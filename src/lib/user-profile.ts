import type { DashboardData, UserProfile } from '@/types'

export const EMPTY_USER_PROFILE: UserProfile = {
  birthYear: null,
  heightCm: null,
  measuredMaxHeartRate: null,
  stepsGoal: null,
  sleepGoalMinutes: null,
  waterGoalMl: null,
  weightGoalKg: null,
  userEdited: [],
}

export interface HeartRateZone {
  key: 'light' | 'moderate' | 'vigorous' | 'peak'
  label: string
  min: number
  max: number
}

export interface Goal {
  value: number | null
  source: 'provider' | 'profile' | null
}

export interface ResolvedGoals {
  steps: Goal
  sleepMinutes: Goal
  waterMl: Goal
  weightKg: Goal
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

/**
 * Max heart rate, with the basis attached.
 *
 * Tanaka (208 - 0.7 * age) describes a population, not this person, so the basis
 * travels with the number and the UI must say which applies. A measured value
 * always wins.
 */
export function maxHeartRate(
  profile: UserProfile,
  referenceYear: number,
): { value: number | null; basis: 'measured' | 'estimated' | null } {
  if (finite(profile.measuredMaxHeartRate)) {
    return { value: profile.measuredMaxHeartRate, basis: 'measured' }
  }
  if (finite(profile.birthYear)) {
    const age = referenceYear - profile.birthYear
    if (age > 0 && age < 130) return { value: 208 - 0.7 * age, basis: 'estimated' }
  }
  return { value: null, basis: null }
}

export function bmiFor(weightKg: number | null, profile: UserProfile): number | null {
  if (!finite(weightKg) || !finite(profile.heightCm) || profile.heightCm <= 0) return null
  const metres = profile.heightCm / 100
  return Number((weightKg / (metres * metres)).toFixed(2))
}

// Karvonen intensities. Boundaries are contiguous by construction, so a sample
// falls in exactly one zone.
const ZONE_BOUNDS: Array<{ key: HeartRateZone['key']; label: string; from: number; to: number }> = [
  { key: 'light', label: 'Light', from: 0.5, to: 0.6 },
  { key: 'moderate', label: 'Moderate', from: 0.6, to: 0.7 },
  { key: 'vigorous', label: 'Vigorous', from: 0.7, to: 0.85 },
  { key: 'peak', label: 'Peak', from: 0.85, to: 1 },
]

/**
 * Heart-rate zones over the heart-rate reserve.
 *
 * Both inputs are the user's own numbers, so these bands are personal rather
 * than a population table. Returns null when max HR is unknown — a zone chart
 * against an invented ceiling is worse than no zone chart.
 */
export function karvonenZones(restingHr: number | null, maxHr: number | null): HeartRateZone[] | null {
  if (!finite(restingHr) || !finite(maxHr)) return null
  const reserve = maxHr - restingHr
  if (reserve <= 0) return null
  return ZONE_BOUNDS.map(({ key, label, from, to }) => ({
    key,
    label,
    min: restingHr + reserve * from,
    max: restingHr + reserve * to,
  }))
}

function pick(providerValue: number | null, profileValue: number | null): Goal {
  // Provider first: a provider goal is the one the user set in the Google or
  // Fitbit app, so it outranks a value typed into OpenFit.
  if (finite(providerValue)) return { value: providerValue, source: 'provider' }
  if (finite(profileValue)) return { value: profileValue, source: 'profile' }
  return { value: null, source: null }
}

export function resolveGoals(data: DashboardData, profile: UserProfile): ResolvedGoals {
  return {
    steps: pick(data.activity.stepsGoal, profile.stepsGoal),
    sleepMinutes: pick(data.sleep.goalMinutes, profile.sleepGoalMinutes),
    waterMl: pick(data.body.waterGoalMl, profile.waterGoalMl),
    weightKg: pick(data.body.weightGoalKg, profile.weightGoalKg),
  }
}

const UNLOCKS: Array<{ field: keyof UserProfile; unlocks: string }> = [
  { field: 'birthYear', unlocks: 'Heart-rate zones and VO2 max context' },
  { field: 'heightCm', unlocks: 'BMI and its trend' },
  { field: 'measuredMaxHeartRate', unlocks: 'Heart-rate zones from a measurement instead of an estimate' },
  { field: 'stepsGoal', unlocks: 'A step goal line when your provider sends none' },
  { field: 'sleepGoalMinutes', unlocks: 'A sleep goal line and sleep goal insights' },
  { field: 'waterGoalMl', unlocks: 'A hydration goal ring' },
  { field: 'weightGoalKg', unlocks: 'A weight target on the body trend' },
]

export function profileCompleteness(profile: UserProfile) {
  return {
    missing: UNLOCKS.filter(({ field }) => !finite(profile[field] as number | null)),
  }
}
