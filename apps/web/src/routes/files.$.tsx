import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import MessageMarkdown from '../message-markdown'
import { withBase } from '../base-path'
import { apiBaseUrl, scopeHeaders } from '../workspace-page'
import { useTranslations } from '../i18n'

type WorkspaceEntry =
  | { kind: 'file'; path: string; content: string }
  | {
      kind: 'directory'
      path: string
      entries: Array<{ name: string; directory: boolean }>
    }

function FilePage() {
  const params = Route.useParams()
  const search = Route.useSearch()
  const path = params._splat ?? ''
  const t = useTranslations()
  const [entry, setEntry] = useState<WorkspaceEntry>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    const controller = new AbortController()
    setEntry(undefined)
    setError(undefined)
    void fetch(
      `${apiBaseUrl}/v1/workspace-files?path=${encodeURIComponent(path)}&sessionId=${encodeURIComponent(search.sessionId ?? '')}`,
      { headers: scopeHeaders, signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(t('File not found', 'Dosya bulunamadı'))
        return (await response.json()) as WorkspaceEntry
      })
      .then(setEntry)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => controller.abort()
  }, [path, search.sessionId, t])

  return (
    <main className="workspace-file-page">
      <header>
        <a href={withBase('/')}>← {t('Conversations', 'Konuşmalar')}</a>
        <code>/{path}</code>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {!entry && !error ? <p>{t('Loading…', 'Yükleniyor…')}</p> : null}
      {entry?.kind === 'file' ? (
        path.toLowerCase().endsWith('.md') ? (
          <MessageMarkdown sessionId={search.sessionId}>
            {entry.content}
          </MessageMarkdown>
        ) : (
          <pre className="workspace-file-plain">{entry.content}</pre>
        )
      ) : null}
      {entry?.kind === 'directory' ? (
        <ul className="workspace-directory-list">
          {entry.entries.map((item) => {
            const baseHref = withBase(
              `/files/${[path, item.name]
                .filter(Boolean)
                .map(encodeURIComponent)
                .join('/')}`,
            )
            const href = search.sessionId
              ? `${baseHref}?sessionId=${encodeURIComponent(search.sessionId)}`
              : baseHref
            return (
              <li key={item.name}>
                <a href={href}>
                  {item.directory ? '▸ ' : ''}
                  {item.name}
                </a>
              </li>
            )
          })}
        </ul>
      ) : null}
    </main>
  )
}

export const Route = createFileRoute('/files/$')({
  validateSearch: (search: Record<string, unknown>) => ({
    sessionId:
      typeof search.sessionId === 'string' ? search.sessionId : undefined,
  }),
  component: FilePage,
})
