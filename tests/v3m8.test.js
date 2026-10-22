import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AI_OFFLINE_TEXT,
  AI_PRIVACY_NOTICE,
  AI_RATE_LIMIT_TEXT,
  AI_STARTERS,
  MESSAGE_MAX_CHARS,
  aiErrorText,
  chatTextBlocks,
  draftCardFacts,
  parseDraftForForm,
  parseDraftServiceOrder,
  renderChatText,
  stripDraftFences,
} from '../chat.js';

/* V3-M8 (SPEC-v3.md section 9, permissions section 13): AI chat panel, draft
 * service orders, AI settings card, Help and README. The pure helpers run
 * without a DOM; the browser parts are checked as static source so no DOM and
 * no server are needed (the AI server routes are covered in ai.test.js). */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(REPO, name), 'utf8');

/* --- Safe assistant text (never innerHTML) --------------------------------- */

const DRAFT_FENCE =
  '```json\n{"draftServiceOrder": {"title": "Fix feed dog", "machineId": "m1", "priority": "high", "problem": "Feed dog stuck"}}\n```';

const REPLY = [
  'Two things need attention:',
  '',
  '- **Juki 8700** is down since Monday',
  '- the **overlock** MO-3716 is due for PM',
  '',
  DRAFT_FENCE,
].join('\n');

test('chatTextBlocks: paragraphs keep line breaks, bullets group, bold marks runs', () => {
  const blocks = chatTextBlocks(REPLY);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: 'p', runs: [{ text: 'Two things need attention:', bold: false }] });
  assert.equal(blocks[1].type, 'list');
  assert.equal(blocks[1].items.length, 2);
  assert.deepEqual(blocks[1].items[0], [
    { text: 'Juki 8700', bold: true },
    { text: ' is down since Monday', bold: false },
  ]);
  const second = blocks[1].items[1].map((run) => run.text).join('');
  assert.equal(second, 'the overlock MO-3716 is due for PM');
});

test('chatTextBlocks: multi-line paragraphs keep the newline inside one block', () => {
  const [para] = chatTextBlocks('line one\nline two');
  assert.equal(para.type, 'p');
  assert.equal(JSON.stringify(para.runs.map((run) => run.text)), JSON.stringify(['line one\nline two']));
});

test('chatTextBlocks: draft fences are removed, other fences stay text', () => {
  const withOtherFence = `info\n\`\`\`\n{"notADraft": 1}\n\`\`\`\nafter`;
  const blocks = chatTextBlocks(withOtherFence);
  const text = JSON.stringify(blocks);
  assert.match(text, /notADraft/);
  assert.doesNotMatch(text, /draftServiceOrder/);
  // The AI draft fence disappears entirely (it renders as a draft card).
  assert.doesNotMatch(JSON.stringify(chatTextBlocks(REPLY)), /draftServiceOrder/);
});

test('chatTextBlocks: empty and blank input give no blocks', () => {
  assert.deepEqual(chatTextBlocks(''), []);
  assert.deepEqual(chatTextBlocks(null), []);
  assert.deepEqual(chatTextBlocks('   \n\n'), []);
});

test('stripDraftFences: only well-formed draft fences go, idempotent', () => {
  const cleaned = stripDraftFences(`before\n${DRAFT_FENCE}\nafter`);
  assert.equal(cleaned, 'before\n\nafter');
  assert.equal(stripDraftFences(cleaned), cleaned);
  // A broken JSON draft fence is kept as text.
  assert.match(stripDraftFences('```json\n{"draftServiceOrder": nope}\n```'), /draftServiceOrder/);
});

/* A stub element factory: renderChatText must build only these tags, with
   plain strings for text (the real h turns them into text nodes). */
function stubH(tag, attrs = {}, ...children) {
  return {
    tag,
    attrs: attrs || {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  };
}

test('renderChatText: builds p/ul/li/strong only, text preserved', () => {
  const nodes = renderChatText(stubH, REPLY);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].tag, 'p');
  assert.equal(nodes[1].tag, 'ul');
  const tags = [];
  const texts = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      texts.push(node);
      return;
    }
    tags.push(node.tag);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  for (const tag of tags) assert.ok(['p', 'ul', 'li', 'strong'].includes(tag), `unexpected tag ${tag}`);
  assert.ok(tags.includes('strong'));
  assert.ok(texts.some((text) => text.includes('Juki 8700')));
  assert.ok(texts.some((text) => text.includes('down since Monday')));
  // The fenced draft JSON never renders as chat text.
  assert.ok(!texts.some((text) => text.includes('draftServiceOrder')));
});

test('renderChatText: nothing rendered escapes into markup', () => {
  const hostile = '<script>alert(1)</script> & <img src=x onerror=alert(1)> **bold**';
  const nodes = renderChatText(stubH, hostile);
  const tags = [];
  const texts = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      texts.push(node);
      return;
    }
    tags.push(node.tag);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  // Hostile markup survives only as text content, never as a built tag.
  for (const tag of tags) assert.notEqual(tag, 'script');
  assert.ok(tags.every((tag) => ['p', 'ul', 'li', 'strong'].includes(tag)));
  assert.ok(texts.some((text) => text.includes('<script>alert(1)</script>')));
  assert.ok(texts.some((text) => text === 'bold'));
});

/* --- Draft service orders --------------------------------------------------- */

test('parseDraftServiceOrder: fenced draft survives sanitizing, junk dropped', () => {
  const draft = parseDraftServiceOrder(REPLY);
  assert.deepEqual(draft, {
    title: 'Fix feed dog',
    machineId: 'm1',
    problem: 'Feed dog stuck',
    priority: 'high',
  });
  assert.equal(parseDraftServiceOrder('no fence here'), null);
  assert.equal(parseDraftServiceOrder('```json\n{"draftServiceOrder": "not an object"}\n```'), null);
  assert.equal(parseDraftServiceOrder('```json\nnot json\n```'), null);
});

test('parseDraftForForm: form-safe fields, machine and assignees validated', () => {
  const machines = [
    { id: 'm1', name: 'Juki 8700' },
    { id: 'm2', name: 'MO-3716' },
  ];
  const people = [{ kind: 'user', id: 'u1', name: 'Ada' }];
  const prefill = parseDraftForForm(
    {
      title: '  Fix feed dog ',
      machineName: 'not a form field',
      machineId: 'm1',
      bogusMachineId: 'm3',
      status: 'done',
      priority: 'normal',
      kind: 'breakdown',
      category: 'mechanical',
      dueDate: '2026-11-01',
      reportedAt: '2026-10-20',
      downtimeMinutes: 45,
      minutesSpent: 30,
      assignees: [
        { kind: 'user', id: 'u1' },
        { kind: 'hacker', id: 'zz' },
      ],
      checklist: ['step one', { text: 'step two', done: true }, 42, { text: '' }],
    },
    machines,
    people,
  );
  assert.deepEqual(prefill, {
    title: 'Fix feed dog',
    machineId: 'm1',
    priority: 'medium',
    kind: 'breakdown',
    category: 'mechanical',
    dueDate: '2026-11-01',
    reportedAt: '2026-10-20',
    downtimeMinutes: 45,
    minutesSpent: 30,
    checklist: [
      { text: 'step one', done: false },
      { text: 'step two', done: true },
    ],
    assignees: [{ kind: 'user', id: 'u1' }],
  });
});

test('parseDraftForForm: unknown machine id never prefills', () => {
  const prefill = parseDraftForForm({ title: 'X', machineId: 'does-not-exist' }, [{ id: 'm1' }], []);
  assert.equal(prefill.machineId, undefined);
  assert.equal(parseDraftForForm({}, [], []), null);
  assert.equal(parseDraftForForm('junk', [], []), null);
});

test('draftCardFacts: labels and machine name for the card', () => {
  const machines = [{ id: 'm1', name: 'Juki 8700' }];
  assert.deepEqual(draftCardFacts({ title: 'Fix feed dog', machineId: 'm1', priority: 'urgent', category: 'mechanical', problem: 'Stuck' }, machines), {
    title: 'Fix feed dog',
    machineName: 'Juki 8700',
    priority: 'Urgent',
    category: 'Mechanical',
    problem: 'Stuck',
  });
  // A machine the device cannot read shows no name (SPEC-v3.md section 9).
  assert.equal(draftCardFacts({ title: 'X', machineId: 'gone' }, machines).machineName, '');
});

/* --- Friendly errors -------------------------------------------------------- */

test('aiErrorText: 429 rate limit, 502 provider message, fallbacks', () => {
  assert.equal(aiErrorText(429, { message: 'Too many AI messages in the last minute.' }), AI_RATE_LIMIT_TEXT);
  assert.equal(AI_RATE_LIMIT_TEXT, 'Slow down: 20 messages per minute');
  assert.equal(aiErrorText(502, { message: 'The AI provider timed out.' }), 'The AI provider timed out.');
  assert.equal(aiErrorText(502, null), 'The AI provider did not answer. Try again soon.');
  assert.equal(AI_OFFLINE_TEXT, 'The assistant needs a connection to the server');
  assert.equal(aiErrorText(400, { message: 'The AI assistant is turned off.' }), 'The AI assistant is turned off.');
});

test('AI_STARTERS: the four starter suggestions', () => {
  assert.equal(AI_STARTERS.length, 4);
  assert.equal(AI_STARTERS[0], 'Which machines are down?');
  assert.equal(AI_STARTERS[1], 'What preventive maintenance is overdue?');
  assert.equal(AI_STARTERS[2], 'Which parts are low on stock?');
  assert.equal(AI_STARTERS[3], "Summarise this week's service orders");
});

test('MESSAGE_MAX_CHARS matches the server limit of 2000', () => {
  assert.equal(MESSAGE_MAX_CHARS, 2000);
  assert.equal(AI_PRIVACY_NOTICE, 'Questions and the records needed to answer them are sent to the configured AI provider.');
});

/* --- Browser wiring (static source checks) ---------------------------------- */

test('chat.js: chat button, panel and draft card strings', () => {
  const source = read('chat.js');
  assert.match(source, /'Ask the AI assistant'/);
  assert.match(source, /'AI assistant'/);
  assert.match(source, /'Clear history'/);
  assert.match(source, /'Open as new service order'/);
  assert.match(source, /'Thinking\.\.\.'/);
  assert.match(source, /restored-never|Enter sends/);
  assert.match(source, /Shift/);
  assert.match(source, /maint-log:ai-conversation/);
  assert.match(source, /maint-log:ai-draft/);
  assert.doesNotMatch(source, /\.innerHTML\b/);
  assert.doesNotMatch(source, /\balert\(/);
  assert.doesNotMatch(source, /\bconfirm\(/);
  assert.doesNotMatch(source, /\bprompt\(/);
  assert.match(source, /'\/api\/ai\/chat'/);
  assert.match(source, /'\/api\/ai\/history'/);
  assert.match(source, /'\/api\/ai\/status'/);
  assert.match(source, /'\/api\/ai\/config'/);
  assert.match(source, /'\/api\/ai\/test'/);
});

test('chat.js: settings card — provider select, secret placeholders, hint, privacy notice', () => {
  const source = read('chat.js');
  assert.match(source, /'off', 'Off'/);
  assert.match(source, /'opencode', 'opencode'/);
  assert.match(source, /'openai-compatible', 'OpenAI-compatible'/);
  assert.match(source, /Saved - leave blank to keep/);
  assert.match(source, /OPENCODE_SERVER_PASSWORD=... opencode serve --port 4096 in an empty folder/);
  assert.match(source, /AI_PRIVACY_NOTICE/);
  // Secrets are password inputs, never echoed back.
  assert.match(source, /type: 'password'/);
});

test('app.js: chat is wired — init, visibility on render, status on sign-in, reset on sign-out', () => {
  const source = read('app.js');
  assert.match(source, /initAiChat\(\{/);
  assert.match(source, /api: sync\.api/);
  assert.match(source, /isSignedIn: \(\) => Boolean\(teamUser\)/);
  assert.match(source, /applyNavPermissions\(\);\s*\n\s*\/\/ AI chat button.*\n\s*updateAiChatButton\(\);/s);
  assert.match(source, /await refreshAiStatus\(\);\s*\n\s*updateAiChatButton\(\);/);
  assert.match(source, /resetAiChat\(\);/);
  // Settings card appears only with settings Write (V3-M9: can() form).
  assert.match(source, /can\('settings', 'write'\) \? \[sectionTitle\('AI assistant'\), aiSettingsCard\(\)\]/);
  // The draft opens the normal new service order form pre-filled (phone page
  // and desktop drawer both consume the stashed draft).
  assert.match(source, /prefillFromAiDraft\(consumeAiDraft\(\) \|\| \{\}\)/);
  assert.match(source, /prefill: prefill \|\| null/);
});

test('app.js: the chat button follows permissions, never the legacy role field', () => {
  const source = read('app.js');
  // No permission check uses teamUser.role directly for the AI chat area.
  assert.doesNotMatch(source, /teamUser\.role ===/);
});

test('styles.css: chat button and panel dimensions, phone sheet, logged-out hidden', () => {
  const source = read('styles.css');
  assert.match(source, /\.ai-chat-fab\b/);
  assert.match(source, /\.ai-chat-panel \{[^}]*width: 380px/s);
  assert.match(source, /\.ai-chat-panel \{[^}]*height: 560px/s);
  // Phone: full-screen sheet; the button stacks above the tab bar and FAB.
  assert.match(source, /@media \(max-width: 767\.98px\) \{[\s\S]*\.ai-chat-panel \{[\s\S]*width: 100vw/s);
  assert.match(source, /@media \(max-width: 1023\.98px\) \{[\s\S]*\.ai-chat-fab[\s\S]*bottom: calc\(var\(--tabbar-height\) \+ env\(safe-area-inset-bottom\) \+ 5\.5rem\)/s);
  assert.match(source, /body\.logged-out \.ai-chat-fab/);
  assert.doesNotMatch(source, /\.logged-out \.ai-chat-panel \{ display: block/);
});

test('styles.css: bubbles user right, assistant left, notices present', () => {
  const source = read('styles.css');
  assert.match(source, /\.ai-msg\.is-user \{[^}]*align-self: flex-end/s);
  assert.match(source, /\.ai-msg\.is-assistant \{[^}]*align-self: flex-start/s);
  assert.match(source, /\.chat-para \{[^}]*white-space: pre-line/s);
  assert.match(source, /\.ai-chat-count|\.ai-chat-notice/s);
});

test('help.js: an AI assistant section exists and renders', () => {
  const source = read('help.js');
  assert.match(source, /\{ id: 'help-ai', title: 'AI assistant' \}/);
  assert.match(source, /helpAi\(h\)/);
  assert.match(source, /draft service order/i);
  assert.match(source, /Settings → AI assistant/);
});

test('sw.js: chat.js cached and the cache version is at least 21', () => {
  const source = read('sw.js');
  assert.match(source, /'\.\/chat\.js',/);
  const match = /const CACHE_VERSION = (\d+);/.exec(source);
  assert.ok(match, 'CACHE_VERSION must be a number');
  const version = Number(match[1]);
  assert.ok(version >= 21, `CACHE_VERSION ${version} must be at least 21`);
});

test('README: AI assistant setup steps for opencode and vLLM', () => {
  const source = read('README.md');
  assert.match(source, /## AI assistant \(v3\)/);
  assert.match(source, /### Setup steps — opencode/);
  assert.match(source, /OPENCODE_SERVER_PASSWORD=choose-a-long-password opencode serve --port 4096/);
  assert.match(source, /### Setup steps — an OpenAI-compatible server/);
  assert.match(source, /vllm serve/);
  assert.match(source, /\/v1/);
  assert.match(source, /Using the chat/);
});

test('index.html: no AI chat button baked in (app.js builds it), shell unchanged', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /ai-chat-fab/);
  assert.doesNotMatch(html, /https?:\/\//);
});
test('chat text drops stray *italic* and `code` markers but keeps **bold** and the words', async () => {
  const { chatTextBlocks } = await import('../chat.js');
  const [block] = chatTextBlocks('Status *waiting-parts*, part `DBx1`, **urgent** and 2*3*4 stays');
  const text = block.runs.map((r) => r.text).join('');
  assert.equal(text, 'Status waiting-parts, part DBx1, urgent and 2*3*4 stays');
  assert.ok(block.runs.some((r) => r.bold && r.text === 'urgent'));
});
