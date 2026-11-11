// One-time v6 setup for an existing shop database (run on the company PC
// after copying the new code). It adds what v6 expects in the DATA, which a
// code update alone cannot bring:
//
//   1. the "Supervisor" role (if missing) with its hidden pages;
//   2. the floor zones agreed for v6: the main sewing section -> "Line A"
//      (except QC and BD stations -> "QC" / "BD"), DF -> "Down fill",
//      TRIM / BLOW / PAC / SP / SNAP / Q1-Q4 -> "Packing and special machine".
//
// Default is a dry run that only prints what would change. With --apply it
// first saves a backup (data/backups/before-v6-setup-<time>.db), then writes
// every change through the normal record path (History shows "v6 setup").
// Running it again changes nothing that is already right.
//
//   node server/setup-v6.js            (preview)
//   node server/setup-v6.js --apply    (do it)

import path from 'node:path';
import fs from 'node:fs';

import { normalizePermissions, setHiddenPages, hiddenPagesOf } from './permissions.js';
import { putRecord } from './records.js';
import { openStore } from './store.js';
import { slotRects } from '../logic-map.js';
import { isMainModule } from './is-main.js';

const SUPERVISOR = {
  name: 'Supervisor',
  permissions: {
    serviceOrders: 'write', // view and add service orders
    statistics: 'read',
    parts: 'read',
    purchasing: 'read',
    coworkers: 'read',
    contractors: 'read',
    floorMap: 'write', // shop floor pages: skills, QC, WPFI inspect
    machines: 'read', // the machine list for new service orders; page hidden below
    files: 'write',
    aiAssistant: 'read', // skill ratings from tickets; set to none to hide the chat
    pm: 'none',
    library: 'none',
    contractorRates: 'none',
    backups: 'none',
    settings: 'none',
    admin: 'none',
  },
  hiddenPages: ['machines', 'mapEdit'],
};

/** Stations whose box lies inside the main sewing section (found from stations named on the plan). */
function sectionTest(stations, rectOf) {
  const pick = (code, zone) => stations.find((s) => s.data.code === code && (!zone || s.data.zone === zone));
  const anchors = [pick('SN 34'), pick('SN 28'), pick('SN1'), pick('QC 1'), pick('BD 2'), pick('4S 109'), pick('SN81'), pick('SN 8')]
    .filter(Boolean)
    .map((s) => rectOf(s))
    .filter(Boolean);
  if (anchors.length < 6) return null; // the plan is not the one v6 was set up on: skip the area rule
  const area = {
    x0: Math.min(...anchors.map((r) => r.x)) - 1,
    y0: Math.min(...anchors.map((r) => r.y)) - 1,
    x1: Math.max(...anchors.map((r) => r.x + r.w)) + 1,
    y1: Math.max(...anchors.map((r) => r.y + r.h)) + 1,
  };
  return (s) => {
    const r = rectOf(s);
    return Boolean(r) && r.x >= area.x0 && r.x + r.w <= area.x1 && r.y >= area.y0 && r.y + r.h <= area.y1;
  };
}

export function planZones(store) {
  const maps = store.listRecords('floorMaps');
  const rects = new Map();
  for (const map of maps) for (const box of map.data.boxes || []) for (const r of slotRects(box)) rects.set(`${box.id}:${r.slot}`, r);
  const stations = store.listRecords('floorStations');
  const rectOf = (s) => (s.data.boxId ? rects.get(`${s.data.boxId}:${Number(s.data.slot) || 0}`) : null);
  const inSection = sectionTest(stations, rectOf);
  const changes = [];
  for (const s of stations) {
    const code = String(s.data.code || '').toUpperCase().replace(/\s+/g, '');
    let zone = null;
    if (/^DF\d*$/.test(code)) zone = 'Down fill';
    else if (/^(TRIM|BLOW|PAC|SP|SNAP)\d*$/.test(code) || /^Q[1-4]$/.test(code)) zone = 'Packing and special machine';
    else if (/^BD\d*$/.test(code)) zone = 'BD';
    else if (inSection && inSection(s)) zone = /^QC\d*$/.test(code) ? 'QC' : 'Line A';
    if (zone && zone !== (s.data.zone || '')) changes.push({ record: s, zone });
  }
  return { changes, sectionFound: Boolean(inSection) };
}

export function main(argv, { dataDir = process.env.DATA_DIR || './data', log = console.log } = {}) {
  const apply = argv.includes('--apply');
  const store = openStore(dataDir);
  try {
    const admin = store.listUsers ? store.listUsers().find((u) => u.username === 'admin') : store.getUserByUsername('admin');
    const actor = admin || store.listUsers?.()[0];
    if (!actor) {
      log('No user found; create the first admin first (node server/admin.js create-user --admin ...).');
      return 1;
    }
    const user = { id: actor.id, username: actor.username, roleId: actor.role_id ?? actor.roleId, store };

    const role = store.getRoleByName(SUPERVISOR.name);
    log(role ? `Supervisor role: already there (hidden pages: ${hiddenPagesOf(store, role.id).join(', ') || 'none'}) - left as it is.` : 'Supervisor role: will be created.');

    const { changes, sectionFound } = planZones(store);
    if (!sectionFound) log('Main sewing section not recognised on this floor plan: only the DF / Packing / BD rules apply.');
    const byZone = {};
    for (const c of changes) (byZone[c.zone] ??= []).push(c.record.data.code || '(no code)');
    log(changes.length ? `Zones: ${changes.length} stations to update` : 'Zones: nothing to change.');
    for (const [zone, codes] of Object.entries(byZone)) log(`  ${zone} (${codes.length}): ${codes.join(', ')}`);

    if (!apply) {
      log('\nPreview only. Run again with --apply to make these changes (a backup is saved first).');
      return 0;
    }

    fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const backup = path.join(dataDir, 'backups', `before-v6-setup-${stamp}.db`);
    store.db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    log(`Backup saved: ${backup}`);

    if (!role) {
      const created = store.createRole({ name: SUPERVISOR.name, permissions: normalizePermissions(SUPERVISOR.permissions), updatedBy: actor.id });
      setHiddenPages(store, created.id, SUPERVISOR.hiddenPages);
      log('Supervisor role created. Assign it to the supervisor in Admin -> Users.');
    }
    for (const { record, zone } of changes) {
      putRecord(store, {
        storeName: 'floorStations',
        id: record.id,
        body: { data: { ...record.data, zone }, baseVersion: record.version },
        user,
        note: 'v6 setup',
      });
    }
    log(`Zones updated: ${changes.length}. Done.`);
    return 0;
  } finally {
    store.close();
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
