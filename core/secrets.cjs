'use strict'

const nodeCrypto = require('node:crypto')
const nodeFs = require('node:fs')
const path = require('node:path')

const KEY_FILE = 'master.key'
const KEY_BYTES = 32
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

function atomicWrite(fs, file, content) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, content, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

// safeStorage is only trustworthy when the OS actually backs it. On Linux the
// `basic_text` backend stores plaintext behind an encryption-shaped API.
function safeStorageUsable(safeStorage, platform) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return false
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (platform !== 'linux') return true
    return safeStorage.getSelectedStorageBackend() !== 'basic_text'
  } catch {
    return false
  }
}

function assertKeyLength(key, file) {
  if (key.length !== KEY_BYTES) {
    throw new Error(`The OpenFit master key at ${file} is not ${KEY_BYTES} bytes. Move it aside to start fresh; data encrypted with the original key will not be readable.`)
  }
  return key
}

function loadOrCreateKey({ dir, fs, randomBytes }) {
  const file = path.join(dir, KEY_FILE)
  try {
    return assertKeyLength(fs.readFileSync(file), file)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const key = randomBytes(KEY_BYTES)
  try {
    // `wx` so two processes starting together cannot clobber each other's key.
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' })
    return key
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return assertKeyLength(fs.readFileSync(file), file)
  }
}

function createSecretStore(options = {}) {
  const fs = options.fs || nodeFs
  const crypto = options.crypto || nodeCrypto
  const randomBytes = options.randomBytes || crypto.randomBytes.bind(crypto)
  const platform = options.platform || process.platform
  const dir = options.dir
  if (!dir) throw new Error('createSecretStore requires a data directory.')

  const safeStorage = safeStorageUsable(options.safeStorage, platform) ? options.safeStorage : null
  let cachedKey = null

  const key = () => {
    if (!cachedKey) cachedKey = loadOrCreateKey({ dir, fs, randomBytes })
    return cachedKey
  }

  function encryptV2(serialized) {
    const iv = randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv(ALGORITHM, key(), iv)
    const data = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()])
    return {
      version: 2,
      encrypted: true,
      algo: ALGORITHM,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }
  }

  function decryptV2(envelope) {
    const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()])
    return plain.toString('utf8')
  }

  return {
    describe() {
      return { encrypted: true, backend: safeStorage ? 'safeStorage' : ALGORITHM }
    },

    // Reads either envelope version regardless of the preferred write backend, so
    // a data directory stays readable when moved between the desktop app and the
    // server. An envelope this process cannot decrypt yields the fallback and is
    // left on disk untouched — never silently deleted.
    read(file, fallback = null) {
      let envelope
      try {
        envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        return fallback
      }
      if (envelope?.encrypted !== true) return fallback
      try {
        if (envelope.version === 2) return JSON.parse(decryptV2(envelope))
        if (!safeStorage) return fallback
        return JSON.parse(safeStorage.decryptString(Buffer.from(envelope.data, 'base64')))
      } catch {
        return fallback
      }
    },

    write(file, value) {
      const serialized = JSON.stringify(value)
      const envelope = safeStorage
        ? { version: 1, encrypted: true, data: safeStorage.encryptString(serialized).toString('base64') }
        : encryptV2(serialized)
      atomicWrite(fs, file, JSON.stringify(envelope))
    },

    remove(file) {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* best effort */
      }
    },
  }
}

module.exports = { createSecretStore, safeStorageUsable, KEY_FILE, KEY_BYTES }
