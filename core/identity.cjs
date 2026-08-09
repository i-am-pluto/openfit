'use strict'

// The laptop hosting OpenFit suspends and resumes, so a strict `exp` comparison
// produces sporadic sign-in failures with no legible cause.
const CLOCK_SKEW_SECONDS = 60

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

function decodeIdToken(idToken) {
  const parts = String(idToken || '').split('.')
  if (parts.length !== 3) throw new Error('The Google ID token is malformed.')
  let claims
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error('The Google ID token is malformed.')
  }
  // `null`, arrays and primitives all survive JSON.parse. Rejecting them here
  // keeps every caller's claim reads on an object, so a hostile payload cannot
  // turn a claim check into a TypeError that escapes as a 500.
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Error('The Google ID token is malformed.')
  }
  return claims
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
 *
 * Every check below compares a claim that must already be the right type
 * against an expectation that must be present. Coercing either side with
 * `String()` makes absent-vs-absent compare equal, which turns a missing
 * `clientId` or `nonce` into an accepted token rather than a rejected one.
 */
function validateIdToken(idToken, { clientId, nonce, now = Math.floor(Date.now() / 1000) }) {
  const claims = decodeIdToken(idToken)

  if (!Number.isFinite(now)) throw new Error('The Google ID token cannot be validated without the current time.')

  if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss)) {
    throw new Error('The Google ID token has an unexpected issuer.')
  }
  if (typeof claims.aud !== 'string' || !clientId || claims.aud !== String(clientId)) {
    throw new Error('The Google ID token has an unexpected audience.')
  }
  if (typeof claims.nonce !== 'string' || !nonce || claims.nonce !== String(nonce)) {
    throw new Error('The Google ID token nonce does not match.')
  }
  // A non-numeric `exp` must not slip through: `Number('later') < anything` is
  // `false`, so a coercing comparison would accept an unexpirable token.
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp < now - CLOCK_SKEW_SECONDS) {
    throw new Error('The Google ID token has expired.')
  }

  const sub = typeof claims.sub === 'string' ? claims.sub : ''
  const email = typeof claims.email === 'string' ? claims.email : ''
  if (!sub) throw new Error('The Google ID token has no subject.')
  if (!email) throw new Error('The Google ID token has no email address.')
  if (claims.email_verified !== true) throw new Error('The Google account email address is not verified.')

  return { sub, email }
}

module.exports = { validateIdToken, decodeIdToken, CLOCK_SKEW_SECONDS }
