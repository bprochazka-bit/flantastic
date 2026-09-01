'use strict';

/*
 * Generic VNC provider: connect to any VNC server by host:port — e.g. an
 * iPhone/iPad running iOS with its VNC server enabled, a standalone VNC box,
 * or a Mac's Screen Sharing. Optionally reach it through an SSH gateway
 * (endpoint.gateway) instead of connecting directly.
 *
 * An endpoint of this type is a single "screen" item (no start/stop).
 */

const net = require('net');
const ssh = require('../lib/ssh');
const { bridgeRaw } = require('../lib/bridge');

module.exports = {
  type: 'vnc',

  async list(ep) {
    return [
      {
        id: 'screen',
        name: ep.deviceName || ep.label || ep.host,
        state: 'available',
        viewer: 'vnc',
        capabilities: { start: false, stop: false, connect: true, native: !ep.gateway },
      },
    ];
  },

  async start() { throw new Error('VNC endpoints cannot be started/stopped'); },
  async stop() { throw new Error('VNC endpoints cannot be started/stopped'); },

  async connectInfo(ep) {
    return { viewer: 'vnc', password: ep.password || '' };
  },

  // Native client details (only meaningful for directly-reachable endpoints;
  // gatewayed ones are hidden behind SSH and use the browser viewer).
  async native(ep) {
    const port = parseInt(ep.port || '5900', 10);
    const pw = ep.password ? `:${encodeURIComponent(ep.password)}@` : '';
    return {
      address: `${ep.host}:${port}`,
      password: ep.password || '',
      url: `vnc://${pw}${ep.host}:${port}`,
    };
  },

  async bridge(ws, ep) {
    const host = ep.host;
    const port = parseInt(ep.port || '5900', 10);

    if (ep.gateway) {
      // Tunnel through an SSH gateway (e.g. reach an iPhone on a private LAN).
      const child = ssh.tunnel(ep.gateway, host, port);
      child.stderr.on('data', () => {});
      child.on('error', () => ws.readyState === ws.OPEN && ws.close(1011, 'ssh tunnel failed'));
      bridgeRaw(ws, child.stdout, child.stdin, () => child.kill());
      return;
    }

    const sock = net.connect(port, host);
    sock.on('error', () => ws.readyState === ws.OPEN && ws.close(1011, 'VNC connect failed'));
    bridgeRaw(ws, sock, sock, () => sock.destroy());
  },
};
