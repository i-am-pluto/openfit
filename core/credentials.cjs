'use strict'

const { DEFAULT_PROVIDER, isProvider, providerId } = require('./providers/index.cjs')

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:42813/oauth/callback'
const OAUTH_IDENTITY_KEYS = ['provider', 'clientId', 'clientSecret', 'redirectUri']

function emptyCredentials() {
  return {
    config: {
      provider: DEFAULT_PROVIDER,
      clientId: '',
      clientSecret: '',
      redirectUri: DEFAULT_REDIRECT_URI,
      agentId: null,
    },
    token: null,
    lastSyncAt: null,
  }
}

// Google only accepts an http loopback redirect or an https origin. A plain
// http tailnet host is rejected at the console, so it is rejected here too.
function validateRedirectUri(value, publicOrigin) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('The callback URL is invalid.')
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error('The callback URL must not contain credentials or a fragment.')
  }
  const isLoopback = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && Boolean(parsed.port)
  const isPublic = Boolean(publicOrigin) && parsed.origin === publicOrigin
  if (!isLoopback && !isPublic) {
    const suffix = publicOrigin ? ` or an ${publicOrigin} callback` : ''
    throw new Error(`Use an http://127.0.0.1 loopback callback with a fixed port${suffix}.`)
  }
  return parsed.toString()
}

function createCredentialStore({ secrets, credentialFile, cacheFile, publicOrigin = null }) {
  if (!secrets) throw new Error('createCredentialStore requires a secret store.')

  function read() {
    const stored = secrets.read(credentialFile, null)
    if (!stored) return emptyCredentials()
    return { ...emptyCredentials(), ...stored, config: { ...emptyCredentials().config, ...stored.config } }
  }

  function save(credentials) {
    secrets.write(credentialFile, credentials)
  }

  function validateConfig(input, previous) {
    const provider = isProvider(input.provider) ? input.provider : DEFAULT_PROVIDER
    const clientId = String(input.clientId || '').trim()
    const redirectUri = validateRedirectUri(String(input.redirectUri || DEFAULT_REDIRECT_URI).trim(), publicOrigin)
    const sameProvider = previous?.provider === provider
    const clientSecret = String(input.clientSecret || (sameProvider ? previous?.clientSecret : '') || '').trim()
    if (!clientId) throw new Error('Enter the OAuth Client ID.')
    if (provider === 'google-health' && !clientSecret) {
      throw new Error('Google Health requires the Cloud project Client Secret.')
    }
    return { provider, clientId, clientSecret, redirectUri, agentId: previous?.agentId ?? null }
  }

  function oauthIdentityChanged(previous, next) {
    return OAUTH_IDENTITY_KEYS.some((key) => String(previous?.[key] || '') !== String(next?.[key] || ''))
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
    validateConfig,
    oauthIdentityChanged,
    publicStatus,
    clearCache: () => secrets.remove(cacheFile),
    readCache: () => secrets.read(cacheFile, null),
    writeCache: (value) => secrets.write(cacheFile, value),
    forget: () => secrets.remove(credentialFile),
  }
}

module.exports = { createCredentialStore, validateRedirectUri, DEFAULT_REDIRECT_URI, emptyCredentials }
