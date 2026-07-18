import { setImmediate as waitForImmediate } from 'node:timers/promises'
import { LocalArtifactStorage } from '@persistent-codex/artifact-storage'
import {
  CorpusIngestionService,
  CorpusError,
  LocalCorpusRegistry,
  singleChunk,
  type CorpusRepository,
  type CorpusSnapshotStorage,
  type EmbeddingProvider,
} from '@persistent-codex/corpus-ingestion'
import {
  AuthenticationError,
  ExplicitDevAuthenticationAdapter,
  authorize,
  type AuthenticationAdapter,
  type MembershipDirectory,
} from '@persistent-codex/authz'
import {
  artifactDownloadTokenSchema,
  artifactMetadataSchema,
  auditListResponseSchema,
  createSupportGrantRequestSchema,
  supportGrantDecisionRequestSchema,
  supportGrantListResponseSchema,
  supportGrantRevokeRequestSchema,
  supportGrantSchema,
  securityAuditListResponseSchema,
  jitLeaseIssueRequestSchema,
  jitLeaseIssueResponseSchema,
  jitLeaseConsumeRequestSchema,
  protectedContentResponseSchema,
  createBreakGlassRequestSchema,
  breakGlassRequestSchema,
  supportMfaRequestSchema,
  supportApprovalRequestSchema,
  supportRevokeRequestSchema,
  outboxDeliveryResultRequestSchema,
  securityOutboxRecordSchema,
  createSourceResponseSchema,
  sourceDetailResponseSchema,
  sourceListResponseSchema,
  sourceUploadMetadataSchema,
} from '@persistent-codex/control-plane-contracts'
import {
  InMemorySupportAccessRepository,
  SupportAccessError,
  type SupportActor,
  type SupportAccessRepository,
  type SupportAccessScope,
} from '@persistent-codex/support-access'
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  constants,
  lstatSync,
  realpathSync,
  readFileSync,
  statfsSync,
} from 'node:fs'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import {
  ackMessageSchema,
  approvalDecisionRequestSchema,
  approvalListResponseSchema,
  approvalSchema,
  apiErrorResponseSchema,
  clientMessageSchema,
  conversationAttachmentSchema,
  conversationFolderListResponseSchema,
  conversationFolderSchema,
  createConversationFolderRequestSchema,
  updateConversationFolderRequestSchema,
  createSessionRequestSchema,
  createTurnRequestSchema,
  steerTurnRequestSchema,
  interruptTurnRequestSchema,
  sessionResponseSchema,
  turnActionResponseSchema,
  replayResponseSchema,
  readinessResponseSchema,
  sessionListResponseSchema,
  updateConversationRequestSchema,
  gitSnapshotSchema,
  gitSnapshotListResponseSchema,
  metricsResponseSchema,
  providerCatalogListResponseSchema,
  conversationUsageCostSchema,
  usageReconciliationResponseSchema,
  usageCostSummarySchema,
  serverMessageSchema,
  type ServerMessage,
  type SubscribeMessage,
  type Approval,
  type AuthPrincipal,
  type AuthorizationAction,
  type OrganizationMembership,
  meResponseSchema,
} from '@persistent-codex/control-plane-contracts'
import type {
  ModelAliasConfig,
  PriceCatalog,
  ProviderCostReconciliationPort,
  ProviderId,
  ProviderModelCatalog,
} from '@persistent-codex/provider-platform'
import { createHash } from 'node:crypto'
import type { TimelineEvent } from '@persistent-codex/domain-events'
import {
  SqliteEventStore,
  StoreConflictError,
  StoreError,
  StoreNotFoundError,
  type StoreScope,
} from '@persistent-codex/event-store'
import type {
  WorkspaceRuntimeClient,
  WorkspaceRuntimeIdentity,
} from '@persistent-codex/workspace-agent'
import { PersistentCodexHomeManager } from '@persistent-codex/workspace-agent'
import Fastify from 'fastify'
import {
  isIdempotencyConflict,
  OrchestrationError,
  SessionOrchestrator,
  type SessionOrchestratorOptions,
} from './session-orchestrator'
import { BoundedMetricRecorder, metricRoute } from './metrics'
import {
  AttachmentStorageError,
  LocalAttachmentStorage,
} from './attachment-storage'

interface RealtimeSocket {
  send(data: string): void
  bufferedAmount?: number
  close?(code?: number, reason?: string): void
}

export interface ControlPlaneOptions {
  databasePath?: string
  eventStore?: SqliteEventStore
  logger?: boolean
  workspaceCwd?:
    | string
    | ((
        identity: Pick<WorkspaceRuntimeIdentity, 'tenantId' | 'workspaceId'>,
      ) => string)
  runtimeClientFactory?: (
    identity: WorkspaceRuntimeIdentity,
  ) => WorkspaceRuntimeClient
  sessionIdFactory?: () => string
  runIdFactory?: () => string
  runtimeInstanceIdFactory?: () => string
  approvalPolicy?: 'untrusted' | 'on-request' | 'never'
  codexHomeRoot?: string
  codexProvisioningSource?: string
  artifactRoot?: string
  attachmentRoot?: string
  corpusRoot?: string
  corpusRepository?: CorpusRepository
  corpusSnapshotStorage?: CorpusSnapshotStorage
  corpusEmbeddingProvider?: EmbeddingProvider
  allowLocalCorpus?: boolean
  corpusAutoDrain?: boolean
  preflightChecks?: Array<{
    name:
      | 'codex'
      | 'workspace'
      | 'database'
      | 'artifacts'
      | 'codexHome'
      | 'provisioning'
    status: 'ready' | 'failed'
    code: string | null
  }>
  metricRecorder?: BoundedMetricRecorder
  now?: () => Date
  readinessProbeTimeoutMs?: number
  securityReadiness?: {
    runtimeBackend: 'local-process' | 'kata-kubernetes'
    isolationLevel: 'development_only' | 'container' | 'microvm'
    encryptedVolume: boolean
    egressDefaultDeny: boolean
    secretProvider: string
    secretProviderProduction: boolean
    kmsProvider: string
    kmsProviderProduction: boolean
    encryptionFormatVersion: number
    chunkedEncryptionFormatVersion: number
  }
  modelAliases?: ModelAliasConfig
  priceCatalog?: PriceCatalog
  costReconciliationPorts?: Partial<
    Record<ProviderId, ProviderCostReconciliationPort>
  >
  providerCatalogs?: ProviderModelCatalog[]
  providerAdapterFactory?: SessionOrchestratorOptions['providerAdapterFactory']
  cursorForceAllowed?: boolean
  titleGenerator?: SessionOrchestratorOptions['titleGenerator']
  authenticationAdapter?: AuthenticationAdapter
  membershipDirectory?: MembershipDirectory
  allowExplicitDevAuthentication?: boolean
  supportAccessRepository?: SupportAccessRepository
  allowInMemorySupportAccess?: boolean
  decryptSupportContent?: (input: {
    tenantId: string
    workspaceId: string
    sessionId: string | null
    objectId: string | null
  }) => Promise<string> | string
}

export interface PublicRouteAuthorizationEntry {
  method: string
  route: string
  action: AuthorizationAction
  resourceType: string
}

export const PUBLIC_ROUTE_AUTHORIZATION_CATALOG: PublicRouteAuthorizationEntry[] =
  [
    {
      method: 'GET',
      route: '/metrics',
      action: 'metrics.read',
      resourceType: 'metrics',
    },
    {
      method: 'GET',
      route: '/v1/me',
      action: 'session.read',
      resourceType: 'principal',
    },
    {
      method: 'GET',
      route: '/readyz',
      action: 'provider.readiness.read',
      resourceType: 'workspace',
    },
    {
      method: 'GET',
      route: '/v1/sessions/:sessionId/audit',
      action: 'audit.read',
      resourceType: 'audit',
    },
    {
      method: 'GET',
      route: '/v1/sessions/:sessionId/support-grants',
      action: 'support.grant.read',
      resourceType: 'support_grant',
    },
    {
      method: 'GET',
      route: '/v1/sessions/:sessionId/support-audit',
      action: 'audit.read',
      resourceType: 'security_audit',
    },
    {
      method: 'POST',
      route: '/v1/sessions/:sessionId/support-grants',
      action: 'support.grant.create',
      resourceType: 'support_grant',
    },
    {
      method: 'POST',
      route: '/v1/support-grants/:grantId/mfa',
      action: 'support.grant.create',
      resourceType: 'support_grant',
    },
    {
      method: 'POST',
      route: '/v1/support-grants/:grantId/decision',
      action: 'support.grant.approve',
      resourceType: 'support_grant',
    },
    {
      method: 'POST',
      route: '/v1/support-grants/:grantId/revoke',
      action: 'support.grant.revoke',
      resourceType: 'support_grant',
    },
    {
      method: 'POST',
      route: '/v1/support-access/leases',
      action: 'support.access.use',
      resourceType: 'jit_lease',
    },
    {
      method: 'POST',
      route: '/v1/support-access/leases/:leaseId/consume',
      action: 'support.access.use',
      resourceType: 'protected_content',
    },
    {
      method: 'POST',
      route: '/v1/break-glass',
      action: 'break_glass.request',
      resourceType: 'break_glass',
    },
    {
      method: 'POST',
      route: '/v1/break-glass/:breakGlassId/mfa',
      action: 'break_glass.request',
      resourceType: 'break_glass',
    },
    {
      method: 'POST',
      route: '/v1/break-glass/:breakGlassId/approve',
      action: 'break_glass.approve',
      resourceType: 'break_glass',
    },
    {
      method: 'POST',
      route: '/v1/break-glass/:breakGlassId/revoke',
      action: 'break_glass.request',
      resourceType: 'break_glass',
    },
    {
      method: 'POST',
      route: '/v1/security-outbox/:outboxId/result',
      action: 'break_glass.request',
      resourceType: 'security_outbox',
    },
    {
      method: 'GET',
      route: '/v1/artifacts/:artifactId',
      action: 'artifact.read',
      resourceType: 'artifact',
    },
    {
      method: 'POST',
      route: '/v1/artifacts/:artifactId/download-token',
      action: 'artifact.download',
      resourceType: 'artifact',
    },
    {
      method: 'GET',
      route: '/v1/approvals',
      action: 'approval.read',
      resourceType: 'approval',
    },
    {
      method: 'GET',
      route: '/v1/approvals/:approvalId',
      action: 'approval.read',
      resourceType: 'approval',
    },
    {
      method: 'POST',
      route: '/v1/approvals/:approvalId/decision',
      action: 'approval.decide',
      resourceType: 'approval',
    },
    {
      method: 'POST',
      route: '/v1/sessions',
      action: 'session.create',
      resourceType: 'session',
    },
    {
      method: 'GET',
      route: '/v1/provider-catalogs',
      action: 'provider.catalog.read',
      resourceType: 'provider_catalog',
    },
    {
      method: 'GET',
      route: '/v1/conversation-folders',
      action: 'folder.read',
      resourceType: 'folder',
    },
    {
      method: 'POST',
      route: '/v1/conversation-folders',
      action: 'folder.manage',
      resourceType: 'folder',
    },
    {
      method: 'PATCH',
      route: '/v1/conversation-folders/:folderId',
      action: 'folder.manage',
      resourceType: 'folder',
    },
    {
      method: 'DELETE',
      route: '/v1/conversation-folders/:folderId',
      action: 'folder.manage',
      resourceType: 'folder',
    },
    {
      method: 'PATCH',
      route: '/v1/sessions/:sessionId/conversation',
      action: 'session.update',
      resourceType: 'session',
    },
    {
      method: 'GET',
      route: '/v1/sessions',
      action: 'session.read',
      resourceType: 'session',
    },
    {
      method: 'GET',
      route: '/v1/sessions/:sessionId',
      action: 'session.read',
      resourceType: 'session',
    },
    {
      method: 'GET',
      route: '/v1/sessions/:sessionId/usage',
      action: 'usage.read',
      resourceType: 'usage',
    },
    {
      method: 'GET',
      route: '/v1/sessions/:sessionId/turns/:turnId/usage',
      action: 'usage.read',
      resourceType: 'usage',
    },
    {
      method: 'POST',
      route: '/v1/sessions/:sessionId/usage/reconcile',
      action: 'usage.reconcile',
      resourceType: 'usage',
    },
    {
      method: 'GET',
      route: '/v1/sessions/:sessionId/git-snapshots',
      action: 'workspace.snapshot.read',
      resourceType: 'git_snapshot',
    },
    {
      method: 'POST',
      route: '/v1/sessions/:sessionId/git-snapshots/refresh',
      action: 'workspace.snapshot.read',
      resourceType: 'git_snapshot',
    },
    {
      method: 'POST',
      route: '/v1/sessions/:sessionId/resume',
      action: 'session.update',
      resourceType: 'session',
    },
    {
      method: 'POST',
      route: '/v1/sessions/:sessionId/turns/:turnId/steer',
      action: 'turn.steer',
      resourceType: 'turn',
    },
    {
      method: 'POST',
      route: '/v1/sessions/:sessionId/turns/:turnId/interrupt',
      action: 'turn.interrupt',
      resourceType: 'turn',
    },
    {
      method: 'POST',
      route: '/v1/sessions/:sessionId/attachments',
      action: 'attachment.upload',
      resourceType: 'attachment',
    },
    {
      method: 'POST',
      route: '/v1/workspaces/:workspaceId/sources',
      action: 'source.create',
      resourceType: 'source',
    },
    {
      method: 'GET',
      route: '/v1/workspaces/:workspaceId/sources',
      action: 'source.read',
      resourceType: 'source',
    },
    {
      method: 'GET',
      route: '/v1/workspaces/:workspaceId/sources/:sourceId',
      action: 'source.read',
      resourceType: 'source',
    },
    {
      method: 'DELETE',
      route: '/v1/workspaces/:workspaceId/sources/:sourceId',
      action: 'source.delete',
      resourceType: 'source',
    },
    {
      method: 'POST',
      route: '/v1/workspaces/:workspaceId/sources/:sourceId/reindex',
      action: 'source.reindex',
      resourceType: 'source',
    },
    {
      method: 'DELETE',
      route: '/v1/sessions/:sessionId/attachments/:attachmentId',
      action: 'attachment.delete',
      resourceType: 'attachment',
    },
    {
      method: 'POST',
      route: '/v1/sessions/:sessionId/turns',
      action: 'turn.start',
      resourceType: 'turn',
    },
    {
      method: 'GET',
      route: '/v1/sessions/:sessionId/events',
      action: 'event.replay',
      resourceType: 'event',
    },
    {
      method: 'GET',
      route: '/v1/realtime',
      action: 'event.subscribe',
      resourceType: 'realtime',
    },
  ]

const authContexts = new WeakMap<
  object,
  { principal: AuthPrincipal; memberships: OrganizationMembership[] }
>()

function opaquePrincipalId(principal: AuthPrincipal) {
  return `sha256:${createHash('sha256')
    .update(`${principal.issuer}\0${principal.subject}`)
    .digest('hex')}`
}

function supportActor(
  principal: AuthPrincipal,
  memberships: OrganizationMembership[],
  organizationId: string,
): SupportActor {
  const role = memberships.find(
    (membership) => membership.organizationId === organizationId,
  )?.role
  return {
    principalId: opaquePrincipalId(principal),
    role:
      role === 'support' ||
      role === 'operator' ||
      role === 'security_approver' ||
      role === 'kms_operator' ||
      role === 'admin'
        ? role
        : 'tenant_user',
  }
}

function routeAuthorization(method: string, route: string | undefined) {
  return PUBLIC_ROUTE_AUTHORIZATION_CATALOG.find(
    (entry) => entry.method === method && entry.route === route,
  )
}

interface SubscriptionState extends StoreScope {
  replaying: boolean
  highWaterSequence: number
  lastSentSequence: number
  ackSequence: number
  buffer: TimelineEvent[]
  bufferBytes: number
  droppedEventCount: number
}
const REALTIME_MAX_QUEUE_EVENTS = 256
const REALTIME_MAX_QUEUE_BYTES = 1024 * 1024
function isAuthoritative(event: TimelineEvent) {
  return (
    event.type.endsWith('.completed') ||
    event.type.startsWith('approval.') ||
    event.type === 'error.reported'
  )
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function requestScope(
  headers: Record<string, string | string[] | undefined>,
  sessionId: string,
): StoreScope | undefined {
  const tenantId = headerValue(headers['x-tenant-id'])
  const workspaceId = headerValue(headers['x-workspace-id'])
  if (!tenantId || !workspaceId) return undefined
  return { tenantId, workspaceId, sessionId }
}

function supportRepositoryScope(
  headers: Record<string, string | string[] | undefined>,
): SupportAccessScope | undefined {
  const organizationId = headerValue(headers['x-tenant-id'])
  const workspaceId = headerValue(headers['x-workspace-id'])
  if (!organizationId || !workspaceId) return undefined
  return {
    tenantId: organizationId,
    organizationId,
    workspaceId,
  }
}

function workspaceScope(
  headers: Record<string, string | string[] | undefined>,
): { tenantId: string; workspaceId: string } | undefined {
  const tenantId = headerValue(headers['x-tenant-id'])
  const workspaceId = headerValue(headers['x-workspace-id'])
  if (!tenantId || !workspaceId) return undefined
  return { tenantId, workspaceId }
}

type DependencyCheckName = 'database' | 'artifacts' | 'workspace' | 'disk'

async function boundedProbe(
  name: DependencyCheckName,
  timeoutMs: number,
  operation: () => void | Promise<void>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PROBE_TIMEOUT')), timeoutMs)
      }),
    ])
    return { name, status: 'ready' as const, code: null }
  } catch (error) {
    return {
      name,
      status: 'failed' as const,
      code:
        error instanceof Error && error.message === 'PROBE_TIMEOUT'
          ? 'DEPENDENCY_PROBE_TIMEOUT'
          : `${name.toUpperCase()}_UNAVAILABLE`,
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function withProbeTimeout<T>(
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PROBE_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function parseNonNegativeInteger(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return 0
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return 100
  if (!/^[1-9]\d*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= 500 ? parsed : undefined
}

function decodeSessionCursor(value: string | undefined) {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as {
      updatedAt?: unknown
      sessionId?: unknown
    }
    if (
      typeof parsed.updatedAt !== 'string' ||
      typeof parsed.sessionId !== 'string'
    )
      return null
    return { updatedAt: parsed.updatedAt, sessionId: parsed.sessionId }
  } catch {
    return null
  }
}

function encodeSessionCursor(value: { updatedAt: string; sessionId: string }) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function safeCorrelation(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null
}

function auditContext(request: {
  id: string
  headers: Record<string, string | string[] | undefined>
}) {
  const traceparent = headerValue(request.headers.traceparent)
  const traceId = traceparent?.match(
    /^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/,
  )?.[1]
  return {
    correlationId: safeCorrelation(
      headerValue(request.headers['x-correlation-id']),
    ),
    requestId:
      safeCorrelation(headerValue(request.headers['x-request-id'])) ??
      safeCorrelation(request.id),
    traceId: traceId ?? null,
  }
}

export class BoundedRealtimeSender {
  readonly #queue: { data: string; authoritative: boolean }[] = []
  #bytes = 0
  #scheduled = false
  #resyncQueued = false
  readonly socket: RealtimeSocket
  readonly maxEvents: number
  readonly maxBytes: number
  cursor:
    | {
        tenantId: string
        workspaceId: string
        sessionId: string
        afterSequence: number
        highWaterSequence: number
      }
    | undefined
  constructor(
    socket: RealtimeSocket,
    maxEvents = REALTIME_MAX_QUEUE_EVENTS,
    maxBytes = REALTIME_MAX_QUEUE_BYTES,
  ) {
    this.socket = socket
    this.maxEvents = maxEvents
    this.maxBytes = maxBytes
  }
  get counters() {
    return {
      events: this.#queue.length,
      bytes: this.#bytes,
      resyncQueued: this.#resyncQueued,
    }
  }
  updateCursor(value: NonNullable<BoundedRealtimeSender['cursor']>) {
    this.cursor = value
  }
  enqueue(message: ServerMessage) {
    const data = JSON.stringify(serverMessageSchema.parse(message))
    const authoritative =
      message.type !== 'event' || isAuthoritative(message.event)
    if (
      this.#queue.length >= this.maxEvents ||
      this.#bytes + Buffer.byteLength(data) > this.maxBytes
    ) {
      if (!authoritative) return this.#queueResync('queue_overflow')
      const disposable = this.#queue.findIndex((v) => !v.authoritative)
      if (disposable >= 0) {
        const [removed] = this.#queue.splice(disposable, 1)
        this.#bytes -= Buffer.byteLength(removed!.data)
      } else return this.#queueResync('slow_consumer')
    }
    this.#queue.push({ data, authoritative })
    this.#bytes += Buffer.byteLength(data)
    this.#flush()
  }
  #queueResync(reason: 'slow_consumer' | 'queue_overflow') {
    if (this.#resyncQueued || !this.cursor) return
    this.#queue.length = 0
    this.#bytes = 0
    this.#resyncQueued = true
    const data = JSON.stringify(
      serverMessageSchema.parse({
        type: 'resync',
        tenantId: this.cursor.tenantId,
        workspaceId: this.cursor.workspaceId,
        sessionId: this.cursor.sessionId,
        reason,
        afterSequence: this.cursor.afterSequence,
        highWaterSequence: this.cursor.highWaterSequence,
        droppedEventCount: 1,
      }),
    )
    this.#queue.push({ data, authoritative: true })
    this.#bytes = Buffer.byteLength(data)
    this.#flush()
  }
  #flush() {
    if ((this.socket.bufferedAmount ?? 0) > this.maxBytes) {
      if (!this.#scheduled) {
        this.#scheduled = true
        setTimeout(() => {
          this.#scheduled = false
          this.#flush()
        }, 5)
      }
      return
    }
    while (
      this.#queue.length &&
      (this.socket.bufferedAmount ?? 0) < this.maxBytes
    ) {
      const next = this.#queue.shift()!
      this.#bytes -= Buffer.byteLength(next.data)
      this.socket.send(next.data)
      if (this.#resyncQueued) {
        this.#resyncQueued = false
        break
      }
    }
  }
}
const senders = new WeakMap<object, BoundedRealtimeSender>()
function senderFor(socket: RealtimeSocket) {
  let sender = senders.get(socket as object)
  if (!sender) {
    sender = new BoundedRealtimeSender(socket)
    senders.set(socket as object, sender)
  }
  return sender
}
function send(socket: RealtimeSocket, message: ServerMessage): void {
  senderFor(socket).enqueue(message)
}

function sendError(
  socket: RealtimeSocket,
  code: string,
  message: string,
): void {
  send(socket, { type: 'error', code, message })
}

function sameScope(left: StoreScope, right: StoreScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId
  )
}

export async function buildControlPlane(options: ControlPlaneOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false })
  const now = options.now ?? (() => new Date())
  const metrics = options.metricRecorder ?? new BoundedMetricRecorder({ now })
  const turnStartedAt = new Map<string, number>()
  const store = options.eventStore ?? new SqliteEventStore(options.databasePath)
  const explicitInMemory =
    options.allowInMemorySupportAccess === true ||
    process.env.NODE_ENV === 'test'
  if (!options.supportAccessRepository && !explicitInMemory)
    throw new SupportAccessError('SUPPORT_ACCESS_REPOSITORY_REQUIRED')
  const supportAccess =
    options.supportAccessRepository ??
    new InMemorySupportAccessRepository({ explicitUsage: 'test', now })
  const ownsStore = options.eventStore === undefined
  const artifacts = new LocalArtifactStorage(
    options.artifactRoot ?? '.runtime/artifacts',
  )
  const attachments = new LocalAttachmentStorage(
    options.attachmentRoot ??
      `${options.artifactRoot ?? '.runtime/artifacts'}/attachments`,
  )
  const explicitLocalCorpus =
    options.allowLocalCorpus === true || process.env.NODE_ENV === 'test'
  if (!options.corpusRepository && !explicitLocalCorpus)
    throw new CorpusError(
      'CORPUS_REPOSITORY_REQUIRED',
      'Production requires a PostgreSQL corpus repository',
    )
  if (options.corpusRepository && !options.corpusSnapshotStorage)
    throw new CorpusError(
      'CORPUS_SNAPSHOT_STORAGE_REQUIRED',
      'Durable corpus repository requires snapshot storage',
    )
  if (
    options.corpusRepository &&
    !options.corpusSnapshotStorage?.productionCapable &&
    !explicitLocalCorpus
  )
    throw new CorpusError(
      'PRODUCTION_CORPUS_KMS_REQUIRED',
      'Production requires corpus snapshot storage backed by a production-capable KMS',
    )
  const corpus = options.corpusRepository
    ? new CorpusIngestionService({
        repository: options.corpusRepository,
        storage: options.corpusSnapshotStorage!,
        ...(options.corpusEmbeddingProvider
          ? { embeddingProvider: options.corpusEmbeddingProvider }
          : {}),
        now,
      })
    : new LocalCorpusRegistry(
        options.corpusRoot ??
          `${options.artifactRoot ?? '.runtime/artifacts'}/corpus`,
        {
          explicitUsage:
            process.env.NODE_ENV === 'test' ? 'test' : 'development',
          now,
        },
      )
  const corpusDrains = new Map<string, Promise<void>>()
  let corpusWorkerTail = Promise.resolve()
  const scheduleCorpusDrain = (scope: SupportAccessScope) => {
    const key = JSON.stringify([
      scope.tenantId,
      scope.organizationId,
      scope.workspaceId,
    ])
    if (corpusDrains.has(key)) return
    const workerId = `control-plane-${createHash('sha256')
      .update(key)
      .digest('hex')
      .slice(0, 16)}`
    const drain = corpusWorkerTail
      .then(async () => {
        for (let processed = 0; processed < 64; processed++) {
          const job = await corpus.claimNext(scope, workerId)
          if (!job) break
          try {
            await corpus.processJob(scope, job.jobId, workerId)
          } catch {
            // Error metadata is persisted; poison jobs must not block the queue.
          }
        }
      })
      .finally(() => corpusDrains.delete(key))
    corpusDrains.set(key, drain)
    corpusWorkerTail = drain.catch(() => undefined)
  }
  if (options.corpusAutoDrain !== false)
    for (const scope of await corpus.recoverableScopes())
      setImmediate(() => scheduleCorpusDrain(scope))
  const securityReadiness = options.securityReadiness ?? {
    runtimeBackend: 'local-process' as const,
    isolationLevel: 'development_only' as const,
    encryptedVolume: false,
    egressDefaultDeny: true,
    secretProvider: 'development-local',
    secretProviderProduction: false,
    kmsProvider: 'local-memory',
    kmsProviderProduction: false,
    encryptionFormatVersion: 1,
    chunkedEncryptionFormatVersion: 1,
  }
  const authentication =
    options.authenticationAdapter ??
    (options.allowExplicitDevAuthentication || process.env.NODE_ENV === 'test'
      ? new ExplicitDevAuthenticationAdapter()
      : undefined)
  const memberships: MembershipDirectory = options.membershipDirectory ?? {
    membershipsFor(subject, issuer) {
      return store.listOrganizationMemberships(subject, issuer)
    },
  }
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  )
  const downloadTokens = new Map<
    string,
    {
      artifactId: string
      tenantId: string
      workspaceId: string
      expiresAt: number
    }
  >()
  for (const durable of store.listRecoverableArtifacts()) {
    try {
      const local = artifacts.metadata(durable.artifactId, durable)
      store.upsertArtifact({
        ...durable,
        byteLength: local.byteLength,
        sha256: local.sha256,
        chunkCount: local.chunkCount,
        finalized: local.finalized,
        status: local.status,
        finalizedAt: local.finalizedAt,
      })
    } catch {
      store.upsertArtifact({ ...durable, status: 'recovery_required' })
    }
  }
  const codexHomes = new PersistentCodexHomeManager(
    options.codexHomeRoot ?? '.runtime/codex-homes',
    options.codexProvisioningSource
      ? { provisioningSource: options.codexProvisioningSource }
      : {},
  )
  const orchestrator = new SessionOrchestrator({
    store,
    artifactStorage: artifacts,
    workspaceCwd: options.workspaceCwd ?? process.cwd(),
    codexHome: (identity) =>
      codexHomes.homeFor(identity.tenantId, identity.workspaceId),
    ...(options.runtimeClientFactory
      ? { runtimeClientFactory: options.runtimeClientFactory }
      : {}),
    ...(options.sessionIdFactory
      ? { sessionIdFactory: options.sessionIdFactory }
      : {}),
    ...(options.runIdFactory ? { runIdFactory: options.runIdFactory } : {}),
    ...(options.runtimeInstanceIdFactory
      ? { runtimeInstanceIdFactory: options.runtimeInstanceIdFactory }
      : {}),
    ...(options.approvalPolicy
      ? { approvalPolicy: options.approvalPolicy }
      : {}),
    ...(options.modelAliases ? { modelAliases: options.modelAliases } : {}),
    ...(options.priceCatalog ? { priceCatalog: options.priceCatalog } : {}),
    ...(options.providerCatalogs
      ? { providerCatalogs: options.providerCatalogs }
      : {}),
    ...(options.providerAdapterFactory
      ? { providerAdapterFactory: options.providerAdapterFactory }
      : {}),
    ...(options.cursorForceAllowed
      ? { cursorForceAllowed: options.cursorForceAllowed }
      : {}),
    ...(options.titleGenerator
      ? { titleGenerator: options.titleGenerator }
      : {}),
    onDeliveryError: (runtime, delivery, error) => {
      app.log.error(
        {
          err: error,
          tenantId: runtime.tenantId,
          workspaceId: runtime.workspaceId,
          runtimeInstanceId: runtime.runtimeInstanceId,
          delivery,
        },
        'workspace runtime delivery failed',
      )
    },
    onRecoveryError: (failure) => {
      store.appendAudit({
        ...failure,
        actor: 'system',
        action: 'recovery.failed',
        outcome: 'failure',
        idempotencyKey: `auto-recovery:${failure.sessionId}:${failure.code}`,
        metadata: { recoveryCode: failure.code },
      })
      app.log.warn(
        {
          tenantId: failure.tenantId,
          workspaceId: failure.workspaceId,
          sessionId: failure.sessionId,
          code: failure.code,
        },
        'automatic session recovery failed',
      )
    },
    onRuntimeHealth: (health) => {
      if (health.state === 'restarting') {
        store.appendAudit({
          ...health,
          sessionId: null,
          actor: 'runtime',
          action: 'runtime.restarted',
          outcome: 'requested',
          idempotencyKey: `runtime:${health.processGeneration}:${health.restartAttempt}:restarting`,
          metadata: {
            runtimeState: health.state,
            processGeneration: health.processGeneration,
          },
        })
      }
      if (health.state === 'ready' && health.restartAttempt > 0) {
        store.appendAudit({
          ...health,
          sessionId: null,
          actor: 'runtime',
          action: 'runtime.restarted',
          outcome: 'success',
          idempotencyKey: `runtime:${health.processGeneration}:${health.restartAttempt}:ready`,
          metadata: {
            runtimeState: health.state,
            processGeneration: health.processGeneration,
          },
        })
        metrics.record('app_server_restarts_total', 1, { outcome: 'ready' })
      }
      if (health.state === 'failed') {
        store.appendAudit({
          ...health,
          sessionId: null,
          actor: 'runtime',
          action: 'runtime.crash_loop',
          outcome: 'failure',
          idempotencyKey: `runtime:${health.processGeneration}:${health.restartAttempt}:failed`,
          metadata: {
            runtimeState: health.state,
            processGeneration: health.processGeneration,
          },
        })
        metrics.record('app_server_restarts_total', 1, {
          outcome: 'crash_loop',
        })
      }
      if (['ready', 'restarting', 'failed', 'stopped'].includes(health.state))
        metrics.record('runtime_health', health.state === 'ready' ? 1 : 0, {
          state: health.state as 'ready' | 'restarting' | 'failed' | 'stopped',
        })
    },
    onAuthTransition: (auth) => {
      store.appendAudit({
        ...auth,
        sessionId: null,
        actor: 'system',
        action: 'auth.state_changed',
        outcome:
          auth.toState === 'failed' || auth.toState === 'required'
            ? 'failure'
            : 'success',
        idempotencyKey: `auth:${auth.fromState}:${auth.toState}:${now().toISOString()}`,
        metadata: {
          fromState: auth.fromState,
          toState: auth.toState,
          authState: auth.toState,
        },
      })
    },
  })

  await app.register(cors, {
    origin: true,
    methods: 'GET,HEAD,POST,PATCH,DELETE,OPTIONS',
  })
  await app.register(websocket)

  app.addHook('onRequest', async (request) => {
    ;(request as typeof request & { wp11StartedAt?: number }).wp11StartedAt =
      performance.now()
    if (
      request.method === 'OPTIONS' ||
      request.url === '/healthz' ||
      request.url.startsWith('/v1/meta') ||
      request.url.startsWith('/v1/realtime') ||
      request.url.startsWith('/v1/artifact-downloads/')
    )
      return
    const coverage = routeAuthorization(
      request.method,
      request.routeOptions.url,
    )
    if (
      !coverage &&
      (request.url.startsWith('/v1/') ||
        request.url === '/metrics' ||
        request.url.startsWith('/readyz'))
    )
      throw new AuthenticationError('AUTHZ_ROUTE_UNCOVERED')
    if (!coverage) return
    if (!authentication)
      throw new AuthenticationError('AUTH_CONFIGURATION_REQUIRED')
    const authorization = headerValue(request.headers.authorization)
    const principal = await authentication.authenticate({
      ...(authorization ? { authorization } : {}),
      headers: request.headers,
      now: now(),
    })
    const organizationId = headerValue(request.headers['x-tenant-id'])
    const workspaceId = headerValue(request.headers['x-workspace-id'])
    if (!organizationId || !workspaceId)
      throw new AuthenticationError('RESOURCE_SCOPE_MISSING')
    const resolvedMemberships =
      principal.memberships.length > 0
        ? principal.memberships
        : memberships.membershipsFor(principal.subject, principal.issuer)
    const action: AuthorizationAction =
      coverage.route === '/v1/artifacts/:artifactId' &&
      new URL(request.url, 'http://control-plane.local').searchParams.get(
        'metadata',
      ) === '1'
        ? 'artifact.metadata.read'
        : coverage.action
    const sessionId =
      typeof (request.params as { sessionId?: unknown } | undefined)
        ?.sessionId === 'string'
        ? (request.params as { sessionId: string }).sessionId
        : undefined
    const decision = authorize({
      principal,
      action,
      memberships: resolvedMemberships,
      resource: {
        organizationId,
        workspaceId,
        ...(sessionId ? { sessionId } : {}),
        resourceType: coverage.resourceType,
      },
    })
    store.appendAudit({
      tenantId: organizationId,
      workspaceId,
      sessionId: null,
      actor: 'user',
      actorPrincipalId: opaquePrincipalId(principal),
      action: 'authorization.decided',
      outcome: decision.allow ? 'success' : 'failure',
      idempotencyKey: `authz:${request.id}:${action}`,
      ...auditContext(request),
      metadata: {
        operation: action,
        reasonCode: decision.reasonCode,
        status: decision.allow ? 'allow' : 'deny',
      },
    })
    metrics.record('authorization_decisions_total', 1, {
      action: action.split('.')[0]!,
      outcome: decision.allow ? 'allow' : 'deny',
      reason: decision.reasonCode,
    })
    if (!decision.allow) throw new AuthenticationError('ACCESS_DENIED')
    authContexts.set(request, { principal, memberships: resolvedMemberships })
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthenticationError) {
      const authenticationFailure =
        error.code === 'AUTH_REQUIRED' ||
        error.code.startsWith('TOKEN_') ||
        error.code.startsWith('OIDC_')
      return reply.code(authenticationFailure ? 401 : 403).send({
        code: error.code,
        message: authenticationFailure
          ? 'Authentication is required'
          : 'Access is denied',
      })
    }
    if (error instanceof SupportAccessError) {
      const conflict = error.code === 'VERSION_CONFLICT'
      const missing = error.code.endsWith('_NOT_FOUND')
      return reply.code(missing ? 404 : conflict ? 409 : 403).send({
        code: error.code,
        message: 'Support access request was rejected',
      })
    }
    return reply.send(error)
  })
  app.addHook('onResponse', async (request, reply) => {
    const started =
      (request as typeof request & { wp11StartedAt?: number }).wp11StartedAt ??
      performance.now()
    const route = metricRoute(request.url.split('?')[0]!)
    const method =
      request.method === 'GET' || request.method === 'POST'
        ? request.method
        : 'OTHER'
    const status =
      reply.statusCode >= 500 ? '5xx' : reply.statusCode >= 400 ? '4xx' : '2xx'
    metrics.record('api_request_latency_ms', performance.now() - started, {
      route,
      method,
      status,
    })
    if (status !== '2xx')
      metrics.record('api_errors_total', 1, { route, code: status })
  })

  store.onCommitted((event) => {
    if (event.type === 'approval.requested')
      store.appendAudit({
        ...event,
        actor: 'runtime',
        action: 'approval.requested',
        outcome: 'requested',
        idempotencyKey: `event:${event.eventId}`,
        requestId: String(event.payload.requestId),
        metadata: { approvalKind: event.payload.approvalKind },
      })
    if (event.type === 'turn.completed') {
      const failed = !['completed', 'success'].includes(event.payload.status)
      store.appendAudit({
        ...event,
        actor: 'runtime',
        action: failed ? 'turn.failed' : 'turn.completed',
        outcome: failed ? 'failure' : 'success',
        idempotencyKey: `turn:${event.codexTurnId ?? event.eventId}:completed`,
        metadata: { turnOutcome: event.payload.status },
      })
      if (event.codexTurnId) {
        const key = JSON.stringify([
          event.tenantId,
          event.workspaceId,
          event.codexTurnId,
        ])
        const started = turnStartedAt.get(key)
        if (started !== undefined) {
          metrics.record(
            'turn_duration_ms',
            Math.max(0, now().getTime() - started),
            { outcome: failed ? 'failed' : 'completed' },
          )
          turnStartedAt.delete(key)
        }
      }
    }
    if (event.type === 'token.usage.updated') {
      metrics.record('turn_token_usage_total', event.payload.last.inputTokens, {
        kind: 'input',
      })
      metrics.record(
        'turn_token_usage_total',
        event.payload.last.outputTokens,
        { kind: 'output' },
      )
      metrics.record(
        'turn_token_usage_total',
        event.payload.last.cachedInputTokens,
        { kind: 'cached' },
      )
      metrics.record(
        'turn_token_usage_total',
        event.payload.last.reasoningOutputTokens,
        { kind: 'reasoning' },
      )
    }
  })

  app.addHook('onClose', async () => {
    await orchestrator.close()
    await supportAccess.close()
    if ('close' in corpus && typeof corpus.close === 'function')
      await corpus.close()
    if (ownsStore) store.close()
  })

  app.get('/healthz', async () => ({ status: 'ok' }))
  app.get('/metrics', async () =>
    metricsResponseSchema.parse(metrics.snapshot()),
  )
  app.get('/readyz', async (request, reply) => {
    const scope = workspaceScope(request.headers)
    if (!scope)
      return reply.code(400).send({
        code: 'MISSING_SCOPE',
        message: 'x-tenant-id and x-workspace-id headers are required',
      })
    const timeoutMs = options.readinessProbeTimeoutMs ?? 2_000
    const cwd =
      typeof options.workspaceCwd === 'function'
        ? options.workspaceCwd(scope)
        : (options.workspaceCwd ?? process.cwd())
    const dependencyChecksPromise = Promise.all([
      boundedProbe('database', timeoutMs, () => store.probe()),
      boundedProbe('artifacts', timeoutMs, () => artifacts.probe()),
      boundedProbe('workspace', timeoutMs, () => {
        const stat = lstatSync(cwd)
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('WORKSPACE_UNAVAILABLE')
        realpathSync(cwd)
        accessSync(cwd, constants.R_OK | constants.W_OK | constants.X_OK)
      }),
      boundedProbe('disk', timeoutMs, () => {
        const disk = statfsSync(cwd)
        if (disk.bavail <= 0 || disk.bsize <= 0)
          throw new Error('DISK_UNAVAILABLE')
      }),
    ])
    let readiness
    try {
      ;[readiness] = await Promise.all([
        withProbeTimeout(timeoutMs, () =>
          orchestrator.checkReadiness(
            scope,
            request.headers['x-readiness-retry'] === '1',
          ),
        ),
        dependencyChecksPromise,
      ])
    } catch {
      readiness = readinessResponseSchema.parse({
        status: 'degraded',
        checkedAt: now().toISOString(),
        checks: [
          { name: 'auth', status: 'failed', code: 'AUTH_CHECK_TIMEOUT' },
        ],
        recovery: {
          code: null,
          instruction: null,
          retryable: true,
          readOnlyAvailable: true,
        },
      })
    }
    const dependencyChecks = await dependencyChecksPromise
    const dependencyFailed = dependencyChecks.some(
      (check) => check.status === 'failed',
    )
    const appServer = {
      name: 'appServer' as const,
      status:
        readiness.status === 'degraded'
          ? ('failed' as const)
          : ('ready' as const),
      code: readiness.status === 'degraded' ? 'APP_SERVER_NOT_READY' : null,
    }
    const runtimeIsolation = {
      name: 'runtimeIsolation' as const,
      status: 'ready' as const,
      code:
        securityReadiness.isolationLevel === 'microvm' &&
        securityReadiness.encryptedVolume
          ? null
          : 'DEVELOPMENT_RUNTIME_ONLY',
    }
    const kms = {
      name: 'kms' as const,
      status: 'ready' as const,
      code: securityReadiness.kmsProviderProduction
        ? null
        : 'DEVELOPMENT_KMS_ONLY',
    }
    const encryption = {
      name: 'encryption' as const,
      status: 'ready' as const,
      code: null,
    }
    const status = dependencyFailed ? 'degraded' : readiness.status
    metrics.record('runtime_health', appServer.status === 'ready' ? 1 : 0, {
      state: appServer.status === 'ready' ? 'ready' : 'failed',
    })
    const diskReady =
      dependencyChecks.find((check) => check.name === 'disk')?.status ===
      'ready'
    metrics.record('disk_health', diskReady ? 1 : 0, {
      state: diskReady ? 'ready' : 'failed',
    })
    return reply.code(status === 'ready' ? 200 : 503).send(
      readinessResponseSchema.parse({
        ...readiness,
        status,
        checkedAt: now().toISOString(),
        security: securityReadiness,
        checks: [
          ...dependencyChecks,
          runtimeIsolation,
          kms,
          encryption,
          appServer,
          ...readiness.checks,
        ],
      }),
    )
  })
  app.get('/v1/meta', async () => ({
    service: 'persistent-codex-control-plane',
    phase: 'poc',
    codexVersion: '0.144.2',
    transport: 'stdio-jsonl',
  }))
  app.get('/v1/me', async (request) => {
    const context = authContexts.get(request)!
    return meResponseSchema.parse({
      ...context.principal,
      memberships: context.memberships,
      activeOrganizationId: headerValue(request.headers['x-tenant-id']),
      activeWorkspaceId: headerValue(request.headers['x-workspace-id']),
    })
  })

  app.get<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/support-grants',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply
          .code(400)
          .send({ code: 'MISSING_SCOPE', message: 'Scope is required' })
      store.getSession(scope)
      return supportGrantListResponseSchema.parse({
        grants: await supportAccess.transaction(
          {
            tenantId: scope.tenantId,
            organizationId: scope.tenantId,
            workspaceId: scope.workspaceId,
          },
          (service) =>
            service
              .listGrants({
                organizationId: scope.tenantId,
                workspaceId: scope.workspaceId,
              })
              .filter((grant) => grant.sessionId === scope.sessionId),
        ),
      })
    },
  )

  app.get<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/support-audit',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply
          .code(400)
          .send({ code: 'MISSING_SCOPE', message: 'Scope is required' })
      store.getSession(scope)
      return securityAuditListResponseSchema.parse({
        records: await supportAccess.transaction(
          {
            tenantId: scope.tenantId,
            organizationId: scope.tenantId,
            workspaceId: scope.workspaceId,
          },
          (service) =>
            service
              .listAudit({
                organizationId: scope.tenantId,
                workspaceId: scope.workspaceId,
              })
              .filter(
                (record) =>
                  JSON.parse(record.scope).sessionId === scope.sessionId,
              ),
        ),
        chainValid: await supportAccess.verifyAuditChain({
          tenantId: scope.tenantId,
          organizationId: scope.tenantId,
          workspaceId: scope.workspaceId,
        }),
      })
    },
  )

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/sources',
    async (request, reply) => {
      const scope = supportRepositoryScope(request.headers)
      const encodedName = headerValue(request.headers['x-source-name'])
      const declaredMediaType = headerValue(
        request.headers['x-source-media-type'],
      )
      if (
        !scope ||
        scope.workspaceId !== request.params.workspaceId ||
        !encodedName ||
        !Buffer.isBuffer(request.body)
      )
        return reply.code(400).send({
          code: 'INVALID_SOURCE_REQUEST',
          message: 'Scoped source name and binary body are required',
        })
      try {
        const metadata = sourceUploadMetadataSchema.parse({
          version: 1,
          displayName: decodeURIComponent(encodedName),
          ...(declaredMediaType ? { declaredMediaType } : {}),
          provenance: { kind: 'upload', workspacePath: null },
        })
        const created = await corpus.createSource({
          scope,
          name: metadata.displayName,
          ...(metadata.declaredMediaType
            ? { declaredMediaType: metadata.declaredMediaType }
            : {}),
          chunks: singleChunk(request.body),
        })
        if (options.corpusAutoDrain !== false)
          setImmediate(() => scheduleCorpusDrain(scope))
        return reply.code(201).send(createSourceResponseSchema.parse(created))
      } catch (error) {
        if (error instanceof Error && error.name === 'ZodError')
          return reply.code(400).send({
            code: 'INVALID_SOURCE_METADATA',
            message: 'Source metadata is invalid',
          })
        if (error instanceof URIError)
          return reply.code(400).send({
            code: 'INVALID_SOURCE_NAME',
            message: 'Source name encoding is invalid',
          })
        if (error instanceof CorpusError)
          return reply
            .code(error.code === 'SOURCE_TOO_LARGE' ? 413 : 400)
            .send({
              code: error.code,
              message: error.message,
            })
        throw error
      }
    },
  )

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/sources',
    async (request, reply) => {
      const scope = supportRepositoryScope(request.headers)
      if (!scope || scope.workspaceId !== request.params.workspaceId)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'Workspace scope is required',
        })
      return sourceListResponseSchema.parse({
        sources: await corpus.listSources(scope),
      })
    },
  )

  app.get<{ Params: { workspaceId: string; sourceId: string } }>(
    '/v1/workspaces/:workspaceId/sources/:sourceId',
    async (request, reply) => {
      const scope = supportRepositoryScope(request.headers)
      if (!scope || scope.workspaceId !== request.params.workspaceId)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'Workspace scope is required',
        })
      try {
        return sourceDetailResponseSchema.parse(
          await corpus.sourceDetail(scope, request.params.sourceId),
        )
      } catch (error) {
        if (error instanceof CorpusError)
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        throw error
      }
    },
  )

  app.delete<{ Params: { workspaceId: string; sourceId: string } }>(
    '/v1/workspaces/:workspaceId/sources/:sourceId',
    async (request, reply) => {
      const scope = supportRepositoryScope(request.headers)
      if (!scope || scope.workspaceId !== request.params.workspaceId)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'Workspace scope is required',
        })
      try {
        await corpus.deleteSource(scope, request.params.sourceId)
        return reply.code(204).send()
      } catch (error) {
        if (error instanceof CorpusError)
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        throw error
      }
    },
  )

  app.post<{ Params: { workspaceId: string; sourceId: string } }>(
    '/v1/workspaces/:workspaceId/sources/:sourceId/reindex',
    async (request, reply) => {
      const scope = supportRepositoryScope(request.headers)
      if (!scope || scope.workspaceId !== request.params.workspaceId)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'Workspace scope is required',
        })
      try {
        const job = await corpus.reindexSource(scope, request.params.sourceId)
        if (options.corpusAutoDrain !== false)
          setImmediate(() => scheduleCorpusDrain(scope))
        return reply.code(202).send(job)
      } catch (error) {
        if (error instanceof CorpusError)
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        throw error
      }
    },
  )

  app.post<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/support-grants',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply
          .code(400)
          .send({ code: 'MISSING_SCOPE', message: 'Scope is required' })
      store.getSession(scope)
      const body = createSupportGrantRequestSchema.parse(request.body)
      const context = authContexts.get(request)!
      const actor = supportActor(
        context.principal,
        context.memberships,
        scope.tenantId,
      )
      const repositoryScope = {
        tenantId: scope.tenantId,
        organizationId: scope.tenantId,
        workspaceId: scope.workspaceId,
      }
      const grant = await supportAccess.transaction(
        repositoryScope,
        (service) => {
          let created = service.createGrant({
            tenantId: scope.tenantId,
            organizationId: scope.tenantId,
            workspaceId: scope.workspaceId,
            sessionId: body.sessionId ?? scope.sessionId,
            ...(body.artifactId !== undefined
              ? { artifactId: body.artifactId }
              : {}),
            ...(body.attachmentId !== undefined
              ? { attachmentId: body.attachmentId }
              : {}),
            actions: body.actions,
            reason: body.reason,
            requester: actor,
            supportPrincipalId: body.supportPrincipalId,
            durationMinutes: body.durationMinutes,
            idempotencyKey:
              headerValue(request.headers['idempotency-key']) ?? request.id,
            correlationId: auditContext(request).correlationId ?? request.id,
          })
          if (context.principal.assurance.mfa)
            created = service.verifyGrantMfa({
              grantId: created.grantId,
              actor,
              mfaEvidenceId: `oidc:${context.principal.authenticatedAt}`,
              expectedVersion: created.version,
              idempotencyKey: `oidc-mfa:${created.grantId}`,
              correlationId: auditContext(request).correlationId ?? request.id,
            })
          return created
        },
      )
      return reply.code(201).send(supportGrantSchema.parse(grant))
    },
  )

  app.post<{ Params: { grantId: string } }>(
    '/v1/support-grants/:grantId/mfa',
    async (request) => {
      const body = supportGrantDecisionRequestSchema
        .pick({ expectedVersion: true, mfaEvidenceId: true })
        .parse(request.body)
      const context = authContexts.get(request)!
      const organizationId = headerValue(request.headers['x-tenant-id'])!
      if (!context.principal.assurance.mfa)
        throw new SupportAccessError('STRONG_MFA_REQUIRED')
      return supportGrantSchema.parse(
        await supportAccess.transaction(
          supportRepositoryScope(request.headers)!,
          (service) =>
            service.verifyGrantMfa({
              grantId: request.params.grantId,
              actor: supportActor(
                context.principal,
                context.memberships,
                organizationId,
              ),
              mfaEvidenceId: body.mfaEvidenceId,
              expectedVersion: body.expectedVersion,
              idempotencyKey:
                headerValue(request.headers['idempotency-key']) ?? request.id,
              correlationId: auditContext(request).correlationId ?? request.id,
            }),
        ),
      )
    },
  )

  app.post<{ Params: { grantId: string } }>(
    '/v1/support-grants/:grantId/decision',
    async (request) => {
      const body = supportGrantDecisionRequestSchema.parse(request.body)
      const context = authContexts.get(request)!
      const organizationId = headerValue(request.headers['x-tenant-id'])!
      if (!context.principal.assurance.mfa)
        throw new SupportAccessError('STRONG_MFA_REQUIRED')
      return supportGrantSchema.parse(
        await supportAccess.transaction(
          supportRepositoryScope(request.headers)!,
          (service) =>
            service.decideGrant({
              grantId: request.params.grantId,
              actor: supportActor(
                context.principal,
                context.memberships,
                organizationId,
              ),
              decision: body.decision,
              expectedVersion: body.expectedVersion,
              idempotencyKey:
                headerValue(request.headers['idempotency-key']) ?? request.id,
              mfaEvidenceId: body.mfaEvidenceId,
              correlationId: auditContext(request).correlationId ?? request.id,
            }),
        ),
      )
    },
  )

  app.post<{ Params: { grantId: string } }>(
    '/v1/support-grants/:grantId/revoke',
    async (request) => {
      const body = supportGrantRevokeRequestSchema.parse(request.body)
      const context = authContexts.get(request)!
      const organizationId = headerValue(request.headers['x-tenant-id'])!
      return supportGrantSchema.parse(
        await supportAccess.transaction(
          supportRepositoryScope(request.headers)!,
          (service) =>
            service.revokeGrant({
              grantId: request.params.grantId,
              actor: supportActor(
                context.principal,
                context.memberships,
                organizationId,
              ),
              expectedVersion: body.expectedVersion,
              idempotencyKey:
                headerValue(request.headers['idempotency-key']) ?? request.id,
              correlationId: auditContext(request).correlationId ?? request.id,
            }),
        ),
      )
    },
  )

  app.post('/v1/support-access/leases', async (request) => {
    const body = jitLeaseIssueRequestSchema.parse(request.body)
    const scope = supportRepositoryScope(request.headers)!
    const context = authContexts.get(request)!
    const actor = supportActor(
      context.principal,
      context.memberships,
      scope.organizationId,
    )
    const issued = await supportAccess.transaction(scope, (service) =>
      body.grantId
        ? service.issueLease({
            grantId: body.grantId,
            actor,
            sessionId: body.sessionId,
            objectId: body.objectId,
            action: body.action,
            idempotencyKey:
              headerValue(request.headers['idempotency-key']) ?? request.id,
            correlationId: auditContext(request).correlationId ?? request.id,
          })
        : service.issueBreakGlassLease({
            breakGlassId: body.breakGlassId!,
            actor,
            sessionId: body.sessionId!,
            objectId: body.objectId!,
            action: body.action,
            idempotencyKey:
              headerValue(request.headers['idempotency-key']) ?? request.id,
            correlationId: auditContext(request).correlationId ?? request.id,
          }),
    )
    return jitLeaseIssueResponseSchema.parse({
      ...issued,
      lease: { schemaVersion: 1, ...issued.lease },
    })
  })

  app.post<{ Params: { leaseId: string } }>(
    '/v1/support-access/leases/:leaseId/consume',
    async (request) => {
      const body = jitLeaseConsumeRequestSchema.parse(request.body)
      const scope = supportRepositoryScope(request.headers)!
      const context = authContexts.get(request)!
      const actor = supportActor(
        context.principal,
        context.memberships,
        scope.organizationId,
      )
      if (body.action === 'content.decrypt' && !options.decryptSupportContent)
        throw new SupportAccessError('KMS_DECRYPT_PORT_REQUIRED')
      return supportAccess.transaction(scope, async (service) => {
        service.consumeLease({
          leaseId: request.params.leaseId,
          token: body.token,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          sessionId: body.sessionId,
          objectId: body.objectId,
          action: body.action,
          principalId: actor.principalId,
          correlationId: auditContext(request).correlationId ?? request.id,
        })
        if (body.action === 'content.view') {
          const events = store.replaySessionEvents(
            {
              tenantId: scope.tenantId,
              workspaceId: scope.workspaceId,
              sessionId: body.sessionId!,
            },
            0,
            500,
          )
          return protectedContentResponseSchema.parse({
            schemaVersion: 1,
            action: body.action,
            mediaType: 'application/json',
            encoding: 'json',
            content: events,
          })
        }
        if (body.action === 'artifact.download') {
          const stream = artifacts.openReadStream(body.objectId!, scope)
          const chunks: Buffer[] = []
          for await (const chunk of stream) chunks.push(Buffer.from(chunk))
          return protectedContentResponseSchema.parse({
            schemaVersion: 1,
            action: body.action,
            mediaType: 'application/octet-stream',
            encoding: 'base64',
            content: Buffer.concat(chunks).toString('base64'),
          })
        }
        if (body.action === 'attachment.download') {
          const attachment = attachments.resolve(
            {
              tenantId: scope.tenantId,
              workspaceId: scope.workspaceId,
              sessionId: body.sessionId!,
            },
            body.objectId!,
          )
          return protectedContentResponseSchema.parse({
            schemaVersion: 1,
            action: body.action,
            mediaType: attachment.mediaType,
            encoding: 'base64',
            content: readFileSync(attachment.path).toString('base64'),
          })
        }
        return protectedContentResponseSchema.parse({
          schemaVersion: 1,
          action: body.action,
          mediaType: 'text/plain; charset=utf-8',
          encoding: 'utf8',
          content: await options.decryptSupportContent!({
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            sessionId: body.sessionId,
            objectId: body.objectId,
          }),
        })
      })
    },
  )

  app.post('/v1/break-glass', async (request, reply) => {
    const body = createBreakGlassRequestSchema.parse(request.body)
    const scope = supportRepositoryScope(request.headers)!
    const context = authContexts.get(request)!
    const actor = supportActor(
      context.principal,
      context.memberships,
      scope.organizationId,
    )
    const created = await supportAccess.transaction(scope, (service) => {
      let value = service.createBreakGlass({
        ...scope,
        sessionId: body.sessionId,
        objectId: body.objectId,
        actions: body.actions,
        incidentId: body.incidentId,
        reason: body.reason,
        requester: actor,
        durationMinutes: body.durationMinutes,
        idempotencyKey:
          headerValue(request.headers['idempotency-key']) ?? request.id,
        correlationId: auditContext(request).correlationId ?? request.id,
      })
      if (context.principal.assurance.mfa)
        value = service.verifyBreakGlassMfa({
          breakGlassId: value.breakGlassId,
          actor,
          mfaEvidenceId: `oidc:${context.principal.authenticatedAt}`,
          expectedVersion: value.version,
          idempotencyKey: `oidc-mfa:${value.breakGlassId}`,
          correlationId: auditContext(request).correlationId ?? request.id,
        })
      return value
    })
    return reply.code(201).send(breakGlassRequestSchema.parse(created))
  })

  app.post<{ Params: { breakGlassId: string } }>(
    '/v1/break-glass/:breakGlassId/mfa',
    async (request) => {
      const body = supportMfaRequestSchema.parse(request.body)
      const scope = supportRepositoryScope(request.headers)!
      const context = authContexts.get(request)!
      if (!context.principal.assurance.mfa)
        throw new SupportAccessError('STRONG_MFA_REQUIRED')
      return breakGlassRequestSchema.parse(
        await supportAccess.transaction(scope, (service) =>
          service.verifyBreakGlassMfa({
            breakGlassId: request.params.breakGlassId,
            actor: supportActor(
              context.principal,
              context.memberships,
              scope.organizationId,
            ),
            mfaEvidenceId: body.mfaEvidenceId,
            expectedVersion: body.expectedVersion,
            idempotencyKey:
              headerValue(request.headers['idempotency-key']) ?? request.id,
            correlationId: auditContext(request).correlationId ?? request.id,
          }),
        ),
      )
    },
  )

  app.post<{ Params: { breakGlassId: string } }>(
    '/v1/break-glass/:breakGlassId/approve',
    async (request) => {
      const body = supportApprovalRequestSchema.parse(request.body)
      const scope = supportRepositoryScope(request.headers)!
      const context = authContexts.get(request)!
      if (!context.principal.assurance.mfa)
        throw new SupportAccessError('STRONG_MFA_REQUIRED')
      return breakGlassRequestSchema.parse(
        await supportAccess.transaction(scope, (service) =>
          service.approveBreakGlass({
            breakGlassId: request.params.breakGlassId,
            actor: supportActor(
              context.principal,
              context.memberships,
              scope.organizationId,
            ),
            expectedVersion: body.expectedVersion,
            mfaEvidenceId: body.mfaEvidenceId,
            idempotencyKey:
              headerValue(request.headers['idempotency-key']) ?? request.id,
            correlationId: auditContext(request).correlationId ?? request.id,
          }),
        ),
      )
    },
  )

  app.post<{ Params: { breakGlassId: string } }>(
    '/v1/break-glass/:breakGlassId/revoke',
    async (request) => {
      const body = supportRevokeRequestSchema.parse(request.body)
      const scope = supportRepositoryScope(request.headers)!
      const context = authContexts.get(request)!
      return breakGlassRequestSchema.parse(
        await supportAccess.transaction(scope, (service) =>
          service.revokeBreakGlass({
            breakGlassId: request.params.breakGlassId,
            actor: supportActor(
              context.principal,
              context.memberships,
              scope.organizationId,
            ),
            expectedVersion: body.expectedVersion,
            idempotencyKey:
              headerValue(request.headers['idempotency-key']) ?? request.id,
            correlationId: auditContext(request).correlationId ?? request.id,
          }),
        ),
      )
    },
  )

  app.post<{ Params: { outboxId: string } }>(
    '/v1/security-outbox/:outboxId/result',
    async (request) => {
      const body = outboxDeliveryResultRequestSchema.parse(request.body)
      const scope = supportRepositoryScope(request.headers)!
      return securityOutboxRecordSchema.parse(
        await supportAccess.transaction(scope, (service) =>
          body.delivered
            ? service.deliverOutbox(
                request.params.outboxId,
                headerValue(request.headers['idempotency-key']) ?? request.id,
              )
            : service.failOutbox(
                request.params.outboxId,
                body.retryAt ??
                  new Date(now().getTime() + 60_000).toISOString(),
                headerValue(request.headers['idempotency-key']) ?? request.id,
              ),
        ),
      )
    },
  )

  app.get<{
    Params: { sessionId: string }
    Querystring: { cursor?: string; limit?: string }
  }>('/v1/sessions/:sessionId/audit', async (request, reply) => {
    const scope = requestScope(request.headers, request.params.sessionId)
    if (!scope)
      return reply.code(400).send({
        code: 'MISSING_SCOPE',
        message: 'x-tenant-id and x-workspace-id headers are required',
      })
    const limit =
      request.query.limit === undefined ? 25 : parseLimit(request.query.limit)
    let cursor: number | undefined
    if (request.query.cursor) {
      try {
        const decoded = Buffer.from(
          request.query.cursor,
          'base64url',
        ).toString()
        if (!/^[1-9]\d*$/.test(decoded)) throw new Error('invalid')
        cursor = Number(decoded)
      } catch {
        return reply
          .code(400)
          .send({ code: 'INVALID_CURSOR', message: 'cursor is invalid' })
      }
    }
    if (!limit || limit > 100)
      return reply.code(400).send({
        code: 'INVALID_LIMIT',
        message: 'limit must be between 1 and 100',
      })
    try {
      store.getSession(scope)
      const page = store.listAudit(scope, {
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      })
      return auditListResponseSchema.parse({
        records: page.records,
        nextCursor: page.nextCursor
          ? Buffer.from(String(page.nextCursor)).toString('base64url')
          : null,
        staleAfter: new Date(now().getTime() + 30_000).toISOString(),
      })
    } catch (error) {
      if (error instanceof StoreNotFoundError)
        return reply
          .code(404)
          .send({ code: error.code, message: error.message })
      throw error
    }
  })

  app.get<{
    Params: { artifactId: string }
    Querystring: { metadata?: string }
  }>('/v1/artifacts/:artifactId', async (request, reply) => {
    const scope = workspaceScope(request.headers)
    if (!scope)
      return reply.code(400).send({
        code: 'MISSING_SCOPE',
        message: 'x-tenant-id and x-workspace-id headers are required',
      })
    const context = authContexts.get(request)!
    const actor = supportActor(
      context.principal,
      context.memberships,
      scope.tenantId,
    )
    if (request.query.metadata !== '1' && actor.role !== 'tenant_user')
      return reply.code(403).send({
        code: 'JIT_LEASE_REQUIRED',
        message: 'Protected artifact content requires a consumed JIT lease',
      })
    try {
      const metadata = store.getArtifact(scope, request.params.artifactId)
      store.appendAudit({
        ...metadata,
        actor: 'user',
        actorPrincipalId:
          authContexts.get(request) === undefined
            ? null
            : opaquePrincipalId(authContexts.get(request)!.principal),
        action: 'artifact.accessed',
        outcome: 'success',
        idempotencyKey: `artifact:${request.id}`,
        ...auditContext(request),
        metadata: {
          artifactKind: metadata.kind,
          operation: request.query.metadata === '1' ? 'metadata' : 'download',
          byteBucket:
            metadata.byteLength < 65_536
              ? 'small'
              : metadata.byteLength < 1_048_576
                ? 'medium'
                : 'large',
        },
      })
      metrics.record('artifacts_total', 1, {
        kind: metadata.kind,
        status: 'accessed',
      })
      metrics.record('artifact_bytes_total', metadata.byteLength, {
        kind: metadata.kind,
        status: 'accessed',
      })
      if (request.query.metadata === '1')
        return artifactMetadataSchema.parse({
          ...metadata,
          downloadUrl: `/v1/artifacts/${encodeURIComponent(metadata.artifactId)}`,
        })
      const range = headerValue(request.headers.range)
      let selected: { start: number; end: number } | undefined
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range)
        if (!match) return reply.code(416).send()
        const start = Number(match[1])
        const end = match[2] ? Number(match[2]) : metadata.byteLength - 1
        if (start > end || end >= metadata.byteLength)
          return reply.code(416).send()
        selected = { start, end }
      }
      const body = artifacts.openReadStream(
        request.params.artifactId,
        scope,
        selected,
      )
      reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="command-output-${request.params.artifactId}.txt"`,
        )
        .header('accept-ranges', 'bytes')
        .header('cache-control', 'private, no-store')
      if (selected)
        reply
          .code(206)
          .header(
            'content-range',
            `bytes ${selected.start}-${selected.end}/${metadata.byteLength}`,
          )
      return reply.send(body)
    } catch {
      return reply
        .code(404)
        .send({ code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found' })
    }
  })

  app.post<{ Params: { artifactId: string } }>(
    '/v1/artifacts/:artifactId/download-token',
    async (request, reply) => {
      const scope = workspaceScope(request.headers)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      const context = authContexts.get(request)!
      const actor = supportActor(
        context.principal,
        context.memberships,
        scope.tenantId,
      )
      if (actor.role !== 'tenant_user')
        return reply.code(403).send({
          code: 'JIT_LEASE_REQUIRED',
          message: 'Protected artifact content requires a consumed JIT lease',
        })
      try {
        store.getArtifact(scope, request.params.artifactId)
        const token = randomBytes(32).toString('base64url')
        const expiresAt = now().getTime() + 60_000
        downloadTokens.set(token, {
          ...scope,
          artifactId: request.params.artifactId,
          expiresAt,
        })
        return artifactDownloadTokenSchema.parse({
          downloadUrl: `/v1/artifact-downloads/${token}`,
          expiresAt: new Date(expiresAt).toISOString(),
        })
      } catch {
        return reply
          .code(404)
          .send({ code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found' })
      }
    },
  )
  app.get<{ Params: { token: string } }>(
    '/v1/artifact-downloads/:token',
    async (request, reply) => {
      const grant = downloadTokens.get(request.params.token)
      downloadTokens.delete(request.params.token)
      if (!grant || grant.expiresAt < now().getTime())
        return reply
          .code(404)
          .send({ code: 'DOWNLOAD_NOT_FOUND', message: 'Download not found' })
      if (request.headers.range)
        return reply
          .code(416)
          .send({ code: 'RANGE_NOT_GRANTED', message: 'Range was not granted' })
      try {
        const metadata = store.getArtifact(grant, grant.artifactId)
        store.appendAudit({
          ...metadata,
          actor: 'user',
          action: 'artifact.accessed',
          outcome: 'success',
          idempotencyKey: `artifact-grant:${request.id}`,
          requestId: safeCorrelation(request.id),
          metadata: {
            artifactKind: metadata.kind,
            operation: 'download-grant',
            byteBucket:
              metadata.byteLength < 65_536
                ? 'small'
                : metadata.byteLength < 1_048_576
                  ? 'medium'
                  : 'large',
          },
        })
        reply
          .header('content-type', 'text/plain; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="command-output-${grant.artifactId}.txt"`,
          )
          .header('cache-control', 'private, no-store')
        return reply.send(artifacts.openReadStream(grant.artifactId, grant))
      } catch {
        return reply
          .code(404)
          .send({ code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found' })
      }
    },
  )

  app.get<{ Querystring: { status?: string } }>(
    '/v1/approvals',
    async (request, reply) => {
      const scope = workspaceScope(request.headers)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      const status = request.query.status ?? 'pending'
      if (
        !['pending', 'resolving', 'resolved', 'expired', 'superseded'].includes(
          status,
        )
      )
        return reply.code(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid approval status',
        })
      return approvalListResponseSchema.parse({
        approvals: store.listApprovals(scope, status as never),
      })
    },
  )

  app.get<{ Params: { approvalId: string } }>(
    '/v1/approvals/:approvalId',
    async (request, reply) => {
      const scope = workspaceScope(request.headers)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      try {
        return approvalSchema.parse(
          store.getApproval(scope, request.params.approvalId),
        )
      } catch (error) {
        if (error instanceof StoreError)
          return reply
            .code(404)
            .send({ code: 'APPROVAL_NOT_FOUND', message: error.message })
        throw error
      }
    },
  )

  app.post<{ Params: { approvalId: string } }>(
    '/v1/approvals/:approvalId/decision',
    async (request, reply) => {
      const scope = workspaceScope(request.headers)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      const key = headerValue(request.headers['idempotency-key'])
      if (!key?.trim())
        return reply.code(400).send({
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required',
        })
      const body = approvalDecisionRequestSchema.safeParse(request.body)
      if (!body.success)
        return reply.code(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Approval decision is invalid',
          issues: body.error.issues.map((i) => i.message),
        })
      const hash = createHash('sha256')
        .update(JSON.stringify(body.data))
        .digest('hex')
      try {
        const reservation = store.reserveIdempotencyKey({
          ...scope,
          scope: `approval:${request.params.approvalId}`,
          key,
          requestHash: hash,
        })
        if (!reservation.created && reservation.record.status === 'completed')
          return approvalSchema.parse(reservation.record.response)
        const result = await orchestrator.decideApproval({
          ...scope,
          approvalId: request.params.approvalId,
          decision: body.data.decision,
          expectedVersion: body.data.expectedVersion,
          userId: body.data.clientContext?.deviceId ?? 'poc-user',
          ...auditContext(request),
        })
        const safe = approvalSchema.parse(result)
        store.completeIdempotencyKey({
          ...scope,
          scope: `approval:${request.params.approvalId}`,
          key,
          status: 'completed',
          response: safe,
        })
        metrics.record(
          'approval_wait_ms',
          Math.max(0, now().getTime() - Date.parse(safe.requestedAt)),
          { outcome: safe.selectedDecision! },
        )
        return safe
      } catch (error) {
        if (error instanceof StoreConflictError)
          return reply
            .code(409)
            .send({ code: error.code, message: error.message })
        if (error instanceof StoreError)
          return reply
            .code(error.code === 'APPROVAL_NOT_FOUND' ? 404 : 400)
            .send({ code: error.code, message: error.message })
        if (error instanceof OrchestrationError)
          return reply
            .code(error.statusCode)
            .send({ code: error.code, message: error.message })
        throw error
      }
    },
  )

  app.post('/v1/sessions', async (request, reply) => {
    const scope = workspaceScope(request.headers)
    if (!scope) {
      return reply.code(400).send(
        apiErrorResponseSchema.parse({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        }),
      )
    }
    const body = createSessionRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return reply.code(400).send(
        apiErrorResponseSchema.parse({
          code: 'VALIDATION_ERROR',
          message: 'Session request body is invalid',
          issues: body.error.issues.map((issue) => issue.message),
        }),
      )
    }
    try {
      if (
        body.data.folderId &&
        !store
          .listConversationFolders(scope)
          .some(
            (folder) =>
              folder.folderId === body.data.folderId && !folder.archivedAt,
          )
      )
        return reply.code(404).send({
          code: 'FOLDER_NOT_FOUND',
          message: 'Conversation folder was not found',
        })
      const created = await orchestrator.createSession({
        ...scope,
        provider: body.data.provider,
        ...(body.data.model ? { model: body.data.model } : {}),
        ...(body.data.folderId !== undefined
          ? { folderId: body.data.folderId }
          : {}),
        ...(body.data.title ? { title: body.data.title } : {}),
      })
      store.appendAudit({
        ...created,
        actor: 'user',
        action: 'session.created',
        outcome: 'success',
        idempotencyKey: `session:${created.sessionId}:created`,
        ...auditContext(request),
        metadata: { toState: created.status },
      })
      store.appendAudit({
        ...created,
        actor: 'system',
        action: 'session.lifecycle_changed',
        outcome: 'success',
        idempotencyKey: `session:${created.sessionId}:active`,
        ...auditContext(request),
        metadata: { fromState: 'starting', toState: created.status },
      })
      return reply.code(201).send(created)
    } catch (error) {
      const failure =
        error instanceof OrchestrationError
          ? error
          : new OrchestrationError('SESSION_START_FAILED', String(error))
      return reply.code(failure.statusCode).send(
        apiErrorResponseSchema.parse({
          code: failure.code,
          message: failure.message,
        }),
      )
    }
  })

  app.get('/v1/provider-catalogs', async (request, reply) => {
    const scope = workspaceScope(request.headers)
    if (!scope)
      return reply.code(400).send({
        code: 'MISSING_SCOPE',
        message: 'x-tenant-id and x-workspace-id headers are required',
      })
    return providerCatalogListResponseSchema.parse({
      catalogs: await orchestrator.listProviderCatalogs(scope),
      readiness: await orchestrator.listProviderReadiness(scope),
    })
  })

  app.get('/v1/conversation-folders', async (request, reply) => {
    const scope = workspaceScope(request.headers)
    if (!scope)
      return reply.code(400).send({
        code: 'MISSING_SCOPE',
        message: 'x-tenant-id and x-workspace-id headers are required',
      })
    return conversationFolderListResponseSchema.parse({
      folders: store.listConversationFolders(scope),
    })
  })

  app.post('/v1/conversation-folders', async (request, reply) => {
    const scope = workspaceScope(request.headers)
    if (!scope)
      return reply.code(400).send({
        code: 'MISSING_SCOPE',
        message: 'x-tenant-id and x-workspace-id headers are required',
      })
    const body = createConversationFolderRequestSchema.safeParse(
      request.body ?? {},
    )
    if (!body.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Folder request body is invalid',
      })
    return reply.code(201).send(
      conversationFolderSchema.parse(
        store.createConversationFolder({
          ...scope,
          folderId: `fol_${randomBytes(12).toString('hex')}`,
          name: body.data.name,
        }),
      ),
    )
  })

  app.patch<{ Params: { folderId: string } }>(
    '/v1/conversation-folders/:folderId',
    async (request, reply) => {
      const scope = workspaceScope(request.headers)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      const body = updateConversationFolderRequestSchema.safeParse(
        request.body ?? {},
      )
      if (!body.success)
        return reply.code(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Folder update is invalid',
        })
      try {
        return conversationFolderSchema.parse(
          store.setConversationFolderArchived(
            { ...scope, folderId: request.params.folderId },
            body.data.archived,
          ),
        )
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply.code(404).send({
            code: error.code,
            message: error.message,
          })
        throw error
      }
    },
  )

  app.delete<{ Params: { folderId: string } }>(
    '/v1/conversation-folders/:folderId',
    async (request, reply) => {
      const scope = workspaceScope(request.headers)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      try {
        store.deleteConversationFolder({
          ...scope,
          folderId: request.params.folderId,
        })
        return reply.code(204).send()
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply.code(404).send({
            code: error.code,
            message: error.message,
          })
        throw error
      }
    },
  )

  app.patch<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/conversation',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      const body = updateConversationRequestSchema.safeParse(request.body ?? {})
      if (!body.success)
        return reply.code(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Conversation update is invalid',
        })
      if (
        body.data.folderId &&
        !store
          .listConversationFolders(scope)
          .some(
            (folder) =>
              folder.folderId === body.data.folderId && !folder.archivedAt,
          )
      )
        return reply.code(404).send({
          code: 'FOLDER_NOT_FOUND',
          message: 'Conversation folder was not found',
        })
      try {
        const changes = {
          ...(body.data.folderId !== undefined
            ? { folderId: body.data.folderId }
            : {}),
          ...(body.data.title !== undefined ? { title: body.data.title } : {}),
        }
        return sessionResponseSchema.parse({
          ...orchestrator.getSession(scope),
          ...store.updateConversation(scope, changes),
        })
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply.code(404).send({
            code: error.code,
            message: error.message,
          })
        throw error
      }
    },
  )

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/v1/sessions',
    async (request, reply) => {
      const scope = workspaceScope(request.headers)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      const limit =
        request.query.limit === undefined ? 20 : parseLimit(request.query.limit)
      const cursor = decodeSessionCursor(request.query.cursor)
      if (!limit || limit > 100)
        return reply.code(400).send({
          code: 'INVALID_LIMIT',
          message: 'limit must be between 1 and 100',
        })
      if (cursor === null)
        return reply
          .code(400)
          .send({ code: 'INVALID_CURSOR', message: 'cursor is invalid' })
      const page = store.listRecentSessions(scope, limit, cursor)
      const last = page.sessions.at(-1)
      return sessionListResponseSchema.parse({
        sessions: page.sessions,
        nextCursor:
          page.hasMore && last
            ? encodeSessionCursor({
                updatedAt: last.updatedAt,
                sessionId: last.sessionId,
              })
            : null,
      })
    },
  )

  app.get<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      try {
        return sessionResponseSchema.parse(orchestrator.getSession(scope))
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        throw error
      }
    },
  )

  app.get<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/usage',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      try {
        store.getSession(scope)
        return conversationUsageCostSchema.parse(
          store.getConversationUsageCost(scope),
        )
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        throw error
      }
    },
  )

  app.get<{ Params: { sessionId: string; turnId: string } }>(
    '/v1/sessions/:sessionId/turns/:turnId/usage',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      try {
        store.getTurn(scope, request.params.turnId)
        return usageCostSummarySchema.parse(
          store.getUsageSummary(scope, request.params.turnId),
        )
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        throw error
      }
    },
  )

  app.post<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/usage/reconcile',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      try {
        const session = store.getSession(scope)
        const candidates = store.listUsageReconciliationCandidates(scope)
        if (candidates.length === 0)
          return usageReconciliationResponseSchema.parse({
            status:
              store.getUsageSummary(scope).reconciliationStatus === 'reconciled'
                ? 'reconciled'
                : session.provider === 'gemini' || session.provider === 'cursor'
                  ? 'unsupported'
                  : 'unavailable',
            provider: session.provider,
            reconciledItems: 0,
            message:
              store.getUsageSummary(scope).reconciliationStatus === 'reconciled'
                ? 'All measured usage is already reconciled'
                : 'No measured usage is ready for reconciliation',
          })
        const port = options.costReconciliationPorts?.[session.provider]
        if (!port)
          return usageReconciliationResponseSchema.parse({
            status:
              session.provider === 'gemini' || session.provider === 'cursor'
                ? 'unsupported'
                : 'unavailable',
            provider: session.provider,
            reconciledItems: 0,
            message:
              session.provider === 'gemini' || session.provider === 'cursor'
                ? `${session.provider} does not expose a provider cost source with turn-safe attribution`
                : 'A separate server-side admin/usage credential and dedicated attribution scope are required',
          })
        let reconciledItems = 0
        for (const candidate of candidates) {
          const results = await port.reconcile({
            provider: candidate.provider,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            sessionId: scope.sessionId,
            turnId: candidate.turnId,
            from: candidate.from,
            to: candidate.to,
          })
          for (const result of results) {
            const sourceHash = createHash('sha256')
              .update(result.sourceReference)
              .digest('hex')
            store.appendUsageReconciliation({
              ...scope,
              turnId: candidate.turnId,
              provider: candidate.provider,
              modelId: candidate.modelId,
              purpose: candidate.purpose,
              dedupeKey: `official:${candidate.provider}:${candidate.turnId}:${sourceHash}`,
              result,
            })
          }
          reconciledItems += 1
        }
        return usageReconciliationResponseSchema.parse({
          status: 'reconciled',
          provider: session.provider,
          reconciledItems,
          message: 'Official provider cost records were appended idempotently',
        })
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        request.log.warn(
          { code: 'PROVIDER_COST_RECONCILIATION_FAILED' },
          'provider cost reconciliation failed',
        )
        return usageReconciliationResponseSchema.parse({
          status: 'unavailable',
          provider: null,
          reconciledItems: 0,
          message:
            'Official provider cost is currently unavailable; estimated usage remains authoritative',
        })
      }
    },
  )

  app.get<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/git-snapshots',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      try {
        store.getSession(scope)
        return gitSnapshotListResponseSchema.parse({
          snapshots: store.listGitSnapshots(scope).map((snapshot) => ({
            ...snapshot,
            stale: Date.now() - Date.parse(snapshot.capturedAt) > 30_000,
          })),
        })
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        throw error
      }
    },
  )

  app.post<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/git-snapshots/refresh',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      const idempotencyKey = headerValue(request.headers['idempotency-key'])
      if (!idempotencyKey?.trim())
        return reply.code(400).send({
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required',
        })
      if (!createSessionRequestSchema.safeParse(request.body ?? {}).success)
        return reply.code(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Git refresh does not accept cwd, arguments, or operations',
        })
      try {
        const snapshot = await orchestrator.captureGitSnapshot(
          scope,
          'refresh',
          null,
          `refresh:${idempotencyKey}`,
        )
        store.appendAudit({
          ...scope,
          actor: 'user',
          action: 'git.snapshot_refreshed',
          outcome: 'success',
          idempotencyKey: `git-refresh:${idempotencyKey}`,
          ...auditContext(request),
          metadata: { phase: 'refresh', operation: 'snapshot' },
        })
        return gitSnapshotSchema.parse({ ...snapshot, stale: false })
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        return reply.code(503).send({
          code: 'GIT_SNAPSHOT_FAILED',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  )

  app.post<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/resume',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      const key = headerValue(request.headers['idempotency-key'])
      if (!key?.trim())
        return reply.code(400).send({
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required',
        })
      try {
        const resumed = sessionResponseSchema.parse(
          await orchestrator.resumeSession(scope, key),
        )
        store.appendAudit({
          ...scope,
          actor: 'runtime',
          action: 'runtime.restarted',
          outcome: 'success',
          idempotencyKey: `runtime-recovery:${key}:ready`,
          ...auditContext(request),
          metadata: {
            runtimeState: 'ready',
            processGeneration: resumed.runtimeGeneration,
            operation: 'resume',
          },
        })
        metrics.record('app_server_restarts_total', 1, { outcome: 'ready' })
        return resumed
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        if (error instanceof StoreConflictError)
          return reply
            .code(409)
            .send({ code: error.code, message: error.message })
        if (error instanceof OrchestrationError)
          return reply
            .code(error.statusCode)
            .send({ code: error.code, message: error.message })
        throw error
      }
    },
  )

  app.post<{ Params: { sessionId: string; turnId: string } }>(
    '/v1/sessions/:sessionId/turns/:turnId/steer',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      const body = steerTurnRequestSchema.safeParse(request.body)
      if (!body.success)
        return reply.code(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Steer request body is invalid',
        })
      const idempotencyKey = headerValue(request.headers['idempotency-key'])
      if (!idempotencyKey?.trim())
        return reply.code(400).send({
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required',
        })
      try {
        const steered = turnActionResponseSchema.parse(
          await orchestrator.steerTurn(
            scope,
            request.params.turnId,
            body.data.expectedTurnId,
            body.data.prompt,
            idempotencyKey,
          ),
        )
        store.appendAudit({
          ...scope,
          actor: 'user',
          action: 'turn.steered',
          outcome: 'success',
          idempotencyKey: `steer:${idempotencyKey}`,
          ...auditContext(request),
          metadata: { operation: 'steer' },
        })
        return steered
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        if (error instanceof OrchestrationError)
          return reply
            .code(error.statusCode)
            .send({ code: error.code, message: error.message })
        throw error
      }
    },
  )

  app.post<{ Params: { sessionId: string; turnId: string } }>(
    '/v1/sessions/:sessionId/turns/:turnId/interrupt',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      const body = interruptTurnRequestSchema.safeParse(request.body ?? {})
      if (!body.success)
        return reply.code(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Interrupt request body is invalid',
        })
      const idempotencyKey = headerValue(request.headers['idempotency-key'])
      if (!idempotencyKey?.trim())
        return reply.code(400).send({
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required',
        })
      try {
        const interrupted = turnActionResponseSchema.parse(
          await orchestrator.interruptTurn(
            scope,
            request.params.turnId,
            idempotencyKey,
          ),
        )
        store.appendAudit({
          ...scope,
          actor: 'user',
          action: 'turn.interrupted',
          outcome: 'success',
          idempotencyKey: `interrupt:${idempotencyKey}`,
          ...auditContext(request),
          metadata: { operation: 'interrupt' },
        })
        metrics.record('turn_duration_ms', 0, { outcome: 'interrupted' })
        return interrupted
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        if (error instanceof OrchestrationError)
          return reply
            .code(error.statusCode)
            .send({ code: error.code, message: error.message })
        throw error
      }
    },
  )

  app.post<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/attachments',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      const encodedName = headerValue(request.headers['x-attachment-name'])
      const mediaType = headerValue(request.headers['x-attachment-media-type'])
      if (!encodedName || !mediaType || !Buffer.isBuffer(request.body))
        return reply.code(400).send({
          code: 'INVALID_ATTACHMENT_REQUEST',
          message: 'Attachment name, media type, and binary body are required',
        })
      try {
        store.getSession(scope)
        const name = decodeURIComponent(encodedName)
        return reply.code(201).send(
          conversationAttachmentSchema.parse(
            attachments.store({
              scope,
              name,
              mediaType,
              data: request.body,
            }),
          ),
        )
      } catch (error) {
        if (error instanceof StoreNotFoundError)
          return reply.code(404).send({
            code: error.code,
            message: error.message,
          })
        if (error instanceof AttachmentStorageError)
          return reply.code(400).send({
            code: error.code,
            message: error.message,
          })
        if (error instanceof URIError)
          return reply.code(400).send({
            code: 'INVALID_ATTACHMENT_NAME',
            message: 'Attachment name encoding is invalid',
          })
        throw error
      }
    },
  )

  app.delete<{ Params: { sessionId: string; attachmentId: string } }>(
    '/v1/sessions/:sessionId/attachments/:attachmentId',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope)
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      try {
        attachments.remove(scope, request.params.attachmentId)
        return reply.code(204).send()
      } catch (error) {
        if (
          error instanceof AttachmentStorageError ||
          (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        )
          return reply.code(404).send({
            code: 'ATTACHMENT_NOT_FOUND',
            message: 'Attachment was not found in this session',
          })
        throw error
      }
    },
  )

  app.post<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/turns',
    async (request, reply) => {
      const scope = requestScope(request.headers, request.params.sessionId)
      if (!scope) {
        return reply.code(400).send({
          code: 'MISSING_SCOPE',
          message: 'x-tenant-id and x-workspace-id headers are required',
        })
      }
      const idempotencyKey = headerValue(request.headers['idempotency-key'])
      if (!idempotencyKey?.trim()) {
        return reply.code(400).send({
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required',
        })
      }
      const body = createTurnRequestSchema.safeParse(request.body)
      if (!body.success) {
        return reply.code(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Turn request body is invalid',
          issues: body.error.issues.map((issue) => issue.message),
        })
      }
      try {
        const turnAttachments = body.data.attachmentIds.map((attachmentId) =>
          attachments.resolve(scope, attachmentId),
        )
        const accepted = await orchestrator.startTurn(
          scope,
          body.data.prompt,
          idempotencyKey,
          turnAttachments,
        )
        turnStartedAt.set(
          JSON.stringify([
            scope.tenantId,
            scope.workspaceId,
            accepted.codexTurnId,
          ]),
          now().getTime(),
        )
        return reply.code(202).send(accepted)
      } catch (error) {
        if (error instanceof AttachmentStorageError)
          return reply.code(400).send({
            code: error.code,
            message: error.message,
          })
        if (error instanceof StoreNotFoundError) {
          return reply
            .code(404)
            .send({ code: error.code, message: error.message })
        }
        if (isIdempotencyConflict(error)) {
          return reply.code(409).send({
            code: 'IDEMPOTENCY_HASH_CONFLICT',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        if (error instanceof StoreConflictError) {
          return reply
            .code(409)
            .send({ code: error.code, message: error.message })
        }
        if (error instanceof OrchestrationError) {
          return reply
            .code(error.statusCode)
            .send({ code: error.code, message: error.message })
        }
        throw error
      }
    },
  )

  app.get<{
    Params: { sessionId: string }
    Querystring: { after?: string; limit?: string }
  }>('/v1/sessions/:sessionId/events', async (request, reply) => {
    const scope = requestScope(request.headers, request.params.sessionId)
    if (!scope) {
      return reply.code(400).send({
        code: 'MISSING_SCOPE',
        message: 'x-tenant-id and x-workspace-id headers are required',
      })
    }
    const after = parseNonNegativeInteger(request.query.after)
    if (after === undefined) {
      return reply.code(400).send({
        code: 'INVALID_CURSOR',
        message: 'after must be a non-negative integer',
      })
    }
    const limit = parseLimit(request.query.limit)
    if (limit === undefined) {
      return reply.code(400).send({
        code: 'INVALID_LIMIT',
        message: 'limit must be an integer between 1 and 500',
      })
    }

    try {
      return replayResponseSchema.parse(
        store.replaySessionEvents(scope, after, limit),
      )
    } catch (error) {
      if (error instanceof StoreNotFoundError) {
        return reply
          .code(404)
          .send({ code: error.code, message: error.message })
      }
      if (error instanceof StoreError) {
        return reply
          .code(400)
          .send({ code: error.code, message: error.message })
      }
      throw error
    }
  })

  app.get('/v1/realtime', { websocket: true }, (socket, request) => {
    metrics.record('realtime_reconnects_total', 1, { reason: 'client' })
    let subscription: SubscriptionState | undefined
    let connectionAuth:
      | {
          principal: AuthPrincipal
          memberships: OrganizationMembership[]
          expiresAt: number
        }
      | undefined
    let expiryTimer: ReturnType<typeof setTimeout> | undefined
    const outbound = senderFor(socket)

    const unsubscribe = store.onCommitted((event) => {
      const current = subscription
      if (!current || !sameScope(current, event)) return
      if (event.sequence <= current.highWaterSequence) return
      if (current.replaying) {
        const bytes = Buffer.byteLength(JSON.stringify(event))
        if (
          current.buffer.length >= REALTIME_MAX_QUEUE_EVENTS ||
          current.bufferBytes + bytes > REALTIME_MAX_QUEUE_BYTES
        ) {
          const disposable = current.buffer.findIndex(
            (candidate) => candidate.type === 'command.output.delta',
          )
          if (disposable >= 0) {
            const [removed] = current.buffer.splice(disposable, 1)
            current.bufferBytes -= Buffer.byteLength(JSON.stringify(removed))
            current.droppedEventCount++
          } else if (!isAuthoritative(event)) {
            current.droppedEventCount++
            return
          } else {
            send(socket, {
              type: 'resync',
              ...current,
              reason: 'queue_overflow',
              afterSequence: current.ackSequence,
              highWaterSequence: store.getHighWaterSequence(current),
              droppedEventCount: current.droppedEventCount,
            })
            current.buffer = []
            current.bufferBytes = 0
            return
          }
        }
        current.buffer.push(event)
        current.bufferBytes += bytes
        return
      }
      if (event.sequence <= current.lastSentSequence) return
      send(socket, {
        type: 'event',
        tenantId: current.tenantId,
        workspaceId: current.workspaceId,
        sessionId: current.sessionId,
        event,
      })
      current.lastSentSequence = event.sequence
    })
    const unsubscribeApprovals = store.onApprovalChanged((approval) => {
      const current = subscription
      if (
        !current ||
        current.tenantId !== approval.tenantId ||
        current.workspaceId !== approval.workspaceId ||
        current.sessionId !== approval.sessionId
      )
        return
      send(socket, {
        type: 'approval',
        ...current,
        approval: approvalSchema.parse(approval) as Approval,
      })
    })
    socket.once('close', () => {
      if (expiryTimer) clearTimeout(expiryTimer)
      unsubscribe()
      unsubscribeApprovals()
    })

    async function subscribe(message: SubscribeMessage): Promise<void> {
      if (subscription) {
        sendError(
          socket,
          'ALREADY_SUBSCRIBED',
          'Connection already has a subscription',
        )
        return
      }

      if (!authentication) {
        sendError(socket, 'AUTH_CONFIGURATION_REQUIRED', 'Access is denied')
        socket.close?.(4403, 'authentication unavailable')
        return
      }
      let principal: AuthPrincipal
      try {
        const authorization =
          message.accessToken === undefined
            ? headerValue(request.headers.authorization)
            : `Bearer ${message.accessToken}`
        principal = await authentication.authenticate({
          ...(authorization ? { authorization } : {}),
          headers: {
            ...request.headers,
            'x-tenant-id': message.tenantId,
            'x-workspace-id': message.workspaceId,
          },
          now: now(),
        })
      } catch {
        sendError(socket, 'AUTH_REQUIRED', 'Authentication is required')
        socket.close?.(4401, 'authentication required')
        return
      }
      const resolvedMemberships =
        principal.memberships.length > 0
          ? principal.memberships
          : memberships.membershipsFor(principal.subject, principal.issuer)
      const authz = authorize({
        principal,
        action: 'event.subscribe',
        memberships: resolvedMemberships,
        resource: {
          organizationId: message.tenantId,
          workspaceId: message.workspaceId,
          sessionId: message.sessionId,
          resourceType: 'realtime',
          resourceId: message.sessionId,
        },
      })
      store.appendAudit({
        tenantId: message.tenantId,
        workspaceId: message.workspaceId,
        sessionId: null,
        actor: 'user',
        actorPrincipalId: opaquePrincipalId(principal),
        action: 'authorization.decided',
        outcome: authz.allow ? 'success' : 'failure',
        idempotencyKey: `authz:ws:${request.id}:${message.sessionId}`,
        ...auditContext(request),
        metadata: {
          operation: 'event.subscribe',
          reasonCode: authz.reasonCode,
          status: authz.allow ? 'allow' : 'deny',
        },
      })
      metrics.record('authorization_decisions_total', 1, {
        action: 'event',
        outcome: authz.allow ? 'allow' : 'deny',
        reason: authz.reasonCode,
      })
      if (!authz.allow) {
        sendError(socket, 'ACCESS_DENIED', 'Access is denied')
        socket.close?.(4403, 'access denied')
        return
      }
      connectionAuth = {
        principal,
        memberships: resolvedMemberships,
        expiresAt: Date.parse(principal.expiresAt),
      }
      const remaining = connectionAuth.expiresAt - now().getTime()
      if (remaining <= 0) {
        sendError(socket, 'TOKEN_EXPIRED', 'Authentication expired')
        socket.close?.(4401, 'token expired')
        return
      }
      expiryTimer = setTimeout(
        () => {
          sendError(socket, 'TOKEN_EXPIRED', 'Authentication expired')
          socket.close?.(4401, 'token expired')
        },
        Math.min(remaining, 2_147_483_647),
      )
      const scope: StoreScope = {
        tenantId: message.tenantId,
        workspaceId: message.workspaceId,
        sessionId: message.sessionId,
      }
      let highWaterSequence: number
      try {
        highWaterSequence = store.getHighWaterSequence(scope)
      } catch (error) {
        if (error instanceof StoreNotFoundError) {
          sendError(socket, error.code, error.message)
          return
        }
        throw error
      }
      if (message.afterSequence > highWaterSequence) {
        sendError(
          socket,
          'INVALID_CURSOR',
          'afterSequence cannot be greater than the session high-water mark',
        )
        return
      }
      metrics.record(
        'replay_lag_events',
        highWaterSequence - message.afterSequence,
        { state: 'replaying' },
      )

      subscription = {
        ...scope,
        replaying: true,
        highWaterSequence,
        lastSentSequence: message.afterSequence,
        ackSequence: message.afterSequence,
        buffer: [],
        bufferBytes: 0,
        droppedEventCount: 0,
      }
      outbound.updateCursor({
        ...scope,
        afterSequence: message.afterSequence,
        highWaterSequence,
      })

      let cursor = message.afterSequence
      let hasMore = true
      while (hasMore) {
        const page = store.replaySessionEvents(
          scope,
          cursor,
          500,
          highWaterSequence,
        )
        send(socket, {
          type: 'replay',
          ...scope,
          highWaterSequence,
          events: page.events,
        })
        cursor = page.nextAfterSequence
        subscription.lastSentSequence = cursor
        hasMore = page.hasMore
      }

      // Give committed events arriving at the replay/live boundary a chance to
      // enter the per-connection buffer before the subscription becomes live.
      await waitForImmediate()
      const current = subscription
      if (!current) return
      send(socket, { type: 'subscribed', ...scope, highWaterSequence })
      current.replaying = false
      metrics.record('replay_lag_events', 0, { state: 'connected' })

      const buffered = [...current.buffer]
        .filter((event) => event.sequence > highWaterSequence)
        .sort((left, right) => left.sequence - right.sequence)
      current.buffer.length = 0
      current.bufferBytes = 0
      const delivered = new Set<number>()
      for (const event of buffered) {
        if (
          delivered.has(event.sequence) ||
          event.sequence <= current.lastSentSequence
        ) {
          continue
        }
        delivered.add(event.sequence)
        send(socket, { type: 'event', ...scope, event })
        current.lastSentSequence = event.sequence
      }
    }

    socket.on('message', (buffer: { toString(): string }) => {
      let value: unknown
      try {
        value = JSON.parse(buffer.toString())
      } catch {
        sendError(socket, 'INVALID_JSON', 'Message must be valid JSON')
        return
      }

      const parsed = clientMessageSchema.safeParse(value)
      if (!parsed.success) {
        sendError(
          socket,
          'INVALID_MESSAGE',
          'Message does not match the realtime contract',
        )
        return
      }

      if (parsed.data.type === 'subscribe') {
        void subscribe(parsed.data).catch((error: unknown) => {
          app.log.error({ err: error }, 'realtime subscription failed')
          sendError(
            socket,
            'INTERNAL_ERROR',
            'Subscription could not be established',
          )
        })
        return
      }

      const ack = ackMessageSchema.parse(parsed.data)
      const current = subscription
      if (!current) {
        sendError(
          socket,
          'NOT_SUBSCRIBED',
          'Subscribe before acknowledging events',
        )
        return
      }
      if (!connectionAuth || connectionAuth.expiresAt <= now().getTime()) {
        sendError(socket, 'TOKEN_EXPIRED', 'Authentication expired')
        socket.close?.(4401, 'token expired')
        return
      }
      const currentMemberships =
        connectionAuth.principal.memberships.length > 0
          ? connectionAuth.memberships
          : memberships.membershipsFor(
              connectionAuth.principal.subject,
              connectionAuth.principal.issuer,
            )
      const ackDecision = authorize({
        principal: connectionAuth.principal,
        action: 'event.subscribe',
        memberships: currentMemberships,
        resource: {
          organizationId: current.tenantId,
          workspaceId: current.workspaceId,
          sessionId: current.sessionId,
          resourceType: 'realtime',
          resourceId: current.sessionId,
        },
      })
      if (!ackDecision.allow) {
        sendError(socket, 'ACCESS_REVOKED', 'Access is denied')
        socket.close?.(4403, 'access revoked')
        return
      }
      if (!sameScope(current, ack)) {
        sendError(
          socket,
          'ACK_SCOPE_MISMATCH',
          'Ack scope does not match the subscription',
        )
        return
      }
      if (ack.sequence < current.ackSequence) {
        sendError(
          socket,
          'ACK_REGRESSION',
          'Ack sequence cannot move backwards',
        )
        return
      }
      if (ack.sequence > current.lastSentSequence) {
        sendError(
          socket,
          'ACK_AHEAD',
          'Ack sequence cannot exceed the last delivered sequence',
        )
        return
      }
      current.ackSequence = ack.sequence
      outbound.updateCursor({
        ...current,
        afterSequence: ack.sequence,
        highWaterSequence: store.getHighWaterSequence(current),
      })
      send(socket, ack)
    })
  })

  return app
}
