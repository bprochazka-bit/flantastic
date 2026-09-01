'use strict';

/*
 * Mac provider: manage `tart` VMs on a Mac over SSH, and view them via the
 * VM's experimental VNC server (tunnelled over the same SSH connection).
 */

const ssh = require('../lib/ssh');
const { bridgeRaw } = require('../lib/bridge');

// tart is usually under Homebrew; a non-interactive ssh shell often lacks it
// on PATH, so prepend the common locations. Override with endpoint.tart.
function tartCmd(ep, args) {
  const bin = ep.tart || 'tart';
  return `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ${bin} ${args}`;
}

const logPath = (vm) => `~/vnc-${vm}.log`;

async function readVncUrl(ep, vm) {
  const { stdout } = await ssh.run(ep, `cat ${logPath(vm)} 2>/dev/null || true`);
  const matches = stdout.match(/vnc:\/\/\S+/g);
  if (!matches || !matches.length) return null;
  const raw = matches[matches.length - 1].trim();
  try {
    const u = new URL(raw);
    return { host: u.hostname || '127.0.0.1', port: parseInt(u.port || '5900', 10), password: decodeURIComponent(u.password || '') };
  } catch (_) {
    const m = raw.match(/vnc:\/\/(?:([^:@]*):?([^@]*)@)?([^:/]+):(\d+)/);
    if (!m) return null;
    return { host: m[3] || '127.0.0.1', port: parseInt(m[4], 10), password: m[2] || '' };
  }
}

module.exports = {
  type: 'mac',

  async list(ep) {
    const { code, stdout, stderr } = await ssh.run(ep, tartCmd(ep, 'list --format json'));
    if (code !== 0) throw new Error(`tart list failed: ${stderr.trim() || 'exit ' + code}`);
    let rows = [];
    try { rows = JSON.parse(stdout); } catch (_) {}
    return rows
      .filter((r) => (r.Source || 'local') === 'local')
      .map((r) => {
        const state = (r.State || 'unknown').toLowerCase();
        return {
          id: r.Name,
          name: r.Name,
          state,
          viewer: 'vnc',
          capabilities: { start: state !== 'running', stop: state === 'running', connect: state === 'running' },
        };
      });
  },

  async start(ep, vm) {
    const run = tartCmd(ep, `run ${vm} --no-graphics --vnc-experimental`);
    // Truncate the log first so we only read this run's VNC URL, then:
    //   nohup tart run <vm> --no-graphics --vnc-experimental > ~/vnc-<vm>.log 2>&1 &
    const cmd = `sh -lc ': > ${logPath(vm)}; nohup ${run} > ${logPath(vm)} 2>&1 &'`;
    const { code, stderr } = await ssh.run(ep, cmd);
    if (code !== 0) throw new Error(`Failed to start ${vm}: ${stderr.trim() || 'exit ' + code}`);
    return { ok: true };
  },

  async stop(ep, vm) {
    const { code, stderr } = await ssh.run(ep, tartCmd(ep, `stop ${vm}`));
    if (code !== 0) throw new Error(`Failed to stop ${vm}: ${stderr.trim() || 'exit ' + code}`);
    return { ok: true };
  },

  async connectInfo(ep, vm) {
    const info = await readVncUrl(ep, vm);
    if (!info) throw new Error('VNC not ready yet. Start the VM and wait a few seconds.');
    return { viewer: 'vnc', password: info.password };
  },

  async bridge(ws, ep, vm) {
    const info = await readVncUrl(ep, vm);
    if (!info) return ws.close(1011, 'VNC not ready');
    const child = ssh.tunnel(ep, info.host, info.port);
    child.stderr.on('data', () => {}); // swallow ssh diagnostics
    child.on('error', () => ws.readyState === ws.OPEN && ws.close(1011, 'ssh tunnel failed'));
    bridgeRaw(ws, child.stdout, child.stdin, () => child.kill());
  },
};
