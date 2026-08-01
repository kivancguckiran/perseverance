import { Link } from '@tanstack/react-router'
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
  const target = withBase(`/files/${encodedPath}`)
  return sessionId
    ? `${target}?sessionId=${encodeURIComponent(sessionId)}`
    : target
}

function markdownComponents(sessionId?: string): Components {
  return {
    a: ({ node: _node, href, children, title }) => {
      const workspacePath = workspaceMarkdownPath(href)
      return workspacePath ? (
        <Link
          to="/files/$"
          params={{ _splat: workspacePath }}
          search={{ sessionId }}
          {...(title ? { title } : {})}
        >
          {children}
        </Link>
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

export default function MessageMarkdown({
  children,
  sessionId,
}: {
  children: string
  sessionId?: string | undefined
}) {
  const components = markdownComponents(sessionId)
  return (
    <div className="message-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
