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
