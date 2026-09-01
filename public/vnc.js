import RFB from '/novnc/core/rfb.js';

const params = new URLSearchParams(location.search);
const sid = params.get('sid');
const vm = params.get('vm');

const statusEl = document.getElementById('status');
const titleEl = document.getElementById('title');
const screenEl = document.getElementById('screen');
titleEl.textContent = `${vm} @ ${sid}`;
document.title = `${vm} — VNC`;

let rfb = null;

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = cls;
}

async function connect() {
  if (rfb) {
    try { rfb.disconnect(); } catch (_) {}
    rfb = null;
  }
  screenEl.innerHTML = '';
  setStatus('fetching credentials…');

  let creds = {};
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(sid)}/vms/${encodeURIComponent(vm)}/vnc`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    creds = body;
  } catch (err) {
    setStatus(`error: ${err.message}`, 'err');
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/vnc-ws/${encodeURIComponent(sid)}/${encodeURIComponent(vm)}`;

  setStatus('connecting…');
  try {
    rfb = new RFB(screenEl, url, {
      credentials: { password: creds.password || '' },
    });
  } catch (err) {
    setStatus(`error: ${err.message}`, 'err');
    return;
  }

  rfb.scaleViewport = true;
  rfb.resizeSession = false;

  rfb.addEventListener('connect', () => setStatus('connected', 'ok'));
  rfb.addEventListener('disconnect', (e) => {
    setStatus(e.detail && e.detail.clean ? 'disconnected' : 'connection lost', 'err');
  });
  rfb.addEventListener('credentialsrequired', () => {
    rfb.sendCredentials({ password: creds.password || '' });
  });
  rfb.addEventListener('securityfailure', (e) => {
    setStatus(`auth failed: ${(e.detail && e.detail.reason) || ''}`, 'err');
  });
}

document.getElementById('reconnect').addEventListener('click', connect);
connect();
