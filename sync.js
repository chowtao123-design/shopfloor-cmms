// Offline-first sync engine (SPEC-v2.md section 8): outbox, push, pull,
// conflict notices. Pure helpers live in logic-sync.js; IndexedDB in db.js.

import * as db from './db.js';
import {
  applyPull,
  backoffDelay,
  coalesceOutbox,
  outboxKey,
  statusText,
  toLocalRecord,
  toServerData,
} from './logic-sync.js';

const RECORD_STORES = ['machines', 'parts', 'workOrders', 'pmTasks', 'coworkers', 'contractors'];
const PULL_INTERVAL_MS = 30000;
const PULL_PAGE_LIMIT = 500;
const MAX_PULL_PAGES = 200;
const FAILED_LIST_MAX = 200;
const PUSH_SCHEDULE_MS = 25;

let me = null;
let needsLogin = false;
let online = true;
// `online` is only the browser's network indicator; the server can still be
// down. `serverReachable` goes false when a push/pull cannot reach it and
// back true on any successful API response (SPEC-v2.md 8).
let serverReachable = true;
let pushInFlight = false;
let pullInFlight = false;
let retryCount = 0;
let retryTimer = null;
let pullTimer = null;
let listenersBound = false;

function nowISO() {
  return new Date().toISOString();
}

function uid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function dispatch(name, detail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function hasWindow() {
  return typeof window !== 'undefined';
}

function normalizeBaseVersion(baseVersion) {
  if (baseVersion === undefined || baseVersion === null) return null;
  const number = Number(baseVersion);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

/**
 * JSON API helper. Same-origin credentials, the CSRF header the server
 * requires for non-GET routes, JSON bodies. Never throws for HTTP error
 * statuses; only network-level failures reject (which also marks the
 * server unreachable for the status pill).
 */
export async function api(method, path, body) {
  const headers = { 'X-Requested-With': 'maint-log' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    serverReachable = false;
    throw error;
  }
  serverReachable = true;
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { ok: response.ok, status: response.status, data };
}

export function currentUser() {
  return me;
}

export function isNeedsLogin() {
  return needsLogin;
}

async function readOutbox() {
  const entries = await db.getAll(db.OUTBOX_STORE);
  entries.sort(
    (a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.opId).localeCompare(String(b.opId)),
  );
  return entries;
}

async function getFailedEntries() {
  const list = await db.getMeta('failed');
  return Array.isArray(list) ? list : [];
}

/** Drop every outbox row that was folded into a coalesced entry. */
async function dropEntry(entry) {
  for (const opId of entry.mergedFrom || [entry.opId]) {
    await db.del(db.OUTBOX_STORE, opId);
  }
}

async function moveEntryToFailed(entry, message) {
  const list = await getFailedEntries();
  list.push({
    opId: entry.opId,
    kind: entry.kind,
    store: entry.store,
    id: entry.id,
    payload: entry.payload,
    baseVersion: normalizeBaseVersion(entry.baseVersion),
    error: message || 'The server rejected this change.',
    failedAt: nowISO(),
  });
  await db.setMeta('failed', list.slice(-FAILED_LIST_MAX));
  await dropEntry(entry);
}

/** Pending outbox keys that a pull must not overwrite. */
async function pendingKeys() {
  const entries = await readOutbox();
  const keys = new Set();
  for (const entry of entries) {
    keys.add(outboxKey(entry.store, entry.id));
  }
  return keys;
}

async function emitStatus() {
  const entries = isSyncedMode() ? await readOutbox() : [];
  const pending = coalesceOutbox(entries).length;
  const failed = (await getFailedEntries()).length;
  const effectiveOnline = online && serverReachable;
  const detail = {
    // A reachable-looking network with a down server still shows Offline
    // (SPEC-v2.md 8), so the pill never claims Synced/Saving against a
    // server that cannot take edits.
    text: statusText({ online: effectiveOnline, pending, needsLogin, failed }),
    online: effectiveOnline,
    pending,
    needsLogin,
    failed,
    user: me,
  };
  dispatch('sync-status', detail);
  return detail;
}

function isSyncedMode() {
  return Boolean(me);
}

async function enqueue(entry) {
  const record = {
    ...entry,
    opId: uid(),
    createdAt: nowISO(),
    attempts: 0,
  };
  await db.put(db.OUTBOX_STORE, record);
  await emitStatus();
  return record;
}

function schedulePush(delayMs = PUSH_SCHEDULE_MS) {
  if (!hasWindow() || !isSyncedMode() || needsLogin) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryTimer = setTimeout(() => {
    retryTimer = null;
    push();
  }, delayMs);
}

function schedulePull() {
  if (!hasWindow() || !isSyncedMode() || needsLogin) return;
  setTimeout(() => {
    pull();
  }, PUSH_SCHEDULE_MS);
}

function requireLogin() {
  needsLogin = true;
  dispatch('sync-session', { reason: 'login-required' });
}

function entryTitle(entry) {
  const payload = entry.payload;
  if (payload && typeof payload === 'object') {
    const title = payload.title || payload.name;
    if (title) return String(title);
  }
  return '';
}

function dispatchConflict(entry, conflict) {
  if (!conflict) return;
  dispatch('sync-conflict', {
    conflict,
    store: entry.store,
    id: entry.id,
    title: entryTitle(entry),
  });
}

async function bumpAttempts(entry) {
  for (const opId of entry.mergedFrom || [entry.opId]) {
    const row = await db.get(db.OUTBOX_STORE, opId);
    if (row) {
      row.attempts = Math.max(0, Math.floor(Number(row.attempts) || 0)) + 1;
      await db.put(db.OUTBOX_STORE, row);
    }
  }
}

/**
 * Push one outbox entry. Returns 'ok' | 'login' | 'retry' | 'failed'.
 */
async function pushOne(entry) {
  let response;
  try {
    if (entry.kind === 'stock') {
      response = await api('POST', '/api/stock-moves', { moves: [entry.payload] });
    } else if (entry.kind === 'delete') {
      const baseVersion = normalizeBaseVersion(entry.baseVersion);
      const suffix = baseVersion === null ? '' : `?baseVersion=${baseVersion}`;
      response = await api(
        'DELETE',
        `/api/records/${encodeURIComponent(entry.store)}/${encodeURIComponent(entry.id)}${suffix}`,
      );
    } else {
      response = await api(
        'PUT',
        `/api/records/${encodeURIComponent(entry.store)}/${encodeURIComponent(entry.id)}`,
        {
          data: entry.payload,
          baseVersion: normalizeBaseVersion(entry.baseVersion),
          clientId: me ? me.id : null,
          clientTime: nowISO(),
        },
      );
    }
  } catch (error) {
    console.warn('Sync push failed (network):', error);
    return 'retry';
  }
  if (response.status === 401) return 'login';
  if (response.status === 400) {
    const message = response.data && response.data.message ? response.data.message : 'The server rejected this change.';
    await moveEntryToFailed(entry, message);
    return 'failed';
  }
  if (!response.ok) {
    console.error(`Sync push failed (HTTP ${response.status}).`);
    return 'retry';
  }
  const data = response.data || {};
  if (entry.kind === 'stock') {
    const pending = await pendingKeys();
    for (const partRecord of Array.isArray(data.parts) ? data.parts : []) {
      if (!partRecord) continue;
      // A pending local edit of the same part (e.g. a rename made offline)
      // stays untouched here; its own outbox entry will push and win.
      if (pending.has(outboxKey('parts', partRecord.id))) continue;
      await db.put('parts', toLocalRecord(partRecord));
    }
  } else if (entry.kind === 'put') {
    if (data.record && !data.record.deleted) {
      await db.put(data.record.store, toLocalRecord(data.record));
    }
    if (data.conflict) dispatchConflict(entry, data.conflict);
  } else if (entry.kind === 'delete') {
    if (data.conflict) dispatchConflict(entry, data.conflict);
  }
  return 'ok';
}

/**
 * Push the outbox: coalesce, send in order, drop entries that made it,
 * keep entries when offline (retry with backoff and on `online`), stop on
 * 401, and move 400-rejected entries to the failed list in `meta`.
 */
export async function push() {
  if (!isSyncedMode() || needsLogin || pushInFlight) return { ok: false, reason: 'inactive' };
  pushInFlight = true;
  let stopped = null;
  let applied = 0;
  try {
    const entries = await readOutbox();
    if (entries.length === 0) {
      retryCount = 0;
      return { ok: true, applied: 0 };
    }
    const merged = coalesceOutbox(entries);
    for (const entry of merged) {
      const outcome = await pushOne(entry);
      if (outcome === 'ok') {
        applied += 1;
        await dropEntry(entry);
      } else if (outcome === 'login') {
        stopped = 'login';
        break;
      } else if (outcome === 'retry') {
        stopped = 'retry';
        await bumpAttempts(entry);
        break;
      }
      // 'failed' entries are already moved out of the outbox; keep going.
    }
    if (stopped === 'login') {
      requireLogin();
    } else if (stopped === 'retry') {
      retryCount += 1;
      schedulePush(backoffDelay(retryCount));
    } else {
      retryCount = 0;
      const remaining = await readOutbox();
      // Entries enqueued while this push ran flush right away.
      if (remaining.length > 0) schedulePush();
    }
    // Pushed records were applied to the local store by the push itself
    // (with server version/number/updatedBy); the page refreshes like after
    // a pull so e.g. an order's SO number replaces "SO-pending".
    if (applied > 0 && stopped !== 'login') dispatch('sync-applied', { applied });
    if (applied > 0 && stopped !== 'login') schedulePull();
    return { ok: stopped === null, applied };
  } finally {
    pushInFlight = false;
    await emitStatus();
  }
}

async function loadLocalRecords() {
  const all = [];
  for (const store of RECORD_STORES) {
    all.push(...(await db.getAll(store)));
  }
  return all;
}

/**
 * Pull the changes feed from the last stored `lastSeq`, looping while the
 * server says there is more, and apply it with pending-edit protection.
 */
export async function pull() {
  if (!isSyncedMode() || needsLogin || pullInFlight) return { ok: false, reason: 'inactive' };
  pullInFlight = true;
  let applied = 0;
  try {
    let since = Number(await db.getMeta('lastSeq')) || 0;
    let more = true;
    let pages = 0;
    let failure = null;
    while (more && pages < MAX_PULL_PAGES) {
      let response;
      try {
        response = await api('GET', `/api/changes?since=${since}&limit=${PULL_PAGE_LIMIT}`);
      } catch (error) {
        console.warn('Sync pull failed (network):', error);
        failure = 'offline';
        break;
      }
      if (response.status === 401) {
        requireLogin();
        failure = 'login';
        break;
      }
      if (!response.ok) {
        console.error(`Sync pull failed (HTTP ${response.status}).`);
        failure = 'error';
        break;
      }
      const data = response.data || {};
      const records = Array.isArray(data.records) ? data.records : [];
      if (records.length > 0) {
        const localRecords = await loadLocalRecords();
        const pending = await pendingKeys();
        const ops = applyPull(localRecords, records, pending);
        for (const op of ops) {
          if (op.action === 'put') await db.put(op.store, op.record);
          else if (op.action === 'delete') await db.del(op.store, op.id);
        }
        applied += ops.filter((op) => op.action === 'put' || op.action === 'delete').length;
      }
      const lastSeq = Number(data.lastSeq);
      if (Number.isFinite(lastSeq)) since = Math.max(since, lastSeq);
      await db.setMeta('lastSeq', since);
      more = Boolean(data.more);
      pages += 1;
    }
    if (applied > 0) dispatch('sync-applied', { applied });
    return failure ? { ok: false, reason: failure } : { ok: true, applied };
  } finally {
    pullInFlight = false;
    await emitStatus();
  }
}

/**
 * Save a record locally (marked pendingSync) and queue it in the outbox.
 * `baseVersion` is the server version the edit was based on (null = create).
 * Without a signed-in session (standalone mode) this is a plain local save.
 */
export async function saveRecord(store, record, baseVersion) {
  if (!isSyncedMode()) {
    await db.put(store, record);
    return record;
  }
  const local = { ...record, pendingSync: true };
  await db.put(store, local);
  await enqueue({
    kind: 'put',
    store,
    id: record.id,
    payload: toServerData(record),
    baseVersion: normalizeBaseVersion(baseVersion),
  });
  schedulePush();
  return local;
}

/**
 * Delete a record: remove it locally at once and queue the tombstone push.
 */
export async function deleteRecord(store, id, baseVersion) {
  if (!isSyncedMode()) {
    await db.del(store, id);
    return;
  }
  await db.del(store, id);
  await enqueue({
    kind: 'delete',
    store,
    id,
    payload: null,
    baseVersion: normalizeBaseVersion(baseVersion),
  });
  schedulePush();
}

/**
 * Stock is synced as deltas (SPEC-v2.md 7.3): update the local part at once,
 * queue a move with a client UUID id (idempotent server-side). Standalone
 * mode keeps the v1 behavior of writing the part directly.
 */
export async function adjustStock(partId, delta, reason, workOrderId = null) {
  const fresh = await db.get('parts', partId);
  if (!fresh) return null;
  const number = Math.floor(Number(delta) || 0);
  if (number === 0) return fresh;
  const currentQty = Math.max(0, Math.floor(Number(fresh.qtyOnHand) || 0));
  const nextQty = Math.max(0, currentQty + number);
  if (!isSyncedMode()) {
    const updated = { ...fresh, qtyOnHand: nextQty, updatedAt: nowISO() };
    await db.put('parts', updated);
    return updated;
  }
  const moveId = uid();
  const updated = { ...fresh, qtyOnHand: nextQty, updatedAt: nowISO(), pendingSync: true };
  await db.put('parts', updated);
  await enqueue({
    kind: 'stock',
    store: 'parts',
    id: moveId,
    payload: { id: moveId, partId, delta: number, reason, workOrderId: workOrderId || null },
  });
  schedulePush();
  return updated;
}

function handleOnline() {
  online = true;
  emitStatus();
  schedulePush();
  schedulePull();
}

function handleOffline() {
  online = false;
  emitStatus();
}

function handleIntervalTick() {
  if (
    typeof document === 'undefined' ||
    (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible')
  ) {
    return;
  }
  pull();
}

function bindListeners() {
  if (listenersBound || !hasWindow()) return;
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  pullTimer = setInterval(handleIntervalTick, PULL_INTERVAL_MS);
  online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  listenersBound = true;
}

function unbindListeners() {
  if (!listenersBound || !hasWindow()) return;
  window.removeEventListener('online', handleOnline);
  window.removeEventListener('offline', handleOffline);
  if (pullTimer) {
    clearInterval(pullTimer);
    pullTimer = null;
  }
  listenersBound = false;
}

/**
 * Begin syncing as the signed-in `user` (SPEC-v2.md 8 pull triggers: start,
 * after each push, every 30 s while visible, `online`). Call pull() once
 * right after this for the initial load.
 */
export async function start(user) {
  me = user && user.id ? user : null;
  needsLogin = false;
  retryCount = 0;
  if (!me) return;
  await db.setMeta('me', me);
  bindListeners();
  await emitStatus();
  schedulePush();
}

/** Stop syncing and clear timers (called on sign-out). */
export function stop() {
  me = null;
  needsLogin = false;
  retryCount = 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  unbindListeners();
  const effectiveOnline = online && serverReachable;
  dispatch('sync-status', {
    text: statusText({ online: effectiveOnline, pending: 0, needsLogin: false, failed: 0 }),
    online: effectiveOnline,
    pending: 0,
    needsLogin: false,
    failed: 0,
    user: null,
  });
}

/** MoveIds of failed outbox entries, newest last, for the Settings list (S6). */
export async function failedEntries() {
  return getFailedEntries();
}

/** Retry the entries on the failed list once (Settings action, S6). */
export async function retryFailed() {
  const list = await getFailedEntries();
  if (list.length === 0) return;
  await db.setMeta('failed', []);
  for (const failed of list) {
    await enqueue({
      kind: failed.kind,
      store: failed.store,
      id: failed.id,
      payload: failed.payload,
      baseVersion: failed.baseVersion,
    });
  }
  schedulePush();
}