'use strict';

/*
 * Tiny HTTP helper: a route table with :params, static file serving, and
 * JSON responses. Node built-ins only (replaces express for our needs).
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

class Router {
  constructor() {
    this.routes = [];
  }

  _add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp(
      '^' +
        pattern.replace(/:[A-Za-z0-9_]+/g, (m) => {
          keys.push(m.slice(1));
          return '([^/]+)';
        }) +
        '$'
    );
    this.routes.push({ method, rx, keys, handler });
  }

  get(p, h) { this._add('GET', p, h); }
  post(p, h) { this._add('POST', p, h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.rx);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// Serve a file from `root`, guarding against path traversal.
function serveStatic(root, urlPath, res) {
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(path.normalize(root))) {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(full);
  } catch (_) {
    return false;
  }
  if (stat.isDirectory()) return serveStatic(root, path.join(rel, 'index.html'), res);
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
  fs.createReadStream(full).pipe(res);
  return true;
}

function checkBasicAuth(header, user, password) {
  if (!password) return true;
  const [scheme, encoded] = (header || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const [u, p] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  return u === user && p === password;
}

module.exports = { Router, sendJson, serveStatic, checkBasicAuth, URL };
