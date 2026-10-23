'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { AREAS as CLIENT_AREAS, storeArea as clientStoreArea } from '../permissions.js';
import {
  AI_EXCLUDED_STORES,
  buildContext,
  ensureAiAssistantUser,
} from '../server/ai.js';
import { ensureAgentUser } from '../server/apiTokens.js';
import {
  AREA_KEYS,
  AREAS,
  can,
  normalizePermissions,
  permissionsOf,
  storeArea,
} from '../server/permissions.js';
import { openStore } from '../server/store.js';
import { putRecord, validateRecordData } from '../server/records.js';
import { startServer } from '../server/server.js';
import {
  fitText,
  hitTest,
  searchStations,
  slotRects,
  snap,
  stationState,
} from '../logic-map.js';

/**
 * V5-M1 (SPEC-v5.md sections 1 and 4, the server/logic half of 5): the
 * floorMaps/floorStations stores with validation, the floorMap permission
 * area (builtin defaults, the pre-v5 role migration, agent/assistant
 * upgrades), the AI exclusion, the import-floor-map CLI and the pure map
 * helpers in logic-map.js.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const XRW = { 'X-Requested-With': 'maint-log' };
const uuid = () => crypto.randomUUID();

/** A role JSON exactly as v4 saved it: every area except floorMap. */
const v4Permissions = (overrides = {}) => ({
  serviceOrders: 'write',
  pm: 'write',
  machines: 'write',
  parts: 'write',
  purchasing: 'write',
  library: 'write',
  coworkers: 'write',
  contractors: 'write',
  contractorRates: 'write',
  statistics: 'read',
  files: 'write',
  backups: 'read',
  aiAssistant: 'write',
  settings: 'none',
  admin: 'none',
  ...overrides,
});

function setRolePermissions(store, roleId, permissions) {
  store.db
    .prepare('UPDATE roles SET permissions = ? WHERE id = ?')
    .run(JSON.stringify(permissions), roleId);
}

function rolePermissions(store, name) {
  const row = store.getRoleByName(name);
  assert.ok(row, `role "${name}" exists`);
  return JSON.parse(row.permissions);
}

// ---------------------------------------------------------------------------
// Section 1: the floorMap area (SPEC-v5.md section 1.3)
// ---------------------------------------------------------------------------

test('AREAS: floorMap sits after machines, identically in client and server', () => {
  const keys = AREAS.map((area) => area.key);
  assert.equal(keys.indexOf('machines') + 1, keys.indexOf('floorMap'));
  assert.deepEqual(
    AREAS.map((area) => [area.key, area.label]),
    CLIENT_AREAS.map((area) => [area.key, area.label]),
    'client and server copies stay identical',
  );
  assert.deepEqual(AREAS.find((area) => area.key === 'floorMap'), {
    key: 'floorMap',
    label: 'Floor map & stations',
  });

  // STORE_AREAS: both floor stores -> floorMap.
  assert.equal(storeArea('floorMaps'), 'floorMap');
  assert.equal(storeArea('floorStations'), 'floorMap');
  assert.equal(clientStoreArea('floorMaps'), 'floorMap');
  assert.equal(clientStoreArea('floorStations'), 'floorMap');

  // normalizePermissions rejects unknown areas and carries floorMap.
  assert.throws(() => normalizePermissions({ atlasing: 'read' }), /unknown permission area "atlasing"/);
  const normalized = normalizePermissions({ floorMap: 'read' });
  assert.equal(normalized.floorMap, 'read');
  assert.equal(normalized.machines, 'none');
});

test('fresh builtin roles get floorMap write/write/read', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v5m1-areas-'));
  try {
    const store = openStore(dataDir);
    try {
      const administrator = rolePermissions(store, 'Administrator');
      assert.equal(administrator.floorMap, 'write');
      const technician = rolePermissions(store, 'Technician');
      assert.equal(technician.floorMap, 'write');
      const viewer = rolePermissions(store, 'Viewer');
      assert.equal(viewer.floorMap, 'read');
      // Every AREA_KEYS entry is present in each seeded row.
      for (const name of ['Administrator', 'Technician', 'Viewer']) {
        assert.deepEqual(
          Object.keys(rolePermissions(store, name)).sort(),
          AREA_KEYS.slice().sort(),
        );
      }
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('pre-v5 role migration: builtin rows get the default, custom roles none, nothing lost', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v5m1-migrate-'));
  let store = null;
  try {
    store = openStore(dataDir);
    // A custom role from v4 days, plus admin edits: Viewer lost machines.
    const oddJob = store.createRole({ name: 'Odd Job', permissions: { parts: 'read' }, updatedBy: null });
    const adminId = store.getRoleByName('Administrator').id;
    const techId = store.getRoleByName('Technician').id;
    const viewerId = store.getRoleByName('Viewer').id;
    setRolePermissions(store, adminId, v4Permissions({ statistics: 'write', settings: 'write', admin: 'write' }));
    setRolePermissions(store, techId, v4Permissions({ contractorRates: 'none', statistics: 'write' }));
    setRolePermissions(store, viewerId, v4Permissions({ parts: 'read', machines: 'none' }));
    store.close();

    // Reopening is the v5 startup on a copy of a v4 database.
    store = openStore(dataDir);
    const administrator = rolePermissions(store, 'Administrator');
    assert.equal(administrator.floorMap, 'write', 'the missing floorMap key is added');
    assert.equal(administrator.settings, 'write', 'nothing the admin had is lost');

    const technician = rolePermissions(store, 'Technician');
    assert.equal(technician.floorMap, 'write');
    assert.equal(technician.contractorRates, 'none', 'the admin edit survives the migration');

    const viewer = rolePermissions(store, 'Viewer');
    assert.equal(viewer.floorMap, 'read');
    assert.equal(viewer.machines, 'none', 'the admin edit survives here too');

    const odd = rolePermissions(store, 'Odd Job');
    // The custom row is not rewritten; the missing key parses as none (can()).
    assert.equal(odd.floorMap, undefined);
    assert.equal(odd.parts, 'read', 'and keep what they had');

    // can() reads the upgraded rows without a sign-in.
    assert.equal(can({ store, roleId: techId }, 'floorMap', 'write'), true);
    assert.equal(can({ store, roleId: viewerId }, 'floorMap', 'read'), true);
    assert.equal(can({ store, roleId: viewerId }, 'floorMap', 'write'), false);
    assert.equal(can({ store, roleId: oddJob.id }, 'floorMap', 'read'), false);

    // One roles-history row per actually upgraded builtin role, none for custom.
    const updates = store.db
      .prepare("SELECT record_id, note FROM history WHERE store = 'roles' AND action = 'update'")
      .all();
    assert.deepEqual(
      new Set(updates.map((row) => row.record_id)),
      new Set([adminId, techId, viewerId]),
      'exactly the three builtin rows were rewritten',
    );
    for (const row of updates) {
      assert.match(row.note, /floorMap area/);
    }

    // Reopening again writes nothing more (idempotent).
    const before = store.db.prepare('SELECT permissions FROM roles ORDER BY name').all();
    store.close();
    store = openStore(dataDir);
    const after = store.db.prepare('SELECT permissions FROM roles ORDER BY name').all();
    assert.deepEqual(after, before);
  } finally {
    if (store !== null) store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Section 2: agent and assistant stay at floorMap none (SPEC-v5.md 1.3)
// ---------------------------------------------------------------------------

test('ensureAgentUser gives the Muse Agent role floorMap none (and keeps an explicit edit)', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v5m1-agent-'));
  try {
    const store = openStore(dataDir);
    try {
      const role = store.createRole({
        name: 'Muse Agent',
        permissions: v4Permissions({ parts: 'none' }),
        updatedBy: null,
      });
      const user = store.createUser({
        username: 'muse-agent',
        displayName: 'Muse Agent',
        roleId: role.id,
        passwordHash: auth.hashPassword('agent-password-1'),
      });

      const agent = ensureAgentUser(store);
      assert.equal(agent.id, user.id, 'the existing user is reused');
      assert.equal(can({ store, roleId: role.id }, 'floorMap', 'read'), false);
      assert.equal(permissionsOf(store, role.id).floorMap, 'none');
      assert.equal(can({ store, roleId: role.id }, 'machines', 'write'), true, 'the v4 keys survive');

      // An admin's explicit floorMap grant is never lowered, like every key.
      setRolePermissions(store, role.id, v4Permissions({ floorMap: 'write' }));
      ensureAgentUser(store);
      assert.equal(can({ store, roleId: role.id }, 'floorMap', 'write'), true, 'an explicit edit wins');

      // Idempotent: a second ensure changes nothing.
      const before = store.db
        .prepare('SELECT permissions, updated_at, updated_by FROM roles WHERE id = ?')
        .get(role.id);
      ensureAgentUser(store);
      const after = store.db
        .prepare('SELECT permissions, updated_at, updated_by FROM roles WHERE id = ?')
        .get(role.id);
      assert.deepEqual(after, before);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ensureAiAssistantUser gives the AI Assistant role floorMap none', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v5m1-assistant-'));
  try {
    const store = openStore(dataDir);
    try {
      const role = store.createRole({
        name: 'AI Assistant',
        permissions: v4Permissions({ aiAssistant: 'write', library: 'write' }),
        updatedBy: null,
      });
      const user = store.createUser({
        username: 'ai-assistant',
        displayName: 'AI Assistant',
        roleId: role.id,
        passwordHash: auth.hashPassword('assistant-password-1'),
      });

      const assistant = ensureAiAssistantUser(store);
      assert.equal(assistant.id, user.id, 'the existing user is reused');
      assert.equal(can({ store, roleId: role.id }, 'floorMap', 'read'), false);
      assert.equal(permissionsOf(store, role.id).floorMap, 'none');
      assert.equal(can({ store, roleId: role.id }, 'library', 'write'), true, 'the v4 keys survive');

      // Idempotent on the second call.
      const before = store.db
        .prepare('SELECT permissions, updated_at, updated_by FROM roles WHERE id = ?')
        .get(role.id);
      ensureAiAssistantUser(store);
      const after = store.db
        .prepare('SELECT permissions, updated_at, updated_by FROM roles WHERE id = ?')
        .get(role.id);
      assert.deepEqual(after, before);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Section 3: floorMaps validation (SPEC-v5.md section 1.1)
// ---------------------------------------------------------------------------

const goodMap = {
  name: 'Main floor',
  width: 1190.55,
  height: 841.89,
  boxes: [
    { id: 'b-1', x: 40, y: 200, w: 90, h: 56, slots: 4, fill: '#FFFFFF', label: 'SP row' },
    { id: 'b-2', x: 200, y: 200, w: 45.25, h: 28 },
  ],
  corridors: [{ x: 10, y: 100, w: 1170, h: 60 }],
  fills: [{ x: 500, y: 20, w: 100, h: 50, color: '#D9D9D9' }],
};

test('floorMaps: a good record validates, with the spec defaults', () => {
  const data = validateRecordData('floorMaps', goodMap, { isCreate: true });
  assert.equal(data.name, 'Main floor');
  assert.equal(data.width, 1190.55);
  assert.equal(data.height, 841.89);
  assert.equal(data.boxes.length, 2);
  assert.deepEqual(data.boxes[0], {
    id: 'b-1',
    x: 40,
    y: 200,
    w: 90,
    h: 56,
    slots: 4,
    fill: '#ffffff',
    label: 'SP row',
    fontSize: null,
  });
  assert.deepEqual(data.boxes[1], {
    id: 'b-2',
    x: 200,
    y: 200,
    w: 45.25,
    h: 28,
    slots: 1,
    fill: null,
    label: '',
    fontSize: null,
  }, 'slots defaults to 1, fill to null, label to empty, fontSize to Auto (V5-M5)');
  assert.deepEqual(data.corridors, [{ x: 10, y: 100, w: 1170, h: 60 }]);
  assert.deepEqual(data.fills, [{ x: 500, y: 20, w: 100, h: 50, color: '#d9d9d9' }]);

  const minimal = validateRecordData('floorMaps', { name: 'Loft', width: 100, height: 80 });
  assert.deepEqual(minimal.boxes, []);
  assert.deepEqual(minimal.corridors, []);
  assert.deepEqual(minimal.fills, []);
});

test('floorMaps: unknown fields are rejected at every level', () => {
  assert.throws(
    () => validateRecordData('floorMaps', { ...goodMap, author: 'x' }),
    /Unknown field "author" for store "floorMaps"/,
  );
  assert.throws(
    () => validateRecordData('floorMaps', { ...goodMap, boxes: [{ ...goodMap.boxes[0], lines: ['x'] }] }),
    /boxes\[0\] has an unknown field "lines"/,
  );
  assert.throws(
    () => validateRecordData('floorMaps', { ...goodMap, corridors: [{ ...goodMap.corridors[0], name: 'aisle' }] }),
    /corridors\[0\] has an unknown field "name"/,
  );
  assert.throws(
    () => validateRecordData('floorMaps', { ...goodMap, fills: [{ ...goodMap.fills[0], shade: 'dark' }] }),
    /fills\[0\] has an unknown field "shade"/,
  );
});

test('floorMaps: numbers are finite, in range, at most two decimals', () => {
  for (const field of ['width', 'height']) {
    assert.throws(
      () => validateRecordData('floorMaps', { ...goodMap, [field]: 9.99 }),
      new RegExp(`floorMaps\\.${field} must be between 10 and 10000`),
    );
    assert.throws(
      () => validateRecordData('floorMaps', { ...goodMap, [field]: 10001 }),
      new RegExp(`floorMaps\\.${field} must be between 10 and 10000`),
    );
  }
  const tooFar = (value) =>
    validateRecordData('floorMaps', { ...goodMap, boxes: [{ ...goodMap.boxes[0], x: value }] });
  assert.throws(() => tooFar(-10001), /floorMaps\.boxes\[0\]\.x must be between -10000 and 20000/);
  assert.throws(() => tooFar(20000.01), /floorMaps\.boxes\[0\]\.x must be between -10000 and 20000/);
  assert.throws(() => tooFar(100.005), /floorMaps\.boxes\[0\]\.x must have at most two decimals/);
  assert.throws(() => tooFar(Number.NaN), /floorMaps\.boxes\[0\]\.x must be a number/);
  assert.throws(() => tooFar(Number.POSITIVE_INFINITY), /floorMaps\.boxes\[0\]\.x must be a number/);
  // -10000 and 20000 themselves are fine.
  const edges = validateRecordData('floorMaps', {
    ...goodMap,
    boxes: [{ ...goodMap.boxes[0], x: -10000, y: 20000 }],
  });
  assert.equal(edges.boxes[0].x, -10000);
  assert.equal(edges.boxes[0].y, 20000);
});

test('floorMaps: box rules (size >= 2, slots 1-12, fill colour, label, id)', () => {
  const box = (changes) =>
    validateRecordData('floorMaps', { ...goodMap, boxes: [{ ...goodMap.boxes[0], ...changes }] }).boxes[0];
  assert.throws(() => box({ w: 1.9 }), /floorMaps\.boxes\[0\]\.w must be at least 2/);
  assert.throws(() => box({ h: 1 }), /floorMaps\.boxes\[0\]\.h must be at least 2/);
  assert.throws(() => box({ slots: 0 }), /floorMaps\.boxes\[0\]\.slots must be >= 1/);
  assert.throws(() => box({ slots: 13 }), /floorMaps\.boxes\[0\]\.slots must be <= 12/);
  assert.throws(() => box({ slots: 1.5 }), /floorMaps\.boxes\[0\]\.slots must be an integer/);
  assert.throws(() => box({ fill: '#fff' }), /floorMaps\.boxes\[0\]\.fill must be a #rrggbb colour/);
  assert.throws(() => box({ fill: 'white' }), /floorMaps\.boxes\[0\]\.fill must be a #rrggbb colour/);
  assert.equal(box({ fill: '#AABBCC' }).fill, '#aabbcc', 'colours normalise to lower case');
  assert.equal(box({ fill: null }).fill, null);
  assert.throws(() => box({ label: 'x'.repeat(61) }), /floorMaps\.boxes\[0\]\.label must be at most 60 characters/);
  assert.throws(() => box({ id: '' }), /floorMaps\.boxes\[0\]\.id must not be empty/);
  assert.throws(() => box({ id: 'x'.repeat(41) }), /floorMaps\.boxes\[0\]\.id must be at most 40 characters/);
  assert.throws(
    () => validateRecordData('floorMaps', { ...goodMap, boxes: [{ ...goodMap.boxes[0], w: undefined }] }),
    /floorMaps\.boxes\[0\]\.w must be a number/,
  );
});

test('floorMaps: limits (boxes 1500, corridors 800, fills 200) and colours', () => {
  const box = (index) => ({ id: `b-${index}`, x: 0, y: 0, w: 2, h: 2 });
  assert.throws(
    () => validateRecordData('floorMaps', { ...goodMap, boxes: Array.from({ length: 1501 }, (_, i) => box(i)) }),
    /floorMaps\.boxes must have at most 1500 entries/,
  );
  assert.ok(
    validateRecordData('floorMaps', { ...goodMap, boxes: Array.from({ length: 1500 }, (_, i) => box(i)) }),
    'exactly 1500 boxes are fine',
  );
  const rect = () => ({ x: 0, y: 0, w: 3, h: 3 });
  assert.throws(
    () => validateRecordData('floorMaps', { ...goodMap, corridors: Array.from({ length: 801 }, rect) }),
    /floorMaps\.corridors must have at most 800 entries/,
  );
  const patch = () => ({ x: 0, y: 0, w: 3, h: 3, color: '#d9d9d9' });
  assert.throws(
    () => validateRecordData('floorMaps', { ...goodMap, fills: Array.from({ length: 201 }, patch) }),
    /floorMaps\.fills must have at most 200 entries/,
  );
  assert.throws(
    () => validateRecordData('floorMaps', { ...goodMap, fills: [{ x: 0, y: 0, w: 3, h: 3 }] }),
    /floorMaps\.fills\[0\]\.color must be a #rrggbb colour/,
  );
  assert.throws(
    () => validateRecordData('floorMaps', { ...goodMap, boxes: 'nope' }),
    /floorMaps\.boxes must be an array of boxes/,
  );
});

// ---------------------------------------------------------------------------
// Section 4: floorStations validation (SPEC-v5.md section 1.2)
// ---------------------------------------------------------------------------

const goodStation = {
  mapId: uuid(),
  boxId: 'b-1',
  slot: 3,
  code: 'SP14',
  zone: 'SP MACHINES',
  name: 'Test Person',
  nameCn: '测试',
  empId: 'E-001',
  vacant: false,
  remark: 'left trimmer',
  machineId: null,
};

test('floorStations: a good record validates, missing fields get defaults', () => {
  const data = validateRecordData('floorStations', goodStation, { isCreate: true });
  assert.deepEqual(data, { ...goodStation, machineId: null });
  assert.deepEqual(validateRecordData('floorStations', { mapId: goodStation.mapId }), {
    mapId: goodStation.mapId,
    boxId: null,
    slot: 0,
    code: '',
    zone: '',
    name: '',
    nameCn: '',
    empId: '',
    vacant: false,
    remark: '',
    machineId: null,
  });
});

test('floorStations: unknown fields rejected, slot 0-11, string limits', () => {
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, phone: '416' }),
    /Unknown field "phone" for store "floorStations"/,
  );
  assert.throws(
    () => {
      const { mapId, ...withoutMap } = goodStation;
      validateRecordData('floorStations', withoutMap);
    },
    /"mapId" is required for store "floorStations"/,
  );
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, slot: 12 }),
    /floorStations\.slot must be <= 11/,
  );
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, slot: -1 }),
    /floorStations\.slot must be >= 0/,
  );
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, slot: 1.5 }),
    /floorStations\.slot must be an integer/,
  );
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, code: 'x'.repeat(41) }),
    /floorStations\.code must be at most 40 characters/,
  );
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, zone: 'x'.repeat(61) }),
    /floorStations\.zone must be at most 60 characters/,
  );
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, name: 'x'.repeat(81) }),
    /floorStations\.name must be at most 80 characters/,
  );
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, nameCn: '测'.repeat(81) }),
    /floorStations\.nameCn must be at most 80 characters/,
  );
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, empId: 'x'.repeat(21) }),
    /floorStations\.empId must be at most 20 characters/,
  );
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, remark: 'x'.repeat(201) }),
    /floorStations\.remark must be at most 200 characters/,
  );
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, vacant: 'yes' }),
    /floorStations\.vacant must be a boolean/,
  );
});

test('floorStations: boxId and machineId are strings or null, empty strings rejected', () => {
  assert.equal(validateRecordData('floorStations', { ...goodStation, boxId: null }).boxId, null);
  assert.equal(validateRecordData('floorStations', { ...goodStation, machineId: uuid() }).machineId.length, 36);
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, boxId: '' }),
    /floorStations\.boxId must not be empty/,
  );
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, machineId: '' }),
    /floorStations\.machineId must not be empty/,
  );
  assert.throws(
    () => validateRecordData('floorStations', { ...goodStation, machineId: 7 }),
    /floorStations\.machineId must be a string or null/,
  );
});

// ---------------------------------------------------------------------------
// Section 5: HTTP routes, the changes feed and role visibility
// ---------------------------------------------------------------------------

let handle;
let base;
let sid;
let adminRoleId;

function setCookies(res) {
  return res.headers.getSetCookie === undefined ? [] : res.headers.getSetCookie();
}

async function login(username, password) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ username, password }),
  });
  const cookie = setCookies(res).find((value) => value.startsWith('sid='));
  assert.ok(cookie, `login failed for ${username}`);
  return cookie.split(';')[0].slice('sid='.length);
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function sessionHeaders(session) {
  return { cookie: `sid=${session}`, ...XRW };
}

async function session(pathname, { method = 'GET', body, session: who } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...sessionHeaders(who === undefined ? sid : who),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { res, body: await readJson(res) };
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v5m1-server-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  base = handle.url;
  adminRoleId = handle.store.getRoleByName('Administrator').id;
  const anna = handle.store.createUser({
    username: 'anna',
    displayName: 'Anna Admin',
    role: 'admin',
    passwordHash: auth.hashPassword('anna-password-1'),
  });
  // One machine so the changes feed carries a visible store record too.
  putRecord(handle.store, {
    storeName: 'machines',
    id: (handle.seedMachineId = uuid()),
    body: { data: { name: 'Seed Press', type: 'pressing' } },
    user: { id: anna.id, roleId: adminRoleId },
  });
  const viewerRoleId = handle.store.getRoleByName('Viewer').id;
  handle.store.createUser({
    username: 'vera',
    displayName: 'Vera Viewer',
    roleId: viewerRoleId,
    passwordHash: auth.hashPassword('vera-password-1'),
  });
  const noFloor = handle.store.createRole({
    name: 'No Floor Map',
    permissions: { machines: 'write' },
    updatedBy: null,
  });
  handle.store.createUser({
    username: 'nia',
    displayName: 'Nia None',
    roleId: noFloor.id,
    passwordHash: auth.hashPassword('nia-password-1'),
  });
  sid = await login('anna', 'anna-password-1');
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
});

test('HTTP: an admin writes and reads both floor stores through the generic routes', async () => {
  const mapId = uuid();
  const created = await session(`/api/records/floorMaps/${mapId}`, {
    method: 'PUT',
    body: {
      data: {
        name: 'Route floor',
        width: 800,
        height: 600,
        boxes: [{ id: 'rb-1', x: 10, y: 10, w: 90, h: 56, slots: 2, fill: '#FFFF00' }],
      },
    },
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.record.store, 'floorMaps');
  assert.equal(created.body.record.version, 1);
  assert.equal(created.body.record.data.boxes[0].slots, 2);
  assert.equal(created.body.record.data.boxes[0].fill, '#ffff00');

  const stationId = uuid();
  const station = await session(`/api/records/floorStations/${stationId}`, {
    method: 'PUT',
    body: {
      data: { mapId, boxId: 'rb-1', slot: 1, code: 'RT-2', name: 'Route Person', empId: 'E-9' },
    },
  });
  assert.equal(station.res.status, 200, JSON.stringify(station.body));
  assert.equal(station.body.record.store, 'floorStations');
  assert.equal(station.body.record.data.mapId, mapId);

  const feed = await session('/api/changes?since=0&limit=1000');
  assert.equal(feed.res.status, 200);
  assert.ok(feed.body.records.some((record) => record.store === 'floorMaps' && record.id === mapId));
  assert.ok(feed.body.records.some((record) => record.store === 'floorStations' && record.id === stationId));

  const history = await session(`/api/history/floorStations/${stationId}`);
  assert.equal(history.res.status, 200);
  assert.equal(history.body[history.body.length - 1].action, 'create');

  // Validation errors come back flat, as everywhere.
  const badPut = await session(`/api/records/floorStations/${uuid()}`, {
    method: 'PUT',
    body: { data: { mapId, slot: 99 } },
  });
  assert.equal(badPut.res.status, 400);
  assert.equal(badPut.body.error, 'bad_request');
  assert.match(badPut.body.message, /slot must be <= 11/);
});

test('HTTP: the builtin Viewer reads both stores but cannot write them', async () => {
  const veraSid = await login('vera', 'vera-password-1');
  const feed = await session('/api/changes?since=0&limit=1000', { session: veraSid });
  assert.equal(feed.res.status, 200);
  assert.ok(
    feed.body.records.some((record) => record.store === 'floorMaps'),
    'Viewer (floorMap read) sees the map records',
  );
  assert.ok(feed.body.records.some((record) => record.store === 'floorStations'));
  const mapId = feed.body.records.find((record) => record.store === 'floorMaps').id;
  const history = await session(`/api/history/floorMaps/${mapId}`, { session: veraSid });
  assert.equal(history.res.status, 200);
  const put = await session(`/api/records/floorMaps/${uuid()}`, {
    method: 'PUT',
    session: veraSid,
    body: { data: { name: 'Nope', width: 100, height: 100 } },
  });
  assert.equal(put.res.status, 403, 'Viewer has floorMap read only');
  assert.equal(put.body.error, 'forbidden');
});

test('HTTP: a role without floorMap gets neither store in feed, history or writes', async () => {
  const niaSid = await login('nia', 'nia-password-1');
  const feed = await session('/api/changes?since=0&limit=1000', { session: niaSid });
  assert.equal(feed.res.status, 200);
  assert.equal(
    feed.body.records.some((record) => record.store === 'floorMaps' || record.store === 'floorStations'),
    false,
    'stores the role cannot read are hidden entirely',
  );
  assert.ok(
    feed.body.records.some((record) => record.store === 'machines'),
    'the visible stores are unaffected',
  );
  const anyMap = await session('/api/changes?since=0&limit=1000');
  const mapId = anyMap.body.records.find((record) => record.store === 'floorMaps').id;
  const history = await session(`/api/history/floorMaps/${mapId}`, { session: niaSid });
  assert.equal(history.res.status, 403);
  assert.equal(history.body.error, 'forbidden');
  const put = await session(`/api/records/floorStations/${uuid()}`, {
    method: 'PUT',
    session: niaSid,
    body: { data: { mapId } },
  });
  assert.equal(put.res.status, 403);
});

// ---------------------------------------------------------------------------
// Section 6: the AI context never contains the roster (SPEC-v5.md 1.3)
// ---------------------------------------------------------------------------

test('AI: floorMaps/floorStations are excluded stores; the context never carries a station', () => {
  assert.deepEqual(AI_EXCLUDED_STORES, ['floorMaps', 'floorStations']);

  const anna = handle.store.getUserByUsername('anna');
  const user = { id: anna.id, roleId: adminRoleId };
  assert.equal(can({ ...user, store: handle.store }, 'floorMap', 'read'), true, 'Anna may read the map');

  // Down machine + open order for the machinery half of the snapshot.
  const machineId = uuid();
  putRecord(handle.store, {
    storeName: 'machines',
    id: machineId,
    body: { data: { name: 'Pac Press 7', type: 'pressing', status: 'down' } },
    user,
  });

  // Two stations, fixture names only (never real roster data).
  const mapId = uuid();
  putRecord(handle.store, {
    storeName: 'floorMaps',
    id: mapId,
    body: { data: { name: 'AI floor', width: 800, height: 600 } },
    user,
  });
  putRecord(handle.store, {
    storeName: 'floorStations',
    id: uuid(),
    body: {
      data: {
        mapId,
        boxId: null,
        slot: 0,
        code: 'ZZQ-9',
        zone: 'TEST ZONE',
        name: 'Unique Roster Personzz',
        nameCn: '测试员工',
        empId: 'EMP-ZZQ',
        machineId,
        remark: 'secret remark',
      },
    },
    user,
  });
  putRecord(handle.store, {
    storeName: 'floorStations',
    id: uuid(),
    body: { data: { mapId, code: 'PAC 1', name: 'Another Roster Personzz' } },
    user,
  });

  // The question names the station code, the staff name and the employee id.
  const question =
    'Who sits at station ZZQ-9? Is Unique Roster Personzz on shift today, emp EMP-ZZQ? What about 测试员工 or PAC 1?';
  const context = buildContext(handle.store, user, question);
  assert.ok(context.length > 0, 'the snapshot itself is not empty');
  assert.ok(context.includes('Pac Press 7'), 'the machine half still works');
  for (const secret of [
    'Unique Roster Personzz',
    'Another Roster Personzz',
    'ZZQ-9',
    'EMP-ZZQ',
    '测试员工',
    'PAC 1',
    'secret remark',
    'TEST ZONE',
  ]) {
    assert.ok(!context.includes(secret), `"${secret}" never reaches the AI context`);
  }
});

// ---------------------------------------------------------------------------
// Section 7: import-floor-map (SPEC-v5.md section 4), as a real CLI run
// ---------------------------------------------------------------------------

const ADMIN_JS = path.join(REPO, 'server', 'admin.js');

function runImport(dataDir, args) {
  return spawnSync(process.execPath, [ADMIN_JS, 'import-floor-map', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dataDir },
  });
}

/** Small fixture files, written by the test (never real roster data). */
function writeImportFixtures(dir) {
  const layout = {
    page: { w: 1190.55, h: 841.89 },
    corridors: [[10, 100, 1170.55, 60.25]],
    fills: [[500, 20, 100, 50, '#D9D9D9']],
    boxes: [
      {
        id: 'b-sp',
        x: 40.5,
        y: 200,
        w: 90,
        h: 56,
        fill: '#FFFFFF',
        slots: [
          { lines: [{ text: 'SECRET ROSTER LINE never store this' }] },
          { lines: [] },
        ],
      },
      { id: 'b-pac', x: 200, y: 200, w: 45.25, h: 28 },
    ],
  };
  const stations = [
    {
      id: 'st-a',
      box: 'b-sp',
      slot: 0,
      zone: 'SP MACHINES',
      code: 'Sp 14',
      en: 'Unique Roster Personzz',
      cn: '测试',
      emp: 'E-001',
      vac: false,
      rem: 'left trimmer',
      phone: '416-555-0100',
      emg: 'Bob Backup',
      join: '2024-01-01',
      shift: 'day',
    },
    {
      id: 'st-b',
      box: 'b-sp',
      slot: 1,
      zone: 'SP MACHINES',
      code: 'SP 15',
      en: 'Second Personzz',
      cn: '',
      emp: 'E-002',
      vac: true,
      rem: '',
      join: '2023-05-05',
    },
    {
      id: 'st-c',
      box: null, // the real export marks off-map stations with box and slot null
      slot: null,
      zone: 'PAC',
      code: 'PAC 1',
      en: 'Off Map Personzz',
      cn: '',
      emp: '',
      vac: true,
      rem: '',
    },
  ];
  const layoutFile = path.join(dir, 'layout.json');
  const stationsFile = path.join(dir, 'stations.json');
  fs.writeFileSync(layoutFile, JSON.stringify(layout));
  fs.writeFileSync(stationsFile, JSON.stringify(stations));
  return { layoutFile, stationsFile };
}

test('import-floor-map: geometry and roster import, lines ignored, extras dropped, off-map, auto-link', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v5m1-import-'));
  const fix = writeImportFixtures(dataDir);
  try {
    // A machine whose name matches station "Sp 14" case/space/dash-insensitively.
    let machineId;
    {
      const store = openStore(dataDir);
      try {
        const admin = store.createUser({
          username: 'importer',
          displayName: 'Importer',
          role: 'admin',
          passwordHash: auth.hashPassword('importer-password-1'),
        });
        const result = putRecord(store, {
          storeName: 'machines',
          id: (machineId = uuid()),
          body: { data: { name: 'SP-14', type: 'single-needle' } },
          user: { id: admin.id, roleId: store.getRoleByName('Administrator').id },
        });
        assert.equal(result.record.version, 1);
      } finally {
        store.close();
      }
    }

    const run = runImport(dataDir, [fix.layoutFile, fix.stationsFile, '--name', 'Test Floor']);
    assert.equal(run.status, 0, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
    assert.match(run.stdout, /Imported floor map "Test Floor" \(1190\.55 x 841\.89\)/);
    assert.match(run.stdout, /2 boxes, 1 corridors, 1 floor patches/);
    assert.match(run.stdout, /3 stations: 2 placed, 1 off-map/);
    assert.match(run.stdout, /1 station\(s\) auto-linked/);
    assert.match(run.stdout, /SP 15, PAC 1/);
    // Counts and codes only — never staff names, never slot lines.
    for (const secret of [
      'Unique Roster Personzz',
      'Second Personzz',
      'Off Map Personzz',
      'SECRET ROSTER LINE',
      '测试',
      'left trimmer',
    ]) {
      assert.ok(!run.stdout.includes(secret) && !run.stderr.includes(secret), `"${secret}" is never printed`);
    }

    const store = openStore(dataDir);
    try {
      const maps = store.listRecords('floorMaps');
      assert.equal(maps.length, 1);
      const map = maps[0];
      assert.equal(map.data.name, 'Test Floor');
      assert.equal(map.data.width, 1190.55);
      assert.deepEqual(
        map.data.boxes,
        [
          { id: 'b-sp', x: 40.5, y: 200, w: 90, h: 56, slots: 2, fill: '#ffffff', label: '', fontSize: null },
          { id: 'b-pac', x: 200, y: 200, w: 45.25, h: 28, slots: 1, fill: null, label: '', fontSize: null },
        ],
        'slots come from box.slots.length; lines never reach the record; boxes stay Auto unless set',
      );
      assert.deepEqual(map.data.corridors, [{ x: 10, y: 100, w: 1170.55, h: 60.25 }]);
      assert.deepEqual(map.data.fills, [{ x: 500, y: 20, w: 100, h: 50, color: '#d9d9d9' }]);
      const raw = JSON.stringify(map);
      assert.ok(!raw.includes('lines') && !raw.includes('SECRET'), 'the map record carries no roster text');

      const stations = store.listRecords('floorStations');
      assert.equal(stations.length, 3);
      const byCode = new Map(stations.map((row) => [row.data.code, row]));
      const a = byCode.get('Sp 14');
      assert.equal(a.data.boxId, 'b-sp');
      assert.equal(a.data.machineId, machineId, '"Sp 14" auto-links to machine "SP-14"');
      assert.equal(a.data.name, 'Unique Roster Personzz');
      assert.equal(a.data.empId, 'E-001');
      assert.equal(a.data.vacant, false);
      assert.equal(a.data.remark, 'left trimmer');
      for (const field of ['phone', 'emg', 'join', 'shift']) {
        assert.equal(a.data[field], undefined, `the extra field "${field}" is dropped`);
      }
      const b = byCode.get('SP 15');
      assert.equal(b.data.machineId, null);
      assert.equal(b.data.slot, 1);
      const c = byCode.get('PAC 1');
      assert.equal(c.data.boxId, null, 'a station whose box does not exist becomes off-map');
      assert.equal(c.data.machineId, null);
      for (const row of stations) {
        assert.equal(row.data.mapId, map.id, 'every station points at the map record');
        assert.match(row.id, /^[0-9a-f-]{36}$/, 'roster ids get fresh UUID record ids');
      }

      // History rows exist, attributed to the disabled System CLI user.
      const system = store.getUserByUsername('system');
      assert.ok(system, 'the import runs as the System bot user');
      assert.equal(Number(system.disabled), 1, 'nobody can sign in as it');
      const creates = store.db
        .prepare(
          "SELECT store, action, user_id FROM history WHERE store IN ('floorMaps','floorStations') AND action = 'create'",
        )
        .all();
      assert.equal(creates.length, 4, 'one create row for the map and each station');
      assert.ok(creates.every((row) => row.user_id === system.id));
    } finally {
      store.close();
    }

    // A second import with the same name refuses without --replace.
    const refused = runImport(dataDir, [fix.layoutFile, fix.stationsFile, '--name', 'Test Floor']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /already exists/);
    assert.match(refused.stderr, /--replace/);

    // With --replace it imports over the existing map and its stations.
    const replaced = runImport(dataDir, [fix.layoutFile, fix.stationsFile, '--name', 'Test Floor', '--replace']);
    assert.equal(replaced.status, 0, `stderr: ${replaced.stderr}`);
    assert.match(replaced.stdout, /Replaced the existing map and removed its 3 station\(s\)/);

    const replacedStore = openStore(dataDir);
    try {
      assert.equal(replacedStore.listRecords('floorMaps').length, 1, 'still exactly one live map');
      assert.equal(replacedStore.listRecords('floorStations').length, 3);
      const rows = replacedStore.db
        .prepare("SELECT deleted, COUNT(*) AS n FROM records WHERE store = 'floorStations' GROUP BY deleted")
        .all();
      assert.deepEqual(
        rows.map((row) => [Number(row.deleted), Number(row.n)]),
        [[0, 3], [1, 3]],
        'the old stations are tombstoned, the new ones live',
      );
      const deletes = replacedStore.db
        .prepare("SELECT COUNT(*) AS n FROM history WHERE store = 'floorStations' AND action = 'delete'")
        .get();
      assert.equal(Number(deletes.n), 3, 'each removed station has its delete history row');
    } finally {
      replacedStore.close();
    }

    // A different name adds a second map without touching the first.
    const second = runImport(dataDir, [fix.layoutFile, fix.stationsFile, '--name', 'Second Floor']);
    assert.equal(second.status, 0, `stderr: ${second.stderr}`);
    const secondStore = openStore(dataDir);
    try {
      const names = secondStore.listRecords('floorMaps').map((row) => row.data.name).sort();
      assert.deepEqual(names, ['Second Floor', 'Test Floor']);
    } finally {
      secondStore.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('import-floor-map: usage and validation failures are clean', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v5m1-import-bad-'));
  try {
    const missing = runImport(dataDir, []);
    assert.equal(missing.status, 1, 'two files are required');

    const fix = writeImportFixtures(dataDir);
    const badLayout = { page: { w: 5, h: 5 } };
    fs.writeFileSync(fix.layoutFile, JSON.stringify(badLayout));
    const run = runImport(dataDir, [fix.layoutFile, fix.stationsFile, '--name', 'Bad Floor']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /width must be between 10 and 10000/, 'the store rules still apply');
    const store = openStore(dataDir);
    try {
      assert.equal(store.listRecords('floorMaps').length, 0, 'nothing was written');
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Section 8: logic-map.js (SPEC-v5.md section 5 "Logic")
// ---------------------------------------------------------------------------

test('slotRects: equal parts stacked top to bottom, clamped to 1-12', () => {
  const rects = slotRects({ x: 10, y: 20, w: 45, h: 28, slots: 4 });
  assert.equal(rects.length, 4);
  assert.deepEqual(rects[0], { x: 10, y: 20, w: 45, h: 7, slot: 0 });
  assert.deepEqual(rects[3], { x: 10, y: 41, w: 45, h: 7, slot: 3 });
  const total = rects.reduce((sum, rect) => sum + rect.h, 0);
  assert.equal(Math.round(total * 1e9) / 1e9, 28, 'the parts cover the box exactly');

  assert.deepEqual(slotRects({ x: 0, y: 0, w: 10, h: 10 }), [
    { x: 0, y: 0, w: 10, h: 10, slot: 0 },
  ], 'no slots field means one full-size slot');
  assert.equal(slotRects({ x: 0, y: 0, w: 10, h: 10, slots: 13 }).length, 12, 'clamped to 12');
  assert.deepEqual(slotRects(null), []);
  assert.deepEqual(slotRects({ x: 'x', y: 0, w: 10, h: 10 }), [
    { x: 0, y: 0, w: 10, h: 10, slot: 0 },
  ], 'junk coordinates degrade to zeros, never a throw');
});

test('stationState: down, open orders count, PM overdue, paused and unlinked', () => {
  const today = '2026-10-22';
  const machines = [
    { id: 'm1', name: 'Linked', status: 'down' },
    { id: 'm2', name: 'Stored', status: 'in-storage' },
    { id: 'm3', name: 'Running', status: 'running' },
  ];
  const workOrders = [
    { id: 'o1', machineId: 'm1', status: 'open' },
    { id: 'o2', machineId: 'm1', status: 'in-progress' },
    { id: 'o3', machineId: 'm1', status: 'done' },
    { id: 'o4', machineId: 'm3', status: 'open' },
  ];
  const pmTasks = [
    { id: 'pm1', machineId: 'm1', active: true, lastDoneAt: '2026-09-20', intervalDays: 10 },
    { id: 'pm2', machineId: 'm3', active: true, lastDoneAt: '2026-10-15', intervalDays: 10 },
    { id: 'pm3', machineId: 'm1', active: false, lastDoneAt: '2026-09-01', intervalDays: 10 },
  ];
  const state = { machines, workOrders, pmTasks, today };
  assert.deepEqual(stationState({ machineId: 'm1' }, state), {
    down: true,
    openOrders: 2,
    pmOverdue: true,
  }, 'down machine, both open orders, PM 12 days overdue');
  assert.deepEqual(stationState({ machineId: 'm3' }, state), {
    down: false,
    openOrders: 1,
    pmOverdue: false,
  }, 'PM due in future is not overdue');
  assert.deepEqual(stationState({ machineId: 'm2' }, state), {
    down: false,
    openOrders: 0,
    pmOverdue: false,
  }, 'in-storage machines pause their PM');
  assert.deepEqual(stationState({ machineId: null }, state), {
    down: false,
    openOrders: 0,
    pmOverdue: false,
  }, 'unlinked stations are plain');
  assert.deepEqual(stationState(null, state), { down: false, openOrders: 0, pmOverdue: false });
  // A PM due today is not overdue (due < today only).
  assert.equal(
    stationState({ machineId: 'm3' }, { machines, workOrders, pmTasks: [{ machineId: 'm3', active: true, lastDoneAt: '2026-10-12', intervalDays: 10 }], today }).pmOverdue,
    false,
  );
  // No lastDoneAt: the task is due today, not overdue (logic.js pmDueDate).
  assert.equal(
    stationState({ machineId: 'm3' }, { machines, workOrders, pmTasks: [{ machineId: 'm3', active: true }], today }).pmOverdue,
    false,
  );
});

test('searchStations: code, staff names, employee id and machine name; empty query', () => {
  const machines = [{ id: 'm1', name: 'Pac Press 7' }];
  const stations = [
    { id: 's1', code: 'SP 14', name: 'Alpha Person', nameCn: '甲', empId: 'E-1', machineId: 'm1' },
    { id: 's2', code: 'PAC 1', name: 'Beta Person', nameCn: '乙', empId: 'E-2', machineId: null },
    { id: 's3', code: 'ZZTOP', name: '', nameCn: '', empId: '', machineId: null },
  ];
  assert.deepEqual(searchStations(stations, '', machines).map((s) => s.id), ['s1', 's2', 's3']);
  assert.deepEqual(searchStations(stations, 'pac 1', machines).map((s) => s.id), ['s2'], 'code match');
  assert.deepEqual(searchStations(stations, 'e-2', machines).map((s) => s.id), ['s2'], 'employee id, case-insensitive');
  assert.deepEqual(searchStations(stations, 'person', machines).map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(searchStations(stations, '甲', machines).map((s) => s.id), ['s1'], 'Chinese name');
  assert.deepEqual(searchStations(stations, 'press', machines).map((s) => s.id), ['s1'], 'linked machine name');
  assert.deepEqual(searchStations(stations, 'zztop', machines).map((s) => s.id), ['s3']);
  assert.deepEqual(searchStations(stations, 'nope', machines), []);
  assert.deepEqual(searchStations(stations, '  ', machines).length, 3, 'blank query = all');
});

test('fitText: wraps, shrinks, never overflows the slot', () => {
  const LINE_HEIGHT = 1.2;
  const fitsHeight = (result, h) =>
    result.lines.length * result.fontSize * LINE_HEIGHT <= h + 1e-9 || result.lines.length === 0;

  assert.deepEqual(fitText('', 45, 14), { lines: [], fontSize: 0 });
  assert.deepEqual(fitText('   ', 45, 14), { lines: [], fontSize: 0 });
  assert.deepEqual(fitText('SP14', 0, 5), { lines: [], fontSize: 0 }, 'no width, no text');

  const one = fitText('SP14', 45, 14);
  assert.deepEqual(one.lines, ['SP14']);
  assert.ok(one.fontSize >= 4 && one.fontSize <= 14);
  assert.ok(fitsHeight(one, 14));

  const two = fitText('Jane Smith', 45, 30);
  assert.deepEqual(two.lines, ['Jane', 'Smith'], 'a word that fits whole is never split');
  assert.ok(fitsHeight(two, 30));

  // A word longer than a line is hard-sliced, nothing is lost.
  const long = fitText('Averyveryverylongword', 45, 14);
  assert.equal(long.lines.join(''), 'Averyveryverylongword');
  assert.ok(fitsHeight(long, 14));

  // A very flat slot shrinks below the minimum instead of overflowing.
  const flat = fitText('SP14', 45, 2);
  assert.deepEqual(flat.lines, ['SP14']);
  assert.ok(flat.fontSize <= 2 / LINE_HEIGHT + 1e-9);
  assert.ok(fitsHeight(flat, 2));

  // Multi-word text capped to what fits keeps whole words where it can.
  const capped = fitText('one two three four five six seven', 45, 14);
  assert.ok(fitsHeight(capped, 14));
  assert.ok(capped.lines.length >= 1 && capped.lines.length <= 3);
});

test('snap: rounds to the grid, cleans floating dust, passes junk through', () => {
  assert.equal(snap(5), 6, 'the 2-unit grid is the default');
  assert.equal(snap(3), 4);
  assert.equal(snap(4), 4);
  assert.equal(snap(-3), -2);
  assert.equal(snap(5.9), 6);
  assert.equal(snap(2.0000000001), 2, 'floating dust is cleaned');
  assert.equal(snap(3.3, 1), 3);
  assert.equal(snap(25, 10), 30);
  assert.equal(snap(24.9, 10), 20);
  assert.equal(snap(7, 0), 8, 'a non-positive grid falls back to 2');
  assert.equal(snap('x'), 'x');
  assert.equal(snap(Number.NaN), Number.NaN);
});

test('hitTest: boxes over fills over corridors, later shapes win, null outside', () => {
  const box = { id: 'bx', x: 0, y: 0, w: 10, h: 10 };
  const earlierBox = { id: 'first', x: 0, y: 0, w: 10, h: 10 };
  const fill = { x: 0, y: 0, w: 10, h: 10, color: '#d9d9d9' };
  const corridor = { x: 0, y: 0, w: 10, h: 10 };
  const map = {
    boxes: [earlierBox, box],
    fills: [fill],
    corridors: [corridor],
  };
  assert.deepEqual(hitTest(map, 5, 5), { kind: 'box', shape: box }, 'boxes sit above patches and aisles');
  assert.deepEqual(hitTest(map, 5, 5).shape, box, 'the later box paints above the earlier one');

  const floorOnly = { boxes: [], fills: [fill], corridors: [corridor] };
  assert.deepEqual(hitTest(floorOnly, 5, 5), { kind: 'fill', shape: fill }, 'patches above aisles');

  const aisleOnly = { boxes: [], fills: [], corridors: [corridor] };
  assert.deepEqual(hitTest(aisleOnly, 5, 5), { kind: 'corridor', shape: corridor });

  assert.equal(hitTest({ boxes: [box] }, 10.001, 5), null, 'x past the right edge');
  assert.equal(hitTest({ boxes: [box] }, 5, 10.001), null, 'y past the bottom edge');
  assert.equal(hitTest({ boxes: [box] }, -0.001, 5), null);
  assert.equal(hitTest(map, Number.NaN, 5), null);
  assert.equal(hitTest(null, 5, 5), null);
  assert.equal(hitTest({ boxes: [box] }, 0, 0).kind, 'box', 'the exact top-left corner counts as inside');
});