import type {
  AgentSummary,
  FitbitAuthStatus,
  FitbitBridge,
  FitbitConfigInput,
  HealthAssistantBridge,
  HealthAssistantEvent,
  HealthAssistantStatus,
  RawFitbitPayload,
  RawHealthArchive,
} from '@/types'

/**
 * The renderer's only data path. Both hosts serve the same HTTP + SSE API — the
 * desktop app runs it on 127.0.0.1 and points a window at it — so there is no
 * Electron-specific branch anywhere in the UI.
 */

type Method = 'GET' | 'POST'

async function request<T>(path: string, method: Method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const text = await response.text()
  const payload = text ? safeParse(text) : null

  if (!response.ok) {
    const message = (payload as { error?: string } | null)?.error
      ?? (response.status === 401
        ? 'This OpenFit session is not authorized. Reopen the link printed when the server started.'
        : `Request failed (${response.status}).`)
    throw new Error(message)
  }
  return payload as T
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Server-sent events: one shared stream, fanned out to per-channel subscribers.
// ---------------------------------------------------------------------------

type Channel = 'auth-complete' | 'sync-progress' | 'assistant'

const subscribers: Record<Channel, Set<(payload: never) => void>> = {
  'auth-complete': new Set(),
  'sync-progress': new Set(),
  assistant: new Set(),
}

let stream: EventSource | null = null

function ensureStream() {
  if (stream || typeof EventSource === 'undefined') return
  stream = new EventSource('/api/events', { withCredentials: true })
  for (const channel of Object.keys(subscribers) as Channel[]) {
    stream.addEventListener(channel, (event) => {
      const payload = safeParse((event as MessageEvent<string>).data)
      for (const listener of subscribers[channel]) (listener as (value: unknown) => void)(payload)
    })
  }
  // EventSource reconnects on its own; drop the handle so a later subscribe can
  // rebuild it if the browser gave up entirely.
  stream.addEventListener('error', () => {
    if (stream?.readyState === EventSource.CLOSED) stream = null
  })
}

function subscribe<T>(channel: Channel, listener: (payload: T) => void): () => void {
  ensureStream()
  const set = subscribers[channel] as unknown as Set<(payload: T) => void>
  set.add(listener)
  return () => { set.delete(listener) }
}

// ---------------------------------------------------------------------------

async function downloadArchive(): Promise<{ canceled: boolean; path?: string }> {
  const response = await fetch('/api/export', { credentials: 'same-origin' })
  if (!response.ok) {
    const payload = safeParse(await response.text()) as { error?: string } | null
    throw new Error(payload?.error ?? 'The export failed.')
  }
  const disposition = response.headers.get('content-disposition') ?? ''
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'openfit-archive.json'
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
  return { canceled: false, path: filename }
}

export const fitbit: FitbitBridge = {
  getStatus: () => request<FitbitAuthStatus>('/api/status'),
  saveConfig: (config: FitbitConfigInput) => request<FitbitAuthStatus>('/api/config', 'POST', config),

  async connect() {
    const result = await request<{ ok: boolean; authorizationUrl?: string; requiresHost?: boolean }>('/api/connect', 'POST', {})
    if (result.requiresHost) {
      return {
        ok: false,
        message: 'Connect your health account from a browser on the machine running OpenFit. Google only accepts a loopback or https callback, so a tailnet address cannot receive it.',
      }
    }
    if (result.authorizationUrl) window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer')
    return { ok: Boolean(result.ok) }
  },

  disconnect: () => request<FitbitAuthStatus>('/api/disconnect', 'POST', {}),
  sync: (date: string) => request<RawFitbitPayload>('/api/sync', 'POST', { date }),
  getCachedData: () => request<RawFitbitPayload | null>('/api/cached-data'),
  getCachedArchive: () => request<RawHealthArchive>('/api/cached-archive'),
  exportData: downloadArchive,
  onAuthComplete: (callback) => subscribe('auth-complete', callback),
  onSyncProgress: (callback) => subscribe('sync-progress', callback),
}

export const healthAssistant: HealthAssistantBridge = {
  getStatus: () => request<HealthAssistantStatus>('/api/assistant/status'),
  listAgents: () => request<{ agents: AgentSummary[]; status: HealthAssistantStatus }>('/api/assistant/agents'),
  selectAgent: (agentId: string) => request<{ status: HealthAssistantStatus; agents: AgentSummary[] }>('/api/assistant/agent', 'POST', { agentId }),
  startTurn: (input) => request<{ requestId: string }>('/api/assistant/turn', 'POST', input),
  cancel: async (requestId: string) => { await request('/api/assistant/cancel', 'POST', { requestId }) },
  reset: async () => { await request('/api/assistant/reset', 'POST', {}) },
  onEvent: (callback) => subscribe<HealthAssistantEvent>('assistant', callback),
}
