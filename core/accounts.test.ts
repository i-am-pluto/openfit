import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createAccounts, accountId } = require('./accounts.cjs') as {
  createAccounts: (options: Record<string, any>) => any
  accountId: (sub: string) => string
}
const { createSecretStore } = require('./secrets.cjs') as {
  createSecretStore: (options: Record<string, any>) => any
}

const dirs: string[] = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-accounts-'))
  dirs.push(dir)
  return dir
}

function build(dataDir: string) {
  return createAccounts({ dataDir, secrets: createSecretStore({ dir: dataDir }) })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('accounts', () => {
  it('maps a sub to a stable 16-hex id', () => {
    expect(accountId('11223344')).toMatch(/^[0-9a-f]{16}$/)
    expect(accountId('11223344')).toBe(accountId('11223344'))
    expect(accountId('11223344')).not.toBe(accountId('55667788'))
  })

  it('creates the account directory with mode 0700', () => {
    const dataDir = tempDir()
    const account = build(dataDir).resolve({ sub: '1', email: 'a@example.com' })

    expect(fs.existsSync(account.dir)).toBe(true)
    expect(fs.statSync(account.dir).mode & 0o777).toBe(0o700)
    expect(account.dir.startsWith(path.join(dataDir, 'accounts'))).toBe(true)
  })

  it('gives separate directories to separate accounts and lists both', () => {
    const accounts = build(tempDir())
    const first = accounts.resolve({ sub: '1', email: 'a@example.com' })
    const second = accounts.resolve({ sub: '2', email: 'b@example.com' })

    expect(first.dir).not.toBe(second.dir)
    expect(accounts.list().map((entry: any) => entry.email).sort()).toEqual(['a@example.com', 'b@example.com'])
  })

  it('keeps createdAt and updates a changed email on re-resolve', () => {
    const accounts = build(tempDir())
    const first = accounts.resolve({ sub: '1', email: 'old@example.com' })
    const again = accounts.resolve({ sub: '1', email: 'new@example.com' })

    expect(again.createdAt).toBe(first.createdAt)
    expect(again.email).toBe('new@example.com')
  })

  it('increments and persists the epoch', () => {
    const dataDir = tempDir()
    expect(build(dataDir).resolve({ sub: '1', email: 'a@example.com' }).epoch).toBe(1)
    expect(build(dataDir).bumpEpoch('1')).toBe(2)
    expect(build(dataDir).get('1').epoch).toBe(2)
  })

  it('cannot escape the accounts directory with a hostile sub', () => {
    const dataDir = tempDir()
    const account = build(dataDir).resolve({ sub: '../../etc/passwd', email: 'a@example.com' })

    expect(account.dir.startsWith(path.join(dataDir, 'accounts') + path.sep)).toBe(true)
    expect(account.dir).not.toContain('..')
  })

  it('leaves pre-existing root-level data where it is, for the first sign-in and every later one', () => {
    // Adoption is gone. It granted the previous owner's Google refresh token and
    // whole health archive to whoever signed in first, whatever their identity,
    // and it moved the files rather than copying them, so the owner could not
    // get them back. "First to sign in" proves nothing about who you are.
    const dataDir = tempDir()
    const credentials = path.join(dataDir, 'credentials.secure.json')
    const cache = path.join(dataDir, 'health-cache.secure.json')
    fs.writeFileSync(credentials, '{"encrypted":true,"owner":"first"}')
    fs.writeFileSync(cache, '{"encrypted":true,"owner":"first"}')

    const stranger = build(dataDir).resolve({ sub: 'stranger', email: 'stranger@example.com' })
    const later = build(dataDir).resolve({ sub: '1', email: 'a@example.com' })

    for (const dir of [stranger.dir, later.dir]) {
      expect(fs.existsSync(path.join(dir, 'credentials.secure.json'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'health-cache.secure.json'))).toBe(false)
      expect(fs.readdirSync(dir)).toEqual(['account.json'])
    }

    expect(fs.readFileSync(credentials, 'utf8')).toBe('{"encrypted":true,"owner":"first"}')
    expect(fs.readFileSync(cache, 'utf8')).toBe('{"encrypted":true,"owner":"first"}')
  })

  it('returns null for a valid sub that has no account, and refuses to bump one', () => {
    const dataDir = tempDir()
    const accounts = build(dataDir)

    // The branch Task 7's request guard takes for a signed-in-but-unknown
    // subject: null, never a throw, and no directory conjured on the way.
    expect(accounts.get('nobody')).toBe(null)
    expect(() => accounts.bumpEpoch('nobody')).toThrow(/Unknown account/)

    accounts.resolve({ sub: '1', email: 'a@example.com' })

    expect(accounts.get('nobody')).toBe(null)
    expect(fs.existsSync(accounts.directoryFor('nobody'))).toBe(false)
  })

  it('refuses a non-string sub rather than collapsing distinct values onto one id', () => {
    const dataDir = tempDir()
    const accounts = build(dataDir)

    // String({}) is '[object Object]' for every object, so a coercing id would
    // hand two different callers the same encrypted directory.
    expect(() => accountId({ sub: 'a' } as any)).toThrow()
    expect(() => accountId(['1'] as any)).toThrow()
    expect(() => accountId(1 as any)).toThrow()
    expect(() => accountId('')).toThrow()
    expect(() => accountId(null as any)).toThrow()
    expect(() => accounts.get(1 as any)).toThrow()
    expect(() => accounts.bumpEpoch(null as any)).toThrow()
    expect(() => accounts.resolve({ sub: { toString: () => '1' } as any, email: 'a@example.com' })).toThrow()
    expect(fs.existsSync(path.join(dataDir, 'accounts'))).toBe(false)
  })

  it('refuses a non-string or empty email rather than storing a coerced one', () => {
    const dataDir = tempDir()
    const accounts = build(dataDir)

    expect(() => accounts.resolve({ sub: '1', email: { address: 'a@example.com' } as any })).toThrow()
    expect(() => accounts.resolve({ sub: '1', email: '' })).toThrow()
    expect(() => accounts.resolve({ sub: '1', email: undefined as any })).toThrow()
    expect(fs.existsSync(path.join(dataDir, 'accounts'))).toBe(false)
  })

  it('confines every hostile sub to a 16-hex directory directly inside accounts/', () => {
    const dataDir = tempDir()
    const accounts = build(dataDir)
    const root = path.join(dataDir, 'accounts')
    const hostile = ['../../etc/passwd', '..', '.', '/etc/passwd', 'a\0b', 'a b', `${'../'.repeat(40)}root`, 'x/../../y', '~']

    for (const sub of hostile) {
      const dir = accounts.resolve({ sub, email: 'a@example.com' }).dir
      expect(path.basename(dir)).toMatch(/^[0-9a-f]{16}$/)
      expect(path.dirname(path.resolve(dir))).toBe(path.resolve(root))
      expect(fs.realpathSync(dir).startsWith(fs.realpathSync(root) + path.sep)).toBe(true)
    }

    // Nothing landed outside accounts/, and no two hostile subs shared a directory.
    expect(fs.readdirSync(dataDir).sort()).toEqual(['accounts', 'master.key'])
    const names = fs.readdirSync(root)
    expect(names.every((name) => /^[0-9a-f]{16}$/.test(name))).toBe(true)
    expect(new Set(names).size).toBe(hostile.length)
  })

  it('refuses to replace an account record it cannot read, so the epoch cannot reset', () => {
    const dataDir = tempDir()
    const account = build(dataDir).resolve({ sub: '1', email: 'a@example.com' })
    build(dataDir).bumpEpoch('1')
    const file = path.join(account.dir, 'account.json')
    fs.writeFileSync(file, '{"encrypted":true,"version":2,"iv":"AAAAAAAAAAAAAAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA==","data":"AAAA"}')

    expect(() => build(dataDir).resolve({ sub: '1', email: 'a@example.com' })).toThrow()
    expect(() => build(dataDir).get('1')).toThrow()
    expect(() => build(dataDir).bumpEpoch('1')).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toContain('"data":"AAAA"')
  })

  it('refuses to bump an epoch that is not a positive integer', () => {
    const dataDir = tempDir()
    const secrets = createSecretStore({ dir: dataDir })
    const accounts = createAccounts({ dataDir, secrets })
    const account = accounts.resolve({ sub: '1', email: 'a@example.com' })

    for (const epoch of ['seven', 0, -1, 1.5, null]) {
      secrets.write(path.join(account.dir, 'account.json'), { sub: '1', email: 'a@example.com', epoch, createdAt: account.createdAt })
      expect(() => accounts.bumpEpoch('1')).toThrow()
      expect(() => accounts.get('1')).toThrow()
    }
  })

  it('refuses a record whose subject does not match the directory', () => {
    const dataDir = tempDir()
    const secrets = createSecretStore({ dir: dataDir })
    const accounts = createAccounts({ dataDir, secrets })
    const account = accounts.resolve({ sub: '1', email: 'a@example.com' })
    secrets.write(path.join(account.dir, 'account.json'), { sub: '2', email: 'b@example.com', epoch: 9, createdAt: account.createdAt })

    expect(() => accounts.get('1')).toThrow()
    expect(() => accounts.bumpEpoch('1')).toThrow()
    expect(() => accounts.resolve({ sub: '1', email: 'a@example.com' })).toThrow()
    expect(accounts.list()).toEqual([])
  })

  it('ignores directories inside accounts/ that no sub could have named', () => {
    const dataDir = tempDir()
    const secrets = createSecretStore({ dir: dataDir })
    const accounts = createAccounts({ dataDir, secrets })
    accounts.resolve({ sub: '1', email: 'a@example.com' })
    const planted = path.join(dataDir, 'accounts', 'planted')
    fs.mkdirSync(planted)
    secrets.write(path.join(planted, 'account.json'), { sub: '1', email: 'evil@example.com', epoch: 1, createdAt: new Date().toISOString() })

    expect(accounts.list().map((entry: any) => entry.email)).toEqual(['a@example.com'])
    expect(accounts.list()[0].id).toBe(accountId('1'))
  })

  it('tightens an account directory that already exists too openly', () => {
    const dataDir = tempDir()
    const dir = path.join(dataDir, 'accounts', accountId('1'))
    fs.mkdirSync(dir, { recursive: true })
    fs.chmodSync(path.join(dataDir, 'accounts'), 0o755)
    fs.chmodSync(dir, 0o777)

    const account = build(dataDir).resolve({ sub: '1', email: 'a@example.com' })

    expect(fs.statSync(account.dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(dataDir, 'accounts')).mode & 0o777).toBe(0o700)
  })
})
