// QC records page (#/qc): quality checks of each worker's output — pieces
// checked, defects and their kinds, the result. A per-worker summary for a
// period (worst defect rate first), the recent checks, a fast entry form and
// each worker's QC history. Records are the `qcRecords` store (floorMap
// area), kept by employee ID like the skills profiles.

import { QC_DEFECT_TYPES, qcSuggestedResult, qcSummary, SKILL_GROUPS, workerRoster } from './logic-map.js';
import { newRecordId } from './logic-ids.js';
import { showPanelWithBody } from './map.js';
import * as sync from './sync.js';

const PERIODS = [
  [7, 'Last 7 days'],
  [30, 'Last 30 days'],
  [90, 'Last 90 days'],
  [365, 'Last year'],
];
const RESULT_LABEL = { pass: 'Pass', rework: 'Rework', fail: 'Fail' };
const RESULT_CLASS = { pass: 'status-done', rework: 'status-in-progress', fail: 'status-down' };
const INSPECTOR_KEY = 'qc-inspector';

const view = { days: 30, search: '' };

/** Style and PO of the last saved record, offered on the next one (same order, many workers). */
const carry = { style: '', po: '' };

const empKey = (value) => String(value ?? '').toUpperCase().replace(/\s+/g, '');

function sinceIso(ctx, days) {
  const d = new Date(`${ctx.todayISO()}T00:00:00`);
  d.setDate(d.getDate() - days + 1);
  return d.toISOString().slice(0, 10);
}

const resultPill = (h, result) => h('span', { class: `pill ${RESULT_CLASS[result] || ''}` }, RESULT_LABEL[result] || result);

export function renderQcPage(ctx) {
  const { h } = ctx;
  ctx.setTitle('QC records');
  const canWrite = ctx.can('floorMap', 'write');
  const records = (ctx.state.qcRecords || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const roster = workerRoster(ctx.state.floorStations || [], ctx.state.workerProfiles || []);
  const since = sinceIso(ctx, view.days);
  const inPeriod = records.filter((r) => String(r.date) >= since);
  const needle = view.search.trim().toLowerCase();
  const matches = (r) => !needle || [r.empId, r.workerName, r.stationCode, r.style, r.po, r.operation, r.inspector].some((v) => String(v || '').toLowerCase().includes(needle));
  const summary = qcSummary(inPeriod.filter(matches));

  const totals = inPeriod.reduce((t, r) => ({ checked: t.checked + (Number(r.checked) || 0), defects: t.defects + (Number(r.defects) || 0), fails: t.fails + (r.result === 'fail' ? 1 : 0) }), { checked: 0, defects: 0, fails: 0 });
  const tile = (value, label, alert) => h('div', { class: `counter${alert ? ' is-alert' : ''}` }, h('span', { class: 'counter-value' }, value), h('span', { class: 'counter-label' }, label));

  const period = h('select', { 'aria-label': 'Period' }, ...PERIODS.map(([days, label]) => h('option', { value: String(days) }, label)));
  period.value = String(view.days);
  period.addEventListener('change', () => {
    view.days = Number(period.value);
    ctx.render();
  });
  const search = ctx.searchBox('Search worker, style, PO, operation, inspector', (value) => {
    view.search = value;
    ctx.render();
  });
  search.querySelector('input').value = view.search;

  const workerTable = summary.length
    ? h(
        'div',
        { class: 'table-scroll workers-wrap' },
        h(
          'table',
          { class: 'stats-table qc-table' },
          h('thead', {}, h('tr', {}, ...['Worker', 'ID', 'Checks', 'Pieces', 'Defects', 'Defect rate', 'Last result', 'Common defects'].map((l) => h('th', { scope: 'col' }, l)))),
          h(
            'tbody',
            {},
            ...summary.map((s) => {
              const worker = roster.find((w) => empKey(w.empId) === empKey(s.empId));
              const name = (worker && worker.name) || s.workerName || s.empId;
              return h(
                'tr',
                {},
                h('th', { scope: 'row' }, h('button', { class: 'link-button', type: 'button', onclick: () => showWorkerQc(ctx, s.empId) }, name)),
                h('td', { class: 'tabular' }, s.empId),
                h('td', { class: 'tabular' }, String(s.checks)),
                h('td', { class: 'tabular' }, String(s.checked)),
                h('td', { class: 'tabular' }, String(s.defects)),
                h('td', { class: `tabular qc-rate${s.rate > 5 ? ' is-bad' : s.rate > 2 ? ' is-warn' : ''}` }, `${s.rate}%`),
                h('td', {}, resultPill(h, s.last.result), h('span', { class: 'muted' }, ` ${s.last.date}`)),
                h('td', {}, s.topKinds.join(', ') || '—'),
              );
            }),
          ),
        ),
      )
    : h('p', { class: 'muted' }, needle ? 'No QC record matches.' : 'No QC records in this period yet.');

  const recent = inPeriod.filter(matches).slice(0, 40);
  const recentList = recent.length
    ? h(
        'div',
        { class: 'list' },
        ...recent.map((r) =>
          h(
            'button',
            { class: 'row qc-row', type: 'button', onclick: () => (canWrite ? showQcForm(ctx, r) : showWorkerQc(ctx, r.empId)) },
            h(
              'div',
              { class: 'row-main' },
              h('div', { class: 'row-title' }, `${r.workerName || r.empId} · ${r.operation || 'QC check'}`),
              h('div', { class: 'row-sub' }, [r.date, r.stationCode, r.style && `Style ${r.style}`, r.po && `PO ${r.po}`, `${r.defects || 0} defects in ${r.checked}`, r.inspector && `by ${r.inspector}`].filter(Boolean).join(' · ')),
            ),
            h('div', { class: 'row-side' }, resultPill(h, r.result)),
            h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'),
          ),
        ),
      )
    : null;

  return ctx.page(
    ctx.pageHead('QC records', canWrite ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => showQcForm(ctx) }, '+ Record QC') : null),
    h(
      'div',
      { class: 'counters qc-counters' },
      tile(String(inPeriod.length), 'QC checks'),
      tile(String(totals.checked), 'Pieces checked'),
      tile(`${totals.checked ? Math.round((totals.defects / totals.checked) * 1000) / 10 : 0}%`, 'Defect rate', totals.checked && totals.defects / totals.checked > 0.05),
      tile(String(totals.fails), 'Failed checks', totals.fails > 0),
    ),
    h('div', { class: 'workers-toolbar' }, search, period),
    h('h3', { class: 'section-title' }, 'By worker (worst defect rate first)'),
    workerTable,
    recentList ? h('h3', { class: 'section-title' }, 'Recent checks') : null,
    recentList,
  );
}

/** One worker's QC history in the side panel, with "Record QC" for writers. */
export function showWorkerQc(ctx, empId) {
  const { h } = ctx;
  const roster = workerRoster(ctx.state.floorStations || [], ctx.state.workerProfiles || []);
  const worker = roster.find((w) => empKey(w.empId) === empKey(empId));
  const records = (ctx.state.qcRecords || []).filter((r) => empKey(r.empId) === empKey(empId)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const [all] = qcSummary(records);
  const name = (worker && worker.name) || (records[0] && records[0].workerName) || empId;
  const body = h(
    'div',
    { class: 'fm-panel qc-history' },
    all
      ? h('p', {}, h('strong', {}, `${all.rate}% defects`), ` over ${all.checked} pieces in ${all.checks} checks (all time) · ${all.fails} failed`)
      : h('p', { class: 'muted' }, 'No QC records for this worker yet.'),
    ...records.slice(0, 60).map((r) =>
      h(
        'div',
        { class: 'card qc-history-item' },
        h('div', { class: 'qc-history-head' }, h('strong', {}, `${r.date} · ${r.operation || 'QC check'}`), resultPill(h, r.result)),
        h('p', { class: 'field-hint' }, `${[r.style && `Style ${r.style}`, r.po && `PO ${r.po}`].filter(Boolean).join(' · ')}${r.style || r.po ? ' · ' : ''}${r.defects || 0} defects in ${r.checked}${(r.defectTypes || []).length ? ` · ${r.defectTypes.join(', ')}` : ''}${r.inspector ? ` · by ${r.inspector}` : ''}`),
        r.notes ? h('p', { class: 'qc-notes' }, r.notes) : null,
        ctx.can('floorMap', 'write') ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => showQcForm(ctx, r) }, 'Edit') : null,
      ),
    ),
    ctx.can('floorMap', 'write')
      ? h('div', { class: 'worker-save-bar' }, h('button', { class: 'btn btn-primary worker-save', type: 'button', onclick: () => showQcForm(ctx, null, worker || { empId, name }) }, 'Record QC for this worker'))
      : null,
  );
  showPanelWithBody(ctx, `QC · ${empId} ${name}`, body);
}

/** New or edit QC record. `preset` = a roster worker to start with. */
export function showQcForm(ctx, record = null, preset = null) {
  const { h } = ctx;
  const roster = workerRoster(ctx.state.floorStations || [], ctx.state.workerProfiles || []).filter((w) => w.empId);
  const listId = `qc-workers-${Math.random().toString(16).slice(2, 8)}`;
  const label = (w) => `${w.empId} — ${w.name || ''}`.trim();
  const workers = h('datalist', { id: listId }, ...roster.map((w) => h('option', { value: label(w) })));
  const initial = record ? roster.find((w) => empKey(w.empId) === empKey(record.empId)) || { empId: record.empId, name: record.workerName, stations: [] } : preset;
  const who = h('input', { type: 'text', list: listId, autocomplete: 'off', placeholder: 'Type ID or name', value: initial ? label(initial) : '' });
  const station = h('input', { type: 'text', maxlength: '40', value: record ? record.stationCode || '' : initial && initial.stations && initial.stations[0] ? initial.stations[0].code || '' : '' });
  const pick = () => {
    const raw = who.value.trim().toLowerCase();
    if (!raw) return null;
    const idPart = empKey(raw.split('—')[0]);
    return roster.find((w) => empKey(w.empId) === idPart) || roster.find((w) => label(w).toLowerCase() === raw) || (roster.filter((w) => label(w).toLowerCase().includes(raw)).length === 1 ? roster.find((w) => label(w).toLowerCase().includes(raw)) : null);
  };
  who.addEventListener('change', () => {
    const w = pick();
    if (w) {
      who.value = label(w);
      if (!station.value && w.stations[0]) station.value = w.stations[0].code || '';
    }
  });
  const date = h('input', { type: 'date', value: record ? record.date : ctx.todayISO() });
  const style = h('input', { type: 'text', maxlength: '40', autocomplete: 'off', placeholder: 'e.g. 3084WT', value: record ? record.style || '' : carry.style });
  const po = h('input', { type: 'text', maxlength: '40', autocomplete: 'off', inputmode: 'text', placeholder: 'e.g. 110115', value: record ? record.po || '' : carry.po });
  const opsId = `qc-ops-${Math.random().toString(16).slice(2, 8)}`;
  const opNames = [...new Set([...SKILL_GROUPS.flatMap((g) => g.options.map(([, l]) => l)), ...(ctx.state.qcRecords || []).map((r) => r.operation).filter(Boolean)])];
  const operation = h('input', { type: 'text', list: opsId, maxlength: '80', placeholder: 'e.g. Binder – collar', value: record ? record.operation || '' : '' });
  const ops = h('datalist', { id: opsId }, ...opNames.map((o) => h('option', { value: o })));
  const num = (value) => h('input', { type: 'number', min: '0', step: '1', inputmode: 'numeric', value: value === undefined || value === null ? '' : String(value) });
  const checked = num(record ? record.checked : '');
  const defects = num(record ? record.defects : 0);

  const chosen = new Set(record ? record.defectTypes || [] : []);
  const chips = QC_DEFECT_TYPES.map((kind) => {
    const chip = h('button', { class: `chip${chosen.has(kind) ? ' is-active' : ''}`, type: 'button', 'aria-pressed': String(chosen.has(kind)) }, kind);
    chip.addEventListener('click', () => {
      if (chosen.has(kind)) chosen.delete(kind);
      else chosen.add(kind);
      chip.classList.toggle('is-active', chosen.has(kind));
      chip.setAttribute('aria-pressed', String(chosen.has(kind)));
    });
    return chip;
  });

  // The result follows the defect rate until the inspector picks one.
  const result = h('select', {}, ...Object.entries(RESULT_LABEL).map(([v, l]) => h('option', { value: v }, l)));
  result.value = record ? record.result : 'pass';
  let resultTouched = Boolean(record);
  result.addEventListener('change', () => {
    resultTouched = true;
  });
  const rateNote = h('span', { class: 'field-hint' });
  const syncResult = () => {
    const c = Number(checked.value);
    const d = Number(defects.value) || 0;
    rateNote.textContent = c > 0 ? `Defect rate ${Math.round((d / c) * 1000) / 10}%` : '';
    if (!resultTouched && c > 0) result.value = qcSuggestedResult(c, d);
  };
  checked.addEventListener('input', syncResult);
  defects.addEventListener('input', syncResult);
  syncResult();

  let rememberedInspector = '';
  try {
    rememberedInspector = localStorage.getItem(INSPECTOR_KEY) || '';
  } catch {
    rememberedInspector = '';
  }
  const inspector = h('input', { type: 'text', maxlength: '80', value: record ? record.inspector || '' : rememberedInspector });
  const notes = h('textarea', { maxlength: '500', rows: '2' });
  notes.value = record ? record.notes || '' : '';
  const error = h('p', { class: 'form-error', role: 'alert' });
  const save = h('button', { class: 'btn btn-primary worker-save', type: 'submit' }, record ? 'Save changes' : 'Save QC record');

  const form = h(
    'form',
    { class: 'fm-panel worker-form qc-form', novalidate: true },
    workers,
    ops,
    ctx.field('Worker', who),
    h('div', { class: 'fm-inspect-row' }, ctx.field('Date', date), ctx.field('Station', station)),
    h('div', { class: 'fm-inspect-row' }, ctx.field('Style (optional)', style), ctx.field('PO (optional)', po)),
    ctx.field('Operation', operation),
    h('div', { class: 'fm-inspect-row' }, ctx.field('Pieces checked', checked), ctx.field('Defects found', defects)),
    rateNote,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Defect types'), h('div', { class: 'fm-inspect-chips' }, ...chips)),
    h('div', { class: 'fm-inspect-row' }, ctx.field('Result', result), ctx.field('Inspector', inspector)),
    ctx.field('Notes', notes),
    error,
    record
      ? h('button', { class: 'btn btn-small btn-danger', type: 'button', onclick: async () => {
          if (!(await ctx.showConfirm({ title: 'Delete this QC record?', message: `${record.date} · ${record.workerName || record.empId}`, confirmText: 'Delete', danger: true }))) return;
          try {
            await sync.deleteRecord('qcRecords', record.id, record.version);
            await ctx.refreshState();
            ctx.toast('QC record deleted.');
            ctx.render();
            showWorkerQc(ctx, record.empId);
          } catch (err) {
            console.error(err);
            ctx.toast('Could not delete the record.', 'warn');
          }
        } }, 'Delete record')
      : null,
    h('div', { class: 'worker-save-bar' }, save),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const w = pick();
    const typedId = who.value.split('—')[0].trim();
    const empId = w ? w.empId : typedId;
    const c = Math.round(Number(checked.value));
    const d = Math.round(Number(defects.value) || 0);
    if (!empId) return void (error.textContent = 'Pick the worker (ID or name).');
    if (!(c >= 1)) return void (error.textContent = 'Enter how many pieces were checked.');
    if (d < 0 || d > c) return void (error.textContent = 'Defects must be between 0 and the pieces checked.');
    if (!date.value) return void (error.textContent = 'Pick the date.');
    const next = {
      ...(record || { id: newRecordId(), createdAt: ctx.nowISO() }),
      date: date.value,
      empId,
      workerName: w ? w.name || '' : record ? record.workerName || '' : '',
      stationCode: station.value.trim(),
      style: style.value.trim(),
      po: po.value.trim(),
      operation: operation.value.trim(),
      checked: c,
      defects: d,
      defectTypes: [...chosen],
      result: result.value,
      inspector: inspector.value.trim(),
      notes: notes.value.trim(),
      updatedAt: ctx.nowISO(),
    };
    delete next.pendingSync;
    save.disabled = true;
    try {
      await sync.saveRecord('qcRecords', next, record ? record.version : null);
      carry.style = next.style;
      carry.po = next.po;
      try {
        localStorage.setItem(INSPECTOR_KEY, next.inspector);
      } catch {
        // only a convenience
      }
      await ctx.refreshState();
      ctx.toast(`QC saved: ${next.workerName || next.empId}, ${d} defects in ${c}.`);
      ctx.render();
      if (record) showWorkerQc(ctx, empId);
      else showQcForm(ctx); // ready for the next worker
    } catch (err) {
      console.error(err);
      save.disabled = false;
      error.textContent = 'Could not save the record. Please try again.';
    }
  });
  showPanelWithBody(ctx, record ? 'Edit QC record' : 'Record QC', form);
}

