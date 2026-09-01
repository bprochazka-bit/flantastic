'use strict';

/*
 * flantastic — run this on a Linux box (e.g. Debian 13). It drives one or
 * more Macs over SSH to:
 *   - list VMs and their state            (`tart list`)
 *   - start a VM with VNC enabled         (your nohup/tart command)
 *   - stop a VM                           (`tart stop`)
 *   - connect to a VM's VNC in the browser (noVNC), tunnelled over the SAME
 *     SSH connection — so VNC never has to be exposed on the Mac; only THIS
 *     web app is bound to 0.0.0.0 for remote access.
 *
 * Macs are configured in servers.json (see servers.example.json). Add more
 * entries there to manage additional Macs.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { URL } = require('url');
const express = require('express');
const { WebSocketServer } = require('ws');
const { runCommand, forwardOut } = require('./lib/ssh');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '8080', 10);
const SERVERS_FILE = process.env.SERVERS_FILE || path.join(__dirname, 'servers.json');
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const AUTH_USER = process.env.AUTH_USER || 'admin';
const NOVNC_DIR = path.join(__dirname, 'node_modules', '@novnc', 'novnc');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadServers() {
  let raw;
  try {
    raw = fs.readFileSync(SERVERS_FILE, 'utf8');
  } catch (_) {
    console.error(`No servers file at ${SERVERS_FILE}. Copy servers.example.json to servers.json.`);
    return [];
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`servers.json is not valid JSON: ${err.message}`);
    return [];
  }
  const list = Array.isArray(data) ? data : data.servers || [];
  return list.filter((s) => s && s.id && s.host && s.username);
}

let SERVERS = loadServers();
function getServer(id) {
  return SERVERS.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Safety + helpers
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const isValidName = (n) => typeof n === 'string' && n.length > 0 && n.length < 128 && NAME_RE.test(n);

// tart is usually under Homebrew; a non-interactive SSH shell often lacks it
// on PATH, so we prepend the common locations. Override per-server with "tart".
function tartCmd(server, args) {
  const bin = server.tart || 'tart';
  return `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ${bin} ${args}`;
}

const logPath = (vm) => `~/vnc-${vm}.log`;

async function listVMs(server) {
  const { code, stdout, stderr } = await runCommand(server, tartCmd(server, 'list --format json'));
  if (code !== 0) {
    throw new Error(`tart list failed on ${server.id}: ${stderr.trim() || 'exit ' + code}`);
  }
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch (_) {
    return [];
  }
  return rows
    .filter((r) => (r.Source || 'local') === 'local')
    .map((r) => ({ name: r.Name, state: (r.State || 'unknown').toLowerCase() }));
}

// Read + parse the vnc:// URL that `tart run --vnc-experimental` logs.
async function readVncInfo(server, vm) {
  const { code, stdout } = await runCommand(server, `cat ${logPath(vm)} 2>/dev/null || true`);
  if (code !== 0) return null;
  const matches = stdout.match(/vnc:\/\/\S+/g);
  if (!matches || matches.length === 0) return null;
  const raw = matches[matches.length - 1].trim();
  try {
    const u = new URL(raw);
    return {
      host: u.hostname || '127.0.0.1',
      port: parseInt(u.port || '5900', 10),
      password: decodeURIComponent(u.password || ''),
    };
  } catch (_) {
    const m = raw.match(/vnc:\/\/(?:([^:@]*):?([^@]*)@)?([^:/]+):(\d+)/);
    if (!m) return null;
    return { host: m[3] || '127.0.0.1', port: parseInt(m[4], 10), password: m[2] || '' };
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (!AUTH_PASSWORD) return next();
  if (checkBasic(req.headers.authorization)) return next();
  res.set('WWW-Authenticate', 'Basic realm="flantastic"');
  res.status(401).send('Authentication required');
});

function checkBasic(hdr) {
  if (!AUTH_PASSWORD) return true;
  const [scheme, encoded] = (hdr || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  return user === AUTH_USER && pass === AUTH_PASSWORD;
}

app.use(express.static(path.join(__dirname, 'public')));
if (fs.existsSync(NOVNC_DIR)) app.use('/novnc', express.static(NOVNC_DIR));

// --- API -------------------------------------------------------------------

app.get('/api/servers', (req, res) => {
  res.json({ servers: SERVERS.map((s) => ({ id: s.id, label: s.label || s.id, host: s.host })) });
});

// List VMs for a single server.
app.get('/api/servers/:sid/vms', async (req, res) => {
  const server = getServer(req.params.sid);
  if (!server) return res.status(404).json({ error: 'Unknown server' });
  try {
    const vms = await listVMs(server);
    res.json({ vms });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/servers/:sid/vms/:name/start', async (req, res) => {
  const server = getServer(req.params.sid);
  const vm = req.params.name;
  if (!server) return res.status(404).json({ error: 'Unknown server' });
  if (!isValidName(vm)) return res.status(400).json({ error: 'Invalid VM name' });
  try {
    const vms = await listVMs(server);
    const target = vms.find((v) => v.name === vm);
    if (!target) return res.status(404).json({ error: `Unknown VM: ${vm}` });
    if (target.state === 'running') return res.json({ ok: true, alreadyRunning: true });

    // Truncate the log first so we only read this run's VNC URL, then launch:
    //   nohup tart run <vm> --no-graphics --vnc-experimental > ~/vnc-<vm>.log 2>&1 &
    const run = tartCmd(server, `run ${vm} --no-graphics --vnc-experimental`);
    const cmd = `sh -lc ': > ${logPath(vm)}; nohup ${run} > ${logPath(vm)} 2>&1 &'`;
    const { code, stderr } = await runCommand(server, cmd);
    if (code !== 0) return res.status(502).json({ error: `Failed to start: ${stderr.trim() || 'exit ' + code}` });
    res.json({ ok: true, started: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/servers/:sid/vms/:name/stop', async (req, res) => {
  const server = getServer(req.params.sid);
  const vm = req.params.name;
  if (!server) return res.status(404).json({ error: 'Unknown server' });
  if (!isValidName(vm)) return res.status(400).json({ error: 'Invalid VM name' });
  try {
    const { code, stderr } = await runCommand(server, tartCmd(server, `stop ${vm}`));
    if (code !== 0) return res.status(502).json({ error: `Failed to stop: ${stderr.trim() || 'exit ' + code}` });
    res.json({ ok: true, stopped: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// VNC credentials for the browser's RFB handshake.
app.get('/api/servers/:sid/vms/:name/vnc', async (req, res) => {
  const server = getServer(req.params.sid);
  const vm = req.params.name;
  if (!server) return res.status(404).json({ error: 'Unknown server' });
  if (!isValidName(vm)) return res.status(400).json({ error: 'Invalid VM name' });
  try {
    const info = await readVncInfo(server, vm);
    if (!info) return res.status(409).json({ error: 'VNC not ready yet. Start the VM and wait a few seconds.' });
    res.json({ password: info.password, port: info.port });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket (bridge browser <-> VM VNC, tunnelled over SSH)
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (_) {
    return socket.destroy();
  }
  const m = pathname.match(/^\/vnc-ws\/([^/]+)\/([^/]+)$/);
  if (!m) return socket.destroy();
  if (AUTH_PASSWORD && !checkBasic(req.headers.authorization)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="flantastic"\r\n\r\n');
    return socket.destroy();
  }
  const sid = decodeURIComponent(m[1]);
  const vm = decodeURIComponent(m[2]);
  if (!getServer(sid) || !isValidName(vm)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, getServer(sid), vm));
});

async function bridge(ws, server, vm) {
  let info;
  try {
    info = await readVncInfo(server, vm);
  } catch (_) {
    info = null;
  }
  if (!info) return ws.close(1011, 'VNC not ready');

  let stream;
  try {
    stream = await forwardOut(server, info.host, info.port);
  } catch (err) {
    return ws.close(1011, 'SSH tunnel failed');
  }

  stream.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  stream.on('close', () => ws.readyState === ws.OPEN && ws.close());
  stream.on('error', () => ws.readyState === ws.OPEN && ws.close(1011, 'VNC tunnel error'));

  ws.on('message', (data) => stream.writable && stream.write(data));
  ws.on('close', () => stream.destroy());
  ws.on('error', () => stream.destroy());
}

server.listen(PORT, HOST, () => {
  console.log(`flantastic listening on http://${HOST}:${PORT}`);
  console.log(`Managing ${SERVERS.length} Mac server(s): ${SERVERS.map((s) => s.id).join(', ') || '(none configured)'}`);
  if (!AUTH_PASSWORD) console.log('WARNING: AUTH_PASSWORD is not set — anyone who can reach this port can control your VMs.');
  if (!fs.existsSync(NOVNC_DIR)) console.log('NOTE: run `npm install` so the in-browser VNC viewer works.');
});
