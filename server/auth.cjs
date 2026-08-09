'use strict'

const nodeCrypto = require('node:crypto')
const nodeFs = require('node:fs')
const path = require('node:path')

const TOKEN_FILE = 'server-token'
const COOKIE_NAME = 'openfit_token'
const TOKEN_BYTES = 32
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

function loadOrCreateToken({ dir, fs, randomBytes }) {
  const file = path.join(dir, TOKEN_FILE)
  try {
    const token = fs.readFileSync(file, 'utf8').trim()
    if (token) return token
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  try {
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' })
    return token
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return fs.readFileSync(file, 'utf8').trim()
  }
}

function parseCookies(header) {
  const jar = {}
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return jar
}

function bearerFrom(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim())
  return match ? match[1].trim() : null
}

// Length-independent, constant-time comparison.
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = nodeCrypto.createHash('sha256').update(a).digest()
  const right = nodeCrypto.createHash('sha256').update(b).digest()
  return nodeCrypto.timingSafeEqual(left, right)
}

function createAuth(options = {}) {
  const fs = options.fs || nodeFs
  const randomBytes = options.randomBytes || nodeCrypto.randomBytes
  const token = options.token || loadOrCreateToken({ dir: options.dir, fs, randomBytes })

  return {
    token,
    cookieName: COOKIE_NAME,

    presentedToken(request) {
      const url = new URL(request.url, 'http://localhost')
      const fromQuery = url.searchParams.get('token')
      if (fromQuery) return fromQuery
      const fromHeader = bearerFrom(request.headers?.authorization)
      if (fromHeader) return fromHeader
      return parseCookies(request.headers?.cookie)[COOKIE_NAME] || null
    },

    isAuthorized(request) {
      return sameToken(this.presentedToken(request), token)
    },

    // Host-only; `Secure` is omitted because the tailnet URL is plain http unless
    // the operator fronts it with `tailscale serve`.
    setCookie(response) {
      response.setHeader('Set-Cookie', [
        `${COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
      ].join('; '))
    },
  }
}

/**
 * True only for a payload this server issued as a *session*.
 *
 * The pending sign-in cookie is signed with the same key and verifies happily,
 * so a verified payload is not yet a session. `kind` marks the pending one;
 * `sub` and `epoch` are required with their real types because everything
 * downstream keys an encrypted directory off `sub` and gates revocation on
 * `epoch`. Coercion here would fail open: `Number(undefined)` is NaN, and
 * `String(undefined)` matches an absent claim.
 */
function usableSession(payload) {
  return payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && payload.kind === undefined
    && typeof payload.sub === 'string'
    && payload.sub !== ''
    && Number.isSafeInteger(payload.epoch)
    && payload.epoch >= 1
}

function ambiguous(all, error) {
  return { error, status: 409, accounts: all.map((entry) => entry.email) }
}

/**
 * Resolves the account for a request.
 *
 * A session names its own account. A bearer token predates multi-account and
 * names none: it resolves to the sole account, and otherwise must say which
 * one. Silently choosing is how an automated caller reads the wrong person's
 * health data.
 *
 * Never returns an account without a reason to. Every branch either names one
 * exactly or refuses; there is no fall-through that picks a default.
 */
function resolveAccount({ session, accounts, header }) {
  if (session) {
    // A cookie that verifies but is not session-shaped is not a session. It
    // must not reach accounts.get(), which throws on a non-string subject.
    if (!usableSession(session)) return { error: 'Sign in to use OpenFit.', status: 401 }

    // Deliberately not wrapped: accounts.get() returns null only when no such
    // account exists and throws when a record exists but is unreadable or names
    // another subject. Catching that here would turn a tampering signal into an
    // ordinary signed-out response.
    const account = accounts.get(session.sub)
    if (!account) return { error: 'Unknown account.', status: 401 }

    // Strict inequality on values both sides validated as safe integers. This
    // is the whole of "log out everywhere": bumpEpoch moves the stored value
    // and every cookie carrying the old one stops here.
    if (account.epoch !== session.epoch) return { error: 'The session has been revoked.', status: 401 }
    return { account }
  }

  const all = accounts.list()
  if (all.length === 0) return { error: 'No account has signed in yet.', status: 401 }

  const wanted = String(header ?? '').trim().toLowerCase()

  if (wanted) {
    // An empty stored email must never match an absent or empty header, and two
    // accounts sharing one address must not be resolved by picking the first.
    // Exactly one match, or nobody is served.
    const matches = all.filter((entry) =>
      typeof entry.email === 'string' && entry.email !== '' && entry.email.toLowerCase() === wanted)
    if (matches.length === 1) return { account: matches[0] }
    return ambiguous(all, 'The X-OpenFit-Account header does not name exactly one account on this instance.')
  }

  if (all.length === 1) return { account: all[0] }

  return ambiguous(all, 'This instance has more than one account. Name one with the X-OpenFit-Account header.')
}

module.exports = { createAuth, sameToken, parseCookies, bearerFrom, resolveAccount, usableSession, TOKEN_FILE, COOKIE_NAME }
