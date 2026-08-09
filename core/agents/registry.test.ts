import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createAgentRegistry } = require('./index.cjs') as {
  createAgentRegistry: (options?: Record<string, any>) => any
}

function fakeProvider(id: string, available: boolean) {
  const session = {
    getStatus: vi.fn(() => ({ id, label: id, available, connected: false, authenticated: available, busy: false })),
    startTurn: vi.fn(async () => ({ text: `${id} replied` })),
    cancelTurn: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  }
  return {
    id,
    label: id,
    available,
    session,
    create: vi.fn(() => session),
    resolveBinary: () => (available ? `/mock/${id}` : null),
  }
}

describe('agent registry', () => {
  it('selects the first available backend, preserving declared order', () => {
    const codex = fakeProvider('codex', true)
    const claude = fakeProvider('claude-code', true)
    const registry = createAgentRegistry({ providers: [codex, claude] })

    expect(registry.selectedId()).toBe('codex')
    expect(registry.list().map((agent: any) => `${agent.id}:${agent.selected}`)).toEqual(['codex:true', 'claude-code:false'])
  })

  it('skips an unavailable backend', () => {
    const registry = createAgentRegistry({ providers: [fakeProvider('codex', false), fakeProvider('claude-code', true)] })
    expect(registry.selectedId()).toBe('claude-code')
  })

  it('does not create a session merely to list agents', () => {
    const codex = fakeProvider('codex', true)
    const claude = fakeProvider('claude-code', true)
    const registry = createAgentRegistry({ providers: [codex, claude] })

    registry.list()
    expect(codex.create).not.toHaveBeenCalled()
    expect(claude.create).not.toHaveBeenCalled()
  })

  it('honours a persisted preference when it is available', () => {
    const registry = createAgentRegistry({ providers: [fakeProvider('codex', true), fakeProvider('claude-code', true)] })
    expect(registry.prefer('claude-code')).toBe('claude-code')
    expect(registry.selectedId()).toBe('claude-code')
  })

  it('falls back and reports the change when the preferred backend disappears', () => {
    const onSelectionChange = vi.fn()
    const registry = createAgentRegistry({
      providers: [fakeProvider('codex', false), fakeProvider('claude-code', true)],
      onSelectionChange,
    })

    expect(registry.prefer('codex')).toBe('claude-code')
    expect(registry.selectedId()).toBe('claude-code')

    // The healed selection is persisted exactly once, not on every read.
    registry.selectedId()
    expect(onSelectionChange).not.toHaveBeenCalledWith('codex')
  })

  it('routes a turn to the selected backend', async () => {
    const codex = fakeProvider('codex', true)
    const claude = fakeProvider('claude-code', true)
    const registry = createAgentRegistry({ providers: [codex, claude] })

    registry.select('claude-code')
    await expect(registry.startTurn({ text: 'hi', healthContext: '{}' })).resolves.toEqual({ text: 'claude-code replied' })
    expect(codex.session.startTurn).not.toHaveBeenCalled()
  })

  it('notifies on an explicit switch and rejects an unknown id', () => {
    const onSelectionChange = vi.fn()
    const registry = createAgentRegistry({
      providers: [fakeProvider('codex', true), fakeProvider('claude-code', true)],
      onSelectionChange,
    })

    registry.select('claude-code')
    expect(onSelectionChange).toHaveBeenCalledWith('claude-code')
    expect(() => registry.select('nope')).toThrow(/Unknown assistant backend/)
  })

  it('resets and disposes every live session', async () => {
    const codex = fakeProvider('codex', true)
    const claude = fakeProvider('claude-code', true)
    const registry = createAgentRegistry({ providers: [codex, claude] })

    await registry.startTurn({ text: 'hi', healthContext: '{}' })
    registry.select('claude-code')
    await registry.startTurn({ text: 'hi', healthContext: '{}' })

    await registry.reset()
    expect(codex.session.reset).toHaveBeenCalled()
    expect(claude.session.reset).toHaveBeenCalled()

    await registry.dispose()
    expect(codex.session.dispose).toHaveBeenCalled()
    expect(claude.session.dispose).toHaveBeenCalled()
  })

  it('reports a usable status when nothing is installed', () => {
    const registry = createAgentRegistry({ providers: [fakeProvider('codex', false)] })
    expect(registry.getStatus()).toMatchObject({ id: 'codex', available: false, authenticated: false })
  })
})
