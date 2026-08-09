'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createAccountRegistry } = require('../core/account-registry.cjs')
const { createAccounts } = require('../core/accounts.cjs')
const { createAgentRegistry } = require('../core/agents/index.cjs')
const { createApp, normalizePublicOrigin } = require('../core/app.cjs')
const { validateIdToken } = require('../core/identity.cjs')
const { buildGoogleAuthUrl, exchangeGoogleCode } = require('../core/providers/google-health.cjs')
const { createSecretStore } = require('../core/secrets.cjs')
const { loadEnv } = require('./env.cjs')
const { createServer } = require('./index.cjs')
const { createSessions } = require('./session.cjs')

// Absolute, not cwd-relative: a service unit with its own WorkingDirectory would
// otherwise find no .env, fall back to whatever the environment happens to hold,
// and fail with a message about a variable the operator did set.
const ENV_FILE = path.resolve(__dirname, '..', '.env')

const DEFAULT_PORT = 7788
const DEFAULT_HOST = '0.0.0.0'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current.startsWith('--')) continue
    const equals = current.indexOf('=')
    if (equals > 0) args[current.slice(2, equals)] = current.slice(equals + 1)
    else args[current.slice(2)] = argv[index + 1]?.startsWith('--') ? 'true' : argv[++index]
  }
  return args
}

function defaultDataDir(env, platform) {
  if (env.OPENFIT_DATA_DIR) return env.OPENFIT_DATA_DIR
  if (env.OPENFIT_USER_DATA) return env.OPENFIT_USER_DATA
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'OpenFit')
  if (platform === 'win32') return path.join(env.APPDATA || os.homedir(), 'OpenFit')
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'openfit')
}

// Tailscale hands out addresses in the 100.64.0.0/10 CGNAT range; listing those
// first means the URL to open on a phone is the first one printed.
function isTailscaleAddress(address) {
  const octets = address.split('.').map(Number)
  return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
}

function reachableAddresses(host) {
  if (host !== '0.0.0.0' && host !== '::') return [host]
  const found = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4') continue
      found.push(entry.address)
    }
  }
  const tailnet = found.filter(isTailscaleAddress)
  const loopback = found.filter((address) => address.startsWith('127.'))
  const rest = found.filter((address) => !isTailscaleAddress(address) && !address.startsWith('127.'))
  return [...tailnet, ...rest, ...loopback]
}

// Sign-in only completes on the origin the OAuth client is registered with: the
// pending cookie is set on the origin the browser started from, and Google sends
// the callback to the redirect URI. Naming that origin first is the difference
// between signing in and a "sign-in took too long" page with no stated cause.
//
// No URL here carries a token. Browser access is a Google sign-in now, and a
// tokenised URL printed to a log or a terminal scrollback was a standing
// credential leak.
function banner({ addresses, port, publicOrigin, dataDir, storageBackend, agents }) {
  const signInAt = publicOrigin ? `${publicOrigin}/` : `http://127.0.0.1:${port}/`
  const others = addresses.map((address) => `http://${address}:${port}/`).filter((url) => url !== signInAt)

  const lines = [
    '',
    '  OpenFit server',
    `  data     ${dataDir}`,
    `  storage  ${storageBackend}`,
    `  agents   ${agents.map((agent) => `${agent.id}${agent.available ? '' : ' (unavailable)'}`).join(', ') || 'none'}`,
    '',
    '  Open this and sign in with Google:',
    `    ${signInAt}`,
  ]
  if (!publicOrigin) {
    lines.push(
      '',
      '  Sign-in only completes from this machine. Set OPENFIT_PUBLIC_ORIGIN=https://<host>.ts.net',
      '  and register <origin>/auth/callback with the Google client to sign in from other devices.',
    )
  }
  if (others.length) lines.push('', '  Also listening on:', ...others.map((url) => `    ${url}`))
  lines.push('')
  return lines.join('\n')
}

function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  const host = args.host || env.OPENFIT_HOST || DEFAULT_HOST
  const port = Number(args.port || env.OPENFIT_PORT || DEFAULT_PORT)
  const dataDir = args['data-dir'] || defaultDataDir(env, process.platform)
  const staticRoot = path.resolve(__dirname, '..', 'dist')

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${args.port || env.OPENFIT_PORT}`)
    process.exit(1)
  }

  // Configuration is settled before anything is created on disk, so a server
  // that cannot sign anyone in leaves no data directory and no master key behind.
  let publicOrigin = null
  let identity = null
  try {
    const configured = loadEnv({ env, path: ENV_FILE })
    // Validated here rather than at the first request: createApp would otherwise
    // reject a non-https origin from inside a request handler, long after the
    // operator stopped watching, and `secure` cookies would already be set on a
    // plain-http origin where no browser will send them back.
    publicOrigin = normalizePublicOrigin(configured.publicOrigin)
    // Frozen because one object is both the login routes' identity and the
    // per-account app's oauthDefaults: the client that signs a person in and the
    // client that refreshes their token must not be able to drift apart.
    identity = Object.freeze({
      clientId: configured.clientId,
      clientSecret: configured.clientSecret,
      redirectUri: `${publicOrigin || `http://127.0.0.1:${port}`}/auth/callback`,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  // In development the Vite dev server serves the page and proxies /api here.
  const devMode = args.dev === 'true' || args.dev === '' || env.OPENFIT_DEV === '1'
  if (!devMode && !fs.existsSync(path.join(staticRoot, 'index.html'))) {
    console.error('dist/index.html is missing. Run `npm run build` first.')
    process.exit(1)
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  // One secret store for the instance. The accounts index and every account's
  // app read it, so `master.key` stays instance-wide instead of one key per
  // account directory, and the session signing key is derived from those bytes.
  const secrets = createSecretStore({ dir: dataDir })
  const accounts = createAccounts({ dataDir, secrets })
  const registry = createAccountRegistry({
    dataDir,
    secrets,
    createApp,
    appOptions: {
      env,
      clientVersion: require('../package.json').version,
      publicOrigin,
      // Without this the OAuth client falls back to whatever a previous release
      // wrote into the account's credentials file, and .env is ignored in
      // silence: the sign-in works and the first token refresh does not.
      oauthDefaults: identity,
    },
  })

  // `Secure` has one source. The login routes check this against the session
  // store at wiring time, so the two cookies cannot disagree.
  const secure = Boolean(publicOrigin)
  const sessions = createSessions({ masterKey: secrets.masterKey(), secure })

  const tokenOverride = env.OPENFIT_SERVER_TOKEN
    || (args['token-file'] ? fs.readFileSync(args['token-file'], 'utf8').trim() : null)

  const { server } = createServer({
    staticRoot,
    dataDir,
    token: tokenOverride,
    sessions,
    accounts,
    registry,
    loginDeps: {
      sessions,
      accounts,
      identity,
      secure,
      validateIdToken,
      authorizationUrl: ({ state, nonce, challenge, prompt }) => buildGoogleAuthUrl({
        clientId: identity.clientId,
        redirectUri: identity.redirectUri,
        state,
        nonce,
        challenge,
        prompt,
      }),
      exchange: (code, verifier) => exchangeGoogleCode({ ...identity, code, verifier }),
      // The app for the account that just signed in, created on demand. This is
      // request handling — the callback is a request — so the registry latch is
      // still open.
      onAuthorized: (account, tokens) => registry.forAccount(account).adoptToken(tokens),
    },
  })

  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : error.message)
    process.exit(1)
  })

  server.listen(port, host, () => {
    console.log(banner({
      addresses: reachableAddresses(host),
      port,
      publicOrigin,
      dataDir,
      // Both read without an app. `registry.forAccount` would build one for a
      // stranger's account at startup — and after shutdown it throws — so the
      // banner reports the instance, not an account: the storage backend from
      // the shared secret store and the assistant backends this machine has.
      storageBackend: secrets.describe().backend,
      agents: createAgentRegistry({ env }).list(),
    }))
  })

  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2_000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // The composed pieces, not just the socket: this is the only place they are
  // wired together, so it is the only place a test can check that they were.
  return { server, registry, accounts, sessions }
}

if (require.main === module) main()

module.exports = { main, banner, parseArgs, defaultDataDir, isTailscaleAddress, reachableAddresses }
