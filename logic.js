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
export function formatOrderNumber(number) {
  const value = Number(number);
  if (number === null || number === undefined || number === '' || !Number.isFinite(value)) {
    return 'SO-pending';
  }
  return `SO-${String(Math.floor(Math.abs(value))).padStart(4, '0')}`;
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
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} h`;
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
