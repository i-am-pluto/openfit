'use strict'

const crypto = require('node:crypto')

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
  function verify(value) {
    const parts = String(value || '').split('.')
    if (parts.length !== 3) return null
    const [version, encoded, signature] = parts
    if (version !== VERSION) return null
    if (!sameToken(signature, mac(encoded))) return null
    try {
      return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      return null
    }
  }

  const attributes = (maxAge) => {
    const parts = [`Path=/`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
    if (secure) parts.push('Secure')
    return parts
  }

  return {
    cookieName: SESSION_COOKIE,
    sign,
    verify,
    cookie: (payload) => [`${SESSION_COOKIE}=${sign(payload)}`, ...attributes(MAX_AGE_SECONDS)].join('; '),
    clearCookie: () => [`${SESSION_COOKIE}=`, ...attributes(0)].join('; '),
  }
}

module.exports = { createSessions, deriveSessionKey, SESSION_COOKIE, MAX_AGE_SECONDS }
