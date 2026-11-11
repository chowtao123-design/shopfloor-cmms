// AI assistant tools (v6). The OpenAI-compatible provider calls these itself
// (native function calling), as many times as a question needs, instead of
// getting one fixed snapshot: search and analyse shop records, read PDFs
// (library manuals, attachments, files attached in the chat) and, unless
// AI_WEB=off, search the web and read public pages.
//
// Every tool runs as the signed-in user: only areas their role can Read,
// never the floor roster (AI_EXCLUDED_STORES), contractor rates only with
// contractorRates Read, and no request ever reaches the shop's own network.

import dns from 'node:dns/promises';
import net from 'node:net';

import { can, storeArea } from './permissions.js';
import { STORES, sanitizeRecordForRole } from './records.js';
import { extractPdfText } from './pdfText.js';
import { SKILL_KEYS, skillLevelKey, workerRoster } from '../logic-map.js';
import fs from 'node:fs';
import path from 'node:path';

export const TOOL_RESULT_MAX_CHARS = 14000;
export const QUERY_LIMIT_DEFAULT = 60;
export const QUERY_LIMIT_MAX = 400;
export const READ_PAGES_MAX = 8;
const WEB_TIMEOUT_MS = 15000;
const WEB_MAX_BYTES = 8 * 1024 * 1024;
const WEB_MAX_REDIRECTS = 4;
const USER_AGENT = 'Mozilla/5.0 (compatible; ShopfloorCMMS-assistant/1.0)';

/** Stores the assistant never reads (the floor roster), kept in sync with ai.js. */
export const TOOL_EXCLUDED_STORES = new Set(['floorMaps', 'floorStations', 'workerProfiles']);

export const webEnabled = (env = process.env) => String(env.AI_WEB ?? 'on').toLowerCase() !== 'off';

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI "tools" format)
// ---------------------------------------------------------------------------

const storeParam = (stores) => ({
  type: 'string',
  enum: stores,
  description: 'Record store: workOrders = service orders, pmTasks = preventive maintenance, purchaseRequests = parts requests, libraryItems = repair methods and manuals.',
});

const whereParam = {
  type: 'object',
  description:
    'Filters on data fields. A plain value means equals (an array field matches when it contains the value). Or use an object: {"gte": x, "lte": y} for numbers/ISO dates, {"in": [..]}, {"ne": x}, {"contains": "text"}. Example: {"status": {"ne": "done"}, "createdAt": {"gte": "2026-09-01"}}. createdAt/updatedAt are the record timestamps.',
  additionalProperties: true,
};

/** The tool list for one user: only stores they can read, web tools when enabled. */
export function toolDefinitions(stores, { web = webEnabled(), workers = false } = {}) {
  const tools = [
    {
      name: 'query_records',
      description:
        'Search and filter shop records and get matching rows (newest first by default). Use it for lists, lookups and as raw data for any analysis. total is the full match count even when rows are capped; ask for fields to keep rows small.',
      parameters: {
        type: 'object',
        properties: {
          store: storeParam(stores),
          search: { type: 'string', description: 'Case-insensitive text found anywhere in the record.' },
          where: whereParam,
          fields: { type: 'array', items: { type: 'string' }, description: 'Only these data fields (id, createdAt, updatedAt always included).' },
          sort: { type: 'string', description: 'Field to sort by; prefix with - for descending. Default -updatedAt.' },
          limit: { type: 'integer', minimum: 1, maximum: QUERY_LIMIT_MAX },
        },
        required: ['store'],
      },
    },
    {
      name: 'aggregate_records',
      description:
        'Count records (and optionally sum/average a number field) grouped by a field or by date period. Use for "how many", trends, top machines, breakdowns per month, labour hours, spend, MTBF-style analysis.',
      parameters: {
        type: 'object',
        properties: {
          store: storeParam(stores),
          groupBy: { type: 'string', description: 'Field to group by (machineId is shown with the machine name). Omit for a single total.' },
          period: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Group by this period of dateField instead of (or with) groupBy.' },
          dateField: { type: 'string', description: 'Date field for period and from/to. Default createdAt.' },
          from: { type: 'string', description: 'ISO date, inclusive.' },
          to: { type: 'string', description: 'ISO date, inclusive.' },
          valueField: { type: 'string', description: 'Number field to sum and average, e.g. downtimeHours, cost. "labourHours" sums the labour entries of service orders.' },
          where: whereParam,
          search: { type: 'string' },
        },
        required: ['store'],
      },
    },
    {
      name: 'get_record',
      description: 'One record with every field, optionally with its change history (who changed what, when).',
      parameters: {
        type: 'object',
        properties: { store: storeParam(stores), id: { type: 'string' }, history: { type: 'boolean' } },
        required: ['store', 'id'],
      },
    },
    {
      name: 'list_files',
      description: 'PDF files the assistant can read: library manuals, PDFs attached to records, and files attached to this chat. Returns fileId, name, where it is attached and page count.',
      parameters: { type: 'object', properties: { search: { type: 'string', description: 'Filter by name, model or record.' } } },
    },
    {
      name: 'read_file',
      description: `Read a PDF by fileId: either pages fromPage..toPage (at most ${READ_PAGES_MAX} per call) or search it for a phrase (best matching pages). Call it again for more pages.`,
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string' },
          fromPage: { type: 'integer', minimum: 1 },
          toPage: { type: 'integer', minimum: 1 },
          search: { type: 'string', description: 'Words to find; returns the best matching pages.' },
        },
        required: ['fileId'],
      },
    },
  ];
  if (workers) {
    tools.push({
      name: 'list_worker_skills',
      description:
        'Floor workers with their station, zone, skills per machine type (expert/good/learning), efficiency %, daily output, quality and notes. Use before proposing skill updates. Filter by search (ID, name, station), zone, or skill + minimum level.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          zone: { type: 'string' },
          skill: { type: 'string', enum: SKILL_KEYS },
          level: { type: 'string', enum: ['expert', 'good', 'learning'], description: 'With skill: this level or better.' },
          limit: { type: 'integer', minimum: 1, maximum: 400 },
        },
      },
    });
  }
  if (web) {
    tools.push(
      {
        name: 'web_search',
        description: 'Search the public web (DuckDuckGo). Returns titles, URLs and snippets. Never put staff names or private shop data in the query.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
      {
        name: 'fetch_url',
        description: 'Read a public web page or online PDF (http/https) as text. Use after web_search to read a promising result, e.g. a manufacturer manual. Long PDFs: pass page numbers.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            fromPage: { type: 'integer', minimum: 1 },
            toPage: { type: 'integer', minimum: 1 },
            search: { type: 'string', description: 'For a PDF: return the pages that best match these words.' },
          },
          required: ['url'],
        },
      }
    );
  }
  return tools.map((fn) => ({ type: 'function', function: fn }));
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** Record stores this user may read through the tools. */
export function readableStores(store, user) {
  const who = { ...user, store };
  return STORES.filter((name) => !TOOL_EXCLUDED_STORES.has(name) && storeArea(name) && can(who, storeArea(name), 'read'));
}

function clip(text, max = TOOL_RESULT_MAX_CHARS) {
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return s.length > max ? `${s.slice(0, max)}\n…[cut at ${max} characters: narrow the query, ask for fewer fields or fewer pages]` : s;
}

/** A record as the tools show it: data plus id/timestamps, long values shortened, machine named. */
function rowOf(record, machineNames, fields) {
  const data = record.data || {};
  const row = { id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt };
  const keys = Array.isArray(fields) && fields.length ? fields : Object.keys(data);
  for (const key of keys) {
    if (key === 'id' || key === 'createdAt' || key === 'updatedAt') continue;
    let value = data[key];
    if (value === undefined) continue;
    if (typeof value === 'string' && value.length > 400) value = `${value.slice(0, 400)}…`;
    if (Array.isArray(value) && value.length > 25) value = [...value.slice(0, 25), `…${value.length - 25} more`];
    row[key] = value;
  }
  if (typeof data.machineId === 'string' && machineNames.has(data.machineId)) row.machineName = machineNames.get(data.machineId);
  if (Array.isArray(data.machineIds)) row.machineNames = data.machineIds.map((id) => machineNames.get(id)).filter(Boolean);
  return row;
}

function fieldValue(record, field) {
  if (field === 'createdAt' || field === 'updatedAt' || field === 'id') return record[field];
  return record.data ? record.data[field] : undefined;
}

function matches(value, cond) {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    if ('gte' in cond && !(value !== undefined && value !== null && compareLoose(value, cond.gte) >= 0)) return false;
    if ('lte' in cond && !(value !== undefined && value !== null && compareLoose(value, cond.lte) <= 0)) return false;
    if ('in' in cond && !(Array.isArray(cond.in) && cond.in.some((v) => equalsLoose(value, v)))) return false;
    if ('ne' in cond && equalsLoose(value, cond.ne)) return false;
    if ('contains' in cond && !String(Array.isArray(value) ? value.join(' ') : value ?? '').toLowerCase().includes(String(cond.contains).toLowerCase())) return false;
    return true;
  }
  return equalsLoose(value, cond);
}

function compareLoose(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (typeof a === 'number' || (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && !/^\d{4}-/.test(String(a)))) return na - nb;
  return String(a).localeCompare(String(b));
}

function equalsLoose(value, wanted) {
  if (Array.isArray(value)) return value.some((v) => equalsLoose(v, wanted));
  if (value === wanted) return true;
  if (value === null || value === undefined || wanted === null || wanted === undefined) return false;
  return String(value).toLowerCase() === String(wanted).toLowerCase();
}

function filteredRecords(ctx, args) {
  const name = args.store;
  if (!ctx.stores.includes(name)) throw toolError(`Store "${name}" is not available to this user. Readable stores: ${ctx.stores.join(', ')}.`);
  const who = { ...ctx.user, store: ctx.store };
  const showRates = can(who, 'contractorRates', 'read');
  let records = ctx.store.listRecords(name).map((record) => sanitizeRecordForRole(record, showRates));
  const where = args.where && typeof args.where === 'object' ? args.where : {};
  for (const [field, cond] of Object.entries(where)) records = records.filter((record) => matches(fieldValue(record, field), cond));
  if (typeof args.search === 'string' && args.search.trim()) {
    const words = args.search.toLowerCase().split(/\s+/).filter(Boolean);
    records = records.filter((record) => {
      const hay = `${JSON.stringify(record.data)} ${ctx.machineNames.get(record.data?.machineId) || ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  return records;
}

class ToolError extends Error {}
const toolError = (message) => new ToolError(message);

// ---------------------------------------------------------------------------
// Record tools
// ---------------------------------------------------------------------------

function queryRecords(ctx, args) {
  const records = filteredRecords(ctx, args);
  const sort = typeof args.sort === 'string' && args.sort ? args.sort : '-updatedAt';
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  records.sort((a, b) => {
    const va = fieldValue(a, key);
    const vb = fieldValue(b, key);
    if (va === vb) return 0;
    if (va === undefined || va === null || va === '') return 1;
    if (vb === undefined || vb === null || vb === '') return -1;
    return (desc ? -1 : 1) * compareLoose(va, vb);
  });
  const limit = Math.min(QUERY_LIMIT_MAX, Math.max(1, Number(args.limit) || QUERY_LIMIT_DEFAULT));
  const rows = records.slice(0, limit).map((record) => rowOf(record, ctx.machineNames, args.fields));
  return { store: args.store, total: records.length, returned: rows.length, rows };
}

const PERIODS = {
  day: (iso) => iso.slice(0, 10),
  month: (iso) => iso.slice(0, 7),
  year: (iso) => iso.slice(0, 4),
  week: (iso) => {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
    return `week of ${d.toISOString().slice(0, 10)}`;
  },
};

function numberOf(record, valueField) {
  if (valueField === 'labourHours') {
    const labour = record.data?.labour;
    return Array.isArray(labour) ? labour.reduce((sum, entry) => sum + (Number(entry?.hours) || 0), 0) : 0;
  }
  const n = Number(fieldValue(record, valueField));
  return Number.isFinite(n) ? n : null;
}

function aggregateRecords(ctx, args) {
  let records = filteredRecords(ctx, args);
  const dateField = args.dateField || 'createdAt';
  if (args.from) records = records.filter((r) => String(fieldValue(r, dateField) ?? '') >= String(args.from));
  if (args.to) records = records.filter((r) => String(fieldValue(r, dateField) ?? '').slice(0, 10) <= String(args.to).slice(0, 10));
  const groups = new Map();
  for (const record of records) {
    const parts = [];
    if (args.period && PERIODS[args.period]) {
      const date = fieldValue(record, dateField);
      parts.push(typeof date === 'string' && date ? PERIODS[args.period](date) : '(no date)');
    }
    if (args.groupBy) {
      let value = fieldValue(record, args.groupBy);
      if (args.groupBy === 'machineId') value = ctx.machineNames.get(value) || value || '(no machine)';
      if (Array.isArray(value)) value = value.length ? value.join(', ') : '(none)';
      parts.push(value === undefined || value === null || value === '' ? '(blank)' : String(value));
    }
    const key = parts.join(' | ') || 'all';
    let group = groups.get(key);
    if (!group) {
      group = { group: key, count: 0, sum: 0, withValue: 0 };
      groups.set(key, group);
    }
    group.count += 1;
    if (args.valueField) {
      const n = numberOf(record, args.valueField);
      if (n !== null) {
        group.sum += n;
        group.withValue += 1;
      }
    }
  }
  const out = [...groups.values()]
    .map((g) => (args.valueField ? { group: g.group, count: g.count, sum: round(g.sum), average: g.withValue ? round(g.sum / g.withValue) : null } : { group: g.group, count: g.count }))
    .sort((a, b) => (args.period ? a.group.localeCompare(b.group) : b.count - a.count));
  return { store: args.store, matched: records.length, groups: out.slice(0, 300) };
}

const round = (n) => Math.round(n * 100) / 100;

function getRecord(ctx, args) {
  if (!ctx.stores.includes(args.store)) throw toolError(`Store "${args.store}" is not available to this user.`);
  const row = ctx.store.getRecord(args.store, String(args.id || ''));
  if (!row || Number(row.deleted) === 1) throw toolError('No such record (or it was deleted).');
  const who = { ...ctx.user, store: ctx.store };
  const record = sanitizeRecordForRole(
    { store: args.store, id: row.id, data: JSON.parse(row.data), createdAt: row.created_at, updatedAt: row.updated_at, version: Number(row.version) },
    can(who, 'contractorRates', 'read')
  );
  const out = { ...rowOf(record, ctx.machineNames), version: record.version };
  if (args.history) {
    out.history = ctx.store.historyList(args.store, record.id).slice(0, 30).map((h) => ({
      at: h.at,
      by: h.displayName || h.display_name || null,
      action: h.action,
      changed: changedKeys(h.before, h.after),
    }));
  }
  return out;
}

function changedKeys(before, after) {
  const b = typeof before === 'string' ? safeJson(before) : before || {};
  const a = typeof after === 'string' ? safeJson(after) : after || {};
  const keys = new Set([...Object.keys(b || {}), ...Object.keys(a || {})]);
  const out = {};
  for (const key of keys) {
    if (JSON.stringify(b?.[key]) !== JSON.stringify(a?.[key])) out[key] = { from: b?.[key], to: a?.[key] };
  }
  return out;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

/** PDFs this user may read: on records of readable stores, plus their own chat uploads. */
export function readableFiles(ctx) {
  const files = new Map();
  for (const name of ctx.stores) {
    for (const record of ctx.store.listRecords(name)) {
      const atts = Array.isArray(record.data?.attachments) ? record.data.attachments : [];
      for (const att of atts) {
        if (!att || att.mime !== 'application/pdf' || typeof att.fileId !== 'string') continue;
        const label = record.data.title || record.data.name || record.data.number || name;
        const entry = files.get(att.fileId) || { fileId: att.fileId, name: att.name, attachedTo: [] };
        entry.attachedTo.push(`${name}: ${label}`);
        files.set(att.fileId, entry);
      }
    }
  }
  for (const fileId of ctx.chatFileIds || []) {
    const row = ctx.store.getFileById(fileId);
    if (row && row.mime === 'application/pdf' && !files.has(fileId)) files.set(fileId, { fileId, name: row.name, attachedTo: ['this chat'] });
  }
  for (const entry of files.values()) {
    const text = ctx.store.getFileText(entry.fileId);
    entry.status = text ? text.status : 'not read yet';
    entry.pages = text && text.pages_json ? safeJsonArray(text.pages_json).length : null;
  }
  return [...files.values()];
}

function safeJsonArray(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function listFiles(ctx, args) {
  let files = readableFiles(ctx);
  if (args.search) {
    const words = String(args.search).toLowerCase().split(/\s+/).filter(Boolean);
    files = files.filter((f) => words.every((w) => `${f.name} ${f.attachedTo.join(' ')}`.toLowerCase().includes(w)));
  }
  return { files: files.slice(0, 80), total: files.length };
}

/** Page texts of a stored PDF, extracting now when the background queue has not yet. */
function pdfPages(ctx, fileId) {
  let text = ctx.store.getFileText(fileId);
  if (!text || text.status === 'pending') {
    const result = extractPdfText(fs.readFileSync(path.join(ctx.store.dataDir, 'files', fileId)));
    ctx.store.upsertFileText({ fileId, status: result.status, pages: result.pages, chars: result.chars, extractedAt: new Date().toISOString() });
    text = ctx.store.getFileText(fileId);
  }
  if (text.status === 'no_text') throw toolError('This PDF is a scan (pictures of pages) with no text layer, so it cannot be read. Say so and suggest a searchable copy.');
  if (text.status !== 'ok') throw toolError('This PDF could not be read (damaged or protected with an open password).');
  return safeJsonArray(text.pages_json);
}

/** Pages fromPage..toPage, or the best `search` matches; numbered like the PDF. */
export function pickPages(pages, { fromPage, toPage, search } = {}, label = 'file') {
  if (typeof search === 'string' && search.trim()) {
    const words = search.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
    const scored = pages
      .map((text, i) => {
        const low = String(text).toLowerCase();
        return { page: i + 1, text, score: words.reduce((s, w) => s + (low.split(w).length - 1), 0) };
      })
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .sort((a, b) => a.page - b.page);
    if (!scored.length) return `No page of ${label} (${pages.length} pages) mentions "${search}". Try other words or read pages directly.`;
    return `${label}: ${pages.length} pages; best matches for "${search}":\n\n${scored.map((p) => `--- page ${p.page} ---\n${p.text}`).join('\n\n')}`;
  }
  const from = Math.max(1, Number(fromPage) || 1);
  const to = Math.min(pages.length, Math.max(from, Number(toPage) || from + 3), from + READ_PAGES_MAX - 1);
  if (from > pages.length) return `${label} has only ${pages.length} pages.`;
  const body = [];
  for (let p = from; p <= to; p += 1) body.push(`--- page ${p} ---\n${pages[p - 1] || '(no text on this page)'}`);
  return `${label}: ${pages.length} pages; showing ${from}-${to}.\n\n${body.join('\n\n')}`;
}

function readFile(ctx, args) {
  const fileId = String(args.fileId || '');
  const file = readableFiles(ctx).find((f) => f.fileId === fileId);
  if (!file) throw toolError('Unknown fileId, or this user cannot read that file. Call list_files for valid ids.');
  return pickPages(pdfPages(ctx, fileId), args, file.name);
}

// ---------------------------------------------------------------------------
// Web tools
// ---------------------------------------------------------------------------

/** True for loopback, private, link-local, CGNAT (Tailscale) and other non-public addresses. */
export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb');
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw toolError('Not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw toolError('Only http and https pages can be read.');
  if (url.port && !['80', '443'].includes(url.port)) throw toolError('Only the normal web ports (80/443) are allowed.');
  if (url.username || url.password) throw toolError('URLs with credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw toolError(`Could not find ${host}.`);
  // shortcut: the address is checked before the request, not pinned for it (DNS rebinding); fine for a read-only assistant, pin it if this ever sends data.
  if (addresses.some((a) => isPrivateAddress(a.address))) throw toolError('That address is on a private network; only public web pages can be read.');
  return url;
}

async function webGet(raw, fetchImpl = fetch) {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= WEB_MAX_REDIRECTS; hop += 1) {
    const res = await fetchImpl(url, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    if (!res.ok) throw toolError(`The site answered HTTP ${res.status}.`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > WEB_MAX_BYTES) throw toolError('That file is larger than 8 MB.');
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > WEB_MAX_BYTES) {
        await reader.cancel();
        throw toolError('That file is larger than 8 MB.');
      }
      chunks.push(value);
    }
    return { url: url.href, type: res.headers.get('content-type') || '', body: Buffer.concat(chunks) };
  }
  throw toolError('Too many redirects.');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decodeEntities = (s) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Readable text of an HTML page: scripts, styles and tags removed, blocks on new lines. */
export function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const body = html
    .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { title: title ? decodeEntities(title[1]).trim() : '', text };
}

/** DuckDuckGo HTML results → [{title, url, snippet}]. */
export function parseDuckDuckGo(html) {
  const strip = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const out = [];
  links.forEach((m, i) => {
    if (out.length >= 8) return;
    let href = decodeEntities(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (/duckduckgo\.com\/y\.js/.test(href)) return; // ads
    // The snippet sits between this result link and the next one.
    const until = i + 1 < links.length ? links[i + 1].index : html.length;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(html.slice(m.index + m[0].length, until));
    out.push({ title: strip(m[2]), url: href, snippet: strip(snippet ? snippet[1] : '') });
  });
  return out;
}

async function webSearch(ctx, args) {
  const query = String(args.query || '').trim().slice(0, 300);
  if (!query) throw toolError('Empty query.');
  const res = await (ctx.fetch || fetch)(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
  });
  if (!res.ok) throw toolError(`Web search failed (HTTP ${res.status}).`);
  const results = parseDuckDuckGo(await res.text());
  return results.length ? { query, results } : { query, results: [], note: 'No results; try simpler words.' };
}

async function fetchUrl(ctx, args) {
  const page = await webGet(String(args.url || ''), ctx.fetch);
  const isPdf = /application\/pdf/i.test(page.type) || page.body.subarray(0, 5).toString('latin1') === '%PDF-';
  if (isPdf) {
    const result = extractPdfText(page.body);
    if (result.status === 'no_text') return `${page.url}: a scanned PDF (no text layer); it cannot be read.`;
    if (result.status !== 'ok') return `${page.url}: this PDF could not be read.`;
    return pickPages(result.pages, args, page.url);
  }
  if (!/text\/|html|xml|json/i.test(page.type)) throw toolError(`Not a readable page (${page.type || 'unknown type'}).`);
  const { title, text } = htmlToText(page.body.toString('utf8'));
  return `${title ? `${title}\n` : ''}${page.url}\n\n${text}`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Worker skills (floorMap Read): the roster joined with the skill profiles.
// Phone and locker numbers never go to the model.
// ---------------------------------------------------------------------------

const LEVEL_RANK = { expert: 0, good: 1, learning: 2, '': 3 };

function listWorkerSkills(ctx, args) {
  if (!ctx.workers) throw toolError('This user cannot see the floor workers.');
  let roster = workerRoster(ctx.store.listRecords('floorStations').map((r) => ({ ...r.data, id: r.id })), ctx.store.listRecords('workerProfiles').map((r) => ({ ...r.data, id: r.id })));
  if (args.search) {
    const needle = String(args.search).toLowerCase();
    roster = roster.filter((w) => [w.empId, w.name, w.nameCn, ...w.stations.map((s) => s.code)].some((v) => String(v || '').toLowerCase().includes(needle)));
  }
  if (args.zone) roster = roster.filter((w) => String(w.zone).toLowerCase() === String(args.zone).toLowerCase());
  if (args.skill) {
    const max = LEVEL_RANK[args.level || 'learning'];
    roster = roster.filter((w) => LEVEL_RANK[skillLevelKey(w.profile, args.skill)] <= max);
  }
  const limit = Math.min(400, Math.max(1, Number(args.limit) || 150));
  const workers = roster.slice(0, limit).map((w) => {
    const p = w.profile || {};
    const skills = {};
    for (const type of SKILL_KEYS) {
      const level = skillLevelKey(p, type);
      if (level) skills[type] = level;
    }
    return {
      empId: w.empId,
      name: w.name,
      nameCn: w.nameCn || undefined,
      stations: w.stations.map((s) => s.code).filter(Boolean),
      zone: w.zone,
      hasProfile: Boolean(w.profile),
      skills,
      efficiency: p.efficiency || null,
      dailyOutput: p.dailyOutput || null,
      quality: p.quality || null,
      specialty: p.specialty || undefined,
      notes: p.notes ? String(p.notes).slice(-400) : undefined,
    };
  });
  return { total: roster.length, returned: workers.length, workers };
}

const HANDLERS = {
  list_worker_skills: listWorkerSkills,
  query_records: queryRecords,
  aggregate_records: aggregateRecords,
  get_record: getRecord,
  list_files: listFiles,
  read_file: readFile,
  web_search: webSearch,
  fetch_url: fetchUrl,
};

/**
 * Run one tool call. Never throws: failures come back as text the model can
 * act on. `ctx` = {store, user, stores, machineNames, chatFileIds, web, fetch?}.
 */
export async function runTool(ctx, name, rawArgs) {
  if (!HANDLERS[name] || ((name === 'web_search' || name === 'fetch_url') && !ctx.web)) {
    return `Error: unknown tool "${name}".`;
  }
  let args = rawArgs;
  if (typeof args === 'string') {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch {
      return 'Error: the tool arguments were not valid JSON.';
    }
  }
  if (!args || typeof args !== 'object') args = {};
  try {
    return clip(await HANDLERS[name](ctx, args));
  } catch (error) {
    if (error instanceof ToolError) return `Error: ${error.message}`;
    console.error(`[ai] tool ${name} failed:`, error && error.message ? error.message : error);
    return `Error: the ${name} tool failed (${error && error.name === 'TimeoutError' ? 'timed out' : 'internal error'}).`;
  }
}

/** The per-question tool context for one user. */
export function toolContext(store, user, { chatFileIds = [], web = webEnabled(), fetchImpl } = {}) {
  const stores = readableStores(store, user);
  const who = { ...user, store };
  const machineNames = new Map(
    can(who, 'machines', 'read') ? store.listRecords('machines').map((m) => [m.id, m.data?.name || m.id]) : []
  );
  // Worker skills follow the floor map permission (read to see, write to apply updates).
  const workers = can(who, 'floorMap', 'read');
  return { store, user, stores, machineNames, chatFileIds, web, workers, fetch: fetchImpl };
}

/** One short line per tool call for the chat's "what I did" list. */
export function describeToolCall(name, rawArgs) {
  let args = {};
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {};
  } catch {
    args = {};
  }
  const labels = { workOrders: 'service orders', pmTasks: 'PM tasks', purchaseRequests: 'parts requests', libraryItems: 'library' };
  const storeLabel = labels[args.store] || args.store || '';
  switch (name) {
    case 'query_records':
      return `Searched ${storeLabel}${args.search ? ` for "${args.search}"` : ''}`;
    case 'aggregate_records':
      return `Analysed ${storeLabel}${args.groupBy ? ` by ${args.groupBy}` : ''}${args.period ? ` per ${args.period}` : ''}`;
    case 'get_record':
      return `Opened a ${storeLabel} record${args.history ? ' and its history' : ''}`;
    case 'list_files':
      return 'Listed readable PDFs';
    case 'list_worker_skills':
      return `Checked worker skills${args.skill ? ` (${args.skill})` : ''}${args.search ? ` for "${args.search}"` : ''}`;
    case 'read_file':
      return args.search ? `Searched a PDF for "${args.search}"` : `Read PDF pages ${args.fromPage || 1}–${args.toPage || (args.fromPage || 1) + 3}`;
    case 'web_search':
      return `Web search: "${args.query || ''}"`;
    case 'fetch_url': {
      let host = '';
      try {
        host = new URL(args.url).hostname;
      } catch {
        host = 'a page';
      }
      return `Read ${host}`;
    }
    default:
      return name;
  }
}
