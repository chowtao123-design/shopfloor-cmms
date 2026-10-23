import * as db from './db.js';
import {
  BACKUP_STORES,
  COWORKER_SHIFTS,
  DEFAULT_MACHINE_TYPE,
  LABELS,
  MACHINE_STATUSES,
  MACHINE_TYPE_GROUPS,
  MACHINE_TYPES,
  PRIORITIES,
  SO_DUE_FILTERS,
  WORK_ORDER_CATEGORIES,
  WORK_ORDER_KINDS,
  WORK_ORDER_STATUSES,
  applyWorkOrderSave,
  applyWorkOrderStatus,
  buildPMCompletionOrder,
  buildLowStockRequestLines,
  contactSearch,
  customTypeOptions,
  compactSyncLabel,
  dashboardCounts,
  daysBetween,
  defaultServiceOrderFilters,
  escapeHtmlText,
  filterServiceOrders,
  filterWorkOrders,
  formatDate,
  formatHours,
  formatMoney,
  formatOrderNumber,
  formatPartsUsed,
  formatRequestNumber,
  groupPMTasks,
  initialsOf,
  isISODate,
  isLowStock,
  isRecentDone,
  labourTotal,
  machineTypeLabel,
  moveRequestLine,
  needsAttention,
  openBreakdownCount,
  openJobCount,
  partRequestLine,
  pmDueDate,
  pmPaused,
  pmState,
  priorityValue,
  requestHstLabel,
  requestSheetCSV,
  requestSheetHTML,
  requestSheetRows,
  requestSheetTotals,
  requestSheetTSV,
  REQUEST_SHEET_COLUMNS,
  requestTotals,
  searchParts,
  searchPurchaseRequests,
  searchWorkOrders,
  serviceOrderDueState,
  shouldOfferMachineDown,
  shouldOfferMachineRunning,
  sortRows,
  sortWorkOrdersNewest,
  todayISO,
  validateBackup,
  workOrderAgeDays,
  workOrdersToCSV,
} from './logic.js';
import {
  countByPriority,
  countByStatus,
  createdVsCompletedWeekly,
  downNow,
  downtimeByMachineType,
  kpis,
  labourByContractor,
  labourByCoworker,
  machineStatusCounts,
  rangeFor,
  tableToCSV,
  todayStrip,
  topMachinesByBreakdowns,
} from './logic-stats.js';
import { barChart, horizontalBarChart, lineChart } from './charts.js';
import {
  aiSettingsCard,
  consumeAiDraft,
  initAiChat,
  parseDraftForForm,
  refreshAiStatus,
  resetAiChat,
  updateAiChatButton,
} from './chat.js';
import { buildSampleData } from './seed.js';
import { renderHelp } from './help.js';
import * as sync from './sync.js';
import { checkSession, logout, renderLogin } from './login.js';
import { AREAS, AREA_KEYS, allows } from './permissions.js';
import * as adminUI from './admin.js';

/**
 * Contractor rates and costs are stored in dollars (SPEC-v3.md section 5);
 * formatMoney takes integer cents (SPEC-v4.md section 2), so convert first.
 * null/undefined/non-numbers stay null for "hide the figure".
 */
function dollarsToCents(value) {
  if (value === null || value === undefined || value === '') return null;
  return Math.round(Number(value) * 100);
}

const appMain = document.getElementById('app-main');
const pageTitle = document.getElementById('page-title');
const backButton = document.getElementById('back-button');
const fab = document.getElementById('fab');
const dialogRoot = document.getElementById('dialog-root');
const toastRoot = document.getElementById('toast-root');
const syncPill = document.getElementById('sync-pill');
const userMenuButton = document.getElementById('user-menu-button');

/* V3-M2 shell elements (SPEC-v3.md sections 8 and 10). */
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarAppName = document.getElementById('sidebar-app-name');
const sidebarLogo = document.getElementById('sidebar-logo');
const sidebarMark = document.getElementById('sidebar-brand-mark');
const headerBrandLogo = document.getElementById('header-brand-logo');
const headerBrandName = document.getElementById('header-brand-name');
const headerBrandMark = document.getElementById('header-brand-mark');
const globalSearchBox = document.getElementById('global-search');
const globalSearchInput = document.getElementById('global-search-input');
const globalSearchResults = document.getElementById('global-search-results');
const moreButton = document.getElementById('more-button');

const DESKTOP_QUERY = '(min-width: 1024px)';
const desktopMedia = window.matchMedia(DESKTOP_QUERY);
// Phone header (SPEC-v2.md 15.4 item 2): same boundary as CSS max-width: 767.98px.
const PHONE_QUERY = '(max-width: 767.98px)';
const phoneMedia = window.matchMedia(PHONE_QUERY);

const state = {
  machines: [],
  parts: [],
  workOrders: [],
  pmTasks: [],
  // v3 people stores (SPEC-v3.md section 5; synced since M3 for the form).
  coworkers: [],
  contractors: [],
  // v4 (SPEC-v4.md section 2): parts requests, synced like every record store.
  purchaseRequests: [],
};

let fieldCounter = 0;
let teamUser = null;
let teamUsers = [];
let loginActive = false;
let syncEventsBound = false;
let userMenuElement = null;
const LAST_BACKUP_KEY = 'maint-log:last-backup';
const LAST_MACHINE_KEY = 'maint-log:last-machine';
const LAST_TAB_KEY = 'maint-log:last-tab';
const SIDEBAR_RAIL_KEY = 'maint-log:sidebar-rail';

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private browsing; the app still works.
  }
}

function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // See storageSet.
  }
}

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
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

function uid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function toInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function toast(message, type = '') {
  const node = h('div', { class: `toast ${type}`.trim(), role: 'status' }, message);
  toastRoot.append(node);
  setTimeout(() => node.remove(), 5200);
}

function showWarnings(warnings) {
  for (const warning of warnings || []) toast(warning, 'warn');
}

/* ---------- Branding (SPEC-v3.md section 8, client side) ----------
   GET /api/branding is public; the name and logo show in the sidebar,
   the tablet header and the login card, and feed document.title. The last
   value is cached in IndexedDB (meta store) so it also works offline. */

const DEFAULT_BRAND_NAME = 'Shopfloor CMMS';
let branding = null;

function brandName() {
  return branding && branding.name ? branding.name : DEFAULT_BRAND_NAME;
}

function brandLogoUrl() {
  return branding && branding.logoUrl ? branding.logoUrl : null;
}

function applyBranding(payload) {
  if (!payload || typeof payload.name !== 'string') return;
  branding = {
    name: payload.name.trim() || DEFAULT_BRAND_NAME,
    logoUrl: typeof payload.logoUrl === 'string' ? payload.logoUrl : null,
  };
  const logoUrl = brandLogoUrl();

  if (sidebarAppName) sidebarAppName.textContent = brandName();
  if (sidebarMark) {
    sidebarMark.textContent = initialsOf(brandName()) || '··';
    // The uploaded logo replaces the initials square; show one or the other, never both.
    sidebarMark.hidden = Boolean(logoUrl);
  }
  if (sidebarLogo) {
    sidebarLogo.hidden = !logoUrl;
    if (logoUrl && sidebarLogo.getAttribute('src') !== logoUrl) sidebarLogo.setAttribute('src', logoUrl);
  }

  if (headerBrandName) headerBrandName.textContent = brandName();
  if (headerBrandMark) {
    headerBrandMark.textContent = initialsOf(brandName()) || '··';
    headerBrandMark.hidden = Boolean(logoUrl);
  }
  if (headerBrandLogo) {
    headerBrandLogo.hidden = !logoUrl;
    if (logoUrl && headerBrandLogo.getAttribute('src') !== logoUrl) headerBrandLogo.setAttribute('src', logoUrl);
  }

  decorateLoginCard();
}

/* The login card is rendered by login.js; branding is applied to it here. */
function decorateLoginCard() {
  if (!loginActive) return;
  const heading = appMain.querySelector('.login-card h2');
  if (!heading) return;
  const logoUrl = brandLogoUrl();
  const logo = logoUrl ? h('img', { class: 'brand-logo login-logo', src: logoUrl, alt: '' }) : null;
  heading.replaceChildren(logo, brandName());
}

async function loadCachedBranding() {
  try {
    const cached = await db.getMeta('branding');
    if (cached) applyBranding(cached);
  } catch (error) {
    console.warn('Could not read the cached branding:', error);
  }
}

async function refreshBranding() {
  try {
    const response = await sync.api('GET', '/api/branding');
    if (!response.ok || !response.data || typeof response.data.name !== 'string') return;
    await db.setMeta('branding', response.data);
    applyBranding(response.data);
  } catch (error) {
    // Offline or no server: keep the cached value (loaded on start).
    console.warn('Could not load branding from the server:', error);
  }
}

function setTitle(title) {
  pageTitle.textContent = title;
  document.title = `${title} · ${brandName()}`;
}

async function refreshState() {
  const [machines, parts, workOrders, pmTasks, coworkers, contractors, purchaseRequests] =
    await Promise.all([
      db.getAll('machines'),
      db.getAll('parts'),
      db.getAll('workOrders'),
      db.getAll('pmTasks'),
      db.getAll('coworkers'),
      db.getAll('contractors'),
      // v4 (SPEC-v4.md section 2): pulled like the other record stores.
      db.getAll('purchaseRequests'),
    ]);
  state.machines = machines;
  state.parts = parts;
  state.workOrders = workOrders;
  state.pmTasks = pmTasks;
  state.coworkers = coworkers;
  state.contractors = contractors;
  state.purchaseRequests = purchaseRequests;
}

function routeInfo() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  return { segments, params: new URLSearchParams(query) };
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function machineById(id) {
  return state.machines.find((machine) => machine.id === id);
}

function partById(id) {
  return state.parts.find((part) => part.id === id);
}

function requestById(id) {
  return state.purchaseRequests.find((request) => request.id === id);
}

function workOrderById(id) {
  return state.workOrders.find((order) => order.id === id);
}

function pmTaskById(id) {
  return state.pmTasks.find((task) => task.id === id);
}

function machineName(id) {
  const machine = machineById(id);
  return machine ? machine.name : 'Unknown machine';
}

function coworkerById(id) {
  return state.coworkers.find((coworker) => coworker.id === id);
}

function contractorById(id) {
  return state.contractors.find((contractor) => contractor.id === id);
}

function teamUserById(id) {
  return teamUsers.find((user) => user && user.id === id);
}

/** Display name of an assignee / labour person {kind, id} (SPEC-v3.md 2). */
function personName(entry) {
  if (!entry || !entry.id) return '';
  if (entry.kind === 'coworker') {
    const coworker = coworkerById(entry.id);
    return coworker ? coworker.name : 'Coworker';
  }
  if (entry.kind === 'contractor') {
    const contractor = contractorById(entry.id);
    if (contractor) return contractor.contactName ? `${contractor.company} (${contractor.contactName})` : contractor.company;
    return 'Contractor';
  }
  if (entry.kind === 'user') {
    const user = teamUserById(entry.id);
    return user ? user.displayName : 'User';
  }
  return '';
}

/** Round initials avatar with the full name in `title` (SPEC-v3.md 3.3). */
function personAvatar(name, kind = '') {
  const text = String(name || '');
  return h(
    'span',
    { class: `avatar avatar-${kind || 'none'}`, 'aria-hidden': 'true', title: text },
    initialsOf(text) || '··',
  );
}

/** Assignee visuals: stacked avatars + names in title attributes. */
function assigneeAvatars(assignees = [], { showNames = false } = {}) {
  const entries = (assignees || []).filter(Boolean).slice(0, 10);
  if (entries.length === 0) return h('span', { class: 'muted' }, 'Unassigned');
  const names = entries.map((entry) => personName(entry) || 'Unknown');
  const wrap = h(
    'span',
    { class: 'avatar-stack', title: names.join(', ') },
    ...entries.map((entry) => personAvatar(personName(entry), entry.kind)),
  );
  return showNames ? [wrap, h('span', { class: 'avatar-names muted' }, names.join(', '))] : wrap;
}

/* ----- Contact actions (SPEC-v3.md section 5): tel: and mailto: links,
   each with a small Copy button. Copying uses the async clipboard API in the
   click handler; a rejection falls back to selecting the text so the user
   can copy it, and a successful copy toasts "Copied". ----- */

function selectTextNode(node) {
  if (!node || typeof document.createRange !== 'function') return;
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function copyContactText(text, linkNode) {
  const clip = navigator.clipboard;
  if (clip && typeof clip.writeText === 'function') {
    clip
      .writeText(text)
      .then(() => toast('Copied'))
      .catch(() => selectTextNode(linkNode));
    return;
  }
  selectTextNode(linkNode);
}

/** Phone or email value as a link + Copy button ("—" when empty). */
function contactValue(kind, value) {
  const text = String(value || '').trim();
  if (!text) return h('span', { class: 'muted' }, '—');
  const isPhone = kind === 'tel';
  const href = `${isPhone ? 'tel:' : 'mailto:'}${text.replace(/\s+/g, '')}`;
  const link = h('a', { class: 'contact-link', href }, text);
  const label = isPhone ? 'phone number' : 'email address';
  const copy = h(
    'button',
    {
      class: 'btn btn-small contact-copy',
      type: 'button',
      'aria-label': `Copy ${label}`,
      title: `Copy ${label}`,
      onclick: () => copyContactText(text, link),
    },
    'Copy',
  );
  return h('span', { class: 'contact-value' }, link, copy);
}

/** Coloured priority badge (SPEC-v3.md 3.3: badge + text). */
function priorityBadge(priority) {
  const value = priorityValue(priority) || 'medium';
  const label = LABELS.priority[priority] || LABELS.priority[value] || priority;
  return h('span', { class: `pill pill-priority priority-${value}` }, label);
}

/** Selectable people for the Assign section and filters (SPEC-v3.md 3.6). */
function assignablePeople() {
  const people = [];
  for (const coworker of state.coworkers) {
    if (coworker && coworker.active === false) continue;
    people.push({
      kind: 'coworker',
      id: coworker.id,
      name: coworker.name,
      sub: coworker.role || LABELS.personKind.coworker,
    });
  }
  for (const contractor of state.contractors) {
    if (contractor && contractor.active === false) continue;
    people.push({
      kind: 'contractor',
      id: contractor.id,
      name: contractor.company,
      sub: contractor.trade || LABELS.personKind.contractor,
    });
  }
  for (const user of teamUsers) {
    if (!user || user.disabled) continue;
    people.push({ kind: 'user', id: user.id, name: user.displayName, sub: LABELS.personKind.user });
  }
  return people.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function statusPill(status, labels) {
  const label = labels ? labels[status] : status;
  return h('span', { class: `pill status-${status}` }, label || status || 'Unknown');
}

function machineTypeBadge(machine) {
  const label = machineTypeLabel(machine);
  if (!label) return '—';
  return h('span', { class: 'type-badge' }, label);
}

function field(labelText, control, hint) {
  const id = control.id || `field-${++fieldCounter}`;
  control.id = id;
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id }, labelText),
    control,
    hint ? h('span', { class: 'field-hint' }, hint) : null,
  );
}

function selectFrom(values, selected, labeler = (value) => value) {
  const select = h('select', {});
  for (const value of values) {
    const option = h('option', { value }, labeler(value));
    if (value === selected) option.selected = true;
    select.append(option);
  }
  return select;
}

/**
 * Machine type <select> with <optgroup>s (SPEC-v2.md 15.1, 15.2): builtin
 * groups, "Your types" (custom types in use, before Other), Other, and the
 * legacy `sewing` value only when the edited machine already has it.
 * Values inside "Your types" are the custom type labels themselves.
 */
function machineTypeSelect(selected, customTypes = []) {
  const select = h('select', {});
  const offered = new Set();
  const addGroup = (label, entries) => {
    const rows = entries.filter(([value]) => value !== '' && !offered.has(value));
    if (rows.length === 0) return;
    const group = h('optgroup', { label });
    for (const [value, text] of rows) {
      offered.add(value);
      const option = h('option', { value }, text);
      if (value === selected) option.selected = true;
      group.append(option);
    }
    select.append(group);
  };
  for (const entry of MACHINE_TYPE_GROUPS) {
    if (entry.group === 'Other') addGroup('Your types', customTypes.map((t) => [t, t]));
    const options = entry.options.slice();
    if (entry.group === 'Sewing machines' && selected === 'sewing') {
      options.push(['sewing', LABELS.machineType.sewing]);
    }
    addGroup(entry.group, options);
  }
  if (selected !== '' && !offered.has(selected)) {
    // The machine's own custom label lost the de-dup or is not listed yet;
    // still offer it so the select shows what is stored.
    addGroup('Your types', [[selected, selected]]);
  }
  return select;
}

function emptyState(title, message, actions = []) {
  return h(
    'div',
    { class: 'empty-state' },
    h('div', { class: 'row-title' }, title),
    h('p', {}, message),
    actions.length ? h('div', { class: 'button-row' }, ...actions) : null,
  );
}

function page(...children) {
  return h('div', { class: 'page' }, ...children);
}

function pageHead(title, ...actions) {
  return h(
    'div',
    { class: 'page-head' },
    h('h2', {}, title),
    actions.length ? h('div', { class: 'button-row' }, ...actions) : null,
  );
}

function sectionTitle(text, ...extra) {
  return h('h3', { class: 'section-title' }, text, ...extra);
}

function showConfirm({
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
}) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const cancel = h('button', { class: 'btn', type: 'button' }, cancelText);
    const confirm = h(
      'button',
      { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`.trim(), type: 'button' },
      confirmText,
    );
    const dialog = h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' },
      h('h2', { id: 'dialog-title' }, title),
      message ? h('p', {}, message) : null,
      h('div', { class: 'dialog-actions' }, cancel, confirm),
    );
    const backdrop = h('div', { class: 'dialog-backdrop' }, dialog);
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
    };
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      dialogRoot.replaceChildren();
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(value);
    };
    cancel.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => close(true));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(false);
    });
    document.addEventListener('keydown', onKey);
    dialogRoot.replaceChildren(backdrop);
    cancel.focus();
  });
}

/** In-page input dialog (never window.prompt). Resolves the value, or null. */
function showInputDialog({
  title,
  message,
  label,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  initial = '',
  type = 'text',
}) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const input = h('input', { type, value: initial, autocomplete: 'off' });
    input.id = `dialog-input-${++fieldCounter}`;
    const cancel = h('button', { class: 'btn', type: 'button' }, cancelText);
    const confirm = h('button', { class: 'btn btn-primary', type: 'submit' }, confirmText);
    const form = h(
      'form',
      { class: 'form', novalidate: true },
      h('label', { class: 'field-label', for: input.id }, label),
      input,
      h('div', { class: 'dialog-actions' }, cancel, confirm),
    );
    const dialog = h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' },
      h('h2', { id: 'dialog-title' }, title),
      message ? h('p', {}, message) : null,
      form,
    );
    const backdrop = h('div', { class: 'dialog-backdrop' }, dialog);
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
    };
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      dialogRoot.replaceChildren();
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(value);
    };
    cancel.addEventListener('click', () => close(null));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      close(input.value);
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(null);
    });
    document.addEventListener('keydown', onKey);
    dialogRoot.replaceChildren(backdrop);
    input.focus();
    input.select();
  });
}

function orderedMachines() {
  const ranks = new Map();
  let rank = 0;
  const last = storageGet(LAST_MACHINE_KEY);
  if (last && machineById(last)) ranks.set(last, rank++);
  for (const order of sortWorkOrdersNewest(state.workOrders)) {
    if (order.machineId && !ranks.has(order.machineId)) ranks.set(order.machineId, rank++);
  }
  return state.machines.slice().sort((a, b) => {
    const rankA = ranks.has(a.id) ? ranks.get(a.id) : Number.MAX_SAFE_INTEGER;
    const rankB = ranks.has(b.id) ? ranks.get(b.id) : Number.MAX_SAFE_INTEGER;
    return rankA - rankB || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function machinePicker(selectedMachineId) {
  const listId = `machine-options-${++fieldCounter}`;
  const options = h('datalist', { id: listId });
  for (const machine of orderedMachines()) {
    options.append(h('option', { value: machine.name }, machine.location || machineTypeLabel(machine)));
  }
  const selected = machineById(selectedMachineId);
  const input = h('input', {
    type: 'text',
    list: listId,
    autocomplete: 'off',
    required: true,
    placeholder: 'Type to find a machine',
    value: selected ? selected.name : '',
  });
  const wrap = h('div', {}, input, options);
  function resolve() {
    const raw = input.value.trim().toLowerCase();
    if (!raw) return null;
    let match = state.machines.find((machine) => machine.name.trim().toLowerCase() === raw);
    if (!match) {
      const partial = state.machines.filter((machine) =>
        machine.name.toLowerCase().includes(raw),
      );
      if (partial.length === 1) match = partial[0];
    }
    return match || null;
  }
  return { wrap, input, resolve };
}

function createPartsEditor(initialPartsUsed = []) {
  const container = h('div', { class: 'parts-editor' });
  const addButton = h(
    'button',
    { class: 'btn btn-small', type: 'button' },
    '+ Add part',
  );
  const hint =
    state.parts.length === 0
      ? h('p', { class: 'field-hint' }, 'No parts in inventory yet. Add parts from the Parts tab.')
      : null;

  function addRow(item = {}) {
    const selectId = `part-select-${++fieldCounter}`;
    const qtyId = `part-qty-${++fieldCounter}`;
    const select = h(
      'select',
      { 'aria-label': 'Part' },
      h('option', { value: '' }, 'Select part'),
      ...state.parts
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((part) => {
          const option = h(
            'option',
            { value: part.id },
            `${part.name}${part.partNumber ? ` (${part.partNumber})` : ''}`,
          );
          if (item.partId === part.id) option.selected = true;
          return option;
        }),
    );
    select.id = selectId;
    const qty = h('input', {
      type: 'number',
      min: 1,
      step: 1,
      inputmode: 'numeric',
      value: item.qty && Number(item.qty) > 0 ? String(Number(item.qty)) : '1',
    });
    qty.id = qtyId;
    const row = h(
      'div',
      { class: 'part-edit-row' },
      h('label', { class: 'sr-only', for: selectId }, 'Part'),
      select,
      h('label', { class: 'sr-only', for: qtyId }, 'Quantity'),
      qty,
      h(
        'button',
        {
          class: 'btn btn-small btn-ghost',
          type: 'button',
          'aria-label': 'Remove part from this service order',
          onclick: () => row.remove(),
        },
        '×',
      ),
    );
    container.append(row);
  }

  for (const item of initialPartsUsed || []) addRow(item);
  addButton.addEventListener('click', () => addRow());
  addButton.disabled = state.parts.length === 0;

  function getPartsUsed() {
    return [...container.querySelectorAll('.part-edit-row')]
      .map((row) => {
        const select = row.querySelector('select');
        const qty = row.querySelector('input[type="number"]');
        return {
          partId: select ? select.value : '',
          qty: toInteger(qty ? qty.value : 0, 0),
        };
      })
      .filter((item) => item.partId && item.qty > 0);
  }

  return {
    element: h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label editor-label' }, 'Parts used'),
      hint,
      container,
      addButton,
    ),
    getPartsUsed,
  };
}

async function persistStockMoves(result, existing) {
  const order = result.order;
  const wasDeducted = Boolean(existing && existing.stockDeducted);
  const deducting = order.status === 'done' && !wasDeducted;
  const restoring = order.status !== 'done' && wasDeducted;
  if (!deducting && !restoring) return;
  const source = deducting ? order.partsUsed || [] : (existing && existing.partsUsed) || [];
  const usage = new Map();
  for (const item of source) {
    if (!item || !item.partId) continue;
    const qty = toInteger(item.qty);
    if (qty <= 0) continue;
    usage.set(item.partId, (usage.get(item.partId) || 0) + qty);
  }
  for (const [partId, qty] of usage) {
    if (!partById(partId)) continue;
    const delta = deducting ? -qty : qty;
    await sync.adjustStock(partId, delta, deducting ? 'job-done' : 'job-reopened', order.id);
  }
}

async function persistWorkOrderSave(existing, incoming, options = {}) {
  const now = nowISO();
  const result = applyWorkOrderSave(existing, incoming, state.parts, todayISO());
  result.order.updatedAt = now;
  await persistStockMoves(result, existing);
  if (options.setMachineDown) {
    const machine = machineById(result.order.machineId);
    // Never auto-change machines that are in storage or retired (SPEC-v2.md 15.3).
    if (machine && machine.status !== 'down' && !pmPaused(machine)) {
      await sync.saveRecord('machines', { ...machine, status: 'down', updatedAt: now }, machine.version);
    }
  }
  await sync.saveRecord('workOrders', result.order, existing ? existing.version : null);
  await refreshState();
  showWarnings(result.warnings);
  if (result.order.machineId) storageSet(LAST_MACHINE_KEY, result.order.machineId);
  return result;
}

async function maybeOfferRunning(order, wasDone) {
  if (wasDone || order.status !== 'done' || order.kind !== 'breakdown') return;
  const machine = machineById(order.machineId);
  if (!shouldOfferMachineRunning(machine, state.workOrders)) return;
  const yes = await showConfirm({
    title: 'Set machine back to Running?',
    message: `No open breakdowns remain for ${machine.name}.`,
    confirmText: 'Set Running',
    cancelText: 'Leave Down',
  });
  if (!yes) return;
  await sync.saveRecord('machines', { ...machine, status: 'running', updatedAt: nowISO() }, machine.version);
  await refreshState();
  toast(`${machine.name} set to Running.`);
}

function formatAge(days) {
  if (days <= 0) return 'Today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

/* ---------- Team mode tags (SPEC-v2.md 9.2) ---------- */

/** Display name for a user id from the cached /api/users list. */
function userDisplayName(id) {
  if (!id) return '';
  const user = teamUsers.find((entry) => entry && entry.id === id);
  return user && user.displayName ? user.displayName : '';
}

/** Relative age ("5 min ago"); older than a week falls back to the date. */
function relativeTime(iso) {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  return formatDate(iso);
}

/**
 * "Edited by <Display Name> · <relative time>" tag, or "Not synced yet" for
 * pending local edits; null in standalone mode (no server, no editor ids).
 */
function editedTag(record) {
  if (!record) return null;
  if (record.pendingSync) {
    return h('span', { class: 'edited-tag is-pending', title: 'Waiting to sync to the server' }, 'Not synced yet');
  }
  if (!teamUser || !record.updatedAt || !record.updatedBy) return null;
  const who = userDisplayName(record.updatedBy) || 'a teammate';
  const when = relativeTime(record.updatedAt);
  const absolute = formatSyncTime(record.updatedAt);
  return h(
    'span',
    { class: 'edited-tag', title: absolute || when },
    `Edited by ${who}${when ? ` · ${when}` : ''}`,
  );
}

/** Local calendar date (YYYY-MM-DD) of an ISO timestamp; slicing the UTC string is a day ahead in the evening. */
function localDateOf(isoTimestamp) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return String(isoTimestamp).slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Created by <name> · <date>" for detail views (SPEC-v2.md 9.2). */
function createdTag(record) {
  if (!teamUser || !record || !record.createdAt || !record.createdBy) return null;
  const who = userDisplayName(record.createdBy) || 'a teammate';
  return h(
    'span',
    { class: 'edited-tag', title: `Created ${formatSyncTime(record.createdAt)}` },
    `Created by ${who} · ${formatDate(localDateOf(record.createdAt))}`,
  );
}

/** Line of edited/created tags under a detail heading. */
function detailMeta(record) {
  if (!record) return null;
  const tags = [editedTag(record), createdTag(record)].filter(Boolean);
  if (tags.length === 0) return null;
  return h('div', { class: 'detail-meta' }, ...tags);
}

/** Plain-text form for the desktop table's Edited by column. */
function editedColumnText(record) {
  if (!record) return '—';
  if (record.pendingSync) return 'Not synced yet';
  if (!teamUser || !record.updatedAt || !record.updatedBy) return '—';
  const who = userDisplayName(record.updatedBy) || 'a teammate';
  return `Edited by ${who} · ${relativeTime(record.updatedAt)}`;
}

function editedByColumn() {
  return {
    key: 'editedBy',
    label: 'Edited by',
    value: editedColumnText,
    cell: (record) => editedTag(record) || editedColumnText(record),
    sortValue: (record) => String(record.updatedAt || ''),
  };
}

/* Service order card row (phone lists, machine history): number, priority
   badge, status, machine, due (SPEC-v3.md section 3 item 7; soPhoneCard does
   the work, this keeps the machine-history call site). */
function jobRow(order) {
  return soPhoneCard(order);
}

function machineRow(machine) {
  const openCount = openJobCount(state.workOrders, machine.id);
  return h(
    'a',
    { class: 'row', href: `#/machines/${encodeURIComponent(machine.id)}` },
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, machine.name),
      h(
        'div',
        { class: 'row-sub' },
        machineTypeBadge(machine),
        machine.location ? h('span', {}, machine.location) : null,
        editedTag(machine),
      ),
    ),
    h(
      'div',
      { class: 'row-side' },
      statusPill(machine.status, LABELS.machineStatus),
      h('span', {}, openCount === 1 ? '1 open service order' : `${openCount} open service orders`),
    ),
    h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'),
  );
}

function searchBox(placeholder, onInput, autofocus = false) {
  const input = h('input', {
    type: 'search',
    placeholder,
    autocomplete: 'off',
    'aria-label': placeholder,
  });
  input.id = `search-${++fieldCounter}`;
  if (autofocus) {
    input.autofocus = true;
    requestAnimationFrame(() => input.focus());
  }
  input.addEventListener('input', () => onInput(input.value));
  return h(
    'div',
    { class: 'search-wrap' },
    h('span', { class: 'search-icon', 'aria-hidden': 'true' }, '⌕'),
    h('label', { class: 'sr-only', for: input.id }, placeholder),
    input,
  );
}

/* ---------- Desktop sortable tables (SPEC 13.1 item 2, >= 1024px) ---------- */

const tableSort = {
  jobs: { key: null, dir: 'asc' },
  machines: { key: null, dir: 'asc' },
  parts: { key: null, dir: 'asc' },
  requests: { key: null, dir: 'asc' },
  pm: { key: null, dir: 'asc' },
  coworkers: { key: null, dir: 'asc' },
  contractors: { key: null, dir: 'asc' },
};

function toggleTableSort(pageKey, columnKey) {
  const sortState = tableSort[pageKey];
  if (sortState.key === columnKey) {
    sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    sortState.key = columnKey;
    sortState.dir = 'asc';
  }
}

function tableCellContent(column, row) {
  if (column.cell) return column.cell(row);
  const value = column.value(row);
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function dataTableRow(columns, row, href) {
  return h(
    'tr',
    {
      class: 'data-row',
      tabindex: 0,
      onclick: () => navigate(href),
      onkeydown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          navigate(href);
        }
      },
    },
    ...columns.map((column) => h('td', { 'data-col': column.key }, tableCellContent(column, row))),
  );
}

function buildDataTable(pageKey, columns, rows, hrefForRow, onResort) {
  const sortState = tableSort[pageKey];
  const activeColumn = sortState.key ? columns.find((column) => column.key === sortState.key) : null;
  const sortedRows = activeColumn
    ? sortRows(rows, activeColumn.sortValue || activeColumn.value, sortState.dir)
    : rows;
  return h(
    'table',
    { class: 'data-table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ...columns.map((column) => {
          const isActive = Boolean(activeColumn) && activeColumn.key === column.key;
          return h(
            'th',
            {
              scope: 'col',
              'data-col': column.key,
              ...(isActive ? { 'aria-sort': sortState.dir === 'asc' ? 'ascending' : 'descending' } : {}),
            },
            h(
              'button',
              {
                type: 'button',
                class: 'th-sort',
                onclick: () => {
                  toggleTableSort(pageKey, column.key);
                  onResort();
                },
              },
              column.label,
              isActive
                ? h('span', { class: 'sort-arrow', 'aria-hidden': 'true' }, sortState.dir === 'asc' ? '↑' : '↓')
                : null,
            ),
          );
        }),
      ),
    ),
    h(
      'tbody',
      {},
      ...sortedRows.map((row) => dataTableRow(columns, row, hrefForRow(row))),
    ),
  );
}

function jobsTableColumns() {
  const today = todayISO();
  return [
    {
      key: 'number',
      label: 'Number',
      value: (order) => formatOrderNumber(order.number),
      sortValue: (order) => {
        const value = Number(order.number);
        return Number.isFinite(value) ? Math.floor(value) : null;
      },
      cell: (order) => h('span', { class: 'so-number' }, formatOrderNumber(order.number)),
    },
    {
      key: 'status',
      label: 'Status',
      value: (order) => LABELS.status[order.status] || order.status,
      cell: (order) => statusPill(order.status, LABELS.status),
    },
    { key: 'title', label: 'Title', value: (order) => order.title },
    {
      key: 'priority',
      label: 'Priority',
      value: (order) => LABELS.priority[order.priority] || order.priority,
      cell: (order) => priorityBadge(order.priority),
      sortValue: (order) => PRIORITIES.indexOf(priorityValue(order.priority)),
    },
    { key: 'machine', label: 'Machine', value: (order) => machineName(order.machineId) },
    {
      key: 'category',
      label: 'Category',
      value: (order) => (order.category ? LABELS.category[order.category] || order.category : '—'),
    },
    {
      key: 'assignedTo',
      label: 'Assigned to',
      value: (order) => {
        const names = (order.assignees || []).filter(Boolean).map((entry) => personName(entry));
        return names.length > 0 ? names.join(', ') : 'Unassigned';
      },
      cell: (order) =>
        (order.assignees || []).filter(Boolean).length === 0
          ? h('span', { class: 'muted' }, 'Unassigned')
          : assigneeAvatars(order.assignees),
      sortValue: (order) => {
        const names = (order.assignees || []).filter(Boolean).map((entry) => personName(entry));
        return names.length > 0 ? names.join(', ') : '';
      },
    },
    {
      key: 'due',
      label: 'Due',
      value: (order) => orderDueParts(order, today).text,
      sortValue: (order) => (order.dueDate ? String(order.dueDate) : ''),
      cell: (order) => {
        const due = orderDueParts(order, today);
        return due.text
          ? [h('span', { class: due.overdue ? 'text-overdue' : '' }, due.text)]
          : h('span', { class: 'muted' }, '—');
      },
    },
    {
      key: 'age',
      label: 'Age (days)',
      value: (order) => String(workOrderAgeDays(order, today)),
      sortValue: (order) => workOrderAgeDays(order, today),
    },
    {
      key: 'labour',
      label: 'Labour h',
      value: (order) => formatHours(labourTotal(order)),
      sortValue: (order) => labourTotal(order),
    },
    editedByColumn(),
  ];
}

function nextPMDueISO(machine) {
  const dates = state.pmTasks
    .filter((task) => task.machineId === machine.id && task.active !== false)
    .map((task) => pmDueDate(task))
    .filter(Boolean)
    .sort();
  return dates[0] || '';
}

function machinesTableColumns() {
  return [
    { key: 'name', label: 'Name', value: (machine) => machine.name },
    {
      key: 'type',
      label: 'Type',
      value: (machine) => machineTypeLabel(machine),
      cell: (machine) => machineTypeBadge(machine),
    },
    { key: 'location', label: 'Location', value: (machine) => machine.location },
    {
      key: 'status',
      label: 'Status',
      value: (machine) => LABELS.machineStatus[machine.status] || machine.status,
      cell: (machine) => statusPill(machine.status, LABELS.machineStatus),
    },
    {
      key: 'openJobs',
      label: 'Open orders',
      value: (machine) => String(openJobCount(state.workOrders, machine.id)),
      sortValue: (machine) => openJobCount(state.workOrders, machine.id),
    },
    {
      key: 'nextPM',
      label: 'Next PM due',
      value: (machine) => {
        const due = nextPMDueISO(machine);
        return due ? formatDate(due) : '—';
      },
      sortValue: (machine) => nextPMDueISO(machine),
    },
    editedByColumn(),
  ];
}

function partsTableColumns() {
  return [
    { key: 'name', label: 'Name', value: (part) => part.name },
    { key: 'partNumber', label: 'Part #', value: (part) => part.partNumber },
    {
      key: 'qty',
      label: 'Qty',
      value: (part) => `${toInteger(part.qtyOnHand)} ${part.unit || 'pcs'}`,
      sortValue: (part) => toInteger(part.qtyOnHand),
      cell: (part) => {
        const qty = h('span', {}, `${toInteger(part.qtyOnHand)} ${part.unit || 'pcs'}`);
        return isLowStock(part) ? [qty, h('span', { class: 'pill status-low' }, 'Low')] : qty;
      },
    },
    {
      key: 'min',
      label: 'Min',
      value: (part) => `${toInteger(part.minQty)} ${part.unit || 'pcs'}`,
      sortValue: (part) => toInteger(part.minQty),
    },
    { key: 'location', label: 'Location', value: (part) => part.location },
    { key: 'supplier', label: 'Supplier', value: (part) => part.supplier },
    editedByColumn(),
    // v4 (SPEC-v4.md 3.3): row action, only for roles that may write requests.
    can('purchasing', 'write')
      ? {
          key: 'request',
          label: 'Request',
          value: () => '',
          cell: (part) => addToRequestButton(part),
        }
      : null,
  ].filter(Boolean);
}

/* ---------- Service order filters (SPEC-v3.md section 3 item 2) ----------
   Filter state is kept per device in localStorage ("Clear all" returns to
   the default: status not Done). The panel/sheet builders below return the
   same controls for the desktop popover and the phone bottom sheet. */

const SO_FILTERS_KEY = 'maint-log:so-filters';
const SO_VIEW_KEY = 'maint-log:so-view';
const SO_PAGE_SIZE_KEY = 'maint-log:so-page-size';

const SO_STATUS_OPTIONS = ['not-done', ...WORK_ORDER_STATUSES];
const SO_STATUS_LABELS = { ...LABELS.status, 'not-done': 'Not done' };
const SO_DUE_LABELS = {
  overdue: 'Overdue',
  'this-week': 'Due this week',
  none: 'No due date',
};
const SO_KIND_LABELS = {
  ...LABELS.kind,
  pm: 'PM',
};
const SO_CREATED_MAX = '2100-01-01';

/** Fresh set of the default filters (never a shared object). */
function initialSOFilters() {
  return normalizeSOFilters(defaultServiceOrderFilters());
}

/** Keep only known filter keys with well-formed values. */
function normalizeSOFilters(raw) {
  const filters = raw && typeof raw === 'object' ? raw : {};
  const list = (value, allowed) =>
    Array.isArray(value)
      ? value.map((item) => String(item)).filter((item) => allowed.includes(item))
      : [];
  const single = (value, allowed) => {
    const text = typeof value === 'string' ? value : '';
    return text && allowed.includes(text) ? text : '';
  };
  const dateOrEmpty = (value) => (isISODate(value) ? value : '');
  const assignee = filters.assignee;
  return {
    status: list(filters.status, SO_STATUS_OPTIONS),
    priority: list(filters.priority, PRIORITIES),
    category: single(filters.category, WORK_ORDER_CATEGORIES),
    machineType: typeof filters.machineType === 'string' ? filters.machineType : '',
    machineId: typeof filters.machineId === 'string' ? filters.machineId : '',
    assignee:
      assignee && typeof assignee === 'object' && typeof assignee.kind === 'string'
        ? { kind: assignee.kind, id: String(assignee.id || '') }
        : null,
    kind: list(filters.kind, WORK_ORDER_KINDS),
    due: list(filters.due, SO_DUE_FILTERS),
    createdFrom: dateOrEmpty(filters.createdFrom),
    createdTo: dateOrEmpty(filters.createdTo),
  };
}

/** Load the per-device filter state; absent/corrupt storage falls back. */
function loadSOFilters() {
  const raw = storageGet(SO_FILTERS_KEY);
  if (!raw) return initialSOFilters();
  try {
    return normalizeSOFilters(JSON.parse(raw));
  } catch (error) {
    console.warn('Ignoring invalid saved service order filters:', error);
    return initialSOFilters();
  }
}

function saveSOFilters(filters) {
  try {
    storageSet(SO_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // Storage can be unavailable in private browsing; filters still apply.
  }
}

/** True when the saved filters equal the default set (status not done only). */
function isDefaultSOFilters(filters) {
  return JSON.stringify(filters) === JSON.stringify(initialSOFilters());
}

/** Chips for the active filters ("removable", SPEC-v3.md section 3 item 2). */
function soFilterChips(filters, machines = []) {
  const chips = [];
  const push = (key, value, label) => chips.push({ key, value, label });
  for (const value of filters.status) push('status', value, SO_STATUS_LABELS[value] || value);
  for (const value of filters.priority) push('priority', value, LABELS.priority[value] || value);
  for (const value of filters.kind) push('kind', value, SO_KIND_LABELS[value] || value);
  for (const value of filters.due) push('due', value, SO_DUE_LABELS[value] || value);
  if (filters.category) push('category', filters.category, LABELS.category[filters.category] || filters.category);
  if (filters.machineType) {
    const machine = machines.find((item) => {
      const label = item.type === 'other' ? item.typeLabel : item.type;
      return label === filters.machineType || item.type === filters.machineType;
    });
    push(
      'machineType',
      filters.machineType,
      (machine && machineTypeLabel(machine)) || filters.machineType,
    );
  }
  if (filters.machineId) {
    const machine = machines.find((item) => item.id === filters.machineId);
    push('machine', filters.machineId, machine ? machine.name : 'Unknown machine');
  }
  if (filters.assignee) {
    const name = personName(filters.assignee) || 'Unknown';
    const kind =
      filters.assignee.kind === 'coworker'
        ? 'Coworker'
        : filters.assignee.kind === 'contractor'
          ? 'Contractor'
          : 'User';
    push('assignee', filters.assignee, `${name} · ${kind}`);
  }
  if (filters.createdFrom || filters.createdTo) {
    const from = filters.createdFrom || '…';
    const to = filters.createdTo || '…';
    push('created', `${from}…${to}`, `Created ${from} → ${to}`);
  }
  return chips;
}

/** Machine type options for the filter select: built-ins in use + customs. */
function soMachineTypeOptions(machines = []) {
  const options = [];
  const seen = new Set();
  for (const machine of machines) {
    const label = machine.type === 'other' ? machine.typeLabel : machine.type;
    if (!label || seen.has(label)) continue;
    seen.add(label);
    options.push(label);
  }
  return options.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/* The current view keeps its own refresh hook so applying filters or moving
   a card does not wipe other page state (search text, board scroll). */
let soRefresh = null;

function removeSOFilterValue(filters, key, value) {
  const next = { ...filters };
  if (Array.isArray(next[key])) {
    next[key] = next[key].filter((item) => item !== value);
  } else if (key === 'assignee') {
    next.assignee = null;
  } else if (key === 'created') {
    next.createdFrom = '';
    next.createdTo = '';
  } else {
    next[key] = '';
  }
  saveSOFilters(next);
  return next;
}

/* ----- Desktop filter popover + phone filter bottom sheet ----- */

let soFilterHost = null;
let soFilterRouteCleanup = null;

function closeSOFiltersPanel() {
  if (!soFilterHost) return;
  const host = soFilterHost;
  soFilterHost = null;
  document.removeEventListener('keydown', onSOFilterKey);
  if (soFilterRouteCleanup) {
    window.removeEventListener('hashchange', soFilterRouteCleanup);
    soFilterRouteCleanup = null;
  }
  host.remove();
  if (soFiltersPreviousFocus && document.contains(soFiltersPreviousFocus)) {
    soFiltersPreviousFocus.focus();
  }
}

let soFiltersPreviousFocus = null;

function onSOFilterKey(event) {
  if (!soFilterHost) return;
  if (event.key === 'Escape') {
    if (dialogRoot.childElementCount > 0) return;
    event.preventDefault();
    closeSOFiltersPanel();
  } else if (event.key === 'Tab') {
    const sheet = soFilterHost.querySelector('.filter-sheet');
    if (sheet) trapTabKey(sheet, event);
  }
}

/** Toggle-chip group for multi-select filters (status, priority, kind, due). */
function soToggleGroup({ legend, values, active, onToggle }) {
  return h(
    'fieldset',
    { class: 'filter-group' },
    h('legend', {}, legend),
    h(
      'div',
      { class: 'chips filter-chips', role: 'group', 'aria-label': legend },
      ...values.map((value) => {
        const pressed = active.includes(value);
        return h(
          'button',
          {
            type: 'button',
            class: `chip chip-toggle${pressed ? ' is-active' : ''}`,
            'aria-pressed': pressed ? 'true' : 'false',
            onclick: () => onToggle(value),
          },
          pressed ? h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓ ') : null,
          value === 'not-done' ? 'Not done' : SO_STATUS_LABELS[value] || LABELS.priority[value] || SO_KIND_LABELS[value] || SO_DUE_LABELS[value] || value,
        );
      }),
    ),
  );
}

/** The filter controls shared by the popover and the bottom sheet. */
function buildSOFilterControls(working, { machines = [] } = {}) {
  const toggle = (key) => (value) => {
    const values = working[key].includes(value)
      ? working[key].filter((item) => item !== value)
      : [...working[key], value];
    working[key] = values;
    rebuild();
  };

  let controlsHost = null;
  const rebuild = () => {
    if (!controlsHost) return;
    controlsHost.replaceChildren(...buildControls());
  };

  const categorySelect = h('select', {}, (() => {
    const nodes = [h('option', { value: '' }, 'Any category')];
    for (const value of WORK_ORDER_CATEGORIES) {
      const option = h('option', { value }, LABELS.category[value]);
      if (value === working.category) option.selected = true;
      nodes.push(option);
    }
    return nodes;
  })());
  const machineTypeSelect = h(
    'select',
    {},
    ...(() => {
      const nodes = [];
      const typeOptions = soMachineTypeOptions(machines);
      if (working.machineType && !typeOptions.includes(working.machineType)) {
        typeOptions.push(working.machineType);
      }
      nodes.push(h('option', { value: '' }, 'Any type'));
      for (const label of typeOptions) {
        const option = h('option', { value: label }, label);
        if (label === working.machineType) option.selected = true;
        nodes.push(option);
      }
      return nodes;
    })(),
  );
  const machineSelect = h('select', {}, (() => {
    const nodes = [h('option', { value: '' }, 'Any machine')];
    for (const machine of machines) {
      const option = h('option', { value: machine.id }, machine.name);
      if (machine.id === working.machineId) option.selected = true;
      nodes.push(option);
    }
    return nodes;
  })());
  const assigneeSelect = h('select', {}, (() => {
    const nodes = [h('option', { value: '' }, 'Anyone')];
    const people = assignablePeople();
    for (const person of people) {
      const value = `${person.kind}:${person.id}`;
      const option = h('option', { value }, `${person.name} · ${person.sub}`);
      const current = working.assignee ? `${working.assignee.kind}:${working.assignee.id}` : '';
      if (value === current) option.selected = true;
      nodes.push(option);
    }
    return nodes;
  })());
  const createdFromInput = h('input', { type: 'date', value: working.createdFrom, max: SO_CREATED_MAX });
  const createdToInput = h('input', { type: 'date', value: working.createdTo, max: SO_CREATED_MAX });

  categorySelect.addEventListener('change', () => {
    working.category = categorySelect.value;
  });
  machineTypeSelect.addEventListener('change', () => {
    working.machineType = machineTypeSelect.value;
  });
  machineSelect.addEventListener('change', () => {
    working.machineId = machineSelect.value;
  });
  assigneeSelect.addEventListener('change', () => {
    const raw = assigneeSelect.value;
    working.assignee = raw ? { kind: raw.split(':')[0], id: raw.split(':')[1] } : null;
  });
  createdFromInput.addEventListener('change', () => {
    working.createdFrom = createdFromInput.value || '';
  });
  createdToInput.addEventListener('change', () => {
    working.createdTo = createdToInput.value || '';
  });

  const applyButton = h('button', { class: 'btn btn-primary btn-small', type: 'button' }, 'Apply');
  const resetButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Reset');
  const peopleEmpty = assignablePeople().length === 0;

  function buildControls() {
    return [
      soToggleGroup({ legend: 'Status', values: SO_STATUS_OPTIONS, active: working.status, onToggle: toggle('status') }),
      soToggleGroup({ legend: 'Priority', values: PRIORITIES, active: working.priority, onToggle: toggle('priority') }),
      soToggleGroup({ legend: 'Kind', values: WORK_ORDER_KINDS, active: working.kind, onToggle: toggle('kind') }),
      soToggleGroup({ legend: 'Due', values: SO_DUE_FILTERS, active: working.due, onToggle: toggle('due') }),
      h(
        'div',
        { class: 'grid-2 filter-selects' },
        field('Category', categorySelect),
        field('Machine type', machineTypeSelect),
        field('Machine', machineSelect),
        field('Assignee', assigneeSelect),
      ),
      h(
        'div',
        { class: 'grid-2 filter-selects' },
        field('Created from', createdFromInput),
        field('Created to', createdToInput),
      ),
      h(
        'div',
        { class: 'form-actions filter-actions' },
        resetButton,
        applyButton,
      ),
      peopleEmpty
        ? h('p', { class: 'field-hint' }, 'No coworkers yet - add them in People.')
        : null,
    ];
  }

  applyButton.addEventListener('click', () => {
    saveSOFilters(normalizeSOFilters(working));
    closeSOFiltersPanel();
    if (typeof soRefresh === 'function') soRefresh();
  });
  resetButton.addEventListener('click', () => {
    Object.assign(working, initialSOFilters());
    categorySelect.value = '';
    machineTypeSelect.value = '';
    machineSelect.value = '';
    assigneeSelect.value = '';
    createdFromInput.value = '';
    createdToInput.value = '';
    rebuild();
  });

  const fragment = document.createDocumentFragment();
  controlsHost = h('div', { class: 'filter-controls' }, ...buildControls());
  fragment.append(controlsHost);
  return fragment;
}

/* Open the filter controls: a popover on desktop, a bottom sheet on phone. */
function openSOFiltersPanel() {
  if (soFilterHost) {
    closeSOFiltersPanel();
    return;
  }
  closeUserMenu();
  soFiltersPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const working = loadSOFilters();
  const machines = state.machines;
  let host;
  if (phoneMedia.matches) {
    // Phone: a bottom sheet with the same filters (SPEC-v3.md 3.7).
    const backdrop = h('div', { class: 'sheet-backdrop' });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeSOFiltersPanel();
    });
    const sheetHost = h(
      'section',
      { class: 'sheet filter-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Filter service orders' },
      h('div', { class: 'filter-sheet-grip', 'aria-hidden': 'true' }),
      h('h2', { class: 'sheet-title' }, 'Filters'),
      buildSOFilterControls(working, { machines }),
    );
    soFilterHost = h('div', { class: 'filter-host-wrap' }, backdrop, sheetHost);
    document.body.append(soFilterHost);
    host = sheetHost;
  } else {
    // Desktop: a popover panel anchored under the Filters button.
    const anchor = document.getElementById('so-filters-button');
    host = h(
      'div',
      { class: 'filter-popover', role: 'dialog', 'aria-label': 'Filter service orders' },
      h('h2', { class: 'filter-popover-title' }, 'Filters'),
      buildSOFilterControls(working, { machines }),
    );
    soFilterHost = host;
    document.body.append(host);
    const rect = anchor ? anchor.getBoundingClientRect() : { right: 16, bottom: 80 };
    const viewportWidth = document.documentElement.clientWidth;
    host.style.top = `${Math.round(rect.bottom + 8)}px`;
    host.style.right = `${Math.max(8, Math.round(viewportWidth - rect.right))}px`;
  }
  document.addEventListener('keydown', onSOFilterKey);
  // Leaving the page closes the panel (the chosen route renders fresh).
  soFilterRouteCleanup = () => closeSOFiltersPanel();
  window.addEventListener('hashchange', soFilterRouteCleanup, { once: true });
  const focusables = focusableElements(host);
  if (focusables.length > 0) focusables[0].focus();
}
/* ---------- Service orders: list, board and calendar (SPEC-v3.md §3) ---------- */

const SO_VIEWS = ['list', 'board', 'calendar'];
const SO_VIEW_LABELS = { list: 'List', board: 'Board', calendar: 'Calendar' };
const SO_PAGE_SIZES = [25, 50, 100];

/** Change a service order's status through the normal save path
    (persistWorkOrderSave). Shared by the detail buttons, the board's drag
    and drop and each card's "Move to…" menu (SPEC-v3.md 3.4). */
async function changeOrderStatus(order, status) {
  if (!order || status === order.status) return null;
  const wasDone = order.status === 'done';
  const result = await persistWorkOrderSave(order, { ...order, status }, {});
  if (shouldOfferMachineDown(result.order)) {
    const machine = machineById(result.order.machineId);
    if (machine && machine.status === 'running') {
      const yes = await showConfirm({
        title: 'Set machine to Down?',
        message: `${machine.name} is still on an open breakdown.`,
        confirmText: 'Set Down',
        cancelText: 'Leave Running',
      });
      if (yes) {
        await sync.saveRecord(
          'machines',
          { ...machine, status: 'down', updatedAt: nowISO() },
          machine.version,
        );
        await refreshState();
      }
    }
  }
  await maybeOfferRunning(result.order, wasDone);
  toast(`Status changed to ${LABELS.status[status]}.`);
  return result.order;
}

function currentSOView() {
  const stored = storageGet(SO_VIEW_KEY);
  return SO_VIEWS.includes(stored) ? stored : 'list';
}

function loadSOPageSize() {
  const stored = Number(storageGet(SO_PAGE_SIZE_KEY));
  return SO_PAGE_SIZES.includes(stored) ? stored : 25;
}

/**
 * Deep links from Home keep their meaning: `waiting`, a concrete status or
 * `all` become a one-off filter set for this render (not saved per device).
 */
function soRouteFilters(value) {
  if (value === 'waiting') {
    return normalizeSOFilters({ status: ['waiting-parts', 'waiting-tech'] });
  }
  if (WORK_ORDER_STATUSES.includes(value)) {
    return normalizeSOFilters({ status: [value] });
  }
  if (value === 'all') {
    return normalizeSOFilters({});
  }
  return null;
}

/** Due date label, red ("overdue") styling via the caller (SPEC-v3.md 3.3). */
function orderDueParts(order, today = todayISO()) {
  if (!order || !order.dueDate) {
    return { text: 'No due date', overdue: false, sort: '' };
  }
  return {
    text: `Due ${formatDate(order.dueDate)}`,
    overdue: serviceOrderDueState(order, today) === 'overdue',
    sort: String(order.dueDate),
  };
}

function soPhoneCard(order) {
  const today = todayISO();
  const due = orderDueParts(order, today);
  return h(
    'a',
    { class: 'row so-card', href: `#/jobs/${encodeURIComponent(order.id)}` },
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, order.title),
      h(
        'div',
        { class: 'row-sub' },
        h('span', { class: 'so-number' }, formatOrderNumber(order.number)),
        ` · ${machineName(order.machineId)}`,
        due.text
          ? h(
              'span',
              { class: due.overdue ? 'due-overdue' : 'due-soon-none' },
              ` · ${due.text}`,
            )
          : null,
      ),
      editedTag(order),
    ),
    h(
      'div',
      { class: 'row-side' },
      statusPill(order.status, LABELS.status),
      priorityBadge(order.priority),
    ),
    h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'),
  );
}

/** Page-head action or the "View only" badge for read-only areas (SPEC-v3.md 13.3). */
function headActionFor(area, node = null) {
  if (can(area, 'write')) return node;
  return isReadOnly(area) ? viewOnlyBadge() : null;
}

function renderJobs(route) {
  setTitle('Service Orders');
  const desktop = desktopMedia.matches;
  let currentView = desktop ? currentSOView() : 'list';
  let pageSize = loadSOPageSize();
  let pageIndex = 0;
  let searchQuery = '';
  /* Deep links from Home become the saved filter state for this device;
     chips/panel/Clear all then operate on that saved state. */
  const routeFilters = soRouteFilters(route.params.get('filter') || route.params.get('status'));
  if (routeFilters) saveSOFilters(routeFilters);
  let filters = loadSOFilters();

  const tableHost = h('div', { class: 'table-wrap' });
  const chipsHost = h('div', { class: 'so-chips-host' });
  const bodyHost = h('div', { class: `so-body so-body-${currentView}` });

  function applyFilters(next) {
    saveSOFilters(normalizeSOFilters(next));
    pageIndex = 0;
    build();
  }

  /* The board assigns columns by status, so the status filter does not hide
     cards there (the Done column itself means "finished last 7 days"). */
  function filteredOrders({ ignoreStatus = false } = {}) {
    const effective = ignoreStatus ? { ...filters, status: [] } : filters;
    let orders = filterServiceOrders(state.workOrders, effective, {
      machines: state.machines,
      today: todayISO(),
    });
    if (searchQuery.trim()) orders = searchWorkOrders(orders, searchQuery, state.machines);
    return sortWorkOrdersNewest(orders);
  }

  /* Removable chips above the table + "Clear all" back to the default
     (status not Done, SPEC-v3.md section 3 item 2). */
  function soChipsRow() {
    const chips = soFilterChips(filters, state.machines);
    if (chips.length === 0) return [];
    const renderChip = (chip) =>
      h(
        'span',
        { class: 'filter-chip' },
        h('span', { class: 'filter-chip-label' }, chip.label),
        h(
          'button',
          {
            class: 'filter-chip-x',
            type: 'button',
            'aria-label': `Remove filter: ${chip.label}`,
            onclick: () => {
              // removeSOFilterValue persists the change; build reloads it.
              removeSOFilterValue(filters, chip.key, chip.value);
              pageIndex = 0;
              build();
            },
          },
          '×',
        ),
      );
    const clearAll = h(
      'button',
      {
        class: 'clear-all',
        type: 'button',
        onclick: () => applyFilters(initialSOFilters()),
      },
      'Clear all',
    );
    return [
      h(
        'div',
        { class: 'so-chips', role: 'group', 'aria-label': 'Active service order filters' },
        ...chips.map(renderChip),
        clearAll,
      ),
    ];
  }

  /* View switch — desktop only (SPEC-v3.md section 3 item 1). */
  const viewSwitch = h(
    'div',
    { class: 'view-switch', role: 'group', 'aria-label': 'Service orders view' },
    ...SO_VIEWS.map((value) =>
      h(
        'button',
        {
          class: `view-switch-btn${value === currentView ? ' is-active' : ''}`,
          type: 'button',
          'aria-pressed': value === currentView ? 'true' : 'false',
          onclick: () => {
            currentView = value;
            saveSOView(value);
            pageIndex = 0;
            build();
          },
        },
        SO_VIEW_LABELS[value],
      ),
    ),
  );

  const filtersButton = h(
    'button',
    { class: 'btn btn-small', type: 'button', id: 'so-filters-button', onclick: () => openSOFiltersPanel() },
    'Filters',
  );

  function pagerBar(totalRows) {
    if (!desktop || totalRows === 0) return null;
    const from = pageIndex * pageSize + 1;
    const to = Math.min(totalRows, (pageIndex + 1) * pageSize);
    const prev = h(
      'button',
      { class: 'btn btn-small', type: 'button', disabled: pageIndex === 0 },
      '← Prev',
    );
    const next = h(
      'button',
      { class: 'btn btn-small', type: 'button', disabled: to >= totalRows },
      'Next →',
    );
    prev.addEventListener('click', () => {
      pageIndex = Math.max(0, pageIndex - 1);
      build();
    });
    next.addEventListener('click', () => {
      pageIndex = Math.min(Math.ceil(totalRows / pageSize) - 1, pageIndex + 1);
      build();
    });
    const sizeSelect = h(
      'select',
      { 'aria-label': 'Rows per page' },
      ...SO_PAGE_SIZES.map((size) => {
        const option = h('option', { value: String(size) }, `${size} rows`);
        if (size === pageSize) option.selected = true;
        return option;
      }),
    );
    sizeSelect.addEventListener('change', () => {
      pageSize = Number(sizeSelect.value) || 25;
      storageSet(SO_PAGE_SIZE_KEY, String(pageSize));
      pageIndex = 0;
      build();
    });
    return h(
      'div',
      { class: 'pager' },
      h(
        'span',
        { class: 'pager-status' },
        `${from}–${to} of ${totalRows}`,
      ),
      prev,
      next,
      sizeSelect,
    );
  }

  function soListBody(orders) {
    if (desktop) {
      // Sort the full filtered set, then show the current page
      // (buildDataTable re-sorts its page deterministically).
      const columns = jobsTableColumns();
      const sortState = tableSort.jobs;
      const activeColumn = sortState.key ? columns.find((column) => column.key === sortState.key) : null;
      const sortedRows = activeColumn
        ? sortRows(orders, activeColumn.sortValue || activeColumn.value, sortState.dir)
        : orders;
      const slice = sortedRows.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize);
      tableHost.replaceChildren(
        buildDataTable(
          'jobs',
          columns,
          slice,
          (order) => `#/jobs/${encodeURIComponent(order.id)}`,
          () => {
            pageIndex = 0;
            build();
          },
        ),
      );
      return [tableHost, pagerBar(orders.length)];
    }
    if (orders.length === 0) {
      return [
        emptyState(
          searchQuery.trim() ? 'No matching service orders' : 'No service orders here',
          searchQuery.trim()
            ? 'Try a different search or clear filters.'
            : 'Log a repair to keep track of what is open.',
          can('serviceOrders', 'write') &&
            (filters.status.length === 0 || filters.status.includes('not-done'))
            ? [h('a', { class: 'btn btn-primary', href: '#/jobs/new' }, '+ Service order')]
            : [],
        ),
      ];
    }
    return [h('div', { class: 'list cards-only' }, ...orders.map(soPhoneCard))];
  }

  function build() {
    soRefresh = build;
    filters = loadSOFilters();
    const orders = filteredOrders({ ignoreStatus: currentView === 'board' });
    chipsHost.replaceChildren(...soChipsRow());
    viewSwitch.querySelectorAll('.view-switch-btn').forEach((button) => {
      const active = button.textContent === SO_VIEW_LABELS[currentView];
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    bodyHost.className = `so-body so-body-${currentView}`;
    if (currentView === 'board' && desktop) {
      bodyHost.replaceChildren(soBoardBody(orders));
    } else if (currentView === 'calendar' && desktop) {
      bodyHost.replaceChildren(soCalendarBody(filteredOrders()));
    } else {
      bodyHost.replaceChildren(...soListBody(orders).flat());
    }
  }

  const searchInput = searchBox('Search service orders', (value) => {
    searchQuery = value;
    pageIndex = 0;
    build();
  });

  const toolbar = h(
    'div',
    { class: 'so-toolbar' },
    h('div', { class: 'so-toolbar-search' }, searchInput),
    viewSwitch,
    filtersButton,
  );

  build();
  return page(
    pageHead(
      'Service Orders',
      headActionFor('serviceOrders', h('a', { class: 'btn btn-primary btn-small', href: '#/jobs/new' }, '+ Service order')),
    ),
    toolbar,
    chipsHost,
    bodyHost,
  );
}

function saveSOView(view) {
  storageSet(SO_VIEW_KEY, view);
}

/* ----- Board view (SPEC-v3.md 3.4): one column per status; cards move by
   drag and drop or the "Move to…" menu (keyboard/touch alternative). ----- */

const SO_DONE_DAYS = 7;

let soMoveMenu = null;
let soMoveRouteCleanup = null;

function onSOMoveMenuKey(event) {
  if (!soMoveMenu) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSOMoveMenu();
  }
}

function closeSOMoveMenu() {
  if (!soMoveMenu) return;
  const menu = soMoveMenu;
  soMoveMenu = null;
  document.removeEventListener('keydown', onSOMoveMenuKey);
  if (soMoveRouteCleanup) {
    window.removeEventListener('hashchange', soMoveRouteCleanup);
    soMoveRouteCleanup = null;
  }
  menu.remove();
}

function openSOMoveMenu(button, order) {
  if (soMoveMenu) {
    closeSOMoveMenu();
    return;
  }
  const menu = h(
    'div',
    { class: 'move-menu', role: 'menu', 'aria-label': `Move ${formatOrderNumber(order.number)} to another status` },
    ...WORK_ORDER_STATUSES.map((status) =>
      h(
        'button',
        {
          class: `move-menu-item${status === order.status ? ' is-current' : ''}`,
          type: 'button',
          role: 'menuitem',
          disabled: status === order.status,
          onclick: () => {
            closeSOMoveMenu();
            moveBoardOrder(order, status);
          },
        },
        LABELS.status[status],
      ),
    ),
  );
  soMoveMenu = menu;
  document.body.append(menu);
  const rect = button.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  menu.style.top = `${Math.round(rect.bottom + 6)}px`;
  menu.style.right = `${Math.max(8, Math.round(viewportWidth - rect.right))}px`;
  document.addEventListener('keydown', onSOMoveMenuKey);
  // Leaving the page closes the menu (like the drawer and filter panel).
  soMoveRouteCleanup = () => closeSOMoveMenu();
  window.addEventListener('hashchange', soMoveRouteCleanup, { once: true });
  const onDocClick = (event) => {
    if (soMoveMenu !== menu) {
      document.removeEventListener('click', onDocClick);
      return;
    }
    if (menu.contains(event.target) || button.contains(event.target)) return;
    document.removeEventListener('click', onDocClick);
    closeSOMoveMenu();
  };
  document.addEventListener('click', onDocClick);
  const focusables = focusableElements(menu);
  if (focusables.length > 0) focusables[0].focus();
  else menu.focus();
}

/** Status change from the board: normal save path, then rebuild the view. */
async function moveBoardOrder(order, status) {
  try {
    await changeOrderStatus(order, status);
  } catch (error) {
    console.error('Could not move the service order:', error);
    toast('Could not save the status change. Please try again.', 'warn');
    return;
  }
  if (typeof soRefresh === 'function') soRefresh();
}

function soBoardCard(order) {
  const due = orderDueParts(order);
  const detailHref = `#/jobs/${encodeURIComponent(order.id)}`;
  // Moving a card edits the order: Read-only users get no move menu and no
  // drag (SPEC-v3.md 13.3).
  const canMove = can('serviceOrders', 'write');
  const moveButton = h(
    'button',
    {
      class: 'btn btn-ghost btn-small board-move',
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-label': `Move ${formatOrderNumber(order.number)} to another status`,
    },
    'Move to…',
  );
  moveButton.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    openSOMoveMenu(moveButton, order);
  });
  const card = h(
    'article',
    {
      class: `board-card status-${order.status}`,
      draggable: canMove === true || null,
      tabindex: 0,
      'aria-label': `${formatOrderNumber(order.number)} ${order.title}`,
    },
    h(
      'div',
      { class: 'board-card-top' },
      h('a', { class: 'board-card-number', href: detailHref }, formatOrderNumber(order.number)),
      priorityBadge(order.priority),
    ),
    h('a', { class: 'board-card-title', href: detailHref }, order.title),
    h('div', { class: 'board-card-meta' }, machineName(order.machineId)),
    due.text
      ? h(
          'div',
          { class: `board-card-due${due.overdue ? ' is-overdue' : ''}` },
          due.text,
        )
      : null,
    h(
      'div',
      { class: 'board-card-foot' },
      assigneeAvatars(order.assignees || []),
      canMove ? moveButton : null,
    ),
  );
  card.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', order.id);
    event.dataTransfer.effectAllowed = 'move';
    card.classList.add('is-dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('is-dragging');
    document.querySelectorAll('.board-list.is-drop-target').forEach((node) => {
      node.classList.remove('is-drop-target');
    });
  });
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      navigate(detailHref);
    }
  });
  return card;
}

function soBoardColumn(status, orders) {
  const canMove = can('serviceOrders', 'write');
  const list = h(
    'div',
    { class: 'board-list', 'data-status': status },
    ...orders.map((order) => soBoardCard(order)),
  );
  if (canMove) {
    list.addEventListener('dragover', (event) => {
      if (!event.dataTransfer) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('is-drop-target');
    });
    list.addEventListener('dragleave', (event) => {
      if (event.target === list) list.classList.remove('is-drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('is-drop-target');
      const id = event.dataTransfer ? event.dataTransfer.getData('text/plain') : '';
      if (!id) return;
      const order = state.workOrders.find((entry) => entry.id === id);
      if (!order || order.status === status) return;
      await moveBoardOrder(order, status);
    });
  }
  return h(
    'section',
    { class: `board-column status-${status}`, 'aria-label': `${LABELS.status[status]} column` },
    h(
      'header',
      { class: 'board-col-head' },
      h(
        'span',
        { class: 'board-col-title' },
        status === 'done' ? `Done · last ${SO_DONE_DAYS} days` : LABELS.status[status],
      ),
      h('span', { class: 'board-col-count' }, String(orders.length)),
    ),
    list,
  );
}

function soBoardBody(filtered) {
  const today = todayISO();
  const byStatus = (status) =>
    filtered.filter(
      (order) =>
        order.status === status && (status !== 'done' || isRecentDone(order, SO_DONE_DAYS, today)),
    );
  return h(
    'div',
    { class: 'board' },
    ...WORK_ORDER_STATUSES.map((status) => soBoardColumn(status, byStatus(status))),
  );
}

/* ----- Calendar view (SPEC-v3.md 3.5): month grid by due date, at most 3
   items per day then "+N more", prev/next month, click opens the order. ----- */

const CAL_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CAL_MAX_PER_DAY = 3;

/** First grid day (Monday on or before the month's 1st) as an ISO date. */
function calendarStartDay(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (first.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(year, month, 1 - shift));
}

function soCalendarBody(filtered) {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
  let expandedDay = null;
  const host = h('div', { class: 'cal-wrap' });

  function ordersFor(dayISO) {
    return filtered.filter((order) => order.dueDate === dayISO);
  }

  function buildCal() {
    const start = calendarStartDay(year, month);
    const monthTitle = new Date(Date.UTC(year, month, 1)).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    const today = todayISO();
    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const dayISO = new Date(start.getTime() + index * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const inMonth = Number(dayISO.slice(0, 4)) === year && Number(dayISO.slice(5, 7)) === month + 1;
      const dayOrders = ordersFor(dayISO);
      const shown = expandedDay === dayISO ? dayOrders : dayOrders.slice(0, CAL_MAX_PER_DAY);
      const overflow = dayOrders.length - shown.length;
      const isTodayCell = dayISO === today;
      cells.push(
        h(
          'div',
          {
            class: `cal-cell${inMonth ? '' : ' is-out'}${isTodayCell ? ' is-today' : ''}`,
            'data-day': dayISO,
          },
          h('span', { class: 'cal-day' }, String(Number(dayISO.slice(8, 10)))),
          ...shown.map((order) =>
            h(
              'a',
              {
                class: `cal-item status-${order.status}`,
                href: `#/jobs/${encodeURIComponent(order.id)}`,
                title: order.title,
              },
              formatOrderNumber(order.number),
              h('span', { class: 'cal-item-text' }, order.title),
            ),
          ),
          overflow > 0
            ? h(
                'button',
                {
                  class: 'cal-more',
                  type: 'button',
                  'aria-label': `Show ${overflow} more service orders due ${dayISO}`,
                  onclick: () => {
                    expandedDay = expandedDay === dayISO ? null : dayISO;
                    buildCal();
                  },
                },
                `+${overflow} more`,
              )
            : null,
        ),
      );
    }

    const prevButton = h('button', { class: 'btn btn-small', type: 'button' }, '← Previous');
    const nextButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Next →');
    const todayButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Today');
    prevButton.addEventListener('click', () => {
      month -= 1;
      if (month < 0) {
        month = 11;
        year -= 1;
      }
      expandedDay = null;
      buildCal();
    });
    nextButton.addEventListener('click', () => {
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
      expandedDay = null;
      buildCal();
    });
    todayButton.addEventListener('click', () => {
      const nowDate = new Date();
      year = nowDate.getFullYear();
      month = nowDate.getMonth();
      expandedDay = null;
      buildCal();
    });

    host.replaceChildren(
      h(
        'div',
        { class: 'cal-toolbar' },
        h('h3', { class: 'cal-month' }, monthTitle),
        h('div', { class: 'cal-nav' }, todayButton, prevButton, nextButton),
      ),
      h(
        'div',
        { class: 'cal-grid', role: 'grid', 'aria-label': `${monthTitle} by due date` },
        ...CAL_WEEKDAYS.map((label) => h('div', { class: 'cal-weekday', 'aria-hidden': 'true' }, label)),
        ...cells,
      ),
      filtered.filter((order) => order.dueDate).length === 0
        ? h(
            'p',
            { class: 'muted cal-empty-note' },
            'No service orders with a due date match the current filters.',
          )
        : null,
    );
  }

  buildCal();
  return host;
}

/* AI draft (SPEC-v3.md section 9): the chat panel stashes a draft and the
   normal new-service-order form opens pre-filled. Nothing is saved until the
   user presses Save; machine ids and assignees must match local records. */
function prefillFromAiDraft(draft) {
  return parseDraftForForm(draft, state.machines, assignablePeople());
}

function renderJobNew(route) {
  setTitle('New service order');
  if (state.machines.length === 0) {
    return page(
      pageHead('New service order'),
      emptyState(
        'Add a machine first',
        'Every service order belongs to a machine or building item.',
        [h('a', { class: 'btn btn-primary', href: '#/machines/new' }, 'Add a machine')],
      ),
    );
  }
  // Phone/tablet form page; on desktop render() opens the drawer instead.
  const preset = route.params.get('machine');
  const prefill = prefillFromAiDraft(consumeAiDraft() || {});
  const { node } = workOrderFormBody({
    existing: null,
    presetMachineId: preset && machineById(preset) ? preset : null,
    prefill: prefill || null,
  });
  return page(pageHead('New service order'), node);
}

/* Attachment thumbnails (SPEC-v3.md section 6): image links open full size
   in a new tab; PDFs open in a new tab. */
function attachmentNode(attachment) {
  if (!attachment || !attachment.fileId) return null;
  const url = `/api/files/${encodeURIComponent(attachment.fileId)}`;
  const name = attachment.name || 'File';
  if (typeof attachment.mime === 'string' && attachment.mime.startsWith('image/')) {
    return h(
      'a',
      { class: 'attach-thumb', href: url, target: '_blank', rel: 'noopener', title: name },
      h('img', { src: url, alt: name }),
    );
  }
  return h(
    'a',
    { class: 'attach-file', href: url, target: '_blank', rel: 'noopener', title: name },
    h('span', { class: 'attach-icon', 'aria-hidden': 'true' }, 'PDF'),
    h('span', { class: 'attach-file-name' }, name),
  );
}

function attachmentsGrid(attachments = []) {
  const list = (attachments || []).filter(Boolean);
  if (list.length === 0) return h('p', { class: 'muted' }, 'No attachments.');
  return h('div', { class: 'attach-grid' }, ...list.map(attachmentNode));
}

function checklistNode(order) {
  const items = (order.checklist || []).filter(Boolean);
  if (items.length === 0) return h('p', { class: 'muted' }, 'No checklist.');
  const done = items.filter((item) => item.done).length;
  return h(
    'div',
    { class: 'card checklist-view' },
    h('p', { class: 'row-sub check-progress' }, `${done} of ${items.length} done`),
    ...items.map((item) =>
      h(
        'div',
        { class: `check-view-item${item.done ? ' is-done' : ''}` },
        item.done
          ? h('span', { class: 'check-box', 'aria-hidden': 'true' }, '✓')
          : h('span', { class: 'check-box is-empty', 'aria-hidden': 'true' }),
        h('span', { class: 'check-view-text' }, item.text),
      ),
    ),
  );
}

function labourNode(order) {
  const entries = (order.labour || []).filter(Boolean);
  const legacyMinutes = toInteger(order.minutesSpent);
  return h(
    'div',
    { class: 'card labour-view' },
    entries.length === 0 && legacyMinutes === 0
      ? h('p', { class: 'muted' }, 'No labour recorded.')
      : null,
    ...entries.map((entry) =>
      h(
        'div',
        { class: 'labour-row' },
        h('span', { class: 'labour-person' }, personName(entry) || 'Unknown'),
        h('span', { class: 'labour-date' }, formatDate(entry.date)),
        h('span', { class: 'labour-hours' }, `${Number(entry.hours) || 0} h`),
        entry.note ? h('span', { class: 'labour-note muted' }, entry.note) : null,
      ),
    ),
    legacyMinutes > 0
      ? h(
          'div',
          { class: 'labour-row is-legacy' },
          h('span', { class: 'labour-person' }, 'Legacy entry by the creator'),
          h('span', { class: 'labour-hours' }, `${Math.round((legacyMinutes / 60) * 100) / 100} h`),
        )
      : null,
    h('p', { class: 'labour-total' }, `Total labour: ${formatHours(labourTotal(order))}`),
  );
}

function renderJobDetail(route) {
  const order = workOrderById(route.segments[1]);
  setTitle(order ? order.title : 'Service order not found');
  if (!order) {
    return page(
      pageHead('Service order not found'),
      emptyState('That service order does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/jobs' }, 'Back to Service Orders'),
      ]),
    );
  }

  const machine = machineById(order.machineId);
  const partsUsed = order.partsUsed || [];
  const today = todayISO();
  const due = orderDueParts(order, today);
  const assignees = (order.assignees || []).filter(Boolean);

  async function changeStatus(status) {
    if (status === order.status) return;
    try {
      await changeOrderStatus(order, status);
    } catch (error) {
      console.error(error);
      toast('Could not save the status change. Please try again.', 'warn');
      return;
    }
    render();
  }

  async function deleteOrder() {
    const yes = await showConfirm({
      title: 'Delete this service order?',
      message: `"${order.title}" will be removed. This cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!yes) return;
    await sync.deleteRecord('workOrders', order.id, order.version);
    await refreshState();
    toast('Service order deleted.');
    navigate('#/jobs');
  }

  /* Edit: right drawer on desktop, a collapsed section on phone/tablet
     (SPEC-v3.md section 3 item 6). */
  function editFormBody() {
    return workOrderFormBody({ existing: order }).node;
  }

  function openEditDrawer() {
    if (drawerHandle) drawerHandle.close();
    const { node, isDirty } = workOrderFormBody({
      existing: order,
      cancelTo: null,
      onSaved: () => {
        if (drawerHandle) drawerHandle.close();
        render();
      },
    });
    openDrawer({ title: 'Edit service order', content: node, isDirty });
  }

  const statusButtons = h(
    'div',
    { class: 'status-buttons', role: 'group', 'aria-label': 'Change status' },
    ...WORK_ORDER_STATUSES.map((status) =>
      h(
        'button',
        {
          type: 'button',
          class: `chip${status === order.status ? ' is-active' : ''}`,
          'aria-pressed': status === order.status ? 'true' : 'false',
          onclick: () => changeStatus(status),
        },
        LABELS.status[status],
      ),
    ),
  );

  const details = h(
    'dl',
    { class: 'detail-grid' },
    h('dt', {}, 'Number'),
    h('dd', {}, formatOrderNumber(order.number)),
    h('dt', {}, 'Machine'),
    h(
      'dd',
      {},
      machine
        ? h('a', { class: 'inline-link', href: `#/machines/${encodeURIComponent(machine.id)}` }, machine.name)
        : 'Unknown machine',
    ),
    h('dt', {}, 'Kind'),
    h('dd', {}, LABELS.kind[order.kind] || order.kind),
    h('dt', {}, 'Category'),
    h('dd', {}, order.category ? LABELS.category[order.category] || order.category : '—'),
    h('dt', {}, 'Priority'),
    h('dd', {}, priorityBadge(order.priority)),
    h('dt', {}, 'Due'),
    h('dd', {}, due.text ? h('span', { class: due.overdue ? 'text-overdue' : '' }, due.text) : '—'),
    h('dt', {}, 'Reported'),
    h('dd', {}, formatDate(order.reportedAt)),
    h('dt', {}, 'Completed'),
    h('dd', {}, order.completedAt ? formatDate(order.completedAt) : '—'),
    h('dt', {}, 'Requested by'),
    h('dd', {}, order.requestedBy || '—'),
    h('dt', {}, 'Age'),
    h('dd', {}, formatAge(workOrderAgeDays(order))),
    h('dt', {}, 'Labour'),
    h('dd', {}, formatHours(labourTotal(order))),
    h('dt', {}, 'Downtime'),
    h('dd', {}, `${toInteger(order.downtimeMinutes)} min`),
    order.pmTaskId
      ? [
          h('dt', {}, 'PM task'),
          h(
            'dd',
            {},
            h(
              'a',
              { class: 'inline-link', href: `#/pm/${encodeURIComponent(order.pmTaskId)}` },
              pmTaskById(order.pmTaskId) ? pmTaskById(order.pmTaskId).title : 'View PM task',
            ),
          ),
        ]
      : null,
  );

  const editSection =
    desktopMedia.matches || !can('serviceOrders', 'write')
      ? null
      : h(
          'details',
          { class: 'more' },
          h('summary', {}, 'Edit service order'),
          editFormBody(),
        );

  const canEditOrder = can('serviceOrders', 'write');
  return page(
    h(
      'div',
      { class: 'detail-head' },
      h(
        'div',
        {},
        h('h2', {}, order.title),
        h('div', { class: 'row-sub' }, `${formatOrderNumber(order.number)} · ${machineName(order.machineId)}`),
      ),
      h(
        'div',
        { class: 'row-sub' },
        statusPill(order.status, LABELS.status),
        isReadOnly('serviceOrders') ? viewOnlyBadge() : null,
      ),
    ),
    detailMeta(order),
    conflictBanner('workOrders', order.id),
    canEditOrder ? statusButtons : null,
    // v4 (SPEC-v4.md 3.3): request parts for this order into a draft request.
    can('purchasing', 'write')
      ? h(
          'div',
          { class: 'button-row', style: { marginTop: '0.5rem' } },
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => requestPartsForOrder(order) }, 'Request parts'),
        )
      : null,
    h('div', { class: 'card' }, details),
    sectionTitle('Assigned to'),
    assignees.length
      ? h('div', { class: 'card assignees-view' }, assigneeAvatars(assignees, { showNames: true }))
      : h('p', { class: 'muted' }, 'Unassigned.'),
    sectionTitle('Problem'),
    order.problem
      ? h('div', { class: 'card pre' }, order.problem)
      : h('p', { class: 'muted' }, 'No problem description.'),
    sectionTitle('Checklist'),
    checklistNode(order),
    sectionTitle('Labour'),
    labourNode(order),
    sectionTitle('Parts used'),
    partsUsed.length
      ? h(
          'div',
          { class: 'card' },
          partsUsed.map((item) => {
            const part = partById(item.partId);
            return h(
              'div',
              { class: 'row-sub' },
              part
                ? h(
                    'a',
                    { class: 'inline-link', href: `#/parts/${encodeURIComponent(part.id)}` },
                    part.name,
                  )
                : 'Unknown part',
              ` × ${toInteger(item.qty)}`,
            );
          }),
        )
      : h('p', { class: 'muted' }, 'No parts recorded.'),
    sectionTitle('Attachments'),
    attachmentsGrid(order.attachments),
    sectionTitle('Action taken'),
    order.actionTaken
      ? h('div', { class: 'card pre' }, order.actionTaken)
      : h('p', { class: 'muted' }, 'Nothing recorded yet.'),
    editSection,
    canEditOrder
      ? h(
          'div',
          { class: 'form-actions', style: { marginTop: '1.25rem' } },
          h('button', { class: 'btn btn-danger', type: 'button', onclick: deleteOrder }, 'Delete service order'),
          desktopMedia.matches ? h('button', { class: 'btn', type: 'button', onclick: openEditDrawer }, 'Edit') : null,
        )
      : null,
    historySection('workOrders', order.id),
  );
}

/* ----- Attachment upload (SPEC-v3.md sections 3 and 6) -----
   Images are downscaled in a canvas (longest side 1600 px, JPEG 0.82) before
   a POST /api/files upload; PDFs upload as-is. Uploading needs a connection
   to the server — the record itself still saves offline. */

const FILE_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const FILE_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
const FILE_UPLOAD_MAX_ATTACHMENTS = 20;
const FILE_UPLOAD_OFFLINE = 'Uploading needs a connection to the server.';
const IMAGE_UPLOAD_MAX_DIM = 1600;
const IMAGE_UPLOAD_JPEG_QUALITY = 0.82;

const FILE_EXT_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** Downscale to JPEG (1600 px / 0.82); null = upload the file unchanged. */
async function downscaleImageForUpload(file, mime) {
  if (!mime.startsWith('image/') || mime === 'application/pdf') return null;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_UPLOAD_MAX_DIM / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && mime === 'image/jpeg') {
      if (typeof bitmap.close === 'function') bitmap.close();
      return null;
    }
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      if (typeof bitmap.close === 'function') bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === 'function') bitmap.close();
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not process the image.'))),
        'image/jpeg',
        IMAGE_UPLOAD_JPEG_QUALITY,
      );
    });
  } catch (error) {
    console.warn('Image downscale failed; uploading as-is:', error);
    return null;
  }
}

/** Upload one file; resolves {fileId, name, mime, size} (SPEC-v3.md 6). */
async function uploadAttachmentFile(file) {
  if (!sync.currentUser()) throw new Error(FILE_UPLOAD_OFFLINE);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error(FILE_UPLOAD_OFFLINE);
  }
  let mime = String(file.type || '');
  if (!mime) {
    const match = /\.([a-z0-9]+)$/i.exec(String(file.name || ''));
    mime = match ? FILE_EXT_TYPES[match[1].toLowerCase()] || '' : '';
  }
  if (!mime || !FILE_UPLOAD_TYPES.includes(mime)) {
    throw new Error('Unsupported file type. Photos (JPEG, PNG, WebP) and PDFs are allowed.');
  }
  if (file.size > FILE_UPLOAD_MAX_BYTES) {
    throw new Error('That file is too large. The maximum is 15 MB.');
  }
  let body = file;
  let sendMime = mime;
  if (mime.startsWith('image/')) {
    const downscaled = await downscaleImageForUpload(file, mime);
    if (downscaled) {
      body = downscaled;
      sendMime = 'image/jpeg';
    }
  }
  const response = await fetch('/api/files', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'maint-log',
      'Content-Type': sendMime,
      'X-File-Name': encodeURIComponent(file.name || 'upload'),
    },
    body,
  });
  if (!response.ok) {
    let message = `Upload failed (HTTP ${response.status}).`;
    try {
      const data = await response.json();
      if (data && data.message) message = data.message;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  const data = await response.json();
  if (!data || !data.fileId) throw new Error('The server did not return a file id.');
  return { fileId: data.fileId, name: data.name || file.name, mime: data.mime || sendMime, size: Number(data.size) || 0 };
}

/* ----- Assignee picker (SPEC-v3.md section 3 item 6: coworkers,
   contractors, users from the synced stores and the users cache) ----- */

function createAssigneeEditor(initialAssignees = []) {
  const selected = [];
  for (const entry of initialAssignees || []) {
    if (entry && entry.kind && entry.id) selected.push({ kind: entry.kind, id: entry.id });
  }
  const people = assignablePeople();
  const listHost = h('div', { class: 'assignee-list' });
  const hint = h('p', { class: 'field-hint' });
  const addSelect = h(
    'select',
    { 'aria-label': 'Add an assignee' },
    h('option', { value: '' }, 'Pick a person…'),
    ...people.map((person) =>
      h('option', { value: `${person.kind}:${person.id}` }, `${person.name} · ${person.sub}`),
    ),
  );
  const addButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Add');

  function atLimit() {
    return selected.length >= 10;
  }

  function syncHint() {
    hint.textContent =
      people.length === 0
        ? 'No coworkers yet - add them in People.'
        : atLimit()
          ? 'At most 10 assignees.'
          : '';
    addButton.disabled = people.length === 0 || atLimit();
    addSelect.disabled = people.length === 0 || atLimit();
  }

  function renderList() {
    listHost.replaceChildren(
      ...selected.map((entry, index) => {
        const name = personName(entry) || 'Unknown';
        return h(
          'div',
          { class: 'assignee-chip' },
          personAvatar(name, entry.kind),
          h('span', { class: 'assignee-chip-name' }, name),
          h(
            'button',
            {
              class: 'filter-chip-x',
              type: 'button',
              'aria-label': `Remove ${name}`,
              onclick: () => {
                selected.splice(index, 1);
                renderList();
                syncHint();
              },
            },
            '×',
          ),
        );
      }),
    );
  }

  function addChosen() {
    if (!addSelect.value) return;
    const separator = addSelect.value.indexOf(':');
    const kind = addSelect.value.slice(0, separator);
    const id = addSelect.value.slice(separator + 1);
    if (atLimit()) return;
    if (!selected.some((entry) => entry.kind === kind && entry.id === id)) {
      selected.push({ kind, id });
      renderList();
      syncHint();
    }
    addSelect.value = '';
  }

  addButton.addEventListener('click', addChosen);
  addSelect.addEventListener('change', addChosen);
  renderList();
  syncHint();

  const element = h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label editor-label' }, 'Assigned to'),
    hint,
    listHost,
    h('div', { class: 'assignee-add' }, addSelect, addButton),
  );
  return { element, getAssignees: () => selected.slice(0, 10) };
}

/* ----- Checklist editor: add, move up/down, tick, remove (SPEC-v3.md 3.6) ----- */

function createChecklistEditor(initialItems = []) {
  const items = (initialItems || [])
    .filter(Boolean)
    .map((item) => ({ id: item.id || uid(), text: String(item.text || ''), done: Boolean(item.done) }));
  const listHost = h('div', { class: 'checklist-edit' });
  const input = h('input', { type: 'text', maxlength: '200', placeholder: 'New checklist step', autocomplete: 'off' });
  const addButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Add step');
  const hint = h('p', { class: 'field-hint' });

  const MAX_CHECKLIST = 50;

  function syncHint() {
    addButton.disabled = items.length >= MAX_CHECKLIST;
    hint.textContent = items.length >= MAX_CHECKLIST ? 'At most 50 steps.' : '';
  }

  function renderRows() {
    listHost.replaceChildren(
      ...items.map((item, index) => {
        const checkInput = h('input', { type: 'checkbox', 'aria-label': `Mark "${item.text}" done` });
        checkInput.checked = item.done;
        checkInput.addEventListener('change', () => {
          item.done = checkInput.checked;
        });
        const textInput = h('input', {
          type: 'text',
          maxlength: '200',
          value: item.text,
          'aria-label': `Checklist step ${index + 1}`,
        });
        textInput.addEventListener('input', () => {
          item.text = textInput.value;
        });
        const upButton = h(
          'button',
          {
            class: 'btn btn-ghost btn-small',
            type: 'button',
            'aria-label': `Move "${item.text}" up`,
            disabled: index === 0,
            onclick: () => {
              if (index === 0) return;
              const [moved] = items.splice(index, 1);
              items.splice(index - 1, 0, moved);
              renderRows();
            },
          },
          '↑',
        );
        const downButton = h(
          'button',
          {
            class: 'btn btn-ghost btn-small',
            type: 'button',
            'aria-label': `Move "${item.text}" down`,
            disabled: index === items.length - 1,
            onclick: () => {
              if (index === items.length - 1) return;
              const [moved] = items.splice(index, 1);
              items.splice(index + 1, 0, moved);
              renderRows();
            },
          },
          '↓',
        );
        const removeButton = h(
          'button',
          {
            class: 'btn btn-ghost btn-small',
            type: 'button',
            'aria-label': `Remove "${item.text}"`,
            onclick: () => {
              items.splice(index, 1);
              renderRows();
              syncHint();
            },
          },
          '×',
        );
        return h(
          'div',
          { class: 'check-edit-row' },
          checkInput,
          textInput,
          h('div', { class: 'check-edit-actions' }, upButton, downButton, removeButton),
        );
      }),
    );
    syncHint();
  }

  function addStep() {
    const text = input.value.trim();
    if (!text || items.length >= MAX_CHECKLIST) return;
    items.push({ id: uid(), text, done: false });
    input.value = '';
    renderRows();
    input.focus();
  }

  addButton.addEventListener('click', addStep);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addStep();
    }
  });

  renderRows();

  const element = h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label editor-label' }, 'Checklist'),
    hint,
    listHost,
    h('div', { class: 'check-add' }, input, addButton),
  );
  return {
    element,
    getChecklist: () => items.map((item) => ({ id: item.id, text: item.text, done: item.done })),
  };
}

/* ----- Labour editor (SPEC-v3.md 3.6): person + date + hours (0.25 steps)
   + note; a list with removal and the running total. ----- */

function createLabourEditor(initialEntries = []) {
  const entries = (initialEntries || [])
    .filter(Boolean)
    .filter((entry) => entry.kind && entry.personId)
    .map((entry) => ({
      id: entry.id || uid(),
      kind: entry.kind,
      personId: entry.personId,
      date: entry.date || todayISO(),
      hours: Number(entry.hours) || 0,
      note: String(entry.note || ''),
    }));
  const people = assignablePeople();
  const listHost = h('div', { class: 'labour-edit' });
  const hint = h('p', { class: 'field-hint' });

  const defaultKind = teamUser ? 'user' : people.length > 0 ? people[0].kind : null;
  const defaultId = teamUser ? teamUser.id : people.length > 0 ? people[0].id : '';
  const personSelect = h(
    'select',
    { 'aria-label': 'Labour: person' },
    h('option', { value: '' }, people.length === 0 ? 'No people yet' : 'Pick a person…'),
    ...people.map((person) => {
      const value = `${person.kind}:${person.id}`;
      const option = h('option', { value }, person.name);
      if (person.kind === defaultKind && person.id === defaultId) option.selected = true;
      return option;
    }),
  );
  const dateInput = h('input', { type: 'date', value: todayISO(), 'aria-label': 'Labour: date' });
  const hoursInput = h('input', {
    type: 'number',
    min: '0.25',
    max: '24',
    step: '0.25',
    inputmode: 'decimal',
    value: '1',
    'aria-label': 'Labour: hours',
  });
  const noteInput = h('input', {
    type: 'text',
    maxlength: '200',
    placeholder: 'What was done (optional)',
    'aria-label': 'Labour: note',
  });
  const addButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Add hours');
  const totalLine = h('p', { class: 'labour-total' });

  const MAX_LABOUR = 200;

  function syncControls() {
    addButton.disabled = people.length === 0 || entries.length >= MAX_LABOUR;
    hint.textContent =
      people.length === 0
        ? 'No coworkers yet - add them in People.'
        : entries.length >= MAX_LABOUR
          ? 'At most 200 labour entries.'
          : '';
    totalLine.textContent = `Total: ${formatHours(labourTotal({ labour: entries }))}`;
  }

  function renderRows() {
    listHost.replaceChildren(
      ...entries.map((entry, index) =>
        h(
          'div',
          { class: 'labour-row' },
          h('span', { class: 'labour-person' }, personName(entry) || 'Unknown'),
          h('span', { class: 'labour-date' }, formatDate(entry.date)),
          h('span', { class: 'labour-hours' }, `${entry.hours} h`),
          entry.note ? h('span', { class: 'labour-note muted' }, entry.note) : null,
          h(
            'button',
            {
              class: 'btn btn-ghost btn-small',
              type: 'button',
              'aria-label': 'Remove labour entry',
              onclick: () => {
                entries.splice(index, 1);
                renderRows();
              },
            },
            '×',
          ),
        ),
      ),
    );
    syncControls();
  }

  function addEntry() {
    const raw = personSelect.value;
    if (!raw) return;
    const separator = raw.indexOf(':');
    const kind = raw.slice(0, separator);
    const personId = raw.slice(separator + 1);
    const hours = Number(hoursInput.value);
    if (!Number.isFinite(hours) || hours < 0.25 || hours > 24) {
      hint.textContent = 'Hours must be between 0.25 and 24.';
      hoursInput.focus();
      return;
    }
    const quarter = Math.round(hours * 4) / 4;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value || '')) {
      hint.textContent = 'Choose the date the work happened.';
      dateInput.focus();
      return;
    }
    if (entries.length >= MAX_LABOUR) return;
    entries.push({
      id: uid(),
      kind,
      personId,
      date: dateInput.value,
      hours: quarter,
      note: noteInput.value.trim().slice(0, 200),
    });
    noteInput.value = '';
    renderRows();
  }

  addButton.addEventListener('click', addEntry);
  renderRows();

  const element = h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label editor-label' }, 'Labour'),
    hint,
    listHost,
    h('div', { class: 'labour-add' }, personSelect, dateInput, hoursInput),
    h('div', { class: 'labour-add-note' }, noteInput, addButton),
    totalLine,
  );
  return { element, getLabour: () => entries.map((entry) => ({ ...entry })) };
}

/* ----- Attachments editor (SPEC-v3.md section 3 item 6 + section 6) ----- */

/* Permission helpers (SPEC-v3.md 13.3): the client follows
   teamUser.permissions {area: 'none'|'read'|'write'}; local mode (no team
   user) allows everything. The server stays the authority on every save.
   can(area, level) is the one check used everywhere: level order
   none < read < write, so write implies read. */
function can(area, level = 'read') {
  if (!teamUser || !teamUser.permissions) return true;
  return allows(teamUser.permissions, area, level);
}

function isReadOnly(area) {
  return can(area) && !can(area, 'write');
}

/* The Admin dashboard exists only in team mode: local records have no users
   or roles to manage (the server routes need admin Write anyway). */
function canAdminUI() {
  return Boolean(teamUser) && can('admin', 'write');
}

/* Contractor rates & costs (SPEC-v3.md 13.1): Read shows rate/cost, Write
   may edit the hourlyRate field. The server stays the authority. */
function canReadRates() {
  return can('contractorRates');
}

function canWriteRates() {
  return can('contractorRates', 'write');
}

/** "View only" badge on read-only pages (SPEC-v3.md 13.3). */
function viewOnlyBadge() {
  return h(
    'span',
    { class: 'pill view-only-badge', title: 'You can view this page but not change it' },
    'View only',
  );
}

/** Route target for a hidden area (SPEC-v3.md 13.3: "You do not have access"). */
function noAccessPage(title, areaLabel) {
  setTitle(title);
  return page(
    pageHead(title),
    emptyState(
      'You do not have access',
      `Your role does not include access to ${areaLabel}. An administrator can change that on the Admin page.`,
      [h('a', { class: 'btn btn-primary', href: '#/home' }, 'Go Home')],
    ),
  );
}

function createAttachmentsEditor(initialAttachments = []) {
  const attachments = (initialAttachments || []).filter(Boolean);
  const gridHost = h('div', { class: 'attach-grid attach-grid-edit' });
  const statusBox = h('p', { class: 'field-hint', role: 'status' });
  const input = h('input', {
    type: 'file',
    multiple: true,
    accept: FILE_UPLOAD_TYPES.join(','),
    'aria-label': 'Add photos or PDFs',
  });
  const addButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Add photo or PDF');
  // Uploading needs the files area Write permission (SPEC-v3.md 13.1).
  const canUpload = can('files', 'write');

  function renderGrid() {
    if (attachments.length === 0) {
      gridHost.replaceChildren();
      return;
    }
    gridHost.replaceChildren(
      ...attachments.map((attachment) =>
        h(
          'div',
          { class: 'attach-cell' },
          attachmentNode(attachment),
          h(
            'button',
            {
              class: 'filter-chip-x attach-remove',
              type: 'button',
              'aria-label': `Remove ${attachment.name}`,
              onclick: () => {
                const index = attachments.indexOf(attachment);
                if (index !== -1) attachments.splice(index, 1);
                renderGrid();
              },
            },
            '×',
          ),
        ),
      ),
    );
  }

  async function handleFiles() {
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length === 0) return;
    if (!sync.currentUser() || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      statusBox.textContent = FILE_UPLOAD_OFFLINE;
      return;
    }
    for (const file of files) {
      if (attachments.length >= FILE_UPLOAD_MAX_ATTACHMENTS) {
        statusBox.textContent = 'At most 20 attachments.';
        return;
      }
      statusBox.textContent = `Uploading ${file.name}…`;
      try {
        const uploaded = await uploadAttachmentFile(file);
        attachments.push(uploaded);
        renderGrid();
      } catch (error) {
        statusBox.textContent = error && error.message ? error.message : 'Upload failed.';
        return;
      }
    }
    statusBox.textContent = '';
  }

  input.addEventListener('change', () => {
    handleFiles();
  });
  addButton.addEventListener('click', () => input.click());

  renderGrid();

  input.hidden = true;
  const element = h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label editor-label' }, 'Attachments'),
    statusBox,
    gridHost,
    ...(canUpload
      ? [input, h('div', { class: 'form-actions' }, addButton)]
      : [
          h(
            'span',
            { class: 'field-hint' },
            'View only — you need the Photos & files write permission to upload.',
          ),
        ]),
    ...(canUpload
      ? [h('span', { class: 'field-hint' }, 'Images are downscaled before upload; PDFs upload as-is.')]
      : []),
  );
  return { element, getAttachments: () => attachments.slice(0, FILE_UPLOAD_MAX_ATTACHMENTS) };
}

/* ----- Service order form body: sectioned form used by the full page
   (phone/tablet) and the desktop drawer (SPEC-v3.md section 3 item 6) ----- */

function workOrderFormBody({
  existing = null,
  presetMachineId = null,
  prefill = null,
  cancelTo = undefined,
  onSaved = null,
} = {}) {
  const isNew = !existing;
  const today = todayISO();
  const base = existing || {
    title: '',
    machineId: presetMachineId || '',
    kind: 'breakdown',
    priority: 'medium',
    category: '',
    status: 'open',
    reportedAt: today,
    dueDate: null,
    requestedBy: '',
    problem: '',
    actionTaken: '',
    partsUsed: [],
    minutesSpent: 0,
    downtimeMinutes: 0,
    assignees: [],
    labour: [],
    checklist: [],
    attachments: [],
  };
  /* AI draft prefill (SPEC-v3.md section 9): form-safe fields only; the
     prefill comes from parseDraftForForm, which validated machine ids and
     assignees against this device's records. */
  if (!existing && prefill && typeof prefill === 'object') {
    for (const [key, value] of Object.entries(prefill)) {
      if (value !== undefined && value !== null) base[key] = value;
    }
  }

  const form = h('form', { class: 'form so-form', novalidate: true });
  const errorBox = h('div', { class: 'form-error', role: 'alert' });

  const titleInput = h('input', {
    type: 'text',
    required: true,
    autocomplete: 'off',
    placeholder: 'Short fault, e.g. Needle breaking',
    value: base.title || '',
  });
  titleInput.addEventListener('input', () => {
    if (titleInput.value.trim()) errorBox.textContent = '';
  });

  const picker = machinePicker(base.machineId);
  picker.input.id = `machine-input-${++fieldCounter}`;
  const machineField = h(
    'div',
    { class: 'field' },
    h('label', { for: picker.input.id }, 'Machine'),
    picker.wrap,
    h('span', { class: 'field-hint' }, 'Start typing to search. Recent machines are listed first.'),
  );
  const kindSelect = selectFrom(WORK_ORDER_KINDS, base.kind || 'breakdown', (value) => LABELS.kind[value]);
  const categorySelect = h(
    'select',
    {},
    h('option', { value: '' }, 'No category'),
    ...WORK_ORDER_CATEGORIES.map((value) => {
      const option = h('option', { value }, LABELS.category[value]);
      if (value === (base.category || '')) option.selected = true;
      return option;
    }),
  );
  const prioritySelect = selectFrom(PRIORITIES, priorityValue(base.priority) || 'medium', (value) => LABELS.priority[value]);
  const statusSelect = selectFrom(WORK_ORDER_STATUSES, base.status || 'open', (value) => LABELS.status[value]);
  const reportedInput = h('input', { type: 'date', value: base.reportedAt || today });
  const dueInput = h('input', { type: 'date', value: base.dueDate || '' });
  const requestedByInput = h('input', {
    type: 'text',
    maxlength: '80',
    autocomplete: 'off',
    placeholder: 'e.g. Line supervisor',
    value: base.requestedBy || '',
  });
  const problemInput = h('textarea', {
    rows: 3,
    placeholder: 'Symptoms, error codes, what the operator saw',
    value: base.problem || '',
  });
  const actionInput = h('textarea', {
    rows: 3,
    placeholder: 'What was done to fix it',
    value: base.actionTaken || '',
  });
  const minutesInput = h('input', {
    type: 'number',
    min: 0,
    step: 1,
    inputmode: 'numeric',
    value: String(toInteger(base.minutesSpent)),
  });
  const downtimeInput = h('input', {
    type: 'number',
    min: 0,
    step: 1,
    inputmode: 'numeric',
    value: String(toInteger(base.downtimeMinutes)),
  });

  const partsEditor = createPartsEditor(base.partsUsed || []);
  const assigneeEditor = createAssigneeEditor(base.assignees || []);
  const checklistEditor = createChecklistEditor(base.checklist || []);
  const labourEditor = createLabourEditor(base.labour || []);
  const attachmentsEditor = createAttachmentsEditor(base.attachments || []);

  const downCheckbox = h('input', { type: 'checkbox', checked: true });
  const downLabel = h('label', { for: 'set-machine-down' }, 'Set machine to Down while this service order is open');
  downCheckbox.id = 'set-machine-down';
  const downRow = h('div', { class: 'check-row' }, downCheckbox, downLabel);

  function updateDownRow() {
    const machine = picker.resolve() || machineById(base.machineId);
    const applies =
      kindSelect.value === 'breakdown' &&
      statusSelect.value !== 'done' &&
      machine &&
      machine.status !== 'retired';
    downRow.hidden = !applies;
  }

  kindSelect.addEventListener('change', updateDownRow);
  statusSelect.addEventListener('change', updateDownRow);
  picker.input.addEventListener('input', updateDownRow);
  updateDownRow();

  form.append(
    errorBox,
    sectionTitle('Basics'),
    field('Title', titleInput),
    machineField,
    h('div', { class: 'grid-2' }, field('Kind', kindSelect), field('Category', categorySelect)),
    h('div', { class: 'grid-2' }, field('Priority', prioritySelect), field('Status', statusSelect)),
    h(
      'div',
      { class: 'grid-2' },
      field('Due date', dueInput),
      field('Reported date', reportedInput),
    ),
    field('Requested by', requestedByInput, 'Operator or supervisor who asked for the work'),
    downRow,
    sectionTitle('Problem'),
    problemInput,
    sectionTitle('Assign'),
    assigneeEditor.element,
    sectionTitle('Checklist'),
    checklistEditor.element,
    sectionTitle('Labour'),
    labourEditor.element,
    // Old orders stored labour as plain minutes; only show that field when it holds a value.
    // (form.append would print a null as the text "null", so spread an empty list instead.)
    ...(toInteger(base.minutesSpent) > 0
      ? [field('Labour minutes (older entry)', minutesInput, 'Also counts towards the total labour hours.')]
      : []),
    // Downtime is only needed for some orders: tucked away, open when it already has a value.
    h(
      'details',
      { class: 'more downtime-details', open: toInteger(base.downtimeMinutes) > 0 },
      h('summary', {}, 'Machine downtime (optional)'),
      field('Downtime (minutes)', downtimeInput, 'How long the machine could not run because of this problem.'),
    ),
    sectionTitle('Parts used'),
    partsEditor.element,
    sectionTitle('Attachments'),
    attachmentsEditor.element,
    sectionTitle('Action taken'),
    actionInput,
  );

  const saveButton = h(
    'button',
    { class: 'btn btn-primary', type: 'submit' },
    isNew ? 'Save service order' : 'Save changes',
  );
  /* Cancel: in the drawer a button that just closes the panel; on a full
     page a link back to where the user came from. */
  const cancelButton =
    cancelTo === null
      ? h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              if (drawerHandle) drawerHandle.close();
            },
          },
          'Cancel',
        )
      : h(
          'a',
          {
            class: 'btn',
            href: cancelTo || (existing ? `#/jobs/${encodeURIComponent(existing.id)}` : '#/jobs'),
          },
          'Cancel',
        );
  form.append(h('div', { class: 'form-actions' }, saveButton, cancelButton));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const title = titleInput.value.trim();
    if (!title) {
      errorBox.textContent = 'Enter a short title for the service order.';
      titleInput.focus();
      return;
    }
    const machine = picker.resolve();
    if (!machine) {
      errorBox.textContent =
        state.machines.length === 0
          ? 'Add a machine before logging a repair.'
          : 'Pick a machine from the list.';
      picker.input.focus();
      return;
    }
    if (!reportedInput.value) {
      errorBox.textContent = 'Choose the date the service order was reported.';
      reportedInput.focus();
      return;
    }
    if (dueInput.value && !isISODate(dueInput.value)) {
      errorBox.textContent = 'Choose a valid due date, or clear it.';
      dueInput.focus();
      return;
    }

    const now = nowISO();
    const incoming = {
      ...base,
      id: existing ? existing.id : uid(),
      title,
      machineId: machine.id,
      kind: kindSelect.value,
      priority: prioritySelect.value,
      status: statusSelect.value,
      reportedAt: reportedInput.value,
      dueDate: dueInput.value || null,
      requestedBy: requestedByInput.value.trim().slice(0, 80),
      completedAt: existing ? existing.completedAt : null,
      problem: problemInput.value.trim(),
      actionTaken: actionInput.value.trim(),
      assignees: assigneeEditor.getAssignees(),
      labour: labourEditor.getLabour(),
      checklist: checklistEditor.getChecklist(),
      attachments: attachmentsEditor.getAttachments(),
      partsUsed: partsEditor.getPartsUsed(),
      minutesSpent: toInteger(minutesInput.value),
      downtimeMinutes: toInteger(downtimeInput.value),
      pmTaskId: existing ? existing.pmTaskId : null,
      photos: existing ? existing.photos || [] : [],
      stockDeducted: existing ? Boolean(existing.stockDeducted) : false,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    // An empty category is omitted (absent) rather than sent as "" — the
    // server validates enum fields and would reject an empty string.
    if (categorySelect.value) incoming.category = categorySelect.value;
    else delete incoming.category;
    saveButton.disabled = true;
    try {
      const wasDone = existing ? existing.status === 'done' : false;
      const setMachineDown =
        !downRow.hidden && downCheckbox.checked && machine.status !== 'down';
      const result = await persistWorkOrderSave(existing, incoming, { setMachineDown });
      await maybeOfferRunning(result.order, wasDone);
      toast(isNew ? 'Service order logged.' : 'Service order saved.');
      if (typeof onSaved === 'function') onSaved(result.order);
      else navigate(`#/jobs/${encodeURIComponent(result.order.id)}`);
    } catch (error) {
      errorBox.textContent = 'Could not save. Please try again.';
      console.error(error);
    } finally {
      saveButton.disabled = false;
    }
  });

  let dirty = false;
  const markDirty = () => {
    dirty = true;
  };
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);

  return { node: form, isDirty: () => dirty };
}

/* ---------- Machines ---------- */

const MACHINE_FILTERS = ['all', 'running', 'down', 'in-storage', 'retired'];

function renderMachines(route) {
  setTitle('Machines');
  const requested = route.params.get('status') || 'all';
  const statusFilter = MACHINE_FILTERS.includes(requested) ? requested : 'all';
  const listHost = h('div', { class: 'list' });
  const tableHost = h('div', { class: 'table-wrap' });
  let searchQuery = '';

  function update(nextQuery) {
    if (typeof nextQuery === 'string') searchQuery = nextQuery;
    const needle = searchQuery.trim().toLowerCase();
    const machines = state.machines
      .filter((machine) => statusFilter === 'all' || machine.status === statusFilter)
      .filter((machine) => {
        if (!needle) return true;
        return [machine.name, machineTypeLabel(machine), machine.model, machine.serial, machine.location]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle));
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (machines.length === 0) {
      listHost.replaceChildren(
        emptyState(
          needle || statusFilter !== 'all' ? 'No matching machines' : 'No machines yet',
          needle
            ? 'Try a different search.'
            : 'Add sewing machines, cutters, building items and anything else you maintain.',
          needle || statusFilter !== 'all'
            ? []
            : [h('a', { class: 'btn btn-primary', href: '#/machines/new' }, 'Add a machine')],
        ),
      );
      listHost.classList.remove('cards-only');
      tableHost.replaceChildren();
    } else {
      listHost.replaceChildren(...machines.map(machineRow));
      listHost.classList.add('cards-only');
      tableHost.replaceChildren(
        buildDataTable(
          'machines',
          machinesTableColumns(),
          machines,
          (machine) => `#/machines/${encodeURIComponent(machine.id)}`,
          update,
        ),
      );
    }
  }

  update();
  const chips = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': 'Filter machines by status' },
    MACHINE_FILTERS.map((value) =>
      h(
        'a',
        {
          class: `chip${value === statusFilter ? ' is-active' : ''}`,
          href: value === 'all' ? '#/machines' : `#/machines?status=${value}`,
          'aria-pressed': value === statusFilter ? 'true' : 'false',
        },
        value === 'all' ? 'All' : LABELS.machineStatus[value],
      ),
    ),
  );

  return page(
    pageHead(
      'Machines',
      headActionFor('machines', h('a', { class: 'btn btn-primary btn-small', href: '#/machines/new' }, '+ Add machine')),
    ),
    searchBox('Search machines', (value) => update(value)),
    chips,
    listHost,
    tableHost,
  );
}

function machineFormTitle(existing) {
  return existing ? 'Edit machine' : 'Add machine';
}

/* Machine form body shared by the full page (< 1024 px) and the desktop
   drawer (SPEC-v3.md section 10, drawer wired in render()). Returns the
   form node plus an isDirty() probe for the drawer's discard check. */
function machineFormBody(existing) {
  const base = existing || {
    name: '',
    type: DEFAULT_MACHINE_TYPE,
    typeLabel: '',
    model: '',
    serial: '',
    location: '',
    status: 'running',
    notes: '',
    attachments: [],
  };
  const form = h('form', { class: 'form', novalidate: true });
  const errorBox = h('div', { class: 'form-error', role: 'alert' });
  const nameInput = h('input', {
    type: 'text',
    required: true,
    autocomplete: 'off',
    placeholder: 'e.g. Juki DDL-8700 #12',
    value: base.name || '',
  });
  const typeSelect = machineTypeSelect(
    existing && existing.type === 'other' && existing.typeLabel
      ? existing.typeLabel
      : base.type || DEFAULT_MACHINE_TYPE,
    customTypeOptions(state.machines),
  );
  const typeLabelInput = h('input', {
    type: 'text',
    required: true,
    maxlength: '40',
    autocomplete: 'off',
    placeholder: 'e.g. Piping machine',
    value: existing && existing.type === 'other' && existing.typeLabel ? existing.typeLabel : '',
  });
  const typeLabelField = field('Machine type', typeLabelInput, 'Your own name for this kind of machine.');
  const modelInput = h('input', { type: 'text', value: base.model || '' });
  const serialInput = h('input', { type: 'text', value: base.serial || '' });
  const locationInput = h('input', { type: 'text', value: base.location || '' });
  const statusSelect = selectFrom(MACHINE_STATUSES, base.status || 'running', (value) => LABELS.machineStatus[value]);
  const notesInput = h('textarea', { rows: 4, value: base.notes || '' });
  // Photos and manuals (SPEC-v3.md sections 4 and 6): one attachments array
  // on the machine record, added with the shared attachments editor. Images
  // show in the machine's photo gallery, PDFs are listed as manuals.
  const attachmentsEditor = createAttachmentsEditor(base.attachments || []);

  typeLabelField.hidden = typeSelect.value !== 'other';
  const syncTypeLabelField = (focus) => {
    const show = typeSelect.value === 'other';
    if (show && typeLabelField.hidden && focus) {
      typeLabelField.hidden = false;
      typeLabelInput.focus();
      return;
    }
    typeLabelField.hidden = !show;
  };
  typeSelect.addEventListener('change', () => syncTypeLabelField(true));

  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Save changes' : 'Add machine');
  form.append(
    errorBox,
    field('Name', nameInput),
    h('div', { class: 'grid-2' }, field('Type', typeSelect), field('Status', statusSelect)),
    typeLabelField,
    h('div', { class: 'grid-2' }, field('Model', modelInput), field('Serial number', serialInput)),
    field('Location', locationInput, 'Line, room, roof, etc.'),
    field('Notes', notesInput),
    sectionTitle('Photos and manuals'),
    attachmentsEditor.element,
    h(
      'div',
      { class: 'form-actions' },
      save,
      h(
        'a',
        { class: 'btn', href: existing ? `#/machines/${encodeURIComponent(existing.id)}` : '#/machines' },
        'Cancel',
      ),
    ),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const name = nameInput.value.trim();
    if (!name) {
      errorBox.textContent = 'Enter a machine name.';
      nameInput.focus();
      return;
    }
    const selectedType = typeSelect.value;
    let type = selectedType;
    let typeLabel = '';
    if (!MACHINE_TYPES.includes(selectedType)) {
      // A "Your types" option: its value is the custom type label.
      type = 'other';
      typeLabel = selectedType.trim();
    }
    if (type === 'other') {
      const label = type === selectedType ? typeLabelInput.value.trim() : typeLabel;
      if (label.trim().length < 2 || label.trim().length > 40) {
        errorBox.textContent = 'Enter a machine type (2 to 40 characters).';
        if (typeLabelField.hidden) typeSelect.focus();
        else typeLabelInput.focus();
        return;
      }
      typeLabel = label.trim();
    }
    const now = nowISO();
    const record = {
      ...base,
      id: existing ? existing.id : uid(),
      name,
      type,
      typeLabel,
      model: modelInput.value.trim(),
      serial: serialInput.value.trim(),
      location: locationInput.value.trim(),
      status: statusSelect.value,
      notes: notesInput.value.trim(),
      attachments: attachmentsEditor.getAttachments(),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    save.disabled = true;
    try {
      await sync.saveRecord('machines', record, existing ? existing.version : null);
      await refreshState();
      toast(existing ? 'Machine saved.' : 'Machine added.');
      navigate(`#/machines/${encodeURIComponent(record.id)}`);
    } catch (error) {
      errorBox.textContent = 'Could not save. Please try again.';
      console.error(error);
    } finally {
      save.disabled = false;
    }
  });

  let dirty = false;
  form.addEventListener('input', () => {
    dirty = true;
  });
  form.addEventListener('change', () => {
    dirty = true;
  });

  return { node: form, isDirty: () => dirty, title: machineFormTitle(existing) };
}

function renderMachineForm(route) {
  const id = route.segments[1];
  const editing = Boolean(id && id !== 'new');
  const existing = editing ? machineById(id) : null;
  setTitle(machineFormTitle(existing));
  if (editing && !existing) {
    return page(
      pageHead('Machine not found'),
      emptyState('That machine does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/machines' }, 'Back to Machines'),
      ]),
    );
  }
  // Read-only roles never see the form (entry buttons are hidden); direct
  // links land on this page. The server stays the authority.
  if (!can('machines', 'write')) {
    return page(
      pageHead(machineFormTitle(existing)),
      emptyState(
        'View only',
        'You need the Machines write permission to add or edit machines.',
        [h('a', { class: 'btn btn-primary', href: '#/machines' }, 'Back to Machines')],
      ),
    );
  }
  const { node: form } = machineFormBody(existing);
  return page(pageHead(machineFormTitle(existing)), form);
}

/* Machine photos and manuals (SPEC-v3.md sections 4 and 6, V3-M4): one
   attachments array on the machine record. Images render in the photo
   gallery; PDFs are listed as manuals with name, size and an Open link. */
function machinePhotos(machine) {
  return (machine.attachments || []).filter(
    (attachment) => attachment && typeof attachment.mime === 'string' && attachment.mime.startsWith('image/'),
  );
}

function machineManuals(machine) {
  return (machine.attachments || []).filter(
    (attachment) => attachment && attachment.mime === 'application/pdf',
  );
}

function machinePhotosNode(machine) {
  const photos = machinePhotos(machine);
  if (photos.length === 0) return h('p', { class: 'muted' }, 'No photos yet.');
  return h('div', { class: 'attach-grid' }, ...photos.map(attachmentNode));
}

function machineManualsNode(machine) {
  const manuals = machineManuals(machine);
  if (manuals.length === 0) return h('p', { class: 'muted' }, 'No manuals yet.');
  return h(
    'ul',
    { class: 'manual-list' },
    ...manuals.map((manual) =>
      h(
        'li',
        { class: 'manual-item' },
        h('span', { class: 'attach-icon', 'aria-hidden': 'true' }, 'PDF'),
        h('span', { class: 'manual-name' }, manual.name || 'File'),
        h('span', { class: 'muted manual-size' }, formatBytes(manual.size)),
        h(
          'a',
          {
            class: 'inline-link',
            href: `/api/files/${encodeURIComponent(manual.fileId)}`,
            target: '_blank',
            rel: 'noopener',
          },
          'Open',
        ),
      ),
    ),
  );
}

function renderMachineDetail(route) {
  const machine = machineById(route.segments[1]);
  setTitle(machine ? machine.name : 'Machine not found');
  if (!machine) {
    return page(
      pageHead('Machine not found'),
      emptyState('That machine does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/machines' }, 'Back to Machines'),
      ]),
    );
  }

  const history = sortWorkOrdersNewest(
    state.workOrders.filter((order) => order.machineId === machine.id),
  );
  const pmTasks = state.pmTasks
    .filter((task) => task.machineId === machine.id)
    .sort((a, b) => pmDueDate(a).localeCompare(pmDueDate(b)));
  const parts = state.parts
    .filter((part) => (part.machineIds || []).includes(machine.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  async function deleteMachine() {
    const open = openJobCount(state.workOrders, machine.id);
    const yes = await showConfirm({
      title: 'Delete this machine?',
      message:
        open > 0
          ? `${machine.name} still has ${open} open service order${open === 1 ? '' : 's'}. The machine will be removed, but its service orders will stay in the log.`
          : `${machine.name} will be removed. Its service order history will stay in the log.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!yes) return;
    await sync.deleteRecord('machines', machine.id, machine.version);
    await refreshState();
    toast('Machine deleted.');
    navigate('#/machines');
  }

  const details = h(
    'dl',
    { class: 'detail-grid' },
    h('dt', {}, 'Type'),
    h('dd', {}, machineTypeLabel(machine)),
    h('dt', {}, 'Status'),
    h('dd', {}, statusPill(machine.status, LABELS.machineStatus)),
    h('dt', {}, 'Model'),
    h('dd', {}, machine.model || '—'),
    h('dt', {}, 'Serial'),
    h('dd', {}, machine.serial || '—'),
    h('dt', {}, 'Location'),
    h('dd', {}, machine.location || '—'),
    h('dt', {}, 'Open service orders'),
    h('dd', {}, String(openJobCount(state.workOrders, machine.id))),
    h('dt', {}, 'Notes'),
    h('dd', { class: 'pre' }, machine.notes || '—'),
  );

  return page(
    h(
      'div',
      { class: 'detail-head' },
      h('div', {}, h('h2', {}, machine.name), h('div', { class: 'row-sub' }, machine.location || '')),
      h('div', { class: 'row-sub' }, statusPill(machine.status, LABELS.machineStatus), isReadOnly('machines') ? viewOnlyBadge() : null),
    ),
    detailMeta(machine),
    conflictBanner('machines', machine.id),
    h(
      'div',
      { class: 'button-row' },
      can('serviceOrders', 'write')
        ? h('a', { class: 'btn btn-primary btn-small', href: `#/jobs/new?machine=${encodeURIComponent(machine.id)}` }, '+ Service order')
        : null,
      can('machines', 'write')
        ? h('a', { class: 'btn btn-small', href: `#/machines/${encodeURIComponent(machine.id)}/edit` }, 'Edit machine')
        : null,
    ),
    h('div', { class: 'card', style: { marginTop: '0.75rem' } }, details),
    sectionTitle('Photos'),
    machinePhotosNode(machine),
    sectionTitle('Manuals'),
    machineManualsNode(machine),
    sectionTitle('Repair history'),
    history.length
      ? h('div', { class: 'list' }, ...history.map(jobRow))
      : h('p', { class: 'muted' }, 'No service orders for this machine yet.'),
    sectionTitle('PM tasks'),
    pmTasks.length
      ? h(
          'div',
          { class: 'list' },
          ...pmTasks.map((task) => {
            const inactive = task.active === false;
            const stateName = inactive ? null : pmState(task);
            const dueLabel = inactive
              ? `Paused · next due ${formatDate(pmDueDate(task))}`
              : `${stateName === 'ok' ? 'Due' : LABELS.pmState[stateName]} ${formatDate(pmDueDate(task))}`;
            return h(
              'a',
              { class: 'row', href: `#/pm/${encodeURIComponent(task.id)}` },
              h(
                'div',
                { class: 'row-main' },
                h('div', { class: 'row-title' }, task.title),
                h('div', { class: 'row-sub' }, `${dueLabel} · every ${task.intervalDays} days`),
              ),
              inactive
                ? statusPill('neutral', { neutral: 'Paused' })
                : statusPill(stateName, LABELS.pmState),
            );
          }),
        )
      : h('p', { class: 'muted' }, 'No PM tasks for this machine.'),
    sectionTitle('Parts that fit'),
    parts.length
      ? h(
          'div',
          { class: 'list' },
          ...parts.map((part) =>
            h(
              'a',
              { class: 'row', href: `#/parts/${encodeURIComponent(part.id)}` },
              h(
                'div',
                { class: 'row-main' },
                h('div', { class: 'row-title' }, part.name),
                h('div', { class: 'row-sub' }, part.partNumber || part.location || ''),
              ),
              h(
                'div',
                { class: 'row-side' },
                isLowStock(part)
                  ? h('span', { class: 'pill status-low' }, 'Low stock')
                  : h('span', { class: 'muted' }, `${toInteger(part.qtyOnHand)} on hand`),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No parts are linked to this machine.'),
    h(
      'div',
      { class: 'form-actions', style: { marginTop: '1.5rem' } },
      can('machines', 'write')
        ? h('button', { class: 'btn btn-danger', type: 'button', onclick: deleteMachine }, 'Delete machine')
        : null,
    ),
    historySection('machines', machine.id),
  );
}

/* ---------- Parts ---------- */

function partRow(part) {
  const low = isLowStock(part);
  const unit = part.unit || 'pcs';
  return h(
    'a',
    { class: 'row', href: `#/parts/${encodeURIComponent(part.id)}` },
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, part.name),
      h(
        'div',
        { class: 'row-sub' },
        [part.partNumber, part.location].filter(Boolean).join(' · ') || 'No part number',
        editedTag(part),
      ),
    ),
    h(
      'div',
      { class: 'row-side' },
      h(
        'span',
        { class: `qty${low ? ' low-text' : ''}` },
        `${toInteger(part.qtyOnHand)} ${unit}`,
      ),
      low ? h('span', { class: 'pill status-low' }, 'Low stock') : null,
      // Row action (SPEC-v4.md 3.3): add this part to a draft request.
      can('purchasing', 'write') ? addToRequestButton(part) : null,
    ),
    h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'),
  );
}

function renderParts(route) {
  setTitle('Parts');
  const lowOnly = route.params.get('low') === '1' || route.params.get('filter') === 'low';
  const listHost = h('div', { class: 'list' });
  const tableHost = h('div', { class: 'table-wrap' });
  let searchQuery = '';
  // Kept current so the low-stock bulk action (SPEC-v4.md 3.3) gathers what
  // the list is actually showing.
  let shownParts = [];

  function update(nextQuery) {
    if (typeof nextQuery === 'string') searchQuery = nextQuery;
    let parts = searchParts(state.parts, searchQuery, state.machines);
    if (lowOnly) parts = parts.filter(isLowStock);
    parts = parts
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    shownParts = parts;
    if (parts.length === 0) {
      listHost.replaceChildren(
        emptyState(
          searchQuery.trim() ? 'No matching parts' : lowOnly ? 'No low-stock parts' : 'No parts yet',
          searchQuery.trim()
            ? 'Try a different search.'
            : lowOnly
              ? 'Everything is above its minimum level.'
              : 'Add needles, blades, sensors and other spares you keep on the shelf.',
          searchQuery.trim() || lowOnly
            ? []
            : can('parts', 'write')
              ? [h('a', { class: 'btn btn-primary', href: '#/parts/new' }, 'Add a part')]
              : [],
        ),
      );
      listHost.classList.remove('cards-only');
      tableHost.replaceChildren();
    } else {
      listHost.replaceChildren(...parts.map(partRow));
      listHost.classList.add('cards-only');
      tableHost.replaceChildren(
        buildDataTable(
          'parts',
          partsTableColumns(),
          parts,
          (part) => `#/parts/${encodeURIComponent(part.id)}`,
          update,
        ),
      );
    }
  }

  update();
  return page(
    pageHead('Parts', headActionFor('parts', h('a', { class: 'btn btn-primary btn-small', href: '#/parts/new' }, '+ Add part'))),
    searchBox('Search parts', (value) => update(value), true),
    h(
      'div',
      { class: 'chips', role: 'group', 'aria-label': 'Filter parts' },
      h(
        'a',
        {
          class: `chip${lowOnly ? ' is-active' : ''}`,
          href: lowOnly ? '#/parts' : '#/parts?low=1',
          'aria-pressed': lowOnly ? 'true' : 'false',
        },
        'Low stock only',
      ),
      // v4 (SPEC-v4.md 3.3): one line per low-stock part on the request,
      // skipping the parts it already lists.
      lowOnly && can('purchasing', 'write')
        ? h(
            'button',
            {
              class: 'btn btn-small',
              type: 'button',
              onclick: () => {
                if (shownParts.length === 0) {
                  toast('No low-stock parts to add.', 'warn');
                  return;
                }
                openAddToRequestPicker({
                  label: 'One line per low-stock part — parts already on the request are skipped.',
                  buildLines: (request) =>
                    buildLowStockRequestLines(shownParts, request ? request.lines : []),
                });
              },
            },
            'Add all low-stock to request',
          )
        : null,
    ),
    listHost,
    tableHost,
  );
}

function renderPartDetail(route) {
  const part = partById(route.segments[1]);
  setTitle(part ? part.name : 'Part not found');
  if (!part) {
    return page(
      pageHead('Part not found'),
      emptyState('That part does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/parts' }, 'Back to Parts'),
      ]),
    );
  }

  const low = isLowStock(part);
  const machines = state.machines.filter((machine) => (part.machineIds || []).includes(machine.id));
  const usedOn = sortWorkOrdersNewest(
    state.workOrders.filter((order) =>
      (order.partsUsed || []).some((item) => item.partId === part.id),
    ),
  );

  async function adjust(delta) {
    const fresh = partById(part.id);
    if (!fresh) return;
    const currentQty = toInteger(fresh.qtyOnHand);
    if (currentQty === 0 && delta < 0) return;
    const updated = await sync.adjustStock(part.id, delta, 'manual');
    const nextQty = updated ? toInteger(updated.qtyOnHand) : currentQty;
    await refreshState();
    toast(`${fresh.name}: ${nextQty} ${fresh.unit || 'pcs'} on hand.`);
    render();
  }

  async function deletePart() {
    const yes = await showConfirm({
      title: 'Delete this part?',
      message: `${part.name} will be removed. Service orders that already used it will keep their record.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!yes) return;
    await sync.deleteRecord('parts', part.id, part.version);
    await refreshState();
    toast('Part deleted.');
    navigate('#/parts');
  }

  const details = h(
    'dl',
    { class: 'detail-grid' },
    h('dt', {}, 'Part number'),
    h('dd', {}, part.partNumber || '—'),
    h('dt', {}, 'Minimum'),
    h('dd', {}, `${toInteger(part.minQty)} ${part.unit || 'pcs'}`),
    h('dt', {}, 'Location'),
    h('dd', {}, part.location || '—'),
    h('dt', {}, 'Supplier'),
    h('dd', {}, part.supplier || '—'),
    h('dt', {}, 'Supplier contact'),
    h('dd', {}, part.supplierContact || '—'),
    h('dt', {}, 'Fits machines'),
    h(
      'dd',
      {},
      machines.length
        ? machines.map((machine, index) => [
            index ? ' · ' : '',
            h(
              'a',
              { class: 'inline-link', href: `#/machines/${encodeURIComponent(machine.id)}` },
              machine.name,
            ),
          ])
        : '—',
    ),
    h('dt', {}, 'Notes'),
    h('dd', { class: 'pre' }, part.notes || '—'),
  );

  return page(
    h(
      'div',
      { class: 'detail-head' },
      h(
        'div',
        {},
        h('h2', {}, part.name),
        h('div', { class: 'row-sub' }, part.partNumber || 'No part number'),
      ),
      h('div', { class: 'row-sub' }, low ? h('span', { class: 'pill status-low' }, 'Low stock') : statusPill('ok', { ok: 'In stock' }), isReadOnly('parts') ? viewOnlyBadge() : null),
    ),
    detailMeta(part),
    conflictBanner('parts', part.id),
    can('parts', 'write')
      ? h(
          'div',
          { class: 'card' },
          h(
            'div',
            { class: 'stock-controls' },
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                'aria-label': `Remove one ${part.name}`,
                disabled: toInteger(part.qtyOnHand) <= 0,
                onclick: () => adjust(-1),
              },
              '−1',
            ),
            h(
              'span',
              { class: `qty-big${low ? ' low-text' : ''}` },
              String(toInteger(part.qtyOnHand)),
            ),
            h('span', { class: 'muted' }, part.unit || 'pcs'),
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                'aria-label': `Add one ${part.name}`,
                onclick: () => adjust(1),
              },
              '+1',
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'button-row', style: { marginTop: '0.75rem' } },
      can('parts', 'write') ? h('a', { class: 'btn btn-small', href: `#/parts/${encodeURIComponent(part.id)}/edit` }, 'Edit part') : null,
      // v4 (SPEC-v4.md 3.3): gather this part into a draft request.
      can('purchasing', 'write')
        ? h(
            'button',
            {
              class: 'btn btn-small',
              type: 'button',
              onclick: () =>
                openAddToRequestPicker({
                  label: `"${part.name}" joins a draft request at ${requestDefaultQty(part)} ${part.unit || 'pcs'}.`,
                  buildLines: () => [partRequestLine(part)],
                }),
            },
            'Add to parts request',
          )
        : null,
    ),
    h('div', { class: 'card', style: { marginTop: '0.75rem' } }, details),
    sectionTitle('Used on service orders'),
    usedOn.length
      ? h(
          'div',
          { class: 'list' },
          ...usedOn.map((order) => {
            const used = (order.partsUsed || []).find((item) => item.partId === part.id);
            return h(
              'a',
              { class: 'row', href: `#/jobs/${encodeURIComponent(order.id)}` },
              h(
                'div',
                { class: 'row-main' },
                h('div', { class: 'row-title' }, order.title),
                h(
                  'div',
                  { class: 'row-sub' },
                  `${machineName(order.machineId)} · ${formatDate(order.reportedAt)}`,
                ),
              ),
              h(
                'div',
                { class: 'row-side' },
                statusPill(order.status, LABELS.status),
                h('span', {}, `Used ${toInteger(used ? used.qty : 0)}`),
              ),
            );
          }),
        )
      : h('p', { class: 'muted' }, 'This part has not been used on a service order yet.'),
    h(
      'div',
      { class: 'form-actions', style: { marginTop: '1.5rem' } },
      can('parts', 'write') ? h('button', { class: 'btn btn-danger', type: 'button', onclick: deletePart }, 'Delete part') : null,
    ),
    historySection('parts', part.id),
  );
}

function renderPartForm(route) {
  const id = route.segments[1];
  const editing = Boolean(id && id !== 'new');
  const existing = editing ? partById(id) : null;
  setTitle(editing ? 'Edit part' : 'Add part');
  if (editing && !existing) {
    return page(
      pageHead('Part not found'),
      emptyState('That part does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/parts' }, 'Back to Parts'),
      ]),
    );
  }
  const base = existing || {
    name: '',
    partNumber: '',
    qtyOnHand: 0,
    minQty: 0,
    unit: 'pcs',
    location: '',
    supplier: '',
    supplierContact: '',
    machineIds: [],
    notes: '',
  };

  const form = h('form', { class: 'form', novalidate: true });
  const errorBox = h('div', { class: 'form-error', role: 'alert' });
  const nameInput = h('input', {
    type: 'text',
    required: true,
    autocomplete: 'off',
    placeholder: 'e.g. Needles DBx1 size 14',
    value: base.name || '',
  });
  const partNumberInput = h('input', { type: 'text', value: base.partNumber || '' });
  const qtyInput = h('input', {
    type: 'number',
    min: 0,
    step: 1,
    inputmode: 'numeric',
    value: String(toInteger(base.qtyOnHand)),
  });
  const minInput = h('input', {
    type: 'number',
    min: 0,
    step: 1,
    inputmode: 'numeric',
    value: String(toInteger(base.minQty)),
  });
  const unitInput = h('input', { type: 'text', value: base.unit || 'pcs' });
  const locationInput = h('input', { type: 'text', value: base.location || '' });
  const supplierInput = h('input', { type: 'text', value: base.supplier || '' });
  const contactInput = h('input', { type: 'text', value: base.supplierContact || '' });
  const notesInput = h('textarea', { rows: 4, value: base.notes || '' });

  const machineChecks = h('div', { class: 'check-list' });
  if (state.machines.length === 0) {
    machineChecks.append(h('p', { class: 'field-hint' }, 'No machines added yet.'));
  } else {
    for (const machine of state.machines
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))) {
      const checkId = `part-machine-${++fieldCounter}`;
      const checkbox = h('input', {
        type: 'checkbox',
        checked: (base.machineIds || []).includes(machine.id),
        value: machine.id,
      });
      checkbox.id = checkId;
      machineChecks.append(
        h(
          'div',
          { class: 'check-row' },
          checkbox,
          h('label', { for: checkId }, machine.name),
        ),
      );
    }
  }

  const machineFieldset = h(
    'fieldset',
    { class: 'field fieldset' },
    h('legend', { class: 'field-label' }, 'Machines this part fits'),
    machineChecks,
  );

  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Save changes' : 'Add part');
  form.append(
    errorBox,
    field('Name', nameInput),
    field('Part number', partNumberInput),
    h('div', { class: 'grid-2' }, field('Quantity on hand', qtyInput), field('Minimum quantity', minInput)),
    h('div', { class: 'grid-2' }, field('Unit', unitInput), field('Location', locationInput)),
    h(
      'div',
      { class: 'grid-2' },
      field('Supplier', supplierInput),
      field('Supplier contact', contactInput, 'Phone or email, shown as selectable text.'),
    ),
    machineFieldset,
    field('Notes', notesInput),
    h(
      'div',
      { class: 'form-actions' },
      save,
      h(
        'a',
        { class: 'btn', href: existing ? `#/parts/${encodeURIComponent(existing.id)}` : '#/parts' },
        'Cancel',
      ),
    ),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const name = nameInput.value.trim();
    if (!name) {
      errorBox.textContent = 'Enter a part name.';
      nameInput.focus();
      return;
    }
    const now = nowISO();
    const record = {
      ...base,
      id: existing ? existing.id : uid(),
      name,
      partNumber: partNumberInput.value.trim(),
      qtyOnHand: toInteger(qtyInput.value),
      minQty: toInteger(minInput.value),
      unit: unitInput.value.trim() || 'pcs',
      location: locationInput.value.trim(),
      supplier: supplierInput.value.trim(),
      supplierContact: contactInput.value.trim(),
      machineIds: [...machineChecks.querySelectorAll('input[type="checkbox"]:checked')].map(
        (input) => input.value,
      ),
      notes: notesInput.value.trim(),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    save.disabled = true;
    try {
      await sync.saveRecord('parts', record, existing ? existing.version : null);
      await refreshState();
      toast(existing ? 'Part saved.' : 'Part added.');
      navigate(`#/parts/${encodeURIComponent(record.id)}`);
    } catch (error) {
      errorBox.textContent = 'Could not save. Please try again.';
      console.error(error);
    } finally {
      save.disabled = false;
    }
  });

  return page(pageHead(editing ? 'Edit part' : 'Add part'), form);
}

/* ---------- Parts requests (SPEC-v4.md sections 2 and 3) ----------
   A request stays a Draft while lines are gathered from parts, low stock,
   service orders or free text; Send turns it into a clean numbered price
   table. Totals are always computed (requestTotals), never stored. */

const REQUEST_STATUS_LABELS = {
  draft: 'Draft',
  sent: 'Sent',
  received: 'Received',
  cancelled: 'Cancelled',
};

const REQUEST_FILTERS = ['draft', 'sent', 'received', 'all'];

/** Drafts and requests newest first (updatedAt, id as the tiebreaker). */
function sortRequestsNewest(requests = []) {
  return requests
    .filter((request) => request && !request.deleted)
    .slice()
    .sort(
      (a, b) =>
        String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')) ||
        String(a.id).localeCompare(String(b.id)),
    );
}

function requestStatusPill(status) {
  return h('span', { class: `pill req-status-${status}` }, REQUEST_STATUS_LABELS[status] || status);
}

/** Filter chip value from the route (SPEC-v4.md 3.1: Draft by default). */
function requestFilterFrom(route) {
  const value = route.params.get('filter') || route.params.get('status') || 'draft';
  return REQUEST_FILTERS.includes(value) ? value : 'draft';
}

function requestTotalText(request) {
  return (request.lines || []).length ? formatMoney(requestTotals(request).totalCents) : null;
}

function requestPhoneCard(request) {
  const lines = (request.lines || []).length;
  return h(
    'a',
    { class: 'row so-card', href: `#/requests/${encodeURIComponent(request.id)}` },
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, request.title),
      h(
        'div',
        { class: 'row-sub' },
        h('span', { class: 'so-number' }, formatRequestNumber(request.number)),
        ` · ${lines} line${lines === 1 ? '' : 's'}`,
        request.neededBy ? ` · needed ${formatDate(request.neededBy)}` : '',
      ),
      editedTag(request),
    ),
    h(
      'div',
      { class: 'row-side' },
      requestStatusPill(request.status),
      requestTotalText(request) ? h('span', { class: 'qty' }, requestTotalText(request)) : null,
    ),
    h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'),
  );
}

function requestsTableColumns() {
  return [
    {
      key: 'number',
      label: 'Number',
      value: (request) => formatRequestNumber(request.number),
      sortValue: (request) => {
        const value = Number(request.number);
        return Number.isFinite(value) ? Math.floor(value) : null;
      },
      cell: (request) => h('span', { class: 'so-number' }, formatRequestNumber(request.number)),
    },
    { key: 'title', label: 'Title', value: (request) => request.title },
    {
      key: 'status',
      label: 'Status',
      value: (request) => REQUEST_STATUS_LABELS[request.status] || request.status,
      cell: (request) => requestStatusPill(request.status),
    },
    {
      key: 'lines',
      label: 'Lines',
      value: (request) => (request.lines || []).length,
      sortValue: (request) => (request.lines || []).length,
    },
    {
      key: 'total',
      label: 'Total',
      value: (request) => requestTotalText(request),
      sortValue: (request) => requestTotals(request).totalCents,
    },
    {
      key: 'neededBy',
      label: 'Needed by',
      value: (request) => (request.neededBy ? formatDate(request.neededBy) : null),
    },
    editedByColumn(),
  ];
}

function renderRequests(route) {
  setTitle('Parts requests');
  // Reaching the list means the gather flow is over (SPEC-v4.md 3.3): any
  // lines waiting for a form are dropped. The form routes consume pending
  // lines before this renders behind the drawer.
  pendingRequestLines = null;
  const filter = requestFilterFrom(route);
  const listHost = h('div', { class: 'list' });
  const tableHost = h('div', { class: 'table-wrap' });
  let searchQuery = '';

  function update(nextQuery) {
    if (typeof nextQuery === 'string') searchQuery = nextQuery;
    let requests = searchPurchaseRequests(state.purchaseRequests, searchQuery);
    // "All" keeps cancelled requests visible; the other chips are statuses.
    requests = sortRequestsNewest(filter === 'all' ? requests : requests.filter((request) => request.status === filter));
    if (requests.length === 0) {
      const filtered = Boolean(searchQuery.trim()) || filter !== 'draft';
      listHost.replaceChildren(
        emptyState(
          searchQuery.trim() ? 'No matching requests' : filtered ? `No ${filter === 'all' ? '' : REQUEST_STATUS_LABELS[filter].toLowerCase() + ' '}requests` : 'No parts requests yet',
          searchQuery.trim()
            ? 'Try a different search.'
            : filter === 'draft'
              ? 'Gather parts you need to buy into a draft request, then send it.'
              : 'Requests you mark with that status show up here.',
          searchQuery.trim() || filter !== 'draft'
            ? []
            : can('purchasing', 'write')
              ? [h('a', { class: 'btn btn-primary', href: '#/requests/new' }, 'New request')]
              : [],
        ),
      );
      listHost.classList.remove('cards-only');
      tableHost.replaceChildren();
    } else {
      listHost.replaceChildren(...requests.map(requestPhoneCard));
      listHost.classList.add('cards-only');
      tableHost.replaceChildren(
        buildDataTable(
          'requests',
          requestsTableColumns(),
          requests,
          (request) => `#/requests/${encodeURIComponent(request.id)}`,
          update,
        ),
      );
    }
  }

  update();
  return page(
    pageHead(
      'Parts requests',
      // New request needs purchasing Write (SPEC-v4.md 3.1).
      headActionFor(
        'purchasing',
        h('a', { class: 'btn btn-primary btn-small', href: '#/requests/new' }, '+ New request'),
      ),
    ),
    searchBox('Search parts requests', (value) => update(value), true),
    h(
      'div',
      { class: 'chips', role: 'group', 'aria-label': 'Filter parts requests' },
      ...REQUEST_FILTERS.map((value) =>
        h(
          'a',
          {
            class: `chip${filter === value ? ' is-active' : ''}`,
            href: value === 'draft' ? '#/requests' : `#/requests?filter=${value}`,
            'aria-pressed': filter === value ? 'true' : 'false',
          },
          value === 'all' ? 'All' : REQUEST_STATUS_LABELS[value],
        ),
      ),
    ),
    listHost,
    tableHost,
  );
}

/* ---------- Request lines editor (SPEC-v4.md 3.2) ----------
   Editable inline rows: #, Description (with catalogue autocomplete),
   Part #, Qty, Unit, Unit price (blank = price unknown), Line total, Machine
   (optional), remove; up/down reorders. Item # follows the order. */

const MAX_REQUEST_LINES = 100;

/** Editor line state: input strings; rawRequestLine() makes it server-safe. */
function normalizeRequestLine(line) {
  const price =
    line && line.unitPrice !== null && line.unitPrice !== undefined ? String(line.unitPrice) : '';
  return {
    id: (line && line.id) || uid(),
    description: String((line && line.description) || ''),
    qty: line && line.qty !== null && line.qty !== undefined ? String(line.qty) : '1',
    unit: String((line && line.unit) || 'pcs'),
    unitPrice: price === '0' ? '0' : price,
    partId: (line && line.partId) || '',
    partNumber: String((line && line.partNumber) || ''),
    supplier: String((line && line.supplier) || ''),
    machineId: (line && line.machineId) || '',
    workOrderId: (line && line.workOrderId) || '',
    note: String((line && line.note) || ''),
  };
}

/** Server-safe line from the editor state (SPEC-v4.md section 2 shape). */
function rawRequestLine(line) {
  const qty = Number(line.qty);
  const priceText = String(line.unitPrice ?? '').trim();
  const price = priceText === '' ? null : Number(priceText);
  const out = {
    id: line.id,
    description: String(line.description || '').trim().slice(0, 200),
    qty: Number.isFinite(qty) && qty > 0 ? Number(qty.toFixed(2)) : 0,
    unit: String(line.unit || '').trim().slice(0, 20) || 'pcs',
    unitPrice: price !== null && Number.isFinite(price) ? Math.max(0, price) : null,
  };
  if (line.partId) out.partId = line.partId;
  if (String(line.partNumber || '').trim()) out.partNumber = line.partNumber.trim().slice(0, 60);
  if (String(line.supplier || '').trim()) out.supplier = line.supplier.trim().slice(0, 120);
  if (line.machineId) out.machineId = line.machineId;
  if (line.workOrderId) out.workOrderId = line.workOrderId;
  if (String(line.note || '').trim()) out.note = line.note.trim().slice(0, 200);
  return out;
}

/** Problems with the current editor lines, shown in the form error box. */
function requestLineProblemsFor(lines) {
  const problems = [];
  (Array.isArray(lines) ? lines : []).forEach((raw, index) => {
    const label = `Line ${index + 1}`;
    if (!String(raw.description || '').trim()) problems.push(`${label} needs a description.`);
    else if (String(raw.description).length > 200) {
      problems.push(`${label} description is longer than 200 characters.`);
    }
    const qty = Number(raw.qty);
    if (!Number.isFinite(qty) || qty <= 0) problems.push(`${label} needs a quantity above 0.`);
    else if (qty > 100000) problems.push(`${label} quantity is above 100000.`);
    if (raw.unit && String(raw.unit).length > 20) problems.push(`${label} unit is longer than 20 characters.`);
    if (raw.unitPrice !== null && raw.unitPrice !== undefined) {
      const price = Number(raw.unitPrice);
      if (!Number.isFinite(price)) problems.push(`${label} price is not a number.`);
      else if (price > 1000000) problems.push(`${label} price is above 1000000.`);
    }
    if (raw.partNumber && String(raw.partNumber).length > 60) {
      problems.push(`${label} part number is longer than 60 characters.`);
    }
  });
  return problems;
}

function createRequestLinesEditor(initialLines = [], { onChange = null, focusLineId = null } = {}) {
  const lines = (initialLines || []).filter(Boolean).map(normalizeRequestLine);
  const listHost = h('div', { class: 'req-lines' });
  const hint = h('p', { class: 'field-hint', role: 'status' });

  function notify() {
    hint.textContent = lines.length >= MAX_REQUEST_LINES ? 'At most 100 lines.' : '';
    if (typeof onChange === 'function') onChange();
  }

/** Editor cell: visible label on phone, header row labels it on wider screens. */
function reqCell(labelText, control, className) {
  return h(
    'div',
    { class: `req-cell ${className}` },
    labelText ? h('span', { class: 'req-cell-label', 'aria-hidden': 'true' }, labelText) : null,
    control,
  );
}

/** One editable row (SPEC-v4.md 3.2): inputs update the line in place. */
function requestLineRow(line, index) {
  const descriptionInput = h('input', {
    type: 'text',
    maxlength: '200',
    value: line.description,
    placeholder: 'What to buy',
    autocomplete: 'off',
    'aria-label': `Line ${index + 1} description`,
    dataset: { lineId: line.id },
  });
  const suggestions = h('div', {
    class: 'req-line-suggest',
    role: 'listbox',
    'aria-label': 'Matching catalogue parts',
  });

    function matches() {
      const needle = descriptionInput.value.trim();
      if (!needle) return [];
      return searchParts(state.parts, needle).slice(0, 8);
    }

    function fillFromPart(part) {
      line.description = part.name || line.description;
      line.partId = part.id || '';
      line.partNumber = part.partNumber || '';
      line.unit = part.unit || 'pcs';
      line.supplier = part.supplier || '';
      // One fitting machine pre-selects itself; more leave the choice open.
      if (!line.machineId && (part.machineIds || []).length === 1) line.machineId = part.machineIds[0];
      suggestions.replaceChildren();
      descriptionInput.value = line.description;
      renderRows();
      descriptionInput.focus();
    }

    function showSuggestions() {
      suggestions.replaceChildren();
      // Typing past a picked part breaks the link; emptying the description
      // drops it, picking a suggestion sets it fresh.
      if (!descriptionInput.value.trim()) line.partId = '';
      const parts = matches();
      let active = -1;
      const options = parts.map((part) =>
        h(
          'button',
          { type: 'button', class: 'req-line-suggest-item', role: 'option' },
          h('span', {}, part.name),
          part.partNumber ? h('span', { class: 'req-line-suggest-no' }, part.partNumber) : null,
        ),
      );
      options.forEach((option, optionIndex) => {
        option.addEventListener('mousedown', (event) => {
          // Before the blur handler clears the list.
          event.preventDefault();
          fillFromPart(parts[optionIndex]);
        });
        suggestions.append(option);
      });
      descriptionInput.setAttribute('aria-expanded', String(options.length > 0));
      descriptionInput.addEventListener('keydown', (event) => {
        if (suggestions.childElementCount === 0) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          active += event.key === 'ArrowDown' ? 1 : -1;
          if (active < 0) active = options.length - 1;
          if (active >= options.length) active = 0;
          options.forEach((option, optionIndex) => {
            option.classList.toggle('is-active', optionIndex === active);
          });
        } else if (event.key === 'Enter' && active >= 0) {
          event.preventDefault();
          fillFromPart(parts[active]);
        } else if (event.key === 'Escape') {
          // Only close the suggestion list; the drawer stays open.
          event.stopPropagation();
          event.preventDefault();
          suggestions.replaceChildren();
        }
      });
    }

    descriptionInput.addEventListener('input', () => {
      line.description = descriptionInput.value;
      showSuggestions();
      notify();
    });
    descriptionInput.addEventListener('blur', () => {
      line.partId = '';
      // Buttons pick with mousedown, so a plain blur just closes the list.
      setTimeout(() => suggestions.replaceChildren(), 120);
    });

    const partNumberInput = h('input', {
      type: 'text',
      maxlength: '60',
      value: line.partNumber,
      'aria-label': `Line ${index + 1} part number`,
      placeholder: 'Catalogue #',
    });
    partNumberInput.addEventListener('input', () => {
      line.partNumber = partNumberInput.value;
      notify();
    });

    const qtyInput = h('input', {
      type: 'number',
      min: '0',
      max: '100000',
      step: '0.01',
      value: line.qty,
      'aria-label': `Line ${index + 1} quantity`,
    });
    qtyInput.addEventListener('input', () => {
      line.qty = qtyInput.value;
      totalText.textContent = requestLineTotalText(line);
      notify();
    });

    const unitInput = h('input', {
      type: 'text',
      maxlength: '20',
      value: line.unit,
      'aria-label': `Line ${index + 1} unit`,
    });
    unitInput.addEventListener('input', () => {
      line.unit = unitInput.value;
      notify();
    });

    const priceInput = h('input', {
      type: 'number',
      min: '0',
      max: '1000000',
      step: '0.01',
      value: line.unitPrice,
      placeholder: 'Unknown',
      'aria-label': `Line ${index + 1} unit price (leave blank when unknown)`,
    });
    priceInput.addEventListener('input', () => {
      line.unitPrice = priceInput.value;
      totalText.textContent = requestLineTotalText(line);
      notify();
    });

    const machineSelect = h('select', { 'aria-label': `Line ${index + 1} machine (optional)` },
      h('option', { value: '' }, '—'),
      ...orderedMachines().map((machine) =>
        machine.id === line.machineId
          ? h('option', { value: machine.id, selected: true }, machine.name)
          : h('option', { value: machine.id }, machine.name),
      ),
    );
    machineSelect.addEventListener('change', () => {
      line.machineId = machineSelect.value;
      notify();
    });

    const totalText = h('span', { class: 'req-line-total tabular' }, requestLineTotalText(line));

    const upButton = h(
      'button',
      {
        class: 'btn btn-ghost btn-small',
        type: 'button',
        'aria-label': `Move line ${index + 1} up`,
        disabled: index === 0,
        onclick: () => moveLine(index, 'up'),
      },
      '↑',
    );
    const downButton = h(
      'button',
      {
        class: 'btn btn-ghost btn-small',
        type: 'button',
        'aria-label': `Move line ${index + 1} down`,
        disabled: index === lines.length - 1,
        onclick: () => moveLine(index, 'down'),
      },
      '↓',
    );
    const removeButton = h(
      'button',
      {
        class: 'btn btn-ghost btn-small',
        type: 'button',
        'aria-label': `Remove line ${index + 1}`,
        onclick: () => {
          lines.splice(index, 1);
          renderRows();
          notify();
        },
      },
      '×',
    );

    return h(
      'div',
      { class: 'req-line-row', dataset: { lineId: line.id } },
      h(
        'div',
        { class: 'req-cell req-cell-n' },
        h('span', { class: 'req-line-no tabular', 'aria-hidden': 'true' }, String(index + 1)),
      ),
      reqCell('Description', h('div', { class: 'req-desc-wrap' }, descriptionInput, suggestions), 'req-cell-desc'),
      reqCell('Part #', partNumberInput, 'req-cell-part'),
      reqCell('Qty', qtyInput, 'req-cell-qty'),
      reqCell('Unit', unitInput, 'req-cell-unit'),
      reqCell('Unit price', priceInput, 'req-cell-price'),
      h(
        'div',
        { class: 'req-cell req-cell-total' },
        h('span', { class: 'req-cell-label', 'aria-hidden': 'true' }, 'Line total'),
        totalText,
      ),
      reqCell('Machine', machineSelect, 'req-cell-machine'),
      h(
        'div',
        { class: 'req-cell req-cell-actions' },
        h('span', { class: 'req-cell-label', 'aria-hidden': 'true' }, 'Order'),
        upButton,
        downButton,
        removeButton,
      ),
    );
  }

  function renderRows({ focusId = null } = {}) {
    const focusIndex = focusId ? lines.findIndex((line) => line.id === focusId) : -1;
    listHost.replaceChildren(...lines.map((line, index) => requestLineRow(line, index)));
    if (focusIndex >= 0) {
      const row = listHost.children[focusIndex];
      const input = row ? row.querySelector('input') : null;
      if (input) {
        // A frame later, so the drawer's own focus-after-open does not win.
        requestAnimationFrame(() => {
          input.focus();
          if (typeof input.select === 'function') input.select();
        });
      }
    }
  }

  function moveLine(index, direction) {
    const to = direction === 'down' ? index + 1 : index - 1;
    if (to < 0 || to >= lines.length) return;
    const next = moveRequestLine(lines, index, direction);
    lines.length = 0;
    lines.push(...next);
    renderRows();
    notify();
  }

  function addLine() {
    if (lines.length >= MAX_REQUEST_LINES) return null;
    const line = normalizeRequestLine({ id: uid(), qty: 1, unit: 'pcs' });
    lines.push(line);
    renderRows({ focusId: line.id });
    notify();
    return line;
  }

  renderRows({ focusId: focusLineId });

  const element = h(
    'div',
    { class: 'req-lines-edit' },
    hint,
    h(
      'div',
      { class: 'req-lines-head', 'aria-hidden': 'true' },
      h('span', { class: 'req-cell req-cell-n' }, '#'),
      h('span', { class: 'req-cell req-cell-desc' }, 'Description'),
      h('span', { class: 'req-cell req-cell-part' }, 'Part #'),
      h('span', { class: 'req-cell req-cell-qty' }, 'Qty'),
      h('span', { class: 'req-cell req-cell-unit' }, 'Unit'),
      h('span', { class: 'req-cell req-cell-price' }, 'Unit price'),
      h('span', { class: 'req-cell req-cell-total' }, 'Line total'),
      h('span', { class: 'req-cell req-cell-machine' }, 'Machine'),
      h('span', { class: 'req-cell req-cell-actions' }, 'Order'),
    ),
    listHost,
    h(
      'div',
      { class: 'req-lines-add' },
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => addLine() }, '+ Add line'),
    ),
  );

  return {
    element,
    addLine,
    getRequestLines: () => lines.map(rawRequestLine),
    requestLineProblems: () => requestLineProblemsFor(lines.map(rawRequestLine)),
  };
}

/** "—" for unknown prices, otherwise the computed line total (SPEC-v4.md 2). */
function requestLineTotalText(line) {
  const raw = rawRequestLine(line);
  if (raw.unitPrice === null) return '—';
  const { lines: computed } = requestTotals({ lines: [raw], hstRate: 0 });
  return formatMoney(computed[0].lineTotalCents) || '—';
}

/* ---------- Request form (SPEC-v4.md 3.2) ----------
   Shared by the full-page form (< 1024 px) and the desktop drawer; returns
   the form node and an isDirty() probe for the drawer's discard check. */

/* Lines gathered from a service order start with an empty description, which
   the server rejects, so they ride along until the form saves (SPEC-v4.md
   3.3): {forId: '<request id>' | 'new', lines: [...]} consumed once. */
let pendingRequestLines = null;

function consumePendingRequestLines(forId) {
  if (!pendingRequestLines || pendingRequestLines.forId !== forId) return [];
  const lines = pendingRequestLines.lines;
  pendingRequestLines = null;
  return lines;
}

/** "Requested by" defaults to the creator's display name (SPEC-v4.md 2). */
function defaultRequesterName() {
  return userDisplayName(teamUser && teamUser.id) || (teamUser && teamUser.displayName) || '';
}

function requestFormTitle(existing) {
  return existing ? 'Edit parts request' : 'New parts request';
}

/** The money footer of the form: subtotal, HST at the typed rate, grand total
 *  and the unpriced-line count (SPEC-v4.md 3.2). */
function requestTotalsNode(stream) {
  const box = h('div', { class: 'req-totals' });
  const paint = (request) => {
    const totals = requestTotals(request);
    const rateLabel = requestHstLabel(request.hstRate);
    box.replaceChildren(
      h(
        'div',
        { class: 'req-total-row' },
        h('span', {}, 'Subtotal before HST'),
        h('span', { class: 'req-total-value tabular' }, formatMoney(totals.subtotalCents)),
      ),
      h(
        'div',
        { class: 'req-total-row' },
        h('span', {}, rateLabel),
        h('span', { class: 'req-total-value tabular' }, formatMoney(totals.hstCents)),
      ),
      h(
        'div',
        { class: 'req-total-row req-total-grand' },
        h('span', {}, 'Grand total'),
        h('span', { class: 'req-total-value tabular' }, formatMoney(totals.totalCents)),
      ),
      totals.unpricedCount > 0
        ? h(
            'div',
            { class: 'req-total-note muted' },
            `${totals.unpricedCount} line${totals.unpricedCount === 1 ? '' : 's'} have no price`,
          )
        : null,
    );
  };
  if (typeof stream === 'function') stream(paint);
  else paint(stream);
  return { box, paint };
}

function requestFormBody({ existing = null } = {}) {
  const base = existing || {
    title: '',
    status: 'draft',
    supplier: '',
    neededBy: '',
    requestedBy: defaultRequesterName(),
    hstRate: 13,
    notes: '',
    lines: [],
    sentAt: null,
    receivedAt: null,
  };
  const form = h('form', { class: 'form', novalidate: true });
  const errorBox = h('div', { class: 'form-error', role: 'alert' });

  const titleInput = h('input', {
    type: 'text',
    required: true,
    maxlength: '120',
    autocomplete: 'off',
    placeholder: 'e.g. Juki needles + belts, Nov',
    value: base.title || '',
  });
  const supplierInput = h('input', {
    type: 'text',
    maxlength: '120',
    autocomplete: 'off',
    value: base.supplier || '',
  });
  const neededByInput = h('input', {
    type: 'date',
    value: isISODate(base.neededBy) ? base.neededBy : '',
  });
  const requestedByInput = h('input', {
    type: 'text',
    maxlength: '80',
    autocomplete: 'off',
    value: base.requestedBy || '',
    placeholder: 'Who asked for these parts',
  });
  const hstRateInput = h('input', {
    type: 'number',
    min: '0',
    max: '30',
    step: '0.01',
    value: base.hstRate === null || base.hstRate === undefined ? 13 : base.hstRate,
  });
  const notesInput = h('textarea', { rows: 3, maxlength: '2000', value: base.notes || '' });

  // Lines gathered elsewhere (SPEC-v4.md 3.3) open pre-attached and focused.
  const extraLines = consumePendingRequestLines(existing ? existing.id : 'new');
  const linesEditor = createRequestLinesEditor(
    [...(base.lines || []), ...extraLines],
    {
      onChange: () => footer.paint(shaped()),
      focusLineId: extraLines.length ? extraLines[0].id : null,
    },
  );

  function currentHstRate() {
    const rate = Number(hstRateInput.value);
    return Number.isFinite(rate) && rate >= 0 && rate <= 30 ? Math.min(rate, 30) : 13;
  }

  function shaped() {
    return {
      lines: linesEditor.getRequestLines(),
      hstRate: currentHstRate(),
    };
  }

  const footer = requestTotalsNode((paint) => {
    paint(shaped());
    hstRateInput.addEventListener('input', () => paint(shaped()));
  });

  const save = h(
    'button',
    { class: 'btn btn-primary', type: 'submit' },
    existing ? 'Save changes' : 'Create request',
  );

  form.append(
    errorBox,
    field('Title', titleInput),
    h('div', { class: 'grid-2' }, field('Supplier', supplierInput), field('Needed by', neededByInput)),
    h('div', { class: 'grid-2' }, field('Requested by', requestedByInput), field('HST %', hstRateInput, 'Ontario HST is 13.')),
    field('Notes', notesInput, 'Printed under the table on the request sheet.'),
    sectionTitle('Lines'),
    linesEditor.element,
    footer.box,
    h(
      'div',
      { class: 'form-actions' },
      save,
      h(
        'a',
        { class: 'btn', href: existing ? `#/requests/${encodeURIComponent(existing.id)}` : '#/requests' },
        'Cancel',
      ),
    ),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const problems = [];
    const title = titleInput.value.trim();
    if (!title) problems.push('Enter a title.');
    else if (title.length > 120) problems.push('The title is longer than 120 characters.');
    const rate = Number(hstRateInput.value);
    if (hstRateInput.value !== '' && (!Number.isFinite(rate) || rate < 0 || rate > 30 || Number(rate.toFixed(2)) !== rate)) {
      problems.push('HST % must be between 0 and 30, with at most 2 decimals.');
    }
    if (neededByInput.value && !isISODate(neededByInput.value)) {
      problems.push('Needed by is not a valid date.');
    }
    const lines = linesEditor.getRequestLines();
    if (lines.length > MAX_REQUEST_LINES) problems.push(`At most ${MAX_REQUEST_LINES} lines.`);
    problems.push(...linesEditor.requestLineProblems());
    if (problems.length > 0) {
      errorBox.textContent = problems[0];
      return;
    }
    const now = nowISO();
    const record = {
      ...base,
      id: existing ? existing.id : uid(),
      title,
      supplier: supplierInput.value.trim().slice(0, 120),
      neededBy: neededByInput.value || null,
      requestedBy: requestedByInput.value.trim().slice(0, 80),
      hstRate: hstRateInput.value === '' ? 13 : Math.min(Math.max(rate, 0), 30),
      notes: notesInput.value.trim(),
      lines,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    save.disabled = true;
    try {
      await sync.saveRecord('purchaseRequests', record, existing ? existing.version : null);
      await refreshState();
      toast(existing ? 'Request saved.' : 'Request created.');
      navigate(`#/requests/${encodeURIComponent(record.id)}`);
    } catch (error) {
      errorBox.textContent = 'Could not save. Please try again.';
      console.error(error);
    } finally {
      save.disabled = false;
    }
  });

  let dirty = extraLines.length > 0;
  form.addEventListener('input', () => {
    dirty = true;
  });
  form.addEventListener('change', () => {
    dirty = true;
  });

  return { node: form, isDirty: () => dirty, title: requestFormTitle(existing) };
}

/** Full-page form route (< 1024 px); desktop opens the drawer instead. */
function renderRequestFormPage(route, existing) {
  const second = route.segments[1];
  if (second && second !== 'new' && !existing) {
    setTitle('Request not found');
    return page(
      pageHead('Request not found'),
      emptyState('That parts request does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/requests' }, 'Back to Parts requests'),
      ]),
    );
  }
  const { node } = requestFormBody({ existing });
  return page(pageHead(requestFormTitle(existing)), node);
}

/* The request form opens in the drawer on desktop (SPEC-v4.md 3.2); phones
   and tablets keep the full-page form. */
function maybeOpenRequestDrawer(route) {
  if (!desktopMedia.matches) return false;
  if (!can('purchasing', 'write')) return false;
  const second = route.segments[1];
  if (second === 'new') {
    const { node, isDirty } = requestFormBody({ existing: null });
    openDrawer({ title: requestFormTitle(null), content: node, isDirty });
    return true;
  }
  if (route.segments[2] !== 'edit') return false;
  const existing = requestById(second);
  if (!existing) return false;
  const { node, isDirty } = requestFormBody({ existing });
  openDrawer({ title: requestFormTitle(existing), content: node, isDirty });
  return true;
}

/* ---------- Request detail (SPEC-v4.md 3.2) ----------
   Read view plus one-click status actions; read-only roles see everything
   with no edit controls or status buttons. */

/** Field changes a status action makes (SPEC-v4.md 2: sentAt/receivedAt are
 *  set by the client when the status changes). */
function requestStatusPatch(request, status) {
  const now = nowISO();
  if (status === 'sent') return { status, sentAt: now };
  if (status === 'received') return { status, sentAt: request.sentAt || now, receivedAt: now };
  if (status === 'draft') return { status, receivedAt: null };
  return { status };
}

const REQUEST_STATUS_TOAST = {
  draft: 'Back to draft.',
  sent: 'Request marked sent.',
  received: 'Request marked received.',
  cancelled: 'Request cancelled.',
};

async function changeRequestStatus(request, status) {
  if (status === request.status) return;
  const totals = requestTotals(request);
  // Mark sent asks again while lines have no price (SPEC-v4.md 3.2).
  if (status === 'sent' && totals.unpricedCount > 0) {
    const yes = await showConfirm({
      title: 'Send without prices?',
      message: `${totals.unpricedCount} line${totals.unpricedCount === 1 ? '' : 's'} still ${totals.unpricedCount === 1 ? 'has' : 'have'} no price. You can add prices after the supplier replies.`,
      confirmText: 'Mark sent',
      cancelText: 'Keep editing',
    });
    if (!yes) return;
  }
  if (status === 'cancelled') {
    const yes = await showConfirm({
      title: 'Cancel this request?',
      message: 'It stays on record marked Cancelled and can still be printed.',
      confirmText: 'Cancel request',
      cancelText: 'Keep it',
      danger: true,
    });
    if (!yes) return;
  }
  const next = { ...request, ...requestStatusPatch(request, status), updatedAt: nowISO() };
  try {
    await sync.saveRecord('purchaseRequests', next, request.version);
    await refreshState();
    toast(REQUEST_STATUS_TOAST[status] || 'Request updated.');
    render();
  } catch (error) {
    console.error(error);
    toast('Could not save the status change. Please try again.', 'warn');
  }
}

/** Status transition buttons by status (SPEC-v4.md 3.2). */
function requestStatusButtons(request) {
  if (!can('purchasing', 'write')) return null;
  const buttons = [];
  if (request.status === 'draft') {
    buttons.push(
      h(
        'button',
        { class: 'btn btn-primary', type: 'button', onclick: () => changeRequestStatus(request, 'sent') },
        'Mark sent',
      ),
    );
  }
  if (request.status === 'sent') {
    buttons.push(
      h(
        'button',
        { class: 'btn btn-primary', type: 'button', onclick: () => changeRequestStatus(request, 'received') },
        'Mark received',
      ),
    );
    buttons.push(
      h(
        'button',
        { class: 'btn', type: 'button', onclick: () => changeRequestStatus(request, 'draft') },
        'Back to draft',
      ),
    );
  }
  if (request.status !== 'cancelled') {
    buttons.push(
      h(
        'button',
        { class: 'btn btn-danger', type: 'button', onclick: () => changeRequestStatus(request, 'cancelled') },
        'Cancel request',
      ),
    );
  }
  if (buttons.length === 0) return null;
  return h('div', { class: 'status-buttons', role: 'group', 'aria-label': 'Request status' }, ...buttons);
}

/** Read-only lines: a table on desktop, stacked cards on phone. */
function requestLinesView(request) {
  const totals = requestTotals(request);
  const machineNames = new Map(state.machines.map((machine) => [machine.id, machine.name]));
  const lines = (request.lines || []).filter(Boolean);

  const table = h(
    'div',
    { class: 'table-wrap req-lines-wrap' },
    h(
      'table',
      { class: 'data-table req-lines-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, '#'),
          h('th', { scope: 'col' }, 'Description'),
          h('th', { scope: 'col' }, 'Part #'),
          h('th', { scope: 'col' }, 'Qty'),
          h('th', { scope: 'col' }, 'Unit'),
          h('th', { scope: 'col' }, 'Unit price'),
          h('th', { scope: 'col' }, 'Line total'),
          h('th', { scope: 'col' }, 'Machine'),
        ),
      ),
      h(
        'tbody',
        {},
        ...lines.map((line, index) => {
          const priced = line.unitPrice !== null && line.unitPrice !== undefined;
          const lineTotal = totals.lines[index] ? totals.lines[index].lineTotalCents : null;
          return h(
            'tr',
            {},
            h('td', { 'data-col': 'n', class: 'tabular' }, String(index + 1)),
            h('td', { 'data-col': 'description' }, line.description),
            h('td', { 'data-col': 'part' }, line.partNumber || '—'),
            h('td', { 'data-col': 'qty', class: 'tabular' }, String(line.qty)),
            h('td', { 'data-col': 'unit' }, line.unit || 'pcs'),
            h('td', { 'data-col': 'price', class: 'tabular' }, priced ? formatMoney(dollarsToCents(line.unitPrice)) : '—'),
            h(
              'td',
              { 'data-col': 'total', class: 'tabular' },
              priced ? formatMoney(lineTotal) : '—',
            ),
            h(
              'td',
              { 'data-col': 'machine' },
              line.machineId && machineNames.get(line.machineId)
                ? h(
                    'a',
                    { class: 'inline-link', href: `#/machines/${encodeURIComponent(line.machineId)}` },
                    machineNames.get(line.machineId),
                  )
                : '—',
            ),
          );
        }),
      ),
    ),
  );

  const cards = h(
    'div',
    { class: 'list cards-only req-lines-cards' },
    ...lines.map((line, index) => {
      const priced = line.unitPrice !== null && line.unitPrice !== undefined;
      const lineTotal = totals.lines[index] ? totals.lines[index].lineTotalCents : null;
      return h(
        'div',
        { class: 'req-line-card' },
        h(
          'div',
          { class: 'req-line-card-head' },
          h('span', { class: 'req-line-no tabular' }, String(index + 1)),
          h('span', { class: 'req-line-card-title' }, line.description),
        ),
        h(
          'div',
          { class: 'row-sub' },
          [
            line.partNumber,
            line.machineId && machineNames.get(line.machineId)
              ? machineNames.get(line.machineId)
              : '',
          ]
            .filter(Boolean)
            .join(' · ') || '—',
        ),
        h(
          'div',
          { class: 'req-line-card-meta tabular' },
          priced
            ? `${line.qty} ${line.unit || 'pcs'} · ${formatMoney(dollarsToCents(line.unitPrice))} · ${formatMoney(lineTotal)}`
            : `${line.qty} ${line.unit || 'pcs'} · price to be confirmed`,
        ),
      );
    }),
  );

  return h('div', {}, cards, table);
}

function renderRequestDetail(route) {
  const request = requestById(route.segments[1]);
  setTitle(request ? request.title : 'Request not found');
  if (!request) {
    return page(
      pageHead('Request not found'),
      emptyState('That parts request does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/requests' }, 'Back to Parts requests'),
      ]),
    );
  }

  const canWrite = can('purchasing', 'write');
  const lines = (request.lines || []).filter(Boolean);

  const details = h(
    'dl',
    { class: 'detail-grid' },
    h('dt', {}, 'Number'),
    h('dd', {}, formatRequestNumber(request.number)),
    h('dt', {}, 'Status'),
    h('dd', {}, requestStatusPill(request.status)),
    h('dt', {}, 'Supplier'),
    h('dd', {}, request.supplier || '—'),
    h('dt', {}, 'Requested by'),
    h('dd', {}, request.requestedBy || '—'),
    h('dt', {}, 'Needed by'),
    h('dd', {}, request.neededBy ? formatDate(request.neededBy) : '—'),
    h('dt', {}, 'Sent'),
    h('dd', {}, request.sentAt ? formatBackupStamp(request.sentAt) : '—'),
    h('dt', {}, 'Received'),
    h('dd', {}, request.receivedAt ? formatBackupStamp(request.receivedAt) : '—'),
    h('dt', {}, 'HST'),
    h('dd', {}, requestHstLabel(request.hstRate)),
  );

  return page(
    h(
      'div',
      { class: 'detail-head' },
      h(
        'div',
        {},
        h('h2', {}, request.title),
        h('div', { class: 'row-sub' }, formatRequestNumber(request.number)),
      ),
      h(
        'div',
        { class: 'row-sub' },
        requestStatusPill(request.status),
        isReadOnly('purchasing') ? viewOnlyBadge() : null,
      ),
    ),
    detailMeta(request),
    conflictBanner('purchaseRequests', request.id),
    requestStatusButtons(request),
    h(
      'div',
      { class: 'button-row', style: { marginTop: '0.75rem' } },
      canWrite
        ? h('a', { class: 'btn btn-small', href: `#/requests/${encodeURIComponent(request.id)}/edit` }, 'Edit request')
        : null,
      h('a', { class: 'btn btn-small', href: `#/requests/${encodeURIComponent(request.id)}/sheet` }, 'View sheet'),
    ),
    h('div', { class: 'card', style: { marginTop: '0.75rem' } }, details),
    sectionTitle('Lines'),
    requestLinesView(request),
    requestTotalsNode(request).box,
    request.notes
      ? h('div', { class: 'card pre', style: { marginTop: '0.75rem' } }, request.notes)
      : null,
    historySection('purchaseRequests', request.id),
  );
}

/* ---------- Request sheet (SPEC-v4.md 3.4) ----------
   A plain white printable page; @media print rules in styles.css hide the
   app chrome and the screen-only buttons. */

async function copyRequestSheet(request) {
  const totals = requestTotals(request);
  const options = { machines: state.machines };
  const html = requestSheetHTML(request, totals, options);
  const plain = requestSheetTSV(request, totals, options);
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
  // The Clipboard API needs a secure context and permission; offer the CSV
  // download instead of failing silently (SPEC-v4.md 3.4).
  if (!clipboard || typeof clipboard.write !== 'function' || typeof window.ClipboardItem !== 'function') {
    toast('Copying tables is not available here — use Download CSV instead.', 'warn');
    return;
  }
  try {
    await clipboard.write([
      new window.ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      }),
    ]);
    toast('Table copied — paste it into an email or a spreadsheet.');
  } catch (error) {
    console.warn('Clipboard write failed:', error);
    toast('Could not copy the table. Use Download CSV instead.', 'warn');
  }
}

function downloadRequestSheetCSV(request) {
  const csv = requestSheetCSV(request, requestTotals(request), { machines: state.machines });
  const number = formatRequestNumber(request.number).toLowerCase();
  downloadFile(`parts-request-${number}-${todayISO()}.csv`, 'text/csv;charset=utf-8', csv);
  toast('CSV downloaded.');
}

function renderRequestSheetPage(route) {
  const request = requestById(route.segments[1]);
  setTitle(request ? `Request sheet ${formatRequestNumber(request.number)}` : 'Request not found');
  if (!request) {
    return page(
      pageHead('Request not found'),
      emptyState('That parts request does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/requests' }, 'Back to Parts requests'),
      ]),
    );
  }

  const totals = requestTotals(request);
  const rows = requestSheetRows(request, totals, { machines: state.machines });
  const footer = requestSheetTotals(request, totals);
  const logoUrl = brandLogoUrl();

  const table = h(
    'table',
    { class: 'pr-sheet-table' },
    h('thead', {}, h('tr', {}, ...REQUEST_SHEET_COLUMNS.map((label) => h('th', { scope: 'col' }, label)))),
    h(
      'tbody',
      {},
      ...rows.map((row) =>
        h(
          'tr',
          {},
          h('td', { class: 'pr-sheet-n tabular' }, row.number),
          h('td', { class: 'pr-sheet-desc' }, row.description),
          h('td', { class: 'pr-sheet-qty tabular' }, row.qty),
          h('td', { class: 'pr-sheet-unit' }, row.unit),
          h('td', { class: 'pr-sheet-price tabular' }, row.unitPrice),
          h('td', { class: 'pr-sheet-total tabular' }, row.totalPrice),
        ),
      ),
    ),
    h(
      'tfoot',
      {},
      ...[footer.beforeHst, footer.hst, footer.grand].map(({ label, value }) =>
        h(
          'tr',
          {},
          h('td', { colspan: '5', class: 'pr-sheet-total-label' }, label),
          h('td', { class: 'pr-sheet-total-value tabular' }, value),
        ),
      ),
    ),
  );

  const metaRow = (label, value) =>
    value
      ? h('span', { class: 'pr-sheet-meta-item' }, h('span', { class: 'pr-sheet-meta-label' }, label), ' ', value)
      : null;

  const sheet = h(
    'div',
    { class: 'pr-sheet' },
    h(
      'div',
      { class: 'pr-sheet-head' },
      h(
        'div',
        { class: 'pr-sheet-brand' },
        logoUrl
          ? h('img', { class: 'pr-sheet-logo', src: logoUrl, alt: brandName() })
          : h('span', { class: 'pr-sheet-mark' }, initialsOf(brandName()) || 'CM'),
        h('span', { class: 'pr-sheet-brand-name' }, brandName()),
      ),
      h(
        'div',
        { class: 'pr-sheet-title' },
        h('span', { class: 'pr-sheet-title-word' }, 'PURCHASE REQUEST'),
        h('span', { class: 'pr-sheet-title-number' }, formatRequestNumber(request.number)),
      ),
    ),
    h(
      'div',
      { class: 'pr-sheet-meta' },
      metaRow('Title:', request.title),
      metaRow('Requested by:', request.requestedBy),
      metaRow('Date:', request.createdAt ? formatDate(String(request.createdAt).slice(0, 10)) : ''),
      metaRow('Needed by:', request.neededBy ? formatDate(request.neededBy) : ''),
      metaRow('Supplier:', request.supplier),
    ),
    table,
    footer.unpricedCount > 0 ? h('p', { class: 'pr-sheet-footnote' }, 'Price to be confirmed') : null,
    request.notes ? h('p', { class: 'pr-sheet-notes' }, request.notes) : null,
  );

  return page(
    h(
      'div',
      { class: 'sheet-actions button-row', role: 'group', 'aria-label': 'Request sheet actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => window.print() }, 'Print / Save as PDF'),
      h('button', { class: 'btn', type: 'button', onclick: () => copyRequestSheet(request) }, 'Copy table'),
      h('button', { class: 'btn', type: 'button', onclick: () => downloadRequestSheetCSV(request) }, 'Download CSV'),
      h('a', { class: 'btn', href: `#/requests/${encodeURIComponent(request.id)}` }, 'Back to request'),
    ),
    sheet,
  );
}

/* ---------- Gathering lines from other pages (SPEC-v4.md 3.3) ----------
   One shared picker: the open draft requests (newest first) plus "New
   request…". Complete lines append and save at once; lines without a
   description (from a service order) open attached to the form, focused. */

async function addLinesToRequest(request, lines) {
  const clean = (Array.isArray(lines) ? lines : []).filter(Boolean);
  if (clean.length === 0) {
    toast('Nothing to add.', 'warn');
    return;
  }
  // An empty description is rejected server-side (SPEC-v4.md 2), so those
  // lines ride along into the form, description focused (SPEC-v4.md 3.3).
  if (clean.some((line) => !String(line.description || '').trim())) {
    pendingRequestLines = { forId: request.id, lines: clean.map(normalizeRequestLine) };
    navigate(`#/requests/${encodeURIComponent(request.id)}/edit`);
    return;
  }
  if ((request.lines || []).length + clean.length > MAX_REQUEST_LINES) {
    toast('That request already has the most lines (100).', 'warn');
    return;
  }
  const next = { ...request, lines: [...(request.lines || []), ...clean], updatedAt: nowISO() };
  try {
    const saved = await sync.saveRecord('purchaseRequests', next, request.version);
    await refreshState();
    toast(`Added to ${formatRequestNumber(saved && saved.number !== undefined ? saved.number : next.number)}.`);
  } catch (error) {
    console.error(error);
    toast('Could not add to the request. Please try again.', 'warn');
  }
}

function openAddToRequestPicker({ buildLines = null, label = null } = {}) {
  // Adding lines needs purchasing Write (SPEC-v4.md 2/3.3).
  if (!can('purchasing', 'write')) return;
  const drafts = sortRequestsNewest(state.purchaseRequests.filter((request) => request.status === 'draft'));
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const close = () => {
    document.removeEventListener('keydown', onKey);
    // The picker removes every node it added (SPEC-v4.md section 6).
    dialogRoot.replaceChildren();
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const linesFor = (request) =>
    typeof buildLines === 'function' ? (buildLines(request) || []).filter(Boolean) : [];

  const newButton = h('button', { class: 'btn btn-primary', type: 'button' }, 'New request…');
  newButton.addEventListener('click', () => {
    const lines = linesFor(null);
    close();
    if (lines.length === 0) {
      toast('Nothing to add.', 'warn');
      return;
    }
    pendingRequestLines = { forId: 'new', lines: lines.map(normalizeRequestLine) };
    navigate('#/requests/new');
  });

  const rows = drafts.map((request) => {
    const button = h(
      'button',
      { class: 'picker-row', type: 'button' },
      h('span', { class: 'picker-number so-number' }, formatRequestNumber(request.number)),
      h('span', { class: 'picker-title' }, request.title),
      h('span', { class: 'picker-lines muted small' }, `${(request.lines || []).length} lines`),
    );
    button.addEventListener('click', () => {
      const lines = linesFor(request);
      close();
      addLinesToRequest(request, lines);
    });
    return button;
  });

  const dialog = h(
    'div',
    { class: 'dialog picker-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'picker-title' },
    h('h2', { id: 'picker-title' }, 'Add to parts request'),
    label ? h('p', { class: 'muted' }, label) : null,
    rows.length
      ? h('div', { class: 'picker-list' }, ...rows)
      : h('p', { class: 'muted' }, 'No open draft requests yet.'),
    newButton,
    h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel')),
  );
  const backdrop = h('div', { class: 'dialog-backdrop' }, dialog);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  dialogRoot.replaceChildren(backdrop);
  const first = dialog.querySelector('.picker-row') || newButton;
  if (first && typeof first.focus === 'function') first.focus();
}

/** Empty starting line for a service order (SPEC-v4.md 3.3): workOrderId and
 *  machineId set, description filled in the form. */
function serviceOrderRequestLine(order) {
  return normalizeRequestLine({
    description: '',
    qty: 1,
    unit: 'pcs',
    workOrderId: order.id,
    machineId: order.machineId || '',
  });
}

/** "Request parts" on a service order (SPEC-v4.md 3.3). */
function requestPartsForOrder(order) {
  openAddToRequestPicker({
    label: `A line for ${formatOrderNumber(order.number)} — describe what you need.`,
    buildLines: () => [serviceOrderRequestLine(order)],
  });
}

/** Row-level "Add to parts request" action on part rows (SPEC-v4.md 3.3). */
function addToRequestButton(part) {
  return h(
    'button',
    {
      class: 'btn btn-ghost btn-small add-request-action',
      type: 'button',
      'aria-label': `Add ${part.name} to a parts request`,
      title: 'Add to parts request',
      onclick: (event) => {
        // Do not open the part; open the picker.
        event.preventDefault();
        event.stopPropagation();
        openAddToRequestPicker({
          label: `"${part.name}" joins a draft request at ${requestDefaultQty(part)} ${part.unit || 'pcs'}.`,
          buildLines: () => [partRequestLine(part)],
        });
      },
    },
    '+ request',
  );
}

/** Qty a part line starts at: back to the minimum level, at least 1. */
function requestDefaultQty(part) {
  const need = partRequestLine(part);
  return need ? need.qty : 1;
}

/* ---------- People: coworkers (SPEC-v3.md sections 5 and 13) ---------- */

const PEOPLE_FILTERS = ['active', 'inactive', 'all'];
const PEOPLE_FILTER_LABELS = { active: 'Active', inactive: 'Inactive', all: 'All' };
const PERSON_ACTIVE_LABELS = { active: 'Active', inactive: 'Inactive' };

function peopleFilterFrom(route) {
  const requested = route.params.get('filter') || 'active';
  return PEOPLE_FILTERS.includes(requested) ? requested : 'active';
}

function activePill(record) {
  return statusPill(record && record.active === false ? 'inactive' : 'active', PERSON_ACTIVE_LABELS);
}

function shiftLabel(coworker) {
  return coworker && coworker.shift ? LABELS.coworkerShift[coworker.shift] || coworker.shift : '';
}

function linkedAccountLabel(coworker) {
  if (!coworker || !coworker.linkedUserId) return null;
  const user = teamUserById(coworker.linkedUserId);
  if (!user) return 'Linked account (not in the user list)';
  return user.username ? `${user.displayName} (@${user.username})` : user.displayName;
}

/* Service orders a person worked on (SPEC-v3.md section 5): assignee or
   labour entry with that kind and id. */
function personServiceOrders(personKind, personId) {
  return state.workOrders.filter((order) => {
    const assignees = Array.isArray(order.assignees) ? order.assignees : [];
    if (assignees.some((entry) => entry && entry.kind === personKind && entry.id === personId)) {
      return true;
    }
    const labour = Array.isArray(order.labour) ? order.labour : [];
    return labour.some((entry) => entry && entry.kind === personKind && entry.personId === personId);
  });
}

function activeTableColumn() {
  return {
    key: 'active',
    label: 'Active',
    value: (record) => (record.active === false ? 'Inactive' : 'Active'),
    cell: (record) => activePill(record),
    sortValue: (record) => (record.active === false ? 1 : 0),
  };
}

function coworkersTableColumns() {
  return [
    { key: 'name', label: 'Name', value: (coworker) => coworker.name },
    { key: 'role', label: 'Role', value: (coworker) => coworker.role },
    {
      key: 'shift',
      label: 'Shift',
      value: (coworker) => shiftLabel(coworker),
      cell: (coworker) => (shiftLabel(coworker) ? h('span', {}, shiftLabel(coworker)) : h('span', { class: 'muted' }, '—')),
    },
    { key: 'phone', label: 'Phone', value: (coworker) => coworker.phone },
    { key: 'email', label: 'Email', value: (coworker) => coworker.email },
    { key: 'skills', label: 'Skills', value: (coworker) => coworker.skills },
    activeTableColumn(),
    editedByColumn(),
  ];
}

function coworkerCard(coworker) {
  return h(
    'div',
    { class: 'person-card card' },
    h(
      'a',
      { class: 'row person-row', href: `#/coworkers/${encodeURIComponent(coworker.id)}` },
      h(
        'div',
        { class: 'row-main' },
        h('div', { class: 'row-title' }, coworker.name),
        h(
          'div',
          { class: 'row-sub' },
          [coworker.role, shiftLabel(coworker)].filter(Boolean).join(' · ') || 'Coworker',
          editedTag(coworker),
        ),
      ),
      h('div', { class: 'row-side' }, activePill(coworker)),
      h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'),
    ),
    coworker.phone || coworker.email
      ? h(
          'div',
          { class: 'contact-list' },
          coworker.phone ? contactValue('tel', coworker.phone) : null,
          coworker.email ? contactValue('mailto', coworker.email) : null,
        )
      : null,
  );
}

function renderCoworkers(route) {
  setTitle('Coworkers');
  const activeFilter = peopleFilterFrom(route);
  const listHost = h('div', { class: 'list people-list' });
  const tableHost = h('div', { class: 'table-wrap' });
  let searchQuery = '';

  function update(nextQuery) {
    if (typeof nextQuery === 'string') searchQuery = nextQuery;
    const coworkers = contactSearch(state.coworkers, searchQuery, [
      'name',
      'role',
      'phone',
      'email',
      'skills',
    ])
      .filter(
        (coworker) =>
          activeFilter === 'all' || (activeFilter === 'active') === (coworker.active !== false),
      )
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (coworkers.length === 0) {
      listHost.replaceChildren(
        emptyState(
          searchQuery || activeFilter !== 'all' ? 'No matching coworkers' : 'No coworkers yet',
          searchQuery
            ? 'Try a different search.'
            : activeFilter !== 'all'
              ? 'No coworkers in this filter.'
              : 'Add the people who work on your machines: roles, shifts, skills and contact details.',
          [
            searchQuery || activeFilter !== 'all'
              ? h('a', { class: 'btn', href: '#/coworkers?filter=all' }, 'Show all coworkers')
              : null,
            can('coworkers', 'write')
              ? h('a', { class: 'btn btn-primary', href: '#/coworkers/new' }, 'Add coworker')
              : null,
          ],
        ),
      );
      listHost.classList.remove('cards-only');
      tableHost.replaceChildren();
    } else {
      listHost.replaceChildren(...coworkers.map(coworkerCard));
      listHost.classList.add('cards-only');
      tableHost.replaceChildren(
        buildDataTable(
          'coworkers',
          coworkersTableColumns(),
          coworkers,
          (coworker) => `#/coworkers/${encodeURIComponent(coworker.id)}`,
          update,
        ),
      );
    }
  }

  update();
  const chips = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': 'Filter coworkers' },
    PEOPLE_FILTERS.map((value) =>
      h(
        'a',
        {
          class: `chip${value === activeFilter ? ' is-active' : ''}`,
          href: value === 'active' ? '#/coworkers' : `#/coworkers?filter=${value}`,
          'aria-pressed': value === activeFilter ? 'true' : 'false',
        },
        PEOPLE_FILTER_LABELS[value],
      ),
    ),
  );

  return page(
    pageHead(
      'Coworkers',
      isReadOnly('coworkers') ? viewOnlyBadge() : null,
      can('coworkers', 'write')
        ? h('a', { class: 'btn btn-primary btn-small', href: '#/coworkers/new' }, '+ Add coworker')
        : null,
    ),
    searchBox('Search coworkers', (value) => update(value)),
    chips,
    listHost,
    tableHost,
  );
}

/* Coworker form body shared by the full page (< 1024 px) and the desktop
   drawer (SPEC-v3.md section 5). Returns the form node plus an isDirty()
   probe for the drawer's discard check. */
function coworkerFormTitle(existing) {
  return existing ? 'Edit coworker' : 'Add coworker';
}

function linkedUserSelect(selectedId) {
  const select = h('select', {});
  const blank = h('option', { value: '' }, 'No linked account');
  select.append(blank);
  const users = teamUsers
    .filter((user) => user && !user.disabled)
    .sort((a, b) =>
      String(a.displayName || '').localeCompare(String(b.displayName || ''), undefined, {
        sensitivity: 'base',
      }),
    );
  for (const user of users) {
    const option = h(
      'option',
      { value: user.id },
      user.username ? `${user.displayName} (@${user.username})` : user.displayName,
    );
    if (user.id === selectedId) option.selected = true;
    select.append(option);
  }
  if (selectedId && !users.some((user) => user.id === selectedId)) {
    const option = h('option', { value: selectedId }, 'Linked account (not in the list)');
    option.selected = true;
    select.append(option);
  }
  return select;
}

function coworkerFormBody(existing) {
  const base = existing || {
    name: '',
    role: '',
    phone: '',
    email: '',
    shift: '',
    skills: '',
    linkedUserId: null,
    active: true,
    notes: '',
  };
  const form = h('form', { class: 'form', novalidate: true });
  const errorBox = h('div', { class: 'form-error', role: 'alert' });
  const nameInput = h('input', {
    type: 'text',
    required: true,
    maxlength: '80',
    autocomplete: 'off',
    placeholder: 'e.g. Ana Cruz',
    value: base.name || '',
  });
  const roleInput = h('input', {
    type: 'text',
    maxlength: '60',
    autocomplete: 'off',
    placeholder: 'e.g. Line supervisor',
    value: base.role || '',
  });
  const phoneInput = h('input', {
    type: 'tel',
    autocomplete: 'off',
    value: base.phone || '',
  });
  const emailInput = h('input', {
    type: 'email',
    autocomplete: 'off',
    value: base.email || '',
  });
  const shiftSelect = selectFrom(['', ...COWORKER_SHIFTS], base.shift || '', (value) =>
    value ? LABELS.coworkerShift[value] : 'No set shift',
  );
  const skillsInput = h('input', {
    type: 'text',
    maxlength: '200',
    autocomplete: 'off',
    placeholder: 'e.g. Juki timing, thread paths',
    value: base.skills || '',
  });
  const linkedSelect = linkedUserSelect(base.linkedUserId || null);
  const activeCheck = h('input', {
    type: 'checkbox',
    id: `coworker-active-${++fieldCounter}`,
    checked: base.active !== false,
  });
  const activeField = h(
    'fieldset',
    { class: 'field fieldset' },
    h('legend', { class: 'field-label' }, 'Active'),
    h('div', { class: 'check-row' }, activeCheck, h('label', { for: activeCheck.id }, 'Worked on recently')),
  );
  const notesInput = h('textarea', { rows: 4, value: base.notes || '' });
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Save changes' : 'Add coworker');

  form.append(
    errorBox,
    field('Name', nameInput),
    h('div', { class: 'grid-2' }, field('Role', roleInput), field('Shift', shiftSelect)),
    h('div', { class: 'grid-2' }, field('Phone', phoneInput), field('Email', emailInput)),
    field('Skills', skillsInput, 'What they are good at — machine types they service.'),
    field('Linked login account', linkedSelect, 'Optional: the team login this person uses.'),
    activeField,
    field('Notes', notesInput),
    h('div', { class: 'form-actions' }, save, h(
      'a',
      {
        class: 'btn',
        href: existing ? `#/coworkers/${encodeURIComponent(existing.id)}` : '#/coworkers',
      },
      'Cancel',
    )),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const name = nameInput.value.trim();
    if (!name) {
      errorBox.textContent = 'Enter a name.';
      nameInput.focus();
      return;
    }
    const now = nowISO();
    const record = {
      ...base,
      id: existing ? existing.id : uid(),
      name,
      role: roleInput.value.trim(),
      phone: phoneInput.value.trim(),
      email: emailInput.value.trim(),
      skills: skillsInput.value.trim(),
      linkedUserId: linkedSelect.value || null,
      active: activeCheck.checked,
      notes: notesInput.value.trim(),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    if (shiftSelect.value) record.shift = shiftSelect.value;
    else delete record.shift;
    save.disabled = true;
    try {
      await sync.saveRecord('coworkers', record, existing ? existing.version : null);
      await refreshState();
      toast(existing ? 'Coworker saved.' : 'Coworker added.');
      navigate(`#/coworkers/${encodeURIComponent(record.id)}`);
    } catch (error) {
      errorBox.textContent = 'Could not save. Please try again.';
      console.error(error);
    } finally {
      save.disabled = false;
    }
  });

  let dirty = false;
  const markDirty = () => {
    dirty = true;
  };
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);

  return { node: form, isDirty: () => dirty };
}

function renderCoworkerForm(route) {
  const id = route.segments[1];
  const editing = Boolean(id && id !== 'new');
  const existing = editing ? coworkerById(id) : null;
  setTitle(coworkerFormTitle(existing));
  if (editing && !existing) {
    return page(
      pageHead('Coworker not found'),
      emptyState('That coworker does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/coworkers' }, 'Back to Coworkers'),
      ]),
    );
  }
  if (!can('coworkers', 'write')) {
    return page(
      pageHead(coworkerFormTitle(existing)),
      emptyState(
        'View only',
        'You need the Coworkers write permission to add or edit coworkers.',
        [h('a', { class: 'btn btn-primary', href: '#/coworkers' }, 'Back to Coworkers')],
      ),
    );
  }
  const { node } = coworkerFormBody(existing);
  return page(pageHead(coworkerFormTitle(existing)), node);
}

/* Labour hours per range for the detail pages (SPEC-v3.md section 5):
   today-based 30 / 90 / 365-day windows via logic-stats rangeFor. */
function contractorHoursEntries(contractor) {
  const includeCost = canReadRates();
  return [30, 90, 365].map((days) => {
    const rows = labourByContractor(state.workOrders, [contractor], rangeFor(days), { includeCost });
    const row = rows[0] || { hours: 0, cost: null };
    return { days, hours: row.hours, cost: row.cost };
  });
}

function coworkerHoursEntries(coworker) {
  return [30, 90, 365].map((days) => {
    const rows = labourByCoworker(state.workOrders, [coworker], rangeFor(days));
    const row = rows[0] || { hours: 0 };
    return { days, hours: row.hours };
  });
}

function personHoursGrid(entries) {
  const cells = [];
  for (const entry of entries) {
    cells.push(h('dt', {}, `Last ${entry.days} days`));
    const hours = `${entry.hours} h`;
    cells.push(
      h(
        'dd',
        {},
        entry.cost === null || entry.cost === undefined
          ? hours
          : `${hours} · ${formatMoney(dollarsToCents(entry.cost))}`,
      ),
    );
  }
  return h('dl', { class: 'detail-grid' }, ...cells);
}

function renderCoworkerDetail(route) {
  const coworker = coworkerById(route.segments[1]);
  setTitle(coworker ? coworker.name : 'Coworker not found');
  if (!coworker) {
    return page(
      pageHead('Coworker not found'),
      emptyState('That coworker does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/coworkers' }, 'Back to Coworkers'),
      ]),
    );
  }

  const orders = sortWorkOrdersNewest(personServiceOrders('coworker', coworker.id));
  const hours = coworkerHoursEntries(coworker);
  const linked = linkedAccountLabel(coworker);

  async function deleteCoworker() {
    const yes = await showConfirm({
      title: 'Delete this coworker?',
      message: `${coworker.name} will be removed from the Coworkers list. Their labour hours stay on the service orders they worked on.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!yes) return;
    await sync.deleteRecord('coworkers', coworker.id, coworker.version);
    await refreshState();
    toast('Coworker deleted.');
    navigate('#/coworkers');
  }

  const details = h(
    'dl',
    { class: 'detail-grid' },
    h('dt', {}, 'Role'),
    h('dd', {}, coworker.role || '—'),
    h('dt', {}, 'Shift'),
    h('dd', {}, shiftLabel(coworker) || '—'),
    h('dt', {}, 'Phone'),
    h('dd', {}, contactValue('tel', coworker.phone)),
    h('dt', {}, 'Email'),
    h('dd', {}, contactValue('mailto', coworker.email)),
    h('dt', {}, 'Skills'),
    h('dd', {}, coworker.skills || '—'),
    h('dt', {}, 'Linked login account'),
    h('dd', {}, linked || '—'),
    h('dt', {}, 'Active'),
    h('dd', {}, activePill(coworker)),
    h('dt', {}, 'Notes'),
    h('dd', { class: 'pre' }, coworker.notes || '—'),
  );

  return page(
    h(
      'div',
      { class: 'detail-head' },
      h(
        'div',
        {},
        h('h2', {}, coworker.name),
        h('div', { class: 'row-sub' }, [coworker.role, shiftLabel(coworker)].filter(Boolean).join(' · ')),
      ),
      isReadOnly('coworkers') ? viewOnlyBadge() : activePill(coworker),
    ),
    detailMeta(coworker),
    conflictBanner('coworkers', coworker.id),
    h(
      'div',
      { class: 'button-row' },
      can('coworkers', 'write')
        ? h('a', { class: 'btn btn-primary btn-small', href: `#/coworkers/${encodeURIComponent(coworker.id)}/edit` }, 'Edit coworker')
        : null,
    ),
    h('div', { class: 'card', style: { marginTop: '0.75rem' } }, details),
    sectionTitle('Service orders'),
    h('p', { class: 'muted field-hint' }, 'Where they are an assignee or have labour hours.'),
    orders.length
      ? h('div', { class: 'list' }, ...orders.map(jobRow))
      : h('p', { class: 'muted' }, 'No service orders for this coworker yet.'),
    sectionTitle('Labour hours'),
    h('div', { class: 'card' }, personHoursGrid(hours)),
    h(
      'div',
      { class: 'form-actions', style: { marginTop: '1.5rem' } },
      can('coworkers', 'write')
        ? h('button', { class: 'btn btn-danger', type: 'button', onclick: deleteCoworker }, 'Delete coworker')
        : null,
    ),
    historySection('coworkers', coworker.id),
  );
}

/* ---------- People: outside contractors (SPEC-v3.md sections 5 and 13) ---------- */

function contractorsServicedMachines(contractor) {
  const ids = Array.isArray(contractor.machineIds) ? contractor.machineIds : [];
  return state.machines
    .filter((machine) => ids.includes(machine.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function contractorsTableColumns() {
  const machinesByName = new Map();
  for (const contractor of state.contractors) {
    machinesByName.set(
      contractor.id,
      contractorsServicedMachines(contractor)
        .map((machine) => machine.name)
        .join(', '),
    );
  }
  const columns = [
    { key: 'company', label: 'Company', value: (contractor) => contractor.company },
    { key: 'trade', label: 'Trade', value: (contractor) => contractor.trade },
    { key: 'contactName', label: 'Contact', value: (contractor) => contractor.contactName },
    { key: 'phone', label: 'Phone', value: (contractor) => contractor.phone },
    { key: 'email', label: 'Email', value: (contractor) => contractor.email },
    {
      key: 'machines',
      label: 'Machines serviced',
      value: (contractor) => machinesByName.get(contractor.id) || '',
      cell: (contractor) => {
        const names = machinesByName.get(contractor.id);
        return names ? h('span', {}, names) : h('span', { class: 'muted' }, '—');
      },
    },
  ];
  // Contractor rates & costs show only with contractorRates Read
  // (SPEC-v3.md 13.1); the column is omitted entirely otherwise.
  if (canReadRates()) {
    columns.push({
      key: 'hourlyRate',
      label: 'Hourly rate',
      value: (contractor) => formatMoney(dollarsToCents(contractor.hourlyRate)) || '—',
      sortValue: (contractor) => {
        const rate = Number(contractor.hourlyRate);
        return contractor.hourlyRate === null || contractor.hourlyRate === undefined || !Number.isFinite(rate)
          ? null
          : rate;
      },
    });
  }
  columns.push(activeTableColumn(), editedByColumn());
  return columns;
}

function contractorCard(contractor) {
  return h(
    'div',
    { class: 'person-card card' },
    h(
      'a',
      { class: 'row person-row', href: `#/contractors/${encodeURIComponent(contractor.id)}` },
      h(
        'div',
        { class: 'row-main' },
        h('div', { class: 'row-title' }, contractor.company),
        h(
          'div',
          { class: 'row-sub' },
          [contractor.trade, contractor.contactName].filter(Boolean).join(' · ') || 'Outside contractor',
          editedTag(contractor),
        ),
      ),
      h(
        'div',
        { class: 'row-side' },
        activePill(contractor),
      ),
      h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'),
    ),
    contractor.phone || contractor.email
      ? h(
          'div',
          { class: 'contact-list' },
          contractor.phone ? contactValue('tel', contractor.phone) : null,
          contractor.email ? contactValue('mailto', contractor.email) : null,
        )
      : null,
  );
}

function renderContractors(route) {
  setTitle('Outside Contractors');
  const activeFilter = peopleFilterFrom(route);
  const listHost = h('div', { class: 'list people-list' });
  const tableHost = h('div', { class: 'table-wrap' });
  let searchQuery = '';

  function update(nextQuery) {
    if (typeof nextQuery === 'string') searchQuery = nextQuery;
    const contractors = contactSearch(state.contractors, searchQuery, [
      'company',
      'trade',
      'contactName',
      'phone',
      'email',
    ])
      .filter(
        (contractor) =>
          activeFilter === 'all' || (activeFilter === 'active') === (contractor.active !== false),
      )
      .sort((a, b) => a.company.localeCompare(b.company, undefined, { sensitivity: 'base' }));
    if (contractors.length === 0) {
      listHost.replaceChildren(
        emptyState(
          searchQuery || activeFilter !== 'all' ? 'No matching contractors' : 'No contractors yet',
          searchQuery
            ? 'Try a different search.'
            : activeFilter !== 'all'
              ? 'No contractors in this filter.'
              : 'Add the companies that service your machines: contacts, trades and what they work on.',
          [
            searchQuery || activeFilter !== 'all'
              ? h('a', { class: 'btn', href: '#/contractors?filter=all' }, 'Show all contractors')
              : null,
            can('contractors', 'write')
              ? h('a', { class: 'btn btn-primary', href: '#/contractors/new' }, 'Add contractor')
              : null,
          ],
        ),
      );
      listHost.classList.remove('cards-only');
      tableHost.replaceChildren();
    } else {
      listHost.replaceChildren(...contractors.map(contractorCard));
      listHost.classList.add('cards-only');
      tableHost.replaceChildren(
        buildDataTable(
          'contractors',
          contractorsTableColumns(),
          contractors,
          (contractor) => `#/contractors/${encodeURIComponent(contractor.id)}`,
          update,
        ),
      );
    }
  }

  update();
  const chips = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': 'Filter contractors' },
    PEOPLE_FILTERS.map((value) =>
      h(
        'a',
        {
          class: `chip${value === activeFilter ? ' is-active' : ''}`,
          href: value === 'active' ? '#/contractors' : `#/contractors?filter=${value}`,
          'aria-pressed': value === activeFilter ? 'true' : 'false',
        },
        PEOPLE_FILTER_LABELS[value],
      ),
    ),
  );

  return page(
    pageHead(
      'Outside Contractors',
      isReadOnly('contractors') ? viewOnlyBadge() : null,
      can('contractors', 'write')
        ? h('a', { class: 'btn btn-primary btn-small', href: '#/contractors/new' }, '+ Add contractor')
        : null,
    ),
    searchBox('Search contractors', (value) => update(value)),
    chips,
    listHost,
    tableHost,
  );
}

function contractorFormTitle(existing) {
  return existing ? 'Edit contractor' : 'Add contractor';
}

function contractorFormBody(existing) {
  const base = existing || {
    company: '',
    trade: '',
    contactName: '',
    phone: '',
    email: '',
    machineIds: [],
    active: true,
    notes: '',
  };
  const form = h('form', { class: 'form', novalidate: true });
  const errorBox = h('div', { class: 'form-error', role: 'alert' });
  const companyInput = h('input', {
    type: 'text',
    required: true,
    maxlength: '80',
    autocomplete: 'off',
    placeholder: 'e.g. Ace Juki Service',
    value: base.company || '',
  });
  const tradeInput = h('input', {
    type: 'text',
    maxlength: '60',
    autocomplete: 'off',
    placeholder: 'e.g. Juki service, HVAC',
    value: base.trade || '',
  });
  const contactNameInput = h('input', {
    type: 'text',
    autocomplete: 'off',
    value: base.contactName || '',
  });
  const phoneInput = h('input', {
    type: 'tel',
    autocomplete: 'off',
    value: base.phone || '',
  });
  const emailInput = h('input', {
    type: 'email',
    autocomplete: 'off',
    value: base.email || '',
  });
  // hourlyRate is ruled by the contractorRates permission (SPEC-v3.md 13.1):
  // hidden without Read, read-only without Write. The server preserves the
  // stored rate on a PUT that cannot change it.
  const showRate = canReadRates();
  const rateEditable = canWriteRates();
  const rateInput = h('input', {
    type: 'number',
    min: '0',
    step: '0.01',
    inputmode: 'decimal',
    placeholder: 'e.g. 95',
    value:
      base.hourlyRate === null || base.hourlyRate === undefined || base.hourlyRate === ''
        ? ''
        : String(base.hourlyRate),
    disabled: !rateEditable ? true : null,
  });
  const machineChecks = h('div', { class: 'check-list' });
  if (state.machines.length === 0) {
    machineChecks.append(h('p', { class: 'field-hint' }, 'No machines added yet.'));
  } else {
    for (const machine of state.machines
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))) {
      const checkId = `contractor-machine-${++fieldCounter}`;
      const checkbox = h('input', {
        type: 'checkbox',
        checked: (base.machineIds || []).includes(machine.id),
        value: machine.id,
      });
      checkbox.id = checkId;
      machineChecks.append(
        h('div', { class: 'check-row' }, checkbox, h('label', { for: checkId }, machine.name)),
      );
    }
  }
  const machineFieldset = h(
    'fieldset',
    { class: 'field fieldset' },
    h('legend', { class: 'field-label' }, 'Machines they service'),
    machineChecks,
  );
  const activeCheck = h('input', {
    type: 'checkbox',
    id: `contractor-active-${++fieldCounter}`,
    checked: base.active !== false,
  });
  const activeField = h(
    'fieldset',
    { class: 'field fieldset' },
    h('legend', { class: 'field-label' }, 'Active'),
    h('div', { class: 'check-row' }, activeCheck, h('label', { for: activeCheck.id }, 'Currently used by the shop')),
  );
  const notesInput = h('textarea', { rows: 4, value: base.notes || '' });
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Save changes' : 'Add contractor');

  form.append(
    errorBox,
    field('Company', companyInput),
    h('div', { class: 'grid-2' }, field('Trade', tradeInput), field('Contact name', contactNameInput)),
    h('div', { class: 'grid-2' }, field('Phone', phoneInput), field('Email', emailInput)),
    showRate ? field('Hourly rate', rateInput, rateEditable ? 'Costs on their detail page are hours × rate.' : 'Read-only: you need the Contractor rates write permission to change it.') : null,
    machineFieldset,
    activeField,
    field('Notes', notesInput),
    h('div', { class: 'form-actions' }, save, h(
      'a',
      {
        class: 'btn',
        href: existing ? `#/contractors/${encodeURIComponent(existing.id)}` : '#/contractors',
      },
      'Cancel',
    )),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const company = companyInput.value.trim();
    if (!company) {
      errorBox.textContent = 'Enter a company name.';
      companyInput.focus();
      return;
    }
    if (rateEditable) {
      const rateText = String(rateInput.value || '').trim();
      if (rateText !== '') {
        const rate = Number(rateText);
        if (!Number.isFinite(rate) || rate < 0) {
          errorBox.textContent = 'Enter an hourly rate of 0 or more, or clear it.';
          rateInput.focus();
          return;
        }
      }
    }
    const now = nowISO();
    const record = {
      ...base,
      id: existing ? existing.id : uid(),
      company,
      trade: tradeInput.value.trim(),
      contactName: contactNameInput.value.trim(),
      phone: phoneInput.value.trim(),
      email: emailInput.value.trim(),
      machineIds: [...machineChecks.querySelectorAll('input[type="checkbox"]:checked')].map(
        (input) => input.value,
      ),
      active: activeCheck.checked,
      notes: notesInput.value.trim(),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    if (rateEditable) {
      const rateText = String(rateInput.value || '').trim();
      if (rateText === '') delete record.hourlyRate;
      else record.hourlyRate = Number(rateText);
    } else if (base.hourlyRate === undefined) {
      delete record.hourlyRate;
    }
    save.disabled = true;
    try {
      await sync.saveRecord('contractors', record, existing ? existing.version : null);
      await refreshState();
      toast(existing ? 'Contractor saved.' : 'Contractor added.');
      navigate(`#/contractors/${encodeURIComponent(record.id)}`);
    } catch (error) {
      errorBox.textContent = 'Could not save. Please try again.';
      console.error(error);
    } finally {
      save.disabled = false;
    }
  });

  let dirty = false;
  const markDirty = () => {
    dirty = true;
  };
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);

  return { node: form, isDirty: () => dirty };
}

function renderContractorForm(route) {
  const id = route.segments[1];
  const editing = Boolean(id && id !== 'new');
  const existing = editing ? contractorById(id) : null;
  setTitle(contractorFormTitle(existing));
  if (editing && !existing) {
    return page(
      pageHead('Contractor not found'),
      emptyState('That contractor does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/contractors' }, 'Back to Outside Contractors'),
      ]),
    );
  }
  if (!can('contractors', 'write')) {
    return page(
      pageHead(contractorFormTitle(existing)),
      emptyState(
        'View only',
        'You need the Outside Contractors write permission to add or edit contractors.',
        [h('a', { class: 'btn btn-primary', href: '#/contractors' }, 'Back to Outside Contractors')],
      ),
    );
  }
  const { node } = contractorFormBody(existing);
  return page(pageHead(contractorFormTitle(existing)), node);
}

function renderContractorDetail(route) {
  const contractor = contractorById(route.segments[1]);
  setTitle(contractor ? contractor.company : 'Contractor not found');
  if (!contractor) {
    return page(
      pageHead('Contractor not found'),
      emptyState('That contractor does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/contractors' }, 'Back to Outside Contractors'),
      ]),
    );
  }

  const machines = contractorsServicedMachines(contractor);
  const orders = sortWorkOrdersNewest(personServiceOrders('contractor', contractor.id));
  const hours = contractorHoursEntries(contractor);
  const showRate = canReadRates();

  async function deleteContractor() {
    const yes = await showConfirm({
      title: 'Delete this contractor?',
      message: `${contractor.company} will be removed from the Outside Contractors list. Their labour hours stay on the service orders they worked on.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!yes) return;
    await sync.deleteRecord('contractors', contractor.id, contractor.version);
    await refreshState();
    toast('Contractor deleted.');
    navigate('#/contractors');
  }

  const detailPairs = [
    h('dt', {}, 'Trade'),
    h('dd', {}, contractor.trade || '—'),
    h('dt', {}, 'Contact'),
    h('dd', {}, contractor.contactName || '—'),
    h('dt', {}, 'Phone'),
    h('dd', {}, contactValue('tel', contractor.phone)),
    h('dt', {}, 'Email'),
    h('dd', {}, contactValue('mailto', contractor.email)),
    showRate
      ? [
          h('dt', {}, 'Hourly rate'),
          h('dd', {}, formatMoney(dollarsToCents(contractor.hourlyRate)) || '—'),
        ]
      : null,
    h('dt', {}, 'Machines serviced'),
    h('dd', {}, machines.length === 0 ? '—' : `${machines.length === 1 ? '1 machine' : `${machines.length} machines`}`),
    h('dt', {}, 'Active'),
    h('dd', {}, activePill(contractor)),
    h('dt', {}, 'Notes'),
    h('dd', { class: 'pre' }, contractor.notes || '—'),
  ].filter(Boolean);
  const details = h('dl', { class: 'detail-grid' }, ...detailPairs.flat());

  return page(
    h(
      'div',
      { class: 'detail-head' },
      h(
        'div',
        {},
        h('h2', {}, contractor.company),
        h('div', { class: 'row-sub' }, [contractor.trade, contractor.contactName].filter(Boolean).join(' · ')),
      ),
      isReadOnly('contractors') ? viewOnlyBadge() : activePill(contractor),
    ),
    detailMeta(contractor),
    conflictBanner('contractors', contractor.id),
    h(
      'div',
      { class: 'button-row' },
      can('contractors', 'write')
        ? h('a', { class: 'btn btn-primary btn-small', href: `#/contractors/${encodeURIComponent(contractor.id)}/edit` }, 'Edit contractor')
        : null,
    ),
    h('div', { class: 'card', style: { marginTop: '0.75rem' } }, details),
    sectionTitle('Machines serviced'),
    machines.length
      ? h(
          'div',
          { class: 'list' },
          ...machines.map((machine) =>
            h(
              'a',
              { class: 'row', href: `#/machines/${encodeURIComponent(machine.id)}` },
              h(
                'div',
                { class: 'row-main' },
                h('div', { class: 'row-title' }, machine.name),
                h('div', { class: 'row-sub' }, [machineTypeLabel(machine), machine.location].filter(Boolean).join(' · ')),
              ),
              statusPill(machine.status, LABELS.machineStatus),
              h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No machines linked to this contractor yet.'),
    sectionTitle('Service orders'),
    h('p', { class: 'muted field-hint' }, 'Where they are an assignee or have labour hours.'),
    orders.length
      ? h('div', { class: 'list' }, ...orders.map(jobRow))
      : h('p', { class: 'muted' }, 'No service orders for this contractor yet.'),
    sectionTitle('Labour hours'),
    h('div', { class: 'card' }, personHoursGrid(hours)),
    h(
      'div',
      { class: 'form-actions', style: { marginTop: '1.5rem' } },
      can('contractors', 'write')
        ? h('button', { class: 'btn btn-danger', type: 'button', onclick: deleteContractor }, 'Delete contractor')
        : null,
    ),
    historySection('contractors', contractor.id),
  );
}

/* The M5 drawer usage (SPEC-v3.md section 10): add/edit opens in the right
   drawer on desktop; phones and tablets keep the full-page form. */
function maybeOpenCoworkerDrawer(route) {
  if (!desktopMedia.matches) return false;
  if (!can('coworkers', 'write')) return false;
  const second = route.segments[1];
  const editing = Boolean(second && second !== 'new');
  const existing = editing ? coworkerById(second) : null;
  if (editing && !existing) return false;
  const { node, isDirty } = coworkerFormBody(existing);
  openDrawer({ title: existing ? 'Edit coworker' : 'New coworker', content: node, isDirty });
  return true;
}

function maybeOpenContractorDrawer(route) {
  if (!desktopMedia.matches) return false;
  if (!can('contractors', 'write')) return false;
  const second = route.segments[1];
  const editing = Boolean(second && second !== 'new');
  const existing = editing ? contractorById(second) : null;
  if (editing && !existing) return false;
  const { node, isDirty } = contractorFormBody(existing);
  openDrawer({ title: existing ? 'Edit contractor' : 'New contractor', content: node, isDirty });
  return true;
}

/* ---------- PM ---------- */

/* In-page dialog after "Mark done" (SPEC-v3.md section 4): optional labour
   hours (person + hours) added to the completion service order. Resolves a
   labour entry, or null when skipped. Never window.prompt. */
function showPMLabourDialog(defaultPerson) {
  return new Promise((resolve) => {
    const people = assignablePeople();
    const defaultValue = defaultPerson
      ? `${defaultPerson.kind}:${defaultPerson.id}`
      : people.length > 0
        ? `${people[0].kind}:${people[0].id}`
        : '';
    const personSelect = h(
      'select',
      { 'aria-label': 'Labour: person' },
      ...(people.length === 0
        ? [h('option', { value: '' }, 'No people yet')]
        : people.map((person) => {
            const value = `${person.kind}:${person.id}`;
            const option = h('option', { value }, `${person.name} · ${person.sub}`);
            if (value === defaultValue) option.selected = true;
            return option;
          })),
    );
    const hoursInput = h('input', {
      type: 'number',
      min: '0.25',
      max: '24',
      step: '0.25',
      inputmode: 'decimal',
      placeholder: 'e.g. 1',
      'aria-label': 'Labour: hours',
    });
    const hint = h('p', { class: 'field-hint', role: 'alert' });
    const previousFocus = document.activeElement;
    const skip = h('button', { class: 'btn', type: 'button' }, 'Finish without hours');
    const add = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add hours');
    const form = h(
      'form',
      { class: 'form', novalidate: true },
      hint,
      field('Person', personSelect),
      field('Hours', hoursInput, 'Optional: quarter-hour steps, e.g. 0.25 or 1.5.'),
      h('div', { class: 'dialog-actions' }, skip, add),
    );
    const dialog = h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' },
      h('h2', { id: 'dialog-title' }, 'Labour hours for this PM'),
      h('p', {}, 'Who worked on it, and for how long? You can skip this.'),
      form,
    );
    const backdrop = h('div', { class: 'dialog-backdrop' }, dialog);
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
    };
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      dialogRoot.replaceChildren();
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(value);
    };
    skip.addEventListener('click', () => close(null));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const raw = personSelect.value;
      const hours = Number(hoursInput.value);
      if (
        raw === '' ||
        hoursInput.value.trim() === '' ||
        !Number.isFinite(hours) ||
        hours < 0.25 ||
        hours > 24
      ) {
        hint.textContent = 'Pick a person and enter hours between 0.25 and 24 — or finish without hours.';
        return;
      }
      const separator = raw.indexOf(':');
      close({
        id: uid(),
        kind: raw.slice(0, separator),
        personId: raw.slice(separator + 1),
        date: todayISO(),
        hours: Math.round(hours * 4) / 4,
        note: '',
      });
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(null);
    });
    document.addEventListener('keydown', onKey);
    dialogRoot.replaceChildren(backdrop);
    hoursInput.focus();
  });
}

async function markPMTaskDone(task) {
  const today = todayISO();
  // V3-M4 (SPEC-v3.md section 4): "Mark done" builds a Done service order
  // that copies priority, category, assignees and the ticked checklist, then
  // asks for optional labour hours before both records are saved.
  const { order, task: updatedTask, labourPerson } = buildPMCompletionOrder(task, teamUser, today);
  const entry = await showPMLabourDialog(labourPerson);
  if (entry) order.labour = [entry];
  try {
    await sync.saveRecord('pmTasks', updatedTask, task.version);
    await sync.saveRecord('workOrders', order, null);
    await refreshState();
    toast(
      `PM done: ${task.title}. Logged as a done PM service order${
        entry ? ` with ${entry.hours} h labour` : ''
      }; next due ${formatDate(pmDueDate(updatedTask))}.`,
    );
    render();
  } catch (error) {
    toast('Could not record the PM. Please try again.', 'warn');
    console.error(error);
  }
}

function pmTaskRow(task) {
  const today = todayISO();
  const due = pmDueDate(task, today);
  const stateName = pmState(task, today);
  const machine = machineById(task.machineId);
  const paused = pmPaused(machine);
  const lateDays = !paused && stateName === 'overdue' ? Math.max(0, daysBetween(due, today) || 0) : 0;
  // Mark done writes the PM task and creates a service order (SPEC-v3.md
  // 13.1): it needs pm + serviceOrders Write and is hidden without them.
  const canDone = can('pm', 'write') && can('serviceOrders', 'write');
  return h(
    'div',
    { class: 'pm-row' },
    h(
      'div',
      { class: 'row-main' },
      h('a', { class: 'row-title inline-link', href: `#/pm/${encodeURIComponent(task.id)}` }, task.title),
      h(
        'div',
        { class: 'row-sub' },
        `${machineName(task.machineId)} · Due ${formatDate(due)}${
          lateDays > 0 ? ` · ${lateDays} day${lateDays === 1 ? '' : 's'} late` : ''
        } · every ${Math.max(1, Math.floor(Number(task.intervalDays) || 1))} days`,
        editedTag(task),
      ),
    ),
    paused ? statusPill(machine.status, LABELS.machineStatus) : canDone
      ? h(
          'button',
          { class: 'btn btn-primary btn-small', type: 'button', onclick: () => markPMTaskDone(task) },
          'Mark done',
        )
      : null,
  );
}

function pmGroupSection(title, tasks) {
  return h(
    'section',
    { class: 'pm-group' },
    h(
      'div',
      { class: 'pm-group-head' },
      h('h3', {}, title),
      h('span', { class: 'chip-count' }, String(tasks.length)),
    ),
    h('div', { class: 'list' }, ...tasks.map(pmTaskRow)),
  );
}

/** Paused group (SPEC-v2.md 15.3): a collapsible <details>, closed by default. */
function pausedPMGroupSection(title, tasks) {
  return h(
    'details',
    { class: 'pm-group pm-group-paused' },
    h(
      'summary',
      { class: 'pm-group-head' },
      h('h3', {}, title),
      h('span', { class: 'chip-count' }, String(tasks.length)),
    ),
    h('div', { class: 'list' }, ...tasks.map(pmTaskRow)),
  );
}

/* Row state for the desktop PM table (SPEC-v3.md section 4): a task on a
   paused machine (or an inactive task) is "Paused"; otherwise overdue /
   due-soon / upcoming. */
const PM_STATE_RANK = { overdue: 0, 'due-soon': 1, ok: 2, paused: 3 };

function pmRowState(task, today = todayISO()) {
  if (task.active === false || pmPaused(machineById(task.machineId))) return 'paused';
  return pmState(task, today);
}

function pmStatePill(task, today = todayISO()) {
  const stateName = pmRowState(task, today);
  return stateName === 'paused'
    ? statusPill('neutral', { neutral: 'Paused' })
    : statusPill(stateName, LABELS.pmState);
}

function pmTableColumns() {
  const today = todayISO();
  return [
    { key: 'task', label: 'Task', value: (task) => task.title },
    { key: 'machine', label: 'Machine', value: (task) => machineName(task.machineId) },
    {
      key: 'priority',
      label: 'Priority',
      value: (task) => LABELS.priority[task.priority] || (task.priority ? String(task.priority) : 'Medium'),
      cell: (task) => priorityBadge(task.priority),
      sortValue: (task) => PRIORITIES.indexOf(priorityValue(task.priority) || 'medium'),
    },
    {
      key: 'assignees',
      label: 'Assigned to',
      value: (task) =>
        (task.assignees || []).map((entry) => personName(entry) || 'Unknown').join(', '),
      cell: (task) => assigneeAvatars(task.assignees || []),
      sortValue: (task) => (task.assignees || []).length,
    },
    {
      key: 'estimatedHours',
      label: 'Est. hours',
      value: (task) =>
        task.estimatedHours === null || task.estimatedHours === undefined
          ? ''
          : String(task.estimatedHours),
      cell: (task) => h('span', {}, formatHours(task.estimatedHours === null || task.estimatedHours === undefined ? null : task.estimatedHours)),
      sortValue: (task) => {
        const value = Number(task.estimatedHours);
        return Number.isFinite(value) ? value : 0;
      },
    },
    {
      key: 'interval',
      label: 'Interval',
      value: (task) => `every ${Math.max(1, Math.floor(Number(task.intervalDays) || 1))} days`,
      sortValue: (task) => Math.max(1, Math.floor(Number(task.intervalDays) || 1)),
    },
    {
      key: 'due',
      label: 'Due',
      value: (task) => pmDueDate(task, today),
      cell: (task) => {
        const due = pmDueDate(task, today);
        const overdue = pmRowState(task, today) === 'overdue';
        return overdue
          ? h('span', { class: 'due-overdue' }, formatDate(due))
          : h('span', {}, formatDate(due));
      },
      sortValue: (task) => pmDueDate(task, today),
    },
    {
      key: 'state',
      label: 'State',
      value: (task) => LABELS.pmState[pmRowState(task, today)] || 'Upcoming',
      cell: (task) => pmStatePill(task, today),
      sortValue: (task) => PM_STATE_RANK[pmRowState(task, today)] ?? 2,
    },
    {
      // The most-used PM action stays one click away on desktop, like the phone cards.
      key: 'action',
      label: '',
      value: () => '',
      cell: (task) => {
        if (!(can('pm', 'write') && can('serviceOrders', 'write')) || pmPaused(machineById(task.machineId)))
          return null;
        return h(
          'button',
          {
            class: 'btn btn-primary btn-small',
            type: 'button',
            onclick: (event) => {
              event.stopPropagation();
              markPMTaskDone(task);
            },
            onkeydown: (event) => event.stopPropagation(),
          },
          'Mark done',
        );
      },
    },
  ];
}

function renderPM() {
  setTitle('Preventive Maintenance');
  const today = todayISO();
  // Creating PM tasks needs the pm write permission (SPEC-v3.md 13.3).
  const add = headActionFor('pm', h('a', { class: 'btn btn-primary btn-small', href: '#/pm/new' }, '+ Add PM task'));
  if (state.pmTasks.length === 0) {
    return page(
      pageHead('Preventive Maintenance', add),
      emptyState(
        'No PM tasks yet',
        'Set up recurring checks such as "Oil hook and check timing" so they show up here before something breaks.',
        add ? [add] : [],
      ),
    );
  }
  if (desktopMedia.matches) {
    // Desktop: one sortable table with the priority, assignee, est-hours and
    // state columns (SPEC-v3.md section 4); every task shows, paused ones
    // included, in their State cell.
    const tableHost = h('div', { class: 'table-wrap' });
    const updatePMTable = () => {
      const rows = [...state.pmTasks].sort(
        (a, b) => pmDueDate(a, today).localeCompare(pmDueDate(b, today)),
      );
      tableHost.replaceChildren(
        buildDataTable(
          'pm',
          pmTableColumns(),
          rows,
          (task) => `#/pm/${encodeURIComponent(task.id)}`,
          updatePMTable,
        ),
      );
    };
    updatePMTable();
    return page(pageHead('Preventive Maintenance', add), tableHost);
  }
  // Phone and tablet keep the grouped cards (SPEC-v2.md 15.3).
  const groups = groupPMTasks(state.pmTasks, today, state.machines);
  return page(
    pageHead('Preventive Maintenance', add),
    groups.overdue.length ? pmGroupSection('Overdue', groups.overdue) : null,
    groups.dueSoon.length ? pmGroupSection('Due soon', groups.dueSoon) : null,
    groups.upcoming.length ? pmGroupSection('Upcoming', groups.upcoming) : null,
    groups.paused.length
      ? pausedPMGroupSection('Paused – machine in storage or retired', groups.paused)
      : null,
  );
}

function renderPMTaskDetail(route) {
  const task = pmTaskById(route.segments[1]);
  setTitle(task ? task.title : 'PM task not found');
  if (!task) {
    return page(
      pageHead('PM task not found'),
      emptyState('That PM task does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/pm' }, 'Back to PM'),
      ]),
    );
  }

  const today = todayISO();
  const due = pmDueDate(task, today);
  const inactive = task.active === false;
  const machine = machineById(task.machineId);

  async function deleteTask() {
    const yes = await showConfirm({
      title: 'Delete this PM task?',
      message: `"${task.title}" will be removed. PM service orders already logged will stay in Service Orders.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!yes) return;
    await sync.deleteRecord('pmTasks', task.id, task.version);
    await refreshState();
    toast('PM task deleted.');
    navigate('#/pm');
  }

  const details = h(
    'dl',
    { class: 'detail-grid' },
    h('dt', {}, 'Machine'),
    h(
      'dd',
      {},
      machine
        ? h('a', { class: 'inline-link', href: `#/machines/${encodeURIComponent(machine.id)}` }, machine.name)
        : 'Unknown machine',
    ),
    h('dt', {}, 'State'),
    h(
      'dd',
      {},
      inactive || pmPaused(machine)
        ? statusPill('neutral', { neutral: 'Paused' })
        : statusPill(pmState(task, today), LABELS.pmState),
    ),
    h('dt', {}, 'Priority'),
    h('dd', {}, priorityBadge(task.priority)),
    task.category ? h('dt', {}, 'Category') : null,
    task.category ? h('dd', {}, LABELS.category[task.category] || task.category) : null,
    h('dt', {}, 'Estimated hours'),
    h('dd', {}, formatHours(task.estimatedHours ?? null)),
    h('dt', {}, 'Assigned to'),
    h('dd', {}, assigneeAvatars(task.assignees || [], { showNames: true })),
    h('dt', {}, 'Interval'),
    h('dd', {}, `Every ${Math.max(1, Math.floor(Number(task.intervalDays) || 1))} days`),
    h('dt', {}, 'Last done'),
    h('dd', {}, task.lastDoneAt ? formatDate(task.lastDoneAt) : 'Never'),
    h('dt', {}, 'Next due'),
    h('dd', {}, formatDate(due)),
    h('dt', {}, 'Instructions'),
    h('dd', { class: 'pre' }, task.instructions || '—'),
  );

  // Mark done needs pm + serviceOrders Write; editing needs pm Write
  // (SPEC-v3.md 13.1). The server stays the authority on every save.
  const canEdit = can('pm', 'write');
  const canDone = can('pm', 'write') && can('serviceOrders', 'write');

  return page(
    h(
      'div',
      { class: 'detail-head' },
      h('div', {}, h('h2', {}, task.title), h('div', { class: 'row-sub' }, machineName(task.machineId))),
      inactive ? statusPill('neutral', { neutral: 'Paused' }) : statusPill(pmState(task, today), LABELS.pmState),
    ),
    detailMeta(task),
    conflictBanner('pmTasks', task.id),
      h(
        'div',
        { class: 'button-row' },
        canDone
          ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => markPMTaskDone(task) }, 'Mark done')
          : null,
        canEdit
          ? h('a', { class: 'btn btn-small', href: `#/pm/${encodeURIComponent(task.id)}/edit` }, 'Edit task')
          : null,
        !canDone && !canEdit && isReadOnly('pm') ? viewOnlyBadge() : null,
      ),
    h('div', { class: 'card', style: { marginTop: '0.75rem' } }, details),
    sectionTitle('Checklist template'),
    (task.checklist || []).length ? checklistNode({ checklist: task.checklist }) : h('p', { class: 'muted' }, 'No checklist steps.'),
    sectionTitle('Attachments'),
    attachmentsGrid(task.attachments || []),
    canEdit
      ? h(
          'div',
          { class: 'form-actions', style: { marginTop: '1.5rem' } },
          h('button', { class: 'btn btn-danger', type: 'button', onclick: deleteTask }, 'Delete PM task'),
        )
      : null,
    historySection('pmTasks', task.id),
  );
}

function pmTaskFormTitle(existing) {
  return existing ? 'Edit PM task' : 'Add PM task';
}

/* PM task form body (SPEC-v3.md section 4, V3-M4): sectioned form with
   title, machine, interval, priority, estimated hours, category, assignees,
   checklist template, instructions and attachments. Shared by the full page
   (phone/tablet) and the desktop drawer like the service order form. */
function pmTaskFormBody({ existing = null, cancelTo = undefined } = {}) {
  const base = existing || {
    title: '',
    machineId: '',
    intervalDays: 30,
    lastDoneAt: null,
    instructions: '',
    active: true,
    priority: 'medium',
  };

  const form = h('form', { class: 'form pm-form', novalidate: true });
  const errorBox = h('div', { class: 'form-error', role: 'alert' });
  const titleInput = h('input', {
    type: 'text',
    required: true,
    autocomplete: 'off',
    placeholder: 'e.g. Oil hook and check timing',
    value: base.title || '',
  });
  const machineSelect = h('select', {}, h('option', { value: '' }, 'Select machine'));
  for (const machine of orderedMachines()) {
    const option = h('option', { value: machine.id }, machine.name);
    if (machine.id === base.machineId) option.selected = true;
    machineSelect.append(option);
  }
  const intervalInput = h('input', {
    type: 'number',
    min: 1,
    step: 1,
    inputmode: 'numeric',
    value: String(Math.max(1, Math.floor(Number(base.intervalDays) || 30))),
  });
  const prioritySelect = selectFrom(PRIORITIES, priorityValue(base.priority) || 'medium', (value) => LABELS.priority[value]);
  const categorySelect = h(
    'select',
    {},
    h('option', { value: '' }, 'No category'),
    ...WORK_ORDER_CATEGORIES.map((value) => {
      const option = h('option', { value }, LABELS.category[value]);
      if (value === (base.category || '')) option.selected = true;
      return option;
    }),
  );
  const estimatedHoursInput = h('input', {
    type: 'number',
    min: '0',
    max: '1000',
    step: '0.01',
    inputmode: 'decimal',
    placeholder: 'e.g. 0.75',
    value:
      base.estimatedHours === null || base.estimatedHours === undefined
        ? ''
        : String(base.estimatedHours),
  });
  const lastDoneInput = h('input', { type: 'date', value: base.lastDoneAt || '' });
  const instructionsInput = h('textarea', {
    rows: 4,
    placeholder: 'How to do this check; copied to the completion service order.',
    value: base.instructions || '',
  });
  const activeId = `pm-active-${++fieldCounter}`;
  const activeCheckbox = h('input', { type: 'checkbox' });
  activeCheckbox.id = activeId;
  activeCheckbox.checked = base.active !== false;

  const assigneeEditor = createAssigneeEditor(base.assignees || []);
  const checklistEditor = createChecklistEditor(base.checklist || []);
  const attachmentsEditor = createAttachmentsEditor(base.attachments || []);

  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Save changes' : 'Add PM task');
  const cancelButton =
    cancelTo === null
      ? h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              if (drawerHandle) drawerHandle.close();
            },
          },
          'Cancel',
        )
      : h(
          'a',
          { class: 'btn', href: cancelTo || (existing ? `#/pm/${encodeURIComponent(existing.id)}` : '#/pm') },
          'Cancel',
        );

  form.append(
    errorBox,
    sectionTitle('Basics'),
    field('Title', titleInput),
    field('Machine', machineSelect),
    h(
      'div',
      { class: 'grid-2' },
      field('Interval (days)', intervalInput, 'The task is due again this many days after it was last done.'),
      field('Priority', prioritySelect),
    ),
    h('div', { class: 'grid-2' }, field('Category', categorySelect), field('Estimated hours', estimatedHoursInput, 'Rough time this check takes, in hours. Decimals allowed, e.g. 0.75.')),
    field('Last done', lastDoneInput, 'Leave empty if this task has never been done; it will be due today.'),
    sectionTitle('Assign'),
    assigneeEditor.element,
    sectionTitle('Checklist template'),
    checklistEditor.element,
    sectionTitle('Instructions'),
    instructionsInput,
    sectionTitle('Attachments'),
    attachmentsEditor.element,
    h('div', { class: 'check-row' }, activeCheckbox, h('label', { for: activeId }, 'Task is active')),
    h('div', { class: 'field-hint' }, 'Paused tasks never count as due or overdue.'),
    h('div', { class: 'form-actions' }, save, cancelButton),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const title = titleInput.value.trim();
    if (!title) {
      errorBox.textContent = 'Enter a title for the PM task.';
      titleInput.focus();
      return;
    }
    if (!machineSelect.value) {
      errorBox.textContent = 'Pick a machine.';
      machineSelect.focus();
      return;
    }
    const interval = Math.floor(Number(intervalInput.value));
    if (!Number.isFinite(interval) || interval < 1) {
      errorBox.textContent = 'The interval must be at least 1 day.';
      intervalInput.focus();
      return;
    }
    const rawEstimated = estimatedHoursInput.value.trim();
    let estimatedHours = null;
    if (rawEstimated !== '') {
      const value = Number(rawEstimated);
      if (!Number.isFinite(value) || value < 0 || value > 1000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
        errorBox.textContent = 'Estimated hours must be 0–1000 with up to two decimals (e.g. 0.75).';
        estimatedHoursInput.focus();
        return;
      }
      estimatedHours = Math.round(value * 100) / 100;
    }
    const lastDone = lastDoneInput.value;
    if (lastDone && !isISODate(lastDone)) {
      errorBox.textContent = 'Enter a valid last-done date or leave it empty.';
      lastDoneInput.focus();
      return;
    }
    const now = nowISO();
    const record = {
      ...base,
      id: existing ? existing.id : uid(),
      title,
      machineId: machineSelect.value,
      intervalDays: interval,
      lastDoneAt: lastDone || null,
      instructions: instructionsInput.value.trim(),
      active: activeCheckbox.checked,
      priority: prioritySelect.value,
      estimatedHours,
      assignees: assigneeEditor.getAssignees(),
      checklist: checklistEditor.getChecklist(),
      attachments: attachmentsEditor.getAttachments(),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    // An empty category is omitted rather than sent as "" (enum validation).
    if (categorySelect.value) record.category = categorySelect.value;
    else delete record.category;
    save.disabled = true;
    try {
      await sync.saveRecord('pmTasks', record, existing ? existing.version : null);
      await refreshState();
      toast(existing ? 'PM task saved.' : 'PM task added.');
      navigate(`#/pm/${encodeURIComponent(record.id)}`);
    } catch (error) {
      errorBox.textContent = 'Could not save. Please try again.';
      console.error(error);
    } finally {
      save.disabled = false;
    }
  });

  let dirty = false;
  form.addEventListener('input', () => {
    dirty = true;
  });
  form.addEventListener('change', () => {
    dirty = true;
  });

  return { node: form, isDirty: () => dirty };
}

function renderPMTaskForm(route) {
  const id = route.segments[1];
  const editing = Boolean(id && id !== 'new');
  const existing = editing ? pmTaskById(id) : null;
  setTitle(pmTaskFormTitle(existing));
  if (editing && !existing) {
    return page(
      pageHead('PM task not found'),
      emptyState('That PM task does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/pm' }, 'Back to PM'),
      ]),
    );
  }
  if (state.machines.length === 0) {
    return page(
      pageHead('Add PM task'),
      emptyState('Add a machine first', 'Every PM task belongs to a machine or building item.', [
        h('a', { class: 'btn btn-primary', href: '#/machines/new' }, 'Add a machine'),
      ]),
    );
  }
  // Read-only roles never see the form (entry buttons are hidden); direct
  // links land on this "View only" page. The server stays the authority.
  if (!can('pm', 'write')) {
    return page(
      pageHead(pmTaskFormTitle(existing)),
      emptyState(
        'View only',
        'You need the Preventive Maintenance write permission to add or edit PM tasks.',
        [h('a', { class: 'btn btn-primary', href: '#/pm' }, 'Back to PM')],
      ),
    );
  }
  const { node: form } = pmTaskFormBody({ existing });
  return page(pageHead(pmTaskFormTitle(existing)), form);
}

/* ---------- Home ---------- */

function counterTile(label, value, href, tone = '') {
  return h(
    'a',
    { class: `counter${tone ? ` ${tone}` : ''}`, href },
    h('span', { class: 'counter-value' }, String(value)),
    h('span', { class: 'counter-label' }, label),
  );
}

function backupReminder(today) {
  const last = storageGet(LAST_BACKUP_KEY);
  if (!last) {
    return h(
      'div',
      { class: 'backup-note' },
      h('span', {}, 'No backup yet. ', h('a', { href: '#/settings' }, 'Export one in Settings'), '.'),
    );
  }
  const days = daysBetween(String(last).slice(0, 10), today);
  if (days === null || days < 7) return null;
  return h(
    'div',
    { class: 'backup-note' },
    h(
      'span',
      {},
      `Last backup ${days} day${days === 1 ? '' : 's'} ago. `,
      h('a', { href: '#/settings' }, 'Export a fresh backup'),
      '.',
    ),
  );
}

function renderHome() {
  setTitle('Home');
  const today = todayISO();
  const counts = dashboardCounts(state, today);
  const hasAnyData =
    state.machines.length > 0 ||
    state.parts.length > 0 ||
    state.workOrders.length > 0 ||
    state.pmTasks.length > 0;

  if (!hasAnyData) {
    return page(
      pageHead('Today'),
      emptyState('Set up your shop', 'Add your machines, then log your first repair.', [
        can('machines', 'write') ? h('a', { class: 'btn btn-primary', href: '#/machines/new' }, 'Add a machine') : null,
        h('button', { class: 'btn', type: 'button', onclick: loadSampleData }, 'Load sample data'),
        h('a', { class: 'btn', href: '#/help' }, 'New here? Read the guide'),
      ]),
    );
  }

  const attention = needsAttention(state, today, 10);
  const attentionHost = attention.length
    ? h(
        'div',
        { class: 'list' },
        ...attention.map((item) => {
          const href =
            item.type === 'pm'
              ? `#/pm/${encodeURIComponent(item.id)}`
              : item.type === 'job'
                ? `#/jobs/${encodeURIComponent(item.id)}`
                : `#/parts/${encodeURIComponent(item.id)}`;
          return h(
            'a',
            { class: `attention-item type-${item.type}`, href },
            h(
              'div',
              { class: 'row-main' },
              h('div', { class: 'row-title' }, item.title),
              h('div', { class: 'row-sub' }, item.subtitle),
            ),
            h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'),
          );
        }),
      )
    : h('div', { class: 'card' }, h('p', { class: 'muted', style: { margin: 0 } }, 'All clear — nothing overdue, urgent or low right now.'));

  const pmDueWeek = state.pmTasks
    .filter((task) => task.active !== false)
    .filter((task) => !pmPaused(machineById(task.machineId)))
    .filter((task) => {
      if (pmState(task, today) === 'overdue') return true;
      const days = daysBetween(today, pmDueDate(task, today));
      return days !== null && days >= 0 && days <= 7;
    })
    .sort(
      (a, b) =>
        pmDueDate(a, today).localeCompare(pmDueDate(b, today)) ||
        String(a.title).localeCompare(String(b.title)),
    );
  const pmWeekHost = pmDueWeek.length
    ? h('div', { class: 'list' }, ...pmDueWeek.map(pmTaskRow))
    : h(
        'div',
        { class: 'card' },
        h('p', { class: 'muted', style: { margin: 0 } }, 'Nothing due in the next 7 days.'),
      );

  return page(
    pageHead('Today'),
    backupReminder(today),
    h(
      'div',
      { class: 'counters' },
      counterTile('Open service orders', counts.openJobs, '#/jobs?filter=active', counts.openJobs > 0 ? 'is-warn' : ''),
      counterTile(
        'Waiting (parts/tech)',
        counts.waiting,
        '#/jobs?filter=waiting',
        counts.waiting > 0 ? 'is-warn' : '',
      ),
      counterTile('PM overdue', counts.pmOverdue, '#/pm', counts.pmOverdue > 0 ? 'is-alert' : ''),
      counterTile('PM due soon', counts.pmDueSoon, '#/pm', counts.pmDueSoon > 0 ? 'is-warn' : ''),
      counterTile('Low stock', counts.lowStock, '#/parts?low=1', counts.lowStock > 0 ? 'is-alert' : ''),
    ),
    h(
      'div',
      { class: 'home-columns' },
      h('section', { class: 'home-column' }, sectionTitle('Needs attention'), attentionHost),
      h('section', { class: 'home-column' }, sectionTitle('PM due this week'), pmWeekHost),
    ),
  );
}

/* ---------- Settings ---------- */

function formatBackupStamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const dayPart = String(iso).slice(0, 10);
  return `${formatDate(dayPart)} ${hh}:${mm}`;
}

function downloadFile(filename, contentType, content) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportBackup() {
  const payload = {
    schemaVersion: 1,
    exportedAt: nowISO(),
    machines: state.machines,
    parts: state.parts,
    workOrders: state.workOrders,
    pmTasks: state.pmTasks,
  };
  downloadFile(
    `maint-log-backup-${todayISO()}.json`,
    'application/json',
    JSON.stringify(payload, null, 2),
  );
  storageSet(LAST_BACKUP_KEY, nowISO());
  toast('Backup exported to your downloads.');
  render();
}

function exportWorkOrderCSV() {
  if (state.workOrders.length === 0) {
    toast('No service orders to export yet.', 'warn');
    return;
  }
  downloadFile(
    `work-orders-${todayISO()}.csv`,
    'text/csv;charset=utf-8',
    workOrdersToCSV(state.workOrders, state.machines, state.parts),
  );
  toast(`Exported ${state.workOrders.length} service order${state.workOrders.length === 1 ? '' : 's'} to CSV.`);
}

async function importBackupFile(file, statusHost) {
  if (teamUser) {
    statusHost.textContent = 'Local backup import is not available while signed in to the team server.';
    return;
  }
  statusHost.textContent = `Reading ${file.name}…`;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const check = validateBackup(parsed);
    if (!check.ok) {
      statusHost.textContent = check.error;
      return;
    }
    const c = check.counts;
    const yes = await showConfirm({
      title: 'Replace all data with this backup?',
      message: `It holds ${c.machines} machine${c.machines === 1 ? '' : 's'}, ${c.parts} part${
        c.parts === 1 ? '' : 's'
      }, ${c.workOrders} service order${c.workOrders === 1 ? '' : 's'} and ${c.pmTasks} PM task${
        c.pmTasks === 1 ? '' : 's'
      }. Everything currently on this device is erased first. This cannot be undone.`,
      confirmText: 'Import backup',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!yes) {
      statusHost.textContent = 'Import cancelled.';
      return;
    }
    await db.replaceAll({
      machines: parsed.machines,
      parts: parsed.parts,
      workOrders: parsed.workOrders,
      pmTasks: parsed.pmTasks,
    });
    await refreshState();
    toast(`Imported ${c.machines} machines, ${c.parts} parts, ${c.workOrders} work orders, ${c.pmTasks} PM tasks.`);
    render();
  } catch (error) {
    statusHost.textContent = 'Could not read that file. Is it a JSON backup exported from this app?';
    console.error(error);
  }
}

async function loadSampleData() {
  if (teamUser) {
    toast('Example data is not available while signed in to the team server.', 'warn');
    return;
  }
  const hasData = BACKUP_STORES.some((store) => state[store].length > 0);
  if (hasData) {
    const yes = await showConfirm({
      title: 'Load example data?',
      message:
        'Example data for a small garment factory (8 machines, 6 parts, 6 work orders, 4 PM tasks) is added alongside your current data. Nothing is erased.',
      confirmText: 'Load example data',
      cancelText: 'Cancel',
    });
    if (!yes) return;
  }
  try {
    const sample = buildSampleData(new Date());
    for (const store of BACKUP_STORES) await db.bulkPut(store, sample[store]);
    await refreshState();
    toast('Example data loaded. Erase it any time in Settings.');
    render();
  } catch (error) {
    toast('Could not load the example data.', 'warn');
    console.error(error);
  }
}

async function eraseAllData() {
  if (teamUser) {
    toast('Erasing data on this device is not available while signed in to the team server.', 'warn');
    return;
  }
  await db.clearAll();
  storageRemove(LAST_BACKUP_KEY);
  await refreshState();
  toast('All data erased from this device.');
  render();
}

/* ---------- Team Settings: backups, users, v1 import (SPEC-v2.md 9.5-9.7) ---------- */

function roleLabel(user) {
  if (!user) return '';
  if (user.roleName) return user.roleName;
  return user.role === 'admin' ? 'Administrator' : 'Technician';
}

function formatBytes(bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Section 10: over plain HTTP on a LAN IP the app works but cannot install offline. */
function httpNotice() {
  if (typeof location === 'undefined') return null;
  if (location.protocol !== 'http:') return null;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return null;
  return h(
    'p',
    { class: 'settings-note' },
    'You opened this over plain HTTP. Everything works online, but the app cannot be installed or opened offline on phones — offline install needs HTTPS. See the HTTPS section of the README.',
  );
}

function suggestPassword(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

const STORE_LABELS = {
  machines: 'Machine',
  parts: 'Part',
  workOrders: 'Service order',
  pmTasks: 'PM task',
  coworkers: 'Coworker',
  contractors: 'Contractor',
};

/** Failed outbox entries from sync.js, with a Retry button (SPEC-v2.md 8). */
function failedSyncSection() {
  const host = h('div', { class: 'failed-list' });

  async function refresh() {
    let entries = [];
    try {
      entries = await sync.failedEntries();
    } catch (error) {
      console.warn('Could not read the failed-changes list:', error);
      return;
    }
    const rows = (Array.isArray(entries) ? entries : []).map((entry) => {
      if (entry && entry.kind === 'stock') {
        return `Stock change: ${entry.error || 'the server rejected it.'}`;
      }
      let label = STORE_LABELS[entry.store] || 'Record';
      const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
      if (payload.title || payload.name) label = `${label} "${payload.title || payload.name}"`;
      return `${label}: ${entry.error || 'The server rejected this change.'}`;
    });
    host.replaceChildren();
    if (rows.length === 0) return;
    const retry = h('button', { class: 'btn btn-small', type: 'button' }, 'Retry');
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      try {
        await sync.retryFailed();
        toast('Retrying the failed changes…');
      } catch (error) {
        toast('Could not retry. Please try again.', 'warn');
        console.error(error);
      } finally {
        await refresh();
      }
    });
    host.append(
      h('p', { class: 'field-hint' }, 'These changes were rejected by the server and are not retried automatically:'),
      ...rows.map((text) => h('div', { class: 'failed-entry' }, text)),
      h('div', { class: 'button-row', style: { marginTop: '0.5rem' } }, retry),
    );
  }

  refresh();
  return host;
}

/** Recent server backups list (time, creator or Automatic, size, admin download). */
async function loadServerBackups(listHost) {
  let response;
  try {
    response = await sync.api('GET', '/api/backups');
  } catch (error) {
    console.warn('Could not load the server backup list:', error);
    listHost.replaceChildren(
      h('p', { class: 'muted', style: { margin: '0.5rem 0 0' } }, 'The backup list needs a connection to the server.'),
    );
    return;
  }
  if (!response.ok || !Array.isArray(response.data)) {
    listHost.replaceChildren(
      h('p', { class: 'muted', style: { margin: '0.5rem 0 0' } }, 'Could not load the backup list. Try again in a moment.'),
    );
    return;
  }
  const backups = response.data;
  if (backups.length === 0) {
    listHost.replaceChildren(
      h('p', { class: 'muted', style: { margin: '0.5rem 0 0' } }, 'No backups on the server yet.'),
    );
    return;
  }
  listHost.replaceChildren(
    h(
      'div',
      { class: 'server-list' },
      ...backups.map((backup) =>
        h(
          'div',
          { class: 'server-row' },
          h(
            'span',
            { class: 'grow' },
            `${backup.createdAt ? formatBackupStamp(backup.createdAt) : 'Unknown time'} · ${backup.createdBy || 'Automatic'}`,
          ),
          h('span', { class: 'muted' }, formatBytes(backup.bytes)),
          can('backups', 'write') && backup.file
            ? h(
                'a',
                { class: 'btn btn-small', href: `/api/backups/${encodeURIComponent(backup.file)}` },
                'Download',
              )
            : null,
        ),
      ),
    ),
  );
}

/** "Backups on server" card with the one-click Back up now button (SPEC-v2.md 9.5). */
function serverBackupsCard() {
  const statusLine = h('p', { class: 'field-hint', role: 'status' });
  const listHost = h('div');
  // "Back up now" and Download need backups Write (SPEC-v3.md 13.1).
  const canBackupNow = can('backups', 'write');
  const backupNow = h('button', { class: 'btn btn-primary', type: 'button' }, 'Back up now');
  backupNow.addEventListener('click', async () => {
    backupNow.disabled = true;
    backupNow.textContent = 'Backing up…';
    try {
      const response = await sync.api('POST', '/api/backups');
      if (response.ok && response.data && response.data.file) {
        statusLine.textContent = `Backup saved on server: ${response.data.file} (${formatBytes(response.data.bytes)}).`;
        toast('Backup saved on the server.');
      } else {
        // 429 (more than one per 30 s) or another rejection: the server's text.
        statusLine.textContent =
          (response.data && response.data.message) || `The server did not save the backup (HTTP ${response.status}).`;
      }
    } catch (error) {
      statusLine.textContent = 'Could not reach the server for the backup.';
      console.warn('Backup now failed (network):', error);
    } finally {
      backupNow.disabled = false;
      backupNow.textContent = 'Back up now';
      loadServerBackups(listHost);
    }
  });
  loadServerBackups(listHost);
  return h(
    'section',
    { class: 'card', style: { padding: '0.95rem 1rem', marginTop: '0.5rem' } },
    h('h3', { class: 'card-title' }, 'Backups on server'),
    h(
      'p',
      { class: 'field-hint' },
      canBackupNow
        ? 'One click saves a backup file on the server. The server also saves one automatically every night.'
        : 'The server saves one backup automatically every night; an administrator can save and download more.',
    ),
    canBackupNow ? h('div', { class: 'button-row' }, backupNow) : null,
    statusLine,
    listHost,
  );
}

/** Settings link to the Admin dashboard (SPEC-v3.md 13.3: users moved there). */
function adminLinkNote() {
  return h(
    'p',
    { class: 'field-hint' },
    h('a', { href: '#/admin' }, 'Manage users and roles in Admin'),
    ' — add teammates, assign roles and reset passwords there.',
  );
}

const LOGO_UPLOAD_MAX_BYTES = 512 * 1024;
const LOGO_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Settings → Branding card (SPEC-v3.md section 8): app name and logo. */
function brandingCard() {
  const status = h('p', { class: 'field-hint', role: 'status' });
  const nameInput = h('input', {
    type: 'text',
    maxlength: '40',
    autocomplete: 'off',
    value: brandName(),
    'aria-label': 'App name',
  });
  const saveName = h('button', { class: 'btn btn-primary btn-small', type: 'button' }, 'Save name');
  saveName.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (name.length < 1 || name.length > 40) {
      status.textContent = 'The app name must be between 1 and 40 characters.';
      return;
    }
    saveName.disabled = true;
    try {
      const response = await sync.api('PUT', '/api/branding', { name });
      if (!response.ok) {
        status.textContent = (response.data && response.data.message) || 'The server rejected the name.';
        return;
      }
      await db.setMeta('branding', response.data);
      applyBranding(response.data);
      status.textContent = '';
      toast('App name saved.');
    } catch (error) {
      status.textContent = 'Could not reach the server. Try again.';
      console.warn('Branding name save failed (network):', error);
    } finally {
      saveName.disabled = false;
    }
  });

  const previewHost = h('div', { class: 'branding-preview' });
  const renderPreview = () => {
    const logoUrl = brandLogoUrl();
    previewHost.replaceChildren(
      logoUrl
        ? h('img', { class: 'brand-logo branding-logo-preview', src: logoUrl, alt: 'Current logo' })
        : h('span', { class: 'muted' }, 'No logo yet.'),
    );
  };

  const logoInput = h('input', {
    type: 'file',
    accept: LOGO_UPLOAD_TYPES.join(','),
    class: 'sr-only',
    'aria-label': 'Logo image file',
  });
  logoInput.addEventListener('change', async () => {
    const file = logoInput.files && logoInput.files[0];
    logoInput.value = '';
    if (!file) return;
    if (!LOGO_UPLOAD_TYPES.includes(String(file.type || ''))) {
      status.textContent = 'The logo must be a PNG, JPEG or WebP image (no SVG).';
      return;
    }
    if (file.size > LOGO_UPLOAD_MAX_BYTES) {
      status.textContent = 'That image is too large. The maximum is 512 KB.';
      return;
    }
    status.textContent = `Uploading ${file.name}…`;
    try {
      const response = await fetch('/api/branding/logo', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'X-Requested-With': 'maint-log',
          'Content-Type': String(file.type),
          'X-File-Name': encodeURIComponent(file.name || 'logo'),
        },
        body: file,
      });
      if (!response.ok) {
        let message = `Upload failed (HTTP ${response.status}).`;
        try {
          const data = await response.json();
          if (data && data.message) message = data.message;
        } catch {
          // keep the generic message
        }
        status.textContent = message;
        return;
      }
      const data = await response.json();
      await db.setMeta('branding', data);
      applyBranding(data);
      renderPreview();
      status.textContent = '';
      toast('Logo saved.');
    } catch (error) {
      status.textContent = 'Could not reach the server. Try again.';
      console.warn('Logo upload failed (network):', error);
    }
  });

  logoInput.id = `branding-logo-${++fieldCounter}`;
  const uploadLogo = h('label', { class: 'btn btn-small', for: logoInput.id }, 'Upload logo…');

  const removeLogo = h('button', { class: 'btn btn-small', type: 'button' }, 'Remove logo');
  const syncRemoveLogo = () => {
    removeLogo.hidden = !brandLogoUrl();
  };
  removeLogo.addEventListener('click', async () => {
    removeLogo.disabled = true;
    try {
      const response = await sync.api('DELETE', '/api/branding/logo');
      if (!response.ok) {
        status.textContent = (response.data && response.data.message) || 'The server kept the logo.';
        return;
      }
      await db.setMeta('branding', response.data);
      applyBranding(response.data);
      renderPreview();
      syncRemoveLogo();
      status.textContent = '';
      toast('Logo removed.');
    } catch (error) {
      status.textContent = 'Could not reach the server. Try again.';
      console.warn('Logo remove failed (network):', error);
    } finally {
      removeLogo.disabled = false;
    }
  });

  renderPreview();
  syncRemoveLogo();
  return h(
    'section',
    { class: 'card', style: { padding: '0.95rem 1rem', marginTop: '0.5rem' } },
    h('h3', { class: 'card-title' }, 'Branding'),
    h('p', { class: 'field-hint' }, 'The app name and logo show in the sidebar, header and sign-in card.'),
    h('div', { class: 'button-row' }, field('App name', nameInput), saveName),
    h('div', { class: 'button-row' }, previewHost, uploadLogo, logoInput, removeLogo),
    status,
  );
}

/** Admin Import v1 data card (SPEC-v2.md 9.7 and section 11). */
function importV1Card() {
  const status = h('p', { class: 'field-hint', role: 'status' });
  const fileInputId = `import-v1-file-${++fieldCounter}`;
  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    class: 'sr-only',
    'aria-label': 'v1 backup JSON file',
  });
  fileInput.id = fileInputId;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    status.textContent = `Reading ${file.name}…`;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      status.textContent = 'Could not read that file. Is it a v1 JSON backup?';
      console.warn('Import v1 parse failed:', error);
      return;
    }
    const check = validateBackup(parsed);
    if (!check.ok) {
      status.textContent = check.error;
      return;
    }
    const c = check.counts;
    const yes = await showConfirm({
      title: 'Import this v1 backup into the shared log?',
      message: `It holds ${c.machines} machine${c.machines === 1 ? '' : 's'}, ${c.parts} part${
        c.parts === 1 ? '' : 's'
      }, ${c.workOrders} service order${c.workOrders === 1 ? '' : 's'} and ${c.pmTasks} PM task${
        c.pmTasks === 1 ? '' : 's'
      }. Records whose ids already exist on the server are skipped. The whole team sees imported records after their next sync.`,
      confirmText: 'Import',
      cancelText: 'Cancel',
    });
    if (!yes) {
      status.textContent = 'Import cancelled.';
      return;
    }
    try {
      const response = await sync.api('POST', '/api/import-v1', parsed);
      if (!response.ok) {
        status.textContent = (response.data && response.data.message) || 'The server rejected the import.';
        return;
      }
      const created = response.data && Number(response.data.created);
      const skipped = response.data && Number(response.data.skipped);
      status.textContent = `Imported ${created} record${created === 1 ? '' : 's'}${
        skipped > 0 ? `, skipped ${skipped} already present` : ''
      }.`;
      toast(`Imported ${created} v1 record${created === 1 ? '' : 's'} onto the server.`);
      await sync.pull();
      await refreshState();
      render();
    } catch (error) {
      status.textContent = 'Could not reach the server for the import.';
      console.warn('Import v1 failed (network):', error);
    }
  });
  return h(
    'section',
    { class: 'card', style: { padding: '0.95rem 1rem', marginTop: '0.5rem' } },
    h('h3', { class: 'card-title' }, 'Import v1 data'),
    h(
      'p',
      { class: 'field-hint' },
      'Bring a v1 JSON backup (from the old single-device app) into the shared log. Existing records on the server are kept.',
    ),
    h('div', { class: 'button-row' }, h('label', { class: 'btn btn-primary btn-small', for: fileInputId }, 'Choose v1 backup file…')),
    fileInput,
    status,
  );
}

function renderSettings() {
  setTitle('Settings');
  const lastBackup = storageGet(LAST_BACKUP_KEY);
  const team = Boolean(teamUser);

  // Local JSON import stays available only in standalone mode (SPEC-v2.md 9.5).
  const importStatus = h('p', { class: 'field-hint', role: 'status' });
  const fileInputId = `import-file-${++fieldCounter}`;
  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    class: 'sr-only',
    'aria-label': 'Backup JSON file',
  });
  fileInput.id = fileInputId;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) await importBackupFile(file, importStatus);
  });

  const eraseInput = h('input', {
    type: 'text',
    placeholder: 'Type ERASE to confirm',
    autocomplete: 'off',
    'aria-label': 'Type ERASE to confirm erasing all data',
  });
  const eraseConfirm = h('button', { class: 'btn btn-danger', type: 'button', disabled: true }, 'Erase everything');
  eraseInput.addEventListener('input', () => {
    eraseConfirm.disabled = eraseInput.value.trim() !== 'ERASE';
  });
  eraseInput.id = `erase-input-${++fieldCounter}`;
  eraseConfirm.addEventListener('click', async () => {
    if (eraseInput.value.trim() !== 'ERASE') return;
    eraseConfirm.disabled = true;
    try {
      await eraseAllData();
    } catch (error) {
      toast('Could not erase. Please try again.', 'warn');
      console.error(error);
    }
  });
  const erasePanel = h(
    'div',
    { class: 'card erases', hidden: true },
    h('label', { class: 'field-label', for: eraseInput.id }, 'Type ERASE to confirm'),
    eraseInput,
    eraseConfirm,
  );
  const eraseReveal = h('button', { class: 'btn btn-danger', type: 'button' }, 'Erase all data…');
  eraseReveal.addEventListener('click', () => {
    erasePanel.hidden = false;
    eraseInput.focus();
  });

  return page(
    pageHead('Settings'),
    h(
      'p',
      { class: 'field-hint' },
      h('a', { href: '#/help' }, 'How this app works'),
      ' — a short guide with a glossary and FAQ.',
    ),
    httpNotice(),
    team
      ? h(
          'p',
          { class: 'muted' },
          `Signed in as ${teamUser.displayName} (${roleLabel(teamUser)}) — everyone on the team shares one log on the server.`,
        )
      : h('p', { class: 'muted' }, 'All data lives on this device only. Keep a backup copy somewhere safe.'),
    h('p', { class: 'field-hint' }, `Last backup: ${lastBackup ? formatBackupStamp(lastBackup) : 'Never'}`),
    sectionTitle(team ? 'Backup on this device' : 'Backup'),
    h(
      'div',
      { class: 'settings-actions' },
      h('button', { class: 'btn', type: 'button', onclick: exportBackup }, 'Export backup (JSON)', h('small', {}, 'Everything on this device in one file')),
      team
        ? null
        : h('label', { class: 'btn', for: fileInputId }, 'Import backup', h('small', {}, 'Replace all data from a backup file')),
      h('button', { class: 'btn', type: 'button', onclick: exportWorkOrderCSV }, 'Export service orders (CSV)', h('small', {}, 'For Excel or email')),
      team ? null : fileInput,
    ),
    team ? null : importStatus,
    team
      ? [
          can('backups') ? [sectionTitle('Backups on server'), serverBackupsCard()] : null,
          failedSyncSection(),
          canAdminUI() ? adminLinkNote() : null,
          canAdminUI() ? [sectionTitle('Import v1 data'), importV1Card()] : null,
          // Branding, AI provider settings (SPEC-v3.md 13.1) need settings Write.
          can('settings', 'write') ? [sectionTitle('Branding'), brandingCard()] : null,
          can('settings', 'write') ? [sectionTitle('AI assistant'), aiSettingsCard()] : null,
        ]
      : [
          sectionTitle('Data'),
          h(
            'div',
            { class: 'settings-actions' },
            h('button', { class: 'btn', type: 'button', onclick: loadSampleData }, 'Load sample data', h('small', {}, 'Example machines, parts, service orders and PM tasks')),
            eraseReveal,
          ),
          erasePanel,
        ],
  );
}

/* ---------- Admin dashboard (SPEC-v3.md 13.3): users, roles matrix ---------- */

function actionToast(message, { label, onAction, type = '' } = {}) {
  const node = h('div', { class: `toast ${type}`.trim(), role: 'status' }, message, ' ');
  const button = h('button', { class: 'btn btn-small toast-action', type: 'button' }, label);
  button.addEventListener('click', () => {
    node.remove();
    if (typeof onAction === 'function') onAction();
  });
  node.append(button);
  toastRoot.append(node);
  setTimeout(() => node.remove(), 8000);
  return node;
}

async function loadRoles() {
  try {
    const response = await sync.api('GET', '/api/roles');
    if (response.ok && Array.isArray(response.data)) return response.data;
  } catch (error) {
    console.warn('Could not load the roles list:', error);
  }
  return null;
}

async function loadUsersOnce() {
  try {
    const response = await sync.api('GET', '/api/users');
    if (response.ok && Array.isArray(response.data)) {
      teamUsers = response.data;
      await db.setMeta('users', teamUsers);
      return response.data;
    }
  } catch (error) {
    console.warn('Could not load the users list:', error);
  }
  return null;
}

function adminApiError(response, fallback) {
  return (response && response.data && response.data.message) || fallback;
}

function roleSelectElement(roles, selectedRoleId, onPick) {
  const select = h('select', { 'aria-label': 'Role' });
  for (const role of roles) {
    const option = h('option', { value: role.id }, role.name);
    if (role.id === selectedRoleId) option.selected = true;
    select.append(option);
  }
  if (typeof onPick === 'function') select.addEventListener('change', () => onPick(select.value));
  return select;
}

async function patchUserFields(user, fields) {
  try {
    const response = await sync.api('PATCH', `/api/users/${encodeURIComponent(user.id)}`, fields);
    if (!response.ok) return { ok: false, message: adminApiError(response, 'The server rejected the change.') };
    return { ok: true, user: response.data };
  } catch (error) {
    console.warn('User patch failed (network):', error);
    return { ok: false, message: 'Could not reach the server. Try again.' };
  }
}

function adminUsersTable({ users, roles, onRoleChange, onToggle, onResetPassword }) {
  const head = h(
    'tr',
    {},
    h('th', { scope: 'col' }, 'Name'),
    h('th', { scope: 'col' }, 'Username'),
    h('th', { scope: 'col' }, 'Role'),
    h('th', { scope: 'col' }, 'Status'),
    h('th', { scope: 'col' }, 'Last sign-in'),
    h('th', { scope: 'col' }, 'Created'),
  );
  const rows = [...users]
    .sort((a, b) => String(a.displayName || a.username).localeCompare(String(b.displayName || b.username)))
    .map((user) => {
      const disabled = Boolean(user.disabled);
      const toggle = h(
        'button',
        {
          class: `btn btn-small${disabled ? '' : ' btn-danger'}`,
          type: 'button',
          onclick: () => onToggle(user),
        },
        disabled ? 'Enable' : 'Disable',
      );
      const reset = h(
        'button',
        { class: 'btn btn-small', type: 'button', onclick: () => onResetPassword(user) },
        'Reset password',
      );
      return h(
        'tr',
        { class: disabled ? 'is-disabled' : '' },
        h('td', {}, user.displayName || user.username),
        h('td', {}, user.username || ''),
        h('td', {}, roleSelectElement(roles, user.roleId, (roleId) => onRoleChange(user, roleId))),
        h('td', {}, toggle, ' ', reset),
        h('td', {}, user.lastSignIn ? formatSyncTime(user.lastSignIn) : '—'),
        h('td', {}, user.createdAt ? formatDate(user.createdAt.slice(0, 10)) : '—'),
      );
    });
  return h(
    'div',
    { class: 'table-wrap matrix-scroll' },
    h(
      'table',
      { class: 'table admin-users-table' },
      h('thead', {}, head),
      h('tbody', {}, ...rows),
    ),
  );
}

function addUserDrawerBody({ roles, onDone }) {
  const errorBox = h('div', { class: 'form-error', role: 'alert' });
  const usernameInput = h('input', {
    type: 'text',
    autocomplete: 'off',
    placeholder: 'e.g. maria',
    'aria-label': 'New user username',
  });
  const displayNameInput = h('input', {
    type: 'text',
    autocomplete: 'off',
    placeholder: 'e.g. Maria P.',
    'aria-label': 'New user display name',
  });
  const defaultRole = roles.find((role) => role.name === 'Technician') || roles[0];
  const roleSelect = roleSelectElement(roles, defaultRole ? defaultRole.id : '');
  const passwordInput = h('input', {
    type: 'text',
    autocomplete: 'off',
    value: suggestPassword(),
    'aria-label': 'New user temporary password',
  });
  const form = h(
    'form',
    { class: 'form', novalidate: true },
    errorBox,
    h('div', { class: 'grid-2' }, field('Username', usernameInput), field('Display name', displayNameInput)),
    h('div', { class: 'grid-2' }, field('Role', roleSelect), field('Temporary password', passwordInput)),
    h(
      'p',
      { class: 'field-hint' },
      'They use the temporary password at the next sign-in. Minimum 6 characters.',
    ),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add user'),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const username = usernameInput.value.trim();
    const displayName = displayNameInput.value.trim();
    const password = passwordInput.value.trim();
    if (!username || !displayName) {
      errorBox.textContent = 'Enter a username and a display name.';
      return;
    }
    if (password.length < 6) {
      errorBox.textContent = 'The temporary password must be at least 6 characters.';
      return;
    }
    try {
      const response = await sync.api('POST', '/api/users', {
        username,
        displayName,
        roleId: roleSelect.value,
        password,
      });
      if (!response.ok) {
        errorBox.textContent = adminApiError(response, 'The server rejected the new user.');
        return;
      }
      toast(`User ${displayName} added. Give them the temporary password.`);
      await onDone();
      if (drawerHandle) drawerHandle.close();
    } catch (error) {
      errorBox.textContent = 'Could not reach the server. Try again.';
      console.warn('Add user failed (network):', error);
    }
  });
  return form;
}

/* Small inline-SVG lock for the Administrator matrix column. */
function lockIconNode() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'matrix-lock-svg');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '5');
  rect.setAttribute('y', '11');
  rect.setAttribute('width', '14');
  rect.setAttribute('height', '9');
  rect.setAttribute('rx', '2');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M8 11V7a4 4 0 0 1 8 0v4');
  svg.append(rect, path);
  return svg;
}

function rolesMatrixNode({ roles, draft, onChangeLevel }) {
  const headRow = h('tr', {}, h('th', { scope: 'col', class: 'matrix-area' }, 'Area'));
  for (const role of roles) {
    const locked = adminUI.isAdministratorRole(role);
    headRow.append(
      h(
        'th',
        { scope: 'col', class: locked ? 'matrix-role is-locked' : 'matrix-role' },
        h('span', {}, role.name),
        locked
          ? h(
              'span',
              {
                class: 'matrix-lock',
                title: 'The Administrator role keeps every permission and cannot be changed here.',
                'aria-label': 'Administrator role is locked',
              },
              lockIconNode(),
            )
          : null,
      ),
    );
  }
  const bodyRows = [];
  for (const area of AREAS) {
    const row = h(
      'tr',
      {},
      h('th', { scope: 'row', class: 'matrix-area' }, area.label),
    );
    for (const role of roles) {
      const locked = adminUI.isAdministratorRole(role);
      const value = draft && draft[role.id] ? draft[role.id][area.key] : 'none';
      row.append(
        h('td', {}, adminUI.renderLevelChoice(h, {
          roleId: role.id,
          area: area.key,
          value,
          disabled: locked,
          onChange: locked ? null : (level) => onChangeLevel(role.id, area.key, level),
        })),
      );
    }
    bodyRows.push(row);
  }
  return h(
    'div',
    { class: 'table-wrap matrix-scroll' },
    h(
      'table',
      { class: 'table roles-matrix' },
      h('thead', {}, headRow),
      h('tbody', {}, ...bodyRows),
    ),
  );
}

function openRoleHistoryDrawer(role) {
  const listHost = h('div');
  const drawerContent = h('div', {}, h('p', { class: 'muted' }, 'Loading history…'), listHost);
  openDrawer({ title: `History · ${role.name}`, content: drawerContent });
  sync
    .api('GET', `/api/roles/${encodeURIComponent(role.id)}/history`)
    .then((response) => {
      if (!response.ok || !Array.isArray(response.data)) {
        listHost.replaceChildren(
          h('p', { class: 'muted' }, adminApiError(response, 'Could not load the role history. Try again in a moment.')),
        );
        return;
      }
      if (response.data.length === 0) {
        listHost.replaceChildren(h('p', { class: 'muted' }, 'No history entries yet.'));
        return;
      }
      listHost.replaceChildren(
        adminUI.renderRoleHistoryList(h, response.data, { formatWhen: formatSyncTime }),
      );
    })
    .catch(() => {
      listHost.replaceChildren(h('p', { class: 'muted' }, 'Could not load the role history. Try again in a moment.'));
    });
}

function rolesTabSection({ roles, users, dirty, errorBox = h('div', { class: 'form-error', role: 'alert' }) }) {
  const draft = adminUI.draftFromRoles(roles);
  const unsavedBar = h('div', { class: 'unsaved-bar', hidden: true });
  const matrixHost = h('div');

  function refreshUnsaved() {
    const changed = adminUI.changedRolePatches(roles, draft);
    unsavedBar.hidden = changed.length === 0;
  }

  function renderMatrix() {
    matrixHost.replaceChildren(
      rolesMatrixNode({
        roles,
        draft,
        onChangeLevel: (roleId, area, level) => {
          draft[roleId][area] = level;
          refreshUnsaved();
        },
      }),
    );
  }

  renderMatrix();
  refreshUnsaved();

  const saveButton = h('button', { class: 'btn btn-primary btn-small', type: 'button' }, 'Save');
  const discardButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Discard');
  unsavedBar.append(
    h('span', { class: 'unsaved-bar-text' }, 'You have unsaved changes'),
    saveButton,
    discardButton,
  );

  async function saveChanges() {
    const patches = adminUI.changedRolePatches(roles, draft);
    saveButton.disabled = true;
    for (const patch of patches) {
      try {
        const response = await sync.api('PATCH', `/api/roles/${encodeURIComponent(patch.id)}`, {
          permissions: patch.permissions,
        });
        if (!response.ok) {
          errorBox.textContent = adminApiError(response, 'The server rejected the role change.');
          saveButton.disabled = false;
          return;
        }
        errorBox.textContent = '';
      } catch (error) {
        errorBox.textContent = 'Could not reach the server. Try again.';
        saveButton.disabled = false;
        return;
      }
    }
    saveButton.disabled = false;
    if (patches.length > 0) toast('Role permissions saved.');
    dirty();
  }

  saveButton.addEventListener('click', saveChanges);

  const newRoleButton = h('button', { class: 'btn btn-primary btn-small', type: 'button' }, 'New role');
  newRoleButton.addEventListener('click', () => {
    const errorBox2 = h('div', { class: 'form-error', role: 'alert' });
    const nameInput = h('input', { type: 'text', autocomplete: 'off', placeholder: 'e.g. Supervisor', 'aria-label': 'New role name' });
    const copyOptions = [h('option', { value: '' }, 'Start empty — no access')];
    for (const role of roles) {
      if (adminUI.isAdministratorRole(role)) continue;
      copyOptions.push(h('option', { value: role.id }, `Copy from ${role.name}`));
    }
    const copySelect = h('select', { 'aria-label': 'Copy permissions from' }, ...copyOptions);
    const form = h(
      'form',
      { class: 'form', novalidate: true },
      errorBox2,
      field('Name', nameInput, '1–40 characters, unique.'),
      field('Copy permissions', copySelect, 'A new role can start from an existing one or from no access.'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create role'),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox2.textContent = '';
      const name = nameInput.value.trim();
      if (name.length < 1 || name.length > 40) {
        errorBox2.textContent = 'The role name must be between 1 and 40 characters.';
        return;
      }
      const body = copySelect.value ? { name, copyOf: copySelect.value } : { name, permissions: {} };
      try {
        const response = await sync.api('POST', '/api/roles', body);
        if (!response.ok) {
          errorBox2.textContent = adminApiError(response, 'The server rejected the new role.');
          return;
        }
        toast(`Role "${response.data.name}" created.`);
        dirty();
        if (drawerHandle) drawerHandle.close();
      } catch (error) {
        errorBox2.textContent = 'Could not reach the server. Try again.';
        console.warn('Create role failed (network):', error);
      }
    });
    openDrawer({ title: 'New role', content: form });
  });

  const roleCardHost = h('div', {});
  function renderRoleCards() {
    roleCardHost.replaceChildren(
      ...roles.map((role) => {
        const locked = adminUI.isAdministratorRole(role);
        const deleteReason = adminUI.roleDeleteReason(role, users);
        const renameReason = adminUI.roleRenameReason(role);
        const historyButton = h(
          'button',
          { class: 'btn btn-small', type: 'button', onclick: () => openRoleHistoryDrawer(role) },
          'History',
        );
        const renameButton = h(
          'button',
          {
            class: 'btn btn-small',
            type: 'button',
            disabled: Boolean(renameReason),
            title: renameReason || 'Rename this role',
          },
          'Rename',
        );
        if (!renameReason) {
          renameButton.addEventListener('click', async () => {
            const name = await showInputDialog({
              title: `Rename ${role.name}`,
              message: '1–40 characters, unique.',
              label: 'New name',
              initial: role.name,
              confirmText: 'Rename',
            });
            if (name === null) return;
            const trimmed = name.trim();
            if (trimmed.length < 1 || trimmed.length > 40) {
              toast('The role name must be between 1 and 40 characters.', 'warn');
              return;
            }
            try {
              const response = await sync.api('PATCH', `/api/roles/${encodeURIComponent(role.id)}`, { name: trimmed });
              if (!response.ok) {
                toast(adminApiError(response, 'The server rejected the rename.'), 'warn');
                return;
              }
              toast(`Renamed to "${trimmed}".`);
              dirty();
            } catch (error) {
              toast('Could not reach the server. Try again.', 'warn');
              console.warn('Role rename failed (network):', error);
            }
          });
        }
        const deleteButton = h(
          'button',
          {
            class: 'btn btn-small btn-danger',
            type: 'button',
            disabled: Boolean(deleteReason),
            title: deleteReason || `Delete ${role.name}`,
            'aria-disabled': Boolean(deleteReason) || null,
          },
          'Delete',
        );
        if (!deleteReason) {
          deleteButton.addEventListener('click', async () => {
            const yes = await showConfirm({
              title: `Delete the role "${role.name}"?`,
              message: 'Roles that no user has can be deleted. This cannot be undone.',
              confirmText: 'Delete',
              cancelText: 'Cancel',
              danger: true,
            });
            if (!yes) return;
            try {
              const response = await sync.api('DELETE', `/api/roles/${encodeURIComponent(role.id)}`);
              if (!response.ok) {
                toast(adminApiError(response, 'The server rejected the delete.'), 'warn');
                return;
              }
              toast(`Role "${role.name}" deleted.`);
              dirty();
            } catch (error) {
              toast('Could not reach the server. Try again.', 'warn');
              console.warn('Role delete failed (network):', error);
            }
          });
        }
        const usersCount = users.filter((user) => user && user.roleId === role.id).length;
        return h(
          'div',
          { class: 'role-card' },
          h('strong', {}, role.name, locked ? h('span', { class: 'muted' }, ' (built-in)') : null),
          h('span', { class: 'muted' }, `${usersCount} user${usersCount === 1 ? '' : 's'}`),
          h('span', { class: 'role-card-actions' }, historyButton, renameButton, deleteButton),
          deleteReason ? h('span', { class: 'muted role-delete-reason' }, deleteReason) : null,
        );
      }),
    );
  }
  renderRoleCards();

  discardButton.addEventListener('click', () => {
    for (const role of roles) {
      if (draft[role.id]) draft[role.id] = adminUI.fullPermissions(role.permissions);
    }
    errorBox.textContent = '';
    renderMatrix();
    refreshUnsaved();
  });

  return h(
    'div',
    {},
    h('p', { class: 'field-hint' }, 'Each column is a role, each row a part of the app. None hides the area and Read keeps it view-only on every device.'),
    errorBox,
    matrixHost,
    unsavedBar,
    sectionTitle('Roles'),
    newRoleButton,
    roleCardHost,
  );
}

async function renderAdminUsersTab({ reload }) {
  const [roles, users] = await Promise.all([loadRoles(), loadUsersOnce()]);
  if (!roles || !users) {
    return h(
      'section',
      {},
      emptyState('User management needs a connection', 'The users and roles come from the server. Try again in a moment.', [
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => render() }, 'Try again'),
      ]),
    );
  }
  return adminUsersPanel({ roles, users, reload });
}

function adminUsersPanel({ roles, users, reload }) {
  const errorBox = h('div', { class: 'form-error', role: 'alert' });
  const tableHost = h('div');

  function refreshTable(list) {
    tableHost.replaceChildren(
      adminUsersTable({
        users: list,
        roles,
        onRoleChange: async (user, roleId) => {
          const previous = user.roleId;
          if (roleId === previous) return;
          const result = await patchUserFields(user, { roleId });
          if (!result.ok) {
            errorBox.textContent = result.message;
            await reload();
            return;
          }
          errorBox.textContent = '';
          teamUsers = teamUsers.map((entry) => (entry.id === user.id ? result.user : entry));
          const next = result.user;
          actionToast(`${next.displayName || next.username} is now ${next.roleName || roleNameOf(roles, roleId)}.`, {
            label: 'Undo',
            onAction: async () => {
              const undo = await patchUserFields(next, { roleId: previous });
              if (!undo.ok) {
                toast(undo.message, 'warn');
                await reload();
                return;
              }
              teamUsers = teamUsers.map((entry) => (entry.id === next.id ? undo.user : entry));
              toast(`Role restored for ${next.displayName || next.username}.`);
              await reload();
            },
          });
          await reload();
        },
        onToggle: async (user) => {
          const disabling = !user.disabled;
          if (disabling) {
            const yes = await showConfirm({
              title: `Disable ${user.displayName || user.username}?`,
              message: 'They are signed out everywhere at once and cannot sign in until you re-enable them.',
              confirmText: 'Disable',
              cancelText: 'Cancel',
              danger: true,
            });
            if (!yes) return;
          }
          const result = await patchUserFields(user, { disabled: disabling });
          if (!result.ok) {
            errorBox.textContent = result.message;
            await reload();
            return;
          }
          errorBox.textContent = '';
          teamUsers = teamUsers.map((entry) => (entry.id === user.id ? result.user : entry));
          toast(`${result.user.displayName || result.user.username} is ${disabling ? 'disabled' : 'able to sign in again'}.`);
          await reload();
        },
        onResetPassword: async (user) => {
          const password = await showInputDialog({
            title: `Reset password for ${user.displayName || user.username}`,
            message: 'They use the new password at the next sign-in. Minimum 6 characters.',
            label: 'New temporary password',
            initial: suggestPassword(),
            confirmText: 'Reset password',
          });
          if (password === null) return;
          const trimmed = password.trim();
          if (trimmed.length < 6) {
            toast('The password must be at least 6 characters.', 'warn');
            return;
          }
          const result = await patchUserFields(user, { password: trimmed });
          if (!result.ok) {
            errorBox.textContent = result.message;
            return;
          }
          errorBox.textContent = '';
          toast(`Password reset for ${user.displayName || user.username}.`);
        },
      }),
    );
  }

  refreshTable(users);

  const addUserButton = h('button', { class: 'btn btn-primary btn-small', type: 'button' }, 'Add user');
  addUserButton.addEventListener('click', () => {
    openDrawer({
      title: 'Add user',
      content: addUserDrawerBody({
        roles,
        onDone: reload,
      }),
    });
  });

  return h(
    'section',
    {},
    h('p', { class: 'field-hint' }, 'Role changes save immediately and can be undone from the toast. Disabled users are signed out at once.'),
    errorBox,
    addUserButton,
    tableHost,
  );
}

function roleNameOf(roles, roleId) {
  const role = roles.find((entry) => entry && entry.id === roleId);
  return role ? role.name : '';
}

async function renderAdminRolesTab({ reload }) {
  const [roles, users] = await Promise.all([loadRoles(), loadUsersOnce()]);
  if (!roles) {
    return emptyState(
      'Roles need a connection',
      'The roles come from the server. Try again in a moment.',
      [h('button', { class: 'btn btn-primary', type: 'button', onclick: () => render() }, 'Try again')],
    );
  }
  return rolesTabSection({ roles, users: users || [], dirty: reload });
}

const ADMIN_TABS = [
  { key: 'users', label: 'Users', href: '#/admin/users' },
  { key: 'roles', label: 'Roles & permissions', href: '#/admin/roles' },
];

function adminTabLinks(activeKey) {
  return h(
    'nav',
    { class: 'stats-tabs admin-tabs', 'aria-label': 'Admin views' },
    ...ADMIN_TABS.map((tab) =>
      h(
        'a',
        { class: 'stats-tab', href: tab.href, 'aria-current': tab.key === activeKey ? 'page' : null },
        tab.label,
      ),
    ),
  );
}

/* The admin page renders its content asynchronously; the host is filled by
   the panel once the users/roles lists arrive. */
function renderAdmin(route) {
  setTitle('Admin');
  // Only roles with admin Write manage users (SPEC-v3.md 13.1/13.3).
  if (!canAdminUI()) {
    return noAccessPage('Admin', 'Users & roles');
  }
  const tab = route.segments[1] === 'roles' ? 'roles' : 'users';
  const reload = () => render();
  const host = h('div', {});
  const renderTab = tab === 'roles' ? renderAdminRolesTab : renderAdminUsersTab;
  renderTab({ reload }).then(
    (content) => host.replaceChildren(content),
    (error) => {
      console.error('Could not render the Admin page:', error);
      host.replaceChildren(
        emptyState('Could not load Admin', 'Try again in a moment.', [
          h('button', { class: 'btn btn-primary', type: 'button', onclick: reload }, 'Try again'),
        ]),
      );
    },
  );
  return page(
    pageHead('Admin'),
    adminTabLinks(tab),
    host,
  );
}

/* ---------- Statistics (SPEC-v3.md section 7, permissions section 13) ----------
   All numbers come from the pure functions in logic-stats.js over the local
   synced stores; charts are hand-written SVG from charts.js. The page is
   read-only, so a sync-applied re-render never loses user input. */

const STATS_TABS = [
  { key: 'monitor', label: 'Status monitor', href: '#/statistics' },
  { key: 'reports', label: 'Reports', href: '#/statistics/reports' },
];

function statsTabLinks(activeKey) {
  return h(
    'nav',
    { class: 'stats-tabs', 'aria-label': 'Statistics views' },
    ...STATS_TABS.map((tab) =>
      h(
        'a',
        { class: 'stats-tab', href: tab.href, 'aria-current': tab.key === activeKey ? 'page' : null },
        tab.label,
      ),
    ),
  );
}

/* Mount chart markup (a string from charts.js) without innerHTML
   (SPEC-v3.md section 11): parse it in an inert SVG document, then import
   the node. Nothing in the markup run scripts on its own, and all text was
   escaped when the string was built. */
function svgFromMarkup(markup) {
  const parsed = new DOMParser().parseFromString(String(markup), 'image/svg+xml');
  const root = parsed.documentElement;
  const broken = !root || root.nodeName !== 'svg' || parsed.querySelector('parsererror');
  if (broken) {
    console.warn('Chart markup could not be parsed.');
    return h('p', { class: 'muted field-hint' }, 'The chart could not be shown.');
  }
  return document.importNode(root, true);
}

/* Local date and time for "Down since" (a datetime shows both, a bare ISO
   date shows just the day). */
function statsWhen(iso) {
  const text = String(iso || '');
  if (!text) return '—';
  if (isISODate(text.slice(0, 10)) && text.length === 10) return formatDate(text);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function assigneeNamesText(order) {
  const names = ((order && order.assignees) || []).map(personName).filter(Boolean);
  return names.length > 0 ? names.join(', ') : '—';
}

function kpiHoursLabel(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number * 10) / 10} h` : '—';
}

function statTile(label, value, tone = '') {
  return h(
    'div',
    { class: `stat-tile${tone ? ` ${tone}` : ''}` },
    h('span', { class: 'stat-tile-value' }, String(value)),
    h('span', { class: 'stat-tile-label' }, label),
  );
}

/* ---- Status monitor tab ---- */

function renderStatisticsMonitor() {
  setTitle('Statistics');
  const counts = machineStatusCounts(state.machines);
  const tiles = MACHINE_STATUSES.map((status) =>
    h(
      'a',
      {
        class: `stat-tile stat-tile-link${status === 'down' && counts.down > 0 ? ' is-alert' : ''}`,
        href: `#/machines?status=${status}`,
        title: `Show machines that are ${(LABELS.machineStatus[status] || status).toLowerCase()}`,
      },
      h('span', { class: 'stat-tile-value' }, String(counts[status] || 0)),
      h('span', { class: 'stat-tile-label' }, LABELS.machineStatus[status] || status),
    ),
  );

  const downRows = downNow(state.machines, state.workOrders, nowISO());
  const downTable =
    downRows.length === 0
      ? emptyState('All machines are running', 'No machine is marked down right now.')
      : h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            { class: 'data-table stats-table stats-table-wide' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ...['Machine', 'Type', 'Down since', 'Service order', 'Assigned to', 'Hours down'].map((label) =>
                  h('th', { scope: 'col' }, label),
                ),
              ),
            ),
            h(
              'tbody',
              {},
              ...downRows.map((row) => {
                const order = row.order;
                return h(
                  'tr',
                  {},
                  h(
                    'td',
                    { 'data-col': 'machine' },
                    h('a', { href: `#/machines/${encodeURIComponent(row.machine.id)}` }, row.machine.name || '—'),
                  ),
                  h('td', { 'data-col': 'type' }, row.type || '—'),
                  h('td', { 'data-col': 'down-since' }, statsWhen(row.downSince)),
                  h(
                    'td',
                    { 'data-col': 'order' },
                    order
                      ? h(
                          'a',
                          { href: `#/jobs/${encodeURIComponent(order.id)}` },
                          `${formatOrderNumber(order.number)} · ${order.title || 'Untitled'}`,
                        )
                      : '—',
                  ),
                  h('td', { 'data-col': 'assignees' }, order ? assigneeNamesText(order) : '—'),
                  h('td', { 'data-col': 'hours' }, row.hoursDown === null ? '—' : `${row.hoursDown.toFixed(1)} h`),
                );
              }),
            ),
          ),
        );

  const strip = todayStrip(state.workOrders, state.pmTasks, state.machines, todayISO());

  return page(
    pageHead('Statistics'),
    statsTabLinks('monitor'),
    sectionTitle('Machines by status'),
    h('div', { class: 'stats-tiles' }, ...tiles),
    sectionTitle('Down now'),
    downTable,
    sectionTitle('Today'),
    h(
      'div',
      { class: 'stats-tiles' },
      statTile('Opened today', strip.openedToday),
      statTile('Closed today', strip.closedToday),
      statTile('Overdue now', strip.overdueNow, strip.overdueNow > 0 ? 'is-alert' : ''),
      statTile('PM due today', strip.pmDueToday, strip.pmDueToday > 0 ? 'is-warn' : ''),
    ),
  );
}

/* ---- Reports tab ---- */

const STATS_RANGE_KEY = 'maint-log:stats-range-days';
const STATS_RANGE_CHOICES = [30, 90, 365];
const DEFAULT_STATS_RANGE_DAYS = 30;

function loadStatsRangeDays() {
  const value = Number(storageGet(STATS_RANGE_KEY));
  return STATS_RANGE_CHOICES.includes(value) ? value : DEFAULT_STATS_RANGE_DAYS;
}

/* A semantic table from plain {key,label} columns and plain-object rows; the
   same columns feed tableToCSV for the Export CSV button. */
function statsTable(columns, rows) {
  return h(
    'table',
    { class: 'data-table stats-table' },
    h('thead', {}, h('tr', {}, ...columns.map((column) => h('th', { scope: 'col' }, column.label)))),
    h(
      'tbody',
      {},
      ...rows.map((row) =>
        h(
          'tr',
          {},
          ...columns.map((column) => {
            const value = row ? row[column.key] : null;
            return h(
              'td',
              { 'data-col': column.key },
              value === null || value === undefined || value === '' ? '—' : String(value),
            );
          }),
        ),
      ),
    ),
  );
}

/* One chart card: title, the SVG chart, a "Show table" toggle with an
   accessible table of the same numbers, and an Export CSV button
   (SPEC-v3.md section 7). */
function chartCard({ title, markup, columns, rows, filename }) {
  const chartHost = h('div', { class: 'chart-host' }, svgFromMarkup(markup));
  const table = statsTable(columns, rows);
  const tableHost = h('div', { class: 'table-scroll' }, table);
  tableHost.hidden = true;
  const toggle = h('button', { class: 'btn btn-small', type: 'button', 'aria-expanded': 'false' }, 'Show table');
  toggle.addEventListener('click', () => {
    const showTable = tableHost.hidden;
    tableHost.hidden = !showTable;
    chartHost.hidden = !showTable;
    toggle.textContent = showTable ? 'Show chart' : 'Show table';
    toggle.setAttribute('aria-expanded', showTable ? 'true' : 'false');
  });
  const exportButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Export CSV');
  exportButton.addEventListener('click', () => {
    downloadFile(filename, 'text/csv;charset=utf-8', tableToCSV(columns, rows));
    toast(`Exported “${title}” to CSV.`);
  });
  return h(
    'section',
    { class: 'card chart-card' },
    h(
      'div',
      { class: 'chart-card-head' },
      h('h3', { class: 'chart-card-title' }, title),
      h('div', { class: 'chart-card-actions' }, toggle, exportButton),
    ),
    chartHost,
    tableHost,
  );
}

function renderStatisticsReports() {
  setTitle('Statistics');
  const days = loadStatsRangeDays();
  const range = rangeFor(days);
  const values = kpis(
    { workOrders: state.workOrders, pmTasks: state.pmTasks, machines: state.machines },
    range,
  );

  const rangeSelector = h(
    'div',
    { class: 'stats-range', role: 'group', 'aria-label': 'Report range' },
    ...STATS_RANGE_CHOICES.map((choice) =>
      h(
        'button',
        {
          class: `stats-range-btn${choice === days ? ' is-active' : ''}`,
          type: 'button',
          'aria-pressed': choice === days ? 'true' : 'false',
          onclick: () => {
            if (choice === days) return;
            storageSet(STATS_RANGE_KEY, String(choice));
            render();
          },
        },
        `Last ${choice} days`,
      ),
    ),
  );

  /* Chart stores gate on the area permissions (SPEC-v3.md 13.3): a chart is
     only built from stores this user can read. */
  const showOrders = can('serviceOrders');
  const showMachines = can('machines');
  const showCoworkers = can('coworkers');
  const showContractors = can('contractors');
  const includeCost = canReadRates();

  const cards = [];

  if (showOrders) {
    const byStatus = countByStatus(state.workOrders);
    cards.push(
      chartCard({
        title: 'Service orders by status',
        markup: barChart(
          WORK_ORDER_STATUSES.map((status) => ({ label: LABELS.status[status], value: byStatus[status] })),
          { title: 'Service orders by status', unit: '' },
        ),
        columns: [
          { key: 'status', label: 'Status' },
          { key: 'count', label: 'Service orders' },
        ],
        rows: WORK_ORDER_STATUSES.map((status) => ({
          status: LABELS.status[status],
          count: byStatus[status],
        })),
        filename: `statistics-orders-by-status-${todayISO()}.csv`,
      }),
    );

    const weeks = createdVsCompletedWeekly(state.workOrders, range);
    cards.push(
      chartCard({
        title: 'Created vs completed per week',
        markup: lineChart(
          [
            {
              name: 'Created',
              values: weeks.map((week) => ({ label: formatDate(week.weekStart), value: week.created })),
            },
            {
              name: 'Completed',
              values: weeks.map((week) => ({ label: formatDate(week.weekStart), value: week.completed })),
            },
          ],
          { title: 'Created vs completed per week' },
        ),
        columns: [
          { key: 'week', label: 'Week starting' },
          { key: 'created', label: 'Created' },
          { key: 'completed', label: 'Completed' },
        ],
        rows: weeks.map((week) => ({
          week: formatDate(week.weekStart),
          created: week.created,
          completed: week.completed,
        })),
        filename: `statistics-created-vs-completed-${todayISO()}.csv`,
      }),
    );

    const byPriority = countByPriority(state.workOrders);
    cards.push(
      chartCard({
        title: 'Service orders by priority',
        markup: barChart(
          PRIORITIES.map((priority) => ({ label: LABELS.priority[priority], value: byPriority[priority] })),
          { title: 'Service orders by priority' },
        ),
        columns: [
          { key: 'priority', label: 'Priority' },
          { key: 'count', label: 'Service orders' },
        ],
        rows: PRIORITIES.map((priority) => ({
          priority: LABELS.priority[priority],
          count: byPriority[priority],
        })),
        filename: `statistics-orders-by-priority-${todayISO()}.csv`,
      }),
    );
  }

  if (showOrders && showMachines) {
    const byType = downtimeByMachineType(state.workOrders, state.machines, range);
    cards.push(
      chartCard({
        title: 'Downtime hours by machine type',
        markup: horizontalBarChart(
          byType.map((row) => ({ label: row.type, value: row.hours })),
          { title: 'Downtime hours by machine type', unit: 'h' },
        ),
        columns: [
          { key: 'type', label: 'Machine type' },
          { key: 'hours', label: 'Downtime hours' },
        ],
        rows: byType.map((row) => ({ type: row.type, hours: row.hours })),
        filename: `statistics-downtime-by-type-${todayISO()}.csv`,
      }),
    );

    const topBreakdowns = topMachinesByBreakdowns(state.workOrders, state.machines, range, 10);
    cards.push(
      chartCard({
        title: 'Top machines by breakdowns',
        markup: horizontalBarChart(
          topBreakdowns.map((row) => ({ label: row.machine.name, value: row.breakdowns })),
          { title: 'Top machines by breakdowns' },
        ),
        columns: [
          { key: 'machine', label: 'Machine' },
          { key: 'breakdowns', label: 'Breakdowns' },
          { key: 'downtime', label: 'Downtime hours' },
          { key: 'mtbf', label: 'MTBF (days)' },
        ],
        rows: topBreakdowns.map((row) => ({
          machine: row.machine.name,
          breakdowns: row.breakdowns,
          downtime: row.downtimeHours,
          mtbf: row.mtbfDays,
        })),
        filename: `statistics-top-machines-${todayISO()}.csv`,
      }),
    );
  }

  if (showContractors) {
    const contractors = labourByContractor(state.workOrders, state.contractors, range, { includeCost });
    const contractorColumns = [
      { key: 'contractor', label: 'Contractor' },
      { key: 'trade', label: 'Trade' },
      { key: 'orders', label: 'Service orders' },
      { key: 'hours', label: 'Hours' },
      // Cost only with the contractorRates permission (SPEC-v3.md 13.3).
      ...(includeCost ? [{ key: 'cost', label: 'Cost' }] : []),
    ];
    cards.push(
      chartCard({
        title: 'Labour hours by outside contractor',
        markup: horizontalBarChart(
          contractors.slice(0, 10).map((row) => ({ label: row.contractor.company, value: row.hours })),
          { title: 'Labour hours by outside contractor', unit: 'h' },
        ),
        columns: contractorColumns,
        rows: contractors.map((row) => {
          const entry = {
            contractor: row.contractor.company,
            trade: row.trade,
            orders: row.orders,
            hours: row.hours,
          };
          if (includeCost) entry.cost = row.cost === null ? '' : formatMoney(dollarsToCents(row.cost));
          return entry;
        }),
        filename: `statistics-contractor-hours-${todayISO()}.csv`,
      }),
    );
  }

  if (showCoworkers) {
    const coworkers = labourByCoworker(state.workOrders, state.coworkers, range);
    cards.push(
      chartCard({
        title: 'Labour hours by coworker',
        markup: horizontalBarChart(
          coworkers.slice(0, 10).map((row) => ({ label: row.coworker.name, value: row.hours })),
          { title: 'Labour hours by coworker', unit: 'h' },
        ),
        columns: [
          { key: 'coworker', label: 'Coworker' },
          { key: 'role', label: 'Role' },
          { key: 'orders', label: 'Service orders' },
          { key: 'hours', label: 'Hours' },
        ],
        rows: coworkers.map((row) => ({
          coworker: row.coworker.name,
          role: row.role,
          orders: row.orders,
          hours: row.hours,
        })),
        filename: `statistics-coworker-hours-${todayISO()}.csv`,
      }),
    );
  }

  return page(
    pageHead('Statistics', rangeSelector),
    statsTabLinks('reports'),
    h('p', { class: 'muted field-hint' }, `Every number covers ${range.from} to ${range.to}, computed on this device from synced data.`),
    sectionTitle('Key numbers'),
    h(
      'div',
      { class: 'kpi-tiles' },
      statTile('Open service orders', values.open),
      statTile('Overdue', values.overdue, values.overdue > 0 ? 'is-alert' : ''),
      statTile('MTTR', values.mttrHours === null ? '—' : `${values.mttrHours.toFixed(1)} h`),
      statTile('PM compliance', values.pmCompliancePct === null ? '—' : `${values.pmCompliancePct}%`),
      statTile('Downtime hours', kpiHoursLabel(values.downtimeHours)),
      statTile('Labour hours', kpiHoursLabel(values.labourHours)),
    ),
    sectionTitle('Charts'),
    h('div', { class: 'chart-grid' }, ...cards),
  );
}

/* ---------- Routing ---------- */

function updateNavCounts() {
  const counts = dashboardCounts(state, todayISO());
  const values = {
    jobs: counts.openJobs,
    parts: counts.lowStock,
    pm: counts.pmOverdue,
  };
  for (const badge of document.querySelectorAll('.sidebar .nav-count')) {
    const value = Math.max(0, Number(values[badge.dataset.count]) || 0);
    badge.textContent = String(value);
    badge.hidden = value === 0;
  }
}

async function render() {
  if (loginActive) return;
  const route = routeInfo();
  const [root, second, third] = route.segments;
  const tab = root || 'home';
  // Hidden areas leave the navigation too (SPEC-v3.md 13.3).
  applyNavPermissions();
  // AI chat button (V3-M8, SPEC-v3.md section 9): visibility follows the
  // aiAssistant permission and the server's provider status.
  updateAiChatButton();

  for (const link of document.querySelectorAll('.tab, .sidebar a[data-tab]')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  // The phone "More" button lights up while a sheet page is shown.
  if (moreButton) {
    if (['parts', 'requests', 'statistics', 'coworkers', 'contractors', 'help', 'settings', 'admin'].includes(tab)) {
      moreButton.setAttribute('aria-current', 'page');
    } else {
      moreButton.removeAttribute('aria-current');
    }
  }
  updateNavCounts();
  if (tab !== 'settings' && tab !== 'help' && tab !== 'admin') storageSet(LAST_TAB_KEY, tab);

  let content;
  let isDetail = false;
  let splitListRoot = null;
  let machineDrawer = false;

  if (!root || root === 'home') {
    content = renderHome();
  } else if (root === 'jobs') {
    let jobDrawer = false;
    if (!can('serviceOrders')) {
      content = noAccessPage('Service Orders', 'Service Orders');
    } else if (!second) {
      content = renderJobs(route);
    } else if (second === 'new') {
      if (!can('serviceOrders', 'write')) {
        content = noAccessPage('New service order', 'Service Orders');
      } else {
        // Desktop opens the form in the drawer (SPEC-v3.md section 3 item 6);
        // below 1024 px the full-page form stays.
        jobDrawer = maybeOpenJobDrawer(route);
        if (jobDrawer) {
          content = renderJobs({ segments: ['jobs'], params: route.params });
        } else {
          content = renderJobNew(route);
        }
      }
    } else {
      content = renderJobDetail(route);
      isDetail = true;
      splitListRoot = 'jobs';
    }
  } else if (root === 'machines') {
    if (!can('machines')) {
      content = noAccessPage('Machines', 'Machines');
    } else if (!second) {
      content = renderMachines(route);
    } else if (second === 'new' || third === 'edit') {
      if (!can('machines', 'write')) {
        content = noAccessPage(machineFormTitle(second === 'new' ? null : { name: '' }), 'Machines');
      } else {
        // M2 drawer usage (SPEC-v3.md section 10): the machine form opens in
        // the right drawer on desktop; phones and tablets keep the full page.
        machineDrawer = maybeOpenMachineDrawer(route);
        if (machineDrawer) {
          content = renderMachines({ segments: [], params: route.params });
        } else {
          content = renderMachineForm(route);
          if (second !== 'new') isDetail = true;
        }
      }
    } else {
      content = renderMachineDetail(route);
      isDetail = true;
      splitListRoot = 'machines';
    }
  } else if (root === 'parts') {
    if (!can('parts')) {
      content = noAccessPage('Parts', 'Parts & Stock');
    } else if (!second) {
      content = renderParts(route);
    } else if (second === 'new' || third === 'edit') {
      if (!can('parts', 'write')) {
        content = noAccessPage(second === 'new' ? 'Add part' : 'Edit part', 'Parts & Stock');
      } else {
        content = renderPartForm(route);
        if (second !== 'new') isDetail = true;
      }
    } else {
      content = renderPartDetail(route);
      isDetail = true;
      splitListRoot = 'parts';
    }
  } else if (root === 'requests') {
    // v4 (SPEC-v4.md section 3): parts requests — list, form (drawer on
    // desktop, full page below 1024 px), detail and the printable sheet.
    if (!can('purchasing')) {
      content = noAccessPage('Parts requests', 'Parts requests');
    } else if (!second) {
      content = renderRequests(route);
    } else if (second === 'new') {
      if (!can('purchasing', 'write')) {
        content = noAccessPage('New parts request', 'Parts requests');
      } else {
        // Desktop opens the form in the drawer (SPEC-v4.md 3.2); phones and
        // tablets keep the full-page form.
        const requestDrawer = maybeOpenRequestDrawer(route);
        if (requestDrawer) {
          content = renderRequests({ segments: ['requests'], params: route.params });
        } else {
          content = renderRequestFormPage(route, null);
        }
      }
    } else if (third === 'edit') {
      if (!can('purchasing', 'write')) {
        content = noAccessPage('Edit parts request', 'Parts requests');
      } else {
        const requestDrawer = maybeOpenRequestDrawer(route);
        if (requestDrawer) {
          content = renderRequests({ segments: ['requests'], params: route.params });
        } else {
          content = renderRequestFormPage(route, requestById(second));
          isDetail = true;
        }
      }
    } else if (third === 'sheet') {
      content = renderRequestSheetPage(route);
      isDetail = true;
    } else {
      content = renderRequestDetail(route);
      isDetail = true;
      splitListRoot = 'requests';
    }
  } else if (root === 'pm') {
    if (!can('pm')) {
      content = noAccessPage('Preventive Maintenance', 'Preventive Maintenance');
    } else if (!second) {
      content = renderPM(route);
    } else if (second === 'new' || third === 'edit') {
      if (!can('pm', 'write')) {
        content = noAccessPage('Preventive Maintenance', 'Preventive Maintenance');
      } else {
        // Desktop opens the PM form in the drawer (SPEC-v3.md section 4);
        // below 1024 px the full-page form stays.
        const pmDrawer = maybeOpenPMDrawer(route);
        if (pmDrawer) {
          content = renderPM({ segments: ['pm'], params: route.params });
        } else {
          content = renderPMTaskForm(route);
          if (second !== 'new') isDetail = true;
        }
      }
    } else {
      content = renderPMTaskDetail(route);
      isDetail = true;
    }
  } else if (root === 'coworkers') {
    // People pages (SPEC-v3.md section 5, permissions section 13).
    if (!can('coworkers')) {
      content = noAccessPage('Coworkers', 'Coworkers');
    } else if (!second) {
      content = renderCoworkers(route);
    } else if (second === 'new' || third === 'edit') {
      // Desktop opens the form in the drawer (SPEC-v3.md section 10);
      // phones and tablets keep the full-page form.
      const peopleDrawer = maybeOpenCoworkerDrawer(route);
      if (peopleDrawer) {
        content = renderCoworkers({ segments: ['coworkers'], params: route.params });
      } else {
        content = renderCoworkerForm(route);
        if (second !== 'new') isDetail = true;
      }
    } else {
      content = renderCoworkerDetail(route);
      isDetail = true;
      splitListRoot = 'coworkers';
    }
  } else if (root === 'contractors') {
    if (!can('contractors')) {
      content = noAccessPage('Outside Contractors', 'Outside Contractors');
    } else if (!second) {
      content = renderContractors(route);
    } else if (second === 'new' || third === 'edit') {
      const peopleDrawer = maybeOpenContractorDrawer(route);
      if (peopleDrawer) {
        content = renderContractors({ segments: ['contractors'], params: route.params });
      } else {
        content = renderContractorForm(route);
        if (second !== 'new') isDetail = true;
      }
    } else {
      content = renderContractorDetail(route);
      isDetail = true;
      splitListRoot = 'contractors';
    }
  } else if (root === 'statistics') {
    // Statistics tabs (SPEC-v3.md section 7); the area itself is gated by
    // the statistics permission (SPEC-v3.md 13.3).
    if (!can('statistics')) {
      setTitle('Statistics');
      content = noAccessPage('Statistics', 'Statistics');
    } else if (!second || second === 'monitor') {
      content = renderStatisticsMonitor();
    } else if (second === 'reports') {
      content = renderStatisticsReports();
    } else {
      setTitle('Not found');
      content = page(
        emptyState('Page not found', 'That link does not exist.', [
          h('a', { class: 'btn btn-primary', href: '#/statistics' }, 'Go to Statistics'),
        ]),
      );
    }
  } else if (root === 'admin') {
    // Admin dashboard (SPEC-v3.md 13.3): needs admin Write on this route.
    content = renderAdmin(route);
  } else if (root === 'help') {
    setTitle('Help');
    content = renderHelp(h, { isAdmin: canAdminUI() });
  } else if (root === 'settings') {
    content = renderSettings();
  } else {
    setTitle('Not found');
    content = page(
      emptyState('Page not found', 'That link does not exist.', [
        h('a', { class: 'btn btn-primary', href: '#/home' }, 'Go Home'),
      ]),
    );
  }

  /* Desktop split view (SPEC 13.1 item 3): list on the left, detail on the
     right. Below 1024px the detail stays a full page; the change listener
     below re-renders when the viewport crosses the breakpoint. */
  if (splitListRoot && desktopMedia.matches) {
    const detailTitle = pageTitle.textContent;
    const listRoute = { segments: [splitListRoot], params: new URLSearchParams() };
    const listPage =
      splitListRoot === 'jobs'
        ? renderJobs(listRoute)
        : splitListRoot === 'machines'
          ? renderMachines(listRoute)
          : splitListRoot === 'coworkers'
            ? renderCoworkers(listRoute)
            : splitListRoot === 'contractors'
              ? renderContractors(listRoute)
              : splitListRoot === 'requests'
                ? renderRequests(listRoute)
                : renderParts(listRoute);
    content = h(
      'div',
      { class: 'split', 'data-split-root': splitListRoot },
      h('section', { class: 'split-list' }, listPage),
      h(
        'section',
        { class: 'split-detail' },
        h(
          'div',
          { class: 'split-detail-bar' },
          h(
            'button',
            {
              class: 'btn split-close',
              type: 'button',
              title: 'Close (Esc)',
              'aria-label': 'Close the detail panel and go back to the list',
              onclick: () => navigate(`#/${splitListRoot}`),
            },
            h('span', { class: 'split-close-icon', 'aria-hidden': 'true' }, '<<'),
            'Close',
            h('span', { class: 'split-close-hint', 'aria-hidden': 'true' }, 'Esc'),
          ),
        ),
        content,
      ),
    );
    setTitle(detailTitle);
  }

  backButton.hidden = !isDetail;
  fab.hidden = !(can('serviceOrders', 'write') && (tab === 'home' || (tab === 'jobs' && !second)));
  appMain.replaceChildren(content);
}

backButton.addEventListener('click', () => {
  if (history.length > 1) history.back();
  else navigate('#/home');
});

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  render();
});

/* Esc retracts the desktop detail pane (machines, jobs, parts, people) back to
   the list. Drawers, dialogs and sheets own Esc while they are open, and Esc in
   a text field keeps its normal behaviour (clearing/undoing the insert). */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (drawerHandle) return;
  if (document.querySelector('.dialog, .dialog-backdrop, .sheet')) return;
  const split = document.querySelector('.split[data-split-root]');
  if (!split) return;
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
  navigate(`#/${split.dataset.splitRoot}`);
});

/* Re-render when the viewport crosses the 1024px desktop breakpoint so the
   split view appears or the full-page detail comes back; any open drawer
   closes so the machine form is not shown twice (drawer + full page). */
function handleDesktopChange() {
  if (drawerHandle) drawerHandle.close();
  render();
}

if (typeof desktopMedia.addEventListener === 'function') {
  desktopMedia.addEventListener('change', handleDesktopChange);
} else if (typeof desktopMedia.addListener === 'function') {
  desktopMedia.addListener(handleDesktopChange);
}

/* ==========================================================================
   V3-M2 shell (SPEC-v3.md sections 8 and 10): right drawer component,
   phone "More" sheet, global search, collapsible dark sidebar.
   ========================================================================== */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

/* Keep Tab inside a dialog/sheet/drawer root (focus trap). */
function trapTabKey(root, event) {
  if (event.defaultPrevented) return;
  const items = focusableElements(root);
  if (items.length === 0) {
    event.preventDefault();
    if (root.hasAttribute('tabindex')) root.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!root.contains(active) || active === root) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/* ----- Right slide-over drawer (SPEC-v3.md sections 3 and 10) -----
   openDrawer({title, content, onClose, isDirty}): 560 px panel over a
   backdrop, focus-trapped. Esc, backdrop and the ✕ button run the
   in-page discard check when isDirty() returns true; leaving the route
   (Save / Cancel links) closes without the check. One drawer at a time. */

let drawerHandle = null;

function openDrawer({ title = '', content = null, onClose = null, isDirty = null } = {}) {
  if (drawerHandle) drawerHandle.close();
  closeUserMenu();
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = `drawer-title-${++fieldCounter}`;
  const closeButton = h('button', { class: 'icon-button drawer-close', type: 'button', 'aria-label': 'Close' }, h('span', { 'aria-hidden': 'true' }, '✕'));
  const panel = h(
    'aside',
    {
      class: 'drawer',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabindex: '-1',
    },
    h('div', { class: 'drawer-head' }, h('h2', { id: titleId }, title), closeButton),
    h('div', { class: 'drawer-body' }, content),
  );
  const backdrop = h('div', { class: 'drawer-backdrop' });

  let closing = false;
  const finishClose = () => {
    document.removeEventListener('keydown', onKeyDown);
    backdrop.remove();
    panel.remove();
    document.body.classList.remove('drawer-open');
    drawerHandle = null;
    if (typeof onClose === 'function') onClose();
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
  };
  const close = () => {
    if (closing) return;
    closing = true;
    finishClose();
  };
  const maybeClose = async () => {
    if (closing) return;
    let dirty = false;
    if (typeof isDirty === 'function') {
      try {
        dirty = isDirty();
      } catch (error) {
        console.warn('Drawer dirty check failed:', error);
      }
    }
    if (dirty) {
      // In-page discard check; native confirm/toast are never used.
      const discard = await showConfirm({
        title: 'Discard changes?',
        message: 'This form has unsaved changes.',
        confirmText: 'Discard',
        cancelText: 'Keep editing',
        danger: true,
      });
      if (!discard) return;
    }
    close();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      // An open confirm dialog handles its own Escape (dialogRoot).
      if (dialogRoot.childElementCount > 0 || moreSheetOpen) return;
      event.preventDefault();
      maybeClose();
    } else if (event.key === 'Tab') {
      trapTabKey(panel, event);
    }
  };

  // Leaving the route closes the drawer: the user already chose where to
  // go (Save, Cancel, back). Listeners added during dispatch are not run
  // by the event that triggered them, so rendering a drawer route is safe.
  const onRouteChange = () => close();
  window.addEventListener('hashchange', onRouteChange, { once: true });

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) maybeClose();
  });
  closeButton.addEventListener('click', () => maybeClose());
  document.addEventListener('keydown', onKeyDown);

  document.body.append(backdrop, panel);
  document.body.classList.add('drawer-open');

  const handle = {
    close,
    onRouteCleanup: null,
  };
  handle.onRouteCleanup = () => {
    window.removeEventListener('hashchange', onRouteChange);
    close();
  };
  drawerHandle = handle;
  const focusables = focusableElements(panel);
  if (focusables.length > 0) focusables[0].focus();
  else panel.focus();
  return handle;
}

function closeDrawerForRouteChange() {
  if (drawerHandle) drawerHandle.onRouteCleanup();
}

/* The one M2 drawer usage: the machine form opens in the drawer on
   desktop (phone and tablet keep the full-page form). */
function maybeOpenMachineDrawer(route) {
  if (!desktopMedia.matches) return false;
  if (!can('machines', 'write')) return false;
  const id = route.segments[1];
  const editing = Boolean(id && id !== 'new');
  const existing = editing ? machineById(id) : null;
  if (editing && !existing) return false;
  const { node, isDirty } = machineFormBody(existing);
  openDrawer({ title: machineFormTitle(existing), content: node, isDirty });
  return true;
}

/* The M3 drawer usage: the service order form opens in the drawer on
   desktop; phones and tablets keep the full-page form (SPEC-v3.md 3.6). */
function maybeOpenJobDrawer(route) {
  if (!desktopMedia.matches) return false;
  const second = route.segments[1];
  if (second !== 'new') return false;
  if (state.machines.length === 0) {
    // Keep the full-page "add a machine first" empty state.
    return false;
  }
  const presetId = route.params.get('machine');
  const presetMachineId = presetId && machineById(presetId) ? presetId : null;
  // An AI draft waiting in this tab opens pre-filled (V3-M8, SPEC-v3 9).
  const prefill = prefillFromAiDraft(consumeAiDraft() || {});
  const { node, isDirty } = workOrderFormBody({
    existing: null,
    presetMachineId,
    prefill: prefill || null,
    cancelTo: null,
  });
  openDrawer({ title: 'New service order', content: node, isDirty });
  return true;
}

/* The M4 drawer usage: the PM task form opens in the drawer on desktop
   (SPEC-v3.md section 4); phones and tablets keep the full-page form. */
function maybeOpenPMDrawer(route) {
  if (!desktopMedia.matches) return false;
  const second = route.segments[1];
  const editing = Boolean(second && second !== 'new');
  const existing = editing ? pmTaskById(second) : null;
  if (editing && !existing) return false;
  if (state.machines.length === 0) {
    // Keep the full-page "add a machine first" empty state.
    return false;
  }
  if (!can('pm', 'write')) {
    // Read-only roles see the full-page "View only" state instead.
    return false;
  }
  const { node, isDirty } = pmTaskFormBody({ existing, cancelTo: null });
  openDrawer({ title: existing ? 'Edit PM task' : 'New PM task', content: node, isDirty });
  return true;
}

/* ----- Phone bottom-bar "More" sheet (SPEC-v3.md section 10) ----- */

const NAV_ICONS = {
  parts: [
    'M12 2.5 20.75 7v10L12 21.5 3.25 17V7L12 2.5Z',
    'M3.25 7 12 11.75 20.75 7',
    'M12 11.75v9.75',
  ],
  // v4 (SPEC-v4.md section 1): the Parts requests entry of the More sheet.
  requests: [
    'M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5Z',
    'M9 2.25h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z',
    'M9 11.5h6',
    'M9 15.5h4',
  ],
  stats: ['M4 20.5h16', 'M7 20.5v-6', 'M12 20.5V5', 'M17 20.5v-10'],
  coworkers: [
    'M5.5 8a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0',
    'M3 20c.6-3.4 3-5.2 6-5.2s5.4 1.8 6 5.2',
    'M16 4.8a3.5 3.5 0 0 1 0 6.4',
    'M17.5 14.9c2.3.7 3.9 2.6 4.3 5',
  ],
  contractors: [
    'M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5',
    'M3 12.75h18',
    'M5 7.5h14A2 2 0 0 1 21 9.5v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z',
  ],
  help: [
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
    'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.2-3 4',
    'M12 17.3h.01',
  ],
  settings: [
    'M4 21v-7',
    'M4 10V3',
    'M12 21v-9',
    'M12 8V3',
    'M20 21v-5',
    'M20 12V3',
    'M1 14h6',
    'M9 8h6',
    'M17 16h6',
  ],
  admin: ['M12 2.5 4 5.5v5c0 5 3.4 8.4 8 10.5 4.6-2.1 8-5.5 8-10.5v-5l-8-3Z'],
};

let moreSheetOpen = false;
let moreSheetRoot = null;
let moreSheetBackdrop = null;

function closeMoreSheet({ refocus = false } = {}) {
  if (!moreSheetRoot) return;
  const previousFocus =
    moreSheetRoot._morePreviousFocus instanceof HTMLElement ? moreSheetRoot._morePreviousFocus : null;
  moreSheetRoot.remove();
  // The backdrop is a separate node; left behind it blocks every tap until reload.
  if (moreSheetBackdrop) moreSheetBackdrop.remove();
  moreSheetBackdrop = null;
  moreSheetRoot = null;
  moreSheetOpen = false;
  document.removeEventListener('keydown', onMoreSheetKey);
  if (moreButton) {
    moreButton.setAttribute('aria-expanded', 'false');
    if (refocus || previousFocus === moreButton) moreButton.focus();
  }
}

function onMoreSheetKey(event) {
  if (!moreSheetRoot) return;
  if (event.key === 'Escape') {
    if (dialogRoot.childElementCount > 0) return;
    event.preventDefault();
    closeMoreSheet({ refocus: true });
  } else if (event.key === 'Tab') {
    trapTabKey(moreSheetRoot, event);
  }
}

function openMoreSheet() {
  if (moreSheetOpen || !moreButton) return;
  closeUserMenu();
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const items = [
    can('parts') && { label: 'Parts', icon: NAV_ICONS.parts, href: '#/parts' },
    // v4 (SPEC-v4.md section 1): Parts requests after Parts, only with the
    // purchasing permission (read or more).
    can('purchasing') && { label: 'Parts requests', icon: NAV_ICONS.requests, href: '#/requests' },
    // Statistics follows its own permission (SPEC-v3.md 13.3).
    can('statistics') && { label: 'Statistics', icon: NAV_ICONS.stats, href: '#/statistics' },
    // People follow the coworkers/contractors permissions (SPEC-v3.md 13.3).
    can('coworkers') && { label: 'Coworkers', icon: NAV_ICONS.coworkers, href: '#/coworkers' },
    can('contractors') && {
      label: 'Outside Contractors',
      icon: NAV_ICONS.contractors,
      href: '#/contractors',
    },
    // The Admin dashboard needs admin Write (SPEC-v3.md 13.3).
    canAdminUI() && { label: 'Admin', icon: NAV_ICONS.admin, href: '#/admin' },
    { label: 'Help', icon: NAV_ICONS.help, href: '#/help' },
    { label: 'Settings', icon: NAV_ICONS.settings, href: '#/settings' },
  ].filter(Boolean);
  const backdrop = h('div', { class: 'sheet-backdrop' });
  moreSheetBackdrop = backdrop;
  moreSheetRoot = h(
    'section',
    { class: 'sheet', id: 'more-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'More pages' },
    h('h2', { class: 'sheet-title' }, 'More'),
    ...items.map((item) =>
      h(
        'a',
        { class: 'sheet-item', href: item.href, onclick: () => closeMoreSheet() },
        menuIcon(item.icon),
        h('span', {}, item.label),
      ),
    ),
  );
  moreSheetRoot._morePreviousFocus = previousFocus;
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeMoreSheet({ refocus: true });
  });
  document.addEventListener('keydown', onMoreSheetKey);
  document.body.append(backdrop, moreSheetRoot);
  moreSheetOpen = true;
  if (moreButton) moreButton.setAttribute('aria-expanded', 'true');
  const firstItem = moreSheetRoot.querySelector('.sheet-item');
  if (firstItem) firstItem.focus();
  else moreSheetRoot.focus();
}

/* ----- Top-bar global search (SPEC-v3.md section 10) -----
   Searches service orders (by number and title), machines and parts;
   results show in a dropdown, Enter opens the first/active item and
   ArrowUp/Down move through it. Desktop only (CSS hides the box). */

function serviceOrderLabel(order) {
  const number = order && order.number;
  if (number === null || number === undefined || number === '') return null;
  return formatOrderNumber(number);
}

function globalSearchMatches(query) {
  const needle = String(query).trim().toLowerCase();
  if (!needle) return [];
  const digits = /^\d+$/.test(needle) ? Number(needle) : null;
  const results = [];

  let matched = 0;
  // Only readable areas are searched (SPEC-v3.md 13.3).
  for (const order of can('serviceOrders') ? sortWorkOrdersNewest(state.workOrders) : []) {
    if (matched >= 4) break;
    const label = serviceOrderLabel(order);
    const title = String(order.title || '');
    const labelText = label ? label.toLowerCase() : '';
    const numberMatches =
      (labelText && (labelText.includes(needle) || (digits !== null && Number(order.number) === digits))) || false;
    if (title.toLowerCase().includes(needle) || numberMatches) {
      matched += 1;
      results.push({
        kind: 'Service order',
        title: title || labelText || 'Untitled',
        sub: labelText,
        href: `#/jobs/${encodeURIComponent(order.id)}`,
      });
    }
  }

  let machineMatches = 0;
  for (const machine of can('machines') ? state.machines : []) {
    if (machineMatches >= 3) break;
    const fits = [machine.name, machine.model, machine.serial, machine.location]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
    if (fits) {
      machineMatches += 1;
      results.push({
        kind: 'Machine',
        title: machine.name,
        sub: machineTypeLabel(machine),
        href: `#/machines/${encodeURIComponent(machine.id)}`,
      });
    }
  }

  let partMatches = 0;
  for (const part of can('parts') ? state.parts : []) {
    if (partMatches >= 3) break;
    const fits = [part.name, part.partNumber, part.supplier]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
    if (fits) {
      partMatches += 1;
      results.push({
        kind: 'Part',
        title: part.name,
        sub: part.partNumber || '',
        href: `#/parts/${encodeURIComponent(part.id)}`,
      });
    }
  }

  // People (SPEC-v3.md section 10): coworkers by name, contractors by company
  // and trade — only the areas this user may see (13.3).
  if (can('coworkers')) {
    let coworkerMatches = 0;
    for (const coworker of contactSearch(state.coworkers, needle, [
      'name',
      'role',
      'phone',
      'email',
      'skills',
    ])) {
      if (coworkerMatches >= 2) break;
      coworkerMatches += 1;
      results.push({
        kind: 'Coworker',
        title: coworker.name,
        sub: coworker.role || '',
        href: `#/coworkers/${encodeURIComponent(coworker.id)}`,
      });
    }
  }
  if (can('contractors')) {
    let contractorMatches = 0;
    for (const contractor of contactSearch(state.contractors, needle, [
      'company',
      'trade',
      'contactName',
      'phone',
      'email',
    ])) {
      if (contractorMatches >= 2) break;
      contractorMatches += 1;
      results.push({
        kind: 'Contractor',
        title: contractor.company,
        sub: contractor.trade || '',
        href: `#/contractors/${encodeURIComponent(contractor.id)}`,
      });
    }
  }

  return results.slice(0, 9);
}

function setUpGlobalSearch() {
  if (!globalSearchInput || !globalSearchResults || !globalSearchBox) return;
  let results = [];
  let activeIndex = -1;

  const closeResults = () => {
    results = [];
    activeIndex = -1;
    globalSearchResults.replaceChildren();
    globalSearchResults.hidden = true;
    globalSearchInput.setAttribute('aria-expanded', 'false');
    globalSearchInput.removeAttribute('aria-activedescendant');
  };

  const setActive = (index) => {
    activeIndex = index;
    const nodes = Array.from(globalSearchResults.querySelectorAll('.gs-result'));
    nodes.forEach((node, i) => node.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false'));
    const active = nodes[activeIndex];
    if (active) globalSearchInput.setAttribute('aria-activedescendant', active.id);
    else globalSearchInput.removeAttribute('aria-activedescendant');
  };

  const openResults = (list) => {
    results = list;
    if (results.length === 0) {
      globalSearchResults.replaceChildren(h('div', { class: 'gs-empty' }, 'No matches.'));
      globalSearchResults.hidden = false;
      globalSearchInput.setAttribute('aria-expanded', 'true');
      setActive(-1);
      return;
    }
    globalSearchResults.replaceChildren(
      ...results.map((item, index) =>
        h(
          'a',
          {
            class: 'gs-result',
            id: `gs-option-${index}`,
            role: 'option',
            href: item.href,
            'aria-selected': 'false',
            onclick: (event) => {
              event.preventDefault();
              const href = (results[index] || results[0] || {}).href;
              globalSearchInput.value = '';
              closeResults();
              if (href) navigate(href);
            },
          },
          h('span', { class: 'gs-kind' }, item.kind),
          h('span', { class: 'gs-title' }, item.title),
          item.sub ? h('span', { class: 'gs-sub' }, item.sub) : null,
        ),
      ),
    );
    globalSearchResults.hidden = false;
    globalSearchInput.setAttribute('aria-expanded', 'true');
    setActive(0);
  };

  globalSearchInput.addEventListener('input', () => {
    const query = globalSearchInput.value;
    if (!query.trim()) {
      closeResults();
      return;
    }
    openResults(globalSearchMatches(query));
  });

  globalSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (globalSearchResults.hidden) return;
      event.preventDefault();
      closeResults();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (globalSearchResults.hidden || results.length === 0) return;
      event.preventDefault();
      const next =
        event.key === 'ArrowDown'
          ? Math.min(activeIndex + 1, results.length - 1)
          : Math.max(activeIndex - 1, 0);
      setActive(next);
      return;
    }
    if (event.key === 'Enter') {
      if (globalSearchResults.hidden || results.length === 0) return;
      event.preventDefault();
      const href = (results[activeIndex] || results[0] || {}).href;
      globalSearchInput.value = '';
      closeResults();
      if (href) navigate(href);
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (globalSearchResults.hidden) return;
    if (globalSearchBox.contains(event.target)) return;
    closeResults();
  });
}

/* ----- Collapsible dark sidebar: 64 px icon rail remembered per device ----- */

function setUpSidebarRail() {
  if (!sidebarToggle) return;
  const apply = (collapsed) => {
    document.body.classList.toggle('sidebar-rail', collapsed);
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Expand navigation' : 'Collapse navigation';
    sidebarToggle.setAttribute('aria-label', label);
    sidebarToggle.title = label;
  };
  apply(storageGet(SIDEBAR_RAIL_KEY) === '1');
  sidebarToggle.addEventListener('click', () => {
    const collapsed = !document.body.classList.contains('sidebar-rail');
    apply(collapsed);
    storageSet(SIDEBAR_RAIL_KEY, collapsed ? '1' : '0');
  });
}

/* People areas with permission None leave the sidebar and the phone More
   sheet (SPEC-v3.md 13.3); the routes themselves answer "You do not have
   access". Local mode (no team user) sees everything. */
/* Navigation follows the role permissions (SPEC-v3.md 13.3): every area with
   None hides its sidebar link, phone tab and More sheet entry. Settings and
   Help always stay visible; the "+ Service order" button needs Write. */
const NAV_TAB_AREAS = {
  jobs: 'serviceOrders',
  pm: 'pm',
  machines: 'machines',
  parts: 'parts',
  // v4 (SPEC-v4.md section 1): Parts requests follows Parts in the sidebar
  // and the More sheet, hidden without the purchasing permission.
  requests: 'purchasing',
  coworkers: 'coworkers',
  contractors: 'contractors',
  statistics: 'statistics',
  admin: 'admin',
};

function applyNavPermissions() {
  const sidebarNew = document.querySelector('.sidebar-new');
  if (sidebarNew) sidebarNew.hidden = !can('serviceOrders', 'write');
  for (const link of document.querySelectorAll('.tab, .sidebar a[data-tab]')) {
    const area = NAV_TAB_AREAS[link.dataset.tab];
    if (area) link.hidden = area === 'admin' ? !canAdminUI() : !can(area);
  }
  const showCoworkers = can('coworkers');
  const showContractors = can('contractors');
  const peopleGroup = document.querySelector('.sidebar-group');
  if (peopleGroup) peopleGroup.hidden = !(showCoworkers || showContractors);
}

setUpSidebarRail();
setUpGlobalSearch();
if (moreButton) moreButton.addEventListener('click', openMoreSheet);

/* ---------- Desktop keyboard shortcuts (SPEC 13.1 item 5) ---------- */

const GO_SEQUENCE_MS = 1500;
let goSequenceUntil = 0;

function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function focusPageSearch() {
  const input = appMain.querySelector('input[type="search"]');
  if (!input) return;
  input.focus();
  if (typeof input.select === 'function') input.select();
}

window.addEventListener('keydown', (event) => {
  if (!desktopMedia.matches) return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
    goSequenceUntil = 0;
    return;
  }
  if (isTypingTarget(event.target)) return;
  if (dialogRoot.childElementCount > 0) {
    goSequenceUntil = 0;
    return;
  }
  const key = event.key;
  const now = Date.now();
  const inGoSequence = goSequenceUntil > now;
  goSequenceUntil = 0;
  if (inGoSequence) {
    if (key === 'h') {
      event.preventDefault();
      navigate('#/home');
      return;
    }
    if (key === 'j') {
      event.preventDefault();
      navigate('#/jobs');
      return;
    }
    if (key === 'm') {
      event.preventDefault();
      navigate('#/machines');
      return;
    }
    if (key === 'p') {
      event.preventDefault();
      navigate('#/parts');
      return;
    }
    if (key === 'k') {
      event.preventDefault();
      navigate('#/pm');
      return;
    }
    // Any other key ends the "g" sequence and falls through below.
  }
  if (key === 'g') {
    goSequenceUntil = now + GO_SEQUENCE_MS;
    return;
  }
  if (key === 'n') {
    event.preventDefault();
    navigate('#/jobs/new');
    return;
  }
  if (key === '/') {
    event.preventDefault();
    focusPageSearch();
  }
});

/* ---------- Team sync wiring (SPEC-v2.md sections 8 and 9.1, 9.4) ---------- */

function formatSyncTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/* ---------- History and conflict notices (SPEC-v2.md 9.3) ---------- */

// Last conflict per record kept in memory from 'sync-conflict'; recent
// entries show a banner on the record's detail view.
const CONFLICT_BANNER_MS = 60 * 60 * 1000;
const recentConflicts = new Map();

function rememberConflict(store, id, conflict) {
  if (!store || !id || !conflict) return;
  recentConflicts.set(`${store}/${id}`, { conflict, at: nowISO() });
}

function conflictBanner(store, id) {
  if (!teamUser) return null;
  const key = `${store}/${id}`;
  const entry = recentConflicts.get(key);
  if (!entry) return null;
  const elapsed = Date.now() - new Date(entry.at).getTime();
  if (Number.isFinite(elapsed) && elapsed > CONFLICT_BANNER_MS) {
    recentConflicts.delete(key);
    return null;
  }
  const who = entry.conflict.overwrittenBy || 'another user';
  const when = formatSyncTime(entry.conflict.overwrittenAt);
  return h(
    'div',
    { class: 'card conflict-banner', role: 'status' },
    `You saved over changes by ${who}${when ? ` from ${when}` : ''}. Nothing was lost — the overwritten version is in History.`,
  );
}

const HISTORY_VERB = {
  create: 'Created',
  update: 'Edited',
  delete: 'Deleted',
  restore: 'Restored',
  stock: 'Stock',
};

/** "Oct 20, 14:03" local time for history lines (SPEC-v2.md 9.3). */
function formatHistoryTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Field names whose values differ between the before and after payloads. */
function changedKeys(before, after) {
  const left = before && typeof before === 'object' ? before : {};
  const right = after && typeof after === 'object' ? after : {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changed = [];
  for (const key of keys) {
    const inLeft = Object.prototype.hasOwnProperty.call(left, key);
    const inRight = Object.prototype.hasOwnProperty.call(right, key);
    if (inLeft !== inRight || JSON.stringify(left[key]) !== JSON.stringify(right[key])) changed.push(key);
  }
  return changed;
}

/** "Overwrote v6 by Ben" from the server's conflict note ("overwrote v6 by Ben at …"). */
function conflictLine(entry) {
  if (!entry || !entry.conflict || !entry.note) return '';
  const match = /^overwrote v(\d+) by (.+?) at /.exec(String(entry.note));
  if (match) return `Overwrote v${match[1]} by ${match[2]}`;
  return String(entry.note);
}

/** "… · +2 (job-done)" for stock entries, from the server note. */
function stockLine(entry) {
  const note = String(entry && entry.note ? entry.note : '');
  const match = /^stock ([+-]\d+) \(([^)]+)\)(.*)$/.exec(note);
  if (!match) return note;
  return `${match[1]} (${match[2]})${match[3] || ''}`;
}

function historyEntryNode(entry) {
  const who = entry.displayName || 'a teammate';
  const when = formatHistoryTime(entry.at);
  const verb = HISTORY_VERB[entry.action] || entry.action || 'Changed';
  const line = [`v${entry.version === null || entry.version === undefined ? '?' : entry.version}`, `${verb} by ${who}`];
  if (when) line.push(when);
  if (entry.action === 'stock') {
    const stock = stockLine(entry);
    if (stock) line.push(stock);
  } else if (entry.action === 'update') {
    const keys = changedKeys(entry.before, entry.after);
    if (keys.length > 0) line.push(`changed: ${keys.join(', ')}`);
  } else if (entry.action === 'restore') {
    const keys = changedKeys(entry.before, entry.after);
    if (keys.length > 0) line.push(`changed: ${keys.join(', ')}`);
  }
  const conflict = entry.action !== 'stock' && conflictLine(entry);
  return h(
    'div',
    { class: `history-entry${conflict ? ' is-conflict' : ''}` },
    h('div', { class: 'history-line' }, line.join(' · ')),
    conflict ? h('div', { class: 'history-note' }, conflict) : null,
    entry.action === 'stock' && !stockLine(entry) && entry.note
      ? h('div', { class: 'history-note' }, String(entry.note))
      : null,
  );
}

function historySection(store, id) {
  if (!teamUser) return null;
  const body = h('div', { class: 'history-body' }, h('p', { class: 'muted' }, 'Loading history…'));
  const section = h(
    'details',
    { class: 'more history-section' },
    h('summary', {}, 'History'),
    body,
  );
  let loaded = false;
  section.addEventListener('toggle', () => {
    if (!section.open || loaded) return;
    loaded = true;
    loadHistory();
  });

  async function loadHistory() {
    let response;
    try {
      response = await sync.api('GET', `/api/history/${encodeURIComponent(store)}/${encodeURIComponent(id)}`);
    } catch (error) {
      // Offline or the server is down (SPEC-v2.md 9.3).
      console.warn('Could not load history:', error);
      body.replaceChildren(h('p', { class: 'muted' }, 'History needs a connection to the server.'));
      return;
    }
    if (response.status === 404) {
      body.replaceChildren(h('p', { class: 'muted' }, 'No history yet.'));
      return;
    }
    if (!response.ok) {
      body.replaceChildren(h('p', { class: 'muted' }, 'Could not load history. Try again in a moment.'));
      return;
    }
    const entries = Array.isArray(response.data) ? response.data : [];
    if (entries.length === 0) {
      body.replaceChildren(h('p', { class: 'muted' }, 'No history yet.'));
      return;
    }
    body.replaceChildren(...entries.map((entry) => historyEntryNode(entry)));
  }

  return section;
}

function handleSyncStatus(event) {
  if (!syncPill) return;
  syncPill.hidden = !teamUser;
  const detail = event.detail || {};
  // Full label for wide screens and screen readers; the compact label is the
  // phone strip (SPEC-v2.md 15.4 item 2) and never announced twice.
  syncPill.replaceChildren(
    h('span', { class: 'sync-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'sync-pill-full' }, detail.text || ''),
    h('span', { class: 'sync-pill-compact', 'aria-hidden': 'true' }, compactSyncLabel(detail)),
  );
  syncPill.className = `sync-pill${
    detail.needsLogin
      ? ' is-login'
      : detail.failed > 0
        ? ' is-failed'
        : detail.pending > 0
          ? ' is-saving'
          : detail.online === false
            ? ' is-offline'
            : ' is-ok'
  }`;
}

function handleSyncConflict(event) {
  const detail = event.detail || {};
  const conflict = detail.conflict || {};
  rememberConflict(detail.store, detail.id, conflict);
  const who = conflict.overwrittenBy || 'another user';
  const when = formatSyncTime(conflict.overwrittenAt);
  const title = detail.title ? `"${detail.title}" ` : '';
  toast(`${title}You saved over changes by ${who}${when ? ` from ${when}` : ''}. See History.`, 'warn');
}

function handleSyncSessionExpired() {
  if (!teamUser || loginActive) return;
  showLoginScreen();
}

async function handleSyncApplied(event) {
  if (!teamUser || loginActive) return;
  const detail = event.detail || {};
  // Roles can change without any record changing for this device, so the
  // permissions are refreshed on every sync round (SPEC-v3.md 13.3).
  await refreshMyPermissions({ forceRender: false });
  if (!(detail.applied > 0)) return;
  await refreshState();
  // Keep any form the user is filling in; closed <details> forms (phone
  // edit sections) have no client rects, so the page may still refresh.
  const form = appMain.querySelector('form');
  if (form && form.getClientRects().length > 0) return;
  render();
}

/* Permission changes follow the user around (SPEC-v3.md 13.3): GET /api/me
   is refreshed after every sync round and on a 30 s timer. When an area
   became None its local store is cleared from IndexedDB and the page is
   left when it is now hidden. */
const AREA_STORES = {
  serviceOrders: 'workOrders',
  pm: 'pmTasks',
  machines: 'machines',
  parts: 'parts',
  purchasing: 'purchaseRequests',
  coworkers: 'coworkers',
  contractors: 'contractors',
};

const PERMISSION_REFRESH_MS = 30000;
let permissionTimer = null;

async function refreshMyPermissions({ forceRender = true } = {}) {
  if (!teamUser || loginActive) return;
  let response;
  try {
    response = await sync.api('GET', '/api/me');
  } catch (error) {
    return;
  }
  if (!response.ok || !response.data || !response.data.id) return;
  const next = response.data;
  const previous = teamUser.permissions || {};
  const nextPermissions = next.permissions || {};
  const changed = [];
  for (const key of AREA_KEYS) {
    const before = previous[key] === 'write' || previous[key] === 'read' ? previous[key] : 'none';
    const after = nextPermissions[key] === 'write' || nextPermissions[key] === 'read' ? nextPermissions[key] : 'none';
    if (before !== after) changed.push(key);
  }
  teamUser = { ...teamUser, ...next };
  try {
    await db.setMeta('me', teamUser);
  } catch (error) {
    console.warn('Could not cache the signed-in user:', error);
  }
  applyNavPermissions();
  if (changed.length === 0 && forceRender) {
    render();
    return;
  }
  if (changed.length === 0) return;
  const hiddenNow = [];
  for (const area of changed) {
    if (!can(area) && AREA_STORES[area]) {
      await db.clear(AREA_STORES[area]);
      hiddenNow.push(area);
    }
  }
  if (hiddenNow.length > 0) {
    await refreshState();
    toast('Your permissions changed. Pages you can no longer see were closed.', 'warn');
  }
  const route = routeInfo();
  const root = route.segments[0] || 'home';
  const tabArea = NAV_TAB_AREAS[root];
  if (tabArea && !can(tabArea)) {
    navigate('#/home');
    return;
  }
  if (forceRender || hiddenNow.length > 0) render();
}

function startPermissionRefresh() {
  if (permissionTimer || !teamUser) return;
  permissionTimer = setInterval(() => {
    if (!teamUser || loginActive) return;
    if (document.visibilityState === 'hidden') return;
    refreshMyPermissions({ forceRender: false });
  }, PERMISSION_REFRESH_MS);
}

function stopPermissionRefresh() {
  if (permissionTimer) {
    clearInterval(permissionTimer);
    permissionTimer = null;
  }
}

function bindSyncEvents() {
  if (syncEventsBound) return;
  syncEventsBound = true;
  window.addEventListener('sync-status', handleSyncStatus);
  window.addEventListener('sync-conflict', handleSyncConflict);
  window.addEventListener('sync-session', handleSyncSessionExpired);
  window.addEventListener('sync-applied', handleSyncApplied);
  startPermissionRefresh();
}

async function loadTeamUsers() {
  try {
    const response = await sync.api('GET', '/api/users');
    if (response.ok && Array.isArray(response.data)) {
      teamUsers = response.data;
      await db.setMeta('users', teamUsers);
      return;
    }
    if (response.status === 401) return;
  } catch (error) {
    // Offline or the server is down: the cached list still gives names.
    console.warn('Could not load the user list:', error);
  }
  try {
    const cached = await db.getMeta('users');
    if (Array.isArray(cached)) teamUsers = cached;
  } catch (error) {
    console.warn('Could not read the cached user list:', error);
  }
}

function closeUserMenu({ refocus = false } = {}) {
  if (!userMenuElement) return;
  const hadFocus = userMenuElement.contains(document.activeElement);
  userMenuElement.remove();
  userMenuElement = null;
  if ((refocus || hadFocus) && userMenuButton && !userMenuButton.hidden) {
    userMenuButton.focus();
  }
  if (userMenuButton) userMenuButton.setAttribute('aria-expanded', 'false');
}

function positionUserMenu() {
  if (!userMenuElement || !userMenuButton) return;
  const rect = userMenuButton.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  userMenuElement.style.top = `${Math.round(rect.bottom + 8)}px`;
  userMenuElement.style.right = `${Math.max(8, Math.round(viewportWidth - rect.right))}px`;
}

function menuIcon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'user-menu-item-icon');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const USER_MENU_ICONS = {
  help: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.2-3 4', 'M12 17.3h.01'],
  settings: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  signout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
};

function toggleUserMenu() {
  if (userMenuElement) {
    closeUserMenu();
    return;
  }
  const displayName = teamUser && teamUser.displayName ? teamUser.displayName : '';
  const username = teamUser && teamUser.username ? teamUser.username : '';
  const role = roleLabel(teamUser);
  const accountLine = username ? `@${username} · ${role}` : role;
  userMenuElement = h(
    'div',
    { class: 'user-menu', role: 'menu', 'aria-label': 'Account menu' },
    h('div', { class: 'user-menu-name' }, displayName || 'Account'),
    h('div', { class: 'user-menu-role' }, accountLine),
    h('div', { class: 'user-menu-divider', role: 'separator' }),
    h(
      'a',
      {
        class: 'user-menu-item',
        href: '#/help',
        role: 'menuitem',
        onclick: () => closeUserMenu({ refocus: true }),
      },
      menuIcon(USER_MENU_ICONS.help),
      h('span', {}, 'Help'),
    ),
    h(
      'a',
      {
        class: 'user-menu-item',
        href: '#/settings',
        role: 'menuitem',
        onclick: () => closeUserMenu({ refocus: true }),
      },
      menuIcon(USER_MENU_ICONS.settings),
      h('span', {}, 'Settings'),
    ),
    h('div', { class: 'user-menu-divider', role: 'separator' }),
    h(
      'button',
      {
        class: 'user-menu-item is-danger',
        type: 'button',
        role: 'menuitem',
        onclick: () => {
          closeUserMenu();
          signOut();
        },
      },
      menuIcon(USER_MENU_ICONS.signout),
      h('span', {}, 'Sign out'),
    ),
  );
  document.body.append(userMenuElement);
  positionUserMenu();
  userMenuButton.setAttribute('aria-expanded', 'true');
  const firstItem = userMenuElement.querySelector('[role="menuitem"]');
  if (firstItem) firstItem.focus();
}

document.addEventListener('click', (event) => {
  if (!userMenuElement) return;
  if (userMenuElement.contains(event.target)) return;
  if (userMenuButton && userMenuButton.contains(event.target)) return;
  closeUserMenu();
});

document.addEventListener('keydown', (event) => {
  if (!userMenuElement) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeUserMenu({ refocus: true });
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  if (!userMenuElement.contains(document.activeElement)) return;
  event.preventDefault();
  const items = Array.from(userMenuElement.querySelectorAll('[role="menuitem"]'));
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement);
  const next =
    current === -1
      ? event.key === 'ArrowDown'
        ? 0
        : items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next].focus();
});

window.addEventListener('resize', () => {
  positionUserMenu();
});

window.addEventListener(
  'scroll',
  () => {
    closeUserMenu();
  },
  true,
);

function userButtonName() {
  return teamUser && teamUser.displayName ? teamUser.displayName : 'Account';
}

function syncUserButtonLabel() {
  if (!userMenuButton) return;
  const name = userButtonName();
  // Phone shows only the initials avatar (SPEC-v2.md 15.4 item 2), so the
  // button needs an explicit label there; wider screens read the visible name.
  if (phoneMedia.matches) userMenuButton.setAttribute('aria-label', `Account: ${name}`);
  else userMenuButton.removeAttribute('aria-label');
}

function renderUserButton() {
  if (!userMenuButton) return;
  const name = userButtonName();
  userMenuButton.replaceChildren(
    h('span', { class: 'user-button-name' }, name),
    h('span', { class: 'user-button-avatar', 'aria-hidden': 'true' }, initialsOf(name) || '··'),
  );
  syncUserButtonLabel();
  userMenuButton.setAttribute('aria-expanded', 'false');
}

function setupTeamHeader() {
  if (syncPill) syncPill.hidden = false;
  if (!userMenuButton) return;
  userMenuButton.hidden = false;
  renderUserButton();
  if (!userMenuButton.dataset.bound) {
    userMenuButton.dataset.bound = 'true';
    userMenuButton.addEventListener('click', () => toggleUserMenu());
    phoneMedia.addEventListener('change', () => {
      syncUserButtonLabel();
      positionUserMenu();
    });
  }
}

function teardownTeamHeader() {
  stopPermissionRefresh();
  if (syncPill) {
    syncPill.hidden = true;
    syncPill.replaceChildren();
  }
  if (userMenuButton) {
    userMenuButton.hidden = true;
    userMenuButton.replaceChildren();
  }
  closeUserMenu();
}

async function signOut() {
  sync.stop();
  const done = await logout({ confirmDialog: showConfirm });
  if (!done) {
    // The server session may already be gone; resume timers so the next
    // 401 shows the login screen.
    await sync.start(teamUser);
    return;
  }
  teamUser = null;
  await refreshState();
  showLoginScreen();
}

function showLoginScreen() {
  loginActive = true;
  teamUser = null;
  teardownTeamHeader();
  resetAiChat();
  document.body.classList.add('logged-out');
  setTitle('Sign in');
  appMain.replaceChildren();
  registerServiceWorker();
  renderLogin(appMain, async (user) => {
    loginActive = false;
    document.body.classList.remove('logged-out');
    await enterTeamMode(user);
  });
  decorateLoginCard();
  // GET /api/branding is public: keep the login card fresh offline cache too.
  refreshBranding();
  window.__maintLogReady = true;
}

const LAST_TAB_AREAS = {
  jobs: 'serviceOrders',
  machines: 'machines',
  parts: 'parts',
  requests: 'purchasing',
  pm: 'pm',
  coworkers: 'coworkers',
  contractors: 'contractors',
  statistics: 'statistics',
};

function restoreLastTab() {
  if (location.hash) return;
  const last = storageGet(LAST_TAB_KEY);
  const allowed = ['home', 'jobs', 'machines', 'parts', 'requests', 'pm', 'coworkers', 'contractors', 'statistics'];
  if (last && allowed.includes(last)) {
    const area = LAST_TAB_AREAS[last];
    if (area && !can(area)) return;
    history.replaceState(null, '', `#/${last}`);
  }
}

async function enterTeamMode(user) {
  teamUser = user;
  document.body.classList.remove('logged-out');
  bindSyncEvents();
  setupTeamHeader();
  await loadTeamUsers();
  // AI chat (V3-M8): ask the server whether a provider is configured, then
  // the button follows the aiAssistant permission on every render.
  await refreshAiStatus();
  updateAiChatButton();
  refreshBranding();
  await sync.start(user);
  await sync.pull();
  restoreLastTab();
  await refreshState();
  await render();
  registerServiceWorker();
  window.__maintLogReady = true;
}

async function startLocalMode() {
  await refreshState();
  restoreLastTab();
  await render();
  registerServiceWorker();
  window.__maintLogReady = true;
}

async function start() {
  try {
    await db.open();
    // Branding (SPEC-v3.md section 8): cached value first, then a fresh
    // public GET so the login card and shell match the server.
    await loadCachedBranding();
    refreshBranding();
    const session = await checkSession();
    if (session.status === 'ok' && session.user) {
      await enterTeamMode(session.user);
      return;
    }
    if (session.status === 'login') {
      showLoginScreen();
      return;
    }
    if (session.status === 'offline') {
      const saved = await db.getMeta('me');
      if (saved && saved.id) {
        await enterTeamMode(saved);
        return;
      }
    }
    await startLocalMode();
  } catch (error) {
    appMain.replaceChildren(
      page(
        emptyState(
          'Could not open the database',
          String(error && error.message ? error.message : error),
        ),
      ),
    );
    console.error(error);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const secure =
    location.protocol === 'https:' ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';
  if (!secure) return;
  navigator.serviceWorker.register('./sw.js').catch((error) => {
    console.error('Service worker registration failed:', error);
  });
}

/* V3-M8 AI chat (SPEC-v3.md section 9, permissions section 13): the fixed
   chat button, its panel and the Settings card live in chat.js; wire them to
   this app's api, permission helpers and records. */
initAiChat({
  api: sync.api,
  can,
  machines: () => state.machines,
  records: (storeName) => (Array.isArray(state[storeName]) ? state[storeName] : []),
  isSignedIn: () => Boolean(teamUser),
  navigate,
  showConfirm,
  refresh: async () => {
    if (teamUser) await sync.pull();
    await refreshState();
    await render();
  },
});

start();
