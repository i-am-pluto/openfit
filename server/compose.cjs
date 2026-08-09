'use strict'

const fs = require('node:fs')

const { createAccountRegistry } = require('../core/account-registry.cjs')
const { createAccounts } = require('../core/accounts.cjs')
const { createApp, normalizePublicOrigin } = require('../core/app.cjs')
const { validateIdToken } = require('../core/identity.cjs')
const { buildGoogleAuthUrl, exchangeGoogleCode } = require('../core/providers/google-health.cjs')
const { createSecretStore } = require('../core/secrets.cjs')
const { createServer } = require('./index.cjs')
const { createSessions } = require('./session.cjs')

// Google is told one path and this is it. Building it in one place is what stops
// the server host and the desktop host from registering two different callbacks
// against the same OAuth client.
const CALLBACK_PATH = '/auth/callback'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])

function requireText(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`composeBackend requires a non-empty ${what}.`)
  }
  return value.trim()
}

// The origin a host is reachable at when it has no public origin. Checked rather
// than trusted: this string becomes the redirect URI Google is asked to send an
// authorization code to, and the cookies that carry the session are set without
// `Secure` precisely because it is plain-http loopback. A non-loopback value here
// would put an unprotected session cookie on a routable origin.
function assertLoopbackOrigin(value) {
  const text = requireText(value, 'local origin')
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error(`composeBackend requires a valid local origin, not ${text}.`)
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`composeBackend requires a bare http loopback origin, for example http://127.0.0.1:7788, not ${text}.`)
  }
  return parsed.origin
}

/**
 * Builds one OpenFit backend: the secret store, the accounts index, the
 * per-account app registry, the session store, and the HTTP server that ties
 * them together with the Google sign-in routes.
 *
 * Both hosts go through here. `server/bin.cjs` runs it behind a terminal banner
 * and `electron/main.cjs` runs it inside the desktop process, and the pieces
 * below are the ones that have to agree with each other — the `Secure` flag on
 * two cookies, the OAuth client that signs a person in versus the one that
 * refreshes their token, the single master key every account reads. Composing
 * them twice is how they drifted apart the first time.
 */
function composeBackend(options = {}) {
  const {
    dataDir,
    staticRoot,
    env = process.env,
    clientVersion,
    clientId,
    clientSecret,
    publicOrigin = null,
    localOrigin,
    token = null,
    safeStorage = null,
    afterAuthorized = null,
  } = options

  if (!dataDir) throw new Error('composeBackend requires a data directory.')

  // Re-validated even though `server/bin.cjs` validates it early to exit before
  // touching the disk: this is the value `Secure` is derived from, and a caller
  // that skipped the check must not be able to hand in a plain-http origin.
  const resolvedPublicOrigin = normalizePublicOrigin(publicOrigin)
  const origin = resolvedPublicOrigin || assertLoopbackOrigin(localOrigin)

  // Frozen because one object is both the login routes' identity and the
  // per-account app's oauthDefaults: the client that signs a person in and the
  // client that refreshes their token must not be able to drift apart.
  const identity = Object.freeze({
    clientId: requireText(clientId, 'Google client id'),
    clientSecret: requireText(clientSecret, 'Google client secret'),
    redirectUri: `${origin}${CALLBACK_PATH}`,
  })

  // `Secure` has one source, and it is the scheme this host is actually
  // reachable on. Derived here rather than accepted as a parameter, so no host
  // can mark cookies Secure on an origin no browser will send them back to, or
  // leave them unmarked on one that is exposed. registerLoginRoutes checks the
  // session store against the login routes at wiring time as well.
  const secure = Boolean(resolvedPublicOrigin)

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  // One secret store for the instance. The accounts index and every account's
  // app read it, so `master.key` stays instance-wide instead of one key per
  // account directory, and the session signing key is derived from those bytes.
  //
  // `safeStorage` is the desktop host's OS keychain and is absent on the server.
  // core/secrets.cjs decides whether it is trustworthy; the Linux `basic_text`
  // backend is rejected there because it stores plaintext behind an
  // encryption-shaped API.
  const secrets = createSecretStore({ dir: dataDir, safeStorage })
  const accounts = createAccounts({ dataDir, secrets })
  const registry = createAccountRegistry({
    dataDir,
    secrets,
    createApp,
    appOptions: {
      env,
      clientVersion,
      publicOrigin: resolvedPublicOrigin,
      // Without this the OAuth client falls back to whatever a previous release
      // wrote into the account's credentials file, and .env is ignored in
      // silence: the sign-in works and the first token refresh does not.
      oauthDefaults: identity,
    },
  })

  const sessions = createSessions({ masterKey: secrets.masterKey(), secure })

  const { server, auth } = createServer({
    staticRoot,
    dataDir,
    token,
    sessions,
    accounts,
    registry,
    loginDeps: {
      sessions,
      accounts,
      identity,
      secure,
      validateIdToken,
      authorizationUrl: ({ state, nonce, challenge, prompt }) => buildGoogleAuthUrl({
        clientId: identity.clientId,
        redirectUri: identity.redirectUri,
        state,
        nonce,
        challenge,
        prompt,
      }),
      exchange: (code, verifier) => exchangeGoogleCode({ ...identity, code, verifier }),
      // The app for the account that just signed in, created on demand. This is
      // request handling — the callback is a request — so the registry latch is
      // still open.
      //
      // `afterAuthorized` runs once the token is stored and is the desktop
      // host's hook for its own cookie jar. It is awaited, so a host that lets
      // it throw fails the callback after the token was already written; the
      // desktop host contains its own errors for exactly that reason.
      //
      // `context` carries the flow id from the pending cookie. It is passed
      // through rather than interpreted here: only the host that minted one can
      // tell whether the flow that just completed is the one it started, and a
      // host that gets `null` must treat the result as somebody else's.
      onAuthorized: async (account, tokens, context) => {
        const status = await registry.forAccount(account).adoptToken(tokens)
        if (afterAuthorized) await afterAuthorized(account, context)
        return status
      },
    },
  })

  return {
    server,
    auth,
    secrets,
    accounts,
    registry,
    sessions,
    identity,
    secure,
    origin,
    publicOrigin: resolvedPublicOrigin,
  }
}

module.exports = { composeBackend, assertLoopbackOrigin, CALLBACK_PATH }
