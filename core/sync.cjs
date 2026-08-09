'use strict'

const healthCache = require('./health-cache.cjs')
const { providerFor } = require('./providers/index.cjs')

const GOOGLE_MEASUREMENT_KEYS = [
  'stepsDaily', 'caloriesDaily', 'distanceDaily', 'activeMinutesDaily', 'zoneMinutesDaily',
  'weightDaily', 'waterDaily', 'nutritionDaily', 'heartIntradayRaw', 'restingHeartRaw', 'hrvRaw',
  'spo2Raw', 'breathingRaw', 'skinTemperatureRaw', 'cardioRaw', 'sleepRaw', 'activitiesRaw',
  'ecgRaw', 'irnAlertsRaw', 'glucoseRaw',
]

const LEGACY_MEASUREMENT_KEYS = [
  'activity', 'stepsIntraday', 'stepsTrend', 'caloriesTrend', 'heartIntraday', 'heartTrend',
  'sleep', 'sleepTrend', 'bodyWeight', 'bodyFat', 'food', 'water', 'breathing', 'hrv', 'spo2',
  'skinTemperature', 'coreTemperature', 'cardio', 'ecg', 'irregularRhythmAlerts',
  'bloodGlucose', 'activities',
]

function localIsoDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function validSyncDate(value, today = localIsoDate()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day, 12))
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false
  return value <= today
}

// A sync that mostly failed must not replace a good cache with a hollow one.
function hasUsefulResponses(payload, provider) {
  const total = Number(payload.requestStats?.total || 0)
  const succeeded = Number(payload.requestStats?.succeeded || 0)
  const successfulKeys = Array.isArray(payload.requestStats?.successfulKeys) ? payload.requestStats.successfulKeys : []
  const minimum = Math.max(3, Math.ceil(total * 0.2))
  const measurementKeys = provider === 'google-health' ? GOOGLE_MEASUREMENT_KEYS : LEGACY_MEASUREMENT_KEYS
  const hasMeasurement = successfulKeys.some((key) => measurementKeys.includes(key))
  return Boolean(total) && succeeded >= minimum && hasMeasurement
}

async function validAccessToken(credentials) {
  const stored = credentials.read()
  if (!stored.token) throw new Error('Account not connected.')
  if (Number(stored.token.expiresAt || 0) > Date.now() + 90_000 && stored.token.access_token) {
    return stored
  }
  const service = providerFor(stored)
  const token = await service.refreshAccessToken(stored.config, stored.token)
  const updated = { ...stored, token }
  credentials.save(updated)
  return updated
}

function createSyncer({ credentials, onProgress, now = () => new Date() }) {
  return async function syncData(date) {
    const today = localIsoDate(now())
    const archive = credentials.readCache()

    // Completed days never change, so serve them without another provider round trip.
    if (date < today) {
      const cached = healthCache.cachedDay(archive, date)
      if (cached) return { ...cached, cacheHit: true }
    }

    const stored = await validAccessToken(credentials)
    const service = providerFor(stored)
    const payload = await service.syncData(stored.token.access_token, date, (progress) => {
      onProgress({ ...progress, date })
    })

    if (!hasUsefulResponses(payload, service.provider)) {
      throw new Error('The sync did not return enough valid sources. The previous cache was preserved.')
    }

    credentials.writeCache(healthCache.storeDay(archive, payload))
    credentials.save({ ...credentials.read(), lastSyncAt: payload.generatedAt })
    return payload
  }
}

module.exports = { createSyncer, localIsoDate, validSyncDate, hasUsefulResponses }
