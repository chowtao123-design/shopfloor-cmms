// Workers page (#/workers): every floor worker with their skills, specialty
// and productivity, so a supervisor can see who can do what. Click a name
// for the full profile; floor-map writers can edit it. Profiles are the
// `workerProfiles` store, keyed by employee ID (they follow the person from
// station to station); the worker list itself comes from the map stations.

import { LABELS } from './logic.js';
import { qcSummary, SKILL_GROUPS, SKILL_LEVELS, skillLevel, skillLevelKey, withSkill, workerRoster } from './logic-map.js';
import { showQcForm, showWorkerQc } from './qc.js';
import { newRecordId } from './logic-ids.js';
import { showPanelWithBody } from './map.js';
import * as sync from './sync.js';

/** Machine types a floor worker can be skilled on (no facility / "other"). */
const SKILL_TYPES = SKILL_GROUPS;

const QUALITY = { '': '—', excellent: 'Excellent', good: 'Good', fair: 'Fair', coaching: 'Needs coaching' };

const typeLabel = (type) => (LABELS.machineType && LABELS.machineType[type]) || type;

const view = { search: '', skill: '', mode: 'list', zone: '', group: SKILL_GROUPS[0].group, bulkSkill: '', bulkLevel: 'good' };

/** Batch editor: staged cell changes, key -> Map(type -> level), until Save. */
const batch = { changes: new Map(), selected: new Set() };

export function renderWorkersPage(ctx, route) {
  const { h } = ctx;
  ctx.setTitle('Workers');
  const wanted = route && route.params ? route.params.get('view') : null;
  if (wanted === 'matrix' || wanted === 'list') view.mode = wanted;
  const roster = workerRoster(ctx.state.floorStations || [], ctx.state.workerProfiles || []);
  const tabs = h(
    'div',
    { class: 'view-switch fm-mode-switch workers-tabs', role: 'group', 'aria-label': 'Workers view' },
    ...[['list', 'List'], ['matrix', 'Skill matrix (batch edit)']].map(([value, label]) =>
      h(
        'button',
        {
          class: `view-switch-btn${view.mode === value ? ' is-active' : ''}`,
          type: 'button',
          'aria-pressed': String(view.mode === value),
          onclick: () => ctx.navigate(`#/workers?view=${value}`),
        },
        label,
      ),
    ),
    h('a', { class: 'view-switch-btn', href: '#/map?view=skills' }, 'Skill map'),
    // Names and IDs live in the name table; this page reads them from there.
    h('a', { class: 'view-switch-btn', href: '#/map?view=table', title: 'Add workers or change names and IDs' }, 'Name table'),
  );
  if (view.mode === 'matrix') return renderMatrix(ctx, roster, tabs);

  const visible = () => {
    const needle = view.search.trim().toLowerCase();
    return roster.filter((worker) => {
      if (view.skill && !skillLevel(worker.profile, view.skill)) return false;
      if (!needle) return true;
      const p = worker.profile || {};
      return [worker.empId, worker.name, worker.nameCn, worker.zone, p.specialty, p.phone, p.locker, ...worker.stations.map((s) => s.code)]
        .some((value) => String(value || '').toLowerCase().includes(needle));
    });
  };

  const listHost = h('div', {});
  const count = h('span', { class: 'field-hint' });
  const fill = () => {
    const rows = visible();
    count.textContent = `${rows.length} of ${roster.length} workers`;
    listHost.replaceChildren(rows.length ? workerTable(ctx, rows) : h('p', { class: 'muted' }, 'No worker matches.'));
  };

  const search = ctx.searchBox('Search name, ID, station, locker, phone', (value) => {
    view.search = value;
    fill();
  });
  search.querySelector('input').value = view.search;

  // "Who can run a binder?": only workers with that skill, best first.
  const skillSelect = h('select', { 'aria-label': 'Skill' });
  skillSelect.append(h('option', { value: '' }, 'Any skill'));
  for (const group of SKILL_TYPES) {
    skillSelect.append(h('optgroup', { label: group.group }, ...group.options.map(([value, label]) => h('option', { value }, label))));
  }
  skillSelect.value = view.skill;
  skillSelect.addEventListener('change', () => {
    view.skill = skillSelect.value;
    fill();
  });

  fill();
  return ctx.page(
    ctx.pageHead('Workers'),
    tabs,
    h('div', { class: 'workers-toolbar' }, search, skillSelect, count),
    h(
      'p',
      { class: 'field-hint' },
      'Click a name to see the worker’s skills, specialty and productivity.',
      ctx.can('floorMap', 'write') ? ' Supervisors can edit them there.' : '',
    ),
    listHost,
  );
}

function workerTable(ctx, rows) {
  const { h } = ctx;
  const sorted = view.skill
    ? rows.slice().sort((a, b) => levelRank(a.profile, view.skill) - levelRank(b.profile, view.skill))
    : rows;
  return h(
    'div',
    { class: 'table-scroll workers-wrap' },
    h(
      'table',
      { class: 'stats-table workers-table' },
      h(
        'thead',
        {},
        h('tr', {}, ...['Worker', 'ID', 'Station', 'Zone', view.skill ? `${typeLabel(view.skill)}` : 'Top skills', 'Efficiency', 'Quality'].map((label) => h('th', { scope: 'col' }, label))),
      ),
      h(
        'tbody',
        {},
        ...sorted.map((worker) => {
          const p = worker.profile;
          const skills = view.skill
            ? [levelPill(h, skillLevel(p, view.skill))]
            : (p && p.skillsExpert ? p.skillsExpert : []).slice(0, 3).map((type) => h('span', { class: 'pill skill-pill is-expert' }, typeLabel(type)));
          return h(
            'tr',
            {},
            h(
              'th',
              { scope: 'row' },
              h(
                'button',
                { class: 'link-button worker-name', type: 'button', onclick: () => openWorker(ctx, worker) },
                worker.name || worker.empId || 'Worker',
                worker.nameCn && !String(worker.name).includes(worker.nameCn) ? h('span', { class: 'muted' }, ` ${worker.nameCn}`) : null,
              ),
            ),
            h('td', { class: 'tabular' }, worker.empId || '—'),
            h('td', {}, worker.stations.map((s) => s.code).filter(Boolean).join(', ') || h('span', { class: 'muted' }, 'Not on the map')),
            h('td', {}, worker.zone || ''),
            h('td', { class: 'skill-cell' }, ...(skills.length ? skills : [h('span', { class: 'muted' }, p ? '—' : 'No profile yet')])),
            h('td', { class: 'tabular' }, p && p.efficiency ? `${p.efficiency}%` : '—'),
            h('td', {}, p ? QUALITY[p.quality || ''] : '—'),
          );
        }),
      ),
    ),
  );
}

function levelRank(profile, type) {
  const level = skillLevel(profile, type);
  return level ? SKILL_LEVELS.findIndex((entry) => entry.label === level) : SKILL_LEVELS.length;
}

function levelPill(h, level) {
  if (!level) return h('span', { class: 'muted' }, '—');
  return h('span', { class: `pill skill-pill is-${level.toLowerCase()}` }, level);
}

/**
 * A click on a worker: straight to the edit screen for floor-map writers
 * (who are the ones keeping skills up to date), the read view for others.
 */
export function openWorker(ctx, worker) {
  if (ctx.can('floorMap', 'write') && worker && worker.empId) showWorkerEditor(ctx, worker);
  else showWorkerProfile(ctx, worker);
}

/** "QC, last 30 days: 2.1% defects in 4 checks" + History / Record QC (qc.js). */
function qcLine(ctx, worker) {
  const { h } = ctx;
  if (!worker.empId) return null;
  const since = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const key = String(worker.empId).toUpperCase().replace(/\s+/g, '');
  const mine = (ctx.state.qcRecords || []).filter((r) => String(r.empId).toUpperCase().replace(/\s+/g, '') === key);
  const [s] = qcSummary(mine, since);
  return h(
    'div',
    { class: 'worker-qc' },
    h('span', {}, h('strong', {}, 'QC, last 30 days: '), s ? `${s.rate}% defects in ${s.checks} check${s.checks === 1 ? '' : 's'}${s.fails ? ` · ${s.fails} failed` : ''}` : 'no checks'),
    h(
      'span',
      { class: 'worker-qc-actions' },
      mine.length ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => showWorkerQc(ctx, worker.empId) }, 'QC history') : null,
      ctx.can('floorMap', 'write') ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => showQcForm(ctx, null, worker) }, 'Record QC') : null,
    ),
  );
}

/** The profile in the side panel: read view; Edit for floor-map writers. */
export function showWorkerProfile(ctx, worker) {
  const { h } = ctx;
  const p = worker.profile || {};
  const title = `${worker.empId ? `${worker.empId} ` : ''}${worker.name || 'Worker'}`;
  const fact = (label, value) => h('div', { class: 'worker-fact' }, h('span', { class: 'field-hint' }, label), h('strong', {}, value));

  const skillBlocks = SKILL_LEVELS.map((level) => {
    const list = Array.isArray(p[level.key]) ? p[level.key] : [];
    return list.length
      ? h(
          'div',
          { class: 'worker-skill-row' },
          h('span', { class: `pill skill-pill is-${level.label.toLowerCase()}` }, level.label),
          h('span', {}, list.map(typeLabel).join(', ')),
        )
      : null;
  }).filter(Boolean);

  const body = h(
    'div',
    { class: 'fm-panel worker-profile' },
    worker.nameCn ? h('p', { class: 'worker-cn' }, worker.nameCn) : null,
    qcLine(ctx, worker),
    h(
      'div',
      { class: 'worker-facts' },
      fact('Station', worker.stations.map((s) => s.code).filter(Boolean).join(', ') || 'Not on the map'),
      fact('Zone', worker.zone || '—'),
      fact('Locker', p.locker || '—'),
      h(
        'div',
        { class: 'worker-fact' },
        h('span', { class: 'field-hint' }, 'Phone'),
        p.phone ? h('a', { class: 'worker-phone', href: `tel:${p.phone.replace(/[^\d+]/g, '')}` }, p.phone) : h('strong', {}, '—'),
      ),
      fact('Efficiency', p.efficiency ? `${p.efficiency}%` : '—'),
      fact('Daily output', p.dailyOutput ? `${p.dailyOutput} pcs` : '—'),
      fact('Quality', QUALITY[p.quality || '']),
    ),
    h('h3', { class: 'section-title' }, 'Skills'),
    skillBlocks.length ? h('div', { class: 'worker-skills' }, ...skillBlocks) : h('p', { class: 'muted' }, 'No skills recorded yet.'),
    h('h3', { class: 'section-title' }, 'Specialty'),
    h('p', {}, p.specialty || h('span', { class: 'muted' }, '—')),
    p.notes ? h('h3', { class: 'section-title' }, 'Supervisor notes') : null,
    p.notes ? h('p', { class: 'worker-notes' }, p.notes) : null,
    p.updatedAt ? h('p', { class: 'field-hint' }, `Updated ${String(p.updatedAt).slice(0, 10)}`) : null,
    ctx.can('floorMap', 'write')
      ? h(
          'button',
          { class: 'btn btn-primary worker-edit', type: 'button', onclick: () => showWorkerEditor(ctx, worker) },
          worker.profile ? 'Edit profile' : 'Add skills and productivity',
        )
      : null,
  );
  showPanelWithBody(ctx, title, body);
}

function showWorkerEditor(ctx, worker) {
  const { h } = ctx;
  const p = worker.profile || {};
  const number = (value, max) => h('input', { type: 'number', min: '0', max: String(max), step: '1', inputmode: 'numeric', value: value ? String(value) : '' });
  const efficiency = number(p.efficiency, 300);
  const output = number(p.dailyOutput, 100000);
  const quality = h('select', {}, ...Object.entries(QUALITY).map(([value, label]) => h('option', { value }, value ? label : 'Not rated')));
  quality.value = p.quality || '';
  const specialty = h('input', { type: 'text', maxlength: '200', value: p.specialty || '', placeholder: 'e.g. collars, pockets, zippers' });
  const phone = h('input', { type: 'tel', maxlength: '40', autocomplete: 'off', value: p.phone || '' });
  const locker = h('input', { type: 'text', maxlength: '20', value: p.locker || '' });
  const notes = h('textarea', { maxlength: '1000', rows: '3' });
  notes.value = p.notes || '';

  // One row per machine type: — / Learning / Good / Expert.
  const levelSelects = [];
  const matrix = h(
    'div',
    { class: 'worker-matrix' },
    ...SKILL_TYPES.map((group) =>
      h(
        'fieldset',
        { class: 'worker-matrix-group' },
        h('legend', {}, group.group),
        ...group.options.map(([type, label]) => {
          const select = h('select', { 'aria-label': label }, h('option', { value: '' }, '—'), ...SKILL_LEVELS.map((level) => h('option', { value: level.key }, level.label)));
          const current = SKILL_LEVELS.find((level) => Array.isArray(p[level.key]) && p[level.key].includes(type));
          select.value = current ? current.key : '';
          levelSelects.push({ type, select });
          return h('label', { class: 'worker-matrix-row' }, h('span', {}, label), select);
        }),
      ),
    ),
  );

  const save = h('button', { class: 'btn btn-primary worker-save', type: 'submit' }, 'Save profile');
  const form = h(
    'form',
    { class: 'fm-panel worker-form', novalidate: true },
    h(
      'p',
      { class: 'worker-where field-hint' },
      [
        worker.nameCn,
        worker.stations.length ? `Station ${worker.stations.map((st) => st.code).filter(Boolean).join(', ')}` : 'Not on the map',
        worker.zone,
      ].filter(Boolean).join(' · '),
    ),
    qcLine(ctx, worker),
    h('div', { class: 'fm-inspect-row' }, ctx.field('Phone', phone), ctx.field('Locker no.', locker)),
    h('div', { class: 'fm-inspect-row' }, ctx.field('Efficiency %', efficiency), ctx.field('Daily output (pcs)', output)),
    ctx.field('Quality', quality),
    ctx.field('Specialty', specialty),
    h('h3', { class: 'section-title' }, 'Skills by machine'),
    matrix,
    ctx.field('Supervisor notes', notes),
    // Pinned to the bottom of the panel while the long skill list scrolls.
    h('div', { class: 'worker-save-bar' }, save),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const toInt = (input, max) => {
      const n = Math.round(Number(input.value));
      return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
    };
    const skills = { skillsExpert: [], skillsGood: [], skillsLearning: [] };
    for (const { type, select } of levelSelects) if (select.value) skills[select.value].push(type);
    const record = {
      ...(worker.profile || { id: newRecordId(), createdAt: ctx.nowISO() }),
      empId: worker.empId,
      name: worker.name || '',
      phone: phone.value.trim(),
      locker: locker.value.trim(),
      specialty: specialty.value.trim(),
      ...skills,
      efficiency: toInt(efficiency, 300),
      dailyOutput: toInt(output, 100000),
      quality: quality.value,
      notes: notes.value.trim(),
      updatedAt: ctx.nowISO(),
    };
    delete record.pendingSync;
    save.disabled = true;
    try {
      await sync.saveRecord('workerProfiles', record, worker.profile ? worker.profile.version : null);
      await ctx.refreshState();
      ctx.toast('Profile saved.');
      const fresh = workerRoster(ctx.state.floorStations || [], ctx.state.workerProfiles || []).find((w) => w.key === worker.key);
      ctx.render();
      showWorkerEditor(ctx, fresh || { ...worker, profile: record });
    } catch (error) {
      console.error(error);
      save.disabled = false;
      ctx.toast('Could not save the profile. Please try again.', 'warn');
    }
  });
  if (!worker.empId) {
    form.replaceChildren(h('p', { class: 'muted' }, 'Give this worker an Employee ID on the map first: profiles are kept by ID.'));
  }
  showPanelWithBody(ctx, `Edit ${worker.name || worker.empId}`, form);
}

// ---------------------------------------------------------------------------
// Skill matrix: batch editing (workers x machine types)
// ---------------------------------------------------------------------------

const LEVEL_CYCLE = ['', 'learning', 'good', 'expert'];
const LEVEL_SHORT = { '': '', learning: 'L', good: 'G', expert: 'E' };
const LEVEL_NAME = { '': 'none', learning: 'Learning', good: 'Good', expert: 'Expert' };

function stagedLevel(worker, type) {
  const staged = batch.changes.get(worker.key);
  return staged && staged.has(type) ? staged.get(type) : skillLevelKey(worker.profile, type);
}

function stage(worker, type, level) {
  const original = skillLevelKey(worker.profile, type);
  const staged = batch.changes.get(worker.key) || new Map();
  if (level === original) staged.delete(type);
  else staged.set(type, level);
  if (staged.size) batch.changes.set(worker.key, staged);
  else batch.changes.delete(worker.key);
}

const changeCount = () => [...batch.changes.values()].reduce((n, m) => n + m.size, 0);

function renderMatrix(ctx, roster, tabs) {
  const { h } = ctx;
  const canWrite = ctx.can('floorMap', 'write');
  const zones = [...new Set(roster.map((w) => w.zone).filter(Boolean))].sort();
  const group = SKILL_GROUPS.find((g) => g.group === view.group) || SKILL_GROUPS[0];
  const types = group.options;

  const needle = view.search.trim().toLowerCase();
  const rows = roster.filter((w) => {
    if (view.zone && w.zone !== view.zone) return false;
    if (!needle) return true;
    return [w.empId, w.name, w.nameCn, ...w.stations.map((st) => st.code)].some((v) => String(v || '').toLowerCase().includes(needle));
  });

  const search = ctx.searchBox('Search name, ID, station', (value) => {
    view.search = value;
    ctx.render();
  });
  search.querySelector('input').value = view.search;
  const zoneSelect = h('select', { 'aria-label': 'Zone' }, h('option', { value: '' }, 'All zones'), ...zones.map((z) => h('option', { value: z }, z)));
  zoneSelect.value = view.zone;
  zoneSelect.addEventListener('change', () => {
    view.zone = zoneSelect.value;
    ctx.render();
  });
  const groupSelect = h('select', { 'aria-label': 'Machine group' }, ...SKILL_GROUPS.map((g) => h('option', { value: g.group }, g.group)));
  groupSelect.value = group.group;
  groupSelect.addEventListener('change', () => {
    view.group = groupSelect.value;
    ctx.render();
  });

  // Status line + Save / Discard: rebuilt after every change, no page render.
  const saveBar = h('div', { class: 'workers-savebar', role: 'status' });
  const refreshBar = () => {
    const n = changeCount();
    const save = h('button', { class: 'btn btn-primary', type: 'button', disabled: n === 0, onclick: () => saveBatch(ctx, roster) }, n ? `Save ${n} change${n === 1 ? '' : 's'}` : 'No changes');
    const discard = h('button', { class: 'btn', type: 'button', disabled: n === 0, onclick: () => {
      batch.changes.clear();
      ctx.render();
    } }, 'Discard');
    saveBar.classList.toggle('has-changes', n > 0);
    saveBar.replaceChildren(h('span', { class: 'field-hint' }, n ? `${n} unsaved change${n === 1 ? '' : 's'} (highlighted)` : 'Tap a cell to cycle: none → Learning → Good → Expert.'), discard, save);
  };

  // Bulk: one skill + level for every ticked worker.
  const bulkSkill = h('select', { 'aria-label': 'Skill to set' }, ...SKILL_GROUPS.map((g) => h('optgroup', { label: g.group }, ...g.options.map(([v, label]) => h('option', { value: v }, label)))));
  bulkSkill.value = view.bulkSkill || types[0][0];
  bulkSkill.addEventListener('change', () => {
    view.bulkSkill = bulkSkill.value;
  });
  const bulkLevel = h('select', { 'aria-label': 'Level' }, ...LEVEL_CYCLE.slice(1).reverse().map((l) => h('option', { value: l }, LEVEL_NAME[l])), h('option', { value: '' }, 'Remove skill'));
  bulkLevel.value = view.bulkLevel;
  bulkLevel.addEventListener('change', () => {
    view.bulkLevel = bulkLevel.value;
  });
  const selectedNote = h('span', { class: 'field-hint' });
  const syncSelected = () => {
    selectedNote.textContent = `${batch.selected.size} selected`;
  };
  const bulkApply = h('button', { class: 'btn btn-small', type: 'button', onclick: () => {
    if (!batch.selected.size) {
      ctx.toast('Tick the workers first.');
      return;
    }
    for (const worker of roster) if (batch.selected.has(worker.key) && worker.empId) stage(worker, bulkSkill.value, bulkLevel.value);
    ctx.render();
  } }, 'Set for selected');
  syncSelected();

  const cellButton = (worker, type) => {
    const level = stagedLevel(worker, type);
    const changed = batch.changes.get(worker.key)?.has(type);
    const btn = h(
      'button',
      {
        class: `skill-cell-btn lv-${level || 'none'}${changed ? ' is-changed' : ''}`,
        type: 'button',
        disabled: !canWrite || !worker.empId,
        title: `${worker.name || worker.empId}: ${typeLabel(type)} — ${LEVEL_NAME[level]}`,
        'aria-label': `${worker.name || worker.empId}, ${typeLabel(type)}: ${LEVEL_NAME[level]}`,
      },
      LEVEL_SHORT[level],
    );
    btn.addEventListener('click', () => {
      const next = LEVEL_CYCLE[(LEVEL_CYCLE.indexOf(stagedLevel(worker, type)) + 1) % LEVEL_CYCLE.length];
      stage(worker, type, next);
      const fresh = cellButton(worker, type);
      btn.replaceWith(fresh);
      fresh.focus();
      refreshBar();
    });
    return btn;
  };

  const allBox = h('input', { type: 'checkbox', 'aria-label': 'Select all shown' });
  allBox.checked = rows.length > 0 && rows.every((w) => batch.selected.has(w.key));
  allBox.addEventListener('change', () => {
    for (const w of rows) if (allBox.checked) batch.selected.add(w.key); else batch.selected.delete(w.key);
    ctx.render();
  });

  const table = h(
    'table',
    { class: 'skill-matrix' },
    h(
      'thead',
      {},
      h('tr', {}, h('th', { class: 'sm-check' }, canWrite ? allBox : ''), h('th', { class: 'sm-name', scope: 'col' }, 'Worker'), ...types.map(([type, label]) => h('th', { class: 'sm-type', scope: 'col', title: label }, h('span', {}, label)))),
    ),
    h(
      'tbody',
      {},
      ...rows.map((worker) => {
        const box = h('input', { type: 'checkbox', 'aria-label': `Select ${worker.name || worker.empId}`, disabled: !worker.empId });
        box.checked = batch.selected.has(worker.key);
        box.addEventListener('change', () => {
          if (box.checked) batch.selected.add(worker.key);
          else batch.selected.delete(worker.key);
          syncSelected();
        });
        return h(
          'tr',
          {},
          h('td', { class: 'sm-check' }, canWrite ? box : ''),
          h(
            'th',
            { class: 'sm-name', scope: 'row' },
            h('button', { class: 'link-button', type: 'button', onclick: () => openWorker(ctx, worker) }, worker.name || worker.empId || 'Worker'),
            h('span', { class: 'sm-sub' }, [worker.empId || 'no ID', worker.stations.map((st) => st.code).filter(Boolean).join(', ')].filter(Boolean).join(' · ')),
          ),
          ...types.map(([type]) => h('td', { class: 'sm-cell' }, cellButton(worker, type))),
        );
      }),
    ),
  );

  refreshBar();
  const pageNode = ctx.page(
    ctx.pageHead('Workers'),
    tabs,
    h('div', { class: 'workers-toolbar' }, search, zoneSelect, groupSelect, h('span', { class: 'field-hint' }, `${rows.length} workers`)),
    canWrite
      ? h('div', { class: 'workers-bulk' }, selectedNote, h('span', {}, 'Set'), bulkSkill, h('span', {}, 'to'), bulkLevel, bulkApply)
      : h('p', { class: 'field-hint' }, 'View only: your role cannot change skills.'),
    // A <form>: app.js does not re-render over it while you edit (sync updates wait).
    h('form', { class: 'skill-matrix-wrap', novalidate: true, onsubmit: (event) => event.preventDefault() }, table),
    h('p', { class: 'skill-legend field-hint' }, h('span', { class: 'skill-cell-btn lv-expert' }, 'E'), ' Expert ', h('span', { class: 'skill-cell-btn lv-good' }, 'G'), ' Good ', h('span', { class: 'skill-cell-btn lv-learning' }, 'L'), ' Learning'),
    canWrite ? saveBar : null,
  );
  pageNode.classList.add('fit-page', 'workers-fit');
  return pageNode;
}

async function saveBatch(ctx, roster) {
  const byKey = new Map(roster.map((w) => [w.key, w]));
  let saved = 0;
  const failed = [];
  for (const [key, staged] of [...batch.changes]) {
    const worker = byKey.get(key);
    if (!worker || !worker.empId) continue;
    let skills = worker.profile || {};
    for (const [type, level] of staged) skills = { ...skills, ...withSkill(skills, type, level) };
    const record = {
      ...(worker.profile || { id: newRecordId(), createdAt: ctx.nowISO(), name: worker.name || '' }),
      empId: worker.empId,
      skillsExpert: skills.skillsExpert || [],
      skillsGood: skills.skillsGood || [],
      skillsLearning: skills.skillsLearning || [],
      updatedAt: ctx.nowISO(),
    };
    delete record.pendingSync;
    try {
      await sync.saveRecord('workerProfiles', record, worker.profile ? worker.profile.version : null);
      batch.changes.delete(key);
      saved += 1;
    } catch (error) {
      console.error(error);
      failed.push(worker.name || worker.empId);
    }
  }
  await ctx.refreshState();
  ctx.toast(failed.length ? `Saved ${saved} workers; not saved: ${failed.join(', ')}` : `Saved skills for ${saved} worker${saved === 1 ? '' : 's'}.`, failed.length ? 'warn' : undefined);
  ctx.render();
}
