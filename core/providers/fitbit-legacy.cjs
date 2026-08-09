'use strict'

const crypto = require('node:crypto')

const API_BASE = 'https://api.fitbit.com'
const TOKEN_URL = `${API_BASE}/oauth2/token`
const AUTHORIZE_URL = 'https://www.fitbit.com/oauth2/authorize'
const REVOKE_URL = `${API_BASE}/oauth2/revoke`
const SCOPES = [
  'activity',
  'blood_glucose',
  'cardio_fitness',
  'electrocardiogram',
  'heartrate',
  'irregular_rhythm_notifications',
  'location',
  'nutrition',
  'oxygen_saturation',
  'profile',
  'respiratory_rate',
  'settings',
  'sleep',
  'temperature',
  'weight',
]

let latestRateLimit = { limit: null, remaining: null, resetSeconds: null }

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

function createAuthorizationUrl(config, state, pkce) {
  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

async function tokenRequest(parameters) {
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(parameters),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = payload.errors?.map((error) => error.message).join(' ') || payload.error_description || `Fitbit OAuth ha risposto ${response.status}.`
    throw new Error(message)
  }
  return { ...payload, expiresAt: Date.now() + Number(payload.expires_in || 28800) * 1000 }
}

function exchangeAuthorizationCode(config, code, verifier) {
  return tokenRequest({
    client_id: config.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  })
}

async function refreshAccessToken(config, token) {
  if (!token.refresh_token) throw new Error('The Fitbit refresh token is unavailable: reconnect the account.')
  const refreshed = await tokenRequest({
    client_id: config.clientId,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  })
  return { ...token, ...refreshed }
}

async function revokeToken(token, config) {
  if (!token?.access_token) return
  const response = await fetchWithTimeout(REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, token: token.access_token }),
  })
  if (!response.ok) throw new Error(`Fitbit did not confirm token revocation (${response.status}).`)
}

async function fetchJson(path, accessToken, retry = true) {
  const response = await fetchWithTimeout(`${API_BASE}${path}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'accept-language': 'it_IT',
    },
  })
  latestRateLimit = {
    limit: numberHeader(response.headers.get('fitbit-rate-limit-limit')),
    remaining: numberHeader(response.headers.get('fitbit-rate-limit-remaining')),
    resetSeconds: numberHeader(response.headers.get('fitbit-rate-limit-reset')),
  }
  if (response.status === 429 && retry) {
    const resetSeconds = Math.max(1, latestRateLimit.resetSeconds || 1)
    if (resetSeconds > 30) {
      const error = new Error(`Limite Fitbit raggiunto. Riprova tra circa ${resetSeconds} secondi.`)
      error.status = 429
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, resetSeconds * 1000 + 250))
    return fetchJson(path, accessToken, false)
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.errors?.map((item) => item.message).join(' ') || `Fitbit ha risposto ${response.status}.`)
    error.status = response.status
    throw error
  }
  return payload
}

function numberHeader(value) {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function shiftIso(value, days) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10)
}

async function syncLegacyData(accessToken, date, onProgress = () => {}) {
  const start = shiftIso(date, -13)
  const next = shiftIso(date, 1)
  const encodedBefore = encodeURIComponent(`${next}T00:00:00`)
  const jobs = [
    ['profile', `/1/user/-/profile.json`],
    ['devices', `/1/user/-/devices.json`],
    ['activity', `/1/user/-/activities/date/${date}.json`],
    ['activityGoals', `/1/user/-/activities/goals/daily.json`],
    ['stepsIntraday', `/1/user/-/activities/steps/date/${date}/1d/1min.json`],
    ['caloriesIntraday', `/1/user/-/activities/calories/date/${date}/1d/15min.json`],
    ['heartIntraday', `/1/user/-/activities/heart/date/${date}/1d/1min.json`],
    ['zoneMinutesIntraday', `/1/user/-/activities/active-zone-minutes/date/${date}/1d/1min.json`],
    ['sleep', `/1.2/user/-/sleep/date/${date}.json`],
    ['sleepGoal', `/1.2/user/-/sleep/goal.json`],
    ['stepsTrend', `/1/user/-/activities/steps/date/${start}/${date}.json`],
    ['caloriesTrend', `/1/user/-/activities/calories/date/${start}/${date}.json`],
    ['heartTrend', `/1/user/-/activities/heart/date/${start}/${date}.json`],
    ['sleepTrend', `/1.2/user/-/sleep/date/${start}/${date}.json`],
    ['bodyWeight', `/1/user/-/body/log/weight/date/${date}/30d.json`],
    ['bodyFat', `/1/user/-/body/log/fat/date/${date}/30d.json`],
    ['weightGoal', `/1/user/-/body/log/weight/goal.json`],
    ['food', `/1/user/-/foods/log/date/${date}.json`],
    ['water', `/1/user/-/foods/log/water/date/${date}.json`],
    ['waterGoal', `/1/user/-/foods/log/water/goal.json`],
    ['breathing', `/1/user/-/br/date/${date}.json`],
    ['hrv', `/1/user/-/hrv/date/${date}.json`],
    ['spo2', `/1/user/-/spo2/date/${date}.json`],
    ['skinTemperature', `/1/user/-/temp/skin/date/${date}.json`],
    ['coreTemperature', `/1/user/-/temp/core/date/${date}.json`],
    ['cardio', `/1/user/-/cardioscore/date/${date}.json`],
    ['ecg', `/1/user/-/ecg/list.json?beforeDate=${encodedBefore}&sort=desc&offset=0&limit=10`],
    ['irregularRhythmProfile', `/1/user/-/irn/profile.json`],
    ['irregularRhythmAlerts', `/1/user/-/irn/alerts/list.json?beforeDate=${encodedBefore}&sort=desc&offset=0&limit=10`],
    ['bloodGlucose', `/1/user/-/health/metrics/glucose/values/${start}/${date}.json`],
    ['activities', `/1/user/-/activities/list.json?beforeDate=${encodedBefore}&sort=desc&offset=0&limit=30`],
  ]
  const endpoints = {}
  const errors = []
  let completed = 0

  await Promise.all(jobs.map(async ([key, path], index) => {
    await new Promise((resolve) => setTimeout(resolve, index * 55))
    try {
      endpoints[key] = await fetchJson(path, accessToken)
    } catch (error) {
      errors.push({ key, message: error.message || 'Source unavailable', status: error.status })
    } finally {
      completed += 1
      onProgress({ completed, total: jobs.length, key })
    }
  }))

  if (errors.some((error) => error.status === 401)) {
    throw new Error('The Fitbit authorization is no longer valid. Reconnect the account with Google Health.')
  }

  return {
    source: 'fitbit',
    date,
    generatedAt: new Date().toISOString(),
    endpoints,
    errors,
    rateLimit: latestRateLimit,
    requestStats: { total: jobs.length, succeeded: Object.keys(endpoints).length, successfulKeys: Object.keys(endpoints) },
  }
}

module.exports = {
  provider: 'fitbit-legacy',
  scopes: SCOPES,
  createPkce,
  createAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  syncData: syncLegacyData,
}
