export const DAY_MS = 24 * 60 * 60 * 1000;

export const MACHINE_TYPES = ['sewing', 'quilting', 'down-filling', 'cutter', 'building', 'other'];
export const MACHINE_STATUSES = ['running', 'down', 'retired'];
export const WORK_ORDER_KINDS = ['breakdown', 'pm', 'facility', 'install', 'other'];
export const PRIORITIES = ['low', 'normal', 'urgent'];
export const WORK_ORDER_STATUSES = ['open', 'in-progress', 'waiting-parts', 'waiting-tech', 'done'];
export const PM_STATES = ['overdue', 'due-soon', 'ok'];

export const LABELS = {
  machineType: {
    sewing: 'Sewing',
    quilting: 'Quilting',
    'down-filling': 'Down filling',
    cutter: 'Cutter',
    building: 'Building',
    other: 'Other',
  },
  machineStatus: {
    running: 'Running',
    down: 'Down',
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
    low: 'Low',
    normal: 'Normal',
    urgent: 'Urgent',
  },
  status: {
    open: 'Open',
    'in-progress': 'In progress',
    'waiting-parts': 'Waiting parts',
    'waiting-tech': 'Waiting tech',
    done: 'Done',
  },
  pmState: {
    overdue: 'Overdue',
    'due-soon': 'Due soon',
    ok: 'Upcoming',
  },
};

export const BACKUP_STORES = ['machines', 'parts', 'workOrders', 'pmTasks'];

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

export function groupPMTasks(tasks, today = todayISO()) {
  const active = tasks.filter((task) => task.active !== false);
  const groups = { overdue: [], dueSoon: [], upcoming: [] };
  for (const task of active) {
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
    priority: 'normal',
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

export function dashboardCounts({ workOrders = [], pmTasks = [], parts = [] } = {}, today = todayISO()) {
  return {
    openJobs: workOrders.filter((order) => order.status !== 'done').length,
    waiting: workOrders.filter(
      (order) => order.status === 'waiting-parts' || order.status === 'waiting-tech',
    ).length,
    pmOverdue: pmTasks.filter((task) => pmState(task, today) === 'overdue').length,
    pmDueSoon: pmTasks.filter((task) => pmState(task, today) === 'due-soon').length,
    lowStock: parts.filter(isLowStock).length,
  };
}

export function needsAttention(
  { workOrders = [], pmTasks = [], parts = [], machines = [] } = {},
  today = todayISO(),
  limit = 10,
) {
  const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));
  const items = [];

  for (const task of pmTasks) {
    if (pmState(task, today) !== 'overdue') continue;
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
