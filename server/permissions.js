'use strict';

/**
 * Roles and permissions (SPEC-v3.md section 13).
 *
 * One access level (None / Read / Write) per area; roles are rows in the
 * `roles` table and users point at one with `users.role_id`. `can(user, area,
 * level)` is the only place that decides access: it re-reads the role's
 * permissions from the database on every call, so a change takes effect on
 * the user's next request without signing out. `user` is the session user
 * (or any object) carrying `{ store, roleId }`.
 */

export const LEVELS = ['none', 'read', 'write'];

const LEVEL_RANK = new Map(LEVELS.map((level, index) => [level, index]));

/** Areas with fixed keys and the labels shown in the UI (13.1 table). */
export const AREAS = [
  { key: 'serviceOrders', label: 'Service Orders' },
  { key: 'pm', label: 'Preventive Maintenance' },
  { key: 'machines', label: 'Machines' },
  // v5 (SPEC-v5.md section 1.3): the floor map and its stations.
  { key: 'floorMap', label: 'Floor map & stations' },
  { key: 'parts', label: 'Parts & Stock' },
  // v4 (SPEC-v4.md section 1): parts requests and the repair library.
  { key: 'purchasing', label: 'Parts requests' },
  { key: 'library', label: 'Library (manuals & repair methods)' },
  { key: 'coworkers', label: 'Coworkers' },
  { key: 'contractors', label: 'Outside Contractors' },
  { key: 'contractorRates', label: 'Contractor rates & costs' },
  { key: 'statistics', label: 'Statistics' },
  { key: 'files', label: 'Photos & files' },
  { key: 'backups', label: 'Backups' },
  { key: 'aiAssistant', label: 'AI assistant' },
  { key: 'settings', label: 'Branding & AI settings' },
  { key: 'admin', label: 'Users & roles' },
];

export const AREA_KEYS = AREAS.map((area) => area.key);

const AREA_BY_KEY = new Map(AREAS.map((area) => [area.key, area]));

/** UI label for an area key, or the key itself when unknown. */
export function areaLabel(area) {
  const found = AREA_BY_KEY.get(area);
  return found === undefined ? area : found.label;
}

/** Record store name -> permission area (`workOrders` -> `serviceOrders`). */
const STORE_AREAS = new Map([
  ['workOrders', 'serviceOrders'],
  ['pmTasks', 'pm'],
  ['machines', 'machines'],
  // v5 (SPEC-v5.md section 1.3): both floor stores -> the floorMap area.
  ['floorMaps', 'floorMap'],
  ['floorStations', 'floorMap'],
  ['parts', 'parts'],
  ['purchaseRequests', 'purchasing'],
  ['libraryItems', 'library'],
  ['coworkers', 'coworkers'],
  ['contractors', 'contractors'],
]);

export function storeArea(storeName) {
  const area = STORE_AREAS.get(storeName);
  return area === undefined ? null : area;
}

/** Permissions with every missing area defaulted to `none`. */
function allNone() {
  const permissions = {};
  for (const key of AREA_KEYS) permissions[key] = 'none';
  return permissions;
}

/**
 * Validate and normalize a permissions object (API input): unknown areas or
 * levels are rejected; missing areas become `none`. Throws a plain Error
 * with a clear message (callers map it to 400 bad_request).
 */
export function normalizePermissions(raw) {
  if (raw === undefined || raw === null) return allNone();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('permissions must be an object of {area: level}');
  }
  for (const key of Object.keys(raw)) {
    if (!AREA_BY_KEY.has(key)) {
      throw new Error(`unknown permission area "${key}"; expected one of ${AREA_KEYS.join(', ')}`);
    }
    if (!LEVEL_RANK.has(raw[key])) {
      throw new Error(`permissions.${key} must be one of ${LEVELS.join(', ')}`);
    }
  }
  const permissions = allNone();
  for (const key of Object.keys(raw)) permissions[key] = raw[key];
  return permissions;
}

/**
 * Parse a stored permissions JSON column without ever throwing. Rows written
 * before an area existed (or corrupted JSON) behave as `none` everywhere —
 * except v4 (SPEC-v4.md section 1): a built-in role gets the built-in default
 * for keys its stored JSON lacks; custom roles get `none`. Stored keys (even
 * an explicit `none`) always win, so an admin's edit is never lowered.
 */
function permissiveParse(text, builtinName = undefined) {
  let parsed = null;
  if (typeof text === 'string' && text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  const defaults =
    builtinName === undefined ? undefined : BUILTIN_ROLE_BY_NAME.get(builtinName);
  const permissions = {};
  for (const key of AREA_KEYS) {
    permissions[key] =
      defaults !== undefined && LEVEL_RANK.has(defaults[key]) ? defaults[key] : 'none';
  }
  for (const key of Object.keys(parsed)) {
    if (AREA_BY_KEY.has(key) && LEVEL_RANK.has(parsed[key])) permissions[key] = parsed[key];
  }
  return permissions;
}

/** Built-in role permission sets created on migration (13.1 defaults). */
export const BUILTIN_ROLES = [
  {
    name: 'Administrator',
    permissions: normalizePermissions(
      Object.fromEntries(AREA_KEYS.map((key) => [key, 'write']))
    ),
  },
  {
    name: 'Technician',
    permissions: normalizePermissions({
      serviceOrders: 'write',
      pm: 'write',
      machines: 'write',
      // v5 (SPEC-v5.md section 1.3): technicians place and edit stations.
      floorMap: 'write',
      parts: 'write',
      coworkers: 'write',
      contractors: 'write',
      contractorRates: 'write',
      purchasing: 'write',
      library: 'write',
      files: 'write',
      aiAssistant: 'write',
      statistics: 'read',
      backups: 'read',
    }),
  },
  {
    name: 'Viewer',
    permissions: normalizePermissions({
      serviceOrders: 'read',
      pm: 'read',
      machines: 'read',
      // v5 (SPEC-v5.md section 1.3): viewers see the map, read-only.
      floorMap: 'read',
      parts: 'read',
      purchasing: 'read',
      library: 'read',
      coworkers: 'read',
      contractors: 'read',
      statistics: 'read',
      files: 'read',
    }),
  },
];

/** Default permissions of a built-in role by name (the 13.1/v4 levels). */
export const BUILTIN_ROLE_BY_NAME = new Map(BUILTIN_ROLES.map((role) => [role.name, role]));

/**
 * Effective permissions of a stored role JSON column when keys saved before an
 * area existed must fall back to `defaults` (SPEC-v4.md section 1): keys the
 * row carries keep their stored value — an admin's edit is never lowered —
 * while missing or invalid keys get the default. `changed` says whether that
 * differs from reading the row as-is (missing -> none), so callers rewrite
 * the row only when the defaults actually add something.
 */
export function mergeMissingPermissions(storedText, defaults) {
  let parsed = null;
  if (typeof storedText === 'string' && storedText !== '') {
    try {
      parsed = JSON.parse(storedText);
    } catch {
      parsed = null;
    }
  }
  const raw = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const permissions = allNone();
  for (const key of Object.keys(raw)) {
    if (AREA_BY_KEY.has(key) && LEVEL_RANK.has(raw[key])) permissions[key] = raw[key];
  }
  let changed = false;
  for (const key of AREA_KEYS) {
    if (AREA_BY_KEY.has(key) && LEVEL_RANK.has(raw[key])) continue;
    const fallback = defaults !== null && typeof defaults === 'object' && LEVEL_RANK.has(defaults[key])
      ? defaults[key]
      : 'none';
    if (fallback !== 'none') {
      permissions[key] = fallback;
      changed = true;
    }
  }
  return { permissions, changed };
}

/**
 * Add `defaults` keys a stored role row does not have yet (SPEC-v4.md section
 * 1, the live-DB upgrade for the agent and AI assistant roles): present keys
 * are kept exactly as stored, so an admin's change — even a lower level —
 * survives the idempotent upgrade. Returns the role row (refreshed when an
 * update was written) or null when the role does not exist.
 */
export function addMissingRolePermissions(store, roleId, defaults) {
  if (roleId === null || roleId === undefined) return null;
  const role = store.getRoleById(roleId);
  if (role === null) return null;
  const { permissions, changed } = mergeMissingPermissions(role.permissions, defaults);
  if (!changed) return role;
  return store.updateRole(role.id, { permissions, updatedBy: undefined });
}

/** Permissions for the user's role, read from the database right now. */
export function permissionsOf(store, roleId) {
  if (store === null || store === undefined || roleId === null || roleId === undefined) {
    return allNone();
  }
  const row = store.db.prepare('SELECT permissions, builtin, name FROM roles WHERE id = ?').get(roleId);
  if (row === undefined) return allNone();
  // Built-in roles fall back to their default for keys saved before the area
  // existed (SPEC-v4.md section 1); custom roles read missing as `none`.
  return permissiveParse(row.permissions, Number(row.builtin) === 1 ? row.name : undefined);
}

/**
 * The one access check used by every route (SPEC-v3.md 13.2). `user` carries
 * `{ store, roleId }` (the session user); permissions are re-read from the
 * database on every call. Write implies Read.
 */
export function can(user, area, level = 'read') {
  if (!AREA_BY_KEY.has(area)) {
    throw new Error(`can(): unknown permission area "${area}"`);
  }
  if (!LEVEL_RANK.has(level)) {
    throw new Error(`can(): unknown permission level "${level}"`);
  }
  if (user === null || user === undefined) return false;
  const permissions = permissionsOf(user.store, user.roleId);
  return LEVEL_RANK.get(permissions[area]) >= LEVEL_RANK.get(level);
}

/** Whether a parsed permissions object grants Write on the admin area. */
export function hasAdminWrite(permissions) {
  return LEVEL_RANK.get(permissions.admin) === LEVEL_RANK.get('write');
}

/** Enabled users whose role grants admin Write, as users rows (role joined). */
export function enabledUsersWithAdminWrite(store) {
  return store
    .listUsers()
    .filter(
      (row) =>
        Number(row.disabled) !== 1 &&
        hasAdminWrite(permissionsOf(store, row.role_id ?? row.roleId ?? null))
    );
}