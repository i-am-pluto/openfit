# Google OAuth Login and Per-Account Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace browser bearer-token access with Google sign-in, where one consent flow grants both identity and the health scopes, and each Google account gets an isolated encrypted directory.

**Architecture:** A new `server/env.cjs` reads the OAuth client from `.env` at startup. `core/identity.cjs` validates the `id_token` that the existing Google token exchange already returns. `server/session.cjs` issues an HMAC-signed cookie keyed off the existing `master.key`. `core/accounts.cjs` maps the Google `sub` to a hashed directory, and `server/bin.cjs` turns its single `createApp` into a registry of one app per account. The bearer token survives for `/api/*` only.

**Tech Stack:** Node 22 (CommonJS `.cjs` for server and core), Vitest, no new runtime dependencies.

## Global Constraints

- Node `>=22`, npm `>=10`. `process.loadEnvFile()` is available; do not add `dotenv`.
- **No new runtime dependencies.** `.npmrc` sets `save-exact=true`; if a dev dependency is unavoidable, pin it exactly.
- Server and core files are CommonJS `.cjs`, start with `'use strict'`, use 2-space indent and **no semicolons**. Match surrounding style exactly.
- Tests are colocated `*.test.ts`, run under Vitest, and load CJS via `createRequire(import.meta.url)`.
- **No test may perform network I/O.** Inject a `fetch` double.
- The CSP in `server/static.cjs` must not be loosened. `form-action 'none'` stays; sign-in is a link, not a form.
- Constant-time comparison uses the existing `sameToken` from `server/auth.cjs`.
- Every file written to disk that holds secrets uses mode `0600`; directories use `0700`.
- Spec: `docs/superpowers/specs/2026-08-09-google-oauth-login-design.md`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server/env.cjs` | new — load `.env`, validate required vars, fail fast |
| `core/identity.cjs` | new — validate ID token claims; no HTTP, no cookies |
| `server/session.cjs` | new — sign/verify session cookie, epoch check |
| `core/accounts.cjs` | new — `sub` → directory, epoch, first-run migration |
| `core/account-registry.cjs` | new — cache one app per account, dispose all |
| `server/login-page.cjs` | new — server-rendered login HTML |
| `server/routes/login.cjs` | new — `/auth/login`, `/auth/callback`, `/auth/logout` |
| `server/auth.cjs` | modify — keep bearer, add session verification |
| `server/index.cjs` | modify — guard accepts session or bearer; login page for anon HTML |
| `server/bin.cjs` | modify — build registry, drop token from banner |
| `core/app.cjs` | modify — remove `saveConfig`, `connect` returns `reauthorizeUrl` |
| `core/providers/google-health.cjs` | modify — add `email` scope |
| `.gitignore`, `.env.example` | modify/new |

---

### Task 1: Environment loading

**Files:**
- Create: `server/env.cjs`
- Create: `server/env.test.ts`
- Create: `.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: `loadEnv({ env, loadEnvFile }) -> { clientId, clientSecret, publicOrigin }`; throws `Error` naming the missing variable.

- [ ] **Step 1: Write the failing test**

Create `server/env.test.ts`:

```ts
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { loadEnv } = require('./env.cjs') as {
  loadEnv: (options: Record<string, any>) => { clientId: string; clientSecret: string; publicOrigin: string | null }
}

const noopLoad = () => {}

describe('loadEnv', () => {
  it('returns the client credentials and origin', () => {
    const result = loadEnv({
      env: {
        OPENFIT_GOOGLE_CLIENT_ID: 'id-1',
        OPENFIT_GOOGLE_CLIENT_SECRET: 'secret-1',
        OPENFIT_PUBLIC_ORIGIN: 'https://box.ts.net',
      },
      loadEnvFile: noopLoad,
    })

    expect(result).toEqual({ clientId: 'id-1', clientSecret: 'secret-1', publicOrigin: 'https://box.ts.net' })
  })

  it('treats a missing public origin as null', () => {
    const result = loadEnv({
      env: { OPENFIT_GOOGLE_CLIENT_ID: 'id-1', OPENFIT_GOOGLE_CLIENT_SECRET: 'secret-1' },
      loadEnvFile: noopLoad,
    })

    expect(result.publicOrigin).toBeNull()
  })

  it('names the missing variable', () => {
    expect(() => loadEnv({ env: { OPENFIT_GOOGLE_CLIENT_ID: 'id-1' }, loadEnvFile: noopLoad }))
      .toThrow(/OPENFIT_GOOGLE_CLIENT_SECRET/)
    expect(() => loadEnv({ env: {}, loadEnvFile: noopLoad }))
      .toThrow(/OPENFIT_GOOGLE_CLIENT_ID/)
  })

  it('ignores a missing .env file but propagates other read errors', () => {
    const missing = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) }
    expect(() => loadEnv({
      env: { OPENFIT_GOOGLE_CLIENT_ID: 'a', OPENFIT_GOOGLE_CLIENT_SECRET: 'b' },
      loadEnvFile: missing,
    })).not.toThrow()

    const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
    expect(() => loadEnv({ env: {}, loadEnvFile: denied })).toThrow(/denied/)
  })

  it('trims surrounding whitespace', () => {
    const result = loadEnv({
      env: { OPENFIT_GOOGLE_CLIENT_ID: '  id-1  ', OPENFIT_GOOGLE_CLIENT_SECRET: ' secret-1 ' },
      loadEnvFile: noopLoad,
    })
    expect(result.clientId).toBe('id-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/env.test.ts`
Expected: FAIL — `Cannot find module './env.cjs'`

- [ ] **Step 3: Write minimal implementation**

Create `server/env.cjs`:

```js
'use strict'

const REQUIRED = ['OPENFIT_GOOGLE_CLIENT_ID', 'OPENFIT_GOOGLE_CLIENT_SECRET']

/**
 * Reads the OAuth client from `.env` plus the process environment.
 *
 * The login client cannot be configured through the UI: `POST /api/config` is
 * itself guarded, so configuring sign-in would require being signed in.
 */
function loadEnv({ env = process.env, loadEnvFile = process.loadEnvFile, path = '.env' } = {}) {
  try {
    loadEnvFile(path)
  } catch (error) {
    // A missing .env is normal when the variables come from systemd.
    if (error?.code !== 'ENOENT') throw error
  }

  for (const name of REQUIRED) {
    if (!String(env[name] || '').trim()) {
      throw new Error(`${name} is not set. Add it to .env or the service environment.`)
    }
  }

  const publicOrigin = String(env.OPENFIT_PUBLIC_ORIGIN || '').trim()

  return {
    clientId: String(env.OPENFIT_GOOGLE_CLIENT_ID).trim(),
    clientSecret: String(env.OPENFIT_GOOGLE_CLIENT_SECRET).trim(),
    publicOrigin: publicOrigin || null,
  }
}

module.exports = { loadEnv, REQUIRED }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/env.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Add .env.example and ignore .env**

Create `.env.example`:

```bash
# OAuth client from Google Cloud console, Web application type.
# Authorized redirect URI must include <origin>/auth/callback
OPENFIT_GOOGLE_CLIENT_ID=
OPENFIT_GOOGLE_CLIENT_SECRET=

# Bare https origin, no path. Required to sign in from another device.
# OPENFIT_PUBLIC_ORIGIN=https://your-host.tail-abc123.ts.net
```

Append to `.gitignore`:

```
.env
```

- [ ] **Step 6: Verify .env is ignored**

Run: `touch .env && git check-ignore -v .env && rm .env`
Expected: prints a `.gitignore:.env` match. If it prints nothing, the ignore rule did not take.

- [ ] **Step 7: Commit**

```bash
git add server/env.cjs server/env.test.ts .env.example .gitignore
git commit -m "feat: load the OAuth client from .env"
```

---

### Task 2: Identity — ID token validation

**Files:**
- Create: `core/identity.cjs`
- Create: `core/identity.test.ts`
- Modify: `core/providers/google-health.cjs:9-21` (add the `email` scope)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `decodeIdToken(idToken) -> object` — throws on malformed input
  - `validateIdToken(idToken, { clientId, nonce, now }) -> { sub, email }` — throws `Error` on any invalid claim
  - `CLOCK_SKEW_SECONDS = 60`

**Context:** the existing `tokenRequest` in `core/providers/google-health.cjs:58-70` spreads Google's whole token response, so `id_token` is already present on the exchange result. This task only validates it. Google returns the `email` claim only when the `email` scope is requested, which is why the scope list changes here.

- [ ] **Step 1: Write the failing test**

Create `core/identity.test.ts`:

```ts
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { validateIdToken, decodeIdToken, CLOCK_SKEW_SECONDS } = require('./identity.cjs') as {
  validateIdToken: (token: string, options: Record<string, any>) => { sub: string; email: string }
  decodeIdToken: (token: string) => Record<string, any>
  CLOCK_SKEW_SECONDS: number
}

const NOW = 1_760_000_000

function makeToken(claims: Record<string, any>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature-not-checked`
}

function baseClaims(overrides: Record<string, any> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: 'client-1',
    sub: '11223344',
    email: 'person@example.com',
    email_verified: true,
    nonce: 'nonce-1',
    exp: NOW + 3600,
    ...overrides,
  }
}

const options = { clientId: 'client-1', nonce: 'nonce-1', now: NOW }

describe('validateIdToken', () => {
  it('returns sub and email for a valid token', () => {
    expect(validateIdToken(makeToken(baseClaims()), options)).toEqual({
      sub: '11223344',
      email: 'person@example.com',
    })
  })

  it('accepts the accounts.google.com issuer with an https prefix or without', () => {
    expect(validateIdToken(makeToken(baseClaims({ iss: 'accounts.google.com' })), options).sub).toBe('11223344')
  })

  it('rejects a wrong issuer', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ iss: 'https://evil.example' })), options))
      .toThrow(/issuer/i)
  })

  it('rejects a wrong audience', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ aud: 'other-client' })), options))
      .toThrow(/audience/i)
  })

  it('rejects a wrong nonce', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ nonce: 'different' })), options))
      .toThrow(/nonce/i)
  })

  it('rejects an unverified email', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ email_verified: false })), options))
      .toThrow(/verified/i)
  })

  it('rejects a token missing sub or email', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ sub: undefined })), options)).toThrow(/subject/i)
    expect(() => validateIdToken(makeToken(baseClaims({ email: undefined })), options)).toThrow(/email/i)
  })

  it('allows exactly the permitted clock skew and rejects one second beyond it', () => {
    const atBoundary = baseClaims({ exp: NOW - CLOCK_SKEW_SECONDS })
    expect(validateIdToken(makeToken(atBoundary), options).sub).toBe('11223344')

    const past = baseClaims({ exp: NOW - CLOCK_SKEW_SECONDS - 1 })
    expect(() => validateIdToken(makeToken(past), options)).toThrow(/expired/i)
  })

  it('rejects a malformed token', () => {
    expect(() => decodeIdToken('not-a-jwt')).toThrow(/malformed/i)
    expect(() => decodeIdToken('a.b')).toThrow(/malformed/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/identity.test.ts`
Expected: FAIL — `Cannot find module './identity.cjs'`

- [ ] **Step 3: Write minimal implementation**

Create `core/identity.cjs`:

```js
'use strict'

// The laptop hosting OpenFit suspends and resumes, so a strict `exp` comparison
// produces sporadic sign-in failures with no legible cause.
const CLOCK_SKEW_SECONDS = 60

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

function decodeIdToken(idToken) {
  const parts = String(idToken || '').split('.')
  if (parts.length !== 3) throw new Error('The Google ID token is malformed.')
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error('The Google ID token is malformed.')
  }
}

/**
 * Validates the claims of an ID token fetched directly from Google's token
 * endpoint over TLS.
 *
 * The signature is deliberately not verified. OIDC Core 3.1.3.7 permits
 * skipping signature validation when the token is received directly from the
 * token endpoint over a TLS-protected server-to-server channel, which is the
 * only way this function is ever reached. If a future change ever accepts an
 * ID token supplied by a client, this reasoning collapses and JWKS
 * verification becomes mandatory.
 */
function validateIdToken(idToken, { clientId, nonce, now = Math.floor(Date.now() / 1000) }) {
  const claims = decodeIdToken(idToken)

  if (!ISSUERS.has(String(claims.iss))) throw new Error('The Google ID token has an unexpected issuer.')
  if (String(claims.aud) !== String(clientId)) throw new Error('The Google ID token has an unexpected audience.')
  if (String(claims.nonce || '') !== String(nonce)) throw new Error('The Google ID token nonce does not match.')
  if (Number(claims.exp || 0) < now - CLOCK_SKEW_SECONDS) throw new Error('The Google ID token has expired.')

  const sub = String(claims.sub || '')
  const email = String(claims.email || '')
  if (!sub) throw new Error('The Google ID token has no subject.')
  if (!email) throw new Error('The Google ID token has no email address.')
  if (claims.email_verified !== true) throw new Error('The Google account email address is not verified.')

  return { sub, email }
}

module.exports = { validateIdToken, decodeIdToken, CLOCK_SKEW_SECONDS }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/identity.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Add the email scope**

In `core/providers/google-health.cjs`, the `SCOPES` array at line 9 begins:

```js
const SCOPES = [
  'openid',
  'profile',
```

Change it to:

```js
const SCOPES = [
  'openid',
  'profile',
  'email',
```

Leave the nine `googlehealth.*` entries untouched.

- [ ] **Step 6: Run the provider tests to confirm nothing regressed**

Run: `npx vitest run core/providers/`
Expected: PASS. If a test asserts an exact scope string, update it to include `email`.

- [ ] **Step 7: Commit**

```bash
git add core/identity.cjs core/identity.test.ts core/providers/google-health.cjs
git commit -m "feat: validate Google ID token claims"
```

---

### Task 3: Session cookie

**Files:**
- Create: `server/session.cjs`
- Create: `server/session.test.ts`

**Interfaces:**
- Consumes: `sameToken` from `server/auth.cjs`
- Produces:
  - `deriveSessionKey(masterKey) -> Buffer`
  - `createSessions({ masterKey, secure }) -> { cookieName, sign(payload), verify(cookieValue), cookie(payload), clearCookie() }`
  - `sign` takes `{ sub, email, epoch }` and stamps `iat`
  - `verify` returns the payload object or `null` — it never throws
  - `SESSION_COOKIE = 'openfit_session'`

- [ ] **Step 1: Write the failing test**

Create `server/session.test.ts`:

```ts
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createSessions, deriveSessionKey, SESSION_COOKIE } = require('./session.cjs') as {
  createSessions: (options: Record<string, any>) => {
    cookieName: string
    sign: (payload: Record<string, any>) => string
    verify: (value: string) => Record<string, any> | null
    cookie: (payload: Record<string, any>) => string
    clearCookie: () => string
  }
  deriveSessionKey: (masterKey: Buffer) => Buffer
  SESSION_COOKIE: string
}

const masterKey = Buffer.alloc(32, 7)
const otherKey = Buffer.alloc(32, 9)
const identity = { sub: '123', email: 'a@example.com', epoch: 1 }

describe('sessions', () => {
  it('round-trips a signed payload', () => {
    const sessions = createSessions({ masterKey, secure: true })
    const value = sessions.verify(sessions.sign(identity))

    expect(value).toMatchObject({ sub: '123', email: 'a@example.com', epoch: 1 })
    expect(typeof value?.iat).toBe('number')
  })

  it('derives the same key from the same master key and a different one otherwise', () => {
    expect(deriveSessionKey(masterKey).equals(deriveSessionKey(masterKey))).toBe(true)
    expect(deriveSessionKey(masterKey).equals(deriveSessionKey(otherKey))).toBe(false)
  })

  it('survives a restart: a new instance verifies the old cookie', () => {
    const signed = createSessions({ masterKey, secure: true }).sign(identity)
    expect(createSessions({ masterKey, secure: true }).verify(signed)).toMatchObject({ sub: '123' })
  })

  it('rejects a cookie signed with a different master key', () => {
    const signed = createSessions({ masterKey, secure: true }).sign(identity)
    expect(createSessions({ masterKey: otherKey, secure: true }).verify(signed)).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const sessions = createSessions({ masterKey, secure: true })
    const [version, , mac] = sessions.sign(identity).split('.')
    const forged = Buffer.from(JSON.stringify({ ...identity, sub: '999' })).toString('base64url')

    expect(sessions.verify(`${version}.${forged}.${mac}`)).toBeNull()
  })

  it('rejects a tampered signature and garbage input', () => {
    const sessions = createSessions({ masterKey, secure: true })
    const [version, payload] = sessions.sign(identity).split('.')

    expect(sessions.verify(`${version}.${payload}.${crypto.randomBytes(32).toString('base64url')}`)).toBeNull()
    expect(sessions.verify('garbage')).toBeNull()
    expect(sessions.verify('')).toBeNull()
    expect(sessions.verify(`v9.${payload}.${crypto.randomBytes(32).toString('base64url')}`)).toBeNull()
  })

  it('sets Secure only for https origins', () => {
    expect(createSessions({ masterKey, secure: true }).cookie(identity)).toContain('Secure')
    expect(createSessions({ masterKey, secure: false }).cookie(identity)).not.toContain('Secure')
  })

  it('issues an HttpOnly, SameSite=Lax, path-scoped cookie', () => {
    const cookie = createSessions({ masterKey, secure: true }).cookie(identity)

    expect(cookie).toContain(`${SESSION_COOKIE}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
  })

  it('clears the cookie with an immediate expiry', () => {
    expect(createSessions({ masterKey, secure: true }).clearCookie()).toContain('Max-Age=0')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session.test.ts`
Expected: FAIL — `Cannot find module './session.cjs'`

- [ ] **Step 3: Write minimal implementation**

Create `server/session.cjs`:

```js
'use strict'

const crypto = require('node:crypto')

const { sameToken } = require('./auth.cjs')

const SESSION_COOKIE = 'openfit_session'
const VERSION = 'v1'
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60

// Key separation: the session signing key must never be the same bytes as the
// data-encryption key, even though both come from master.key.
function deriveSessionKey(masterKey) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), 'openfit-session-v1', 32))
}

function createSessions({ masterKey, secure = false }) {
  const key = deriveSessionKey(masterKey)

  const mac = (encodedPayload) =>
    crypto.createHmac('sha256', key).update(`${VERSION}.${encodedPayload}`).digest('base64url')

  function sign(payload) {
    const body = { ...payload, iat: Math.floor(Date.now() / 1000) }
    const encoded = Buffer.from(JSON.stringify(body)).toString('base64url')
    return `${VERSION}.${encoded}.${mac(encoded)}`
  }

  // Never throws: a corrupt cookie is a user-facing condition, not a fault.
  function verify(value) {
    const parts = String(value || '').split('.')
    if (parts.length !== 3) return null
    const [version, encoded, signature] = parts
    if (version !== VERSION) return null
    if (!sameToken(signature, mac(encoded))) return null
    try {
      return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      return null
    }
  }

  const attributes = (maxAge) => {
    const parts = [`Path=/`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
    if (secure) parts.push('Secure')
    return parts
  }

  return {
    cookieName: SESSION_COOKIE,
    sign,
    verify,
    cookie: (payload) => [`${SESSION_COOKIE}=${sign(payload)}`, ...attributes(MAX_AGE_SECONDS)].join('; '),
    clearCookie: () => [`${SESSION_COOKIE}=`, ...attributes(0)].join('; '),
  }
}

module.exports = { createSessions, deriveSessionKey, SESSION_COOKIE, MAX_AGE_SECONDS }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/session.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add server/session.cjs server/session.test.ts
git commit -m "feat: add signed session cookies derived from master.key"
```

---

### Task 4: Accounts — directory mapping, epoch, migration

**Files:**
- Create: `core/accounts.cjs`
- Create: `core/accounts.test.ts`

**Interfaces:**
- Consumes: `createSecretStore` from `core/secrets.cjs`
- Produces:
  - `accountId(sub) -> string` — 16 lowercase hex characters
  - `createAccounts({ dataDir, secrets, fs }) -> { resolve({ sub, email }), get(sub), list(), bumpEpoch(sub), directoryFor(sub) }`
  - `resolve` returns `{ id, sub, email, epoch, dir, createdAt }` and creates the directory on first call
  - `list()` returns an array of `{ id, sub, email, epoch, dir, createdAt }`
  - `get(sub)` returns the same shape or `null`

**Context:** `core/app.cjs:47-48` names the on-disk files `credentials.secure.json` and `health-cache.secure.json`. The migration moves exactly those two.

- [ ] **Step 1: Write the failing test**

Create `core/accounts.test.ts`:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createAccounts, accountId } = require('./accounts.cjs') as {
  createAccounts: (options: Record<string, any>) => any
  accountId: (sub: string) => string
}
const { createSecretStore } = require('./secrets.cjs') as {
  createSecretStore: (options: Record<string, any>) => any
}

const dirs: string[] = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-accounts-'))
  dirs.push(dir)
  return dir
}

function build(dataDir: string) {
  return createAccounts({ dataDir, secrets: createSecretStore({ dir: dataDir }) })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('accounts', () => {
  it('maps a sub to a stable 16-hex id', () => {
    expect(accountId('11223344')).toMatch(/^[0-9a-f]{16}$/)
    expect(accountId('11223344')).toBe(accountId('11223344'))
    expect(accountId('11223344')).not.toBe(accountId('55667788'))
  })

  it('creates the account directory with mode 0700', () => {
    const dataDir = tempDir()
    const account = build(dataDir).resolve({ sub: '1', email: 'a@example.com' })

    expect(fs.existsSync(account.dir)).toBe(true)
    expect(fs.statSync(account.dir).mode & 0o777).toBe(0o700)
    expect(account.dir.startsWith(path.join(dataDir, 'accounts'))).toBe(true)
  })

  it('gives separate directories to separate accounts and lists both', () => {
    const accounts = build(tempDir())
    const first = accounts.resolve({ sub: '1', email: 'a@example.com' })
    const second = accounts.resolve({ sub: '2', email: 'b@example.com' })

    expect(first.dir).not.toBe(second.dir)
    expect(accounts.list().map((entry: any) => entry.email).sort()).toEqual(['a@example.com', 'b@example.com'])
  })

  it('keeps createdAt and updates a changed email on re-resolve', () => {
    const accounts = build(tempDir())
    const first = accounts.resolve({ sub: '1', email: 'old@example.com' })
    const again = accounts.resolve({ sub: '1', email: 'new@example.com' })

    expect(again.createdAt).toBe(first.createdAt)
    expect(again.email).toBe('new@example.com')
  })

  it('increments and persists the epoch', () => {
    const dataDir = tempDir()
    expect(build(dataDir).resolve({ sub: '1', email: 'a@example.com' }).epoch).toBe(1)
    expect(build(dataDir).bumpEpoch('1')).toBe(2)
    expect(build(dataDir).get('1').epoch).toBe(2)
  })

  it('cannot escape the accounts directory with a hostile sub', () => {
    const dataDir = tempDir()
    const account = build(dataDir).resolve({ sub: '../../etc/passwd', email: 'a@example.com' })

    expect(account.dir.startsWith(path.join(dataDir, 'accounts') + path.sep)).toBe(true)
    expect(account.dir).not.toContain('..')
  })

  it('adopts root-level data on first sign-in when accounts/ is absent', () => {
    const dataDir = tempDir()
    fs.writeFileSync(path.join(dataDir, 'credentials.secure.json'), '{"encrypted":true}')
    fs.writeFileSync(path.join(dataDir, 'health-cache.secure.json'), '{"encrypted":true}')

    const account = build(dataDir).resolve({ sub: '1', email: 'a@example.com' })

    expect(fs.existsSync(path.join(account.dir, 'credentials.secure.json'))).toBe(true)
    expect(fs.existsSync(path.join(account.dir, 'health-cache.secure.json'))).toBe(true)
    expect(fs.existsSync(path.join(dataDir, 'credentials.secure.json'))).toBe(false)
  })

  it('does not adopt root-level data once an account exists', () => {
    const dataDir = tempDir()
    build(dataDir).resolve({ sub: '1', email: 'a@example.com' })
    fs.writeFileSync(path.join(dataDir, 'credentials.secure.json'), '{"encrypted":true}')

    const second = build(dataDir).resolve({ sub: '2', email: 'b@example.com' })

    expect(fs.existsSync(path.join(second.dir, 'credentials.secure.json'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'credentials.secure.json'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/accounts.test.ts`
Expected: FAIL — `Cannot find module './accounts.cjs'`

- [ ] **Step 3: Write minimal implementation**

Create `core/accounts.cjs`:

```js
'use strict'

const crypto = require('node:crypto')
const nodeFs = require('node:fs')
const path = require('node:path')

const ACCOUNTS_DIR = 'accounts'
const ACCOUNT_FILE = 'account.json'
const ADOPTABLE = ['credentials.secure.json', 'health-cache.secure.json']

// A hash rather than the raw `sub`: fixed length, filesystem-safe, does not
// disclose the Google account id to anything that can list the directory, and
// traversal through a hostile value is structurally impossible.
function accountId(sub) {
  return crypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 16)
}

function createAccounts({ dataDir, secrets, fs = nodeFs }) {
  if (!dataDir) throw new Error('createAccounts requires a dataDir.')
  if (!secrets) throw new Error('createAccounts requires a secret store.')

  const root = path.join(dataDir, ACCOUNTS_DIR)
  const directoryFor = (sub) => path.join(root, accountId(sub))
  const recordFile = (dir) => path.join(dir, ACCOUNT_FILE)

  const readRecord = (dir) => secrets.read(recordFile(dir), null)

  function adoptRootData(dir) {
    for (const name of ADOPTABLE) {
      const from = path.join(dataDir, name)
      if (!fs.existsSync(from)) continue
      fs.renameSync(from, path.join(dir, name))
      console.log(`Adopted ${name} into ${path.basename(dir)}.`)
    }
  }

  return {
    directoryFor,

    get(sub) {
      const dir = directoryFor(sub)
      const record = readRecord(dir)
      return record ? { ...record, id: accountId(sub), dir } : null
    },

    list() {
      let entries = []
      try {
        entries = fs.readdirSync(root)
      } catch {
        return []
      }
      return entries
        .map((id) => {
          const dir = path.join(root, id)
          const record = readRecord(dir)
          return record ? { ...record, id, dir } : null
        })
        .filter(Boolean)
    },

    resolve({ sub, email }) {
      // Adoption is gated on accounts/ being absent, so it can only ever run
      // for the very first sign-in.
      const firstEver = !fs.existsSync(root)
      const dir = directoryFor(sub)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (firstEver) adoptRootData(dir)

      const existing = readRecord(dir)
      const record = existing
        ? { ...existing, email: String(email) }
        : { sub: String(sub), email: String(email), epoch: 1, createdAt: new Date().toISOString() }

      secrets.write(recordFile(dir), record)
      return { ...record, id: accountId(sub), dir }
    },

    bumpEpoch(sub) {
      const dir = directoryFor(sub)
      const record = readRecord(dir)
      if (!record) throw new Error('Unknown account.')
      const updated = { ...record, epoch: Number(record.epoch || 1) + 1 }
      secrets.write(recordFile(dir), updated)
      return updated.epoch
    },
  }
}

module.exports = { createAccounts, accountId, ACCOUNTS_DIR, ACCOUNT_FILE }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/accounts.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add core/accounts.cjs core/accounts.test.ts
git commit -m "feat: isolate each Google account in its own encrypted directory"
```

---

### Task 5: Account registry

**Files:**
- Create: `core/account-registry.cjs`
- Create: `core/account-registry.test.ts`

**Interfaces:**
- Consumes: `createAccounts` (Task 4), `createApp` from `core/app.cjs`
- Produces: `createAccountRegistry({ dataDir, secrets, accounts, createApp, appOptions }) -> { forAccount(account), disposeAll() }`
  - `forAccount` caches by `account.id` and returns the app instance
  - `disposeAll` awaits `dispose()` on **every** cached app

**Context:** `core/app.cjs:44` calls `createSecretStore({ dir: dataDir })` when no store is injected, which would mint one `master.key` per account. The registry passes the root store in via `options.secrets` so `master.key` stays instance-wide. `server/index.cjs:141` currently disposes a single app on server close; Task 7 repoints it at `disposeAll`.

- [ ] **Step 1: Write the failing test**

Create `core/account-registry.test.ts`:

```ts
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createAccountRegistry } = require('./account-registry.cjs') as {
  createAccountRegistry: (options: Record<string, any>) => {
    forAccount: (account: any) => any
    disposeAll: () => Promise<void>
  }
}

const secrets = { read: vi.fn(), write: vi.fn(), remove: vi.fn(), describe: () => ({ encrypted: true, backend: 'x' }) }

function build() {
  const created: any[] = []
  const createApp = vi.fn((options: any) => {
    const app = { dataDir: options.dataDir, secrets: options.secrets, dispose: vi.fn(async () => {}) }
    created.push(app)
    return app
  })
  const registry = createAccountRegistry({ dataDir: '/data', secrets, createApp, appOptions: { env: {} } })
  return { registry, createApp, created }
}

describe('account registry', () => {
  it('creates one app per account and caches it', () => {
    const { registry, createApp } = build()
    const account = { id: 'aaa', dir: '/data/accounts/aaa' }

    const first = registry.forAccount(account)
    const second = registry.forAccount(account)

    expect(first).toBe(second)
    expect(createApp).toHaveBeenCalledTimes(1)
  })

  it('builds the app against the account directory', () => {
    const { registry } = build()
    const app = registry.forAccount({ id: 'aaa', dir: '/data/accounts/aaa' })

    expect(app.dataDir).toBe('/data/accounts/aaa')
  })

  it('shares the instance-wide secret store so master.key is not per-account', () => {
    const { registry } = build()
    const app = registry.forAccount({ id: 'aaa', dir: '/data/accounts/aaa' })

    expect(app.secrets).toBe(secrets)
  })

  it('creates distinct apps for distinct accounts', () => {
    const { registry, createApp } = build()
    registry.forAccount({ id: 'aaa', dir: '/a' })
    registry.forAccount({ id: 'bbb', dir: '/b' })

    expect(createApp).toHaveBeenCalledTimes(2)
  })

  it('disposes every cached app', async () => {
    const { registry, created } = build()
    registry.forAccount({ id: 'aaa', dir: '/a' })
    registry.forAccount({ id: 'bbb', dir: '/b' })

    await registry.disposeAll()

    expect(created).toHaveLength(2)
    for (const app of created) expect(app.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes the remaining apps even when one throws', async () => {
    const { registry, created } = build()
    const failing = registry.forAccount({ id: 'aaa', dir: '/a' })
    registry.forAccount({ id: 'bbb', dir: '/b' })
    failing.dispose.mockRejectedValueOnce(new Error('boom'))

    await expect(registry.disposeAll()).resolves.toBeUndefined()
    expect(created[1].dispose).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/account-registry.test.ts`
Expected: FAIL — `Cannot find module './account-registry.cjs'`

- [ ] **Step 3: Write minimal implementation**

Create `core/account-registry.cjs`:

```js
'use strict'

/**
 * One app instance per signed-in account, created lazily and cached.
 *
 * The root secret store is injected into every app so `master.key` stays
 * instance-wide; left to itself `createApp` would create one key per account
 * directory.
 */
function createAccountRegistry({ dataDir, secrets, createApp, appOptions = {} }) {
  if (!dataDir) throw new Error('createAccountRegistry requires a dataDir.')
  if (!secrets) throw new Error('createAccountRegistry requires a secret store.')

  const apps = new Map()

  return {
    forAccount(account) {
      const cached = apps.get(account.id)
      if (cached) return cached

      const app = createApp({ ...appOptions, dataDir: account.dir, secrets })
      apps.set(account.id, app)
      return app
    },

    // One failing dispose must not strand the others.
    async disposeAll() {
      const pending = [...apps.values()].map(async (app) => {
        try {
          await app.dispose()
        } catch (error) {
          console.warn('Disposing an account app failed.', error?.message)
        }
      })
      apps.clear()
      await Promise.all(pending)
    },
  }
}

module.exports = { createAccountRegistry }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/account-registry.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add core/account-registry.cjs core/account-registry.test.ts
git commit -m "feat: cache one app instance per account"
```

---

### Task 6: Login page and auth routes

**Files:**
- Create: `server/login-page.cjs`
- Create: `server/routes/login.cjs`
- Create: `server/routes/login.test.ts`

**Interfaces:**
- Consumes: `validateIdToken` (Task 2), `createSessions` (Task 3), `createAccounts` (Task 4)
- Produces: `registerLoginRoutes({ addPublic, deps })` where `deps` is
  `{ sessions, accounts, identity: { clientId, clientSecret, redirectUri }, exchange, authorizationUrl, validateIdToken, onAuthorized }`
  - `onAuthorized(account, tokens) -> Promise<void>` — stores the exchanged token against that account
  - `exchange(code, verifier) -> Promise<{ id_token, refresh_token, access_token }>` — injected so tests never reach the network
  - `authorizationUrl({ state, nonce, challenge, prompt }) -> string`
  - Registers `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`

**Context:** these are registered with `addPublic`, the unguarded registration helper already used for OAuth at `server/index.cjs:72`. The pending state cookie is separate from the session cookie and lives for ten minutes.

- [ ] **Step 1: Write the failing test**

Create `server/routes/login.test.ts`:

```ts
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { registerLoginRoutes, PENDING_COOKIE } = require('./login.cjs') as {
  registerLoginRoutes: (options: Record<string, any>) => void
  PENDING_COOKIE: string
}
const { createSessions } = require('../session.cjs') as { createSessions: (o: any) => any }

const masterKey = Buffer.alloc(32, 3)

function collect(deps: Record<string, any>) {
  const routes = new Map<string, Function>()
  const addPublic = (method: string, pathname: string, handle: Function) => routes.set(`${method} ${pathname}`, handle)
  registerLoginRoutes({ addPublic, deps })
  return routes
}

function fakeResponse() {
  return {
    headers: {} as Record<string, any>,
    status: 0,
    body: '',
    setHeader(name: string, value: any) { this.headers[name.toLowerCase()] = value },
    writeHead(status: number, headers: Record<string, any> = {}) {
      this.status = status
      Object.assign(this.headers, headers)
    },
    end(body = '') { this.body = String(body) },
  }
}

function buildDeps(overrides: Record<string, any> = {}) {
  const sessions = createSessions({ masterKey, secure: false })
  return {
    sessions,
    accounts: {
      resolve: vi.fn(({ sub, email }: any) => ({ id: 'acc1', sub, email, epoch: 1, dir: '/d/acc1' })),
      bumpEpoch: vi.fn(() => 2),
    },
    identity: { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://box.ts.net/auth/callback' },
    onAuthorized: vi.fn(async () => {}),
    exchange: vi.fn(async () => ({ id_token: 'stub', refresh_token: 'r1' })),
    authorizationUrl: vi.fn(({ state }: any) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
    validateIdToken: vi.fn(() => ({ sub: '123', email: 'a@example.com' })),
    ...overrides,
  }
}

describe('login routes', () => {
  it('redirects to Google and sets a pending cookie', async () => {
    const deps = buildDeps()
    const response = fakeResponse()

    await collect(deps).get('GET /auth/login')!({ url: '/auth/login', headers: {} }, response, { url: new URL('https://box.ts.net/auth/login') })

    expect(response.status).toBe(302)
    expect(String(response.headers.location)).toContain('accounts.google.com')
    expect(String(response.headers['set-cookie'])).toContain(PENDING_COOKIE)
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=600')
  })

  it('completes the callback, stores the token and issues a session', async () => {
    const deps = buildDeps()
    const routes = collect(deps)

    const loginResponse = fakeResponse()
    await routes.get('GET /auth/login')!({ url: '/auth/login', headers: {} }, loginResponse, { url: new URL('https://box.ts.net/auth/login') })
    const pending = String(loginResponse.headers['set-cookie']).split(';')[0]
    const state = new URL(String(loginResponse.headers.location)).searchParams.get('state')

    const callbackResponse = fakeResponse()
    await routes.get('GET /auth/callback')!(
      { url: `/auth/callback?code=abc&state=${state}`, headers: { cookie: pending } },
      callbackResponse,
      { url: new URL(`https://box.ts.net/auth/callback?code=abc&state=${state}`) },
    )

    expect(deps.exchange).toHaveBeenCalledTimes(1)
    expect(deps.accounts.resolve).toHaveBeenCalledWith({ sub: '123', email: 'a@example.com' })
    expect(deps.onAuthorized).toHaveBeenCalledTimes(1)
    expect(callbackResponse.status).toBe(302)
    expect(String(callbackResponse.headers['set-cookie'])).toContain('openfit_session=')
  })

  it('rejects a callback with no pending cookie', async () => {
    const response = fakeResponse()
    await collect(buildDeps()).get('GET /auth/callback')!(
      { url: '/auth/callback?code=abc&state=s', headers: {} },
      response,
      { url: new URL('https://box.ts.net/auth/callback?code=abc&state=s') },
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatch(/took too long/i)
  })

  it('rejects a mismatched state without disclosing detail', async () => {
    const deps = buildDeps()
    const routes = collect(deps)
    const loginResponse = fakeResponse()
    await routes.get('GET /auth/login')!({ url: '/auth/login', headers: {} }, loginResponse, { url: new URL('https://box.ts.net/auth/login') })
    const pending = String(loginResponse.headers['set-cookie']).split(';')[0]

    const response = fakeResponse()
    await routes.get('GET /auth/callback')!(
      { url: '/auth/callback?code=abc&state=wrong', headers: { cookie: pending } },
      response,
      { url: new URL('https://box.ts.net/auth/callback?code=abc&state=wrong') },
    )

    expect(response.status).toBe(400)
    expect(deps.exchange).not.toHaveBeenCalled()
  })

  it('surfaces access_denied from Google', async () => {
    const deps = buildDeps()
    const routes = collect(deps)
    const loginResponse = fakeResponse()
    await routes.get('GET /auth/login')!({ url: '/auth/login', headers: {} }, loginResponse, { url: new URL('https://box.ts.net/auth/login') })
    const pending = String(loginResponse.headers['set-cookie']).split(';')[0]
    const state = new URL(String(loginResponse.headers.location)).searchParams.get('state')

    const response = fakeResponse()
    await routes.get('GET /auth/callback')!(
      { url: `/auth/callback?error=access_denied&state=${state}`, headers: { cookie: pending } },
      response,
      { url: new URL(`https://box.ts.net/auth/callback?error=access_denied&state=${state}`) },
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatch(/denied|cancel/i)
  })

  it('returns 403 when the email is unverified', async () => {
    const deps = buildDeps({
      validateIdToken: vi.fn(() => { throw new Error('The Google account email address is not verified.') }),
    })
    const routes = collect(deps)
    const loginResponse = fakeResponse()
    await routes.get('GET /auth/login')!({ url: '/auth/login', headers: {} }, loginResponse, { url: new URL('https://box.ts.net/auth/login') })
    const pending = String(loginResponse.headers['set-cookie']).split(';')[0]
    const state = new URL(String(loginResponse.headers.location)).searchParams.get('state')

    const response = fakeResponse()
    await routes.get('GET /auth/callback')!(
      { url: `/auth/callback?code=abc&state=${state}`, headers: { cookie: pending } },
      response,
      { url: new URL(`https://box.ts.net/auth/callback?code=abc&state=${state}`) },
    )

    expect(response.status).toBe(401)
  })

  it('clears the cookie on logout', async () => {
    const response = fakeResponse()
    await collect(buildDeps()).get('POST /auth/logout')!({ url: '/auth/logout', headers: {} }, response, { url: new URL('https://box.ts.net/auth/logout'), body: {} })

    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0')
  })

  it('bumps the epoch when logging out everywhere', async () => {
    const deps = buildDeps()
    const sessionCookie = `openfit_session=${deps.sessions.sign({ sub: '123', email: 'a@example.com', epoch: 1 })}`
    const response = fakeResponse()

    await collect(deps).get('POST /auth/logout')!(
      { url: '/auth/logout', headers: { cookie: sessionCookie } },
      response,
      { url: new URL('https://box.ts.net/auth/logout'), body: { everywhere: true } },
    )

    expect(deps.accounts.bumpEpoch).toHaveBeenCalledWith('123')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/routes/login.test.ts`
Expected: FAIL — `Cannot find module './login.cjs'`

- [ ] **Step 3: Write the login page**

Create `server/login-page.cjs`:

```js
'use strict'

// Server-rendered so an anonymous visitor never downloads the application
// bundle. Sign-in is a link, not a form: the CSP sets `form-action 'none'`
// and link navigation is unaffected by it.
function loginPage(message = '') {
  const notice = message
    ? `<p class="notice">${String(message).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c])}</p>`
    : ''

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenFit</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;color:#edf4f5;background:#080c11;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.card{width:min(380px,calc(100vw - 40px));padding:34px;border:1px solid #ffffff12;border-radius:20px;background:#111820;text-align:center}h1{margin:0 0 8px;font-size:22px}p{margin:0 0 22px;color:#83909b;font-size:13px;line-height:1.55}.notice{color:#ff7b74}a.button{display:block;padding:12px 18px;border-radius:12px;background:#5ae4c0;color:#08121a;font-size:14px;font-weight:600;text-decoration:none}</style></head><body><main class="card"><h1>OpenFit</h1><p>Sign in with the Google account your Fitbit app uses.</p>${notice}<a class="button" href="/auth/login">Sign in with Google</a></main></body></html>`
}

module.exports = { loginPage }
```

- [ ] **Step 4: Write the routes**

Create `server/routes/login.cjs`:

```js
'use strict'

const crypto = require('node:crypto')

const { parseCookies } = require('../auth.cjs')
const { loginPage } = require('../login-page.cjs')

const PENDING_COOKIE = 'openfit_pending'
const PENDING_MAX_AGE_SECONDS = 600

function base64Url(buffer) {
  return buffer.toString('base64url')
}

function sendHtml(response, status, html) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(html)
}

function registerLoginRoutes({ addPublic, deps }) {
  const { sessions, accounts, identity, exchange, authorizationUrl, validateIdToken, onAuthorized } = deps

  const pendingAttributes = (maxAge) => {
    const parts = ['Path=/auth', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
    if (identity.redirectUri.startsWith('https:')) parts.push('Secure')
    return parts
  }

  addPublic('GET', '/auth/login', async (request, response, { url }) => {
    const state = base64Url(crypto.randomBytes(24))
    const nonce = base64Url(crypto.randomBytes(24))
    const verifier = base64Url(crypto.randomBytes(48))
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())

    // The pending values are signed into a short-lived cookie rather than held
    // in memory, so a restart mid-sign-in does not strand the flow.
    const pending = sessions.sign({ state, nonce, verifier })

    response.writeHead(302, {
      location: authorizationUrl({ state, nonce, challenge, prompt: url.searchParams.get('prompt') || undefined }),
      'set-cookie': [`${PENDING_COOKIE}=${pending}`, ...pendingAttributes(PENDING_MAX_AGE_SECONDS)].join('; '),
    })
    response.end()
  })

  addPublic('GET', '/auth/callback', async (request, response, { url }) => {
    const pending = sessions.verify(parseCookies(request.headers?.cookie)[PENDING_COOKIE])
    if (!pending) {
      sendHtml(response, 400, loginPage('Sign-in took too long. Start again.'))
      return
    }

    if (url.searchParams.get('state') !== pending.state) {
      sendHtml(response, 400, loginPage('The sign-in security check failed. Start again.'))
      return
    }

    const oauthError = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (oauthError || !code) {
      sendHtml(response, 400, loginPage(oauthError === 'access_denied' ? 'Access was denied at the Google consent screen.' : 'Sign-in was cancelled.'))
      return
    }

    let account
    let tokens
    try {
      tokens = await exchange(code, pending.verifier)
      const claims = validateIdToken(tokens.id_token, { clientId: identity.clientId, nonce: pending.nonce })
      account = accounts.resolve(claims)
    } catch (error) {
      const unverified = /not verified/i.test(error?.message || '')
      sendHtml(response, unverified ? 403 : 401, loginPage(unverified ? error.message : 'Google sign-in could not be completed.'))
      return
    }

    await onAuthorized(account, tokens)

    response.writeHead(302, {
      location: '/',
      'set-cookie': [
        sessions.cookie({ sub: account.sub, email: account.email, epoch: account.epoch }),
        [`${PENDING_COOKIE}=`, ...pendingAttributes(0)].join('; '),
      ],
    })
    response.end()
  })

  addPublic('POST', '/auth/logout', async (request, response, { body }) => {
    const session = sessions.verify(parseCookies(request.headers?.cookie)[sessions.cookieName])
    if (body?.everywhere && session?.sub) {
      try {
        accounts.bumpEpoch(session.sub)
      } catch {
        // Already gone; clearing the cookie is still correct.
      }
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': sessions.clearCookie() })
    response.end(JSON.stringify({ ok: true }))
  })
}

module.exports = { registerLoginRoutes, PENDING_COOKIE, PENDING_MAX_AGE_SECONDS }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/routes/login.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 6: Commit**

```bash
git add server/login-page.cjs server/routes/login.cjs server/routes/login.test.ts
git commit -m "feat: add Google sign-in routes and login page"
```

---

### Task 7: Wire the guard

**Files:**
- Modify: `server/auth.cjs` (add session support alongside the bearer token)
- Modify: `server/index.cjs:64-150`
- Modify: `server/routes.test.ts`
- Modify: `server/auth.test.ts` (only if a name changed; behaviour must not)

**Interfaces:**
- Consumes: everything from Tasks 1–6
- Produces: `createServer({ app, staticRoot, token, dataDir, sessions, accounts, registry, loginDeps })`
  - `request.account` is set for session-authenticated requests
  - Bearer authorises `/api/*` only

- [ ] **Step 1: Write the failing tests**

Append to `server/routes.test.ts` (the file already provides `stubApp` and `withServer`; extend `withServer` to accept and pass through `sessions`, `accounts`, and `registry`):

```ts
describe('session and bearer guards', () => {
  it('serves the login page to an anonymous visitor instead of 401', async () => {
    const { base } = await withServer(stubApp())
    const response = await fetch(`${base}/`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Sign in with Google')
  })

  it('still returns 401 for anonymous /api requests', async () => {
    const { base } = await withServer(stubApp())
    expect((await fetch(`${base}/api/status`)).status).toBe(401)
  })

  it('accepts a valid session cookie for the app shell and the api', async () => {
    const { base, sessionCookie } = await withServer(stubApp())

    expect((await fetch(`${base}/api/status`, { headers: { cookie: sessionCookie } })).status).toBe(200)
    expect((await fetch(`${base}/`, { headers: { cookie: sessionCookie } })).status).toBe(200)
  })

  it('accepts the bearer token for /api only', async () => {
    const { base } = await withServer(stubApp())
    const headers = { authorization: 'Bearer test-token' }

    expect((await fetch(`${base}/api/status`, { headers })).status).toBe(200)

    const shell = await fetch(`${base}/`, { headers })
    expect(await shell.text()).toContain('Sign in with Google')
  })

  it('rejects a session cookie whose epoch is stale', async () => {
    const { base, staleCookie } = await withServer(stubApp())
    expect((await fetch(`${base}/api/status`, { headers: { cookie: staleCookie } })).status).toBe(401)
  })

  it('returns 409 listing accounts when a bearer request is ambiguous', async () => {
    const { base } = await withServer(stubApp(), { accountCount: 2 })
    const response = await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer test-token' } })

    expect(response.status).toBe(409)
    expect((await response.json()).accounts).toHaveLength(2)
  })

  it('resolves an ambiguous bearer request with X-OpenFit-Account', async () => {
    const { base } = await withServer(stubApp(), { accountCount: 2 })
    const response = await fetch(`${base}/api/status`, {
      headers: { authorization: 'Bearer test-token', 'x-openfit-account': 'a@example.com' },
    })

    expect(response.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/routes.test.ts`
Expected: FAIL — the anonymous `GET /` returns 401 text, not the login page

- [ ] **Step 3: Extend `server/auth.cjs`**

Keep every existing export unchanged and add session awareness. Insert before `module.exports`:

```js
/**
 * Resolves the account for a request.
 *
 * A session names its own account. A bearer token predates multi-account and
 * names none: it resolves to the sole account, and otherwise must say which
 * one. Silently choosing is how an automated caller reads the wrong person's
 * health data.
 */
function resolveAccount({ session, accounts, header }) {
  if (session) {
    const account = accounts.get(session.sub)
    if (!account) return { error: 'Unknown account.', status: 401 }
    if (Number(account.epoch) !== Number(session.epoch)) return { error: 'The session has been revoked.', status: 401 }
    return { account }
  }

  const all = accounts.list()
  if (all.length === 0) return { error: 'No account has signed in yet.', status: 401 }
  if (all.length === 1) return { account: all[0] }

  const wanted = String(header || '').trim().toLowerCase()
  const match = all.find((entry) => entry.email.toLowerCase() === wanted)
  if (match) return { account: match }

  return {
    error: 'This instance has more than one account. Name one with the X-OpenFit-Account header.',
    status: 409,
    accounts: all.map((entry) => entry.email),
  }
}
```

Then extend the exports:

```js
module.exports = { createAuth, sameToken, parseCookies, bearerFrom, resolveAccount, TOKEN_FILE, COOKIE_NAME }
```

- [ ] **Step 4: Rework the guard in `server/index.cjs`**

Replace the block from `const authorized = auth.isAuthorized(request)` (line 84) through the `if (!authorized)` static branch (line 137) with:

```js
    const session = sessions.verify(parseCookies(request.headers?.cookie)[sessions.cookieName])
    const bearerOk = auth.isAuthorized(request)
    const authorized = Boolean(session) || bearerOk

    if (route) {
      if (!authorized) {
        sendJson(response, 401, { error: 'Sign in to use OpenFit.' })
        return
      }

      const resolved = resolveAccount({
        session,
        accounts,
        header: request.headers['x-openfit-account'],
      })
      if (resolved.error) {
        sendJson(response, resolved.status, { error: resolved.error, accounts: resolved.accounts })
        return
      }

      try {
        const body = request.method === 'POST' ? await readJsonBody(request) : {}
        const isLoopback = LOOPBACK.has(request.socket.remoteAddress)
        const accountApp = registry.forAccount(resolved.account)
        const result = await route.handle(request, response, { body, url, isLoopback, app: accountApp, account: resolved.account })
        if (!response.headersSent && !response.writableEnded) sendJson(response, 200, result ?? null)
      } catch (error) {
        if (response.headersSent) {
          response.end()
          return
        }
        const status = Number(error?.status) || 400
        sendJson(response, status, { error: error instanceof Error ? error.message : 'Request failed.' })
      }
      return
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(response, authorized ? 404 : 401, { error: authorized ? 'Not found.' : 'Unauthorized.' })
      return
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Method not allowed.' })
      return
    }

    // The bearer token is for /api only; a browser holding one still signs in.
    if (!session) {
      securityHeaders(response)
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(loginPage())
      return
    }
```

Delete the `?token=` cookie-exchange branch (lines 118-125) — tokenized browser URLs no longer exist.

Register the login routes next to the OAuth ones and dispose through the registry:

```js
  registerLoginRoutes({ addPublic, deps: loginDeps })
```

```js
  server.on('close', () => { void registry.disposeAll() })
```

Add the imports at the top of the file:

```js
const { createAuth, parseCookies, resolveAccount } = require('./auth.cjs')
const { loginPage } = require('./login-page.cjs')
const { registerLoginRoutes } = require('./routes/login.cjs')
```

Route handlers registered through `add` currently close over the single `app`. Change `healthRoutes.register`, `assistantRoutes.register`, and `eventRoutes.register` to take the app from the handler context instead — for example in `server/routes/health.cjs`:

```js
  add('GET', '/api/status', (request, response, { app }) => app.getStatus())
```

Apply the same change to every route in `server/routes/health.cjs`, `server/routes/assistant.cjs`, and `server/routes/events.cjs`, and drop `app` from their `register` signatures.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. `server/auth.test.ts` must pass **unchanged** — bearer behaviour was preserved, and any edit needed there means the token path was altered by accident.

- [ ] **Step 6: Commit**

```bash
git add server/auth.cjs server/index.cjs server/routes/ server/routes.test.ts
git commit -m "feat: accept a Google session or a bearer token per request"
```

---

### Task 8: Retire in-app OAuth configuration

**Files:**
- Modify: `core/app.cjs:145-165`
- Modify: `server/routes/health.cjs:6`
- Modify: `core/credentials.cjs` (default the config from `.env`)
- Modify: `server/routes.test.ts`

**Interfaces:**
- Consumes: `loadEnv` (Task 1)
- Produces: `app.connect()` returns `{ reauthorizeUrl: '/auth/login?prompt=consent' }`; `app.saveConfig` no longer exists

- [ ] **Step 1: Write the failing test**

Append to `server/routes.test.ts`:

```ts
describe('retired configuration surface', () => {
  it('no longer exposes POST /api/config', async () => {
    const { base, sessionCookie } = await withServer(stubApp())
    const response = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(404)
  })

  it('returns a reauthorize url from /api/connect rather than a redirect', async () => {
    const app = stubApp({ connect: vi.fn(async () => ({ reauthorizeUrl: '/auth/login?prompt=consent' })) })
    const { base, sessionCookie } = await withServer(app)

    const response = await fetch(`${base}/api/connect`, { method: 'POST', headers: { cookie: sessionCookie } })

    expect(response.status).toBe(200)
    expect((await response.json()).reauthorizeUrl).toBe('/auth/login?prompt=consent')
  })

  it('keeps the session alive after disconnecting the health account', async () => {
    const { base, sessionCookie } = await withServer(stubApp())

    const disconnected = await fetch(`${base}/api/disconnect`, { method: 'POST', headers: { cookie: sessionCookie } })
    expect(disconnected.status).toBe(200)

    // Signing out of Google Health must not sign you out of OpenFit.
    expect((await fetch(`${base}/api/status`, { headers: { cookie: sessionCookie } })).status).toBe(200)
  })
})
```

Add a status test in `core/app.test.ts` (create it if absent):

```ts
it('advertises how to reauthorize while disconnected', () => {
  // A refresh token expires after 7 days in testing mode, so "signed in but
  // disconnected" is the normal steady state and must be actionable.
  const status = app.getStatus()
  expect(status.connected).toBe(false)
  expect(status.reauthorizeUrl).toBe('/auth/login?prompt=consent')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/routes.test.ts`
Expected: FAIL — `/api/config` still returns 200

- [ ] **Step 3: Remove the config route**

Delete line 6 of `server/routes/health.cjs`:

```js
  add('POST', '/api/config', async (request, response, { body }) => app.saveConfig(body))
```

- [ ] **Step 4: Replace `saveConfig` and `connect` in `core/app.cjs`**

Delete the whole `saveConfig` method (lines 145-158) and replace `connect` (lines 160-163) with:

```js
    // The renderer calls this with fetch, which would follow a 302 and load
    // Google's consent page as an XHR. Return the URL and let the browser
    // navigate.
    connect() {
      if (syncInFlight) throw new Error('Wait for the sync to finish before reconnecting the account.')
      return { reauthorizeUrl: REAUTHORIZE_URL }
    },
```

Define the constant near the top of `core/app.cjs`, beside `REQUEST_ID`:

```js
const REAUTHORIZE_URL = '/auth/login?prompt=consent'
```

Then extend `getStatus` (line 143) so a disconnected session is actionable rather than a dead end:

```js
    getStatus: () => ({
      ...credentials.publicStatus(),
      assistant: agents.getStatus(),
      reauthorizeUrl: REAUTHORIZE_URL,
    }),
```

- [ ] **Step 5: Default the credential config from the environment**

In `core/credentials.cjs`, replace `emptyCredentials` so the OAuth identity comes from the injected environment rather than the UI:

```js
function emptyCredentials(defaults = {}) {
  return {
    config: {
      provider: DEFAULT_PROVIDER,
      clientId: defaults.clientId || '',
      clientSecret: defaults.clientSecret || '',
      redirectUri: defaults.redirectUri || DEFAULT_REDIRECT_URI,
      agentId: null,
    },
    token: null,
    lastSyncAt: null,
  }
}
```

Thread a `defaults` option through `createCredentialStore({ secrets, credentialFile, cacheFile, publicOrigin, defaults })` and pass it wherever `emptyCredentials()` is called. In `core/app.cjs`, pass it from the new `oauthDefaults` option:

```js
  const credentials = createCredentialStore({
    secrets,
    credentialFile: path.join(dataDir, 'credentials.secure.json'),
    cacheFile: path.join(dataDir, 'health-cache.secure.json'),
    publicOrigin,
    defaults: options.oauthDefaults || {},
  })
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. Tests asserting `saveConfig` must be deleted, not adapted — the capability is gone.

- [ ] **Step 7: Commit**

```bash
git add core/app.cjs core/credentials.cjs server/routes/health.cjs server/routes.test.ts
git commit -m "feat: take the OAuth client from the environment and retire /api/config"
```

---

### Task 9: Compose it in the entry point

**Files:**
- Modify: `server/bin.cjs:60-130`

**Interfaces:**
- Consumes: every module from Tasks 1–8
- Produces: a server that signs users in; the banner no longer prints a tokenized browser URL

- [ ] **Step 1: Update the banner**

Replace the `banner` function's URL and OAuth lines:

```js
function banner({ addresses, port, dataDir, storageBackend, agents, publicOrigin }) {
  const lines = [
    '',
    '  OpenFit server',
    `  data     ${dataDir}`,
    `  storage  ${storageBackend}`,
    `  agents   ${agents.map((agent) => `${agent.id}${agent.selected ? '*' : ''}${agent.available ? '' : ' (unavailable)'}`).join(', ') || 'none'}`,
    '',
    '  Open one of these and sign in with Google:',
    ...addresses.map((address) => `    http://${address}:${port}/`),
  ]
  if (publicOrigin) lines.push('', `  OAuth callback: ${publicOrigin}/auth/callback`)
  else lines.push('', '  Set OPENFIT_PUBLIC_ORIGIN=https://<host>.ts.net to sign in from other devices.')
  lines.push('')
  return lines.join('\n')
}
```

- [ ] **Step 2: Compose the registry in `main`**

Replace the single `createApp` block (lines 93-99) with:

```js
  let env_
  try {
    env_ = loadEnv({ env })
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }

  const publicOrigin = env_.publicOrigin
  const redirectUri = `${publicOrigin || `http://127.0.0.1:${port}`}/auth/callback`

  const secrets = createSecretStore({ dir: dataDir })
  const accounts = createAccounts({ dataDir, secrets })
  const registry = createAccountRegistry({
    dataDir,
    secrets,
    createApp,
    appOptions: {
      env,
      clientVersion: require('../package.json').version,
      publicOrigin,
      oauthDefaults: { clientId: env_.clientId, clientSecret: env_.clientSecret, redirectUri },
    },
  })
```

- [ ] **Step 3: Pass the new collaborators to `createServer`**

```js
  const sessions = createSessions({ masterKey: secrets.masterKey(), secure: Boolean(publicOrigin) })

  const { server } = createServer({
    app: null,
    staticRoot,
    dataDir,
    token: tokenOverride,
    sessions,
    accounts,
    registry,
    loginDeps: {
      sessions,
      accounts,
      identity: { clientId: env_.clientId, clientSecret: env_.clientSecret, redirectUri },
      validateIdToken,
      authorizationUrl: ({ state, nonce, challenge, prompt }) => buildGoogleAuthUrl({
        clientId: env_.clientId, redirectUri, state, nonce, challenge, prompt,
      }),
      exchange: (code, verifier) => exchangeGoogleCode({
        clientId: env_.clientId, clientSecret: env_.clientSecret, redirectUri, code, verifier,
      }),
      onAuthorized: async (account, tokens) => {
        const accountApp = registry.forAccount(account)
        await accountApp.adoptToken(tokens)
      },
    },
  })
```

`createSecretStore` must expose the key for `createSessions`. Add to its returned object in `core/secrets.cjs`:

```js
    masterKey: () => key(),
```

`buildGoogleAuthUrl` and `exchangeGoogleCode` are thin wrappers over the existing provider functions; add them to `core/providers/google-health.cjs` exports, reusing `AUTHORIZE_URL`, `TOKEN_URL`, `SCOPES`, and `tokenRequest`, and adding `nonce` to the authorization parameters.

`adoptToken` is a new method on the app that stores the exchanged token without going through the retired config path. Add it to `core/app.cjs` beside `disconnect`:

```js
    async adoptToken(token) {
      const stored = credentials.read()
      credentials.save({ ...stored, token, lastSyncAt: null })
      credentials.clearCache()
      return credentials.publicStatus()
    },
```

- [ ] **Step 4: Fix the banner call site**

The `server.listen` callback references `app`, which no longer exists at that scope. Report against the first account when one exists, and fall back to a bare banner otherwise:

```js
  server.listen(port, host, () => {
    const first = accounts.list()[0]
    const scoped = first ? registry.forAccount(first) : null
    console.log(banner({
      addresses: reachableAddresses(host),
      port,
      publicOrigin,
      dataDir,
      storageBackend: scoped ? scoped.getStatus().storageBackend : secrets.describe().backend,
      agents: scoped ? scoped.assistant.listAgents() : [],
    }))
  })
```

- [ ] **Step 5: Run the full suite and start the server**

Run: `npm test`
Expected: PASS

Run: `OPENFIT_GOOGLE_CLIENT_ID=x OPENFIT_GOOGLE_CLIENT_SECRET=y node server/bin.cjs --dev --host 127.0.0.1 --port 7799`
Expected: the banner prints without a token, and `curl -s localhost:7799/ | grep -c "Sign in with Google"` returns `1`. Stop it with Ctrl-C.

Run: `node server/bin.cjs --dev --port 7799`
Expected: exits non-zero printing `OPENFIT_GOOGLE_CLIENT_ID is not set.`

- [ ] **Step 6: Commit**

```bash
git add server/bin.cjs core/secrets.cjs core/app.cjs core/providers/google-health.cjs
git commit -m "feat: sign in with Google from the server entry point"
```

---

### Task 10: Renderer and documentation

**Files:**
- Modify: `src/App.tsx` (remove the credential form, add sign-out and reconnect)
- Modify: `docs/SELF_HOSTING.md`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Find the settings surface**

Run: `grep -rn "saveConfig\|clientSecret\|redirectUri" src/`
Expected: the connection dialog and its types. Every call site must go — the endpoint returns 404 now.

- [ ] **Step 2: Replace the connect action**

Wherever the renderer called `saveConfig` then `connect`, call `connect` alone and navigate:

```tsx
const response = await fetch('/api/connect', { method: 'POST' })
const { reauthorizeUrl } = await response.json()
window.location.href = reauthorizeUrl
```

Add a sign-out control:

```tsx
await fetch('/auth/logout', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ everywhere: false }),
})
window.location.href = '/'
```

- [ ] **Step 3: Run the type check and build**

Run: `npm run typecheck && npm run build`
Expected: PASS with no reference to removed fields

- [ ] **Step 4: Update the documentation**

In `docs/SELF_HOSTING.md`:
- Replace the banner sample with the tokenless one from Task 9
- Retitle *Access control* to cover Google sign-in, keeping the bearer token described as `/api/*` only
- Replace *Connecting a health account* with sign-in, noting one consent grants identity and health scopes
- Add `.env` to the options table and to the systemd unit as `EnvironmentFile=/home/you/code/openfit/.env`
- Add to the troubleshooting table: *"Health disconnected after about a week — Google expires refresh tokens for apps in testing after 7 days. Sign in again."*

In `README.md`, step 5: the authorized redirect URI is now `<origin>/auth/callback`. Delete the *Connect OpenFit* steps that describe pasting a Client ID and Secret.

In `docs/ARCHITECTURE.md`, document the account registry and the session boundary.

- [ ] **Step 5: Verify the docs match reality**

Run: `grep -rn "42813\|/api/config\|token=" docs/SELF_HOSTING.md README.md`
Expected: no hits describing the retired flow. The loopback port may still appear in legacy-provider context; anything describing OpenFit's own callback must be gone.

- [ ] **Step 6: Full verification**

Run: `npm run check`
Expected: PASS — typecheck, node syntax check, tests, and build

- [ ] **Step 7: Commit**

```bash
git add src/ docs/ README.md
git commit -m "docs: describe Google sign-in and drop the credential form"
```

---

## Manual verification

Automated tests never reach Google. Verify the live integration once:

1. Add `<origin>/auth/callback` as a redirect URI on the existing OAuth client.
2. Write `.env` with the client ID and secret.
3. `npm run serve`, then open the origin in a browser.
4. Confirm the login page appears, sign in, and confirm the redirect lands on the dashboard.
5. Confirm `accounts/<hash>/` was created with mode `0700`.
6. Confirm `curl -H "Authorization: Bearer $(cat <data-dir>/server-token)" <origin>/api/status` still returns 200.
