'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { startServer } from '../server/server.js';
import {
  AGENT_DISPLAY_NAME,
  AGENT_USERNAME,
  ensureAgentUser,
  tokenPathAllowed,
} from '../server/apiTokens.js';

/**
 * Agent API tokens (Muse): Bearer-only auth, scope enforcement, hashed
 * storage, revocation, no access to admin surfaces, and attribution of
 * writes to the agent user in the record history.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const XRW = { 'X-Requested-With': 'maint-log' };

let handle;
let base;
let sid;
let agentId;

function setCookies(res) {
  const raw = res.headers.getSetCookie === undefined ? [] : res.headers.getSetCookie();
  return raw;
}

async function login(username, password) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ username, password }),
  });
  const cookie = setCookies(res).find((value) => value.startsWith('sid='));
  assert.ok(cookie, `login failed for ${username}`);
  return cookie.split(';')[0].slice('sid='.length);
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Signed-in human request (cookie + CSRF header). */
async function session(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      cookie: `sid=${sid}`,
      ...XRW,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { res, body: await readJson(res) };
}

/** Agent request: Bearer only, deliberately no cookie and no CSRF header. */
async function bearer(token, pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { res, body: await readJson(res) };
}

async function createToken(payload) {
  const created = await session('/api/tokens', { method: 'POST', body: payload });
  assert.equal(created.res.status, 201, JSON.stringify(created.body));
  return created.body;
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'tokens-test-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  base = handle.url;
  handle.store.createUser({
    username: 'anna',
    displayName: 'Anna Admin',
    role: 'admin',
    passwordHash: auth.hashPassword('anna-password-1'),
  });
  sid = await login('anna', 'anna-password-1');
  agentId = ensureAgentUser(handle.store).id;
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Public discovery
// ---------------------------------------------------------------------------

test('GET /health is public and reports the version', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
});

test('GET /openapi.json is public and documents Bearer auth and the real routes', async () => {
  const res = await fetch(`${base}/openapi.json`);
  assert.equal(res.status, 200);
  const spec = await res.json();
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
  assert.deepEqual(Object.keys(spec.paths).sort(), [
    '/api/changes',
    '/api/history/{store}/{id}',
    '/api/me',
    '/api/records/{store}/{id}',
    '/health',
  ]);
  assert.equal(spec.paths['/api/records/{store}/{id}'].get, undefined, 'no per-record GET exists');
});

test('a non-GET probe path is rejected with 405', async () => {
  const res = await fetch(`${base}/openapi.json`, { method: 'POST' });
  assert.equal(res.status, 405);
});

// ---------------------------------------------------------------------------
// Token creation and storage
// ---------------------------------------------------------------------------

test('admin creates a write token for the Muse Agent; raw token is returned once', async () => {
  const created = await createToken({ name: 'Muse laptop', scope: 'write' });
  assert.match(created.token, /^mlt_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.scope, 'write');
  assert.equal(created.name, 'Muse laptop');
  assert.equal(created.username, AGENT_USERNAME);
  assert.equal(created.displayName, AGENT_DISPLAY_NAME);
  assert.equal(created.userId, agentId);
  assert.equal(created.revokedAt, null);
  assert.equal(created.token_hash, undefined, 'the hash must never be serialized');

  const listed = await session('/api/tokens');
  assert.equal(listed.res.status, 200);
  assert.equal(listed.body.length, 1);
  const text = JSON.stringify(listed.body);
  assert.ok(!text.includes(created.token), 'the raw token is never listed');
  assert.ok(!text.includes('token_hash'));
});

test('token creation validates name, scope and unknown fields', async () => {
  assert.equal((await session('/api/tokens', { method: 'POST', body: { name: '', scope: 'write' } })).res.status, 400);
  assert.equal((await session('/api/tokens', { method: 'POST', body: { name: 'x', scope: 'admin' } })).res.status, 400);
  assert.equal(
    (await session('/api/tokens', { method: 'POST', body: { name: 'x', scope: 'read', extra: 1 } })).res.status,
    400
  );
});

test('ensureAgentUser is idempotent and the bot cannot sign in', () => {
  const again = ensureAgentUser(handle.store);
  assert.equal(again.id, agentId);
  const row = handle.store.getUserById(agentId);
  assert.equal(row.username, AGENT_USERNAME);
  assert.equal(Number(row.disabled), 1);
});

// ---------------------------------------------------------------------------
// Scope enforcement
// ---------------------------------------------------------------------------

test('token path policy: reads are narrow, writes need write scope and PUT/DELETE only', () => {
  assert.equal(tokenPathAllowed('GET', '/api/changes', 'read'), true);
  assert.equal(tokenPathAllowed('GET', '/api/history/machines/x', 'read'), true);
  assert.equal(tokenPathAllowed('GET', '/api/me', 'read'), true);
  assert.equal(tokenPathAllowed('GET', '/api/users', 'read'), false);
  assert.equal(tokenPathAllowed('GET', '/api/backups', 'write'), false);
  assert.equal(tokenPathAllowed('PUT', '/api/records/machines/x', 'read'), false);
  assert.equal(tokenPathAllowed('PUT', '/api/records/machines/x', 'write'), true);
  assert.equal(tokenPathAllowed('DELETE', '/api/records/machines/x', 'write'), true);
  assert.equal(tokenPathAllowed('POST', '/api/records/machines/x', 'write'), false);
  assert.equal(tokenPathAllowed('POST', '/api/tokens', 'write'), false);
  assert.equal(tokenPathAllowed('POST', '/api/ai/chat', 'write'), false);
});

test('write token can read the feed and create a machine, attributed to the agent', async () => {
  const { token } = await createToken({ name: 'Writer', scope: 'write' });
  const machineId = crypto.randomUUID();
  const created = await bearer(token, `/api/records/machines/${machineId}`, {
    method: 'PUT',
    body: { data: { name: 'Muse test machine', type: 'single-needle', location: 'Line 9', status: 'running' } },
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.record.id, machineId);

  const history = await bearer(token, `/api/history/machines/${machineId}`);
  assert.equal(history.res.status, 200);
  assert.equal(history.body[0].userId, agentId);
  assert.equal(history.body[0].displayName, AGENT_DISPLAY_NAME);

  const feed = await bearer(token, '/api/changes?since=0&limit=1000');
  assert.equal(feed.res.status, 200);
  assert.equal(typeof feed.body.lastSeq, 'number');
  assert.equal(typeof feed.body.more, 'boolean');
  const row = feed.body.records.find((record) => record.store === 'machines' && record.id === machineId);
  assert.ok(row, 'the new machine appears in the feed');
});

test('read token can GET but not write', async () => {
  const { token } = await createToken({ name: 'Reader', scope: 'read' });
  const feed = await bearer(token, '/api/changes');
  assert.equal(feed.res.status, 200);

  const machineId = crypto.randomUUID();
  const denied = await bearer(token, `/api/records/machines/${machineId}`, {
    method: 'PUT',
    body: { data: { name: 'Nope', type: 'single-needle', status: 'running' } },
  });
  assert.equal(denied.res.status, 403);
  assert.equal(denied.body.error, 'forbidden');
});

test('tokens cannot reach users, roles, token management, backups or AI', async () => {
  const { token } = await createToken({ name: 'Scoped', scope: 'write' });
  for (const pathname of ['/api/users', '/api/roles', '/api/backups', '/api/tokens', '/api/ai/status']) {
    const result = await bearer(token, pathname);
    assert.equal(result.res.status, 403, `${pathname} must be human-only`);
  }
  const created = await bearer(token, '/api/tokens', { method: 'POST', body: { name: 'escalate', scope: 'write' } });
  assert.equal(created.res.status, 403);
});

// ---------------------------------------------------------------------------
// Auth failures and revocation
// ---------------------------------------------------------------------------

test('missing or malformed Bearer credentials return 401 invalid_token', async () => {
  const none = await fetch(`${base}/api/changes`);
  assert.equal(none.status, 401);
  assert.equal((await none.json()).error, 'login_required');

  const bogus = await bearer('mlt_not-a-real-token', '/api/changes');
  assert.equal(bogus.res.status, 401);
  assert.equal(bogus.body.error, 'invalid_token');
  assert.match(bogus.res.headers.get('www-authenticate') ?? '', /Bearer/);

  const malformed = await fetch(`${base}/api/changes`, { headers: { authorization: 'Token abc' } });
  assert.equal(malformed.status, 401);
  assert.equal((await malformed.json()).error, 'invalid_token');
});

test('a revoked token stops working immediately and stays in the list', async () => {
  const { token, id } = await createToken({ name: 'Short lived', scope: 'write' });
  assert.equal((await bearer(token, '/api/changes')).res.status, 200);

  const revoked = await session(`/api/tokens/${id}`, { method: 'DELETE' });
  assert.equal(revoked.res.status, 200);
  assert.equal(typeof revoked.body.revokedAt, 'string');

  const after = await bearer(token, '/api/changes');
  assert.equal(after.res.status, 401);
  assert.equal(after.body.error, 'invalid_token');

  const listed = await session('/api/tokens');
  const row = listed.body.find((entry) => entry.id === id);
  assert.equal(typeof row.revokedAt, 'string');
});

test('revoking an unknown token is 404; only admins may manage tokens', async () => {
  assert.equal((await session('/api/tokens/does-not-exist', { method: 'DELETE' })).res.status, 404);

  handle.store.createUser({
    username: 'ben',
    displayName: 'Ben Bolt',
    role: 'tech',
    passwordHash: auth.hashPassword('ben-password-1'),
  });
  const adminSid = sid;
  sid = await login('ben', 'ben-password-1');
  try {
    assert.equal((await session('/api/tokens')).res.status, 403);
    assert.equal((await session('/api/tokens', { method: 'POST', body: { name: 'x', scope: 'read' } })).res.status, 403);
  } finally {
    sid = adminSid;
  }
});

