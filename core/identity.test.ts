import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { validateIdToken, decodeIdToken, CLOCK_SKEW_SECONDS } = require('./identity.cjs') as {
  validateIdToken: (token: string, options: Record<string, any>) => { sub: string; email: string }
  decodeIdToken: (token: string) => Record<string, any>
  CLOCK_SKEW_SECONDS: number
}

const NOW = 1_760_000_000

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

function makeToken(claims: unknown) {
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

  it('rejects a non-string or absent issuer', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ iss: undefined })), options)).toThrow(/issuer/i)
    expect(() => validateIdToken(makeToken(baseClaims({ iss: ['https://accounts.google.com'] })), options)).toThrow(/issuer/i)
  })

  it('rejects a wrong audience', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ aud: 'other-client' })), options))
      .toThrow(/audience/i)
  })

  it('rejects an absent audience claim even when no client id is expected', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ aud: undefined })), { nonce: 'nonce-1', now: NOW }))
      .toThrow(/audience/i)
    expect(() => validateIdToken(makeToken(baseClaims({ aud: undefined })), options)).toThrow(/audience/i)
  })

  it('rejects a valid-looking token when the expected client id is missing', () => {
    expect(() => validateIdToken(makeToken(baseClaims()), { nonce: 'nonce-1', now: NOW })).toThrow(/audience/i)
    expect(() => validateIdToken(makeToken(baseClaims()), { clientId: '', nonce: 'nonce-1', now: NOW })).toThrow(/audience/i)
  })

  it('rejects an audience delivered as an array', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ aud: ['client-1'] })), options)).toThrow(/audience/i)
  })

  it('rejects a wrong nonce', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ nonce: 'different' })), options))
      .toThrow(/nonce/i)
  })

  it('rejects an absent nonce claim when an empty nonce is expected', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ nonce: undefined })), { clientId: 'client-1', nonce: '', now: NOW }))
      .toThrow(/nonce/i)
    expect(() => validateIdToken(makeToken(baseClaims({ nonce: undefined })), { clientId: 'client-1', now: NOW }))
      .toThrow(/nonce/i)
  })

  it('rejects a genuine token when no nonce is expected', () => {
    expect(() => validateIdToken(makeToken(baseClaims()), { clientId: 'client-1', nonce: '', now: NOW }))
      .toThrow(/nonce/i)
  })

  it('rejects an unverified email', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ email_verified: false })), options))
      .toThrow(/not verified/)
  })

  it('rejects a token missing sub or email', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ sub: undefined })), options))
      .toThrow('The Google ID token has no subject.')
    expect(() => validateIdToken(makeToken(baseClaims({ email: undefined })), options))
      .toThrow('The Google ID token has no email address.')
  })

  it('rejects a non-string sub or email', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ sub: 11223344 })), options))
      .toThrow('The Google ID token has no subject.')
    expect(() => validateIdToken(makeToken(baseClaims({ email: { address: 'person@example.com' } })), options))
      .toThrow('The Google ID token has no email address.')
  })

  it('allows exactly the permitted clock skew and rejects one second beyond it', () => {
    const atBoundary = baseClaims({ exp: NOW - CLOCK_SKEW_SECONDS })
    expect(validateIdToken(makeToken(atBoundary), options).sub).toBe('11223344')

    const past = baseClaims({ exp: NOW - CLOCK_SKEW_SECONDS - 1 })
    expect(() => validateIdToken(makeToken(past), options)).toThrow(/expired/i)
  })

  it('rejects a missing exp', () => {
    expect(() => validateIdToken(makeToken(baseClaims({ exp: undefined })), options)).toThrow(/expired/i)
  })

  it('rejects a non-numeric exp instead of accepting it', () => {
    for (const exp of ['expired-yesterday', {}, [], true, null, 'NaN', String(NOW + 3600), [NOW + 3600]]) {
      expect(() => validateIdToken(makeToken(baseClaims({ exp })), options)).toThrow(/expired/i)
    }
  })

  it('refuses to validate against a non-numeric now', () => {
    expect(() => validateIdToken(makeToken(baseClaims()), { ...options, now: Number.NaN })).toThrow(/current time/i)
  })

  it('defaults now to the current time', () => {
    const live = { clientId: 'client-1', nonce: 'nonce-1' }
    const seconds = Math.floor(Date.now() / 1000)
    expect(validateIdToken(makeToken(baseClaims({ exp: seconds + 3600 })), live).sub).toBe('11223344')
    expect(() => validateIdToken(makeToken(baseClaims({ exp: seconds - CLOCK_SKEW_SECONDS - 5 })), live))
      .toThrow(/expired/i)
  })

  it('rejects a malformed token', () => {
    expect(() => decodeIdToken('not-a-jwt')).toThrow(/malformed/i)
    expect(() => decodeIdToken('a.b')).toThrow(/malformed/i)
  })

  it('rejects a payload that is not an object', () => {
    for (const payload of [null, 'a-string', 42, ['claims']]) {
      expect(() => decodeIdToken(makeToken(payload))).toThrow(/malformed/i)
      expect(() => validateIdToken(makeToken(payload), options)).toThrow(/malformed/i)
    }
  })
})
