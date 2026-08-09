'use strict'

function register({ add, app }) {
  add('GET', '/api/status', () => app.getStatus())

  add('POST', '/api/config', async (request, response, { body }) => app.saveConfig(body))

  add('POST', '/api/connect', async (request, response, { isLoopback }) => app.connect({ fromLoopback: isLoopback }))

  add('POST', '/api/disconnect', () => app.disconnect())

  add('POST', '/api/sync', async (request, response, { body }) => app.sync(body?.date))

  add('GET', '/api/cached-data', () => app.getCachedData())

  add('GET', '/api/cached-archive', () => app.getCachedArchive())

  add('GET', '/api/export', (request, response) => {
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
