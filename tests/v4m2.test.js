'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildLowStockRequestLines,
  escapeHtmlText,
  moveRequestLine,
  partRequestLine,
  requestHstLabel,
  requestLineDescription,
  REQUEST_SHEET_COLUMNS,
  requestSheetCSV,
  requestSheetHTML,
  requestSheetRows,
  requestSheetTotals,
  requestSheetTSV,
  requestTotals,
  searchPurchaseRequests,
} from '../logic.js';

/**
 * V4-M2 (SPEC-v4.md sections 3.1-3.4 and 7): the parts requests UI. The pure
 * helpers here cover the low-stock line builder (skipping parts already on
 * the request), the line reorder, the CSV/TSV/HTML sheet exports, and the
 * list search; source checks pin the navigation entries to the purchasing
 * permission.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(REPO, name), 'utf8');

/* ------------------------------------------------------------------------- */
/* Low-stock line builder (SPEC-v4.md 3.3)                                   */
/* ------------------------------------------------------------------------- */

test('partRequestLine: quantity returns to the minimum level, at least 1', () => {
  const part = {
    id: 'p-needles',
    name: 'Needles DBx1 #14',
    partNumber: 'DBX1-14',
    unit: 'pcs',
    minQty: 10,
    qtyOnHand: 4,
    supplier: 'Juki Parts Co.',
  };
  assert.deepEqual(partRequestLine(part), {
    description: 'Needles DBx1 #14',
    qty: 6,
    unit: 'pcs',
    unitPrice: null,
    partId: 'p-needles',
    partNumber: 'DBX1-14',
    supplier: 'Juki Parts Co.',
  });
});

test('partRequestLine: above the minimum still asks for one; no part is null', () => {
  const plenty = { id: 'p1', name: 'Belts', minQty: 2, qtyOnHand: 12, unit: 'pcs' };
  assert.equal(partRequestLine(plenty).qty, 1);
  const missing = { id: 'p2', name: 'Sensor', minQty: 0, qtyOnHand: 0 };
  assert.equal(partRequestLine(missing).qty, 1);
  assert.equal(partRequestLine(null), null);
  assert.equal(partRequestLine({}).unit, 'pcs');
});

test('partRequestLine: fractional needs round up, description is capped at 200', () => {
  const part = { id: 'p9', name: 'x'.repeat(230), minQty: 10.5, qtyOnHand: 0 };
  const line = partRequestLine(part);
  assert.equal(line.qty, 11);
  assert.equal(line.description.length, 200);
});

test('buildLowStockRequestLines: one line per low-stock part, skipping parts already requested', () => {
  const parts = [
    { id: 'a', name: 'Needles', minQty: 5, qtyOnHand: 2 }, // low → line, qty 3
    { id: 'b', name: 'Bobbins', minQty: 10, qtyOnHand: 30 }, // fine → no line
    { id: 'c', name: 'Belts', minQty: 4, qtyOnHand: 4 }, // low → line, qty 1
    { id: 'd', name: 'Cutters', minQty: 2, qtyOnHand: 0 }, // low but already on the request
  ];
  const existingLines = [{ id: 'x1', description: 'Cutters', qty: 2, partId: 'd' }];
  const lines = buildLowStockRequestLines(parts, existingLines);

  assert.deepEqual(
    lines.map((line) => line.partId),
    ['a', 'c'],
  );
  assert.deepEqual(
    lines.map((line) => line.qty),
    [3, 1],
  );
  // Nothing is mutated: the inputs keep their shape.
  assert.equal(existingLines.length, 1);
  assert.equal(parts.length, 4);
});

test('buildLowStockRequestLines: no duplicates when repeated, empty without low parts', () => {
  const low = { id: 'only', name: 'Oil', minQty: 3, qtyOnHand: 1 };
  assert.equal(buildLowStockRequestLines([low], []).length, 1);
  assert.deepEqual(buildLowStockRequestLines([], []), []);
  const fine = { id: 'ok', name: 'Thread', minQty: 1, qtyOnHand: 40 };
  assert.deepEqual(buildLowStockRequestLines([fine], []), []);
  assert.equal(buildLowStockRequestLines(null, null).length, 0);
});

/* ------------------------------------------------------------------------- */
/* Line reorder (SPEC-v4.md 3.2)                                              */
/* ------------------------------------------------------------------------- */

test('moveRequestLine: up and down move one line, the ends stay put', () => {
  const lines = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(moveRequestLine(lines, 1, 'up').map((l) => l.id), ['b', 'a', 'c']);
  assert.deepEqual(moveRequestLine(lines, 1, 'down').map((l) => l.id), ['a', 'c', 'b']);
  // First up and last down change nothing.
  assert.deepEqual(moveRequestLine(lines, 0, 'up').map((l) => l.id), ['a', 'b', 'c']);
  assert.deepEqual(moveRequestLine(lines, 2, 'down').map((l) => l.id), ['a', 'b', 'c']);
});

test('moveRequestLine: pure — the input array stays untouched, the result is new', () => {
  const lines = [{ id: 'a' }, { id: 'b' }];
  const moved = moveRequestLine(lines, 0, 'down');
  assert.deepEqual(lines.map((l) => l.id), ['a', 'b']);
  assert.deepEqual(moved.map((l) => l.id), ['b', 'a']);
  assert.notEqual(moved, lines);
  // Unknown directions and indexes keep the order.
  assert.deepEqual(moveRequestLine(lines, 0, 'sideways').map((l) => l.id), ['a', 'b']);
  assert.deepEqual(moveRequestLine(lines, 9, 'up').map((l) => l.id), ['a', 'b']);
  assert.deepEqual(moveRequestLine(null, 0, 'up'), []);
});

/* ------------------------------------------------------------------------- */
/* Sheet rows, description context and totals labels (SPEC-v4.md 3.4)        */
/* ------------------------------------------------------------------------- */

const MACHINES = [{ id: 'm1', name: 'Juki DDL-1' }, { id: 'm2', name: 'Brother overlock' }];

const SHEET_REQUEST = {
  id: 'r7',
  number: 7,
  title: 'Juki needles + belts, Nov',
  hstRate: 13,
  lines: [
    {
      id: 'l1',
      description: 'Needle DBx1 #14',
      partNumber: 'DBX1-14',
      machineId: 'm1',
      qty: 100,
      unit: 'pcs',
      unitPrice: 0.45,
    },
    { id: 'l2', description: 'Belt, 5mm', qty: 2, unit: 'm', unitPrice: null },
  ],
};

test('requestLineDescription: part number and machine follow the description', () => {
  const names = new Map(MACHINES.map((machine) => [machine.id, machine.name]));
  assert.equal(
    requestLineDescription({ description: 'Needle', partNumber: 'DBX1-14', machineId: 'm1' }, names),
    'Needle (DBX1-14 / Juki DDL-1)',
  );
  assert.equal(requestLineDescription({ description: 'Belt' }, names), 'Belt');
  assert.equal(requestLineDescription({ description: 'Oil', machineId: 'm1' }, names), 'Oil (Juki DDL-1)');
  assert.equal(requestLineDescription({}, names), '');
});

test('requestSheetRows: unpriced lines show "—" and priced lines carry the computed total', () => {
  const totals = requestTotals(SHEET_REQUEST);
  const rows = requestSheetRows(SHEET_REQUEST, totals, { machines: MACHINES });
  assert.deepEqual(
    rows.map((row) => row.number),
    ['1', '2'],
  );
  assert.equal(rows[0].description, 'Needle DBx1 #14 (DBX1-14 / Juki DDL-1)');
  assert.equal(rows[0].unitPrice, '$0.45');
  assert.equal(rows[0].totalPrice, '$45.00');
  assert.equal(rows[1].unpriced, true);
  assert.equal(rows[1].unitPrice, '—');
  assert.equal(rows[1].totalPrice, '—');
});

test('requestSheetTotals and requestHstLabel: three figures, the typed HST rate in the label', () => {
  const footer = requestSheetTotals(SHEET_REQUEST);
  assert.deepEqual(footer.beforeHst, { label: 'Total before HST', value: '$45.00' });
  assert.deepEqual(footer.hst, { label: 'HST (13%)', value: '$5.85' });
  assert.deepEqual(footer.grand, { label: 'Total grand amount', value: '$50.85' });
  assert.equal(footer.unpricedCount, 1);
  assert.equal(requestHstLabel(13), 'HST (13%)');
  assert.equal(requestHstLabel(13.5), 'HST (13.5%)');
  assert.equal(requestHstLabel(undefined), 'HST (13%)');
});

test('requestSheetRows: works with defaults (no totals, no machines)', () => {
  const rows = requestSheetRows(SHEET_REQUEST);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].description, 'Needle DBx1 #14 (DBX1-14)');
  const empty = requestSheetRows(null);
  assert.deepEqual(empty, []);
});

/* ------------------------------------------------------------------------- */
/* CSV export (SPEC-v4.md 3.4: UTF-8 BOM, same columns + 3 total rows)        */
/* ------------------------------------------------------------------------- */

test('requestSheetCSV: BOM, header, the sheet columns and the three total rows', () => {
  const csv = requestSheetCSV(SHEET_REQUEST, null, { machines: MACHINES });
  assert.equal(csv.charCodeAt(0), 0xfeff, 'the CSV starts with the UTF-8 BOM');
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines[0], '#,Description,Qty,Unit,Unit price,Total price');
  assert.equal(lines[1], '1,Needle DBx1 #14 (DBX1-14 / Juki DDL-1),100,pcs,$0.45,$45.00');
  assert.equal(lines[2], '2,"Belt, 5mm",2,m,—,—');
  assert.deepEqual(lines.slice(3, 6), [
    ',Total before HST,,,,$45.00',
    ',HST (13%),,,,$5.85',
    ',Total grand amount,,,,$50.85',
  ]);
  assert.equal(lines.length, 7); // header + 2 lines + 3 totals + trailing row end
  assert.ok(csv.endsWith('\r\n'));
});

test('requestSheetCSV: commas and quotes are quoted, quotes double up', () => {
  const request = {
    hstRate: 0,
    lines: [
      { description: 'Belt, 5mm', qty: 1, unit: 'm', unitPrice: 3 },
      { description: 'Hook "J" size 2', qty: 2, unit: 'pcs', unitPrice: 1.5 },
    ],
  };
  const csv = requestSheetCSV(request);
  const lines = csv.split('\r\n');
  assert.equal(lines[1], '1,"Belt, 5mm",1,m,$3.00,$3.00');
  assert.equal(lines[2], '2,"Hook ""J"" size 2",2,pcs,$1.50,$3.00');
  assert.equal(lines[3], ',Total before HST,,,,$6.00');
});

test('REQUEST_SHEET_COLUMNS: exactly the six sheet columns', () => {
  assert.deepEqual(REQUEST_SHEET_COLUMNS, ['#', 'Description', 'Qty', 'Unit', 'Unit price', 'Total price']);
});

/* ------------------------------------------------------------------------- */
/* TSV and HTML clipboard payloads (SPEC-v4.md 3.4 "Copy table")             */
/* ------------------------------------------------------------------------- */

test('requestSheetTSV: tab columns, totals, and tabs inside user text cannot break the grid', () => {
  const request = {
    hstRate: 13,
    lines: [
      { description: 'Needle\tDBx1', qty: 100, unit: 'pcs', unitPrice: 0.45 },
      { description: 'Belt, 5mm', qty: 2, unit: 'm', unitPrice: null },
    ],
  };
  const tsv = requestSheetTSV(request, null, { machines: [] });
  const lines = tsv.split('\n');
  assert.equal(lines[0], '#\tDescription\tQty\tUnit\tUnit price\tTotal price');
  assert.equal(lines[1], '1\tNeedle DBx1\t100\tpcs\t$0.45\t$45.00');
  assert.equal(lines[2], '2\tBelt, 5mm\t2\tm\t—\t—');
  assert.equal(lines[3], '\tTotal before HST\t\t\t\t$45.00');
  assert.equal(lines[4], '\tHST (13%)\t\t\t\t$5.85');
  assert.equal(lines[5], '\tTotal grand amount\t\t\t\t$50.85');
});

test('escapeHtmlText: escapes the five characters that build markup', () => {
  assert.equal(escapeHtmlText('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
  assert.equal(escapeHtmlText("it's"), 'it&#39;s');
  assert.equal(escapeHtmlText(null), '');
  assert.equal(escapeHtmlText(undefined), '');
  assert.equal(escapeHtmlText(7), '7');
});

test('requestSheetHTML: a real table that escapes user text', () => {
  const request = {
    number: 7,
    title: 'Needles <small> & "more"',
    hstRate: 13,
    lines: [
      { description: 'Needle <script>alert(1)</script>', qty: 100, unit: 'pcs', unitPrice: 0.45 },
    ],
  };
  const html = requestSheetHTML(request, null, { machines: MACHINES });
  assert.ok(html.startsWith('<table'), 'starts with the table element');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'user text is not raw markup');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Purchase request PR-0007 — Needles &lt;small&gt; &amp; &quot;more&quot;'));
  assert.ok(html.includes('<thead>'));
  assert.ok(html.includes('<tfoot>'));
  assert.ok(html.includes('<th scope="col">Description</th>'));
  assert.ok(html.includes('<td colspan="5">Total before HST</td>'));
  assert.ok(html.includes('<td>$45.00</td>'));
  assert.ok(html.includes('<td>—</td>') === false, 'no unpriced marker in this request');
});

/* ------------------------------------------------------------------------- */
/* List search (SPEC-v4.md 3.1)                                              */
/* ------------------------------------------------------------------------- */

test('searchPurchaseRequests: title, number and line text, empty query returns all', () => {
  const requests = [
    { id: 'r1', number: 7, title: 'Juki needles', lines: [{ description: 'DBx1 needles' }] },
    { id: 'r2', number: 8, title: 'Belts for November', lines: [] },
    { id: 'r3', number: null, title: 'draft notes', lines: [{ description: 'grease' }] },
    { id: 'r4', number: 9, title: 'deleted request', deleted: true, lines: [] },
  ];
  assert.deepEqual(searchPurchaseRequests(requests, '').map((r) => r.id), ['r1', 'r2', 'r3']);
  assert.deepEqual(searchPurchaseRequests(requests, 'needles').map((r) => r.id), ['r1']);
  assert.deepEqual(searchPurchaseRequests(requests, 'PR-0008').map((r) => r.id), ['r2']);
  assert.deepEqual(searchPurchaseRequests(requests, '8').map((r) => r.id), ['r2']);
  assert.deepEqual(searchPurchaseRequests(requests, 'grease').map((r) => r.id), ['r3']);
  assert.deepEqual(searchPurchaseRequests(requests, 'zzz'), []);
});

/* ------------------------------------------------------------------------- */
/* Source checks: the parts requests navigation follows can('purchasing')    */
/* (SPEC-v4.md section 1)                                                    */
/* ------------------------------------------------------------------------- */

const appSource = read('app.js');
const stylesSource = read('styles.css');
const helpSource = read('help.js');
const shellSource = read('index.html');
const swSource = read('sw.js');

test('navigation: sidebar data-tab and NAV_TAB_AREAS map requests to purchasing', () => {
  // The sidebar link exists and sits right after Parts.
  const partsAt = shellSource.indexOf('href="#/parts" data-tab="parts"');
  const requestsAt = shellSource.indexOf('href="#/requests" data-tab="requests"');
  assert.ok(partsAt > 0, 'the Parts sidebar link exists');
  assert.ok(requestsAt > partsAt, 'the Parts requests link follows Parts');
  assert.ok(shellSource.includes('title="Parts requests"'));

  // NAV_TAB_AREAS drives the hidden attribute for every sidebar link.
  const navBlock = appSource.slice(
    appSource.indexOf('const NAV_TAB_AREAS'),
    appSource.indexOf('function applyNavPermissions'),
  );
  assert.ok(navBlock.includes("requests: 'purchasing',"), 'requests maps to the purchasing area');

  // The phone More sheet lists it after Parts behind the permission check.
  const moreBlock = appSource.slice(appSource.indexOf('function openMoreSheet'));
  assert.ok(
    moreBlock.includes("can('purchasing') && { label: 'Parts requests'"),
    'the More sheet entry is gated on can(purchasing)',
  );
});

test('routes: #/requests pages are gated on the purchasing permission', () => {
  const routeBlock = appSource.slice(
    appSource.indexOf("root === 'requests'"),
    appSource.indexOf("root === 'pm'"),
  );
  assert.ok(routeBlock.includes("noAccessPage('Parts requests'"), 'the area itself is gated');
  assert.ok(
    routeBlock.includes("can('purchasing', 'write')") && routeBlock.includes('renderRequestFormPage'),
    'the form routes need purchasing write',
  );

  // List "New request" button, status actions, the picker and the part-row
  // action all need purchasing write.
  assert.ok(/headActionFrom\(\s*'purchasing'/.test(appSource) || /headActionFor\(\s*'purchasing'/.test(appSource), 'New request follows headActionFor(purchasing)');
  assert.ok(appSource.includes("function requestStatusButtons(request) {\n  if (!can('purchasing', 'write')) return null;"));
  assert.ok(appSource.includes("function openAddToRequestPicker({ buildLines = null, label = null } = {}) {\n  // Adding lines needs purchasing Write (SPEC-v4.md 2/3.3).\n  if (!can('purchasing', 'write')) return;"));
});

test('gather actions exist where SPEC-v4.md 3.3 puts them', () => {
  // Part rows and part detail.
  assert.ok(appSource.includes('function addToRequestButton(part)'), 'part row action');
  // Low stock bulk: skips parts already on the request by partId.
  assert.ok(appSource.includes('Add all low-stock to request'));
  assert.ok(appSource.includes('buildLowStockRequestLines(shownParts'));
  // Service order detail.
  assert.ok(appSource.includes('function requestPartsForOrder(order)'));
  assert.ok(appSource.includes('function serviceOrderRequestLine(order)'));
  assert.ok(appSource.includes('Request parts'));
});

test('sheet: print rules hide the app chrome and the screen buttons', () => {
  const printAt = stylesSource.indexOf('@media print');
  assert.ok(printAt > 0, 'a print block exists');
  const printBlock = stylesSource.slice(printAt);
  for (const selector of ['.app-header', '.tabbar', '.sidebar', '.sheet-actions', '.fab']) {
    assert.ok(printBlock.includes(selector), `${selector} is hidden in print`);
  }
  assert.ok(stylesSource.includes('.pr-sheet'), 'the printable sheet page is styled');
});

test('help: the Parts requests section exists and is wired into the page', () => {
  assert.ok(helpSource.includes("{ id: 'help-requests', title: 'Parts requests' }"));
  assert.ok(helpSource.includes('function helpRequests(h)'));
  assert.ok(helpSource.includes('helpRequests(h),'));
  assert.ok(helpSource.includes('Parts requests,'), 'the roles area list mentions Parts requests');
});

test('service worker: the cache version is bumped past the shipped 35', () => {
  const match = swSource.match(/CACHE_VERSION\s*=\s*(\d+)/);
  assert.ok(match, 'CACHE_VERSION is defined');
  assert.ok(Number(match[1]) >= 36, `CACHE_VERSION ${match[1]} is at least 36`);
});

test('the sheet actions reuse the shared CSV/copy helpers from logic.js', () => {
  assert.ok(appSource.includes('requestSheetCSV(request, requestTotals(request), { machines: state.machines })'));
  assert.ok(appSource.includes("new window.ClipboardItem({"));
  assert.ok(appSource.includes("'text/html'"));
  assert.ok(appSource.includes("'text/plain'"));
  assert.ok(appSource.includes('window.print()'));
  assert.ok(appSource.includes('Price to be confirmed'));
});
test('request page: gather items in a plain list; the priced table only comes from Generate table', () => {
  const app = read('app.js');
  const page = app.slice(app.indexOf('function requestItemsSection('), app.indexOf('function renderRequestDetail('));
  assert.match(page, /'Generate table'/);
  assert.match(page, /\/sheet`/);
  assert.doesNotMatch(page, /requestTotals\(|<table|'table'/, 'no totals or table on the request page');
  assert.doesNotMatch(app, /createRequestLinesEditor|requestTotalsNode/, 'the inline table editor is gone');
  assert.match(app, /function requestItemForm\(/);
});

test('sheet: an item link stays in the six columns (clickable in the copied table, written out in CSV)', async () => {
  const { requestSheetHTML, requestSheetCSV, requestSheetRows } = await import('../logic.js');
  const request = { hstRate: 13, lines: [{ id: 'a', description: 'Needle', qty: 2, unit: 'pcs', unitPrice: 1, link: 'https://shop.example/x?a=1&b="2"' }] };
  assert.equal(requestSheetRows(request).at(0).link, 'https://shop.example/x?a=1&b="2"');
  const html = requestSheetHTML(request);
  assert.match(html, /<td>Needle<br><a href="https:\/\/shop\.example\/x\?a=1&amp;b=&quot;2&quot;">/);
  assert.equal((html.match(/<th /g) || []).length, 6);
  assert.match(requestSheetCSV(request), /"Needle https:\/\/shop\.example\/x\?a=1&b=""2"""/);
});
