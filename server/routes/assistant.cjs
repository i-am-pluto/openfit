'use strict'

// The app comes from the per-request context so each account talks to its own
// assistant; see server/routes/health.cjs.
function register({ add }) {
  add('GET', '/api/assistant/status', (request, response, { app }) => app.assistant.getStatus())

  add('GET', '/api/assistant/agents', (request, response, { app }) => ({
    agents: app.assistant.listAgents(),
    status: app.assistant.getStatus(),
  }))

  add('POST', '/api/assistant/agent', async (request, response, { app, body }) => app.assistant.selectAgent(body?.agentId))

  add('POST', '/api/assistant/turn', async (request, response, { app, body }) => app.assistant.startTurn(body))

  add('POST', '/api/assistant/cancel', async (request, response, { app, body }) => {
    await app.assistant.cancel(body?.requestId)
    return { ok: true }
  })

  add('POST', '/api/assistant/reset', async (request, response, { app }) => {
    await app.assistant.reset()
    return { ok: true }
  })
}

module.exports = { register }
