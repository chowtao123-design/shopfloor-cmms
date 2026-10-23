'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clampMapNumber,
  createShapeFromRect,
  DEFAULT_BOX_SIZE,
  DEFAULT_CORRIDOR_SIZE,
  DEFAULT_PATCH_SIZE,
  defaultShapeRect,
  moveShape,
  newBoxId,
  nudgeShape,
  offMapStationIds,
  popUndoSnapshot,
  pushUndoSnapshot,
  rectIntersectsShape,
  RESIZE_HANDLES,
  resizeShape,
  roundMapNumber,
  rubberBandRect,
  sanitizeMapForSave,
  SHAPE_MIN_SIZE,
  SNAP_GRID,
  UNDO_LIMIT,
} from '../logic-map.js';

/**
 * V5-M3 (SPEC-v5.md section 3): the floor map edit canvas. The pure geometry
 * the canvas drives — resize by handle (minimum size + grid snapping), move
 * with snapping, exact arrow nudges, the rubber-band hit test, the 50-step
 * undo stack, the off-map calculation for deleted boxes and shrunken slots,
 * and the pre-save rounding/validation — plus source checks that the editor
 * itself is gated (desktop ≥ 1024 px + floorMap write), edits a
 * structuredClone working copy that Cancel discards, saves through the
 * normal record PUT and sends affected stations off-map instead of deleting
 * them. No real map or roster data here: the fixtures are tiny and synthetic
 * (SPEC-v5.md sections 0 and 1.3 — the roster never reaches the repo).
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(REPO, name), 'utf8');

// ---------------------------------------------------------------------------
// Resize: each handle moves only its own edges; minimum size 2; snapping.
// ---------------------------------------------------------------------------

test('resizeShape: every handle moves only its own edges', () => {
  const shape = { x: 100, y: 100, w: 40, h: 20 };
  // Snap off, so this is pure handle arithmetic (snapping has its own test).
  assert.deepEqual(resizeShape(shape, 'e', 10, 99, { snapOn: false }), { x: 100, y: 100, w: 50, h: 20 });
  assert.deepEqual(resizeShape(shape, 'w', 10, 0, { snapOn: false }), { x: 110, y: 100, w: 30, h: 20 });
  assert.deepEqual(resizeShape(shape, 's', 0, 5, { snapOn: false }), { x: 100, y: 100, w: 40, h: 25 });
  assert.deepEqual(resizeShape(shape, 'n', 0, -3, { snapOn: false }), { x: 100, y: 97, w: 40, h: 23 });
  assert.deepEqual(resizeShape(shape, 'se', 4, 4, { snapOn: false }), { x: 100, y: 100, w: 44, h: 24 });
  assert.deepEqual(resizeShape(shape, 'nw', 4, 6, { snapOn: false }), { x: 104, y: 106, w: 36, h: 14 });
  assert.deepEqual(resizeShape(shape, 'ne', 4, -6, { snapOn: false }), { x: 100, y: 94, w: 44, h: 26 });
  assert.deepEqual(resizeShape(shape, 'sw', -4, 6, { snapOn: false }), { x: 96, y: 100, w: 44, h: 26 });
  // The input shape is never mutated (drag maths off a snapshot).
  assert.deepEqual(shape, { x: 100, y: 100, w: 40, h: 20 });
});

test('resizeShape: w/h never drop below the 2-unit minimum; the anchor edge stays', () => {
  // 'e' drags left through the box: the right edge stops 2 units from x.
  assert.deepEqual(
    resizeShape({ x: 10, y: 10, w: 20, h: 20 }, 'e', -1000, 0, { snapOn: false }),
    { x: 10, y: 10, w: SHAPE_MIN_SIZE, h: 20 },
  );
  // 'w' drags right past the right edge: the left edge stops under it.
  assert.deepEqual(
    resizeShape({ x: 10, y: 10, w: 20, h: 20 }, 'w', 1000, 0, { snapOn: false }),
    { x: 28, y: 10, w: SHAPE_MIN_SIZE, h: 20 },
  );
  // 'n' drags down past the bottom: the top edge stops above it.
  assert.deepEqual(
    resizeShape({ x: 10, y: 10, w: 20, h: 20 }, 'n', 0, 1000, { snapOn: false }),
    { x: 10, y: 28, w: 20, h: SHAPE_MIN_SIZE },
  );
  // A degenerate starting shape is lifted to the minimum, never below.
  assert.deepEqual(
    resizeShape({ x: 0, y: 0, w: 0, h: 0 }, 'e', 0, 0, { snapOn: false }),
    { x: 0, y: 0, w: SHAPE_MIN_SIZE, h: SHAPE_MIN_SIZE },
  );
});

test('resizeShape: moving edges snap to the 2-unit grid; numbers stay clean', () => {
  // e: the right edge goes 30 -> 33, which snaps to 34.
  assert.deepEqual(resizeShape({ x: 10, y: 10, w: 20, h: 20 }, 'e', 3, 0), { x: 10, y: 10, w: 24, h: 20 });
  // nw: (11.2, 12.7) snaps to (12, 12); the opposite edges stay.
  assert.deepEqual(resizeShape({ x: 10, y: 10, w: 20, h: 20 }, 'nw', 1.2, 2.7), { x: 12, y: 12, w: 18, h: 18 });
  // Snap off: the raw move survives, still rounded to two decimals.
  assert.deepEqual(
    resizeShape({ x: 10, y: 10, w: 20, h: 20 }, 'e', 0.333, 0, { snapOn: false }),
    { x: 10, y: 10, w: 20.33, h: 20 },
  );
  // An unknown handle is a no-op (the tool list is the only source).
  assert.deepEqual(resizeShape({ x: 3, y: 4, w: 9, h: 9 }, 'middle', 10, 10), { x: 3, y: 4, w: 9, h: 9 });
  assert.deepEqual(resizeShape({ x: 3, y: 4, w: 9, h: 9 }, null, 10, 10), { x: 3, y: 4, w: 9, h: 9 });
  // CLAMP-ed into the stored range at the far edges.
  assert.deepEqual(
    resizeShape({ x: -9999, y: 0, w: 5, h: 5 }, 'w', -100, 0, { snapOn: false }),
    { x: -10000, y: 0, w: 6, h: 5 },
  );
});

test('RESIZE_HANDLES: exactly the eight compass handles', () => {
  assert.deepEqual([...RESIZE_HANDLES], ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
  assert.equal(RESIZE_HANDLES.length, 8);
});

// ---------------------------------------------------------------------------
// Move and nudge.
// ---------------------------------------------------------------------------

test('moveShape: snapped on, raw off, always clamped and rounded', () => {
  // 11.3 and 10.2 both land on the 2-unit grid.
  assert.deepEqual(moveShape({ x: 10.3, y: 9.2 }, 1, 1), { x: 12, y: 10 });
  // Without snap the raw move survives, rounded clean.
  assert.deepEqual(moveShape({ x: 10.3, y: 9.2 }, 1, 1, { snapOn: false }), { x: 11.3, y: 10.2 });
  // Clamped into −10000…20000 (never past the stored range).
  assert.deepEqual(moveShape({ x: 19999.4, y: 0 }, 30, 0), { x: 20000, y: 0 });
  assert.deepEqual(moveShape({ x: -9998.4, y: 0 }, -30, 0), { x: -10000, y: 0 });
  // A custom grid still flows through logic-map's snap().
  assert.deepEqual(moveShape({ x: 0, y: 0 }, 3, 3, { grid: 5 }), { x: 5, y: 5 });
  assert.equal(SNAP_GRID, 2, 'the default grid is the 2-unit one from the spec');
  // Junk input degrades to zeros, never a throw.
  assert.deepEqual(moveShape(null, 5, 5), { x: 6, y: 6 });
  assert.deepEqual(moveShape({ x: 'a', y: 'b' }, 4, 4), { x: 4, y: 4 });
});

test('nudgeShape: arrow keys move exactly 1 (Shift = 10), never grid-snapped', () => {
  assert.deepEqual(nudgeShape({ x: 10, y: 10 }, 1, -10), { x: 11, y: 0 });
  assert.deepEqual(nudgeShape({ x: 10 }, 0, 10), { x: 10, y: 10 });
  // A 1-unit step against a 2-unit grid must still move (snapping would eat it).
  assert.deepEqual(nudgeShape({ x: 4, y: 4 }, 1, 0), { x: 5, y: 4 });
  // Decimal positions stay exact, just rounded to two decimals.
  assert.deepEqual(nudgeShape({ x: 10.5, y: 10.25 }, 1, 1), { x: 11.5, y: 11.25 });
  // Clamped at the stored range, junk input degrades to zeros.
  assert.deepEqual(nudgeShape({ x: 20000, y: -9999 }, 10, -10), { x: 20000, y: -10000 });
  assert.deepEqual(nudgeShape(null, 1, 1), { x: 1, y: 1 });
});

// ---------------------------------------------------------------------------
// Rubber band.
// ---------------------------------------------------------------------------

test('rubberBandRect: any drag direction normalises to x/y/w/h', () => {
  assert.deepEqual(rubberBandRect(10, 10, 2, 4), { x: 2, y: 4, w: 8, h: 6 });
  assert.deepEqual(rubberBandRect(2, 4, 10, 10), { x: 2, y: 4, w: 8, h: 6 });
  assert.deepEqual(rubberBandRect(0, 0, 10, 4), { x: 0, y: 0, w: 10, h: 4 });
  // Junk corners degrade to a zero-empty band, never a throw.
  assert.deepEqual(rubberBandRect('a', 'b', 0, 0), { x: 0, y: 0, w: 0, h: 0 });
});

test('rectIntersectsShape: the band grabs everything it touches', () => {
  const band = rubberBandRect(10, 10, 60, 50);
  assert.equal(rectIntersectsShape(band, { x: 12, y: 12, w: 5, h: 5 }), true, 'fully inside');
  assert.equal(rectIntersectsShape(band, { x: 40, y: 10, w: 30, h: 5 }), true, 'crossing the right edge');
  assert.equal(rectIntersectsShape(band, { x: 60, y: 20, w: 5, h: 5 }), true, 'touching an edge counts');
  assert.equal(rectIntersectsShape(band, { x: 60.01, y: 20, w: 5, h: 5 }), false, 'just past the edge');
  assert.equal(rectIntersectsShape(band, { x: 61, y: 51, w: 5, h: 5 }), false, 'outside');
  assert.equal(rectIntersectsShape(band, null), false, 'a junk shape never hits');
  assert.equal(
    rectIntersectsShape(null, { x: 1, y: 1, w: 5, h: 5 }),
    false,
    'a junk band sits at the origin and touches nothing but the origin',
  );
});

// ---------------------------------------------------------------------------
// Undo stack: 50 snapshots, LIFO.
// ---------------------------------------------------------------------------

test('pushUndoSnapshot / popUndoSnapshot: 50 steps, oldest falls off first', () => {
  let stack = [];
  for (let step = 1; step <= 60; step += 1) stack = pushUndoSnapshot(stack, { step });
  assert.equal(stack.length, UNDO_LIMIT, 'capped at the spec limit');
  assert.equal(UNDO_LIMIT, 50);
  assert.equal(stack[stack.length - 1].step, 60, 'the newest snapshot stays');
  assert.equal(stack[0].step, 11, 'the oldest ten fell off');
  // LIFO pops; the stack shrinks.
  const first = popUndoSnapshot(stack);
  assert.equal(first.snapshot.step, 60);
  assert.equal(first.stack.length, UNDO_LIMIT - 1);
  const second = popUndoSnapshot(first.stack);
  assert.equal(second.snapshot.step, 59);
  // An empty stack pops null and stays empty.
  let empty = popUndoSnapshot([]);
  assert.deepEqual(empty, { stack: [], snapshot: null });
  empty = popUndoSnapshot(empty.stack);
  assert.deepEqual(empty, { stack: [], snapshot: null });
  // Not actually a stack: still behaves, input never mutated.
  assert.deepEqual(popUndoSnapshot(null), { stack: [], snapshot: null });
  assert.equal(pushUndoSnapshot(null, 1).length, 1);
  const original = [1, 2];
  pushUndoSnapshot(original, 3);
  assert.deepEqual(original, [1, 2], 'the pure helper leaves the input alone');
});

// ---------------------------------------------------------------------------
// Off-map: deleted boxes and reduced slots (never deletions).
// ---------------------------------------------------------------------------

test('offMapStationIds: deleted boxes and slots beyond the new count', () => {
  const stations = [
    { id: 's1', boxId: 'b1', slot: 0 }, // box kept its 2 slots: slot 0 fits
    { id: 's2', boxId: 'b1', slot: 2 }, // slot 2 >= b1's new 2 slots
    { id: 's3', boxId: 'gone', slot: 0 }, // its box was deleted
    { id: 's4', boxId: null, slot: 0 }, // already off-map: nothing to change
    { id: 's5', boxId: 'b2', slot: 3 }, // b2 kept 4 slots: fits
  ];
  const edited = { boxes: [{ id: 'b1', slots: 2 }, { id: 'b2', slots: 4 }] };
  assert.deepEqual(offMapStationIds(stations, edited).sort(), ['s2', 's3']);
  // Undo the deletion (the box is back): nobody moves anywhere.
  const restored = {
    boxes: [{ id: 'b1', slots: 3 }, { id: 'b2', slots: 4 }, { id: 'gone', slots: 1 }],
  };
  assert.deepEqual(offMapStationIds(stations, restored), []);
  // Every slot beyond the count goes, not just the first.
  assert.deepEqual(
    offMapStationIds(
      [{ id: 'a', boxId: 'x', slot: 0 }, { id: 'b', boxId: 'x', slot: 1 }, { id: 'c', boxId: 'x', slot: 2 }],
      { boxes: [{ id: 'x', slots: 1 }] },
    ),
    ['b', 'c'],
  );
  // Junk-safe both ways.
  assert.deepEqual(offMapStationIds(null, null), []);
  assert.deepEqual(offMapStationIds([null, 'nope'], { boxes: [{ id: 'b1', slots: 2 }] }), []);
  assert.deepEqual(
    offMapStationIds(stations, { boxes: [{ id: 'b1' }] }),
    ['s2', 's3', 's5'],
    'no slots field means one slot: s1 (slot 0) still fits',
  );
});

// ---------------------------------------------------------------------------
// Pre-save rounding/validation and the create-tool defaults.
// ---------------------------------------------------------------------------

test('roundMapNumber / clampMapNumber: two decimals, −10000…20000', () => {
  assert.equal(roundMapNumber(3.14159), 3.14);
  assert.equal(roundMapNumber(0.125), 0.13, 'exact halves round up like the server check');
  assert.equal(roundMapNumber(-0.125), -0.12);
  assert.equal(roundMapNumber(12.346), 12.35);
  assert.equal(roundMapNumber('junk'), 0);
  assert.equal(clampMapNumber(20000.004), 20000);
  assert.equal(clampMapNumber(-20000), -10000);
  assert.equal(clampMapNumber(12.346), 12.35);
  assert.equal(clampMapNumber(Number.NaN), 0);
});

test('sanitizeMapForSave: rounded, clamped, exactly the six stored fields', () => {
  const out = sanitizeMapForSave({
    name: '  Main floor  ',
    width: 612,
    height: 792,
    boxes: [
      {
        id: 'bx1',
        x: 10.005,
        y: -2.567,
        w: 1,
        h: 30000.333,
        slots: 2.6,
        fill: '#ABCDEF',
        label: 'L'.repeat(70),
        junk: 'must-not-ride-along',
      },
      { id: '   ', x: 0, y: 0, w: 20, h: 20 }, // a blank id gets a deterministic fallback
    ],
    corridors: [{ x: 1, y: 1, w: 5, h: 5, extra: 1 }],
    fills: [
      { x: 0, y: 0, w: 8, h: 8, color: 'red' }, // not #rrggbb -> the default grey
      { x: 1, y: 1, w: 8, h: 8, color: '#CCFFCC' },
    ],
    notAField: true,
  });
  assert.deepEqual(
    Object.keys(out).sort(),
    ['boxes', 'corridors', 'fills', 'height', 'name', 'width'],
    'the stored record has exactly the SPEC 1.1 fields',
  );
  assert.equal(out.name, 'Main floor');
  assert.equal(out.width, 612);
  assert.equal(out.height, 792);
  assert.ok(!('notAField' in out), 'nothing outside the SPEC 1.1 fields can ride along');
  const box = out.boxes[0];
  assert.equal(box.x, 10.01, 'rounded to two decimals');
  assert.equal(box.y, -2.57);
  assert.equal(box.w, SHAPE_MIN_SIZE, 'lifted to the box minimum');
  assert.equal(box.h, 20000, 'clamped into the stored range');
  assert.equal(box.slots, 3, 'rounded to an integer');
  assert.equal(box.fill, '#abcdef', 'colours normalise to lower case');
  assert.equal(box.label, 'L'.repeat(60), 'labels trim to 60');
  assert.ok(!('junk' in box), 'unknown box fields are dropped');
  assert.equal(out.boxes[1].id, 'box-2', 'a deterministic fallback id');
  assert.deepEqual(out.corridors, [{ x: 1, y: 1, w: 5, h: 5 }], 'extra fields dropped');
  assert.deepEqual(out.fills[0], { x: 0, y: 0, w: 8, h: 8, color: '#e5e7ec' });
  assert.equal(out.fills[1].color, '#ccffcc');
  // Degenerate input still yields a valid, saveable record.
  assert.deepEqual(sanitizeMapForSave(null), {
    name: 'Floor',
    width: 10,
    height: 10,
    boxes: [],
    corridors: [],
    fills: [],
  });
});

test('create tools: default sizes for a plain click, fresh shapes from a drag', () => {
  assert.deepEqual(DEFAULT_BOX_SIZE, { w: 45, h: 28 });
  assert.deepEqual(DEFAULT_CORRIDOR_SIZE, { w: 5, h: 60 });
  assert.deepEqual(DEFAULT_PATCH_SIZE, { w: 24, h: 24 });
  assert.deepEqual(defaultShapeRect('box', 3.7, 2.2), { x: 3.7, y: 2.2, w: 45, h: 28 });
  assert.deepEqual(defaultShapeRect('corridor', 0, 0), { x: 0, y: 0, w: 5, h: 60 });
  assert.deepEqual(defaultShapeRect('fill', 0, 0), { x: 0, y: 0, w: 24, h: 24 });

  const box = createShapeFromRect('box', { x: 4.004, y: 4, w: 30, h: 12 }, ['bx1']);
  assert.equal(box.id, 'box-1', 'a fresh id, never a collision');
  assert.equal(box.slots, 1);
  assert.equal(box.fill, null);
  assert.equal(box.label, '');
  assert.equal(box.x, 4);
  const tiny = createShapeFromRect('box', { x: 0, y: 0, w: 0.5, h: 0.5 }, []);
  assert.equal(tiny.w, SHAPE_MIN_SIZE);
  assert.equal(tiny.h, SHAPE_MIN_SIZE);
  assert.deepEqual(createShapeFromRect('corridor', { x: 1, y: 2, w: 3, h: 4 }, []), { x: 1, y: 2, w: 3, h: 4 });
  const patch = createShapeFromRect('fill', { x: 1, y: 2, w: 3, h: 4 }, []);
  assert.equal(patch.color, '#e5e7ec');
  assert.equal(createShapeFromRect('nonsense', {}), null);
});

test('newBoxId: short, deterministic, collision-free', () => {
  assert.equal(newBoxId(['box-1', 'box-2']), 'box-3');
  assert.equal(newBoxId(['bx1']), 'box-1');
  assert.equal(newBoxId([]), 'box-1');
  assert.ok(newBoxId().length <= 40);
  assert.ok(newBoxId(null).length <= 40);
});

// ---------------------------------------------------------------------------
// Source checks: the canvas itself (map.js), the gate (app.js) and the shell.
// ---------------------------------------------------------------------------

test("map.js: the Edit map button requires floorMap write AND a desktop screen", () => {
  const src = read('map.js');
  // Built only when both hold (the toolbar button)...
  assert.ok(
    src.includes('canWrite && ctx.desktopMedia.matches'),
    'the button must be built behind canWrite && desktopMedia',
  );
  assert.ok(src.includes("'Edit map'"), 'the toolbar button label');
  // ...and the session start re-checks both (the belt to the braces).
  assert.match(src, /if \(!ctx\.can\('floorMap', 'write'\) \|\| !ctx\.desktopMedia\.matches\) return;/);
  // "Desktop" is the shared ≥ 1024 px media query, not a local shortcut.
  const appSrc = read('app.js');
  assert.match(appSrc, /const DESKTOP_QUERY = '\(min-width: 1024px\)';/);
});

test('map.js: the session edits a structuredClone copy; Cancel discards it', () => {
  const src = read('map.js');
  // Enter: a deep clone of the record's geometry — never the record itself.
  assert.match(src, /mapEdit\.original = map;/);
  assert.match(src, /mapEdit\.copy = structuredClone\(\{/);
  // Cancel: ask first when dirty, then throw the copy away unsaved.
  assert.match(src, /async function confirmLeaveEditSession\(ctx\)/);
  assert.match(src, /title: 'Leave edit mode\?'/);
  assert.match(src, /'Discard changes',/);
  const discard = src.slice(
    src.indexOf('function discardEditSession'),
    src.indexOf('function confirmLeaveEditSession'),
  );
  assert.match(discard, /mapEdit\.copy = null;/);
  assert.match(discard, /uninstallEditGuards\(\);/);
  assert.ok(!discard.includes('saveRecord'), 'Cancel must not save anything');
});

test('map.js: Save writes the whole floorMaps record on the original version', () => {
  const src = read('map.js');
  assert.match(
    src,
    /sync\.saveRecord\(\s*'floorMaps',\s*\{ \.\.\.data, id: mapEdit\.original\.id, updatedAt: ctx\.nowISO\(\) \},\s*mapEdit\.original\.version,\s*\)/,
  );
  assert.match(src, /const data = sanitizeMapForSave\(mapEdit\.copy\);/);
});

test('map.js: stations of removed boxes go off-map (boxId null), never deleted', () => {
  const src = read('map.js');
  assert.match(src, /const offIds = new Set\(offMapStationIds\(stations, data\)\)/);
  assert.match(src, /\{ \.\.\.station, boxId: null, updatedAt: ctx\.nowISO\(\) \}/);
  assert.match(src, /sync\.saveRecord\('floorStations', next, station\.version\)/);
  // Nothing in the editor deletes a station record.
  assert.ok(!src.includes('deleteRecord'), 'no record deletions in map.js');
  // The toast counts the off-map moves — no staff names, ever (privacy).
  assert.match(src, /Map saved\. \$\{movedOff\} station/);
  assert.ok(!src.includes('console.log'), 'map.js must never console.log (roster privacy)');
});

test('map.js: gestures and shortcuts are wired the section-3 way', () => {
  const src = read('map.js');
  // Drag = one undo step, pushed at first movement, not per pointermove.
  assert.match(src, /mapEdit\.undo = pushUndoSnapshot\(mapEdit\.undo, gesture\.pending\)/);
  assert.match(src, /const \{ stack, snapshot \} = popUndoSnapshot\(mapEdit\.undo\)/);
  // Move snaps off the anchor grab so a multi-selection keeps its layout.
  assert.match(src, /const moved = moveShape\(\{ x: anchor\.x, y: anchor\.y \}, dxu, dyu/);
  // Resize runs against the pre-gesture snapshot of the shape.
  assert.match(src, /resizeShape\(gesture\.starts, gesture\.handle, dxu, dyu/);
  // Rubber band over empty floor, Shift adds to the selection.
  assert.match(src, /rubberBandRect\(gesture\.startUnits\.x, gesture\.startUnits\.y, u\.x, u\.y\)/);
  assert.match(src, /rectIntersectsShape\(gesture\.rect, obj\)/);
  // Select clicks hit-test via logic-map.js.
  assert.match(src, /const hit = hitTest\(copy, u\.x, u\.y\)/);
  // Create snaps its corners; a plain click drops the default size.
  assert.match(src, /mapEdit\.snap \? snap\(u\.x\) : roundMapNumber\(u\.x\)/);
  assert.match(src, /defaultShapeRect\(g\.kind, at\.x, at\.y\)/);
  // Eight handles around a single selection.
  assert.match(src, /for \(const handle of RESIZE_HANDLES\)/);
  // Arrow nudge 1 unit, Shift = 10; Ctrl+Z; Delete; Escape.
  assert.match(src, /const step = event\.shiftKey \? 10 : 1;/);
  assert.match(src, /nudgeEditSelection\(-step, 0\)/);
  assert.match(src, /String\(event\.key\)\.toLowerCase\(\) === 'z'/);
  assert.match(src, /case 'Delete':|event\.key === 'Delete'/);
  assert.match(src, /confirmLeaveEditSession\(ctx\)/);
  // The top bar ships Save map, Cancel, Undo, Snap and all four tools.
  for (const label of ['Save map', 'Cancel', 'Snap', 'Select', '+ Box', '+ Corridor', '+ Patch']) {
    assert.ok(src.includes(`'${label}'`), `missing editor button/tool label: ${label}`);
  }
});

test('map.js: leaving edit mode or the page with unsaved changes asks first', () => {
  const src = read('map.js');
  assert.match(src, /title: 'Leave the floor map\?'/, 'the route-change guard asks too');
  assert.match(src, /window\.addEventListener\('hashchange', onEditRouteChange\)/);
  assert.match(src, /window\.addEventListener\('beforeunload', onEditBeforeUnload\)/);
  assert.match(src, /document\.addEventListener\('keydown', onEditKeyDown\)/);
  // And every guard listener comes back off when the session ends.
  assert.match(src, /window\.removeEventListener\('hashchange', onEditRouteChange\)/);
  assert.match(src, /window\.removeEventListener\('beforeunload', onEditBeforeUnload\)/);
  assert.match(src, /document\.removeEventListener\('keydown', onEditKeyDown\)/);
});

test('map.js: while editing, clicks do not open the station panel and colours dim', () => {
  const src = read('map.js');
  // Station texts render inside a dimmed, click-through group on the canvas.
  assert.match(src, /const dim = svgEl\('g', \{ class: 'fm-edit-dim' \}\)/);
  // The editor render itself opens no station panel (the section-2 view does).
  const editor = src.slice(src.indexOf('function renderMapEditor'));
  assert.ok(!editor.includes('showStationPanel'), 'station clicks must not open the panel in edit mode');
  assert.ok(!editor.includes('showNewStationPanel'), 'empty slots add stations in the view, not the canvas');
});

test('map.js: empty slots offer + Add station for writers (placement in the view)', () => {
  const src = read('map.js');
  assert.match(src, /showNewStationPanel\(ctx, map\.id, empty\.box, empty\.slot\)/);
  assert.match(src, /function newStationBody\(ctx, mapId, box, slot\)/);
  assert.match(src, /await sync\.saveRecord\('floorStations', record\)/);
  // A small "+" mark; the slot's aria-label says what it does.
  assert.ok(src.includes("fitText('+',"));
  assert.ok(src.includes("'aria-label': canAdd ? 'Add a station in this slot' : null"));
});

test('app.js + help.js + sw.js + styles.css: the editor is wired into the shell', () => {
  const appSrc = read('app.js');
  // V5-M4 added stopMapPrint to the same import line.
  assert.match(appSrc, /import \{ renderMapPage, stationForMachine(?:, stopMapPrint)? \} from '\.\/map\.js';/);
  assert.match(appSrc, /renderMapPage\(mapPageContext\(\), route\)/);
  // The map context hands over showConfirm for the leave guards.
  assert.match(appSrc, /\n    showConfirm,\n/);
  const help = read('help.js');
  assert.match(help, /'Editing the map'/);
  const sw = read('sw.js');
  assert.match(sw, /'\.\/map\.js',/);
  assert.match(sw, /const CACHE_VERSION = \d+;/, 'bumped, never an exact number here');
  const css = read('styles.css');
  for (const selector of [
    '.fm-edit-topbar',
    '.fm-edit-tools',
    '.fm-edit-wrap',
    '.fm-edit-panel',
    '.fm-selection-rect',
    '.fm-handle',
    '.fm-band-rect',
    '.fm-ghost-rect',
    '.fm-edit-dim',
    '.fm-slot-sep',
    '.fm-slot-add',
  ]) {
    assert.ok(css.includes(selector), `missing editor style: ${selector}`);
  }
  // Dimmed stations are click-through, so canvas clicks reach the box.
  assert.match(css, /\.fm-edit-dim \{[\s\S]*?pointer-events: none;/);
});
test('a plain move or resize marks the map changed (Save map enables, Cancel asks)', () => {
  const src = fs.readFileSync(new URL('../map.js', import.meta.url), 'utf8');
  const end = src.indexOf('// move / resize / band: the undo snapshot went on at drag start');
  assert.ok(end > 0);
  assert.match(src.slice(end, end + 400), /recomputeEditDirty\(\);\s*ctx\.render\(\);/);
});

test('map fit: the drawing, not the paper margins; empty maps still fit the page', async () => {
  const { fitViewBox, drawingBounds } = await import('../map.js');
  const map = { width: 612, height: 792, boxes: [{ id: 'b1', x: 50, y: 10, w: 45, h: 28, slots: 1 }], corridors: [{ x: 40, y: 600, w: 500, h: 5 }], fills: [] };
  assert.deepEqual(drawingBounds(map), { x: 36, y: 6, w: 508, h: 603 });
  assert.deepEqual(fitViewBox(map), drawingBounds(map));
  assert.deepEqual(fitViewBox({ width: 612, height: 792, boxes: [] }), { x: 0, y: 0, w: 612, h: 792 });
});

test('fitText: shrinks below the old 4-unit minimum instead of cutting words off', async () => {
  const { fitText } = await import('../logic-map.js');
  const name = 'Chen, Mei Ling (Michelle)';
  const fit = fitText(name, 20, 6);
  assert.equal(fit.lines.join(' ').replace(/\s+/g, ' '), name, 'every word is still there');
  assert.ok(fit.fontSize < 4 && fit.lines.length * fit.fontSize * 1.2 <= 6 + 1e-9);
});

test('import: machine on top + operator below in one box merge into one station', async () => {
  const { mergeSplitStations } = await import('../server/admin.js');
  const map = { boxes: [{ id: 'b1', slots: 2 }, { id: 'b2', slots: 2 }, { id: 'b3', slots: 2 }] };
  const rows = [
    { id: 's1', box: 'b1', slot: 0, code: 'SN 104', emp: '', en: '', cn: '', vac: true },
    { id: 's2', box: 'b1', slot: 1, code: '691A Doe', emp: '', en: 'Doe, Jane', cn: '珍', vac: false, rem: 'left-handed' },
    // Two real operators in one box (PAC 1 style) stay two stations.
    { id: 's3', box: 'b2', slot: 0, code: 'PAC 1', emp: '1', en: 'A', vac: false },
    { id: 's4', box: 'b2', slot: 1, code: 'PAC 1', emp: '2', en: 'B', vac: false },
    // A bottom code that is not an employee ID is left alone.
    { id: 's5', box: 'b3', slot: 0, code: 'Cutter', en: '', vac: true },
    { id: 's6', box: 'b3', slot: 1, code: 'Helper', en: 'C', vac: false },
  ];
  const { stations, merged } = mergeSplitStations(map, rows);
  assert.equal(merged, 1);
  assert.deepEqual(stations.map((r) => r.id), ['s1', 's3', 's4', 's5', 's6']);
  assert.deepEqual(
    { code: stations[0].code, emp: stations[0].emp, en: stations[0].en, cn: stations[0].cn, vac: stations[0].vac, rem: stations[0].rem },
    { code: 'SN 104', emp: '691A', en: 'Doe, Jane', cn: '珍', vac: false, rem: 'left-handed' },
  );
  assert.deepEqual(map.boxes.map((b) => b.slots), [1, 2, 2]);
});
