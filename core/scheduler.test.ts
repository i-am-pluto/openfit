import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createSyncScheduler, DEFAULT_INTERVAL_MS } = require('./scheduler.cjs') as {
  createSyncScheduler: (options: Record<string, any>) => {
    intervalMs: number
    runOnce: () => Promise<{ skipped: boolean; results: Array<Record<string, any>> }>
    start: (options?: { immediate?: boolean }) => void
    stop: () => void
    syncAccountNow: (account: any) => Promise<Record<string, any>>
  }
  DEFAULT_INTERVAL_MS: number
}

const NOW = new Date(2026, 7, 9, 14, 30)

function stubApp(overrides: Record<string, any> = {}) {
  return {
    getStatus: vi.fn(() => ({ connected: true })),
    sync: vi.fn(async () => ({ date: '2026-08-09' })),
    ...overrides,
  }
}

function build(apps: Record<string, any>, options: Record<string, any> = {}) {
  const list = Object.keys(apps).map((id) => ({ id, dir: `/data/accounts/${id}` }))
  const accounts = { list: vi.fn(() => list), ...(options.accounts || {}) }
  const registry = { forAccount: vi.fn((account: any) => apps[account.id]), ...(options.registry || {}) }
  const log = { warn: vi.fn(), log: vi.fn() }
  const scheduler = createSyncScheduler({ accounts, registry, now: () => NOW, log, ...options })
  return { scheduler, accounts, registry, log, apps }
}

const schedulers: Array<{ stop: () => void }> = []

afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stop()
  vi.useRealTimers()
})

describe('sync scheduler', () => {
  it('requires an accounts index and a registry', () => {
    expect(() => createSyncScheduler({ registry: {} })).toThrow(/accounts index/)
    expect(() => createSyncScheduler({ accounts: {} })).toThrow(/account registry/)
  })

  it('defaults to a ten minute interval and rejects nonsense', () => {
    expect(DEFAULT_INTERVAL_MS).toBe(600_000)
    for (const bad of [0, -1, 1.5, NaN, Infinity, '600000', null, undefined]) {
      expect(build({}, { intervalMs: bad }).scheduler.intervalMs).toBe(DEFAULT_INTERVAL_MS)
    }
    expect(build({}, { intervalMs: 1_000 }).scheduler.intervalMs).toBe(1_000)
  })

  it("syncs every connected account's current local day", async () => {
    const { scheduler, apps } = build({ a: stubApp(), b: stubApp() })

    const run = await scheduler.runOnce()

    expect(run.results.map((r) => r.status)).toEqual(['synced', 'synced'])
    // Local date, not UTC — 2026-08-09 14:30 local must not roll to the 10th.
    expect(apps.a.sync).toHaveBeenCalledWith('2026-08-09')
    expect(apps.b.sync).toHaveBeenCalledWith('2026-08-09')
  })

  it('skips a disconnected account without calling sync', async () => {
    const lapsed = stubApp({ getStatus: vi.fn(() => ({ connected: false })) })
    const { scheduler } = build({ a: lapsed })

    const run = await scheduler.runOnce()

    expect(run.results[0]).toMatchObject({ id: 'a', status: 'disconnected' })
    expect(lapsed.sync).not.toHaveBeenCalled()
  })

  it("does not let one account's failure stop the others", async () => {
    const failing = stubApp({ sync: vi.fn(async () => { throw new Error('token expired') }) })
    const healthy = stubApp()
    const { scheduler } = build({ a: failing, b: healthy })

    const run = await scheduler.runOnce()

    expect(run.results).toMatchObject([
      { id: 'a', status: 'failed', message: 'token expired' },
      { id: 'b', status: 'synced' },
    ])
    expect(healthy.sync).toHaveBeenCalledTimes(1)
  })

  it('survives a registry that refuses to build an app', async () => {
    const healthy = stubApp()
    const { scheduler } = build({ a: healthy }, {
      registry: {
        forAccount: vi.fn((account: any) => {
          if (account.id === 'gone') throw new Error('This account registry has been disposed.')
          return healthy
        }),
      },
      accounts: { list: () => [{ id: 'gone' }, { id: 'a' }] },
    })

    const run = await scheduler.runOnce()

    expect(run.results).toMatchObject([{ id: 'gone', status: 'unavailable' }, { id: 'a', status: 'synced' }])
  })

  it('survives an unreadable accounts index', async () => {
    const { scheduler, log } = build({}, {
      accounts: { list: () => { throw new Error('master.key is unreadable') } },
    })

    await expect(scheduler.runOnce()).resolves.toMatchObject({ skipped: false, results: [] })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('master.key is unreadable'))
  })

  it('does not stack a second walk on top of a slow one', async () => {
    let release: () => void = () => {}
    const slow = stubApp({ sync: vi.fn(() => new Promise<void>((resolve) => { release = () => resolve() })) })
    const { scheduler } = build({ a: slow })

    const first = scheduler.runOnce()
    const second = await scheduler.runOnce()

    expect(second).toMatchObject({ skipped: true, results: [] })
    expect(slow.sync).toHaveBeenCalledTimes(1)

    release()
    await first

    // The guard releases, so a later tick works normally. Swap in a settling
    // sync first — reusing the blocked one would hang this call too.
    slow.sync.mockImplementation(async () => ({ date: '2026-08-09' }))
    expect(await scheduler.runOnce()).toMatchObject({ skipped: false })
    expect(slow.sync).toHaveBeenCalledTimes(2)
  })

  it('reports a repeated failure once rather than every tick', async () => {
    const failing = stubApp({ sync: vi.fn(async () => { throw new Error('invalid_grant') }) })
    const { scheduler, log } = build({ a: failing })

    await scheduler.runOnce()
    await scheduler.runOnce()
    await scheduler.runOnce()

    expect(failing.sync).toHaveBeenCalledTimes(3)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('invalid_grant'))
  })

  it('reports again when the failure changes, and after a recovery', async () => {
    const messages = ['invalid_grant', 'invalid_grant', 'network down']
    let call = 0
    const flaky = stubApp({
      sync: vi.fn(async () => {
        const message = messages[call++]
        if (message) throw new Error(message)
      }),
    })
    const { scheduler, log } = build({ a: flaky })

    await scheduler.runOnce()
    await scheduler.runOnce()
    await scheduler.runOnce()
    await scheduler.runOnce()
    await scheduler.runOnce()

    expect(log.warn.mock.calls.map((c: any[]) => String(c[0]))).toEqual([
      expect.stringContaining('invalid_grant'),
      expect.stringContaining('network down'),
    ])
    // The fourth call recovered and the fifth failed again — a recovery must
    // clear the memo so the next failure is reported rather than swallowed.
    expect(flaky.sync).toHaveBeenCalledTimes(5)
  })

  it('re-reads the accounts index each tick so a new sign-in is picked up', async () => {
    const a = stubApp()
    const b = stubApp()
    const apps: Record<string, any> = { a }
    let list = [{ id: 'a' }]
    const { scheduler } = build({}, {
      accounts: { list: () => list },
      registry: { forAccount: (account: any) => apps[account.id] },
    })

    await scheduler.runOnce()
    expect(a.sync).toHaveBeenCalledTimes(1)

    apps.b = b
    list = [{ id: 'a' }, { id: 'b' }]
    await scheduler.runOnce()

    expect(b.sync).toHaveBeenCalledTimes(1)
  })

  it('runs on the interval and stops when told', async () => {
    vi.useFakeTimers()
    const app = stubApp()
    const { scheduler } = build({ a: app }, { intervalMs: 600_000 })
    schedulers.push(scheduler)

    scheduler.start({ immediate: false })
    expect(app.sync).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(600_000)
    expect(app.sync).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(600_000)
    expect(app.sync).toHaveBeenCalledTimes(2)

    scheduler.stop()
    await vi.advanceTimersByTimeAsync(600_000 * 3)
    expect(app.sync).toHaveBeenCalledTimes(2)
  })

  it('catches up immediately by default and starts idempotently', async () => {
    vi.useFakeTimers()
    const app = stubApp()
    const { scheduler } = build({ a: app })
    schedulers.push(scheduler)

    scheduler.start()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(app.sync).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS)
    // Two ticks would mean start() installed two intervals.
    expect(app.sync).toHaveBeenCalledTimes(2)
  })

  it('does not hold the process open', () => {
    vi.useFakeTimers()
    const { scheduler } = build({})
    schedulers.push(scheduler)
    const unref = vi.fn()
    vi.spyOn(globalThis, 'setInterval').mockReturnValueOnce({ unref } as any)

    scheduler.start({ immediate: false })

    expect(unref).toHaveBeenCalledTimes(1)
  })

  it('refreshes one account on demand without throwing', async () => {
    const app = stubApp()
    const { scheduler } = build({ a: app })

    expect(await scheduler.syncAccountNow({ id: 'a' })).toMatchObject({ status: 'synced' })
    expect(app.sync).toHaveBeenCalledWith('2026-08-09')

    expect(await scheduler.syncAccountNow(null)).toMatchObject({ status: 'unavailable' })
  })

  it('never rejects on demand, even when the sync fails', async () => {
    const failing = stubApp({ sync: vi.fn(async () => { throw new Error('token expired') }) })
    const { scheduler } = build({ a: failing })

    await expect(scheduler.syncAccountNow({ id: 'a' })).resolves.toMatchObject({
      status: 'failed',
      message: 'token expired',
    })
  })
})
