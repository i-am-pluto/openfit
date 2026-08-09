import { describe, expect, it } from 'vitest'

const { cachedDay, latestDay, normalizeArchive, storeDay } = require('./health-cache.cjs')

const payload = (date: string) => ({ source: 'google-health', date, generatedAt: `${date}T12:00:00Z`, endpoints: {}, errors: [], rateLimit: {} })

describe('health history cache', () => {
  it('migrates the previous single-day cache', () => {
    const oldCache = payload('2026-06-21')
    expect(normalizeArchive(oldCache)).toMatchObject({ version: 2, lastDate: '2026-06-21', days: { '2026-06-21': oldCache } })
  })

  it('keeps every stored day and returns each one independently', () => {
    const archive = storeDay(storeDay(null, payload('2026-06-21')), payload('2026-06-22'))
    expect(cachedDay(archive, '2026-06-21')?.date).toBe('2026-06-21')
    expect(cachedDay(archive, '2026-06-22')?.date).toBe('2026-06-22')
    expect(latestDay(archive)?.date).toBe('2026-06-22')
  })

  it('replaces only the matching day', () => {
    const first = storeDay(storeDay(null, payload('2026-06-21')), payload('2026-06-22'))
    const updated = storeDay(first, { ...payload('2026-06-22'), generatedAt: 'new' })
    expect(cachedDay(updated, '2026-06-21')?.generatedAt).toBe('2026-06-21T12:00:00Z')
    expect(cachedDay(updated, '2026-06-22')?.generatedAt).toBe('new')
  })
})
