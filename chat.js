/* V3-M8 AI assistant chat (SPEC-v3.md section 9; permissions section 13).
 *
 * Pure helpers (chatTextBlocks, renderChatText, aiErrorText,
 * parseDraftServiceOrder, parseDraftForForm, draftCardFacts) run in Node for
 * tests; the panel and Settings card builders run in the browser and are
 * wired from app.js via initAiChat()/aiSettingsCard(). Assistant text is
 * rendered by building elements only — never innerHTML — and secrets from
 * /api/ai/config are shown as "Saved - leave blank to keep" placeholders.
 */

import {
  LABELS,
  PRIORITIES,
  WORK_ORDER_CATEGORIES,
  WORK_ORDER_KINDS,
  isISODate,
} from './logic.js';

export const MESSAGE_MAX_CHARS = 2000;

export const AI_STARTERS = [
  'Which machines are down?',
  'What preventive maintenance is overdue?',
  'Which parts are low on stock?',
  "Summarise this week's service orders",
];

export const AI_PRIVACY_NOTICE =
  'Questions and the records needed to answer them are sent to the configured AI provider.';

export const AI_OFFLINE_TEXT = 'The assistant needs a connection to the server';

export const AI_RATE_LIMIT_TEXT = 'Slow down: 20 messages per minute';

export const AI_HINT_OPENCODE =
  'For opencode run: OPENCODE_SERVER_PASSWORD=... opencode serve --port 4096 in an empty folder';

const SECRET_PLACEHOLDER = 'Saved - leave blank to keep';

const ASSIGNEE_KINDS = ['user', 'coworker', 'contractor'];

/* Fenced JSON block holding a draft service order (SPEC-v3.md section 9);
 * the same shape the server parses in server/ai.js. */
const FENCE_RE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ---------------------------------------------------------------------------
 * Safe assistant text (SPEC-v3.md section 9 client rules): plain text nodes
 * only, line breaks kept, simple **bold** and "- " bullets, never innerHTML.
 * ------------------------------------------------------------------------- */

function boldRuns(text) {
  const parts = String(text).split('**');
  const runs = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '') continue;
    // Odd indexes sit between two ** markers and render bold. Models also emit *italic*
    // and `code` despite the prompt: keep the words, drop the stray markers.
    const clean = part.replace(/(^|[^*\w])\*([^*\n]+?)\*(?=[^*\w]|$)/g, '$1$2').replace(/`([^`\n]+)`/g, '$1');
    runs.push({ text: clean, bold: index % 2 === 1 });
  }
  return runs;
}

/**
 * Remove fenced blocks that hold a valid {"draftServiceOrder": {...}} JSON
 * object — those render as a draft card instead of chat text (SPEC-v3.md
 * section 9). Other fences stay as text.
 */
export function stripDraftFences(text) {
  const source = text === null || text === undefined ? '' : String(text);
  const fenceAll = /```(?:json)?[ \t]*\r?\n?[\s\S]*?```/g;
  let out = '';
  let last = 0;
  let match = fenceAll.exec(source);
  while (match !== null) {
    const inner = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/.exec(match[0]);
    let isDraft = false;
    if (inner) {
      try {
        const parsed = JSON.parse(inner[1]);
        isDraft =
          isPlainObject(parsed) &&
          (isPlainObject(parsed.draftServiceOrder) || Array.isArray(parsed.proposals));
      } catch {
        isDraft = false;
      }
    }
    if (isDraft) {
      out += source.slice(last, match.index);
      last = match.index + match[0].length;
    }
    match = fenceAll.exec(source);
  }
  out += source.slice(last);
  return out;
}

const BULLET_RE = /^[-*•–—]\s+/;

/**
 * Assistant text as safe blocks: paragraphs ({type: 'p', runs}) keep line
 * breaks inside their runs, "- " lines become one list block
 * ({type: 'list', items: [runs]}). Bold runs carry bold: true. Pure.
 */
export function chatTextBlocks(text) {
  const lines = stripDraftFences(text).split(/\r\n|\r|\n/);
  const blocks = [];
  let paraLines = [];
  let listItems = [];

  const flushParagraph = () => {
    if (paraLines.length === 0) return;
    const runs = boldRuns(paraLines.join('\n'));
    if (runs.length > 0) blocks.push({ type: 'p', runs });
    paraLines = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push({ type: 'list', items: listItems });
    listItems = [];
  };

  for (const line of lines) {
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushParagraph();
      const rest = line.slice(bullet[0].length);
      if (rest.trim() === '') continue;
      listItems.push(boldRuns(rest));
      continue;
    }
    flushList();
    paraLines.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/**
 * Render blocks from chatTextBlocks() with an element factory `h` — a
 * <p class="chat-para"> per paragraph, one <ul class="chat-list"> per bullet
 * group, <strong> per bold run. Plain runs stay strings so the caller's h()
 * turns them into text nodes. Pure given `h`.
 */
export function renderChatText(h, text) {
  const runNodes = (runs) =>
    runs.map((run) => (run.bold ? h('strong', {}, run.text) : run.text));
  const nodes = [];
  for (const block of chatTextBlocks(text)) {
    if (block.type === 'list') {
      nodes.push(
        h('ul', { class: 'chat-list' }, ...block.items.map((runs) => h('li', {}, ...runNodes(runs)))),
      );
    } else {
      nodes.push(h('p', { class: 'chat-para' }, ...runNodes(block.runs)));
    }
  }
  return nodes;
}

/* ---------------------------------------------------------------------------
 * Draft service orders (SPEC-v3.md section 9): nothing is saved until the
 * user presses Save in the normal form.
 * ------------------------------------------------------------------------- */

/** Client mirror of the server's draft sanitize: known fields, safe types. */
function sanitizeDraft(draft) {
  const out = {};
  const strings = {
    title: 200,
    machineId: 200,
    requestedBy: 80,
    problem: 4000,
    actionTaken: 4000,
    pmTaskId: 200,
  };
  for (const [field, max] of Object.entries(strings)) {
    const value = draft[field];
    if (typeof value === 'string' && value.trim() !== '') {
      out[field] = value.trim().slice(0, max);
    }
  }
  if (draft.priority !== undefined) {
    const priority = draft.priority === 'normal' ? 'medium' : draft.priority;
    if (PRIORITIES.includes(priority)) out.priority = priority;
  }
  if (WORK_ORDER_KINDS.includes(draft.kind)) out.kind = draft.kind;
  if (WORK_ORDER_CATEGORIES.includes(draft.category)) out.category = draft.category;
  for (const field of ['dueDate', 'reportedAt', 'completedAt']) {
    if (isISODate(draft[field])) out[field] = draft[field];
  }
  if (Array.isArray(draft.checklist)) {
    const checklist = draft.checklist
      .slice(0, 50)
      .map((item) => {
        if (typeof item === 'string') return { text: item.trim().slice(0, 200), done: false };
        if (!isPlainObject(item)) return null;
        const text = typeof item.text === 'string' ? item.text.trim().slice(0, 200) : '';
        if (text === '') return null;
        return { text, done: item.done === true };
      })
      .filter((item) => item !== null);
    if (checklist.length > 0) out.checklist = checklist;
  }
  if (Array.isArray(draft.assignees)) {
    const assignees = draft.assignees
      .slice(0, 10)
      .filter((entry) => isPlainObject(entry) && ASSIGNEE_KINDS.includes(entry.kind) && typeof entry.id === 'string' && entry.id !== '')
      .map((entry) => ({ kind: entry.kind, id: entry.id }));
    if (assignees.length > 0) out.assignees = assignees;
  }
  for (const field of ['downtimeMinutes', 'minutesSpent']) {
    if (Number.isInteger(draft[field]) && draft[field] >= 0) out[field] = draft[field];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Extract the draft service order from a reply's fenced JSON block
 * (```json {"draftServiceOrder": {...}}```); null when absent or unusable.
 */
export function parseDraftServiceOrder(reply) {
  if (typeof reply !== 'string') return null;
  const match = FENCE_RE.exec(reply);
  if (match === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.draftServiceOrder)) return null;
  return sanitizeDraft(parsed.draftServiceOrder);
}

/**
 * Map a draft to fields the new-service-order form accepts (workOrderFormBody
 * prefill): only values that are valid for that form survive, and machineId /
 * assignees must match records this device actually holds.
 */
export function parseDraftForForm(draft, machines = [], people = []) {
  const clean = isPlainObject(draft) ? sanitizeDraft(draft) : null;
  if (clean === null) return null;
  const out = {};
  for (const field of ['title', 'requestedBy', 'problem', 'actionTaken']) {
    if (typeof clean[field] === 'string') out[field] = clean[field];
  }
  if (clean.machineId && (machines || []).some((m) => m && m.id === clean.machineId)) {
    out.machineId = clean.machineId;
  }
  if (PRIORITIES.includes(clean.priority)) out.priority = clean.priority;
  if (WORK_ORDER_KINDS.includes(clean.kind)) out.kind = clean.kind;
  if (WORK_ORDER_CATEGORIES.includes(clean.category)) out.category = clean.category;
  if (isISODate(clean.dueDate)) out.dueDate = clean.dueDate;
  if (isISODate(clean.reportedAt)) out.reportedAt = clean.reportedAt;
  if (Number.isInteger(clean.downtimeMinutes)) out.downtimeMinutes = clean.downtimeMinutes;
  if (Number.isInteger(clean.minutesSpent)) out.minutesSpent = clean.minutesSpent;
  if (Array.isArray(clean.checklist)) out.checklist = clean.checklist;
  if (Array.isArray(clean.assignees)) {
    const peopleList = people || [];
    const valid = clean.assignees.filter((entry) =>
      peopleList.some((person) => person && person.kind === entry.kind && person.id === entry.id),
    );
    if (valid.length > 0) out.assignees = valid;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Facts shown on the draft card: title, machine name, priority, category, problem. */
export function draftCardFacts(draft, machines = []) {
  const clean = isPlainObject(draft) ? sanitizeDraft(draft) : null;
  if (clean === null) return null;
  const machine = clean.machineId
    ? (machines || []).find((entry) => entry && entry.id === clean.machineId)
    : null;
  return {
    title: typeof clean.title === 'string' ? clean.title : '',
    machineName: machine && typeof machine.name === 'string' ? machine.name : '',
    priority:
      PRIORITIES.includes(clean.priority) ? LABELS.priority[clean.priority] || clean.priority : '',
    category:
      WORK_ORDER_CATEGORIES.includes(clean.category)
        ? LABELS.category[clean.category] || clean.category
        : '',
    problem: typeof clean.problem === 'string' ? clean.problem : '',
  };
}

/* ---------------------------------------------------------------------------
 * Friendly inline errors (SPEC-v3.md section 9).
 * ------------------------------------------------------------------------- */

export function aiErrorText(status, data) {
  const message = data && typeof data.message === 'string' ? data.message.trim() : '';
  if (status === 429) return AI_RATE_LIMIT_TEXT;
  if (typeof message === 'string' && message !== '') return message;
  if (status === 502) return 'The AI provider did not answer. Try again soon.';
  return 'The assistant could not answer. Try again.';
}

/* ---------------------------------------------------------------------------
 * Session storage (conversation id and the stashed draft for the form).
 * ------------------------------------------------------------------------- */

const AI_CONVERSATION_KEY = 'maint-log:ai-conversation';
const AI_DRAFT_KEY = 'maint-log:ai-draft';

function sessionGet(key) {
  try {
    return globalThis.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key, value) {
  try {
    globalThis.sessionStorage.setItem(key, value);
  } catch {
    // Private browsing: the chat still works, ids just are not remembered.
  }
}

function sessionRemove(key) {
  try {
    globalThis.sessionStorage.removeItem(key);
  } catch {
    // See sessionSet.
  }
}

/** Stash a draft so #/jobs/new opens the normal form pre-filled. */
export function stashAiDraft(draft) {
  if (!isPlainObject(draft)) return;
  sessionSet(AI_DRAFT_KEY, JSON.stringify(draft));
}

/** Take (and remove) the stashed AI draft, or null when none is waiting. */
export function consumeAiDraft() {
  const raw = sessionGet(AI_DRAFT_KEY);
  if (raw === null) return null;
  sessionRemove(AI_DRAFT_KEY);
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ==========================================================================
 * Browser panel and Settings card. Everything below only runs when the app
 * calls initAiChat()/aiSettingsCard(); importing this module in Node is safe.
 * ========================================================================== */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') node.textContent = value;
    else if (key in node && key !== 'list' && key !== 'form') {
      try {
        node[key] = value;
      } catch {
        node.setAttribute(key, value === true ? '' : value);
      }
    } else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) node.append(child);
    else node.append(document.createTextNode(String(child)));
  }
}

let deps = null;
let chatButton = null;
let chatPanel = null;
let panelOpen = false;
let sending = false;
let aiEnabled = null;

/* Provider status (SPEC-v3.md section 9): the button shows only when the
 * server says a provider is enabled. */
export async function refreshAiStatus() {
  if (!deps || !deps.api) return;
  if (!deps.isSignedIn()) {
    aiEnabled = false;
    return;
  }
  try {
    const response = await deps.api('GET', '/api/ai/status');
    aiEnabled = Boolean(response.ok && response.data && response.data.enabled === true);
  } catch (error) {
    // Offline: keep the last known state.
    console.warn('Could not check the AI status:', error);
  }
}

/** Show the chat button only with aiAssistant Read/Write and a provider on. */
export function updateAiChatButton() {
  if (!chatButton) return;
  const usable =
    deps !== null &&
    deps.isSignedIn() &&
    typeof deps.can === 'function' &&
    deps.can('aiAssistant') &&
    aiEnabled === true;
  chatButton.hidden = !usable;
}

/** Sign-out: forget the provider state and close the panel. */
export function resetAiChat() {
  aiEnabled = null;
  sessionRemove(AI_CONVERSATION_KEY);
  if (panelOpen) closePanel();
}

function readableMachines() {
  if (!deps || typeof deps.machines !== 'function' || typeof deps.can !== 'function' || !deps.can('machines')) return [];
  const machines = deps.machines();
  return Array.isArray(machines) ? machines : [];
}

/* ----- Draft card ----- */

function draftCardNode(draft) {
  const facts = draftCardFacts(draft, readableMachines());
  if (facts === null) return null;
  const rows = [];
  const addRow = (label, value) => {
    if (value === '' || value === null || value === undefined) return;
    rows.push(el('div', { class: 'ai-draft-row' }, el('dt', {}, label), el('dd', {}, value)));
  };
  addRow('Title', facts.title);
  addRow('Machine', facts.machineName);
  addRow('Priority', facts.priority);
  addRow('Category', facts.category);
  addRow('Problem', facts.problem);
  const canSave = deps && typeof deps.can === 'function' && deps.can('serviceOrders', 'write');
  const openButton = el(
    'button',
    { class: 'btn btn-primary btn-small', type: 'button' },
    'Open as new service order',
  );
  openButton.addEventListener('click', () => {
    closePanel();
    stashAiDraft(draft);
    if (deps && typeof deps.navigate === 'function') deps.navigate('#/jobs/new');
  });
  return el(
    'div',
    { class: 'card ai-draft-card' },
    el('h3', { class: 'ai-draft-title' }, 'Draft service order'),
    rows.length > 0 ? el('dl', { class: 'ai-draft-facts' }, ...rows) : null,
    el(
      'p',
      { class: 'field-hint' },
      'Nothing is saved until you review it and press Save in the form.',
    ),
    canSave ? openButton : null,
  );
}

/* ----- Proposed changes (assistant edits) ----- */

const PROPOSAL_STORES = {
  machines: { area: 'machines', label: 'Machine' },
  workOrders: { area: 'serviceOrders', label: 'Service order' },
  pmTasks: { area: 'pm', label: 'PM task' },
  libraryItems: { area: 'library', label: 'Repair method' },
};

const PROPOSAL_BLOCKED_FIELDS = ['id', 'version', 'number', 'createdBy', 'updatedBy'];

/** Proposed changes in a reply (client copy of parseProposals in server/ai.js). */
export function parseProposals(text) {
  if (typeof text !== 'string') return [];
  const fence = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/g;
  const proposals = [];
  let match = fence.exec(text);
  while (match !== null) {
    let parsed = null;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      parsed = null;
    }
    const list = isPlainObject(parsed) && Array.isArray(parsed.proposals) ? parsed.proposals : [];
    for (const raw of list) {
      if (!isPlainObject(raw) || !PROPOSAL_STORES[raw.store] || !isPlainObject(raw.fields)) continue;
      // SPEC-v4.md section 5: repair-method proposals create methods only.
      if (raw.store === 'libraryItems' && raw.fields.kind !== 'method') continue;
      const fields = {};
      for (const [key, value] of Object.entries(raw.fields)) {
        if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) continue;
        if (PROPOSAL_BLOCKED_FIELDS.includes(key)) continue;
        fields[key] = value;
      }
      if (Object.keys(fields).length === 0) continue;
      proposals.push({
        store: raw.store,
        id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : null,
        summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 200) : '',
        fields,
      });
      if (proposals.length >= 3) return proposals;
    }
    match = fence.exec(text);
  }
  return proposals;
}

function valueText(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((item) => valueText(item)).join(', ');
  }
  if (typeof value === 'object') {
    const label = value.name ?? value.title ?? value.label ?? value.id;
    return label === undefined ? JSON.stringify(value) : String(label);
  }
  return String(value);
}

function currentRecordFor(store, id) {
  if (!deps || typeof deps.records !== 'function' || !id) return null;
  const rows = deps.records(store);
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => row && row.id === id) ?? null;
}

function proposalCardNode(proposal) {
  const entry = PROPOSAL_STORES[proposal.store];
  if (!entry) return null;
  const current = currentRecordFor(proposal.store, proposal.id);
  const currentData = current && isPlainObject(current.data) ? current.data : {};
  const rows = Object.entries(proposal.fields).map(([key, value]) => {
    const before = currentData[key];
    const changed = current !== null && valueText(before) !== valueText(value);
    return el(
      'div',
      { class: 'ai-draft-row' },
      el('dt', {}, key),
      el('dd', {}, changed ? `${valueText(before)} → ${valueText(value)}` : valueText(value)),
    );
  });
  const status = el('p', { class: 'field-hint', role: 'status' });
  const actions = el('div', { class: 'ai-proposal-actions' });
  const canApply = Boolean(deps && typeof deps.can === 'function' && deps.can(entry.area, 'write'));
  const dismiss = el('button', { class: 'btn btn-small', type: 'button' }, 'Dismiss');
  dismiss.addEventListener('click', () => card.remove());
  if (!canApply) {
    status.textContent = `You do not have write access to ${entry.label.toLowerCase()}s, so this change cannot be applied from here.`;
    actions.append(dismiss);
  } else {
    status.textContent =
      'Nothing is saved until you press Apply. The record will show AI Assistant as the editor.';
    const apply = el('button', { class: 'btn btn-primary btn-small', type: 'button' }, 'Apply');
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      dismiss.disabled = true;
      try {
        const payload = { store: proposal.store, summary: proposal.summary, fields: proposal.fields };
        if (proposal.id !== null) payload.id = proposal.id;
        const response = await deps.api('POST', '/api/ai/apply', payload);
        if (!response.ok) {
          status.className = 'form-error';
          status.textContent = aiErrorText(response.status, response.data);
          apply.disabled = false;
          dismiss.disabled = false;
          return;
        }
        actions.remove();
        status.className = 'ai-proposal-done';
        status.textContent = `Saved · ${entry.label} ${proposal.id === null ? 'created' : 'updated'} by AI Assistant`;
        if (typeof deps.refresh === 'function') {
          try {
            await deps.refresh();
          } catch (error) {
            console.warn('Refresh after an AI change failed:', error);
          }
        }
      } catch (error) {
        console.warn('AI apply failed (network):', error);
        status.className = 'form-error';
        status.textContent = AI_OFFLINE_TEXT;
        apply.disabled = false;
        dismiss.disabled = false;
      }
    });
    actions.append(apply, dismiss);
  }
  const card = el(
    'div',
    { class: 'card ai-proposal-card' },
    el('h3', { class: 'ai-draft-title' }, `Proposed change · ${entry.label}`),
    proposal.summary ? el('p', { class: 'ai-proposal-summary' }, proposal.summary) : null,
    current
      ? el(
          'p',
          { class: 'field-hint' },
          `Record: ${valueText(current.data && (current.data.title ?? current.data.name))} · ${proposal.id}`,
        )
      : null,
    el('dl', { class: 'ai-draft-facts' }, ...rows),
    status,
    actions,
  );
  return card;
}

/* ----- Message list ----- */

function userMessageNode(text) {
  return el('div', { class: 'ai-msg is-user' }, el('p', { class: 'chat-para' }, text));
}

function assistantMessageNode(content, draft, proposals) {
  const bubble = el('div', { class: 'ai-msg is-assistant' });
  bubble.append(...renderChatText(el, stripDraftFences(content)));
  const nodes = [bubble];
  const card = draftCardNode(draft !== undefined ? draft : null);
  if (card !== null) nodes.push(card);
  const list = Array.isArray(proposals) ? proposals : [];
  for (const proposal of list) {
    const proposalCard = proposalCardNode(proposal);
    if (proposalCard !== null) nodes.push(proposalCard);
  }
  return nodes;
}

function startersNode(onPick) {
  return el(
    'div',
    { class: 'ai-chat-starters' },
    el('p', { class: 'ai-chat-starters-title' }, 'Try asking:'),
    ...AI_STARTERS.map((starter) => {
      const button = el('button', { class: 'btn btn-small ai-starter', type: 'button' }, starter);
      button.addEventListener('click', () => onPick(starter));
      return button;
    }),
  );
}

/* ----- Panel ----- */

function ensurePanel() {
  if (chatPanel) return chatPanel;

  const list = el('div', { class: 'ai-chat-messages', role: 'log', 'aria-label': 'AI assistant conversation' });
  const thinking = el('p', { class: 'ai-chat-thinking', role: 'status' }, 'Thinking...');
  thinking.hidden = true;
  const errorLine = el('p', { class: 'form-error ai-chat-error', role: 'alert' });
  errorLine.textContent = '';
  errorLine.hidden = true;

  const clearButton = el('button', { class: 'btn btn-small', type: 'button' }, 'Clear history');
  const closeButton = el(
    'button',
    { class: 'icon-button drawer-close', type: 'button', 'aria-label': 'Close' },
    el('span', { 'aria-hidden': 'true' }, '✕'),
  );
  const header = el(
    'div',
    { class: 'ai-chat-head' },
    el('h2', { class: 'ai-chat-title' }, 'AI assistant'),
    clearButton,
    closeButton,
  );

  const input = el('textarea', {
    class: 'ai-chat-input',
    rows: 3,
    maxlength: String(MESSAGE_MAX_CHARS),
    placeholder: 'Ask about machines, service orders, parts…',
    'aria-label': 'Message the AI assistant',
  });
  const sendButton = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Send');
  const form = el('form', { class: 'ai-chat-form', novalidate: true }, input, sendButton);
  const counter = el('span', { class: 'ai-chat-count', 'aria-hidden': 'true' }, `0 / ${MESSAGE_MAX_CHARS}`);
  const notice = el('p', { class: 'ai-chat-notice field-hint' }, AI_PRIVACY_NOTICE);

  const syncCounter = () => {
    counter.textContent = `${input.value.length} / ${MESSAGE_MAX_CHARS}`;
  };
  input.addEventListener('input', syncCounter);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitQuestion();
  });
  input.addEventListener('keydown', (event) => {
    // Enter sends, Shift+Enter makes a newline (SPEC-v3.md section 9).
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submitQuestion();
    }
  });

  clearButton.addEventListener('click', () => void clearHistory());
  closeButton.addEventListener('click', () => closePanel());

  const root = el(
    'section',
    { class: 'ai-chat-panel', role: 'dialog', 'aria-label': 'AI assistant', hidden: true },
    header,
    list,
    thinking,
    errorLine,
    form,
    el('div', { class: 'ai-chat-foot' }, counter, notice),
  );
  document.body.append(root);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !panelOpen) return;
    // An open confirm dialog handles its own Escape (dialog-root).
    const dialogRoot = document.getElementById('dialog-root');
    if (dialogRoot && dialogRoot.childElementCount > 0) return;
    closePanel();
  });

  chatPanel = { root, list, input, sendButton, form, counter, thinking, errorLine };
  return chatPanel;
}

function scrollListToEnd() {
  const list = chatPanel && chatPanel.list;
  if (!list) return;
  list.scrollTop = list.scrollHeight;
}

function showError(message) {
  if (!chatPanel) return;
  chatPanel.errorLine.textContent = message;
  chatPanel.errorLine.hidden = false;
}

function hideError() {
  if (!chatPanel) return;
  chatPanel.errorLine.textContent = '';
  chatPanel.errorLine.hidden = true;
}

function showStarters() {
  if (!chatPanel) return;
  chatPanel.list.replaceChildren(startersNode((starter) => void ask(starter)));
}

/* True once the user sent or saw messages in this panel opening: a history
 * response that lands later must not wipe them. */
let listTouched = false;

async function ask(question) {
  if (sending) return;
  const text = String(question || '').trim().slice(0, MESSAGE_MAX_CHARS);
  if (text === '') return;
  const panel = ensurePanel();
  panel.list.append(userMessageNode(text));
  listTouched = true;
  hideError();
  scrollListToEnd();
  panel.thinking.hidden = false;
  sending = true;
  panel.sendButton.disabled = true;
  try {
    const body = { message: text };
    const conversationId = sessionGet(AI_CONVERSATION_KEY);
    if (conversationId !== null && conversationId !== '') body.conversationId = conversationId;
    const response = await deps.api('POST', '/api/ai/chat', body);
    if (!response.ok) {
      showError(aiErrorText(response.status, response.data));
      return;
    }
    const data = response.data || {};
    if (typeof data.conversationId === 'string' && data.conversationId !== '') {
      sessionSet(AI_CONVERSATION_KEY, data.conversationId);
    }
    const draft =
      isPlainObject(data.draftServiceOrder) ? data.draftServiceOrder : parseDraftServiceOrder(data.reply);
    const proposals = Array.isArray(data.proposals) ? data.proposals : parseProposals(data.reply);
    panel.list.append(...assistantMessageNode(data.reply || '', draft, proposals));
  } catch (error) {
    console.warn('AI chat failed (network):', error);
    showError(AI_OFFLINE_TEXT);
  } finally {
    panel.thinking.hidden = true;
    sending = false;
    panel.sendButton.disabled = false;
    if (panelOpen) panel.input.focus();
    scrollListToEnd();
  }
}

async function submitQuestion() {
  const panel = ensurePanel();
  const text = panel.input.value;
  if (String(text).trim() === '') return;
  panel.input.value = '';
  panel.counter.textContent = `0 / ${MESSAGE_MAX_CHARS}`;
  await ask(text);
}

async function loadHistory() {
  const panel = ensurePanel();
  try {
    const response = await deps.api('GET', '/api/ai/history');
    // The user may have sent a message while the history loaded; keep theirs.
    if (listTouched) return;
    if (!response.ok) {
      showError(aiErrorText(response.status, response.data));
      return;
    }
    const messages = response.data && Array.isArray(response.data.messages) ? response.data.messages : [];
    if (messages.length === 0) {
      showStarters();
      return;
    }
    const stored = sessionGet(AI_CONVERSATION_KEY);
    const storedKnown = messages.some((m) => m && m.conversationId === stored);
    const conversationId = storedKnown ? stored : messages[messages.length - 1].conversationId;
    sessionSet(AI_CONVERSATION_KEY, conversationId);
    const rows = messages.filter((m) => m && m.conversationId === conversationId);
    if (rows.length === 0) {
      showStarters();
      return;
    }
    const nodes = [];
    for (const row of rows) {
      if (!row || typeof row.content !== 'string') continue;
      if (row.role === 'user') {
        nodes.push(userMessageNode(stripDraftFences(row.content)));
      } else {
        const draft = parseDraftServiceOrder(row.content);
        nodes.push(...assistantMessageNode(row.content, draft, parseProposals(row.content)));
      }
    }
    panel.list.replaceChildren(...nodes);
    scrollListToEnd();
  } catch (error) {
    console.warn('Could not load the AI history:', error);
    showError(AI_OFFLINE_TEXT);
  }
}

async function clearHistory() {
  const yes = await deps.showConfirm({
    title: 'Clear AI history?',
    message: 'Deletes your questions and the assistant answers for every conversation. It cannot be undone.',
    confirmText: 'Clear history',
    cancelText: 'Keep',
    danger: true,
  });
  if (!yes) return;
  const panel = ensurePanel();
  try {
    const response = await deps.api('DELETE', '/api/ai/history');
    if (!response.ok) {
      showError(aiErrorText(response.status, response.data));
      return;
    }
    sessionRemove(AI_CONVERSATION_KEY);
    panel.list.replaceChildren();
    listTouched = false;
    showStarters();
    hideError();
  } catch (error) {
    console.warn('Could not clear the AI history:', error);
    showError(AI_OFFLINE_TEXT);
  }
}

function openPanel() {
  const panel = ensurePanel();
  panel.root.hidden = false;
  panelOpen = true;
  hideError();
  listTouched = false;
  chatButton.setAttribute('aria-expanded', 'true');
  panel.list.replaceChildren();
  showStarters();
  void loadHistory();
  panel.input.focus();
}

function closePanel() {
  if (!panelOpen) return;
  panelOpen = false;
  if (chatPanel) chatPanel.root.hidden = true;
  if (chatButton) {
    chatButton.setAttribute('aria-expanded', 'false');
    chatButton.focus();
  }
}

/**
 * Build the fixed chat button and wire the panel. Called once from app.js
 * with: { api, can, machines, records, isSignedIn, navigate, showConfirm,
 * refresh }. `records(store)` returns the cached rows of a store, `refresh()`
 * reloads them from the server after the assistant's change is applied.
 */
export function initAiChat(options) {
  deps = {
    api: options.api,
    can: options.can,
    machines: options.machines,
    records: options.records,
    isSignedIn: options.isSignedIn,
    navigate: options.navigate,
    showConfirm: options.showConfirm,
    refresh: options.refresh,
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ai-chat-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const svgPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  svgPath.setAttribute(
    'd',
    'M21 12a8.5 8.5 0 0 1-8.5 8.5c-1.1 0-2.2-.2-3.1-.6L4 21l1.2-4.4A8.5 8.5 0 1 1 21 12Z',
  );
  svg.append(svgPath);
  const icon = el('span', { class: 'ai-chat-fab-icon', 'aria-hidden': 'true' }, svg);
  chatButton = el(
    'button',
    { class: 'ai-chat-fab', type: 'button', 'aria-label': 'Ask the AI assistant', hidden: true },
    icon,
  );
  chatButton.addEventListener('click', () => {
    if (panelOpen) closePanel();
    else openPanel();
  });
  document.body.append(chatButton);
}

/* ==========================================================================
 * Settings → AI assistant card (SPEC-v3.md section 9; settings Write).
 * ========================================================================== */

const PROVIDERS = [
  ['off', 'Off'],
  ['opencode', 'opencode'],
  ['openai-compatible', 'OpenAI-compatible'],
];

/**
 * The AI assistant Settings card. Load once, edit the fields, Save (PUT
 * /api/ai/config) or Test connection (POST /api/ai/test). Secrets are
 * password inputs; the server never returns them, so a configured secret
 * shows as a "Saved - leave blank to keep" placeholder instead.
 */
export function aiSettingsCard() {
  const status = el('p', { class: 'field-hint', role: 'status' });

  const providerSelect = el(
    'select',
    { id: 'ai-settings-provider', 'aria-label': 'AI provider' },
    ...PROVIDERS.map(([value, label]) => el('option', { value }, label)),
  );

  const settingsField = (input, text) => {
    input.id = `ai-settings-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    return [el('label', { class: 'field-label', for: input.id }, text), input];
  };
  const urlInput = el('input', { type: 'url', autocomplete: 'off', placeholder: 'http://127.0.0.1:4096' });
  const passwordInput = el('input', { type: 'password', autocomplete: 'new-password' });
  const providerIdInput = el('input', { type: 'text', autocomplete: 'off', placeholder: 'e.g. opencode' });
  const modelIdInput = el('input', { type: 'text', autocomplete: 'off', placeholder: 'e.g. glm-4.6' });

  const baseURLInput = el('input', { type: 'url', autocomplete: 'off', placeholder: 'http://127.0.0.1:8000/v1' });
  const apiKeyInput = el('input', { type: 'password', autocomplete: 'new-password' });
  const modelInput = el('input', { type: 'text', autocomplete: 'off', placeholder: 'e.g. qwen2.5-7b-instruct' });

  const opencodeSection = el(
    'div',
    { class: 'ai-settings-section' },
    ...settingsField(urlInput, 'Server URL'),
    ...settingsField(passwordInput, 'Server password'),
    ...settingsField(providerIdInput, 'Provider ID'),
    ...settingsField(modelIdInput, 'Model ID'),
    el('p', { class: 'field-hint' }, AI_HINT_OPENCODE),
  );
  const openaiSection = el(
    'div',
    { class: 'ai-settings-section' },
    ...settingsField(baseURLInput, 'Base URL'),
    ...settingsField(apiKeyInput, 'API key'),
    ...settingsField(modelInput, 'Model'),
  );

  function applyProviderSections(provider) {
    opencodeSection.hidden = provider !== 'opencode';
    openaiSection.hidden = provider !== 'openai-compatible';
  }
  providerSelect.addEventListener('change', () => applyProviderSections(providerSelect.value));

  function fill(config) {
    if (!config) return;
    providerSelect.value = PROVIDERS.some(([value]) => value === config.provider) ? config.provider : 'off';
    urlInput.value = (config.opencode && config.opencode.url) || '';
    providerIdInput.value = (config.opencode && config.opencode.providerID) || '';
    modelIdInput.value = (config.opencode && config.opencode.modelID) || '';
    baseURLInput.value = (config.openai && config.openai.baseURL) || '';
    modelInput.value = (config.openai && config.openai.model) || '';
    passwordInput.placeholder = config.passwordConfigured ? SECRET_PLACEHOLDER : '';
    apiKeyInput.placeholder = config.apiKeyConfigured ? SECRET_PLACEHOLDER : '';
    applyProviderSections(providerSelect.value);
  }

  async function loadConfig() {
    try {
      const response = await deps.api('GET', '/api/ai/config');
      if (response.ok) fill(response.data);
      else status.textContent = aiErrorText(response.status, response.data);
    } catch (error) {
      console.warn('Could not load the AI settings:', error);
      status.textContent = AI_OFFLINE_TEXT;
    }
  }

  const saveButton = el('button', { class: 'btn btn-primary btn-small', type: 'button' }, 'Save');
  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    try {
      const response = await deps.api('PUT', '/api/ai/config', {
        provider: providerSelect.value,
        opencode: {
          url: urlInput.value.trim(),
          password: passwordInput.value,
          providerID: providerIdInput.value.trim(),
          modelID: modelIdInput.value.trim(),
        },
        openai: {
          baseURL: baseURLInput.value.trim(),
          apiKey: apiKeyInput.value,
          model: modelInput.value.trim(),
        },
      });
      if (!response.ok) {
        status.textContent = aiErrorText(response.status, response.data);
        return;
      }
      fill(response.data);
      status.textContent = 'AI settings saved.';
      await refreshAiStatus();
      updateAiChatButton();
    } catch (error) {
      console.warn('Could not save the AI settings:', error);
      status.textContent = AI_OFFLINE_TEXT;
    } finally {
      saveButton.disabled = false;
    }
  });

  const testButton = el('button', { class: 'btn btn-small', type: 'button' }, 'Test connection');
  testButton.addEventListener('click', async () => {
    testButton.disabled = true;
    status.textContent = 'Testing the provider…';
    try {
      const response = await deps.api('POST', '/api/ai/test');
      if (response.ok) status.textContent = 'Connected: the provider answered.';
      else status.textContent = aiErrorText(response.status, response.data);
    } catch (error) {
      console.warn('AI test connection failed:', error);
      status.textContent = AI_OFFLINE_TEXT;
    } finally {
      testButton.disabled = false;
    }
  });

  void loadConfig();

  return el(
    'section',
    { class: 'card ai-settings-card', style: { padding: '0.95rem 1rem', marginTop: '0.5rem' } },
    el('h3', { class: 'card-title' }, 'AI assistant'),
    el(
      'p',
      { class: 'field-hint' },
      'Answer questions about this log with an AI provider you run and control.',
    ),
    el('label', { class: 'field-label', for: 'ai-settings-provider' }, 'Provider'),
    providerSelect,
    opencodeSection,
    openaiSection,
    el('p', { class: 'field-hint' }, AI_PRIVACY_NOTICE),
    el('div', { class: 'button-row' }, saveButton, testButton),
    status,
  );
}