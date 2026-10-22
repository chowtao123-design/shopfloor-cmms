import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countByPriority,
  countByStatus,
  createdVsCompletedWeekly,
  downNow,
  downtimeByMachineType,
  kpis,
  labourByContractor,
  labourByCoworker,
  labourEntries,
  machineStatusCounts,
  rangeFor,
  tableToCSV,
  todayStrip,
  topMachinesByBreakdowns,
} from '../logic-stats.js';

const TODAY = '2026-10-21';
const RANGE30 = { from: '2026-09-22', to: TODAY };

function machine(overrides = {}) {
  return {
    id: 'm1',
    name: 'Juki DDL-8700 #12',
    type: 'sewing',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    id: 'w1',
    title: 'Needle breaking',
    machineId: 'm1',
    kind: 'breakdown',
    priority: 'medium',
    status: 'open',
    reportedAt: TODAY,
    completedAt: null,
    dueDate: null,
    problem: '',
    actionTaken: '',
    partsUsed: [],
    minutesSpent: 0,
    downtimeMinutes: 0,
    labour: [],
    assignees: [],
    createdBy: 'u1',
    createdAt: '2026-10-21T08:00:00.000Z',
    updatedAt: '2026-10-21T08:00:00.000Z',
    ...overrides,
  };
}

function pmTask(overrides = {}) {
  return {
    id: 't1',
    title: 'Weekly clean',
    machineId: 'm1',
    intervalDays: 7,
    lastDoneAt: null,
    active: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function contractor(overrides = {}) {
  return {
    id: 'c1',
    company: 'Juki Service',
    trade: 'Sewing machines',
    hourlyRate: null,
    active: true,
    ...overrides,
  };
}

function coworker(overrides = {}) {
  return {
    id: 'k1',
    name: 'Ana Cruz',
    role: 'Mechanic',
    active: true,
    ...overrides,
  };
}

test('rangeFor: inclusive window ending on today', () => {
  assert.deepEqual(rangeFor(30, TODAY), { from: '2026-09-22', to: TODAY });
  assert.deepEqual(rangeFor(1, TODAY), { from: TODAY, to: TODAY });
  assert.deepEqual(rangeFor(7, '2024-02-29'), { from: '2024-02-23', to: '2024-02-29' });
  assert.deepEqual(rangeFor(90, TODAY), { from: '2026-07-24', to: TODAY });
});

test('machineStatusCounts: all four statuses, deleted and unknown ignored', () => {
  const machines = [
    machine({ id: 'a', status: 'running' }),
    machine({ id: 'b', status: 'running' }),
    machine({ id: 'c', status: 'down' }),
    machine({ id: 'd', status: 'in-storage' }),
    machine({ id: 'e', status: 'retired' }),
    machine({ id: 'f', status: 'running', deleted: true }),
    machine({ id: 'g', status: 'hovering' }),
  ];
  assert.deepEqual(machineStatusCounts(machines), {
    running: 2,
    down: 1,
    'in-storage': 1,
    retired: 1,
  });
  assert.deepEqual(machineStatusCounts([]), { running: 0, down: 0, 'in-storage': 0, retired: 0 });
});

test('downNow: machines down, oldest breakdown first, hours since down', () => {
  const machines = [
    machine({ id: 'm1', name: 'Alpha', type: 'overlock-5', status: 'down' }),
    machine({ id: 'm2', name: 'Beta', status: 'down' }),
    machine({ id: 'm3', name: 'Gamma', status: 'down' }),
    machine({ id: 'm4', name: 'Delta', status: 'running' }),
    machine({ id: 'm5', name: 'Erased', status: 'down', deleted: true }),
  ];
  const workOrders = [
    order({ id: 'w1', machineId: 'm1', reportedAt: '2026-10-18', createdAt: '2026-10-18T09:00:00.000Z' }),
    order({
      id: 'w0',
      machineId: 'm1',
      reportedAt: '2026-10-17',
      createdAt: '2026-10-17T09:00:00.000Z',
      deleted: true,
    }),
    order({ id: 'w2', machineId: 'm2', reportedAt: '2026-10-20', createdAt: '2026-10-20T09:00:00.000Z' }),
    order({ id: 'w3', machineId: 'm2', kind: 'pm', reportedAt: '2026-10-19', status: 'done', completedAt: '2026-10-19' }),
    order({
      id: 'w4',
      machineId: 'm3',
      reportedAt: '2026-10-19',
      status: 'done',
      completedAt: '2026-10-19',
    }),
  ];
  const rows = downNow(machines, workOrders, '2026-10-21T09:30:00.000Z');
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => [row.machine.id, row.hoursDown, row.downSince]),
    [
      // Measured from the moment each order was logged (createdAt), to the minute.
      ['m1', 72.5, '2026-10-18T09:00:00.000Z'],
      ['m2', 24.5, '2026-10-20T09:00:00.000Z'],
      ['m3', null, null],
    ],
  );
  assert.equal(rows[0].type, '5-thread overlock (safety stitch)');
  assert.equal(rows[0].order.id, 'w1');
  assert.equal(rows[1].order.id, 'w2');
  assert.equal(rows[2].order, null);
  assert.equal(downNow([], [], TODAY).length, 0);
});

test('downNow: an order with only a report date counts from that local midnight', () => {
  const machines = [machine({ id: 'm1', status: 'down' })];
  const workOrders = [order({ id: 'w', machineId: 'm1', reportedAt: '2026-10-19' })];
  const now = new Date('2026-10-20T06:00:00');
  const [row] = downNow(machines, workOrders, now.toISOString());
  assert.equal(row.downSince, '2026-10-19');
  assert.equal(row.hoursDown, 30);
});

test('downNow: earliest reportedAt wins among several open breakdowns', () => {
  const machines = [machine({ id: 'm1', status: 'down' })];
  const workOrders = [
    order({ id: 'late', machineId: 'm1', reportedAt: '2026-10-20', createdAt: '2026-10-20T16:00:00.000Z' }),
    order({ id: 'early', machineId: 'm1', reportedAt: '2026-10-19', createdAt: '2026-10-19T10:00:00.000Z' }),
    order({ id: 'earlier', machineId: 'm1', reportedAt: '2026-10-19', createdAt: '2026-10-19T08:00:00.000Z' }),
  ];
  const [row] = downNow(machines, workOrders, '2026-10-21T08:00:00.000Z');
  assert.equal(row.order.id, 'earlier');
  assert.equal(row.hoursDown, 48);
});

test('todayStrip: opened, closed, overdue, PM due today', () => {
  const machines = [
    machine({ id: 'm1', status: 'running' }),
    machine({ id: 'm2', status: 'in-storage' }),
  ];
  const workOrders = [
    order({ id: 'opened', reportedAt: TODAY }),
    order({ id: 'openedDeleted', reportedAt: TODAY, deleted: true }),
    order({ id: 'closed', status: 'done', completedAt: TODAY, reportedAt: '2026-10-18' }),
    order({ id: 'overdue', reportedAt: '2026-10-15', dueDate: '2026-10-20' }),
    order({ id: 'dueToday', reportedAt: '2026-10-15', dueDate: TODAY }),
    order({ id: 'dueTodayDone', reportedAt: '2026-10-15', dueDate: '2026-10-20', status: 'done', completedAt: TODAY }),
    order({ id: 'duePastDone', dueDate: '2026-10-05', status: 'done', reportedAt: '2026-10-01', completedAt: '2026-10-06' }),
  ];
  const pmTasks = [
    pmTask({ id: 'due', machineId: 'm1', lastDoneAt: '2026-10-14' }),
    pmTask({ id: 'pausedMachine', machineId: 'm2', lastDoneAt: '2026-10-14' }),
    pmTask({ id: 'inactive', machineId: 'm1', lastDoneAt: '2026-10-14', active: false }),
    pmTask({ id: 'dueTomorrow', machineId: 'm1', lastDoneAt: '2026-10-15' }),
    pmTask({ id: 'deleted', machineId: 'm1', lastDoneAt: '2026-10-14', deleted: true }),
  ];
  assert.deepEqual(todayStrip(workOrders, pmTasks, machines, TODAY), {
    openedToday: 1,
    closedToday: 2,
    overdueNow: 1,
    pmDueToday: 1,
  });
  assert.deepEqual(todayStrip([], [], [], TODAY), {
    openedToday: 0,
    closedToday: 0,
    overdueNow: 0,
    pmDueToday: 0,
  });
});

test('kpis: open, overdue, MTTR excludes open and out-of-range orders', () => {
  const workOrders = [
    order({
      id: 'done1',
      status: 'done',
      reportedAt: '2026-09-10',
      completedAt: '2026-09-13',
      kind: 'breakdown',
      downtimeMinutes: 120,
    }),
    order({
      id: 'sameDay',
      status: 'done',
      reportedAt: '2026-09-20',
      completedAt: '2026-09-20',
      kind: 'breakdown',
      downtimeMinutes: 60,
    }),
    order({
      id: 'stillOpen',
      reportedAt: '2026-09-01',
      kind: 'breakdown',
      downtimeMinutes: 999,
      dueDate: '2026-10-20',
    }),
    order({
      id: 'openDueToday',
      reportedAt: '2026-09-05',
      dueDate: TODAY,
    }),
    order({
      id: 'outOfRange',
      status: 'done',
      reportedAt: '2026-08-01',
      completedAt: '2026-08-04',
      kind: 'breakdown',
      downtimeMinutes: 600,
    }),
    order({
      id: 'deleted',
      status: 'done',
      reportedAt: '2026-09-10',
      completedAt: '2026-09-11',
      kind: 'breakdown',
      downtimeMinutes: 999,
      deleted: true,
    }),
    order({
      id: 'pmRange',
      kind: 'pm',
      status: 'done',
      reportedAt: '2026-09-25',
      completedAt: '2026-09-25',
      downtimeMinutes: 30,
      labour: [
        { id: 'l1', kind: 'coworker', personId: 'k1', date: '2026-09-25', hours: 2 },
      ],
    }),
    order({
      id: 'legacy',
      status: 'done',
      kind: 'other',
      reportedAt: '2026-09-26',
      completedAt: '2026-09-26',
      minutesSpent: 90,
    }),
  ];
  const result = kpis({ workOrders, pmTasks: [], machines: [] }, { from: '2026-09-01', to: TODAY });
  assert.equal(result.open, 2);
  assert.equal(result.overdue, 1);
  assert.equal(result.mttrHours, 36);
  assert.equal(result.pmCompliancePct, null);
  assert.equal(result.downtimeHours, 3.5);
  assert.equal(result.labourHours, 3.5);
});

test('kpis: empty data yields zero tiles and null rates', () => {
  assert.deepEqual(kpis({}, RANGE30), {
    open: 0,
    overdue: 0,
    mttrHours: null,
    pmCompliancePct: null,
    downtimeHours: 0,
    labourHours: 0,
  });
  assert.deepEqual(kpis({ workOrders: [], pmTasks: [], machines: [] }, RANGE30), {
    open: 0,
    overdue: 0,
    mttrHours: null,
    pmCompliancePct: null,
    downtimeHours: 0,
    labourHours: 0,
  });
});

test('kpis: PM compliance uses the documented approximation', () => {
  const task7 = pmTask({ id: 't7', machineId: 'm1', intervalDays: 7, createdAt: '2026-09-01T00:00:00.000Z' });
  const task30 = pmTask({ id: 't30', machineId: 'm1', intervalDays: 30, createdAt: '2026-08-01T00:00:00.000Z' });
  const pmOrder = (id, taskId, completedAt) =>
    order({
      id,
      kind: 'pm',
      pmTaskId: taskId,
      status: 'done',
      reportedAt: completedAt,
      completedAt,
    });
  const workOrders = [
    pmOrder('a1', 't7', '2026-09-08'),
    pmOrder('a2', 't7', '2026-09-20'),
    pmOrder('a3', 't7', '2026-09-27'),
    pmOrder('b1', 't30', '2026-09-10'),
    order({ id: 'unknown', kind: 'pm', pmTaskId: 'gone', status: 'done', completedAt: '2026-09-10' }),
  ];
  // t7: anchor createdAt 09-01 + 7 = 09-08 (on time), then 09-08 + 7 = 09-15
  // (a2 on 09-20 is late), then 09-20 + 7 = 09-27 (a3 on time).
  // t30: anchor 08-01 + 30 = 08-31, b1 on 09-10 is late.
  // Unknown pmTaskId is excluded from both parts.
  const result = kpis({ workOrders, pmTasks: [task7, task30], machines: [] }, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(result.pmCompliancePct, 50);
});

test('kpis: PM compliance same-day double completion follows the chain', () => {
  const task = pmTask({ id: 't1', intervalDays: 1, createdAt: '2026-09-05T00:00:00.000Z' });
  const workOrders = [
    order({ id: 'first', kind: 'pm', pmTaskId: 't1', status: 'done', completedAt: '2026-09-06' }),
    order({ id: 'second', kind: 'pm', pmTaskId: 't1', status: 'done', completedAt: '2026-09-06' }),
    order({ id: 'late', kind: 'pm', pmTaskId: 't1', status: 'done', completedAt: '2026-09-09' }),
  ];
  const result = kpis({ workOrders, pmTasks: [task], machines: [] }, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(result.pmCompliancePct, 67);
});

test('countByStatus: five statuses including zeros, deleted ignored', () => {
  const workOrders = [
    order(),
    order({ id: 'w2' }),
    order({ id: 'w3', status: 'in-progress' }),
    order({ id: 'w4', status: 'waiting-parts' }),
    order({ id: 'w5', status: 'done', completedAt: TODAY }),
    order({ id: 'w6', status: 'done', completedAt: TODAY }),
    order({ id: 'w7', deleted: true }),
  ];
  assert.deepEqual(countByStatus(workOrders), {
    open: 2,
    'in-progress': 1,
    'waiting-parts': 1,
    'waiting-tech': 0,
    done: 2,
  });
});

test('countByPriority: legacy normal counts as medium, missing defaults to medium', () => {
  const workOrders = [
    order({ priority: 'medium' }),
    order({ id: 'w2', priority: 'normal' }),
    order({ id: 'w3', priority: 'high' }),
    order({ id: 'w4', priority: 'urgent' }),
    order({ id: 'w5', priority: 'none' }),
    order({ id: 'w6', priority: 'low' }),
    order({ id: 'w7' }),
    order({ id: 'w8', priority: 'normal', deleted: true }),
  ];
  assert.deepEqual(countByPriority(workOrders), {
    none: 1,
    low: 1,
    medium: 3,
    high: 1,
    urgent: 1,
  });
});

test('createdVsCompletedWeekly: Monday buckets, empty weeks, month crossings', () => {
  const range = { from: '2026-09-28', to: '2026-10-21' };
  const workOrders = [
    order({ id: 'sepMon', reportedAt: '2026-09-28' }),
    // 2026-10-01 is a Thursday; its Monday is 2026-09-28, crossing the month.
    order({ id: 'octThu', reportedAt: '2026-10-01' }),
    order({ id: 'mon5', reportedAt: '2026-10-05', status: 'done', completedAt: '2026-10-05' }),
    order({ id: 'mon12', reportedAt: '2026-10-12', status: 'done', completedAt: '2026-10-19' }),
    order({ id: 'outBefore', status: 'done', reportedAt: '2026-09-20', completedAt: '2026-09-27' }),
    order({ id: 'outAfter', reportedAt: '2026-10-22' }),
    order({ id: 'gone', reportedAt: '2026-10-05', deleted: true }),
  ];
  assert.deepEqual(createdVsCompletedWeekly(workOrders, range), [
    { weekStart: '2026-09-28', created: 2, completed: 0 },
    { weekStart: '2026-10-05', created: 1, completed: 1 },
    { weekStart: '2026-10-12', created: 1, completed: 0 },
    { weekStart: '2026-10-19', created: 0, completed: 1 },
  ]);
  assert.deepEqual(createdVsCompletedWeekly([], range), [
    { weekStart: '2026-09-28', created: 0, completed: 0 },
    { weekStart: '2026-10-05', created: 0, completed: 0 },
    { weekStart: '2026-10-12', created: 0, completed: 0 },
    { weekStart: '2026-10-19', created: 0, completed: 0 },
  ]);
  assert.deepEqual(createdVsCompletedWeekly(workOrders, { from: '2026-10-22', to: '2026-10-01' }), []);
});

test('createdVsCompletedWeekly: single-day range is one bucket', () => {
  const workOrders = [order({ id: 'w', reportedAt: '2026-10-21' })];
  assert.deepEqual(createdVsCompletedWeekly(workOrders, { from: TODAY, to: TODAY }), [
    { weekStart: '2026-10-19', created: 1, completed: 0 },
  ]);
});

test('downtimeByMachineType: labels via machineTypeLabel, completed in range only', () => {
  const machines = [
    machine({ id: 'overlock', type: 'overlock-5' }),
    machine({ id: 'sewing', type: 'sewing' }),
    machine({ id: 'quilting', type: 'quilting' }),
    machine({ id: 'gone', type: 'cutter', deleted: true }),
  ];
  const workOrders = [
    order({ id: 'w1', machineId: 'overlock', status: 'done', reportedAt: '2026-10-01', completedAt: '2026-10-02', downtimeMinutes: 120 }),
    order({ id: 'w2', machineId: 'overlock', status: 'done', reportedAt: '2026-10-04', completedAt: '2026-10-05', downtimeMinutes: 60 }),
    order({ id: 'w3', machineId: 'sewing', status: 'done', reportedAt: '2026-10-06', completedAt: '2026-10-07', downtimeMinutes: 45 }),
    order({ id: 'w4', machineId: 'sewing', status: 'done', reportedAt: '2026-09-01', completedAt: '2026-09-02', downtimeMinutes: 999 }),
    order({ id: 'w5', machineId: 'sewing', reportedAt: '2026-10-06', downtimeMinutes: 999 }),
    order({ id: 'w6', machineId: 'gone', status: 'done', reportedAt: '2026-10-06', completedAt: '2026-10-07', downtimeMinutes: 999 }),
    order({ id: 'w7', machineId: 'nope', status: 'done', reportedAt: '2026-10-06', completedAt: '2026-10-07', downtimeMinutes: 999 }),
    order({ id: 'w8', machineId: 'overlock', status: 'done', reportedAt: '2026-10-06', completedAt: '2026-10-07', downtimeMinutes: 30, deleted: true }),
  ];
  assert.deepEqual(downtimeByMachineType(workOrders, machines, RANGE30), [
    { type: '5-thread overlock (safety stitch)', hours: 3 },
    { type: 'Sewing (general)', hours: 0.75 },
    { type: 'Automated quilting', hours: 0 },
  ]);
});

test('topMachinesByBreakdowns: count, downtime, MTBF, limit, ties', () => {
  const machines = [
    machine({ id: 'busy', name: 'Busy machine' }),
    machine({ id: 'alpha', name: 'Alpha machine' }),
    machine({ id: 'zeta', name: 'Zeta machine' }),
    machine({ id: 'quiet', name: 'Quiet machine' }),
    machine({ id: 'gone', name: 'Gone machine', deleted: true }),
  ];
  const breakdown = (id, machineId, reportedAt, downtimeMinutes = 0) =>
    order({ id, machineId, reportedAt, downtimeMinutes, kind: 'breakdown' });
  const workOrders = [
    breakdown('b1', 'busy', '2026-09-25', 120),
    breakdown('b2', 'busy', '2026-10-05', 60),
    breakdown('b3', 'busy', '2026-10-20'),
    breakdown('b4', 'busy', '2026-09-20'),
    breakdown('b5', 'alpha', '2026-10-01', 30),
    breakdown('b6', 'zeta', '2026-10-02', 120),
    breakdown('b7', 'alpha', '2026-09-21'),
    breakdown('b8', 'gone', '2026-10-01'),
    order({ id: 'p1', machineId: 'busy', kind: 'pm', reportedAt: '2026-10-01', status: 'done', completedAt: '2026-10-02' }),
  ];
  const rows = topMachinesByBreakdowns(workOrders, machines, RANGE30);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => [row.machine.id, row.breakdowns, row.downtimeHours, row.mtbfDays]),
    [
      ['busy', 3, 3, 10],
      ['zeta', 1, 2, 30],
      ['alpha', 1, 0.5, 30],
    ],
  );
  assert.deepEqual(
    topMachinesByBreakdowns(workOrders, machines, RANGE30, 1).map((row) => row.machine.id),
    ['busy'],
  );
  assert.deepEqual(topMachinesByBreakdowns(workOrders, machines, RANGE30, 0), []);
});

test('labourEntries: labour arrays plus legacy minutesSpent by the creator', () => {
  const workOrders = [
    order({
      id: 'w1',
      reportedAt: '2026-10-01',
      labour: [
        { id: 'l1', kind: 'contractor', personId: 'c9', date: '2026-10-02', hours: 2, note: 'belt change' },
        { id: 'l2', kind: 'coworker', personId: 'k2', date: '2026-09-15', hours: 1.5 },
        { id: 'l3', kind: 'user', personId: 'u2', date: '2026-10-03', hours: 0.25 },
        null,
      ],
    }),
    order({
      id: 'w2',
      status: 'done',
      reportedAt: '2026-10-05',
      completedAt: '2026-10-05',
      minutesSpent: 90,
      createdBy: 'u7',
    }),
    order({ id: 'w3', reportedAt: '2026-09-01', minutesSpent: 120 }),
    order({ id: 'w4', reportedAt: '2026-10-06', minutesSpent: 0 }),
    order({ id: 'w5', reportedAt: '2026-10-06', minutesSpent: 45, labour: [], deleted: true }),
  ];
  const entries = labourEntries(workOrders, RANGE30);
  assert.deepEqual(entries, [
    {
      id: 'l1',
      orderId: 'w1',
      kind: 'contractor',
      personId: 'c9',
      date: '2026-10-02',
      hours: 2,
      note: 'belt change',
    },
    { id: 'l3', orderId: 'w1', kind: 'user', personId: 'u2', date: '2026-10-03', hours: 0.25, note: '' },
    {
      id: 'w2:minutesSpent',
      orderId: 'w2',
      kind: 'user',
      personId: 'u7',
      date: '2026-10-05',
      hours: 1.5,
      note: '',
    },
  ]);
  assert.deepEqual(labourEntries([], RANGE30), []);
});

test('labourByContractor: hours, distinct orders, cost rules, sorting', () => {
  const workOrders = [
    order({
      id: 'w1',
      reportedAt: '2026-10-01',
      labour: [
        { id: 'l1', kind: 'contractor', personId: 'c1', date: '2026-10-01', hours: 2 },
        { id: 'l2', kind: 'contractor', personId: 'c1', date: '2026-10-02', hours: 1.5 },
        { id: 'l3', kind: 'contractor', personId: 'c2', date: '2026-10-02', hours: 0.25 },
      ],
    }),
    order({
      id: 'w2',
      reportedAt: '2026-10-03',
      labour: [{ id: 'l4', kind: 'contractor', personId: 'c1', date: '2026-10-03', hours: 1 },
      ],
    }),
    order({
      id: 'w3',
      reportedAt: '2026-10-04',
      labour: [{ id: 'l5', kind: 'contractor', personId: 'c1', date: '2026-09-01', hours: 9 }],
    }),
  ];
  const contractors = [
    contractor({ id: 'c2', company: 'No Rate Co', trade: 'HVAC', hourlyRate: null }),
    contractor({ id: 'c1', company: 'Juki Service', trade: 'Sewing machines', hourlyRate: 90 }),
    contractor({ id: 'c4', company: 'Idle Co', trade: 'Electrical' }),
    contractor({ id: 'c5', company: 'Gone Co', deleted: true }),
  ];
  const withoutCost = labourByContractor(workOrders, contractors, RANGE30);
  assert.deepEqual(
    withoutCost.map((row) => [row.contractor.id, row.hours, row.cost, row.orders, row.trade]),
    [
      ['c1', 4.5, null, 2, 'Sewing machines'],
      ['c2', 0.25, null, 1, 'HVAC'],
      ['c4', 0, null, 0, 'Electrical'],
    ],
  );
  const withCost = labourByContractor(workOrders, contractors, RANGE30, { includeCost: true });
  assert.deepEqual(
    withCost.map((row) => [row.contractor.id, row.cost]),
    [
      ['c1', 405],
      ['c2', null],
      ['c4', null],
    ],
  );
  const zeroRate = labourByContractor(
    workOrders,
    [contractor({ id: 'c1', hourlyRate: 0 })],
    RANGE30,
    { includeCost: true },
  );
  assert.equal(zeroRate[0].cost, 0);
  assert.deepEqual(labourByContractor([], [], RANGE30), []);
});

test('labourByCoworker: hours, distinct orders, role, sorting', () => {
  const workOrders = [
    order({
      id: 'w1',
      reportedAt: '2026-10-01',
      labour: [
        { id: 'l1', kind: 'coworker', personId: 'k1', date: '2026-10-01', hours: 1 },
        { id: 'l2', kind: 'coworker', personId: 'k1', date: '2026-10-02', hours: 0.5 },
      ],
    }),
    order({
      id: 'w2',
      reportedAt: '2026-10-02',
      labour: [{ id: 'l3', kind: 'coworker', personId: 'k2', date: '2026-10-02', hours: 3 }],
    }),
    order({
      id: 'w3',
      reportedAt: '2026-10-03',
      minutesSpent: 60,
    }),
  ];
  const coworkers = [
    coworker({ id: 'k3', name: 'Bob Nav', role: '' }),
    coworker({ id: 'k1', name: 'Ana Cruz', role: 'Mechanic' }),
    coworker({ id: 'kDel', name: 'Deleted Person', deleted: true }),
  ];
  const rows = labourByCoworker(workOrders, coworkers, RANGE30);
  assert.deepEqual(
    rows.map((row) => [row.coworker.id, row.hours, row.orders, row.role]),
    [
      ['k1', 1.5, 1, 'Mechanic'],
      ['k3', 0, 0, ''],
    ],
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(labourByCoworker([], [], RANGE30), []);
});

test('tableToCSV: labels, quoting, empty cells, string columns', () => {
  const columns = [
    { key: 'name', label: 'Machine, name' },
    { key: 'hours', label: 'Hours' },
  ];
  const rows = [
    { name: 'Juki "8700", line 3', hours: 2.5 },
    { name: 'Line 1\nbreak', hours: null },
  ];
  assert.equal(
    tableToCSV(columns, rows),
    '"Machine, name",Hours\n' +
      '"Juki ""8700"", line 3",2.5\n' +
      '"Line 1\nbreak",',
  );
  assert.equal(tableToCSV(columns, []), '"Machine, name",Hours');
  assert.equal(tableToCSV(['a', 'b'], [{ a: 1, b: 'x' }, { a: '', b: undefined }]), 'a,b\n1,x\n,');
  assert.equal(tableToCSV([], []), '');
});