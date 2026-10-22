'use strict';

import crypto from 'node:crypto';

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_LENGTH = 64;
export const SCRYPT_SALT_LENGTH = 16;
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 128;
export const SESSION_TOKEN_BYTES = 32;
export const SESSION_SLIDE_INTERVAL_MS = 60 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const CSRF_HEADER_VALUE = 'maint-log';
const SESSION_DAY_MS = 24 * 60 * 60 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT_SALT_LENGTH);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

const DUMMY_HASH = hashPassword('maint-log-dummy-password');

export function verifyPassword(stored, password) {
  if (typeof stored !== 'string' || typeof password !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 0 || r <= 0 || p <= 0) {
    return false;
  }
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length !== SCRYPT_SALT_LENGTH || expected.length !== SCRYPT_KEY_LENGTH) return false;
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH, { N, r, p });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function burnPasswordCheck(password) {
  verifyPassword(DUMMY_HASH, String(password));
}

export function createSessionToken() {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(store, userId, sessionDays) {
  const token = createSessionToken();
  const tokenHash = hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionDays * SESSION_DAY_MS);
  store.createSession({
    tokenHash,
    userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    lastSeenAt: now.toISOString(),
  });
  return { token, tokenHash, expiresAt: expiresAt.toISOString() };
}

export function validateSession(store, token, sessionDays) {
  if (typeof token !== 'string' || token === '') return null;
  const tokenHash = hashToken(token);
  const row = store.getSessionWithUser(tokenHash);
  if (row === null) return null;
  const now = Date.now();
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    store.deleteSessionByTokenHash(tokenHash);
    return null;
  }
  if (Number(row.disabled) === 1) {
    store.deleteUserSessions(row.user_id);
    return null;
  }
  const lastSeen = Date.parse(row.last_seen_at || row.session_created_at || '');
  if (now - lastSeen >= SESSION_SLIDE_INTERVAL_MS) {
    store.touchSession(tokenHash, {
      expiresAt: new Date(now + sessionDays * SESSION_DAY_MS).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
    });
  } else {
    store.touchSession(tokenHash, { lastSeenAt: new Date(now).toISOString() });
  }
  return { id: row.user_id, username: row.username, display_name: row.display_name, role: row.role };
}

export function deleteSessionByToken(store, token) {
  if (typeof token !== 'string' || token === '') return false;
  return store.deleteSessionByTokenHash(hashToken(token));
}

export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string' || header === '') return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    cookies[name] = part.slice(eq + 1).trim();
  }
  return cookies;
}

export function findSessionToken(req) {
  return parseCookies(req.headers.cookie).sid || null;
}

export function sessionCookie(token, sessionDays, secure) {
  const maxAge = Math.max(0, Math.floor(sessionDays * 86400));
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure) {
  return `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function checkCsrf(req) {
  if (req.headers['x-requested-with'] !== CSRF_HEADER_VALUE) {
    return 'CSRF check failed: expected the X-Requested-With: maint-log header';
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return 'CSRF check failed: Origin header is not a valid URL';
    }
    if (typeof req.headers.host !== 'string' || req.headers.host === '' || originHost !== req.headers.host) {
      return 'CSRF check failed: Origin does not match the request host';
    }
  }
  return null;
}

export function checkUsername(value) {
  if (typeof value !== 'string') return { ok: false, message: 'username must be a string' };
  const username = value.trim();
  if (username.length < 1 || username.length > 64) {
    return { ok: false, message: 'username must be between 1 and 64 characters' };
  }
  if (!/^[\x21-\x7e]+$/.test(username)) {
    return { ok: false, message: 'username may only use printable characters, without spaces' };
  }
  return { ok: true, value: username };
}

export function checkDisplayName(value) {
  if (typeof value !== 'string') return { ok: false, message: 'displayName must be a string' };
  const displayName = value.trim();
  if (displayName.length < 1 || displayName.length > 100) {
    return { ok: false, message: 'displayName must be between 1 and 100 characters' };
  }
  if (/[\u0000-\u001f\u007f]/.test(displayName)) {
    return { ok: false, message: 'displayName may not contain control characters' };
  }
  return { ok: true, value: displayName };
}

export function checkRole(value) {
  if (value !== 'admin' && value !== 'tech') {
    return { ok: false, message: 'role must be "admin" or "tech"' };
  }
  return { ok: true, value };
}

export function checkPassword(value) {
  if (typeof value !== 'string') return { ok: false, message: 'password must be a string' };
  if (value.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: `password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, message: 'password may not contain control characters' };
  }
  return { ok: true, value };
}

function attemptKeys(username, ip) {
  return [`u:${String(username).toLowerCase()}`, `ip:${ip}`];
}

export function loginRetryAfterSeconds(store, username, ip) {
  const now = Date.now();
  let retryAfterSeconds = 0;
  for (const key of attemptKeys(username, ip)) {
    const row = store.getLoginAttempt(key);
    if (row === null) continue;
    const windowStart = Date.parse(row.window_start);
    if (!Number.isFinite(windowStart) || windowStart + LOGIN_WINDOW_MS <= now) continue;
    if (Number(row.count) >= LOGIN_MAX_FAILURES) {
      const remaining = Math.ceil((windowStart + LOGIN_WINDOW_MS - now) / 1000);
      retryAfterSeconds = Math.max(retryAfterSeconds, remaining);
    }
  }
  return retryAfterSeconds;
}

export function recordLoginFailure(store, username, ip) {
  const now = new Date();
  const iso = now.toISOString();
  for (const key of attemptKeys(username, ip)) {
    const row = store.getLoginAttempt(key);
    const windowStart = Date.parse(row === null ? '' : row.window_start);
    if (row !== null && Number.isFinite(windowStart) && windowStart + LOGIN_WINDOW_MS > now.getTime()) {
      store.setLoginAttempt(key, Number(row.count) + 1, row.window_start);
    } else {
      store.setLoginAttempt(key, 1, iso);
    }
  }
}

export function clearUsernameFailures(store, username) {
  const [usernameKey] = attemptKeys(username, 'unused');
  store.deleteLoginAttempt(usernameKey);
}