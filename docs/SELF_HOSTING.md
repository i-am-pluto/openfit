# Self-hosting OpenFit

OpenFit runs as a small HTTP server you sign in to with Google. Use this when
you want the dashboard on your phone or another laptop over Tailscale.

> **The desktop app does not run on this branch.** `electron/main.cjs` has not
> been updated for Google sign-in: it calls `createServer` without a session
> store, an accounts store, or an account registry, and the server refuses to be
> built that way. `npm run dev:electron` and `npm run dist` produce an app that
> fails at startup. Use the server until that composition root is fixed.

## Before you start: `.env` is required

The server reads its Google OAuth client from the environment and **exits with
status 1 if it is missing**. There is no in-app settings screen for it — the
endpoint that used to accept a Client ID and Secret (`POST /api/config`) is
gone, and it would have been unreachable anyway, because configuring sign-in
would have required being signed in.

```bash
cp .env.example .env
$EDITOR .env    # fill in the client ID and secret from Google Cloud
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENFIT_GOOGLE_CLIENT_ID` | yes | OAuth client ID, Web application type |
| `OPENFIT_GOOGLE_CLIENT_SECRET` | yes | OAuth client secret for the same client |
| `OPENFIT_PUBLIC_ORIGIN` | no | Bare `https` origin, e.g. `https://box.tail-abc123.ts.net`. Needed to sign in from another device. |

`.env` is read from the repository root by absolute path, so a service unit with
its own `WorkingDirectory` still finds it. Variables already present in the
process environment are used as-is, so systemd can supply them instead.

### Redirect URIs to register

The server does not choose one redirect URI; it derives one from the origin it is
running on, and Google will only accept a callback it was told about in advance.
Register every origin you will actually use:

| How you run OpenFit | Origin | Register in Google Cloud |
| --- | --- | --- |
| `npm run serve` on this machine | `http://127.0.0.1:7788` | `http://127.0.0.1:7788/auth/callback` |
| `npm run dev` (the API listens on **7789**) | `http://127.0.0.1:7789` | `http://127.0.0.1:7789/auth/callback` |
| Behind `tailscale serve`, `OPENFIT_PUBLIC_ORIGIN` set | that origin | `https://<host>.ts.net/auth/callback` |

A different `--port` means a different origin and therefore another entry. This
is also why `redirect_uri_mismatch` is the most common first-run error.

### `npm run dev`

Two things bite, in this order.

**Without `.env` it exits immediately.** `npm run dev` runs three processes under
`concurrently -k`. `dev:api` is the server, and without
`OPENFIT_GOOGLE_CLIENT_ID` it prints one line and exits 1:

```text
OPENFIT_GOOGLE_CLIENT_ID is not set. Add it to .env or the service environment.
```

`-k` then sends `SIGTERM` to the other two, so Vite and Electron die with it and
the whole command exits non-zero. There is nothing wrong with your Node version
or your install.

**`.env` alone is not enough to sign in from the dev server.** `dev:api` listens
on port **7789**, not 7788, so the redirect URI it computes is
`http://127.0.0.1:7789/auth/callback`. Register that exact URI on the same OAuth
client, in addition to the 7788 one, or Google refuses the sign-in with
`redirect_uri_mismatch`.

Vite serves the page on `http://127.0.0.1:5173` and proxies both `/api` and
`/auth` to `dev:api`, so signing in and out work from the dev origin. Session
cookies are not scoped by port, so the cookie Google's callback sets on
`127.0.0.1:7789` is sent on `127.0.0.1:5173` too. The callback itself lands on
7789; go back to 5173 afterwards.

`npm run dev` also starts Electron, which does not run on this branch (see the
note at the top). `npm run dev:api` and `npm run dev:web` in two terminals give
you the same server and dev page without it.

## Start the server

```bash
npm install
npm run serve
```

`npm run serve` builds the renderer and starts the server on port 7788, bound to
all interfaces. It prints the address to sign in on, then any other addresses it
is listening on:

```text
  OpenFit server
  data     /home/you/.local/share/openfit
  storage  aes-256-gcm
  agents   codex, claude-code (unavailable)

  Open this and sign in with Google:
    http://127.0.0.1:7788/

  Sign-in only completes from this machine. Set OPENFIT_PUBLIC_ORIGIN=https://<host>.ts.net
  and register <origin>/auth/callback with the Google client to sign in from other devices.

  Also listening on:
    http://100.92.14.7:7788/
    http://192.168.1.20:7788/
```

No URL printed here carries a credential. The banner used to append `?token=…`;
a tokenised URL in a terminal scrollback or a `journalctl` buffer was a standing
credential leak, and browser access is a Google sign-in now.

With `OPENFIT_PUBLIC_ORIGIN` set, the sign-in URL is that origin and the
paragraph about host-bound sign-in is not printed.

### Options

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--host` | `OPENFIT_HOST` | `0.0.0.0` |
| `--port` | `OPENFIT_PORT` | `7788` |
| `--data-dir` | `OPENFIT_DATA_DIR` | platform data directory (see below) |
| `--token-file` | `OPENFIT_SERVER_TOKEN` | generated at `<data-dir>/server-token` |
| — | `OPENFIT_GOOGLE_CLIENT_ID` | **required**, no default |
| — | `OPENFIT_GOOGLE_CLIENT_SECRET` | **required**, no default |
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

## Signing in

Open the URL from the banner. An unauthenticated request for any page gets a
server-rendered sign-in page — the application bundle is never served to an
anonymous visitor — with a single **Sign in with Google** link.

Sign-in and health access are **one** Google consent. There is no second step
where you connect a health account: the same authorization grants the `openid`
identity scopes and the read-only Google Health scopes, and the resulting tokens
are stored for the account that signed in.

Sign in with the Google account your Fitbit app uses. The account must be listed
as a test user on the OAuth consent screen, and it must have a verified email
address; an unverified one is refused rather than given a session.

**Sign-in only completes on the origin the OAuth client is registered with.** The
pending sign-in cookie is set on the origin the browser started from, and Google
sends the callback to the registered redirect URI. Starting at
`http://100.92.14.7:7788/` when only `http://127.0.0.1:7788/auth/callback` is
registered fails at Google.

To sign in from a phone, put an HTTPS origin in front of the server:

```bash
tailscale serve --bg --https 443 http://127.0.0.1:7788
OPENFIT_PUBLIC_ORIGIN=https://your-host.tail-abc123.ts.net npm run serve
```

Then add `https://your-host.tail-abc123.ts.net/auth/callback` as an authorized
redirect URI on the same Google OAuth client. Google accepts only an
`http://127.0.0.1` loopback redirect or an `https://` one, so a plain
`http://<tailnet-host>:7788/...` callback cannot be registered at all.

`OPENFIT_PUBLIC_ORIGIN` must be a bare `https` origin — no path, query, or
credentials. The server refuses to start otherwise. Setting it also puts
`Secure` on the session cookies, so do not set it unless HTTPS really is in
front of the server.

### Multiple accounts

Each Google account that signs in gets its own encrypted directory under
`<data-dir>/accounts/<hash-of-subject>/`, created `0700`, holding that account's
credentials, health archive, and account record. One server can host several
people without either seeing the other's data.

### Signing out

The account menu offers two actions:

- **Sign out of this browser** clears the session cookie here and nowhere else.
- **Sign out everywhere** additionally bumps the account's revocation epoch on
  the server, which invalidates every session cookie ever issued for that
  account. This is the only revocation mechanism there is — use it if you lose a
  device. OpenFit reports an error rather than a success if the epoch was not
  actually bumped.

Sessions also expire on their own after 30 days, enforced server-side from the
signed timestamp inside the cookie rather than from its `Max-Age`.

## Access control

Two independent ways in, with different reach:

| Credential | Reaches | Notes |
| --- | --- | --- |
| Google session cookie | the app shell and every `/api/*` route | Issued by signing in. `HttpOnly`, `SameSite=Lax`, signed with a key derived from `master.key`. |
| Server token | `/api/*` **only** | For automation. A browser holding one still gets the sign-in page for any page request. |

The server generates a 32-byte token on first run and stores it at
`<data-dir>/server-token` with `0600` permissions. Present it as an
`Authorization: Bearer` header; comparison is constant-time.

```bash
TOKEN="$(cat ~/.local/share/openfit/server-token)"
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7788/api/status
```

A bearer token predates multi-account support and names no account, so it cannot
create one either:

- before anyone has signed in, every `/api/*` call answers
  `401 {"error":"No account has signed in yet."}`. Sign in with a browser once;
- with exactly one account on the instance, it resolves to that account;
- with more than one, name one with an `X-OpenFit-Account: you@example.com`
  header or the request is refused with `409` and the list of addresses, rather
  than served from whichever account came first.

To pin a token you manage yourself:

```bash
OPENFIT_SERVER_TOKEN="$(openssl rand -hex 32)" npm run serve
```

Tailscale membership is not treated as sufficient on its own: a misconfigured
ACL, a shared node, or another device on the tailnet still has to sign in.

## Data at rest

Outside Electron there is no `safeStorage`, so the server encrypts credentials
and the health archive with AES-256-GCM under a key at `<data-dir>/master.key`
(32 random bytes, `0600`, created with an exclusive open so two processes cannot
race). The session signing key is derived from those same bytes with HKDF, so it
is never the key that encrypts data.

- **Back up `master.key` together with the data directory.** Without it the
  encrypted files cannot be read, and every account record with them.
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
EnvironmentFile=/home/you/code/openfit/.env
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

`EnvironmentFile=` is not optional. Without the Google client the unit exits 1 on
every start and `Restart=on-failure` turns that into a restart loop; the reason
is in `journalctl`, one line, before the banner.

Keep `.env` at mode `0600` — it holds the client secret, and `EnvironmentFile`
does not care what the file is readable by.

```bash
npm run build           # the service does not build; do it ahead of time
sudo systemctl enable --now openfit
journalctl -u openfit -f   # the startup banner prints the sign-in URL
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
| `OPENFIT_GOOGLE_CLIENT_ID is not set` | No `.env` and no service environment. See *Before you start*. |
| `npm run dev` exits immediately, Vite and Electron die with it | Same cause: `dev:api` exits 1 and `concurrently -k` kills its siblings. |
| Health disconnected after about a week | Google expires refresh tokens for apps in testing after 7 days. Sign in again — **Reconnect** in the app, which forces a fresh consent. You are not signed out; only health access lapsed. |
| The sign-in page comes back instead of the dashboard | The session cookie is missing, expired, or revoked by a *sign out everywhere*. Sign in again. |
| `Sign-in took too long. Start again.` | The pending cookie is older than 10 minutes, or the browser started at one origin and Google returned to another. Start from the origin registered with the OAuth client. |
| `redirect_uri_mismatch` at Google | The registered redirect URI is not `<origin>/auth/callback` for the origin you started from. |
| `401 Unauthorized` from `curl` | The bearer token is wrong, or you sent it as `?token=…` to a page rather than an `/api/*` route. |
| `409` from `curl` with a list of addresses | More than one account has signed in. Add `X-OpenFit-Account: you@example.com`. |
| `dist/index.html is missing` | Run `npm run build` first, or use `npm run serve`. |
| `Port 7788 is already in use` | Another instance is running, or pick a different `--port`. |
| Assistant shows "not found" | The backend's CLI is not on the service's `PATH`. Set `CLAUDE_BINARY` or `CODEX_BINARY` to an absolute path. |
| The desktop app closes at startup | Known: `electron/main.cjs` has not been updated for Google sign-in. Use the server. |
