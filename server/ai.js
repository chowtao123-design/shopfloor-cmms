'use strict';

import crypto from 'node:crypto';

import { hashPassword } from './auth.js';
import { ApiError, UUID_RE, putRecord } from './records.js';
import { addMissingRolePermissions, can, normalizePermissions, storeArea } from './permissions.js';
import { formatOrderNumber, normalizeModel, relatedLibraryItems } from '../logic.js';

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
export const CONTEXT_MAX_CHARS = 20000;
/** Library budget inside the snapshot (SPEC-v4.md section 5, V4-M5). */
export const LIBRARY_CONTEXT_MAX_CHARS = 7000;
/** Manual pages are split into chunks of roughly this many characters. */
export const LIBRARY_CHUNK_MAX_CHARS = 1200;
/** Prepared manual chunks kept in memory per process, oldest dropped first. */
export const MANUAL_CHUNK_CACHE_MAX_FILES = 20;

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
  '- Service Orders (the "workOrders" store) are the work tickets. Kinds: breakdown, pm, facility, install or other. Statuses: open, in-progress, waiting-parts, waiting-tech, done. Priorities: none, low, medium, high, urgent. Categories: mechanical, electrical, pneumatic, facility, safety, cleaning, other. Numbers look like "SO-261022-1" (the day it was opened, then that day\'s count; older ones look like "SO-0001") and are assigned by the app.',
  '- Preventive Maintenance ("pmTasks") are recurring tasks per machine with an interval in days. The next due date is lastDoneAt + intervalDays; a task with no lastDoneAt is due today.',
  '- Machines are the workshop devices (machine types include single-needle, double-needle, overlock-5/4/3, coverstitch, bartack, buttonhole, button-sew, snap-attach, feed-off-arm, blindstitch, cutter, pressing). Statuses: running, down, in-storage, retired.',
  '- Parts is the spare-part inventory; a part is low stock when qtyOnHand is below its minQty.',
  '- Coworkers are internal staff; Outside Contractors are external companies with a trade.',
  '- Users are login accounts; service orders are reported by users or requested by staff.',
  'The data below is a READ-ONLY snapshot of the shop taken for this question. You cannot write anything directly: you can only propose changes that the user applies with one click. Never claim something is saved, created or deleted by you.',
  'You can propose changes to machines, service orders, preventive maintenance tasks and repair methods (Library). To propose up to 3 changes, end your answer with fenced JSON blocks exactly like this:',
  '```json',
  '{"proposals": [{"store": "machines", "id": "<record id from the snapshot, or omit for a new record>", "summary": "one short sentence", "fields": {"status": "down", "notes": "..."}}]}',
  '```',
  'In a proposal, store must be machines, workOrders, pmTasks or libraryItems; fields holds only the fields to change (for a new record, the fields it needs). A libraryItems proposal is create-only: give no id and set kind to "method" with title, symptom, cause, steps (an array of {"id", "text"}), toolsParts and safety, plus models (the model of that machine, e.g. ["DDL-8700-7"]) and machineIds (the id of that machine from the snapshot) so the method shows on that machine - typically to save a fix as a repair method after the user confirms the repair worked. Use real record ids from the snapshot and never invent one for an existing record. Never propose deletes and never send id, version, number, createdBy or updatedBy as fields. The user must press Apply: nothing is saved until they do, so say that. When you propose a change, do not tell the user to edit the record by hand - tell them to press Apply. Propose only when the user asks for a change or agrees to one.',
  'Only state facts that appear in the snapshot. Do not guess causes, parts, people, dates or next steps that the records do not contain; if something is not recorded, say "not recorded" and suggest which field to fill in. When you give a reason, quote the record it comes from (service order number, title or problem text).',
  'For every "how many" question use the "Shop totals" lines. The extract under them is capped and incomplete, so never count its rows; a record may legitimately appear once as a machine and again inside a PM task or service order. If a figure is not in the totals, say it is not recorded rather than estimating.',
  'Questions like "what is most of the work", "which type is the majority" or "what do the PM tasks cover" are answered from the breakdown lines in "Shop totals" (machine types, PM task titles, priorities and categories, most common first). Quote those counts; do not answer "not recorded" when a breakdown line covers it.',
  'For fault and repair questions, build the answer on the "Library" part of the snapshot first: the matching repair methods, the manual excerpts and the past fixes for that machine. Cite the source next to each fact exactly as it is labelled there - for example (Repair method: Thread breaks at high speed), (Manual: Juki DDL-8700 manual, p. 23) or (SO-261022-1). If the Library part has nothing for that machine, say so plainly and make clear your answer is general knowledge, not from the shop records.',
  'Give step-by-step checks in the order a technician would do them: simple, non-invasive checks first (thread path, needle condition, threading, tension) before adjustments or disassembly. Always tell the user to power off and lock out the machine before any guard, belt or knife is removed, and say it before the first such step - never after.',
  'Otherwise answer briefly and helpfully in plain text. Use **bold** and "- " bullet lists only; no other Markdown.',
].join('\n');

/** Snapshot areas and the plain names used when telling the model one is hidden. */
const CONTEXT_AREA_LABELS = [
  ['serviceOrders', 'service orders'],
  ['pm', 'preventive maintenance'],
  ['machines', 'machines'],
  ['parts', 'parts and stock'],
  ['library', 'the repair library (manuals and repair methods)'],
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

// ---------------------------------------------------------------------------
// Repair library context (SPEC-v4.md section 5, V4-M5): detect the machines
// a question is about, then fill a Library block (repair methods, manual
// excerpts with page labels, past fixes) within LIBRARY_CONTEXT_MAX_CHARS.
// ---------------------------------------------------------------------------

/** Unique content words of a text: lower-cased, punctuation stripped, no stopwords. */
export function tokenSet(text) {
  const words = String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const tokens = new Set();
  for (const word of words) {
    if (word.length < 3 || KEYWORD_STOPWORDS.has(word)) continue;
    tokens.add(word);
  }
  return tokens;
}

/**
 * Model numbers and error codes a question mentions ("E302", "Err-12",
 * "DDL-8700-7", "ddl 8700-7"): letter-led tokens with digits, reduced with
 * normalizeModel so spacing and dashes never matter. Each one that also
 * appears in a chunk scores +3 (SPEC-v4.md section 5).
 */
export function specialQuestionTokens(question) {
  if (typeof question !== 'string' || question.trim() === '') return [];
  const lower = question.toLowerCase();
  const tokens = new Set();
  for (const match of lower.matchAll(/[a-z]{1,8}[\s-]?\d{1,8}(?:[\s-]?\d{1,8}|-[a-z0-9]{1,8})*/g)) {
    const token = normalizeModel(match[0]);
    if (token.length >= 4) tokens.add(token);
  }
  return [...tokens];
}

/**
 * Word-overlap score of one candidate text against the question: +1 per
 * question keyword present, +3 per model number / error code token present.
 */
export function overlapScore(text, questionTokens, specialTokens) {
  let score = 0;
  if (questionTokens instanceof Set && questionTokens.size > 0) {
    const words = tokenSet(text);
    for (const word of questionTokens) {
      if (words.has(word)) score += 1;
    }
  }
  if (Array.isArray(specialTokens) && specialTokens.length > 0) {
    const squashed = normalizeModel(text);
    for (const token of specialTokens) {
      if (squashed.includes(token)) score += 3;
    }
  }
  return score;
}

/**
 * The machines a question is about (SPEC-v4.md section 5): by machine name,
 * model number (through normalizeModel, so spacing never matters), serial
 * number, or the machine of a service order number mentioned in the
 * question ("SO-261022-1" / "261022-1", the older "SO-0042" / "SO 42", or a bare 42 that is a real SO number).
 * `machinesList` should already hold only machines the user can read.
 */
export function detectQuestionMachines(question, machinesList, workOrders) {
  if (typeof question !== 'string' || question.trim() === '') return [];
  const q = question.toLowerCase();
  const squashed = normalizeModel(question);
  const numbers = new Set();
  for (const match of q.matchAll(/(?<![a-z0-9])(\d{1,5})(?![a-z0-9])/g)) {
    numbers.add(Number(match[1]));
  }
  // Daily numbers: "SO-261022-1" or "261022-1" is stored as 261022001.
  for (const match of q.matchAll(/(?<![a-z0-9])(\d{6})-(\d{1,3})(?![a-z0-9])/g)) {
    numbers.add(Number(match[1]) * 1000 + Number(match[2]));
  }
  const soMachineIds = new Set();
  for (const record of Array.isArray(workOrders) ? workOrders : []) {
    const number = Number(record.data?.number);
    if (Number.isInteger(number) && numbers.has(number) && typeof record.data?.machineId === 'string') {
      soMachineIds.add(record.data.machineId);
    }
  }
  const matched = [];
  for (const record of Array.isArray(machinesList) ? machinesList : []) {
    const data = record.data ?? {};
    const name = typeof data.name === 'string' ? data.name.trim().toLowerCase() : '';
    const serial = typeof data.serial === 'string' ? data.serial.trim().toLowerCase() : '';
    const modelKey = normalizeModel(data.model);
    if (name !== '' && q.includes(name)) {
      matched.push(record);
      continue;
    }
    if (serial !== '' && q.includes(serial)) {
      matched.push(record);
      continue;
    }
    if (modelKey.length >= 3 && squashed.includes(modelKey)) {
      matched.push(record);
      continue;
    }
    if (soMachineIds.has(record.id)) {
      matched.push(record);
    }
  }
  return matched;
}

/** The per-page manualslib watermark (and lines like it) never reach the AI. */
const MANUALSLIB_WATERMARK = 'downloaded from www.manualslib.com manuals search engine';

/**
 * Watermark-free page texts (SPEC-v4.md section 5): drop the manualslib
 * line, and any line that appears on more than half the pages of the file
 * (per-file boilerplate), before chunking.
 */
export function stripWatermarkLines(pages) {
  const list = (Array.isArray(pages) ? pages : []).map((page) => String(page ?? ''));
  if (list.length === 0) return [];
  const appearances = new Map();
  for (const page of list) {
    const seen = new Set();
    for (const line of page.split(/\r?\n/)) {
      const key = line.trim().toLowerCase();
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      appearances.set(key, (appearances.get(key) ?? 0) + 1);
    }
  }
  const threshold = list.length / 2;
  return list.map((page) =>
    page
      .split(/\r?\n/)
      .filter((line) => {
        const key = line.trim().toLowerCase();
        if (key === '') return true;
        if (key === MANUALSLIB_WATERMARK) return false;
        return (appearances.get(key) ?? 0) <= threshold;
      })
      .join('\n'),
  );
}

/** Split one page's text into ~target-char chunks on line boundaries. */
export function splitIntoChunks(text, target = LIBRARY_CHUNK_MAX_CHARS) {
  const lines = String(text ?? '').split(/\r?\n/);
  const chunks = [];
  let current = [];
  let chars = 0;
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
      chars = 0;
    }
  };
  for (const line of lines) {
    if (current.length > 0 && chars + line.length + 1 > target) flush();
    current.push(line);
    chars += line.length + 1;
  }
  flush();
  return chunks;
}

/**
 * Prepared manual chunks per fileId ({page, text}), split once and kept in
 * memory (at most MANUAL_CHUNK_CACHE_MAX_FILES, oldest dropped) so a
 * 274-page manual is not re-split on every question.
 */
const manualChunkCache = new Map();

function chunkManualPages(pages) {
  const chunks = [];
  stripWatermarkLines(pages).forEach((pageText, index) => {
    for (const text of splitIntoChunks(pageText)) {
      chunks.push({ page: index + 1, text });
    }
  });
  return chunks;
}

export function manualChunksFor(fileId, pages) {
  const key = String(fileId);
  const cached = manualChunkCache.get(key);
  if (cached !== undefined) return cached;
  const chunks = chunkManualPages(pages);
  manualChunkCache.delete(key);
  manualChunkCache.set(key, chunks);
  while (manualChunkCache.size > MANUAL_CHUNK_CACHE_MAX_FILES) {
    const oldest = manualChunkCache.keys().next().value;
    manualChunkCache.delete(oldest);
  }
  return chunks;
}

/** Library block headers (SPEC-v4.md section 5). */
export const LIBRARY_HEADERS = Object.freeze({
  block: 'Library (repair methods, manual excerpts and past fixes for this question; capped, not a complete list):',
  methods: 'Repair methods that match (best match first):',
  manuals: 'Manual excerpts (best matches first; cite them by their bracketed labels):',
  pastFixes: 'Past fixes (last 5 completed service orders for these machines):',
  empty: '- Nothing in the library matches this question.',
});

/** Matched-machine shape for relatedLibraryItems (logic.js): plain fields. */
function libraryMachine(record) {
  return { id: record.id, model: record.data.model, type: record.data.type };
}

/** Where a repair method's searchable text lives (title, models, tags, fields). */
function methodSearchText(item) {
  const steps = Array.isArray(item.steps)
    ? item.steps.map((step) => (step !== null && typeof step === 'object' && typeof step.text === 'string' ? step.text : '')).join(' ')
    : '';
  return [
    typeof item.title === 'string' ? item.title : '',
    Array.isArray(item.models) ? item.models.join(' ') : '',
    Array.isArray(item.tags) ? item.tags.join(' ') : '',
    typeof item.symptom === 'string' ? item.symptom : '',
    typeof item.cause === 'string' ? item.cause : '',
    steps,
    typeof item.toolsParts === 'string' ? item.toolsParts : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** A repair method as compact lines (SPEC-v4.md section 5, a). */
function methodLines(item) {
  const models = Array.isArray(item.models) && item.models.length > 0 ? item.models.join(', ') : '';
  const steps = Array.isArray(item.steps)
    ? item.steps
        .map((step, index) => `${index + 1}. ${step !== null && typeof step === 'object' && typeof step.text === 'string' ? step.text : ''}`)
        .join(' ')
    : '';
  return [
    `- [Repair method: ${typeof item.title === 'string' ? item.title : item.id}]`,
    ...(models === '' ? [] : [`  models: ${models}`]),
    ...(typeof item.symptom === 'string' && item.symptom.trim() !== '' ? [`  symptom: ${clip(item.symptom, 500)}`] : []),
    ...(typeof item.cause === 'string' && item.cause.trim() !== '' ? [`  cause: ${clip(item.cause, 800)}`] : []),
    ...(steps.trim() !== '' ? [`  steps: ${clip(steps, 1200)}`] : []),
    ...(typeof item.toolsParts === 'string' && item.toolsParts.trim() !== '' ? [`  tools & parts: ${clip(item.toolsParts, 400)}`] : []),
    ...(typeof item.safety === 'string' && item.safety.trim() !== '' ? [`  safety: ${clip(item.safety, 400)}`] : []),
  ];
}

/** PDF attachments of one record's data (machines and library items). */
function pdfAttachments(data) {
  return Array.isArray(data.attachments)
    ? data.attachments.filter((att) => att !== null && typeof att === 'object' && att.mime === 'application/pdf' && typeof att.fileId === 'string' && att.fileId !== '')
    : [];
}

/** One completed service order as a past-fix line (SPEC-v4.md section 5, c). */
function pastFixLine(record, machineNames, partsById) {
  const data = record.data;
  const number = formatOrderNumber(data.number);
  const machine = machineNames.get(data.machineId) ?? 'a machine';
  const date = typeof data.completedAt === 'string' && data.completedAt !== '' ? data.completedAt : record.updatedAt;
  const partsUsed = (Array.isArray(data.partsUsed) ? data.partsUsed : [])
    .map((used) => {
      const name = partsById.get(used.partId)?.name ?? used.partId;
      return `${name} (${used.qty})`;
    })
    .join(', ');
  return `- [Past fix: ${number} · ${machine}${date ? ` · ${date}` : ''}] problem: ${clip(data.problem, 300) ?? 'not recorded'}; action: ${clip(data.actionTaken, 300) ?? 'not recorded'}; parts: ${partsUsed === '' ? 'none recorded' : partsUsed}`;
}

/**
 * The Library block (SPEC-v4.md section 5), as lines clipped to
 * LIBRARY_CONTEXT_MAX_CHARS: repair methods first (best match first), then
 * manual excerpts with `[Manual: <title or file name>, p. <n>]` labels
 * (library notes count as one `[Notes: <title>]` chunk), then the last 5
 * completed service orders of the matched machines and same-model machines.
 * Callers only invoke this with library Read; the machine list must already
 * be filtered to readable machines.
 *
 * @param {object} store open store handle
 * @param {string} question the user's message
 * @param {{machinesList?: array, workOrders?: array, partsList?: array}} data readable records for the machine/SO/part lookups
 */
export function buildLibrarySection(store, question, { machinesList = [], workOrders = [], partsList = [] } = {}) {
  const libraryItems = store.listRecords('libraryItems').map((record) => ({ ...record.data, id: record.id }));
  const machineNames = new Map(machinesList.map((record) => [record.id, record.data.name ?? record.id]));
  const partsById = new Map(partsList.map((record) => [record.id, record.data]));
  const questionTokens = tokenSet(question);
  const specialTokens = specialQuestionTokens(question);
  const matched = detectQuestionMachines(question, machinesList, workOrders);
  const hasMatch = matched.length > 0;

  // (a) Repair methods: every method of the matched machines, best match
  // first; without a machine match, every scored method in score order.
  const methods = [];
  const seenMethods = new Set();
  if (hasMatch) {
    for (const record of matched) {
      for (const item of relatedLibraryItems(libraryMachine(record), libraryItems)) {
        if (item.kind === 'method' && !seenMethods.has(item.id)) {
          seenMethods.add(item.id);
          methods.push(item);
        }
      }
    }
  } else {
    for (const item of libraryItems) {
      if (item.kind === 'method') methods.push(item);
    }
  }
  const rankedMethods = methods
    .map((item, index) => ({ item, index, score: overlapScore(methodSearchText(item), questionTokens, specialTokens) }))
    .filter((entry) => entry.score > 0 || hasMatch)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // (b) Manual text: PDFs of the matched machines themselves plus the
  // manuals of the matching library items (all manual items without a
  // machine match). Notes are one chunk each.
  const manuals = [];
  const noteChunks = [];
  const collectItemManual = (item) => {
    for (const att of pdfAttachments(item)) {
      manuals.push({ fileId: att.fileId, label: typeof item.title === 'string' ? item.title : att.name });
    }
    if (typeof item.notes === 'string' && item.notes.trim() !== '') {
      noteChunks.push({ label: item.title, text: item.notes.trim().slice(0, LIBRARY_CHUNK_MAX_CHARS) });
    }
  };
  const seenManualItems = new Set();
  if (hasMatch) {
    for (const record of matched) {
      for (const att of pdfAttachments(record.data)) manuals.push({ fileId: att.fileId, label: att.name });
      for (const item of relatedLibraryItems(libraryMachine(record), libraryItems)) {
        if (item.kind !== 'manual' || seenManualItems.has(item.id)) continue;
        seenManualItems.add(item.id);
        collectItemManual(item);
      }
    }
  } else {
    for (const item of libraryItems) {
      if (item.kind === 'manual' && !seenManualItems.has(item.id)) {
        seenManualItems.add(item.id);
        collectItemManual(item);
      }
    }
  }
  const chunks = noteChunks.map((note) => ({ label: `[Notes: ${note.label}]`, page: 0, text: note.text }));
  for (const manual of manuals) {
    const pages = store.getFileTextPages(manual.fileId);
    if (pages === null) continue;
    for (const chunk of manualChunksFor(manual.fileId, pages)) {
      chunks.push({ label: `[Manual: ${manual.label}, p. ${chunk.page}]`, page: chunk.page, text: chunk.text });
    }
  }
  const rankedChunks = chunks
    .map((chunk) => ({ ...chunk, score: overlapScore(chunk.text, questionTokens, specialTokens) }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.page - b.page || a.label.localeCompare(b.label));

  // (c) The last 5 completed service orders of the matched machines and
  // same-model machines.
  let pastFixes = [];
  if (hasMatch) {
    const modelKeys = new Set(matched.map((record) => normalizeModel(record.data.model)).filter((key) => key !== ''));
    const group = matched.slice();
    for (const record of machinesList) {
      if (group.includes(record)) continue;
      if (modelKeys.size > 0 && modelKeys.has(normalizeModel(record.data.model))) group.push(record);
    }
    const groupIds = new Set(group.map((record) => record.id));
    pastFixes = workOrders
      .filter((record) => record.data.status === 'done' && groupIds.has(record.data.machineId))
      .sort(
        (a, b) =>
          String(b.data.completedAt ?? '').localeCompare(String(a.data.completedAt ?? '')) ||
          String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
      )
      .slice(0, 5)
      .map((record) => pastFixLine(record, machineNames, partsById));
  }

  // Assemble within LIBRARY_CONTEXT_MAX_CHARS: methods, then chunks while
  // the budget lasts, then past fixes. Headers are budgeted with their
  // entries and refunded when nothing under them fits.
  const lines = [LIBRARY_HEADERS.block];
  let used = LIBRARY_HEADERS.block.length + 1;
  const addBlock = (block) => {
    const cost = block.reduce((sum, line) => sum + line.length + 1, 0);
    if (used + cost > LIBRARY_CONTEXT_MAX_CHARS) return false;
    lines.push(...block);
    used += cost;
    return true;
  };
  let content = 0;
  if (rankedMethods.length > 0) {
    const block = [LIBRARY_HEADERS.methods, ...rankedMethods.map((entry) => methodLines(entry.item)).flat()];
    if (addBlock(block)) content += 1;
  }
  if (rankedChunks.length > 0) {
    const headerCost = LIBRARY_HEADERS.manuals.length + 1;
    if (used + headerCost <= LIBRARY_CONTEXT_MAX_CHARS) {
      const block = [LIBRARY_HEADERS.manuals];
      used += headerCost;
      for (const chunk of rankedChunks) {
        const entry = [chunk.label, ...chunk.text.split(/\r?\n/)];
        const cost = entry.reduce((sum, line) => sum + line.length + 1, 0);
        if (used + cost > LIBRARY_CONTEXT_MAX_CHARS) break;
        block.push(...entry);
        used += cost;
      }
      if (block.length > 1) {
        lines.push(...block);
        content += 1;
      } else {
        used -= headerCost;
      }
    }
  }
  if (pastFixes.length > 0) {
    const headerCost = LIBRARY_HEADERS.pastFixes.length + 1;
    if (used + headerCost <= LIBRARY_CONTEXT_MAX_CHARS) {
      const block = [LIBRARY_HEADERS.pastFixes];
      used += headerCost;
      for (const line of pastFixes) {
        if (used + line.length + 1 > LIBRARY_CONTEXT_MAX_CHARS) break;
        block.push(line);
        used += line.length + 1;
      }
      if (block.length > 1) {
        lines.push(...block);
        content += 1;
      } else {
        used -= headerCost;
      }
    }
  }
  if (content === 0) lines.push(LIBRARY_HEADERS.empty);
  return lines;
}

/** Counts records by a label, most common first: [[label, count], ...]. */
function countEntries(records, labelFor) {
  const counts = new Map();
  for (const record of records) {
    const label = labelFor(record);
    if (label === null || label === undefined || label === '') continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])),
  );
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
 * Never reads users, sessions or raw files (manual PDF text comes from the
 * pre-extracted `file_texts` table). Capped at CONTEXT_MAX_CHARS.
 *
 * V4-M5 (SPEC-v4.md section 5): users with library Read also get a Library
 * block (repair methods, manual excerpts with page labels, past fixes),
 * second after the shop totals, within LIBRARY_CONTEXT_MAX_CHARS.
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
    const seenMatches = new Set();
    for (const record of searchable) {
      if (matches.length >= 20) break;
      const entryKey = `${record.store}:${record.entry.id}`;
      if (seenMatches.has(entryKey)) continue;
      const haystack = JSON.stringify(record.entry).toLowerCase();
      if (keywords.some((word) => haystack.includes(word))) {
        seenMatches.add(entryKey);
        matches.push({ store: record.store, ...record.entry });
      }
    }
    addSection('Records matching words of the question', matches, 20);
  }

  // Totals are stated explicitly, in front of the extract: the extract is
  // capped, and a capped list is what makes a model answer "20 machines" when
  // 114 exist. These lines are the authoritative counts for "how many".
  const totals = [];
  if (readMachines) {
    const countStatus = (status) =>
      machinesList.filter((record) => (record.data.status ?? 'running') === status).length;
    const typeCounts = new Map();
    for (const record of machinesList) {
      const label = record.data.typeLabel || record.data.type || 'unknown';
      typeCounts.set(label, (typeCounts.get(label) ?? 0) + 1);
    }
    const byType = [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, count]) => `${label} ${count}`)
      .join(', ');
    totals.push(
      `Machines: ${machinesList.length} total (${countStatus('running')} running, ${countStatus('down')} down, ${countStatus('in-storage')} in storage, ${countStatus('retired')} retired)${byType ? `; by type: ${byType}` : ''}.`,
    );
  } else {
    totals.push('Machines: not visible to this user.');
  }
  if (read('pmTasks')) {
    // Tasks on in-storage or retired machines are paused (SPEC-v2.md 15.3),
    // so they are left out of the active counts and of the breakdowns.
    const pmInService = pmTasks.filter((record) => {
      if (record.data.active === false) return false;
      const machine = machines.get(record.data.machineId ?? '') ?? null;
      const status = machine === null ? null : machine.data.status;
      return status !== 'in-storage' && status !== 'retired';
    });
    totals.push(
      `PM tasks: ${pmTasks.length} total, ${pmInService.length} active, ${pmDue.length} due within 7 days (including overdue).`,
    );
    const summarise = (entries, limit = 5) => {
      const shown = entries
        .slice(0, limit)
        .map(([label, count]) => `${label} ${count}`)
        .join(', ');
      return entries.length > limit ? `${shown} (+${entries.length - limit} more)` : shown;
    };
    const titles = countEntries(pmInService, (record) => record.data.title);
    if (titles.length > 0) totals.push(`PM task titles (most common first): ${summarise(titles)}.`);
    const priorities = countEntries(pmInService, (record) => record.data.priority ?? 'medium');
    if (priorities.length > 0) totals.push(`PM task priorities: ${summarise(priorities)}.`);
    const categories = countEntries(pmInService, (record) => record.data.category);
    if (categories.length > 0) totals.push(`PM task categories: ${summarise(categories)}.`);
  } else {
    totals.push('PM tasks: not visible to this user.');
  }
  if (read('workOrders')) {
    totals.push(
      `Service orders: ${workOrders.length} total, ${openOrders.length} open, ${overdue.length} overdue.`,
    );
  } else {
    totals.push('Service orders: not visible to this user.');
  }
  if (read('parts')) totals.push(`Parts: ${parts.length} total, ${lowStock.length} low stock.`);
  if (read('coworkers')) totals.push(`Coworkers: ${coworkers.length}.`);
  if (read('contractors')) totals.push(`Contractors: ${contractors.length}.`);
  // V4-M5 (SPEC-v4.md section 5): the Library block comes right after the
  // shop totals; users without library Read get no block at all.
  const libraryLines = read('libraryItems')
    ? buildLibrarySection(store, question, { machinesList, workOrders, partsList: parts })
    : [];
  if (libraryLines.length > 0) lines.unshift(...libraryLines);
  lines.unshift(
    'Shop totals (authoritative counts - never count the extract below to answer "how many"):',
    ...totals.map((line) => `- ${line}`),
    'The extract below is capped (up to 30 rows per section, 20 keyword matches), so it is not a complete list.',
  );

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
// Assistant edits: the model may propose changes to machines, service orders
// and PM tasks. Nothing is written until the signed-in user presses Apply in
// the chat; the write itself is made by the dedicated "AI Assistant" user, so
// created_by/updated_by and the history row name the assistant.
// ---------------------------------------------------------------------------

export const AI_ASSISTANT_USERNAME = 'ai-assistant';
export const AI_ASSISTANT_DISPLAY_NAME = 'AI Assistant';
export const AI_ASSISTANT_ROLE_NAME = 'AI Assistant';
export const AI_EDITABLE_STORES = Object.freeze(['machines', 'workOrders', 'pmTasks', 'libraryItems']);
export const AI_MAX_PROPOSALS = 3;

/** Fields the model may never set through a proposal. */
const ASSISTANT_PROTECTED_FIELDS = new Set(['id', 'version', 'number', 'createdBy', 'updatedBy']);

/** What the AI Assistant role may do (v4: read requests, write the library). */
function assistantPermissions() {
  return normalizePermissions({
    serviceOrders: 'write',
    pm: 'write',
    machines: 'write',
    parts: 'read',
    coworkers: 'read',
    contractors: 'read',
    statistics: 'read',
    files: 'read',
    aiAssistant: 'write',
    purchasing: 'read',
    library: 'write',
  });
}

/**
 * The AI Assistant user, created on first use (idempotent): its own role with
 * Write on exactly the three editable areas, and disabled so nobody can sign
 * in as it. Returns the user row. When the role already exists (the live DB
 * does), keys it is missing are added and existing keys are never lowered
 * (SPEC-v4.md section 1).
 */
export function ensureAiAssistantUser(store) {
  const existing = store.getUserByUsername(AI_ASSISTANT_USERNAME);
  if (existing !== null) {
    addMissingRolePermissions(store, existing.role_id ?? existing.roleId ?? null, assistantPermissions());
    return asSessionUser(existing);
  }
  let role = store.getRoleByName(AI_ASSISTANT_ROLE_NAME);
  if (role === null) {
    role = store.createRole({
      name: AI_ASSISTANT_ROLE_NAME,
      permissions: assistantPermissions(),
    });
  } else {
    role = addMissingRolePermissions(store, role.id, assistantPermissions()) ?? role;
  }
  const created = store.createUser({
    username: AI_ASSISTANT_USERNAME,
    displayName: AI_ASSISTANT_DISPLAY_NAME,
    roleId: role.id,
    passwordHash: hashPassword(crypto.randomBytes(32).toString('hex')),
  });
  store.updateUser(created.id, { disabled: 1 });
  // The store returns a raw users row; can() expects the session shape.
  return asSessionUser(store.getUserById(created.id));
}

/** Raw users row (snake_case) -> the {id, roleId} shape can() reads. */
function asSessionUser(row) {
  return { ...row, roleId: row.role_id ?? row.roleId ?? null };
}

/** Keep one proposed change only if it targets an editable store and plain fields. */
function sanitizeProposal(raw) {
  if (!isPlainObject(raw)) return null;
  const storeName = typeof raw.store === 'string' ? raw.store : '';
  if (!AI_EDITABLE_STORES.includes(storeName)) return null;
  if (!isPlainObject(raw.fields)) return null;
  // SPEC-v4.md section 5: repair-method proposals create methods only.
  if (storeName === 'libraryItems' && raw.fields.kind !== 'method') return null;
  const fields = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw.fields)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) continue;
    if (ASSISTANT_PROTECTED_FIELDS.has(key)) continue;
    fields[key] = value;
    count += 1;
    if (count >= 40) break;
  }
  if (count === 0) return null;
  const id = typeof raw.id === 'string' && raw.id !== '' && raw.id.length <= 80 ? raw.id : null;
  const summary = typeof raw.summary === 'string' ? raw.summary.slice(0, 200) : '';
  return { store: storeName, id, summary, fields };
}

/**
 * Proposals in a reply: fenced JSON blocks shaped
 * `{"proposals": [{store, id, summary, fields}]}`, at most AI_MAX_PROPOSALS.
 * Invalid blocks are ignored, so a broken proposal never breaks the answer.
 */
export function parseProposals(reply) {
  if (typeof reply !== 'string') return [];
  const fence = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/g;
  const proposals = [];
  let match = fence.exec(reply);
  while (match !== null) {
    let parsed = null;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      parsed = null;
    }
    const list = isPlainObject(parsed) && Array.isArray(parsed.proposals) ? parsed.proposals : [];
    for (const raw of list) {
      const proposal = sanitizeProposal(raw);
      if (proposal !== null) proposals.push(proposal);
      if (proposals.length >= AI_MAX_PROPOSALS) return proposals;
    }
    match = fence.exec(reply);
  }
  return proposals;
}

/**
 * POST /api/ai/apply: apply one proposal the user approved in the chat.
 * The requester needs Write on the target area, and so does the AI Assistant
 * role. Updates merge the proposed fields onto the current record, so the
 * model never has to send a whole record back. libraryItems proposals are
 * create-only repair methods (SPEC-v4.md section 5): an id that already
 * exists is refused before anything is written.
 */
export async function aiApplyProposal(ctx, req, body) {
  const { store, user } = ctx;
  if (!isPlainObject(body)) throw badRequest('Expected a JSON object body');
  for (const key of Object.keys(body)) {
    if (!['store', 'id', 'fields', 'summary'].includes(key)) {
      throw badRequest(`Unknown field "${key}"; expected store, id, fields, summary`);
    }
  }
  const storeName = body.store;
  if (!AI_EDITABLE_STORES.includes(storeName)) {
    throw badRequest(`The assistant can only change ${AI_EDITABLE_STORES.join(', ')}`);
  }
  const area = storeArea(storeName) ?? storeName;
  if (!can(user, area, 'write')) {
    throw bad(403, 'forbidden', `You need write access to ${area} to approve this change`);
  }
  // SPEC-v4.md section 5: libraryItems proposals are create-only and must
  // be repair methods; an id that already exists is refused (no updates to
  // existing library items through the chat).
  if (storeName === 'libraryItems') {
    if (!isPlainObject(body.fields) || body.fields.kind !== 'method') {
      throw badRequest('The assistant can only propose new repair methods (kind must be "method")');
    }
    const proposedId = typeof body.id === 'string' && body.id !== '' ? body.id : null;
    if (proposedId !== null && store.getRecord('libraryItems', proposedId) !== null) {
      throw badRequest('The assistant can only create new repair methods; existing library items cannot be changed from the chat');
    }
  }
  const proposal = sanitizeProposal(body);
  if (proposal === null) throw badRequest('The proposed fields are empty or not allowed');
  const assistant = ensureAiAssistantUser(store);
  const actor = { ...assistant, store };
  if (!can(actor, area, 'write')) {
    throw bad(403, 'forbidden', 'The AI Assistant role may not write there; an admin can change its role');
  }
  const id = proposal.id ?? crypto.randomUUID();
  const current = store.getRecord(storeName, id);
  const data = current === null ? proposal.fields : { ...JSON.parse(current.data), ...proposal.fields };
  const approver = store.displayName(user.id) ?? user.username;
  const applied = putRecord(store, {
    storeName,
    id,
    body: {
      data,
      baseVersion: current === null ? null : Number(current.version),
      clientId: AI_ASSISTANT_USERNAME,
      clientTime: new Date().toISOString(),
    },
    user: actor,
    note: `from AI chat, approved by ${approver}`,
  });
  return {
    status: 200,
    body: {
      record: applied.record,
      appliedBy: { id: assistant.id, displayName: assistant.display_name ?? assistant.displayName },
    },
  };
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
  return { status: 200, body: { conversationId, reply, draftServiceOrder, proposals: parseProposals(reply) } };
}