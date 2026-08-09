import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS } = require('./agent-common.cjs')

describe('shared assistant instructions', () => {
  it('asks for markdown rather than plain text', () => {
    expect(HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS).toMatch(/markdown/i)
    expect(HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS).not.toMatch(/plain text/i)
  })

  it('states the sidebar formatting limits the renderer depends on', () => {
    expect(HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS).toMatch(/##/)
    expect(HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS).toMatch(/three columns/i)
  })

  it('keeps the navigation contract intact', () => {
    expect(HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS).toContain('openfit:navigate')
    expect(HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS).toContain('OPENFIT_HEALTH_CONTEXT')
  })

  it('keeps the safety boundaries intact', () => {
    expect(HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS).toMatch(/never diagnose/i)
    expect(HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS).toMatch(/never run shell commands/i)
  })

  it('is a single string both backends can send verbatim', () => {
    expect(typeof HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS).toBe('string')
    expect(HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS).not.toContain('\n')
  })
})
