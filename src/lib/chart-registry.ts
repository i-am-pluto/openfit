import type { PageId } from '@/types'

/**
 * Every chart panel that can be explained, favourited, and reordered.
 *
 * `priority` is an editorial ranking, not a computed one. Panels sort ascending
 * within their section, so a lower number sits higher on the page. The ranking
 * answers one question — **would seeing this change what I do?** — and breaks
 * ties on how much the number can be trusted day to day:
 *
 *  - 10-19  Decide today. Recovery and training load are the only two readings
 *           that should change this morning's plan, and both update daily.
 *  - 20-39  The slow signals a fitness journey actually turns on. Resting heart
 *           rate, HRV, sleep duration, steps, cardio fitness — these move over
 *           weeks and are the ones worth tracking against a goal.
 *  - 40-59  Composition and distribution. Useful for understanding a day that
 *           already happened; rarely changes a decision.
 *  - 60-79  Exploratory and conditional. Correlations describe association and
 *           cannot direct an action. SpO2 and skin temperature sit near-flat
 *           until something is wrong, so they earn their place by exception.
 *  - 80+    Data quality. Matters when a metric stops arriving, not otherwise.
 *
 * A user favourite always outranks this ordering — see `sortChartIds`. The
 * ranking is a default, not an argument.
 */
export interface ChartMeta {
  id: string
  title: string
  page: PageId
  priority: number
}

const CHARTS: ChartMeta[] = [
  // -- Decide today ---------------------------------------------------------
  { id: 'health-recovery-panel', title: 'Recovery signals', page: 'health', priority: 10 },
  { id: 'activity-cardio-load', title: 'Cardio load', page: 'activity', priority: 11 },

  // -- The signals a fitness journey turns on -------------------------------
  { id: 'health-resting-hr', title: 'Resting heart rate', page: 'health', priority: 20 },
  { id: 'health-trend-hrv', title: 'HRV', page: 'health', priority: 21 },
  { id: 'sleep-duration-trend', title: 'Duration per night', page: 'sleep', priority: 22 },
  { id: 'activity-steps-daily', title: 'Daily steps', page: 'activity', priority: 23 },
  { id: 'health-trend-cardio-fitness', title: 'Cardio fitness', page: 'health', priority: 24 },
  { id: 'sleep-efficiency-trend', title: 'Sleep efficiency', page: 'sleep', priority: 25 },
  { id: 'sleep-score-trend', title: 'Sleep score', page: 'sleep', priority: 26 },
  { id: 'activity-trend-zone-minutes', title: 'Zone minutes', page: 'activity', priority: 27 },
  { id: 'activity-trend-active-minutes', title: 'Active minutes', page: 'activity', priority: 28 },

  // -- Composition and distribution -----------------------------------------
  { id: 'activity-intensity-composition', title: 'Workout intensity composition', page: 'activity', priority: 40 },
  { id: 'health-hr-distribution', title: 'Time spent at each heart rate', page: 'health', priority: 41 },
  { id: 'sleep-stages', title: 'Time by sleep stage', page: 'sleep', priority: 42 },
  { id: 'sleep-timeline', title: 'Night timeline', page: 'sleep', priority: 43 },
  { id: 'sleep-stage-episodes', title: 'Stage episodes', page: 'sleep', priority: 44 },
  { id: 'activity-steps-hourly', title: 'Steps per hour', page: 'activity', priority: 45 },
  { id: 'health-heart-rate-day', title: 'Heart rate through the day', page: 'health', priority: 46 },
  { id: 'activity-calories-hourly', title: 'Calories per hour', page: 'activity', priority: 47 },
  { id: 'activity-steps-weekday', title: 'Steps by weekday', page: 'activity', priority: 48 },
  { id: 'sleep-duration-histogram', title: 'Sleep duration distribution', page: 'sleep', priority: 49 },
  { id: 'activity-trend-calories', title: 'Calories burned', page: 'activity', priority: 50 },
  { id: 'activity-trend-distance', title: 'Distance', page: 'activity', priority: 51 },

  // -- Exploratory and conditional ------------------------------------------
  { id: 'health-hrv-scatter', title: 'HRV against resting heart rate', page: 'health', priority: 60 },
  { id: 'sleep-duration-efficiency-scatter', title: 'Sleep duration against efficiency', page: 'sleep', priority: 61 },
  { id: 'body-energy-balance', title: 'Intake against expenditure', page: 'body', priority: 62 },
  { id: 'body-weight', title: 'Weight', page: 'body', priority: 63 },
  { id: 'body-bmi', title: 'Body mass index', page: 'body', priority: 64 },
  { id: 'health-spo2-band', title: 'Blood oxygen', page: 'health', priority: 65 },
  { id: 'health-skin-temperature-band', title: 'Skin temperature against baseline', page: 'health', priority: 66 },
  { id: 'health-trend-breathing', title: 'Breathing rate', page: 'health', priority: 67 },
  { id: 'health-trend-spo2', title: 'Average SpO₂', page: 'health', priority: 68 },
  { id: 'health-trend-skin-temperature', title: 'Skin temperature', page: 'health', priority: 69 },
  { id: 'health-trend-body-temperature', title: 'Body temperature', page: 'health', priority: 70 },
  { id: 'body-trend-fat', title: 'Body fat', page: 'body', priority: 71 },
  { id: 'body-trend-hydration', title: 'Hydration', page: 'body', priority: 72 },
  { id: 'body-trend-calories-in', title: 'Calories consumed', page: 'body', priority: 73 },
  { id: 'activity-trend-sedentary', title: 'Sedentary time', page: 'activity', priority: 74 },
  { id: 'activity-trend-floors', title: 'Floors', page: 'activity', priority: 75 },

  // -- Data quality ---------------------------------------------------------
  { id: 'devices-coverage', title: 'Data coverage', page: 'devices', priority: 80 },
  { id: 'devices-sync-errors', title: 'Sync errors', page: 'devices', priority: 81 },
]

const BY_ID = new Map(CHARTS.map((chart) => [chart.id, chart]))

/** Panels not in the registry sort after every registered one rather than jumping to the top. */
export const UNRANKED_PRIORITY = 999

export function chartMeta(id: string): ChartMeta | null {
  return BY_ID.get(id) ?? null
}

export function allCharts(): ChartMeta[] {
  return [...CHARTS]
}

export function chartsForPage(page: PageId): ChartMeta[] {
  return CHARTS.filter((chart) => chart.page === page).sort((left, right) => left.priority - right.priority)
}

/**
 * The CSS `order` value for a panel.
 *
 * Reordering is done with flex/grid `order` rather than by rebuilding the view
 * trees, so a panel keeps its place in the JSX and its guards stay exactly where
 * they were. Favourites are offset below every ranked value so they float to the
 * top of their section while keeping their relative order among themselves.
 */
export function chartOrder(id: string, favourites: readonly string[]): number {
  const priority = chartMeta(id)?.priority ?? UNRANKED_PRIORITY
  return favourites.includes(id) ? priority - 10_000 : priority
}

/** Sorts ids by favourite first, then by editorial priority, then by id for stability. */
export function sortChartIds(ids: readonly string[], favourites: readonly string[]): string[] {
  return [...ids].sort((left, right) =>
    chartOrder(left, favourites) - chartOrder(right, favourites) || left.localeCompare(right))
}
