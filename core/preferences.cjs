'use strict'

// Per-account UI preferences. Chart favourites are a small thing, but the value
// is user input that is persisted and echoed straight back to the browser, so it
// is sanitized on the way in *and* on the way out — a file that was corrupted or
// written by an older build must never reach the UI unchecked.

const EMPTY_PREFERENCES = Object.freeze({ favouriteCharts: Object.freeze([]) })

// Chart ids are kebab-case slugs from the client's own registry. Anything else
// is either a bug or an attempt to smuggle a path or markup through the store.
const CHART_ID = /^[a-z0-9-]{1,64}$/

// A client bug that appended on every render must not be able to grow an
// unbounded array inside the encrypted store.
const MAX_FAVOURITE_CHARTS = 64

function sanitizeFavouriteCharts(value) {
  if (!Array.isArray(value)) return []
  const unique = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (!CHART_ID.test(id)) continue
    unique.add(id)
  }
  // Sorted before the cap so the same input always yields the same stored list.
  return [...unique].sort().slice(0, MAX_FAVOURITE_CHARTS)
}

function createPreferencesStore({ secrets, preferencesFile } = {}) {
  if (!secrets) throw new Error('createPreferencesStore requires a secret store.')
  if (!preferencesFile) throw new Error('createPreferencesStore requires a preferences file path.')

  function read() {
    const stored = secrets.read(preferencesFile, null)
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { favouriteCharts: [] }
    return { favouriteCharts: sanitizeFavouriteCharts(stored.favouriteCharts) }
  }

  /**
   * Merges a patch. A patch that does not name `favouriteCharts` leaves the
   * stored list alone, so a caller saving one preference cannot silently clear
   * the others as this shape grows.
   */
  function save(patch) {
    const next = read()
    const update = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
    if (Object.prototype.hasOwnProperty.call(update, 'favouriteCharts')) {
      next.favouriteCharts = sanitizeFavouriteCharts(update.favouriteCharts)
    }
    secrets.write(preferencesFile, next)
    return next
  }

  return { read, save, describe: () => secrets.describe() }
}

module.exports = { createPreferencesStore, EMPTY_PREFERENCES, CHART_ID, MAX_FAVOURITE_CHARTS }
