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
