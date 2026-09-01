# flantastic

A single web app to manage and view your remote machines from a browser:

- **Macs** — start/stop [`tart`](https://tart.run) VMs over SSH and view them via VNC
- **VNC devices** — any VNC server by `host:port`, e.g. an **iPhone/iPad running iOS with its VNC server enabled**
- **Proxmox** — list, start/stop, and open the console for QEMU VMs and LXC containers
- **Android** — mirror and control devices via **scrcpy** (H.264, decoded in the browser)

It runs on a **Linux host (e.g. Debian 13)** and is designed to be reachable
from remote machines (binds `0.0.0.0`). Everything is proxied through this one
app, so the machines it controls don't need to be exposed themselves.

```
browser ──HTTP/WebSocket──▶ flantastic (Debian) ──▶ SSH / adb / Proxmox API ──▶ your machines
```

## No `npm install`

flantastic uses **only Node.js built-ins** — no Node packages to install. The
browser VNC client (noVNC) is **vendored** into the repo, and the Android
scrcpy server binary ships in `vendor/`. The only things you need are Node and,
depending on which endpoints you use, a couple of system packages:

```bash
sudo apt update
sudo apt install -y nodejs            # the runtime
sudo apt install -y openssh-client    # for "mac" and gatewayed "vnc" endpoints
sudo apt install -y adb               # for "android" endpoints (a.k.a. android-tools-adb)
```

Then just:

```bash
git clone <this repo> && cd flantastic
cp endpoints.example.json endpoints.json
$EDITOR endpoints.json
node server.js         # → http://<host>:8080
```

## Configuring endpoints

Everything is driven by `endpoints.json` (see `endpoints.example.json` for a
full sample of all four types). It's a list of endpoints, each with a `type`.

### `mac` — tart VMs over SSH
```json
{ "id": "mac1", "type": "mac", "label": "Mac mini", "host": "10.0.0.50",
  "username": "brandon", "privateKey": "~/.ssh/id_ed25519", "tart": "tart" }
```
Discovers VMs with `tart list`. **Start** runs your command
(`nohup tart run <vm> --no-graphics --vnc-experimental > ~/vnc-<vm>.log 2>&1 &`),
**Stop** runs `tart stop`. The VM's VNC is tunnelled over the same SSH
connection — nothing on the Mac needs to bind to `0.0.0.0`.
Enable Remote Login on the Mac (System Settings → General → Sharing).

> `tart` is usually at `/opt/homebrew/bin`; flantastic prepends that (and
> `/usr/local/bin`) to `PATH` for the non-interactive SSH shell. Override the
> binary with the `tart` field if needed.

### `vnc` — any VNC server (e.g. iPhone / iOS 27)
```json
{ "id": "iphone", "type": "vnc", "label": "iPhone", "host": "10.0.0.71",
  "port": 5900, "password": "secret" }
```
Connects straight to a VNC server. For a device on a private LAN, reach it
through an SSH gateway instead of connecting directly:
```json
{ "id": "ipad", "type": "vnc", "host": "10.0.0.72", "port": 5900,
  "gateway": { "host": "10.0.0.50", "username": "brandon", "privateKey": "~/.ssh/id_ed25519" } }
```

### `proxmox` — QEMU + LXC guests
```json
{ "id": "pve", "type": "proxmox", "label": "Proxmox", "host": "10.0.0.10",
  "port": 8006, "verifyTls": false,
  "tokenId": "flantastic@pve!api", "tokenSecret": "xxxxxxxx-...." }
```
Lists guests across all nodes (or set `"node"` to pin one), starts/stops them,
and opens the console in-browser via Proxmox's `vncproxy` (flantastic relays the
VNC WebSocket). Use an **API token** (recommended) or `username`/`password`
(+ `realm`, default `pam`). Proxmox uses a self-signed cert by default, so
`verifyTls` defaults to `false`.

### `android` — scrcpy
```json
{ "id": "phones", "type": "android", "label": "Android", "adb": "adb",
  "maxSize": 1280, "maxFps": 30 }
```
Lists devices from `adb devices`. **Connect** pushes the vendored scrcpy server
to the device, streams H.264, and decodes it in the browser with **WebCodecs**;
touch, on-screen keys (Back/Home/Recents), and text input are sent back. Set
`"adbHost": "1.2.3.4:5555"` to `adb connect` a networked device first.

> **WebCodecs requires a secure context.** Android/scrcpy works over
> `http://localhost`, but from a remote machine you must serve flantastic over
> **HTTPS** (see TLS below). The other endpoint types work over plain HTTP.

## Running

| Env var         | Default          | Purpose |
|-----------------|------------------|---------|
| `HOST`          | `0.0.0.0`        | Bind address (remote-reachable by default). |
| `PORT`          | `8080`           | Listen port. |
| `ENDPOINTS_FILE`| `./endpoints.json` | Path to the config. |
| `AUTH_USER`     | `admin`          | Basic-auth user (only if a password is set). |
| `AUTH_PASSWORD` | *(unset)*        | If set, the whole app requires HTTP Basic auth. |
| `TLS_CERT` / `TLS_KEY` | *(unset)* | PEM cert/key paths. If both set, flantastic serves HTTPS (and WebSockets upgrade to `wss://`). |
| `LOG_LEVEL`     | `info`           | `error` \| `warn` \| `info` \| `debug`. `debug` logs every SSH command, adb step, and Proxmox call. |

## Logging & troubleshooting

flantastic logs to stdout/stderr, so `journalctl -u flantastic -f` (or the
terminal) shows what it's doing: each API call with status + timing, every SSH
command and its exit code, adb/scrcpy steps, Proxmox requests, and WebSocket
connect/close. Set `LOG_LEVEL=debug` for full detail.

In the web UI, Mac VMs have a **Log** button that shows `~/vnc-<vm>.log` on the
Mac — the tart output plus the `vnc://` URL. If a VM won't start or won't
connect, check that log first: it usually says exactly why (e.g. the VM name,
a missing `tart`, or that VNC isn't up yet). The VNC viewer also **waits and
retries** for ~50s while a VM boots rather than failing immediately.

### As a systemd service (Debian)
See [`flantastic.service`](./flantastic.service):
```bash
sudo cp -r . /opt/flantastic
sudo cp flantastic.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now flantastic
```

### Enabling TLS (for remote Android/scrcpy)
A self-signed cert is enough for a private network:
```bash
mkdir -p tls
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout tls/key.pem -out tls/cert.pem -subj "/CN=flantastic"
TLS_CERT=tls/cert.pem TLS_KEY=tls/key.pem node server.js
```

## Security

Because it binds `0.0.0.0`, anyone who can reach the port can control these
machines and view their screens. Protect it:

- Set **`AUTH_PASSWORD`** (and `AUTH_USER`).
- Prefer a private network / VPN, and enable **TLS** so credentials and screens
  aren't sent in the clear.
- SSH endpoints use `StrictHostKeyChecking=accept-new` and connection
  multiplexing; use key-based auth.

## Viewer controls (VNC)

The VNC viewer toolbar has:

- **Ctrl+Alt+Del** and a **⌨ Keys** menu that sends special key combinations
  straight to the remote (bypassing your local OS), grouped for **Windows**
  (Win, Win+D/E/R/L, Ctrl+Shift+Esc, Alt+F4…), **macOS** (⌘Space, ⌘Tab, ⌘Q,
  ⌃⌘Q lock, ⌘⇧3/4…), plus common keys and **F1–F12**.
- **📷 Screenshot** — saves a PNG of the current screen.
- **⛶ Fullscreen**.

For full keyboard fidelity (all OS shortcuts, no browser sandbox), each VNC
item also has a **VNC app** button. It shows the address + password for a
native VNC client, a clickable `vnc://…` link (opens **Screen Sharing** on
macOS), and an SSH-tunnel command for a private connection. tart's VNC binds
on all interfaces, so `<mac-ip>:<port>` is reachable directly; the port
changes every VM start, so reopen it after a restart.

## Behind a reverse proxy (nginx)

flantastic's screens ride over **WebSockets** (`/ws/…`). A reverse proxy must be
told to pass the WebSocket upgrade, or connect will hang forever at
"connecting" while plain HTTP still works. For nginx:

```nginx
# http { } context, once:
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;                 # TLS here also gives scrcpy its secure context
    server_name flan.example;
    # ssl_certificate ... ; ssl_certificate_key ... ;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;      # <-- the WebSocket upgrade
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_buffering off;                            # don't stall the video streams
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Caddy (`reverse_proxy 127.0.0.1:8080`) and Traefik upgrade WebSockets
automatically. If you terminate TLS at the proxy you can drop flantastic's own
`TLS_CERT`/`TLS_KEY`.

## Adding more machines

Add another object to `endpoints.json` and refresh — no code changes. New Macs,
iPhones, Proxmox clusters, and Android devices all slot in as endpoints.

## Layout

```
server.js              HTTP + WebSocket server, routing, config
lib/ws.js              WebSocket server (RFC 6455) — no deps
lib/wsclient.js        WebSocket client (used to relay Proxmox consoles)
lib/http.js            tiny router + static file serving
lib/ssh.js             system `ssh` wrapper (exec + `-W` tunnel)
lib/bridge.js          WebSocket <-> byte-stream bridge
providers/mac.js       tart-over-SSH provider
providers/vnc.js       generic VNC provider (iPhone, etc.)
providers/proxmox.js   Proxmox REST + console provider
providers/android.js   adb + scrcpy provider
public/                UI, the VNC viewer, the scrcpy viewer
public/vendor/novnc/   vendored noVNC (MPL-2.0)
vendor/scrcpy-server-* vendored scrcpy server (Apache-2.0)
```

## Credits

- [noVNC](https://github.com/novnc/noVNC) — in-browser VNC client (MPL-2.0), vendored under `public/vendor/novnc/`.
- [scrcpy](https://github.com/Genymobile/scrcpy) — Android mirroring (Apache-2.0); the server binary is vendored under `vendor/`.
