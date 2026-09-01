'use strict';

/*
 * Proxmox VE provider: list QEMU VMs and LXC containers across the cluster's
 * nodes, start/stop them, and open their console in the browser.
 *
 * Console path: POST .../vncproxy (websocket=1) yields a one-time {port,
 * ticket}. flantastic then relays between the browser's noVNC WebSocket and
 * Proxmox's own vncwebsocket endpoint (both carry the raw RFB stream). The
 * RFB password is the vncproxy ticket.
 *
 * Auth: an API token (recommended) or username/password (ticket cookie).
 *
 * Endpoint config fields:
 *   host, port(=8006), verifyTls(false),
 *   tokenId ("user@pam!name") + tokenSecret,   OR
 *   username + password + realm(=pam)
 */

const https = require('https');
const { URL } = require('url');
const { WSClient } = require('../lib/wsclient');

// Short-lived console sessions created by connectInfo(), consumed by bridge().
const sessions = new Map();
function putSession(data) {
  const id = require('crypto').randomBytes(16).toString('hex');
  sessions.set(id, { ...data, exp: Date.now() + 30000 });
  return id;
}
function takeSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  sessions.delete(id);
  if (s.exp < Date.now()) return null;
  return s;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
}, 30000).unref();

function apiBase(ep) {
  return `https://${ep.host}:${ep.port || 8006}/api2/json`;
}

// --- authenticated REST request --------------------------------------------

async function authHeaders(ep, method) {
  if (ep.tokenId && ep.tokenSecret) {
    return { Authorization: `PVEAPIToken=${ep.tokenId}=${ep.tokenSecret}` };
  }
  // Username/password: fetch a ticket (cached briefly on the endpoint object).
  const now = Date.now();
  if (!ep._ticket || ep._ticketExp < now) {
    const body = new URLSearchParams({
      username: `${ep.username}@${ep.realm || 'pam'}`,
      password: ep.password || '',
    }).toString();
    const res = await request(ep, 'POST', '/access/ticket', body, {});
    if (!res || !res.data) throw new Error('Proxmox login failed');
    ep._ticket = res.data.ticket;
    ep._csrf = res.data.CSRFPreventionToken;
    ep._ticketExp = now + 90 * 60 * 1000; // tickets last ~2h
  }
  const h = { Cookie: `PVEAuthCookie=${ep._ticket}` };
  if (method !== 'GET') h.CSRFPreventionToken = ep._csrf;
  return h;
}

function request(ep, method, apiPath, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(apiBase(ep) + apiPath);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { ...headers },
      rejectUnauthorized: ep.verifyTls === true,
    };
    if (body != null) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Proxmox ${method} ${apiPath} -> ${res.statusCode} ${data.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function api(ep, method, apiPath, body) {
  const headers = await authHeaders(ep, method);
  return request(ep, method, apiPath, body, headers);
}

// --- provider ---------------------------------------------------------------

async function nodes(ep) {
  if (ep.node) return [ep.node];
  const res = await api(ep, 'GET', '/nodes');
  return (res.data || []).map((n) => n.node);
}

// itemId encodes node + kind + vmid: "node/kind/vmid"
function itemId(node, kind, vmid) { return `${node}/${kind}/${vmid}`; }
function parseItem(iid) {
  const [node, kind, vmid] = iid.split('/');
  return { node, kind, vmid };
}

module.exports = {
  type: 'proxmox',

  async list(ep) {
    const items = [];
    for (const node of await nodes(ep)) {
      for (const kind of ['qemu', 'lxc']) {
        let res;
        try { res = await api(ep, 'GET', `/nodes/${node}/${kind}`); } catch (_) { continue; }
        for (const g of res.data || []) {
          const running = g.status === 'running';
          items.push({
            id: itemId(node, kind, g.vmid),
            name: `${g.name || (kind === 'lxc' ? 'ct' : 'vm')}-${g.vmid}`,
            detail: `${node} · ${kind === 'lxc' ? 'LXC' : 'QEMU'}`,
            state: running ? 'running' : 'stopped',
            viewer: 'vnc',
            capabilities: { start: !running, stop: running, connect: running },
          });
        }
      }
    }
    return items;
  },

  async start(ep, iid) {
    const { node, kind, vmid } = parseItem(iid);
    await api(ep, 'POST', `/nodes/${node}/${kind}/${vmid}/status/start`, '');
    return { ok: true };
  },

  async stop(ep, iid) {
    const { node, kind, vmid } = parseItem(iid);
    await api(ep, 'POST', `/nodes/${node}/${kind}/${vmid}/status/shutdown`, '');
    return { ok: true };
  },

  async connectInfo(ep, iid) {
    const { node, kind, vmid } = parseItem(iid);
    const res = await api(ep, 'POST', `/nodes/${node}/${kind}/${vmid}/vncproxy`, 'websocket=1');
    const d = res.data || {};
    const session = putSession({ node, kind, vmid, port: d.port, ticket: d.ticket });
    return { viewer: 'vnc', password: d.ticket, session };
  },

  async bridge(ws, ep, iid, query) {
    const s = takeSession(query.session);
    if (!s) return ws.close(1011, 'console session expired — reconnect');

    const headers = await authHeaders(ep, 'GET');
    const wsUrl =
      `wss://${ep.host}:${ep.port || 8006}/api2/json/nodes/${s.node}/${s.kind}/${s.vmid}` +
      `/vncwebsocket?port=${encodeURIComponent(s.port)}&vncticket=${encodeURIComponent(s.ticket)}`;

    const upstream = new WSClient(wsUrl, {
      headers,
      subprotocol: 'binary',
      rejectUnauthorized: ep.verifyTls === true,
    });

    upstream.on('open', () => {
      upstream.on('message', (buf) => ws.readyState === ws.OPEN && ws.send(buf));
      ws.on('message', (buf) => upstream.readyState === upstream.OPEN && upstream.send(buf));
    });
    upstream.on('close', () => ws.readyState === ws.OPEN && ws.close());
    upstream.on('error', () => ws.readyState === ws.OPEN && ws.close(1011, 'proxmox console error'));
    ws.on('close', () => upstream.close());
    ws.on('error', () => upstream.close());
  },
};
