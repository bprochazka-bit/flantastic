'use strict';

/*
 * SSH via the system `ssh` binary (apt: openssh-client) — no npm deps.
 *
 *   run(server, cmd)          -> { code, stdout, stderr }
 *   tunnel(server, host, port)-> a child_process whose stdio is a raw pipe to
 *                                host:port on the remote (via `ssh -W`).
 *
 * ControlMaster multiplexing keeps repeated commands fast (one TCP/auth per
 * server, reused).
 */

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Common ssh options for a server definition.
function baseArgs(server) {
  const ctl = path.join(os.tmpdir(), 'flantastic-%r@%h:%p');
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${server.connectTimeout || 10}`,
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${ctl}`,
    '-o', 'ControlPersist=60',
    '-p', String(server.port || 22),
  ];
  const key = expandHome(server.privateKey);
  if (key) args.push('-i', key);
  return args;
}

function target(server) {
  return `${server.username}@${server.host}`;
}

function run(server, command) {
  return new Promise((resolve, reject) => {
    const args = [...baseArgs(server), target(server), '--', command];
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Returns a child process. child.stdout = bytes FROM host:port,
// child.stdin  = bytes TO host:port. Uses ssh's netcat mode (-W).
function tunnel(server, host, port) {
  const args = [...baseArgs(server), '-W', `${host}:${port}`, target(server)];
  return spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

module.exports = { run, tunnel, expandHome, baseArgs, target };
