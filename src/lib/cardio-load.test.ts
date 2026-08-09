import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '@/types'
import { dailyCardioLoad, edwardsTrimp, workloadRatio } from './cardio-load'

function workout(date: string, zones: Partial<ActivityItem['heartZoneMinutes']>): ActivityItem {
  return {
    id: `${date}-w`, name: 'Run', date, time: '08:00', durationMinutes: 40,
    calories: null, distanceKm: null, averageHeartRate: null, zoneMinutes: null,
    steps: null, averagePaceSecondsPerMeter: null,
    heartZoneMinutes: { light: null, moderate: null, vigorous: null, peak: null, ...zones },
  }
}

describe('edwardsTrimp', () => {
  it('weights each zone by its ordinal', () => {
    // 10*1 + 10*2 + 10*3 + 10*4 = 100
    expect(edwardsTrimp({ light: 10, moderate: 10, vigorous: 10, peak: 10 })).toBe(100)
  })

  it('treats an absent zone as absent, not as zero minutes of a zone that happened', () => {
    expect(edwardsTrimp({ light: 20, moderate: null, vigorous: null, peak: null })).toBe(20)
  })

  it('returns null when no zone has any minutes', () => {
    expect(edwardsTrimp({ light: null, moderate: null, vigorous: null, peak: null })).toBeNull()
    expect(edwardsTrimp(null)).toBeNull()
  })
})

describe('dailyCardioLoad', () => {
  it('sums every workout on a day and marks the source', () => {
    const loads = dailyCardioLoad([{
      date: '2026-08-01',
      activities: [workout('2026-08-01', { moderate: 10 }), workout('2026-08-01', { vigorous: 10 })],
      zoneMinutes: 99,
    }])
    expect(loads).toEqual([{ date: '2026-08-01', trimp: 20 + 30, source: 'workout-zones' }])
  })

  it('falls back to active zone minutes only when no workout has zones, and flags it', () => {
    const loads = dailyCardioLoad([{ date: '2026-08-01', activities: [], zoneMinutes: 24 }])
    expect(loads[0].source).toBe('active-zone-minutes')
    expect(loads[0].trimp).toBe(24)
  })

  it('omits a day with neither rather than recording zero load', () => {
    expect(dailyCardioLoad([{ date: '2026-08-01', activities: [], zoneMinutes: null }])).toEqual([])
  })

  it('returns days in ascending date order', () => {
    const loads = dailyCardioLoad([
      { date: '2026-08-03', activities: [], zoneMinutes: 5 },
      { date: '2026-08-01', activities: [], zoneMinutes: 5 },
    ])
    expect(loads.map((load) => load.date)).toEqual(['2026-08-01', '2026-08-03'])
  })
})

describe('workloadRatio', () => {
  function loadsFor(days: number, trimp: number, endDate = '2026-08-28'): Array<{ date: string; trimp: number; source: 'workout-zones' }> {
    const end = new Date(`${endDate}T12:00:00Z`).getTime()
    return Array.from({ length: days }, (_, index) => ({
      date: new Date(end - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10),
      trimp,
      source: 'workout-zones' as const,
    }))
  }

  it('is 1 when the acute and chronic means match', () => {
    const result = workloadRatio(loadsFor(28, 50), '2026-08-28')!
    expect(result.ratio).toBeCloseTo(1, 6)
    expect(result.sufficient).toBe(true)
    expect(result.chronicDays).toBe(28)
    expect(result.acuteDays).toBe(7)
  })

  it('rises above 1 when the last week is harder than the month', () => {
    const loads = loadsFor(28, 20)
    for (const load of loads.slice(-7)) load.trimp = 60
    const result = workloadRatio(loads, '2026-08-28')!
    expect(result.ratio).toBeGreaterThan(1.5)
  })

  it('reports insufficiency with the real day count instead of a number', () => {
    const result = workloadRatio(loadsFor(11, 50, '2026-08-11'), '2026-08-11')!
    expect(result.sufficient).toBe(false)
    expect(result.chronicDays).toBe(11)
    expect(result.requiredChronicDays).toBe(14)
  })

  it('returns null rather than infinity when the chronic mean is zero', () => {
    expect(workloadRatio(loadsFor(28, 0), '2026-08-28')).toBeNull()
  })

  it('returns null with no loads at all', () => {
    expect(workloadRatio([], '2026-08-28')).toBeNull()
  })

  it('ignores days after the end date', () => {
    const loads = [...loadsFor(28, 50), { date: '2026-09-30', trimp: 5000, source: 'workout-zones' as const }]
    expect(workloadRatio(loads, '2026-08-28')!.ratio).toBeCloseTo(1, 6)
  })
})
