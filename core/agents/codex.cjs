'use strict'

const { createCodexService, resolveCodexBinary } = require('./codex-service.cjs')

const UNAUTHORIZED = /unauthorized|not logged|sign in|authentication/i

function create(options = {}) {
  const service = createCodexService(options)

  return {
    id: 'codex',
    label: 'Codex',

    getStatus() {
      const status = service.getStatus() || {}
      const available = status.available ?? Boolean(resolveCodexBinary({ env: options.env }))
      const unauthorized = UNAUTHORIZED.test(String(status.lastError || ''))
      return {
        id: 'codex',
        label: 'Codex',
        available,
        connected: Boolean(status.connected),
        authenticated: Boolean(available && !unauthorized),
        busy: Boolean(status.busy),
        ...(status.lastError ? { error: status.lastError } : {}),
      }
    },

    // The Codex service resolves with richer turn metadata; the registry contract
    // only promises the final text.
    startTurn: (input) => service.startTurn(input).then((result) => ({ text: result.text })),
    cancelTurn: () => service.cancelTurn(),
    reset: () => service.reset(),
    dispose: () => service.dispose(),
  }
}

module.exports = {
  id: 'codex',
  label: 'Codex',
  create,
  resolveBinary: (env = process.env) => resolveCodexBinary({ env }),
}
