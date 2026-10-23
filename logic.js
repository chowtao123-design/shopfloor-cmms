export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Machine types (SPEC-v2.md 15.1): garment-specific groups used by the form's
 * <select> with <optgroup>. `sewing` is a legacy stored value that is offered
 * only when the edited machine already has it; it is not in any group.
 */
export const MACHINE_TYPE_GROUPS = [
  {
    group: 'Sewing machines',
    options: [
      ['single-needle', 'Single needle lockstitch'],
      ['double-needle', 'Double needle'],
      ['binder', 'Binder'],
      ['bartack', 'Bartack'],
      ['buttonhole', 'Buttonhole'],
      ['button-sew', 'Button sew'],
      ['snap-attach', 'Snap / button attach'],
      ['overlock-5', '5-thread overlock (safety stitch)'],
      ['overlock-4', '4-thread overlock'],
      ['overlock-3', '3-thread overlock'],
      ['coverstitch', 'Coverstitch'],
      ['flatlock', 'Flatlock'],
      ['blindstitch', 'Blind stitch'],
      ['feed-off-arm', 'Feed-off-arm'],
      ['zigzag', 'Zigzag'],
    ],
  },
  {
    group: 'Production equipment',
    options: [
      ['quilting', 'Automated quilting'],
      ['down-filling', 'Down filling'],
      ['cutter', 'Cutter (Gerber)'],
      ['pressing', 'Pressing / fusing'],
    ],
  },
  {
    group: 'Facility',
    options: [['building', 'Building item (drains, gutters, lighting)']],
  },
  {
    group: 'Other',
    options: [['other', 'Other (type your own)']],
  },
];

/** All storable machine type values, including the legacy `sewing`. */
export const MACHINE_TYPES = [
  ...MACHINE_TYPE_GROUPS.flatMap((entry) => entry.options.map(([value]) => value)),
  'sewing',
];

/** Default type for a new machine (SPEC-v2.md 15.1). */
export const DEFAULT_MACHINE_TYPE = 'single-needle';

export const MACHINE_STATUSES = ['running', 'down', 'in-storage', 'retired'];
export const WORK_ORDER_KINDS = ['breakdown', 'pm', 'facility', 'install', 'other'];
// SPEC-v3.md section 2: the new priority enum. The legacy value `normal` is
// not offered any more but stays readable (server stores it as `medium`).
export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
export const WORK_ORDER_STATUSES = ['open', 'in-progress', 'waiting-parts', 'waiting-tech', 'done'];
// SPEC-v3.md section 2: service order categories.
export const WORK_ORDER_CATEGORIES = [
  'mechanical',
  'electrical',
  'pneumatic',
  'facility',
  'safety',
  'cleaning',
  'other',
];
// SPEC-v3.md section 3 item 2: due filters for the service order list.
export const SO_DUE_FILTERS = ['overdue', 'this-week', 'none'];
export const PM_STATES = ['overdue', 'due-soon', 'ok'];
// SPEC-v3.md section 5: coworker shifts.
export const COWORKER_SHIFTS = ['day', 'evening', 'night', 'rotating', 'other'];

/** Map a stored priority to its current value; legacy `normal` reads as `medium`. */
export function priorityValue(priority) {
  return priority === 'normal' ? 'medium' : priority;
}

export const LABELS = {
  machineType: Object.fromEntries([
    ...MACHINE_TYPE_GROUPS.flatMap((entry) => entry.options),
    ['sewing', 'Sewing (general)'],
  ]),
  machineStatus: {
    running: 'Running',
    down: 'Down',
    'in-storage': 'In storage',
    retired: 'Retired',
  },
  kind: {
    breakdown: 'Breakdown',
    pm: 'PM',
    facility: 'Facility',
    install: 'Install',
    other: 'Other',
  },
  priority: {
    none: 'None',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    urgent: 'Urgent',
    // Legacy v1/v2 value; the server stores it as `medium` (SPEC-v3.md 2).
    normal: 'Medium',
  },
  status: {
    open: 'Open',
    'in-progress': 'In progress',
    'waiting-parts': 'Waiting parts',
    'waiting-tech': 'Waiting tech',
    done: 'Done',
  },
  category: {
    mechanical: 'Mechanical',
    electrical: 'Electrical',
    pneumatic: 'Pneumatic',
    facility: 'Facility',
    safety: 'Safety',
    cleaning: 'Cleaning',
    other: 'Other',
  },
  personKind: {
    user: 'User',
    coworker: 'Coworker',
    contractor: 'Contractor',
  },
  coworkerShift: {
    day: 'Day',
    evening: 'Evening',
    night: 'Night',
    rotating: 'Rotating',
    other: 'Other',
  },
  pmState: {
    overdue: 'Overdue',
    'due-soon': 'Due soon',
    ok: 'Upcoming',
  },
};

export const BACKUP_STORES = ['machines', 'parts', 'workOrders', 'pmTasks'];

/**
 * Display label for a machine's type (SPEC-v2.md 15.2): the custom `typeLabel`
 * when `type === 'other'`, otherwise the built-in label.
 */
export function machineTypeLabel(machine) {
  if (!machine) return '';
  if (machine.type === 'other') {
    const label = typeof machine.typeLabel === 'string' ? machine.typeLabel.trim() : '';
    return label || LABELS.machineType.other;
  }
  return LABELS.machineType[machine.type] || machine.type || '';
}

/**
 * Two-letter initials for a display name (SPEC-v2.md 15.4 item 2): the first
 * letters of the first two words ("Jane Cruz" -> "JC"), or the first two
 * letters of a single word ("Madeleine" -> "MA"). Returns '' for nothing.
 */
export function initialsOf(name) {
  const words = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) {
    const letters = Array.from(words[0]);
    return (letters[0] + (letters[1] || '')).toUpperCase();
  }
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

/**
 * Compact phone header text for the sync pill (SPEC-v2.md 15.4 item 2):
 * a dot plus a word, with the pending count shown only while changes are
 * pending. Mirrors statusText states (logic-sync.js) without replacing it.
 */
export function compactSyncLabel(status = {}) {
  const pending = Math.max(0, Math.floor(Number(status.pending) || 0));
  const failed = Math.max(0, Math.floor(Number(status.failed) || 0));
  const online = status.online !== false;
  if (status.needsLogin) return 'Sign in';
  if (pending > 0) return online ? `Saving ${pending}` : `Offline ${pending}`;
  if (!online) return 'Offline';
  if (failed > 0) return 'Failed';
  return 'Synced';
}

/**
 * Distinct custom ("Other") machine types already in use (SPEC-v2.md 15.2):
 * the `typeLabel` values of all non-deleted machines with `type === 'other'`,
 * de-duplicated case-insensitively (most common spelling wins, first-seen
 * wins a tie), sorted A–Z.
 */
export function customTypeOptions(machines = []) {
  const byKey = new Map();
  for (const machine of machines) {
    if (!machine || machine.deleted === true || machine.type !== 'other') continue;
    const label = typeof machine.typeLabel === 'string' ? machine.typeLabel.trim() : '';
    if (label === '') continue;
    const key = label.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, new Map());
    const spellings = byKey.get(key);
    spellings.set(label, (spellings.get(label) || 0) + 1);
  }
  const labels = [];
  for (const spellings of byKey.values()) {
    let best = null;
    for (const [label, count] of spellings) {
      if (best === null || count > best.count) best = { label, count };
    }
    labels.push(best.label);
  }
  return labels.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export const WORK_ORDER_CSV_COLUMNS = [
  'reportedAt',
  'completedAt',
  'machine',
  'kind',
  'priority',
  'status',
  'title',
  'problem',
  'actionTaken',
  'partsUsed',
  'minutesSpent',
  'downtimeMinutes',
];

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function isISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return parseISODate(value) !== null;
}

export function parseISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function addDays(isoDate, days) {
  const date = parseISODate(isoDate);
  if (!date) return null;
  return new Date(date.getTime() + Math.trunc(days) * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(fromISO, toISO) {
  const from = parseISODate(fromISO);
  const to = parseISODate(toISO);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

export function formatDate(isoDate) {
  const date = parseISODate(isoDate);
  if (!date) return isoDate || '—';
  return date.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function pmDueDate(task, today = todayISO()) {
  if (!task || !task.lastDoneAt) return today;
  const interval = Math.max(1, Math.floor(Number(task.intervalDays) || 1));
  return addDays(task.lastDoneAt, interval) || today;
}

export function pmState(task, today = todayISO()) {
  if (!task || task.active === false) return 'ok';
  const due = pmDueDate(task, today);
  if (!due) return 'ok';
  if (due < today) return 'overdue';
  const days = daysBetween(today, due);
  if (days !== null && days >= 0 && days <= 3) return 'due-soon';
  return 'ok';
}

/**
 * PM is paused for machines that are `in-storage` or `retired`
 * (SPEC-v2.md 15.3): their tasks never count as overdue/due soon anywhere.
 */
export function pmPaused(machine) {
  return Boolean(machine && (machine.status === 'in-storage' || machine.status === 'retired'));
}

/**
 * Group active PM tasks (SPEC-v2.md 15.3). Tasks on machines that are
 * `in-storage` or `retired` go to `paused`; they are excluded from
 * overdue/dueSoon/upcoming until the machine runs again.
 */
export function groupPMTasks(tasks, today = todayISO(), machines = []) {
  const machinesById = new Map(machines.map((machine) => [machine.id, machine]));
  const active = tasks.filter((task) => task.active !== false);
  const groups = { overdue: [], dueSoon: [], upcoming: [], paused: [] };
  for (const task of active) {
    if (pmPaused(machinesById.get(task.machineId))) {
      groups.paused.push(task);
      continue;
    }
    const state = pmState(task, today);
    if (state === 'overdue') groups.overdue.push(task);
    else if (state === 'due-soon') groups.dueSoon.push(task);
    else groups.upcoming.push(task);
  }
  const byDue = (a, b) => {
    const dueA = pmDueDate(a, today);
    const dueB = pmDueDate(b, today);
    return dueA.localeCompare(dueB) || String(a.title).localeCompare(String(b.title));
  };
  groups.overdue.sort(byDue);
  groups.dueSoon.sort(byDue);
  groups.upcoming.sort(byDue);
  groups.paused.sort(byDue);
  return groups;
}

export function completePMTask(task, options = {}) {
  const today = options.today || todayISO();
  const now = options.now || new Date().toISOString();
  const id = options.id;
  if (!id) throw new Error('completePMTask requires an id for the work order');
  const workOrder = {
    id,
    title: task.title,
    machineId: task.machineId,
    kind: 'pm',
    priority: 'medium',
    status: 'done',
    reportedAt: today,
    completedAt: today,
    problem: '',
    actionTaken: task.instructions || '',
    partsUsed: [],
    minutesSpent: 0,
    downtimeMinutes: 0,
    pmTaskId: task.id,
    photos: [],
    stockDeducted: false,
    createdAt: now,
    updatedAt: now,
  };
  const updatedTask = { ...task, lastDoneAt: today, updatedAt: now };
  return { task: updatedTask, workOrder };
}

/**
 * "Mark done" for v3 PM tasks (SPEC-v3.md section 4, V3-M4): builds the Done
 * service order that copies the task's priority (legacy `normal` reads as
 * `medium`; none given → `medium`), category (only when set), assignees and
 * the checklist with every item ticked, plus the updated task with
 * `lastDoneAt` set to today. `user` (the signed-in user, may be null in local
 * mode) yields `labourPerson` — the default person for the optional labour
 * hours dialog shown after Mark done.
 */
export function buildPMCompletionOrder(task, user, today = todayISO(), options = {}) {
  const now = options.now || new Date().toISOString();
  let id = options.id;
  if (!id) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      id = crypto.randomUUID();
    } else {
      throw new Error('buildPMCompletionOrder requires an id for the work order');
    }
  }
  const assignees = Array.isArray(task.assignees)
    ? task.assignees.filter(Boolean).slice(0, 10).map((entry) => ({ kind: entry.kind, id: entry.id }))
    : [];
  const checklist = Array.isArray(task.checklist)
    ? task.checklist.filter(Boolean).slice(0, 50).map((item) => ({ id: item.id, text: item.text, done: true }))
    : [];
  const order = {
    id,
    title: task.title,
    machineId: task.machineId,
    kind: 'pm',
    status: 'done',
    priority: priorityValue(task.priority) || 'medium',
    reportedAt: today,
    completedAt: today,
    problem: '',
    actionTaken: task.instructions || '',
    partsUsed: [],
    minutesSpent: 0,
    downtimeMinutes: 0,
    pmTaskId: task.id,
    photos: [],
    stockDeducted: false,
    assignees,
    checklist,
    labour: [],
    createdAt: now,
    updatedAt: now,
  };
  if (task.category) order.category = task.category;
  const labourPerson = user && user.id ? { kind: 'user', id: user.id } : null;
  const updatedTask = { ...task, lastDoneAt: today, updatedAt: now };
  return { order, task: updatedTask, labourPerson };
}

export function isLowStock(part) {
  const onHand = Number(part && part.qtyOnHand);
  const min = Number(part && part.minQty);
  return Number.isFinite(onHand) && Number.isFinite(min) && min > 0 && onHand <= min;
}

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).toLowerCase();
}

export function searchParts(parts, query, machines = []) {
  const needle = normalizeText(query).trim();
  if (!needle) return parts.slice();
  const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));
  return parts.filter((part) => {
    const fits = (part.machineIds || []).map((id) => machineNames.get(id) || '');
    return [part.name, part.partNumber, part.supplier, part.notes, ...fits].some((value) =>
      normalizeText(value).includes(needle),
    );
  });
}

export function searchWorkOrders(workOrders, query, machines = []) {
  const needle = normalizeText(query).trim();
  if (!needle) return workOrders.slice();
  const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));
  return workOrders.filter((order) =>
    [
      order.title,
      order.problem,
      order.actionTaken,
      machineNames.get(order.machineId) || '',
    ].some((value) => normalizeText(value).includes(needle)),
  );
}

/**
 * Search people records — coworkers and contractors (SPEC-v3.md section 5):
 * case-insensitive text match over the given `fields` (default: the union of
 * both stores' text fields). Tombstones (deleted) are never returned, and an
 * empty query returns every live record, like the other search helpers.
 */
export function contactSearch(records, query, fields) {
  const keys = Array.isArray(fields)
    ? fields
    : ['name', 'company', 'role', 'trade', 'contactName', 'phone', 'email', 'skills'];
  const list = (Array.isArray(records) ? records : []).filter(
    (record) => record && record.deleted !== true,
  );
  const needle = normalizeText(query).trim();
  if (!needle) return list.slice();
  return list.filter((record) => keys.some((key) => normalizeText(record[key]).includes(needle)));
}

function aggregateUsage(partsUsed = []) {
  const usage = new Map();
  for (const item of partsUsed || []) {
    if (!item || !item.partId) continue;
    const qty = Math.max(0, Math.floor(Number(item.qty) || 0));
    if (qty <= 0) continue;
    usage.set(item.partId, (usage.get(item.partId) || 0) + qty);
  }
  return usage;
}

export function deductStock(parts, partsUsed) {
  const usage = aggregateUsage(partsUsed);
  const warnings = [];
  const changedIds = [];
  const updated = parts.map((part) => ({ ...part }));
  const byId = new Map(updated.map((part) => [part.id, part]));
  for (const [partId, qty] of usage) {
    const part = byId.get(partId);
    if (!part) {
      warnings.push(`A used part is no longer in inventory (${partId}).`);
      continue;
    }
    const onHand = Math.max(0, Math.floor(Number(part.qtyOnHand) || 0));
    if (qty > onHand) {
      warnings.push(
        `Not enough ${part.name || 'part'}: used ${qty}, only ${onHand} on hand. Stock set to 0.`,
      );
    }
    const nextQty = Math.max(0, onHand - qty);
    if (nextQty !== part.qtyOnHand) {
      part.qtyOnHand = nextQty;
      changedIds.push(part.id);
    }
  }
  return { parts: updated, warnings, changedIds };
}

export function restoreStock(parts, partsUsed) {
  const usage = aggregateUsage(partsUsed);
  const warnings = [];
  const changedIds = [];
  const updated = parts.map((part) => ({ ...part }));
  const byId = new Map(updated.map((part) => [part.id, part]));
  for (const [partId, qty] of usage) {
    const part = byId.get(partId);
    if (!part) {
      warnings.push(`Cannot restore a part that is no longer in inventory (${partId}).`);
      continue;
    }
    part.qtyOnHand = Math.max(0, Math.floor(Number(part.qtyOnHand) || 0)) + qty;
    changedIds.push(part.id);
  }
  return { parts: updated, warnings, changedIds };
}

export function applyWorkOrderSave(existing, incoming, parts, today = todayISO()) {
  const order = { ...incoming };
  const wasDeducted = Boolean(existing && existing.stockDeducted);
  let nextParts = parts;
  let warnings = [];
  let changedIds = [];

  if (order.status === 'done') {
    if (wasDeducted) {
      order.completedAt = (existing && existing.completedAt) || order.completedAt || today;
    } else {
      const result = deductStock(parts, order.partsUsed || []);
      nextParts = result.parts;
      warnings = warnings.concat(result.warnings);
      changedIds = changedIds.concat(result.changedIds);
      order.completedAt = order.completedAt || today;
    }
    order.stockDeducted = true;
  } else {
    order.completedAt = null;
    if (wasDeducted) {
      const result = restoreStock(parts, (existing && existing.partsUsed) || []);
      nextParts = result.parts;
      warnings = warnings.concat(result.warnings);
      changedIds = changedIds.concat(result.changedIds);
    }
    order.stockDeducted = false;
  }

  return { order, parts: nextParts, warnings, changedIds };
}

export function applyWorkOrderStatus(existing, status, parts, today = todayISO()) {
  return applyWorkOrderSave(existing, { ...existing, status }, parts, today);
}

export function filterWorkOrders(workOrders, filter) {
  if (!filter || filter === 'all') return workOrders.slice();
  if (filter === 'active') return workOrders.filter((order) => order.status !== 'done');
  if (filter === 'waiting') {
    return workOrders.filter(
      (order) => order.status === 'waiting-parts' || order.status === 'waiting-tech',
    );
  }
  return workOrders.filter((order) => order.status === filter);
}

export function openJobCount(workOrders, machineId) {
  return workOrders.filter((order) => order.machineId === machineId && order.status !== 'done')
    .length;
}

export function openBreakdownCount(workOrders, machineId) {
  return workOrders.filter(
    (order) =>
      order.machineId === machineId && order.kind === 'breakdown' && order.status !== 'done',
  ).length;
}

export function shouldOfferMachineDown(order) {
  return Boolean(order && order.kind === 'breakdown' && order.status !== 'done');
}

export function shouldOfferMachineRunning(machine, workOrders) {
  return Boolean(
    machine &&
      machine.status === 'down' &&
      openBreakdownCount(workOrders, machine.id) === 0,
  );
}

export function workOrderAgeDays(order, today = todayISO()) {
  const age = daysBetween(order.reportedAt, today);
  if (age === null) return 0;
  return Math.max(0, age);
}

export function sortWorkOrdersNewest(workOrders) {
  return workOrders.slice().sort((a, b) => {
    const aKey = `${a.reportedAt || ''}T${a.createdAt || ''}`;
    const bKey = `${b.reportedAt || ''}T${b.createdAt || ''}`;
    return bKey.localeCompare(aKey);
  });
}

/* ---------- Service order helpers (SPEC-v3.md sections 2 and 3) ---------- */

/**
 * "SO-0001" for a server-assigned order number, "SO-pending" for an
 * offline-created order that has not been synced yet (SPEC-v3.md section 2).
 */
/*
 * Service order and parts request numbers are server-assigned integers. Since
 * 2026-10-22 they hold the day and that day's count: 261022001 is 22 Oct 2026,
 * number 1, shown "SO-261022-1". Older records keep plain counters (SO-0042).
 */
const DAILY_NUMBER_MIN = 100000000;

/** yymmdd × 1000 for a local date: the first number of that day is this + 1. */
export function dailyNumberBase(date = new Date()) {
  const yy = date.getFullYear() % 100;
  return (yy * 10000 + (date.getMonth() + 1) * 100 + date.getDate()) * 1000;
}

function formatRecordNumber(prefix, number) {
  const value = Number(number);
  if (number === null || number === undefined || number === '' || !Number.isFinite(value)) {
    return `${prefix}-pending`;
  }
  const n = Math.floor(Math.abs(value));
  if (n >= DAILY_NUMBER_MIN) return `${prefix}-${String(Math.floor(n / 1000)).padStart(6, '0')}-${n % 1000}`;
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

export function formatOrderNumber(number) {
  return formatRecordNumber('SO', number);
}

/** Total labour hours: entries + the legacy minutesSpent / 60 (SPEC-v3.md 3). */
export function labourTotal(order) {
  const entries = (order && Array.isArray(order.labour) ? order.labour : []).filter(Boolean);
  let total = 0;
  for (const entry of entries) total += Math.max(0, Number(entry.hours) || 0);
  total += (Number(order && order.minutesSpent) || 0) / 60;
  return Math.round(total * 100) / 100;
}

/** "1.75 h" / "—" for labour hour displays. */
export function formatHours(hours) {
  if (hours === null || hours === undefined || hours === '') return '—';
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} h`;
}

/**
 * "$1,234.50" for money in integer cents (SPEC-v4.md section 2, CAD):
 * totals are calculated in cents so client math never drifts, and this
 * formats them with thousands separators. null/undefined/non-numbers stay
 * null so callers can hide the figure.
 */
export function formatMoney(cents) {
  const amount = Number(cents);
  if (cents === null || cents === undefined || cents === '' || !Number.isFinite(amount)) {
    return null;
  }
  const absolute = Math.abs(Math.round(amount));
  const whole = String(Math.floor(absolute / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${amount < 0 ? '-' : ''}$${whole}.${String(absolute % 100).padStart(2, '0')}`;
}

/* ---------- Parts request helpers (SPEC-v4.md section 2) ---------- */

/**
 * "PR-0001" for a server-assigned request number, "PR-pending" before the
 * first sync (SPEC-v4.md section 2).
 */
export function formatRequestNumber(number) {
  return formatRecordNumber('PR', number);
}

/**
 * Money math for one parts request in integer cents (SPEC-v4.md section 2):
 * `lineTotal = round(qty × unitPrice × 100)` per line, the subtotal before
 * HST, `hst = round(subtotal × hstRate / 100)` and the grand total. Lines
 * without a unit price count as 0 and are reported in `unpricedCount`. The
 * totals are calculated, never stored.
 */
export function requestTotals(request) {
  const lines = Array.isArray(request && request.lines) ? request.lines.filter(Boolean) : [];
  const rate = Number(request && request.hstRate);
  const hstRate = Number.isFinite(rate) && rate >= 0 ? rate : 13;
  const lineTotals = lines.map((line) => {
    const unitPrice = line.unitPrice;
    if (unitPrice === null || unitPrice === undefined) return 0;
    const price = Number(unitPrice);
    if (!Number.isFinite(price)) return 0;
    const qty = Number(line.qty);
    const quantity = Number.isFinite(qty) ? qty : 0;
    return Math.round(quantity * price * 100);
  });
  let subtotalCents = 0;
  for (const cents of lineTotals) subtotalCents += cents;
  const unpricedCount = lines.filter(
    (line) => line.unitPrice === null || line.unitPrice === undefined
  ).length;
  const hstCents = Math.round((subtotalCents * hstRate) / 100);
  return {
    lines: lineTotals.map((lineTotalCents) => ({ lineTotalCents })),
    subtotalCents,
    hstCents,
    totalCents: subtotalCents + hstCents,
    unpricedCount,
  };
}

/* ---------- Parts request UI helpers (SPEC-v4.md section 3) ---------- */

/** Whole dollars → integer cents for sheet price cells (formatMoney input). */
function priceToCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100);
}

/**
 * A starting line for a catalogue part (SPEC-v4.md 3.3): enough quantity to
 * reach the minimum level again, at least 1; the price stays unknown (null)
 * until the supplier quotes it. partId/partNumber/supplier carry over.
 */
export function partRequestLine(part) {
  if (!part) return null;
  const onHand = Number(part.qtyOnHand);
  const min = Number(part.minQty);
  const need =
    Number.isFinite(onHand) && Number.isFinite(min) ? Math.max(Math.ceil(min - onHand), 1) : 1;
  const line = {
    description: String(part.name || '').slice(0, 200),
    qty: Math.min(need, 100000),
    unit: part.unit || 'pcs',
    unitPrice: null,
  };
  if (part.id) line.partId = String(part.id);
  if (part.partNumber) line.partNumber = String(part.partNumber).slice(0, 60);
  if (part.supplier) line.supplier = String(part.supplier).slice(0, 120);
  return line;
}

/**
 * Lines for "Add all low-stock to request" (SPEC-v4.md 3.3): one per
 * low-stock part, skipping parts already on the request by partId so the
 * button never duplicates a line.
 */
export function buildLowStockRequestLines(parts, lines = []) {
  const already = new Set(
    (Array.isArray(lines) ? lines : [])
      .map((line) => (line && line.partId) || null)
      .filter(Boolean),
  );
  const out = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || already.has(part.id) || !isLowStock(part)) continue;
    const line = partRequestLine(part);
    if (line) out.push(line);
  }
  return out;
}

/**
 * Reorder one line in the request form (SPEC-v4.md 3.2): direction 'up' or
 * 'down', ignored at the ends. Pure: returns a new array.
 */
export function moveRequestLine(lines, index, direction) {
  const list = Array.isArray(lines) ? lines : [];
  const from = Math.trunc(Number(index));
  if (!Number.isFinite(from) || from < 0 || from >= list.length) return list.slice();
  const to = direction === 'down' ? from + 1 : direction === 'up' ? from - 1 : from;
  if (to < 0 || to >= list.length) return list.slice();
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Sheet description cell (SPEC-v4.md 3.4): the line description with the part
 * number and machine in parentheses behind it, e.g. "Needles (#129 · Juki)".
 */
export function requestLineDescription(line, machineNames = new Map()) {
  const names = machineNames instanceof Map ? machineNames : new Map(machineNames || []);
  const machineName = line && line.machineId ? names.get(line.machineId) : '';
  const context = [line && line.partNumber, machineName]
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => String(value));
  const text = String((line && line.description) || '');
  if (context.length === 0) return text;
  return text ? `${text} (${context.join(' / ')})` : context.join(' / ');
}

/** Sheet cell objects shared by the screen table, clipboard and CSV (SPEC-v4.md 3.4). */
export function requestSheetRows(request, totals, { machines = [] } = {}) {
  const names = new Map(
    (Array.isArray(machines) ? machines : []).map((machine) => [machine.id, machine.name]),
  );
  const computed = requestTotals(request);
  const t = totals || computed;
  const lines = Array.isArray(request && request.lines) ? request.lines.filter(Boolean) : [];
  return lines.map((line, index) => {
    const priced = line.unitPrice !== null && line.unitPrice !== undefined;
    const cents = t.lines[index] ? t.lines[index].lineTotalCents : 0;
    return {
      number: String(index + 1),
      description: requestLineDescription(line, names),
      qty: String(line.qty),
      unit: line.unit || 'pcs',
      unitPrice: priced ? formatMoney(priceToCents(line.unitPrice)) :'—',
      totalPrice: priced ? formatMoney(cents) : '—',
      unpriced: !priced,
      // Where to buy it; the accountant orders from this page.
      link: typeof line.link === 'string' ? line.link : '',
    };
  });
}

/** HST label keeps one decimal at most ("HST (13%)" / "HST (13.5%)"). */
export function requestHstLabel(hstRate) {
  const rate = Number(hstRate);
  const value = Number.isFinite(rate) && rate >= 0 ? rate : 13;
  const text = Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
  return `HST (${text}%)`;
}

/** The three footer figures (SPEC-v4.md 3.4 drawing). */
export function requestSheetTotals(request, totals) {
  const t = totals || requestTotals(request);
  return {
    beforeHst: { label: 'Total before HST', value: formatMoney(t.subtotalCents) },
    hst: { label: requestHstLabel(request && request.hstRate), value: formatMoney(t.hstCents) },
    grand: { label: 'Total grand amount', value: formatMoney(t.totalCents) },
    unpricedCount: t.unpricedCount,
  };
}

/** Sheet column headers, shared by the table, clipboard and CSV (SPEC-v4.md 3.4). */
export const REQUEST_SHEET_COLUMNS = ['#', 'Description', 'Qty', 'Unit', 'Unit price', 'Total price'];

/** Cell order used by every text export of the sheet. */
function requestSheetCells(row) {
  const description = row.link ? `${row.description} ${row.link}` : row.description;
  return [row.number, description, row.qty, row.unit, row.unitPrice, row.totalPrice];
}

/**
 * CSV text for the request sheet (SPEC-v4.md 3.4): the sheet columns plus the
 * three total rows, comma-quoted where needed, UTF-8 with BOM so Excel opens
 * it directly. CRLF row ends for Excel friendliness.
 */
export function requestSheetCSV(request, totals, options = {}) {
  const rows = requestSheetRows(request, totals, options);
  const footer = requestSheetTotals(request, totals);
  const lines = [REQUEST_SHEET_COLUMNS.map(csvEscape).join(',')];
  for (const row of rows) lines.push(requestSheetCells(row).map(csvEscape).join(','));
  for (const { label, value } of [footer.beforeHst, footer.hst, footer.grand]) {
    lines.push(['', label, '', '', '', value].map(csvEscape).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** One TSV cell: tabs and line breaks would break the column grid. */
function tsvCell(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[\t\r\n]+/g, ' ');
}

/**
 * Tab-separated text for the clipboard (SPEC-v4.md 3.4 "Copy table"): the
 * paste-as-table payload for plain-text targets.
 */
export function requestSheetTSV(request, totals, options = {}) {
  const rows = requestSheetRows(request, totals, options);
  const footer = requestSheetTotals(request, totals);
  const lines = [REQUEST_SHEET_COLUMNS.map(tsvCell).join('\t')];
  for (const row of rows) lines.push(requestSheetCells(row).map(tsvCell).join('\t'));
  for (const { label, value } of [footer.beforeHst, footer.hst, footer.grand]) {
    lines.push(['', label, '', '', '', value].map(tsvCell).join('\t'));
  }
  return lines.join('\n');
}

/** HTML escaping for clipboard payloads (never innerHTML with user text). */
export function escapeHtmlText(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The clipboard `text/html` payload (SPEC-v4.md 3.4): a real <table> so the
 * copy pastes as a table into Outlook/Gmail/Excel. A border attribute keeps
 * the grid visible in clients that drop <style>.
 */
export function requestSheetHTML(request, totals, options = {}) {
  const rows = requestSheetRows(request, totals, options);
  const footer = requestSheetTotals(request, totals);
  const headRow = `<tr>${REQUEST_SHEET_COLUMNS.map(
    (label) => `<th scope="col">${escapeHtmlText(label)}</th>`,
  ).join('')}</tr>`;
  const bodyRows = rows
    .map(
      (row) =>
        `<tr>${requestSheetCells({ ...row, link: '' })
          .map((cell, index) =>
            index === 1 && row.link
              ? `<td>${escapeHtmlText(cell)}<br><a href="${escapeHtmlText(row.link)}">${escapeHtmlText(row.link)}</a></td>`
              : `<td>${escapeHtmlText(cell)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  const footRows = [footer.beforeHst, footer.hst, footer.grand]
    .map(
      ({ label, value }) =>
        `<tr><td colspan="5">${escapeHtmlText(label)}</td><td>${escapeHtmlText(
          value,
        )}</td></tr>`,
    )
    .join('');
  const caption =
    request && (request.title || request.number)
      ? `<caption>Purchase request ${escapeHtmlText(
          formatRequestNumber(request && request.number),
        )}${request.title ? ` — ${escapeHtmlText(request.title)}` : ''}</caption>`
      : '';
  return `<table border="1" cellpadding="4" cellspacing="0">${caption}<thead>${headRow}</thead><tbody>${bodyRows}</tbody><tfoot>${footRows}</tfoot></table>`;
}

/**
 * Search parts requests (SPEC-v4.md 3.1): case-insensitive match on the
 * title, the PR number (PR-0007 / 7 / partial) and any line text. Empty
 * query returns everything, like searchParts.
 */
export function searchPurchaseRequests(requests, query) {
  const list = Array.isArray(requests) ? requests.filter((record) => record && !record.deleted) : [];
  const needle = normalizeText(query).trim();
  if (!needle) return list.slice();
  const digits = /^\d+$/.test(needle) ? Number(needle) : null;
  return list.filter((request) => {
    const rawNumber = request.number;
    const number = Number(rawNumber);
    const hasNumber =
      rawNumber !== null && rawNumber !== undefined && rawNumber !== '' && Number.isFinite(number);
    const numberText = hasNumber ? normalizeText(formatRequestNumber(number)) : '';
    if (numberText && numberText.includes(needle)) return true;
    if (hasNumber && digits !== null && digits === number) return true;
    if (normalizeText(request.title).includes(needle)) return true;
    return (Array.isArray(request.lines) ? request.lines : []).some((line) => {
      if (!line) return false;
      return [line.description, line.partNumber, line.note, line.supplier].some((value) =>
        normalizeText(value).includes(needle),
      );
    });
  });
}

/* ---------- Library helpers (SPEC-v4.md section 4.1) ---------- */

/**
 * A model number reduced for matching (SPEC-v4.md 4.1): lower-cased with
 * spaces, dashes, dots and slashes removed, so "DDL-8700-7", "DDL 8700 7"
 * and "ddl.8700/7" all compare equal. Non-strings become ''.
 */
export function normalizeModel(text) {
  if (text === null || text === undefined) return '';
  return String(text).toLowerCase().replace(/[\s\-./]+/g, '');
}

/**
 * Library items that apply to one machine (SPEC-v4.md 4.1): the machine id
 * is in `machineIds`, OR one of the item's models matches the machine's
 * model (compared through normalizeModel), OR the item names no models and
 * no machines and its `machineType` equals the machine's type. Matching
 * items come back in input order.
 */
export function relatedLibraryItems(machine, items) {
  if (machine === null || machine === undefined || !Array.isArray(items)) return [];
  const id = machine.id === undefined ? null : machine.id;
  const modelKey = normalizeModel(machine.model);
  const type = machine.type === undefined ? null : machine.type;
  const matches = [];
  for (const item of items) {
    if (item === null || item === undefined) continue;
    const machineIds = Array.isArray(item.machineIds) ? item.machineIds : [];
    if (id !== null && machineIds.includes(id)) {
      matches.push(item);
      continue;
    }
    const models = Array.isArray(item.models) ? item.models : [];
    if (
      modelKey !== '' &&
      models.some((model) => model !== null && model !== undefined && normalizeModel(model) === modelKey)
    ) {
      matches.push(item);
      continue;
    }
    // Type-only rule: applies to all machines of the type when the item
    // gives no models and no specific machines.
    if (
      models.length === 0 &&
      machineIds.length === 0 &&
      item.machineType !== null &&
      item.machineType !== undefined &&
      item.machineType === type
    ) {
      matches.push(item);
    }
  }
  return matches;
}

/* ---------- Library UI helpers (SPEC-v4.md section 4.3, V4-M4) ---------- */

/**
 * Free-text search across the Library list (SPEC-v4.md 4.3): title, models,
 * tags, symptom and step text, case-insensitive. A blank query returns the
 * input order (null/false entries dropped), like searchPurchaseRequests.
 */
export function searchLibraryItems(items, query) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  const needle = String(query === null || query === undefined ? '' : query)
    .trim()
    .toLowerCase();
  if (needle === '') return list;
  return list.filter((item) => {
    const parts = [
      typeof item.title === 'string' ? item.title : '',
      Array.isArray(item.models) ? item.models.join(' ') : '',
      Array.isArray(item.tags) ? item.tags.join(' ') : '',
      typeof item.symptom === 'string' ? item.symptom : '',
      Array.isArray(item.steps)
        ? item.steps.map((step) => (step && typeof step.text === 'string' ? step.text : '')).join(' ')
        : '',
    ];
    return parts.join(' ').toLowerCase().includes(needle);
  });
}

/**
 * Library list filters (SPEC-v4.md 4.3): machine type, model number and tag.
 * Every value is optional; null/''/"all" means "no filter". Models compare
 * through normalizeModel (SPEC-v4.md 4.1) and tags case-insensitively.
 * Input order is kept.
 */
export function filterLibraryItems(items, { machineType = null, model = null, tag = null } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  const typeFilter =
    machineType === null || machineType === undefined || String(machineType).trim() === ''
      ? null
      : String(machineType);
  const modelKey =
    model === null || model === undefined ? '' : normalizeModel(String(model));
  const tagFilter =
    tag === null || tag === undefined || String(tag).trim() === ''
      ? null
      : String(tag).trim().toLowerCase();
  return list.filter((item) => {
    if (typeFilter !== null && item.machineType !== typeFilter) return false;
    if (modelKey !== '') {
      const models = Array.isArray(item.models) ? item.models : [];
      if (!models.some((entry) => entry !== null && entry !== undefined && normalizeModel(entry) === modelKey)) {
        return false;
      }
    }
    if (tagFilter !== null) {
      const tags = Array.isArray(item.tags) ? item.tags : [];
      if (!tags.some((entry) => String(entry || '').trim().toLowerCase() === tagFilter)) return false;
    }
    return true;
  });
}

/**
 * A completed service order becomes a repair-method draft (SPEC-v4.md 4.3):
 * title from the order, symptom from the problem, one step per non-empty
 * "action taken" line, the machine's id and model, sourceWorkOrderId set.
 * The shape matches the libraryItems "method" record (steps get deterministic
 * ids, texts trimmed and capped at 1000 characters, at most 60 steps).
 */
export function methodDraftFromWorkOrder(order, machine) {
  const source = order === null || order === undefined ? {} : order;
  const steps = String(source.actionTaken === null || source.actionTaken === undefined ? '' : source.actionTaken)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 60)
    .map((line, index) => ({ id: `so-${index + 1}`, text: line.slice(0, 1000) }));
  return {
    kind: 'method',
    title: String(source.title === null || source.title === undefined ? '' : source.title).slice(0, 160),
    symptom: String(source.problem === null || source.problem === undefined ? '' : source.problem).slice(0, 1000),
    cause: '',
    steps,
    toolsParts: '',
    safety: '',
    tags: [],
    machineIds: machine && machine.id ? [machine.id] : [],
    models: machine && machine.model ? [String(machine.model).slice(0, 60)] : [],
    sourceWorkOrderId: source.id || null,
  };
}

/**
 * The badge text for one manual PDF from GET /api/files/:id/text-status
 * (SPEC-v4.md 4.2/4.3): ok with the page count, no_text "Scanned — AI can't
 * read" plus the hint to type key specs into Text for the AI, pending
 * "Reading…", error "Couldn't read". Unknown shapes give null (no badge).
 */
export function manualTextBadge(statusData) {
  if (statusData === null || typeof statusData !== 'object') return null;
  const status = String(statusData.status === null || statusData.status === undefined ? '' : statusData.status);
  if (status === 'ok') {
    const pages = Number(statusData.pages);
    const count = Number.isFinite(pages) && pages > 0 ? Math.floor(pages) : 0;
    return { kind: 'ok', label: `AI can read · ${count} ${count === 1 ? 'page' : 'pages'}`, hint: null };
  }
  if (status === 'no_text') {
    return {
      kind: 'no_text',
      label: "Scanned — AI can't read",
      hint: 'Type the key specs into Text for the AI',
    };
  }
  if (status === 'pending') return { kind: 'pending', label: 'Reading…', hint: null };
  if (status === 'error') return { kind: 'error', label: "Couldn't read", hint: null };
  return null;
}

/**
 * Due state used by the "due" filter: 'none' (no due date), 'overdue'
 * (before today), 'this-week' (today through the next 7 days) or 'later'.
 */
export function serviceOrderDueState(order, today = todayISO()) {
  if (!order || !order.dueDate) return 'none';
  if (String(order.dueDate) < today) return 'overdue';
  const days = daysBetween(today, order.dueDate);
  if (days !== null && days >= 0 && days <= 6) return 'this-week';
  return 'later';
}

/** Date the order was finished: completedAt, or updatedAt as a fallback. */
export function doneDateOf(order) {
  return (order && (order.completedAt || order.updatedAt)) || '';
}

/** Done within the last `days` days (the board's Done column, SPEC-v3.md 3.4). */
export function isRecentDone(order, days = 7, today = todayISO()) {
  if (!order || order.status !== 'done') return false;
  const day = String(doneDateOf(order)).slice(0, 10);
  if (!day) return false;
  const from = addDays(today, -Math.max(1, Math.floor(days))) || '';
  return day >= from && day <= today;
}

/**
 * Default service order filters (SPEC-v3.md section 3 item 2): status not
 * Done. Stored per device; "Clear all" returns here.
 */
export function defaultServiceOrderFilters() {
  return { status: ['not-done'] };
}

function asList(value) {
  if (value === null || value === undefined || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function createdDayOf(order) {
  const created = order && (order.createdAt || order.reportedAt);
  return String(created || '').slice(0, 10);
}

/**
 * Filter service orders (SPEC-v3.md section 3 item 2). All arrays are
 * multi-select; single-value filters (category, machine type, machine,
 * assignee) take a string / {kind,id}. `context` carries the machines (for
 * machine/type lookups) and `today` (ISO date). Returns a new array.
 *
 * Filters: status (incl. the pseudo value 'not-done'), priority (legacy
 * 'normal' counts as 'medium'), category, machineType (built-in `type` value
 * or a custom type label), machine (id), assignee {kind,id}, kind,
 * due ('overdue' | 'this-week' | 'none'), createdFrom/createdTo date range.
 * Default filters (status not Done) apply when `filters` is null/undefined.
 */
export function filterServiceOrders(workOrders, filters = null, context = {}) {
  const today = (context && context.today) || todayISO();
  const machines = (context && context.machines) || [];
  const machinesById = new Map(machines.map((machine) => [machine.id, machine]));
  const effective =
    filters && typeof filters === 'object' ? filters : defaultServiceOrderFilters();

  const status = asList(effective.status);
  const priority = asList(effective.priority);
  const kind = asList(effective.kind);
  const due = asList(effective.due);
  const category = asList(effective.category);
  const machineType = asList(effective.machineType);
  const machineIds = asList(effective.machineId).map(String);
  const assignee = effective.assignee || null;
  const createdFrom = effective.createdFrom || '';
  const createdTo = effective.createdTo || '';

  return (workOrders || []).filter((order) => {
    if (status.length > 0) {
      const matches =
        status.includes('not-done') && order.status !== 'done'
          ? true
          : status.includes(order.status);
      if (!matches) return false;
    }
    if (priority.length > 0 && !priority.includes(priorityValue(order.priority))) return false;
    if (category.length > 0 && !category.includes(order.category)) return false;
    if (kind.length > 0 && !kind.includes(order.kind)) return false;
    if (due.length > 0 && !due.includes(serviceOrderDueState(order, today))) return false;
    if (machineIds.length > 0 && !machineIds.includes(String(order.machineId))) return false;
    if (machineType.length > 0) {
      const machine = machinesById.get(order.machineId);
      if (!machine) return false;
      const label = machine.type === 'other' ? machine.typeLabel : machine.type;
      if (!machineType.includes(machine.type) && !machineType.includes(label)) return false;
    }
    if (assignee) {
      const assignees = (order.assignees || []).filter(Boolean);
      const matches = assignees.some(
        (entry) => entry.kind === assignee.kind && entry.id === assignee.id,
      );
      if (!matches) return false;
    }
    if (createdFrom || createdTo) {
      const day = createdDayOf(order);
      if (!day) return false;
      if (createdFrom && day < createdFrom) return false;
      if (createdTo && day > createdTo) return false;
    }
    return true;
  });
}

function isEmptySortValue(value) {
  return value === null || value === undefined || value === '';
}

/**
 * Sort rows for the desktop tables (SPEC 13.1 item 2).
 * `key` is a string field name or a function row => value. Strings compare
 * case-insensitively (localeCompare, sensitivity 'base'); numbers compare
 * numerically; ISO dates are plain strings so lexicographic order is
 * chronological. null/undefined/'' always sort LAST in both directions.
 * Equal values keep their original order (stable). Returns a new array.
 */
export function sortRows(rows, key, dir = 'asc') {
  const getValue = typeof key === 'function' ? key : (row) => row[key];
  const order = dir === 'desc' ? -1 : 1;
  const indexed = rows.map((row, index) => ({ row, index }));
  indexed.sort((entryA, entryB) => {
    const valueA = getValue(entryA.row);
    const valueB = getValue(entryB.row);
    if (isEmptySortValue(valueA) && isEmptySortValue(valueB)) return entryA.index - entryB.index;
    if (isEmptySortValue(valueA)) return 1;
    if (isEmptySortValue(valueB)) return -1;
    let compared = 0;
    if (typeof valueA === 'number' && typeof valueB === 'number') {
      if (valueA < valueB) compared = -1;
      else if (valueA > valueB) compared = 1;
    } else {
      compared = String(valueA).localeCompare(String(valueB), undefined, { sensitivity: 'base' });
    }
    if (compared === 0) return entryA.index - entryB.index;
    return compared * order;
  });
  return indexed.map((entry) => entry.row);
}

export function dashboardCounts(
  { workOrders = [], pmTasks = [], parts = [], machines = [] } = {},
  today = todayISO(),
) {
  const machinesById = new Map(machines.map((machine) => [machine.id, machine]));
  const counted = pmTasks.filter((task) => !pmPaused(machinesById.get(task.machineId)));
  return {
    openJobs: workOrders.filter((order) => order.status !== 'done').length,
    waiting: workOrders.filter(
      (order) => order.status === 'waiting-parts' || order.status === 'waiting-tech',
    ).length,
    pmOverdue: counted.filter((task) => pmState(task, today) === 'overdue').length,
    pmDueSoon: counted.filter((task) => pmState(task, today) === 'due-soon').length,
    lowStock: parts.filter(isLowStock).length,
  };
}

export function needsAttention(
  { workOrders = [], pmTasks = [], parts = [], machines = [] } = {},
  today = todayISO(),
  limit = 10,
) {
  const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));
  const machinesById = new Map(machines.map((machine) => [machine.id, machine]));
  const items = [];

  for (const task of pmTasks) {
    if (pmState(task, today) !== 'overdue') continue;
    if (pmPaused(machinesById.get(task.machineId))) continue;
    items.push({
      type: 'pm',
      id: task.id,
      title: task.title,
      subtitle: `${machineNames.get(task.machineId) || 'Unknown machine'} · due ${formatDate(
        pmDueDate(task, today),
      )}`,
      createdAt: task.createdAt || '',
    });
  }

  for (const order of workOrders) {
    if (order.status === 'done' || order.priority !== 'urgent') continue;
    items.push({
      type: 'job',
      id: order.id,
      title: order.title,
      subtitle: `${machineNames.get(order.machineId) || 'Unknown machine'} · ${
        LABELS.status[order.status] || order.status
      }`,
      createdAt: order.createdAt || '',
    });
  }

  for (const part of parts) {
    if (!isLowStock(part)) continue;
    items.push({
      type: 'part',
      id: part.id,
      title: part.name,
      subtitle: `${Number(part.qtyOnHand) || 0} on hand · min ${Number(part.minQty) || 0}`,
      createdAt: part.createdAt || '',
    });
  }

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title));
  return items.slice(0, limit);
}

export function formatPartsUsed(partsUsed = [], parts = []) {
  const byId = new Map(parts.map((part) => [part.id, part]));
  return (partsUsed || [])
    .filter((item) => item && Number(item.qty) > 0)
    .map((item) => {
      const part = byId.get(item.partId);
      return `${part ? part.name : 'Unknown part'} x ${Number(item.qty)}`;
    })
    .join('; ');
}

export function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function workOrdersToCSV(workOrders, machines = [], parts = []) {
  const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));
  const lines = [WORK_ORDER_CSV_COLUMNS.join(',')];
  for (const order of workOrders) {
    const row = [
      order.reportedAt,
      order.completedAt,
      machineNames.get(order.machineId) || '',
      order.kind,
      order.priority,
      order.status,
      order.title,
      order.problem,
      order.actionTaken,
      formatPartsUsed(order.partsUsed, parts),
      order.minutesSpent,
      order.downtimeMinutes,
    ];
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\n');
}

export function validateBackup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'The backup file is not a JSON object.' };
  }
  if (data.schemaVersion !== 1) {
    return {
      ok: false,
      error: `Unsupported backup schema version: ${String(data.schemaVersion)}. Expected 1.`,
    };
  }
  for (const store of BACKUP_STORES) {
    if (!Array.isArray(data[store])) {
      return { ok: false, error: `The backup is missing a valid "${store}" list.` };
    }
  }
  const counts = {};
  for (const store of BACKUP_STORES) counts[store] = data[store].length;
  return { ok: true, counts };
}
