'use strict'

const { localIsoDate } = require('./sync.cjs')

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000

/**
 * One timer for the whole instance, not one per account.
 *
 * Every tick walks the accounts index and syncs each connected account's
 * current day. A per-account loop would multiply timers by sign-ins and leave
 * orphans behind whenever an account stopped being used; a single job has one
 * lifecycle to reason about and reads the account list fresh each time, so an
 * account that signs in between ticks is picked up without any wiring.
 *
 * Accounts are synced one at a time on purpose. `core/providers/google-health.cjs`
 * paces its own requests through a module-level cursor, so running several
 * accounts concurrently would interleave against a rate limiter that cannot see
 * them and would burst against Google on behalf of every account at once.
 */
function createSyncScheduler(options = {}) {
  const { accounts, registry } = options
  if (!accounts) throw new Error('createSyncScheduler requires an accounts index.')
  if (!registry) throw new Error('createSyncScheduler requires an account registry.')

  const intervalMs = Number.isSafeInteger(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : DEFAULT_INTERVAL_MS
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const log = options.log || console

  let timer = null
  let inFlight = false
  // A refresh token expires after seven days of OAuth testing mode, so the same
  // failure would otherwise be logged every ten minutes forever. Report a
  // message once per account and stay quiet until it changes.
  const reported = new Map()

  function note(id, message) {
    if (reported.get(id) === message) return
    reported.set(id, message)
    if (message) log.warn(`Scheduled sync skipped for ${id}: ${message}`)
  }

  async function syncAccount(account) {
    let app
    try {
      // Throws once the registry has been disposed, which is a shutdown racing
      // a tick rather than an account problem — never a reason to stop the run.
      app = registry.forAccount(account)
    } catch (error) {
      return { id: account.id, status: 'unavailable', message: errorMessage(error) }
    }

    let status
    try {
      status = app.getStatus()
    } catch (error) {
      note(account.id, errorMessage(error))
      return { id: account.id, status: 'unavailable', message: errorMessage(error) }
    }

    // Disconnected accounts are the steady state once a testing-mode refresh
    // token lapses. Attempting the sync would fail every tick and teach the
    // account nothing it does not already know.
    if (!status.connected) {
      note(account.id, 'not connected')
      return { id: account.id, status: 'disconnected' }
    }

    try {
      await app.sync(localIsoDate(now()))
      note(account.id, null)
      reported.delete(account.id)
      return { id: account.id, status: 'synced' }
    } catch (error) {
      // A user-triggered sync already running is benign — that account is being
      // refreshed anyway, just not by us.
      const message = errorMessage(error)
      note(account.id, message)
      return { id: account.id, status: 'failed', message }
    }
  }

  async function runOnce() {
    // A tick that overruns its interval must not stack another walk on top of
    // itself; skipping is correct because the next tick does the same work.
    if (inFlight) return { skipped: true, results: [] }
    inFlight = true
    try {
      let list
      try {
        list = accounts.list()
      } catch (error) {
        log.warn(`Scheduled sync could not read the accounts index: ${errorMessage(error)}`)
        return { skipped: false, results: [] }
      }

      const results = []
      for (const account of list) {
        results.push(await syncAccount(account))
      }
      return { skipped: false, results }
    } finally {
      inFlight = false
    }
  }

  return {
    intervalMs,
    runOnce,

    /** Idempotent. `immediate` catches up an instance that was restarted. */
    start({ immediate = true } = {}) {
      if (timer) return
      timer = setInterval(() => { void runOnce() }, intervalMs)
      // The scheduler must never be the reason the process stays alive.
      if (typeof timer.unref === 'function') timer.unref()
      if (immediate) void runOnce()
    },

    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },

    /**
     * Refresh one account now, outside the tick. Used when somebody signs back
     * in: their data may be a week stale and waiting up to ten minutes for the
     * next tick would show them the staleness first.
     *
     * Never rejects — the caller is an OAuth callback whose response must not
     * depend on Google being reachable a second time.
     */
    async syncAccountNow(account) {
      if (!account) return { status: 'unavailable', message: 'no account' }
      return syncAccount(account)
    },
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

module.exports = { createSyncScheduler, DEFAULT_INTERVAL_MS }
