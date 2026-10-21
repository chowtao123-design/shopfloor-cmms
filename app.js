import * as db from './db.js';
import {
  BACKUP_STORES,
  LABELS,
  MACHINE_STATUSES,
  MACHINE_TYPES,
  PRIORITIES,
  WORK_ORDER_KINDS,
  WORK_ORDER_STATUSES,
  applyWorkOrderSave,
  applyWorkOrderStatus,
  completePMTask,
  dashboardCounts,
  daysBetween,
  filterWorkOrders,
  formatDate,
  formatPartsUsed,
  groupPMTasks,
  isISODate,
  isLowStock,
  needsAttention,
  openBreakdownCount,
  openJobCount,
  pmDueDate,
  pmState,
  searchParts,
  searchWorkOrders,
  shouldOfferMachineDown,
  shouldOfferMachineRunning,
  sortRows,
  sortWorkOrdersNewest,
  todayISO,
  validateBackup,
  workOrderAgeDays,
  workOrdersToCSV,
} from './logic.js';
import { buildSampleData } from './seed.js';
import { renderHelp } from './help.js';
import * as sync from './sync.js';
import { checkSession, logout, renderLogin } from './login.js';

const appMain = document.getElementById('app-main');
const pageTitle = document.getElementById('page-title');
const backButton = document.getElementById('back-button');
const fab = document.getElementById('fab');
const dialogRoot = document.getElementById('dialog-root');
const toastRoot = document.getElementById('toast-root');
const syncPill = document.getElementById('sync-pill');
const userMenuButton = document.getElementById('user-menu-button');

const DESKTOP_QUERY = '(min-width: 1024px)';
const desktopMedia = window.matchMedia(DESKTOP_QUERY);

const state = {
  machines: [],
  parts: [],
  workOrders: [],
  pmTasks: [],
};

let fieldCounter = 0;
let teamUser = null;
let loginActive = false;
let syncEventsBound = false;
let userMenuElement = null;
const LAST_BACKUP_KEY = 'maint-log:last-backup';
const LAST_MACHINE_KEY = 'maint-log:last-machine';
const LAST_TAB_KEY = 'maint-log:last-tab';

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

function setTitle(title) {
  pageTitle.textContent = title;
  document.title = `${title} · Shop Maintenance Log`;
}

async function refreshState() {
  const [machines, parts, workOrders, pmTasks] = await Promise.all([
    db.getAll('machines'),
    db.getAll('parts'),
    db.getAll('workOrders'),
    db.getAll('pmTasks'),
  ]);
  state.machines = machines;
  state.parts = parts;
  state.workOrders = workOrders;
  state.pmTasks = pmTasks;
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

function statusPill(status, labels) {
  const label = labels ? labels[status] : status;
  return h('span', { class: `pill status-${status}` }, label || status || 'Unknown');
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
    options.append(h('option', { value: machine.name }, machine.location || machine.type || ''));
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
          'aria-label': 'Remove part from this work order',
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
      h('span', { class: 'field-label' }, 'Parts used'),
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
    if (machine && machine.status !== 'down' && machine.status !== 'retired') {
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

function jobRow(order) {
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
      h('span', {}, formatAge(workOrderAgeDays(order))),
    ),
    h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'),
  );
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
        [LABELS.machineType[machine.type] || machine.type, machine.location]
          .filter(Boolean)
          .join(' · '),
      ),
    ),
    h(
      'div',
      { class: 'row-side' },
      statusPill(machine.status, LABELS.machineStatus),
      h('span', {}, openCount === 1 ? '1 open job' : `${openCount} open jobs`),
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
      key: 'status',
      label: 'Status',
      value: (order) => LABELS.status[order.status] || order.status,
      cell: (order) => statusPill(order.status, LABELS.status),
    },
    { key: 'title', label: 'Title', value: (order) => order.title },
    { key: 'machine', label: 'Machine', value: (order) => machineName(order.machineId) },
    { key: 'kind', label: 'Kind', value: (order) => LABELS.kind[order.kind] || order.kind },
    {
      key: 'priority',
      label: 'Priority',
      value: (order) => LABELS.priority[order.priority] || order.priority,
      sortValue: (order) => PRIORITIES.indexOf(order.priority),
    },
    {
      key: 'reported',
      label: 'Reported',
      value: (order) => formatDate(order.reportedAt),
      sortValue: (order) => order.reportedAt,
    },
    {
      key: 'age',
      label: 'Age (days)',
      value: (order) => String(workOrderAgeDays(order, today)),
      sortValue: (order) => workOrderAgeDays(order, today),
    },
    {
      key: 'downtime',
      label: 'Downtime',
      value: (order) => `${toInteger(order.downtimeMinutes)} min`,
      sortValue: (order) => toInteger(order.downtimeMinutes),
    },
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
      value: (machine) => LABELS.machineType[machine.type] || machine.type,
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
      label: 'Open jobs',
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
  ];
}

/* ---------- Work orders ---------- */

function renderJobs(route) {
  setTitle('Jobs');
  const requested = route.params.get('filter') || route.params.get('status') || 'active';
  const filter = ['active', 'all', ...WORK_ORDER_STATUSES, 'waiting'].includes(requested)
    ? requested
    : 'active';
  const listHost = h('div', { class: 'list' });
  const tableHost = h('div', { class: 'table-wrap' });
  let searchQuery = '';

  function update(nextQuery) {
    if (typeof nextQuery === 'string') searchQuery = nextQuery;
    let orders = filterWorkOrders(state.workOrders, filter);
    if (searchQuery.trim()) orders = searchWorkOrders(orders, searchQuery, state.machines);
    orders = sortWorkOrdersNewest(orders);
    if (orders.length === 0) {
      listHost.replaceChildren(
        emptyState(
          searchQuery.trim() ? 'No matching jobs' : 'No jobs here',
          searchQuery.trim()
            ? 'Try a different search.'
            : 'Log a repair to keep track of what is open.',
          filter === 'active' ? [h('a', { class: 'btn btn-primary', href: '#/jobs/new' }, '+ Log repair')] : [],
        ),
      );
      listHost.classList.remove('cards-only');
      tableHost.replaceChildren();
    } else {
      listHost.replaceChildren(...orders.map(jobRow));
      listHost.classList.add('cards-only');
      tableHost.replaceChildren(
        buildDataTable(
          'jobs',
          jobsTableColumns(),
          orders,
          (order) => `#/jobs/${encodeURIComponent(order.id)}`,
          update,
        ),
      );
    }
  }

  const chips = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': 'Filter jobs by status' },
    ['active', 'open', 'in-progress', 'waiting', 'done', 'all'].map((value) => {
      const label =
        value === 'active'
          ? 'All open'
          : value === 'waiting'
            ? 'Waiting'
            : value === 'all'
              ? 'All'
              : LABELS.status[value];
      let href = `#/jobs?filter=${value}`;
      return h(
        'a',
        {
          class: `chip${value === filter ? ' is-active' : ''}`,
          href,
          'aria-pressed': value === filter ? 'true' : 'false',
        },
        label,
      );
    }),
  );

  update();
  const search = searchBox('Search jobs', (value) => update(value));

  return page(
    pageHead('Jobs', h('a', { class: 'btn btn-primary btn-small', href: '#/jobs/new' }, '+ Log repair')),
    search,
    chips,
    listHost,
    tableHost,
  );
}

function renderJobNew(route) {
  setTitle('Log repair');
  if (state.machines.length === 0) {
    return page(
      pageHead('Log repair'),
      emptyState(
        'Add a machine first',
        'Every work order belongs to a machine or building item.',
        [h('a', { class: 'btn btn-primary', href: '#/machines/new' }, 'Add a machine')],
      ),
    );
  }
  const preset = route.params.get('machine');
  return page(
    pageHead('Log repair'),
    workOrderForm({
      existing: null,
      quick: true,
      presetMachineId: preset && machineById(preset) ? preset : null,
    }),
  );
}

function renderJobDetail(route) {
  const order = workOrderById(route.segments[1]);
  setTitle(order ? order.title : 'Job not found');
  if (!order) {
    return page(
      pageHead('Job not found'),
      emptyState('That work order does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/jobs' }, 'Back to Jobs'),
      ]),
    );
  }

  const machine = machineById(order.machineId);
  const partsUsed = order.partsUsed || [];

  async function changeStatus(status) {
    if (status === order.status) return;
    const wasDone = order.status === 'done';
    const result = await persistWorkOrderSave(order, { ...order, status }, {});
    if (shouldOfferMachineDown(result.order)) {
      const currentMachine = machineById(result.order.machineId);
      if (currentMachine && currentMachine.status === 'running') {
        const yes = await showConfirm({
          title: 'Set machine to Down?',
          message: `${currentMachine.name} is still on an open breakdown.`,
          confirmText: 'Set Down',
          cancelText: 'Leave Running',
        });
        if (yes) {
          await sync.saveRecord(
            'machines',
            { ...currentMachine, status: 'down', updatedAt: nowISO() },
            currentMachine.version,
          );
          await refreshState();
        }
      }
    }
    await maybeOfferRunning(result.order, wasDone);
    toast(`Status changed to ${LABELS.status[status]}.`);
    render();
  }

  async function deleteOrder() {
    const yes = await showConfirm({
      title: 'Delete this work order?',
      message: `"${order.title}" will be removed. This cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!yes) return;
    await sync.deleteRecord('workOrders', order.id, order.version);
    await refreshState();
    toast('Work order deleted.');
    navigate('#/jobs');
  }

  const statusButtons = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': 'Change status' },
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
    h('dt', {}, 'Priority'),
    h('dd', {}, LABELS.priority[order.priority] || order.priority),
    h('dt', {}, 'Reported'),
    h('dd', {}, formatDate(order.reportedAt)),
    h('dt', {}, 'Completed'),
    h('dd', {}, order.completedAt ? formatDate(order.completedAt) : '—'),
    h('dt', {}, 'Age'),
    h('dd', {}, formatAge(workOrderAgeDays(order))),
    h('dt', {}, 'Labour'),
    h('dd', {}, `${toInteger(order.minutesSpent)} min`),
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

  const editForm = h(
    'details',
    { class: 'more' },
    h('summary', {}, 'Edit work order'),
    workOrderForm({ existing: order, quick: false }),
  );

  return page(
    h(
      'div',
      { class: 'detail-head' },
      h('div', {}, h('h2', {}, order.title), h('div', { class: 'row-sub' }, machineName(order.machineId))),
      statusPill(order.status, LABELS.status),
    ),
    statusButtons,
    h('div', { class: 'card' }, details),
    order.problem ? [sectionTitle('Problem'), h('div', { class: 'card pre' }, order.problem)] : null,
    order.actionTaken
      ? [sectionTitle('Action taken'), h('div', { class: 'card pre' }, order.actionTaken)]
      : null,
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
    editForm,
    h(
      'div',
      { class: 'form-actions', style: { marginTop: '1.25rem' } },
      h('button', { class: 'btn btn-danger', type: 'button', onclick: deleteOrder }, 'Delete work order'),
    ),
  );
}

function workOrderForm({ existing = null, quick = false, presetMachineId = null }) {
  const isNew = !existing;
  const today = todayISO();
  const base = existing || {
    title: '',
    machineId: presetMachineId || '',
    kind: 'breakdown',
    priority: 'normal',
    status: 'open',
    reportedAt: today,
    problem: '',
    actionTaken: '',
    partsUsed: [],
    minutesSpent: 0,
    downtimeMinutes: 0,
  };

  const form = h('form', { class: 'form', novalidate: true });
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
  const prioritySelect = selectFrom(PRIORITIES, base.priority || 'normal', (value) => LABELS.priority[value]);
  const statusSelect = selectFrom(WORK_ORDER_STATUSES, base.status || 'open', (value) => LABELS.status[value]);
  const reportedInput = h('input', { type: 'date', value: base.reportedAt || today });
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

  const downCheckbox = h('input', { type: 'checkbox', checked: true });
  const downLabel = h('label', { for: 'set-machine-down' }, 'Set machine to Down while this job is open');
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

  const extraFields = h(
    'div',
    { class: 'stack' },
    field('Action taken', actionInput),
    partsEditor.element,
    h(
      'div',
      { class: 'grid-2' },
      field('Labour minutes', minutesInput),
      field('Machine downtime (minutes)', downtimeInput),
    ),
  );

  form.append(
    errorBox,
    machineField,
    field('Title', titleInput),
    h(
      'div',
      { class: 'grid-2' },
      field('Kind', kindSelect),
      field('Priority', prioritySelect),
    ),
    h(
      'div',
      { class: 'grid-2' },
      field('Status', statusSelect),
      field('Reported date', reportedInput),
    ),
    field('Problem', problemInput),
    downRow,
  );

  if (quick) {
    form.append(
      h('details', { class: 'more' }, h('summary', {}, 'More details'), extraFields),
    );
  } else {
    form.append(extraFields);
  }

  const saveButton = h(
    'button',
    { class: 'btn btn-primary', type: 'submit' },
    isNew ? 'Save work order' : 'Save changes',
  );
  const cancelHref = existing ? `#/jobs/${encodeURIComponent(existing.id)}` : '#/jobs';
  form.append(
    h(
      'div',
      { class: 'form-actions' },
      saveButton,
      h('a', { class: 'btn', href: cancelHref }, 'Cancel'),
    ),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const title = titleInput.value.trim();
    if (!title) {
      errorBox.textContent = 'Enter a short title for the job.';
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
      errorBox.textContent = 'Choose the date the job was reported.';
      reportedInput.focus();
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
      completedAt: existing ? existing.completedAt : null,
      problem: problemInput.value.trim(),
      actionTaken: actionInput.value.trim(),
      partsUsed: partsEditor.getPartsUsed(),
      minutesSpent: toInteger(minutesInput.value),
      downtimeMinutes: toInteger(downtimeInput.value),
      pmTaskId: existing ? existing.pmTaskId : null,
      photos: existing ? existing.photos || [] : [],
      stockDeducted: existing ? Boolean(existing.stockDeducted) : false,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    saveButton.disabled = true;
    try {
      const wasDone = existing ? existing.status === 'done' : false;
      const setMachineDown =
        !downRow.hidden && downCheckbox.checked && machine.status !== 'down';
      const result = await persistWorkOrderSave(existing, incoming, { setMachineDown });
      await maybeOfferRunning(result.order, wasDone);
      toast(isNew ? 'Work order logged.' : 'Work order saved.');
      navigate(`#/jobs/${encodeURIComponent(result.order.id)}`);
    } catch (error) {
      errorBox.textContent = 'Could not save. Please try again.';
      console.error(error);
    } finally {
      saveButton.disabled = false;
    }
  });

  return form;
}

/* ---------- Machines ---------- */

function renderMachines(route) {
  setTitle('Machines');
  const listHost = h('div', { class: 'list' });
  const tableHost = h('div', { class: 'table-wrap' });
  let searchQuery = '';

  function update(nextQuery) {
    if (typeof nextQuery === 'string') searchQuery = nextQuery;
    const needle = searchQuery.trim().toLowerCase();
    const machines = state.machines
      .filter((machine) => {
        if (!needle) return true;
        return [machine.name, machine.type, machine.model, machine.serial, machine.location]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle));
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (machines.length === 0) {
      listHost.replaceChildren(
        emptyState(
          needle ? 'No matching machines' : 'No machines yet',
          needle
            ? 'Try a different search.'
            : 'Add sewing machines, cutters, building items and anything else you maintain.',
          needle
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
  return page(
    pageHead(
      'Machines',
      h('a', { class: 'btn btn-primary btn-small', href: '#/machines/new' }, '+ Add machine'),
    ),
    searchBox('Search machines', (value) => update(value)),
    listHost,
    tableHost,
  );
}

function renderMachineForm(route) {
  const id = route.segments[1];
  const editing = Boolean(id && id !== 'new');
  const existing = editing ? machineById(id) : null;
  setTitle(editing ? 'Edit machine' : 'Add machine');
  if (editing && !existing) {
    return page(
      pageHead('Machine not found'),
      emptyState('That machine does not exist.', 'It may have been deleted.', [
        h('a', { class: 'btn btn-primary', href: '#/machines' }, 'Back to Machines'),
      ]),
    );
  }
  const base = existing || {
    name: '',
    type: 'sewing',
    model: '',
    serial: '',
    location: '',
    status: 'running',
    notes: '',
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
  const typeSelect = selectFrom(MACHINE_TYPES, base.type || 'sewing', (value) => LABELS.machineType[value]);
  const modelInput = h('input', { type: 'text', value: base.model || '' });
  const serialInput = h('input', { type: 'text', value: base.serial || '' });
  const locationInput = h('input', { type: 'text', value: base.location || '' });
  const statusSelect = selectFrom(MACHINE_STATUSES, base.status || 'running', (value) => LABELS.machineStatus[value]);
  const notesInput = h('textarea', { rows: 4, value: base.notes || '' });

  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Save changes' : 'Add machine');
  form.append(
    errorBox,
    field('Name', nameInput),
    h('div', { class: 'grid-2' }, field('Type', typeSelect), field('Status', statusSelect)),
    h('div', { class: 'grid-2' }, field('Model', modelInput), field('Serial number', serialInput)),
    field('Location', locationInput, 'Line, room, roof, etc.'),
    field('Notes', notesInput),
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
    const now = nowISO();
    const record = {
      ...base,
      id: existing ? existing.id : uid(),
      name,
      type: typeSelect.value,
      model: modelInput.value.trim(),
      serial: serialInput.value.trim(),
      location: locationInput.value.trim(),
      status: statusSelect.value,
      notes: notesInput.value.trim(),
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

  return page(pageHead(editing ? 'Edit machine' : 'Add machine'), form);
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
          ? `${machine.name} still has ${open} open job${open === 1 ? '' : 's'}. The machine will be removed, but its work orders will stay in the log.`
          : `${machine.name} will be removed. Its work order history will stay in the log.`,
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
    h('dd', {}, LABELS.machineType[machine.type] || machine.type),
    h('dt', {}, 'Status'),
    h('dd', {}, statusPill(machine.status, LABELS.machineStatus)),
    h('dt', {}, 'Model'),
    h('dd', {}, machine.model || '—'),
    h('dt', {}, 'Serial'),
    h('dd', {}, machine.serial || '—'),
    h('dt', {}, 'Location'),
    h('dd', {}, machine.location || '—'),
    h('dt', {}, 'Open jobs'),
    h('dd', {}, String(openJobCount(state.workOrders, machine.id))),
    h('dt', {}, 'Notes'),
    h('dd', { class: 'pre' }, machine.notes || '—'),
  );

  return page(
    h(
      'div',
      { class: 'detail-head' },
      h('div', {}, h('h2', {}, machine.name), h('div', { class: 'row-sub' }, machine.location || '')),
      statusPill(machine.status, LABELS.machineStatus),
    ),
    h(
      'div',
      { class: 'button-row' },
      h('a', { class: 'btn btn-primary btn-small', href: `#/jobs/new?machine=${encodeURIComponent(machine.id)}` }, '+ Log repair'),
      h('a', { class: 'btn btn-small', href: `#/machines/${encodeURIComponent(machine.id)}/edit` }, 'Edit machine'),
    ),
    h('div', { class: 'card', style: { marginTop: '0.75rem' } }, details),
    sectionTitle('Repair history'),
    history.length
      ? h('div', { class: 'list' }, ...history.map(jobRow))
      : h('p', { class: 'muted' }, 'No work orders for this machine yet.'),
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
      h('button', { class: 'btn btn-danger', type: 'button', onclick: deleteMachine }, 'Delete machine'),
    ),
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

  function update(nextQuery) {
    if (typeof nextQuery === 'string') searchQuery = nextQuery;
    let parts = searchParts(state.parts, searchQuery, state.machines);
    if (lowOnly) parts = parts.filter(isLowStock);
    parts = parts
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
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
            : [h('a', { class: 'btn btn-primary', href: '#/parts/new' }, 'Add a part')],
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
    pageHead('Parts', h('a', { class: 'btn btn-primary btn-small', href: '#/parts/new' }, '+ Add part')),
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
      message: `${part.name} will be removed. Work orders that already used it will keep their record.`,
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
      low ? h('span', { class: 'pill status-low' }, 'Low stock') : statusPill('ok', { ok: 'In stock' }),
    ),
    h(
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
    ),
    h(
      'div',
      { class: 'button-row', style: { marginTop: '0.75rem' } },
      h('a', { class: 'btn btn-small', href: `#/parts/${encodeURIComponent(part.id)}/edit` }, 'Edit part'),
    ),
    h('div', { class: 'card', style: { marginTop: '0.75rem' } }, details),
    sectionTitle('Used on work orders'),
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
      : h('p', { class: 'muted' }, 'This part has not been used on a work order yet.'),
    h(
      'div',
      { class: 'form-actions', style: { marginTop: '1.5rem' } },
      h('button', { class: 'btn btn-danger', type: 'button', onclick: deletePart }, 'Delete part'),
    ),
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

/* ---------- PM ---------- */

async function markPMTaskDone(task) {
  const now = nowISO();
  const { task: updatedTask, workOrder } = completePMTask(task, {
    id: uid(),
    today: todayISO(),
    now,
  });
  try {
    await sync.saveRecord('pmTasks', updatedTask, task.version);
    await sync.saveRecord('workOrders', workOrder, null);
    await refreshState();
    toast(`PM done: ${task.title}. Logged as a done PM job; next due ${formatDate(pmDueDate(updatedTask))}.`);
    render();
  } catch (error) {
    toast('Could not record the PM. Please try again.', 'warn');
    console.error(error);
  }
}

function pmTaskRow(task) {
  const today = todayISO();
  const due = pmDueDate(task, today);
  const state = pmState(task, today);
  const lateDays = state === 'overdue' ? Math.max(0, daysBetween(due, today) || 0) : 0;
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
      ),
    ),
    h(
      'button',
      { class: 'btn btn-primary btn-small', type: 'button', onclick: () => markPMTaskDone(task) },
      'Mark done',
    ),
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

function renderPM() {
  setTitle('PM');
  const today = todayISO();
  const groups = groupPMTasks(state.pmTasks, today);
  const activeCount = state.pmTasks.filter((task) => task.active !== false).length;
  if (activeCount === 0) {
    return page(
      pageHead('PM', h('a', { class: 'btn btn-primary btn-small', href: '#/pm/new' }, '+ Add PM task')),
      emptyState(
        'No PM tasks yet',
        'Set up recurring checks such as "Oil hook and check timing" so they show up here before something breaks.',
        [h('a', { class: 'btn btn-primary', href: '#/pm/new' }, '+ Add PM task')],
      ),
    );
  }
  return page(
    pageHead('PM', h('a', { class: 'btn btn-primary btn-small', href: '#/pm/new' }, '+ Add PM task')),
    groups.overdue.length ? pmGroupSection('Overdue', groups.overdue) : null,
    groups.dueSoon.length ? pmGroupSection('Due soon', groups.dueSoon) : null,
    groups.upcoming.length ? pmGroupSection('Upcoming', groups.upcoming) : null,
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
      message: `"${task.title}" will be removed. PM work orders already logged will stay in the Jobs tab.`,
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
      inactive ? statusPill('neutral', { neutral: 'Paused' }) : statusPill(pmState(task, today), LABELS.pmState),
    ),
    h('dt', {}, 'Interval'),
    h('dd', {}, `Every ${Math.max(1, Math.floor(Number(task.intervalDays) || 1))} days`),
    h('dt', {}, 'Last done'),
    h('dd', {}, task.lastDoneAt ? formatDate(task.lastDoneAt) : 'Never'),
    h('dt', {}, 'Next due'),
    h('dd', {}, formatDate(due)),
    h('dt', {}, 'Instructions'),
    h('dd', { class: 'pre' }, task.instructions || '—'),
  );

  return page(
    h(
      'div',
      { class: 'detail-head' },
      h('div', {}, h('h2', {}, task.title), h('div', { class: 'row-sub' }, machineName(task.machineId))),
      inactive ? statusPill('neutral', { neutral: 'Paused' }) : statusPill(pmState(task, today), LABELS.pmState),
    ),
    h(
      'div',
      { class: 'button-row' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => markPMTaskDone(task) }, 'Mark done'),
      h('a', { class: 'btn btn-small', href: `#/pm/${encodeURIComponent(task.id)}/edit` }, 'Edit task'),
    ),
    h('div', { class: 'card', style: { marginTop: '0.75rem' } }, details),
    h(
      'div',
      { class: 'form-actions', style: { marginTop: '1.5rem' } },
      h('button', { class: 'btn btn-danger', type: 'button', onclick: deleteTask }, 'Delete PM task'),
    ),
  );
}

function renderPMTaskForm(route) {
  const id = route.segments[1];
  const editing = Boolean(id && id !== 'new');
  const existing = editing ? pmTaskById(id) : null;
  setTitle(editing ? 'Edit PM task' : 'Add PM task');
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

  const base = existing || {
    title: '',
    machineId: '',
    intervalDays: 30,
    lastDoneAt: null,
    instructions: '',
    active: true,
  };

  const form = h('form', { class: 'form', novalidate: true });
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
  const lastDoneInput = h('input', { type: 'date', value: base.lastDoneAt || '' });
  const instructionsInput = h('textarea', {
    rows: 4,
    placeholder: 'Checklist text, e.g. Oil hook; check timing; wipe feed dogs.',
    value: base.instructions || '',
  });
  const activeId = `pm-active-${++fieldCounter}`;
  const activeCheckbox = h('input', { type: 'checkbox' });
  activeCheckbox.id = activeId;
  activeCheckbox.checked = base.active !== false;

  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Save changes' : 'Add PM task');
  form.append(
    errorBox,
    field('Title', titleInput),
    field('Machine', machineSelect),
    field('Interval (days)', intervalInput, 'The task is due again this many days after it was last done.'),
    field('Last done', lastDoneInput, 'Leave empty if this task has never been done; it will be due today.'),
    field('Instructions', instructionsInput),
    h('div', { class: 'check-row' }, activeCheckbox, h('label', { for: activeId }, 'Task is active')),
    h('div', { class: 'field-hint' }, 'Paused tasks never count as due or overdue.'),
    h(
      'div',
      { class: 'form-actions' },
      save,
      h(
        'a',
        { class: 'btn', href: existing ? `#/pm/${encodeURIComponent(existing.id)}` : '#/pm' },
        'Cancel',
      ),
    ),
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
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
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

  return page(pageHead(editing ? 'Edit PM task' : 'Add PM task'), form);
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
        h('a', { class: 'btn btn-primary', href: '#/machines/new' }, 'Add a machine'),
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
      counterTile('Open jobs', counts.openJobs, '#/jobs?filter=active', counts.openJobs > 0 ? 'is-warn' : ''),
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
    toast('No work orders to export yet.', 'warn');
    return;
  }
  downloadFile(
    `work-orders-${todayISO()}.csv`,
    'text/csv;charset=utf-8',
    workOrdersToCSV(state.workOrders, state.machines, state.parts),
  );
  toast(`Exported ${state.workOrders.length} work order${state.workOrders.length === 1 ? '' : 's'} to CSV.`);
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
      }, ${c.workOrders} work order${c.workOrders === 1 ? '' : 's'} and ${c.pmTasks} PM task${
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

function renderSettings() {
  setTitle('Settings');
  const lastBackup = storageGet(LAST_BACKUP_KEY);

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
    h('p', { class: 'muted' }, 'All data lives on this device only. Keep a backup copy somewhere safe.'),
    h(
      'p',
      { class: 'field-hint' },
      `Last backup: ${lastBackup ? formatBackupStamp(lastBackup) : 'Never'}`,
    ),
    sectionTitle('Backup'),
    h(
      'div',
      { class: 'settings-actions' },
      h('button', { class: 'btn', type: 'button', onclick: exportBackup }, 'Export backup (JSON)', h('small', {}, 'Everything on this device in one file')),
      h('label', { class: 'btn', for: fileInputId }, 'Import backup', h('small', {}, 'Replace all data from a backup file')),
      h('button', { class: 'btn', type: 'button', onclick: exportWorkOrderCSV }, 'Export work orders (CSV)', h('small', {}, 'For Excel or email')),
      fileInput,
    ),
    importStatus,
    sectionTitle('Data'),
    h(
      'div',
      { class: 'settings-actions' },
      h('button', { class: 'btn', type: 'button', onclick: loadSampleData }, 'Load sample data', h('small', {}, 'Example machines, parts, jobs and PM tasks')),
      eraseReveal,
    ),
    erasePanel,
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

  for (const link of document.querySelectorAll('.tab, .sidebar a[data-tab]')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  updateNavCounts();
  if (tab !== 'settings' && tab !== 'help') storageSet(LAST_TAB_KEY, tab);

  let content;
  let isDetail = false;
  let splitListRoot = null;

  if (!root || root === 'home') {
    content = renderHome();
  } else if (root === 'jobs') {
    if (!second) content = renderJobs(route);
    else if (second === 'new') content = renderJobNew(route);
    else {
      content = renderJobDetail(route);
      isDetail = true;
      splitListRoot = 'jobs';
    }
  } else if (root === 'machines') {
    if (!second) content = renderMachines(route);
    else if (second === 'new') content = renderMachineForm(route);
    else if (third === 'edit') {
      content = renderMachineForm(route);
      isDetail = true;
    } else {
      content = renderMachineDetail(route);
      isDetail = true;
      splitListRoot = 'machines';
    }
  } else if (root === 'parts') {
    if (!second) content = renderParts(route);
    else if (second === 'new') content = renderPartForm(route);
    else if (third === 'edit') {
      content = renderPartForm(route);
      isDetail = true;
    } else {
      content = renderPartDetail(route);
      isDetail = true;
      splitListRoot = 'parts';
    }
  } else if (root === 'pm') {
    if (!second) content = renderPM(route);
    else if (second === 'new') content = renderPMTaskForm(route);
    else if (third === 'edit') {
      content = renderPMTaskForm(route);
      isDetail = true;
    } else {
      content = renderPMTaskDetail(route);
      isDetail = true;
    }
  } else if (root === 'help') {
    setTitle('Help');
    content = renderHelp(h);
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
          : renderParts(listRoute);
    content = h(
      'div',
      { class: 'split' },
      h('section', { class: 'split-list' }, listPage),
      h('section', { class: 'split-detail' }, content),
    );
    setTitle(detailTitle);
  }

  backButton.hidden = !isDetail;
  fab.hidden = !(tab === 'home' || (tab === 'jobs' && !second));
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

/* Re-render when the viewport crosses the 1024px desktop breakpoint so the
   split view appears or the full-page detail comes back. */
function handleDesktopChange() {
  render();
}

if (typeof desktopMedia.addEventListener === 'function') {
  desktopMedia.addEventListener('change', handleDesktopChange);
} else if (typeof desktopMedia.addListener === 'function') {
  desktopMedia.addListener(handleDesktopChange);
}

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

function handleSyncStatus(event) {
  if (!syncPill) return;
  syncPill.hidden = !teamUser;
  const detail = event.detail || {};
  syncPill.textContent = detail.text || '';
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
  if (!(detail.applied > 0)) return;
  await refreshState();
  // Keep any form the user is filling in; the next navigation re-renders.
  if (appMain.querySelector('form')) return;
  render();
}

function bindSyncEvents() {
  if (syncEventsBound) return;
  syncEventsBound = true;
  window.addEventListener('sync-status', handleSyncStatus);
  window.addEventListener('sync-conflict', handleSyncConflict);
  window.addEventListener('sync-session', handleSyncSessionExpired);
  window.addEventListener('sync-applied', handleSyncApplied);
}

async function loadTeamUsers() {
  try {
    const response = await sync.api('GET', '/api/users');
    if (response.ok && Array.isArray(response.data)) {
      await db.setMeta('users', response.data);
    }
  } catch (error) {
    console.error('Could not load the user list:', error);
  }
}

function closeUserMenu() {
  if (userMenuElement) {
    userMenuElement.remove();
    userMenuElement = null;
  }
  if (userMenuButton) userMenuButton.setAttribute('aria-expanded', 'false');
}

function toggleUserMenu() {
  if (userMenuElement) {
    closeUserMenu();
    return;
  }
  const displayName = teamUser ? teamUser.displayName : '';
  const roleLabel = teamUser && teamUser.role === 'admin' ? 'Administrator' : 'Technician';
  userMenuElement = h(
    'div',
    { class: 'user-menu', role: 'menu' },
    h('div', { class: 'user-menu-name' }, displayName),
    h('div', { class: 'user-menu-role' }, roleLabel),
    h(
      'button',
      {
        class: 'btn btn-danger btn-small',
        type: 'button',
        role: 'menuitem',
        onclick: () => {
          closeUserMenu();
          signOut();
        },
      },
      'Sign out',
    ),
  );
  document.body.append(userMenuElement);
  userMenuButton.setAttribute('aria-expanded', 'true');
}

document.addEventListener('click', (event) => {
  if (!userMenuElement) return;
  if (userMenuElement.contains(event.target)) return;
  if (userMenuButton && userMenuButton.contains(event.target)) return;
  closeUserMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeUserMenu();
});

function setupTeamHeader() {
  if (syncPill) syncPill.hidden = false;
  if (!userMenuButton) return;
  userMenuButton.hidden = false;
  userMenuButton.textContent = teamUser ? teamUser.displayName : 'Account';
  userMenuButton.setAttribute('aria-expanded', 'false');
  if (!userMenuButton.dataset.bound) {
    userMenuButton.dataset.bound = 'true';
    userMenuButton.addEventListener('click', () => toggleUserMenu());
  }
}

function teardownTeamHeader() {
  if (syncPill) {
    syncPill.hidden = true;
    syncPill.textContent = '';
  }
  if (userMenuButton) userMenuButton.hidden = true;
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
  document.body.classList.add('logged-out');
  setTitle('Sign in');
  appMain.replaceChildren();
  registerServiceWorker();
  renderLogin(appMain, async (user) => {
    loginActive = false;
    document.body.classList.remove('logged-out');
    await enterTeamMode(user);
  });
  window.__maintLogReady = true;
}

function restoreLastTab() {
  if (location.hash) return;
  const last = storageGet(LAST_TAB_KEY);
  if (last && ['home', 'jobs', 'machines', 'parts', 'pm'].includes(last)) {
    history.replaceState(null, '', `#/${last}`);
  }
}

async function enterTeamMode(user) {
  teamUser = user;
  document.body.classList.remove('logged-out');
  bindSyncEvents();
  setupTeamHeader();
  await loadTeamUsers();
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

start();
