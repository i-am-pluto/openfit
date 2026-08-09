import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const google = require('./google-health.cjs')
const legacy = require('./fitbit-legacy.cjs')

const config = {
  clientId: 'client-id',
  clientSecret: 'never-put-this-in-the-url',
  redirectUri: 'http://127.0.0.1:42813/oauth/callback',
}

describe.each([
  ['Google Health', google],
  ['Fitbit legacy', legacy],
])('%s OAuth', (_name, provider) => {
  it('uses PKCE and state without leaking the client secret', () => {
    const pkce = provider.createPkce()
    const url = new URL(provider.createAuthorizationUrl(config, 'csrf-state', pkce))

    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pkce.challenge).not.toContain('=')
    expect(url.searchParams.get('state')).toBe('csrf-state')
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.toString()).not.toContain(config.clientSecret)
  })
})

const signIn = {
  clientId: 'client-id',
  redirectUri: 'https://box.ts.net/auth/callback',
  state: 'csrf-state',
  nonce: 'replay-nonce',
  challenge: 'pkce-challenge',
}

describe('buildGoogleAuthUrl', () => {
  it('sends the nonce the ID token is checked against', () => {
    // core/identity.cjs rejects an ID token whose nonce claim is missing, and
    // Google omits the claim when the parameter is absent. Without this
    // parameter every real sign-in fails at the callback.
    const url = new URL(google.buildGoogleAuthUrl(signIn))

    expect(url.searchParams.get('nonce')).toBe('replay-nonce')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://box.ts.net/auth/callback')
    expect(url.searchParams.get('state')).toBe('csrf-state')
    expect(url.searchParams.get('code_challenge')).toBe('pkce-challenge')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toContain('openid')
  })

  it('refuses to build a URL that could not produce a usable token', () => {
    for (const missing of ['clientId', 'redirectUri', 'state', 'nonce', 'challenge']) {
      expect(() => google.buildGoogleAuthUrl({ ...signIn, [missing]: '' })).toThrow(/requires a non-empty/)
      expect(() => google.buildGoogleAuthUrl({ ...signIn, [missing]: undefined })).toThrow(/requires a non-empty/)
    }
  })

  it('asks for the consent screen only when the caller does', () => {
    // Forcing consent on every sign-in is noise; the reconnect path asks for it
    // when a refresh token is actually needed.
    expect(new URL(google.buildGoogleAuthUrl(signIn)).searchParams.has('prompt')).toBe(false)
    expect(new URL(google.buildGoogleAuthUrl({ ...signIn, prompt: 'consent' })).searchParams.get('prompt')).toBe('consent')
  })
})

describe('exchangeGoogleCode', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('posts the code and verifier to Google and never puts the secret in a URL', async () => {
    const calls: Array<[string, any]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: any) => {
      calls.push([String(url), options])
      return { ok: true, json: async () => ({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 }) }
    }))

    const token = await google.exchangeGoogleCode({
      clientId: 'client-id',
      clientSecret: 'never-put-this-in-the-url',
      redirectUri: 'https://box.ts.net/auth/callback',
      code: 'auth-code',
      verifier: 'pkce-verifier',
    })

    expect(token.access_token).toBe('a1')
    expect(token.expiresAt).toBeGreaterThan(Date.now())
    const [url, options] = calls[0]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(url).not.toContain('never-put-this-in-the-url')
    expect(options.method).toBe('POST')
    const body = new URLSearchParams(String(options.body))
    expect(Object.fromEntries(body)).toMatchObject({
      code: 'auth-code',
      code_verifier: 'pkce-verifier',
      grant_type: 'authorization_code',
      client_id: 'client-id',
      client_secret: 'never-put-this-in-the-url',
      redirect_uri: 'https://box.ts.net/auth/callback',
    })
  })

  it('throws when Google rejects the exchange', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'Bad code' }),
    })))

    await expect(google.exchangeGoogleCode({
      clientId: 'c', clientSecret: 's', redirectUri: 'https://box.ts.net/auth/callback', code: 'x', verifier: 'y',
    })).rejects.toThrow('Bad code')
  })
})
