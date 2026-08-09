/**
 * Pure helpers for rendering assistant output as markdown.
 *
 * The assistant's text is untrusted: it is produced by a model reasoning over
 * health data, and neither side of that is a trust boundary. These helpers make
 * no attempt to sanitize HTML — that is handled by never enabling `rehype-raw`
 * in the renderer — and only cover the two problems `react-markdown` leaves to
 * the caller: partial text during streaming, and link targets.
 */

// A fence opens a block only when it starts a line, after at most three spaces
// of indentation. Backticks anywhere else in the line are inline code.
const fenceLine = /^ {0,3}(`{3,}|~{3,})/

/**
 * Closes a code fence that has opened but not yet closed.
 *
 * Apply to in-flight streaming text only. Without it, everything after an
 * unterminated fence renders inside a code block until the closing fence
 * arrives, which flickers the whole message.
 */
export function stabilizeStreamingMarkdown(text: string): string {
  if (!text) return text

  let openMarker: string | null = null
  for (const line of text.split('\n')) {
    const match = fenceLine.exec(line)
    if (!match) continue
    const marker = match[1]
    if (openMarker === null) {
      openMarker = marker[0]
      continue
    }
    // A fence closes only with the same character it opened with.
    if (marker[0] === openMarker) openMarker = null
  }

  return openMarker === null ? text : `${text}\n${openMarker.repeat(3)}`
}

/**
 * Allowlists link targets by scheme.
 *
 * Returns '' for anything that is not an absolute http(s) URL, which
 * `react-markdown` renders as a link with no destination. Relative targets are
 * refused too: resolving them against this origin would let assistant output
 * point at OpenFit's own endpoints.
 */
export function safeMarkdownUrl(url: string): string {
  if (typeof url !== 'string') return ''
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : ''
  } catch {
    return ''
  }
}
