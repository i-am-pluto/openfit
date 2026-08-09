import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createApp } = require('./app.cjs') as { createApp: (options: Record<string, any>) => any }

const DATA_DIR = '/mock/account'
const CREDENTIAL_FILE = path.join(DATA_DIR, 'credentials.secure.json')

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
})

// An in-memory stand-in for core/secrets.cjs: `read` takes a fallback, `write`
// and `remove` are keyed by absolute path, exactly as the real store is.
function fakeSecrets(initial: Record<string, any> = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    read: (file: string, fallback: any) => (files.has(file) ? files.get(file) : fallback),
    write: (file: string, value: any) => { files.set(file, value) },
    remove: (file: string) => { files.delete(file) },
    describe: () => ({ encrypted: true, backend: 'test' }),
  }
}

function makeApp(options: Record<string, any> = {}) {
  // An empty env keeps the assistant registry from finding a real binary, so
  // nothing here can spawn a process.
  const app = createApp({ dataDir: DATA_DIR, env: {}, ...options })
  disposals.push(() => app.dispose())
  return app
}

describe('app status', () => {
  it('advertises how to reauthorize while disconnected', () => {
    // A refresh token expires after 7 days in testing mode, so "signed in but
    // disconnected" is the normal steady state and must be actionable.
    const app = makeApp({ secrets: fakeSecrets() })

    const status = app.getStatus()
    expect(status.connected).toBe(false)
    expect(status.reauthorizeUrl).toBe('/auth/login?prompt=consent')
  })

  it('returns the same reauthorize url from connect rather than starting a flow', async () => {
    const app = makeApp({ secrets: fakeSecrets() })

    expect(await app.connect()).toEqual({ reauthorizeUrl: '/auth/login?prompt=consent' })
    expect(app.getStatus().reauthorizeUrl).toBe('/auth/login?prompt=consent')
  })

  it('no longer exposes saveConfig or the provider callback', () => {
    const app = makeApp({ secrets: fakeSecrets() })

    // The OAuth client comes from .env now. Leaving either of these reachable
    // would let a signed-in browser repoint the client it authenticates with.
    expect(app.saveConfig).toBeUndefined()
    expect(app.handleOAuthCallback).toBeUndefined()
  })
})

describe('oauth defaults', () => {
  it('prefers the environment client over one left on disk by the old settings screen', () => {
    const secrets = fakeSecrets({
      [CREDENTIAL_FILE]: {
        config: {
          provider: 'google-health',
          clientId: 'stale-client',
          clientSecret: 'stale-secret',
          redirectUri: 'http://127.0.0.1:42813/oauth/callback',
          agentId: null,
        },
        token: { refresh_token: 'kept' },
        lastSyncAt: '2026-08-01T00:00:00.000Z',
      },
    })
    const app = makeApp({
      secrets,
      oauthDefaults: { clientId: 'env-client', clientSecret: 'env-secret', redirectUri: 'http://127.0.0.1:7789/auth/callback' },
    })

    const status = app.getStatus()
    // Token refresh signs with config.clientId/clientSecret. A stale stored
    // pair would keep being sent to Google long after .env was changed.
    expect(status.clientId).toBe('env-client')
    expect(status.redirectUri).toBe('http://127.0.0.1:7789/auth/callback')
    // The stored token is untouched: only the identity is overridden.
    expect(status.connected).toBe(true)
    expect(status.lastSyncAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it('keeps a stored client when the host supplies no defaults', () => {
    // The desktop host builds the app without oauthDefaults. Blanking its
    // configured client would disconnect every existing install.
    const secrets = fakeSecrets({
      [CREDENTIAL_FILE]: {
        config: { provider: 'google-health', clientId: 'desktop-client', clientSecret: 'desktop-secret', redirectUri: 'http://127.0.0.1:42813/oauth/callback', agentId: null },
        token: null,
        lastSyncAt: null,
      },
    })
    const app = makeApp({ secrets })

    expect(app.getStatus().clientId).toBe('desktop-client')
  })
})
