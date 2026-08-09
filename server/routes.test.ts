import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createServer } = require('./index.cjs') as {
  createServer: (options: Record<string, any>) => { server: any; token: string }
}
const { createSessions } = require('./session.cjs') as { createSessions: (options: any) => any }
const { createUserProfileStore } = require('../core/user-profile.cjs') as {
  createUserProfileStore: (options: any) => any
}
const { createPreferencesStore } = require('../core/preferences.cjs') as {
  createPreferencesStore: (options: any) => any
}

const MASTER_KEY = Buffer.alloc(32, 11)
const LETTERS = ['a', 'b', 'c', 'd']

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

// The profile stub is the real store over an in-memory secrets object rather
// than a bare mock: the round-trip test is only meaningful if a GET after a POST
// reads back through the same validation the server actually runs.
function memoryProfileStore() {
  const files = new Map<string, any>()
  return createUserProfileStore({
    secrets: {
      read: (file: string, fallback: any) => (files.has(file) ? files.get(file) : fallback),
      write: (file: string, value: any) => { files.set(file, value) },
      remove: (file: string) => { files.delete(file) },
      describe: () => ({ encrypted: true, backend: 'test' }),
    },
    profileFile: '/mock/user-profile.secure.json',
  })
}

// Same reasoning as the profile stub: the real store over in-memory secrets, so
// a POST of a hostile chart id is rejected by the code the server actually runs.
function memoryPreferencesStore() {
  const files = new Map<string, any>()
  return createPreferencesStore({
    secrets: {
      read: (file: string, fallback: any) => (files.has(file) ? files.get(file) : fallback),
      write: (file: string, value: any) => { files.set(file, value) },
      remove: (file: string) => { files.delete(file) },
      describe: () => ({ encrypted: true, backend: 'test' }),
    },
    preferencesFile: '/mock/preferences.secure.json',
  })
}

function stubApp(overrides: Record<string, any> = {}) {
  const events = new EventEmitter()
  const profile = memoryProfileStore()
  const preferences = memoryPreferencesStore()
  return {
    events,
    dataDir: '/mock',
    getStatus: vi.fn(() => ({ hasBackend: true, configured: false, provider: 'google-health' })),
    connect: vi.fn(async () => ({ reauthorizeUrl: '/auth/login?prompt=consent' })),
    disconnect: vi.fn(async () => ({ hasBackend: true, connected: false })),
    sync: vi.fn(async () => ({ date: '2026-08-09' })),
    getCachedData: vi.fn(() => null),
    getCachedArchive: vi.fn(() => ({ version: 2, lastDate: null, days: {} })),
    exportArchive: vi.fn(() => ({ filename: 'openfit-archive-2026-08-09.json', json: '{"days":{}}' })),
    getProfile: vi.fn(() => profile.read()),
    saveProfile: vi.fn((patch: any) => profile.save(patch, { source: 'user' })),
    getPreferences: vi.fn(() => preferences.read()),
    savePreferences: vi.fn((patch: any) => preferences.save(patch)),
    assistant: {
      listAgents: vi.fn(() => [{ id: 'codex', label: 'Codex', available: true, selected: true }]),
      getStatus: vi.fn(() => ({ id: 'codex', label: 'Codex', available: true, authenticated: true })),
      selectAgent: vi.fn((id: string) => ({ status: { id }, agents: [] })),
      startTurn: vi.fn((input: any) => ({ requestId: input.requestId })),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
    },
    dispose: vi.fn(async () => {}),
    ...overrides,
  }
}

// Every stub account carries epoch 2 so a stale cookie can name epoch 1 and
// still be a value the accounts module would consider valid.
function makeAccount(index: number, email?: string) {
  const letter = LETTERS[index] ?? `x${index}`
  return {
    id: `acc-${letter}`,
    sub: `sub-${letter}`,
    email: email ?? `${letter}@example.com`,
    epoch: 2,
    dir: `/data/accounts/acc-${letter}`,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

type ServerOptions = {
  accountCount?: number
  emails?: Array<string>
  apps?: Record<string, any>
  getThrows?: boolean
  heartbeatMs?: number
}

function stubAccounts(options: ServerOptions) {
  const all = options.emails
    ? options.emails.map((email, index) => makeAccount(index, email))
    : Array.from({ length: options.accountCount ?? 1 }, (_unused, index) => makeAccount(index))

  return {
    all,
    // Faithful to core/accounts.cjs: `null` means "no such account" and nothing
    // else. A non-string subject or an unreadable record throws.
    get: vi.fn((sub: string) => {
      if (typeof sub !== 'string' || sub === '') throw new Error('An account subject must be a non-empty string.')
      if (options.getThrows) throw new Error('The account record at /data/accounts/acc-a/account.json cannot be read.')
      return all.find((account) => account.sub === sub) ?? null
    }),
    list: vi.fn(() => all),
    // Faithful again: a bump moves the stored epoch, so a later get() reports
    // the new one and cookies carrying the old one stop verifying. A stub that
    // returned a number without moving anything could not show revocation
    // reaching a session it did not issue.
    bumpEpoch: vi.fn((sub: string) => {
      const account = all.find((entry) => entry.sub === sub)
      if (!account) throw new Error('Unknown account.')
      account.epoch += 1
      return account.epoch
    }),
    resolve: vi.fn(),
  }
}

function stubRegistry(fallback: any, byId: Record<string, any> = {}) {
  return {
    forAccount: vi.fn((account: any) => byId[account.id] ?? fallback),
    disposeAll: vi.fn(async () => {}),
  }
}

async function withServer(app: any, options: ServerOptions = {}) {
  const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-dist-'))
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html>SHELL')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-data-'))

  const sessions = createSessions({ masterKey: MASTER_KEY, secure: false })
  const accounts = stubAccounts(options)
  const registry = stubRegistry(app, options.apps)
  const loginDeps = {
    sessions,
    accounts,
    secure: false,
    identity: { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'http://127.0.0.1/auth/callback' },
    exchange: vi.fn(async () => ({ id_token: 'stub' })),
    authorizationUrl: vi.fn(({ state }: any) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
    validateIdToken: vi.fn(() => ({ sub: 'sub-a', email: 'a@example.com' })),
    onAuthorized: vi.fn(async () => {}),
  }

  const { server, token } = createServer({
    staticRoot, dataDir, token: 'test-token', sessions, accounts, registry, loginDeps,
    heartbeatMs: options.heartbeatMs,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  cleanups.push(() => {
    server.close()
    fs.rmSync(staticRoot, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const cookieFor = (account: any, epoch = account.epoch) =>
    `openfit_session=${sessions.sign({ sub: account.sub, email: account.email, epoch })}`

  // Built from account zero whether or not the stub store holds it, so a
  // session naming a deleted account is expressible.
  const first = accounts.all[0] ?? makeAccount(0)
  const sessionCookie = cookieFor(first)
  const staleCookie = cookieFor(first, first.epoch - 1)

  const call = (pathname: string, init: RequestInit = {}) => fetch(base + pathname, {
    ...init,
    headers: { cookie: sessionCookie, 'content-type': 'application/json', ...(init.headers || {}) },
  })

  return { base, token, call, sessions, accounts, registry, sessionCookie, staleCookie, cookieFor }
}

describe('server routes', () => {
  it('gates every API route behind an identity', async () => {
    const { base } = await withServer(stubApp())

    for (const pathname of ['/api/status', '/api/cached-data', '/api/assistant/agents', '/api/events']) {
      expect((await fetch(base + pathname)).status).toBe(401)
    }
    expect((await fetch(base + '/api/status', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
  })

  it('serves status and sync through the core app', async () => {
    const app = stubApp()
    const { call } = await withServer(app)

    expect(await (await call('/api/status')).json()).toMatchObject({ hasBackend: true })

    await call('/api/sync', { method: 'POST', body: JSON.stringify({ date: '2026-08-09' }) })
    expect(app.sync).toHaveBeenCalledWith('2026-08-09')
  })

  it('reports a core error as a 400 with its message', async () => {
    const app = stubApp({
      sync: vi.fn(async () => { throw new Error('A sync is already in progress.') }),
    })
    const { call } = await withServer(app)

    const response = await call('/api/sync', { method: 'POST', body: JSON.stringify({ date: '2026-08-09' }) })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'A sync is already in progress.' })
  })

  it('calls connect with nothing: there is no per-caller reconnect variant left', async () => {
    const app = stubApp()
    const { call } = await withServer(app)

    await call('/api/connect', { method: 'POST', body: '{}' })
    expect(app.connect).toHaveBeenCalledWith()
  })

  it('serves the archive as a download', async () => {
    const { call } = await withServer(stubApp())
    const response = await call('/api/export')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="openfit-archive-2026-08-09.json"')
    expect(await response.text()).toBe('{"days":{}}')
  })

  it('round-trips the user profile', async () => {
    const { call } = await withServer(stubApp())

    const saved = await (await call('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ birthYear: 1990, heightCm: 178 }),
    })).json()
    expect(saved).toMatchObject({ birthYear: 1990, heightCm: 178 })

    expect(await (await call('/api/profile')).json()).toMatchObject({ birthYear: 1990, heightCm: 178 })
  })

  it('rejects a non-object profile body', async () => {
    const app = stubApp()
    const { call } = await withServer(app)

    const response = await call('/api/profile', { method: 'POST', body: JSON.stringify(['not', 'an', 'object']) })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'The profile update must be an object.' })
    expect(app.saveProfile).not.toHaveBeenCalled()
  })

  it('returns an all-null profile before anything is saved', async () => {
    const { call } = await withServer(stubApp())

    expect(await (await call('/api/profile')).json()).toMatchObject({ birthYear: null, heightCm: null })
  })

  it('round-trips the chart favourites', async () => {
    const { call } = await withServer(stubApp())

    const saved = await (await call('/api/preferences', {
      method: 'POST',
      body: JSON.stringify({ favouriteCharts: ['steps-trend', 'sleep-stages'] }),
    })).json()
    expect(saved).toEqual({ favouriteCharts: ['sleep-stages', 'steps-trend'] })

    expect(await (await call('/api/preferences')).json()).toEqual({
      favouriteCharts: ['sleep-stages', 'steps-trend'],
    })
  })

  it('returns empty preferences before anything is saved', async () => {
    const { call } = await withServer(stubApp())
    expect(await (await call('/api/preferences')).json()).toEqual({ favouriteCharts: [] })
  })

  it('drops a hostile chart id on the way through the route', async () => {
    const { call } = await withServer(stubApp())

    const saved = await (await call('/api/preferences', {
      method: 'POST',
      body: JSON.stringify({ favouriteCharts: ['../../etc/passwd', 'Steps Trend', 'steps-trend'] }),
    })).json()

    expect(saved).toEqual({ favouriteCharts: ['steps-trend'] })
  })

  it('merges a preferences patch that names nothing', async () => {
    const { call } = await withServer(stubApp())

    await call('/api/preferences', { method: 'POST', body: JSON.stringify({ favouriteCharts: ['steps-trend'] }) })
    await call('/api/preferences', { method: 'POST', body: '{}' })

    expect(await (await call('/api/preferences')).json()).toEqual({ favouriteCharts: ['steps-trend'] })
  })

  it('rejects a non-object preferences body', async () => {
    const app = stubApp()
    const { call } = await withServer(app)

    const response = await call('/api/preferences', { method: 'POST', body: JSON.stringify(['not', 'an', 'object']) })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'The preferences update must be an object.' })
    expect(app.savePreferences).not.toHaveBeenCalled()
  })

  it('routes assistant calls, including agent selection', async () => {
    const app = stubApp()
    const { call } = await withServer(app)

    expect(await (await call('/api/assistant/agents')).json()).toMatchObject({ agents: [{ id: 'codex' }] })

    await call('/api/assistant/agent', { method: 'POST', body: JSON.stringify({ agentId: 'claude-code' }) })
    expect(app.assistant.selectAgent).toHaveBeenCalledWith('claude-code')

    await call('/api/assistant/turn', { method: 'POST', body: JSON.stringify({ requestId: 'abcd1234', message: 'hi' }) })
    expect(app.assistant.startTurn).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'abcd1234' }))
  })

  it('streams core events over SSE', async () => {
    const app = stubApp()
    const { call } = await withServer(app)

    const response = await call('/api/events')
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''

    await vi.waitFor(() => expect(app.events.listenerCount('sync-progress')).toBe(1))
    app.events.emit('sync-progress', { completed: 1, total: 4, key: 'steps' })

    while (!seen.includes('sync-progress')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }

    expect(seen).toContain('event: sync-progress')
    expect(seen).toContain('"completed":1')
    await reader.cancel()
  })

  it('detaches SSE listeners when a client disconnects', async () => {
    const app = stubApp()
    const { call } = await withServer(app)

    const controller = new AbortController()
    await call('/api/events', { signal: controller.signal })
    await vi.waitFor(() => expect(app.events.listenerCount('assistant')).toBe(1))

    controller.abort()
    await vi.waitFor(() => expect(app.events.listenerCount('assistant')).toBe(0))
  })

  it('closes an open SSE stream once the session behind it is revoked', async () => {
    // Authorization is a per-request property and this request never ends. A
    // revoked browser — a lost laptop with an open tab — kept receiving sync
    // progress and assistant output until the heartbeat learned to re-check.
    const app = stubApp()
    const { base, sessionCookie } = await withServer(app, { heartbeatMs: 25 })

    const stream = await fetch(`${base}/api/events`, { headers: { cookie: sessionCookie } })
    await vi.waitFor(() => expect(app.events.listenerCount('sync-progress')).toBe(1))

    const drained = (async () => {
      const reader = stream.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return text
        text += decoder.decode(value, { stream: true })
      }
    })()

    // Signed out everywhere from another device, exactly as the account menu does.
    const loggedOut = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ everywhere: true }),
    })
    expect(await loggedOut.json()).toEqual({ ok: true, revoked: true })

    const text = await drained
    expect(app.events.listenerCount('sync-progress')).toBe(0)

    // Nothing this account's app emits after the revocation can reach it.
    app.events.emit('sync-progress', { completed: 1, total: 4, key: 'steps' })
    expect(text).not.toContain('sync-progress')
  })

  it('keeps a still-valid stream open across heartbeats', async () => {
    const app = stubApp()
    const { base, sessionCookie } = await withServer(app, { heartbeatMs: 25 })

    const stream = await fetch(`${base}/api/events`, { headers: { cookie: sessionCookie } })
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes(': ping')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }

    expect(text).toContain(': ping')
    expect(app.events.listenerCount('sync-progress')).toBe(1)
    await reader.cancel()
  })

  it('falls back to the shell for unknown paths but 404s unknown API routes', async () => {
    const { call } = await withServer(stubApp())

    expect(await (await call('/today')).text()).toContain('SHELL')
    expect((await call('/api/nope')).status).toBe(404)
  })

  it('404s a missing asset instead of answering it with the shell', async () => {
    const { call } = await withServer(stubApp())

    // Serving HTML for a missing .js yields a blank page under nosniff rather
    // than a legible failure, so anything with a file extension must 404.
    for (const pathname of ['/assets/index-abc123.js', '/assets/gone.css', '/assets/font.woff2']) {
      const response = await call(pathname)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).not.toContain('text/html')
    }
  })

  it('serves real assets with their own content type', async () => {
    const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-dist-'))
    fs.mkdirSync(path.join(staticRoot, 'assets'))
    fs.writeFileSync(path.join(staticRoot, 'index.html'), 'SHELL')
    fs.writeFileSync(path.join(staticRoot, 'assets', 'app.js'), 'export default 1')
    fs.writeFileSync(path.join(staticRoot, 'assets', 'app.css'), '.a{}')
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-data-'))

    const sessions = createSessions({ masterKey: MASTER_KEY, secure: false })
    const accounts = stubAccounts({})
    const { server } = createServer({
      staticRoot,
      dataDir,
      token: 'test-token',
      sessions,
      accounts,
      registry: stubRegistry(stubApp()),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => {
      server.close()
      fs.rmSync(staticRoot, { recursive: true, force: true })
      fs.rmSync(dataDir, { recursive: true, force: true })
    })

    const base = `http://127.0.0.1:${server.address().port}`
    const account = accounts.all[0]
    const headers = { cookie: `openfit_session=${sessions.sign({ sub: account.sub, email: account.email, epoch: account.epoch })}` }

    const js = await fetch(`${base}/assets/app.js`, { headers })
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')

    const css = await fetch(`${base}/assets/app.css`, { headers })
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
  })

  it('no longer mounts the legacy provider callback', async () => {
    const { call } = await withServer(stubApp())

    // The health scopes now come from the same consent as sign-in, so the
    // in-app provider callback is gone; the path is an ordinary navigation.
    expect(await (await call('/oauth/callback?code=x')).text()).toContain('SHELL')
  })

  it('rejects an oversized request body', async () => {
    const { call } = await withServer(stubApp())
    const response = await call('/api/sync', { method: 'POST', body: JSON.stringify({ date: 'x'.repeat(2 * 1024 * 1024) }) })
    expect(response.status).toBe(413)
  })
})

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

  it('no longer exchanges a tokenized link for a cookie, and clears the legacy one', async () => {
    const { base, token } = await withServer(stubApp())
    const response = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
    const cookies = response.headers.getSetCookie()

    // Tokenized browser URLs are gone: the token travelled in history and in
    // referrers, and it authorises /api/* rather than a person. The only cookie
    // left in the response is the one that deletes the legacy credential.
    expect(response.status).toBe(200)
    expect(cookies).toEqual([expect.stringContaining('openfit_token=;')])
    expect(cookies[0]).toContain('Max-Age=0')
    expect(cookies.join('\n')).not.toContain(token)
    expect(await response.text()).toContain('Sign in with Google')
  })

  it('refuses the server token presented as a query parameter or the legacy cookie', async () => {
    const { base, token } = await withServer(stubApp())

    // Both channels authorised /api/* until this fix. The cookie was the worse
    // of the two: a previous release set it for a year and no epoch bump could
    // reach it, so "log out everywhere" did nothing to a browser holding one.
    expect((await fetch(`${base}/api/status?token=${token}`)).status).toBe(401)
    expect((await fetch(`${base}/api/status`, { headers: { cookie: `openfit_token=${token}` } })).status).toBe(401)
    expect((await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
  })

  it('rejects a session cookie whose epoch is stale', async () => {
    const { base, staleCookie } = await withServer(stubApp())
    expect((await fetch(`${base}/api/status`, { headers: { cookie: staleCookie } })).status).toBe(401)
  })

  it('shows the login page and clears the cookie when a revoked session asks for the shell', async () => {
    const { base, staleCookie } = await withServer(stubApp())
    const response = await fetch(`${base}/`, { headers: { cookie: staleCookie } })

    // A revoked browser that still gets the shell looks signed in while every
    // call it makes 401s, which is how "log out everywhere" appears to work
    // and does not.
    expect(await response.text()).toContain('Sign in with Google')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('treats a session for a deleted account as signed out', async () => {
    const { base, sessionCookie, registry } = await withServer(stubApp(), { accountCount: 0 })

    expect((await fetch(`${base}/api/status`, { headers: { cookie: sessionCookie } })).status).toBe(401)
    expect(await (await fetch(`${base}/`, { headers: { cookie: sessionCookie } })).text()).toContain('Sign in with Google')
    expect(registry.forAccount).not.toHaveBeenCalled()
  })

  it('refuses a bearer request when no account has signed in yet', async () => {
    const { base, registry } = await withServer(stubApp(), { accountCount: 0 })
    const response = await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer test-token' } })

    expect(response.status).toBe(401)
    expect(registry.forAccount).not.toHaveBeenCalled()
  })

  it('rejects a pending sign-in cookie replayed as a session', async () => {
    const { base, sessions, registry } = await withServer(stubApp())
    const pending = sessions.sign({ kind: 'pending', state: 's', nonce: 'n', verifier: 'v' })

    const response = await fetch(`${base}/api/status`, { headers: { cookie: `openfit_session=${pending}` } })
    expect(response.status).toBe(401)
    expect(registry.forAccount).not.toHaveBeenCalled()
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

  it('refuses an X-OpenFit-Account header that names nothing', async () => {
    const { base, registry } = await withServer(stubApp(), { accountCount: 2 })
    const response = await fetch(`${base}/api/status`, {
      headers: { authorization: 'Bearer test-token', 'x-openfit-account': 'nobody@example.com' },
    })

    expect(response.status).toBe(409)
    expect(registry.forAccount).not.toHaveBeenCalled()
  })

  it('refuses a header that names nothing even when there is only one account', async () => {
    // The sole-account shortcut must sit *below* the header check. Above it, a
    // caller explicitly asking for b@example.com on an instance holding only
    // a@example.com is silently handed a@example.com.
    const { base, registry } = await withServer(stubApp(), { accountCount: 1 })
    const response = await fetch(`${base}/api/status`, {
      headers: { authorization: 'Bearer test-token', 'x-openfit-account': 'nobody@example.com' },
    })

    expect(response.status).toBe(409)
    expect(registry.forAccount).not.toHaveBeenCalled()
  })

  it('refuses an X-OpenFit-Account header that names two accounts at once', async () => {
    const { base, registry } = await withServer(stubApp(), { emails: ['same@example.com', 'same@example.com'] })
    const response = await fetch(`${base}/api/status`, {
      headers: { authorization: 'Bearer test-token', 'x-openfit-account': 'same@example.com' },
    })

    expect(response.status).toBe(409)
    expect(registry.forAccount).not.toHaveBeenCalled()
  })

  it('does not let an account with an empty email absorb a header-less bearer request', async () => {
    const { base, registry } = await withServer(stubApp(), { emails: ['', 'b@example.com'] })
    const response = await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer test-token' } })

    expect(response.status).toBe(409)
    expect(registry.forAccount).not.toHaveBeenCalled()
  })

  it('ignores X-OpenFit-Account when a session names the account', async () => {
    const alice = stubApp()
    const bob = stubApp()
    const { base, accounts, cookieFor, registry } = await withServer(alice, {
      accountCount: 2,
      apps: { 'acc-a': alice, 'acc-b': bob },
    })

    await fetch(`${base}/api/status`, {
      headers: { cookie: cookieFor(accounts.all[0]), 'x-openfit-account': 'b@example.com' },
    })

    expect(registry.forAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'acc-a' }))
    expect(alice.getStatus).toHaveBeenCalledTimes(1)
    expect(bob.getStatus).not.toHaveBeenCalled()
  })

  it('answers a tampered account record with a 500 rather than another account', async () => {
    const { base, sessionCookie, registry } = await withServer(stubApp(), { accountCount: 2, getThrows: true })
    const response = await fetch(`${base}/api/status`, { headers: { cookie: sessionCookie } })

    expect(response.status).toBe(500)
    // The message names a file path, so it must not be echoed to the client.
    expect((await response.json()).error).toBe('The account could not be read.')
    expect(registry.forAccount).not.toHaveBeenCalled()
  })

  it('disposes every account app when the server closes', async () => {
    const { registry } = await withServer(stubApp())
    for (const cleanup of cleanups.splice(0)) cleanup()

    await vi.waitFor(() => expect(registry.disposeAll).toHaveBeenCalledTimes(1))
  })
})

describe('per-account routing', () => {
  it('serves each account its own app', async () => {
    const alice = stubApp({ getStatus: vi.fn(() => ({ who: 'alice' })) })
    const bob = stubApp({ getStatus: vi.fn(() => ({ who: 'bob' })) })
    const { base, accounts, cookieFor } = await withServer(alice, {
      accountCount: 2,
      apps: { 'acc-a': alice, 'acc-b': bob },
    })

    const first = await fetch(`${base}/api/status`, { headers: { cookie: cookieFor(accounts.all[0]) } })
    const second = await fetch(`${base}/api/status`, { headers: { cookie: cookieFor(accounts.all[1]) } })

    expect(await first.json()).toEqual({ who: 'alice' })
    expect(await second.json()).toEqual({ who: 'bob' })
  })

  it('streams only the signed-in account\'s events', async () => {
    const alice = stubApp()
    const bob = stubApp()
    const { base, accounts, cookieFor } = await withServer(alice, {
      accountCount: 2,
      apps: { 'acc-a': alice, 'acc-b': bob },
    })

    const response = await fetch(`${base}/api/events`, { headers: { cookie: cookieFor(accounts.all[1]) } })
    await vi.waitFor(() => expect(bob.events.listenerCount('sync-progress')).toBe(1))
    expect(alice.events.listenerCount('sync-progress')).toBe(0)

    await response.body!.cancel()
  })
})

describe('public route bodies', () => {
  it('parses a JSON body for public POST routes so logout everywhere works', async () => {
    const { base, accounts, sessionCookie } = await withServer(stubApp())

    const response = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ everywhere: true }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, revoked: true })
    expect(accounts.bumpEpoch).toHaveBeenCalledWith('sub-a')
  })

  it('does not revoke anything for a plain logout', async () => {
    const { base, accounts, sessionCookie } = await withServer(stubApp())

    const response = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ everywhere: false }),
    })

    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(accounts.bumpEpoch).not.toHaveBeenCalled()
  })

  it('applies the same body limits to public routes as to guarded ones', async () => {
    const { base } = await withServer(stubApp())

    const oversized = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ everywhere: 'x'.repeat(2 * 1024 * 1024) }),
    })
    expect(oversized.status).toBe(413)

    const malformed = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(malformed.status).toBe(400)
  })
})
