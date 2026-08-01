import { withBase } from './base-path'
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
  providerCatalogListResponseSchema,
  conversationUsageCostSchema,
  billingOverviewSchema,
  billingFinancialOverviewSchema,
  meResponseSchema,
  createSupportGrantRequestSchema,
  supportGrantListResponseSchema,
  supportGrantSchema,
  securityAuditListResponseSchema,
  sourceListResponseSchema,
  acceptFolderInvitationResponseSchema,
  createFolderInvitationResponseSchema,
  folderListResponseSchema,
  folderMemberListResponseSchema,
  folderMembershipSchema,
  sharedFolderSchema,
  apiErrorResponseSchema,
  type SessionResponse,
  type Approval,
  type ApprovalDecision,
  type ReadinessResponse,
  type GitSnapshot,
  type AuditRecord,
  type ConversationFolder,
  type ConversationAttachment,
  type SessionSummary,
  type DurableRun,
  type ProviderCatalogListResponse,
  type ConversationUsageCost,
  type UsageCostSummary,
  type BillingOverview,
  type BillingFinancialOverview,
  type MeResponse,
  type SupportGrant,
  type SupportAccessAction,
  type SecurityAuditRecord,
  type Source,
  type FolderMembership,
  type SharedFolder,
  type ApiErrorResponse,
} from '@perseverance/control-plane-contracts'
import type { TimelineEvent } from '@perseverance/domain-events'
import { useNavigate } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  lazy,
  Suspense,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { PushNotificationControl, useOnlineStatus } from './pwa-runtime'
import './content-key-unlock.css'
import {
  readContentKeySession,
  readStoredAuth,
  signOut,
  unlockStoredContentKey,
} from './self-hosted-auth'
import {
  offlineConversationKey,
  offlineHistoryKey,
  tenantCacheNamespace,
} from './tenant-cache'
import { LanguageSwitcher, localize, useTranslations } from './i18n'

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
const locationScope =
  typeof window === 'undefined'
    ? undefined
    : new URLSearchParams(window.location.search)
// WP37: son kullanıcı akışında scope ve token login yanıtından (storage)
// gelir; query param ve sessionStorage enjeksiyonu operatör/acil ve yerel
// geliştirme yolları olarak kalır.
const storedAuth = readStoredAuth()
const tenantId =
  storedAuth?.tenantId ?? locationScope?.get('organization') ?? 'ten_local'
const workspaceId =
  storedAuth?.workspaceId ?? locationScope?.get('workspace') ?? 'wsp_local'
const runtimeAuth =
  typeof window === 'undefined'
    ? undefined
    : (
        window as typeof window & {
          __PERSISTENT_AUTH__?: { accessToken?: string; subject?: string }
        }
      ).__PERSISTENT_AUTH__
const runtimeAccessToken = () => {
  if (runtimeAuth?.accessToken) return runtimeAuth.accessToken
  return readStoredAuth()?.accessToken
}
const principalId = runtimeAuth?.subject ?? storedAuth?.subject ?? 'dev-user'
const historyDesktopMediaQuery = '(min-width: 1100px)'
const scopeHeaders: Record<string, string> = {
  'content-type': 'application/json',
  'x-tenant-id': tenantId,
  'x-workspace-id': workspaceId,
}
if (runtimeAuth?.accessToken ?? storedAuth?.accessToken)
  // Getter, sessiz refresh sonrası her istekte güncel token'ı okur.
  Object.defineProperty(scopeHeaders, 'authorization', {
    enumerable: true,
    get: () => `Bearer ${runtimeAccessToken() ?? ''}`,
  })

const cacheNamespace = tenantCacheNamespace(principalId, tenantId, workspaceId)

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

export function serverOwnedRunLabel(
  status: DurableRun['status'],
  realtimeState: string,
) {
  if (status === 'interrupting') return localize('Stopping…', 'Durduruluyor…')
  return realtimeState === 'canlı'
    ? localize('Running on the server', 'Server üzerinde çalışıyor')
    : localize(
        'Running in the background · reconnecting',
        'Arka planda çalışıyor · bağlantı yeniden kuruluyor',
      )
}

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

export function sourceMediaType(file: Pick<File, 'name' | 'type'>) {
  const extension = file.name.toLowerCase().split('.').pop()
  if (file.type === 'application/pdf' || extension === 'pdf')
    return 'application/pdf'
  if (
    file.type === 'text/markdown' ||
    ['md', 'markdown'].includes(extension ?? '')
  )
    return 'text/markdown'
  if (file.type === 'text/plain' || ['txt', 'text'].includes(extension ?? ''))
    return 'text/plain'
  const codeTypes: Record<string, string> = {
    json: 'application/json',
    js: 'application/javascript',
    jsx: 'application/javascript',
    ts: 'application/typescript',
    tsx: 'application/typescript',
    py: 'text/x-python',
    rs: 'text/x-rust',
    sh: 'text/x-shellscript',
    css: 'text/css',
    html: 'text/html',
  }
  return extension ? codeTypes[extension] : undefined
}

async function readPlatformMeta(): Promise<PlatformMeta> {
  const response = await fetch(`${apiBaseUrl}/v1/meta`)
  if (!response.ok)
    throw new Error(
      localize(
        'The control plane did not respond',
        'Control plane yanıt vermedi',
      ),
    )
  return response.json() as Promise<PlatformMeta>
}

async function readMe(): Promise<MeResponse> {
  const response = await fetch(`${apiBaseUrl}/v1/me`, {
    headers: scopeHeaders,
  })
  if (!response.ok) throw await apiError(response)
  return meResponseSchema.parse(await response.json())
}

async function readReadiness(retry = false): Promise<ReadinessResponse> {
  const response = await fetch(`${apiBaseUrl}/readyz`, {
    headers: {
      ...scopeHeaders,
      ...(retry ? { 'x-readiness-retry': '1' } : {}),
    },
  })
  return normalizeReadinessResponse(await response.json())
}

export function normalizeReadinessResponse(input: unknown): ReadinessResponse {
  const workspaceReadiness = readinessResponseSchema.safeParse(input)
  if (workspaceReadiness.success) return workspaceReadiness.data

  // Production/self-hosted deployments expose dependency readiness at the
  // same path. Treat a healthy production topology as ready so the composer
  // does not remain permanently disabled while preserving the richer local
  // workspace readiness contract when it is available.
  if (
    typeof input !== 'object' ||
    input === null ||
    !('ready' in input) ||
    typeof input.ready !== 'boolean'
  )
    throw workspaceReadiness.error

  const checkedAt =
    'checkedAt' in input &&
    typeof input.checkedAt === 'string' &&
    !Number.isNaN(Date.parse(input.checkedAt))
      ? input.checkedAt
      : new Date().toISOString()
  return readinessResponseSchema.parse({
    status: input.ready ? 'ready' : 'degraded',
    checkedAt,
    checks: [
      {
        name: 'provisioning',
        status: input.ready ? 'ready' : 'failed',
        code: input.ready ? null : 'PRODUCTION_DEPENDENCY_UNAVAILABLE',
      },
    ],
    recovery: {
      code: null,
      instruction: null,
      retryable: !input.ready,
      readOnlyAvailable: true,
    },
  })
}

async function readProviderCatalogs(): Promise<ProviderCatalogListResponse> {
  const response = await fetch(`${apiBaseUrl}/v1/provider-catalogs`, {
    headers: scopeHeaders,
  })
  if (!response.ok) throw await apiError(response)
  return providerCatalogListResponseSchema.parse(await response.json())
}

async function readUsage(sessionId: string): Promise<ConversationUsageCost> {
  const response = await fetch(
    `${apiBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/usage`,
    { headers: scopeHeaders },
  )
  if (!response.ok) throw await apiError(response)
  return conversationUsageCostSchema.parse(await response.json())
}

async function readBilling(sessionId: string): Promise<BillingOverview> {
  const response = await fetch(
    `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/billing?sessionId=${encodeURIComponent(sessionId)}`,
    { headers: scopeHeaders },
  )
  if (!response.ok) throw await apiError(response)
  return billingOverviewSchema.parse(await response.json())
}

async function readBillingFinancial(): Promise<BillingFinancialOverview> {
  const response = await fetch(
    `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/financial`,
    { headers: scopeHeaders },
  )
  if (!response.ok) throw await apiError(response)
  return billingFinancialOverviewSchema.parse(await response.json())
}

export function formatUsageCost(summary: UsageCostSummary | undefined) {
  if (!summary)
    return {
      amount: localize('No usage yet', 'Henüz kullanım yok'),
      detail: localize(
        'Calculated after the first response',
        'İlk yanıttan sonra hesaplanır',
      ),
    }
  if (Object.values(summary.counters).every((value) => value === 0))
    return {
      amount: localize('No measured usage yet', 'Henüz ölçülmüş kullanım yok'),
      detail: localize(
        'Calculated after the first token record',
        'İlk token kaydından sonra hesaplanır',
      ),
    }
  const micros =
    summary.reconciliationStatus === 'reconciled'
      ? summary.officialCostMicros
      : summary.estimatedCostMicros
  const amount =
    micros === null
      ? localize('Unavailable', 'Fiyatlandırılamadı')
      : new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: summary.currency,
          minimumFractionDigits: 4,
          maximumFractionDigits: 6,
        }).format(micros / 1_000_000)
  return {
    amount,
    detail:
      summary.reconciliationStatus === 'reconciled'
        ? `${localize('Actual provider cost', 'Gerçekleşen provider maliyeti')} · ${summary.completeness}`
        : `${micros === null ? localize('No price for this model', 'Bu model için fiyat yok') : localize('API list-price estimate', 'API liste fiyatı tahmini')} · ${summary.completeness}`,
  }
}

type OfflineHistorySession = Pick<
  SessionSummary,
  | 'sessionId'
  | 'title'
  | 'status'
  | 'provider'
  | 'resolvedModel'
  | 'reasoningEffort'
> & { folderId: null; archivedAt: null; updatedAt: string }

export function parseOfflineHistory(
  raw: string | null,
): OfflineHistorySession[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; sessions?: unknown }
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return []
    return parsed.sessions.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const item = value as Record<string, unknown>
      return typeof item.sessionId === 'string' &&
        typeof item.title === 'string' &&
        typeof item.status === 'string' &&
        (item.provider === 'codex' ||
          item.provider === 'claude' ||
          item.provider === 'gemini' ||
          item.provider === 'cursor') &&
        typeof item.resolvedModel === 'string' &&
        typeof item.reasoningEffort === 'string' &&
        typeof item.updatedAt === 'string'
        ? [
            {
              sessionId: item.sessionId,
              title: item.title,
              status: item.status as OfflineHistorySession['status'],
              provider: item.provider,
              resolvedModel: item.resolvedModel,
              reasoningEffort:
                item.reasoningEffort as OfflineHistorySession['reasoningEffort'],
              folderId: null,
              archivedAt: null,
              updatedAt: item.updatedAt,
            },
          ]
        : []
    })
  } catch {
    return []
  }
}

interface OfflineConversationSnapshot {
  version: 1
  sessionId: string
  savedAt: string
  messages: ConversationMessage[]
}

export function parseOfflineConversation(
  raw: string | null,
  expectedSessionId: string,
): OfflineConversationSnapshot | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (
      value.version !== 1 ||
      value.sessionId !== expectedSessionId ||
      typeof value.savedAt !== 'string' ||
      !Array.isArray(value.messages)
    )
      return undefined
    const messages = value.messages.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return []
      const item = candidate as Record<string, unknown>
      if (
        typeof item.key !== 'string' ||
        (item.role !== 'user' && item.role !== 'assistant') ||
        typeof item.text !== 'string' ||
        typeof item.sequence !== 'number'
      )
        return []
      return [
        {
          key: item.key,
          role: item.role,
          text: item.text,
          sequence: item.sequence,
          ...(typeof item.turnId === 'string' ? { turnId: item.turnId } : {}),
        } satisfies ConversationMessage,
      ]
    })
    return {
      version: 1,
      sessionId: expectedSessionId,
      savedAt: value.savedAt,
      messages,
    }
  } catch {
    return undefined
  }
}

export function userFacingApiError(
  body: ApiErrorResponse | null,
  status: number,
) {
  if (
    body?.reasonCode === 'HARD_LIMIT_PREPAID_CREDIT' ||
    body?.message === 'HARD_LIMIT_PREPAID_CREDIT'
  )
    return localize(
      'Usage credits are depleted. This workspace does not have enough prepaid credit to start a new operation.',
      'Kullanım kredisi tükendi. Bu workspace’te yeni bir işlem başlatmak için yeterli prepaid kredi bulunmuyor.',
    )
  if (body?.code === 'USAGE_LIMIT_REACHED')
    return localize(
      'The workspace usage limit has been reached. Check plan and quota settings.',
      'Workspace kullanım limiti doldu. Plan ve kota ayarlarını kontrol edin.',
    )
  if (
    body?.reasonCode === 'HARD_LIMIT_TENANT_CONCURRENT_TURN' ||
    body?.message === 'HARD_LIMIT_TENANT_CONCURRENT_TURN'
  )
    return localize(
      'The concurrent turn limit has been reached. Wait for active work to finish or recover terminal runs before trying again.',
      'Eşzamanlı turn sınırına ulaşıldı. Yeniden denemeden önce aktif işlerin bitmesini bekleyin veya terminal run’ları kurtarın.',
    )
  if (body?.code === 'COMMERCIAL_DEPENDENCY_UNAVAILABLE')
    return localize(
      'The usage verification service is unavailable. Try again shortly.',
      'Kullanım doğrulama servisine şu anda ulaşılamıyor. Lütfen kısa bir süre sonra yeniden deneyin.',
    )
  if (body?.code === 'CONTENT_KEY_LOCKED' || status === 428)
    return localize(
      'The secure content key is locked. Reauthenticate with your password to continue.',
      'Güvenli içerik anahtarı kilitli. Devam etmek için parolanızla yeniden doğrulayın.',
    )
  return (
    body?.message ??
    localize(`Request failed (${status})`, `İstek başarısız (${status})`)
  )
}

async function apiError(response: Response): Promise<Error> {
  const parsed = apiErrorResponseSchema.safeParse(
    await response.json().catch(() => null),
  )
  return new Error(
    userFacingApiError(parsed.success ? parsed.data : null, response.status),
  )
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

async function readRecentSessions(cursor: string | null, archived = false) {
  const query = new URLSearchParams({ limit: '12' })
  if (cursor) query.set('cursor', cursor)
  if (archived) query.set('archived', 'true')
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

async function readSharedFolders() {
  const response = await fetch(`${apiBaseUrl}/v1/folders`, {
    headers: scopeHeaders,
  })
  if (!response.ok) throw await apiError(response)
  return folderListResponseSchema.parse(await response.json())
}

async function readFolderMembers(folderId: string) {
  const response = await fetch(
    `${apiBaseUrl}/v1/folders/${encodeURIComponent(folderId)}/members`,
    { headers: scopeHeaders },
  )
  if (!response.ok) throw await apiError(response)
  return folderMemberListResponseSchema.parse(await response.json())
}

async function readSources() {
  const response = await fetch(
    `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/sources`,
    { headers: scopeHeaders },
  )
  if (!response.ok) throw await apiError(response)
  return sourceListResponseSchema.parse(await response.json())
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

async function readSupportGrants(sessionId: string) {
  const response = await fetch(
    `${apiBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/support-grants`,
    { headers: scopeHeaders },
  )
  if (!response.ok) throw await apiError(response)
  return supportGrantListResponseSchema.parse(await response.json()).grants
}
async function readSupportAudit(sessionId: string) {
  const response = await fetch(
    `${apiBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/support-audit`,
    { headers: scopeHeaders },
  )
  if (!response.ok) throw await apiError(response)
  return securityAuditListResponseSchema.parse(await response.json())
}

export function supportGrantStatusLabel(status: SupportGrant['status']) {
  return {
    pending_verification: localize(
      'Awaiting MFA verification',
      'MFA doğrulaması bekliyor',
    ),
    pending_approval: localize(
      'Awaiting authorized approval',
      'Yetkili onayı bekliyor',
    ),
    active: localize('Active', 'Aktif'),
    revoked: localize('Revoked early', 'Erken iptal edildi'),
    expired: localize('Expired', 'Süresi doldu'),
    denied: localize('Denied', 'Reddedildi'),
  }[status]
}

function SupportAccessPanel({
  sessionId,
  grants,
  pending,
  audit,
  auditChainValid,
  onChanged,
  onClose,
}: {
  sessionId: string
  grants: SupportGrant[]
  pending: boolean
  audit: SecurityAuditRecord[]
  auditChainValid: boolean
  onChanged(): void
  onClose(): void
}) {
  const t = useTranslations()
  const [reason, setReason] = useState('')
  const [supportPrincipalId, setSupportPrincipalId] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(15)
  const [actions, setActions] = useState<SupportAccessAction[]>([
    'content.view',
  ])
  const [submitting, setSubmitting] = useState(false)
  const [panelError, setPanelError] = useState<string>()

  function toggleAction(action: SupportAccessAction) {
    setActions((current) =>
      current.includes(action)
        ? current.filter((value) => value !== action)
        : [...current, action],
    )
  }

  async function createGrant(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setPanelError(undefined)
    try {
      const body = createSupportGrantRequestSchema.parse({
        sessionId,
        actions,
        reason,
        supportPrincipalId,
        durationMinutes,
      })
      const response = await fetch(
        `${apiBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/support-grants`,
        {
          method: 'POST',
          headers: { ...scopeHeaders, 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify(body),
        },
      )
      if (!response.ok) throw await apiError(response)
      supportGrantSchema.parse(await response.json())
      setReason('')
      onChanged()
    } catch (cause) {
      setPanelError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  async function revoke(grant: SupportGrant) {
    setSubmitting(true)
    setPanelError(undefined)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/support-grants/${encodeURIComponent(grant.grantId)}/revoke`,
        {
          method: 'POST',
          headers: { ...scopeHeaders, 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ expectedVersion: grant.version }),
        },
      )
      if (!response.ok) throw await apiError(response)
      supportGrantSchema.parse(await response.json())
      onChanged()
    } catch (cause) {
      setPanelError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <aside
      className="workspace-drawer support-access-panel"
      aria-labelledby="support-access-title"
    >
      <div className="support-access-heading">
        <div>
          <p className="section-label">
            {t('User-controlled access', 'Kullanıcı kontrollü erişim')}
          </p>
          <h2 id="support-access-title">
            {t('Support access', 'Support erişimi')}
          </h2>
        </div>
        <button
          type="button"
          className="drawer-close"
          aria-label={t(
            'Close support access panel',
            'Support erişimi panelini kapat',
          )}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="support-access-note">
        {t(
          'Only this conversation and the actions you select are shared. Access to the whole account is never granted.',
          'Yalnız bu sohbet ve seçtiğiniz eylemler paylaşılır. Tüm hesaba erişim verilmez.',
        )}
      </p>
      {panelError ? (
        <p className="form-error" role="alert">
          {panelError}
        </p>
      ) : null}
      <form
        className="support-access-form"
        onSubmit={(event) => void createGrant(event)}
      >
        <p>
          <strong>{t('Shared object', 'Paylaşılan nesne')}:</strong> session{' '}
          <code>{sessionId}</code>
        </p>
        <fieldset>
          <legend>{t('Allowed actions', 'İzin verilen eylemler')}</legend>
          {(
            [
              [
                'content.view',
                t('View prompts and output', 'Prompt ve output görüntüleme'),
              ],
              [
                'artifact.download',
                t(
                  'Download artifacts (dual approval)',
                  'Artifact indirme (çift onay)',
                ),
              ],
              [
                'attachment.download',
                t(
                  'Download attachments (dual approval)',
                  'Attachment indirme (çift onay)',
                ),
              ],
              [
                'content.decrypt',
                t(
                  'Decrypt content (KMS role + dual approval)',
                  'İçerik decrypt (KMS rolü + çift onay)',
                ),
              ],
            ] as const
          ).map(([action, label]) => (
            <label key={action}>
              <input
                type="checkbox"
                checked={actions.includes(action)}
                onChange={() => toggleAction(action)}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <label>
          <span>Atanan support principal</span>
          <input
            value={supportPrincipalId}
            required
            maxLength={160}
            onChange={(event) => setSupportPrincipalId(event.target.value)}
          />
        </label>
        <label>
          <span>{t('User justification', 'Kullanıcı gerekçesi')}</span>
          <textarea
            value={reason}
            required
            minLength={8}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <label>
          <span>{t('Duration', 'Süre')}</span>
          <select
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(Number(event.target.value))}
          >
            <option value={5}>5 dakika</option>
            <option value={15}>15 dakika</option>
            <option value={30}>30 dakika</option>
            <option value={60}>60 dakika</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={
            submitting ||
            actions.length === 0 ||
            reason.trim().length < 8 ||
            !supportPrincipalId.trim()
          }
        >
          {submitting
            ? t('Creating…', 'Oluşturuluyor…')
            : t('Create scoped grant', 'Dar kapsamlı grant oluştur')}
        </button>
      </form>
      {pending ? <p>{t('Loading grants…', 'Grant’ler yükleniyor…')}</p> : null}
      <ul className="support-grant-list">
        {grants.map((grant) => (
          <li key={grant.grantId} data-status={grant.status}>
            <div>
              <strong>{supportGrantStatusLabel(grant.status)}</strong>
              <span>{grant.actions.join(' · ')}</span>
              <small>
                {t('Expires', 'Son kullanım')}:{' '}
                {new Date(grant.expiresAt).toLocaleString(
                  localize('en-US', 'tr-TR'),
                )}
              </small>
            </div>
            {['pending_verification', 'pending_approval', 'active'].includes(
              grant.status,
            ) ? (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void revoke(grant)}
              >
                Erken iptal et
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {audit.length ? (
        <details className="support-audit-list">
          <summary>
            Immutable support audit · {audit.length} {t('records', 'kayıt')} ·{' '}
            {auditChainValid
              ? t('chain verified', 'zincir doğrulandı')
              : t('chain error', 'zincir hatası')}
          </summary>
          <ol>
            {audit
              .slice()
              .reverse()
              .map((record) => (
                <li key={record.sequence}>
                  <strong>{record.action}</strong>
                  <span>{record.outcome}</span>
                  <time dateTime={record.occurredAt}>
                    {new Date(record.occurredAt).toLocaleString(
                      localize('en-US', 'tr-TR'),
                    )}
                  </time>
                </li>
              ))}
          </ol>
        </details>
      ) : null}
    </aside>
  )
}

function SourcesDrawer({
  sources,
  pending,
  error,
  online,
  onUpload,
  onClose,
}: {
  sources: Source[]
  pending: boolean
  error: boolean
  online: boolean
  onUpload(file: File): void
  onClose(): void
}) {
  const t = useTranslations()
  return (
    <aside
      className="workspace-drawer sources-drawer"
      aria-labelledby="sources-title"
    >
      <div className="drawer-heading">
        <div>
          <p className="section-label">
            {t('Workspace knowledge', 'Workspace bilgisi')}
          </p>
          <h2 id="sources-title">Sources</h2>
          <p>
            {t(
              'Files and documents this workspace can reference in answers.',
              'Bu workspace’in cevaplarda başvurabildiği dosya ve dokümanlar.',
            )}
          </p>
        </div>
        <button
          className="drawer-close"
          type="button"
          onClick={onClose}
          aria-label={t('Close sources panel', 'Sources panelini kapat')}
        >
          ×
        </button>
      </div>
      <label className="source-upload drawer-upload">
        <span>
          {pending
            ? t('Loading…', 'Yükleniyor…')
            : t('Add source', 'Source ekle')}
        </span>
        <input
          type="file"
          disabled={!online || pending}
          accept=".pdf,.md,.markdown,.txt,.text,.json,.js,.jsx,.ts,.tsx,.py,.rs,.sh,.css,.html"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) onUpload(file)
            event.currentTarget.value = ''
          }}
        />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {t('Could not load the source list.', 'Source listesi alınamadı.')}
        </p>
      ) : null}
      {sources.length ? (
        <ul
          className="source-list"
          aria-label={t('Corpus source statuses', 'Corpus source durumları')}
        >
          {sources.map((source) => (
            <li key={source.sourceId}>
              <span title={source.displayName}>{source.displayName}</span>
              <strong data-source-status={source.status}>
                {source.status}
              </strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="drawer-empty">
          {t('No sources have been added yet.', 'Henüz source eklenmedi.')}
        </p>
      )}
    </aside>
  )
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
  const t = useTranslations()
  return (
    <section
      className="audit-panel"
      aria-labelledby="audit-title"
      aria-busy={pending}
    >
      <div className="audit-heading">
        <div>
          <p className="section-label">Durable audit</p>
          <h2 id="audit-title">
            {t('Session action chain', 'Session eylem zinciri')}
          </h2>
        </div>
        {stale ? <span className="audit-stale">stale</span> : null}
      </div>
      {pending ? (
        <p className="audit-state">
          {t('Loading audit…', 'Audit yükleniyor…')}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {t('Could not load audit', 'Audit alınamadı')}: {error}
        </p>
      ) : null}
      {!pending && !error && !records.length ? (
        <p className="audit-state">
          {t('No audit records yet.', 'Henüz audit kaydı yok.')}
        </p>
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
                {new Date(record.occurredAt).toLocaleString(
                  localize('en-US', 'tr-TR'),
                )}
              </time>
              <code>
                {record.correlationId ?? t('no correlation', 'correlation yok')}
              </code>
            </li>
          ))}
        </ol>
      ) : null}
      {hasMore ? (
        <button type="button" disabled={fetchingMore} onClick={onMore}>
          {fetchingMore
            ? t('Loading…', 'Yükleniyor…')
            : t('Older audit records', 'Daha eski audit kayıtları')}
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
  const t = useTranslations()
  return (
    <section
      className="git-panel"
      aria-labelledby="git-title"
      aria-busy={pending}
    >
      <div className="git-panel-heading">
        <div>
          <p className="section-label">
            {t('Git source of truth', 'Git doğruluk kaynağı')}
          </p>
          <h2 id="git-title">Status · diff · log</h2>
        </div>
        <button type="button" disabled={pending} onClick={onRefresh}>
          {pending ? t('Refreshing…', 'Yenileniyor…') : t('Refresh', 'Yenile')}
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {!snapshot && !pending ? (
        <p className="git-empty">
          {t('No Git snapshot yet.', 'Henüz Git snapshot yok.')}
        </p>
      ) : null}
      {snapshot ? (
        <>
          <div className="git-summary">
            <span>{snapshot.repositoryKind}</span>
            <span>
              {snapshot.branch ??
                (snapshot.detached
                  ? 'detached HEAD'
                  : t('no branch', 'branch yok'))}
            </span>
            <code>
              {snapshot.headOid?.slice(0, 10) ?? t('no HEAD', 'HEAD yok')}
            </code>
            <span>
              {snapshot.clean
                ? 'clean'
                : `${snapshot.changes.length} ${t('changes', 'değişiklik')}`}
            </span>
            {snapshot.stale ? <strong>stale</strong> : null}
          </div>
          <p
            className={`git-relationship relationship-${snapshot.relationship}`}
          >
            {snapshot.relationship === 'authoritative'
              ? t(
                  'The Git snapshot is authoritative; there is no normalized event change count.',
                  'Git snapshot authoritative; normalize event değişiklik sayısı yok.',
                )
              : snapshot.relationship === 'matches_events'
                ? `Git snapshot, ${snapshot.eventChangeCount} normalize file-change eventiyle uyumlu.`
                : t(
                    'The normalized event summary differs from the Git snapshot; Git is authoritative.',
                    'Normalize event özeti ile Git snapshot farklı; Git sonucu authoritative.',
                  )}
          </p>
          <div className="git-columns">
            <div>
              <h3>{t('Changes', 'Değişiklikler')}</h3>
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
                {!snapshot.changes.length ? (
                  <li>{t('Workspace clean.', 'Workspace temiz.')}</li>
                ) : null}
              </ul>
            </div>
            <div>
              <h3>{t('Recent commits', 'Son commit’ler')}</h3>
              <ul className="git-log-list">
                {snapshot.log.slice(0, 6).map((entry) => (
                  <li key={entry.oid}>
                    <code>{entry.shortOid}</code>
                    <span>{entry.subject}</span>
                  </li>
                ))}
                {!snapshot.log.length ? (
                  <li>{t('No commit history.', 'Commit geçmişi yok.')}</li>
                ) : null}
              </ul>
            </div>
          </div>
          <details className="git-diff" open={Boolean(snapshot.diff.preview)}>
            <summary>
              Diff preview · {snapshot.diff.byteLength} byte
              {snapshot.diff.truncated ? ' · bounded' : ''}
            </summary>
            <pre>{snapshot.diff.preview || t('No diff.', 'Diff yok.')}</pre>
            {snapshot.diff.artifactId ? (
              <button
                type="button"
                onClick={() => void downloadArtifact(snapshot.diff.artifactId!)}
              >
                {t('Download full redacted diff', 'Tam redakte diff’i indir')}
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
        name: source.split(/[\\/]/).pop() || localize('Image', 'Görsel'),
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
        card.event.sequence <= assistant.sequence &&
        (assistant.turnId
          ? card.event.codexTurnId === assistant.turnId
          : card.event.sequence > afterSequence),
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
  const trailingGroups = new Map<string, TimelineCard[]>()
  for (const card of cards.filter(
    (candidate) => !claimedCards.has(candidate.key),
  )) {
    const key = card.event.codexTurnId ?? 'legacy'
    const group = trailingGroups.get(key) ?? []
    group.push(card)
    trailingGroups.set(key, group)
  }
  for (const trailing of trailingGroups.values()) {
    if (!trailing.some((card) => !isHousekeepingCard(card))) continue
    const last = trailing.at(-1)!
    const groupTurnId = last.event.codexTurnId
    const lastGroupMessageSequence = messages
      .filter((message) => message.turnId === groupTurnId)
      .reduce((maximum, message) => Math.max(maximum, message.sequence), -1)
    work.push({
      key: nextWorkKey(trailing),
      role: 'work',
      cards: trailing,
      sequence: Math.max(last.event.sequence, lastGroupMessageSequence) + 0.25,
      running:
        turnIsActive &&
        (!groupTurnId || !activeTurnId || groupTurnId === activeTurnId),
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

export function turnSubmitBlocked(input: {
  session: Pick<SessionResponse, 'status' | 'provider'> | undefined
  prompt: string
  attachmentCount: number
  turnPending: boolean
  turnActive: boolean
  online: boolean
  authReady: boolean
  selectedProvider: 'codex' | 'claude' | 'gemini' | 'cursor'
}): boolean {
  const provider = input.session?.provider ?? input.selectedProvider
  return (
    (input.session !== undefined && input.session.status !== 'active') ||
    (!input.prompt.trim() && input.attachmentCount === 0) ||
    input.turnPending ||
    input.turnActive ||
    !input.online ||
    (!input.authReady && provider === 'codex')
  )
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
  if (event.type === 'cursor.unknown')
    return localize('Cursor event', 'Cursor olayı')
  const titles: Partial<Record<TimelineEvent['type'], string>> = {
    'turn.started': localize('Turn started', 'Turn başladı'),
    'turn.completed': localize('Turn completed', 'Turn tamamlandı'),
    'agent.message.delta': localize('Codex response', 'Codex yanıtı'),
    'agent.message.completed': localize('Codex response', 'Codex yanıtı'),
    'reasoning.summary.delta': localize('Reasoning summary', 'Reasoning özeti'),
    'plan.delta': 'Plan',
    'plan.completed': 'Plan',
    'command.proposed': 'Komut',
    'command.output.delta': localize('Command output', 'Komut çıktısı'),
    'command.completed': localize('Command completed', 'Komut tamamlandı'),
    'file.change.proposed': localize('File change', 'Dosya değişikliği'),
    'file.change.completed': localize('File change', 'Dosya değişikliği'),
    'diff.updated': 'Diff',
    'tool.started': localize('Tool running', 'Tool çalışıyor'),
    'tool.completed': localize('Tool completed', 'Tool tamamlandı'),
    'token.usage.updated': localize('Token usage', 'Token kullanımı'),
    'error.reported': localize('Error', 'Hata'),
    'approval.requested': localize('Approval pending', 'Onay bekleniyor'),
    'approval.resolved': localize('Approval resolved', 'Onay çözüldü'),
    'context.compacted': localize(
      'Context compacted',
      'Context compact edildi',
    ),
  }
  return titles[event.type] ?? event.type
}

function unknownEventTitle(method: string): string {
  return (
    {
      'thread/started': localize(
        'Codex task started',
        'Codex task’ı başlatıldı',
      ),
      'thread/status/changed': localize(
        'Task status changed',
        'Task durumu değişti',
      ),
      'turn/started': localize('Turn started', 'Turn başladı'),
      'turn/completed': localize('Turn completed', 'Turn tamamlandı'),
      'item/started': localize('Operation started', 'İşlem başladı'),
      'item/completed': localize('Operation completed', 'İşlem tamamlandı'),
      'mcpServer/startupStatus/updated': localize(
        'Preparing tool connections',
        'Araç bağlantıları hazırlanıyor',
      ),
      warning: localize('Codex warning', 'Codex uyarısı'),
    }[method] ?? localize('Codex event', 'Codex olayı')
  )
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
    event.type === 'diff.updated' ||
    event.type === 'tool.completed'
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
  if (event.type === 'cursor.unknown')
    return JSON.stringify(
      {
        ...metadata,
        eventType: event.payload.eventType,
        envelope: event.payload.envelope,
      },
      null,
      2,
    )
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
        localize(
          'Waiting for a user decision; no automatic response was sent.',
          'Kullanıcı kararı bekleniyor; otomatik yanıt verilmedi.',
        )
      )
    case 'approval.resolved':
      return `${event.payload.approvalKind} ${localize('approval resolved', 'onayı çözüldü')}`
    case 'token.usage.updated':
      return `${event.payload.total.totalTokens} ${localize('total tokens', 'toplam token')}`
    case 'error.reported':
      return event.payload.message
    case 'codex.unknown':
      return event.payload.method
    case 'cursor.unknown':
      return event.payload.eventType
    case 'context.compacted':
      return localize(
        'Conversation context was compacted.',
        'Conversation context compact edildi.',
      )
    default:
      return event.type
  }
}

function TimelineEntry({ card }: { card: TimelineCard }) {
  const t = useTranslations()
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
              <pre
                aria-label={
                  card.event.type === 'tool.completed' &&
                  card.event.payload.tool === 'search_corpus'
                    ? 'Corpus citation result'
                    : undefined
                }
              >
                {presentation.summary}
              </pre>
              <details className="timeline-technical-details">
                <summary>{t('Technical details', 'Teknik detaylar')}</summary>
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
            {card.event.payload.output.truncated
              ? `${t('Truncated', 'Kısaltıldı')} · `
              : ''}
            {card.event.payload.output.totalBytes.toLocaleString()} byte
          </span>
          <button
            type="button"
            onClick={() => void downloadArtifact(artifactId)}
          >
            {t(
              'Open/download full redacted output',
              'Tam redakte çıktıyı aç/indir',
            )}
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

function activity(
  running: boolean,
  runningEnglish: string,
  runningTurkish: string,
  completedEnglish: string,
  completedTurkish: string,
) {
  return running
    ? localize(runningEnglish, runningTurkish)
    : localize(completedEnglish, completedTurkish)
}

function commandActivity(command: string, running: boolean): string {
  const value = command.toLocaleLowerCase('en-US')
  if (
    /\b(vitest|jest|pytest|cargo test|go test|pnpm test|npm test)\b/.test(value)
  )
    return activity(
      running,
      'Running tests',
      'Testleri çalıştırıyor',
      'Ran tests',
      'Testleri çalıştırdı',
    )
  if (/\b(typecheck|tsc|build|lint|prettier)\b/.test(value))
    return activity(
      running,
      'Validating changes',
      'Değişiklikleri doğruluyor',
      'Validated changes',
      'Değişiklikleri doğruladı',
    )
  if (/\b(install|add)\b/.test(value))
    return activity(
      running,
      'Preparing dependencies',
      'Bağımlılıkları hazırlıyor',
      'Prepared dependencies',
      'Bağımlılıkları hazırladı',
    )
  if (/\b(rg|grep|find|ls|sed|git status|git diff)\b/.test(value))
    return activity(
      running,
      'Inspecting the workspace',
      'Çalışma alanını inceliyor',
      'Inspected the workspace',
      'Çalışma alanını inceledi',
    )
  return activity(
    running,
    'Running a command',
    'Bir komut çalıştırıyor',
    'Completed commands',
    'Komutları tamamladı',
  )
}

export function describeConversationWork(work: ConversationWork): string {
  const { cards, running } = work
  if (running && cards.length === 0) return localize('Thinking', 'Düşünüyor')
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
    return activity(
      running,
      'Applying code changes',
      'Kod değişikliklerini uyguluyor',
      'Applied code changes',
      'Kod değişikliklerini uyguladı',
    )
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
      return activity(
        running,
        'Researching sources',
        'Kaynakları araştırıyor',
        'Researched sources',
        'Kaynakları araştırdı',
      )
    if (/\b(rg|grep|find|read|filesystem)\b/.test(toolName))
      return activity(
        running,
        'Inspecting the workspace',
        'Çalışma alanını inceliyor',
        'Inspected the workspace',
        'Çalışma alanını inceledi',
      )
    return activity(
      running,
      'Using tools',
      'Araçları kullanıyor',
      'Completed tool operations',
      'Araç işlemlerini tamamladı',
    )
  }
  if (unknownKinds.some((kind) => /websearch|search|browser/.test(kind)))
    return activity(
      running,
      'Researching sources',
      'Kaynakları araştırıyor',
      'Researched sources',
      'Kaynakları araştırdı',
    )
  if (unknownKinds.some((kind) => /reasoning|plan/.test(kind)))
    return activity(
      running,
      'Evaluating the approach',
      'Yaklaşımı değerlendiriyor',
      'Evaluated the approach',
      'Yaklaşımı değerlendirdi',
    )
  if (
    cards.some(
      (card) =>
        card.event.type === 'codex.unknown' &&
        card.event.payload.method === 'mcpServer/startupStatus/updated',
    )
  )
    return activity(
      running,
      'Preparing the environment',
      'Çalışma ortamını hazırlıyor',
      'Prepared the environment',
      'Çalışma ortamını hazırladı',
    )
  if (
    cards.some(
      (card) =>
        card.event.type === 'plan.delta' ||
        card.event.type === 'plan.completed' ||
        card.event.type === 'reasoning.summary.delta',
    )
  )
    return activity(
      running,
      'Evaluating the approach',
      'Yaklaşımı değerlendiriyor',
      'Evaluated the approach',
      'Yaklaşımı değerlendirdi',
    )
  return activity(
    running,
    'Preparing the response',
    'Yanıtı hazırlıyor',
    'Prepared the response',
    'Yanıtı hazırladı',
  )
}

function ConversationWorkBlock({ work }: { work: ConversationWork }) {
  const t = useTranslations()
  const [expanded, setExpanded] = useState(work.running)
  const visibleCards = work.cards.slice(-8)
  const corpusCitation = [...visibleCards]
    .reverse()
    .find(
      (card) =>
        card.event.type === 'tool.completed' &&
        card.event.payload.provider === 'workspace_corpus' &&
        card.event.payload.tool === 'search_corpus' &&
        card.event.payload.success,
    )
  return (
    <details
      className={`chat-work ${work.running ? 'is-running' : ''}`}
      open={work.running || expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="chat-work-icon" aria-hidden="true">
          <span />
        </span>
        <span className="chat-work-label">
          <strong>{describeConversationWork(work)}</strong>
          {work.running ? (
            <span
              className="chat-work-loading"
              aria-label={t('In progress', 'Devam ediyor')}
            >
              <i />
              <i />
              <i />
            </span>
          ) : null}
        </span>
        <small className="chat-work-meta">
          {work.running
            ? t('live', 'canlı')
            : `${work.cards.length} ${t('steps', 'adım')}`}
        </small>
        <span className="chat-work-chevron" aria-hidden="true" />
      </summary>
      <ol>
        {visibleCards.map((card) => (
          <li key={card.key}>
            <span aria-hidden="true">
              {card.event.type.startsWith('command.')
                ? '$'
                : card.event.type.startsWith('file.')
                  ? '±'
                  : card.event.type.startsWith('token.')
                    ? '#'
                    : card.event.type.startsWith('reasoning.')
                      ? '»'
                      : '›'}
            </span>
            <strong>{describeTimelineEvent(card).title}</strong>
            <small>{compactWorkSummary(card)}</small>
          </li>
        ))}
      </ol>
      {corpusCitation?.event.type === 'tool.completed' ? (
        <details className="corpus-citation-details">
          <summary>
            {t('Corpus citation details', 'Corpus citation ayrıntıları')}
          </summary>
          <pre aria-label="Corpus citation result">
            {JSON.stringify(corpusCitation.event.payload.result, null, 2)}
          </pre>
        </details>
      ) : null}
      {work.cards.length > visibleCards.length ? (
        <p>
          {work.cards.length - visibleCards.length}{' '}
          {t('older steps hidden.', 'eski adım gizlendi.')}
        </p>
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
  const t = useTranslations()
  const context = approval.context
  const commandActions = Array.isArray(context.commandActions)
    ? context.commandActions
    : []
  const networkContext = context.networkApprovalContext
  return (
    <aside
      id={`approval-${approval.approvalId}`}
      tabIndex={-1}
      className={`approval-card approval-${approval.status}`}
      aria-live="assertive"
    >
      <div className="card-heading">
        <strong>
          {approval.kind === 'command_execution'
            ? t('Command approval', 'Komut onayı')
            : t('File change approval', 'Dosya değişikliği onayı')}
        </strong>
        <span>
          {approval.status === 'pending'
            ? t('awaiting approval', 'onay bekliyor')
            : approval.status === 'resolved'
              ? t('resolved', 'çözüldü')
              : approval.status}
        </span>
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
      <dl className="approval-safety-summary">
        <div>
          <dt>Risk</dt>
          <dd>
            {String(
              context.risk ??
                (networkContext
                  ? t('High · network access', 'Yüksek · ağ erişimi')
                  : approval.kind === 'file_change'
                    ? t('Medium · file write', 'Orta · dosya yazma')
                    : t('Command execution', 'Komut çalıştırma')),
            )}
          </dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>
            {String(
              context.scope ??
                context.grantRoot ??
                context.cwd ??
                t('This request only', 'Yalnız bu istek'),
            )}
          </dd>
        </div>
        <div>
          <dt>Expiry</dt>
          <dd>
            {approval.expiresAt
              ? new Date(approval.expiresAt).toLocaleString(
                  localize('en-US', 'tr-TR'),
                )
              : t(
                  'Until the turn or runtime changes',
                  'Turn veya runtime değişimine kadar',
                )}
          </dd>
        </div>
      </dl>
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
              : t('No diff available', 'Diff mevcut değil')}
          </pre>
        </div>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      {approval.status === 'resolving' ? (
        <p className="approval-progress">
          {t('Sending decision…', 'Karar gönderiliyor…')}
        </p>
      ) : null}
      {approval.status === 'pending' && !readOnly ? (
        <div className="approval-actions">
          <button disabled={pending} onClick={() => onDecision('accept')}>
            {t('Approve once', 'Bir kez onayla')}
          </button>
          <button
            disabled={pending}
            onClick={() => onDecision('accept_for_session')}
          >
            {t('Approve for session', 'Oturum için onayla')}
          </button>
          <button disabled={pending} onClick={() => onDecision('decline')}>
            {t('Decline', 'Reddet')}
          </button>
          <button disabled={pending} onClick={() => onDecision('cancel')}>
            {t('Cancel', 'İptal')}
          </button>
        </div>
      ) : null}
    </aside>
  )
}

type HistorySession = Pick<
  SessionSummary,
  'sessionId' | 'folderId' | 'title' | 'status' | 'archivedAt'
>

export function ConversationHistory({
  folders,
  sessions,
  archivedSessions,
  activeSessionId,
  folderName,
  folderPending,
  readOnly,
  folderActionPending,
  conversationActionPending,
  onFolderNameChange,
  onCreateFolder,
  onNewConversation,
  onSelectConversation,
  onArchiveConversation,
  onRestoreConversation,
  onSelectFolder,
  onArchiveFolder,
  onRestoreFolder,
  onDeleteFolder,
  onClose,
  tools,
  footer,
}: {
  folders: ConversationFolder[]
  sessions: HistorySession[]
  archivedSessions: HistorySession[]
  activeSessionId?: string
  folderName: string
  folderPending: boolean
  readOnly: boolean
  folderActionPending?: string
  conversationActionPending?: string
  onFolderNameChange(value: string): void
  onCreateFolder(): void
  onNewConversation(folderId: string | null): void
  onSelectConversation(sessionId: string): void
  onArchiveConversation(session: HistorySession): void
  onRestoreConversation(session: HistorySession): void
  onSelectFolder(folderId: string | null): void
  onArchiveFolder(folder: ConversationFolder): void
  onRestoreFolder(folder: ConversationFolder): void
  onDeleteFolder(folder: ConversationFolder): void
  onClose?(): void
  tools?: ReactNode
  footer?: ReactNode
}) {
  const t = useTranslations()
  const [creatingFolder, setCreatingFolder] = useState(false)
  const activeFolders = folders.filter((folder) => !folder.archivedAt)
  const archivedFolders = folders.filter((folder) => folder.archivedAt)
  const groups = [
    ...activeFolders.map((folder) => ({
      folderId: folder.folderId as string | null,
      name: folder.name,
    })),
    { folderId: null, name: t('Other conversations', 'Diğer konuşmalar') },
  ]
  return (
    <section className="conversation-history" aria-label="Conversation history">
      <div className="history-brand">
        <span className="history-logo" aria-hidden="true" />
        <strong>PERSEVERANCE</strong>
        {onClose ? (
          <button
            type="button"
            aria-label={t('Close folder drawer', "Folder drawer'ı kapat")}
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </div>
      <div className="history-actions">
        <button
          className="new-conversation-button"
          type="button"
          disabled={readOnly}
          onClick={() => onNewConversation(null)}
        >
          <span aria-hidden="true">＋</span>{' '}
          {t('New conversation', 'Yeni sohbet')}
        </button>
        <button
          className="new-folder-button"
          type="button"
          disabled={readOnly}
          aria-expanded={creatingFolder}
          onClick={() => setCreatingFolder((open) => !open)}
        >
          <span aria-hidden="true">▱</span> {t('New folder', 'Yeni folder')}
        </button>
      </div>
      {tools ? <div className="history-tools">{tools}</div> : null}
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
            aria-label={t('New folder name', 'Yeni folder adı')}
            value={folderName}
            onChange={(event) => onFolderNameChange(event.target.value)}
            placeholder={t('Folder name', 'Folder adı')}
            maxLength={80}
            disabled={readOnly}
          />
          <button
            type="submit"
            disabled={readOnly || !folderName.trim() || folderPending}
            aria-label={t('Create folder', 'Folder oluştur')}
          >
            {folderPending ? '…' : t('Add', 'Ekle')}
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
                      disabled={readOnly}
                      aria-label={t(
                        `New conversation in ${group.name}`,
                        `${group.name} içinde yeni sohbet`,
                      )}
                      title={t('New conversation', 'Yeni sohbet')}
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
                      disabled={
                        readOnly || folderActionPending === group.folderId
                      }
                      aria-label={t(
                        `Archive ${group.name} folder`,
                        `${group.name} folder'ını arşivle`,
                      )}
                      title={t('Archive', 'Arşivle')}
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
                  <div className="history-conversation" key={item.sessionId}>
                    <button
                      type="button"
                      className={
                        item.sessionId === activeSessionId ? 'is-active' : ''
                      }
                      onClick={() => onSelectConversation(item.sessionId)}
                    >
                      <span>{item.title}</span>
                      <small>{item.status}</small>
                    </button>
                    <button
                      type="button"
                      className="history-conversation-action"
                      disabled={
                        readOnly || conversationActionPending === item.sessionId
                      }
                      aria-label={t(
                        `Archive ${item.title} conversation`,
                        `${item.title} sohbetini arşivle`,
                      )}
                      title={t('Archive conversation', 'Sohbeti arşivle')}
                      onClick={() => onArchiveConversation(item)}
                    >
                      ↓
                    </button>
                  </div>
                ))}
                {groupedSessions.length === 0 ? (
                  <p>{t('No conversations yet.', 'Henüz konuşma yok.')}</p>
                ) : null}
              </div>
            </details>
          )
        })}
        {archivedFolders.length ? (
          <details className="archived-folders">
            <summary>
              {t('Archived folders', 'Arşivlenenler')} ·{' '}
              {archivedFolders.length}
            </summary>
            {archivedFolders.map((folder) => {
              const groupedSessions = sessions.filter(
                (item) => item.folderId === folder.folderId,
              )
              return (
                <div className="archived-folder" key={folder.folderId}>
                  <div>
                    <strong>{folder.name}</strong>
                    <small>
                      {groupedSessions.length} {t('conversations', 'sohbet')}
                    </small>
                  </div>
                  <button
                    type="button"
                    disabled={
                      readOnly || folderActionPending === folder.folderId
                    }
                    onClick={() => onRestoreFolder(folder)}
                  >
                    {t('Restore', 'Geri al')}
                  </button>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={
                      readOnly || folderActionPending === folder.folderId
                    }
                    onClick={() => onDeleteFolder(folder)}
                  >
                    {t('Delete', 'Sil')}
                  </button>
                </div>
              )
            })}
          </details>
        ) : null}
        {archivedSessions.length ? (
          <details className="archived-conversations">
            <summary>
              {t('Archived conversations', 'Arşivlenen sohbetler')} ·{' '}
              {archivedSessions.length}
            </summary>
            {archivedSessions.map((item) => (
              <div className="archived-conversation" key={item.sessionId}>
                <button
                  type="button"
                  onClick={() => onSelectConversation(item.sessionId)}
                >
                  <span>{item.title}</span>
                  <small>{item.status}</small>
                </button>
                <button
                  type="button"
                  disabled={
                    readOnly || conversationActionPending === item.sessionId
                  }
                  onClick={() => onRestoreConversation(item)}
                >
                  {t('Restore', 'Geri al')}
                </button>
              </div>
            ))}
          </details>
        ) : null}
      </div>
      {footer ? <div className="history-footer">{footer}</div> : null}
    </section>
  )
}

export function readStoredProviderSelection(): {
  provider: 'codex' | 'claude' | 'gemini' | 'cursor'
  modelId: string
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
} {
  return parseStoredProviderSelection(
    typeof window === 'undefined'
      ? null
      : window.localStorage.getItem('provider-selection-v1'),
  )
}

export function parseStoredProviderSelection(raw: string | null): {
  provider: 'codex' | 'claude' | 'gemini' | 'cursor'
  modelId: string
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
} {
  const fallback = {
    provider: 'codex' as const,
    modelId: '',
    effort: 'medium' as const,
  }
  if (!raw) return fallback
  try {
    const saved = JSON.parse(raw) as Record<string, unknown> | null
    const providers = ['codex', 'claude', 'gemini', 'cursor'] as const
    const efforts = [
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ] as const
    return saved &&
      providers.includes(saved.provider as (typeof providers)[number]) &&
      typeof saved.modelId === 'string' &&
      efforts.includes(saved.effort as (typeof efforts)[number])
      ? {
          provider: saved.provider as (typeof providers)[number],
          modelId: saved.modelId,
          effort: saved.effort as (typeof efforts)[number],
        }
      : fallback
  } catch {
    return fallback
  }
}

export function providerPickerSelection(
  provider: 'codex' | 'claude' | 'gemini' | 'cursor',
  models: Array<{
    modelId: string
    isDefault: boolean
    hidden: boolean
    defaultReasoningEffort:
      'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  }> = [],
) {
  const model = models.find((entry) => entry.isDefault && !entry.hidden)
  return provider === 'codex'
    ? { modelId: '', effort: 'medium' as const }
    : {
        modelId: model?.modelId ?? '',
        effort: model?.defaultReasoningEffort ?? ('none' as const),
      }
}

export function providerAuthMessage(
  provider: 'claude' | 'gemini' | 'cursor',
  authStatus: 'ready' | 'required' | 'unknown',
  instruction?: string | null,
) {
  if (authStatus === 'required')
    return `${provider} login gerekli. ${instruction ?? ''}`
  if (authStatus === 'unknown')
    return provider === 'gemini'
      ? localize(
          'Gemini authentication cannot be verified with a safe probe. Run a real smoke test; retry capacity errors later.',
          'Gemini auth durumu güvenli bir probe ile doğrulanamıyor. Gerçek smoke çalıştırın; capacity hatasında daha sonra yeniden deneyin.',
        )
      : localize(
          `${provider} authentication cannot be verified with a safe probe. Run a real smoke test.`,
          `${provider} auth durumu güvenli bir probe ile doğrulanamıyor. Gerçek smoke çalıştırın.`,
        )
  return localize(
    `${provider} authentication is ready.`,
    `${provider} auth hazır.`,
  )
}

export function conversationFolderPickerState({
  sessionFolderId,
  selectedFolderId,
  online,
}: {
  sessionFolderId: string | null | undefined
  selectedFolderId: string | null
  online: boolean
}) {
  return {
    value: sessionFolderId ?? selectedFolderId ?? '',
    disabled: !online,
  }
}

export function WorkspacePage({ sessionId }: { sessionId?: string }) {
  const t = useTranslations()
  const navigate = useNavigate()
  const online = useOnlineStatus()
  const meta = useQuery({
    queryKey: ['platform-meta'],
    queryFn: readPlatformMeta,
    enabled: online,
  })
  const identity = useQuery({
    queryKey: ['identity', cacheNamespace],
    queryFn: readMe,
    enabled: online,
    retry: false,
  })
  const readiness = useQuery({
    queryKey: ['readiness', cacheNamespace],
    queryFn: () => readReadiness(),
    enabled: online && identity.isSuccess,
    refetchInterval: (query) =>
      query.state.data?.status === 'ready' ? false : 5_000,
  })
  const authReady = readiness.data?.status === 'ready'
  const contentKeySession = useQuery({
    queryKey: ['content-key-session', cacheNamespace],
    queryFn: () => readContentKeySession(apiBaseUrl, scopeHeaders),
    enabled: online && identity.isSuccess && Boolean(storedAuth?.username),
    retry: false,
  })
  const contentKeyLocked = contentKeySession.data?.contentKeyUnlocked === false
  const providerCatalogs = useQuery({
    queryKey: ['provider-catalogs', cacheNamespace],
    queryFn: readProviderCatalogs,
    enabled: online && identity.isSuccess,
    staleTime: 60_000,
  })
  const recentSessions = useInfiniteQuery({
    queryKey: ['recent-sessions', cacheNamespace],
    queryFn: ({ pageParam }) => readRecentSessions(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: online && identity.isSuccess,
  })
  const archivedSessions = useQuery({
    queryKey: ['archived-sessions', cacheNamespace],
    queryFn: () => readRecentSessions(null, true),
    enabled: online && identity.isSuccess,
  })
  const [offlineHistory, setOfflineHistory] = useState<OfflineHistorySession[]>(
    [],
  )
  const [offlineMessages, setOfflineMessages] = useState<ConversationMessage[]>(
    [],
  )
  const conversationFolders = useQuery({
    queryKey: ['conversation-folders', cacheNamespace],
    queryFn: readConversationFolders,
    enabled: online && identity.isSuccess,
  })
  const sharedFolders = useQuery({
    queryKey: ['shared-folders', cacheNamespace],
    queryFn: readSharedFolders,
    enabled: online && identity.isSuccess,
    staleTime: 0,
  })
  const [managedFolderId, setManagedFolderId] = useState<string>()
  const managedFolder = sharedFolders.data?.folders.find(
    (entry) => entry.folder.folderId === managedFolderId,
  )
  const folderMembers = useQuery({
    queryKey: ['shared-folder-members', cacheNamespace, managedFolderId],
    queryFn: () => readFolderMembers(managedFolderId!),
    enabled:
      online && managedFolder?.membership.role === 'owner' && !!managedFolderId,
    retry: false,
  })
  const sources = useQuery({
    queryKey: ['corpus-sources', cacheNamespace],
    queryFn: readSources,
    enabled: online && identity.isSuccess,
    refetchInterval: (query) =>
      query.state.data?.sources.some((source) =>
        ['pending', 'extracting'].includes(source.status),
      )
        ? 1_000
        : false,
  })
  const gitSnapshots = useQuery({
    queryKey: ['git-snapshots', cacheNamespace, sessionId],
    queryFn: () => readGitSnapshots(sessionId!),
    enabled: Boolean(sessionId) && online && identity.isSuccess,
  })
  const audit = useInfiniteQuery({
    queryKey: ['session-audit', cacheNamespace, sessionId],
    queryFn: ({ pageParam }) => readAudit(sessionId!, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(sessionId) && online && identity.isSuccess,
    staleTime: 30_000,
  })
  const supportGrants = useQuery({
    queryKey: ['support-grants', cacheNamespace, sessionId],
    queryFn: () => readSupportGrants(sessionId!),
    enabled: Boolean(sessionId) && online && identity.isSuccess,
    staleTime: 10_000,
  })
  const supportAudit = useQuery({
    queryKey: ['support-audit', cacheNamespace, sessionId],
    queryFn: () => readSupportAudit(sessionId!),
    enabled: Boolean(sessionId) && online && identity.isSuccess,
    staleTime: 10_000,
  })
  const [session, setSession] = useState<SessionResponse>()
  const [events, setEvents] = useState<Map<string, TimelineEvent>>(new Map())
  const [sessionPending, setSessionPending] = useState(false)
  const [turnPending, setTurnPending] = useState(false)
  const [gitRefreshPending, setGitRefreshPending] = useState(false)
  const [gitError, setGitError] = useState<string>()
  const [error, setError] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')
  const [unlockPending, setUnlockPending] = useState(false)
  const [unlockError, setUnlockError] = useState<string>()
  const [realtimeState, setRealtimeState] = useState('kapalı')
  const realtimeLabel =
    {
      kapalı: t('off', 'kapalı'),
      bağlanıyor: t('connecting', 'bağlanıyor'),
      canlı: t('live', 'canlı'),
      'yeniden eşitleniyor': t('resynchronizing', 'yeniden eşitleniyor'),
      'erişim kaldırıldı': t('access revoked', 'erişim kaldırıldı'),
      'yeniden bağlanıyor': t('reconnecting', 'yeniden bağlanıyor'),
    }[realtimeState] ?? realtimeState
  const [inviteTokenFromLocation, setInviteTokenFromLocation] = useState<
    string | null
  >(null)
  const [approvals, setApprovals] = useState<Map<string, Approval>>(new Map())
  const [approvalPending, setApprovalPending] = useState<string>()
  const [approvalErrors, setApprovalErrors] = useState<Map<string, string>>(
    new Map(),
  )
  const deepLinkedApprovalId = locationScope?.get('approval') ?? undefined
  const [readOnly, setReadOnly] = useState(false)
  const [masterExpanded, setMasterExpanded] = useState(true)
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderPending, setFolderPending] = useState(false)
  const [sharedFolderName, setSharedFolderName] = useState('')
  const [sharingPending, setSharingPending] = useState(false)
  const [invitationToken, setInvitationToken] = useState<string>()
  const [folderAccessLost, setFolderAccessLost] = useState(false)

  useEffect(() => {
    setInviteTokenFromLocation(
      new URLSearchParams(window.location.search).get('invite'),
    )
  }, [])
  const [folderActionPending, setFolderActionPending] = useState<string>()
  const [conversationActionPending, setConversationActionPending] =
    useState<string>()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [providerSheetOpen, setProviderSheetOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [supportAccessOpen, setSupportAccessOpen] = useState(false)
  const [attachments, setAttachments] = useState<ConversationAttachment[]>([])
  const [attachmentPending, setAttachmentPending] = useState(false)
  const [sourcePending, setSourcePending] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<
    'codex' | 'claude' | 'gemini' | 'cursor'
  >('codex')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [selectedEffort, setSelectedEffort] = useState<
    'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  >('medium')
  const [providerSelectionHydrated, setProviderSelectionHydrated] =
    useState(false)

  const syncedHistory = useMemo(
    () => recentSessions.data?.pages.flatMap((page) => page.sessions) ?? [],
    [recentSessions.data],
  )
  const historySessions: HistorySession[] = syncedHistory.length
    ? syncedHistory
    : online
      ? []
      : offlineHistory
  const archivedHistorySessions: HistorySession[] =
    archivedSessions.data?.sessions ?? []

  useEffect(() => {
    setOfflineHistory(
      parseOfflineHistory(
        window.localStorage.getItem(offlineHistoryKey(cacheNamespace)),
      ),
    )
  }, [online])

  useEffect(() => {
    const stored = readStoredProviderSelection()
    setSelectedProvider(stored.provider)
    setSelectedModelId(stored.modelId)
    setSelectedEffort(stored.effort)
    setProviderSelectionHydrated(true)
  }, [])

  useEffect(() => {
    if (!providerSelectionHydrated || !providerCatalogs.data) return
    if (selectedProvider === 'codex' && selectedModelId === '') return
    const catalog = providerCatalogs.data.catalogs.find(
      (entry) => entry.identity.provider === selectedProvider,
    )
    if (!catalog) return
    const selected = catalog.models.find(
      (model) => model.modelId === selectedModelId && !model.hidden,
    )
    if (!selected) {
      const fallback = providerPickerSelection(selectedProvider, catalog.models)
      setSelectedModelId(fallback.modelId)
      setSelectedEffort(fallback.effort)
      return
    }
    if (!selected.reasoningEfforts.includes(selectedEffort))
      setSelectedEffort(selected.defaultReasoningEffort)
  }, [
    providerCatalogs.data,
    providerSelectionHydrated,
    selectedEffort,
    selectedModelId,
    selectedProvider,
  ])

  useEffect(() => {
    if (!syncedHistory.length) return
    const minimized: OfflineHistorySession[] = syncedHistory
      .slice(0, 24)
      .map((item) => ({
        sessionId: item.sessionId,
        title: item.title,
        status: item.status,
        provider: item.provider,
        resolvedModel: item.resolvedModel,
        reasoningEffort: item.reasoningEffort,
        folderId: null,
        archivedAt: null,
        updatedAt: item.updatedAt,
      }))
    setOfflineHistory(minimized)
    window.localStorage.setItem(
      offlineHistoryKey(cacheNamespace),
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        sessions: minimized,
      }),
    )
  }, [syncedHistory])

  useEffect(() => {
    if (!sessionId) {
      setOfflineMessages([])
      return
    }
    setOfflineMessages(
      parseOfflineConversation(
        window.localStorage.getItem(
          offlineConversationKey(cacheNamespace, sessionId),
        ),
        sessionId,
      )?.messages ?? [],
    )
  }, [online, sessionId])

  useEffect(() => {
    if (!providerSelectionHydrated) return
    window.localStorage.setItem(
      'provider-selection-v1',
      JSON.stringify({
        provider: selectedProvider,
        modelId: selectedModelId,
        effort: selectedEffort,
      }),
    )
  }, [
    providerSelectionHydrated,
    selectedEffort,
    selectedModelId,
    selectedProvider,
  ])
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
    if (!sessionId || !online) return
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
  }, [online, sessionId])

  useEffect(() => {
    if (!session) return
    let active = true
    let accessRevoked = false
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
      // WP38: kök-mutlak path apiBaseUrl'deki base'i düşürür — string birleştir.
      const url = new URL(`${apiBaseUrl}/v1/realtime`)
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
            ...(runtimeAccessToken()
              ? { accessToken: runtimeAccessToken()! }
              : {}),
          }),
        )
      })
      socket.addEventListener('message', (message) => {
        let value: unknown
        try {
          value = JSON.parse(String(message.data))
        } catch {
          setError(
            t('Realtime sent invalid JSON', 'Realtime geçersiz JSON gönderdi'),
          )
          return
        }
        const parsed = serverMessageSchema.safeParse(value)
        if (!parsed.success) return
        if (parsed.data.type === 'replay') apply(parsed.data.events)
        if (parsed.data.type === 'event') apply([parsed.data.event])
        if (
          parsed.data.type === 'subscribed' ||
          (parsed.data.type === 'event' &&
            parsed.data.event.type === 'turn.completed')
        )
          void readSessionDetail(session.sessionId).then((loaded) => {
            if (active && loaded) setSession(loaded)
          })
        if (
          parsed.data.type === 'event' &&
          parsed.data.event.type === 'turn.completed'
        )
          void recentSessions.refetch()
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
        if (parsed.data.type === 'error') {
          setError(parsed.data.message)
          if (parsed.data.code === 'ACCESS_REVOKED') {
            accessRevoked = true
            setFolderAccessLost(true)
            setReadOnly(true)
            void Promise.all([
              sharedFolders.refetch(),
              recentSessions.refetch(),
              sources.refetch(),
            ])
          }
        }
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
        setRealtimeState(
          accessRevoked ? 'erişim kaldırıldı' : 'yeniden bağlanıyor',
        )
        if (active && !accessRevoked) reconnectTimer = setTimeout(connect, 750)
      })
    }
    connect()
    return () => {
      active = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [session?.sessionId])

  useEffect(() => {
    if (!deepLinkedApprovalId || !session) return
    const approval = approvals.get(deepLinkedApprovalId)
    if (!approval) return
    const element = document.getElementById(`approval-${deepLinkedApprovalId}`)
    element?.scrollIntoView({ block: 'center' })
    element?.focus({ preventScroll: true })
  }, [approvals, deepLinkedApprovalId, session])

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
  const displayedChatFeed =
    chatFeed.length > 0 || online ? chatFeed : offlineMessages

  useEffect(() => {
    if (!online || !sessionId) return
    const messages = chatFeed
      .filter(
        (item): item is ConversationMessage =>
          item.role === 'user' || item.role === 'assistant',
      )
      .slice(-200)
      .map(({ key, role, text, sequence, turnId }) => ({
        key,
        role,
        text,
        sequence,
        ...(turnId ? { turnId } : {}),
      }))
    if (!messages.length) return
    setOfflineMessages(messages)
    window.localStorage.setItem(
      offlineConversationKey(cacheNamespace, sessionId),
      JSON.stringify({
        version: 1,
        sessionId,
        savedAt: new Date().toISOString(),
        messages,
      } satisfies OfflineConversationSnapshot),
    )
  }, [chatFeed, online, sessionId])
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
    return (
      active ||
      session?.activeRun?.status === 'queued' ||
      session?.activeRun?.status === 'running' ||
      session?.activeRun?.status === 'interrupting'
    )
  }, [events, session?.activeRun?.status])
  const usage = useQuery({
    queryKey: ['session-usage', cacheNamespace, sessionId],
    queryFn: () => readUsage(sessionId!),
    enabled: Boolean(sessionId) && online && identity.isSuccess,
    staleTime: turnActive ? 0 : 5_000,
    refetchInterval: turnActive ? 2_000 : false,
  })
  const usageDisplay = formatUsageCost(usage.data?.total)
  const billing = useQuery({
    queryKey: ['workspace-billing', cacheNamespace, workspaceId, sessionId],
    queryFn: () => readBilling(sessionId!),
    enabled: Boolean(sessionId) && online && identity.isSuccess,
    staleTime: turnActive ? 0 : 5_000,
    refetchInterval: turnActive ? 2_000 : false,
  })
  const billingFinancial = useQuery({
    queryKey: ['workspace-billing-financial', cacheNamespace, workspaceId],
    queryFn: readBillingFinancial,
    enabled: Boolean(sessionId) && online && identity.isSuccess,
    staleTime: 5_000,
    retry: false,
  })
  const offlineSelected = offlineHistory.find(
    (item) => item.sessionId === sessionId,
  )

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
  }, [displayedChatFeed])

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
  }, [displayedChatFeed.length > 0, sessionId])

  const selectedCatalog = providerCatalogs.data?.catalogs.find(
    (catalog) => catalog.identity.provider === selectedProvider,
  )
  const selectedModel = selectedModelId
    ? selectedCatalog?.models.find((model) => model.modelId === selectedModelId)
    : selectedCatalog?.models.find((model) => model.isDefault && !model.hidden)
  const availableEfforts =
    selectedModel?.reasoningEfforts ??
    (selectedProvider === 'codex'
      ? (['low', 'medium', 'high', 'xhigh'] as const)
      : [])
  const capabilityWarnings = selectedModel
    ? Object.entries(selectedModel.capabilities).flatMap(
        ([capability, support]) =>
          support === 'supported' ||
          !['commandExecution', 'fileChanges', 'approvals'].includes(capability)
            ? []
            : [
                capability === 'approvals'
                  ? localize(
                      'No native approval flow',
                      'Native approval akışı yok',
                    )
                  : capability === 'commandExecution'
                    ? localize(
                        'Limited command support',
                        'Komut desteği sınırlı',
                      )
                    : localize(
                        'Limited file-change support',
                        'Dosya değişikliği desteği sınırlı',
                      ),
              ],
      )
    : []
  const selectedProviderReadiness =
    providerCatalogs.data?.readiness[selectedProvider]
  const folderPicker = conversationFolderPickerState({
    sessionFolderId: session?.folderId,
    selectedFolderId,
    online,
  })

  function beginConversationDraft(folderId = selectedFolderId) {
    setSelectedFolderId(folderId)
    closeHistoryOverlay()
    void recentSessions.refetch()
    if (!sessionId) return
    lastSequence.current = 0
    setEvents(new Map())
    setSession(undefined)
    setApprovals(new Map())
    setPrompt('')
    setAttachments([])
    setReadOnly(false)
    setError(undefined)
    void navigate({ to: '/' })
  }

  async function provisionSession(folderId = selectedFolderId) {
    const body = JSON.stringify({
      folderId,
      provider: selectedProvider,
      model: selectedModelId
        ? { modelId: selectedModelId, reasoningEffort: selectedEffort }
        : { alias: 'sol', reasoningEffort: selectedEffort },
    })
    const response = await fetch(`${apiBaseUrl}/v1/sessions`, {
      method: 'POST',
      headers: scopeHeaders,
      body,
      keepalive: true,
    })
    if (!response.ok) throw await apiError(response)
    const created = sessionResponseSchema.parse(await response.json())
    lastSequence.current = 0
    setEvents(new Map())
    setSession(created)
    setReadOnly(false)
    return created
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

  async function createSharedFolder() {
    const name = sharedFolderName.trim()
    if (!name || sharingPending) return
    setSharingPending(true)
    setError(undefined)
    try {
      const response = await fetch(`${apiBaseUrl}/v1/folders`, {
        method: 'POST',
        headers: scopeHeaders,
        body: JSON.stringify({ schemaVersion: 1, name }),
      })
      if (!response.ok) throw await apiError(response)
      const body = (await response.json()) as { folder: unknown }
      const folder = sharedFolderSchema.parse(body.folder)
      setManagedFolderId(folder.folderId)
      setSelectedFolderId(folder.folderId)
      setSharedFolderName('')
      await sharedFolders.refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSharingPending(false)
    }
  }

  async function createShareInvitation(folder: SharedFolder) {
    setSharingPending(true)
    setInvitationToken(undefined)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/folders/${encodeURIComponent(folder.folderId)}/invitations`,
        {
          method: 'POST',
          headers: scopeHeaders,
          body: JSON.stringify({
            schemaVersion: 1,
            role: 'viewer',
            expiresInSeconds: 86_400,
          }),
        },
      )
      if (!response.ok) throw await apiError(response)
      const created = createFolderInvitationResponseSchema.parse(
        await response.json(),
      )
      setInvitationToken(created.token)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSharingPending(false)
    }
  }

  async function acceptShareInvitation() {
    const token = inviteTokenFromLocation
    if (!token || sharingPending) return
    setSharingPending(true)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/folder-invitations/accept`,
        {
          method: 'POST',
          headers: scopeHeaders,
          body: JSON.stringify({ schemaVersion: 1, token }),
        },
      )
      if (!response.ok) throw await apiError(response)
      const accepted = acceptFolderInvitationResponseSchema.parse(
        await response.json(),
      )
      setManagedFolderId(accepted.membership.folderId)
      setSelectedFolderId(accepted.membership.folderId)
      setFolderAccessLost(false)
      await sharedFolders.refetch()
      const url = new URL(window.location.href)
      url.searchParams.delete('invite')
      window.history.replaceState({}, '', url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSharingPending(false)
    }
  }

  async function changeSharedFolderRole(
    member: FolderMembership,
    role: FolderMembership['role'],
  ) {
    const response = await fetch(
      `${apiBaseUrl}/v1/folders/${encodeURIComponent(member.folderId)}/members/${encodeURIComponent(member.principalId)}`,
      {
        method: 'PATCH',
        headers: scopeHeaders,
        body: JSON.stringify({
          schemaVersion: 1,
          role,
          expectedVersion: member.version,
        }),
      },
    )
    if (!response.ok) throw await apiError(response)
    folderMembershipSchema.parse(await response.json())
    await Promise.all([folderMembers.refetch(), sharedFolders.refetch()])
  }

  async function revokeSharedFolderMember(member: FolderMembership) {
    const response = await fetch(
      `${apiBaseUrl}/v1/folders/${encodeURIComponent(member.folderId)}/members/${encodeURIComponent(member.principalId)}`,
      {
        method: 'DELETE',
        headers: scopeHeaders,
        body: JSON.stringify({
          schemaVersion: 1,
          expectedVersion: member.version,
        }),
      },
    )
    if (!response.ok) throw await apiError(response)
    folderMembershipSchema.parse(await response.json())
    await folderMembers.refetch()
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

  async function setConversationArchived(
    conversation: HistorySession,
    archived: boolean,
  ) {
    setConversationActionPending(conversation.sessionId)
    setError(undefined)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/sessions/${encodeURIComponent(conversation.sessionId)}/archive`,
        {
          method: 'POST',
          headers: scopeHeaders,
          body: JSON.stringify({ archived }),
        },
      )
      if (!response.ok) throw await apiError(response)
      sessionResponseSchema.parse(await response.json())
      if (archived && conversation.sessionId === sessionId)
        beginConversationDraft()
      await Promise.all([recentSessions.refetch(), archivedSessions.refetch()])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setConversationActionPending(undefined)
    }
  }

  async function deleteFolder(folder: ConversationFolder) {
    if (
      !window.confirm(
        t(
          `Delete the “${folder.name}” folder? Its conversations will be preserved and moved to “No folder”.`,
          `“${folder.name}” folder'ı silinsin mi? İçindeki sohbetler korunup “Folder yok” grubuna taşınacak.`,
        ),
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
    return current ?? session?.activeRun?.turnId ?? undefined
  }, [events, session?.activeRun?.turnId])

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

  async function submitTurn() {
    const trimmed = prompt.trim()
    if (contentKeyLocked) return
    if (
      turnSubmitBlocked({
        session,
        prompt,
        attachmentCount: attachments.length,
        turnPending,
        turnActive,
        online,
        authReady,
        selectedProvider,
      })
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
      const activeSession = session ?? (await provisionSession())
      const body = JSON.stringify({
        prompt: trimmed,
        attachmentIds: attachments.map((attachment) => attachment.attachmentId),
      })
      const response = await fetch(
        `${apiBaseUrl}/v1/sessions/${activeSession.sessionId}/turns`,
        {
          method: 'POST',
          headers: { ...scopeHeaders, 'idempotency-key': crypto.randomUUID() },
          body,
          keepalive: new TextEncoder().encode(body).byteLength <= 60_000,
        },
      )
      if (!response.ok) throw await apiError(response)
      turnAcceptedResponseSchema.parse(await response.json())
      void recentSessions.refetch()
      if (!sessionId)
        await navigate({
          to: '/sessions/$sessionId',
          params: { sessionId: activeSession.sessionId },
        })
      setPrompt('')
      setAttachments([])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      if (
        cause instanceof Error &&
        (cause.message.includes('secure content key is locked') ||
          cause.message.includes('Güvenli içerik anahtarı kilitli'))
      )
        void contentKeySession.refetch()
    } finally {
      setTurnPending(false)
    }
  }

  async function unlockContentKey(event: React.FormEvent) {
    event.preventDefault()
    setUnlockPending(true)
    setUnlockError(undefined)
    try {
      await unlockStoredContentKey(apiBaseUrl, scopeHeaders, unlockPassword)
      const refreshed = await contentKeySession.refetch()
      if (refreshed.data?.contentKeyUnlocked !== true)
        throw new Error(
          t(
            'Could not verify content-key status.',
            'İçerik anahtarı durumu doğrulanamadı.',
          ),
        )
      setUnlockPassword('')
      setError(undefined)
    } catch (cause) {
      setUnlockError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setUnlockPending(false)
    }
  }

  async function uploadAttachments(files: FileList | null) {
    if (!files?.length || attachmentPending) return
    const selected = [...files]
    setAttachmentPending(true)
    setError(undefined)
    try {
      const activeSession = session ?? (await provisionSession())
      const uploaded = await Promise.all(
        selected.map(async (file) => {
          const mediaType = attachmentMediaType(file)
          if (!mediaType)
            throw new Error(
              t(
                `${file.name}: unsupported file type`,
                `${file.name}: desteklenmeyen dosya türü`,
              ),
            )
          if (file.size < 1)
            throw new Error(
              t(
                `${file.name}: file must not be empty`,
                `${file.name}: dosya boş olmamalı`,
              ),
            )
          const response = await fetch(
            `${apiBaseUrl}/v1/sessions/${encodeURIComponent(activeSession.sessionId)}/attachments`,
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

  async function uploadSource(file: File) {
    const mediaType = sourceMediaType(file)
    if (!mediaType || sourcePending || !online) return
    setSourcePending(true)
    setError(undefined)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/sources`,
        {
          method: 'POST',
          headers: {
            ...scopeHeaders,
            'content-type': 'application/octet-stream',
            'x-source-name': encodeURIComponent(file.name),
            'x-source-media-type': mediaType,
            ...(selectedFolderId?.startsWith('fld_')
              ? { 'x-folder-id': selectedFolderId }
              : {}),
          },
          body: file,
        },
      )
      if (!response.ok) throw await apiError(response)
      await sources.refetch()
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : t('Could not upload source', 'Source yüklenemedi'),
      )
    } finally {
      setSourcePending(false)
    }
  }

  return (
    <main className="workspace-shell" data-session-id={sessionId}>
      {identity.isPending && online ? (
        <p className="offline-banner" role="status">
          {t(
            'Verifying identity and organization membership…',
            'Kimlik ve organization üyelikleri doğrulanıyor…',
          )}
        </p>
      ) : null}
      {identity.isError && online ? (
        <p className="offline-banner" role="alert">
          {t(
            'Your session has expired or access to this organization was denied.',
            'Oturum süresi dolmuş veya bu organization için erişim yasaklanmış.',
          )}{' '}
          <a href={withBase('/login')}>
            {t('Sign in again', 'Yeniden giriş yapın')}
          </a>
          .
        </p>
      ) : null}
      {folderAccessLost ? (
        <p className="offline-banner access-lost" role="alert">
          {t(
            'Your access to this folder was removed. The local view was cleared; returning to the secure folder list.',
            'Bu klasöre erişimin kaldırıldı. Yerel görünüm temizlendi; güvenli klasör listesine dönülüyor.',
          )}
        </p>
      ) : null}
      {inviteTokenFromLocation ? (
        <div
          className="invite-accept-banner"
          role="region"
          aria-label={t('Folder invitation', 'Klasör daveti')}
        >
          <span>
            {t(
              'You have a secure folder invitation.',
              'Güvenli klasör davetin var.',
            )}
          </span>
          <button
            type="button"
            disabled={!online || sharingPending}
            onClick={() => void acceptShareInvitation()}
          >
            {sharingPending ? 'Kabul ediliyor…' : 'Daveti kabul et'}
          </button>
        </div>
      ) : null}
      {!online ? (
        <p className="offline-banner" role="status">
          {t(
            'Offline · Showing the last synchronized conversation history as read-only. New prompts will not be queued.',
            'Çevrimdışı · Son senkronize conversation history read-only gösteriliyor. Yeni prompt kuyruğa alınmaz.',
          )}
        </p>
      ) : null}
      <header className="topbar">
        <div>
          <p className="eyebrow">
            {t('PHASE 0 · LIVE CODEX STREAM', 'FAZ 0 · CANLI CODEX AKIŞI')}
          </p>
          <h1>Perseverance</h1>
          {identity.data ? (
            <label>
              Organization
              <select
                aria-label="Organization"
                value={identity.data.activeOrganizationId}
                onChange={(event) => {
                  const membership = identity.data.memberships.find(
                    (item) =>
                      item.organizationId === event.target.value &&
                      item.status === 'active',
                  )
                  if (!membership) return
                  const url = new URL(window.location.href)
                  url.searchParams.set(
                    'organization',
                    membership.organizationId,
                  )
                  url.searchParams.set(
                    'workspace',
                    membership.workspaceIds[0] ?? workspaceId,
                  )
                  window.location.assign(url)
                }}
              >
                {identity.data.memberships
                  .filter((membership) => membership.status === 'active')
                  .map((membership) => (
                    <option
                      key={membership.organizationId}
                      value={membership.organizationId}
                    >
                      {membership.organizationId} · {membership.role}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
        </div>
        <PushNotificationControl
          apiBaseUrl={apiBaseUrl}
          headers={scopeHeaders}
          namespace={cacheNamespace}
          online={online && identity.isSuccess}
        />
        <button
          type="button"
          className="signout-button"
          onClick={() => void signOut(apiBaseUrl)}
        >
          {t('Exit', 'Çıkış')}{' '}
          <span suppressHydrationWarning>
            ({storedAuth?.username ?? 'oturum'})
          </span>
        </button>
        <div className={`status-pill status-${meta.status}`}>
          <span className="status-dot" aria-hidden="true" />
          {!online
            ? t('Offline', 'Çevrimdışı')
            : meta.isSuccess
              ? t('Control plane connected', 'Control plane bağlı')
              : 'Control plane bekleniyor'}
        </div>
      </header>

      <section
        className={`workspace-grid ${historyOpen ? 'history-is-open' : ''}`}
      >
        <aside className={`project-panel ${historyOpen ? 'is-open' : ''}`}>
          <ConversationHistory
            folders={conversationFolders.data?.folders ?? []}
            sessions={historySessions}
            archivedSessions={archivedHistorySessions}
            {...(sessionId ? { activeSessionId: sessionId } : {})}
            folderName={folderName}
            folderPending={folderPending}
            readOnly={!online}
            {...(folderActionPending ? { folderActionPending } : {})}
            {...(conversationActionPending
              ? { conversationActionPending }
              : {})}
            onFolderNameChange={setFolderName}
            onCreateFolder={() => void createFolder()}
            onSelectFolder={setSelectedFolderId}
            onArchiveConversation={(conversation) =>
              void setConversationArchived(conversation, true)
            }
            onRestoreConversation={(conversation) =>
              void setConversationArchived(conversation, false)
            }
            onArchiveFolder={(folder) => void setFolderArchived(folder, true)}
            onRestoreFolder={(folder) => void setFolderArchived(folder, false)}
            onDeleteFolder={(folder) => void deleteFolder(folder)}
            onClose={() => setHistoryOpen(false)}
            onNewConversation={(folderId) => {
              beginConversationDraft(folderId)
            }}
            onSelectConversation={(selectedSessionId) => {
              closeHistoryOverlay()
              void navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: selectedSessionId },
              })
            }}
            footer={
              <div className="history-profile">
                <span aria-hidden="true" suppressHydrationWarning>
                  {(storedAuth?.username ?? 'K').slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong suppressHydrationWarning>
                    {storedAuth?.username ?? t('user', 'kullanıcı')}
                  </strong>
                  <small suppressHydrationWarning>
                    {workspaceId} · {tenantId}
                  </small>
                </div>
                <button
                  type="button"
                  aria-label={t('Settings and usage', 'Ayarlar ve kullanım')}
                  onClick={() => {
                    setHistoryOpen(false)
                    setSettingsOpen(true)
                  }}
                >
                  ☷
                </button>
                <button type="button" onClick={() => void signOut(apiBaseUrl)}>
                  {t('SIGN OUT', 'ÇIKIŞ')}
                </button>
              </div>
            }
            tools={
              <>
                <button
                  className="history-tool-button"
                  type="button"
                  onClick={() => setSourcesOpen(true)}
                >
                  <span>▤ Sources</span>
                  <small>{sources.data?.sources.length ?? 0}</small>
                </button>
                {session ? (
                  <button
                    className="history-tool-button"
                    type="button"
                    onClick={() => setSupportAccessOpen(true)}
                  >
                    <span>{t('Support access', 'Support erişimi')}</span>
                    <small>
                      {supportGrants.data?.filter(
                        (grant) => grant.status === 'active',
                      ).length ?? 0}{' '}
                      aktif
                    </small>
                  </button>
                ) : null}
              </>
            }
          />
          <section
            className="shared-folder-panel"
            aria-label={t('Shared folders', 'Paylaşımlı klasörler')}
          >
            <div className="shared-folder-heading">
              <div>
                <p className="section-label">
                  {t('Secure sharing', 'Güvenli paylaşım')}
                </p>
                <h2>{t('Shared folders', 'Paylaşımlı klasörler')}</h2>
              </div>
              <span>{sharedFolders.data?.folders.length ?? 0}</span>
            </div>
            <form
              className="shared-folder-create"
              onSubmit={(event) => {
                event.preventDefault()
                void createSharedFolder()
              }}
            >
              <input
                aria-label={t(
                  'New shared folder name',
                  'Yeni paylaşımlı klasör adı',
                )}
                value={sharedFolderName}
                maxLength={80}
                disabled={!online || sharingPending}
                onChange={(event) => setSharedFolderName(event.target.value)}
                placeholder={t('Private folder', 'Özel klasör')}
              />
              <button
                type="submit"
                disabled={!sharedFolderName.trim() || !online || sharingPending}
              >
                {t('Create', 'Oluştur')}
              </button>
            </form>
            <ul className="shared-folder-list">
              {(sharedFolders.data?.folders ?? []).map((entry) => (
                <li key={entry.folder.folderId}>
                  <button
                    type="button"
                    className={
                      managedFolderId === entry.folder.folderId
                        ? 'is-selected'
                        : ''
                    }
                    onClick={() => {
                      setManagedFolderId(entry.folder.folderId)
                      setSelectedFolderId(entry.folder.folderId)
                    }}
                  >
                    <span>{entry.folder.name}</span>
                    <small>{entry.membership.role}</small>
                  </button>
                  {entry.membership.role === 'owner' ? (
                    <button
                      type="button"
                      className="share-folder-button"
                      disabled={sharingPending}
                      onClick={() => void createShareInvitation(entry.folder)}
                    >
                      {t('Share', 'Paylaş')}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {invitationToken ? (
              <div className="invite-token" role="status">
                <strong>
                  {t('Single-use invitation', 'Tek kullanımlık davet')}
                </strong>
                <code>{invitationToken}</code>
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      `${window.location.origin}${window.location.pathname}?organization=${encodeURIComponent(tenantId)}&workspace=${encodeURIComponent(workspaceId)}&invite=${encodeURIComponent(invitationToken)}`,
                    )
                  }
                >
                  {t('Copy link', 'Bağlantıyı kopyala')}
                </button>
              </div>
            ) : null}
            {managedFolder?.membership.role === 'owner' ? (
              <ul
                className="shared-member-list"
                aria-label={t('Folder members', 'Klasör üyeleri')}
              >
                {(folderMembers.data?.members ?? []).map((member) => (
                  <li key={member.principalId}>
                    <span title={member.principalId}>
                      {member.principalId.slice(0, 18)}…
                    </span>
                    <select
                      aria-label={t(
                        `${member.principalId} role`,
                        `${member.principalId} rolü`,
                      )}
                      value={member.role}
                      onChange={(event) =>
                        void changeSharedFolderRole(
                          member,
                          event.target.value as FolderMembership['role'],
                        ).catch((cause) =>
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : String(cause),
                          ),
                        )
                      }
                    >
                      <option value="viewer">viewer</option>
                      <option value="editor">editor</option>
                      <option value="owner">owner</option>
                    </select>
                    <button
                      type="button"
                      disabled={member.role === 'owner'}
                      onClick={() =>
                        void revokeSharedFolderMember(member).catch((cause) =>
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : String(cause),
                          ),
                        )
                      }
                    >
                      {t('Remove', 'Kaldır')}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
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
              <dd>{realtimeLabel}</dd>
            </div>
          </dl>
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
                  {sessionPending
                    ? t('Resuming…', 'Sürdürülüyor…')
                    : t('Resume conversation', 'Sohbeti sürdür')}
                </button>
              ) : null}
              {session.recoveryErrorCode ? (
                <p className="form-error">{session.recoveryErrorCode}</p>
              ) : null}
            </div>
          ) : null}
          <nav className="recent-sessions" aria-label="Son sohbetler">
            <p className="section-label">Son sohbetler</p>
            {recentSessions.isPending ? (
              <span>{t('Loading…', 'Yükleniyor…')}</span>
            ) : null}
            {recentSessions.isError ? (
              <span>
                {t(
                  'Could not load the conversation list.',
                  'Sohbet listesi alınamadı.',
                )}
              </span>
            ) : null}
            {historySessions.map((item) => (
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
                    ? t('Loading…', 'Yükleniyor…')
                    : t('Older conversations', 'Daha eski sohbetler')}
                </span>
              </button>
            ) : null}
            {recentSessions.data &&
            !recentSessions.data.pages.some((page) => page.sessions.length) ? (
              <span>{t('No conversations.', 'Sohbet yok.')}</span>
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
              aria-label={t(
                'Toggle conversation history',
                'Conversation history aç/kapat',
              )}
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              ☰
            </button>
            <div>
              <h1 id="chat-title">
                {session?.title ??
                  offlineSelected?.title ??
                  t('New conversation', 'Yeni konuşma')}
              </h1>
              <p className="chat-context">
                {(conversationFolders.data?.folders ?? []).find(
                  (folder) => folder.folderId === folderPicker.value,
                )?.name ?? 'perseverance'}{' '}
                · main
              </p>
            </div>
            <button
              className={`provider-chip ${turnActive ? 'is-running' : ''}`}
              type="button"
              aria-label={t(
                'Choose provider and model',
                'Provider ve model seç',
              )}
              onClick={() => setProviderSheetOpen(true)}
            >
              <span aria-hidden="true" />
              {(session?.provider ?? selectedProvider).toUpperCase()} ·{' '}
              {session?.resolvedModel ??
                selectedModel?.displayName ??
                'Default'}{' '}
              · {session?.reasoningEffort ?? selectedEffort}
            </button>
            {sessionId ? (
              <details className="usage-summary">
                <summary aria-live="polite">
                  <strong>{usageDisplay.amount}</strong>
                  <small>{usageDisplay.detail}</small>
                  {usage.data ? (
                    <small>
                      {usage.data.total.counters.inputTokens} in ·{' '}
                      {usage.data.total.counters.outputTokens} out
                    </small>
                  ) : null}
                </summary>
                <div className="usage-breakdown">
                  <h2>{t('Conversation usage', 'Conversation kullanımı')}</h2>
                  <p>
                    {t(
                      'The total includes conversation turns and automatic title generation. Missing usage is not treated as zero cost.',
                      'Toplam; conversation turn’leri ile otomatik başlık işini birlikte içerir. Eksik usage sıfır maliyet sayılmaz.',
                    )}
                  </p>
                  {billing.data ? (
                    <section
                      className="billing-status"
                      aria-label={t(
                        'Plan and budget status',
                        'Plan ve bütçe durumu',
                      )}
                    >
                      <div>
                        <strong>{billing.data.plan.displayName}</strong>
                        <span>
                          v{billing.data.plan.planVersion} ·{' '}
                          {billing.data.providerMode}
                        </span>
                      </div>
                      <small>
                        currency {billing.data.plan.currency} · tax{' '}
                        {billing.data.plan.taxBehavior} · price{' '}
                        {billing.data.usage.priceCatalogVersions.join(', ') ||
                          'bekleniyor'}
                      </small>
                      <small>
                        usage states · {billing.data.usageStates.join(' · ')}
                      </small>
                      <div aria-label="Prepaid kredi bakiyesi">
                        <strong>
                          available credits{' '}
                          {billing.data.credits.balance.availableCreditsMicros}
                        </strong>
                        <span>
                          reserved credits{' '}
                          {billing.data.credits.balance.reservedCreditsMicros}
                        </span>
                        <small>
                          paid{' '}
                          {
                            billing.data.credits.balance
                              .paidAvailableCreditsMicros
                          }{' '}
                          · promotional{' '}
                          {
                            billing.data.credits.balance
                              .promotionalAvailableCreditsMicros
                          }{' '}
                          · ledger{' '}
                          {billing.data.credits.balance.ledgerWatermark}
                        </small>
                      </div>
                      <details
                        aria-label={t('Credit history', 'Kredi geçmişi')}
                      >
                        <summary>Credit history</summary>
                        <ul>
                          {billing.data.credits.ledger
                            .slice(0, 12)
                            .map((entry) => (
                              <li key={entry.ledgerEntryId}>
                                {entry.entryType} · {entry.creditAmountMicros} µ
                                {entry.currency} ·{' '}
                                {entry.usageDedupeKey ?? entry.ledgerEntryId}
                              </li>
                            ))}
                        </ul>
                        {billing.data.credits.reservations.map(
                          (reservation) => (
                            <small key={reservation.reservationId}>
                              reservation {reservation.reservationId} ·{' '}
                              {reservation.state} · unresolved{' '}
                              {reservation.unresolvedCreditsMicros}
                            </small>
                          ),
                        )}
                        {billing.data.credits.settlements.map((settlement) => (
                          <small key={settlement.settlementId}>
                            settlement {settlement.settlementId} ·{' '}
                            {settlement.usageStatus} · measured{' '}
                            {settlement.measuredCreditsMicros} · released{' '}
                            {settlement.releasedCreditsMicros}
                          </small>
                        ))}
                      </details>
                      <small>
                        freshness{' '}
                        {new Date(
                          billing.data.usageFreshnessAt,
                        ).toLocaleString()}{' '}
                        · last reconciliation{' '}
                        {billing.data.lastReconciledAt
                          ? new Date(
                              billing.data.lastReconciledAt,
                            ).toLocaleString()
                          : t('none', 'yok')}
                      </small>
                      {billing.data.budgets.map((budget) => (
                        <small key={budget.budgetId}>
                          {budget.period} budget · consumed{' '}
                          {billing.data.usage.estimatedCostMicros === null
                            ? 'incomplete'
                            : `${billing.data.usage.estimatedCostMicros} µ${budget.currency}`}{' '}
                          · soft {budget.softLimitMicros ?? t('none', 'yok')} ·
                          hard {budget.hardLimitMicros ?? t('none', 'yok')}
                        </small>
                      ))}
                      {billing.data.latestDecision ? (
                        <p
                          className={`quota-${billing.data.latestDecision.outcome}`}
                          role={
                            billing.data.latestDecision.outcome === 'deny'
                              ? 'alert'
                              : 'status'
                          }
                        >
                          {billing.data.latestDecision.outcome === 'warn'
                            ? t('Soft limit warning', 'Soft limit uyarısı')
                            : billing.data.latestDecision.outcome === 'deny'
                              ? 'Hard limit'
                              : t('Quota available', 'Kota uygun')}
                          : {billing.data.latestDecision.reason} · policy v
                          {billing.data.latestDecision.policyVersion}
                        </p>
                      ) : null}
                      {!billing.data.productionBillingVerified ? (
                        <small>
                          {t(
                            'Billing emulator · production collection not verified',
                            'Billing emulator · production tahsilat doğrulanmadı',
                          )}
                        </small>
                      ) : null}
                      {billingFinancial.data ? (
                        <section aria-label="Admin finansal projection">
                          <strong>Admin financial projection</strong>
                          <small>
                            cash collected{' '}
                            {
                              billingFinancial.data.projection
                                .cashCollectedMicros
                            }{' '}
                            · outstanding liability{' '}
                            {
                              billingFinancial.data.projection
                                .outstandingPaidCreditLiabilityMicros
                            }
                          </small>
                          <small>
                            consumed-credit revenue{' '}
                            {
                              billingFinancial.data.projection
                                .consumedPaidCreditRevenueMicros
                            }{' '}
                            · promotional consumption{' '}
                            {
                              billingFinancial.data.projection
                                .promotionalConsumptionMicros
                            }
                          </small>
                          <small>
                            provider COGS{' '}
                            {
                              billingFinancial.data.projection
                                .providerCogsMicros
                            }{' '}
                            · infrastructure COGS{' '}
                            {
                              billingFinancial.data.projection
                                .infrastructureCogsMicros
                            }{' '}
                            · gross margin{' '}
                            {billingFinancial.data.projection.grossMarginMicros}
                          </small>
                          <small>
                            {billingFinancial.data.projection.accountingStatus}
                            {' · '}ledger{' '}
                            {billingFinancial.data.projection.ledgerWatermark} ·
                            retail price{' '}
                            {
                              billingFinancial.data.projection
                                .retailPriceCatalogVersion
                            }
                          </small>
                        </section>
                      ) : null}
                    </section>
                  ) : null}
                  {usage.data?.items.length ? (
                    <ul>
                      {usage.data.items.map((item) => {
                        const display = formatUsageCost(item)
                        return (
                          <li key={`${item.turnId}:${item.purpose}`}>
                            <div>
                              <strong>
                                {item.purpose === 'conversation_title'
                                  ? t('Automatic title', 'Otomatik başlık')
                                  : `Turn ${item.turnId}`}
                              </strong>
                              <span>{display.amount}</span>
                            </div>
                            <small>
                              {item.provider} · {item.modelId} ·{' '}
                              {item.outcome ?? 'job'} · {display.detail}
                            </small>
                            <small>
                              input {item.counters.inputTokens} · cached{' '}
                              {item.counters.cachedInputTokens} · output{' '}
                              {item.counters.outputTokens} · reasoning{' '}
                              {item.counters.reasoningTokens} · tool{' '}
                              {item.counters.toolUnits}
                            </small>
                            <small>
                              {item.currency} · price catalog:{' '}
                              {item.priceCatalogVersions.join(', ') ||
                                t('none', 'yok')}
                            </small>
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <p>
                      {t('No measured usage yet.', 'Henüz ölçülmüş usage yok.')}
                    </p>
                  )}
                </div>
              </details>
            ) : null}
            <label>
              <span>Folder</span>
              <select
                value={folderPicker.value}
                disabled={folderPicker.disabled}
                onChange={(event) => {
                  const folderId = event.target.value || null
                  if (session) void moveConversation(folderId)
                  else setSelectedFolderId(folderId)
                }}
              >
                <option value="">{t('No folder', 'Folder yok')}</option>
                {(conversationFolders.data?.folders ?? []).map((folder) => (
                  <option
                    key={folder.folderId}
                    value={folder.folderId}
                    disabled={Boolean(folder.archivedAt)}
                  >
                    {folder.archivedAt
                      ? `[${t('Archived', 'Arşiv')}] ${folder.name}`
                      : folder.name}
                  </option>
                ))}
                {(sharedFolders.data?.folders ?? []).map((entry) => (
                  <option
                    key={entry.folder.folderId}
                    value={entry.folder.folderId}
                  >
                    {entry.folder.name} · {entry.membership.role}
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
              {turnActive ? (
                <p className="background-run-banner" role="status">
                  {serverOwnedRunLabel(
                    session?.activeRun?.status ?? 'running',
                    realtimeState,
                  )}
                </p>
              ) : session?.latestRun?.terminalOutcome ? (
                <p className="background-run-banner is-terminal" role="status">
                  {t('Last run', 'Son çalışma')}:{' '}
                  {session.latestRun.terminalOutcome}
                </p>
              ) : null}
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
              {displayedChatFeed.length > 0 ? (
                <div className="chat-messages">
                  {displayedChatFeed.map((item) =>
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
                            {item.role === 'assistant'
                              ? 'Codex'
                              : t('You', 'Sen')}
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
                  <span aria-hidden="true">&gt;_</span>
                  <h2>
                    {t('READY FOR THE FIRST TURN', 'İLK TURN İÇİN HAZIR')}
                  </h2>
                  <p>
                    {t(
                      'Enter a task below to start a new conversation.',
                      'Yeni bir konuşma başlatmak için aşağıya görevini yaz.',
                    )}
                  </p>
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
                    ? t('Codex authentication ready', 'Codex auth hazır')
                    : readiness.data?.status === 'setup_required'
                      ? 'Codex login gerekli'
                      : t(
                          'Codex readiness degraded',
                          'Codex readiness bozulmuş',
                        )}
              </strong>
              {readiness.data?.status === 'setup_required' ? (
                <p>
                  {t('Run', 'Terminalde')} <code>codex login</code>{' '}
                  {t(
                    'in a terminal. Do not enter an API key; then try again.',
                    'çalıştırın. API key girmeyin; ardından yeniden deneyin.',
                  )}
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
              <p className="section-label">{t('Live task', 'Canlı görev')}</p>
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
            aria-label={t('Timeline events', 'Timeline olayları')}
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
              <section
                className="timeline-master"
                aria-label={t('Codex activity', 'Codex çalışması')}
              >
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
                    <strong>{t('Codex activity', 'Codex çalışması')}</strong>
                    <span>
                      {cards.length} {t('operations', 'işlem')} ·{' '}
                      {turnActive
                        ? t('running', 'çalışıyor')
                        : t('ready', 'hazır')}
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
                  {session
                    ? t('Ready for the first turn', 'İlk turn için hazır')
                    : t('Create a conversation first', 'Önce sohbet oluştur')}
                </h3>
                <p>
                  {t(
                    'Normalized events appear here live after the durable store commit.',
                    'Normalize event’ler durable store commit’inden sonra burada canlı görünür.',
                  )}
                </p>
              </div>
            )}
          </div>

          {error ? (
            <section className="request-error" role="alert">
              <strong>
                {t('Operation could not be completed', 'İşlem tamamlanamadı')}
              </strong>
              <p>{error}</p>
            </section>
          ) : null}
          {contentKeyLocked ? (
            <form
              className="content-key-unlock"
              role="alert"
              onSubmit={(event) => void unlockContentKey(event)}
            >
              <div>
                <strong>
                  {t(
                    'Secure session must be reauthenticated',
                    'Güvenli oturum yeniden doğrulanmalı',
                  )}
                </strong>
                <p>
                  {t(
                    'The server restarted. Your message is preserved; enter your password once to send it.',
                    'Sunucu yeniden başlatıldı. Mesajınız korunuyor; göndermek için parolanızı bir kez girin.',
                  )}
                </p>
              </div>
              <label>
                <span>Parola</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={unlockPassword}
                  disabled={unlockPending}
                  onChange={(event) => setUnlockPassword(event.target.value)}
                />
              </label>
              <button
                type="submit"
                disabled={unlockPending || unlockPassword.length < 8}
              >
                {unlockPending
                  ? t('Verifying…', 'Doğrulanıyor…')
                  : t('Unlock', 'Kilidi aç')}
              </button>
              {unlockError ? <p className="form-error">{unlockError}</p> : null}
            </form>
          ) : null}
          {session?.recoveryOptions.length ? (
            <section className="recovery-panel" aria-live="polite">
              <h3>
                {session.recoveryErrorCode === 'THREAD_NOT_RESUMABLE'
                  ? t('Thread cannot be resumed', 'Thread sürdürülemiyor')
                  : t(
                      'Conversation could not be recovered temporarily',
                      'Sohbet geçici olarak kurtarılamadı',
                    )}
              </h3>
              <p>
                {session.recoveryErrorCode === 'THREAD_NOT_RESUMABLE'
                  ? t(
                      'The existing thread binding is preserved; no new thread was opened automatically.',
                      'Mevcut thread binding’i korunuyor; otomatik yeni thread açılmadı.',
                    )
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
                    onClick={() => beginConversationDraft()}
                  >
                    {t('Start new conversation', 'Yeni sohbet başlat')}
                  </button>
                ) : null}
                {session.recoveryOptions.includes('view_read_only') ? (
                  <button type="button" onClick={() => setReadOnly(true)}>
                    {t(
                      'View timeline as read-only',
                      'Timeline’ı read-only görüntüle',
                    )}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}
          {readOnly ? (
            <p className="read-only-banner">Read-only timeline modu</p>
          ) : null}
          {turnActive ? (
            <div className="running-status" role="status">
              <span aria-hidden="true" />
              <small>
                {t('Running on the server', 'Server üzerinde çalışıyor')} ·
                sequence {String(lastSequence.current).padStart(4, '0')}
              </small>
              <button
                type="button"
                disabled={turnPending}
                onClick={() => void steerOrInterrupt('interrupt')}
              >
                DURDUR
              </button>
            </div>
          ) : null}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault()
              void submitTurn()
            }}
          >
            <label htmlFor="prompt">
              {t('Give Codex a task', 'Codex’e görev ver')}
            </label>
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
                      aria-label={t(
                        `Remove ${attachment.name} attachment`,
                        `${attachment.name} attachment’ını kaldır`,
                      )}
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
                    (session !== undefined && session.status !== 'active') ||
                    !online ||
                    turnPending ||
                    turnActive ||
                    readOnly ||
                    attachmentPending ||
                    contentKeyLocked
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
                  else void submitTurn()
                }}
                placeholder={t(
                  `Give ${session?.provider ?? selectedProvider} a task…`,
                  `${session?.provider ?? selectedProvider}'e görev ver…`,
                )}
                rows={2}
                disabled={
                  (session !== undefined && session.status !== 'active') ||
                  !online ||
                  turnPending ||
                  readOnly ||
                  contentKeyLocked ||
                  (!authReady &&
                    (session?.provider ?? selectedProvider) === 'codex')
                }
              />
              <button
                type="submit"
                disabled={
                  (session !== undefined && session.status !== 'active') ||
                  !online ||
                  (!prompt.trim() && attachments.length === 0) ||
                  turnPending ||
                  attachmentPending ||
                  turnActive ||
                  readOnly ||
                  contentKeyLocked ||
                  (!authReady &&
                    (session?.provider ?? selectedProvider) === 'codex')
                }
              >
                {turnPending ? '…' : '↑'}
              </button>
              {turnActive && !readOnly && online ? (
                <>
                  <button
                    type="button"
                    disabled={!prompt.trim() || turnPending}
                    onClick={() => void steerOrInterrupt('steer')}
                  >
                    {t('Steer', 'Yönlendir')}
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
      {sourcesOpen || supportAccessOpen ? (
        <button
          className="drawer-backdrop"
          type="button"
          aria-label="Yan paneli kapat"
          onClick={() => {
            setSourcesOpen(false)
            setSupportAccessOpen(false)
          }}
        />
      ) : null}
      {sourcesOpen ? (
        <SourcesDrawer
          sources={sources.data?.sources ?? []}
          pending={sourcePending}
          error={sources.isError}
          online={online}
          onUpload={(file) => void uploadSource(file)}
          onClose={() => setSourcesOpen(false)}
        />
      ) : null}
      {supportAccessOpen && session ? (
        <SupportAccessPanel
          sessionId={session.sessionId}
          grants={supportGrants.data ?? []}
          pending={supportGrants.isPending}
          audit={supportAudit.data?.records ?? []}
          auditChainValid={supportAudit.data?.chainValid ?? true}
          onClose={() => setSupportAccessOpen(false)}
          onChanged={() => {
            void supportGrants.refetch()
            void supportAudit.refetch()
          }}
        />
      ) : null}
      {providerSheetOpen ? (
        <div className="modal-layer" role="presentation">
          <button
            className="modal-backdrop"
            type="button"
            aria-label={t(
              'Close provider selection',
              'Provider seçimini kapat',
            )}
            onClick={() => setProviderSheetOpen(false)}
          />
          <section
            className="provider-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="provider-sheet-title"
          >
            <header>
              <h2 id="provider-sheet-title">PROVIDER &amp; MODEL</h2>
              <button type="button" onClick={() => setProviderSheetOpen(false)}>
                ×
              </button>
            </header>
            <div className="provider-segments" role="radiogroup">
              {(['codex', 'claude', 'gemini', 'cursor'] as const).map(
                (provider) => (
                  <button
                    key={provider}
                    type="button"
                    className={selectedProvider === provider ? 'is-active' : ''}
                    onClick={() => {
                      const catalog = providerCatalogs.data?.catalogs.find(
                        (entry) => entry.identity.provider === provider,
                      )
                      const selection = providerPickerSelection(
                        provider,
                        catalog?.models,
                      )
                      setSelectedProvider(provider)
                      setSelectedModelId(selection.modelId)
                      setSelectedEffort(selection.effort)
                    }}
                  >
                    {provider}
                  </button>
                ),
              )}
            </div>
            <div className="provider-models">
              {selectedProvider === 'codex' ? (
                <button
                  type="button"
                  className={selectedModelId === '' ? 'is-selected' : ''}
                  onClick={() => {
                    setSelectedModelId('')
                    setSelectedEffort('medium')
                  }}
                >
                  <span>
                    <strong>Catalog default</strong>
                    <small>onay destekli · komut + diff · vision</small>
                  </span>
                  <i aria-hidden="true" />
                </button>
              ) : null}
              {(selectedCatalog?.models ?? [])
                .filter((model) => !model.hidden)
                .map((model) => (
                  <button
                    type="button"
                    key={model.modelId}
                    className={
                      selectedModelId === model.modelId ? 'is-selected' : ''
                    }
                    onClick={() => {
                      setSelectedModelId(model.modelId)
                      setSelectedEffort(model.defaultReasoningEffort)
                    }}
                  >
                    <span>
                      <strong>
                        {model.displayName}
                        {model.isDefault ? (
                          <em>{t('default', 'varsayılan')}</em>
                        ) : null}
                      </strong>
                      <small>
                        {model.capabilities.approvals === 'supported'
                          ? 'onay destekli'
                          : t('limited approval', 'sınırlı onay')}{' '}
                        · komut + diff
                      </small>
                    </span>
                    <i aria-hidden="true" />
                  </button>
                ))}
            </div>
            <p className="provider-sheet-label">REASONING EFFORT</p>
            <div className="effort-segments">
              {availableEfforts.map((effort) => (
                <button
                  type="button"
                  key={effort}
                  className={selectedEffort === effort ? 'is-active' : ''}
                  onClick={() => setSelectedEffort(effort)}
                >
                  {effort}
                </button>
              ))}
            </div>
            {capabilityWarnings.length ? (
              <p className="provider-note">{capabilityWarnings.join(' · ')}</p>
            ) : null}
            <button
              className="provider-apply"
              type="button"
              onClick={() => setProviderSheetOpen(false)}
            >
              Uygula
            </button>
          </section>
        </div>
      ) : null}
      {settingsOpen ? (
        <section
          className="settings-screen"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
        >
          <header>
            <button type="button" onClick={() => setSettingsOpen(false)}>
              ←
            </button>
            <h2 id="settings-title">AYARLAR &amp; KULLANIM</h2>
          </header>
          <div className="settings-content">
            <section>
              <p className="settings-label">{t('LANGUAGE', 'DİL')}</p>
              <LanguageSwitcher variant="settings" />
            </section>
            <section>
              <p className="settings-label">
                {t('THIS CONVERSATION’S USAGE', 'BU SOHBETİN KULLANIMI')}
              </p>
              <strong className="usage-amount">{usageDisplay.amount}</strong>
              <small>{usageDisplay.detail}</small>
              <dl className="token-grid">
                <div>
                  <dt>INPUT</dt>
                  <dd>{usage.data?.total.counters.inputTokens ?? 0}</dd>
                </div>
                <div>
                  <dt>OUTPUT</dt>
                  <dd>{usage.data?.total.counters.outputTokens ?? 0}</dd>
                </div>
                <div>
                  <dt>CACHED</dt>
                  <dd>{usage.data?.total.counters.cachedInputTokens ?? 0}</dd>
                </div>
              </dl>
            </section>
            <section>
              <p className="settings-label">OTURUM</p>
              <dl className="settings-rows">
                <div>
                  <dt>Provider</dt>
                  <dd>
                    {session?.provider ?? selectedProvider} ·{' '}
                    {session?.resolvedModel ??
                      selectedModel?.displayName ??
                      'default'}
                  </dd>
                </div>
                <div>
                  <dt>Transport</dt>
                  <dd>codex app-server · JSON-RPC</dd>
                </div>
                <div>
                  <dt>Workspace</dt>
                  <dd>{workspaceId}</dd>
                </div>
                <div>
                  <dt>Realtime</dt>
                  <dd>{realtimeLabel}</dd>
                </div>
              </dl>
            </section>
            <section>
              <p className="settings-label">{t('SECURITY', 'GÜVENLİK')}</p>
              <p className="settings-copy">
                {t(
                  'Conversation content is stored within the tenant scope. Your password and sensitive environment values are never written to the timeline or logs.',
                  'Konuşma içeriği tenant kapsamında saklanır. Parolanız ve hassas environment değerleri timeline veya loglara yazılmaz.',
                )}
              </p>
            </section>
            <button
              className="settings-signout"
              type="button"
              onClick={() => void signOut(apiBaseUrl)}
            >
              OTURUMU KAPAT
            </button>
          </div>
        </section>
      ) : null}
    </main>
  )
}
