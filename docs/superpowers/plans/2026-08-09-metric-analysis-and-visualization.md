# Metric Analysis and AI-Powered Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the data OpenFit already collects into analysis the user can act on — cardio load, strain, recovery, correlations, anomalies — computed locally and always available, with the assistant reasoning on top of the same numbers.

**Architecture:** Four layers, bottom-up. (1) The Google Health adapter stops discarding profile, settings, and goals. (2) A user-profile store in `core/`, served over HTTP, supplies the facts the provider cannot. (3) Pure analysis modules in `src/lib/` compute every derived figure with no React and no I/O. (4) Chart primitives and view wiring render them, and the assistant context carries the same computed values so the chat cannot contradict the screen.

**Tech Stack:** Node 22 CommonJS (`core/`, `server/`), React 19 + TypeScript 6 + Vite 8 (`src/`), vitest 4, AES-256-GCM via `core/secrets.cjs`.

## Global Constraints

- **No invented composite scores.** `docs/HOME_DASHBOARD_MODEL.md` forbids them. Every number traces to a measurement, an explicit goal, or a visible personal baseline. The two composites this plan admits — Edwards TRIMP and ACWR — are published formulas, are reported in their own documented units, and show their inputs on the same screen. No 0-100 wellness score. No single recovery number.
- **Absent is never zero.** A missing metric renders as missing, is excluded from means, and is reported with its real sample count.
- **Insufficient data returns `null`, never `NaN` or `0`.** Every analysis function states its minimum sample count and honors it.
- **Pure functions only in `src/lib/`.** No React imports, no `fetch`, no `Date.now()` outside an explicitly injected parameter. This is what makes them testable without a DOM.
- **No jsdom, no testing-library.** The project has no component tests. Chart geometry is extracted into exported pure functions and tested directly; components are not.
- **Every task ends green on `npm run check`** (typecheck, `check:node`, `vitest run`, production build).
- Commit after every task. Author is the repository's configured `i-am-pluto` identity; do not pass `--author`.
- Never run the audit script with `--update-cache`; it would overwrite the real encrypted health cache.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/audit-google-health-raw.cjs` (modify) | Repointed at `core/providers/google-health.cjs` and runnable under plain Node. |
| `core/providers/google-health.cjs` (modify) | Stop discarding profile/settings/goals; derive BMI. |
| `core/user-profile.cjs` (create) | Encrypted read/write of the seven profile facts, built on `createSecretStore`. |
| `server/routes/health.cjs` (modify) | `GET`/`POST /api/profile`. |
| `core/app.cjs` (modify) | Compose the profile store; expose `getProfile`/`saveProfile`. |
| `src/lib/user-profile.ts` (create) | Derived values: max HR, BMI, Karvonen zones, goal precedence. |
| `src/lib/metric-analysis.ts` (create) | Correlation, anomalies, rollups, histogram, band stats, energy balance, HR zones. |
| `src/lib/cardio-load.ts` (create) | Edwards TRIMP and acute:chronic workload ratio. |
| `src/lib/recovery-panel.ts` (create) | Four independent baseline deviations. Nothing summed. |
| `src/lib/insight-engine.ts` (create) | Deterministic, severity-ordered insights with cited evidence and seeded prompts. |
| `src/components/analysis-chart-geometry.ts` (create) | Pure geometry for the five new chart shapes. |
| `src/components/AnalysisCharts.tsx` (create) | The five components. Keeps `Charts.tsx` at its current size. |
| `src/components/ProfileSettings.tsx` (create) | The profile capture form. |
| `src/components/Views.tsx` (modify) | Panel wiring per view. |
| `src/lib/health-assistant.ts` (modify) | The `analysis` context block. |
| `src/types.ts` (modify) | `UserProfile` and the new payload passthrough fields. |

## Task Dependency Order

Tasks 1-2 are provider work. Tasks 3-4 are the profile. Tasks 5-8 are pure analysis and depend only on Task 4's types. Tasks 9-10 are charts. Tasks 11-13 are wiring and depend on everything above.

---

### Task 1: Make the provider audit runnable

**Files:**
- Modify: `scripts/audit-google-health-raw.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: a runnable audit. No source export.

**Background you need.** The script currently opens with
`require('../electron/google-health-service.cjs')`. The server restructure moved
that module to `core/providers/google-health.cjs` and deleted the old path, so
the script throws `Cannot find module` before doing anything. It is also
Electron-bound, so on a headless host it fails a second way with
`Missing X server or $DISPLAY` and a SIGSEGV.

This audit is what tells us which fields `/users/me/profile` and
`/users/me/settings` actually return. Until it runs, Task 3's prefill mapping is
written defensively and every field stays manually editable — so this task
unblocks a refinement, not the feature.

**This task cannot be fully verified on a host with no connected account.** If
`ls ~/.local/share/openfit/**/credentials.secure.json` finds nothing, complete
steps 1-4, record the blocked state in the commit message, and move on. Do not
initiate an OAuth flow to unblock it.

- [ ] **Step 1: Read the script and find every stale reference**

Run: `grep -n "electron/\|require(" scripts/audit-google-health-raw.cjs`
Expected: at least one `require('../electron/google-health-service.cjs')`.

- [ ] **Step 2: Repoint the requires**

Replace `require('../electron/google-health-service.cjs')` with
`require('../core/providers/google-health.cjs')`. Check the exported names still
match with `grep -n "^module.exports" core/providers/google-health.cjs` and fix
any destructure that no longer resolves.

- [ ] **Step 3: Remove the Electron dependency**

The script needs a secret store to read credentials. Build one directly rather
than through Electron:

```js
const { createSecretStore } = require('../core/secrets.cjs')
const store = createSecretStore({ dir: dataDir })   // no safeStorage: plain Node
```

`core/secrets.cjs` reads both envelope versions, so a v2 (AES-GCM) credential
file written by the server decrypts here. A v1 envelope written by the desktop
app under `safeStorage` will **not** decrypt without Electron; if that happens
the store returns the fallback rather than throwing, so print an explicit
"this credential file was written by the desktop app and needs Electron to read"
message instead of reporting an empty response as an empty API.

- [ ] **Step 4: Guard the output**

The audit prints real health data. Ensure the script's default output is
type-level only — key paths and value *types*, not values. Confirm with
`grep -n "leafPaths\|typeof" scripts/audit-google-health-raw.cjs`. If it dumps
values, add a `--values` flag and make type-level the default.

- [ ] **Step 5: Verify it loads**

Run: `node -e "require('./scripts/audit-google-health-raw.cjs')" 2>&1 | head -5`
Expected: no `Cannot find module`. A "no credentials" message is a pass.

- [ ] **Step 6: Run it if an account exists**

Run: `ls ~/.local/share/openfit/*/credentials.secure.json 2>/dev/null`

If a file exists:
```bash
node scripts/audit-google-health-raw.cjs > /tmp/claude-1000/-home-parikshit-code-openfit/47f7d326-aeba-4e9d-b0af-993e0e70349f/scratchpad/audit.txt 2>&1
grep -iE "profile|settings|goal|height|birth|weight" /tmp/claude-1000/-home-parikshit-code-openfit/47f7d326-aeba-4e9d-b0af-993e0e70349f/scratchpad/audit.txt
```
Record the field names found in a comment block at the top of
`core/providers/google-health.cjs`. Keep the full output in the scratchpad —
do not paste health values into a commit message or the transcript.

If no file exists: skip, and note it.

- [ ] **Step 7: Commit**

```bash
git add scripts/audit-google-health-raw.cjs
git commit -m "fix: repoint the provider audit at core and drop its Electron dependency"
```

---

### Task 2: Stop the adapter discarding goals, profile, and BMI

**Files:**
- Modify: `core/providers/google-health.cjs` (lines 228-229, 476-477, 557, 559, 566, 588, 590, 592)
- Modify: `core/providers/google-health.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RawFitbitPayload.endpoints.profileRaw` and `.settingsRaw` reaching
  the normalizer intact, plus populated `activityGoals`, `sleepGoal`,
  `weightGoal`, `waterGoal`, and a derived `bmi` on `bodyWeight` entries.

**Background you need — this is a pre-existing bug, not new work.** The adapter
fetches `/users/me/profile` and `/users/me/settings` on every sync, then throws
almost all of it away: only `membershipStartDate` and `timeZone` survive
translation. Separately it emits `activityGoals: { goals: {} }`,
`sleepGoal: { goal: {} }`, `weightGoal: { goal: {} }`, and
`waterGoal: { goal: {} }` — all empty.

The consequence is that **every goal is null for every Google Health user**, so
goal rings, target lines, bullet charts, and "percent of goal" notes are dead on
the primary provider and light up only on legacy Fitbit or demo data. Fixing
this is worth more to the user than any new chart, and everything downstream in
this plan reads better once goals exist.

- [ ] **Step 1: Write the failing test**

Add to `core/providers/google-health.test.ts`:

```ts
describe('google health goal and profile passthrough', () => {
  it('carries the raw profile and settings through to the payload', () => {
    const raw = {
      profileRaw: { user: { height: 178, dateOfBirth: '1990-04-12', strideLengthWalking: 71 } },
      settingsRaw: { timeZone: 'Europe/Rome' },
    }
    const payload = translate(raw, '2026-08-09')
    expect(payload.endpoints.profileRaw).toEqual(raw.profileRaw)
    expect(payload.endpoints.settingsRaw).toEqual(raw.settingsRaw)
  })

  it('maps recognized goal fields instead of emitting empty objects', () => {
    const raw = {
      profileRaw: { user: { height: 178 } },
      goalsRaw: { steps: 9000, caloriesOut: 2400, distance: 7.5, floors: 12, activeMinutes: 45 },
      sleepGoalRaw: { minDuration: 450 },
      weightGoalRaw: { weight: 71.5 },
      waterGoalRaw: { goal: 2400 },
    }
    const payload = translate(raw, '2026-08-09')
    expect(payload.endpoints.activityGoals.goals.steps).toBe(9000)
    expect(payload.endpoints.sleepGoal.goal.minDuration).toBe(450)
    expect(payload.endpoints.weightGoal.goal.weight).toBe(71.5)
    expect(payload.endpoints.waterGoal.goal.goal).toBe(2400)
  })

  it('leaves goals absent rather than zero when the provider sends nothing', () => {
    const payload = translate({}, '2026-08-09')
    expect(payload.endpoints.activityGoals.goals.steps ?? null).toBeNull()
    expect(payload.endpoints.sleepGoal.goal.minDuration ?? null).toBeNull()
  })

  it('derives BMI from height when the provider omits it', () => {
    const raw = {
      profileRaw: { user: { height: 178 } },
      weightRaw: [['2026-08-09', 72.4]],
    }
    const payload = translate(raw, '2026-08-09')
    const entry = payload.endpoints.bodyWeight.weight.find((w) => w.date === '2026-08-09')
    // 72.4 / 1.78^2 = 22.85
    expect(entry.bmi).toBeCloseTo(22.85, 1)
  })

  it('leaves BMI null when height is unknown', () => {
    const payload = translate({ weightRaw: [['2026-08-09', 72.4]] }, '2026-08-09')
    const entry = payload.endpoints.bodyWeight.weight.find((w) => w.date === '2026-08-09')
    expect(entry.bmi).toBeNull()
  })

  it('ignores an unrecognized response shape rather than throwing', () => {
    expect(() => translate({ profileRaw: 'unexpected', goalsRaw: 42 }, '2026-08-09')).not.toThrow()
  })
})
```

Adjust `translate` to whatever the module actually exports — check with
`grep -n "^module.exports" core/providers/google-health.cjs` and match the
existing tests' import style in the same file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/providers/google-health.test.ts`
Expected: FAIL on the passthrough, goal, and BMI tests.

- [ ] **Step 3: Add the goal requests if they are absent**

Check whether the request list around line 228 already fetches goals:
`grep -n "goal" core/providers/google-health.cjs`

If the Google Health v4 API exposes goals at all, add the request beside the
existing `profileRaw` / `settingsRaw` entries. If Task 1's audit showed no goal
endpoint exists, skip this step — the profile fallback in Task 4 becomes the
only source and that is expected. Record which case applies in a comment.

- [ ] **Step 4: Write the passthrough and mapping**

In the translation function, replace the empty-object literals. Map
**defensively**: read through optional chaining, coerce with the module's
existing `numeric()` helper, and let an unrecognized shape yield `null` rather
than throwing.

```js
// Kept raw so the renderer can prefill the user profile from whatever the
// provider actually returned. Field names here are not guaranteed by the v4
// API docs, so nothing downstream may assume a key exists.
const profileUser = (raw.profileRaw && typeof raw.profileRaw === 'object' && raw.profileRaw.user) || {}
const heightCm = numeric(profileUser.height)

// ...
profileRaw: raw.profileRaw ?? null,
settingsRaw: raw.settingsRaw ?? null,
activityGoals: { goals: withoutUndefined({
  steps: numeric(raw.goalsRaw?.steps),
  caloriesOut: numeric(raw.goalsRaw?.caloriesOut),
  distance: numeric(raw.goalsRaw?.distance),
  floors: numeric(raw.goalsRaw?.floors),
  activeMinutes: numeric(raw.goalsRaw?.activeMinutes),
}) },
sleepGoal: { goal: withoutUndefined({ minDuration: numeric(raw.sleepGoalRaw?.minDuration) }) },
weightGoal: { goal: withoutUndefined({ weight: numeric(raw.weightGoalRaw?.weight) }) },
waterGoal: { goal: withoutUndefined({ goal: numeric(raw.waterGoalRaw?.goal) }) },
```

For BMI at line 588, replace `bmi: null`:

```js
bodyWeight: {
  weight: weightEntries.map(([date, weight]) => ({
    date,
    weight,
    // Provider BMI when it sends one; otherwise derived, but only when height
    // is known. Never a guess.
    bmi: numeric(providerBmi?.[date])
      ?? (heightCm && weight ? Number((weight / ((heightCm / 100) ** 2)).toFixed(2)) : null),
  })),
},
```

Add the small helper if the module has no equivalent:

```js
// An absent goal must stay absent. Emitting `steps: null` would let a consumer
// that only checks `in` treat "no goal" as "a goal of nothing".
function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined))
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run core/providers/google-health.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm the normalizer reads the new fields**

Run: `grep -n "activityGoals\|sleepGoal\|weightGoal\|waterGoal" src/data/normalize.ts`
Expected: each already read. The normalizer was written against the legacy
Fitbit shapes, which are the shapes just produced — so no normalizer change
should be needed. If a key differs, change the **adapter** to match the
normalizer, not the reverse; legacy Fitbit still emits the original shape.

- [ ] **Step 7: Run the full gate and commit**

```bash
npm run check
git add core/providers/google-health.cjs core/providers/google-health.test.ts
git commit -m "fix: stop discarding Google Health goals, profile, and BMI"
```

---

### Task 3: Store the user profile

**Files:**
- Create: `core/user-profile.cjs`
- Create: `core/user-profile.test.ts`
- Modify: `core/app.cjs` (compose the store beside `createCredentialStore`, ~line 51; add to the returned object, ~line 224)
- Modify: `server/routes/health.cjs`
- Modify: `server/routes.test.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `createSecretStore` from `core/secrets.cjs`.
- Produces:
  - `createUserProfileStore({ secrets, profileFile }) -> { read(), save(patch), describe() }`
  - `app.getProfile(): UserProfile`, `app.saveProfile(patch): UserProfile`
  - `GET /api/profile`, `POST /api/profile`
  - `profile.get()` / `profile.save(patch)` on the `src/lib/api.ts` client
  - `UserProfile` in `src/types.ts`

**Background you need.** The profile is personal data, so it follows the same
boundary as credentials and the health cache — `core/secrets.cjs`, AES-256-GCM,
keyed by `master.key` — and never `localStorage`. `createSecretStore` works in
both Electron and headless server mode, so no IPC channel and no preload change
is required.

Biological sex is deliberately **not** collected. Its only use would be generic
population threshold tables, which `HOME_DASHBOARD_MODEL.md` rejects, and
collecting sensitive data with no consumer is worse than not collecting it.

Each field earns its place by naming a consumer:

| Field | Consumer |
|---|---|
| `birthYear` | Tanaka max-HR estimate -> Karvonen zones, VO2 max context |
| `heightCm` | BMI from weight -> BMI trend |
| `measuredMaxHeartRate` | overrides the estimate when the user knows it |
| `stepsGoal`, `sleepGoalMinutes`, `waterGoalMl`, `weightGoalKg` | goal lines when the provider returns none |

- [ ] **Step 1: Add the type**

In `src/types.ts`, after the `HealthProvider` type:

```ts
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
```

- [ ] **Step 2: Write the failing store test**

Create `core/user-profile.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createUserProfileStore, EMPTY_PROFILE } = require('./user-profile.cjs')

function memoryStore() {
  const files = new Map<string, unknown>()
  return {
    files,
    read: (file: string, fallback: unknown = null) => (files.has(file) ? files.get(file) : fallback),
    write: (file: string, value: unknown) => { files.set(file, JSON.parse(JSON.stringify(value))) },
    remove: (file: string) => { files.delete(file) },
    describe: () => ({ encrypted: true, backend: 'aes-256-gcm' }),
  }
}

describe('user profile store', () => {
  it('returns an all-null profile before anything is written', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    expect(store.read()).toEqual(EMPTY_PROFILE)
  })

  it('round-trips a saved profile', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ birthYear: 1990, heightCm: 178 })
    expect(store.read()).toMatchObject({ birthYear: 1990, heightCm: 178 })
  })

  it('merges a patch instead of replacing the profile', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ birthYear: 1990 })
    store.save({ heightCm: 178 })
    expect(store.read()).toMatchObject({ birthYear: 1990, heightCm: 178 })
  })

  it('records which fields the user edited', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ heightCm: 178 }, { source: 'user' })
    expect(store.read().userEdited).toContain('heightCm')
  })

  it('never lets a provider prefill overwrite a user edit', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ heightCm: 178 }, { source: 'user' })
    store.save({ heightCm: 165 }, { source: 'provider' })
    expect(store.read().heightCm).toBe(178)
  })

  it('lets a provider prefill fill a field the user never touched', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ heightCm: 165 }, { source: 'provider' })
    expect(store.read().heightCm).toBe(165)
  })

  it('rejects values outside a physically plausible range', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ birthYear: 1200, heightCm: -5, measuredMaxHeartRate: 700 })
    const saved = store.read()
    expect(saved.birthYear).toBeNull()
    expect(saved.heightCm).toBeNull()
    expect(saved.measuredMaxHeartRate).toBeNull()
  })

  it('drops unknown keys rather than persisting arbitrary input', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ heightCm: 178, evil: 'payload' } as never)
    expect(store.read()).not.toHaveProperty('evil')
  })

  it('clears a field when the user explicitly blanks it', () => {
    const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
    store.save({ heightCm: 178 }, { source: 'user' })
    store.save({ heightCm: null }, { source: 'user' })
    expect(store.read().heightCm).toBeNull()
  })

  it('survives a corrupt file by returning the empty profile', () => {
    const secrets = memoryStore()
    secrets.files.set('/p', 'not an object')
    const store = createUserProfileStore({ secrets, profileFile: '/p' })
    expect(store.read()).toEqual(EMPTY_PROFILE)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run core/user-profile.test.ts`
Expected: FAIL — `Cannot find module './user-profile.cjs'`.

- [ ] **Step 4: Write the store**

Create `core/user-profile.cjs`:

```js
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run core/user-profile.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Compose it into the app**

In `core/app.cjs`, beside the `createCredentialStore` call:

```js
const { createUserProfileStore } = require('./user-profile.cjs')
// ...
const userProfile = createUserProfileStore({
  secrets,
  profileFile: path.join(dataDir, 'user-profile.secure.json'),
})
```

And in the returned object, beside `getCachedArchive`:

```js
getProfile: () => userProfile.read(),
saveProfile: (patch) => userProfile.save(patch, { source: 'user' }),
```

- [ ] **Step 7: Register the routes**

In `server/routes/health.cjs`, beside the existing `add(...)` calls:

```js
  add('GET', '/api/profile', (request, response, { app }) => app.getProfile())

  // The body is a partial profile. Validation lives in the store, which is the
  // only thing that writes to disk — a route-level check would be a second,
  // drifting copy of the same rules.
  add('POST', '/api/profile', (request, response, { app, body }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('The profile update must be an object.')
    }
    return app.saveProfile(body)
  })
```

- [ ] **Step 8: Add the route tests**

In `server/routes.test.ts`, following the file's existing harness pattern:

```ts
it('round-trips the user profile', async () => {
  const saved = await post('/api/profile', { birthYear: 1990, heightCm: 178 })
  expect(saved).toMatchObject({ birthYear: 1990, heightCm: 178 })
  expect(await get('/api/profile')).toMatchObject({ birthYear: 1990, heightCm: 178 })
})

it('rejects a non-object profile body', async () => {
  await expect(post('/api/profile', ['not', 'an', 'object'])).rejects.toThrow()
})

it('returns an all-null profile before anything is saved', async () => {
  expect(await get('/api/profile')).toMatchObject({ birthYear: null, heightCm: null })
})
```

Match the helper names the file already uses; if it drives requests differently,
follow that instead of introducing `get`/`post`.

- [ ] **Step 9: Add the client methods**

In `src/lib/api.ts`, after the `fitbit` export:

```ts
export const profile = {
  get: () => request<UserProfile>('/api/profile'),
  save: (patch: Partial<UserProfile>) => request<UserProfile>('/api/profile', 'POST', patch),
}
```

Add `UserProfile` to the type import at the top of the file.

- [ ] **Step 10: Prefill from the provider after a sync**

Task 2 makes `profileRaw` and `settingsRaw` reach the payload. Nothing yet reads
them into the profile, so without this step prefill is designed but not wired.

In `core/app.cjs`, after a successful sync stores its payload, map whatever the
provider returned onto the profile with `source: 'provider'`. The store already
refuses to overwrite a user edit, so this is safe to run on every sync:

```js
// Field names in the v4 profile response are unverified — the audit in Task 1
// could not run. Map defensively: anything unrecognized is simply absent, and
// every field stays editable by hand, so a wrong guess costs nothing.
function prefillFromProvider(payload) {
  const user = payload?.endpoints?.profileRaw?.user
  if (!user || typeof user !== 'object') return
  userProfile.save({
    heightCm: user.height ?? null,
    birthYear: typeof user.dateOfBirth === 'string' && /^\d{4}/.test(user.dateOfBirth)
      ? Number(user.dateOfBirth.slice(0, 4))
      : null,
  }, { source: 'provider' })
}
```

Call it from the sync completion path. Guard it in a `try`/`catch` that swallows
the error: a malformed profile response must never fail a sync that otherwise
succeeded.

- [ ] **Step 11: Test the prefill precedence end to end**

Add to `core/user-profile.test.ts`:

```ts
it('prefills an untouched field but never a user-edited one', () => {
  const store = createUserProfileStore({ secrets: memoryStore(), profileFile: '/p' })
  store.save({ birthYear: 1985 }, { source: 'user' })
  store.save({ birthYear: 1990, heightCm: 178 }, { source: 'provider' })
  const saved = store.read()
  expect(saved.birthYear).toBe(1985)   // the user's edit stands
  expect(saved.heightCm).toBe(178)     // the untouched field is filled
})
```

Run: `npx vitest run core/user-profile.test.ts`
Expected: PASS.

- [ ] **Step 12: Run the full gate and commit**

```bash
npm run check
git add core/user-profile.cjs core/user-profile.test.ts core/app.cjs server/routes/health.cjs server/routes.test.ts src/lib/api.ts src/types.ts
git commit -m "feat: store the user profile in the encrypted secret store"
```

---

### Task 4: Derive max HR, BMI, zones, and goal precedence

**Files:**
- Create: `src/lib/user-profile.ts`
- Create: `src/lib/user-profile.test.ts`

**Interfaces:**
- Consumes: `UserProfile`, `DashboardData` from `@/types`.
- Produces:
  - `EMPTY_USER_PROFILE: UserProfile`
  - `maxHeartRate(profile, referenceYear): { value: number | null; basis: 'measured' | 'estimated' | null }`
  - `bmiFor(weightKg, profile): number | null`
  - `karvonenZones(restingHr, maxHr): HeartRateZone[] | null`
  - `resolveGoals(data, profile): ResolvedGoals`
  - `profileCompleteness(profile): { missing: Array<{ field: keyof UserProfile; unlocks: string }> }`
  - `interface HeartRateZone { key: 'light' | 'moderate' | 'vigorous' | 'peak'; label: string; min: number; max: number }`
  - `interface ResolvedGoals { steps: Goal; sleepMinutes: Goal; waterMl: Goal; weightKg: Goal }`
  - `interface Goal { value: number | null; source: 'provider' | 'profile' | null }`

**Background you need.** Tanaka's estimate is `208 - 0.7 * age`. It is an
estimate for a population, not a measurement of this person, so the UI must
label which of the two applies and must never present the estimate as measured —
hence `basis` travels with the value rather than being inferred later.

Karvonen zones work on heart-rate *reserve*: `reserve = maxHr - restingHr`, and
a zone boundary at intensity `i` is `restingHr + reserve * i`. Both inputs are
the user's own numbers, so the zones are personal rather than a population table.
Zones are omitted entirely when `maxHr` is null; a zone chart with an invented
ceiling is worse than no zone chart.

Goal precedence is provider, then profile, then absent — a provider goal is the
one the user configured in the Google or Fitbit app, so it outranks a value they
typed into OpenFit. `source` travels with the goal so the UI can say where it
came from.

- [ ] **Step 1: Write the failing test**

Create `src/lib/user-profile.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import {
  EMPTY_USER_PROFILE,
  bmiFor,
  karvonenZones,
  maxHeartRate,
  profileCompleteness,
  resolveGoals,
} from './user-profile'

const profile = { ...EMPTY_USER_PROFILE }

describe('maxHeartRate', () => {
  it('uses the Tanaka estimate from birth year', () => {
    // age 36 -> 208 - 0.7 * 36 = 182.8
    const result = maxHeartRate({ ...profile, birthYear: 1990 }, 2026)
    expect(result.value).toBeCloseTo(182.8, 1)
    expect(result.basis).toBe('estimated')
  })

  it('prefers a measured value over the estimate', () => {
    const result = maxHeartRate({ ...profile, birthYear: 1990, measuredMaxHeartRate: 194 }, 2026)
    expect(result.value).toBe(194)
    expect(result.basis).toBe('measured')
  })

  it('returns null with no basis when neither is known', () => {
    expect(maxHeartRate(profile, 2026)).toEqual({ value: null, basis: null })
  })
})

describe('bmiFor', () => {
  it('derives BMI from weight and height', () => {
    expect(bmiFor(72.4, { ...profile, heightCm: 178 })).toBeCloseTo(22.85, 2)
  })

  it('returns null without a height', () => {
    expect(bmiFor(72.4, profile)).toBeNull()
  })

  it('returns null without a weight', () => {
    expect(bmiFor(null, { ...profile, heightCm: 178 })).toBeNull()
  })
})

describe('karvonenZones', () => {
  it('spans the heart-rate reserve between resting and max', () => {
    const zones = karvonenZones(58, 183)
    expect(zones).not.toBeNull()
    expect(zones!).toHaveLength(4)
    // reserve 125; light starts at 58 + 125 * 0.5 = 120.5
    expect(zones![0].min).toBeCloseTo(120.5, 1)
    expect(zones!.at(-1)!.max).toBe(183)
  })

  it('produces contiguous, ascending bands', () => {
    const zones = karvonenZones(58, 183)!
    for (let index = 1; index < zones.length; index += 1) {
      expect(zones[index].min).toBeCloseTo(zones[index - 1].max, 5)
      expect(zones[index].max).toBeGreaterThan(zones[index].min)
    }
  })

  it('returns null without a max heart rate', () => {
    expect(karvonenZones(58, null)).toBeNull()
  })

  it('returns null when resting is not below max', () => {
    expect(karvonenZones(190, 183)).toBeNull()
  })
})

describe('resolveGoals', () => {
  it('prefers the provider goal over the profile', () => {
    const data = createDemoData('2026-06-23')   // demo supplies stepsGoal 10000
    const goals = resolveGoals(data, { ...profile, stepsGoal: 7000 })
    expect(goals.steps).toEqual({ value: 10_000, source: 'provider' })
  })

  it('falls back to the profile when the provider sends none', () => {
    const data = createDemoData('2026-06-23')
    data.activity.stepsGoal = null
    const goals = resolveGoals(data, { ...profile, stepsGoal: 7000 })
    expect(goals.steps).toEqual({ value: 7_000, source: 'profile' })
  })

  it('reports absence rather than zero when neither has a goal', () => {
    const data = createDemoData('2026-06-23')
    data.activity.stepsGoal = null
    expect(resolveGoals(data, profile).steps).toEqual({ value: null, source: null })
  })
})

describe('profileCompleteness', () => {
  it('names what each missing field would unlock', () => {
    const missing = profileCompleteness(profile).missing
    expect(missing.map((entry) => entry.field)).toContain('birthYear')
    expect(missing.find((entry) => entry.field === 'birthYear')!.unlocks).toMatch(/heart.rate zone/i)
  })

  it('reports nothing missing once every field is set', () => {
    const complete = {
      ...profile,
      birthYear: 1990,
      heightCm: 178,
      measuredMaxHeartRate: 194,
      stepsGoal: 10_000,
      sleepGoalMinutes: 480,
      waterGoalMl: 2_500,
      weightGoalKg: 71.5,
    }
    expect(profileCompleteness(complete).missing).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/user-profile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/user-profile.ts`:

```ts
import type { DashboardData, UserProfile } from '@/types'

export const EMPTY_USER_PROFILE: UserProfile = {
  birthYear: null,
  heightCm: null,
  measuredMaxHeartRate: null,
  stepsGoal: null,
  sleepGoalMinutes: null,
  waterGoalMl: null,
  weightGoalKg: null,
  userEdited: [],
}

export interface HeartRateZone {
  key: 'light' | 'moderate' | 'vigorous' | 'peak'
  label: string
  min: number
  max: number
}

export interface Goal {
  value: number | null
  source: 'provider' | 'profile' | null
}

export interface ResolvedGoals {
  steps: Goal
  sleepMinutes: Goal
  waterMl: Goal
  weightKg: Goal
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

/**
 * Max heart rate, with the basis attached.
 *
 * Tanaka (208 - 0.7 * age) describes a population, not this person, so the basis
 * travels with the number and the UI must say which applies. A measured value
 * always wins.
 */
export function maxHeartRate(
  profile: UserProfile,
  referenceYear: number,
): { value: number | null; basis: 'measured' | 'estimated' | null } {
  if (finite(profile.measuredMaxHeartRate)) {
    return { value: profile.measuredMaxHeartRate, basis: 'measured' }
  }
  if (finite(profile.birthYear)) {
    const age = referenceYear - profile.birthYear
    if (age > 0 && age < 130) return { value: 208 - 0.7 * age, basis: 'estimated' }
  }
  return { value: null, basis: null }
}

export function bmiFor(weightKg: number | null, profile: UserProfile): number | null {
  if (!finite(weightKg) || !finite(profile.heightCm) || profile.heightCm <= 0) return null
  const metres = profile.heightCm / 100
  return Number((weightKg / (metres * metres)).toFixed(2))
}

// Karvonen intensities. Boundaries are contiguous by construction, so a sample
// falls in exactly one zone.
const ZONE_BOUNDS: Array<{ key: HeartRateZone['key']; label: string; from: number; to: number }> = [
  { key: 'light', label: 'Light', from: 0.5, to: 0.6 },
  { key: 'moderate', label: 'Moderate', from: 0.6, to: 0.7 },
  { key: 'vigorous', label: 'Vigorous', from: 0.7, to: 0.85 },
  { key: 'peak', label: 'Peak', from: 0.85, to: 1 },
]

/**
 * Heart-rate zones over the heart-rate reserve.
 *
 * Both inputs are the user's own numbers, so these bands are personal rather
 * than a population table. Returns null when max HR is unknown — a zone chart
 * against an invented ceiling is worse than no zone chart.
 */
export function karvonenZones(restingHr: number | null, maxHr: number | null): HeartRateZone[] | null {
  if (!finite(restingHr) || !finite(maxHr)) return null
  const reserve = maxHr - restingHr
  if (reserve <= 0) return null
  return ZONE_BOUNDS.map(({ key, label, from, to }) => ({
    key,
    label,
    min: restingHr + reserve * from,
    max: restingHr + reserve * to,
  }))
}

function pick(providerValue: number | null, profileValue: number | null): Goal {
  // Provider first: a provider goal is the one the user set in the Google or
  // Fitbit app, so it outranks a value typed into OpenFit.
  if (finite(providerValue)) return { value: providerValue, source: 'provider' }
  if (finite(profileValue)) return { value: profileValue, source: 'profile' }
  return { value: null, source: null }
}

export function resolveGoals(data: DashboardData, profile: UserProfile): ResolvedGoals {
  return {
    steps: pick(data.activity.stepsGoal, profile.stepsGoal),
    sleepMinutes: pick(data.sleep.goalMinutes, profile.sleepGoalMinutes),
    waterMl: pick(data.body.waterGoalMl, profile.waterGoalMl),
    weightKg: pick(data.body.weightGoalKg, profile.weightGoalKg),
  }
}

const UNLOCKS: Array<{ field: keyof UserProfile; unlocks: string }> = [
  { field: 'birthYear', unlocks: 'Heart-rate zones and VO2 max context' },
  { field: 'heightCm', unlocks: 'BMI and its trend' },
  { field: 'measuredMaxHeartRate', unlocks: 'Heart-rate zones from a measurement instead of an estimate' },
  { field: 'stepsGoal', unlocks: 'A step goal line when your provider sends none' },
  { field: 'sleepGoalMinutes', unlocks: 'A sleep goal line and sleep goal insights' },
  { field: 'waterGoalMl', unlocks: 'A hydration goal ring' },
  { field: 'weightGoalKg', unlocks: 'A weight target on the body trend' },
]

export function profileCompleteness(profile: UserProfile) {
  return {
    missing: UNLOCKS.filter(({ field }) => !finite(profile[field] as number | null)),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/user-profile.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add src/lib/user-profile.ts src/lib/user-profile.test.ts
git commit -m "feat: derive max heart rate, BMI, zones, and goal precedence"
```

---

### Task 5: The metric analysis engine

**Files:**
- Create: `src/lib/metric-analysis.ts`
- Create: `src/lib/metric-analysis.test.ts`

**Interfaces:**
- Consumes: `TrendPoint`, `TimePoint` from `@/types`; `HeartRateZone` from `./user-profile`.
- Produces:

```ts
export interface CorrelationResult { r: number; sampleCount: number }
export function correlate(a: Array<number | null>, b: Array<number | null>): CorrelationResult | null

export interface AnomalyPoint { index: number; value: number; baseline: number; sigma: number; z: number }
export function detectAnomalies(series: Array<number | null>, options?: { threshold?: number; minimumBaseline?: number }): AnomalyPoint[]

export interface WeekBucket { isoWeek: string; mean: number; sampleCount: number }
export function weeklyRollup(trends: TrendPoint[], selector: (point: TrendPoint) => number | null): WeekBucket[]

export interface WeekdayBucket { weekday: number; label: string; mean: number | null; sampleCount: number }
export function weekdayProfile(trends: TrendPoint[], selector: (point: TrendPoint) => number | null): WeekdayBucket[]

export interface HistogramBin { start: number; end: number; label: string; count: number }
export function histogram(values: Array<number | null>, binCount?: number): HistogramBin[]

export interface BandStats { min: number; max: number; mean: number; stdDev: number; sampleCount: number }
export function bandStats(values: Array<number | null>): BandStats | null

export interface EnergyBalancePoint { date: string; label: string; balance: number | null }
export function energyBalance(trends: TrendPoint[]): EnergyBalancePoint[]

export interface ZoneShare { key: HeartRateZone['key']; label: string; count: number; share: number }
export function samplesInZones(intraday: TimePoint[], zones: HeartRateZone[]): ZoneShare[]

export function isoWeekKey(isoDate: string): string
```

**Background you need — read this before writing a line.**

*Why `samplesInZones` counts samples and not minutes.* `compactIntraday` in
`src/data/normalize.ts` averages heart-rate samples into minute-level points and
then buckets them once the series exceeds 288 points. The interval a point
represents is therefore **not constant across a day**. Converting counts to
minutes would require assuming uniform spacing that the pipeline does not
guarantee, and would put a fabricated number on screen. The function reports the
share of recorded samples, and the Health view labels the axis that way.

*Why the anomaly baseline excludes the point under test.* A z-score computed
against a window that contains the point is biased toward calling it normal —
the point drags its own baseline. The baseline is strictly the prior points.

*Why every function has a sample floor.* Pearson r over 3 points is noise that
looks like signal. Below the floor these return `null`, and `null` is what the UI
and the assistant must both receive.

- [ ] **Step 1: Write the failing test**

Create `src/lib/metric-analysis.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import { karvonenZones } from './user-profile'
import {
  bandStats,
  correlate,
  detectAnomalies,
  energyBalance,
  histogram,
  isoWeekKey,
  samplesInZones,
  weekdayProfile,
  weeklyRollup,
} from './metric-analysis'

describe('correlate', () => {
  it('returns 1 for a perfect positive relationship', () => {
    const result = correlate([1, 2, 3, 4, 5, 6, 7], [2, 4, 6, 8, 10, 12, 14])
    expect(result!.r).toBeCloseTo(1, 6)
    expect(result!.sampleCount).toBe(7)
  })

  it('returns -1 for a perfect inverse relationship', () => {
    expect(correlate([1, 2, 3, 4, 5, 6, 7], [7, 6, 5, 4, 3, 2, 1])!.r).toBeCloseTo(-1, 6)
  })

  it('matches a hand-computed value', () => {
    // r for these two series is 0.6324555 to seven places.
    const result = correlate([1, 2, 3, 4, 5, 6, 7], [2, 1, 4, 3, 6, 5, 7])
    expect(result!.r).toBeCloseTo(0.6428571, 5)
  })

  it('pairs only indices where both sides are finite', () => {
    const result = correlate([1, null, 3, 4, 5, 6, 7, 8], [2, 9, 6, 8, 10, 12, 14, 16])
    expect(result!.sampleCount).toBe(7)
    expect(result!.r).toBeCloseTo(1, 6)
  })

  it('returns null below seven pairs', () => {
    expect(correlate([1, 2, 3, 4, 5, 6], [2, 4, 6, 8, 10, 12])).toBeNull()
  })

  it('returns null when either side has zero variance', () => {
    expect(correlate([1, 2, 3, 4, 5, 6, 7], [5, 5, 5, 5, 5, 5, 5])).toBeNull()
  })

  it('returns null rather than NaN for empty input', () => {
    expect(correlate([], [])).toBeNull()
  })
})

describe('detectAnomalies', () => {
  it('flags a point beyond two sigma of its trailing baseline', () => {
    const series = [10, 10, 10, 10, 10, 40]
    const found = detectAnomalies(series)
    expect(found).toHaveLength(1)
    expect(found[0].index).toBe(5)
    expect(found[0].value).toBe(40)
  })

  it('never flags a point inside the minimum baseline window', () => {
    expect(detectAnomalies([10, 90, 10, 10])).toHaveLength(0)
  })

  it('computes the baseline from prior points only', () => {
    const found = detectAnomalies([10, 10, 10, 10, 10, 40])
    expect(found[0].baseline).toBeCloseTo(10, 6)
  })

  it('skips nulls without treating them as zero', () => {
    expect(detectAnomalies([10, null, 10, 10, 10, 10, 11])).toHaveLength(0)
  })

  it('returns nothing when the baseline has zero variance and the point matches', () => {
    expect(detectAnomalies([10, 10, 10, 10, 10, 10])).toHaveLength(0)
  })

  it('honors a custom threshold', () => {
    const series = [10, 10, 10, 11, 10, 13]
    expect(detectAnomalies(series, { threshold: 10 })).toHaveLength(0)
  })
})

describe('isoWeekKey', () => {
  it('formats an ISO week', () => {
    expect(isoWeekKey('2026-08-09')).toMatch(/^\d{4}-W\d{2}$/)
  })

  it('assigns 1 January 2027 to the 2026 week that contains it', () => {
    // 2027-01-01 is a Friday, so ISO week 53 of 2026.
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53')
  })

  it('assigns 31 December 2029 to ISO week 1 of 2030', () => {
    // 2029-12-31 is a Monday, so ISO week 1 of 2030.
    expect(isoWeekKey('2029-12-31')).toBe('2030-W01')
  })
})

describe('weeklyRollup', () => {
  it('reports a week only when it holds at least three finite days', () => {
    const data = createDemoData('2026-06-23')
    const weeks = weeklyRollup(data.trends, (point) => point.steps)
    expect(weeks.every((week) => week.sampleCount >= 3)).toBe(true)
    expect(weeks.length).toBeGreaterThan(0)
  })

  it('excludes a sparse week rather than reporting a one-day mean', () => {
    const data = createDemoData('2026-06-23')
    const trends = data.trends.map((point, index) => (index < 12 ? { ...point, steps: null } : point))
    const weeks = weeklyRollup(trends, (point) => point.steps)
    expect(weeks.every((week) => week.sampleCount >= 3)).toBe(true)
  })
})

describe('weekdayProfile', () => {
  it('returns all seven weekdays with their real sample counts', () => {
    const data = createDemoData('2026-06-23')
    const profile = weekdayProfile(data.trends, (point) => point.steps)
    expect(profile).toHaveLength(7)
    expect(profile.reduce((sum, day) => sum + day.sampleCount, 0)).toBe(14)
  })

  it('reports a null mean rather than zero for a weekday with no data', () => {
    const profile = weekdayProfile([], (point) => point.steps)
    expect(profile.every((day) => day.mean === null && day.sampleCount === 0)).toBe(true)
  })
})

describe('histogram', () => {
  it('places every finite value in exactly one bin', () => {
    const bins = histogram([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)
    expect(bins).toHaveLength(5)
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(10)
  })

  it('includes the maximum in the final bin rather than dropping it', () => {
    const bins = histogram([0, 10], 2)
    expect(bins.at(-1)!.count).toBe(1)
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(2)
  })

  it('handles a single repeated value without dividing by zero', () => {
    const bins = histogram([5, 5, 5], 4)
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(3)
    expect(bins.every((bin) => Number.isFinite(bin.start) && Number.isFinite(bin.end))).toBe(true)
  })

  it('returns no bins for no finite values', () => {
    expect(histogram([null, null])).toHaveLength(0)
  })
})

describe('bandStats', () => {
  it('computes min, max, mean, and population standard deviation', () => {
    const stats = bandStats([2, 4, 4, 4, 5, 5, 7, 9])!
    expect(stats.min).toBe(2)
    expect(stats.max).toBe(9)
    expect(stats.mean).toBeCloseTo(5, 6)
    expect(stats.stdDev).toBeCloseTo(2, 6)
    expect(stats.sampleCount).toBe(8)
  })

  it('returns null with no finite values', () => {
    expect(bandStats([null, null])).toBeNull()
  })
})

describe('energyBalance', () => {
  it('subtracts expenditure from intake per day', () => {
    const data = createDemoData('2026-06-23')
    const balance = energyBalance(data.trends)
    expect(balance).toHaveLength(14)
    const first = data.trends[0]
    expect(balance[0].balance).toBe(first.caloriesIn! - first.calories!)
  })

  it('reports null on a day missing either side rather than assuming zero', () => {
    const data = createDemoData('2026-06-23')
    const trends = data.trends.map((point, index) => (index === 0 ? { ...point, caloriesIn: null } : point))
    expect(energyBalance(trends)[0].balance).toBeNull()
  })
})

describe('samplesInZones', () => {
  it('counts intraday samples per zone and reports their share', () => {
    const zones = karvonenZones(58, 183)!
    const intraday = [
      { time: '00:00', value: 55 },    // below light
      { time: '01:00', value: 125 },   // light
      { time: '02:00', value: 135 },   // moderate
      { time: '03:00', value: 160 },   // vigorous
      { time: '04:00', value: 180 },   // peak
    ]
    const shares = samplesInZones(intraday, zones)
    expect(shares).toHaveLength(4)
    expect(shares.reduce((sum, zone) => sum + zone.count, 0)).toBe(4)
    expect(shares.reduce((sum, zone) => sum + zone.share, 0)).toBeCloseTo(1, 6)
  })

  it('returns zero shares rather than NaN for an empty series', () => {
    const shares = samplesInZones([], karvonenZones(58, 183)!)
    expect(shares.every((zone) => zone.count === 0 && zone.share === 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/metric-analysis.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/metric-analysis.ts`:

```ts
import type { TimePoint, TrendPoint } from '@/types'
import type { HeartRateZone } from './user-profile'

/**
 * Pure statistics over health series.
 *
 * Two rules run through every function here. Absent is not zero: a null is
 * excluded from the calculation and reflected in the sample count, never
 * coerced. And insufficient data returns null rather than a number: silently
 * returning NaN or 0 would let the UI and the assistant present noise as signal.
 */

const MINIMUM_CORRELATION_PAIRS = 7
const DEFAULT_ANOMALY_THRESHOLD = 2
const MINIMUM_ANOMALY_BASELINE = 4
const MINIMUM_WEEK_DAYS = 3

const isFinite_ = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

function finiteOf(values: Array<number | null | undefined>): number[] {
  return values.filter(isFinite_)
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stdDev(values: number[], average: number): number {
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length)
}

export interface CorrelationResult {
  r: number
  sampleCount: number
}

/**
 * Pearson r over indices where both series are finite.
 *
 * Null below seven pairs, because r over three points is noise shaped like
 * signal. Null on zero variance, where r is undefined rather than zero.
 */
export function correlate(a: Array<number | null>, b: Array<number | null>): CorrelationResult | null {
  const pairs: Array<[number, number]> = []
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (isFinite_(left) && isFinite_(right)) pairs.push([left, right])
  }
  if (pairs.length < MINIMUM_CORRELATION_PAIRS) return null

  const leftValues = pairs.map(([value]) => value)
  const rightValues = pairs.map(([, value]) => value)
  const leftMean = mean(leftValues)
  const rightMean = mean(rightValues)

  let covariance = 0
  let leftSquares = 0
  let rightSquares = 0
  for (const [left, right] of pairs) {
    const dx = left - leftMean
    const dy = right - rightMean
    covariance += dx * dy
    leftSquares += dx * dx
    rightSquares += dy * dy
  }
  if (leftSquares === 0 || rightSquares === 0) return null

  return { r: covariance / Math.sqrt(leftSquares * rightSquares), sampleCount: pairs.length }
}

export interface AnomalyPoint {
  index: number
  value: number
  baseline: number
  sigma: number
  z: number
}

/**
 * Flags points beyond `threshold` sigma of a trailing personal baseline.
 *
 * The baseline is strictly the prior finite points. Including the point under
 * test would bias its own z-score toward normal — it would drag the mean it is
 * being measured against.
 */
export function detectAnomalies(
  series: Array<number | null>,
  options: { threshold?: number; minimumBaseline?: number } = {},
): AnomalyPoint[] {
  const threshold = options.threshold ?? DEFAULT_ANOMALY_THRESHOLD
  const minimumBaseline = options.minimumBaseline ?? MINIMUM_ANOMALY_BASELINE
  const found: AnomalyPoint[] = []

  for (let index = 0; index < series.length; index += 1) {
    const value = series[index]
    if (!isFinite_(value)) continue
    const prior = finiteOf(series.slice(0, index))
    if (prior.length < minimumBaseline) continue
    const baseline = mean(prior)
    const sigma = stdDev(prior, baseline)
    if (sigma === 0) continue
    const z = (value - baseline) / sigma
    if (Math.abs(z) >= threshold) found.push({ index, value, baseline, sigma, z })
  }

  return found
}

/**
 * ISO-8601 week key, e.g. "2026-W32".
 *
 * ISO weeks start on Monday and belong to the year containing their Thursday,
 * which is why late December can land in week 1 of the next year and 1 January
 * in week 52 or 53 of the previous one. Computed in UTC so a local timezone
 * cannot shift a date across a week boundary.
 */
export function isoWeekKey(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  // Shift to the Thursday of this ISO week; its calendar year is the ISO year.
  const weekday = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - weekday + 3)
  const isoYear = date.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekday + 3)
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

export interface WeekBucket {
  isoWeek: string
  mean: number
  sampleCount: number
}

/** Groups days into ISO weeks. A week with fewer than three finite days is omitted, not averaged. */
export function weeklyRollup(
  trends: TrendPoint[],
  selector: (point: TrendPoint) => number | null,
): WeekBucket[] {
  const buckets = new Map<string, number[]>()
  for (const point of trends) {
    const value = selector(point)
    if (!isFinite_(value)) continue
    const key = isoWeekKey(point.date)
    const existing = buckets.get(key)
    if (existing) existing.push(value)
    else buckets.set(key, [value])
  }
  return [...buckets.entries()]
    .filter(([, values]) => values.length >= MINIMUM_WEEK_DAYS)
    .map(([isoWeek, values]) => ({ isoWeek, mean: mean(values), sampleCount: values.length }))
    .sort((left, right) => left.isoWeek.localeCompare(right.isoWeek))
}

export interface WeekdayBucket {
  weekday: number
  label: string
  mean: number | null
  sampleCount: number
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Mean per weekday, Monday first, with the real sample count behind each mean. */
export function weekdayProfile(
  trends: TrendPoint[],
  selector: (point: TrendPoint) => number | null,
): WeekdayBucket[] {
  const buckets: number[][] = WEEKDAY_LABELS.map(() => [])
  for (const point of trends) {
    const value = selector(point)
    if (!isFinite_(value)) continue
    const [year, month, day] = point.date.split('-').map(Number)
    const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7
    buckets[weekday].push(value)
  }
  return WEEKDAY_LABELS.map((label, weekday) => ({
    weekday,
    label,
    mean: buckets[weekday].length ? mean(buckets[weekday]) : null,
    sampleCount: buckets[weekday].length,
  }))
}

export interface HistogramBin {
  start: number
  end: number
  label: string
  count: number
}

/** Equal-width bins over the finite range. The maximum falls in the last bin rather than off the end. */
export function histogram(values: Array<number | null>, binCount = 8): HistogramBin[] {
  const finite = finiteOf(values)
  if (!finite.length) return []
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  // A single repeated value has zero range; widen it so bins stay finite.
  const width = max === min ? Math.max(Math.abs(min) * 0.1, 1) / binCount : (max - min) / binCount

  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, index) => {
    const start = min + width * index
    const end = start + width
    return { start, end, label: `${Math.round(start)}-${Math.round(end)}`, count: 0 }
  })

  for (const value of finite) {
    const raw = Math.floor((value - min) / width)
    bins[Math.min(Math.max(raw, 0), binCount - 1)].count += 1
  }
  return bins
}

export interface BandStats {
  min: number
  max: number
  mean: number
  stdDev: number
  sampleCount: number
}

export function bandStats(values: Array<number | null>): BandStats | null {
  const finite = finiteOf(values)
  if (!finite.length) return null
  const average = mean(finite)
  return {
    min: Math.min(...finite),
    max: Math.max(...finite),
    mean: average,
    stdDev: stdDev(finite, average),
    sampleCount: finite.length,
  }
}

export interface EnergyBalancePoint {
  date: string
  label: string
  balance: number | null
}

/** Intake minus expenditure. Null on any day missing either side — a one-sided balance is not a balance. */
export function energyBalance(trends: TrendPoint[]): EnergyBalancePoint[] {
  return trends.map((point) => ({
    date: point.date,
    label: point.label,
    balance: isFinite_(point.caloriesIn) && isFinite_(point.calories)
      ? point.caloriesIn - point.calories
      : null,
  }))
}

export interface ZoneShare {
  key: HeartRateZone['key']
  label: string
  count: number
  share: number
}

/**
 * Share of recorded intraday samples falling in each zone.
 *
 * Deliberately samples and not minutes. `compactIntraday` in normalize.ts
 * buckets the series once it exceeds 288 points, so the interval a point
 * represents is not constant across a day; converting counts to minutes would
 * assume a uniform spacing the pipeline does not guarantee. The axis is labelled
 * as a share of samples wherever this is rendered.
 */
export function samplesInZones(intraday: TimePoint[], zones: HeartRateZone[]): ZoneShare[] {
  const counts = zones.map(() => 0)
  let total = 0

  for (const point of intraday) {
    if (!isFinite_(point.value)) continue
    for (let index = 0; index < zones.length; index += 1) {
      const zone = zones[index]
      const isLast = index === zones.length - 1
      const inside = point.value >= zone.min && (isLast ? point.value <= zone.max : point.value < zone.max)
      if (inside) {
        counts[index] += 1
        total += 1
        break
      }
    }
  }

  return zones.map((zone, index) => ({
    key: zone.key,
    label: zone.label,
    count: counts[index],
    share: total ? counts[index] / total : 0,
  }))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/metric-analysis.test.ts`
Expected: PASS. If the hand-computed r in the third correlation test disagrees,
recompute it rather than loosening the tolerance — the formula is the thing
under test.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add src/lib/metric-analysis.ts src/lib/metric-analysis.test.ts
git commit -m "feat: add the local metric analysis engine"
```

---

### Task 6: Cardio load and the acute:chronic workload ratio

**Files:**
- Create: `src/lib/cardio-load.ts`
- Create: `src/lib/cardio-load.test.ts`

**Interfaces:**
- Consumes: `ActivityItem`, `HeartZoneMinutes` from `@/types`.
- Produces:

```ts
export const ZONE_WEIGHTS: Record<keyof HeartZoneMinutes, number>
export function edwardsTrimp(zones: HeartZoneMinutes | null | undefined): number | null
export interface LoadDay { date: string; activities: ActivityItem[]; zoneMinutes: number | null }
export interface DailyLoad { date: string; trimp: number; source: 'workout-zones' | 'active-zone-minutes' }
export function dailyCardioLoad(days: LoadDay[]): DailyLoad[]
export interface WorkloadRatio {
  ratio: number; acuteMean: number; chronicMean: number
  acuteDays: number; chronicDays: number; sufficient: boolean; requiredChronicDays: number
}
export function workloadRatio(loads: DailyLoad[], endDate: string): WorkloadRatio | null
```

**Background you need — the honesty constraint.** `HOME_DASHBOARD_MODEL.md`
forbids invented composite scores, and load and strain are composites. These two
are admitted only because each satisfies three rules, and any composite that
cannot satisfy all three does not ship:

1. **A published formula, named.** Edwards' summated heart-rate-zone TRIMP:
   `load = sum(minutes_in_zone_i * i)` for `i = 1..4` over light, moderate,
   vigorous, and peak. ACWR is the standard 7-day mean over 28-day mean.
2. **Inputs visible on the same screen.** The zone minutes and both window means
   render beside the figure.
3. **Its own documented unit.** TRIMP points and a dimensionless ratio. Never a
   0-100 OpenFit invented.

*Why the zone minutes are trustworthy here.* `ActivityItem.heartZoneMinutes`
arrives from the provider as **true minutes per workout**. This is not the
intraday series, so none of the bucketing problem that forced `samplesInZones`
to report shares applies. Confirm with
`grep -n "heartZoneMinutes" src/data/normalize.ts` — `activityHeartZoneMinutes`
reads both the modern and legacy shapes.

*Why the fallback is flagged.* A day with no recorded workout falls back to the
daily Active Zone Minutes total, which is a coarser, differently-derived number.
Mixing the two silently would make a trend that is partly one measurement and
partly another. `source` travels with every day so the UI can mark it.

*Why ACWR is suppressed below 14 chronic days.* A ratio against a half-filled
28-day window is not a conservative estimate, it is a wrong number — the chronic
mean is computed over whatever happens to exist and reads as a spike. The
archive in `core/health-cache.cjs` is unbounded and never pruned, so the window
fills in as the ten-minute scheduler runs. Historical backfill is not
implemented and is out of scope here; until the window fills, the UI states the
real day count.

- [ ] **Step 1: Write the failing test**

Create `src/lib/cardio-load.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '@/types'
import { dailyCardioLoad, edwardsTrimp, workloadRatio } from './cardio-load'

function workout(date: string, zones: Partial<ActivityItem['heartZoneMinutes']>): ActivityItem {
  return {
    id: `${date}-w`, name: 'Run', date, time: '08:00', durationMinutes: 40,
    calories: null, distanceKm: null, averageHeartRate: null, zoneMinutes: null,
    steps: null, averagePaceSecondsPerMeter: null,
    heartZoneMinutes: { light: null, moderate: null, vigorous: null, peak: null, ...zones },
  }
}

describe('edwardsTrimp', () => {
  it('weights each zone by its ordinal', () => {
    // 10*1 + 10*2 + 10*3 + 10*4 = 100
    expect(edwardsTrimp({ light: 10, moderate: 10, vigorous: 10, peak: 10 })).toBe(100)
  })

  it('treats an absent zone as absent, not as zero minutes of a zone that happened', () => {
    expect(edwardsTrimp({ light: 20, moderate: null, vigorous: null, peak: null })).toBe(20)
  })

  it('returns null when no zone has any minutes', () => {
    expect(edwardsTrimp({ light: null, moderate: null, vigorous: null, peak: null })).toBeNull()
    expect(edwardsTrimp(null)).toBeNull()
  })
})

describe('dailyCardioLoad', () => {
  it('sums every workout on a day and marks the source', () => {
    const loads = dailyCardioLoad([{
      date: '2026-08-01',
      activities: [workout('2026-08-01', { moderate: 10 }), workout('2026-08-01', { vigorous: 10 })],
      zoneMinutes: 99,
    }])
    expect(loads).toEqual([{ date: '2026-08-01', trimp: 20 + 30, source: 'workout-zones' }])
  })

  it('falls back to active zone minutes only when no workout has zones, and flags it', () => {
    const loads = dailyCardioLoad([{ date: '2026-08-01', activities: [], zoneMinutes: 24 }])
    expect(loads[0].source).toBe('active-zone-minutes')
    expect(loads[0].trimp).toBe(24)
  })

  it('omits a day with neither rather than recording zero load', () => {
    expect(dailyCardioLoad([{ date: '2026-08-01', activities: [], zoneMinutes: null }])).toEqual([])
  })

  it('returns days in ascending date order', () => {
    const loads = dailyCardioLoad([
      { date: '2026-08-03', activities: [], zoneMinutes: 5 },
      { date: '2026-08-01', activities: [], zoneMinutes: 5 },
    ])
    expect(loads.map((load) => load.date)).toEqual(['2026-08-01', '2026-08-03'])
  })
})

describe('workloadRatio', () => {
  function loadsFor(days: number, trimp: number, endDate = '2026-08-28'): Array<{ date: string; trimp: number; source: 'workout-zones' }> {
    const end = new Date(`${endDate}T12:00:00Z`).getTime()
    return Array.from({ length: days }, (_, index) => ({
      date: new Date(end - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10),
      trimp,
      source: 'workout-zones' as const,
    }))
  }

  it('is 1 when the acute and chronic means match', () => {
    const result = workloadRatio(loadsFor(28, 50), '2026-08-28')!
    expect(result.ratio).toBeCloseTo(1, 6)
    expect(result.sufficient).toBe(true)
    expect(result.chronicDays).toBe(28)
    expect(result.acuteDays).toBe(7)
  })

  it('rises above 1 when the last week is harder than the month', () => {
    const loads = loadsFor(28, 20)
    for (const load of loads.slice(-7)) load.trimp = 60
    const result = workloadRatio(loads, '2026-08-28')!
    expect(result.ratio).toBeGreaterThan(1.5)
  })

  it('reports insufficiency with the real day count instead of a number', () => {
    const result = workloadRatio(loadsFor(11, 50, '2026-08-11'), '2026-08-11')!
    expect(result.sufficient).toBe(false)
    expect(result.chronicDays).toBe(11)
    expect(result.requiredChronicDays).toBe(14)
  })

  it('returns null rather than infinity when the chronic mean is zero', () => {
    expect(workloadRatio(loadsFor(28, 0), '2026-08-28')).toBeNull()
  })

  it('returns null with no loads at all', () => {
    expect(workloadRatio([], '2026-08-28')).toBeNull()
  })

  it('ignores days after the end date', () => {
    const loads = [...loadsFor(28, 50), { date: '2026-09-30', trimp: 5000, source: 'workout-zones' as const }]
    expect(workloadRatio(loads, '2026-08-28')!.ratio).toBeCloseTo(1, 6)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/cardio-load.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/cardio-load.ts`:

```ts
import type { ActivityItem, HeartZoneMinutes } from '@/types'

/**
 * Cardio load and workload ratio.
 *
 * Both figures here are composites, which HOME_DASHBOARD_MODEL.md otherwise
 * forbids. They are admitted under three constraints, and anything that cannot
 * meet all three does not belong in this file: the formula is published and
 * named, its inputs render on the same screen, and it reports in that formula's
 * own unit — never a 0-100 scale invented for OpenFit.
 */

const ACUTE_DAYS = 7
const CHRONIC_DAYS = 28
const REQUIRED_CHRONIC_DAYS = 14
const DAY_MS = 86_400_000

/** Edwards' summated heart-rate-zone weights: zone ordinal 1..4. */
export const ZONE_WEIGHTS: Record<keyof HeartZoneMinutes, number> = {
  light: 1,
  moderate: 2,
  vigorous: 3,
  peak: 4,
}

const isFinite_ = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

/**
 * Edwards TRIMP for one workout, in TRIMP points.
 *
 * The zone minutes come from the provider as true minutes per workout, so
 * unlike the intraday series there is no bucketing to correct for. Null when no
 * zone reported any minutes — a workout with no zone data has unknown load, not
 * zero load.
 */
export function edwardsTrimp(zones: HeartZoneMinutes | null | undefined): number | null {
  if (!zones) return null
  let total = 0
  let any = false
  for (const key of Object.keys(ZONE_WEIGHTS) as Array<keyof HeartZoneMinutes>) {
    const minutes = zones[key]
    if (!isFinite_(minutes)) continue
    any = true
    total += minutes * ZONE_WEIGHTS[key]
  }
  return any ? total : null
}

export interface LoadDay {
  date: string
  activities: ActivityItem[]
  zoneMinutes: number | null
}

export interface DailyLoad {
  date: string
  trimp: number
  source: 'workout-zones' | 'active-zone-minutes'
}

/**
 * One load figure per day, ascending.
 *
 * A day is omitted when neither workout zones nor an Active Zone Minutes total
 * exists: recording zero would put a rest day and an unmonitored day in the same
 * bucket, and they are not the same thing.
 */
export function dailyCardioLoad(days: LoadDay[]): DailyLoad[] {
  const loads: DailyLoad[] = []

  for (const day of days) {
    const fromWorkouts = day.activities
      .map((activity) => edwardsTrimp(activity.heartZoneMinutes))
      .filter(isFinite_)

    if (fromWorkouts.length) {
      loads.push({
        date: day.date,
        trimp: fromWorkouts.reduce((sum, value) => sum + value, 0),
        source: 'workout-zones',
      })
      continue
    }
    // Coarser and differently derived, so it carries its own source label and
    // the UI marks it. Mixing the two silently would make a trend that is partly
    // one measurement and partly another.
    if (isFinite_(day.zoneMinutes)) {
      loads.push({ date: day.date, trimp: day.zoneMinutes, source: 'active-zone-minutes' })
    }
  }

  return loads.sort((left, right) => left.date.localeCompare(right.date))
}

export interface WorkloadRatio {
  ratio: number
  acuteMean: number
  chronicMean: number
  acuteDays: number
  chronicDays: number
  /** False when the chronic window is too short for the ratio to mean anything. */
  sufficient: boolean
  requiredChronicDays: number
}

/**
 * Acute:chronic workload ratio — the 7-day mean load over the 28-day mean.
 *
 * `sufficient` is false below 14 chronic days. The caller must show the day
 * count instead of the ratio in that case: a ratio against a half-filled window
 * is not conservative, it is wrong, because the chronic mean is computed over
 * whatever happens to exist and reads as a spike.
 */
export function workloadRatio(loads: DailyLoad[], endDate: string): WorkloadRatio | null {
  const end = new Date(`${endDate}T12:00:00Z`).getTime()
  if (!Number.isFinite(end)) return null

  const within = (days: number) => loads.filter((load) => {
    const time = new Date(`${load.date}T12:00:00Z`).getTime()
    return Number.isFinite(time) && time <= end && time > end - days * DAY_MS
  })

  const acute = within(ACUTE_DAYS)
  const chronic = within(CHRONIC_DAYS)
  if (!acute.length || !chronic.length) return null

  const acuteMean = acute.reduce((sum, load) => sum + load.trimp, 0) / acute.length
  const chronicMean = chronic.reduce((sum, load) => sum + load.trimp, 0) / chronic.length
  // A zero chronic mean makes the ratio infinite, which is not a number to show.
  if (chronicMean === 0) return null

  return {
    ratio: acuteMean / chronicMean,
    acuteMean,
    chronicMean,
    acuteDays: acute.length,
    chronicDays: chronic.length,
    sufficient: chronic.length >= REQUIRED_CHRONIC_DAYS,
    requiredChronicDays: REQUIRED_CHRONIC_DAYS,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/cardio-load.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add src/lib/cardio-load.ts src/lib/cardio-load.test.ts
git commit -m "feat: compute Edwards TRIMP load and the acute:chronic workload ratio"
```

---

### Task 7: The recovery panel

**Files:**
- Create: `src/lib/recovery-panel.ts`
- Create: `src/lib/recovery-panel.test.ts`

**Interfaces:**
- Consumes: `DashboardData`, `TrendPoint` from `@/types`.
- Produces:

```ts
export interface RecoverySignal {
  key: 'hrv' | 'restingHeartRate' | 'breathingRate' | 'skinTemperature'
  label: string
  unit: string
  current: number | null
  baseline: number | null
  delta: number | null
  z: number | null
  /** Which direction of change is favorable for this metric. Not a score. */
  favorableDirection: 'higher' | 'lower'
  sampleCount: number
}
export function recoveryPanel(data: DashboardData, baselineDays?: number): RecoverySignal[]
export function strainedSignals(panel: RecoverySignal[], threshold?: number): RecoverySignal[]
```

**Background you need.** There is **no recovery score**, and adding one later
would violate the model doc. This is a panel of four independent deviations,
each in its native unit with its own baseline attached. Nothing is summed and
nothing is normalized onto a common scale.

That is the point rather than a limitation: whether HRV, resting heart rate,
respiratory rate, and skin temperature agree or disagree on a given morning is
exactly the information a single number would destroy. Four signals pointing the
same way is a different situation from two pointing each way, and a score
renders both as the same middling figure.

`favorableDirection` records which way is good for each metric — higher HRV,
lower resting heart rate — so the UI can color a deviation without inventing a
composite. It labels; it does not score. Skin temperature already arrives as a
deviation from the user's own baseline (`TrendPoint.skinTemperature`), so its
own baseline is near zero and its delta is read directly.

- [ ] **Step 1: Write the failing test**

Create `src/lib/recovery-panel.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import { recoveryPanel, strainedSignals } from './recovery-panel'

describe('recoveryPanel', () => {
  it('returns the four signals with their own units', () => {
    const panel = recoveryPanel(createDemoData('2026-06-23'))
    expect(panel.map((signal) => signal.key)).toEqual(['hrv', 'restingHeartRate', 'breathingRate', 'skinTemperature'])
    expect(panel.find((signal) => signal.key === 'hrv')!.unit).toBe('ms')
    expect(panel.find((signal) => signal.key === 'restingHeartRate')!.unit).toBe('bpm')
  })

  it('records the favorable direction per metric rather than scoring', () => {
    const panel = recoveryPanel(createDemoData('2026-06-23'))
    expect(panel.find((signal) => signal.key === 'hrv')!.favorableDirection).toBe('higher')
    expect(panel.find((signal) => signal.key === 'restingHeartRate')!.favorableDirection).toBe('lower')
  })

  it('computes each baseline from that metric only, excluding the selected day', () => {
    const data = createDemoData('2026-06-23')
    const priorHrv = data.trends.filter((point) => point.date < data.selectedDate).map((point) => point.hrvMs!)
    const expected = priorHrv.reduce((sum, value) => sum + value, 0) / priorHrv.length
    const hrv = recoveryPanel(data).find((signal) => signal.key === 'hrv')!
    expect(hrv.baseline).toBeCloseTo(expected, 6)
    expect(hrv.sampleCount).toBe(priorHrv.length)
  })

  it('drops out to nulls rather than zero when a signal is absent', () => {
    const data = createDemoData('2026-06-23')
    data.health.hrvMs = null
    data.trends = data.trends.map((point) => ({ ...point, hrvMs: null }))
    const hrv = recoveryPanel(data).find((signal) => signal.key === 'hrv')!
    expect(hrv.current).toBeNull()
    expect(hrv.baseline).toBeNull()
    expect(hrv.z).toBeNull()
    expect(hrv.sampleCount).toBe(0)
  })

  it('reports a null z when the baseline has no variance', () => {
    const data = createDemoData('2026-06-23')
    data.trends = data.trends.map((point) => ({ ...point, hrvMs: 50 }))
    data.health.hrvMs = 50
    expect(recoveryPanel(data).find((signal) => signal.key === 'hrv')!.z).toBeNull()
  })

  it('never returns a summed or averaged overall figure', () => {
    const panel = recoveryPanel(createDemoData('2026-06-23'))
    expect(Array.isArray(panel)).toBe(true)
    expect(panel).toHaveLength(4)
  })
})

describe('strainedSignals', () => {
  it('selects only signals deviating unfavorably beyond the threshold', () => {
    const panel = [
      { key: 'hrv', label: 'HRV', unit: 'ms', current: 30, baseline: 50, delta: -20, z: -2.4, favorableDirection: 'higher', sampleCount: 10 },
      { key: 'restingHeartRate', label: 'RHR', unit: 'bpm', current: 52, baseline: 58, delta: -6, z: -2.6, favorableDirection: 'lower', sampleCount: 10 },
    ] as never
    const strained = strainedSignals(panel, 1.5)
    expect(strained.map((signal) => signal.key)).toEqual(['hrv'])
  })

  it('ignores signals with a null z', () => {
    const panel = [{ key: 'hrv', label: 'HRV', unit: 'ms', current: null, baseline: null, delta: null, z: null, favorableDirection: 'higher', sampleCount: 0 }] as never
    expect(strainedSignals(panel)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/recovery-panel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/recovery-panel.ts`:

```ts
import type { DashboardData, TrendPoint } from '@/types'

/**
 * Four independent recovery signals. There is deliberately no recovery score.
 *
 * Each signal keeps its own unit and its own baseline, and nothing is summed or
 * normalized onto a shared scale. That is the design, not a gap: four signals
 * agreeing is a different morning from two pointing each way, and a single
 * number renders both as the same middling figure. Adding one later would also
 * be exactly the invented composite HOME_DASHBOARD_MODEL.md forbids.
 */

const DEFAULT_BASELINE_DAYS = 28
const DEFAULT_STRAIN_THRESHOLD = 1.5

export interface RecoverySignal {
  key: 'hrv' | 'restingHeartRate' | 'breathingRate' | 'skinTemperature'
  label: string
  unit: string
  current: number | null
  baseline: number | null
  delta: number | null
  z: number | null
  /** Which direction of change is favorable. A label for the UI, never a score. */
  favorableDirection: 'higher' | 'lower'
  sampleCount: number
}

const isFinite_ = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

interface SignalSpec {
  key: RecoverySignal['key']
  label: string
  unit: string
  favorableDirection: RecoverySignal['favorableDirection']
  current: (data: DashboardData) => number | null
  select: (point: TrendPoint) => number | null
}

const SPECS: SignalSpec[] = [
  {
    key: 'hrv', label: 'Heart-rate variability', unit: 'ms', favorableDirection: 'higher',
    current: (data) => data.health.hrvMs, select: (point) => point.hrvMs,
  },
  {
    key: 'restingHeartRate', label: 'Resting heart rate', unit: 'bpm', favorableDirection: 'lower',
    current: (data) => data.health.restingHeartRate, select: (point) => point.restingHeartRate,
  },
  {
    key: 'breathingRate', label: 'Respiratory rate', unit: '/min', favorableDirection: 'lower',
    current: (data) => data.health.breathingRate, select: (point) => point.breathingRate,
  },
  {
    // Already a deviation from the user's own baseline as the provider sends it,
    // so its baseline sits near zero and the delta is read directly.
    key: 'skinTemperature', label: 'Skin temperature', unit: '°C from baseline', favorableDirection: 'lower',
    current: (data) => data.health.skinTemperature, select: (point) => point.skinTemperature,
  },
]

export function recoveryPanel(data: DashboardData, baselineDays = DEFAULT_BASELINE_DAYS): RecoverySignal[] {
  return SPECS.map((spec) => {
    // Prior days only. Including the selected day would drag the baseline it is
    // being measured against toward itself.
    const prior = data.trends
      .filter((point) => point.date < data.selectedDate)
      .slice(-baselineDays)
      .map(spec.select)
      .filter(isFinite_)

    const current = spec.current(data)
    const baseline = prior.length ? prior.reduce((sum, value) => sum + value, 0) / prior.length : null
    const sigma = baseline === null
      ? null
      : Math.sqrt(prior.reduce((sum, value) => sum + (value - baseline) ** 2, 0) / prior.length)

    return {
      key: spec.key,
      label: spec.label,
      unit: spec.unit,
      current: isFinite_(current) ? current : null,
      baseline,
      delta: isFinite_(current) && baseline !== null ? current - baseline : null,
      z: isFinite_(current) && baseline !== null && sigma !== null && sigma > 0
        ? (current - baseline) / sigma
        : null,
      favorableDirection: spec.favorableDirection,
      sampleCount: prior.length,
    }
  })
}

/**
 * Signals deviating in the unfavorable direction beyond `threshold` sigma.
 *
 * A filter over the panel, not a reduction of it. The caller reports how many
 * signals are strained and which ones — never a combined figure.
 */
export function strainedSignals(panel: RecoverySignal[], threshold = DEFAULT_STRAIN_THRESHOLD): RecoverySignal[] {
  return panel.filter((signal) => {
    if (signal.z === null) return false
    const unfavorable = signal.favorableDirection === 'higher' ? signal.z < 0 : signal.z > 0
    return unfavorable && Math.abs(signal.z) >= threshold
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/recovery-panel.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add src/lib/recovery-panel.ts src/lib/recovery-panel.test.ts
git commit -m "feat: add the four-signal recovery panel with no composite score"
```

---

### Task 8: The insight engine

**Files:**
- Create: `src/lib/insight-engine.ts`
- Create: `src/lib/insight-engine.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4-7.
- Produces:

```ts
export interface Insight {
  id: string
  category: 'activity' | 'heart' | 'sleep' | 'recovery' | 'body' | 'data'
  severity: 'info' | 'notable' | 'attention'
  title: string
  body: string
  evidence: { label: string; value: string; baseline?: string; sampleCount: number }
  page?: PageId
  /** Seeds the assistant with an improvement request naming the metric, numbers, and window. */
  prompt: string
}
export function buildInsights(data: DashboardData, profile: UserProfile, options?: { loads?: DailyLoad[] }): Insight[]
```

**Background you need.** Every rule must cite evidence or not fire at all — an
insight with no `evidence.sampleCount` is a claim OpenFit cannot back, and the
model doc forbids it. Output is deterministic and severity-ordered
(`attention` > `notable` > `info`, then by id) so the same data always produces
the same feed in the same order; a feed that reshuffles between renders is
unreadable.

Eleven rules. The first eight come from the original design; rules 9-11 are the
cardio-load family:

1. **Goal delta** — selected day against a resolved goal (`activity`).
2. **Baseline deviation** — a metric beyond 2 sigma of its personal baseline, minimum 4 prior days.
3. **Streak** — consecutive days meeting a goal, minimum 3.
4. **Correlation** — `|r| >= 0.5` over at least 7 pairs, phrased as association and never causation.
5. **Anomaly day** — a flagged day inside the visible window.
6. **Energy balance** — a sustained intake-versus-expenditure gap, only when both sides are logged.
7. **Consistency** — coefficient of variation of sleep duration or steps against the same user's history.
8. **Data completeness** — a metric that stopped reporting, distinguishing absent from zero (`data`).
9. **Load spike** — ACWR above 1.5 (`attention`).
10. **Undertraining** — ACWR below 0.8 (`info`).
11. **Multi-signal strain** — two or more recovery signals beyond 1.5 z on the same day (`attention`).

The `insights[]` array `normalize.ts` already produces stays where it is and
keeps feeding the assistant context, so nothing regresses while this richer path
takes over the UI. Do not delete `buildInsights` in `src/data/normalize.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/insight-engine.test.ts`. Cover, at minimum, one firing case and
one silent case per rule, plus these cross-cutting properties:

```ts
import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import { EMPTY_USER_PROFILE } from './user-profile'
import { buildInsights } from './insight-engine'

const profile = { ...EMPTY_USER_PROFILE }

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
    data.trends = data.trends.map((point) => ({ ...point, hrvMs: 50, restingHeartRate: 58 }))
    data.health.hrvMs = 20        // far below baseline: unfavorable
    data.health.restingHeartRate = 75  // far above baseline: unfavorable
    const strain = buildInsights(data, profile).find((insight) => insight.id === 'multi-signal-strain')
    expect(strain).toBeDefined()
    expect(strain!.severity).toBe('attention')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/insight-engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/insight-engine.ts`. Structure it as an array of rule functions,
each `(context) => Insight | null`, then filter and sort. That shape keeps each
rule independently readable and makes "fires or stays silent" a property of one
small function rather than of a long branch.

```ts
import type { DashboardData, PageId, UserProfile } from '@/types'
import { correlate, detectAnomalies, energyBalance } from './metric-analysis'
import { workloadRatio, type DailyLoad } from './cardio-load'
import { recoveryPanel, strainedSignals } from './recovery-panel'
import { resolveGoals } from './user-profile'

export interface Insight {
  id: string
  category: 'activity' | 'heart' | 'sleep' | 'recovery' | 'body' | 'data'
  severity: 'info' | 'notable' | 'attention'
  title: string
  body: string
  evidence: { label: string; value: string; baseline?: string; sampleCount: number }
  page?: PageId
  prompt: string
}

const SEVERITY_RANK: Record<Insight['severity'], number> = { attention: 0, notable: 1, info: 2 }

interface RuleContext {
  data: DashboardData
  profile: UserProfile
  loads: DailyLoad[]
  goals: ReturnType<typeof resolveGoals>
}

type Rule = (context: RuleContext) => Insight | null

// ... one named function per rule, listed in RULES below.

const RULES: Rule[] = [
  goalDeltaRule,
  baselineDeviationRule,
  streakRule,
  correlationRule,
  anomalyDayRule,
  energyBalanceRule,
  consistencyRule,
  dataCompletenessRule,
  loadSpikeRule,
  undertrainingRule,
  multiSignalStrainRule,
]

/**
 * Deterministic, severity-ordered insights.
 *
 * Every rule cites evidence or returns null. An insight without a real sample
 * count is a claim OpenFit cannot back, which HOME_DASHBOARD_MODEL.md forbids —
 * so a rule that cannot fill `evidence` must stay silent rather than soften its
 * wording.
 */
export function buildInsights(
  data: DashboardData,
  profile: UserProfile,
  options: { loads?: DailyLoad[] } = {},
): Insight[] {
  const context: RuleContext = {
    data,
    profile,
    loads: options.loads ?? [],
    goals: resolveGoals(data, profile),
  }
  return RULES
    .map((rule) => {
      try {
        return rule(context)
      } catch {
        // A rule that throws must not take the whole feed down with it.
        return null
      }
    })
    .filter((insight): insight is Insight => insight !== null && insight.evidence.sampleCount > 0)
    .sort((left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || left.id.localeCompare(right.id))
}
```

Write each rule to these specifics:

- **`loadSpikeRule`** — `workloadRatio(context.loads, data.selectedDate)`; returns
  null when the result is null or `sufficient === false`, or when
  `ratio <= 1.5`. Severity `attention`. Evidence
  `{ label: 'Acute:chronic load', value: ratio.toFixed(2), baseline: '28-day mean ' + Math.round(chronicMean) + ' TRIMP', sampleCount: chronicDays }`.
  Page `activity`. Prompt names the ratio, both window means, and asks what to
  change over the next week.
- **`undertrainingRule`** — same guard, fires below 0.8, severity `info`.
- **`multiSignalStrainRule`** — `strainedSignals(recoveryPanel(data))`; fires at
  two or more, severity `attention`, category `recovery`, page `health`.
  Evidence lists the strained keys and uses the **smallest** sample count across
  them, so the count never overstates the weakest signal.
- **`correlationRule`** — evaluate a fixed, ordered list of candidate pairs (HRV
  against resting HR; sleep duration against efficiency; steps against sleep
  duration; active minutes against resting HR), take the strongest `|r| >= 0.5`,
  and phrase it as "moves with" / "moves against". Never "causes", "because", or
  "leads to".
- **`dataCompletenessRule`** — a metric with values earlier in `trends` and none
  in the last three days. Category `data`, page `devices`. Its body must say the
  metric stopped reporting, not that it is zero.
- **`goalDeltaRule`** — the selected day's steps against `goals.steps`. Silent
  when the goal is null. `notable` when short by more than 20 percent, `info`
  otherwise. Evidence carries the goal as `baseline` and its `source` in the
  body, so "your goal" is never ambiguous between provider and profile.
  `sampleCount: 1` — it is a single day, and saying so is the point.
- **`baselineDeviationRule`** — runs `detectAnomalies` over the trailing series
  for resting heart rate, HRV, and sleep duration; fires on the selected day
  only. `attention` beyond 3 sigma, `notable` beyond 2. Evidence carries the
  baseline and the number of prior days behind it.
- **`streakRule`** — counts consecutive days from the selected day backwards
  meeting `goals.steps`. Silent below 3. Severity `info`. `sampleCount` is the
  streak length.
- **`anomalyDayRule`** — the most recent flagged day in the visible window that
  is *not* the selected day, so it does not duplicate rule 2. Severity `notable`,
  page chosen by metric.
- **`energyBalanceRule`** — `energyBalance(trends)`; fires when at least 5 days
  have both sides logged and the mean absolute balance exceeds 300 kcal.
  Silent when fewer than 5 days are complete — a gap of that size over two days
  is a logging artefact, not a pattern. `sampleCount` is the count of complete
  days, never the window length.
- **`consistencyRule`** — coefficient of variation (sigma over mean) of sleep
  duration and of steps across the visible window; fires above 0.25 for sleep or
  0.5 for steps, minimum 7 finite days. Severity `notable`. Phrase it as
  variability against the user's own history, never against a population norm.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/insight-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add src/lib/insight-engine.ts src/lib/insight-engine.test.ts
git commit -m "feat: add the local insight engine with cited evidence"
```

---

### Task 9: Chart geometry

**Files:**
- Create: `src/components/analysis-chart-geometry.ts`
- Create: `src/components/analysis-chart-geometry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface Plot { width: number; height: number; margin: { top: number; right: number; bottom: number; left: number } }
export interface Point { x: number; y: number }
export function regressionLine(points: Point[]): { slope: number; intercept: number; from: Point; to: Point } | null
export function scatterPositions(points: Point[], plot: Plot): Array<{ cx: number; cy: number }>
export interface HeatmapCell { row: number; column: number; x: number; y: number; width: number; height: number; intensity: number | null }
export function heatmapCells(values: Array<Array<number | null>>, plot: Plot): HeatmapCell[]
export interface StackSegment { key: string; y: number; height: number; value: number }
export function stackSegments(values: Array<{ key: string; value: number | null }>, total: number, plot: Plot): StackSegment[]
export function bandPath(upper: Array<number | null>, lower: Array<number | null>, domain: { min: number; max: number }, plot: Plot): string
export interface DivergingBar { index: number; x: number; y: number; width: number; height: number; sign: 1 | -1 | 0 }
export function divergingLayout(values: Array<number | null>, plot: Plot): { zeroY: number; bars: DivergingBar[] }
```

**Background you need.** This is where SVG bugs actually live: off-by-one
placement, stacks that do not sum to their total, bands that invert when the
domain is negative, diverging bars drawn on the wrong side of zero. Extracting
the geometry into pure functions makes all of it testable with numbers, and
avoids introducing a DOM-testing dependency and convention the project does not
have.

`bandPath` must return a closed path: the upper edge left-to-right, then the
lower edge right-to-left, then `Z`. A null on either edge breaks the band into a
separate subpath rather than interpolating across the gap — an interpolated gap
draws data that was never recorded.

- [ ] **Step 1: Write the failing test**

Create `src/components/analysis-chart-geometry.test.ts` covering:

- `regressionLine` recovers a known slope and intercept from collinear points; returns null below 2 points; returns null when every x is identical (vertical, infinite slope); endpoints sit at the min and max x.
- `scatterPositions` maps the domain minimum to the left inset and the maximum to the right inset; y is inverted so the largest value sits highest.
- `heatmapCells` produces `rows * columns` cells; adjacent cells are contiguous with no overlap; a null value yields `intensity: null` rather than `0`; intensity is normalized to `[0, 1]` across the whole grid.
- `stackSegments` heights sum to the plot height when the values sum to `total`; a null segment is skipped without shifting the ones after it out of the stack; segments are contiguous.
- `bandPath` returns a path closed with `Z`; every coordinate is finite; a null in either edge starts a new subpath rather than bridging it; a fully-null input returns `''`.
- `divergingLayout` places the zero baseline mid-plot for a symmetric domain; a positive bar's `y + height === zeroY`; a negative bar starts at `zeroY`; a zero value has `sign: 0` and zero height; a null value produces no bar.

Assert on numbers, not on strings, except where the deliverable is a path.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/analysis-chart-geometry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/components/analysis-chart-geometry.ts` with no React import. Reuse
the margin convention already in `src/components/Charts.tsx`
(`{ top: 20, right: 14, bottom: 30, left: 48 }` for the full variant) so the new
charts line up visually with the existing ones.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/analysis-chart-geometry.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add src/components/analysis-chart-geometry.ts src/components/analysis-chart-geometry.test.ts
git commit -m "feat: add pure geometry for the analysis chart shapes"
```

---

### Task 10: The analysis chart components

**Files:**
- Create: `src/components/AnalysisCharts.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: Task 9's geometry.
- Produces: `ScatterChart`, `HeatmapGrid`, `StackedBarChart`, `RangeBandChart`, `DivergingColumnChart`.

**Background you need.** A separate file keeps `Charts.tsx` at its current 579
lines rather than growing it past the point where it can be held in context.

Histograms reuse the existing `ColumnChart` with bin-range labels — a separate
histogram component would duplicate it for no gain.

Every component follows the conventions already established in `Charts.tsx`,
which you should read first:

- a screen-reader data table (`AccessibleChartTable` is the model — copy the pattern; export a shared version from `Charts.tsx` if it fits without disturbing the existing components)
- `role="img"` with a descriptive `aria-label`, plus `<title>` and `<desc>`
- explicit null handling: a missing point renders as a gap with `var(--color-graphite)` at 0.3 opacity and an aria-label saying "no data", never as zero
- category colors from the existing CSS custom properties
- keyboard reachability: `tabIndex={0}` on each mark with an aria-label, matching `ColumnChart`
- **color never carries meaning alone** — every color-coded distinction also has a label, a pattern, or a position

| Component | Props | Consumers |
|---|---|---|
| `ScatterChart` | `{ points: Array<{ x, y, label }>, xLabel, yLabel, correlation: CorrelationResult \| null, ariaLabel }` | HRV against resting HR; sleep duration against efficiency |
| `HeatmapGrid` | `{ rows: string[], columns: string[], values: Array<Array<number \| null>>, formatter, ariaLabel }` | steps by weekday and week |
| `StackedBarChart` | `{ categories: Array<{ label, segments: Array<{ key, label, value, color }> }>, ariaLabel }` | activity intensity split; per-workout heart zones |
| `RangeBandChart` | `{ points: Array<{ label, value, min, max }>, band?: { mean, stdDev }, ariaLabel }` | SpO2 range; skin temperature against baseline |
| `DivergingColumnChart` | `{ values: Array<number \| null>, labels: string[], positiveLabel, negativeLabel, formatter, ariaLabel }` | energy balance; skin temperature delta |

`ScatterChart` renders the regression line only when `correlation` is non-null,
and prints `r` with its sample count next to the chart. A regression line drawn
under an `r` the engine refused to compute would assert a relationship that was
explicitly found insufficient.

- [ ] **Step 1: Read the existing conventions**

Run: `sed -n '70,115p' src/components/Charts.tsx` and
`sed -n '278,395p' src/components/Charts.tsx`.

- [ ] **Step 2: Write the components**

Create `src/components/AnalysisCharts.tsx`. Each component computes its geometry
by calling Task 9's functions — do not inline arithmetic that duplicates them,
because the tests only cover the exported versions.

- [ ] **Step 3: Add the styles**

Extend `src/styles.css` with `.scatter-chart`, `.heatmap-grid`,
`.stacked-bar-chart`, `.range-band-chart`, and `.diverging-column-chart`,
following the existing `.column-chart` and `.line-chart` rules. Reuse
`.chart-empty`, `.chart-gridline`, `.chart-tick`, `.chart-label`, and
`.chart-tooltip` rather than defining parallel ones.

- [ ] **Step 4: Run the full gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/AnalysisCharts.tsx src/styles.css
git commit -m "feat: add scatter, heatmap, stacked, band, and diverging charts"
```

---

### Task 11: The profile capture form

**Files:**
- Create: `src/components/ProfileSettings.tsx`
- Modify: `src/App.tsx` (the settings dialog, around line 681)

**Interfaces:**
- Consumes: `profile` from `src/lib/api.ts`; `profileCompleteness` from `src/lib/user-profile.ts`.
- Produces: `<ProfileSettings />`, self-contained — it loads and saves through the API itself.

**Background you need.** No blocking wizard. This is a "Profile" section inside
the existing settings dialog (`settingsOpen` in `App.tsx`), every field optional,
each labeled by **what it unlocks** rather than by what it is — "Year of birth
— enables heart-rate zones and VO2 max context" beats "Year of birth". That
labeling is what makes an optional field worth filling in.

Each field shows its origin: **from your provider** or **entered by you**. A
user edit always wins and is never overwritten by a later sync — the store
already enforces this via `userEdited`, so the UI only has to display it.

When the API is unreachable — the demo path — the profile resolves to an
all-null default and the form is disabled with an explanatory note. When the
secret store is unavailable the write fails explicitly, matching credentials and
the cache; surface that error in the form rather than silently discarding input.

- [ ] **Step 1: Write the component**

Fields, in this order, each with its unlock text from `UNLOCKS` in
`src/lib/user-profile.ts` so the two never drift:

`birthYear`, `heightCm`, `measuredMaxHeartRate`, `stepsGoal`,
`sleepGoalMinutes`, `waterGoalMl`, `weightGoalKg`.

Use `<input type="number">` with `min`/`max` mirroring `FIELD_RANGES` in
`core/user-profile.cjs`, an explicit `<label htmlFor>` per field, and a `<small>`
carrying the unlock text wired to the input with `aria-describedby`. Save on
blur, not on every keystroke.

- [ ] **Step 2: Mount it in the settings dialog**

In `src/App.tsx`, inside `<DialogContent className="settings-dialog">`, after the
`connected-state` block, add `<ProfileSettings />`. Do not add another dialog.

- [ ] **Step 3: Verify manually**

Run `npm run dev`, open Settings, enter a birth year and height, close and
reopen the dialog. Expected: the values persist. Then confirm the file is
encrypted at rest:

```bash
head -c 200 ~/.local/share/openfit/*/user-profile.secure.json
```
Expected: a JSON envelope with `"encrypted":true` and base64 `data` — no
plaintext birth year.

- [ ] **Step 4: Run the full gate and commit**

```bash
npm run check
git add src/components/ProfileSettings.tsx src/App.tsx
git commit -m "feat: capture the user profile in settings"
```

---

### Task 12: Wire the views

**Files:**
- Modify: `src/components/Views.tsx`
- Modify: `src/App.tsx` (load the profile once and pass it through `ViewProps`)

**Interfaces:**
- Consumes: everything from Tasks 4-10.
- Produces: no new export. `ViewProps` gains `profile: UserProfile` and `insights: Insight[]`.

**Background you need.** Every addition is guarded by the same availability
predicates the views already use (`src/lib/data-availability.ts`), so a partial
sync renders **fewer panels rather than empty ones**. Read that file before
starting.

| View | Additions |
|---|---|
| **Today** | Insight feed after Overview — the position `HOME_DASHBOARD_MODEL.md` assigns to "what is different from my baseline". Each insight shows its evidence, deep-links to the view that proves it, and offers "Improve this". Cap at four; the cap exists because eleven rules over a 14-day window would otherwise crowd the screen. |
| **Activity** | Calories-intraday column chart beside steps-per-hour, guarded on a non-empty dataset since Google Health never supplies one; 14-day intensity composition stack; weekday steps heatmap; cardio load trend with its ACWR readout and both window means; per-workout heart-zone stack in the detailed rows. |
| **Health** | SpO2 range band; skin temperature against baseline with the 30-day sigma band; heart-rate distribution histogram (`ColumnChart` over `histogram()`) with resting HR marked and Karvonen zones when `maxHeartRate` is known; HRV against resting HR scatter; the four-signal recovery panel as diverging columns. |
| **Sleep** | Sleep score trend; all four stage-transition counts; duration histogram; duration against efficiency scatter. |
| **Body** | Energy balance diverging bars; BMI trend derived per day from `trends.weight` and the profile height, shown only when height is set. |
| **Devices** | Per-source sync error list replacing the count sentence; profile completeness prompt when fields that would unlock analysis are unset. |

- [ ] **Step 1: Load the profile in `App.tsx`**

Fetch once via `profile.get()` in an effect, hold it in state, default to
`EMPTY_USER_PROFILE`, and catch the failure to that default so the demo path and
an unreachable API both degrade rather than blank the app. Pass it into the
views alongside `data`.

- [ ] **Step 2: Compute the analysis once per render**

In `App.tsx`, wrap in `useMemo` keyed on `[data, profile]`:
`buildInsights(data, profile, { loads })`, where `loads` comes from
`dailyCardioLoad` over the archive days. Pass the result down. Do not recompute
per view — three views need it and recomputing would triple the work on every
navigation.

- [ ] **Step 3: Add the panels, one view at a time**

Run `npm run check` after each view rather than after all six. A type error in
`HealthView` is far cheaper to find before `BodyView` is also in flight.

Every new panel must carry its sample count or window in visible text — "14
days", "over 9 recorded days". A chart without its window is a chart the user
cannot judge.

For the cardio load panel specifically: when `workloadRatio` returns
`sufficient: false`, render the day count sentence
("Chronic load needs 28 days of history; 11 recorded") **instead of** the ratio,
not alongside it.

- [ ] **Step 4: Verify each view manually**

Run `npm run dev` and visit all six pages with demo data. Expected: no empty
panels, no `NaN`, no `0` where a metric is absent, and no chart without a stated
window.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add src/components/Views.tsx src/App.tsx
git commit -m "feat: wire the analysis panels into every view"
```

---

### Task 13: Give the assistant the computed analysis

**Files:**
- Modify: `src/lib/health-assistant.ts`
- Modify: `src/lib/health-assistant.test.ts`
- Modify: `src/components/HealthAssistant.tsx`

**Interfaces:**
- Consumes: Tasks 5-8.
- Produces: an `analysis` block inside the context `buildHealthAssistantContext` returns.

**Background you need.** The assistant must reason from **the same numbers that
are on screen** rather than re-deriving them from raw series. That is cheaper,
and more importantly it stops the chat contradicting the UI — two different
correlation values for the same pair, computed two ways, is the worst possible
outcome for trust.

The existing `withoutNulls` compaction applies unchanged.

Task 3 of the assistant-markdown plan already added the recommendation
requirement to `HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS`. Do not add a second
copy here.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/health-assistant.test.ts`:

```ts
describe('assistant analysis context', () => {
  it('carries the computed analysis rather than leaving the model to re-derive it', () => {
    const data = createDemoData('2026-06-23')
    const context = JSON.parse(buildHealthAssistantContext(data, [data], 'today'))
    expect(context.analysis).toBeDefined()
    expect(context.analysis.insights.length).toBeGreaterThan(0)
    expect(context.analysis.recovery).toHaveLength(4)
  })

  it('labels an estimated max heart rate as estimated', () => {
    const data = createDemoData('2026-06-23')
    const context = JSON.parse(buildHealthAssistantContext(data, [data], 'today', { birthYear: 1990 }))
    expect(context.analysis.profile.maxHeartRate.basis).toBe('estimated')
  })

  it('compacts nulls out of the analysis block', () => {
    const data = createDemoData('2026-06-23')
    const context = JSON.parse(buildHealthAssistantContext(data, [data], 'today'))
    expect(JSON.stringify(context.analysis)).not.toContain('null')
  })

  it('carries no credential-shaped strings', () => {
    const data = createDemoData('2026-06-23')
    const serialized = buildHealthAssistantContext(data, [data], 'today')
    expect(serialized).not.toMatch(/access_token|refresh_token|client_secret|Bearer /i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/health-assistant.test.ts`
Expected: FAIL — `context.analysis` is undefined.

- [ ] **Step 3: Extend the context builder**

Give `buildHealthAssistantContext` an optional fourth parameter
`profile: UserProfile = EMPTY_USER_PROFILE` — optional so every existing caller
and test keeps compiling — and add:

```ts
analysis: withoutNulls({
  profile: {
    maxHeartRate: maxHeartRate(profile, new Date(current.selectedDate).getUTCFullYear()),
    bmi: bmiFor(current.body.weightKg, profile),
    goals: resolveGoals(current, profile),
  },
  correlations,      // the same pairs the correlation rule evaluates
  anomalies,         // from detectAnomalies over the visible window
  weekly,            // weeklyRollup for steps and sleep
  recovery: recoveryPanel(current),
  cardioLoad: { daily: loads.slice(-28), workload: workloadRatio(loads, current.selectedDate) },
  insights: buildInsights(current, profile, { loads }),
}),
```

Keep `insights: current.insights` where it is. The normalizer's array still
feeds the context and removing it would regress what the assistant sees.

- [ ] **Step 4: Pass the profile from the component**

In `src/components/HealthAssistant.tsx`, add a `profile` prop, hold it in a ref
beside `dataRef` following the existing pattern, and pass it as the fourth
argument to `buildHealthAssistantContext` at line 156.

- [ ] **Step 5: Wire the "Improve this" action**

The Today insight feed's button opens the assistant seeded with that insight's
`prompt`. Add an `initialPrompt` prop to `HealthAssistant`, and on open send it
through the runtime's composer rather than appending a synthetic message — the
user must be able to see and edit the question before it is sent.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/lib/health-assistant.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify the context size**

`serializeHealthContext` in `core/agents/agent-common.cjs` throws above 500,000
characters. Confirm the real payload stays well under it:

```bash
node -e "
const { createDemoData } = require('./dist-test/demo.js')" 2>/dev/null || \
npx vitest run src/lib/health-assistant.test.ts --reporter=verbose
```

Simpler: add a test asserting
`buildHealthAssistantContext(data, archive, 'today').length < 400_000` with a
28-day archive. If it exceeds that, trim `cardioLoad.daily` before trimming
insights — the daily array is the largest and the least individually meaningful.

- [ ] **Step 8: Run the full gate and commit**

```bash
npm run check
git add src/lib/health-assistant.ts src/lib/health-assistant.test.ts src/components/HealthAssistant.tsx
git commit -m "feat: give the assistant the computed analysis as context"
```

---

## Done When

- `npm run check` is green.
- Goal rings and target lines render for a Google Health account (Task 2).
- Today shows an insight feed where every card carries evidence and a sample count.
- Activity shows cardio load with its ACWR, or the honest day count when the window is too short.
- Health shows the four-signal recovery panel — and no combined recovery score anywhere.
- No `NaN`, and no `0` standing in for an absent metric, on any view with demo data.
- The assistant's answers cite the same numbers the screen shows.
- Thirteen commits, one per task.
