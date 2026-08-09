# Self-hosting OpenFit

OpenFit runs as a desktop app and as a small HTTP server. Both use the same
backend — the desktop app starts the server on loopback and points a window at
it — so hosting adds a way in, not a second implementation.

Use this when you want the dashboard on your phone or another laptop over
Tailscale.

## Start the server

```bash
npm install
npm run serve
```

`npm run serve` builds the renderer and starts the server on port 7788, bound to
all interfaces. It prints one URL per reachable address, Tailscale addresses
first:

```text
  OpenFit server
  data     /home/you/.local/share/openfit
  storage  aes-256-gcm
  agents   codex, claude-code*

  Open one of these (the token is stored as a cookie on first visit):
    http://100.92.14.7:7788/?token=8f3c…
    http://192.168.1.20:7788/?token=8f3c…
    http://127.0.0.1:7788/?token=8f3c…
```

Open the Tailscale URL on your phone. The token moves into an `HttpOnly` cookie
on the first request, so it stops appearing in the address bar and history.

### Options

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--host` | `OPENFIT_HOST` | `0.0.0.0` |
| `--port` | `OPENFIT_PORT` | `7788` |
| `--data-dir` | `OPENFIT_DATA_DIR` | platform data directory (see below) |
| `--token-file` | `OPENFIT_SERVER_TOKEN` | generated at `<data-dir>/server-token` |
| — | `OPENFIT_PUBLIC_ORIGIN` | unset |

Default data directory:

| Platform | Path |
| --- | --- |
| Linux | `$XDG_DATA_HOME/openfit`, else `~/.local/share/openfit` |
| macOS | `~/Library/Application Support/OpenFit` |
| Windows | `%APPDATA%\OpenFit` |

To bind only to your tailnet address rather than every interface:

```bash
npm run serve -- --host 100.92.14.7
```

## Access control

The server generates a 32-byte token on first run and stores it at
`<data-dir>/server-token` with `0600` permissions. Every `/api/*` route and the
app shell itself require it, presented as the `openfit_token` cookie or an
`Authorization: Bearer` header. Comparison is constant-time.

Tailscale membership is not treated as sufficient on its own: the token means a
misconfigured ACL, a shared node, or another device on the tailnet cannot read
your health data or trigger a sync.

To pin a token you manage yourself:

```bash
OPENFIT_SERVER_TOKEN="$(openssl rand -hex 32)" npm run serve
```

## Connecting a health account

Google accepts only an `http://127.0.0.1` loopback redirect or an `https://`
one. A plain `http://<tailnet-host>:7788/oauth/callback` is rejected at the
Google console, so OpenFit does not pretend otherwise.

**Default — connect from the host.** Open the `127.0.0.1` URL in a browser on
the machine running OpenFit and connect there. Pressing *Connect* from a phone
returns an explanation rather than a broken redirect. Everything else — viewing,
syncing, chatting — works from any device.

**Optional — connect from anywhere via `tailscale serve`.** Put an HTTPS origin
in front of the server and tell OpenFit about it:

```bash
tailscale serve --bg --https 443 http://127.0.0.1:7788
OPENFIT_PUBLIC_ORIGIN=https://your-host.tail-abc123.ts.net npm run serve
```

Then add `https://your-host.tail-abc123.ts.net/oauth/callback` as an authorized
redirect URI in your Google Cloud OAuth client, and set the same value as the
callback URL in OpenFit's settings. Connecting now works from any device on the
tailnet.

`OPENFIT_PUBLIC_ORIGIN` must be a bare `https` origin — no path, query, or
credentials. The server refuses to start otherwise.

## Data at rest

Outside Electron there is no `safeStorage`, so the server encrypts credentials
and the health archive with AES-256-GCM under a key at `<data-dir>/master.key`
(32 random bytes, `0600`, created with an exclusive open so two processes cannot
race).

- **Back up `master.key` together with the data directory.** Without it the
  encrypted files cannot be read.
- The desktop app still prefers `safeStorage` when the OS genuinely provides it,
  and rejects the Linux `basic_text` backend, which stores plaintext behind an
  encryption-shaped API.
- Both hosts read either format, so a data directory stays usable if you move
  between them — with one exception: a `safeStorage` envelope cannot be decrypted
  by the server, since only the desktop keychain holds that key. OpenFit reports
  this and asks you to reconnect rather than silently discarding the file.

## Running it as a service

```ini
# /etc/systemd/system/openfit.service
[Unit]
Description=OpenFit
After=network-online.target tailscaled.service

[Service]
Type=simple
User=you
WorkingDirectory=/home/you/code/openfit
Environment=NODE_ENV=production
Environment=OPENFIT_DATA_DIR=/home/you/.local/share/openfit
ExecStart=/usr/bin/node server/bin.cjs --host 0.0.0.0 --port 7788
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/you/.local/share/openfit

[Install]
WantedBy=multi-user.target
```

```bash
npm run build           # the service does not build; do it ahead of time
sudo systemctl enable --now openfit
journalctl -u openfit -f   # the startup banner prints the URL and token
```

The unit deliberately omits `--dev`, so the server refuses to start if
`dist/index.html` is missing rather than serving nothing.

## The health assistant

The assistant backend is discovered at runtime; see [AGENTS.md](AGENTS.md). On a
headless box install the CLI you want (`claude` for Claude Code, Codex Desktop
for Codex) and make sure it is signed in as the same user the service runs as —
both reuse their own local login, and OpenFit never stores an API key.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `401 Unauthorized` in the browser | The cookie is missing or stale. Reopen the `?token=…` URL from the banner. |
| `dist/index.html is missing` | Run `npm run build` first, or use `npm run serve`. |
| `Port 7788 is already in use` | Another instance is running, or pick a different `--port`. |
| Assistant shows "not found" | The backend's CLI is not on the service's `PATH`. Set `CLAUDE_BINARY` or `CODEX_BINARY` to an absolute path. |
| Connect says it must be done on the host | Expected in the default mode. See *Connecting a health account*. |
