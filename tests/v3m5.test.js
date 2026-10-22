import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COWORKER_SHIFTS, LABELS, contactSearch, formatMoney } from '../logic.js';

/* V3-M5 People (SPEC-v3.md sections 5 and 13): the Coworkers and Outside
   Contractors pages, contact actions, permission-aware rates and the
   contractor hours on the detail pages. The browser parts are checked as
   static source (no DOM in node:test); the pure helpers run for real. */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(REPO, name), 'utf8');

/* ---------- contactSearch (logic.js, pure) ---------- */

const people = [
  { id: 'a', name: 'Ana Cruz', role: 'Mechanic', skills: 'Juki timing', phone: '416 555 0134' },
  { id: 'b', name: 'Bo Lin', role: 'Line supervisor', skills: '', email: 'bo@shop.example' },
  { id: 'c', company: 'Ace Juki Service', trade: 'Juki service', contactName: 'Carla Diaz' },
  { id: 'd', company: 'North HVAC', trade: 'HVAC', contactName: 'Dave' },
  { id: 'e', name: 'Ghost', deleted: true },
];

test('contactSearch: empty query returns every live record', () => {
  const found = contactSearch(people, '');
  assert.equal(found.length, 4);
  assert.equal(found.some((record) => record.deleted), false, 'tombstones never match');
});

test('contactSearch: case-insensitive match over the given fields', () => {
  assert.deepEqual(contactSearch(people, 'ana cruz').map((r) => r.id), ['a']);
  assert.deepEqual(contactSearch(people, 'ACE JUKI', ['company', 'trade']).map((r) => r.id), ['c']);
  assert.deepEqual(contactSearch(people, 'hvac').map((r) => r.id), ['d']);
  assert.deepEqual(contactSearch(people, 'mechanic', ['role']).map((r) => r.id), ['a']);
  assert.deepEqual(contactSearch(people, 'bo@shop.example', ['email']).map((r) => r.id), ['b']);
  assert.deepEqual(contactSearch(people, 'ghost').map((r) => r.id), [], 'deleted records stay hidden');
});

test('contactSearch: default fields cover both people stores', () => {
  assert.deepEqual(contactSearch(people, 'carla').map((r) => r.id), ['c']);
  assert.deepEqual(contactSearch(people, 'timing').map((r) => r.id), ['a']);
  assert.deepEqual(contactSearch(people, 'zzz').length, 0);
});

test('coworker shifts: the five v3 values with labels', () => {
  assert.deepEqual(COWORKER_SHIFTS, ['day', 'evening', 'night', 'rotating', 'other']);
  for (const shift of COWORKER_SHIFTS) {
    assert.equal(typeof LABELS.coworkerShift[shift], 'string', shift);
  }
});

/* ---------- formatMoney (logic.js, pure) ---------- */

test('formatMoney: dollars with two decimals, null for missing values', () => {
  assert.equal(formatMoney(126.5), '$126.50');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(95), '$95.00');
  assert.equal(formatMoney(null), null);
  assert.equal(formatMoney(undefined), null);
  assert.equal(formatMoney(''), null);
  assert.equal(formatMoney('not a number'), null);
});

/* ---------- Static source checks ---------- */

test('app.js: coworkers and contractors pages render tables, cards and filters', () => {
  const src = read('app.js');
  assert.match(src, /function renderCoworkers\(route\)/);
  assert.match(src, /function renderContractors\(route\)/);
  // Desktop sortable tables with their own sort state.
  assert.match(src, /coworkers: \{ key: null, dir: 'asc' \}/);
  assert.match(src, /contractors: \{ key: null, dir: 'asc' \}/);
  assert.match(src, /function coworkersTableColumns\(\)/);
  assert.match(src, /function contractorsTableColumns\(\)/);
  // Columns follow the spec (SPEC-v3.md section 5 + M5 build list).
  for (const label of ["'Name'", "'Role'", "'Shift'", "'Phone'", "'Email'", "'Skills'"]) {
    assert.equal(src.includes(label), true, label);
  }
  for (const label of ["'Company'", "'Trade'", "'Contact'", "'Machines serviced'", "'Hourly rate'"]) {
    assert.equal(src.includes(label), true, label);
  }
  // Phone cards: person cards with contact strips.
  assert.match(src, /function coworkerCard\(coworker\)/);
  assert.match(src, /function contractorCard\(contractor\)/);
  // Active/Inactive/All filter chips.
  assert.equal(src.includes("const PEOPLE_FILTERS = ['active', 'inactive', 'all'];"), true);
  assert.match(src, /PEOPLE_FILTER_LABELS\[value\]/);
  // Page search boxes.
  assert.match(src, /searchBox\('Search coworkers'/);
  assert.match(src, /searchBox\('Search contractors'/);
});

test('app.js: detail routes with machines serviced, service orders and hours', () => {
  const src = read('app.js');
  assert.match(src, /function renderCoworkerDetail\(route\)/);
  assert.match(src, /function renderContractorDetail\(route\)/);
  assert.match(src, /function contractorsServicedMachines\(contractor\)/);
  // Assignee or labour entries, newest first.
  assert.match(src, /function personServiceOrders\(personKind, personId\)/);
  assert.match(src, /sortWorkOrdersNewest\(personServiceOrders\('contractor'/);
  assert.match(src, /sortWorkOrdersNewest\(personServiceOrders\('coworker'/);
  // Hours per range come from logic-stats.js.
  assert.match(src, /labourByContractor\(state\.workOrders, \[contractor\], rangeFor\(days\), \{ includeCost \}\)/);
  assert.match(src, /labourByCoworker\(state\.workOrders, \[coworker\], rangeFor\(days\)\)/);
  assert.match(src, /return \[30, 90, 365\]\.map\(\(days\) =>/);
  assert.match(src, /`Last \$\{entry\.days\} days`/);
});

test('app.js: forms open in the drawer on desktop, full page on phones', () => {
  const src = read('app.js');
  assert.match(src, /function maybeOpenCoworkerDrawer\(route\)/);
  assert.match(src, /function maybeOpenContractorDrawer\(route\)/);
  assert.match(src, /openDrawer\(\{ title: existing \? 'Edit coworker' : 'New coworker', content: node, isDirty \}\)/);
  assert.match(src, /openDrawer\(\{ title: existing \? 'Edit contractor' : 'New contractor', content: node, isDirty \}\)/);
  assert.match(src, /function coworkerFormBody\(existing\)/);
  assert.match(src, /function contractorFormBody\(existing\)/);
  // Linked login account select comes from the users cache.
  assert.match(src, /function linkedUserSelect\(selectedId\)/);
  assert.match(src, /teamUsers\s*\n?\s*\.filter\(\(user\) => user && !user\.disabled\)/);
  // Machines serviced is a checkbox multi-select of machines.
  assert.match(src, /'Machines they service'/);
  // Required fields with in-form errors, not dialogs.
  assert.match(src, /errorBox\.textContent = 'Enter a name\.'/);
  assert.match(src, /errorBox\.textContent = 'Enter a company name\.'/);
});

test('app.js: deletes use the in-page confirm, never native dialogs', () => {
  const src = read('app.js');
  assert.match(src, /title: 'Delete this coworker\?'/);
  assert.match(src, /title: 'Delete this contractor\?'/);
  assert.match(src, /await sync\.deleteRecord\('coworkers', coworker\.id, coworker\.version\);/);
  assert.match(src, /await sync\.deleteRecord\('contractors', contractor\.id, contractor\.version\);/);
  assert.match(src, /toast\('Coworker deleted\.'\)/);
  assert.match(src, /toast\('Contractor deleted\.'\)/);
});

test('app.js: contact actions render tel:/mailto: links with a Copy button', () => {
  const src = read('app.js');
  assert.match(src, /function contactValue\(kind, value\)/);
  assert.match(src, /\$\{isPhone \? 'tel:' : 'mailto:'\}/);
  assert.match(src, /navigator\.clipboard/);
  assert.match(src, /\.writeText\(text\)/);
  // Rejection falls back to selecting the text; success toasts "Copied".
  assert.match(src, /\.then\(\(\) => toast\('Copied'\)\)/);
  assert.match(src, /\.catch\(\(\) => selectTextNode\(linkNode\)\)/);
  assert.match(src, /function selectTextNode\(node\)/);
  assert.match(src, /range\.selectNodeContents\(node\)/);
  assert.match(src, /'aria-label': `Copy \$\{label\}`/);
  // Copies happen in the click handler only — no silent swallowing.
  assert.match(src, /onclick: \(\) => copyContactText\(text, link\),/);
});

test('app.js: permissions hide pages and buttons (SPEC-v3.md 13.3)', () => {
  const src = read('app.js');
  assert.match(src, /function areaLevel\(area\)/);
  assert.match(src, /function canViewArea\(area\)/);
  // Routes answer "You do not have access" for hidden areas.
  assert.match(src, /function noAccessPage\(title, areaLabel\)/);
  assert.match(src, /'You do not have access'/);
  assert.match(src, /if \(!canViewArea\('coworkers'\)\)/);
  assert.match(src, /if \(!canViewArea\('contractors'\)\)/);
  // Sidebar links and the People group hide with None.
  assert.match(src, /function applyNavPermissions\(\)/);
  assert.match(src, /coworkersLink\.hidden = !showCoworkers/);
  assert.match(src, /contractorsLink\.hidden = !showContractors/);
  assert.match(src, /peopleGroup\.hidden = !\(showCoworkers \|\| showContractors\)/);
  assert.match(src, /applyNavPermissions\(\);/);
  // The phone More sheet filters them the same way.
  assert.match(src, /canViewArea\('coworkers'\) && \{ label: 'Coworkers'/);
  assert.match(src, /canViewArea\('contractors'\) && \{/);
  // Read-only pages carry a View only badge and no add/edit/delete.
  assert.match(src, /function viewOnlyBadge\(\)/);
  assert.match(src, /'View only'/);
  assert.match(src, /areaLevel\('coworkers'\) === 'read' \? viewOnlyBadge\(\) : null/);
  assert.match(src, /areaLevel\('contractors'\) === 'read' \? viewOnlyBadge\(\) : null/);
});

test('app.js: contractor rates follow the contractorRates permission', () => {
  const src = read('app.js');
  assert.match(src, /function canReadRates\(\)/);
  assert.match(src, /function canWriteRates\(\)/);
  // The rate field is hidden without Read...
  assert.match(src, /const showRate = canReadRates\(\);/);
  // ...and read-only without Write (the server preserves the stored rate).
  assert.match(src, /disabled: !rateEditable \? true : null/);
  assert.match(src, /if \(rateEditable\) \{/);
  assert.match(src, /else if \(base\.hourlyRate === undefined\) \{/);
  // Costs appear only with contractorRates Read: includeCost drives it.
  assert.match(src, /const includeCost = canReadRates\(\);/);
  assert.match(src, /if \(canReadRates\(\)\) \{\s*\n\s*columns\.push\(/);
});

test('app.js: global search finds coworkers and contractors', () => {
  const src = read('app.js');
  assert.match(src, /kind: 'Coworker',/);
  assert.match(src, /kind: 'Contractor',/);
  assert.match(src, /href: `#\/coworkers\/\$\{encodeURIComponent\(coworker\.id\)\}`/);
  assert.match(src, /href: `#\/contractors\/\$\{encodeURIComponent\(contractor\.id\)\}`/);
  // And only in areas the user may see.
  assert.match(src, /if \(canViewArea\('coworkers'\)\) \{/);
  assert.match(src, /if \(canViewArea\('contractors'\)\) \{/);
});

test('app.js: split view lists people beside their detail pages', () => {
  const src = read('app.js');
  assert.match(src, /splitListRoot = 'coworkers';/);
  assert.match(src, /splitListRoot = 'contractors';/);
  assert.match(src, /renderCoworkers\(listRoute\)/);
  assert.match(src, /renderContractors\(listRoute\)/);
});

test('index.html: global search placeholder mentions people', () => {
  const html = read('index.html');
  assert.match(html, /placeholder="Search service orders, machines, parts, people"/);
});

test('sw.js: cache version bumped and logic-stats joined the shell', () => {
  const src = read('sw.js');
  const version = Number(src.match(/const CACHE_VERSION = (\d+);/)?.[1]);
  assert.ok(version >= 18, `expected CACHE_VERSION >= 18, got ${version}`);
  assert.match(src, /'\.\/logic-stats\.js'/);
});

test('help.js: People wording present', () => {
  const src = read('help.js');
  assert.match(src, /Add a coworker/);
  assert.match(src, /Add an outside contractor/);
  assert.match(src, /Call or copy a contact/);
  assert.match(src, /parts and people/);
});

test('V3-M5 client source: no innerHTML and no external URLs', () => {
  for (const name of ['app.js', 'styles.css', 'help.js', 'index.html']) {
    const src = read(name);
    assert.doesNotMatch(src, /\.innerHTML\s*=/, `${name} must not assign innerHTML`);
  }
  for (const name of ['app.js', 'help.js']) {
    const src = read(name);
    assert.doesNotMatch(src, /https?:\/\/(?!www\.w3\.org)/, `${name} must not reference external URLs`);
  }
});