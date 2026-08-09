import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createCredentialStore, DEFAULT_REDIRECT_URI } = require('./credentials.cjs') as {
  createCredentialStore: (options: Record<string, any>) => any
  DEFAULT_REDIRECT_URI: string
}

const CREDENTIAL_FILE = '/mock/credentials.secure.json'
const CACHE_FILE = '/mock/health-cache.secure.json'

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

function makeStore(options: Record<string, any> = {}) {
  return createCredentialStore({
    secrets: options.secrets || fakeSecrets(),
    credentialFile: CREDENTIAL_FILE,
    cacheFile: CACHE_FILE,
    publicOrigin: options.publicOrigin ?? null,
    defaults: options.defaults,
  })
}

const storedConfig = (overrides: Record<string, any> = {}) => ({
  [CREDENTIAL_FILE]: {
    config: {
      provider: 'google-health',
      clientId: 'stale-client',
      clientSecret: 'stale-secret',
      redirectUri: 'http://127.0.0.1:42813/oauth/callback',
      agentId: 'codex',
      ...overrides,
    },
    token: { refresh_token: 'kept' },
    lastSyncAt: '2026-08-01T00:00:00.000Z',
  },
})

describe('credential defaults', () => {
  it('seeds an empty store from the injected environment', () => {
    const store = makeStore({ defaults: { clientId: 'env-client', clientSecret: 'env-secret', redirectUri: 'https://box.example/auth/callback' } })

    expect(store.read().config).toMatchObject({
      provider: 'google-health',
      clientId: 'env-client',
      clientSecret: 'env-secret',
      redirectUri: 'https://box.example/auth/callback',
    })
  })

  it('falls back to the loopback redirect when the environment names none', () => {
    expect(makeStore().read().config.redirectUri).toBe(DEFAULT_REDIRECT_URI)
  })

  // The whole point of the change: `.env` is the source of truth for the OAuth
  // identity. Anything the retired settings screen wrote is history.
  it('overrides a stored client id and secret with the environment', () => {
    const store = makeStore({
      secrets: fakeSecrets(storedConfig()),
      defaults: { clientId: 'env-client', clientSecret: 'env-secret', redirectUri: 'https://box.example/auth/callback' },
    })

    expect(store.read().config).toMatchObject({
      clientId: 'env-client',
      clientSecret: 'env-secret',
      redirectUri: 'https://box.example/auth/callback',
    })
  })

  it('does not blank a stored client when the host passes no defaults', () => {
    const store = makeStore({ secrets: fakeSecrets(storedConfig()) })

    expect(store.read().config).toMatchObject({ clientId: 'stale-client', clientSecret: 'stale-secret' })
  })

  it('applies only the identity keys the environment actually sets', () => {
    // A half-filled defaults object must not erase the rest of the identity.
    const store = makeStore({ secrets: fakeSecrets(storedConfig()), defaults: { clientId: 'env-client', clientSecret: '  ' } })

    const config = store.read().config
    expect(config.clientId).toBe('env-client')
    expect(config.clientSecret).toBe('stale-secret')
  })

  it('leaves everything that is not the oauth identity on disk', () => {
    const store = makeStore({ secrets: fakeSecrets(storedConfig()), defaults: { clientId: 'env-client' } })

    const credentials = store.read()
    expect(credentials.config.agentId).toBe('codex')
    expect(credentials.token).toEqual({ refresh_token: 'kept' })
    expect(credentials.lastSyncAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it('no longer accepts a configuration from a caller', () => {
    const store = makeStore()

    // saveConfig is gone from the app; the validators that only it used must go
    // with it, or a future caller resurrects the surface by calling them.
    expect(store.validateConfig).toBeUndefined()
    expect(store.oauthIdentityChanged).toBeUndefined()
  })
})
