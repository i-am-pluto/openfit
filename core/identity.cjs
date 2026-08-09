'use strict'

// The laptop hosting OpenFit suspends and resumes, so a strict `exp` comparison
// produces sporadic sign-in failures with no legible cause.
const CLOCK_SKEW_SECONDS = 60

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

function decodeIdToken(idToken) {
  const parts = String(idToken || '').split('.')
  if (parts.length !== 3) throw new Error('The Google ID token is malformed.')
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error('The Google ID token is malformed.')
  }
}

/**
 * Validates the claims of an ID token fetched directly from Google's token
 * endpoint over TLS.
 *
 * The signature is deliberately not verified. OIDC Core 3.1.3.7 permits
 * skipping signature validation when the token is received directly from the
 * token endpoint over a TLS-protected server-to-server channel, which is the
 * only way this function is ever reached. If a future change ever accepts an
 * ID token supplied by a client, this reasoning collapses and JWKS
 * verification becomes mandatory.
 */
function validateIdToken(idToken, { clientId, nonce, now = Math.floor(Date.now() / 1000) }) {
  const claims = decodeIdToken(idToken)

  if (!ISSUERS.has(String(claims.iss))) throw new Error('The Google ID token has an unexpected issuer.')
  if (String(claims.aud) !== String(clientId)) throw new Error('The Google ID token has an unexpected audience.')
  if (String(claims.nonce || '') !== String(nonce)) throw new Error('The Google ID token nonce does not match.')
  if (Number(claims.exp || 0) < now - CLOCK_SKEW_SECONDS) throw new Error('The Google ID token has expired.')

  const sub = String(claims.sub || '')
  const email = String(claims.email || '')
  if (!sub) throw new Error('The Google ID token has no subject.')
  if (!email) throw new Error('The Google ID token has no email address.')
  if (claims.email_verified !== true) throw new Error('The Google account email address is not verified.')

  return { sub, email }
}

module.exports = { validateIdToken, decodeIdToken, CLOCK_SKEW_SECONDS }
