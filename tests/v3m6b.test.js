import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { barChart, escapeSVGText, formatTickValue, horizontalBarChart, lineChart, niceTicks } from '../charts.js';

/* V3-M6b Statistics UI (SPEC-v3.md section 7 with section 13 permissions).
   charts.js is a pure module (SVG markup strings), so it runs for real here;
   the app wiring is checked as static source (no DOM in node:test), matching
   the style of tests/v3m5.test.js. */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(REPO, name), 'utf8');

/* ---------- escapeSVGText / formatTickValue (pure) ---------- */

test('escapeSVGText: escapes markup characters, keeps numbers readable', () => {
  assert.equal(escapeSVGText('Needle & <breaking> "Juki"'), 'Needle &amp; &lt;breaking&gt; &quot;Juki&quot;');
  assert.equal(escapeSVGText(null), '');
  assert.equal(escapeSVGText(undefined), '');
  assert.equal(escapeSVGText(7), '7');
});

test('formatTickValue: rounds to two decimals without trailing zeros', () => {
  assert.equal(formatTickValue(3), '3');
  assert.equal(formatTickValue(2.5), '2.5');
  assert.equal(formatTickValue(0.25), '0.25');
  assert.equal(formatTickValue(null), '0');
  assert.equal(formatTickValue('nope'), '0');
  assert.equal(formatTickValue(2.999), '3');
});

/* ---------- niceTicks (scale maths, pure) ---------- */

test('niceTicks: target count respected, ticks start at 0 and cover max', () => {
  assert.deepEqual(niceTicks(7, 4), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(3.5, 4), [0, 1, 2, 3, 4]);
  assert.deepEqual(niceTicks(100, 4), [0, 25, 50, 75, 100]);
  const ticks = niceTicks(52, 4);
  assert.equal(ticks[0], 0);
  assert.ok(ticks[ticks.length - 1] >= 52, 'the last tick is at or above max');
  assert.ok(ticks.length <= 5, `at most targetCount steps (got ${ticks.length})`);
  for (let index = 1; index < ticks.length; index += 1) {
    assert.ok(ticks[index] > ticks[index - 1], 'ticks are increasing');
  }
});

test('niceTicks: zero, negative and invalid max fall back to [0]', () => {
  assert.deepEqual(niceTicks(0), [0]);
  assert.deepEqual(niceTicks(-4), [0]);
  assert.deepEqual(niceTicks(Number.NaN), [0]);
  assert.deepEqual(niceTicks('x'), [0]);
  assert.deepEqual(niceTicks(null), [0]);
});

test('niceTicks: a max that divides evenly keeps whole ticks', () => {
  assert.deepEqual(niceTicks(8, 4), [0, 2, 4, 6, 8]);
  // A single unit max still spans a readable ladder step, not 0 and 1 only.
  assert.deepEqual(niceTicks(1, 4), [0, 0.25, 0.5, 0.75, 1]);
});

test('niceTicks: fractional maxima keep round steps', () => {
  assert.deepEqual(niceTicks(0.3, 4), [0, 0.1, 0.2, 0.3]);
  assert.ok(niceTicks(2.6, 4).every((tick) => Number.isFinite(tick)));
});

/* ---------- barChart (pure markup) ---------- */

const countTitles = (markup) => (String(markup).match(/<title>/g) || []).length;

test('barChart: one <title> per bar, values and axis in the markup', () => {
  const svg = barChart(
    [
      { label: 'Open', value: 3 },
      { label: 'Waiting parts', value: 7 },
      { label: 'Done', value: 0 },
    ],
    { title: 'Service orders by status' },
  );
  assert.ok(svg.startsWith('<svg '), 'returns SVG markup');
  assert.ok(svg.includes('viewBox="0 0'), 'the viewBox scales on phones');
  assert.ok(svg.includes('role="img"'), 'exposed as an image to assistive tech');
  assert.ok(svg.includes('aria-label="Service orders by status'), 'the aria-label names the chart');
  assert.equal(countTitles(svg), 3, 'a <title> per bar');
  assert.ok(svg.includes('>Open: 3</title>'), 'bar titles carry label and value');
  assert.ok(svg.includes('>7</text>'), 'the largest value is printed');
  assert.ok(svg.includes('var(--chart-c1)'), 'colours come from CSS variables');
  assert.ok(svg.includes('var(--chart-grid)'), 'grid lines come from CSS variables');
});

test('barChart: labels are escaped, never raw markup', () => {
  const svg = barChart([{ label: 'Needle & <breaking> "Juki"', value: 2 }], { title: 'X' });
  assert.ok(svg.includes('Needle &amp; &lt;breaking&gt; &quot;Juki&quot;'));
  assert.ok(!svg.includes('<breaking>'), 'raw user text can never become markup');
});

test('barChart: empty input renders a valid empty chart', () => {
  const svg = barChart([], { title: 'Service orders by status' });
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.includes('role="img"'));
  assert.ok(svg.includes('No data yet'));
  assert.equal(countTitles(svg), 1, 'the empty state has its own title');
});

test('barChart: invalid rows and values fall back to zero-height bars', () => {
  const svg = barChart([null, { label: 'Only', value: 'nope' }], { title: 'X' });
  assert.equal(countTitles(svg), 1, 'null rows are dropped');
  assert.ok(svg.includes(': 0</title>'), 'a non-numeric value counts as 0');
});

/* ---------- horizontalBarChart (pure markup) ---------- */

test('horizontalBarChart: ranked rows with a <title> per bar and value labels', () => {
  const svg = horizontalBarChart(
    [
      { label: 'Juki DDL-8700 #12', value: 9 },
      { label: 'Steam press', value: 0 },
    ],
    { title: 'Top machines by breakdowns', unit: '' },
  );
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.includes('viewBox="0 0'));
  assert.equal(countTitles(svg), 2, 'a <title> per bar');
  assert.ok(svg.includes('>Juki DDL-8700 #12: 9</title>'));
  assert.ok(svg.includes('>9</text>'), 'values print at the end of each bar');
  assert.ok(svg.includes('var(--chart-c'), 'bar colours come from CSS variables');
});

test('horizontalBarChart: hours unit lands in the title and value label', () => {
  const svg = horizontalBarChart([{ label: 'Ace Juki Service', value: 4.5 }], { title: 'Hours', unit: 'h' });
  assert.ok(svg.includes(': 4.5h</title>'));
  assert.ok(svg.includes('>4.5h</text>'));
});

test('horizontalBarChart: empty input renders the empty chart', () => {
  const svg = horizontalBarChart([], { title: 'Hours' });
  assert.ok(svg.includes('No data yet'));
  assert.equal(countTitles(svg), 1);
});

test('horizontalBarChart: long labels are truncated for the visual, full in the title', () => {
  const longName = 'North Industrial Sewing Machine Services Incorporated';
  const svg = horizontalBarChart([{ label: longName, value: 1 }], { title: 'Hours' });
  assert.ok(svg.includes(`>${longName}: 1</title>`), 'the title keeps the full label');
  assert.ok(!svg.includes(longName.replace(/…$/, '') + '</text>'), 'the visible label is shortened');
  assert.ok(svg.includes('…'), 'truncation is marked with an ellipsis');
});

/* ---------- lineChart (pure markup) ---------- */

const weeks = [
  { label: 'Sep 21', created: 2, completed: 1 },
  { label: 'Sep 28', created: 3, completed: 3 },
  { label: 'Oct 5', created: 0, completed: 2 },
  { label: 'Oct 12', created: 5, completed: 4 },
];

const series = () => [
  { name: 'Created', values: weeks.map((week) => ({ label: week.label, value: week.created })) },
  { name: 'Completed', values: weeks.map((week) => ({ label: week.label, value: week.completed })) },
];

test('lineChart: a legend entry and a point <title> per series per bucket', () => {
  const svg = lineChart(series(), { title: 'Created vs completed per week' });
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.includes('viewBox="0 0'));
  assert.ok(svg.includes('aria-label="Created vs completed per week'));
  assert.ok(svg.includes('>Created</text>'), 'legend names the first line');
  assert.ok(svg.includes('>Completed</text>'), 'legend names the second line');
  assert.equal((svg.match(/<circle/g) || []).length, 8, 'one circle per point per series');
  assert.equal(countTitles(svg), 8, 'one <title> per point');
  assert.ok(svg.includes('>Sep 28: 3</title>'), 'point titles carry bucket label and value');
  assert.ok(svg.includes('var(--chart-c1') && svg.includes('var(--chart-c2)'), 'each line gets its own token colour');
  assert.equal((svg.match(/<polyline/g) || []).length, 2, 'one polyline per series');
});

test('lineChart: empty and single-bucket inputs', () => {
  const empty = lineChart([], { title: 'X' });
  assert.ok(empty.includes('No data yet'));
  assert.ok(empty.includes('role="img"'));
  const one = lineChart([{ name: 'Created', values: [{ label: 'Oct 12', value: 2 }] }], { title: 'Y' });
  assert.equal(countTitles(one), 1);
  assert.ok(one.includes('polyline'), 'a single bucket still draws a line');
});

test('lineChart: label text is escaped', () => {
  const svg = lineChart([
    { name: 'Crea&ted', values: [{ label: '<Oct>', value: 1 }] },
  ], { title: 'X' });
  assert.ok(svg.includes('Crea&amp;ted'));
  assert.ok(svg.includes('&lt;Oct&gt;'));
  assert.ok(!svg.includes('<Oct>'));
});

/* ---------- Static source: app.js wiring ---------- */

test('app.js: statistics routes, tabs and the permission gate', () => {
  const src = read('app.js');
  assert.match(src, /function renderStatisticsMonitor\(\)/);
  assert.match(src, /function renderStatisticsReports\(\)/);
  // The area gate answers "You do not have access" (SPEC-v3.md 13.3).
  assert.match(src, /canViewArea\('statistics'\)/);
  assert.match(src, /content = noAccessPage\('Statistics', 'Statistics'\)/);
  // Two tabs at #/statistics and #/statistics/reports.
  assert.match(src, /\{ key: 'monitor', label: 'Status monitor', href: '#\/statistics' \}/);
  assert.match(src, /\{ key: 'reports', label: 'Reports', href: '#\/statistics\/reports' \}/);
  assert.match(src, /content = renderStatisticsMonitor\(\);/);
  assert.match(src, /content = renderStatisticsReports\(\);/);
});

test('app.js: status monitor built from logic-stats with clickable tiles', () => {
  const src = read('app.js');
  assert.match(src, /machineStatusCounts\(state\.machines\)/);
  assert.match(src, /downNow\(state\.machines, state\.workOrders, nowISO\(\)\)/);
  assert.match(src, /todayStrip\(state\.workOrders, state\.pmTasks, state\.machines, todayISO\(\)\)/);
  // Every tile filters the Machines list by that status.
  assert.match(src, /href: `#\/machines\?status=\$\{status\}`/);
  assert.ok(src.includes('All machines are running'), 'the empty state text');
  for (const label of ["'Machine'", "'Type'", "'Down since'", "'Service order'", "'Assigned to'", "'Hours down'"]) {
    assert.ok(src.includes(label), `down-now table has the ${label} column`);
  }
  for (const label of ["'Opened today'", "'Closed today'", "'Overdue now'", "'PM due today'"]) {
    assert.ok(src.includes(`statTile(${label}`), `today strip counts ${label}`);
  }
});

test('app.js: reports tab with range selector, KPIs, charts, tables and CSV', () => {
  const src = read('app.js');
  // Range selector 30 / 90 / 365 via rangeFor.
  assert.ok(src.includes('const STATS_RANGE_CHOICES = [30, 90, 365];'));
  assert.match(src, /const range = rangeFor\(days\);/);
  // KPIs from logic-stats.
  assert.match(src, /const values = kpis\(/);
  for (const label of ["'Open service orders'", "'MTTR'", "'PM compliance'", "'Downtime hours'", "'Labour hours'"]) {
    assert.ok(src.includes(`statTile(${label}`), `KPI tile ${label}`);
  }
  assert.match(src, /values\.mttrHours === null \? '—' : `\$\{values\.mttrHours\.toFixed\(1\)\} h`/);
  // The six charts.
  assert.match(src, /markup: barChart\(/);
  assert.match(src, /markup: lineChart\(/);
  assert.match(src, /markup: horizontalBarChart\(/);
  for (const call of [
    'countByStatus(state.workOrders)',
    'countByPriority(state.workOrders)',
    'createdVsCompletedWeekly(state.workOrders, range)',
    'downtimeByMachineType(state.workOrders, state.machines, range)',
    'topMachinesByBreakdowns(state.workOrders, state.machines, range, 10)',
    'labourByContractor(state.workOrders, state.contractors, range, { includeCost })',
    'labourByCoworker(state.workOrders, state.coworkers, range)',
  ]) {
    assert.ok(src.includes(call), `chart data from ${call}`);
  }
  // Show table toggle + Export CSV through tableToCSV.
  assert.ok(src.includes("'Show table'"));
  assert.ok(src.includes("'Show chart'"));
  assert.match(src, /downloadFile\(filename, 'text\/csv;charset=utf-8', tableToCSV\(columns, rows\)\)/);
  // The contractor table: Contractor, Trade, Service orders, Hours (+ Cost).
  assert.ok(src.includes("{ key: 'contractor', label: 'Contractor' }"));
  assert.ok(src.includes("{ key: 'trade', label: 'Trade' }"));
  assert.ok(src.includes("{ key: 'orders', label: 'Service orders' }"));
  assert.ok(src.includes("{ key: 'hours', label: 'Hours' }"));
  assert.ok(src.includes("{ key: 'cost', label: 'Cost' }"));
  assert.ok(src.includes("{ key: 'machine', label: 'Machine' }"));
  assert.ok(src.includes("{ key: 'mtbf', label: 'MTBF (days)' }"));
});

test('app.js: chart costs and whole charts follow the role permissions', () => {
  const src = read('app.js');
  // Costs only with contractorRates Read or Write (SPEC-v3.md 13.3).
  assert.match(src, /const includeCost = canReadRates\(\);/);
  assert.match(src, /\.\.\.\(includeCost \? \[\{ key: 'cost', label: 'Cost' \}\] : \[\]\),/);
  // Charts only from readable stores.
  assert.match(src, /const showContractors = canViewArea\('contractors'\);/);
  assert.match(src, /const showCoworkers = canViewArea\('coworkers'\);/);
  assert.match(src, /const showOrders = canViewArea\('serviceOrders'\);/);
  assert.match(src, /const showMachines = canViewArea\('machines'\);/);
  // Sidebar + phone More sheet hide Statistics with permission None.
  const nav = src.slice(src.indexOf('function applyNavPermissions'));
  assert.match(nav, /const showStatistics = canViewArea\('statistics'\);/);
  assert.match(nav, /a\[data-tab="statistics"\]/);
  const moreSheet = src.slice(src.indexOf('function openMoreSheet'));
  assert.match(moreSheet, /canViewArea\('statistics'\) && \{ label: 'Statistics'/);
});

test('app.js: chart markup mounts without innerHTML; sync refreshes the monitor', () => {
  const src = read('app.js');
  // No innerHTML assignments anywhere in the client (only mentions in comments).
  assert.ok(!/\.innerHTML\s*=/.test(src), 'no innerHTML assignments in the client');
  assert.match(src, /function svgFromMarkup\(markup\)/);
  assert.match(src, /new DOMParser\(\)\.parseFromString\(String\(markup\), 'image\/svg\+xml'\)/);
  assert.match(src, /document\.importNode\(root, true\)/);
  // The page is read-only, so the sync-applied handler re-renders it.
  assert.match(src, /window\.addEventListener\('sync-applied', handleSyncApplied\)/);
  assert.match(src, /async function handleSyncApplied\(event\)/);
});

test('app.js: the statistics placeholder is gone', () => {
  const src = read('app.js');
  assert.ok(!src.includes("statistics: {\n    title: 'Statistics'"), 'no "Coming soon" statistics entry');
  assert.ok(!src.includes('Statistics arrive in a coming update'));
});

/* ---------- help.js ---------- */

test('help.js: Statistics is documented (status monitor, MTTR, PM compliance)', () => {
  const src = read('help.js');
  assert.ok(src.includes("['Status monitor',"), 'glossary entry');
  assert.ok(src.includes('Mean time to repair'), 'MTTR glossary entry');
  assert.ok(src.includes('share of PM service orders'), 'PM compliance glossary entry');
  assert.ok(src.includes('See what is down right now'), 'how-to for the monitor');
  assert.ok(src.includes('Read the statistics reports'), 'how-to for the reports');
});

/* ---------- sw.js ---------- */

test('sw.js: CACHE_VERSION bumped for the statistics shell and charts.js cached', () => {
  const src = read('sw.js');
  const version = Number(src.match(/const CACHE_VERSION = (\d+);/)?.[1]);
  assert.ok(Number.isFinite(version), 'CACHE_VERSION is a number');
  assert.ok(version >= 20, `expected CACHE_VERSION >= 20, got ${version}`);
  assert.ok(src.includes("'./charts.js'"), 'charts.js is in the app shell');
});
test('every chart root carries the SVG namespace (without it the browser shows only text)', async () => {
  const C = await import('../charts.js');
  const rows = [{ label: 'A', value: 1 }, { label: 'B', value: 2 }];
  const outputs = [
    C.barChart(rows, { title: 'x' }),
    C.horizontalBarChart(rows, { title: 'x' }),
    C.lineChart([{ name: 's', points: [{ x: 'w1', y: 1 }, { x: 'w2', y: 2 }] }], { title: 'x' }),
    C.barChart([], { title: 'empty' }),
  ];
  for (const svg of outputs) assert.match(String(svg), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});
