import {
  MACHINE_STATUSES,
  PRIORITIES,
  WORK_ORDER_STATUSES,
  addDays,
  csvEscape,
  daysBetween,
  isISODate,
  machineTypeLabel,
  parseISODate,
  pmDueDate,
  pmPaused,
  priorityValue,
  todayISO,
} from './logic.js';

/**
 * Statistics for the v3 Statistics page (SPEC-v3.md section 7, section 2 for
 * labour/priority). Pure functions over the local client record shapes
 * ({id, ...fields}); records with `deleted === true` are ignored everywhere.
 * Dates are ISO day strings (`YYYY-MM-DD`); datetime strings are truncated to
 * their day. Hours are rounded to 2 decimals unless stated otherwise.
 */

function live(records) {
  return (Array.isArray(records) ? records : []).filter((record) => record && record.deleted !== true);
}

function dateOf(value) {
  return typeof value === 'string' ? value.slice(0, 10) : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function inRange(dateISO, range) {
  if (!isISODate(dateISO) || !range) return false;
  const from = dateOf(range.from);
  const to = dateOf(range.to);
  if (!isISODate(from) || !isISODate(to) || from > to) return false;
  return dateISO >= from && dateISO <= to;
}

function downtimeMinutesOf(order) {
  return Math.max(0, Math.floor(Number(order && order.downtimeMinutes) || 0));
}

/**
 * Monday of the ISO week containing `isoDate` (Sunday belongs to the previous
 * week). Null for an invalid date.
 */
function weekStart(isoDate) {
  const date = parseISODate(isoDate);
  if (!date) return null;
  return addDays(isoDate, -((date.getUTCDay() + 6) % 7));
}

function intervalDaysOf(task) {
  return Math.max(1, Math.floor(Number(task && task.intervalDays) || 1));
}

/**
 * Range covering the last `days` calendar days ending on `today`, inclusive:
 * `rangeFor(30, today)` is today plus the 29 days before it.
 */
export function rangeFor(days, today = todayISO()) {
  const span = Math.max(1, Math.floor(Number(days) || 1));
  const to = isISODate(dateOf(today)) ? dateOf(today) : todayISO();
  return { from: addDays(to, -(span - 1)), to };
}

/**
 * Machine status tiles: counts per status (SPEC-v3.md 7). Machines with an
 * unknown status value are not counted.
 */
export function machineStatusCounts(machines) {
  const counts = Object.fromEntries(MACHINE_STATUSES.map((status) => [status, 0]));
  for (const machine of live(machines)) {
    if (Object.hasOwn(counts, machine.status)) counts[machine.status] += 1;
  }
  return counts;
}

/**
 * "Down now" rows (Status monitor): one row per live machine with status
 * `down`, longest first. `downSince` is the `reportedAt` of that machine's
 * oldest open breakdown order (null when there is none), `order` that order
 * (null likewise, earliest by reportedAt then createdAt then id), and
 * `hoursDown` the whole 24-hour days between `downSince` and `nowISO`
 * (an ISO date or datetime, truncated to its day; null without a downSince).
 */
export function downNow(machines, workOrders, nowISO) {
  const now = isISODate(dateOf(nowISO)) ? dateOf(nowISO) : todayISO();
  const openBreakdowns = live(workOrders).filter(
    (order) => order.kind === 'breakdown' && order.status !== 'done',
  );
  const orderKey = (order) => `${dateOf(order.reportedAt) || ''}|${dateOf(order.createdAt) || ''}|${order.id || ''}`;
  const rows = [];
  for (const machine of live(machines)) {
    if (machine.status !== 'down') continue;
    let order = null;
    for (const candidate of openBreakdowns) {
      if (candidate.machineId !== machine.id) continue;
      if (order === null || orderKey(candidate) < orderKey(order)) order = candidate;
    }
    // Prefer the moment the order was logged; a report date alone counts from local midnight.
    const reported = order ? dateOf(order.reportedAt) : null;
    const created = order && order.createdAt && !Number.isNaN(Date.parse(order.createdAt)) ? order.createdAt : null;
    const downSince = created && (!reported || dateOf(created) === reported) ? created : reported;
    let hoursDown = null;
    if (downSince) {
      const start = isISODate(downSince) ? new Date(`${downSince}T00:00:00`) : new Date(downSince);
      const end = nowISO && !isISODate(nowISO) && !Number.isNaN(Date.parse(nowISO)) ? new Date(nowISO) : new Date(`${now}T00:00:00`);
      hoursDown = Math.max(0, Math.round(((end - start) / 3600000) * 10) / 10);
    }
    rows.push({ machine, type: machineTypeLabel(machine), downSince, order, hoursDown });
  }
  rows.sort(
    (a, b) =>
      (b.hoursDown === null ? -1 : b.hoursDown) - (a.hoursDown === null ? -1 : a.hoursDown) ||
      String(a.machine.name || '').localeCompare(String(b.machine.name || '')),
  );
  return rows;
}

/**
 * Today strip (Status monitor). `overdueNow` counts open service orders whose
 * `dueDate` is before `today`; `pmDueToday` follows `groupPMTasks` semantics:
 * live, active tasks on machines that are not in storage or retired, whose
 * `pmDueDate` is exactly `today`.
 */
export function todayStrip(workOrders, pmTasks, machines, today) {
  const day = isISODate(dateOf(today)) ? dateOf(today) : todayISO();
  const orders = live(workOrders);
  const machinesById = new Map(live(machines).map((machine) => [machine.id, machine]));
  return {
    openedToday: orders.filter((order) => dateOf(order.reportedAt) === day).length,
    closedToday: orders.filter((order) => dateOf(order.completedAt) === day).length,
    overdueNow: orders.filter(
      (order) =>
        order.status !== 'done' &&
        isISODate(dateOf(order.dueDate)) &&
        String(dateOf(order.dueDate)) < day,
    ).length,
    pmDueToday: live(pmTasks).filter(
      (task) =>
        task.active !== false &&
        !pmPaused(machinesById.get(task.machineId)) &&
        pmDueDate(task, day) === day,
    ).length,
  };
}

/**
 * PM completion on-time check with the documented approximation: the due date
 * "at that time" is addDays(anchor, intervalDays) where the anchor is the
 * completedAt of the latest other done PM order for the same task dated on or
 * before this order's completedAt; for the earliest completion on record the
 * anchor falls back to the task's createdAt day (Mark done overwrites
 * lastDoneAt, so the pre-completion date cannot be recovered). When no anchor
 * can be reconstructed at all the completion counts as on time.
 */
function pmCompletedOnTime(task, order, pmOrdersOfTask) {
  const completedAt = dateOf(order.completedAt);
  if (!isISODate(completedAt)) return true;
  let anchor = null;
  for (const other of pmOrdersOfTask || []) {
    if (other === order || other.id === order.id) continue;
    const otherAt = dateOf(other.completedAt);
    if (!isISODate(otherAt) || otherAt > completedAt) continue;
    if (anchor === null || otherAt >= anchor) anchor = otherAt;
  }
  if (anchor === null) {
    anchor = dateOf(task.createdAt);
    if (!isISODate(anchor)) return true;
  }
  const due = addDays(anchor, intervalDaysOf(task));
  return due === null || completedAt <= due;
}

/**
 * KPI tiles for the Reports tab (range = {from, to}, inclusive ISO days).
 * - `open`: live orders not done, all time (current state, not range-limited).
 * - `overdue`: open orders whose dueDate is before `range.to` (as of the end
 *   of the range, which is normally today).
 * - `mttrHours`: mean hours reportedAt -> completedAt for breakdowns completed
 *   in range (whole days x 24); orders still open are excluded; null if none.
 * - `pmCompliancePct`: percent of PM-kind orders completed in range whose
 *   completedAt <= the task's due date at that time (approximation above, in
 *   `pmCompletedOnTime`); orders whose pmTaskId does not resolve to a live PM
 *   task are excluded from both parts; null when there are none.
 * - `downtimeHours`: sum of downtimeMinutes/60 over orders completed in range.
 * - `labourHours`: labour hours in range from `labourEntries` (labour arrays
 *   plus legacy minutesSpent, attributed to the creator).
 */
export function kpis({ workOrders = [], pmTasks = [], machines = [] } = {}, range) {
  const orders = live(workOrders);
  const tasksById = new Map(live(pmTasks).map((task) => [task.id, task]));

  const open = orders.filter((order) => order.status !== 'done').length;
  const to = dateOf(range && range.to);
  const overdue = orders.filter(
    (order) =>
      order.status !== 'done' &&
      isISODate(to) &&
      isISODate(dateOf(order.dueDate)) &&
      String(dateOf(order.dueDate)) < to,
  ).length;

  const completedInRange = orders.filter((order) => inRange(dateOf(order.completedAt), range));

  const mttrSamples = [];
  for (const order of completedInRange) {
    if (order.kind !== 'breakdown') continue;
    const reportedAt = dateOf(order.reportedAt);
    const completedAt = dateOf(order.completedAt);
    if (!isISODate(reportedAt) || !isISODate(completedAt)) continue;
    mttrSamples.push(Math.max(0, daysBetween(reportedAt, completedAt)) * 24);
  }
  const mttrHours = mttrSamples.length
    ? round2(mttrSamples.reduce((sum, hours) => sum + hours, 0) / mttrSamples.length)
    : null;

  const pmDoneByTask = new Map();
  for (const order of orders) {
    if (order.kind !== 'pm' || !order.pmTaskId || !isISODate(dateOf(order.completedAt))) continue;
    if (!pmDoneByTask.has(order.pmTaskId)) pmDoneByTask.set(order.pmTaskId, []);
    pmDoneByTask.get(order.pmTaskId).push(order);
  }
  let onTimePm = 0;
  let totalPm = 0;
  for (const order of completedInRange) {
    if (order.kind !== 'pm') continue;
    const task = tasksById.get(order.pmTaskId);
    if (!task) continue;
    totalPm += 1;
    if (pmCompletedOnTime(task, order, pmDoneByTask.get(order.pmTaskId))) onTimePm += 1;
  }
  const pmCompliancePct = totalPm > 0 ? Math.round((onTimePm / totalPm) * 100) : null;

  let downtimeMinutes = 0;
  for (const order of completedInRange) downtimeMinutes += downtimeMinutesOf(order);

  const labourHours = round2(
    labourEntries(orders, range).reduce((sum, entry) => sum + entry.hours, 0),
  );

  return { open, overdue, mttrHours, pmCompliancePct, downtimeHours: round2(downtimeMinutes / 60), labourHours };
}

/** Count live orders per status; all five statuses are present, 0 included. */
export function countByStatus(workOrders) {
  const counts = Object.fromEntries(WORK_ORDER_STATUSES.map((status) => [status, 0]));
  for (const order of live(workOrders)) {
    if (order.status == null) continue;
    counts[order.status] = (counts[order.status] || 0) + 1;
  }
  return counts;
}

/**
 * Count live orders per priority; legacy `normal` reads as `medium`
 * (SPEC-v3.md 2), and a missing/blank priority counts as `medium` too (the
 * stored default).
 */
export function countByPriority(workOrders) {
  const counts = Object.fromEntries(PRIORITIES.map((priority) => [priority, 0]));
  for (const order of live(workOrders)) {
    const raw = order.priority == null || order.priority === '' ? 'medium' : order.priority;
    if (typeof raw !== 'string') continue;
    const key = priorityValue(raw);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * Created vs completed per week across the range, Monday-start ISO weeks
 * (weekStart is the Monday's ISO date), including weeks with no activity.
 * `created` counts reportedAt and `completed` counts completedAt, both only
 * for dates inside [from, to]. Empty array for an invalid or empty range.
 */
export function createdVsCompletedWeekly(workOrders, range) {
  const from = dateOf(range && range.from);
  const to = dateOf(range && range.to);
  if (!isISODate(from) || !isISODate(to) || from > to) return [];
  const weeks = [];
  for (let cursor = weekStart(from); cursor && cursor <= to; cursor = addDays(cursor, 7)) {
    weeks.push({ weekStart: cursor, created: 0, completed: 0 });
  }
  const byWeek = new Map(weeks.map((week) => [week.weekStart, week]));
  for (const order of live(workOrders)) {
    const reportedAt = dateOf(order.reportedAt);
    if (isISODate(reportedAt) && reportedAt >= from && reportedAt <= to) {
      const bucket = byWeek.get(weekStart(reportedAt));
      if (bucket) bucket.created += 1;
    }
    const completedAt = dateOf(order.completedAt);
    if (isISODate(completedAt) && completedAt >= from && completedAt <= to) {
      const bucket = byWeek.get(weekStart(completedAt));
      if (bucket) bucket.completed += 1;
    }
  }
  return weeks;
}

/**
 * Downtime hours by machine type (labels via `machineTypeLabel`) for orders
 * completed in range. Every live machine's type is listed (0 when no
 * downtime); orders whose machine is missing or deleted are ignored.
 * Sorted hours desc, then type asc.
 */
export function downtimeByMachineType(workOrders, machines, range) {
  const machinesById = new Map(live(machines).map((machine) => [machine.id, machine]));
  const minutesByType = new Map();
  for (const machine of machinesById.values()) {
    minutesByType.set(machineTypeLabel(machine), 0);
  }
  for (const order of live(workOrders)) {
    if (!inRange(dateOf(order.completedAt), range)) continue;
    const machine = machinesById.get(order.machineId);
    if (!machine) continue;
    const label = machineTypeLabel(machine);
    if (!minutesByType.has(label)) minutesByType.set(label, 0);
    minutesByType.set(label, (minutesByType.get(label) || 0) + downtimeMinutesOf(order));
  }
  return [...minutesByType.entries()]
    .map(([type, minutes]) => ({ type, hours: round2(minutes / 60) }))
    .sort((a, b) => b.hours - a.hours || a.type.localeCompare(b.type));
}

/**
 * Top machines by breakdown count in range (breakdowns counted by reportedAt
 * in range, any status; downtimeHours sums those breakdown orders' minutes).
 * mtbfDays = range days / breakdowns, null when there are none (only
 * machines with at least one breakdown are listed). Sorted breakdowns desc,
 * then downtime desc, then machine name asc; trimmed to `limit`.
 */
export function topMachinesByBreakdowns(workOrders, machines, range, limit = 10) {
  const from = dateOf(range && range.from);
  const to = dateOf(range && range.to);
  const spanDays = isISODate(from) && isISODate(to) && from <= to ? daysBetween(from, to) + 1 : null;
  const machinesById = new Map(live(machines).map((machine) => [machine.id, machine]));
  const rows = [];
  for (const machine of machinesById.values()) {
    const breakdowns = [];
    for (const order of live(workOrders)) {
      if (order.kind !== 'breakdown' || order.machineId !== machine.id) continue;
      const reportedAt = dateOf(order.reportedAt);
      if (isISODate(reportedAt) && isISODate(from) && isISODate(to) && reportedAt >= from && reportedAt <= to) {
        breakdowns.push(order);
      }
    }
    if (breakdowns.length === 0) continue;
    let minutes = 0;
    for (const order of breakdowns) minutes += downtimeMinutesOf(order);
    rows.push({
      machine,
      breakdowns: breakdowns.length,
      downtimeHours: round2(minutes / 60),
      mtbfDays: spanDays === null || breakdowns.length === 0 ? null : round2(spanDays / breakdowns.length),
    });
  }
  rows.sort(
    (a, b) =>
      b.breakdowns - a.breakdowns ||
      b.downtimeHours - a.downtimeHours ||
      String(a.machine.name || '').localeCompare(String(b.machine.name || '')),
  );
  const max = Number.isFinite(Number(limit)) && Number(limit) >= 0 ? Math.floor(Number(limit)) : 10;
  return rows.slice(0, max);
}

/**
 * Labour entries dated inside the range (both bounds inclusive): one per
 * `labour` array item ({id, kind, personId, date, hours, note}) plus one
 * legacy entry per order with minutesSpent > 0 — kind 'user', personId the
 * order's creator (`createdBy`), dated to `reportedAt` (SPEC-v3.md 2).
 * Hours are rounded to 2 decimals.
 */
export function labourEntries(workOrders, range) {
  const entries = [];
  for (const order of live(workOrders)) {
    for (const entry of Array.isArray(order.labour) ? order.labour : []) {
      if (!entry) continue;
      const date = dateOf(entry.date);
      if (!inRange(date, range)) continue;
      entries.push({
        id: entry.id,
        orderId: order.id,
        kind: entry.kind,
        personId: entry.personId,
        date,
        hours: round2(Math.max(0, Number(entry.hours) || 0)),
        note: typeof entry.note === 'string' ? entry.note : '',
      });
    }
    const minutes = Math.max(0, Math.floor(Number(order.minutesSpent) || 0));
    if (minutes > 0 && inRange(dateOf(order.reportedAt), range)) {
      entries.push({
        id: `${order.id}:minutesSpent`,
        orderId: order.id,
        kind: 'user',
        personId: order.createdBy || null,
        date: dateOf(order.reportedAt),
        hours: round2(minutes / 60),
        note: '',
      });
    }
  }
  return entries;
}

/**
 * Labour hours per outside contractor over the range: `contractor` is the
 * record, `trade` its trade, `orders` the distinct service orders they worked
 * on, `hours` the summed entry hours, and `cost` hours x hourlyRate when
 * `includeCost` is true and the contractor has a rate (null otherwise).
 * Inactive and zero-hour contractors are listed; sorted hours desc, then
 * company asc.
 */
export function labourByContractor(workOrders, contractors, range, options = {}) {
  const includeCost = Boolean(options && options.includeCost);
  const entries = labourEntries(workOrders, range).filter((entry) => entry.kind === 'contractor');
  return live(contractors)
    .map((contractor) => {
      const mine = entries.filter((entry) => entry.personId === contractor.id);
      const hours = round2(mine.reduce((sum, entry) => sum + entry.hours, 0));
      const rate = Number(contractor.hourlyRate);
      const hasRate = contractor.hourlyRate != null && Number.isFinite(rate) && rate >= 0;
      return {
        contractor,
        trade: typeof contractor.trade === 'string' ? contractor.trade : '',
        orders: new Set(mine.map((entry) => entry.orderId)).size,
        hours,
        cost: includeCost && hasRate ? round2(hours * rate) : null,
      };
    })
    .sort(
      (a, b) =>
        b.hours - a.hours ||
        String(a.contractor.company || '').localeCompare(String(b.contractor.company || '')),
    );
}

/**
 * Labour hours per coworker over the range, same shape as the contractor
 * table without cost: `coworker` is the record, `role` its role, `orders` the
 * distinct service orders, `hours` the summed entry hours. Sorted hours desc,
 * then name asc.
 */
export function labourByCoworker(workOrders, coworkers, range) {
  const entries = labourEntries(workOrders, range).filter((entry) => entry.kind === 'coworker');
  return live(coworkers)
    .map((coworker) => {
      const mine = entries.filter((entry) => entry.personId === coworker.id);
      return {
        coworker,
        role: typeof coworker.role === 'string' ? coworker.role : '',
        orders: new Set(mine.map((entry) => entry.orderId)).size,
        hours: round2(mine.reduce((sum, entry) => sum + entry.hours, 0)),
      };
    })
    .sort(
      (a, b) =>
        b.hours - a.hours ||
        String(a.coworker.name || '').localeCompare(String(b.coworker.name || '')),
    );
}

/**
 * CSV for the statistics tables. `columns` is a list of {key, label} (plain
 * strings are used as both key and label); `rows` a list of row objects. Cell
 * values are stringified (null/undefined as empty) and quoted only when they
 * contain a quote, comma, CR or NL, with quotes doubled. Header row first,
 * lines joined with LF, no trailing newline.
 */
export function tableToCSV(columns, rows) {
  const cols = (Array.isArray(columns) ? columns : []).map((column) =>
    typeof column === 'string' ? { key: column, label: column } : column,
  );
  const lines = [cols.map((column) => csvEscape(column && column.label)).join(',')];
  for (const row of Array.isArray(rows) ? rows : []) {
    lines.push(cols.map((column) => csvEscape(row ? row[column.key] : null)).join(','));
  }
  return lines.join('\n');
}