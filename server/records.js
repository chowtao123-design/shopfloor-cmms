'use strict';

/**
 * Record validation and write operations for the four record stores
 * (SPEC-v2.md sections 5, 7.1, 7.3, 11; field rules from SPEC.md section 6).
 *
 * `data` holds the v1 record fields minus id/createdAt/updatedAt, which live
 * in `records` columns. Parts' qtyOnHand is server-owned (SPEC-v2.md 7.3):
 * client PUTs of parts ignore qtyOnHand except on create; quantity changes go
 * through stock moves.
 */

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (message) => new ApiError(400, 'bad_request', message);

export const STORES = ['machines', 'parts', 'workOrders', 'pmTasks'];

export const STOCK_REASONS = ['job-done', 'job-reopened', 'manual', 'import'];

/** v1 fields that live in `records` columns and are ignored inside `data`. */
const EXCLUDED_KEYS = new Set(['id', 'createdAt', 'updatedAt']);

// SPEC-v2.md 15.1: garment machine types; `sewing` is a legacy value kept for
// v1 records and imports. 15.2: `typeLabel` (custom type) rules. 15.3 adds
// the `in-storage` machine status.
const MACHINE_TYPES = [
  'single-needle',
  'double-needle',
  'binder',
  'bartack',
  'buttonhole',
  'button-sew',
  'snap-attach',
  'overlock-5',
  'overlock-4',
  'overlock-3',
  'coverstitch',
  'flatlock',
  'blindstitch',
  'feed-off-arm',
  'zigzag',
  'quilting',
  'down-filling',
  'cutter',
  'pressing',
  'building',
  'other',
  'sewing',
];
const MACHINE_STATUSES = ['running', 'down', 'in-storage', 'retired'];
const WORK_ORDER_KINDS = ['breakdown', 'pm', 'facility', 'install', 'other'];
const WORK_ORDER_PRIORITIES = ['low', 'normal', 'urgent'];
const WORK_ORDER_STATUSES = ['open', 'in-progress', 'waiting-parts', 'waiting-tech', 'done'];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAMPLE_ID_RE = /^sample-[A-Za-z0-9._-]+$/;

/** Record ids are UUIDs or seed-style `sample-*` ids (SPEC-v2.md 7.1). */
export function isValidRecordId(id) {
  return typeof id === 'string' && (UUID_RE.test(id) || SAMPLE_ID_RE.test(id));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function todayISO(now = new Date()) {
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
}

/** `YYYY-MM-DD` naming a real calendar date (v1 date fields use this form). */
function isISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Full ISO timestamp such as `2026-10-20T12:00:00.000Z`. */
function isISOTimestamp(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function isISODateOrTimestamp(value) {
  return isISODate(value) || isISOTimestamp(value);
}

function expectString(store, key, value, { nonEmpty = false, orNull = false } = {}) {
  if (value === null && orNull) return value;
  if (typeof value !== 'string') {
    throw bad(`${store}.${key} must be a string${orNull ? ' or null' : ''}`);
  }
  if (nonEmpty && value.trim() === '') {
    throw bad(`${store}.${key} must not be empty`);
  }
  return value;
}

function expectInteger(store, key, value, { min = -Infinity } = {}) {
  if (!Number.isInteger(value)) {
    throw bad(`${store}.${key} must be an integer`);
  }
  if (value < min) {
    throw bad(`${store}.${key} must be >= ${min}`);
  }
  return value;
}

function expectBoolean(store, key, value) {
  if (typeof value !== 'boolean') throw bad(`${store}.${key} must be a boolean`);
  return value;
}

function expectEnum(store, key, value, values) {
  if (!values.includes(value)) {
    throw bad(
      `${store}.${key} must be one of ${values.join(', ')}; got ${JSON.stringify(String(value))}`
    );
  }
  return value;
}

function expectDate(store, key, value, { orNull = false } = {}) {
  if (value === null && orNull) return value;
  if (!isISODateOrTimestamp(value)) {
    throw bad(
      `${store}.${key} must be an ISO date (YYYY-MM-DD) or ISO timestamp${
        orNull ? ' or null' : ''
      }`
    );
  }
  return value;
}

function expectStringArray(store, key, value) {
  if (!Array.isArray(value)) throw bad(`${store}.${key} must be an array of strings`);
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw bad(`${store}.${key} must contain only non-empty strings`);
    }
  }
  return value;
}

function expectPartsUsed(store, key, value) {
  if (!Array.isArray(value)) throw bad(`${store}.${key} must be an array of {partId, qty}`);
  for (const [index, item] of value.entries()) {
    const where = `${store}.${key}[${index}]`;
    if (!isPlainObject(item)) throw bad(`${where} must be an object with partId and qty`);
    for (const itemKey of Object.keys(item)) {
      if (itemKey !== 'partId' && itemKey !== 'qty') {
        throw bad(`${where} has an unknown field "${itemKey}"`);
      }
    }
    expectString(store, `${key}[${index}].partId`, item.partId, { nonEmpty: true });
    expectInteger(store, `${key}[${index}].qty`, item.qty, { min: 0 });
  }
  return value;
}

/**
 * Field specs per SPEC.md section 6. `required` fields must be present;
 * `defaults()` fills spec-noted defaults on create only.
 */
const FIELD_SPECS = {
  machines: {
    required: ['name'],
    fields: {
      name: { type: 'string', nonEmpty: true },
      type: { type: 'enum', values: MACHINE_TYPES },
      typeLabel: { type: 'string' },
      model: { type: 'string' },
      serial: { type: 'string' },
      location: { type: 'string' },
      status: { type: 'enum', values: MACHINE_STATUSES },
      notes: { type: 'string' },
    },
    defaults: () => ({}),
    // SPEC-v2.md 15.2: typeLabel is required (trimmed, 2–40 chars) when
    // type is 'other' and must be stripped for every other type.
    finalize: (data) => {
      const label = typeof data.typeLabel === 'string' ? data.typeLabel.trim() : '';
      if (data.type === 'other') {
        if (label === '') {
          throw bad('machines.typeLabel is required when type is "other"');
        }
        if (label.length < 2 || label.length > 40) {
          throw bad('machines.typeLabel must be 2–40 characters');
        }
        data.typeLabel = label;
      } else {
        delete data.typeLabel;
      }
      return data;
    },
  },
  parts: {
    required: ['name'],
    fields: {
      name: { type: 'string', nonEmpty: true },
      partNumber: { type: 'string' },
      qtyOnHand: { type: 'int', min: 0 },
      minQty: { type: 'int', min: 0 },
      unit: { type: 'string' },
      location: { type: 'string' },
      supplier: { type: 'string' },
      supplierContact: { type: 'string' },
      machineIds: { type: 'stringArray' },
      notes: { type: 'string' },
    },
    defaults: () => ({ qtyOnHand: 0, minQty: 0, unit: 'pcs' }),
  },
  workOrders: {
    required: ['title', 'machineId'],
    fields: {
      title: { type: 'string', nonEmpty: true },
      machineId: { type: 'string', nonEmpty: true },
      kind: { type: 'enum', values: WORK_ORDER_KINDS },
      priority: { type: 'enum', values: WORK_ORDER_PRIORITIES },
      status: { type: 'enum', values: WORK_ORDER_STATUSES },
      reportedAt: { type: 'date' },
      completedAt: { type: 'date', orNull: true },
      problem: { type: 'string' },
      actionTaken: { type: 'string' },
      partsUsed: { type: 'partsUsed' },
      minutesSpent: { type: 'int', min: 0 },
      downtimeMinutes: { type: 'int', min: 0 },
      pmTaskId: { type: 'string', orNull: true },
      stockDeducted: { type: 'boolean' },
      photos: { type: 'photos' },
    },
    defaults: () => ({ reportedAt: todayISO() }),
  },
  pmTasks: {
    required: ['title', 'machineId'],
    fields: {
      title: { type: 'string', nonEmpty: true },
      machineId: { type: 'string', nonEmpty: true },
      intervalDays: { type: 'int', min: 1 },
      lastDoneAt: { type: 'date', orNull: true },
      instructions: { type: 'string' },
      active: { type: 'boolean' },
    },
    defaults: () => ({ active: true }),
  },
};

function validateField(store, key, spec, value) {
  switch (spec.type) {
    case 'string':
      return expectString(store, key, value, { nonEmpty: spec.nonEmpty === true });
    case 'int':
      return expectInteger(store, key, value, { min: spec.min ?? -Infinity });
    case 'boolean':
      return expectBoolean(store, key, value);
    case 'enum':
      return expectEnum(store, key, value, spec.values);
    case 'date':
      return expectDate(store, key, value, { orNull: spec.orNull === true });
    case 'stringArray':
      return expectStringArray(store, key, value);
    case 'partsUsed':
      return expectPartsUsed(store, key, value);
    case 'photos': {
      if (!Array.isArray(value)) throw bad(`${store}.${key} must be an array (reserved)`);
      return value;
    }
    default:
      throw new Error(`unhandled field spec type "${spec.type}"`);
  }
}

/**
 * Validate a record's v1 fields (SPEC.md section 6) for one store.
 * Unknown stores and unknown fields are rejected with 400. `id`, `createdAt`
 * and `updatedAt` inside `data` are ignored (they live in `records` columns).
 * @param {string} storeName one of STORES
 * @param {object} raw the incoming `data` object
 * @param {{isCreate?: boolean, part?: string}} [options]
 * @returns {object} normalized data object (known fields only)
 */
export function validateRecordData(storeName, raw, { isCreate = true, part = 'record' } = {}) {
  if (!STORES.includes(storeName)) {
    throw bad(`Unknown store "${storeName}"; expected one of ${STORES.join(', ')}`);
  }
  if (!isPlainObject(raw)) {
    throw bad(`${part} data must be a JSON object`);
  }
  const spec = FIELD_SPECS[storeName];
  const data = {};
  for (const [key, value] of Object.entries(raw)) {
    if (EXCLUDED_KEYS.has(key)) continue;
    const fieldSpec = spec.fields[key];
    if (fieldSpec === undefined) {
      throw bad(`Unknown field "${key}" for store "${storeName}"`);
    }
    data[key] = validateField(storeName, key, fieldSpec, value);
  }
  for (const key of spec.required) {
    if (data[key] === undefined) {
      throw bad(`"${key}" is required for store "${storeName}"`);
    }
  }
  if (spec.finalize) spec.finalize(data);
  if (isCreate) {
    for (const [key, value] of Object.entries(spec.defaults())) {
      if (data[key] === undefined) data[key] = value;
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Write operations (SPEC-v2.md sections 7.1, 7.3, 11)
// ---------------------------------------------------------------------------

const BODY_KEYS = new Set(['data', 'baseVersion', 'clientId', 'clientTime']);

function checkStoreAndId(storeName, id) {
  if (!STORES.includes(storeName)) {
    throw bad(`Unknown store "${storeName}"; expected one of ${STORES.join(', ')}`);
  }
  if (!isValidRecordId(id)) {
    throw bad(`Invalid record id "${String(id)}"; expected a UUID or sample-* id`);
  }
}

/** baseVersion must be a positive integer or null/absent (SPEC-v2.md 7.1). */
function checkBaseVersion(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw bad('baseVersion must be a positive integer or null');
  }
  return value;
}

function conflictFor(current, baseVersion, store) {
  if (baseVersion === null || baseVersion === Number(current.version)) return null;
  const name = store.displayName(current.updated_by) ?? 'unknown user';
  return {
    overwrittenVersion: Number(current.version),
    overwrittenBy: name,
    overwrittenAt: current.updated_at,
  };
}

const conflictNote = (conflict) =>
  `overwrote v${conflict.overwrittenVersion} by ${conflict.overwrittenBy} at ${conflict.overwrittenAt}`;

function recordJson(
  storeName,
  id,
  data,
  version,
  deleted,
  createdAt,
  createdBy,
  updatedAt,
  updatedBy,
  seq
) {
  return {
    store: storeName,
    id,
    data,
    version,
    deleted,
    createdAt,
    createdBy,
    updatedAt,
    updatedBy,
    seq,
  };
}

/**
 * PUT /api/records/:store/:id — create or update, last save wins
 * (SPEC-v2.md 7.1). `updated_by`/`created_by` always come from the session
 * user. Parts updates ignore incoming qtyOnHand (server-owned, 7.3).
 * @returns {{record: object, conflict: null | object}}
 */
export function putRecord(store, { storeName, id, body, user }) {
  checkStoreAndId(storeName, id);
  if (!isPlainObject(body)) throw bad('Request body must be a JSON object');
  for (const key of Object.keys(body)) {
    if (!BODY_KEYS.has(key)) throw bad(`Unknown body field "${key}"`);
  }
  const baseVersion = checkBaseVersion(body.baseVersion);
  const current = store.getRecord(storeName, id);
  const isCreate = current === null;
  const data = validateRecordData(storeName, body.data, { isCreate });
  if (storeName === 'parts' && !isCreate) {
    // qtyOnHand is server-owned: keep the stored quantity on updates.
    const currentData = JSON.parse(current.data);
    delete data.qtyOnHand;
    data.qtyOnHand = Number.isInteger(currentData.qtyOnHand) ? currentData.qtyOnHand : 0;
  }

  return store.transaction(() => {
    const now = new Date().toISOString();
    const seq = store.nextSeq();
    let action;
    let version;
    let createdAt;
    let createdBy;
    let before = null;
    let conflict = null;
    if (isCreate) {
      action = 'create';
      version = 1;
      createdAt = now;
      createdBy = user.id;
    } else {
      version = Number(current.version) + 1;
      createdAt = current.created_at;
      createdBy = current.created_by;
      before = current.data;
      action = Number(current.deleted) === 1 ? 'restore' : 'update';
      conflict = conflictFor(current, baseVersion, store);
    }
    const dataJson = JSON.stringify(data);
    store.upsertRecord({
      store: storeName,
      id,
      data: dataJson,
      version,
      deleted: 0,
      createdAt,
      createdBy,
      updatedAt: now,
      updatedBy: user.id,
      seq,
    });
    store.insertHistory({
      store: storeName,
      recordId: id,
      version,
      action,
      userId: user.id,
      at: now,
      before,
      after: dataJson,
      conflict: conflict ? 1 : 0,
      note: conflict ? conflictNote(conflict) : null,
    });
    return {
      record: recordJson(
        storeName,
        id,
        data,
        version,
        false,
        createdAt,
        createdBy,
        now,
        user.id,
        seq
      ),
      conflict,
    };
  });
}

/**
 * DELETE /api/records/:store/:id — soft delete (tombstone), same conflict
 * rule as updates (SPEC-v2.md 7.1). Deleting an existing tombstone is a
 * no-op that returns it unchanged.
 * @returns {{record: object, conflict: null | object}}
 */
export function deleteRecord(store, { storeName, id, baseVersion, user }) {
  checkStoreAndId(storeName, id);
  const bv = checkBaseVersion(baseVersion);
  const current = store.getRecord(storeName, id);
  if (current === null) {
    throw new ApiError(404, 'not_found', `No such record in "${storeName}"`);
  }
  if (Number(current.deleted) === 1) {
    return {
      record: recordJson(
        storeName,
        id,
        JSON.parse(current.data),
        Number(current.version),
        true,
        current.created_at,
        current.created_by,
        current.updated_at,
        current.updated_by,
        Number(current.seq)
      ),
      conflict: null,
    };
  }

  return store.transaction(() => {
    const now = new Date().toISOString();
    const seq = store.nextSeq();
    const version = Number(current.version) + 1;
    const conflict = conflictFor(current, bv, store);
    store.upsertRecord({
      store: storeName,
      id,
      data: current.data,
      version,
      deleted: 1,
      createdAt: current.created_at,
      createdBy: current.created_by,
      updatedAt: now,
      updatedBy: user.id,
      seq,
    });
    store.insertHistory({
      store: storeName,
      recordId: id,
      version,
      action: 'delete',
      userId: user.id,
      at: now,
      before: current.data,
      after: null,
      conflict: conflict ? 1 : 0,
      note: conflict ? conflictNote(conflict) : null,
    });
    return {
      record: recordJson(
        storeName,
        id,
        JSON.parse(current.data),
        version,
        true,
        current.created_at,
        current.created_by,
        now,
        user.id,
        seq
      ),
      conflict,
    };
  });
}

/**
 * POST /api/stock-moves — batch of quantity deltas (SPEC-v2.md 7.3).
 * Idempotent by move id (repeats are ignored and reported as `duplicate`),
 * results clamp at 0 with a note in history, part version/seq bump and a
 * `stock` history entry is written. Returns the updated parts.
 * @returns {{parts: object[], moves: object[]}}
 */
export function applyStockMoves(store, { moves, user }) {
  if (!Array.isArray(moves)) throw bad('moves must be an array of stock moves');
  const normalized = moves.map((move, index) => {
    const where = `moves[${index}]`;
    if (!isPlainObject(move)) throw bad(`${where} must be an object`);
    for (const key of Object.keys(move)) {
      if (!['id', 'partId', 'delta', 'reason', 'workOrderId'].includes(key)) {
        throw bad(`${where} has an unknown field "${key}"`);
      }
    }
    expectString('moves', `${index}.id`, move.id, { nonEmpty: true });
    expectString('moves', `${index}.partId`, move.partId, { nonEmpty: true });
    if (!Number.isInteger(move.delta) || move.delta === 0) {
      throw bad(`${where}.delta must be a non-zero integer`);
    }
    expectEnum('moves', `${index}.reason`, move.reason, STOCK_REASONS);
    let workOrderId = null;
    if (move.workOrderId !== undefined && move.workOrderId !== null) {
      workOrderId = expectString('moves', `${index}.workOrderId`, move.workOrderId, {
        nonEmpty: true,
      });
    }
    return { id: move.id, partId: move.partId, delta: move.delta, reason: move.reason, workOrderId };
  });

  return store.transaction(() => {
    const results = [];
    const parts = new Map();
    for (const move of normalized) {
      if (store.getStockMove(move.id) !== null) {
        results.push({ id: move.id, applied: false, duplicate: true });
        continue;
      }
      const part = store.getRecord('parts', move.partId);
      if (part === null || Number(part.deleted) === 1) {
        throw bad(`moves: unknown part "${move.partId}" for move "${move.id}"`);
      }
      const partData = JSON.parse(part.data);
      const rawQty = Number(partData.qtyOnHand) + move.delta;
      const clamped = rawQty < 0;
      partData.qtyOnHand = clamped ? 0 : rawQty;
      const now = new Date().toISOString();
      const seq = store.nextSeq();
      const version = Number(part.version) + 1;
      const after = JSON.stringify(partData);
      const note =
        `stock ${move.delta >= 0 ? '+' : ''}${move.delta} (${move.reason})` +
        (clamped ? `; clamped at 0 (would be ${rawQty})` : '');
      store.upsertRecord({
        store: 'parts',
        id: part.id,
        data: after,
        version,
        deleted: 0,
        createdAt: part.created_at,
        createdBy: part.created_by,
        updatedAt: now,
        updatedBy: user.id,
        seq,
      });
      store.insertHistory({
        store: 'parts',
        recordId: part.id,
        version,
        action: 'stock',
        userId: user.id,
        at: now,
        before: part.data,
        after,
        conflict: 0,
        note,
      });
      store.insertStockMove({
        id: move.id,
        partId: part.id,
        delta: move.delta,
        reason: move.reason,
        workOrderId: move.workOrderId,
        userId: user.id,
        at: now,
      });
      results.push({
        id: move.id,
        applied: true,
        duplicate: false,
        clamped,
        qtyOnHand: partData.qtyOnHand,
      });
      parts.set(
        part.id,
        recordJson(
          'parts',
          part.id,
          partData,
          version,
          false,
          part.created_at,
          part.created_by,
          now,
          user.id,
          seq
        )
      );
    }
    return { parts: [...parts.values()], moves: results };
  });
}

/**
 * POST /api/import-v1 — import a v1 JSON backup (SPEC-v2.md section 11).
 * Records keep their ids; existing ids are skipped. Imported records get
 * created_by/updated_by = the importing user, history action `create` with
 * note "imported from v1"; parts also get one `stock` history entry with
 * reason `import`. Either the whole import applies or nothing does.
 * @returns {{created: number, skipped: number}}
 */
export function importV1(store, payload, user) {
  if (!isPlainObject(payload)) throw bad('The v1 backup must be a JSON object');
  if (payload.schemaVersion !== 1) {
    throw bad(
      `Unsupported backup schema version ${JSON.stringify(
        String(payload.schemaVersion)
      )}; expected 1`
    );
  }
  const incoming = [];
  for (const storeName of STORES) {
    const list = payload[storeName];
    if (!Array.isArray(list)) {
      throw bad(`The backup is missing a valid "${storeName}" list.`);
    }
    for (const [index, record] of list.entries()) {
      if (!isPlainObject(record)) throw bad(`${storeName}[${index}] must be an object`);
      if (!isValidRecordId(record.id)) {
        throw bad(`${storeName}[${index}].id "${String(record.id)}" is not a valid id`);
      }
      const data = validateRecordData(storeName, record, {
        isCreate: true,
        part: `${storeName}[${index}]`,
      });
      incoming.push({
        storeName,
        id: record.id,
        data,
        createdAt: isISOTimestamp(record.createdAt) ? record.createdAt : null,
      });
    }
  }

  let created = 0;
  let skipped = 0;
  store.transaction(() => {
    const now = new Date().toISOString();
    for (const item of incoming) {
      if (store.getRecord(item.storeName, item.id) !== null) {
        skipped += 1;
        continue;
      }
      created += 1;
      const seq = store.nextSeq();
      const createdAt = item.createdAt === null ? now : item.createdAt;
      const dataJson = JSON.stringify(item.data);
      store.upsertRecord({
        store: item.storeName,
        id: item.id,
        data: dataJson,
        version: 1,
        deleted: 0,
        createdAt,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
        seq,
      });
      store.insertHistory({
        store: item.storeName,
        recordId: item.id,
        version: 1,
        action: 'create',
        userId: user.id,
        at: now,
        before: null,
        after: dataJson,
        conflict: 0,
        note: 'imported from v1',
      });
      if (item.storeName === 'parts') {
        const qty = Number(item.data.qtyOnHand) || 0;
        store.insertHistory({
          store: 'parts',
          recordId: item.id,
          version: 1,
          action: 'stock',
          userId: user.id,
          at: now,
          before: null,
          after: dataJson,
          conflict: 0,
          note: `stock ${qty >= 0 ? '+' : ''}${qty} (import)`,
        });
      }
    }
  });
  return { created, skipped };
}