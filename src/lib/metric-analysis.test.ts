import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import { karvonenZones } from './user-profile'
import {
  bandStats,
  correlate,
  detectAnomalies,
  energyBalance,
  histogram,
  isoWeekKey,
  samplesInZones,
  weekdayProfile,
  weeklyRollup,
} from './metric-analysis'

describe('correlate', () => {
  it('returns 1 for a perfect positive relationship', () => {
    const result = correlate([1, 2, 3, 4, 5, 6, 7], [2, 4, 6, 8, 10, 12, 14])
    expect(result!.r).toBeCloseTo(1, 6)
    expect(result!.sampleCount).toBe(7)
  })

  it('returns -1 for a perfect inverse relationship', () => {
    expect(correlate([1, 2, 3, 4, 5, 6, 7], [7, 6, 5, 4, 3, 2, 1])!.r).toBeCloseTo(-1, 6)
  })

  it('matches a hand-computed value', () => {
    // Means are both 4. Covariance sum is 25, and each sum of squared deviations
    // is 28, so r = 25 / 28 = 0.8928571 to seven places.
    const result = correlate([1, 2, 3, 4, 5, 6, 7], [2, 1, 4, 3, 6, 5, 7])
    expect(result!.r).toBeCloseTo(0.8928571, 5)
  })

  it('pairs only indices where both sides are finite', () => {
    const result = correlate([1, null, 3, 4, 5, 6, 7, 8], [2, 9, 6, 8, 10, 12, 14, 16])
    expect(result!.sampleCount).toBe(7)
    expect(result!.r).toBeCloseTo(1, 6)
  })

  it('returns null below seven pairs', () => {
    expect(correlate([1, 2, 3, 4, 5, 6], [2, 4, 6, 8, 10, 12])).toBeNull()
  })

  it('returns null when either side has zero variance', () => {
    expect(correlate([1, 2, 3, 4, 5, 6, 7], [5, 5, 5, 5, 5, 5, 5])).toBeNull()
  })

  it('returns null rather than NaN for empty input', () => {
    expect(correlate([], [])).toBeNull()
  })
})

describe('detectAnomalies', () => {
  it('flags a point beyond two sigma of its trailing baseline', () => {
    // A baseline with real spread, as any recorded health series has.
    const series = [10, 12, 9, 11, 10, 40]
    const found = detectAnomalies(series)
    expect(found).toHaveLength(1)
    expect(found[0].index).toBe(5)
    expect(found[0].value).toBe(40)
  })

  it('never flags a point inside the minimum baseline window', () => {
    expect(detectAnomalies([10, 90, 10, 10])).toHaveLength(0)
  })

  it('computes the baseline from prior points only', () => {
    // Mean of [10, 12, 9, 11, 10] is 10.4 — the 40 is excluded from its own baseline.
    const found = detectAnomalies([10, 12, 9, 11, 10, 40])
    expect(found[0].baseline).toBeCloseTo(10.4, 6)
  })

  it('skips nulls without treating them as zero', () => {
    expect(detectAnomalies([10, null, 10, 10, 10, 10, 11])).toHaveLength(0)
  })

  it('returns nothing when the baseline has zero variance and the point matches', () => {
    expect(detectAnomalies([10, 10, 10, 10, 10, 10])).toHaveLength(0)
  })

  it('makes no claim at all against a flat baseline, however far the point sits', () => {
    // z is undefined without spread. Substituting a nominal sigma would put a
    // fabricated number into the evidence the UI and the assistant both cite.
    expect(detectAnomalies([10, 10, 10, 10, 10, 4000])).toHaveLength(0)
  })

  it('reports the sigma it actually measured', () => {
    const found = detectAnomalies([10, 12, 9, 11, 10, 40])
    // Population sigma of [10, 12, 9, 11, 10] is sqrt(1.04).
    expect(found[0].sigma).toBeCloseTo(Math.sqrt(1.04), 6)
    expect(found[0].z).toBeCloseTo((40 - 10.4) / Math.sqrt(1.04), 6)
  })

  it('honors a custom threshold', () => {
    const series = [10, 10, 10, 11, 10, 13]
    expect(detectAnomalies(series, { threshold: 10 })).toHaveLength(0)
  })
})

describe('isoWeekKey', () => {
  it('formats an ISO week', () => {
    expect(isoWeekKey('2026-08-09')).toMatch(/^\d{4}-W\d{2}$/)
  })

  it('assigns 1 January 2027 to the 2026 week that contains it', () => {
    // 2027-01-01 is a Friday, so ISO week 53 of 2026.
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53')
  })

  it('assigns 31 December 2029 to ISO week 1 of 2030', () => {
    // 2029-12-31 is a Monday, so ISO week 1 of 2030.
    expect(isoWeekKey('2029-12-31')).toBe('2030-W01')
  })
})

describe('weeklyRollup', () => {
  it('reports a week only when it holds at least three finite days', () => {
    const data = createDemoData('2026-06-23')
    const weeks = weeklyRollup(data.trends, (point) => point.steps)
    expect(weeks.every((week) => week.sampleCount >= 3)).toBe(true)
    expect(weeks.length).toBeGreaterThan(0)
  })

  it('excludes a sparse week rather than reporting a one-day mean', () => {
    const data = createDemoData('2026-06-23')
    const trends = data.trends.map((point, index) => (index < 12 ? { ...point, steps: null } : point))
    const weeks = weeklyRollup(trends, (point) => point.steps)
    expect(weeks.every((week) => week.sampleCount >= 3)).toBe(true)
  })
})

describe('weekdayProfile', () => {
  it('returns all seven weekdays with their real sample counts', () => {
    const data = createDemoData('2026-06-23')
    const profile = weekdayProfile(data.trends, (point) => point.steps)
    expect(profile).toHaveLength(7)
    expect(profile.reduce((sum, day) => sum + day.sampleCount, 0)).toBe(14)
  })

  it('reports a null mean rather than zero for a weekday with no data', () => {
    const profile = weekdayProfile([], (point) => point.steps)
    expect(profile.every((day) => day.mean === null && day.sampleCount === 0)).toBe(true)
  })
})

describe('histogram', () => {
  it('places every finite value in exactly one bin', () => {
    const bins = histogram([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)
    expect(bins).toHaveLength(5)
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(10)
  })

  it('includes the maximum in the final bin rather than dropping it', () => {
    const bins = histogram([0, 10], 2)
    expect(bins.at(-1)!.count).toBe(1)
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(2)
  })

  it('handles a single repeated value without dividing by zero', () => {
    const bins = histogram([5, 5, 5], 4)
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(3)
    expect(bins.every((bin) => Number.isFinite(bin.start) && Number.isFinite(bin.end))).toBe(true)
  })

  it('returns no bins for no finite values', () => {
    expect(histogram([null, null])).toHaveLength(0)
  })
})

describe('bandStats', () => {
  it('computes min, max, mean, and population standard deviation', () => {
    const stats = bandStats([2, 4, 4, 4, 5, 5, 7, 9])!
    expect(stats.min).toBe(2)
    expect(stats.max).toBe(9)
    expect(stats.mean).toBeCloseTo(5, 6)
    expect(stats.stdDev).toBeCloseTo(2, 6)
    expect(stats.sampleCount).toBe(8)
  })

  it('returns null with no finite values', () => {
    expect(bandStats([null, null])).toBeNull()
  })
})

describe('energyBalance', () => {
  it('subtracts expenditure from intake per day', () => {
    const data = createDemoData('2026-06-23')
    const balance = energyBalance(data.trends)
    expect(balance).toHaveLength(14)
    const first = data.trends[0]
    expect(balance[0].balance).toBe(first.caloriesIn! - first.calories!)
  })

  it('reports null on a day missing either side rather than assuming zero', () => {
    const data = createDemoData('2026-06-23')
    const trends = data.trends.map((point, index) => (index === 0 ? { ...point, caloriesIn: null } : point))
    expect(energyBalance(trends)[0].balance).toBeNull()
  })
})

describe('samplesInZones', () => {
  it('counts intraday samples per zone and reports their share', () => {
    const zones = karvonenZones(58, 183)!
    const intraday = [
      { time: '00:00', value: 55 },    // below light
      { time: '01:00', value: 125 },   // light
      { time: '02:00', value: 135 },   // moderate
      { time: '03:00', value: 160 },   // vigorous
      { time: '04:00', value: 180 },   // peak
    ]
    const shares = samplesInZones(intraday, zones)
    expect(shares).toHaveLength(4)
    expect(shares.reduce((sum, zone) => sum + zone.count, 0)).toBe(4)
    expect(shares.reduce((sum, zone) => sum + zone.share, 0)).toBeCloseTo(1, 6)
  })

  it('returns zero shares rather than NaN for an empty series', () => {
    const shares = samplesInZones([], karvonenZones(58, 183)!)
    expect(shares.every((zone) => zone.count === 0 && zone.share === 0)).toBe(true)
  })
})
