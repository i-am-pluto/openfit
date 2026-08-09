import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fitbit, healthAssistant } from './api'

// Replaces the old preload-contract test: the renderer now reaches the backend
// over HTTP, so the contract worth pinning is the request each bridge method
// makes and the error text the UI shows when one fails.

type Call = { url: string; init: RequestInit | undefined }

let calls: Call[] = []
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
  vi.stubGlobal('window', { open: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer API client', () => {
  it('exposes the full fitbit bridge surface', () => {
    expect(new Set(Object.keys(fitbit))).toEqual(new Set([
      'getStatus', 'saveConfig', 'connect', 'disconnect', 'sync',
      'getCachedData', 'getCachedArchive', 'exportData',
      'onAuthComplete', 'onSyncProgress',
    ]))
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

    await fitbit.saveConfig({ provider: 'google-health', clientId: 'abc', redirectUri: 'http://127.0.0.1:42813/oauth/callback' })
    await fitbit.sync('2026-08-09')
    await healthAssistant.selectAgent('claude-code')
    await healthAssistant.startTurn({ requestId: 'abcd1234', message: 'hi', healthContext: '{}' })
    await healthAssistant.cancel('abcd1234')
    await healthAssistant.reset()

    expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      'POST /api/config',
      'POST /api/sync',
      'POST /api/assistant/agent',
      'POST /api/assistant/turn',
      'POST /api/assistant/cancel',
      'POST /api/assistant/reset',
    ])
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ date: '2026-08-09' })
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ agentId: 'claude-code' })
  })

  it('opens the authorization URL when connect succeeds', async () => {
    respond = () => jsonResponse({ ok: true, authorizationUrl: 'https://accounts.example/auth' })

    await expect(fitbit.connect()).resolves.toEqual({ ok: true })
    expect(window.open).toHaveBeenCalledWith('https://accounts.example/auth', '_blank', 'noopener,noreferrer')
  })

  it('explains that connecting is host-bound when the server says so', async () => {
    respond = () => jsonResponse({ ok: false, requiresHost: true })

    const result = await fitbit.connect()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/machine running OpenFit/)
    expect(window.open).not.toHaveBeenCalled()
  })

  it('surfaces the server error message', async () => {
    respond = () => jsonResponse({ error: 'A sync is already in progress.' }, 400)
    await expect(fitbit.sync('2026-08-09')).rejects.toThrow('A sync is already in progress.')
  })

  it('explains an expired session on 401', async () => {
    respond = () => new Response('', { status: 401 })
    await expect(fitbit.getStatus()).rejects.toThrow(/not authorized/i)
  })

  it('returns an unsubscribe function without an EventSource available', () => {
    const unsubscribe = fitbit.onSyncProgress(() => {})
    expect(typeof unsubscribe).toBe('function')
    expect(() => unsubscribe()).not.toThrow()
  })
})
