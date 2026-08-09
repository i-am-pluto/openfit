import type {
  AgentSummary,
  FitbitAuthStatus,
  FitbitBridge,
  HealthAssistantBridge,
  HealthAssistantEvent,
  HealthAssistantStatus,
  RawFitbitPayload,
  RawHealthArchive,
  SessionBridge,
  UserPreferences,
  UserProfile,
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
        ? 'This OpenFit session has ended. Reload the page and sign in with Google again.'
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

/**
 * Sends the browser to a path this server asked it to open.
 *
 * Sign-in is a top-level redirect to Google, so `fetch` is the wrong tool: it
 * would follow the 302 and load the consent screen as an XHR that the CSP then
 * blocks. The server returns the path and the browser navigates.
 *
 * Only a same-origin absolute path is accepted. `//host` is a protocol-relative
 * URL and `https://host` an absolute one; navigating to either because a
 * response said so would turn this into an open redirect, and a value that is
 * not a string at all would navigate to the text "undefined".
 */
function navigateTo(target: unknown): { ok: boolean; message?: string } {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) {
    return { ok: false, message: 'This OpenFit server did not return a usable sign-in URL. Update the server and try again.' }
  }
  window.location.assign(target)
  return { ok: true }
}

export const fitbit: FitbitBridge = {
  getStatus: () => request<FitbitAuthStatus>('/api/status'),

  // Health access and sign-in are one Google consent, so "reconnect" is
  // "sign in again with the consent screen forced". The server decides the
  // path; this only checks that what came back is one.
  async connect() {
    const result = await request<{ reauthorizeUrl?: unknown }>('/api/connect', 'POST', {})
    return navigateTo(result?.reauthorizeUrl)
  },

  disconnect: () => request<FitbitAuthStatus>('/api/disconnect', 'POST', {}),
  sync: (date: string) => request<RawFitbitPayload>('/api/sync', 'POST', { date }),
  getCachedData: () => request<RawFitbitPayload | null>('/api/cached-data'),
  getCachedArchive: () => request<RawHealthArchive>('/api/cached-archive'),
  exportData: downloadArchive,
  onAuthComplete: (callback) => subscribe('auth-complete', callback),
  onSyncProgress: (callback) => subscribe('sync-progress', callback),
}

/**
 * The facts the provider cannot supply. Held server-side in the encrypted secret
 * store, never in localStorage, because this is personal data on the same
 * footing as credentials and the health cache.
 */
export const profile = {
  get: () => request<UserProfile>('/api/profile'),
  save: (patch: Partial<UserProfile>) => request<UserProfile>('/api/profile', 'POST', patch),
}

/**
 * How this account likes its dashboard. Server-side for the same reason the
 * profile is: preferences follow the account to whatever browser it signs in
 * from, and localStorage cannot do that.
 */
export const preferences = {
  get: () => request<UserPreferences>('/api/preferences'),
  save: (patch: Partial<UserPreferences>) => request<UserPreferences>('/api/preferences', 'POST', patch),
}

/**
 * The OpenFit session, which is not a health-provider concern.
 *
 * `everywhere` is the only revocation mechanism there is: it bumps the account's
 * epoch server-side, which invalidates every session cookie ever issued for that
 * account, including the ones on devices this browser cannot reach. The server
 * reports whether that actually happened, and the caller must not claim it did
 * when it did not.
 */
export const session: SessionBridge = {
  signOut: async (everywhere: boolean) => {
    const result = await request<{ ok?: unknown; revoked?: unknown }>('/auth/logout', 'POST', { everywhere: everywhere === true })
    return { ok: result?.ok === true, revoked: result?.revoked === true }
  },
  goToLoginPage: () => navigateTo('/'),
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
