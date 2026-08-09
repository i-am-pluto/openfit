'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createApp } = require('../core/app.cjs')
const { createServer } = require('./index.cjs')

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

function banner({ addresses, port, token, publicOrigin, dataDir, storageBackend, agents }) {
  const lines = [
    '',
    '  OpenFit server',
    `  data     ${dataDir}`,
    `  storage  ${storageBackend}`,
    `  agents   ${agents.map((agent) => `${agent.id}${agent.selected ? '*' : ''}${agent.available ? '' : ' (unavailable)'}`).join(', ') || 'none'}`,
    '',
    '  Open one of these (the token is stored as a cookie on first visit):',
    ...addresses.map((address) => `    http://${address}:${port}/?token=${token}`),
  ]
  if (publicOrigin) lines.push('', `  OAuth callback origin: ${publicOrigin}/oauth/callback`)
  else lines.push('', '  Connecting a health account must be done from a browser on this machine.', '  Set OPENFIT_PUBLIC_ORIGIN=https://<host>.ts.net to allow it from other devices.')
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

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  // In development the Vite dev server serves the page and proxies /api here.
  const devMode = args.dev === 'true' || args.dev === '' || env.OPENFIT_DEV === '1'
  if (!devMode && !fs.existsSync(path.join(staticRoot, 'index.html'))) {
    console.error('dist/index.html is missing. Run `npm run build` first.')
    process.exit(1)
  }

  let app
  try {
    app = createApp({ dataDir, env, clientVersion: require('../package.json').version })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const tokenOverride = env.OPENFIT_SERVER_TOKEN
    || (args['token-file'] ? fs.readFileSync(args['token-file'], 'utf8').trim() : null)

  const { server, token } = createServer({ app, staticRoot, dataDir, token: tokenOverride })

  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : error.message)
    process.exit(1)
  })

  server.listen(port, host, () => {
    console.log(banner({
      addresses: reachableAddresses(host),
      port,
      token,
      publicOrigin: app.publicOrigin,
      dataDir,
      storageBackend: app.getStatus().storageBackend,
      agents: app.assistant.listAgents(),
    }))
  })

  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2_000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return server
}

if (require.main === module) main()

module.exports = { main, parseArgs, defaultDataDir, isTailscaleAddress, reachableAddresses }
