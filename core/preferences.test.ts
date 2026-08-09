import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPreferencesStore, EMPTY_PREFERENCES } = require('./preferences.cjs')

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

describe('preferences store', () => {
  it('returns empty preferences before anything is written', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    expect(store.read()).toEqual(EMPTY_PREFERENCES)
  })

  it('round-trips a saved favourite chart list', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    store.save({ favouriteCharts: ['steps-trend', 'sleep-stages'] })
    expect(store.read().favouriteCharts).toEqual(['sleep-stages', 'steps-trend'])
  })

  it('sorts the list so the round-trip is deterministic', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    store.save({ favouriteCharts: ['zzz', 'aaa', 'mmm'] })
    expect(store.read().favouriteCharts).toEqual(['aaa', 'mmm', 'zzz'])
  })

  it('deduplicates entries', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    store.save({ favouriteCharts: ['steps-trend', 'steps-trend', 'steps-trend'] })
    expect(store.read().favouriteCharts).toEqual(['steps-trend'])
  })

  it('trims surrounding whitespace before validating', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    store.save({ favouriteCharts: ['  steps-trend  '] })
    expect(store.read().favouriteCharts).toEqual(['steps-trend'])
  })

  it('drops an entry that trims to nothing', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    store.save({ favouriteCharts: ['', '   ', 'steps-trend'] })
    expect(store.read().favouriteCharts).toEqual(['steps-trend'])
  })

  it('drops anything that is not a kebab-case slug', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    store.save({
      favouriteCharts: [
        'Steps-Trend',        // uppercase
        'steps_trend',        // underscore
        'steps trend',        // space
        '../../etc/passwd',   // traversal
        '<script>x</script>', // markup
        'steps-trend',        // the one good id
      ],
    })
    expect(store.read().favouriteCharts).toEqual(['steps-trend'])
  })

  it('drops an entry longer than 64 characters', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    store.save({ favouriteCharts: ['a'.repeat(65), 'b'.repeat(64)] })
    expect(store.read().favouriteCharts).toEqual(['b'.repeat(64)])
  })

  it('drops entries that are not strings', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    store.save({ favouriteCharts: [1, null, undefined, {}, ['steps-trend'], true, 'steps-trend'] as never })
    expect(store.read().favouriteCharts).toEqual(['steps-trend'])
  })

  it('reads a non-array favouriteCharts as an empty list', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    store.save({ favouriteCharts: 'steps-trend' as never })
    expect(store.read().favouriteCharts).toEqual([])
  })

  it('caps the stored list at 64 entries', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    // A client bug must not be able to grow an unbounded array in the encrypted store.
    const many = Array.from({ length: 500 }, (_unused, index) => `chart-${String(index).padStart(3, '0')}`)
    store.save({ favouriteCharts: many })

    const saved = store.read().favouriteCharts
    expect(saved).toHaveLength(64)
    expect(saved[0]).toBe('chart-000')
  })

  it('merges a patch: no favouriteCharts key leaves the stored list alone', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    store.save({ favouriteCharts: ['steps-trend'] })
    store.save({})
    expect(store.read().favouriteCharts).toEqual(['steps-trend'])
  })

  it('replaces the list when the patch names it, including with an empty list', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    store.save({ favouriteCharts: ['steps-trend'] })
    store.save({ favouriteCharts: [] })
    expect(store.read().favouriteCharts).toEqual([])
  })

  it('drops unknown keys rather than persisting arbitrary input', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    store.save({ favouriteCharts: ['steps-trend'], evil: 'payload' } as never)
    expect(store.read()).not.toHaveProperty('evil')
  })

  it('returns the saved value from save()', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    expect(store.save({ favouriteCharts: ['b-chart', 'a-chart'] })).toEqual({ favouriteCharts: ['a-chart', 'b-chart'] })
  })

  it('survives a corrupt file by returning the empty preferences', () => {
    const secrets = memoryStore()
    secrets.files.set('/p', 'not an object')
    const store = createPreferencesStore({ secrets, preferencesFile: '/p' })
    expect(store.read()).toEqual(EMPTY_PREFERENCES)
  })

  it('survives an array file by returning the empty preferences', () => {
    const secrets = memoryStore()
    secrets.files.set('/p', ['steps-trend'])
    const store = createPreferencesStore({ secrets, preferencesFile: '/p' })
    expect(store.read()).toEqual(EMPTY_PREFERENCES)
  })

  it('sanitizes junk that reached the file by some other route', () => {
    const secrets = memoryStore()
    secrets.files.set('/p', { favouriteCharts: ['OK-NO', 'yes-ok', 42] })
    const store = createPreferencesStore({ secrets, preferencesFile: '/p' })
    expect(store.read().favouriteCharts).toEqual(['yes-ok'])
  })

  it('never hands out the shared empty list', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    const first = store.read()
    first.favouriteCharts.push('mutated')
    expect(store.read().favouriteCharts).toEqual([])
    expect(EMPTY_PREFERENCES.favouriteCharts).toEqual([])
  })

  it('requires a secret store and a file path', () => {
    expect(() => createPreferencesStore({ preferencesFile: '/p' })).toThrow()
    expect(() => createPreferencesStore({ secrets: memoryStore() })).toThrow()
  })

  it('describes the backend the secrets live behind', () => {
    const store = createPreferencesStore({ secrets: memoryStore(), preferencesFile: '/p' })
    expect(store.describe()).toEqual({ encrypted: true, backend: 'aes-256-gcm' })
  })
})
