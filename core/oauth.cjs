'use strict'

const crypto = require('node:crypto')
const http = require('node:http')

const { providerFor } = require('./providers/index.cjs')

const SESSION_TIMEOUT_MS = 5 * 60_000

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character])
}

function resultPage(success, message) {
  const color = success ? '#5ae4c0' : '#ff7b74'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>OpenFit</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;color:#edf4f5;background:#080c11;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.card{width:min(420px,calc(100vw - 40px));padding:34px;border:1px solid #ffffff12;border-radius:20px;background:#111820;text-align:center;box-shadow:0 25px 80px #0008}.orb{display:grid;width:58px;height:58px;place-items:center;margin:0 auto 18px;border-radius:50%;color:${color};background:${color}16;font-size:25px}h1{margin:0 0 10px;font-size:22px}p{margin:0;color:#83909b;font-size:13px;line-height:1.55}</style></head><body><main class="card"><div class="orb">${success ? '✓' : '!'}</div><h1>${success ? 'Account connected' : 'Connection failed'}</h1><p>${escapeHtml(message)}<br>You can close this tab and return to OpenFit.</p></main></body></html>`
}

/**
 * Coordinates the OAuth authorization-code + PKCE exchange.
 *
 * Loopback mode (default) opens a short-lived 127.0.0.1 listener, exactly as the
 * desktop app always has. Public-origin mode skips the listener: the main HTTP
 * server owns `/oauth/callback` and hands the request to `handleCallback`.
 */
function createOAuthCoordinator({ credentials, onComplete, publicOrigin = null, timeoutMs = SESSION_TIMEOUT_MS }) {
  let session = null
  let server = null
  let timer = null

  function reset() {
    if (timer) clearTimeout(timer)
    timer = null
    if (server) {
      try { server.close() } catch { /* already stopped */ }
    }
    server = null
    session = null
  }

  function complete(result) {
    reset()
    onComplete(result)
  }

  function armTimeout() {
    timer = setTimeout(() => complete({ ok: false, error: 'The OAuth session expired.' }), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function finish(params) {
    if (!session) return { ok: false, message: 'There is no authorization in progress.' }
    const active = session
    const returnedState = params.get('state')
    const code = params.get('code')
    const oauthError = params.get('error')

    if (returnedState !== active.state) {
      complete({ ok: false, error: 'Invalid OAuth state.' })
      return { ok: false, message: 'The request security check is invalid.' }
    }
    if (oauthError || !code) {
      const message = params.get('error_description') || oauthError || 'Authorization canceled.'
      complete({ ok: false, error: message })
      return { ok: false, message }
    }
    try {
      const stored = credentials.read()
      const service = providerFor(stored)
      const token = await service.exchangeAuthorizationCode(stored.config, code, active.verifier)
      credentials.save({ ...stored, token, lastSyncAt: null })
      credentials.clearCache()
      complete({ ok: true })
      return {
        ok: true,
        message: service.provider === 'google-health' ? 'Google Health is ready.' : 'Fitbit legacy is ready.',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Token exchange failed.'
      complete({ ok: false, error: message })
      return { ok: false, message }
    }
  }

  function startLoopbackServer(redirect) {
    return new Promise((resolve, reject) => {
      server = http.createServer(async (request, response) => {
        const incoming = new URL(request.url, redirect.origin)
        if (incoming.pathname !== redirect.pathname) {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('Not found')
          return
        }
        const outcome = await finish(incoming.searchParams)
        response.writeHead(outcome.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
        response.end(resultPage(outcome.ok, outcome.message))
      })
      server.once('error', (error) => {
        reset()
        reject(error.code === 'EADDRINUSE' ? new Error(`Port ${redirect.port} is already in use.`) : error)
      })
      server.listen(Number(redirect.port), '127.0.0.1', resolve)
    })
  }

  return {
    inProgress: () => Boolean(session),

    /**
     * @param {{ fromLoopback?: boolean }} options
     * @returns {Promise<{ ok: true, authorizationUrl: string } | { ok: false, requiresHost: true }>}
     */
    async start({ fromLoopback = true } = {}) {
      if (session) throw new Error('A connection process is already in progress.')
      const stored = credentials.read()
      if (!credentials.publicStatus().configured) throw new Error('Complete the OAuth configuration first.')

      const redirect = new URL(stored.config.redirectUri)
      const usesPublicOrigin = Boolean(publicOrigin) && redirect.origin === publicOrigin

      // A loopback callback resolves on whichever device follows it, so a remote
      // browser would send the code to itself. Say so rather than fail opaquely.
      if (!usesPublicOrigin && !fromLoopback) {
        return { ok: false, requiresHost: true }
      }

      const service = providerFor(stored)
      const pkce = service.createPkce()
      session = { state: crypto.randomBytes(24).toString('hex'), verifier: pkce.verifier }

      if (!usesPublicOrigin) {
        try {
          await startLoopbackServer(redirect)
        } catch (error) {
          reset()
          throw error
        }
      }
      armTimeout()
      return { ok: true, authorizationUrl: service.createAuthorizationUrl(stored.config, session.state, pkce) }
    },

    // Used by the HTTP server when OPENFIT_PUBLIC_ORIGIN is configured.
    async handleCallback(searchParams) {
      const outcome = await finish(searchParams)
      return { status: outcome.ok ? 200 : 400, html: resultPage(outcome.ok, outcome.message) }
    },

    cancel: reset,
    dispose: reset,
  }
}

module.exports = { createOAuthCoordinator, resultPage, escapeHtml }
