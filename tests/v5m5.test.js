'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SLOT_FONT_MAX,
  SLOT_FONT_MIN,
  SLOT_FONT_STEP,
  SLOT_TEXT_MAX,
  boxFontSize,
  createShapeFromRect,
  fitSlotText,
  sanitizeMapForSave,
} from '../logic-map.js';
import { validateRecordData } from '../server/records.js';
import { openApiSpec } from '../server/openapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

/**
 * V5-M5 (client request 2026-10-22, "add font size edit in the pull-out
 * menu"): every slot of one box can share ONE text size instead of Auto.
 *
 * Data: a box carries an optional `fontSize` — null (or absent) = Auto, or a
 * number 1.5-20 in drawing units with at most one decimal; the server
 * rejects everything else, sanitizeMapForSave keeps it on Save map, and
 * duplicating or splitting a box keeps it (Duplicate clones the shape
 * wholesale; mergeSplitStations only touches slots).
 *
 * Rendering: fitSlotText takes an optional fixed size — every row of that
 * slot uses exactly that size (above SLOT_TEXT_MAX allowed, Text scale
 * ignored), wrapping whole words, dropping overflow rows with an ellipsis on
 * the last kept row while the code row always survives. Auto boxes behave
 * exactly as before. The print copy clones the same svg, so it shows the same
 * sizes.
 *
 * UI: the station panel has a Text size row (A- / value / A+ and Auto, step
 * 0.5 from the rounded Auto size when the box was Auto) that saves the
 * floorMaps record immediately with its version — writers only; read-only
 * roles see the value — and the map editor's selection panel has the same
 * control for every selected box, as part of the undo stack and Save map.
 *
 * No real map or roster data anywhere: the fixtures here are tiny and
 * synthetic. No staff names.
 */

// ---------------------------------------------------------------------------
// fitSlotText with a fixed size (logic-map.js): the box's explicit choice.
// ---------------------------------------------------------------------------

test('fitSlotText: a fixed size is drawn exactly, above SLOT_TEXT_MAX, scale ignored', () => {
  // 9.5 > SLOT_TEXT_MAX: an explicit choice may tower over its neighbours.
  const fit = fitSlotText(['SP14', '123 Doe, Jo Jo'], 45, 14, { fixedSize: 9.5 });
  assert.equal(fit.fontSize, 9.5, 'the exact fixed size, never shrunk');
  assert.ok(fit.fontSize > SLOT_TEXT_MAX, 'fixed sizes may exceed the Auto cap');
  assert.deepEqual(
    fit.lines,
    [['SP14…'], []],
    'one row fits; the person rows drop with an ellipsis on the kept one',
  );

  // The toolbar Text scale multiplies only Auto boxes (V5-M4); a fixed box
  // ignores it.
  const scaled = fitSlotText(['SP14'], 45, 14, { fixedSize: 5, scale: 2 });
  assert.equal(scaled.fontSize, 5);
  assert.deepEqual(scaled.lines, [['SP14']]);

  // Not even one row fits vertically: the fixed size stays, the code survives.
  const tiny = fitSlotText(['SP14'], 45, 14, { fixedSize: 12 });
  assert.equal(tiny.fontSize, 12);
  assert.deepEqual(tiny.lines, [['SP14']], 'the code row is always kept');
});

test('fitSlotText: a fixed size wraps on whole words', () => {
  const fit = fitSlotText(['Ribbon cutting'], 22.1, 28.3, { fixedSize: 3 });
  assert.equal(fit.fontSize, 3);
  assert.deepEqual(fit.lines, [['Ribbon', 'cutting']], 'never "Ribb" / "on c"');

  // A single word wider than the row is hard-sliced (wrapWords), same as the
  // Auto fallback: every character is kept, and no ellipsis is added while
  // all the sliced rows still fit the slot.
  const sliced = fitSlotText(['EXTRALONGWORD'], 22.1, 28.3, { fixedSize: 3 });
  assert.equal(sliced.fontSize, 3);
  assert.equal(sliced.lines[0].length, 2, 'the word continues on the next row');
  assert.equal(sliced.lines.flat(Infinity).join(''), 'EXTRALONGWORD', 'no characters lost, no ellipsis');
});

test('fitSlotText: fixed size drops bottom rows with an ellipsis, keeps the code', () => {
  // A 20 x 4 slot with 6-unit rows: only the code row fits vertically.
  const fit = fitSlotText(['A1', '12345 Wong, Chi Keung'], 20, 4, { fixedSize: 6 });
  assert.equal(fit.fontSize, 6);
  assert.deepEqual(fit.lines, [['A1…'], []], 'the person line falls off, "A1…" stays');

  // A slot with no room for even one row still shows the code row.
  const none = fitSlotText(['SP14', '123 Doe, Jo Jo'], 10, 2.5, { fixedSize: 8 });
  assert.equal(none.fontSize, 8);
  assert.equal(none.lines.length, 2, 'one entry per input line, as always');
  assert.equal(none.lines[0].length, 1, 'the code keeps exactly its first row');
  assert.ok(none.lines[0][0].startsWith('S'));
  assert.ok(none.lines[0][0].endsWith('…'));
  assert.deepEqual(none.lines[1], []);
});

test('fitSlotText: junk or missing fixedSize stays pure Auto (Auto boxes change nothing)', () => {
  const auto = fitSlotText(['SP14', '123 Doe, Jo Jo'], 45, 14);
  assert.ok(auto.fontSize > 0 && auto.fontSize <= SLOT_TEXT_MAX);
  for (const junk of ['x', 0, -3, null, undefined, Number.NaN, Infinity]) {
    assert.deepEqual(
      fitSlotText(['SP14', '123 Doe, Jo Jo'], 45, 14, { fixedSize: junk }),
      auto,
      `fixedSize ${String(junk)} behaves exactly like no fixedSize`,
    );
  }
});

// ---------------------------------------------------------------------------
// The stored helpers (logic-map.js): clamp, new boxes, Save map.
// ---------------------------------------------------------------------------

test('boxFontSize: the clamp helper — 1.5-20 kept to one decimal, everything else Auto', () => {
  assert.equal(boxFontSize(null), null);
  assert.equal(boxFontSize(undefined), null);
  assert.equal(boxFontSize(6.5), 6.5);
  assert.equal(boxFontSize(1.5), 1.5, 'the smallest storable size');
  assert.equal(boxFontSize(20), 20, 'the largest storable size');
  assert.equal(boxFontSize(6.55), 6.6, 'rounded to one decimal, like Save map will store');
  assert.equal(boxFontSize(0), null);
  assert.equal(boxFontSize(20.5), null, 'out of range falls back to Auto');
  assert.equal(boxFontSize('x'), null);
  assert.equal(boxFontSize(Number.NaN), null);
  assert.deepEqual([SLOT_FONT_MIN, SLOT_FONT_MAX, SLOT_FONT_STEP], [1.5, 20, 0.5]);
});

test('createShapeFromRect: a new box starts Auto', () => {
  const box = createShapeFromRect('box', { x: 4, y: 4, w: 30, h: 12 }, []);
  assert.equal(box.fontSize, null, 'no fixed size until a writer picks one');
  // Duplicating a box clones every field (the editor's Duplicate): the size
  // rides along with x/y/w/h/slots/fill/label.
  const clone = structuredClone(box);
  assert.equal(clone.fontSize, null);
});

test('sanitizeMapForSave: keeps a box fontSize; absent, junk and out-of-range go Auto', () => {
  const out = sanitizeMapForSave({
    name: 'Main floor',
    width: 612,
    height: 792,
    boxes: [
      { id: 'b1', x: 0, y: 0, w: 30, h: 12, slots: 2, fontSize: 6.5 },
      { id: 'b2', x: 1, y: 1, w: 30, h: 12 }, // absent = Auto
      { id: 'b3', x: 2, y: 2, w: 30, h: 12, fontSize: 25 }, // above the range
      { id: 'b4', x: 3, y: 3, w: 30, h: 12, fontSize: 6.55 }, // two decimals
      { id: 'b5', x: 4, y: 4, w: 30, h: 12, fontSize: 'big' }, // junk
    ],
    corridors: [],
    fills: [],
  });
  assert.deepEqual(
    out.boxes.map((box) => box.fontSize),
    [6.5, null, null, 6.6, null],
    'the stored choice survives Save map untouched when valid',
  );
});

// ---------------------------------------------------------------------------
// Server validation (server/records.js): the box fontSize rule.
// ---------------------------------------------------------------------------

const GOOD_BOX = { id: 'b1', x: 0, y: 0, w: 30, h: 12 };

function boxWith(changes) {
  return validateRecordData('floorMaps', {
    name: 'Loft',
    width: 100,
    height: 80,
    boxes: [{ ...GOOD_BOX, ...changes }],
  }).boxes[0];
}

test('floorMaps boxes: fontSize null/absent is Auto; 1.5-20 with one decimal validates', () => {
  assert.equal(boxWith({}).fontSize, null, 'absent = Auto');
  assert.equal(boxWith({ fontSize: null }).fontSize, null);
  assert.equal(boxWith({ fontSize: 6.5 }).fontSize, 6.5);
  assert.equal(boxWith({ fontSize: 1.5 }).fontSize, 1.5);
  assert.equal(boxWith({ fontSize: 20 }).fontSize, 20);
});

test('floorMaps boxes: bad fontSize values are rejected with one clear message', () => {
  const message = /floorMaps\.boxes\[0\]\.fontSize must be a number 1\.5-20 with at most one decimal, or null/;
  for (const bad of [0, 25, 1.49, 6.55, 'x', '6.5', true, {}, -1]) {
    assert.throws(() => boxWith({ fontSize: bad }), message, `rejects ${JSON.stringify(bad)}`);
  }
});

test('floorMaps boxes: fontSize is a known field, not an unknown-key rejection', () => {
  // It must not trip the unknown-field check, and junk keys still do.
  assert.doesNotThrow(() => boxWith({ fontSize: 6.5 }));
  assert.throws(
    () => boxWith({ font: 6.5 }),
    /boxes\[0\] has an unknown field "font"/,
  );
});

// ---------------------------------------------------------------------------
// OpenAPI: the schema documents the same choice.
// ---------------------------------------------------------------------------

test('openapi: FloorMapBox.fontSize is a nullable 1.5-20 number', () => {
  const schema = openApiSpec().components.schemas.FloorMapBox.properties.fontSize;
  assert.deepEqual(schema.type, ['number', 'null']);
  assert.equal(schema.minimum, 1.5);
  assert.equal(schema.maximum, 20);
  assert.match(schema.description, /null for Auto/);
});

// ---------------------------------------------------------------------------
// Keeping the size when a box is split (server/admin.js): imported stations
// that share a printed box merge into one slot; the box keeps its size.
// ---------------------------------------------------------------------------

test('import: mergeSplitStations keeps the box text size', async () => {
  const { mergeSplitStations } = await import('../server/admin.js');
  const box = { id: 'bx', x: 0, y: 0, w: 90, h: 56, slots: 2, fill: null, label: '', fontSize: 6.5 };
  const { stations, merged } = mergeSplitStations({ boxes: [box] }, [
    { box: 'bx', slot: 0, code: 'SN 104', en: '', cn: '', emp: '' },
    { box: 'bx', slot: 1, code: '691A Isbilir', en: 'Person', cn: '', emp: '' },
  ]);
  assert.equal(merged, 1, 'the pair merged into one station');
  assert.equal(stations.length, 1);
  assert.equal(box.slots, 1);
  assert.equal(box.fontSize, 6.5, 'splitting a box never loses its text size');
});

// ---------------------------------------------------------------------------
// Source checks (map.js): the station pull-out panel and the editor panel.
// ---------------------------------------------------------------------------

test('map.js: the station panel saves floorMaps with the map version, writers only', () => {
  const src = read('map.js');
  // The Text size row's apply(): a floorMap write, the whole record on the
  // current version (last save wins), nothing else.
  assert.match(src, /await sync\.saveRecord\('floorMaps', data, map\.version\)/);
  // The buttons exist only with floorMap write; read-only roles see the value.
  assert.match(src, /const canWrite = ctx\.can\('floorMap', 'write'\);/);
  assert.match(src, /if \(panelBox !== null && canWrite\) \{/);
  assert.match(src, /\} else if \(panelBox !== null\) \{/);
  // The map re-renders behind the panel while it stays open.
  assert.match(src, /\/\/ The map re-renders behind the panel \(the panel itself stays open\)\./);
  // A- / A+ step SLOT_FONT_STEP inside the stored bounds.
  assert.match(src, /Math\.min\(SLOT_FONT_MAX, Math\.max\(SLOT_FONT_MIN, base \+ delta\)\)/);
  assert.match(src, /const halfStep = \(value\) => Math\.round\(value \/ SLOT_FONT_STEP\) \* SLOT_FONT_STEP;/);
  // The Auto base when the box was Auto: what the slot really renders.
  assert.match(src, /stepBaseOf: \(box\) => autoSlotFontSize\(box, current\)/);
  // All slots of the box share the setting — said when there is more than one.
  assert.match(src, /`All \$\{slots\} slots in this box share this text size\.`/);
});

test('map.js: the render paths pass the box size; the print copy shows the same sizes', () => {
  const src = read('map.js');
  // The view renders each station with its box (stationNode) and the fixed
  // size clamped by boxFontSize; the editor's syncEntry does the same.
  assert.match(src, /const fixed = box === null \? null : boxFontSize\(box\.fontSize\);/);
  assert.match(src, /const fixed = boxFontSize\(obj\.fontSize\);/);
  assert.match(src, /stationNode\(ctx, station, rect, liveFor\(station\), machines, box\)/);
  // The print copy is a clone of the rendered svg (V5-M4b): the fixed sizes
  // are already on the text nodes, so the paper matches the screen.
  assert.match(src, /const copy = svg\.cloneNode\(true\)/);
});

test('map.js: the editor selection panel has the same control, on the undo stack', () => {
  const src = read('map.js');
  // Single box: the Text size row next to Slots/Fill/Label.
  assert.match(src, /const editFontSizeControl = \(boxes\) =>/);
  // The change lands on the working copy through editMutation (undo + dirty
  // + Save map), never straight into the synced record.
  assert.match(src, /if \(box && typeof box === 'object'\) box\.fontSize = value;/);
  // Several selected boxes: one step applies to every selected box.
  assert.match(src, /const boxes = sel\.filter\(\(ref\) => ref\.kind === 'box'\)\.map\(\(ref\) => ref\.obj\);/);
  assert.match(src, /'Applies to every selected box\.'/);
  assert.match(src, /`All \$\{boxSlotsCount\} slots in this box share this text size\.`/);
  // Duplicating a box clones it wholesale: the size rides along.
  assert.match(src, /const clone = structuredClone\(obj\);/);
});

test('help.js: the Floor map section explains the Text size row', () => {
  const help = read('help.js');
  assert.match(help, /Text size sets the letter size of every slot in the station’s box/);
  assert.match(help, /fix one size for the whole box/);
});