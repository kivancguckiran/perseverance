import { useQuery } from '@tanstack/react-query'
import {
  serverMessageSchema,
  approvalListResponseSchema,
  approvalSchema,
  artifactDownloadTokenSchema,
  sessionResponseSchema,
  turnAcceptedResponseSchema,
  turnActionResponseSchema,
  type SessionResponse,
  type Approval,
  type ApprovalDecision,
} from '@persistent-codex/control-plane-contracts'
import type { TimelineEvent } from '@persistent-codex/domain-events'
import { useNavigate } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
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

export async function readSessionDetail(
  sessionId: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<SessionResponse | undefined> {
  if (!sessionId) return undefined
  const response = await fetcher(
    `${apiBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
    { headers: scopeHeaders },
  )
  if (!response.ok) throw await apiError(response)
  return sessionResponseSchema.parse(await response.json())
}

interface TimelineCard {
  key: string
  event: TimelineEvent
  text?: string
  output?: string
  completed: boolean
}
const COMMAND_TAIL_BYTES = 64 * 1024
const MAX_TIMELINE_EVENTS = 2_000
export function boundedTail(
  current: string,
  chunk: string,
  limit = COMMAND_TAIL_BYTES,
) {
  const bytes = new TextEncoder().encode(current + chunk)
  if (bytes.length <= limit) return current + chunk
  let start = bytes.length - limit
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
  return new TextDecoder().decode(bytes.slice(start))
}
export function coalesceTimelineEvents(
  current: Map<string, TimelineEvent>,
  incoming: TimelineEvent[],
) {
  const next = new Map(current)
  const sequences = new Set([...current.values()].map((e) => e.sequence))
  for (const event of incoming) {
    if (next.has(event.eventId) || sequences.has(event.sequence)) continue
    const item = itemKey(event)
    if (
      item &&
      (event.type === 'command.output.delta' ||
        event.type === 'command.completed')
    ) {
      let previousKey: string | undefined
      let previous: TimelineEvent | undefined
      for (const [key, candidate] of next) {
        if (
          itemKey(candidate) === item &&
          (candidate.type === 'command.output.delta' ||
            candidate.type === 'command.completed')
        ) {
          previousKey = key
          previous = candidate
          break
        }
      }
      if (previous?.type === 'command.completed') continue
      if (previousKey) next.delete(previousKey)
      if (
        event.type === 'command.output.delta' &&
        previous?.type === 'command.output.delta'
      ) {
        const text = boundedTail(previous.payload.text, event.payload.text)
        next.set(event.eventId, {
          ...event,
          payload: {
            ...event.payload,
            text,
            byteLength: new TextEncoder().encode(text).length,
            truncated: true,
          },
        })
      } else next.set(event.eventId, event)
    } else next.set(event.eventId, event)
    sequences.add(event.sequence)
  }
  while (next.size > MAX_TIMELINE_EVENTS) {
    const oldest = next.keys().next().value as string | undefined
    if (!oldest) break
    next.delete(oldest)
  }
  return next
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
      next.output = boundedTail(previous?.output ?? '', event.payload.text)
    } else if (
      event.type === 'agent.message.completed' ||
      event.type === 'plan.completed'
    ) {
      next = { ...next, text: event.payload.text, completed: true }
    } else if (event.type === 'command.completed') {
      const output = event.payload.output.previewTail || previous?.output
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
  const artifactId =
    card.event.type === 'command.completed'
      ? card.event.payload.output.artifact?.artifactId
      : undefined
  async function downloadArtifact(artifactId: string) {
    const response = await fetch(
      `${apiBaseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}/download-token`,
      { method: 'POST', headers: scopeHeaders },
    )
    if (!response.ok) throw await apiError(response)
    const token = artifactDownloadTokenSchema.parse(await response.json())
    const anchor = document.createElement('a')
    anchor.href = new URL(token.downloadUrl, apiBaseUrl).toString()
    anchor.click()
  }
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
      {card.event.type === 'command.completed' && artifactId ? (
        <div className="artifact-actions">
          <span>
            {card.event.payload.output.truncated ? 'Kısaltıldı · ' : ''}
            {card.event.payload.output.totalBytes.toLocaleString()} byte
          </span>
          <button
            type="button"
            onClick={() => void downloadArtifact(artifactId)}
          >
            Tam redakte çıktıyı aç/indir
          </button>
        </div>
      ) : null}
    </article>
  )
}

function ApprovalCard({
  approval,
  onDecision,
  pending,
  error,
  readOnly,
}: {
  approval: Approval
  onDecision: (decision: ApprovalDecision) => void
  pending: boolean
  error?: string
  readOnly: boolean
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
      {approval.status === 'pending' && !readOnly ? (
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

export function WorkspacePage({ sessionId }: { sessionId?: string }) {
  const navigate = useNavigate()
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
  const [readOnly, setReadOnly] = useState(false)
  const lastSequence = useRef(0)
  const timelineRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sessionId) return
    let active = true
    readSessionDetail(sessionId)
      .then((loaded) => {
        if (active && loaded) setSession(loaded)
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
  }, [sessionId])

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
        return coalesceTimelineEvents(current, incoming)
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
        if (parsed.data.type === 'resync') {
          lastSequence.current = parsed.data.afterSequence
          setRealtimeState('yeniden eşitleniyor')
          socket?.close()
        }
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
  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => timelineRef.current,
    estimateSize: () => 150,
    overscan: 8,
  })
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
      setReadOnly(false)
      await navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: created.sessionId },
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSessionPending(false)
    }
  }

  async function resumeSession() {
    if (!session) return
    setSessionPending(true)
    setError(undefined)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/sessions/${session.sessionId}/resume`,
        {
          method: 'POST',
          headers: { ...scopeHeaders, 'idempotency-key': crypto.randomUUID() },
          body: '{}',
        },
      )
      if (!response.ok) throw await apiError(response)
      setSession(sessionResponseSchema.parse(await response.json()))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSessionPending(false)
    }
  }

  const activeTurnId = useMemo(() => {
    let current: string | undefined
    for (const event of [...events.values()].sort(
      (a, b) => a.sequence - b.sequence,
    )) {
      if (event.type === 'turn.started')
        current = event.codexTurnId ?? undefined
      if (
        event.type === 'turn.completed' &&
        (!current || current === event.codexTurnId)
      )
        current = undefined
    }
    return current
  }, [events])

  async function steerOrInterrupt(action: 'steer' | 'interrupt') {
    if (!session || !activeTurnId) return
    const trimmed = prompt.trim()
    if (action === 'steer' && !trimmed) return
    setTurnPending(true)
    setError(undefined)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/sessions/${session.sessionId}/turns/${activeTurnId}/${action}`,
        {
          method: 'POST',
          headers: {
            ...scopeHeaders,
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify(
            action === 'steer'
              ? { expectedTurnId: activeTurnId, prompt: trimmed }
              : {},
          ),
        },
      )
      if (!response.ok) throw await apiError(response)
      turnActionResponseSchema.parse(await response.json())
      if (action === 'steer') setPrompt('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTurnPending(false)
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
    <main className="workspace-shell" data-session-id={sessionId}>
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
              <span>{session.status}</span>
              {!session.runtimeConnected ||
              session.status === 'recovery_required' ? (
                <button
                  type="button"
                  disabled={sessionPending}
                  onClick={() => void resumeSession()}
                >
                  {sessionPending ? 'Resume ediliyor…' : 'Session resume'}
                </button>
              ) : null}
              {session.recoveryErrorCode ? (
                <p className="form-error">{session.recoveryErrorCode}</p>
              ) : null}
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
            {cards.length > 20 ? (
              <button
                className="timeline-end-button"
                type="button"
                onClick={() => {
                  virtualizer.scrollToOffset(virtualizer.getTotalSize(), {
                    align: 'end',
                  })
                  requestAnimationFrame(() =>
                    timelineRef.current?.scrollTo({
                      top: timelineRef.current.scrollHeight,
                      behavior: 'auto',
                    }),
                  )
                }}
              >
                Sona git
              </button>
            ) : null}
          </div>

          <div
            className="timeline-stream"
            aria-live="polite"
            aria-label="Timeline olayları"
            tabIndex={0}
            ref={timelineRef}
          >
            {[...approvals.values()]
              .filter((approval) => approval.sessionId === session?.sessionId)
              .map((approval) => (
                <ApprovalCard
                  key={approval.approvalId}
                  approval={approval}
                  pending={approvalPending === approval.approvalId}
                  readOnly={readOnly}
                  {...(approvalErrors.get(approval.approvalId)
                    ? { error: approvalErrors.get(approval.approvalId)! }
                    : {})}
                  onDecision={(decision) =>
                    void decideApproval(approval, decision)
                  }
                />
              ))}
            {cards.length ? (
              <div
                className="virtual-timeline"
                style={{
                  height: virtualizer.getTotalSize(),
                  position: 'relative',
                }}
              >
                {virtualizer.getVirtualItems().map((row) => (
                  <div
                    key={cards[row.index]!.key}
                    ref={virtualizer.measureElement}
                    data-index={row.index}
                    style={{
                      position: 'absolute',
                      width: '100%',
                      transform: `translateY(${row.start}px)`,
                      paddingBottom: 12,
                    }}
                  >
                    <TimelineEntry card={cards[row.index]!} />
                  </div>
                ))}
              </div>
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
          {session?.recoveryOptions.length ? (
            <section className="recovery-panel" aria-live="polite">
              <h3>
                {session.recoveryErrorCode === 'THREAD_NOT_RESUMABLE'
                  ? 'Thread sürdürülemiyor'
                  : 'Session geçici olarak kurtarılamadı'}
              </h3>
              <p>
                {session.recoveryErrorCode === 'THREAD_NOT_RESUMABLE'
                  ? 'Mevcut thread binding’i korunuyor; otomatik yeni thread açılmadı.'
                  : 'Runtime, timeout veya authentication sorunu giderildikten sonra yeniden deneyebilirsiniz.'}
              </p>
              <div className="approval-actions">
                {session.recoveryOptions.includes('retry_resume') ? (
                  <button
                    type="button"
                    disabled={sessionPending || readOnly}
                    onClick={() => void resumeSession()}
                  >
                    Retry resume
                  </button>
                ) : null}
                {session.recoveryOptions.includes('start_new_session') ? (
                  <button
                    type="button"
                    disabled={sessionPending || readOnly}
                    onClick={() => void createSession()}
                  >
                    Yeni session başlat
                  </button>
                ) : null}
                {session.recoveryOptions.includes('view_read_only') ? (
                  <button type="button" onClick={() => setReadOnly(true)}>
                    Timeline’ı read-only görüntüle
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}
          {readOnly ? (
            <p className="read-only-banner">Read-only timeline modu</p>
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
                disabled={!session || turnPending || readOnly}
              />
              <button
                type="submit"
                disabled={
                  !session ||
                  !prompt.trim() ||
                  turnPending ||
                  turnActive ||
                  readOnly
                }
              >
                {turnPending ? 'Gönderiliyor…' : 'Gönder'}
              </button>
              {turnActive && !readOnly ? (
                <>
                  <button
                    type="button"
                    disabled={!prompt.trim() || turnPending}
                    onClick={() => void steerOrInterrupt('steer')}
                  >
                    Aktif turn’e yönlendir
                  </button>
                  <button
                    type="button"
                    disabled={turnPending}
                    onClick={() => void steerOrInterrupt('interrupt')}
                  >
                    Durdur
                  </button>
                </>
              ) : null}
            </div>
          </form>
        </section>
      </section>
    </main>
  )
}
