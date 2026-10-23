'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SLOT_TEXT_MAX, fitSlotText } from '../logic-map.js';

/**
 * V5-M4b (SPEC-v5.md, PM browser check of V5-M4 2026-10-22): the map PDF and
 * the slot text cap.
 *
 * Chrome fires 'afterprint' BEFORE it renders the PDF (Page.printToPDF does,
 * and the print preview may too), so M4's beforeprint/afterprint state switch
 * was undone before the picture was taken — the PDF showed the zoomed map AND
 * the whole app page. Printing no longer listens to those events at all: the
 * map view keeps a hidden print-only copy of the svg in the page (plus its
 * @page <style>), rebuilt on every render (data, names, text size) and never
 * on zoom/pan; the Print / PDF button only calls window.print().
 *
 * And the Auto slot text size caps at SLOT_TEXT_MAX: a lone code in a big
 * cell no longer towers over its neighbours ("SN 41" drawn ~12 units next to
 * "End QC 1" at 7) — every cell reads at a similar size, smaller cells still
 * shrink to fit exactly as before.
 *
 * Source checks for the DOM side, pure calls for the fit. No browser here and
 * no real map or roster data anywhere: the text fixtures are tiny and
 * synthetic (SPEC-v5.md sections 0 and 1.3 — the roster never reaches the
 * repo, and no staff name reaches any log).
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(REPO, name), 'utf8');

// ---------------------------------------------------------------------------
// Print CSS (styles.css): while the print-only copy is in the page, printing
// shows only that copy — the whole layout, no app chrome, no screen zoom.
// ---------------------------------------------------------------------------

test('styles.css: print CSS centres on .fm-print-only behind body:has', () => {
  const css = read('styles.css');
  // With the copy in the page (the map view is shown), everything else stays
  // off the paper…
  assert.match(css, /body:has\(\.fm-print-only\) \* \{\s*visibility: hidden;\s*\}/);
  // …and the copy itself, with everything inside it, goes back on it.
  assert.match(css, /\.fm-print-only,\s*\.fm-print-only \* \{[^}]*visibility: visible/);
  // The copy IS the page inside its margin; the svg fills it, width and page
  // height, and meet-fits the whole drawing (viewBox set by map.js).
  assert.match(css, /\.fm-print-only \{[^}]*display: block;\s*position: fixed;\s*inset: 0;/);
  assert.match(css, /\.fm-print-svg \{[^}]*width: 100%;\s*height: 100%;/);
  // Box and badge colours print as drawn.
  assert.match(css, /print-color-adjust: exact/);
  // On screen the holder — svg included — is hidden: print-only.
  assert.match(css, /\.fm-print-only \{\s*display: none;\s*\}/);
  // The V5-M4 event-driven switch (body class + print-area CSS) is gone.
  assert.ok(!css.includes('body.fm-printing'), 'the body.fm-printing switch is gone');
  assert.ok(!css.includes('.fm-print-area'), 'the old print-area class is gone');
});

// ---------------------------------------------------------------------------
// No print event listeners: the copy makes printing event-independent.
// ---------------------------------------------------------------------------

test('no beforeprint/afterprint listeners remain in the client', () => {
  // No listener registration (or removal) of the print events anywhere in
  // the client — comments may name the events, code must not use them.
  for (const name of ['map.js', 'app.js', 'help.js']) {
    const src = read(name);
    for (const eventName of ['beforeprint', 'afterprint']) {
      const pattern = new RegExp(`(?:add|remove)EventListener\\((['"])${eventName}\\1`);
      assert.ok(!pattern.test(src), `${name} never registers or removes a '${eventName}' listener`);
    }
  }
});

// ---------------------------------------------------------------------------
// fitSlotText (logic-map.js): the Auto size caps at SLOT_TEXT_MAX.
// ---------------------------------------------------------------------------

test('fitSlotText: the Auto size never returns anything above SLOT_TEXT_MAX (7)', () => {
  assert.equal(SLOT_TEXT_MAX, 7);
  // A code alone in a big cell hits the cap exactly — the PM's example pair
  // ("SN 41" next to "End QC 1") reads at the same size now.
  for (const code of ['SN 41', 'SP 90', 'SN 23', 'End QC 1']) {
    const fit = fitSlotText([code], 60, 26);
    assert.deepEqual(fit.lines, [[code]]);
    assert.equal(fit.fontSize, 7);
  }
  // Whatever the cell (and whatever the text), Auto stays at or under the cap.
  const cells = [
    [45, 14],
    [60, 26],
    [90, 40],
    [120, 30],
    [180, 60],
    [22.1, 28.3],
    [300, 120],
  ];
  const lineSets = [
    ['A1'],
    ['SP14'],
    ['SN 41'],
    ['SP14', '123 Doe, Jo Jo'],
    ['A1', '12345 Wong, Chi Keung'],
    ['End QC 1', '207 Cheung, Kai Ming'],
    ['', null],
  ];
  for (const [w, h] of cells) {
    for (const lines of lineSets) {
      const fit = fitSlotText(lines, w, h);
      if (fit.fontSize > 0) {
        assert.ok(
          fit.fontSize <= SLOT_TEXT_MAX,
          `${JSON.stringify(lines)} in ${w}x${h}: ${fit.fontSize} <= ${SLOT_TEXT_MAX}`,
        );
      }
    }
  }
  // Smaller cells still shrink to fit exactly as they did before the cap.
  assert.equal(fitSlotText(['SP14', '123 Doe, Jo Jo'], 45, 14).fontSize, 4.5);
  assert.equal(fitSlotText(['Ribbon cutting'], 22.1, 28.3).fontSize, 4.5);
  assert.equal(fitSlotText(['A1', '12345 Wong, Chi Keung'], 30, 20).fontSize, 4);
  assert.equal(fitSlotText(['EXTRALONGWORDTHATNEVERFITS'], 22.1, 28.3).fontSize, 1.5);
});