'use strict'

const HEARTBEAT_MS = 25_000
const FORWARDED = ['auth-complete', 'sync-progress', 'assistant']

// One SSE stream carries every push. Multiple devices may listen at once; a
// disconnect never cancels in-flight work, matching the desktop behavior when
// the window is backgrounded.
//
// The event emitter is read from the per-request context, so a stream only ever
// forwards the signed-in account's own events.
function register({ add }) {
  add('GET', '/api/events', (request, response, { app }) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write('retry: 2000\n\n')

    const send = (name, payload) => {
      if (response.writableEnded) return
      response.write(`event: ${name}\ndata: ${JSON.stringify(payload ?? null)}\n\n`)
    }

    const listeners = FORWARDED.map((name) => {
      const listener = (payload) => send(name, payload)
      app.events.on(name, listener)
      return { name, listener }
    })

    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': ping\n\n')
    }, HEARTBEAT_MS)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()

    const close = () => {
      clearInterval(heartbeat)
      for (const { name, listener } of listeners) app.events.off(name, listener)
      if (!response.writableEnded) response.end()
    }

    request.on('close', close)
    request.on('error', close)
  })
}

module.exports = { register, FORWARDED }
