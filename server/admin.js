'use strict';

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import * as auth from './auth.js';
import { importV1 } from './records.js';
import { openStore } from './store.js';

const DATA_DIR =
  process.env.DATA_DIR === undefined || process.env.DATA_DIR === '' ? './data' : process.env.DATA_DIR;

const USAGE = `Usage:
  node server/admin.js create-user [--admin] <username> "<Display Name>" [--password-stdin]
  node server/admin.js reset-password <username> [--password-stdin]
  node server/admin.js disable-user <username>
  node server/admin.js enable-user <username>
  node server/admin.js list-users
  node server/admin.js import-v1 <file> --as <username>

Accounts live in the SQLite database under DATA_DIR (default: ./data).
Passwords are read hidden from the terminal, or as one line from stdin
when --password-stdin is given. import-v1 reads a v1 JSON backup and
attributes the imported records to the given admin user.`;

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
    const onData = (chunk) => {
      if (chunk === '\r' || chunk === '\n') {
        finish(value);
      } else if (chunk === '\x03') {
        finish(null);
      } else if (chunk === '\x7f') {
        value = value.slice(0, -1);
      } else {
        value += chunk;
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
  const positional = [];
  for (const arg of args) {
    if (arg === '--admin') admin = true;
    else if (arg === '--password-stdin') passwordStdin = true;
    else positional.push(arg);
  }
  if (positional.length !== 2) return usageError();
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
    const user = store.createUser({
      username: username.value,
      displayName: displayName.value,
      role: admin ? 'admin' : 'tech',
      passwordHash: auth.hashPassword(password),
    });
    console.log(`Created ${user.role} "${user.username}" (${user.display_name})`);
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
        user.role,
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
    if (user.role !== 'admin') {
      throw new Error(`user "${asUsername}" is not an admin; only admins can import v1 data`);
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
    case 'import-v1':
      return cmdImportV1(args);
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

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`admin: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}