import { AREAS, AREA_KEYS, areaLabel, allNonePermissions, normalizeLevel } from './permissions.js';

const LEVEL_LABELS = { none: 'None', read: 'Read', write: 'Write' };

function fullPermissions(permissions) {
  const full = allNonePermissions();
  if (permissions === null || permissions === undefined || typeof permissions !== 'object') return full;
  for (const key of AREA_KEYS) full[key] = normalizeLevel(permissions[key]);
  return full;
}

function draftFromRoles(roles) {
  const draft = {};
  for (const role of Array.isArray(roles) ? roles : []) {
    if (!role || !role.id) continue;
    draft[role.id] = fullPermissions(role.permissions);
  }
  return draft;
}

function isAdministratorRole(role) {
  return Boolean(role && role.builtin && role.name === 'Administrator');
}

function changedRolePatches(roles, draft) {
  const patches = [];
  const source = Array.isArray(roles) ? roles : [];
  const current = draft && typeof draft === 'object' ? draft : {};
  for (const role of source) {
    if (!role || !role.id) continue;
    if (isAdministratorRole(role)) continue;
    const next = fullPermissions(current[role.id]);
    const before = fullPermissions(role.permissions);
    const changed = AREA_KEYS.some((key) => next[key] !== before[key]);
    if (!changed) continue;
    patches.push({ id: role.id, permissions: next });
  }
  return patches;
}

function levelName(value) {
  const normalized = normalizeLevel(value);
  return LEVEL_LABELS[normalized];
}

function historyChangeLines(before, after) {
  const lines = [];
  const beforeSnap = before && typeof before === 'object' ? before : null;
  const afterSnap = after && typeof after === 'object' ? after : null;
  if (beforeSnap && afterSnap && beforeSnap.name !== afterSnap.name) {
    lines.push(`Name: "${beforeSnap.name}" → "${afterSnap.name}"`);
  }
  if (beforeSnap || afterSnap) {
    for (const key of AREA_KEYS) {
      const from = beforeSnap ? normalizeLevel(beforeSnap.permissions?.[key]) : 'none';
      const to = afterSnap ? normalizeLevel(afterSnap.permissions?.[key]) : 'none';
      if (from === to) continue;
      lines.push(`${areaLabel(key)}: ${levelName(from)} → ${levelName(to)}`);
    }
  }
  return lines;
}

function formatRoleHistoryEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const who = source.displayName ? String(source.displayName) : 'System';
  const action = source.action === 'create' || source.action === 'delete' ? source.action : 'update';
  const changes = historyChangeLines(source.before, source.after);
  return {
    who,
    at: source.at || '',
    action,
    changes,
    note: source.note ? String(source.note) : '',
  };
}

function sortHistoryNewestFirst(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort((a, b) => {
    const left = String(a && a.at ? a.at : '');
    const right = String(b && b.at ? b.at : '');
    return right.localeCompare(left);
  });
}

function renderLevelChoice(h, { roleId, area, value, disabled = false, onChange = null } = {}) {
  const group = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': `${areaLabel(area)} access` });
  for (const level of ['none', 'read', 'write']) {
    const input = h('input', {
      type: 'radio',
      name: `perm-${roleId}-${area}`,
      value: level,
      disabled: disabled === true || null,
      checked: level === normalizeLevel(value) || null,
      'aria-label': `${areaLabel(area)}: ${levelName(level)}`,
    });
    if (typeof input.addEventListener === 'function' && typeof onChange === 'function') {
      input.addEventListener('change', () => onChange(level));
    }
    group.append(h('label', { class: 'seg-option' }, input, levelName(level)));
  }
  return group;
}

function renderRoleHistoryList(h, entries, { formatWhen = (at) => at } = {}) {
  const list = h('ul', { class: 'role-history-list' });
  for (const entry of sortHistoryNewestFirst(entries)) {
    const formatted = formatRoleHistoryEntry(entry);
    const changeNodes =
      formatted.changes.length > 0
        ? formatted.changes.map((line) =>
            h('li', { class: 'role-history-change' }, line),
          )
        : [h('li', { class: 'role-history-change muted' }, 'No permission changes.')];
    list.append(
      h(
        'li',
        { class: `role-history-entry action-${formatted.action}` },
        h('div', { class: 'role-history-who' }, formatted.who),
        h('div', { class: 'role-history-when muted' }, formatWhen(formatted.at)),
        h('ul', { class: 'role-history-changes' }, ...changeNodes),
      ),
    );
  }
  return list;
}

function roleDeleteReason(role, users) {
  if (isAdministratorRole(role)) return 'The Administrator role cannot be deleted.';
  const assigned = (Array.isArray(users) ? users : []).filter(
    (user) => user && user.roleId === role.id,
  ).length;
  if (assigned > 0) {
    return `Assigned to ${assigned} user${assigned === 1 ? '' : 's'} — move them to another role first.`;
  }
  return null;
}

function roleRenameReason(role) {
  if (isAdministratorRole(role)) return 'The Administrator role cannot be changed.';
  return null;
}

export {
  LEVEL_LABELS,
  fullPermissions,
  draftFromRoles,
  isAdministratorRole,
  changedRolePatches,
  historyChangeLines,
  formatRoleHistoryEntry,
  sortHistoryNewestFirst,
  renderLevelChoice,
  renderRoleHistoryList,
  roleDeleteReason,
  roleRenameReason,
};