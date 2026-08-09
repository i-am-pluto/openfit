import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TextMessagePartComponent } from '@assistant-ui/react'
import { safeMarkdownUrl, stabilizeStreamingMarkdown } from '@/lib/assistant-markdown'

/**
 * Renders an assistant text part as markdown.
 *
 * Raw HTML is never rendered: `rehype-raw` is deliberately absent, so the
 * `<!-- openfit:navigate ... -->` directive cannot reach the DOM even if
 * `stripAssistantNavigation` were to miss it. That strip remains the primary
 * control and this is the second one — do not add `rehype-raw` to this file.
 *
 * Tables are wrapped rather than styled loose: the assistant lives in a narrow
 * sidebar, and a wide table has to scroll itself instead of the panel.
 */
export const MarkdownText: TextMessagePartComponent = ({ text, status }) => {
  const source = status?.type === 'running' ? stabilizeStreamingMarkdown(text) : text

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={safeMarkdownUrl}
      components={{
        a: ({ children, href, ...props }) => (
          href
            ? <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>
            : <span {...props}>{children}</span>
        ),
        table: ({ children, ...props }) => (
          <div className="assistant-table-scroll">
            <table {...props}>{children}</table>
          </div>
        ),
      }}
    >
      {source}
    </ReactMarkdown>
  )
}
