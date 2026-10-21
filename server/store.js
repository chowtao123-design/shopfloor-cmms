'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite store for the Shop Maintenance Log team server.
 * One file (DATA_DIR/maint.db) is the source of truth (SPEC-v2.md section 5).
 */

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','tech')),
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
`;

function getMetaValue(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
}

function setMetaValue(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function migrate(db) {
  // CREATE IF NOT EXISTS: safe on a fresh database and on an existing one.
  // (When later schema versions exist, run stepwise migrations here instead.)
  db.exec(SCHEMA);
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
    close() {
      if (db.open) db.close();
    },
  };
  return store;
}