import * as db from './db.js';

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
let lastBackupKey = 'maint-log:last-backup';
let lastMachineKey = 'maint-log:last-machine';
let lastTabKey = 'maint-log:last-tab';

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
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
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
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      dialogRoot.replaceChildren();
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
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

function requireData() {
  return true;
}

function renderPlaceholder(title) {
  setTitle(title);
  return page(
    pageHead(title),
    emptyState(
      'Not built yet',
      'This milestone will be added in the next build step.',
    ),
  );
}

function renderHome() {
  setTitle('Home');
  return page(
    pageHead('Today'),
    emptyState(
      'Set up your shop',
      'Add your machines, then log your first repair.',
      [h('a', { class: 'btn btn-primary', href: '#/machines/new' }, 'Add a machine')],
    ),
  );
}

function renderMachines() {
  return renderPlaceholder('Machines');
}

function renderJobs() {
  return renderPlaceholder('Jobs');
}

function renderParts() {
  return renderPlaceholder('Parts');
}

function renderPM() {
  return renderPlaceholder('PM');
}

function renderSettings() {
  return renderPlaceholder('Settings');
}

async function render() {
  if (!requireData()) return;
  const route = routeInfo();
  const [root, second, third] = route.segments;
  const tab = root || 'home';

  for (const link of document.querySelectorAll('.tab')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (tab !== 'settings') storageSet(lastTabKey, tab);

  let content;
  let isDetail = false;
  if (!root || root === 'home') {
    content = renderHome();
  } else if (root === 'jobs') {
    if (!second) content = renderJobs();
    else content = renderPlaceholder('Job');
  } else if (root === 'machines') {
    if (!second) content = renderMachines();
    else content = renderPlaceholder('Machine');
  } else if (root === 'parts') {
    if (!second) content = renderParts();
    else content = renderPlaceholder('Part');
  } else if (root === 'pm') {
    if (!second) content = renderPM();
    else content = renderPlaceholder('PM task');
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

  if (second && root !== 'settings') isDetail = true;
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
    const savedTab = storageGet(lastTabKey);
    if (!location.hash && savedTab) {
      // Default to Home on launch; the stored tab is only a preference hint.
    }
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
