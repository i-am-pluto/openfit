import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createClaudeCodeService,
  createStreamJsonParser,
  DENIED_TOOLS,
} = require('./claude-code.cjs') as {
  createClaudeCodeService: (options?: Record<string, unknown>) => {
    getStatus: () => Record<string, unknown>
    startTurn: (input: Record<string, unknown>) => Promise<{ text: string }>
    cancelTurn: () => Promise<void>
    reset: () => Promise<void>
  }
  createStreamJsonParser: (handlers: Record<string, unknown>) => { push: (chunk: string) => void; end: () => void }
  DENIED_TOOLS: string[]
}

// Line shapes captured from a real `claude -p --output-format stream-json` run.
const delta = (text: string) => JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
})
const resultLine = (fields: Record<string, unknown>) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', ...fields,
})

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  stdinData = ''
  killed: string | null = null
  readonly stdin: Writable

  constructor() {
    super()
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        this.stdinData += chunk.toString()
        done()
      },
    })
  }

  emitLines(...lines: string[]) {
    for (const line of lines) this.stdout.write(`${line}\n`)
  }

  close(code = 0) {
    this.stdout.end()
    this.stderr.end()
    queueMicrotask(() => this.emit('close', code, null))
  }

  kill(signal: string) {
    this.killed = signal
    if (signal === 'SIGTERM') this.close(143)
    return true
  }
}

function serviceWith(child: FakeChild, options: Record<string, unknown> = {}) {
  const spawn = vi.fn(() => child)
  const service = createClaudeCodeService({
    spawn,
    resolveBinary: () => '/mock/bin/claude',
    randomUUID: () => 'fixed-session-uuid',
    cwd: '/mock/data',
    ...options,
  })
  return { spawn, service }
}

describe('Claude Code stream-json parser', () => {
  it('accumulates text deltas and reads the final result', () => {
    const onDelta = vi.fn()
    const onResult = vi.fn()
    const parser = createStreamJsonParser({ onDelta, onResult })

    parser.push(`${delta('You slept ')}\n${delta('7 hours.')}\n`)
    parser.push(`${resultLine({ result: 'You slept 7 hours.' })}\n`)

    expect(onDelta.mock.calls.map(([value]) => value)).toEqual(['You slept ', '7 hours.'])
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ isError: false, text: 'You slept 7 hours.' }))
  })

  it('handles NDJSON split across chunk boundaries', () => {
    const onDelta = vi.fn()
    const parser = createStreamJsonParser({ onDelta })
    const line = delta('split')
    parser.push(line.slice(0, 20))
    expect(onDelta).not.toHaveBeenCalled()
    parser.push(`${line.slice(20)}\n`)
    expect(onDelta).toHaveBeenCalledWith('split')
  })

  it('ignores unknown event types and non-JSON noise', () => {
    const onDelta = vi.fn()
    const onResult = vi.fn()
    const parser = createStreamJsonParser({ onDelta, onResult })
    parser.push('not json at all\n')
    parser.push(`${JSON.stringify({ type: 'some_future_event', payload: 1 })}\n`)
    parser.push(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_stop' } })}\n`)
    parser.end()
    expect(onDelta).not.toHaveBeenCalled()
    expect(onResult).not.toHaveBeenCalled()
  })

  it('reports overflow instead of buffering without bound', () => {
    const onOverflow = vi.fn()
    const parser = createStreamJsonParser({ onOverflow })
    parser.push('x'.repeat(9 * 1024 * 1024))
    expect(onOverflow).toHaveBeenCalledTimes(1)
  })
})

describe('Claude Code service', () => {
  it('runs a tool-less, settings-free turn and returns the final text', async () => {
    const child = new FakeChild()
    const { spawn, service } = serviceWith(child)

    const onDelta = vi.fn()
    const promise = service.startTurn({
      text: 'How did I sleep?',
      healthContext: '{"sleepMinutes":420}',
      onDelta,
    })

    await vi.waitFor(() => expect(child.stdinData).toContain('How did I sleep?'))
    child.emitLines(delta('You slept '), delta('7 hours.'), resultLine({ result: 'You slept 7 hours.' }))
    child.close()

    await expect(promise).resolves.toEqual({ text: 'You slept 7 hours.' })
    expect(onDelta.mock.calls.map(([value]) => value)).toEqual(['You slept ', '7 hours.'])

    const args = spawn.mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--model', 'opus']))
    expect(args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']))
    expect(args).toEqual(expect.arrayContaining(['--disable-slash-commands', '--setting-sources', '']))
    for (const tool of DENIED_TOOLS) expect(args).toContain(tool)
    expect(args).not.toContain('--allowedTools')
    // Health context is fenced so the model treats it as data, not instructions.
    expect(child.stdinData).toContain('<OPENFIT_HEALTH_CONTEXT>')
    expect(child.stdinData).toContain('{"sleepMinutes":420}')
  })

  it('starts a new session then resumes it on the next turn, and rotates on reset', async () => {
    const first = new FakeChild()
    const children = [first, new FakeChild(), new FakeChild()]
    let index = 0
    let minted = 0
    const spawn = vi.fn(() => children[index++])
    const service = createClaudeCodeService({
      spawn,
      resolveBinary: () => '/mock/bin/claude',
      randomUUID: () => `uuid-${++minted}`,
      cwd: '/mock/data',
    })

    const run = async (child: FakeChild) => {
      const promise = service.startTurn({ text: 'hi', healthContext: '{}' })
      await vi.waitFor(() => expect(child.stdinData).toContain('hi'))
      child.emitLines(resultLine({ result: 'ok' }))
      child.close()
      await promise
    }

    await run(children[0])
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['--session-id', 'uuid-1']))

    await run(children[1])
    // The session exists now, so the second turn continues it.
    expect(spawn.mock.calls[1][1]).toEqual(expect.arrayContaining(['--resume', 'uuid-1']))

    await service.reset()
    await run(children[2])
    expect(spawn.mock.calls[2][1]).toEqual(expect.arrayContaining(['--session-id', 'uuid-2']))
  })

  it('rejects with a cancellation error when the turn is cancelled', async () => {
    const child = new FakeChild()
    const { service } = serviceWith(child)
    const promise = service.startTurn({ text: 'hi', healthContext: '{}' })
    await vi.waitFor(() => expect(child.stdinData).toContain('hi'))

    await service.cancelTurn()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError', code: 'CLAUDE_TURN_CANCELLED' })
    expect(child.killed).toBe('SIGTERM')
  })

  it('surfaces an error result without leaking credentials', async () => {
    const child = new FakeChild()
    const { service } = serviceWith(child)
    const promise = service.startTurn({ text: 'hi', healthContext: '{}' })
    await vi.waitFor(() => expect(child.stdinData).toContain('hi'))

    child.emitLines(JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'failed with Authorization: Bearer super-secret-token and sk-abcdefgh12345',
      session_id: 's',
    }))
    child.close(1)

    await expect(promise).rejects.toMatchObject({ code: 'CLAUDE_TURN_FAILED' })
    await promise.catch((error: Error) => {
      expect(error.message).not.toContain('super-secret-token')
      expect(error.message).not.toContain('sk-abcdefgh12345')
      expect(error.message).toContain('[redacted]')
    })
  })

  it('marks itself unauthenticated when the CLI reports a login problem', async () => {
    const child = new FakeChild()
    const { service } = serviceWith(child)
    const promise = service.startTurn({ text: 'hi', healthContext: '{}' })
    await vi.waitFor(() => expect(child.stdinData).toContain('hi'))
    child.emitLines(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Please log in with /login' }))
    child.close(1)

    await expect(promise).rejects.toThrow()
    expect(service.getStatus()).toMatchObject({ available: true, authenticated: false })
  })

  it('reports a missing binary without spawning', async () => {
    const spawn = vi.fn()
    const service = createClaudeCodeService({ spawn, resolveBinary: () => null })

    await expect(service.startTurn({ text: 'hi', healthContext: '{}' }))
      .rejects.toMatchObject({ code: 'CLAUDE_BINARY_NOT_FOUND' })
    expect(spawn).not.toHaveBeenCalled()
    expect(service.getStatus()).toMatchObject({ available: false, authenticated: false })
  })

  it('refuses a second concurrent turn', async () => {
    const child = new FakeChild()
    const { service } = serviceWith(child)
    const first = service.startTurn({ text: 'one', healthContext: '{}' })
    await expect(service.startTurn({ text: 'two', healthContext: '{}' }))
      .rejects.toMatchObject({ code: 'CLAUDE_TURN_IN_PROGRESS' })

    child.emitLines(resultLine({ result: 'ok' }))
    child.close()
    await first
  })

  it('rejects an oversized health context before spawning', async () => {
    const spawn = vi.fn()
    const service = createClaudeCodeService({
      spawn,
      resolveBinary: () => '/mock/bin/claude',
      maxHealthContextChars: 32,
    })
    await expect(service.startTurn({ text: 'hi', healthContext: 'x'.repeat(64) })).rejects.toThrow(/too large/)
    expect(spawn).not.toHaveBeenCalled()
  })
})
