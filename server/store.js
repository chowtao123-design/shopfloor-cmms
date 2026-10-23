'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { BUILTIN_ROLE_BY_NAME, BUILTIN_ROLES, mergeMissingPermissions } from './permissions.js';
import { dailyNumberBase } from '../logic.js';

/**
 * SQLite store for the Shop Maintenance Log team server.
 * One file (DATA_DIR/maint.db) is the source of truth (SPEC-v2.md section 5).
 */

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- v3 (SPEC-v3.md section 13): roles with per-area permissions. Must be
-- created before users, which references it.
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL COLLATE NOCASE,
  builtin INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','tech')),
  role_id TEXT REFERENCES roles(id),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT,
  expires_at TEXT,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS records (
  store TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (store, id)
);

CREATE INDEX IF NOT EXISTS idx_records_seq ON records (seq);

CREATE TABLE IF NOT EXISTS history (
  hid INTEGER PRIMARY KEY AUTOINCREMENT,
  store TEXT,
  record_id TEXT,
  version INTEGER,
  action TEXT CHECK (action IN ('create','update','delete','restore','stock')),
  user_id TEXT,
  at TEXT,
  before TEXT,
  after TEXT,
  conflict INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_history_store_record ON history (store, record_id);

CREATE TABLE IF NOT EXISTS stock_moves (
  id TEXT PRIMARY KEY,
  part_id TEXT,
  delta INTEGER,
  reason TEXT,
  work_order_id TEXT,
  user_id TEXT,
  at TEXT
);

CREATE TABLE IF NOT EXISTS backups (
  file TEXT PRIMARY KEY,
  created_at TEXT,
  created_by TEXT,
  bytes INTEGER,
  kind TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER,
  window_start TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

  -- v3 API tokens for agents (Muse): the raw token is shown once and only
  -- its SHA-256 hash is stored. Scope is read or write; revocation keeps the
  -- row for the audit trail.
  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    created_by TEXT,
    last_used_at TEXT,
    revoked_at TEXT
  );

  -- v3 (SPEC-v3.md section 8): key/value app settings (branding name, logo file id).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- v3 (SPEC-v3.md section 6): uploaded files metadata; bytes live in DATA_DIR/files/<id>.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL
);

-- v4 (SPEC-v4.md section 4.2): text extracted from manual PDFs, one row per
-- file, filled in the background after an upload and at startup.
CREATE TABLE IF NOT EXISTS file_texts (
  file_id TEXT PRIMARY KEY REFERENCES files(id),
  status TEXT NOT NULL,
  pages_json TEXT NOT NULL DEFAULT '[]',
  chars INTEGER NOT NULL DEFAULT 0,
  extracted_at TEXT
);

-- v3 (SPEC-v3.md section 9): AI chat history, per user and conversation.
CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_user_conversation ON ai_messages (user_id, conversation_id);
`;

function getMetaValue(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
}

function setMetaValue(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

// v3 (SPEC-v3.md section 13): the legacy users.role values map to roles.
const LEGACY_ROLE_TO_BUILTIN = new Map([
  ['admin', 'Administrator'],
  ['tech', 'Technician'],
]);

function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}

function insertRoleHistoryOnCreate(db, roleRow, note) {
  db.prepare(
    `INSERT INTO history (store, record_id, action, user_id, at, before, after, conflict, note)
     VALUES ('roles', ?, 'create', NULL, ?, NULL, ?, 0, ?)`
  ).run(roleRow.id, roleRow.created_at, JSON.stringify(roleSnapshot(roleRow)), note);
}

function roleSnapshot(row) {
  return { name: row.name, builtin: Number(row.builtin) === 1, permissions: JSON.parse(row.permissions) };
}

/**
 * Create the three built-in roles idempotently (INSERT OR IGNORE on the
 * unique name) and record a `roles` history row for each actual creation.
 * Existing roles (and admin edits to built-in levels) are never overwritten.
 */
function seedBuiltinRoles(db) {
  for (const builtin of BUILTIN_ROLES) {
    const permissionsJson = JSON.stringify(builtin.permissions);
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO roles (id, name, builtin, permissions, created_at, updated_at, updated_by)
         VALUES (?, ?, 1, ?, ?, ?, NULL)`
      )
      .run(crypto.randomUUID(), builtin.name, permissionsJson, now, now);
    if (result.changes !== 1) continue;
    const row = db.prepare('SELECT * FROM roles WHERE name = ?').get(builtin.name);
    insertRoleHistoryOnCreate(db, row, 'created by the role migration (SPEC-v3.md section 13)');
  }
}

function snapshotOrNull(row) {
  try {
    return JSON.stringify(roleSnapshot(row));
  } catch {
    return null;
  }
}

/**
 * v4 (SPEC-v4.md section 1): a role saved before the purchasing and library
 * areas existed has no value for those keys. Built-in roles get the built-in
 * default for every missing key (custom roles parse missing as `none`); keys
 * an admin already set are never touched. Idempotent, runs on every startup,
 * and records a `roles` history row for each actual change.
 */
/**
 * Today's next number, e.g. 261022003 = the third of 22 Oct 2026 ("SO-261022-3",
 * logic.js formatOrderNumber). One counter row per kind and server-local day.
 */
function nextDailyNumber(db, kind, now) {
  const base = dailyNumberBase(now);
  const row = db
    .prepare(
      `INSERT INTO counters (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`
    )
    .get(`${kind}:${base / 1000}`);
  const count = Number(row.value);
  // shortcut: three digits per day; a shop never opens 1,000 in one day, widen the format if it ever does.
  if (count > 999) throw new Error(`More than 999 ${kind} numbers today`);
  return base + count;
}

function upgradeBuiltinRolePermissions(db) {
  const rows = db.prepare('SELECT * FROM roles WHERE builtin = 1').all();
  for (const row of rows) {
    const builtin = BUILTIN_ROLE_BY_NAME.get(row.name);
    if (builtin === undefined) continue;
    const { permissions, changed } = mergeMissingPermissions(row.permissions, builtin.permissions);
    if (!changed) continue;
    const before = snapshotOrNull(row);
    db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), row.id);
    const refreshed = db.prepare('SELECT * FROM roles WHERE id = ?').get(row.id);
    db.prepare(
      `INSERT INTO history (store, record_id, action, user_id, at, before, after, conflict, note)
       VALUES ('roles', ?, 'update', NULL, ?, ?, ?, 0, ?)`
    ).run(
      row.id,
      new Date().toISOString(),
      before,
      snapshotOrNull(refreshed),
      'added the purchasing and library areas (SPEC-v4.md section 1)'
    );
  }
}

/** users.role_id for the whole legacy `admin`/`tech` split (13.2 migration). */
function mapLegacyUsers(db) {
  const byName = db.prepare('SELECT id, name FROM roles');
  const roleIdByName = new Map(byName.all().map((row) => [row.name, row.id]));
  for (const [legacy, builtinName] of LEGACY_ROLE_TO_BUILTIN) {
    const roleId = roleIdByName.get(builtinName);
    if (roleId === undefined) continue;
    db.prepare('UPDATE users SET role_id = ? WHERE role = ? AND role_id IS NULL').run(roleId, legacy);
  }
}

function migrate(db) {
  // CREATE IF NOT EXISTS: safe on a fresh database and on an existing one.
  db.exec(SCHEMA);
  if (!columnExists(db, 'users', 'role_id')) {
    // Databases from before v3 roles have no role_id column (stepwise migration).
    db.exec('ALTER TABLE users ADD COLUMN role_id TEXT REFERENCES roles(id)');
  }
  seedBuiltinRoles(db);
  upgradeBuiltinRolePermissions(db);
  mapLegacyUsers(db);
  const row = getMetaValue(db, 'schema_version');
  const current = row ? Number(row.value) : null;
  if (Number.isFinite(current) && current > SCHEMA_VERSION) {
    throw new Error(
      `maint.db schema version ${current} is newer than this server supports (${SCHEMA_VERSION}); upgrade the server.`
    );
  }
  if (current !== SCHEMA_VERSION) {
    setMetaValue(db, 'schema_version', String(SCHEMA_VERSION));
  }
}

/** Public JSON shape of one records row (SPEC-v2.md section 7). */
function publicRecord(row) {
  return {
    store: row.store,
    id: row.id,
    data: JSON.parse(row.data),
    version: Number(row.version),
    deleted: Number(row.deleted) === 1,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    seq: Number(row.seq),
  };
}

/** Public JSON shape of one history entry, with the acting user's display name. */
function publicHistory(row) {
  return {
    hid: Number(row.hid),
    store: row.store,
    recordId: row.record_id,
    version: row.version === null ? null : Number(row.version),
    action: row.action,
    at: row.at,
    userId: row.user_id,
    displayName: row.display_name,
    before: row.before === null ? null : JSON.parse(row.before),
    after: row.after === null ? null : JSON.parse(row.after),
    conflict: Number(row.conflict) === 1,
    note: row.note,
  };
}

/** users rows always carry the joined role name and permissions (v3 13.2). */
const USER_SELECT = `SELECT u.*, r.name AS role_name, r.permissions AS role_permissions
  FROM users u LEFT JOIN roles r ON r.id = u.role_id`;

/** Agent API tokens: prefix, entropy and one-way hashing. */
const API_TOKEN_PREFIX = 'mlt_';
const API_TOKEN_BYTES = 32;

/** SHA-256 of a raw token; only this hash is ever stored or compared. */
export function hashApiToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/** Public JSON shape of one api_tokens row (no hash, no raw value). */
function apiTokenJson(row) {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    userId: row.user_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/** Public JSON shape of one ai_messages row (SPEC-v3.md section 9). */
function publicAiMessage(row) {  return {
    id: Number(row.id),
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    at: row.at,
  };
}

/**
 * Open (creating if needed) the SQLite database in `dataDir`.
 * @param {string} dataDir directory for maint.db (and later backups/)
 * @returns {object} store handle
 */
export function openStore(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') {
    throw new Error('openStore requires a dataDir path string');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'maint.db');
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  } catch (err) {
    try { db.close(); } catch { /* close what we can; report the original error */ }
    throw err;
  }

  /** @type {{ db: import('node:sqlite').DatabaseSync, dataDir: string, dbFile: string,
   *    schemaVersion: number, getMeta: (key: string) => string | null,
   *    setMeta: (key: string, value: string) => void, nextSeq: () => number,
   *    close: () => void }} */
  const store = {
    db,
    dataDir,
    dbFile,
    schemaVersion: SCHEMA_VERSION,
    getMeta(key) {
      const row = getMetaValue(db, key);
      return row ? row.value : null;
    },
    setMeta(key, value) {
      setMetaValue(db, key, value);
    },
    /** Global, strictly increasing change counter (section 5 `counters` for `seq`). */
    nextSeq() {
      const row = db
        .prepare(
          `INSERT INTO counters (name, value) VALUES ('seq', 1)
           ON CONFLICT(name) DO UPDATE SET value = value + 1
           RETURNING value`
        )
        .get();
      return Number(row.value);
    },
    /**
     * Next sequential service order number (SPEC-v3.md section 2). Must be
     * called inside the same transaction as the record write so concurrent
     * creates get distinct numbers.
     */
    nextWorkOrderNumber(now = new Date()) {
      return nextDailyNumber(db, 'workOrderNumber', now);
    },
    /**
     * Next sequential parts request number (SPEC-v4.md section 2), own
     * `PR-0001` sequence. Same transaction rule as nextWorkOrderNumber:
     * called inside the record write so concurrent creates stay distinct.
     */
    nextPurchaseRequestNumber(now = new Date()) {
      return nextDailyNumber(db, 'purchaseRequestNumber', now);
    },
    /**
     * Create an API token for an agent user. Returns the raw token once; only
     * its SHA-256 hash is stored, so it can never be shown again.
     */
    createApiToken({ name, scope, userId, createdBy = null }) {
      const token = `${API_TOKEN_PREFIX}${crypto.randomBytes(API_TOKEN_BYTES).toString('base64url')}`;
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO api_tokens (id, name, token_hash, scope, user_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, name, hashApiToken(token), scope, userId, new Date().toISOString(), createdBy);
      return { token, record: this.getApiToken(id) };
    },
    /** One token's public metadata (never the hash or the raw token). */
    getApiToken(id) {
      const row = db
        .prepare(
          `SELECT id, name, scope, user_id, created_at, created_by, last_used_at, revoked_at
           FROM api_tokens WHERE id = ?`
        )
        .get(id);
      return row === undefined ? null : apiTokenJson(row);
    },
    listApiTokens() {
      return db
        .prepare(
          `SELECT id, name, scope, user_id, created_at, created_by, last_used_at, revoked_at
           FROM api_tokens ORDER BY created_at DESC`
        )
        .all()
        .map(apiTokenJson);
    },
    /** The live token row for a raw token hash, or null (revoked/unknown). */
    findApiTokenByHash(hash) {
      const row = db
        .prepare(
          `SELECT id, name, scope, user_id, revoked_at FROM api_tokens
           WHERE token_hash = ? AND revoked_at IS NULL`
        )
        .get(hash);
      return row === undefined ? null : row;
    },
    touchApiToken(id) {
      db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    },
    /** Revoke a token; the row stays for the audit trail. */
    revokeApiToken(id) {
      const now = new Date().toISOString();
      db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
      return this.getApiToken(id);
    },
    /** Settings value by key, or null (SPEC-v3.md section 8). */
    getSetting(key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row === undefined ? null : row.value;
    },
    setSetting(key, value) {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(key, value);
    },
    deleteSetting(key) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    },
    /**
     * All live records of one store, oldest seq first (v3 SPEC-v3.md
     * section 9 read-only AI snapshot). Tombstones are excluded.
     */
    listRecords(storeName) {
      return db
        .prepare('SELECT * FROM records WHERE store = ? AND deleted = 0 ORDER BY seq ASC')
        .all(storeName)
        .map((row) => publicRecord(row));
    },
    /** Insert one AI chat message (SPEC-v3.md section 9). */
    insertAiMessage(message) {
      const result = db
        .prepare(
          `INSERT INTO ai_messages (conversation_id, user_id, role, content, at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(message.conversationId, message.userId, message.role, message.content, message.at);
      return Number(result.lastInsertRowid);
    },
    /**
     * A user's own AI messages (public shape), newest last; optionally scoped
     * to one conversation. Other users' chats are never visible (SPEC-v3.md
     * section 9).
     */
    listAiMessages(userId, conversationId = null) {
      const rows =
        conversationId === null
          ? db
              .prepare(
                `SELECT id, conversation_id, role, content, at FROM ai_messages
                 WHERE user_id = ? ORDER BY id ASC`
              )
              .all(userId)
          : db
              .prepare(
                `SELECT id, conversation_id, role, content, at FROM ai_messages
                 WHERE user_id = ? AND conversation_id = ? ORDER BY id ASC`
              )
              .all(userId, conversationId);
      return rows.map((row) => publicAiMessage(row));
    },
    /** Delete a user's own AI messages, all or one conversation; returns the count. */
    deleteAiMessages(userId, conversationId = null) {
      const statement =
        conversationId === null
          ? db.prepare('DELETE FROM ai_messages WHERE user_id = ?')
          : db.prepare('DELETE FROM ai_messages WHERE user_id = ? AND conversation_id = ?');
      const params = conversationId === null ? [userId] : [userId, conversationId];
      return statement.run(...params).changes;
    },
    /** Insert one uploaded-file row (SPEC-v3.md section 6). */
    insertFile(file) {
      db.prepare(
        `INSERT INTO files (id, name, mime, size, sha256, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        file.id,
        file.name,
        file.mime,
        file.size,
        file.sha256,
        file.uploadedBy === undefined ? null : file.uploadedBy,
        file.uploadedAt
      );
      return this.getFileById(file.id);
    },
    /** One files row by id, or null. */
    getFileById(id) {
      const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
      return row === undefined ? null : row;
    },
    deleteFileById(id) {
      return db.prepare('DELETE FROM files WHERE id = ?').run(id).changes > 0;
    },
    // ---------------------------------------------------------------------
    // v4 (SPEC-v4.md section 4.2): extracted manual text per uploaded PDF.
    // ---------------------------------------------------------------------
    /** One file_texts row (snake_case) or null. */
    getFileText(fileId) {
      const row = db.prepare('SELECT * FROM file_texts WHERE file_id = ?').get(fileId);
      return row === undefined ? null : row;
    },
    /** Insert or update one file_texts row. */
    upsertFileText({ fileId, status, pages = [], chars = 0, extractedAt = null }) {
      db.prepare(
        `INSERT INTO file_texts (file_id, status, pages_json, chars, extracted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET
           status = excluded.status,
           pages_json = excluded.pages_json,
           chars = excluded.chars,
           extracted_at = excluded.extracted_at`
      ).run(fileId, status, JSON.stringify(pages), chars, extractedAt);
    },
    /**
     * The extracted page texts of one file for the AI to read (V4-M5), or
     * null when there is no row or the extraction did not succeed.
     */
    getFileTextPages(fileId) {
      const row = this.getFileText(fileId);
      if (row === null || row.status !== 'ok') return null;
      try {
        const pages = JSON.parse(row.pages_json);
        return Array.isArray(pages) ? pages : null;
      } catch {
        return null;
      }
    },
    /**
     * PDFs with no file_texts row (or still 'pending' from an interrupted
     * run): the startup extraction sweep (SPEC-v4.md section 4.2), oldest
     * upload first.
     */
    listFilesNeedingText() {
      return db
        .prepare(
          `SELECT f.* FROM files f
           LEFT JOIN file_texts t ON t.file_id = f.id
           WHERE f.mime = 'application/pdf' AND (t.file_id IS NULL OR t.status = 'pending')
           ORDER BY f.uploaded_at, f.id`
        )
        .all();
    },
    /**
     * Resolve the role a create/update refers to: an explicit roleId, or the
     * legacy `role` value ('admin' -> Administrator, 'tech' -> Technician).
     * The legacy column is written once on insert with its mapped value and
     * left untouched afterwards (13.2: readable, not updated).
     */
    resolveRole({ roleId, role }) {
      if (roleId !== undefined) {
        const byId = this.getRoleById(roleId);
        if (byId === null) throw new Error(`unknown roleId "${String(roleId)}"`);
        return byId;
      }
      const builtinName = role === 'admin' ? 'Administrator' : 'Technician';
      const byName = this.getRoleByName(builtinName);
      if (byName === null) {
        throw new Error(`the built-in role "${builtinName}" is missing; cannot map role "${String(role)}"`);
      }
      return byName;
    },
    createUser({ username, displayName, role, roleId, passwordHash }) {
      const roleRow = this.resolveRole({ roleId, role });
      const legacyRole = roleRow.name === 'Administrator' ? 'admin' : 'tech';
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, role_id, disabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
      ).run(id, username, displayName, passwordHash, legacyRole, roleRow.id, new Date().toISOString());
      return this.getUserById(id);
    },
    getUserByUsername(username) {
      const row = db.prepare(USER_SELECT + ' WHERE u.username = ?').get(username);
      return row === undefined ? null : row;
    },
    getUserById(id) {
      const row = db.prepare(USER_SELECT + ' WHERE u.id = ?').get(id);
      return row === undefined ? null : row;
    },
    listUsers() {
      return db.prepare(USER_SELECT + ' ORDER BY u.created_at, u.username').all();
    },
    updateUser(id, fields) {
      const columns = {
        displayName: 'display_name',
        roleId: 'role_id',
        disabled: 'disabled',
        passwordHash: 'password_hash',
      };
      const sets = [];
      const values = [];
      for (const [field, column] of Object.entries(columns)) {
        if (fields[field] === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(fields[field]);
      }
      if (sets.length > 0) {
        values.push(id);
        db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      }
      return this.getUserById(id);
    },
    deleteUserSessions(userId) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    },

    // -----------------------------------------------------------------------
    // Roles (SPEC-v3.md section 13): every change is written to history with
    // store 'roles' and before/after, like records.
    // -----------------------------------------------------------------------

    listRoles() {
      return db.prepare('SELECT * FROM roles ORDER BY builtin DESC, name').all();
    },
    getRoleById(id) {
      const row = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
      return row === undefined ? null : row;
    },
    getRoleByName(name) {
      const row = db.prepare('SELECT * FROM roles WHERE name = ?').get(name);
      return row === undefined ? null : row;
    },
    /** Number of users currently assigned to a role. */
    roleUsersCount(roleId) {
      const row = db.prepare('SELECT COUNT(*) AS count FROM users WHERE role_id = ?').get(roleId);
      return Number(row.count);
    },
    createRole({ name, permissions, updatedBy }) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO roles (id, name, builtin, permissions, created_at, updated_at, updated_by)
         VALUES (?, ?, 0, ?, ?, ?, ?)`
      ).run(id, name, JSON.stringify(permissions), now, now, updatedBy === undefined ? null : updatedBy);
      const row = this.getRoleById(id);
      this.insertHistory({
        store: 'roles',
        recordId: id,
        version: null,
        action: 'create',
        userId: updatedBy,
        at: now,
        before: null,
        after: JSON.stringify(roleSnapshot(row)),
        conflict: false,
        note: null,
      });
      return row;
    },
    updateRole(id, { name, permissions, updatedBy }) {
      const current = this.getRoleById(id);
      if (current === null) return null;
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE roles SET name = ?, permissions = ?, updated_at = ?, updated_by = ?
         WHERE id = ?`
      ).run(
        name === undefined ? current.name : name,
        JSON.stringify(permissions === undefined ? JSON.parse(current.permissions) : permissions),
        now,
        updatedBy === undefined ? current.updated_by : updatedBy,
        id
      );
      const row = this.getRoleById(id);
      this.insertHistory({
        store: 'roles',
        recordId: id,
        version: null,
        action: 'update',
        userId: updatedBy,
        at: now,
        before: JSON.stringify(roleSnapshot(current)),
        after: JSON.stringify(roleSnapshot(row)),
        conflict: false,
        note: null,
      });
      return row;
    },
    deleteRole(id, { updatedBy } = {}) {
      const current = this.getRoleById(id);
      if (current === null) return null;
      const now = new Date().toISOString();
      const before = JSON.stringify(roleSnapshot(current));
      db.prepare('DELETE FROM roles WHERE id = ?').run(id);
      this.insertHistory({
        store: 'roles',
        recordId: id,
        version: null,
        action: 'delete',
        userId: updatedBy,
        at: now,
        before,
        after: null,
        conflict: false,
        note: null,
      });
      return current;
    },
    /** History entries for one role, newest first (store 'roles'). */
    roleHistory(roleId) {
      return this.historyList('roles', roleId);
    },
    createSession({ tokenHash, userId, createdAt, expiresAt, lastSeenAt }) {
      db.prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
      ).run(tokenHash, userId, createdAt, expiresAt, lastSeenAt);
    },
    getSessionWithUser(tokenHash) {
      const row = db
        .prepare(
          `SELECT s.token_hash, s.created_at AS session_created_at, s.expires_at, s.last_seen_at,
                  u.id AS user_id, u.username, u.display_name, u.role AS legacy_role, u.role_id, u.disabled,
                  r.name AS role_name
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN roles r ON r.id = u.role_id
           WHERE s.token_hash = ?`
        )
        .get(tokenHash);
      return row === undefined ? null : row;
    },
    touchSession(tokenHash, { expiresAt, lastSeenAt } = {}) {
      const sets = [];
      const values = [];
      if (expiresAt !== undefined) {
        sets.push('expires_at = ?');
        values.push(expiresAt);
      }
      if (lastSeenAt !== undefined) {
        sets.push('last_seen_at = ?');
        values.push(lastSeenAt);
      }
      if (sets.length === 0) return;
      values.push(tokenHash);
      db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE token_hash = ?`).run(...values);
    },
    deleteSessionByTokenHash(tokenHash) {
      return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes > 0;
    },
    getLoginAttempt(key) {
      const row = db.prepare('SELECT key, count, window_start FROM login_attempts WHERE key = ?').get(key);
      return row === undefined ? null : row;
    },
    setLoginAttempt(key, count, windowStart) {
      db.prepare(
        `INSERT INTO login_attempts (key, count, window_start) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start`
      ).run(key, count, windowStart);
    },
    deleteLoginAttempt(key) {
      db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
    },
    /** Display name of a user id, or null for unknown/absent users. */
    displayName(userId) {
      if (userId === null || userId === undefined) return null;
      const row = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
      return row === undefined ? null : row.display_name;
    },
    /** Display name of a user id, or null for unknown/absent users. */
    /**
     * Run `fn` inside one SQLite transaction so every write (records row,
     * counter bump, history entry) commits or rolls back together. Not
     * reentrant: public operations wrap their own single transaction.
     */
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      let result;
      try {
        result = fn();
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* connection already left the transaction; report original error */
        }
        throw err;
      }
      db.exec('COMMIT');
      return result;
    },
    /** Current row for a record (or null), including tombstones. */
    getRecord(storeName, id) {
      const row = db
        .prepare('SELECT * FROM records WHERE store = ? AND id = ?')
        .get(storeName, id);
      return row === undefined ? null : row;
    },
    /** Insert or fully replace one records row (version bump decided by caller). */
    upsertRecord(record) {
      db.prepare(
        `INSERT INTO records
           (store, id, data, version, deleted, created_at, created_by, updated_at, updated_by, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(store, id) DO UPDATE SET
           data = excluded.data,
           version = excluded.version,
           deleted = excluded.deleted,
           created_at = excluded.created_at,
           created_by = excluded.created_by,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by,
           seq = excluded.seq`
      ).run(
        record.store,
        record.id,
        record.data,
        record.version,
        record.deleted ? 1 : 0,
        record.createdAt,
        record.createdBy === undefined ? null : record.createdBy,
        record.updatedAt,
        record.updatedBy,
        record.seq
      );
    },
    /** Append one history entry; `before`/`after` are JSON strings or null. */
    insertHistory(entry) {
      db.prepare(
        `INSERT INTO history
           (store, record_id, version, action, user_id, at, before, after, conflict, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.store,
        entry.recordId,
        entry.version === undefined ? null : entry.version,
        entry.action,
        entry.userId === undefined ? null : entry.userId,
        entry.at,
        entry.before === undefined ? null : entry.before,
        entry.after === undefined ? null : entry.after,
        entry.conflict ? 1 : 0,
        entry.note === undefined ? null : entry.note
      );
    },
    /**
     * Changes feed: records with seq > since ordered by seq (ascending),
     * tombstones included. Returns {records, lastSeq, more} where `more`
     * marks a truncated page and `lastSeq` is the resume position.
     */
    changesFeed(since, limit) {
      const rows = db
        .prepare('SELECT * FROM records WHERE seq > ? ORDER BY seq ASC LIMIT ?')
        .all(since, limit + 1);
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const records = page.map((row) => publicRecord(row));
      let lastSeq;
      if (records.length > 0) {
        lastSeq = records[records.length - 1].seq;
      } else {
        const max = db.prepare('SELECT MAX(seq) AS seq FROM records').get();
        lastSeq = Math.max(since, Number(max && max.seq) || 0);
      }
      return { records, lastSeq, more };
    },
    /** History entries for one record, newest first, with display names. */
    historyList(storeName, recordId) {
      return db
        .prepare(
          `SELECT h.hid, h.store, h.record_id, h.version, h.action, h.user_id, h.at,
                  h.before, h.after, h.conflict, h.note, u.display_name
           FROM history h LEFT JOIN users u ON u.id = h.user_id
           WHERE h.store = ? AND h.record_id = ?
           ORDER BY h.hid DESC`
        )
        .all(storeName, recordId)
        .map((row) => publicHistory(row));
    },
    /** An applied stock move by its client id, or null (idempotency check). */
    getStockMove(id) {
      const row = db.prepare('SELECT * FROM stock_moves WHERE id = ?').get(id);
      return row === undefined ? null : row;
    },
    insertStockMove(move) {
      db.prepare(
        `INSERT INTO stock_moves (id, part_id, delta, reason, work_order_id, user_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        move.id,
        move.partId,
        move.delta,
        move.reason,
        move.workOrderId === undefined ? null : move.workOrderId,
        move.userId,
        move.at
      );
    },
    close() {
      if (db.open) db.close();
    },
  };
  return store;
}