'use strict';

/**
 * Agent API tokens (Muse): the machine-to-machine half of the auth model.
 *
 * A token belongs to a disabled bot user so every record edit is attributed
 * ("Muse Agent") in the history log, and the token's own scope (read|write)
 * is enforced on top of the role permissions of that user. Sessions keep
 * using cookies + CSRF; tokens are Bearer-only and never get a cookie.
 */

import crypto from 'node:crypto';

import { hashPassword } from './auth.js';
import { addMissingRolePermissions, normalizePermissions } from './permissions.js';

export const AGENT_USERNAME = 'muse-agent';
export const AGENT_DISPLAY_NAME = 'Muse Agent';
export const TOKEN_SCOPES = ['read', 'write'];
export const TOKEN_NAME_MAX = 80;

/** What an agent may do in the shop: edit the three working stores. */
function agentPermissions() {
  return normalizePermissions({
    serviceOrders: 'write',
    pm: 'write',
    machines: 'write',
    parts: 'read',
    coworkers: 'read',
    contractors: 'read',
    statistics: 'read',
    files: 'read',
    // v4 (SPEC-v4.md section 1): Muse reads requests from /api/changes and
    // writes purchaseRequests.
    purchasing: 'write',
    library: 'read',
  });
}

/**
 * Upgrade a stored role row with the permission keys it is missing
 * (SPEC-v4.md section 1): keys the row already has are never changed, so an
 * admin's edit survives the idempotent ensure. Returns the role row used.
 */
function ensureRoleUpgraded(store, roleId) {
  return addMissingRolePermissions(store, roleId, agentPermissions());
}

/** Raw users row (snake_case) -> the {id, roleId} shape can() reads. */
function asSessionUser(row) {
  return { ...row, roleId: row.role_id ?? row.roleId ?? null };
}

/**
 * Find or create the disabled bot account a token acts as. Idempotent, so
 * every token can point at one stable "Muse Agent" identity.
 */
export function ensureAgentUser(store, options = {}) {
  const username = options.username ?? AGENT_USERNAME;
  const displayName = options.displayName ?? AGENT_DISPLAY_NAME;
  const existing = store.getUserByUsername(username);
  if (existing !== null) {
    // The live DB already carries the role: add keys it is missing (v4),
    // never lower keys an admin changed.
    ensureRoleUpgraded(store, existing.role_id ?? existing.roleId ?? null);
    return asSessionUser(existing);
  }
  let role = store.getRoleByName(displayName);
  if (role === null) {
    role = store.createRole({ name: displayName, permissions: agentPermissions() });
  } else {
    role = ensureRoleUpgraded(store, role.id) ?? role;
  }
  const created = store.createUser({
    username,
    displayName,
    roleId: role.id,
    passwordHash: hashPassword(crypto.randomBytes(32).toString('hex')),
  });
  store.updateUser(created.id, { disabled: 1 });
  return asSessionUser(store.getUserById(created.id));
}

/**
 * Path allow-list for tokens. Deliberately narrow: the record feed, history,
 * identity. Users, roles, tokens, backups, settings, files and the AI
 * endpoints are for signed-in humans only.
 */
const RECORD_WRITE_PATH = /^\/api\/records\/[^/]+\/[^/]+$/;
const HISTORY_PATH = /^\/api\/history\/[^/]+\/[^/]+$/;

export function tokenPathAllowed(method, path, scope) {
  if (method === 'GET') {
    return path === '/api/health' || path === '/api/me' || path === '/api/changes' || HISTORY_PATH.test(path);
  }
  // Record create/update/delete is PUT/DELETE /api/records/:store/:id.
  return scope === 'write' && RECORD_WRITE_PATH.test(path) && (method === 'PUT' || method === 'DELETE');
}

/** Validate the body of POST /api/tokens; returns {name, scope, username}. */
export function validTokenRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Expected a JSON object body' };
  }
  for (const key of Object.keys(body)) {
    if (!['name', 'scope', 'username'].includes(key)) {
      return { ok: false, message: `Unknown body field "${key}"` };
    }
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > TOKEN_NAME_MAX) {
    return { ok: false, message: `name must be between 1 and ${TOKEN_NAME_MAX} characters` };
  }
  const scope = body.scope ?? 'read';
  if (!TOKEN_SCOPES.includes(scope)) {
    return { ok: false, message: 'scope must be "read" or "write"' };
  }
  if (body.username !== undefined) {
    if (typeof body.username !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(body.username)) {
      return { ok: false, message: 'username must be 2-32 lowercase letters, digits, dot, dash or underscore' };
    }
  }
  return { ok: true, value: { name, scope, username: body.username } };
}
