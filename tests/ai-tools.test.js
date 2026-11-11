// v6 assistant tools: the model calls tools itself (native function calling).
// Checks the access rules, the record/analysis tools, the private-network
// guard of the web tools, and a full chat round trip through a fake provider
// that first asks for a tool and then answers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from '../server/auth.js';
import { startServer } from '../server/server.js';
import { toolsSystemPrompt, SYSTEM_PROMPT } from '../server/ai.js';
import {
  htmlToText,
  isPrivateAddress,
  parseDuckDuckGo,
  pickPages,
  readableStores,
  runTool,
  toolContext,
  toolDefinitions,
} from '../server/aiTools.js';

const TMP = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const XRW = { 'X-Requested-With': 'maint-log' };

let handle;
let provider;
const replies = [];
const requests = [];

before(async () => {
  provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(replies.shift() ?? { choices: [{ message: { content: 'done' } }] }));
    });
  });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  handle = await startServer({ port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(TMP, 'ai-tools-')) });
  const s = handle.store;
  s.createUser({ username: 'ann', displayName: 'Ann Admin', role: 'admin', passwordHash: auth.hashPassword('ann-password-1') });
  s.createUser({ username: 'vic', displayName: 'Vic Viewer', roleId: s.getRoleByName('Viewer').id, passwordHash: auth.hashPassword('vic-password-1') });
  s.setSetting('ai.provider', 'openai-compatible');
  s.setSetting('ai.openai.baseURL', `http://127.0.0.1:${provider.address().port}`);
  s.setSetting('ai.openai.model', 'test-model');
});

after(async () => {
  await handle.close();
  await new Promise((r) => provider.close(r));
  fs.rmSync(handle.config.dataDir, { recursive: true, force: true });
});

const user = (name) => {
  const row = handle.store.getUserByUsername(name);
  return { id: row.id, roleId: row.role_id, displayName: row.display_name };
};

async function login(username, password) {
  const res = await fetch(`${handle.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ username, password }),
  });
  return res.headers.getSetCookie().find((v) => v.startsWith('sid=')).split(';')[0];
}

async function putRecord(cookie, store, data) {
  const id = crypto.randomUUID();
  const res = await fetch(`${handle.url}/api/records/${store}/${id}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ data }),
  });
  assert.equal(res.status, 200, `${store} saved`);
  return id;
}

test('tool access: the floor roster is never a tool store; viewers see only what they may read', () => {
  const ann = readableStores(handle.store, user('ann'));
  for (const hidden of ['floorMaps', 'floorStations', 'workerProfiles']) assert.ok(!ann.includes(hidden), hidden);
  assert.ok(ann.includes('workOrders') && ann.includes('machines'));
  const names = toolDefinitions(ann, { web: false }).map((t) => t.function.name);
  assert.deepEqual(names, ['query_records', 'aggregate_records', 'get_record', 'list_files', 'read_file']);
  assert.ok(toolDefinitions(ann, { web: true }).some((t) => t.function.name === 'web_search'));
});

test('query_records and aggregate_records: filters, machine names, groups', async () => {
  const ann = await login('ann', 'ann-password-1');
  const m1 = await putRecord(ann, 'machines', { name: 'Juki 7', type: 'single-needle', status: 'down' });
  const m2 = await putRecord(ann, 'machines', { name: 'Overlock 2', type: 'overlock-5', status: 'running' });
  for (const [machineId, status, hours] of [[m1, 'done', 2], [m1, 'open', 1], [m2, 'done', 3]]) {
    await putRecord(ann, 'workOrders', {
      title: 'Thread breaks',
      machineId,
      status,
      labour: [{ id: crypto.randomUUID(), kind: 'coworker', personId: 'p1', date: '2026-11-01', hours, note: '' }],
    });
  }
  const ctx = toolContext(handle.store, user('ann'), { web: false });

  const open = JSON.parse(await runTool(ctx, 'query_records', { store: 'workOrders', where: { status: { ne: 'done' } } }));
  assert.equal(open.total, 1);
  assert.equal(open.rows[0].machineName, 'Juki 7');

  const byMachine = JSON.parse(await runTool(ctx, 'aggregate_records', { store: 'workOrders', groupBy: 'machineId', valueField: 'labourHours' }));
  assert.deepEqual(byMachine.groups, [
    { group: 'Juki 7', count: 2, sum: 3, average: 1.5 },
    { group: 'Overlock 2', count: 1, sum: 3, average: 3 },
  ]);

  const denied = await runTool(ctx, 'query_records', { store: 'floorStations' });
  assert.match(denied, /^Error: Store "floorStations" is not available/);
  assert.match(await runTool(ctx, 'web_search', { query: 'x' }), /^Error: unknown tool/, 'web off: no web tool');
  assert.match(await runTool(ctx, 'query_records', '{bad json'), /not valid JSON/);
});

test('web guard: private, loopback and Tailscale addresses are refused', async () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.50', '172.20.0.1', '100.101.102.103', '169.254.1.1', '::1', 'fd00::1', '::ffff:192.168.0.1']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '142.250.72.14', '2606:4700::1111']) assert.equal(isPrivateAddress(a), false, a);
  const ctx = { ...toolContext(handle.store, user('ann'), { web: true }) };
  assert.match(await runTool(ctx, 'fetch_url', { url: 'http://127.0.0.1/api/me' }), /private network/);
  assert.match(await runTool(ctx, 'fetch_url', { url: 'http://192.168.1.50/' }), /private network/);
  assert.match(await runTool(ctx, 'fetch_url', { url: 'file:///etc/passwd' }), /Only http and https/);
  assert.match(await runTool(ctx, 'fetch_url', { url: 'http://example.com:2375/' }), /normal web ports/);
});

test('web helpers: DuckDuckGo results and page text', () => {
  const html =
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fjuki.com%2Fmanual.pdf&amp;rut=1">JUKI <b>DDL-8700</b> manual</a>' +
    '<a class="result__snippet" href="#">Thread trimmer &amp; timing</a>';
  assert.deepEqual(parseDuckDuckGo(html), [{ title: 'JUKI DDL-8700 manual', url: 'https://juki.com/manual.pdf', snippet: 'Thread trimmer & timing' }]);
  const page = htmlToText('<html><head><title>Part 401</title><script>x()</script></head><body><p>Solenoid&nbsp;stroke</p><p>5 mm</p></body></html>');
  assert.deepEqual(page, { title: 'Part 401', text: 'Solenoid stroke\n5 mm' });
  const pages = ['intro', 'thread trimmer solenoid stroke', 'bobbin', 'trimmer knife'];
  assert.match(pickPages(pages, { search: 'trimmer' }, 'M'), /page 2[\s\S]*page 4/);
  assert.match(pickPages(pages, { fromPage: 3, toPage: 9 }, 'M'), /showing 3-4/);
});

test('tools prompt: readLibrary blocks gone, web rule follows the setting', () => {
  const on = toolsSystemPrompt(SYSTEM_PROMPT, { web: true });
  assert.ok(!on.includes('readLibrary'));
  assert.match(on, /You can search the public web/);
  assert.match(on, /query_records/);
  assert.match(toolsSystemPrompt(SYSTEM_PROMPT, { web: false }), /Web access is turned off/);
});

test('chat round trip: the model calls a tool, gets the rows, then answers; steps are reported', async () => {
  const ann = await login('ann', 'ann-password-1');
  replies.push(
    {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'aggregate_records', arguments: '{"store":"machines","groupBy":"status"}' } }],
          },
        },
      ],
    },
    { choices: [{ message: { content: '**1 machine is down.**' } }] }
  );
  const before = requests.length;
  const res = await fetch(`${handle.url}/api/ai/chat`, {
    method: 'POST',
    headers: { cookie: ann, 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ message: 'How many machines are down?' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.reply, '**1 machine is down.**');
  assert.deepEqual(body.steps, ['Analysed machines by status']);
  const [first, second] = requests.slice(before);
  assert.ok(first.tools.some((t) => t.function.name === 'query_records'), 'tools offered');
  const toolMsg = second.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'c1');
  assert.match(toolMsg.content, /"group":"down","count":1/);
});

test('chat attachments: only your own uploaded PDFs', async () => {
  const ann = await login('ann', 'ann-password-1');
  const res = await fetch(`${handle.url}/api/ai/chat`, {
    method: 'POST',
    headers: { cookie: ann, 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ message: 'read this', attachments: [crypto.randomUUID()] }),
  });
  assert.equal(res.status, 400);
});

test('list_worker_skills: floor-map readers only, never phone or locker; skills prompt in English with the glossary', async () => {
  const { SKILLS_PROMPT, parseSkillUpdates } = await import('../server/ai.js');
  const ann = await login('ann', 'ann-password-1');
  const mapId = await putRecord(ann, 'floorMaps', { name: 'Main floor', width: 100, height: 100 });
  await putRecord(ann, 'floorStations', { mapId, code: 'SN 9', empId: '524', name: 'May Wu', zone: 'Line A' });
  await putRecord(ann, 'workerProfiles', { empId: '524', phone: '416-555-0100', locker: 'B-17', skillsExpert: ['binder'], efficiency: 91 });

  const ctx = toolContext(handle.store, user('ann'), { web: false });
  assert.ok(toolDefinitions(ctx.stores, { workers: ctx.workers }).some((t) => t.function.name === 'list_worker_skills'));
  const out = await runTool(ctx, 'list_worker_skills', { skill: 'binder', level: 'good' });
  assert.ok(!/416-555|B-17|phone|locker/.test(out), 'no contact data');
  const list = JSON.parse(out);
  assert.equal(list.total, 1);
  assert.deepEqual(list.workers[0].skills, { binder: 'expert' });
  assert.deepEqual(list.workers[0].stations, ['SN 9']);

  const noMap = { ...ctx, workers: false };
  assert.match(await runTool(noMap, 'list_worker_skills', {}), /cannot see the floor workers/);

  assert.match(SKILLS_PROMPT, /ALWAYS answer in English/);
  assert.match(SKILLS_PROMPT, /拉条\/包边\/滚边 = binder/);
  assert.match(SKILLS_PROMPT, /"skillUpdates"/);
  const updates = parseSkillUpdates('Done.\n```json\n{"skillUpdates": [{"empId": "524", "skills": {"binder": "good"}}, {"skills": {}}]}\n```');
  assert.deepEqual(updates, [{ empId: '524', skills: { binder: 'good' } }]);
});
