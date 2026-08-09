import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createAuth, sameToken, TOKEN_FILE } = require('./auth.cjs') as {
  createAuth: (options: Record<string, unknown>) => {
    token: string
    isAuthorized: (request: unknown) => boolean
    presentedToken: (request: unknown) => string | null
  }
  sameToken: (a: unknown, b: unknown) => boolean
  TOKEN_FILE: string
}

const directories: string[] = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-auth-'))
  directories.push(dir)
  return dir
}

const requestWith = (headers: Record<string, string>, url = '/api/status') => ({ url, headers })

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('server auth', () => {
  it('generates a token file with 0600 permissions and reuses it', () => {
    const dir = tempDir()
    const first = createAuth({ dir })

    expect(first.token).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.statSync(path.join(dir, TOKEN_FILE)).mode & 0o777).toBe(0o600)
    expect(createAuth({ dir }).token).toBe(first.token)
  })

  it('accepts the token from an Authorization header and from nowhere else', () => {
    const auth = createAuth({ dir: tempDir() })

    expect(auth.isAuthorized(requestWith({ authorization: `Bearer ${auth.token}` }))).toBe(true)

    // A token in a URL is recorded in access logs, browser history and Referer
    // headers, and `openfit_token` was a year-long cookie a previous release set
    // on any tokenized page request: it named no account, carried no epoch, and
    // so no "log out everywhere" could ever revoke it. Both channels are gone.
    expect(auth.isAuthorized(requestWith({}, `/api/status?token=${auth.token}`))).toBe(false)
    expect(auth.isAuthorized(requestWith({ cookie: `openfit_token=${auth.token}` }))).toBe(false)
    expect(auth.isAuthorized(requestWith({ cookie: `openfit_token=${auth.token}` }, `/?token=${auth.token}`))).toBe(false)
    expect(auth.presentedToken(requestWith({}, `/?token=${auth.token}`))).toBe(null)
  })

  it('rejects a missing, empty, wrong, or wrong-length token', () => {
    const auth = createAuth({ dir: tempDir() })

    expect(auth.isAuthorized(requestWith({}))).toBe(false)
    expect(auth.isAuthorized(requestWith({ authorization: 'Bearer ' }))).toBe(false)
    expect(auth.isAuthorized(requestWith({ authorization: 'Bearer wrong' }))).toBe(false)
    expect(auth.isAuthorized(requestWith({ authorization: `Bearer ${auth.token}x` }))).toBe(false)
    expect(auth.isAuthorized(requestWith({ authorization: auth.token }))).toBe(false)
    expect(auth.isAuthorized(requestWith({ cookie: 'openfit_token=' }))).toBe(false)
    expect(auth.isAuthorized(requestWith({ cookie: 'other=value' }))).toBe(false)
  })

  it('compares tokens of differing lengths without throwing', () => {
    expect(sameToken('short', 'a-much-longer-token-value')).toBe(false)
    expect(sameToken(null, 'token')).toBe(false)
    expect(sameToken('same', 'same')).toBe(true)
  })

  it('issues no cookie of its own', () => {
    // setCookie minted the year-long `openfit_token` credential. There is no
    // way left to create one; server/session.cjs only knows how to clear it.
    expect(createAuth({ dir: tempDir() })).not.toHaveProperty('setCookie')
  })

  it('prefers an explicitly supplied token over the file', () => {
    const dir = tempDir()
    const auth = createAuth({ dir, token: 'supplied-token' })
    expect(auth.token).toBe('supplied-token')
    expect(fs.existsSync(path.join(dir, TOKEN_FILE))).toBe(false)
  })
})
