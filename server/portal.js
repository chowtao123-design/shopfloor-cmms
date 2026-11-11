// Contractor map page (v6): a public, login-free page for one outside
// contractor, opened with a secret link made on his Outside Contractors
// record. It shows only the machines with open service orders assigned to
// him on a bare floor plan (no staff names), and lets him leave a comment on
// each order. Every token gets one page load and one comment per 5 seconds.

import crypto from 'node:crypto';

import { hashPassword } from './auth.js';
import { putRecord } from './records.js';
import { lineAreas, slotRects } from '../logic-map.js';
import { formatOrderNumber, LABELS } from '../logic.js';

export const PORTAL_WINDOW_MS = 5000;
export const PORTAL_COMMENT_MAX = 1000;
export const PORTAL_COMMENTS_KEPT = 200;
const PORTAL_USERNAME = 'contractor-portal';

const linkKey = (contractorId) => `portal.contractor.${contractorId}`;
const tokenKey = (token) => `portal.token.${crypto.createHash('sha256').update(token).digest('hex')}`;

/** A new secret link for the contractor (the old one stops working). Returns the token. */
export function createPortalLink(store, contractorId) {
  revokePortalLink(store, contractorId);
  const token = crypto.randomBytes(24).toString('base64url');
  store.setSetting(linkKey(contractorId), token);
  store.setSetting(tokenKey(token), contractorId);
  return token;
}

/** The contractor's current token, or null. */
export function portalLinkOf(store, contractorId) {
  return store.getSetting(linkKey(contractorId)) || null;
}

export function revokePortalLink(store, contractorId) {
  const old = portalLinkOf(store, contractorId);
  if (old) store.setSetting(tokenKey(old), '');
  store.setSetting(linkKey(contractorId), '');
}

/** The contractor record a token opens, or null (unknown, revoked, deleted, inactive). */
export function contractorForToken(store, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const id = store.getSetting(tokenKey(token));
  if (!id || portalLinkOf(store, id) !== token) return null;
  const row = store.getRecord('contractors', id);
  if (!row || Number(row.deleted) === 1) return null;
  const data = JSON.parse(row.data);
  if (data.active === false) return null;
  return { id, ...data };
}

// --- Rate limit: one load and one comment per token per 5 seconds ----------

const lastHit = new Map();

/** Seconds to wait, or 0 when this request may go ahead (and is counted). */
export function portalWait(token, kind, now = Date.now()) {
  const key = `${kind}:${token}`;
  const last = lastHit.get(key) || 0;
  if (now - last < PORTAL_WINDOW_MS) return Math.ceil((PORTAL_WINDOW_MS - (now - last)) / 1000);
  lastHit.set(key, now);
  if (lastHit.size > 5000) {
    for (const [k, at] of lastHit) if (now - at > PORTAL_WINDOW_MS) lastHit.delete(k);
  }
  return 0;
}

export function resetPortalRateLimit() {
  lastHit.clear();
}

// --- What the page shows ---------------------------------------------------

const assignedTo = (order, contractorId) =>
  Array.isArray(order.assignees) && order.assignees.some((a) => a && a.kind === 'contractor' && a.id === contractorId);

/** The contractor's open service orders, his machines' places on the plan, and the plan itself (geometry only). */
export function portalPayload(store, contractor) {
  const orders = store
    .listRecords('workOrders')
    .filter((r) => r.data.status !== 'done' && assignedTo(r.data, contractor.id));
  const machines = new Map(store.listRecords('machines').map((r) => [r.id, r.data]));
  const maps = store.listRecords('floorMaps');
  const stations = store.listRecords('floorStations').map((r) => r.data);
  const machineIds = new Set(orders.map((o) => o.data.machineId));

  // Station rectangles of those machines, per floor.
  const highlightsByMap = new Map();
  for (const st of stations) {
    if (!st.machineId || !machineIds.has(st.machineId) || !st.boxId) continue;
    const map = maps.find((m) => m.id === st.mapId);
    const box = map && (map.data.boxes || []).find((b) => b && b.id === st.boxId);
    const rect = box && slotRects(box).find((r) => r.slot === (Number(st.slot) || 0));
    if (!rect) continue;
    const list = highlightsByMap.get(map.id) || [];
    list.push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, machineId: st.machineId, code: st.code || '' });
    highlightsByMap.set(map.id, list);
  }
  const floor =
    maps.find((m) => highlightsByMap.has(m.id)) || maps.slice().sort((a, b) => (b.data.boxes || []).length - (a.data.boxes || []).length)[0] || null;

  const stationOf = new Map();
  for (const h of (floor && highlightsByMap.get(floor.id)) || []) if (!stationOf.has(h.machineId)) stationOf.set(h.machineId, h.code);

  return {
    contractor: { company: contractor.company || contractor.contactName || '', contactName: contractor.contactName || '' },
    generatedAt: new Date().toISOString(),
    orders: orders
      .sort((a, b) => String(a.data.dueDate || '9999').localeCompare(String(b.data.dueDate || '9999')))
      .map((r) => {
        const d = r.data;
        const m = machines.get(d.machineId) || {};
        return {
          id: r.id,
          number: formatOrderNumber(d.number) || '',
          title: d.title || '',
          problem: d.problem || '',
          status: d.status || 'open',
          priority: d.priority || '',
          dueDate: d.dueDate || null,
          machine: {
            id: d.machineId,
            name: m.name || '',
            type: (LABELS.machineType && LABELS.machineType[m.type]) || m.type || '',
            location: m.location || '',
          },
          station: stationOf.get(d.machineId) || '',
          comments: Array.isArray(d.contractorComments) ? d.contractorComments.slice(-50) : [],
        };
      }),
    // Geometry only: no station codes or staff names except the highlights.
    map: floor
      ? {
          width: floor.data.width,
          height: floor.data.height,
          boxes: (floor.data.boxes || []).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, label: typeof b.label === 'string' ? b.label : '' })),
          corridors: (floor.data.corridors || []).map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
          fills: (floor.data.fills || []).map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, color: f.color })),
          highlights: highlightsByMap.get(floor.id) || [],
          // Production line outlines ("Line A", "Line B"): labels and rectangles only.
          areas: lineAreas(stations.filter((st) => st.mapId === floor.id), floor.data),
        }
      : null,
  };
}

/** The disabled user that portal comments are saved as (History shows "Contractor portal"). */
function portalUser(store) {
  let row = store.getUserByUsername(PORTAL_USERNAME);
  if (!row) {
    const viewer = store.getRoleByName('Viewer');
    const created = store.createUser({
      username: PORTAL_USERNAME,
      displayName: 'Contractor portal',
      roleId: viewer ? viewer.id : undefined,
      role: viewer ? undefined : 'tech',
      passwordHash: hashPassword(crypto.randomBytes(32).toString('hex')),
    });
    store.updateUser(created.id, { disabled: 1 });
    row = store.getUserById(created.id);
  }
  return { id: row.id, username: row.username, roleId: row.role_id, store };
}

/** Add the contractor's comment to one of his open orders. Returns the saved comment or an error string. */
export function addPortalComment(store, contractor, orderId, text) {
  const comment = String(text ?? '').trim();
  if (!comment) return 'empty';
  if (comment.length > PORTAL_COMMENT_MAX) return 'too_long';
  const row = typeof orderId === 'string' ? store.getRecord('workOrders', orderId) : null;
  if (!row || Number(row.deleted) === 1) return 'not_found';
  const data = JSON.parse(row.data);
  if (data.status === 'done' || !assignedTo(data, contractor.id)) return 'not_found';
  const entry = { at: new Date().toISOString(), by: contractor.company || contractor.contactName || 'Contractor', text: comment };
  const comments = [...(Array.isArray(data.contractorComments) ? data.contractorComments : []), entry].slice(-PORTAL_COMMENTS_KEPT);
  putRecord(store, {
    storeName: 'workOrders',
    id: row.id,
    body: { data, baseVersion: Number(row.version) },
    user: portalUser(store),
    note: `contractor comment (${entry.by})`,
    serverFields: { contractorComments: comments },
  });
  return entry;
}
