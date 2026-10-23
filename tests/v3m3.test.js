import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LABELS,
  SO_DUE_FILTERS,
  WORK_ORDER_CATEGORIES,
  defaultServiceOrderFilters,
  filterServiceOrders,
  formatHours,
  formatOrderNumber,
  isRecentDone,
  labourTotal,
  serviceOrderDueState,
} from '../logic.js';
import { renderHelp } from '../help.js';

/* V3-M3 (SPEC-v3.md sections 2 and 3): service orders list with filters,
   board, calendar, drawer form with assignees, checklist, labour and
   attachments. Pure helpers are unit-tested; the browser parts are checked
   as static source so no DOM is needed (see m2-shell.test.js). */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(REPO, name), 'utf8');

const TODAY = '2026-10-21';

const MACHINES = [
  { id: 'm1', name: 'Juki #12', type: 'single-needle' },
  { id: 'm2', name: 'Bartack #3', type: 'other', typeLabel: 'Piping machine' },
  { id: 'm3', name: 'Boiler', type: 'building' },
];

const ORDERS = [
  {
    id: 'a',
    status: 'open',
    priority: 'urgent',
    kind: 'breakdown',
    machineId: 'm1',
    category: 'mechanical',
    dueDate: '2026-10-19',
    reportedAt: '2026-10-15',
    createdAt: '2026-10-15T09:00:00.000Z',
    assignees: [{ kind: 'coworker', id: 'cw1' }],
    labour: [{ id: 'l1', kind: 'coworker', personId: 'cw1', date: '2026-10-16', hours: 1.5, note: '' }],
    minutesSpent: 30,
  },
  {
    id: 'b',
    status: 'done',
    priority: 'normal', // legacy value
    kind: 'pm',
    machineId: 'm2',
    category: 'cleaning',
    dueDate: '2026-10-24',
    reportedAt: '2026-10-01',
    createdAt: '2026-10-01T08:00:00.000Z',
    completedAt: '2026-10-03',
    assignees: [{ kind: 'contractor', id: 'ct1' }],
    labour: [],
    minutesSpent: 0,
  },
  {
    id: 'c',
    status: 'waiting-parts',
    priority: 'low',
    kind: 'facility',
    machineId: 'm3',
    dueDate: null,
    reportedAt: '2026-10-20',
    createdAt: '2026-10-20T10:30:00.000Z',
    assignees: [],
    labour: [],
    minutesSpent: 0,
  },
];

test('formatOrderNumber: SO-0001 style with SO-pending fallback', () => {
  assert.equal(formatOrderNumber(1), 'SO-0001');
  assert.equal(formatOrderNumber(41), 'SO-0041');
  assert.equal(formatOrderNumber(4137), 'SO-4137');
  assert.equal(formatOrderNumber(undefined), 'SO-pending');
  assert.equal(formatOrderNumber(null), 'SO-pending');
  assert.equal(formatOrderNumber(''), 'SO-pending');
  assert.equal(formatOrderNumber('nope'), 'SO-pending');
  // A synced record carries a real number property; an offline one has none.
  const synced = { number: 7 };
  const offline = {};
  assert.equal(formatOrderNumber(synced.number), 'SO-0007');
  assert.equal(formatOrderNumber(offline.number), 'SO-pending');
});

test('labourTotal: labour entries plus legacy minutesSpent / 60', () => {
  assert.equal(labourTotal({ labour: [{ hours: 1.5 }, { hours: 2 }], minutesSpent: 30 }), 4);
  assert.equal(labourTotal({ labour: [], minutesSpent: 90 }), 1.5);
  assert.equal(labourTotal({ labour: [{ hours: 0.25 }] }), 0.25);
  assert.equal(labourTotal({}), 0);
  assert.equal(labourTotal(null), 0);
  // Quarter-hour rounding to two decimals.
  assert.equal(labourTotal({ labour: [{ hours: 1.1 }], minutesSpent: 3 }), 1.15);
});

test('formatHours: totals display', () => {
  assert.equal(formatHours(4), '4 h');
  assert.equal(formatHours(1.25), '1.25 h');
  assert.equal(formatHours(0), '—');
  assert.equal(formatHours(null), '—');
});

test('serviceOrderDueState: overdue / this-week / later / none', () => {
  assert.equal(serviceOrderDueState({ dueDate: '2026-10-19' }, TODAY), 'overdue');
  assert.equal(serviceOrderDueState({ dueDate: TODAY }, TODAY), 'this-week');
  assert.equal(serviceOrderDueState({ dueDate: '2026-10-27' }, TODAY), 'this-week');
  assert.equal(serviceOrderDueState({ dueDate: '2026-10-28' }, TODAY), 'later');
  assert.equal(serviceOrderDueState({ dueDate: null }, TODAY), 'none');
  assert.equal(serviceOrderDueState({}, TODAY), 'none');
});

test('isRecentDone: done within the last 7 days for the board column', () => {
  assert.equal(isRecentDone({ status: 'done', completedAt: '2026-10-20' }, 7, TODAY), true);
  assert.equal(isRecentDone({ status: 'done', completedAt: TODAY }, 7, TODAY), true);
  assert.equal(isRecentDone({ status: 'done', completedAt: '2026-10-13' }, 7, TODAY), false);
  assert.equal(isRecentDone({ status: 'done', completedAt: '2026-10-01' }, 7, TODAY), false);
  assert.equal(isRecentDone({ status: 'open', completedAt: TODAY }, 7, TODAY), false);
  // No completedAt: fall back to updatedAt.
  assert.equal(isRecentDone({ status: 'done', updatedAt: '2026-10-19T12:00:00.000Z' }, 7, TODAY), true);
});

/* --- filterServiceOrders (SPEC-v3.md section 3 item 2) --------------------- */

test('filterServiceOrders: default filters are status not Done', () => {
  assert.deepEqual(defaultServiceOrderFilters(), { status: ['not-done'] });
  assert.deepEqual(filterServiceOrders(ORDERS, null, { machines: MACHINES, today: TODAY }).map((o) => o.id), [
    'a',
    'c',
  ]);
  // The same applies for an undefined filters argument.
  assert.deepEqual(filterServiceOrders(ORDERS, undefined, { today: TODAY }).map((o) => o.id), ['a', 'c']);
});

test('filterServiceOrders: status multi-select incl. not-done and concrete statuses', () => {
  const context = { machines: MACHINES, today: TODAY };
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: ['waiting-parts'] }, context).map((o) => o.id),
    ['c'],
  );
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: ['open', 'done'] }, context).map((o) => o.id),
    ['a', 'b'],
  );
  // 'not-done' mixes with concrete statuses.
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: ['not-done', 'done'] }, context).map((o) => o.id),
    ['a', 'b', 'c'],
  );
  // An empty status list means no restriction at all ("Clear all" state).
  assert.deepEqual(filterServiceOrders(ORDERS, { status: [] }, context).map((o) => o.id), [
    'a',
    'b',
    'c',
  ]);
});

test('filterServiceOrders: priority multi-select reads legacy normal as medium', () => {
  const context = { machines: MACHINES, today: TODAY };
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], priority: ['medium'] }, context).map((o) => o.id),
    ['b'],
  );
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], priority: ['low', 'urgent'] }, context).map((o) => o.id),
    ['a', 'c'],
  );
});

test('filterServiceOrders: category, kind and machine', () => {
  const context = { machines: MACHINES, today: TODAY };
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], category: 'mechanical' }, context).map((o) => o.id),
    ['a'],
  );
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], kind: ['pm', 'facility'] }, context).map((o) => o.id),
    ['b', 'c'],
  );
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], machineId: 'm3' }, context).map((o) => o.id),
    ['c'],
  );
});

test('filterServiceOrders: machine type matches built-ins and custom labels', () => {
  const context = { machines: MACHINES, today: TODAY };
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], machineType: 'single-needle' }, context).map((o) => o.id),
    ['a'],
  );
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], machineType: 'Piping machine' }, context).map((o) => o.id),
    ['b'],
  );
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], machineType: 'building' }, context).map((o) => o.id),
    ['c'],
  );
});

test('filterServiceOrders: assignee {kind, id}', () => {
  const context = { machines: MACHINES, today: TODAY };
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], assignee: { kind: 'coworker', id: 'cw1' } }, context).map((o) => o.id),
    ['a'],
  );
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], assignee: { kind: 'contractor', id: 'ct1' } }, context).map((o) => o.id),
    ['b'],
  );
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], assignee: { kind: 'coworker', id: 'zz' } }, context).map((o) => o.id),
    [],
  );
});

test('filterServiceOrders: due (overdue · this week · none)', () => {
  const context = { machines: MACHINES, today: TODAY };
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], due: ['overdue'] }, context).map((o) => o.id),
    ['a'],
  );
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], due: ['this-week'] }, context).map((o) => o.id),
    ['b'],
  );
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], due: ['none'] }, context).map((o) => o.id),
    ['c'],
  );
  assert.equal(SO_DUE_FILTERS.length, 3);
});

test('filterServiceOrders: created date range uses the CreatedAt day', () => {
  const context = { machines: MACHINES, today: TODAY };
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], createdFrom: '2026-10-15', createdTo: '2026-10-21' }, context).map((o) => o.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], createdFrom: '2026-10-01', createdTo: '2026-10-02' }, context).map((o) => o.id),
    ['b'],
  );
  assert.deepEqual(
    filterServiceOrders(ORDERS, { status: [], createdFrom: '2026-11-01' }, context).map((o) => o.id),
    [],
  );
  // A record without createdAt falls back to the reported date.
  assert.deepEqual(
    filterServiceOrders(
      [{ id: 'd', status: 'open', reportedAt: '2026-10-16', createdAt: null }],
      { status: [], createdFrom: '2026-10-16', createdTo: '2026-10-16' },
      context,
    ).map((o) => o.id),
    ['d'],
  );
});

test('LABELS.category covers the seven SPEC categories', () => {
  assert.deepEqual(WORK_ORDER_CATEGORIES, [
    'mechanical',
    'electrical',
    'pneumatic',
    'facility',
    'safety',
    'cleaning',
    'other',
  ]);
  for (const category of WORK_ORDER_CATEGORIES) {
    assert.ok(LABELS.category[category], `label for ${category}`);
  }
});

/* --- Static source checks (app.js, styles.css, db.js, sync.js, sw.js) ------ */

test('app.js: service order filters persist per device with Clear all', () => {
  const src = read('app.js');
  assert.match(src, /const SO_FILTERS_KEY = 'maint-log:so-filters';/);
  assert.match(src, /function loadSOFilters\(\)/);
  assert.match(src, /function saveSOFilters\(filters\)/);
  assert.match(src, /'Clear all'/);
  assert.match(src, /function removeSOFilterValue\(filters, key, value\)/);
  // The panel opens as a phone bottom sheet and a desktop popover.
  assert.match(src, /function openSOFiltersPanel\(\)/);
  assert.match(src, /filter-sheet/);
  assert.match(src, /filter-popover/);
});

test('app.js: list view has the view switch, pager and new table columns', () => {
  const src = read('app.js');
  assert.match(src, /const SO_VIEWS = \['list', 'board', 'calendar'\]/);
  assert.match(src, /const SO_VIEW_KEY = 'maint-log:so-view';/);
  assert.match(src, /const SO_PAGE_SIZES = \[25, 50, 100\];/);
  assert.match(src, /const SO_PAGE_SIZE_KEY = 'maint-log:so-page-size';/);
  for (const label of ["'Number'", "'Assigned to'", "'Labour h'", "'Age (days)'", "'Priority'"]) {
    assert.ok(src.includes(label), `jobs table column label ${label}`);
  }
  assert.match(src, /function jobsTableColumns\(\)/);
});

test('app.js: board columns, drag-and-drop and Move to… menu', () => {
  const src = read('app.js');
  assert.match(src, /function soBoardBody\(filtered\)/);
  assert.match(src, /function soBoardColumn\(status, orders\)/);
  assert.match(src, /'Move to…'/);
  assert.match(src, /function openSOMoveMenu\(button, order\)/);
  assert.match(src, /dragstart/);
  assert.match(src, /addEventListener\('drop',/);
  assert.match(src, /Done · last \$\{SO_DONE_DAYS\} days/);
  // Status changes go through the normal save path.
  assert.match(src, /async function changeOrderStatus\(order, status\)/);
  assert.match(src, /persistWorkOrderSave\(order, \{ \.\.\.order, status \}, \{\}\)/);
});

test('app.js: calendar month grid with +N more overflow', () => {
  const src = read('app.js');
  assert.match(src, /function soCalendarBody\(filtered\)/);
  assert.match(src, /const CAL_MAX_PER_DAY = 3;/);
  assert.match(src, /\`\+\$\{overflow\} more\`/);
  assert.match(src, /'← Previous'/);
  assert.match(src, /'Next →'/);
  assert.match(src, /'Today'/);
});

test('app.js: sectioned form with assign/checklist/labour/attachments', () => {
  const src = read('app.js');
  assert.match(src, /function workOrderFormBody\(/);
  assert.match(src, /return \{ node: form, isDirty: \(\) => dirty \};/);
  assert.match(src, /function createAssigneeEditor\(/);
  assert.match(src, /function createChecklistEditor\(/);
  assert.match(src, /function createLabourEditor\(/);
  assert.match(src, /function createAttachmentsEditor\(/);
  for (const text of ["'Basics'", "'Problem'", "'Assign'", "'Checklist'", "'Labour'", "'Parts used'", "'Attachments'", "'Action taken'", "'Requested by'"]) {
    assert.ok(src.includes(text), `form section ${text}`);
  }
});

test('app.js: checklist editor reorder/tick/remove; labour 0.25 steps', () => {
  const src = read('app.js');
  assert.match(src, /`Move "\$\{item\.text\}" up`/);
  assert.match(src, /`Move "\$\{item\.text\}" down`/);
  assert.match(src, /`Remove "\$\{item\.text\}"`/);
  assert.match(src, /const MAX_CHECKLIST = 50;/);
  assert.match(src, /step: '0\.25'/);
  assert.match(src, /const MAX_LABOUR = 200;/);
});

test('app.js: attachments upload via POST /api/files with X-File-Name + downscale', () => {
  const src = read('app.js');
  assert.match(src, /const FILE_UPLOAD_OFFLINE = 'Uploading needs a connection to the server\.';/);
  assert.match(src, /const IMAGE_UPLOAD_MAX_DIM = 1600;/);
  assert.match(src, /const IMAGE_UPLOAD_JPEG_QUALITY = 0\.82;/);
  assert.match(src, /'\/api\/files'/);
  assert.match(src, /'X-File-Name': encodeURIComponent\(file\.name \|\| 'uploads?'\)/);
  assert.match(src, /async function downscaleImageForUpload\(file, mime\)/);
  assert.match(src, /'image\/jpeg',\s+IMAGE_UPLOAD_JPEG_QUALITY,/);
});

test('app.js: form opens in the drawer on desktop, full page below 1024 px', () => {
  const src = read('app.js');
  assert.match(src, /function maybeOpenJobDrawer\(route\)/);
  assert.match(src, /openDrawer\(\{ title: 'New service order', content: node, isDirty \}\)/);
  assert.match(src, /openDrawer\(\{ title: 'Edit service order', content: node, isDirty \}\)/);
  assert.match(src, /cancelTo: null/);
});

test('app.js: phone cards show number, priority badge, status, machine, due', () => {
  const src = read('app.js');
  assert.match(src, /function soPhoneCard\(order\)/);
  assert.match(src, /formatOrderNumber\(order\.number\)/);
  assert.match(src, /priorityBadge\(order\.priority\)/);
  assert.match(src, /due\.text/);
});

test('app.js: people come from the synced stores and the users cache', () => {
  const src = read('app.js');
  assert.match(src, /function assignablePeople\(\)/);
  assert.match(src, /'No coworkers yet - add them in People\.'/);
  assert.match(src, /state\.coworkers/);
  assert.match(src, /state\.contractors/);
  assert.match(src, /teamUsers/);
});

test('db.js + sync.js: coworkers and contractors sync as record stores', () => {
  const dbSrc = read('db.js');
  // v4 (SPEC-v4.md section 2): DB_VERSION 4 created purchaseRequests;
  // v4 (SPEC-v4.md section 4.1): 5 creates the libraryItems store.
  assert.match(dbSrc, /const DB_VERSION = 5;/);
  assert.match(dbSrc, /'coworkers'/);
  assert.match(dbSrc, /'contractors'/);
  assert.match(dbSrc, /'purchaseRequests'/);
  assert.match(dbSrc, /'libraryItems'/);
  const syncSrc = read('sync.js');
  assert.match(
    syncSrc,
    /const RECORD_STORES = \['machines', 'parts', 'workOrders', 'pmTasks', 'coworkers', 'contractors', 'purchaseRequests', 'libraryItems'\];/,
  );
});

test('app.js + index.html: no user-visible job wording left', () => {
  const src = read('app.js');
  assert.ok(!src.includes("label: 'Open jobs'"), 'the machines column says Open orders');
  assert.match(src, /label: 'Open orders'/);
  const html = read('index.html');
  assert.ok(!/>Open jobs</.test(html));
});

test('styles.css: phone bottom bar keeps Prev. Maint. on one line at 390 px', () => {
  const css = read('styles.css');
  assert.match(css, /\.tab \{[\s\S]*?white-space: nowrap;[\s\S]*?\}/);
  assert.match(css, /letter-spacing: -0\.01em;/);
});

test('styles.css: board, calendar, filter chips and priority badges exist', () => {
  const css = read('styles.css');
  for (const selector of [
    '.view-switch',
    '.filter-chip',
    '.clear-all',
    '.filter-popover',
    '.board',
    '.board-column',
    '.board-list.is-drop-target',
    '.move-menu',
    '.cal-grid',
    '.cal-cell.is-today',
    '.cal-more',
    '.avatar',
    '.avatar-stack',
    '.priority-urgent',
    '.attach-grid',
    '.labour-row',
    '.check-edit-row',
    '.pager',
  ]) {
    assert.ok(css.includes(`${selector} `), `css rule ${selector}`);
  }
});

test('sw.js: CACHE_VERSION bumped for the new shell', () => {
  const src = read('sw.js');
  // At least the version this milestone shipped; later fixes bump it further.
  assert.ok(Number(src.match(/const CACHE_VERSION = (\d+);/)?.[1]) >= 13);
});

test('help.js: documents the views, filters and the new form sections', () => {
  const src = read('help.js');
  assert.match(src, /\['Board view',/);
  assert.match(src, /\['Calendar view',/);
  assert.match(src, /\['Priority',/);
  assert.match(src, /\['Labour hours',/);
  assert.match(src, /\['Attachment',/);
  assert.match(src, /Filter and find service orders/);
  assert.match(src, /Track labour hours/);
  assert.match(src, /Attach photos and PDFs/);
  // The rendered Help keeps rendering with the module contract.
  const stubH = () => ({ children: [], attrs: {} });
  const rendered = renderHelp(stubH);
  assert.equal(typeof rendered, 'object');
  assert.ok(rendered);
});