'use strict'

// Reports the *shape* of every Google Health v4 response a sync touches: key
// paths and value types, never the values themselves, unless `--values` is
// passed. This is the only thing that can tell us which fields
// `/users/me/profile` and `/users/me/settings` actually return.
//
// Runs under plain Node. It used to require `electron/google-health-service.cjs`
// — a path the server restructure deleted — and to boot Electron purely to reach
// `safeStorage`, which fails on a headless host with `Missing X server or
// $DISPLAY`. `core/secrets.cjs` reads both envelope versions, so a v2 (AES-GCM)
// credential file written by the server decrypts here with `master.key` alone.
// A v1 envelope written by the desktop app under `safeStorage` cannot be read
// without Electron; that case is reported explicitly rather than being mistaken
// for an empty API.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createSecretStore, KEY_FILE } = require('../core/secrets.cjs')
const { ACCOUNTS_DIR } = require('../core/accounts.cjs')
const { defaultDataDir } = require('../server/bin.cjs')
const googleHealth = require('../core/providers/google-health.cjs')

const CREDENTIAL_FILE = 'credentials.secure.json'
const CACHE_FILE = 'health-cache.secure.json'
const LEGACY_APP_DIR = 'pulseboard-fitbit-desktop'

const array = (value) => Array.isArray(value) ? value : []
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

function argumentValue(name) {
  const prefix = `--${name}=`
  const match = process.argv.find((argument) => argument.startsWith(prefix))
  return match ? match.slice(prefix.length) : null
}

// Where the desktop app kept its data before the server restructure. Listed so a
// credential file found there can be named in the report instead of the audit
// claiming no account exists.
function legacyDesktopDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', LEGACY_APP_DIR)
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), LEGACY_APP_DIR)
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), LEGACY_APP_DIR)
}

// One instance holds many accounts, each in its own directory under `accounts/`,
// so the credential file is never at a single fixed path.
function credentialFiles(dataDir) {
  const found = []
  const push = (file) => { if (fs.existsSync(file)) found.push(file) }
  push(path.join(dataDir, CREDENTIAL_FILE))
  let entries = []
  try {
    entries = fs.readdirSync(path.join(dataDir, ACCOUNTS_DIR), { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (entry.isDirectory()) push(path.join(dataDir, ACCOUNTS_DIR, entry.name, CREDENTIAL_FILE))
  }
  push(path.join(legacyDesktopDir(), CREDENTIAL_FILE))
  return found
}

// `master.key` is instance-wide and sits at the data directory root, while an
// account's credential file sits two levels below it.
function keyDirectoryFor(file) {
  let dir = path.dirname(file)
  for (let depth = 0; depth < 4; depth += 1) {
    if (fs.existsSync(path.join(dir, KEY_FILE))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function envelopeVersion(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.version ?? null
  } catch {
    return null
  }
}

function openCredentials(file) {
  const version = envelopeVersion(file)
  if (version === 1) {
    return { file, credentials: null, store: null, reason: `${file} was written by the desktop app under Electron safeStorage. Reading it needs Electron; sign in through the server to write a v2 envelope this script can read.` }
  }
  const keyDir = keyDirectoryFor(file)
  if (!keyDir) return { file, credentials: null, store: null, reason: `No ${KEY_FILE} was found at or above ${path.dirname(file)}, so ${file} cannot be decrypted.` }
  const store = createSecretStore({ dir: keyDir })
  const credentials = store.read(file, null)
  if (!credentials) return { file, credentials: null, store: null, reason: `${file} could not be decrypted with the ${KEY_FILE} in ${keyDir}.` }
  return { file, credentials, store, reason: null }
}

function localIsoToday() {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

function responseName(url) {
  const parsed = new URL(url)
  const dataType = parsed.pathname.match(/\/dataTypes\/([^/]+)\/([^/]+)/)
  if (dataType) return `${dataType[1]}:${dataType[2]}`
  return parsed.pathname.split('/').filter(Boolean).slice(-2).join('/') || parsed.hostname
}

// Records `path:type`, never `path=value`, so the default output can be pasted
// into an issue without leaking anybody's health data.
function collectLeafPaths(value, prefix = '', paths = new Set(), depth = 0) {
  if (depth > 10) return paths
  if (Array.isArray(value)) {
    paths.add(`${prefix}[]`)
    for (const item of value.slice(0, 250)) collectLeafPaths(item, `${prefix}[]`, paths, depth + 1)
    return paths
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectLeafPaths(child, prefix ? `${prefix}.${key}` : key, paths, depth + 1)
    }
    return paths
  }
  paths.add(`${prefix}:${value === null ? 'null' : typeof value}`)
  return paths
}

function dataPoints(captures, type) {
  return captures
    .filter((capture) => capture.name.startsWith(`${type}:`))
    .flatMap((capture) => array(capture.body.dataPoints))
}

function rollupPoints(captures, type) {
  return captures
    .filter((capture) => capture.name.startsWith(`${type}:`))
    .flatMap((capture) => array(capture.body.rollupDataPoints))
}

function civilDate(value) {
  const date = value?.date || value
  if (!date?.year || !date?.month || !date?.day) return null
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
}

function recordForDate(items, selector, date) {
  return array(items).find((item) => civilDate(selector(item)?.date) === date) ?? null
}

async function main() {
  const dataDir = argumentValue('data-dir') || defaultDataDir(process.env, process.platform)
  const candidates = credentialFiles(dataDir)
  if (candidates.length === 0) {
    console.error(`No ${CREDENTIAL_FILE} was found under ${dataDir} (or the legacy desktop directory). Connect an account first; this audit cannot run without one.`)
    process.exitCode = 1
    return
  }

  const opened = candidates.map(openCredentials)
  const usable = opened.find((entry) => entry.credentials?.config?.provider === 'google-health' && entry.credentials?.token)
  if (!usable) {
    for (const entry of opened) {
      console.error(entry.reason || `${entry.file} holds no connected Google Health account.`)
    }
    process.exitCode = 1
    return
  }

  const { file: credentialsPath, credentials, store } = usable
  let token = credentials.token
  if (!token.access_token || Number(token.expiresAt || 0) < Date.now() + 90_000) {
    token = await googleHealth.refreshAccessToken(credentials.config, token)
  }

  const captures = []
  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://health.googleapis.com/v4/')) {
      const body = await response.clone().json().catch(() => ({}))
      captures.push({
        name: responseName(url),
        method: init?.method || 'GET',
        status: response.status,
        body,
      })
    }
    return response
  }

  const date = process.argv.find((argument) => /^\d{4}-\d{2}-\d{2}$/.test(argument)) || localIsoToday()
  let translated
  try {
    translated = await googleHealth.syncData(token.access_token, date)
  } finally {
    globalThis.fetch = originalFetch
  }

  let cacheUpdated = false
  if (process.argv.includes('--update-cache')) {
    const total = Number(translated.requestStats?.total || 0)
    const succeeded = Number(translated.requestStats?.succeeded || 0)
    const successfulKeys = array(translated.requestStats?.successfulKeys)
    const minimumUsefulResponses = Math.max(3, Math.ceil(total * 0.2))
    const measurementKeys = ['stepsDaily', 'caloriesDaily', 'distanceDaily', 'activeMinutesDaily', 'zoneMinutesDaily', 'weightDaily', 'waterDaily', 'nutritionDaily', 'heartIntradayRaw', 'restingHeartRaw', 'hrvRaw', 'spo2Raw', 'breathingRaw', 'skinTemperatureRaw', 'cardioRaw', 'sleepRaw', 'activitiesRaw', 'ecgRaw', 'irnAlertsRaw', 'glucoseRaw']
    const hasMeasurementResponse = successfulKeys.some((key) => measurementKeys.includes(key))
    if (!total || succeeded < minimumUsefulResponses || !hasMeasurementResponse) {
      throw new Error('The sync did not return enough valid sources. The previous cache was kept.')
    }

    store.write(path.join(path.dirname(credentialsPath), CACHE_FILE), translated)
    store.write(credentialsPath, { ...credentials, token, lastSyncAt: translated.generatedAt })
    cacheUpdated = true
  }

  const sleepPoints = dataPoints(captures, 'sleep')
  const exercisePoints = dataPoints(captures, 'exercise')
  const activeMinutes = rollupPoints(captures, 'active-minutes')
  const zoneMinutes = rollupPoints(captures, 'active-zone-minutes')
  const hrvPoints = dataPoints(captures, 'daily-heart-rate-variability')
  const oxygenPoints = dataPoints(captures, 'daily-oxygen-saturation')
  const respiratoryPoints = dataPoints(captures, 'daily-respiratory-rate')
  const skinTemperaturePoints = dataPoints(captures, 'daily-sleep-temperature-derivations')

  const groupedResponses = new Map()
  for (const capture of captures) {
    const current = groupedResponses.get(capture.name) || { name: capture.name, pages: 0, dataPoints: 0, rollupDataPoints: 0, fields: new Set() }
    current.pages += 1
    current.dataPoints += array(capture.body.dataPoints).length
    current.rollupDataPoints += array(capture.body.rollupDataPoints).length
    collectLeafPaths(capture.body).forEach((field) => current.fields.add(field))
    groupedResponses.set(capture.name, current)
  }

  const responseGroups = [...groupedResponses.values()].map((group) => ({
    name: group.name,
    pages: group.pages,
    dataPoints: group.dataPoints,
    rollupDataPoints: group.rollupDataPoints,
    fieldCount: group.fields.size,
  })).sort((left, right) => left.name.localeCompare(right.name))

  const rawResponseShapes = captures
    .map((capture) => ({
      name: capture.name,
      method: capture.method,
      status: capture.status,
      dataPoints: array(capture.body.dataPoints).length,
      rollupDataPoints: array(capture.body.rollupDataPoints).length,
      topLevelFields: Object.keys(object(capture.body)).sort(),
      leafPaths: [...collectLeafPaths(capture.body)].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

  // What Tasks 2-4 are waiting on: whether any response carries a goal, a
  // height, or a date of birth at all. Field names only.
  const profileShapeCandidates = [...new Set(rawResponseShapes
    .flatMap((response) => response.leafPaths)
    .filter((leaf) => /goal|target|height|birth|stride|weight|age|gender|locale|timezone|units/i.test(leaf)))].sort()

  const report = {
    date,
    dataDir,
    credentialFile: credentialsPath,
    cacheUpdated,
    requests: {
      expected: translated.requestStats.total,
      succeeded: translated.requestStats.succeeded,
      failed: translated.errors.map((error) => ({ key: error.key, status: error.status ?? null })),
      capturedGoogleResponses: captures.length,
    },
    nonEmptyResponses: responseGroups.filter((group) => group.dataPoints || group.rollupDataPoints || group.fieldCount),
    emptyResponses: responseGroups.filter((group) => !group.dataPoints && !group.rollupDataPoints && !group.fieldCount).map((group) => group.name),
    rawResponseShapes,
    profileShapeCandidates,
    translatedEndpointShape: [...collectLeafPaths(object(translated.endpoints))].sort(),
  }

  // Values are opt-in. The default output is safe to paste into an issue or a
  // commit message; this branch is not.
  if (process.argv.includes('--values')) {
    const currentSleep = sleepPoints.find((point) => point.sleep?.interval?.endTime?.slice(0, 10) === date) ?? null
    const currentHrv = recordForDate(hrvPoints, (point) => point.dailyHeartRateVariability, date)
    const currentOxygen = recordForDate(oxygenPoints, (point) => point.dailyOxygenSaturation, date)
    const currentRespiratory = recordForDate(respiratoryPoints, (point) => point.dailyRespiratoryRate, date)
    const currentSkinTemperature = recordForDate(skinTemperaturePoints, (point) => point.dailySleepTemperatureDerivations, date)
    const currentActiveMinutes = activeMinutes.find((point) => civilDate(point.civilStartTime) === date) ?? null
    const currentZoneMinutes = zoneMinutes.find((point) => civilDate(point.civilStartTime) === date) ?? null

    report.values = {
      currentRawValues: {
        sleep: currentSleep ? {
          type: currentSleep.sleep?.type ?? null,
          metadata: object(currentSleep.sleep?.metadata),
          summary: object(currentSleep.sleep?.summary),
          stageSegmentCount: array(currentSleep.sleep?.stages).length,
        } : null,
        activeMinuteLevels: array(currentActiveMinutes?.activeMinutes?.activeMinutesRollupByActivityLevel),
        activeZoneMinuteBuckets: object(currentZoneMinutes?.activeZoneMinutes),
        hrv: object(currentHrv?.dailyHeartRateVariability),
        oxygenSaturation: object(currentOxygen?.dailyOxygenSaturation),
        respiratoryRate: object(currentRespiratory?.dailyRespiratoryRate),
        skinTemperature: object(currentSkinTemperature?.dailySleepTemperatureDerivations),
      },
      profileResponses: captures
        .filter((capture) => /profile|settings/i.test(capture.name))
        .map((capture) => ({ name: capture.name, body: capture.body })),
      rawHighlights: {
        sleep: sleepPoints.map((point) => ({
          pointFields: Object.keys(object(point)).sort(),
          sleepFields: Object.keys(object(point.sleep)).sort(),
          metadata: object(point.sleep?.metadata),
          summary: object(point.sleep?.summary),
          stageSegmentCount: array(point.sleep?.stages).length,
        })),
        activeMinuteLevels: activeMinutes.map((point) => array(point.activeMinutes?.activeMinutesRollupByActivityLevel)),
        activeZoneMinuteBuckets: zoneMinutes.map((point) => object(point.activeZoneMinutes)),
        exercises: exercisePoints.map((point) => ({
          fields: Object.keys(object(point.exercise)).sort(),
          type: point.exercise?.exerciseType ?? null,
          displayName: point.exercise?.displayName ?? null,
          metricsSummary: object(point.exercise?.metricsSummary),
          hasRouteOrLocation: Boolean(point.exercise?.route || point.exercise?.location || point.exercise?.laps),
        })),
        hrv: hrvPoints.map((point) => object(point.dailyHeartRateVariability)),
        oxygenSaturation: oxygenPoints.map((point) => object(point.dailyOxygenSaturation)),
        respiratoryRate: respiratoryPoints.map((point) => object(point.dailyRespiratoryRate)),
        skinTemperature: skinTemperaturePoints.map((point) => object(point.dailySleepTemperatureDerivations)),
      },
    }
  }

  if (process.argv.includes('--summary')) {
    console.log(JSON.stringify({
      date: report.date,
      cacheUpdated: report.cacheUpdated,
      requests: report.requests,
      nonEmptyResponses: report.nonEmptyResponses,
      emptyResponses: report.emptyResponses,
      profileShapeCandidates: report.profileShapeCandidates,
    }, null, 2))
    return
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
