'use strict'

const { app, BrowserWindow, nativeTheme, safeStorage, session, shell } = require('electron')
const path = require('node:path')

const { createApp } = require('../core/app.cjs')
const { createServer } = require('../server/index.cjs')

app.commandLine.appendSwitch('lang', 'en-US')

const APP_ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png')
const APP_DISPLAY_NAME = 'OpenFit'
// safeStorage keys are tied to the historical app name, so initialize Electron
// with the legacy identity before the secure storage backend is created.
const LEGACY_USER_DATA_NAME = 'pulseboard-fitbit-desktop'
app.setName(LEGACY_USER_DATA_NAME)

let mainWindow = null
let core = null
let httpServer = null
let startUrl = null
let allowedOrigin = null

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

// The desktop app embeds the same HTTP core the server exposes, bound to an
// ephemeral loopback port. One backend implementation, one renderer data path.
async function startBackend(dataDir) {
  core = createApp({ dataDir, safeStorage, clientVersion: app.getVersion() })
  const started = createServer({
    app: core,
    staticRoot: path.join(__dirname, '..', 'dist'),
    dataDir,
  })
  httpServer = started.server
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })
  const { port } = httpServer.address()
  allowedOrigin = `http://127.0.0.1:${port}`
  // The token round-trips once and comes back as an HttpOnly cookie.
  startUrl = `${allowedOrigin}/?token=${started.token}`
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })

  const devUrl = developmentUrl()
  void mainWindow.loadURL(devUrl ? devUrl.toString() : startUrl)
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(async () => {
  app.setName(APP_DISPLAY_NAME)
  if (process.platform === 'darwin') app.dock.setIcon(APP_ICON_PATH)
  const userData = process.env.OPENFIT_USER_DATA || path.join(app.getPath('appData'), LEGACY_USER_DATA_NAME)
  app.setPath('userData', userData)

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  // In development the Vite dev server owns the page and proxies /api to the
  // standalone core server started by `npm run dev:api`.
  if (!developmentUrl()) await startBackend(userData)

  createWindow()
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
  }
  void core?.dispose()
})
