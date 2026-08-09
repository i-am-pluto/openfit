'use strict'

const { EventEmitter } = require('node:events')
const path = require('node:path')

const healthCache = require('./health-cache.cjs')
const { createAgentRegistry } = require('./agents/index.cjs')
const { createCredentialStore } = require('./credentials.cjs')
const { createSecretStore } = require('./secrets.cjs')
const { createSyncer, localIsoDate, validSyncDate } = require('./sync.cjs')
const { MAX_MESSAGE_CHARS, MAX_HEALTH_CONTEXT_CHARS, sanitizeMessage } = require('./agents/agent-common.cjs')

const REQUEST_ID = /^[a-zA-Z0-9_-]{8,80}$/

// Health scopes come from the same Google consent as sign-in, so reconnecting
// the provider means signing in again with the consent screen forced. There is
// no separate provider authorization to start from inside the app.
const REAUTHORIZE_URL = '/auth/login?prompt=consent'

function normalizePublicOrigin(value) {
  if (!value) return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`OPENFIT_PUBLIC_ORIGIN is not a valid URL: ${value}`)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('OPENFIT_PUBLIC_ORIGIN must be a plain https origin, for example https://box.tail-abc.ts.net')
  }
  return parsed.origin
}

/**
 * Builds every OpenFit capability from a data directory. Knows nothing about
 * Electron or HTTP: the desktop shell and the server are both thin hosts on top
 * of the object this returns.
 */
function createApp(options = {}) {
  const dataDir = options.dataDir
  if (!dataDir) throw new Error('createApp requires a dataDir.')
  const env = options.env || process.env
  const publicOrigin = normalizePublicOrigin(options.publicOrigin ?? env.OPENFIT_PUBLIC_ORIGIN ?? null)

  const events = new EventEmitter()
  events.setMaxListeners(0)

  const secrets = options.secrets || createSecretStore({ dir: dataDir, safeStorage: options.safeStorage })
  const credentials = createCredentialStore({
    secrets,
    credentialFile: path.join(dataDir, 'credentials.secure.json'),
    cacheFile: path.join(dataDir, 'health-cache.secure.json'),
    publicOrigin,
    defaults: options.oauthDefaults || {},
  })

  const agents = createAgentRegistry({
    env,
    createOptions: { cwd: dataDir, clientVersion: options.clientVersion || '1.0.0' },
    onSelectionChange: (agentId) => {
      const stored = credentials.read()
      if (stored.config.agentId === agentId) return
      credentials.save({ ...stored, config: { ...stored.config, agentId } })
    },
  })
  agents.prefer(credentials.read().config.agentId)

  const syncer = createSyncer({
    credentials,
    onProgress: (progress) => events.emit('sync-progress', progress),
  })

  let syncInFlight = null
  let assistantRequestId = null

  function emitAssistant(event) {
    events.emit('assistant', event)
  }

  const assistant = {
    listAgents: () => agents.list(),
    getStatus: () => agents.getStatus(),

    selectAgent(agentId) {
      if (assistantRequestId) throw new Error('Wait for the current assistant response to finish.')
      const status = agents.select(String(agentId))
      const stored = credentials.read()
      credentials.save({ ...stored, config: { ...stored.config, agentId: status.id } })
      return { status, agents: agents.list() }
    },

    startTurn(input) {
      if (!input || !REQUEST_ID.test(String(input.requestId || ''))) throw new Error('Invalid assistant request.')
      const requestId = String(input.requestId)
      if (assistantRequestId && assistantRequestId !== requestId) {
        throw new Error('Wait for the current assistant response to finish.')
      }
      const message = String(input.message || '').trim()
      const healthContext = String(input.healthContext || '').trim()
      if (!message || message.length > MAX_MESSAGE_CHARS) throw new Error('The assistant message is empty or too long.')
      if (!healthContext || healthContext.length > MAX_HEALTH_CONTEXT_CHARS) throw new Error('The health context is empty or too large.')

      assistantRequestId = requestId
      void agents.startTurn({
        text: message,
        healthContext,
        onDelta: (delta) => {
          if (assistantRequestId === requestId) emitAssistant({ requestId, type: 'delta', delta })
        },
      }).then((result) => {
        if (assistantRequestId !== requestId) return
        assistantRequestId = null
        emitAssistant({ requestId, type: 'complete', text: result.text })
      }).catch((error) => {
        if (assistantRequestId !== requestId) return
        assistantRequestId = null
        if (error?.name === 'AbortError' || error?.code === 'CODEX_TURN_CANCELLED' || error?.code === 'CLAUDE_TURN_CANCELLED') {
          emitAssistant({ requestId, type: 'cancelled' })
        } else {
          emitAssistant({ requestId, type: 'error', message: sanitizeMessage(error?.message) })
        }
      })
      return { requestId }
    },

    async cancel(requestId) {
      if (!REQUEST_ID.test(String(requestId || '')) || assistantRequestId !== requestId) return
      await agents.cancelTurn()
    },

    async reset() {
      assistantRequestId = null
      await agents.reset()
    },
  }

  return {
    events,
    publicOrigin,
    dataDir,

    // A refresh token expires after seven days while the Cloud project is in
    // testing mode, so "signed in but disconnected" is the normal steady state
    // and every status has to say how to get out of it.
    getStatus: () => ({
      ...credentials.publicStatus(),
      assistant: agents.getStatus(),
      reauthorizeUrl: REAUTHORIZE_URL,
    }),

    // The renderer calls this with fetch, which would follow a 302 and load
    // Google's consent page as an XHR. Return the URL and let the browser
    // navigate.
    connect() {
      if (syncInFlight) throw new Error('Wait for the sync to finish before reconnecting the account.')
      return { reauthorizeUrl: REAUTHORIZE_URL }
    },

    /**
     * Stores the token the sign-in produced.
     *
     * Sign-in and the health scopes come from one Google authorization, so the
     * token arrives from the login route rather than from a callback this app
     * owns. Two things it deliberately does not do:
     *
     * - It does not replace the stored token wholesale. Google issues a refresh
     *   token only alongside the consent screen, so an ordinary sign-in returns
     *   an access token alone; overwriting would drop the refresh token and
     *   disconnect an account that was working a second ago.
     * - It does not clear the health cache. The cache lives in this account's
     *   own directory and belongs to the same subject that just signed in, so
     *   dropping it would empty the dashboard on every sign-in.
     */
    async adoptToken(token) {
      if (token === null || typeof token !== 'object' || Array.isArray(token)) {
        throw new Error('adoptToken requires a token payload.')
      }
      const stored = credentials.read()
      // The ID token has done its job at the callback and is a bearer credential
      // with no further use here; it is not written to disk.
      const { id_token: _idToken, ...received } = token
      const merged = { ...stored.token, ...received }
      if (!merged.refresh_token && stored.token?.refresh_token) merged.refresh_token = stored.token.refresh_token
      credentials.save({ ...stored, token: merged })
      const status = credentials.publicStatus()
      // Other browsers already signed into this account are holding an SSE
      // stream open; this is what tells them the connection came back. The
      // payload is the `{ ok }` shape src/App.tsx has always handled — a status
      // object here reads as `ok: false` and raises "Authorization failed."
      events.emit('auth-complete', { ok: true })
      return status
    },

    async disconnect() {
      if (syncInFlight) throw new Error('Wait for the sync to finish before disconnecting the account.')
      const stored = credentials.read()
      try {
        const { providerFor } = require('./providers/index.cjs')
        await providerFor(stored).revokeToken(stored.token, stored.config)
      } catch (error) {
        console.warn('Remote revocation failed; local credentials will still be deleted.', error?.message)
      }
      try {
        credentials.save({ ...stored, token: null, lastSyncAt: null })
      } catch {
        credentials.forget()
      }
      credentials.clearCache()
      return credentials.publicStatus()
    },

    async sync(date) {
      const requested = String(date)
      if (!validSyncDate(requested)) throw new Error('Invalid sync date.')
      if (syncInFlight) throw new Error('A sync is already in progress.')
      syncInFlight = syncer(requested)
      try {
        return await syncInFlight
      } finally {
        syncInFlight = null
      }
    },

    getCachedData: () => healthCache.latestDay(credentials.readCache()),
    getCachedArchive: () => healthCache.normalizeArchive(credentials.readCache()),

    exportArchive() {
      const archive = healthCache.normalizeArchive(credentials.readCache())
      if (!Object.keys(archive.days).length) throw new Error('There is no real data to export yet.')
      return {
        filename: `openfit-archive-${archive.lastDate || 'health'}.json`,
        json: JSON.stringify(archive, null, 2),
      }
    },

    assistant,

    async dispose() {
      await agents.dispose()
      events.removeAllListeners()
    },
  }
}

module.exports = { createApp, normalizePublicOrigin, localIsoDate }
