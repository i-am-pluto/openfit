# Google OAuth Login and Per-Account Isolation — Design

Date: 2026-08-09
Status: approved for planning

## Problem

The self-hosted server authenticates with a single bearer token generated on
first run and stored at `<data-dir>/server-token`. Access means holding a
64-character hex string, delivered as a `?token=…` URL that the server exchanges
for an `openfit_token` cookie.

That has three costs.

The token is a shared secret with no identity attached. It cannot say who is
using the instance, so the health archive and OAuth credentials are inherently
single-tenant: anyone with the string reads everything.

Connecting a health account is a separate, manual ceremony. The operator opens
the settings screen, pastes a Client ID, a Client Secret, and a callback URL,
and any mismatch between that callback and the Google Cloud console produces
`redirect_uri_mismatch`. The credentials are entered through `POST /api/config`,
which is itself guarded — so configuration requires prior access.

The token cookie omits `Secure`, because the code assumes the tailnet URL may be
plain HTTP.

Signing in with Google removes all three. The account that owns the health data
becomes the account that authenticates, in one consent flow.

## Goals

- Replace token-based browser access with Google sign-in.
- Grant identity and the health scopes in a single OAuth flow, so a successful
  sign-in leaves the instance connected.
- Read the OAuth client from `.env` at startup, removing the in-app credential
  screen and the bootstrap deadlock it creates.
- Isolate each Google account's credentials and health archive.
- Keep the bearer token working for `/api/*` so scripts and health checks
  continue to function.
- Set `Secure` on session cookies whenever the origin is HTTPS.

## Non-goals

- Replacing the storage engine. Per-account isolation uses directories and the
  existing AES-256-GCM file format. A datastore migration is a separate spec.
- Publishing the OAuth consent screen. The app stays in testing mode, and the
  seven-day refresh-token expiry that implies is accepted, not worked around.
- Password authentication, account registration, or password recovery. Google
  is the only identity provider.
- Per-device session listing or management beyond a single "log out
  everywhere".
- Any change to the health adapters, sync logic, or renderer data contracts
  beyond what removing `POST /api/config` requires.

## Decisions

| Decision | Choice |
| --- | --- |
| OAuth client | Reuse the existing client; add `/auth/callback` as a second redirect URI |
| Who may sign in | Whoever Google's test-user list admits |
| Scope grant | One flow grants `openid`/`email`/`profile` and the nine `googlehealth.*.readonly` scopes |
| Credential source | `.env`, read at startup |
| Programmatic access | Bearer token retained for `/api/*` only |
| Isolation | Per-account encrypted directories keyed by a hash of the Google `sub` |
| Session | Stateless HMAC-signed cookie plus a per-account epoch counter |

Trusting Google's test-user list is safe here only because of per-account
isolation. A second test user who signs in receives an empty directory of their
own rather than access to the first user's data.

## Architecture

`server/bin.cjs` builds one `createApp({ dataDir })` at startup. Per-account
isolation turns that singleton into a registry that creates and caches an app
instance per account, lazily, on first authenticated request.

```text
.env ──► server/env.cjs ──► clientId / clientSecret / publicOrigin
                                    │
GET /            ─── no session ───► login page ──► GET /auth/login
                                                          │ redirect
                                                          ▼
                                              accounts.google.com
                                    ┌─────────────────────┘
                                    ▼  code
                            GET /auth/callback
                            ├─ verify ID token ──► sub, email
                            ├─ accounts.resolve(sub) ──► per-account dir
                            ├─ store refresh token (encrypted)
                            └─ Set-Cookie: openfit_session (signed)
                                    │
GET /api/*  ──► session cookie ─OR─ Bearer token ──► app(sub) ──► health data
```

### Module layout

| File | Status | Responsibility |
| --- | --- | --- |
| `server/env.cjs` | new | `process.loadEnvFile()`, validate required variables, fail fast |
| `core/identity.cjs` | new | Build the auth URL, exchange the code, validate ID token claims |
| `core/accounts.cjs` | new | Map `sub` to a directory, create on first sign-in, hold the epoch |
| `server/session.cjs` | new | Sign and verify the session cookie, check the epoch |
| `server/routes/login.cjs` | new | `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` |
| `server/auth.cjs` | modified | Keeps bearer for `/api/*`, gains session verification |
| `server/index.cjs` | modified | Guard accepts session or bearer; unauthenticated HTML serves the login page |
| `server/bin.cjs` | modified | Builds an account registry rather than a single app |

The boundaries are deliberate. `identity.cjs` talks to Google and knows nothing
about cookies. `session.cjs` performs crypto and knows nothing about routing.
`accounts.cjs` owns directory layout only. Each is testable without an HTTP
server.

Node 22 is already required by `engines`, so `process.loadEnvFile()` covers
`.env` loading with no dependency. `.env` must be added to `.gitignore`, which
does not currently list it.

### The login page

The login page is server-rendered, not part of the React bundle. A visitor
without a session should not download the application to see one button, and
serving a single static string keeps the unauthenticated surface minimal.

Sign-in is an `<a href="/auth/login">` link rather than a form. The existing CSP
sets `form-action 'none'`, which would block a form POST; link navigation is
unaffected, so no security header is loosened to accommodate this feature.

### Sign-in flow

`GET /auth/login` generates `state`, `nonce`, and a PKCE verifier, then stores
them in a short-lived signed cookie rather than server memory. A restart during
sign-in therefore does not strand the flow. The cookie expires after ten
minutes.

`GET /auth/callback` validates `state`, exchanges the code at Google's token
endpoint, and reads the ID token.

Signature verification against Google's JWKS is deliberately skipped. The ID
token arrives directly from the token endpoint over TLS in a server-to-server
call, a case in which OIDC Core section 3.1.3.7 explicitly permits skipping
signature validation. The `iss`, `aud`, `exp`, `nonce`, and `email_verified`
claims are still validated. This removes JWKS fetching and cache expiry, and
with them a failure mode that would buy nothing.

`exp` is compared with sixty seconds of leeway. The host is a laptop that
suspends and resumes, and a strict comparison would produce sporadic sign-in
failures with no legible cause.

### Session cookie

```text
openfit_session = v1.<base64url(payload)>.<base64url(hmac)>
payload = { sub, email, iat, epoch }
```

The HMAC-SHA256 key is derived from the existing `master.key` through HKDF with
the label `openfit-session-v1`, so the session key and the data-encryption key
are never the same bytes. Deriving from `master.key` rather than generating a
separate secret is what makes sessions survive a restart.

Attributes: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` of 30 days, and
`Secure` whenever `publicOrigin` is HTTPS.

Verification uses the existing constant-time `sameToken` comparison.

### Storage layout

```text
<data-dir>/
  master.key                   # instance-wide
  server-token                 # bearer, /api/* only
  accounts/
    <sha256(sub)[:16]>/
      account.json             # encrypted: sub, email, epoch, createdAt
      credentials.secure.json  # existing encrypted health OAuth blob
      health-cache.secure.json # existing encrypted archive
```

The directory name is a hash of `sub` rather than `sub` itself. The name is then
fixed-length and filesystem-safe, it does not disclose the Google account
identifier to anything that can list the directory, and path traversal through a
hostile `sub` is structurally impossible.

Account directories are created with mode `0700`.

`createSecretStore({ dir })` creates a `master.key` in whichever directory it is
given, so a per-account app left to its own devices would produce one key per
account. `master.key` stays instance-wide instead: the registry builds a single
secret store at the data-directory root and passes it to every per-account app.
`createApp` already accepts `options.secrets`, so this seam exists and
`core/secrets.cjs` needs no change.

### Migration

If root-level `credentials.secure.json` or `health-cache.secure.json` exist and
`accounts/` does not, the first sign-in adopts them into that account's
directory. Without this, a health connection made before this ships would be
orphaned.

Adoption is conditional on `accounts/` being absent. Once any account exists,
root-level files are left untouched rather than grafted onto whichever account
happens to sign in next.

### Bearer token and account context

The bearer token predates multi-account and carries no account identity. It
resolves to the sole account when exactly one exists. When more than one exists
it returns 409 with the list of accounts and requires an explicit
`X-OpenFit-Account` header whose value is the account's email address.

Returning 409 is preferred over silently choosing an account, which is the
mechanism by which an automated caller would read the wrong person's health
data.

### Logout

`POST /auth/logout` clears the cookie. Logging out everywhere increments `epoch`
in `account.json`; every previously issued cookie then fails its epoch check on
the next request. This restores the revocation that a stateless session would
otherwise lack.

### Consequences for existing routes

| Route | Fate |
| --- | --- |
| `POST /api/config` | Removed. Credentials come from `.env` |
| `POST /api/connect` | Returns 200 with `{ reauthorizeUrl }` for the renderer to navigate to |
| `POST /api/disconnect` | Clears health tokens, keeps the session |

`POST /api/connect` returns the URL rather than an HTTP redirect. The renderer
calls it with `fetch`, which would follow a 302 and attempt the Google consent
page as an XHR; the navigation has to happen in the browser's address bar.

Removing `POST /api/config` also removes the settings screen that asks for a
Client ID, Client Secret, and callback URL, and with it the `redirect_uri_mismatch`
class of misconfiguration.

## Error handling

The controlling distinction is between "not signed in" and "signed in, health
connection lapsed". Conflating them is the most likely way this design degrades
in daily use.

### Startup

A missing or incomplete `.env` prevents startup, naming the absent variable.
`OPENFIT_GOOGLE_CLIENT_ID` and `OPENFIT_GOOGLE_CLIENT_SECRET` are required;
`OPENFIT_PUBLIC_ORIGIN` remains optional and falls back to loopback. This
follows the existing precedent that a malformed `OPENFIT_PUBLIC_ORIGIN` refuses
to start rather than half-working.

### Sign-in

| Condition | Response |
| --- | --- |
| State cookie missing or older than ten minutes | 400, "sign-in took too long", retry link |
| `state` mismatch | 400, treated as CSRF, no detail disclosed |
| Google returns `access_denied` | Explanatory page |
| `iss`, `aud`, `exp`, or `nonce` invalid | 401, generic message |
| `email_verified` is false | 403, with the reason |
| Account is not a Google test user | Blocked by Google before the callback; documented so it is not mistaken for an application fault |

### Sessions

A tampered HMAC, an unrecognised epoch, and a deleted account directory all
resolve identically: treated as signed out, serve the login page. None produces
a 500. A corrupt cookie is a user-facing condition, not a server fault.

### Expired health authorization

The session lasts 30 days. The Google refresh token expires after seven days
while the consent screen is in testing. The steady state is therefore signed in
and disconnected.

That state reports `connected: false` with a `reauthorizeUrl`, and the interface
prompts to reconnect without signing the user out. Re-authorization is
`/auth/login?prompt=consent`, reusing the same flow and returning the user to
where they were.

## Testing

Tests are colocated as `*.test.ts` and inject dependencies rather than mocking
globals, following `createAuth({ dir, fs, randomBytes, token })`. `identity.cjs`
receives a `fetch` double; no test performs network I/O.

### Unit

`core/identity.test.ts` — the auth URL carries the nine health scopes plus
`openid`, `email`, and `profile`, along with `access_type=offline`, the PKCE
challenge, `state`, and `nonce`, and passes `prompt=consent` through. A claim
validation table covers valid, wrong `iss`, wrong `aud`, expired, exactly at the
sixty-second skew boundary, wrong `nonce`, and `email_verified: false`.

`server/session.test.ts` — sign and verify round trip; tampered payload
rejected; tampered signature rejected; epoch mismatch rejected; the same
`master.key` derives the same signing key across instances; a different
`master.key` fails verification; `Secure` present only for HTTPS origins.

`core/accounts.test.ts` — `sub` to directory mapping is stable; directories are
created `0700`; a second account receives a separate directory; epoch increments
persist. Migration is covered in both directions: a root-level
`credentials.secure.json` is adopted when `accounts/` is absent, and is not
adopted when it exists.

A hostile `sub` containing `../` is tested explicitly. Traversal is already
impossible because the directory name is a hash, and the test pins that property
so that replacing the hash with a raw `sub` fails loudly.

### Integration

Extending `server/routes.test.ts`:

- Unauthenticated `GET /` serves the login page rather than 401
- Unauthenticated `/api/*` returns 401
- A session cookie grants both the app shell and the API
- A bearer token grants `/api/*` only; `GET /` with a bearer shows the login page
- Bearer with multiple accounts returns 409 listing them; `X-OpenFit-Account` resolves it
- `/auth/callback` succeeds against a stubbed token endpoint
- A missing state cookie returns 400
- Logout clears the cookie, and an epoch increment invalidates a previously valid cookie

`server/auth.test.ts` is left substantially unchanged, which signals that bearer
behaviour was preserved rather than quietly altered.

### Not covered

There is no end-to-end test against Google. The token endpoint is injected, so
the contract is pinned but the live integration is verified once, manually, by
signing in.

## Documentation

`docs/SELF_HOSTING.md` requires revision in several places: the startup banner
no longer prints a tokenized URL for browser access, the access-control section
must describe sign-in alongside the retained bearer token, the "Connecting a
health account" section collapses into the sign-in flow, and the systemd unit
gains the `.env` file. The seven-day refresh expiry in testing mode belongs in
the troubleshooting table.

`README.md` step 5 must add `/auth/callback` as a second redirect URI, and the
"Connect OpenFit" steps that describe pasting a Client ID and Secret no longer
apply to the server.

`docs/ARCHITECTURE.md` needs the account registry and the session boundary.

An `.env.example` documents the required variables without holding secrets.

## Risks

Turning the app singleton into a registry is the largest change and touches
startup, routing, and disposal. `server.on('close')` currently disposes one app;
it must dispose every cached instance.

Skipping JWKS verification is correct under OIDC only while the token is
fetched directly from Google over TLS. If a future change ever accepts an ID
token from the client, that reasoning collapses. The rationale is recorded in a
comment at the validation site, not only in this document.

Adopting root-level data on first sign-in runs exactly once and is difficult to
undo if it picks the wrong account. It is gated on `accounts/` being absent,
which makes the wrong-account case impossible in practice, but the migration
should log what it moved.

The instance depends on Google being reachable to sign in. The bearer token
remains as the break-glass path for `/api/*`, but the dashboard itself is
unavailable while Google is down.
