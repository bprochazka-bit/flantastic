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
let connected = false;       // reached a successful RFB 'connect'
let attempt = 0;
const MAX_ATTEMPTS = 25;     // ~50s of retrying while the VM boots
let retryTimer = null;

function setStatus(text, cls = '') { statusEl.textContent = text; statusEl.className = cls; }

function scheduleRetry(why) {
  if (connected || attempt >= MAX_ATTEMPTS) {
    setStatus(why || 'connection lost', 'err');
    return;
  }
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
    // Usually "VNC not ready yet" while the VM boots — keep waiting.
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

  rfb.addEventListener('connect', () => { connected = true; attempt = 0; setStatus('connected', 'ok'); });
  rfb.addEventListener('disconnect', (e) => {
    if (!connected) return scheduleRetry('VNC not up yet');
    setStatus(e.detail && e.detail.clean ? 'disconnected' : 'connection lost', 'err');
  });
  rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password: info.password || '' }));
  rfb.addEventListener('securityfailure', (e) =>
    setStatus(`auth failed: ${(e.detail && e.detail.reason) || ''}`, 'err'));
}

document.getElementById('reconnect').addEventListener('click', () => {
  connected = false; attempt = 0; clearTimeout(retryTimer); connect();
});
connect();
