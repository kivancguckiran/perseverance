import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { withBase } from './base-path'

export function workspaceMarkdownHref(
  href: string | undefined,
  sessionId?: string,
) {
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
  const target = withBase(
    `/files/${workspacePath
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/')}`,
  )
  return sessionId
    ? `${target}?sessionId=${encodeURIComponent(sessionId)}`
    : target
}

function markdownComponents(sessionId?: string): Components {
  return {
    a: ({ node: _node, href, ...props }) => {
      const workspaceHref = workspaceMarkdownHref(href, sessionId)
      return workspaceHref ? (
        <a {...props} href={workspaceHref} />
      ) : (
        <a {...props} href={href} target="_blank" rel="noreferrer noopener" />
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
