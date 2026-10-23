'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  centreViewBoxOnRect,
  clampViewBox,
  fitViewBox,
  legendCounts,
  MAP_FILTERS,
  panViewBox,
  stationForMachine,
  stationMatchesChip,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomViewBox,
} from '../map.js';

/**
 * V5-M2 (SPEC-v5.md section 2): the floor map view. The pure math the map
 * renders with — view-box zoom/pan/fit (clamped 0.5×–8×), the filter-chip
 * predicate, the legend counts and the machine→station lookup — plus
 * source checks for the navigation (sidebar + More sheet gated by
 * can('floorMap')), the #/map route, Help, the service-worker shell, and
 * that every SVG node goes through createElementNS (no innerHTML with user
 * text). The drawn map, the roster and staff names are NOT fixtures here:
 * the browser checks import the real map separately, and the roster never
 * goes into the repo (SPEC-v5.md 0 and 1.3).
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(REPO, name), 'utf8');

const view = (x, y, w, h) => ({ x, y, w, h });
const closeView = (actual, expected, epsilon = 1e-9) => {
  for (const key of ['x', 'y', 'w', 'h']) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) <= epsilon,
      `${key}: expected ${expected[key]}, got ${actual[key]}`,
    );
  }
};

// ---------------------------------------------------------------------------
// View-box math: fit, zoom (clamped 0.5×–8×), pan, clamp, centre.
// ---------------------------------------------------------------------------

test('fitViewBox: the whole map at 0 0 width height', () => {
  closeView(fitViewBox({ width: 612, height: 792 }), view(0, 0, 612, 792));
  closeView(fitViewBox({ width: 40, height: 10 }), view(0, 0, 40, 10));
  // A degenerate map still yields a usable view, never a throw or a zero.
  closeView(fitViewBox({}), view(0, 0, 1, 1));
  closeView(fitViewBox({ width: -5, height: NaN }), view(0, 0, 1, 1));
  closeView(fitViewBox(null), view(0, 0, 1, 1));
});

test('zoomViewBox: zooms around the anchor and keeps the w/h ratio', () => {
  // Centre-anchored ×2 from the fit view: the middle stays put.
  closeView(zoomViewBox(view(0, 0, 100, 50), 100, 50, 2), view(25, 12.5, 50, 25));
  // Pointer-anchored (top-left): the point under the pointer stays put.
  closeView(zoomViewBox(view(0, 0, 100, 50), 100, 50, 2, 0, 0), view(0, 0, 50, 25));
  closeView(zoomViewBox(view(0, 0, 100, 50), 100, 50, 2, 1, 1), view(50, 25, 50, 25));
  // Anchors clamp into 0–1 so a wild pointer fraction cannot skew the map.
  closeView(zoomViewBox(view(0, 0, 100, 50), 100, 50, 2, -3, 4), view(0, 25, 50, 25));
});

test('zoomViewBox: the zoom level stays within 0.5×–8× (SPEC-v5.md section 2)', () => {
  const fitW = 600;
  const fitH = 400;
  let box = view(0, 0, fitW, fitH);
  // Absurd steps in both directions: the level clamps, never the step.
  for (const factor of [1000, 100, 10]) box = zoomViewBox(box, fitW, fitH, factor);
  let level = fitW / box.w;
  assert.ok(level <= ZOOM_MAX + 1e-9, `zoomed past 8x: ${level}`);
  for (const factor of [0.001, 0.01, 0.1]) box = zoomViewBox(box, fitW, fitH, factor);
  level = fitW / box.w;
  assert.ok(level >= ZOOM_MIN - 1e-9, `zoomed below 0.5x: ${level}`);
  // Still a sane view after all that.
  assert.ok(box.w > 0 && box.h > 0 && Number.isFinite(box.x) && Number.isFinite(box.y));
});

test('zoomViewBox: a non-positive or non-finite factor is a no-op', () => {
  const before = view(10, 10, 60, 30);
  closeView(zoomViewBox(before, 100, 50, 0), before, 0);
  closeView(zoomViewBox(before, 100, 50, -2), before, 0);
  closeView(zoomViewBox(before, 100, 50, Number.NaN), before, 0);
  closeView(zoomViewBox(before, 100, 50, Number.POSITIVE_INFINITY), before, 0);
});

test('zoomViewBox: an unusable view passes through untouched', () => {
  assert.equal(zoomViewBox(null, 100, 50, 2), null);
  assert.equal(zoomViewBox(undefined, 100, 50, 2), undefined);
  assert.deepEqual(zoomViewBox(view(0, 0, 0, 50), 100, 50, 2), view(0, 0, 0, 50));
  assert.deepEqual(zoomViewBox(view('x', 0, 10, 50), 100, 50, 2), view('x', 0, 10, 50));
});

test('panViewBox: screen pixels convert through the current view', () => {
  // 100 units wide shown at 200 px: 1 px = 0.5 units, so the map follows.
  closeView(panViewBox(view(0, 0, 100, 50), 10, 5, 200), view(-5, -2.5, 100, 50));
  closeView(panViewBox(view(100, 40, 50, 25), -10, 0, 100), view(105, 40, 50, 25));
  // A zero-size or bogus client cannot divide: the view is unchanged, not a giant jump.
  closeView(panViewBox(view(0, 0, 100, 50), 10, 5, 0), view(0, 0, 100, 50));
  assert.deepEqual(panViewBox(view(0, 0, 100, 50), 10, 5, -30), view(0, 0, 100, 50));
  assert.deepEqual(panViewBox(view(0, 0, 100, 50), Number.NaN, 1, 100), view(0, 0, 100, 50));
  assert.deepEqual(panViewBox(view(0, 0, 100, 50), 10, 5, Number.NaN), view(0, 0, 100, 50));
  assert.equal(panViewBox(null, 1, 1, 100), null);
});

test('clampViewBox: the map edges are the pan stops; big views centre', () => {
  closeView(clampViewBox(view(-20, 900, 100, 50), 600, 400), view(0, 350, 100, 50));
  closeView(clampViewBox(view(700, -10, 100, 50), 600, 400), view(500, 0, 100, 50));
  // Zoomed out past the map (0.5x): the view centres on it.
  closeView(clampViewBox(view(0, 0, 1200, 800), 600, 400), view(-300, -200, 1200, 800));
  assert.equal(clampViewBox(null, 600, 400), null);
});

test('centreViewBoxOnRect: the rect lands in the middle at the same zoom', () => {
  closeView(centreViewBoxOnRect(view(0, 0, 100, 50), { x: 250, y: 150, w: 20, h: 10 }), view(210, 130, 100, 50));
  // Off-map / nonsense rects are ignored, not thrown on.
  assert.deepEqual(centreViewBoxOnRect(view(0, 0, 100, 50), null), view(0, 0, 100, 50));
  assert.deepEqual(
    centreViewBoxOnRect(view(0, 0, 100, 50), { x: 'a', y: 0, w: 1, h: 1 }),
    view(0, 0, 100, 50),
  );
  assert.equal(centreViewBoxOnRect(null, { x: 0, y: 0, w: 1, h: 1 }), null);
});

test('view-box chain: fit → clamp → centre keeps a coherent view', () => {
  const map = { width: 1000, height: 500 };
  let box = fitViewBox(map);
  box = zoomViewBox(box, map.width, map.height, 2.8); // search centre-from-fit
  box = centreViewBoxOnRect(box, { x: 400, y: 200, w: 40, h: 20 });
  box = clampViewBox(box, map.width, map.height);
  const level = map.width / box.w;
  assert.ok(level > 1 && level <= ZOOM_MAX);
  // Centred on the rectangle's middle, then stopped at the map edges.
  const midX = 400 + 40 / 2;
  assert.ok(Math.abs(box.x + box.w / 2 - clampNum(midX, box.w / 2, map.width - box.w / 2)) < 1e-9);
  function clampNum(value, low, high) {
    return Math.min(Math.max(value, low), high);
  }
});

// ---------------------------------------------------------------------------
// Filter predicate + legend counts + machine→station lookup.
// ---------------------------------------------------------------------------

test('stationMatchesChip: every chip tests the right thing', () => {
  const station = { machineId: 'm1', vacant: false };
  const live = { down: false, openOrders: 0, pmOverdue: true };
  assert.equal(stationMatchesChip(station, live, 'all'), true);
  assert.equal(stationMatchesChip(station, live, 'down'), false);
  assert.equal(stationMatchesChip(station, { down: true, openOrders: 0 }, 'down'), true);
  assert.equal(stationMatchesChip(station, live, 'open'), false);
  assert.equal(stationMatchesChip(station, { openOrders: 2 }, 'open'), true);
  assert.equal(stationMatchesChip(station, live, 'unlinked'), false);
  assert.equal(stationMatchesChip({ machineId: null }, live, 'unlinked'), true);
  assert.equal(stationMatchesChip({}, live, 'unlinked'), true);
  assert.equal(stationMatchesChip(station, live, 'vacant'), false);
  assert.equal(stationMatchesChip({ vacant: true }, live, 'vacant'), true);
  // Unknown chips behave like "all" (a stale URL or bad state never blanks the map).
  assert.equal(stationMatchesChip(station, live, 'nope'), true);
  // Defensive: junk input answers false for the state chips, never throws.
  assert.equal(stationMatchesChip(null, null, 'down'), false);
  assert.equal(stationMatchesChip(null, null, 'all'), true);
});

test('MAP_FILTERS: the toolbar ships All · Down · Open orders · Unlinked · Vacant', () => {
  assert.deepEqual(
    MAP_FILTERS.map((chip) => chip.key),
    ['all', 'down', 'open', 'unlinked', 'vacant'],
  );
  for (const chip of MAP_FILTERS) assert.ok(chip.label.length > 0);
});

test('legendCounts: stations down / with open orders / PM overdue', () => {
  const counts = legendCounts([
    { down: true, openOrders: 0, pmOverdue: false },
    { down: false, openOrders: 3, pmOverdue: true },
    { down: false, openOrders: 1, pmOverdue: false },
    { down: false, openOrders: 0, pmOverdue: false },
  ]);
  assert.deepEqual(counts, { down: 1, openOrders: 2, pmOverdue: 1 });
  assert.deepEqual(legendCounts([]), { down: 0, openOrders: 0, pmOverdue: 0 });
  // Non-state junk is skipped instead of counted or thrown on.
  assert.deepEqual(legendCounts(null), { down: 0, openOrders: 0, pmOverdue: 0 });
  assert.deepEqual(legendCounts([null, 7, 'x', { down: true }]), {
    down: 1,
    openOrders: 0,
    pmOverdue: 0,
  });
});

test('stationForMachine: the station a Show-on-map button points at', () => {
  const stations = [
    { id: 's1', mapId: 'floor', machineId: 'm1' },
    { id: 's2', mapId: 'floor', machineId: 'm2' },
    { id: 'gone', machineId: 'm3' }, // no mapId: not on any imported floor
    { id: 's3', mapId: 'floor', machineId: null },
  ];
  assert.equal(stationForMachine('m2', stations).id, 's2');
  assert.equal(stationForMachine('m3', stations), null);
  assert.equal(stationForMachine(null, stations), null);
  assert.equal(stationForMachine('m1', []), null);
  assert.equal(stationForMachine('m1', 'not a list'), null);
});

// ---------------------------------------------------------------------------
// Source checks: navigation permissions, the route, SVG safety, Help, shell.
// ---------------------------------------------------------------------------

test('app.js: the #/map route is gated on can(\'floorMap\') and renders via map.js', () => {
  const src = read('app.js');
  assert.match(src, /import \{ renderMapPage, stationForMachine \} from '\.\/map\.js';/);
  assert.match(src, /root === 'map'/);
  assert.match(src, /!can\('floorMap'\)/);
  assert.match(src, /renderMapPage\(mapPageContext\(\), route\)/);
  // Hidden areas leave the whole route (SPEC-v3.md 13.3 pattern).
  assert.match(src, /noAccessPage\('Floor map', 'Floor map & stations'\)/);
});

test('app.js: nav entries respect floorMap — sidebar tab area + More sheet item', () => {
  const src = read('app.js');
  // applyNavPermissions() hides any link whose data-tab maps through here.
  assert.match(src, /map: 'floorMap',/);
  // The phone More sheet entry is built behind its own can('floorMap') check.
  assert.match(
    src,
    /can\('floorMap'\) && \{ label: 'Floor map', icon: NAV_ICONS\.map, href: '#\/map' \}/,
  );
  // The map icon paths exist for menuIcon().
  assert.match(src, /map: \[/);
  // The More button lights up while a More-sheet page (incl. the map) is shown.
  assert.match(src, /\['parts', 'requests', 'library', 'map', 'statistics',/);
});

test('index.html: the sidebar offers Floor map after Machines, hidden by permission', () => {
  const html = read('index.html');
  const machinesAt = html.indexOf('data-tab="machines"');
  const mapAt = html.indexOf('data-tab="map"');
  assert.ok(machinesAt > 0, 'no Machines sidebar link');
  assert.ok(mapAt > machinesAt, 'Floor map must come after Machines');
  assert.match(html, /href="#\/map" data-tab="map" title="Floor map"/);
  assert.match(html, /<span class="sidebar-label">Floor map<\/span>/);
  // The map icon is an inline stroke SVG like every other sidebar icon.
  const mapLink = html.slice(mapAt, html.indexOf('</a>', mapAt));
  assert.match(mapLink, /<svg class="sb-icon"/);
  assert.doesNotMatch(mapLink, /https?:\/\//);
});

test('map.js: every SVG node comes from createElementNS, never innerHTML', () => {
  const src = read('map.js');
  assert.match(src, /const SVG_NS = 'http:\/\/www\.w3\.org\/2000\/svg';/);
  assert.match(src, /document\.createElementNS\(SVG_NS, tag\)/);
  // Not "the word never appears in a comment" — the actual DOM sink must be absent.
  assert.doesNotMatch(src, /\.innerHTML\s*=/);
  assert.doesNotMatch(src, /insertAdjacentHTML\s*\(/);
  assert.doesNotMatch(src, /\.outerHTML\s*=/);
  // The one http URL allowed in the module is the SVG namespace itself.
  assert.equal((src.match(/https?:\/\//g) || []).length, (src.match(/http:\/\/www\.w3\.org\/2000\/svg/g) || []).length);
});

test('map.js: stations save through sync.saveRecord on floorStations', () => {
  const src = read('map.js');
  assert.match(src, /sync\.saveRecord\('floorStations', next, current\.version\)/);
  assert.match(src, /sync\.saveRecord\('floorStations', next, station\.version\)/);
  // The staff fields are the SPEC-v5.md 1.2 set, saved on change.
  for (const field of ['code', 'zone', 'name', 'nameCn', 'empId', 'vacant', 'remark', 'machineId', 'boxId', 'slot']) {
    assert.ok(src.includes(`{ ${field === 'machineId' ? 'machineId' : field}`) || src.includes(`${field}:`) || src.includes(`'${field}'`) || src.includes(`textField('${field}'`) || src.includes(`.${field}`),
      `missing station field handling: ${field}`);
  }
  // Nothing logs the roster (privacy: staff names never reach any log).
  assert.doesNotMatch(src, /console\.log/);
});

test('app.js + map.js: the V5-M3 edit canvas is not smuggled into the view', () => {
  // This milestone is the map view only; "Edit map" (canvas) is V5-M3, and a
  // disabled "Coming next" button was explicitly not wanted.
  for (const name of ['app.js', 'map.js']) {
    const src = read(name);
    assert.doesNotMatch(src, /Coming next/);
    assert.doesNotMatch(src, /Edit map/);
  }
});

test('help.js: a Floor map section exists and is registered', () => {
  const src = read('help.js');
  assert.match(src, /\{ id: 'help-floor', title: 'Floor map' \}/);
  assert.match(src, /function helpFloor\(h\)/);
  assert.match(src, /helpFloor\(h\),/);
});

test('sw.js: the shell caches map.js (version bumped, exact number not asserted)', () => {
  const src = read('sw.js');
  assert.match(src, /'\.\/map\.js',/);
  assert.match(src, /const CACHE_VERSION = \d+;/);
});

test('styles.css: the map view styles are in place', () => {
  const css = read('styles.css');
  for (const selector of ['.fm-svg', '.fm-toolbar', '.fm-legend', '.fm-slot-empty-rect', '.fm-offmap', '.fm-panel']) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
  // The SVG grabs the pan/pinch gestures instead of scrolling the page.
  assert.match(css, /\.fm-svg[\s\S]*touch-action: none;/);
});