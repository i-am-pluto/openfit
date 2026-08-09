'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_HEALTH_CONTEXT_CHARS = 500_000
const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024

const { HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS } = require('./agent-common.cjs')

class CodexServiceError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'CodexServiceError'
    this.code = code
  }
}

function sanitizeMessage(value, fallback = 'Codex app-server error.') {
  const source = String(value || fallback)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie)\s*[=:]\s*)[^\s,;}]+/gi, '$1[redacted]')
  return (source.trim() || fallback).slice(0, 600)
}

function serviceError(error, fallback, code) {
  if (error instanceof CodexServiceError) return error
  return new CodexServiceError(sanitizeMessage(fallback), code)
}

function abortError(message = 'The Codex turn was cancelled.') {
  const error = new CodexServiceError(message, 'CODEX_TURN_CANCELLED')
  error.name = 'AbortError'
  return error
}

function isPathLike(value, pathImpl) {
  return pathImpl.isAbsolute(value) || value.includes('/') || value.includes('\\')
}

function executableExtensions(env, platform) {
  if (platform !== 'win32') return ['']
  const extensions = String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)
  return ['', ...extensions.map((extension) => extension.toLowerCase()), ...extensions.map((extension) => extension.toUpperCase())]
}

function isExecutableFile(candidate, fsImpl, platform) {
  try {
    const mode = platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK
    fsImpl.accessSync(candidate, mode)
    return fsImpl.statSync(candidate).isFile()
  } catch {
    return false
  }
}

function resolveCodexBinary(options = {}) {
  const env = options.env || process.env
  const fsImpl = options.fs || fs
  const pathImpl = options.path || path
  const platform = options.platform || process.platform
  const home = options.homedir || os.homedir()
  const candidates = []
  const seen = new Set()
  const extensions = executableExtensions(env, platform)

  const add = (candidate) => {
    if (!candidate) return
    const normalized = pathImpl.normalize(String(candidate).replace(/^['"]|['"]$/g, ''))
    if (!seen.has(normalized)) {
      seen.add(normalized)
      candidates.push(normalized)
    }
  }

  const addFromPath = (command) => {
    const pathEntries = String(env.PATH || '').split(pathImpl.delimiter).filter(Boolean)
    for (const entry of pathEntries) {
      const directory = entry.replace(/^['"]|['"]$/g, '')
      for (const extension of extensions) add(pathImpl.join(directory, `${command}${extension}`))
    }
  }

  const explicit = String(env.CODEX_BINARY || '').trim()
  if (explicit) {
    if (isPathLike(explicit, pathImpl)) add(pathImpl.resolve(explicit))
    else addFromPath(explicit)
  }

  addFromPath('codex')

  if (platform === 'darwin') {
    const applicationRoots = ['/Applications', pathImpl.join(home, 'Applications')]
    const appNames = ['Codex.app']
    const resourcePaths = [
      ['Contents', 'Resources', 'codex'],
      ['Contents', 'Resources', 'bin', 'codex'],
    ]
    for (const root of applicationRoots) {
      for (const appName of appNames) {
        for (const resourcePath of resourcePaths) add(pathImpl.join(root, appName, ...resourcePath))
      }
    }
  }

  return candidates.find((candidate) => isExecutableFile(candidate, fsImpl, platform)) || null
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Number(value) : fallback
}

function serializeHealthContext(value, maxChars) {
  let serialized
  try {
    if (typeof value === 'string') serialized = value.trim()
    else if (value === undefined || value === null) serialized = '{}'
    else serialized = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)
  } catch {
    throw new CodexServiceError('The health context could not be serialized.', 'CODEX_INVALID_HEALTH_CONTEXT')
  }
  if (typeof serialized !== 'string') serialized = String(serialized)
  if (serialized.length > maxChars) {
    throw new CodexServiceError(`The compact health context exceeds ${maxChars} characters.`, 'CODEX_HEALTH_CONTEXT_TOO_LARGE')
  }
  return serialized
}

function normalizeTurnInput(input, maxContextChars) {
  if (!input || typeof input !== 'object') {
    throw new CodexServiceError('startTurn expects an options object.', 'CODEX_INVALID_TURN')
  }
  const text = String(input.text || '').trim()
  if (!text) throw new CodexServiceError('A non-empty user message is required.', 'CODEX_INVALID_TURN')
  const context = serializeHealthContext(input.healthContext ?? input.context, maxContextChars)
  return {
    text,
    context,
    onDelta: typeof input.onDelta === 'function' ? input.onDelta : null,
    onComplete: typeof input.onComplete === 'function' ? input.onComplete : null,
    onError: typeof input.onError === 'function' ? input.onError : null,
    signal: input.signal || null,
  }
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class CodexService {
  constructor(options = {}) {
    this._spawn = options.spawn || childProcess.spawn
    this._env = options.env || process.env
    this._cwd = options.cwd || process.cwd()
    this._resolveBinary = options.resolveBinary || (() => resolveCodexBinary({
      env: options.binary ? { ...this._env, CODEX_BINARY: options.binary } : this._env,
    }))
    this._requestTimeoutMs = positiveNumber(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
    this._turnTimeoutMs = positiveNumber(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS)
    this._maxHealthContextChars = positiveNumber(options.maxHealthContextChars, DEFAULT_MAX_HEALTH_CONTEXT_CHARS)
    this._terminationGraceMs = positiveNumber(options.terminationGraceMs, 1_000)
    this._clientInfo = {
      name: String(options.clientName || 'openfit_desktop'),
      title: String(options.clientTitle || 'OpenFit'),
      version: String(options.clientVersion || '1.0.0'),
    }
    this._threadOptions = {
      model: options.model || null,
      ephemeral: options.ephemeral !== false,
      developerInstructions: String(options.developerInstructions || HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS),
    }
    this._onStatusChange = typeof options.onStatusChange === 'function' ? options.onStatusChange : null

    this._state = 'idle'
    this._lastError = null
    this._binaryPath = null
    this._binaryResolutionAttempted = false
    this._child = null
    this._initialized = false
    this._stdoutBuffer = ''
    this._stderrBytes = 0
    this._nextRequestId = 1
    this._pending = new Map()
    this._threadId = null
    this._active = null
    this._startPromise = null
    this._threadPromise = null
    this._generation = 0
    this._resetting = false
    this._disposed = false
  }

  getStatus() {
    return {
      state: this._state,
      available: this._binaryResolutionAttempted ? Boolean(this._binaryPath) : null,
      connected: Boolean(this._child && this._initialized),
      busy: Boolean(this._active),
      threadId: this._threadId,
      turnId: this._active?.turnId || null,
      lastError: this._lastError,
    }
  }

  async start() {
    this._assertUsable()
    await this._ensureThread()
    return this.getStatus()
  }

  startTurn(input) {
    let normalized
    try {
      this._assertUsable()
      if (this._resetting) throw new CodexServiceError('The Codex conversation is resetting.', 'CODEX_RESETTING')
      if (this._active) throw new CodexServiceError('A Codex turn is already running.', 'CODEX_TURN_IN_PROGRESS')
      normalized = normalizeTurnInput(input, this._maxHealthContextChars)
    } catch (error) {
      return Promise.reject(error)
    }

    const deferred = createDeferred()
    const active = {
      ...normalized,
      deferred,
      phase: 'preparing',
      threadId: this._threadId,
      turnId: null,
      streamedText: '',
      finalText: null,
      notificationError: null,
      cancelRequested: Boolean(normalized.signal?.aborted),
      abortHandler: null,
      timer: null,
      interruptPromise: null,
    }
    this._active = active
    this._setState('starting')

    if (active.signal && !active.signal.aborted && typeof active.signal.addEventListener === 'function') {
      active.abortHandler = () => {
        void this.cancelTurn().catch((error) => {
          if (this._active === active) this._finishActiveError(active, serviceError(error, 'Could not interrupt the Codex turn.', 'CODEX_INTERRUPT_FAILED'))
        })
      }
      active.signal.addEventListener('abort', active.abortHandler, { once: true })
    }

    void this._beginTurn(active)
    return deferred.promise
  }

  async cancelTurn() {
    const active = this._active
    if (!active) return false
    active.cancelRequested = true

    if (active.phase === 'preparing') {
      this._finishActiveError(active, abortError())
      return true
    }
    if (!active.turnId) return true
    await this._interrupt(active)
    return true
  }

  async reset() {
    this._assertUsable()
    if (this._resetting) return this.getStatus()
    this._resetting = true
    const reason = abortError('The Codex conversation was reset.')
    try {
      const active = this._active
      if (active?.turnId && this._child) {
        try { await this._request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, Math.min(this._requestTimeoutMs, 2_000)) } catch { /* best effort */ }
      }
      if (this._active) this._finishActiveError(this._active, reason, true)
      this._generation += 1
      this._shutdownConnection(reason)
      this._threadId = null
      this._threadPromise = null
      this._startPromise = null
      this._setState('idle')
      return this.getStatus()
    } finally {
      this._resetting = false
    }
  }

  async dispose() {
    if (this._disposed) return
    this._disposed = true
    const reason = abortError('The Codex service was disposed.')
    const active = this._active
    if (active?.turnId && this._child) {
      try { await this._request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, Math.min(this._requestTimeoutMs, 1_000)) } catch { /* best effort */ }
    }
    if (this._active) this._finishActiveError(this._active, reason, true)
    this._generation += 1
    this._shutdownConnection(reason)
    this._threadId = null
    this._threadPromise = null
    this._startPromise = null
    this._setState('disposed')
  }

  _assertUsable() {
    if (this._disposed) throw new CodexServiceError('The Codex service has been disposed.', 'CODEX_DISPOSED')
  }

  async _beginTurn(active) {
    try {
      if (active.cancelRequested) throw abortError()
      await this._ensureThread()
      if (this._active !== active) return
      active.threadId = this._threadId
      if (active.cancelRequested) throw abortError()
      active.phase = 'starting'

      const response = await this._request('turn/start', {
        threadId: active.threadId,
        input: [
          {
            type: 'text',
            text: `<OPENFIT_HEALTH_CONTEXT>\n${active.context}\n</OPENFIT_HEALTH_CONTEXT>`,
            text_elements: [],
          },
          { type: 'text', text: active.text, text_elements: [] },
        ],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      })

      if (this._active !== active) return
      const turnId = response?.turn?.id
      if (!turnId) throw new CodexServiceError('Codex app-server returned an invalid turn.', 'CODEX_PROTOCOL_ERROR')
      if (active.turnId && active.turnId !== turnId) {
        throw new CodexServiceError('Codex app-server returned a mismatched turn.', 'CODEX_PROTOCOL_ERROR')
      }
      active.turnId = turnId
      active.phase = 'running'
      this._setState('running')
      this._armTurnTimeout(active)
      if (active.cancelRequested) await this._interrupt(active)
    } catch (error) {
      if (this._active === active) {
        this._finishActiveError(active, serviceError(error, 'Could not start the Codex turn.', 'CODEX_TURN_START_FAILED'))
      }
    }
  }

  async _ensureThread() {
    if (this._threadId) return this._threadId
    if (this._threadPromise) return this._threadPromise
    const generation = this._generation
    const promise = (async () => {
      await this._ensureProcess()
      if (generation !== this._generation || this._disposed) throw abortError('Codex startup was cancelled.')
      const params = {
        cwd: this._cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions: this._threadOptions.developerInstructions,
        ephemeral: this._threadOptions.ephemeral,
      }
      if (this._threadOptions.model) params.model = this._threadOptions.model
      const response = await this._request('thread/start', params)
      const threadId = response?.thread?.id
      if (!threadId) throw new CodexServiceError('Codex app-server returned an invalid thread.', 'CODEX_PROTOCOL_ERROR')
      if (generation !== this._generation || this._disposed) throw abortError('Codex startup was cancelled.')
      this._threadId = threadId
      this._setState('ready')
      return threadId
    })()
    this._threadPromise = promise
    try {
      return await promise
    } catch (error) {
      if (generation === this._generation && !this._disposed) {
        const safe = serviceError(error, 'Could not create the Codex conversation.', 'CODEX_THREAD_START_FAILED')
        if (!this._child) this._setState('error', safe)
        throw safe
      }
      throw error
    } finally {
      if (this._threadPromise === promise) this._threadPromise = null
    }
  }

  async _ensureProcess() {
    if (this._child && this._initialized) return
    if (this._startPromise) return this._startPromise
    const generation = this._generation
    const promise = (async () => {
      this._setState('starting')
      this._binaryResolutionAttempted = true
      let binary
      try { binary = await this._resolveBinary() } catch { binary = null }
      if (!binary) {
        this._binaryPath = null
        throw new CodexServiceError('Codex CLI was not found. Install Codex Desktop or set CODEX_BINARY to the Codex executable.', 'CODEX_BINARY_NOT_FOUND')
      }
      this._binaryPath = String(binary)
      if (generation !== this._generation || this._disposed) throw abortError('Codex startup was cancelled.')

      let child
      try {
        child = this._spawn(this._binaryPath, ['app-server'], {
          cwd: this._cwd,
          env: this._env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        const code = /^[A-Z0-9_-]+$/i.test(String(error?.code || '')) ? ` (${error.code})` : ''
        throw new CodexServiceError(`Could not start Codex app-server${code}.`, 'CODEX_SPAWN_FAILED')
      }
      if (!child?.stdin || !child?.stdout || !child?.stderr) {
        throw new CodexServiceError('Codex app-server did not provide stdio streams.', 'CODEX_SPAWN_FAILED')
      }
      this._child = child
      this._initialized = false
      this._stdoutBuffer = ''
      this._stderrBytes = 0
      this._attachChild(child)

      await this._request('initialize', {
        clientInfo: this._clientInfo,
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      }, this._requestTimeoutMs)
      if (this._child !== child || generation !== this._generation || this._disposed) throw abortError('Codex startup was cancelled.')
      this._notify('initialized')
      this._initialized = true
    })()
    this._startPromise = promise
    try {
      await promise
    } catch (error) {
      const safe = serviceError(error, 'Could not initialize Codex app-server.', 'CODEX_INITIALIZE_FAILED')
      if (generation === this._generation && !this._disposed) {
        if (this._child) this._shutdownConnection(safe)
        this._setState('error', safe)
      }
      throw safe
    } finally {
      if (this._startPromise === promise) this._startPromise = null
    }
  }

  _attachChild(child) {
    child.stdout.setEncoding?.('utf8')
    child.stdout.on('data', (chunk) => this._handleStdout(child, chunk))
    child.stdout.on('error', () => this._handleFatal(child, new CodexServiceError('Codex app-server stdout failed.', 'CODEX_TRANSPORT_ERROR')))
    child.stdin.on?.('error', () => this._handleFatal(child, new CodexServiceError('Codex app-server stdin failed.', 'CODEX_TRANSPORT_ERROR')))
    child.stderr.on('data', (chunk) => {
      if (this._child === child) this._stderrBytes += Buffer.byteLength(chunk)
    })
    child.on('error', (error) => {
      const code = /^[A-Z0-9_-]+$/i.test(String(error?.code || '')) ? ` (${error.code})` : ''
      this._handleFatal(child, new CodexServiceError(`Could not start Codex app-server${code}.`, 'CODEX_SPAWN_FAILED'))
    })
    child.on('exit', (code, signal) => {
      if (this._child !== child) return
      const detail = Number.isInteger(code) ? `exit code ${code}` : signal ? `signal ${String(signal).slice(0, 32)}` : 'an unknown reason'
      this._handleFatal(child, new CodexServiceError(`Codex app-server stopped unexpectedly (${detail}).`, 'CODEX_PROCESS_EXITED'))
    })
  }

  _handleStdout(child, chunk) {
    if (this._child !== child) return
    this._stdoutBuffer += String(chunk)
    if (Buffer.byteLength(this._stdoutBuffer) > MAX_PROTOCOL_LINE_BYTES && !this._stdoutBuffer.includes('\n')) {
      this._handleFatal(child, new CodexServiceError('Codex app-server sent an oversized protocol message.', 'CODEX_PROTOCOL_ERROR'))
      return
    }

    let newline
    while ((newline = this._stdoutBuffer.indexOf('\n')) >= 0) {
      let line = this._stdoutBuffer.slice(0, newline)
      this._stdoutBuffer = this._stdoutBuffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line.trim()) continue
      if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
        this._handleFatal(child, new CodexServiceError('Codex app-server sent an oversized protocol message.', 'CODEX_PROTOCOL_ERROR'))
        return
      }
      let message
      try { message = JSON.parse(line) } catch {
        this._handleFatal(child, new CodexServiceError('Codex app-server sent malformed JSONL.', 'CODEX_PROTOCOL_ERROR'))
        return
      }
      try { this._handleMessage(message) } catch {
        this._handleFatal(child, new CodexServiceError('Codex app-server sent an invalid protocol message.', 'CODEX_PROTOCOL_ERROR'))
        return
      }
    }
  }

  _handleMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new CodexServiceError('Invalid Codex protocol message.', 'CODEX_PROTOCOL_ERROR')
    }
    if (typeof message.method === 'string') {
      if (Object.prototype.hasOwnProperty.call(message, 'id')) this._handleServerRequest(message)
      else this._handleNotification(message.method, message.params || {})
      return
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
      throw new CodexServiceError('Invalid Codex protocol response.', 'CODEX_PROTOCOL_ERROR')
    }
    const key = String(message.id)
    const pending = this._pending.get(key)
    if (!pending) return
    this._pending.delete(key)
    clearTimeout(pending.timer)
    if (message.error) {
      const detail = sanitizeMessage(message.error.message, 'Unknown request error.')
      pending.reject(new CodexServiceError(`Codex app-server rejected ${pending.method}: ${detail}`, 'CODEX_RPC_ERROR'))
    } else {
      pending.resolve(message.result)
    }
  }

  _handleServerRequest(message) {
    const method = message.method
    let result
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        result = { decision: 'decline' }
        break
      case 'applyPatchApproval':
      case 'execCommandApproval':
        result = { decision: 'denied' }
        break
      case 'item/permissions/requestApproval':
        result = { permissions: {}, scope: 'turn' }
        break
      case 'item/tool/requestUserInput':
        result = { answers: {} }
        break
      case 'item/tool/call':
        result = {
          contentItems: [{ type: 'inputText', text: 'Tool calls are disabled in the OpenFit health assistant.' }],
          success: false,
        }
        break
      case 'mcpServer/elicitation/request':
        result = { action: 'decline', content: null, _meta: null }
        break
      default:
        this._write({ id: message.id, error: { code: -32601, message: 'Server request is not supported by this client.' } })
        return
    }
    this._write({ id: message.id, result })
  }

  _handleNotification(method, params) {
    const active = this._active
    if (!active) return

    if (method === 'turn/started' && this._notificationMatches(active, params)) {
      active.phase = 'running'
      this._setState('running')
      return
    }

    if (method === 'item/agentMessage/delta' && this._notificationMatches(active, params)) {
      const delta = typeof params.delta === 'string' ? params.delta : ''
      if (!delta) return
      active.streamedText += delta
      this._safeCallback(active.onDelta, delta, {
        threadId: active.threadId,
        turnId: active.turnId,
        itemId: params.itemId || null,
      })
      return
    }

    if (method === 'item/completed' && this._notificationMatches(active, params)) {
      const item = params.item
      if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        if (item.phase === 'final_answer' || item.phase == null || active.finalText === null) active.finalText = item.text
      }
      return
    }

    if (method === 'error' && this._notificationMatches(active, params)) {
      if (params.willRetry !== true) {
        active.notificationError = new CodexServiceError(sanitizeMessage(params.error?.message, 'The Codex turn failed.'), 'CODEX_TURN_FAILED')
      }
      return
    }

    if (method === 'turn/completed' && this._notificationMatches(active, params)) {
      const turn = params.turn || {}
      const status = turn.status || 'completed'
      if (status === 'failed') {
        const error = active.notificationError || new CodexServiceError(sanitizeMessage(turn.error?.message, 'The Codex turn failed.'), 'CODEX_TURN_FAILED')
        this._finishActiveError(active, error)
        return
      }
      const result = {
        threadId: active.threadId,
        turnId: active.turnId || turn.id || null,
        status,
        text: active.finalText ?? active.streamedText,
      }
      this._finishActiveSuccess(active, result)
    }
  }

  _notificationMatches(active, params) {
    if (params.threadId && active.threadId && params.threadId !== active.threadId) return false
    const incomingTurnId = params.turnId || params.turn?.id || null
    if (incomingTurnId && active.turnId && incomingTurnId !== active.turnId) return false
    if (incomingTurnId && !active.turnId) active.turnId = incomingTurnId
    return true
  }

  _safeCallback(callback, ...args) {
    if (!callback) return
    try { callback(...args) } catch { /* consumer callbacks cannot break the protocol loop */ }
  }

  _armTurnTimeout(active) {
    clearTimeout(active.timer)
    active.timer = setTimeout(() => {
      if (this._active !== active) return
      const error = new CodexServiceError('The Codex turn timed out.', 'CODEX_TURN_TIMEOUT')
      if (this._child) this._handleFatal(this._child, error)
      else this._finishActiveError(active, error)
    }, this._turnTimeoutMs)
    active.timer.unref?.()
  }

  _cleanupActive(active) {
    clearTimeout(active.timer)
    if (active.signal && active.abortHandler && typeof active.signal.removeEventListener === 'function') {
      active.signal.removeEventListener('abort', active.abortHandler)
    }
    if (this._active === active) this._active = null
  }

  _finishActiveSuccess(active, result) {
    if (this._active !== active) return
    this._cleanupActive(active)
    this._setState(this._child && this._threadId ? 'ready' : 'idle')
    this._safeCallback(active.onComplete, result)
    active.deferred.resolve(result)
  }

  _finishActiveError(active, error, preserveState = false) {
    if (this._active !== active) return
    const safe = serviceError(error, 'The Codex turn failed.', 'CODEX_TURN_FAILED')
    this._cleanupActive(active)
    if (!preserveState) {
      const nextState = this._child && this._threadId ? 'ready' : this._child ? 'starting' : 'error'
      this._setState(nextState, safe)
    }
    this._safeCallback(active.onError, safe)
    active.deferred.reject(safe)
  }

  async _interrupt(active) {
    if (active.interruptPromise) return active.interruptPromise
    if (!active.threadId || !active.turnId) return false
    const promise = this._request('turn/interrupt', {
      threadId: active.threadId,
      turnId: active.turnId,
    }, this._requestTimeoutMs).then(() => true)
    active.interruptPromise = promise
    try { return await promise } finally {
      if (active.interruptPromise === promise) active.interruptPromise = null
    }
  }

  _request(method, params, timeoutMs = this._requestTimeoutMs) {
    const child = this._child
    if (!child) return Promise.reject(new CodexServiceError('Codex app-server is not connected.', 'CODEX_NOT_CONNECTED'))
    const id = this._nextRequestId++
    const deferred = createDeferred()
    const timer = setTimeout(() => {
      const pending = this._pending.get(String(id))
      if (!pending) return
      this._pending.delete(String(id))
      const error = new CodexServiceError(`Codex app-server timed out while handling ${method}.`, 'CODEX_REQUEST_TIMEOUT')
      pending.reject(error)
      this._handleFatal(child, error)
    }, positiveNumber(timeoutMs, this._requestTimeoutMs))
    timer.unref?.()
    this._pending.set(String(id), { ...deferred, timer, method })
    try {
      this._write({ method, id, params })
    } catch (error) {
      clearTimeout(timer)
      this._pending.delete(String(id))
      deferred.reject(serviceError(error, 'Could not write to Codex app-server.', 'CODEX_TRANSPORT_ERROR'))
    }
    return deferred.promise
  }

  _notify(method, params) {
    this._write(params === undefined ? { method } : { method, params })
  }

  _write(message) {
    const child = this._child
    if (!child?.stdin || child.stdin.destroyed || child.stdin.writable === false) {
      throw new CodexServiceError('Codex app-server stdin is unavailable.', 'CODEX_TRANSPORT_ERROR')
    }
    const line = `${JSON.stringify(message)}\n`
    child.stdin.write(line, (error) => {
      if (error) this._handleFatal(child, new CodexServiceError('Could not write to Codex app-server.', 'CODEX_TRANSPORT_ERROR'))
    })
  }

  _handleFatal(child, error) {
    if (this._child !== child) return
    const safe = serviceError(error, 'Codex app-server stopped unexpectedly.', 'CODEX_PROCESS_EXITED')
    this._shutdownConnection(safe)
    this._threadId = null
    this._threadPromise = null
    this._setState('error', safe)
    if (this._active) this._finishActiveError(this._active, safe, true)
  }

  _shutdownConnection(error) {
    const child = this._child
    this._child = null
    this._initialized = false
    this._stdoutBuffer = ''
    this._rejectPending(error)
    if (!child) return
    try { child.stdin.end() } catch { /* already closed */ }
    try { child.kill('SIGTERM') } catch { /* already exited */ }
    const timer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
      }
    }, this._terminationGraceMs)
    timer.unref?.()
  }

  _rejectPending(error) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this._pending.clear()
  }

  _setState(state, error) {
    this._state = state
    if (error) this._lastError = sanitizeMessage(error.message)
    else if (state === 'idle' || state === 'ready' || state === 'running') this._lastError = null
    this._safeCallback(this._onStatusChange, this.getStatus())
  }
}

function createCodexService(options) {
  return new CodexService(options)
}

module.exports = {
  CodexService,
  CodexServiceError,
  HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS,
  createCodexService,
  resolveCodexBinary,
  __test: {
    normalizeTurnInput,
    sanitizeMessage,
    serializeHealthContext,
  },
}
