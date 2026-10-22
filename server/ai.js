'use strict';

import crypto from 'node:crypto';

import { ApiError, UUID_RE } from './records.js';
import { can, storeArea } from './permissions.js';

/**
 * AI assistant server parts (SPEC-v3.md section 9): provider
 * configuration in the `settings` table, the read-only context
 * snapshot, the opencode and OpenAI-compatible providers, chat
 * history in `ai_messages`, and the JSON handlers wired into
 * server.js routes. Handlers return `{status, body, headers}` and
 * throw `ApiError` on failure; server.js sends the response.
 *
 * The assistant can never change data: the context is read-only,
 * every opencode tool is disabled, and the only write path back
 * into the app is a draft service order the user must review.
 */

const bad = (status, code, message) => new ApiError(status, code, message);
const badRequest = (message) => bad(400, 'bad_request', message);
const providerError = (message) => bad(502, 'ai_provider_error', message);

// ---------------------------------------------------------------------------
// Constants and settings keys
// ---------------------------------------------------------------------------

export const AI_PROVIDERS = ['off', 'opencode', 'openai-compatible'];
export const PROVIDER_TIMEOUT_MS = 60 * 1000;
export const MESSAGE_MAX_CHARS = 2000;
export const MESSAGE_HISTORY_LIMIT = 10;
export const MESSAGES_PER_MINUTE = 20;
export const RATE_WINDOW_MS = 60 * 1000;
export const CONTEXT_MAX_CHARS = 12000;

/**
 * Every opencode tool set to false: the agent can only answer in text
 * (SPEC-v3.md section 9). Sent as the `tools` map of each message.
 */
export const OPENCODE_DISABLED_TOOLS = Object.freeze({
  bash: false,
  edit: false,
  write: false,
  read: false,
  grep: false,
  glob: false,
  list: false,
  patch: false,
  multiedit: false,
  webfetch: false,
  websearch: false,
  codesearch: false,
  todowrite: false,
  todoread: false,
  task: false,
  skill: false,
  question: false,
  lsp: false,
  batch: false,
});

const KEYS = {
  provider: 'ai.provider',
  opencodeUrl: 'ai.opencode.url',
  opencodePassword: 'ai.opencode.password', // secret: never returned to the browser
  opencodeProviderID: 'ai.opencode.providerID',
  opencodeModelID: 'ai.opencode.modelID',
  openaiBaseURL: 'ai.openai.baseURL',
  openaiAPIKey: 'ai.openai.apiKey', // secret: never returned to the browser
  openaiModel: 'ai.openai.model',
};

/** settings key holding the opencode session id for a conversation. */
const opencodeSessionKey = (conversationId) => `ai.opencode.session.${conversationId}`;

const MAX_SECRET_CHARS = 1000;
const MAX_SETTING_CHARS = 300;

/** Current provider configuration, secrets included (server-side only). */
export function getAiConfig(store) {
  return {
    provider: store.getSetting(KEYS.provider) ?? 'off',
    opencode: {
      url: store.getSetting(KEYS.opencodeUrl),
      password: store.getSetting(KEYS.opencodePassword),
      providerID: store.getSetting(KEYS.opencodeProviderID),
      modelID: store.getSetting(KEYS.opencodeModelID),
    },
    openai: {
      baseURL: store.getSetting(KEYS.openaiBaseURL),
      apiKey: store.getSetting(KEYS.openaiAPIKey),
      model: store.getSetting(KEYS.openaiModel),
    },
  };
}

/**
 * True when a provider is configured enough for the chat button
 * (SPEC-v3.md section 9: hidden when no provider is configured).
 */
export function isAiEnabled(store) {
  const config = getAiConfig(store);
  if (config.provider === 'opencode') return config.opencode.url !== null;
  if (config.provider === 'openai-compatible') return config.openai.baseURL !== null;
  return false;
}

/** GET /api/ai/config payload: non-secret fields plus configured booleans. */
export function aiConfigPayload(store) {
  const config = getAiConfig(store);
  return {
    provider: config.provider,
    opencode: {
      url: config.opencode.url,
      providerID: config.opencode.providerID,
      modelID: config.opencode.modelID,
    },
    openai: {
      baseURL: config.openai.baseURL,
      model: config.openai.model,
    },
    apiKeyConfigured: config.openai.apiKey !== null,
    passwordConfigured: config.opencode.password !== null,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkHttpUrl(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${label} must be an http or https URL`);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw badRequest(`${label} must be an http or https URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest(`${label} must be an http or https URL, not ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw badRequest(`${label} may not contain credentials`);
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * Validate one section of PUT /api/ai/config. Non-secret fields must be
 * strings ('' clears); secret fields follow the "empty keeps the stored
 * value, null clears it" rule so browsers can send back the shape they
 * received (SPEC-v3.md section 9).
 */
/** PUT /api/ai/config (admin): change provider settings, keeping secrets on empty fields. */
export function putAiConfig(store, body) {
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object body');
  for (const key of Object.keys(body)) {
    if (!['provider', 'opencode', 'openai'].includes(key)) {
      throw badRequest(`Unknown field "${key}"; expected provider, opencode or openai`);
    }
  }

  let provider = store.getSetting(KEYS.provider);
  if (body.provider !== undefined) {
    if (typeof body.provider !== 'string' || !AI_PROVIDERS.includes(body.provider.trim())) {
      throw badRequest(`provider must be one of ${AI_PROVIDERS.join(', ')}`);
    }
    provider = body.provider.trim();
  }

  const opencode = validateOpencodeSection(body.opencode, store);
  const openai = validateOpenAISection(body.openai, store);

  store.setSetting(KEYS.provider, provider);
  applySection(store, KEYS.opencodeUrl, opencode.url);
  applySection(store, KEYS.opencodeProviderID, opencode.providerID);
  applySection(store, KEYS.opencodeModelID, opencode.modelID);
  applySecret(store, KEYS.opencodePassword, opencode.password);
  applySection(store, KEYS.openaiBaseURL, openai.baseURL);
  applySection(store, KEYS.openaiModel, openai.model);
  applySecret(store, KEYS.openaiAPIKey, openai.apiKey);
  return aiConfigPayload(store);
}

function optionalString(value, label, { max = MAX_SETTING_CHARS } = {}) {
  if (value === undefined) return { keep: true };
  if (value === null || value === '') return { clear: true };
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${label} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`${label} must be at most ${max} characters`);
  return { value: trimmed };
}

function applySection(store, key, entry) {
  // entry: {value} to set, {clear: true} to remove, {keep: true} to leave as-is.
  if (entry.keep === true) return;
  if (entry.clear === true) {
    store.deleteSetting(key);
    return;
  }
  store.setSetting(key, entry.value);
}

function applySecret(store, key, entry) {
  applySection(store, key, entry);
}

function validateOpencodeSection(section, store) {
  if (section === undefined) {
    return {
      url: { keep: true },
      providerID: { keep: true },
      modelID: { keep: true },
      password: { keep: true },
    };
  }
  if (!isPlainObject(section)) throw badRequest('opencode must be a JSON object');
  for (const key of Object.keys(section)) {
    if (!['url', 'password', 'providerID', 'modelID'].includes(key)) {
      throw badRequest(`Unknown field "${key}" in opencode`);
    }
  }
  let url;
  if (section.url === undefined) {
    url = { keep: true };
  } else if (section.url === null || section.url === '') {
    url = { clear: true };
  } else {
    url = { value: checkHttpUrl(section.url, 'opencode.url') };
  }
  let password;
  if (section.password === undefined || section.password === '') {
    password = { keep: true };
  } else if (section.password === null) {
    password = { clear: true };
  } else if (typeof section.password !== 'string' || section.password.length > MAX_SECRET_CHARS) {
    throw badRequest(`opencode.password must be a string of at most ${MAX_SECRET_CHARS} characters`);
  } else {
    password = { value: section.password };
  }
  const providerID = optionalString(section.providerID, 'opencode.providerID', { max: 200 });
  const modelID = optionalString(section.modelID, 'opencode.modelID', { max: 200 });
  return { url, password, providerID, modelID };
}

function validateOpenAISection(section) {
  if (section === undefined) {
    return { baseURL: { keep: true }, apiKey: { keep: true }, model: { keep: true } };
  }
  if (!isPlainObject(section)) throw badRequest('openai must be a JSON object');
  for (const key of Object.keys(section)) {
    if (!['baseURL', 'apiKey', 'model'].includes(key)) {
      throw badRequest(`Unknown field "${key}" in openai`);
    }
  }
  let baseURL;
  if (section.baseURL === undefined) {
    baseURL = { keep: true };
  } else if (section.baseURL === null || section.baseURL === '') {
    baseURL = { clear: true };
  } else {
    baseURL = { value: checkHttpUrl(section.baseURL, 'openai.baseURL') };
  }
  let apiKey;
  if (section.apiKey === undefined || section.apiKey === '') {
    apiKey = { keep: true };
  } else if (section.apiKey === null) {
    apiKey = { clear: true };
  } else if (typeof section.apiKey !== 'string' || section.apiKey.length > MAX_SECRET_CHARS) {
    throw badRequest(`openai.apiKey must be a string of at most ${MAX_SECRET_CHARS} characters`);
  } else {
    apiKey = { value: section.apiKey };
  }
  const model = optionalString(section.model, 'openai.model', { max: 200 });
  return { baseURL, apiKey, model };
}

// ---------------------------------------------------------------------------
// System prompt and read-only context (SPEC-v3.md section 9)
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = [
  'You are the assistant inside Shopfloor CMMS, a maintenance log app for a garment workshop.',
  'App vocabulary:',
  '- Service Orders (the "workOrders" store) are the work tickets. Kinds: breakdown, pm, facility, install or other. Statuses: open, in-progress, waiting-parts, waiting-tech, done. Priorities: none, low, medium, high, urgent. Categories: mechanical, electrical, pneumatic, facility, safety, cleaning, other. Numbers look like "SO-0001" and are assigned by the app.',
  '- Preventive Maintenance ("pmTasks") are recurring tasks per machine with an interval in days. The next due date is lastDoneAt + intervalDays; a task with no lastDoneAt is due today.',
  '- Machines are the workshop devices (machine types include single-needle, double-needle, overlock-5/4/3, coverstitch, bartack, buttonhole, button-sew, snap-attach, feed-off-arm, blindstitch, cutter, pressing). Statuses: running, down, in-storage, retired.',
  '- Parts is the spare-part inventory; a part is low stock when qtyOnHand is below its minQty.',
  '- Coworkers are internal staff; Outside Contractors are external companies with a trade.',
  '- Users are login accounts; service orders are reported by users or requested by staff.',
  'The data below is a READ-ONLY snapshot of the shop taken for this question. You cannot change, create or delete anything: you have no tools and no writing ability. If the user asks to change something, tell them which screen to use.',
  'If the user needs a new service order, you may propose one by writing a fenced JSON block exactly like this:',
  '```json',
  '{"draftServiceOrder": {"title": "...", "machineId": "...", "priority": "medium", "problem": "..."}}',
  '```',
  'In a draftServiceOrder use only these fields: title, machineId, kind, priority, category, dueDate, requestedBy, problem, actionTaken, checklist, assignees, labour, partsUsed. Never invent machine ids: use ids from the snapshot. The user reviews and saves the draft themselves; nothing is saved automatically.',
  'Otherwise answer briefly and helpfully in plain text.',
].join('\n');

/** Snapshot areas and the plain names used when telling the model one is hidden. */
const CONTEXT_AREA_LABELS = [
  ['serviceOrders', 'service orders'],
  ['pm', 'preventive maintenance'],
  ['machines', 'machines'],
  ['parts', 'parts and stock'],
  ['coworkers', 'coworkers'],
  ['contractors', 'outside contractors'],
];

/**
 * The system prompt for one signed-in user (SPEC-v3.md section 9 with
 * 13): the shared prompt plus, when areas are hidden from the user's role,
 * a note naming them so the assistant answers that the user does not have
 * access to that area instead of guessing. Rates are a note of their own
 * because contractors may be readable while rates are not.
 */
export function aiSystemPrompt(store, user) {
  const who = { ...user, store };
  const hidden = CONTEXT_AREA_LABELS.filter(([area]) => !can(who, area, 'read')).map(([, label]) => label);
  const notes = [];
  if (hidden.length > 0) {
    notes.push(
      `The signed-in user does not have access to the following areas of the app: ${hidden.join(', ')}. Nothing from those areas appears in the data snapshot. If a question needs one of them, answer that the user does not have access to that area instead of guessing.`
    );
  }
  if (!can(who, 'contractorRates', 'read')) {
    notes.push(
      'Contractor hourly rates and costs are not available to this user; if asked about them, answer that the user does not have access to contractor rates instead of guessing.'
    );
  }
  return notes.length === 0 ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n${notes.join('\n')}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function isoDate(now = new Date()) {
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
}

/** `YYYY-MM-DD` plus whole days, or null for a non-date. */
function isoAddDays(dateISO, days) {
  if (typeof dateISO !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null;
  const date = new Date(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function clip(value, max) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Machine label used inside the snapshot: name plus custom type label. */
function machineLabel(machine) {
  if (machine === null || machine === undefined) return null;
  return machine.data.name ?? machine.id;
}

/**
 * Service-order snapshot entry. When the user cannot read machines, a
 * referenced machine shows up as 'a machine' without its details (SPEC-v3.md
 * 13 with section 9: only areas the role can Read enter the context).
 */
function workOrderEntry(record, machines, machinesReadable) {
  const data = record.data;
  const machine = machinesReadable ? machines.get(data.machineId) ?? null : null;
  return {
    id: record.id,
    number: data.number ?? null,
    title: clip(data.title, 120),
    status: data.status,
    priority: data.priority,
    category: data.category,
    machineId: machinesReadable ? data.machineId ?? null : null,
    machine: machinesReadable ? machineLabel(machine) : 'a machine',
    dueDate: data.dueDate ?? null,
    problem: clip(data.problem, 400),
  };
}

function machineEntry(record) {
  const data = record.data;
  return {
    id: record.id,
    name: data.name,
    type: data.type ?? null,
    customType: data.typeLabel ?? null,
    model: clip(data.model, 60),
    location: clip(data.location, 60),
    status: data.status ?? null,
    notes: clip(data.notes, 300),
  };
}

function partEntry(record) {
  const data = record.data;
  return {
    id: record.id,
    name: data.name,
    partNumber: clip(data.partNumber, 60),
    qtyOnHand: Number(data.qtyOnHand) || 0,
    minQty: Number(data.minQty) || 0,
    unit: data.unit ?? null,
    location: clip(data.location, 60),
  };
}

/** PM task entry; machine references follow machines readability like service orders. */
function pmTaskEntry(record, machines, machinesReadable) {
  const data = record.data;
  const machine = machinesReadable ? machines.get(data.machineId) ?? null : null;
  return {
    id: record.id,
    title: clip(data.title, 120),
    machineId: machinesReadable ? data.machineId ?? null : null,
    machine: machinesReadable ? machineLabel(machine) : 'a machine',
    intervalDays: data.intervalDays ?? null,
    lastDoneAt: data.lastDoneAt ?? null,
    instructions: clip(data.instructions, 300),
  };
}

function coworkerEntry(record) {
  const data = record.data;
  return {
    id: record.id,
    name: data.name,
    role: clip(data.role, 60),
    shift: data.shift ?? null,
    phone: clip(data.phone, 40),
    email: clip(data.email, 80),
    skills: clip(data.skills, 200),
    active: data.active !== false,
  };
}

/** Contractor entry; hourlyRate only with contractorRates Read (SPEC-v3.md 13.1). */
function contractorEntry(record, includeRate) {
  const data = record.data;
  const entry = {
    id: record.id,
    company: data.company,
    trade: clip(data.trade, 60),
    contactName: clip(data.contactName, 80),
    phone: clip(data.phone, 40),
    email: clip(data.email, 80),
    machineIds: Array.isArray(data.machineIds) ? data.machineIds : undefined,
    active: data.active !== false,
  };
  if (includeRate) entry.hourlyRate = data.hourlyRate ?? null;
  return entry;
}

const KEYWORD_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'you', 'your', 'what', 'when',
  'where', 'which', 'who', 'why', 'how', 'does', 'did', 'have', 'has', 'its',
  'this', 'that', 'these', 'those', 'with', 'from', 'they', 'their', 'there',
  'about', 'into', 'over', 'under', 'again', 'then', 'once', 'here', 'all',
  'any', 'both', 'each', 'more', 'most', 'other', 'some', 'such', 'only',
  'own', 'same', 'than', 'too', 'very', 'can', 'will', 'just', 'should',
  'now', 'our', 'also', 'because', 'while', 'been', 'being', 'between',
  'after', 'before', 'during', 'against', 'above', 'below', 'off', 'out',
  'down', 'give', 'tell', 'show', 'make', 'need', 'want', 'know', 'get',
  'please', 'could', 'would', 'mind', 'list', 'see', 'look', 'help',
]);

function questionKeywords(question) {
  if (typeof question !== 'string') return [];
  const words = question.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const seen = new Set();
  const keywords = [];
  for (const word of words) {
    if (word.length < 3 || KEYWORD_STOPWORDS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    keywords.push(word);
  }
  return keywords;
}

/**
 * Build the read-only data snapshot for one question (SPEC-v3.md
 * section 9 with section 13): open and overdue service orders, down
 * machines, PM due within 7 days, low-stock parts and up to 20 records
 * matching keywords of the question. A store's records enter the snapshot
 * only when the user's role can Read that store's area (`can(user,
 * storeArea(store), 'read')`); service orders and PM tasks referencing a
 * machine the user cannot read show 'a machine' without its details.
 * Contractor hourlyRate (and any cost) needs `contractorRates` Read.
 * Never reads users, sessions or files. Capped at CONTEXT_MAX_CHARS.
 *
 * @param {object} store open store handle
 * @param {{id: string, roleId: string, store?: object}} user the signed-in user
 * @param {string} question the user's message
 */
export function buildContext(store, user, question, { now = new Date() } = {}) {
  const who = { ...user, store };
  const read = (storeName) => can(who, storeArea(storeName), 'read');
  const readMachines = can(who, 'machines', 'read');
  const includeRate = can(who, 'contractorRates', 'read');
  const workOrders = read('workOrders') ? store.listRecords('workOrders') : [];
  const machinesList = readMachines ? store.listRecords('machines') : [];
  const parts = read('parts') ? store.listRecords('parts') : [];
  const pmTasks = read('pmTasks') ? store.listRecords('pmTasks') : [];
  const coworkers = read('coworkers') ? store.listRecords('coworkers') : [];
  const contractors = read('contractors') ? store.listRecords('contractors') : [];

  // Only machines the user can read: references to any other machine show
  // as 'a machine' in the entries below (machinesReadable).
  const machines = new Map(machinesList.map((record) => [record.id, record]));
  const lines = [];
  const addSection = (title, entries, cap) => {
    if (entries.length === 0) return;
    lines.push(`${title} (${Math.min(entries.length, cap ?? entries.length)}):`);
    for (const entry of entries.slice(0, cap)) {
      lines.push(`- ${JSON.stringify(entry)}`);
    }
  };

  // Open and overdue service orders (statuses before done), overdue first.
  const today = isoDate(now);
  const openOrders = workOrders
    .filter((record) => record.data.status !== 'done')
    .map((record) => {
      const entry = workOrderEntry(record, machines, readMachines);
      entry.overdue =
        typeof entry.dueDate === 'string' && entry.dueDate !== '' && entry.dueDate < today;
      return entry;
    })
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999')));
  const overdue = openOrders.filter((entry) => entry.overdue);
  const notOverdue = openOrders.filter((entry) => !entry.overdue);
  addSection('Open service orders', notOverdue, 30);
  addSection('Overdue service orders', overdue, 30);

  // Down machines.
  const downMachines = machinesList.filter((record) => record.data.status === 'down');
  addSection('Down machines', downMachines.map(machineEntry), 30);

  // PM due within 7 days: active tasks whose machine is not paused
  // (In storage or Retired machines pause their PM, SPEC-v2.md 15.3).
  const in7Days = isoAddDays(today, 7);
  const pmDue = pmTasks
    .map((record) => {
      const machine = machines.get(record.data.machineId) ?? null;
      const machineStatus = machine === null ? null : machine.data.status;
      if (record.data.active === false) return null;
      if (machineStatus === 'in-storage' || machineStatus === 'retired') return null;
      const dueDate =
        typeof record.data.lastDoneAt === 'string' && record.data.lastDoneAt !== ''
          ? isoAddDays(record.data.lastDoneAt, Number(record.data.intervalDays) || 0)
          : today;
      if (dueDate === null || dueDate > in7Days) return null;
      return { ...pmTaskEntry(record, machines, readMachines), dueDate, overdue: dueDate < today };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  addSection('PM tasks due within 7 days (including overdue)', pmDue, 30);

  // Low-stock parts.
  const lowStock = parts.filter((record) => Number(record.data.qtyOnHand ?? 0) < Number(record.data.minQty ?? 0));
  addSection('Low-stock parts (qtyOnHand below minQty)', lowStock.map(partEntry), 30);

  // Up to 20 records matching keywords of the question, across stores.
  const keywords = questionKeywords(question);
  if (keywords.length > 0) {
    const searchable = [
      ...workOrders.map((record) => ({ store: 'service order', entry: workOrderEntry(record, machines, readMachines) })),
      ...machinesList.map((record) => ({ store: 'machine', entry: machineEntry(record) })),
      ...parts.map((record) => ({ store: 'part', entry: partEntry(record) })),
      ...pmTasks.map((record) => ({ store: 'pm task', entry: pmTaskEntry(record, machines, readMachines) })),
      ...coworkers.map((record) => ({ store: 'coworker', entry: coworkerEntry(record) })),
      ...contractors.map((record) => ({ store: 'contractor', entry: contractorEntry(record, includeRate) })),
    ];
    const matches = [];
    for (const record of searchable) {
      if (matches.length >= 20) break;
      const haystack = JSON.stringify(record.entry).toLowerCase();
      if (keywords.some((word) => haystack.includes(word))) {
        matches.push({ store: record.store, ...record.entry });
      }
    }
    addSection('Records matching words of the question', matches, 20);
  }

  // Cap the snapshot, keeping the urgent sections first (SPEC-v3.md 9).
  let text = '';
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > CONTEXT_MAX_CHARS) {
      text += `${text === '' ? '' : '\n'}(+ more context not included)`;
      break;
    }
    text += `${text === '' ? '' : '\n'}${line}`;
    used += line.length + 1;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Rate limit: 20 chat messages per minute per user (SPEC-v3.md section 9)
// ---------------------------------------------------------------------------

const rateBuckets = new Map();

/**
 * Record one chat message for `userId`; returns null when allowed, or the
 * seconds until the oldest message leaves the window when the 20/min
 * limit is hit. In-memory per server process.
 */
export function takeAiMessageQuota(userId, now = Date.now()) {
  const bucket = (rateBuckets.get(userId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (bucket.length >= MESSAGES_PER_MINUTE) {
    rateBuckets.set(userId, bucket);
    const retryAfterMs = bucket[0] + RATE_WINDOW_MS - now;
    return Math.max(1, Math.ceil(retryAfterMs / 1000));
  }
  bucket.push(now);
  rateBuckets.set(userId, bucket);
  if (rateBuckets.size > 500) {
    for (const [key, entries] of rateBuckets) {
      if (entries.every((at) => now - at >= RATE_WINDOW_MS)) rateBuckets.delete(key);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Providers (server-side only; the browser never sees these requests)
// ---------------------------------------------------------------------------

function logProviderFailure(step, err) {
  // err.name is 'TimeoutError'/'AbortError'/'TypeError' etc. and carries no
  // secrets; err.cause may embed the URL, so it is not logged.
  console.error(`[maint-log] AI provider ${step} failed:`, err && err.name ? err.name : err);
}

function toProviderError(err) {
  const timedOut = err !== null && typeof err === 'object' && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return providerError(
    timedOut
      ? 'The AI provider did not answer in time. Please try again in a moment.'
      : 'Could not reach the AI provider. Please try again in a moment.'
  );
}

/** JSON POST with the 60 s provider timeout; ApiError(502) on failure. */
async function providerJsonRequest(step, url, init, timeout = PROVIDER_TIMEOUT_MS) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    logProviderFailure(step, err);
    throw toProviderError(err);
  }
  if (response.status < 200 || response.status >= 300) {
    console.error(`[maint-log] AI provider ${step} failed: HTTP ${response.status}`);
    throw providerError('The AI provider returned an error. Please try again later.');
  }
  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw providerError('The AI provider sent an unexpected reply. Please try again later.');
  }
  return payload;
}

function withoutTrailingSlash(url) {
  return String(url).replace(/\/+$/, '');
}

/**
 * OpenAI-compatible provider (SPEC-v3.md section 9): POST
 * {baseURL}/chat/completions with {model, messages, temperature: 0.2},
 * a Bearer key when set. Returns the assistant message content.
 */
export async function callOpenAICompatible({ baseURL, apiKey, model }, messages, { timeout = PROVIDER_TIMEOUT_MS } = {}) {
  if (baseURL === null || baseURL === undefined) throw badRequest('openai.baseURL is not configured');
  if (model === null || model === undefined) throw badRequest('openai.model is not configured');
  const headers = {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
  const payload = await providerJsonRequest(
    'chat/completions',
    `${withoutTrailingSlash(baseURL)}/chat/completions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, temperature: 0.2 }),
    },
    timeout
  );
  const content =
    payload !== null &&
    typeof payload === 'object' &&
    Array.isArray(payload.choices) &&
    payload.choices[0] !== null &&
    typeof payload.choices[0] === 'object' &&
    payload.choices[0].message !== null &&
    typeof payload.choices[0].message === 'object' &&
    typeof payload.choices[0].message.content === 'string'
      ? payload.choices[0].message.content
      : null;
  if (content === null) {
    throw providerError('The AI provider sent an unexpected reply. Please try again later.');
  }
  return content;
}

function basicAuthHeader(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

function opencodeHeaders(password) {
  return {
    'content-type': 'application/json',
    ...(password ? { authorization: basicAuthHeader(password) } : {}),
  };
}

function pickSessionId(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  const candidates = [payload.id, payload.session?.id, payload.data?.id];
  const found = candidates.find((value) => typeof value === 'string' && value.trim() !== '');
  return found === undefined ? null : found.trim();
}

/**
 * Create one opencode session (POST {url}/session); returns its id. Used
 * once per conversation, then reused, per SPEC-v3.md section 9.
 */
export async function createOpencodeSession({ url, password }, { timeout = PROVIDER_TIMEOUT_MS } = {}) {
  if (url === null || url === undefined) throw badRequest('opencode.url is not configured');
  const payload = await providerJsonRequest(
    'session create',
    `${withoutTrailingSlash(url)}/session`,
    { method: 'POST', headers: opencodeHeaders(password), body: JSON.stringify({}) },
    timeout
  );
  const sessionId = pickSessionId(payload);
  if (sessionId === null) {
    throw providerError('The AI provider did not return a session. Please try again later.');
  }
  return sessionId;
}

/** Concatenate the text parts of an opencode message reply. */
function opencodeReplyText(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  const parts = Array.isArray(payload.parts)
    ? payload.parts
    : payload.message !== null &&
      typeof payload.message === 'object' &&
      Array.isArray(payload.message.parts)
      ? payload.message.parts
      : [];
  const text = parts
    .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  return text;
}

/**
 * Send one message to an opencode session (POST {url}/session/:id/message)
 * with the configured model, the system prompt, text parts and every tool
 * disabled (OPENCODE_DISABLED_TOOLS). Returns the concatenated text parts.
 */
export async function sendOpencodeMessage(
  { url, password, providerID, modelID },
  sessionId,
  { system, parts },
  { timeout = PROVIDER_TIMEOUT_MS } = {}
) {
  if (url === null || url === undefined) throw badRequest('opencode.url is not configured');
  if (providerID === null || providerID === undefined) throw badRequest('opencode.providerID is not configured');
  if (modelID === null || modelID === undefined) throw badRequest('opencode.modelID is not configured');
  const payload = await providerJsonRequest(
    'session message',
    `${withoutTrailingSlash(url)}/session/${encodeURIComponent(sessionId)}/message`,
    {
      method: 'POST',
      headers: opencodeHeaders(password),
      body: JSON.stringify({
        model: { providerID, modelID },
        system,
        parts,
        tools: OPENCODE_DISABLED_TOOLS,
      }),
    },
    timeout
  );
  const text = opencodeReplyText(payload);
  if (text === null || text.trim() === '') {
    throw providerError('The AI provider sent an empty answer. Please try again later.');
  }
  return text;
}

/** The opencode session id stored for a conversation, or null. */
export function getOpencodeSessionId(store, conversationId) {
  return store.getSetting(opencodeSessionKey(conversationId));
}

// ---------------------------------------------------------------------------
// Draft service orders (SPEC-v3.md section 9)
// ---------------------------------------------------------------------------

const DRAFT_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const DRAFT_KINDS = ['breakdown', 'pm', 'facility', 'install', 'other'];
const DRAFT_STATUSES = ['open', 'in-progress', 'waiting-parts', 'waiting-tech', 'done'];
const DRAFT_CATEGORIES = [
  'mechanical',
  'electrical',
  'pneumatic',
  'facility',
  'safety',
  'cleaning',
  'other',
];

function isISODateValue(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Loose draft service-order validation: keep only known service-order
 * fields with roughly matching types (SPEC-v3.md section 9). Unknown or
 * malformed fields are dropped, never fatal.
 */
function sanitizeDraftServiceOrder(draft) {
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
    if (DRAFT_PRIORITIES.includes(priority)) out.priority = priority;
  }
  for (const [field, values] of [
    ['kind', DRAFT_KINDS],
    ['status', DRAFT_STATUSES],
    ['category', DRAFT_CATEGORIES],
  ]) {
    if (values.includes(draft[field])) out[field] = draft[field];
  }
  for (const field of ['dueDate', 'reportedAt', 'completedAt']) {
    if (isISODateValue(draft[field])) out[field] = draft[field];
  }
  const arrays = {
    assignees: 10,
    labour: 200,
    checklist: 50,
    partsUsed: 200,
  };
  for (const [field, max] of Object.entries(arrays)) {
    if (Array.isArray(draft[field])) out[field] = draft[field].slice(0, max);
  }
  for (const field of ['downtimeMinutes', 'minutesSpent']) {
    if (Number.isInteger(draft[field]) && draft[field] >= 0) out[field] = draft[field];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Extract the draft service order from a reply's fenced JSON block:
 * ```json {"draftServiceOrder": {...}}```. Returns null when there is no
 * block, it is not valid JSON, or nothing usable is left after sanitizing.
 */
export function parseDraftServiceOrder(reply) {
  if (typeof reply !== 'string') return null;
  const match = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/.exec(reply);
  if (match === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.draftServiceOrder)) return null;
  return sanitizeDraftServiceOrder(parsed.draftServiceOrder);
}

// ---------------------------------------------------------------------------
// Request handlers (returns {status, body, headers}; ApiError on failure)
// ---------------------------------------------------------------------------

function checkConversationId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw badRequest('conversationId must be a UUID');
  }
  return value;
}

function requireReadyProvider(config) {
  if (config.provider === 'off') {
    throw bad(400, 'ai_disabled', 'The AI assistant is turned off; an admin can enable it in Settings.');
  }
  if (config.provider === 'opencode') {
    const missing = ['url', 'providerID', 'modelID'].filter((key) => config.opencode[key] === null);
    if (missing.length > 0) {
      throw bad(400, 'ai_incomplete', `The opencode provider is missing ${missing.join(', ')}.`);
    }
  } else if (config.provider === 'openai-compatible') {
    const configKey = config.openai;
    const missing = ['baseURL', 'model'].filter((key) => configKey[key] === null);
    if (missing.length > 0) {
      throw bad(400, 'ai_incomplete', `The openai-compatible provider is missing ${missing.join(', ')}.`);
    }
  } else {
    throw badRequest('provider must be one of off, opencode, openai-compatible');
  }
  return config;
}

const aiAt = () => new Date().toISOString();

/** GET /api/ai/config (admin): provider and non-secret fields, never secrets. */
export function aiGetConfig(ctx) {
  return { status: 200, body: aiConfigPayload(ctx.store) };
}

/** PUT /api/ai/config (admin): change provider settings. */
export function aiPutConfig(ctx, req, body) {
  return { status: 200, body: putAiConfig(ctx.store, body) };
}

/** GET /api/ai/status (any signed-in user): is the chat button visible. */
export function aiGetStatus(ctx) {
  return { status: 200, body: { enabled: isAiEnabled(ctx.store) } };
}

/** POST /api/ai/test (admin): one round trip to the configured provider. */
export async function aiPostTest(ctx) {
  const config = requireReadyProvider(getAiConfig(ctx.store));
  const ping = 'Reply with the single word: ready.';
  if (config.provider === 'openai-compatible') {
    await callOpenAICompatible(config.openai, [{ role: 'user', content: ping }]);
  } else {
    const sessionId = await createOpencodeSession(config.opencode);
    await sendOpencodeMessage(config.opencode, sessionId, {
      system: SYSTEM_PROMPT,
      parts: [{ type: 'text', text: ping }],
    });
  }
  return { status: 200, body: { ok: true } };
}

/** GET /api/ai/history (?conversationId=): the user's own chat messages. */
export function aiGetHistory(ctx, req) {
  const query = new URL(req.url, 'http://localhost').searchParams;
  let conversationId = null;
  if (query.get('conversationId') !== null && query.get('conversationId') !== '') {
    conversationId = checkConversationId(query.get('conversationId'));
  }
  return { status: 200, body: { messages: ctx.store.listAiMessages(ctx.user.id, conversationId) } };
}

/** DELETE /api/ai/history (?conversationId=): clear the user's own history. */
export function aiDeleteHistory(ctx, req) {
  const query = new URL(req.url, 'http://localhost').searchParams;
  let conversationId = null;
  if (query.get('conversationId') !== null && query.get('conversationId') !== '') {
    conversationId = checkConversationId(query.get('conversationId'));
  }
  return { status: 200, body: { ok: true, deleted: ctx.store.deleteAiMessages(ctx.user.id, conversationId) } };
}

/**
 * POST /api/ai/chat {conversationId?, message} (any signed-in user):
 * store the user message, build the read-only context, ask the provider,
 * parse a draft service order, store the assistant message. Rate limited
 * to 20 messages per minute per user (429).
 *
 * Handlers are called (ctx, req, body) by the aiRoute wrapper in server.js.
 */
export async function aiPostChat(ctx, req, body) {
  const { store, user } = ctx;
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object body');
  for (const key of Object.keys(body)) {
    if (!['conversationId', 'message'].includes(key)) {
      throw badRequest(`Unknown field "${key}"; expected conversationId, message`);
    }
  }
  let conversationId = null;
  if (body.conversationId !== undefined && body.conversationId !== null) {
    conversationId = checkConversationId(body.conversationId);
  }
  const message = body.message;
  if (typeof message !== 'string') throw badRequest('message must be a string');
  const text = message.trim();
  if (text === '') throw badRequest('message must not be empty');
  if (text.length > MESSAGE_MAX_CHARS) {
    throw badRequest(`message must be at most ${MESSAGE_MAX_CHARS} characters`);
  }

  // 20 messages per minute per user (SPEC-v3.md section 9).
  const retryAfterSeconds = takeAiMessageQuota(user.id);
  if (retryAfterSeconds !== null) {
    return {
      status: 429,
      body: {
        error: 'rate_limited',
        message: `Too many AI messages in the last minute; try again in about ${retryAfterSeconds} seconds.`,
      },
      headers: { 'Retry-After': String(retryAfterSeconds) },
    };
  }

  const config = requireReadyProvider(getAiConfig(store));
  if (conversationId === null) conversationId = crypto.randomUUID();
  const context = buildContext(store, user, text);

  let reply;
  if (config.provider === 'openai-compatible') {
    // Store the user message first, then send prior turns plus the question.
    const prior = store
      .listAiMessages(user.id, conversationId)
      .slice(-MESSAGE_HISTORY_LIMIT)
      .map((row) => ({ role: row.role, content: row.content }));
    store.insertAiMessage({
      conversationId,
      userId: user.id,
      role: 'user',
      content: text,
      at: aiAt(),
    });
    const system = aiSystemPrompt(store, user);
    const messages = [
      { role: 'system', content: `${system}\n\nRead-only data snapshot:\n${context}` },
      ...prior,
      { role: 'user', content: text },
    ];
    reply = await callOpenAICompatible(config.openai, messages);
  } else {
    // opencode: one session per conversation, reused across messages.
    let sessionId = getOpencodeSessionId(store, conversationId);
    if (sessionId === null) {
      sessionId = await createOpencodeSession(config.opencode);
      store.setSetting(opencodeSessionKey(conversationId), sessionId);
    }
    store.insertAiMessage({
      conversationId,
      userId: user.id,
      role: 'user',
      content: text,
      at: aiAt(),
    });
    reply = await sendOpencodeMessage(config.opencode, sessionId, {
      system: aiSystemPrompt(store, user),
      parts: [
        { type: 'text', text: `Read-only data snapshot:\n${context}` },
        { type: 'text', text },
      ],
    });
  }

  const draftServiceOrder = parseDraftServiceOrder(reply);
  store.insertAiMessage({
    conversationId,
    userId: user.id,
    role: 'assistant',
    content: reply,
    at: aiAt(),
  });
  return { status: 200, body: { conversationId, reply, draftServiceOrder } };
}