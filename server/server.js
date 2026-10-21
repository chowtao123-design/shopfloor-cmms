'use strict';

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  burnPasswordCheck,
  checkCsrf,
  checkDisplayName,
  checkPassword,
  checkRole,
  checkUsername,
  clearSessionCookie,
  clearUsernameFailures,
  createSession,
  deleteSessionByToken,
  findSessionToken,
  hashPassword,
  loginRetryAfterSeconds,
  recordLoginFailure,
  sessionCookie,
  validateSession,
  verifyPassword,
} from './auth.js';
import { openStore } from './store.js';

/**
 * Shop Maintenance Log v2 team server: config from env, HTTP(S) server,
 * static allow-list, security headers, JSON body limit, /api routing
 * (SPEC-v2.md sections 2, 3, 4, 6.9, 7, 10).
 */

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
export const SERVER_VERSION = PACKAGE.version;

/** Maximum accepted JSON request body: 1 MB (SPEC-v2.md 6.9). */
export const BODY_LIMIT_BYTES = 1024 * 1024;

/** Security headers sent on every response (SPEC-v2.md 6.9). */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

// ---------------------------------------------------------------------------
// Configuration (SPEC-v2.md section 4)
// ---------------------------------------------------------------------------

function readInt(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${name} must be an integer between 0 and 65535, got ${JSON.stringify(String(raw))}`);
  }
  return n;
}

function readDailyAt(env) {
  const raw = env.BACKUP_DAILY_AT;
  const value = raw === undefined || raw === '' ? '02:00' : raw;
  if (value === 'off') return value;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`BACKUP_DAILY_AT must be "HH:MM" (local time) or "off", got ${JSON.stringify(String(value))}`);
  }
  return value;
}

/** Read server configuration from environment variables (SPEC-v2.md section 4). */
export function readConfig(env = process.env) {
  const tlsCert = env.TLS_CERT || undefined;
  const tlsKey = env.TLS_KEY || undefined;
  if ((tlsCert !== undefined) !== (tlsKey !== undefined)) {
    throw new Error('TLS_CERT and TLS_KEY must be set together to serve HTTPS');
  }
  return {
    port: readInt(env, 'PORT', 8080),
    host: env.HOST === undefined || env.HOST === '' ? '0.0.0.0' : env.HOST,
    dataDir: env.DATA_DIR === undefined || env.DATA_DIR === '' ? './data' : env.DATA_DIR,
    tlsCert,
    tlsKey,
    sessionDays: readInt(env, 'SESSION_DAYS', 14),
    backupKeep: readInt(env, 'BACKUP_KEEP', 30),
    backupDailyAt: readDailyAt(env),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const errorResponse = (code, message) => ({ error: code, message });

function send(req, res, status, headers, body) {
  const extra = body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) };
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, ...extra });
  if (req.method === 'HEAD' || body === undefined) res.end();
  else res.end(body);
}

function sendJson(req, res, status, payload, extraHeaders = {}) {
  send(
    req,
    res,
    status,
    { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
    JSON.stringify(payload)
  );
}

function notFound(req, res) {
  sendJson(req, res, 404, errorResponse('not_found', 'Not found'));
}

/**
 * Read and parse a JSON request body, rejecting bodies above BODY_LIMIT_BYTES
 * with 413 (SPEC-v2.md 6.9). Resolves with the parsed value; rejects with
 * HttpError (400/413) or the underlying stream error.
 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
      req.resume(); // drain the oversized body we are refusing
      reject(new HttpError(413, 'payload_too_large', 'Request body exceeds the 1 MB limit'));
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > BODY_LIMIT_BYTES) {
        fail(new HttpError(413, 'payload_too_large', 'Request body exceeds the 1 MB limit'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        reject(new HttpError(400, 'bad_json', 'Expected a JSON request body'));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'bad_json', 'Request body is not valid JSON'));
      }
    });
    req.on('error', (err) => fail(err));
  });
}

// ---------------------------------------------------------------------------
// Static file allow-list (SPEC-v2.md section 3)
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Resolve a request target to an allowed static file, or null when the request
 * must be rejected. Percent-decoding happens first so traversal (`..`,
 * encoded or raw) and hidden names (dotfiles, `.git/`) are always visible;
 * the result is matched against the explicit allow-list: `/`, `/index.html`,
 * `*.js` at the repo root, `styles.css`, `manifest.webmanifest`, `icons/*`.
 */
export function resolveStatic(rawUrl) {
  let target = rawUrl;
  const hash = target.indexOf('#');
  if (hash !== -1) target = target.slice(0, hash);
  const query = target.indexOf('?');
  if (query !== -1) target = target.slice(0, query);
  let decoded;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded === '/' || decoded === '') return { rel: 'index.html', type: CONTENT_TYPES['.html'] };
  if (!decoded.startsWith('/')) return null;
  const segments = decoded.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '') return null; // double slash or trailing slash
    if (segment === '.' || segment === '..') return null; // traversal
    if (segment.startsWith('.')) return null; // dotfiles (.git/, .gitignore, logs, ...)
    if (!/^[\x20-\x7e]+$/.test(segment)) return null; // printable ASCII filenames only
  }
  if (segments.length === 1) {
    const name = segments[0];
    if (name === 'index.html') return { rel: name, type: CONTENT_TYPES['.html'] };
    if (name === 'styles.css') return { rel: name, type: CONTENT_TYPES['.css'] };
    if (name === 'manifest.webmanifest') return { rel: name, type: CONTENT_TYPES['.webmanifest'] };
    if (name.endsWith('.js')) return { rel: name, type: CONTENT_TYPES['.js'] };
    return null;
  }
  if (segments.length === 2 && segments[0] === 'icons') {
    const type = CONTENT_TYPES[path.extname(segments[1])];
    return type ? { rel: `icons/${segments[1]}`, type } : null;
  }
  return null;
}

async function serveStatic(req, res, resolved) {
  const abs = path.join(ROOT_DIR, resolved.rel);
  if (!path.resolve(abs).startsWith(ROOT_DIR + path.sep)) {
    notFound(req, res);
    return;
  }
  let body;
  try {
    body = await fs.promises.readFile(abs);
  } catch {
    notFound(req, res);
    return;
  }
  send(req, res, 200, { 'Content-Type': resolved.type, 'Cache-Control': 'no-cache' }, body);
}

// ---------------------------------------------------------------------------
// API routing (SPEC-v2.md sections 6, 7)
// ---------------------------------------------------------------------------

function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

function publicUserWithDisabled(row) {
  return { ...publicUser(row), disabled: Number(row.disabled) === 1 };
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ipOf(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

const healthHandler = (req, res) => {
  sendJson(req, res, 200, { ok: true, version: SERVER_VERSION });
};

async function loginHandler(req, res, ctx) {
  const body = await readJsonBody(req);
  if (!isJsonObject(body)) {
    throw new HttpError(400, 'bad_request', 'Expected a JSON object body');
  }
  const { username, password } = body;
  if (typeof username !== 'string' || username.trim() === '' || typeof password !== 'string' || password === '') {
    throw new HttpError(400, 'bad_request', 'username and password are required strings');
  }
  const ip = ipOf(req);
  const retryAfterSeconds = loginRetryAfterSeconds(ctx.store, username, ip);
  if (retryAfterSeconds > 0) {
    sendJson(
      req,
      res,
      429,
      errorResponse(
        'rate_limited',
        `Too many failed sign-in attempts; try again in about ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minutes`
      ),
      { 'Retry-After': String(retryAfterSeconds) }
    );
    return;
  }
  const user = ctx.store.getUserByUsername(username.trim());
  if (user === null) burnPasswordCheck(password);
  const ok = user !== null && Number(user.disabled) !== 1 && verifyPassword(user.password_hash, password);
  if (!ok) {
    recordLoginFailure(ctx.store, username, ip);
    sendJson(req, res, 401, errorResponse('invalid_credentials', 'Invalid username or password'));
    return;
  }
  clearUsernameFailures(ctx.store, username);
  const session = createSession(ctx.store, user.id, ctx.sessionDays);
  sendJson(req, res, 200, publicUser(user), {
    'Set-Cookie': sessionCookie(session.token, ctx.sessionDays, ctx.scheme === 'https'),
  });
}

function logoutHandler(req, res, ctx) {
  const token = findSessionToken(req);
  if (token !== null) deleteSessionByToken(ctx.store, token);
  sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(ctx.scheme === 'https') });
}

function meHandler(req, res, ctx) {
  sendJson(req, res, 200, publicUser(ctx.user));
}

function listUsersHandler(req, res, ctx) {
  sendJson(req, res, 200, ctx.store.listUsers().map(publicUserWithDisabled));
}

async function createUserHandler(req, res, ctx) {
  const body = await readJsonBody(req);
  if (!isJsonObject(body)) {
    throw new HttpError(400, 'bad_request', 'Expected a JSON object body');
  }
  const checks = [
    checkUsername(body.username),
    checkDisplayName(body.displayName),
    checkRole(body.role),
    checkPassword(body.password),
  ];
  const failed = checks.find((check) => !check.ok);
  if (failed) {
    throw new HttpError(400, 'bad_request', failed.message);
  }
  const [username, displayName, role, password] = checks.map((check) => check.value);
  if (ctx.store.getUserByUsername(username) !== null) {
    throw new HttpError(409, 'username_taken', `Username "${username}" is already in use`);
  }
  const user = ctx.store.createUser({
    username,
    displayName,
    role,
    passwordHash: hashPassword(password),
  });
  sendJson(req, res, 201, publicUserWithDisabled(user));
}

async function patchUserHandler(req, res, ctx, params) {
  const body = await readJsonBody(req);
  if (!isJsonObject(body)) {
    throw new HttpError(400, 'bad_request', 'Expected a JSON object body');
  }
  const existing = ctx.store.getUserById(params.id);
  if (existing === null) {
    throw new HttpError(404, 'not_found', 'No such user');
  }
  if (
    'username' in body &&
    (typeof body.username !== 'string' || body.username.trim() !== existing.username)
  ) {
    throw new HttpError(400, 'bad_request', 'Usernames cannot be changed');
  }
  const fields = {};
  if (body.displayName !== undefined) {
    const displayName = checkDisplayName(body.displayName);
    if (!displayName.ok) throw new HttpError(400, 'bad_request', displayName.message);
    fields.displayName = displayName.value;
  }
  if (body.role !== undefined) {
    const role = checkRole(body.role);
    if (!role.ok) throw new HttpError(400, 'bad_request', role.message);
    fields.role = role.value;
  }
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== 'boolean') {
      throw new HttpError(400, 'bad_request', 'disabled must be a boolean');
    }
    fields.disabled = body.disabled ? 1 : 0;
  }
  if (body.password !== undefined) {
    const password = checkPassword(body.password);
    if (!password.ok) throw new HttpError(400, 'bad_request', password.message);
    fields.passwordHash = hashPassword(password.value);
  }
  if (Object.keys(fields).length === 0) {
    throw new HttpError(400, 'bad_request', 'Provide at least one of displayName, role, disabled, password');
  }
  const user = ctx.store.updateUser(existing.id, fields);
  if (fields.disabled === 1) ctx.store.deleteUserSessions(existing.id);
  sendJson(req, res, 200, publicUserWithDisabled(user));
}

function compileRoute(method, pathPattern, options, handler) {
  const keys = [];
  const source = pathPattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { method, regex: new RegExp(`^${source}$`), keys, ...options, handler };
}

const ROUTES = [
  compileRoute('GET', '/api/health', { auth: false }, healthHandler),
  compileRoute('POST', '/api/login', { auth: false }, loginHandler),
  compileRoute('POST', '/api/logout', { auth: true }, logoutHandler),
  compileRoute('GET', '/api/me', { auth: true }, meHandler),
  compileRoute('GET', '/api/users', { auth: true }, listUsersHandler),
  compileRoute('POST', '/api/users', { auth: true, admin: true }, createUserHandler),
  compileRoute('PATCH', '/api/users/:id', { auth: true, admin: true }, patchUserHandler),
];

function matchRoute(method, apiPath) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.regex.exec(apiPath);
    if (match === null) continue;
    const params = {};
    route.keys.forEach((key, index) => {
      params[key] = match[index + 1];
    });
    return { route, params };
  }
  return null;
}

function requireUser(req, ctx) {
  const token = findSessionToken(req);
  if (token === null) return null;
  return validateSession(ctx.store, token, ctx.sessionDays);
}

async function handleApi(req, res, decodedPath, ctx) {
  const effectiveMethod = req.method === 'HEAD' ? 'GET' : req.method;
  const matched = matchRoute(effectiveMethod, decodedPath);
  if (matched === null) {
    sendJson(req, res, 404, errorResponse('not_found', `No such API route: ${req.method} ${decodedPath}`));
    return;
  }
  const { route, params } = matched;
  const context = { ...ctx, user: null };
  if (route.auth) {
    const user = requireUser(req, context);
    if (user === null) {
      sendJson(req, res, 401, errorResponse('login_required', 'Sign in to use the API'));
      return;
    }
    context.user = user;
  }
  if (effectiveMethod !== 'GET') {
    const csrfError = checkCsrf(req);
    if (csrfError !== null) {
      sendJson(req, res, 403, errorResponse('forbidden', csrfError));
      return;
    }
  }
  if (route.admin && context.user.role !== 'admin') {
    sendJson(req, res, 403, errorResponse('forbidden', 'Only admins can manage users'));
    return;
  }
  await route.handler(req, res, context, params);
}

/** Decode the request path; returns the decoded pathname or null when the raw
 *  target is undecodable or unsafe (traversal, hidden segments). */
function decodeRequestPath(rawUrl) {
  try {
    const decoded = decodeURIComponent(rawUrl.split('#')[0].split('?')[0]);
    if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return null;
    if (decoded.length > 1 && (decoded.startsWith('//') || decoded.endsWith('/'))) return null;
    for (const segment of decoded.slice(1).split('/')) {
      if (segment === '..' || segment.startsWith('.')) return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function createRequestHandler(context = {}) {
  return function requestListener(req, res) {
    Promise.resolve()
      .then(async () => {
        const decodedPath = decodeRequestPath(req.url);
        if (decodedPath === null) {
          notFound(req, res);
          return;
        }
        if (decodedPath === '/api' || decodedPath.startsWith('/api/')) {
          await handleApi(req, res, decodedPath, context);
          return;
        }
        const resolved = resolveStatic(req.url);
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          if (resolved) {
            send(req, res, 405, {
              'Content-Type': 'application/json; charset=utf-8',
              Allow: 'GET, HEAD',
            }, JSON.stringify(errorResponse('method_not_allowed', 'This path only allows GET and HEAD')));
          } else {
            notFound(req, res);
          }
          return;
        }
        if (!resolved) {
          notFound(req, res);
          return;
        }
        await serveStatic(req, res, resolved);
      })
      .catch((err) => {
        if (res.writableEnded) return;
        if (err instanceof HttpError) {
          sendJson(req, res, err.status, errorResponse(err.code, err.message));
          return;
        }
        console.error('[maint-log] request error:', err);
        if (res.headersSent) {
          res.destroy(err);
          return;
        }
        sendJson(req, res, 500, errorResponse('internal', 'Internal server error'));
      });
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the server. Options override the environment configuration.
 * @param {object} [options] { port, host, dataDir, tlsCert, tlsKey,
 *   sessionDays, backupKeep, backupDailyAt, env }
 * @returns {Promise<{server: import('node:http').Server, port: number, host: string,
 *   config: object, store: object, scheme: string, url: string, close: () => Promise<void>}>}
 */
export async function startServer(options = {}) {
  const config = {
    ...readConfig(options.env ?? process.env),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.tlsCert !== undefined ? { tlsCert: options.tlsCert } : {}),
    ...(options.tlsKey !== undefined ? { tlsKey: options.tlsKey } : {}),
    ...(options.sessionDays !== undefined ? { sessionDays: options.sessionDays } : {}),
    ...(options.backupKeep !== undefined ? { backupKeep: options.backupKeep } : {}),
    ...(options.backupDailyAt !== undefined ? { backupDailyAt: options.backupDailyAt } : {}),
  };

  const store = openStore(config.dataDir);

  const useTls = Boolean(config.tlsCert && config.tlsKey);
  let tlsOptions;
  if (useTls) {
    try {
      tlsOptions = {
        cert: fs.readFileSync(config.tlsCert),
        key: fs.readFileSync(config.tlsKey),
      };
    } catch (err) {
      store.close();
      throw new Error(`Could not load TLS certificate or key: ${err.message}`);
    }
  }

  const scheme = useTls ? 'https' : 'http';
  const requestHandler = createRequestHandler({
    store,
    scheme,
    sessionDays: config.sessionDays,
    config,
  });
  const server = useTls
    ? https.createServer({ cert: tlsOptions.cert, key: tlsOptions.key }, requestHandler)
    : http.createServer(requestHandler);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    store.close();
  };

  return { server, port, host: config.host, config, store, scheme, url: `${scheme}://127.0.0.1:${port}`, close };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    const handle = await startServer();
    const displayHost = handle.host === '0.0.0.0' ? '(any LAN address)' : handle.host;
    console.log(`Shop Maintenance Log v2 server ${SERVER_VERSION} listening`);
    console.log(`  ${handle.scheme}://${displayHost}:${handle.port}`);
    console.log(`  data dir: ${path.resolve(handle.config.dataDir)}`);
    const shutdown = (signal) => {
      console.log(`\n${signal} received, shutting down`);
      handle
        .close()
        .then(() => process.exit(0))
        .catch((err) => {
          console.error('Shutdown failed:', err);
          process.exit(1);
        });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}