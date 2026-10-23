'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { ApiError } from '../server/records.js';
import { startServer } from '../server/server.js';
import {
  AI_ASSISTANT_USERNAME,
  CONTEXT_MAX_CHARS,
  OPENCODE_DISABLED_TOOLS,
  SYSTEM_PROMPT,
  aiSystemPrompt,
  buildContext,
  callOpenAICompatible,
  parseProposals,
  sendOpencodeMessage,
} from '../server/ai.js';

/**
 * V3-M7/M7b server tests (SPEC-v3.md section 9 with section 13): AI
 * configuration with secrets never returned, chat history scoped to the
 * owner, rate limiting, the opencode and OpenAI-compatible providers
 * against fake providers started with node:http on port 0, the read-only
 * context builder (only areas the user's role can Read), the per-role
 * system prompt, draft service order parsing and provider failures
 * mapping to a friendly 502.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const XRW = { 'X-Requested-With': 'maint-log' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OPENCODE_TOOL_NAMES = [
  'bash', 'edit', 'write', 'read', 'grep', 'glob', 'list', 'patch', 'multiedit',
  'webfetch', 'websearch', 'codesearch', 'todowrite', 'todoread', 'task', 'skill',
  'question', 'lsp', 'batch',
];

const OPENAI_API_KEY = 'sk-test-abc123';
const OPENCODE_PASSWORD = 'srv-pw-9';
const QUESTION = 'The Juki DDL-8700 keeps skipping stitches - what should I check first?';

let handle;
let base;
let anna; // admin
let ben; // tech
let cara; // tech, used for the rate-limit test
let dave; // custom role: everyone read, parts and contractorRates none
let eve; // custom role: contractors and machines read, contractorRates none
let fred; // custom role: contractors and contractorRates read
let gina; // custom role: everything read except serviceOrders
let hal; // custom role: machines read, aiAssistant none
let ivan; // custom role: serviceOrders read, machines none

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

const putAiConfig = (token, config) => api(token, '/api/ai/config', { method: 'PUT', body: config });

const chat = (token, message, conversationId) =>
  api(token, '/api/ai/chat', {
    method: 'POST',
    body: { message, ...(conversationId === undefined ? {} : { conversationId }) },
  });

// ---------------------------------------------------------------------------
// Fake AI providers (node:http servers on port 0)
// ---------------------------------------------------------------------------

function startFakeProvider() {
  const state = {
    chatRequests: [],
    chatStatus: 200,
    chatReply: { choices: [{ message: { content: 'plain reply' } }] },
    hangChat: false,
    sessionRequests: [],
    sessionCount: 0,
    messageRequests: [],
    messageStatus: 200,
    messageReply: {
      parts: [
        { type: 'text', text: 'Sure ' },
        { type: 'tool', name: 'bash' },
        { type: 'text', text: 'answer' },
      ],
    },
    hangMessage: false,
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let json = null;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw !== '') {
        try {
          json = JSON.parse(raw);
        } catch {
          json = raw;
        }
      }
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'POST' && req.url === '/chat/completions') {
        if (state.hangChat) return; // never answer: exercises the timeout path
        state.chatRequests.push({ authorization: req.headers.authorization, body: json });
        send(state.chatStatus, state.chatReply);
        return;
      }
      if (req.method === 'POST' && req.url === '/session') {
        state.sessionCount += 1;
        const id = `sess-${state.sessionCount}`;
        state.sessionRequests.push({ authorization: req.headers.authorization, body: json, id });
        send(200, { id });
        return;
      }
      const message = req.method === 'POST' && /^\/session\/([^/]+)\/message$/.exec(req.url);
      if (message) {
        if (state.hangMessage) return;
        state.messageRequests.push({
          sessionId: message[1],
          authorization: req.headers.authorization,
          body: json,
        });
        send(state.messageStatus, state.messageReply);
        return;
      }
      send(404, { error: 'not_found' });
    });
    req.on('error', () => res.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
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

const openaiFake = await startFakeProvider();
const opencodeFake = await startFakeProvider();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - n);
  return date.toISOString().slice(0, 10);
};

const machineDownId = crypto.randomUUID();
const machineBerninaId = crypto.randomUUID();
const machineRetiredId = crypto.randomUUID();

async function createFixtures() {
  await put(anna, 'machines', machineBerninaId, {
    name: 'Bernina 123 overlock',
    type: 'overlock-5',
    location: 'Line 2',
    status: 'running',
  });
  await put(anna, 'machines', machineDownId, {
    name: 'Juki DDL-8700',
    type: 'single-needle',
    location: 'Line 1',
    status: 'down',
  });
  await put(anna, 'machines', machineRetiredId, {
    name: 'Pfaff Press',
    type: 'pressing',
    status: 'retired',
  });
  await put(anna, 'parts', crypto.randomUUID(), {
    name: 'Belt DIN 2',
    partNumber: 'BD2',
    qtyOnHand: 2,
    minQty: 10,
    unit: 'pcs',
    location: 'Rack A4',
  });
  // PM task due today on a running machine (lastDoneAt + 30 days).
  await put(anna, 'pmTasks', crypto.randomUUID(), {
    title: 'PM Bernina looper oil',
    machineId: machineBerninaId,
    intervalDays: 30,
    lastDoneAt: daysAgo(30),
    instructions: 'Oil the looper, check the knife.',
  });
  // PM task on a retired machine: paused, never in the PM-due snapshot.
  await put(anna, 'pmTasks', crypto.randomUUID(), {
    title: 'PM Pfaff press cleaning',
    machineId: machineRetiredId,
    intervalDays: 7,
    lastDoneAt: null,
    instructions: 'Clean the press.',
  });
  await put(anna, 'coworkers', crypto.randomUUID(), {
    name: 'Maria Thread',
    role: 'Mechanic',
    shift: 'day',
    skills: 'Juki looper timing, needle replacement',
    active: true,
  });
  await put(anna, 'contractors', crypto.randomUUID(), {
    company: 'Ace Juki Service',
    trade: 'Juki service',
    contactName: 'Ravi Patel',
    phone: '+1 416 555 0134',
    hourlyRate: 126.5,
    machineIds: [machineDownId],
    active: true,
  });
  // Overdue service order (status not done, due yesterday).
  await put(anna, 'workOrders', crypto.randomUUID(), {
    title: 'Broken take-up lever',
    machineId: machineDownId,
    kind: 'breakdown',
    status: 'waiting-parts',
    priority: 'high',
    dueDate: daysAgo(1),
    problem: 'Lever snapped mid-shift; line stopped.',
  });
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'ai-test-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  base = handle.url;
  handle.store.createUser({
    username: 'anna',
    displayName: 'Anna Admin',
    role: 'admin',
    passwordHash: auth.hashPassword('anna-password-1'),
  });
  handle.store.createUser({
    username: 'ben',
    displayName: 'Ben Bolt',
    role: 'tech',
    passwordHash: auth.hashPassword('ben-password-1'),
  });
  handle.store.createUser({
    username: 'cara',
    displayName: 'Cara Coil',
    role: 'tech',
    passwordHash: auth.hashPassword('cara-password-1'),
  });
  // Custom roles for the AI context tests (SPEC-v3.md sections 9 and 13):
  // created through the store helpers, like the roles API would.
  const customRole = (name, permissions) =>
    handle.store.createRole({ name, permissions, updatedBy: null });
  const customUser = (username, roleId) =>
    handle.store.createUser({
      username,
      displayName: username,
      roleId,
      passwordHash: auth.hashPassword(`${username}-password-1`),
    });
  customUser('dave', customRole('AI No Parts', {
    serviceOrders: 'read',
    pm: 'read',
    machines: 'read',
    coworkers: 'read',
    contractors: 'read',
    aiAssistant: 'read',
  }).id);
  customUser('eve', customRole('AI No Rates', {
    machines: 'read',
    contractors: 'read',
  }).id);
  customUser('fred', customRole('AI Rates Reader', {
    contractors: 'read',
    contractorRates: 'read',
  }).id);
  customUser('gina', customRole('AI No Orders', {
    pm: 'read',
    machines: 'read',
    parts: 'read',
    coworkers: 'read',
    contractors: 'read',
  }).id);
  customUser('hal', customRole('AI Mute', {
    machines: 'read',
  }).id);
  customUser('ivan', customRole('AI Orders Only', {
    serviceOrders: 'read',
  }).id);
  anna = await login('anna', 'anna-password-1');
  ben = await login('ben', 'ben-password-1');
  cara = await login('cara', 'cara-password-1');
  dave = await login('dave', 'dave-password-1');
  eve = await login('eve', 'eve-password-1');
  fred = await login('fred', 'fred-password-1');
  gina = await login('gina', 'gina-password-1');
  hal = await login('hal', 'hal-password-1');
  ivan = await login('ivan', 'ivan-password-1');
  await createFixtures();
});

after(async () => {
  await handle.close();
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
  await openaiFake.close();
  await opencodeFake.close();
});

// ---------------------------------------------------------------------------
// Configuration API (admin-only, secrets never returned)
// ---------------------------------------------------------------------------

test('AI defaults: provider off, not enabled, config admin-only', async () => {
  const status = await api(ben, '/api/ai/status');
  assert.equal(status.res.status, 200);
  assert.deepEqual(status.body, { enabled: false });

  const unauth = await api(null, '/api/ai/status');
  assert.equal(unauth.res.status, 401);

  const config = await api(anna, '/api/ai/config');
  assert.equal(config.res.status, 200);
  assert.equal(config.body.provider, 'off');
  assert.equal(config.body.apiKeyConfigured, false);
  assert.equal(config.body.passwordConfigured, false);

  const forbidden = await api(ben, '/api/ai/config');
  assert.equal(forbidden.res.status, 403);
  const forbiddenPut = await putAiConfig(ben, { provider: 'off' });
  assert.equal(forbiddenPut.res.status, 403);
  const forbiddenTest = await api(ben, '/api/ai/test', { method: 'POST', body: {} });
  assert.equal(forbiddenTest.res.status, 403);
});

test('PUT /api/ai/config validation: provider enum, http(s) URLs, unknown fields', async () => {
  const badProvider = await putAiConfig(anna, { provider: 'skynet' });
  assert.equal(badProvider.res.status, 400);
  const badUrl = await putAiConfig(anna, { provider: 'openai-compatible', openai: { baseURL: 'ftp://10.0.0.1/v1' } });
  assert.equal(badUrl.res.status, 400);
  const badScheme = await putAiConfig(anna, {
    provider: 'opencode',
    opencode: { url: 'javascript:alert(1)' },
  });
  assert.equal(badScheme.res.status, 400);
  const unknownTop = await putAiConfig(anna, { provider: 'off', wat: true });
  assert.equal(unknownTop.res.status, 400);
  const unknownNested = await putAiConfig(anna, { openai: { apiKeyX: 'nope' } });
  assert.equal(unknownNested.res.status, 400);
});

test('PUT /api/ai/config: stores config, empty secret keeps, null clears, never returns secrets', async () => {
  const set = await putAiConfig(anna, {
    provider: 'openai-compatible',
    openai: { baseURL: openaiFake.url, model: 'test-model', apiKey: OPENAI_API_KEY },
  });
  assert.equal(set.res.status, 200);
  assert.equal(JSON.stringify(set.body).includes(OPENAI_API_KEY), false);

  const config = await api(anna, '/api/ai/config');
  assert.equal(config.body.provider, 'openai-compatible');
  assert.equal(config.body.openai.baseURL, openaiFake.url);
  assert.equal(config.body.openai.model, 'test-model');
  assert.equal(config.body.apiKeyConfigured, true);
  assert.equal(JSON.stringify(config.body).includes(OPENAI_API_KEY), false);

  const status = await api(ben, '/api/ai/status');
  assert.deepEqual(status.body, { enabled: true });

  // Empty secret keeps the stored value.
  const keep = await putAiConfig(anna, { openai: { apiKey: '' } });
  assert.equal(keep.res.status, 200);
  assert.equal(keep.body.apiKeyConfigured, true);

  // Switching the provider away does not reveal or lose the stored secret.
  const away = await putAiConfig(anna, { provider: 'off' });
  assert.equal(away.body.apiKeyConfigured, true);
  assert.equal(away.body.provider, 'off');

  // Restoring with no secrets section keeps using the stored key.
  const back = await putAiConfig(anna, { provider: 'openai-compatible' });
  assert.equal(back.body.apiKeyConfigured, true);

  const cleared = await putAiConfig(anna, { openai: { apiKey: null } });
  assert.equal(cleared.res.status, 200);
  assert.equal(cleared.body.apiKeyConfigured, false);

  // Re-set the key for the chat tests below.
  const reset = await putAiConfig(anna, { openai: { apiKey: OPENAI_API_KEY } });
  assert.equal(reset.body.apiKeyConfigured, true);
});

test('POST /api/ai/chat validation: message size, conversationId, unknown fields', async () => {
  const noMessage = await api(ben, '/api/ai/chat', { method: 'POST', body: {} });
  assert.equal(noMessage.res.status, 400);
  const empty = await api(ben, '/api/ai/chat', { method: 'POST', body: { message: '   ' } });
  assert.equal(empty.res.status, 400);
  const tooLong = await api(ben, '/api/ai/chat', {
    method: 'POST',
    body: { message: 'x'.repeat(2001) },
  });
  assert.equal(tooLong.res.status, 400);
  const badConversation = await api(ben, '/api/ai/chat', {
    method: 'POST',
    body: { message: 'hi', conversationId: 'not-a-uuid' },
  });
  assert.equal(badConversation.res.status, 400);
  const unknownField = await api(ben, '/api/ai/chat', {
    method: 'POST',
    body: { message: 'hi', hax: true },
  });
  assert.equal(unknownField.res.status, 400);
});

// ---------------------------------------------------------------------------
// OpenAI-compatible chat flow (SPEC-v3.md section 9)
// ---------------------------------------------------------------------------

test('openai-compatible chat: auth header, request body, read-only context, draft parsing', async () => {
  openaiFake.state.chatRequests.length = 0;
  openaiFake.state.chatReply = {
    choices: [
      {
        message: {
          content:
            `Check the looper timing and needle bar.
\`\`\`json
{"draftServiceOrder": {"title": "Fix skipping stitches", "machineId": "${machineDownId}", "priority": "high", "hax": true, "number": "SO-9999"}}
\`\`\`
Ask Ace Juki Service if it persists.`,
        },
      },
    ],
  };
  const { res, body } = await chat(ben, QUESTION);
  assert.equal(res.status, 200, `chat must succeed, got ${JSON.stringify(body)}`);
  assert.equal(typeof body.conversationId, 'string');
  assert.ok(UUID_RE.test(body.conversationId));
  assert.ok(String(body.reply).includes('Check the looper timing'));

  // Draft parsed from the fenced block: known fields kept, unknowns and the
  // server-owned number dropped (SPEC-v3.md section 9).
  assert.equal(body.draftServiceOrder.title, 'Fix skipping stitches');
  assert.equal(body.draftServiceOrder.machineId, machineDownId);
  assert.equal(body.draftServiceOrder.priority, 'high');
  assert.equal('hax' in body.draftServiceOrder, false);
  assert.equal('number' in body.draftServiceOrder, false);

  const captured = openaiFake.state.chatRequests[0];
  assert.ok(captured, 'fake provider saw the chat request');
  assert.equal(captured.authorization, `Bearer ${OPENAI_API_KEY}`);
  assert.equal(captured.body.model, 'test-model');
  assert.equal(captured.body.temperature, 0.2);
  const messages = captured.body.messages;
  assert.ok(Array.isArray(messages) && messages.length >= 2);
  assert.equal(messages[messages.length - 1].role, 'user');
  assert.equal(messages[messages.length - 1].content, QUESTION);
  const system = messages[0];
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes('proposals'));
  assert.ok(system.content.includes('READ-ONLY'));
  assert.ok(system.content.includes('Juki DDL-8700'), 'context includes the down machine');
  assert.ok(system.content.includes('PM Bernina looper oil'), 'context includes PM due within 7 days');
  assert.ok(system.content.includes('Belt DIN 2'), 'context includes low stock');
  assert.ok(system.content.includes('Broken take-up lever'), 'overdue order in the context');
  assert.ok(system.content.includes('Ace Juki Service'), 'contractor matched by keyword');

  // Secrets are never sent. The old admin-only rate rule is replaced by the
  // roles model (SPEC-v3.md 13.1): the Technician role has contractorRates
  // Write, so ben's context does include the rate.
  const capturedText = JSON.stringify(captured.body);
  assert.ok(capturedText.includes('126.5'), 'Technician role includes contractor hourlyRate');
  assert.equal(capturedText.includes('password_hash'), false);
  assert.equal(capturedText.includes('anna-password-1'), false);
  assert.equal(capturedText.includes('cara-password-1'), false);
});

test('openai-compatible chat: no fence or broken fence returns draft null, reply kept', async () => {
  openaiFake.state.chatReply = { choices: [{ message: { content: 'Maria can retip it tomorrow.' } }] };
  const first = await chat(ben, 'Who can retip the presser foot?');
  assert.equal(first.res.status, 200);
  assert.equal(first.body.draftServiceOrder, null);
  assert.ok(String(first.body.reply).length > 0);

  openaiFake.state.chatReply = {
    choices: [{ message: { content: 'text\n```json\n{"draftServiceOrder": [not json\n```' } }],
  };
  const second = await chat(ben, 'Draft it please');
  assert.equal(second.res.status, 200);
  assert.equal(second.body.draftServiceOrder, null);
  assert.ok(String(second.body.reply).includes('```'));
  openaiFake.state.chatReply = { choices: [{ message: { content: 'back to normal' } }] };
});

// ---------------------------------------------------------------------------
// History (own messages only)
// ---------------------------------------------------------------------------

test("AI history lists and clears only the signed-in user's messages", async () => {
  const first = await chat(ben, 'Hi, quick status?');
  assert.equal(first.res.status, 200);
  const conversationId = first.body.conversationId;
  const second = await chat(ben, 'And the Bernina?', conversationId);
  assert.equal(second.res.status, 200);
  assert.equal(second.body.conversationId, conversationId);

  const scoped = await api(ben, `/api/ai/history?conversationId=${conversationId}`);
  assert.equal(scoped.res.status, 200);
  assert.deepEqual(
    scoped.body.messages.map((message) => message.role),
    ['user', 'assistant', 'user', 'assistant']
  );
  assert.equal(scoped.body.messages[0].content, 'Hi, quick status?');

  // Another user sees nothing of this conversation (scope is always the
  // signed-in user, SPEC-v3.md section 9).
  const annaScoped = await api(anna, `/api/ai/history?conversationId=${conversationId}`);
  assert.equal(annaScoped.res.status, 200);
  assert.deepEqual(annaScoped.body, { messages: [] });

  const mine = await api(ben, '/api/ai/history');
  assert.ok(mine.body.messages.length >= 4);

  const badId = await api(ben, '/api/ai/history?conversationId=nope');
  assert.equal(badId.res.status, 400);

  const cleared = await api(ben, '/api/ai/history', { method: 'DELETE' });
  assert.equal(cleared.res.status, 200);
  assert.ok(cleared.body.ok === true && cleared.body.deleted >= 4);
  const after = await api(ben, `/api/ai/history?conversationId=${conversationId}`);
  assert.deepEqual(after.body, { messages: [] });
});

// ---------------------------------------------------------------------------
// opencode provider (SPEC-v3.md section 9)
// ---------------------------------------------------------------------------

test('opencode provider: session per conversation, Basic auth, all tools disabled, admin rate', async () => {
  const set = await putAiConfig(anna, {
    provider: 'opencode',
    opencode: {
      url: opencodeFake.url,
      password: OPENCODE_PASSWORD,
      providerID: 'prov-1',
      modelID: 'model-7',
    },
  });
  assert.equal(set.res.status, 200);
  assert.equal(set.body.passwordConfigured, true);
  assert.equal(JSON.stringify(set.body).includes(OPENCODE_PASSWORD), false);

  const enabled = await api(ben, '/api/ai/status');
  assert.deepEqual(enabled.body, { enabled: true });

  const sessionCountBefore = opencodeFake.state.sessionCount;
  const messageCountBefore = opencodeFake.state.messageRequests.length;
  // "juki" matches the down machine and the contractor, so the admin context
  // includes the contractor's hourlyRate.
  const question = 'What is coming up for the Juki machines and the line?';
  const first = await chat(anna, question);
  assert.equal(first.res.status, 200, `opencode chat must succeed, got ${JSON.stringify(first.body)}`);
  assert.equal(first.body.reply, 'Sure answer'); // concatenation of the text parts only
  assert.equal(first.body.draftServiceOrder, null);
  assert.equal(opencodeFake.state.sessionCount, sessionCountBefore + 1, 'one session created');

  const authHeader = `Basic ${Buffer.from(`opencode:${OPENCODE_PASSWORD}`).toString('base64')}`;
  const sessionRequest = opencodeFake.state.sessionRequests[0];
  assert.equal(sessionRequest.authorization, authHeader);
  const messageRequest = opencodeFake.state.messageRequests[messageCountBefore];
  assert.ok(messageRequest);
  assert.equal(messageRequest.authorization, authHeader);
  assert.deepEqual(messageRequest.body.model, { providerID: 'prov-1', modelID: 'model-7' });
  assert.ok(String(messageRequest.body.system).includes('proposals'));
  assert.ok(
    Array.isArray(messageRequest.body.parts) &&
      messageRequest.body.parts.some(
        (part) => part.type === 'text' && typeof part.text === 'string' && part.text.startsWith('Read-only data snapshot:')
      )
  );
  assert.ok(messageRequest.body.parts.some((part) => part.type === 'text' && part.text === question));

  // Every opencode tool is disabled in the request body.
  assert.deepEqual(messageRequest.body.tools, OPENCODE_DISABLED_TOOLS);
  assert.deepEqual(Object.keys(OPENCODE_DISABLED_TOOLS).sort(), [...OPENCODE_TOOL_NAMES].sort());
  assert.ok(Object.values(messageRequest.body.tools).every((tool) => tool === false));

  // Admins see contractor rates in the context; other users' chats stay out.
  const messageText = JSON.stringify(messageRequest.body);
  assert.ok(messageText.includes('126.5'), 'admin context includes hourlyRate');
  assert.equal(messageText.includes('skipping stitches'), false, "no other users' chats");
  assert.equal(messageText.includes('password_hash'), false);

  // Reuse the session: a second message in the same conversation does not
  // create another opencode session.
  const second = await chat(anna, 'And the parts?', first.body.conversationId);
  assert.equal(second.res.status, 200);
  assert.equal(opencodeFake.state.sessionCount, sessionCountBefore + 1, 'session reused');
  assert.equal(
    opencodeFake.state.messageRequests[opencodeFake.state.messageRequests.length - 1].sessionId,
    sessionRequest.id
  );

  // Test connection creates its own ephemeral session.
  const probe = await api(anna, '/api/ai/test', { method: 'POST', body: {} });
  assert.equal(probe.res.status, 200);
  assert.deepEqual(probe.body, { ok: true });
  assert.equal(opencodeFake.state.sessionCount, sessionCountBefore + 2);
});

// ---------------------------------------------------------------------------
// Provider failures (SPEC-v3.md section 9: friendly 502, no secrets)
// ---------------------------------------------------------------------------

test('provider error and timeout map to a friendly 502 without leaking secrets', async () => {
  // HTTP error through the API.
  await putAiConfig(anna, {
    provider: 'openai-compatible',
    openai: { baseURL: openaiFake.url, apiKey: OPENAI_API_KEY, model: 'test-model' },
  });
  openaiFake.state.chatStatus = 500;
  const failed = await chat(ben, 'Anyone there?');
  assert.equal(failed.res.status, 502);
  assert.equal(failed.body.error, 'ai_provider_error');
  assert.ok(typeof failed.body.message === 'string' && failed.body.message.length > 0);
  assert.equal(String(failed.body.message).includes(openaiFake.url), false);
  assert.equal(String(failed.body.message).includes(OPENAI_API_KEY), false);

  // Timeout at the provider level: short timeout against a hanging server.
  openaiFake.state.hangChat = true;
  opencodeFake.state.hangMessage = true;
  const is502 = (err) =>
    err instanceof ApiError && err.status === 502 && err.code === 'ai_provider_error' && err.message.length > 0;
  await assert.rejects(
    callOpenAICompatible(
      { baseURL: openaiFake.url, apiKey: 'k', model: 'm' },
      [{ role: 'user', content: 'hi' }],
      { timeout: 200 }
    ),
    is502
  );
  await assert.rejects(
    sendOpencodeMessage(
      { url: opencodeFake.url, password: null, providerID: 'p', modelID: 'm' },
      'sess-1',
      { system: 's', parts: [{ type: 'text', text: 'q' }] },
      { timeout: 200 }
    ),
    is502
  );
  openaiFake.state.hangChat = false;
  opencodeFake.state.hangMessage = false;

  // The test connection surfaces provider errors as 502 too, then recovers.
  const probeFailed = await api(anna, '/api/ai/test', { method: 'POST', body: {} });
  assert.equal(probeFailed.res.status, 502);
  openaiFake.state.chatStatus = 200;

  const probeHealthy = await api(anna, '/api/ai/test', { method: 'POST', body: {} });
  assert.equal(probeHealthy.res.status, 200);
  assert.deepEqual(probeHealthy.body, { ok: true });
});

// ---------------------------------------------------------------------------
// Rate limit: 20 messages per minute per user (SPEC-v3.md section 9)
// ---------------------------------------------------------------------------

test('AI chat rate limit: 20 per minute per user, then 429 with Retry-After', async () => {
  await putAiConfig(anna, { provider: 'off' });
  const failures = [];
  for (let i = 0; i < 20; i += 1) {
    const { res, body } = await chat(cara, `question number ${i}`);
    // The quota burns before the provider check: these fail as ai_disabled.
    assert.equal(res.status, 400, `message ${i} should reach the config check`);
    failures.push(body.error);
  }
  assert.ok(failures.every((code) => code === 'ai_disabled'));

  const blocked = await chat(cara, 'one more');
  assert.equal(blocked.res.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  const retryAfter = Number(blocked.res.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60);

  // Nothing was stored: the provider was off.
  const history = await api(cara, '/api/ai/history');
  assert.deepEqual(history.body, { messages: [] });

  // The limit is per user: ben (under the cap) still gets a real answer.
  await putAiConfig(anna, {
    provider: 'openai-compatible',
    openai: { baseURL: openaiFake.url, model: 'test-model', apiKey: OPENAI_API_KEY },
  });
  openaiFake.state.chatReply = { choices: [{ message: { content: 'still fine' } }] };
  const unaffected = await chat(ben, 'am I affected?');
  assert.equal(unaffected.res.status, 200);
  assert.equal(unaffected.body.reply, 'still fine');
});

// ---------------------------------------------------------------------------
// Context builder (unit-level, SPEC-v3.md section 9)
// ---------------------------------------------------------------------------

// Session-style user objects carrying {store, roleId} for can() (13.2).
// Lazy: `handle` only exists once the before() hook has started the server.
const contextUser = (username) => {
  const row = handle.store.getUserByUsername(username);
  return { ...row, roleId: row.role_id };
};
const techUser = () => contextUser('ben'); // Technician: write on every data area
const adminUser = () => contextUser('anna'); // Administrator: everything

test('buildContext: down machines, overdue orders, PM due, low stock; role-based rate; no secrets', () => {
  const tech = buildContext(handle.store, techUser(), 'What is wrong with the Juki line?');
  assert.ok(tech.includes('Down machines'));
  assert.ok(tech.includes('Juki DDL-8700'));
  assert.ok(tech.includes('Overdue service orders'));
  assert.ok(tech.includes('Broken take-up lever'));
  assert.ok(tech.includes('PM Bernina looper oil'));
  assert.ok(tech.includes('Belt DIN 2'));
  assert.ok(tech.includes('Ace Juki Service'), 'contractor matched by keyword');
  assert.ok(tech.includes('126.5'), 'Technician role sees contractor hourlyRate');
  assert.equal(tech.includes('password_hash'), false);
  assert.equal(tech.includes('anna-password-1'), false);
  assert.ok(tech.length <= 12000);

  const admin = buildContext(handle.store, adminUser(), 'What is wrong with the Juki line?');
  assert.ok(admin.includes('126.5'), 'Administrator sees hourlyRate');
  assert.ok(admin.length <= 12000);
});

test('buildContext: paused PM (retired machine) excluded from PM due', () => {
  const context = buildContext(handle.store, techUser(), 'Can anything slip?');
  assert.ok(context.includes('PM Bernina looper oil'));
  assert.equal(context.includes('PM Pfaff press cleaning'), false, 'retired machine PM stays paused');
});

test('buildContext: keyword matches find related records across stores', () => {
  const context = buildContext(handle.store, techUser(), 'Where are the bernina belts?');
  assert.ok(context.includes('Records matching words of the question'));
  assert.ok(context.includes('Bernina 123 overlock'));
  assert.ok(context.includes('Belt DIN 2'));
});

test('buildContext: capped at CONTEXT_MAX_CHARS even with many records', async () => {
  for (let i = 0; i < 40; i += 1) {
    const { res } = await put(anna, 'machines', crypto.randomUUID(), {
      name: `Filler machine ${String(i)}`,
      type: 'other',
      typeLabel: 'Filler type',
      notes: 'filler note '.repeat(60),
    });
    assert.equal(res.status, 200);
  }
  const context = buildContext(handle.store, techUser(), 'everything about filler machines and more words');
  assert.ok(context.length > 1000, 'cushion: context actually got big before capping');
  // V4-M5 (SPEC-v4.md section 5): the cap moved from 12,000 to 20,000.
  assert.ok(context.length <= CONTEXT_MAX_CHARS, `context must be capped, got ${context.length}`);
});

// ---------------------------------------------------------------------------
// AI context respects roles (SPEC-v3.md sections 9 and 13)
// ---------------------------------------------------------------------------

test('buildContext: parts none means no parts data, even when the question names a part', () => {
  const question = 'What about the Belt DIN 2 part?';
  const daveContext = buildContext(handle.store, contextUser('dave'), question);
  assert.equal(daveContext.includes('Belt DIN 2'), false, 'no part record for a parts-none role');
  assert.equal(daveContext.includes('BD2'), false, 'no part number either');
  assert.equal(daveContext.includes('Low-stock parts'), false, 'no low-stock section');
  assert.ok(daveContext.includes('Juki DDL-8700'), 'machines are still readable');
  // The same question does surface the part for a role that can read parts.
  assert.ok(buildContext(handle.store, techUser(), question).includes('Belt DIN 2'));
});

test('buildContext: contractors readable without contractorRates shows no hourlyRate', () => {
  const context = buildContext(handle.store, contextUser('eve'), 'Who services the Juki machines?');
  assert.ok(context.includes('Ace Juki Service'), 'contractor visible to a contractors-read role');
  assert.equal(context.includes('hourlyRate'), false, 'no rate key without contractorRates');
  assert.equal(context.includes('126.5'), false, 'no rate value without contractorRates');
});

test('buildContext: contractorRates read includes hourlyRate', () => {
  const context = buildContext(handle.store, contextUser('fred'), 'Who services the Juki machines and what do they charge?');
  assert.ok(context.includes('Ace Juki Service'));
  assert.ok(context.includes('hourlyRate'));
  assert.ok(context.includes('126.5'));
});

test('buildContext: serviceOrders none means no service orders anywhere in the snapshot', () => {
  const context = buildContext(handle.store, contextUser('gina'), 'Everything about the broken take-up lever on the Juki?');
  assert.equal(context.includes('Open service orders'), false);
  assert.equal(context.includes('Overdue service orders'), false);
  assert.equal(context.includes('Broken take-up lever'), false, 'no keyword match on hidden orders');
  assert.equal(context.includes('service order'), false, 'no matched-record entry either');
  assert.ok(context.includes('Juki DDL-8700'), 'down machines are still readable');
});

test('buildContext: an order on a machine the user cannot read shows "a machine"', () => {
  const context = buildContext(handle.store, contextUser('ivan'), 'What is broken on the line?');
  assert.ok(context.includes('Overdue service orders'), 'service orders are readable');
  assert.ok(context.includes('Broken take-up lever'));
  assert.ok(context.includes('"machine":"a machine"'), 'machine replaced by a placeholder');
  assert.ok(context.includes('"machineId":null'), 'no machine id leak');
  assert.equal(context.includes('Juki DDL-8700'), false, 'no machine name leak');
  assert.equal(context.includes('Down machines'), false, 'no machines section');
});

test('buildContext: Administrator sees everything', () => {
  const context = buildContext(handle.store, adminUser(), 'Everything about the Juki line: orders, PM, parts, people, contractors and rates?');
  for (const part of [
    'Overdue service orders',
    'Broken take-up lever',
    'Down machines',
    'Juki DDL-8700',
    'PM tasks due within 7 days',
    'PM Bernina looper oil',
    'Low-stock parts',
    'Belt DIN 2',
    'Maria Thread',
    'Ace Juki Service',
    '126.5',
  ]) {
    assert.ok(context.includes(part), `Administrator context includes ${part}`);
  }
});

test('aiSystemPrompt: names the areas hidden from the role, verbatim prompt otherwise', () => {
  const adminPrompt = aiSystemPrompt(handle.store, adminUser());
  assert.equal(adminPrompt, SYSTEM_PROMPT, 'nothing hidden, no extra note');
  assert.equal(adminPrompt.includes('does not have access'), false);

  const davePrompt = aiSystemPrompt(handle.store, contextUser('dave'));
  assert.ok(davePrompt.startsWith(SYSTEM_PROMPT));
  assert.ok(davePrompt.includes('does not have access'));
  assert.ok(davePrompt.includes('parts and stock'), 'hidden parts named');
  assert.ok(davePrompt.includes('contractor rates'), 'hidden rates named');

  const evePrompt = aiSystemPrompt(handle.store, contextUser('eve'));
  assert.ok(evePrompt.startsWith(SYSTEM_PROMPT));
  assert.ok(evePrompt.includes('contractor rates'), 'rates hidden although contractors are readable');
  assert.equal(evePrompt.includes('outside contractors'), false, 'readable areas are not named as hidden');
  // Machines hidden but contractors readable: both notes in place.
  assert.ok(aiSystemPrompt(handle.store, contextUser('ivan')).includes('machines'));

  const techPrompt = aiSystemPrompt(handle.store, techUser());
  assert.equal(techPrompt, SYSTEM_PROMPT, 'Technician reads every data area');
});

test('chat sends only readable areas in the context and the hidden-areas note in the prompt', async () => {
  const set = await putAiConfig(anna, {
    provider: 'openai-compatible',
    openai: { baseURL: openaiFake.url, model: 'test-model', apiKey: OPENAI_API_KEY },
  });
  assert.equal(set.res.status, 200);
  openaiFake.state.chatRequests.length = 0;
  openaiFake.state.chatReply = { choices: [{ message: { content: 'Sure thing.' } }] };
  const { res, body } = await chat(dave, 'Where are the bernina belts and what do they cost?');
  assert.equal(res.status, 200, `chat must succeed, got ${JSON.stringify(body)}`);

  const captured = openaiFake.state.chatRequests[0];
  assert.ok(captured, 'fake provider saw the chat request');
  const system = captured.body.messages[0];
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes('does not have access'));
  assert.ok(system.content.includes('parts and stock'));
  assert.ok(system.content.includes('contractor rates'));
  assert.ok(system.content.includes('Bernina 123 overlock'), 'readable machines stay in the context');
  assert.equal(system.content.includes('Belt DIN 2'), false, 'no parts data for a parts-none role');
  assert.equal(system.content.includes('126.5'), false, 'no rates for a rates-none role');
});

test('aiAssistant none: 403 on chat, status and history; Technician still allowed', async () => {
  const status = await api(hal, '/api/ai/status');
  assert.equal(status.res.status, 403);
  assert.equal(status.body.error, 'forbidden');
  assert.equal(status.body.area, 'aiAssistant');
  assert.equal(status.body.needed, 'read');

  const rejected = await api(hal, '/api/ai/chat', { method: 'POST', body: { message: 'hello there' } });
  assert.equal(rejected.res.status, 403);
  assert.equal(rejected.body.area, 'aiAssistant');

  const history = await api(hal, '/api/ai/history');
  assert.equal(history.res.status, 403);
  assert.equal(history.body.area, 'aiAssistant');

  // The chat 403 happens before the rate limit: hal burned no quota.
  const cleared = await api(hal, '/api/ai/history', { method: 'DELETE' });
  assert.equal(cleared.res.status, 403);

  // Technician has aiAssistant Write and keeps access (settings Write is
  // what /api/ai/config needs: Technician 403, Administrator 200).
  const techStatus = await api(ben, '/api/ai/status');
  assert.equal(techStatus.res.status, 200);
  const techConfig = await api(ben, '/api/ai/config');
  assert.equal(techConfig.res.status, 403);
  assert.equal(techConfig.body.area, 'settings');
  const adminConfig = await api(anna, '/api/ai/config');
  assert.equal(adminConfig.res.status, 200);
});

// ---------------------------------------------------------------------------
// Assistant edits (machines, service orders, PM tasks): the model only
// proposes, the user presses Apply, and the write is attributed to the
// dedicated AI Assistant account.
// ---------------------------------------------------------------------------

test('parseProposals: editable stores only, protected fields dropped, junk ignored', () => {
  const reply = [
    'Sure, I can do that.',
    '```json',
    JSON.stringify({
      proposals: [
        {
          store: 'machines',
          id: machineDownId,
          summary: 'Mark it running',
          fields: { status: 'running', number: 9, updatedBy: 'x' },
        },
        { store: 'parts', id: 'p-1', fields: { qtyOnHand: 1 } },
        { store: 'pmTasks', fields: { title: 'Oil', intervalDays: 45 } },
      ],
    }),
    '```',
  ].join('\n');
  const proposals = parseProposals(reply);
  assert.equal(proposals.length, 2);
  assert.deepEqual(proposals[0], {
    store: 'machines',
    id: machineDownId,
    summary: 'Mark it running',
    fields: { status: 'running' },
  });
  assert.equal(proposals[1].id, null);
  assert.deepEqual(proposals[1].fields, { title: 'Oil', intervalDays: 45 });
  assert.deepEqual(parseProposals('no json here'), []);
});

test('POST /api/ai/apply: updates as the AI Assistant user with an approved-by note', async () => {
  const applied = await api(anna, '/api/ai/apply', {
    method: 'POST',
    body: {
      store: 'machines',
      id: machineDownId,
      summary: 'Back to running',
      fields: { status: 'running', notes: 'guard replaced' },
    },
  });
  assert.equal(applied.res.status, 200);
  const assistant = handle.store.getUserByUsername(AI_ASSISTANT_USERNAME);
  assert.ok(assistant !== null, 'the AI Assistant user exists after the first apply');
  assert.equal(assistant.display_name, 'AI Assistant');
  assert.equal(Number(assistant.disabled), 1, 'the bot account cannot sign in');
  assert.equal(applied.body.record.updatedBy, assistant.id);
  assert.equal(applied.body.appliedBy.displayName, 'AI Assistant');
  assert.equal(applied.body.record.data.status, 'running');
  assert.equal(applied.body.record.data.notes, 'guard replaced');
  assert.equal(applied.body.record.data.name, 'Juki DDL-8700', 'untouched fields survive the merge');
  const historyRow = handle.store.db
    .prepare('SELECT user_id, note FROM history WHERE store = ? AND record_id = ? ORDER BY hid DESC LIMIT 1')
    .get('machines', machineDownId);
  assert.equal(historyRow.user_id, assistant.id);
  assert.match(historyRow.note, /approved by Anna Admin/);
});

test('POST /api/ai/apply: creates a record when no id is given', async () => {
  const created = await api(anna, '/api/ai/apply', {
    method: 'POST',
    body: {
      store: 'pmTasks',
      summary: 'New PM task',
      fields: { title: 'Clean bobbin case', machineId: machineBerninaId, intervalDays: 30 },
    },
  });
  assert.equal(created.res.status, 200);
  const assistant = handle.store.getUserByUsername(AI_ASSISTANT_USERNAME);
  assert.equal(created.body.record.createdBy, assistant.id);
  assert.equal(created.body.record.data.title, 'Clean bobbin case');
});

test('POST /api/ai/apply: a new service order gets its SO number and the bot as author', async () => {
  const created = await api(anna, '/api/ai/apply', {
    method: 'POST',
    body: {
      store: 'workOrders',
      summary: 'New service order',
      fields: {
        title: 'Juki oil leak',
        machineId: machineDownId,
        priority: 'high',
        status: 'open',
        category: 'mechanical',
      },
    },
  });
  assert.equal(created.res.status, 200);
  assert.ok(
    Number.isInteger(created.body.record.data.number) && created.body.record.data.number >= 1,
    'the server assigned the work order number',
  );
  const assistant = handle.store.getUserByUsername(AI_ASSISTANT_USERNAME);
  assert.equal(created.body.record.createdBy, assistant.id);
});

test('POST /api/ai/apply: requires write on the area and rejects bad proposals', async () => {
  const noWrite = await api(ivan, '/api/ai/apply', {
    method: 'POST',
    body: { store: 'machines', id: machineDownId, fields: { status: 'down' } },
  });
  assert.equal(noWrite.res.status, 403);

  const wrongStore = await api(anna, '/api/ai/apply', {
    method: 'POST',
    body: { store: 'parts', fields: { name: 'x' } },
  });
  assert.equal(wrongStore.res.status, 400);

  const onlyProtected = await api(anna, '/api/ai/apply', {
    method: 'POST',
    body: { store: 'machines', id: machineDownId, fields: { number: 7 } },
  });
  assert.equal(onlyProtected.res.status, 400);

  const invalidValue = await api(anna, '/api/ai/apply', {
    method: 'POST',
    body: { store: 'machines', id: machineDownId, fields: { type: 'sewing-robot' } },
  });
  assert.equal(invalidValue.res.status, 400, JSON.stringify(invalidValue.body));
});

test('POST /api/ai/chat returns the proposals parsed from the reply', async () => {
  const set = await putAiConfig(anna, {
    provider: 'openai-compatible',
    openai: { baseURL: openaiFake.url, model: 'test-model', apiKey: OPENAI_API_KEY },
  });
  assert.equal(set.res.status, 200);
  openaiFake.state.chatStatus = 200;
  openaiFake.state.chatReply = {
    choices: [
      {
        message: {
          content: [
            'I can open that ticket.',
            '```json',
            JSON.stringify({
              proposals: [
                { store: 'workOrders', fields: { title: 'Juki skipping stitches', machineId: machineDownId } },
              ],
            }),
            '```',
          ].join('\n'),
        },
      },
    ],
  };
  const response = await chat(anna, 'Please open a ticket for the Juki');
  assert.equal(response.res.status, 200);
  assert.equal(response.body.proposals.length, 1);
  assert.equal(response.body.proposals[0].store, 'workOrders');
  assert.equal(response.body.proposals[0].id, null);
  assert.equal(response.body.proposals[0].fields.title, 'Juki skipping stitches');
});