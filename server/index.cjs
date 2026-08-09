'use strict'

const http = require('node:http')
const path = require('node:path')

const { createAuth } = require('./auth.cjs')
const { createStaticHandler, securityHeaders } = require('./static.cjs')
const healthRoutes = require('./routes/health.cjs')
const assistantRoutes = require('./routes/assistant.cjs')
const eventRoutes = require('./routes/events.cjs')
const oauthRoutes = require('./routes/oauth.cjs')

const MAX_BODY_BYTES = 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    let rejected = false
    const chunks = []
    request.on('data', (chunk) => {
      if (rejected) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejected = true
        chunks.length = 0
        // Drain rather than destroy: resetting the socket here would deny the
        // client the 413 explaining what went wrong.
        request.resume()
        reject(Object.assign(new Error('The request body is too large.'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (rejected) return
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(Object.assign(new Error('The request body is not valid JSON.'), { status: 400 }))
      }
    })
    request.on('error', reject)
  })
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  response.end(body)
}

function createServer({ app, staticRoot, token, dataDir }) {
  const auth = createAuth({ dir: dataDir || app.dataDir, token })
  const serveStatic = createStaticHandler({ root: staticRoot || path.resolve(__dirname, '..', 'dist') })

  const routes = []
  const add = (method, pathname, handle) => routes.push({ method, pathname, handle, guarded: true })
  const addPublic = (method, pathname, handle) => routes.push({ method, pathname, handle, guarded: false })

  healthRoutes.register({ add, app })
  assistantRoutes.register({ add, app })
  eventRoutes.register({ add, app })
  if (app.publicOrigin) oauthRoutes.register({ addPublic, app })

  const server = http.createServer(async (request, response) => {
    let url
    try {
      url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
    } catch {
      sendJson(response, 400, { error: 'Malformed request URL.' })
      return
    }

    const route = routes.find((entry) => entry.pathname === url.pathname && entry.method === request.method)

    if (route?.guarded === false) {
      try {
        await route.handle(request, response, { url })
      } catch (error) {
        sendJson(response, 500, { error: 'The callback could not be completed.' })
      }
      return
    }

    const authorized = auth.isAuthorized(request)

    if (route) {
      if (!authorized) {
        sendJson(response, 401, { error: 'Unauthorized. Open OpenFit using the tokenized URL printed at startup.' })
        return
      }
      try {
        const body = request.method === 'POST' ? await readJsonBody(request) : {}
        const isLoopback = LOOPBACK.has(request.socket.remoteAddress)
        const result = await route.handle(request, response, { body, url, isLoopback })
        if (!response.headersSent && !response.writableEnded) sendJson(response, 200, result ?? null)
      } catch (error) {
        if (response.headersSent) {
          response.end()
          return
        }
        const status = Number(error?.status) || 400
        sendJson(response, status, { error: error instanceof Error ? error.message : 'Request failed.' })
      }
      return
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(response, authorized ? 404 : 401, { error: authorized ? 'Not found.' : 'Unauthorized.' })
      return
    }

    // A tokenized link exchanges the query parameter for a cookie once, so the
    // token stops travelling in URLs and browser history.
    if (request.method === 'GET' && url.searchParams.get('token') && authorized) {
      auth.setCookie(response)
      response.writeHead(302, { location: url.pathname || '/' })
      response.end()
      return
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Method not allowed.' })
      return
    }

    if (!authorized) {
      securityHeaders(response)
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Unauthorized. Open OpenFit using the tokenized URL printed at startup.')
      return
    }

    if (serveStatic(url.pathname, response)) return

    // Unknown navigations fall back to the app shell, but a request that names a
    // file must 404. Answering a missing .js with HTML produces a blank page
    // under `nosniff` instead of a legible error.
    if (!path.extname(url.pathname) && serveStatic('/index.html', response)) return

    securityHeaders(response)
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found. Run `npm run build` first.')
  })

  server.on('close', () => { void app.dispose() })

  return { server, auth, token: auth.token }
}

module.exports = { createServer, readJsonBody, sendJson, MAX_BODY_BYTES }
