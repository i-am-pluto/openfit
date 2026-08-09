import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fitbit, healthAssistant, session } from './api'

// Replaces the old preload-contract test: the renderer now reaches the backend
// over HTTP, so the contract worth pinning is the request each bridge method
// makes and the error text the UI shows when one fails.

type Call = { url: string; init: RequestInit | undefined }

let calls: Call[] = []
let assigned: string[] = []
let respond: (call: Call) => Response

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  calls = []
  respond = () => jsonResponse({})
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const call = { url: String(url), init }
    calls.push(call)
    return Promise.resolve(respond(call))
  }))
  assigned = []
  vi.stubGlobal('window', { location: { assign: vi.fn((url: string) => { assigned.push(url) }) } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer API client', () => {
  it('exposes the full fitbit bridge surface', () => {
    expect(new Set(Object.keys(fitbit))).toEqual(new Set([
      'getStatus', 'connect', 'disconnect', 'sync',
      'getCachedData', 'getCachedArchive', 'exportData',
      'onAuthComplete', 'onSyncProgress',
    ]))
  })

  it('exposes the session bridge separately from the health provider', () => {
    expect(new Set(Object.keys(session))).toEqual(new Set(['signOut', 'goToLoginPage']))
  })

  it('exposes the full assistant bridge surface, including agent selection', () => {
    expect(new Set(Object.keys(healthAssistant))).toEqual(new Set([
      'getStatus', 'listAgents', 'selectAgent', 'startTurn', 'cancel', 'reset', 'onEvent',
    ]))
  })

  it('maps each read to its endpoint', async () => {
    respond = () => jsonResponse({ ok: true })

    await fitbit.getStatus()
    await fitbit.getCachedData()
    await fitbit.getCachedArchive()
    await healthAssistant.getStatus()
    await healthAssistant.listAgents()

    expect(calls.map((call) => call.url)).toEqual([
      '/api/status', '/api/cached-data', '/api/cached-archive',
      '/api/assistant/status', '/api/assistant/agents',
    ])
    expect(calls.every((call) => (call.init?.method ?? 'GET') === 'GET')).toBe(true)
  })

  it('posts JSON bodies for writes', async () => {
    respond = () => jsonResponse({ ok: true })

    await fitbit.sync('2026-08-09')
    await healthAssistant.selectAgent('claude-code')
    await healthAssistant.startTurn({ requestId: 'abcd1234', message: 'hi', healthContext: '{}' })
    await healthAssistant.cancel('abcd1234')
    await healthAssistant.reset()

    expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      'POST /api/sync',
      'POST /api/assistant/agent',
      'POST /api/assistant/turn',
      'POST /api/assistant/cancel',
      'POST /api/assistant/reset',
    ])
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ date: '2026-08-09' })
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ agentId: 'claude-code' })
  })

  // Sign-in is a top-level redirect, so connect navigates rather than opening a
  // window or following the 302 itself.
  it('navigates to the reauthorization path connect returns', async () => {
    respond = () => jsonResponse({ reauthorizeUrl: '/auth/login?prompt=consent' })

    await expect(fitbit.connect()).resolves.toEqual({ ok: true })
    expect(assigned).toEqual(['/auth/login?prompt=consent'])
  })

  // The path comes from this server, but a navigation target is still checked:
  // an absolute or protocol-relative URL here would be an open redirect, and a
  // missing one would navigate to the string "undefined".
  it.each([
    ['an absent path', {}],
    ['a non-string path', { reauthorizeUrl: 42 }],
    ['an absolute URL', { reauthorizeUrl: 'https://evil.example/auth' }],
    ['a protocol-relative URL', { reauthorizeUrl: '//evil.example/auth' }],
  ])('refuses to navigate for %s', async (_label, body) => {
    respond = () => jsonResponse(body)

    const result = await fitbit.connect()
    expect(result.ok).toBe(false)
    expect(assigned).toEqual([])
  })

  it('posts the logout body and reports whether other devices were revoked', async () => {
    respond = () => jsonResponse({ ok: true, revoked: true })

    await expect(session.signOut(true)).resolves.toEqual({ ok: true, revoked: true })
    expect(`${calls[0].init?.method} ${calls[0].url}`).toBe('POST /auth/logout')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ everywhere: true })
  })

  // `revoked` is the only evidence that sessions on other devices were ended.
  // Anything that is not exactly `true` must not be reported as a revocation.
  it('reports revoked: false when the server did not bump the epoch', async () => {
    respond = () => jsonResponse({ ok: true, revoked: 'yes' })

    await expect(session.signOut(true)).resolves.toEqual({ ok: true, revoked: false })
  })

  it('surfaces the server error message', async () => {
    respond = () => jsonResponse({ error: 'A sync is already in progress.' }, 400)
    await expect(fitbit.sync('2026-08-09')).rejects.toThrow('A sync is already in progress.')
  })

  it('explains an expired session on 401', async () => {
    respond = () => new Response('', { status: 401 })
    await expect(fitbit.getStatus()).rejects.toThrow(/sign in with Google again/i)
  })

  it('returns an unsubscribe function without an EventSource available', () => {
    const unsubscribe = fitbit.onSyncProgress(() => {})
    expect(typeof unsubscribe).toBe('function')
    expect(() => unsubscribe()).not.toThrow()
  })
})
