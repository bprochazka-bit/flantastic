'use strict';

/*
 * Minimal WebSocket server (RFC 6455) using only Node built-ins.
 *
 * Enough for our needs: binary + text frames, ping/pong, close, and
 * fragmentation. No permessage-deflate. Server->client frames are unmasked;
 * client->server frames are unmasked here (we require masking per spec).
 *
 * Usage:
 *   const ws = accept(req, socket);   // performs the handshake
 *   ws.on('message', (buf, isBinary) => ...);
 *   ws.on('close', () => ...);
 *   ws.send(buffer);                  // binary
 *   ws.close(code, reason);
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = 1; // OPEN
    this.OPEN = 1;
    this._buf = Buffer.alloc(0);
    this._fragOpcode = null;
    this._fragChunks = [];

    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._onClose());
    socket.on('error', (err) => this.emit('error', err));
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    // Parse as many complete frames as are buffered.
    for (;;) {
      const frame = this._parseFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  _parseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(64 * 1024 * 1024)) {
        this.close(1009, 'Frame too large');
        return null;
      }
      len = Number(big);
      offset += 8;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.slice(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null; // wait for full payload

    let payload = buf.slice(offset, offset + len);
    if (masked && len > 0) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }

    this._buf = buf.slice(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODE.PING:
        this._writeFrame(OPCODE.PONG, payload);
        return;
      case OPCODE.PONG:
        return;
      case OPCODE.CLOSE:
        this.close();
        return;
      case OPCODE.CONT:
        if (this._fragOpcode == null) return; // protocol error, ignore
        this._fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragChunks);
          const isBin = this._fragOpcode === OPCODE.BIN;
          this._fragOpcode = null;
          this._fragChunks = [];
          this.emit('message', full, isBin);
        }
        return;
      case OPCODE.TEXT:
      case OPCODE.BIN:
        if (!fin) {
          this._fragOpcode = opcode;
          this._fragChunks = [payload];
          return;
        }
        this.emit('message', payload, opcode === OPCODE.BIN);
        return;
      default:
        return;
    }
  }

  _writeFrame(opcode, payload = Buffer.alloc(0)) {
    if (this.readyState !== 1 && opcode !== OPCODE.CLOSE) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode, no mask (server->client)
    try {
      this.socket.write(header);
      if (len) this.socket.write(payload);
      return true;
    } catch (_) {
      return false;
    }
  }

  send(data, binary = true) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return this._writeFrame(binary ? OPCODE.BIN : OPCODE.TEXT, buf);
  }

  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    let payload = Buffer.alloc(0);
    if (typeof code === 'number') {
      const r = reason ? Buffer.from(String(reason)) : Buffer.alloc(0);
      payload = Buffer.allocUnsafe(2 + r.length);
      payload.writeUInt16BE(code, 0);
      r.copy(payload, 2);
    }
    this._writeFrame(OPCODE.CLOSE, payload);
    try { this.socket.end(); } catch (_) {}
    this.emit('close');
  }

  _onClose() {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.emit('close');
    }
  }
}

// Perform the upgrade handshake and return a WebSocketConnection.
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return null;
  }
  const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );
  socket.setNoDelay(true);
  return new WebSocketConnection(socket);
}

module.exports = { accept, WebSocketConnection };
