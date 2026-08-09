'use strict'

// The profile is personal data, so it lives behind the same secret store as
// credentials and the health cache rather than in the browser. Every field is
// optional and every consumer handles null, so a profile that is never filled in
// degrades to exactly today's behavior.

const EMPTY_PROFILE = Object.freeze({
  birthYear: null,
  heightCm: null,
  measuredMaxHeartRate: null,
  stepsGoal: null,
  sleepGoalMinutes: null,
  waterGoalMl: null,
  weightGoalKg: null,
  userEdited: [],
})

// Ranges are wide on purpose. They exist to reject transcription errors and
// hostile input, not to police what a human body can be.
const FIELD_RANGES = {
  birthYear: [1900, 2100],
  heightCm: [50, 260],
  measuredMaxHeartRate: [80, 260],
  stepsGoal: [100, 200000],
  sleepGoalMinutes: [60, 900],
  waterGoalMl: [100, 20000],
  weightGoalKg: [20, 400],
}

const FIELDS = Object.keys(FIELD_RANGES)

function sanitize(field, value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  const [min, max] = FIELD_RANGES[field]
  if (numeric < min || numeric > max) return null
  return field === 'weightGoalKg' ? Number(numeric.toFixed(1)) : Math.round(numeric)
}

function createUserProfileStore({ secrets, profileFile }) {
  if (!secrets) throw new Error('createUserProfileStore requires a secret store.')
  if (!profileFile) throw new Error('createUserProfileStore requires a profile file path.')

  function read() {
    const stored = secrets.read(profileFile, null)
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { ...EMPTY_PROFILE }
    const profile = { ...EMPTY_PROFILE }
    for (const field of FIELDS) profile[field] = sanitize(field, stored[field])
    profile.userEdited = Array.isArray(stored.userEdited)
      ? stored.userEdited.filter((entry) => FIELDS.includes(entry))
      : []
    return profile
  }

  /**
   * Merges a patch. `source: 'provider'` is a prefill and must never overwrite a
   * field the user has edited by hand — a sync that silently reverted a typed
   * value would be indistinguishable from data loss.
   */
  function save(patch, options = {}) {
    const source = options.source === 'provider' ? 'provider' : 'user'
    const current = read()
    const next = { ...current }
    const edited = new Set(current.userEdited)

    for (const field of FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch || {}, field)) continue
      if (source === 'provider' && edited.has(field)) continue
      next[field] = sanitize(field, patch[field])
      if (source === 'user') edited.add(field)
    }

    next.userEdited = [...edited].sort()
    secrets.write(profileFile, next)
    return next
  }

  return { read, save, describe: () => secrets.describe() }
}

module.exports = { createUserProfileStore, EMPTY_PROFILE, FIELDS, FIELD_RANGES }
