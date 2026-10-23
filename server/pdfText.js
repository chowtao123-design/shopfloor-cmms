'use strict';

import { inflateSync } from 'node:zlib';

/**
 * Text extraction from manual PDFs for the AI (SPEC-v4.md section 4.2).
 *
 * `extractPdfText(buffer)` never throws: it returns
 * `{status: 'ok'|'no_text'|'error', pages: string[], chars}`. Encrypted PDFs
 * are `error`; fewer than 200 meaningful characters overall are `no_text`
 * (a scanned manual). Hard limits: 1,500 pages, 2,000,000 characters and 20
 * seconds, the clock checked once per page.
 *
 * Objects are found by scanning for `N M obj` bodies instead of trusting
 * the xref table, so broken offsets, xref streams and object streams
 * (`/Type /ObjStm`, most modern PDFs) all work. FlateDecode streams inflate
 * with node:zlib; any other filter (or a second filter in the chain) skips
 * that stream. Text comes from the `Tj`, `TJ`, `'` and `"` operators inside
 * `BT…ET`, with line breaks on `Td`/`TD`/`T*`/`Tm` y-changes; strings decode
 * through the font's `ToUnicode` CMap (`bfchar`, `bfrange`) when present,
 * else WinAnsi/Standard single-byte encoding. Kerning numbers inside `TJ`
 * arrays are adjusted spacing, not separators, so words stay together.
 */

export const PDF_MAX_PAGES = 1500;
export const PDF_MAX_CHARS = 2000000;
export const PDF_TIME_LIMIT_MS = 20000;
/** Fewer meaningful (non-whitespace) characters than this → 'no_text'. */
export const PDF_MIN_TEXT_CHARS = 200;

// ---------------------------------------------------------------------------
// Low-level object model
// ---------------------------------------------------------------------------

/** An indirect reference `N M R` (the generation is unused by this reader). */
class PdfRef {
  constructor(num) {
    this.num = num;
  }
}

/** A stream object: its dictionary plus the raw (still encoded) bytes. */
class PdfStream {
  constructor(dict, raw) {
    this.dict = dict;
    this.raw = raw;
  }
}

/** A PDF string (literal or hex): raw bytes only (SPEC-v4 4.2 decoding). */
class PdfString {
  constructor(bytes) {
    this.bytes = bytes;
  }
}

const isDict = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof PdfRef) &&
  !(value instanceof PdfStream) &&
  !(value instanceof PdfString);

const isName = (value) => typeof value === 'string' && value.startsWith('/');

// PDF whitespace (\0 t n f r space) and delimiters ()<>[]{}/% (spec 7.2).
const WHITESPACE = new Set(['\0', '\t', '\n', '\f', '\r', ' ']);
const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const NUMBER_START_RE = /^[0-9.+-]$/;

/**
 * The file is scanned through a latin1 view of the buffer: latin1 maps every
 * byte to one code point 0-255, so an index into the string is also the byte
 * offset, and `charCodeAt` yields the raw byte.
 */
const latin1 = (buffer) => buffer.toString('latin1');

function skipWhitespaceAndComments(s, pos) {
  const n = s.length;
  while (pos < n) {
    const ch = s[pos];
    if (WHITESPACE.has(ch)) {
      pos += 1;
      continue;
    }
    if (ch === '%') {
      while (pos < n && s[pos] !== '\n' && s[pos] !== '\r') pos += 1;
      continue;
    }
    break;
  }
  return pos;
}

function isKeywordBoundaryAt(s, pos) {
  if (pos >= s.length) return true;
  return WHITESPACE.has(s[pos]) || DELIMITERS.has(s[pos]);
}

/** Parse a `/Name` (with `#XX` escapes); `s[pos]` must be the slash. */
function parseNameAt(s, pos) {
  const n = s.length;
  pos += 1;
  let value = '/';
  while (pos < n) {
    const ch = s[pos];
    if (WHITESPACE.has(ch) || DELIMITERS.has(ch)) break;
    if (
      ch === '#' &&
      pos + 2 < n &&
      /^[0-9A-Fa-f]{2}$/.test(s.slice(pos + 1, pos + 3))
    ) {
      value += String.fromCharCode(parseInt(s.slice(pos + 1, pos + 3), 16));
      pos += 3;
      continue;
    }
    value += ch;
    pos += 1;
  }
  return { value, end: pos };
}

/** Parse a `(literal)` string into raw bytes; escapes and nesting included. */
function parseLiteralStringAt(s, pos) {
  const n = s.length;
  pos += 1;
  const bytes = [];
  let depth = 1;
  while (pos < n) {
    const ch = s[pos];
    if (ch === '\\') {
      const next = pos + 1 < n ? s[pos + 1] : '';
      if (next === 'n') bytes.push(10);
      else if (next === 'r') bytes.push(13);
      else if (next === 't') bytes.push(9);
      else if (next === 'b') bytes.push(8);
      else if (next === 'f') bytes.push(12);
      else if (next === '(') bytes.push(40);
      else if (next === ')') bytes.push(41);
      else if (next === '\\') bytes.push(92);
      else if (next === '\n' || next === '\r') {
        // line continuation: the escaped EOL itself is dropped
        pos += next === '\r' && s[pos + 2] === '\n' ? 3 : 2;
        continue;
      } else if (/^[0-7]$/.test(next)) {
        let octal = '';
        let q = pos + 1;
        while (q < n && octal.length < 3 && /^[0-7]$/.test(s[q])) {
          octal += s[q];
          q += 1;
        }
        bytes.push(parseInt(octal, 8) & 0xff);
        pos = q;
        continue;
      } else if (next !== '') {
        bytes.push(s.charCodeAt(pos + 1) & 0xff);
      }
      pos += 2;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      bytes.push(40);
      pos += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        pos += 1;
        break;
      }
      bytes.push(41);
      pos += 1;
      continue;
    }
    bytes.push(s.charCodeAt(pos) & 0xff);
    pos += 1;
  }
  return { bytes, end: pos };
}

/** Parse a `<hex>` string into raw bytes (odd digit counts pad with 0). */
function parseHexStringAt(s, pos) {
  const n = s.length;
  pos += 1;
  let hex = '';
  while (pos < n && s[pos] !== '>') {
    if (!WHITESPACE.has(s[pos])) hex += s[pos];
    pos += 1;
  }
  if (pos < n) pos += 1;
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const bytes = [];
  for (let i = 0; i + 2 <= padded.length; i += 2) {
    bytes.push(parseInt(padded.slice(i, i + 2), 16));
  }
  return { bytes, end: pos };
}

/** Bytes → a PdfString operand (array elements keep their raw bytes). */
const pdfStringOfBytes = (bytes) => new PdfString(bytes);

/** Parse an `[array]`, elements through parseValueAt. */
function parseArrayAt(s, pos) {
  pos += 1;
  const value = [];
  for (;;) {
    pos = skipWhitespaceAndComments(s, pos);
    if (pos >= s.length) break;
    if (s[pos] === ']') {
      pos += 1;
      break;
    }
    const parsed = parseValueAt(s, pos);
    if (parsed === null) {
      pos += 1;
      continue;
    }
    value.push(parsed.value);
    pos = parsed.end;
  }
  return { value, end: pos };
}

/** Parse a `<<dict>>`, keys are `/Names`, values through parseValueAt. */
function parseDictAt(s, pos) {
  pos += 2;
  const dict = {};
  const n = s.length;
  for (;;) {
    pos = skipWhitespaceAndComments(s, pos);
    if (pos >= n) break;
    if (s[pos] === '>' && s[pos + 1] === '>') {
      pos += 2;
      break;
    }
    if (s[pos] !== '/') {
      // Not a name: defensive single skip (valid PDFs never land here).
      pos += 1;
      continue;
    }
    const key = parseNameAt(s, pos);
    pos = key.end;
    const value = parseValueAt(s, pos);
    if (value === null) continue;
    dict[key.value] = value.value;
    pos = value.end;
  }
  return { value: dict, end: pos };
}

/**
 * Parse one PDF value at `pos`: dict, array, name, string (literal or hex),
 * number, indirect reference (`N M R`), true/false/null. Unknown keywords
 * (stream, endobj, …) parse as `undefined`. Returns null when nothing
 * sensible starts at `pos`.
 */
function parseValueAt(s, pos) {
  pos = skipWhitespaceAndComments(s, pos);
  if (pos >= s.length) return null;
  const ch = s[pos];
  if (ch === '<' && s[pos + 1] === '<') return parseDictAt(s, pos);
  if (ch === '<') {
    const hex = parseHexStringAt(s, pos);
    return { value: pdfStringOfBytes(hex.bytes), end: hex.end };
  }
  if (ch === '(') {
    const literal = parseLiteralStringAt(s, pos);
    return { value: pdfStringOfBytes(literal.bytes), end: literal.end };
  }
  if (ch === '[') return parseArrayAt(s, pos);
  if (ch === '/') return parseNameAt(s, pos);
  if (DELIMITERS.has(ch)) return null; // stray ) ] } > { %
  let end = pos;
  while (end < s.length && !WHITESPACE.has(s[end]) && !DELIMITERS.has(s[end])) end += 1;
  const token = s.slice(pos, end);
  if (token === '') return null;
  if (NUMBER_RE.test(token)) {
    const first = Number(token);
    // "num gen R" is an indirect reference.
    let refPos = skipWhitespaceAndComments(s, end);
    if (refPos < s.length && NUMBER_START_RE.test(s[refPos])) {
      let refEnd = refPos;
      while (refEnd < s.length && !WHITESPACE.has(s[refEnd]) && !DELIMITERS.has(s[refEnd])) refEnd += 1;
      const second = s.slice(refPos, refEnd);
      if (NUMBER_RE.test(second)) {
        const rPos = skipWhitespaceAndComments(s, refEnd);
        if (s[rPos] === 'R' && isKeywordBoundaryAt(s, rPos + 1)) {
          return { value: new PdfRef(first), end: rPos + 1 };
        }
      }
    }
    return { value: first, end };
  }
  if (token === 'true') return { value: true, end };
  if (token === 'false') return { value: false, end };
  if (token === 'null') return { value: null, end };
  return { value: undefined, end };
}

/**
 * The raw bytes of one stream: `/Length` when it is a plain integer that
 * really ends at an `endstream`, else the next `endstream` (trailing EOL
 * stripped). Returns null when no end is in sight.
 */
function streamBytes(text, dict, dataStart) {
  const n = text.length;
  const length = dict['/Length'];
  if (typeof length === 'number' && Number.isFinite(length) && length >= 0) {
    const candidate = dataStart + length;
    if (candidate <= n) {
      let check = candidate;
      while (check < n && '\r\n \t'.includes(text[check])) check += 1;
      if (text.startsWith('endstream', check)) {
        return { bytes: Buffer.from(text.slice(dataStart, candidate), 'latin1'), end: candidate };
      }
    }
  }
  const idx = text.indexOf('endstream', dataStart);
  if (idx === -1) return null;
  let end = idx;
  while (end > dataStart && '\r\n \t'.includes(text[end - 1])) end -= 1;
  return { bytes: Buffer.from(text.slice(dataStart, end), 'latin1'), end: idx };
}

/**
 * Scan the whole file for indirect object bodies (`N M obj … endobj`),
 * skipping past each successfully parsed stream so object headers inside
 * stream bytes are never mistaken for objects. Later occurrences win, which
 * matches incremental updates.
 */
function scanObjects(text) {
  const objects = new Map();
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = objRe.exec(text)) !== null) {
    const num = Number(match[1]);
    if (!Number.isInteger(num) || num <= 0) continue;
    const bodyStart = skipWhitespaceAndComments(text, match.index + match[0].length);
    const parsed = parseValueAt(text, bodyStart);
    if (parsed === null || parsed.value === undefined) continue;
    let end = parsed.end;
    if (isDict(parsed.value)) {
      const after = skipWhitespaceAndComments(text, end);
      if (
        text.startsWith('stream', after) &&
        isKeywordBoundaryAt(text, after + 6) &&
        after + 6 <= text.length
      ) {
        // The 'stream' keyword is followed by exactly one EOL (\r\n, \n or \r).
        let dataStart = after + 6;
        if (text[dataStart] === '\r') dataStart += 1;
        if (text[dataStart] === '\n') dataStart += 1;
        const raw = streamBytes(text, parsed.value, dataStart);
        if (raw !== null) {
          objects.set(num, new PdfStream(parsed.value, raw.bytes));
          const closeIdx = text.indexOf('endstream', raw.end);
          objRe.lastIndex = closeIdx === -1 ? raw.end : closeIdx + 9;
          continue;
        }
      }
    }
    objects.set(num, parsed.value);
    objRe.lastIndex = end;
  }
  return objects;
}

/** Resolve an indirect reference (chasing ref-to-ref chains); null when absent. */
function resolve(objects, value) {
  let current = value;
  for (let depth = 0; depth < 5 && current instanceof PdfRef; depth += 1) {
    const found = objects.get(current.num);
    if (found === undefined) return null;
    current = found;
  }
  if (current instanceof PdfRef) return null;
  return current === undefined ? null : current;
}

/**
 * Decode one stream: raw bytes without a filter, `zlib.inflateSync` for a
 * single `/FlateDecode`, and null for anything else (that stream is
 * skipped, SPEC-v4.md 4.2). Never throws.
 */
function decodeStream(objects, stream) {
  if (!(stream instanceof PdfStream)) return null;
  let filter = resolve(objects, stream.dict['/Filter']);
  if (filter === null) filter = undefined;
  let names = [];
  if (isName(filter)) names = [filter];
  else if (Array.isArray(filter)) names = filter.filter(isName);
  if (names.length === 0) return stream.raw;
  if (names.length > 1 || names[0] !== '/FlateDecode') return null;
  try {
    return inflateSync(stream.raw);
  } catch {
    return null;
  }
}

/**
 * Expand `/Type /ObjStm` object streams (the way most modern PDFs store
 * their indirect objects): N `objNum offset` header pairs, then the object
 * bodies without `obj`/`endobj`. Direct objects already scanned win.
 */
function expandObjectStreams(objects) {
  const containers = [...objects.values()].filter(
    (value) => value instanceof PdfStream && value.dict['/Type'] === '/ObjStm'
  );
  for (const container of containers) {
    const decoded = decodeStream(objects, container);
    if (decoded === null) continue;
    const s = decoded.toString('latin1');
    const count = Number(container.dict['/N']);
    const first = Number(container.dict['/First']);
    if (!Number.isInteger(count) || !Number.isInteger(first) || count <= 0 || first <= 0) continue;
    if (first > s.length) continue;
    const tokens = s.slice(0, first).match(/\d+/g) ?? [];
    if (tokens.length < count * 2) continue;
    for (let i = 0; i < count; i++) {
      const objNum = Number(tokens[i * 2]);
      const offset = Number(tokens[i * 2 + 1]);
      if (!Number.isInteger(objNum) || objNum <= 0) continue;
      if (!Number.isInteger(offset) || offset < 0) continue;
      if (objects.has(objNum)) continue;
      const bodyPos = first + offset;
      if (bodyPos >= s.length) continue;
      const parsed = parseValueAt(s, bodyPos);
      if (parsed === null || parsed.value === undefined) continue;
      objects.set(objNum, parsed.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Page tree
// ---------------------------------------------------------------------------

/**
 * Collect leaf pages from a `/Pages` node (or a page directly), depth-first,
 * cycle-safe, capped at PDF_MAX_PAGES. `/Resources` are inherited from the
 * nearest ancestor that carries them.
 */
function collectPages(objects, nodeValue, pages, seen, inheritedResources) {
  if (pages.length >= PDF_MAX_PAGES) return;
  const node = resolve(objects, nodeValue);
  if (!isDict(node) || seen.has(node)) return;
  const resources = node['/Resources'] !== undefined ? node['/Resources'] : inheritedResources;
  if (Array.isArray(node['/Kids'])) {
    seen.add(node);
    for (const kid of node['/Kids'].slice(0, 1000)) {
      collectPages(objects, kid, pages, seen, resources);
      if (pages.length >= PDF_MAX_PAGES) return;
    }
    return;
  }
  if (node['/Type'] === '/Page' || node['/Contents'] !== undefined) {
    seen.add(node);
    pages.push({ node, resources });
  }
}

/** Page-tree roots: the catalog's /Pages when findable, else every /Pages. */
function pageRoots(objects) {
  const catalogRoots = [];
  let hasCatalog = false;
  for (const value of objects.values()) {
    if (!isDict(value) || value['/Type'] !== '/Catalog') continue;
    hasCatalog = true;
    if (value['/Pages'] !== undefined) {
      const resolved = resolve(objects, value['/Pages']);
      if (isDict(resolved)) catalogRoots.push(resolved);
    }
  }
  if (catalogRoots.length > 0) return catalogRoots;
  if (hasCatalog) return [];
  const anyPages = [];
  for (const value of objects.values()) {
    if (isDict(value) && value['/Type'] === '/Pages') anyPages.push(value);
  }
  return anyPages;
}

// ---------------------------------------------------------------------------
// Fonts: ToUnicode CMaps and WinAnsi/Standard single-byte tables
// ---------------------------------------------------------------------------

/** Hex UTF-16BE bytes → JS string (surrogate pairs included). */
function hexToUtf16(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  if (clean.length === 0 || clean.length % 2 === 1) return null;
  const bytes = Buffer.from(clean, 'hex');
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  return out;
}

const CMAP_MAX_ENTRIES = 200000;

/**
 * Parse a `ToUnicode` CMap: `begincodespacerange` sets the source byte width,
 * `beginbfchar`/`beginbfrange` map codes to UTF-16BE strings (ranges either
 * start at one destination value or list one per entry). Returns
 * {width, map} or null when nothing usable is in there.
 */
function parseUnicodeCMap(text) {
  const map = new Map();
  let width = 0;
  const spaceMatch = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  const space = spaceMatch.exec(text);
  if (space !== null) {
    const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(space[1]);
    if (pair !== null) width = Math.max(width, pair[1].length / 2, pair[2].length / 2);
  }
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  let block;
  while ((block = bfchar.exec(text)) !== null) {
    let entry;
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    while ((entry = re.exec(block[1])) !== null) {
      if (map.size >= CMAP_MAX_ENTRIES) break;
      const dst = hexToUtf16(entry[2]);
      if (dst === null) continue;
      width = Math.max(width, entry[1].length / 2);
      map.set(parseInt(entry[1], 16), dst);
    }
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = bfrange.exec(text)) !== null) {
    let entry;
    const re =
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[(?:\s*<[0-9A-Fa-f]+>)+\s*\])/g;
    while ((entry = re.exec(block[1])) !== null) {
      const lo = parseInt(entry[1], 16);
      const hi = parseInt(entry[2], 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      const count = hi - lo + 1;
      if (count <= 0 || count > 65536) continue;
      width = Math.max(width, entry[1].length / 2);
      const dst = entry[3];
      if (dst.startsWith('<')) {
        const startHex = dst.slice(1, -1).replace(/[^0-9A-Fa-f]/g, '');
        const startStr = hexToUtf16(startHex);
        if (startStr === null || startStr.length === 0) continue;
        const start = startStr.codePointAt(0);
        for (let i = 0; i < count && map.size < CMAP_MAX_ENTRIES && start + i <= 0x10ffff; i++) {
          map.set(lo + i, String.fromCodePoint(start + i));
        }
      } else {
        const dsts = [...dst.matchAll(/<([0-9A-Fa-f]+)>/g)];
        for (let i = 0; i < count && i < dsts.length && map.size < CMAP_MAX_ENTRIES; i++) {
          const value = hexToUtf16(dsts[i][1]);
          if (value !== null) map.set(lo + i, value);
        }
      }
    }
  }
  if (width < 1 || width > 4 || map.size === 0) return null;
  return { width, map };
}

/** cp1252 (WinAnsi) specials for bytes 0x80-0x9F. */
const CP1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function buildSingleByteMap(high) {
  const map = new Map();
  for (let byte = 0; byte < 256; byte++) {
    if (byte === 0x0a) map.set(byte, '\n'); // newline bytes inside strings
    else if (byte === 0x09) map.set(byte, '\t');
    else if (byte >= 0x20 && byte <= 0x7e) map.set(byte, String.fromCharCode(byte));
    else if (byte >= 0xa0) map.set(byte, String.fromCharCode(byte));
    else if (high[byte] !== undefined) map.set(byte, String.fromCharCode(high[byte]));
    else map.set(byte, '');
  }
  return map;
}

const WINANSI_BYTE_MAP = buildSingleByteMap(CP1252_HIGH);
const STANDARD_BYTE_MAP = buildSingleByteMap({});

/** The fallback decoder when a font names no usable encoding (SPEC-v4 4.2). */
const DEFAULT_FONT_DECODER = { width: 1, map: WINANSI_BYTE_MAP };

/** Build the decoder for one font: ToUnicode CMap, else WinAnsi/Standard. */
function buildFontDecoder(objects, fontValue) {
  const font = resolve(objects, fontValue);
  if (!isDict(font)) return null;
  const toUnicode = resolve(objects, font['/ToUnicode']);
  if (toUnicode instanceof PdfStream) {
    const decoded = decodeStream(objects, toUnicode);
    if (decoded !== null) {
      const cmap = parseUnicodeCMap(decoded.toString('latin1'));
      if (cmap !== null) return cmap;
    }
  }
  const encoding = resolve(objects, font['/Encoding']);
  const standard = isName(encoding) && encoding === '/StandardEncoding';
  return { width: 1, map: standard ? STANDARD_BYTE_MAP : WINANSI_BYTE_MAP };
}

/** Decode string bytes through a font decoder (1-4 byte codes). */
function decodeStringBytes(font, bytes) {
  const decoder = font ?? DEFAULT_FONT_DECODER;
  const width = decoder.width === 2 || decoder.width === 4 ? decoder.width : 1;
  let out = '';
  if (width === 1) {
    for (let i = 0; i < bytes.length; i++) {
      const mapped = decoder.map.get(bytes[i]);
      out += mapped === undefined ? '' : mapped;
    }
    return out;
  }
  for (let i = 0; i + width <= bytes.length; i += width) {
    let code = 0;
    for (let b = 0; b < width; b++) code = (code << 8) | bytes[i + b];
    const mapped = decoder.map.get(code);
    out += mapped === undefined ? '' : mapped;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content-stream text operators
// ---------------------------------------------------------------------------

/**
 * Run the text-showing operators of a page's content streams (they share one
 * text state). Strings are operands kept as {bytes}; arrays keep elements of
 * any operand kind. Only Tj/TJ/'/" show text, and only inside BT…ET; the
 * Td, TD, T* and Tm y-changes break lines. Every other operator just clears
 * its operands off the stack.
 */
function runContentStreams(strings, fonts, drawForm = () => '') {
  let out = '';
  let stack = [];
  let inText = false;
  let font = null;
  let lineY = null;
  // A line break is pending until the next text shows it: several position
  // changes between two strings still break the line only once.
  let pendingBreak = false;
  // Many PDFs (LaTeX, Word) draw no space glyphs: words are separated by a big
  // TJ gap or a jump along the same line, so those become one space.
  let pendingSpace = false;
  // Some writers (Chrome) place every glyph with its own move and draw real
  // spaces; a move only means a word gap after a run longer than one glyph.
  let lastRunLength = 0;
  const breakLine = () => {
    if (inText) pendingBreak = true;
  };
  const show = (bytes) => {
    if (pendingBreak) {
      out += '\n';
      pendingBreak = false;
    } else if (pendingSpace && out !== '' && !/\s$/.test(out)) {
      out += ' ';
    }
    pendingSpace = false;
    // Text shown before any positioning op sits on the implicit baseline 0,
    // so the next Td/Tm y-change is detected as a new line.
    if (lineY === null) lineY = 0;
    const text = decodeStringBytes(font, bytes);
    lastRunLength = text.length;
    out += text;
  };
  for (const s of strings) {
    const n = s.length;
    let i = 0;
    while (i < n) {
      const ch = s[i];
      if (WHITESPACE.has(ch)) {
        i += 1;
        continue;
      }
      if (ch === '%') {
        while (i < n && s[i] !== '\n' && s[i] !== '\r') i += 1;
        continue;
      }
      if (ch === '(') {
        const literal = parseLiteralStringAt(s, i);
        stack.push({ bytes: literal.bytes });
        i = literal.end;
        continue;
      }
      if (ch === '<' && s[i + 1] === '<') {
        const dict = parseDictAt(s, i);
        stack.push(null); // inline dictionaries (BDC properties) are placeheld
        i = dict.end;
        continue;
      }
      if (ch === '<') {
        const hex = parseHexStringAt(s, i);
        stack.push({ bytes: hex.bytes });
        i = hex.end;
        continue;
      }
      if (ch === '[') {
        const array = parseArrayAt(s, i);
        stack.push(array.value);
        i = array.end;
        continue;
      }
      if (ch === '/') {
        const name = parseNameAt(s, i);
        stack.push(name.value);
        i = name.end;
        continue;
      }
      if (s[i] === ']' || s[i] === ')' || s[i] === '>' || s[i] === '}' || s[i] === '{') {
        i += 1; // stray closing delimiter: skip
        continue;
      }
      // A run of regular characters: a number operand or an operator keyword.
      let end = i;
      while (end < n && !WHITESPACE.has(s[end]) && !DELIMITERS.has(s[end])) end += 1;
      const token = s.slice(i, end);
      i = end;
      if (token === '') continue;
      if (NUMBER_RE.test(token)) {
        stack.push(Number(token));
        continue;
      }
      switch (token) {
        case 'BT':
          inText = true;
          lineY = null;
          pendingBreak = false;
          pendingSpace = true;
          break;
        case 'ET':
          inText = false;
          pendingBreak = false;
          break;
        case 'Tf': {
          const name = stack.length >= 2 ? stack[stack.length - 2] : null;
          font = typeof name === 'string' && fonts.has(name) ? fonts.get(name) : null;
          break;
        }
        case 'Tj': {
          const operand = stack[stack.length - 1];
          if (inText && operand !== null && operand !== undefined && operand.bytes) show(operand.bytes);
          break;
        }
        case 'TJ': {
          const operand = stack[stack.length - 1];
          if (inText && Array.isArray(operand)) {
            // Small numbers are kerning; a gap of a fifth of an em or more is a word space.
            for (const element of operand) {
              if (typeof element === 'number' && element <= -200) pendingSpace = true;
              else if (element !== null && element !== undefined && element.bytes) show(element.bytes);
            }
          }
          break;
        }
        case "'":
        case '"': {
          const operand = stack[stack.length - 1];
          if (inText) {
            breakLine(); // these move to the next line before showing text
            if (operand !== null && operand !== undefined && operand.bytes) show(operand.bytes);
          }
          break;
        }
        case 'Td':
        case 'TD': {
          const ty = stack[stack.length - 1];
          const tx = stack[stack.length - 2];
          if (inText && typeof ty === 'number') {
            const next = (lineY === null ? 0 : lineY) + ty;
            if (lineY !== null && next !== lineY) breakLine();
            else if (typeof tx === 'number' && tx !== 0 && lastRunLength > 1) pendingSpace = true;
            lineY = next;
          }
          break;
        }
        case 'T*':
          breakLine();
          break;
        case 'Tm': {
          const fy = stack[stack.length - 1];
          if (inText && typeof fy === 'number') {
            if (lineY !== null && fy !== lineY) breakLine();
            else if (lastRunLength > 1) pendingSpace = true;
            lineY = fy;
          }
          break;
        }
        case 'Do': {
          // A form XObject is a reusable block of page content (web-to-PDF
          // tools put each whole manual page in one); its text joins the page.
          const name = stack[stack.length - 1];
          const formText = typeof name === 'string' ? drawForm(name) : '';
          if (formText !== '') {
            out += (out === '' || out.endsWith('\n') ? '' : '\n') + formText;
            pendingBreak = true;
          }
          break;
        }
        default:
          break; // every other operator only clears its operands
      }
      stack = [];
    }
  }
  return out;
}

const FORM_MAX_DEPTH = 8;
const FORM_MAX_PER_PAGE = 300;

function fontsOf(objects, resources) {
  const fonts = new Map();
  if (!isDict(resources)) return fonts;
  const fontDict = resolve(objects, resources['/Font']);
  if (isDict(fontDict)) {
    for (const [name, fontValue] of Object.entries(fontDict)) {
      if (!isName(name)) continue;
      const decoder = buildFontDecoder(objects, fontValue);
      if (decoder !== null) fonts.set(name, decoder);
    }
  }
  return fonts;
}

/**
 * Run content strings with their resources; `Do` on a /Form XObject runs the
 * form's own stream with its own resources (inheriting ours when it has none).
 * `active` blocks a form that (indirectly) draws itself; `budget` caps forms
 * per page so a hostile file cannot blow up.
 */
function runWithResources(objects, strings, resources, depth, active, budget) {
  const drawForm = (name) => {
    if (depth >= FORM_MAX_DEPTH || budget.left <= 0 || !isDict(resources)) return '';
    const xobjects = resolve(objects, resources['/XObject']);
    if (!isDict(xobjects)) return '';
    const form = resolve(objects, xobjects[name]);
    if (!(form instanceof PdfStream) || resolve(objects, form.dict['/Subtype']) !== '/Form') return '';
    if (active.has(form)) return '';
    const decoded = decodeStream(objects, form);
    if (decoded === null) return '';
    budget.left -= 1;
    const formResources = resolve(objects, form.dict['/Resources']);
    active.add(form);
    try {
      return runWithResources(objects, [decoded.toString('latin1')], isDict(formResources) ? formResources : resources, depth + 1, active, budget);
    } finally {
      active.delete(form);
    }
  };
  return runContentStreams(strings, fontsOf(objects, resources), drawForm);
}

/** Decode every content stream of one page and run the text operators. */
function extractPageText(objects, page) {
  const resources = resolve(objects, page.resources);
  const contents = page.node['/Contents'];
  const contentList = Array.isArray(contents) ? contents : contents === undefined ? [] : [contents];
  const strings = [];
  for (const entry of contentList) {
    const stream = resolve(objects, entry);
    if (!(stream instanceof PdfStream)) continue;
    const decoded = decodeStream(objects, stream);
    if (decoded === null) continue; // unsupported filter: skip that stream
    strings.push(decoded.toString('latin1'));
  }
  return runWithResources(objects, strings, resources, 0, new Set(), { left: FORM_MAX_PER_PAGE });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function extractInternal(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('extractPdfText needs a Buffer');
  const text = latin1(buffer);
  // A PDF starts with %PDF-, allowing a little leading junk (it must be in
  // the first kilobyte); anything else is not a PDF we can read.
  const headerAt = text.indexOf('%PDF-');
  if (headerAt < 0 || headerAt > 1024) return { status: 'error', pages: [], chars: 0 };
  // Encrypted PDFs are unreadable here (SPEC-v4.md 4.2 → 'error').
  if (text.includes('/Encrypt')) return { status: 'error', pages: [], chars: 0 };

  const objects = scanObjects(text);
  expandObjectStreams(objects);

  const pages = [];
  const seen = new Set();
  for (const root of pageRoots(objects)) {
    collectPages(objects, root, pages, seen, undefined);
  }

  const started = Date.now();
  const pagesText = [];
  let chars = 0;
  for (const page of pages) {
    // Hard limits (SPEC-v4.md 4.2), the clock checked once per page.
    if (pagesText.length >= PDF_MAX_PAGES) break;
    if (chars >= PDF_MAX_CHARS) break;
    if (Date.now() - started > PDF_TIME_LIMIT_MS) break;
    let pageText = '';
    try {
      pageText = extractPageText(objects, page);
    } catch {
      pageText = '';
    }
    if (typeof pageText !== 'string') pageText = '';
    const trimmed = pageText.trim();
    const room = PDF_MAX_CHARS - chars;
    const take = room <= 0 ? '' : trimmed.length > room ? trimmed.slice(0, room) : trimmed;
    pagesText.push(take);
    chars += take.length;
    if (chars >= PDF_MAX_CHARS) break;
  }

  // Fewer than 200 meaningful characters overall: a scanned manual.
  const meaningful = pagesText.join('\n').replace(/\s/g, '').length;
  if (meaningful < PDF_MIN_TEXT_CHARS) {
    return { status: 'no_text', pages: pagesText, chars };
  }
  return { status: 'ok', pages: pagesText, chars };
}

/**
 * Extract text from one manual PDF. Never throws: any internal failure is
 * reported as `{status: 'error', pages: [], chars: 0}`.
 */
export function extractPdfText(buffer) {
  try {
    return extractInternal(buffer);
  } catch {
    return { status: 'error', pages: [], chars: 0 };
  }
}