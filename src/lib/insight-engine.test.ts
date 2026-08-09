import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import type { DailyLoad } from './cardio-load'
import { EMPTY_USER_PROFILE } from './user-profile'
import { buildInsights } from './insight-engine'

const profile = { ...EMPTY_USER_PROFILE }

/** 28 consecutive days ending on the demo's selected date. */
function loadsEnding(trimpAt: (index: number) => number, days = 28): DailyLoad[] {
  return Array.from({ length: days }, (_, index) => ({
    date: new Date(Date.UTC(2026, 5, 23) - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10),
    trimp: trimpAt(index),
    source: 'workout-zones' as const,
  }))
}

describe('buildInsights', () => {
  it('is deterministic for the same input', () => {
    const data = createDemoData('2026-06-23')
    expect(buildInsights(data, profile)).toEqual(buildInsights(data, profile))
  })

  it('orders attention before notable before info', () => {
    const insights = buildInsights(createDemoData('2026-06-23'), profile)
    const rank = { attention: 0, notable: 1, info: 2 }
    const ranks = insights.map((insight) => rank[insight.severity])
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right))
  })

  it('gives every insight cited evidence with a real sample count', () => {
    for (const insight of buildInsights(createDemoData('2026-06-23'), profile)) {
      expect(insight.evidence.value).toBeTruthy()
      expect(insight.evidence.sampleCount).toBeGreaterThan(0)
    }
  })

  it('seeds every prompt with the metric and an improvement request', () => {
    for (const insight of buildInsights(createDemoData('2026-06-23'), profile)) {
      expect(insight.prompt.length).toBeGreaterThan(20)
      expect(insight.prompt).toMatch(/improve|change|what should/i)
    }
  })

  it('gives every insight a unique id', () => {
    const ids = buildInsights(createDemoData('2026-06-23'), profile).map((insight) => insight.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('emits nothing rather than guessing when there is no data', () => {
    const empty = createDemoData('2026-06-23')
    empty.trends = []
    empty.activities = []
    empty.activity = { ...empty.activity, steps: null, stepsGoal: null, zoneMinutes: null }
    expect(buildInsights(empty, profile).every((insight) => insight.evidence.sampleCount > 0)).toBe(true)
  })

  it('never reports an absent metric as zero', () => {
    const data = createDemoData('2026-06-23')
    data.body.caloriesIn = null
    data.trends = data.trends.map((point) => ({ ...point, caloriesIn: null }))
    const balance = buildInsights(data, profile).find((insight) => insight.id.startsWith('energy-balance'))
    expect(balance).toBeUndefined()
  })

  it('phrases a correlation as association, never causation', () => {
    const correlations = buildInsights(createDemoData('2026-06-23'), profile)
      .filter((insight) => insight.id.startsWith('correlation'))
    for (const insight of correlations) {
      expect(insight.body).not.toMatch(/\bcauses?\b|\bbecause\b|\bleads to\b/i)
    }
  })

  it('flags a load spike when the acute:chronic ratio exceeds 1.5', () => {
    const data = createDemoData('2026-06-23')
    const loads = Array.from({ length: 28 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 4, 27 + index)).toISOString().slice(0, 10),
      trimp: index >= 21 ? 120 : 20,
      source: 'workout-zones' as const,
    }))
    const spike = buildInsights(data, profile, { loads }).find((insight) => insight.id === 'load-spike')
    expect(spike).toBeDefined()
    expect(spike!.severity).toBe('attention')
    expect(spike!.evidence.value).toMatch(/\d/)
  })

  it('stays silent on load when the chronic window is too short', () => {
    const data = createDemoData('2026-06-23')
    const loads = Array.from({ length: 8 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 5, 16 + index)).toISOString().slice(0, 10),
      trimp: 100,
      source: 'workout-zones' as const,
    }))
    expect(buildInsights(data, profile, { loads }).find((insight) => insight.id === 'load-spike')).toBeUndefined()
  })

  it('raises multi-signal strain only when two or more signals deviate unfavorably', () => {
    const data = createDemoData('2026-06-23')
    // The baseline needs real spread: `detectAnomalies` and `recoveryPanel` both
    // refuse to score a point against a flat window, so a constant history would
    // produce a null z and no strain at all.
    data.trends = data.trends.map((point, index) => ({
      ...point,
      hrvMs: 50 + (index % 3),
      restingHeartRate: 58 + (index % 2),
    }))
    data.health.hrvMs = 20        // far below baseline: unfavorable
    data.health.restingHeartRate = 75  // far above baseline: unfavorable
    const strain = buildInsights(data, profile).find((insight) => insight.id === 'multi-signal-strain')
    expect(strain).toBeDefined()
    expect(strain!.severity).toBe('attention')
  })

  it('stays silent on strain when only one signal deviates unfavorably', () => {
    const data = createDemoData('2026-06-23')
    data.trends = data.trends.map((point, index) => ({
      ...point,
      hrvMs: 50 + (index % 3),
      restingHeartRate: 58 + (index % 2),
    }))
    data.health.hrvMs = 20
    data.health.restingHeartRate = 58
    expect(buildInsights(data, profile).find((insight) => insight.id === 'multi-signal-strain')).toBeUndefined()
  })
})

describe('goal delta rule', () => {
  it('reports the selected day against the resolved goal and names its source', () => {
    const goal = buildInsights(createDemoData('2026-06-23'), profile)
      .find((insight) => insight.id === 'goal-delta-steps')
    expect(goal).toBeDefined()
    expect(goal!.severity).toBe('notable')  // 6,196 of 10,000 is more than 20 percent short
    expect(goal!.evidence.sampleCount).toBe(1)
    expect(goal!.evidence.baseline).toMatch(/10,000/)
    expect(goal!.body).toMatch(/provider/i)
  })

  it('stays silent when no goal is resolved from provider or profile', () => {
    const data = createDemoData('2026-06-23')
    data.activity = { ...data.activity, stepsGoal: null }
    expect(buildInsights(data, profile).find((insight) => insight.id === 'goal-delta-steps')).toBeUndefined()
  })
})

describe('baseline deviation rule', () => {
  it('fires when the selected day sits beyond two sigma of its own baseline', () => {
    const data = createDemoData('2026-06-23')
    data.trends = data.trends.map((point, index) => ({
      ...point,
      restingHeartRate: index === data.trends.length - 1 ? 90 : 58 + (index % 3),
    }))
    const deviation = buildInsights(data, profile)
      .find((insight) => insight.id === 'baseline-deviation-restingHeartRate')
    expect(deviation).toBeDefined()
    expect(deviation!.severity).toBe('attention')  // far beyond three sigma
    expect(deviation!.evidence.sampleCount).toBe(13)
    expect(deviation!.evidence.baseline).toBeTruthy()
  })

  it('makes no claim when the trailing baseline has no spread', () => {
    const data = createDemoData('2026-06-23')
    // A flat baseline gives nothing to scale a deviation against, so
    // `detectAnomalies` returns nothing at all. That is "no claim", not "normal".
    data.trends = data.trends.map((point, index) => ({
      ...point,
      restingHeartRate: index === data.trends.length - 1 ? 90 : 58,
    }))
    expect(buildInsights(data, profile)
      .find((insight) => insight.id === 'baseline-deviation-restingHeartRate')).toBeUndefined()
  })

  it('stays silent when the selected day sits inside its baseline', () => {
    expect(buildInsights(createDemoData('2026-06-23'), profile)
      .find((insight) => insight.id.startsWith('baseline-deviation'))).toBeUndefined()
  })
})

describe('streak rule', () => {
  it('counts consecutive days meeting the goal', () => {
    const data = createDemoData('2026-06-23')
    data.trends = data.trends.map((point) => ({ ...point, steps: 12_000 }))
    const streak = buildInsights(data, profile).find((insight) => insight.id === 'streak-steps')
    expect(streak).toBeDefined()
    expect(streak!.severity).toBe('info')
    expect(streak!.evidence.sampleCount).toBe(14)
  })

  it('stays silent below three consecutive days', () => {
    const data = createDemoData('2026-06-23')
    data.trends = data.trends.map((point, index) => ({
      ...point,
      steps: index >= data.trends.length - 2 ? 12_000 : 3_000,
    }))
    expect(buildInsights(data, profile).find((insight) => insight.id === 'streak-steps')).toBeUndefined()
  })
})

describe('correlation rule', () => {
  it('reports the strongest qualifying pair as an association', () => {
    const correlation = buildInsights(createDemoData('2026-06-23'), profile)
      .find((insight) => insight.id.startsWith('correlation'))
    expect(correlation).toBeDefined()
    expect(correlation!.body).toMatch(/moves with|moves against/)
    expect(correlation!.evidence.sampleCount).toBeGreaterThanOrEqual(7)
    expect(correlation!.evidence.value).toMatch(/r = -?\d/)
  })

  it('stays silent below seven paired days', () => {
    const data = createDemoData('2026-06-23')
    data.trends = data.trends.slice(-5)
    expect(buildInsights(data, profile).find((insight) => insight.id.startsWith('correlation'))).toBeUndefined()
  })
})

describe('anomaly day rule', () => {
  it('reports the most recent flagged day that is not the selected day', () => {
    const anomaly = buildInsights(createDemoData('2026-06-23'), profile)
      .find((insight) => insight.id.startsWith('anomaly-day'))
    expect(anomaly).toBeDefined()
    expect(anomaly!.severity).toBe('notable')
    expect(anomaly!.body).not.toMatch('2026-06-23')
    expect(anomaly!.evidence.sampleCount).toBeGreaterThan(0)
  })

  it('stays silent when no day has enough baseline behind it', () => {
    const data = createDemoData('2026-06-23')
    data.trends = data.trends.slice(0, 4)
    expect(buildInsights(data, profile).find((insight) => insight.id.startsWith('anomaly-day'))).toBeUndefined()
  })
})

describe('energy balance rule', () => {
  it('fires on a sustained gap when both sides are logged', () => {
    const data = createDemoData('2026-06-23')
    data.trends = data.trends.map((point) => ({ ...point, caloriesIn: (point.calories ?? 0) + 600 }))
    const balance = buildInsights(data, profile).find((insight) => insight.id === 'energy-balance')
    expect(balance).toBeDefined()
    expect(balance!.evidence.sampleCount).toBe(14)
    expect(balance!.evidence.value).toMatch(/600|59\d|60\d/)
  })

  it('stays silent below five complete days', () => {
    const data = createDemoData('2026-06-23')
    data.trends = data.trends.map((point, index) => ({
      ...point,
      caloriesIn: index >= data.trends.length - 4 ? (point.calories ?? 0) + 900 : null,
    }))
    expect(buildInsights(data, profile).find((insight) => insight.id === 'energy-balance')).toBeUndefined()
  })

  it('stays silent on the demo window, where the gap is under 300 kcal', () => {
    expect(buildInsights(createDemoData('2026-06-23'), profile)
      .find((insight) => insight.id === 'energy-balance')).toBeUndefined()
  })
})

describe('consistency rule', () => {
  it('fires on high variability against the user own history', () => {
    const data = createDemoData('2026-06-23')
    data.trends = data.trends.map((point, index) => ({
      ...point,
      sleepMinutes: index % 2 ? 180 : 620,
    }))
    const consistency = buildInsights(data, profile).find((insight) => insight.id === 'consistency-sleepMinutes')
    expect(consistency).toBeDefined()
    expect(consistency!.severity).toBe('notable')
    expect(consistency!.evidence.sampleCount).toBe(14)
    expect(consistency!.body).toMatch(/your own/i)
  })

  it('stays silent when the window is steady', () => {
    expect(buildInsights(createDemoData('2026-06-23'), profile)
      .find((insight) => insight.id.startsWith('consistency'))).toBeUndefined()
  })

  it('stays silent below seven finite days', () => {
    const data = createDemoData('2026-06-23')
    data.trends = data.trends.slice(-6).map((point, index) => ({ ...point, sleepMinutes: index % 2 ? 180 : 620 }))
    expect(buildInsights(data, profile).find((insight) => insight.id.startsWith('consistency'))).toBeUndefined()
  })
})

describe('data completeness rule', () => {
  it('reports a metric that stopped reporting, without calling it zero', () => {
    const data = createDemoData('2026-06-23')
    data.trends = data.trends.map((point, index) => ({
      ...point,
      hrvMs: index >= data.trends.length - 3 ? null : point.hrvMs,
    }))
    const gap = buildInsights(data, profile).find((insight) => insight.id === 'data-completeness-hrvMs')
    expect(gap).toBeDefined()
    expect(gap!.category).toBe('data')
    expect(gap!.page).toBe('devices')
    expect(gap!.body).toMatch(/stopped reporting/i)
    expect(gap!.body).not.toMatch(/\b0\b|zero (ms|steps|bpm)/)
    expect(gap!.evidence.sampleCount).toBe(11)
  })

  it('stays silent while every metric is still reporting', () => {
    expect(buildInsights(createDemoData('2026-06-23'), profile)
      .find((insight) => insight.id.startsWith('data-completeness'))).toBeUndefined()
  })
})

describe('cardio load rules', () => {
  it('names both window means in the load spike prompt', () => {
    const loads = loadsEnding((index) => (index >= 21 ? 120 : 20))
    const spike = buildInsights(createDemoData('2026-06-23'), profile, { loads })
      .find((insight) => insight.id === 'load-spike')
    expect(spike).toBeDefined()
    expect(spike!.evidence.sampleCount).toBe(28)
    expect(spike!.prompt).toMatch(/TRIMP/)
    expect(spike!.prompt).toMatch(/improve|change|what should/i)
  })

  it('flags undertraining below 0.8 as info', () => {
    const loads = loadsEnding((index) => (index >= 21 ? 20 : 100))
    const undertraining = buildInsights(createDemoData('2026-06-23'), profile, { loads })
      .find((insight) => insight.id === 'undertraining')
    expect(undertraining).toBeDefined()
    expect(undertraining!.severity).toBe('info')
    expect(undertraining!.evidence.value).toMatch(/0\.\d\d/)
  })

  it('stays silent on both load rules inside the normal band', () => {
    const loads = loadsEnding(() => 60)
    const insights = buildInsights(createDemoData('2026-06-23'), profile, { loads })
    expect(insights.find((insight) => insight.id === 'load-spike')).toBeUndefined()
    expect(insights.find((insight) => insight.id === 'undertraining')).toBeUndefined()
  })

  it('stays silent on both load rules with no load days at all', () => {
    const insights = buildInsights(createDemoData('2026-06-23'), profile)
    expect(insights.find((insight) => insight.id === 'load-spike')).toBeUndefined()
    expect(insights.find((insight) => insight.id === 'undertraining')).toBeUndefined()
  })
})
