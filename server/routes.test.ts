import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createServer } = require('./index.cjs') as {
  createServer: (options: Record<string, any>) => { server: any; token: string }
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function stubApp(overrides: Record<string, any> = {}) {
  const events = new EventEmitter()
  return {
    events,
    publicOrigin: null,
    dataDir: '/mock',
    getStatus: vi.fn(() => ({ hasBackend: true, configured: false, provider: 'google-health' })),
    saveConfig: vi.fn((config: any) => ({ hasBackend: true, configured: true, clientId: config.clientId })),
    connect: vi.fn(async () => ({ ok: true, authorizationUrl: 'https://accounts.example/auth' })),
    disconnect: vi.fn(async () => ({ hasBackend: true, connected: false })),
    sync: vi.fn(async () => ({ date: '2026-08-09' })),
    getCachedData: vi.fn(() => null),
    getCachedArchive: vi.fn(() => ({ version: 2, lastDate: null, days: {} })),
    exportArchive: vi.fn(() => ({ filename: 'openfit-archive-2026-08-09.json', json: '{"days":{}}' })),
    handleOAuthCallback: vi.fn(async () => ({ status: 200, html: '<html>done</html>' })),
    assistant: {
      listAgents: vi.fn(() => [{ id: 'codex', label: 'Codex', available: true, selected: true }]),
      getStatus: vi.fn(() => ({ id: 'codex', label: 'Codex', available: true, authenticated: true })),
      selectAgent: vi.fn((id: string) => ({ status: { id }, agents: [] })),
      startTurn: vi.fn((input: any) => ({ requestId: input.requestId })),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
    },
    dispose: vi.fn(async () => {}),
    ...overrides,
  }
}

async function withServer(app: any) {
  const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-dist-'))
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html>SHELL')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-data-'))

  const { server, token } = createServer({ app, staticRoot, dataDir, token: 'test-token' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  cleanups.push(() => {
    server.close()
    fs.rmSync(staticRoot, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const call = (pathname: string, init: RequestInit = {}) => fetch(base + pathname, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  })

  return { base, token, call }
}

describe('server routes', () => {
  it('gates every API route behind the token', async () => {
    const { base } = await withServer(stubApp())

    for (const pathname of ['/api/status', '/api/cached-data', '/api/assistant/agents', '/api/events']) {
      expect((await fetch(base + pathname)).status).toBe(401)
    }
    expect((await fetch(base + '/api/status', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
  })

  it('requires the token before serving the app shell', async () => {
    const { base, token } = await withServer(stubApp())
    expect((await fetch(base + '/')).status).toBe(401)
    expect((await fetch(base + '/', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
  })

  it('exchanges a tokenized link for a cookie and redirects', async () => {
    const { base, token } = await withServer(stubApp())
    const response = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
    expect(response.headers.get('set-cookie')).toContain('openfit_token=')
  })

  it('serves status, config, and sync through the core app', async () => {
    const app = stubApp()
    const { call } = await withServer(app)

    expect(await (await call('/api/status')).json()).toMatchObject({ hasBackend: true })

    await call('/api/config', { method: 'POST', body: JSON.stringify({ clientId: 'abc' }) })
    expect(app.saveConfig).toHaveBeenCalledWith({ clientId: 'abc' })

    await call('/api/sync', { method: 'POST', body: JSON.stringify({ date: '2026-08-09' }) })
    expect(app.sync).toHaveBeenCalledWith('2026-08-09')
  })

  it('reports a core error as a 400 with its message', async () => {
    const app = stubApp({
      sync: vi.fn(async () => { throw new Error('A sync is already in progress.') }),
    })
    const { call } = await withServer(app)

    const response = await call('/api/sync', { method: 'POST', body: JSON.stringify({ date: '2026-08-09' }) })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'A sync is already in progress.' })
  })

  it('tells connect whether the caller reached it over loopback', async () => {
    const app = stubApp()
    const { call } = await withServer(app)

    await call('/api/connect', { method: 'POST', body: '{}' })
    expect(app.connect).toHaveBeenCalledWith({ fromLoopback: true })
  })

  it('serves the archive as a download', async () => {
    const { call } = await withServer(stubApp())
    const response = await call('/api/export')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="openfit-archive-2026-08-09.json"')
    expect(await response.text()).toBe('{"days":{}}')
  })

  it('routes assistant calls, including agent selection', async () => {
    const app = stubApp()
    const { call } = await withServer(app)

    expect(await (await call('/api/assistant/agents')).json()).toMatchObject({ agents: [{ id: 'codex' }] })

    await call('/api/assistant/agent', { method: 'POST', body: JSON.stringify({ agentId: 'claude-code' }) })
    expect(app.assistant.selectAgent).toHaveBeenCalledWith('claude-code')

    await call('/api/assistant/turn', { method: 'POST', body: JSON.stringify({ requestId: 'abcd1234', message: 'hi' }) })
    expect(app.assistant.startTurn).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'abcd1234' }))
  })

  it('streams core events over SSE', async () => {
    const app = stubApp()
    const { call } = await withServer(app)

    const response = await call('/api/events')
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''

    await vi.waitFor(() => expect(app.events.listenerCount('sync-progress')).toBe(1))
    app.events.emit('sync-progress', { completed: 1, total: 4, key: 'steps' })

    while (!seen.includes('sync-progress')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }

    expect(seen).toContain('event: sync-progress')
    expect(seen).toContain('"completed":1')
    await reader.cancel()
  })

  it('detaches SSE listeners when a client disconnects', async () => {
    const app = stubApp()
    const { call } = await withServer(app)

    const controller = new AbortController()
    await call('/api/events', { signal: controller.signal })
    await vi.waitFor(() => expect(app.events.listenerCount('assistant')).toBe(1))

    controller.abort()
    await vi.waitFor(() => expect(app.events.listenerCount('assistant')).toBe(0))
  })

  it('falls back to the shell for unknown paths but 404s unknown API routes', async () => {
    const { call } = await withServer(stubApp())

    expect(await (await call('/today')).text()).toContain('SHELL')
    expect((await call('/api/nope')).status).toBe(404)
  })

  it('404s a missing asset instead of answering it with the shell', async () => {
    const { call } = await withServer(stubApp())

    // Serving HTML for a missing .js yields a blank page under nosniff rather
    // than a legible failure, so anything with a file extension must 404.
    for (const pathname of ['/assets/index-abc123.js', '/assets/gone.css', '/assets/font.woff2']) {
      const response = await call(pathname)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).not.toContain('text/html')
    }
  })

  it('serves real assets with their own content type', async () => {
    const app = stubApp()
    const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-dist-'))
    fs.mkdirSync(path.join(staticRoot, 'assets'))
    fs.writeFileSync(path.join(staticRoot, 'index.html'), 'SHELL')
    fs.writeFileSync(path.join(staticRoot, 'assets', 'app.js'), 'export default 1')
    fs.writeFileSync(path.join(staticRoot, 'assets', 'app.css'), '.a{}')
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-data-'))

    const { server, token } = createServer({ app, staticRoot, dataDir, token: 'test-token' })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => {
      server.close()
      fs.rmSync(staticRoot, { recursive: true, force: true })
      fs.rmSync(dataDir, { recursive: true, force: true })
    })

    const base = `http://127.0.0.1:${server.address().port}`
    const headers = { authorization: `Bearer ${token}` }

    const js = await fetch(`${base}/assets/app.js`, { headers })
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')

    const css = await fetch(`${base}/assets/app.css`, { headers })
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
  })

  it('does not mount the OAuth callback unless a public origin is configured', async () => {
    const withoutOrigin = await withServer(stubApp())
    expect(await (await withoutOrigin.call('/oauth/callback?code=x')).text()).toContain('SHELL')

    const app = stubApp({ publicOrigin: 'https://box.example.ts.net' })
    const withOrigin = await withServer(app)
    // Deliberately unauthenticated: the provider redirects the browser here
    // without OpenFit's cookie; `state` is the CSRF check.
    const response = await fetch(`${withOrigin.base}/oauth/callback?code=abc&state=xyz`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('done')
    expect(app.handleOAuthCallback).toHaveBeenCalled()
  })

  it('rejects an oversized request body', async () => {
    const { call } = await withServer(stubApp())
    const response = await call('/api/config', { method: 'POST', body: JSON.stringify({ clientId: 'x'.repeat(2 * 1024 * 1024) }) })
    expect(response.status).toBe(413)
  })
})
