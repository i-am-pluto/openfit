import type { TimePoint, TrendPoint } from '@/types'
import type { HeartRateZone } from './user-profile'

/**
 * Pure statistics over health series.
 *
 * Two rules run through every function here. Absent is not zero: a null is
 * excluded from the calculation and reflected in the sample count, never
 * coerced. And insufficient data returns null rather than a number: silently
 * returning NaN or 0 would let the UI and the assistant present noise as signal.
 */

const MINIMUM_CORRELATION_PAIRS = 7
const DEFAULT_ANOMALY_THRESHOLD = 2
const MINIMUM_ANOMALY_BASELINE = 4
/**
 * Spread assumed for a perfectly flat baseline, as a fraction of its mean.
 *
 * A run of identical values is an artefact of coarse reporting — a step count
 * rounded, a rate logged once a day — not evidence that the body holds a metric
 * constant. Sigma of exactly zero would make every z-score infinite, so a flat
 * window is treated as carrying ten percent variation. Skipping the point
 * instead would silently discard the clearest anomalies there are: the ones that
 * depart from a baseline that had never moved.
 */
const MINIMUM_WEEK_DAYS = 3

const isFinite_ = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

function finiteOf(values: Array<number | null | undefined>): number[] {
  return values.filter(isFinite_)
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stdDev(values: number[], average: number): number {
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length)
}

export interface CorrelationResult {
  r: number
  sampleCount: number
}

/**
 * Pearson r over indices where both series are finite.
 *
 * Null below seven pairs, because r over three points is noise shaped like
 * signal. Null on zero variance, where r is undefined rather than zero.
 */
export function correlate(a: Array<number | null>, b: Array<number | null>): CorrelationResult | null {
  const pairs: Array<[number, number]> = []
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (isFinite_(left) && isFinite_(right)) pairs.push([left, right])
  }
  if (pairs.length < MINIMUM_CORRELATION_PAIRS) return null

  const leftValues = pairs.map(([value]) => value)
  const rightValues = pairs.map(([, value]) => value)
  const leftMean = mean(leftValues)
  const rightMean = mean(rightValues)

  let covariance = 0
  let leftSquares = 0
  let rightSquares = 0
  for (const [left, right] of pairs) {
    const dx = left - leftMean
    const dy = right - rightMean
    covariance += dx * dy
    leftSquares += dx * dx
    rightSquares += dy * dy
  }
  if (leftSquares === 0 || rightSquares === 0) return null

  return { r: covariance / Math.sqrt(leftSquares * rightSquares), sampleCount: pairs.length }
}

export interface AnomalyPoint {
  index: number
  value: number
  baseline: number
  sigma: number
  z: number
}

/**
 * Flags points beyond `threshold` sigma of a trailing personal baseline.
 *
 * The baseline is strictly the prior finite points. Including the point under
 * test would bias its own z-score toward normal — it would drag the mean it is
 * being measured against.
 */
export function detectAnomalies(
  series: Array<number | null>,
  options: { threshold?: number; minimumBaseline?: number } = {},
): AnomalyPoint[] {
  const threshold = options.threshold ?? DEFAULT_ANOMALY_THRESHOLD
  const minimumBaseline = options.minimumBaseline ?? MINIMUM_ANOMALY_BASELINE
  const found: AnomalyPoint[] = []

  for (let index = 0; index < series.length; index += 1) {
    const value = series[index]
    if (!isFinite_(value)) continue
    const prior = finiteOf(series.slice(0, index))
    if (prior.length < minimumBaseline) continue
    const baseline = mean(prior)
    const sigma = stdDev(prior, baseline)
    // A baseline with no spread gives nothing to scale a deviation against, so
    // no claim can be made about the point either way. Substituting a nominal
    // sigma here would put a fabricated number into `sigma` and `z`, and those
    // travel into the insight evidence and the assistant context as if they had
    // been measured. Real health series are never exactly flat; a run that is
    // means coarse reporting, which is a reason to say less, not more.
    if (sigma === 0) continue
    const z = (value - baseline) / sigma
    if (Math.abs(z) >= threshold) found.push({ index, value, baseline, sigma, z })
  }

  return found
}

/**
 * ISO-8601 week key, e.g. "2026-W32".
 *
 * ISO weeks start on Monday and belong to the year containing their Thursday,
 * which is why late December can land in week 1 of the next year and 1 January
 * in week 52 or 53 of the previous one. Computed in UTC so a local timezone
 * cannot shift a date across a week boundary.
 */
export function isoWeekKey(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  // Shift to the Thursday of this ISO week; its calendar year is the ISO year.
  const weekday = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - weekday + 3)
  const isoYear = date.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekday + 3)
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

export interface WeekBucket {
  isoWeek: string
  mean: number
  sampleCount: number
}

/** Groups days into ISO weeks. A week with fewer than three finite days is omitted, not averaged. */
export function weeklyRollup(
  trends: TrendPoint[],
  selector: (point: TrendPoint) => number | null,
): WeekBucket[] {
  const buckets = new Map<string, number[]>()
  for (const point of trends) {
    const value = selector(point)
    if (!isFinite_(value)) continue
    const key = isoWeekKey(point.date)
    const existing = buckets.get(key)
    if (existing) existing.push(value)
    else buckets.set(key, [value])
  }
  return [...buckets.entries()]
    .filter(([, values]) => values.length >= MINIMUM_WEEK_DAYS)
    .map(([isoWeek, values]) => ({ isoWeek, mean: mean(values), sampleCount: values.length }))
    .sort((left, right) => left.isoWeek.localeCompare(right.isoWeek))
}

export interface WeekdayBucket {
  weekday: number
  label: string
  mean: number | null
  sampleCount: number
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Mean per weekday, Monday first, with the real sample count behind each mean. */
export function weekdayProfile(
  trends: TrendPoint[],
  selector: (point: TrendPoint) => number | null,
): WeekdayBucket[] {
  const buckets: number[][] = WEEKDAY_LABELS.map(() => [])
  for (const point of trends) {
    const value = selector(point)
    if (!isFinite_(value)) continue
    const [year, month, day] = point.date.split('-').map(Number)
    const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7
    buckets[weekday].push(value)
  }
  return WEEKDAY_LABELS.map((label, weekday) => ({
    weekday,
    label,
    mean: buckets[weekday].length ? mean(buckets[weekday]) : null,
    sampleCount: buckets[weekday].length,
  }))
}

export interface HistogramBin {
  start: number
  end: number
  label: string
  count: number
}

/** Equal-width bins over the finite range. The maximum falls in the last bin rather than off the end. */
export function histogram(values: Array<number | null>, binCount = 8): HistogramBin[] {
  const finite = finiteOf(values)
  if (!finite.length) return []
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  // A single repeated value has zero range; widen it so bins stay finite.
  const width = max === min ? Math.max(Math.abs(min) * 0.1, 1) / binCount : (max - min) / binCount

  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, index) => {
    const start = min + width * index
    const end = start + width
    return { start, end, label: `${Math.round(start)}-${Math.round(end)}`, count: 0 }
  })

  for (const value of finite) {
    const raw = Math.floor((value - min) / width)
    bins[Math.min(Math.max(raw, 0), binCount - 1)].count += 1
  }
  return bins
}

export interface BandStats {
  min: number
  max: number
  mean: number
  stdDev: number
  sampleCount: number
}

export function bandStats(values: Array<number | null>): BandStats | null {
  const finite = finiteOf(values)
  if (!finite.length) return null
  const average = mean(finite)
  return {
    min: Math.min(...finite),
    max: Math.max(...finite),
    mean: average,
    stdDev: stdDev(finite, average),
    sampleCount: finite.length,
  }
}

export interface EnergyBalancePoint {
  date: string
  label: string
  balance: number | null
}

/** Intake minus expenditure. Null on any day missing either side — a one-sided balance is not a balance. */
export function energyBalance(trends: TrendPoint[]): EnergyBalancePoint[] {
  return trends.map((point) => ({
    date: point.date,
    label: point.label,
    balance: isFinite_(point.caloriesIn) && isFinite_(point.calories)
      ? point.caloriesIn - point.calories
      : null,
  }))
}

export interface ZoneShare {
  key: HeartRateZone['key']
  label: string
  count: number
  share: number
}

/**
 * Share of recorded intraday samples falling in each zone.
 *
 * Deliberately samples and not minutes. `compactIntraday` in normalize.ts
 * buckets the series once it exceeds 288 points, so the interval a point
 * represents is not constant across a day; converting counts to minutes would
 * assume a uniform spacing the pipeline does not guarantee. The axis is labelled
 * as a share of samples wherever this is rendered.
 */
export function samplesInZones(intraday: TimePoint[], zones: HeartRateZone[]): ZoneShare[] {
  const counts = zones.map(() => 0)
  let total = 0

  for (const point of intraday) {
    if (!isFinite_(point.value)) continue
    for (let index = 0; index < zones.length; index += 1) {
      const zone = zones[index]
      const isLast = index === zones.length - 1
      const inside = point.value >= zone.min && (isLast ? point.value <= zone.max : point.value < zone.max)
      if (inside) {
        counts[index] += 1
        total += 1
        break
      }
    }
  }

  return zones.map((zone, index) => ({
    key: zone.key,
    label: zone.label,
    count: counts[index],
    share: total ? counts[index] / total : 0,
  }))
}
