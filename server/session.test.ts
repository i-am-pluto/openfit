import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createSessions, deriveSessionKey, SESSION_COOKIE } = require('./session.cjs') as {
  createSessions: (options: Record<string, any>) => {
    cookieName: string
    sign: (payload: Record<string, any>) => string
    verify: (value: string) => Record<string, any> | null
    cookie: (payload: Record<string, any>) => string
    clearCookie: () => string
  }
  deriveSessionKey: (masterKey: Buffer) => Buffer
  SESSION_COOKIE: string
}

const masterKey = Buffer.alloc(32, 7)
const otherKey = Buffer.alloc(32, 9)
const identity = { sub: '123', email: 'a@example.com', epoch: 1 }

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
