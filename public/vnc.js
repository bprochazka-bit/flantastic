import RFB from '/vendor/novnc/core/rfb.js';

const params = new URLSearchParams(location.search);
const eid = params.get('eid');
const iid = params.get('iid');
const name = params.get('name') || iid;

const statusEl = document.getElementById('status');
document.getElementById('title').textContent = name;
document.title = `${name} — VNC`;
const screenEl = document.getElementById('screen');
const stageEl = document.getElementById('stage');

let rfb = null;
let connected = false;
let attempt = 0;
const MAX_ATTEMPTS = 25;
let retryTimer = null;

function setStatus(text, cls = '') { statusEl.textContent = text; statusEl.className = cls; }

function scheduleRetry(why) {
  if (connected || attempt >= MAX_ATTEMPTS) { setStatus(why || 'connection lost', 'err'); return; }
  setStatus(`${why} — retrying (${attempt}/${MAX_ATTEMPTS})…`);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, 2000);
}

async function connect() {
  attempt++;
  if (rfb) { try { rfb.disconnect(); } catch (_) {} rfb = null; }
  screenEl.innerHTML = '';
  setStatus('requesting console…');

  let info;
  try {
    const res = await fetch(`/api/endpoints/${encodeURIComponent(eid)}/items/${encodeURIComponent(iid)}/connect`);
    info = await res.json();
    if (!res.ok) throw new Error(info.error || res.statusText);
  } catch (err) {
    return scheduleRetry(err.message);
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${proto}://${location.host}/ws/${encodeURIComponent(eid)}/${encodeURIComponent(iid)}`;
  if (info.session) url += `?session=${encodeURIComponent(info.session)}`;

  setStatus('connecting…');
  try {
    rfb = new RFB(screenEl, url, { credentials: { password: info.password || '' } });
  } catch (err) {
    return scheduleRetry(err.message);
  }
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.focusOnClick = true;

  rfb.addEventListener('connect', () => { connected = true; attempt = 0; setStatus('connected', 'ok'); updateButtons(); });
  rfb.addEventListener('disconnect', (e) => {
    updateButtons();
    if (!connected) return scheduleRetry('VNC not up yet');
    setStatus(e.detail && e.detail.clean ? 'disconnected' : 'connection lost', 'err');
  });
  rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password: info.password || '' }));
  rfb.addEventListener('securityfailure', (e) => setStatus(`auth failed: ${(e.detail && e.detail.reason) || ''}`, 'err'));
}

// --- special keys -----------------------------------------------------------
// X11 keysyms + DOM codes for modifiers/keys we send as combos. Sending via
// buttons bypasses the local OS, so combos it would otherwise intercept
// (Cmd+Tab, Ctrl+Alt+Del, Win+L…) reach the remote machine instead.
const K = {
  ctrl: [0xffe3, 'ControlLeft'], alt: [0xffe9, 'AltLeft'], shift: [0xffe1, 'ShiftLeft'],
  meta: [0xffeb, 'MetaLeft'], // Windows key / Mac ⌘
  esc: [0xff1b, 'Escape'], tab: [0xff09, 'Tab'], enter: [0xff0d, 'Enter'],
  del: [0xffff, 'Delete'], space: [0x20, 'Space'], prtsc: [0xff61, 'PrintScreen'],
  d: [0x64, 'KeyD'], e: [0x65, 'KeyE'], l: [0x6c, 'KeyL'], r: [0x72, 'KeyR'],
  q: [0x71, 'KeyQ'], w: [0x77, 'KeyW'], d3: [0x33, 'Digit3'], d4: [0x34, 'Digit4'],
};
function fkey(n) { return [0xffbe + (n - 1), 'F' + n]; }

const GROUPS = {
  common: [
    ['Esc', [K.esc]], ['Tab', [K.tab]], ['Alt+Tab', [K.alt, K.tab]],
    ['PrtSc', [K.prtsc]], ['Ctrl+Esc', [K.ctrl, K.esc]],
  ],
  windows: [
    ['Win', [K.meta]], ['Win+D', [K.meta, K.d]], ['Win+E', [K.meta, K.e]],
    ['Win+R', [K.meta, K.r]], ['Win+L', [K.meta, K.l]],
    ['Ctrl+Shift+Esc', [K.ctrl, K.shift, K.esc]], ['Alt+F4', [K.alt, fkey(4)]],
  ],
  mac: [
    ['⌘Space', [K.meta, K.space]], ['⌘Tab', [K.meta, K.tab]], ['⌘Q', [K.meta, K.q]],
    ['⌘W', [K.meta, K.w]], ['⌃⌘Q (lock)', [K.ctrl, K.meta, K.q]],
    ['⌘⇧3', [K.meta, K.shift, K.d3]], ['⌘⇧4', [K.meta, K.shift, K.d4]],
  ],
  fkeys: Array.from({ length: 12 }, (_, i) => ['F' + (i + 1), [fkey(i + 1)]]),
};

function sendCombo(keys) {
  if (!rfb || !connected) return;
  for (const [ks, code] of keys) rfb.sendKey(ks, code, true);        // press
  for (let i = keys.length - 1; i >= 0; i--) rfb.sendKey(keys[i][0], keys[i][1], false); // release
  rfb.focus();
}

function buildMenu() {
  for (const [group, combos] of Object.entries(GROUPS)) {
    const container = document.querySelector(`.keys[data-group="${group}"]`);
    for (const [label, keys] of combos) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => { sendCombo(keys); closeMenu(); });
      container.appendChild(b);
    }
  }
}

// --- toolbar ----------------------------------------------------------------
const keysBtn = document.getElementById('keys-btn');
const keysMenu = document.getElementById('keys-menu');
function closeMenu() { keysMenu.hidden = true; }
keysBtn.addEventListener('click', (e) => { e.stopPropagation(); keysMenu.hidden = !keysMenu.hidden; });
document.addEventListener('click', (e) => { if (!keysMenu.contains(e.target) && e.target !== keysBtn) closeMenu(); });

document.getElementById('cad').addEventListener('click', () => { if (rfb && connected) { rfb.sendCtrlAltDel(); rfb.focus(); } });

document.getElementById('fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else (stageEl.requestFullscreen ? stageEl.requestFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
});

document.getElementById('screenshot').addEventListener('click', () => {
  const canvas = screenEl.querySelector('canvas');
  if (!canvas) { setStatus('nothing to capture yet', 'err'); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a = document.createElement('a');
  a.download = `${name}-${stamp}.png`;
  a.href = canvas.toDataURL('image/png');
  document.body.appendChild(a);
  a.click();
  a.remove();
});

document.getElementById('reconnect').addEventListener('click', () => {
  connected = false; attempt = 0; clearTimeout(retryTimer); connect();
});

function updateButtons() {
  const on = !!rfb && connected;
  for (const id of ['cad', 'keys-btn', 'screenshot']) document.getElementById(id).disabled = !on;
}

buildMenu();
updateButtons();
connect();
