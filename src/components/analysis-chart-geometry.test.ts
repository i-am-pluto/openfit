import { describe, expect, it } from 'vitest'
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

const plot: Plot = createPlot(400, 200)
const left = CHART_MARGIN.left
const right = 400 - CHART_MARGIN.right
const top = CHART_MARGIN.top
const bottom = 200 - CHART_MARGIN.bottom
const innerWidth = right - left
const innerHeight = bottom - top

function pathNumbers(path: string) {
  return path
    .split(/[^0-9eE+.-]+/)
    .filter((token) => token.length > 0)
    .map(Number)
}

describe('regressionLine', () => {
  it('recovers a known slope and intercept from collinear points', () => {
    const line = regressionLine([
      { x: 0, y: 2 },
      { x: 1, y: 5 },
      { x: 2, y: 8 },
      { x: 3, y: 11 },
    ])
    expect(line).not.toBeNull()
    expect(line?.slope).toBeCloseTo(3, 10)
    expect(line?.intercept).toBeCloseTo(2, 10)
  })

  it('fits the least-squares line through a scattered cloud', () => {
    const line = regressionLine([
      { x: 1, y: 1 },
      { x: 2, y: 3 },
      { x: 3, y: 2 },
      { x: 4, y: 5 },
      { x: 5, y: 4 },
    ])
    expect(line?.slope).toBeCloseTo(0.8, 10)
    expect(line?.intercept).toBeCloseTo(0.6, 10)
  })

  it('returns null below two points', () => {
    expect(regressionLine([])).toBeNull()
    expect(regressionLine([{ x: 1, y: 1 }])).toBeNull()
  })

  it('returns null when every x is identical', () => {
    expect(regressionLine([
      { x: 4, y: 1 },
      { x: 4, y: 9 },
      { x: 4, y: 5 },
    ])).toBeNull()
  })

  it('returns null when fewer than two points are finite', () => {
    expect(regressionLine([
      { x: 1, y: 1 },
      { x: Number.NaN, y: 4 },
      { x: 3, y: Number.POSITIVE_INFINITY },
    ])).toBeNull()
  })

  it('puts its endpoints at the minimum and maximum x regardless of input order', () => {
    const line = regressionLine([
      { x: 7, y: 23 },
      { x: -2, y: -4 },
      { x: 3, y: 11 },
    ])
    expect(line?.from.x).toBe(-2)
    expect(line?.to.x).toBe(7)
    expect(line?.from.y).toBeCloseTo((line?.slope ?? 0) * -2 + (line?.intercept ?? 0), 10)
    expect(line?.to.y).toBeCloseTo((line?.slope ?? 0) * 7 + (line?.intercept ?? 0), 10)
  })
})

describe('scatterPositions', () => {
  const points = [
    { x: 0, y: 10 },
    { x: 5, y: 30 },
    { x: 10, y: 20 },
  ]

  it('maps the domain minimum to the left inset and the maximum to the right inset', () => {
    const positions = scatterPositions(points, plot)
    expect(positions).toHaveLength(3)
    expect(positions[0].cx).toBeCloseTo(left, 10)
    expect(positions[2].cx).toBeCloseTo(right, 10)
    expect(positions[1].cx).toBeCloseTo(left + innerWidth / 2, 10)
  })

  it('inverts y so the largest value sits highest', () => {
    const positions = scatterPositions(points, plot)
    expect(positions[1].cy).toBeCloseTo(top, 10)
    expect(positions[0].cy).toBeCloseTo(bottom, 10)
    expect(positions[2].cy).toBeLessThan(positions[0].cy)
    expect(positions[2].cy).toBeGreaterThan(positions[1].cy)
  })

  it('centres a degenerate domain instead of dividing by zero', () => {
    const positions = scatterPositions([
      { x: 4, y: 9 },
      { x: 4, y: 9 },
    ], plot)
    for (const position of positions) {
      expect(position.cx).toBeCloseTo(left + innerWidth / 2, 10)
      expect(position.cy).toBeCloseTo(top + innerHeight / 2, 10)
    }
  })

  it('keeps every coordinate finite for a single point and a zero-width plot', () => {
    const single = scatterPositions([{ x: 1, y: 1 }], plot)
    expect(single).toHaveLength(1)
    expect(Number.isFinite(single[0].cx)).toBe(true)
    expect(Number.isFinite(single[0].cy)).toBe(true)

    const flat = scatterPositions(points, createPlot(10, 10))
    for (const position of flat) {
      expect(Number.isFinite(position.cx)).toBe(true)
      expect(Number.isFinite(position.cy)).toBe(true)
    }
  })

  it('drops points that are not finite rather than emitting NaN coordinates', () => {
    const positions = scatterPositions([
      { x: 0, y: 1 },
      { x: Number.NaN, y: 2 },
      { x: 2, y: 3 },
    ], plot)
    expect(positions).toHaveLength(2)
    for (const position of positions) {
      expect(Number.isFinite(position.cx)).toBe(true)
      expect(Number.isFinite(position.cy)).toBe(true)
    }
  })
})

describe('heatmapCells', () => {
  const grid = [
    [0, 5, 10],
    [2, null, 8],
  ]

  it('produces rows * columns cells addressed by row and column', () => {
    const cells = heatmapCells(grid, plot)
    expect(cells).toHaveLength(6)
    expect(cells.map((cell) => `${cell.row}:${cell.column}`)).toEqual([
      '0:0', '0:1', '0:2', '1:0', '1:1', '1:2',
    ])
  })

  it('tiles the plot area contiguously with no overlap or gap', () => {
    const cells = heatmapCells(grid, plot)
    expect(cells[0].x).toBeCloseTo(left, 10)
    expect(cells[0].y).toBeCloseTo(top, 10)
    for (const cell of cells) {
      expect(cell.width).toBeCloseTo(innerWidth / 3, 10)
      expect(cell.height).toBeCloseTo(innerHeight / 2, 10)
    }
    expect(cells[0].x + cells[0].width).toBeCloseTo(cells[1].x, 10)
    expect(cells[1].x + cells[1].width).toBeCloseTo(cells[2].x, 10)
    expect(cells[2].x + cells[2].width).toBeCloseTo(right, 10)
    expect(cells[0].y + cells[0].height).toBeCloseTo(cells[3].y, 10)
    expect(cells[3].y + cells[3].height).toBeCloseTo(bottom, 10)
  })

  it('normalizes intensity to [0, 1] across the whole grid', () => {
    const cells = heatmapCells(grid, plot)
    expect(cells[0].intensity).toBeCloseTo(0, 10)
    expect(cells[1].intensity).toBeCloseTo(0.5, 10)
    expect(cells[2].intensity).toBeCloseTo(1, 10)
    expect(cells[3].intensity).toBeCloseTo(0.2, 10)
    expect(cells[5].intensity).toBeCloseTo(0.8, 10)
    for (const cell of cells) {
      if (cell.intensity === null) continue
      expect(cell.intensity).toBeGreaterThanOrEqual(0)
      expect(cell.intensity).toBeLessThanOrEqual(1)
    }
  })

  it('yields intensity null for a missing value rather than zero', () => {
    const cells = heatmapCells(grid, plot)
    expect(cells[4].intensity).toBeNull()
    expect(cells[4].row).toBe(1)
    expect(cells[4].column).toBe(1)
  })

  it('treats a non-finite value as missing', () => {
    const cells = heatmapCells([[1, Number.NaN]], plot)
    expect(cells[1].intensity).toBeNull()
  })

  it('handles a flat grid and an empty grid without dividing by zero', () => {
    const flat = heatmapCells([[4, 4], [4, 4]], plot)
    for (const cell of flat) {
      expect(cell.intensity).not.toBeNull()
      expect(Number.isFinite(cell.intensity as number)).toBe(true)
      expect(cell.intensity as number).toBeGreaterThanOrEqual(0)
      expect(cell.intensity as number).toBeLessThanOrEqual(1)
    }
    expect(heatmapCells([], plot)).toEqual([])
    expect(heatmapCells([[]], plot)).toEqual([])
  })

  it('pads short rows with missing cells so the grid stays rectangular', () => {
    const cells = heatmapCells([[1, 2], [3]], plot)
    expect(cells).toHaveLength(4)
    expect(cells[3].intensity).toBeNull()
  })
})

describe('stackSegments', () => {
  it('fills the plot height when the values sum to the total', () => {
    const segments = stackSegments(
      [{ key: 'a', value: 25 }, { key: 'b', value: 25 }, { key: 'c', value: 50 }],
      100,
      plot,
    )
    expect(segments).toHaveLength(3)
    const sum = segments.reduce((total, segment) => total + segment.height, 0)
    expect(sum).toBeCloseTo(innerHeight, 10)
    expect(segments.map((segment) => segment.key)).toEqual(['a', 'b', 'c'])
    expect(segments.map((segment) => segment.value)).toEqual([25, 25, 50])
  })

  it('stacks contiguously from the baseline upwards', () => {
    const segments = stackSegments(
      [{ key: 'a', value: 25 }, { key: 'b', value: 25 }, { key: 'c', value: 50 }],
      100,
      plot,
    )
    expect(segments[0].y + segments[0].height).toBeCloseTo(bottom, 10)
    expect(segments[1].y + segments[1].height).toBeCloseTo(segments[0].y, 10)
    expect(segments[2].y + segments[2].height).toBeCloseTo(segments[1].y, 10)
    expect(segments[2].y).toBeCloseTo(top, 10)
  })

  it('leaves head room when the values fall short of the total', () => {
    const segments = stackSegments([{ key: 'a', value: 50 }], 100, plot)
    expect(segments[0].height).toBeCloseTo(innerHeight / 2, 10)
    expect(segments[0].y).toBeCloseTo(top + innerHeight / 2, 10)
  })

  it('skips a null segment without shifting the later ones out of the stack', () => {
    const segments = stackSegments(
      [{ key: 'a', value: 40 }, { key: 'b', value: null }, { key: 'c', value: 60 }],
      100,
      plot,
    )
    expect(segments.map((segment) => segment.key)).toEqual(['a', 'c'])
    const sum = segments.reduce((total, segment) => total + segment.height, 0)
    expect(sum).toBeCloseTo(innerHeight, 10)
    for (const segment of segments) {
      expect(segment.y).toBeGreaterThanOrEqual(top - 1e-9)
      expect(segment.y + segment.height).toBeLessThanOrEqual(bottom + 1e-9)
    }
    expect(segments[1].y).toBeCloseTo(top, 10)
  })

  it('never coerces a null into a zero-valued segment', () => {
    const segments = stackSegments([{ key: 'a', value: null }], 100, plot)
    expect(segments).toEqual([])
  })

  it('clamps an overflowing stack to the plot instead of drawing past it', () => {
    const segments = stackSegments(
      [{ key: 'a', value: 80 }, { key: 'b', value: 80 }],
      100,
      plot,
    )
    const sum = segments.reduce((total, segment) => total + segment.height, 0)
    expect(sum).toBeLessThanOrEqual(innerHeight + 1e-9)
    for (const segment of segments) {
      expect(segment.y).toBeGreaterThanOrEqual(top - 1e-9)
      expect(segment.height).toBeGreaterThanOrEqual(0)
    }
  })

  it('returns nothing for a non-positive or non-finite total', () => {
    const values = [{ key: 'a', value: 10 }]
    expect(stackSegments(values, 0, plot)).toEqual([])
    expect(stackSegments(values, -5, plot)).toEqual([])
    expect(stackSegments(values, Number.NaN, plot)).toEqual([])
  })

  it('skips negative and non-finite values rather than inverting a segment', () => {
    const segments = stackSegments(
      [{ key: 'a', value: -10 }, { key: 'b', value: Number.NaN }, { key: 'c', value: 50 }],
      100,
      plot,
    )
    expect(segments.map((segment) => segment.key)).toEqual(['c'])
    expect(segments[0].y + segments[0].height).toBeCloseTo(bottom, 10)
  })
})

describe('bandPath', () => {
  const domain = { min: 0, max: 10 }

  it('closes the path and spans the plot for a full band', () => {
    const path = bandPath([10, 10, 10], [0, 0, 0], domain, plot)
    expect(path).toBe(
      `M ${left.toFixed(2)} ${top.toFixed(2)}`
      + ` L ${(left + innerWidth / 2).toFixed(2)} ${top.toFixed(2)}`
      + ` L ${right.toFixed(2)} ${top.toFixed(2)}`
      + ` L ${right.toFixed(2)} ${bottom.toFixed(2)}`
      + ` L ${(left + innerWidth / 2).toFixed(2)} ${bottom.toFixed(2)}`
      + ` L ${left.toFixed(2)} ${bottom.toFixed(2)} Z`,
    )
    expect(path.endsWith('Z')).toBe(true)
  })

  it('emits only finite coordinates', () => {
    const path = bandPath([8, 6, 9, 7], [2, 1, 4, 3], domain, plot)
    const numbers = pathNumbers(path)
    expect(numbers.length).toBeGreaterThan(0)
    for (const value of numbers) expect(Number.isFinite(value)).toBe(true)
  })

  it('breaks into a separate closed subpath at a null in either edge', () => {
    const upperGap = bandPath([8, null, 9, 7], [2, 2, 4, 3], domain, plot)
    expect(upperGap.match(/M/g)).toHaveLength(2)
    expect(upperGap.match(/Z/g)).toHaveLength(2)

    const lowerGap = bandPath([8, 6, 9, 7], [2, null, 4, 3], domain, plot)
    expect(lowerGap.match(/M/g)).toHaveLength(2)
    expect(lowerGap.match(/Z/g)).toHaveLength(2)
    for (const value of pathNumbers(lowerGap)) expect(Number.isFinite(value)).toBe(true)
  })

  it('does not bridge a gap: no coordinate falls inside the missing column', () => {
    const path = bandPath([8, null, 9], [2, 2, 4], domain, plot)
    const middleX = Number((left + innerWidth / 2).toFixed(2))
    const xs = pathNumbers(path).filter((_, index) => index % 2 === 0)
    expect(xs).not.toContain(middleX)
  })

  it('treats a non-finite edge value as a break', () => {
    const path = bandPath([8, Number.NaN, 9], [2, 2, 4], domain, plot)
    expect(path.match(/M/g)).toHaveLength(2)
  })

  it('returns an empty string when either edge is entirely missing', () => {
    expect(bandPath([null, null], [1, 2], domain, plot)).toBe('')
    expect(bandPath([1, 2], [null, null], domain, plot)).toBe('')
    expect(bandPath([], [], domain, plot)).toBe('')
  })

  it('does not invert when the domain is entirely negative', () => {
    const negative = { min: -20, max: -5 }
    const path = bandPath([-5, -5], [-20, -20], negative, plot)
    const numbers = pathNumbers(path)
    const ys = numbers.filter((_, index) => index % 2 === 1)
    expect(Math.min(...ys)).toBeCloseTo(top, 6)
    expect(Math.max(...ys)).toBeCloseTo(bottom, 6)
    expect(ys[0]).toBeCloseTo(top, 6)
    expect(ys.at(-1)).toBeCloseTo(bottom, 6)
  })

  it('centres a degenerate domain and a single column', () => {
    const flat = bandPath([5, 5], [5, 5], { min: 3, max: 3 }, plot)
    for (const value of pathNumbers(flat)) expect(Number.isFinite(value)).toBe(true)
    const ys = pathNumbers(flat).filter((_, index) => index % 2 === 1)
    for (const y of ys) expect(y).toBeCloseTo(top + innerHeight / 2, 6)

    const single = bandPath([8], [2], domain, plot)
    expect(single.endsWith('Z')).toBe(true)
    for (const value of pathNumbers(single)) expect(Number.isFinite(value)).toBe(true)
  })

  it('clamps values outside the domain into the plot', () => {
    const path = bandPath([40], [-40], domain, plot)
    const ys = pathNumbers(path).filter((_, index) => index % 2 === 1)
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(top - 1e-6)
      expect(y).toBeLessThanOrEqual(bottom + 1e-6)
    }
  })
})

describe('divergingLayout', () => {
  it('places the zero baseline mid-plot for a symmetric domain', () => {
    const { zeroY } = divergingLayout([-5, 5, 0], plot)
    expect(zeroY).toBeCloseTo(top + innerHeight / 2, 10)
  })

  it('grows a positive bar upward from the baseline', () => {
    const { zeroY, bars } = divergingLayout([-10, 10], plot)
    const positive = bars[1]
    expect(positive.sign).toBe(1)
    expect(positive.y + positive.height).toBeCloseTo(zeroY, 10)
    expect(positive.y).toBeCloseTo(top, 10)
    expect(positive.height).toBeGreaterThan(0)
  })

  it('grows a negative bar downward from the baseline', () => {
    const { zeroY, bars } = divergingLayout([-10, 10], plot)
    const negative = bars[0]
    expect(negative.sign).toBe(-1)
    expect(negative.y).toBeCloseTo(zeroY, 10)
    expect(negative.y + negative.height).toBeCloseTo(bottom, 10)
  })

  it('gives a zero value sign 0 and no height', () => {
    const { zeroY, bars } = divergingLayout([-4, 0, 4], plot)
    const zero = bars.find((bar) => bar.index === 1)
    expect(zero?.sign).toBe(0)
    expect(zero?.height).toBe(0)
    expect(zero?.y).toBeCloseTo(zeroY, 10)
  })

  it('produces no bar at all for a null value', () => {
    const { bars } = divergingLayout([-4, null, 4], plot)
    expect(bars).toHaveLength(2)
    expect(bars.map((bar) => bar.index)).toEqual([0, 2])
    expect(bars.some((bar) => bar.height === 0 && bar.sign === 0)).toBe(false)
  })

  it('treats a non-finite value as missing', () => {
    const { bars } = divergingLayout([1, Number.POSITIVE_INFINITY], plot)
    expect(bars.map((bar) => bar.index)).toEqual([0])
  })

  it('keeps the baseline at the bottom when every value is positive', () => {
    const { zeroY, bars } = divergingLayout([2, 4], plot)
    expect(zeroY).toBeCloseTo(bottom, 10)
    expect(bars.every((bar) => bar.sign === 1)).toBe(true)
    for (const bar of bars) expect(bar.y + bar.height).toBeCloseTo(zeroY, 10)
    expect(bars[1].y).toBeCloseTo(top, 10)
  })

  it('keeps the baseline at the top when every value is negative', () => {
    const { zeroY, bars } = divergingLayout([-2, -4], plot)
    expect(zeroY).toBeCloseTo(top, 10)
    expect(bars.every((bar) => bar.sign === -1)).toBe(true)
    for (const bar of bars) expect(bar.y).toBeCloseTo(zeroY, 10)
  })

  it('lays bars out left to right inside the plot without overlapping', () => {
    const { bars } = divergingLayout([1, 2, 3, 4], plot)
    expect(bars).toHaveLength(4)
    for (const bar of bars) {
      expect(bar.width).toBeGreaterThan(0)
      expect(bar.x).toBeGreaterThanOrEqual(left - 1e-9)
      expect(bar.x + bar.width).toBeLessThanOrEqual(right + 1e-9)
    }
    for (let index = 1; index < bars.length; index += 1) {
      expect(bars[index].x).toBeGreaterThanOrEqual(bars[index - 1].x + bars[index - 1].width)
    }
  })

  it('returns a finite baseline and no bars when every value is missing', () => {
    const { zeroY, bars } = divergingLayout([null, null], plot)
    expect(bars).toEqual([])
    expect(Number.isFinite(zeroY)).toBe(true)
    expect(divergingLayout([], plot).bars).toEqual([])
  })

  it('keeps every coordinate finite for a degenerate plot', () => {
    const { zeroY, bars } = divergingLayout([-1, 0, 1], { width: 0, height: 0, margin: CHART_MARGIN })
    expect(Number.isFinite(zeroY)).toBe(true)
    for (const bar of bars) {
      expect(Number.isFinite(bar.x)).toBe(true)
      expect(Number.isFinite(bar.y)).toBe(true)
      expect(Number.isFinite(bar.width)).toBe(true)
      expect(Number.isFinite(bar.height)).toBe(true)
    }
  })
})

describe('createPlot', () => {
  it('defaults to the margin convention the existing charts use', () => {
    expect(CHART_MARGIN).toEqual({ top: 20, right: 14, bottom: 30, left: 48 })
    expect(createPlot(400, 200)).toEqual({ width: 400, height: 200, margin: CHART_MARGIN })
  })
})
