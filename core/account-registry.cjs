'use strict'

function assertText(value, what) {
  if (typeof value !== 'string' || value === '') throw new Error(`An account requires a non-empty ${what}.`)
  return value
}

/**
 * One app instance per signed-in account, created lazily and cached.
 *
 * The root secret store is injected into every app so `master.key` stays
 * instance-wide. Left to itself `createApp` calls `createSecretStore({ dir })`
 * and mints a key per data directory; an account directory holding its own key
 * could not read the `account.json` the accounts module encrypted with the
 * root key, and every account would carry a separate key to protect.
 */
function createAccountRegistry(options = {}) {
  const { dataDir, secrets, createApp, appOptions = {} } = options
  if (!dataDir) throw new Error('createAccountRegistry requires a dataDir.')
  if (!secrets) throw new Error('createAccountRegistry requires a secret store.')
  if (typeof createApp !== 'function') throw new Error('createAccountRegistry requires a createApp function.')

  const apps = new Map()
  let disposed = false

  return {
    forAccount(account) {
      // The cache key is the account id, so it has to be a real one. An absent
      // id would key every id-less account to `undefined`, and the second
      // caller would be handed the first caller's app — one person's health
      // data served under another person's sign-in. Reject rather than coerce.
      if (account === null || typeof account !== 'object') throw new Error('forAccount requires an account.')
      const id = assertText(account.id, 'id')
      const dir = assertText(account.dir, 'directory')

      // After disposal has begun the snapshot below has already been taken, so
      // a fresh app would never be disposed — it would hold its handles open
      // past shutdown. Refuse instead.
      if (disposed) throw new Error('This account registry has been disposed.')

      const cached = apps.get(id)
      if (cached) {
        // One id must name one directory. If a caller presents the same id with
        // a different directory the account objects disagree about where this
        // account lives, and serving the cached app would read and write the
        // other directory without saying so.
        if (cached.dir !== dir) {
          throw new Error(`Account ${id} is already bound to ${cached.dir}; refusing to rebind it to ${dir}.`)
        }
        return cached.app
      }

      // `appOptions` first: the caller may not override the account directory
      // or the shared secret store.
      const app = createApp({ ...appOptions, dataDir: dir, secrets })
      apps.set(id, { app, dir })
      return app
    },

    // One failing dispose must not strand the others, so every dispose is
    // started before any is awaited and each failure is contained.
    async disposeAll() {
      disposed = true
      const cached = [...apps.values()]
      apps.clear()
      await Promise.all(cached.map(async ({ app }) => {
        try {
          await app.dispose()
        } catch (error) {
          console.warn('Disposing an account app failed.', error)
        }
      }))
    },
  }
}

module.exports = { createAccountRegistry }
