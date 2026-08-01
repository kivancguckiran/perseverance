import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { withBase } from './base-path'

export function workspaceMarkdownHref(href: string | undefined) {
  if (!href || href.startsWith('#')) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? '')
  } catch {
    return null
  }
  const workspacePath = decoded.startsWith('/workspace/')
    ? decoded.slice('/workspace/'.length)
    : decoded.replace(/^\/+/, '')
  if (
    !workspacePath ||
    workspacePath.includes('\0') ||
    workspacePath.split('/').includes('..')
  )
    return null
  return withBase(
    `/files/${workspacePath
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/')}`,
  )
}

const markdownComponents: Components = {
  a: ({ node: _node, href, ...props }) => {
    const workspaceHref = workspaceMarkdownHref(href)
    return workspaceHref ? (
      <a {...props} href={workspaceHref} />
    ) : (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener" />
    )
  },
}

export default function MessageMarkdown({ children }: { children: string }) {
  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
