import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* V3-M2 shell (SPEC-v3.md sections 1, 8 client part, 10): renames, dark
   sidebar markup, phone More bar, drawer wiring, branding display. The
   browser parts are checked as static markup/source so no DOM is needed. */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(REPO, name), 'utf8');

test('index.html: renames — Service Orders, Preventive Maintenance, Shopfloor CMMS', () => {
  const html = read('index.html');
  assert.match(html, /<title>Shopfloor CMMS<\/title>/);
  assert.match(html, /data-tab="jobs"[^>]*>\s*<svg[^>]*>\s*.*?<span class="sidebar-label">Service Orders<\/span>/s);
  assert.match(html, /<span class="sidebar-label">Preventive Maintenance<\/span>/);
  assert.doesNotMatch(html, />Jobs</);
  assert.doesNotMatch(html, />PM</);
  // The new-order buttons say "Service order", not "Log repair".
  assert.doesNotMatch(html, /Log repair/);
  assert.match(html, />\+ <span class="sidebar-new-label">Service order<\/span>/);
  assert.match(html, /id="fab"[^>]*>\+ Service order</);
});

test('index.html: routes and stores keep their v2 names', () => {
  const html = read('index.html');
  // Routes stay #/jobs and #/pm (SPEC-v3.md section 1; no data migration).
  assert.match(html, /href="#\/jobs" data-tab="jobs"/);
  assert.match(html, /href="#\/pm" data-tab="pm"/);
  assert.match(html, /sidebar-new" href="#\/jobs\/new"/);
});

test('index.html: People group, Statistics and placeholder routes', () => {
  const html = read('index.html');
  assert.match(html, /<h3 class="sidebar-group-title">People<\/h3>/);
  assert.match(html, /href="#\/coworkers" data-tab="coworkers"/);
  assert.match(html, /href="#\/contractors" data-tab="contractors"/);
  assert.match(html, /href="#\/statistics" data-tab="statistics"/);
  assert.match(html, /<span class="sidebar-label">Coworkers<\/span>/);
  assert.match(html, /<span class="sidebar-label">Outside Contractors<\/span>/);
  // Badges still ride on .nav-count spans for updateNavCounts().
  for (const count of ['jobs', 'pm', 'parts']) {
    assert.match(html, new RegExp(`data-count="${count}"`));
  }
});

test('index.html: sidebar collapses to an icon rail via the toggle button', () => {
  const html = read('index.html');
  assert.match(html, /id="sidebar-toggle"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /title="Collapse navigation"/);
});

test('index.html: phone bottom bar is Home · Orders · Prev. Maint. · Machines · More', () => {
  const html = read('index.html');
  for (const label of ['Home', 'Orders', 'Prev. Maint.', 'Machines', 'More']) {
    assert.match(html, new RegExp(`>${label}</(a|button)>`), label);
  }
  assert.match(html, /id="more-button"/);
  assert.match(html, /aria-haspopup="dialog"/);
  // Parts left the bar: it lives behind More now.
  assert.doesNotMatch(html, /data-tab="parts"[^>]*>Parts</);
});

test('index.html: top bar has page title, global search, sync pill and user menu', () => {
  const html = read('index.html');
  assert.match(html, /<h1 id="page-title">Shopfloor CMMS<\/h1>/);
  assert.match(html, /id="global-search-input"/);
  assert.match(html, /id="global-search-results" role="listbox"/);
  assert.match(html, /id="sync-pill"/);
  assert.match(html, /id="user-menu-button"/);
});

test('index.html: inline SVG icons with no external URLs', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /https?:\/\//);
  const icons = html.match(/<svg class="sb-icon"/g) || [];
  assert.ok(icons.length >= 8, `expected sidebar icons, got ${icons.length}`);
});

test('app.js: renames and no leftover v2 wording in user-facing strings', () => {
  const src = read('app.js');
  assert.match(src, /setTitle\('Service Orders'\)/);
  assert.match(src, /setTitle\('Preventive Maintenance'\)/);
  assert.match(src, /setTitle\('New service order'\)/);
  assert.doesNotMatch(src, /'Log repair'\)/);
  assert.doesNotMatch(src, /\+ Log repair/);
  assert.doesNotMatch(src, /'Jobs'/);
  // Store labels for history use the new name too.
  assert.match(src, /workOrders: 'Service order',/);
});

test('app.js: placeholder pages render Coming soon for people and statistics', () => {
  const src = read('app.js');
  assert.match(src, /function renderComingSoon\(tab\)/);
  for (const tab of ['coworkers', 'contractors', 'statistics']) {
    assert.match(src, new RegExp(`${tab}: \\{`));
  }
  assert.match(src, /root === 'coworkers' \|\| root === 'contractors' \|\| root === 'statistics'/);
  // The last-tab restore accepts the new tabs.
  assert.match(src, /'coworkers', 'contractors', 'statistics'\]\.includes\(last\)/);
});

test('app.js: drawer component and the machine-form drawer usage', () => {
  const src = read('app.js');
  assert.match(src, /function openDrawer\(\{ title = '', content = null, onClose = null, isDirty = null \} = \{\}\)/);
  assert.match(src, /class: 'drawer',\n\s+role: 'dialog',/);
  assert.match(src, /maybeOpenMachineDrawer/);
  assert.match(src, /machineFormBody\(existing\)/);
  // Esc and backdrop close run the in-page discard check.
  assert.match(src, /title: 'Discard changes\?'/);
  assert.equal(src.includes("'Keep editing'"), true);
  // Focus trap is a helper, not a browser dialog.
  assert.match(src, /function trapTabKey\(root, event\)/);
});

test('app.js: global search matches service orders by number and title', () => {
  const src = read('app.js');
  assert.match(src, /function globalSearchMatches\(query\)/);
  assert.match(src, /function serviceOrderLabel\(order\)/);
  // The SO-number formatting lives in the pure helper logic.js:formatOrderNumber.
  assert.match(src, /formatOrderNumber\(number\)/);
  assert.match(read('logic.js'), /`SO-\$\{String\(Math\.floor\(Math\.abs\(value\)\)\)\.padStart\(4, '0'\)\}`/);
  assert.match(src, /searchBox\('Search service orders'/);
  // Keyboard navigation: ArrowUp/ArrowDown/Enter on the results dropdown.
  assert.match(src, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/);
});

test('app.js: branding is fetched, cached in IndexedDB meta and applied', () => {
  const src = read('app.js');
  assert.match(src, /const DEFAULT_BRAND_NAME = 'Shopfloor CMMS';/);
  assert.match(src, /sync\.api\('GET', '\/api\/branding'\)/);
  assert.match(src, /await db\.setMeta\('branding', response\.data\);/);
  assert.match(src, /await db\.getMeta\('branding'\)/);
  assert.match(src, /decorateLoginCard\(\)/);
  assert.match(src, /document\.title = `\$\{title\} · \$\{brandName\(\)\}`;/);
});

test('app.js: sidebar rail remembered in localStorage', () => {
  const src = read('app.js');
  assert.match(src, /const SIDEBAR_RAIL_KEY = 'maint-log:sidebar-rail';/);
  assert.match(src, /storageSet\(SIDEBAR_RAIL_KEY, collapsed \? '1' : '0'\)/);
  assert.match(src, /storageGet\(SIDEBAR_RAIL_KEY\) === '1'/);
});

test('app.js: More sheet lists the phone-bar pages', () => {
  const src = read('app.js');
  assert.match(src, /function openMoreSheet\(\)/);
  for (const item of ["'Parts'", "'Statistics'", "'Coworkers'", "'Outside Contractors'", "'Help'", "'Settings'"]) {
    assert.equal(src.includes(item), true, item);
  }
});

test('help.js: wording follows the renames', () => {
  const src = read('help.js');
  assert.match(src, /Service Orders → \+ Service order/);
  assert.match(src, /Start a new service order/);
  assert.match(src, /Go to Service Orders/);
  assert.match(src, /Go to Preventive Maintenance/);
  assert.match(src, /Export service orders \(CSV\)/);
  assert.doesNotMatch(src, /Jobs →/);
  assert.doesNotMatch(src, /Log repair/);
});

test('manifest keeps the default app name', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.name, 'Shopfloor CMMS');
});

test('sw.js: cache version bumped and the shell still caches the client files', () => {
  const src = read('sw.js');
  // Bumped with each shell change (13 in V3-M3).
  assert.match(src, /CACHE_VERSION = 13;/);
  for (const file of ['index.html', 'styles.css', 'app.js', 'help.js', 'db.js', 'sync.js']) {
    assert.match(src, new RegExp(`'\\./${file.replace('.', '\\.')}'`), file);
  }
});

test('client source: no innerHTML and no external URLs in the changed files', () => {
  for (const name of ['index.html', 'app.js', 'help.js', 'sw.js', 'styles.css']) {
    const src = read(name);
    assert.doesNotMatch(src, /\.innerHTML\s*=/, `${name} must not assign innerHTML`);
  }
  for (const name of ['app.js', 'help.js']) {
    const src = read(name);
    assert.doesNotMatch(src, /https?:\/\/(?!www\.w3\.org)/, `${name} must not reference external URLs`);
  }
});