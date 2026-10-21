'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  startServer,
  readConfig,
  SECURITY_HEADERS,
  SERVER_VERSION,
  BODY_LIMIT_BYTES,
} from '../server/server.js';
import { openStore, SCHEMA_VERSION } from '../server/store.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

/** Assert `{error: code, message: <non-empty string>}` (SPEC-v2.md section 7). */
function assertApiError(body, code) {
  assert.ok(body && typeof body === 'object');
  assert.equal(body.error, code);
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0);
}

/** Raw HTTP request with full control over the request target (no URL
 *  normalization, so traversal attempts reach the server verbatim). */
function rawRequest(target, { method = 'GET', headers = {}, writeChunks = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: handle.port, method, path: target, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = text;
          try {
            body = JSON.parse(text);
          } catch { /* keep raw text */ }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
    if (writeChunks) {
      for (const chunk of writeChunks) req.write(chunk);
    }
    req.end();
  });
}

let handle;
let base;

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'server-test-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  assert.ok(fs.existsSync(path.join(dataDir, 'maint.db')), 'startServer opens maint.db in dataDir');
  base = handle.url;
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(path.join(handle.config.dataDir, 'maint.db')), 'test data dir cleaned up');
});

// ---------------------------------------------------------------------------
// config (SPEC-v2.md section 4)
// ---------------------------------------------------------------------------

test('readConfig returns documented defaults', () => {
  assert.deepEqual(readConfig({}), {
    port: 8080,
    host: '0.0.0.0',
    dataDir: './data',
    tlsCert: undefined,
    tlsKey: undefined,
    sessionDays: 14,
    backupKeep: 30,
    backupDailyAt: '02:00',
  });
});

test('readConfig reads environment variables', () => {
  const cfg = readConfig({
    PORT: '9000',
    HOST: 'localhost',
    DATA_DIR: '/srv/maint-log-data',
    TLS_CERT: 'cert.pem',
    TLS_KEY: 'key.pem',
    SESSION_DAYS: '7',
    BACKUP_KEEP: '5',
    BACKUP_DAILY_AT: '03:15',
  });
  assert.deepEqual(cfg, {
    port: 9000,
    host: 'localhost',
    dataDir: '/srv/maint-log-data',
    tlsCert: 'cert.pem',
    tlsKey: 'key.pem',
    sessionDays: 7,
    backupKeep: 5,
    backupDailyAt: '03:15',
  });
});

test('readConfig accepts BACKUP_DAILY_AT=off and rejects invalid values', () => {
  assert.equal(readConfig({ BACKUP_DAILY_AT: 'off' }).backupDailyAt, 'off');
  assert.throws(() => readConfig({ PORT: 'eighty' }), /PORT/);
  assert.throws(() => readConfig({ PORT: '-1' }), /PORT/);
  assert.throws(() => readConfig({ SESSION_DAYS: 'x' }), /SESSION_DAYS/);
  assert.throws(() => readConfig({ BACKUP_DAILY_AT: '24:30' }), /BACKUP_DAILY_AT/);
  assert.throws(() => readConfig({ BACKUP_DAILY_AT: '2:00' }), /BACKUP_DAILY_AT/);
  assert.throws(() => readConfig({ TLS_CERT: 'cert.pem' }), /TLS_CERT and TLS_KEY/);
  assert.throws(() => readConfig({ TLS_KEY: 'key.pem' }), /TLS_CERT and TLS_KEY/);
});

// ---------------------------------------------------------------------------
// /api/health (SPEC-v2.md section 7)
// ---------------------------------------------------------------------------

test('GET /api/health returns ok and the server version as JSON', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, version: SERVER_VERSION });
  assert.equal(typeof body.version, 'string');
  assert.notEqual(body.version, '');
});

test('HEAD /api/health behaves like GET without a body', async () => {
  const res = await fetch(`${base}/api/health`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('unknown API routes return 404 not_found', async () => {
  for (const target of ['/api/nope', '/api/', '/api/health/extra']) {
    const res = await fetch(`${base}${target}`);
    assert.equal(res.status, 404, target);
    assertApiError(await res.json(), 'not_found');
  }
});

// ---------------------------------------------------------------------------
// security headers (SPEC-v2.md 6.9) on every response
// ---------------------------------------------------------------------------

const SPEC_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function assertSecurityHeaders(headers) {
  // `headers` is a fetch Headers instance.
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('referrer-policy'), 'same-origin');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('content-security-policy'), SPEC_CSP);
  assert.equal(headers.get('content-security-policy'), SECURITY_HEADERS['Content-Security-Policy']);
}

test('security headers are present on API responses', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assertSecurityHeaders(res.headers);
});

test('security headers are present on static responses', async () => {
  const res = await fetch(`${base}/styles.css`);
  assert.equal(res.status, 200);
  assertSecurityHeaders(res.headers);
});

test('security headers are present on 404 responses', async () => {
  const res = await fetch(`${base}/no-such-file.txt`);
  assert.equal(res.status, 404);
  assertSecurityHeaders(res.headers);
});

// ---------------------------------------------------------------------------
// static allow-list (SPEC-v2.md section 3)
// ---------------------------------------------------------------------------

test('serves / as index.html with the right content type', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(await res.text(), fs.readFileSync(path.join(REPO, 'index.html'), 'utf8'));
});

test('serves /index.html identically to /', async () => {
  const res = await fetch(`${base}/index.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(await res.text(), fs.readFileSync(path.join(REPO, 'index.html'), 'utf8'));
});

test('serves allowed repo-root *.js files as text/javascript', async () => {
  for (const name of ['app.js', 'db.js', 'logic.js', 'help.js', 'seed.js', 'sw.js']) {
    const res = await fetch(`${base}/${name}`);
    assert.equal(res.status, 200, name);
    assert.match(res.headers.get('content-type'), /^text\/javascript/, name);
    assert.equal(await res.text(), fs.readFileSync(path.join(REPO, name), 'utf8'), name);
  }
});

test('serves styles.css as text/css', async () => {
  const res = await fetch(`${base}/styles.css`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/css/);
  assert.equal(await res.text(), fs.readFileSync(path.join(REPO, 'styles.css'), 'utf8'));
});

test('serves manifest.webmanifest as application/manifest+json', async () => {
  const res = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/manifest+json');
  assert.equal(await res.text(), fs.readFileSync(path.join(REPO, 'manifest.webmanifest'), 'utf8'));
});

test('serves icons/* with the right content type', async () => {
  const res = await fetch(`${base}/icons/icon-192.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const expected = fs.readFileSync(path.join(REPO, 'icons', 'icon-192.png'));
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), expected);
});

test('HEAD / returns headers without a body', async () => {
  const res = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  const size = fs.statSync(path.join(REPO, 'index.html')).size;
  assert.equal(res.headers.get('content-length'), String(size));
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('nonexistent allowed-shape files still 404', async () => {
  for (const name of ['does-not-exist.js', 'ghost.js', 'made-up-name.js']) {
    const res = await fetch(`${base}/${name}`);
    assert.equal(res.status, 404, name);
    assertApiError(await res.json(), 'not_found');
  }
});

test('non-GET/HEAD on an allowed static path returns 405, blocked paths stay 404', async () => {
  const allowed = await rawRequest('/app.js', { method: 'POST' });
  assert.equal(allowed.status, 405);
  assert.equal(allowed.headers.allow, 'GET, HEAD');
  assertApiError(allowed.body, 'method_not_allowed');

  const blocked = await rawRequest('/server/server.js', { method: 'POST' });
  assert.equal(blocked.status, 404);
});

// ---------------------------------------------------------------------------
// forbidden files: server/, data/, tests/, .git/, .tmp/, *.md, logs, dotfiles
// ---------------------------------------------------------------------------

const FORBIDDEN_GET = [
  '/server/server.js',
  '/server/store.js',
  '/server/auth.js',
  '/server/admin.js',
  '/data/maint.db',
  '/data/backups/maint-20261020-020000-schedule.db',
  '/tests/logic.test.js',
  '/tests/index.js',
  '/tests/server.test.js',
  '/.git/config',
  '/.git/HEAD',
  '/.gitignore',
  '/.tmp/server-test-x/maint.db',
  '/.opencode-build.log',
  '/SPEC.md',
  '/SPEC-v2.md',
  '/README.md',
  '/package.json',
  '/icons/icon-192.png.bak',
  '/icons/../icon-192.png',
];

for (const target of FORBIDDEN_GET) {
  test(`404 for forbidden static file: ${target}`, async () => {
    const res = await rawRequest(target);
    assert.equal(res.status, 404);
    assertApiError(res.body, 'not_found');
  });
}

// ---------------------------------------------------------------------------
// path traversal: raw and percent-encoded (SPEC-v2.md section 3)
// ---------------------------------------------------------------------------

const TRAVERSAL_TARGETS = [
  '/../SPEC.md',
  '/../../etc/passwd',
  '/../server/server.js',
  '/server/../server/server.js',
  '/..%2fSPEC.md',
  '/..%2Fserver%2Fserver.js',
  '/%2e%2e/SPEC.md',
  '/%2E%2E/server/store.js',
  '/icons/%2e%2e/app.js',
  '/icons/%2e%2e%2fserver%2fserver.js',
  '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  '/server/%2e%2e/%2e%2e/SPEC.md',
  '/app.js%00.txt',
  '/%2e/env',
  '/..%5c..%5cserver%5cserver.js',
  '/..',
];

for (const target of TRAVERSAL_TARGETS) {
  test(`404 for traversal attempt: ${target}`, async () => {
    const res = await rawRequest(target);
    assert.equal(res.status, 404);
    assertApiError(res.body, 'not_found');
  });
}

test('percent-encoding in an allowed path still serves the real file', async () => {
  const res = await rawRequest('/app%2Ejs');
  assert.equal(res.status, 200);
  assert.equal(res.body, fs.readFileSync(path.join(REPO, 'app.js'), 'utf8'));
});

test('double slashes and trailing slashes are rejected', async () => {
  for (const target of ['//app.js', '/app.js/', '/icons//icon-192.png', '/icons/']) {
    const res = await rawRequest(target);
    assert.equal(res.status, 404, target);
  }
});

// ---------------------------------------------------------------------------
// JSON body limit: 1 MB (SPEC-v2.md 6.9)
// ---------------------------------------------------------------------------

test('POST /api/login answers 401 invalid_credentials for an unknown user', async () => {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Requested-With': 'maint-log' },
    body: JSON.stringify({ username: 'ada', password: 'hunter2222' }),
  });
  assert.equal(res.status, 401);
  assertApiError(await res.json(), 'invalid_credentials');
});

test('POST /api/login without X-Requested-With is rejected with 403 forbidden', async () => {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ada', password: 'hunter2222' }),
  });
  assert.equal(res.status, 403);
  assertApiError(await res.json(), 'forbidden');
});

test('POST /api/login rejects invalid JSON with 400', async () => {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Requested-With': 'maint-log' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assertApiError(await res.json(), 'bad_json');
});

test('POST with a declared Content-Length over 1 MB returns 413', async () => {
  const oversized = 'x'.repeat(BODY_LIMIT_BYTES + 1);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Requested-With': 'maint-log' },
    body: oversized,
  });
  assert.equal(res.status, 413);
  assertApiError(await res.json(), 'payload_too_large');
});

test('POST that streams more than 1 MB without Content-Length returns 413', async () => {
  const chunk = Buffer.from('x'.repeat(256 * 1024));
  const writeChunks = [];
  while (writeChunks.length * chunk.length <= BODY_LIMIT_BYTES) {
    writeChunks.push(chunk);
  } // 5 x 256 KB > 1 MB, sent with chunked transfer-encoding (no Content-Length)
  const res = await rawRequest('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'maint-log' },
    writeChunks,
  });
  assert.equal(res.status, 413);
  assertApiError(res.body, 'payload_too_large');
});

test('POST bodies up to exactly 1 MB are accepted (boundary)', async () => {
  const pad = 'x'.repeat(BODY_LIMIT_BYTES - 10);
  const body = JSON.stringify({ pad }); // 10 bytes of JSON scaffolding
  assert.equal(Buffer.byteLength(body), BODY_LIMIT_BYTES);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Requested-With': 'maint-log' },
    body,
  });
  assert.equal(res.status, 400); // parsed fine: validation, not the body limit, answers
  assertApiError(await res.json(), 'bad_request');
});

// ---------------------------------------------------------------------------
// store schema (SPEC-v2.md section 5)
// ---------------------------------------------------------------------------

test('openStore creates the full v2 schema with WAL, foreign keys and counters', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'store-test-'));
  try {
    const store = openStore(dataDir);
    assert.equal(store.dbFile, path.join(dataDir, 'maint.db'));
    assert.equal(store.getMeta('schema_version'), String(SCHEMA_VERSION));

    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const table of [
      'meta', 'users', 'sessions', 'records', 'history',
      'stock_moves', 'backups', 'login_attempts', 'counters',
    ]) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }
    const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    assert.ok(indexes.includes('idx_records_seq'), 'records(seq) index');
    assert.ok(indexes.includes('idx_history_store_record'), 'history(store, record_id) index');

    assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);

    assert.equal(store.db.prepare('SELECT value FROM counters WHERE name = ?').get('seq'), undefined);
    assert.equal(store.nextSeq(), 1);
    assert.equal(store.nextSeq(), 2);
    assert.equal(store.nextSeq(), 3);

    assert.throws(
      () => store.db.prepare('INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)').run('t1', 'no-such-user'),
      /FOREIGN KEY/
    );
    assert.throws(
      () =>
        store.db
          .prepare('INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run('u1', 'ada', 'Ada', 'scrypt$16384$8$1$AAAA$BBBB', 'owner', '2026-10-20T00:00:00.000Z'),
      /CHECK/
    );
    assert.throws(
      () => store.db.prepare("INSERT INTO history (store, record_id, action) VALUES ('machines', 'm1', 'explode')").run(),
      /CHECK/
    );

    store.close();
    const reopened = openStore(dataDir);
    assert.equal(reopened.getMeta('schema_version'), String(SCHEMA_VERSION));
    assert.equal(reopened.nextSeq(), 4, 'counters persist across reopen');
    reopened.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('startServer is reusable: a second server on another port serves the same API', async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'server-test-'));
  let second;
  try {
    second = await startServer({ port: 0, host: '127.0.0.1', dataDir });
    const res = await fetch(`${second.url}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, version: SERVER_VERSION });
  } finally {
    if (second) await second.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});