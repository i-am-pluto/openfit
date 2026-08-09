import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

type StubCookie = {
  url: string
  name: string
  value: string
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
  expirationDate?: number
}

const cookiesSet: StubCookie[] = []
const openedExternally: string[] = []

/**
 * Enough of Electron to load the composition root, and no more.
 *
 * `whenReady` never resolves, so the window lifecycle never runs: what is under
 * test is the backend this file composes, which is the part Task 7 broke and no
 * test noticed. `safeStorage` reports a real OS backend so the desktop host's
 * preference for the keychain over `master.key` is exercised too.
 */
const electronStub = {
  app: {
    isPackaged: false,
    commandLine: { appendSwitch: () => {} },
    setName: () => {},
    setPath: () => {},
    getPath: () => os.tmpdir(),
    getVersion: () => '1.0.0-test',
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise<void>(() => {}),
    on: () => {},
    quit: () => {},
    dock: { setIcon: () => {} },
  },
  BrowserWindow: class {
    static getAllWindows() { return [] }
  },
  dialog: { showErrorBox: () => {} },
  nativeTheme: { themeSource: 'dark' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`keychain:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^keychain:/, ''),
  },
  session: {
    defaultSession: {
      setPermissionRequestHandler: () => {},
      cookies: { set: async (cookie: StubCookie) => { cookiesSet.push(cookie) } },
    },
  },
  shell: { openExternal: async (url: string) => { openedExternally.push(url) } },
}

// Installed in the CommonJS cache before main.cjs is loaded, so its
// `require('electron')` resolves to the stub. Outside a real Electron run that
// module exports the path of the binary, and every call in main.cjs would throw.
const ELECTRON = require.resolve('electron')
require.cache[ELECTRON] = {
  id: ELECTRON,
  filename: ELECTRON,
  path: path.dirname(ELECTRON),
  loaded: true,
  children: [],
  paths: [],
  exports: electronStub,
} as unknown as NodeJS.Module

type Composed = {
  server: { close: (done: () => void) => void }
  secrets: { describe: () => { backend: string } }
  sessions: { verify: (value: string) => Record<string, unknown> | null; cookieName: string }
  registry: { forAccount: (account: { id: string; dir: string }) => { getStatus: () => Record<string, unknown> } }
  publicOrigin: string | null
  secure: boolean
  origin: string
  startUrl: string
}

const main = require('./main.cjs') as {
  startBackend: (dataDir: string, options?: { port?: number; env?: Record<string, string>; envPath?: string }) => Promise<Composed>
  isTrustedRendererUrl: (value: string) => boolean
  desktopSignInUrl: (value: string) => string | null
  openSignInExternally: (value: string) => boolean
  environmentFile: (dataDir: string) => string
  DESKTOP_PORT: number
  SIGN_IN_PATH: string
}

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  cookiesSet.length = 0
  openedExternally.length = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-electron-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Bind, read the port, release it. The real host binds DESKTOP_PORT, which is
// registered with Google and would collide with a developer's running app.
async function freePort() {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as net.AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/**
 * A free port low enough that appending a digit is still a valid port.
 *
 * `http://127.0.0.1:2345` is a prefix of `http://127.0.0.1:23450`, which is a
 * different process on the same machine — the only parseable way to fake this
 * origin that carries no userinfo. With a five-digit ephemeral port the two
 * guards cannot be told apart.
 */
async function freeLowPort() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = 2000 + Math.floor(Math.random() * 3000)
    if (candidate === 5173) continue
    const probe = net.createServer()
    const listening = await new Promise<boolean>((resolve) => {
      probe.once('error', () => resolve(false))
      probe.listen(candidate, '127.0.0.1', () => resolve(true))
    })
    await new Promise((resolve) => probe.close(resolve))
    if (listening) return candidate
  }
  throw new Error('No free port below 5000 to test the origin comparison with.')
}

async function start(extraEnv: Record<string, string> = {}, fixedPort?: number) {
  const root = tempDir()
  const dataDir = path.join(root, 'data')
  const port = fixedPort ?? await freePort()

  const composed = await main.startBackend(dataDir, {
    port,
    env: {
      OPENFIT_GOOGLE_CLIENT_ID: 'desktop-client',
      OPENFIT_GOOGLE_CLIENT_SECRET: 'desktop-secret',
      ...extraEnv,
    },
    // Deliberately absent: loadEnv treats ENOENT as normal, and the developer's
    // own .env must not decide what this test sees.
    envPath: path.join(root, 'absent.env'),
  })

  cleanups.push(() => new Promise<void>((resolve) => { composed.server.close(() => resolve()) }))
  return { ...composed, port, dataDir, origin: `http://127.0.0.1:${port}` }
}

// Only Google's token endpoint; everything else, including this file's own
// requests to the server under test, goes through the real fetch.
function stubGoogleTokenEndpoint(payload: Record<string, unknown>) {
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    if (!String(input).startsWith('https://oauth2.googleapis.com/token')) return realFetch(input as string, init)
    return { ok: true, json: async () => payload }
  })
}

function idToken(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.signature`
}

const cookieValue = (response: Response, name: string) =>
  response.headers.getSetCookie().map((entry) => entry.split(';')[0]).find((pair) => pair.startsWith(`${name}=`)) ?? ''

describe('the desktop composition root', () => {
  it('builds a backend and serves the sign-in page to an anonymous window', async () => {
    // Task 7 changed createServer's signature and left this call behind, so the
    // packaged app threw before it ever opened a window. Composing at all is
    // most of the assertion.
    const { origin, startUrl } = await start()

    const response = await fetch(`${origin}/`)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Sign in with Google')
    // The `?token=` cookie exchange is gone; that URL only added a useless
    // query parameter to the sign-in page.
    expect(startUrl).toBe(`${origin}/`)
    expect(startUrl).not.toContain('token=')
  })

  it('starts the Google flow with the configured client, a nonce, and the loopback callback', async () => {
    const { origin, port } = await start()

    const response = await fetch(`${origin}/auth/login`, { redirect: 'manual' })
    const location = new URL(String(response.headers.get('location')))

    expect(response.status).toBe(302)
    expect(location.origin).toBe('https://accounts.google.com')
    expect(location.searchParams.get('client_id')).toBe('desktop-client')
    expect(location.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/auth/callback`)
    // core/identity.cjs rejects an ID token with no nonce, so a URL without one
    // produces a sign-in that can never complete.
    expect(location.searchParams.get('nonce')).toBeTruthy()
    expect(location.searchParams.get('state')).toBeTruthy()
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.search).not.toContain('desktop-secret')
  })

  it('never marks its cookies Secure, which plain-http loopback would never send back', async () => {
    // registerLoginRoutes refuses to wire up when the session store and the
    // login routes disagree, so reaching a 302 at all is half the assertion.
    const { origin, secure } = await start()

    const response = await fetch(`${origin}/auth/login`, { redirect: 'manual' })

    expect(secure).toBe(false)
    expect(String(response.headers.get('set-cookie'))).toContain('openfit_pending=')
    expect(String(response.headers.get('set-cookie'))).not.toContain('Secure')
  })

  it('hands every account app the OAuth client from the environment', async () => {
    // Miss `oauthDefaults` and .env is ignored in silence: sign-in works and the
    // first token refresh does not.
    const { registry, dataDir, port } = await start()
    const dir = path.join(dataDir, 'accounts', 'a'.repeat(16))
    fs.mkdirSync(dir, { recursive: true })

    const status = registry.forAccount({ id: 'a'.repeat(16), dir }).getStatus()

    expect(status.clientId).toBe('desktop-client')
    expect(status.redirectUri).toBe(`http://127.0.0.1:${port}/auth/callback`)
    expect(status.hasClientSecret).toBe(true)
  })

  it('prefers the OS keychain for data at rest', async () => {
    // The server has no safeStorage and falls back to master.key. The desktop
    // host must keep the keychain it has always used, or existing users' stored
    // credentials become unreadable.
    const { secrets } = await start()

    expect(secrets.describe().backend).toBe('safeStorage')
  })

  it('ignores OPENFIT_PUBLIC_ORIGIN, which a loopback window could not satisfy', async () => {
    // A shared .env configuring the server for a tailnet must not make the
    // desktop app claim an origin it is not serving, mark cookies Secure that
    // no browser would return, or send Google's callback to another process.
    const { origin, port, publicOrigin, secure, dataDir, registry } = await start({
      OPENFIT_PUBLIC_ORIGIN: 'https://box.tail-abc123.ts.net',
    })
    const dir = path.join(dataDir, 'accounts', 'b'.repeat(16))
    fs.mkdirSync(dir, { recursive: true })

    const response = await fetch(`${origin}/auth/login`, { redirect: 'manual' })
    const location = new URL(String(response.headers.get('location')))

    expect(publicOrigin).toBe(null)
    expect(secure).toBe(false)
    expect(location.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/auth/callback`)
    expect(registry.forAccount({ id: 'b'.repeat(16), dir }).getStatus().publicOrigin).toBe(null)
  })

  it('binds a port that collides with neither the server, the dev API, nor Vite', async () => {
    // The port is in the OAuth client's registered redirect URI, so it cannot
    // move once anyone has registered it, and it cannot be one another OpenFit
    // process already holds.
    expect([7788, 7789, 5173]).not.toContain(main.DESKTOP_PORT)
    expect(Number.isInteger(main.DESKTOP_PORT)).toBe(true)
    expect(main.DESKTOP_PORT).toBeGreaterThan(1023)
    expect(main.DESKTOP_PORT).toBeLessThan(65536)
  })

  it('refuses to start without a Google client, and leaves nothing on disk', async () => {
    const root = tempDir()
    const dataDir = path.join(root, 'never-created')

    await expect(main.startBackend(dataDir, {
      port: await freePort(),
      env: {},
      envPath: path.join(root, 'absent.env'),
    })).rejects.toThrow('OPENFIT_GOOGLE_CLIENT_ID is not set.')

    expect(fs.existsSync(dataDir)).toBe(false)
  })
})

describe('the external sign-in handoff', () => {
  it('hands its own sign-in route to the browser and nothing else', async () => {
    const { origin } = await start()

    expect(main.desktopSignInUrl(`${origin}/auth/login`)).toBe(`${origin}/auth/login`)
    expect(main.desktopSignInUrl(`${origin}/auth/login?prompt=consent`)).toBe(`${origin}/auth/login?prompt=consent`)

    // shell.openExternal launches whatever handler the desktop registered for a
    // scheme, so every one of these would be an arbitrary-URL opener if the
    // rule were "whatever the page navigated to".
    for (const hostile of [
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      'https://evil.example/auth/login',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ms-msdt:/id',
      // Credentials in the authority: the first has this origin and would ride
      // them into the browser, the second only *starts with* it — the host is
      // evil.example and `127.0.0.1:<port>` is the userinfo.
      `${origin.replace('http://', 'http://user:pass@')}/auth/login`,
      `${origin}@evil.example/auth/login`,
      `${origin}/auth/callback?code=stolen`,
      `${origin}/auth/logout`,
      `${origin}/`,
      'not a url',
    ]) {
      expect(main.desktopSignInUrl(hostile)).toBe(null)
    }
  })

  it('opens only the sign-in route, and refuses everything else silently', async () => {
    const { origin } = await start()

    expect(main.openSignInExternally('https://evil.example/')).toBe(false)
    expect(openedExternally).toEqual([])

    expect(main.openSignInExternally(`${origin}/auth/login?prompt=consent`)).toBe(true)
    expect(openedExternally).toHaveLength(1)

    const handed = new URL(openedExternally[0])
    expect(handed.origin).toBe(origin)
    expect(handed.pathname).toBe('/auth/login')
    expect(handed.searchParams.get('prompt')).toBe('consent')
    // The flow id is what lets the callback be recognised as this one.
    expect(handed.searchParams.get('flow')).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  })

  it('mints its own flow id rather than taking one from the page', async () => {
    // The URL comes from the renderer. A page that navigated to
    // /auth/login?flow=<something it chose> must not get to pick the id that
    // decides whose sign-in the window adopts.
    const { origin } = await start()

    main.openSignInExternally(`${origin}/auth/login?flow=${'p'.repeat(43)}`)
    main.openSignInExternally(`${origin}/auth/login`)

    const ids = openedExternally.map((value) => new URL(value).searchParams.get('flow'))
    expect(ids[0]).not.toBe('p'.repeat(43))
    expect(ids[0]).not.toBe(ids[1])
    expect(new URL(openedExternally[0]).searchParams.getAll('flow')).toHaveLength(1)
  })

  it('compares the whole origin, not a prefix of it', async () => {
    // A neighbouring loopback port is another process. Handing it the sign-in
    // URL would start the flow there — pending cookie, client secret exchange
    // and all — instead of here.
    const port = await freeLowPort()
    const { origin } = await start({}, port)

    expect(main.desktopSignInUrl(`${origin}/auth/login`)).toBe(`${origin}/auth/login`)
    expect(main.desktopSignInUrl(`${origin}0/auth/login`)).toBe(null)
    expect(main.isTrustedRendererUrl(`${origin}0/`)).toBe(false)
  })

  it('still trusts its own origin for ordinary navigation', async () => {
    const { origin } = await start()

    expect(main.isTrustedRendererUrl(`${origin}/index.html`)).toBe(true)
    expect(main.isTrustedRendererUrl('https://accounts.google.com/')).toBe(false)
    expect(main.isTrustedRendererUrl(`${origin}@evil.example/`)).toBe(false)
  })
})

describe('adopting the session the browser signed in with', () => {
  const sub = 'google-sub-desktop'

  /**
   * Drives a whole sign-in against the loopback server, as a browser would.
   *
   * `loginUrl` is what makes this able to play both parts: the window's own
   * flow starts at the URL that was handed to `shell.openExternal`, and a
   * foreign flow starts at a bare `/auth/login` it reached on its own.
   */
  async function completeCallback(origin: string, options: { loginUrl?: string; sub?: string; email?: string } = {}) {
    const {
      loginUrl = `${origin}/auth/login`,
      sub: subject = sub,
      email = 'ada@example.com',
    } = options

    const login = await fetch(loginUrl, { redirect: 'manual' })
    const authorize = new URL(String(login.headers.get('location')))
    const pending = cookieValue(login, 'openfit_pending')

    stubGoogleTokenEndpoint({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      id_token: idToken({
        iss: 'https://accounts.google.com',
        aud: 'desktop-client',
        nonce: authorize.searchParams.get('nonce'),
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: subject,
        email,
        email_verified: true,
      }),
    })

    return fetch(`${origin}/auth/callback?code=auth-code&state=${authorize.searchParams.get('state')}`, {
      redirect: 'manual',
      headers: { cookie: pending },
    })
  }

  const handedOff = () => String(openedExternally.at(-1))

  it('mints the window an equivalent cookie when this window started the sign-in', async () => {
    // The consent happened in the user's browser, which has its own cookie
    // store: the Set-Cookie on the callback is invisible to Electron whatever
    // port it was set on. The server runs in this process, so the cookie is
    // minted here with the same signing key instead.
    const { origin, sessions } = await start()
    main.openSignInExternally(`${origin}/auth/login`)

    const callback = await completeCallback(origin, { loginUrl: handedOff() })

    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/')
    expect(cookiesSet).toHaveLength(1)
    expect(cookiesSet[0]).toMatchObject({
      url: `${origin}/`,
      name: 'openfit_session',
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
    })
    expect(sessions.verify(cookiesSet[0].value)).toMatchObject({ sub, email: 'ada@example.com', epoch: 1 })
  })

  it('ignores a sign-in this window did not start', async () => {
    // Anything on the machine can reach a loopback port. Without the latch a
    // second local user completing their own Google sign-in against this port
    // would silently retarget the window at their account.
    const { origin } = await start()

    const callback = await completeCallback(origin)

    // The browser that did the sign-in still gets its session; this window does
    // not, and the callback is not failed over it.
    expect(callback.status).toBe(302)
    expect(cookieValue(callback, 'openfit_session')).toMatch(/^openfit_session=v1\./)
    expect(cookiesSet).toEqual([])
  })

  it('refuses a sign-in for another account completed while its own is outstanding', async () => {
    // The window is waiting on its own flow. A second local user — or any page
    // in the user's ordinary browser, since cross-origin navigation to loopback
    // is not blocked — drives a whole flow of its own against the same port and
    // finishes first. "A sign-in was started here recently" is true, so a latch
    // that is not bound to a specific flow hands the window to the stranger and
    // then silently drops the user's own callback.
    const { origin, sessions } = await start()
    main.openSignInExternally(`${origin}/auth/login`)
    const ours = handedOff()

    const foreign = await completeCallback(origin, {
      // No flow id: a foreign process cannot know the one handed to the browser.
      loginUrl: `${origin}/auth/login`,
      sub: 'google-sub-attacker',
      email: 'attacker@example.com',
    })

    // The foreign browser gets its own session, as it should — that flow was a
    // real sign-in. What must not happen is this window being moved onto it.
    expect(foreign.status).toBe(302)
    expect(cookieValue(foreign, 'openfit_session')).toMatch(/^openfit_session=v1\./)
    expect(cookiesSet).toEqual([])

    // And the outstanding flow was not burned by it. The user finishes, and it
    // is their account the window ends up on.
    const mine = await completeCallback(origin, { loginUrl: ours })

    expect(mine.status).toBe(302)
    expect(cookiesSet).toHaveLength(1)
    expect(sessions.verify(cookiesSet[0].value)).toMatchObject({ sub, email: 'ada@example.com' })
  })

  it('refuses a flow id the window did not mint', async () => {
    // The parameter is in a URL, so anything that can reach the port can set
    // it. Guessing is the only way in, against 32 random bytes.
    const { origin } = await start()
    main.openSignInExternally(`${origin}/auth/login`)

    const guessed = await completeCallback(origin, {
      loginUrl: `${origin}/auth/login?flow=${'g'.repeat(43)}`,
      sub: 'google-sub-guesser',
      email: 'guesser@example.com',
    })

    expect(guessed.status).toBe(302)
    expect(cookiesSet).toEqual([])
  })

  it('stores the exchanged token against the account that signed in', async () => {
    // afterAuthorized runs after adoptToken, so a broken hook must not be able
    // to cost the account its credentials.
    const { origin, dataDir } = await start()
    main.openSignInExternally(`${origin}/auth/login`)

    await completeCallback(origin, { loginUrl: handedOff() })

    const { accountId } = require('../core/accounts.cjs') as { accountId: (value: string) => string }
    const file = path.join(dataDir, 'accounts', accountId(sub), 'credentials.secure.json')
    expect(fs.existsSync(file)).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).encrypted).toBe(true)
  })
})
