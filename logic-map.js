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

const FIT_CHAR_WIDTH = 0.6;
const FIT_LINE_HEIGHT = 1.2;
const FIT_MIN_SIZE = 4;
const FIT_MAX_SIZE = 14;
const FIT_STEP = 0.5;

/**
 * Greedy word wrap at `maxChars` per line: a word that fits whole never
 * splits; a word longer than a line is hard-sliced. No characters are lost.
 * @param {string} text
 * @param {number} maxChars at least 1
 * @returns {Array<string>} the lines; empty for empty input
 */
function wrapWords(text, maxChars) {
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
  while (fontSize >= FIT_MIN_SIZE) {
    const maxChars = Math.max(1, Math.floor(w / (fontSize * FIT_CHAR_WIDTH)));
    const lines = wrapWords(clean, maxChars);
    if (lines.length * fontSize * FIT_LINE_HEIGHT <= h) {
      return { lines, fontSize: Math.round(fontSize * 10) / 10 };
    }
    fontSize -= FIT_STEP;
  }
  // Nothing fits at 4: hard-slice, and let the size shrink below 4 so the
  // kept lines still fit a very flat slot (never overflow the box).
  const maxChars = Math.max(1, Math.floor(w / (FIT_MIN_SIZE * FIT_CHAR_WIDTH)));
  const all = wrapWords(clean, maxChars);
  const size = Math.min(FIT_MIN_SIZE, h / FIT_LINE_HEIGHT);
  const maxLines = Math.max(1, Math.floor(h / (size * FIT_LINE_HEIGHT) + 1e-9));
  return { lines: all.slice(0, maxLines), fontSize: size };
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

/** A finite number, or the fallback. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}