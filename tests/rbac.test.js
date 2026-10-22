'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import * as auth from '../server/auth.js';
import { can } from '../server/permissions.js';
import { openStore } from '../server/store.js';
import { startServer } from '../server/server.js';

/**
 * V3-M1b RBAC server tests (SPEC-v3.md section 13): migration from the old
 * admin/tech split, the can() matrix, 403s per route family, hidden stores
 * in the changes feed, contractor rate rules, role CRUD with history, the
 * Administrator/safety rules, and permissions taking effect on the next
 * request without signing out (13.4).
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const XRW = { 'X-Requested-With': 'maint-log' };
const uuid = () => crypto.randomUUID();
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBytes = (extra = 32) => Buffer.concat([PNG_MAGIC, Buffer.alloc(extra, 0x42)]);

function assertForbidden(body, area, needed) {
  assert.ok(body && typeof body === 'object');
  assert.equal(body.error, 'forbidden');
  assert.equal(body.area, area, 'names the permission area');
  assert.equal(body.needed, needed, 'names the needed level');
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0);
}

// ---------------------------------------------------------------------------
// Migration and built-in defaults (SPEC-v3.md 13.1, 13.2)
// ---------------------------------------------------------------------------

test('migration seeds the built-in roles, maps legacy users and keeps the role column readable', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'rbac-migrate-'));
  try {
    // The v2 users table (no role_id); other tables are created by openStore.
    const db = new DatabaseSync(path.join(dataDir, 'maint.db'));
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','tech')),
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    const insert = db.prepare(
      'INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
    );
    insert.run(uuid(), 'heidi', 'Heidi Head', 'x', 'admin', new Date().toISOString());
    insert.run(uuid(), 'tom', 'Tom Tool', 'x', 'tech', new Date().toISOString());
    db.close();

    const store = openStore(dataDir);
    try {
      const heidi = store.getUserByUsername('heidi');
      const tom = store.getUserByUsername('tom');
      assert.equal(heidi.role, 'admin', 'the legacy column is still readable');
      assert.equal(tom.role, 'tech');
      assert.equal(heidi.role_name, 'Administrator', 'legacy admin maps to Administrator');
      assert.equal(tom.role_name, 'Technician', 'legacy tech maps to Technician');
      assert.equal(heidi.role_id, store.getRoleByName('Administrator').id);
      assert.equal(tom.role_id, store.getRoleByName('Technician').id);
      assert.notEqual(store.getRoleByName('Viewer'), null, 'the Viewer role is seeded too');

      // A role history row is written for each role created by the migration.
      const seeded = store.db
        .prepare("SELECT COUNT(*) c FROM history WHERE store = 'roles' AND action = 'create'")
        .get();
      assert.equal(Number(seeded.c), 3);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('fresh databases get exactly the three built-in roles with the 13.1 levels', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'rbac-fresh-'));
  try {
    const store = openStore(dataDir);
    try {
      const names = store.listRoles().map((role) => role.name).sort();
      assert.deepEqual(names, ['Administrator', 'Technician', 'Viewer']);

      assert.deepEqual(JSON.parse(store.getRoleByName('Administrator').permissions), {
        serviceOrders: 'write',
        pm: 'write',
        machines: 'write',
        parts: 'write',
        coworkers: 'write',
        contractors: 'write',
        contractorRates: 'write',
        statistics: 'write',
        files: 'write',
        backups: 'write',
        aiAssistant: 'write',
        settings: 'write',
        admin: 'write',
      });
      assert.deepEqual(JSON.parse(store.getRoleByName('Technician').permissions), {
        serviceOrders: 'write',
        pm: 'write',
        machines: 'write',
        parts: 'write',
        coworkers: 'write',
        contractors: 'write',
        contractorRates: 'write',
        files: 'write',
        aiAssistant: 'write',
        statistics: 'read',
        backups: 'read',
        settings: 'none',
        admin: 'none',
      });
      assert.deepEqual(JSON.parse(store.getRoleByName('Viewer').permissions), {
        serviceOrders: 'read',
        pm: 'read',
        machines: 'read',
        parts: 'read',
        coworkers: 'read',
        contractors: 'read',
        contractorRates: 'none',
        statistics: 'read',
        files: 'read',
        backups: 'none',
        aiAssistant: 'none',
        settings: 'none',
        admin: 'none',
      });
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// can() level matrix (SPEC-v3.md 13.1)
// ---------------------------------------------------------------------------

test('can(): none hides, read views, write implies read; unknown area/level throw', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'rbac-can-'));
  try {
    const store = openStore(dataDir);
    try {
      const storeless = store.createRole({ name: 'Nobody', permissions: {}, updatedBy: null });
      const readerRole = store.createRole({ name: 'Reader', permissions: { machines: 'read' }, updatedBy: null });
      const writerRole = store.createRole({ name: 'Writer', permissions: { machines: 'write' }, updatedBy: null });

      assert.equal(can({ store, roleId: storeless.id }, 'machines', 'read'), false);
      assert.equal(can({ store, roleId: storeless.id }, 'machines', 'write'), false);
      assert.equal(can(null, 'machines', 'read'), false);
      assert.equal(can({ store, roleId: null }, 'machines', 'read'), false);
      assert.equal(can({ store, roleId: 'missing-role' }, 'machines', 'read'), false);

      const reader = { store, roleId: readerRole.id };
      assert.equal(can(reader, 'machines', 'read'), true);
      assert.equal(can(reader, 'machines', 'write'), false, 'read does not grant write');
      assert.equal(can(reader, 'parts', 'read'), false, 'other areas stay none');

      const writer = { store, roleId: writerRole.id };
      assert.equal(can(writer, 'machines', 'read'), true, 'write implies read');
      assert.equal(can(writer, 'machines', 'write'), true);

      assert.throws(() => can(writer, 'bogusArea', 'read'), /unknown permission area/);
      assert.throws(() => can(writer, 'machines', 'sometimes'), /unknown permission level/);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTP fixtures
// ---------------------------------------------------------------------------

let handle;
let base;

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
  assert.ok(res.ok, `login failed for ${username}`);
  const sidCookie = setCookies(res).find((value) => value.startsWith('sid='));
  assert.ok(sidCookie, `login set no session cookie for ${username}`);
  return sidCookie.split(';')[0].slice('sid='.length);
}

async function api(token, pathname, { method = 'GET', body, contentType, fileName } = {}) {
  const headers = {
    ...(token === null ? {} : { cookie: `sid=${token}` }),
    ...XRW,
    ...(body === undefined ? {} : { 'content-type': contentType ?? 'application/json' }),
    ...(fileName === undefined ? {} : { 'x-file-name': encodeURIComponent(fileName) }),
  };
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    ...(body === undefined
      ? {}
      : {
          body:
            typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array
              ? body
              : JSON.stringify(body),
        }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

const put = (token, storeName, id, data) =>
  api(token, `/api/records/${storeName}/${id}`, { method: 'PUT', body: { data, baseVersion: null } });
const del = (token, storeName, id) => api(token, `/api/records/${storeName}/${id}`, { method: 'DELETE' });
const historyOf = (token, storeName, id) => api(token, `/api/history/${storeName}/${id}`);
const changes = (token) => api(token, '/api/changes');

async function createRole(rootToken, name, permissions, extra = {}) {
  const created = await api(rootToken, '/api/roles', {
    method: 'POST',
    body: { name, permissions, ...extra },
  });
  assert.equal(created.res.status, 201, `role "${name}" created: ${JSON.stringify(created.json)}`);
  return created.json;
}

async function createUser(rootToken, { username, displayName, roleId, role }) {
  const created = await api(rootToken, '/api/users', {
    method: 'POST',
    body: { username, displayName, password: `${username}-password-1`, ...(roleId ? { roleId } : { role }) },
  });
  assert.equal(created.res.status, 201, `user "${username}" created: ${JSON.stringify(created.json)}`);
  return created.json;
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'rbac-test-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  base = handle.url;
  handle.store.createUser({
    username: 'root',
    displayName: 'Root Admin',
    role: 'admin',
    passwordHash: auth.hashPassword('root-password-1'),
  });
  handle.store.createUser({
    username: 'tom',
    displayName: 'Tom Tool',
    role: 'tech',
    passwordHash: auth.hashPassword('tom-password-1'),
  });
  handle.store.createUser({
    username: 'vera',
    displayName: 'Vera View',
    roleId: handle.store.getRoleByName('Viewer').id,
    passwordHash: auth.hashPassword('vera-password-1'),
  });
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(path.join(handle.config.dataDir, 'maint.db')), 'test data dir cleaned up');
});

// ---------------------------------------------------------------------------
// /api/me and GET /api/roles (SPEC-v3.md 13.2)
// ---------------------------------------------------------------------------

test('GET /api/me adds roleId, roleName and the live permissions', async () => {
  const tom = await login('tom', 'tom-password-1');
  const me = await api(tom, '/api/me');
  assert.equal(me.res.status, 200);
  const tomRow = handle.store.getUserByUsername('tom');
  assert.equal(me.json.roleId, tomRow.role_id);
  assert.equal(me.json.roleName, 'Technician');
  assert.equal(me.json.permissions.serviceOrders, 'write');
  assert.equal(me.json.permissions.backups, 'read');
  assert.equal(me.json.permissions.settings, 'none');
  assert.equal(me.json.permissions.admin, 'none');

  const vera = await login('vera', 'vera-password-1');
  const veraMe = await api(vera, '/api/me');
  assert.equal(veraMe.json.roleName, 'Viewer');
  assert.equal(veraMe.json.permissions.serviceOrders, 'read');
  assert.equal(veraMe.json.permissions.contractorRates, 'none');
});

test('GET /api/roles lists the built-in roles; each has a history endpoint', async () => {
  const root = await login('root', 'root-password-1');
  const list = await api(root, '/api/roles');
  assert.equal(list.res.status, 200);
  const byName = new Map(list.json.map((role) => [role.name, role]));
  assert.ok(byName.get('Administrator').builtin);
  assert.equal(byName.get('Administrator').permissions.admin, 'write');

  const adminHistory = await api(root, `/api/roles/${byName.get('Administrator').id}/history`);
  assert.equal(adminHistory.res.status, 200);
  assert.ok(Array.isArray(adminHistory.json));
  assert.ok(adminHistory.json.length >= 1, 'the migration itself is in the role history');
});

// ---------------------------------------------------------------------------
// Route families: 403 for None/Read where Write is needed (13.4)
// ---------------------------------------------------------------------------

test('records: Write on the area for PUT/DELETE, Read for history; 403 body names area and level', async () => {
  const root = await login('root', 'root-password-1');
  const vera = await login('vera', 'vera-password-1');
  const machineId = uuid();

  const created = await put(root, 'machines', machineId, { name: 'Juki DDL-8700' });
  assert.equal(created.res.status, 200);

  // A user with nothing at all: every record route is a 403 naming the area.
  const nilRole = await createRole(root, 'Empty Hat', {});
  await createUser(root, { username: 'niles', displayName: 'Niles Nil', roleId: nilRole.id });
  const niles = await login('niles', 'niles-password-1');

  const nilHistory = await historyOf(niles, 'machines', machineId);
  assert.equal(nilHistory.res.status, 403);
  assertForbidden(nilHistory.json, 'machines', 'read');

  const nilPut = await put(niles, 'machines', machineId, { name: 'Nope' });
  assert.equal(nilPut.res.status, 403);
  assertForbidden(nilPut.json, 'machines', 'write');

  const nilDelete = await del(niles, 'machines', machineId);
  assert.equal(nilDelete.res.status, 403);
  assertForbidden(nilDelete.json, 'machines', 'write');

  // Viewer has machines Read: history yes, writes no.
  const seen = await historyOf(vera, 'machines', machineId);
  assert.equal(seen.res.status, 200);
  assert.ok(Array.isArray(seen.json));

  const noWrite = await put(vera, 'machines', machineId, { name: 'Renamed by viewer' });
  assert.equal(noWrite.res.status, 403);
  assertForbidden(noWrite.json, 'machines', 'write');

  const noDelete = await del(vera, 'machines', machineId);
  assert.equal(noDelete.res.status, 403);
  assertForbidden(noDelete.json, 'machines', 'write');
});

test('changes feed returns only stores the user can Read', async () => {
  const root = await login('root', 'root-password-1');
  const machineId = uuid();
  const partId = uuid();
  assert.equal((await put(root, 'machines', machineId, { name: 'Machine for feed' })).res.status, 200);
  assert.equal((await put(root, 'parts', partId, { name: 'Part for feed' })).res.status, 200);

  const rootFeed = await changes(root);
  assert.equal(rootFeed.res.status, 200);
  assert.ok(rootFeed.json.records.some((record) => record.id === machineId));
  assert.ok(rootFeed.json.records.some((record) => record.id === partId));

  // A role with machines Read but parts None: the feed hides parts.
  const machinesOnly = await createRole(root, 'Machines Only', { machines: 'read' });
  await createUser(root, { username: 'maple', displayName: 'Maple Reader', roleId: machinesOnly.id });
  const maple = await login('maple', 'maple-password-1');
  const mapleFeed = await changes(maple);
  assert.equal(mapleFeed.res.status, 200);
  assert.ok(mapleFeed.json.records.some((record) => record.id === machineId), 'machines read: included');
  assert.ok(!mapleFeed.json.records.some((record) => record.id === partId), 'parts none: hidden');

  // A user with nothing at all sees no records.
  const nilRole = await createRole(root, 'Empty Feed', {});
  await createUser(root, { username: 'fay', displayName: 'Fay Feedless', roleId: nilRole.id });
  const fay = await login('fay', 'fay-password-1');
  const fayFeed = await changes(fay);
  assert.equal(fayFeed.res.status, 200);
  assert.deepEqual(fayFeed.json.records, []);
});

test('stock moves need parts Write; an order save may deduct for serviceOrders Write', async () => {
  const root = await login('root', 'root-password-1');
  const partId = uuid();
  assert.equal((await put(root, 'parts', partId, { name: 'Part for moves' })).res.status, 200);

  const move = (id, reason, workOrderId) => ({
    id,
    partId,
    delta: -1,
    reason,
    ...(workOrderId === undefined ? {} : { workOrderId }),
  });

  const tom = await login('tom', 'tom-password-1');
  const techManual = await api(tom, '/api/stock-moves', {
    method: 'POST',
    body: { moves: [move(uuid(), 'manual')] },
  });
  assert.equal(techManual.res.status, 200, 'Technician has parts Write');

  const jobsRole = await createRole(root, 'Job Runner', { serviceOrders: 'write' });
  await createUser(root, { username: 'june', displayName: 'June Runner', roleId: jobsRole.id });
  const june = await login('june', 'june-password-1');

  const jobMove = await api(june, '/api/stock-moves', {
    method: 'POST',
    body: { moves: [move(uuid(), 'job-done', uuid())] },
  });
  assert.equal(jobMove.res.status, 200, 'job deduction via serviceOrders Write');

  const manualMove = await api(june, '/api/stock-moves', {
    method: 'POST',
    body: { moves: [move(uuid(), 'manual')] },
  });
  assert.equal(manualMove.res.status, 403);
  assertForbidden(manualMove.json, 'parts', 'write');

  const vera = await login('vera', 'vera-password-1');
  const viewerMove = await api(vera, '/api/stock-moves', {
    method: 'POST',
    body: { moves: [move(uuid(), 'job-done', uuid())] },
  });
  assert.equal(viewerMove.res.status, 403);
  assertForbidden(viewerMove.json, 'serviceOrders', 'write');
});

test('files: upload needs files Write, viewing needs files Read', async () => {
  const tom = await login('tom', 'tom-password-1');
  const vera = await login('vera', 'vera-password-1');

  const uploaded = await api(tom, '/api/files', {
    method: 'POST',
    contentType: 'image/png',
    fileName: 'Machine photo.png',
    body: pngBytes(),
  });
  assert.equal(uploaded.res.status, 201, 'Technician files Write: upload ok');
  const fileId = uploaded.json.fileId;

  const seen = await api(vera, `/api/files/${fileId}`);
  assert.equal(seen.res.status, 200, 'Viewer files Read: download ok');
  assert.equal(seen.res.headers.get('content-type'), 'image/png');

  const denied = await api(vera, '/api/files', {
    method: 'POST',
    contentType: 'image/png',
    fileName: 'Nope.png',
    body: pngBytes(),
  });
  assert.equal(denied.res.status, 403);
  assertForbidden(denied.json, 'files', 'write');

  const root = await login('root', 'root-password-1');
  const nilRole = await createRole(root, 'Empty Files', {});
  await createUser(root, { username: 'filbert', displayName: 'Filbert No', roleId: nilRole.id });
  const filbert = await login('filbert', 'filbert-password-1');
  const noRead = await api(filbert, `/api/files/${fileId}`);
  assert.equal(noRead.res.status, 403);
  assertForbidden(noRead.json, 'files', 'read');
});

test('backups: list needs Read; "Back up now" and download need Write', async () => {
  const root = await login('root', 'root-password-1');
  const tom = await login('tom', 'tom-password-1');
  const vera = await login('vera', 'vera-password-1');

  const listed = await api(tom, '/api/backups');
  assert.equal(listed.res.status, 200, 'Technician has backups Read');
  assert.ok(Array.isArray(listed.json));

  const created = await api(tom, '/api/backups', { method: 'POST' });
  assert.equal(created.res.status, 403, 'Technician has no backups Write');
  assertForbidden(created.json, 'backups', 'write');

  const anyFile = listed.json.length > 0 ? listed.json[0].file : 'maint-20990101-000000-nobody.db';
  const download = await api(tom, `/api/backups/${anyFile}`);
  assert.equal(download.res.status, 403);
  assertForbidden(download.json, 'backups', 'write');

  const viewerList = await api(vera, '/api/backups');
  assert.equal(viewerList.res.status, 403, 'Viewer has backups None');
  assertForbidden(viewerList.json, 'backups', 'read');

  const rootCreate = await api(root, '/api/backups', { method: 'POST' });
  assert.equal(rootCreate.res.status, 200, 'Administrator backups Write: create ok');
  assert.ok(rootCreate.json.file);
});

test('branding needs settings Write; GET branding stays public', async () => {
  const root = await login('root', 'root-password-1');
  const tom = await login('tom', 'tom-password-1');

  const noWrite = await api(tom, '/api/branding', { method: 'PUT', body: { name: 'Tom Shop' } });
  assert.equal(noWrite.res.status, 403);
  assertForbidden(noWrite.json, 'settings', 'write');

  const noLogo = await api(tom, '/api/branding/logo', {
    method: 'POST',
    contentType: 'image/png',
    fileName: 'logo.png',
    body: pngBytes(),
  });
  assert.equal(noLogo.res.status, 403);
  assertForbidden(noLogo.json, 'settings', 'write');

  const set = await api(root, '/api/branding', { method: 'PUT', body: { name: 'RBAC Shop' } });
  assert.equal(set.res.status, 200);

  const publicGet = await fetch(`${base}/api/branding`);
  assert.equal(publicGet.status, 200);
  assert.equal((await publicGet.json()).name, 'RBAC Shop');
});

test('users, roles and import routes need admin Write; any signed-in user may list users', async () => {
  const tom = await login('tom', 'tom-password-1');
  const root = await login('root', 'root-password-1');

  // Names for "edited by" lookups stay available to every signed-in user.
  const listed = await api(tom, '/api/users');
  assert.equal(listed.res.status, 200);
  assert.ok(Array.isArray(listed.json));
  assert.ok(listed.json.some((user) => user.username === 'tom'));

  const roles = await api(tom, '/api/roles');
  assert.equal(roles.res.status, 403);
  assertForbidden(roles.json, 'admin', 'write');

  const made = await api(tom, '/api/roles', { method: 'POST', body: { name: 'Sneaky', permissions: {} } });
  assert.equal(made.res.status, 403);
  assertForbidden(made.json, 'admin', 'write');

  const someRole = (await api(root, '/api/roles')).json[0];
  const patched = await api(tom, `/api/roles/${someRole.id}`, { method: 'PATCH', body: { name: 'Nope' } });
  assert.equal(patched.res.status, 403);
  assertForbidden(patched.json, 'admin', 'write');

  const removed = await api(tom, `/api/roles/${someRole.id}`, { method: 'DELETE' });
  assert.equal(removed.res.status, 403);
  assertForbidden(removed.json, 'admin', 'write');

  const roleHistory = await api(tom, `/api/roles/${someRole.id}/history`);
  assert.equal(roleHistory.res.status, 403);
  assertForbidden(roleHistory.json, 'admin', 'write');

  const addUser = await api(tom, '/api/users', {
    method: 'POST',
    body: { username: 'sneaky', displayName: 'Sneaky', role: 'tech', password: 'sneaky-pass-1' },
  });
  assert.equal(addUser.res.status, 403);
  assertForbidden(addUser.json, 'admin', 'write');

  const rootRow = handle.store.getUserByUsername('root');
  const patchUser = await api(tom, `/api/users/${rootRow.id}`, { method: 'PATCH', body: { disabled: true } });
  assert.equal(patchUser.res.status, 403);
  assertForbidden(patchUser.json, 'admin', 'write');

  const importV1 = await api(tom, '/api/import-v1', { method: 'POST', body: { records: [] } });
  assert.equal(importV1.res.status, 403);
  assertForbidden(importV1.json, 'admin', 'write');
});

// ---------------------------------------------------------------------------
// Contractor rates and costs (contractorRates area)
// ---------------------------------------------------------------------------

test('hourlyRate: hidden without contractorRates Read, stored rate kept without Write', async () => {
  const root = await login('root', 'root-password-1');

  const noRates = await createRole(root, 'Rateless R', { contractors: 'write' });
  await createUser(root, { username: 'nora', displayName: 'Nora Rateless', roleId: noRates.id });
  const nora = await login('nora', 'nora-password-1');

  const rateReader = await createRole(root, 'Rate Seer', { contractors: 'write', contractorRates: 'read' });
  await createUser(root, { username: 'sam', displayName: 'Sam Seer', roleId: rateReader.id });
  const sam = await login('sam', 'sam-password-1');

  const contractorId = uuid();
  const created = await put(root, 'contractors', contractorId, {
    company: 'Rates Ltd',
    trade: 'Electrician',
    hourlyRate: 85.5,
  });
  assert.equal(created.res.status, 200);
  assert.equal(created.json.record.data.hourlyRate, 85.5);

  // Without Write: the PUT is allowed (contractors write) but keeps the stored
  // rate, and the response hides the rate (no Read).
  const edited = await put(nora, 'contractors', contractorId, {
    company: 'Rates Ltd',
    trade: 'Electrician + HVAC',
    hourlyRate: 1,
  });
  assert.equal(edited.res.status, 200);
  assert.equal(edited.json.record.data.hourlyRate, undefined, 'response hides the rate');

  const rootFeed = await changes(root);
  const stored = rootFeed.json.records.find((record) => record.id === contractorId);
  assert.equal(stored.data.hourlyRate, 85.5, 'the stored rate is unchanged');

  const noraFeed = await changes(nora);
  const noraSeen = noraFeed.json.records.find((record) => record.id === contractorId);
  assert.equal(noraSeen.data.hourlyRate, undefined, 'changes hides the rate without Read');

  const samFeed = await changes(sam);
  const samSeen = samFeed.json.records.find((record) => record.id === contractorId);
  assert.equal(samSeen.data.hourlyRate, 85.5, 'changes shows the rate with Read');

  // With Read but not Write: a PUT that includes a rate still keeps the stored one.
  const samEdit = await put(sam, 'contractors', contractorId, {
    company: 'Rates Ltd',
    trade: 'Electrician + HVAC',
    hourlyRate: 999,
  });
  assert.equal(samEdit.res.status, 200);
  assert.equal(samEdit.json.record.data.hourlyRate, 85.5, 'PUT without Write keeps the stored rate');

  const samHistory = await historyOf(sam, 'contractors', contractorId);
  assert.equal(samHistory.res.status, 200);
  assert.ok(samHistory.json.every((entry) => entry.after === null || entry.after.hourlyRate === 85.5));

  const noraHistory = await historyOf(nora, 'contractors', contractorId);
  assert.equal(noraHistory.res.status, 200);
  assert.ok(noraHistory.json.every((entry) => entry.after === null || !('hourlyRate' in entry.after)));
});

// ---------------------------------------------------------------------------
// Roles CRUD (SPEC-v3.md 13.1: custom roles)
// ---------------------------------------------------------------------------

test('roles: create, copy, rename, validate permissions, delete only when unused', async () => {
  const root = await login('root', 'root-password-1');

  // Name rules: 1-40 chars, unique case-insensitively.
  for (const name of ['', ' '.repeat(41)]) {
    const badName = await api(root, '/api/roles', { method: 'POST', body: { name, permissions: {} } });
    assert.equal(badName.res.status, 400, JSON.stringify(name));
  }
  const clash = await api(root, '/api/roles', { method: 'POST', body: { name: 'administrator', permissions: {} } });
  assert.equal(clash.res.status, 409);
  assert.equal(clash.json.error, 'name_taken');

  // Permissions rules: known areas, known levels.
  const badArea = await api(root, '/api/roles', {
    method: 'POST',
    body: { name: 'Bad Area', permissions: { bogusArea: 'read' } },
  });
  assert.equal(badArea.res.status, 400);
  assert.match(badArea.json.message, /unknown permission area/);
  const badLevel = await api(root, '/api/roles', {
    method: 'POST',
    body: { name: 'Bad Level', permissions: { machines: 'sometimes' } },
  });
  assert.equal(badLevel.res.status, 400);
  assert.match(badLevel.json.message, /must be one of/);

  // Unknown body fields are rejected.
  const badField = await api(root, '/api/roles', {
    method: 'POST',
    body: { name: 'Bad Field', permissions: {}, id: uuid() },
  });
  assert.equal(badField.res.status, 400);

  const supervisor = await createRole(root, 'Supervisor', {
    machines: 'write',
    parts: 'read',
    contractors: 'read',
  });
  assert.equal(supervisor.permissions.machines, 'write');
  assert.equal(supervisor.permissions.coworkers, 'none', 'missing areas default to none');
  assert.equal(supervisor.permissions.admin, 'none');

  // copyOf copies the source permissions.
  const copy = await createRole(root, 'Supervisor Copy', undefined, { copyOf: supervisor.id });
  assert.deepEqual(copy.permissions, supervisor.permissions);

  // Rename does not touch levels; a taken name is a 409.
  const renamed = await api(root, `/api/roles/${supervisor.id}`, { method: 'PATCH', body: { name: 'Shift Boss' } });
  assert.equal(renamed.res.status, 200);
  assert.equal(renamed.json.name, 'Shift Boss');
  assert.equal(renamed.json.permissions.parts, 'read', 'rename does not touch levels');

  const renameClash = await api(root, `/api/roles/${supervisor.id}`, { method: 'PATCH', body: { name: 'Technician' } });
  assert.equal(renameClash.res.status, 409);
  assert.equal(renameClash.json.error, 'name_taken');

  // Levels change; an empty body is rejected.
  const leveled = await api(root, `/api/roles/${supervisor.id}`, {
    method: 'PATCH',
    body: { permissions: { machines: 'read', parts: 'read', contractors: 'read' } },
  });
  assert.equal(leveled.res.status, 200);
  assert.equal(leveled.json.permissions.machines, 'read');
  const empty = await api(root, `/api/roles/${supervisor.id}`, { method: 'PATCH', body: {} });
  assert.equal(empty.res.status, 400);

  // Delete: blocked while a user has the role, allowed once unassigned.
  const worker = await createUser(root, {
    username: 'shifty',
    displayName: 'Shifty Boss',
    roleId: supervisor.id,
  });
  const blocked = await api(root, `/api/roles/${supervisor.id}`, { method: 'DELETE' });
  assert.equal(blocked.res.status, 409);
  assert.equal(blocked.json.error, 'role_in_use');
  assert.match(blocked.json.message, /assigned to 1 user/);

  const moved = await api(root, `/api/users/${worker.id}`, {
    method: 'PATCH',
    body: { roleId: handle.store.getRoleByName('Technician').id },
  });
  assert.equal(moved.res.status, 200);
  assert.equal(moved.json.roleName, 'Technician');

  const removedRole = await api(root, `/api/roles/${supervisor.id}`, { method: 'DELETE' });
  assert.equal(removedRole.res.status, 200);
  assert.equal(removedRole.json.ok, true);
  assert.equal(handle.store.getRoleById(supervisor.id), null);

  const missing = await api(root, '/api/roles/does-not-exist', { method: 'DELETE' });
  assert.equal(missing.res.status, 404);
});

test('the Administrator role cannot be changed or deleted', async () => {
  const root = await login('root', 'root-password-1');
  const adminRole = handle.store.getRoleByName('Administrator');

  const renamed = await api(root, `/api/roles/${adminRole.id}`, { method: 'PATCH', body: { name: 'Boss of All' } });
  assert.equal(renamed.res.status, 409);
  assert.equal(renamed.json.error, 'role_immutable');

  const leveled = await api(root, `/api/roles/${adminRole.id}`, {
    method: 'PATCH',
    body: { permissions: { machines: 'read' } },
  });
  assert.equal(leveled.res.status, 409);
  assert.equal(leveled.json.error, 'role_immutable');

  const removed = await api(root, `/api/roles/${adminRole.id}`, { method: 'DELETE' });
  assert.equal(removed.res.status, 409);
  assert.equal(removed.json.error, 'role_immutable');

  // The stored role is untouched.
  assert.deepEqual(
    JSON.parse(handle.store.getRoleById(adminRole.id).permissions),
    JSON.parse(adminRole.permissions)
  );
});

test('role changes are recorded in the role history with before/after', async () => {
  const root = await login('root', 'root-password-1');
  const rootRow = handle.store.getUserByUsername('root');
  const role = await createRole(root, 'Historied', { machines: 'write' });

  await api(root, `/api/roles/${role.id}`, {
    method: 'PATCH',
    body: { name: 'Historied Two', permissions: { machines: 'read' } },
  });

  const history = await api(root, `/api/roles/${role.id}/history`);
  assert.equal(history.res.status, 200);
  assert.ok(history.json.length >= 2, 'create and update entries');
  assert.ok(history.json.every((entry) => entry.store === 'roles'));
  assert.ok(history.json.every((entry) => entry.userId === rootRow.id));
  assert.ok(history.json.every((entry) => entry.conflict === false));

  const [update, create] = history.json;
  assert.equal(update.action, 'update');
  assert.equal(update.before.name, 'Historied');
  assert.equal(update.before.permissions.machines, 'write');
  assert.equal(update.after.name, 'Historied Two');
  assert.equal(update.after.permissions.machines, 'read');
  assert.equal(create.action, 'create');
  assert.equal(create.before, null);
  assert.equal(create.after.name, 'Historied');
  assert.equal(create.after.permissions.machines, 'write');
});

// ---------------------------------------------------------------------------
// Safety rules (SPEC-v3.md 13.2)
// ---------------------------------------------------------------------------

test('the last enabled user with admin Write cannot be disabled or demoted (409)', async () => {
  const adminRole = handle.store.getRoleByName('Administrator');
  const technicianRole = handle.store.getRoleByName('Technician');

  // Root is the only enabled user with admin Write in this fresh server.
  const root = await login('root', 'root-password-1');
  const rootRow = handle.store.getUserByUsername('root');

  const disableSelf = await api(root, `/api/users/${rootRow.id}`, {
    method: 'PATCH',
    body: { disabled: true },
  });
  assert.equal(disableSelf.res.status, 409);
  assert.equal(disableSelf.json.error, 'last_admin');
  assert.match(disableSelf.json.message, /cannot be disabled/i);

  const demoteSelf = await api(root, `/api/users/${rootRow.id}`, {
    method: 'PATCH',
    body: { roleId: technicianRole.id },
  });
  assert.equal(demoteSelf.res.status, 409);
  assert.equal(demoteSelf.json.error, 'last_admin');
  assert.match(demoteSelf.json.message, /demoted/i);

  // A second enabled admin unlocks it: root may be demoted and disabled.
  const ada = await createUser(root, {
    username: 'ada',
    displayName: 'Ada Admin',
    roleId: adminRole.id,
  });
  const adaToken = await login('ada', 'ada-password-1');

  assert.equal(
    (
      await api(root, `/api/users/${rootRow.id}`, {
        method: 'PATCH',
        body: { roleId: technicianRole.id },
      })
    ).res.status,
    200,
    'with a second admin root may be demoted'
  );
  assert.equal(
    (
      await api(adaToken, `/api/users/${rootRow.id}`, {
        method: 'PATCH',
        body: { roleId: adminRole.id },
      })
    ).res.status,
    200,
    'ada restores root to Administrator'
  );

  // Disabling deletes sessions: the disabled user's token stops working.
  const root2 = await login('root', 'root-password-1');
  const disabled = await api(adaToken, `/api/users/${rootRow.id}`, {
    method: 'PATCH',
    body: { disabled: true },
  });
  assert.equal(disabled.res.status, 200, 'ada may disable root');
  assert.equal((await api(root2, '/api/me')).res.status, 401, "disabled root's sessions are gone");

  assert.equal(
    (await api(adaToken, `/api/users/${rootRow.id}`, { method: 'PATCH', body: { disabled: false } })).res.status,
    200,
    'ada re-enables root'
  );
  assert.ok((await login('root', 'root-password-1')).length > 0, 'root signs in again');
});

test('a user cannot remove admin Write from their own role (409)', async () => {
  const root = await login('root', 'root-password-1');

  const bossRole = await createRole(root, 'Own Boss', { admin: 'write' });
  await createUser(root, { username: 'bossy', displayName: 'Bossy Boots', roleId: bossRole.id });
  const bossy = await login('bossy', 'bossy-password-1');

  // Bossy has admin Write (via the custom role) and tries to strip it.
  const selfDemote = await api(bossy, `/api/roles/${bossRole.id}`, {
    method: 'PATCH',
    body: { permissions: { admin: 'none' } },
  });
  assert.equal(selfDemote.res.status, 409);
  assert.equal(selfDemote.json.error, 'last_admin');
  assert.match(selfDemote.json.message, /own role/i);

  // Another admin may strip it from that role: bossy is demoted on the next
  // request, without signing out.
  const stripped = await api(root, `/api/roles/${bossRole.id}`, {
    method: 'PATCH',
    body: { permissions: { admin: 'none' } },
  });
  assert.equal(stripped.res.status, 200);

  const demoted = await api(bossy, '/api/roles');
  assert.equal(demoted.res.status, 403, 'bossy lost admin Write without signing out');
  assertForbidden(demoted.json, 'admin', 'write');
});

// ---------------------------------------------------------------------------
// Permissions are live on every request (no session caching)
// ---------------------------------------------------------------------------

test('a permission change applies on the very next request without signing out', async () => {
  const root = await login('root', 'root-password-1');

  const halfRole = await createRole(root, 'Half Machine', { machines: 'none' });
  await createUser(root, { username: 'hal', displayName: 'Hal Half', roleId: halfRole.id });
  const hal = await login('hal', 'hal-password-1');
  const machineId = uuid();

  const denied = await put(hal, 'machines', machineId, { name: 'Hal Machine' });
  assert.equal(denied.res.status, 403);
  assertForbidden(denied.json, 'machines', 'write');

  // Root lifts the level while Hal stays signed in.
  const lifted = await api(root, `/api/roles/${halfRole.id}`, {
    method: 'PATCH',
    body: { permissions: { machines: 'write' } },
  });
  assert.equal(lifted.res.status, 200);

  const allowed = await put(hal, 'machines', machineId, { name: 'Hal Machine' });
  assert.equal(allowed.res.status, 200, 'the very next request with the same token passes');

  const me = await api(hal, '/api/me');
  assert.equal(me.json.permissions.machines, 'write', '/api/me reflects the change too');

  // And dropping it back hides the store on the next request.
  await api(root, `/api/roles/${halfRole.id}`, {
    method: 'PATCH',
    body: { permissions: { machines: 'none' } },
  });
  const deniedAgain = await put(hal, 'machines', machineId, { name: 'Hal Machine 2' });
  assert.equal(deniedAgain.res.status, 403);
  assertForbidden(deniedAgain.json, 'machines', 'write');
});

// ---------------------------------------------------------------------------
// admin.js CLI (SPEC-v3.md 13.2: --admin, --role "<name>", list-users)
// ---------------------------------------------------------------------------

test('admin.js create-user --admin/--role assigns roles; list-users shows role names', async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'rbac-cli-'));
  const env = { ...process.env, DATA_DIR: dataDir };
  const run = (args, input = '') =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(REPO, 'server', 'admin.js'), ...args], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', () => resolve({ code: 1, stdout, stderr: 'spawn failed' }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });

  try {
    const first = await run(['create-user', '--admin', 'skipper', 'Skipper Chief', '--password-stdin'], 'skip-pass-99\n');
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Created Administrator "skipper"/);

    // A custom role exists before --role can use it.
    const seed = openStore(dataDir);
    try {
      seed.createRole({ name: 'Supervisor', permissions: { machines: 'write' }, updatedBy: null });
    } finally {
      seed.close();
    }

    const made = await run(['create-user', '--role', 'Supervisor', 'sammy', 'Sammy Super', '--password-stdin'], 'sam-pass-91919\n');
    assert.equal(made.code, 0, made.stderr);
    assert.match(made.stdout, /Created Supervisor "sammy"/);

    const seeded = await run(['create-user', '--role=Supervisor', 'simone', 'Simone Super', '--password-stdin'], 'sim-pass-91919\n');
    assert.equal(seeded.code, 0, seeded.stderr);
    assert.match(seeded.stdout, /Created Supervisor "simone"/, '--role=Name also works');

    const defaultMade = await run(['create-user', 'tillie', 'Tillie Tech', '--password-stdin'], 'til-pass-91919\n');
    assert.equal(defaultMade.code, 0, defaultMade.stderr);
    assert.match(defaultMade.stdout, /Created Technician "tillie"/, 'default without --admin/--role is Technician');

    const listed = await run(['list-users']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /Supervisor/);
    assert.match(listed.stdout, /Administrator/);
    assert.match(listed.stdout, /Technician/);

    const missingRole = await run(['create-user', '--role', 'Nobody Role', 'xavier', 'Xavier Y', '--password-stdin'], 'xy-pass-91919\n');
    assert.notEqual(missingRole.code, 0);
    assert.match(`${missingRole.stderr}${missingRole.stdout}`, /no role named "Nobody Role"/);

    const both = await run(['create-user', '--admin', '--role', 'Supervisor', 'dup', 'Dup Person', '--password-stdin'], 'dup-pass-91919\n');
    assert.notEqual(both.code, 0);
    assert.match(`${both.stderr}${both.stdout}`, /either --admin or --role/);

    const check = openStore(dataDir);
    try {
      const sammy = check.getUserByUsername('sammy');
      assert.equal(sammy.role_name, 'Supervisor');
      assert.equal(check.getRoleById(sammy.role_id).name, 'Supervisor');
    } finally {
      check.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
test('login response carries the role permissions, same as GET /api/me', async () => {
  for (const [username, password, adminLevel] of [['root', 'root-password-1', 'write'], ['vera', 'vera-password-1', 'none']]) {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...XRW },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.permissions?.admin, adminLevel, `${username} admin level`);
    assert.equal(typeof body.roleName, 'string');
  }
});
