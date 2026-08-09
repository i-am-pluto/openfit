'use strict'

const http = require('node:http')
const path = require('node:path')

const { createAuth, parseCookies, resolveAccount, usableSession } = require('./auth.cjs')
const { loginPage } = require('./login-page.cjs')
const { createStaticHandler, securityHeaders } = require('./static.cjs')
const healthRoutes = require('./routes/health.cjs')
const assistantRoutes = require('./routes/assistant.cjs')
const eventRoutes = require('./routes/events.cjs')
const { registerLoginRoutes } = require('./routes/login.cjs')

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

function createServer({ staticRoot, token, dataDir, sessions, accounts, registry, loginDeps }) {
  // These three are what keeps one account's data away from another. A server
  // built without them would have to invent a default account, so it refuses.
  if (!sessions) throw new Error('createServer requires a session store.')
  if (!accounts) throw new Error('createServer requires an accounts store.')
  if (!registry) throw new Error('createServer requires an account registry.')

  const auth = createAuth({ dir: dataDir, token })
  const serveStatic = createStaticHandler({ root: staticRoot || path.resolve(__dirname, '..', 'dist') })

  const routes = []
  const add = (method, pathname, handle) => routes.push({ method, pathname, handle, guarded: true })
  const addPublic = (method, pathname, handle) => routes.push({ method, pathname, handle, guarded: false })

  healthRoutes.register({ add })
  assistantRoutes.register({ add })
  eventRoutes.register({ add })
  if (loginDeps) registerLoginRoutes({ addPublic, deps: loginDeps })

  const sendLoginPage = (response, { clearSession = false, message = '' } = {}) => {
    securityHeaders(response)
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    if (clearSession) headers['set-cookie'] = sessions.clearCookie()
    response.writeHead(200, headers)
    response.end(loginPage(message))
  }

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
      // Public routes get a parsed body on the same terms as guarded ones. Left
      // unparsed, POST /auth/logout could never see `{ everywhere: true }` and
      // "log out everywhere" would silently do nothing.
      let body = {}
      if (request.method === 'POST') {
        try {
          body = await readJsonBody(request)
        } catch (error) {
          const status = Number(error?.status) || 400
          sendJson(response, status, { error: error instanceof Error ? error.message : 'Request failed.' })
          return
        }
      }
      try {
        await route.handle(request, response, { url, body })
      } catch (error) {
        if (response.headersSent) {
          response.end()
          return
        }
        sendJson(response, 500, { error: 'The callback could not be completed.' })
      }
      return
    }

    // A verified cookie is only a session once it is shaped like one: the
    // pending sign-in cookie is signed with the same key and verifies happily.
    // Anything else is anonymous from here down. resolveAccount re-checks.
    const verified = sessions.verify(parseCookies(request.headers?.cookie)[sessions.cookieName])
    const session = usableSession(verified) ? verified : null
    const bearerOk = auth.isAuthorized(request)
    const authorized = Boolean(session) || bearerOk

    // An unreadable or mis-owned account record throws out of accounts.get().
    // That is a tampering signal, not a signed-out visitor: it is answered with
    // a 500 and a fixed message, never by falling back to another account.
    const resolveOrFail = (header) => {
      try {
        return resolveAccount({ session, accounts, header })
      } catch (error) {
        console.error('Resolving the account for a request failed.', error)
        return { error: 'The account could not be read.', status: 500, fatal: true }
      }
    }

    if (route) {
      if (!authorized) {
        sendJson(response, 401, { error: 'Sign in to use OpenFit.' })
        return
      }

      const resolved = resolveOrFail(request.headers['x-openfit-account'])
      if (resolved.error) {
        sendJson(response, resolved.status, { error: resolved.error, accounts: resolved.accounts })
        return
      }

      // Nothing below this line runs without a fully resolved, epoch-checked
      // account, and the app is fetched from that account alone.
      request.account = resolved.account

      try {
        const body = request.method === 'POST' ? await readJsonBody(request) : {}
        const isLoopback = LOOPBACK.has(request.socket.remoteAddress)
        const accountApp = registry.forAccount(resolved.account)
        const result = await route.handle(request, response, { body, url, isLoopback, app: accountApp, account: resolved.account })
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

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Method not allowed.' })
      return
    }

    // The bearer token is for /api only; a browser holding one still signs in.
    // The session is resolved here too — a revoked or deleted account must not
    // be handed a shell that looks signed in while every call it makes 401s.
    if (!session) {
      sendLoginPage(response)
      return
    }

    const resolved = resolveOrFail(undefined)
    if (resolved.error) {
      if (resolved.fatal) {
        sendJson(response, resolved.status, { error: resolved.error })
        return
      }
      sendLoginPage(response, { clearSession: true, message: 'Your session has ended. Sign in again.' })
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

  server.on('close', () => { void registry.disposeAll() })

  return { server, auth, token: auth.token }
}

module.exports = { createServer, readJsonBody, sendJson, MAX_BODY_BYTES }
