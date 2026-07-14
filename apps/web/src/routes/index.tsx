import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  serverMessageSchema,
  approvalListResponseSchema,
  approvalSchema,
  sessionResponseSchema,
  turnAcceptedResponseSchema,
  type SessionResponse,
  type Approval,
  type ApprovalDecision,
} from '@persistent-codex/control-plane-contracts'
import type { TimelineEvent } from '@persistent-codex/domain-events'
import { useEffect, useMemo, useRef, useState } from 'react'

interface PlatformMeta {
  service: string
  phase: string
  codexVersion: string
  transport: string
}

const apiBaseUrl =
  (import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) ??
  'http://127.0.0.1:3100'
const tenantId = 'ten_local'
const workspaceId = 'wsp_local'
const scopeHeaders = {
  'content-type': 'application/json',
  'x-tenant-id': tenantId,
  'x-workspace-id': workspaceId,
}

async function readPlatformMeta(): Promise<PlatformMeta> {
  const response = await fetch(`${apiBaseUrl}/v1/meta`)
  if (!response.ok) throw new Error('Control plane yanıt vermedi')
  return response.json() as Promise<PlatformMeta>
}

async function apiError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    message?: string
  } | null
  return new Error(body?.message ?? `İstek başarısız (${response.status})`)
}

export const Route = createFileRoute('/')({ component: WorkspacePage })

interface TimelineCard {
  key: string
  event: TimelineEvent
  text?: string
  output?: string
  completed: boolean
}

function itemKey(event: TimelineEvent): string | undefined {
  if (!event.codexThreadId || !event.codexTurnId || !event.codexItemId) {
    return undefined
  }
  return `${event.codexThreadId}:${event.codexTurnId}:${event.codexItemId}`
}

function reconcile(events: TimelineEvent[]): TimelineCard[] {
  const cards = new Map<string, TimelineCard>()
  for (const event of events) {
    const item = itemKey(event)
    const key = item ?? event.eventId
    const previous = cards.get(key)
    if (previous?.completed) continue
    let next: TimelineCard = { key, event, completed: false }
    if (
      event.type === 'agent.message.delta' ||
      event.type === 'reasoning.summary.delta' ||
      event.type === 'plan.delta'
    ) {
      next.text = `${previous?.text ?? ''}${event.payload.text}`
    } else if (event.type === 'command.output.delta') {
      next.output = `${previous?.output ?? ''}${event.payload.text}`
    } else if (
      event.type === 'agent.message.completed' ||
      event.type === 'plan.completed'
    ) {
      next = { ...next, text: event.payload.text, completed: true }
    } else if (event.type === 'command.completed') {
      const output = event.payload.output ?? previous?.output
      next = {
        ...next,
        ...(output === undefined ? {} : { output }),
        completed: true,
      }
    } else if (
      event.type === 'file.change.completed' ||
      event.type === 'tool.completed'
    ) {
      next.completed = true
    }
    cards.set(key, next)
  }
  return [...cards.values()].sort(
    (left, right) => left.event.sequence - right.event.sequence,
  )
}

function titleOf(event: TimelineEvent): string {
  const titles: Partial<Record<TimelineEvent['type'], string>> = {
    'turn.started': 'Turn başladı',
    'turn.completed': 'Turn tamamlandı',
    'agent.message.delta': 'Codex yanıtı',
    'agent.message.completed': 'Codex yanıtı',
    'reasoning.summary.delta': 'Reasoning özeti',
    'plan.delta': 'Plan',
    'plan.completed': 'Plan',
    'command.proposed': 'Komut',
    'command.output.delta': 'Komut çıktısı',
    'command.completed': 'Komut tamamlandı',
    'file.change.proposed': 'Dosya değişikliği',
    'file.change.completed': 'Dosya değişikliği',
    'diff.updated': 'Diff',
    'tool.started': 'Tool çalışıyor',
    'tool.completed': 'Tool tamamlandı',
    'token.usage.updated': 'Token kullanımı',
    'error.reported': 'Hata',
    'codex.unknown': 'Bilinmeyen Codex olayı',
    'approval.requested': 'Onay bekleniyor',
    'approval.resolved': 'Onay çözüldü',
    'context.compacted': 'Context compact edildi',
  }
  return titles[event.type] ?? event.type
}

function detailOf(card: TimelineCard): string {
  const { event } = card
  if (card.text !== undefined) return card.text
  if (card.output !== undefined) return card.output
  switch (event.type) {
    case 'turn.started':
    case 'turn.completed':
      return event.payload.status
    case 'command.proposed':
      return `$ ${event.payload.command}`
    case 'command.completed':
      return card.output ?? `$ ${event.payload.command}`
    case 'file.change.proposed':
    case 'file.change.completed':
      return event.payload.changes
        .map((change) => `${change.kind.type}: ${change.path}\n${change.diff}`)
        .join('\n')
    case 'diff.updated':
      return 'diff' in event.payload
        ? event.payload.diff
        : event.payload.changes.map((change) => change.diff).join('\n')
    case 'tool.started':
      return `${event.payload.provider ?? 'local'} / ${event.payload.tool}`
    case 'tool.completed':
      return JSON.stringify(event.payload.result, null, 2)
    case 'approval.requested':
      return (
        event.payload.reason ??
        'Kullanıcı kararı bekleniyor; otomatik yanıt verilmedi.'
      )
    case 'approval.resolved':
      return `${event.payload.approvalKind} onayı çözüldü`
    case 'token.usage.updated':
      return `${event.payload.total.totalTokens} toplam token`
    case 'error.reported':
      return event.payload.message
    case 'codex.unknown':
      return event.payload.method
    case 'context.compacted':
      return 'Conversation context compact edildi.'
    default:
      return event.type
  }
}

function TimelineEntry({ card }: { card: TimelineCard }) {
  const approvalEvent = card.event.type === 'approval.requested'
  return (
    <article
      className={`timeline-card event-${card.event.type.replaceAll('.', '-')} ${
        approvalEvent ? 'is-approval' : ''
      }`}
    >
      <div className="card-heading">
        <strong>{titleOf(card.event)}</strong>
        <span>#{card.event.sequence}</span>
      </div>
      <pre>{detailOf(card)}</pre>
    </article>
  )
}

function ApprovalCard({
  approval,
  onDecision,
  pending,
  error,
}: {
  approval: Approval
  onDecision: (decision: ApprovalDecision) => void
  pending: boolean
  error?: string
}) {
  const context = approval.context
  const commandActions = Array.isArray(context.commandActions)
    ? context.commandActions
    : []
  const networkContext = context.networkApprovalContext
  return (
    <aside
      className={`approval-card approval-${approval.status}`}
      aria-live="assertive"
    >
      <div className="card-heading">
        <strong>
          {approval.kind === 'command_execution'
            ? 'Komut onayı'
            : 'Dosya değişikliği onayı'}
        </strong>
        <span>{approval.status}</span>
      </div>
      {context.command ? <pre>$ {String(context.command)}</pre> : null}
      {context.cwd ? (
        <p>
          <b>cwd</b> {String(context.cwd)}
        </p>
      ) : null}
      {context.grantRoot ? (
        <p>
          <b>grant root</b> {String(context.grantRoot)}
        </p>
      ) : null}
      {context.reason ? <p>{String(context.reason)}</p> : null}
      {commandActions.length ? (
        <div className="approval-context">
          <b>Command actions</b>
          <pre>{JSON.stringify(commandActions, null, 2)}</pre>
        </div>
      ) : null}
      {networkContext ? (
        <div className="approval-context">
          <b>Network context</b>
          <pre>{JSON.stringify(networkContext, null, 2)}</pre>
        </div>
      ) : null}
      {approval.kind === 'file_change' ? (
        <div className="approval-context">
          {context.filePath ? (
            <p>
              <b>file</b> {String(context.filePath)}
            </p>
          ) : null}
          <pre>
            {context.diffAvailable && context.diff
              ? String(context.diff)
              : 'Diff mevcut değil'}
          </pre>
        </div>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      {approval.status === 'resolving' ? (
        <p className="approval-progress">Karar gönderiliyor…</p>
      ) : null}
      {approval.status === 'pending' ? (
        <div className="approval-actions">
          <button disabled={pending} onClick={() => onDecision('accept')}>
            Accept once
          </button>
          <button
            disabled={pending}
            onClick={() => onDecision('accept_for_session')}
          >
            Accept for session
          </button>
          <button disabled={pending} onClick={() => onDecision('decline')}>
            Decline
          </button>
          <button disabled={pending} onClick={() => onDecision('cancel')}>
            Cancel
          </button>
        </div>
      ) : null}
    </aside>
  )
}

function WorkspacePage() {
  const meta = useQuery({
    queryKey: ['platform-meta'],
    queryFn: readPlatformMeta,
  })
  const [session, setSession] = useState<SessionResponse>()
  const [events, setEvents] = useState<Map<string, TimelineEvent>>(new Map())
  const [sessionPending, setSessionPending] = useState(false)
  const [turnPending, setTurnPending] = useState(false)
  const [error, setError] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [realtimeState, setRealtimeState] = useState('kapalı')
  const [approvals, setApprovals] = useState<Map<string, Approval>>(new Map())
  const [approvalPending, setApprovalPending] = useState<string>()
  const [approvalErrors, setApprovalErrors] = useState<Map<string, string>>(
    new Map(),
  )
  const lastSequence = useRef(0)

  useEffect(() => {
    if (!session) return
    let active = true
    let socket: WebSocket | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    const apply = (incoming: TimelineEvent[]) => {
      lastSequence.current = Math.max(
        lastSequence.current,
        ...incoming.map((event) => event.sequence),
      )
      setEvents((current) => {
        const next = new Map(current)
        const sequences = new Set(
          [...current.values()].map((event) => event.sequence),
        )
        for (const event of incoming) {
          if (next.has(event.eventId) || sequences.has(event.sequence)) continue
          next.set(event.eventId, event)
          sequences.add(event.sequence)
        }
        return next
      })
    }
    void Promise.all(
      ['pending', 'resolving', 'resolved', 'expired', 'superseded'].map(
        async (status) => {
          const response = await fetch(
            `${apiBaseUrl}/v1/approvals?status=${status}`,
            { headers: scopeHeaders },
          )
          if (!response.ok) throw await apiError(response)
          return approvalListResponseSchema.parse(await response.json())
            .approvals
        },
      ),
    )
      .then((groups) => {
        if (active)
          setApprovals(
            new Map(
              groups
                .flat()
                .filter((a) => a.sessionId === session.sessionId)
                .map((a) => [a.approvalId, a]),
            ),
          )
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause))
      })
    const connect = () => {
      if (!active) return
      const url = new URL('/v1/realtime', apiBaseUrl)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url)
      setRealtimeState('bağlanıyor')
      socket.addEventListener('open', () => {
        setRealtimeState('canlı')
        socket?.send(
          JSON.stringify({
            type: 'subscribe',
            tenantId,
            workspaceId,
            sessionId: session.sessionId,
            afterSequence: lastSequence.current,
          }),
        )
      })
      socket.addEventListener('message', (message) => {
        let value: unknown
        try {
          value = JSON.parse(String(message.data))
        } catch {
          setError('Realtime geçersiz JSON gönderdi')
          return
        }
        const parsed = serverMessageSchema.safeParse(value)
        if (!parsed.success) return
        if (parsed.data.type === 'replay') apply(parsed.data.events)
        if (parsed.data.type === 'event') apply([parsed.data.event])
        if (parsed.data.type === 'event' || parsed.data.type === 'replay') {
          socket?.send(
            JSON.stringify({
              type: 'ack',
              tenantId,
              workspaceId,
              sessionId: session.sessionId,
              sequence: lastSequence.current,
            }),
          )
        }
        if (parsed.data.type === 'error') setError(parsed.data.message)
        if (parsed.data.type === 'approval') {
          const approval = parsed.data.approval
          setApprovals((current) =>
            new Map(current).set(approval.approvalId, approval),
          )
        }
      })
      socket.addEventListener('close', () => {
        setRealtimeState('yeniden bağlanıyor')
        if (active) reconnectTimer = setTimeout(connect, 750)
      })
    }
    connect()
    return () => {
      active = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [session])

  async function decideApproval(
    approval: Approval,
    decision: ApprovalDecision,
  ) {
    setApprovalPending(approval.approvalId)
    setApprovalErrors((current) => {
      const next = new Map(current)
      next.delete(approval.approvalId)
      return next
    })
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/approvals/${approval.approvalId}/decision`,
        {
          method: 'POST',
          headers: { ...scopeHeaders, 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({
            decision,
            expectedVersion: approval.version,
            clientContext: { deviceId: 'web-poc', reason: null },
          }),
        },
      )
      if (!response.ok) throw await apiError(response)
      const updated = approvalSchema.parse(await response.json())
      setApprovals((current) =>
        new Map(current).set(updated.approvalId, updated),
      )
    } catch (cause) {
      setApprovalErrors((current) =>
        new Map(current).set(
          approval.approvalId,
          cause instanceof Error ? cause.message : String(cause),
        ),
      )
    } finally {
      setApprovalPending(undefined)
    }
  }

  const cards = useMemo(
    () =>
      reconcile([...events.values()].sort((a, b) => a.sequence - b.sequence)),
    [events],
  )
  const turnActive = useMemo(() => {
    let active = false
    for (const event of [...events.values()].sort(
      (left, right) => left.sequence - right.sequence,
    )) {
      if (event.type === 'turn.started') active = true
      if (event.type === 'turn.completed') active = false
    }
    return active
  }, [events])

  async function createSession() {
    setSessionPending(true)
    setError(undefined)
    try {
      const response = await fetch(`${apiBaseUrl}/v1/sessions`, {
        method: 'POST',
        headers: scopeHeaders,
        body: '{}',
      })
      if (!response.ok) throw await apiError(response)
      const created = sessionResponseSchema.parse(await response.json())
      lastSequence.current = 0
      setEvents(new Map())
      setSession(created)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSessionPending(false)
    }
  }

  async function submitTurn(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = prompt.trim()
    if (!session || !trimmed || turnPending || turnActive) return
    setTurnPending(true)
    setError(undefined)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/sessions/${session.sessionId}/turns`,
        {
          method: 'POST',
          headers: { ...scopeHeaders, 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ prompt: trimmed }),
        },
      )
      if (!response.ok) throw await apiError(response)
      turnAcceptedResponseSchema.parse(await response.json())
      setPrompt('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTurnPending(false)
    }
  }

  return (
    <main className="workspace-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">FAZ 0 · CANLI CODEX AKIŞI</p>
          <h1>Persistent Codex Workspace</h1>
        </div>
        <div className={`status-pill status-${meta.status}`}>
          <span className="status-dot" aria-hidden="true" />
          {meta.isSuccess ? 'Control plane bağlı' : 'Control plane bekleniyor'}
        </div>
      </header>

      <section className="workspace-grid">
        <aside className="project-panel">
          <p className="section-label">Workspace</p>
          <h2>local-poc</h2>
          <dl className="metadata-list">
            <div>
              <dt>Codex</dt>
              <dd>{meta.data?.codexVersion ?? '0.144.2'}</dd>
            </div>
            <div>
              <dt>Transport</dt>
              <dd>{meta.data?.transport ?? 'stdio-jsonl'}</dd>
            </div>
            <div>
              <dt>Realtime</dt>
              <dd>{realtimeState}</dd>
            </div>
          </dl>
          <button
            className="session-button"
            type="button"
            disabled={sessionPending}
            onClick={() => void createSession()}
          >
            {sessionPending
              ? 'Session başlatılıyor…'
              : session
                ? 'Yeni session'
                : 'Session oluştur'}
          </button>
          {session ? (
            <div className="session-meta">
              <span>{session.sessionId}</span>
              <span>{session.codexThreadId}</span>
            </div>
          ) : null}
        </aside>

        <section className="timeline-panel" aria-labelledby="timeline-title">
          <div className="timeline-heading">
            <div>
              <p className="section-label">Canlı görev</p>
              <h2 id="timeline-title">Codex timeline</h2>
            </div>
            <span className="sequence-label">
              sequence {String(lastSequence.current).padStart(4, '0')}
            </span>
          </div>

          <div className="timeline-stream" aria-live="polite">
            {[...approvals.values()]
              .filter((approval) => approval.sessionId === session?.sessionId)
              .map((approval) => (
                <ApprovalCard
                  key={approval.approvalId}
                  approval={approval}
                  pending={approvalPending === approval.approvalId}
                  {...(approvalErrors.get(approval.approvalId)
                    ? { error: approvalErrors.get(approval.approvalId)! }
                    : {})}
                  onDecision={(decision) =>
                    void decideApproval(approval, decision)
                  }
                />
              ))}
            {cards.length ? (
              cards.map((card) => <TimelineEntry key={card.key} card={card} />)
            ) : (
              <div className="timeline-empty">
                <div className="terminal-mark" aria-hidden="true">
                  &gt;_
                </div>
                <h3>
                  {session ? 'İlk turn için hazır' : 'Önce session oluştur'}
                </h3>
                <p>
                  Normalize event’ler durable store commit’inden sonra burada
                  canlı görünür.
                </p>
              </div>
            )}
          </div>

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <form
            className="composer"
            onSubmit={(event) => void submitTurn(event)}
          >
            <label htmlFor="prompt">Codex’e görev ver</label>
            <div className="composer-row">
              <textarea
                id="prompt"
                name="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Kısa bir cevap ver…"
                rows={2}
                disabled={!session || turnPending || turnActive}
              />
              <button
                type="submit"
                disabled={
                  !session || !prompt.trim() || turnPending || turnActive
                }
              >
                {turnPending ? 'Gönderiliyor…' : 'Gönder'}
              </button>
            </div>
          </form>
        </section>
      </section>
    </main>
  )
}
