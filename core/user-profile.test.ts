import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createUserProfileStore, EMPTY_PROFILE } = require('./user-profile.cjs')

function memoryStore() {
  const files = new Map<string, unknown>()
  return {
    files,
    read: (file: string, fallback: unknown = null) => (files.has(file) ? files.get(file) : fallback),
    write: (file: string, value: unknown) => { files.set(file, JSON.parse(JSON.stringify(value))) },
    remove: (file: string) => { files.delete(file) },
    describe: () => ({ encrypted: true, backend: 'aes-256-gcm' }),
  }
}

describe('user profile store', () => {
  it('returns an all-null profile before anything is written', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    expect(store.read()).toEqual(EMPTY_PROFILE)
  })

  it('round-trips a saved profile', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ birthYear: 1990, heightCm: 178 })
    expect(store.read()).toMatchObject({ birthYear: 1990, heightCm: 178 })
  })

  it('merges a patch instead of replacing the profile', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ birthYear: 1990 })
    store.save({ heightCm: 178 })
    expect(store.read()).toMatchObject({ birthYear: 1990, heightCm: 178 })
  })

  it('records which fields the user edited', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ heightCm: 178 }, { source: 'user' })
    expect(store.read().userEdited).toContain('heightCm')
  })

  it('never lets a provider prefill overwrite a user edit', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ heightCm: 178 }, { source: 'user' })
    store.save({ heightCm: 165 }, { source: 'provider' })
    expect(store.read().heightCm).toBe(178)
  })

  it('lets a provider prefill fill a field the user never touched', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ heightCm: 165 }, { source: 'provider' })
    expect(store.read().heightCm).toBe(165)
  })

  it('rejects values outside a physically plausible range', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ birthYear: 1200, heightCm: -5, measuredMaxHeartRate: 700 })
    const saved = store.read()
    expect(saved.birthYear).toBeNull()
    expect(saved.heightCm).toBeNull()
    expect(saved.measuredMaxHeartRate).toBeNull()
  })

  it('drops unknown keys rather than persisting arbitrary input', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ heightCm: 178, evil: 'payload' } as never)
    expect(store.read()).not.toHaveProperty('evil')
  })

  it('clears a field when the user explicitly blanks it', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ heightCm: 178 }, { source: 'user' })
    store.save({ heightCm: null }, { source: 'user' })
    expect(store.read().heightCm).toBeNull()
  })

  it('prefills an untouched field but never a user-edited one', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ birthYear: 1985 }, { source: 'user' })
    store.save({ birthYear: 1990, heightCm: 178 }, { source: 'provider' })
    const saved = store.read()
    expect(saved.birthYear).toBe(1985)   // the user's edit stands
    expect(saved.heightCm).toBe(178)     // the untouched field is filled
  })

  it('survives a corrupt file by returning the empty profile', () => {
    const secrets = memoryStore()
    secrets.files.set('/p', 'not an object')
    const store = createUserProfileStore({ secrets, profileFile: '/p' })
    expect(store.read()).toEqual(EMPTY_PROFILE)
  })
})
