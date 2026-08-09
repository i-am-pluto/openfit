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
    setCookie: (response: { setHeader: (name: string, value: unknown) => void }) => void
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

  it('accepts the token from a bearer header, a cookie, or a query parameter', () => {
    const auth = createAuth({ dir: tempDir() })

    expect(auth.isAuthorized(requestWith({ authorization: `Bearer ${auth.token}` }))).toBe(true)
    expect(auth.isAuthorized(requestWith({ cookie: `openfit_token=${auth.token}` }))).toBe(true)
    expect(auth.isAuthorized(requestWith({}, `/?token=${auth.token}`))).toBe(true)
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

  it('issues an HttpOnly, SameSite=Lax, path-scoped cookie', () => {
    const auth = createAuth({ dir: tempDir() })
    let cookie = ''
    auth.setCookie({ setHeader: (_name, value) => { cookie = String(value) } })

    expect(cookie).toContain(`openfit_token=${auth.token}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
  })

  it('prefers an explicitly supplied token over the file', () => {
    const dir = tempDir()
    const auth = createAuth({ dir, token: 'supplied-token' })
    expect(auth.token).toBe('supplied-token')
    expect(fs.existsSync(path.join(dir, TOKEN_FILE))).toBe(false)
  })
})
