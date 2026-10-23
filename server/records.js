'use strict';

import { can } from './permissions.js';

/**
 * Record validation and write operations for the record stores
 * (SPEC-v2.md sections 5, 7.1, 7.3, 11; SPEC-v3.md sections 2 and 5;
 * SPEC-v4.md section 2 for purchaseRequests and section 4.1 for
 * libraryItems; field rules from SPEC.md section 6).
 *
 * `data` holds the record fields minus id/createdAt/updatedAt, which live in
 * `records` columns. Parts' qtyOnHand is server-owned (SPEC-v2.md 7.3):
 * client PUTs of parts ignore qtyOnHand except on create; quantity changes go
 * through stock moves. WorkOrders.number is server-assigned (SPEC-v3.md 2) and
 * ignored in client data. Contractors' hourlyRate is ruled by the
 * contractorRates permission (SPEC-v3.md 5 and 13): hidden in responses
 * without Read, kept on writes without Write. `user` carries { store,
 * roleId } for can() (see server/permissions.js).
 */

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (message) => new ApiError(400, 'bad_request', message);

export const STORES = [
  'machines',
  'parts',
  'workOrders',
  'pmTasks',
  'coworkers',
  'contractors',
  // v4 (SPEC-v4.md section 2): parts requests, ruled by the `purchasing`
  // permission area like the stores above.
  'purchaseRequests',
  // v4 (SPEC-v4.md section 4.1): the repair library, ruled by `library`.
  'libraryItems',
];

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
// SPEC-v3.md section 2: `normal` is the legacy v1/v2 value; it is accepted and
// stored as `medium` (see the workOrders finalize step below).
const WORK_ORDER_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent', 'normal'];
const WORK_ORDER_CATEGORIES = [
  'mechanical',
  'electrical',
  'pneumatic',
  'facility',
  'safety',
  'cleaning',
  'other',
];
const WORK_ORDER_STATUSES = ['open', 'in-progress', 'waiting-parts', 'waiting-tech', 'done'];
// SPEC-v3.md section 5: assignee/labour person kinds.
const PERSON_KINDS = ['user', 'coworker', 'contractor'];
// SPEC-v3.md section 5: coworker shifts.
const COWORKER_SHIFTS = ['day', 'evening', 'night', 'rotating', 'other'];
// SPEC-v4.md section 2: parts request statuses.
const REQUEST_STATUSES = ['draft', 'sent', 'received', 'cancelled'];
// SPEC-v4.md section 4.1: repair-library kinds and the method-only fields.
const LIBRARY_KINDS = ['manual', 'method'];
const METHOD_ONLY_KEYS = ['symptom', 'cause', 'steps', 'toolsParts', 'safety'];

export const UUID_RE =
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

function expectString(store, key, value, { nonEmpty = false, orNull = false, maxLength } = {}) {
  if (value === null && orNull) return value;
  if (typeof value !== 'string') {
    throw bad(`${store}.${key} must be a string${orNull ? ' or null' : ''}`);
  }
  if (nonEmpty && value.trim() === '') {
    throw bad(`${store}.${key} must not be empty`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw bad(`${store}.${key} must be at most ${maxLength} characters`);
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

function expectNumber(store, key, value, { min } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw bad(`${store}.${key} must be a number`);
  }
  if (min !== undefined && value < min) {
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

/** Reject unknown keys inside one array item object. */
function checkItemKeys(store, where, item, allowedKeys) {
  if (!isPlainObject(item)) throw bad(`${where} must be an object`);
  for (const itemKey of Object.keys(item)) {
    if (!allowedKeys.includes(itemKey)) {
      throw bad(`${where} has an unknown field "${itemKey}"`);
    }
  }
  return item;
}

// SPEC-v3.md section 2: assignees — array of at most 10 {kind, id}.
function expectAssignees(store, key, value) {
  if (!Array.isArray(value)) throw bad(`${store}.${key} must be an array of {kind, id}`);
  if (value.length > 10) throw bad(`${store}.${key} must have at most 10 entries`);
  return value.map((item, index) => {
    const where = `${store}.${key}[${index}]`;
    checkItemKeys(store, where, item, ['kind', 'id']);
    expectEnum(store, `${key}[${index}].kind`, item.kind, PERSON_KINDS);
    expectString(store, `${key}[${index}].id`, item.id, { nonEmpty: true });
    return { kind: item.kind, id: item.id };
  });
}

// SPEC-v3.md section 2: labour — array of at most 200 entries; hours are
// 0.25–24 in steps of 0.25; note is at most 200 characters.
function expectLabour(store, key, value) {
  if (!Array.isArray(value)) throw bad(`${store}.${key} must be an array of labour entries`);
  if (value.length > 200) throw bad(`${store}.${key} must have at most 200 entries`);
  return value.map((item, index) => {
    const where = `${store}.${key}[${index}]`;
    checkItemKeys(store, where, item, ['id', 'kind', 'personId', 'date', 'hours', 'note']);
    expectString(store, `${key}[${index}].id`, item.id, { nonEmpty: true });
    expectEnum(store, `${key}[${index}].kind`, item.kind, PERSON_KINDS);
    expectString(store, `${key}[${index}].personId`, item.personId, { nonEmpty: true });
    expectDate(store, `${key}[${index}].date`, item.date);
    const hours = item.hours;
    if (
      typeof hours !== 'number' ||
      !Number.isFinite(hours) ||
      hours < 0.25 ||
      hours > 24 ||
      !Number.isInteger(hours * 4)
    ) {
      throw bad(`${store}.${key}[${index}].hours must be 0.25–24 in steps of 0.25`);
    }
    const note =
      item.note === undefined
        ? ''
        : expectString(store, `${key}[${index}].note`, item.note, { maxLength: 200 });
    return { id: item.id, kind: item.kind, personId: item.personId, date: item.date, hours, note };
  });
}

// SPEC-v3.md section 2: checklist — array of at most 50 items; text ≤ 200.
function expectChecklist(store, key, value) {
  if (!Array.isArray(value)) throw bad(`${store}.${key} must be an array of checklist items`);
  if (value.length > 50) throw bad(`${store}.${key} must have at most 50 entries`);
  return value.map((item, index) => {
    const where = `${store}.${key}[${index}]`;
    checkItemKeys(store, where, item, ['id', 'text', 'done']);
    expectString(store, `${key}[${index}].id`, item.id, { nonEmpty: true });
    expectString(store, `${key}[${index}].text`, item.text, { nonEmpty: true, maxLength: 200 });
    const done = item.done === undefined ? false : expectBoolean(store, `${key}[${index}].done`, item.done);
    return { id: item.id, text: item.text, done };
  });
}

// SPEC-v3.md section 2 + section 6: attachments — at most 20 references to
// uploaded files {fileId, name, mime, size}.
function expectAttachments(store, key, value) {
  if (!Array.isArray(value)) throw bad(`${store}.${key} must be an array of {fileId, name, mime, size}`);
  if (value.length > 20) throw bad(`${store}.${key} must have at most 20 entries`);
  return value.map((item, index) => {
    const where = `${store}.${key}[${index}]`;
    checkItemKeys(store, where, item, ['fileId', 'name', 'mime', 'size']);
    expectString(store, `${key}[${index}].fileId`, item.fileId, { nonEmpty: true });
    expectString(store, `${key}[${index}].name`, item.name, { nonEmpty: true, maxLength: 200 });
    expectString(store, `${key}[${index}].mime`, item.mime, { nonEmpty: true, maxLength: 100 });
    expectInteger(store, `${key}[${index}].size`, item.size, { min: 0 });
    return { fileId: item.fileId, name: item.name, mime: item.mime, size: item.size };
  });
}

// SPEC-v4.md section 4.1: a bounded string array — at most `maxItems`
// entries, each a non-empty string of at most `itemMax` characters.
function expectBoundedStringArray(store, key, value, { maxItems, itemMax } = {}) {
  const list = expectStringArray(store, key, value);
  if (maxItems !== undefined && list.length > maxItems) {
    throw bad(`${store}.${key} must have at most ${maxItems} entries`);
  }
  if (itemMax !== undefined) {
    for (const [index, item] of list.entries()) {
      if (item.length > itemMax) {
        throw bad(`${store}.${key}[${index}] must be at most ${itemMax} characters`);
      }
    }
  }
  return list;
}

// SPEC-v4.md section 4.1: repair-method steps — at most 60 {id, text 1-1000}.
function expectSteps(store, key, value) {
  if (!Array.isArray(value)) throw bad(`${store}.${key} must be an array of {id, text}`);
  if (value.length > 60) throw bad(`${store}.${key} must have at most 60 entries`);
  return value.map((item, index) => {
    const where = `${store}.${key}[${index}]`;
    checkItemKeys(store, where, item, ['id', 'text']);
    expectString(store, `${key}[${index}].id`, item.id, { nonEmpty: true });
    expectString(store, `${key}[${index}].text`, item.text, { nonEmpty: true, maxLength: 1000 });
    return { id: item.id, text: item.text };
  });
}

// SPEC-v3.md section 4 (V3-M4): a PM task's estimated hours — a number
// 0–1000 in hundredth-hour steps, or null for "no estimate".
function expectEstimatedHours(store, key, value) {
  if (value === null) return value;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1000 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 1e-6
  ) {
    throw bad(`${store}.${key} must be 0–1000 with up to two decimals, or null`);
  }
  return value;
}

/**
 * A number between `min` and `max` with at most `decimals` decimal places
 * (SPEC-v4.md section 2 money and quantity rules). `min` is exclusive when
 * `minExclusive` is set.
 */
function expectDecimal(store, key, value, { min = 0, max = Infinity, minExclusive = false, decimals = 2 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw bad(`${store}.${key} must be a number`);
  }
  if (minExclusive ? value <= min : value < min) {
    throw bad(`${store}.${key} must be ${minExclusive ? 'greater than' : 'at least'} ${min}`);
  }
  if (value > max) {
    throw bad(`${store}.${key} must be at most ${max}`);
  }
  const scale = 10 ** decimals;
  if (Math.abs(value * scale - Math.round(value * scale)) > 1e-6) {
    throw bad(`${store}.${key} must have at most ${decimals} decimals`);
  }
  return value;
}

/** SPEC-v4.md section 2: the HST percent, 0–30 with at most two decimals. */
function expectHstRate(store, key, value) {
  return expectDecimal(store, key, value, { min: 0, max: 30 });
}

/** ISO datetime or null (SPEC-v4.md section 2: sentAt / receivedAt). */
function expectTimestampOrNull(store, key, value) {
  if (value === null) return value;
  if (typeof value !== 'string' || !isISOTimestamp(value)) {
    throw bad(`${store}.${key} must be an ISO datetime or null`);
  }
  return value;
}

/** http/https URL of at most 500 characters (SPEC-v4.md section 2 `link`). */
function expectHttpUrl(store, key, value) {
  expectString(store, key, value, { nonEmpty: true });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw bad(`${store}.${key} must be a valid http/https URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw bad(`${store}.${key} must be an http or https URL`);
  }
  if (value.length > 500) {
    throw bad(`${store}.${key} must be at most 500 characters`);
  }
  return value;
}

// SPEC-v4.md section 2: parts request lines. Totals are computed from the
// lines client-side (logic.js requestTotals) and never stored.
const REQUEST_LINE_KEYS = [
  'id',
  'description',
  'qty',
  'unit',
  'unitPrice',
  'partId',
  'partNumber',
  'supplier',
  'machineId',
  'workOrderId',
  'link',
  'note',
];

/**
 * Validate the `lines` array of a parts request: at most 100 entries, each
 * checked line by line, unknown fields rejected. `description` is required;
 * `unit` defaults to "pcs" and a missing/null `unitPrice` stays null for
 * "price unknown".
 */
function expectRequestLines(store, key, value) {
  if (!Array.isArray(value)) throw bad(`${store}.${key} must be an array of line items`);
  if (value.length > 100) throw bad(`${store}.${key} must have at most 100 entries`);
  return value.map((item, index) => {
    const where = `${store}.${key}[${index}]`;
    checkItemKeys(store, where, item, REQUEST_LINE_KEYS);
    const line = {};
    if (item.id !== undefined) {
      line.id = expectString(store, `${key}[${index}].id`, item.id, { maxLength: 40 });
    }
    line.description = expectString(store, `${key}[${index}].description`, item.description, {
      nonEmpty: true,
      maxLength: 200,
    });
    line.qty = expectDecimal(store, `${key}[${index}].qty`, item.qty, {
      min: 0,
      minExclusive: true,
      max: 100000,
    });
    line.unit =
      item.unit === undefined
        ? 'pcs'
        : expectString(store, `${key}[${index}].unit`, item.unit, { maxLength: 20 });
    line.unitPrice =
      item.unitPrice === undefined || item.unitPrice === null
        ? null
        : expectDecimal(store, `${key}[${index}].unitPrice`, item.unitPrice, { min: 0, max: 1000000 });
    if (item.partId !== undefined) {
      line.partId = expectString(store, `${key}[${index}].partId`, item.partId, { nonEmpty: true });
    }
    if (item.partNumber !== undefined) {
      line.partNumber = expectString(store, `${key}[${index}].partNumber`, item.partNumber, {
        maxLength: 60,
      });
    }
    if (item.supplier !== undefined) {
      line.supplier = expectString(store, `${key}[${index}].supplier`, item.supplier, {
        maxLength: 120,
      });
    }
    if (item.machineId !== undefined) {
      line.machineId = expectString(store, `${key}[${index}].machineId`, item.machineId, {
        nonEmpty: true,
      });
    }
    if (item.workOrderId !== undefined) {
      line.workOrderId = expectString(store, `${key}[${index}].workOrderId`, item.workOrderId, {
        nonEmpty: true,
      });
    }
    if (item.link !== undefined) {
      line.link = expectHttpUrl(store, `${key}[${index}].link`, item.link);
    }
    if (item.note !== undefined) {
      line.note = expectString(store, `${key}[${index}].note`, item.note, { maxLength: 200 });
    }
    return line;
  });
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
      // SPEC-v3.md sections 4 and 6 (V3-M4): machine photos and manuals are
      // stored as one attachments array; images show as photos, PDFs as
      // manuals on the machine detail page.
      attachments: { type: 'attachments' },
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
    // `number` is server-assigned (SPEC-v3.md section 2): it is ignored in
    // incoming data and set on first save, inside the write transaction.
    serverOwned: ['number'],
    fields: {
      title: { type: 'string', nonEmpty: true },
      machineId: { type: 'string', nonEmpty: true },
      kind: { type: 'enum', values: WORK_ORDER_KINDS },
      priority: { type: 'enum', values: WORK_ORDER_PRIORITIES },
      status: { type: 'enum', values: WORK_ORDER_STATUSES },
      category: { type: 'enum', values: WORK_ORDER_CATEGORIES },
      reportedAt: { type: 'date' },
      completedAt: { type: 'date', orNull: true },
      dueDate: { type: 'date', orNull: true },
      requestedBy: { type: 'string', maxLength: 80 },
      problem: { type: 'string' },
      actionTaken: { type: 'string' },
      assignees: { type: 'assignees' },
      labour: { type: 'labour' },
      checklist: { type: 'checklist' },
      partsUsed: { type: 'partsUsed' },
      attachments: { type: 'attachments' },
      minutesSpent: { type: 'int', min: 0 },
      downtimeMinutes: { type: 'int', min: 0 },
      pmTaskId: { type: 'string', orNull: true },
      stockDeducted: { type: 'boolean' },
      photos: { type: 'photos' },
    },
    defaults: () => ({ reportedAt: todayISO(), priority: 'medium' }),
    // Legacy `normal` is read as `medium` (SPEC-v3.md section 2).
    finalize: (data) => {
      if (data.priority === 'normal') data.priority = 'medium';
      return data;
    },
  },
  // SPEC-v3.md section 4 (V3-M4): PM tasks carry the same priority, category,
  // assignees, checklist and attachment fields as work orders, plus
  // estimatedHours. `priority` keeps the workOrders legacy `normal` mapping.
  pmTasks: {
    required: ['title', 'machineId'],
    fields: {
      title: { type: 'string', nonEmpty: true },
      machineId: { type: 'string', nonEmpty: true },
      intervalDays: { type: 'int', min: 1 },
      lastDoneAt: { type: 'date', orNull: true },
      instructions: { type: 'string' },
      active: { type: 'boolean' },
      priority: { type: 'enum', values: WORK_ORDER_PRIORITIES },
      estimatedHours: { type: 'estimatedHours' },
      category: { type: 'enum', values: WORK_ORDER_CATEGORIES },
      assignees: { type: 'assignees' },
      checklist: { type: 'checklist' },
      attachments: { type: 'attachments' },
    },
    defaults: () => ({ active: true, priority: 'medium' }),
    // Legacy `normal` reads as `medium` here too (SPEC-v3.md section 2).
    finalize: (data) => {
      if (data.priority === 'normal') data.priority = 'medium';
      return data;
    },
  },
  // SPEC-v3.md section 5: people stores share the versioning/history rules.
  coworkers: {
    required: ['name'],
    fields: {
      name: { type: 'string', nonEmpty: true, maxLength: 80 },
      role: { type: 'string', maxLength: 60 },
      phone: { type: 'string' },
      email: { type: 'string' },
      shift: { type: 'enum', values: COWORKER_SHIFTS },
      skills: { type: 'string', maxLength: 200 },
      linkedUserId: { type: 'string', orNull: true },
      active: { type: 'boolean' },
      notes: { type: 'string' },
    },
    defaults: () => ({ active: true }),
  },
  contractors: {
    required: ['company'],
    fields: {
      company: { type: 'string', nonEmpty: true, maxLength: 80 },
      trade: { type: 'string', maxLength: 60 },
      contactName: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      // contractorRates permission only (SPEC-v3.md 5, 13.1): see putRecord
      // for the no-write rule.
      hourlyRate: { type: 'number', min: 0 },
      machineIds: { type: 'stringArray' },
      active: { type: 'boolean' },
      notes: { type: 'string' },
    },
    defaults: () => ({ active: true }),
  },
  // SPEC-v4.md section 2: parts requests. `number` is server-assigned on
  // first save (own PR- sequence, see putRecord) and ignored in incoming
  // data; totals are computed (logic.js requestTotals), never stored.
  purchaseRequests: {
    required: ['title'],
    serverOwned: ['number'],
    fields: {
      title: { type: 'string', nonEmpty: true, maxLength: 120 },
      status: { type: 'enum', values: REQUEST_STATUSES },
      supplier: { type: 'string', maxLength: 120 },
      neededBy: { type: 'date', orNull: true },
      requestedBy: { type: 'string', maxLength: 80 },
      hstRate: { type: 'hstRate' },
      notes: { type: 'string', maxLength: 2000 },
      sentAt: { type: 'datetime' },
      receivedAt: { type: 'datetime' },
      lines: { type: 'requestLines' },
    },
    defaults: () => ({ status: 'draft', hstRate: 13, lines: [], sentAt: null, receivedAt: null }),
  },
  // SPEC-v4.md section 4.1: the repair library. Manuals (PDF uploads) and
  // repair methods (symptom -> cause -> steps) linked to a machine type,
  // model numbers and/or specific machines. The method-only fields are
  // rejected for kind "manual" so a manual stays a manual.
  libraryItems: {
    required: ['kind', 'title'],
    fields: {
      kind: { type: 'enum', values: LIBRARY_KINDS },
      title: { type: 'string', nonEmpty: true, maxLength: 160 },
      machineType: { type: 'enumOrNull', values: MACHINE_TYPES },
      models: { type: 'models' },
      machineIds: { type: 'machineIds' },
      tags: { type: 'tags' },
      attachments: { type: 'attachments' },
      notes: { type: 'string', maxLength: 20000 },
      symptom: { type: 'string', maxLength: 1000 },
      cause: { type: 'string', maxLength: 2000 },
      steps: { type: 'steps' },
      toolsParts: { type: 'string', maxLength: 1000 },
      safety: { type: 'string', maxLength: 1000 },
      sourceWorkOrderId: { type: 'string', orNull: true, nonEmpty: true },
    },
    defaults: (data) => ({
      machineType: null,
      models: [],
      machineIds: [],
      tags: [],
      attachments: [],
      ...(data.kind === 'method' ? { steps: [] } : {}),
      sourceWorkOrderId: null,
    }),
    // Method-only fields cannot ride along on a manual (SPEC-v4.md 4.1).
    finalize: (data) => {
      if (data.kind === 'manual') {
        for (const key of METHOD_ONLY_KEYS) {
          if (data[key] !== undefined) {
            throw bad(`libraryItems.${key} is only allowed when kind is "method"`);
          }
        }
      }
      return data;
    },
  },
};

function validateField(store, key, spec, value) {
  switch (spec.type) {
    case 'string':
      return expectString(store, key, value, {
        nonEmpty: spec.nonEmpty === true,
        orNull: spec.orNull === true,
        maxLength: spec.maxLength,
      });
    case 'int':
      return expectInteger(store, key, value, { min: spec.min ?? -Infinity });
    case 'number':
      return expectNumber(store, key, value, { min: spec.min });
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
    case 'assignees':
      return expectAssignees(store, key, value);
    case 'labour':
      return expectLabour(store, key, value);
    case 'checklist':
      return expectChecklist(store, key, value);
    case 'attachments':
      return expectAttachments(store, key, value);
    case 'estimatedHours':
      return expectEstimatedHours(store, key, value);
    case 'hstRate':
      return expectHstRate(store, key, value);
    case 'datetime':
      return expectTimestampOrNull(store, key, value);
    case 'requestLines':
      return expectRequestLines(store, key, value);
    // SPEC-v4.md section 4.1: library fields.
    case 'enumOrNull':
      if (value === null) return value;
      return expectEnum(store, key, value, spec.values);
    case 'models':
      return expectBoundedStringArray(store, key, value, { maxItems: 20, itemMax: 60 });
    case 'machineIds':
      return expectBoundedStringArray(store, key, value, { maxItems: 50 });
    case 'tags':
      return expectBoundedStringArray(store, key, value, { maxItems: 20, itemMax: 40 });
    case 'steps':
      return expectSteps(store, key, value);
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
    if (spec.serverOwned !== undefined && spec.serverOwned.includes(key)) continue;
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
    // `defaults(data)` lets a spec fill kind-dependent defaults (SPEC-v4.md
    // 4.1 libraryItems); the other stores ignore the argument.
    for (const [key, value] of Object.entries(spec.defaults(data))) {
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

// ---------------------------------------------------------------------------
// Contractors' hourlyRate is ruled by the contractorRates permission
// (SPEC-v3.md sections 5 and 13): it is omitted for viewers without Read and
// a PUT without Write keeps the stored value.
// ---------------------------------------------------------------------------

function withoutHourlyRate(data) {
  if (!isPlainObject(data) || !('hourlyRate' in data)) return data;
  const copy = { ...data };
  delete copy.hourlyRate;
  return copy;
}

/** Hide contractors.hourlyRate from a viewer without contractorRates Read. */
export function sanitizeRecordForRole(record, showRates) {
  if (!record || record.store !== 'contractors' || showRates) return record;
  if (record.data === withoutHourlyRate(record.data)) return record;
  return { ...record, data: withoutHourlyRate(record.data) };
}

/** Hide contractors.hourlyRate from a viewer without contractorRates Read. */
export function sanitizeHistoryForRole(entry, showRates) {
  if (!entry || entry.store !== 'contractors' || showRates) return entry;
  const before = withoutHourlyRate(entry.before);
  const after = withoutHourlyRate(entry.after);
  if (before === entry.before && after === entry.after) return entry;
  return { ...entry, before, after };
}

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
 * `note` (optional) is written on the history row; the AI apply path uses it
 * to record who approved the change.
 * @returns {{record: object, conflict: null | object}}
 */
export function putRecord(store, { storeName, id, body, user, note = null }) {
  checkStoreAndId(storeName, id);
  if (!isPlainObject(body)) throw bad('Request body must be a JSON object');
  for (const key of Object.keys(body)) {
    if (!BODY_KEYS.has(key)) throw bad(`Unknown body field "${key}"`);
  }
  const baseVersion = checkBaseVersion(body.baseVersion);
  const current = store.getRecord(storeName, id);
  const isCreate = current === null;
  // Only contractorRates Write may edit contractors.hourlyRate (SPEC-v3.md
  // 13.1): a PUT without it that includes a rate keeps the stored value.
  const noRateWrite = storeName === 'contractors' && !can(user, 'contractorRates', 'write');
  let rawData = body.data;
  if (noRateWrite && isPlainObject(rawData) && rawData.hourlyRate !== undefined) {
    rawData = { ...rawData };
    delete rawData.hourlyRate;
  }
  const data = validateRecordData(storeName, rawData, { isCreate });
  if (storeName === 'parts' && !isCreate) {
    // qtyOnHand is server-owned: keep the stored quantity on updates.
    const currentData = JSON.parse(current.data);
    delete data.qtyOnHand;
    data.qtyOnHand = Number.isInteger(currentData.qtyOnHand) ? currentData.qtyOnHand : 0;
  }
  if (noRateWrite && !isCreate) {
    const currentData = JSON.parse(current.data);
    if (currentData.hourlyRate !== undefined) data.hourlyRate = currentData.hourlyRate;
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
    if (storeName === 'workOrders') {
      // Sequential server-assigned number on first save (SPEC-v3.md section
      // 2): assigned inside the same transaction as the write, kept afterwards.
      // Records saved before v3 (no stored number) get one on their next save.
      const prior = isCreate ? null : JSON.parse(current.data);
      if (prior === null || prior.number === undefined) {
        data.number = store.nextWorkOrderNumber();
      } else {
        data.number = prior.number;
      }
    }
    if (storeName === 'purchaseRequests') {
      // Same pattern, own PR- sequence (SPEC-v4.md section 2): assigned on
      // first save inside the write transaction, kept on every later save.
      const prior = isCreate ? null : JSON.parse(current.data);
      if (prior === null || prior.number === undefined) {
        data.number = store.nextPurchaseRequestNumber();
      } else {
        data.number = prior.number;
      }
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
      note: [note, conflict ? conflictNote(conflict) : null].filter(Boolean).join('; ') || null,
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
  // v1 backups (schemaVersion 1) predate the v3 people stores: machines,
  // parts, workOrders and pmTasks are required lists, coworkers/contractors
  // are imported when present and must be arrays then.
  const importStores = [
    ['machines', true],
    ['parts', true],
    ['workOrders', true],
    ['pmTasks', true],
    ['coworkers', false],
    ['contractors', false],
  ];
  for (const [storeName, required] of importStores) {
    const list = payload[storeName];
    if (!Array.isArray(list)) {
      if (required) throw bad(`The backup is missing a valid "${storeName}" list.`);
      continue;
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
      // Imported service orders get their sequential number here too.
      if (item.storeName === 'workOrders') item.data.number = store.nextWorkOrderNumber();
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