# Known follow-ups

Deferred findings from the Google sign-in branch (`dabasp/hosting-local`). Each
was raised by review, triaged as safe to ship, and left deliberately. Recorded
here because the review workspace is git-ignored and would otherwise be lost.

## Security-adjacent

**`/auth/logout` does not check the epoch.** A revoked session cookie can still
bump its own account's epoch. Self-inflicted denial of service only — a stale
cookie cannot affect another account. `server/routes/login.cjs` re-implements
the session-shape check inline rather than reusing the exported `usableSession`,
so the two can drift.

**The Electron flow id transits the OS as a command-line argument.**
`shell.openExternal` execs `xdg-open <url>` on Linux and `/proc/<pid>/cmdline`
is world-readable, so a *different local user* can read the id and drive a flow
within its ten-minute window. The residual is inherent — the URL has to reach
the browser somehow. The latch defends against concurrent flows, not against
someone who can read your process table.

**`outstandingSignIn` is never cleared on window close or sign-out**, so a flow
armed before a sign-out stays adoptable for the rest of its ten minutes. Only
the user's own click can arm it.

**A bearer-token SSE stream opened without `X-OpenFit-Account`** while one
account exists will close on the next heartbeat if a second account signs in,
because resolution then returns the 409 ambiguity. Fail-closed and arguably
correct, but it is an unpinned behaviour change for automation clients.

**`revalidate` re-checks the epoch but not the session's 30-day age.** A stream
would have to stay open for thirty days to matter.

**The 409 ambiguity response enumerates every account email on the instance.**
Only reachable by a bearer holder.

## Correctness and hygiene

- `core/credentials.cjs` — the comment "the desktop host builds the app without
  any defaults at all" is stale; Task 11 routed Electron through
  `composeBackend`, which always supplies `oauthDefaults`. The mechanism is
  right, its stated justification is not. The `see server/bin.cjs` pointer
  should now read `server/compose.cjs`.
- `core/app.cjs` — `normalizePublicOrigin` checks protocol, credentials,
  `search` and `hash` but **not `pathname`**, so `https://box.ts.net/openfit` is
  accepted and the path silently dropped. `docs/SELF_HOSTING.md` and
  `.env.example` both assert it is refused, and `server/compose.cjs` *does*
  check pathname for the loopback origin — an omission, not a policy.
- `server/env.cjs` — comment still describes `POST /api/config` in the present
  tense. It is the stalest surviving reference to the retired flow.
- `vite.config.ts` — "the production auth gate stays fully enforced" is no
  longer accurate now that `/auth` is proxied with the same injected bearer.
- `server/routes/events.cjs` — `heartbeatMs` accepts integers above Node's
  `TIMEOUT_MAX`, which `setInterval` clamps to 1 ms. Fails toward more checking,
  not less; an upper bound would make the parameter total.
- `server/routes/login.cjs` — `FLOW_ID` is exported but imported nowhere.
- `server/login-page.cjs` — exports `escapeHtml` with no importer.
- `docs/superpowers/plans/2026-08-09-google-oauth-login.md` still contains the
  full `adoptRootData` implementation and its tests. Historical record of what
  was planned, but a grep hazard for anyone later searching for "adoption".

## Test gaps

- `server/compose.cjs`'s `assertLoopbackOrigin` has no direct coverage;
  neutering it is green.
- `server/bin.test.ts`'s master-key derivation test is a tautology —
  `sessions.verify(sessions.sign(...))` round-trips under any key. The real test
  is restarting `main()` against the same data directory and replaying a cookie
  from the first run.
- The `kind` cookie discriminators and the doubled `usableSession` layers are
  defence in depth behind checks that *are* pinned, but are themselves unpinned.
- `adoptDesktopSession`'s window-reload branch is untested — `mainWindow` is
  always null under the Electron stub.
- No component tests exist for the renderer; `src/App.tsx` states are covered by
  typecheck and reading only.

## Production readiness

**The Electron host has never been executed.** The build machine has no X
server, `electron/main.test.ts` runs against a stubbed `electron` module, and
`npm run check` never launches it. This is the exact class of failure that
already shipped once on this branch — a review cleared Electron by checking
`createApp` and missing `createServer`, and a packaged app would never have
opened a window. Launch the packaged desktop build and complete one real sign-in
before release.

**`npm run dist` has not been run end to end.** A packaged build reads `.env`
from `<userData>`, which is only usable by someone who owns the Google Cloud
project and has registered `http://127.0.0.1:7790/auth/callback`.

## Design decisions worth revisiting

**There is no allowlist in the code.** The design decided that whoever Google's
test-user list admits may sign in. `/auth/login` and `/auth/callback` are public
routes, `accounts.resolve` enrolls any valid identity unconditionally, and the
server binds `0.0.0.0` by default. The sole authorization boundary is a setting
in an external console that can be changed without touching this repository, and
publishing the consent screen would remove it silently. An
`OPENFIT_ALLOWED_EMAILS` check would be defence in depth for a self-hosted
product whose documentation encourages tailnet exposure.

**Background sync stops when the refresh token lapses.** One scheduled job
syncs every connected account every ten minutes (`core/scheduler.cjs`). While
the OAuth consent screen stays in testing mode Google expires refresh tokens
after seven days, after which every account reports disconnected and the job
skips it — by design. Signing back in refreshes that account immediately and
resumes the schedule.

**The scheduler syncs the current day only.** A gap longer than a day — a
laptop closed over a weekend — leaves those days absent from the archive until
something requests them. Backfilling missed days is not implemented.
