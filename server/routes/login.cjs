'use strict'

const crypto = require('node:crypto')

const { parseCookies, sameToken } = require('../auth.cjs')
const { securityHeaders } = require('../static.cjs')
const { loginPage } = require('../login-page.cjs')

const PENDING_COOKIE = 'openfit_pending'
const PENDING_MAX_AGE_SECONDS = 600
const PENDING_PATH = '/auth'

// The pending cookie and the session cookie are signed with the same key and
// share a format, so the payload has to say which one it is. Without the tag a
// valid session cookie pasted into `openfit_pending` verifies happily, and a
// pending cookie pasted into `openfit_session` does the same in reverse.
const PENDING_KIND = 'pending'

// Only what the flow actually needs. `prompt` arrives in the query string, so
// echoing it verbatim would let a crafted link pick Google's behaviour for the
// victim — `prompt=none` most of all, which suppresses the consent screen.
const PROMPTS = new Set(['consent', 'select_account'])

// An opaque handle a host may attach to one sign-in so it can recognise *that*
// sign-in when the callback completes. The desktop host mints one per click and
// compares it in `onAuthorized`; without it, "a sign-in was started here
// recently" is the only thing a host can check, and any other flow finishing
// first satisfies that.
//
// It is signed into the pending cookie rather than kept in memory, so the answer
// travels with the flow. It is never a secret this route enforces anything with:
// the caller supplied it, so the caller is the only one who can recognise it.
const SIGN_IN_FLOW_PARAM = 'flow'

// Attacker-reachable, like everything else in this query string. Bounded and
// restricted to an unreserved alphabet so it cannot bloat the cookie or carry
// anything a consumer might interpret; anything else is dropped, which fails
// closed because a host that finds no flow id must not adopt the result.
const FLOW_ID = /^[A-Za-z0-9_-]{16,64}$/

function requestedFlowId(url) {
  const value = url.searchParams.get(SIGN_IN_FLOW_PARAM)
  return typeof value === 'string' && FLOW_ID.test(value) ? value : undefined
}

function base64Url(buffer) {
  return buffer.toString('base64url')
}

function usablePending(payload) {
  return payload !== null
    && typeof payload === 'object'
    && payload.kind === PENDING_KIND
    && typeof payload.state === 'string'
    && payload.state !== ''
    && typeof payload.nonce === 'string'
    && payload.nonce !== ''
    && typeof payload.verifier === 'string'
    && payload.verifier !== ''
    // Optional, because only the desktop host sets one — but never anything but
    // a string. A cookie carrying, say, `flowId: true` would otherwise reach a
    // consumer's comparison as a non-string and could make it fail open.
    && (payload.flowId === undefined || (typeof payload.flowId === 'string' && payload.flowId !== ''))
}

function registerLoginRoutes({ addPublic, deps }) {
  const { sessions, accounts, identity, secure, exchange, authorizationUrl, validateIdToken, onAuthorized } = deps

  // `Secure` has exactly one source. Deriving it here from something else — the
  // scheme of the redirect URI, say — gives the two cookies two mechanisms that
  // can disagree, so the flag is required and checked against the session store
  // at wiring time rather than at the first request.
  if (typeof secure !== 'boolean') throw new Error('registerLoginRoutes requires an explicit boolean `secure`.')
  const probe = sessions.cookieString({ name: PENDING_COOKIE, maxAge: 0, path: PENDING_PATH })
  if (probe.includes('Secure') !== secure) {
    throw new Error('The session store and the login routes disagree about the Secure cookie attribute.')
  }

  const pendingCookie = (value, maxAge) =>
    sessions.cookieString({ name: PENDING_COOKIE, value, maxAge, path: PENDING_PATH })
  const clearPending = () => pendingCookie('', 0)

  addPublic('GET', '/auth/login', async (request, response, { url }) => {
    const state = base64Url(crypto.randomBytes(24))
    const nonce = base64Url(crypto.randomBytes(24))
    const verifier = base64Url(crypto.randomBytes(48))
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())

    const requested = url.searchParams.get('prompt')
    const prompt = PROMPTS.has(requested) ? requested : undefined
    const flowId = requestedFlowId(url)

    // The pending values are signed into a short-lived cookie rather than held
    // in memory, so a restart mid-sign-in does not strand the flow. `flowId` is
    // omitted entirely when absent, so a pending cookie either names one flow or
    // names none.
    const pending = sessions.sign({ kind: PENDING_KIND, state, nonce, verifier, ...(flowId ? { flowId } : {}) })

    response.writeHead(302, {
      // `nonce` is not optional: core/identity.cjs rejects an ID token whose
      // nonce claim is missing or unexpected, so the authorization request must
      // carry it or Google returns a token that cannot pass validation.
      location: authorizationUrl({ state, nonce, challenge, prompt }),
      'set-cookie': pendingCookie(pending, PENDING_MAX_AGE_SECONDS),
    })
    response.end()
  })

  addPublic('GET', '/auth/callback', async (request, response, { url }) => {
    // Every exit from here clears the pending cookie. A state and verifier that
    // have been through the callback once, successfully or not, must not stay in
    // the browser to be replayed for the rest of the ten minutes.
    const fail = (status, message) => {
      securityHeaders(response)
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': clearPending(),
      })
      response.end(loginPage(message))
    }

    // `maxAgeSeconds` is passed explicitly: the cookie's own Max-Age is only a
    // hint to the browser, and the default here would be the 30-day session
    // lifetime, which would leave a captured pending cookie replayable for a
    // month rather than ten minutes.
    const pending = sessions.verify(parseCookies(request.headers?.cookie)[PENDING_COOKIE], {
      maxAgeSeconds: PENDING_MAX_AGE_SECONDS,
    })
    if (!usablePending(pending)) {
      fail(400, 'Sign-in took too long. Start again.')
      return
    }

    // Constant time, and false whenever either side is absent: an absent `state`
    // query parameter is `null`, and `null === undefined` would otherwise be one
    // careless refactor away from matching an absent cookie field.
    if (!sameToken(url.searchParams.get('state'), pending.state)) {
      fail(400, 'The sign-in security check failed. Start again.')
      return
    }

    // Only past the CSRF check does an attacker-supplied `code` become worth
    // looking at, and it still never reaches the exchange while an error is set.
    const oauthError = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (oauthError || !code) {
      // Google's `error` value is never rendered: it is attacker-influenceable
      // and there is nothing in it a person signing in needs to read.
      fail(400, oauthError === 'access_denied'
        ? 'Access was denied at the Google consent screen. Sign in again to continue.'
        : 'Google did not complete the sign-in. Start again.')
      return
    }

    let tokens
    try {
      tokens = await exchange(code, pending.verifier)
    } catch {
      // The token request carries the client secret and provider errors quote
      // the request that produced them, so nothing from this failure is shown.
      fail(502, 'Google sign-in could not be completed. Try again.')
      return
    }

    // Kept apart from the exchange so the "not verified" test below can only ever
    // match a message this repo wrote. Matched against a provider's error text it
    // would be a way to steer the response and put that text on the page.
    let account
    try {
      const claims = validateIdToken(tokens?.id_token, { clientId: identity.clientId, nonce: pending.nonce })
      account = accounts.resolve(claims)
    } catch (error) {
      const unverified = /not verified/i.test(error?.message || '')
      fail(unverified ? 403 : 401, unverified
        ? 'That Google account has no verified email address. Verify it with Google, then sign in again.'
        : 'Google sign-in could not be completed. Try again.')
      return
    }

    try {
      // The flow id comes from the pending cookie, never from the query string:
      // it has to be the one the browser was carrying when it left for Google,
      // or a caller could name someone else's flow at the callback.
      await onAuthorized(account, tokens, { flowId: pending.flowId ?? null })
    } catch {
      // No session is issued: a browser signed in against an account whose token
      // was never stored looks connected and can do nothing. Storage errors name
      // filesystem paths, so the message is a fixed one.
      fail(500, 'Your account could not be saved. Try again.')
      return
    }

    response.writeHead(302, {
      location: '/',
      'set-cookie': [
        sessions.cookie({ sub: account.sub, email: account.email, epoch: account.epoch }),
        clearPending(),
      ],
    })
    response.end()
  })

  addPublic('POST', '/auth/logout', async (request, response, context = {}) => {
    const { body } = context
    const session = sessions.verify(parseCookies(request.headers?.cookie)[sessions.cookieName])
    // A pending cookie verifies against the same key; it is not a session and
    // must not be able to nominate a subject whose epoch gets bumped.
    const subject = session && session.kind === undefined && typeof session.sub === 'string' && session.sub !== ''
      ? session.sub
      : null

    // Body only. server/index.cjs parses a JSON body for public POST routes as
    // well as guarded ones, so the query form is gone: a URL parameter is a
    // lasting second way to drive a state-changing control, reachable from a
    // link and recorded in history.
    const everywhere = body?.everywhere === true

    let revoked = false
    if (everywhere && subject) {
      try {
        accounts.bumpEpoch(subject)
        revoked = true
      } catch {
        // Already gone, or the record cannot be read. Clearing this browser's
        // cookie is still correct, and reporting `revoked: false` is honest.
      }
    }

    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': [sessions.clearCookie(), clearPending()],
    })
    response.end(JSON.stringify({ ok: true, revoked }))
  })
}

module.exports = { registerLoginRoutes, PENDING_COOKIE, PENDING_MAX_AGE_SECONDS, SIGN_IN_FLOW_PARAM, FLOW_ID }
