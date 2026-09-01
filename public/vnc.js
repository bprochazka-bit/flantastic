import RFB from '/vendor/novnc/core/rfb.js';

const params = new URLSearchParams(location.search);
const eid = params.get('eid');
const iid = params.get('iid');
const name = params.get('name') || iid;

const statusEl = document.getElementById('status');
document.getElementById('title').textContent = name;
document.title = `${name} — VNC`;
const screenEl = document.getElementById('screen');

let rfb = null;

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = cls;
}

async function connect() {
  if (rfb) { try { rfb.disconnect(); } catch (_) {} rfb = null; }
  screenEl.innerHTML = '';
  setStatus('requesting console…');

  let info;
  try {
    const res = await fetch(`/api/endpoints/${encodeURIComponent(eid)}/items/${encodeURIComponent(iid)}/connect`);
    info = await res.json();
    if (!res.ok) throw new Error(info.error || res.statusText);
  } catch (err) {
    return setStatus(`error: ${err.message}`, 'err');
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${proto}://${location.host}/ws/${encodeURIComponent(eid)}/${encodeURIComponent(iid)}`;
  if (info.session) url += `?session=${encodeURIComponent(info.session)}`;

  setStatus('connecting…');
  try {
    rfb = new RFB(screenEl, url, { credentials: { password: info.password || '' } });
  } catch (err) {
    return setStatus(`error: ${err.message}`, 'err');
  }
  rfb.scaleViewport = true;
  rfb.resizeSession = false;

  rfb.addEventListener('connect', () => setStatus('connected', 'ok'));
  rfb.addEventListener('disconnect', (e) =>
    setStatus(e.detail && e.detail.clean ? 'disconnected' : 'connection lost', 'err'));
  rfb.addEventListener('credentialsrequired', () =>
    rfb.sendCredentials({ password: info.password || '' }));
  rfb.addEventListener('securityfailure', (e) =>
    setStatus(`auth failed: ${(e.detail && e.detail.reason) || ''}`, 'err'));
}

document.getElementById('reconnect').addEventListener('click', connect);
connect();
