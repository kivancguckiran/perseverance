import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import MessageMarkdown from '../message-markdown'
import { apiBaseUrl, scopeHeaders } from '../workspace-page'
import { useTranslations } from '../i18n'

type WorkspaceEntry =
  | { kind: 'file'; path: string; content: string }
  | {
      kind: 'directory'
      path: string
      entries: Array<{ name: string; directory: boolean }>
    }

export function copyWorkspaceFileContent(
  content: string,
  clipboard: Pick<Clipboard, 'writeText'> = navigator.clipboard,
) {
  return clipboard.writeText(content)
}

export function WorkspaceFilePage({
  path,
  sessionId,
}: {
  path: string
  sessionId?: string | undefined
}) {
  const t = useTranslations()
  const [entry, setEntry] = useState<WorkspaceEntry>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setEntry(undefined)
    setError(undefined)
    setCopied(false)
    void fetch(
      `${apiBaseUrl}/v1/workspace-files?path=${encodeURIComponent(path)}&sessionId=${encodeURIComponent(sessionId ?? '')}`,
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
  }, [path, sessionId, t])

  return (
    <main className="workspace-file-page">
      <header>
        {sessionId ? (
          <Link
            className="workspace-file-back"
            to="/sessions/$sessionId"
            params={{ sessionId }}
            replace
            aria-label={t('Back to conversation', 'Konuşmaya dön')}
            title={t('Back to conversation', 'Konuşmaya dön')}
          >
            ←
          </Link>
        ) : (
          <Link
            className="workspace-file-back"
            to="/"
            aria-label={t('Conversations', 'Konuşmalar')}
            title={t('Conversations', 'Konuşmalar')}
          >
            ←
          </Link>
        )}
        <div className="workspace-file-actions">
          <code title={`/${path}`}>/{path}</code>
          {entry?.kind === 'file' ? (
            <button
              className={`workspace-file-copy${copied ? ' is-copied' : ''}`}
              type="button"
              aria-live="polite"
              aria-label={t(
                copied ? 'File copied' : 'Copy file',
                copied ? 'Dosya kopyalandı' : 'Dosyayı kopyala',
              )}
              title={t(
                copied ? 'File copied' : 'Copy file',
                copied ? 'Dosya kopyalandı' : 'Dosyayı kopyala',
              )}
              onClick={() => {
                void copyWorkspaceFileContent(entry.content)
                  .then(() => setCopied(true))
                  .catch(() =>
                    setError(
                      t('File could not be copied', 'Dosya kopyalanamadı'),
                    ),
                  )
              }}
              onBlur={() => setCopied(false)}
            >
              {copied ? (
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="m4.5 10.5 3.25 3.25L15.5 6" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <rect x="6.5" y="6.5" width="9" height="9" rx="1" />
                  <path d="M13.5 6.5v-2h-9v9h2" />
                </svg>
              )}
            </button>
          ) : null}
        </div>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {!entry && !error ? <p>{t('Loading…', 'Yükleniyor…')}</p> : null}
      {entry?.kind === 'file' ? (
        path.toLowerCase().endsWith('.md') ? (
          <MessageMarkdown sessionId={sessionId}>
            {entry.content}
          </MessageMarkdown>
        ) : (
          <pre className="workspace-file-plain">{entry.content}</pre>
        )
      ) : null}
      {entry?.kind === 'directory' ? (
        <ul className="workspace-directory-list">
          {entry.entries.map((item) => {
            const childPath = [path, item.name].filter(Boolean).join('/')
            return (
              <li key={item.name}>
                {sessionId ? (
                  <Link
                    to="/sessions/$sessionId/files/$"
                    params={{ sessionId, _splat: childPath }}
                  >
                    {item.directory ? '▸ ' : ''}
                    {item.name}
                  </Link>
                ) : (
                  <Link
                    to="/files/$"
                    params={{ _splat: childPath }}
                    search={{ sessionId: undefined }}
                  >
                    {item.directory ? '▸ ' : ''}
                    {item.name}
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
    </main>
  )
}

function FilePage() {
  const params = Route.useParams()
  const search = Route.useSearch()
  return (
    <WorkspaceFilePage
      path={params._splat ?? ''}
      sessionId={search.sessionId}
    />
  )
}

export const Route = createFileRoute('/files/$')({
  validateSearch: (search: Record<string, unknown>) => ({
    sessionId:
      typeof search.sessionId === 'string' ? search.sessionId : undefined,
  }),
  component: FilePage,
})
