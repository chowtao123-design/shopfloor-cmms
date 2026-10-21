'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { startServer } from '../server/server.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const XRW = { 'X-Requested-With': 'maint-log' };

const uuid = () => crypto.randomUUID();

let handle;
let base;
let anna; // admin
let ben; // tech
let cid; // tech

function setCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single === null ? [] : [single];
}

async function login(username, password) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ username, password }),
  });
  const sidCookie = setCookies(res).find((value) => value.startsWith('sid='));
  assert.ok(sidCookie, `login failed for ${username}`);
  return sidCookie.split(';')[0].slice('sid='.length);
}

async function api(token, pathname, { method = 'GET', body } = {}) {
  const headers = {
    ...(token === null ? {} : { cookie: `sid=${token}` }),
    ...XRW,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, body: json };
}

const put = (token, storeName, id, data, baseVersion) =>
  api(token, `/api/records/${storeName}/${id}`, {
    method: 'PUT',
    body: { data, ...(baseVersion === undefined ? {} : { baseVersion }) },
  });

const history = (token, storeName, id) => api(token, `/api/history/${storeName}/${id}`);
const changes = (token, since, limit) =>
  api(token, `/api/changes?since=${since}${limit === undefined ? '' : `&limit=${limit}`}`);

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'records-test-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  base = handle.url;
  handle.store.createUser({
    username: 'anna',
    displayName: 'Anna Admin',
    role: 'admin',
    passwordHash: auth.hashPassword('anna-password-1'),
  });
  handle.store.createUser({
    username: 'ben',
    displayName: 'Ben Bolt',
    role: 'tech',
    passwordHash: auth.hashPassword('ben-password-1'),
  });
  handle.store.createUser({
    username: 'cid',
    displayName: 'Cid Crew',
    role: 'tech',
    passwordHash: auth.hashPassword('cid-password-1'),
  });
  anna = await login('anna', 'anna-password-1');
  ben = await login('ben', 'ben-password-1');
  cid = await login('cid', 'cid-password-1');
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
});

test('PUT create sets version 1, seq and created_by/updated_by from the session', async () => {
  const id = uuid();
  const { res, body } = await put(anna, 'machines', id, {
    name: 'Juki DDL-8700 #12',
    type: 'sewing',
    status: 'running',
    location: 'Line 2',
  });
  assert.equal(res.status, 200);
  const annaRow = handle.store.getUserByUsername('anna');
  assert.equal(body.record.store, 'machines');
  assert.equal(body.record.id, id);
  assert.equal(body.record.version, 1);
  assert.equal(body.record.deleted, false);
  assert.ok(Number.isInteger(body.record.seq) && body.record.seq > 0);
  assert.equal(body.record.createdBy, annaRow.id);
  assert.equal(body.record.updatedBy, annaRow.id);
  assert.equal(body.record.data.name, 'Juki DDL-8700 #12');
  assert.equal(body.conflict, null);

  const hist = await history(anna, 'machines', id);
  assert.equal(hist.res.status, 200);
  assert.equal(hist.body.length, 1);
  assert.equal(hist.body[0].action, 'create');
  assert.equal(hist.body[0].version, 1);
  assert.equal(hist.body[0].displayName, 'Anna Admin');
  assert.equal(hist.body[0].before, null);
  assert.deepEqual(hist.body[0].after, body.record.data);
});

test('PUT update bumps version and seq and keeps created_by', async () => {
  const id = uuid();
  const first = await put(anna, 'machines', id, { name: 'Old name', type: 'sewing' });
  const { res, body } = await put(anna, 'machines', id, {
    name: 'New name',
    type: 'sewing',
    status: 'down',
  });
  assert.equal(res.status, 200);
  assert.equal(body.record.version, 2);
  assert.ok(body.record.seq > first.body.record.seq);
  assert.equal(body.record.createdBy, first.body.record.createdBy);
  assert.equal(body.record.updatedBy, first.body.record.updatedBy);
  const hist = await history(anna, 'machines', id);
  assert.equal(hist.body[0].version, 2);
  assert.equal(hist.body[0].action, 'update');
  assert.equal(hist.body[0].before.name, 'Old name');
  assert.equal(hist.body[0].after.name, 'New name');
});

test('updated_by always comes from the session user, never from the body', async () => {
  const id = uuid();
  await put(anna, 'machines', id, { name: 'Shared machine', type: 'other' });
  const spoof = await api(ben, `/api/records/machines/${id}`, {
    method: 'PUT',
    body: { data: { name: 'Renamed by Ben', type: 'other' }, updatedBy: 'not-a-user', createdAt: '1999-01-01T00:00:00.000Z' },
  });
  assert.equal(spoof.res.status, 400, 'spoof fields are rejected, not applied');
  const clean = await put(ben, 'machines', id, { name: 'Renamed by Ben', type: 'other' });
  assert.equal(clean.res.status, 200);
  const benRow = handle.store.getUserByUsername('ben');
  const annaRow = handle.store.getUserByUsername('anna');
  assert.equal(clean.body.record.updatedBy, benRow.id, 'updated_by is the session user');
  assert.equal(clean.body.record.createdBy, annaRow.id, 'created_by is unchanged');
  assert.notEqual(clean.body.record.updatedAt, '1999-01-01T00:00:00.000Z');
});

test('stale baseVersion still saves (last save wins) and reports the conflict', async () => {
  const id = uuid();
  await put(ben, 'parts', id, { name: 'Needle DBX1', qtyOnHand: 20, minQty: 5 });
  const second = await put(ben, 'parts', id, { name: 'Needle DBX1', qtyOnHand: 20, minQty: 6 }, 1);
  assert.equal(second.res.status, 200);
  assert.equal(second.body.conflict, null);
  // anna edits from a stale copy (baseVersion 1, but the current version is 2)
  const stale = await put(anna, 'parts', id, { name: 'Needles DBX1 (bulk)', qtyOnHand: 20, minQty: 6 }, 1);
  assert.equal(stale.res.status, 200, 'the incoming write always wins');
  assert.equal(stale.body.record.version, 3);
  assert.equal(stale.body.record.updatedBy, handle.store.getUserByUsername('anna').id);
  assert.deepEqual(stale.body.conflict, {
    overwrittenVersion: 2,
    overwrittenBy: 'Ben Bolt',
    overwrittenAt: second.body.record.updatedAt,
  });
  const hist = await history(anna, 'parts', id);
  const conflictEntry = hist.body.find((entry) => entry.version === 3);
  assert.equal(conflictEntry.conflict, true);
  assert.match(conflictEntry.note, /v2/);
  assert.match(conflictEntry.note, /Ben Bolt/);
  assert.ok(hist.body.every((entry) => entry.conflict === false || entry.version === 3));
});

test('matching baseVersion saves without a conflict flag', async () => {
  const id = uuid();
  await put(cid, 'parts', id, { name: 'Bobbin case', qtyOnHand: 4 });
  const current = await changes(cid, 0, 1000);
  const row = current.body.records.find((record) => record.id === id);
  const ok = await put(cid, 'parts', id, { name: 'Bobbin case (black)', qtyOnHand: 4 }, row.version);
  assert.equal(ok.res.status, 200);
  assert.equal(ok.body.conflict, null);
  const hist = await history(cid, 'parts', id);
  assert.equal(hist.body[0].action, 'update');
  assert.equal(hist.body[0].conflict, false);
});

test('DELETE makes a tombstone that stays visible in the changes feed', async () => {
  const id = uuid();
  await put(anna, 'machines', id, { name: 'Scrap press', type: 'cutter' });
  const del = await api(anna, `/api/records/machines/${id}`, { method: 'DELETE' });
  assert.equal(del.res.status, 200);
  assert.equal(del.body.record.deleted, true);
  assert.equal(del.body.record.version, 2);
  assert.equal(del.body.conflict, null);

  const feed = await changes(anna, 0, 1000);
  const row = feed.body.records.find((record) => record.id === id);
  assert.ok(row, 'tombstone is returned by /api/changes');
  assert.equal(row.deleted, true);
  assert.equal(row.version, 2);

  const hist = await history(anna, 'machines', id);
  assert.equal(hist.body[0].action, 'delete');
  assert.equal(hist.body[0].before.name, 'Scrap press');
  assert.equal(hist.body[0].after, null);

  const again = await api(anna, `/api/records/machines/${id}`, { method: 'DELETE' });
  assert.equal(again.res.status, 200, 'deleting a tombstone is a no-op');
  assert.equal(again.body.record.version, 2);

  const missing = await api(ben, `/api/records/machines/${uuid()}`, { method: 'DELETE' });
  assert.equal(missing.res.status, 404);

  const staleDel = await api(ben, `/api/records/machines/${uuid()}?baseVersion=99`, { method: 'DELETE' });
  assert.equal(staleDel.res.status, 404);
});

test('delete with a stale baseVersion saves and flags the conflict', async () => {
  const id = uuid();
  await put(ben, 'machines', id, { name: 'To drop', type: 'other' });
  const del = await api(ben, `/api/records/machines/${id}?baseVersion=42`, { method: 'DELETE' });
  assert.equal(del.res.status, 200);
  assert.equal(del.body.record.deleted, true);
  assert.equal(del.body.conflict.overwrittenVersion, 1);
  assert.equal(del.body.conflict.overwrittenBy, 'Ben Bolt');
  const hist = await history(ben, 'machines', id);
  assert.equal(hist.body[0].action, 'delete');
  assert.equal(hist.body[0].conflict, true);
});

test('changes feed is ordered by seq and pages with since/limit/more', async () => {
  const taskIds = [uuid(), uuid(), uuid(), uuid()];
  for (const [index, taskId] of taskIds.entries()) {
    const res = await put(ben, 'pmTasks', taskId, {
      title: `Oil check ${index}`,
      machineId: 'sample-m-juki-11',
      intervalDays: 7,
    });
    assert.equal(res.res.status, 200);
  }

  const seen = [];
  let since = 0;
  let pages = 0;
  let page;
  do {
    page = await changes(ben, since, 2);
    assert.equal(page.res.status, 200);
    assert.ok(page.body.records.length <= 2);
    for (let i = 1; i < page.body.records.length; i += 1) {
      assert.ok(page.body.records[i - 1].seq < page.body.records[i].seq, 'page is ascending');
    }
    if (page.body.records.length === 2) {
      assert.equal(page.body.more, true);
      assert.equal(page.body.lastSeq, page.body.records[1].seq);
    }
    seen.push(...page.body.records);
    since = page.body.lastSeq;
    if (page.body.records.length > 0) {
      assert.equal(seen[seen.length - 1].seq, page.body.lastSeq);
    }
    pages += 1;
    assert.ok(pages < 50, 'feed pagination must terminate');
  } while (page.body.more);

  const seqs = seen.map((record) => record.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'no record appears twice');
  for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i - 1] < seqs[i], 'global order is ascending');
  for (const taskId of taskIds) {
    assert.ok(seen.length > 0 && seen.some((record) => record.id === taskId), `task ${taskId} is in the feed`);
  }
  const names = seen.filter((record) => record.id === taskIds[0]);
  assert.equal(names.length, 1);

  const end = await changes(ben, Math.max(...seqs), undefined);
  assert.equal(end.body.records.length, 0);
  assert.equal(end.body.more, false);
  assert.equal(end.body.lastSeq, Math.max(...seqs));
});

test('history lists newest first with before/after for every version', async () => {
  const id = uuid();
  await put(anna, 'workOrders', id, {
    title: 'Needle breaking',
    machineId: 'sample-m-juki-11',
    kind: 'breakdown',
    priority: 'urgent',
    status: 'open',
    problem: 'E07 every few minutes',
  });
  await put(ben, 'workOrders', id, {
    title: 'Needle breaking',
    machineId: 'sample-m-juki-11',
    kind: 'breakdown',
    priority: 'urgent',
    status: 'done',
    problem: 'E07 every few minutes',
    actionTaken: 'Replaced needle bar',
    completedAt: '2026-10-20',
  });
  const hist = await history(cid, 'workOrders', id);
  assert.equal(hist.res.status, 200);
  assert.equal(hist.body.length, 2);
  assert.equal(hist.body[0].version, 2);
  assert.equal(hist.body[0].action, 'update');
  assert.equal(hist.body[0].displayName, 'Ben Bolt');
  assert.equal(hist.body[0].before.status, 'open');
  assert.equal(hist.body[0].after.status, 'done');
  assert.equal(hist.body[0].after.actionTaken, 'Replaced needle bar');
  assert.equal(hist.body[1].version, 1);
  assert.equal(hist.body[1].action, 'create');
  assert.equal(hist.body[1].before, null);
  assert.equal(hist.body[1].displayName, 'Anna Admin');
  assert.ok(hist.body[0].hid > hist.body[1].hid, 'newest first');

  const invalidStore = await history(anna, 'widgets', id);
  assert.equal(invalidStore.res.status, 400);
  const noRecord = await history(anna, 'workOrders', uuid());
  assert.equal(noRecord.res.status, 404);
});

test('invalid store, id, field, enum or type gives 400', async () => {
  const cases = [
    ['unknown store', () => put(anna, 'widgets', uuid(), { name: 'X' })],
    ['bad id', () => put(anna, 'machines', 'not a uuid!', { name: 'X' })],
    ['unknown field', () => put(anna, 'machines', uuid(), { name: 'X', bogus: 1 })],
    ['bad enum', () => put(anna, 'machines', uuid(), { name: 'X', type: 'hovercraft' })],
    ['bad machine status', () => put(anna, 'machines', uuid(), { name: 'X', status: 'sideways' })],
    ['missing required', () => put(anna, 'machines', uuid(), { type: 'sewing' })],
    ['negative qtyOnHand', () => put(anna, 'parts', uuid(), { name: 'P', qtyOnHand: -3 })],
    ['fractional minQty', () => put(anna, 'parts', uuid(), { name: 'P', minQty: 1.5 })],
    ['bad partsUsed', () => put(anna, 'workOrders', uuid(), { title: 'T', machineId: 'm', partsUsed: [{ partId: 'p', qty: -1 }] })],
    ['bad work order status', () => put(anna, 'workOrders', uuid(), { title: 'T', machineId: 'm', status: 'finished' })],
    ['intervalDays below 1', () => put(anna, 'pmTasks', uuid(), { title: 'T', machineId: 'm', intervalDays: 0 })],
    ['non-integer intervalDays', () => put(anna, 'pmTasks', uuid(), { title: 'T', machineId: 'm', intervalDays: 'weekly' })],
    ['bad completedAt', () => put(anna, 'workOrders', uuid(), { title: 'T', machineId: 'm', completedAt: 'tomorrow' })],
    ['bad baseVersion', () => put(anna, 'machines', uuid(), { name: 'X' }, 'one')],
    ['bad machineIds', () => put(anna, 'parts', uuid(), { name: 'P', machineIds: 'm1' })],
    ['bad active flag', () => put(anna, 'pmTasks', uuid(), { title: 'T', machineId: 'm', active: 'yes' })],
  ];
  for (const [label, run] of cases) {
    const { res, body } = await run();
    assert.equal(res.status, 400, `${label}: expected 400`);
    assert.equal(body.error, 'bad_request', `${label}: expected bad_request code`);
    assert.ok(typeof body.message === 'string' && body.message.length > 0, label);
  }
});

test('record API without a session answers 401 login_required', async () => {
  const id = uuid();
  const cases = [
    () => api(null, '/api/changes?since=0'),
    () => api(null, `/api/records/machines/${id}`, {
      method: 'PUT',
      body: { data: { name: 'X' } },
    }),
    () => api(null, `/api/records/machines/${id}`, { method: 'DELETE' }),
    () => api(null, `/api/history/machines/${id}`),
    () => api(null, '/api/stock-moves', { method: 'POST', body: { moves: [] } }),
    () => api(null, '/api/import-v1', { method: 'POST', body: { schemaVersion: 1 } }),
  ];
  for (const run of cases) {
    const { res, body } = await run();
    assert.equal(res.status, 401);
    assert.equal(body.error, 'login_required');
  }
});

test('stock moves from two users on the same part both apply', async () => {
  const partId = uuid();
  const created = await put(cid, 'parts', partId, {
    name: 'Hook timing gauge',
    qtyOnHand: 10,
    minQty: 2,
  });
  assert.equal(created.body.record.data.qtyOnHand, 10, 'create keeps qtyOnHand');

  const annaMove = await api(anna, '/api/stock-moves', {
    method: 'POST',
    body: { moves: [{ id: uuid(), partId, delta: -3, reason: 'manual' }] },
  });
  assert.equal(annaMove.res.status, 200);
  assert.equal(annaMove.body.moves[0].applied, true);
  assert.equal(annaMove.body.moves[0].duplicate, false);
  assert.equal(annaMove.body.moves[0].qtyOnHand, 7);
  assert.equal(annaMove.body.parts[0].version, 2);

  const benMove = await api(ben, '/api/stock-moves', {
    method: 'POST',
    body: {
      moves: [{ id: uuid(), partId, delta: -4, reason: 'job-done', workOrderId: 'sample-wo-1' }],
    },
  });
  assert.equal(benMove.res.status, 200);
  assert.equal(benMove.body.moves[0].qtyOnHand, 3);
  assert.equal(benMove.body.parts[0].version, 3);
  assert.equal(benMove.body.parts[0].seq > annaMove.body.parts[0].seq, true);

  const hist = await history(cid, 'parts', partId);
  const stockEntries = hist.body.filter((entry) => entry.action === 'stock');
  assert.equal(stockEntries.length, 2);
  assert.equal(stockEntries[0].displayName, 'Ben Bolt');
  assert.match(stockEntries[0].note, /-4 \(job-done\)/);
  assert.equal(stockEntries[0].before.qtyOnHand, 7);
  assert.equal(stockEntries[0].after.qtyOnHand, 3);
});

test('duplicate move ids are ignored and reported, never applied twice', async () => {
  const partId = uuid();
  await put(cid, 'parts', partId, { name: 'Grease tube', qtyOnHand: 5 });
  const moveId = uuid();
  const first = await api(cid, '/api/stock-moves', {
    method: 'POST',
    body: { moves: [{ id: moveId, partId, delta: -1, reason: 'manual' }] },
  });
  assert.equal(first.body.moves[0].applied, true);
  assert.equal(first.body.moves[0].qtyOnHand, 4);

  const repeatBody = { moves: [{ id: moveId, partId, delta: -1, reason: 'manual' }] };
  const retry = await api(ben, '/api/stock-moves', { method: 'POST', body: repeatBody });
  assert.equal(retry.res.status, 200);
  assert.deepEqual(retry.body.moves, [{ id: moveId, applied: false, duplicate: true }]);
  assert.equal(retry.body.parts.length, 0);

  const sameBatchId = uuid();
  const sameBatch = await api(anna, '/api/stock-moves', {
    method: 'POST',
    body: {
      moves: [
        { id: sameBatchId, partId, delta: -2, reason: 'job-reopened' },
        { id: sameBatchId, partId, delta: -2, reason: 'job-reopened' },
      ],
    },
  });
  assert.equal(sameBatch.res.status, 200);
  assert.equal(sameBatch.body.moves[0].applied, true);
  assert.equal(sameBatch.body.moves[1].duplicate, true);
  assert.equal(sameBatch.body.parts[0].data.qtyOnHand, 2, 'only one delta of the batch applies');

  const hist = await history(cid, 'parts', partId);
  const stock = hist.body.filter((entry) => entry.action === 'stock');
  assert.equal(stock.length, 2, 'one history entry per applied move, none for duplicates');
  assert.ok(hist.body.every((entry) => entry.conflict === false));
});

test('stock moves clamp the quantity at 0 and record the clamp in the note', async () => {
  const partId = uuid();
  await put(ben, 'parts', partId, { name: 'Rare belt', qtyOnHand: 2 });
  const move = await api(ben, '/api/stock-moves', {
    method: 'POST',
    body: { moves: [{ id: uuid(), partId, delta: -100, reason: 'job-done' }] },
  });
  assert.equal(move.res.status, 200);
  assert.equal(move.body.moves[0].applied, true);
  assert.equal(move.body.moves[0].clamped, true);
  assert.equal(move.body.moves[0].qtyOnHand, 0);
  assert.equal(move.body.parts[0].data.qtyOnHand, 0);
  const hist = await history(ben, 'parts', partId);
  assert.equal(hist.body[0].action, 'stock');
  assert.match(hist.body[0].note, /-100 \(job-done\)/);
  assert.match(hist.body[0].note, /clamped at 0/);
  assert.equal(hist.body[0].after.qtyOnHand, 0);

  const up = await api(ben, '/api/stock-moves', {
    method: 'POST',
    body: { moves: [{ id: uuid(), partId, delta: 3, reason: 'manual' }] },
  });
  assert.equal(up.body.moves[0].qtyOnHand, 3, 'positive moves add from the clamped value');
});

test('invalid stock move batches are rejected with 400', async () => {
  const partId = uuid();
  await put(anna, 'parts', partId, { name: 'Spare part', qtyOnHand: 1 });
  const bad = [
    [{ partId, delta: -1, reason: 'manual' }],
    [{ id: 'x', partId, delta: 0, reason: 'manual' }],
    [{ id: 'x', partId, delta: -1, reason: 'shrinkage' }],
    [{ id: 'x', partId, delta: -1, reason: 'manual', extra: 'no' }],
    [{ id: 'x', partId: uuid(), delta: -1, reason: 'manual' }],
    [{ id: 'x', partId, delta: 1.5, reason: 'manual' }],
  ];
  for (const moves of bad) {
    const { res } = await api(anna, '/api/stock-moves', { method: 'POST', body: { moves } });
    assert.equal(res.status, 400, JSON.stringify(moves));
  }
});

test('qtyOnHand in a part PUT is ignored on update (server-owned)', async () => {
  const partId = uuid();
  await put(anna, 'parts', partId, { name: 'Sewing light', qtyOnHand: 6, minQty: 1 });
  const sneaky = await put(anna, 'parts', partId, {
    name: 'Sewing light LED',
    qtyOnHand: 999,
    minQty: 2,
  });
  assert.equal(sneaky.res.status, 200);
  assert.equal(sneaky.body.record.data.qtyOnHand, 6, 'client cannot write qtyOnHand on update');
  assert.equal(sneaky.body.record.data.name, 'Sewing light LED');
  assert.equal(sneaky.body.record.data.minQty, 2);

  const move = await api(ben, '/api/stock-moves', {
    method: 'POST',
    body: { moves: [{ id: uuid(), partId, delta: -6, reason: 'job-done' }] },
  });
  assert.equal(move.body.parts[0].data.qtyOnHand, 0);
  const refill = await put(ben, 'parts', partId, { name: 'Sewing light LED', qtyOnHand: 500 }, 3);
  assert.equal(refill.body.record.data.qtyOnHand, 0, 'still server-owned after moves');
  assert.equal(refill.body.record.data.qtyOnHand, move.body.parts[0].data.qtyOnHand);
});

test('import-v1 is admin-only, counts created/skipped, and keeps history', async () => {
  const machineId = 'sample-m-imp-1';
  const partId = 'sample-p-imp-1';
  const taskId = 'sample-t-imp-1';
  const payload = {
    schemaVersion: 1,
    exportedAt: '2026-10-19T09:00:00.000Z',
    machines: [
      {
        id: machineId,
        name: 'Imported quilter',
        type: 'quilting',
        status: 'running',
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-01T10:00:00.000Z',
      },
    ],
    parts: [{ id: partId, name: 'Imported needle', qtyOnHand: 7, minQty: 2, createdAt: '2026-10-01T10:00:00.000Z' }],
    workOrders: [],
    pmTasks: [
      { id: taskId, title: 'Imported oil check', machineId: machineId, intervalDays: 30, active: true, createdAt: '2026-10-01T10:00:00.000Z' },
    ],
  };

  const denied = await api(ben, '/api/import-v1', { method: 'POST', body: payload });
  assert.equal(denied.res.status, 403);
  assert.equal(denied.body.error, 'forbidden');

  const first = await api(anna, '/api/import-v1', { method: 'POST', body: payload });
  assert.equal(first.res.status, 200);
  assert.deepEqual(first.body, { created: 3, skipped: 0 });

  const annaRow = handle.store.getUserByUsername('anna');
  const machineHistory = await history(anna, 'machines', machineId);
  assert.equal(machineHistory.body.length, 1);
  assert.equal(machineHistory.body[0].action, 'create');
  assert.equal(machineHistory.body[0].note, 'imported from v1');
  assert.equal(machineHistory.body[0].displayName, 'Anna Admin');
  assert.equal(machineHistory.body[0].version, 1);
  assert.equal(machineHistory.body[0].before, null);
  assert.equal(machineHistory.body[0].after.name, 'Imported quilter');

  const partHistory = await history(anna, 'parts', partId);
  assert.equal(partHistory.body[0].action, 'stock');
  assert.match(partHistory.body[0].note, /\(import\)/);
  assert.equal(partHistory.body[0].after.qtyOnHand, 7);
  assert.equal(partHistory.body[1].action, 'create');
  assert.equal(partHistory.body[1].note, 'imported from v1');

  const feed = await changes(anna, 0, 1000);
  const imported = feed.body.records.filter((record) => [machineId, partId, taskId].includes(record.id));
  assert.equal(imported.length, 3, 'imported records keep their ids and appear in the feed');
  for (const record of imported) {
    assert.equal(record.version, 1);
    assert.equal(record.createdBy, annaRow.id);
    assert.equal(record.updatedBy, annaRow.id);
    assert.equal(record.deleted, false);
  }
  const importedMachine = imported.find((record) => record.id === machineId);
  assert.equal(importedMachine.data.name, 'Imported quilter');
  assert.equal(importedMachine.data.qtyOnHand, undefined, 'machines do not carry part fields');

  const again = await api(anna, '/api/import-v1', { method: 'POST', body: payload });
  assert.equal(again.res.status, 200);
  assert.deepEqual(again.body, { created: 0, skipped: 3 });

  const badVersion = await api(anna, '/api/import-v1', {
    method: 'POST',
    body: { ...payload, schemaVersion: 2 },
  });
  assert.equal(badVersion.res.status, 400);

  const freshId = 'sample-m-imp-2';
  const invalid = await api(anna, '/api/import-v1', {
    method: 'POST',
    body: { ...payload, machines: [{ id: freshId, type: 'sewing' }] },
  });
  assert.equal(invalid.res.status, 400, 'invalid records are rejected');
  const afterInvalid = await changes(anna, 0, 1000);
  assert.equal(
    afterInvalid.body.records.find((record) => record.id === freshId),
    undefined,
    'a rejected import leaves nothing behind'
  );

  const repaired = await api(anna, '/api/import-v1', {
    method: 'POST',
    body: { ...payload, machines: [{ id: freshId, name: 'Fixed import', type: 'sewing' }] },
  });
  assert.equal(repaired.res.status, 200);
  assert.deepEqual(repaired.body, { created: 1, skipped: 2 });
});