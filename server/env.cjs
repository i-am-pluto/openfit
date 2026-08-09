'use strict'

const REQUIRED = ['OPENFIT_GOOGLE_CLIENT_ID', 'OPENFIT_GOOGLE_CLIENT_SECRET']

/**
 * Reads the OAuth client from `.env` plus the process environment.
 *
 * The login client cannot be configured through the UI: `POST /api/config` is
 * itself guarded, so configuring sign-in would require being signed in.
 */
function loadEnv({ env = process.env, loadEnvFile = process.loadEnvFile, path = '.env' } = {}) {
  try {
    loadEnvFile(path)
  } catch (error) {
    // A missing .env is normal when the variables come from systemd.
    if (error?.code !== 'ENOENT') throw error
  }

  for (const name of REQUIRED) {
    if (!String(env[name] || '').trim()) {
      throw new Error(`${name} is not set. Add it to .env or the service environment.`)
    }
  }

  const publicOrigin = String(env.OPENFIT_PUBLIC_ORIGIN || '').trim()

  return {
    clientId: String(env.OPENFIT_GOOGLE_CLIENT_ID).trim(),
    clientSecret: String(env.OPENFIT_GOOGLE_CLIENT_SECRET).trim(),
    publicOrigin: publicOrigin || null,
  }
}

module.exports = { loadEnv, REQUIRED }
