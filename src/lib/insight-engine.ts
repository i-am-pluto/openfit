import type { DashboardData, PageId, TrendPoint, UserProfile } from '@/types'
import { bandStats, correlate, detectAnomalies, energyBalance } from './metric-analysis'
import { workloadRatio, type DailyLoad } from './cardio-load'
import { recoveryPanel, strainedSignals } from './recovery-panel'
import { resolveGoals } from './user-profile'

export interface Insight {
  id: string
  category: 'activity' | 'heart' | 'sleep' | 'recovery' | 'body' | 'data'
  severity: 'info' | 'notable' | 'attention'
  title: string
  body: string
  evidence: { label: string; value: string; baseline?: string; sampleCount: number }
  page?: PageId
  /** Seeds the assistant with an improvement request naming the metric, numbers, and window. */
  prompt: string
}

const SEVERITY_RANK: Record<Insight['severity'], number> = { attention: 0, notable: 1, info: 2 }

interface RuleContext {
  data: DashboardData
  profile: UserProfile
  loads: DailyLoad[]
  goals: ReturnType<typeof resolveGoals>
}

type Rule = (context: RuleContext) => Insight | null

const isFinite_ = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

const round = (value: number) => Math.round(value).toLocaleString('en-US')

/** Days at the end of the window a metric may miss before it counts as stopped. */
const STALE_DAYS = 3
const MINIMUM_STREAK = 3
const MINIMUM_CORRELATION = 0.5
const MINIMUM_ENERGY_DAYS = 5
const ENERGY_GAP_KCAL = 300
const MINIMUM_CONSISTENCY_DAYS = 7
const LOAD_SPIKE_RATIO = 1.5
const UNDERTRAINING_RATIO = 0.8

interface MetricSpec {
  key: string
  /** Reads naturally after "your", singular, so a body line stays grammatical. */
  label: string
  unit: string
  category: Insight['category']
  page: PageId
  select: (point: TrendPoint) => number | null
  format: (value: number) => string
}

const METRICS: Record<string, MetricSpec> = {
  steps: {
    key: 'steps', label: 'step count', unit: 'steps', category: 'activity', page: 'activity',
    select: (point) => point.steps, format: (value) => `${round(value)} steps`,
  },
  activeMinutes: {
    key: 'activeMinutes', label: 'active-minutes total', unit: 'min', category: 'activity', page: 'activity',
    select: (point) => point.activeMinutes, format: (value) => `${round(value)} min`,
  },
  restingHeartRate: {
    key: 'restingHeartRate', label: 'resting heart rate', unit: 'bpm', category: 'heart', page: 'health',
    select: (point) => point.restingHeartRate, format: (value) => `${round(value)} bpm`,
  },
  hrvMs: {
    key: 'hrvMs', label: 'HRV', unit: 'ms', category: 'heart', page: 'health',
    select: (point) => point.hrvMs, format: (value) => `${round(value)} ms`,
  },
  breathingRate: {
    key: 'breathingRate', label: 'respiratory rate', unit: '/min', category: 'heart', page: 'health',
    select: (point) => point.breathingRate, format: (value) => `${value.toFixed(1)}/min`,
  },
  spo2: {
    key: 'spo2', label: 'blood oxygen', unit: '%', category: 'heart', page: 'health',
    select: (point) => point.spo2, format: (value) => `${value.toFixed(1)}%`,
  },
  sleepMinutes: {
    key: 'sleepMinutes', label: 'sleep duration', unit: 'min', category: 'sleep', page: 'sleep',
    select: (point) => point.sleepMinutes, format: (value) => `${round(value)} min`,
  },
  sleepEfficiency: {
    key: 'sleepEfficiency', label: 'sleep efficiency', unit: '%', category: 'sleep', page: 'sleep',
    select: (point) => point.sleepEfficiency, format: (value) => `${round(value)}%`,
  },
  weight: {
    key: 'weight', label: 'weight', unit: 'kg', category: 'body', page: 'body',
    select: (point) => point.weight, format: (value) => `${value.toFixed(1)} kg`,
  },
  caloriesIn: {
    key: 'caloriesIn', label: 'logged intake', unit: 'kcal', category: 'body', page: 'body',
    select: (point) => point.caloriesIn, format: (value) => `${round(value)} kcal`,
  },
}

/** Index of the selected day inside the visible window, or -1 when it is absent. */
function selectedIndex(data: DashboardData): number {
  return data.trends.findIndex((point) => point.date === data.selectedDate)
}

/** Finite values strictly before `index` — the same trailing baseline `detectAnomalies` uses. */
function priorCount(series: Array<number | null>, index: number): number {
  return series.slice(0, index).filter(isFinite_).length
}

/**
 * Rule 1 — the selected day against a resolved goal.
 *
 * The goal's source travels into the body, so "your goal" is never ambiguous
 * between the number set in the provider's app and the one typed into OpenFit.
 * The sample count is 1 on purpose: this is one day, and saying so keeps a
 * single reading from reading like a trend.
 */
function goalDeltaRule({ data, goals }: RuleContext): Insight | null {
  const goal = goals.steps
  const steps = data.activity.steps
  if (!isFinite_(goal.value) || goal.value <= 0 || !isFinite_(steps)) return null

  const delta = steps - goal.value
  const shortfall = -delta / goal.value
  const met = delta >= 0
  const severity: Insight['severity'] = shortfall > 0.2 ? 'notable' : 'info'
  const source = goal.source === 'provider' ? 'your provider’s app' : 'your OpenFit profile'

  return {
    id: 'goal-delta-steps',
    category: 'activity',
    severity,
    title: met
      ? `Step goal met by ${round(delta)}`
      : `${round(-delta)} steps short of your goal`,
    body: met
      ? `On ${data.selectedDate} you walked ${round(steps)} steps against a goal of ${round(goal.value)}, set in ${source}.`
      : `On ${data.selectedDate} you walked ${round(steps)} steps against a goal of ${round(goal.value)}, set in ${source} — ${Math.round(shortfall * 100)} percent short.`,
    evidence: {
      label: `Steps on ${data.selectedDate}`,
      value: `${round(steps)} steps`,
      baseline: `Goal ${round(goal.value)} steps (${goal.source})`,
      sampleCount: 1,
    },
    page: 'activity',
    prompt: `On ${data.selectedDate} I recorded ${round(steps)} steps against my ${round(goal.value)} step goal from ${source}. What should I change over the next week to improve that?`,
  }
}

const BASELINE_METRICS = ['restingHeartRate', 'hrvMs', 'sleepMinutes']

/**
 * Rule 2 — the selected day beyond two sigma of its own trailing baseline.
 *
 * `detectAnomalies` returns nothing at all when the trailing window is flat,
 * and that is "no claim", not "normal": there is no spread to scale a deviation
 * against, so this rule stays silent rather than inventing a sigma to divide by.
 */
function baselineDeviationRule({ data }: RuleContext): Insight | null {
  const index = selectedIndex(data)
  if (index < 0) return null

  let best: { spec: MetricSpec; value: number; baseline: number; z: number; sampleCount: number } | null = null
  for (const key of BASELINE_METRICS) {
    const spec = METRICS[key]
    const series = data.trends.map(spec.select)
    const hit = detectAnomalies(series).find((anomaly) => anomaly.index === index)
    if (!hit) continue
    const candidate = { spec, value: hit.value, baseline: hit.baseline, z: hit.z, sampleCount: priorCount(series, index) }
    if (!best || Math.abs(candidate.z) > Math.abs(best.z)) best = candidate
  }
  if (!best || best.sampleCount <= 0) return null

  const direction = best.z > 0 ? 'above' : 'below'
  const sigma = Math.abs(best.z)
  return {
    id: `baseline-deviation-${best.spec.key}`,
    category: best.spec.category,
    severity: sigma >= 3 ? 'attention' : 'notable',
    title: `${best.spec.format(best.value)} is ${direction} your baseline`,
    body: `On ${data.selectedDate} your ${best.spec.label} read ${best.spec.format(best.value)}, ${sigma.toFixed(1)} sigma ${direction} the ${best.spec.format(best.baseline)} mean of the ${best.sampleCount} prior days in this window.`,
    evidence: {
      label: `${best.spec.label} on ${data.selectedDate}`,
      value: best.spec.format(best.value),
      baseline: `${best.spec.format(best.baseline)} over ${best.sampleCount} prior days`,
      sampleCount: best.sampleCount,
    },
    page: best.spec.page,
    prompt: `My ${best.spec.label} on ${data.selectedDate} was ${best.spec.format(best.value)}, ${sigma.toFixed(1)} sigma ${direction} my ${best.spec.format(best.baseline)} baseline over the prior ${best.sampleCount} days. What should I change to improve it?`,
  }
}

/**
 * Rule 3 — consecutive days meeting the step goal, counted back from the
 * selected day. A missing day breaks the run rather than extending it: an
 * unrecorded day is not a day the goal was met.
 */
function streakRule({ data, goals }: RuleContext): Insight | null {
  const goal = goals.steps
  const index = selectedIndex(data)
  if (!isFinite_(goal.value) || goal.value <= 0 || index < 0) return null

  let streak = 0
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const steps = data.trends[cursor].steps
    if (!isFinite_(steps) || steps < goal.value) break
    streak += 1
  }
  if (streak < MINIMUM_STREAK) return null

  const from = data.trends[index - streak + 1].date
  return {
    id: 'streak-steps',
    category: 'activity',
    severity: 'info',
    title: `${streak}-day step-goal streak`,
    body: `You met your ${round(goal.value)} step goal on every day from ${from} through ${data.selectedDate} — ${streak} consecutive days in this window.`,
    evidence: {
      label: 'Consecutive days at goal',
      value: `${streak} days`,
      baseline: `Goal ${round(goal.value)} steps (${goal.source})`,
      sampleCount: streak,
    },
    page: 'activity',
    prompt: `I have met my ${round(goal.value)} step goal for ${streak} consecutive days, ${from} through ${data.selectedDate}. What should I change to improve on that without overreaching?`,
  }
}

interface CorrelationCandidate {
  id: string
  left: string
  right: string
  category: Insight['category']
  page: PageId
}

// Fixed and ordered, so the same window always evaluates the same pairs in the
// same sequence and ties resolve identically on every render.
const CORRELATION_CANDIDATES: CorrelationCandidate[] = [
  { id: 'correlation-hrv-resting-hr', left: 'hrvMs', right: 'restingHeartRate', category: 'heart', page: 'health' },
  { id: 'correlation-sleep-efficiency', left: 'sleepMinutes', right: 'sleepEfficiency', category: 'sleep', page: 'sleep' },
  { id: 'correlation-steps-sleep', left: 'steps', right: 'sleepMinutes', category: 'activity', page: 'activity' },
  { id: 'correlation-active-minutes-resting-hr', left: 'activeMinutes', right: 'restingHeartRate', category: 'heart', page: 'health' },
]

/**
 * Rule 4 — the strongest qualifying association in the window.
 *
 * Phrased as "moves with" / "moves against" and nothing stronger. Two series
 * moving together says nothing about which one moves the other, or whether a
 * third thing moves both, and wording that implies otherwise would be a claim
 * the arithmetic cannot support.
 */
function correlationRule({ data }: RuleContext): Insight | null {
  let best: { candidate: CorrelationCandidate; r: number; sampleCount: number } | null = null
  for (const candidate of CORRELATION_CANDIDATES) {
    const left = METRICS[candidate.left]
    const right = METRICS[candidate.right]
    const result = correlate(data.trends.map(left.select), data.trends.map(right.select))
    if (!result || Math.abs(result.r) < MINIMUM_CORRELATION) continue
    if (!best || Math.abs(result.r) > Math.abs(best.r)) best = { candidate, r: result.r, sampleCount: result.sampleCount }
  }
  if (!best) return null

  const left = METRICS[best.candidate.left]
  const right = METRICS[best.candidate.right]
  const direction = best.r > 0 ? 'moves with' : 'moves against'
  const figure = `r = ${best.r.toFixed(2)}`

  return {
    id: best.candidate.id,
    category: best.candidate.category,
    severity: 'info',
    title: `Your ${left.label} ${direction} your ${right.label}`,
    body: `Across ${best.sampleCount} paired days in this window your ${left.label} ${direction} your ${right.label} (${figure}). This is an association in your own data — the arithmetic cannot say which way any influence runs, or whether a third factor moves both.`,
    evidence: {
      label: `${left.label} against ${right.label}`,
      value: figure,
      baseline: `${best.sampleCount} paired days`,
      sampleCount: best.sampleCount,
    },
    page: best.candidate.page,
    prompt: `In my last ${best.sampleCount} days my ${left.label} ${direction} my ${right.label} (${figure}). What should I change to improve both, keeping in mind this is only an association?`,
  }
}

const ANOMALY_METRICS = ['steps', 'restingHeartRate', 'hrvMs', 'sleepMinutes']

/**
 * Rule 5 — the most recent flagged day in the window other than the selected
 * one, which rule 2 already covers. Reporting the same day twice would look
 * like two findings.
 */
function anomalyDayRule({ data }: RuleContext): Insight | null {
  const selected = selectedIndex(data)
  let best: { spec: MetricSpec; index: number; value: number; baseline: number; z: number; sampleCount: number } | null = null

  for (const key of ANOMALY_METRICS) {
    const spec = METRICS[key]
    const series = data.trends.map(spec.select)
    for (const anomaly of detectAnomalies(series)) {
      if (anomaly.index === selected) continue
      if (best && anomaly.index <= best.index) continue
      best = {
        spec,
        index: anomaly.index,
        value: anomaly.value,
        baseline: anomaly.baseline,
        z: anomaly.z,
        sampleCount: priorCount(series, anomaly.index),
      }
    }
  }
  if (!best || best.sampleCount <= 0) return null

  const date = data.trends[best.index].date
  const direction = best.z > 0 ? 'above' : 'below'
  const sigma = Math.abs(best.z)
  return {
    id: `anomaly-day-${best.spec.key}`,
    category: best.spec.category,
    severity: 'notable',
    title: `${date} stands out for ${best.spec.label}`,
    body: `Your ${best.spec.label} on ${date} was ${best.spec.format(best.value)}, ${sigma.toFixed(1)} sigma ${direction} the ${best.spec.format(best.baseline)} mean of the ${best.sampleCount} days before it.`,
    evidence: {
      label: `${best.spec.label} on ${date}`,
      value: best.spec.format(best.value),
      baseline: `${best.spec.format(best.baseline)} over ${best.sampleCount} prior days`,
      sampleCount: best.sampleCount,
    },
    page: best.spec.page,
    prompt: `On ${date} my ${best.spec.label} was ${best.spec.format(best.value)} against a ${best.spec.format(best.baseline)} baseline from the ${best.sampleCount} days before it. What should I look at to improve days like that one?`,
  }
}

/**
 * Rule 6 — a sustained gap between logged intake and expenditure.
 *
 * Only days with both sides logged count, and fewer than five of them is a
 * logging artefact rather than a pattern. An unlogged meal is absent, not a
 * deficit, so the rule stays silent instead of reporting a shortfall the user
 * simply did not type in.
 */
function energyBalanceRule({ data }: RuleContext): Insight | null {
  const balances = energyBalance(data.trends)
    .map((point) => point.balance)
    .filter(isFinite_)
  if (balances.length < MINIMUM_ENERGY_DAYS) return null

  // The signed mean, then its magnitude: alternating surpluses and deficits
  // average out to no sustained gap, which is exactly what this rule is for.
  const meanBalance = balances.reduce((sum, value) => sum + value, 0) / balances.length
  if (Math.abs(meanBalance) <= ENERGY_GAP_KCAL) return null

  const surplus = meanBalance > 0
  const magnitude = `${surplus ? '+' : '-'}${round(Math.abs(meanBalance))} kcal/day`
  return {
    id: 'energy-balance',
    category: 'body',
    severity: 'notable',
    title: surplus ? `Intake runs ${round(Math.abs(meanBalance))} kcal/day above burn` : `Intake runs ${round(Math.abs(meanBalance))} kcal/day below burn`,
    body: `Across the ${balances.length} days in this window with both intake and expenditure logged, your daily balance averaged ${magnitude}. Days missing either side are excluded rather than counted as nil.`,
    evidence: {
      label: 'Mean daily energy balance',
      value: magnitude,
      baseline: `${balances.length} days with both sides logged`,
      sampleCount: balances.length,
    },
    page: 'body',
    prompt: `My logged intake and expenditure differ by ${magnitude} on average across ${balances.length} fully logged days in this window. What should I change to improve that balance?`,
  }
}

const CONSISTENCY_TARGETS: Array<{ key: string; threshold: number }> = [
  { key: 'sleepMinutes', threshold: 0.25 },
  { key: 'steps', threshold: 0.5 },
]

/**
 * Rule 7 — coefficient of variation against the same user's history.
 *
 * The comparison is this window against itself, never against a population
 * spread: there is no "normal" variability to hold anyone to, only how steady
 * they are relative to their own recent days.
 */
function consistencyRule({ data }: RuleContext): Insight | null {
  let best: { spec: MetricSpec; cv: number; threshold: number; mean: number; stdDev: number; sampleCount: number } | null = null

  for (const target of CONSISTENCY_TARGETS) {
    const spec = METRICS[target.key]
    const stats = bandStats(data.trends.map(spec.select))
    if (!stats || stats.sampleCount < MINIMUM_CONSISTENCY_DAYS || stats.mean <= 0) continue
    const cv = stats.stdDev / stats.mean
    if (cv <= target.threshold) continue
    const candidate = { spec, cv, threshold: target.threshold, mean: stats.mean, stdDev: stats.stdDev, sampleCount: stats.sampleCount }
    if (!best || candidate.cv / candidate.threshold > best.cv / best.threshold) best = candidate
  }
  if (!best) return null

  return {
    id: `consistency-${best.spec.key}`,
    category: best.spec.category,
    severity: 'notable',
    title: `Your ${best.spec.label} swings widely day to day`,
    body: `Across ${best.sampleCount} days your ${best.spec.label} varied by ${best.spec.format(best.stdDev)} around a ${best.spec.format(best.mean)} mean — a coefficient of variation of ${best.cv.toFixed(2)}, past the ${best.threshold.toFixed(2)} mark for this metric. That is measured against your own history in this window, not against anyone else.`,
    evidence: {
      label: `${best.spec.label} coefficient of variation`,
      value: best.cv.toFixed(2),
      baseline: `${best.spec.format(best.stdDev)} around a ${best.spec.format(best.mean)} mean`,
      sampleCount: best.sampleCount,
    },
    page: best.spec.page,
    prompt: `My ${best.spec.label} varied by ${best.spec.format(best.stdDev)} around a ${best.spec.format(best.mean)} mean over ${best.sampleCount} days (coefficient of variation ${best.cv.toFixed(2)}). What should I change to improve how steady it is?`,
  }
}

const COMPLETENESS_METRICS = [
  'steps', 'restingHeartRate', 'hrvMs', 'breathingRate', 'spo2',
  'sleepMinutes', 'sleepEfficiency', 'weight', 'caloriesIn',
]

/**
 * Rule 8 — a metric that reported earlier in the window and has stopped.
 *
 * The body says the metric stopped reporting. It never says the value is nil:
 * a tracker left on the charger and a day of no movement are different facts,
 * and only one of them is about the user's health.
 */
function dataCompletenessRule({ data }: RuleContext): Insight | null {
  if (data.trends.length <= STALE_DAYS) return null
  const recent = data.trends.slice(-STALE_DAYS)
  const earlier = data.trends.slice(0, -STALE_DAYS)

  for (const key of COMPLETENESS_METRICS) {
    const spec = METRICS[key]
    if (recent.some((point) => isFinite_(spec.select(point)))) continue
    const reported = earlier.filter((point) => isFinite_(spec.select(point)))
    if (!reported.length) continue

    const last = reported[reported.length - 1].date
    return {
      id: `data-completeness-${spec.key}`,
      category: 'data',
      severity: 'notable',
      title: `Your ${spec.label} stopped reporting`,
      body: `Your ${spec.label} stopped reporting after ${last}. It has a value on ${reported.length} days of this window and none in the last ${STALE_DAYS}. Those days are missing data, not a measurement of nil — nothing here is counted as a low reading.`,
      evidence: {
        label: `${spec.label} last reported`,
        value: `${last}, then nothing for ${STALE_DAYS} days`,
        baseline: `${reported.length} days reported earlier in this window`,
        sampleCount: reported.length,
      },
      page: 'devices',
      prompt: `My ${spec.label} stopped reporting after ${last}, with ${reported.length} days recorded earlier in the window. What should I check on my device or sync to improve that coverage?`,
    }
  }
  return null
}

/**
 * Rules 9 and 10 — the acute:chronic workload ratio.
 *
 * Both stay silent while the chronic window is short. A ratio against a
 * half-filled 28 days is not a cautious estimate, it is a wrong one: the
 * chronic mean is taken over whatever exists and any ordinary week reads as a
 * spike against it.
 */
function loadRatioFor(context: RuleContext) {
  const ratio = workloadRatio(context.loads, context.data.selectedDate)
  if (!ratio || !ratio.sufficient || ratio.chronicDays <= 0) return null
  return ratio
}

function loadSpikeRule(context: RuleContext): Insight | null {
  const ratio = loadRatioFor(context)
  if (!ratio || ratio.ratio <= LOAD_SPIKE_RATIO) return null

  const acute = Math.round(ratio.acuteMean)
  const chronic = Math.round(ratio.chronicMean)
  return {
    id: 'load-spike',
    category: 'activity',
    severity: 'attention',
    title: `Cardio load is ramping fast (${ratio.ratio.toFixed(2)})`,
    body: `Your last 7 days averaged ${acute} TRIMP a day against a 28-day mean of ${chronic}, an acute:chronic ratio of ${ratio.ratio.toFixed(2)} over ${ratio.chronicDays} recorded days. Ratios above ${LOAD_SPIKE_RATIO} mark a faster ramp than the chronic base supports.`,
    evidence: {
      label: 'Acute:chronic load',
      value: ratio.ratio.toFixed(2),
      baseline: `28-day mean ${chronic} TRIMP`,
      sampleCount: ratio.chronicDays,
    },
    page: 'activity',
    prompt: `My acute:chronic workload ratio is ${ratio.ratio.toFixed(2)} — a 7-day mean of ${acute} TRIMP against a 28-day mean of ${chronic} TRIMP over ${ratio.chronicDays} recorded days. What should I change over the next week to improve how I am ramping load?`,
  }
}

function undertrainingRule(context: RuleContext): Insight | null {
  const ratio = loadRatioFor(context)
  if (!ratio || ratio.ratio >= UNDERTRAINING_RATIO) return null

  const acute = Math.round(ratio.acuteMean)
  const chronic = Math.round(ratio.chronicMean)
  return {
    id: 'undertraining',
    category: 'activity',
    severity: 'info',
    title: `Cardio load has eased off (${ratio.ratio.toFixed(2)})`,
    body: `Your last 7 days averaged ${acute} TRIMP a day against a 28-day mean of ${chronic}, an acute:chronic ratio of ${ratio.ratio.toFixed(2)} over ${ratio.chronicDays} recorded days. Below ${UNDERTRAINING_RATIO} the recent week sits under the base you had built.`,
    evidence: {
      label: 'Acute:chronic load',
      value: ratio.ratio.toFixed(2),
      baseline: `28-day mean ${chronic} TRIMP`,
      sampleCount: ratio.chronicDays,
    },
    page: 'activity',
    prompt: `My acute:chronic workload ratio is ${ratio.ratio.toFixed(2)} — a 7-day mean of ${acute} TRIMP against a 28-day mean of ${chronic} TRIMP over ${ratio.chronicDays} recorded days. What should I change over the next week to improve on that base?`,
  }
}

/**
 * Rule 11 — two or more recovery signals strained on the same day.
 *
 * The count reports the weakest evidence behind it, not the best: a signal with
 * six baseline days does not become sturdier by sitting next to one with
 * twenty-eight.
 */
function multiSignalStrainRule({ data }: RuleContext): Insight | null {
  const strained = strainedSignals(recoveryPanel(data))
  if (strained.length < 2) return null

  const sampleCount = Math.min(...strained.map((signal) => signal.sampleCount))
  const detail = strained
    .map((signal) => `${signal.label} ${signal.current}${signal.unit === '/min' ? '' : ' '}${signal.unit} (z ${signal.z!.toFixed(1)})`)
    .join('; ')
  const names = strained.map((signal) => signal.label).join(' and ')

  return {
    id: 'multi-signal-strain',
    category: 'recovery',
    severity: 'attention',
    title: `${strained.length} recovery signals strained`,
    body: `On ${data.selectedDate}, ${names} each sat beyond 1.5 sigma in the unfavorable direction against their own baselines: ${detail}. They are reported separately, with no combined score.`,
    evidence: {
      label: 'Signals beyond 1.5 sigma',
      value: detail,
      baseline: `${sampleCount} baseline days behind the weakest signal`,
      sampleCount,
    },
    page: 'health',
    prompt: `On ${data.selectedDate} these recovery signals were strained against my own baselines: ${detail}. What should I change over the next few days to improve them?`,
  }
}

const RULES: Rule[] = [
  goalDeltaRule,
  baselineDeviationRule,
  streakRule,
  correlationRule,
  anomalyDayRule,
  energyBalanceRule,
  consistencyRule,
  dataCompletenessRule,
  loadSpikeRule,
  undertrainingRule,
  multiSignalStrainRule,
]

/**
 * Deterministic, severity-ordered insights.
 *
 * Every rule cites evidence or returns null. An insight without a real sample
 * count is a claim OpenFit cannot back, which HOME_DASHBOARD_MODEL.md forbids —
 * so a rule that cannot fill `evidence` must stay silent rather than soften its
 * wording.
 */
export function buildInsights(
  data: DashboardData,
  profile: UserProfile,
  options: { loads?: DailyLoad[] } = {},
): Insight[] {
  const context: RuleContext = {
    data,
    profile,
    loads: options.loads ?? [],
    goals: resolveGoals(data, profile),
  }
  return RULES
    .map((rule) => {
      try {
        return rule(context)
      } catch {
        // A rule that throws must not take the whole feed down with it.
        return null
      }
    })
    .filter((insight): insight is Insight => insight !== null && insight.evidence.sampleCount > 0)
    .sort((left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || left.id.localeCompare(right.id))
}
