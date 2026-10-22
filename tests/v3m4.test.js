'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { startServer } from '../server/server.js';
import { buildPMCompletionOrder } from '../logic.js';
import { renderHelp } from '../help.js';

/**
 * V3-M4 (SPEC-v3.md sections 4 and 6): PM drawer fields, the Mark done flow
 * and machine photos/manuals. The server part adds the new pmTasks fields
 * (priority with the legacy `normal` mapping, estimatedHours, category,
 * assignees, checklist, attachments) and machines.attachments; valid values
 * are accepted, invalid ones rejected. The pure completion builder is
 * unit-tested; browser parts are checked as static source (see v3m3.test.js).
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const XRW = { 'X-Requested-With': 'maint-log' };
const uuid = () => crypto.randomUUID();

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBytes = (extra = 40) => Buffer.concat([PNG_MAGIC, Buffer.alloc(extra, 0x42)]);
const pdfBytes = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(40, 0x43)]);

const read = (name) => fs.readFileSync(path.join(REPO, name), 'utf8');

let handle;
let base;
let anna; // admin: every area Write

function setCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single === null ? [] : [single];
}

async function login(username, password) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ username, password }),
  });
  const sidCookie = setCookies(res).find((value) => value.startsWith('sid='));
  assert.ok(sidCookie, `login failed for ${username}`);
  return sidCookie.split(';')[0].slice('sid='.length);
}

async function api(token, pathname, { method = 'GET', body } = {}) {
  const headers = {
    ...(token === null ? {} : { cookie: `sid=${token}` }),
    ...XRW,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, body: json };
}

const put = (token, storeName, id, data, baseVersion) =>
  api(token, `/api/records/${storeName}/${id}`, {
    method: 'PUT',
    body: { data, ...(baseVersion === undefined ? {} : { baseVersion }) },
  });

async function uploadFile(token, { contentType, fileName, body }) {
  const res = await fetch(`${base}/api/files`, {
    method: 'POST',
    headers: {
      cookie: `sid=${token}`,
      ...XRW,
      'content-type': contentType,
      'x-file-name': encodeURIComponent(fileName),
    },
    body,
  });
  assert.equal(res.status, 201, `file upload failed: ${fileName}`);
  return res.json();
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v3m4-test-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  base = handle.url;
  handle.store.createUser({
    username: 'anna',
    displayName: 'Ana Admin',
    role: 'admin',
    passwordHash: auth.hashPassword('anna-password-1'),
  });
  anna = await login('anna', 'anna-password-1');
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// pmTasks: the new fields (SPEC-v3.md section 4)
// ---------------------------------------------------------------------------

test('pmTasks: priority, estimatedHours, category, assignees, checklist and attachments are accepted', async () => {
  const machineId = uuid();
  const photo = await uploadFile(anna, {
    contentType: 'image/png',
    fileName: 'hook-page.png',
    body: pngBytes(),
  });
  const manual = await uploadFile(anna, {
    contentType: 'application/pdf',
    fileName: 'ddl8700-manual.pdf',
    body: pdfBytes(),
  });
  const id = uuid();
  const data = {
    title: 'Oil hook and check timing',
    machineId,
    intervalDays: 30,
    instructions: 'Oil the hook; check the timing.',
    priority: 'high',
    estimatedHours: 1.5,
    category: 'mechanical',
    assignees: [
      { kind: 'coworker', id: 'cw-1' },
      { kind: 'contractor', id: 'ct-1' },
    ],
    checklist: [
      { id: 'c1', text: 'Oil the hook', done: false },
      { id: 'c2', text: 'Check timing', done: true },
    ],
    attachments: [
      { fileId: photo.fileId, name: photo.name, mime: photo.mime, size: photo.size },
      { fileId: manual.fileId, name: manual.name, mime: manual.mime, size: manual.size },
    ],
  };
  const { res, body } = await put(anna, 'pmTasks', id, data);
  assert.equal(res.status, 200);
  assert.equal(body.record.version, 1);
  assert.equal(body.record.data.priority, 'high');
  assert.equal(body.record.data.estimatedHours, 1.5);
  assert.equal(body.record.data.category, 'mechanical');
  assert.deepEqual(body.record.data.assignees, data.assignees);
  assert.deepEqual(body.record.data.checklist, data.checklist);
  assert.deepEqual(body.record.data.attachments, data.attachments);
  assert.equal(body.record.data.active, true); // unchanged default

  // Updates keep working: clear the estimate with null, drop the category.
  const { res: res2, body: body2 } = await put(anna, 'pmTasks', id, {
    ...body.record.data,
    estimatedHours: null,
    priority: 'low',
    assignees: [],
    checklist: [],
    attachments: [],
  }, 1);
  assert.equal(res2.status, 200);
  assert.equal(body2.record.version, 2);
  assert.equal(body2.record.data.estimatedHours, null);
  assert.equal(body2.record.data.priority, 'low');
  assert.deepEqual(body2.record.data.assignees, []);
});

test('pmTasks: legacy priority normal is stored as medium; default is medium', async () => {
  const legacy = await put(anna, 'pmTasks', uuid(), {
    title: 'Clean lint trap',
    machineId: uuid(),
    intervalDays: 7,
    priority: 'normal',
  });
  assert.equal(legacy.res.status, 200);
  assert.equal(legacy.body.record.data.priority, 'medium');

  const fresh = await put(anna, 'pmTasks', uuid(), {
    title: 'Wipe feed dogs',
    machineId: uuid(),
    intervalDays: 14,
  });
  assert.equal(fresh.res.status, 200);
  assert.equal(fresh.body.record.data.priority, 'medium', 'default priority is medium');
  assert.ok(
    !('estimatedHours' in fresh.body.record.data),
    'no estimatedHours in the data when none was sent',
  );
  assert.ok(!('category' in fresh.body.record.data), 'no category when none was sent');
});

test('pmTasks: quarter-hour estimatedHours steps and bounds', async () => {
  const base = { title: 'Belt check', machineId: uuid(), intervalDays: 21 };
  for (const estimatedHours of [0.25, 2.75, 1000]) {
    const ok = await put(anna, 'pmTasks', uuid(), { ...base, estimatedHours });
    assert.equal(ok.res.status, 200, `estimatedHours ${estimatedHours} should be accepted`);
  }
  for (const estimatedHours of [0, 0.1, 0.3, 1000.25, 1001, -1]) {
    const bad = await put(anna, 'pmTasks', uuid(), { ...base, estimatedHours });
    assert.equal(bad.res.status, 400, `estimatedHours ${estimatedHours} should be rejected`);
  }
  const asString = await put(anna, 'pmTasks', uuid(), { ...base, estimatedHours: '1.5' });
  assert.equal(asString.res.status, 400, 'estimatedHours must be a number');
});

test('pmTasks: invalid priority, category, assignees, checklist and attachments are rejected', async () => {
  const base = { title: 'Bad task', machineId: uuid(), intervalDays: 7 };
  const checks = [
    { priority: 'critical' },
    { priority: null },
    { category: 'plumbing' },
    { category: '' },
    { estimatedHours: 'x' },
    { assignees: [{ kind: 'alien', id: 'x' }] },
    { assignees: [{ kind: 'user' }] },
    {
      assignees: Array.from({ length: 11 }, (_, index) => ({ kind: 'user', id: `u${index}` })),
    },
    { checklist: [{ id: 'c1', done: false }] },
    { checklist: [{ id: 'c1', text: '' }] },
    {
      checklist: Array.from({ length: 51 }, (_, index) => ({
        id: `c${index}`,
        text: `Step ${index}`,
        done: false,
      })),
    },
    { attachments: [{ fileId: 'f1', name: 'x.png', mime: 'image/png' }] },
    { attachments: [{ fileId: 'f1', name: 'x.png', mime: 'image/png', size: -1 }] },
    { attachments: [{ fileId: 'f1', name: 'x.png', mime: 'image/png', size: 1, kind: 'photo' }] },
    {
      attachments: Array.from({ length: 21 }, (_, index) => ({
        fileId: `f${index}`,
        name: `x${index}.png`,
        mime: 'image/png',
        size: 1,
      })),
    },
  ];
  for (const extra of checks) {
    const { res } = await put(anna, 'pmTasks', uuid(), { ...base, ...extra });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(extra)}`);
  }
});

// ---------------------------------------------------------------------------
// machines.attachments (SPEC-v3.md sections 4 and 6)
// ---------------------------------------------------------------------------

test('machines: attachments with photos and manuals are accepted', async () => {
  const photo = await uploadFile(anna, {
    contentType: 'image/webp',
    fileName: 'juki-12.webp',
    body: Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]),
      Buffer.from([0x57, 0x45, 0x42, 0x50]),
      Buffer.alloc(24, 0x44),
    ]),
  });
  const manual = await uploadFile(anna, {
    contentType: 'application/pdf',
    fileName: 'juki-manual.pdf',
    body: pdfBytes(),
  });
  const attachments = [photo, manual].map((file) => ({
    fileId: file.fileId,
    name: file.name,
    mime: file.mime,
    size: file.size,
  }));
  const { res, body } = await put(anna, 'machines', uuid(), {
    name: 'Juki DDL-8700 #12',
    type: 'single-needle',
    status: 'running',
    attachments,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(body.record.data.attachments, attachments);
});

test('machines: invalid attachments are rejected, no attachments still fine', async () => {
  const plain = await put(anna, 'machines', uuid(), {
    name: 'Bartack #3',
    type: 'bartack',
  });
  assert.equal(plain.res.status, 200);
  assert.ok(!('attachments' in plain.body.record.data));

  const badMime = await put(anna, 'machines', uuid(), {
    name: 'Nope',
    type: 'other',
    typeLabel: 'Piping machine',
    attachments: [{ fileId: 'f1', name: 'x.bin', size: 1 }],
  });
  assert.equal(badMime.res.status, 400);

  const tooMany = await put(anna, 'machines', uuid(), {
    name: 'Many manuals',
    type: 'building',
    attachments: Array.from({ length: 21 }, (_, index) => ({
      fileId: `f${index}`,
      name: `m${index}.pdf`,
      mime: 'application/pdf',
      size: 2,
    })),
  });
  assert.equal(tooMany.res.status, 400);
});

// ---------------------------------------------------------------------------
// buildPMCompletionOrder (SPEC-v3.md section 4: "Mark done")
// ---------------------------------------------------------------------------

test('buildPMCompletionOrder copies priority, category, assignees and the ticked checklist', () => {
  const task = {
    id: 'pt-1',
    title: 'Oil hook and check timing',
    machineId: 'm-1',
    intervalDays: 30,
    priority: 'normal', // legacy value reads as medium
    category: 'mechanical',
    assignees: [
      { kind: 'coworker', id: 'cw-1' },
      { kind: 'contractor', id: 'ct-1' },
    ],
    checklist: [
      { id: 'c1', text: 'Oil the hook', done: false },
      { id: 'c2', text: 'Check timing', done: true },
    ],
    instructions: 'Oil the hook; check the timing.',
    lastDoneAt: '2026-09-21',
    active: true,
  };
  const { order, task: updatedTask, labourPerson } = buildPMCompletionOrder(
    task,
    { id: 'u-1', displayName: 'Ana' },
    '2026-10-21',
    { id: 'wo-1', now: '2026-10-21T10:00:00.000Z' },
  );
  assert.equal(order.id, 'wo-1');
  assert.equal(order.title, 'Oil hook and check timing');
  assert.equal(order.machineId, 'm-1');
  assert.equal(order.kind, 'pm');
  assert.equal(order.status, 'done');
  assert.equal(order.priority, 'medium');
  assert.equal(order.category, 'mechanical');
  assert.deepEqual(order.assignees, [
    { kind: 'coworker', id: 'cw-1' },
    { kind: 'contractor', id: 'ct-1' },
  ]);
  assert.deepEqual(order.checklist, [
    { id: 'c1', text: 'Oil the hook', done: true },
    { id: 'c2', text: 'Check timing', done: true },
  ]);
  assert.equal(order.actionTaken, 'Oil the hook; check the timing.');
  assert.equal(order.reportedAt, '2026-10-21');
  assert.equal(order.completedAt, '2026-10-21');
  assert.equal(order.pmTaskId, 'pt-1');
  assert.equal(order.createdAt, '2026-10-21T10:00:00.000Z');
  assert.deepEqual(order.labour, [], 'labour comes from the optional hours dialog');
  assert.equal(updatedTask.lastDoneAt, '2026-10-21');
  assert.equal(task.lastDoneAt, '2026-09-21', 'the input task is not mutated');
  assert.deepEqual(labourPerson, { kind: 'user', id: 'u-1' });
});

test('buildPMCompletionOrder defaults, absent category and no user', () => {
  const task = { id: 'pt-2', title: 'Clean lint trap', machineId: 'm-2', intervalDays: 7 };
  const result = buildPMCompletionOrder(task, null, '2026-10-21', {
    id: 'wo-2',
    now: '2026-10-21T08:30:00.000Z',
  });
  assert.equal(result.order.priority, 'medium', 'no priority given defaults to medium');
  assert.ok(!('category' in result.order), 'no category when the task has none');
  assert.deepEqual(result.order.assignees, []);
  assert.deepEqual(result.order.checklist, []);
  assert.equal(result.labourPerson, null, 'local mode has no default labour person');
  assert.equal(result.order.actionTaken, '');

  const urgent = buildPMCompletionOrder(
    { ...task, priority: 'urgent' },
    null,
    '2026-10-21',
    { id: 'wo-3' },
  );
  assert.equal(urgent.order.priority, 'urgent');
  const none = buildPMCompletionOrder(
    { ...task, priority: 'none' },
    null,
    '2026-10-21',
    { id: 'wo-4' },
  );
  assert.equal(none.order.priority, 'none', 'explicit none is copied as-is');
});

test('buildPMCompletionOrder caps assignees at 10 and checklist at 50', () => {
  const task = {
    id: 'pt-3',
    title: 'Big service',
    machineId: 'm-3',
    intervalDays: 90,
    assignees: Array.from({ length: 12 }, (_, index) => ({ kind: 'user', id: `u${index}` })),
    checklist: Array.from({ length: 52 }, (_, index) => ({
      id: `c${index}`,
      text: `Step ${index}`,
      done: false,
    })),
  };
  const { order } = buildPMCompletionOrder(task, { id: 'u-9' }, '2026-10-21', { id: 'wo-5' });
  assert.equal(order.assignees.length, 10);
  assert.equal(order.checklist.length, 50);
  assert.ok(order.checklist.every((item) => item.done === true));
});

// ---------------------------------------------------------------------------
// Static source checks (client)
// ---------------------------------------------------------------------------

test('app.js: PM task form sections with drawer on desktop', () => {
  const src = read('app.js');
  assert.match(src, /function pmTaskFormBody\(/);
  assert.match(src, /function maybeOpenPMDrawer\(route\)/);
  assert.match(
    src,
    /openDrawer\(\{ title: existing \? 'Edit PM task' : 'New PM task', content: node, isDirty \}\)/,
  );
  assert.match(src, /const pmDrawer = maybeOpenPMDrawer\(route\);/);
  for (const text of [
    "'Checklist template'",
    "'Estimated hours'",
    "'Instructions'",
    "'Attachments'",
    "'Last done'",
    'value: String(Math.max(1, Math.floor(Number(base.intervalDays) || 30)))',
  ]) {
    assert.ok(src.includes(text), `pm form has ${text}`);
  }
});

test('app.js: desktop PM table with Priority, Assigned to, Est. hours, Interval, Due, State', () => {
  const src = read('app.js');
  assert.match(src, /function pmTableColumns\(\)/);
  assert.match(src, /pm: \{ key: null, dir: 'asc' \}/);
  assert.match(src, /function pmRowState\(task/);
  assert.match(src, /function pmStatePill\(task/);
  for (const label of ["'Task'", "'Machine'", "'Priority'", "'Assigned to'", "'Est. hours'", "'Interval'", "'Due'", "'State'"]) {
    assert.ok(src.includes(label), `pm table column ${label}`);
  }
  // Phone keeps the grouped cards.
  assert.match(src, /groups\.overdue\.length \? pmGroupSection\('Overdue'/);
  assert.match(src, /pausedPMGroupSection\('Paused – machine in storage or retired'/);
});

test('app.js: mark done builds the completion order and asks for labour hours', () => {
  const src = read('app.js');
  assert.match(src, /buildPMCompletionOrder\(task, teamUser, today\)/);
  assert.match(src, /function showPMLabourDialog\(defaultPerson\)/);
  assert.match(src, /'Finish without hours'/);
  assert.match(src, /if \(entry\) order\.labour = \[entry\];/);
  assert.match(src, /sync\.saveRecord\('pmTasks', updatedTask, task\.version\)/);
  assert.match(src, /sync\.saveRecord\('workOrders', order, null\)/);
});

test('app.js: permissions hide create/edit/Mark done and the upload button', () => {
  const src = read('app.js');
  // V3-M9: the ad-hoc helpers became the one can(area, level) check.
  assert.match(src, /function can\(area, level = 'read'\)/);
  assert.match(src, /function isReadOnly\(area\)/);
  // Upload is hidden without the files write permission.
  assert.match(src, /const canUpload = can\('files', 'write'\);/);
  assert.match(src, /'View only — you need the Photos \& files write permission to upload\.'/);
  // Mark done needs pm + serviceOrders write (SPEC-v3.md 13.1).
  assert.match(src, /can\('pm', 'write'\) && can\('serviceOrders', 'write'\)/);
  // PM and machine entry points are gated.
  assert.match(src, /can\('pm', 'write'\)/);
  assert.match(src, /can\('machines', 'write'\)/);
  // The old helper names are gone (replaced by can(), SPEC-v3.md 13.3).
  assert.doesNotMatch(src, /function areaLevel\(area\)/);
  assert.doesNotMatch(src, /function canWriteArea\(area\)/);
  assert.doesNotMatch(src, /function canMarkPMDone\(\)/);
  assert.doesNotMatch(src, /function canViewArea\(area\)/);
});

test('app.js: machine photos and manuals reuse the shared attachments helper', () => {
  const src = read('app.js');
  assert.match(src, /sectionTitle\('Photos and manuals'\)/);
  assert.match(src, /sectionTitle\('Photos'\)/);
  assert.match(src, /sectionTitle\('Manuals'\)/);
  assert.match(src, /function machinePhotos\(machine\)/);
  assert.match(src, /function machineManuals\(machine\)/);
  assert.match(src, /function machineManualsNode\(machine\)/);
  assert.match(src, /attachmentsEditor = createAttachmentsEditor\(base\.attachments \|\| \[\]\)/);
  assert.match(src, /attachments: attachmentsEditor\.getAttachments\(\)/);
  // Not duplicated: there is exactly one attachments editor helper.
  assert.equal((src.match(/function createAttachmentsEditor\(/g) || []).length, 1);
});

test('styles.css: manual list and PM form section styles', () => {
  const css = read('styles.css');
  for (const selector of ['.manual-list', '.manual-item', '.manual-name', '.pm-form .section-title']) {
    assert.ok(css.includes(`${selector} `), `css rule ${selector}`);
  }
});

test('help.js: documents the PM drawer flow and machine manuals', () => {
  const src = read('help.js');
  assert.match(src, /Keep machine photos and manuals/);
  assert.match(src, /PM checklist template/);
  assert.match(src, /Estimated hours/);
  assert.match(src, /\['Manuals',/);
  assert.match(src, /optional labour hours \(person \+ hours\)/);
  const stubH = () => ({ children: [], attrs: {} });
  const rendered = renderHelp(stubH);
  assert.equal(typeof rendered, 'object');
  assert.ok(rendered);
});

test('sw.js: CACHE_VERSION bumped for the new shell', () => {
  const src = read('sw.js');
  // At least the version this milestone shipped; later fixes bump it further.
  assert.ok(Number(src.match(/const CACHE_VERSION = (\d+);/)?.[1]) >= 15);
});