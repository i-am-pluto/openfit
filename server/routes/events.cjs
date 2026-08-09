'use strict'

const HEARTBEAT_MS = 25_000
const FORWARDED = ['auth-complete', 'sync-progress', 'assistant']

// One SSE stream carries every push. Multiple devices may listen at once; a
// disconnect never cancels in-flight work, matching the desktop behavior when
// the window is backgrounded.
//
// The event emitter is read from the per-request context, so a stream only ever
// forwards the signed-in account's own events.
function register({ add, heartbeatMs }) {
  // The suite drives revocation faster than a 25-second wall clock. Anything
  // that is not a positive safe integer falls back to the production value
  // rather than being coerced into one: Number('x') would disable the check.
  const interval = Number.isSafeInteger(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : HEARTBEAT_MS

  add('GET', '/api/events', (request, response, { app, account, revalidate }) => {
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

    let heartbeat = null

    const close = () => {
      if (heartbeat) clearInterval(heartbeat)
      for (const { name, listener } of listeners) app.events.off(name, listener)
      if (!response.writableEnded) response.end()
    }

    // Authorization was checked when this request arrived and this request never
    // ends, so it is checked again on every heartbeat through the same path the
    // request guard uses. Without this, "log out everywhere" leaves an already
    // open tab on a lost laptop receiving that account's sync progress and
    // assistant output — LLM-generated text about the person's health.
    //
    // The stream survives only while the very same account re-resolves cleanly:
    // an error, a missing account, a resolution that names anyone else, or a
    // revalidate that is not callable all close it.
    heartbeat = setInterval(() => {
      const current = typeof revalidate === 'function' ? revalidate() : { error: 'No revalidation is available.' }
      if (current?.error || !current?.account || current.account.id !== account?.id) {
        close()
        return
      }
      if (!response.writableEnded) response.write(': ping\n\n')
    }, interval)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()

    request.on('close', close)
    request.on('error', close)
  })
}

module.exports = { register, FORWARDED }
