'use strict';

/*
 * Minimal WebSocket client (RFC 6455) over TLS/TCP using Node built-ins.
 * Used to relay to Proxmox's vncwebsocket endpoint. Client->server frames are
 * masked (per spec); server->client frames are unmasked.
 *
 *   const c = new WSClient(url, { headers, rejectUnauthorized });
 *   c.on('open', ...); c.on('message', (buf) => ...); c.on('close', ...);
 *   c.send(buffer);
 */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { URL } = require('url');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WSClient extends EventEmitter {
  constructor(url, opts = {}) {
    super();
    this.readyState = 0;
    this.OPEN = 1;
    this._buf = Buffer.alloc(0);
    this._handshakeDone = false;
    this._frag = [];
    this._fragOp = null;

    const u = new URL(url);
    const secure = u.protocol === 'wss:';
    const port = u.port ? parseInt(u.port, 10) : secure ? 443 : 80;
    const key = crypto.randomBytes(16).toString('base64');
    this._acceptExpected = crypto.createHash('sha1').update(key + GUID).digest('base64');

    const connect = secure ? tls.connect : net.connect;
    const connOpts = secure
      ? { host: u.hostname, port, servername: u.hostname, rejectUnauthorized: opts.rejectUnauthorized !== false }
      : { host: u.hostname, port };

    this.socket = connect(connOpts, () => {
      const headers = [
        `GET ${u.pathname}${u.search} HTTP/1.1`,
        `Host: ${u.hostname}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      if (opts.subprotocol) headers.push(`Sec-WebSocket-Protocol: ${opts.subprotocol}`);
      for (const [k, v] of Object.entries(opts.headers || {})) headers.push(`${k}: ${v}`);
      this.socket.write(headers.join('\r\n') + '\r\n\r\n');
    });

    this.socket.setNoDelay(true);
    this.socket.on('data', (d) => this._onData(d));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => {
      if (this.readyState !== 3) { this.readyState = 3; this.emit('close'); }
    });
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    if (!this._handshakeDone) {
      const idx = this._buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = this._buf.slice(0, idx).toString('utf8');
      this._buf = this._buf.slice(idx + 4);
      if (!/HTTP\/1\.1 101/.test(head)) {
        this.emit('error', new Error('WebSocket handshake failed: ' + head.split('\r\n')[0]));
        this.socket.destroy();
        return;
      }
      this._handshakeDone = true;
      this.readyState = 1;
      this.emit('open');
    }
    for (;;) {
      const f = this._parse();
      if (!f) break;
      this._handle(f);
    }
  }

  _parse() {
    const buf = this._buf;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0; // server frames should not be masked
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < off + 2) return null; len = buf.readUInt16BE(off); off += 2; }
    else if (len === 127) { if (buf.length < off + 8) return null; len = Number(buf.readBigUInt64BE(off)); off += 8; }
    let mask = null;
    if (masked) { if (buf.length < off + 4) return null; mask = buf.slice(off, off + 4); off += 4; }
    if (buf.length < off + len) return null;
    let payload = buf.slice(off, off + len);
    if (masked && len) { const o = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ mask[i & 3]; payload = o; }
    this._buf = buf.slice(off + len);
    return { fin, opcode, payload };
  }

  _handle({ fin, opcode, payload }) {
    if (opcode === OP.PING) return this._frame(OP.PONG, payload);
    if (opcode === OP.PONG) return;
    if (opcode === OP.CLOSE) { this.close(); return; }
    if (opcode === OP.CONT) {
      this._frag.push(payload);
      if (fin) { const full = Buffer.concat(this._frag); const bin = this._fragOp === OP.BIN; this._frag = []; this._fragOp = null; this.emit('message', full, bin); }
      return;
    }
    if (opcode === OP.TEXT || opcode === OP.BIN) {
      if (!fin) { this._fragOp = opcode; this._frag = [payload]; return; }
      this.emit('message', payload, opcode === OP.BIN);
    }
  }

  _frame(opcode, payload = Buffer.alloc(0)) {
    if (this.readyState === 3) return false;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.allocUnsafe(2 + 4);
    else if (len < 65536) { header = Buffer.allocUnsafe(4 + 4); }
    else header = Buffer.allocUnsafe(10 + 4);
    header[0] = 0x80 | opcode;
    let off;
    if (len < 126) { header[1] = 0x80 | len; off = 2; }
    else if (len < 65536) { header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); off = 4; }
    else { header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); off = 10; }
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(header, off);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ maskKey[i & 3];
    try { this.socket.write(header); if (len) this.socket.write(masked); return true; } catch (_) { return false; }
  }

  send(data, binary = true) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return this._frame(binary ? OP.BIN : OP.TEXT, buf);
  }

  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    let payload = Buffer.alloc(0);
    if (typeof code === 'number') {
      const r = reason ? Buffer.from(String(reason)) : Buffer.alloc(0);
      payload = Buffer.allocUnsafe(2 + r.length);
      payload.writeUInt16BE(code, 0); r.copy(payload, 2);
    }
    this._frame(OP.CLOSE, payload);
    try { this.socket.end(); } catch (_) {}
    this.emit('close');
  }
}

module.exports = { WSClient };
