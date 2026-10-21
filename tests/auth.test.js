'use strict';

import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { openStore } from '../server/store.js';
import { startServer } from '../server/server.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const XRW = { 'X-Requested-With': 'maint-log' };

function setCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single === null ? [] : [single];
}

async function login(url, username, password, extraHeaders = {}) {
  const res = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...XRW, ...extraHeaders },
    body: JSON.stringify({ username, password }),
  });
  const sidCookie = setCookies(res).find((value) => value.startsWith('sid=')) || null;
  const token = sidCookie === null ? null : sidCookie.split(';')[0].slice('sid='.length);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, sidCookie, token, body };
}

const cookie = (token) => ({ cookie: `sid=${token}` });

let handle;
let base;

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'auth-test-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  base = handle.url;
  handle.store.createUser({
    username: 'root',
    displayName: 'Root Admin',
    role: 'admin',
    passwordHash: auth.hashPassword('root-password-1'),
  });
  handle.store.createUser({
    username: 'tess',
    displayName: 'Tess Tech',
    role: 'tech',
    passwordHash: auth.hashPassword('tess-password-1'),
  });
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
});

test('successful login sets a session cookie with the right flags (no Secure over http)', async () => {
  const { res, sidCookie, token, body } = await login(base, 'root', 'root-password-1');
  assert.equal(res.status, 200);
  assert.ok(sidCookie);
  assert.match(sidCookie, /^sid=[A-Za-z0-9_-]{43};/);
  assert.ok(sidCookie.includes('HttpOnly'));
  assert.ok(sidCookie.includes('SameSite=Strict'));
  assert.ok(sidCookie.includes('Path=/'));
  assert.ok(sidCookie.includes(`Max-Age=${handle.config.sessionDays * 86400}`));
  assert.ok(!sidCookie.includes('Secure'));
  assert.ok(token);
  const root = handle.store.getUserByUsername('root');
  assert.deepEqual(body, { id: root.id, username: 'root', displayName: 'Root Admin', role: 'admin' });
});

test('cookie strings set and clear with Secure only for HTTPS', () => {
  assert.equal(auth.sessionCookie('tok', 14, false), 'sid=tok; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600');
  assert.equal(
    auth.sessionCookie('tok', 14, true),
    'sid=tok; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600; Secure'
  );
  assert.equal(auth.clearSessionCookie(false), 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  assert.equal(auth.clearSessionCookie(true), 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');
});

test('GET /api/me returns the signed-in user without the password hash', async () => {
  const { token } = await login(base, 'tess', 'tess-password-1');
  assert.ok(token);
  const res = await fetch(`${base}/api/me`, { headers: cookie(token) });
  assert.equal(res.status, 200);
  const body = await res.json();
  const tess = handle.store.getUserByUsername('tess');
  assert.deepEqual(body, { id: tess.id, username: 'tess', displayName: 'Tess Tech', role: 'tech' });
  assert.ok(!JSON.stringify(body).includes('password'));
  assert.ok(!JSON.stringify(body).includes(tess.password_hash));
});

test('API routes without a valid session answer 401 login_required', async () => {
  for (const target of ['/api/me', '/api/users']) {
    const res = await fetch(`${base}${target}`);
    assert.equal(res.status, 401, target);
    const body = await res.json();
    assert.equal(body.error, 'login_required');
    assert.equal(typeof body.message, 'string');
    assert.ok(body.message.length > 0);
  }
  const bogus = await fetch(`${base}/api/me`, { headers: cookie('not-a-real-session-token') });
  assert.equal(bogus.status, 401);
  assert.equal((await bogus.json()).error, 'login_required');
});

test('non-GET API requests need X-Requested-With and a matching Origin (403 otherwise)', async () => {
  const attempt = (headers) =>
    fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'root', password: 'root-password-1' }),
    });

  const missing = await attempt({});
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).error, 'forbidden');

  const mismatched = await attempt({ ...XRW, origin: 'http://evil.example' });
  assert.equal(mismatched.status, 403);
  assert.equal((await mismatched.json()).error, 'forbidden');

  const matching = await attempt({ ...XRW, origin: base });
  assert.equal(matching.status, 200);

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);

  const other = await fetch(`${base}/health`);
  assert.equal(other.status, 404);
});

test('unknown user, wrong password and disabled user all get the same generic error', async () => {
  handle.store.createUser({
    username: 'off',
    displayName: 'Off Duty',
    role: 'tech',
    passwordHash: auth.hashPassword('off-duty-pass'),
  });
  const offRow = handle.store.getUserByUsername('off');
  handle.store.updateUser(offRow.id, { disabled: 1 });

  const results = [
    await login(base, 'who-is-this', 'whatever-password'),
    await login(base, 'root', 'not-the-password'),
    await login(base, 'off', 'off-duty-pass'),
  ];
  for (const result of results) {
    assert.equal(result.res.status, 401);
    assert.deepEqual(result.body, { error: 'invalid_credentials', message: 'Invalid username or password' });
    assert.equal(result.sidCookie, null);
  }
  assert.deepEqual(results[0].body, results[1].body);
  assert.deepEqual(results[1].body, results[2].body);
});

test('passwords are stored as scrypt hashes, never plaintext', () => {
  const root = handle.store.getUserByUsername('root');
  assert.notEqual(root.password_hash, 'root-password-1');
  assert.match(root.password_hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/);
  assert.ok(auth.verifyPassword(root.password_hash, 'root-password-1'));
  assert.ok(!auth.verifyPassword(root.password_hash, 'root-password-2'));
  assert.ok(!auth.verifyPassword('root-password-1', 'root-password-1'));
  assert.ok(!auth.verifyPassword('scrypt$16384$8$1$AAAA$BBBB', 'root-password-1'));

  const first = auth.hashPassword('same-password-1');
  const second = auth.hashPassword('same-password-1');
  assert.notEqual(first, second);
  assert.ok(auth.verifyPassword(first, 'same-password-1'));
  assert.ok(auth.verifyPassword(second, 'same-password-1'));
});

test('tech users cannot create users (403) but can list them', async () => {
  const { token } = await login(base, 'tess', 'tess-password-1');
  assert.ok(token);
  const denied = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...XRW, ...cookie(token) },
    body: JSON.stringify({ username: 'nope', displayName: 'Nope Never', role: 'tech', password: 'nope-pass-123' }),
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'forbidden');

  const list = await fetch(`${base}/api/users`, { headers: cookie(token) });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(await list.json()));
});

test('admin can create users; the list shows everyone without hashes', async () => {
  const { token } = await login(base, 'root', 'root-password-1');
  assert.ok(token);
  const headers = { 'content-type': 'application/json', ...XRW, ...cookie(token) };

  const short = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'shorty', displayName: 'Shorty', role: 'tech', password: 'short' }),
  });
  assert.equal(short.status, 400);
  assert.equal((await short.json()).error, 'bad_request');

  const created = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'nina', displayName: 'Nina New', role: 'tech', password: 'nina-pass-123' }),
  });
  assert.equal(created.status, 201);
  const nina = await created.json();
  const ninaRow = handle.store.getUserByUsername('nina');
  assert.deepEqual(nina, { id: ninaRow.id, username: 'nina', displayName: 'Nina New', role: 'tech', disabled: false });

  const duplicate = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'NINA', displayName: 'Nina Copy', role: 'tech', password: 'nina-pass-456' }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error, 'username_taken');

  const freshLogin = await login(base, 'nina', 'nina-pass-123');
  assert.equal(freshLogin.res.status, 200);
  assert.ok(freshLogin.token);

  const list = await fetch(`${base}/api/users`, { headers: cookie(token) });
  assert.equal(list.status, 200);
  const users = await list.json();
  assert.ok(Array.isArray(users));
  assert.ok(users.some((user) => user.username === 'nina'));
  for (const user of users) {
    assert.equal(typeof user.id, 'string');
    assert.equal(typeof user.displayName, 'string');
    assert.equal(typeof user.role, 'string');
    assert.equal(typeof user.disabled, 'boolean');
    assert.deepEqual(Object.keys(user).sort(), ['disabled', 'displayName', 'id', 'role', 'username']);
  }
});

test('disabling a user deletes their sessions and locks them out', async () => {
  const { token: adminToken } = await login(base, 'root', 'root-password-1');
  const adminHeaders = { 'content-type': 'application/json', ...XRW, ...cookie(adminToken) };

  const created = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ username: 'gil', displayName: 'Gil Guest', role: 'tech', password: 'gil-pass-1234' }),
  });
  assert.equal(created.status, 201);
  const gil = await created.json();

  const gilLogin = await login(base, 'gil', 'gil-pass-1234');
  assert.equal(gilLogin.res.status, 200);
  assert.ok(gilLogin.token);
  const meBefore = await fetch(`${base}/api/me`, { headers: cookie(gilLogin.token) });
  assert.equal(meBefore.status, 200);

  const patch = await fetch(`${base}/api/users/${gil.id}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).disabled, true);

  const meAfter = await fetch(`${base}/api/me`, { headers: cookie(gilLogin.token) });
  assert.equal(meAfter.status, 401);
  assert.equal((await meAfter.json()).error, 'login_required');

  const locked = await login(base, 'gil', 'gil-pass-1234');
  assert.equal(locked.res.status, 401);
  assert.equal(locked.body.error, 'invalid_credentials');

  const sessionCount = handle.store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(gil.id);
  assert.equal(sessionCount.n, 0);

  const ghost = await fetch(`${base}/api/users/no-such-user-id`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(ghost.status, 404);
  assert.equal((await ghost.json()).error, 'not_found');

  const reenable = await fetch(`${base}/api/users/${gil.id}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ disabled: false }),
  });
  assert.equal(reenable.status, 200);
  assert.equal((await reenable.json()).disabled, false);

  const again = await login(base, 'gil', 'gil-pass-1234');
  assert.equal(again.res.status, 200);

  const techPatch = await fetch(`${base}/api/users/${gil.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...XRW, ...cookie(again.token) },
    body: JSON.stringify({ displayName: 'Nope Never' }),
  });
  assert.equal(techPatch.status, 403);
});

test('POST /api/logout deletes the session and clears the cookie', async () => {
  const { token } = await login(base, 'root', 'root-password-1');
  assert.ok(token);

  const out = await fetch(`${base}/api/logout`, {
    method: 'POST',
    headers: { ...XRW, ...cookie(token) },
  });
  assert.equal(out.status, 200);
  const cleared = setCookies(out).find((value) => value.startsWith('sid='));
  assert.ok(cleared);
  assert.match(cleared, /^sid=;/);
  assert.ok(cleared.includes('Max-Age=0'));
  assert.ok(cleared.includes('HttpOnly'));
  assert.ok(cleared.includes('SameSite=Strict'));
  assert.ok(cleared.includes('Path=/'));

  const me = await fetch(`${base}/api/me`, { headers: cookie(token) });
  assert.equal(me.status, 401);

  const row = handle.store.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(auth.hashToken(token));
  assert.equal(row, undefined);
});

test('ten failed logins lock the username: 429 with Retry-After', async () => {
  handle.store.db.exec('DELETE FROM login_attempts');
  handle.store.createUser({
    username: 'rl',
    displayName: 'Rate Limited',
    role: 'tech',
    passwordHash: auth.hashPassword('rl-pass-1234'),
  });
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const { res } = await login(base, 'rl', 'wrong-password-x');
    assert.equal(res.status, 401, `failed attempt ${attempt}`);
  }
  const rlRow = handle.store.getLoginAttempt('u:rl');
  assert.ok(rlRow !== null && rlRow.count === 10);
  const blocked = await login(base, 'rl', 'rl-pass-1234');
  assert.equal(blocked.res.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  const retryAfter = Number(blocked.res.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 900);

  const otherUser = await login(base, 'root', 'root-password-1');
  assert.equal(otherUser.res.status, 429);

  handle.store.db.exec('DELETE FROM login_attempts');
  const recovered = await login(base, 'root', 'root-password-1');
  assert.equal(recovered.res.status, 200);
});

test('ten failures across different usernames lock the IP address too', async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'auth-ip-test-'));
  let server;
  try {
    server = await startServer({ port: 0, host: '127.0.0.1', dataDir });
    server.store.createUser({
      username: 'many',
      displayName: 'Many Mistakes',
      role: 'tech',
      passwordHash: auth.hashPassword('many-pass-1234'),
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { res } = await login(server.url, `ghost-${attempt}`, 'wrong-password-x');
      assert.equal(res.status, 401, `attempt ${attempt}`);
    }
    const blocked = await login(server.url, 'many', 'many-pass-1234');
    assert.equal(blocked.res.status, 429);
    assert.equal(blocked.body.error, 'rate_limited');
    assert.ok(Number(blocked.res.headers.get('retry-after')) >= 1);
  } finally {
    if (server) await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sessions slide: expiry extends at most once per hour of use', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'auth-slide-'));
  const store = openStore(dataDir);
  try {
    const user = store.createUser({
      username: 'slide',
      displayName: 'Slide Test',
      role: 'tech',
      passwordHash: auth.hashPassword('slide-pass-123'),
    });
    const session = auth.createSession(store, user.id, 14);
    const created = store.getSessionWithUser(session.tokenHash);

    assert.ok(auth.validateSession(store, session.token, 14) !== null);
    const afterFirstUse = store.getSessionWithUser(session.tokenHash);
    assert.equal(afterFirstUse.expires_at, created.expires_at);

    store.touchSession(session.tokenHash, {
      lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    assert.ok(auth.validateSession(store, session.token, 14) !== null);
    const afterSlide = store.getSessionWithUser(session.tokenHash);
    assert.ok(Date.parse(afterSlide.expires_at) > Date.parse(created.expires_at));

    store.touchSession(session.tokenHash, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(auth.validateSession(store, session.token, 14), null);
    assert.equal(store.getSessionWithUser(session.tokenHash), null);
  } finally {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('server/admin.js CLI', () => {
  let dataDir;
  let server;

  const run = (args, input = '') =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(REPO, 'server', 'admin.js'), ...args], {
        cwd: REPO,
        env: { ...process.env, DATA_DIR: dataDir },
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
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      if (input !== '') child.stdin.write(input);
      child.stdin.end();
    });

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(TMP, 'admin-cli-'));
    server = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  });

  after(async () => {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('create-user --password-stdin creates a working admin account', async () => {
    const created = await run(
      ['create-user', '--admin', 'bosun', 'Bosun Chief', '--password-stdin'],
      'bosun-pass-123\n'
    );
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /Created admin "bosun"/);

    const store = openStore(dataDir);
    try {
      const row = store.getUserByUsername('bosun');
      assert.notEqual(row, null);
      assert.equal(row.role, 'admin');
      assert.equal(row.display_name, 'Bosun Chief');
      assert.notEqual(row.password_hash, 'bosun-pass-123');
      assert.ok(auth.verifyPassword(row.password_hash, 'bosun-pass-123'));
    } finally {
      store.close();
    }

    const signedIn = await login(server.url, 'bosun', 'bosun-pass-123');
    assert.equal(signedIn.res.status, 200);
    assert.ok(signedIn.token);
    const me = await fetch(`${server.url}/api/me`, { headers: cookie(signedIn.token) });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), {
      id: server.store.getUserByUsername('bosun').id,
      username: 'bosun',
      displayName: 'Bosun Chief',
      role: 'admin',
    });
  });

  it('rejects passwords shorter than 8 characters', async () => {
    const created = await run(['create-user', 'shrimp', 'Shrimp Short', '--password-stdin'], 'short1\n');
    assert.notEqual(created.code, 0);
    assert.match(`${created.stderr}${created.stdout}`, /at least 8/);

    const store = openStore(dataDir);
    try {
      assert.equal(store.getUserByUsername('shrimp'), null);
    } finally {
      store.close();
    }
  });

  it('list-users lists the created users without passwords', async () => {
    const listed = await run(['list-users']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /username/);
    assert.match(listed.stdout, /bosun/);
    assert.doesNotMatch(listed.stdout, /shrimp/);
    assert.ok(!listed.stdout.includes('bosun-pass-123'));
  });

  it('disable-user blocks sign-in and deletes sessions; enable-user restores access', async () => {
    const signedIn = await login(server.url, 'bosun', 'bosun-pass-123');
    assert.equal(signedIn.res.status, 200);
    assert.ok(signedIn.token);

    const disabled = await run(['disable-user', 'bosun']);
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.match(disabled.stdout, /Disabled "bosun"/);

    const me = await fetch(`${server.url}/api/me`, { headers: cookie(signedIn.token) });
    assert.equal(me.status, 401);

    const locked = await login(server.url, 'bosun', 'bosun-pass-123');
    assert.equal(locked.res.status, 401);
    assert.equal(locked.body.error, 'invalid_credentials');

    const enabled = await run(['enable-user', 'bosun']);
    assert.equal(enabled.code, 0, enabled.stderr);
    assert.match(enabled.stdout, /Enabled "bosun"/);

    const again = await login(server.url, 'bosun', 'bosun-pass-123');
    assert.equal(again.res.status, 200);
  });

  it('reset-password changes the password', async () => {
    const reset = await run(['reset-password', 'bosun', '--password-stdin'], 'fresh-bosun-pass\n');
    assert.equal(reset.code, 0, reset.stderr);
    assert.match(reset.stdout, /Password updated for "bosun"/);

    const oldPassword = await login(server.url, 'bosun', 'bosun-pass-123');
    assert.equal(oldPassword.res.status, 401);

    const newPassword = await login(server.url, 'bosun', 'fresh-bosun-pass');
    assert.equal(newPassword.res.status, 200);
  });
});