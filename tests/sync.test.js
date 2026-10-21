import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPull,
  backoffDelay,
  coalesceOutbox,
  outboxKey,
  statusText,
  toLocalRecord,
  toServerData,
} from '../logic-sync.js';

const put = (opId, store, id, payload, baseVersion, createdAt) => ({
  opId,
  kind: 'put',
  store,
  id,
  payload,
  baseVersion: baseVersion === undefined ? null : baseVersion,
  createdAt: createdAt || '2026-10-20T10:00:00.000Z',
  attempts: 0,
});

const del = (opId, store, id, baseVersion, createdAt) => ({
  opId,
  kind: 'delete',
  store,
  id,
  payload: null,
  baseVersion: baseVersion === undefined ? null : baseVersion,
  createdAt: createdAt || '2026-10-20T10:00:00.000Z',
  attempts: 0,
});

const stock = (opId, partId, delta) => ({
  opId,
  kind: 'stock',
  store: 'parts',
  id: opId,
  payload: { id: opId, partId, delta, reason: 'manual', workOrderId: null },
  baseVersion: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  attempts: 0,
});

const serverRecord = (over = {}) => ({
  store: 'workOrders',
  id: 'wo-1',
  data: { title: 'Fix needle', status: 'done' },
  version: 3,
  deleted: false,
  createdAt: '2026-10-01T09:00:00.000Z',
  createdBy: 'user-a',
  updatedAt: '2026-10-20T12:00:00.000Z',
  updatedBy: 'user-b',
  seq: 42,
  ...over,
});

test('coalesceOutbox collapses several puts into the latest payload with the earliest baseVersion', () => {
  const entries = [
    put('p1', 'workOrders', 'wo-1', { title: 'Draft' }, 2, '2026-10-20T10:00:00.000Z'),
    put('p2', 'workOrders', 'wo-1', { title: 'Better draft' }, 3, '2026-10-20T10:01:00.000Z'),
    put('p3', 'workOrders', 'wo-1', { title: 'Final' }, 3, '2026-10-20T10:02:00.000Z'),
  ];
  const merged = coalesceOutbox(entries);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, 'put');
  assert.equal(merged[0].payload.title, 'Final');
  assert.equal(merged[0].baseVersion, 2);
  assert.equal(merged[0].createdAt, '2026-10-20T10:00:00.000Z');
  assert.deepEqual(merged[0].mergedFrom, ['p1', 'p2', 'p3']);
});

test('coalesceOutbox collapses a delete after puts into one delete', () => {
  const entries = [
    put('p1', 'parts', 'part-9', { name: 'Needle' }, 5),
    put('p2', 'parts', 'part-9', { name: 'Needle A' }, 5),
    del('d1', 'parts', 'part-9', 5),
  ];
  const merged = coalesceOutbox(entries);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, 'delete');
  assert.equal(merged[0].id, 'part-9');
  assert.equal(merged[0].baseVersion, 5);
  assert.deepEqual(merged[0].mergedFrom, ['p1', 'p2', 'd1']);
});

test('coalesceOutbox keeps one delete after another delete', () => {
  const merged = coalesceOutbox([del('d1', 'machines', 'm-1', 4), del('d2', 'machines', 'm-1', 4)]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, 'delete');
  assert.equal(merged[0].opId, 'd1');
  assert.deepEqual(merged[0].mergedFrom, ['d1', 'd2']);
});

test('coalesceOutbox turns a put after a delete back into a put with the latest payload', () => {
  const merged = coalesceOutbox([
    del('d1', 'machines', 'm-1', 4),
    put('p1', 'machines', 'm-1', { name: 'Reborn' }, 4),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, 'put');
  assert.deepEqual(merged[0].payload, { name: 'Reborn' });
  assert.deepEqual(merged[0].mergedFrom, ['d1', 'p1']);
});

test('coalesceOutbox never coalesces stock entries', () => {
  const merged = coalesceOutbox([
    stock('s1', 'part-1', 1),
    stock('s2', 'part-1', 1),
    put('p1', 'parts', 'part-1', { name: 'Needle' }, 2),
    stock('s3', 'part-1', -1),
    put('p2', 'parts', 'part-1', { name: 'Needle B' }, 2),
  ]);
  assert.equal(merged.length, 4);
  const kinds = merged.map((entry) => entry.kind);
  assert.deepEqual(kinds, ['stock', 'stock', 'put', 'stock']);
  assert.equal(merged[2].payload.name, 'Needle B');
  assert.equal(merged[2].baseVersion, 2);
  for (const entry of [merged[0], merged[1], merged[3]]) {
    assert.deepEqual(entry.mergedFrom, [entry.opId]);
  }
});

test('coalesceOutbox keeps separate groups apart and preserves first-appearance order', () => {
  const merged = coalesceOutbox([
    put('a1', 'machines', 'm-1', { name: 'A' }, 1),
    put('b1', 'machines', 'm-2', { name: 'B' }, 1),
    put('a2', 'machines', 'm-1', { name: 'A2' }, 1),
    put('b2', 'machines', 'm-2', { name: 'B2' }, 1),
  ]);
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ['m-1', 'm-2'],
  );
  assert.equal(merged[0].payload.name, 'A2');
  assert.equal(merged[1].payload.name, 'B2');
});

test('coalesceOutbox tolerates empty and missing input', () => {
  assert.deepEqual(coalesceOutbox([]), []);
  assert.deepEqual(coalesceOutbox(undefined), []);
});

test('toLocalRecord maps the server shape onto the v1 record shape', () => {
  const local = toLocalRecord(serverRecord());
  assert.equal(local.id, 'wo-1');
  assert.equal(local.title, 'Fix needle');
  assert.equal(local.createdAt, '2026-10-01T09:00:00.000Z');
  assert.equal(local.createdBy, 'user-a');
  assert.equal(local.updatedAt, '2026-10-20T12:00:00.000Z');
  assert.equal(local.updatedBy, 'user-b');
  assert.equal(local.version, 3);
  assert.equal(local.pendingSync, undefined);
});

test('toServerData strips client metadata and keeps data fields', () => {
  const data = toServerData({
    id: 'wo-1',
    title: 'Fix needle',
    status: 'done',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
    version: 3,
    createdBy: 'user-a',
    updatedBy: 'user-b',
    pendingSync: true,
  });
  assert.deepEqual(data, { title: 'Fix needle', status: 'done' });
  assert.deepEqual(toServerData(null), {});
});

test('toServerData and toLocalRecord round-trip data fields', () => {
  const sent = { title: 'Oil hook', partsUsed: [{ partId: 'p1', qty: 2 }], stockDeducted: true };
  const server = serverRecord({ data: sent });
  const back = toServerData(toLocalRecord(server));
  assert.deepEqual(back, sent);
});

test('applyPull lets server records win over local copies', () => {
  const local = [{ id: 'wo-1', title: 'Old title', version: 2, updatedAt: '2026-10-19T09:00:00.000Z' }];
  const ops = applyPull(local, [serverRecord()], []);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].action, 'put');
  assert.equal(ops[0].store, 'workOrders');
  assert.equal(ops[0].record.title, 'Fix needle');
  assert.equal(ops[0].record.version, 3);
});

test('applyPull protects keys with pending outbox entries', () => {
  const local = [{ id: 'wo-1', title: 'My offline edit', version: 3, pendingSync: true }];
  const pending = new Set([outboxKey('workOrders', 'wo-1')]);
  const ops = applyPull(local, [serverRecord()], pending);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].action, 'skip');
  assert.equal(ops[0].id, 'wo-1');
});

test('applyPull keeps a pending local record even against a tombstone', () => {
  const local = [{ id: 'wo-1', title: 'Keep me', version: 3, pendingSync: true }];
  const pending = new Set([outboxKey('workOrders', 'wo-1')]);
  const ops = applyPull(local, [serverRecord({ deleted: true })], pending);
  assert.equal(ops[0].action, 'skip');
});

test('applyPull removes local records that the server tombstoned', () => {
  const local = [{ id: 'wo-1', title: 'Doomed', version: 3 }];
  const ops = applyPull(local, [serverRecord({ deleted: true })], []);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].action, 'delete');
  assert.equal(ops[0].id, 'wo-1');
});

test('applyPull skips tombstones for records it does not have', () => {
  const ops = applyPull([], [serverRecord({ deleted: true })], []);
  assert.equal(ops[0].action, 'skip');
});

test('applyPull skips records that already match the server version', () => {
  const local = [toLocalRecord(serverRecord())];
  const ops = applyPull(local, [serverRecord()], []);
  assert.equal(ops[0].action, 'skip');
});

test('applyPull handles several stores in one batch', () => {
  const local = [
    { id: 'm-1', name: 'Juki 1', version: 1, updatedAt: '2026-10-01T09:00:00.000Z' },
    { id: 'pm-1', title: 'Oil hook', version: 1, updatedAt: '2026-10-01T09:00:00.000Z' },
  ];
  const ops = applyPull(
    local,
    [
      serverRecord({ store: 'machines', id: 'm-1', data: { name: 'Juki 1A' }, version: 2 }),
      serverRecord({ store: 'pmTasks', id: 'pm-1', data: { title: 'Oil hook weekly' }, version: 2 }),
    ],
    [],
  );
  assert.deepEqual(
    ops.map((op) => op.action),
    ['put', 'put'],
  );
  assert.equal(ops[0].store, 'machines');
  assert.equal(ops[1].store, 'pmTasks');
});

test('applyPull ignores broken server records and empty input', () => {
  assert.deepEqual(applyPull([], [], []), []);
  assert.deepEqual(applyPull(null, null, null), []);
  const ops = applyPull([], [{ nope: true }, { store: 'machines' }, null], []);
  assert.deepEqual(ops, []);
});

test('backoffDelay follows the 2s, 5s, 15s, 60s-max schedule', () => {
  assert.equal(backoffDelay(1), 2000);
  assert.equal(backoffDelay(2), 5000);
  assert.equal(backoffDelay(3), 15000);
  assert.equal(backoffDelay(4), 60000);
  assert.equal(backoffDelay(10), 60000);
  assert.equal(backoffDelay(0), 2000);
  assert.equal(backoffDelay(-5), 2000);
  assert.equal(backoffDelay(Number.NaN), 2000);
});

test('statusText labels every state and never says Synced while pending', () => {
  assert.equal(statusText({ online: true, pending: 0 }), 'Synced');
  assert.equal(statusText({}), 'Synced');
  assert.equal(statusText({ online: true, pending: 3 }), 'Saving… (3)');
  assert.equal(statusText({ online: true, pending: 1 }), 'Saving… (1)');
  assert.equal(statusText({ online: false, pending: 2 }), 'Offline – 2 changes waiting');
  assert.equal(statusText({ online: false, pending: 1 }), 'Offline – 1 change waiting');
  assert.equal(statusText({ online: false, pending: 0 }), 'Offline');
  assert.equal(statusText({ needsLogin: true, pending: 4, online: true }), 'Sign in needed');
  assert.notEqual(statusText({ online: false, pending: 7 }), 'Synced');
  assert.equal(statusText({ online: true, failed: 1 }), '1 change failed to sync');
  assert.equal(statusText({ online: true, failed: 2, pending: 0 }), '2 changes failed to sync');
});

test('statusText shows Offline waiting while the browser is online but the server is unreachable', () => {
  // sync.js computes online = navigator.onLine && serverReachable and feeds
  // it here; a down server must read as Offline even with Wi-Fi on.
  const browserOnline = true;
  const serverReachable = false;
  const online = browserOnline && serverReachable;
  assert.equal(online, false);
  assert.equal(statusText({ online, pending: 3 }), 'Offline – 3 changes waiting');
  assert.equal(statusText({ online, pending: 1 }), 'Offline – 1 change waiting');
  assert.equal(statusText({ online, pending: 0 }), 'Offline');
});