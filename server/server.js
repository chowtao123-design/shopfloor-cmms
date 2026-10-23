'use strict';

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.js';

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
import {
  BackupRateLimitError,
  createBackup,
  isValidBackupName,
  listBackups,
  startBackupSchedule,
} from './backup.js';
import {
  ApiError,
  STORES,
  applyStockMoves,
  deleteRecord,
  importV1,
  putRecord,
  sanitizeHistoryForRole,
  sanitizeRecordForRole,
} from './records.js';
import { createUploadedFile, findFileById, streamStoredFile } from './files.js';
import { scheduleFileTextExtraction, startTextExtractionQueue } from './fileTexts.js';
import {
  brandingPayload,
  clearBrandingLogo,
  getBrandingLogoFile,
  setBrandingLogo,
  setBrandingName,
} from './branding.js';
import {
  aiApplyProposal,
  aiDeleteHistory,
  aiGetConfig,
  aiGetHistory,
  aiGetStatus,
  aiPostChat,
  aiPostTest,
  aiPutConfig,
} from './ai.js';
import {
  areaLabel,
  can,
  enabledUsersWithAdminWrite,
  hasAdminWrite,
  normalizePermissions,
  permissionsOf,
  storeArea,
} from './permissions.js';
import { hashApiToken, openStore } from './store.js';
import { ensureAgentUser, tokenPathAllowed, validTokenRequest } from './apiTokens.js';
import { openApiSpec } from './openapi.js';

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
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const errorResponse = (code, message, extra = {}) => ({ error: code, message, ...extra });

/**
 * Forbidden body for a failed permission check (SPEC-v3.md 13.2):
 * `{error: "forbidden", area, needed: "read"|"write"}` (+ a human message).
 */
function forbiddenError(area, level) {
  return new HttpError(403, 'forbidden', `Your role needs "${level}" access to ${areaLabel(area)} for this`, {
    area,
    needed: level,
  });
}

/** The one gate used inside route handlers (the route table uses `area`). */
function requireArea(ctx, area, level) {
  if (!can(ctx.user, area, level)) throw forbiddenError(area, level);
}

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
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    // Legacy role column, kept readable for one version (SPEC-v3.md 13.2).
    role: row.role === undefined ? null : row.role,
    roleId: row.role_id !== undefined ? row.role_id : (row.roleId ?? null),
    roleName: row.role_name !== undefined ? row.role_name : (row.roleName ?? null),
  };
}

function publicUserWithDisabled(row) {
  return { ...publicUser(row), disabled: Number(row.disabled) === 1 };
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requestQuery(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
}

/** Non-negative integer query parameter, or the fallback when absent. */
function intQueryParam(query, name, { fallback, min, max }) {
  const raw = query.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'bad_request', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function checkStoreParam(storeName) {
  if (!STORES.includes(storeName)) {
    throw new HttpError(400, 'bad_request', `Unknown store "${storeName}"; expected one of ${STORES.join(', ')}`);
  }
  return storeName;
}

function changesHandler(req, res, ctx) {
  const query = requestQuery(req);
  const since = intQueryParam(query, 'since', { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  const limit = intQueryParam(query, 'limit', { fallback: 500, min: 1, max: 1000 });
  const feed = ctx.store.changesFeed(since, limit);
  // Stores the user cannot Read are hidden entirely; contractors.hourlyRate
  // needs contractorRates Read (SPEC-v3.md 13.2).
  const showRates = can(ctx.user, 'contractorRates', 'read');
  feed.records = feed.records
    .filter((record) => can(ctx.user, storeArea(record.store), 'read'))
    .map((record) => sanitizeRecordForRole(record, showRates));
  sendJson(req, res, 200, feed);
}

async function putRecordHandler(req, res, ctx, params) {
  checkStoreParam(params.store);
  requireArea(ctx, storeArea(params.store), 'write');
  const body = await readJsonBody(req);
  const result = putRecord(ctx.store, {
    storeName: params.store,
    id: params.id,
    body,
    user: ctx.user,
  });
  sendJson(req, res, 200, {
    ...result,
    record: sanitizeRecordForRole(result.record, can(ctx.user, 'contractorRates', 'read')),
  });
}

async function deleteRecordHandler(req, res, ctx, params) {
  checkStoreParam(params.store);
  requireArea(ctx, storeArea(params.store), 'write');
  const query = requestQuery(req);
  const baseVersionRaw = query.get('baseVersion');
  let baseVersion = null;
  if (baseVersionRaw !== null && baseVersionRaw !== '') {
    baseVersion = Number(baseVersionRaw);
    if (!Number.isInteger(baseVersion) || baseVersion < 1) {
      throw new HttpError(400, 'bad_request', 'baseVersion must be a positive integer');
    }
  }
  const result = deleteRecord(ctx.store, {
    storeName: params.store,
    id: params.id,
    baseVersion,
    user: ctx.user,
  });
  sendJson(req, res, 200, {
    ...result,
    record: sanitizeRecordForRole(result.record, can(ctx.user, 'contractorRates', 'read')),
  });
}

function historyHandler(req, res, ctx, params) {
  checkStoreParam(params.store);
  requireArea(ctx, storeArea(params.store), 'read');
  if (ctx.store.getRecord(params.store, params.id) === null) {
    throw new HttpError(404, 'not_found', 'No such record');
  }
  const showRates = can(ctx.user, 'contractorRates', 'read');
  sendJson(
    req,
    res,
    200,
    ctx.store
      .historyList(params.store, params.id)
      .map((entry) => sanitizeHistoryForRole(entry, showRates))
  );
}

/**
 * Stock moves need `parts` Write; job deductions (job-done/job-reopened with
 * the order's id) also pass with `serviceOrders` Write, because they are
 * sent when that user's Service Order save is applied (SPEC-v3.md 13.1).
 */
function isJobDeduction(move) {
  return (
    isJsonObject(move) &&
    (move.reason === 'job-done' || move.reason === 'job-reopened') &&
    typeof move.workOrderId === 'string' &&
    move.workOrderId !== ''
  );
}

function checkStockMovesAccess(user, moves) {
  if (can(user, 'parts', 'write')) return;
  if (Array.isArray(moves) && moves.length > 0 && moves.every(isJobDeduction)) {
    if (can(user, 'serviceOrders', 'write')) return;
    throw forbiddenError('serviceOrders', 'write');
  }
  throw forbiddenError('parts', 'write');
}

async function stockMovesHandler(req, res, ctx) {
  const body = await readJsonBody(req);
  if (!isJsonObject(body)) {
    throw new HttpError(400, 'bad_request', 'Expected a JSON object body');
  }
  checkStockMovesAccess(ctx.user, body.moves);
  const result = applyStockMoves(ctx.store, { moves: body.moves, user: ctx.user });
  sendJson(req, res, 200, result);
}

async function importV1Handler(req, res, ctx) {
  requireArea(ctx, 'admin', 'write');
  const body = await readJsonBody(req);
  const counts = importV1(ctx.store, body, ctx.user);
  sendJson(req, res, 200, counts);
}

// ---------------------------------------------------------------------------
// Files and branding (SPEC-v3.md sections 6 and 8)
// ---------------------------------------------------------------------------

async function uploadFileHandler(req, res, ctx) {
  requireArea(ctx, 'files', 'write');
  const file = await createUploadedFile(ctx.store, ctx.store.dataDir, req, {
    uploadedBy: ctx.user.id,
  });
  // v4 (SPEC-v4.md section 4.2): manual PDFs get their text extracted in the
  // background; the upload response never waits for it.
  if (file.mime === 'application/pdf') {
    scheduleFileTextExtraction(ctx.store, file.fileId);
  }
  sendJson(req, res, 201, file);
}

function getFileHandler(req, res, ctx, params) {
  requireArea(ctx, 'files', 'read');
  const row = findFileById(ctx.store, params.id);
  if (row === null) {
    notFound(req, res);
    return;
  }
  streamStoredFile(req, res, row, ctx.store.dataDir);
}

/**
 * GET /api/files/:id/text-status (SPEC-v4.md section 4.2): the extraction
 * state of one uploaded PDF — `{status, chars, pages}` once extracted, or
 * `{status: 'pending'}` while the background queue has not reached it.
 */
function fileTextStatusHandler(req, res, ctx, params) {
  requireArea(ctx, 'files', 'read');
  const row = findFileById(ctx.store, params.id);
  if (row === null) {
    notFound(req, res);
    return;
  }
  if (row.mime !== 'application/pdf') {
    throw new HttpError(404, 'not_found', 'No extracted text for this file');
  }
  const text = ctx.store.getFileText(row.id);
  if (text === null || text.status === 'pending') {
    sendJson(req, res, 200, { status: 'pending' });
    return;
  }
  let pages = 0;
  try {
    const parsed = JSON.parse(text.pages_json);
    if (Array.isArray(parsed)) pages = parsed.length;
  } catch {
    pages = 0;
  }
  sendJson(req, res, 200, {
    status: text.status,
    chars: Number(text.chars),
    pages,
  });
}

function getBrandingHandler(req, res, ctx) {
  sendJson(req, res, 200, brandingPayload(ctx.store, SERVER_VERSION));
}

async function putBrandingHandler(req, res, ctx) {
  requireArea(ctx, 'settings', 'write');
  const body = await readJsonBody(req);
  if (!isJsonObject(body)) {
    throw new HttpError(400, 'bad_request', 'Expected a JSON object body');
  }
  for (const key of Object.keys(body)) {
    if (key !== 'name') {
      throw new HttpError(400, 'bad_request', 'Only "name" can be set with PUT /api/branding');
    }
  }
  sendJson(req, res, 200, setBrandingName(ctx.store, body.name, SERVER_VERSION));
}

async function postBrandingLogoHandler(req, res, ctx) {
  requireArea(ctx, 'settings', 'write');
  const payload = await setBrandingLogo(ctx.store, ctx.store.dataDir, req, {
    version: SERVER_VERSION,
    uploadedBy: ctx.user.id,
  });
  sendJson(req, res, 200, payload);
}

function getBrandingLogoHandler(req, res, ctx) {
  const row = getBrandingLogoFile(ctx.store);
  if (row === null) {
    notFound(req, res);
    return;
  }
  streamStoredFile(req, res, row, ctx.store.dataDir);
}

function deleteBrandingLogoHandler(req, res, ctx) {
  requireArea(ctx, 'settings', 'write');
  sendJson(req, res, 200, clearBrandingLogo(ctx.store, ctx.store.dataDir, SERVER_VERSION));
}

// ---------------------------------------------------------------------------
// AI assistant (SPEC-v3.md section 9). Handlers live in server/ai.js and
// return {status, body, headers} or throw ApiError; this wrapper sends them.
// ---------------------------------------------------------------------------

function aiRoute(handler, area, level) {
  if (!area || !level) throw new Error('aiRoute needs a permission area and level');
  return async function aiHandler(req, res, ctx) {
    requireArea(ctx, area, level);
    const body = req.method === 'POST' || req.method === 'PUT' ? await readJsonBody(req) : undefined;
    const out = await handler(ctx, req, body);
    sendJson(req, res, out.status ?? 200, out.body ?? {}, out.headers ?? {});
  };
}

async function createBackupHandler(req, res, ctx) {
  requireArea(ctx, 'backups', 'write');
  let meta;
  try {
    meta = await createBackup({
      db: ctx.store.db,
      dataDir: ctx.store.dataDir,
      createdBy: { id: ctx.user.id, username: ctx.user.username },
      kind: 'manual',
      keep: ctx.config.backupKeep,
    });
  } catch (err) {
    if (err instanceof BackupRateLimitError) {
      sendJson(req, res, err.status, errorResponse(err.code, err.message), {
        'Retry-After': String(err.retryAfterSeconds),
      });
      return;
    }
    throw err;
  }
  sendJson(req, res, 200, meta);
}

function listBackupsHandler(req, res, ctx) {
  requireArea(ctx, 'backups', 'read');
  sendJson(req, res, 200, listBackups(ctx.store.db));
}

/** Stream a recorded backup file as an attachment (SPEC-v2.md section 7). */
function streamBackupFile(req, res, filePath, filename) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    stat = null;
  }
  if (stat === null || !stat.isFile()) {
    notFound(req, res);
    return;
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': String(stat.size),
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const source = fs.createReadStream(filePath);
  source.on('error', (err) => res.destroy(err));
  source.pipe(res);
}

function downloadBackupHandler(req, res, ctx, params) {
  requireArea(ctx, 'backups', 'write');
  if (!isValidBackupName(ctx.store.db, params.file)) {
    notFound(req, res);
    return;
  }
  streamBackupFile(req, res, path.join(ctx.store.dataDir, 'backups', params.file), params.file);
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
  // Same shape as GET /api/me, so the client knows the role's permissions right after signing in.
  sendJson(req, res, 200, { ...publicUser(user), permissions: permissionsOf(ctx.store, user.role_id ?? user.roleId) }, {
    'Set-Cookie': sessionCookie(session.token, ctx.sessionDays, ctx.scheme === 'https'),
  });
}

function logoutHandler(req, res, ctx) {
  const token = findSessionToken(req);
  if (token !== null) deleteSessionByToken(ctx.store, token);
  sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(ctx.scheme === 'https') });
}

function meHandler(req, res, ctx) {
  // 13.2: adds roleId, roleName, permissions (read fresh from the database).
  sendJson(req, res, 200, {
    ...publicUser(ctx.user),
    permissions: permissionsOf(ctx.store, ctx.user.roleId),
  });
}

  // --- Agent API tokens (admin only). Tokens never manage tokens. -----------

  function listTokensHandler(req, res, ctx) {
    requireArea(ctx, 'admin', 'read');
    sendJson(req, res, 200, ctx.store.listApiTokens());
  }

  async function createTokenHandler(req, res, ctx) {
    requireArea(ctx, 'admin', 'write');
    const body = await readJsonBody(req);
    const parsed = validTokenRequest(body);
    if (!parsed.ok) throw new HttpError(400, 'bad_request', parsed.message);
    const agent = ensureAgentUser(
      ctx.store,
      parsed.value.username === undefined ? {} : { username: parsed.value.username }
    );
    if (agent.disabled !== 1 && agent.disabled !== true) {
      throw new HttpError(
        409,
        'conflict',
        `User "${agent.username}" can sign in; pass a dedicated agent username instead`
      );
    }
    const { token, record } = ctx.store.createApiToken({
      name: parsed.value.name,
      scope: parsed.value.scope,
      userId: agent.id,
      createdBy: ctx.user.id,
    });
    // The raw token is part of this response only; it is never stored.
    sendJson(req, res, 201, {
      ...record,
      username: agent.username,
      displayName: agent.display_name ?? agent.displayName ?? null,
      token,
    });
  }

  function revokeTokenHandler(req, res, ctx, params) {
    requireArea(ctx, 'admin', 'write');
    const row = ctx.store.revokeApiToken(params.id);
    if (row === null) throw new HttpError(404, 'not_found', `No API token with id "${params.id}"`);
    sendJson(req, res, 200, row);
  }

  function listUsersHandler(req, res, ctx) {
  sendJson(req, res, 200, ctx.store.listUsers().map(publicUserWithDisabled));
}

// Role names: 1-40 characters, unique (case-insensitive); the Administrator
// role is immutable (SPEC-v3.md 13.1).
function checkRoleName(value) {
  if (typeof value !== 'string') return { ok: false, message: 'name must be a string' };
  const name = value.trim();
  if (name.length < 1 || name.length > 40) {
    return { ok: false, message: 'name must be between 1 and 40 characters' };
  }
  return { ok: true, value: name };
}

const LAST_ADMIN_MESSAGE =
  'This is the last enabled user with "write" access to Users & roles; it cannot be disabled or demoted';

/** Resolve the role a create/update refers to (roleId, or the legacy split). */
function resolveTargetRole(store, { roleId, role }) {
  if (roleId !== undefined) {
    if (typeof roleId !== 'string' || roleId === '') {
      throw new HttpError(400, 'bad_request', 'roleId must be a string');
    }
    const row = store.getRoleById(roleId);
    if (row === null) throw new HttpError(400, 'bad_request', `No role with id "${roleId}"`);
    return row;
  }
  const legacy = checkRole(role);
  if (!legacy.ok) throw new HttpError(400, 'bad_request', legacy.message);
  const name = legacy.value === 'admin' ? 'Administrator' : 'Technician';
  const row = store.getRoleByName(name);
  if (row === null) {
    throw new HttpError(400, 'bad_request', `The built-in role "${name}" is missing`);
  }
  return row;
}

async function createUserHandler(req, res, ctx) {
  requireArea(ctx, 'admin', 'write');
  const body = await readJsonBody(req);
  if (!isJsonObject(body)) {
    throw new HttpError(400, 'bad_request', 'Expected a JSON object body');
  }
  for (const key of Object.keys(body)) {
    if (!['username', 'displayName', 'role', 'roleId', 'password'].includes(key)) {
      throw new HttpError(400, 'bad_request', `Unknown body field "${key}"`);
    }
  }
  if (body.roleId !== undefined && body.role !== undefined) {
    throw new HttpError(400, 'bad_request', 'Provide either roleId or role, not both');
  }
  if (body.roleId === undefined && body.role === undefined) {
    throw new HttpError(400, 'bad_request', 'roleId (or the legacy role) is required');
  }
  const checks = [
    checkUsername(body.username),
    checkDisplayName(body.displayName),
    checkPassword(body.password),
  ];
  const failed = checks.find((check) => !check.ok);
  if (failed) {
    throw new HttpError(400, 'bad_request', failed.message);
  }
  const [username, displayName, password] = checks.map((check) => check.value);
  const roleRow = resolveTargetRole(ctx.store, { roleId: body.roleId, role: body.role });
  if (ctx.store.getUserByUsername(username) !== null) {
    throw new HttpError(409, 'username_taken', `Username "${username}" is already in use`);
  }
  const user = ctx.store.createUser({
    username,
    displayName,
    roleId: roleRow.id,
    passwordHash: hashPassword(password),
  });
  sendJson(req, res, 201, publicUserWithDisabled(user));
}

async function patchUserHandler(req, res, ctx, params) {
  requireArea(ctx, 'admin', 'write');
  const body = await readJsonBody(req);
  if (!isJsonObject(body)) {
    throw new HttpError(400, 'bad_request', 'Expected a JSON object body');
  }
  for (const key of Object.keys(body)) {
    if (!['displayName', 'role', 'roleId', 'disabled', 'password', 'username'].includes(key)) {
      throw new HttpError(400, 'bad_request', `Unknown body field "${key}"`);
    }
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
  if (body.roleId !== undefined && body.role !== undefined) {
    throw new HttpError(400, 'bad_request', 'Provide either roleId or role, not both');
  }
  const fields = {};
  if (body.displayName !== undefined) {
    const displayName = checkDisplayName(body.displayName);
    if (!displayName.ok) throw new HttpError(400, 'bad_request', displayName.message);
    fields.displayName = displayName.value;
  }
  if (body.roleId !== undefined || body.role !== undefined) {
    const roleRow = resolveTargetRole(ctx.store, { roleId: body.roleId, role: body.role });
    if (roleRow.id !== existing.role_id) fields.roleId = roleRow.id;
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
    throw new HttpError(400, 'bad_request', 'Provide at least one of displayName, roleId, disabled, password');
  }
  // 13.2 safety: the last enabled user with admin Write cannot be disabled
  // or demoted (409).
  const disabling = fields.disabled === 1;
  const roleChanged = fields.roleId !== undefined;
  if (disabling || roleChanged) {
    const isLastAdmin =
      Number(existing.disabled) !== 1 &&
      hasAdminWrite(permissionsOf(ctx.store, existing.role_id)) &&
      enabledUsersWithAdminWrite(ctx.store).every((row) => row.id === existing.id);
    const keepsAdmin =
      roleChanged && !disabling && hasAdminWrite(permissionsOf(ctx.store, fields.roleId));
    if (isLastAdmin && !keepsAdmin) {
      throw new HttpError(409, 'last_admin', LAST_ADMIN_MESSAGE);
    }
  }
  const user = ctx.store.updateUser(existing.id, fields);
  if (fields.disabled === 1) ctx.store.deleteUserSessions(existing.id);
  sendJson(req, res, 200, publicUserWithDisabled(user));
}

// ---------------------------------------------------------------------------
// Roles (SPEC-v3.md sections 13.1, 13.2)
// ---------------------------------------------------------------------------

function publicRole(row) {
  return {
    id: row.id,
    name: row.name,
    builtin: Number(row.builtin) === 1,
    permissions: JSON.parse(row.permissions),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by === undefined || row.updated_by === null ? null : row.updated_by,
  };
}

function getRoleOr404(ctx, id) {
  const role = ctx.store.getRoleById(id);
  if (role === null) throw new HttpError(404, 'not_found', 'No such role');
  return role;
}

function listRolesHandler(req, res, ctx) {
  requireArea(ctx, 'admin', 'write');
  sendJson(req, res, 200, ctx.store.listRoles().map(publicRole));
}

async function createRoleHandler(req, res, ctx) {
  requireArea(ctx, 'admin', 'write');
  const body = await readJsonBody(req);
  if (!isJsonObject(body)) {
    throw new HttpError(400, 'bad_request', 'Expected a JSON object body');
  }
  for (const key of Object.keys(body)) {
    if (!['name', 'permissions', 'copyOf'].includes(key)) {
      throw new HttpError(400, 'bad_request', `Unknown body field "${key}"`);
    }
  }
  const name = checkRoleName(body.name);
  if (!name.ok) throw new HttpError(400, 'bad_request', name.message);
  if (ctx.store.getRoleByName(name.value) !== null) {
    throw new HttpError(409, 'name_taken', `A role named "${name.value}" already exists`);
  }
  let permissions;
  if (body.copyOf !== undefined) {
    if (body.permissions !== undefined) {
      throw new HttpError(400, 'bad_request', 'Provide either permissions or copyOf, not both');
    }
    const source = getRoleOr404(ctx, body.copyOf);
    permissions = permissionsOf(ctx.store, source.id);
  } else {
    permissions = normalizeRolePermissionsInput(body.permissions);
  }
  const role = ctx.store.createRole({ name: name.value, permissions, updatedBy: ctx.user.id });
  sendJson(req, res, 201, publicRole(role));
}

function normalizeRolePermissionsInput(raw) {
  try {
    return normalizePermissions(raw);
  } catch (err) {
    throw new HttpError(400, 'bad_request', err.message);
  }
}

async function patchRoleHandler(req, res, ctx, params) {
  requireArea(ctx, 'admin', 'write');
  const body = await readJsonBody(req);
  if (!isJsonObject(body)) {
    throw new HttpError(400, 'bad_request', 'Expected a JSON object body');
  }
  for (const key of Object.keys(body)) {
    if (!['name', 'permissions'].includes(key)) {
      throw new HttpError(400, 'bad_request', `Unknown body field "${key}"`);
    }
  }
  const role = getRoleOr404(ctx, params.id);
  if (Number(role.builtin) === 1 && role.name === 'Administrator') {
    throw new HttpError(409, 'role_immutable', 'The Administrator role cannot be changed');
  }
  const fields = {};
  if (body.name !== undefined) {
    const name = checkRoleName(body.name);
    if (!name.ok) throw new HttpError(400, 'bad_request', name.message);
    const clash = ctx.store.getRoleByName(name.value);
    if (clash !== null && clash.id !== role.id) {
      throw new HttpError(409, 'name_taken', `A role named "${name.value}" already exists`);
    }
    fields.name = name.value;
  }
  if (body.permissions !== undefined) {
    fields.permissions = normalizeRolePermissionsInput(body.permissions);
  }
  if (fields.name === undefined && fields.permissions === undefined) {
    throw new HttpError(400, 'bad_request', 'Provide at least one of name, permissions');
  }
  // 13.2 safety: nobody can remove admin Write from their own role, and the
  // roles of the last enabled admins cannot lose it either (409).
  if (fields.permissions !== undefined) {
    const oldPerms = permissionsOf(ctx.store, role.id);
    if (hasAdminWrite(oldPerms) && !hasAdminWrite(fields.permissions)) {
      if (role.id === ctx.user.roleId) {
        throw new HttpError(
          409,
          'last_admin',
          'You cannot remove "write" access to Users & roles from your own role'
        );
      }
      const remaining = enabledUsersWithAdminWrite(ctx.store).filter((row) => row.role_id !== role.id);
      if (remaining.length === 0) {
        throw new HttpError(
          409,
          'last_admin',
          `Role "${role.name}" is assigned to the last enabled users with "write" access to Users & roles`
        );
      }
    }
  }
  const updated = ctx.store.updateRole(role.id, { ...fields, updatedBy: ctx.user.id });
  sendJson(req, res, 200, publicRole(updated));
}

async function deleteRoleHandler(req, res, ctx, params) {
  requireArea(ctx, 'admin', 'write');
  const role = getRoleOr404(ctx, params.id);
  if (Number(role.builtin) === 1 && role.name === 'Administrator') {
    throw new HttpError(409, 'role_immutable', 'The Administrator role cannot be deleted');
  }
  const users = ctx.store.roleUsersCount(role.id);
  if (users > 0) {
    throw new HttpError(
      409,
      'role_in_use',
      `Role "${role.name}" is assigned to ${users} user${users === 1 ? '' : 's'} and cannot be deleted`
    );
  }
  ctx.store.deleteRole(role.id, { updatedBy: ctx.user.id });
  sendJson(req, res, 200, { ok: true });
}

async function roleHistoryHandler(req, res, ctx, params) {
  requireArea(ctx, 'admin', 'write');
  const role = getRoleOr404(ctx, params.id);
  sendJson(req, res, 200, ctx.store.roleHistory(role.id));
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

// Access is decided inside each handler by can()/requireArea() (SPEC-v3.md
// 13.2): users, roles and import management need `admin` Write; records,
// stock moves, files, backups and branding need their area's level.
const ROUTES = [
  compileRoute('GET', '/api/health', { auth: false }, healthHandler),
  compileRoute('POST', '/api/login', { auth: false }, loginHandler),
  compileRoute('POST', '/api/logout', { auth: true }, logoutHandler),
    compileRoute('GET', '/api/me', { auth: true }, meHandler),
    // Agent tokens: created and revoked by admins from a signed-in session.
    compileRoute('GET', '/api/tokens', { auth: true }, listTokensHandler),
    compileRoute('POST', '/api/tokens', { auth: true }, createTokenHandler),
    compileRoute('DELETE', '/api/tokens/:id', { auth: true }, revokeTokenHandler),
  // Any signed-in user may list users (SPEC-v2.md section 7: "edited by"
  // names); managing them (create/patch) needs `admin` Write in the handler.
  compileRoute('GET', '/api/users', { auth: true }, listUsersHandler),
  compileRoute('POST', '/api/users', { auth: true }, createUserHandler),
  compileRoute('PATCH', '/api/users/:id', { auth: true }, patchUserHandler),
  compileRoute('GET', '/api/roles', { auth: true }, listRolesHandler),
  compileRoute('POST', '/api/roles', { auth: true }, createRoleHandler),
  compileRoute('PATCH', '/api/roles/:id', { auth: true }, patchRoleHandler),
  compileRoute('DELETE', '/api/roles/:id', { auth: true }, deleteRoleHandler),
  compileRoute('GET', '/api/roles/:id/history', { auth: true }, roleHistoryHandler),
  compileRoute('GET', '/api/changes', { auth: true }, changesHandler),
  compileRoute('PUT', '/api/records/:store/:id', { auth: true }, putRecordHandler),
  compileRoute('DELETE', '/api/records/:store/:id', { auth: true }, deleteRecordHandler),
  compileRoute('GET', '/api/history/:store/:id', { auth: true }, historyHandler),
  compileRoute('POST', '/api/stock-moves', { auth: true }, stockMovesHandler),
  compileRoute('POST', '/api/backups', { auth: true }, createBackupHandler),
  compileRoute('GET', '/api/backups', { auth: true }, listBackupsHandler),
  compileRoute('GET', '/api/backups/:file', { auth: true }, downloadBackupHandler),
  compileRoute('POST', '/api/import-v1', { auth: true }, importV1Handler),
  compileRoute('POST', '/api/files', { auth: true }, uploadFileHandler),
  compileRoute('GET', '/api/files/:id', { auth: true }, getFileHandler),
  compileRoute('GET', '/api/files/:id/text-status', { auth: true }, fileTextStatusHandler),
  compileRoute('GET', '/api/branding', { auth: false }, getBrandingHandler),
  compileRoute('PUT', '/api/branding', { auth: true }, putBrandingHandler),
  compileRoute('POST', '/api/branding/logo', { auth: true }, postBrandingLogoHandler),
  compileRoute('GET', '/api/branding/logo', { auth: false }, getBrandingLogoHandler),
  compileRoute('DELETE', '/api/branding/logo', { auth: true }, deleteBrandingLogoHandler),
  // AI routes (v3 section 9) gated by the roles model (v3 section 13): settings write for
  // provider config, aiAssistant read to use the chat.
  compileRoute('GET', '/api/ai/config', { auth: true }, aiRoute(aiGetConfig, 'settings', 'write')),
  compileRoute('PUT', '/api/ai/config', { auth: true }, aiRoute(aiPutConfig, 'settings', 'write')),
  compileRoute('POST', '/api/ai/test', { auth: true }, aiRoute(aiPostTest, 'settings', 'write')),
  compileRoute('GET', '/api/ai/status', { auth: true }, aiRoute(aiGetStatus, 'aiAssistant', 'read')),
  compileRoute('POST', '/api/ai/chat', { auth: true }, aiRoute(aiPostChat, 'aiAssistant', 'read')),
  compileRoute('POST', '/api/ai/apply', { auth: true }, aiRoute(aiApplyProposal, 'aiAssistant', 'read')),
  compileRoute('GET', '/api/ai/history', { auth: true }, aiRoute(aiGetHistory, 'aiAssistant', 'read')),
  compileRoute('DELETE', '/api/ai/history', { auth: true }, aiRoute(aiDeleteHistory, 'aiAssistant', 'read')),
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

/**
 * `Authorization: Bearer mlt_…`. Returns null when the header is absent,
 * {invalid:true} when it is malformed, or {token} with the raw value.
 */
function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header.trim() === '') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (match === null) return { invalid: true };
  return { token: match[1] };
}

const BEARER_CHALLENGE = { 'WWW-Authenticate': 'Bearer realm="shopfloor-cmms"' };

async function handleApi(req, res, decodedPath, ctx) {
  const effectiveMethod = req.method === 'HEAD' ? 'GET' : req.method;
  const matched = matchRoute(effectiveMethod, decodedPath);
  if (matched === null) {
    sendJson(req, res, 404, errorResponse('not_found', `No such API route: ${req.method} ${decodedPath}`));
    return;
  }
  const { route, params } = matched;
  const context = { ...ctx, user: null, auth: null };
  // Bearer tokens authenticate machines/agents; cookies authenticate humans.
  const bearer = bearerToken(req);
  let tokenAuth = null;
  if (bearer !== null) {
    const row =
      bearer.invalid === true ? null : context.store.findApiTokenByHash(hashApiToken(bearer.token));
    if (row === null) {
      sendJson(req, res, 401, errorResponse('invalid_token', 'API token is missing, revoked or invalid'), BEARER_CHALLENGE);
      return;
    }
    const user = context.store.getUserById(row.user_id);
    if (user === null) {
      sendJson(req, res, 401, errorResponse('invalid_token', 'The token owner no longer exists'), BEARER_CHALLENGE);
      return;
    }
    context.store.touchApiToken(row.id);
    tokenAuth = { kind: 'token', id: row.id, name: row.name, scope: row.scope };
    context.auth = tokenAuth;
    context.user = { ...user, roleId: user.role_id ?? user.roleId ?? null, store: context.store };
  } else if (route.auth) {
    const user = requireUser(req, context);
    if (user === null) {
      sendJson(req, res, 401, errorResponse('login_required', 'Sign in to use the API'));
      return;
    }
    // The session user carries the store handle so can() can re-read the
    // role's permissions from the database on every request (13.2).
    context.user = { ...user, store: context.store };
    context.auth = { kind: 'session' };
  }
  // A token may only reach records/history/identity, and a read token may
  // only GET; everything else (users, roles, tokens, backups, AI, settings)
  // stays human-only.
  if (tokenAuth !== null && tokenPathAllowed(effectiveMethod, decodedPath, tokenAuth.scope) !== true) {
    sendJson(
      req,
      res,
      403,
      errorResponse('forbidden', 'This API token may only read shop records, or edit them with write scope')
    );
    return;
  }
  // CSRF applies to cookie sessions only; a Bearer token is not ambient.
  if (effectiveMethod !== 'GET' && tokenAuth === null) {
    const csrfError = checkCsrf(req);
    if (csrfError !== null) {
      sendJson(req, res, 403, errorResponse('forbidden', csrfError));
      return;
    }
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
        // Agent-facing public probes: no session, no token (GET only).
        if (decodedPath === '/health' || decodedPath === '/openapi.json') {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            send(req, res, 405, {
              'Content-Type': 'application/json; charset=utf-8',
              Allow: 'GET, HEAD',
            }, JSON.stringify(errorResponse('method_not_allowed', 'This path only allows GET and HEAD')));
            return;
          }
          if (decodedPath === '/health') {
            sendJson(req, res, 200, { ok: true, version: SERVER_VERSION });
          } else {
            sendJson(req, res, 200, openApiSpec(SERVER_VERSION));
          }
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
        if (err instanceof HttpError || err instanceof ApiError) {
          sendJson(req, res, err.status, errorResponse(err.code, err.message, err.extra));
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
  const backupSchedule = startBackupSchedule({
    db: store.db,
    dataDir: store.dataDir,
    at: config.backupDailyAt,
    keep: config.backupKeep,
  });
  // v4 (SPEC-v4.md section 4.2): extract text for PDFs that have no
  // file_texts row yet, one at a time in the background.
  const textExtractionQueue = startTextExtractionQueue(store);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    textExtractionQueue.stop();
    backupSchedule.stop();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    store.close();
  };

  return { server, port, host: config.host, config, store, scheme, url: `${scheme}://127.0.0.1:${port}`, close };
}

const isMain = isMainModule(import.meta.url);

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