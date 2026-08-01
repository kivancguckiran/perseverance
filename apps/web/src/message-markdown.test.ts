import { describe, expect, it } from 'vitest'
import { workspaceMarkdownHref } from './message-markdown'

describe('workspace markdown links', () => {
  it('routes relative and /workspace paths through the authenticated viewer', () => {
    expect(workspaceMarkdownHref('yazilar/index.md')).toContain(
      '/files/yazilar/index.md',
    )
    expect(workspaceMarkdownHref('/workspace/yazilar/index.md')).toContain(
      '/files/yazilar/index.md',
    )
  })

  it('leaves external links external and rejects traversal', () => {
    expect(workspaceMarkdownHref('https://example.com')).toBeNull()
    expect(workspaceMarkdownHref('../secret.md')).toBeNull()
  })
})
