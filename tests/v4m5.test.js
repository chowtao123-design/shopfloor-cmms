'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { startServer } from '../server/server.js';
import {
  AI_ASSISTANT_USERNAME,
  CONTEXT_MAX_CHARS,
  LIBRARY_CONTEXT_MAX_CHARS,
  LIBRARY_HEADERS,
  SYSTEM_PROMPT,
  aiSystemPrompt,
  buildContext,
  detectQuestionMachines,
  manualChunksFor,
  parseProposals,
  splitIntoChunks,
  stripWatermarkLines,
} from '../server/ai.js';

/**
 * V4-M5 server tests (SPEC-v4.md section 5): the Library block inside the
 * AI context (machine detection, repair methods, ranked manual chunks with
 * page labels, watermark stripping, the 7,000-char budget, past fixes),
 * no library context without library Read, and repair-method proposals
 * (libraryItems in the sanitizer and POST /api/ai/apply, create only).
 * The chat path is exercised against a fake openai-compatible provider.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const XRW = { 'X-Requested-With': 'maint-log' };
const PDF_MIME = 'application/pdf';

// ---------------------------------------------------------------------------
// Fake openai-compatible provider (node:http on port 0, like ai.test.js)
// ---------------------------------------------------------------------------

function startFakeProvider() {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        state.requests.push({ authorization: req.headers.authorization, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            state.reply ?? { choices: [{ message: { content: 'plain reply' } }] },
          ),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    req.on('error', () => res.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () =>
          new Promise((done) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

const fake = await startFakeProvider();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOILER = [
  'Downloaded from www.Manualslib.com manuals search engine',
  'Please keep this manual for future reference',
].join('\n');

const PDF1_PAGES = [
  `${BOILER}\nTable of contents: general information, maintenance, error codes list.`,
  `${BOILER}\nGeneral safety precautions. Read this chapter before any service work.`,
  `${BOILER}\nError code E302: Upper thread break detected. Open the take-up lever cover and check the thread path, then clear the jam and rethread. Model DDL 8700-7.`,
  `${BOILER}\nIf an error occurs repeatedly, contact your dealer or service center.`,
  `${BOILER}\nWarranty information and service intervals on page 5.`,
  `${BOILER}\nMaintenance schedule: oil the needle bar weekly.`,
  `${BOILER}\nAdjusting the presser foot pressure and the feed dog height.`,
  `${BOILER}\nReplacing the needle DBx1 #14: power off first.`,
];

const PDF200_PAGES = Array.from({ length: 200 }, (_, page) =>
  Array.from({ length: 5 }, (_, line) =>
    `Service note ${page + 1}.${line}: the needle bar timing screw and the feed dog oil hook need checking when skipping stitches happen at high speed on the machine.`,
  ).join('\n'),
);

const NOTES_TEXT =
  'Text for the AI: needle DBx1 #14, thread path diagram, feed dog height 0.8 mm, presser foot pressure.';

const Q_A = 'What does error code E302 mean on the Juki DDL 8700-7?';
const Q_B = 'Why does the Juki DDL 8700-7 keep skipping stitches at high speed?';
const Q_C = 'The DDL 8700-7 keeps breaking thread, what fixed it before?';

const juki1Id = crypto.randomUUID();
const juki2Id = crypto.randomUUID();
const berninaId = crypto.randomUUID();
const partNeedleId = crypto.randomUUID();
const woOpenId = crypto.randomUUID();
const wo1Id = crypto.randomUUID();
const wo2Id = crypto.randomUUID();
const wo3Id = crypto.randomUUID();
const methodJukiId = crypto.randomUUID();
const methodBerninaId = crypto.randomUUID();
const manualJukiId = crypto.randomUUID();
const pdf1Id = crypto.randomUUID();
const pdf200Id = crypto.randomUUID();

let handle;
let base;
let ada; // admin
let tom; // technician (library write)
let uma; // custom role: everything read except library none

function setCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single === null ? [] : [single];
}

async function login(username, password) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ username, password }),
  });
  const sidCookie = setCookies(res).find((value) => value.startsWith('sid='));
  assert.ok(sidCookie, `login failed for ${username}`);
  return sidCookie.split(';')[0].slice('sid='.length);
}

async function api(token, pathname, { method = 'GET', body } = {}) {
  const headers = {
    ...(token === null ? {} : { cookie: `sid=${token}` }),
    ...XRW,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, body: json };
}

const put = (token, storeName, id, data) =>
  api(token, `/api/records/${storeName}/${id}`, { method: 'PUT', body: { data } });

const chat = (token, message) =>
  api(token, '/api/ai/chat', { method: 'POST', body: { message } });

const contextUser = (username) => {
  const row = handle.store.getUserByUsername(username);
  return { ...row, roleId: row.role_id };
};
const techUser = () => contextUser('tom');
const adminUser = () => contextUser('ada');

const soNumber = (id) => {
  const record = handle.store.listRecords('workOrders').find((row) => row.id === id);
  return `SO-${String(record.data.number).padStart(4, '0')}`;
};

async function createFixtures() {
  const iso = new Date().toISOString();
  for (const [fileId, name, pages] of [
    [pdf1Id, 'juki-8700-manual.pdf', PDF1_PAGES],
    [pdf200Id, 'juki-service-200.pdf', PDF200_PAGES],
  ]) {
    handle.store.insertFile({
      id: fileId,
      name,
      mime: PDF_MIME,
      size: 1024,
      sha256: 'v4m5',
      uploadedAt: iso,
    });
    handle.store.upsertFileText({
      fileId,
      status: 'ok',
      pages,
      chars: pages.join('\n').length,
      extractedAt: iso,
    });
  }

  await put(ada, 'machines', juki1Id, {
    name: 'Juki DDL-8700 Line 1',
    type: 'single-needle',
    model: 'DDL-8700-7',
    serial: 'JS-8700-001',
    status: 'running',
    attachments: [{ fileId: pdf200Id, name: 'juki-service-200.pdf', mime: PDF_MIME, size: 1024 }],
  });
  await put(ada, 'machines', juki2Id, {
    name: 'Juki DDL-8700 Line 2',
    type: 'single-needle',
    model: 'DDL-8700-7',
    status: 'running',
  });
  await put(ada, 'machines', berninaId, {
    name: 'Bernina B530 overlock',
    type: 'overlock-5',
    model: 'B530',
    status: 'running',
  });
  await put(ada, 'parts', partNeedleId, {
    name: 'DBx1 needle #14',
    partNumber: 'DBX1',
    qtyOnHand: 20,
    minQty: 5,
    unit: 'pcs',
    location: 'Rack A1',
  });

  // An open order keeps the "Open service orders" section in the context,
  // which the budget test slices at.
  await put(ada, 'workOrders', woOpenId, {
    title: 'Juki skipping stitches',
    machineId: juki1Id,
    kind: 'breakdown',
    status: 'open',
    priority: 'high',
    problem: 'Needle skips stitches at speed',
  });
  await put(ada, 'workOrders', wo1Id, {
    title: 'Skipping stitches at speed',
    machineId: juki1Id,
    kind: 'breakdown',
    status: 'done',
    priority: 'medium',
    problem: 'Needle thread skips stitches at speed',
    actionTaken: 'Re-timed the feed and replaced the needle',
    partsUsed: [{ partId: partNeedleId, qty: 2 }],
    completedAt: '2026-09-10',
  });
  await put(ada, 'workOrders', wo2Id, {
    title: 'Upper thread frays',
    machineId: juki2Id,
    kind: 'breakdown',
    status: 'done',
    priority: 'low',
    problem: 'Upper thread frays near the take-up lever',
    actionTaken: 'Adjusted needle bar timing',
    partsUsed: [],
    completedAt: '2026-09-02',
  });
  await put(ada, 'workOrders', wo3Id, {
    title: 'Handwheel wobbles',
    machineId: berninaId,
    kind: 'breakdown',
    status: 'done',
    priority: 'low',
    problem: 'Handwheel wobbles at idle',
    actionTaken: 'Bernina wheel replaced',
    partsUsed: [],
    completedAt: '2026-08-30',
  });

  await put(ada, 'libraryItems', methodJukiId, {
    kind: 'method',
    title: 'Thread breaks at high speed',
    models: ['DDL-8700-7'],
    tags: ['thread break'],
    symptom: 'Upper thread breaks when running fast',
    cause: 'Take-up lever timing drifted',
    steps: [
      { id: 'st1', text: 'Power off and unplug the machine' },
      { id: 'st2', text: 'Re-time the take-up lever' },
    ],
    toolsParts: 'Screwdriver, DBx1 needle',
    safety: 'Lock out at the wall breaker before opening covers',
  });
  await put(ada, 'libraryItems', methodBerninaId, {
    kind: 'method',
    title: 'Overknife replacement',
    models: ['B530'],
    tags: ['knife'],
    symptom: 'Knife dull and leaves threads',
    cause: 'Worn upper knife',
    steps: [{ id: 'st1', text: 'Remove the knife cover screw' }],
    toolsParts: 'Torx driver',
    safety: 'Unplug the machine first',
  });
  await put(ada, 'libraryItems', manualJukiId, {
    kind: 'manual',
    title: 'Juki DDL-8700 manual',
    models: ['DDL-8700-7'],
    attachments: [{ fileId: pdf1Id, name: 'juki-8700-manual.pdf', mime: PDF_MIME, size: 1024 }],
    notes: NOTES_TEXT,
  });
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'v4m5-test-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  base = handle.url;
  handle.store.createUser({
    username: 'ada',
    displayName: 'Ada Admin',
    role: 'admin',
    passwordHash: auth.hashPassword('ada-password-1'),
  });
  handle.store.createUser({
    username: 'tom',
    displayName: 'Tom Tech',
    role: 'tech',
    passwordHash: auth.hashPassword('tom-password-1'),
  });
  const libNoneRole = handle.store.createRole({
    name: 'V4M5 Library None',
    permissions: {
      machines: 'read',
      serviceOrders: 'read',
      parts: 'read',
      library: 'none',
      aiAssistant: 'read',
    },
    updatedBy: null,
  });
  handle.store.createUser({
    username: 'uma',
    displayName: 'Uma Viewer',
    roleId: libNoneRole.id,
    passwordHash: auth.hashPassword('uma-password-1'),
  });
  ada = await login('ada', 'ada-password-1');
  tom = await login('tom', 'tom-password-1');
  uma = await login('uma', 'uma-password-1');
  await createFixtures();
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
  await fake.close();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('detectQuestionMachines: name, model with different spacing, serial, SO number', () => {
  const machines = [
    { id: 'm-a', data: { name: 'Juki DDL-8700 Line 1', model: 'DDL-8700-7', serial: 'JS-8700-001' } },
    { id: 'm-b', data: { name: 'Juki DDL-8700 Line 2', model: 'DDL-8700-7' } },
    { id: 'm-c', data: { name: 'Bernina B530', model: 'B530' } },
  ];
  const ids = (list) => list.map((record) => record.id);
  assert.deepEqual(ids(detectQuestionMachines('how do I time the ddl 8700-7?', machines, [])), [
    'm-a',
    'm-b',
  ], 'model matched ignoring spaces and dashes');
  assert.deepEqual(ids(detectQuestionMachines('the JS-8700-001 makes a grinding noise', machines, [])), [
    'm-a',
  ], 'serial matched');
  assert.deepEqual(
    ids(detectQuestionMachines('who fixed what on SO 42?', machines, [
      { data: { number: 42, machineId: 'm-c' } },
      { data: { number: 41, machineId: 'm-a' } },
    ])),
    ['m-c'],
    'the machine of the mentioned SO number',
  );
  assert.deepEqual(ids(detectQuestionMachines('total guess about nothing', machines, [])), []);
});

test('stripWatermarkLines: manualslib line and more-than-half-page boilerplate go', () => {
  const pages = [
    'Keep this page.\nDownloaded from www.Manualslib.com manuals search engine\nbody one',
    'Keep this page.\nDownloaded from www.Manualslib.com manuals search engine\nbody two',
    'Keep this page.\nLost in half the file only\nbody three',
    'Lost in half the file only\nbody four',
  ];
  const stripped = stripWatermarkLines(pages);
  assert.equal(stripped.some((page) => page.includes('Manualslib')), false, 'the manualslib line is stripped everywhere');
  assert.equal(
    stripped.some((page) => page.includes('Keep this page.')),
    false,
    'a line on more than half the pages (3 of 4) is stripped',
  );
  // 'Lost in half the file only' is on 2 of 4 pages: exactly half, kept.
  assert.equal(stripped[2].includes('Lost in half the file only'), true);
  assert.equal(stripped[3].includes('Lost in half the file only'), true);
  assert.ok(stripped[0].includes('body one'));
});

test('splitIntoChunks: ~1,200-char chunks on line boundaries', () => {
  const chunks = splitIntoChunks(`${'x'.repeat(700)}\n${'y'.repeat(700)}\n${'z'.repeat(700)}`);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [700, 700, 700]);
  const small = splitIntoChunks('aa\nbb\ncc', 4);
  assert.deepEqual(small, ['aa', 'bb', 'cc']);
});

test('manualChunksFor: pages are chunked once per fileId and cached', () => {
  const fileId = `cache-${crypto.randomUUID()}`;
  const chunks1 = manualChunksFor(fileId, ['page one line a\npage one line b', 'page two']);
  assert.deepEqual(chunks1, [
    { page: 1, text: 'page one line a\npage one line b' },
    { page: 2, text: 'page two' },
  ]);
  // A second call with different input returns the cached split (pages
  // never change for a file), proving the cache path.
  const chunks2 = manualChunksFor(fileId, ['totally different pages']);
  assert.deepEqual(chunks2, chunks1);
});

// ---------------------------------------------------------------------------
// buildContext: the Library block (SPEC-v4.md section 5)
// ---------------------------------------------------------------------------

test('buildContext: Library block sits after the shop totals and matches the model', () => {
  const context = buildContext(handle.store, techUser(), 'How do I time the ddl 8700-7?');
  const totalsAt = context.indexOf('Shop totals');
  const libraryAt = context.indexOf(LIBRARY_HEADERS.block);
  assert.ok(libraryAt > totalsAt, 'Library block comes after the shop totals');
  assert.ok(context.includes('[Repair method: Thread breaks at high speed]'), 'the matched method is there in full');
  assert.ok(context.includes('models: DDL-8700-7'));
  assert.ok(context.includes('symptom: Upper thread breaks when running fast'));
  assert.ok(context.includes('cause: Take-up lever timing drifted'));
  assert.ok(context.includes('steps: 1. Power off and unplug the machine 2. Re-time the take-up lever'));
  assert.ok(context.includes('tools & parts: Screwdriver, DBx1 needle'));
  assert.ok(context.includes('safety: Lock out at the wall breaker before opening covers'));
  assert.equal(context.includes('[Repair method: Overknife replacement]'), false, 'other machines stay out');
});

test('buildContext: the chunk with the mentioned error code E302 ranks first; watermarks stripped', () => {
  const context = buildContext(handle.store, techUser(), Q_A);
  const firstManual = context.indexOf('[Manual:');
  assert.ok(firstManual > -1, 'manual excerpts present');
  assert.equal(
    context.slice(firstManual, firstManual + '[Manual: Juki DDL-8700 manual, p. 3]'.length),
    '[Manual: Juki DDL-8700 manual, p. 3]',
    'the page containing E302 is cited first',
  );
  assert.ok(context.includes('Upper thread break detected'), 'the error-code text itself stays');
  assert.equal(context.includes('Manualslib'), false, 'the manualslib watermark never reaches the model');
  assert.equal(
    context.includes('Please keep this manual for future reference'),
    false,
    'a line repeated on more than half the pages is stripped',
  );
});

test('buildContext: a 200-page manual stays within the 7,000-char library budget', () => {
  const context = buildContext(handle.store, techUser(), Q_B);
  assert.ok(context.length <= CONTEXT_MAX_CHARS, `context capped at ${CONTEXT_MAX_CHARS}, got ${context.length}`);
  const start = context.indexOf(LIBRARY_HEADERS.block);
  assert.ok(start > -1, 'library block present');
  const end = context.indexOf('\nOpen service orders');
  assert.ok(end > start, 'the extract follows the library block (open order fixture)');
  const slice = context.slice(start, end);
  assert.ok(
    slice.length <= LIBRARY_CONTEXT_MAX_CHARS,
    `library block within ${LIBRARY_CONTEXT_MAX_CHARS}, got ${slice.length}`,
  );
  assert.ok(context.includes('[Manual: juki-service-200.pdf, p. 1]'), 'the top-scoring manual page is cited');
  const cited = context.split('[Manual: juki-service-200.pdf').length - 1;
  assert.ok(cited >= 1 && cited <= 10, `only a handful of the 200 pages fit: ${cited}`);
});

test('buildContext: past fixes are the last 5 completed orders of those machines', () => {
  const context = buildContext(handle.store, techUser(), Q_C);
  assert.ok(context.includes(LIBRARY_HEADERS.pastFixes), 'past fixes section present');
  assert.ok(context.includes('[Notes: Juki DDL-8700 manual]'), 'notes count as one labelled chunk');
  assert.ok(context.includes(`[Past fix: ${soNumber(wo1Id)} · Juki DDL-8700 Line 1`), 'done order of the matched machine');
  assert.ok(context.includes('Re-timed the feed and replaced the needle'), 'action taken included');
  assert.ok(context.includes('DBx1 needle #14 (2)'), 'parts used are named with quantity');
  assert.ok(context.includes(`[Past fix: ${soNumber(wo2Id)} · Juki DDL-8700 Line 2`), 'same-model machine fixes included');
  assert.ok(context.includes('Adjusted needle bar timing'), 'same-model action included');
  assert.equal(context.includes('Bernina wheel replaced'), false, 'other machines stay out');
  assert.equal(context.includes('Handwheel wobbles'), false);
  assert.equal(context.includes(soNumber(woOpenId)), false, 'the open order is not a past fix');
});

test('buildContext: the Library block says plainly when nothing matches', () => {
  const context = buildContext(handle.store, techUser(), 'Which paint suits the lunch room?');
  assert.ok(context.includes(LIBRARY_HEADERS.empty));
});

test('buildContext: no Library block without library read; readable areas still there', () => {
  const context = buildContext(handle.store, contextUser('uma'), Q_B);
  assert.equal(context.includes(LIBRARY_HEADERS.block), false, 'no library block');
  assert.equal(context.includes('[Repair method:'), false);
  assert.equal(context.includes('[Manual:'), false);
  assert.equal(context.includes('[Notes:'), false);
  assert.ok(context.includes('Shop totals'), 'the rest of the snapshot is intact');
  assert.ok(context.includes('Juki DDL-8700 Line 1'), 'machines are still readable');
  const prompt = aiSystemPrompt(handle.store, contextUser('uma'));
  assert.ok(prompt.includes('does not have access'), 'the hidden-area note names the library');
  assert.ok(prompt.includes('repair library'));
  assert.equal(aiSystemPrompt(handle.store, techUser()), SYSTEM_PROMPT, 'Technician has library write: no note');
});

test('SYSTEM_PROMPT: library first, cite the labels, simple checks first, lockout', () => {
  const prompt = aiSystemPrompt(handle.store, adminUser());
  assert.ok(prompt.includes('build the answer on the "Library" part of the snapshot first'));
  assert.ok(prompt.includes('Cite the source next to each fact'));
  assert.ok(prompt.includes('simple, non-invasive checks first'));
  assert.ok(/power off and lock out the machine/.test(prompt));
  assert.ok(prompt.includes('libraryItems'), 'the proposal protocol allows repair methods');
  assert.ok(prompt.includes('save a fix as a repair method after the user confirms the repair worked'));
});

// ---------------------------------------------------------------------------
// Proposals (SPEC-v4.md section 5): libraryItems create-only
// ---------------------------------------------------------------------------

test('parseProposals: libraryItems kept for kind method only; protected fields dropped', () => {
  const reply = [
    'Sure.',
    '```json',
    JSON.stringify({
      proposals: [
        {
          store: 'libraryItems',
          fields: {
            kind: 'method',
            title: 'Fix',
            steps: [{ id: 'a', text: 'Do it' }],
            number: 4,
            updatedBy: 'x',
          },
        },
        { store: 'libraryItems', fields: { kind: 'manual', title: 'Nope' } },
        { store: 'parts', fields: { name: 'x' } },
        { store: 'machines', id: juki1Id, summary: 'Down', fields: { status: 'down', version: 9 } },
      ],
    }),
    '```',
  ].join('\n');
  const proposals = parseProposals(reply);
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].store, 'libraryItems');
  assert.equal(proposals[0].id, null, 'create-only: no existing id needed');
  assert.equal(proposals[0].fields.kind, 'method');
  assert.equal('number' in proposals[0].fields, false);
  assert.equal('updatedBy' in proposals[0].fields, false);
  assert.equal(proposals[1].store, 'machines');
  assert.deepEqual(proposals[1].fields, { status: 'down' });
});

test('POST /api/ai/apply: libraryItems creates a repair method attributed to the AI Assistant', async () => {
  const applied = await api(ada, '/api/ai/apply', {
    method: 'POST',
    body: {
      store: 'libraryItems',
      summary: 'Save the fix we just did',
      fields: {
        kind: 'method',
        title: 'Skip stitches fix at speed',
        symptom: 'Needle thread skips stitches at speed',
        cause: 'Feed timing off',
        steps: [{ id: 's1', text: 'Re-time the feed dog' }],
        toolsParts: 'Screwdriver',
        safety: 'Power off before covers come off',
        models: ['DDL-8700-7'],
      },
    },
  });
  assert.equal(applied.res.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.record.store, 'libraryItems');
  assert.equal(applied.body.record.data.kind, 'method');
  assert.equal(applied.body.record.data.title, 'Skip stitches fix at speed');
  assert.deepEqual(applied.body.record.data.models, ['DDL-8700-7']);
  assert.deepEqual(applied.body.record.data.steps, [{ id: 's1', text: 'Re-time the feed dog' }]);
  const assistant = handle.store.getUserByUsername(AI_ASSISTANT_USERNAME);
  assert.ok(assistant !== null, 'the AI Assistant user exists');
  assert.equal(applied.body.record.createdBy, assistant.id);
  assert.equal(applied.body.record.updatedBy, assistant.id);
  assert.equal(applied.body.appliedBy.displayName, 'AI Assistant');
  const historyRow = handle.store.db
    .prepare('SELECT user_id, note FROM history WHERE store = ? AND record_id = ? ORDER BY hid DESC LIMIT 1')
    .get('libraryItems', applied.body.record.id);
  assert.equal(historyRow.user_id, assistant.id, 'history attributes the assistant');
  assert.match(historyRow.note, /approved by Ada Admin/);
});

test('POST /api/ai/apply: kind manual, an existing id and missing write are rejected', async () => {
  const manualKind = await api(ada, '/api/ai/apply', {
    method: 'POST',
    body: { store: 'libraryItems', summary: 'A manual', fields: { kind: 'manual', title: 'Nope' } },
  });
  assert.equal(manualKind.res.status, 400);
  assert.equal(manualKind.body.error, 'bad_request');

  const onExisting = await api(ada, '/api/ai/apply', {
    method: 'POST',
    body: {
      store: 'libraryItems',
      id: methodJukiId,
      summary: 'Retitle it',
      fields: { kind: 'method', title: 'New title' },
    },
  });
  assert.equal(onExisting.res.status, 400, 'an id that exists is refused (create only)');
  const before = handle.store.getRecord('libraryItems', methodJukiId);
  assert.equal(JSON.parse(before.data).title, 'Thread breaks at high speed', 'nothing was written');

  const noWrite = await api(uma, '/api/ai/apply', {
    method: 'POST',
    body: { store: 'libraryItems', summary: 'Save', fields: { kind: 'method', title: 'Uma method' } },
  });
  assert.equal(noWrite.res.status, 403, 'library write is checked for the approving user');
});

// ---------------------------------------------------------------------------
// Chat through the fake provider
// ---------------------------------------------------------------------------

test('POST /api/ai/chat: library text reaches the provider; libraryItems proposal parsed', async () => {
  const set = await api(ada, '/api/ai/config', {
    method: 'PUT',
    body: {
      provider: 'openai-compatible',
      openai: { baseURL: fake.url, model: 'test-model', apiKey: 'sk-v4m5-test' },
    },
  });
  assert.equal(set.res.status, 200, JSON.stringify(set.body));
  fake.state.requests.length = 0;
  fake.state.reply = {
    choices: [
      {
        message: {
          content: [
            'The fix worked - saving it as a repair method.',
            '```json',
            JSON.stringify({
              proposals: [
                {
                  store: 'libraryItems',
                  summary: 'Save the fix',
                  fields: {
                    kind: 'method',
                    title: 'Skipping stitches fix',
                    symptom: 'Skips stitches at speed',
                    steps: [{ id: 's1', text: 'Re-time the feed' }],
                  },
                },
              ],
            }),
            '```',
          ].join('\n'),
        },
      },
    ],
  };
  const { res, body } = await chat(tom, 'Please save the ddl 8700-7 skip-stitch fix as a repair method');
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.proposals.length, 1);
  assert.equal(body.proposals[0].store, 'libraryItems');
  assert.equal(body.proposals[0].fields.kind, 'method');
  assert.equal(body.draftServiceOrder, null);

  const captured = fake.state.requests[0];
  assert.ok(captured, 'the fake provider saw the chat request');
  assert.equal(captured.authorization, 'Bearer sk-v4m5-test');
  const system = captured.body.messages[0];
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes(LIBRARY_HEADERS.block), 'the library block reaches the provider');
  assert.ok(system.content.includes('[Repair method: Thread breaks at high speed]'));
  assert.ok(system.content.includes('[Manual: Juki DDL-8700 manual'));
});