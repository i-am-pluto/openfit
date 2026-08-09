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

  it('refuses an account that carries no usable id', () => {
    const { registry, createApp } = build()

    expect(() => registry.forAccount(null)).toThrow(/account/i)
    expect(() => registry.forAccount({ dir: '/a' })).toThrow(/id/i)
    expect(() => registry.forAccount({ id: '', dir: '/a' })).toThrow(/id/i)
    expect(() => registry.forAccount({ id: 123, dir: '/a' })).toThrow(/id/i)
    expect(createApp).not.toHaveBeenCalled()
  })

  it('does not let two id-less accounts share one cached app', () => {
    const { registry } = build()

    expect(() => registry.forAccount({ dir: '/a' })).toThrow()
    expect(() => registry.forAccount({ dir: '/b' })).toThrow()
  })

  it('refuses an account that carries no usable directory', () => {
    const { registry, createApp } = build()

    expect(() => registry.forAccount({ id: 'aaa' })).toThrow(/director/i)
    expect(() => registry.forAccount({ id: 'aaa', dir: '' })).toThrow(/director/i)
    expect(createApp).not.toHaveBeenCalled()
  })

  it('refuses to serve a cached app when the same id names a different directory', () => {
    const { registry, createApp } = build()
    registry.forAccount({ id: 'aaa', dir: '/a' })

    expect(() => registry.forAccount({ id: 'aaa', dir: '/b' })).toThrow(/aaa/)
    expect(createApp).toHaveBeenCalledTimes(1)
  })

  it('refuses to create an app once disposal has started, so none is stranded', async () => {
    const { registry, created } = build()
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = registry.forAccount({ id: 'aaa', dir: '/a' })
    first.dispose.mockImplementationOnce(() => blocked)

    const disposing = registry.disposeAll()
    expect(() => registry.forAccount({ id: 'bbb', dir: '/b' })).toThrow(/dispos/i)

    release()
    await disposing
    expect(created).toHaveLength(1)
  })

  it('stays disposable and quiet on a second disposeAll', async () => {
    const { registry, created } = build()
    registry.forAccount({ id: 'aaa', dir: '/a' })

    await registry.disposeAll()
    await expect(registry.disposeAll()).resolves.toBeUndefined()
    expect(created[0].dispose).toHaveBeenCalledTimes(1)
  })

  it('requires a data directory, a secret store and a createApp', () => {
    expect(() => createAccountRegistry({ secrets, createApp: () => ({}) })).toThrow(/dataDir/)
    expect(() => createAccountRegistry({ dataDir: '/data', createApp: () => ({}) })).toThrow(/secret/)
    expect(() => createAccountRegistry({ dataDir: '/data', secrets })).toThrow(/createApp/)
  })
})
