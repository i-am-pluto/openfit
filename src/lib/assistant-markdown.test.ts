import { describe, expect, it } from 'vitest'
import { safeMarkdownUrl, stabilizeStreamingMarkdown } from './assistant-markdown'

describe('stabilizeStreamingMarkdown', () => {
  it('leaves balanced text untouched', () => {
    const text = 'Your resting heart rate is **58 bpm**.\n\n```\nsteps: 8412\n```\n'
    expect(stabilizeStreamingMarkdown(text)).toBe(text)
  })

  it('closes a fence that opened but has not closed yet', () => {
    const text = 'Here is the raw day:\n\n```json\n{ "steps": 8412'
    expect(stabilizeStreamingMarkdown(text)).toBe(`${text}\n\`\`\``)
  })

  it('counts only fences that begin a line', () => {
    // Inline backticks are not fences and must not trigger a synthetic close.
    const text = 'Use the ```steps``` field.'
    expect(stabilizeStreamingMarkdown(text)).toBe(text)
  })

  it('treats an indented fence as a fence', () => {
    const text = '- Example:\n\n   ```\n   steps: 1'
    expect(stabilizeStreamingMarkdown(text)).toBe(`${text}\n\`\`\``)
  })

  it('handles longer fence runs', () => {
    const text = '````\ncontent'
    expect(stabilizeStreamingMarkdown(text)).toBe(`${text}\n\`\`\``)
  })

  it('returns empty text unchanged', () => {
    expect(stabilizeStreamingMarkdown('')).toBe('')
  })
})

describe('safeMarkdownUrl', () => {
  it('keeps http and https targets', () => {
    expect(safeMarkdownUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(safeMarkdownUrl('http://example.com/a')).toBe('http://example.com/a')
  })

  it('refuses every other scheme', () => {
    expect(safeMarkdownUrl('javascript:alert(1)')).toBe('')
    expect(safeMarkdownUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe('')
    expect(safeMarkdownUrl('file:///etc/passwd')).toBe('')
    expect(safeMarkdownUrl('vbscript:msgbox')).toBe('')
  })

  it('refuses a scheme disguised with whitespace or case', () => {
    expect(safeMarkdownUrl('  JaVaScRiPt:alert(1)')).toBe('')
    expect(safeMarkdownUrl('java\nscript:alert(1)')).toBe('')
  })

  it('refuses a relative target rather than resolving it against this origin', () => {
    expect(safeMarkdownUrl('/api/export')).toBe('')
    expect(safeMarkdownUrl('#anchor')).toBe('')
  })

  it('refuses a non-string', () => {
    expect(safeMarkdownUrl(undefined as unknown as string)).toBe('')
  })
})
