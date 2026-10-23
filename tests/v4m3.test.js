'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import * as auth from '../server/auth.js';
import { normalizeModel, relatedLibraryItems } from '../logic.js';
import { openStore } from '../server/store.js';
import { createUploadedFile } from '../server/files.js';
import { extractPdfText } from '../server/pdfText.js';
import { putRecord, validateRecordData } from '../server/records.js';
import { startServer } from '../server/server.js';

/**
 * V4-M3 (SPEC-v4.md sections 4.1 and 4.2): the libraryItems store, matching
 * helpers, the built-in PDF text extractor (fixtures generated here, never
 * checked in), the file_texts table with background extraction, the 50 MB
 * streaming PDF upload and backup coverage.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const XRW = { 'X-Requested-With': 'maint-log' };
const uuid = () => crypto.randomUUID();
const PDF_MIME = 'application/pdf';
const FILES_DIR = (dataDir) => path.join(dataDir, 'files');
const tempFilesIn = (dataDir) => {
  try {
    return fs.readdirSync(FILES_DIR(dataDir)).filter((name) => name.startsWith('.tmp-'));
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// libraryItems validation (SPEC-v4.md section 4.1)
// ---------------------------------------------------------------------------

const attachment = { fileId: uuid(), name: 'manual.pdf', mime: PDF_MIME, size: 1234 };

const goodMethod = {
  kind: 'method',
  title: 'Thread breaks at high speed',
  machineType: 'single-needle',
  models: ['DDL-8700-7', 'MO-3716'],
  machineIds: ['machine-1'],
  tags: ['thread break', 'timing'],
  attachments: [attachment],
  symptom: 'Top thread breaks above the needle after a few minutes at speed',
  cause: 'Needle bar height drifted after the last take-up lever adjustment.',
  steps: [
    { id: 's1', text: 'Turn the machine off and unplug it.' },
    { id: 's2', text: 'Measure the needle bar height at rest.' },
    { id: 's3', text: 'Set the height to 12.5 mm and retest.' },
  ],
  toolsParts: 'Hex keys, DBx1 #14 needles',
  safety: 'Lock out the main switch before opening the side cover.',
  sourceWorkOrderId: 'order-9',
};

test('libraryItems: a good method validates with the spec defaults', () => {
  const data = validateRecordData('libraryItems', goodMethod, { isCreate: true });
  assert.equal(data.kind, 'method');
  assert.equal(data.title, 'Thread breaks at high speed');
  assert.equal(data.machineType, 'single-needle');
  assert.deepEqual(data.models, ['DDL-8700-7', 'MO-3716']);
  assert.deepEqual(data.machineIds, ['machine-1']);
  assert.deepEqual(data.tags, ['thread break', 'timing']);
  assert.deepEqual(data.attachments, [attachment]);
  assert.equal(data.symptom, goodMethod.symptom);
  assert.equal(data.cause, goodMethod.cause);
  assert.deepEqual(data.steps, [
    { id: 's1', text: 'Turn the machine off and unplug it.' },
    { id: 's2', text: 'Measure the needle bar height at rest.' },
    { id: 's3', text: 'Set the height to 12.5 mm and retest.' },
  ]);
  assert.equal(data.toolsParts, goodMethod.toolsParts);
  assert.equal(data.safety, goodMethod.safety);
  assert.equal(data.sourceWorkOrderId, 'order-9');

  // Unknown keys inside a step are rejected (steps are exactly {id, text}).
  assert.throws(
    () => validateRecordData('libraryItems', { ...goodMethod, steps: [{ id: 'a', text: 'do it', done: true }] }, { isCreate: true }),
    /steps\[0\] has an unknown field "done"/,
  );
});

test('libraryItems: a good manual validates and arrives with empty defaults', () => {
  const manual = {
    kind: 'manual',
    title: 'Juki DDL-8700 service manual',
    models: ['DDL-8700-7'],
    tags: ['manual'],
    notes: 'Timing chart on page 12; bobbin tension table on page 34.',
  };
  const data = validateRecordData('libraryItems', manual, { isCreate: true });
  assert.equal(data.kind, 'manual');
  assert.equal(data.machineType, null);
  assert.deepEqual(data.models, ['DDL-8700-7']);
  assert.deepEqual(data.machineIds, []);
  assert.deepEqual(data.tags, ['manual']);
  assert.deepEqual(data.attachments, []);
  assert.equal(data.sourceWorkOrderId, null);
  assert.equal(data.notes, manual.notes);

  // On updates no defaults are filled (PUT replaces the whole record).
  const update = validateRecordData('libraryItems', { kind: 'manual', title: 'X' }, {
    isCreate: false,
  });
  assert.equal('models' in update, false);
  assert.equal('steps' in update, false);
});

test('libraryItems: method-only fields are rejected on a manual with a clear message', () => {
  const methodOnly = {
    symptom: 'Top thread breaks',
    cause: 'Needle bar height',
    steps: [{ id: 's1', text: 'Measure the height.' }],
    toolsParts: 'Hex keys',
    safety: 'Lock out first.',
  };
  for (const [key, value] of Object.entries(methodOnly)) {
    assert.throws(
      () => validateRecordData('libraryItems', { kind: 'manual', title: 'Manual', [key]: value }),
      (err) =>
        err.status === 400 &&
        err.code === 'bad_request' &&
        err.message === `libraryItems.${key} is only allowed when kind is "method"`,
      `${key} is rejected on a manual`,
    );
  }
  // And they are fine on a method.
  for (const [key, value] of Object.entries(methodOnly)) {
    assert.doesNotThrow(
      () => validateRecordData('libraryItems', { kind: 'method', title: 'M', [key]: value }),
      key,
    );
  }
});

test('libraryItems: every field can fail on its own', () => {
  const DELETE = Symbol('delete key');
  const att = { fileId: 'f1', name: 'n', mime: 'image/png', size: 4 };
  const cases = [
    ['kind missing', { kind: DELETE }, /"kind" is required/],
    ['kind unknown', { kind: 'blueprint' }, /kind must be one of manual, method/],
    ['title missing', { title: DELETE }, /"title" is required/],
    ['title empty', { title: '   ' }, /title must not be empty/],
    ['title too long', { title: 'T'.repeat(161) }, /title must be at most 160 characters/],
    ['title boundary', { title: 'T'.repeat(160) }, null],
    ['machineType invalid', { machineType: 'loom' }, /machineType must be one of/],
    ['machineType null allowed', { machineType: null }, null],
    ['machineType legacy value', { machineType: 'sewing' }, null],
    ['models not an array', { models: 'DDL' }, /models must be an array of strings/],
    ['models blank entry', { models: [' '] }, /models must contain only non-empty strings/],
    ['models too many', { models: Array.from({ length: 21 }, () => 'DDL-8700') }, /models must have at most 20 entries/],
    ['models entry too long', { models: ['M'.repeat(61)] }, /models\[0\] must be at most 60 characters/],
    ['machineIds too many', { machineIds: Array.from({ length: 51 }, (_, i) => `m${i}`) }, /machineIds must have at most 50 entries/],
    ['tags too many', { tags: Array.from({ length: 21 }, () => 't') }, /tags must have at most 20 entries/],
    ['tags entry too long', { tags: ['t'.repeat(41)] }, /tags\[0\] must be at most 40 characters/],
    ['attachments too many', { attachments: Array.from({ length: 21 }, () => att) }, /attachments must have at most 20 entries/],
    ['attachment unknown field', { attachments: [{ ...att, extra: 1 }] }, /unknown field "extra"/],
    ['notes too long', { notes: 'N'.repeat(20001) }, /notes must be at most 20000 characters/],
    ['notes boundary', { notes: 'N'.repeat(20000) }, null],
    ['symptom too long', { symptom: 'S'.repeat(1001) }, /symptom must be at most 1000 characters/],
    ['cause too long', { cause: 'C'.repeat(2001) }, /cause must be at most 2000 characters/],
    ['steps not an array', { steps: 'x' }, /steps must be an array of {id, text}/],
    ['steps too many', { steps: Array.from({ length: 61 }, (_, i) => ({ id: `s${i}`, text: 't' })) }, /steps must have at most 60 entries/],
    ['step missing text', { steps: [{ id: 'a' }] }, /steps\[0\].text must be a string/],
    ['step empty text', { steps: [{ id: 'a', text: ' ' }] }, /steps\[0\].text must not be empty/],
    ['step text too long', { steps: [{ id: 'a', text: 'T'.repeat(1001) }] }, /steps\[0\].text must be at most 1000 characters/],
    ['toolsParts too long', { toolsParts: 'P'.repeat(1001) }, /toolsParts must be at most 1000 characters/],
    ['safety too long', { safety: 'S'.repeat(1001) }, /safety must be at most 1000 characters/],
    ['sourceWorkOrderId empty', { sourceWorkOrderId: ' ' }, /sourceWorkOrderId must not be empty/],
    ['sourceWorkOrderId null allowed', { sourceWorkOrderId: null }, null],
    ['sourceWorkOrderId wrong type', { sourceWorkOrderId: 5 }, /sourceWorkOrderId must be a string or null/],
    ['unknown top-level field', { urgency: 'high' }, /Unknown field "urgency"/],
  ];
  for (const [name, overrides, pattern] of cases) {
    const input = { ...goodMethod, ...overrides };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === DELETE) delete input[key];
    }
    if (pattern === null) {
      assert.doesNotThrow(() => validateRecordData('libraryItems', input, { isCreate: true }), name);
      continue;
    }
    assert.throws(
      () => validateRecordData('libraryItems', input, { isCreate: true }),
      (err) => err.status === 400 && err.code === 'bad_request' && pattern.test(err.message),
      `${name}: expected ${pattern}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Matching helpers (SPEC-v4.md section 4.1, logic.js)
// ---------------------------------------------------------------------------

test('normalizeModel: lower-case, spaces, dashes, dots and slashes stripped', () => {
  assert.equal(normalizeModel('DDL-8700-7'), 'ddl87007');
  assert.equal(normalizeModel('Ddl 8700 7'), 'ddl87007');
  assert.equal(normalizeModel('ddl.8700/7'), 'ddl87007');
  assert.equal(normalizeModel(' MO-3716S '), 'mo3716s');
  assert.equal(normalizeModel(''), '');
  assert.equal(normalizeModel(null), '');
  assert.equal(normalizeModel(undefined), '');
});

test('relatedLibraryItems: id, model (any spacing), the type-only rule, and no match', () => {
  const machine = { id: 'm-juki', type: 'single-needle', model: 'DDL-8700-7' };
  const items = [
    { id: 'by-id', machineIds: ['m-other', 'm-juki'] },
    { id: 'by-model-spaces', models: ['Ddl 8700 7'] },
    { id: 'by-model-punct', models: ['ddl.8700/7'] },
    { id: 'type-only', machineType: 'single-needle' },
    { id: 'explicit-empty-arrays', machineIds: [], models: [], machineType: 'single-needle' },
    { id: 'type-but-models', machineType: 'single-needle', models: ['MO-6716S'] },
    { id: 'other-type', machineType: 'overlock-5' },
    { id: 'wrong-model', models: ['MO-6716S'] },
    { id: 'brand-prefixed-model', models: ['Juki DDL-8700-7'] },
    null,
  ];
  const matches = relatedLibraryItems(machine, items);
  assert.deepEqual(
    matches.map((item) => item.id),
    ['by-id', 'by-model-spaces', 'by-model-punct', 'type-only', 'explicit-empty-arrays'],
    'input order is kept',
  );

  // No match: another machine entirely.
  const other = { id: 'm-brother', type: 'coverstitch', model: 'CV-3440' };
  assert.deepEqual(relatedLibraryItems(other, items), []);
  // The type-only rule needs the machine type to be equal.
  const bare = { id: 'm-2', type: 'overlock-5' };
  assert.deepEqual(relatedLibraryItems(bare, [items[6]]).map((item) => item.id), ['other-type']);
  // A machine with no model never matches by model, but can by id/type.
  const noModel = { id: 'm-juki', type: 'single-needle' };
  assert.deepEqual(
    relatedLibraryItems(noModel, items).map((item) => item.id),
    ['by-id', 'type-only', 'explicit-empty-arrays'],
  );
  // Null safety.
  assert.deepEqual(relatedLibraryItems(null, items), []);
  assert.deepEqual(relatedLibraryItems(machine, null), []);
  assert.deepEqual(relatedLibraryItems(machine, 'nope'), []);
});

// ---------------------------------------------------------------------------
// PDF fixtures: generated here, never checked in (SPEC-v4.md section 4.2)
// ---------------------------------------------------------------------------

/**
 * Assemble a minimal but structurally correct PDF: object bodies keyed by
 * number, classic xref with the real byte offsets, trailer with /Root.
 * `{xref: false}` omits the xref (objects live in an ObjStm; the reader
 * scans for `obj` bodies, it never trusts the xref table).
 */
function buildPdf(objects, { trailerExtra = '', xref = true } = {}) {
  const nums = Object.keys(objects).map(Number).sort((a, b) => a - b);
  const maxNum = nums[nums.length - 1];
  let out = '%PDF-1.4\n';
  const offsets = new Map();
  for (const num of nums) {
    offsets.set(num, out.length);
    out += `${num} 0 obj\n${objects[num]}\nendobj\n`;
  }
  if (!xref) {
    out += 'startxref\n0\n%%EOF\n';
    return Buffer.from(out, 'latin1');
  }
  const xrefPos = out.length;
  let table = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= maxNum; num++) {
    table += `${String(offsets.get(num) ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  out += table;
  out += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R${trailerExtra}>>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const escapeLiteral = (text) => text.replace(/([()\\])/g, '\\$1');

const P1_FIRST = 'Manual text page one: the needle bar height is 12.5 mm at rest.';
const P1_TJ = 'Takeup lever timing must be checked second, never first.';
const P1_THIRD = 'Set the thread tension to the middle position, then test sew.';
const P1_QUOTE = 'Feed dog height comes last on page one.';
const P1_APPEND = ' Retiming follows the chart in the appendix.';
const P2_FIRST = 'Page two covers the bobbin case tension and the rotating hook.';
const P2_SECOND = 'Use fresh needles (DBx1 #14) each morning. ';
const P2_THIRD = 'Bar height is twelve . five millimetres.';
const PLAIN_PAGES = [
  [P1_FIRST, P1_TJ, P1_THIRD, P1_QUOTE + P1_APPEND].join('\n'),
  [P2_FIRST, P2_SECOND + P2_THIRD].join('\n'),
];

/** Uncompressed two-page PDF: Tj, TJ with kerning, T*, ' and escapes. */
function plainTextPdf() {
  const page1 =
    'BT\n/F1 12 Tf\n72 720 Td\n' +
    `(${escapeLiteral(P1_FIRST)}) Tj\n` +
    '0 -14 Td\n' +
    `[(Take) -50 (up) 40 ( ${escapeLiteral('lever timing must be checked second, never first.')})] TJ\n` +
    'T*\n' +
    `(${escapeLiteral(P1_THIRD)}) Tj\n` +
    '0 -14 Td\n' +
    `(${escapeLiteral(P1_QUOTE)}) '\n` +
    `(${escapeLiteral(P1_APPEND)}) Tj\n` +
    'ET\n';
  const page2 =
    'BT\n/F1 11 Tf\n72 700 Td\n' +
    `(${escapeLiteral(P2_FIRST)}) Tj\n` +
    '0 -14 Td\n' +
    `(Use fresh needles \\(DBx1 #14\\) each morning. ) Tj\n` +
    '(Bar height is twelve \\056 five millimetres.) Tj\n' +
    'ET\n';
  return buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 2 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    4: `<< /Length ${page1.length} >>\nstream\n${page1}endstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    6: `<< /Length ${page2.length} >>\nstream\n${page2}endstream`,
    7: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    8: '<< /Type /Check /Note (never referenced, just xref padding) >>',
    9: '7 0 R',
  });
}

/** One-page PDF whose page objects live inside a compressed ObjStm. */
function objStmPdf() {
  const o1 = 'Object stream pages are found by scanning obj bodies, not the xref table.';
  const o2 = 'This manual page lives inside a compressed ObjStm container object.';
  const o3 = 'The content stream itself stays a direct stream object as required.';
  const o4 = 'Fonts resolve from the page resources dictionary too.';
  const expected = [o1, o2, o3, o4].join('\n');
  const inner = {
    2: '<< /Type /Catalog /Pages 3 0 R >>',
    3: `<< /Type /Pages /Kids [4 0 R] /Count 1 >>`,
    4: '<< /Type /Page /Parent 3 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  };
  let header = '';
  let bodies = '';
  for (const [num, body] of Object.entries(inner)) {
    header += `${num} ${bodies.length} `;
    bodies += `${body}\n`;
  }
  const first = header.length;
  const objstm = deflateSync(Buffer.from(header + bodies, 'latin1'));
  const content = `BT /F1 12 Tf 72 720 Td (${escapeLiteral(o1)}) Tj 0 -14 Td (${escapeLiteral(o2)}) Tj 0 -14 Td (${escapeLiteral(o3)}) Tj 0 -14 Td (${escapeLiteral(o4)}) Tj ET\n`;
  const pdf = Buffer.concat([
    Buffer.from(
      `%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /N ${Object.keys(inner).length} /First ${first} /Filter /FlateDecode /Length ${objstm.length} >>\nstream\n`,
      'latin1'
    ),
    objstm,
    Buffer.from('endstream\nendobj\n', 'latin1'),
    Buffer.from(
      `6 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\nstartxref\n0\n%%EOF\n`,
      'latin1'
    ),
  ]);
  return { pdf, expected };
}

/** FlateDecode page content shown with hex strings through a ToUnicode CMap. */
function cmapPdf() {
  const lines = [
    'C mapped fonts decode through their ToUnicode table without any trouble at all.',
    'Two byte hex codes map onto plain ASCII text, which proves the lookup works.',
    'The page moves down fourteen text units between lines, so breaks are kept.',
    'Every single character here comes from the b f char entries written above.',
  ];
  const codeOf = new Map();
  const hexes = [];
  for (const line of lines) {
    let hex = '';
    for (const ch of line) {
      if (!codeOf.has(ch)) codeOf.set(ch, 0x100 + codeOf.size);
      hex += codeOf.get(ch).toString(16).padStart(4, '0');
    }
    hexes.push(hex);
  }
  let bfchar = '';
  for (const [ch, code] of codeOf) {
    bfchar += `<${code.toString(16).padStart(4, '0')}> <${ch.charCodeAt(0).toString(16).padStart(4, '0')}>\n`;
  }
  const cmap =
    '/CIDInit /ProcSet findresource begin\n' +
    '12 dict begin\n' +
    'begincodespacerange\n<0000> <ffff>\nendcodespacerange\n' +
    `beginbfchar\n${bfchar}endbfchar\n` +
    'end\nend\n';
  const content =
    'BT\n/F1 12 Tf\n72 720 Td\n' +
    hexes.map((hex) => `<${hex}> Tj`).join('\n0 -14 Td\n') +
    '\nET\n';
  const deflated = deflateSync(Buffer.from(content, 'latin1'));
  const pdf = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>',
    4: `<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n${deflated.toString('latin1')}endstream`,
    5: `<< /Length ${cmap.length} >>\nstream\n${cmap}endstream`,
    6: '<< /Type /Font /Subtype /Type0 /BaseFont /Test-CID /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 5 0 R >>',
    7: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test >>',
  });
  return { pdf, expected: lines.join('\n') };
}

/** A scanned manual: image drawing only, no text operators at all. */
function imageOnlyPdf() {
  const content = 'q 216 0 0 279 72 460 cm /Im1 Do Q\n';
  return buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    4: '<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 64 >>\nstream\n' +
      'A'.repeat(64) + '\nendstream',
    5: `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  });
}

/** A page whose content stream uses an unsupported filter: skipped entirely. */
function asciiHexPdf() {
  const text = 'This text lives behind an ASCIIHexDecode filter which the reader must skip.';
  const content = `BT /F1 12 Tf 72 720 Td (${escapeLiteral(text)}) Tj ET\n`;
  const encoded = `${Buffer.from(content, 'latin1').toString('hex').toUpperCase()}>`;
  return buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    4: `<< /Length ${encoded.length} /Filter /ASCIIHexDecode >>\nstream\n${encoded}endstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  });
}

test('pdfText: an uncompressed page extracts exactly, TJ kerning keeps words together', () => {
  const result = extractPdfText(plainTextPdf());
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.pages, PLAIN_PAGES);
  assert.equal(result.chars, PLAIN_PAGES.join('').length);
  // Sanity: the fixture really passes the meaningful-characters threshold.
  assert.ok(result.chars >= 200, `fixture must be readable, got ${result.chars} chars`);
});

test('pdfText: FlateDecode page content with a ToUnicode CMap and hex strings', () => {
  const { pdf, expected } = cmapPdf();
  const result = extractPdfText(pdf);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.pages, [expected]);
  assert.equal(result.chars, expected.length);
});

test('pdfText: page objects inside a compressed ObjStm are found by scanning', () => {
  const { pdf, expected } = objStmPdf();
  const result = extractPdfText(pdf);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.pages, [expected]);
});

test('pdfText: an image-only page is no_text, other filters skip the stream', () => {
  const scanned = extractPdfText(imageOnlyPdf());
  assert.equal(scanned.status, 'no_text');
  assert.deepEqual(scanned.pages, ['']);
  assert.equal(scanned.chars, 0);

  const asciiHex = extractPdfText(asciiHexPdf());
  assert.equal(asciiHex.status, 'no_text', 'the unsupported stream is skipped');
});

test('pdfText: garbage bytes and encrypted documents are errors, never throws', () => {
  const garbage = extractPdfText(Buffer.from('this is plain text, nothing PDF about it'));
  assert.deepEqual(garbage, { status: 'error', pages: [], chars: 0 });

  const random = extractPdfText(crypto.randomBytes(512));
  assert.equal(random.status, 'error');

  const empty = extractPdfText(Buffer.alloc(0));
  assert.equal(empty.status, 'error');

  const encrypted = extractPdfText(
    buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        2: '<< /Type /Pages /Kids [] /Count 0 >>',
      },
      { trailerExtra: ' /Encrypt 9 0 R' }
    )
  );
  assert.deepEqual(encrypted, { status: 'error', pages: [], chars: 0 });

  // Even wrong input types never throw.
  assert.equal(extractPdfText(null).status, 'error');
  assert.equal(extractPdfText('nope').status, 'error');
});

// ---------------------------------------------------------------------------
// file_texts store functions (SPEC-v4.md section 4.2)
// ---------------------------------------------------------------------------

test('store: file_texts rows, getFileTextPages, and the startup sweep list', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v4m3-texts-'));
  let store = null;
  try {
    store = openStore(dataDir);
    const iso = new Date().toISOString();
    const pdfOk = uuid();
    const pdfPending = uuid();
    const pdfNone = uuid();
    const image = uuid();
    for (const [id, mime] of [
      [pdfOk, PDF_MIME],
      [pdfPending, PDF_MIME],
      [pdfNone, PDF_MIME],
      [image, 'image/png'],
    ]) {
      store.insertFile({ id, name: `${id.slice(0, 8)}.${mime.split('/')[1]}`, mime, size: 10, sha256: 'x', uploadedAt: iso });
    }

    assert.equal(store.getFileText(pdfOk), null);
    assert.equal(store.getFileTextPages(pdfOk), null, 'no row means no pages');

    store.upsertFileText({ fileId: pdfOk, status: 'ok', pages: ['page one', 'page two'], chars: 18, extractedAt: iso });
    assert.equal(store.getFileText(pdfOk).status, 'ok');
    assert.deepEqual(store.getFileTextPages(pdfOk), ['page one', 'page two']);

    // Rows replace each other; only 'ok' exposes pages.
    store.upsertFileText({ fileId: pdfOk, status: 'no_text', pages: [], chars: 0, extractedAt: iso });
    assert.equal(store.getFileTextPages(pdfOk), null);
    store.upsertFileText({ fileId: pdfOk, status: 'error', pages: [], chars: 0, extractedAt: iso });
    assert.equal(store.getFileTextPages(pdfOk), null);
    assert.equal(store.getFileTextPages(uuid()), null);

    // The startup sweep list: pending or missing PDFs, never images, never done ones.
    store.upsertFileText({ fileId: pdfPending, status: 'pending', pages: [], chars: 0, extractedAt: null });
    const needing = store.listFilesNeedingText().map((row) => row.id);
    assert.deepEqual(needing.sort(), [pdfNone, pdfPending].sort());
    store.upsertFileText({ fileId: pdfPending, status: 'ok', pages: ['p'], chars: 1, extractedAt: iso });
    assert.deepEqual(store.listFilesNeedingText().map((row) => row.id), [pdfNone]);
  } finally {
    if (store !== null) store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Streaming PDF uploads (SPEC-v4.md section 4.2): temp file, 50 MB, cleanup
// ---------------------------------------------------------------------------

/** A minimal fake http.IncomingMessage for driving the upload by hand. */
class FakeRequest extends EventEmitter {
  constructor({ contentType = PDF_MIME, fileName = 'manual.pdf', contentLength } = {}) {
    super();
    this.headers = {
      'content-type': contentType,
      'x-file-name': encodeURIComponent(fileName),
    };
    if (contentLength !== undefined) this.headers['content-length'] = String(contentLength);
  }
  resume() {}
  send(chunks) {
    for (const chunk of chunks) this.emit('data', chunk);
    this.emit('end');
    return this;
  }
}

test('stream upload: PDF bytes stream to disk, hash and size are right, no temp left', async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v4m3-stream-'));
  let store = null;
  try {
    store = openStore(dataDir);
    const bytes = plainTextPdf().subarray(0, 600);
    const req = new FakeRequest({ fileName: 'small manual.pdf' });
    const pending = createUploadedFile(store, dataDir, req, { uploadedBy: null });
    // Chunks under five bytes cross the magic-byte buffer boundary.
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.subarray(i, i + 3));
    req.send(chunks);
    const file = await pending;
    assert.equal(file.mime, PDF_MIME);
    assert.equal(file.size, bytes.length);
    const stored = fs.readFileSync(path.join(FILES_DIR(dataDir), file.fileId));
    assert.ok(stored.equals(bytes), 'the stored bytes are exactly what was streamed');
    const row = store.getFileById(file.fileId);
    assert.equal(Number(row.size), bytes.length);
    assert.equal(row.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(tempFilesIn(dataDir), [], 'no temp file is left behind');
  } finally {
    if (store !== null) store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('stream upload: wrong magic bytes, oversized bodies and stream errors clean up', async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v4m3-fails-'));
  let store = null;
  try {
    store = openStore(dataDir);

    // PNG magic declared as application/pdf → 415, no temp file.
    const fakePng = new FakeRequest({ fileName: 'not-a-pdf.pdf' });
    const wrongMagic = createUploadedFile(store, dataDir, fakePng, {});
    fakePng.send([Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]), Buffer.alloc(64)])]);
    await assert.rejects(wrongMagic, (err) => err.status === 415 && err.code === 'unsupported_media_type');
    assert.deepEqual(tempFilesIn(dataDir), []);

    // A declared Content-Length over 50 MB → 413 before a single byte is read.
    const declared = new FakeRequest({ contentLength: 51 * 1024 * 1024 });
    const declaredUpload = createUploadedFile(store, dataDir, declared, {});
    declared.send([Buffer.alloc(64)]);
    await assert.rejects(declaredUpload, (err) => err.status === 413 && err.code === 'payload_too_large');
    assert.deepEqual(tempFilesIn(dataDir), []);

    // Chunked (no Content-Length): the 50 MB limit aborts at the limit.
    // The body starts with a valid %PDF- header so the magic check passes.
    const chunked = new FakeRequest();
    const chunkedUpload = createUploadedFile(store, dataDir, chunked, {});
    const pdfHead = Buffer.from('%PDF-1.4\n');
    const lead = Buffer.concat([pdfHead, Buffer.alloc(20 * 1024 * 1024 - pdfHead.length)]);
    const twenty = Buffer.alloc(20 * 1024 * 1024);
    chunked.send([lead, twenty, twenty]);
    await assert.rejects(chunkedUpload, (err) => err.status === 413 && err.code === 'payload_too_large');
    assert.deepEqual(tempFilesIn(dataDir), [], 'the temp file is deleted after the limit hit');

    // A broken request stream rejects and leaves nothing behind.
    const broken = new FakeRequest();
    const brokenUpload = createUploadedFile(store, dataDir, broken, {});
    broken.emit('data', plainTextPdf().subarray(0, 32));
    broken.emit('error', new Error('socket went away'));
    await assert.rejects(brokenUpload, /socket went away/);
    assert.deepEqual(tempFilesIn(dataDir), []);
  } finally {
    if (store !== null) store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Through the HTTP server: routes, permissions, limits, background extraction
// ---------------------------------------------------------------------------

let handle;
let base;
let adaSid;
let noraSid;
/** fileIds shared between the HTTP tests (earlier tests fill these in). */
const uploaded = {};

function setCookies(res) {
  return res.headers.getSetCookie === undefined ? [] : res.headers.getSetCookie();
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function login(username, password) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ username, password }),
  });
  const cookie = setCookies(res).find((value) => value.startsWith('sid='));
  assert.ok(cookie, `login failed for ${username}`);
  return cookie.split(';')[0].slice('sid='.length);
}

async function api(pathname, { method = 'GET', sid = adaSid, headers = {}, body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(sid === null ? {} : { cookie: `sid=${sid}` }),
      ...XRW,
      ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { res, body: await readJson(res) };
}

async function upload(sid, { contentType, fileName, body }) {
  const res = await fetch(`${base}/api/files`, {
    method: 'POST',
    headers: {
      ...(sid === null ? {} : { cookie: `sid=${sid}` }),
      'content-type': contentType,
      'x-file-name': encodeURIComponent(fileName),
      ...XRW,
    },
    body,
  });
  return { res, body: await readJson(res) };
}

async function waitForTextStatus(sid, fileId, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { res, body } = await api(`/api/files/${fileId}/text-status`, { sid });
    assert.equal(res.status, 200, JSON.stringify(body));
    if (body.status !== 'pending') return body;
    if (Date.now() > deadline) throw new Error(`text-status still pending for ${fileId}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v4m3-server-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  base = handle.url;
  handle.store.createUser({
    username: 'ada',
    displayName: 'Ada Admin',
    role: 'admin',
    passwordHash: auth.hashPassword('ada-password-1'),
  });
  const noFilesOrLibrary = handle.store.createRole({ name: 'No Files', permissions: {}, updatedBy: null });
  handle.store.createUser({
    username: 'nora',
    displayName: 'Nora Noaccess',
    roleId: noFilesOrLibrary.id,
    passwordHash: auth.hashPassword('nora-password-1'),
  });
  adaSid = await login('ada', 'ada-password-1');
  noraSid = await login('nora', 'nora-password-1');
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
});

test('HTTP: libraryItems save through the generic record routes with the library area', async () => {
  const id = uuid();
  const created = await api(`/api/records/libraryItems/${id}`, {
    method: 'PUT',
    body: { data: { kind: 'method', title: 'Needle bar drift', machineType: 'single-needle', steps: [{ id: 's1', text: 'Measure first.' }] } },
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.record.store, 'libraryItems');
  assert.equal(created.body.record.data.kind, 'method');
  assert.deepEqual(created.body.record.data.steps, [{ id: 's1', text: 'Measure first.' }]);
  assert.deepEqual(created.body.record.data.models, []);
  assert.equal(created.body.record.version, 1);

  // Validation through HTTP keeps the flat error shape.
  const bad = await api(`/api/records/libraryItems/${uuid()}`, {
    method: 'PUT',
    body: { data: { kind: 'manual', title: 'Manual', symptom: 'not allowed' } },
  });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.body.error, 'bad_request');
  assert.match(bad.body.message, /libraryItems\.symptom is only allowed/);

  // History records the write; the changes feed carries the store.
  const history = await api(`/api/history/libraryItems/${id}`);
  assert.equal(history.res.status, 200);
  assert.equal(history.body[history.body.length - 1].action, 'create');
  const feed = await api('/api/changes?since=0&limit=1000');
  assert.ok(feed.body.records.some((record) => record.store === 'libraryItems' && record.id === id));

  // A role without library access gets 403 on write and nothing in the feed.
  const denied = await api(`/api/records/libraryItems/${uuid()}`, {
    method: 'PUT',
    sid: noraSid,
    body: { data: { kind: 'manual', title: 'Nope' } },
  });
  assert.equal(denied.res.status, 403);
  assert.equal(denied.body.error, 'forbidden');
  const noraFeed = await api('/api/changes?since=0&limit=1000', { sid: noraSid });
  assert.equal(
    noraFeed.body.records.some((record) => record.store === 'libraryItems'),
    false,
    'stores the role cannot read are hidden entirely',
  );
});

test('HTTP: a text PDF uploads, text-status becomes ok with pages and chars', async () => {
  const uploadRes = await upload(adaSid, { contentType: PDF_MIME, fileName: 'juki-ddl8700-manual.pdf', body: plainTextPdf() });
  assert.equal(uploadRes.res.status, 201, JSON.stringify(uploadRes.body));
  assert.equal(uploadRes.body.mime, PDF_MIME);
  uploaded.helpFileId = uploadRes.body.fileId;
  assert.deepEqual(tempFilesIn(handle.config.dataDir), []);

  const status = await waitForTextStatus(adaSid, uploaded.helpFileId);
  assert.equal(status.status, 'ok', JSON.stringify(status));
  assert.equal(status.pages, 2);
  assert.equal(status.chars, PLAIN_PAGES.join('').length);

  // The pages are stored for the AI to read (V4-M5).
  assert.deepEqual(handle.store.getFileTextPages(uploaded.helpFileId), PLAIN_PAGES);
});

test('HTTP: an image-only PDF reports no_text, garbage bytes never upload', async () => {
  const scanRes = await upload(adaSid, { contentType: PDF_MIME, fileName: 'scanned-manual.pdf', body: imageOnlyPdf() });
  assert.equal(scanRes.res.status, 201);
  const status = await waitForTextStatus(adaSid, scanRes.body.fileId);
  assert.deepEqual(status, { status: 'no_text', chars: 0, pages: 1 });

  // Not a PDF at all: the magic bytes reject it before any row exists.
  const garbage = await upload(adaSid, {
    contentType: PDF_MIME,
    fileName: 'garbage.pdf',
    body: Buffer.from('just some bytes that claim to be a manual'),
  });
  assert.equal(garbage.res.status, 415);
  assert.equal(garbage.body.error, 'unsupported_media_type');
  assert.deepEqual(tempFilesIn(handle.config.dataDir), []);
});

test('HTTP: text-status pending, 404s and the files permission', async () => {
  // A PDF row with no extraction yet answers pending (in queue, not done).
  const iso = new Date().toISOString();
  const dangling = uuid();
  handle.store.insertFile({ id: dangling, name: 'dangling.pdf', mime: PDF_MIME, size: 9, sha256: 'd', uploadedAt: iso });
  const pending = await api(`/api/files/${dangling}/text-status`);
  assert.deepEqual(pending.body, { status: 'pending' });

  // Non-PDF files have no text status at all.
  const isoPng = uuid();
  handle.store.insertFile({ id: isoPng, name: 'photo.png', mime: 'image/png', size: 9, sha256: 'p', uploadedAt: iso });
  const pngStatus = await api(`/api/files/${isoPng}/text-status`);
  assert.equal(pngStatus.res.status, 404);
  assert.equal(pngStatus.body.error, 'not_found');

  const missing = await api(`/api/files/${uuid()}/text-status`);
  assert.equal(missing.res.status, 404);
  const notUuid = await api('/api/files/definitely-not-a-uuid/text-status');
  assert.equal(notUuid.res.status, 404);

  // needs files read.
  const denied = await api(`/api/files/${uploaded.helpFileId}/text-status`, { sid: noraSid });
  assert.equal(denied.res.status, 403);
  assert.equal(denied.body.error, 'forbidden');
  assert.equal(typeof denied.body.message, 'string');
});

test('HTTP: a 16 MB PDF is accepted, a 16 MB PNG and a 51 MB PDF are 413', async () => {
  // 16 MB PDF: above the old 15 MB image limit, far under the 50 MB PDF limit.
  const pad = 16 * 1024 * 1024;
  const smallPad = pad + 1024;
  const filler =
    `<< /Length ${smallPad} >>\nstream\n` + 'P'.repeat(smallPad) + '\nendstream';
  const big = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    4: `<< /Length ${PLAIN_PAGES[0].length} >>\nstream\nBT /F1 12 Tf 72 720 Td (${escapeLiteral(PLAIN_PAGES[0])}) Tj ET\nendstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    9: filler,
  });
  assert.ok(big.length > pad && big.length < 50 * 1024 * 1024, `fixture size ${big.length}`);
  const accepted = await upload(adaSid, { contentType: PDF_MIME, fileName: 'big-manual.pdf', body: big });
  assert.equal(accepted.res.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.size, big.length);
  const status = await waitForTextStatus(adaSid, accepted.body.fileId);
  assert.equal(status.status, 'ok', JSON.stringify(status));
  assert.equal(status.pages, 1);
  assert.equal(status.chars, PLAIN_PAGES[0].length);
  assert.deepEqual(tempFilesIn(handle.config.dataDir), []);

  // 16 MB PNG: images stay at 15 MB.
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngBody = Buffer.concat([pngMagic, Buffer.alloc(16 * 1024 * 1024 - pngMagic.length)]);
  const pngRejected = await upload(adaSid, { contentType: 'image/png', fileName: 'huge.png', body: pngBody });
  assert.equal(pngRejected.res.status, 413);
  assert.equal(pngRejected.body.error, 'payload_too_large');

  // 51 MB PDF: rejected before a byte is stored, no temp file left behind.
  const tooBig = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(51 * 1024 * 1024)]);
  const pdfRejected = await upload(adaSid, { contentType: PDF_MIME, fileName: 'huge.pdf', body: tooBig });
  assert.equal(pdfRejected.res.status, 413);
  assert.equal(pdfRejected.body.error, 'payload_too_large');
  assert.deepEqual(tempFilesIn(handle.config.dataDir), [], 'no temp file is left behind');
});

test('HTTP: backups include the file_texts rows', async () => {
  const created = await api('/api/backups', { method: 'POST' });
  assert.equal(created.res.status, 200, JSON.stringify(created.body));
  const list = await api('/api/backups');
  assert.equal(list.res.status, 200);
  assert.ok(list.body.some((row) => row.file === created.body.file));

  const download = await fetch(`${base}/api/backups/${encodeURIComponent(created.body.file)}`, {
    headers: { cookie: `sid=${adaSid}`, ...XRW },
  });
  assert.equal(download.status, 200);
  const backupPath = path.join(TMP, `v4m3-backup-${uuid()}.db`);
  try {
    fs.writeFileSync(backupPath, Buffer.from(await download.arrayBuffer()));
    const db = new DatabaseSync(backupPath);
    try {
      const rows = db.prepare('SELECT file_id, status, chars, extracted_at FROM file_texts').all();
      const ours = rows.find((row) => row.file_id === uploaded.helpFileId);
      assert.ok(ours, 'the uploaded manual has a file_texts row in the backup');
      assert.equal(ours.status, 'ok');
      assert.equal(Number(ours.chars), PLAIN_PAGES.join('').length);
      assert.equal(typeof ours.extracted_at, 'string');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(backupPath, { force: true });
  }
});
test('pdfText: word gaps drawn without space glyphs become spaces; per-glyph placement does not', () => {
  const content =
    'BT\n/F1 12 Tf\n72 720 Td\n' +
    // LaTeX style: a big TJ gap is a word space, a small one is kerning.
    '[(Needle) -333 (bar) -20 (height) -400 (12.5mm)] TJ\n' +
    // Word-by-word placement on the same line.
    '0 -14 Td\n(Check) Tj\n30 0 Td\n(hook) Tj\n25 0 Td\n(timing) Tj\n' +
    // Chrome style: each glyph moved on its own, real space glyphs drawn.
    '0 -14 Td\n(O) Tj\n7 0 Td\n(i) Tj\n3 0 Td\n(l) Tj\n3 0 Td\n( ) Tj\n3 0 Td\n(d) Tj\n7 0 Td\n(a) Tj\n7 0 Td\n(i) Tj\n3 0 Td\n(l) Tj\n3 0 Td\n(y) Tj\n' +
    'ET\nBT\n/F1 12 Tf\n1 0 0 1 300 692 Tm\n(before use) Tj\nET\n' +
    `BT\n(${escapeLiteral('x'.repeat(200))}) Tj\nET\n`;
  const pdf = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    4: `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  });
  const result = extractPdfText(pdf);
  assert.equal(result.status, 'ok');
  const lines = result.pages[0].split('\n');
  assert.equal(lines[0], 'Needle barheight 12.5mm');
  assert.equal(lines[1], 'Check hook timing');
  assert.ok(lines[2].startsWith('Oil daily before use '), lines[2].slice(0, 40));
});

test('pdfText: text inside form XObjects (web-to-PDF manuals) is read; a self-drawing form cannot loop', () => {
  const pageContent = 'BT\n/F1 9 Tf\n10 10 Td\n(Downloaded from a manuals site) Tj\nET\n/Fm1 Do\n';
  const filler = 'Adjust the needle bar height so the hook point meets the needle 1.5 mm above the eye. '.repeat(3);
  const formContent = `BT\n/F1 12 Tf\n72 720 Td\n(${escapeLiteral(filler)}) Tj\nET\n/Fm1 Do\n`;
  const pdf = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 6 0 R >> >> /Contents 4 0 R >>',
    4: `<< /Length ${pageContent.length} >>\nstream\n${pageContent}endstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    // The form draws itself again (a loop) and inherits the page's resources.
    6: `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Length ${formContent.length} >>\nstream\n${formContent}endstream`,
  });
  const result = extractPdfText(pdf);
  assert.equal(result.status, 'ok');
  assert.equal(result.pages[0], `Downloaded from a manuals site\n${filler}`);
});
