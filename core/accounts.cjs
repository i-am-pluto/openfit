'use strict'

const crypto = require('node:crypto')
const nodeFs = require('node:fs')
const path = require('node:path')

const ACCOUNTS_DIR = 'accounts'
const ACCOUNT_FILE = 'account.json'
const ADOPTABLE = ['credentials.secure.json', 'health-cache.secure.json']
const ID = /^[0-9a-f]{16}$/

// `sub` arrives from a Google ID token, so it is hostile input. Coercing it with
// String() would be a fail-open: every object stringifies to '[object Object]',
// so two different callers would hash to one id and share one encrypted
// directory. A non-string is rejected instead of being made to look like one.
function assertSub(sub) {
  if (typeof sub !== 'string' || sub === '') throw new Error('An account subject must be a non-empty string.')
  return sub
}

function assertEmail(email) {
  if (typeof email !== 'string' || email === '') throw new Error('An account requires a non-empty email address.')
  return email
}

// A hash rather than the raw `sub`: fixed length, filesystem-safe, does not
// disclose the Google account id to anything that can list the directory, and
// traversal through a hostile value is structurally impossible.
function accountId(sub) {
  return crypto.createHash('sha256').update(assertSub(sub), 'utf8').digest('hex').slice(0, 16)
}

// Every field is checked on the way out of storage. `epoch` in particular backs
// "log out everywhere": a value that is not a positive integer must stop the
// caller rather than be coerced, because Number('x') + 1 is NaN and a later bump
// would restart the counter at a number old cookies already carry.
function usableRecord(record) {
  return record !== null
    && typeof record === 'object'
    && !Array.isArray(record)
    && typeof record.sub === 'string'
    && record.sub !== ''
    && typeof record.email === 'string'
    && typeof record.createdAt === 'string'
    && Number.isSafeInteger(record.epoch)
    && record.epoch >= 1
}

function createAccounts({ dataDir, secrets, fs = nodeFs }) {
  if (!dataDir) throw new Error('createAccounts requires a dataDir.')
  if (!secrets) throw new Error('createAccounts requires a secret store.')

  const root = path.join(dataDir, ACCOUNTS_DIR)
  const directoryFor = (sub) => path.join(root, accountId(sub))
  const recordFile = (dir) => path.join(dir, ACCOUNT_FILE)

  // An unreadable record must never be treated as an absent one. Falling through
  // to "no account here" would rewrite the file with epoch 1 and revive every
  // session a previous revocation was supposed to have killed.
  function readRecord(dir) {
    const file = recordFile(dir)
    const record = secrets.read(file, null)
    if (record === null) {
      if (fs.existsSync(file)) throw new Error(`The account record at ${file} cannot be read; refusing to replace it.`)
      return null
    }
    if (!usableRecord(record)) throw new Error(`The account record at ${file} is not usable.`)
    return record
  }

  // The directory is named by the hash of the subject, so a record naming a
  // different subject means the store was tampered with or moved. Serving it
  // would graft one person's health history onto another account.
  function readOwned(sub, dir) {
    const record = readRecord(dir)
    if (record && record.sub !== sub) {
      throw new Error(`The account record at ${recordFile(dir)} belongs to a different subject.`)
    }
    return record
  }

  const present = (record, sub, dir) => ({ ...record, id: accountId(sub), dir })

  function adoptRootData(dir) {
    for (const name of ADOPTABLE) {
      const from = path.join(dataDir, name)
      if (!fs.existsSync(from)) continue
      fs.renameSync(from, path.join(dir, name))
      console.log(`Adopted ${name} into ${path.basename(dir)}.`)
    }
  }

  return {
    directoryFor,

    get(sub) {
      const dir = directoryFor(assertSub(sub))
      const record = readOwned(sub, dir)
      return record ? present(record, sub, dir) : null
    },

    list() {
      let entries = []
      try {
        entries = fs.readdirSync(root)
      } catch {
        return []
      }
      const accounts = []
      for (const id of entries) {
        // Only a directory this module named can be an account, and only the
        // subject that hashes to that name can own it. Anything else — a planted
        // directory, a corrupt record — is left out rather than listed.
        if (!ID.test(id)) continue
        const dir = path.join(root, id)
        let record = null
        try {
          record = readRecord(dir)
        } catch {
          continue
        }
        if (!record || accountId(record.sub) !== id) continue
        accounts.push({ ...record, id, dir })
      }
      return accounts
    },

    resolve({ sub, email }) {
      // Validate before touching the filesystem so a rejected sign-in leaves no
      // directory behind.
      const owner = assertSub(sub)
      const address = assertEmail(email)

      // Adoption is gated on accounts/ being absent, so it can only ever run
      // for the very first sign-in.
      const firstEver = !fs.existsSync(root)
      const dir = directoryFor(owner)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      // mkdir's mode is masked by the umask and ignored outright when the
      // directory already exists, so 0700 is asserted rather than requested.
      fs.chmodSync(root, 0o700)
      fs.chmodSync(dir, 0o700)
      if (firstEver) adoptRootData(dir)

      const existing = readOwned(owner, dir)
      const record = existing
        ? { ...existing, sub: owner, email: address }
        : { sub: owner, email: address, epoch: 1, createdAt: new Date().toISOString() }

      secrets.write(recordFile(dir), record)
      return present(record, owner, dir)
    },

    bumpEpoch(sub) {
      const owner = assertSub(sub)
      const dir = directoryFor(owner)
      const record = readOwned(owner, dir)
      if (!record) throw new Error('Unknown account.')
      const updated = { ...record, epoch: record.epoch + 1 }
      secrets.write(recordFile(dir), updated)
      return updated.epoch
    },
  }
}

module.exports = { createAccounts, accountId, ACCOUNTS_DIR, ACCOUNT_FILE }
