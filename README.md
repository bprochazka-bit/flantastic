# flantastic

A small web app for starting, stopping, and connecting to
[`tart`](https://tart.run) VMs on one or more Macs — from your browser.

The app runs on a **Linux box (e.g. Debian 13)** and drives each Mac **over
SSH**. VNC is tunnelled through the same SSH connection and rendered in the
browser with [noVNC](https://novnc.com), so **only this web app needs to be
reachable from remote machines** — nothing on the Macs has to be exposed.

```
browser ──HTTP/WebSocket──▶ flantastic (Debian) ──SSH──▶ Mac ──▶ tart VM (VNC)
```

## What it does

- Lists local VMs on each Mac and their state (via `tart list`).
- **Start** a VM using your command:
  `nohup tart run <vm> --no-graphics --vnc-experimental > ~/vnc-<vm>.log 2>&1 &`
- **Stop** a VM (`tart stop <vm>`).
- **Connect VNC** — opens an in-browser VNC viewer. flantastic reads the
  `vnc://` URL that tart writes to `~/vnc-<vm>.log`, tunnels that port over
  SSH, and hands the auto-generated password to the browser.

## Requirements

- **Linux host:** Node.js 18+.
- **Each Mac:** Apple Silicon, `tart` installed, and SSH enabled
  (System Settings → General → Sharing → Remote Login). Key-based SSH auth
  is strongly recommended.

## Setup

```bash
git clone <this repo>
cd flantastic
npm install

cp servers.example.json servers.json
$EDITOR servers.json          # add your Mac(s)
```

`servers.json` — add one entry per Mac (add more later for extra Macs):

```json
{
  "servers": [
    {
      "id": "mac1",
      "label": "Mac mini (office)",
      "host": "10.0.0.50",
      "port": 22,
      "username": "brandon",
      "privateKey": "~/.ssh/id_ed25519",
      "tart": "tart"
    }
  ]
}
```

| Field        | Notes |
|--------------|-------|
| `id`         | Unique short id (used in URLs). |
| `label`      | Display name in the UI. |
| `host`/`port`| SSH address of the Mac. |
| `username`   | SSH user on the Mac. |
| `privateKey` | Path to an SSH private key. Omit to use `password`, or the `ssh-agent` (`SSH_AUTH_SOCK`). |
| `passphrase` | Passphrase for the key, if any. |
| `password`   | SSH password (use a key instead where possible). |
| `tart`       | Path to the `tart` binary. Defaults to `tart`; flantastic also prepends `/opt/homebrew/bin` and `/usr/local/bin` to `PATH`, which covers a standard Homebrew install. |

## Run

```bash
npm start
# → http://<debian-host>:8080
```

Environment variables:

| Var             | Default            | Purpose |
|-----------------|--------------------|---------|
| `HOST`          | `0.0.0.0`          | Bind address. `0.0.0.0` makes it reachable from remote machines. |
| `PORT`          | `8080`             | Listen port. |
| `SERVERS_FILE`  | `./servers.json`   | Path to the servers config. |
| `AUTH_USER`     | `admin`            | Basic-auth username (only if a password is set). |
| `AUTH_PASSWORD` | *(unset)*          | If set, the whole app requires HTTP Basic auth. |

### Run as a service (Debian)

An example unit is in [`flantastic.service`](./flantastic.service):

```bash
sudo cp -r . /opt/flantastic
sudo cp flantastic.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now flantastic
```

## Security

Because the app is bound to `0.0.0.0`, anyone who can reach the port can
start/stop your VMs and view their screens. Protect it:

- Set **`AUTH_PASSWORD`** (and `AUTH_USER`) to require a login.
- Better still, keep it on a private network / VPN, or put it behind a
  reverse proxy with TLS (the VNC WebSocket then upgrades to `wss://`
  automatically).

## Notes on `tart` VNC

`tart run --vnc-experimental` starts a VNC server bound to the Mac's
loopback and prints a `vnc://:<password>@<host>:<port>` line. flantastic
reads that from `~/vnc-<vm>.log` and reaches it through the SSH tunnel — so
you do **not** need to bind VNC itself to `0.0.0.0` on the Mac. Only this web
app is exposed remotely.
