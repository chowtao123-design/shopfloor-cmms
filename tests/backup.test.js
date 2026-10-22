'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import * as auth from '../server/auth.js';
import {
  DEFAULT_BACKUP_KEEP,
  MANUAL_BACKUP_INTERVAL_MS,
  createBackup,
  listBackups,
  nextRunDelay,
  startBackupSchedule,
} from '../server/backup.js';
import { startServer } from '../server/server.js';
import { openStore } from '../server/store.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const XRW = { 'X-Requested-With': 'maint-log' };

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
  return { res, json };
}

/** Raw request with a verbatim target so `..` reaches the server unnormalized. */
function rawRequest(target, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: handle.port, method, path: target, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = text;
          try {
            body = JSON.parse(text);
          } catch {
            /* keep raw text */
          }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const rowInt = (db, sql, ...args) => Number(db.prepare(sql).get(...args).c);

let anna; // admin
let ben; // tech

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'backup-test-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir, backupKeep: 2 });
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
  anna = await login('anna', 'anna-password-1');
  ben = await login('ben', 'ben-password-1');
});

after(async () => {
  await handle.close();
  const dataDir = handle.config.dataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(path.join(dataDir, 'maint.db')), 'test data dir cleaned up');
});

// ---------------------------------------------------------------------------
// POST /api/backups — one-click backup (SPEC-v2.md sections 7, 12)
// ---------------------------------------------------------------------------

test('POST /api/backups creates a readable SQLite copy of the live database', async () => {
  // Backups Write is needed for "Back up now" (SPEC-v3.md 13.1): anna has it.
  const { res, json } = await api(anna, '/api/backups', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(json.error, undefined);
  assert.match(json.file, /^maint-\d{8}-\d{6}-anna\.db$/);
  assert.ok(!Number.isNaN(Date.parse(json.createdAt)), 'createdAt is an ISO timestamp');
  assert.ok(Number.isInteger(json.bytes) && json.bytes > 0);

  const filePath = path.join(handle.config.dataDir, 'backups', json.file);
  assert.ok(fs.existsSync(filePath), 'backup file exists under data/backups');
  assert.equal(fs.statSync(filePath).size, json.bytes);
  assert.ok(fs.readFileSync(filePath).subarray(0, 15).toString().startsWith('SQLite format 3'));

  const copy = new DatabaseSync(filePath);
  assert.equal(rowInt(copy, 'SELECT COUNT(*) c FROM users'), rowInt(handle.store.db, 'SELECT COUNT(*) c FROM users'));
  assert.equal(rowInt(copy, 'SELECT COUNT(*) c FROM records'), rowInt(handle.store.db, 'SELECT COUNT(*) c FROM records'));
  copy.close();
});

test('a second manual backup within 30 seconds returns 429 with Retry-After', async () => {
  const { res, json } = await api(anna, '/api/backups', { method: 'POST' });
  assert.equal(res.status, 429);
  assert.equal(json.error, 'rate_limited');
  assert.equal(typeof json.message, 'string');
  assert.ok(json.message.length > 0);
  const retryAfter = Number(res.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= MANUAL_BACKUP_INTERVAL_MS / 1000);
});

test('POST /api/backups without a session returns 401 login_required', async () => {
  const { res, json } = await api(null, '/api/backups', { method: 'POST' });
  assert.equal(res.status, 401);
  assert.equal(json.error, 'login_required');
});

// ---------------------------------------------------------------------------
// GET /api/backups — list newest first (SPEC-v2.md sections 7, 9.5)
// ---------------------------------------------------------------------------

let scheduleFile;

test('GET /api/backups lists newest first with creator names and Automatic', async () => {
  const scheduled = await createBackup({
    db: handle.store.db,
    dataDir: handle.config.dataDir,
    createdBy: 'schedule',
    kind: 'schedule',
    keep: 2,
  });
  scheduleFile = scheduled.file;

  const { res, json } = await api(ben, '/api/backups');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(json));
  assert.ok(json.length >= 2);
  assert.deepEqual(
    json.map((item) => item.file).slice(0, 2),
    [scheduleFile, json.find((item) => item.file !== scheduleFile).file]
  );
  const scheduledItem = json.find((item) => item.file === scheduleFile);
  const manualItem = json.find((item) => item.file !== scheduleFile);
  assert.equal(scheduledItem.createdBy, 'Automatic');
  assert.equal(manualItem.createdBy, 'Anna Admin');
  for (const item of json) {
    assert.ok(Number.isInteger(item.bytes) && item.bytes > 0);
    assert.ok(!Number.isNaN(Date.parse(item.createdAt)));
    assert.ok(item.kind === 'manual' || item.kind === 'schedule');
  }
});

// ---------------------------------------------------------------------------
// GET /api/backups/:file — admin download (SPEC-v2.md sections 7, 12)
// ---------------------------------------------------------------------------

test('users without backups Write get 403 on download; Write gets the bytes', async () => {
  const list = await api(ben, '/api/backups');
  const file = list.json.find((item) => item.createdBy === 'Anna Admin').file;

  const denied = await api(ben, `/api/backups/${file}`);
  assert.equal(denied.res.status, 403);
  assert.equal(denied.json.error, 'forbidden');
  assert.equal(denied.json.area, 'backups');
  assert.equal(denied.json.needed, 'write');

  const allowed = await fetch(`${base}/api/backups/${file}`, {
    headers: { cookie: `sid=${anna}` },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('content-type'), 'application/octet-stream');
  assert.equal(allowed.headers.get('content-disposition'), `attachment; filename="${file}"`);
  const expected = fs.readFileSync(path.join(handle.config.dataDir, 'backups', file));
  assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), expected);
});

test('download rejects names not in the backups table and traversal attempts', async () => {
  const list = await api(anna, '/api/backups');
  assert.ok(list.json.length >= 2);

  for (const bad of [
    '/api/backups/maint-20990101-000000-nobody.db',
    '/api/backups/notes.txt',
    '/api/backups/pre-restore-20990101-000000.db',
    '/api/backups/maint.db',
  ]) {
    const { res, json } = await api(anna, bad);
    assert.equal(res.status, 404, bad);
    assert.equal(json.error, 'not_found');
  }

  for (const target of ['/api/backups/../maint.db', '/api/backups/%2e%2e/maint.db', '/api/backups/sub/maint.db']) {
    const raw = await rawRequest(target, { headers: { cookie: `sid=${anna}` } });
    assert.equal(raw.status, 404, target);
    assert.equal(raw.body.error, 'not_found');
  }
});

test('a recorded backup whose file is missing on disk returns 404', async () => {
  const filePath = path.join(handle.config.dataDir, 'backups', scheduleFile);
  fs.rmSync(filePath, { force: true });
  const { res, json } = await api(anna, `/api/backups/${scheduleFile}`);
  assert.equal(res.status, 404);
  assert.equal(json.error, 'not_found');
});

// ---------------------------------------------------------------------------
// retention: keep only the newest BACKUP_KEEP (SPEC-v2.md section 12)
// ---------------------------------------------------------------------------

test('retention keeps only the newest BACKUP_KEEP files and rows', async () => {
  const dataDir = handle.config.dataDir;
  const backupsDir = path.join(dataDir, 'backups');
  assert.equal(handle.config.backupKeep, 2);
  assert.equal(DEFAULT_BACKUP_KEEP, 30, 'default BACKUP_KEEP stays 30');

  const manualBefore = rowInt(handle.store.db, 'SELECT COUNT(*) c FROM backups');
  assert.ok(manualBefore >= 2, 'earlier tests left recorded backups');

  const created = [];
  for (let i = 0; i < 3; i += 1) {
    created.push(
      await createBackup({ db: handle.store.db, dataDir, createdBy: 'schedule', kind: 'schedule', keep: 2 })
    );
  }

  const list = listBackups(handle.store.db);
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((item) => item.file),
    [created[2].file, created[1].file]
  );
  assert.equal(rowInt(handle.store.db, 'SELECT COUNT(*) c FROM backups'), 2);

  const onDisk = fs.readdirSync(backupsDir).filter((name) => name.startsWith('maint-')).sort();
  assert.deepEqual(
    onDisk,
    [created[1].file, created[2].file].sort(),
    'older backup files are deleted from disk'
  );
  for (const old of created.slice(0, 1)) {
    assert.ok(!fs.existsSync(path.join(backupsDir, old.file)), 'deleted row file removed');
  }
});

// ---------------------------------------------------------------------------
// daily schedule: nextRunDelay is the pure, unit-tested core (SPEC-v2.md 4, 12)
// ---------------------------------------------------------------------------

test('nextRunDelay returns today for later times and tomorrow for earlier ones', () => {
  const now = new Date(2026, 9, 20, 10, 30, 15, 250);
  const before = new Date(2026, 9, 20, 23, 45, 0, 0);
  assert.equal(nextRunDelay(now, '23:45'), before.getTime() - now.getTime());

  const tomorrow = new Date(2026, 9, 21, 3, 15, 0, 0);
  assert.equal(nextRunDelay(now, '03:15'), tomorrow.getTime() - now.getTime());

  const dayMs = 24 * 60 * 60 * 1000;
  const delay = nextRunDelay(now, '10:30');
  assert.ok(delay > 0 && delay <= dayMs && delay === dayMs - 15250);

  assert.throws(() => nextRunDelay(now, '2:00'), TypeError);
  assert.throws(() => nextRunDelay(now, '24:30'), TypeError);
  assert.throws(() => nextRunDelay(now, '10:60'), TypeError);
  assert.throws(() => nextRunDelay(now, 'off'), TypeError);
});

test('startBackupSchedule is disabled with "off" and stop() is idempotent', () => {
  assert.equal(startBackupSchedule().disabled, true);
  const off = startBackupSchedule({ db: handle.store.db, dataDir: handle.config.dataDir, at: 'off' });
  assert.equal(off.disabled, true);
  off.stop();
  off.stop();

  const on = startBackupSchedule({ db: handle.store.db, dataDir: handle.config.dataDir, at: '23:59' });
  assert.equal(on.disabled, false);
  assert.equal(on.stopped, false);
  on.stop();
  on.stop();
  assert.equal(on.stopped, true);
});

// ---------------------------------------------------------------------------
// CLI restore (SPEC-v2.md section 12): admin.js restore <file> [--yes]
// ---------------------------------------------------------------------------

function runRestoreCli(dataDir, args) {
  return spawnSync(process.execPath, [path.join(REPO, 'server', 'admin.js'), 'restore', ...args], {
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

test('admin.js restore refuses without --yes and swaps the database with it', async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'restore-cli-'));
  const store = openStore(dataDir);
  const user = store.createUser({
    username: 'ruth',
    displayName: 'Ruth Restore',
    role: 'admin',
    passwordHash: auth.hashPassword('ruth-password-1'),
  });
  const iso = new Date().toISOString();
  const addRecord = (id) =>
    store.upsertRecord({
      store: 'machines',
      id,
      data: JSON.stringify({ name: `machine ${id}` }),
      version: 1,
      deleted: 0,
      createdAt: iso,
      createdBy: user.id,
      updatedAt: iso,
      updatedBy: user.id,
      seq: store.nextSeq(),
    });
  addRecord('sample-keep-me');
  const meta = await createBackup({
    db: store.db,
    dataDir,
    createdBy: { id: user.id, username: 'ruth' },
    kind: 'manual',
  });
  addRecord('sample-added-later');
  store.close();

  const refusal = runRestoreCli(dataDir, [meta.file]);
  assert.equal(refusal.status, 1);
  assert.match(refusal.stdout, /--yes/);
  assert.match(refusal.stdout, /Stop the Shop Maintenance Log/);

  const untouched = openStore(dataDir);
  assert.equal(rowInt(untouched.db, 'SELECT COUNT(*) c FROM records'), 2);
  untouched.close();

  const restore = runRestoreCli(dataDir, [meta.file, '--yes']);
  assert.equal(restore.status, 0, restore.stderr);

  const restored = openStore(dataDir);
  assert.equal(rowInt(restored.db, 'SELECT COUNT(*) c FROM records'), 1);
  assert.deepEqual(
    restored.db.prepare('SELECT id FROM records').all().map((row) => row.id),
    ['sample-keep-me']
  );
  assert.equal(rowInt(restored.db, 'SELECT COUNT(*) c FROM users'), 1);
  restored.close();

  const backupsDir = path.join(dataDir, 'backups');
  const preRestore = fs.readdirSync(backupsDir).filter((name) => name.startsWith('pre-restore-'));
  assert.equal(preRestore.length, 1);
  assert.match(preRestore[0], /^pre-restore-\d{8}-\d{6}\.db$/);
  assert.ok(!fs.existsSync(path.join(dataDir, 'maint.db-wal')), 'stale -wal removed');
  assert.ok(!fs.existsSync(path.join(dataDir, 'maint.db-shm')), 'stale -shm removed');

  const preFile = preRestore[0];
  const notRecorded = runRestoreCli(dataDir, [preFile, '--yes']);
  assert.equal(notRecorded.status, 1);
  assert.match(notRecorded.stderr, /not recorded in the backups table/);

  const badName = runRestoreCli(dataDir, ['not a backup!.db', '--yes']);
  assert.equal(badName.status, 1);
  assert.match(badName.stderr, /not a valid backup file name/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});