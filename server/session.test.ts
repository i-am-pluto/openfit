import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createSessions, deriveSessionKey, SESSION_COOKIE, MAX_AGE_SECONDS } = require('./session.cjs') as {
  createSessions: (options: Record<string, any>) => {
    cookieName: string
    sign: (payload: Record<string, any>) => string
    verify: (value: string, options?: Record<string, any>) => Record<string, any> | null
    cookie: (payload: Record<string, any>) => string
    clearCookie: () => string
  }
  deriveSessionKey: (masterKey: Buffer) => Buffer
  SESSION_COOKIE: string
  MAX_AGE_SECONDS: number
}

const masterKey = Buffer.alloc(32, 7)
const otherKey = Buffer.alloc(32, 9)
const identity = { sub: '123', email: 'a@example.com', epoch: 1 }

// `sign` always stamps a truthful `iat`, so a payload with a hostile one has to be
// minted by hand — with a genuine MAC, so the age check is what rejects it.
function mint(payload: Record<string, any>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = crypto.createHmac('sha256', deriveSessionKey(masterKey)).update(`v1.${encoded}`).digest('base64url')
  return `v1.${encoded}.${mac}`
}

describe('sessions', () => {
  it('round-trips a signed payload', () => {
    const sessions = createSessions({ masterKey, secure: true })
    const value = sessions.verify(sessions.sign(identity))

    expect(value).toMatchObject({ sub: '123', email: 'a@example.com', epoch: 1 })
    expect(typeof value?.iat).toBe('number')
  })

  it('derives the same key from the same master key and a different one otherwise', () => {
    expect(deriveSessionKey(masterKey).equals(deriveSessionKey(masterKey))).toBe(true)
    expect(deriveSessionKey(masterKey).equals(deriveSessionKey(otherKey))).toBe(false)
  })

  it('survives a restart: a new instance verifies the old cookie', () => {
    const signed = createSessions({ masterKey, secure: true }).sign(identity)
    expect(createSessions({ masterKey, secure: true }).verify(signed)).toMatchObject({ sub: '123' })
  })

  it('rejects a cookie signed with a different master key', () => {
    const signed = createSessions({ masterKey, secure: true }).sign(identity)
    expect(createSessions({ masterKey: otherKey, secure: true }).verify(signed)).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const sessions = createSessions({ masterKey, secure: true })
    const [version, , mac] = sessions.sign(identity).split('.')
    const forged = Buffer.from(JSON.stringify({ ...identity, sub: '999' })).toString('base64url')

    expect(sessions.verify(`${version}.${forged}.${mac}`)).toBeNull()
  })

  it('rejects a tampered signature and garbage input', () => {
    const sessions = createSessions({ masterKey, secure: true })
    const [version, payload] = sessions.sign(identity).split('.')

    expect(sessions.verify(`${version}.${payload}.${crypto.randomBytes(32).toString('base64url')}`)).toBeNull()
    expect(sessions.verify('garbage')).toBeNull()
    expect(sessions.verify('')).toBeNull()
    expect(sessions.verify(`v9.${payload}.${crypto.randomBytes(32).toString('base64url')}`)).toBeNull()
  })

  it('sets Secure only for https origins', () => {
    expect(createSessions({ masterKey, secure: true }).cookie(identity)).toContain('Secure')
    expect(createSessions({ masterKey, secure: false }).cookie(identity)).not.toContain('Secure')
  })

  it('issues an HttpOnly, SameSite=Lax, path-scoped cookie', () => {
    const cookie = createSessions({ masterKey, secure: true }).cookie(identity)

    expect(cookie).toContain(`${SESSION_COOKIE}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
  })

  it('clears the cookie with an immediate expiry', () => {
    expect(createSessions({ masterKey, secure: true }).clearCookie()).toContain('Max-Age=0')
  })
})

describe('session age', () => {
  const sessions = createSessions({ masterKey, secure: true })
  const signedAt = () => {
    const value = sessions.sign(identity)
    return { value, iat: sessions.verify(value)!.iat as number }
  }

  it('accepts a fresh cookie', () => {
    const { value, iat } = signedAt()
    expect(sessions.verify(value, { now: iat })).toMatchObject({ sub: '123' })
  })

  it('accepts a cookie at exactly the maximum age and rejects one second beyond it', () => {
    const { value, iat } = signedAt()

    expect(sessions.verify(value, { now: iat + MAX_AGE_SECONDS })).toMatchObject({ sub: '123' })
    expect(sessions.verify(value, { now: iat + MAX_AGE_SECONDS + 1 })).toBeNull()
  })

  it('enforces the default maximum age when no option is passed', () => {
    const stale = mint({ ...identity, iat: Math.floor(Date.now() / 1000) - MAX_AGE_SECONDS - 1 })
    expect(sessions.verify(stale)).toBeNull()
  })

  it('rejects a payload whose iat is missing, non-numeric or NaN', () => {
    for (const iat of [undefined, null, 'NaN', NaN, '1700000000', {}, [], true, Infinity]) {
      expect(sessions.verify(mint({ ...identity, iat }))).toBeNull()
    }
  })

  it('tolerates a small forward clock skew but rejects a cookie stamped far in the future', () => {
    const { value, iat } = signedAt()

    expect(sessions.verify(value, { now: iat - 30 })).toMatchObject({ sub: '123' })
    expect(sessions.verify(value, { now: iat - 120 })).toBeNull()
  })

  it('honours an explicit shorter maximum age for the pending-state cookie', () => {
    const { value, iat } = signedAt()
    const later = iat + 601

    expect(sessions.verify(value, { now: later })).toMatchObject({ sub: '123' })
    expect(sessions.verify(value, { now: later, maxAgeSeconds: 600 })).toBeNull()
    expect(sessions.verify(value, { now: iat + 600, maxAgeSeconds: 600 })).toMatchObject({ sub: '123' })
  })
})
