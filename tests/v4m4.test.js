'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  filterLibraryItems,
  manualTextBadge,
  methodDraftFromWorkOrder,
  normalizeModel,
  relatedLibraryItems,
  searchLibraryItems,
} from '../logic.js';

/**
 * V4-M4 (SPEC-v4.md section 4.3 and the Library part of section 7): the
 * Library UI. Pure helpers cover the list search/filters, the completed
 * service order -> repair-method draft, and the AI-readable badge text from
 * a text-status object; source checks pin the navigation entries, routes and
 * buttons to the library permission.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(REPO, name), 'utf8');

/* ------------------------------------------------------------------------- */
/* Library list search (SPEC-v4.md 4.3)                                       */
/* ------------------------------------------------------------------------- */

const LIBRARY_ITEMS = [
  {
    id: 'li-1',
    kind: 'method',
    title: 'Thread breaks at high speed',
    machineType: 'single-needle',
    models: ['DDL-8700-7'],
    machineIds: ['m-1'],
    tags: ['thread break'],
    symptom: 'Top thread snaps above 4,000 rpm',
    steps: [
      { id: 's1', text: 'Check the thread path for burrs' },
      { id: 's2', text: 'Replace the needle' },
    ],
    toolsParts: 'Needles DBx1 #14',
  },
  {
    id: 'li-2',
    kind: 'manual',
    title: 'Juki DDL-8700 service manual',
    machineType: null,
    models: ['DDL 8700'],
    machineIds: [],
    tags: ['manual', 'timing'],
    notes: 'Timing marks on page 23',
    attachments: [],
  },
  {
    id: 'li-3',
    kind: 'method',
    title: 'Bartack keeps skipping',
    machineType: 'bartack',
    models: [],
    machineIds: [],
    tags: ['skip'],
    symptom: 'Skips stitches on thick webbing',
    steps: [{ id: 's1', text: 'Lower the needle bar slightly' }],
  },
];

test('searchLibraryItems: blank query returns every item in input order', () => {
  assert.deepEqual(searchLibraryItems(LIBRARY_ITEMS, '').map((i) => i.id), ['li-1', 'li-2', 'li-3']);
  assert.deepEqual(searchLibraryItems(LIBRARY_ITEMS, null).map((i) => i.id), ['li-1', 'li-2', 'li-3']);
  assert.deepEqual(searchLibraryItems(LIBRARY_ITEMS).map((i) => i.id), ['li-1', 'li-2', 'li-3']);
  // Non-arrays and null entries are tolerated.
  assert.deepEqual(searchLibraryItems(null, 'x'), []);
  assert.deepEqual(searchLibraryItems([null, LIBRARY_ITEMS[0], false], 'thread').map((i) => i.id), ['li-1']);
});

test('searchLibraryItems: matches title, models, tags, symptom and step text', () => {
  assert.deepEqual(searchLibraryItems(LIBRARY_ITEMS, 'high speed').map((i) => i.id), ['li-1']);
  // Step text (tools & parts is not a search field, SPEC-v4.md 4.3).
  assert.deepEqual(searchLibraryItems(LIBRARY_ITEMS, 'replace the needle').map((i) => i.id), ['li-1']);
  assert.deepEqual(searchLibraryItems(LIBRARY_ITEMS, 'Needles DBx1 #14'), []);
  // A model string joined from the array.
  assert.deepEqual(searchLibraryItems(LIBRARY_ITEMS, 'ddl 8700').map((i) => i.id), ['li-2']);
  // Tags.
  assert.deepEqual(searchLibraryItems(LIBRARY_ITEMS, 'timing').map((i) => i.id), ['li-2']);
  // Symptom.
  assert.deepEqual(searchLibraryItems(LIBRARY_ITEMS, 'webbing').map((i) => i.id), ['li-3']);
  // Step text.
  assert.deepEqual(searchLibraryItems(LIBRARY_ITEMS, 'needle bar').map((i) => i.id), ['li-3']);
  // Case-insensitive across all fields.
  assert.deepEqual(searchLibraryItems(LIBRARY_ITEMS, 'JUKI').map((i) => i.id), ['li-2']);
  assert.deepEqual(searchLibraryItems(LIBRARY_ITEMS, 'zzz'), []);
});

/* ------------------------------------------------------------------------- */
/* Library list filters (SPEC-v4.md 4.3)                                     */
/* ------------------------------------------------------------------------- */

test('filterLibraryItems: no filters returns everything', () => {
  assert.deepEqual(filterLibraryItems(LIBRARY_ITEMS).map((i) => i.id), ['li-1', 'li-2', 'li-3']);
  assert.deepEqual(
    filterLibraryItems(LIBRARY_ITEMS, {}).map((i) => i.id),
    ['li-1', 'li-2', 'li-3'],
  );
});

test('filterLibraryItems: machine type matches exactly', () => {
  assert.deepEqual(filterLibraryItems(LIBRARY_ITEMS, { machineType: 'bartack' }).map((i) => i.id), ['li-3']);
  assert.deepEqual(filterLibraryItems(LIBRARY_ITEMS, { machineType: 'Bartack' }).map((i) => i.id), []);
});

test('filterLibraryItems: model compares through normalizeModel, ignoring spaces and dashes', () => {
  // "ddl87007" == normalizeModel("DDL-8700-7").
  assert.deepEqual(filterLibraryItems(LIBRARY_ITEMS, { model: 'DDL 8700 7' }).map((i) => i.id), ['li-1']);
  assert.deepEqual(filterLibraryItems(LIBRARY_ITEMS, { model: 'ddl.8700/7' }).map((i) => i.id), ['li-1']);
  // "DDL 8700" (li-2) is a different model from "DDL-8700-7".
  assert.deepEqual(filterLibraryItems(LIBRARY_ITEMS, { model: 'DDL-8700' }).map((i) => i.id), ['li-2']);
  assert.deepEqual(filterLibraryItems(LIBRARY_ITEMS, { model: 'MO-3716' }), []);
  assert.equal(normalizeModel('DDL-8700-7'), 'ddl87007');
});

test('filterLibraryItems: tag matches case-insensitively and combines with other filters', () => {
  assert.deepEqual(filterLibraryItems(LIBRARY_ITEMS, { tag: 'Thread Break' }).map((i) => i.id), ['li-1']);
  assert.deepEqual(filterLibraryItems(LIBRARY_ITEMS, { tag: 'skip' }).map((i) => i.id), ['li-3']);
  // Combined: type + tag narrows to nothing, model + tag keeps li-2.
  assert.deepEqual(filterLibraryItems(LIBRARY_ITEMS, { machineType: 'bartack', tag: 'thread break' }), []);
  assert.deepEqual(filterLibraryItems(LIBRARY_ITEMS, { model: 'DDL-8700', tag: 'TIMING' }).map((i) => i.id), ['li-2']);
});

/* ------------------------------------------------------------------------- */
/* Completed service order -> repair method draft (SPEC-v4.md 4.3)           */
/* ------------------------------------------------------------------------- */

test('methodDraftFromWorkOrder: title, symptom, steps, machine ids/models, source', () => {
  const order = {
    id: 'so-42',
    title: 'Fixed sketchy feed on Juki 8700',
    problem: 'Feed dog moves intermittently',
    actionTaken: 'Cleaned the feed mechanism.\n\nAdjusted the feed height.\n  Re-timed the feed cam  ',
    machineId: 'm-1',
  };
  const machine = { id: 'm-1', model: 'DDL-8700-7', type: 'single-needle' };
  assert.deepEqual(methodDraftFromWorkOrder(order, machine), {
    kind: 'method',
    title: 'Fixed sketchy feed on Juki 8700',
    symptom: 'Feed dog moves intermittently',
    cause: '',
    steps: [
      { id: 'so-1', text: 'Cleaned the feed mechanism.' },
      { id: 'so-2', text: 'Adjusted the feed height.' },
      { id: 'so-3', text: 'Re-timed the feed cam' },
    ],
    toolsParts: '',
    safety: '',
    tags: [],
    machineIds: ['m-1'],
    models: ['DDL-8700-7'],
    sourceWorkOrderId: 'so-42',
  });
});

test('methodDraftFromWorkOrder: blank action taken gives no steps; no machine empties the links', () => {
  const draft = methodDraftFromWorkOrder({ id: 'so-7', title: 'T', problem: 'P', actionTaken: '   \n \n' }, null);
  assert.deepEqual(draft.steps, []);
  assert.deepEqual(draft.machineIds, []);
  assert.deepEqual(draft.models, []);
  assert.equal(draft.sourceWorkOrderId, 'so-7');
  // A missing order behaves like an empty one, never throws.
  assert.deepEqual(methodDraftFromWorkOrder(null, null).steps, []);
});

test('methodDraftFromWorkOrder: at most 60 steps, step text capped at 1000, title at 160', () => {
  const long = 'x'.repeat(1200);
  const manyLines = Array.from({ length: 70 }, (_, index) => `Step ${index + 1}`).join('\n');
  const order = { id: 'so-9', title: 'y'.repeat(200), problem: 'p', actionTaken: `${long}\n${manyLines}` };
  const draft = methodDraftFromWorkOrder(order, { id: 'm-9', model: 'z'.repeat(80) });
  assert.equal(draft.steps.length, 60);
  assert.equal(draft.steps[0].text.length, 1000);
  assert.equal(draft.steps[1].text, 'Step 1');
  assert.equal(draft.title.length, 160);
  assert.equal(draft.models.length, 1);
  assert.equal(draft.models[0].length, 60);
});

/* ------------------------------------------------------------------------- */
/* AI-readable badge text from a text-status object (SPEC-v4.md 4.2/4.3)     */
/* ------------------------------------------------------------------------- */

test('manualTextBadge: ok carries the page count', () => {
  assert.deepEqual(manualTextBadge({ status: 'ok', pages: 23, chars: 4021 }), {
    kind: 'ok',
    label: 'AI can read · 23 pages',
    hint: null,
  });
  assert.deepEqual(manualTextBadge({ status: 'ok', pages: 1, chars: 900 }), {
    kind: 'ok',
    label: 'AI can read · 1 page',
    hint: null,
  });
  // A nonsense page count still reads as zero pages, never NaN.
  assert.deepEqual(manualTextBadge({ status: 'ok', pages: 'many' }), {
    kind: 'ok',
    label: 'AI can read · 0 pages',
    hint: null,
  });
});

test('manualTextBadge: no_text is a scan with the Text-for-the-AI hint', () => {
  assert.deepEqual(manualTextBadge({ status: 'no_text' }), {
    kind: 'no_text',
    label: "Scanned — AI can't read",
    hint: 'Type the key specs into Text for the AI',
  });
});

test('manualTextBadge: pending, error and unknown shapes', () => {
  assert.deepEqual(manualTextBadge({ status: 'pending' }), { kind: 'pending', label: 'Reading…', hint: null });
  assert.deepEqual(manualTextBadge({ status: 'error' }), { kind: 'error', label: "Couldn't read", hint: null });
  assert.equal(manualTextBadge(null), null);
  assert.equal(manualTextBadge('ok'), null);
  assert.equal(manualTextBadge({ status: 'weird' }), null);
  assert.equal(manualTextBadge({}), null);
});

/* ------------------------------------------------------------------------- */
/* relatedLibraryItems sanity (SPEC-v4.md 4.1) — the machine section base   */
/* ------------------------------------------------------------------------- */

test('relatedLibraryItems still matches id, model and type-only rules', () => {
  const machine = { id: 'm-1', model: 'DDL-8700-7', type: 'single-needle' };
  const items = [
    { machineIds: ['m-1'] },
    { models: ['DDL 8700 7'] },
    { machineType: 'single-needle', models: [], machineIds: [] },
    { machineType: 'single-needle', models: ['MO-3716'] },
    { machineType: 'overlock', models: [], machineIds: [] },
  ];
  assert.deepEqual(relatedLibraryItems(machine, items), [items[0], items[1], items[2]]);
});

/* ------------------------------------------------------------------------- */
/* Source checks: navigation follows can('library') (SPEC-v4.md section 1)  */
/* ------------------------------------------------------------------------- */

const appSource = read('app.js');
const shellSource = read('index.html');
const helpSource = read('help.js');
const stylesSource = read('styles.css');
const swSource = read('sw.js');

test('navigation: sidebar Library link sits after Machines and maps to the library area', () => {
  const machinesAt = shellSource.indexOf('href="#/machines" data-tab="machines"');
  const libraryAt = shellSource.indexOf('href="#/library" data-tab="library"');
  assert.ok(machinesAt > 0, 'the Machines sidebar link exists');
  assert.ok(libraryAt > machinesAt, 'the Library link follows Machines');
  assert.ok(shellSource.includes('title="Library"'));

  // NAV_TAB_AREAS drives the hidden attribute for every sidebar link.
  const navBlock = appSource.slice(
    appSource.indexOf('const NAV_TAB_AREAS'),
    appSource.indexOf('function applyNavPermissions'),
  );
  assert.ok(navBlock.includes("library: 'library',"), 'library maps to the library area');

  // The phone More sheet lists Library behind the permission check.
  const moreBlock = appSource.slice(appSource.indexOf('function openMoreSheet'));
  assert.ok(
    moreBlock.includes("can('library') && { label: 'Library'"),
    'the More sheet entry is gated on can(library)',
  );
  assert.ok(appSource.includes('library: ['), 'NAV_ICONS has a library (book) icon');

  // The last-tab restore allows Library and still checks the permission.
  const restoreBlock = appSource.slice(appSource.indexOf('function restoreLastTab'));
  assert.ok(restoreBlock.includes("'library',"), 'Library is a restorable tab');
  assert.ok(
    appSource.slice(appSource.indexOf('const LAST_TAB_AREAS'), appSource.indexOf('function restoreLastTab')).includes(
      "library: 'library',",
    ),
    'restoring Library checks the library permission',
  );
});

test('routes: #/library pages are gated on the library permission', () => {
  const routeBlock = appSource.slice(appSource.indexOf("root === 'library'"), appSource.indexOf("root === 'pm'"));
  assert.ok(routeBlock.includes("noAccessPage('Library', 'Library')"), 'the area itself is gated');
  assert.ok(
    routeBlock.includes("can('library', 'write')") && routeBlock.includes('renderLibraryFormPage'),
    'the form routes need library write',
  );
  assert.ok(routeBlock.includes('renderLibraryDetail'), 'the detail route exists');
  assert.ok(appSource.includes("function renderLibrary(route)"), 'the list page exists');
  assert.ok(appSource.includes('searchLibraryItems(') && appSource.includes('filterLibraryItems('), 'the list uses the shared helpers');
});

test('manuals: detail badges come from the text-status endpoint and poll pending PDFs', () => {
  assert.ok(
    appSource.includes('`/api/files/${encodeURIComponent(fileId)}/text-status`'),
    'the badge reads GET /api/files/:id/text-status',
  );
  assert.ok(appSource.includes('manualTextBadge('), 'the badge text comes from the pure helper');
  // Re-check every 5 s while the page is open; stop when you leave it.
  const intervalMatch = appSource.match(/setInterval\(\(\) => \{[\s\S]*?\}, 5000\)/);
  assert.ok(
    intervalMatch && intervalMatch[0].includes('refresh();'),
    'pending PDFs re-check on a 5 s interval that calls refresh()',
  );
  assert.ok(appSource.includes('function stopLibraryBadgePolling()'));
  assert.ok(
    /renderLibraryDetail|manualPdfList/.test(appSource) &&
      appSource.includes('requestAnimationFrame(() => pdfList.start())'),
    'the manual page starts its badge reads once rendered',
  );
  // Leaving the route stops the polling.
  const renderStart = appSource.slice(appSource.indexOf('async function render()'), appSource.indexOf('async function render()') + 900);
  assert.ok(renderStart.includes('stopLibraryBadgePolling();'), 'render() stops stale badge polling');
  // Offline: no badge.
  assert.ok(appSource.includes('const online ='), 'the badge list checks connectivity');
});

test('manual form: reuses the attachments helper and the Text for the AI box is notes', () => {
  assert.ok(appSource.includes('function libraryFormBody({ existing = null, route = null } = {})'));
  assert.ok(
    appSource.includes('const attachmentsEditor = createAttachmentsEditor(base.attachments || []);'),
    'the library form reuses the attachments editor',
  );
  assert.ok(appSource.includes("field('Text for the AI', notesInput"), 'the manual form labels notes as Text for the AI');
  // Method-only fields never ride along on a manual (SPEC-v4.md 4.1).
  assert.ok(appSource.includes("if (!isManual) {"), 'method-only fields are set for methods only');
});

test('repair methods: steps editor reuses the checklist editor pattern', () => {
  assert.ok(appSource.includes('function createStepsEditor(initialSteps = [])'));
  const stepsBlock = appSource.slice(
    appSource.indexOf('function createStepsEditor'),
    appSource.indexOf('function createLibraryMachineChecks'),
  );
  for (const piece of ['Add step', 'Move step', 'splice(index - 1, 0, moved)', 'splice(index + 1, 0, moved)']) {
    assert.ok(stepsBlock.includes(piece), `the steps editor keeps the checklist pattern: ${piece}`);
  }
  assert.ok(stepsBlock.includes('At most 60 steps.'), 'steps are capped at 60');
});

test('machine detail: Library section lists relatedLibraryItems with methods first', () => {
  assert.ok(appSource.includes('function machineLibrarySection(machine)'));
  const sectionBlock = appSource.slice(
    appSource.indexOf('function machineLibrarySection'),
    appSource.indexOf('/* ---------- People: coworkers'),
  );
  assert.ok(
    sectionBlock.includes('relatedLibraryItems(machine, state.libraryItems)'),
    'the section matches through relatedLibraryItems',
  );
  assert.ok(
    sectionBlock.includes(".filter((item) => item.kind !== 'manual')"),
    'repair methods come before manuals',
  );
  assert.ok(
    sectionBlock.includes("`#/library/new?kind=method&machine=${encodeURIComponent(machine.id)}`"),
    'Add repair method is pre-filled with this machine id',
  );
  assert.ok(
    appSource.includes("prefill.models = [machine.model]") &&
      appSource.includes('prefill.machineIds = [machine.id]'),
    'the pre-fill uses the machine id and its model',
  );
  // The machine page keeps its existing Manuals section (v3).
  const machineDetail = appSource.slice(
    appSource.indexOf('function renderMachineDetail'),
    appSource.indexOf('/* ---------- Parts ----------'),
  );
  assert.ok(machineDetail.includes("sectionTitle('Manuals')"), 'the existing Manuals section stays');
  assert.ok(machineDetail.includes('machineLibrarySection(machine)'), 'the machine page renders the Library section');
});

test('service orders: completed orders offer Save as repair method behind library write', () => {
  const orderDetail = appSource.slice(
    appSource.indexOf('function renderJobDetail'),
    appSource.indexOf('/* ----- Attachment upload'),
  );
  assert.ok(orderDetail.includes("'Save as repair method'"), 'the button exists on the order detail');
  assert.ok(
    orderDetail.includes("can('library', 'write') && order.status === 'done'"),
    'it shows for completed orders with library write only',
  );
  assert.ok(
    orderDetail.includes("`#/library/new?kind=method&from=${encodeURIComponent(order.id)}`"),
    'it routes into the pre-filled method form',
  );
  assert.ok(appSource.includes('methodDraftFromWorkOrder(order, machineById(order.machineId))'), 'the draft comes from the pure helper');
});

test('help: the Library section exists and is wired into the page', () => {
  assert.ok(helpSource.includes("{ id: 'help-library', title: 'Library' }"));
  assert.ok(helpSource.includes('function helpLibrary(h)'));
  assert.ok(helpSource.includes('helpLibrary(h),'));
  assert.ok(helpSource.includes('Library,'), 'the roles area list mentions Library');
  assert.ok(helpSource.includes('Scanned — AI can’t read'), 'the help explains scanned PDFs');
  assert.ok(helpSource.includes('Text for the AI'), 'the help explains Text for the AI');
});

test('styles: badges, safety box, steps editor and filter grid are styled', () => {
  for (const selector of [
    '.lib-badge-ok',
    '.lib-badge-no_text',
    '.lib-badge-pending',
    '.lib-badge-error',
    '.safety-box',
    '.step-edit-row',
    '.chips-input',
    '.grid-3',
    '.method-steps',
  ]) {
    assert.ok(stylesSource.includes(`${selector} {`), `${selector} is styled`);
  }
});

test('service worker: the cache version is bumped past the shipped 38', () => {
  const match = swSource.match(/CACHE_VERSION\s*=\s*(\d+)/);
  assert.ok(match, 'CACHE_VERSION is defined');
  assert.ok(Number(match[1]) >= 39, `CACHE_VERSION ${match[1]} is at least 39`);
});

test('uploads: manual PDFs up to 50 MB, images stay 15 MB (SPEC-v4.md 4.2)', () => {
  assert.ok(appSource.includes('const PDF_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;'));
  assert.ok(appSource.includes('const maxBytes = isPdf ? PDF_UPLOAD_MAX_BYTES : FILE_UPLOAD_MAX_BYTES;'));
});