// WPFI safety inspections: sheet parsing, the cached refresh, the two-month
// window, grouping by worker, and the API permissions. No real network: the
// "Google sheet" is a local HTTP server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { startServer } from '../server/server.js';
import { isoDate, parseCsv, readWpfi, refreshWpfi, wpfiRecords } from '../server/wpfi.js';
import { twoMonthsBefore, wpfiGroups } from '../logic-map.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const SHEET = [
  '時間戳記,Date (如為之前補填),Station No.,Worker ID,Worker Name (Optional),Improvement Areas: request to remove items,Inspector\'s Name',
  '2026/10/15 下午 3:55:24,2026/10/15,SN 19 ,524,Test Worker,Coffee,Insp A',
  '2026/11/10 上午 11:45:14,2026/11/6,73,524,,"Phone on table, earphone",Insp B',
  '2026/11/10 上午 11:46:00,,SN 32,51,"Pat ""PT"" Test","3 把剪刀\n冇繫繩",Insp A',
  ',,,,,,',
  '2026/8/01 上午 9:00:00,2026/8/1,SN 5,77,Old,Hand cream,Insp A',
].join('\r\n');

test('parseCsv: quotes, doubled quotes, commas and newlines inside fields', () => {
  const rows = parseCsv('a,"b,c","d ""e"""\r\n"x\ny",z,\n');
  assert.deepEqual(rows, [
    ['a', 'b,c', 'd "e"'],
    ['x\ny', 'z', ''],
  ]);
});

test('isoDate: sheet dates and timestamps', () => {
  assert.equal(isoDate('2026/1/5'), '2026-01-05');
  assert.equal(isoDate('2026/11/10 上午 11:45:14'), '2026-11-10');
  assert.equal(isoDate(''), null);
  assert.equal(isoDate('soon'), null);
});

test('wpfiRecords: columns by header, Date falls back to the timestamp, blank rows dropped', () => {
  const records = wpfiRecords(parseCsv(SHEET));
  assert.equal(records.length, 4);
  assert.deepEqual(records[1], {
    date: '2026-11-06',
    station: '73',
    workerId: '524',
    workerName: '',
    issue: 'Phone on table, earphone',
    inspector: 'Insp B',
  });
  assert.equal(records[2].date, '2026-11-10');
  assert.equal(records[2].workerName, 'Pat "PT" Test');
});

test('twoMonthsBefore: same day two months back, clamped to the month end', () => {
  assert.equal(twoMonthsBefore('2026-11-10'), '2026-09-10');
  assert.equal(twoMonthsBefore('2026-04-30'), '2026-02-28');
  assert.equal(twoMonthsBefore('2026-01-15'), '2025-11-15');
});

test('wpfiGroups: by worker ID, station by employee ID first then code, newest first', () => {
  const records = wpfiRecords(parseCsv(SHEET));
  const stations = [
    { id: 'a', empId: '524', code: 'SN 40' },
    { id: 'b', code: 'SN 32' },
  ];
  const groups = wpfiGroups(records, stations, '2026-09-10');
  assert.deepEqual(
    groups.map((g) => [g.workerId, g.station && g.station.id, g.records.map((r) => r.date)]),
    [
      ['524', 'a', ['2026-11-06', '2026-10-15']],
      ['51', 'b', ['2026-11-10']],
    ],
  );
  assert.equal(groups[0].workerName, 'Test Worker');
});

test('refreshWpfi: a failed download keeps the last good records and notes the error', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'wpfi-unit-'));
  try {
    const ok = await refreshWpfi(dir, 'x', async () => new Response(SHEET));
    assert.equal(ok.records.length, 4);
    assert.equal(ok.error, null);
    const failed = await refreshWpfi(dir, 'x', async () => new Response('<!DOCTYPE html><p>sign in</p>'));
    assert.equal(failed.records.length, 4);
    assert.match(failed.error, /web page instead of CSV/);
    assert.equal(readWpfi(dir).fetchedAt, ok.fetchedAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

let sheetServer;
let handle;
const XRW = { 'X-Requested-With': 'maint-log' };

async function login(username, password) {
  const res = await fetch(`${handle.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers.getSetCookie().find((value) => value.startsWith('sid='));
  assert.ok(cookie, `login failed for ${username}`);
  return cookie.split(';')[0];
}

before(async () => {
  sheetServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/csv' });
    res.end(SHEET);
  });
  await new Promise((resolve) => sheetServer.listen(0, '127.0.0.1', resolve));
  const dataDir = fs.mkdtempSync(path.join(TMP, 'wpfi-test-'));
  handle = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    env: { WPFI_CSV_URL: `http://127.0.0.1:${sheetServer.address().port}/sheet.csv` },
  });
  handle.store.createUser({ username: 'tina', displayName: 'Tina Tech', role: 'tech', passwordHash: auth.hashPassword('tina-password-1') });
  handle.store.createUser({ username: 'vic', displayName: 'Vic Viewer', roleId: handle.store.getRoleByName('Viewer').id, passwordHash: auth.hashPassword('vic-password-1') });
});

after(async () => {
  await handle.close();
  await new Promise((resolve) => sheetServer.close(resolve));
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
});

test('API: floor-map writers refresh from the sheet, readers see the cache, no session gets 401', async () => {
  const tina = await login('tina', 'tina-password-1');
  const vic = await login('vic', 'vic-password-1');

  const none = await fetch(`${handle.url}/api/wpfi`);
  assert.equal(none.status, 401);

  const empty = await (await fetch(`${handle.url}/api/wpfi`, { headers: { cookie: vic } })).json();
  assert.deepEqual(empty.records, []);

  const denied = await fetch(`${handle.url}/api/wpfi/refresh`, { method: 'POST', headers: { cookie: vic, ...XRW } });
  assert.equal(denied.status, 403);

  const refreshed = await fetch(`${handle.url}/api/wpfi/refresh`, { method: 'POST', headers: { cookie: tina, ...XRW } });
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).records.length, 4);

  const cached = await (await fetch(`${handle.url}/api/wpfi`, { headers: { cookie: vic } })).json();
  assert.equal(cached.records.length, 4);
  assert.ok(cached.fetchedAt);
});
