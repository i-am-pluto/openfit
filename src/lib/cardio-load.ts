import type { ActivityItem, HeartZoneMinutes } from '@/types'

/**
 * Cardio load and workload ratio.
 *
 * Both figures here are composites, which HOME_DASHBOARD_MODEL.md otherwise
 * forbids. They are admitted under three constraints, and anything that cannot
 * meet all three does not belong in this file: the formula is published and
 * named, its inputs render on the same screen, and it reports in that formula's
 * own unit — never a 0-100 scale invented for OpenFit.
 */

const ACUTE_DAYS = 7
const CHRONIC_DAYS = 28
const REQUIRED_CHRONIC_DAYS = 14
const DAY_MS = 86_400_000

/** Edwards' summated heart-rate-zone weights: zone ordinal 1..4. */
export const ZONE_WEIGHTS: Record<keyof HeartZoneMinutes, number> = {
  light: 1,
  moderate: 2,
  vigorous: 3,
  peak: 4,
}

const isFinite_ = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

/**
 * Edwards TRIMP for one workout, in TRIMP points.
 *
 * The zone minutes come from the provider as true minutes per workout, so
 * unlike the intraday series there is no bucketing to correct for. Null when no
 * zone reported any minutes — a workout with no zone data has unknown load, not
 * zero load.
 */
export function edwardsTrimp(zones: HeartZoneMinutes | null | undefined): number | null {
  if (!zones) return null
  let total = 0
  let any = false
  for (const key of Object.keys(ZONE_WEIGHTS) as Array<keyof HeartZoneMinutes>) {
    const minutes = zones[key]
    if (!isFinite_(minutes)) continue
    any = true
    total += minutes * ZONE_WEIGHTS[key]
  }
  return any ? total : null
}

export interface LoadDay {
  date: string
  activities: ActivityItem[]
  zoneMinutes: number | null
}

export interface DailyLoad {
  date: string
  trimp: number
  source: 'workout-zones' | 'active-zone-minutes'
}

/**
 * One load figure per day, ascending.
 *
 * A day is omitted when neither workout zones nor an Active Zone Minutes total
 * exists: recording zero would put a rest day and an unmonitored day in the same
 * bucket, and they are not the same thing.
 */
export function dailyCardioLoad(days: LoadDay[]): DailyLoad[] {
  const loads: DailyLoad[] = []

  for (const day of days) {
    const fromWorkouts = day.activities
      .map((activity) => edwardsTrimp(activity.heartZoneMinutes))
      .filter(isFinite_)

    if (fromWorkouts.length) {
      loads.push({
        date: day.date,
        trimp: fromWorkouts.reduce((sum, value) => sum + value, 0),
        source: 'workout-zones',
      })
      continue
    }
    // Coarser and differently derived, so it carries its own source label and
    // the UI marks it. Mixing the two silently would make a trend that is partly
    // one measurement and partly another.
    if (isFinite_(day.zoneMinutes)) {
      loads.push({ date: day.date, trimp: day.zoneMinutes, source: 'active-zone-minutes' })
    }
  }

  return loads.sort((left, right) => left.date.localeCompare(right.date))
}

export interface WorkloadRatio {
  ratio: number
  acuteMean: number
  chronicMean: number
  acuteDays: number
  chronicDays: number
  /** False when the chronic window is too short for the ratio to mean anything. */
  sufficient: boolean
  requiredChronicDays: number
}

/**
 * Acute:chronic workload ratio — the 7-day mean load over the 28-day mean.
 *
 * `sufficient` is false below 14 chronic days. The caller must show the day
 * count instead of the ratio in that case: a ratio against a half-filled window
 * is not conservative, it is wrong, because the chronic mean is computed over
 * whatever happens to exist and reads as a spike.
 */
export function workloadRatio(loads: DailyLoad[], endDate: string): WorkloadRatio | null {
  const end = new Date(`${endDate}T12:00:00Z`).getTime()
  if (!Number.isFinite(end)) return null

  const within = (days: number) => loads.filter((load) => {
    const time = new Date(`${load.date}T12:00:00Z`).getTime()
    return Number.isFinite(time) && time <= end && time > end - days * DAY_MS
  })

  const acute = within(ACUTE_DAYS)
  const chronic = within(CHRONIC_DAYS)
  if (!acute.length || !chronic.length) return null

  const acuteMean = acute.reduce((sum, load) => sum + load.trimp, 0) / acute.length
  const chronicMean = chronic.reduce((sum, load) => sum + load.trimp, 0) / chronic.length
  // A zero chronic mean makes the ratio infinite, which is not a number to show.
  if (chronicMean === 0) return null

  return {
    ratio: acuteMean / chronicMean,
    acuteMean,
    chronicMean,
    acuteDays: acute.length,
    chronicDays: chronic.length,
    sufficient: chronic.length >= REQUIRED_CHRONIC_DAYS,
    requiredChronicDays: REQUIRED_CHRONIC_DAYS,
  }
}
