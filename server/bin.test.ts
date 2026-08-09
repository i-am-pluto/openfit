import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const bin = require('./bin.cjs') as {
  main: (argv: string[], env: Record<string, string>) => { server: any; registry: any; accounts: any; sessions: any }
  banner: (options: Record<string, any>) => string
}
const { accountId } = require('../core/accounts.cjs') as { accountId: (sub: string) => string }
const { createSecretStore } = require('../core/secrets.cjs') as { createSecretStore: (o: any) => any }

const BIN = require.resolve('./bin.cjs')
const ENV_FILE = path.resolve(BIN, '..', '..', '.env')

// A developer's own .env is loaded from an absolute path, so it would satisfy
// the variable the "missing configuration" case is about.
const envFileConfigures = (name: string) => {
  try {
    return new RegExp(`^\\s*${name}\\s*=\\s*\\S`, 'm').test(fs.readFileSync(ENV_FILE, 'utf8'))
  } catch {
    return false
  }
}

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-bin-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Bind, read the port, release it. A fixed port would collide with whatever the
// machine running the suite happens to have open.
async function freePort() {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as net.AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** Runs the real entry point in this process and tears it down afterwards. */
async function start(extraEnv: Record<string, string> = {}) {
  const dataDir = path.join(tempDir(), 'data')
  const port = await freePort()
  const logs: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { logs.push(parts.join(' ')) })

  // Signal handlers are process-wide; only the ones this call added are removed.
  const before = {
    SIGINT: new Set(process.listeners('SIGINT')),
    SIGTERM: new Set(process.listeners('SIGTERM')),
  }

  const started = bin.main(['--dev', '--host', '127.0.0.1', '--port', String(port), '--data-dir', dataDir], {
    OPENFIT_GOOGLE_CLIENT_ID: 'test-client',
    OPENFIT_GOOGLE_CLIENT_SECRET: 'test-secret',
    ...extraEnv,
  })

  cleanups.push(async () => {
    await new Promise((resolve) => started.server.close(resolve))
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].has(listener)) process.removeListener(signal, listener)
      }
    }
  })

  await once(started.server, 'listening')
  return { ...started, port, dataDir, logs, origin: `http://127.0.0.1:${port}` }
}

/**
 * Answers Google's token endpoint and lets every other request through.
 *
 * The server under test runs in this process, so a blanket `fetch` stub would
 * also swallow the requests this file makes to drive it. Only the token URL is
 * intercepted; nothing here reaches the network.
 */
function stubGoogleTokenEndpoint(payload: Record<string, unknown>) {
  const realFetch = globalThis.fetch
  const bodies: URLSearchParams[] = []
  vi.stubGlobal('fetch', async (input: any, init: any = {}) => {
    if (!String(input).startsWith('https://oauth2.googleapis.com/token')) return realFetch(input, init)
    bodies.push(new URLSearchParams(String(init.body)))
    return { ok: true, json: async () => payload }
  })
  cleanups.push(() => vi.unstubAllGlobals())
  return bodies
}

// Unsigned on purpose: core/identity.cjs documents why it validates claims
// without verifying the signature for a token taken straight from the token
// endpoint over TLS. This is the payload Google would have returned.
function idToken(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.signature`
}

// getSetCookie keeps the headers separate; the joined form would have to be
// re-split on commas that also appear inside cookie attributes.
const cookieValue = (response: Response, name: string) =>
  response.headers.getSetCookie().map((entry) => entry.split(';')[0]).find((pair) => pair.startsWith(`${name}=`)) ?? ''

/**
 * Drives a whole Google sign-in against the composed server and hands back the
 * cookie the callback issued.
 *
 * Nothing used that cookie before: this file matched its prefix and stopped, so
 * the `epoch` claim it carries was unpinned — deleting it shipped green while
 * signing every user out the instant they signed in.
 */
async function signIn(origin: string, { sub, email }: { sub: string; email: string }) {
  const login = await fetch(`${origin}/auth/login`, { redirect: 'manual' })
  const authorize = new URL(String(login.headers.get('location')))
  const pending = cookieValue(login, 'openfit_pending')

  stubGoogleTokenEndpoint({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    id_token: idToken({
      iss: 'https://accounts.google.com',
      aud: 'test-client',
      nonce: authorize.searchParams.get('nonce'),
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub,
      email,
      email_verified: true,
    }),
  })

  const callback = await fetch(
    `${origin}/auth/callback?code=auth-code&state=${authorize.searchParams.get('state')}`,
    { redirect: 'manual', headers: { cookie: pending } },
  )
  return { callback, cookie: cookieValue(callback, 'openfit_session') }
}

describe('server entry point', () => {
  it('serves the login page to an anonymous visitor', async () => {
    const { origin } = await start()

    const response = await fetch(`${origin}/`)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Sign in with Google')
  })

  it('starts the Google flow with the configured client and a nonce', async () => {
    // Everything below comes from the composition: the client id from .env, the
    // redirect URI from the origin, and the nonce core/identity.cjs demands.
    const { origin, port } = await start()

    const response = await fetch(`${origin}/auth/login`, { redirect: 'manual' })
    const location = new URL(String(response.headers.get('location')))

    expect(response.status).toBe(302)
    expect(location.origin).toBe('https://accounts.google.com')
    expect(location.searchParams.get('client_id')).toBe('test-client')
    expect(location.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/auth/callback`)
    expect(location.searchParams.get('nonce')).toBeTruthy()
    expect(location.searchParams.get('state')).toBeTruthy()
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.search).not.toContain('test-secret')
    expect(String(response.headers.get('set-cookie'))).toContain('openfit_pending=')
  })

  it('hands every account app the OAuth client from the environment', async () => {
    // loadEnv has no other production caller. Miss this wiring and .env is
    // ignored in silence: sign-in works and the first token refresh does not.
    const { registry, dataDir, port } = await start()
    const dir = path.join(dataDir, 'accounts', 'a'.repeat(16))
    fs.mkdirSync(dir, { recursive: true })

    const status = registry.forAccount({ id: 'a'.repeat(16), dir }).getStatus()

    expect(status.clientId).toBe('test-client')
    expect(status.redirectUri).toBe(`http://127.0.0.1:${port}/auth/callback`)
    expect(status.hasClientSecret).toBe(true)
  })

  it('stores the exchanged token against the account the callback signed in', async () => {
    // The one composition edge nothing else reaches: server/routes/login.test.ts
    // injects its own onAuthorized, and every other test here stops at the
    // redirect to Google. Break the `onAuthorized` wire in server/bin.cjs and
    // this is the test that goes red.
    const { origin, dataDir, registry } = await start()
    const sub = 'google-sub-1'
    const id = accountId(sub)
    const dir = path.join(dataDir, 'accounts', id)

    // The registry caches by account id, so the app the callback reaches is this
    // one; listening now is the only way to see the event it emits.
    const announced: unknown[] = []
    registry.forAccount({ id, dir }).events.on('auth-complete', (payload: unknown) => announced.push(payload))

    const login = await fetch(`${origin}/auth/login`, { redirect: 'manual' })
    const authorize = new URL(String(login.headers.get('location')))
    const pending = cookieValue(login, 'openfit_pending')

    const exchanges = stubGoogleTokenEndpoint({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      id_token: idToken({
        iss: 'https://accounts.google.com',
        aud: 'test-client',
        nonce: authorize.searchParams.get('nonce'),
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub,
        email: 'ada@example.com',
        email_verified: true,
      }),
    })

    const callback = await fetch(
      `${origin}/auth/callback?code=auth-code&state=${authorize.searchParams.get('state')}`,
      { redirect: 'manual', headers: { cookie: pending } },
    )

    // A session at all means the whole chain ran: login.cjs:154 catches a
    // failing onAuthorized and answers 500 without issuing one.
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/')
    expect(cookieValue(callback, 'openfit_session')).toMatch(/^openfit_session=v1\./)

    // The code and verifier reached Google's token endpoint.
    expect(Object.fromEntries(exchanges[0])).toMatchObject({
      code: 'auth-code',
      grant_type: 'authorization_code',
      client_id: 'test-client',
      client_secret: 'test-secret',
    })
    expect(exchanges[0].get('code_verifier')).toBeTruthy()

    // And the token was stored, encrypted, in this account's own directory.
    const file = path.join(dir, 'credentials.secure.json')
    expect(fs.existsSync(file)).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).encrypted).toBe(true)
    const stored = createSecretStore({ dir: dataDir }).read(file, null)
    expect(stored.token).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1' })
    expect(stored.token).not.toHaveProperty('id_token')

    // Requirement 9: the renderer's live update has a publisher again.
    expect(announced).toEqual([{ ok: true }])
  })

  it('issues a session cookie that authenticates the very next request', async () => {
    const { origin } = await start()
    const { callback, cookie } = await signIn(origin, { sub: 'google-sub-1', email: 'ada@example.com' })

    expect(callback.status).toBe(302)
    expect(cookie).toMatch(/^openfit_session=v1\./)

    // Every claim in that cookie has to be right for this to be a 200: `sub`
    // names the account, and `epoch` has to match the stored one, which is what
    // makes revocation mean anything.
    const status = await fetch(`${origin}/api/status`, { headers: { cookie } })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ hasBackend: true })
  })

  it('stops a second, independently issued cookie after a sign-out everywhere', async () => {
    const { origin } = await start()
    const identity = { sub: 'google-sub-1', email: 'ada@example.com' }
    const first = await signIn(origin, identity)

    // A whole second, so the two cookies differ in their signed `iat` and the
    // one being revoked is provably not the one used to sign out. Anything less
    // and both callbacks could mint the same bytes.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const second = await signIn(origin, identity)

    expect(second.cookie).not.toBe(first.cookie)
    expect((await fetch(`${origin}/api/status`, { headers: { cookie: second.cookie } })).status).toBe(200)

    const loggedOut = await fetch(`${origin}/auth/logout`, {
      method: 'POST',
      headers: { cookie: first.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ everywhere: true }),
    })
    expect(await loggedOut.json()).toEqual({ ok: true, revoked: true })

    // The only end-to-end proof that "log out everywhere" reaches a session it
    // was not sent from: server/routes.test.ts stubs bumpEpoch, and nothing else
    // watches a real cookie stop working.
    const after = await fetch(`${origin}/api/status`, { headers: { cookie: second.cookie } })
    expect(after.status).toBe(401)
    expect((await after.json()).error).toBe('The session has been revoked.')
  })

  it('signs its session cookies with the instance master key', async () => {
    const { sessions, dataDir } = await start()

    // Derived from master.key, so the cookie survives a restart of this server
    // and nothing else can mint one.
    expect(fs.existsSync(path.join(dataDir, 'master.key'))).toBe(true)
    expect(sessions.verify(sessions.sign({ sub: 'x', epoch: 1 }))).toMatchObject({ sub: 'x', epoch: 1 })
  })

  it('prints no token in the banner', async () => {
    const { logs, port } = await start()
    const printed = logs.join('\n')

    // Browser access is a Google sign-in now. A tokenised URL in a log or a
    // terminal scrollback was a standing credential leak.
    expect(printed).not.toContain('token=')
    expect(printed).toContain(`http://127.0.0.1:${port}/`)
    expect(printed).toContain('sign in with Google')
  })

  it('marks its cookies Secure exactly when a public origin is configured', async () => {
    // registerLoginRoutes refuses to wire up if the session store and the login
    // routes disagree, so reaching a redirect at all is half the assertion.
    const { origin } = await start({ OPENFIT_PUBLIC_ORIGIN: 'https://box.ts.net' })

    const response = await fetch(`${origin}/auth/login`, { redirect: 'manual' })
    const location = new URL(String(response.headers.get('location')))

    expect(String(response.headers.get('set-cookie'))).toContain('Secure')
    expect(location.searchParams.get('redirect_uri')).toBe('https://box.ts.net/auth/callback')
  })
})

describe('server entry point misconfiguration', () => {
  const run = (env: Record<string, string>) => {
    const dataDir = path.join(tempDir(), 'never-created')
    const result = spawnSync(process.execPath, [BIN, '--dev', '--port', '7799', '--data-dir', dataDir], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 20_000,
    })
    return { ...result, dataDir }
  }

  it.skipIf(envFileConfigures('OPENFIT_GOOGLE_CLIENT_ID'))('exits naming the missing variable', () => {
    const result = run({})

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('OPENFIT_GOOGLE_CLIENT_ID is not set.')
    // Nothing is created before the configuration is known good: a server that
    // cannot sign anyone in must not leave a data directory or a master key.
    expect(fs.existsSync(result.dataDir)).toBe(false)
  })

  it.skipIf(envFileConfigures('OPENFIT_GOOGLE_CLIENT_SECRET'))('exits naming a missing secret', () => {
    const result = run({ OPENFIT_GOOGLE_CLIENT_ID: 'test-client' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('OPENFIT_GOOGLE_CLIENT_SECRET is not set.')
  })

  it('refuses a public origin that cookies marked Secure would never reach', () => {
    const result = run({
      OPENFIT_GOOGLE_CLIENT_ID: 'test-client',
      OPENFIT_GOOGLE_CLIENT_SECRET: 'test-secret',
      OPENFIT_PUBLIC_ORIGIN: 'http://box.ts.net',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('OPENFIT_PUBLIC_ORIGIN must be a plain https origin')
  })
})
