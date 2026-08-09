'use strict'

const codex = require('./codex.cjs')
const claudeCode = require('./claude-code.cjs')

// Order matters: the first available backend is the default, so existing Codex
// installs keep the behavior they had before Claude Code existed.
const AGENTS = [codex, claudeCode]

function describe(provider, available) {
  return {
    id: provider.id,
    label: provider.label,
    available,
    connected: false,
    authenticated: available,
    busy: false,
  }
}

/**
 * Owns backend discovery, selection, and lifecycle. Sessions are created lazily
 * so merely listing agents never spawns a process.
 */
function createAgentRegistry(options = {}) {
  const providers = options.providers || AGENTS
  const env = options.env || process.env
  const createOptions = options.createOptions || {}
  const onSelectionChange = typeof options.onSelectionChange === 'function' ? options.onSelectionChange : () => {}

  const sessions = new Map()
  let selectedId = null

  const providerFor = (id) => providers.find((provider) => provider.id === id) || null
  const isAvailable = (provider) => {
    try {
      return Boolean(provider.resolveBinary(env))
    } catch {
      return false
    }
  }

  function resolveSelection(preferredId) {
    const preferred = providerFor(preferredId)
    if (preferred && isAvailable(preferred)) return preferred.id
    const firstAvailable = providers.find(isAvailable)
    if (firstAvailable) return firstAvailable.id
    return providers[0]?.id || null
  }

  function sessionFor(id) {
    const provider = providerFor(id)
    if (!provider) throw new Error(`Unknown assistant backend: ${id}`)
    if (!sessions.has(id)) sessions.set(id, provider.create({ ...createOptions, env }))
    return sessions.get(id)
  }

  const registry = {
    ids: () => providers.map((provider) => provider.id),

    // Reported selection self-heals when the selected backend's binary disappears.
    selectedId() {
      const healed = resolveSelection(selectedId)
      if (healed !== selectedId) {
        selectedId = healed
        onSelectionChange(selectedId)
      }
      return selectedId
    },

    list() {
      const active = registry.selectedId()
      return providers.map((provider) => {
        const live = sessions.get(provider.id)
        const status = live ? live.getStatus() : describe(provider, isAvailable(provider))
        return { ...status, selected: provider.id === active }
      })
    },

    getStatus() {
      const id = registry.selectedId()
      if (!id) {
        return { id: null, label: 'None', available: false, connected: false, authenticated: false, busy: false }
      }
      const provider = providerFor(id)
      if (!isAvailable(provider) && !sessions.has(id)) return describe(provider, false)
      return sessionFor(id).getStatus()
    },

    select(id) {
      const provider = providerFor(id)
      if (!provider) throw new Error(`Unknown assistant backend: ${id}`)
      if (selectedId === id) return registry.getStatus()
      selectedId = id
      onSelectionChange(id)
      return registry.getStatus()
    },

    // The caller decides the initial preference (persisted config); the registry
    // decides whether it is usable.
    prefer(id) {
      selectedId = resolveSelection(id)
      return selectedId
    },

    startTurn(input) {
      const id = registry.selectedId()
      if (!id) return Promise.reject(new Error('No assistant backend is available.'))
      return sessionFor(id).startTurn(input)
    },

    async cancelTurn() {
      await Promise.all([...sessions.values()].map((session) => session.cancelTurn()))
    },

    async reset() {
      await Promise.all([...sessions.values()].map((session) => session.reset()))
    },

    async dispose() {
      await Promise.all([...sessions.values()].map((session) => session.dispose()))
      sessions.clear()
    },
  }

  return registry
}

module.exports = { createAgentRegistry, AGENTS }
