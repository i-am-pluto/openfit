'use strict'

const { securityHeaders } = require('../static.cjs')

// Only mounted when OPENFIT_PUBLIC_ORIGIN is configured. In the default loopback
// mode the coordinator runs its own short-lived 127.0.0.1 listener instead.
//
// This route is deliberately outside the token gate: the provider redirects the
// browser here without OpenFit's cookie. The OAuth `state` value is the CSRF
// check, and the code is worthless without the PKCE verifier held in memory.
function register({ addPublic, app }) {
  addPublic('GET', '/oauth/callback', async (request, response, { url }) => {
    const outcome = await app.handleOAuthCallback(url.searchParams)
    securityHeaders(response)
    response.writeHead(outcome.status, { 'content-type': 'text/html; charset=utf-8' })
    response.end(outcome.html)
  })
}

module.exports = { register }
