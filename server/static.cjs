'use strict'

const fs = require('node:fs')
const path = require('node:path')

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

// Every provider call happens server-side, so the page never needs a remote origin.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ')

function securityHeaders(response) {
  response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Referrer-Policy', 'no-referrer')
}

function createStaticHandler({ root }) {
  const resolvedRoot = path.resolve(root)

  return function serve(pathname, response) {
    const requested = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
    const candidate = path.resolve(resolvedRoot, `.${path.posix.normalize(requested)}`)

    // Reject anything that escapes the build directory.
    if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Forbidden')
      return true
    }

    let body
    try {
      const stats = fs.statSync(candidate)
      if (!stats.isFile()) return false
      body = fs.readFileSync(candidate)
    } catch {
      return false
    }

    securityHeaders(response)
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(candidate).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': candidate.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
    })
    response.end(body)
    return true
  }
}

module.exports = { createStaticHandler, securityHeaders, CONTENT_SECURITY_POLICY }
