'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { AREAS as CLIENT_AREAS, storeArea as clientStoreArea } from '../permissions.js';
import { AREA_KEYS, AREAS, can, normalizePermissions, storeArea } from '../server/permissions.js';
import { openStore } from '../server/store.js';
import { startServer } from '../server/server.js';
import { ensureAgentUser } from '../server/apiTokens.js';
import { ensureAiAssistantUser } from '../server/ai.js';
import { putRecord, validateRecordData } from '../server/records.js';
import { formatMoney, formatRequestNumber, requestTotals } from '../logic.js';

/**
 * V4-M1 (SPEC-v4.md sections 1, 2, 3.5): the purchaseRequests store with PR
 * numbering, the purchasing/library permission areas (builtin defaults, the
 * pre-v4 role migration, agent/assistant role key upgrades), money math in
 * integer cents, the OpenAPI schema, and the Muse write flow through the
 * public record routes.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const XRW = { 'X-Requested-With': 'maint-log' };
const uuid = () => crypto.randomUUID();

/** A role JSON exactly as v3 saved it: the 13 v3 areas, no purchasing/library. */
const v3Permissions = (overrides = {}) => ({
  serviceOrders: 'write',
  pm: 'write',
  machines: 'write',
  parts: 'write',
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
// Section 1: the purchasing and library areas (SPEC-v4.md section 1)
// ---------------------------------------------------------------------------

test('AREAS: purchasing and library sit after parts, identically in client and server', () => {
  const keys = AREAS.map((area) => area.key);
  assert.equal(keys.indexOf('parts') + 1, keys.indexOf('purchasing'));
  assert.equal(keys.indexOf('purchasing') + 1, keys.indexOf('library'));
  assert.deepEqual(
    AREAS.map((area) => [area.key, area.label]),
    CLIENT_AREAS.map((area) => [area.key, area.label]),
    'client and server copies stay identical',
  );
  assert.deepEqual(
    AREAS.find((area) => area.key === 'purchasing'),
    { key: 'purchasing', label: 'Parts requests' },
  );
  assert.deepEqual(
    AREAS.find((area) => area.key === 'library'),
    { key: 'library', label: 'Library (manuals & repair methods)' },
  );

  // STORE_AREAS: purchaseRequests -> purchasing, libraryItems -> library.
  assert.equal(storeArea('purchaseRequests'), 'purchasing');
  assert.equal(storeArea('libraryItems'), 'library');
  assert.equal(clientStoreArea('purchaseRequests'), 'purchasing');
  assert.equal(clientStoreArea('libraryItems'), 'library');

  // normalizePermissions rejects unknown areas and accepts the new ones.
  assert.throws(() => normalizePermissions({ sketching: 'read' }), /unknown permission area "sketching"/);
  const normalized = normalizePermissions({ purchasing: 'read', library: 'write' });
  assert.equal(normalized.purchasing, 'read');
  assert.equal(normalized.library, 'write');
  assert.equal(normalized.parts, 'none');
});

test('fresh builtin roles get purchasing write/write/read and library write/write/read', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v4m1-areas-'));
  try {
    const store = openStore(dataDir);
    try {
      const administrator = rolePermissions(store, 'Administrator');
      assert.equal(administrator.purchasing, 'write');
      assert.equal(administrator.library, 'write');
      const technician = rolePermissions(store, 'Technician');
      assert.equal(technician.purchasing, 'write');
      assert.equal(technician.library, 'write');
      const viewer = rolePermissions(store, 'Viewer');
      assert.equal(viewer.purchasing, 'read');
      assert.equal(viewer.library, 'read');
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

test('pre-v4 role migration: builtin rows get the builtin default, custom roles none, nothing lost', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v4m1-migrate-'));
  let store = null;
  try {
    store = openStore(dataDir);
    // A custom role from v3 days, plus admin edits: Technician lost
    // contractorRates, Viewer only reads.
    const oddJob = store.createRole({ name: 'Odd Job', permissions: { parts: 'read' }, updatedBy: null });
    const adminId = store.getRoleByName('Administrator').id;
    const techId = store.getRoleByName('Technician').id;
    const viewerId = store.getRoleByName('Viewer').id;
    setRolePermissions(
      store,
      adminId,
      v3Permissions({ statistics: 'write', settings: 'write', admin: 'write' })
    );
    setRolePermissions(store, techId, v3Permissions({ contractorRates: 'none', statistics: 'write' }));
    setRolePermissions(store, viewerId, v3Permissions({ parts: 'read', statistics: 'read' }));
    store.close();

    // Reopening is the v4 startup on a copy of a v3 database.
    store = openStore(dataDir);
    const administrator = rolePermissions(store, 'Administrator');
    assert.equal(administrator.purchasing, 'write', 'the missing purchasing key is added');
    assert.equal(administrator.library, 'write');
    assert.equal(administrator.settings, 'write', 'nothing the admin had is lost');
    assert.equal(administrator.admin, 'write');

    const technician = rolePermissions(store, 'Technician');
    assert.equal(technician.purchasing, 'write');
    assert.equal(technician.library, 'write');
    assert.equal(technician.contractorRates, 'none', 'the admin edit survives the migration');
    assert.equal(technician.parts, 'write');

    const viewer = rolePermissions(store, 'Viewer');
    assert.equal(viewer.purchasing, 'read');
    assert.equal(viewer.library, 'read');
    assert.equal(viewer.serviceOrders, 'write');

    const odd = rolePermissions(store, 'Odd Job');
    // The custom row is not rewritten; the missing keys parse as none (can() above).
    assert.equal(odd.purchasing, undefined);
    assert.equal(odd.library, undefined);
    assert.equal(odd.parts, 'read', 'and keep what they had');

    // can() reads the upgraded rows without a sign-in.
    assert.equal(can({ store, roleId: techId }, 'purchasing', 'write'), true);
    assert.equal(can({ store, roleId: oddJob.id }, 'purchasing', 'read'), false);
    assert.equal(can({ store, roleId: oddJob.id }, 'library', 'write'), false);

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
      assert.match(row.note, /purchasing and library/);
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
// Section 2: agent and assistant role key upgrades (SPEC-v4.md section 1)
// ---------------------------------------------------------------------------

test('ensureAgentUser adds the v4 keys to an existing Muse Agent role and never lowers one', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v4m1-agent-'));
  try {
    const store = openStore(dataDir);
    try {
      // The live-DB shape: role and user exist from v3 days. An admin has
      // since lowered parts to none and raised library above the default.
      const role = store.createRole({
        name: 'Muse Agent',
        permissions: v3Permissions({ parts: 'none', library: 'write' }),
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

      const permissions = rolePermissions(store, 'Muse Agent');
      assert.equal(permissions.purchasing, 'write', 'the missing purchasing key is added');
      assert.equal(permissions.library, 'write', 'an existing key is never lowered to the default read');
      assert.equal(permissions.parts, 'none', 'the admin edit is never raised back');
      assert.equal(permissions.serviceOrders, 'write', 'existing keys are kept');

      // And the agent really can write purchaseRequests through can().
      assert.equal(can({ store, roleId: role.id }, 'purchasing', 'write'), true);
      assert.equal(can({ store, roleId: role.id }, 'library', 'write'), true);
      assert.equal(can({ store, roleId: role.id }, 'parts', 'read'), false);

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

test('ensureAiAssistantUser adds purchasing read / library write to an existing role', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v4m1-assistant-'));
  try {
    const store = openStore(dataDir);
    try {
      // An admin already set purchasing to write (above the read default).
      const role = store.createRole({
        name: 'AI Assistant',
        permissions: v3Permissions({ aiAssistant: 'write', purchasing: 'write' }),
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

      const permissions = rolePermissions(store, 'AI Assistant');
      assert.equal(permissions.purchasing, 'write', 'an existing key is never lowered to the read default');
      assert.equal(permissions.library, 'write', 'the missing library key is added');
      assert.equal(permissions.aiAssistant, 'write', 'the v3 keys survive');
      assert.equal(permissions.serviceOrders, 'write');

      assert.equal(can({ store, roleId: role.id }, 'purchasing', 'read'), true);
      assert.equal(can({ store, roleId: role.id }, 'purchasing', 'write'), true);
      assert.equal(can({ store, roleId: role.id }, 'library', 'write'), true);

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
// Section 3: purchaseRequests validation (SPEC-v4.md section 2)
// ---------------------------------------------------------------------------

const goodRequest = {
  title: 'Juki needles + belts, Nov',
  supplier: 'Sew Parts Co',
  neededBy: '2026-11-05',
  requestedBy: 'Dana',
  notes: 'For the November service round',
  lines: [
    {
      id: 'line-1',
      description: 'Needle DBx1 #14',
      qty: 100,
      unit: 'pcs',
      unitPrice: 0.45,
      partNumber: 'DBx1#14',
      supplier: 'Sew Parts Co',
      machineId: 'machine-1',
      workOrderId: 'order-1',
      link: 'https://example.com/needle-db-x1',
      note: 'check the package size',
    },
    { description: 'Belt', qty: 2.5, unitPrice: 12 },
    { description: 'Oil, price unknown', qty: 1, unitPrice: null },
  ],
};

test('purchaseRequests: a good record validates with the spec defaults', () => {
  const data = validateRecordData('purchaseRequests', goodRequest, { isCreate: true });
  assert.equal(data.title, 'Juki needles + belts, Nov');
  assert.equal(data.status, 'draft');
  assert.equal(data.hstRate, 13);
  assert.equal(data.supplier, 'Sew Parts Co');
  assert.equal(data.sentAt, null);
  assert.equal(data.receivedAt, null);
  assert.equal(data.lines.length, 3);
  assert.equal(data.lines[0].qty, 100);
  assert.equal(data.lines[0].link, 'https://example.com/needle-db-x1');
  assert.equal(data.lines[1].unit, 'pcs', 'unit defaults to "pcs"');
  assert.equal(data.lines[1].unitPrice, 12);
  assert.equal(data.lines[2].unitPrice, null, 'an unpriced line stays null');
  assert.equal(data.number, undefined, 'number is server-owned and absent from data');
  assert.equal(data.version, undefined, 'record metadata is ignored inside data');

  // The client cannot smuggle a number in.
  const smuggled = validateRecordData('purchaseRequests', { ...goodRequest, number: 999 }, {
    isCreate: true,
  });
  assert.equal(smuggled.number, undefined);
});

test('purchaseRequests: every field can fail on its own', () => {
  // A marker to drop a key entirely (JSON cannot carry undefined).
  const DELETE = Symbol('delete key');
  const line = (overrides = {}) => ({ description: 'Item', qty: 1, ...overrides });
  const cases = [
    ['title missing', { title: DELETE }, /"title" is required/],
    ['title empty', { title: '   ' }, /title must not be empty/],
    ['title too long', { title: 'T'.repeat(121) }, /at most 120 characters/],
    ['status unknown', { status: 'shipped' }, /status must be one of/],
    ['status boundary', { status: 'cancelled' }, null],
    ['supplier too long', { supplier: 'S'.repeat(121) }, /at most 120 characters/],
    ['neededBy not a date', { neededBy: '2026-13-45' }, /neededBy must be an ISO date/],
    ['neededBy null allowed', { neededBy: null }, null],
    ['requestedBy too long', { requestedBy: 'R'.repeat(81) }, /at most 80 characters/],
    ['hstRate negative', { hstRate: -1 }, /at least 0/],
    ['hstRate too high', { hstRate: 30.01 }, /at most 30/],
    ['hstRate three decimals', { hstRate: 13.333 }, /at most 2 decimals/],
    ['hstRate boundary', { hstRate: 0 }, null],
    ['notes too long', { notes: 'N'.repeat(2001) }, /at most 2000 characters/],
    ['sentAt garbage', { sentAt: 'yesterday' }, /sentAt must be an ISO datetime or null/],
    ['sentAt date-only rejected', { sentAt: '2026-11-05' }, /sentAt must be an ISO datetime or null/],
    ['sentAt null allowed', { sentAt: null }, null],
    ['receivedAt garbage', { receivedAt: 42 }, /receivedAt must be an ISO datetime or null/],
    ['lines not an array', { lines: 'nope' }, /lines must be an array/],
    ['line unknown field', { lines: [line({ totalCents: 5 })] }, /unknown field "totalCents"/],
    ['line description missing', { lines: [line({ description: undefined })] }, /description must be a string/],
    ['line description empty', { lines: [line({ description: ' ' })] }, /must not be empty/],
    ['line description too long', { lines: [line({ description: 'D'.repeat(201) })] }, /at most 200 characters/],
    ['line id too long', { lines: [line({ id: 'x'.repeat(41) })] }, /at most 40 characters/],
    ['line qty zero', { lines: [line({ qty: 0 })] }, /greater than 0/],
    ['line qty too high', { lines: [line({ qty: 100001 })] }, /at most 100000/],
    ['line qty three decimals', { lines: [line({ qty: 1.333 })] }, /at most 2 decimals/],
    ['line unit too long', { lines: [line({ unit: 'u'.repeat(21) })] }, /at most 20 characters/],
    ['line unitPrice negative', { lines: [line({ unitPrice: -0.01 })] }, /at least 0/],
    ['line unitPrice too high', { lines: [line({ unitPrice: 1000001 })] }, /at most 1000000/],
    ['line unitPrice three decimals', { lines: [line({ unitPrice: 9.999 })] }, /at most 2 decimals/],
    ['line partNumber too long', { lines: [line({ partNumber: 'p'.repeat(61) })] }, /at most 60 characters/],
    ['line supplier too long', { lines: [line({ supplier: 's'.repeat(121) })] }, /at most 120 characters/],
    ['line note too long', { lines: [line({ note: 'n'.repeat(201) })] }, /at most 200 characters/],
    ['line link not a URL', { lines: [line({ link: 'example.com/needle' })] }, /valid http\/https URL/],
    ['line link wrong scheme', { lines: [line({ link: 'ftp://example.com/needle' })] }, /http or https URL/],
    ['line link too long', { lines: [line({ link: `https://example.com/${'x'.repeat(500)}` })] }, /at most 500 characters/],
    ['line machineId empty', { lines: [line({ machineId: ' ' })] }, /machineId must not be empty/],
    ['unknown top-level field', { totalCents: 500 }, /Unknown field "totalCents"/],
  ];
  for (const [name, overrides, pattern] of cases) {
    const input = { ...goodRequest, ...overrides };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === DELETE) delete input[key];
    }
    if (pattern === null) {
      assert.doesNotThrow(() => validateRecordData('purchaseRequests', input, { isCreate: true }), name);
      continue;
    }
    assert.throws(
      () => validateRecordData('purchaseRequests', input, { isCreate: true }),
      (err) => err.status === 400 && err.code === 'bad_request' && pattern.test(err.message),
      `${name}: expected ${pattern}`,
    );
  }
});

test('purchaseRequests: at most 100 lines', () => {
  const lines = Array.from({ length: 101 }, (_, index) => ({
    description: `Item ${index + 1}`,
    qty: 1,
  }));
  assert.throws(
    () => validateRecordData('purchaseRequests', { ...goodRequest, lines }, { isCreate: true }),
    /at most 100 entries/,
  );
  const hundred = lines.slice(0, 100);
  const data = validateRecordData('purchaseRequests', { ...goodRequest, lines: hundred }, {
    isCreate: true,
  });
  assert.equal(data.lines.length, 100);
});

// ---------------------------------------------------------------------------
// Section 4: PR numbering through putRecord (SPEC-v4.md section 2)
// ---------------------------------------------------------------------------

test('numbering: assigned on first save, kept on updates, the client cannot set it', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v4m1-number-'));
  try {
    const store = openStore(dataDir);
    try {
      const userRow = store.createUser({
        username: 'nia',
        displayName: 'Nia Numbering',
        role: 'admin',
        passwordHash: auth.hashPassword('nia-password-1'),
      });
      const user = { store, id: userRow.id, roleId: userRow.role_id };

      const first = putRecord(store, {
        storeName: 'purchaseRequests',
        id: uuid(),
        body: { data: { title: 'First request', number: 77 } },
        user,
      });
      assert.equal(first.record.data.number, 1, 'the first request is PR-0001');
      assert.equal(formatRequestNumber(first.record.data.number), 'PR-0001');

      const update = putRecord(store, {
        storeName: 'purchaseRequests',
        id: first.record.id,
        body: {
          data: { ...first.record.data, title: 'First request, priced', number: 77 },
          baseVersion: first.record.version,
        },
        user,
      });
      assert.equal(update.record.data.number, 1, 'updates keep the assigned number');
      assert.equal(update.record.version, 2);
      assert.equal(update.conflict, null);

      const second = putRecord(store, {
        storeName: 'purchaseRequests',
        id: uuid(),
        body: { data: { title: 'Second request' } },
        user,
      });
      assert.equal(second.record.data.number, 2, 'the sequence continues');

      // The counter is its own sequence, apart from workOrderNumber.
      const order = putRecord(store, {
        storeName: 'workOrders',
        id: uuid(),
        body: { data: { title: 'Unrelated order', machineId: uuid() } },
        user,
      });
      assert.equal(order.record.data.number, 1, 'work orders keep their own sequence');
      const third = putRecord(store, {
        storeName: 'purchaseRequests',
        id: uuid(),
        body: { data: { title: 'Third request' } },
        user,
      });
      assert.equal(third.record.data.number, 3);

      // History is written per save with the acting user's display name.
      const history = store.historyList('purchaseRequests', first.record.id);
      assert.equal(history.length, 2);
      assert.equal(history[0].action, 'update');
      assert.equal(history[1].action, 'create');
      assert.equal(history[0].displayName, 'Nia Numbering');
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Section 5: money math in integer cents (SPEC-v4.md section 2, logic.js)
// ---------------------------------------------------------------------------

test('requestTotals: rounding, the 13% cases, unpriced lines, empty requests, decimal quantities', () => {
  const rounding = requestTotals({
    hstRate: 13,
    lines: [
      { description: 'a', qty: 1, unitPrice: 0.1 },
      { description: 'b', qty: 1, unitPrice: 0.2 },
    ],
  });
  assert.deepEqual(rounding, {
    lines: [{ lineTotalCents: 10 }, { lineTotalCents: 20 }],
    subtotalCents: 30, // 0.1 + 0.2 in cents, never 30.000000000000004
    hstCents: 4, // round(30 × 13 / 100)
    totalCents: 34,
    unpricedCount: 0,
  });

  // 13% HST on $0.01 / $99.99 / $1,000.00.
  const oneCent = requestTotals({ hstRate: 13, lines: [{ qty: 1, unitPrice: 0.01 }] });
  assert.equal(oneCent.subtotalCents, 1);
  assert.equal(oneCent.hstCents, 0, 'round(1 × 13 / 100) = 0');
  assert.equal(oneCent.totalCents, 1);
  assert.equal(formatMoney(oneCent.subtotalCents), '$0.01');

  const ninetyNine = requestTotals({ hstRate: 13, lines: [{ qty: 1, unitPrice: 99.99 }] });
  assert.equal(ninetyNine.subtotalCents, 9999);
  assert.equal(ninetyNine.hstCents, 1300, 'round(9999 × 13 / 100) = 1299.87 -> 1300');
  assert.equal(ninetyNine.totalCents, 11299);
  assert.equal(formatMoney(ninetyNine.totalCents), '$112.99');

  const thousand = requestTotals({ hstRate: 13, lines: [{ qty: 1, unitPrice: 1000 }] });
  assert.equal(thousand.subtotalCents, 100000);
  assert.equal(thousand.hstCents, 13000);
  assert.equal(thousand.totalCents, 113000);
  assert.equal(formatMoney(thousand.totalCents), '$1,130.00');

  // Unpriced lines count as 0 and are reported.
  const unpriced = requestTotals({
    hstRate: 13,
    lines: [
      { description: 'unknown', qty: 3, unitPrice: null },
      { description: 'belt', qty: 1, unitPrice: 5 },
    ],
  });
  assert.deepEqual(unpriced.lines, [{ lineTotalCents: 0 }, { lineTotalCents: 500 }]);
  assert.equal(unpriced.subtotalCents, 500);
  assert.equal(unpriced.unpricedCount, 1);
  assert.equal(unpriced.hstCents, 65);

  // No lines at all.
  const empty = { lines: [], subtotalCents: 0, hstCents: 0, totalCents: 0, unpricedCount: 0 };
  assert.deepEqual(requestTotals({ hstRate: 13, lines: [] }), empty);
  assert.deepEqual(requestTotals({}), empty);

  // Quantities with decimals, and a zero tax rate.
  const decimals = requestTotals({ hstRate: 0, lines: [{ qty: 2.5, unitPrice: 2.4 }] });
  assert.equal(decimals.lines[0].lineTotalCents, 600);
  assert.equal(decimals.hstCents, 0, 'hstRate 0 means no tax');

  // hstRate defaults to 13 when the request has none.
  const noRate = requestTotals({ lines: [{ qty: 1, unitPrice: 1 }] });
  assert.equal(noRate.hstCents, 13);

  // The sheet example: 100 × $0.45 == $45.00.
  const spec = requestTotals({ hstRate: 13, lines: [{ qty: 100, unitPrice: 0.45 }] });
  assert.equal(formatMoney(spec.lines[0].lineTotalCents), '$45.00');
});

test('formatMoney: integer cents to CAD strings with separators', () => {
  assert.equal(formatMoney(123450), '$1,234.50');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(1), '$0.01');
  assert.equal(formatMoney(9500), '$95.00');
  assert.equal(formatMoney(45), '$0.45');
  assert.equal(formatMoney(123456789), '$1,234,567.89');
  assert.equal(formatMoney(-50), '-$0.50');
  assert.equal(formatMoney(123450.4), '$1,234.50');
  assert.equal(formatMoney(null), null);
  assert.equal(formatMoney(undefined), null);
  assert.equal(formatMoney(''), null);
  assert.equal(formatMoney('free'), null);
});

test('formatRequestNumber: PR-0001 and PR-pending', () => {
  assert.equal(formatRequestNumber(1), 'PR-0001');
  assert.equal(formatRequestNumber(7), 'PR-0007');
  assert.equal(formatRequestNumber(42), 'PR-0042');
  assert.equal(formatRequestNumber(1234), 'PR-1234');
  assert.equal(formatRequestNumber(12345), 'PR-12345');
  assert.equal(formatRequestNumber(null), 'PR-pending');
  assert.equal(formatRequestNumber(undefined), 'PR-pending');
  assert.equal(formatRequestNumber(''), 'PR-pending');
  assert.equal(formatRequestNumber('later'), 'PR-pending');
});

// ---------------------------------------------------------------------------
// Sections 2 and 3.5 through HTTP: routes, permissions, OpenAPI, Muse
// ---------------------------------------------------------------------------

let handle;
let base;
let sid;

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

async function session(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      cookie: `sid=${sid}`,
      ...XRW,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { res, body: await readJson(res) };
}

async function bearer(token, pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { res, body: await readJson(res) };
}

async function createToken(payload) {
  const created = await session('/api/tokens', { method: 'POST', body: payload });
  assert.equal(created.res.status, 201, JSON.stringify(created.body));
  return created.body;
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v4m1-server-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  base = handle.url;
  handle.store.createUser({
    username: 'anna',
    displayName: 'Anna Admin',
    role: 'admin',
    passwordHash: auth.hashPassword('anna-password-1'),
  });
  const noPurch = handle.store.createRole({ name: 'No Purchasing', permissions: {}, updatedBy: null });
  handle.store.createUser({
    username: 'vic',
    displayName: 'Vic Viewer',
    roleId: noPurch.id,
    passwordHash: auth.hashPassword('vic-password-1'),
  });
  sid = await login('anna', 'anna-password-1');
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
});

test('OpenAPI: PurchaseRequest schema and the PUT notes for agents', async () => {
  const res = await fetch(`${base}/openapi.json`);
  assert.equal(res.status, 200);
  const spec = await res.json();
  const request = spec.components.schemas.PurchaseRequest;
  assert.ok(request, 'the PurchaseRequest schema exists');
  assert.deepEqual(request.properties.status.enum, ['draft', 'sent', 'received', 'cancelled']);
  assert.equal(request.properties.hstRate.maximum, 30);
  assert.equal(request.properties.hstRate.default, 13);
  assert.equal(request.properties.lines.maxItems, 100);
  assert.equal(request.properties.lines.items.$ref, '#/components/schemas/PurchaseRequestLine');
  assert.equal(request.required.includes('title'), true);
  const line = spec.components.schemas.PurchaseRequestLine;
  assert.equal(line.properties.description.maxLength, 200);
  assert.deepEqual(line.properties.unitPrice.type, ['number', 'null']);
  assert.equal(line.required.includes('description'), true);

  const storeParam = spec.components.parameters.Store;
  assert.ok(storeParam.schema.enum.includes('purchaseRequests'));
  const put = spec.paths['/api/records/{store}/{id}'].put;
  assert.match(put.description, /purchaseRequests/);
  assert.match(put.description, /number.*assigned by the server/s);
  assert.match(put.description, /replaces the whole record/);
  assert.match(put.description, /\/api\/changes/s);
});

test('HTTP: a signed-in admin creates and reads purchaseRequests through the generic routes', async () => {
  const id = uuid();
  const created = await session(`/api/records/purchaseRequests/${id}`, {
    method: 'PUT',
    body: {
      data: { title: 'November belt order', lines: [{ description: 'Belt', qty: 2, unitPrice: 12 }] },
    },
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.record.store, 'purchaseRequests');
  assert.equal(created.body.record.data.number, 1);
  assert.equal(created.body.record.data.status, 'draft');
  assert.equal(created.body.record.data.lines[0].unit, 'pcs');

  const feed = await session('/api/changes?since=0&limit=1000');
  assert.equal(feed.res.status, 200);
  const seen = feed.body.records.find((record) => record.store === 'purchaseRequests');
  assert.ok(seen, 'the changes feed carries purchaseRequests');

  const history = await session(`/api/history/purchaseRequests/${id}`);
  assert.equal(history.res.status, 200);
  assert.equal(history.body[history.body.length - 1].action, 'create');

  // A role without purchasing read gets nothing from the feed.
  const vicSid = await login('vic', 'vic-password-1');
  const vicFeed = await fetch(`${base}/api/changes?since=0&limit=1000`, {
    headers: { cookie: `sid=${vicSid}`, ...XRW },
  });
  const vicBody = await readJson(vicFeed);
  assert.equal(
    vicBody.records.some((record) => record.store === 'purchaseRequests'),
    false,
    'stores the role cannot read are hidden entirely',
  );
  const vicHistory = await fetch(`${base}/api/history/purchaseRequests/${id}`, {
    headers: { cookie: `sid=${vicSid}`, ...XRW },
  });
  assert.equal(vicHistory.status, 403);
  assert.equal((await readJson(vicHistory)).error, 'forbidden');
});

test('Muse: a write token creates then updates a request; history says Muse Agent', async () => {
  const write = await createToken({ name: 'Muse requests', scope: 'write' });
  assert.ok(write.token);

  const id = uuid();
  const created = await bearer(write.token, `/api/records/purchaseRequests/${id}`, {
    method: 'PUT',
    body: {
      data: {
        title: 'Muse gathered list',
        neededBy: '2026-11-20',
        requestedBy: 'Muse',
        lines: [{ description: 'Needle DBx1 #14', qty: 100, unitPrice: 0.45 }],
      },
    },
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.record.data.number, 2, 'the PR sequence continues');
  assert.equal(created.body.record.data.hstRate, 13);

  // Read it back from the changes feed like a real agent would…
  const feed = await bearer(write.token, '/api/changes?since=0&limit=1000');
  assert.equal(feed.res.status, 200);
  const mine = feed.body.records.filter(
    (record) => record.store === 'purchaseRequests' && record.id === id
  );
  assert.equal(mine.length, 1);
  assert.equal(mine[0].version, 1);

  // …then PUT the whole record back with one more line.
  const updated = await bearer(write.token, `/api/records/purchaseRequests/${id}`, {
    method: 'PUT',
    body: {
      data: {
        ...mine[0].data,
        status: 'sent',
        sentAt: '2026-10-22T15:04:05.000Z',
        lines: [...mine[0].data.lines, { description: 'Belt', qty: 2.5, unitPrice: 12 }],
      },
      baseVersion: mine[0].version,
    },
  });
  assert.equal(updated.res.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.record.version, 2);
  assert.equal(updated.body.record.data.lines.length, 2);
  assert.equal(updated.body.record.data.number, 2, 'the number is kept');
  assert.equal(updated.body.record.data.status, 'sent');

  const history = await bearer(write.token, `/api/history/purchaseRequests/${id}`);
  assert.equal(history.res.status, 200);
  const actions = history.body.map((entry) => entry.action);
  assert.deepEqual(actions, ['update', 'create'], 'newest first');
  for (const entry of history.body) {
    assert.equal(entry.displayName, 'Muse Agent', 'the write is attributed');
  }

  // Stale baseVersion: last save wins (SPEC-v2.md 7.1) and the conflict is
  // reported in the body for the agent to see.
  const stale = await bearer(write.token, `/api/records/purchaseRequests/${id}`, {
    method: 'PUT',
    body: { data: { title: 'Stale', lines: [] }, baseVersion: 1 },
  });
  assert.equal(stale.res.status, 200);
  assert.ok(stale.body.conflict, 'the stale save reports the conflict');
  assert.equal(stale.body.conflict.overwrittenVersion, 2);
  assert.equal(stale.body.record.version, 3);
});

test('Muse: a read token gets 403 on PUT with the flat error shape', async () => {
  const read = await createToken({ name: 'Muse read only', scope: 'read' });
  const id = uuid();
  const denied = await bearer(read.token, `/api/records/purchaseRequests/${id}`, {
    method: 'PUT',
    body: { data: { title: 'Nope' } },
  });
  assert.equal(denied.res.status, 403);
  assert.equal(denied.body.error, 'forbidden');
  assert.equal(Object.keys(denied.body).length, 2, 'the error shape stays flat');
  assert.equal(typeof denied.body.message, 'string');
});

test('HTTP: two concurrent creates get distinct PR numbers', async () => {
  const write = await createToken({ name: 'Muse concurrent', scope: 'write' });
  const ids = [uuid(), uuid()];
  const results = await Promise.all(
    ids.map((id) =>
      bearer(write.token, `/api/records/purchaseRequests/${id}`, {
        method: 'PUT',
        body: { data: { title: 'Concurrent request' } },
      })
    )
  );
  for (const { res, body } of results) {
    assert.equal(res.status, 200, JSON.stringify(body));
  }
  const numbers = results.map(({ body }) => body.record.data.number);
  assert.equal(new Set(numbers).size, 2, `distinct numbers, got ${numbers.join(', ')}`);
  assert.deepEqual(
    numbers.slice().sort((a, b) => a - b),
    [3, 4],
    'the sequence continues after the earlier requests'
  );
  assert.ok(numbers.every((number) => Number.isInteger(number)));
});