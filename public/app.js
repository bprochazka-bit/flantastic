'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const endpointsEl = $('#endpoints');
const errorEl = $('#error');
const statusLine = $('#status-line');
const emptyEl = $('#empty');

let endpoints = [];
let timer = null;

const TYPE_LABEL = { mac: 'Mac / tart', vnc: 'VNC', proxmox: 'Proxmox', android: 'Android' };

function showError(msg) {
  errorEl.textContent = msg || '';
  errorEl.hidden = !msg;
}

async function api(method, url) {
  const res = await fetch(url, { method });
  let body = {};
  try { body = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

function stateClass(state) {
  if (['running', 'online', 'available', 'device'].includes(state)) return 'ok';
  if (['stopped', 'offline', 'unauthorized'].includes(state)) return 'off';
  return 'warn';
}

async function loadEndpoints() {
  const { endpoints: eps } = await api('GET', '/api/endpoints');
  endpoints = eps;
  emptyEl.hidden = eps.length > 0;
  endpointsEl.innerHTML = '';
  for (const e of eps) {
    const node = $('#endpoint-tpl').content.cloneNode(true);
    $('.endpoint', node).dataset.eid = e.id;
    $('.type-badge', node).textContent = TYPE_LABEL[e.type] || e.type;
    $('.type-badge', node).classList.add('t-' + e.type);
    $('.endpoint-label', node).textContent = e.label;
    $('.endpoint-host', node).textContent = e.host || '';
    endpointsEl.appendChild(node);
  }
}

async function refreshEndpoint(e) {
  const section = endpointsEl.querySelector(`.endpoint[data-eid="${CSS.escape(e.id)}"]`);
  if (!section) return;
  const grid = $('.grid', section);
  const errEl = $('.endpoint-error', section);
  try {
    const { items } = await api('GET', `/api/endpoints/${encodeURIComponent(e.id)}/items`);
    errEl.hidden = true;
    renderItems(grid, e, items);
  } catch (err) {
    errEl.textContent = `Could not reach ${e.label}: ${err.message}`;
    errEl.hidden = false;
    grid.innerHTML = '';
  }
}

function renderItems(grid, endpoint, items) {
  grid.innerHTML = '';
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Nothing to show here.';
    grid.appendChild(p);
    return;
  }
  for (const it of items) {
    const node = $('#card-tpl').content.cloneNode(true);
    const cls = stateClass(it.state);
    $('.name', node).textContent = it.name;
    const badge = $('.state', node);
    badge.textContent = it.state;
    badge.classList.add(cls);
    $('.dot', node).classList.add(cls);
    const detail = $('.card-detail', node);
    if (it.detail) detail.textContent = it.detail; else detail.remove();

    const caps = it.capabilities || {};
    const startBtn = $('.start', node);
    const stopBtn = $('.stop', node);
    const logBtn = $('.log', node);
    const nativeBtn = $('.native', node);
    const connectBtn = $('.connect', node);

    if (!caps.start && !caps.stop) { startBtn.remove(); stopBtn.remove(); }
    else { startBtn.disabled = !caps.start; stopBtn.disabled = !caps.stop; }
    if (!caps.log) logBtn.remove();
    if (!caps.native) nativeBtn.remove();
    connectBtn.disabled = !caps.connect;

    startBtn && startBtn.addEventListener('click', () => act(startBtn, endpoint, it.id, 'start'));
    stopBtn && stopBtn.addEventListener('click', () => act(stopBtn, endpoint, it.id, 'stop'));
    logBtn && logBtn.addEventListener('click', () => showLog(endpoint, it));
    nativeBtn && nativeBtn.addEventListener('click', () => showNative(endpoint, it));
    connectBtn.addEventListener('click', () => {
      const viewer = it.viewer === 'scrcpy' ? 'scrcpy.html' : 'vnc.html';
      const url = `/${viewer}?eid=${encodeURIComponent(endpoint.id)}&iid=${encodeURIComponent(it.id)}&name=${encodeURIComponent(it.name)}`;
      window.open(url, `view-${endpoint.id}-${it.id}`);
    });

    grid.appendChild(node);
  }
}

async function act(btn, endpoint, iid, action) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = action === 'start' ? 'Starting…' : 'Stopping…';
  showError('');
  try {
    const res = await api('POST', `/api/endpoints/${encodeURIComponent(endpoint.id)}/items/${encodeURIComponent(iid)}/${action}`);
    if (res && res.message) statusLine.textContent = res.message;
    // VMs take a few seconds to boot; refresh a few times to catch the state.
    for (const ms of [1500, 4000, 8000, 13000]) setTimeout(() => refreshEndpoint(endpoint), ms);
  } catch (err) {
    showError(`${action} ${iid}: ${err.message}`);
    btn.textContent = original;
    btn.disabled = false;
  }
}

// --- log modal --------------------------------------------------------------

const modal = $('#modal');
async function showLog(endpoint, item) {
  $('#modal-title').textContent = `Log — ${item.name}`;
  $('#modal-body').textContent = 'Loading…';
  modal.hidden = false;
  try {
    const res = await api('GET', `/api/endpoints/${encodeURIComponent(endpoint.id)}/items/${encodeURIComponent(item.id)}/log`);
    $('#modal-body').textContent = res.text || '(empty)';
  } catch (err) {
    $('#modal-body').textContent = `Could not load log: ${err.message}`;
  }
}
$('#modal-close').addEventListener('click', () => (modal.hidden = true));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

// --- native VNC client details ---------------------------------------------

async function copyText(value, btn) {
  try {
    await navigator.clipboard.writeText(value);
    const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = t), 1200);
  } catch (_) {
    // Fallback for non-secure contexts.
    const ta = document.createElement('textarea'); ta.value = value; document.body.appendChild(ta);
    ta.select(); try { document.execCommand('copy'); } catch (_) {} ta.remove();
  }
}

function field(label, value, { link } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'nfield';
  const l = document.createElement('div'); l.className = 'nlabel'; l.textContent = label;
  const rowEl = document.createElement('div'); rowEl.className = 'nrow';
  let val;
  if (link) { val = document.createElement('a'); val.href = value; val.textContent = value; }
  else { val = document.createElement('code'); val.textContent = value; }
  val.className = 'nval';
  const copy = document.createElement('button'); copy.className = 'btn'; copy.textContent = 'Copy';
  copy.addEventListener('click', () => copyText(value, copy));
  rowEl.append(val, copy);
  wrap.append(l, rowEl);
  return wrap;
}

async function showNative(endpoint, item) {
  $('#modal-title').textContent = `VNC client — ${item.name}`;
  const body = $('#modal-body');
  body.textContent = 'Loading…';
  modal.hidden = false;
  let info;
  try {
    info = await api('GET', `/api/endpoints/${encodeURIComponent(endpoint.id)}/items/${encodeURIComponent(item.id)}/native`);
  } catch (err) {
    body.textContent = `Could not get connection details: ${err.message}`;
    return;
  }
  body.innerHTML = '';
  const intro = document.createElement('p');
  intro.className = 'nnote';
  intro.textContent = 'Point any VNC client at the address below (on macOS, use the “Open in Screen Sharing” link). The port changes every time the VM starts, so reopen this after a restart.';
  body.appendChild(intro);
  body.appendChild(field('Address', info.address));
  if (info.password) body.appendChild(field('Password', info.password));
  if (info.url) body.appendChild(field('Open in Screen Sharing (macOS)', info.url, { link: true }));
  if (info.ssh) {
    const note = document.createElement('p');
    note.className = 'nnote';
    note.textContent = `Private alternative — run this, then connect your VNC client to ${info.tunnelAddress || 'localhost:5901'}:`;
    body.append(note, field('SSH tunnel', info.ssh));
  }
}

async function refreshAll() {
  statusLine.textContent = 'Refreshing…';
  await Promise.all(endpoints.map(refreshEndpoint));
  statusLine.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

async function init() {
  try {
    await loadEndpoints();
    await refreshAll();
  } catch (err) {
    showError(err.message);
  }
  clearInterval(timer);
  timer = setInterval(refreshAll, 8000);
}

$('#refresh').addEventListener('click', refreshAll);
init();
