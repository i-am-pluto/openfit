'use strict'

function register({ add, app }) {
  add('GET', '/api/assistant/status', () => app.assistant.getStatus())

  add('GET', '/api/assistant/agents', () => ({
    agents: app.assistant.listAgents(),
    status: app.assistant.getStatus(),
  }))

  add('POST', '/api/assistant/agent', async (request, response, { body }) => app.assistant.selectAgent(body?.agentId))

  add('POST', '/api/assistant/turn', async (request, response, { body }) => app.assistant.startTurn(body))

  add('POST', '/api/assistant/cancel', async (request, response, { body }) => {
    await app.assistant.cancel(body?.requestId)
    return { ok: true }
  })

  add('POST', '/api/assistant/reset', async () => {
    await app.assistant.reset()
    return { ok: true }
  })
}

module.exports = { register }
