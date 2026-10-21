// Login screen, session check and sign-out (SPEC-v2.md sections 6 and 9.1).
// No app data is rendered before login.

import * as db from './db.js';
import { api } from './sync.js';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) node.append(child);
    else node.append(document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Probe the session cookie: 'ok' (signed in), 'login' (401: server reachable,
 * no valid session) or 'offline' (server unreachable / no team server).
 */
export async function checkSession() {
  try {
    const response = await api('GET', '/api/me');
    if (response.ok) return { status: 'ok', user: response.data };
    if (response.status === 401) return { status: 'login' };
    return { status: 'none' };
  } catch (error) {
    return { status: 'offline', error };
  }
}

/**
 * Render the login form into `container`. `onSuccess(user)` runs after the
 * server sets the session cookie.
 */
export function renderLogin(container, onSuccess) {
  container.replaceChildren();
  const error = el('p', { class: 'login-error', role: 'alert' });
  const usernameInput = el('input', {
    type: 'text',
    id: 'login-username',
    name: 'username',
    autocomplete: 'username',
    autocapitalize: 'none',
    required: true,
  });
  const passwordInput = el('input', {
    type: 'password',
    id: 'login-password',
    name: 'password',
    autocomplete: 'current-password',
    required: true,
  });
  const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in');
  const form = el(
    'form',
    { class: 'login-form', novalidate: true },
    el('label', { class: 'field-label', for: 'login-username' }, 'Username'),
    usernameInput,
    el('label', { class: 'field-label', for: 'login-password' }, 'Password'),
    passwordInput,
    error,
    submit,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
      error.textContent = 'Enter your username and password.';
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const response = await api('POST', '/api/login', { username, password });
      if (response.ok && response.data && response.data.id) {
        if (typeof onSuccess === 'function') onSuccess(response.data);
        return;
      }
      error.textContent =
        response.data && response.data.message
          ? response.data.message
          : 'Could not sign in. Check your username and password.';
    } catch {
      error.textContent = 'Could not reach the server. Check the network and try again.';
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });
  const card = el(
    'section',
    { class: 'login-card', 'aria-label': 'Sign in' },
    el('h2', {}, 'Shop Maintenance Log'),
    el('p', { class: 'login-sub' }, 'Sign in with your team account.'),
    form,
  );
  container.append(card);
  usernameInput.focus();
}

/**
 * Sign out: end the server session, warn about unsynced changes (in-page
 * confirm when the outbox is non-empty), then clear local data so the next
 * person on a shared device sees no stale cache. Returns false when the user
 * kept the session because of unsynced changes.
 */
export async function logout({ confirmDialog } = {}) {
  try {
    await api('POST', '/api/logout');
  } catch (error) {
    console.error('Could not reach the server to sign out:', error);
  }
  let entries = [];
  try {
    entries = await db.getAll(db.OUTBOX_STORE);
  } catch (error) {
    console.error('Could not read pending changes:', error);
  }
  if (entries.length > 0 && typeof confirmDialog === 'function') {
    const yes = await confirmDialog({
      title: 'Sign out?',
      message: `${entries.length} change${entries.length === 1 ? '' : 's'} on this device ${
        entries.length === 1 ? 'is' : 'are'
      } not synced to the server yet. Signing out erases ${entries.length === 1 ? 'it' : 'them'} from this device.`,
      confirmText: 'Sign out anyway',
      cancelText: 'Stay signed in',
      danger: true,
    });
    if (!yes) return false;
  }
  try {
    await db.clearAll();
  } catch (error) {
    console.error('Could not clear local data:', error);
  }
  return true;
}