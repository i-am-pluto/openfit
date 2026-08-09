import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { registerLoginRoutes, PENDING_COOKIE, PENDING_MAX_AGE_SECONDS } = require('./login.cjs') as {
  registerLoginRoutes: (options: Record<string, any>) => void
  PENDING_COOKIE: string
  PENDING_MAX_AGE_SECONDS: number
}
const { createSessions } = require('../session.cjs') as { createSessions: (o: any) => any }
const { loginPage } = require('../login-page.cjs') as { loginPage: (message?: string) => string }

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

const setCookie = (response: ReturnType<typeof fakeResponse>) => [response.headers['set-cookie']].flat().map(String)

function buildDeps(overrides: Record<string, any> = {}) {
  const sessions = createSessions({ masterKey, secure: false })
  return {
    sessions,
    accounts: {
      resolve: vi.fn(({ sub, email }: any) => ({ id: 'acc1', sub, email, epoch: 1, dir: '/d/acc1' })),
      bumpEpoch: vi.fn(() => 2),
    },
    identity: { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://box.ts.net/auth/callback' },
    secure: false,
    onAuthorized: vi.fn(async () => {}),
    exchange: vi.fn(async () => ({ id_token: 'stub', refresh_token: 'r1' })),
    authorizationUrl: vi.fn(({ state }: any) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
    validateIdToken: vi.fn(() => ({ sub: '123', email: 'a@example.com' })),
    ...overrides,
  }
}

// Drives `GET /auth/login` and returns everything a callback needs to look genuine.
async function signIn(routes: Map<string, Function>, query = '') {
  const response = fakeResponse()
  await routes.get('GET /auth/login')!(
    { url: `/auth/login${query}`, headers: {} },
    response,
    { url: new URL(`https://box.ts.net/auth/login${query}`) },
  )
  return {
    response,
    cookie: setCookie(response)[0].split(';')[0],
    state: new URL(String(response.headers.location)).searchParams.get('state'),
  }
}

async function callback(routes: Map<string, Function>, query: string, cookie?: string) {
  const response = fakeResponse()
  await routes.get('GET /auth/callback')!(
    { url: `/auth/callback${query}`, headers: cookie ? { cookie } : {} },
    response,
    { url: new URL(`https://box.ts.net/auth/callback${query}`) },
  )
  return response
}

afterEach(() => { vi.useRealTimers() })

describe('login routes', () => {
  it('redirects to Google and sets a pending cookie', async () => {
    const { response } = await signIn(collect(buildDeps()))

    expect(response.status).toBe(302)
    expect(String(response.headers.location)).toContain('accounts.google.com')
    expect(setCookie(response)[0]).toContain(PENDING_COOKIE)
    expect(setCookie(response)[0]).toContain(`Max-Age=${PENDING_MAX_AGE_SECONDS}`)
    expect(PENDING_MAX_AGE_SECONDS).toBe(600)
  })

  it('scopes the pending cookie to /auth and keeps every protective attribute', async () => {
    const insecure = setCookie((await signIn(collect(buildDeps()))).response)[0]
    const secured = setCookie((await signIn(collect(buildDeps({
      sessions: createSessions({ masterKey, secure: true }),
      secure: true,
    })))).response)[0]

    for (const cookie of [insecure, secured]) {
      expect(cookie).toContain('Path=/auth')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
    }
    // `Secure` follows the one explicit flag, never a guess at the redirect URI.
    expect(insecure).not.toContain('Secure')
    expect(secured).toContain('Secure')
  })

  it('refuses to wire up when the session store and the routes disagree about Secure', () => {
    expect(() => collect(buildDeps({ secure: true }))).toThrow(/Secure/)
    expect(() => collect(buildDeps({ secure: 'yes' }))).toThrow(/boolean/)
  })

  // Google will not return an ID token containing a nonce unless the authorization
  // request carried one, and core/identity.cjs rejects a token whose nonce is absent
  // or unexpected. The generated nonce therefore has to reach `authorizationUrl`.
  it('hands the freshly generated state, nonce and PKCE challenge to authorizationUrl', async () => {
    const deps = buildDeps()
    const routes = collect(deps)
    const { state } = await signIn(routes)

    const [args] = deps.authorizationUrl.mock.calls[0] as [Record<string, any>]
    expect(args.state).toBe(state)
    expect(typeof args.nonce).toBe('string')
    expect(args.nonce.length).toBeGreaterThan(20)
    expect(typeof args.challenge).toBe('string')
    expect(args.nonce).not.toBe(args.state)

    // The nonce given to Google is the nonce the ID token is checked against.
    const second = await signIn(routes)
    await callback(routes, `?code=abc&state=${second.state}`, second.cookie)
    const secondNonce = (deps.authorizationUrl.mock.calls[1][0] as Record<string, any>).nonce
    expect(secondNonce).not.toBe(args.nonce)
    expect(deps.validateIdToken).toHaveBeenCalledWith('stub', { clientId: 'client-1', nonce: secondNonce })
  })

  it('generates a distinct state and nonce for every sign-in', async () => {
    const routes = collect(buildDeps())
    const first = await signIn(routes)
    const second = await signIn(routes)

    expect(first.state).not.toBe(second.state)
    expect(first.cookie).not.toBe(second.cookie)
  })

  // `prompt` arrives in the query string. Forwarding it verbatim would let a crafted
  // link choose Google's behaviour for the victim, `prompt=none` above all.
  it('forwards only allow-listed prompt values', async () => {
    const deps = buildDeps()
    const routes = collect(deps)

    await signIn(routes, '?prompt=consent')
    expect(deps.authorizationUrl.mock.calls[0][0]).toMatchObject({ prompt: 'consent' })

    await signIn(routes, '?prompt=none')
    expect(deps.authorizationUrl.mock.calls[1][0].prompt).toBeUndefined()

    await signIn(routes, '?prompt=' + encodeURIComponent('consent&scope=evil'))
    expect(deps.authorizationUrl.mock.calls[2][0].prompt).toBeUndefined()
  })

  it('completes the callback, stores the token and issues a session', async () => {
    const deps = buildDeps()
    const routes = collect(deps)
    const { cookie, state } = await signIn(routes)

    const response = await callback(routes, `?code=abc&state=${state}`, cookie)

    expect(deps.exchange).toHaveBeenCalledTimes(1)
    expect(deps.accounts.resolve).toHaveBeenCalledWith({ sub: '123', email: 'a@example.com' })
    expect(deps.onAuthorized).toHaveBeenCalledTimes(1)
    expect(deps.onAuthorized.mock.calls[0][1]).toMatchObject({ refresh_token: 'r1' })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/')
    expect(setCookie(response).join('\n')).toContain('openfit_session=')
    // The used state and verifier must not survive the exchange.
    expect(setCookie(response).find((value) => value.startsWith(PENDING_COOKIE))).toContain('Max-Age=0')
  })

  it('rejects a callback with no pending cookie', async () => {
    const deps = buildDeps()
    const response = await callback(collect(deps), '?code=abc&state=s')

    expect(response.status).toBe(400)
    expect(response.body).toMatch(/took too long/i)
    expect(deps.exchange).not.toHaveBeenCalled()
  })

  it('rejects a mismatched state without disclosing detail', async () => {
    const deps = buildDeps()
    const routes = collect(deps)
    const { cookie } = await signIn(routes)

    const response = await callback(routes, '?code=abc&state=wrong', cookie)

    expect(response.status).toBe(400)
    expect(deps.exchange).not.toHaveBeenCalled()
    expect(response.body).not.toContain('wrong')
  })

  // `null` from an absent query parameter must never compare equal to an absent
  // cookie field, and the code must not reach the exchange while state is unproven.
  it('rejects a callback with no state at all', async () => {
    const deps = buildDeps()
    const routes = collect(deps)
    const { cookie } = await signIn(routes)

    const response = await callback(routes, '?code=abc', cookie)

    expect(response.status).toBe(400)
    expect(deps.exchange).not.toHaveBeenCalled()
  })

  // The pending cookie and the session cookie are signed with the same key, so the
  // payload has to say which one it is.
  it('refuses a session cookie presented as the pending cookie', async () => {
    const deps = buildDeps()
    const forged = `${PENDING_COOKIE}=${deps.sessions.sign({ sub: '123', email: 'a@example.com', epoch: 1 })}`

    const response = await callback(collect(deps), '?code=abc&state=undefined', forged)

    expect(response.status).toBe(400)
    expect(deps.exchange).not.toHaveBeenCalled()
  })

  // Max-Age is only a hint to the browser: a captured cookie must expire server-side.
  it('rejects a pending cookie older than ten minutes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-09T10:00:00Z'))
    const deps = buildDeps()
    const routes = collect(deps)
    const { cookie, state } = await signIn(routes)

    vi.setSystemTime(new Date('2026-08-09T10:00:00Z').getTime() + (PENDING_MAX_AGE_SECONDS + 1) * 1000)
    const response = await callback(routes, `?code=abc&state=${state}`, cookie)

    expect(response.status).toBe(400)
    expect(response.body).toMatch(/took too long/i)
    expect(deps.exchange).not.toHaveBeenCalled()
    // Still inside the default 30-day session lifetime, so only the explicit
    // maxAgeSeconds option can be what rejected it.
    expect(deps.sessions.verify(cookie.split('=').slice(1).join('='))).not.toBeNull()
  })

  it('surfaces access_denied from Google', async () => {
    const deps = buildDeps()
    const routes = collect(deps)
    const { cookie, state } = await signIn(routes)

    const response = await callback(routes, `?error=access_denied&state=${state}`, cookie)

    expect(response.status).toBe(400)
    expect(response.body).toMatch(/denied|cancel/i)
    expect(deps.exchange).not.toHaveBeenCalled()
  })

  it('never echoes Google\'s error parameter into the page', async () => {
    const routes = collect(buildDeps())
    const { cookie, state } = await signIn(routes)
    const hostile = encodeURIComponent('<script>alert(1)</script>')

    const response = await callback(routes, `?error=${hostile}&state=${state}`, cookie)

    expect(response.status).toBe(400)
    expect(response.body).not.toContain('alert(1)')
    expect(response.body).not.toContain('<script>')
  })

  it('returns 403 when the email is unverified', async () => {
    const deps = buildDeps({
      validateIdToken: vi.fn(() => { throw new Error('The Google account email address is not verified.') }),
    })
    const routes = collect(deps)
    const { cookie, state } = await signIn(routes)

    const response = await callback(routes, `?code=abc&state=${state}`, cookie)

    expect(response.status).toBe(403)
    expect(response.body).toMatch(/verified/i)
    expect(deps.onAuthorized).not.toHaveBeenCalled()
  })

  it('returns 401 for any other identity failure', async () => {
    const deps = buildDeps({
      validateIdToken: vi.fn(() => { throw new Error('The Google ID token nonce does not match.') }),
    })
    const routes = collect(deps)
    const { cookie, state } = await signIn(routes)

    expect((await callback(routes, `?code=abc&state=${state}`, cookie)).status).toBe(401)
  })

  // The token request carries the client secret and Google's error text can quote
  // the request that produced it, so nothing from a failed exchange reaches the page.
  it('leaks nothing from a failed token exchange', async () => {
    const deps = buildDeps({
      exchange: vi.fn(async () => { throw new Error('invalid_client: secret-1 rejected for client-1') }),
    })
    const routes = collect(deps)
    const { cookie, state } = await signIn(routes)

    const response = await callback(routes, `?code=abc&state=${state}`, cookie)

    expect(response.status).toBe(502)
    expect(response.body).not.toContain('secret-1')
    expect(response.body).not.toContain('invalid_client')
    expect(deps.onAuthorized).not.toHaveBeenCalled()
  })

  it('issues no session when storing the token fails', async () => {
    const deps = buildDeps({ onAuthorized: vi.fn(async () => { throw new Error('/home/u/.openfit is read-only') }) })
    const routes = collect(deps)
    const { cookie, state } = await signIn(routes)

    const response = await callback(routes, `?code=abc&state=${state}`, cookie)

    expect(response.status).toBe(500)
    expect(response.body).not.toContain('/home/u/.openfit')
    expect(setCookie(response).join('\n')).not.toContain('openfit_session=')
  })

  it('clears the pending cookie on every terminal path', async () => {
    const deps = buildDeps()
    const routes = collect(deps)

    const cases = await Promise.all([
      callback(routes, '?code=abc&state=s'),
      (async () => callback(routes, '?code=abc&state=wrong', (await signIn(routes)).cookie))(),
      (async () => {
        const { cookie, state } = await signIn(routes)
        return callback(routes, `?error=access_denied&state=${state}`, cookie)
      })(),
      (async () => {
        const { cookie, state } = await signIn(routes)
        return callback(routes, `?code=abc&state=${state}`, cookie)
      })(),
    ])

    for (const response of cases) {
      const pending = setCookie(response).find((value) => value.startsWith(PENDING_COOKIE))
      expect(pending).toBeDefined()
      expect(pending).toContain('Max-Age=0')
      expect(pending).toContain('Path=/auth')
    }
  })

  it('clears the cookie on logout', async () => {
    const response = fakeResponse()
    await collect(buildDeps()).get('POST /auth/logout')!(
      { url: '/auth/logout', headers: {} },
      response,
      { url: new URL('https://box.ts.net/auth/logout'), body: {} },
    )

    expect(setCookie(response).join('\n')).toContain('Max-Age=0')
    expect(setCookie(response).some((value) => value.startsWith('openfit_session='))).toBe(true)
    expect(setCookie(response).some((value) => value.startsWith(PENDING_COOKIE))).toBe(true)
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

  // Public routes are dispatched without a parsed body today, so the query form has
  // to work or "log out everywhere" silently does nothing in production.
  it('accepts everywhere as a query parameter when no body was parsed', async () => {
    const deps = buildDeps()
    const sessionCookie = `openfit_session=${deps.sessions.sign({ sub: '123', email: 'a@example.com', epoch: 1 })}`
    const response = fakeResponse()

    await collect(deps).get('POST /auth/logout')!(
      { url: '/auth/logout?everywhere=true', headers: { cookie: sessionCookie } },
      response,
      { url: new URL('https://box.ts.net/auth/logout?everywhere=true') },
    )

    expect(deps.accounts.bumpEpoch).toHaveBeenCalledWith('123')
    expect(response.status).toBe(200)
  })

  it('does not bump an epoch for a pending cookie replayed as a session', async () => {
    const deps = buildDeps()
    const routes = collect(deps)
    const pending = (await signIn(routes)).cookie.split('=').slice(1).join('=')
    const response = fakeResponse()

    await routes.get('POST /auth/logout')!(
      { url: '/auth/logout', headers: { cookie: `openfit_session=${pending}` } },
      response,
      { url: new URL('https://box.ts.net/auth/logout'), body: { everywhere: true } },
    )

    expect(deps.accounts.bumpEpoch).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
  })

  it('still clears the cookie when the epoch bump fails', async () => {
    const deps = buildDeps({
      accounts: {
        resolve: vi.fn(),
        bumpEpoch: vi.fn(() => { throw new Error('Unknown account.') }),
      },
    })
    const sessionCookie = `openfit_session=${deps.sessions.sign({ sub: '123', email: 'a@example.com', epoch: 1 })}`
    const response = fakeResponse()

    await collect(deps).get('POST /auth/logout')!(
      { url: '/auth/logout', headers: { cookie: sessionCookie } },
      response,
      { url: new URL('https://box.ts.net/auth/logout'), body: { everywhere: true } },
    )

    expect(response.status).toBe(200)
    expect(setCookie(response).join('\n')).toContain('Max-Age=0')
  })
})

describe('login page', () => {
  it('offers sign-in as a link, because the CSP sets form-action none', () => {
    const html = loginPage()

    expect(html).toContain('href="/auth/login"')
    expect(html).not.toContain('<form')
  })

  it('escapes an interpolated message', () => {
    const html = loginPage('<img src=x onerror="alert(1)">')

    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&quot;')
  })

  it('renders no notice at all without a message', () => {
    expect(loginPage()).not.toContain('class="notice"')
  })
})
