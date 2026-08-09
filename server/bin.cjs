'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createAgentRegistry } = require('../core/agents/index.cjs')
const { normalizePublicOrigin } = require('../core/app.cjs')
const { composeBackend } = require('./compose.cjs')
const { loadEnv } = require('./env.cjs')

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
  let configured = null
  try {
    configured = loadEnv({ env, path: ENV_FILE })
    // Validated here rather than at the first request: createApp would otherwise
    // reject a non-https origin from inside a request handler, long after the
    // operator stopped watching, and `secure` cookies would already be set on a
    // plain-http origin where no browser will send them back.
    publicOrigin = normalizePublicOrigin(configured.publicOrigin)
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

  const tokenOverride = env.OPENFIT_SERVER_TOKEN
    || (args['token-file'] ? fs.readFileSync(args['token-file'], 'utf8').trim() : null)

  // Everything below the configuration check is shared with the desktop host.
  // server/compose.cjs creates the data directory, the instance secret store,
  // the accounts index, the per-account registry, the session store and the
  // HTTP server, and it is the only place any of that is wired.
  const { server, secrets, registry, accounts, sessions } = composeBackend({
    dataDir,
    staticRoot,
    env,
    clientVersion: require('../package.json').version,
    clientId: configured.clientId,
    clientSecret: configured.clientSecret,
    publicOrigin,
    localOrigin: `http://127.0.0.1:${port}`,
    token: tokenOverride,
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

  // The composed pieces, not just the socket: a test that only had the server
  // could not tell that the registry, the accounts index and the session store
  // are the same ones the login routes were handed.
  return { server, registry, accounts, sessions }
}

if (require.main === module) main()

module.exports = { main, banner, parseArgs, defaultDataDir, isTailscaleAddress, reachableAddresses }
