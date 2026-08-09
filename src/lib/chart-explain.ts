import type { PageId } from '@/types'

/**
 * The prompt behind a chart's "Explain" button.
 *
 * Everything the assistant is told about the chart comes from the panel itself:
 * the title, the window the panel is drawing, and the readings the user can see
 * on screen right now. The values are passed through verbatim so the answer
 * talks about the user's own numbers rather than a textbook range — and so the
 * assistant is never left guessing at figures it would otherwise invent.
 *
 * Readings are derived from health data, which is user-controlled text as far
 * as this module is concerned: a device name, a label from an import, a note.
 * Every field is flattened to a single line, stripped of control characters and
 * capped before it reaches the prompt, so no reading can forge a heading, a new
 * instruction, or a fake section break.
 */
export interface ChartReading {
  label: string
  value: string
}

export interface ChartExplainInput {
  chartId: string
  title: string
  page: PageId
  /** The span the chart is drawing, e.g. "14 days", "9 recorded nights". */
  window?: string
  /** The values visible on the chart right now. */
  readings: ChartReading[]
  /** Anything the panel already tells the user, e.g. a caveat under the chart. */
  note?: string
}

/** Per-field cap. A reading is a short label and a short figure; nothing here is prose. */
export const CHART_EXPLAIN_FIELD_MAX_CHARS = 120
/** The panel's own caveat is a sentence or two, so it gets more room than a reading. */
export const CHART_EXPLAIN_NOTE_MAX_CHARS = 320
/** Hard ceiling on the assembled prompt. Readings are dropped before the instructions are. */
export const CHART_EXPLAIN_MAX_CHARS = 4000

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\ufeff]/g

const TRUNCATION_NOTICE = '- (Not all readings fitted here — the list above is truncated.)'

function instructions(hasReadings: boolean): string {
  return [
    'Answer in four parts, in this order:',
    '1. What this chart shows and how to read it.',
    hasReadings
      ? '2. What my readings above say about me specifically — work from those actual figures, not from a textbook range.'
      : '2. What this chart would tell me about myself once it has readings, and that it has none to interpret right now.',
    '3. Whether anything here needs attention, and why.',
    '4. One concrete thing to change, the horizon to judge it over, and the view in this dashboard that will confirm whether it worked.',
    '',
    'Use only the readings above; do not invent values the chart does not show. If the data here is too thin to support a conclusion, say so plainly rather than reaching for one.',
  ].join('\n')
}

/** Flattens to one line, drops control characters, collapses whitespace and caps the length. */
function clean(value: string | undefined, max: number): string {
  const flattened = (value ?? '').replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= max) return flattened
  return `${flattened.slice(0, max - 1)}…`
}

function readingLines(readings: ChartReading[]): string[] {
  return readings
    .map((reading) => ({
      label: clean(reading.label, CHART_EXPLAIN_FIELD_MAX_CHARS),
      value: clean(reading.value, CHART_EXPLAIN_FIELD_MAX_CHARS),
    }))
    .filter((reading) => reading.label !== '' || reading.value !== '')
    .map((reading) => `- ${reading.label}: ${reading.value}`)
}

/** Keeps as many reading lines as the cap allows, flagging the cut when one is made. */
function fitReadings(lines: string[], budget: number): string[] {
  const reserve = TRUNCATION_NOTICE.length + 1
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    if (used + line.length + 1 > budget - reserve) {
      kept.push(TRUNCATION_NOTICE)
      return kept
    }
    kept.push(line)
    used += line.length + 1
  }
  return kept
}

export function buildChartExplainPrompt(input: ChartExplainInput): string {
  const title = clean(input.title, CHART_EXPLAIN_FIELD_MAX_CHARS)
  const page = clean(input.page, CHART_EXPLAIN_FIELD_MAX_CHARS)
  const chartId = clean(input.chartId, CHART_EXPLAIN_FIELD_MAX_CHARS)
  const window = clean(input.window, CHART_EXPLAIN_FIELD_MAX_CHARS)
  const caveat = clean(input.note, CHART_EXPLAIN_NOTE_MAX_CHARS)

  const header = [
    'Explain one chart from my health dashboard to me.',
    '',
    `Chart: ${title}`,
    `Dashboard view: ${page}`,
    `Chart id: ${chartId}`,
    window === ''
      ? 'Window covered: unknown — the panel does not state one, so do not assume a window.'
      : `Window covered: ${window}.`,
  ]
  if (caveat !== '') header.push(`The panel also tells me: ${caveat}`)

  const lines = readingLines(input.readings)
  if (lines.length === 0) {
    const body = [
      ...header,
      '',
      'No readings are available from this chart right now. Explain the chart in general terms and say plainly that no readings are currently available — do not invent values for it.',
      '',
      instructions(false),
    ].join('\n')
    return body.slice(0, CHART_EXPLAIN_MAX_CHARS)
  }

  const before = `${header.join('\n')}\n\nReadings currently on the chart:\n`
  const after = `\n\n${instructions(true)}`
  const budget = Math.max(0, CHART_EXPLAIN_MAX_CHARS - before.length - after.length)
  return `${before}${fitReadings(lines, budget).join('\n')}${after}`.slice(0, CHART_EXPLAIN_MAX_CHARS)
}
