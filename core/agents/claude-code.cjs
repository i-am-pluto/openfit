'use strict'

const childProcess = require('node:child_process')
const nodeCrypto = require('node:crypto')

const {
  HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS,
  MAX_HEALTH_CONTEXT_CHARS,
  resolveBinary,
  sanitizeMessage,
  serializeHealthContext,
} = require('./agent-common.cjs')

const DEFAULT_MODEL = 'opus'
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000
const DEFAULT_TERMINATION_GRACE_MS = 1_000
const MAX_PROTOCOL_BUFFER_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024

// The assistant reasons over supplied text only. Every built-in tool is denied,
// slash commands are off, MCP is emptied, and user/project settings are not
// loaded, so the turn cannot touch the filesystem, run commands, or reach the
// network. This mirrors the Codex bridge's read-only, no-network sandbox.
const DENIED_TOOLS = [
  'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite',
]
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}'

class ClaudeCodeError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ClaudeCodeError'
    this.code = code
  }
}

function abortError() {
  const error = new ClaudeCodeError('The Claude Code turn was cancelled.', 'CLAUDE_TURN_CANCELLED')
  error.name = 'AbortError'
  return error
}

function looksUnauthorized(message) {
  return /unauthorized|not logged in|please log in|authentication|invalid api key|\/login/i.test(String(message || ''))
}

/**
 * Parses the `--output-format stream-json` NDJSON stream.
 *
 * Observed line shapes (claude 2.1.x):
 *   {"type":"system","subtype":"init","session_id":"..."}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"...","session_id":"..."}
 *
 * Unknown types are ignored on purpose so a CLI upgrade that adds an event type
 * does not break a turn.
 */
function createStreamJsonParser(handlers = {}) {
  const onDelta = handlers.onDelta || (() => {})
  const onMessageText = handlers.onMessageText || (() => {})
  const onResult = handlers.onResult || (() => {})
  const onInit = handlers.onInit || (() => {})
  const onOverflow = handlers.onOverflow || (() => {})
  let buffer = ''
  let overflowed = false

  function handle(message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'system' && message.subtype === 'init') {
      onInit({ sessionId: message.session_id || null })
      return
    }
    if (message.type === 'stream_event') {
      const event = message.event
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        onDelta(event.delta.text)
      }
      return
    }
    if (message.type === 'assistant') {
      const blocks = Array.isArray(message.message?.content) ? message.message.content : []
      const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text || '').join('')
      if (text) onMessageText(text)
      return
    }
    if (message.type === 'result') {
      onResult({
        isError: message.is_error === true,
        subtype: typeof message.subtype === 'string' ? message.subtype : null,
        text: typeof message.result === 'string' ? message.result : '',
        sessionId: message.session_id || null,
      })
    }
  }

  function consume(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      return // non-JSON noise on stdout is not fatal
    }
    handle(message)
  }

  return {
    push(chunk) {
      if (overflowed) return
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_PROTOCOL_BUFFER_BYTES) {
        overflowed = true
        buffer = ''
        onOverflow()
        return
      }
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        consume(line)
      }
    },
    end() {
      if (!overflowed && buffer) consume(buffer)
      buffer = ''
    },
  }
}

class ClaudeCodeService {
  constructor(options = {}) {
    this._spawn = options.spawn || childProcess.spawn
    this._env = options.env || process.env
    this._cwd = options.cwd || process.cwd()
    this._model = options.model || DEFAULT_MODEL
    this._randomUUID = options.randomUUID || nodeCrypto.randomUUID.bind(nodeCrypto)
    this._resolveBinary = options.resolveBinary || (() => resolveBinary('claude', { env: this._env, envVar: 'CLAUDE_BINARY' }))
    this._instructions = String(options.developerInstructions || HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS)
    this._turnTimeoutMs = Number(options.turnTimeoutMs) > 0 ? Number(options.turnTimeoutMs) : DEFAULT_TURN_TIMEOUT_MS
    this._terminationGraceMs = Number(options.terminationGraceMs) > 0 ? Number(options.terminationGraceMs) : DEFAULT_TERMINATION_GRACE_MS
    this._maxHealthContextChars = Number(options.maxHealthContextChars) > 0 ? Number(options.maxHealthContextChars) : MAX_HEALTH_CONTEXT_CHARS

    this._binaryPath = null
    this._binaryResolved = false
    this._sessionId = null
    this._resumable = false
    this._active = null
    this._lastError = null
    this._unauthorized = false
    this._disposed = false
  }

  get id() { return 'claude-code' }

  get label() { return 'Claude Code' }

  _binary() {
    if (!this._binaryResolved) {
      this._binaryPath = this._resolveBinary() || null
      this._binaryResolved = true
    }
    return this._binaryPath
  }

  getStatus() {
    const available = Boolean(this._binary())
    return {
      id: this.id,
      label: this.label,
      available,
      connected: Boolean(this._active),
      authenticated: available && !this._unauthorized,
      busy: Boolean(this._active),
      sessionId: this._sessionId,
      model: this._model,
      ...(this._lastError ? { error: this._lastError } : {}),
    }
  }

  _buildArgs(sessionId) {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', this._model,
      '--system-prompt', this._instructions,
      '--setting-sources', '',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--mcp-config', EMPTY_MCP_CONFIG,
      '--disallowedTools', ...DENIED_TOOLS,
    ]
    // A session only exists once a turn has completed against it.
    if (this._resumable && sessionId) args.push('--resume', sessionId)
    else args.push('--session-id', sessionId)
    return args
  }

  startTurn(input) {
    if (this._disposed) return Promise.reject(new ClaudeCodeError('The Claude Code bridge is disposed.', 'CLAUDE_DISPOSED'))
    if (this._active) return Promise.reject(new ClaudeCodeError('A Claude Code turn is already running.', 'CLAUDE_TURN_IN_PROGRESS'))

    let prompt
    try {
      const binary = this._binary()
      if (!binary) throw new ClaudeCodeError('Claude Code was not found. Install it and make sure `claude` is on your PATH.', 'CLAUDE_BINARY_NOT_FOUND')
      const message = String(input?.text || '').trim()
      if (!message) throw new ClaudeCodeError('The assistant message is empty.', 'CLAUDE_EMPTY_MESSAGE')
      const context = serializeHealthContext(input?.healthContext, this._maxHealthContextChars)
      prompt = `<OPENFIT_HEALTH_CONTEXT>\n${context}\n</OPENFIT_HEALTH_CONTEXT>\n\n${message}`
    } catch (error) {
      this._lastError = sanitizeMessage(error.message)
      return Promise.reject(error instanceof ClaudeCodeError ? error : new ClaudeCodeError(sanitizeMessage(error.message), 'CLAUDE_INVALID_INPUT'))
    }

    const onDelta = typeof input.onDelta === 'function' ? input.onDelta : () => {}
    if (!this._sessionId) this._sessionId = this._randomUUID()
    const sessionId = this._sessionId

    return new Promise((resolve, reject) => {
      let child
      try {
        child = this._spawn(this._binary(), this._buildArgs(sessionId), {
          cwd: this._cwd,
          env: this._env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        this._lastError = sanitizeMessage(error.message, 'Could not start Claude Code.')
        reject(new ClaudeCodeError(this._lastError, 'CLAUDE_SPAWN_FAILED'))
        return
      }

      const active = { child, cancelled: false, settled: false, timer: null }
      this._active = active

      let streamedText = ''
      let messageText = ''
      let result = null
      let stderrBytes = 0
      let stderrText = ''
      let overflowed = false

      const finish = (error, value) => {
        if (active.settled) return
        active.settled = true
        if (active.timer) clearTimeout(active.timer)
        this._active = null
        if (error) reject(error)
        else resolve(value)
      }

      const parser = createStreamJsonParser({
        onInit: ({ sessionId: reported }) => {
          if (reported) this._sessionId = reported
        },
        onDelta: (delta) => {
          streamedText += delta
          onDelta(delta)
        },
        onMessageText: (text) => { messageText = text },
        onResult: (payload) => { result = payload },
        onOverflow: () => {
          overflowed = true
          this._terminate(child)
        },
      })

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => parser.push(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        if (stderrBytes >= MAX_STDERR_BYTES) return
        stderrBytes += Buffer.byteLength(chunk, 'utf8')
        stderrText += chunk
      })

      child.on('error', (error) => {
        this._lastError = sanitizeMessage(`Could not start Claude Code (${error.code || error.message}).`, 'Could not start Claude Code.')
        finish(new ClaudeCodeError(this._lastError, 'CLAUDE_SPAWN_FAILED'))
      })

      child.on('close', () => {
        parser.end()
        if (active.cancelled) {
          finish(abortError())
          return
        }
        if (overflowed) {
          this._lastError = 'Claude Code sent an oversized response and the turn was stopped.'
          finish(new ClaudeCodeError(this._lastError, 'CLAUDE_PROTOCOL_OVERFLOW'))
          return
        }
        const text = (result?.text || messageText || streamedText).trim()
        if (result && !result.isError && text) {
          this._resumable = true
          this._lastError = null
          this._unauthorized = false
          finish(null, { text })
          return
        }
        const detail = result?.text || stderrText || result?.subtype || 'Claude Code ended the turn without a response.'
        this._lastError = sanitizeMessage(detail, 'Claude Code ended the turn without a response.')
        this._unauthorized = looksUnauthorized(detail)
        finish(new ClaudeCodeError(this._lastError, 'CLAUDE_TURN_FAILED'))
      })

      active.timer = setTimeout(() => {
        active.cancelled = true
        this._lastError = 'Claude Code did not respond in time.'
        this._terminate(child)
      }, this._turnTimeoutMs)
      if (typeof active.timer.unref === 'function') active.timer.unref()

      child.stdin.on('error', () => { /* the process may exit before stdin drains */ })
      child.stdin.end(prompt)
    })
  }

  _terminate(child) {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, this._terminationGraceMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async cancelTurn() {
    const active = this._active
    if (!active) return
    active.cancelled = true
    this._terminate(active.child)
  }

  async reset() {
    await this.cancelTurn()
    this._sessionId = null
    this._resumable = false
    this._lastError = null
  }

  async dispose() {
    this._disposed = true
    await this.cancelTurn()
  }
}

function createClaudeCodeService(options) {
  return new ClaudeCodeService(options)
}

module.exports = {
  id: 'claude-code',
  label: 'Claude Code',
  create: createClaudeCodeService,
  resolveBinary: (env = process.env) => resolveBinary('claude', { env, envVar: 'CLAUDE_BINARY' }),
  ClaudeCodeService,
  ClaudeCodeError,
  createClaudeCodeService,
  createStreamJsonParser,
  DENIED_TOOLS,
  DEFAULT_MODEL,
}
