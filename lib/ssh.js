'use strict';

/*
 * SSH connection management for flantastic.
 *
 * Keeps one persistent ssh2 client per configured Mac server, reconnecting
 * on demand. Provides:
 *   - runCommand(server, cmd)  -> { code, stdout, stderr }
 *   - forwardOut(server, host, port) -> a duplex stream to host:port on the Mac
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Build the ssh2 connection config for a server definition.
function connectConfig(server) {
  const cfg = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    readyTimeout: server.readyTimeout || 20000,
    keepaliveInterval: 15000,
  };

  const keyPath = expandHome(server.privateKey);
  if (keyPath) {
    cfg.privateKey = fs.readFileSync(keyPath);
    if (server.passphrase) cfg.passphrase = server.passphrase;
  } else if (server.password) {
    cfg.password = server.password;
  } else if (process.env.SSH_AUTH_SOCK) {
    // Fall back to the ssh-agent.
    cfg.agent = process.env.SSH_AUTH_SOCK;
  }
  return cfg;
}

const pool = new Map(); // server.id -> { client, ready: Promise }

function getClient(server) {
  const existing = pool.get(server.id);
  if (existing) return existing.ready;

  const client = new Client();
  const ready = new Promise((resolve, reject) => {
    client.on('ready', () => resolve(client));
    client.on('error', (err) => {
      pool.delete(server.id);
      reject(err);
    });
    client.on('close', () => {
      pool.delete(server.id);
    });
    try {
      client.connect(connectConfig(server));
    } catch (err) {
      pool.delete(server.id);
      reject(err);
    }
  });

  pool.set(server.id, { client, ready });
  return ready;
}

function runCommand(server, cmd) {
  return getClient(server).then(
    (client) =>
      new Promise((resolve, reject) => {
        client.exec(cmd, (err, stream) => {
          if (err) return reject(err);
          let stdout = '';
          let stderr = '';
          stream.on('data', (d) => (stdout += d.toString('utf8')));
          stream.stderr.on('data', (d) => (stderr += d.toString('utf8')));
          stream.on('close', (code) => resolve({ code, stdout, stderr }));
          stream.on('error', reject);
        });
      })
  );
}

function forwardOut(server, dstHost, dstPort) {
  return getClient(server).then(
    (client) =>
      new Promise((resolve, reject) => {
        // srcIP/srcPort are informational for the origin of the forward.
        client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, stream) => {
          if (err) return reject(err);
          resolve(stream);
        });
      })
  );
}

module.exports = { getClient, runCommand, forwardOut, expandHome };
