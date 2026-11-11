// Record id rules, shared by every client page (SPEC-v2.md 7.1).
//
// The server accepts a record id only when it is a UUID or a seed-style
// `sample-*` id; anything else is refused with `Invalid record id`. The
// client must therefore never mint an id outside that set, and a client that
// did has to repair its local ids before those changes can sync again.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAMPLE_ID_RE = /^sample-[A-Za-z0-9._-]+$/;

/** True when the server would accept this id (mirrors server/records.js). */
export function isValidRecordId(id) {
  return typeof id === 'string' && (UUID_RE.test(id) || SAMPLE_ID_RE.test(id));
}

/**
 * A fresh record id: a v4 UUID.
 *
 * `crypto.randomUUID` only exists in secure contexts and the app is also
 * served over plain HTTP on the LAN, so the fallback builds the same UUID
 * shape from `getRandomValues` (available in every context). Both forms are
 * accepted by the server; the old `id-<time>-<rand>` fallback was not.
 */
export function newRecordId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function idKey(store, id) {
  return `${store}/${id}`;
}

/**
 * Plan the repair of local ids the server would reject.
 *
 * A change whose record id is invalid never reached the server, so the id
 * can simply be replaced: the local record, its queued outbox entries and
 * its failed-list entries are re-keyed to one fresh UUID each, and the
 * changes can be pushed again afterwards. A delete of a record that never
 * reached the server has nothing to delete, so it is dropped instead.
 *
 * @param {object} input
 * @param {Array<{store: string, record: object}>} input.records local records
 * @param {Array<object>} input.outbox queued outbox entries
 * @param {Array<object>} input.failed failed-list entries
 * @param {() => string} [input.makeId] id factory (tests)
 * @returns {{
 *   recordRenames: Array<{store: string, fromId: string, toId: string, record: object}>,
 *   outbox: Array<object>,
 *   outboxDropped: Array<string>,
 *   failed: Array<object>,
 *   failedDropped: Array<number>,
 *   changed: number,
 * }}
 */
export function planIdRepairs({
  records = [],
  outbox = [],
  failed = [],
  makeId = newRecordId,
} = {}) {
  const renames = new Map();
  const recordRenames = [];
  const renameFor = (store, id) => {
    const key = idKey(store, id);
    if (!renames.has(key)) renames.set(key, makeId());
    return renames.get(key);
  };

  for (const item of records) {
    if (!item || !item.store || !item.record) continue;
    const record = item.record;
    if (isValidRecordId(record.id)) continue;
    const toId = renameFor(item.store, record.id);
    recordRenames.push({
      store: item.store,
      fromId: record.id,
      toId,
      record: { ...record, id: toId },
    });
  }

  const outboxDropped = [];
  const nextOutbox = [];
  for (const entry of outbox) {
    if (!entry || isValidRecordId(entry.id)) {
      if (entry) nextOutbox.push(entry);
      continue;
    }
    if (entry.kind === 'delete') {
      // The record never reached the server, so there is nothing to delete.
      outboxDropped.push(entry.opId);
      continue;
    }
    const toId = renames.get(idKey(entry.store, entry.id)) || renameFor(entry.store, entry.id);
    nextOutbox.push(
      entry.kind === 'stock' && entry.payload && typeof entry.payload === 'object'
        ? { ...entry, id: toId, payload: { ...entry.payload, id: toId } }
        : { ...entry, id: toId },
    );
  }

  const failedDropped = [];
  const nextFailed = [];
  failed.forEach((entry, index) => {
    if (!entry || isValidRecordId(entry.id)) {
      if (entry) nextFailed.push(entry);
      return;
    }
    if (entry.kind === 'delete') {
      failedDropped.push(index);
      return;
    }
    const toId = renames.get(idKey(entry.store, entry.id)) || renameFor(entry.store, entry.id);
    nextFailed.push({ ...entry, id: toId });
  });

  return {
    recordRenames,
    outbox: nextOutbox,
    outboxDropped,
    failed: nextFailed,
    failedDropped,
    changed: renames.size,
  };
}
