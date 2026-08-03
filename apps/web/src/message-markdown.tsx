import { Link } from '@tanstack/react-router'
import { memo, useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { withBase } from './base-path'

export function workspaceMarkdownPath(href: string | undefined) {
  if (!href || href.startsWith('#')) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? '')
  } catch {
    return null
  }
  const workspacePath = decoded.startsWith('/scoped-workspace/')
    ? decoded.slice('/scoped-workspace/'.length)
    : decoded.startsWith('/workspace/')
      ? decoded.slice('/workspace/'.length)
      : decoded.replace(/^\/+/, '')
  if (
    !workspacePath ||
    workspacePath.includes('\0') ||
    workspacePath.split('/').includes('..')
  )
    return null
  return workspacePath.split('/').filter(Boolean).join('/')
}

export function workspaceMarkdownHref(
  href: string | undefined,
  sessionId?: string,
) {
  const workspacePath = workspaceMarkdownPath(href)
  if (!workspacePath) return null
  const encodedPath = workspacePath.split('/').map(encodeURIComponent).join('/')
  return sessionId
    ? withBase(
        `/sessions/${encodeURIComponent(sessionId)}/files/${encodedPath}`,
      )
    : withBase(`/files/${encodedPath}`)
}

function markdownComponents(sessionId?: string): Components {
  return {
    a: ({ node: _node, href, children, title }) => {
      const workspacePath = workspaceMarkdownPath(href)
      return workspacePath ? (
        sessionId ? (
          <Link
            to="/sessions/$sessionId/files/$"
            params={{ sessionId, _splat: workspacePath }}
            {...(title ? { title } : {})}
          >
            {children}
          </Link>
        ) : (
          <Link
            to="/files/$"
            params={{ _splat: workspacePath }}
            search={{ sessionId: undefined }}
            {...(title ? { title } : {})}
          >
            {children}
          </Link>
        )
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          {...(title ? { title } : {})}
        >
          {children}
        </a>
      )
    },
  }
}

const MessageMarkdown = memo(function MessageMarkdown({
  children,
  sessionId,
}: {
  children: string
  sessionId?: string | undefined
}) {
  const components = useMemo(() => markdownComponents(sessionId), [sessionId])
  return (
    <div className="message-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
})

export default MessageMarkdown
