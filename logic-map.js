// Pure helpers for the floor map (SPEC-v5.md sections 1-3): slot rectangles
// from a box, a station's live state, station search, text fitting inside a
// slot, grid snapping and hit-testing. No DOM, no fetch, no stores — the
// module is unit-tested in tests/v5m1.test.js and rendered by app.js (V5-M2).

import { pmDueDate, pmPaused, todayISO } from './logic.js';

/** The edit canvas snap grid (SPEC-v5.md section 3): 2 drawing units. */
export const SNAP_GRID = 2;

/** Boxes hold 1-12 stations stacked top to bottom in equal parts (1.1). */
export const BOX_SLOTS_MIN = 1;
export const BOX_SLOTS_MAX = 12;

/**
 * The rectangles of a box's `slots` stations, stacked top to bottom in equal
 * parts (SPEC-v5.md section 1.1). Each entry is `{x, y, w, h, slot}`; a box
 * without a usable `slots` count renders one full-size slot. Pure: invalid
 * input yields all-zero rects, never a throw (the canvas must keep drawing).
 * @param {{x?: number, y?: number, w?: number, h?: number, slots?: number}} box
 * @returns {Array<{x: number, y: number, w: number, h: number, slot: number}>}
 */
export function slotRects(box) {
  if (box === null || typeof box !== 'object') return [];
  const count = Number.isInteger(box.slots)
    ? Math.min(BOX_SLOTS_MAX, Math.max(BOX_SLOTS_MIN, box.slots))
    : BOX_SLOTS_MIN;
  const x = numberOr(box.x, 0);
  const y = numberOr(box.y, 0);
  const w = numberOr(box.w, 0);
  const h = numberOr(box.h, 0);
  const part = h / count;
  return Array.from({ length: count }, (_, slot) => ({
    x,
    y: y + part * slot,
    w,
    h: part,
    slot,
  }));
}

/**
 * A station's live state from its linked machine (SPEC-v5.md section 2):
 * `down` when the machine is down, `openOrders` the count of its service
 * orders that are not done yet, `pmOverdue` when an active PM task on the
 * machine is overdue. PM on in-storage/retired machines is paused
 * (SPEC-v2.md 15.3), and an unlinked station is plain: all-false/zero.
 * Machines, work orders and PM tasks are the synced local records
 * (`{id, ...data}` shape); `today` defaults to the local date.
 * @param {object|null} station a floorStations record
 * @param {{machines?: Array, workOrders?: Array, pmTasks?: Array, today?: string}} state
 * @returns {{down: boolean, openOrders: number, pmOverdue: boolean}}
 */
export function stationState(
  station,
  { machines = [], workOrders = [], pmTasks = [], today = todayISO() } = {},
) {
  if (station === null || typeof station !== 'object') {
    return { down: false, openOrders: 0, pmOverdue: false };
  }
  const machineId = typeof station.machineId === 'string' ? station.machineId : null;
  const machine =
    machineId === null ? null : machines.find((entry) => entry && entry.id === machineId) ?? null;
  const down = machine !== null && machine.status === 'down';
  const openOrders = workOrders.filter(
    (order) => order && order.machineId === machineId && order.status !== 'done',
  ).length;
  let pmOverdue = false;
  if (machine !== null && !pmPaused(machine)) {
    pmOverdue = pmTasks.some(
      (task) =>
        task &&
        task.machineId === machineId &&
        task.active !== false &&
        String(pmDueDate(task, today)) < today,
    );
  }
  return { down, openOrders, pmOverdue };
}

/**
 * Search stations (SPEC-v5.md section 2 toolbar): a case-insensitive
 * substring match over the code, both staff names, the employee ID and the
 * linked machine's name. An empty query returns every station, like the other
 * search helpers in logic.js. Tombstone filtering is the caller's job (the
 * synced lists never carry them).
 * @param {Array<object>} stations local floorStations records
 * @param {string} query the search box text
 * @param {Array<object>} machines local machine records (for their names)
 * @returns {Array<object>} the matching stations, order kept
 */
export function searchStations(stations, query, machines = []) {
  const list = Array.isArray(stations) ? stations : [];
  const needle = String(query ?? '').toLowerCase().trim();
  if (needle === '') return list.slice();
  const machineNames = new Map(
    (Array.isArray(machines) ? machines : [])
      .filter((machine) => machine && typeof machine.id === 'string')
      .map((machine) => [machine.id, String(machine.name ?? '').toLowerCase()]),
  );
  return list.filter((station) => {
    if (station === null || typeof station !== 'object') return false;
    const machineName = machineNames.get(station.machineId) ?? '';
    return [station.code, station.name, station.nameCn, station.empId, machineName].some(
      (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
    );
  });
}

// --- Text fitting -----------------------------------------------------------
//
// The station code and staff name wrap inside their slot and shrink to fit;
// the text never overflows the box (SPEC-v5.md section 2). All measures are
// in drawing units: an average glyph is ~0.6 of the font size wide and a line
// is 1.2 font sizes tall (sans-serif approximations, SVG-rendered later).

export const FIT_CHAR_WIDTH = 0.6;
const FIT_LINE_HEIGHT = 1.2;
const FIT_MIN_SIZE = 4;
const FIT_MAX_SIZE = 14;
const FIT_STEP = 0.5;
// Below FIT_MIN_SIZE text keeps shrinking (in finer steps) so nothing is cut
// off; zoom or the PDF makes it readable.
const FIT_FLOOR = 1.5;

/**
 * Greedy word wrap at `maxChars` per line: a word that fits whole never
 * splits; a word longer than a line is hard-sliced. No characters are lost.
 * @param {string} text
 * @param {number} maxChars at least 1
 * @returns {Array<string>} the lines; empty for empty input
 */
export function wrapWords(text, maxChars) {
  const words = String(text).split(/\s+/).filter((word) => word !== '');
  const lines = [];
  let current = '';
  const flush = () => {
    if (current !== '') {
      lines.push(current);
      current = '';
    }
  };
  for (const word of words) {
    let rest = word;
    while (rest.length > 0) {
      if (current === '') {
        if (rest.length <= maxChars) {
          current = rest;
          rest = '';
        } else {
          current = rest.slice(0, maxChars);
          rest = rest.slice(maxChars);
          flush();
        }
      } else if (`${current} ${rest}`.length <= maxChars) {
        current += ` ${rest}`;
        rest = '';
      } else if (rest.length <= maxChars) {
        // The word fits whole on the next line: never split it here.
        flush();
      } else {
        // Longer than a whole line: fill this line, continue on the next.
        current += ` ${rest.slice(0, maxChars - current.length - 1)}`;
        rest = rest.slice(maxChars - current.length - 1);
        flush();
      }
    }
  }
  flush();
  return lines;
}

/**
 * Fit `text` inside a slot `w` x `h` drawing units: wraps at word boundaries
 * and shrinks the font (14 down to 4, half steps) until the wrapped block
 * fits the height. When even the smallest normal size cannot fit, the words
 * are hard-sliced at the minimum size and only the lines that fit are kept,
 * so the result never overflows the box.
 * @param {string|null} text
 * @param {number} w slot width in drawing units
 * @param {number} h slot height in drawing units
 * @returns {{lines: Array<string>, fontSize: number}} empty text -> no lines
 */
export function fitText(text, w, h) {
  const clean = String(text ?? '').trim();
  if (clean === '' || !(Number(w) > 0) || !(Number(h) > 0)) {
    return { lines: [], fontSize: 0 };
  }
  let fontSize = FIT_MAX_SIZE;
  while (fontSize >= FIT_FLOOR) {
    const maxChars = Math.max(1, Math.floor(w / (fontSize * FIT_CHAR_WIDTH)));
    const lines = wrapWords(clean, maxChars);
    if (lines.length * fontSize * FIT_LINE_HEIGHT <= h) {
      return { lines, fontSize: Math.round(fontSize * 10) / 10 };
    }
    fontSize -= fontSize > FIT_MIN_SIZE ? FIT_STEP : FIT_STEP / 2;
    if (fontSize < FIT_MIN_SIZE && fontSize < FIT_FLOOR) break;
  }
  // Nothing fits at 4: hard-slice, and let the size shrink below 4 so the
  // kept lines still fit a very flat slot (never overflow the box).
  const maxChars = Math.max(1, Math.floor(w / (FIT_MIN_SIZE * FIT_CHAR_WIDTH)));
  const all = wrapWords(clean, maxChars);
  const size = Math.min(FIT_MIN_SIZE, h / FIT_LINE_HEIGHT);
  const maxLines = Math.max(1, Math.floor(h / (size * FIT_LINE_HEIGHT) + 1e-9));
  return { lines: all.slice(0, maxLines), fontSize: size };
}

// --- Slot text (V5-M4, client feedback 2026-10-22) -------------------------
//
// Every line in a slot — the station code and the person line — shares ONE
// font size, so codes are no longer much bigger than names. The size is the
// largest (capped at SLOT_TEXT_MAX, V5-M4b) at which all wrapped rows fit
// inside the slot with FIT_SLOT_PAD breathing room, and words are never split
// while any size >= the floor fits with whole words: only a single word wider
// than the slot at the floor size may be hard-sliced (which is why
// fitSlotText("Ribbon cutting", 22.1, 28.3) wraps to "Ribbon" / "cutting",
// never "Ribb" / "on c").

/** Padding kept around the text inside a slot, in drawing units. */
export const FIT_SLOT_PAD = 1.2;

/**
 * The Auto (default-fit) slot text size never exceeds this, in drawing units
 * (V5-M4b, PM browser check of V5-M4 2026-10-22): a code alone in a big cell
 * would otherwise reach FIT_MAX_SIZE and tower over its neighbours ("SN 41"
 * drawn ~12 units next to "End QC 1" at 7). With the cap every cell reads at a
 * similar size; smaller cells still shrink to fit exactly as before. A Text
 * control step multiplies the capped Auto size — an explicit choice may
 * still go above it.
 */
export const SLOT_TEXT_MAX = 7;
const ELLIPSIS = '…';

/** The longest word of `text` (split on whitespace); 0 for empty text. */
function longestWord(text) {
  let longest = 0;
  for (const word of String(text).split(/\s+/)) {
    if (word.length > longest) longest = word.length;
  }
  return longest;
}

/**
 * A word that fits `maxChars` whole never splits; when a word is wider than
 * that, the line simply stops before it (nothing is sliced). `rows` are the
 * kept whole-word lines, `truncated` says whether any word was left out.
 * @param {string} text
 * @param {number} maxChars at least 1
 * @returns {{rows: Array<string>, truncated: boolean}}
 */
function wrapFitWords(text, maxChars) {
  const words = String(text).split(/\s+/).filter((word) => word !== '');
  const rows = [];
  let current = '';
  let truncated = false;
  for (const word of words) {
    if (word.length > maxChars) {
      truncated = true;
      break;
    }
    if (current === '') current = word;
    else if (`${current} ${word}`.length <= maxChars) current += ` ${word}`;
    else {
      rows.push(current);
      current = word;
    }
  }
  if (current !== '') rows.push(current);
  return { rows, truncated };
}

/**
 * The Auto fit for one slot: the largest size (SLOT_TEXT_MAX down, half steps
 * above 4, quarter steps below) at which EVERY input line wraps into whole
 * words that fit the width and all rows together fit the height. When no size
 * >= floor manages that, wrapWords hard-slices at the floor width and only the
 * rows that fit are kept (mirroring fitText), the first line (the code) first.
 * @param {Array<string>} input non-empty trimmed lines, code first
 * @param {number} padW slot width minus padding (> 0)
 * @param {number} padH slot height minus padding (> 0)
 * @param {number} floor the minimum font size (capped at SLOT_TEXT_MAX)
 * @returns {{lines: Array<Array<string>>, fontSize: number}}
 */
function fitSlotAuto(input, padW, padH, floor) {
  // Auto never starts above the cap (V5-M4b): a lone code in a big cell must
  // read at the same size as its neighbours, not fill the whole box.
  let fontSize = Math.min(FIT_MAX_SIZE, SLOT_TEXT_MAX);
  while (fontSize >= floor - 1e-9) {
    const maxChars = Math.max(1, Math.floor(padW / (fontSize * FIT_CHAR_WIDTH)));
    if (input.every((text) => longestWord(text) <= maxChars)) {
      const lines = input.map((text) => wrapWords(text, maxChars));
      const rows = lines.reduce((sum, wrapped) => sum + wrapped.length, 0);
      if (rows * fontSize * FIT_LINE_HEIGHT <= padH + 1e-9) {
        return { lines, fontSize: Math.round(fontSize * 10) / 10 };
      }
    }
    fontSize -= fontSize > FIT_MIN_SIZE ? FIT_STEP : FIT_STEP / 2;
  }
  const maxChars = Math.max(1, Math.floor(padW / (floor * FIT_CHAR_WIDTH)));
  const size = Math.min(floor, padH / FIT_LINE_HEIGHT, SLOT_TEXT_MAX);
  const maxRows = Math.max(1, Math.floor(padH / (size * FIT_LINE_HEIGHT) + 1e-9));
  const lines = input.map(() => []);
  let left = maxRows;
  for (const [index, wrapped] of input
    .map((text) => wrapWords(text, maxChars))
    .entries()) {
    lines[index] = wrapped.slice(0, Math.max(0, left));
    left -= wrapped.length;
  }
  return { lines, fontSize: Math.round(size * 10) / 10 };
}

/**
 * The text layout of ONE station slot (V5-M4): `lines` are the slot's text
 * lines, lines[0] the station code (always kept) and lines[1] the person line
 * "<employee ID> <staff name>" built by personLine(); every returned row uses
 * the SAME fontSize. `lines[i]` holds the wrapped rows of input line i.
 *
 * scale 1 (Auto, the default) picks the largest size — capped at
 * SLOT_TEXT_MAX (V5-M4b) — at which all rows fit with whole words (see
 * fitSlotAuto). Other steps multiply the Auto size for the whole slot: the lines re-wrap at the multiplied size, rows that no
 * longer fit are dropped from the bottom and the last kept row ends with an
 * ellipsis, and lines[0] (the code) is always kept — when not even its first
 * row would fit, the whole slot falls back to its Auto layout.
 *
 * @param {Array<string|null>} lines the slot's text lines, code first
 * @param {number} w slot width in drawing units (padding FIT_SLOT_PAD inside)
 * @param {number} h slot height in drawing units (padding FIT_SLOT_PAD inside)
 * @param {{floor?: number, scale?: number}} [options] floor defaults to 1.5,
 *   scale to 1 (Auto)
 * @returns {{lines: Array<Array<string>>, fontSize: number}} fontSize 0 when
 *   there is no text or no room
 */
export function fitSlotText(lines, w, h, { floor = FIT_FLOOR, scale = 1 } = {}) {
  const input = (Array.isArray(lines) ? lines : [])
    .map((line) => String(line ?? '').trim())
    .filter((line) => line !== '');
  const padW = Number(w) - FIT_SLOT_PAD * 2;
  const padH = Number(h) - FIT_SLOT_PAD * 2;
  if (input.length === 0 || !(padW > 0) || !(padH > 0)) {
    return { lines: [], fontSize: 0 };
  }
  const minFloor = Number.isFinite(floor) && floor > 0 ? floor : FIT_FLOOR;
  const auto = fitSlotAuto(input, padW, padH, minFloor);
  const k = Number(scale);
  if (!Number.isFinite(k) || k === 1) return auto;
  const size = Math.round(auto.fontSize * k * 10) / 10;
  if (!(size > 0)) return auto;
  // The multiplied size for the WHOLE slot (V5-M4): re-wrap without ever
  // slicing a word, drop rows that no longer fit from the bottom, mark the
  // last kept row with an ellipsis, keep the code.
  const maxChars = Math.max(1, Math.floor(padW / (size * FIT_CHAR_WIDTH)));
  const wrapped = input.map((text) => wrapFitWords(text, maxChars));
  const codeFits =
    wrapped[0].rows.length > 0 && size * FIT_LINE_HEIGHT <= padH + 1e-9;
  if (!codeFits) return auto;
  const maxRows = Math.max(1, Math.floor(padH / (size * FIT_LINE_HEIGHT) + 1e-9));
  const out = input.map(() => []);
  let dropped = false;
  let left = maxRows;
  for (const [index, { rows, truncated }] of wrapped.entries()) {
    out[index] = rows.slice(0, Math.max(0, left));
    left -= rows.length;
    dropped = dropped || truncated || out[index].length < rows.length;
  }
  if (dropped) {
    for (let index = out.length - 1; index >= 0; index -= 1) {
      if (out[index].length > 0) {
        out[index] = [
          ...out[index].slice(0, -1),
          `${out[index][out[index].length - 1].replace(/…$/, '')}${ELLIPSIS}`,
        ];
        break;
      }
    }
  }
  return { lines: out, fontSize: size };
}

/**
 * The one person line under the station code: the employee ID first, then the
 * staff name — "123 Doe, Jo Jo", exactly like the client's printed plan.
 * The ID alone or the name alone when the other is empty, '' when both are.
 * (SPEC-v5.md section 2: nothing else about the person is shown on the map.)
 * @param {{empId?: string|null, name?: string|null}} station
 * @returns {string}
 */
export function personLine(station) {
  const empId = String((station && station.empId) ?? '').trim();
  const name = String((station && station.name) ?? '').trim();
  if (empId && name) return `${empId} ${name}`;
  return empId || name;
}

// --- Snap and hit-testing ---------------------------------------------------

/**
 * Snap `value` to a `grid` (SPEC-v5.md section 3: the 2-unit grid, on by
 * default). Half-way values round up; the result keeps at most two decimals
 * so the stored record stays clean. A non-finite value passes through.
 * @param {number} value
 * @param {number} [grid=SNAP_GRID] a positive grid size
 * @returns {number}
 */
export function snap(value, grid = SNAP_GRID) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  const step = typeof grid === 'number' && Number.isFinite(grid) && grid > 0 ? grid : SNAP_GRID;
  const snapped = Math.round(value / step) * step;
  return Math.round(snapped * 100) / 100;
}

/**
 * The topmost map element at drawing-unit point (`x`, `y`): boxes first (the
 * stations sit above the floor), then patches, then corridors; within one
 * list the later entry wins (it paints above the earlier one). Returns
 * `{kind, shape}` or null when nothing is hit.
 * @param {object} map a floorMaps record data (`boxes`, `corridors`, `fills`)
 * @param {number} x
 * @param {number} y
 * @returns {{kind: 'box'|'fill'|'corridor', shape: object}|null}
 */
export function hitTest(map, x, y) {
  if (map === null || typeof map !== 'object' || typeof x !== 'number' || !Number.isFinite(x)
    || typeof y !== 'number' || !Number.isFinite(y)) {
    return null;
  }
  const layers = [
    ['box', Array.isArray(map.boxes) ? map.boxes : []],
    ['fill', Array.isArray(map.fills) ? map.fills : []],
    ['corridor', Array.isArray(map.corridors) ? map.corridors : []],
  ];
  const inRect = (shape) =>
    shape !== null &&
    typeof shape === 'object' &&
    x >= Number(shape.x ?? NaN) &&
    x <= Number(shape.x ?? NaN) + Number(shape.w ?? NaN) &&
    y >= Number(shape.y ?? NaN) &&
    y <= Number(shape.y ?? NaN) + Number(shape.h ?? NaN);
  for (const [kind, shapes] of layers) {
    for (let index = shapes.length - 1; index >= 0; index -= 1) {
      if (inRect(shapes[index])) return { kind, shape: shapes[index] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// V5-M3 edit canvas (SPEC-v5.md section 3): pure geometry for moving,
// resizing, rubber-band selection, the undo stack, the off-map calculation
// and the pre-save rounding/limits. The DOM canvas lives in map.js; these are
// unit-tested in tests/v5m3.test.js.
// ---------------------------------------------------------------------------

/** The stored number range (SPEC-v5.md 1.1): finite, −10000…20000. */
export const MAP_COORD_MIN = -10000;
export const MAP_COORD_MAX = 20000;
/** Width/height of every canvas shape bottoms out at 2 units (box rule). */
export const SHAPE_MIN_SIZE = 2;
/** The eight resize handles, clockwise from top-left. */
export const RESIZE_HANDLES = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
/** Undo keeps the last 50 snapshots (SPEC-v5.md section 3). */
export const UNDO_LIMIT = 50;
/** A plain click with a create tool drops these (SPEC section 3). */
export const DEFAULT_BOX_SIZE = Object.freeze({ w: 45, h: 28 });
export const DEFAULT_CORRIDOR_SIZE = Object.freeze({ w: 5, h: 60 });
export const DEFAULT_PATCH_SIZE = Object.freeze({ w: 24, h: 24 });

/** A finite number rounded to at most two decimals; junk becomes 0. */
export function roundMapNumber(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.round(n * 100) / 100;
}

/** A map number rounded to two decimals and kept inside −10000…20000. */
export function clampMapNumber(value) {
  return Math.min(MAP_COORD_MAX, Math.max(MAP_COORD_MIN, roundMapNumber(value)));
}

/**
 * Move a shape by (`dx`, `dy`) drawing units: with snap on the resulting
 * position lands on the `grid` (drag-to-move, SPEC section 3); without it
 * the move is raw, still rounded clean. Clamped into the stored range.
 * @param {object} shape `{x, y}` (w/h never touched)
 * @param {number} dx @param {number} dy
 * @param {{snapOn?: boolean, grid?: number}} [options]
 * @returns {{x: number, y: number}}
 */
export function moveShape(shape, dx, dy, { snapOn = true, grid = SNAP_GRID } = {}) {
  const x = numberOr(shape && shape.x, 0) + numberOr(dx, 0);
  const y = numberOr(shape && shape.y, 0) + numberOr(dy, 0);
  return {
    x: clampMapNumber(snapOn ? snap(x, grid) : roundMapNumber(x)),
    y: clampMapNumber(snapOn ? snap(y, grid) : roundMapNumber(y)),
  };
}

/**
 * Arrow-key nudge (SPEC section 3): exactly `dx`/`dy` units (1, or 10 with
 * Shift), never grid-snapped — a 1-unit step against a 2-unit grid would
 * never move. Rounded and clamped like every stored number.
 * @param {object} shape `{x, y}`
 * @param {number} dx @param {number} dy
 * @returns {{x: number, y: number}}
 */
export function nudgeShape(shape, dx, dy) {
  return {
    x: clampMapNumber(roundMapNumber(numberOr(shape && shape.x, 0) + numberOr(dx, 0))),
    y: clampMapNumber(roundMapNumber(numberOr(shape && shape.y, 0) + numberOr(dy, 0))),
  };
}

/**
 * Resize by one of the 8 handles: the named edges follow the pointer (their
 * corners snap to the grid when snap is on), the opposite edges stay put, and
 * w/h never drop below `SHAPE_MIN_SIZE` (the moving edge stops, the anchor
 * stays — the stored box rule w,h ≥ 2). An unknown handle is a no-op.
 * @param {object} shape `{x, y, w, h}`
 * @param {string} handle one of RESIZE_HANDLES
 * @param {number} dx @param {number} dy in drawing units
 * @param {{snapOn?: boolean, grid?: number}} [options]
 * @returns {{x: number, y: number, w: number, h: number}} the new geometry
 */
export function resizeShape(shape, handle, dx, dy, { snapOn = true, grid = SNAP_GRID } = {}) {
  const base = {
    x: numberOr(shape && shape.x, 0),
    y: numberOr(shape && shape.y, 0),
    w: Math.max(SHAPE_MIN_SIZE, numberOr(shape && shape.w, SHAPE_MIN_SIZE)),
    h: Math.max(SHAPE_MIN_SIZE, numberOr(shape && shape.h, SHAPE_MIN_SIZE)),
  };
  const which = RESIZE_HANDLES.includes(handle) ? handle : null;
  if (!which) return base;
  const doSnap = (value) => (snapOn ? snap(value, grid) : roundMapNumber(value));
  const clamp = (value) => Math.min(MAP_COORD_MAX, Math.max(MAP_COORD_MIN, value));
  let left = clamp(doSnap(base.x));
  let top = clamp(doSnap(base.y));
  let right = clamp(doSnap(base.x + base.w));
  let bottom = clamp(doSnap(base.y + base.h));
  const ddx = numberOr(dx, 0);
  const ddy = numberOr(dy, 0);
  if (which.includes('w')) left = clamp(doSnap(base.x + ddx));
  if (which.includes('e')) right = clamp(doSnap(base.x + base.w + ddx));
  if (which.includes('n')) top = clamp(doSnap(base.y + ddy));
  if (which.includes('s')) bottom = clamp(doSnap(base.y + base.h + ddy));
  if (right - left < SHAPE_MIN_SIZE) {
    if (which.includes('e')) right = left + SHAPE_MIN_SIZE;
    else left = right - SHAPE_MIN_SIZE;
  }
  if (bottom - top < SHAPE_MIN_SIZE) {
    if (which.includes('s')) bottom = top + SHAPE_MIN_SIZE;
    else top = bottom - SHAPE_MIN_SIZE;
  }
  return {
    x: roundMapNumber(left),
    y: roundMapNumber(top),
    w: roundMapNumber(right - left),
    h: roundMapNumber(bottom - top),
  };
}

/**
 * The rubber-band rectangle from two corners in any order (negative width
 * cannot exist in a drag): normalised, rounded, minimum zero.
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function rubberBandRect(x0, y0, x1, y1) {
  const left = Math.min(numberOr(x0, 0), numberOr(x1, 0));
  const right = Math.max(numberOr(x0, 0), numberOr(x1, 0));
  const top = Math.min(numberOr(y0, 0), numberOr(y1, 0));
  const bottom = Math.max(numberOr(y0, 0), numberOr(y1, 0));
  return {
    x: roundMapNumber(left),
    y: roundMapNumber(top),
    w: roundMapNumber(right - left),
    h: roundMapNumber(bottom - top),
  };
}

/**
 * Rubber-band hit test: does `rect` (the band) overlap the shape? Edges
 * touching count — a band dragged along a box edge still selects it.
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @param {{x: number, y: number, w: number, h: number}} shape
 * @returns {boolean}
 */
export function rectIntersectsShape(rect, shape) {
  const rx = numberOr(rect && rect.x, 0);
  const ry = numberOr(rect && rect.y, 0);
  const rw = numberOr(rect && rect.w, 0);
  const rh = numberOr(rect && rect.h, 0);
  const sx = numberOr(shape && shape.x, 0);
  const sy = numberOr(shape && shape.y, 0);
  const sw = numberOr(shape && shape.w, 0);
  const sh = numberOr(shape && shape.h, 0);
  return rx <= sx + sw && rx + rw >= sx && ry <= sy + sh && ry + rh >= sy;
}

/**
 * Push one undo snapshot onto the stack, keeping at most the newest
 * `UNDO_LIMIT` (the oldest steps fall off, SPEC section 3). Pure: returns
 * the new stack, the input is left alone.
 * @param {Array} stack
 * @param {*} snapshot a structuredClone of the working copy
 * @returns {Array}
 */
export function pushUndoSnapshot(stack, snapshot) {
  const next = [...(Array.isArray(stack) ? stack : []), snapshot];
  return next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next;
}

/**
 * Pop the newest snapshot (the step to undo to). An empty stack pops null
 * and stays empty.
 * @param {Array} stack
 * @returns {{stack: Array, snapshot: *}}
 */
export function popUndoSnapshot(stack) {
  const list = Array.isArray(stack) ? stack : [];
  if (list.length === 0) return { stack: [], snapshot: null };
  return { stack: list.slice(0, -1), snapshot: list[list.length - 1] };
}

/**
 * Which stations become off-map in the edited map (`boxId` must go null):
 * whose box was deleted, or whose `slot` sits at or beyond the box's new
 * slot count (SPEC section 3 — they are never deleted). Already-off-map
 * stations (no `boxId`) need no change and are not listed.
 * @param {Array<object>} stations this map's floorStations records
 * @param {object} map the edited floorMaps geometry
 * @returns {string[]} station ids whose boxId must be saved as null
 */
export function offMapStationIds(stations, map) {
  const boxes = Array.isArray(map && map.boxes) ? map.boxes : [];
  const byId = new Map();
  for (const box of boxes) {
    if (box && typeof box.id === 'string') byId.set(box.id, box);
  }
  const ids = [];
  for (const station of Array.isArray(stations) ? stations : []) {
    if (station === null || typeof station !== 'object') continue;
    if (!station.boxId) continue;
    const box = byId.get(station.boxId);
    if (!box) {
      ids.push(station.id);
      continue;
    }
    const slots = Number.isInteger(box.slots) ? box.slots : 1;
    if ((Number(station.slot) || 0) >= slots) ids.push(station.id);
  }
  return ids;
}

/**
 * A fresh id for a new or duplicated box: short (≤ 40, the stored rule),
 * deterministic, never colliding with an existing one.
 * @param {Array<string>} existingIds
 * @returns {string}
 */
export function newBoxId(existingIds = []) {
  const taken = new Set(
    (Array.isArray(existingIds) ? existingIds : []).filter((id) => typeof id === 'string' && id !== ''),
  );
  for (let n = 1; n <= 9999; n += 1) {
    const id = `box-${n}`;
    if (!taken.has(id)) return id;
  }
  return `box-${roundMapNumber(Date.now()).toString(36)}`;
}

/**
 * The rectangle a plain click drops for a create tool: default size at the
 * clicked point (box 45 × 28, corridor 5 × 60, patch 24 × 24 — SPEC section 3).
 * @param {'box'|'corridor'|'fill'} kind
 * @param {number} x @param {number} y
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function defaultShapeRect(kind, x, y) {
  const size =
    kind === 'box'
      ? DEFAULT_BOX_SIZE
      : kind === 'corridor'
        ? DEFAULT_CORRIDOR_SIZE
        : DEFAULT_PATCH_SIZE;
  return { x: roundMapNumber(x), y: roundMapNumber(y), w: size.w, h: size.h };
}

/**
 * A new canvas shape of `kind` from a drawn rectangle: clean numbers, w/h ≥ 2,
 * a box gets a free id and one slot, a fill its colour. Unknown kinds return
 * null (the tool button list is the only source).
 * @param {'box'|'corridor'|'fill'} kind
 * @param {{x?: number, y?: number, w?: number, h?: number}} rect
 * @param {Array<string>} [existingIds] box ids already in the copy
 * @returns {object|null}
 */
export function createShapeFromRect(kind, rect, existingIds = []) {
  const clean = {
    x: clampMapNumber(rect && rect.x),
    y: clampMapNumber(rect && rect.y),
    w: Math.max(SHAPE_MIN_SIZE, clampMapNumber(rect && rect.w)),
    h: Math.max(SHAPE_MIN_SIZE, clampMapNumber(rect && rect.h)),
  };
  if (kind === 'box') {
    return { id: newBoxId(existingIds), ...clean, slots: BOX_SLOTS_MIN, fill: null, label: '' };
  }
  if (kind === 'corridor') return { ...clean };
  if (kind === 'fill') return { ...clean, color: '#e5e7ec' };
  return null;
}

const SAVE_HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * The validation pass before Save map (SPEC-v5.md 3 + 1.1): every number
 * rounded to two decimals and inside −10000…20000, box w/h ≥ 2, slots an
 * integer 1–12, colours `#rrggbb` or null, ids/labels trimmed to their
 * limits — and exactly the six stored fields, so nothing the canvas uses
 * internally can ride along. Pure; the record shape it returns is the one
 * sync.sendRecord will put.
 * @param {object} map the working copy
 * @returns {{name: string, width: number, height: number, boxes: Array, corridors: Array, fills: Array}}
 */
export function sanitizeMapForSave(map) {
  const source = map === null || typeof map !== 'object' ? {} : map;
  const num = (value, fallback = 0) =>
    clampMapNumber(typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  const size = (value) => Math.max(SHAPE_MIN_SIZE, num(value, SHAPE_MIN_SIZE));
  const dimension = (value, fallback) => Math.min(10000, Math.max(10, num(value, fallback)));
  const list = (value) => (Array.isArray(value) ? value : []).filter((entry) => entry !== null && typeof entry === 'object');
  const hex = (value) => (typeof value === 'string' && SAVE_HEX_RE.test(value) ? value.toLowerCase() : null);
  return {
    name: String(source.name ?? '').trim().slice(0, 80) || 'Floor',
    width: dimension(source.width, 10),
    height: dimension(source.height, 10),
    boxes: list(source.boxes).map((box, index) => ({
      x: num(box.x),
      y: num(box.y),
      w: size(box.w),
      h: size(box.h),
      id:
        typeof box.id === 'string' && box.id.trim() !== ''
          ? box.id.slice(0, 40)
          : `box-${index + 1}`,
      slots: Math.min(
        BOX_SLOTS_MAX,
        Math.max(BOX_SLOTS_MIN, Math.round(Number(box.slots) || BOX_SLOTS_MIN)),
      ),
      fill: hex(box.fill),
      label: String(box.label ?? '').slice(0, 60),
    })),
    corridors: list(source.corridors).map((corridor) => ({
      x: num(corridor.x),
      y: num(corridor.y),
      w: size(corridor.w),
      h: size(corridor.h),
    })),
    fills: list(source.fills).map((fill) => ({
      x: num(fill.x),
      y: num(fill.y),
      w: size(fill.w),
      h: size(fill.h),
      color: hex(fill.color) ?? '#e5e7ec',
    })),
  };
}

/** A finite number, or the fallback. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}