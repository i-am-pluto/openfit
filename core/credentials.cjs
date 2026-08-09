'use strict'

const { DEFAULT_PROVIDER, providerId } = require('./providers/index.cjs')

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:42813/oauth/callback'
const OAUTH_IDENTITY_KEYS = ['provider', 'clientId', 'clientSecret', 'redirectUri']

function emptyCredentials(defaults = {}) {
  return {
    config: {
      provider: DEFAULT_PROVIDER,
      clientId: defaults.clientId || '',
      clientSecret: defaults.clientSecret || '',
      redirectUri: defaults.redirectUri || DEFAULT_REDIRECT_URI,
      agentId: null,
    },
    token: null,
    lastSyncAt: null,
  }
}

// Only the identity keys the environment actually supplies. An absent variable
// must not blank out a stored value: the desktop host builds the app without
// any defaults at all, and reading '' over its config would strand it.
function configuredIdentity(defaults) {
  const identity = {}
  for (const key of OAUTH_IDENTITY_KEYS) {
    const value = String(defaults?.[key] || '').trim()
    if (value) identity[key] = value
  }
  return identity
}

function createCredentialStore({ secrets, credentialFile, cacheFile, publicOrigin = null, defaults = {} }) {
  if (!secrets) throw new Error('createCredentialStore requires a secret store.')

  const identity = configuredIdentity(defaults)

  function read() {
    const base = emptyCredentials(defaults)
    const stored = secrets.read(credentialFile, null)
    if (!stored) return base
    // The environment owns the OAuth identity, so it is applied *after* the
    // stored config rather than under it. An account configured through the
    // retired settings screen still has a clientId and secret on disk, and
    // letting those outrank .env would send token refreshes to a client the
    // operator has replaced — a silent, undebuggable failure.
    return { ...base, ...stored, config: { ...base.config, ...stored.config, ...identity } }
  }

  function save(credentials) {
    secrets.write(credentialFile, credentials)
  }

  function publicStatus() {
    const credentials = read()
    const config = credentials.config || {}
    const provider = providerId(config)
    const needsSecret = provider === 'google-health'
    const storage = secrets.describe()
    return {
      hasBackend: true,
      configured: Boolean(config.clientId && config.redirectUri && (!needsSecret || config.clientSecret)),
      connected: Boolean(credentials.token?.access_token || credentials.token?.refresh_token),
      clientId: config.clientId || '',
      redirectUri: config.redirectUri || DEFAULT_REDIRECT_URI,
      hasClientSecret: Boolean(config.clientSecret),
      storageEncrypted: storage.encrypted,
      storageBackend: storage.backend,
      lastSyncAt: credentials.lastSyncAt || null,
      provider,
      publicOrigin,
    }
  }

  return {
    read,
    save,
    publicStatus,
    clearCache: () => secrets.remove(cacheFile),
    readCache: () => secrets.read(cacheFile, null),
    writeCache: (value) => secrets.write(cacheFile, value),
    forget: () => secrets.remove(credentialFile),
  }
}

module.exports = { createCredentialStore, DEFAULT_REDIRECT_URI, emptyCredentials }
