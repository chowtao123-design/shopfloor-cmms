'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';

/**
 * One-click and scheduled backups: file creation with node:sqlite backup(),
 * 30 s rate limit for manual backups, retention of the newest BACKUP_KEEP,
 * listing and name validation (SPEC-v2.md sections 4, 7, 12).
 */

export const DEFAULT_BACKUP_KEEP = 30;
export const MANUAL_BACKUP_INTERVAL_MS = 30 * 1000;
export const BACKUP_NAME_RE = /^[A-Za-z0-9._-]+\.db$/;

/** Thrown when a manual backup would come within MANUAL_BACKUP_INTERVAL_MS of the last one. */
export class BackupRateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super(
      `A backup was made less than ${MANUAL_BACKUP_INTERVAL_MS / 1000} seconds ago; try again in ${retryAfterSeconds} seconds`
    );
    this.status = 429;
    this.code = 'rate_limited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const lastBackupAtByDataDir = new Map();

const pad2 = (value) => String(value).padStart(2, '0');

/** `YYYYMMDD-HHMMSS` in server local time, used in backup file names. */
export function formatBackupStamp(date = new Date()) {
  return (
    `${pad2(date.getFullYear()).padStart(4, '0')}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

function backupRowExists(db, file) {
  return db.prepare('SELECT 1 FROM backups WHERE file = ?').get(file) !== undefined;
}

/** True only for server-generated names that are recorded in the backups table. */
export function isValidBackupName(db, name) {
  if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) return false;
  return backupRowExists(db, name);
}

function enforceRetention(db, backupsDir, keep) {
  const rows = db
    .prepare('SELECT file FROM backups ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?')
    .all(keep);
  for (const row of rows) {
    db.prepare('DELETE FROM backups WHERE file = ?').run(row.file);
    fs.rmSync(path.join(backupsDir, row.file), { force: true });
  }
}

/**
 * Create one backup file under DATA_DIR/backups (SPEC-v2.md section 12).
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db the live database
 * @param {string} options.dataDir DATA_DIR (holds maint.db and backups/)
 * @param {object|string} options.createdBy {id, username} for a user backup,
 *   or the string 'schedule' for the daily automatic backup
 * @param {string} [options.kind] 'manual' (rate-limited) or 'schedule'
 * @param {number} [options.keep] retention count (BACKUP_KEEP), default 30
 * @returns {Promise<{file: string, createdAt: string, bytes: number}>}
 */
export async function createBackup({ db, dataDir, createdBy, kind = 'manual', keep = DEFAULT_BACKUP_KEEP } = {}) {
  if (db === null || db === undefined) throw new TypeError('createBackup requires an open db (DatabaseSync)');
  if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('createBackup requires a dataDir string');
  if (kind !== 'manual' && kind !== 'schedule') {
    throw new TypeError(`kind must be "manual" or "schedule", got ${JSON.stringify(kind)}`);
  }
  const isSchedule = typeof createdBy === 'string';
  const createdById = isSchedule ? createdBy : createdBy && createdBy.id;
  const label = isSchedule ? createdBy : createdBy && createdBy.username;
  if (typeof createdById !== 'string' || createdById === '') {
    throw new TypeError('createdBy must be "schedule" or an {id, username} object');
  }
  const kept = Math.max(1, Number.isInteger(keep) ? keep : DEFAULT_BACKUP_KEEP);

  if (kind === 'manual') {
    const last = lastBackupAtByDataDir.get(dataDir);
    const now = Date.now();
    if (last !== undefined && now - last < MANUAL_BACKUP_INTERVAL_MS) {
      throw new BackupRateLimitError(
        Math.max(1, Math.ceil((MANUAL_BACKUP_INTERVAL_MS - (now - last)) / 1000))
      );
    }
  }

  const backupsDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const safeLabel = String(label === undefined || label === null ? createdById : label)
    .replace(/[^A-Za-z0-9_-]/g, '-');
  const stamp = formatBackupStamp(new Date());
  let file = `maint-${stamp}-${safeLabel === '' ? 'backup' : safeLabel}.db`;
  let attempt = 1;
  while (fs.existsSync(path.join(backupsDir, file)) || backupRowExists(db, file)) {
    attempt += 1;
    if (attempt > 999) throw new Error('could not pick an unused backup file name');
    file = `maint-${stamp}-${safeLabel === '' ? 'backup' : safeLabel}-${attempt}.db`;
  }

  const finalPath = path.join(backupsDir, file);
  const tempPath = `${finalPath}.tmp`;
  try {
    await backup(db, tempPath);
    fs.renameSync(tempPath, finalPath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw new Error(`could not write the backup file: ${err.message}`);
  }

  const createdAt = new Date().toISOString();
  const bytes = fs.statSync(finalPath).size;
  db.prepare('INSERT INTO backups (file, created_at, created_by, bytes, kind) VALUES (?, ?, ?, ?, ?)').run(
    file,
    createdAt,
    createdById,
    bytes,
    kind
  );
  lastBackupAtByDataDir.set(dataDir, Date.now());
  enforceRetention(db, backupsDir, kept);
  return { file, createdAt, bytes };
}

/** List backups newest first, with the creator's display name or 'Automatic'. */
export function listBackups(db) {
  return db
    .prepare(
      `SELECT b.file, b.created_at, b.bytes, b.kind, u.display_name
         FROM backups b LEFT JOIN users u ON u.id = b.created_by
        ORDER BY b.created_at DESC, b.rowid DESC`
    )
    .all()
    .map((row) => ({
      file: row.file,
      createdAt: row.created_at,
      bytes: Number(row.bytes),
      kind: row.kind,
      createdBy: row.display_name === null || row.display_name === undefined ? 'Automatic' : row.display_name,
    }));
}

const DAILY_AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Milliseconds from `now` until the next local-time HH:MM occurrence
 * (later today, else tomorrow) — the pure core of the daily scheduler.
 */
export function nextRunDelay(now, dailyAt) {
  const match = DAILY_AT_RE.exec(String(dailyAt));
  if (match === null) {
    throw new TypeError(`dailyAt must be "HH:MM" or "off", got ${JSON.stringify(String(dailyAt))}`);
  }
  const start = new Date(now);
  const target = new Date(start);
  target.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (target.getTime() < start.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - start.getTime();
}

/**
 * Daily automatic backup at `at` local time; 'off' (or missing) disables it.
 * Each run recomputes the next delay. The returned handle stops the schedule
 * and is called by the server on close.
 */
export function startBackupSchedule({ db, dataDir, at = 'off', keep = DEFAULT_BACKUP_KEEP } = {}) {
  if (at === undefined || at === null || at === 'off') {
    return { disabled: true, stopped: false, stop() {} };
  }
  nextRunDelay(new Date(), at); // fail fast on an invalid value
  let stopped = false;
  let timer = null;
  const run = async () => {
    if (stopped) return;
    try {
      await createBackup({ db, dataDir, createdBy: 'schedule', kind: 'schedule', keep });
    } catch (err) {
      console.error('[maint-log] scheduled backup failed:', err && err.message ? err.message : err);
    }
    schedule();
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void run();
    }, nextRunDelay(new Date(), at));
    if (typeof timer.unref === 'function') timer.unref();
  };
  schedule();
  return {
    disabled: false,
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}