// server/setup-v6.js: preview by default, --apply backs up first, creates the
// Supervisor role with hidden pages, applies the zone rules, and a second run
// changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { openStore } from '../server/store.js';
import { putRecord } from '../server/records.js';
import { hiddenPagesOf } from '../server/permissions.js';
import { main } from '../server/setup-v6.js';

const TMP = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), '.tmp');
fs.mkdirSync(TMP, { recursive: true });

test('setup-v6: preview, apply with backup, then nothing left to do', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'setup-v6-'));
  try {
    const store = openStore(dir);
    const admin = store.createUser({ username: 'admin', displayName: 'Admin', role: 'admin', passwordHash: auth.hashPassword('admin-password-1') });
    const user = { id: admin.id, roleId: admin.role_id ?? admin.roleId, store };
    const mapId = crypto.randomUUID();
    putRecord(store, { storeName: 'floorMaps', id: mapId, body: { data: { name: 'Main', width: 100, height: 100, boxes: [{ id: 'b', x: 0, y: 0, w: 30, h: 10, slots: 3 }] } }, user });
    for (const [slot, code] of [[0, 'DF1'], [1, 'TRIM 2'], [2, 'BD 4']]) {
      putRecord(store, { storeName: 'floorStations', id: crypto.randomUUID(), body: { data: { mapId, boxId: 'b', slot, code, zone: 'old' } }, user });
    }
    store.close();

    const lines = [];
    assert.equal(main([], { dataDir: dir, log: (l) => lines.push(l) }), 0);
    assert.ok(lines.some((l) => /Supervisor role: will be created/.test(l)));
    assert.ok(lines.some((l) => /Zones: 3 stations to update/.test(l)));
    let check = openStore(dir);
    assert.equal(check.getRoleByName('Supervisor'), null, 'preview changes nothing');
    check.close();

    assert.equal(main(['--apply'], { dataDir: dir, log: () => {} }), 0);
    assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.startsWith('before-v6-setup-')), 'backup first');
    check = openStore(dir);
    const role = check.getRoleByName('Supervisor');
    assert.deepEqual(hiddenPagesOf(check, role.id), ['machines', 'mapEdit']);
    assert.equal(JSON.parse(role.permissions).serviceOrders, 'write');
    const zones = Object.fromEntries(check.listRecords('floorStations').map((r) => [r.data.code, r.data.zone]));
    assert.deepEqual(zones, { DF1: 'Down fill', 'TRIM 2': 'Packing and special machine', 'BD 4': 'BD' });
    check.close();

    const again = [];
    main([], { dataDir: dir, log: (l) => again.push(l) });
    assert.ok(again.some((l) => /Zones: nothing to change/.test(l)));
    assert.ok(again.some((l) => /already there/.test(l)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
