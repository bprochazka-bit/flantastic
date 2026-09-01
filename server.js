'use strict';

/*
 * flantastic — a zero-dependency (Node built-ins only) web app to manage and
 * view remote machines from your browser. Runs on Linux (e.g. Debian 13).
 *
 * Endpoint types (see endpoints.json / endpoints.example.json):
 *   - mac      : tart VMs on a Mac over SSH, viewed via VNC (SSH-tunnelled)
 *   - vnc      : any VNC server by host:port (e.g. an iPhone/iOS VNC server),
 *                direct or via an SSH gateway
 *   - proxmox  : Proxmox VE guests (QEMU + LXC) via the REST API + console
 *   - android  : Android devices via adb + the scrcpy server (H.264)
 *
 * Requires system tools depending on which endpoints you use:
 *   ssh (openssh-client), adb (android-tools-adb). No `npm install` needed.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { Router, sendJson, serveStatic, checkBasicAuth, URL } = require('./lib/http');
const wsserver = require('./lib/ws');
const L = require('./lib/log')('http');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '8080', 10);
const ENDPOINTS_FILE = process.env.ENDPOINTS_FILE || path.join(__dirname, 'endpoints.json');
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';
const PUBLIC = path.join(__dirname, 'public');

// --- providers -------------------------------------------------------------

const providers = {};
for (const p of [require('./providers/mac'), require('./providers/vnc'), require('./providers/proxmox'), require('./providers/android')]) {
  providers[p.type] = p;
}

// --- config ----------------------------------------------------------------

function loadEndpoints() {
  let raw;
  try {
    raw = fs.readFileSync(ENDPOINTS_FILE, 'utf8');
  } catch (_) {
    console.error(`No endpoints file at ${ENDPOINTS_FILE}. Copy endpoints.example.json to endpoints.json.`);
    return [];
  }
  let data;
  try { data = JSON.parse(raw); } catch (err) {
    console.error(`endpoints.json is not valid JSON: ${err.message}`);
    return [];
  }
  const list = Array.isArray(data) ? data : data.endpoints || [];
  return list.filter((e) => {
    if (!e || !e.id || !e.type) return false;
    if (!providers[e.type]) { console.error(`Unknown endpoint type "${e.type}" for "${e.id}"`); return false; }
    return true;
  });
}

let ENDPOINTS = loadEndpoints();
const getEndpoint = (id) => ENDPOINTS.find((e) => e.id === id);
const providerFor = (ep) => providers[ep.type];

// --- HTTP routes ------------------------------------------------------------

const router = new Router();

router.get('/api/endpoints', (req, res) => {
  sendJson(res, 200, {
    endpoints: ENDPOINTS.map((e) => ({ id: e.id, type: e.type, label: e.label || e.id, host: e.host || null })),
  });
});

router.get('/api/endpoints/:eid/items', async (req, res) => {
  const ep = getEndpoint(req.params.eid);
  if (!ep) return sendJson(res, 404, { error: 'Unknown endpoint' });
  try {
    const items = await providerFor(ep).list(ep);
    sendJson(res, 200, { items });
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
});

router.post('/api/endpoints/:eid/items/:iid/start', (req, res) => act(req, res, 'start'));
router.post('/api/endpoints/:eid/items/:iid/stop', (req, res) => act(req, res, 'stop'));

async function act(req, res, action) {
  const ep = getEndpoint(req.params.eid);
  if (!ep) return sendJson(res, 404, { error: 'Unknown endpoint' });
  try {
    const result = await providerFor(ep)[action](ep, req.params.iid);
    sendJson(res, 200, result || { ok: true });
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
}

router.get('/api/endpoints/:eid/items/:iid/connect', async (req, res) => {
  const ep = getEndpoint(req.params.eid);
  if (!ep) return sendJson(res, 404, { error: 'Unknown endpoint' });
  try {
    const info = await providerFor(ep).connectInfo(ep, req.params.iid);
    sendJson(res, 200, info);
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
});

// Native VNC client connection details. Only if the provider supports it.
router.get('/api/endpoints/:eid/items/:iid/native', async (req, res) => {
  const ep = getEndpoint(req.params.eid);
  if (!ep) return sendJson(res, 404, { error: 'Unknown endpoint' });
  const provider = providerFor(ep);
  if (typeof provider.native !== 'function') return sendJson(res, 404, { error: 'No native VNC for this endpoint type' });
  try {
    sendJson(res, 200, await provider.native(ep, req.params.iid));
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
});

// Provider log (e.g. the tart VM log). Only if the provider supports it.
router.get('/api/endpoints/:eid/items/:iid/log', async (req, res) => {
  const ep = getEndpoint(req.params.eid);
  if (!ep) return sendJson(res, 404, { error: 'Unknown endpoint' });
  const provider = providerFor(ep);
  if (typeof provider.log !== 'function') return sendJson(res, 404, { error: 'No log for this endpoint type' });
  try {
    sendJson(res, 200, await provider.log(ep, req.params.iid));
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
});

// --- server -----------------------------------------------------------------

const useTls = TLS_CERT && TLS_KEY;
const requestHandler = (req, res) => {
  if (AUTH_PASSWORD && !checkBasicAuth(req.headers.authorization, AUTH_USER, AUTH_PASSWORD)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="flantastic"' });
    return res.end('Authentication required');
  }
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (_) { res.writeHead(400).end(); return; }

  // Log API calls (not static asset noise) with status + duration.
  if (u.pathname.startsWith('/api/')) {
    const started = Date.now();
    res.on('finish', () => L.info(`${req.method} ${u.pathname} -> ${res.statusCode} (${Date.now() - started}ms)`));
  }

  const route = router.match(req.method, u.pathname);
  if (route) {
    req.params = route.params;
    return route.handler(req, res);
  }
  // Static files (UI + vendored noVNC).
  if (req.method === 'GET' && serveStatic(PUBLIC, u.pathname, res)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
};

const server = useTls
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, requestHandler)
  : http.createServer(requestHandler);

// WebSocket upgrades: /ws/:eid/:iid  -> provider.bridge(ws, ep, iid, query)
server.on('upgrade', (req, socket, head) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (_) { return socket.destroy(); }
  const m = u.pathname.match(/^\/ws\/([^/]+)\/([^/]+)$/);
  if (!m) return socket.destroy();
  if (AUTH_PASSWORD && !checkBasicAuth(req.headers.authorization, AUTH_USER, AUTH_PASSWORD)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="flantastic"\r\n\r\n');
    return socket.destroy();
  }
  const ep = getEndpoint(decodeURIComponent(m[1]));
  if (!ep) return socket.destroy();
  const iid = decodeURIComponent(m[2]);
  const query = Object.fromEntries(u.searchParams);

  const ws = wsserver.accept(req, socket);
  if (!ws) return;
  L.info(`ws connect ${ep.id}[${ep.type}] item=${iid}`);
  ws.on('close', () => L.info(`ws close ${ep.id} item=${iid}`));
  Promise.resolve()
    .then(() => providerFor(ep).bridge(ws, ep, iid, query))
    .catch((err) => { L.error(`bridge ${ep.id} item=${iid}: ${err.message || err}`); try { ws.close(1011, String(err.message || err)); } catch (_) {} });
});

server.listen(PORT, HOST, () => {
  console.log(`flantastic listening on ${useTls ? 'https' : 'http'}://${HOST}:${PORT}`);
  console.log(`Endpoints (${ENDPOINTS.length}): ${ENDPOINTS.map((e) => `${e.id}[${e.type}]`).join(', ') || '(none — see endpoints.example.json)'}`);
  if (!AUTH_PASSWORD) console.log('WARNING: AUTH_PASSWORD is not set — anyone who can reach this port can control these machines.');
  if (!useTls) console.log('NOTE: no TLS — Android/scrcpy (WebCodecs) needs a secure context; set TLS_CERT/TLS_KEY for remote use.');
});
