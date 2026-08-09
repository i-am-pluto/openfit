// Pure SVG geometry for the analysis charts. No React, no DOM: numbers in,
// numbers or path strings out, so the placement rules that SVG bugs hide in —
// off-by-one insets, stacks that miss their total, bands that invert on a
// negative domain, diverging bars on the wrong side of zero — are testable
// without a DOM-testing dependency the project does not otherwise have.
//
// Two rules hold everywhere:
//   * A missing value is never coerced to zero. It is dropped, reported as
//     null, or breaks the shape — never drawn as a real reading of 0.
//   * Every coordinate returned is finite, including for degenerate input
//     (one point, an all-identical domain, a plot with no room in it).

export interface Plot {
  width: number
  height: number
  margin: { top: number; right: number; bottom: number; left: number }
}

export interface Point {
  x: number
  y: number
}

/** The margin the full-size charts in `Charts.tsx` use, so these line up with them. */
export const CHART_MARGIN = { top: 20, right: 14, bottom: 30, left: 48 } as const

export function createPlot(width: number, height: number, margin: Plot['margin'] = CHART_MARGIN): Plot {
  return { width, height, margin }
}

interface Area {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** The drawable rectangle inside the margins, clamped so it can never go negative. */
function area(plot: Plot): Area {
  const left = plot.margin.left
  const top = plot.margin.top
  const width = Math.max(0, plot.width - plot.margin.left - plot.margin.right)
  const height = Math.max(0, plot.height - plot.margin.top - plot.margin.bottom)
  return { left, top, right: left + width, bottom: top + height, width, height }
}

function isFinitePoint(point: Point) {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

function isNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value))
}

/**
 * Maps a value onto a pixel span. A zero-width domain has no ordering to
 * express, so everything lands in the middle rather than at an arbitrary end.
 */
function scale(value: number, min: number, max: number, from: number, span: number) {
  if (!(max > min)) return from + span / 2
  return from + ((value - min) / (max - min)) * span
}

/** Ordinal positions across the plot: a lone column sits centred, not flush left. */
function columnCentre(index: number, count: number, box: Area) {
  if (count <= 1) return box.left + box.width / 2
  return box.left + (index / (count - 1)) * box.width
}

/**
 * Ordinary least squares. Returns null rather than a fabricated line when there
 * is nothing to fit: fewer than two finite points, or a vertical cloud whose
 * slope is infinite.
 */
export function regressionLine(points: Point[]): { slope: number; intercept: number; from: Point; to: Point } | null {
  const valid = points.filter(isFinitePoint)
  if (valid.length < 2) return null

  const count = valid.length
  const meanX = valid.reduce((total, point) => total + point.x, 0) / count
  const meanY = valid.reduce((total, point) => total + point.y, 0) / count
  let covariance = 0
  let varianceX = 0
  for (const point of valid) {
    const deltaX = point.x - meanX
    covariance += deltaX * (point.y - meanY)
    varianceX += deltaX * deltaX
  }
  if (varianceX === 0) return null

  const slope = covariance / varianceX
  const intercept = meanY - slope * meanX
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null

  const xs = valid.map((point) => point.x)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  return {
    slope,
    intercept,
    from: { x: minX, y: slope * minX + intercept },
    to: { x: maxX, y: slope * maxX + intercept },
  }
}

/**
 * Positions for a scatter cloud. The x domain spans the full inset width and y
 * is inverted so the largest value sits highest. Points that are not finite are
 * dropped: there is no honest place to put one, and emitting NaN would silently
 * blank the mark.
 */
export function scatterPositions(points: Point[], plot: Plot): Array<{ cx: number; cy: number }> {
  const box = area(plot)
  const valid = points.filter(isFinitePoint)
  if (!valid.length) return []

  const xs = valid.map((point) => point.x)
  const ys = valid.map((point) => point.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  return valid.map((point) => ({
    cx: scale(point.x, minX, maxX, box.left, box.width),
    cy: scale(maxY - point.y, 0, maxY - minY, box.top, box.height),
  }))
}

export interface HeatmapCell {
  row: number
  column: number
  x: number
  y: number
  width: number
  height: number
  intensity: number | null
}

/**
 * A contiguous grid of cells covering the plot area. Intensity is normalized
 * across the whole grid so cells are comparable with one another; a missing
 * reading stays null so the renderer can draw a gap instead of a cold cell,
 * which would read as a real zero.
 */
export function heatmapCells(values: Array<Array<number | null>>, plot: Plot): HeatmapCell[] {
  const box = area(plot)
  const rows = values.length
  const columns = values.reduce((widest, row) => Math.max(widest, row.length), 0)
  if (rows === 0 || columns === 0) return []

  const finite: number[] = []
  for (const row of values) {
    for (const value of row) if (isNumber(value)) finite.push(value)
  }
  const min = finite.length ? Math.min(...finite) : 0
  const max = finite.length ? Math.max(...finite) : 0
  // A grid with no variation carries no ranking; mid intensity says "uniform"
  // where 0 would falsely say "all at the floor".
  const intensityFor = (value: number) => (max > min ? (value - min) / (max - min) : 0.5)

  const cells: HeatmapCell[] = []
  for (let row = 0; row < rows; row += 1) {
    // Edges are derived from the fraction rather than accumulated, so adjacent
    // cells share an edge exactly instead of drifting apart by a rounding step.
    const yTop = box.top + (row / rows) * box.height
    const yBottom = box.top + ((row + 1) / rows) * box.height
    for (let column = 0; column < columns; column += 1) {
      const xLeft = box.left + (column / columns) * box.width
      const xRight = box.left + ((column + 1) / columns) * box.width
      const value = values[row][column]
      cells.push({
        row,
        column,
        x: xLeft,
        y: yTop,
        width: xRight - xLeft,
        height: yBottom - yTop,
        intensity: isNumber(value) ? intensityFor(value) : null,
      })
    }
  }
  return cells
}

export interface StackSegment {
  key: string
  y: number
  height: number
  value: number
}

/**
 * Segments of one stacked column, laid out from the baseline upwards in the
 * order given. `total` is the value that fills the plot height, so a stack that
 * falls short leaves head room rather than being rescaled to look complete.
 *
 * A null (or negative, or non-finite) segment is omitted entirely and
 * contributes nothing to the running sum, so the segments after it keep their
 * places in the stack instead of being pushed off the top.
 */
export function stackSegments(
  values: Array<{ key: string; value: number | null }>,
  total: number,
  plot: Plot,
): StackSegment[] {
  const box = area(plot)
  if (!Number.isFinite(total) || total <= 0) return []

  const segments: StackSegment[] = []
  let consumed = 0
  for (const entry of values) {
    if (!isNumber(entry.value) || entry.value < 0) continue
    const start = consumed
    // Clamped so an over-full stack stops at the top of the plot instead of
    // drawing outside it.
    const end = Math.min(total, consumed + entry.value)
    consumed = end
    const yBottom = box.bottom - (start / total) * box.height
    const yTop = box.bottom - (end / total) * box.height
    segments.push({
      key: entry.key,
      y: yTop,
      height: Math.max(0, yBottom - yTop),
      value: entry.value,
    })
  }
  return segments
}

function coordinate(value: number) {
  return value.toFixed(2)
}

/**
 * A closed band: the upper edge left-to-right, the lower edge right-to-left,
 * then `Z`. A null on either edge ends the current subpath and a new one starts
 * after the gap — bridging it would draw a band across data that was never
 * recorded. Returns '' when no column has both edges.
 */
export function bandPath(
  upper: Array<number | null>,
  lower: Array<number | null>,
  domain: { min: number; max: number },
  plot: Plot,
): string {
  const box = area(plot)
  const count = Math.min(upper.length, lower.length)
  if (count === 0) return ''

  const yFor = (value: number) =>
    clamp(scale(domain.max - value, 0, domain.max - domain.min, box.top, box.height), box.top, box.bottom)

  const runs: number[][] = []
  let run: number[] = []
  for (let index = 0; index < count; index += 1) {
    if (isNumber(upper[index]) && isNumber(lower[index])) {
      run.push(index)
      continue
    }
    if (run.length) runs.push(run)
    run = []
  }
  if (run.length) runs.push(run)
  if (!runs.length) return ''

  return runs
    .map((indexes) => {
      const xs = indexes.map((index) => columnCentre(index, count, box))
      const tops = indexes.map((index) => yFor(upper[index] as number))
      const bottoms = indexes.map((index) => yFor(lower[index] as number))
      const forward = indexes.map((_, position) =>
        `${position === 0 ? 'M' : 'L'} ${coordinate(xs[position])} ${coordinate(tops[position])}`)
      const back = indexes
        .map((_, position) => `L ${coordinate(xs[position])} ${coordinate(bottoms[position])}`)
        .reverse()
      return `${[...forward, ...back].join(' ')} Z`
    })
    .join(' ')
}

export interface DivergingBar {
  index: number
  x: number
  y: number
  width: number
  height: number
  sign: 1 | -1 | 0
}

/**
 * Columns growing away from a zero baseline. The domain always includes zero
 * and reaches only as far as the data, so the baseline sits mid-plot for a
 * symmetric spread and at the edge when every reading falls on one side.
 *
 * A missing reading produces no bar at all — a zero-height bar at the baseline
 * is indistinguishable from a genuine zero.
 */
export function divergingLayout(values: Array<number | null>, plot: Plot): { zeroY: number; bars: DivergingBar[] } {
  const box = area(plot)
  const finite = values.filter(isNumber)
  const domainMin = Math.min(0, ...finite)
  const domainMax = Math.max(0, ...finite)
  const yFor = (value: number) => scale(domainMax - value, 0, domainMax - domainMin, box.top, box.height)
  const zeroY = yFor(0)

  const count = values.length
  const slot = count > 0 ? box.width / count : 0
  const barWidth = Math.max(1, Math.min(26, slot * 0.62))

  const bars: DivergingBar[] = []
  values.forEach((value, index) => {
    if (!isNumber(value)) return
    const edge = yFor(value)
    const sign: 1 | -1 | 0 = value > 0 ? 1 : value < 0 ? -1 : 0
    bars.push({
      index,
      x: box.left + index * slot + (slot - barWidth) / 2,
      y: Math.min(edge, zeroY),
      height: Math.abs(edge - zeroY),
      width: barWidth,
      sign,
    })
  })
  return { zeroY, bars }
}
