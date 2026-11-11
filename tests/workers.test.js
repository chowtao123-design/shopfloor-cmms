// workerProfiles over the real API: accepted, validated, and writable only
// with floorMap Write.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { startServer } from '../server/server.js';

const TMP = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const XRW = { 'X-Requested-With': 'maint-log' };
let handle;

async function login(username, password) {
  const res = await fetch(`${handle.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ username, password }),
  });
  return res.headers.getSetCookie().find((value) => value.startsWith('sid=')).split(';')[0];
}

const put = (cookie, id, data) =>
  fetch(`${handle.url}/api/records/workerProfiles/${id}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ data }),
  });

before(async () => {
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(TMP, 'workers-test-')) });
  handle.store.createUser({ username: 'sue', displayName: 'Sue Supervisor', role: 'tech', passwordHash: auth.hashPassword('sue-password-1') });
  handle.store.createUser({ username: 'vic', displayName: 'Vic Viewer', roleId: handle.store.getRoleByName('Viewer').id, passwordHash: auth.hashPassword('vic-password-1') });
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
});

test('workerProfiles: saved with defaults, bad values refused, viewers read-only', async () => {
  const sue = await login('sue', 'sue-password-1');
  const vic = await login('vic', 'vic-password-1');
  const id = crypto.randomUUID();

  const ok = await put(sue, id, { empId: '524', skillsExpert: ['binder'], efficiency: 92, quality: 'good' });
  assert.equal(ok.status, 200);
  const saved = (await ok.json()).record.data;
  assert.deepEqual(saved.skillsGood, []);
  assert.equal(saved.phone, '');
  assert.equal(saved.locker, '');

  const contact = await put(sue, crypto.randomUUID(), { empId: '600', phone: '416-555-0100', locker: 'B-17' });
  assert.equal(contact.status, 200);
  assert.equal((await contact.json()).record.data.locker, 'B-17');
  assert.equal((await put(sue, crypto.randomUUID(), { empId: '601', locker: 'x'.repeat(21) })).status, 400);
  assert.equal(saved.dailyOutput, 0);

  assert.equal((await put(sue, crypto.randomUUID(), { empId: '1', efficiency: 999 })).status, 400);
  assert.equal((await put(sue, crypto.randomUUID(), { empId: '1', quality: 'superb' })).status, 400);
  assert.equal((await put(sue, crypto.randomUUID(), { name: 'no id' })).status, 400);
  assert.equal((await put(vic, crypto.randomUUID(), { empId: '2' })).status, 403);

  const changes = await (await fetch(`${handle.url}/api/changes?since=0`, { headers: { cookie: vic } })).json();
  assert.ok(changes.records.some((r) => r.store === 'workerProfiles' && r.id === id), 'viewers receive profiles');
});

test('skill updates: one level per machine type, validated, notes dated', async () => {
  const { withSkill, skillUpdateFields } = await import('../logic-map.js');
  assert.deepEqual(withSkill({ skillsExpert: ['binder'], skillsGood: ['single-needle'] }, 'binder', 'learning'), {
    skillsExpert: [],
    skillsGood: ['single-needle'],
    skillsLearning: ['binder'],
  });
  assert.deepEqual(withSkill({ skillsGood: ['binder'] }, 'binder', ''), { skillsExpert: [], skillsGood: [], skillsLearning: [] });
  const fields = skillUpdateFields({ skillsGood: ['bartack'], notes: 'old' }, { empId: '524', skills: { bartack: 'expert' }, efficiency: '91.6', note: 'week 45' });
  assert.deepEqual(fields.skillsExpert, ['bartack']);
  assert.equal(fields.efficiency, 92);
  assert.match(fields.notes, /^old\n\d{4}-\d{2}-\d{2}: week 45$/);
  assert.match(skillUpdateFields({}, { empId: '1', skills: { laser: 'expert' } }), /unknown machine type/);
  assert.match(skillUpdateFields({}, { empId: '1', skills: { binder: 'master' } }), /unknown level/);
  assert.match(skillUpdateFields({}, { empId: '1', efficiency: 500 }), /efficiency must be/);
  assert.equal(skillUpdateFields({}, { empId: '1' }), 'nothing to change');
});

test('POST /api/ai/apply-skills: creates or merges profiles, reports bad rows, writers only', async () => {
  const sue = await login('sue', 'sue-password-1');
  const vic = await login('vic', 'vic-password-1');
  const post = (cookie, body) =>
    fetch(`${handle.url}/api/ai/apply-skills`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', ...XRW },
      body: JSON.stringify(body),
    });
  assert.equal((await post(vic, { updates: [{ empId: '524', skills: { binder: 'good' } }] })).status, 403);
  const res = await post(sue, {
    updates: [
      { empId: '524', skills: { binder: 'good', bartack: 'learning' }, efficiency: 88 },
      { empId: '901', skills: { 'overlock-5': 'expert' } },
      { empId: '902', skills: { laser: 'expert' } },
    ],
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.applied, 2);
  assert.match(body.results[2].error, /unknown machine type/);
  const profiles = handle.store.listRecords('workerProfiles');
  const p524 = profiles.find((r) => r.data.empId === '524');
  assert.deepEqual(p524.data.skillsExpert, []);
  assert.deepEqual(p524.data.skillsGood, ['binder']);
  assert.equal(p524.data.efficiency, 88);
  assert.equal(p524.data.phone, '', 'other fields kept');
  assert.ok(profiles.some((r) => r.data.empId === '901' && r.data.skillsExpert.includes('overlock-5')), 'new profile created');
});

test('roles: hidden pages are stored per role, validated, and sent with /api/me', async () => {
  const s = handle.store;
  s.createUser({ username: 'ada', displayName: 'Ada Admin', role: 'admin', passwordHash: auth.hashPassword('ada-password-1') });
  const ada = await login('ada', 'ada-password-1');
  const call = (method, url, body) =>
    fetch(`${handle.url}${url}`, { method, headers: { cookie: ada, 'content-type': 'application/json', ...XRW }, body: body && JSON.stringify(body) });

  const bad = await call('POST', '/api/roles', { name: 'Bad', permissions: {}, hiddenPages: ['nope'] });
  assert.equal(bad.status, 400);
  const created = await call('POST', '/api/roles', { name: 'Supervisor', permissions: { serviceOrders: 'write', machines: 'read' }, hiddenPages: ['machines', 'mapEdit'] });
  assert.equal(created.status, 201);
  const role = await created.json();
  assert.deepEqual(role.hiddenPages, ['machines', 'mapEdit']);

  const patched = await call('PATCH', `/api/roles/${role.id}`, { hiddenPages: ['machines', 'pm'] });
  assert.equal(patched.status, 200);
  assert.deepEqual((await patched.json()).hiddenPages, ['machines', 'pm']);

  s.createUser({ username: 'sam', displayName: 'Sam Supervisor', roleId: role.id, passwordHash: auth.hashPassword('sam-password-1') });
  const sam = await login('sam', 'sam-password-1');
  const me = await (await fetch(`${handle.url}/api/me`, { headers: { cookie: sam } })).json();
  assert.deepEqual(me.hiddenPages, ['machines', 'pm']);
  assert.equal(me.permissions.machines, 'read', 'the data stays readable for the service order form');

  const admin = s.getRoleByName('Administrator');
  assert.equal((await call('PATCH', `/api/roles/${admin.id}`, { hiddenPages: ['jobs'] })).status, 409);
});

test('qcRecords: saved with defaults, bad values refused, viewers read-only', async () => {
  const sue = await login('sue', 'sue-password-1');
  const vic = await login('vic', 'vic-password-1');
  const putQc = (cookie, data) =>
    fetch(`${handle.url}/api/records/qcRecords/${crypto.randomUUID()}`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json', ...XRW },
      body: JSON.stringify({ data }),
    });
  const ok = await putQc(sue, { date: '2026-11-10', empId: '524', checked: 120, defects: 3, defectTypes: ['Puckering'], result: 'rework' });
  assert.equal(ok.status, 200);
  const saved = (await ok.json()).record.data;
  assert.equal(saved.inspector, '');
  assert.equal(saved.workerName, '');
  assert.equal(saved.style, '', 'style and PO are optional');
  assert.equal(saved.po, '');
  const withOrder = await putQc(sue, { date: '2026-11-10', empId: '524', checked: 50, style: '3084WT', po: '110115' });
  assert.equal(withOrder.status, 200);
  const order = (await withOrder.json()).record.data;
  assert.deepEqual([order.style, order.po], ['3084WT', '110115']);
  assert.equal((await putQc(sue, { date: '2026-11-10', empId: '524', checked: 5, po: 'x'.repeat(41) })).status, 400);
  assert.equal((await putQc(sue, { date: '2026-11-10', empId: '524', checked: 0 })).status, 400, 'at least one piece');
  assert.equal((await putQc(sue, { date: '2026-11-10', empId: '524', checked: 10, result: 'great' })).status, 400);
  assert.equal((await putQc(sue, { empId: '524', checked: 10 })).status, 400, 'date required');
  assert.equal((await putQc(vic, { date: '2026-11-10', empId: '524', checked: 10 })).status, 403);
});
