import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import {
  buildHealthAssistantContext,
  parseAssistantNavigation,
  stripAssistantNavigation,
  visibleAssistantText,
} from './health-assistant'
import { EMPTY_USER_PROFILE } from './user-profile'

describe('health assistant context', () => {
  it('includes every category and the selected-day detail without null noise', () => {
    const data = createDemoData('2026-06-23')
    const context = JSON.parse(buildHealthAssistantContext(data, [data], 'sleep'))

    expect(context.app).toMatchObject({ currentPage: 'sleep', selectedDate: '2026-06-23' })
    expect(context.archive.dayCount).toBeGreaterThanOrEqual(14)
    expect(context.selectedDayDetail.summary).toHaveProperty('activity')
    expect(context.selectedDayDetail.summary).toHaveProperty('health')
    expect(context.selectedDayDetail.summary).toHaveProperty('sleep')
    expect(context.selectedDayDetail.summary).toHaveProperty('body')
    expect(context.selectedDayDetail.intraday.heartRate.length).toBeGreaterThan(0)
  })
})

describe('assistant navigation directives', () => {
  it('parses and removes a valid directive', () => {
    const text = 'Apro il sonno di ieri.\n<!-- openfit:navigate {"page":"sleep","date":"2026-06-22"} -->'
    expect(parseAssistantNavigation(text)).toEqual({ page: 'sleep', date: '2026-06-22' })
    expect(stripAssistantNavigation(text)).toBe('Apro il sonno di ieri.')
    expect(visibleAssistantText(text)).toBe('Apro il sonno di ieri.')
    expect(visibleAssistantText('Apro il sonno.\n<!-- pulse')).toBe('Apro il sonno.')
  })

  it('ignores invalid pages and malformed JSON', () => {
    expect(parseAssistantNavigation('<!-- openfit:navigate {"page":"admin"} -->')).toBeNull()
    expect(parseAssistantNavigation('<!-- openfit:navigate {"date":"2026-02-31"} -->')).toBeNull()
    expect(parseAssistantNavigation('<!-- openfit:navigate nope -->')).toBeNull()
  })
})

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
    const context = JSON.parse(
      buildHealthAssistantContext(data, [data], 'today', { ...EMPTY_USER_PROFILE, birthYear: 1990 }),
    )
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

  it('stays inside the context budget with a 28-day archive', () => {
    // `serializeHealthContext` in core/agents/agent-common.cjs throws above
    // 500,000 characters. 400,000 leaves headroom for a denser real account.
    const dates = Array.from({ length: 28 }, (_, index) =>
      new Date(Date.UTC(2026, 5, 23) - (27 - index) * 86_400_000).toISOString().slice(0, 10))
    const archive = dates.map((date) => createDemoData(date))
    const serialized = buildHealthAssistantContext(archive.at(-1)!, archive, 'today')
    expect(JSON.parse(serialized).archive.dayCount).toBeGreaterThanOrEqual(28)
    expect(serialized.length).toBeLessThan(400_000)
  })
})
