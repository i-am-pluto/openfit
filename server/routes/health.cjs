'use strict'

// Every handler takes its app from the per-request context. Closing over one
// app here would bind the whole server to a single account's data directory.
function register({ add }) {
  add('GET', '/api/status', (request, response, { app }) => app.getStatus())

  // Returns a URL for the browser to navigate to; see core/app.cjs::connect.
  add('POST', '/api/connect', async (request, response, { app }) => app.connect())

  add('POST', '/api/disconnect', (request, response, { app }) => app.disconnect())

  add('POST', '/api/sync', async (request, response, { app, body }) => app.sync(body?.date))

  add('GET', '/api/cached-data', (request, response, { app }) => app.getCachedData())

  add('GET', '/api/cached-archive', (request, response, { app }) => app.getCachedArchive())

  add('GET', '/api/export', (request, response, { app }) => {
    const archive = app.exportArchive()
    const body = Buffer.from(archive.json, 'utf8')
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${archive.filename}"`,
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    response.end(body)
  })
}

module.exports = { register }
