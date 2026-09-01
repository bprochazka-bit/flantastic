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
    const connectBtn = $('.connect', node);

    if (!caps.start && !caps.stop) { startBtn.remove(); stopBtn.remove(); }
    else { startBtn.disabled = !caps.start; stopBtn.disabled = !caps.stop; }
    connectBtn.disabled = !caps.connect;

    startBtn && startBtn.addEventListener('click', () => act(startBtn, endpoint, it.id, 'start'));
    stopBtn && stopBtn.addEventListener('click', () => act(stopBtn, endpoint, it.id, 'stop'));
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
    await api('POST', `/api/endpoints/${encodeURIComponent(endpoint.id)}/items/${encodeURIComponent(iid)}/${action}`);
    setTimeout(() => refreshEndpoint(endpoint), 1500);
    setTimeout(() => refreshEndpoint(endpoint), 4500);
  } catch (err) {
    showError(`${action} ${iid}: ${err.message}`);
    btn.textContent = original;
    btn.disabled = false;
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
