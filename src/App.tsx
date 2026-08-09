import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronsUpDown, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DashboardData, FitbitAuthStatus, PageId, RawHealthArchive, UserProfile } from '@/types'
import { createDemoData, localIso } from '@/data/demo'
import { fitbit, profile as profileApi, session } from '@/lib/api'
import { normalizeFitbitData } from '@/data/normalize'
import { formatDate, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ActivityView, BodyView, DevicesView, HealthView, SleepView, TodayView } from '@/components/Views'
import { HealthAssistant } from '@/components/HealthAssistant'
import { ProfileSettings } from '@/components/ProfileSettings'
import { loadDaysFor, type AssistantNavigation } from '@/lib/health-assistant'
import { dailyCardioLoad, workloadRatio } from '@/lib/cardio-load'
import { buildInsights } from '@/lib/insight-engine'
import { EMPTY_USER_PROFILE } from '@/lib/user-profile'
import type { AppIcon } from '@/components/icons'
import {
  ActivityIcon,
  BodyIcon,
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CloudIcon,
  DeviceIcon,
  DisconnectIcon,
  ExportIcon,
  HeartIcon,
  LoaderIcon,
  SettingsIcon,
  ShieldIcon,
  SleepIcon,
  SparkleIcon,
  StepsIcon,
  TodayIcon,
} from '@/components/icons'

type NavCategory = 'summary' | 'activity' | 'heart' | 'sleep' | 'body' | 'device'

const navItems: Array<{ id: PageId; label: string; copy: string; icon: AppIcon; category: NavCategory }> = [
  { id: 'today', label: 'Today', copy: 'The day’s essential overview.', icon: TodayIcon, category: 'summary' },
  { id: 'activity', label: 'Activity', copy: 'Goals, hourly distribution, and workouts.', icon: ActivityIcon, category: 'activity' },
  { id: 'health', label: 'Health', copy: 'Cardiac and physiological signals over time.', icon: HeartIcon, category: 'heart' },
  { id: 'sleep', label: 'Sleep', copy: 'Duration, quality, and composition of your latest night’s sleep.', icon: SleepIcon, category: 'sleep' },
  { id: 'body', label: 'Body', copy: 'Weight, composition, and daily balance.', icon: BodyIcon, category: 'body' },
  { id: 'devices', label: 'Data', copy: 'Sources, coverage, and local protection.', icon: DeviceIcon, category: 'device' },
]

const defaultStatus: FitbitAuthStatus = {
  hasBackend: false,
  configured: false,
  connected: false,
  storageEncrypted: false,
  lastSyncAt: null,
  provider: 'google-health',
}

// Google issues a refresh token that expires after seven days while the OAuth
// consent screen is still in testing, so a signed-in account whose health access
// has lapsed is the ordinary case. It is explained rather than reported as a
// fault, and the way out is a fresh consent — the same Google sign-in.
const RECONNECT_EXPLANATION = 'Google expires health access after about a week while the OAuth consent screen is in testing. Reconnect to grant it again; you stay signed in either way.'

interface ToastState {
  tone: 'success' | 'error' | 'neutral'
  message: string
}

interface SyncProgressState {
  completed: number
  total: number
  key?: string
  date?: string
}

function shiftDate(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number)
  return localIso(new Date(year, month - 1, day + days, 12))
}

/**
 * The cached archive's days as dashboards, ascending.
 *
 * Cardio load prefers per-workout heart zones, and only a full day payload
 * carries them; the visible trend row has Active Zone Minutes and nothing finer.
 */
function archiveDashboards(archive: RawHealthArchive | null | undefined): DashboardData[] {
  if (!archive) return []
  return Object.values(archive.days)
    .map((payload) => normalizeFitbitData(payload))
    .sort((left, right) => left.selectedDate.localeCompare(right.selectedDate))
}

function IconButton({ label, children, ...props }: { label: string; children: ReactNode } & React.ComponentProps<typeof Button>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><Button aria-label={label} variant="ghost" size="icon" {...props}>{children}</Button></TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export default function App() {
  const [page, setPage] = useState<PageId>('today')
  const [selectedDate, setSelectedDate] = useState(localIso())
  const [data, setData] = useState<DashboardData>(() => createDemoData())
  const [status, setStatus] = useState(defaultStatus)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncTargetDate, setSyncTargetDate] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [syncProgress, setSyncProgress] = useState<SyncProgressState | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [profile, setProfile] = useState<UserProfile>(EMPTY_USER_PROFILE)
  const [archive, setArchive] = useState<DashboardData[]>([])
  const [assistantSeed, setAssistantSeed] = useState<string | null>(null)
  const selectedDateRef = useRef(selectedDate)
  const dataDateRef = useRef(data.selectedDate)
  const syncingRef = useRef(false)
  const syncTargetDateRef = useRef<string | null>(null)
  const queuedDateRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [page])

  useEffect(() => {
    selectedDateRef.current = selectedDate
  }, [selectedDate])

  useEffect(() => {
    dataDateRef.current = data.selectedDate
  }, [data.selectedDate])

  // One read at startup. A rejection is the demo path or an unreachable API,
  // and both fall back to the all-null profile rather than blanking the app —
  // every consumer of `UserProfile` already handles a null in every field.
  useEffect(() => {
    let cancelled = false
    void profileApi
      .get()
      .then((next) => { if (!cancelled) setProfile(next) })
      .catch(() => { if (!cancelled) setProfile(EMPTY_USER_PROFILE) })
    return () => { cancelled = true }
  }, [])

  // The archive only changes when a sync writes to it, so it is read on mount
  // and after a sync rather than on every date change. Without it the cardio
  // load series falls back to the trend row's Active Zone Minutes, which is
  // coarser but still labelled as such by `dailyCardioLoad`.
  const loadArchive = useCallback(async () => {
    try {
      setArchive(archiveDashboards(await fitbit.getCachedArchive()))
    } catch {
      setArchive([])
    }
  }, [])

  const loadNativeState = useCallback(async () => {
    try {
      const [nextStatus, cached] = await Promise.all([fitbit.getStatus(), fitbit.getCachedData()])
      setStatus(nextStatus)
      if (cached) {
        const normalized = normalizeFitbitData(cached)
        dataDateRef.current = normalized.selectedDate
        selectedDateRef.current = normalized.selectedDate
        setData({ ...normalized, source: 'cache' })
        setSelectedDate(normalized.selectedDate)
      }
    } catch (error) {
      setToast({ tone: 'error', message: error instanceof Error ? error.message : 'Unable to read the local status.' })
    }
  }, [])

  const runSync = useCallback(async (requestedDate?: string) => {
    const firstDate = requestedDate ?? selectedDateRef.current
    if (syncingRef.current) {
      queuedDateRef.current = firstDate
      return
    }

    syncingRef.current = true
    setSyncing(true)
    let nextDate: string | null = firstDate

    try {
      while (nextDate) {
        const date: string = nextDate
        queuedDateRef.current = null
        syncTargetDateRef.current = date
        setSyncTargetDate(date)
        setSyncProgress({ completed: 0, total: 0 })

        try {
          const payload = await fitbit.sync(date)
          const normalized = normalizeFitbitData(payload)

          if (selectedDateRef.current === date) {
            dataDateRef.current = normalized.selectedDate
            setData(normalized)
            setToast({
              tone: payload.cacheHit || payload.errors.length ? 'neutral' : 'success',
              message: payload.cacheHit
                ? 'Day loaded from the local archive.'
                : payload.errors.length
                ? `Updated. ${payload.errors.length} sources have no data for this period.`
                : 'Data updated.',
            })
          }

          void fitbit.getStatus().then(setStatus).catch(() => undefined)
          void loadArchive()
        } catch (error) {
          const queuedDate = queuedDateRef.current
          const failedDateIsStillSelected = selectedDateRef.current === date
          const hasDifferentDateQueued = Boolean(queuedDate && queuedDate !== date)

          if (failedDateIsStillSelected && !hasDifferentDateQueued) {
            selectedDateRef.current = dataDateRef.current
            setSelectedDate(dataDateRef.current)
            setToast({ tone: 'error', message: error instanceof Error ? error.message : 'Sync failed.' })
          }
        }

        const queuedDate = queuedDateRef.current
        queuedDateRef.current = null
        nextDate = queuedDate && queuedDate !== date ? queuedDate : null
      }
    } finally {
      syncingRef.current = false
      syncTargetDateRef.current = null
      queuedDateRef.current = null
      setSyncing(false)
      setSyncTargetDate(null)
      setSyncProgress(null)
    }
  }, [loadArchive])

  useEffect(() => {
    void loadNativeState()
    void loadArchive()
    const unsubscribeAuth = fitbit.onAuthComplete(async (result) => {
      setConnecting(false)
      if (!result.ok) {
        setToast({ tone: 'error', message: result.error ?? 'Authorization failed.' })
        return
      }
      setSettingsOpen(false)
      const authDate = selectedDateRef.current
      setToast({ tone: 'success', message: 'Account connected. Syncing data…' })
      await loadNativeState()
      selectedDateRef.current = authDate
      setSelectedDate(authDate)
      void runSync(authDate)
    })
    const unsubscribeSync = fitbit.onSyncProgress((progress) => {
      if (syncingRef.current && (!progress.date || progress.date === syncTargetDateRef.current)) {
        setSyncProgress(progress)
      }
    })
    return () => {
      unsubscribeAuth()
      unsubscribeSync()
    }
  }, [loadArchive, loadNativeState, runSync])

  useEffect(() => {
    if (!toast) return
    if (toast.tone === 'error') return
    const timer = window.setTimeout(() => setToast(null), 4_500)
    return () => window.clearTimeout(timer)
  }, [toast])

  const visibleNav = navItems

  const changeDate = (date: string) => {
    if (!date || date > localIso()) return
    selectedDateRef.current = date
    setSelectedDate(date)
    if (data.source === 'demo' && !status.connected) {
      const demoData = createDemoData(date)
      dataDateRef.current = demoData.selectedDate
      setData(demoData)
      return
    }
    if (status.connected) void runSync(date)
  }

  // Reconnecting is a full-page redirect to Google, so a success here means the
  // browser is on its way out of this document and `connecting` never has to be
  // cleared again. There is nothing to configure first: the OAuth client comes
  // from the server's environment.
  const connect = async () => {
    if (!status.configured) {
      setToast({
        tone: 'error',
        message: 'This OpenFit server has no Google OAuth client. Set OPENFIT_GOOGLE_CLIENT_ID and OPENFIT_GOOGLE_CLIENT_SECRET in its .env file and restart it.',
      })
      return
    }
    setConnecting(true)
    try {
      const result = await fitbit.connect()
      if (!result.ok) throw new Error(result.message ?? 'Unable to start Google authorization.')
      setToast({ tone: 'neutral', message: 'Opening the Google consent screen…' })
    } catch (error) {
      setConnecting(false)
      setToast({ tone: 'error', message: error instanceof Error ? error.message : 'Connection failed.' })
    }
  }

  const signOut = async (everywhere: boolean) => {
    setSigningOut(true)
    try {
      const result = await session.signOut(everywhere)
      // The server has already cleared this browser's cookie by now, so the
      // page cannot stay usable either way. It is still not allowed to claim
      // the other devices were signed out when the epoch was not bumped — that
      // is the whole point of the control, and someone who lost a device would
      // walk away believing it had been locked out.
      if (everywhere && !result.revoked) {
        throw new Error('Signed out here, but no other devices could be signed out — this server found no session to revoke. Sign in again and retry.')
      }
      session.goToLoginPage()
    } catch (error) {
      setSigningOut(false)
      setToast({ tone: 'error', message: error instanceof Error ? error.message : 'Signing out failed.' })
    }
  }

  // Both of these refuse while a sync is in flight, and the export refuses when
  // there is nothing real to write. Left unhandled the rejection would go to the
  // console and the button would look like it did nothing at all.
  const disconnect = async () => {
    try {
      setStatus(await fitbit.disconnect())
      setData(createDemoData(selectedDate))
      setArchive([])
      setSettingsOpen(false)
      setPage('today')
      setToast({ tone: 'success', message: 'Account disconnected and local data removed.' })
    } catch (error) {
      setToast({ tone: 'error', message: error instanceof Error ? error.message : 'Disconnecting failed.' })
    }
  }

  const exportData = async () => {
    if (data.source === 'demo') {
      setToast({ tone: 'neutral', message: 'Reconnect Google Health to export real data.' })
      return
    }
    try {
      const result = await fitbit.exportData()
      if (!result.canceled) setToast({ tone: 'success', message: 'JSON archive exported.' })
    } catch (error) {
      setToast({ tone: 'error', message: error instanceof Error ? error.message : 'The export failed.' })
    }
  }

  // Opens the assistant with the question already written, unsent. The insight
  // that raised it names its own metric, numbers, and window, and the user has
  // to be able to read and edit that before it goes anywhere.
  const askAssistant = useCallback((prompt: string) => {
    setAssistantSeed(prompt)
    setAssistantOpen(true)
  }, [])

  // Computed once for the whole app. Today, Activity, and Health all read it,
  // and recomputing inside each view would triple the work on every navigation.
  const analysis = useMemo(() => {
    const loads = dailyCardioLoad(loadDaysFor(data, archive))
    return {
      loads,
      workload: workloadRatio(loads, data.selectedDate),
      insights: buildInsights(data, profile, { loads }),
    }
  }, [archive, data, profile])

  const currentView = useMemo(() => {
    const props = {
      data,
      status,
      navigate: setPage,
      profile,
      insights: analysis.insights,
      loads: analysis.loads,
      workload: analysis.workload,
      onImprove: askAssistant,
    }
    if (page === 'activity') return <ActivityView {...props} />
    if (page === 'health') return <HealthView {...props} />
    if (page === 'sleep') return <SleepView {...props} />
    if (page === 'body') return <BodyView {...props} />
    if (page === 'devices') return <DevicesView {...props} />
    return <TodayView {...props} />
  }, [analysis, askAssistant, data, page, profile, status])

  const isToday = selectedDate === localIso()
  const sourceProviderLabel = status.provider === 'fitbit-legacy' ? 'Fitbit legacy' : 'Google Health'
  const sourceLabel = status.connected
    ? sourceProviderLabel
    : data.source === 'demo' ? 'Demo data' : 'Local cache'
  const pageMeta = navItems.find((item) => item.id === page) ?? navItems[0]
  const loadingSelectedDate = syncing && data.selectedDate !== selectedDate
  const selectedDateQueued = loadingSelectedDate && syncTargetDate !== null && syncTargetDate !== selectedDate
  const syncProgressPercent = syncProgress && syncProgress.total > 0
    ? Math.round(syncProgress.completed / syncProgress.total * 100)
    : null
  const syncProgressLabel = syncProgress?.total
    ? `${syncProgress.completed} of ${syncProgress.total} sources`
    : 'Starting secure sync…'
  const batteryLevel = data.device?.batteryLevel == null
    ? null
    : Math.max(0, Math.min(100, Math.round(data.device.batteryLevel)))

  const navigate = (nextPage: PageId) => {
    setPage(nextPage)
  }

  const navigateFromAssistant = (navigation: AssistantNavigation) => {
    if (navigation.date) changeDate(navigation.date)
    if (navigation.page) setPage(navigation.page)
  }

  return (
    <SidebarProvider className={cn('app-shell', assistantOpen && 'assistant-open')}>
      <div className="window-drag-region" />
      <OpenFitSidebar
        items={visibleNav}
        page={page}
        userName={data.profile.displayName}
        userAvatar={data.profile.avatar}
        sourceLabel={sourceLabel}
        onNavigate={navigate}
        onSettings={() => setSettingsOpen(true)}
      />

      <SidebarInset className="main-area">
        <header className="topbar">
          <div className="topbar-heading">
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarTrigger className="sidebar-trigger" aria-label="Toggle navigation" />
              </TooltipTrigger>
              <TooltipContent>Toggle navigation</TooltipContent>
            </Tooltip>
            <div>
              <h1>{pageMeta.label}</h1>
              <p className="topbar-meta">
                <span>{page === 'today' ? formatDate(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' }) : pageMeta.copy}</span>
              </p>
            </div>
          </div>

          <div className="topbar-actions">
            <div className="date-control">
              <IconButton label="Previous day" onClick={() => changeDate(shiftDate(selectedDate, -1))}><ChevronLeftIcon /></IconButton>
              <label className="date-picker">
                {loadingSelectedDate ? <LoaderCircle className="spin" aria-hidden="true" /> : <CalendarIcon aria-hidden="true" />}
                <span>{isToday ? 'Today' : formatDate(selectedDate, { day: 'numeric', month: 'short' })}</span>
                <input type="date" value={selectedDate} max={localIso()} onChange={(event) => changeDate(event.target.value)} />
              </label>
              <IconButton label="Next day" disabled={isToday} onClick={() => changeDate(shiftDate(selectedDate, 1))}><ChevronRightIcon /></IconButton>
            </div>

            {batteryLevel != null && (
              <div className="fitbit-battery" role="status" aria-label={`Fitbit battery ${batteryLevel}%`}>
                <span className="battery-glyph" aria-hidden="true">
                  <span className="battery-charge" style={{ width: `${batteryLevel}%` }} />
                </span>
                <span className="battery-percent">{batteryLevel}%</span>
              </div>
            )}

            <IconButton
              label={assistantOpen ? 'Close health assistant' : 'Open health assistant'}
              className={cn('assistant-toggle', assistantOpen && 'is-active')}
              aria-controls="health-assistant"
              aria-expanded={assistantOpen}
              onClick={() => setAssistantOpen((open) => !open)}
            >
              <Sparkles />
            </IconButton>
            {status.connected ? (
              <>
                {syncing && (
                  <span className="sync-status" role="status" aria-live="polite">
                    {syncProgress?.total ? `${syncProgress.completed}/${syncProgress.total}` : 'Syncing'}
                  </span>
                )}
                <IconButton
                  label={syncProgress?.total ? `Syncing data ${syncProgress.completed} of ${syncProgress.total}` : syncing ? 'Starting data sync' : 'Refresh data'}
                  className="refresh-button"
                  onClick={() => runSync()}
                  disabled={syncing}
                >
                  {syncing ? <LoaderCircle className="spin" /> : <RefreshCw />}
                </IconButton>
              </>
            ) : (
              <Button className="connect-button" aria-label={`Reconnect ${sourceProviderLabel}`} onClick={connect} disabled={connecting}>
                {connecting ? <LoaderIcon className="spin" /> : <CloudIcon />}<span>Reconnect</span>
              </Button>
            )}
          </div>
        </header>

        <div className="page-content" key={page} aria-busy={loadingSelectedDate}>
          {loadingSelectedDate ? (
            <div className="date-loading" role="status" aria-live="polite">
              <LoaderCircle className="spin" aria-hidden="true" />
              <div>
                <strong>
                  {selectedDateQueued
                    ? `${formatDate(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' })} is next`
                    : `Loading ${formatDate(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' })}`}
                </strong>
                <span>
                  {selectedDateQueued && syncTargetDate
                    ? `Finishing ${formatDate(syncTargetDate, { day: 'numeric', month: 'short' })} first · ${syncProgressLabel}`
                    : syncProgressLabel}
                </span>
                <div
                  className={cn('date-loading-progress', syncProgressPercent === null && 'is-indeterminate')}
                  role="progressbar"
                  aria-label="Data sync progress"
                  aria-valuemin={0}
                  aria-valuemax={syncProgress?.total || 100}
                  aria-valuenow={syncProgress?.total ? syncProgress.completed : undefined}
                >
                  <i style={{ width: syncProgressPercent === null ? '32%' : `${syncProgressPercent}%` }} />
                </div>
                {selectedDateQueued && <small>You can keep moving between days; the latest selection loads next.</small>}
              </div>
            </div>
          ) : currentView}
        </div>
      </SidebarInset>

      <HealthAssistant
        open={assistantOpen}
        data={data}
        page={page}
        profile={profile}
        initialPrompt={assistantSeed}
        onInitialPromptConsumed={() => setAssistantSeed(null)}
        onOpenChange={setAssistantOpen}
        onNavigate={navigateFromAssistant}
      />

      <AccountDialog
        open={settingsOpen}
        status={status}
        connecting={connecting}
        signingOut={signingOut}
        onOpenChange={setSettingsOpen}
        onConnect={connect}
        onExport={exportData}
        onDisconnect={disconnect}
        onSignOut={signOut}
        onProfileChange={setProfile}
      />

      {toast && (
        <div className={cn('toast', `toast-${toast.tone}`)} role={toast.tone === 'error' ? 'alert' : 'status'}>
          {toast.tone === 'success' ? <CheckIcon /> : toast.tone === 'error' ? <CloseIcon /> : <SparkleIcon />}
          <span>{toast.message}</span>
          <button className="toast-close" aria-label="Close notification" onClick={() => setToast(null)}><CloseIcon /></button>
        </div>
      )}
    </SidebarProvider>
  )
}

function OpenFitSidebar({
  items,
  page,
  userName,
  userAvatar,
  sourceLabel,
  onNavigate,
  onSettings,
}: {
  items: typeof navItems
  page: PageId
  userName: string
  userAvatar: string | null
  sourceLabel: string
  onNavigate: (page: PageId) => void
  onSettings: () => void
}) {
  const { setOpenMobile } = useSidebar()
  const initials = userName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'PB'
  const wellbeingItems = items.filter((item) => item.id !== 'devices')
  const dataItem = items.find((item) => item.id === 'devices')

  const selectPage = (nextPage: PageId) => {
    onNavigate(nextPage)
    setOpenMobile(false)
  }

  const openSettings = () => {
    setOpenMobile(false)
    onSettings()
  }

  return (
    <Sidebar collapsible="icon" className="pulse-sidebar">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="sidebar-workspace" tooltip="OpenFit" onClick={() => selectPage('today')}>
              <span className="sidebar-workspace-mark">
                <img src="./app-icon.png" alt="" aria-hidden="true" />
              </span>
              <span className="sidebar-workspace-copy">
                <strong>OpenFit</strong>
                <small>Health dashboard</small>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Wellbeing</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu aria-label="Main navigation">
              {wellbeingItems.map(({ id, label, icon: Icon, category }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    data-category={category}
                    isActive={page === id}
                    tooltip={label}
                    aria-current={page === id ? 'page' : undefined}
                    onClick={() => selectPage(id)}
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Management</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {dataItem && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    data-category={dataItem.category}
                    isActive={page === dataItem.id}
                    tooltip={dataItem.label}
                    aria-current={page === dataItem.id ? 'page' : undefined}
                    onClick={() => selectPage(dataItem.id)}
                  >
                    <dataItem.icon aria-hidden="true" />
                    <span>{dataItem.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Settings" onClick={openSettings}>
                  <SettingsIcon />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="sidebar-user" tooltip={userName} onClick={openSettings}>
              <Avatar className="sidebar-user-avatar">
                {userAvatar && <AvatarImage src={userAvatar} alt="" />}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <span className="sidebar-user-copy">
                <strong>{userName}</strong>
                <small>{sourceLabel}</small>
              </span>
              <ChevronsUpDown className="sidebar-switcher-icon" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function AccountDialog({
  open,
  status,
  connecting,
  signingOut,
  onOpenChange,
  onConnect,
  onExport,
  onDisconnect,
  onSignOut,
  onProfileChange,
}: {
  open: boolean
  status: FitbitAuthStatus
  connecting: boolean
  signingOut: boolean
  onOpenChange: (open: boolean) => void
  onConnect: () => Promise<void>
  onExport: () => Promise<void>
  onDisconnect: () => Promise<void>
  onSignOut: (everywhere: boolean) => Promise<void>
  onProfileChange: (profile: UserProfile) => void
}) {
  const providerLabel = status.provider === 'fitbit-legacy' ? 'Fitbit legacy' : 'Google Health'
  const busy = connecting || signingOut

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-dialog" showCloseButton>
        <DialogHeader>
          <div className="dialog-icon"><CloudIcon /></div>
          <DialogTitle>{status.connected ? `${providerLabel} connected` : `${providerLabel} disconnected`}</DialogTitle>
          <DialogDescription>
            You are signed in to this OpenFit server with Google. Health data and tokens stay encrypted on the machine that runs it.
          </DialogDescription>
        </DialogHeader>

        <div className="connected-state">
          <div className={cn('connection-check', !status.connected && 'is-warning')}>
            {status.connected ? <CheckIcon /> : <CloudIcon />}
          </div>
          <div>
            <h3>{status.connected ? 'Sync active' : 'Health access expired'}</h3>
            <p>{status.connected ? `Last updated ${relativeTime(status.lastSyncAt)}.` : RECONNECT_EXPLANATION}</p>
          </div>

          <div className="scope-note">
            <ShieldIcon />
            <p>One Google consent covers signing in and read-only access to activity, heart, sleep, and authorized measurements. OpenFit never asks for a Client ID or Client Secret — the server operator sets those in its environment.</p>
          </div>

          <div className="connected-actions">
            <Button onClick={() => void onConnect()} disabled={busy}>
              {connecting ? <LoaderCircle className="spin" /> : <RefreshCw />}
              {status.connected ? 'Reauthorize health access' : `Reconnect ${providerLabel}`}
            </Button>
            {/* The archive is local, so it stays exportable while health access is lapsed. */}
            <Button variant="outline" onClick={() => void onExport()} disabled={busy}><ExportIcon /> Export data</Button>
            <Button variant="outline" onClick={() => void onSignOut(false)} disabled={busy}>
              {signingOut ? <LoaderCircle className="spin" /> : <DisconnectIcon />} Sign out of this browser
            </Button>
            {/* The only way to end a session on a device you no longer hold. */}
            <Button variant="outline" onClick={() => void onSignOut(true)} disabled={busy}>
              <ShieldIcon /> Sign out everywhere
            </Button>
            <Button variant="destructive" onClick={() => void onDisconnect()} disabled={busy}>
              <CloseIcon /> Disconnect and delete local data
            </Button>
          </div>
        </div>

        <ProfileSettings onChange={onProfileChange} />
      </DialogContent>
    </Dialog>
  )
}
