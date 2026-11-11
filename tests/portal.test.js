// Contractor map page (server/portal.js): secret link, only his open jobs,
// no staff names, one load / one comment per 5 seconds, comments kept on
// the service order through normal saves.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { startServer } from '../server/server.js';
import { resetPortalRateLimit } from '../server/portal.js';

const TMP = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const XRW = { 'X-Requested-With': 'maint-log' };
let handle;
let staff;
const ids = {};

async function login(username, password) {
  const res = await fetch(`${handle.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...XRW }, body: JSON.stringify({ username, password }) });
  return res.headers.getSetCookie().find((v) => v.startsWith('sid=')).split(';')[0];
}
const call = (method, url, body, headers = {}) =>
  fetch(`${handle.url}${url}`, { method, headers: { 'content-type': 'application/json', ...XRW, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
async function put(store, data) {
  const id = crypto.randomUUID();
  const res = await call('PUT', `/api/records/${store}/${id}`, { data }, { cookie: staff });
  assert.equal(res.status, 200, `${store}: ${await res.clone().text()}`);
  return id;
}
const portal = (token) => call('GET', '/api/portal', undefined, { 'X-Portal-Token': token });
const comment = (token, orderId, text) => call('POST', '/api/portal/comment', { orderId, text }, { 'X-Portal-Token': token });

before(async () => {
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(TMP, 'portal-')) });
  handle.store.createUser({ username: 'tom', displayName: 'Tom Tech', role: 'tech', passwordHash: auth.hashPassword('tom-password-1') });
  staff = await login('tom', 'tom-password-1');
  ids.acme = await put('contractors', { company: 'Acme Sewing', contactName: 'Wah' });
  ids.other = await put('contractors', { company: 'Other Co' });
  ids.m1 = await put('machines', { name: 'Juki 121', type: 'single-needle', status: 'down' });
  ids.m2 = await put('machines', { name: 'Overlock 7', type: 'overlock-5', status: 'running' });
  ids.map = await put('floorMaps', { name: 'Main', width: 100, height: 100, boxes: [{ id: 'b1', x: 10, y: 10, w: 20, h: 10, slots: 2 }] });
  await put('floorStations', { mapId: ids.map, boxId: 'b1', slot: 0, code: 'SN 121', name: 'Secret Worker', empId: '777', machineId: ids.m1 });
  ids.mine = await put('workOrders', { title: 'Trimmer broken', machineId: ids.m1, status: 'open', assignees: [{ kind: 'contractor', id: ids.acme }] });
  ids.done = await put('workOrders', { title: 'Old job', machineId: ids.m1, status: 'done', assignees: [{ kind: 'contractor', id: ids.acme }] });
  ids.theirs = await put('workOrders', { title: 'Not his', machineId: ids.m2, status: 'open', assignees: [{ kind: 'contractor', id: ids.other }] });
});

beforeEach(() => resetPortalRateLimit());

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
});

test('staff make the link; the page shows only his open jobs, no staff names; 5-second limit', async () => {
  assert.equal((await call('POST', `/api/contractors/${ids.acme}/portal`)).status, 401, 'staff only');
  const made = await (await call('POST', `/api/contractors/${ids.acme}/portal`, undefined, { cookie: staff })).json();
  assert.ok(made.token && made.token.length >= 30);
  assert.equal((await portal('wrong-token-wrong-token-wrong')).status, 404);

  const res = await portal(made.token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.orders.map((o) => o.title), ['Trimmer broken']);
  assert.equal(body.orders[0].station, 'SN 121');
  assert.equal(body.map.highlights.length, 1);
  assert.ok(!JSON.stringify(body).includes('Secret Worker') && !JSON.stringify(body).includes('777'), 'no roster data');

  const again = await portal(made.token);
  assert.equal(again.status, 429);
  assert.ok(Number(again.headers.get('retry-after')) >= 1);
  assert.match((await again.json()).message, /请等待/);
});

test('comments land on his order, survive a normal staff save, and never on other jobs', async () => {
  const { token } = await (await call('GET', `/api/contractors/${ids.acme}/portal`, undefined, { cookie: staff })).json();
  const ok = await comment(token, ids.mine, 'Solenoid replaced, testing tomorrow. 已更换电磁阀。');
  assert.equal(ok.status, 201);
  assert.equal((await comment(token, ids.mine, 'too fast')).status, 429);
  resetPortalRateLimit();
  assert.equal((await comment(token, ids.theirs, 'x')).status, 404);
  resetPortalRateLimit();
  assert.equal((await comment(token, ids.done, 'x')).status, 404);

  // A staff save that does not carry the comments keeps them.
  const row = handle.store.getRecord('workOrders', ids.mine);
  const data = JSON.parse(row.data);
  delete data.contractorComments;
  const saved = await call('PUT', `/api/records/workOrders/${ids.mine}`, { data: { ...data, status: 'in-progress' }, baseVersion: Number(row.version) }, { cookie: staff });
  assert.equal(saved.status, 200);
  const after = JSON.parse(handle.store.getRecord('workOrders', ids.mine).data);
  assert.equal(after.status, 'in-progress');
  assert.equal(after.contractorComments.length, 1);
  assert.equal(after.contractorComments[0].by, 'Acme Sewing');
  assert.match(after.contractorComments[0].text, /已更换电磁阀/);
});

test('revoking the link closes the page; contractor.html is served without login', async () => {
  const { token } = await (await call('GET', `/api/contractors/${ids.acme}/portal`, undefined, { cookie: staff })).json();
  assert.equal((await call('DELETE', `/api/contractors/${ids.acme}/portal`, undefined, { cookie: staff })).status, 200);
  assert.equal((await portal(token)).status, 404);
  const page = await fetch(`${handle.url}/contractor.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /您的工单/);
});
