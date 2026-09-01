// Android scrcpy viewer: decodes the H.264 stream flantastic relays from the
// device (WebCodecs) and sends touch/key input back.
//
// NOTE: WebCodecs (VideoDecoder) requires a *secure context* — HTTPS, or
// http://localhost. Over plain http to a LAN IP it is unavailable; serve
// flantastic over TLS for remote scrcpy. See the README.

const params = new URLSearchParams(location.search);
const eid = params.get('eid');
const iid = params.get('iid');
const name = params.get('name') || iid;

const statusEl = document.getElementById('status');
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
document.getElementById('title').textContent = name;
document.title = `${name} — scrcpy`;

let ws = null;
let decoder = null;
let configBytes = null; // SPS/PPS (Annex B) to prepend to keyframes
let sawKey = false;

function setStatus(text, cls = '') { statusEl.textContent = text; statusEl.className = cls; }

if (!('VideoDecoder' in window)) {
  setStatus('WebCodecs unavailable — serve flantastic over HTTPS (or use localhost).', 'err');
}

// --- Annex B helpers --------------------------------------------------------

function* nalUnits(buf) {
  // Yields [start, end) offsets of each NAL payload (after the start code).
  let i = 0;
  const n = buf.length;
  let prevStart = -1;
  while (i + 3 < n) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      const scLen = buf[i + 2] === 1 ? 3 : 4;
      if (prevStart >= 0) yield [prevStart, i];
      prevStart = i + scLen;
      i += scLen;
    } else {
      i++;
    }
  }
  if (prevStart >= 0) yield [prevStart, n];
}

function codecStringFromConfig(buf) {
  for (const [s, e] of nalUnits(buf)) {
    const type = buf[s] & 0x1f;
    if (type === 7 && e - s >= 4) {
      const profile = buf[s + 1], constraints = buf[s + 2], level = buf[s + 3];
      const hex = (v) => v.toString(16).padStart(2, '0');
      return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
    }
  }
  return 'avc1.42e01e'; // baseline fallback
}

// --- decoder ----------------------------------------------------------------

function setupDecoder(codec) {
  if (decoder) { try { decoder.close(); } catch (_) {} }
  sawKey = false;
  decoder = new VideoDecoder({
    output: (frame) => {
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
      ctx.drawImage(frame, 0, 0);
      frame.close();
    },
    error: (e) => setStatus(`decode error: ${e.message}`, 'err'),
  });
  decoder.configure({ codec, optimizeForLatency: true });
}

function onFrame(flags, pts, data) {
  const isConfig = (flags & 1) !== 0;
  const isKey = (flags & 2) !== 0;
  if (isConfig) {
    configBytes = data;
    try { setupDecoder(codecStringFromConfig(data)); setStatus('connected', 'ok'); }
    catch (e) { setStatus(`configure failed: ${e.message}`, 'err'); }
    return;
  }
  if (!decoder || decoder.state !== 'configured') return;
  if (!sawKey && !isKey) return; // wait for the first keyframe
  let payload = data;
  if (isKey && configBytes) {
    payload = new Uint8Array(configBytes.length + data.length);
    payload.set(configBytes, 0);
    payload.set(data, configBytes.length);
  }
  if (isKey) sawKey = true;
  try {
    decoder.decode(new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp: Number(pts),
      data: payload,
    }));
  } catch (e) {
    setStatus(`decode error: ${e.message}`, 'err');
  }
}

// --- connection -------------------------------------------------------------

function connect() {
  if (ws) { try { ws.close(); } catch (_) {} }
  configBytes = null;
  setStatus('connecting…');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(eid)}/${encodeURIComponent(iid)}`);
  ws.binaryType = 'arraybuffer';

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const meta = JSON.parse(ev.data);
        if (meta.type === 'meta') {
          canvas.width = meta.width; canvas.height = meta.height;
          setStatus(`streaming ${meta.width}×${meta.height}`, 'ok');
        }
      } catch (_) {}
      return;
    }
    const buf = new Uint8Array(ev.data);
    const flags = buf[0];
    const view = new DataView(ev.data);
    const pts = view.getBigUint64(1);
    onFrame(flags, pts, buf.subarray(9));
  };
  ws.onclose = () => setStatus('disconnected', 'err');
  ws.onerror = () => setStatus('connection error', 'err');
}

// --- input ------------------------------------------------------------------

function sendEvent(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function pointer(e, action) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !canvas.width) return;
  const x = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
  const y = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
  sendEvent({ t: 'touch', action, x, y });
}

let down = false;
canvas.addEventListener('pointerdown', (e) => { down = true; canvas.setPointerCapture(e.pointerId); pointer(e, 0); });
canvas.addEventListener('pointermove', (e) => { if (down) pointer(e, 2); });
canvas.addEventListener('pointerup', (e) => { down = false; pointer(e, 1); });
canvas.addEventListener('pointercancel', (e) => { down = false; pointer(e, 1); });

for (const btn of document.querySelectorAll('#bar [data-key]')) {
  btn.addEventListener('click', () => sendEvent({ t: 'key', key: btn.dataset.key }));
}

const textInput = document.getElementById('text-input');
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && textInput.value) {
    sendEvent({ t: 'text', text: textInput.value });
    textInput.value = '';
  }
});

document.getElementById('reconnect').addEventListener('click', connect);
connect();
