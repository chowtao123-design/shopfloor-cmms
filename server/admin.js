'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as auth from './auth.js';
import { BACKUP_NAME_RE, formatBackupStamp, isValidBackupName } from './backup.js';
import { can, normalizePermissions } from './permissions.js';
import { deleteRecord, importV1, isValidRecordId, putRecord, validateRecordData } from './records.js';
import { openStore } from './store.js';
import { ensureAgentUser } from './apiTokens.js';
import { isMainModule } from './is-main.js';

const DATA_DIR =
  process.env.DATA_DIR === undefined || process.env.DATA_DIR === '' ? './data' : process.env.DATA_DIR;

const USAGE = `Usage:
  node server/admin.js create-user [--admin | --role "<Role name>"] <username> "<Display Name>" [--password-stdin]
  node server/admin.js reset-password <username> [--password-stdin]
  node server/admin.js disable-user <username>
  node server/admin.js enable-user <username>
  node server/admin.js list-users
  node server/admin.js token create --name "<label>" [--scope read|write] [--agent <username>]
  node server/admin.js token list
  node server/admin.js token revoke <token-id>
  node server/admin.js import-v1 <file> --as <username>
  node server/admin.js import-floor-map <layout.json> <stations.json> [--name "Main floor"] [--replace]
  node server/admin.js restore <backup-file> [--yes]

Accounts live in the SQLite database under DATA_DIR (default: ./data).
Passwords are read hidden from the terminal, or as one line from stdin
when --password-stdin is given. import-v1 reads a v1 JSON backup and
attributes the imported records to the given admin user.

create-user assigns the Administrator role with --admin, the named role
with --role "<Role name>" (see list-users), and the Technician role
otherwise. restore copies a backup from DATA_DIR/backups over the live
database. Stop the Shop Maintenance Log server first; restore asks for
--yes to confirm. The current database is kept as backups/pre-restore-<timestamp>.db.

import-floor-map (SPEC-v5.md section 4) creates the floor map record and
its stations from the client's map export: layout.json holds the geometry
(page size, boxes, corridors, fills) and stations.json the roster. Box
slot "lines" are ignored completely and non-roster fields (phone,
emergency contact, join date, shift...) are dropped; a station whose box
does not exist becomes off-map, and a station whose code matches a machine
name (ignoring case, spaces and dashes) is auto-linked to it. --name names
the floor (default "Main floor"); an existing map with that name is only
replaced with --replace. Only counts and codes are printed, never staff
names: the roster lives in the database only, never in this repo.`;

function usageError() {
  console.error(USAGE);
  return 1;
}

async function readPasswordFromStdin() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = chunks.join('');
  const newline = text.indexOf('\n');
  return (newline === -1 ? text : text.slice(0, newline)).replace(/\r$/, '');
}

function readPasswordHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY !== true) {
      reject(new Error('stdin is not a terminal; use --password-stdin'));
      return;
    }
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    let value = '';
    const finish = (result) => {
      process.stdin.setRawMode(false);
      process.stdin.off('data', onData);
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(result);
    };
    // Handle one character at a time: a paste arrives as one chunk that may end with Enter,
    // and Windows terminals send \b (not DEL) for Backspace.
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(value);
        if (ch === '\x03') return finish(null);
        if (ch === '\x7f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function obtainPassword(passwordStdin, username) {
  const raw = passwordStdin
    ? await readPasswordFromStdin()
    : await readPasswordHidden(`Password for ${username}: `);
  if (raw === null) throw new Error('Password entry was cancelled');
  const check = auth.checkPassword(raw);
  if (!check.ok) throw new Error(check.message);
  return check.value;
}

async function cmdCreateUser(args) {
  let admin = false;
  let passwordStdin = false;
  let roleName = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--admin') {
      admin = true;
    } else if (arg === '--role') {
      roleName = args[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--role=')) {
      roleName = arg.slice(7);
    } else if (arg === '--password-stdin') {
      passwordStdin = true;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) return usageError();
  if (admin && roleName !== null) {
    throw new Error('create-user takes either --admin or --role "<Role name>", not both');
  }
  const username = auth.checkUsername(positional[0]);
  if (!username.ok) throw new Error(`username: ${username.message}`);
  const displayName = auth.checkDisplayName(positional[1]);
  if (!displayName.ok) throw new Error(`displayName: ${displayName.message}`);
  const password = await obtainPassword(passwordStdin, username.value);
  const store = openStore(DATA_DIR);
  try {
    if (store.getUserByUsername(username.value) !== null) {
      throw new Error(`user "${username.value}" already exists`);
    }
    // --admin assigns Administrator, --role "<name>" the named role, and the
    // default is Technician (SPEC-v3.md 13.2).
    let roleRow = null;
    if (admin) {
      roleRow = store.getRoleByName('Administrator');
      if (roleRow === null) throw new Error('the built-in role "Administrator" is missing');
    } else if (roleName !== null) {
      roleRow = store.getRoleByName(roleName);
      if (roleRow === null) throw new Error(`no role named "${roleName}" (see list-users)`);
    } else {
      roleRow = store.getRoleByName('Technician');
      if (roleRow === null) throw new Error('the built-in role "Technician" is missing');
    }
    const user = store.createUser({
      username: username.value,
      displayName: displayName.value,
      roleId: roleRow.id,
      passwordHash: auth.hashPassword(password),
    });
    console.log(`Created ${user.role_name} "${user.username}" (${user.display_name})`);
    return 0;
  } finally {
    store.close();
  }
}

async function cmdResetPassword(args) {
  let passwordStdin = false;
  const positional = [];
  for (const arg of args) {
    if (arg === '--password-stdin') passwordStdin = true;
    else positional.push(arg);
  }
  if (positional.length !== 1) return usageError();
  const store = openStore(DATA_DIR);
  try {
    const user = store.getUserByUsername(positional[0]);
    if (user === null) throw new Error(`no user named "${positional[0]}"`);
    const password = await obtainPassword(passwordStdin, user.username);
    store.updateUser(user.id, { passwordHash: auth.hashPassword(password) });
    console.log(`Password updated for "${user.username}"`);
    return 0;
  } finally {
    store.close();
  }
}

async function cmdDisableUser(args) {
  if (args.length !== 1) return usageError();
  const store = openStore(DATA_DIR);
  try {
    const user = store.getUserByUsername(args[0]);
    if (user === null) throw new Error(`no user named "${args[0]}"`);
    store.updateUser(user.id, { disabled: 1 });
    store.deleteUserSessions(user.id);
    console.log(`Disabled "${user.username}" and deleted their sessions`);
    return 0;
  } finally {
    store.close();
  }
}

async function cmdEnableUser(args) {
  if (args.length !== 1) return usageError();
  const store = openStore(DATA_DIR);
  try {
    const user = store.getUserByUsername(args[0]);
    if (user === null) throw new Error(`no user named "${args[0]}"`);
    store.updateUser(user.id, { disabled: 0 });
    console.log(`Enabled "${user.username}"`);
    return 0;
  } finally {
    store.close();
  }
}

async function cmdListUsers(args) {
  if (args.length > 0) return usageError();
  const store = openStore(DATA_DIR);
  try {
    const users = store.listUsers();
    if (users.length === 0) {
      console.log('No users yet. Create the first admin with:');
      console.log('  node server/admin.js create-user --admin <username> "<Display Name>"');
      return 0;
    }
    const header = ['username', 'display name', 'role', 'disabled', 'created'];
    console.log(header.map((name) => name.padEnd(18)).join('').trimEnd());
    for (const user of users) {
      const cells = [
        user.username,
        user.display_name,
        user.role_name === undefined || user.role_name === null ? `(no role)` : user.role_name,
        Number(user.disabled) === 1 ? 'yes' : 'no',
        user.created_at,
      ];
      console.log(
        cells
          .map((cell) => String(cell).padEnd(18))
          .join('')
          .trimEnd()
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

async function cmdImportV1(args) {
  let asUsername = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--as') {
      asUsername = args[i + 1] ?? null;
      i += 1;
    } else if (args[i].startsWith('--as=')) {
      asUsername = args[i].slice(5);
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length !== 1 || asUsername === null || asUsername === '') return usageError();
  const file = positional[0];
  const store = openStore(DATA_DIR);
  try {
    const user = store.getUserByUsername(asUsername);
    if (user === null) throw new Error(`no user named "${asUsername}"`);
    if (!can({ ...user, store }, 'admin', 'write')) {
      throw new Error(`user "${asUsername}" cannot import v1 data; their role needs "write" access to Users & roles`);
    }
    let payload;
    try {
      payload = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch (err) {
      throw new Error(`could not read v1 backup "${file}": ${err.message}`);
    }
    const counts = importV1(store, payload, user);
    console.log(`Imported ${counts.created} record(s); skipped ${counts.skipped} existing.`);
    console.log(`Attributed to "${user.username}" (${user.display_name}).`);
    return 0;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// import-floor-map (SPEC-v5.md section 4): the one-time admin import of the
// client's map export. layout.json carries the geometry (page size, boxes,
// corridors, fills) and stations.json the roster. Box slot "lines" (staff
// names) are ignored completely; non-roster station fields are dropped.
// Everything is written through putRecord/deleteRecord, so history rows and
// attribution exist exactly like a server-side write.
// ---------------------------------------------------------------------------

const SYSTEM_USERNAME = 'system';
const SYSTEM_DISPLAY_NAME = 'System';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonFile(file, what) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`could not read the ${what} file "${file}": ${err.message}`);
  }
}

/** Map numbers keep at most two decimals (SPEC-v5.md section 1.1). */
function roundMapNumber(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${where} must be a number`);
  }
  return Math.round(value * 100) / 100;
}

/**
 * The disabled bot user the CLI writes as — the same convention the admin
 * commands already use for non-human actors (the Muse Agent / AI Assistant
 * bot accounts): every record edit is attributed in the history log, and
 * nobody can sign in as the bot. Its role only ever carries floorMap.
 */
function ensureSystemUser(store) {
  const existing = store.getUserByUsername(SYSTEM_USERNAME);
  if (existing !== null) {
    return { ...existing, roleId: existing.role_id ?? existing.roleId ?? null };
  }
  let role = store.getRoleByName(SYSTEM_DISPLAY_NAME);
  if (role === null) {
    role = store.createRole({
      name: SYSTEM_DISPLAY_NAME,
      permissions: normalizePermissions({ floorMap: 'write' }),
      updatedBy: null,
    });
  }
  const created = store.createUser({
    username: SYSTEM_USERNAME,
    displayName: SYSTEM_DISPLAY_NAME,
    roleId: role.id,
    passwordHash: auth.hashPassword(crypto.randomBytes(32).toString('hex')),
  });
  store.updateUser(created.id, { disabled: 1 });
  const row = store.getUserById(created.id);
  return { ...row, roleId: role.id };
}

/** Geometry -> one floorMaps record data object (SPEC-v5.md section 4). */
function buildMapData(layout, name) {
  if (!isPlainObject(layout)) throw new Error('the layout file must be a JSON object');
  const page = isPlainObject(layout.page) ? layout.page : {};
  const map = {
    name,
    width: roundMapNumber(page.w, 'layout page.w'),
    height: roundMapNumber(page.h, 'layout page.h'),
  };
  const boxes = Array.isArray(layout.boxes) ? layout.boxes : [];
  map.boxes = boxes.map((box, index) => {
    if (!isPlainObject(box)) throw new Error(`layout boxes[${index}] must be an object`);
    if (typeof box.id !== 'string' || box.id === '') {
      throw new Error(`layout boxes[${index}].id is required`);
    }
    // slots = box.slots.length (SPEC-v5.md section 4); box.slots[].lines are
    // ignored completely — staff names never reach the map record.
    const slotCount = Array.isArray(box.slots) ? box.slots.length : 0;
    if (slotCount > 12) {
      throw new Error(`layout boxes[${index}] has ${slotCount} slots; a box holds at most 12`);
    }
    return {
      id: box.id,
      x: roundMapNumber(box.x, `layout boxes[${index}].x`),
      y: roundMapNumber(box.y, `layout boxes[${index}].y`),
      w: roundMapNumber(box.w, `layout boxes[${index}].w`),
      h: roundMapNumber(box.h, `layout boxes[${index}].h`),
      slots: slotCount > 0 ? slotCount : 1,
      fill: typeof box.fill === 'string' ? box.fill : null,
      label: typeof box.label === 'string' ? box.label : '',
    };
  });
  map.corridors = (Array.isArray(layout.corridors) ? layout.corridors : []).map((rect, index) => {
    if (!Array.isArray(rect) || rect.length !== 4) {
      throw new Error(`layout corridors[${index}] must be [x, y, w, h]`);
    }
    return {
      x: roundMapNumber(rect[0], `layout corridors[${index}].x`),
      y: roundMapNumber(rect[1], `layout corridors[${index}].y`),
      w: roundMapNumber(rect[2], `layout corridors[${index}].w`),
      h: roundMapNumber(rect[3], `layout corridors[${index}].h`),
    };
  });
  map.fills = (Array.isArray(layout.fills) ? layout.fills : []).map((patch, index) => {
    if (!Array.isArray(patch) || patch.length !== 5) {
      throw new Error(`layout fills[${index}] must be [x, y, w, h, color]`);
    }
    if (typeof patch[4] !== 'string') {
      throw new Error(`layout fills[${index}].color must be a #rrggbb string`);
    }
    return {
      x: roundMapNumber(patch[0], `layout fills[${index}].x`),
      y: roundMapNumber(patch[1], `layout fills[${index}].y`),
      w: roundMapNumber(patch[2], `layout fills[${index}].w`),
      h: roundMapNumber(patch[3], `layout fills[${index}].h`),
      color: patch[4],
    };
  });
  return map;
}

/**
 * One stations.json entry -> floorStations data (SPEC-v5.md section 4):
 * id, box, slot, zone, code, emp->empId, en->name, cn->nameCn, vac->vacant,
 * rem->remark. Every other field (phone, emg, join, shift...) is dropped.
 */
function buildStationData(station, mapId) {
  const data = { mapId };
  // Off-map stations in the export have slot null; the slot means nothing without a box.
  if (Number.isInteger(station.slot)) data.slot = station.slot;
  if (station.code !== undefined) data.code = station.code;
  if (station.zone !== undefined) data.zone = station.zone;
  if (station.en !== undefined) data.name = station.en;
  if (station.cn !== undefined) data.nameCn = station.cn;
  if (station.emp !== undefined) data.empId = station.emp;
  if (station.vac !== undefined) data.vacant = station.vac === true;
  if (station.rem !== undefined) data.remark = station.rem;
  return data;
}

/** A station code's match key: case, space and dash insensitive (section 4). */
function machineKey(text) {
  return String(text ?? '').toLowerCase().replace(/[\s-]+/g, '');
}

async function cmdImportFloorMap(args) {
  let name = 'Main floor';
  let replace = false;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--name') {
      name = args[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--name=')) {
      name = arg.slice(7);
    } else if (arg === '--replace') {
      replace = true;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) return usageError();
  if (typeof name !== 'string' || name.trim() === '' || name.trim().length > 80) {
    throw new Error('--name must be 1-80 characters');
  }
  name = name.trim();
  const [layoutFile, stationsFile] = positional;
  const layout = await readJsonFile(layoutFile, 'layout');
  const stations = await readJsonFile(stationsFile, 'stations');
  if (!Array.isArray(stations)) throw new Error('the stations file must be a JSON array');

  const store = openStore(DATA_DIR);
  try {
    const user = ensureSystemUser(store);
    const map = buildMapData(layout, name);
    const boxIds = new Set(map.boxes.map((box) => box.id));

    // Auto-link: station code == machine name, case/space/dash-insensitive.
    const machineByKey = new Map();
    for (const record of store.listRecords('machines')) {
      const key = machineKey(record.data.name);
      if (key !== '' && !machineByKey.has(key)) machineByKey.set(key, record.id);
    }

    const mapId = crypto.randomUUID();
    const rows = [];
    let linked = 0;
    const unlinked = [];
    for (const [index, station] of stations.entries()) {
      if (!isPlainObject(station)) {
        throw new Error(`stations[${index}] must be an object`);
      }
      const data = buildStationData(station, mapId);
      // A station whose box does not exist becomes off-map (boxId null).
      data.boxId = typeof station.box === 'string' && boxIds.has(station.box) ? station.box : null;
      const key = machineKey(data.code);
      if (key !== '' && machineByKey.has(key)) {
        data.machineId = machineByKey.get(key);
        linked += 1;
      } else if (data.code !== undefined && data.code !== '') {
        unlinked.push(data.code);
      }
      rows.push({ id: null, sourceId: station.id, data });
    }

    // Validate everything before writing anything: a bad line never leaves a
    // half-imported map behind (putRecord validates again on the write path).
    validateRecordData('floorMaps', map, { isCreate: true, part: 'layout' });
    for (const [index, row] of rows.entries()) {
      validateRecordData('floorStations', row.data, {
        isCreate: true,
        part: `stations[${index}]`,
      });
    }

    const existing = store
      .listRecords('floorMaps')
      .find((record) => record.data.name === name);
    let removedStations = 0;
    if (existing !== undefined) {
      if (!replace) {
        throw new Error(
          `a floor map named "${name}" already exists (record ${existing.id}); pass --replace to import over it`
        );
      }
      for (const record of store.listRecords('floorStations')) {
        if (record.data.mapId !== existing.id) continue;
        deleteRecord(store, {
          storeName: 'floorStations',
          id: record.id,
          baseVersion: null,
          user,
        });
        removedStations += 1;
      }
      deleteRecord(store, { storeName: 'floorMaps', id: existing.id, baseVersion: null, user });
    }

    // Station ids: the roster's own id when it is a valid unused record id,
    // a fresh UUID otherwise (stable for a later "request repair" page).
    for (const row of rows) {
      const sourceId = row.sourceId;
      row.id =
        isValidRecordId(sourceId) && store.getRecord('floorStations', sourceId) === null
          ? sourceId
          : crypto.randomUUID();
    }

    putRecord(store, { storeName: 'floorMaps', id: mapId, body: { data: map }, user });
    for (const row of rows) {
      putRecord(store, { storeName: 'floorStations', id: row.id, body: { data: row.data }, user });
    }

    const offMap = rows.filter((row) => !row.data.boxId).length;
    console.log(`Imported floor map "${name}" (${map.width} x ${map.height}), record ${mapId}.`);
    console.log(
      `  ${map.boxes.length} boxes, ${map.corridors.length} corridors, ${map.fills.length} floor patches.`
    );
    console.log(`  ${rows.length} stations: ${rows.length - offMap} placed, ${offMap} off-map.`);
    console.log(`  ${linked} station(s) auto-linked to a machine by code.`);
    if (unlinked.length > 0) {
      console.log(`  ${unlinked.length} station(s) without a machine link: ${unlinked.join(', ')}.`);
    }
    if (existing !== undefined) {
      console.log(`  Replaced the existing map and removed its ${removedStations} station(s).`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/** Recorded backup row for `name` in the given database file, or null. */
function recordedBackup(dbFile, name) {
  let db = null;
  try {
    db = new DatabaseSync(dbFile);
  } catch {
    return null;
  }
  try {
    if (!isValidBackupName(db, name)) return null;
    return db.prepare('SELECT file, created_at, bytes, kind FROM backups WHERE file = ?').get(name) ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function verifySQLiteFile(file) {
  let handle;
  try {
    handle = new DatabaseSync(file);
  } catch (err) {
    throw new Error(`"${file}" is not a readable SQLite database: ${err.message}`);
  }
  try {
    handle.prepare('SELECT count(*) AS tables FROM sqlite_master').get();
  } catch (err) {
    throw new Error(`"${file}" is not a usable SQLite backup: ${err.message}`);
  } finally {
    handle.close();
  }
}

function checkpointWal(dbFile) {
  let db;
  try {
    db = new DatabaseSync(dbFile);
  } catch {
    return;
  }
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

async function cmdRestore(args) {
  let yes = false;
  const positional = [];
  for (const arg of args) {
    if (arg === '--yes') yes = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option "${arg}"`);
    else positional.push(arg);
  }
  if (positional.length !== 1) return usageError();
  const target = positional[0];
  const name = path.basename(target);
  if (!BACKUP_NAME_RE.test(name)) {
    throw new Error(`"${target}" is not a valid backup file name`);
  }
  const dataDb = path.join(DATA_DIR, 'maint.db');
  const backupsDir = path.join(DATA_DIR, 'backups');
  const source = target === name ? path.join(backupsDir, name) : target;
  if (!fs.existsSync(source)) throw new Error(`backup file not found: ${source}`);
  if (!fs.existsSync(dataDb)) {
    throw new Error(`no current database at ${dataDb}; restore needs an existing data dir`);
  }
  const recorded = recordedBackup(dataDb, name);
  if (recorded === null) {
    throw new Error(`"${name}" is not recorded in the backups table; only server-created backups can be restored`);
  }
  verifySQLiteFile(source);
  if (!yes) {
    console.log('Restore overwrites the live database. Stop the Shop Maintenance Log');
    console.log('server before restoring, then re-run with --yes to confirm:');
    console.log(`  node server/admin.js restore ${name} --yes`);
    console.log(`Current database: ${path.resolve(dataDb)}`);
    console.log(`Backup: ${path.resolve(source)} (${recorded.created_at}, ${recorded.bytes} bytes)`);
    return 1;
  }
  checkpointWal(dataDb);
  fs.mkdirSync(backupsDir, { recursive: true });
  const preRestore = path.join(backupsDir, `pre-restore-${formatBackupStamp()}.db`);
  fs.copyFileSync(dataDb, preRestore);
  fs.copyFileSync(source, dataDb);
  fs.rmSync(`${dataDb}-wal`, { force: true });
  fs.rmSync(`${dataDb}-shm`, { force: true });
  console.log(`Saved the current database as backups/${path.basename(preRestore)}`);
  console.log(`Restored "${name}" over the live database`);
  console.log('Removed stale -wal/-shm files. Start the server to use the restored data.');
  return 0;
}

async function cmdToken(args) {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    if (rest.length > 0) return usageError();
    const store = openStore(DATA_DIR);
    try {
      const tokens = store.listApiTokens();
      if (tokens.length === 0) {
        console.log('No API tokens. Create one with:');
        console.log('  node server/admin.js token create --name "Muse" --scope write');
        return 0;
      }
      const header = ['id', 'name', 'scope', 'agent', 'last used', 'revoked'];
      console.log(header.map((name) => name.padEnd(20)).join('').trimEnd());
      for (const token of tokens) {
        const cells = [
          token.id,
          token.name,
          token.scope,
          token.userId,
          token.lastUsedAt ?? 'never',
          token.revokedAt ?? 'no',
        ];
        console.log(cells.map((cell) => String(cell).padEnd(20)).join('').trimEnd());
      }
      return 0;
    } finally {
      if (typeof store.close === 'function') store.close();
    }
  }
  if (sub === 'create') {
    let name = null;
    let scope = 'read';
    let agent = null;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === '--name') name = rest[(i += 1)];
      else if (arg === '--scope') scope = rest[(i += 1)];
      else if (arg === '--agent') agent = rest[(i += 1)];
      else return usageError();
    }
    if (typeof name !== 'string' || name.trim() === '') return usageError();
    if (scope !== 'read' && scope !== 'write') {
      console.error('--scope must be "read" or "write"');
      return 1;
    }
    const store = openStore(DATA_DIR);
    try {
      const user = ensureAgentUser(store, agent === null ? {} : { username: agent });
      const { token, record } = store.createApiToken({ name: name.trim(), scope, userId: user.id });
      console.log(`Created token "${record.name}" (${record.scope}) for ${user.display_name ?? user.displayName} [${user.username}]`);
      console.log(`id:    ${record.id}`);
      console.log(`token: ${token}`);
      console.log('Copy this token now: only its hash is stored and it will not be shown again.');
      return 0;
    } finally {
      if (typeof store.close === 'function') store.close();
    }
  }
  if (sub === 'revoke') {
    if (rest.length !== 1) return usageError();
    const store = openStore(DATA_DIR);
    try {
      const row = store.revokeApiToken(rest[0]);
      if (row === null) {
        console.error(`No API token with id "${rest[0]}"`);
        return 1;
      }
      console.log(`Revoked token "${row.name}" (${row.id}) at ${row.revokedAt}`);
      return 0;
    } finally {
      if (typeof store.close === 'function') store.close();
    }
  }
  return usageError();
}

async function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case 'create-user':
      return cmdCreateUser(args);
    case 'reset-password':
      return cmdResetPassword(args);
    case 'disable-user':
      return cmdDisableUser(args);
    case 'enable-user':
      return cmdEnableUser(args);
    case 'list-users':
      return cmdListUsers(args);
    case 'token':
      return cmdToken(args);
    case 'import-v1':
      return cmdImportV1(args);
    case 'import-floor-map':
      return cmdImportFloorMap(args);
    case 'restore':
      return cmdRestore(args);
    case '--help':
    case 'help':
      console.log(USAGE);
      return 0;
    case undefined:
      return usageError();
    default:
      console.error(`Unknown command: ${command}`);
      return usageError();
  }
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`admin: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}