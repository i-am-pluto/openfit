<p align="center">
  <img src="public/app-icon.png" alt="OpenFit app icon" width="96">
</p>

<h1 align="center">OpenFit</h1>

OpenFit is a private dashboard for Google Fitbit Air and other Fitbit devices. It runs as a small self-hosted server you sign in to with Google and can reach from your phone over Tailscale. Its adaptive interface prioritizes a small set of useful insights and only displays views, metrics, and navigation when Google Health returns real data.

<p align="center">
  <img src="public/openfit-screenshot.webp" alt="OpenFit desktop dashboard screenshot" width="960">
</p>

The renderer uses React, shadcn/Radix, Tailwind CSS v4, assistant-ui, Inter Variable, JetBrains Mono, and Nucleo Essential Outline icons.

> Project status: the server is complete and buildable. Signing in requires an OAuth client in your own Google Cloud project, supplied through `.env`.
>
> **The Electron desktop app does not run on this branch.** `electron/main.cjs`
> still builds the HTTP server the old way and has not been updated for Google
> sign-in, so it fails at startup. `npm run dev:electron`, `npm run capture:ui`,
> and `npm run dist` are all affected. Use `npm run serve`.

## How Fitbit data reaches OpenFit

Fitbit Air does **not provide a public Bluetooth synchronization interface** for third-party applications. The supported data path is:

```text
Fitbit Air -> Bluetooth -> Fitbit/Google Health mobile app
                                  |
                                  v cloud sync
                         Google Health API -> OpenFit
```

OpenFit uses **Google Health API v4** as its default provider. The legacy Fitbit Web API remains available only as a transitional adapter and is scheduled for deprecation in September 2026.

OpenFit can replace the browsing and analysis experience, but it cannot perform initial device pairing, firmware updates, or phone-to-device synchronization.

## Quick start

Requirements:

- Node.js 22 or later;
- npm 10 or later;
- Codex Desktop or Claude Code, only if you want to use the health assistant. OpenFit reuses whichever local login you already have and never needs an API key. See [assistant backends](docs/AGENTS.md).

**A `.env` file is required before anything will start.** The server reads its
Google OAuth client from the environment and exits with status 1 without it.

```bash
npm install
cp .env.example .env
$EDITOR .env          # OPENFIT_GOOGLE_CLIENT_ID and OPENFIT_GOOGLE_CLIENT_SECRET
npm run serve
```

Then open the URL the banner prints and sign in with Google.

> **`npm run dev` fails immediately without `.env`.** `dev:api` prints
> `OPENFIT_GOOGLE_CLIENT_ID is not set` and exits 1, and because the three dev
> processes run under `concurrently -k`, Vite and Electron are killed with it.
> The whole command exits non-zero with no other explanation. Create `.env`
> first. See [*Connect Google Health*](#connect-google-health) for where the
> values come from.
>
> **`.env` alone does not make dev sign-in work.** `dev:api` listens on port
> **7789**, so its redirect URI is `http://127.0.0.1:7789/auth/callback` — a
> different origin from `npm run serve`. Register that URI on the same OAuth
> client too, or Google answers with `redirect_uri_mismatch`. `npm run dev` also
> starts Electron, which does not run on this branch; `npm run dev:api` and
> `npm run dev:web` in two terminals avoid it.

Full setup, access control, sign-out, and `systemd` notes are in the
[self-hosting guide](docs/SELF_HOSTING.md).

Useful commands:

```bash
npm run build       # Type-check and bundle the renderer
npm run serve       # Build, then host on the local network (needs .env)
npm test            # Run normalizer, adapter, agent, and server tests
npm run check       # Type-check, syntax-check, test, and build
npm run capture:ui  # Electron visual QA — broken on this branch, see the status note
npm run dist        # Package the desktop app — broken on this branch, see the status note
```

Packaging is documented in the [release checklist](docs/RELEASE.md), but produces
a non-starting app until the Electron composition root is updated.

## Connect Google Health

### Before you begin

You need:

- the Google account used by the Fitbit mobile app;
- access to [Google Cloud Console](https://console.cloud.google.com/);
- Fitbit Air or another supported tracker already paired and synchronized with the Fitbit app;
- a checkout of this repository; the OAuth client is configured in `.env`, not in the app.

API configuration, OAuth consent, and OAuth credentials must all belong to the same Google Cloud project.

Signing in to OpenFit and granting it health access are **one** Google
authorization. There is no separate step where you connect a health account
after signing in: the same consent covers the `openid` identity scopes and the
read-only Google Health scopes.

### 1. Create a Google Cloud project

1. Open [Create a Google Cloud project](https://console.cloud.google.com/projectcreate).
2. Name the project `OpenFit`.
3. For a personal account, leave **Organization** set to **No organization**.
4. Create the project and select it from the project picker.

### 2. Enable Google Health API

1. With the OpenFit project selected, open [Google Health API](https://console.cloud.google.com/apis/library/health.googleapis.com).
2. Click **Enable**.
3. Wait until the page shows that the API is enabled or displays **Manage**.

### 3. Configure the OAuth consent screen

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) and click **Get started**.
2. Set the application name to `OpenFit` and enter a support email.
3. Select **External** as the audience. **Internal** only supports accounts in the same Google Workspace organization.
4. Enter a contact email and complete the setup.
5. Open [Audience](https://console.cloud.google.com/auth/audience), add the Google account used by Fitbit as a test user, and save it.

While the application remains in OAuth testing mode, only explicitly listed test users can authorize it. Google normally expires refresh tokens for external applications in testing after seven days; reconnect the account when needed or complete Google's production requirements.

### 4. Add read-only scopes

Open [Google Auth Platform scopes](https://console.cloud.google.com/auth/scopes), choose **Add or remove scopes**, and add these read-only Google Health scopes:

```text
https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
https://www.googleapis.com/auth/googlehealth.ecg.readonly
https://www.googleapis.com/auth/googlehealth.irn.readonly
https://www.googleapis.com/auth/googlehealth.location.readonly
https://www.googleapis.com/auth/googlehealth.nutrition.readonly
https://www.googleapis.com/auth/googlehealth.profile.readonly
https://www.googleapis.com/auth/googlehealth.settings.readonly
https://www.googleapis.com/auth/googlehealth.sleep.readonly
```

Do not add write scopes. OpenFit also requests the standard `openid` and `profile` scopes to display the account name and avatar.

### 5. Create the OAuth client

1. Open [Google Auth Platform clients](https://console.cloud.google.com/auth/clients).
2. Create an OAuth client of type **Web application**.
3. Name it `OpenFit`.
4. Leave **Authorized JavaScript origins** empty.
5. Add an **Authorized redirect URI** of `<origin>/auth/callback` for every
   origin you will open OpenFit at. For a local server on the default port:

   ```text
   http://127.0.0.1:7788/auth/callback
   ```

   Add `http://127.0.0.1:7789/auth/callback` as well if you develop with
   `npm run dev` — `dev:api` listens on 7789, so that is a different origin.

   Add a third entry if you also reach OpenFit over an HTTPS tailnet origin:

   ```text
   https://your-host.tail-abc123.ts.net/auth/callback
   ```

6. Create the client and retain its Client ID and Client Secret.

OpenFit no longer opens a loopback listener of its own; the callback is a route
on the OpenFit server itself, and `state`, `nonce`, and PKCE are validated
there. Do not commit or share these credentials.

### 6. Write `.env` and sign in

1. `cp .env.example .env` and fill in:

   ```bash
   OPENFIT_GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   OPENFIT_GOOGLE_CLIENT_SECRET=…
   # Only when you front the server with HTTPS, e.g. via `tailscale serve`:
   # OPENFIT_PUBLIC_ORIGIN=https://your-host.tail-abc123.ts.net
   ```

2. `npm run serve`, then open the URL the banner prints. Start from the origin
   whose `/auth/callback` you registered — sign-in cannot complete anywhere else.
3. Click **Sign in with Google** and choose the account you added as a test user.
4. Approve the requested access. One consent grants both sign-in and read-only
   health access.
5. You land on the dashboard and the first synchronization starts automatically.

OpenFit never asks for a Client ID or Client Secret in the interface. The
endpoint that used to accept them is gone.

The connection is working when OpenFit shows **Google Health** instead of **Demo data**, displays a last synchronization time, and begins showing real device and health metrics. Metric availability depends on the device, region, granted consent, and recent Fitbit mobile synchronization.

### Security note

The Client Secret is read from `.env` on the server and is never sent to the
renderer. OAuth tokens, the health cache, and each account record are encrypted
at rest — with AES-256-GCM under `<data-dir>/master.key` on the server, and with
`safeStorage` (Keychain, Credential Manager, or a Linux secret store) under
Electron. Keep `.env` at mode `0600`; it is git-ignored.

A Client Secret distributed in a desktop binary is not a durable global secret. The current setup is appropriate for personal use and development. A public release should complete Google's verification and security-review requirements.

### Troubleshooting

`redirect_uri_mismatch`

- Register `<origin>/auth/callback` for the exact origin you opened OpenFit at. Do not swap `localhost` for `127.0.0.1`, omit the path, or add a trailing slash.
- Starting at a tailnet IP while only the loopback callback is registered produces this too.

`OPENFIT_GOOGLE_CLIENT_ID is not set`

- The server has no `.env` and no service environment. It exits 1 before creating a data directory. Under `npm run dev` this also kills Vite and Electron.

`Sign-in took too long. Start again.`

- More than ten minutes passed on the Google screens, or the browser began at one origin and Google returned to another.

`Access blocked`, `access_denied`, or unauthorized user

- Confirm that the OAuth audience is **External**.
- Add the correct account under **Audience -> Test users**.
- Sign in with the same account used by the Fitbit app.

`invalid_client`

- Copy the Client ID and Client Secret again from the same OAuth client into `.env`, then restart the server.
- Remove accidental leading or trailing spaces.
- Do not mix credentials from different Cloud projects.

HTTP 403 or API not enabled

- Confirm that Google Health API is enabled in the same project as the OAuth client.

Health disconnected after about a week

- Google expires refresh tokens for apps in testing after 7 days. You are still signed in; click **Reconnect** to grant health access again, which forces a fresh consent screen.

Some metrics are missing

- Open the Fitbit app on the phone and wait for the tracker to synchronize.
- Return to OpenFit and click **Sync**.
- ECG, SpO2, skin temperature, HRV, and irregular-rhythm notifications may not be available for every device, account, or country. OpenFit hides sections for which no data exists.

For a longer checklist, see [Google Health setup](docs/GOOGLE_HEALTH_SETUP.md).

## Project structure

```text
.env                          OAuth client for sign-in; required, git-ignored
core/                         Transport-agnostic backend (no Electron, no HTTP)
  app.cjs                     One account's capabilities, built from its data directory
  accounts.cjs                Google subject -> encrypted per-account directory
  account-registry.cjs        One cached app instance per signed-in account
  identity.cjs                Google ID token claim validation
  secrets.cjs                 safeStorage or AES-256-GCM envelope storage
  credentials.cjs             Token storage and public status
  sync.cjs                    Provider sync with the minimum-useful-response gate
  health-cache.cjs            Encrypted per-day archive
  providers/                  Google Health v4 and legacy Fitbit adapters
  agents/                     Assistant backends behind one interface
server/
  bin.cjs                     CLI entry, composition root, address discovery, banner
  env.cjs                     Reads the OAuth client from .env and the environment
  index.cjs                   HTTP wiring, session/bearer gate, account resolution
  auth.cjs                    Bearer token and account resolution rules
  session.cjs                 Signed session cookies keyed off master.key
  login-page.cjs              Server-rendered sign-in page for anonymous visitors
  static.cjs                  dist/ serving with security headers
  routes/                     health, assistant, events (SSE), login
electron/
  main.cjs                    Desktop shell — not updated for sign-in; does not start
src/
  components/                 Views, charts, and assistant-ui chat
  data/                       Demo data and provider-independent normalization
  lib/api.ts                  fetch + SSE client, the renderer's only data path
  App.tsx                     UI, connection state, sign-out
  types.ts                    Shared renderer/backend contracts
scripts/
  capture-ui.cjs              Electron visual smoke test
  check-node-syntax.cjs       Syntax-checks every shipped CommonJS file
docs/
  ARCHITECTURE.md             System decisions and boundaries
  SELF_HOSTING.md             Running the server, sign-in, Tailscale, systemd
  AGENTS.md                   Assistant backend interface and how to add one
  DATA_COVERAGE.md            Data coverage and limitations
  GOOGLE_HEALTH_SETUP.md      Extended OAuth setup guide
  RELEASE.md                  Signing, notarization, and release process
```

See [Architecture](docs/ARCHITECTURE.md) for security boundaries and design decisions.

## Interface principles

- one primary metric per screen, with secondary details ordered by importance;
- no empty cards: unavailable sections remain hidden;
- one accent color for status, progress, and actions;
- aggregated intraday samples for responsive charts without changing minimum, maximum, or latest values;
- accessible shadcn/Radix components and responsive layouts without horizontal overflow.

## Health assistant

The chat button in the top bar opens a right-side panel built with assistant-ui primitives. Two backends are supported and either may be used:

| Backend | Requires | Transport |
| --- | --- | --- |
| Codex | Codex Desktop, signed in | `codex app-server` over JSONL |
| Claude Code | `claude` on your `PATH`, signed in | `claude -p --output-format stream-json` |

OpenFit reuses whichever local login you already have; no API key is stored or
required. The first available backend is selected automatically, and a picker
appears in the assistant header when both are installed. See
[assistant backends](docs/AGENTS.md) for the interface and how to add another.

Both run with the same instructions and the same restrictions: a read-only,
network-disabled sandbox for Codex, and every tool denied with slash commands,
MCP, and user settings disabled for Claude Code. Neither can read your files,
run commands, or browse the web.

When you send a message, OpenFit creates a compact context containing normalized
metrics, available dates, and details for the selected day. It does not include
OAuth credentials or encrypted files, and it is sent only when you use the chat.
The assistant may navigate to an OpenFit view or date, but it cannot modify
health data.

## Official references

- [Google Health API: Cloud and OAuth setup](https://developers.google.com/health/setup)
- [Google Health API: scopes](https://developers.google.com/health/scopes)
- [Google Health API: migration from Fitbit Web API](https://developers.google.com/health/migration)
- [Google Health API: data types](https://developers.google.com/health/data-types)
- [Google Health API: endpoints](https://developers.google.com/health/endpoints)
- [Google OAuth for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth for installed applications](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Fitbit OAuth 2.0 with PKCE](https://dev.fitbit.com/build/reference/web-api/developer-guide/authorization/)

Icons: Nucleo Essential Outline (c) Nucleo, used under the [Nucleo license](https://nucleoapp.com/license/).

The information displayed by OpenFit is not a diagnosis or medical advice.
