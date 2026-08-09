'use strict'

const crypto = require('node:crypto')

const { CLOCK_SKEW_SECONDS } = require('../core/identity.cjs')
const { sameToken } = require('./auth.cjs')

const SESSION_COOKIE = 'openfit_session'
const VERSION = 'v1'
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60

// Key separation: the session signing key must never be the same bytes as the
// data-encryption key, even though both come from master.key.
function deriveSessionKey(masterKey) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), 'openfit-session-v1', 32))
}

function createSessions({ masterKey, secure = false }) {
  const key = deriveSessionKey(masterKey)

  const mac = (encodedPayload) =>
    crypto.createHmac('sha256', key).update(`${VERSION}.${encodedPayload}`).digest('base64url')

  function sign(payload) {
    const body = { ...payload, iat: Math.floor(Date.now() / 1000) }
    const encoded = Buffer.from(JSON.stringify(body)).toString('base64url')
    return `${VERSION}.${encoded}.${mac(encoded)}`
  }

  // Never throws: a corrupt cookie is a user-facing condition, not a fault.
  function verify(value, { maxAgeSeconds = MAX_AGE_SECONDS, now = Math.floor(Date.now() / 1000) } = {}) {
    const parts = String(value || '').split('.')
    if (parts.length !== 3) return null
    const [version, encoded, signature] = parts
    if (version !== VERSION) return null
    if (!sameToken(signature, mac(encoded))) return null

    let payload
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      return null
    }
    if (!payload || typeof payload !== 'object') return null

    // Age is enforced here rather than left to the cookie's `Max-Age`, which is only a
    // hint to the browser: a captured cookie value would otherwise be valid forever.
    // `Number.isFinite` does not coerce, so a missing, NaN or string `iat` fails closed
    // instead of reading as an unexpirable session.
    if (!Number.isFinite(payload.iat)) return null
    if (!Number.isFinite(now) || !Number.isFinite(maxAgeSeconds)) return null
    if (payload.iat > now + CLOCK_SKEW_SECONDS) return null
    if (now - payload.iat > maxAgeSeconds) return null

    return payload
  }

  const attributes = (maxAge, path = '/') => {
    const parts = [`Path=${path}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
    if (secure) parts.push('Secure')
    return parts
  }

  // Every cookie this server sets goes through here. A second Set-Cookie string
  // assembled by hand elsewhere is how `Secure` or `HttpOnly` ends up on one
  // cookie and not the other; there is one attribute list and it lives here.
  const cookieString = ({ name, value = '', maxAge, path = '/' }) =>
    [`${name}=${value}`, ...attributes(maxAge, path)].join('; ')

  return {
    cookieName: SESSION_COOKIE,
    sign,
    verify,
    cookieString,
    cookie: (payload) => cookieString({ name: SESSION_COOKIE, value: sign(payload), maxAge: MAX_AGE_SECONDS }),
    clearCookie: () => cookieString({ name: SESSION_COOKIE, maxAge: 0 }),
  }
}

module.exports = { createSessions, deriveSessionKey, SESSION_COOKIE, MAX_AGE_SECONDS }
