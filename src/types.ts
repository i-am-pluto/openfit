export type PageId = 'today' | 'activity' | 'health' | 'sleep' | 'body' | 'devices'

export type DataSource = 'demo' | 'fitbit' | 'google-health' | 'cache'

export type HealthProvider = 'google-health' | 'fitbit-legacy'

/**
 * The small set of facts the health provider cannot supply, each justified by a
 * named consumer. Biological sex is deliberately excluded: its only use would be
 * generic population threshold tables, which HOME_DASHBOARD_MODEL.md rejects.
 *
 * Every field is optional. Every consumer already handles null.
 */
export interface UserProfile {
  birthYear: number | null
  heightCm: number | null
  measuredMaxHeartRate: number | null
  stepsGoal: number | null
  sleepGoalMinutes: number | null
  waterGoalMl: number | null
  weightGoalKg: number | null
  /** Fields the user has edited by hand. A later sync must never overwrite these. */
  userEdited: string[]
}

export interface TimePoint {
  time: string
  value: number
}

export interface TrendPoint {
  date: string
  label: string
  steps: number | null
  calories: number | null
  distanceKm: number | null
  floors: number | null
  activeMinutes: number | null
  zoneMinutes: number | null
  sedentaryMinutes: number | null
  restingHeartRate: number | null
  hrvMs: number | null
  breathingRate: number | null
  spo2: number | null
  skinTemperature: number | null
  coreTemperature: number | null
  cardioScore: number | null
  sleepMinutes: number | null
  sleepScore: number | null
  sleepEfficiency: number | null
  weight: number | null
  bodyFat: number | null
  waterMl: number | null
  caloriesIn: number | null
}

export interface ActivityItem {
  id: string
  name: string
  date: string
  time: string
  durationMinutes: number
  calories: number | null
  distanceKm: number | null
  averageHeartRate: number | null
  zoneMinutes: number | null
  steps: number | null
  averagePaceSecondsPerMeter: number | null
  heartZoneMinutes: HeartZoneMinutes | null
}

export type SleepStageKey = 'deep' | 'light' | 'rem' | 'wake'

export interface HeartZoneMinutes {
  light: number | null
  moderate: number | null
  vigorous: number | null
  peak: number | null
}

export interface SleepStage {
  name: 'Deep' | 'Light' | 'REM' | 'Awake'
  key: SleepStageKey
  minutes: number
  color: string
}

export interface SleepStageSegment {
  startTime: string
  endTime: string
  type: SleepStageKey
}

export interface SleepStageCounts {
  deep: number | null
  light: number | null
  rem: number | null
  wake: number | null
}

export interface DashboardData {
  source: DataSource
  selectedDate: string
  generatedAt: string
  profile: {
    displayName: string
    avatar: string | null
    memberSince: string | null
    timezone: string | null
  }
  device: {
    id: string | null
    name: string
    type: string | null
    battery: string | null
    batteryLevel: number | null
    lastSyncTime: string | null
    firmware: string | null
    features: string[]
  } | null
  activity: {
    steps: number | null
    stepsGoal: number | null
    calories: number | null
    caloriesGoal: number | null
    distanceKm: number | null
    distanceGoalKm: number | null
    floors: number | null
    floorsGoal: number | null
    activeMinutes: number | null
    lightActiveMinutes: number | null
    moderateActiveMinutes: number | null
    vigorousActiveMinutes: number | null
    activeMinutesGoal: number | null
    zoneMinutes: number | null
    sedentaryMinutes: number | null
    stepsIntraday: TimePoint[]
    caloriesIntraday: TimePoint[]
  }
  health: {
    currentHeartRate: number | null
    restingHeartRate: number | null
    heartRateMin: number | null
    heartRateMax: number | null
    heartRateIntraday: TimePoint[]
    hrvMs: number | null
    hrvDeepSleepRmssdMs: number | null
    hrvEntropy: number | null
    nonRemHeartRate: number | null
    breathingRate: number | null
    spo2: number | null
    spo2Min: number | null
    spo2Max: number | null
    skinTemperature: number | null
    skinNightlyTemperatureCelsius: number | null
    skinBaselineTemperatureCelsius: number | null
    skinTemperatureStddev30dCelsius: number | null
    coreTemperature: number | null
    vo2Max: string | null
    cardioScore: number | null
    ecgClassification: string | null
    bloodGlucoseMgDl: number | null
    irregularRhythmAlerts: number | null
  }
  sleep: {
    totalMinutes: number | null
    goalMinutes: number | null
    score: number | null
    efficiency: number | null
    startTime: string | null
    endTime: string | null
    stages: SleepStage[]
    stageTimeline: SleepStageSegment[]
    stageTransitions: SleepStageCounts
    minutesToFallAsleep: number | null
    minutesAfterWakeUp: number | null
    timeInBed: number | null
    minutesAwake: number | null
  }
  body: {
    weightKg: number | null
    weightGoalKg: number | null
    bmi: number | null
    bodyFat: number | null
    waterMl: number | null
    waterGoalMl: number | null
    caloriesIn: number | null
  }
  trends: TrendPoint[]
  activities: ActivityItem[]
  insights: Array<{
    id: string
    tone: 'mint' | 'blue' | 'amber' | 'violet'
    title: string
    body: string
  }>
  sync: {
    endpointCount: number
    successCount: number
    errors: Array<{ key: string; message: string }>
    rateLimitRemaining: number | null
  }
}

export interface RawFitbitPayload {
  source: 'fitbit' | 'google-health'
  date: string
  generatedAt: string
  cacheHit?: boolean
  endpoints: Record<string, unknown>
  errors: Array<{ key: string; message: string; status?: number }>
  rateLimit: {
    limit: number | null
    remaining: number | null
    resetSeconds: number | null
  }
  requestStats?: {
    total: number
    succeeded: number
    successfulKeys?: string[]
  }
}

export interface RawHealthArchive {
  version: number
  lastDate: string | null
  days: Record<string, RawFitbitPayload>
}

/**
 * `GET /api/status`.
 *
 * The OAuth client is not part of this any more. It comes from the server's
 * environment (`OPENFIT_GOOGLE_CLIENT_ID`, `OPENFIT_GOOGLE_CLIENT_SECRET`), the
 * renderer cannot set it, and there is no endpoint that would accept it.
 *
 * `connected: false` while signed in is the normal steady state, not an error:
 * Google expires a refresh token after seven days while the consent screen is
 * in testing. `reauthorizeUrl` is how a browser gets out of it.
 */
export interface FitbitAuthStatus {
  hasBackend: boolean
  configured: boolean
  connected: boolean
  storageEncrypted: boolean
  storageBackend?: string
  lastSyncAt: string | null
  provider: HealthProvider
  publicOrigin?: string | null
  reauthorizeUrl?: string
  assistant?: HealthAssistantStatus
}

export interface FitbitBridge {
  getStatus: () => Promise<FitbitAuthStatus>
  connect: () => Promise<{ ok: boolean; message?: string }>
  disconnect: () => Promise<FitbitAuthStatus>
  sync: (date: string) => Promise<RawFitbitPayload>
  getCachedData: () => Promise<RawFitbitPayload | null>
  getCachedArchive: () => Promise<RawHealthArchive>
  exportData: () => Promise<{ canceled: boolean; path?: string }>
  onAuthComplete: (callback: (result: { ok: boolean; error?: string }) => void) => () => void
  onSyncProgress: (callback: (progress: { completed: number; total: number; key: string; date?: string }) => void) => () => void
}

export interface SessionBridge {
  // `revoked` is true only when the account's epoch was actually bumped, which
  // is what ends sessions on other devices.
  signOut: (everywhere: boolean) => Promise<{ ok: boolean; revoked: boolean }>
  goToLoginPage: () => void
}

export interface HealthAssistantStatus {
  id: string | null
  label: string
  available: boolean
  connected: boolean
  authenticated: boolean
  busy?: boolean
  model?: string
  error?: string
}

export interface AgentSummary extends HealthAssistantStatus {
  selected: boolean
}

export type HealthAssistantEvent =
  | { requestId: string; type: 'delta'; delta: string }
  | { requestId: string; type: 'complete'; text?: string }
  | { requestId: string; type: 'error'; message: string }
  | { requestId: string; type: 'cancelled' }

export interface HealthAssistantBridge {
  getStatus: () => Promise<HealthAssistantStatus>
  listAgents: () => Promise<{ agents: AgentSummary[]; status: HealthAssistantStatus }>
  selectAgent: (agentId: string) => Promise<{ status: HealthAssistantStatus; agents: AgentSummary[] }>
  startTurn: (input: {
    requestId: string
    message: string
    healthContext: string
  }) => Promise<{ requestId: string }>
  cancel: (requestId: string) => Promise<void>
  reset: () => Promise<void>
  onEvent: (callback: (event: HealthAssistantEvent) => void) => () => void
}
