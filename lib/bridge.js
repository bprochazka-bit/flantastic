'use strict';

/*
 * Bridge a WebSocket connection to a raw byte stream (a TCP socket, an ssh
 * tunnel child's stdio, etc). Bytes flow both directions unchanged — this is
 * what carries the VNC (RFB) protocol between the browser's noVNC and the
 * remote VNC server.
 */

// readable: stream of bytes FROM the remote. writable: bytes TO the remote.
// onClose: optional cleanup.
function bridgeRaw(ws, readable, writable, onClose) {
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { if (onClose) onClose(); } catch (_) {}
  };

  readable.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  readable.on('close', () => {
    if (ws.readyState === ws.OPEN) ws.close();
    cleanup();
  });
  readable.on('error', () => {
    if (ws.readyState === ws.OPEN) ws.close(1011, 'stream error');
    cleanup();
  });

  ws.on('message', (data) => {
    if (writable.writable) writable.write(data);
  });
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

module.exports = { bridgeRaw };
