// v6 UI refresh: name table on the floor map, sign-in that waits for the app,
// crisp printed map text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('map.js: Map / Name table switch; the table filters with the same search and chips', () => {
  const src = read('map.js');
  assert.match(src, /mode: 'map'/);
  assert.match(src, /\['table', 'Name table'\]/);
  assert.match(src, /function nameTableRow\(/);
  // search + chip hide table rows the same way they dim map slots
  assert.match(src, /row\.node\.hidden =\s*!stationMatchesChip\(/);
  // table mode never installs the map's one-page print copy
  assert.match(src, /tableMode \? null : buildPrintCopy\(svg, map\)/);
});

test('login.js: waits for the app to load before releasing the sign-in button', () => {
  const src = read('login.js');
  assert.match(src, /await onSuccess\(response\.data\)/);
  assert.match(src, /Loading your data…/);
});

test('app.js: the login layout is dropped only after the first sync, which cannot block it', () => {
  const src = read('app.js');
  const body = src.slice(src.indexOf('async function enterTeamMode'), src.indexOf('async function startLocalMode'));
  assert.match(body, /try \{\s*await sync\.pull\(\);/);
  assert.ok(body.indexOf("classList.remove('logged-out')") > body.indexOf('await sync.pull()'));
});

test('styles.css: floor map text uses geometricPrecision for print', () => {
  const css = read('styles.css');
  assert.match(css, /\.fm-print-svg text \{\s*text-rendering: geometricPrecision;/);
});

test('map.js: without ?map= the page opens the floor with the most stations', () => {
  const src = read('map.js');
  assert.match(src, /function activeMap\(maps, route, stations = \[\]\)/);
  assert.match(src, /count\(map\) > count\(best\)/);
  assert.match(src, /activeMap\(maps, route, ctx\.state\.floorStations \|\| \[\]\)/);
});

test('sync.js: a reset from the server clears the stale local copy and pulls from 0', () => {
  const src = read('sync.js');
  const block = src.slice(src.indexOf('data.reset === true'), src.indexOf('const records = Array.isArray(data.records)'));
  assert.match(block, /await resetLocalCopy\(\{ dropQueue: true \}\)/);
  assert.match(block, /since = 0;/);
  const fn = src.slice(src.indexOf('export async function resetLocalCopy'));
  assert.match(fn, /for \(const store of db\.STORES\) await db\.clear\(store\)/);
  assert.match(fn, /await db\.setMeta\('lastSeq', 0\)/);
});

test('app.js: every interactive sign-in starts from the server copy', () => {
  const src = read('app.js');
  assert.match(src, /loginActive = false;[\s\S]{0,200}await sync\.resetLocalCopy\(\);\s*await enterTeamMode\(user\);/);
});

test('map.js: name table is a spreadsheet for writers', () => {
  const src = read('map.js');
  assert.match(src, /const NAME_TABLE_FIELDS = \[/);
  assert.match(src, /function attachGridKeys\(table\)/);
  assert.match(src, /if \(tableMode && canWrite\) attachGridKeys/);
  // saves go through the normal synced record path, one at a time per row
  assert.match(src, /queue = queue\.then\(async \(\) => \{[\s\S]{0,200}sync\.saveRecord\('floorStations', next, current\.version\)/);
  // wrapped in a form so a sync re-render never interrupts typing
  assert.match(src, /canWrite \? 'form' : 'div'/);
});

test('app.js: a cache epoch bump makes every browser rebuild its copy once', () => {
  const src = read('app.js');
  assert.match(src, /const CACHE_EPOCH = \d+;/);
  assert.match(src, /getMeta\('cacheEpoch'\)\) !== CACHE_EPOCH\) \{\s*await sync\.resetLocalCopy\(\);\s*await db\.setMeta\('cacheEpoch', CACHE_EPOCH\);/);
});

test('map.js: writers can delete an off-map station after a confirm', () => {
  const src = read('map.js');
  assert.match(src, /onclick: \(\) => deleteOffMapStation\(ctx, station\)/);
  const fn = src.slice(src.indexOf('async function deleteOffMapStation'));
  assert.match(fn, /danger: true/);
  assert.match(fn, /if \(!yes\) return;/);
  assert.match(fn, /sync\.deleteRecord\('floorStations', station\.id, station\.version\)/);
});

test('map.js: a WPFI worker opens in the side panel; re-renders only keep the highlight', () => {
  const src = read('map.js');
  const fn = src.slice(src.indexOf('function wpfiSection('));
  assert.match(fn, /showPanelWithBody\(ctx, title, content\)/);
  assert.match(src, /selectGroup\(again, \{ open: false \}\)/);
});

test('logic-map.js: the WPFI form link fills every field, Other and several inspectors', async () => {
  const { wpfiFormUrl } = await import('../logic-map.js');
  // A made-up form: the real one is private (local-config.json).
  const WPFI_FORM = {
    url: 'https://docs.google.com/forms/d/e/TEST/viewform',
    date: 'entry.1', station: 'entry.2', workerId: 'entry.3', workerName: 'entry.4', issue: 'entry.5', inspector: 'entry.6',
    issues: ['Earphone', 'Cell Phone'], inspectors: ['Ann', 'Bo'],
  };
  const url = new URL(wpfiFormUrl(WPFI_FORM, {
    date: '2026-11-10', station: 'SN 19', workerId: '524', workerName: 'Test Worker',
    issue: 'Phone on rack', inspectors: ['Ann', 'Bo'],
  }));
  assert.equal(url.origin + url.pathname, WPFI_FORM.url);
  assert.equal(url.searchParams.get('usp'), 'pp_url');
  assert.equal(url.searchParams.get(WPFI_FORM.station), 'SN 19');
  assert.equal(url.searchParams.get(WPFI_FORM.workerId), '524');
  assert.equal(url.searchParams.get(WPFI_FORM.issue), '__other_option__');
  assert.equal(url.searchParams.get(`${WPFI_FORM.issue}.other_option_response`), 'Phone on rack');
  assert.deepEqual(url.searchParams.getAll(WPFI_FORM.inspector), ['Ann', 'Bo']);
  const known = new URL(wpfiFormUrl(WPFI_FORM, { issue: 'Earphone' }));
  assert.equal(known.searchParams.get(WPFI_FORM.issue), 'Earphone');
  assert.equal(known.searchParams.get(WPFI_FORM.station), null, 'blank fields are left out');
});

test('map.js: the Inspect view opens the form panel from a station click', () => {
  const src = read('map.js');
  assert.match(src, /if \(inspectMode\) return showInspectPanel\(ctx, station\);/);
  assert.match(src, /window\.open\(url, '_blank', 'noopener'\)/);
});

test('Home and the installed app icon link straight to the WPFI pages', () => {
  const src = read('app.js');
  assert.match(src, /pageHead\('Today'\),\s*homeShortcuts\(\),/);
  assert.match(src, /tile\('#\/map\?view=inspect', 'Inspect a worker'/);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.deepEqual(manifest.shortcuts.map((s) => s.url), ['./#/map?view=inspect', './#/map?view=wpfi']);
});

test('phone sheets close with a downward swipe (gestures.js on all three sheets)', () => {
  const g = read('gestures.js');
  assert.match(g, /export function swipeToClose\(sheet, close, backdrop = null\)/);
  assert.match(g, /if \(scroller && scroller\.scrollTop > 0\) return;/, 'never while the content is scrolled');
  assert.match(read('map.js'), /swipeToClose\(root, \(\) => closeStationSheet\(\{ refocus: true \}\), backdrop\)/);
  const app = read('app.js');
  assert.match(app, /swipeToClose\(sheetHost, \(\) => closeSOFiltersPanel\(\), backdrop\)/);
  assert.match(app, /swipeToClose\(moreSheetRoot, \(\) => closeMoreSheet\(\{ refocus: true \}\), backdrop\)/);
  assert.match(read('sw.js'), /'\.\/gestures\.js'/);
});

test('zone colours: pale enough for black-and-white printing, case-insensitive, stable', async () => {
  const { zoneColor, greyValue } = await import('../logic-map.js');
  const zones = ['Line A', 'Line B', 'QC', 'BD', 'Down fill', 'Packing and special machine', 'INS / HP', 'Storage', 'x', 'Zone 42', '中文區'];
  for (let i = 0; i < 200; i += 1) zones.push(`random zone ${i}`);
  for (const zone of zones) {
    const color = zoneColor(zone);
    assert.match(color, /^#[0-9a-f]{6}$/, zone);
    assert.ok(greyValue(color) >= 0.88, `${zone} ${color} prints too dark`);
  }
  assert.equal(zoneColor('LINE B'), zoneColor('line  b'));
  assert.equal(zoneColor(''), '#ffffff');
  assert.notEqual(zoneColor('Line A'), zoneColor('QC'));
  assert.match(read('map.js'), /fill: down \? DOWN_FILL : zoneColor\(station\.zone\)/);
});

test('light/dark button: saved choice applied before paint, both token sets', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('<script src="theme.js"></script>') < html.indexOf('styles.css'), 'theme.js runs before the stylesheet');
  assert.match(html, /id="theme-button"/);
  assert.match(read('theme.js'), /setAttribute\('data-theme', saved\)/);
  const css = read('styles.css');
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{/);
  assert.match(css, /:root\[data-theme="dark"\] \{\s*color-scheme: dark;\s*--bg: #0b1020;/);
  assert.match(read('app.js'), /storageSet\('theme', next\)/);
  assert.match(read('sw.js'), /'\.\/theme\.js'/);
});

test('the browser tab icon follows the uploaded brand logo', () => {
  const src = read('app.js');
  assert.match(src, /const href = logoUrl \|\| 'icons\/icon-192\.png';/);
  assert.match(src, /favicon\.setAttribute\('href', href\)/);
});

test('worker roster: profiles join stations by employee ID, vacant seats skipped, one row per person', async () => {
  const { workerRoster, skillLevel } = await import('../logic-map.js');
  const roster = workerRoster(
    [
      { id: 'a', empId: '524', name: 'May', code: 'SN 9' },
      { id: 'b', empId: ' 524', code: 'SN 10' },
      { id: 'c', vacant: true, empId: '9', name: 'Old' },
      { id: 'd', name: 'Ann', code: 'SN 1' },
    ],
    [{ empId: '524', skillsExpert: ['binder'], skillsLearning: ['bartack'] }, { empId: '777', name: 'Off map' }],
  );
  assert.deepEqual(roster.map((w) => [w.name, w.stations.map((s) => s.code), Boolean(w.profile)]), [
    ['Ann', ['SN 1'], false],
    ['May', ['SN 9', 'SN 10'], true],
    ['Off map', [], true],
  ]);
  assert.equal(skillLevel(roster[1].profile, 'binder'), 'Expert');
  assert.equal(skillLevel(roster[1].profile, 'bartack'), 'Learning');
  assert.equal(skillLevel(null, 'binder'), '');
});

test('workerProfiles: a synced store in the floorMap area, kept from the AI, page routed', () => {
  assert.match(read('server/records.js'), /workerProfiles: \{\s*required: \['empId'\],/);
  assert.match(read('server/permissions.js'), /\['workerProfiles', 'floorMap'\]/);
  assert.match(read('permissions.js'), /\['workerProfiles', 'floorMap'\]/);
  assert.match(read('sync.js'), /'floorStations', 'workerProfiles', 'qcRecords'\]/);
  assert.match(read('db.js'), /'workerProfiles',\n  'qcRecords',\n\];/);
  assert.match(read('server/ai.js'), /AI_EXCLUDED_STORES = Object\.freeze\(\['floorMaps', 'floorStations', 'workerProfiles'\]\)/);
  assert.match(read('app.js'), /root === 'workers'/);
  assert.match(read('index.html'), /href="#\/workers" data-tab="workers"/);
});

test('skills UI: matrix batch editor, skill map view, chat Apply all card', () => {
  const workers = read('workers.js');
  assert.match(workers, /function renderMatrix\(ctx, roster, tabs\)/);
  assert.match(workers, /await sync\.saveRecord\('workerProfiles', record, worker\.profile \? worker\.profile\.version : null\)/);
  const map = read('map.js');
  assert.match(map, /\['skills', 'Skills'\]/);
  assert.match(map, /node\.classList\.add\(`fm-skill-\$\{level\}`\)/);
  const chat = read('chat.js');
  assert.match(chat, /deps\.api\('POST', '\/api\/ai\/apply-skills', \{ updates, source: 'from AI chat' \}\)/);
  assert.match(chat, /deps\.can\('floorMap', 'write'\)/);
});

test('name table: own sidebar entry, add workers not on the map, profiles follow ID changes', () => {
  assert.match(read('index.html'), /href="#\/map\?view=table" data-tab="table"/);
  const map = read('map.js');
  assert.match(map, /function showAddWorkerPanel\(ctx, map\)/);
  assert.match(map, /boxId: null,\s*slot: 0,/);
  assert.match(map, /await syncProfileWithStation\(ctx, before, next\)/);
  const fn = map.slice(map.indexOf('async function syncProfileWithStation'));
  assert.match(fn, /if \(profile && newId && !stillThere && !taken\)/);
  assert.match(read('server/permissions.js'), /'map', 'table', 'skills'/);
});

test('area marks: one outline per production line, spelling and case ignored', async () => {
  const { lineAreas } = await import('../logic-map.js');
  const map = { boxes: [{ id: 'a', x: 0, y: 0, w: 20, h: 10, slots: 2 }, { id: 'b', x: 50, y: 40, w: 10, h: 10, slots: 1 }] };
  const areas = lineAreas(
    [
      { boxId: 'a', slot: 0, zone: 'Line A' },
      { boxId: 'a', slot: 1, zone: 'LINE  a' },
      { boxId: 'b', slot: 0, zone: 'line b' },
      { boxId: 'b', slot: 0, zone: 'QC' },
      { boxId: null, zone: 'Line C' },
    ],
    map,
    0
  );
  assert.deepEqual(areas.map((a) => a.label), ['Line A', 'Line B']);
  assert.deepEqual(areas[0], { label: 'Line A', color: '#1d4ed8', x: 0, y: 0, w: 20, h: 10 });
  assert.equal(areas[1].color, '#15803d');
  assert.match(read('map.js'), /layers\.append\(areaMarks\(lineAreas\(stations, map\)\)\)/);
  assert.match(read('server/portal.js'), /areas: lineAreas\(/);
});

test('QC records: summary per worker, suggested result, store and page wired', async () => {
  const { qcSummary, qcSuggestedResult } = await import('../logic-map.js');
  assert.equal(qcSuggestedResult(100, 2), 'pass');
  assert.equal(qcSuggestedResult(100, 5), 'rework');
  assert.equal(qcSuggestedResult(100, 6), 'fail');
  const s = qcSummary(
    [
      { date: '2026-11-01', empId: '524', workerName: 'May', checked: 100, defects: 3, result: 'rework', defectTypes: ['Puckering'] },
      { date: '2026-11-05', empId: ' 524', checked: 100, defects: 1, result: 'pass', defectTypes: ['Puckering', 'Open seam'] },
      { date: '2026-11-04', empId: '9', checked: 50, defects: 0, result: 'pass' },
      { date: '2026-09-01', empId: '9', checked: 10, defects: 9, result: 'fail' },
    ],
    '2026-10-11'
  );
  assert.deepEqual(s.map((x) => [x.empId.trim(), x.checks, x.rate, x.topKinds]), [['524', 2, 2, ['Puckering', 'Open seam']], ['9', 1, 0, []]]);
  assert.equal(s[0].workerName, 'May');
  assert.match(read('server/records.js'), /qcRecords: \{\s*required: \['date', 'empId', 'checked'\],/);
  assert.match(read('app.js'), /root === 'qc'/);
  assert.match(read('index.html'), /href="#\/qc" data-tab="qc"/);
  assert.match(read('server/ai.js'), /store "qcRecords"/);
});

test('QC summary: the last result is the newest check, also on the same day', async () => {
  const { qcSummary } = await import('../logic-map.js');
  const [s] = qcSummary([
    { date: '2026-11-10', empId: '1', checked: 100, defects: 4, result: 'rework', updatedAt: '2026-11-10T15:00:00Z' },
    { date: '2026-11-10', empId: '1', checked: 100, defects: 0, result: 'pass', updatedAt: '2026-11-10T09:00:00Z' },
  ]);
  assert.equal(s.last.result, 'rework');
});

test('Line C is ready: purple outline, pale purple zone tint; staff map hides lines until "Show lines"', async () => {
  const { lineAreas, zoneColor, greyValue } = await import('../logic-map.js');
  const map = { boxes: [{ id: 'c', x: 0, y: 0, w: 10, h: 10, slots: 1 }] };
  const [area] = lineAreas([{ boxId: 'c', slot: 0, zone: 'Line C' }], map, 0);
  assert.equal(area.label, 'Line C');
  assert.equal(area.color, '#7e22ce');
  assert.equal(zoneColor('Line C'), '#ede9fe');
  assert.ok(greyValue('#ede9fe') >= 0.88);
  const src = read('map.js');
  assert.match(src, /areas: false,/);
  assert.match(src, /if \(mapView\.areas\) layers\.append\(areaMarks\(lineAreas\(stations, map\)\)\)/);
  assert.match(src, /'Show lines'/);
});

test('private shop settings stay out of git and off the web server', async () => {
  assert.match(read('.gitignore'), /^local-config\.json$/m);
  const { resolveStatic } = await import('../server/server.js');
  assert.equal(resolveStatic('/local-config.json'), null);
  assert.equal(resolveStatic('/local-config.example.json'), null);
  for (const file of ['logic-map.js', 'server/wpfi.js', 'map.js']) {
    assert.ok(!/docs\.google\.com\/(spreadsheets|forms)\/d\/[A-Za-z0-9_-]{20,}/.test(read(file)), `${file}: no real Google links`);
  }
  const { wpfiFormConfig } = await import('../server/localConfig.js');
  assert.equal(wpfiFormConfig({}), null);
  assert.equal(wpfiFormConfig({ wpfiForm: { url: 'https://evil.example/form' } }), null);
  assert.deepEqual(wpfiFormConfig({ wpfiForm: { url: 'https://docs.google.com/forms/d/e/X/viewform', date: 'entry.1', issue: 'bad', issues: ['A'] } }).issue, null);
});
