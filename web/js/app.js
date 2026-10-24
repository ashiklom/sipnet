// SIPNET WebAssembly runner: configure inputs, run SIPNET in a worker, save
// runs to IndexedDB, and compare saved runs.

import { LineChart, fmtValue } from './chart.js';
import {
  FLAGS, aggregate, buildConfig, flagConflicts, hashText, parseConfigFlags,
  parseOutput, parseParamFile, serializeParamFile,
} from './sipnet-io.js';
import * as store from './storage.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
};

const MAX_COMPARE = 8;
const SERIES_VARS = Array.from({ length: MAX_COMPARE }, (_, i) => `--series-${i + 1}`);
const UPLOAD = '__upload__';

const state = {
  examples: [],
  paramInfo: {},
  outputInfo: {},
  site: null,  // { kind, id, label, clim, paramText, eventsText, flags, summary }
  parsedParams: null,
  baseValues: {},
  values: {},
  flags: {},
  runs: [],
  selected: new Map(),  // run id -> color slot; insertion order = selection order
  outputs: new Map(),  // run id -> parsed sipnet.out
  version: '',
};

// ---------------------------------------------------------------------------
// Worker

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextMsg = 1;
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.ok) p.resolve(data); else p.reject(new Error(data.error));
};
worker.onerror = (e) => {
  e.preventDefault?.();
  showBanner('Could not load the SIPNET WebAssembly module (web/sipnet.mjs, web/sipnet.wasm). '
    + "Build it with 'make wasm-site' and serve this directory over HTTP (see docs/web-assembly.md).");
  for (const p of pending.values()) p.reject(new Error('worker failed to load'));
  pending.clear();
};
const callWorker = (msg) => new Promise((resolve, reject) => {
  const id = nextMsg++;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, ...msg });
});

function showBanner(text) {
  const b = $('#banner');
  b.textContent = text;
  b.hidden = false;
}

// ---------------------------------------------------------------------------
// Inputs

async function fetchText(url, optional = false) {
  const r = await fetch(url);
  if (!r.ok) {
    if (optional) return '';
    throw new Error(`${url}: ${r.status} ${r.statusText}`);
  }
  return r.text();
}

async function fetchJson(url) {
  try {
    const r = await fetch(url);
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

function climSummary(clim) {
  const lines = clim.split('\n').filter((l) => l.trim() && !l.trim().startsWith('!'));
  if (!lines.length) return 'empty climate file';
  const yearOf = (l) => {
    const f = l.trim().split(/\s+/);
    return f[f.length >= 14 ? 1 : 0];
  };
  return `${lines.length.toLocaleString()} climate steps, ${yearOf(lines[0])}–${yearOf(lines[lines.length - 1])}`;
}

const countEvents = (text) => text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('!')).length;

async function loadExample(id) {
  const ex = state.examples.find((e) => e.id === id);
  if (!ex) throw new Error(`unknown example ${id}`);
  const base = `examples/${ex.id}/`;
  const [config, paramText, clim, eventsText] = await Promise.all([
    fetchText(`${base}sipnet.in`, true),
    fetchText(`${base}sipnet.param`),
    fetchText(`${base}sipnet.clim`),
    fetchText(`${base}events.in`, true),
  ]);
  setSite({
    kind: 'example', id: ex.id, label: ex.name, description: ex.description,
    clim, paramText, eventsText, flags: parseConfigFlags(config),
  });
}

async function loadUploadBundle(hash) {
  const rec = await store.getInput(hash);
  if (!rec) throw new Error('The uploaded inputs for this run are no longer stored in this browser');
  setSite({
    kind: 'upload', id: hash, label: rec.label, description: 'Uploaded input files',
    clim: rec.clim, paramText: rec.paramText, eventsText: rec.eventsText,
    flags: parseConfigFlags(rec.config),
  });
}

async function onUpload() {
  const read = async (sel) => {
    const f = $(sel).files[0];
    return f ? f.text() : null;
  };
  const [paramText, clim, eventsText, config] = await Promise.all(
    ['#up-param', '#up-clim', '#up-events', '#up-config'].map(read));
  if (!paramText || !clim) {
    alert('Please choose at least a parameter file and a climate file.');
    return;
  }
  const label = $('#up-name').value.trim() || $('#up-clim').files[0].name.replace(/\.clim$/, '');
  const rec = { label, paramText, clim, eventsText: eventsText || '', config: config || '' };
  rec.hash = hashText(JSON.stringify([rec.paramText, rec.clim, rec.eventsText, rec.config]));
  await store.saveInput(rec);
  await loadUploadBundle(rec.hash);
}

function setSite(site) {
  site.summary = `${climSummary(site.clim)}; ${countEvents(site.eventsText)} events`;
  state.site = site;
  state.parsedParams = parseParamFile(site.paramText);
  state.baseValues = Object.fromEntries(state.parsedParams.params.map((p) => [p.name, p.value]));
  state.values = { ...state.baseValues };
  state.flags = { ...site.flags };
  $('#events-text').value = site.eventsText;

  const sel = $('#site-select');
  if (site.kind === 'upload' && ![...sel.options].some((o) => o.value === `upload:${site.id}`)) {
    sel.insertBefore(el('option', { value: `upload:${site.id}`, textContent: `${site.label} (uploaded)` }),
      sel.querySelector(`option[value="${UPLOAD}"]`));
  }
  sel.value = site.kind === 'example' ? site.id : `upload:${site.id}`;
  $('#upload-panel').hidden = true;
  $('#site-summary').textContent = site.summary;
  $('#site-description').textContent = site.description || '';
  renderFlags();
  renderParams();
  updateEventsSummary();
  suggestRunName();
}

// ---------------------------------------------------------------------------
// Model options and parameters

function renderFlags() {
  const box = $('#flags');
  box.replaceChildren(...FLAGS.map((f) => {
    const cb = el('input', { type: 'checkbox', checked: !!state.flags[f.name] });
    cb.addEventListener('change', () => {
      state.flags[f.name] = cb.checked ? 1 : 0;
      renderFlags();
    });
    const label = el('label', { title: `${f.help} (${f.name})` }, cb, f.label);
    if (state.flags[f.name] !== state.site.flags[f.name]) label.classList.add('changed');
    return label;
  }));
  $('#flag-errors').replaceChildren(...flagConflicts(state.flags).map((e) => el('li', { textContent: e })));
}

const isNumber = (s) => s.trim() !== '' && Number.isFinite(Number(s));
const sameValue = (a, b) => a === b || (isNumber(a) && isNumber(b) && Number(a) === Number(b));

function changedParams() {
  return state.parsedParams.params
    .filter((p) => !sameValue(state.values[p.name], state.baseValues[p.name]))
    .map((p) => ({ name: p.name, base: state.baseValues[p.name], value: state.values[p.name] }));
}

function pctChange(base, value) {
  const b = Number(base);
  const v = Number(value);
  if (!isNumber(String(value)) || sameValue(String(base), String(value))) return '';
  if (b === 0) return v > 0 ? '+∞' : '−∞';
  const pct = ((v - b) / Math.abs(b)) * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
}

// Parameters grouped as in docs/parameters.md (file order within a group);
// undocumented parameters go last
function sortedParams() {
  const groups = [...new Set(Object.values(state.paramInfo).map((i) => i.group))];
  const rank = (p) => {
    const g = groups.indexOf(state.paramInfo[p.name]?.group);
    return g < 0 ? groups.length : g;
  };
  return state.parsedParams.params
    .map((p, i) => ({ p, i, r: rank(p) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ p }) => p);
}

function renderParams() {
  const tbody = $('#param-table tbody');
  const filter = $('#param-filter').value.trim().toLowerCase();
  const changedOnly = $('#changed-only').checked;
  const rows = [];
  let lastGroup = null;
  for (const p of sortedParams()) {
    const info = state.paramInfo[p.name] || {};
    const value = state.values[p.name];
    const changed = !sameValue(value, state.baseValues[p.name]);
    if (changedOnly && !changed) continue;
    if (filter && !`${p.name} ${info.description || ''} ${info.group || ''}`.toLowerCase().includes(filter)) continue;
    const group = info.group || 'Other parameters';
    if (group !== lastGroup) {
      rows.push(el('tr', { className: 'group' }, el('td', { colSpan: 6, textContent: group })));
      lastGroup = group;
    }
    const input = el('input', { className: 'value', value, type: 'text', inputMode: 'decimal' });
    input.setAttribute('aria-label', `Value of ${p.name}`);
    const changeCell = el('td', { className: 'num', textContent: pctChange(state.baseValues[p.name], value) });
    const tr = el('tr', {},
      el('td', {}, el('code', { textContent: p.name })),
      el('td', { className: 'desc', textContent: info.description || '' }),
      el('td', { className: 'units', textContent: info.units || '' }),
      el('td', { className: 'num', textContent: state.baseValues[p.name] }),
      el('td', { className: 'num' }, input),
      changeCell);
    tr.classList.toggle('changed', changed);
    input.addEventListener('input', () => {
      state.values[p.name] = input.value.trim();
      input.classList.toggle('invalid', !isNumber(input.value));
      tr.classList.toggle('changed', !sameValue(state.values[p.name], state.baseValues[p.name]));
      changeCell.textContent = pctChange(state.baseValues[p.name], state.values[p.name]);
      updateParamSummary();
    });
    rows.push(tr);
  }
  if (!rows.length) {
    rows.push(el('tr', {}, el('td', { colSpan: 6, className: 'subtle', textContent: 'No matching parameters' })));
  }
  tbody.replaceChildren(...rows);
  updateParamSummary();
}

function updateParamSummary() {
  const n = changedParams().length;
  $('#param-summary').textContent = `${state.parsedParams.params.length} parameters`
    + (n ? `, ${n} changed` : '');
}

function updateEventsSummary() {
  const text = $('#events-text').value;
  const n = countEvents(text);
  const edited = text !== state.site.eventsText ? ' (edited)' : '';
  $('#events-summary').textContent = `${n} event${n === 1 ? '' : 's'}${edited}`;
}

function suggestRunName() {
  const n = state.runs.filter((r) => r.site.label === state.site.label).length + 1;
  $('#run-name').value = `${state.site.label} #${n}`;
}

// ---------------------------------------------------------------------------
// Running

async function onRun() {
  const status = $('#run-status');
  const fail = (msg) => {
    status.className = 'error';
    status.textContent = msg;
  };
  if (!state.site) return fail('Load input files first');
  const conflicts = flagConflicts(state.flags);
  if (conflicts.length) return fail(`Fix model options first: ${conflicts.join('; ')}`);
  const bad = state.parsedParams.params.filter((p) => !isNumber(state.values[p.name]));
  if (bad.length) return fail(`Invalid value for ${bad.map((p) => p.name).join(', ')}`);

  const eventsText = $('#events-text').value;
  const paramText = serializeParamFile(state.parsedParams, state.values);
  const files = {
    'sipnet.in': buildConfig(state.flags),
    'sipnet.param': paramText,
    'sipnet.clim': state.site.clim,
    'events.in': eventsText,
  };

  const btn = $('#run-btn');
  btn.disabled = true;
  status.className = '';
  status.textContent = 'Running…';
  try {
    const t0 = performance.now();
    const r = await callWorker({ type: 'run', files });
    const wallMs = performance.now() - t0;
    $('#run-log').textContent = r.log;
    if (r.exitCode !== 0 || !r.outputs['sipnet.out']) {
      $('#log-wrap').open = true;
      return fail(`SIPNET failed (exit code ${r.exitCode}); see the log below`);
    }
    const out = parseOutput(r.outputs['sipnet.out']);
    const meta = {
      name: $('#run-name').value.trim() || `Run ${new Date().toLocaleString()}`,
      created: Date.now(),
      site: { kind: state.site.kind, id: state.site.id, label: state.site.label },
      flags: { ...state.flags },
      siteFlags: { ...state.site.flags },
      params: { ...state.values },
      changed: changedParams(),
      eventsEdited: eventsText !== state.site.eventsText,
      eventsText,
      paramText,
      runMs: r.runMs,
      steps: out.n,
      version: state.version,
    };
    const id = await store.saveRun(meta, {
      out: r.outputs['sipnet.out'],
      eventsOut: r.outputs['events.out'] || '',
      config: r.outputs['sipnet.config'] || '',
      log: r.log,
    });
    state.outputs.set(id, out);
    status.className = 'ok';
    status.textContent = `Done: ${out.n.toLocaleString()} steps in ${r.runMs.toFixed(0)} ms `
      + `(${wallMs.toFixed(0)} ms including setup). Saved as “${meta.name}”.`;
    await refreshRuns();
    if (state.selected.size < MAX_COMPARE) toggleSelected(id, true);
    suggestRunName();
  } catch (e) {
    fail(`Error: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Saved runs

async function refreshRuns() {
  state.runs = (await store.listRuns()).sort((a, b) => b.created - a.created);
  for (const id of [...state.selected.keys()]) {
    if (!state.runs.some((r) => r.id === id)) state.selected.delete(id);
  }
  renderRuns();
  renderCompare();
  updateStorageInfo();
}

async function updateStorageInfo() {
  if (!navigator.storage?.estimate) return;
  const { usage, quota } = await navigator.storage.estimate();
  const mb = (b) => (b / 1e6).toFixed(1);
  $('#storage-info').textContent = `${state.runs.length} saved; using ${mb(usage)} MB of ${mb(quota)} MB`;
}

function describeChanges(run) {
  const parts = run.changed.map((c) => `${c.name}: ${c.base} → ${c.value}`);
  for (const f of FLAGS) {
    if (run.flags[f.name] !== run.siteFlags[f.name]) parts.push(`${f.label} ${run.flags[f.name] ? 'on' : 'off'}`);
  }
  if (run.eventsEdited) parts.push('events edited');
  if (!parts.length) return 'none';
  return parts.length > 3 ? `${parts.slice(0, 3).join('; ')}; +${parts.length - 3} more` : parts.join('; ');
}

function download(name, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const safeName = (s) => s.replace(/[^\w.-]+/g, '_');

// CSS custom property holding the color for a selection slot
const seriesColor = (slot) => SERIES_VARS[slot];

function renderRuns() {
  const tbody = $('#runs-table tbody');
  $('#runs-empty').hidden = state.runs.length > 0;
  tbody.replaceChildren(...state.runs.map((run) => {
    const selected = state.selected.has(run.id);
    const cb = el('input', { type: 'checkbox', checked: selected });
    cb.setAttribute('aria-label', `Compare ${run.name}`);
    cb.addEventListener('change', () => toggleSelected(run.id, cb.checked));
    const key = el('span', { className: 'line-key' });
    if (selected) key.style.background = `var(${seriesColor(state.selected.get(run.id))})`;

    const btn = (label, title, fn) => {
      const b = el('button', { type: 'button', className: 'small', textContent: label, title });
      b.addEventListener('click', fn);
      return b;
    };
    const actions = el('td', { className: 'actions' },
      btn('Load', 'Load this run\'s inputs into the editor above', () => loadRunIntoEditor(run)),
      btn('Rename', 'Rename this run', async () => {
        const name = prompt('New name for this run', run.name);
        if (name && name.trim()) {
          await store.updateRun(run.id, { name: name.trim() });
          await refreshRuns();
        }
      }),
      btn('.out', 'Download sipnet.out', async () => {
        download(`${safeName(run.name)}.out`, (await store.getOutput(run.id)).out);
      }),
      btn('.param', 'Download the parameter file used', () => {
        download(`${safeName(run.name)}.param`, run.paramText);
      }),
      btn('Delete', 'Delete this run', async () => {
        if (!confirm(`Delete run “${run.name}”?`)) return;
        await store.deleteRun(run.id);
        state.outputs.delete(run.id);
        await refreshRuns();
      }));

    return el('tr', {},
      el('td', {}, el('label', { className: 'inline' }, cb, key)),
      el('td', { textContent: run.name }),
      el('td', { textContent: run.site.label }),
      el('td', { textContent: new Date(run.created).toLocaleString() }),
      el('td', { className: 'desc', textContent: describeChanges(run) }),
      el('td', { className: 'num', textContent: `${run.runMs.toFixed(0)} ms` }),
      actions);
  }));
}

function toggleSelected(id, on) {
  if (on && !state.selected.has(id)) {
    if (state.selected.size >= MAX_COMPARE) {
      alert(`At most ${MAX_COMPARE} runs can be compared at once.`);
      renderRuns();
      return;
    }
    // Lowest free color slot; a run keeps its color while it stays selected
    const used = new Set(state.selected.values());
    let slot = 0;
    while (used.has(slot)) slot++;
    state.selected.set(id, slot);
  } else if (!on) {
    state.selected.delete(id);
  }
  localStorage.setItem('sipnet-selected', JSON.stringify([...state.selected]));
  renderRuns();
  renderCompare();
}

async function loadRunIntoEditor(run) {
  try {
    if (run.site.kind === 'example') await loadExample(run.site.id);
    else await loadUploadBundle(run.site.id);
  } catch (e) {
    alert(e.message);
    return;
  }
  for (const [k, v] of Object.entries(run.params)) {
    if (k in state.values) state.values[k] = v;
  }
  state.flags = { ...run.flags };
  $('#events-text').value = run.eventsText;
  renderFlags();
  renderParams();
  updateEventsSummary();
  $('#run-name').value = `${run.name} (copy)`;
  $('#h-inputs').scrollIntoView({ behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Comparison

let chart;
let compareToken = 0;

async function getParsedOutput(id) {
  if (!state.outputs.has(id)) {
    const rec = await store.getOutput(id);
    state.outputs.set(id, parseOutput(rec.out));
  }
  return state.outputs.get(id);
}

function renderVarOptions(columns) {
  const sel = $('#cmp-var');
  const current = sel.value || localStorage.getItem('sipnet-cmp-var') || 'cumNEE';
  const vars = columns.filter((c) => !['year', 'day', 'time'].includes(c));
  sel.replaceChildren(...vars.map((v) => {
    const info = state.outputInfo[v];
    return el('option', { value: v, textContent: info?.units ? `${v} (${info.units})` : v });
  }));
  sel.value = vars.includes(current) ? current : vars[0];
}

async function renderCompare() {
  const token = ++compareToken;
  const ids = [...state.selected.keys()];
  const runs = ids.map((id) => state.runs.find((r) => r.id === id)).filter(Boolean);
  const outs = await Promise.all(runs.map((r) => getParsedOutput(r.id)));
  if (token !== compareToken) return;  // a newer render started meanwhile

  const columns = [...new Set(outs.flatMap((o) => o.columns))];
  if (columns.length) renderVarOptions(columns);
  const variable = $('#cmp-var').value;
  const period = $('#cmp-period').value;
  const stat = $('#cmp-stat').value;
  const mode = $('#cmp-mode').value;
  const info = state.outputInfo[variable] || {};
  $('#cmp-var-desc').textContent = variable && info.description ? `${variable}: ${info.description}` : '';

  let series = runs.map((run, i) => ({
    run,
    label: run.name,
    color: seriesColor(state.selected.get(run.id)),
    ...(outs[i].data[variable] ? aggregate(outs[i], variable, period, stat) : { x: new Float64Array(), y: new Float64Array() }),
  }));

  let yLabel = variable ? `${variable}${info.units ? ` (${info.units})` : ''}` : '';
  if (period !== 'none' && variable) yLabel = `${period}ly ${stat} of ${yLabel}`.replace('dayly', 'daily');
  if (mode === 'diff' && series.length >= 2) {
    // Difference from the first selected run, matched on time
    const ref = series[0];
    const refAt = new Map();
    ref.x.forEach((x, i) => refAt.set(x.toFixed(6), ref.y[i]));
    series = series.slice(1).map((s) => {
      const xs = [];
      const ys = [];
      s.x.forEach((x, i) => {
        const r = refAt.get(x.toFixed(6));
        if (r !== undefined) {
          xs.push(x);
          ys.push(s.y[i] - r);
        }
      });
      return { ...s, label: `${s.label} − ${ref.label}`, x: Float64Array.from(xs), y: Float64Array.from(ys) };
    });
    yLabel = `Δ ${yLabel}`;
  }

  chart.setData({
    series,
    yLabel,
    period,
    emptyText: runs.length === 0 ? 'Tick saved runs above to compare them'
      : (mode === 'diff' && runs.length < 2 ? 'Select at least two runs to show differences' : 'No data'),
  });
  renderStats(series);
  renderDiffs(runs);
}

function runHeader(run) {
  const key = el('span', { className: 'line-key' });
  key.style.background = `var(${seriesColor(state.selected.get(run.id))})`;
  return el('th', {}, el('span', { className: 'inline' }, key, ' ', run.name));
}

function renderStats(series) {
  const thead = $('#stats-table thead');
  const tbody = $('#stats-table tbody');
  if (!series.length) {
    thead.replaceChildren();
    tbody.replaceChildren();
    return;
  }
  thead.replaceChildren(el('tr', {}, ...['Series', 'Mean', 'Min', 'Max', 'Final', 'Points'].map(
    (h, i) => el('th', { className: i ? 'num' : '', textContent: h }))));
  tbody.replaceChildren(...series.map((s) => {
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const v of s.y) {
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const n = s.y.length;
    const key = el('span', { className: 'line-key' });
    key.style.background = `var(${s.color})`;
    return el('tr', {},
      el('td', {}, el('span', { className: 'inline' }, key, ' ', s.label)),
      ...[n ? sum / n : NaN, min, max, n ? s.y[n - 1] : NaN].map(
        (v) => el('td', { className: 'num', textContent: fmtValue(v) })),
      el('td', { className: 'num', textContent: n.toLocaleString() }));
  }));
}

function renderDiffs(runs) {
  const thead = $('#diff-table thead');
  const tbody = $('#diff-table tbody');
  const rows = [];
  if (runs.length >= 2) {
    const differs = (vals) => vals.some((v) => !sameValue(String(v), String(vals[0])));
    const sites = runs.map((r) => r.site.label);
    if (differs(sites)) rows.push(['Site', sites]);
    for (const f of FLAGS) {
      const vals = runs.map((r) => (r.flags[f.name] ? 'on' : 'off'));
      if (differs(vals)) rows.push([`Option: ${f.label}`, vals]);
    }
    const names = [...new Set(runs.flatMap((r) => Object.keys(r.params)))];
    for (const name of names) {
      const vals = runs.map((r) => r.params[name] ?? '–');
      if (differs(vals)) rows.push([name, vals]);
    }
    const events = runs.map((r) => r.eventsText);
    if (differs(events)) rows.push(['events.in', events.map((e) => `${countEvents(e)} events`)]);
  }
  $('#diff-empty').hidden = !(runs.length >= 2 && rows.length === 0);
  if (!rows.length) {
    thead.replaceChildren();
    tbody.replaceChildren();
    return;
  }
  thead.replaceChildren(el('tr', {}, el('th', { textContent: 'Input' }), ...runs.map(runHeader)));
  tbody.replaceChildren(...rows.map(([name, vals]) => el('tr', {},
    el('td', {}, el('code', { textContent: name })),
    ...vals.map((v) => el('td', { textContent: v })))));
}

// ---------------------------------------------------------------------------
// Startup

async function init() {
  chart = new LineChart($('#chart'));

  callWorker({ type: 'version' })
    .then((r) => {
      state.version = r.log.trim();
      $('#version').textContent = `(${state.version})`;
    })
    .catch(() => {});

  const [examples, paramInfo, outputInfo] = await Promise.all([
    fetchJson('examples.json'), fetchJson('param-info.json'), fetchJson('output-info.json')]);
  state.examples = examples || [];
  state.paramInfo = paramInfo || {};
  state.outputInfo = outputInfo || {};

  const sel = $('#site-select');
  sel.replaceChildren(
    ...state.examples.map((e) => el('option', { value: e.id, textContent: e.name })),
    el('option', { value: UPLOAD, textContent: 'Upload your own files…' }));
  sel.addEventListener('change', async () => {
    if (sel.value === UPLOAD) {
      $('#upload-panel').hidden = false;
      return;
    }
    try {
      if (sel.value.startsWith('upload:')) await loadUploadBundle(sel.value.slice(7));
      else await loadExample(sel.value);
    } catch (e) {
      showBanner(e.message);
    }
  });

  $('#up-load').addEventListener('click', () => onUpload().catch((e) => showBanner(e.message)));
  $('#param-filter').addEventListener('input', renderParams);
  $('#changed-only').addEventListener('change', renderParams);
  $('#reset-params').addEventListener('click', () => {
    state.values = { ...state.baseValues };
    state.flags = { ...state.site.flags };
    $('#events-text').value = state.site.eventsText;
    renderFlags();
    renderParams();
    updateEventsSummary();
  });
  $('#events-text').addEventListener('input', updateEventsSummary);
  $('#run-btn').addEventListener('click', onRun);
  $('#delete-all').addEventListener('click', async () => {
    if (!confirm('Delete all saved runs and uploaded inputs from this browser?')) return;
    await store.deleteAll();
    state.outputs.clear();
    state.selected.clear();
    localStorage.removeItem('sipnet-selected');
    await refreshRuns();
  });
  for (const id of ['#cmp-period', '#cmp-stat', '#cmp-mode']) $(id).addEventListener('change', renderCompare);
  $('#cmp-var').addEventListener('change', () => {
    localStorage.setItem('sipnet-cmp-var', $('#cmp-var').value);
    renderCompare();
  });

  try {
    for (const [id, slot] of JSON.parse(localStorage.getItem('sipnet-selected') || '[]')) {
      state.selected.set(id, slot);
    }
  } catch {
    // ignore a corrupt saved selection
  }

  if (!state.examples.length) {
    showBanner("No example inputs found (examples.json / examples/). Run 'make wasm-site', "
      + 'or upload your own input files.');
    sel.value = UPLOAD;
    $('#upload-panel').hidden = false;
  }
  await refreshRuns();
  if (state.examples.length) {
    try {
      await loadExample(state.examples[0].id);
    } catch (e) {
      showBanner(`Could not load example inputs: ${e.message}. Run 'make wasm-site' to copy them into web/examples/.`);
    }
  }
}

init().catch((e) => showBanner(`Startup failed: ${e.message}`));
