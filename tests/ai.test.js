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
  OPENCODE_DISABLED_TOOLS,
  buildContext,
  callOpenAICompatible,
  sendOpencodeMessage,
} from '../server/ai.js';

/**
 * V3-M7 server tests (SPEC-v3.md section 9): AI configuration with secrets
 * never returned, chat history scoped to the owner, rate limiting, the
 * opencode and OpenAI-compatible providers against fake providers started
 * with node:http on port 0, the read-only context builder, draft service
 * order parsing and provider failures mapping to a friendly 502.
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
  anna = await login('anna', 'anna-password-1');
  ben = await login('ben', 'ben-password-1');
  cara = await login('cara', 'cara-password-1');
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
  assert.ok(system.content.includes('draftServiceOrder'));
  assert.ok(system.content.includes('READ-ONLY'));
  assert.ok(system.content.includes('Juki DDL-8700'), 'context includes the down machine');
  assert.ok(system.content.includes('PM Bernina looper oil'), 'context includes PM due within 7 days');
  assert.ok(system.content.includes('Belt DIN 2'), 'context includes low stock');
  assert.ok(system.content.includes('Broken take-up lever'), 'overdue order in the context');
  assert.ok(system.content.includes('Ace Juki Service'), 'contractor matched by keyword');

  // Secrets and admin-only rates are never sent for a tech user (SPEC-v3.md 5, 9).
  const capturedText = JSON.stringify(captured.body);
  assert.equal(capturedText.includes('126.5'), false, 'contractor hourlyRate hidden from techs');
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
  assert.ok(String(messageRequest.body.system).includes('draftServiceOrder'));
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

const techUser = { id: 'u-tech', username: 'ben', display_name: 'Ben Bolt', role: 'tech' };
const adminUser = { id: 'u-admin', username: 'anna', display_name: 'Anna Admin', role: 'admin' };

test('buildContext: down machines, overdue orders, PM due, low stock; admin-only rate; no secrets', () => {
  const tech = buildContext(handle.store, techUser, 'What is wrong with the Juki line?');
  assert.ok(tech.includes('Down machines'));
  assert.ok(tech.includes('Juki DDL-8700'));
  assert.ok(tech.includes('Overdue service orders'));
  assert.ok(tech.includes('Broken take-up lever'));
  assert.ok(tech.includes('PM Bernina looper oil'));
  assert.ok(tech.includes('Belt DIN 2'));
  assert.ok(tech.includes('Ace Juki Service'), 'contractor matched by keyword');
  assert.equal(tech.includes('126.5'), false, 'hourlyRate hidden from techs');
  assert.equal(tech.includes('password_hash'), false);
  assert.equal(tech.includes('anna-password-1'), false);
  assert.ok(tech.length <= 12000);

  const admin = buildContext(handle.store, adminUser, 'What is wrong with the Juki line?');
  assert.ok(admin.includes('126.5'), 'admins see hourlyRate');
  assert.ok(admin.length <= 12000);
});

test('buildContext: paused PM (retired machine) excluded from PM due', () => {
  const context = buildContext(handle.store, techUser, 'Can anything slip?');
  assert.ok(context.includes('PM Bernina looper oil'));
  assert.equal(context.includes('PM Pfaff press cleaning'), false, 'retired machine PM stays paused');
});

test('buildContext: keyword matches find related records across stores', () => {
  const context = buildContext(handle.store, techUser, 'Where are the bernina belts?');
  assert.ok(context.includes('Records matching words of the question'));
  assert.ok(context.includes('Bernina 123 overlock'));
  assert.ok(context.includes('Belt DIN 2'));
});

test('buildContext: capped at 12000 characters even with many records', async () => {
  for (let i = 0; i < 40; i += 1) {
    const { res } = await put(anna, 'machines', crypto.randomUUID(), {
      name: `Filler machine ${String(i)}`,
      type: 'other',
      typeLabel: 'Filler type',
      notes: 'filler note '.repeat(60),
    });
    assert.equal(res.status, 200);
  }
  const context = buildContext(handle.store, techUser, 'everything about filler machines and more words');
  assert.ok(context.length > 1000, 'cushion: context actually got big before capping');
  assert.ok(context.length <= 12000, `context must be capped, got ${context.length}`);
});