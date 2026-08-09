# Server Hosting and Multi-Agent Backends — Design

Date: 2026-08-09
Status: approved for planning

## Problem

OpenFit runs only as an Electron desktop app. Every capability — the OAuth
loopback server, the Google Health and Fitbit adapters, the `safeStorage`
encrypted archive, and the Codex chat bridge — lives in `electron/main.cjs` and
reaches the React renderer through a `contextBridge` IPC allowlist
(`window.fitbit`, `window.healthAssistant`). Opening `dist/index.html` in a
browser yields a demo-mode shell with no backend.

Two consequences:

1. The dashboard cannot be viewed from a phone on the same Tailscale tailnet,
   even though the renderer is already responsive.
2. The assistant is hard-wired to Codex. `createCodexService` is instantiated
   directly in `main.cjs`, and the four `assistant:*` IPC handlers call it by
   name, so there is no seam at which a second backend could be added.

## Goals

1. Serve OpenFit over HTTP so any device on the tailnet can use the full
   application, not a demo shell.
2. Add Claude Code as a second assistant backend behind an interface that makes
   a third backend a new file rather than an edit to existing ones.
3. Keep one backend implementation. The desktop app and the hosted server must
   not drift.
4. Preserve the existing security posture: no secrets in the renderer, no health
   data leaving the machine, encrypted data at rest, read-only tool-less agents.

## Non-goals

- An Anthropic Messages API adapter. The agent interface leaves the seam and
  `docs/AGENTS.md` documents how to add one; this design does not build it.
- Multi-user accounts, roles, or per-user data separation.
- Any change to normalization (`src/data/normalize.ts`), the view components, or
  the `DashboardData` contract beyond swapping the transport the renderer uses.
- Reverse-engineering device BLE, or any change to how data reaches Google
  Health.

## Architecture

### Chosen approach: one HTTP core, Electron embeds it

All main-process logic moves into a transport-agnostic `core/`. A Node HTTP
server exposes it. Electron starts that same server on `127.0.0.1:0` and opens a
`BrowserWindow` pointed at it.

```
                       core/  (no electron, no server)
                         │
            ┌────────────┴────────────┐
            │                         │
      server/ (HTTP+SSE)        electron/main.cjs
            │                         │
   phone / laptop browser      BrowserWindow → 127.0.0.1:<port>
```

The renderer has exactly one data path — `src/lib/api.ts` over `fetch` and
`EventSource` — in both hosts.

**Rejected: shared core with two transports** (keep IPC *and* add HTTP). It
preserves the `contextBridge` allowlist unchanged, but requires two transport
adapters and a runtime bridge-selection layer kept in sync forever. The
duplication is the exact failure mode this work exists to prevent.

**Rejected: drop Electron.** Simplest codebase, but loses `safeStorage`, the
packaged installers, and the electron-builder pipeline.

### Security consequence of the choice

Replacing IPC with loopback HTTP replaces the `assertTrustedSender` /
`isTrustedRendererUrl` allowlist with a bearer-token check plus a bound host.
The properties that matter are preserved:

| Property | Before | After |
| --- | --- | --- |
| Renderer never sees tokens | IPC allowlist returns `publicStatus()` only | Same payloads over HTTP; `core/` never serializes secrets |
| Renderer cannot reach Node | `nodeIntegration: false`, `sandbox: true` | Unchanged; `webPreferences` keeps `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and drops only the `preload` entry |
| Only OpenFit can call the backend | Sender-frame URL check | Bearer token (cookie or header), `timingSafeEqual` |
| Backend is not world-reachable | Not listening at all | Binds an explicit host; Electron binds `127.0.0.1:0` |

### Module layout

```
core/
  secrets.cjs              envelope store: safeStorage | AES-256-GCM keyfile
  credentials.cjs          config + token read/write/validate   (from main.cjs)
  oauth.cjs                PKCE flow, callback handling, result page
  sync.cjs                 syncData + minimum-useful-response gate
  health-cache.cjs         moved unchanged from electron/
  providers/
    index.cjs              PROVIDERS registry + providerFor()
    google-health.cjs      moved from electron/google-health-service.cjs
    fitbit-legacy.cjs      moved from electron/fitbit-legacy-service.cjs
  agents/
    index.cjs              registry: list, resolve, select, fallback
    agent-common.cjs       instructions, sanitizeMessage, serializeHealthContext,
                           navigate-directive contract, resolveBinary
    codex.cjs              wraps the existing CodexService
    claude-code.cjs        new
  app.cjs                  createApp({ dataDir, safeStorage? }) — composition root
server/
  bin.cjs                  CLI entry: args, env, startup banner
  index.cjs                createServer({ app, host, port, token, publicOrigin })
  auth.cjs                 token load/generate, cookie issue, request gate
  static.cjs               dist/ serving + security headers
  routes/
    health.cjs             /api/status, config, connect, sync, cache, export
    assistant.cjs          /api/assistant/*
    events.cjs             /api/events (SSE fan-out)
    oauth.cjs              /oauth/callback when publicOrigin is set
electron/
  main.cjs                 slimmed: start core server on loopback, open window
                           (preload.cjs is deleted — no contextBridge remains)
src/lib/api.ts             fetch + SSE client, the only renderer data path
```

`core/` requires neither `electron` nor a listening socket. Electron injects
`safeStorage` as a capability into `createApp`; the server passes nothing and
gets the keyfile backend.

### Agent provider contract

```js
// core/agents/<name>.cjs
module.exports = {
  id: 'claude-code',
  label: 'Claude Code',
  resolveBinary(env),                 // → absolute path | null
  create(options) → AgentSession,
}

// AgentSession
getStatus()  → { id, label, available, connected, authenticated, busy, error? }
startTurn({ text, healthContext, onDelta }) → Promise<{ text }>
cancelTurn() → Promise<void>
reset()      → Promise<void>
dispose()    → Promise<void>
```

`CodexService` already implements `getStatus/startTurn/cancelTurn/reset/dispose`
with these semantics. The Codex work is: add `id`/`label`, normalize
`getStatus()` to the shape above, and register — no behavioral change.

`agent-common.cjs` holds what both backends must share so the renderer sees
identical output regardless of which is selected:

- `HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS` (verbatim from `codex-service.cjs`,
  including the `openfit:navigate` directive and its page allowlist)
- `sanitizeMessage` — control-character stripping and bearer/API-key redaction
- `serializeHealthContext` and the 500,000-character cap
- `resolveBinary(name, envVar)` — generalized from `resolveCodexBinary`,
  preserving the `PATHEXT` handling and executable-file checks

### Claude Code adapter

Spawned per turn, NDJSON over stdio, reusing the local Claude Code login. No API
key is read or stored.

```
claude -p --output-format stream-json --include-partial-messages --verbose
       --system-prompt <HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS>
       --disallowed-tools Bash Edit Write Read Glob Grep WebFetch WebSearch \
                          Task NotebookEdit TodoWrite
       --disable-slash-commands
       --strict-mcp-config --mcp-config '{}'
       --setting-sources ''           # load no user/project settings
       --session-id <uuid>            # --resume <uuid> on subsequent turns
       --model <configurable, default: opus>
```

- Turn text is written to stdin; the process exits per turn.
- Deltas come from `content_block_delta` / `text` stream events; final text from
  the `result` event; failures from `is_error`.
- Same 8 MB per-protocol-line guard as `codex-service.cjs`; oversized lines abort
  the turn rather than buffering unbounded.
- `reset()` mints a new session UUID, matching Codex's ephemeral-thread reset.
- `cancelTurn()` sends `SIGTERM`, then `SIGKILL` after the same 1 s grace period
  Codex uses.
- The tool set is empty and MCP is stripped, so the assistant cannot read the
  filesystem, run commands, or reach the network — matching the Codex bridge's
  `read-only` / `approvalPolicy: never` / network-disabled posture.

Binary resolution honours `CLAUDE_BINARY` the way Codex honours `CODEX_BINARY`.

### Agent selection

- `GET /api/assistant/agents` → every registered agent with live status.
- `POST /api/assistant/agent { agentId }` → persisted in the encrypted config as
  `config.agentId`.
- Default: first available in `[codex, claude-code]` order, preserving today's
  behavior on machines that have Codex.
- If the persisted agent's binary stops resolving, the registry falls back to the
  next available one and reports the substitution in status.
- UI: a selector in the `HealthAssistant` header listing only available agents.

### HTTP surface

All routes under `/api` require the token. One SSE stream carries all pushes.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/status` | replaces `fitbit:get-status` |
| POST | `/api/config` | replaces `fitbit:save-config` |
| POST | `/api/connect` | returns `{ authorizationUrl }` or `{ requiresHost: true }` |
| POST | `/api/disconnect` | |
| POST | `/api/sync` | `{ date }` |
| GET | `/api/cached-data`, `/api/cached-archive` | |
| GET | `/api/export` | `Content-Disposition` attachment; replaces the native save dialog |
| GET | `/api/events` | SSE: `auth-complete`, `sync-progress`, `assistant` |
| POST | `/api/assistant/turn`, `/cancel`, `/reset` | |
| GET/POST | `/api/assistant/agent(s)` | |

`openExternal` is removed from the bridge. A browser opens links itself; in
Electron the existing `setWindowOpenHandler` already routes `https:` to the
system browser.

Concurrency guards that today live in `main.cjs` (`syncInFlight`,
`assistantRequestId`) move into `core/app.cjs` so they hold across all clients,
not per connection. A second device requesting a sync while one is running gets
today's "A sync is already in progress." error.

### OAuth

Google accepts only `http://127.0.0.1` loopback or `https://` redirect URIs, so a
plain `http://<tailnet-host>:<port>/oauth/callback` is rejected at the console.
Two modes:

**Loopback (default).** Unchanged from today: an ephemeral `127.0.0.1` server on
the host, 5-minute timeout, state check, PKCE. `POST /api/connect` from a
non-loopback client returns `{ requiresHost: true }` and the UI explains that
account connection must be completed on the machine running OpenFit.

**Public origin (opt-in).** With `OPENFIT_PUBLIC_ORIGIN=https://box.tail-abc.ts.net`
(a `tailscale serve` HTTPS origin), the callback is served by the main server at
`<origin>/oauth/callback`, `validateConfig` accepts that exact origin in addition
to loopback, and connecting works from the phone. The origin must be `https:`
with no credentials, query, or fragment; anything else is rejected at startup.

Viewing, syncing, and chatting work from any device in both modes. Only
first-time account connection is host-bound by default.

### Secrets

`core/secrets.cjs` exposes:

```js
createSecretStore({ dir, safeStorage })
  describe()            → { encrypted: true, backend: 'safeStorage' | 'aes-256-gcm' }
  read(file, fallback)
  write(file, value)
```

- **v1 envelopes** (`{ version: 1, encrypted: true, data }`, safeStorage) stay
  readable, so existing desktop installs keep their credentials and archive.
- **v2 envelopes** (`{ version: 2, encrypted: true, algo: 'aes-256-gcm', iv, tag,
  data }`) are keyed by `<dataDir>/master.key`: 32 random bytes written with the
  `wx` flag at mode `0600`, so a concurrent start cannot clobber it.
- Electron prefers safeStorage when genuinely available, keeping the existing
  Linux `basic_text` rejection. The server always uses the keyfile.
- Writes keep the existing temp-file-plus-rename atomicity and `0600` mode.
- A v1 envelope read without safeStorage returns the fallback and surfaces an
  explicit "reconnect your account" state — it is never silently deleted, and
  never silently treated as empty data.

### Server auth

- A 32-byte token is generated on first run at `<dataDir>/server-token` (`0600`),
  overridable with `OPENFIT_SERVER_TOKEN` or `--token-file`.
- Startup prints one URL per interface, Tailscale CGNAT addresses
  (`100.64.0.0/10`) listed first, each with `?token=…`.
- `GET /?token=…` sets an `HttpOnly`, `SameSite=Lax`, `Path=/`, one-year cookie
  and redirects to `/`, so the token leaves the URL bar after first visit.
- Every `/api/*` request requires the cookie or an `Authorization: Bearer`
  header, compared with `crypto.timingSafeEqual` over fixed-length buffers.
- Electron binds `127.0.0.1:0` and loads the tokenized URL, so this is invisible
  on the desktop.

### Static serving and headers

`dist/` is served with the CSP currently applied in `main.cjs`, tightened now
that all provider calls are server-side:

```
default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline';
script-src 'self'; connect-src 'self'
```

Plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`. Path traversal is prevented by resolving each
request against `dist/` and rejecting anything that escapes it.

### Renderer changes

`src/lib/api.ts` exports `fitbit` and `healthAssistant` objects matching today's
`FitbitBridge` and `HealthAssistantBridge` types, backed by `fetch` and one
shared `EventSource` with reconnect. Call sites change from `window.fitbit` to
an imported `api` — mechanical across `App.tsx` and `HealthAssistant.tsx`.

`FitbitAuthStatus.isElectron` is renamed `hasBackend`, since the meaning is now
"a backend answered" rather than "we are in Electron". Three call sites and the
type change.

`src/vite-env.d.ts` drops the `Window` augmentation.

### Scripts

| Script | Behavior |
| --- | --- |
| `dev` | vite (`--host 127.0.0.1`) + core server + electron, as today |
| `dev:server` | vite `--host 0.0.0.0` proxying `/api` and `/oauth` to the core server |
| `serve` | `npm run build` then `node server/bin.cjs` |
| `check:node` | extends today's `node --check` list to every `core/` and `server/` file |
| `check` | unchanged composition: typecheck, node checks, tests, build |

## Testing

Extends the existing vitest suite, following the injected-dependency style
already used by `codex-service.test.ts` (fake `spawn`, fake `fs`).

- `core/secrets.test.ts` — v2 roundtrip; v1 compatibility; tampered ciphertext
  and tampered auth tag return the fallback; key file created `0600` and not
  overwritten on a second start.
- `core/agents/index.test.ts` — default ordering; persisted selection honoured;
  fallback when the persisted agent's binary disappears; unknown id rejected.
- `core/agents/claude-code.test.ts` — delta accumulation; final `result`;
  `is_error`; NDJSON split across chunk boundaries; oversized-line abort; cancel
  during a turn; session id reuse across turns and rotation on `reset()`;
  redaction of a bearer token in an error message.
- `core/agents/agent-common.test.ts` — instructions are byte-identical to the
  string the Codex bridge previously used; `serializeHealthContext` cap.
- `server/auth.test.ts` — missing, wrong-length, wrong-value, valid cookie, valid
  header; cookie issued with the right attributes.
- `server/routes.test.ts` — real server on port 0, real `fetch`, stubbed core:
  auth gate on every route; sync concurrency error; export headers; SSE delivers
  a queued event.
- `server/static.test.ts` — traversal attempts rejected; headers present.
- `src/lib/api.test.ts` — replaces `preload-contract.test.ts`, asserting the HTTP
  client implements the same bridge surface the renderer consumes.

Existing tests for normalizers, adapters, health cache, and OAuth are unchanged
apart from import paths.

## Error handling

- Provider read independence, per-source error attribution, 429 backoff, token
  refresh, atomic writes, and the "mostly failed sync preserves the cache" rule
  all move with `sync.cjs` unchanged.
- Agent errors keep the existing sanitize-and-truncate path (600 characters,
  control characters stripped, credentials redacted) before reaching a client.
- SSE clients that disconnect mid-turn do not cancel the turn; the result is
  delivered to whoever is listening when it completes, matching today's
  behavior when the window is backgrounded.
- Server startup fails loudly on: unwritable data dir, a `master.key` that is not
  32 bytes, a malformed `OPENFIT_PUBLIC_ORIGIN`, or a port already in use.

## Documentation

- `README.md` — a "Run as a server" section alongside the desktop quick start.
- `docs/ARCHITECTURE.md` — new flow diagram, the agent contract, the secret-store
  table, and the revised trust boundary.
- `docs/SELF_HOSTING.md` (new) — Tailscale setup, the OAuth caveat and the
  `tailscale serve` escape hatch, a systemd unit, backup guidance for
  `master.key`.
- `docs/AGENTS.md` (new) — the provider interface and how to add a backend,
  including what an Anthropic Messages API adapter would need.

## Risks

- **Renderer transport swap touches every data call site.** Mitigated by keeping
  the `FitbitBridge` / `HealthAssistantBridge` type shapes identical, so the
  compiler catches every miss.
- **Existing desktop installs must keep decrypting.** Mitigated by keeping v1
  envelope support and covering it with a test.
- **Claude Code CLI output format may shift between versions.** Mitigated by
  parsing defensively (ignore unknown event types, never assume field presence)
  and by a status probe that reports an actionable error rather than hanging.
- **Exact CLI flag spellings must be verified against the installed binary.** The
  flag list above was read from `claude --help` (v2.1.226); the plan verifies each
  one — particularly `--setting-sources` with an empty value — against a live
  invocation before the adapter is wired up, and drops any flag the binary
  rejects rather than assuming it is accepted.
