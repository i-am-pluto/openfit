import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { Panel, PanelHeader } from '@/components/Shared'
import { chartMeta, chartOrder } from '@/lib/chart-registry'
import { buildChartExplainPrompt, type ChartReading } from '@/lib/chart-explain'
import type { PageId } from '@/types'
import { cn } from '@/lib/utils'
import type { AppIcon } from './icons'
import { FavouriteIcon, SparkleIcon } from './icons'

/**
 * A chart panel with the two things every chart should offer: ask the assistant
 * what it means, and pin it to the top.
 *
 * It renders the same `Panel` + `PanelHeader` pair the hand-written chart panels
 * do, so swapping one for the other changes nothing on screen except the header
 * actions. Ordering is done with CSS `order` (see `chartOrder`) rather than by
 * reordering the JSX, so each panel keeps its guards and its place in the tree.
 */
export interface ChartPanelProps {
  /** Registry id — drives the ordering and is passed to the explain prompt. */
  chartId: string
  title: string
  eyebrow?: string
  icon?: AppIcon
  category?: 'activity' | 'heart' | 'sleep' | 'recovery' | 'body' | 'device'
  className?: string
  children: ReactNode
  /** The span the chart draws, e.g. "14 days". Omitted means the assistant is told it is unknown. */
  window?: string
  /** The figures currently visible on the chart, handed to the assistant verbatim. */
  readings?: ChartReading[]
  /** A caveat the panel already shows the user, repeated to the assistant. */
  note?: string
  /** Every favourited chart id, used for ordering. */
  favourites?: readonly string[]
  /** Overrides membership of `favourites` for this panel. */
  favourite?: boolean
  onToggleFavourite?: (chartId: string) => void
  /** Absent when the assistant is unavailable — Explain then renders disabled, not hidden. */
  onExplain?: (prompt: string) => void
  /** A caller's own header action. Rendered beside Explain and Favourite, never instead of them. */
  action?: ReactNode
  tone?: 'default' | 'mint' | 'blue' | 'violet' | 'amber'
  onClick?: () => void
  ariaLabel?: string
}

const EXPLAIN_UNAVAILABLE = 'The assistant is not available here, so this chart cannot be explained right now.'

/**
 * Keeps a header button from firing the panel it sits in. A clickable `Panel`
 * listens for both clicks and Enter/Space, so the keyboard path has to be
 * stopped as well or the panel opens behind the assistant answer.
 */
function containKeys(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
}

export function ChartPanel({
  chartId,
  title,
  eyebrow,
  icon,
  category,
  className,
  children,
  window,
  readings = [],
  note,
  favourites = [],
  favourite,
  onToggleFavourite,
  onExplain,
  action,
  tone,
  onClick,
  ariaLabel,
}: ChartPanelProps) {
  const isFavourite = favourite ?? favourites.includes(chartId)
  const page = pageOf(chartId)

  const explain = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!onExplain) return
    onExplain(buildChartExplainPrompt({ chartId, title, page, window, readings, note }))
  }

  const toggleFavourite = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    onToggleFavourite?.(chartId)
  }

  const actions = (
    <div className="chart-panel-actions">
      {action}
      <button
        type="button"
        className="chart-panel-action"
        onClick={explain}
        onKeyDown={containKeys}
        disabled={!onExplain}
        title={onExplain ? `Ask the assistant about ${title}` : EXPLAIN_UNAVAILABLE}
      >
        <SparkleIcon aria-hidden="true" />
        Explain
      </button>
      <button
        type="button"
        className={cn('chart-panel-action', 'is-favourite', isFavourite && 'is-on')}
        onClick={toggleFavourite}
        onKeyDown={containKeys}
        aria-pressed={isFavourite}
        aria-label={isFavourite ? `Remove ${title} from favourites` : `Add ${title} to favourites`}
        title={isFavourite ? `Remove ${title} from favourites` : `Add ${title} to favourites`}
      >
        <FavouriteIcon aria-hidden="true" />
      </button>
    </div>
  )

  return (
    <Panel
      className={cn('chart-panel', className)}
      category={category}
      tone={tone}
      onClick={onClick}
      ariaLabel={ariaLabel}
      favourite={isFavourite}
      style={{ order: chartOrder(chartId, favourites) }}
    >
      <PanelHeader eyebrow={eyebrow} title={title} icon={icon} action={actions} />
      {children}
    </Panel>
  )
}

const PAGES: PageId[] = ['today', 'activity', 'health', 'sleep', 'body', 'devices']

/**
 * The view a chart belongs to. The registry is the authority; an id it has not
 * been told about falls back to its own prefix, which is how the ids are named,
 * so an unregistered panel still tells the assistant where it lives.
 */
function pageOf(chartId: string): PageId {
  const registered = chartMeta(chartId)
  if (registered) return registered.page
  const prefix = chartId.split('-')[0]
  return PAGES.find((page) => page === prefix) ?? 'today'
}
