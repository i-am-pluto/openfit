import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { formatNumber } from '../lib/format'
import type { CorrelationResult } from '../lib/metric-analysis'
import {
  CHART_MARGIN,
  bandPath,
  createPlot,
  divergingLayout,
  heatmapCells,
  regressionLine,
  scatterPositions,
  stackSegments,
} from './analysis-chart-geometry'
import type { Plot } from './analysis-chart-geometry'

// The analysis charts. Every coordinate in this file comes from
// `analysis-chart-geometry.ts`, which is the part under test; nothing here
// re-derives a position with its own arithmetic.
//
// Two conventions carry through all five components, both inherited from
// `Charts.tsx`:
//   * A missing reading is a gap — graphite at 0.3 opacity, hatched, labelled
//     "no data" — never a bar of height zero, which reads as a real zero.
//   * Color never carries meaning alone. Every color-coded distinction is also
//     a label, a position, or a pattern.

const MISSING_OPACITY = 0.3

function isNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
}

/** Copied from `Charts.tsx` so this file can be added without touching that one. */
function useResponsiveChartWidth(active: boolean) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!active || !container) return

    const updateWidth = (nextWidth: number) => {
      if (nextWidth > 0) setWidth(Math.max(240, Math.round(nextWidth)))
    }
    updateWidth(container.getBoundingClientRect().width)

    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width
      if (nextWidth) updateWidth(nextWidth)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [active])

  return { containerRef, width }
}

/**
 * The screen-reader table pattern from `Charts.tsx`, widened to more than one
 * value column so a scatter point, a heat-map row, or a stack can each list
 * every number the marks encode.
 */
function AccessibleChartTable({
  title,
  rowHeader,
  columns,
  rows,
}: {
  title: string
  rowHeader: string
  columns: string[]
  rows: Array<{ label: string; cells: string[] }>
}) {
  return (
    <table className="sr-only chart-data-table">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">{rowHeader}</th>
          {columns.map((column, index) => <th key={`${column}-${index}`} scope="col">{column}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.label}-${index}`}>
            <th scope="row">{row.label}</th>
            {row.cells.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The hover/focus read-out, reusing `.chart-tooltip` from the existing charts. */
function ChartTooltip({
  x,
  y,
  width,
  height,
  label,
  value,
}: {
  x: number
  y: number
  width: number
  height: number
  label: string
  value: string
}) {
  return (
    <div
      className="chart-tooltip"
      style={{ left: `clamp(52px, ${(x / Math.max(1, width)) * 100}%, calc(100% - 52px))`, top: `${(y / Math.max(1, height)) * 100}%` }}
      role="status"
    >
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

/**
 * The fill every missing mark uses: graphite hatching, so a gap is still a gap
 * to a reader who cannot separate it from a filled cell by color.
 */
function NoDataHatch({ id }: { id: string }) {
  return (
    <pattern id={id} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="7" height="7" fill="var(--color-graphite)" />
      <line x1="0" y1="0" x2="0" y2="7" stroke="var(--color-slate)" strokeWidth="2.2" />
    </pattern>
  )
}

function useHatchId() {
  return `no-data-${useId().replace(/:/g, '')}`
}

function ChartLegend({ children }: { children: ReactNode }) {
  return <ul className="chart-key">{children}</ul>
}

function LegendSwatch({ fill, dashed = false, label }: { fill: string; dashed?: boolean; label: string }) {
  return (
    <li>
      <span className={`chart-key-swatch ${dashed ? 'is-dashed' : ''}`} style={{ background: fill }} aria-hidden="true" />
      <span>{label}</span>
    </li>
  )
}

function plotBox(plot: Plot) {
  return {
    left: plot.margin.left,
    top: plot.margin.top,
    right: plot.width - plot.margin.right,
    bottom: plot.height - plot.margin.bottom,
    width: Math.max(0, plot.width - plot.margin.left - plot.margin.right),
    height: Math.max(0, plot.height - plot.margin.top - plot.margin.bottom),
  }
}

/**
 * Where a value sits on a fixed domain, expressed through `stackSegments`: the
 * top of a stack `value - min` tall on a plot whose full height is the domain
 * span. That is the same mapping `bandPath` uses internally, so ticks and
 * markers land exactly on the band rather than near it.
 */
function valueY(value: number, domain: { min: number; max: number }, plot: Plot) {
  const box = plotBox(plot)
  const span = domain.max - domain.min
  if (!(span > 0)) return box.top + box.height / 2
  const [segment] = stackSegments([{ key: 'tick', value: value - domain.min }], span, plot)
  return segment ? segment.y : box.bottom
}

/**
 * The x centres a `bandPath` puts its columns on — first flush left, last flush
 * right, a lone column centred. `scatterPositions` over the indices produces
 * exactly that mapping, so markers sit on the band they annotate.
 */
function columnCentres(count: number, plot: Plot) {
  if (count <= 0) return []
  return scatterPositions(Array.from({ length: count }, (_, index) => ({ x: index, y: 0 })), plot).map((point) => point.cx)
}

/** Evenly divided lanes across the plot, from a single-row heat map. */
function laneRects(count: number, plot: Plot) {
  if (count <= 0) return []
  return heatmapCells([Array.from({ length: count }, () => 1)], plot).map((cell) => ({ x: cell.x, width: cell.width }))
}

function labelStride(count: number, maximum = 7) {
  return Math.max(1, Math.ceil(count / maximum))
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

export interface ScatterPoint {
  x: number
  y: number
  label: string
}

export function ScatterChart({
  points,
  xLabel,
  yLabel,
  correlation,
  ariaLabel = 'Scatter plot',
  height = 260,
  formatX = (value: number) => formatNumber(value),
  formatY = (value: number) => formatNumber(value),
}: {
  points: ScatterPoint[]
  xLabel: string
  yLabel: string
  correlation: CorrelationResult | null
  ariaLabel?: string
  height?: number
  formatX?: (value: number) => string
  formatY?: (value: number) => string
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  // `scatterPositions` drops non-finite points, so the pairing of label to
  // position only holds if the same filter is applied here first.
  const plotted = points.filter((point) => isNumber(point.x) && isNumber(point.y))
  const missingCount = points.length - plotted.length
  const { containerRef, width } = useResponsiveChartWidth(plotted.length > 0)

  const table = (
    <AccessibleChartTable
      title={ariaLabel}
      rowHeader="Observation"
      columns={[xLabel, yLabel]}
      rows={points.map((point, index) => ({
        label: point.label || `Point ${index + 1}`,
        cells: [isNumber(point.x) ? formatX(point.x) : 'No data', isNumber(point.y) ? formatY(point.y) : 'No data'],
      }))}
    />
  )
  if (!plotted.length) {
    return (
      <div className="scatter-chart">
        <div className="chart-empty" style={{ height }}>No paired readings for this range</div>
        {table}
      </div>
    )
  }

  const plot = createPlot(width, height, CHART_MARGIN)
  const box = plotBox(plot)
  // The line is drawn only under an `r` the engine was willing to compute. A
  // fit under a refused correlation would assert a relationship that the
  // analysis explicitly found insufficient.
  const fit = correlation === null ? null : regressionLine(plotted)
  // One call, one domain: the dots and the fitted endpoints are scaled
  // together so the line cannot drift off the cloud it describes.
  const laid = fit ? [...plotted, fit.from, fit.to] : plotted
  const positions = scatterPositions(laid, plot)
  const dots = positions.slice(0, plotted.length)
  const fitEnds = fit ? positions.slice(plotted.length) : []
  const xs = laid.map((point) => point.x)
  const ys = laid.map((point) => point.y)
  const domainX = { min: Math.min(...xs), max: Math.max(...xs) }
  const domainY = { min: Math.min(...ys), max: Math.max(...ys) }
  const correlationText = correlation
    ? `r = ${correlation.r.toFixed(2)} over ${correlation.sampleCount} paired readings`
    : 'No correlation reported — too few paired readings, or no variation to correlate'
  const active = activeIndex === null ? null : plotted[activeIndex]

  return (
    <div className="scatter-chart" ref={containerRef}>
      <div className="scatter-chart-plot" style={{ height }}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} onPointerLeave={() => setActiveIndex(null)}>
          <title>{ariaLabel}</title>
          <desc>{`${plotted.length} points of ${yLabel} against ${xLabel}. ${correlationText}.`}</desc>
          {[domainY.max, domainY.min].map((tick, index) => {
            const y = index === 0 ? box.top : box.bottom
            return (
              <g key={`y-${index}`}>
                <line x1={box.left} y1={y} x2={box.right} y2={y} className="chart-gridline" />
                <text x={box.left - 9} y={y + 3} textAnchor="end" className="chart-tick">{formatY(tick)}</text>
              </g>
            )
          })}
          <text x={box.left} y={box.bottom + 16} textAnchor="start" className="chart-tick">{formatX(domainX.min)}</text>
          <text x={box.right} y={box.bottom + 16} textAnchor="end" className="chart-tick">{formatX(domainX.max)}</text>
          <text x={box.left + box.width / 2} y={height - 3} textAnchor="middle" className="chart-label">{xLabel}</text>
          <text x={13} y={box.top + box.height / 2} textAnchor="middle" className="chart-label" transform={`rotate(-90 13 ${box.top + box.height / 2})`}>{yLabel}</text>
          {fit && fitEnds.length === 2 && (
            <line
              x1={fitEnds[0].cx}
              y1={fitEnds[0].cy}
              x2={fitEnds[1].cx}
              y2={fitEnds[1].cy}
              stroke="var(--color-amber)"
              strokeWidth={2}
              strokeDasharray="7 5"
              strokeLinecap="round"
            >
              <title>{`Best fit: ${correlationText}`}</title>
            </line>
          )}
          {dots.map((position, index) => {
            const point = plotted[index]
            const description = `${point.label || `Point ${index + 1}`}: ${xLabel} ${formatX(point.x)}, ${yLabel} ${formatY(point.y)}`
            return (
              <circle
                key={`${point.label}-${index}`}
                cx={position.cx}
                cy={position.cy}
                r={activeIndex === index ? 6 : 4.4}
                fill="var(--color-indigo)"
                fillOpacity={activeIndex === null || activeIndex === index ? 0.88 : 0.36}
                stroke="var(--card)"
                strokeWidth={1.4}
                className="chart-column-mark"
                tabIndex={0}
                aria-label={description}
                onPointerEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
              >
                <title>{description}</title>
              </circle>
            )
          })}
        </svg>
        {active && activeIndex !== null && dots[activeIndex] && (
          <ChartTooltip
            x={dots[activeIndex].cx}
            y={dots[activeIndex].cy}
            width={width}
            height={height}
            label={active.label || `Point ${activeIndex + 1}`}
            value={`${formatX(active.x)} · ${formatY(active.y)}`}
          />
        )}
      </div>
      <div className="scatter-chart-readout">
        <p className={`chart-note ${correlation ? 'is-strong' : ''}`}>{correlationText}</p>
        {fit && <p className="chart-note">Dashed line: least-squares fit across the plotted readings.</p>}
        {missingCount > 0 && <p className="chart-note">{`${missingCount} of ${points.length} readings have no data on one axis and are not plotted.`}</p>}
      </div>
      {table}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Heat map
// ---------------------------------------------------------------------------

export function HeatmapGrid({
  rows,
  columns,
  values,
  formatter = (value: number) => formatNumber(value),
  ariaLabel = 'Values by row and column',
  height,
}: {
  rows: string[]
  columns: string[]
  values: Array<Array<number | null>>
  formatter?: (value: number) => string
  ariaLabel?: string
  height?: number
}) {
  const [active, setActive] = useState<{ row: number; column: number } | null>(null)
  const hatchId = useHatchId()
  const chartHeight = height ?? Math.max(140, rows.length * 30 + CHART_MARGIN.top + CHART_MARGIN.bottom)
  const hasGrid = rows.length > 0 && columns.length > 0
  const { containerRef, width } = useResponsiveChartWidth(hasGrid)

  const table = (
    <AccessibleChartTable
      title={ariaLabel}
      rowHeader="Row"
      columns={columns}
      rows={rows.map((row, rowIndex) => ({
        label: row,
        cells: columns.map((_, columnIndex) => {
          const value = values[rowIndex]?.[columnIndex] ?? null
          return isNumber(value) ? formatter(value) : 'No data'
        }),
      }))}
    />
  )
  if (!hasGrid) {
    return (
      <div className="heatmap-grid">
        <div className="chart-empty" style={{ height: chartHeight }}>No data for this range</div>
        {table}
      </div>
    )
  }

  const plot = createPlot(width, chartHeight, CHART_MARGIN)
  const cells = heatmapCells(values, plot)
  const finite = values.flat().filter(isNumber)
  const lowest = finite.length ? Math.min(...finite) : null
  const highest = finite.length ? Math.max(...finite) : null
  const stride = labelStride(columns.length, 8)
  const activeCell = active ? cells.find((cell) => cell.row === active.row && cell.column === active.column) : undefined
  const activeValue = active ? values[active.row]?.[active.column] ?? null : null

  return (
    <div className="heatmap-grid" ref={containerRef}>
      <div className="heatmap-grid-plot" style={{ height: chartHeight }}>
        <svg viewBox={`0 0 ${width} ${chartHeight}`} role="img" aria-label={ariaLabel} onPointerLeave={() => setActive(null)}>
          <title>{ariaLabel}</title>
          <desc>
            {finite.length
              ? `${rows.length} rows by ${columns.length} columns, from ${formatter(lowest as number)} to ${formatter(highest as number)}. Missing readings are hatched.`
              : `${rows.length} rows by ${columns.length} columns, none of which was recorded.`}
          </desc>
          <defs><NoDataHatch id={hatchId} /></defs>
          {cells.map((cell) => {
            const label = `${rows[cell.row] ?? `Row ${cell.row + 1}`}, ${columns[cell.column] ?? `Column ${cell.column + 1}`}`
            const value = values[cell.row]?.[cell.column] ?? null
            const description = isNumber(value) ? `${label}: ${formatter(value)}` : `${label}: no data`
            const isActive = active?.row === cell.row && active?.column === cell.column
            const showValue = isNumber(value) && cell.width >= 34 && cell.height >= 17
            return (
              <g key={`${cell.row}-${cell.column}`}>
                <rect
                  x={cell.x}
                  y={cell.y}
                  width={Math.max(0, cell.width - 1.5)}
                  height={Math.max(0, cell.height - 1.5)}
                  rx={3}
                  fill={cell.intensity === null ? `url(#${hatchId})` : 'var(--color-indigo)'}
                  fillOpacity={cell.intensity === null ? MISSING_OPACITY : 0.14 + cell.intensity * 0.78}
                  stroke={isActive ? 'var(--foreground)' : 'transparent'}
                  strokeWidth={1.5}
                  className="chart-column-mark"
                  tabIndex={0}
                  aria-label={description}
                  onPointerEnter={() => setActive({ row: cell.row, column: cell.column })}
                  onFocus={() => setActive({ row: cell.row, column: cell.column })}
                  onBlur={() => setActive(null)}
                >
                  <title>{description}</title>
                </rect>
                {showValue && (
                  <text
                    x={cell.x + cell.width / 2}
                    y={cell.y + cell.height / 2 + 4}
                    textAnchor="middle"
                    className="heatmap-cell-value"
                    aria-hidden="true"
                  >
                    {formatter(value as number)}
                  </text>
                )}
              </g>
            )
          })}
          {rows.map((row, index) => {
            const cell = cells.find((candidate) => candidate.row === index && candidate.column === 0)
            if (!cell) return null
            return (
              <text key={`${row}-${index}`} x={CHART_MARGIN.left - 9} y={cell.y + cell.height / 2 + 4} textAnchor="end" className="chart-label">{row}</text>
            )
          })}
          {columns.map((column, index) => {
            if (index % stride !== 0 && index !== columns.length - 1) return null
            const cell = cells.find((candidate) => candidate.row === 0 && candidate.column === index)
            if (!cell) return null
            return (
              <text key={`${column}-${index}`} x={cell.x + cell.width / 2} y={chartHeight - 9} textAnchor="middle" className="chart-label">{column}</text>
            )
          })}
        </svg>
        {activeCell && (
          <ChartTooltip
            x={activeCell.x + activeCell.width / 2}
            y={activeCell.y}
            width={width}
            height={chartHeight}
            label={`${rows[activeCell.row] ?? ''} · ${columns[activeCell.column] ?? ''}`}
            value={isNumber(activeValue) ? formatter(activeValue) : 'No data'}
          />
        )}
      </div>
      <ChartLegend>
        <LegendSwatch fill="color-mix(in srgb, var(--color-indigo) 18%, transparent)" label={`Lowest${lowest === null ? '' : ` · ${formatter(lowest)}`}`} />
        <LegendSwatch fill="color-mix(in srgb, var(--color-indigo) 92%, transparent)" label={`Highest${highest === null ? '' : ` · ${formatter(highest)}`}`} />
        <LegendSwatch fill="var(--color-graphite)" dashed label="No data" />
      </ChartLegend>
      {table}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stacked bars
// ---------------------------------------------------------------------------

export interface StackedSegment {
  key: string
  label: string
  value: number | null
  color: string
}

export interface StackedCategory {
  label: string
  segments: StackedSegment[]
}

export function StackedBarChart({
  categories,
  ariaLabel = 'Composition by period',
  height = 240,
  formatter = (value: number) => formatNumber(value),
}: {
  categories: StackedCategory[]
  ariaLabel?: string
  height?: number
  formatter?: (value: number) => string
}) {
  const [active, setActive] = useState<{ category: number; key: string } | null>(null)
  const hatchId = useHatchId()
  const sums = categories.map((category) =>
    category.segments.reduce((total, segment) => (isNumber(segment.value) && segment.value >= 0 ? total + segment.value : total), 0))
  // One shared total, so the columns are comparable with one another rather
  // than each being rescaled to look full.
  const total = Math.max(0, ...sums)
  const hasData = categories.length > 0 && total > 0
  const { containerRef, width } = useResponsiveChartWidth(hasData)

  const legendKeys = new Map<string, { label: string; color: string }>()
  for (const category of categories) {
    for (const segment of category.segments) {
      if (!legendKeys.has(segment.key)) legendKeys.set(segment.key, { label: segment.label, color: segment.color })
    }
  }
  const table = (
    <AccessibleChartTable
      title={ariaLabel}
      rowHeader="Period"
      columns={[...[...legendKeys.values()].map((entry) => entry.label), 'Total']}
      rows={categories.map((category, index) => ({
        label: category.label,
        cells: [
          ...[...legendKeys.keys()].map((key) => {
            const segment = category.segments.find((candidate) => candidate.key === key)
            return segment && isNumber(segment.value) ? formatter(segment.value) : 'No data'
          }),
          formatter(sums[index]),
        ],
      }))}
    />
  )
  if (!hasData) {
    return (
      <div className="stacked-bar-chart">
        <div className="chart-empty" style={{ height }}>No data for this range</div>
        {table}
      </div>
    )
  }

  const plot = createPlot(width, height, CHART_MARGIN)
  const box = plotBox(plot)
  const lanes = laneRects(categories.length, plot)
  // The tick heights come from the stack layout itself rather than a second
  // formula, so the gridlines cannot drift away from the segments.
  const [halfSegment, topSegment] = stackSegments(
    [{ key: 'lower', value: total / 2 }, { key: 'upper', value: total / 2 }],
    total,
    plot,
  )
  const ticks = [
    { value: 0, y: box.bottom },
    { value: total / 2, y: halfSegment ? halfSegment.y : box.bottom },
    { value: total, y: topSegment ? topSegment.y : box.top },
  ]
  const stride = labelStride(categories.length)
  let tooltip: ReactNode = null

  return (
    <div className="stacked-bar-chart" ref={containerRef}>
      <div className="stacked-bar-chart-plot" style={{ height }}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} onPointerLeave={() => setActive(null)}>
          <title>{ariaLabel}</title>
          <desc>{`${categories.length} periods, each split into ${legendKeys.size} parts, against a shared total of ${formatter(total)}.`}</desc>
          <defs><NoDataHatch id={hatchId} /></defs>
          {ticks.map((tick, index) => (
            <g key={`tick-${index}`}>
              <line x1={box.left} y1={tick.y} x2={box.right} y2={tick.y} className="chart-gridline" />
              <text x={box.left - 9} y={tick.y + 3} textAnchor="end" className="chart-tick">{formatter(tick.value)}</text>
            </g>
          ))}
          {categories.map((category, index) => {
            const lane = lanes[index]
            if (!lane) return null
            const barWidth = Math.max(3, Math.min(38, lane.width * 0.62))
            const x = lane.x + (lane.width - barWidth) / 2
            const byKey = new Map(category.segments.map((segment) => [segment.key, segment]))
            // `stackSegments` returns the base segment first and skips missing
            // values, so the drawn parts are matched back by key, never by
            // position in the input.
            const laid = stackSegments(category.segments.map((segment) => ({ key: segment.key, value: segment.value })), total, plot)
            if (!laid.length) {
              return (
                <rect
                  key={`${category.label}-${index}`}
                  x={x}
                  y={box.bottom - 5}
                  width={barWidth}
                  height={5}
                  fill={`url(#${hatchId})`}
                  opacity={MISSING_OPACITY}
                  className="chart-column-mark"
                  tabIndex={0}
                  aria-label={`${category.label}: no data`}
                >
                  <title>{`${category.label}: no data`}</title>
                </rect>
              )
            }
            return (
              <g key={`${category.label}-${index}`}>
                {laid.map((segment) => {
                  const source = byKey.get(segment.key)
                  const share = total > 0 ? Math.round((segment.value / total) * 100) : 0
                  const description = `${category.label}, ${source?.label ?? segment.key}: ${formatter(segment.value)} (${share}% of ${formatter(total)})`
                  const isActive = active?.category === index && active.key === segment.key
                  if (isActive) {
                    tooltip = (
                      <ChartTooltip
                        x={x + barWidth / 2}
                        y={segment.y}
                        width={width}
                        height={height}
                        label={`${category.label} · ${source?.label ?? segment.key}`}
                        value={`${formatter(segment.value)} · ${share}%`}
                      />
                    )
                  }
                  return (
                    <rect
                      key={segment.key}
                      x={x}
                      y={segment.y}
                      width={barWidth}
                      height={segment.height}
                      fill={source?.color ?? 'var(--color-indigo)'}
                      opacity={active === null || isActive ? 0.92 : 0.34}
                      className="chart-column-mark"
                      tabIndex={0}
                      aria-label={description}
                      onPointerEnter={() => setActive({ category: index, key: segment.key })}
                      onFocus={() => setActive({ category: index, key: segment.key })}
                      onBlur={() => setActive(null)}
                    >
                      <title>{description}</title>
                    </rect>
                  )
                })}
              </g>
            )
          })}
          {categories.map((category, index) => {
            const lane = lanes[index]
            if (!lane) return null
            if (index % stride !== 0 && index !== categories.length - 1) return null
            return (
              <text key={`label-${category.label}-${index}`} x={lane.x + lane.width / 2} y={height - 9} textAnchor="middle" className="chart-label">{category.label}</text>
            )
          })}
        </svg>
        {tooltip}
      </div>
      <ChartLegend>
        {[...legendKeys.entries()].map(([key, entry]) => <LegendSwatch key={key} fill={entry.color} label={entry.label} />)}
        <LegendSwatch fill="var(--color-graphite)" dashed label="No data" />
      </ChartLegend>
      {table}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Range band
// ---------------------------------------------------------------------------

export interface RangePoint {
  label: string
  value: number | null
  min: number | null
  max: number | null
}

export function RangeBandChart({
  points,
  band,
  ariaLabel = 'Range over time',
  height = 240,
  formatter = (value: number) => formatNumber(value),
}: {
  points: RangePoint[]
  band?: { mean: number; stdDev: number }
  ariaLabel?: string
  height?: number
  formatter?: (value: number) => string
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const hatchId = useHatchId()
  const baseline = band && isNumber(band.mean) && isNumber(band.stdDev) ? band : undefined
  const spread = [
    ...points.flatMap((point) => [point.value, point.min, point.max].filter(isNumber)),
    ...(baseline ? [baseline.mean - baseline.stdDev, baseline.mean + baseline.stdDev] : []),
  ]
  const hasData = points.length > 0 && spread.length > 0
  const { containerRef, width } = useResponsiveChartWidth(hasData)

  const table = (
    <AccessibleChartTable
      title={ariaLabel}
      rowHeader="Period"
      columns={['Value', 'Low', 'High']}
      rows={points.map((point, index) => ({
        label: point.label || `Point ${index + 1}`,
        cells: [point.value, point.min, point.max].map((value) => (isNumber(value) ? formatter(value) : 'No data')),
      }))}
    />
  )
  if (!hasData) {
    return (
      <div className="range-band-chart">
        <div className="chart-empty" style={{ height }}>No data for this range</div>
        {table}
      </div>
    )
  }

  const plot = createPlot(width, height, CHART_MARGIN)
  const box = plotBox(plot)
  const lowest = Math.min(...spread)
  const highest = Math.max(...spread)
  const pad = Math.max((highest - lowest) * 0.1, 0.5)
  const domain = { min: lowest - pad, max: highest + pad }
  const uppers = points.map((point) => (isNumber(point.max) ? point.max : null))
  const lowers = points.map((point) => (isNumber(point.min) ? point.min : null))
  const values = points.map((point) => (isNumber(point.value) ? point.value : null))
  const rangePath = bandPath(uppers, lowers, domain, plot)
  // A zero-width band traces the value series itself, so the line and the band
  // it sits inside come from one placement rule and break at the same gaps.
  const valuePath = bandPath(values, values, domain, plot)
  const baselinePath = baseline
    ? bandPath(points.map(() => baseline.mean + baseline.stdDev), points.map(() => baseline.mean - baseline.stdDev), domain, plot)
    : ''
  const centres = columnCentres(points.length, plot)
  const laneWidth = Math.max(6, box.width / Math.max(1, points.length))
  const ticks = [domain.max, (domain.max + domain.min) / 2, domain.min]
  const stride = labelStride(points.length)
  const active = activeIndex === null ? null : points[activeIndex]

  return (
    <div className="range-band-chart" ref={containerRef}>
      <div className="range-band-chart-plot" style={{ height }}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} onPointerLeave={() => setActiveIndex(null)}>
          <title>{ariaLabel}</title>
          <desc>
            {`Daily value with its low-to-high range across ${points.length} periods, from ${formatter(lowest)} to ${formatter(highest)}${baseline ? `, against a baseline of ${formatter(baseline.mean)} plus or minus ${formatter(baseline.stdDev)}` : ''}. Gaps are periods with no reading.`}
          </desc>
          <defs><NoDataHatch id={hatchId} /></defs>
          {ticks.map((tick, index) => {
            const y = valueY(tick, domain, plot)
            return (
              <g key={`tick-${index}`}>
                <line x1={box.left} y1={y} x2={box.right} y2={y} className="chart-gridline" />
                <text x={box.left - 9} y={y + 3} textAnchor="end" className="chart-tick">{formatter(tick)}</text>
              </g>
            )
          })}
          {baseline && baselinePath && (
            <path d={baselinePath} fill="var(--color-violet)" fillOpacity={0.12} stroke="var(--color-violet)" strokeWidth={1} strokeDasharray="6 4">
              <title>{`Baseline ±1 SD: ${formatter(baseline.mean)}`}</title>
            </path>
          )}
          {rangePath && <path d={rangePath} fill="var(--color-indigo)" fillOpacity={0.2} stroke="none" />}
          {valuePath && <path d={valuePath} fill="none" stroke="var(--color-indigo)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />}
          {points.map((point, index) => {
            const centre = centres[index]
            if (centre === undefined) return null
            const label = point.label || `Point ${index + 1}`
            if (!isNumber(point.value)) {
              const description = `${label}: no data`
              return (
                <rect
                  key={`${label}-${index}`}
                  x={centre - laneWidth * 0.3}
                  y={box.top}
                  width={laneWidth * 0.6}
                  height={box.height}
                  fill={`url(#${hatchId})`}
                  opacity={MISSING_OPACITY}
                  className="chart-column-mark"
                  tabIndex={0}
                  aria-label={description}
                  onPointerEnter={() => setActiveIndex(index)}
                  onFocus={() => setActiveIndex(index)}
                  onBlur={() => setActiveIndex(null)}
                >
                  <title>{description}</title>
                </rect>
              )
            }
            const range = isNumber(point.min) && isNumber(point.max) ? `, range ${formatter(point.min)} to ${formatter(point.max)}` : ', range not recorded'
            const description = `${label}: ${formatter(point.value)}${range}`
            return (
              <circle
                key={`${label}-${index}`}
                cx={centre}
                cy={valueY(point.value, domain, plot)}
                r={activeIndex === index ? 5.5 : 3.6}
                fill="var(--card)"
                stroke="var(--color-indigo)"
                strokeWidth={2}
                className="chart-column-mark"
                tabIndex={0}
                aria-label={description}
                onPointerEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
              >
                <title>{description}</title>
              </circle>
            )
          })}
          {points.map((point, index) => {
            const centre = centres[index]
            if (centre === undefined) return null
            if (index % stride !== 0 && index !== points.length - 1) return null
            return <text key={`label-${index}`} x={centre} y={height - 9} textAnchor="middle" className="chart-label">{point.label}</text>
          })}
        </svg>
        {active && activeIndex !== null && centres[activeIndex] !== undefined && (
          <ChartTooltip
            x={centres[activeIndex]}
            y={isNumber(active.value) ? valueY(active.value, domain, plot) : box.top}
            width={width}
            height={height}
            label={active.label || `Point ${activeIndex + 1}`}
            value={isNumber(active.value)
              ? `${formatter(active.value)}${isNumber(active.min) && isNumber(active.max) ? ` · ${formatter(active.min)}–${formatter(active.max)}` : ''}`
              : 'No data'}
          />
        )}
      </div>
      <ChartLegend>
        <LegendSwatch fill="var(--color-indigo)" label="Value" />
        <LegendSwatch fill="color-mix(in srgb, var(--color-indigo) 30%, transparent)" label="Low to high range" />
        {baseline && <LegendSwatch fill="color-mix(in srgb, var(--color-violet) 30%, transparent)" dashed label={`Baseline ±1 SD · ${formatter(baseline.mean)}`} />}
        <LegendSwatch fill="var(--color-graphite)" dashed label="No data" />
      </ChartLegend>
      {table}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Diverging columns
// ---------------------------------------------------------------------------

export function DivergingColumnChart({
  values,
  labels,
  positiveLabel,
  negativeLabel,
  formatter = (value: number) => formatNumber(value),
  ariaLabel = 'Change against a zero baseline',
  height = 240,
}: {
  values: Array<number | null>
  labels: string[]
  positiveLabel: string
  negativeLabel: string
  formatter?: (value: number) => string
  ariaLabel?: string
  height?: number
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const hatchId = useHatchId()
  const finite = values.filter(isNumber)
  const { containerRef, width } = useResponsiveChartWidth(finite.length > 0)

  const nameOf = (index: number) => labels[index] ?? `Period ${index + 1}`
  const table = (
    <AccessibleChartTable
      title={ariaLabel}
      rowHeader="Period"
      columns={['Value', 'Direction']}
      rows={values.map((value, index) => ({
        label: nameOf(index),
        cells: isNumber(value)
          ? [formatter(value), value > 0 ? positiveLabel : value < 0 ? negativeLabel : 'At the baseline']
          : ['No data', 'No data'],
      }))}
    />
  )
  if (!finite.length) {
    return (
      <div className="diverging-column-chart">
        <div className="chart-empty" style={{ height }}>No data for this range</div>
        {table}
      </div>
    )
  }

  const plot = createPlot(width, height, CHART_MARGIN)
  const box = plotBox(plot)
  const { zeroY, bars } = divergingLayout(values, plot)
  // The domain always contains zero, so substituting zero for the gaps leaves
  // the baseline and every bar exactly where they were: this second pass is
  // only for the lane a missing reading would have occupied.
  const lanes = divergingLayout(values.map((value) => (isNumber(value) ? value : 0)), plot).bars
  const laneAt = new Map(lanes.map((bar) => [bar.index, bar]))
  const stride = labelStride(values.length)
  const highest = Math.max(...finite)
  const lowest = Math.min(...finite)
  const activeBar = activeIndex === null ? null : bars.find((bar) => bar.index === activeIndex) ?? null
  const activeValue = activeIndex === null ? null : values[activeIndex]

  return (
    <div className="diverging-column-chart" ref={containerRef}>
      <div className="diverging-column-chart-plot" style={{ height }}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} onPointerLeave={() => setActiveIndex(null)}>
          <title>{ariaLabel}</title>
          <desc>{`${bars.length} of ${values.length} periods recorded, from ${formatter(lowest)} to ${formatter(highest)}. Bars above the baseline are ${positiveLabel.toLowerCase()}; bars below it are ${negativeLabel.toLowerCase()}.`}</desc>
          <defs><NoDataHatch id={hatchId} /></defs>
          <line x1={box.left} y1={zeroY} x2={box.right} y2={zeroY} className="chart-baseline" />
          <text x={box.right} y={zeroY - 6} textAnchor="end" className="chart-tick">{`0 · ${positiveLabel} above`}</text>
          <text x={box.right} y={zeroY + 15} textAnchor="end" className="chart-tick">{`${negativeLabel} below`}</text>
          {values.map((value, index) => {
            if (isNumber(value)) return null
            const lane = laneAt.get(index)
            if (!lane) return null
            const description = `${nameOf(index)}: no data`
            return (
              <rect
                key={`missing-${index}`}
                x={lane.x}
                y={zeroY - 4}
                width={lane.width}
                height={8}
                fill={`url(#${hatchId})`}
                opacity={MISSING_OPACITY}
                className="chart-column-mark"
                tabIndex={0}
                aria-label={description}
                onPointerEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
              >
                <title>{description}</title>
              </rect>
            )
          })}
          {bars.map((bar) => {
            const value = values[bar.index] as number
            const direction = bar.sign > 0 ? positiveLabel : bar.sign < 0 ? negativeLabel : 'at the baseline'
            const description = `${nameOf(bar.index)}: ${formatter(value)}, ${direction}`
            const isActive = activeIndex === bar.index
            return (
              <rect
                key={`bar-${bar.index}`}
                x={bar.x}
                y={bar.sign === 0 ? zeroY - 1 : bar.y}
                width={bar.width}
                height={bar.sign === 0 ? 2 : bar.height}
                rx={Math.min(3, bar.width / 3)}
                fill={bar.sign < 0 ? 'var(--color-crimson)' : 'var(--color-emerald)'}
                opacity={activeIndex === null || isActive ? 0.92 : 0.34}
                className="chart-column-mark"
                tabIndex={0}
                aria-label={description}
                onPointerEnter={() => setActiveIndex(bar.index)}
                onFocus={() => setActiveIndex(bar.index)}
                onBlur={() => setActiveIndex(null)}
              >
                <title>{description}</title>
              </rect>
            )
          })}
          {values.map((_, index) => {
            const lane = laneAt.get(index)
            if (!lane) return null
            if (index % stride !== 0 && index !== values.length - 1) return null
            return <text key={`label-${index}`} x={lane.x + lane.width / 2} y={height - 9} textAnchor="middle" className="chart-label">{nameOf(index)}</text>
          })}
        </svg>
        {activeIndex !== null && (
          <ChartTooltip
            x={((lane) => (lane ? lane.x + lane.width / 2 : box.left))(activeBar ?? laneAt.get(activeIndex))}
            y={activeBar ? Math.min(activeBar.y, zeroY) : zeroY}
            width={width}
            height={height}
            label={nameOf(activeIndex)}
            value={isNumber(activeValue)
              ? `${formatter(activeValue)} · ${activeValue > 0 ? positiveLabel : activeValue < 0 ? negativeLabel : 'baseline'}`
              : 'No data'}
          />
        )}
      </div>
      <ChartLegend>
        <LegendSwatch fill="var(--color-emerald)" label={`${positiveLabel} (above the baseline)`} />
        <LegendSwatch fill="var(--color-crimson)" label={`${negativeLabel} (below the baseline)`} />
        <LegendSwatch fill="var(--color-graphite)" dashed label="No data" />
      </ChartLegend>
      {table}
    </div>
  )
}
