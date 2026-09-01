'use strict';

/*
 * Android provider: mirror + control a device using the scrcpy server (v2.7),
 * driven over `adb` (apt: adb / android-tools-adb). No npm deps.
 *
 * Pipeline:
 *   adb push scrcpy-server -> device, start it (tunnel_forward), then connect
 *   a video socket and a control socket over `adb forward`. flantastic parses
 *   the scrcpy stream and relays to the browser:
 *     - one JSON "meta" text message  ({codec,width,height,name})
 *     - then one binary message per H.264 access unit:
 *         [flags u8][pts u64 BE][h264 bytes]   flags: bit0=config bit1=keyframe
 *   The browser decodes with WebCodecs. Browser -> flantastic text messages are
 *   input events, re-encoded to scrcpy control messages.
 *
 * scrcpy is a trademark of its authors; the vendored server binary is theirs
 * (Apache-2.0). See vendor/ and README.
 */

const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');

const SCRCPY_VERSION = '2.7';
const SCRCPY_JAR = path.join(__dirname, '..', 'vendor', `scrcpy-server-v${SCRCPY_VERSION}`);
const DEVICE_JAR = '/data/local/tmp/scrcpy-server-flantastic.jar';

function adbBin(ep) { return ep.adb || 'adb'; }

function adb(ep, args, serial) {
  const full = serial ? ['-s', serial, ...args] : args;
  return new Promise((resolve) => {
    const child = spawn(adbBin(ep), full, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Try to connect to 127.0.0.1:port a few times (server may not be listening yet).
function connectRetry(port, attempts = 40) {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', () => {
        s.destroy();
        if (n <= 0) return reject(new Error('scrcpy socket connect failed'));
        setTimeout(() => tryOnce(n - 1), 50);
      });
    };
    tryOnce(attempts);
  });
}

// ---- scrcpy control message encoders (subset) -----------------------------

// INJECT_TOUCH_EVENT (type 2), 32 bytes.
function touchMsg({ action, pointerId = 0, x, y, width, height, pressure, buttons }) {
  const b = Buffer.alloc(32);
  let o = 0;
  b.writeUInt8(2, o); o += 1;
  b.writeUInt8(action, o); o += 1;               // 0=down 1=up 2=move
  b.writeBigUInt64BE(BigInt(pointerId), o); o += 8;
  b.writeInt32BE(x | 0, o); o += 4;
  b.writeInt32BE(y | 0, o); o += 4;
  b.writeUInt16BE(width & 0xffff, o); o += 2;
  b.writeUInt16BE(height & 0xffff, o); o += 2;
  b.writeUInt16BE(Math.round((pressure ?? 0) * 0xffff), o); o += 2;
  b.writeInt32BE(0, o); o += 4;                   // action button
  b.writeInt32BE(buttons | 0, o); o += 4;         // buttons
  return b;
}

// INJECT_KEYCODE (type 0), 14 bytes.
function keyMsg({ action, keycode, repeat = 0, metaState = 0 }) {
  const b = Buffer.alloc(14);
  let o = 0;
  b.writeUInt8(0, o); o += 1;
  b.writeUInt8(action, o); o += 1;                // 0=down 1=up
  b.writeInt32BE(keycode, o); o += 4;
  b.writeInt32BE(repeat, o); o += 4;
  b.writeInt32BE(metaState, o); o += 4;
  return b;
}

// INJECT_TEXT (type 1).
function textMsg(text) {
  const t = Buffer.from(text, 'utf8');
  const b = Buffer.alloc(1 + 4 + t.length);
  b.writeUInt8(1, 0);
  b.writeUInt32BE(t.length, 1);
  t.copy(b, 5);
  return b;
}

// BACK_OR_SCREEN_ON etc via keycode; expose a couple of common keys.
const KEYCODES = { back: 4, home: 3, appswitch: 187, power: 26, volup: 24, voldown: 25 };

// ---- video stream parser --------------------------------------------------

// Parses: [dummy 1][device name 64][codec id 4][width 4][height 4] then frames
// of [pts+flags 8][size 4][data size]. Emits meta + frames via callbacks.
function makeVideoParser(onMeta, onFrame) {
  let buf = Buffer.alloc(0);
  let phase = 'dummy';
  let meta = {};
  return function feed(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (phase === 'dummy') {
        if (buf.length < 1) return;
        buf = buf.slice(1);
        phase = 'name';
      } else if (phase === 'name') {
        if (buf.length < 64) return;
        meta.name = buf.slice(0, 64).toString('utf8').replace(/\0+$/, '');
        buf = buf.slice(64);
        phase = 'codec';
      } else if (phase === 'codec') {
        if (buf.length < 12) return;
        const codecId = buf.readUInt32BE(0);
        meta.width = buf.readUInt32BE(4);
        meta.height = buf.readUInt32BE(8);
        meta.codec = codecId === 0x68323634 ? 'h264' : codecId === 0x68323635 ? 'h265' : 'h264';
        buf = buf.slice(12);
        phase = 'frame';
        onMeta(meta);
      } else if (phase === 'frame') {
        if (buf.length < 12) return;
        const ptsAndFlags = buf.readBigUInt64BE(0);
        const size = buf.readUInt32BE(8);
        if (buf.length < 12 + size) return;
        const data = buf.slice(12, 12 + size);
        buf = buf.slice(12 + size);
        const CONFIG = 1n << 63n;
        const KEY = 1n << 62n;
        const flags = (ptsAndFlags & CONFIG ? 1 : 0) | (ptsAndFlags & KEY ? 2 : 0);
        const pts = ptsAndFlags & ~(CONFIG | KEY);
        onFrame(flags, pts, data);
      }
    }
  };
}

// ---- provider --------------------------------------------------------------

module.exports = {
  type: 'android',

  async list(ep) {
    if (ep.adbHost) await adb(ep, ['connect', ep.adbHost]); // network adb, optional
    const { stdout } = await adb(ep, ['devices', '-l']);
    const items = [];
    for (const line of stdout.split('\n').slice(1)) {
      const m = line.match(/^(\S+)\s+(device|offline|unauthorized)\b(.*)$/);
      if (!m) continue;
      const serial = m[1];
      const model = (m[3].match(/model:(\S+)/) || [])[1];
      const state = m[2];
      items.push({
        id: serial,
        name: model ? `${model.replace(/_/g, ' ')}` : serial,
        detail: serial,
        state: state === 'device' ? 'online' : state,
        viewer: 'scrcpy',
        capabilities: { start: false, stop: false, connect: state === 'device' },
      });
    }
    return items;
  },

  async start() { throw new Error('Android devices cannot be started/stopped'); },
  async stop() { throw new Error('Android devices cannot be started/stopped'); },

  async connectInfo() { return { viewer: 'scrcpy' }; },

  async bridge(ws, ep, serial) {
    const cleanup = [];
    const done = (msg) => {
      while (cleanup.length) { try { cleanup.pop()(); } catch (_) {} }
      if (ws.readyState === ws.OPEN) ws.close(1011, msg || undefined);
    };

    try {
      // 1. Push the server binary.
      const push = await adb(ep, ['push', SCRCPY_JAR, DEVICE_JAR], serial);
      if (push.code !== 0) return done('adb push failed: ' + push.stderr.trim());

      // 2. Allocate a forwarded port to the scrcpy abstract socket.
      const scid = crypto.randomBytes(4).toString('hex');
      const sockName = `localabstract:scrcpy_${scid}`;
      const fwd = await adb(ep, ['forward', 'tcp:0', sockName], serial);
      if (fwd.code !== 0) return done('adb forward failed: ' + fwd.stderr.trim());
      const localPort = parseInt(fwd.stdout.trim(), 10);
      cleanup.push(() => adb(ep, ['forward', '--remove', `tcp:${localPort}`], serial));

      // 3. Start the scrcpy server (tunnel_forward: the client connects in).
      const serverArgs = [
        'shell',
        `CLASSPATH=${DEVICE_JAR}`,
        'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_VERSION,
        `scid=${scid}`,
        'log_level=error',
        'tunnel_forward=true',
        'audio=false',
        'control=true',
        'video=true',
        'video_codec=h264',
        `max_size=${ep.maxSize || 1280}`,
        `max_fps=${ep.maxFps || 30}`,
        'send_dummy_byte=true',
        'send_device_meta=true',
        'send_frame_meta=true',
        'send_codec_meta=true',
        'cleanup=true',
      ];
      const server = spawn(adbBin(ep), ['-s', serial, ...serverArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
      server.stdout.on('data', () => {});
      server.stderr.on('data', () => {});
      cleanup.push(() => { try { server.kill(); } catch (_) {} });

      // 4. Connect video socket, then control socket.
      const videoSock = await connectRetry(localPort);
      cleanup.push(() => videoSock.destroy());
      const controlSock = await connectRetry(localPort, 20);
      cleanup.push(() => controlSock.destroy());

      let width = 0, height = 0;
      const parser = makeVideoParser(
        (meta) => {
          width = meta.width; height = meta.height;
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'meta', ...meta }), false);
        },
        (flags, pts, data) => {
          if (ws.readyState !== ws.OPEN) return;
          const head = Buffer.alloc(9);
          head.writeUInt8(flags, 0);
          head.writeBigUInt64BE(pts, 1);
          ws.send(Buffer.concat([head, data]));
        }
      );
      videoSock.on('data', parser);
      videoSock.on('close', () => done());
      videoSock.on('error', () => done());

      // 5. Browser -> device input events (text JSON) -> scrcpy control msgs.
      ws.on('message', (data, isBinary) => {
        if (isBinary || !controlSock.writable) return;
        let ev;
        try { ev = JSON.parse(data.toString('utf8')); } catch (_) { return; }
        try {
          if (ev.t === 'touch') {
            controlSock.write(touchMsg({
              action: ev.action, x: ev.x, y: ev.y, width, height,
              pressure: ev.action === 1 ? 0 : 1,
              buttons: ev.action === 1 ? 0 : 1,
            }));
          } else if (ev.t === 'key' && KEYCODES[ev.key] != null) {
            controlSock.write(keyMsg({ action: 0, keycode: KEYCODES[ev.key] }));
            controlSock.write(keyMsg({ action: 1, keycode: KEYCODES[ev.key] }));
          } else if (ev.t === 'text' && typeof ev.text === 'string') {
            controlSock.write(textMsg(ev.text));
          }
        } catch (_) {}
      });
      ws.on('close', () => done());
      ws.on('error', () => done());
    } catch (err) {
      done(String(err.message || err));
    }
  },
};
