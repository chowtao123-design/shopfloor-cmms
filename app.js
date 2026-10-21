import * as db from './db.js';
import {
  LABELS,
  MACHINE_STATUSES,
  MACHINE_TYPES,
  PRIORITIES,
  WORK_ORDER_KINDS,
  WORK_ORDER_STATUSES,
  applyWorkOrderSave,
  applyWorkOrderStatus,
  filterWorkOrders,
  formatDate,
  formatPartsUsed,
  isLowStock,
  openBreakdownCount,
  openJobCount,
  pmDueDate,
  pmState,
  searchParts,
  searchWorkOrders,
  shouldOfferMachineDown,
  shouldOfferMachineRunning,
  sortWorkOrdersNewest,
  todayISO,
  workOrderAgeDays,
} from './logic.js';

const appMain = document.getElementById('app-main');
const pageTitle = document.getElementById('page-title');
const backButton = document.getElementById('back-button');
const fab = document.getElementById('fab');
const dialogRoot = document.getElementById('dialog-root');
const toastRoot = document.getElementById('toast-root');

const state = {
  machines: [],
  parts: [],
  workOrders: [],
  pmTasks: [],
};

let fieldCounter = 0;
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

async function persistChangedParts(result) {
  const now = nowISO();
  const changed = new Set(result.changedIds || []);
  for (const id of changed) {
    const part = result.parts.find((item) => item.id === id);
    if (part) await db.put('parts', { ...part, updatedAt: now });
  }
}

async function persistWorkOrderSave(existing, incoming, options = {}) {
  const now = nowISO();
  const result = applyWorkOrderSave(existing, incoming, state.parts, todayISO());
  result.order.updatedAt = now;
  await persistChangedParts(result);
  if (options.setMachineDown) {
    const machine = machineById(result.order.machineId);
    if (machine && machine.status !== 'down' && machine.status !== 'retired') {
      await db.put('machines', { ...machine, status: 'down', updatedAt: now });
    }
  }
  await db.put('workOrders', result.order);
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
  await db.put('machines', { ...machine, status: 'running', updatedAt: nowISO() });
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
  if (autofocus) input.autofocus = true;
  input.addEventListener('input', () => onInput(input.value));
  return h(
    'div',
    { class: 'search-wrap' },
    h('span', { class: 'search-icon', 'aria-hidden': 'true' }, '⌕'),
    input,
  );
}

/* ---------- Work orders ---------- */

function renderJobs(route) {
  setTitle('Jobs');
  const requested = route.params.get('filter') || route.params.get('status') || 'active';
  const filter = ['active', 'all', ...WORK_ORDER_STATUSES, 'waiting'].includes(requested)
    ? requested
    : 'active';
  const listHost = h('div', { class: 'list' });

  function update(query = '') {
    let orders = filterWorkOrders(state.workOrders, filter);
    if (query.trim()) orders = searchWorkOrders(orders, query, state.machines);
    orders = sortWorkOrdersNewest(orders);
    if (orders.length === 0) {
      listHost.replaceChildren(
        emptyState(
          query.trim() ? 'No matching jobs' : 'No jobs here',
          query.trim()
            ? 'Try a different search.'
            : 'Log a repair to keep track of what is open.',
          filter === 'active' ? [h('a', { class: 'btn btn-primary', href: '#/jobs/new' }, '+ Log repair')] : [],
        ),
      );
    } else {
      listHost.replaceChildren(...orders.map(jobRow));
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
          await db.put('machines', {
            ...currentMachine,
            status: 'down',
            updatedAt: nowISO(),
          });
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
    await db.del('workOrders', order.id);
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

  function update(query = '') {
    const needle = query.trim().toLowerCase();
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
    } else {
      listHost.replaceChildren(...machines.map(machineRow));
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
      await db.put('machines', record);
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
    await db.del('machines', machine.id);
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
            const stateName = pmState(task);
            return h(
              'a',
              { class: 'row', href: `#/pm/${encodeURIComponent(task.id)}` },
              h(
                'div',
                { class: 'row-main' },
                h('div', { class: 'row-title' }, task.title),
                h(
                  'div',
                  { class: 'row-sub' },
                  `${pmState(task) === 'ok' ? 'Due' : LABELS.pmState[stateName]} ${formatDate(pmDueDate(task))} · every ${task.intervalDays} days`,
                ),
              ),
              statusPill(stateName, LABELS.pmState),
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

/* ---------- Placeholders until later milestones ---------- */

function renderParts() {
  setTitle('Parts');
  return page(
    pageHead('Parts'),
    emptyState('Parts arrive in M3', 'The parts inventory is being built.', []),
  );
}

function renderPM() {
  setTitle('PM');
  return page(pageHead('PM'), emptyState('PM arrives in M4', 'Preventive maintenance is being built.', []));
}

function renderHome() {
  setTitle('Home');
  return page(
    pageHead('Today'),
    emptyState('Set up your shop', 'Add your machines, then log your first repair.', [
      h('a', { class: 'btn btn-primary', href: '#/machines/new' }, 'Add a machine'),
    ]),
  );
}

function renderSettings() {
  setTitle('Settings');
  return page(
    pageHead('Settings'),
    emptyState('Settings arrive in M5', 'Backup, import and sample data are being built.', []),
  );
}

/* ---------- Routing ---------- */

async function render() {
  const route = routeInfo();
  const [root, second, third] = route.segments;
  const tab = root || 'home';

  for (const link of document.querySelectorAll('.tab')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (tab !== 'settings') storageSet(LAST_TAB_KEY, tab);

  let content;
  let isDetail = false;

  if (!root || root === 'home') {
    content = renderHome();
  } else if (root === 'jobs') {
    if (!second) content = renderJobs(route);
    else if (second === 'new') content = renderJobNew(route);
    else {
      content = renderJobDetail(route);
      isDetail = true;
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
    }
  } else if (root === 'parts') {
    content = renderParts(route);
    isDetail = Boolean(second);
  } else if (root === 'pm') {
    content = renderPM(route);
    isDetail = Boolean(second);
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

async function start() {
  try {
    await db.open();
    await refreshState();
    await render();
    window.__maintLogReady = true;
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

start();
