'use strict'

const CACHE_VERSION = 2

function emptyArchive() {
  return { version: CACHE_VERSION, lastDate: null, days: {} }
}

function normalizeArchive(value) {
  if (value?.version === CACHE_VERSION && value.days && typeof value.days === 'object') {
    return {
      version: CACHE_VERSION,
      lastDate: typeof value.lastDate === 'string' ? value.lastDate : null,
      days: { ...value.days },
    }
  }

  // Version 1 stored one raw payload directly in the encrypted cache file.
  if (value && typeof value === 'object' && typeof value.date === 'string') {
    return { version: CACHE_VERSION, lastDate: value.date, days: { [value.date]: value } }
  }

  return emptyArchive()
}

function cachedDay(value, date) {
  return normalizeArchive(value).days[date] || null
}

function latestDay(value) {
  const archive = normalizeArchive(value)
  if (archive.lastDate && archive.days[archive.lastDate]) return archive.days[archive.lastDate]
  const dates = Object.keys(archive.days).sort()
  return dates.length ? archive.days[dates.at(-1)] : null
}

function storeDay(value, payload) {
  const archive = normalizeArchive(value)
  return {
    version: CACHE_VERSION,
    lastDate: payload.date,
    days: { ...archive.days, [payload.date]: payload },
  }
}

module.exports = { CACHE_VERSION, normalizeArchive, cachedDay, latestDay, storeDay }
