import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MessageMarkdown, { workspaceMarkdownHref } from './message-markdown'

describe('workspace markdown links', () => {
  it('routes relative and /workspace paths through the authenticated viewer', () => {
    expect(workspaceMarkdownHref('yazilar/index.md')).toContain(
      '/files/yazilar/index.md',
    )
    expect(workspaceMarkdownHref('/workspace/yazilar/index.md')).toContain(
      '/files/yazilar/index.md',
    )
    expect(
      workspaceMarkdownHref('/scoped-workspace/index.md', 'ses_1'),
    ).toContain('/sessions/ses_1/files/index.md')
  })

  it('leaves external links external and rejects traversal', () => {
    expect(workspaceMarkdownHref('https://example.com')).toBeNull()
    expect(workspaceMarkdownHref('../secret.md')).toBeNull()
  })

  it('renders workspace files as authenticated document navigations', () => {
    const html = renderToStaticMarkup(
      createElement(MessageMarkdown, {
        sessionId: 'ses_1',
        children: '[Kavram atlası](/scoped-workspace/corpus/atlas.md)',
      }),
    )
    expect(html).toContain('href="/sessions/ses_1/files/corpus/atlas.md"')
  })
})
