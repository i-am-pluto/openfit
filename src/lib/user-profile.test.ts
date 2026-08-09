import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import {
  EMPTY_USER_PROFILE,
  bmiFor,
  karvonenZones,
  maxHeartRate,
  profileCompleteness,
  resolveGoals,
} from './user-profile'

const profile = { ...EMPTY_USER_PROFILE }

describe('maxHeartRate', () => {
  it('uses the Tanaka estimate from birth year', () => {
    // age 36 -> 208 - 0.7 * 36 = 182.8
    const result = maxHeartRate({ ...profile, birthYear: 1990 }, 2026)
    expect(result.value).toBeCloseTo(182.8, 1)
    expect(result.basis).toBe('estimated')
  })

  it('prefers a measured value over the estimate', () => {
    const result = maxHeartRate({ ...profile, birthYear: 1990, measuredMaxHeartRate: 194 }, 2026)
    expect(result.value).toBe(194)
    expect(result.basis).toBe('measured')
  })

  it('returns null with no basis when neither is known', () => {
    expect(maxHeartRate(profile, 2026)).toEqual({ value: null, basis: null })
  })
})

describe('bmiFor', () => {
  it('derives BMI from weight and height', () => {
    expect(bmiFor(72.4, { ...profile, heightCm: 178 })).toBeCloseTo(22.85, 2)
  })

  it('returns null without a height', () => {
    expect(bmiFor(72.4, profile)).toBeNull()
  })

  it('returns null without a weight', () => {
    expect(bmiFor(null, { ...profile, heightCm: 178 })).toBeNull()
  })
})

describe('karvonenZones', () => {
  it('spans the heart-rate reserve between resting and max', () => {
    const zones = karvonenZones(58, 183)
    expect(zones).not.toBeNull()
    expect(zones!).toHaveLength(4)
    // reserve 125; light starts at 58 + 125 * 0.5 = 120.5
    expect(zones![0].min).toBeCloseTo(120.5, 1)
    expect(zones!.at(-1)!.max).toBe(183)
  })

  it('produces contiguous, ascending bands', () => {
    const zones = karvonenZones(58, 183)!
    for (let index = 1; index < zones.length; index += 1) {
      expect(zones[index].min).toBeCloseTo(zones[index - 1].max, 5)
      expect(zones[index].max).toBeGreaterThan(zones[index].min)
    }
  })

  it('returns null without a max heart rate', () => {
    expect(karvonenZones(58, null)).toBeNull()
  })

  it('returns null when resting is not below max', () => {
    expect(karvonenZones(190, 183)).toBeNull()
  })
})

describe('resolveGoals', () => {
  it('prefers the provider goal over the profile', () => {
    const data = createDemoData('2026-06-23')   // demo supplies stepsGoal 10000
    const goals = resolveGoals(data, { ...profile, stepsGoal: 7000 })
    expect(goals.steps).toEqual({ value: 10_000, source: 'provider' })
  })

  it('falls back to the profile when the provider sends none', () => {
    const data = createDemoData('2026-06-23')
    data.activity.stepsGoal = null
    const goals = resolveGoals(data, { ...profile, stepsGoal: 7000 })
    expect(goals.steps).toEqual({ value: 7_000, source: 'profile' })
  })

  it('reports absence rather than zero when neither has a goal', () => {
    const data = createDemoData('2026-06-23')
    data.activity.stepsGoal = null
    expect(resolveGoals(data, profile).steps).toEqual({ value: null, source: null })
  })
})

describe('profileCompleteness', () => {
  it('names what each missing field would unlock', () => {
    const missing = profileCompleteness(profile).missing
    expect(missing.map((entry) => entry.field)).toContain('birthYear')
    expect(missing.find((entry) => entry.field === 'birthYear')!.unlocks).toMatch(/heart.rate zone/i)
  })

  it('reports nothing missing once every field is set', () => {
    const complete = {
      ...profile,
      birthYear: 1990,
      heightCm: 178,
      measuredMaxHeartRate: 194,
      stepsGoal: 10_000,
      sleepGoalMinutes: 480,
      waterGoalMl: 2_500,
      weightGoalKg: 71.5,
    }
    expect(profileCompleteness(complete).missing).toHaveLength(0)
  })
})
