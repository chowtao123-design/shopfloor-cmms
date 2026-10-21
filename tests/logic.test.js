import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORK_ORDER_CSV_COLUMNS,
  addDays,
  applyWorkOrderSave,
  applyWorkOrderStatus,
  completePMTask,
  csvEscape,
  dashboardCounts,
  daysBetween,
  deductStock,
  filterWorkOrders,
  groupPMTasks,
  isLowStock,
  needsAttention,
  openBreakdownCount,
  pmDueDate,
  pmState,
  searchParts,
  searchWorkOrders,
  shouldOfferMachineDown,
  shouldOfferMachineRunning,
  sortRows,
  todayISO,
  validateBackup,
  workOrdersToCSV,
} from '../logic.js';
import { buildSampleData } from '../seed.js';

const TODAY = '2026-10-20';

function part(overrides = {}) {
  return {
    id: 'p1',
    name: 'Needle',
    partNumber: 'DBX1',
    qtyOnHand: 10,
    minQty: 2,
    supplier: 'Juki',
    notes: '',
    machineIds: [],
    ...overrides,
  };
}

function machine(overrides = {}) {
  return {
    id: 'm1',
    name: 'Juki DDL-8700 #12',
    type: 'sewing',
    status: 'running',
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    id: 'w1',
    title: 'Needle breaking',
    machineId: 'm1',
    kind: 'breakdown',
    priority: 'normal',
    status: 'open',
    reportedAt: TODAY,
    completedAt: null,
    problem: '',
    actionTaken: '',
    partsUsed: [],
    minutesSpent: 0,
    downtimeMinutes: 0,
    stockDeducted: false,
    createdAt: '2026-10-20T12:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
    ...overrides,
  };
}

test('date helpers use calendar dates and handle leap days', () => {
  assert.equal(addDays('2026-10-20', 7), '2026-10-27');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(daysBetween('2026-10-20', '2026-10-23'), 3);
  assert.equal(todayISO(new Date(2026, 9, 20, 23, 30)), '2026-10-20');
});

test('rule 1: PM due date is lastDoneAt + intervalDays', () => {
  const task = { id: 't1', intervalDays: 30, lastDoneAt: '2026-09-20', active: true };
  assert.equal(pmDueDate(task, TODAY), '2026-10-20');
  assert.equal(pmDueDate({ ...task, lastDoneAt: '2026-10-01' }, TODAY), '2026-10-31');
});

test('rule 1: PM with null lastDoneAt is due today, not overdue', () => {
  const task = { id: 't1', intervalDays: 7, lastDoneAt: null, active: true };
  assert.equal(pmDueDate(task, TODAY), TODAY);
  assert.equal(pmState(task, TODAY), 'due-soon');
});

test('rule 2: PM overdue, due-soon boundary and inactive', () => {
  const task = { id: 't1', intervalDays: 7, lastDoneAt: '2026-10-12', active: true };
  assert.equal(pmState(task, TODAY), 'overdue');
  assert.equal(pmState({ ...task, lastDoneAt: '2026-10-13' }, TODAY), 'due-soon');
  assert.equal(pmState({ ...task, lastDoneAt: '2026-10-14' }, TODAY), 'due-soon');
  assert.equal(pmState({ ...task, lastDoneAt: '2026-10-17' }, TODAY), 'ok');
  assert.equal(pmState({ ...task, active: false }, TODAY), 'ok');
  assert.equal(pmState({ ...task, lastDoneAt: null, active: false }, TODAY), 'ok');
});

test('rule 2: PM due-soon is inclusive at exactly 3 days', () => {
  const dueInThree = { id: 't1', intervalDays: 10, lastDoneAt: '2026-10-13', active: true };
  const dueInFour = { id: 't2', intervalDays: 10, lastDoneAt: '2026-10-14', active: true };
  assert.equal(pmDueDate(dueInThree, TODAY), '2026-10-23');
  assert.equal(pmState(dueInThree, TODAY), 'due-soon');
  assert.equal(pmState(dueInFour, TODAY), 'ok');
  assert.equal(pmState({ ...dueInThree, lastDoneAt: '2026-10-10' }, TODAY), 'due-soon');
});

test('rule 2: grouping separates overdue, due soon and upcoming active tasks', () => {
  const groups = groupPMTasks(
    [
      { id: 'a', title: 'A', intervalDays: 7, lastDoneAt: '2026-10-01', active: true },
      { id: 'b', title: 'B', intervalDays: 7, lastDoneAt: '2026-10-15', active: true },
      { id: 'c', title: 'C', intervalDays: 7, lastDoneAt: '2026-10-19', active: true },
      { id: 'd', title: 'D', intervalDays: 7, lastDoneAt: null, active: false },
    ],
    TODAY,
  );
  assert.deepEqual(groups.overdue.map((task) => task.id), ['a']);
  assert.deepEqual(groups.dueSoon.map((task) => task.id), ['b']);
  assert.deepEqual(groups.upcoming.map((task) => task.id), ['c']);
});

test('rule 3: completing a PM creates a done PM work order and updates lastDoneAt', () => {
  const task = {
    id: 't1',
    title: 'Oil hook and check timing',
    machineId: 'm1',
    intervalDays: 30,
    lastDoneAt: null,
    instructions: 'Oil hook; check timing.',
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const result = completePMTask(task, {
    today: TODAY,
    now: '2026-10-20T15:00:00.000Z',
    id: 'w9',
  });
  assert.equal(result.task.lastDoneAt, TODAY);
  assert.equal(result.workOrder.id, 'w9');
  assert.equal(result.workOrder.kind, 'pm');
  assert.equal(result.workOrder.status, 'done');
  assert.equal(result.workOrder.pmTaskId, 't1');
  assert.equal(result.workOrder.completedAt, TODAY);
  assert.equal(result.workOrder.title, task.title);
  assert.equal(result.workOrder.machineId, 'm1');
  assert.deepEqual(result.workOrder.partsUsed, []);
  assert.equal(result.workOrder.photos.length, 0);
});

test('rule 4: parts are deducted when a work order is saved done', () => {
  const parts = [part(), part({ id: 'p2', name: 'Bobbin case', qtyOnHand: 3, minQty: 1 })];
  const result = applyWorkOrderSave(
    null,
    order({
      status: 'done',
      partsUsed: [
        { partId: 'p1', qty: 2 },
        { partId: 'p2', qty: 1 },
      ],
    }),
    parts,
    TODAY,
  );
  assert.equal(result.order.status, 'done');
  assert.equal(result.order.completedAt, TODAY);
  assert.equal(result.order.stockDeducted, true);
  assert.equal(result.parts.find((item) => item.id === 'p1').qtyOnHand, 8);
  assert.equal(result.parts.find((item) => item.id === 'p2').qtyOnHand, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal(parts[0].qtyOnHand, 10, 'input parts must not be mutated');
});

test('rule 4: closing twice does not deduct twice', () => {
  const parts = [part()];
  const first = applyWorkOrderSave(
    null,
    order({ status: 'done', partsUsed: [{ partId: 'p1', qty: 4 }] }),
    parts,
    TODAY,
  );
  const second = applyWorkOrderSave(
    first.order,
    { ...first.order, actionTaken: 'Edited note' },
    first.parts,
    '2026-10-21',
  );
  assert.equal(second.parts[0].qtyOnHand, 6);
  assert.equal(second.order.stockDeducted, true);
  assert.equal(second.order.completedAt, TODAY, 'completion date is preserved');
  assert.deepEqual(second.warnings, []);
});

test('rule 4: reopening restores stock and clears flag; re-closing deducts exactly once', () => {
  const parts = [part({ qtyOnHand: 10 })];
  const closed = applyWorkOrderSave(
    null,
    order({ status: 'done', partsUsed: [{ partId: 'p1', qty: 3 }] }),
    parts,
    TODAY,
  );
  assert.equal(closed.parts[0].qtyOnHand, 7);

  const reopened = applyWorkOrderStatus(closed.order, 'open', closed.parts, TODAY);
  assert.equal(reopened.parts[0].qtyOnHand, 10);
  assert.equal(reopened.order.stockDeducted, false);
  assert.equal(reopened.order.completedAt, null);

  const reclosed = applyWorkOrderStatus(reopened.order, 'done', reopened.parts, TODAY);
  assert.equal(reclosed.parts[0].qtyOnHand, 7);
  assert.equal(reclosed.order.stockDeducted, true);
  assert.equal(reclosed.order.completedAt, TODAY);
});

test('rule 4: stock is clamped at zero and a warning is returned', () => {
  const result = applyWorkOrderSave(
    null,
    order({ status: 'done', partsUsed: [{ partId: 'p1', qty: 15 }] }),
    [part({ qtyOnHand: 4 })],
    TODAY,
  );
  assert.equal(result.parts[0].qtyOnHand, 0);
  assert.equal(result.order.stockDeducted, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /only 4 on hand/);
});

test('rule 4: duplicate part rows are combined and missing parts warn', () => {
  const result = deductStock(
    [part({ qtyOnHand: 10 })],
    [
      { partId: 'p1', qty: 2 },
      { partId: 'p1', qty: 3 },
      { partId: 'missing', qty: 1 },
    ],
  );
  assert.equal(result.parts[0].qtyOnHand, 5);
  assert.equal(result.warnings.length, 1);
});

test('rule 5: low stock uses qtyOnHand <= minQty and minQty > 0', () => {
  assert.equal(isLowStock({ qtyOnHand: 5, minQty: 5 }), true);
  assert.equal(isLowStock({ qtyOnHand: 4, minQty: 5 }), true);
  assert.equal(isLowStock({ qtyOnHand: 6, minQty: 5 }), false);
  assert.equal(isLowStock({ qtyOnHand: 0, minQty: 0 }), false);
  assert.equal(isLowStock({ qtyOnHand: 1, minQty: 0 }), false);
});

test('work order status filters treat active as everything not done', () => {
  const orders = [
    order({ id: 'a', status: 'open' }),
    order({ id: 'b', status: 'in-progress' }),
    order({ id: 'c', status: 'waiting-parts' }),
    order({ id: 'd', status: 'waiting-tech' }),
    order({ id: 'e', status: 'done' }),
  ];
  assert.deepEqual(filterWorkOrders(orders, 'active').map((item) => item.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filterWorkOrders(orders, 'waiting').map((item) => item.id), ['c', 'd']);
  assert.deepEqual(filterWorkOrders(orders, 'done').map((item) => item.id), ['e']);
  assert.deepEqual(filterWorkOrders(orders, 'all').map((item) => item.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(filterWorkOrders(orders, undefined).map((item) => item.id), ['a', 'b', 'c', 'd', 'e']);
});

test('rule 6: machine down offer applies to open breakdown jobs only', () => {
  assert.equal(shouldOfferMachineDown(order({ status: 'open' })), true);
  assert.equal(shouldOfferMachineDown(order({ status: 'in-progress' })), true);
  assert.equal(shouldOfferMachineDown(order({ status: 'waiting-parts' })), true);
  assert.equal(shouldOfferMachineDown(order({ status: 'done' })), false);
  assert.equal(shouldOfferMachineDown(order({ kind: 'facility' })), false);
});

test('rule 6: machine running offer when no breakdowns remain open', () => {
  const machineDown = machine({ status: 'down' });
  assert.equal(
    shouldOfferMachineRunning(machineDown, [order({ status: 'done' })]),
    true,
  );
  assert.equal(
    shouldOfferMachineRunning(machineDown, [order({ status: 'open' }), order({ status: 'done' })]),
    false,
  );
  assert.equal(
    shouldOfferMachineRunning(machine({ status: 'running' }), [order({ status: 'done' })]),
    false,
  );
  assert.equal(openBreakdownCount([order({ status: 'open' })], 'm1'), 1);
});

test('rule 7: part search is case-insensitive across all fields and machine names', () => {
  const machines = [machine({ id: 'm1', name: 'Juki DDL-8700 #12' })];
  const parts = [
    part({ id: 'a', name: 'Needle', partNumber: 'DBX1', supplier: 'Juki', notes: 'size 14' }),
    part({
      id: 'b',
      name: 'Load cell',
      partNumber: 'LC-9',
      supplier: 'Sartorius',
      notes: 'calibrate',
      machineIds: ['m1'],
    }),
    part({ id: 'c', name: 'Cutter blade', partNumber: 'G-22', supplier: 'Gerber', notes: '' }),
  ];
  assert.deepEqual(searchParts(parts, 'needle').map((item) => item.id), ['a']);
  assert.deepEqual(searchParts(parts, 'dbx').map((item) => item.id), ['a']);
  assert.deepEqual(searchParts(parts, 'SARTORIUS').map((item) => item.id), ['b']);
  assert.deepEqual(searchParts(parts, 'calibrate').map((item) => item.id), ['b']);
  assert.deepEqual(searchParts(parts, 'ddl-8700', machines).map((item) => item.id), ['b']);
  assert.deepEqual(searchParts(parts, '  ').map((item) => item.id), ['a', 'b', 'c']);
});

test('rule 7: work order search covers title, problem, action and machine name', () => {
  const machines = [machine({ id: 'm1', name: 'Juki DDL-8700 #12' })];
  const orders = [
    order({ id: 'a', title: 'Needle breaking', problem: 'Error E07', actionTaken: 'Replaced' }),
    order({ id: 'b', title: 'Cutter stall', problem: 'Blade jam', actionTaken: 'Cleaned track' }),
  ];
  assert.deepEqual(searchWorkOrders(orders, 'needle', machines).map((item) => item.id), ['a']);
  assert.deepEqual(searchWorkOrders(orders, 'e07', machines).map((item) => item.id), ['a']);
  assert.deepEqual(searchWorkOrders(orders, 'cleaned', machines).map((item) => item.id), ['b']);
  assert.deepEqual(searchWorkOrders(orders, 'juki', machines).map((item) => item.id), ['a', 'b']);
});

test('rule 8: CSV uses the specified column order', () => {
  assert.deepEqual(WORK_ORDER_CSV_COLUMNS, [
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
  ]);
  const csv = workOrdersToCSV(
    [
      order({
        reportedAt: '2026-10-01',
        completedAt: '2026-10-02',
        kind: 'pm',
        priority: 'urgent',
        status: 'done',
        title: 'Check timing',
        problem: 'none',
        actionTaken: 'done',
        minutesSpent: 30,
        downtimeMinutes: 0,
      }),
    ],
    [machine()],
    [],
  );
  const lines = csv.split('\n');
  assert.equal(lines[0], WORK_ORDER_CSV_COLUMNS.join(','));
  assert.equal(
    lines[1],
    '2026-10-01,2026-10-02,Juki DDL-8700 #12,pm,urgent,done,Check timing,none,done,,30,0',
  );
});

test('rule 8: CSV quoting handles commas, quotes and newlines', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape('line1\r\nline2'), '"line1\r\nline2"');
  assert.equal(csvEscape(null), '');

  const csv = workOrdersToCSV(
    [
      order({
        title: 'Noise, vibration',
        problem: 'Says "stop"\nthen resets',
        partsUsed: [{ partId: 'p1', qty: 2 }],
      }),
    ],
    [machine()],
    [part()],
  );
  const lines = csv.split('\n');
  assert.equal(lines[1], '2026-10-20,,Juki DDL-8700 #12,breakdown,normal,open,"Noise, vibration","Says ""stop""');
  assert.equal(lines[2], 'then resets",,Needle x 2,0,0');
});

test('dashboard and attention helpers count the right records', () => {
  const counts = dashboardCounts(
    {
      workOrders: [
        order({ id: 'a', status: 'open' }),
        order({ id: 'b', status: 'waiting-parts' }),
        order({ id: 'c', status: 'waiting-tech' }),
        order({ id: 'd', status: 'done' }),
      ],
      pmTasks: [
        { id: 't1', intervalDays: 7, lastDoneAt: '2026-10-01', active: true },
        { id: 't2', intervalDays: 7, lastDoneAt: '2026-10-15', active: true },
      ],
      parts: [part({ qtyOnHand: 1, minQty: 2 }), part({ id: 'p2', qtyOnHand: 9, minQty: 2 })],
    },
    TODAY,
  );
  assert.deepEqual(counts, {
    openJobs: 3,
    waiting: 2,
    pmOverdue: 1,
    pmDueSoon: 1,
    lowStock: 1,
  });

  const attention = needsAttention(
    {
      workOrders: [
        order({ id: 'u', priority: 'urgent', createdAt: '2026-10-20T01:00:00.000Z' }),
        order({ id: 'n', priority: 'normal' }),
      ],
      pmTasks: [{ id: 't', title: 'Overdue PM', intervalDays: 7, lastDoneAt: '2026-10-01', active: true, createdAt: '2026-10-01T00:00:00.000Z' }],
      parts: [part({ id: 'low', createdAt: '2026-10-19T00:00:00.000Z', qtyOnHand: 1, minQty: 2 })],
      machines: [machine()],
    },
    TODAY,
  );
  assert.deepEqual(attention.map((item) => item.id), ['u', 'low', 't']);
});

test('backup validation checks schema version and store lists', () => {
  assert.deepEqual(validateBackup(null), {
    ok: false,
    error: 'The backup file is not a JSON object.',
  });
  assert.equal(validateBackup({ schemaVersion: 2 }).ok, false);
  assert.equal(validateBackup({ schemaVersion: 1, machines: [] }).ok, false);
  const valid = {
    schemaVersion: 1,
    machines: [],
    parts: [],
    workOrders: [],
    pmTasks: [],
  };
  assert.deepEqual(validateBackup(valid), {
    ok: true,
    counts: { machines: 0, parts: 0, workOrders: 0, pmTasks: 0 },
  });
});

test('sample data matches the composition in the spec', () => {
  const data = buildSampleData(new Date(2026, 9, 20, 9, 0));
  const machineCounts = {};
  for (const machine of data.machines) machineCounts[machine.type] = (machineCounts[machine.type] || 0) + 1;
  assert.equal(data.machines.length, 8);
  assert.deepEqual(machineCounts, {
    sewing: 3,
    quilting: 1,
    'down-filling': 1,
    cutter: 1,
    building: 2,
  });

  assert.equal(data.parts.length, 6);
  assert.equal(data.parts.filter(isLowStock).length, 1);
  assert.equal(data.parts.find(isLowStock).id, 'sample-p-bobbin');

  assert.equal(data.pmTasks.length, 4);
  const states = data.pmTasks.map((task) => pmState(task, TODAY));
  assert.equal(states.filter((state) => state === 'overdue').length, 1);
  assert.equal(states.filter((state) => state === 'due-soon').length, 1);
  assert.equal(states.filter((state) => state === 'ok').length, 2);

  assert.equal(data.workOrders.length, 6);
  const statuses = new Set(data.workOrders.map((order) => order.status));
  for (const status of ['open', 'in-progress', 'waiting-parts', 'waiting-tech', 'done']) {
    assert.ok(statuses.has(status), `sample must include a ${status} work order`);
  }
  const machineIds = new Set(data.machines.map((machine) => machine.id));
  for (const order of data.workOrders) {
    assert.ok(machineIds.has(order.machineId), 'sample work orders must point at sample machines');
    assert.deepEqual(order.photos, []);
  }
  const usedPartOrder = data.workOrders.find((order) => order.partsUsed.length > 0);
  assert.equal(usedPartOrder.status, 'done');
  assert.equal(usedPartOrder.stockDeducted, true);

  const partIds = new Set(data.parts.map((part) => part.id));
  for (const part of data.parts) {
    for (const id of part.machineIds) assert.ok(machineIds.has(id), 'part fits a sample machine');
  }
  assert.equal(partIds.size, data.parts.length, 'sample part ids are unique');

  const allIds = [
    ...data.machines.map((item) => item.id),
    ...data.parts.map((item) => item.id),
    ...data.workOrders.map((item) => item.id),
    ...data.pmTasks.map((item) => item.id),
  ];
  assert.equal(new Set(allIds).size, allIds.length, 'sample ids are unique across stores');
  for (const collection of [data.machines, data.parts, data.workOrders, data.pmTasks]) {
    for (const record of collection) assert.ok(record.createdAt && record.updatedAt);
  }
});

test('sortRows compares strings case-insensitively in both directions', () => {
  const rows = [{ name: 'banana' }, { name: 'Apple' }, { name: 'cherry' }, { name: 'apricot' }];
  assert.deepEqual(
    sortRows(rows, 'name', 'asc').map((row) => row.name),
    ['Apple', 'apricot', 'banana', 'cherry'],
  );
  assert.deepEqual(
    sortRows(rows, 'name', 'desc').map((row) => row.name),
    ['cherry', 'banana', 'apricot', 'Apple'],
  );
});

test('sortRows compares numbers numerically, not as text', () => {
  const rows = [{ qty: 10 }, { qty: 2 }, { qty: 33 }, { qty: 5 }];
  assert.deepEqual(
    sortRows(rows, 'qty', 'asc').map((row) => row.qty),
    [2, 5, 10, 33],
  );
  assert.deepEqual(
    sortRows(rows, 'qty', 'desc').map((row) => row.qty),
    [33, 10, 5, 2],
  );
});

test('sortRows orders ISO date strings chronologically', () => {
  const rows = [
    { due: '2026-01-02' },
    { due: '2026-10-20' },
    { due: '2025-12-31' },
    { due: '2026-01-01' },
  ];
  assert.deepEqual(
    sortRows(rows, 'due', 'asc').map((row) => row.due),
    ['2025-12-31', '2026-01-01', '2026-01-02', '2026-10-20'],
  );
  assert.deepEqual(
    sortRows(rows, 'due', 'desc').map((row) => row.due),
    ['2026-10-20', '2026-01-02', '2026-01-01', '2025-12-31'],
  );
});

test('sortRows puts empty values last in both directions', () => {
  const rows = [
    { note: 'b' },
    { note: null },
    { note: 'a' },
    { note: '' },
    {},
    { note: 'c' },
  ];
  const label = (row) => (row.note === undefined ? '<missing>' : row.note);
  assert.deepEqual(
    sortRows(rows, 'note', 'asc').map(label),
    ['a', 'b', 'c', null, '', '<missing>'],
  );
  assert.deepEqual(
    sortRows(rows, 'note', 'desc').map(label),
    ['c', 'b', 'a', null, '', '<missing>'],
  );
});

test('sortRows is stable for equal values', () => {
  const rows = [
    { prio: 1, id: 'first' },
    { prio: 2, id: 'second' },
    { prio: 1, id: 'third' },
    { prio: 2, id: 'fourth' },
    { prio: 1, id: 'fifth' },
  ];
  assert.deepEqual(
    sortRows(rows, 'prio', 'asc').map((row) => row.id),
    ['first', 'third', 'fifth', 'second', 'fourth'],
  );
  assert.deepEqual(
    sortRows(rows, 'prio', 'desc').map((row) => row.id),
    ['second', 'fourth', 'first', 'third', 'fifth'],
  );
});

test('sortRows accepts a key function and returns a new array without mutating the input', () => {
  const rows = [
    { meta: { count: 3 } },
    { meta: { count: 20 } },
    { meta: { count: 7 } },
  ];
  const before = rows.map((row) => ({ meta: { count: row.meta.count } }));
  const sorted = sortRows(rows, (row) => row.meta.count, 'asc');
  assert.deepEqual(
    sorted.map((row) => row.meta.count),
    [3, 7, 20],
  );
  assert.notEqual(sorted, rows, 'sortRows must return a new array');
  assert.deepEqual(rows, before, 'sortRows must not mutate the input');
  assert.deepEqual(
    sortRows(rows, (row) => row.meta.count, 'desc').map((row) => row.meta.count),
    [20, 7, 3],
  );
});
