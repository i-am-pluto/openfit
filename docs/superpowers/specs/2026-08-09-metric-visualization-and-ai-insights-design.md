# Metric Visualization and AI Insights — Design

Date: 2026-08-09
Status: approved for planning

## Problem

OpenFit ingests 28 Google Health endpoints and normalizes them into a rich
`DashboardData` model, but a measurable share of that model never reaches the
screen. The app also owns only six chart shapes, which limits every view to
"value over time" and "value versus goal". Finally, the Codex assistant is a
sidebar chat: it can navigate, but it cannot ground its answers in the same
numbers the dashboard computes, and its instructions ask it to describe rather
than to recommend.

## Goals

1. Render the data OpenFit already collects but never draws.
2. Add the analysis shapes the current chart library cannot express.
3. Compute insights locally, deterministically, and testably — so the feature
   works without Codex Desktop installed.
4. Give the assistant the computed analysis as context, and require it to
   produce actionable improvements rather than descriptions.
5. Collect the small set of user profile facts that unlock analysis the
   provider cannot supply.
6. Treat cardio load, strain, and recovery as a first-class metric family, built
   from published formulas whose inputs stay visible.
7. Render the assistant's markdown as markdown, and instruct it to write for the
   surface it is actually displayed on.

## Non-Goals

- Reworking views to read the multi-month encrypted archive instead of the
  provider's 14-day `trends`. Deferred; it touches the archive API, App state,
  and every view, and is worth its own spec.
- Any proprietary composite score. `docs/HOME_DASHBOARD_MODEL.md` forbids it and
  this design upholds that: every number traces to a measurement, an explicit
  goal, or a visible personal baseline. Section 6 admits two published
  composites — Edwards TRIMP and ACWR — under the three constraints stated
  there; it invents none, and it produces no single "recovery score".
- Machine-learned models trained on the user's data. "AI algorithms" here means
  published statistical methods computed locally plus a language model reasoning
  over their output. Nothing is trained, and no health data leaves the host.
- Historical backfill of the archive beyond what the scheduler has collected.
  Deferred; the 28-day windows in section 6 fill in over time and state their
  real day count until they do.
- Component-level DOM tests. The project has no jsdom or testing-library
  dependency and no component tests; this design does not introduce that
  convention.

## Current State

### Metrics in `DashboardData`

| Domain | Fields |
|---|---|
| Activity | steps, calories out, distance, floors, active minutes (light / moderate / vigorous), zone minutes, sedentary minutes, matching goals, steps intraday, calories intraday |
| Heart and physiology | current HR, resting HR, HR min / max, HR intraday, HRV daily, HRV deep-sleep RMSSD, HRV entropy, non-REM HR, breathing rate, SpO2 with min / max, skin temperature delta, skin nightly / baseline / 30-day sigma, core temperature, VO2 max, cardio score, ECG classification, blood glucose, irregular-rhythm alerts |
| Sleep | total minutes, goal, score, efficiency, start / end, four stages, stage timeline, stage transition counts, latency, minutes after waking, time in bed, minutes awake |
| Body | weight and goal, BMI, body fat, water and goal, calories in |
| Workouts | name, date, time, duration, calories, distance, average HR, zone minutes, steps, pace, per-zone minutes |
| Trends | 22 daily series over 14 days |

### Chart primitives

`LineChart` (line and area), `ColumnChart`, `RadialProgress`, `BulletChart`,
`SleepStageBar`, `SleepStageTimeline`. All handle null gaps, expose a screen
reader data table, and support keyboard traversal. They are a good foundation
and this design does not modify them.

### Gaps

**Collected but never drawn**

| Field | Where it dies |
|---|---|
| `activity.caloriesIntraday` | normalized and sent to the assistant, rendered nowhere |
| `insights[]` | built in `normalize.ts` and `demo.ts`, rendered in no view |
| `trends.sleepScore` | present in the trend model, no chart |
| `sleep.stageTransitions.deep/light/rem` | only the `wake` count surfaces |
| `activity.lightActiveMinutes` and siblings | plain numbers, no composition |
| `ActivityItem.heartZoneMinutes` | joined into a text string |
| `health.spo2Min` / `spo2Max` | text string, though it is range data |
| `health.skinBaselineTemperatureCelsius`, `skinTemperatureStddev30dCelsius` | text string, though it is band data |
| `sync.errors[]` | reduced to a count sentence on Devices |

**Missing analysis shapes.** No correlation, no distribution, no heatmap, no
composition stacking, no range band, and no signed bars — so the signed skin
temperature delta is drawn on a line chart and energy balance cannot be drawn
at all.

**Missing profile facts.** No birth year, so max heart rate is unknown and
heart-rate zones cannot be computed. No height, so BMI exists only when the
provider supplies it, which makes a BMI trend impossible despite a full weight
trend being available.

**Provider gaps found while specifying this work.** These are pre-existing
defects in `core/providers/google-health.cjs`, not consequences of this design,
and they change what the profile is for:

| Line | Finding | Consequence |
|---|---|---|
| 557, 566, 590, 592 | `activityGoals`, `sleepGoal`, `weightGoal` and `waterGoal` are all translated as empty objects | every goal is null for every Google Health user, so goal rings, target lines, bullet charts and "percent of goal" notes are dead on the primary provider and light up only on legacy Fitbit or demo data |
| 228, 229, 476, 477 | `/users/me/profile` and `/users/me/settings` are fetched on every sync, but only `membershipStartDate` and `timeZone` survive translation | any date of birth, height or goals those responses carry are discarded before caching, so they cannot be recovered from existing archives |
| 559 | `caloriesIntraday` is translated as an empty dataset | a calories-intraday chart can only ever render on legacy Fitbit or demo data |
| 588 | `bodyWeight` entries are translated with `bmi: null` | BMI is null for all Google Health users regardless of profile completeness |

The first two are the reason this design treats profile goals as a real source
rather than a fallback, and the reason prefill is worth pursuing before asking
the user to type anything.

## Design

### 1. User profile

A small, locally stored set of facts, each justified by a named consumer.

```ts
export interface UserProfile {
  birthYear: number | null          // -> max HR estimate -> HR zones, VO2 max context
  heightCm: number | null           // -> BMI from weight, enabling a BMI trend
  measuredMaxHeartRate: number | null // -> overrides the estimate when known
  stepsGoal: number | null          // -> goal line when the provider returns none
  sleepGoalMinutes: number | null
  waterGoalMl: number | null
  weightGoalKg: number | null
}
```

Biological sex is deliberately excluded. Its only use would be generic
population threshold tables, which `HOME_DASHBOARD_MODEL.md` rejects, and
collecting sensitive data with no consumer is worse than not collecting it.

**Storage.** The profile is personal data, so it follows the same boundary as
credentials and the health cache rather than `localStorage`. Since the HTTP
server landed, that boundary is `core/secrets.cjs` — an AES-256-GCM store keyed
by `master.key`, with `safeStorage` optional — which works in both Electron and
headless server modes. The path is therefore:

1. a profile module in `core/` built on `createSecretStore`;
2. `GET` and `POST /api/profile` registered in `server/routes/health.cjs`
   alongside the existing `app.*` handlers;
3. a `profile` method pair on the `src/lib/api.ts` client.

No IPC channel and no preload change is required. When the secret store is
unavailable the write fails explicitly, matching credentials and cache, and the
settings form surfaces that error.

When the API is unreachable — the demo path — the profile resolves to an
all-null default and the form is disabled. Every consumer already handles null.

**Capture.** A "Profile" section in the existing settings dialog
(`settingsOpen` in `App.tsx`), with each field labeled by what it unlocks, and
every field optional. No blocking wizard.

**Prefill.** The user should not type what the provider already knows. Because
the profile and settings responses are fetched but discarded, the adapter is
changed to pass them through to the normalized payload, and any recognized
field maps onto the matching profile value. The user then confirms or corrects
a pre-filled form rather than filling an empty one, and each field is labeled
with its origin: supplied by the provider, or entered by the user. A user edit
always wins and is never overwritten by a later sync.

Which fields those responses actually carry is unverified. The audit intended to
answer it could not run: `scripts/audit-google-health-raw.cjs` still requires
the pre-restructure path `../electron/google-health-service.cjs`, and it is
Electron-bound so it needs a display. Repointing it at
`core/providers/google-health.cjs` and running it under plain Node is a
prerequisite task in the plan. Until it runs, the mapping is written
defensively: recognized fields map, unrecognized responses are ignored, nothing
assumes a field name, and every profile field remains manually editable.

**Precedence.** For goals the order is provider value, then user profile value,
then absent — since a provider goal is the goal the user configured in the
Google or Fitbit app. Given the empty-goals defect above, on Google Health the
profile is in practice the only source of goals until that defect is fixed. If
the audit shows goals are available upstream, fixing the adapter to read them is
preferred over relying on the profile, and the profile returns to being a
genuine fallback.

**Derived values.**

- `maxHeartRate` = `measuredMaxHeartRate` when set, otherwise
  `208 - 0.7 * age` (Tanaka) from `birthYear`, otherwise null. The UI labels
  which of the two applies; an estimate is never presented as a measurement.
- `bmi` = provider BMI when present, otherwise `weightKg / (heightCm / 100)^2`.
- Heart-rate zones use the Karvonen heart-rate reserve between the measured
  resting HR and `maxHeartRate`. Every input is either the user's own
  measurement or an explicitly labeled estimate. Zones are omitted entirely when
  `maxHeartRate` is null.

### 2. Local analysis engine

Two new pure modules with no dependencies, each unit-tested directly.

**`src/lib/metric-analysis.ts`**

| Function | Contract |
|---|---|
| `correlate(a, b)` | Pearson r over pairs where both series are finite. Returns null below 7 pairs or when either side has zero variance. Reports `sampleCount`. |
| `detectAnomalies(series, options)` | z-score against a trailing personal baseline. Requires at least 4 prior finite points; flags beyond 2 sigma. Never flags the baseline window itself. |
| `weeklyRollup(trends, selector)` | Groups daily points into ISO weeks; a week is reported only when it holds at least 3 finite days. |
| `weekdayProfile(trends, selector)` | Mean per weekday with per-weekday sample counts. |
| `histogram(values, binCount)` | Equal-width bins over the finite range; returns bin edges, counts, and labels. |
| `bandStats(values)` | min, max, mean, and standard deviation for range-band rendering. |
| `energyBalance(trends)` | Per-day `caloriesIn - calories`, null on any day missing either side. |
| `heartRateZones(restingHr, maxHr)` | Karvonen zone boundaries, or null when `maxHr` is null. |
| `samplesInZones(intraday, zones)` | Count and share of intraday samples falling in each zone. |

`samplesInZones` reports sample share rather than minutes on purpose.
`compactIntraday` in `normalize.ts` averages heart-rate samples into
minute-level points and then buckets them when the series exceeds 288 points, so
the interval a point represents is not constant across a day. Converting counts
to minutes would require assuming uniform spacing that the pipeline does not
guarantee. The Health view labels this axis as a share of recorded samples.

Null-safety, insufficient-sample, and zero-variance behavior are part of the
contract and are tested, because silently returning `NaN` or `0` would let the
UI and the assistant present noise as signal.

**`src/lib/insight-engine.ts`**

```ts
export interface Insight {
  id: string
  category: 'activity' | 'heart' | 'sleep' | 'recovery' | 'body' | 'data'
  severity: 'info' | 'notable' | 'attention'
  title: string
  body: string
  evidence: {
    label: string
    value: string
    baseline?: string
    sampleCount: number
  }
  page?: PageId
  prompt: string
}
```

`buildInsights(data, profile)` returns a deterministic, severity-ordered list.
Rules, each of which must cite evidence or not fire at all:

1. **Goal delta** — selected day versus an explicit goal.
2. **Baseline deviation** — metric beyond 2 sigma of its personal baseline, minimum 4 prior days.
3. **Streak** — consecutive days meeting a goal, minimum 3.
4. **Correlation** — `|r| >= 0.5` with at least 7 pairs, phrased as association, never causation.
5. **Anomaly day** — a flagged day inside the visible window.
6. **Energy balance** — sustained intake-versus-expenditure gap, only when both sides are logged.
7. **Consistency** — coefficient of variation of sleep duration or steps against the same user's history.
8. **Data completeness** — a metric that stopped reporting, distinguishing absent from zero.

Every insight carries a `prompt` that seeds the assistant with an improvement
request naming the metric, the numbers, and the window.

The existing `insights[]` produced by `normalize.ts` is retained as an input to
this engine rather than being deleted, so the assistant context does not
regress while the richer path takes over the UI.

### 3. New chart shapes

New file `src/components/AnalysisCharts.tsx`, keeping `Charts.tsx` focused on
the existing primitives rather than growing it past its current 579 lines.

| Component | Purpose | Consumers |
|---|---|---|
| `ScatterChart` | two metrics against each other, with a least-squares line and the r value | HRV against resting HR; sleep duration against efficiency |
| `HeatmapGrid` | weekday by week intensity grid | steps by weekday |
| `StackedBarChart` | composition over categories | activity intensity split; per-workout heart zones |
| `RangeBandChart` | central value with a min / max or sigma band | SpO2 range; skin temperature against baseline |
| `DivergingColumnChart` | signed values as bars from a zero baseline | energy balance; skin temperature delta |

Histograms reuse the existing `ColumnChart` with bin-range labels; a separate
component would duplicate it.

All five follow the conventions already established in `Charts.tsx`: a screen
reader data table, `role="img"` with a descriptive label, explicit null
handling, and category colors from the existing CSS custom properties. Color
never carries meaning alone.

**Testability.** All geometry is extracted into exported pure functions —
`regressionLine`, `heatmapCells`, `stackSegments`, `bandPath`,
`divergingLayout` — which take numbers and return numbers or path strings. These
are unit-tested directly. This is where SVG bugs actually live, and it avoids
introducing a DOM-testing dependency and convention the project does not have.

### 4. View wiring

| View | Additions |
|---|---|
| Today | Insight feed section placed after Overview, answering "what is different from my baseline" in the position `HOME_DASHBOARD_MODEL.md` assigns it. Each insight shows its evidence, deep-links to the view that proves it, and offers "Improve this". |
| Activity | Calories intraday column chart beside steps per hour, guarded on a non-empty dataset since Google Health never supplies one; intensity composition stack over 14 days; weekday steps heatmap; per-workout heart-zone stack in detailed rows. |
| Health | SpO2 range band; skin temperature against baseline with the 30-day sigma band; heart-rate distribution histogram with resting HR marked and Karvonen zones when `maxHeartRate` is known; HRV against resting HR scatter. |
| Sleep | Sleep score trend; all four stage transition counts; duration histogram; duration against efficiency scatter. |
| Body | Energy balance diverging bars; BMI trend derived per day from `trends.weight` and the profile height, shown only when height is set. |
| Devices | Per-source sync error list replacing the count sentence; profile completeness prompt when fields that would unlock analysis are unset. |

Every addition is guarded by the same availability predicates the views already
use, so a partial sync renders fewer panels rather than empty ones.

### 5. Assistant integration

**Context.** `src/lib/health-assistant.ts` gains an `analysis` block carrying the
computed correlations, anomalies, weekly rollups, insights, and the derived
profile values with their estimated-versus-measured labels. The assistant then
reasons from the same numbers on screen instead of re-deriving them from raw
series, which is both cheaper and prevents the chat from contradicting the UI.
The existing `withoutNulls` compaction applies unchanged.

**Instructions.** A single constant edit to
`HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS` in `core/agents/agent-common.cjs`,
adding the requirement that answers give specific, actionable recommendations —
what to change, in what direction, over what horizon, and which OpenFit view
will show whether it worked — each grounded in cited evidence from the context,
with uncertainty stated and the existing non-diagnostic boundary intact.

That constant is shared by `core/agents/codex-service.cjs` and
`core/agents/claude-code.cjs`, so one edit changes the behavior of both
assistant backends and no per-backend prompt drift is introduced.

**Seeded prompts.** The "Improve this" action on an insight opens the assistant
with that insight's `prompt`.

**Degradation.** Insights, charts, and profile-derived values are computed
locally and render with Codex absent. Only the seeded-prompt action and the
narrative require the assistant, and it is already gated on
`status.available && status.authenticated`.

### 6. Cardio load, strain, and recovery

**Why these are composites, and how they stay honest.** `HOME_DASHBOARD_MODEL.md`
forbids invented composite scores, and strain and stress are composites. Each one
here therefore has to satisfy three rules: name a published formula, show its
inputs on the same screen, and report in that formula's own documented unit —
never a 0-100 scale OpenFit made up. A composite that cannot meet all three is
not shipped.

**Cardio load (strain).** Edwards' summated heart-rate-zone TRIMP:
`load = sum(minutes_in_zone_i * i)` for `i = 1..4` over light, moderate,
vigorous, and peak. The inputs come from `activities[].heartZoneMinutes`, which
the provider already supplies per workout as true minutes — no intraday
re-bucketing, so none of the sampling artefact that made a minutes-per-zone
figure unsound elsewhere in this document. Days with no recorded workout fall
back to the daily Active Zone Minutes total, flagged on screen as the coarser
source. The unit is TRIMP points and is labelled as such.

**Acute:chronic workload ratio.** `ACWR = 7-day mean load / 28-day mean load`,
rendered with both windows and their day counts visible. Below 14 chronic days it
is suppressed outright in favour of an explicit "chronic load needs 28 days of
history; 11 recorded" note, because a ratio computed against a half-filled window
is worse than no ratio. The archive in `core/health-cache.cjs` is unbounded and
never pruned, so the window fills in as the ten-minute scheduler runs. Historical
backfill remains unimplemented and stays deferred.

**Recovery.** No single score. A panel of four independent deviations from the
user's own trailing 28-day baseline, each in its native unit with the baseline
printed beside it: HRV (RMSSD), resting heart rate, respiratory rate, and skin
temperature delta — the last already arriving as a deviation. Sleep efficiency
joins as context. Nothing is summed. Whether these four agree or disagree on a
given morning is precisely the information a single number would destroy, and it
is the thing worth showing.

**Cardio fitness.** The `vo2Max` / `cardioScore` trend against its 28-day
baseline, the resting-heart-rate trend, and the heart-rate-zone distribution
histogram from section 3.

**Where AI enters.** Everything above is computed locally and renders with no
assistant present. The assistant reads these figures from the context block and
does the part statistics cannot: reconciling signals that disagree, weighing them
against what the user recorded in the profile, and proposing one specific change
with a horizon and the view that will confirm whether it worked. Three rules in
`insight-engine.ts` cover it — load spike (ACWR above 1.5), sustained
undertraining (ACWR below 0.8 across seven days), and multi-signal strain (two or
more recovery deviations beyond 1.5 z on the same day).

### 7. Assistant markdown

**Rendering.** `MessagePrimitive.Parts` renders text parts verbatim today, so
every heading, list, table, and bold span Claude Code emits reaches the user as
literal syntax. A `MarkdownText` component built on `react-markdown` and
`remark-gfm` is passed as `components={{ Text: MarkdownText }}`.

`@assistant-ui/react-markdown` is deliberately not used: at 0.14.10 it peers on
`@assistant-ui/react ^0.15.0` while this app pins 0.14.23, so adopting it forces
a runtime major bump mid-branch and buys no capability the two direct
dependencies do not already provide.

**Safety.** `react-markdown` does not render raw HTML unless `rehype-raw` is
added, and it is not added. The `<!-- openfit:navigate -->` directive therefore
cannot reach the DOM even if `stripAssistantNavigation` were to miss it; the
strip stays the primary control and this is the second. Link targets are
restricted to `http:` and `https:` through `urlTransform`, and anything else
renders as plain text. Assistant output is derived from health data and is
treated as untrusted input throughout.

**Streaming.** An unterminated code fence mid-stream swallows the rest of the
response into a code block until its closing fence arrives.
`stabilizeStreamingMarkdown` appends a synthetic closing fence when the fence
count is odd — a pure function over the visible text, applied only to in-flight
deltas and never to the settled final message.

**Prompt.** `HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS` currently instructs
"concise plain text", which actively fights the renderer being added. It is
replaced by a formatting contract written for a narrow sidebar: GitHub-flavored
markdown; the answer first and the evidence second; `##` as the deepest heading;
bullets rather than prose whenever more than one item is being compared; tables
only at three columns or fewer and bullets beyond that; bold reserved for the one
number carrying the answer; no code fences except when quoting raw data. This
merges with the recommendation requirement from section 5 into the single shared
constant that serves both backends.

**Styling.** `.assistant-ai-message` gains element styles in `src/styles.css` for
headings, lists, tables, and inline code, with tables inside an
`overflow-x: auto` wrapper so a wide table scrolls itself rather than the
sidebar.

## Testing

| File | Covers |
|---|---|
| `src/lib/metric-analysis.test.ts` | Pearson against known values; null on zero variance; null below the sample floor; null gaps skipped rather than zero-filled; anomaly windowing excludes the point under test; ISO week boundaries including year rollover; histogram edges including a single-value series; Karvonen zones null without max HR |
| `src/lib/insight-engine.test.ts` | Each rule fires on data that warrants it and stays silent otherwise; evidence sample counts are accurate; deterministic ordering; severity ranking; absent is never reported as zero |
| `src/components/analysis-chart-geometry.test.ts` | Regression line endpoints; heatmap cell placement; stack offsets summing to the total; band path bounds; diverging layout across the zero baseline |
| `src/lib/cardio-load.test.ts` | Edwards TRIMP against hand-computed zone minutes; the Active Zone Minutes fallback is flagged and never silently mixed with workout-derived load; ACWR arithmetic; suppression below 14 chronic days reports the real day count; a zero chronic mean yields null rather than infinity |
| `src/lib/recovery-panel.test.ts` | Each deviation is computed against its own baseline and never against another metric's; an absent signal drops out of the panel instead of reading zero; the baseline window reports its true sample count |
| `src/lib/assistant-markdown.test.ts` | `stabilizeStreamingMarkdown` closes an odd fence count and leaves balanced text untouched; a navigation directive never survives into rendered output; non-http schemes are refused by the URL transform |
| `src/lib/health-assistant.test.ts` (extended) | The analysis block is present, null-compacted, and free of credentials |
| `src/lib/user-profile.test.ts` | Tanaka estimate; measured value overrides the estimate; BMI derivation; provider goals outrank profile fallbacks; a user edit is not overwritten by a later sync; all-null profile degrades cleanly |
| `server/routes.test.ts` (extended) | `GET` and `POST /api/profile` round-trip, reject malformed bodies, and fail explicitly when the secret store is unavailable |
| `core/providers/google-health.test.ts` (extended) | Profile and settings passthrough; recognized fields map; unrecognized shapes are ignored rather than throwing |

Validation gate: `npm run check` — typecheck, Electron syntax check, the full
vitest suite, and the production build.

## Risks

- **Merge collision** with the parallel Claude Code and HTTP-server work.
  Resolved: that work landed on this branch at `345e99c` during specification,
  and this document is written against the resulting layout. The assistant edit
  is now a single shared constant serving both backends, and the profile needs
  no preload or IPC surface at all.

- **Unverified prefill mapping.** The provider audit has not run, so no field
  name in the profile or settings response is confirmed. Mitigated by making
  the audit a prerequisite task, mapping defensively, and keeping every field
  manually editable so prefill is an improvement rather than a dependency.
- **Insight noise.** Eight rules over a 14-day window could crowd the home
  screen. Mitigated by severity ordering and a cap of four insights on Today,
  with the remainder reachable from the view each one deep-links to.

- **Plan size.** This spec spans storage, analysis, five chart shapes, six
  views, and the assistant. The implementation plan should stage it so each
  stage is independently verifiable: profile and storage, then the analysis
  engine, then chart primitives, then view wiring, then the assistant layer.
- **Estimate presented as measurement.** Mitigated by labeling every derived
  value at the point of display and omitting zone charts entirely when
  `maxHeartRate` is unknown.
