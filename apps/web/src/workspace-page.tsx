import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  attachmentContextStart,
  serverMessageSchema,
  approvalListResponseSchema,
  approvalSchema,
  artifactDownloadTokenSchema,
  conversationAttachmentSchema,
  conversationFolderListResponseSchema,
  conversationFolderSchema,
  sessionResponseSchema,
  turnAcceptedResponseSchema,
  turnActionResponseSchema,
  readinessResponseSchema,
  sessionListResponseSchema,
  gitSnapshotListResponseSchema,
  gitSnapshotSchema,
  auditListResponseSchema,
  type SessionResponse,
  type Approval,
  type ApprovalDecision,
  type ReadinessResponse,
  type GitSnapshot,
  type AuditRecord,
  type ConversationFolder,
  type ConversationAttachment,
  type SessionSummary,
} from '@persistent-codex/control-plane-contracts'
import type { TimelineEvent } from '@persistent-codex/domain-events'
import { useNavigate } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'

interface PlatformMeta {
  service: string
  phase: string
  codexVersion: string
  transport: string
}

const MessageMarkdown = lazy(() => import('./message-markdown'))

const apiBaseUrl =
  (import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) ??
  'http://127.0.0.1:3100'
const tenantId = 'ten_local'
const workspaceId = 'wsp_local'
const historyDesktopMediaQuery = '(min-width: 1100px)'
const scopeHeaders = {
  'content-type': 'application/json',
  'x-tenant-id': tenantId,
  'x-workspace-id': workspaceId,
}

const supportedAttachmentTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/pdf',
])

export function attachmentMediaType(file: Pick<File, 'name' | 'type'>) {
  if (supportedAttachmentTypes.has(file.type)) return file.type
  const extension = file.name.toLowerCase().split('.').pop()
  return extension === 'md'
    ? 'text/markdown'
    : extension === 'json'
      ? 'application/json'
      : extension === 'txt'
        ? 'text/plain'
        : extension === 'pdf'
          ? 'application/pdf'
          : undefined
}

async function readPlatformMeta(): Promise<PlatformMeta> {
  const response = await fetch(`${apiBaseUrl}/v1/meta`)
  if (!response.ok) throw new Error('Control plane yanıt vermedi')
  return response.json() as Promise<PlatformMeta>
}

async function readReadiness(retry = false): Promise<ReadinessResponse> {
  const response = await fetch(`${apiBaseUrl}/readyz`, {
    headers: {
      ...scopeHeaders,
      ...(retry ? { 'x-readiness-retry': '1' } : {}),
    },
  })
  const body = readinessResponseSchema.parse(await response.json())
  return body
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

export function sessionScopedCursor(
  currentSessionId: string | undefined,
  nextSessionId: string | undefined,
  cursor: number,
): number {
  return currentSessionId === nextSessionId ? cursor : 0
}

async function readRecentSessions(cursor: string | null) {
  const query = new URLSearchParams({ limit: '12' })
  if (cursor) query.set('cursor', cursor)
  const response = await fetch(`${apiBaseUrl}/v1/sessions?${query}`, {
    headers: scopeHeaders,
  })
  if (!response.ok) throw await apiError(response)
  return sessionListResponseSchema.parse(await response.json())
}

async function readConversationFolders() {
  const response = await fetch(`${apiBaseUrl}/v1/conversation-folders`, {
    headers: scopeHeaders,
  })
  if (!response.ok) throw await apiError(response)
  return conversationFolderListResponseSchema.parse(await response.json())
}

async function readGitSnapshots(sessionId: string) {
  const response = await fetch(
    `${apiBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/git-snapshots`,
    { headers: scopeHeaders },
  )
  if (!response.ok) throw await apiError(response)
  return gitSnapshotListResponseSchema.parse(await response.json())
}

async function readAudit(sessionId: string, cursor: string | null) {
  const query = new URLSearchParams({ limit: '10' })
  if (cursor) query.set('cursor', cursor)
  const response = await fetch(
    `${apiBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/audit?${query}`,
    { headers: scopeHeaders },
  )
  if (!response.ok) throw await apiError(response)
  return auditListResponseSchema.parse(await response.json())
}

function AuditPanel({
  records,
  pending,
  fetchingMore,
  hasMore,
  stale,
  error,
  onMore,
}: {
  records: AuditRecord[]
  pending: boolean
  fetchingMore: boolean
  hasMore: boolean
  stale: boolean
  error?: string
  onMore(): void
}) {
  return (
    <section
      className="audit-panel"
      aria-labelledby="audit-title"
      aria-busy={pending}
    >
      <div className="audit-heading">
        <div>
          <p className="section-label">Durable audit</p>
          <h2 id="audit-title">Session eylem zinciri</h2>
        </div>
        {stale ? <span className="audit-stale">stale</span> : null}
      </div>
      {pending ? <p className="audit-state">Audit yükleniyor…</p> : null}
      {error ? (
        <p className="form-error" role="alert">
          Audit alınamadı: {error}
        </p>
      ) : null}
      {!pending && !error && !records.length ? (
        <p className="audit-state">Henüz audit kaydı yok.</p>
      ) : null}
      {records.length ? (
        <ol className="audit-list">
          {records.map((record) => (
            <li key={record.auditId}>
              <span className={`audit-outcome outcome-${record.outcome}`}>
                {record.outcome}
              </span>
              <strong>{record.action}</strong>
              <span>{record.actor}</span>
              <time dateTime={record.occurredAt}>
                {new Date(record.occurredAt).toLocaleString('tr-TR')}
              </time>
              <code>{record.correlationId ?? 'correlation yok'}</code>
            </li>
          ))}
        </ol>
      ) : null}
      {hasMore ? (
        <button type="button" disabled={fetchingMore} onClick={onMore}>
          {fetchingMore ? 'Yükleniyor…' : 'Daha eski audit kayıtları'}
        </button>
      ) : null}
    </section>
  )
}

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

function GitPanel({
  snapshot,
  pending,
  error,
  onRefresh,
}: {
  snapshot?: GitSnapshot
  pending: boolean
  error?: string
  onRefresh(): void
}) {
  return (
    <section
      className="git-panel"
      aria-labelledby="git-title"
      aria-busy={pending}
    >
      <div className="git-panel-heading">
        <div>
          <p className="section-label">Git doğruluk kaynağı</p>
          <h2 id="git-title">Status · diff · log</h2>
        </div>
        <button type="button" disabled={pending} onClick={onRefresh}>
          {pending ? 'Yenileniyor…' : 'Yenile'}
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {!snapshot && !pending ? (
        <p className="git-empty">Henüz Git snapshot yok.</p>
      ) : null}
      {snapshot ? (
        <>
          <div className="git-summary">
            <span>{snapshot.repositoryKind}</span>
            <span>
              {snapshot.branch ??
                (snapshot.detached ? 'detached HEAD' : 'branch yok')}
            </span>
            <code>{snapshot.headOid?.slice(0, 10) ?? 'HEAD yok'}</code>
            <span>
              {snapshot.clean
                ? 'clean'
                : `${snapshot.changes.length} değişiklik`}
            </span>
            {snapshot.stale ? <strong>stale</strong> : null}
          </div>
          <p
            className={`git-relationship relationship-${snapshot.relationship}`}
          >
            {snapshot.relationship === 'authoritative'
              ? 'Git snapshot authoritative; normalize event değişiklik sayısı yok.'
              : snapshot.relationship === 'matches_events'
                ? `Git snapshot, ${snapshot.eventChangeCount} normalize file-change eventiyle uyumlu.`
                : 'Normalize event özeti ile Git snapshot farklı; Git sonucu authoritative.'}
          </p>
          <div className="git-columns">
            <div>
              <h3>Değişiklikler</h3>
              <ul className="git-change-list">
                {snapshot.changes.map((change) => (
                  <li key={`${change.previousPath ?? ''}:${change.path}`}>
                    <code>{change.areas.join(' + ')}</code>
                    <span>
                      {change.previousPath ? `${change.previousPath} → ` : ''}
                      {change.path}
                    </span>
                    {change.binary ? <b>binary</b> : null}
                    {change.submodule ? <b>submodule</b> : null}
                  </li>
                ))}
                {!snapshot.changes.length ? <li>Workspace temiz.</li> : null}
              </ul>
            </div>
            <div>
              <h3>Son commit’ler</h3>
              <ul className="git-log-list">
                {snapshot.log.slice(0, 6).map((entry) => (
                  <li key={entry.oid}>
                    <code>{entry.shortOid}</code>
                    <span>{entry.subject}</span>
                  </li>
                ))}
                {!snapshot.log.length ? <li>Commit geçmişi yok.</li> : null}
              </ul>
            </div>
          </div>
          <details className="git-diff" open={Boolean(snapshot.diff.preview)}>
            <summary>
              Diff preview · {snapshot.diff.byteLength} byte
              {snapshot.diff.truncated ? ' · bounded' : ''}
            </summary>
            <pre>{snapshot.diff.preview || 'Diff yok.'}</pre>
            {snapshot.diff.artifactId ? (
              <button
                type="button"
                onClick={() => void downloadArtifact(snapshot.diff.artifactId!)}
              >
                Tam redakte diff’i indir
              </button>
            ) : null}
          </details>
        </>
      ) : null}
    </section>
  )
}

export interface TimelineCard {
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

export interface ConversationMessage {
  key: string
  role: 'user' | 'assistant'
  text: string
  sequence: number
  turnId?: string
  attachments?: Array<{ kind: 'image' | 'file'; name: string }>
}

function userMessageContent(event: TimelineEvent):
  | {
      text: string
      attachments: Array<{ kind: 'image' | 'file'; name: string }>
    }
  | undefined {
  if (
    event.type !== 'codex.unknown' ||
    (event.payload.method !== 'item/started' &&
      event.payload.method !== 'item/completed') ||
    !isRecord(event.payload.params)
  )
    return undefined
  const item = event.payload.params.item
  if (!isRecord(item) || item.type !== 'userMessage') return undefined
  if (!Array.isArray(item.content)) return undefined
  const rawText = item.content
    .map((part) =>
      isRecord(part) && typeof part.text === 'string' ? part.text : '',
    )
    .join('')
    .trim()
  const markerIndex = rawText.indexOf(attachmentContextStart)
  const text = (
    markerIndex >= 0 ? rawText.slice(0, markerIndex) : rawText
  ).trim()
  const attachments: Array<{ kind: 'image' | 'file'; name: string }> = []
  for (const part of item.content) {
    if (!isRecord(part) || typeof part.type !== 'string') continue
    if (part.type === 'localImage' || part.type === 'image') {
      const source =
        typeof part.path === 'string'
          ? part.path
          : typeof part.url === 'string'
            ? part.url
            : ''
      attachments.push({
        kind: 'image',
        name: source.split(/[\\/]/).pop() || 'Görsel',
      })
      continue
    }
    if (part.type === 'mention' && typeof part.name === 'string')
      attachments.push({ kind: 'file', name: part.name })
  }
  return text || attachments.length > 0 ? { text, attachments } : undefined
}

function userMessageText(event: TimelineEvent): string | undefined {
  return userMessageContent(event)?.text
}

export function conversationMessages(
  events: TimelineEvent[],
): ConversationMessage[] {
  const messages = new Map<string, ConversationMessage>()
  for (const event of events) {
    const userContent = userMessageContent(event)
    if (userContent) {
      const key = event.codexItemId ?? event.eventId
      messages.set(key, {
        key,
        role: 'user',
        text: userContent.text,
        sequence: event.sequence,
        ...(userContent.attachments.length > 0
          ? { attachments: userContent.attachments }
          : {}),
        ...(event.codexTurnId ? { turnId: event.codexTurnId } : {}),
      })
    }
  }
  for (const card of reconcile(events)) {
    if (
      card.event.type !== 'agent.message.delta' &&
      card.event.type !== 'agent.message.completed'
    )
      continue
    const text = card.text?.trim()
    if (!text) continue
    messages.set(card.key, {
      key: card.key,
      role: 'assistant',
      text,
      sequence: card.event.sequence,
      ...(card.event.codexTurnId ? { turnId: card.event.codexTurnId } : {}),
    })
  }
  return [...messages.values()].sort(
    (left, right) => left.sequence - right.sequence,
  )
}

export interface ConversationWork {
  key: string
  role: 'work'
  cards: TimelineCard[]
  sequence: number
  running: boolean
}

export type ConversationFeedItem = ConversationMessage | ConversationWork

function workKey(cards: TimelineCard[]): string {
  const first = cards[0]!
  return `work:${first.event.codexTurnId ?? first.key}`
}

function isMessageCard(card: TimelineCard): boolean {
  if (
    card.event.type === 'agent.message.delta' ||
    card.event.type === 'agent.message.completed'
  )
    return true
  return Boolean(userMessageText(card.event))
}

function isHousekeepingCard(card: TimelineCard): boolean {
  if (
    card.event.type === 'token.usage.updated' ||
    card.event.type === 'turn.completed'
  )
    return true
  return (
    card.event.type === 'codex.unknown' &&
    (card.event.payload.method === 'thread/status/changed' ||
      card.event.payload.method === 'turn/completed')
  )
}

export function conversationFeed(
  events: TimelineEvent[],
): ConversationFeedItem[] {
  const messages = conversationMessages(events)
  const cards = reconcile(events).filter((card) => !isMessageCard(card))
  const assistantMessages = messages.filter(
    (message) => message.role === 'assistant',
  )
  const work: ConversationWork[] = []
  const claimedCards = new Set<string>()
  const workKeyCounts = new Map<string, number>()
  let turnIsActive = false
  let activeTurnId: string | undefined
  for (const event of events) {
    if (event.type === 'turn.started') {
      turnIsActive = true
      activeTurnId = event.codexTurnId
    }
    if (event.type === 'turn.completed') {
      turnIsActive = false
      activeTurnId = undefined
    }
  }
  const nextWorkKey = (segment: TimelineCard[]) => {
    const base = workKey(segment)
    const count = workKeyCounts.get(base) ?? 0
    workKeyCounts.set(base, count + 1)
    return count === 0 ? base : `${base}:${count + 1}`
  }
  let afterSequence = -1
  for (const assistant of assistantMessages) {
    const segment = cards.filter(
      (card) =>
        !claimedCards.has(card.key) &&
        card.event.sequence > afterSequence &&
        card.event.sequence <= assistant.sequence,
    )
    if (segment.length) {
      for (const card of segment) claimedCards.add(card.key)
      work.push({
        key: nextWorkKey(segment),
        role: 'work',
        cards: segment,
        sequence: assistant.sequence - 0.5,
        running: false,
      })
    }
    afterSequence = assistant.sequence
  }
  const trailing = cards.filter(
    (card) =>
      card.event.sequence > afterSequence && !claimedCards.has(card.key),
  )
  if (trailing.length && trailing.some((card) => !isHousekeepingCard(card))) {
    const last = trailing.at(-1)!
    const lastMessageSequence = messages.at(-1)?.sequence ?? -1
    work.push({
      key: nextWorkKey(trailing),
      role: 'work',
      cards: trailing,
      sequence: Math.max(last.event.sequence, lastMessageSequence) + 0.5,
      running: turnIsActive,
    })
  }
  if (turnIsActive && !work.some((item) => item.running)) {
    const lastSequence = Math.max(
      events.at(-1)?.sequence ?? -1,
      messages.at(-1)?.sequence ?? -1,
    )
    work.push({
      key: `work:${activeTurnId ?? 'active'}:pending`,
      role: 'work',
      cards: [],
      sequence: lastSequence + 0.5,
      running: true,
    })
  }
  return [...messages, ...work].sort(
    (left, right) => left.sequence - right.sequence,
  )
}

export function shouldSubmitComposer(input: {
  key: string
  shiftKey: boolean
  isComposing: boolean
}): boolean {
  return input.key === 'Enter' && !input.shiftKey && !input.isComposing
}

export function isNearScrollEnd(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 120,
): boolean {
  return (
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
  )
}

export function chatFollowStateAfterScroll(input: {
  wasFollowing: boolean
  previousScrollTop: number | null
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}): boolean {
  if (
    input.previousScrollTop !== null &&
    input.scrollTop < input.previousScrollTop - 1
  )
    return false
  if (isNearScrollEnd(input, 24)) return true
  return input.wasFollowing
}

function titleOf(event: TimelineEvent): string {
  if (event.type === 'codex.unknown') {
    return unknownEventTitle(event.payload.method)
  }
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
    'approval.requested': 'Onay bekleniyor',
    'approval.resolved': 'Onay çözüldü',
    'context.compacted': 'Context compact edildi',
  }
  return titles[event.type] ?? event.type
}

const unknownEventTitles: Record<string, string> = {
  'thread/started': 'Codex task’ı başlatıldı',
  'thread/status/changed': 'Task durumu değişti',
  'turn/started': 'Turn başladı',
  'turn/completed': 'Turn tamamlandı',
  'item/started': 'İşlem başladı',
  'item/completed': 'İşlem tamamlandı',
  'mcpServer/startupStatus/updated': 'Araç bağlantıları hazırlanıyor',
  warning: 'Codex uyarısı',
}

function unknownEventTitle(method: string): string {
  return unknownEventTitles[method] ?? 'Codex olayı'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstString(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return undefined
}

function unknownEventSummary(
  event: Extract<TimelineEvent, { type: 'codex.unknown' }>,
) {
  const params = event.payload.params
  const direct = firstString(params, [
    'message',
    'status',
    'state',
    'serverName',
    'name',
  ])
  if (direct) return direct
  if (isRecord(params)) {
    const nested = firstString(params.thread, ['status', 'state'])
    if (nested) return nested
    const itemType = firstString(params.item, ['type', 'kind', 'name'])
    if (itemType) return itemType
  }
  return event.payload.method
}

export interface TimelineEventPresentation {
  title: string
  summary: string
  tone: 'activity' | 'content' | 'success' | 'warning' | 'error'
  expanded: boolean
}

export function describeTimelineEvent(
  card: TimelineCard,
): TimelineEventPresentation {
  const { event } = card
  if (event.type === 'codex.unknown') {
    const method = event.payload.method
    return {
      title: unknownEventTitle(method),
      summary: unknownEventSummary(event),
      tone: method === 'warning' ? 'warning' : 'activity',
      expanded: false,
    }
  }
  const content =
    event.type === 'agent.message.delta' ||
    event.type === 'agent.message.completed' ||
    event.type === 'reasoning.summary.delta' ||
    event.type === 'plan.delta' ||
    event.type === 'plan.completed' ||
    event.type === 'command.output.delta' ||
    event.type === 'command.completed' ||
    event.type === 'file.change.proposed' ||
    event.type === 'file.change.completed' ||
    event.type === 'diff.updated'
  const tone =
    event.type === 'error.reported'
      ? 'error'
      : event.type === 'approval.requested'
        ? 'warning'
        : event.type === 'turn.completed' ||
            event.type === 'tool.completed' ||
            event.type === 'approval.resolved'
          ? 'success'
          : content
            ? 'content'
            : 'activity'
  return {
    title: titleOf(event),
    summary: detailOf(card),
    tone,
    expanded: content,
  }
}

function technicalDetailOf(event: TimelineEvent): string {
  const metadata = {
    type: event.type,
    sourceMethod: event.sourceMethod,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    codexThreadId: event.codexThreadId,
    codexTurnId: event.codexTurnId,
    codexItemId: event.codexItemId,
  }
  if (event.type !== 'codex.unknown') return JSON.stringify(metadata, null, 2)
  return JSON.stringify(
    {
      ...metadata,
      envelopeKind: event.payload.envelopeKind,
      method: event.payload.method,
      params: event.payload.params,
    },
    null,
    2,
  )
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
  const presentation = describeTimelineEvent(card)
  const artifactId =
    card.event.type === 'command.completed'
      ? card.event.payload.output.artifact?.artifactId
      : undefined
  return (
    <article
      className={`timeline-card timeline-tone-${presentation.tone} event-${card.event.type.replaceAll('.', '-')} ${
        approvalEvent ? 'is-approval' : ''
      }`}
    >
      <details className="timeline-event" open={presentation.expanded}>
        <summary className="timeline-event-summary">
          <span className="timeline-event-marker" aria-hidden="true" />
          <span className="timeline-event-label">
            <strong>{presentation.title}</strong>
            {!presentation.expanded ? (
              <span>{presentation.summary}</span>
            ) : null}
          </span>
          <span className="timeline-event-sequence">
            #{card.event.sequence}
          </span>
          <span className="timeline-event-chevron" aria-hidden="true" />
        </summary>
        <div className="timeline-event-body">
          {presentation.expanded ? (
            <>
              <pre>{presentation.summary}</pre>
              <details className="timeline-technical-details">
                <summary>Teknik detaylar</summary>
                <pre>{technicalDetailOf(card.event)}</pre>
              </details>
            </>
          ) : (
            <pre>{technicalDetailOf(card.event)}</pre>
          )}
        </div>
      </details>
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

function compactWorkSummary(card: TimelineCard): string {
  const value = describeTimelineEvent(card).summary.split('\n')[0]?.trim() ?? ''
  return value.length > 90 ? `${value.slice(0, 87)}…` : value
}

function commandActivity(command: string, running: boolean): string {
  const value = command.toLocaleLowerCase('en-US')
  if (
    /\b(vitest|jest|pytest|cargo test|go test|pnpm test|npm test)\b/.test(value)
  )
    return running ? 'Testleri çalıştırıyor' : 'Testleri çalıştırdı'
  if (/\b(typecheck|tsc|build|lint|prettier)\b/.test(value))
    return running ? 'Değişiklikleri doğruluyor' : 'Değişiklikleri doğruladı'
  if (/\b(install|add)\b/.test(value))
    return running ? 'Bağımlılıkları hazırlıyor' : 'Bağımlılıkları hazırladı'
  if (/\b(rg|grep|find|ls|sed|git status|git diff)\b/.test(value))
    return running ? 'Çalışma alanını inceliyor' : 'Çalışma alanını inceledi'
  return running ? 'Bir komut çalıştırıyor' : 'Komutları tamamladı'
}

export function describeConversationWork(work: ConversationWork): string {
  const { cards, running } = work
  if (running && cards.length === 0) return 'Düşünüyor'
  const unknownKinds = cards
    .filter(
      (
        card,
      ): card is TimelineCard & {
        event: Extract<TimelineEvent, { type: 'codex.unknown' }>
      } => card.event.type === 'codex.unknown',
    )
    .map((card) => unknownEventSummary(card.event).toLocaleLowerCase('en-US'))
  const command = [...cards]
    .reverse()
    .find(
      (card) =>
        card.event.type === 'command.proposed' ||
        card.event.type === 'command.completed',
    )
  const hasFileChange = cards.some(
    (card) =>
      card.event.type === 'file.change.proposed' ||
      card.event.type === 'file.change.completed' ||
      card.event.type === 'diff.updated',
  )
  const tool = [...cards]
    .reverse()
    .find(
      (card) =>
        card.event.type === 'tool.started' ||
        card.event.type === 'tool.completed',
    )
  if (running && command) {
    const event = command.event
    return commandActivity(
      event.type === 'command.proposed' || event.type === 'command.completed'
        ? event.payload.command
        : '',
      true,
    )
  }
  if (hasFileChange)
    return running
      ? 'Kod değişikliklerini uyguluyor'
      : 'Kod değişikliklerini uyguladı'
  if (command) {
    const event = command.event
    return commandActivity(
      event.type === 'command.proposed' || event.type === 'command.completed'
        ? event.payload.command
        : '',
      running,
    )
  }
  if (tool) {
    const event = tool.event
    const toolName =
      event.type === 'tool.started' || event.type === 'tool.completed'
        ? event.payload.tool.toLocaleLowerCase('en-US')
        : ''
    if (/search|web|browser/.test(toolName))
      return running ? 'Kaynakları araştırıyor' : 'Kaynakları araştırdı'
    if (/\b(rg|grep|find|read|filesystem)\b/.test(toolName))
      return running ? 'Çalışma alanını inceliyor' : 'Çalışma alanını inceledi'
    return running ? 'Araçları kullanıyor' : 'Araç işlemlerini tamamladı'
  }
  if (unknownKinds.some((kind) => /websearch|search|browser/.test(kind)))
    return running ? 'Kaynakları araştırıyor' : 'Kaynakları araştırdı'
  if (unknownKinds.some((kind) => /reasoning|plan/.test(kind)))
    return running ? 'Yaklaşımı değerlendiriyor' : 'Yaklaşımı değerlendirdi'
  if (
    cards.some(
      (card) =>
        card.event.type === 'codex.unknown' &&
        card.event.payload.method === 'mcpServer/startupStatus/updated',
    )
  )
    return running
      ? 'Çalışma ortamını hazırlıyor'
      : 'Çalışma ortamını hazırladı'
  if (
    cards.some(
      (card) =>
        card.event.type === 'plan.delta' ||
        card.event.type === 'plan.completed' ||
        card.event.type === 'reasoning.summary.delta',
    )
  )
    return running ? 'Yaklaşımı değerlendiriyor' : 'Yaklaşımı değerlendirdi'
  return running ? 'Yanıtı hazırlıyor' : 'Yanıtı hazırladı'
}

function ConversationWorkBlock({ work }: { work: ConversationWork }) {
  const [expanded, setExpanded] = useState(false)
  const visibleCards = work.cards.slice(-8)
  return (
    <details
      className={`chat-work ${work.running ? 'is-running' : ''}`}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="chat-work-icon" aria-hidden="true">
          <span />
        </span>
        <span className="chat-work-label">
          <strong>{describeConversationWork(work)}</strong>
          {work.running ? (
            <span className="chat-work-loading" aria-label="Devam ediyor">
              <i />
              <i />
              <i />
            </span>
          ) : null}
        </span>
        <span className="chat-work-chevron" aria-hidden="true" />
      </summary>
      <ol>
        {visibleCards.map((card) => (
          <li key={card.key}>
            <span aria-hidden="true" />
            <strong>{describeTimelineEvent(card).title}</strong>
            <small>{compactWorkSummary(card)}</small>
          </li>
        ))}
      </ol>
      {work.cards.length > visibleCards.length ? (
        <p>{work.cards.length - visibleCards.length} eski işlem gizlendi.</p>
      ) : null}
    </details>
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

function ConversationHistory({
  folders,
  sessions,
  activeSessionId,
  folderName,
  folderPending,
  folderActionPending,
  onFolderNameChange,
  onCreateFolder,
  onNewConversation,
  onSelectConversation,
  onSelectFolder,
  onArchiveFolder,
  onRestoreFolder,
  onDeleteFolder,
}: {
  folders: ConversationFolder[]
  sessions: SessionSummary[]
  activeSessionId?: string
  folderName: string
  folderPending: boolean
  folderActionPending?: string
  onFolderNameChange(value: string): void
  onCreateFolder(): void
  onNewConversation(folderId: string | null): void
  onSelectConversation(sessionId: string): void
  onSelectFolder(folderId: string | null): void
  onArchiveFolder(folder: ConversationFolder): void
  onRestoreFolder(folder: ConversationFolder): void
  onDeleteFolder(folder: ConversationFolder): void
}) {
  const [creatingFolder, setCreatingFolder] = useState(false)
  const activeFolders = folders.filter((folder) => !folder.archivedAt)
  const archivedFolders = folders.filter((folder) => folder.archivedAt)
  const groups = [
    ...activeFolders.map((folder) => ({
      folderId: folder.folderId as string | null,
      name: folder.name,
    })),
    { folderId: null, name: 'Diğer konuşmalar' },
  ]
  return (
    <section className="conversation-history" aria-label="Conversation history">
      <div className="history-brand">
        <span className="history-logo" aria-hidden="true">
          C
        </span>
        <strong>Conversations</strong>
      </div>
      <div className="history-actions">
        <button
          className="new-conversation-button"
          type="button"
          onClick={() => onNewConversation(null)}
        >
          <span aria-hidden="true">＋</span> Yeni sohbet
        </button>
        <button
          className="new-folder-button"
          type="button"
          aria-expanded={creatingFolder}
          onClick={() => setCreatingFolder((open) => !open)}
        >
          <span aria-hidden="true">▱</span> Yeni folder
        </button>
      </div>
      {creatingFolder ? (
        <form
          className="folder-create-row"
          onSubmit={(event) => {
            event.preventDefault()
            if (!folderName.trim() || folderPending) return
            onCreateFolder()
            setCreatingFolder(false)
          }}
        >
          <input
            autoFocus
            aria-label="Yeni folder adı"
            value={folderName}
            onChange={(event) => onFolderNameChange(event.target.value)}
            placeholder="Folder adı"
            maxLength={80}
          />
          <button
            type="submit"
            disabled={!folderName.trim() || folderPending}
            aria-label="Folder oluştur"
          >
            {folderPending ? '…' : 'Ekle'}
          </button>
        </form>
      ) : null}
      <div className="history-folders">
        {groups.map((group) => {
          const groupedSessions = sessions.filter(
            (item) => item.folderId === group.folderId,
          )
          if (group.folderId === null && groupedSessions.length === 0)
            return null
          return (
            <details
              className="history-folder"
              key={group.folderId ?? 'none'}
              open
            >
              <summary>
                <span aria-hidden="true">▾</span>
                <strong>{group.name}</strong>
                <small>{groupedSessions.length}</small>
                {group.folderId ? (
                  <span className="history-folder-actions">
                    <button
                      type="button"
                      aria-label={`${group.name} içinde yeni sohbet`}
                      title="Yeni sohbet"
                      onClick={(event) => {
                        event.preventDefault()
                        onSelectFolder(group.folderId)
                        onNewConversation(group.folderId)
                      }}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      disabled={folderActionPending === group.folderId}
                      aria-label={`${group.name} folder'ını arşivle`}
                      title="Arşivle"
                      onClick={(event) => {
                        event.preventDefault()
                        const folder = activeFolders.find(
                          (item) => item.folderId === group.folderId,
                        )
                        if (folder) onArchiveFolder(folder)
                      }}
                    >
                      ↓
                    </button>
                  </span>
                ) : null}
              </summary>
              <div className="history-conversations">
                {groupedSessions.map((item) => (
                  <button
                    type="button"
                    key={item.sessionId}
                    className={
                      item.sessionId === activeSessionId ? 'is-active' : ''
                    }
                    onClick={() => onSelectConversation(item.sessionId)}
                  >
                    <span>{item.title}</span>
                    <small>{item.status}</small>
                  </button>
                ))}
                {groupedSessions.length === 0 ? (
                  <p>Henüz konuşma yok.</p>
                ) : null}
              </div>
            </details>
          )
        })}
        {archivedFolders.length ? (
          <details className="archived-folders">
            <summary>Arşivlenenler · {archivedFolders.length}</summary>
            {archivedFolders.map((folder) => {
              const groupedSessions = sessions.filter(
                (item) => item.folderId === folder.folderId,
              )
              return (
                <div className="archived-folder" key={folder.folderId}>
                  <div>
                    <strong>{folder.name}</strong>
                    <small>{groupedSessions.length} sohbet</small>
                  </div>
                  <button
                    type="button"
                    disabled={folderActionPending === folder.folderId}
                    onClick={() => onRestoreFolder(folder)}
                  >
                    Geri al
                  </button>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={folderActionPending === folder.folderId}
                    onClick={() => onDeleteFolder(folder)}
                  >
                    Sil
                  </button>
                </div>
              )
            })}
          </details>
        ) : null}
      </div>
    </section>
  )
}

export function WorkspacePage({ sessionId }: { sessionId?: string }) {
  const navigate = useNavigate()
  const meta = useQuery({
    queryKey: ['platform-meta'],
    queryFn: readPlatformMeta,
  })
  const readiness = useQuery({
    queryKey: ['readiness'],
    queryFn: () => readReadiness(),
    refetchInterval: (query) =>
      query.state.data?.status === 'ready' ? false : 5_000,
  })
  const authReady = readiness.data?.status === 'ready'
  const recentSessions = useInfiniteQuery({
    queryKey: ['recent-sessions'],
    queryFn: ({ pageParam }) => readRecentSessions(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
  const conversationFolders = useQuery({
    queryKey: ['conversation-folders'],
    queryFn: readConversationFolders,
  })
  const gitSnapshots = useQuery({
    queryKey: ['git-snapshots', sessionId],
    queryFn: () => readGitSnapshots(sessionId!),
    enabled: Boolean(sessionId),
  })
  const audit = useInfiniteQuery({
    queryKey: ['session-audit', sessionId],
    queryFn: ({ pageParam }) => readAudit(sessionId!, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(sessionId),
    staleTime: 30_000,
  })
  const [session, setSession] = useState<SessionResponse>()
  const [events, setEvents] = useState<Map<string, TimelineEvent>>(new Map())
  const [sessionPending, setSessionPending] = useState(false)
  const [turnPending, setTurnPending] = useState(false)
  const [gitRefreshPending, setGitRefreshPending] = useState(false)
  const [gitError, setGitError] = useState<string>()
  const [error, setError] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [realtimeState, setRealtimeState] = useState('kapalı')
  const [approvals, setApprovals] = useState<Map<string, Approval>>(new Map())
  const [approvalPending, setApprovalPending] = useState<string>()
  const [approvalErrors, setApprovalErrors] = useState<Map<string, string>>(
    new Map(),
  )
  const [readOnly, setReadOnly] = useState(false)
  const [masterExpanded, setMasterExpanded] = useState(true)
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderPending, setFolderPending] = useState(false)
  const [folderActionPending, setFolderActionPending] = useState<string>()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [attachments, setAttachments] = useState<ConversationAttachment[]>([])
  const [attachmentPending, setAttachmentPending] = useState(false)
  const lastSequence = useRef(0)
  const timelineRef = useRef<HTMLDivElement>(null)
  const chatSurfaceRef = useRef<HTMLElement>(null)
  const chatContentRef = useRef<HTMLDivElement>(null)
  const followChatRef = useRef(true)
  const forceChatScrollRef = useRef(false)
  const previousChatScrollTopRef = useRef<number | null>(null)

  useEffect(() => {
    const desktop = window.matchMedia(historyDesktopMediaQuery)
    const syncHistoryForViewport = (event: Pick<MediaQueryList, 'matches'>) =>
      setHistoryOpen(event.matches)
    syncHistoryForViewport(desktop)
    desktop.addEventListener('change', syncHistoryForViewport)
    return () => desktop.removeEventListener('change', syncHistoryForViewport)
  }, [])

  function closeHistoryOverlay() {
    if (!window.matchMedia(historyDesktopMediaQuery).matches)
      setHistoryOpen(false)
  }

  useEffect(() => {
    if (!sessionId) return
    let active = true
    const scopedCursor = sessionScopedCursor(
      session?.sessionId,
      sessionId,
      lastSequence.current,
    )
    if (session?.sessionId !== sessionId) {
      lastSequence.current = scopedCursor
      followChatRef.current = true
      forceChatScrollRef.current = true
      previousChatScrollTopRef.current = null
      setSession(undefined)
      setEvents(new Map())
      setApprovals(new Map())
      setError(undefined)
      setRealtimeState('kapalı')
      setMasterExpanded(true)
      setAttachments([])
    }
    readSessionDetail(sessionId)
      .then((loaded) => {
        if (active && loaded) {
          setSession(loaded)
          setSelectedFolderId(loaded.folderId)
        }
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
  const chatFeed = useMemo(
    () =>
      conversationFeed(
        [...events.values()].sort((a, b) => a.sequence - b.sequence),
      ),
    [events],
  )
  const virtualizer = useVirtualizer({
    count: masterExpanded ? cards.length : 0,
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

  useEffect(() => {
    if (!followChatRef.current && !forceChatScrollRef.current) return
    const frame = requestAnimationFrame(() => {
      const surface = chatSurfaceRef.current
      if (!surface) return
      surface.scrollTo({
        top: surface.scrollHeight,
        behavior: forceChatScrollRef.current ? 'smooth' : 'auto',
      })
      forceChatScrollRef.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [chatFeed])

  useEffect(() => {
    const content = chatContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!followChatRef.current) return
      const surface = chatSurfaceRef.current
      if (surface) surface.scrollTop = surface.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [chatFeed.length > 0, sessionId])

  async function createSession(folderId = selectedFolderId) {
    setSessionPending(true)
    setError(undefined)
    try {
      const response = await fetch(`${apiBaseUrl}/v1/sessions`, {
        method: 'POST',
        headers: scopeHeaders,
        body: JSON.stringify({ folderId }),
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
      void recentSessions.refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSessionPending(false)
    }
  }

  async function createFolder() {
    const name = folderName.trim()
    if (!name || folderPending) return
    setFolderPending(true)
    setError(undefined)
    try {
      const response = await fetch(`${apiBaseUrl}/v1/conversation-folders`, {
        method: 'POST',
        headers: scopeHeaders,
        body: JSON.stringify({ name }),
      })
      if (!response.ok) throw await apiError(response)
      const created = conversationFolderSchema.parse(await response.json())
      setSelectedFolderId(created.folderId)
      setFolderName('')
      await conversationFolders.refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setFolderPending(false)
    }
  }

  async function moveConversation(folderId: string | null) {
    if (!session) return
    setError(undefined)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/sessions/${encodeURIComponent(session.sessionId)}/conversation`,
        {
          method: 'PATCH',
          headers: scopeHeaders,
          body: JSON.stringify({ folderId }),
        },
      )
      if (!response.ok) throw await apiError(response)
      setSession(sessionResponseSchema.parse(await response.json()))
      setSelectedFolderId(folderId)
      void recentSessions.refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function setFolderArchived(
    folder: ConversationFolder,
    archived: boolean,
  ) {
    setFolderActionPending(folder.folderId)
    setError(undefined)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/conversation-folders/${encodeURIComponent(folder.folderId)}`,
        {
          method: 'PATCH',
          headers: scopeHeaders,
          body: JSON.stringify({ archived }),
        },
      )
      if (!response.ok) throw await apiError(response)
      conversationFolderSchema.parse(await response.json())
      if (archived && selectedFolderId === folder.folderId)
        setSelectedFolderId(null)
      await conversationFolders.refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setFolderActionPending(undefined)
    }
  }

  async function deleteFolder(folder: ConversationFolder) {
    if (
      !window.confirm(
        `“${folder.name}” folder'ı silinsin mi? İçindeki sohbetler korunup “Folder yok” grubuna taşınacak.`,
      )
    )
      return
    setFolderActionPending(folder.folderId)
    setError(undefined)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/conversation-folders/${encodeURIComponent(folder.folderId)}`,
        { method: 'DELETE', headers: scopeHeaders },
      )
      if (!response.ok) throw await apiError(response)
      if (selectedFolderId === folder.folderId) setSelectedFolderId(null)
      if (session?.folderId === folder.folderId)
        setSession((current) =>
          current ? { ...current, folderId: null } : current,
        )
      await Promise.all([
        conversationFolders.refetch(),
        recentSessions.refetch(),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setFolderActionPending(undefined)
    }
  }

  async function refreshGit() {
    if (!session) return
    setGitError(undefined)
    setGitRefreshPending(true)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/sessions/${encodeURIComponent(session.sessionId)}/git-snapshots/refresh`,
        {
          method: 'POST',
          headers: { ...scopeHeaders, 'idempotency-key': crypto.randomUUID() },
          body: '{}',
        },
      )
      if (!response.ok) throw await apiError(response)
      gitSnapshotSchema.parse(await response.json())
      await gitSnapshots.refetch()
    } catch (cause) {
      setGitError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setGitRefreshPending(false)
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
    if (
      !session ||
      (!trimmed && attachments.length === 0) ||
      turnPending ||
      turnActive ||
      !authReady
    )
      return
    followChatRef.current = true
    forceChatScrollRef.current = true
    requestAnimationFrame(() => {
      const surface = chatSurfaceRef.current
      if (surface)
        surface.scrollTo({ top: surface.scrollHeight, behavior: 'smooth' })
    })
    setTurnPending(true)
    setError(undefined)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/sessions/${session.sessionId}/turns`,
        {
          method: 'POST',
          headers: { ...scopeHeaders, 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({
            prompt: trimmed,
            attachmentIds: attachments.map(
              (attachment) => attachment.attachmentId,
            ),
          }),
        },
      )
      if (!response.ok) throw await apiError(response)
      turnAcceptedResponseSchema.parse(await response.json())
      if (session.title === 'Yeni konuşma') {
        const title = (trimmed || attachments[0]?.name || 'Yeni konuşma').slice(
          0,
          120,
        )
        const titleResponse = await fetch(
          `${apiBaseUrl}/v1/sessions/${encodeURIComponent(session.sessionId)}/conversation`,
          {
            method: 'PATCH',
            headers: scopeHeaders,
            body: JSON.stringify({ title }),
          },
        )
        if (titleResponse.ok) {
          setSession(sessionResponseSchema.parse(await titleResponse.json()))
          void recentSessions.refetch()
        }
      }
      setPrompt('')
      setAttachments([])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTurnPending(false)
    }
  }

  async function uploadAttachments(files: FileList | null) {
    if (!session || !files?.length || attachmentPending) return
    const selected = [...files]
    setAttachmentPending(true)
    setError(undefined)
    try {
      const uploaded = await Promise.all(
        selected.map(async (file) => {
          const mediaType = attachmentMediaType(file)
          if (!mediaType)
            throw new Error(`${file.name}: desteklenmeyen dosya türü`)
          if (file.size < 1) throw new Error(`${file.name}: dosya boş olmamalı`)
          const response = await fetch(
            `${apiBaseUrl}/v1/sessions/${encodeURIComponent(session.sessionId)}/attachments`,
            {
              method: 'POST',
              headers: {
                ...scopeHeaders,
                'content-type': 'application/octet-stream',
                'x-attachment-name': encodeURIComponent(file.name),
                'x-attachment-media-type': mediaType,
              },
              body: file,
            },
          )
          if (!response.ok) throw await apiError(response)
          return conversationAttachmentSchema.parse(await response.json())
        }),
      )
      setAttachments((current) => [...current, ...uploaded])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAttachmentPending(false)
    }
  }

  async function removeAttachment(attachment: ConversationAttachment) {
    if (!session) return
    setError(undefined)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/sessions/${encodeURIComponent(session.sessionId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
        { method: 'DELETE', headers: scopeHeaders },
      )
      if (!response.ok) throw await apiError(response)
      setAttachments((current) =>
        current.filter((item) => item.attachmentId !== attachment.attachmentId),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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

      <section
        className={`workspace-grid ${historyOpen ? 'history-is-open' : ''}`}
      >
        <aside className={`project-panel ${historyOpen ? 'is-open' : ''}`}>
          <ConversationHistory
            folders={conversationFolders.data?.folders ?? []}
            sessions={
              recentSessions.data?.pages.flatMap((page) => page.sessions) ?? []
            }
            {...(sessionId ? { activeSessionId: sessionId } : {})}
            folderName={folderName}
            folderPending={folderPending}
            {...(folderActionPending ? { folderActionPending } : {})}
            onFolderNameChange={setFolderName}
            onCreateFolder={() => void createFolder()}
            onSelectFolder={setSelectedFolderId}
            onArchiveFolder={(folder) => void setFolderArchived(folder, true)}
            onRestoreFolder={(folder) => void setFolderArchived(folder, false)}
            onDeleteFolder={(folder) => void deleteFolder(folder)}
            onNewConversation={(folderId) => {
              setSelectedFolderId(folderId)
              closeHistoryOverlay()
              void createSession(folderId)
            }}
            onSelectConversation={(selectedSessionId) => {
              closeHistoryOverlay()
              void navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: selectedSessionId },
              })
            }}
          />
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
            disabled={sessionPending || !authReady}
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
          <nav className="recent-sessions" aria-label="Yakın session’lar">
            <p className="section-label">Yakın session’lar</p>
            {recentSessions.isPending ? <span>Yükleniyor…</span> : null}
            {recentSessions.isError ? (
              <span>Session listesi alınamadı.</span>
            ) : null}
            {recentSessions.data?.pages
              .flatMap((page) => page.sessions)
              .map((item) => (
                <button
                  type="button"
                  key={item.sessionId}
                  className={item.sessionId === sessionId ? 'is-active' : ''}
                  onClick={() =>
                    void navigate({
                      to: '/sessions/$sessionId',
                      params: { sessionId: item.sessionId },
                    })
                  }
                >
                  <span>{item.sessionId}</span>
                  <small>{item.status}</small>
                </button>
              ))}
            {recentSessions.hasNextPage ? (
              <button
                type="button"
                disabled={recentSessions.isFetchingNextPage}
                onClick={() => void recentSessions.fetchNextPage()}
              >
                <span>
                  {recentSessions.isFetchingNextPage
                    ? 'Yükleniyor…'
                    : 'Daha eski session’lar'}
                </span>
              </button>
            ) : null}
            {recentSessions.data &&
            !recentSessions.data.pages.some((page) => page.sessions.length) ? (
              <span>Session yok.</span>
            ) : null}
          </nav>
        </aside>

        <button
          className="history-backdrop"
          type="button"
          aria-label="Conversation history panelini kapat"
          onClick={() => setHistoryOpen(false)}
        />

        <section className="timeline-panel" aria-labelledby="chat-title">
          <header className="chat-header">
            <button
              className="history-toggle"
              type="button"
              aria-label="Conversation history aç/kapat"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              ☰
            </button>
            <div>
              <p className="section-label">Conversation</p>
              <h1 id="chat-title">{session?.title ?? 'Yeni konuşma'}</h1>
            </div>
            <label>
              <span>Folder</span>
              <select
                value={session?.folderId ?? ''}
                disabled={!session}
                onChange={(event) =>
                  void moveConversation(event.target.value || null)
                }
              >
                <option value="">Folder yok</option>
                {(conversationFolders.data?.folders ?? []).map((folder) => (
                  <option
                    key={folder.folderId}
                    value={folder.folderId}
                    disabled={Boolean(folder.archivedAt)}
                  >
                    {folder.archivedAt ? `[Arşiv] ${folder.name}` : folder.name}
                  </option>
                ))}
              </select>
            </label>
          </header>
          <section
            className="chat-surface"
            aria-label="Conversation messages"
            ref={chatSurfaceRef}
            onScroll={(event) => {
              const surface = event.currentTarget
              followChatRef.current = chatFollowStateAfterScroll({
                wasFollowing: followChatRef.current,
                previousScrollTop: previousChatScrollTopRef.current,
                scrollHeight: surface.scrollHeight,
                scrollTop: surface.scrollTop,
                clientHeight: surface.clientHeight,
              })
              previousChatScrollTopRef.current = surface.scrollTop
            }}
          >
            <div className="chat-content" ref={chatContentRef}>
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
              {chatFeed.length > 0 ? (
                <div className="chat-messages">
                  {chatFeed.map((item) =>
                    item.role === 'work' ? (
                      <ConversationWorkBlock work={item} key={item.key} />
                    ) : (
                      <article
                        className={`chat-message is-${item.role}`}
                        key={item.key}
                      >
                        <span className="chat-avatar" aria-hidden="true">
                          {item.role === 'assistant' ? 'C' : 'S'}
                        </span>
                        <div>
                          <strong>
                            {item.role === 'assistant' ? 'Codex' : 'Sen'}
                          </strong>
                          <Suspense fallback={<p>{item.text}</p>}>
                            {item.text ? (
                              <MessageMarkdown>{item.text}</MessageMarkdown>
                            ) : null}
                          </Suspense>
                          {item.attachments?.length ? (
                            <div className="message-attachments">
                              {item.attachments.map((attachment, index) => (
                                <span key={`${attachment.name}:${index}`}>
                                  <span aria-hidden="true">
                                    {attachment.kind === 'image' ? '▧' : '▤'}
                                  </span>
                                  {attachment.name}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </article>
                    ),
                  )}
                </div>
              ) : (
                <div className="chat-welcome">
                  <span aria-hidden="true">C</span>
                  <h2>Nasıl yardımcı olabilirim?</h2>
                  <p>Yeni bir konuşma başlatmak için aşağıya yaz.</p>
                </div>
              )}
            </div>
          </section>
          <section
            className={`auth-readiness auth-${readiness.data?.status ?? 'checking'}`}
            aria-live="polite"
          >
            <div>
              <strong>
                {readiness.isPending
                  ? 'Codex auth kontrol ediliyor…'
                  : readiness.data?.status === 'ready'
                    ? 'Codex auth hazır'
                    : readiness.data?.status === 'setup_required'
                      ? 'Codex login gerekli'
                      : 'Codex readiness bozulmuş'}
              </strong>
              {readiness.data?.status === 'setup_required' ? (
                <p>
                  Terminalde <code>codex login</code> çalıştırın. API key
                  girmeyin; ardından yeniden deneyin.
                </p>
              ) : null}
            </div>
            {readiness.data?.status !== 'ready' ? (
              <button
                type="button"
                disabled={readiness.isFetching}
                onClick={() => void readiness.refetch()}
              >
                {readiness.isFetching
                  ? 'Kontrol ediliyor…'
                  : 'Readiness yeniden dene'}
              </button>
            ) : null}
          </section>
          {session ? (
            <>
              <AuditPanel
                records={
                  audit.data?.pages.flatMap((page) => page.records) ?? []
                }
                pending={audit.isPending}
                fetchingMore={audit.isFetchingNextPage}
                hasMore={Boolean(audit.hasNextPage)}
                stale={audit.isStale}
                {...(audit.error ? { error: audit.error.message } : {})}
                onMore={() => void audit.fetchNextPage()}
              />
              <GitPanel
                {...(gitSnapshots.data?.snapshots[0]
                  ? { snapshot: gitSnapshots.data.snapshots[0] }
                  : {})}
                pending={
                  gitRefreshPending ||
                  gitSnapshots.isPending ||
                  gitSnapshots.isFetching
                }
                {...(gitError || gitSnapshots.error
                  ? { error: gitError ?? gitSnapshots.error!.message }
                  : {})}
                onRefresh={() => void refreshGit()}
              />
            </>
          ) : null}
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
            className={`timeline-stream ${masterExpanded ? '' : 'is-collapsed'}`}
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
            {cards.length > 0 ? (
              <section className="timeline-master" aria-label="Codex çalışması">
                <button
                  className="timeline-master-toggle"
                  type="button"
                  aria-expanded={masterExpanded}
                  aria-controls="timeline-master-events"
                  onClick={() => setMasterExpanded((expanded) => !expanded)}
                >
                  <span className="timeline-master-icon" aria-hidden="true">
                    <span />
                  </span>
                  <span className="timeline-master-label">
                    <strong>Codex çalışması</strong>
                    <span>
                      {cards.length} işlem ·{' '}
                      {turnActive ? 'çalışıyor' : 'hazır'}
                    </span>
                  </span>
                  <span
                    className="timeline-master-chevron"
                    aria-hidden="true"
                  />
                </button>
                {masterExpanded ? (
                  <div
                    id="timeline-master-events"
                    className="virtual-timeline timeline-master-events"
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
                          paddingBottom: 4,
                        }}
                      >
                        <TimelineEntry card={cards[row.index]!} />
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
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
            {attachments.length > 0 ? (
              <div className="composer-attachments" aria-label="Attachment’lar">
                {attachments.map((attachment) => (
                  <span
                    className="attachment-chip"
                    key={attachment.attachmentId}
                  >
                    <span aria-hidden="true">
                      {attachment.kind === 'image' ? '▧' : '▤'}
                    </span>
                    <span>{attachment.name}</span>
                    <small>
                      {(attachment.byteLength / 1024).toFixed(1)} KB
                    </small>
                    <button
                      type="button"
                      aria-label={`${attachment.name} attachment’ını kaldır`}
                      onClick={() => void removeAttachment(attachment)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="composer-row">
              <label
                className="attachment-button"
                aria-label="Dosya ekle"
                title="Dosya ekle"
              >
                <input
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,application/json,application/pdf,.md,.txt,.json,.pdf"
                  disabled={
                    !session ||
                    turnPending ||
                    turnActive ||
                    readOnly ||
                    attachmentPending
                  }
                  onChange={(event) => {
                    void uploadAttachments(event.target.files)
                    event.target.value = ''
                  }}
                />
                <span aria-hidden="true">＋</span>
              </label>
              <textarea
                id="prompt"
                name="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    !shouldSubmitComposer({
                      key: event.key,
                      shiftKey: event.shiftKey,
                      isComposing: event.nativeEvent.isComposing,
                    })
                  )
                    return
                  event.preventDefault()
                  if (turnActive) void steerOrInterrupt('steer')
                  else event.currentTarget.form?.requestSubmit()
                }}
                placeholder="Kısa bir cevap ver…"
                rows={2}
                disabled={!session || turnPending || readOnly || !authReady}
              />
              <button
                type="submit"
                disabled={
                  !session ||
                  (!prompt.trim() && attachments.length === 0) ||
                  turnPending ||
                  attachmentPending ||
                  turnActive ||
                  readOnly ||
                  !authReady
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
