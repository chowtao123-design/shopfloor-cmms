'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import * as auth from '../server/auth.js';
import { startServer } from '../server/server.js';

/**
 * V3-M1 server tests (SPEC-v3.md sections 2, 5, 6, 8 server parts):
 * service order fields and numbering, cowork/contractor stores with the
 * admin-only hourlyRate, the files API (type/size/magic bytes/headers),
 * the branding API (admin-only writes, public GET, logo rules) and backup
 * inclusion of the files/ folder.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const XRW = { 'X-Requested-With': 'maint-log' };
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const pngBytes = (extra = 32) => Buffer.concat([PNG_MAGIC, Buffer.alloc(extra, 0x42)]);
const jpegBytes = (extra = 32) => Buffer.concat([JPEG_MAGIC, Buffer.alloc(extra, 0x41)]);

const uuid = () => crypto.randomUUID();

let handle;
let base;
let anna; // admin
let ben; // tech
let pat; // contractors Write without the contractorRates permission

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

const history = (token, storeName, id) => api(token, `/api/history/${storeName}/${id}`);
const changes = (token, since = 0, limit = 1000) =>
  api(token, `/api/changes?since=${since}&limit=${limit}`);

async function postBody(token, pathname, { contentType, body, fileName, method = 'POST' } = {}) {
  const headers = {
    ...(token === null ? {} : { cookie: `sid=${token}` }),
    ...XRW,
    'content-type': contentType,
  };
  if (fileName !== undefined) headers['x-file-name'] = encodeURIComponent(fileName);
  const res = await fetch(`${base}${pathname}`, { method, headers, body });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, body: json };
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v3-server-test-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  base = handle.url;
  handle.store.createUser({
    username: 'anna',
    displayName: 'Anna Admin',
    role: 'admin',
    passwordHash: auth.hashPassword('anna-password-1'),
  });
  handle.store.createUser({
    username: 'ben',
    displayName: 'Ben Bolt',
    role: 'tech',
    passwordHash: auth.hashPassword('ben-password-1'),
  });
  // A role that can edit contractors but has no contractorRates access, for
  // the rate rules (SPEC-v3.md 13.1).
  const ratelessRole = handle.store.createRole({
    name: 'Rateless',
    permissions: { contractors: 'write' },
    updatedBy: null,
  });
  handle.store.createUser({
    username: 'pat',
    displayName: 'Pat Rateless',
    roleId: ratelessRole.id,
    passwordHash: auth.hashPassword('pat-password-1'),
  });
  anna = await login('anna', 'anna-password-1');
  ben = await login('ben', 'ben-password-1');
  pat = await login('pat', 'pat-password-1');
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Service order fields (SPEC-v3.md section 2)
// ---------------------------------------------------------------------------

test('work order priority: default medium, legacy normal stored as medium, new enum accepted', async () => {
  const orders = [];
  for (const priority of [undefined, 'normal', 'none', 'low', 'medium', 'high', 'urgent']) {
    const id = uuid();
    const data = { title: `Order ${String(priority)}`, machineId: 'm1' };
    if (priority !== undefined) data.priority = priority;
    const { res, body } = await put(anna, 'workOrders', id, data);
    assert.equal(res.status, 200, `priority ${String(priority)} must be accepted`);
    const expected = priority === undefined || priority === 'normal' ? 'medium' : priority;
    assert.equal(body.record.data.priority, expected, `priority ${String(priority)} stores as ${expected}`);
    orders.push(id);
  }

  const bad = await put(anna, 'workOrders', uuid(), { title: 'Bad', machineId: 'm1', priority: 'critical' });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.body.error, 'bad_request');

  const legacy = await changes(anna);
  const legacyRecord = legacy.body.records.find((record) => record.id === orders[1]);
  assert.equal(legacyRecord.data.priority, 'medium', 'legacy normal is stored as medium');
});

test('work order new fields round-trip with their exact limits', async () => {
  const full = {
    title: 'Belt snapped on quilting head',
    machineId: 'm1',
    kind: 'breakdown',
    priority: 'high',
    status: 'open',
    category: 'mechanical',
    reportedAt: '2026-10-21',
    dueDate: '2026-10-28',
    requestedBy: 'Line supervisor Priya',
    problem: 'Loud bang then stop',
    assignees: [
      { kind: 'user', id: 'u-anna' },
      { kind: 'coworker', id: uuid() },
      { kind: 'contractor', id: uuid() },
    ],
    labour: [
      { id: uuid(), kind: 'coworker', personId: uuid(), date: '2026-10-21', hours: 2.25, note: 'Stripped the head' },
      { id: uuid(), kind: 'user', personId: 'u-anna', date: '2026-10-22', hours: 0.5, note: '' },
    ],
    checklist: [
      { id: uuid(), text: 'Lock out the machine', done: true },
      { id: uuid(), text: 'Check belt tension', done: false },
    ],
    partsUsed: [{ partId: 'p1', qty: 1 }],
    attachments: [
      { fileId: uuid(), name: 'fault-photo.png', mime: 'image/png', size: 2048 },
    ],
    minutesSpent: 0,
    downtimeMinutes: 45,
  };
  const id = uuid();
  const { res, body } = await put(anna, 'workOrders', id, full);
  assert.equal(res.status, 200);
  const data = body.record.data;
  assert.equal(data.category, 'mechanical');
  assert.equal(data.dueDate, '2026-10-28');
  assert.equal(data.requestedBy, 'Line supervisor Priya');
  assert.equal(data.assignees.length, 3);
  assert.equal(data.assignees[0].kind, 'user');
  assert.deepEqual(data.labour[0], full.labour[0]);
  assert.deepEqual(data.checklist[1], full.checklist[1]);
  assert.deepEqual(data.attachments[0], full.attachments[0]);
  // Checklist `done` defaults to false when omitted.
  const minimal = await put(anna, 'workOrders', uuid(), {
    title: 'Minimal checklist',
    machineId: 'm1',
    checklist: [{ id: uuid(), text: 'Inspect' }],
  });
  assert.equal(minimal.res.status, 200);
  assert.deepEqual(minimal.body.record.data.checklist, [{ id: minimal.body.record.data.checklist[0].id, text: 'Inspect', done: false }]);

  // Null due date is fine.
  const nullDue = await put(anna, 'workOrders', uuid(), {
    title: 'No due date',
    machineId: 'm1',
    dueDate: null,
  });
  assert.equal(nullDue.res.status, 200);
  assert.equal(nullDue.body.record.data.dueDate, null);
});

test('work order new fields reject bad values and unknown fields', async () => {
  const cases = [
    [{ title: 'x', machineId: 'm1', category: 'hydraulic' }, 'category enum'],
    [{ title: 'x', machineId: 'm1', dueDate: '2026-02-30' }, 'dueDate real date'],
    [{ title: 'x', machineId: 'm1', requestedBy: 'x'.repeat(81) }, 'requestedBy length'],
    [{ title: 'x', machineId: 'm1', assignee: 'nope' }, 'unknown field'],
    [{ title: 'x', machineId: 'm1', assignees: [{ kind: 'robot', id: 'a' }] }, 'assignee kind'],
    [{ title: 'x', machineId: 'm1', assignees: [{ kind: 'user', id: 'a', role: 'x' }] }, 'assignee unknown field'],
    [{ title: 'x', machineId: 'm1', assignees: Array.from({ length: 11 }, () => ({ kind: 'user', id: 'a' })) }, 'assignees limit'],
    [{ title: 'x', machineId: 'm1', labour: [{ id: 'l', kind: 'user', personId: 'p', date: '2026-10-21', hours: 0.2 }] }, 'hours step'],
    [{ title: 'x', machineId: 'm1', labour: [{ id: 'l', kind: 'user', personId: 'p', date: '2026-10-21', hours: 24.25 }] }, 'hours range'],
    [{ title: 'x', machineId: 'm1', labour: [{ id: 'l', kind: 'user', personId: 'p', date: '2026-10-21', hours: 0 }] }, 'hours minimum'],
    [{ title: 'x', machineId: 'm1', labour: [{ id: 'l', kind: 'user', personId: 'p', date: '2026-10-21', hours: 1.5, note: 'n'.repeat(201) }] }, 'labour note length'],
    [{ title: 'x', machineId: 'm1', labour: Array.from({ length: 201 }, () => ({ id: 'l', kind: 'user', personId: 'p', date: '2026-10-21', hours: 1 })) }, 'labour limit'],
    [{ title: 'x', machineId: 'm1', checklist: [{ id: 'c', text: 't'.repeat(201), done: false }] }, 'checklist text length'],
    [{ title: 'x', machineId: 'm1', checklist: Array.from({ length: 51 }, () => ({ id: 'c', text: 't', done: false })) }, 'checklist limit'],
    [{ title: 'x', machineId: 'm1', attachments: [{ fileId: 'f', name: 'n', mime: 'image/png', size: 10, extra: 1 }] }, 'attachment unknown field'],
    [{ title: 'x', machineId: 'm1', attachments: Array.from({ length: 21 }, () => ({ fileId: 'f', name: 'n', mime: 'image/png', size: 10 })) }, 'attachments limit'],
  ];
  for (const [data, label] of cases) {
    const result = await put(anna, 'workOrders', uuid(), data);
    assert.equal(result.res.status, 400, `${label} must be rejected`);
    assert.equal(result.body.error, 'bad_request');
  }

  // Sanity: 10 assignees, 200 labour and 50 checklist entries are accepted.
  const okData = {
    title: 'At the limits',
    machineId: 'm1',
    assignees: Array.from({ length: 10 }, () => ({ kind: 'coworker', id: uuid() })),
    labour: Array.from({ length: 200 }, () => ({
      id: uuid(),
      kind: 'coworker',
      personId: 'p',
      date: '2026-10-21',
      hours: 24,
      note: '',
    })),
    checklist: Array.from({ length: 50 }, () => ({ id: uuid(), text: 'Do it', done: true })),
  };
  const ok = await put(anna, 'workOrders', uuid(), okData);
  assert.equal(ok.res.status, 200, 'entry counts at the exact limits are accepted');
});

// ---------------------------------------------------------------------------
// Service order numbering (SPEC-v3.md section 2, V3-M1 item 2)
// ---------------------------------------------------------------------------

test('workOrders.number is server-assigned, sequential and unchangeable', async () => {
  const first = await put(anna, 'workOrders', uuid(), { title: 'First', machineId: 'm1' });
  assert.equal(first.res.status, 200);
  assert.ok(Number.isInteger(first.body.record.data.number), 'create assigns an integer number');

  // A client-provided number on create is ignored.
  const withNumber = await put(anna, 'workOrders', uuid(), {
    title: 'Try to set number',
    machineId: 'm1',
    number: 999,
  });
  assert.equal(withNumber.res.status, 200);
  assert.equal(withNumber.body.record.data.number, first.body.record.data.number + 1);
  assert.notEqual(withNumber.body.record.data.number, 999);

  // The number is stable across updates and cannot be changed by clients.
  const updated = await put(
    anna,
    'workOrders',
    withNumber.body.record.id,
    { title: 'Renamed', machineId: 'm1', number: 42 },
    1
  );
  assert.equal(updated.res.status, 200);
  assert.equal(updated.body.record.data.number, withNumber.body.record.data.number);
  assert.equal(updated.body.record.data.title, 'Renamed');

  const second = await put(anna, 'workOrders', uuid(), { title: 'Next', machineId: 'm1' });
  assert.equal(second.body.record.data.number, withNumber.body.record.data.number + 1, 'sequential');
});

test('concurrent creates get distinct sequential numbers', async () => {
  const count = 12;
  const results = await Promise.all(
    Array.from({ length: count }, () =>
      put(anna, 'workOrders', uuid(), { title: 'Concurrent', machineId: 'm1' })
    )
  );
  const numbers = results.map((result) => {
    assert.equal(result.res.status, 200);
    return result.body.record.data.number;
  });
  assert.equal(new Set(numbers).size, count, 'every concurrent create gets a distinct number');
  const sorted = [...numbers].sort((a, b) => a - b);
  const expected = Array.from({ length: count }, (_, index) => sorted[0] + index);
  assert.deepEqual(sorted, expected, 'the numbers form a gap-free run');
});

test('a pre-v3 work order without a stored number gets one on its next save', async () => {
  const legacyId = uuid();
  handle.store.transaction(() => {
    handle.store.upsertRecord({
      store: 'workOrders',
      id: legacyId,
      data: JSON.stringify({ title: 'Pre-v3 order', machineId: 'm1', priority: 'normal' }),
      version: 1,
      deleted: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: handle.store.getUserByUsername('anna').id,
      seq: handle.store.nextSeq(),
    });
  });
  const { res, body } = await put(anna, 'workOrders', legacyId, {
    title: 'Pre-v3 order, saved again',
    machineId: 'm1',
    priority: 'normal',
  });
  assert.equal(res.status, 200);
  assert.ok(Number.isInteger(body.record.data.number), 'legacy records gain a number on save');
  assert.equal(body.record.data.priority, 'medium', 'legacy normal becomes medium on save');
});

// ---------------------------------------------------------------------------
// Coworkers and contractors (SPEC-v3.md section 5)
// ---------------------------------------------------------------------------

test('coworkers store: field rules, defaults and history', async () => {
  const id = uuid();
  const { res, body } = await put(anna, 'coworkers', id, {
    name: 'Priya Kaur',
    role: 'Line supervisor',
    phone: '+44 7700 900123',
    email: 'priya@example.com',
    shift: 'day',
    skills: 'Juki single needle, timing, thread paths',
    linkedUserId: null,
    notes: 'Works mornings',
  });
  assert.equal(res.status, 200);
  assert.equal(body.record.store, 'coworkers');
  assert.equal(body.record.data.active, true, 'active defaults to true');

  const hist = await history(anna, 'coworkers', id);
  assert.equal(hist.res.status, 200);
  assert.equal(hist.body[0].action, 'create');
  assert.equal(hist.body[0].after.name, 'Priya Kaur');

  const invalid = [
    [{ role: 'Mechanic' }, 'name required'],
    [{ name: '   ' }, 'name non-empty'],
    [{ name: 'x'.repeat(81) }, 'name length'],
    [{ name: 'ok', role: 'r'.repeat(61) }, 'role length'],
    [{ name: 'ok', shift: 'graveshift' }, 'shift enum'],
    [{ name: 'ok', skills: 's'.repeat(201) }, 'skills length'],
    [{ name: 'ok', height: '180cm' }, 'unknown field'],
  ];
  for (const [data, label] of invalid) {
    const result = await put(anna, 'coworkers', uuid(), data);
    assert.equal(result.res.status, 400, `${label} must be rejected`);
  }

  for (const shift of ['day', 'evening', 'night', 'rotating', 'other']) {
    const shiftOk = await put(anna, 'coworkers', uuid(), { name: `Shift ${shift}`, shift });
    assert.equal(shiftOk.res.status, 200, `shift ${shift} accepted`);
  }
});

test('contractors.hourlyRate needs the contractorRates permission: hidden in changes/history, kept on writes without it', async () => {
  const contractorId = uuid();
  const created = await put(anna, 'contractors', contractorId, {
    company: 'Juki Service Ltd',
    trade: 'Juki service',
    contactName: 'Marco Bell',
    phone: '+44 7700 900555',
    email: 'marco@example.com',
    hourlyRate: 85.5,
    machineIds: ['m1', 'm2'],
    notes: 'Quarterly service',
  });
  assert.equal(created.res.status, 200);
  assert.equal(created.body.record.data.hourlyRate, 85.5, 'admin sees the rate');

  // A PUT without contractorRates Write that includes hourlyRate keeps the
  // stored value (SPEC-v3.md 13.1).
  const patUpdate = await put(pat, 'contractors', contractorId, {
    company: 'Juki Service Ltd',
    trade: 'Juki service + presses',
    contactName: 'Marco Bell',
    phone: '+44 7700 900555',
    email: 'marco@example.com',
    hourlyRate: 1,
    machineIds: ['m1', 'm2'],
    notes: 'Quarterly service',
  });
  assert.equal(patUpdate.res.status, 200);
  assert.equal(patUpdate.body.record.data.hourlyRate, undefined, 'PUT response hides the rate without Read');

  const adminFeed = await changes(anna);
  const contractor = adminFeed.body.records.find((record) => record.id === contractorId);
  assert.equal(contractor.data.hourlyRate, 85.5, 'the stored rate is unchanged by the no-Write PUT');

  const patFeed = await changes(pat);
  const patContractor = patFeed.body.records.find((record) => record.id === contractorId);
  assert.equal(patContractor.data.hourlyRate, undefined, 'changes omits the rate without Read');
  assert.ok(!('hourlyRate' in patContractor.data));

  const benFeed = await changes(ben);
  const benContractor = benFeed.body.records.find((record) => record.id === contractorId);
  assert.equal(benContractor.data.hourlyRate, 85.5, 'the Technician role has rates Write and sees the rate');

  const adminHistory = await history(anna, 'contractors', contractorId);
  assert.equal(adminHistory.res.status, 200);
  assert.ok(
    adminHistory.body.every((entry) => entry.after !== null && entry.after.hourlyRate === 85.5),
    'history shows the rate with Read'
  );

  const patHistory = await history(pat, 'contractors', contractorId);
  assert.equal(patHistory.res.status, 200);
  assert.ok(patHistory.body.length >= 2, 'history has the create and update entries');
  assert.ok(
    patHistory.body.every(
      (entry) =>
        (entry.before === null || !('hourlyRate' in entry.before)) &&
        !('hourlyRate' in entry.after)
    ),
    'history without Read omits the rate from before/after'
  );

  // Admin can change the rate; zero is allowed; bad rates are rejected.
  const adminSet = await put(anna, 'contractors', contractorId, {
    company: 'Juki Service Ltd',
    trade: 'Juki service + presses',
    machineIds: ['m1'],
    hourlyRate: 90,
  });
  assert.equal(adminSet.res.status, 200);
  assert.equal(adminSet.body.record.data.hourlyRate, 90);

  const zeroRate = await put(anna, 'contractors', uuid(), {
    company: 'Zero Rate HVAC',
    trade: 'HVAC',
    hourlyRate: 0,
  });
  assert.equal(zeroRate.res.status, 200);
  assert.equal(zeroRate.body.record.data.hourlyRate, 0);

  for (const rate of [-1, '85', null]) {
    const badRate = await put(anna, 'contractors', uuid(), { company: 'Bad Rate', hourlyRate: rate });
    assert.equal(badRate.res.status, 400, `hourlyRate ${JSON.stringify(rate)} must be rejected`);
  }

  // A create without contractorRates Write cannot sneak a rate in.
  const patCreate = await put(pat, 'contractors', uuid(), {
    company: 'Pat Electric',
    trade: 'Electrician',
    hourlyRate: 500,
  });
  assert.equal(patCreate.res.status, 200);
  const patCreatedId = patCreate.body.record.id;
  const checkFeed = await changes(anna);
  const patCreated = checkFeed.body.records.find((record) => record.id === patCreatedId);
  assert.equal(patCreated.data.hourlyRate, undefined, 'a create without Write stores no rate');

  // Field rules for contractors.
  const invalid = [
    [{ trade: 'HVAC' }, 'company required'],
    [{ company: 'c'.repeat(81) }, 'company length'],
    [{ company: 'ok', trade: 't'.repeat(61) }, 'trade length'],
    [{ company: 'ok', vat: 'yes' }, 'unknown field'],
  ];
  for (const [data, label] of invalid) {
    const result = await put(anna, 'contractors', uuid(), data);
    assert.equal(result.res.status, 400, `${label} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// Files API (SPEC-v3.md section 6)
// ---------------------------------------------------------------------------

test('POST /api/files stores allowed types with magic-byte checks', async () => {
  const png = await postBody(anna, '/api/files', {
    contentType: 'image/png',
    fileName: 'Broken needle.png',
    body: pngBytes(64),
  });
  assert.equal(png.res.status, 201);
  assert.equal(png.body.mime, 'image/png');
  assert.equal(png.body.name, 'Broken needle.png', 'X-File-Name is URL-decoded');
  assert.equal(png.body.size, PNG_MAGIC.length + 64);
  assert.match(png.body.fileId, UUID_RE);

  const pdf = await postBody(anna, '/api/files', {
    contentType: 'application/pdf',
    fileName: 'service-report.pdf',
    body: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(16)]),
  });
  assert.equal(pdf.res.status, 201);
  assert.equal(pdf.body.mime, 'application/pdf');

  const webp = await postBody(anna, '/api/files', {
    contentType: 'image/webp',
    fileName: 'press.webp',
    body: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]),
  });
  assert.equal(webp.res.status, 201);

  const jpeg = await postBody(anna, '/api/files', {
    contentType: 'image/jpeg',
    fileName: 'hook.jpg',
    body: jpegBytes(16),
  });
  assert.equal(jpeg.res.status, 201);

  // Mismatched magic bytes: declared png but jpeg contents.
  const mismatch = await postBody(anna, '/api/files', {
    contentType: 'image/png',
    fileName: 'not-really.png',
    body: jpegBytes(16),
  });
  assert.equal(mismatch.res.status, 415, 'magic-byte mismatch is 415');

  const notImage = await postBody(anna, '/api/files', {
    contentType: 'text/plain',
    fileName: 'notes.txt',
    body: Buffer.from('hello'),
  });
  assert.equal(notImage.res.status, 415, 'disallowed Content-Type is 415');

  const html = await postBody(anna, '/api/files', {
    contentType: 'image/svg+xml',
    fileName: 'evil.svg',
    body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  });
  assert.equal(html.res.status, 415, 'SVG is not an allowed file type');

  const noName = await postBody(anna, '/api/files', {
    contentType: 'image/png',
    body: pngBytes(8),
  });
  assert.equal(noName.res.status, 400, 'X-File-Name is required');

  const empty = await postBody(anna, '/api/files', {
    contentType: 'image/png',
    fileName: 'empty.png',
    body: Buffer.alloc(0),
  });
  assert.equal(empty.res.status, 415, 'an empty body cannot match the declared type');

  const unauth = await postBody(null, '/api/files', {
    contentType: 'image/png',
    fileName: 'anon.png',
    body: pngBytes(8),
  });
  assert.equal(unauth.res.status, 401, 'uploads need a session');
});

test('POST /api/files rejects bodies above 15 MB with 413', async () => {
  const tooBig = Buffer.concat([PNG_MAGIC, Buffer.alloc(15 * 1024 * 1024 - PNG_MAGIC.length + 1)]);
  const res = await postBody(anna, '/api/files', {
    contentType: 'image/png',
    fileName: 'huge.png',
    body: tooBig,
  });
  assert.equal(res.res.status, 413);

  const exactlyFifteenMB = await postBody(anna, '/api/files', {
    contentType: 'image/png',
    fileName: 'max.png',
    body: Buffer.concat([PNG_MAGIC, Buffer.alloc(15 * 1024 * 1024 - PNG_MAGIC.length)]),
  });
  assert.equal(exactlyFifteenMB.res.status, 201, 'exactly 15 MB is accepted');
});

test('GET /api/files/:id streams with nosniff, sandbox and inline disposition', async () => {
  const bytes = pngBytes(40);
  const upload = await postBody(anna, '/api/files', {
    contentType: 'image/png',
    fileName: 'Streamed photo.png',
    body: bytes,
  });
  assert.equal(upload.res.status, 201);

  const res = await fetch(`${base}/api/files/${upload.body.fileId}`, {
    headers: { cookie: `sid=${anna}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), 'sandbox');
  assert.equal(res.headers.get('content-disposition'), 'inline; filename="Streamed photo.png"');
  const streamed = Buffer.from(await res.arrayBuffer());
  assert.ok(streamed.equals(bytes));

  // Signed-in users only.
  const anon = await fetch(`${base}/api/files/${upload.body.fileId}`);
  assert.equal(anon.status, 401);

  // Unknown and non-UUID ids are 404; no directory listing.
  const missing = await api(anna, `/api/files/${uuid()}`);
  assert.equal(missing.res.status, 404);
  const notUuid = await api(anna, '/api/files/definitely-not-a-uuid');
  assert.equal(notUuid.res.status, 404);
  const traversal = await api(anna, '/api/files/..%2f..%2fserver');
  assert.equal(traversal.res.status, 404);

  // The uploaded file can be attached to a service order.
  const attach = await put(anna, 'workOrders', uuid(), {
    title: 'Photo of the fault',
    machineId: 'm1',
    attachments: [
      { fileId: upload.body.fileId, name: upload.body.name, mime: upload.body.mime, size: upload.body.size },
    ],
  });
  assert.equal(attach.res.status, 200);
  assert.equal(attach.body.record.data.attachments[0].fileId, upload.body.fileId);
});

test('files are recorded in the files table with sha256', async () => {
  const bytes = pngBytes(24);
  const upload = await postBody(anna, '/api/files', {
    contentType: 'image/png',
    fileName: 'hashed.png',
    body: bytes,
  });
  assert.equal(upload.res.status, 201);
  const row = handle.store.getFileById(upload.body.fileId);
  assert.equal(row.name, 'hashed.png');
  assert.equal(row.mime, 'image/png');
  assert.equal(Number(row.size), bytes.length);
  assert.equal(
    row.sha256,
    crypto.createHash('sha256').update(bytes).digest('hex'),
    'sha256 of the stored bytes'
  );
  const onDisk = fs.readFileSync(path.join(handle.config.dataDir, 'files', upload.body.fileId));
  assert.ok(onDisk.equals(bytes), 'bytes are stored at DATA_DIR/files/<uuid>');
});

// ---------------------------------------------------------------------------
// Branding (SPEC-v3.md section 8)
// ---------------------------------------------------------------------------

test('GET /api/branding is public and returns name, logoUrl and version', async () => {
  const res = await fetch(`${base}/api/branding`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['logoUrl', 'name', 'version']);
  assert.equal(body.name, 'Shopfloor CMMS');
  assert.equal(body.logoUrl, null);
  assert.equal(body.version, PACKAGE_VERSION);
});

test('PUT /api/branding is admin-only with name 1-40 validation', async () => {
  const denied = await api(ben, '/api/branding', { method: 'PUT', body: { name: 'Ben CMMS' } });
  assert.equal(denied.res.status, 403);
  assert.equal(denied.body.error, 'forbidden');

  const set = await api(anna, '/api/branding', { method: 'PUT', body: { name: '  Acme CMMS  ' } });
  assert.equal(set.res.status, 200);
  assert.equal(set.body.name, 'Acme CMMS', 'the name is trimmed');

  const publicGet = await fetch(`${base}/api/branding`);
  assert.equal((await publicGet.json()).name, 'Acme CMMS', 'public GET reflects the change');

  const tooLong = await api(anna, '/api/branding', {
    method: 'PUT',
    body: { name: 'x'.repeat(41) },
  });
  assert.equal(tooLong.res.status, 400);
  const empty = await api(anna, '/api/branding', { method: 'PUT', body: { name: '   ' } });
  assert.equal(empty.res.status, 400);
  const notString = await api(anna, '/api/branding', { method: 'PUT', body: { name: 7 } });
  assert.equal(notString.res.status, 400);
  const unknownField = await api(anna, '/api/branding', {
    method: 'PUT',
    body: { name: 'Fine', logoUrl: '/evil' },
  });
  assert.equal(unknownField.res.status, 400);

  const restore = await api(anna, '/api/branding', {
    method: 'PUT',
    body: { name: 'Shopfloor CMMS' },
  });
  assert.equal(restore.res.status, 200);
});

test('branding logo: admin-only upload, image types only, no SVG, 512 KB limit', async () => {
  // Non-admin upload is forbidden.
  const denied = await postBody(ben, '/api/branding/logo', {
    contentType: 'image/png',
    body: pngBytes(16),
  });
  assert.equal(denied.res.status, 403);

  // SVG is rejected.
  const svg = await postBody(anna, '/api/branding/logo', {
    contentType: 'image/svg+xml',
    body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  });
  assert.equal(svg.res.status, 415, 'SVG logos are rejected');

  // Above 512 KB is rejected.
  const tooBig = Buffer.concat([PNG_MAGIC, Buffer.alloc(512 * 1024 - PNG_MAGIC.length + 1)]);
  const oversize = await postBody(anna, '/api/branding/logo', {
    contentType: 'image/png',
    body: tooBig,
  });
  assert.equal(oversize.res.status, 413);

  // Mismatched magic bytes are rejected.
  const mismatch = await postBody(anna, '/api/branding/logo', {
    contentType: 'image/png',
    body: jpegBytes(16),
  });
  assert.equal(mismatch.res.status, 415);

  // A real PNG becomes the logo and is served publicly.
  const logoBytes = pngBytes(96);
  const set = await postBody(anna, '/api/branding/logo', {
    contentType: 'image/png',
    body: logoBytes,
  });
  assert.equal(set.res.status, 200);
  // Each upload gets its own URL (?v=<file id>) so browsers never show a cached old logo.
  assert.match(set.body.logoUrl, /^\/api\/branding\/logo\?v=[\w-]+$/);
  assert.equal(set.body.name, 'Shopfloor CMMS');

  const publicLogo = await fetch(`${base}${set.body.logoUrl}`);
  assert.equal(publicLogo.status, 200, 'the logo is public (login screen needs it)');
  assert.equal(publicLogo.headers.get('content-type'), 'image/png');
  assert.equal(publicLogo.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(publicLogo.headers.get('content-security-policy'), 'sandbox');
  assert.equal(publicLogo.headers.get('content-disposition'), 'inline; filename="logo.png"');
  assert.ok(Buffer.from(await publicLogo.arrayBuffer()).equals(logoBytes));

  const branding = await fetch(`${base}/api/branding`);
  assert.equal((await branding.json()).logoUrl, set.body.logoUrl);

  // Replacing the logo keeps one logo only.
  const replace = await postBody(anna, '/api/branding/logo', {
    contentType: 'image/webp',
    body: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]),
  });
  assert.equal(replace.res.status, 200);
  assert.match(replace.body.logoUrl, /^\/api\/branding\/logo\?v=[\w-]+$/);
  assert.notEqual(replace.body.logoUrl, set.body.logoUrl, 'a new logo gets a new URL');
  const logoSetting = handle.store.getSetting('branding.logoFileId');
  assert.match(logoSetting, UUID_RE);

  // Reset: DELETE removes the logo.
  const reset = await api(anna, '/api/branding/logo', { method: 'DELETE' });
  assert.equal(reset.res.status, 200);
  assert.equal(reset.body.logoUrl, null);
  const afterReset = await fetch(`${base}/api/branding/logo`);
  assert.equal(afterReset.status, 404);
  const brandingAfter = await fetch(`${base}/api/branding`);
  assert.equal((await brandingAfter.json()).logoUrl, null);
});

// ---------------------------------------------------------------------------
// Backups include the files folder (SPEC-v3.md section 6)
// ---------------------------------------------------------------------------

test('backups include the files table and copy files/ next to the backup', async () => {
  const bytes = pngBytes(120);
  const upload = await postBody(anna, '/api/files', {
    contentType: 'image/png',
    fileName: 'backup-me.png',
    body: bytes,
  });
  assert.equal(upload.res.status, 201);

  const backup = await api(anna, '/api/backups', { method: 'POST' });
  assert.equal(backup.res.status, 200);
  const backupFile = backup.body.file;
  assert.match(backupFile, /\.db$/);

  const backupsDir = path.join(handle.config.dataDir, 'backups');
  const dbPath = path.join(backupsDir, backupFile);
  assert.ok(fs.existsSync(dbPath), 'the backup .db exists');

  // The files/ folder is copied next to the backup.
  const filesCopy = path.join(backupsDir, `${backupFile}.files`);
  const copiedFile = path.join(filesCopy, upload.body.fileId);
  assert.ok(fs.existsSync(copiedFile), 'files/ is copied as <backup>.files/');
  assert.ok(fs.readFileSync(copiedFile).equals(bytes), 'the copied bytes match');

  // The files table row is inside the backed-up database.
  const copiedDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = copiedDb.prepare('SELECT * FROM files WHERE id = ?').get(upload.body.fileId);
    assert.ok(row !== undefined, 'the files table travels in the backup db');
    assert.equal(row.name, 'backup-me.png');
    assert.equal(Number(row.size), bytes.length);
  } finally {
    copiedDb.close();
  }
});