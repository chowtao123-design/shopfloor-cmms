// Pure sync helpers for the offline-first client (SPEC-v2.md section 8).
// No DOM, no IndexedDB, no fetch — everything here is unit-tested directly
// in tests/sync.test.js and driven by sync.js.

/**
 * Fields of a local (v1-shaped) record that are metadata: they live in
 * server columns, not in the record `data` payload, or are client-only
 * markers (`pendingSync`).
 */
const LOCAL_META_KEYS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'version',
  'createdBy',
  'updatedBy',
  'pendingSync',
  'deleted',
  'seq',
]);

const BACKOFF_STEPS_MS = [2000, 5000, 15000];
const BACKOFF_MAX_MS = 60000;

/** Outbox entry key used to group writes for the same record. */
export function outboxKey(store, id) {
  return `${store}/${id}`;
}

/**
 * Collapse pending outbox entries for pushing (SPEC-v2.md 8):
 * - several puts to the same store+id become one put with the latest payload
 *   and the earliest baseVersion (entries are processed in order);
 * - a delete after puts collapses to a single delete (earliest baseVersion);
 * - a put after a delete becomes the put (the record is recreated);
 * - stock entries never coalesce — every move is its own entry.
 *
 * Each returned entry carries `mergedFrom`: the opIds of every original entry
 * folded into it, so the caller can drop exactly those rows from the outbox.
 *
 * @param {Array<object>} entries outbox entries in chronological order
 * @returns {Array<object>} coalesced entries, order of first appearance kept
 */
export function coalesceOutbox(entries) {
  const output = [];
  const positionByKey = new Map();
  for (const entry of entries || []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.kind === 'stock') {
      output.push({ ...entry, mergedFrom: [entry.opId] });
      continue;
    }
    const key = outboxKey(entry.store, entry.id);
    const position = positionByKey.get(key);
    if (position === undefined) {
      positionByKey.set(key, output.length);
      output.push({ ...entry, mergedFrom: [entry.opId] });
      continue;
    }
    const merged = output[position];
    merged.mergedFrom.push(entry.opId);
    if (entry.kind === 'delete') {
      // A delete after puts (or after another delete) collapses to one
      // delete; the earlier baseVersion and createdAt stay.
      merged.kind = 'delete';
      merged.payload = null;
    } else {
      // Latest payload wins; baseVersion/createdAt of the earliest entry stay.
      merged.kind = 'put';
      merged.payload = entry.payload;
    }
  }
  return output;
}

/**
 * Map a server record shape
 * `{store, id, data, version, deleted, createdAt, createdBy, updatedAt, updatedBy, seq}`
 * to the local (v1) record shape `{id, ...data, createdAt, updatedAt, version,
 * createdBy, updatedBy}`. The result is a plain editable record; `pendingSync`
 * is absent so it reads as falsy.
 *
 * @param {object} serverRecord
 * @returns {object} local-shaped record
 */
export function toLocalRecord(serverRecord) {
  const data =
    serverRecord && typeof serverRecord.data === 'object' && serverRecord.data !== null
      ? serverRecord.data
      : {};
  return {
    ...data,
    id: serverRecord.id,
    createdAt: serverRecord.createdAt,
    updatedAt: serverRecord.updatedAt,
    createdBy: serverRecord.createdBy,
    updatedBy: serverRecord.updatedBy,
    version: serverRecord.version,
  };
}

/**
 * Extract the data payload to send for a local (v1-shaped) record: every
 * field except the client-side metadata columns.
 *
 * @param {object} record local record
 * @returns {object} payload for the PUT body `data` field
 */
export function toServerData(record) {
  const data = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (!LOCAL_META_KEYS.has(key)) data[key] = value;
  }
  return data;
}

/**
 * Apply one batch of server records to the local working set (SPEC-v2.md 8).
 * Server records win except for keys with pending outbox entries; tombstones
 * remove the local record. Returns the operations to apply to IndexedDB:
 * `{store, action: 'put'|'delete'|'skip', record?, id?}`.
 *
 * @param {Array<object>} localRecords all local records (flat, any store)
 * @param {Array<object>} serverRecords one changes-feed page (server shape)
 * @param {Set|Array<string>} pendingKeys outbox keys `${store}/${id}` that
 *   must not be overwritten by the server yet
 * @returns {Array<object>} operations in feed order
 */
export function applyPull(localRecords, serverRecords, pendingKeys) {
  const localById = new Map();
  for (const record of localRecords || []) {
    if (record && record.id !== undefined) localById.set(record.id, record);
  }
  const pending = new Set(pendingKeys || []);
  const ops = [];
  for (const serverRecord of serverRecords || []) {
    if (!serverRecord || !serverRecord.store || !serverRecord.id) continue;
    const key = outboxKey(serverRecord.store, serverRecord.id);
    if (pending.has(key)) {
      ops.push({ store: serverRecord.store, action: 'skip', id: serverRecord.id });
      continue;
    }
    if (serverRecord.deleted) {
      const existsLocally = localById.has(serverRecord.id);
      ops.push({
        store: serverRecord.store,
        action: existsLocally ? 'delete' : 'skip',
        id: serverRecord.id,
      });
      continue;
    }
    const local = localById.get(serverRecord.id);
    const unchanged =
      local &&
      local.version === serverRecord.version &&
      local.updatedAt === serverRecord.updatedAt;
    if (unchanged) {
      ops.push({ store: serverRecord.store, action: 'skip', id: serverRecord.id });
      continue;
    }
    ops.push({ store: serverRecord.store, action: 'put', record: toLocalRecord(serverRecord) });
  }
  return ops;
}

/**
 * Retry backoff for failed pushes (SPEC-v2.md 8): 2 s, 5 s, 15 s, then 60 s
 * for every later attempt.
 *
 * @param {number} attempt 1-based number of the attempt that just failed
 * @returns {number} milliseconds to wait before the next try
 */
export function backoffDelay(attempt) {
  const number = Number(attempt);
  const index = (Number.isFinite(number) ? Math.max(1, Math.floor(number)) : 1) - 1;
  return index < BACKOFF_STEPS_MS.length ? BACKOFF_STEPS_MS[index] : BACKOFF_MAX_MS;
}

/**
 * Status pill text (SPEC-v2.md 8): never "Synced" while changes are pending.
 *
 * @param {{online?: boolean, pending?: number, needsLogin?: boolean, failed?: number}} status
 * @returns {string} label for the header pill
 */
export function statusText(status = {}) {
  const online = status.online !== false;
  const pending = Math.max(0, Math.floor(Number(status.pending) || 0));
  const failed = Math.max(0, Math.floor(Number(status.failed) || 0));
  if (status.needsLogin) return 'Sign in needed';
  if (pending > 0) {
    return online
      ? `Saving… (${pending})`
      : `Offline – ${pending} change${pending === 1 ? '' : 's'} waiting`;
  }
  if (!online) return 'Offline';
  if (failed > 0) return `${failed} change${failed === 1 ? '' : 's'} failed to sync`;
  return 'Synced';
}