import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createSecretStore, KEY_FILE } = require('./secrets.cjs') as {
  createSecretStore: (options: Record<string, unknown>) => {
    describe: () => { encrypted: boolean; backend: string }
    read: (file: string, fallback?: unknown) => unknown
    write: (file: string, value: unknown) => void
    remove: (file: string) => void
  }
  KEY_FILE: string
}

const directories: string[] = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-secrets-'))
  directories.push(dir)
  return dir
}

// Stands in for Electron's safeStorage: reversible, and distinguishable from
// real ciphertext so tests can assert which backend produced an envelope.
function fakeSafeStorage(backend = 'gnome_libsecret') {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value: string) => Buffer.from(`safe:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^safe:/, ''),
  }
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('secret store', () => {
  it('round-trips through AES-256-GCM when safeStorage is unavailable', () => {
    const dir = tempDir()
    const file = path.join(dir, 'credentials.secure.json')
    const store = createSecretStore({ dir })

    expect(store.describe()).toEqual({ encrypted: true, backend: 'aes-256-gcm' })
    store.write(file, { clientSecret: 'top-secret-value', token: { access_token: 'abc' } })

    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(envelope).toMatchObject({ version: 2, encrypted: true, algo: 'aes-256-gcm' })
    expect(JSON.stringify(envelope)).not.toContain('top-secret-value')
    expect(store.read(file)).toEqual({ clientSecret: 'top-secret-value', token: { access_token: 'abc' } })
  })

  it('creates the key file with 0600 permissions and reuses it across instances', () => {
    const dir = tempDir()
    const file = path.join(dir, 'a.json')
    createSecretStore({ dir }).write(file, { value: 1 })

    const keyPath = path.join(dir, KEY_FILE)
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600)
    const key = fs.readFileSync(keyPath)

    // A second store must decrypt what the first wrote, and must not re-key.
    expect(createSecretStore({ dir }).read(file)).toEqual({ value: 1 })
    expect(fs.readFileSync(keyPath)).toEqual(key)
  })

  it('writes 0600 envelopes', () => {
    const dir = tempDir()
    const file = path.join(dir, 'perm.json')
    createSecretStore({ dir }).write(file, { value: 1 })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('returns the fallback for tampered ciphertext and a tampered auth tag', () => {
    const dir = tempDir()
    const file = path.join(dir, 'tampered.json')
    const store = createSecretStore({ dir })
    store.write(file, { value: 'original' })
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))

    const flipped = Buffer.from(envelope.data, 'base64')
    flipped[0] ^= 0xff
    fs.writeFileSync(file, JSON.stringify({ ...envelope, data: flipped.toString('base64') }))
    expect(store.read(file, 'FALLBACK')).toBe('FALLBACK')

    const badTag = Buffer.from(envelope.tag, 'base64')
    badTag[0] ^= 0xff
    fs.writeFileSync(file, JSON.stringify({ ...envelope, tag: badTag.toString('base64') }))
    expect(store.read(file, 'FALLBACK')).toBe('FALLBACK')
  })

  it('prefers safeStorage when available and still reads AES envelopes', () => {
    const dir = tempDir()
    const safeFile = path.join(dir, 'safe.json')
    const aesFile = path.join(dir, 'aes.json')

    createSecretStore({ dir }).write(aesFile, { from: 'server' })

    const desktop = createSecretStore({ dir, safeStorage: fakeSafeStorage(), platform: 'linux' })
    expect(desktop.describe()).toEqual({ encrypted: true, backend: 'safeStorage' })
    desktop.write(safeFile, { from: 'desktop' })

    expect(JSON.parse(fs.readFileSync(safeFile, 'utf8')).version).toBe(1)
    // A data directory stays readable when it moves between the two hosts.
    expect(desktop.read(aesFile)).toEqual({ from: 'server' })
    expect(desktop.read(safeFile)).toEqual({ from: 'desktop' })
  })

  it('rejects the Linux basic_text backend and falls back to AES', () => {
    const dir = tempDir()
    const store = createSecretStore({ dir, safeStorage: fakeSafeStorage('basic_text'), platform: 'linux' })
    expect(store.describe().backend).toBe('aes-256-gcm')
  })

  it('leaves an undecryptable v1 envelope on disk and returns the fallback', () => {
    const dir = tempDir()
    const file = path.join(dir, 'v1.json')
    createSecretStore({ dir, safeStorage: fakeSafeStorage(), platform: 'linux' }).write(file, { value: 'desktop' })

    // Same directory, no safeStorage — the "moved a desktop profile to a server" case.
    expect(createSecretStore({ dir }).read(file, null)).toBeNull()
    expect(fs.existsSync(file)).toBe(true)
  })

  it('refuses to run with a truncated key file', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, KEY_FILE), Buffer.alloc(8), { mode: 0o600 })
    expect(() => createSecretStore({ dir }).write(path.join(dir, 'x.json'), { a: 1 })).toThrow(/not 32 bytes/)
  })
})
