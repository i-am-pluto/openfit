import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { validateIdToken, decodeIdToken, CLOCK_SKEW_SECONDS } = require('./identity.cjs') as {
  validateIdToken: (token: string, options: Record<string, any>) => { sub: string; email: string }
  decodeIdToken: (token: string) => Record<string, any>
  CLOCK_SKEW_SECONDS: number
}

const NOW = 1_760_000_000

function makeToken(claims: Record<string, any>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature-not-checked`
}

function baseClaims(overrides: Record<string, any> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: 'client-1',
    sub: '11223344',
    email: 'person@example.com',
    email_verified: true,
    nonce: 'nonce-1',
    exp: NOW + 3600,
    ...overrides,
  }
}

const options = { clientId: 'client-1', nonce: 'nonce-1', now: NOW }

describe('validateIdToken', () => {
  it('returns sub and email for a valid token', () => {
    expect(validateIdToken(makeToken(baseClaims()), options)).toEqual({
      sub: '11223344',
      email: 'person@example.com',
    })
  })

  it('accepts the accounts.google.com issuer with an https prefix or without', () => {
    expect(validateIdToken(makeToken(baseClaims({ iss: 'accounts.google.com' })), options).sub).toBe('11223344')
  })

  it('rejects a wrong issuer', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ iss: 'https://evil.example' })), options))
      .toThrow(/issuer/i)
  })

  it('rejects a wrong audience', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ aud: 'other-client' })), options))
      .toThrow(/audience/i)
  })

  it('rejects a wrong nonce', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ nonce: 'different' })), options))
      .toThrow(/nonce/i)
  })

  it('rejects an unverified email', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ email_verified: false })), options))
      .toThrow(/verified/i)
  })

  it('rejects a token missing sub or email', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ sub: undefined })), options)).toThrow(/subject/i)
    expect(() => validateIdToken(makeToken(baseClaims({ email: undefined })), options)).toThrow(/email/i)
  })

  it('allows exactly the permitted clock skew and rejects one second beyond it', () => {
    const atBoundary = baseClaims({ exp: NOW - CLOCK_SKEW_SECONDS })
    expect(validateIdToken(makeToken(atBoundary), options).sub).toBe('11223344')

    const past = baseClaims({ exp: NOW - CLOCK_SKEW_SECONDS - 1 })
    expect(() => validateIdToken(makeToken(past), options)).toThrow(/expired/i)
  })

  it('rejects a malformed token', () => {
    expect(() => decodeIdToken('not-a-jwt')).toThrow(/malformed/i)
    expect(() => decodeIdToken('a.b')).toThrow(/malformed/i)
  })
})
