'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIT_SLOT_PAD, fitSlotText, personLine } from '../logic-map.js';

/**
 * V5-M4 (SPEC-v5.md, client feedback 2026-10-22): station text and the PDF.
 * One font size for every line in a slot (the code and the person line
 * "<employee ID> <staff name>", ID first like the client's printed plan),
 * whole words whenever any size >= 1.5 fits them, a Text control that
 * multiplies the Auto size for the whole slot (dropping rows that no longer
 * fit, "…" on the last kept one, the code always kept), and print/PDF that
 * puts the WHOLE layout on one Letter page (6 mm margin, no header, zoom and
 * pan ignored) — since V5-M4b from a print-only copy of the svg kept in the
 * page, with no print event listeners. Pure helpers here plus source checks
 * for the DOM side. No real map or roster data: the fixtures are tiny and
 * synthetic (SPEC-v5.md sections 0 and 1.3 — the roster never reaches the
 * repo, and no staff name reaches any log).
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(REPO, name), 'utf8');

// ---------------------------------------------------------------------------
// fitSlotText (logic-map.js): one size per slot, whole words.
// ---------------------------------------------------------------------------

test('fitSlotText: one font size for every line in the slot', () => {
  // Code and person line share the slot's height budget; the result carries
  // a single fontSize and lines[i] holds the wrapped rows of input line i.
  const fit = fitSlotText(['SP14', '123 Doe, Jo Jo'], 45, 14);
  assert.deepEqual(fit, { lines: [['SP14'], ['123 Doe, Jo Jo']], fontSize: 4.5 });
  // Everything fits: 2 rows x 1.2 x 4.5 = 10.8 <= 14 - 2 x 1.2 padding.
  assert.ok(fit.lines.flat().length * 1.2 * fit.fontSize <= 14 - FIT_SLOT_PAD * 2);
});

test('fitSlotText: whole words in a 22.1 x 28.3 box ("Ribbon cutting")', () => {
  // The client's example: "Ribbon" / "cutting", never "Ribb" / "on c".
  const fit = fitSlotText(['Ribbon cutting'], 22.1, 28.3);
  assert.deepEqual(fit, { lines: [['Ribbon', 'cutting']], fontSize: 4.5 });
  // No row is a cut-off piece of a word.
  for (const row of fit.lines.flat()) {
    assert.ok(['Ribbon', 'cutting'].includes(row), `whole word only, got "${row}"`);
  }
});

test('fitSlotText: a long name wraps on spaces', () => {
  const fit = fitSlotText(['A1', '12345 Wong, Chi Keung'], 30, 20);
  assert.deepEqual(fit, { lines: [['A1'], ['12345 Wong,', 'Chi Keung']], fontSize: 4 });
  // Each person row is a run of whole space-separated words.
  for (const row of fit.lines[1]) {
    assert.ok(row.split(' ').every((word) => word.length > 0));
    assert.equal(row.trim(), row);
  }
});

test('fitSlotText: no text or no room -> nothing rendered', () => {
  assert.deepEqual(fitSlotText([], 30, 20), { lines: [], fontSize: 0 });
  assert.deepEqual(fitSlotText(['', '   '], 30, 20), { lines: [], fontSize: 0 });
  assert.deepEqual(fitSlotText(['A1'], 2, 20), { lines: [], fontSize: 0 }, 'no width after padding');
  assert.deepEqual(fitSlotText(['A1'], 30, 2), { lines: [], fontSize: 0 }, 'no height after padding');
});

test('fitSlotText: a single word wider than the slot at 1.5 is hard-sliced, nothing lost', () => {
  const word = 'EXTRALONGWORDTHATNEVERFITS';
  const fit = fitSlotText([word], 22.1, 28.3);
  // Nothing >= 1.5 fits this word whole (the only case slicing is allowed),
  // so it is sliced at the floor size — and every character survives.
  assert.equal(fit.fontSize, 1.5);
  assert.equal(fit.lines.flat().join(''), word);
});

// ---------------------------------------------------------------------------
// fitSlotText with a Text scale step: the Auto size multiplied for the whole
// slot; bottom rows dropped with "…", the code row always kept.
// ---------------------------------------------------------------------------

test('fitSlotText: scale > 1 drops bottom rows but keeps the code', () => {
  const lines = ['A1', '12345 Wong, Chi Keung'];
  // Auto is 4 (see the wrap test above); 1.5x -> 6, budget for 2 rows.
  assert.deepEqual(fitSlotText(lines, 30, 20, { scale: 1.5 }), {
    lines: [['A1'], ['12345…']],
    fontSize: 6,
  });
  // 2x -> 8, budget for one row: the code survives, the person line goes.
  assert.deepEqual(fitSlotText(lines, 30, 20, { scale: 2 }), {
    lines: [['A1…'], []],
    fontSize: 8,
  });
});

test('fitSlotText: the code shrinks back to Auto when even it would not fit', () => {
  // In a flat 12 x 8 slot the code "A1" alone Auto-fits at 4.5 (the size is
  // capped at SLOT_TEXT_MAX, V5-M4b); at 2x = 9 not even the wrapped code
  // fits any more, so the whole slot falls back to its Auto layout.
  assert.deepEqual(fitSlotText(['A1'], 12, 8, { scale: 2 }), { lines: [['A1']], fontSize: 4.5 });
});

test('fitSlotText: a smaller step keeps every row, no ellipsis', () => {
  const fit = fitSlotText(['SP14', '123 Doe, Jo Jo'], 45, 14, { scale: 0.9 });
  assert.equal(fit.fontSize, 4.1);
  assert.deepEqual(fit.lines, [['SP14'], ['123 Doe, Jo Jo']]);
  assert.ok(!fit.lines.flat().some((row) => row.includes('…')));
});

// ---------------------------------------------------------------------------
// personLine (logic-map.js): "<employee ID> <staff name>", ID first.
// ---------------------------------------------------------------------------

test('personLine: ID first, then the name — "123 Doe, Jo Jo"', () => {
  assert.equal(personLine({ empId: '123', name: 'Doe, Jo Jo' }), '123 Doe, Jo Jo');
  assert.equal(personLine({ empId: ' 123 ', name: ' Doe, Jo Jo ' }), '123 Doe, Jo Jo');
  // ID alone or name alone when the other is empty; '' when both are.
  assert.equal(personLine({ empId: '123' }), '123');
  assert.equal(personLine({ name: 'Doe, Jo Jo' }), 'Doe, Jo Jo');
  assert.equal(personLine({ empId: '', name: '' }), '');
  assert.equal(personLine(null), '');
  assert.equal(personLine({ empId: null, name: null }), '');
});

// ---------------------------------------------------------------------------
// Source checks: the DOM side of map.js/styles.css/app.js/help.js.
// ---------------------------------------------------------------------------

test('map.js: slot text is laid out by fitSlotText in the view AND the editor', () => {
  const src = read('map.js');
  assert.match(src, /from '\.\/logic-map\.js'/);
  assert.match(src, /fitSlotText\(defs\.map\(\(entry\) => entry\.text\), rect\.w, rect\.h, \{ scale \}\)/);
  // Both render paths build their rows through slotTextNodes with the station.
  assert.match(src, /slotTextNodes\(rect, station\)/);
  assert.match(src, /slotTextNodes\(slot, station, mapView\.names\)/);
  // The person line comes from the pure helper (never string-built ad hoc).
  assert.match(src, /text: showNames \? personLine\(station\) : ''/);
  // Toggling Show names re-renders: the person line changes the shared size.
  assert.match(src, /\/\/ The slot text is laid out for the lines actually shown/);
  assert.match(src, /ctx\.render\(\);\n      \},\n    },\n    'Show names',/);
});

test('map.js: the Text control scales the whole slot and keeps its storage key', () => {
  const src = read('map.js');
  assert.match(src, /'Text: Auto'/);
  assert.match(src, /`Text: \$\{Math\.round\(mapView\.textScale \* 100\)\}%`/);
  assert.match(src, /'aria-label': 'Smaller text'/);
  assert.match(src, /'aria-label': 'Larger text'/);
  // Same localStorage key as before (a saved choice survives the upgrade).
  assert.match(src, /const TEXT_SCALE_KEY = 'fm-text-scale'/);
});

test('map.js: print/PDF is a print-only copy built at render time, Letter, 6 mm, no header', () => {
  const src = read('map.js');
  // The copy: a deep clone of the view svg (V5-M4b; nothing is switched while
  // printing — Chrome runs afterprint before it renders the PDF).
  assert.match(src, /const copy = svg\.cloneNode\(true\)/);
  // The whole drawing (not the paper margins, not the current zoom/pan).
  assert.match(src, /return drawingBounds\(map\) \|\| fitViewBox\(map\)/);
  assert.match(src, /copy\.setAttribute\('viewBox', viewBoxString\(bounds\)\)/);
  assert.match(src, /copy\.setAttribute\('preserveAspectRatio', 'xMidYMid meet'\)/);
  assert.match(src, /copy\.setAttribute\('class', 'fm-print-svg'\)/);
  // Wrapped in the print-only holder appended next to the normal map.
  assert.match(src, /holder\.className = 'fm-print-only'/);
  // Screen-only marks and duplicated ids are stripped from the copy.
  assert.match(src, /node\.classList\.remove\(\.\.\.PRINT_STRIP_CLASSES\)/);
  assert.match(src, /copy\.querySelectorAll\('\.fm-slot-add-text'\)/);
  assert.match(src, /removeAttribute\('id'\)/);
  // Letter paper, orientation by the drawing's shape, a 6 mm margin, no
  // header text anywhere — written at render time, not at print time.
  assert.match(
    src,
    /@page \{ size: letter \$\{bounds\.w > bounds\.h \? 'landscape' : 'portrait'\}; margin: 6mm; \}/,
  );
  assert.match(src, /const PRINT_STYLE_ID = 'fm-page-style'/);
  assert.ok(!src.includes('fm-print-head'), 'the print header is gone');
  assert.ok(!src.includes('printed ${ctx.todayISO()}'), 'no printed-date header either');
  // The button only prints; the copy in the page does the layout.
  assert.match(src, /onclick: \(\) => window\.print\(\),/);
});

test('app.js: leaving the map page stops the map print setup', () => {
  const appSrc = read('app.js');
  // The route change cleanup app.js already had (V5-M4): stopMapPrint now
  // removes the @page <style> of the print copy from <head>.
  assert.match(appSrc, /import \{ renderMapPage, stationForMachine, stopMapPrint \} from '\.\/map\.js';/);
  assert.match(appSrc, /if \(tab !== 'map'\) stopMapPrint\(\);/);
});

test('styles.css: the map print shows the copy, not the app chrome or screen marks', () => {
  const css = read('styles.css');
  assert.ok(!css.includes('.fm-print-head'), 'the header style is gone too');
  // V5-M4b: printing centres on the print-only copy (body:has keeps the rule
  // to the map page; the pair is checked in tests/v5m4b.test.js).
  assert.match(css, /body:has\(\.fm-print-only\) \*/);
  assert.match(css, /\.fm-print-svg \{/);
  assert.match(css, /print-color-adjust: exact/);
  // The V5-M4 event-driven switch CSS is gone.
  assert.ok(!css.includes('body.fm-printing'), 'the old body.fm-printing switch is gone');
  assert.ok(!css.includes('.fm-print-area'), 'the old print-area class is gone');
  // "+ Add" empty-slot marks, search highlights and selection never reach the
  // paper: map.js strips them from the copy (PRINT_STRIP_CLASSES).
  const src = read('map.js');
  const strip = src.match(/const PRINT_STRIP_CLASSES = \[([^\]]*)\]/);
  assert.ok(strip, 'PRINT_STRIP_CLASSES is defined');
  for (const className of ['fm-hit', 'fm-dim', 'fm-selected', 'fm-slot-pick', 'fm-slot-add']) {
    assert.ok(strip[1].includes(`'${className}'`), `"${className}" is stripped from the print copy`);
  }
});

test('help.js + sw.js: the Floor map help matches V5-M4, the cache is bumped', () => {
  const help = read('help.js');
  assert.match(help, /employee ID first, then the staff name/);
  assert.match(help, /“123 Doe, Jo Jo”/);
  assert.match(help, /one text size for all of its lines/);
  assert.match(help, /never cutting one in half/);
  assert.match(help, /whole layout on one Letter page/);
  assert.match(help, /6 mm margin and no header text/);
  assert.match(help, /Ctrl\+P while the map page is shown/);
  const sw = read('sw.js');
  assert.match(sw, /const CACHE_VERSION = \d+;/, 'bumped, never an exact number here');
});