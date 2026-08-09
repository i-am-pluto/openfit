import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAssistantRuntime,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
} from '@assistant-ui/react'
import { ArrowDown, ArrowUp, Plus, Sparkles, Square, X } from 'lucide-react'
import { fitbit, healthAssistant } from '@/lib/api'
import { MarkdownText } from '@/components/MarkdownText'
import { normalizeFitbitData } from '@/data/normalize'
import {
  buildHealthAssistantContext,
  parseAssistantNavigation,
  stripAssistantNavigation,
  visibleAssistantText,
  type AssistantNavigation,
} from '@/lib/health-assistant'
import { EMPTY_USER_PROFILE } from '@/lib/user-profile'
import type {
  AgentSummary,
  DashboardData,
  HealthAssistantEvent,
  HealthAssistantStatus,
  PageId,
  RawHealthArchive,
  UserProfile,
} from '@/types'

const unavailableStatus: HealthAssistantStatus = {
  id: null,
  label: 'Assistant',
  available: false,
  connected: false,
  authenticated: false,
}

function messageText(message: ThreadMessage | undefined) {
  if (!message) return ''
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

function archiveData(archive: RawHealthArchive | null | undefined) {
  if (!archive) return []
  return Object.values(archive.days)
    .map((payload) => normalizeFitbitData(payload))
    .sort((left, right) => left.selectedDate.localeCompare(right.selectedDate))
}

function statusLabel(status: HealthAssistantStatus) {
  const name = status.label || 'Assistant'
  if (!status.available) return `${name} not found`
  if (!status.authenticated) return `Sign in to ${name}`
  return status.connected ? `${name} connected` : `${name} ready`
}

function createQueue() {
  const events: HealthAssistantEvent[] = []
  let wake: ((event: HealthAssistantEvent) => void) | null = null

  return {
    push(event: HealthAssistantEvent) {
      if (wake) {
        const resolve = wake
        wake = null
        resolve(event)
      } else {
        events.push(event)
      }
    },
    next() {
      const event = events.shift()
      if (event) return Promise.resolve(event)
      return new Promise<HealthAssistantEvent>((resolve) => { wake = resolve })
    },
  }
}

export function HealthAssistant({
  open,
  data,
  page,
  profile = EMPTY_USER_PROFILE,
  initialPrompt = null,
  onInitialPromptConsumed,
  onOpenChange,
  onNavigate,
}: {
  open: boolean
  data: DashboardData
  page: PageId
  profile?: UserProfile
  /** Seeds the composer. Never sent on the user's behalf. */
  initialPrompt?: string | null
  onInitialPromptConsumed?: () => void
  onOpenChange: (open: boolean) => void
  onNavigate: (navigation: AssistantNavigation) => void
}) {
  const dataRef = useRef(data)
  const pageRef = useRef(page)
  const profileRef = useRef(profile)
  const navigateRef = useRef(onNavigate)
  const [status, setStatus] = useState(unavailableStatus)
  const [agents, setAgents] = useState<AgentSummary[]>([])

  useEffect(() => { dataRef.current = data }, [data])
  useEffect(() => { pageRef.current = page }, [page])
  useEffect(() => { profileRef.current = profile }, [profile])
  useEffect(() => { navigateRef.current = onNavigate }, [onNavigate])

  const refreshStatus = useCallback(async () => {
    try {
      const listed = await healthAssistant.listAgents()
      setAgents(listed.agents)
      setStatus(listed.status)
    } catch (error) {
      setAgents([])
      setStatus({
        ...unavailableStatus,
        error: error instanceof Error ? error.message : 'The assistant is unavailable.',
      })
    }
  }, [])

  const selectAgent = useCallback(async (agentId: string) => {
    try {
      const selection = await healthAssistant.selectAgent(agentId)
      setAgents(selection.agents)
      setStatus(selection.status)
    } catch (error) {
      setStatus((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Could not switch the assistant backend.',
      }))
    }
  }, [])

  useEffect(() => { void refreshStatus() }, [refreshStatus])
  useEffect(() => {
    if (open) void refreshStatus()
  }, [open, refreshStatus])

  const modelAdapter = useMemo<ChatModelAdapter>(() => ({
    async *run({ messages, abortSignal }) {
      const bridge = healthAssistant

      const prompt = messageText(messages.at(-1))
      if (!prompt) throw new Error('Write a question before sending it.')

      let archived: DashboardData[] = []
      if (dataRef.current.source !== 'demo') {
        try {
          archived = archiveData(await fitbit.getCachedArchive())
        } catch {
          archived = []
        }
      }

      const healthContext = buildHealthAssistantContext(dataRef.current, archived, pageRef.current, profileRef.current)
      const requestId = crypto.randomUUID()
      const queue = createQueue()
      let fullText = ''
      let lastVisibleText = ''
      let completed = false

      const unsubscribe = bridge.onEvent((event) => {
        if (event.requestId === requestId) queue.push(event)
      })
      const onAbort = () => queue.push({ requestId, type: 'cancelled' })
      abortSignal.addEventListener('abort', onAbort, { once: true })

      try {
        await bridge.startTurn({ requestId, message: prompt, healthContext })
        void refreshStatus()

        while (!completed) {
          const event = await queue.next()
          if (event.type === 'delta') {
            fullText += event.delta
            const visible = visibleAssistantText(fullText)
            if (visible && visible !== lastVisibleText) {
              lastVisibleText = visible
              yield { content: [{ type: 'text', text: visible }] }
            }
          } else if (event.type === 'complete') {
            completed = true
            if (event.text) fullText = event.text
          } else if (event.type === 'error') {
            throw new Error(event.message)
          } else {
            return
          }
        }

        const navigation = parseAssistantNavigation(fullText)
        const finalText = stripAssistantNavigation(fullText)
        if (navigation) navigateRef.current(navigation)
        if (!finalText) throw new Error('The assistant completed the turn without a response.')
        if (finalText !== lastVisibleText) {
          yield { content: [{ type: 'text', text: finalText }] }
        }
      } finally {
        abortSignal.removeEventListener('abort', onAbort)
        unsubscribe()
        if (!completed || abortSignal.aborted) void bridge.cancel(requestId)
        void refreshStatus()
      }
    },
  }), [refreshStatus])

  const runtime = useLocalRuntime(modelAdapter)
  const ready = Boolean(status.available && status.authenticated)

  // The seeded question goes into the composer, not into the thread. An insight
  // the user never asked about must not become a question they appear to have
  // asked: they have to read it, edit it, and press send themselves.
  useEffect(() => {
    if (!open || !initialPrompt) return
    runtime.thread.composer.setText(initialPrompt)
    onInitialPromptConsumed?.()
  }, [initialPrompt, onInitialPromptConsumed, open, runtime])

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <aside
        id="health-assistant"
        className={`health-assistant ${open ? 'is-open' : ''}`}
        aria-label="Health assistant"
        aria-hidden={!open}
        inert={!open}
      >
        <AssistantHeader
          status={status}
          agents={agents}
          ready={ready}
          onClose={() => onOpenChange(false)}
          onStatusRefresh={refreshStatus}
          onSelectAgent={selectAgent}
        />
        <AssistantThread ready={ready} />
      </aside>
      {open && <button className="assistant-scrim" aria-label="Close health assistant" onClick={() => onOpenChange(false)} />}
    </AssistantRuntimeProvider>
  )
}

function AssistantHeader({
  status,
  agents,
  ready,
  onClose,
  onStatusRefresh,
  onSelectAgent,
}: {
  status: HealthAssistantStatus
  agents: AgentSummary[]
  ready: boolean
  onClose: () => void
  onStatusRefresh: () => Promise<void>
  onSelectAgent: (agentId: string) => Promise<void>
}) {
  const runtime = useAssistantRuntime()

  const newConversation = async () => {
    runtime.thread.cancelRun()
    runtime.thread.reset()
    await healthAssistant.reset()
    await onStatusRefresh()
  }

  return (
    <header className="assistant-header">
      <div className="assistant-title">
        <span className="assistant-mark"><Sparkles aria-hidden="true" /></span>
        <span>
          <strong>Health assistant</strong>
          <small><i className={ready ? 'is-ready' : ''} />{statusLabel(status)}</small>
        </span>
      </div>
      <div className="assistant-header-actions">
        {agents.length > 1 && (
          <select
            className="assistant-agent"
            aria-label="Assistant backend"
            title="Assistant backend"
            value={status.id ?? ''}
            onChange={(event) => void onSelectAgent(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.id ?? ''} value={agent.id ?? ''} disabled={!agent.available}>
                {agent.available ? agent.label : `${agent.label} (not installed)`}
              </option>
            ))}
          </select>
        )}
        <button type="button" aria-label="New conversation" title="New conversation" onClick={() => void newConversation()}>
          <Plus aria-hidden="true" />
        </button>
        <button type="button" aria-label="Close assistant" title="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}

function AssistantThread({ ready }: { ready: boolean }) {
  return (
    <ThreadPrimitive.Root className="assistant-thread">
      <ThreadPrimitive.Viewport className="assistant-viewport">
        <AuiIf condition={(state) => state.thread.isEmpty}>
          <div className="assistant-welcome">
            <h2>Ask your health data.</h2>
            <p>I can compare days, explain trends, and take you to the relevant view.</p>
            <div className="assistant-suggestions" aria-label="Suggested questions">
              <ThreadPrimitive.Suggestion prompt="How did I sleep last night?" send disabled={!ready}>How did I sleep?</ThreadPrimitive.Suggestion>
              <ThreadPrimitive.Suggestion prompt="Compare my activity over the last seven days." send disabled={!ready}>Compare this week</ThreadPrimitive.Suggestion>
              <ThreadPrimitive.Suggestion prompt="Show me my heart health data." send disabled={!ready}>Open heart data</ThreadPrimitive.Suggestion>
            </div>
          </div>
        </AuiIf>

        <div className="assistant-messages">
          <ThreadPrimitive.Messages>
            {({ message }) => message.role === 'user' ? <UserMessage /> : <AssistantMessage />}
          </ThreadPrimitive.Messages>
        </div>

        <ThreadPrimitive.ViewportFooter className="assistant-viewport-footer">
          <ThreadPrimitive.ScrollToBottom className="assistant-scroll-bottom" aria-label="Scroll to latest response">
            <ArrowDown aria-hidden="true" />
          </ThreadPrimitive.ScrollToBottom>
          <ComposerPrimitive.Root className="assistant-composer">
            <ComposerPrimitive.Input
              className="assistant-composer-input"
              rows={1}
              disabled={!ready}
              placeholder={ready ? 'Ask about your health…' : 'Connect Codex Desktop to chat'}
              aria-label="Message health assistant"
            />
            <AuiIf condition={(state) => !state.thread.isRunning}>
              <ComposerPrimitive.Send className="assistant-send" disabled={!ready} aria-label="Send message">
                <ArrowUp aria-hidden="true" />
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(state) => state.thread.isRunning}>
              <ComposerPrimitive.Cancel className="assistant-send is-cancel" aria-label="Stop response">
                <Square aria-hidden="true" />
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </ComposerPrimitive.Root>
          <p className="assistant-disclaimer">Health context, not medical advice.</p>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="assistant-user-message">
      <div><MessagePrimitive.Parts /></div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="assistant-ai-message">
      <span className="assistant-response-mark" aria-hidden="true">+</span>
      <div><MessagePrimitive.Parts components={{ Text: MarkdownText }} /></div>
    </MessagePrimitive.Root>
  )
}
