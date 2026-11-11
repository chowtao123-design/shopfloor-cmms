import test from 'node:test';
import assert from 'node:assert/strict';

import { isValidRecordId, newRecordId, planIdRepairs, UUID_RE } from '../logic-ids.js';
import { newStationId } from '../map.js';

const put = (opId, store, id, payload, baseVersion) => ({
  opId,
  kind: 'put',
  store,
  id,
  payload,
  baseVersion: baseVersion === undefined ? null : baseVersion,
  createdAt: '2026-11-10T10:00:00.000Z',
  attempts: 0,
});

const failedPut = (opId, store, id, payload) => ({
  opId,
  kind: 'put',
  store,
  id,
  payload,
  baseVersion: null,
  error: 'Invalid record id "st-19361421-b917-4dc7-b782-3b2b68098e96"; expected a UUID or sample-* id',
  failedAt: '2026-11-10T10:05:00.000Z',
});

test('isValidRecordId accepts UUIDs and sample-* ids only', () => {
  assert.equal(isValidRecordId('19361421-b917-4dc7-b782-3b2b68098e96'), true);
  assert.equal(isValidRecordId('583a7141-2b60-4b0d-976e-6244dc016007'), true);
  assert.equal(isValidRecordId('sample-p-bobbin'), true);
  // The map page used to mint these: the server refused them with
  // `Invalid record id`, which is what filled the failed-changes list.
  assert.equal(isValidRecordId('st-19361421-b917-4dc7-b782-3b2b68098e96'), false);
  assert.equal(isValidRecordId('st-a'), false);
  assert.equal(isValidRecordId('id-1762761600000-abc123'), false);
  assert.equal(isValidRecordId(''), false);
  assert.equal(isValidRecordId(null), false);
  assert.equal(isValidRecordId(42), false);
});

test('newRecordId returns a UUID the server accepts', () => {
  for (let index = 0; index < 50; index += 1) {
    const id = newRecordId();
    assert.match(id, UUID_RE);
    assert.equal(isValidRecordId(id), true);
  }
});

test('newRecordId still returns a UUID without crypto.randomUUID (plain HTTP on the LAN)', () => {
  const original = globalThis.crypto;
  const originalRandomUUID = original.randomUUID;
  try {
    Object.defineProperty(original, 'randomUUID', { value: undefined, configurable: true });
    const id = newRecordId();
    assert.match(id, UUID_RE);
    assert.equal(isValidRecordId(id), true);
  } finally {
    Object.defineProperty(original, 'randomUUID', { value: originalRandomUUID, configurable: true });
  }
});

test('the map page mints station ids the server accepts', () => {
  // Regression: the map page used to mint `st-<uuid>` ids, which the server
  // refused with `Invalid record id`; every station added from the map then
  // landed in the failed-changes list instead of syncing.
  for (let index = 0; index < 20; index += 1) {
    const id = newStationId();
    assert.match(id, UUID_RE);
    assert.equal(isValidRecordId(id), true);
  }
});

test('planIdRepairs re-keys a bad record and its queued and failed entries to one UUID', () => {
  const badId = 'st-19361421-b917-4dc7-b782-3b2b68098e96';
  const plan = planIdRepairs({
    records: [{ store: 'floorStations', record: { id: badId, code: 'SN 44', name: 'Fang' } }],
    outbox: [put('op-1', 'floorStations', badId, { code: 'SN 44', name: 'Fang' })],
    failed: [failedPut('op-2', 'floorStations', badId, { code: 'SN 44', name: 'Fang' })],
    makeId: () => '11111111-2222-4333-8444-555555555555',
  });

  assert.equal(plan.changed, 1);
  assert.equal(plan.recordRenames.length, 1);
  assert.equal(plan.recordRenames[0].fromId, badId);
  assert.equal(plan.recordRenames[0].record.id, '11111111-2222-4333-8444-555555555555');
  assert.equal(plan.outbox[0].id, '11111111-2222-4333-8444-555555555555');
  assert.equal(plan.failed[0].id, '11111111-2222-4333-8444-555555555555');
  assert.equal(plan.outbox[0].opId, 'op-1');
  assert.equal(plan.failed[0].opId, 'op-2');
});

test('planIdRepairs gives every bad record its own UUID and leaves valid ones alone', () => {
  const plan = planIdRepairs({
    records: [
      { store: 'floorStations', record: { id: 'st-19361421-b917-4dc7-b782-3b2b68098e96' } },
      { store: 'floorStations', record: { id: 'st-0135427c-b707-4713-944a-65dc3a6de55b' } },
      { store: 'workOrders', record: { id: '583a7141-2b60-4b0d-976e-6244dc016007' } },
    ],
    outbox: [],
    failed: [],
    makeId: (() => {
      let counter = 0;
      return () => `0000000${counter++}-2222-4333-8444-555555555555`;
    })(),
  });

  assert.equal(plan.changed, 2);
  assert.equal(plan.recordRenames.length, 2);
  const ids = plan.recordRenames.map((rename) => rename.record.id);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.equal(isValidRecordId(id), true);
});

test('planIdRepairs drops a delete of a record that never reached the server', () => {
  const badId = 'st-0135427c-b707-4713-944a-65dc3a6de55b';
  const plan = planIdRepairs({
    records: [],
    outbox: [{ opId: 'op-3', kind: 'delete', store: 'floorStations', id: badId, payload: null }],
    failed: [{ opId: 'op-4', kind: 'delete', store: 'floorStations', id: badId, payload: null }],
    makeId: () => '11111111-2222-4333-8444-555555555555',
  });

  assert.deepEqual(plan.outboxDropped, ['op-3']);
  assert.deepEqual(plan.failedDropped, [0]);
  assert.equal(plan.outbox.length, 0);
  assert.equal(plan.failed.length, 0);
});

test('planIdRepairs keeps a stock move id and its payload id in step', () => {
  const plan = planIdRepairs({
    records: [],
    outbox: [
      {
        opId: 'op-5',
        kind: 'stock',
        store: 'parts',
        id: 'id-1762761600000-abc123',
        payload: { id: 'id-1762761600000-abc123', partId: 'p-1', delta: -1, reason: 'job-done' },
      },
    ],
    failed: [],
    makeId: () => '11111111-2222-4333-8444-555555555555',
  });

  assert.equal(plan.outbox[0].id, '11111111-2222-4333-8444-555555555555');
  assert.equal(plan.outbox[0].payload.id, '11111111-2222-4333-8444-555555555555');
  assert.equal(plan.outbox[0].payload.partId, 'p-1');
});

test('planIdRepairs changes nothing when every id is valid', () => {
  const plan = planIdRepairs({
    records: [{ store: 'floorStations', record: { id: '583a7141-2b60-4b0d-976e-6244dc016007' } }],
    outbox: [put('op-6', 'floorStations', '583a7141-2b60-4b0d-976e-6244dc016007', { code: 'SP14' })],
    failed: [],
  });

  assert.equal(plan.changed, 0);
  assert.equal(plan.recordRenames.length, 0);
  assert.equal(plan.outbox.length, 1);
  assert.equal(plan.outbox[0].id, '583a7141-2b60-4b0d-976e-6244dc016007');
});
