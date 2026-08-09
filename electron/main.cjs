'use strict'

const { app, BrowserWindow, dialog, nativeTheme, safeStorage, session, shell } = require('electron')
const crypto = require('node:crypto')
const path = require('node:path')

const { sameToken } = require('../server/auth.cjs')
const { composeBackend } = require('../server/compose.cjs')
const { loadEnv } = require('../server/env.cjs')
const { PENDING_MAX_AGE_SECONDS, SIGN_IN_FLOW_PARAM } = require('../server/routes/login.cjs')
const { MAX_AGE_SECONDS } = require('../server/session.cjs')

app.commandLine.appendSwitch('lang', 'en-US')

const APP_ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png')
const APP_DISPLAY_NAME = 'OpenFit'
// safeStorage keys are tied to the historical app name, so initialize Electron
// with the legacy identity before the secure storage backend is created.
const LEGACY_USER_DATA_NAME = 'pulseboard-fitbit-desktop'
app.setName(LEGACY_USER_DATA_NAME)

// Fixed, not ephemeral. Google only accepts a redirect URI that was registered
// on the OAuth client in advance, port and all, and an arbitrary loopback port
// is a concession granted to *Desktop app* clients only. OpenFit's client is a
// Web application client — that is what docs/SELF_HOSTING.md has the user
// create — so the desktop host has to pick one port and keep it.
//
// 7788 is the server's default, 7789 is `npm run dev:api` and 5173 is Vite, so
// the desktop app can run alongside all three.
const DESKTOP_PORT = 7790
const SIGN_IN_PATH = '/auth/login'

// A sign-in this window did not start must not be able to sign this window in;
// see adoptDesktopSession. Matching the pending cookie's own lifetime means the
// outstanding flow never outlives the pending cookie that carries its id.
const SIGN_IN_WINDOW_MS = PENDING_MAX_AGE_SECONDS * 1000

// 32 bytes, so the id cannot be guessed by a process that can watch the port but
// not the handoff. `base64url` keeps it inside the alphabet /auth/login accepts.
const SIGN_IN_FLOW_BYTES = 32

// One fixed port means a second copy of the app could only ever fail with
// EADDRINUSE, so the second copy hands the window over instead of racing for it.
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()

let mainWindow = null
let backend = null
let httpServer = null
let startUrl = null
let allowedOrigin = null
// The one sign-in this window is waiting on: `{ id, startedAt }`, or null.
let outstandingSignIn = null

function developmentUrl() {
  if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) return null
  try {
    const parsed = new URL(process.env.VITE_DEV_SERVER_URL)
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) return null
    if (parsed.username || parsed.password) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Where the desktop host reads `OPENFIT_GOOGLE_CLIENT_ID` and its secret from.
 *
 * A packaged app runs out of `app.asar`. `path.resolve(__dirname, '..')` is a
 * read-only archive there, not a directory anyone can open in an editor, and
 * `.env` is not in electron-builder's `files` list so it is not even inside it.
 * `process.loadEnvFile` is native code that does not go through Electron's
 * asar-aware `fs` shim, so it could not read the file from the archive in any
 * case. The user data directory is the one path a packaged build can name that
 * the person running it can actually write to, and it is where their data
 * already lives.
 *
 * Unpackaged — `npm run dev`, `electron .` from a checkout — keeps the repo
 * `.env`, so one file still configures both hosts during development.
 */
function environmentFile(dataDir) {
  return app.isPackaged ? path.join(dataDir, '.env') : path.resolve(__dirname, '..', '.env')
}

/**
 * Starts the same backend `server/bin.cjs` runs, inside this process.
 *
 * `port`, `env` and `envPath` are parameters so the composition can be tested
 * without binding the registered port or reading the developer's own `.env`.
 * Production passes none of them.
 */
async function startBackend(dataDir, options = {}) {
  const { port = DESKTOP_PORT, env = process.env, envPath = environmentFile(dataDir) } = options

  // Before anything is created on disk, so a desktop app that cannot sign
  // anyone in leaves no data directory and no master key behind.
  const configured = loadEnv({ env, path: envPath })

  // The desktop host is reachable over plain-http loopback and nothing else, so
  // it cannot honour OPENFIT_PUBLIC_ORIGIN: `Secure` cookies would never be
  // sent back to it, and Google would deliver the callback to the public origin
  // instead of to this process. A shared .env that configures the server for a
  // tailnet is not an error here, but it is not silently obeyed either.
  if (configured.publicOrigin) {
    console.warn(`OPENFIT_PUBLIC_ORIGIN=${configured.publicOrigin} is ignored by the desktop app, which serves plain-http loopback only.`)
  }

  const localOrigin = `http://127.0.0.1:${port}`
  const composed = composeBackend({
    dataDir,
    staticRoot: path.join(__dirname, '..', 'dist'),
    // Blanked rather than omitted: core/app.cjs reads
    // `options.publicOrigin ?? env.OPENFIT_PUBLIC_ORIGIN`, so passing null on
    // its own would let a shared .env put an origin this app is not serving on
    // into every account's status.
    env: { ...env, OPENFIT_PUBLIC_ORIGIN: '' },
    clientVersion: app.getVersion(),
    clientId: configured.clientId,
    clientSecret: configured.clientSecret,
    publicOrigin: null,
    localOrigin,
    // The desktop host prefers the OS keychain. core/secrets.cjs decides
    // whether this backend is real; it rejects the Linux `basic_text` one.
    safeStorage,
    afterAuthorized: (account, context) => {
      // Never allowed to fail the callback. The token is already stored and the
      // browser already holds its session by this point, so throwing would make
      // server/routes/login.cjs answer 500 and report a failure that did not
      // happen. A window that did not pick the cookie up shows the sign-in page
      // again, which is the honest signal.
      return Promise.resolve()
        .then(() => adoptDesktopSession(account, context))
        .catch((error) => { console.error('Adopting the desktop session failed.', error) })
    },
  })

  backend = composed
  httpServer = composed.server
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })

  allowedOrigin = localOrigin
  // No token in the URL. The `?token=` cookie exchange was retired with the
  // bearer-token browser flow; an unauthenticated request for any page is
  // answered with the server-rendered sign-in page.
  startUrl = `${allowedOrigin}/`
  return { ...composed, startUrl }
}

function isTrustedRendererUrl(value) {
  try {
    const parsed = new URL(value)
    const devUrl = developmentUrl()
    if (devUrl && parsed.origin === devUrl.origin) return true
    return Boolean(allowedOrigin) && parsed.origin === allowedOrigin
  } catch {
    return false
  }
}

/**
 * The only URL this app ever hands to the user's browser, or `null`.
 *
 * Google's policy on embedded user agents makes the consent screen unreliable
 * inside a BrowserWindow, so sign-in is started in the real browser instead.
 * What gets handed over is this process's own loopback sign-in route and
 * nothing else: `shell.openExternal` will launch whatever handler the desktop
 * has registered for a scheme, so a rule that let the page choose the target
 * would be an arbitrary-URL opener running with the user's privileges — one
 * `location.href` away for anything that ever executes in the renderer.
 *
 * The check is on the parsed origin, never a prefix: `http://127.0.0.1:7790`
 * is a prefix of `http://127.0.0.1:7790.example.com`. Credentials are refused
 * because `new URL('http://a:b@127.0.0.1:7790/').origin` drops them, so they
 * would otherwise ride along into the browser. The development origin is
 * deliberately excluded — that backend belongs to another process and can set
 * no cookie this window will ever see.
 */
function desktopSignInUrl(value) {
  if (!allowedOrigin) return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.origin !== allowedOrigin) return null
  if (parsed.pathname !== SIGN_IN_PATH) return null
  if (parsed.username || parsed.password) return null
  return parsed.toString()
}

/**
 * Hands one sign-in to the browser and remembers *which* one.
 *
 * The flow id is minted here, appended to the handed-off URL, and signed into
 * the pending cookie by `/auth/login`, so it comes back through
 * `afterAuthorized` attached to the flow that actually completed. Without it the
 * window could only ask "was some sign-in started here recently", which any
 * other flow finishing first would satisfy.
 *
 * `set` rather than `append`: the URL came from the renderer, so a page that
 * navigated to `/auth/login?flow=<something it chose>` must not be able to
 * decide the id.
 *
 * A second click replaces the outstanding flow. The most recent click is the
 * one the user is waiting on, and two live ids would be two ways in.
 */
function openSignInExternally(url) {
  const target = desktopSignInUrl(url)
  if (!target) return false
  const id = crypto.randomBytes(SIGN_IN_FLOW_BYTES).toString('base64url')
  const handoff = new URL(target)
  handoff.searchParams.set(SIGN_IN_FLOW_PARAM, id)
  outstandingSignIn = { id, startedAt: Date.now() }
  void shell.openExternal(handoff.toString())
  return true
}

/**
 * Puts the session the callback just issued into this window's cookie jar.
 *
 * The sign-in finished in the user's browser, which has a cookie store of its
 * own: the `Set-Cookie` on the callback response is invisible to Electron no
 * matter which port it was set on — they are different user agents, and RFC
 * 6265's lack of port scoping does not bridge two cookie jars. The HTTP server,
 * though, runs inside this process, so the account is known here and the
 * equivalent cookie can be minted with the same signing key.
 *
 * Only for the sign-in this window started, identified by the flow id it minted
 * and `/auth/login` signed into that flow's pending cookie. Any process on the
 * machine can reach a loopback port: a second local user, or a page in the
 * user's ordinary browser navigating to `http://127.0.0.1:7790/auth/login`,
 * can complete a flow of its own at any time. "A sign-in was started here
 * recently" does not distinguish those from this one — it would hand the window
 * to whichever flow finished first, and drop the user's own.
 *
 * The outstanding flow is consumed only once it has been matched. A foreign or
 * expired callback must not be able to burn a live one and leave the genuine
 * sign-in with nothing to be recognised by.
 */
async function adoptDesktopSession(account, context) {
  const outstanding = outstandingSignIn
  if (!outstanding) return false
  if (Date.now() - outstanding.startedAt > SIGN_IN_WINDOW_MS) {
    outstandingSignIn = null
    return false
  }
  // Constant time, and false whenever either side is not a string: a callback
  // that carried no flow id at all arrives here as `null`.
  if (!sameToken(context?.flowId, outstanding.id)) return false

  outstandingSignIn = null
  if (!backend || !allowedOrigin) return false

  await session.defaultSession.cookies.set({
    url: `${allowedOrigin}/`,
    name: backend.sessions.cookieName,
    value: backend.sessions.sign({ sub: account.sub, email: account.email, epoch: account.epoch }),
    path: '/',
    httpOnly: true,
    // Plain-http loopback. A `Secure` cookie would not be sent back, and
    // server/compose.cjs derives the same answer for the browser's copy.
    secure: false,
    sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
  })

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(startUrl)
    mainWindow.focus()
  }
  return true
}

function createWindow() {
  nativeTheme.themeSource = 'dark'
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 930,
    minWidth: 960,
    minHeight: 680,
    icon: APP_ICON_PATH,
    show: false,
    backgroundColor: '#101112',
    title: APP_DISPLAY_NAME,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 15 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Nothing is opened in a new window. The sign-in route goes to the browser;
  // every other target is refused rather than forwarded, because "forward any
  // https URL" is the same arbitrary-URL opener with a narrower scheme.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openSignInExternally(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (openSignInExternally(url)) {
      event.preventDefault()
      return
    }
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })

  // A 302 out of /auth/login is a will-redirect, not a will-navigate: without
  // this the window would follow the server's redirect straight to Google's
  // consent screen, which is what the handoff above exists to avoid. Guarded
  // only once this process owns the backend — in development the page and the
  // API are separate processes, and following the redirect in the window is the
  // only way that window can reach Google at all.
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!allowedOrigin) return
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })

  const devUrl = developmentUrl()
  void mainWindow.loadURL(devUrl ? devUrl.toString() : startUrl)
  mainWindow.on('closed', () => { mainWindow = null })
}

// A desktop app has no terminal to print to, so the one thing that stops it
// from starting has to be said in a dialog, with the path to the file to fix.
function reportFatal(error, dataDir) {
  console.error('OpenFit could not start.', error)
  const detail = error?.code === 'EADDRINUSE'
    ? `Port ${DESKTOP_PORT} is already in use. OpenFit may already be running, or another program has taken the port its Google sign-in is registered against.`
    : (error instanceof Error ? error.message : String(error))
  dialog.showErrorBox('OpenFit could not start', `${detail}\n\nConfiguration file: ${environmentFile(dataDir)}`)
  app.quit()
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  app.setName(APP_DISPLAY_NAME)
  if (process.platform === 'darwin') app.dock.setIcon(APP_ICON_PATH)
  const userData = process.env.OPENFIT_USER_DATA || path.join(app.getPath('appData'), LEGACY_USER_DATA_NAME)
  app.setPath('userData', userData)

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  // In development the Vite dev server owns the page and proxies /api to the
  // standalone core server started by `npm run dev:api`.
  if (!developmentUrl()) {
    try {
      await startBackend(userData)
    } catch (error) {
      reportFatal(error, userData)
      return
    }
  }

  createWindow()
})

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (httpServer) {
    try { httpServer.close() } catch { /* already closing */ }
    try { httpServer.closeAllConnections() } catch { /* nothing open */ }
  }
  // Not left to the server's `close` event: a keep-alive connection can hold
  // that back past the point Electron tears the process down, and every account
  // app owns an assistant subprocess that has to be told to stop.
  void backend?.registry.disposeAll()
})

// Exported for electron/main.test.ts. Nothing in the app requires this file.
module.exports = {
  startBackend,
  isTrustedRendererUrl,
  desktopSignInUrl,
  openSignInExternally,
  adoptDesktopSession,
  environmentFile,
  DESKTOP_PORT,
  SIGN_IN_PATH,
}
