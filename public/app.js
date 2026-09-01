'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const serversEl = $('#servers');
const errorEl = $('#error');
const statusLine = $('#status-line');
const emptyEl = $('#empty');

let servers = [];
let refreshTimer = null;

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = !msg;
}

async function api(method, url) {
  const res = await fetch(url, { method });
  let body = {};
  try { body = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

function stateBadge(state) {
  const map = {
    running: ['running', 'ok'],
    stopped: ['stopped', 'off'],
    suspended: ['suspended', 'warn'],
  };
  return map[state] || [state, 'off'];
}

async function loadServers() {
  const data = await api('GET', '/api/servers');
  servers = data.servers;
  emptyEl.hidden = servers.length > 0;

  serversEl.innerHTML = '';
  for (const s of servers) {
    const node = $('#server-tpl').content.cloneNode(true);
    const section = $('.server', node);
    section.dataset.sid = s.id;
    $('.server-label', node).textContent = s.label;
    $('.server-host', node).textContent = s.host;
    serversEl.appendChild(node);
  }
}

async function refreshServer(s) {
  const section = serversEl.querySelector(`.server[data-sid="${CSS.escape(s.id)}"]`);
  if (!section) return;
  const grid = $('.grid', section);
  const errEl = $('.server-error', section);
  try {
    const { vms } = await api('GET', `/api/servers/${encodeURIComponent(s.id)}/vms`);
    errEl.hidden = true;
    renderVMs(grid, s, vms);
  } catch (err) {
    errEl.textContent = `Could not reach ${s.label}: ${err.message}`;
    errEl.hidden = false;
    grid.innerHTML = '';
  }
}

function renderVMs(grid, server, vms) {
  grid.innerHTML = '';
  if (vms.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No local VMs on this Mac.';
    grid.appendChild(p);
    return;
  }
  for (const vm of vms) {
    const node = $('#card-tpl').content.cloneNode(true);
    const card = $('.card', node);
    const [label, cls] = stateBadge(vm.state);
    const running = vm.state === 'running';

    $('.name', node).textContent = vm.name;
    const badge = $('.state', node);
    badge.textContent = label;
    badge.classList.add(cls);
    $('.dot', node).classList.add(cls);

    const startBtn = $('.start', node);
    const stopBtn = $('.stop', node);
    const vncBtn = $('.vnc', node);

    startBtn.disabled = running;
    stopBtn.disabled = !running;
    vncBtn.disabled = !running;

    startBtn.addEventListener('click', () => act(startBtn, server, vm.name, 'start'));
    stopBtn.addEventListener('click', () => act(stopBtn, server, vm.name, 'stop'));
    vncBtn.addEventListener('click', () => {
      const url = `/vnc.html?sid=${encodeURIComponent(server.id)}&vm=${encodeURIComponent(vm.name)}`;
      window.open(url, `vnc-${server.id}-${vm.name}`);
    });

    grid.appendChild(node);
  }
}

async function act(btn, server, vm, action) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = action === 'start' ? 'Starting…' : 'Stopping…';
  showError('');
  try {
    await api('POST', `/api/servers/${encodeURIComponent(server.id)}/vms/${encodeURIComponent(vm)}/${action}`);
    // Give tart a moment, then refresh this server a few times to catch state.
    setTimeout(() => refreshServer(server), 1500);
    setTimeout(() => refreshServer(server), 4000);
  } catch (err) {
    showError(`${action} ${vm}: ${err.message}`);
    btn.textContent = original;
    btn.disabled = false;
  }
}

async function refreshAll() {
  statusLine.textContent = 'Refreshing…';
  await Promise.all(servers.map(refreshServer));
  statusLine.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

async function init() {
  try {
    await loadServers();
    await refreshAll();
  } catch (err) {
    showError(err.message);
  }
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, 8000);
}

$('#refresh').addEventListener('click', refreshAll);
init();
