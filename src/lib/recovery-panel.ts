import type { DashboardData, TrendPoint } from '@/types'

/**
 * Four independent recovery signals. There is deliberately no recovery score.
 *
 * Each signal keeps its own unit and its own baseline, and nothing is summed or
 * normalized onto a shared scale. That is the design, not a gap: four signals
 * agreeing is a different morning from two pointing each way, and a single
 * number renders both as the same middling figure. Adding one later would also
 * be exactly the invented composite HOME_DASHBOARD_MODEL.md forbids.
 */

const DEFAULT_BASELINE_DAYS = 28
const DEFAULT_STRAIN_THRESHOLD = 1.5

export interface RecoverySignal {
  key: 'hrv' | 'restingHeartRate' | 'breathingRate' | 'skinTemperature'
  label: string
  unit: string
  current: number | null
  baseline: number | null
  delta: number | null
  z: number | null
  /** Which direction of change is favorable. A label for the UI, never a score. */
  favorableDirection: 'higher' | 'lower'
  sampleCount: number
}

const isFinite_ = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

interface SignalSpec {
  key: RecoverySignal['key']
  label: string
  unit: string
  favorableDirection: RecoverySignal['favorableDirection']
  current: (data: DashboardData) => number | null
  select: (point: TrendPoint) => number | null
}

const SPECS: SignalSpec[] = [
  {
    key: 'hrv', label: 'Heart-rate variability', unit: 'ms', favorableDirection: 'higher',
    current: (data) => data.health.hrvMs, select: (point) => point.hrvMs,
  },
  {
    key: 'restingHeartRate', label: 'Resting heart rate', unit: 'bpm', favorableDirection: 'lower',
    current: (data) => data.health.restingHeartRate, select: (point) => point.restingHeartRate,
  },
  {
    key: 'breathingRate', label: 'Respiratory rate', unit: '/min', favorableDirection: 'lower',
    current: (data) => data.health.breathingRate, select: (point) => point.breathingRate,
  },
  {
    // Already a deviation from the user's own baseline as the provider sends it,
    // so its baseline sits near zero and the delta is read directly.
    key: 'skinTemperature', label: 'Skin temperature', unit: '°C from baseline', favorableDirection: 'lower',
    current: (data) => data.health.skinTemperature, select: (point) => point.skinTemperature,
  },
]

export function recoveryPanel(data: DashboardData, baselineDays = DEFAULT_BASELINE_DAYS): RecoverySignal[] {
  return SPECS.map((spec) => {
    // Prior days only. Including the selected day would drag the baseline it is
    // being measured against toward itself.
    const prior = data.trends
      .filter((point) => point.date < data.selectedDate)
      .slice(-baselineDays)
      .map(spec.select)
      .filter(isFinite_)

    const current = spec.current(data)
    const baseline = prior.length ? prior.reduce((sum, value) => sum + value, 0) / prior.length : null
    const sigma = baseline === null
      ? null
      : Math.sqrt(prior.reduce((sum, value) => sum + (value - baseline) ** 2, 0) / prior.length)

    return {
      key: spec.key,
      label: spec.label,
      unit: spec.unit,
      current: isFinite_(current) ? current : null,
      baseline,
      delta: isFinite_(current) && baseline !== null ? current - baseline : null,
      z: isFinite_(current) && baseline !== null && sigma !== null && sigma > 0
        ? (current - baseline) / sigma
        : null,
      favorableDirection: spec.favorableDirection,
      sampleCount: prior.length,
    }
  })
}

/**
 * Signals deviating in the unfavorable direction beyond `threshold` sigma.
 *
 * A filter over the panel, not a reduction of it. The caller reports how many
 * signals are strained and which ones — never a combined figure.
 */
export function strainedSignals(panel: RecoverySignal[], threshold = DEFAULT_STRAIN_THRESHOLD): RecoverySignal[] {
  return panel.filter((signal) => {
    if (signal.z === null) return false
    const unfavorable = signal.favorableDirection === 'higher' ? signal.z < 0 : signal.z > 0
    return unfavorable && Math.abs(signal.z) >= threshold
  })
}
