import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

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
