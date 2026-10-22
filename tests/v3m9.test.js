import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AREAS as CLIENT_AREAS, AREA_KEYS, areaLabel, isReadOnlyLevel, allows, storeArea } from '../permissions.js';
import {
  changedRolePatches,
  draftFromRoles,
  formatRoleHistoryEntry,
  historyChangeLines,
  isAdministratorRole,
  renderLevelChoice,
  renderRoleHistoryList,
  roleDeleteReason,
  roleRenameReason,
  sortHistoryNewestFirst,
} from '../admin.js';
import { AREAS as SERVER_AREAS } from '../server/permissions.js';
import { renderHelp } from '../help.js';

const REPO = import.meta.dirname.replace(/[\\/]tests$/, '');

function read(name) {
  return fs.readFileSync(path.join(REPO, name), 'utf8');
}

/* ---------- can()/allows(): one permission check everywhere ---------- */

test('allows(): level order none < read < write, write implies read', () => {
  const viewer = { serviceOrders: 'read', pm: 'write', machines: 'none' };
  assert.equal(allows(viewer, 'serviceOrders'), true);
  assert.equal(allows(viewer, 'serviceOrders', 'write'), false);
  assert.equal(allows(viewer, 'pm'), true);
  assert.equal(allows(viewer, 'pm', 'write'), true);
  assert.equal(allows(viewer, 'pm', 'read'), true);
  assert.equal(allows(viewer, 'machines'), false);
  assert.equal(allows(viewer, 'machines', 'write'), false);
});

test('allows(): missing areas behave as none; no permissions at all hides everything', () => {
  assert.equal(allows({}, 'parts'), false);
  assert.equal(allows(null, 'parts'), false);
  assert.equal(allows(undefined, 'parts', 'write'), false);
  assert.equal(allows({ parts: undefined }, 'parts'), false);
  assert.equal(allows({ parts: 'nonsense' }, 'parts'), false);
});

test('allows(): unknown area or level throws like the server can()', () => {
  assert.throws(() => allows({}, 'nope'), /unknown permission area/);
  assert.throws(() => allows({}, 'parts', 'admin'), /unknown permission level/);
});

test('isReadOnlyLevel(): read without write', () => {
  assert.equal(isReadOnlyLevel({ parts: 'read' }, 'parts'), true);
  assert.equal(isReadOnlyLevel({ parts: 'write' }, 'parts'), false);
  assert.equal(isReadOnlyLevel({ parts: 'none' }, 'parts'), false);
  assert.equal(isReadOnlyLevel({}, 'parts'), false);
});

test('AREA_KEYS and labels match the server list exactly', () => {
  assert.deepEqual(
    CLIENT_AREAS.map((area) => [area.key, area.label]),
    SERVER_AREAS.map((area) => [area.key, area.label]),
  );
  assert.deepEqual(AREA_KEYS, SERVER_AREAS.map((area) => area.key));
});

test('areaLabel(): known labels, store names and unknown keys fall back', () => {
  assert.equal(areaLabel('serviceOrders'), 'Service Orders');
  assert.equal(areaLabel('contractorRates'), 'Contractor rates & costs');
  assert.equal(areaLabel('workOrders'), 'Service Orders');
  assert.equal(areaLabel('pmTasks'), 'Preventive Maintenance');
  assert.equal(areaLabel('unknown-area'), 'unknown-area');
});

test('storeArea(): record store names map to their areas', () => {
  assert.equal(storeArea('workOrders'), 'serviceOrders');
  assert.equal(storeArea('pmTasks'), 'pm');
  assert.equal(storeArea('contractors'), 'contractors');
  assert.equal(storeArea('files'), null);
  assert.equal(storeArea('nothing'), null);
});

test('every AREA_KEYS entry has a label and areaLabel knows it', () => {
  for (const key of AREA_KEYS) {
    assert.ok(areaLabel(key).length > 0);
  }
});

test('app.js: one can(area, level) helper with local mode allowing everything', () => {
  const src = read('app.js');
  assert.match(src, /function can\(area, level = 'read'\) \{\s*\n\s*if \(!teamUser \|\| !teamUser\.permissions\) return true;\s*\n\s*return allows\(teamUser\.permissions, area, level\);\s*\n\}/);
  assert.match(src, /from '\.\/permissions\.js'/);
});

test('app.js: the ad-hoc helpers were removed, not just bypassed', () => {
  const src = read('app.js');
  assert.doesNotMatch(src, /\bareaLevel\b/);
  assert.doesNotMatch(src, /\bcanWriteArea\b/);
  assert.doesNotMatch(src, /\bcanViewArea\b/);
  assert.doesNotMatch(src, /\bcanMarkPMDone\b/);
  assert.doesNotMatch(src, /permissions\.admin === 'write'/);
  assert.doesNotMatch(src, /teamUser && teamUser\.permissions &&/);
});

/* ---------- The roles matrix PATCH payload builder ---------- */

const ROLES = [
  {
    id: 'role-admin',
    name: 'Administrator',
    builtin: true,
    permissions: Object.fromEntries(AREA_KEYS.map((key) => [key, 'write'])),
  },
  {
    id: 'role-tech',
    name: 'Technician',
    builtin: true,
    permissions: { serviceOrders: 'write', pm: 'write', statistics: 'read' },
  },
  {
    id: 'role-viewer',
    name: 'Viewer',
    builtin: true,
    permissions: { serviceOrders: 'read', pm: 'read', machines: 'read' },
  },
];

test('draftFromRoles(): a full editable draft, missing areas normalised to none', () => {
  const draft = draftFromRoles(ROLES);
  assert.deepEqual(Object.keys(draft).sort(), ROLES.map((role) => role.id).sort());
  assert.equal(draft['role-tech'].statistics, 'read');
  assert.equal(draft['role-tech'].parts, 'none');
  assert.equal(draft['role-viewer'].coworkers, 'none');
});

test('changedRolePatches: no changes means nothing to PATCH', () => {
  const draft = draftFromRoles(ROLES);
  assert.deepEqual(changedRolePatches(ROLES, draft), []);
});

test('changedRolePatches: one changed area produces one full-permissions payload', () => {
  const draft = draftFromRoles(ROLES);
  draft['role-viewer'].machines = 'write';
  const patches = changedRolePatches(ROLES, draft);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].id, 'role-viewer');
  assert.equal(patches[0].permissions.machines, 'write');
  assert.equal(patches['role-viewer'] === undefined, true);
  // The payload always carries every area (server normalises the rest to none).
  assert.deepEqual(Object.keys(patches[0].permissions).sort(), AREA_KEYS.slice().sort());
  assert.equal(patches[0].permissions.serviceOrders, 'read');
  assert.equal(patches[0].permissions.contractorRates, 'none');
});

test('changedRolePatches: the Administrator column is locked and never PATCHed', () => {
  const draft = draftFromRoles(ROLES);
  draft['role-admin'].admin = 'none';
  draft['role-admin'].serviceOrders = 'read';
  assert.deepEqual(changedRolePatches(ROLES, draft), []);
  assert.equal(isAdministratorRole(ROLES[0]), true);
  assert.equal(isAdministratorRole(ROLES[1]), false);
  assert.equal(isAdministratorRole({ name: 'Fake', builtin: true }), false);
});

test('changedRolePatches: two changed roles produce two payloads', () => {
  const draft = draftFromRoles(ROLES);
  draft['role-tech'].admin = 'write';
  draft['role-viewer'].files = 'read';
  const patches = changedRolePatches(ROLES, draft);
  assert.deepEqual(patches.map((patch) => patch.id).sort(), ['role-tech', 'role-viewer']);
});

test('changedRolePatches: a rename-only diff sends no permissions PATCH', () => {
  const renamed = [
    { ...ROLES[1], name: 'Technician II' },
    ROLES[2],
  ];
  const draft = draftFromRoles(renamed);
  assert.deepEqual(changedRolePatches(renamed, draft), []);
});

test('app.js: the unsaved-changes bar PATCHes every changed role', () => {
  const src = read('app.js');
  assert.match(src, /const patches = adminUI\.changedRolePatches\(roles, draft\);/);
  assert.match(src, /await sync\.api\('PATCH', `\/api\/roles\/\$\{encodeURIComponent\(patch\.id\)\}`, \{\s*\n\s*permissions: patch\.permissions,\s*\n\s*\}\);/);
  assert.match(src, /'You have unsaved changes'/);
  assert.match(src, /unsavedBar\.hidden = changed\.length === 0;/);
  assert.match(src, /'Save'[\s\S]*'Discard'/);
});

/* ---------- Role history: formatting and rendering ---------- */

const HISTORY_ENTRY = {
  action: 'update',
  at: '2026-10-21T09:30:00.000Z',
  userId: null,
  displayName: null,
  before: { name: 'Supervisor', builtin: false, permissions: { machines: 'write', parts: 'read' } },
  after: { name: 'Supervisor', builtin: false, permissions: { machines: 'read', parts: 'read' } },
  note: 'created by the role migration (SPEC-v3.md section 13)',
};

test('formatRoleHistoryEntry: entries without a user say "System"', () => {
  const formatted = formatRoleHistoryEntry({ ...HISTORY_ENTRY, displayName: null, userId: null });
  assert.equal(formatted.who, 'System');
  assert.equal(formatted.action, 'update');
  assert.deepEqual(formatted.changes, ['Machines: Write → Read']);
});

test('formatRoleHistoryEntry: entries with a user show the display name', () => {
  const formatted = formatRoleHistoryEntry({ ...HISTORY_ENTRY, userId: 'u1', displayName: 'Maria P.' });
  assert.equal(formatted.who, 'Maria P.');
});

test('formatRoleHistoryEntry: creation entries read from none', () => {
  const formatted = formatRoleHistoryEntry({
    action: 'create',
    at: '2026-10-20T08:00:00.000Z',
    userId: 'u1',
    displayName: 'Root User',
    before: null,
    after: { name: 'Supervisor', builtin: false, permissions: { serviceOrders: 'read', pm: 'write' } },
    note: null,
  });
  assert.deepEqual(formatted.changes, [
    'Service Orders: None → Read',
    'Preventive Maintenance: None → Write',
  ]);
});

test('formatRoleHistoryEntry: deletions go to none, renames add a name line', () => {
  const formatted = formatRoleHistoryEntry({
    action: 'delete',
    at: '2026-10-22T08:00:00.000Z',
    userId: 'u1',
    displayName: 'Root User',
    before: { name: 'Old Supervisor', builtin: false, permissions: { machines: 'write' } },
    after: null,
    note: null,
  });
  assert.deepEqual(formatted.changes, ['Machines: Write → None']);
  const renamed = formatRoleHistoryEntry({
    action: 'update',
    at: '2026-10-22T08:00:00.000Z',
    userId: 'u1',
    displayName: 'Root User',
    before: { name: 'Sup', builtin: false, permissions: {} },
    after: { name: 'Supervisor', builtin: false, permissions: {} },
    note: null,
  });
  assert.deepEqual(renamed.changes, ['Name: "Sup" → "Supervisor"']);
});

test('formatRoleHistoryEntry keeps the server note and timestamp', () => {
  const formatted = formatRoleHistoryEntry(HISTORY_ENTRY);
  assert.equal(formatted.at, '2026-10-21T09:30:00.000Z');
  assert.equal(formatted.note, 'created by the role migration (SPEC-v3.md section 13)');
  const messy = formatRoleHistoryEntry(null);
  assert.equal(messy.who, 'System');
  assert.deepEqual(messy.changes, []);
});

test('historyChangeLines lists areas in the fixed order', () => {
  const lines = historyChangeLines(
    { name: 'R', builtin: false, permissions: { machines: 'write', serviceOrders: 'write' } },
    { name: 'R', builtin: false, permissions: { machines: 'read', serviceOrders: 'read' } },
  );
  assert.deepEqual(lines, ['Service Orders: Write → Read', 'Machines: Write → Read']);
});

test('sortHistoryNewestFirst orders by time descending', () => {
  const sorted = sortHistoryNewestFirst([
    { at: '2026-10-01T00:00:00.000Z', displayName: 'A' },
    { at: '2026-10-05T00:00:00.000Z', displayName: null },
    { at: '2026-10-03T00:00:00.000Z', displayName: 'C' },
  ]);
  assert.deepEqual(sorted.map((entry) => entry.at && entry.displayName), [null, 'C', 'A']);
});

/* ---------- Pure render helpers (stub build helper like ui.test) ---------- */

function stubH() {
  const make = (tag, attrs = {}, ...children) => {
    const node = {
      tag,
      attrs: { ...(attrs || {}) },
      children: [],
    };
    node.append = (...items) => {
      for (const item of items.flat(Infinity)) {
        if (item === null || item === undefined || item === false) continue;
        node.children.push(item);
      }
    };
    node.addEventListener = () => {};
    node.append(...children);
    return node;
  };
  return make;
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  return (node.children || []).map(textOf).join('');
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) findAll(child, predicate, out);
  return out;
}

test('renderLevelChoice: a None/Read/Write segmented control of radio inputs', () => {
  const h = stubH();
  const control = renderLevelChoice(h, { roleId: 'r1', area: 'machines', value: 'read' });
  const radios = findAll(control, (node) => node.tag === 'input');
  assert.equal(radios.length, 3);
  assert.deepEqual(radios.map((radio) => radio.attrs.type), ['radio', 'radio', 'radio']);
  assert.deepEqual(radios.map((radio) => radio.attrs.value), ['none', 'read', 'write']);
  assert.deepEqual(radios.map((radio) => Boolean(radio.attrs.checked)), [false, true, false]);
  const labels = findAll(control, (node) => node.tag === 'label').map(textOf);
  assert.deepEqual(labels, ['None', 'Read', 'Write']);
  const labelTexts = findAll(control, (node) => node.tag === 'input').map(
    (radio) => radio.attrs['aria-label'],
  );
  assert.equal(labelTexts[0], 'Machines: None');
  assert.equal(labelTexts[2], 'Machines: Write');
});

test('renderLevelChoice: a locked cell renders no working control', () => {
  const h = stubH();
  let picked = null;
  const control = renderLevelChoice(h, {
    roleId: 'r1',
    area: 'admin',
    value: 'write',
    disabled: true,
    onChange: (level) => {
      picked = level;
    },
  });
  const radios = findAll(control, (node) => node.tag === 'input');
  assert.ok(radios.every((radio) => radio.attrs.disabled === true));
  assert.equal(picked, null);
});

test('renderRoleHistoryList: newest first, "System" who, change lines', () => {
  const h = stubH();
  const list = renderRoleHistoryList(h, [
    { ...HISTORY_ENTRY },
    {
      action: 'update',
      at: '2026-10-21T10:30:00.000Z',
      userId: 'u9',
      displayName: 'Root User',
      before: { name: 'Supervisor', builtin: false, permissions: { machines: 'write' } },
      after: { name: 'Supervisor', builtin: false, permissions: { machines: 'write', files: 'read' } },
      note: null,
    },
  ]);
  const entries = findAll(list, (node) => node.tag === 'li' && String(node.attrs.class || '').includes('role-history-entry'));
  assert.equal(entries.length, 2);
  const whos = findAll(list, (node) => String(node.attrs.class || '').includes('role-history-who'));
  assert.equal(textOf(whos[1]), 'System');
  assert.equal(textOf(whos[0]), 'Root User');
  const changes = findAll(list, (node) =>
    String(node.attrs.class || '')
      .split(/\s+/)
      .includes('role-history-change'),
  ).map(textOf);
  assert.deepEqual(changes, ['Photos & files: None → Read', 'Machines: Write → Read']);
});

test('renderRoleHistoryList: entries without changes say so instead of nothing', () => {
  const h = stubH();
  const list = renderRoleHistoryList(h, [
    {
      action: 'rename',
      at: '2026-10-21T11:00:00.000Z',
      userId: 'u1',
      displayName: 'Root User',
      before: { name: 'Sup', builtin: false, permissions: {} },
      after: { name: 'Supervisor', builtin: false, permissions: {} },
      note: null,
    },
  ]);
  const text = textOf(list);
  assert.match(text, /Name: "Sup" → "Supervisor"/);
});

test('roleDeleteReason: locked Administrator, in-use roles, free roles', () => {
const users = [{ roleId: 'role-tech' }, { roleId: 'role-tech' }, { roleId: 'role-none' }];
assert.match(roleDeleteReason(ROLES[0], users), /Administrator role cannot be deleted\./);
assert.match(roleDeleteReason(ROLES[1], users), /Assigned to 2 users/);
assert.equal(roleDeleteReason(ROLES[2], users), null);
});

test('roleRenameReason: only the Administrator role is blocked', () => {
  assert.match(roleRenameReason(ROLES[0]), /Administrator role cannot be changed\./);
  assert.equal(roleRenameReason(ROLES[1]), null);
  assert.equal(roleRenameReason({ name: 'Custom', builtin: false }), null);
});

/* ---------- Read-only pages render no create/edit controls ---------- */

test('help: the roles section is for admins; the View only note is for everyone', () => {
  const h = stubH();
  const everyone = textOf(renderHelp(h, { isAdmin: false }));
  assert.doesNotMatch(everyone, /Roles and permissions/);
  assert.match(everyone, /View only/);
  assert.match(everyone, /You no longer have permission to change/);
  const admin = textOf(renderHelp(h, { isAdmin: true }));
  assert.match(admin, /Roles and permissions/);
  assert.match(admin, /Users & roles see the Admin page/);
  const toc = findAll(
    renderHelp(h, { isAdmin: false }),
    (node) => node.tag === 'nav' && String(node.attrs.class || '').includes('help-toc'),
  );
  assert.equal(toc.length, 1);
  assert.doesNotMatch(textOf(toc[0]), /help-roles/);
});

test('app.js: read-only pages hide the create buttons (service orders, machines, parts)', () => {
  const src = read('app.js');
  // Service Orders toolbar and phone empty state.
  assert.match(src, /headActionFor\('serviceOrders', h\('a', \{ class: 'btn btn-primary btn-small', href: '#\/jobs\/new' \}, '\+ Service order'\)\)/);
  assert.match(src, /can\('serviceOrders', 'write'\) &&\s*\n\s*\(filters\.status\.length === 0 \|\| filters\.status\.includes\('not-done'\)\)/);
  // Machines and Parts page heads.
  assert.match(src, /headActionFor\('machines', h\('a', \{ class: 'btn btn-primary btn-small', href: '#\/machines\/new' \}, '\+ Add machine'\)\)/);
  assert.match(src, /headActionFor\('parts', h\('a', \{ class: 'btn btn-primary btn-small', href: '#\/parts\/new' \}, '\+ Add part'\)\)/);
  assert.match(src, /can\('parts', 'write'\)\s*\n\s*\? \[h\('a', \{ class: 'btn btn-primary', href: '#\/parts\/new' \}, 'Add a part'\)\]/);
});

test('app.js: read-only pages hide edit/delete/move/mark-done and the FAB', () => {
  const src = read('app.js');
  // Service order detail: no status buttons, edit section, delete or desktop edit.
  assert.match(src, /canEditOrder \? statusButtons : null/);
  assert.match(src, /desktopMedia\.matches \|\| !can\('serviceOrders', 'write'\)/);
  assert.match(src, /canEditOrder\s*\n\s*\? h\(\s*\n\s*'div',\s*\n\s*\{ class: 'form-actions'/);
  // Board: no move menu and no drag without write.
  assert.match(src, /const canMove = can\('serviceOrders', 'write'\);/);
  assert.match(src, /canMove \? moveButton : null/);
  assert.match(src, /draggable: canMove === true \|\| null/);
  assert.match(src, /if \(canMove\) \{\s*\n\s*list\.addEventListener\('dragover'/);
  // Parts detail: no −1/+1 stock controls, edit link or delete.
  assert.match(src, /can\('parts', 'write'\)\s*\n\s*\? h\(\s*\n\s*'div',\s*\n\s*\{ class: 'card' \},/);
  assert.match(src, /can\('parts', 'write'\) \? h\('a', \{ class: 'btn btn-small', href: `#\/parts\/\$\{encodeURIComponent\(part\.id\)\}\/edit` \}, 'Edit part'\) : null/);
  assert.match(src, /can\('parts', 'write'\) \? h\('button', \{ class: 'btn btn-danger', type: 'button', onclick: deletePart \}, 'Delete part'\) : null/);
  // Machines detail: edit/delete gated; a new order still needs serviceOrders write.
  assert.match(src, /can\('serviceOrders', 'write'\)\s*\n\s*\? h\('a', \{ class: 'btn btn-primary btn-small', href: `#\/jobs\/new\?machine=\$\{encodeURIComponent\(machine\.id\)\}` \}, '\+ Service order'\)/);
  assert.match(src, /can\('machines', 'write'\)\s*\n\s*\? h\('button', \{ class: 'btn btn-danger', type: 'button', onclick: deleteMachine \}, 'Delete machine'\)/);
  // FAB and sidebar "+ Service order" button.
  assert.match(src, /fab\.hidden = !\(can\('serviceOrders', 'write'\) && \(tab === 'home' \|\| \(tab === 'jobs' && !second\)\)\);/);
  assert.match(src, /sidebarNew\.hidden = !can\('serviceOrders', 'write'\)/);
});

test('app.js: router blocks none and read-only access to the form routes', () => {
  const src = read('app.js');
  assert.match(src, /if \(!can\('serviceOrders'\)\) \{\s*\n\s*content = noAccessPage\('Service Orders', 'Service Orders'\);/);
  assert.match(src, /if \(!can\('serviceOrders', 'write'\)\) \{\s*\n\s*content = noAccessPage\('New service order', 'Service Orders'\);/);
  assert.match(src, /if \(!can\('machines'\)/);
  assert.match(src, /if \(!can\('machines', 'write'\)\) \{\s*\n\s*content = noAccessPage\(machineFormTitle\(second === 'new' \? null : \{ name: '' \}\), 'Machines'\);/);
  assert.match(src, /if \(!can\('parts'\)\) \{\s*\n\s*content = noAccessPage\('Parts', 'Parts & Stock'\);/);
  assert.match(src, /if \(!can\('pm'\)\) \{\s*\n\s*content = noAccessPage\('Preventive Maintenance', 'Preventive Maintenance'\);/);
  assert.match(src, /content = renderAdmin\(route\);/);
});

/* ---------- Navigation and settings follow permissions ---------- */

test('app.js: nav, tabs and the More sheet hide areas with none', () => {
  const src = read('app.js');
  const navArea = src.slice(src.indexOf('const NAV_TAB_AREAS'));
  for (const pair of [
    "jobs: 'serviceOrders',",
    "pm: 'pm',",
    "machines: 'machines',",
    "parts: 'parts',",
    "coworkers: 'coworkers',",
    "contractors: 'contractors',",
    "statistics: 'statistics',",
    "admin: 'admin',",
  ]) {
    assert.ok(navArea.includes(pair), pair);
  }
  assert.match(navArea, /link\.hidden = area === 'admin' \? !canAdminUI\(\) : !can\(area\)/);
  const moreSheet = src.slice(src.indexOf('function openMoreSheet'));
  assert.match(moreSheet, /can\('parts'\) && \{ label: 'Parts'/);
  assert.match(moreSheet, /canAdminUI\(\) && \{ label: 'Admin', icon: NAV_ICONS\.admin, href: '#\/admin' \}/);
  assert.match(src, /function canAdminUI\(\) \{\s*\n\s*return Boolean\(teamUser\) && can\('admin', 'write'\);\s*\n\}/);
});

test('index.html: the Admin sidebar item exists and starts hidden', () => {
  const html = read('index.html');
  assert.match(html, /href="#\/admin" data-tab="admin" title="Admin" hidden/);
  assert.match(html, /<span class="sidebar-label">Admin<\/span>/);
});

test('app.js: the Admin route needs admin write; tabs Users and Roles', () => {
  const src = read('app.js');
  assert.match(src, /if \(!canAdminUI\(\)\) \{\s*\n\s*return noAccessPage\('Admin', 'Users \& roles'\);/);
  assert.match(src, /\{ key: 'users', label: 'Users', href: '#\/admin\/users' \}/);
  assert.match(src, /\{ key: 'roles', label: 'Roles \& permissions', href: '#\/admin\/roles' \}/);
});

test('app.js: Users tab — role select saves immediately with an Undo toast', () => {
  const src = read('app.js');
  assert.match(src, /roleSelectElement\(roles, user\.roleId, \(roleId\) => onRoleChange\(user, roleId\)\)/);
  assert.match(src, /await patchUserFields\(user, \{ roleId \}\)/);
  assert.match(src, /actionToast\(`\$\{next\.displayName \|\| next\.username\} is now \$\{next\.roleName \|\| roleNameOf\(roles, roleId\)\}\.`, \{\s*\n\s*label: 'Undo',/);
  assert.match(src, /onAction: async \(\) => \{\s*\n\s*const undo = await patchUserFields\(next, \{ roleId: previous \}\);/);
  assert.match(src, /'Reset password'/);
  assert.match(src, /showInputDialog\(\{\s*\n\s*title: `Reset password for \$\{user\.displayName \|\| user\.username\}`/);
});

test('app.js: Users tab table headers and the add-user drawer fields', () => {
  const src = read('app.js');
  assert.match(src, /h\('th', \{ scope: 'col' \}, 'Name'\)/);
  assert.match(src, /h\('th', \{ scope: 'col' \}, 'Username'\)/);
  assert.match(src, /h\('th', \{ scope: 'col' \}, 'Role'\)/);
  assert.match(src, /h\('th', \{ scope: 'col' \}, 'Status'\)/);
  assert.match(src, /h\('th', \{ scope: 'col' \}, 'Last sign-in'\)/);
  assert.match(src, /h\('th', \{ scope: 'col' \}, 'Created'\)/);
  assert.match(src, /user\.lastSignIn \? formatSyncTime\(user\.lastSignIn\) : '—'/);
  assert.match(src, /user\.createdAt \? formatDate\(user\.createdAt\.slice\(0, 10\)\) : '—'/);
  // The drawer form (username, display name, role select, temporary password).
  assert.match(src, /field\('Username', usernameInput\), field\('Display name', displayNameInput\)/);
  assert.match(src, /field\('Role', roleSelect\), field\('Temporary password', passwordInput\)/);
  assert.match(src, /The temporary password must be at least 6 characters\./);
  assert.match(src, /await sync\.api\('POST', '\/api\/users', \{\s*\n\s*username,\s*\n\s*displayName,\s*\n\s*roleId: roleSelect\.value,/);
});

test('app.js: Users tab shows server 409 messages inline', () => {
  const src = read('app.js');
  assert.match(src, /const result = await patchUserFields\(user, \{ roleId \}\);/);
  assert.match(src, /if \(!result\.ok\) \{\s*\n\s*errorBox\.textContent = result\.message;/);
  assert.match(src, /message: adminApiError\(response, 'The server rejected the change\.'\)/);
});

test('app.js: Settings keeps a link to Admin, moves the users card out, gates backups', () => {
  const src = read('app.js');
  assert.match(src, /function adminLinkNote\(\)/);
  assert.match(src, /h\('a', \{ href: '#\/admin' \}, 'Manage users and roles in Admin'\)/);
  assert.match(src, /canAdminUI\(\) \? adminLinkNote\(\) : null/);
  // No users card is left in Settings.
  assert.doesNotMatch(src, /sectionTitle\('Users'\), usersCard\(\)/);
  // Backups: read to list, write for "Back up now" and downloads.
  assert.match(src, /can\('backups'\) \? \[sectionTitle\('Backups on server'\), serverBackupsCard\(\)\] : null/);
  assert.match(src, /const canBackupNow = can\('backups', 'write'\);/);
  assert.match(src, /canBackupNow \? h\('div', \{ class: 'button-row' \}, backupNow\) : null/);
  // Branding and AI settings need settings write.
  assert.match(src, /can\('settings', 'write'\) \? \[sectionTitle\('Branding'\), brandingCard\(\)\] : null/);
  assert.match(src, /can\('settings', 'write'\) \? \[sectionTitle\('AI assistant'\), aiSettingsCard\(\)\] : null/);
});

test('app.js: the roles matrix uses the AREA labels with a locked Administrator column', () => {
  const src = read('app.js');
  assert.match(src, /for \(const area of AREAS\) \{\s*\n\s*const row = h\(/);
  assert.match(src, /h\('th', \{ scope: 'row', class: 'matrix-area' \}, area\.label\)/);
  assert.match(src, /const locked = adminUI\.isAdministratorRole\(role\);/);
  assert.match(src, /disabled: locked,/);
  assert.match(src, /title: 'The Administrator role keeps every permission and cannot be changed here\.'/);
  assert.match(src, /function lockIconNode\(\)/);
});

test('app.js: new role, rename, delete with reason, and the history drawer', () => {
  const src = read('app.js');
  assert.match(src, /body = copySelect\.value \? \{ name, copyOf: copySelect\.value \} : \{ name, permissions: \{\} \};/);
  assert.match(src, /await sync\.api\('POST', '\/api\/roles', body\)/);
  assert.match(src, /await sync\.api\('PATCH', `\/api\/roles\/\$\{encodeURIComponent\(role\.id\)\}`, \{ name: trimmed \}\)/);
  assert.match(src, /await sync\.api\('DELETE', `\/api\/roles\/\$\{encodeURIComponent\(role\.id\)\}`\)/);
  assert.match(src, /disabled: Boolean\(deleteReason\)/);
  assert.match(src, /deleteReason \? h\('span', \{ class: 'muted role-delete-reason' \}, deleteReason\) : null/);
  assert.match(src, /function openRoleHistoryDrawer\(role\)/);
  assert.match(src, /\.api\('GET', `\/api\/roles\/\$\{encodeURIComponent\(role\.id\)\}\/history`\)/);
  assert.match(src, /adminUI\.renderRoleHistoryList\(h, response\.data, \{ formatWhen: formatSyncTime \}\)/);
});

test('app.js: global search only searches readable areas', () => {
  const src = read('app.js');
  assert.match(src, /for \(const order of can\('serviceOrders'\) \? sortWorkOrdersNewest\(state\.workOrders\) : \[\]\)/);
  assert.match(src, /for \(const machine of can\('machines'\) \? state\.machines : \[\]\)/);
  assert.match(src, /for \(const part of can\('parts'\) \? state\.parts : \[\]\)/);
  assert.match(src, /if \(can\('coworkers'\)\) \{/);
  assert.match(src, /if \(can\('contractors'\)\) \{/);
});

test('app.js: after a sync round permissions refresh; none areas clear their store and page', () => {
  const src = read('app.js');
  assert.match(src, /await refreshMyPermissions\(\{ forceRender: false \}\);/);
  assert.match(src, /function refreshMyPermissions\(/);
  assert.match(src, /await db\.clear\(AREA_STORES\[area\]\);/);
  assert.match(src, /const tabArea = NAV_TAB_AREAS\[root\];\s*\n\s*if \(tabArea && !can\(tabArea\)\) \{\s*\n\s*navigate\('#\/home'\);/);
  assert.match(src, /startPermissionRefresh\(\);/);
  const stores = src.slice(src.indexOf('const AREA_STORES'));
  assert.match(stores, /serviceOrders: 'workOrders',/);
  assert.match(stores, /pm: 'pmTasks',/);
});

test('sync.js: a 403 moves the change to the failed list naming the area', () => {
  const src = read('sync.js');
  assert.match(src, /if \(response\.status === 403\) \{/);
  assert.match(src, /const deniedArea = response\.data && response\.data\.area \? response\.data\.area : entry\.store;/);
  assert.match(src, /`You no longer have permission to change \$\{areaLabel\(deniedArea\)\}\.`/);
  assert.match(src, /import \{ areaLabel \} from '\.\/permissions\.js';/);
});

test('chat.js: the panel follows can() for the assistant and machines context', () => {
  const src = read('chat.js');
  assert.match(src, /deps\.can\('aiAssistant'\)/);
  assert.match(src, /!deps\.can\('machines'\)/);
  assert.match(src, /deps\.can\('serviceOrders', 'write'\)/);
  assert.match(src, /can: options\.can,/);
});

test('styles.css: matrix scroll with a sticky area column, segmented control, unsaved bar', () => {
  const css = read('styles.css');
  for (const selector of [
    '.matrix-scroll',
    '.roles-matrix',
    '.matrix-area',
    '.seg',
    '.seg-option',
    '.unsaved-bar',
    '.role-card',
    '.role-history-list',
    '.matrix-lock-svg',
  ]) {
    assert.ok(css.includes(`${selector}`), `css rule ${selector}`);
  }
  assert.match(css, /\.matrix-scroll \{[^}]*overflow-x: auto;/s);
  assert.match(css, /position: sticky;\s*\n\s*left: 0;/);
});

test('sw.js: cache bumped and the new client modules cached', () => {
  const src = read('sw.js');
  assert.ok(Number(src.match(/const CACHE_VERSION = (\d+);/)?.[1]) >= 24);
  assert.match(src, /'\.\/admin\.js'/);
  assert.match(src, /'\.\/permissions\.js'/);
});

test('client source: no innerHTML assignments and no external URLs in new files', () => {
  for (const name of ['app.js', 'admin.js', 'permissions.js', 'help.js', 'sync.js', 'sw.js']) {
    const src = read(name);
    assert.doesNotMatch(src, /\.innerHTML\s*=/, `${name} must not assign innerHTML`);
    assert.doesNotMatch(src, /https?:\/\/(?!www\.w3\.org|127\.0\.0\.1|localhost)/, `${name} must not reference external URLs`);
  }
  const chat = read('chat.js');
  assert.doesNotMatch(chat, /\.innerHTML\s*=/);
});

test('node --check passes for the changed client files', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const name of ['app.js', 'admin.js', 'permissions.js', 'sync.js', 'chat.js', 'help.js', 'sw.js']) {
    execFileSync(process.execPath, ['--check', path.join(REPO, name)]);
  }
});