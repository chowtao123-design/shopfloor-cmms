'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as auth from './auth.js';
import { BACKUP_NAME_RE, formatBackupStamp, isValidBackupName } from './backup.js';
import { can } from './permissions.js';
import { importV1 } from './records.js';
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
  node server/admin.js restore <backup-file> [--yes]

Accounts live in the SQLite database under DATA_DIR (default: ./data).
Passwords are read hidden from the terminal, or as one line from stdin
when --password-stdin is given. import-v1 reads a v1 JSON backup and
attributes the imported records to the given admin user.

create-user assigns the Administrator role with --admin, the named role
with --role "<Role name>" (see list-users), and the Technician role
otherwise. restore copies a backup from DATA_DIR/backups over the live
database. Stop the Shop Maintenance Log server first; restore asks for
--yes to confirm. The current database is kept as backups/pre-restore-<timestamp>.db.`;

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