'use strict'

// What /users/me/profile and /users/me/settings actually return, recorded from
// scripts/audit-google-health-raw.cjs against a live account on 2026-08-09
// (31 of 31 requests succeeded; field names only, no values):
//
//   /users/me/profile   age, membershipStartDate{year,month,day}, name,
//                       userConfiguredRunningStrideLengthMm,
//                       userConfiguredWalkingStrideLengthMm
//   /users/me/settings  autoStrideEnabled, distanceUnit, foodLanguageCode,
//                       glucoseUnit, heightUnit, languageLocale, name,
//                       strideLengthRunningType, strideLengthWalkingType,
//                       temperatureUnit, timeZone, utcOffset, waterUnit,
//                       weightUnit
//
// Two consequences the code below depends on. There is no goal anywhere in the
// v4 surface this app is scoped for — no goal endpoint, and no goal field in
// either response — so the user profile store is the only source of goals until
// Google exposes one. And the profile carries no height and no date of birth,
// only `age`, so BMI cannot be derived from the provider on Google Health.
// Both mappings are written anyway and are simply inert until a source appears.

const crypto = require('node:crypto')

const API_BASE = 'https://health.googleapis.com/v4'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const SCOPES = [
  'openid',
  'profile',
  'email',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.ecg.readonly',
  'https://www.googleapis.com/auth/googlehealth.irn.readonly',
  'https://www.googleapis.com/auth/googlehealth.location.readonly',
  'https://www.googleapis.com/auth/googlehealth.nutrition.readonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
]

let nextApiRequestAt = 0

function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
}

function base64Url(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function createPkce() {
  const verifier = base64Url(crypto.randomBytes(48))
  return {
    verifier,
    challenge: base64Url(crypto.createHash('sha256').update(verifier).digest()),
  }
}

// One place builds the authorization query, so a parameter can never be present
// on one path and missing on the other. Callers pass only what varies; anything
// left undefined is omitted rather than serialized as the string "undefined".
function authorizationUrl(parameters) {
  const url = new URL(AUTHORIZE_URL)
  const query = new URLSearchParams({
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    code_challenge_method: 'S256',
  })
  for (const [name, value] of Object.entries(parameters)) {
    if (value === undefined || value === null || value === '') continue
    query.set(name, String(value))
  }
  url.search = query.toString()
  return url.toString()
}

function createAuthorizationUrl(config, state, pkce) {
  return authorizationUrl({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    prompt: 'consent',
    state,
    code_challenge: pkce.challenge,
  })
}

function requireText(value, what) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`A Google authorization URL requires a non-empty ${what}.`)
  }
  return value
}

/**
 * The authorization request that signs a person in.
 *
 * `nonce` is mandatory and checked here rather than left to the caller: Google
 * omits the claim entirely when the parameter is absent, and core/identity.cjs
 * rejects an ID token with no nonce. A URL built without one produces a token
 * that can never validate, so every sign-in would fail at the callback with
 * nothing in the request to explain why.
 *
 * `prompt` is deliberately absent by default. Forcing the consent screen on
 * every sign-in is noise; the reconnect path asks for it explicitly when a
 * refresh token is actually needed.
 */
function buildGoogleAuthUrl({ clientId, redirectUri, state, nonce, challenge, prompt }) {
  return authorizationUrl({
    client_id: requireText(clientId, 'client id'),
    redirect_uri: requireText(redirectUri, 'redirect uri'),
    state: requireText(state, 'state'),
    nonce: requireText(nonce, 'nonce'),
    code_challenge: requireText(challenge, 'PKCE challenge'),
    prompt,
  })
}

async function tokenRequest(parameters) {
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(parameters),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Google OAuth ha risposto ${response.status}.`)
  }
  return {
    ...payload,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
  }
}

function exchangeAuthorizationCode(config, code, verifier) {
  return tokenRequest({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  })
}

// Named arguments for the sign-in path: the positional form takes the client and
// the code in the same shape, and transposing them there is silent.
function exchangeGoogleCode({ clientId, clientSecret, redirectUri, code, verifier }) {
  return exchangeAuthorizationCode({ clientId, clientSecret, redirectUri }, code, verifier)
}

async function refreshAccessToken(config, token) {
  if (!token.refresh_token) throw new Error('The Google refresh token is unavailable: reconnect the account.')
  const refreshed = await tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  })
  return { ...token, ...refreshed, refresh_token: refreshed.refresh_token || token.refresh_token }
}

async function revokeToken(token) {
  const value = token?.refresh_token || token?.access_token
  if (!value) return
  const response = await fetchWithTimeout(REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: value }),
  })
  if (!response.ok) throw new Error(`Google did not confirm token revocation (${response.status}).`)
}

async function waitForApiSlot() {
  const now = Date.now()
  const slot = Math.max(now, nextApiRequestAt)
  nextApiRequestAt = slot + 225
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now))
}

async function request(path, accessToken, { method = 'GET', body, retryCount = 0 } = {}) {
  await waitForApiSlot()
  const response = await fetchWithTimeout(path.startsWith('http') ? path : `${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (response.status === 429 && retryCount < 2) {
    const retryAfter = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(30_000, retryAfter * 1000)
      : Math.min(30_000, 1_100 * (2 ** retryCount))
    await new Promise((resolve) => setTimeout(resolve, delay))
    return request(path, accessToken, { method, body, retryCount: retryCount + 1 })
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Google Health ha risposto ${response.status}.`)
    error.status = response.status
    throw error
  }
  return payload
}

function shiftIso(value, days) {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days, 12))
  return date.toISOString().slice(0, 10)
}

function civilDateTime(value, endOfDay = false) {
  const [year, month, day] = value.split('-').map(Number)
  // Match the REST example exactly. Although the schema describes a
  // closed-open interval, the current v4 endpoint expects the final civil day
  // at 23:59:59 instead of the following day at midnight.
  return {
    date: { year, month, day },
    time: endOfDay
      ? { hours: 23, minutes: 59, seconds: 59, nanos: 0 }
      : { hours: 0, minutes: 0, seconds: 0, nanos: 0 },
  }
}

function dateFromCivil(value) {
  const date = value?.date || value
  if (!date?.year || !date?.month || !date?.day) return null
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
}

function timeFromCivil(value) {
  const time = value?.time || value
  if (typeof time?.hours !== 'number') return null
  return `${String(time.hours).padStart(2, '0')}:${String(time.minutes || 0).padStart(2, '0')}`
}

function durationSeconds(value) {
  if (typeof value !== 'string') return 0
  const parsed = Number(value.replace(/s$/, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function dataFilter(type, recordType, start, end) {
  if (recordType === 'daily') return `${type.replaceAll('-', '_')}.date >= "${start}" AND ${type.replaceAll('-', '_')}.date < "${end}"`
  if (recordType === 'sleep') return `sleep.interval.civil_end_time >= "${start}" AND sleep.interval.civil_end_time < "${end}"`
  if (recordType === 'ecg') return `electrocardiogram.interval.start_time >= "${start}T00:00:00Z"`
  if (recordType === 'sample') return `${type.replaceAll('-', '_')}.sample_time.civil_time >= "${start}" AND ${type.replaceAll('-', '_')}.sample_time.civil_time < "${end}"`
  return `${type.replaceAll('-', '_')}.interval.civil_start_time >= "${start}" AND ${type.replaceAll('-', '_')}.interval.civil_start_time < "${end}"`
}

async function listData(accessToken, type, recordType, start, end, dataSourceFamily = 'all-sources', operation = 'reconcile') {
  const baseParams = {
    filter: dataFilter(type, recordType, start, end),
    pageSize: type === 'sleep' || type === 'exercise' ? '25' : '10000',
  }
  if (operation === 'reconcile') baseParams.dataSourceFamily = `users/me/dataSourceFamilies/${dataSourceFamily}`
  const endpoint = operation === 'list' ? 'dataPoints' : 'dataPoints:reconcile'
  const merged = { dataPoints: [] }
  let pageToken = ''
  let pageCount = 0
  do {
    const params = new URLSearchParams(baseParams)
    if (pageToken) params.set('pageToken', pageToken)
    const page = await request(`/users/me/dataTypes/${type}/${endpoint}?${params}`, accessToken)
    if (Array.isArray(page.dataPoints)) merged.dataPoints.push(...page.dataPoints)
    pageToken = page.nextPageToken || ''
    pageCount += 1
    if (pageCount >= 100 && pageToken) throw new Error(`Google Health ha restituito troppe pagine per ${type}.`)
  } while (pageToken)
  return merged
}

function dailyRollup(accessToken, type, start, end) {
  return request(`/users/me/dataTypes/${type}/dataPoints:dailyRollUp`, accessToken, {
    method: 'POST',
    body: {
      range: {
        start: civilDateTime(start),
        end: civilDateTime(shiftIso(end, -1), true),
      },
      windowSizeDays: 1,
    },
  })
}

async function syncGoogleHealthData(accessToken, selectedDate, onProgress = () => {}) {
  const trendStart = shiftIso(selectedDate, -13)
  const dayAfter = shiftIso(selectedDate, 1)
  const ecgStart = shiftIso(selectedDate, -90)
  const jobs = [
    ['identity', () => request('/users/me/identity', accessToken)],
    ['profileRaw', () => request('/users/me/profile', accessToken)],
    ['settingsRaw', () => request('/users/me/settings', accessToken)],
    ['devicesRaw', () => request('/users/me/pairedDevices?pageSize=100', accessToken)],
    ['userInfo', () => request('https://www.googleapis.com/oauth2/v3/userinfo', accessToken)],
    ['stepsDaily', () => dailyRollup(accessToken, 'steps', trendStart, dayAfter)],
    ['caloriesDaily', () => dailyRollup(accessToken, 'total-calories', trendStart, dayAfter)],
    ['distanceDaily', () => dailyRollup(accessToken, 'distance', trendStart, dayAfter)],
    ['floorsDaily', () => dailyRollup(accessToken, 'floors', trendStart, dayAfter)],
    ['activeMinutesDaily', () => dailyRollup(accessToken, 'active-minutes', trendStart, dayAfter)],
    ['zoneMinutesDaily', () => dailyRollup(accessToken, 'active-zone-minutes', trendStart, dayAfter)],
    ['sedentaryDaily', () => dailyRollup(accessToken, 'sedentary-period', trendStart, dayAfter)],
    ['weightDaily', () => dailyRollup(accessToken, 'weight', trendStart, dayAfter)],
    ['fatDaily', () => dailyRollup(accessToken, 'body-fat', trendStart, dayAfter)],
    ['waterDaily', () => dailyRollup(accessToken, 'hydration-log', trendStart, dayAfter)],
    ['nutritionDaily', () => dailyRollup(accessToken, 'nutrition-log', trendStart, dayAfter)],
    ['coreTemperatureDaily', () => dailyRollup(accessToken, 'core-body-temperature', trendStart, dayAfter)],
    ['stepsIntradayRaw', () => listData(accessToken, 'steps', 'interval', selectedDate, dayAfter, 'google-wearables')],
    ['heartIntradayRaw', () => listData(accessToken, 'heart-rate', 'sample', selectedDate, dayAfter, 'google-wearables')],
    ['restingHeartRaw', () => listData(accessToken, 'daily-resting-heart-rate', 'daily', trendStart, dayAfter)],
    ['hrvRaw', () => listData(accessToken, 'daily-heart-rate-variability', 'daily', trendStart, dayAfter)],
    ['spo2Raw', () => listData(accessToken, 'daily-oxygen-saturation', 'daily', trendStart, dayAfter)],
    ['breathingRaw', () => listData(accessToken, 'daily-respiratory-rate', 'daily', trendStart, dayAfter)],
    ['skinTemperatureRaw', () => listData(accessToken, 'daily-sleep-temperature-derivations', 'daily', trendStart, dayAfter)],
    ['cardioRaw', () => listData(accessToken, 'daily-vo2-max', 'daily', trendStart, dayAfter)],
    ['sleepRaw', () => listData(accessToken, 'sleep', 'sleep', trendStart, dayAfter, 'google-wearables')],
    ['activitiesRaw', () => listData(accessToken, 'exercise', 'session', trendStart, dayAfter)],
    ['ecgRaw', () => listData(accessToken, 'electrocardiogram', 'ecg', ecgStart, dayAfter, 'all-sources', 'list')],
    ['irnProfileRaw', () => request('/users/me/irnProfile', accessToken)],
    ['irnAlertsRaw', () => listData(accessToken, 'irregular-rhythm-notification', 'session', trendStart, dayAfter, 'all-sources', 'list')],
    ['glucoseRaw', () => listData(accessToken, 'blood-glucose', 'sample', trendStart, dayAfter)],
  ]
  const endpoints = {}
  const errors = []
  let completed = 0

  await Promise.all(jobs.map(async ([key, run]) => {
    try {
      endpoints[key] = await run()
    } catch (error) {
      errors.push({ key, message: error.message || 'Source unavailable', status: error.status })
    } finally {
      completed += 1
      onProgress({ completed, total: jobs.length, key })
    }
  }))

  if (errors.some((error) => error.status === 401)) {
    throw new Error('The Google Health authorization is no longer valid. Reconnect the account.')
  }

  return {
    source: 'google-health',
    date: selectedDate,
    generatedAt: new Date().toISOString(),
    endpoints: translateGoogleHealth(endpoints, selectedDate),
    errors,
    rateLimit: { limit: 300, remaining: null, resetSeconds: 60 },
    requestStats: { total: jobs.length, succeeded: Object.keys(endpoints).length, successfulKeys: Object.keys(endpoints) },
  }
}

function rollupPoints(payload) {
  return Array.isArray(payload?.rollupDataPoints) ? payload.rollupDataPoints : []
}

function dataPoints(payload) {
  return Array.isArray(payload?.dataPoints) ? payload.dataPoints : []
}

function dailyMap(payload, extractor) {
  return new Map(rollupPoints(payload).map((point) => [dateFromCivil(point.civilStartTime), extractor(point)]).filter(([date]) => date))
}

function dailyRecordMap(payload, key, extractor) {
  return new Map(dataPoints(payload).map((point) => {
    const record = point[key]
    return [dateFromCivil(record?.date), extractor(record)]
  }).filter(([date]) => date))
}

function selected(map, date) {
  return map.get(date) ?? null
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

// An absent goal must stay absent. Emitting `steps: null` would let a consumer
// that only checks `in` treat "no goal" as "a goal of nothing".
function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined))
}

// A height is only usable when it is plausibly centimetres. A profile that
// reported metres or inches would otherwise produce a confident, wrong BMI, and
// a wrong number on screen is worse than a missing one.
function heightCentimetres(value) {
  const parsed = numeric(value)
  return parsed !== null && parsed >= 50 && parsed <= 260 ? parsed : null
}

function bodyMassIndex(weightKg, heightCm) {
  if (weightKg === null || weightKg === undefined || heightCm === null) return null
  const metres = heightCm / 100
  const index = numeric(weightKg, (kilograms) => kilograms / (metres * metres))
  return index === null ? null : Number(index.toFixed(2))
}

function numeric(value, transform = (number) => number) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? transform(parsed) : null
}

function sleepStageKey(value) {
  const type = String(value || '').toLowerCase()
  if (type === 'awake' || type === 'restless') return 'wake'
  if (type === 'asleep') return 'light'
  return ['deep', 'light', 'rem', 'wake'].includes(type) ? type : null
}

function toLegacySleep(point) {
  const sleep = point.sleep || {}
  const summary = sleep.summary || {}
  const stageSummaries = summary.stagesSummary || []
  const hasDetailedStages = stageSummaries.some((stage) => ['LIGHT', 'DEEP', 'REM'].includes(String(stage.type || '').toUpperCase()))
  const uniqueStageSummaries = stageSummaries.reduce((result, stage) => {
    const rawType = String(stage.type || '').toLowerCase()
    if (!rawType) return result
    const previous = result[rawType] || { minutes: 0, count: null }
    const count = numeric(stage.count)
    result[rawType] = {
      // Reconciled responses can repeat the same aggregate. Keep the largest
      // value per raw type before merging compatible classic-sleep buckets.
      minutes: Math.max(previous.minutes, numeric(stage.minutes) ?? 0),
      count: count === null ? previous.count : Math.max(previous.count ?? 0, count),
    }
    return result
  }, {})
  const stageMap = Object.entries(uniqueStageSummaries).reduce((result, [rawType, values]) => {
    // ASLEEP is the aggregate of LIGHT/DEEP/REM when detailed stages exist.
    if (rawType === 'asleep' && hasDetailedStages) return result
    const key = sleepStageKey(rawType)
    if (!key) return result
    const previous = result[key] || { minutes: 0, count: null }
    result[key] = {
      minutes: previous.minutes + values.minutes,
      count: values.count === null ? previous.count : (previous.count ?? 0) + values.count,
    }
    return result
  }, {})
  const stageTimeline = (Array.isArray(sleep.stages) ? sleep.stages : []).map((stage) => {
    const level = sleepStageKey(stage.type)
    if (!level || !stage.startTime || !stage.endTime) return null
    const seconds = (new Date(stage.endTime) - new Date(stage.startTime)) / 1000
    return {
      dateTime: stage.startTime,
      endTime: stage.endTime,
      level,
      seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : null,
    }
  }).filter(Boolean)
  const asleep = numeric(summary.minutesAsleep) ?? 0
  const period = numeric(summary.minutesInSleepPeriod)
  const endCivil = sleep.interval?.civilEndTime
  const dateOfSleep = dateFromCivil(endCivil) || sleep.interval?.endTime?.slice(0, 10)
  return {
    logId: point.dataPointName ?? point.name,
    dateOfSleep,
    isMainSleep: sleep.metadata?.nap !== true,
    minutesAsleep: asleep,
    minutesAwake: numeric(summary.minutesAwake),
    minutesToFallAsleep: numeric(summary.minutesToFallAsleep),
    minutesAfterWakeUp: numeric(summary.minutesAfterWakeUp),
    timeInBed: period,
    efficiency: period && period > 0 ? Math.round(asleep / period * 100) : null,
    startTime: sleep.interval?.startTime || null,
    endTime: sleep.interval?.endTime || null,
    levels: { summary: stageMap, data: stageTimeline },
  }
}

function translateGoogleHealth(raw, selectedDate) {
  const steps = dailyMap(raw.stepsDaily, (point) => numeric(point.steps?.countSum))
  const calories = dailyMap(raw.caloriesDaily, (point) => numeric(point.totalCalories?.kcalSum))
  const distance = dailyMap(raw.distanceDaily, (point) => numeric(point.distance?.millimetersSum, (value) => value / 1_000_000))
  const floors = dailyMap(raw.floorsDaily, (point) => numeric(point.floors?.countSum))
  const activeMinutes = dailyMap(raw.activeMinutesDaily, (point) => {
    if (!point.activeMinutes) return null
    const levels = point.activeMinutes?.activeMinutesRollupByActivityLevel || []
    return Object.fromEntries(levels.map((level) => [level.activityLevel, Number(level.activeMinutesSum || 0)]))
  })
  const zoneMinutes = dailyMap(raw.zoneMinutesDaily, (point) => point.activeZoneMinutes ? Object.values(point.activeZoneMinutes).reduce((sum, value) => sum + Number(value || 0), 0) : null)
  const sedentary = dailyMap(raw.sedentaryDaily, (point) => point.sedentaryPeriod?.durationSum === undefined ? null : durationSeconds(point.sedentaryPeriod.durationSum) / 60)
  const weights = dailyMap(raw.weightDaily, (point) => numeric(point.weight?.weightGramsAvg, (value) => value / 1000))
  const bodyFat = dailyMap(raw.fatDaily, (point) => numeric(point.bodyFat?.bodyFatPercentageAvg))
  const water = dailyMap(raw.waterDaily, (point) => numeric(point.hydrationLog?.amountConsumed?.millilitersSum))
  const nutrition = dailyMap(raw.nutritionDaily, (point) => numeric(point.nutritionLog?.energy?.kcalSum))
  const coreTemperature = dailyMap(raw.coreTemperatureDaily, (point) => numeric(point.coreBodyTemperature?.temperatureCelsiusAvg))
  const restingHeart = dailyRecordMap(raw.restingHeartRaw, 'dailyRestingHeartRate', (record) => numeric(record?.beatsPerMinute))
  const hrv = dailyRecordMap(raw.hrvRaw, 'dailyHeartRateVariability', (record) => ({
    averageMs: numeric(record?.averageHeartRateVariabilityMilliseconds ?? record?.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds),
    deepSleepRmssdMs: numeric(record?.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds),
    entropy: numeric(record?.entropy),
    nonRemHeartRate: numeric(record?.nonRemHeartRateBeatsPerMinute),
  }))
  const spo2 = dailyRecordMap(raw.spo2Raw, 'dailyOxygenSaturation', (record) => ({
    average: numeric(record?.averagePercentage),
    lowerBound: numeric(record?.lowerBoundPercentage),
    upperBound: numeric(record?.upperBoundPercentage),
  }))
  const breathing = dailyRecordMap(raw.breathingRaw, 'dailyRespiratoryRate', (record) => numeric(record?.breathsPerMinute))
  const skinTemp = dailyRecordMap(raw.skinTemperatureRaw, 'dailySleepTemperatureDerivations', (record) => {
    const nightly = numeric(record?.nightlyTemperatureCelsius)
    const baseline = numeric(record?.baselineTemperatureCelsius)
    return {
      relative: nightly === null || baseline === null ? null : Number((nightly - baseline).toFixed(2)),
      nightly,
      baseline,
      stddev30d: numeric(record?.relativeNightlyStddev30dCelsius),
    }
  })
  const cardio = dailyRecordMap(raw.cardioRaw, 'dailyVo2Max', (record) => numeric(record?.vo2Max))
  const selectedActivityLevels = selected(activeMinutes, selectedDate)
  const todayActivityLevels = selectedActivityLevels || {}
  const sleepRecords = dataPoints(raw.sleepRaw).map(toLegacySleep)
  const selectedSleepRecords = sleepRecords.filter((item) => item.dateOfSleep === selectedDate)
  const selectedSleep = selectedSleepRecords.find((item) => item.isMainSleep)
    || selectedSleepRecords.sort((a, b) => b.minutesAsleep - a.minutesAsleep)[0]
    || null
  const allDates = [...new Set([
    ...steps.keys(),
    ...calories.keys(),
    ...distance.keys(),
    ...floors.keys(),
    ...activeMinutes.keys(),
    ...zoneMinutes.keys(),
    ...sedentary.keys(),
    ...restingHeart.keys(),
    ...hrv.keys(),
    ...spo2.keys(),
    ...breathing.keys(),
    ...skinTemp.keys(),
    ...coreTemperature.keys(),
    ...cardio.keys(),
    ...weights.keys(),
    ...bodyFat.keys(),
    ...water.keys(),
    ...nutrition.keys(),
    ...sleepRecords.map((item) => item.dateOfSleep).filter(Boolean),
  ])].sort()
  const sleepByDate = new Map(sleepRecords
    .filter((item) => item.dateOfSleep && item.isMainSleep !== false)
    .map((item) => [item.dateOfSleep, item]))
  const activeMinutesFor = (date) => {
    const levels = activeMinutes.get(date)
    if (!levels) return null
    const moderate = numeric(levels.MODERATE)
    const vigorous = numeric(levels.VIGOROUS)
    if (moderate === null && vigorous === null) return null
    return (moderate || 0) + (vigorous || 0)
  }
  const stepPoints = dataPoints(raw.stepsIntradayRaw).map((point) => {
    const record = point.steps || {}
    const time = timeFromCivil(record.interval?.civilStartTime) || record.interval?.startTime?.slice(11, 16)
    return { time, value: Number(record.count || 0) }
  }).filter((point) => point.time).sort((a, b) => a.time.localeCompare(b.time))
  const heartPoints = dataPoints(raw.heartIntradayRaw).map((point) => {
    const record = point.heartRate || {}
    const time = timeFromCivil(record.sampleTime?.civilTime) || record.sampleTime?.physicalTime?.slice(11, 16)
    return { time, value: Number(record.beatsPerMinute || 0) }
  }).filter((point) => point.time && point.value).sort((a, b) => a.time.localeCompare(b.time))
  const profile = plainObject(raw.profileRaw)
  const settings = plainObject(raw.settingsRaw)
  const userInfo = plainObject(raw.userInfo)
  // The v4 profile is flat, but the legacy Fitbit profile nests everything under
  // `user`, and the renderer's prefill reads the nested form. Accept either
  // rather than picking one and being silently wrong on the other.
  const profileUser = plainObject(profile.user)
  const heightCm = heightCentimetres(profileUser.height ?? profile.height)
  // Goals have no v4 endpoint today, so these stay empty on every real sync.
  // Reading them here means the goals light up the moment one exists, without
  // a second pass over this function.
  const activityGoals = plainObject(raw.goalsRaw)
  const sleepGoalSource = plainObject(raw.sleepGoalRaw)
  const weightGoalSource = plainObject(raw.weightGoalRaw)
  const waterGoalSource = plainObject(raw.waterGoalRaw)
  const membershipDate = dateFromCivil(profile.membershipStartDate)
  const devices = (raw.devicesRaw?.pairedDevices || []).map((device) => ({
    id: String(device.name || '').split('/').at(-1),
    type: device.deviceType,
    deviceVersion: device.deviceVersion,
    battery: device.batteryStatus,
    batteryLevel: device.batteryLevel,
    lastSyncTime: device.lastSyncTime,
    features: device.features,
  }))
  const todaySteps = selected(steps, selectedDate)
  const todayCalories = selected(calories, selectedDate)
  const todayDistance = selected(distance, selectedDate)
  const todayFloors = selected(floors, selectedDate)
  const todayZone = selected(zoneMinutes, selectedDate)
  const todaySedentary = selected(sedentary, selectedDate)
  const currentWeight = selected(weights, selectedDate) ?? [...weights.values()].filter((value) => value !== null).at(-1) ?? null
  const currentFat = selected(bodyFat, selectedDate) ?? [...bodyFat.values()].filter((value) => value !== null).at(-1) ?? null
  const currentHrv = selected(hrv, selectedDate)
  const currentSpo2 = selected(spo2, selectedDate)
  const currentBreathing = selected(breathing, selectedDate)
  const currentTemp = selected(skinTemp, selectedDate)
  const currentCardio = selected(cardio, selectedDate)
  const currentCoreTemperature = selected(coreTemperature, selectedDate)
  const ecgUpperBound = `${shiftIso(selectedDate, 1)}T00:00:00Z`
  const ecgReadings = dataPoints(raw.ecgRaw)
    .filter((point) => {
      const startTime = point.electrocardiogram?.interval?.startTime
      return !startTime || startTime < ecgUpperBound
    })
    .map((point) => ({
      ...(point.electrocardiogram || {}),
      readingTime: point.electrocardiogram?.interval?.startTime,
    }))
  const activities = dataPoints(raw.activitiesRaw).map((point) => {
    const exercise = point.exercise || {}
    const summary = exercise.metricsSummary || {}
    const start = exercise.interval?.startTime || ''
    const end = exercise.interval?.endTime || ''
    const intervalDuration = (new Date(end) - new Date(start)) / 1000
    const duration = durationSeconds(exercise.activeDuration) || (Number.isFinite(intervalDuration) ? Math.max(0, intervalDuration) : 0)
    const zoneDurations = summary.heartRateZoneDurations || {}
    const zoneMinutes = (value) => value === undefined || value === null ? null : durationSeconds(value) / 60
    const heartZoneMinutes = Object.keys(zoneDurations).length ? {
      light: zoneMinutes(zoneDurations.lightTime),
      moderate: zoneMinutes(zoneDurations.moderateTime),
      vigorous: zoneMinutes(zoneDurations.vigorousTime),
      peak: zoneMinutes(zoneDurations.peakTime),
    } : null
    return {
      logId: point.dataPointName ?? point.name,
      activityName: exercise.displayName || String(exercise.exerciseType || 'Activity').replaceAll('_', ' '),
      startTime: start,
      duration: duration * 1000,
      calories: summary.caloriesKcal,
      distance: numeric(summary.distanceMillimeters, (value) => value / 1_000_000),
      averageHeartRate: summary.averageHeartRateBeatsPerMinute,
      steps: numeric(summary.steps),
      averagePaceSecondsPerMeter: numeric(summary.averagePaceSecondsPerMeter),
      heartZoneMinutes,
      activeZoneMinutes: { totalMinutes: summary.activeZoneMinutes },
    }
  })

  return {
    profile: { user: { displayName: userInfo.name || 'Atleta', avatar640: userInfo.picture || null, memberSince: membershipDate, timezone: settings.timeZone || null } },
    devices,
    activity: { summary: {
      steps: todaySteps,
      caloriesOut: todayCalories,
      distances: [{ activity: 'total', distance: todayDistance }],
      floors: todayFloors,
      lightlyActiveMinutes: selectedActivityLevels === null ? null : numeric(todayActivityLevels.LIGHT) ?? 0,
      fairlyActiveMinutes: selectedActivityLevels === null ? null : numeric(todayActivityLevels.MODERATE) ?? 0,
      veryActiveMinutes: selectedActivityLevels === null ? null : numeric(todayActivityLevels.VIGOROUS) ?? 0,
      activeZoneMinutes: { totalMinutes: todayZone },
      sedentaryMinutes: todaySedentary,
    } },
    // Legacy Fitbit shapes, because src/data/normalize.ts was written against
    // them and legacy Fitbit still emits them: the normalizer is the contract.
    activityGoals: { goals: withoutUndefined({
      steps: numeric(activityGoals.steps),
      caloriesOut: numeric(activityGoals.caloriesOut),
      distance: numeric(activityGoals.distance),
      floors: numeric(activityGoals.floors),
      activeMinutes: numeric(activityGoals.activeMinutes),
    }) },
    stepsIntraday: { 'activities-steps-intraday': { dataset: stepPoints } },
    caloriesIntraday: { 'activities-calories-intraday': { dataset: [] } },
    heartIntraday: {
      'activities-heart': [{ dateTime: selectedDate, value: { restingHeartRate: selected(restingHeart, selectedDate) } }],
      'activities-heart-intraday': { dataset: heartPoints },
    },
    sleep: { sleep: selectedSleep ? [selectedSleep] : [] },
    sleepTrend: { sleep: sleepRecords },
    sleepGoal: { goal: withoutUndefined({ minDuration: numeric(sleepGoalSource.minDuration) }) },
    stepsTrend: { 'activities-steps': allDates.map((date) => ({ dateTime: date, value: steps.get(date) })) },
    caloriesTrend: { 'activities-calories': allDates.map((date) => ({ dateTime: date, value: calories.get(date) })) },
    heartTrend: { 'activities-heart': allDates.map((date) => ({ dateTime: date, value: { restingHeartRate: restingHeart.get(date) } })) },
    metricTrends: { values: allDates.map((date) => ({
      dateTime: date,
      distanceKm: distance.get(date) ?? null,
      floors: floors.get(date) ?? null,
      activeMinutes: activeMinutesFor(date),
      zoneMinutes: zoneMinutes.get(date) ?? null,
      sedentaryMinutes: sedentary.get(date) ?? null,
      hrvMs: hrv.get(date)?.averageMs ?? null,
      breathingRate: breathing.get(date) ?? null,
      spo2: spo2.get(date)?.average ?? null,
      skinTemperature: skinTemp.get(date)?.relative ?? null,
      coreTemperature: coreTemperature.get(date) ?? null,
      cardioScore: cardio.get(date) ?? null,
      sleepEfficiency: sleepByDate.get(date)?.efficiency ?? null,
      bodyFat: bodyFat.get(date) ?? null,
      waterMl: water.get(date) ?? null,
      caloriesIn: nutrition.get(date) ?? null,
    })) },
    // Derived only when a height is known, and never guessed: v4 sends no BMI
    // and no height, so this is null until the user fills in their profile.
    bodyWeight: { weight: [...weights].filter(([, weight]) => weight !== null).map(([date, weight]) => ({ date, weight, bmi: bodyMassIndex(weight, heightCm) })) },
    bodyFat: { fat: [...bodyFat].filter(([, fat]) => fat !== null).map(([date, fat]) => ({ date, fat })) },
    weightGoal: { goal: withoutUndefined({ weight: numeric(weightGoalSource.weight) }) },
    water: { summary: { water: selected(water, selectedDate) } },
    waterGoal: { goal: withoutUndefined({ goal: numeric(waterGoalSource.goal) }) },
    food: { summary: { calories: selected(nutrition, selectedDate) } },
    breathing: { br: currentBreathing === null ? [] : [{ dateTime: selectedDate, value: { breathingRate: currentBreathing } }] },
    hrv: { hrv: currentHrv === null ? [] : [{ dateTime: selectedDate, value: {
      dailyRmssd: currentHrv.averageMs,
      deepRmssd: currentHrv.deepSleepRmssdMs,
      entropy: currentHrv.entropy,
      nonRemHeartRate: currentHrv.nonRemHeartRate,
    } }] },
    spo2: currentSpo2 === null ? {} : { dateTime: selectedDate, value: {
      avg: currentSpo2.average,
      min: currentSpo2.lowerBound,
      max: currentSpo2.upperBound,
    } },
    skinTemperature: { tempSkin: currentTemp === null ? [] : [{ dateTime: selectedDate, value: {
      nightlyRelative: currentTemp.relative,
      nightlyTemperatureCelsius: currentTemp.nightly,
      baselineTemperatureCelsius: currentTemp.baseline,
      relativeNightlyStddev30dCelsius: currentTemp.stddev30d,
    } }] },
    coreTemperature: { tempCore: currentCoreTemperature === null ? [] : [{ dateTime: selectedDate, value: { coreTemperature: currentCoreTemperature } }] },
    cardio: { cardioScore: currentCardio === null ? [] : [{ dateTime: selectedDate, value: { vo2Max: String(currentCardio) } }] },
    ecg: { ecgReadings },
    activities: { activities },
    identity: raw.identity,
    // Kept raw so the renderer can prefill the user profile from whatever the
    // provider actually returned. Field names here are not guaranteed by the v4
    // API docs, so nothing downstream may assume a key exists.
    profileRaw: raw.profileRaw ?? null,
    settingsRaw: raw.settingsRaw ?? null,
    ...(raw.irnProfileRaw !== undefined || raw.irnAlertsRaw !== undefined
      ? { irregularRhythm: { profile: raw.irnProfileRaw, alerts: raw.irnAlertsRaw } }
      : {}),
    bloodGlucose: raw.glucoseRaw,
  }
}

module.exports = {
  provider: 'google-health',
  scopes: SCOPES,
  createPkce,
  createAuthorizationUrl,
  buildGoogleAuthUrl,
  exchangeAuthorizationCode,
  exchangeGoogleCode,
  refreshAccessToken,
  revokeToken,
  syncData: syncGoogleHealthData,
  __test: { translateGoogleHealth, dateFromCivil, durationSeconds },
}
