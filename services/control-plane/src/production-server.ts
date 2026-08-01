import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import { z, ZodError } from 'zod'
import {
  AuthenticationError,
  OidcAuthenticationAdapter,
  type AuthenticationAdapter,
} from '@perseverance/authz'
import {
  apiErrorResponseSchema,
  conversationFolderListResponseSchema,
  conversationFolderSchema,
  createConversationFolderRequestSchema,
  createSessionRequestSchema,
  createSharedFolderRequestSchema,
  folderListResponseSchema,
  folderMembershipSchema,
  interruptTurnRequestSchema,
  sessionResponseSchema,
  sessionListResponseSchema,
  sharedFolderSchema,
  subscribeMessageSchema,
  updateConversationRequestSchema,
  updateSessionArchiveRequestSchema,
  turnActionResponseSchema,
  type AuthPrincipal,
  type SessionResponse,
} from '@perseverance/control-plane-contracts'
import {
  ProductionTelemetry,
  OtlpHttpExporter,
  opaqueScope,
  parseTraceparent,
  type TraceContext,
} from '@perseverance/production-observability'
import {
  createBillingPostgresRepository,
  type BillingPostgresRepository,
} from '@perseverance/billing-platform'
import {
  createProductionPostgresRepository,
  type ProductionEvent,
  type ProductionSession,
  type ProductionPostgresRepository,
  type ProductionScope,
} from '@perseverance/production-topology/production-postgres'
import {
  timelineEventSchema,
  type TimelineEvent,
} from '@perseverance/domain-events'
import { adaptCodexNotification } from '@perseverance/codex-event-adapter'
import type { ServerNotification } from '@perseverance/codex-protocol-generated'
import {
  RabbitMqManagementBroker,
  S3CompatibleObjectStore,
  httpDependencyReady,
  type DurableEventBroker,
  type ObjectStore,
} from '@perseverance/production-topology/durable-dependencies'
import { ProductionRolloutAuthority } from './production-rollout-authority'
import {
  registerManagedCloudRoutes,
  type ManagedCloudAuthenticatedPrincipal,
} from './managed-cloud-api'
import { ManagedCloudError } from '@perseverance/managed-cloud'
import { createManagedCloudProductionComposition } from './managed-cloud-production'
import {
  HttpAwsKmsClient,
  HttpTenantRuntimeResources,
} from './managed-cloud-infrastructure'
import { AwsKmsProvider } from '@perseverance/workspace-security'
import {
  StaticProviderAuthCapabilitySource,
  type ProviderAuthEvidence,
  type ProviderAuthFeatureFlags,
} from '@perseverance/provider-auth'
import {
  SelfHostedAuthError,
  type SelfHostedAuthService,
} from './self-hosted-auth'
import {
  SELF_HOSTED_AUTH_PUBLIC_PATHS,
  registerSelfHostedAuthRoutes,
} from './self-hosted-auth-api'
import { createSelfHostedAuthFromEnv } from './self-hosted-auth-composition'
import {
  decryptUserContent,
  encryptUserContent,
  parseUserContentEnvelope,
} from './user-content-crypto'
import {
  SharedFolderError,
  type FolderIdentity,
  type SharedFolderRepository,
} from '@perseverance/shared-folders'
import { PostgresSharedFolderRepository } from '@perseverance/shared-folders/postgres'

export interface ProductionControlPlaneOptions {
  instanceId: string
  repository: ProductionPostgresRepository
  objectStore: ObjectStore
  broker: DurableEventBroker
  runtimeControlReadinessUrl: string
  kmsReadinessUrl: string
  requiredRegionId: string
  billing: BillingPostgresRepository
  logger?: boolean
  dependencyTimeoutMs?: number
  now?: () => Date
  telemetry?: ProductionTelemetry
  telemetryScopeSalt?: string
  authentication?: AuthenticationAdapter
  allowedWebOrigin?: string
  managedCloud?: ReturnType<typeof createManagedCloudProductionComposition>
  selfHostedAuth?: SelfHostedAuthService
  sharedFolders?: SharedFolderRepository
  internalRuntimeToken?: string
}

export const DEFAULT_CONVERSATION_FOLDER_ID = 'fol_default'
const DEFAULT_CONVERSATION_FOLDER_NAME = 'Default'

function encodeSessionCursor(value: { updatedAt: string; sessionId: string }) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeSessionCursor(value: string | undefined) {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    if (
      typeof parsed.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      typeof parsed.sessionId !== 'string' ||
      !parsed.sessionId
    )
      return null
    return { updatedAt: parsed.updatedAt, sessionId: parsed.sessionId }
  } catch {
    return null
  }
}

function header(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function scope(headers: Record<string, string | string[] | undefined>) {
  const tenantId = header(headers['x-tenant-id'])
  const organizationId = header(headers['x-organization-id']) ?? tenantId
  const workspaceId = header(headers['x-workspace-id'])
  if (!tenantId || !organizationId || !workspaceId) return null
  return { tenantId, organizationId, workspaceId } satisfies ProductionScope
}

export function productionRealtimeSubscription(input: unknown) {
  const parsed = subscribeMessageSchema.safeParse(input)
  if (!parsed.success || !parsed.data.accessToken) return null
  const organizationId =
    typeof input === 'object' &&
    input !== null &&
    'organizationId' in input &&
    typeof input.organizationId === 'string' &&
    input.organizationId.length > 0
      ? input.organizationId
      : parsed.data.tenantId
  return {
    accessToken: parsed.data.accessToken,
    sessionId: parsed.data.sessionId,
    afterSequence: parsed.data.afterSequence,
    scope: {
      tenantId: parsed.data.tenantId,
      organizationId,
      workspaceId: parsed.data.workspaceId,
    } satisfies ProductionScope,
  }
}

export function productionTimelineEvent(
  stored: ProductionEvent,
  contentText?: string,
): TimelineEvent {
  const identity = {
    eventId: stored.eventId,
    schemaVersion: 1 as const,
    tenantId: stored.tenantId,
    workspaceId: stored.workspaceId,
    sessionId: stored.sessionId,
    ...(typeof stored.payload.codexThreadId === 'string'
      ? { codexThreadId: stored.payload.codexThreadId }
      : {}),
    ...(stored.runId ? { codexTurnId: stored.runId } : {}),
    ...(typeof stored.payload.codexItemId === 'string'
      ? { codexItemId: stored.payload.codexItemId }
      : {}),
    sequence: stored.sequence,
    occurredAt: stored.occurredAt,
    receivedAt: stored.occurredAt,
    source: 'codex-app-server' as const,
    sourceVersion: '0.144.2',
    sourceMethod: stored.eventType,
    visibility: 'user' as const,
  }
  if (stored.eventType === 'turn.started')
    return timelineEventSchema.parse({
      ...identity,
      type: 'turn.started',
      payload: { status: 'running' },
    })
  if (stored.eventType === 'agent.message.completed')
    return timelineEventSchema.parse({
      ...identity,
      type: 'agent.message.completed',
      payload: { text: contentText ?? '' },
    })
  if (stored.eventType === 'turn.completed')
    return timelineEventSchema.parse({
      ...identity,
      type: 'turn.completed',
      payload: {
        status:
          typeof stored.payload.outcome === 'string'
            ? stored.payload.outcome
            : 'completed',
      },
    })
  return timelineEventSchema.parse({
    ...identity,
    type: 'codex.unknown',
    payload: {
      envelopeKind: 'notification',
      method: `production/${stored.eventType}`,
      params: stored.payload,
    },
  })
}

export function productionCodexNotificationEvent(
  stored: ProductionEvent,
  notification: unknown,
): TimelineEvent {
  const adapted = adaptCodexNotification(notification as ServerNotification, {
    tenantId: stored.tenantId,
    workspaceId: stored.workspaceId,
    sessionId: stored.sessionId,
    sourceVersion: '0.144.2',
    nextSequence: () => stored.sequence,
    now: () => new Date(stored.occurredAt),
    nextEventId: () => stored.eventId,
  })
  return timelineEventSchema.parse({
    ...adapted,
    ...(stored.runId ? { codexTurnId: stored.runId } : {}),
  })
}

export function productionUserMessageEvent(
  stored: ProductionEvent,
  text: string,
): TimelineEvent {
  return timelineEventSchema.parse({
    eventId: `${stored.eventId}_user`,
    schemaVersion: 1,
    tenantId: stored.tenantId,
    workspaceId: stored.workspaceId,
    sessionId: stored.sessionId,
    ...(stored.runId
      ? { codexTurnId: stored.runId, codexItemId: `user_${stored.runId}` }
      : {}),
    sequence: stored.sequence,
    occurredAt: stored.occurredAt,
    receivedAt: stored.occurredAt,
    source: 'codex-app-server',
    sourceVersion: '0.144.2',
    sourceMethod: 'item/completed',
    visibility: 'user',
    type: 'codex.unknown',
    payload: {
      envelopeKind: 'notification',
      method: 'item/completed',
      params: {
        item: { type: 'userMessage', content: [{ type: 'text', text }] },
      },
    },
  })
}

function opaquePrincipalId(principal: AuthPrincipal) {
  return `sha256:${createHash('sha256')
    .update(`${principal.issuer}\0${principal.subject}`)
    .digest('hex')}`
}

export function productionSessionResponse(
  stored: ProductionSession,
): SessionResponse {
  const archived = stored.status === 'archived'
  const recoveryRequired = stored.status === 'recovery_required'
  const provider = ['codex', 'claude', 'gemini', 'cursor'].includes(
    stored.providerId,
  )
    ? (stored.providerId as SessionResponse['provider'])
    : 'codex'

  return sessionResponseSchema.parse({
    tenantId: stored.tenantId,
    workspaceId: stored.workspaceId,
    sessionId: stored.sessionId,
    folderId: stored.folderId,
    title: stored.title,
    provider,
    requestedPolicy: stored.requestedPolicy,
    resolvedModel: stored.resolvedModel,
    reasoningEffort: stored.reasoningEffort,
    capabilitySnapshot: null,
    codexThreadId: stored.codexThreadId,
    status: archived ? 'failed' : stored.status,
    archivedAt: archived ? stored.updatedAt : null,
    recoveryErrorCode: recoveryRequired ? 'RECOVERY_OUTCOME_UNKNOWN' : null,
    lastResumedAt: null,
    runtimeGeneration: null,
    runtimeConnected: false,
    activeRun: null,
    latestRun: null,
    replay: {
      afterSequence: stored.highWaterSequence,
      highWaterSequence: stored.highWaterSequence,
    },
    recoveryOptions: recoveryRequired
      ? ['retry_resume', 'start_new_session', 'view_read_only']
      : [],
  })
}

async function bounded<T>(timeoutMs: number, operation: () => Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('DEPENDENCY_TIMEOUT')),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function buildProductionControlPlane(
  options: ProductionControlPlaneOptions,
) {
  const app = Fastify({ logger: options.logger ?? false })
  await app.register(websocket)
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const timeoutMs = options.dependencyTimeoutMs ?? 2_000
  const now = options.now ?? (() => new Date())
  const telemetry = options.telemetry ?? new ProductionTelemetry(now)
  const telemetrySalt = options.telemetryScopeSalt ?? 'wp27-test-scope-salt'
  const requestTelemetry = new WeakMap<
    object,
    {
      context: TraceContext
      end: (
        status?: 'ok' | 'error',
        extra?: Record<string, string | number | boolean>,
      ) => void
      started: number
    }
  >()
  const requestPrincipals = new WeakMap<object, AuthPrincipal>()
  const rolloutAuthority = new ProductionRolloutAuthority(
    options.repository.pool,
  )

  app.addHook('onSend', async (_request, reply, payload) => {
    if (options.allowedWebOrigin) {
      reply.header('access-control-allow-origin', options.allowedWebOrigin)
      reply.header(
        'access-control-allow-headers',
        'authorization,content-type,idempotency-key,x-tenant-id,x-organization-id,x-workspace-id,x-principal-id',
      )
      reply.header('access-control-allow-methods', 'GET,POST,OPTIONS')
      reply.header('vary', 'origin')
    }
    return payload
  })

  app.options('*', async (_request, reply) => reply.code(204).send())

  app.addHook('onRequest', async (request) => {
    const requestScope = scope(request.headers)
    const span = telemetry.startSpan('api.request', {
      parent: parseTraceparent(header(request.headers.traceparent)),
      attributes: {
        'service.name': 'control-plane',
        'service.role': 'api',
        operation: request.url.startsWith('/v1/realtime') ? 'realtime' : 'http',
        method: request.method,
        ...(requestScope
          ? {
              'tenant.opaque': opaqueScope(
                requestScope.tenantId,
                telemetrySalt,
              ),
              'workspace.opaque': opaqueScope(
                requestScope.workspaceId,
                telemetrySalt,
              ),
            }
          : {}),
      },
    })
    requestTelemetry.set(request, { ...span, started: performance.now() })
  })
  app.addHook('onRequest', async (request, reply) => {
    if (
      !options.authentication ||
      request.method === 'OPTIONS' ||
      request.url === '/' ||
      request.url === '/healthz' ||
      request.url === '/readyz' ||
      request.url === '/v1/meta' ||
      request.url.startsWith('/v1/realtime') ||
      // WP37: kayıt/giriş uçları pre-auth'tur; kendi doğrulama, rate-limit
      // ve audit denetimlerini self-hosted-auth-api içinde uygular.
      (options.selfHostedAuth &&
        (SELF_HOSTED_AUTH_PUBLIC_PATHS as readonly string[]).includes(
          request.url.split('?')[0] ?? request.url,
        ))
    )
      return
    try {
      const principal = await options.authentication.authenticate({
        headers: request.headers,
        ...(header(request.headers.authorization)
          ? { authorization: header(request.headers.authorization)! }
          : {}),
      })
      if (request.url.startsWith('/v1/managed-cloud')) {
        requestPrincipals.set(request, principal)
        return
      }
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const membership = await options.repository.pool.query(
        `SELECT m.role FROM persistent_codex.principal_identities p
         JOIN persistent_codex.organization_memberships m
           ON m.issuer=p.issuer AND m.subject=p.subject
         WHERE p.issuer=$1 AND p.subject=$2 AND p.status='active'
           AND m.organization_id=$3 AND m.status='active'`,
        [principal.issuer, principal.subject, requestScope.organizationId],
      )
      if (!membership.rowCount)
        return reply.code(403).send({ code: 'AUTHORIZATION_DENIED' })
      requestPrincipals.set(request, principal)
    } catch (error) {
      if (error instanceof AuthenticationError)
        return reply.code(401).send({ code: error.code })
      throw error
    }
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ code: 'INVALID_REQUEST' })
    if (error instanceof SharedFolderError) {
      const status = error.code.includes('NOT_FOUND')
        ? 404
        : error.code.includes('DENIED')
          ? 403
          : error.code.includes('PROTECTED') || error.code.includes('CONFLICT')
            ? 409
            : 400
      return reply.code(status).send({ code: error.code })
    }
    if (error instanceof ManagedCloudError) {
      const status =
        error.code === 'AUTH_REQUIRED'
          ? 401
          : error.code.includes('DENIED') ||
              error.code.includes('HALT') ||
              error.code.includes('LIMIT')
            ? 403
            : error.code.includes('NOT_FOUND')
              ? 404
              : error.code.includes('CONFLICT')
                ? 409
                : 400
      return reply.code(status).send({ code: error.code })
    }
    throw error
  })
  app.addHook('onResponse', async (request, reply) => {
    const observed = requestTelemetry.get(request)
    if (!observed) return
    const ok = reply.statusCode < 500
    telemetry.recordMetric('api_availability', ok ? 1 : 0, {
      context: observed.context,
      attributes: { status: ok ? 'success' : 'error', method: request.method },
    })
    telemetry.recordMetric('api_error_rate', ok ? 0 : 1, {
      context: observed.context,
      attributes: { status: `${Math.floor(reply.statusCode / 100)}xx` },
    })
    observed.end(ok ? 'ok' : 'error', {
      status: `${reply.statusCode}`,
      outcome: ok ? 'success' : 'error',
    })
  })

  const dependencyReadiness = async () => {
    const probes = await Promise.allSettled([
      bounded(timeoutMs, () => options.repository.pool.query('SELECT 1')),
      bounded(timeoutMs, () => options.broker.ready()),
      bounded(timeoutMs, () => options.objectStore.ready()),
      bounded(timeoutMs, () =>
        httpDependencyReady(options.runtimeControlReadinessUrl),
      ),
      bounded(timeoutMs, () => httpDependencyReady(options.kmsReadinessUrl)),
    ])
    const names = [
      'postgresql',
      'event-broker',
      'object-storage',
      'runtime-control',
      'kms',
    ] as const
    const dependencies = names.map((name, index) => ({
      name,
      ready:
        probes[index]?.status === 'fulfilled' &&
        (typeof (probes[index] as PromiseFulfilledResult<unknown>).value !==
          'boolean' ||
          (probes[index] as PromiseFulfilledResult<boolean>).value),
      code:
        probes[index]?.status === 'fulfilled' &&
        (typeof (probes[index] as PromiseFulfilledResult<unknown>).value !==
          'boolean' ||
          (probes[index] as PromiseFulfilledResult<boolean>).value)
          ? null
          : `${name.toUpperCase().replaceAll('-', '_')}_UNAVAILABLE`,
    }))
    return {
      schemaVersion: 1 as const,
      instanceId: options.instanceId,
      mode: 'production' as const,
      ready: dependencies.every((dependency) => dependency.ready),
      checkedAt: now().toISOString(),
      dependencies,
    }
  }

  const requireReady = async () => {
    const readiness = await dependencyReadiness()
    return readiness.ready ? null : readiness
  }

  app.get('/healthz', async () => ({
    status: 'ok',
    instanceId: options.instanceId,
    mode: 'production',
  }))
  app.get('/', async () => ({
    service: 'persistent-codex-control-plane',
    mode: 'production',
    health: '/healthz',
    readiness: '/readyz',
  }))
  app.get('/readyz', async (_request, reply) => {
    const readiness = await dependencyReadiness()
    return reply.code(readiness.ready ? 200 : 503).send(readiness)
  })
  app.get('/v1/meta', async () => ({
    service: 'persistent-codex-control-plane',
    topology: 'active-passive-region-pinned',
    persistence: 'postgresql-object-storage-durable-broker',
    instanceId: options.instanceId,
    codexVersion: '0.144.2',
  }))
  if (options.managedCloud)
    registerManagedCloudRoutes(app, {
      ...options.managedCloud,
      principalFor(request): ManagedCloudAuthenticatedPrincipal {
        const value = requestPrincipals.get(request)
        if (!value) throw new ManagedCloudError('AUTH_REQUIRED')
        return { issuer: value.issuer, subject: value.subject }
      },
    })

  if (options.selfHostedAuth) {
    registerSelfHostedAuthRoutes(app, { service: options.selfHostedAuth })
    app.post('/v1/auth/unlock', async (request, reply) => {
      const requestScope = scope(request.headers)
      const principal = requestPrincipals.get(request)
      if (!requestScope || !principal)
        return reply.code(401).send({ code: 'AUTH_REQUIRED' })
      try {
        const body = z
          .object({
            username: z.string().trim().min(3).max(32),
            password: z.string().min(8).max(1024),
          })
          .parse(request.body)
        return reply.code(200).send(
          await options.selfHostedAuth!.unlock({
            ...body,
            expectedSubject: principal.subject,
            expectedScope: requestScope,
          }),
        )
      } catch (error) {
        if (error instanceof ZodError)
          return reply.code(400).send({ code: 'INVALID_AUTH_REQUEST' })
        if (error instanceof SelfHostedAuthError)
          return reply.code(error.statusCode).send({ code: error.message })
        throw error
      }
    })
    // Oturum durumu: bearer + scope doğrulamasından geçer (public listede
    // değildir); web istemcisi content key kilidini buradan yoklar.
    app.get('/v1/auth/session', async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const principal = requestPrincipals.get(request)
      return reply.code(200).send({
        subject: principal?.subject ?? null,
        ...requestScope,
        contentKeyUnlocked:
          options.selfHostedAuth!.leases.acquire(requestScope.workspaceId) !==
          null,
      })
    })

    // Web istemcisinin kimlik sorgusu (server.ts'teki /v1/me karşılığı):
    // membership'ler DB'den, kalan alanlar doğrulanmış principal'dan gelir.
    app.get('/v1/me', async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const principal = requestPrincipals.get(request)
      if (!principal) return reply.code(401).send({ code: 'AUTH_REQUIRED' })
      const memberships = await options.repository.pool.query(
        `SELECT m.organization_id, m.role, m.status
         FROM persistent_codex.organization_memberships m
         WHERE m.issuer=$1 AND m.subject=$2 AND m.status='active'`,
        [principal.issuer, principal.subject],
      )
      return reply.code(200).send({
        ...principal,
        memberships: memberships.rows.map(
          (row: { organization_id: string; role: string; status: string }) => ({
            version: 1,
            subject: principal.subject,
            issuer: principal.issuer,
            organizationId: row.organization_id,
            role: row.role,
            status: row.status,
            workspaceIds: [],
            updatedAt: now().toISOString(),
          }),
        ),
        activeOrganizationId: requestScope.organizationId,
        activeWorkspaceId: requestScope.workspaceId,
      })
    })
  }

  if (options.sharedFolders) {
    const folderIdentity = (request: {
      headers: Record<string, string | string[] | undefined>
    }): FolderIdentity | null => {
      const requestScope = scope(request.headers)
      const principal = requestPrincipals.get(request as object)
      if (!requestScope || !principal) return null
      return {
        ...requestScope,
        principalId: opaquePrincipalId(principal),
      }
    }
    const legacyFolder = (folder: {
      tenantId: string
      workspaceId: string
      folderId: string
      name: string
      createdAt: string
      updatedAt: string
      archivedAt: string | null
    }) =>
      conversationFolderSchema.parse({
        tenantId: folder.tenantId,
        workspaceId: folder.workspaceId,
        folderId: folder.folderId,
        name: folder.name,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
        archivedAt: folder.archivedAt,
      })

    const mutateConversationWorkspace = async (
      method: 'POST' | 'DELETE',
      identity: FolderIdentity,
      folderId: string,
    ) => {
      if (!options.internalRuntimeToken)
        return {
          ok: false as const,
          status: 503,
          code: 'WORKSPACE_MUTATION_UNAVAILABLE',
        }
      const endpoint = new URL(
        `/internal/v1/conversation-workspaces/${encodeURIComponent(folderId)}`,
        options.runtimeControlReadinessUrl,
      )
      endpoint.searchParams.set('tenantId', identity.tenantId)
      endpoint.searchParams.set('organizationId', identity.organizationId)
      endpoint.searchParams.set('workspaceId', identity.workspaceId)
      const response = await fetch(endpoint, {
        method,
        headers: { authorization: `Bearer ${options.internalRuntimeToken}` },
      })
      if (response.ok) return { ok: true as const }
      const body = (await response.json().catch(() => null)) as {
        code?: string
      } | null
      return {
        ok: false as const,
        status: response.status,
        code: body?.code ?? 'WORKSPACE_MUTATION_FAILED',
      }
    }

    app.get('/v1/folders', async (request, reply) => {
      const identity = folderIdentity(request)
      if (!identity) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      return folderListResponseSchema.parse({
        folders: await options.sharedFolders!.listFolders(identity),
      })
    })

    app.post('/v1/folders', async (request, reply) => {
      const identity = folderIdentity(request)
      const body = createSharedFolderRequestSchema.safeParse(request.body)
      if (!identity || !body.success)
        return reply.code(400).send({ code: 'VALIDATION_ERROR' })
      const created = await options.sharedFolders!.createFolder({
        ...identity,
        name: body.data.name,
      })
      return reply.code(201).send({
        folder: sharedFolderSchema.parse(created.folder),
        membership: folderMembershipSchema.parse(created.membership),
      })
    })

    // The current conversation sidebar still consumes the pre-WP25 endpoint.
    // Back it with the same durable shared-folder aggregate so self-hosted
    // production does not fall back to the alpha-only SQLite event store.
    app.get('/v1/conversation-folders', async (request, reply) => {
      const identity = folderIdentity(request)
      if (!identity) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const folders = await options.sharedFolders!.listFolders(identity)
      return conversationFolderListResponseSchema.parse({
        folders: [
          conversationFolderSchema.parse({
            tenantId: identity.tenantId,
            workspaceId: identity.workspaceId,
            folderId: DEFAULT_CONVERSATION_FOLDER_ID,
            name: DEFAULT_CONVERSATION_FOLDER_NAME,
            createdAt: '1970-01-01T00:00:00.000Z',
            updatedAt: '1970-01-01T00:00:00.000Z',
            archivedAt: null,
          }),
          ...folders.map((entry) => legacyFolder(entry.folder)),
        ],
      })
    })

    app.post('/v1/conversation-folders', async (request, reply) => {
      const identity = folderIdentity(request)
      const body = createConversationFolderRequestSchema.safeParse(request.body)
      if (!identity || !body.success)
        return reply.code(400).send({ code: 'VALIDATION_ERROR' })
      const created = await options.sharedFolders!.createFolder({
        ...identity,
        name: body.data.name,
      })
      const workspace = await mutateConversationWorkspace(
        'POST',
        identity,
        created.folder.folderId,
      )
      if (!workspace.ok) {
        await options
          .sharedFolders!.deleteFolder({
            ...identity,
            folderId: created.folder.folderId,
          })
          .catch(() => undefined)
        return reply.code(workspace.status).send({ code: workspace.code })
      }
      return reply.code(201).send(legacyFolder(created.folder))
    })

    app.delete<{ Params: { folderId: string } }>(
      '/v1/conversation-folders/:folderId',
      async (request, reply) => {
        const identity = folderIdentity(request)
        if (!identity) return reply.code(400).send({ code: 'MISSING_SCOPE' })
        if (request.params.folderId === DEFAULT_CONVERSATION_FOLDER_ID)
          return reply
            .code(409)
            .send({ code: 'DEFAULT_CONVERSATION_FOLDER_PROTECTED' })
        try {
          await options.sharedFolders!.getFolder(
            identity,
            request.params.folderId,
            'manage',
          )
        } catch {
          return reply.code(404).send({ code: 'FOLDER_NOT_FOUND' })
        }
        const sessionCount = await options.repository.countSessionsInFolder(
          identity,
          request.params.folderId,
        )
        if (sessionCount > 0)
          return reply.code(409).send({ code: 'FOLDER_NOT_EMPTY' })
        const workspace = await mutateConversationWorkspace(
          'DELETE',
          identity,
          request.params.folderId,
        )
        if (!workspace.ok)
          return reply.code(workspace.status).send({ code: workspace.code })
        await options.sharedFolders!.deleteFolder({
          ...identity,
          folderId: request.params.folderId,
        })
        return reply.code(204).send()
      },
    )
  }

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const workspace = await options.repository.getWorkspace(
        requestScope,
        request.params.workspaceId,
      )
      if (!workspace)
        return reply.code(404).send({ code: 'WORKSPACE_NOT_FOUND' })
      return workspace
    },
  )

  app.get<{ Params: { artifactId: string } }>(
    '/v1/artifacts/:artifactId',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const artifact = await options.repository.getArtifact(
        requestScope,
        request.params.artifactId,
      )
      if (!artifact) return reply.code(404).send({ code: 'ARTIFACT_NOT_FOUND' })
      const bytes = await options.objectStore.get(artifact.objectKey)
      return reply
        .header('x-artifact-id', artifact.artifactId)
        .type('application/octet-stream')
        .send(Buffer.from(bytes))
    },
  )

  app.get<{ Querystring: { path?: string; sessionId?: string } }>(
    '/v1/workspace-files',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      if (!options.internalRuntimeToken)
        return reply.code(503).send({ code: 'WORKSPACE_FILES_UNAVAILABLE' })
      if (!request.query.sessionId)
        return reply.code(400).send({ code: 'SESSION_ID_REQUIRED' })
      const endpoint = new URL(
        '/internal/v1/workspace-files',
        options.runtimeControlReadinessUrl,
      )
      endpoint.searchParams.set('path', request.query.path ?? '')
      endpoint.searchParams.set('tenantId', requestScope.tenantId)
      endpoint.searchParams.set('organizationId', requestScope.organizationId)
      endpoint.searchParams.set('workspaceId', requestScope.workspaceId)
      endpoint.searchParams.set('sessionId', request.query.sessionId)
      const response = await fetch(endpoint, {
        headers: { authorization: `Bearer ${options.internalRuntimeToken}` },
      })
      const body = await response.json().catch(() => ({
        code: 'WORKSPACE_FILE_SERVICE_ERROR',
      }))
      return reply.code(response.status).send(body)
    },
  )

  app.post<{
    Body: {
      rolloutId?: unknown
      cohortId?: unknown
      artifactSha256?: unknown
      previousArtifactSha256?: unknown
    }
  }>('/v1/production-rollouts', async (request, reply) => {
    const requestScope = scope(request.headers)
    if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
    const body = request.body
    if (
      typeof body?.rolloutId !== 'string' ||
      typeof body.cohortId !== 'string' ||
      typeof body.artifactSha256 !== 'string' ||
      typeof body.previousArtifactSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.artifactSha256) ||
      !/^[a-f0-9]{64}$/.test(body.previousArtifactSha256)
    )
      return reply.code(400).send({ code: 'INVALID_ROLLOUT' })
    const created = await rolloutAuthority.create({
      ...requestScope,
      rolloutId: body.rolloutId,
      cohortId: body.cohortId,
      artifactSha256: body.artifactSha256,
      previousArtifactSha256: body.previousArtifactSha256,
    })
    return reply.code(201).send(created)
  })

  app.post<{
    Params: { rolloutId: string }
    Body: {
      expectedVersion?: unknown
      idempotencyKey?: unknown
      next?: unknown
      cohortId?: unknown
      operatorHalt?: unknown
      rollbackVerified?: unknown
      budgetHealthy?: unknown
    }
  }>(
    '/v1/production-rollouts/:rolloutId/transitions',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const body = request.body
      if (
        !Number.isInteger(body?.expectedVersion) ||
        typeof body.idempotencyKey !== 'string' ||
        typeof body.cohortId !== 'string' ||
        ![
          'design_partner',
          'limited_beta',
          'production_cohort',
          'halted',
          'rolled_back',
        ].includes(String(body.next))
      )
        return reply.code(400).send({ code: 'INVALID_ROLLOUT_TRANSITION' })
      try {
        return await rolloutAuthority.transition({
          ...requestScope,
          rolloutId: request.params.rolloutId,
          expectedVersion: Number(body.expectedVersion),
          idempotencyKey: body.idempotencyKey,
          next: body.next as
            | 'design_partner'
            | 'limited_beta'
            | 'production_cohort'
            | 'halted'
            | 'rolled_back',
          cohortId: body.cohortId,
          ...(body.operatorHalt === true ? { operatorHalt: true } : {}),
          ...(body.rollbackVerified === true ? { rollbackVerified: true } : {}),
          ...(typeof body.budgetHealthy === 'boolean'
            ? { budgetHealthy: body.budgetHealthy }
            : {}),
        })
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('VERSION_CONFLICT') ||
            error.message.includes('IDEMPOTENCY_CONFLICT'))
        )
          return reply.code(409).send({ code: error.message })
        throw error
      }
    },
  )

  app.post('/v1/sessions', async (request, reply) => {
    const requestScope = scope(request.headers)
    if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
    const body = createSessionRequestSchema.safeParse(request.body ?? {})
    if (!body.success) return reply.code(400).send({ code: 'VALIDATION_ERROR' })
    const unavailable = await requireReady()
    if (unavailable)
      return reply.code(503).send({
        code: 'PRODUCTION_DEPENDENCY_UNAVAILABLE',
        readiness: unavailable,
      })
    const folderId = body.data.folderId ?? DEFAULT_CONVERSATION_FOLDER_ID
    if (folderId !== DEFAULT_CONVERSATION_FOLDER_ID) {
      const identity =
        options.sharedFolders && requestPrincipals.get(request as object)
          ? {
              ...requestScope,
              principalId: opaquePrincipalId(
                requestPrincipals.get(request as object)!,
              ),
            }
          : null
      if (!identity)
        return reply.code(403).send({ code: 'FOLDER_ACCESS_DENIED' })
      try {
        await options.sharedFolders!.getFolder(identity, folderId, 'mutate')
      } catch {
        return reply.code(404).send({ code: 'FOLDER_NOT_FOUND' })
      }
    }
    const requestedPolicy = body.data.model ?? {
      alias: 'sol' as const,
      reasoningEffort: 'medium' as const,
    }
    const created = await options.repository.createSession({
      ...requestScope,
      folderId,
      title: body.data.title ?? 'Yeni konuşma',
      providerId: body.data.provider,
      requestedPolicy,
      resolvedModel:
        'modelId' in requestedPolicy ? requestedPolicy.modelId : null,
      reasoningEffort: requestedPolicy.reasoningEffort,
    })
    return reply.code(201).send(productionSessionResponse(created))
  })

  app.get<{
    Querystring: { cursor?: string; limit?: string; archived?: string }
  }>('/v1/sessions', async (request, reply) => {
    const requestScope = scope(request.headers)
    if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
    const limit = request.query.limit ? Number(request.query.limit) : 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return reply.code(400).send({ code: 'INVALID_LIMIT' })
    if (
      request.query.archived !== undefined &&
      request.query.archived !== 'true' &&
      request.query.archived !== 'false'
    )
      return reply.code(400).send({ code: 'INVALID_ARCHIVED_FILTER' })
    const cursor = decodeSessionCursor(request.query.cursor)
    if (cursor === null) return reply.code(400).send({ code: 'INVALID_CURSOR' })
    const page = await options.repository.listSessions(requestScope, {
      limit,
      archived: request.query.archived === 'true',
      ...(cursor ? { cursor } : {}),
    })
    const sessions = page.sessions.map((stored) => ({
      ...productionSessionResponse(stored),
      lastSequence: stored.highWaterSequence,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    }))
    const last = sessions.at(-1)
    return sessionListResponseSchema.parse({
      sessions,
      nextCursor:
        page.hasMore && last
          ? encodeSessionCursor({
              updatedAt: last.updatedAt,
              sessionId: last.sessionId,
            })
          : null,
    })
  })

  app.get<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const stored = await options.repository.getSession(
        requestScope,
        request.params.sessionId,
      )
      if (!stored) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' })
      return productionSessionResponse(stored)
    },
  )

  app.patch<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/conversation',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      const body = updateConversationRequestSchema.safeParse(request.body ?? {})
      if (!requestScope || !body.success)
        return reply.code(400).send({ code: 'VALIDATION_ERROR' })
      const folderId =
        body.data.folderId === null
          ? DEFAULT_CONVERSATION_FOLDER_ID
          : body.data.folderId
      if (folderId && folderId !== DEFAULT_CONVERSATION_FOLDER_ID) {
        const principal = requestPrincipals.get(request as object)
        if (!options.sharedFolders || !principal)
          return reply.code(403).send({ code: 'FOLDER_ACCESS_DENIED' })
        try {
          await options.sharedFolders.getFolder(
            { ...requestScope, principalId: opaquePrincipalId(principal) },
            folderId,
            'mutate',
          )
        } catch {
          return reply.code(404).send({ code: 'FOLDER_NOT_FOUND' })
        }
      }
      const updated = await options.repository.updateConversation(
        requestScope,
        request.params.sessionId,
        {
          ...(folderId !== undefined ? { folderId } : {}),
          ...(body.data.title !== undefined ? { title: body.data.title } : {}),
        },
      )
      if (!updated) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' })
      return productionSessionResponse(updated)
    },
  )

  app.post<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/archive',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      const body = updateSessionArchiveRequestSchema.safeParse(
        request.body ?? {},
      )
      if (!requestScope || !body.success)
        return reply.code(400).send({ code: 'VALIDATION_ERROR' })
      const updated = await options.repository.setSessionArchived(
        requestScope,
        request.params.sessionId,
        body.data.archived,
      )
      if (!updated) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' })
      return productionSessionResponse(updated)
    },
  )

  app.delete<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const stored = await options.repository.getSession(
        requestScope,
        request.params.sessionId,
      )
      if (!stored) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' })
      if (stored.folderId !== DEFAULT_CONVERSATION_FOLDER_ID) {
        const principal = requestPrincipals.get(request as object)
        if (!options.sharedFolders || !principal)
          return reply.code(403).send({ code: 'FOLDER_ACCESS_DENIED' })
        try {
          await options.sharedFolders.getFolder(
            { ...requestScope, principalId: opaquePrincipalId(principal) },
            stored.folderId,
            'mutate',
          )
        } catch {
          return reply.code(404).send({ code: 'FOLDER_NOT_FOUND' })
        }
      }
      const result = await options.repository.deleteSession(
        requestScope,
        request.params.sessionId,
      )
      if (result === 'not_found')
        return reply.code(404).send({ code: 'SESSION_NOT_FOUND' })
      if (result === 'active_run')
        return reply.code(409).send({ code: 'SESSION_HAS_ACTIVE_RUN' })
      return reply.code(204).send()
    },
  )

  app.post<{
    Params: { sessionId: string }
    Body: {
      prompt?: unknown
      approvalContext?: {
        kind?: unknown
        command?: unknown
        risk?: unknown
      }
    }
  }>('/v1/sessions/:sessionId/turns', async (request, reply) => {
    const admissionStarted = performance.now()
    const admissionSpan = telemetry.startSpan('turn.admission', {
      parent: requestTelemetry.get(request)?.context ?? null,
      attributes: { operation: 'turn.start' },
    })
    const requestScope = scope(request.headers)
    if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
    const unavailable = await requireReady()
    if (unavailable)
      return reply.code(503).send({
        code: 'PRODUCTION_DEPENDENCY_UNAVAILABLE',
        readiness: unavailable,
      })
    if (
      typeof request.body?.prompt !== 'string' ||
      request.body.prompt.length === 0 ||
      request.body.prompt.length > 100_000
    )
      return reply.code(400).send({ code: 'INVALID_PROMPT' })
    const idempotencyKey = header(request.headers['idempotency-key'])
    if (!idempotencyKey)
      return reply.code(400).send({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
    const storedSession = await options.repository.getSession(
      requestScope,
      request.params.sessionId,
    )
    if (!storedSession)
      return reply.code(404).send({ code: 'SESSION_NOT_FOUND' })
    // WP37: kullanıcı workspace'lerinde prompt düz metin yazılmaz. Content
    // key lease'i yoksa (login yok / süresi doldu) fail-closed 428 döner.
    let contentKeyLease: {
      contentKey: Buffer
      keyVersion: string
    } | null = null
    if (
      options.selfHostedAuth &&
      (await options.selfHostedAuth.isUserWorkspace(requestScope.workspaceId))
    ) {
      contentKeyLease = options.selfHostedAuth.leases.acquire(
        requestScope.workspaceId,
      )
      if (!contentKeyLease)
        return reply.code(428).send({ code: 'CONTENT_KEY_LOCKED' })
    }
    const billingDecision = await options.billing.admit({
      ...requestScope,
      requestKey: idempotencyKey,
      operation: 'turn.start',
      sessionId: request.params.sessionId,
    })
    if (billingDecision.outcome === 'deny')
      return reply.code(429).send(
        apiErrorResponseSchema.parse({
          code: 'COMMERCIAL_ADMISSION_DENIED',
          message: billingDecision.reason,
          reasonCode: billingDecision.reason,
          policyVersion: billingDecision.policyVersion,
          measurementWatermark: billingDecision.measurementWatermark,
        }),
      )
    const runId = `run_${randomUUID()}`
    const objectKey = `${requestScope.tenantId}/${requestScope.organizationId}/${requestScope.workspaceId}/runs/${runId}/input`
    try {
      await options.objectStore.put(
        objectKey,
        contentKeyLease
          ? await encryptUserContent(
              contentKeyLease,
              { ...requestScope, recordType: 'prompt', recordId: runId },
              encoder.encode(request.body.prompt),
            )
          : encoder.encode(request.body.prompt),
        contentKeyLease
          ? 'application/json; charset=utf-8'
          : 'text/plain; charset=utf-8',
      )
      const approvalContext = request.body.approvalContext
      const accepted = await options.repository.enqueueTurn({
        ...requestScope,
        sessionId: request.params.sessionId,
        runId,
        idempotencyKey,
        promptObjectKey: objectKey,
        requestBody: request.body,
        requiredRegionId: options.requiredRegionId,
        maxAttempts: 4,
        traceId: admissionSpan.context.traceId,
        ...(approvalContext
          ? {
              approval: {
                kind:
                  approvalContext.kind === 'file' ||
                  approvalContext.kind === 'network'
                    ? approvalContext.kind
                    : ('command' as const),
                context: {
                  command:
                    typeof approvalContext.command === 'string'
                      ? approvalContext.command
                      : 'opaque-command',
                  risk:
                    typeof approvalContext.risk === 'string'
                      ? approvalContext.risk
                      : 'bounded',
                },
              },
            }
          : {}),
      })
      if (!accepted.created)
        await options.objectStore.delete(objectKey).catch(() => undefined)
      await options.billing.bindDecision(
        requestScope,
        billingDecision.decisionId,
        accepted.run.runId,
      )
      const brokerSpan = telemetry.startSpan('event.publish', {
        parent: admissionSpan.context,
        attributes: { operation: 'broker.publish', 'event.type': 'run.queued' },
      })
      await options.broker.publish('ha.event', {
        schemaVersion: 1,
        type: 'run.queued',
        tenantId: requestScope.tenantId,
        workspaceId: requestScope.workspaceId,
        sessionId: request.params.sessionId,
        runId: accepted.run.runId,
        traceId: admissionSpan.context.traceId,
      })
      brokerSpan.end('ok')
      telemetry.recordMetric(
        'turn_admission_latency',
        performance.now() - admissionStarted,
        {
          context: admissionSpan.context,
          attributes: { outcome: accepted.created ? 'created' : 'idempotent' },
        },
      )
      admissionSpan.end('ok')
      return reply.code(202).send({
        tenantId: requestScope.tenantId,
        workspaceId: requestScope.workspaceId,
        sessionId: request.params.sessionId,
        runId: accepted.run.runId,
        queueItemId: accepted.run.queueItemId,
        codexThreadId: storedSession.codexThreadId ?? request.params.sessionId,
        codexTurnId: accepted.run.runId,
        idempotencyKey,
        status: accepted.approval ? 'awaiting_approval' : 'queued',
        approvalId: accepted.approval?.approvalId ?? null,
      })
    } catch (error) {
      admissionSpan.end('error', {
        'error.code':
          error instanceof Error
            ? error.message.slice(0, 64).replaceAll(/[^A-Za-z0-9_:-]/g, '_')
            : 'UNKNOWN',
      })
      await options.objectStore.delete(objectKey).catch(() => undefined)
      await options.billing
        .cancelDecision(requestScope, billingDecision.decisionId)
        .catch(() => undefined)
      if (error instanceof Error && error.message === 'IDEMPOTENCY_KEY_REUSED')
        return reply.code(409).send({ code: error.message })
      throw error
    }
  })

  app.post<{
    Params: { sessionId: string; turnId: string }
    Body: unknown
  }>(
    '/v1/sessions/:sessionId/turns/:turnId/interrupt',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      if (!interruptTurnRequestSchema.safeParse(request.body ?? {}).success)
        return reply.code(400).send({ code: 'VALIDATION_ERROR' })
      if (!header(request.headers['idempotency-key']))
        return reply.code(400).send({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
      if (!options.internalRuntimeToken)
        return reply.code(503).send({ code: 'RUNTIME_CONTROL_UNAVAILABLE' })
      const [session, run] = await Promise.all([
        options.repository.getSession(requestScope, request.params.sessionId),
        options.repository.getRun(requestScope, request.params.turnId),
      ])
      if (!session || !run || run.sessionId !== session.sessionId)
        return reply.code(404).send({ code: 'TURN_NOT_FOUND' })
      if (run.terminalAt)
        return turnActionResponseSchema.parse({
          ...requestScope,
          runId: run.runId,
          codexThreadId: run.codexThreadId ?? session.sessionId,
          codexTurnId: run.runId,
          status: 'interrupted',
        })

      const endpoint = new URL(
        `/internal/v1/runs/${encodeURIComponent(run.runId)}/interrupt`,
        options.runtimeControlReadinessUrl,
      )
      let runtimeResponse: Response | undefined
      for (let attempt = 0; attempt < 20; attempt += 1) {
        runtimeResponse = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.internalRuntimeToken}`,
          },
          body: '{}',
        })
        if (runtimeResponse.status !== 409) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!runtimeResponse?.ok) {
        const body = await runtimeResponse?.json().catch(() => null)
        return reply
          .code(runtimeResponse?.status ?? 503)
          .send(body ?? { code: 'RUNTIME_CONTROL_UNAVAILABLE' })
      }
      return reply.code(202).send(
        turnActionResponseSchema.parse({
          ...requestScope,
          runId: run.runId,
          codexThreadId: run.codexThreadId ?? session.sessionId,
          codexTurnId: run.runId,
          status: 'accepted',
        }),
      )
    },
  )

  app.get<{ Querystring: { status?: string } }>(
    '/v1/approvals',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const status = request.query.status
      const approvals = await options.repository.listApprovals(
        requestScope,
        status === 'pending' ||
          status === 'accepted' ||
          status === 'declined' ||
          status === 'expired'
          ? status
          : undefined,
      )
      return { approvals }
    },
  )

  app.post<{
    Params: { approvalId: string }
    Body: { decision?: unknown; expectedVersion?: unknown }
  }>('/v1/approvals/:approvalId/decision', async (request, reply) => {
    const approvalStarted = performance.now()
    const approvalSpan = telemetry.startSpan('approval.decision', {
      parent: requestTelemetry.get(request)?.context ?? null,
      attributes: { operation: 'approval.decision' },
    })
    const requestScope = scope(request.headers)
    if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
    const unavailable = await requireReady()
    if (unavailable)
      return reply.code(503).send({
        code: 'PRODUCTION_DEPENDENCY_UNAVAILABLE',
        readiness: unavailable,
      })
    if (
      (request.body?.decision !== 'accept' &&
        request.body?.decision !== 'decline') ||
      !Number.isInteger(request.body.expectedVersion)
    )
      return reply.code(400).send({ code: 'INVALID_APPROVAL_DECISION' })
    const decided = await options.repository.decideApproval({
      ...requestScope,
      approvalId: request.params.approvalId,
      expectedVersion: Number(request.body.expectedVersion),
      decision: request.body.decision,
      principalId:
        requestPrincipals.get(request)?.subject ?? 'opaque-principal',
    })
    if (!decided)
      return reply.code(409).send({ code: 'APPROVAL_VERSION_CONFLICT' })
    await options.broker.publish('ha.event', {
      schemaVersion: 1,
      type: 'approval.decided',
      tenantId: requestScope.tenantId,
      workspaceId: requestScope.workspaceId,
      sessionId: decided.sessionId,
      approvalId: decided.approvalId,
      runId: decided.runId,
      state: decided.state,
      traceId: approvalSpan.context.traceId,
    })
    telemetry.recordMetric(
      'approval_latency',
      performance.now() - approvalStarted,
      {
        context: approvalSpan.context,
        attributes: { outcome: decided.state },
      },
    )
    approvalSpan.end('ok')
    return decided
  })

  const readRunContentText = async (
    requestScope: ProductionScope,
    objectKey: string,
    recordType: 'prompt' | 'model_output' | 'raw_event',
    recordId: string,
  ) => {
    const bytes = await options.objectStore.get(objectKey)
    const envelope = parseUserContentEnvelope(bytes)
    if (!envelope) return decoder.decode(bytes)
    const lease = options.selfHostedAuth?.leases.acquire(
      requestScope.workspaceId,
    )
    if (!lease) throw new Error('CONTENT_KEY_LOCKED')
    try {
      return decoder.decode(
        await decryptUserContent(
          lease,
          { ...requestScope, recordType, recordId },
          envelope,
        ),
      )
    } catch {
      throw new Error('CONTENT_UNRECOVERABLE')
    }
  }

  const materializeProductionEvents = async (
    requestScope: ProductionScope,
    stored: ProductionEvent,
  ): Promise<TimelineEvent[]> => {
    if (stored.eventType === 'turn.started' && stored.runId) {
      const run = await options.repository.getRun(requestScope, stored.runId)
      const prompt = run?.promptObjectKey
        ? await readRunContentText(
            requestScope,
            run.promptObjectKey,
            'prompt',
            stored.runId,
          )
        : ''
      return [
        productionUserMessageEvent(stored, prompt),
        productionTimelineEvent(stored),
      ]
    }
    if (stored.eventType === 'agent.message.completed' && stored.runId) {
      const outputObjectKey =
        typeof stored.payload.outputObjectKey === 'string'
          ? stored.payload.outputObjectKey
          : null
      const text = outputObjectKey
        ? await readRunContentText(
            requestScope,
            outputObjectKey,
            'model_output',
            stored.runId,
          )
        : ''
      return [productionTimelineEvent(stored, text)]
    }
    if (stored.eventType === 'codex.notification') {
      const activityObjectKey =
        typeof stored.payload.activityObjectKey === 'string'
          ? stored.payload.activityObjectKey
          : null
      const recordId =
        typeof stored.payload.recordId === 'string'
          ? stored.payload.recordId
          : null
      if (!activityObjectKey || !recordId)
        return [productionTimelineEvent(stored)]
      const raw = await readRunContentText(
        requestScope,
        activityObjectKey,
        'raw_event',
        recordId,
      )
      return [productionCodexNotificationEvent(stored, JSON.parse(raw))]
    }
    return [productionTimelineEvent(stored)]
  }

  app.get<{
    Params: { sessionId: string }
    Querystring: { after?: string; limit?: string }
  }>('/v1/sessions/:sessionId/events', async (request, reply) => {
    const replayStarted = performance.now()
    const replaySpan = telemetry.startSpan('event.replay', {
      parent: requestTelemetry.get(request)?.context ?? null,
      attributes: { operation: 'event.replay' },
    })
    const requestScope = scope(request.headers)
    if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
    const storedSession = await options.repository.getSession(
      requestScope,
      request.params.sessionId,
    )
    if (!storedSession)
      return reply.code(404).send({ code: 'SESSION_NOT_FOUND' })
    const after = Number.parseInt(request.query.after ?? '0', 10)
    const limit = Math.min(
      500,
      Math.max(1, Number.parseInt(request.query.limit ?? '500', 10)),
    )
    const replay = await options.repository.replay(
      requestScope,
      request.params.sessionId,
      Number.isFinite(after) ? after : 0,
      limit,
    )
    let events: TimelineEvent[]
    try {
      events = (
        await Promise.all(
          replay.events.map((stored) =>
            materializeProductionEvents(requestScope, stored),
          ),
        )
      ).flat()
    } catch (error) {
      if (error instanceof Error && error.message === 'CONTENT_KEY_LOCKED')
        return reply.code(428).send({ code: 'CONTENT_KEY_LOCKED' })
      if (error instanceof Error && error.message === 'CONTENT_UNRECOVERABLE')
        return reply.code(410).send({ code: 'CONTENT_UNRECOVERABLE' })
      throw error
    }
    telemetry.recordMetric(
      'event_replay_lag',
      Math.max(0, performance.now() - replayStarted),
      {
        context: replaySpan.context,
        attributes: { outcome: 'success' },
      },
    )
    replaySpan.end('ok')
    return {
      ...requestScope,
      sessionId: request.params.sessionId,
      ...replay,
      events,
    }
  })

  // WP37: kullanıcı workspace'lerinde object storage'daki içerik EnvelopeV1
  // JSON'dur; yalnız geçerli content key lease'i ile çözülür. Lease yoksa
  // 428 CONTENT_KEY_LOCKED (yeniden login gerekir); crypto-erase sonrası
  // çözme kalıcı olarak başarısız olur ve 410 döner.
  const serveRunContent = async (
    requestScope: ProductionScope,
    objectKey: string,
    recordType: 'prompt' | 'model_output',
    recordId: string,
    reply: {
      code(status: number): { send(body: unknown): unknown }
      type(contentType: string): { send(body: unknown): unknown }
    },
  ) => {
    try {
      return reply
        .type('text/plain; charset=utf-8')
        .send(
          await readRunContentText(
            requestScope,
            objectKey,
            recordType,
            recordId,
          ),
        )
    } catch (error) {
      return error instanceof Error && error.message === 'CONTENT_KEY_LOCKED'
        ? reply.code(428).send({ code: 'CONTENT_KEY_LOCKED' })
        : reply.code(410).send({ code: 'CONTENT_UNRECOVERABLE' })
    }
  }

  app.get<{ Params: { runId: string } }>(
    '/v1/runs/:runId/output',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const stored = await options.repository.getRun(
        requestScope,
        request.params.runId,
      )
      if (!stored?.outputObjectKey)
        return reply.code(404).send({ code: 'OUTPUT_NOT_FOUND' })
      return await serveRunContent(
        requestScope,
        stored.outputObjectKey,
        'model_output',
        stored.runId,
        reply,
      )
    },
  )

  app.get<{ Params: { runId: string } }>(
    '/v1/runs/:runId/input',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const stored = await options.repository.getRun(
        requestScope,
        request.params.runId,
      )
      if (!stored?.promptObjectKey)
        return reply.code(404).send({ code: 'INPUT_NOT_FOUND' })
      return await serveRunContent(
        requestScope,
        stored.promptObjectKey,
        'prompt',
        stored.runId,
        reply,
      )
    },
  )

  app.get('/wp26', async (_request, reply) =>
    reply.type('text/html').send(`<!doctype html><meta charset="utf-8">
      <title>WP26 Production HA</title><main><h1>WP26 Production HA</h1>
      <div id="state">connecting</div><ol id="timeline"></ol><pre id="approval"></pre></main>
      <script>
      const q=new URLSearchParams(location.search),tenant=q.get('tenant'),workspace=q.get('workspace'),session=q.get('session');
      const headers={'x-tenant-id':tenant,'x-organization-id':tenant,'x-workspace-id':workspace};let after=0;
      function connect(){const protocol=location.protocol==='https:'?'wss:':'ws:';const socket=new WebSocket(protocol+'//'+location.host+'/v1/realtime?sessionId='+encodeURIComponent(session)+'&after='+after+'&tenant='+encodeURIComponent(tenant)+'&workspace='+encodeURIComponent(workspace));
        socket.onmessage=message=>{const value=JSON.parse(message.data);if(value.type==='hello'){document.body.dataset.instance=value.instanceId;document.querySelector('#state').textContent='connected high-water '+after;return}const event=value.event;if(event.sequence<=after)return;after=event.sequence;const li=document.createElement('li');li.dataset.sequence=event.sequence;li.textContent=event.eventType;document.querySelector('#timeline').append(li);document.querySelector('#state').textContent='connected high-water '+value.highWaterSequence};
        socket.onclose=()=>{document.querySelector('#state').textContent='reconnecting';setTimeout(connect,100)}}
      async function approvals(){try{const a=await fetch('/v1/approvals?status=pending',{headers}).then(r=>r.json());document.querySelector('#approval').textContent=JSON.stringify(a.approvals||[])}finally{setTimeout(approvals,100)}}connect();approvals();
      </script>`),
  )

  app.get('/v1/realtime', { websocket: true }, (socket, request) => {
    let closed = false
    socket.on('close', () => {
      closed = true
    })
    const pump = async (
      requestScope: ProductionScope,
      sessionId: string,
      initialAfter: number,
    ) => {
      let after = initialAfter
      socket.send(
        JSON.stringify({ type: 'hello', instanceId: options.instanceId }),
      )
      while (!closed) {
        const replay = await options.repository.replay(
          requestScope,
          sessionId,
          after,
          100,
        )
        for (const stored of replay.events) {
          after = stored.sequence
          for (const event of await materializeProductionEvents(
            requestScope,
            stored,
          ))
            socket.send(
              JSON.stringify({
                type: 'event',
                tenantId: requestScope.tenantId,
                workspaceId: requestScope.workspaceId,
                sessionId,
                event,
                highWaterSequence: replay.highWaterSequence,
              }),
            )
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    socket.once('message', (raw: unknown) => {
      void (async () => {
        const subscription = productionRealtimeSubscription(
          JSON.parse(String(raw)),
        )
        if (!subscription || !options.authentication) return socket.close(4400)
        const principal = await options.authentication.authenticate({
          authorization: `Bearer ${subscription.accessToken}`,
          headers: request.headers,
        })
        const requestScope = subscription.scope
        const membership = await options.repository.pool.query(
          `SELECT 1 FROM persistent_codex.organization_memberships m
           WHERE m.issuer=$1 AND m.subject=$2 AND m.organization_id=$3
             AND m.status='active'`,
          [principal.issuer, principal.subject, requestScope.organizationId],
        )
        if (!membership.rowCount) return socket.close(4403)
        const storedSession = await options.repository.getSession(
          requestScope,
          subscription.sessionId,
        )
        if (!storedSession) return socket.close(4404)
        await pump(
          requestScope,
          subscription.sessionId,
          subscription.afterSequence,
        )
      })().catch(() => socket.close(4401))
    })
  })

  const outboxTimer = setInterval(() => {
    void (async () => {
      const rows = await options.repository.listOutbox(100)
      const published: number[] = []
      for (const row of rows) {
        await options.broker.publish('ha.event', {
          schemaVersion: 1,
          type: 'timeline.event',
          tenantId: row.tenant_id,
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
          eventId: row.event_id,
          sequence: Number(row.sequence),
        })
        published.push(Number(row.outbox_id))
      }
      await options.repository.markOutboxPublished(published)
    })().catch(() => undefined)
  }, 100)
  outboxTimer.unref()
  app.addHook('onClose', async () => clearInterval(outboxTimer))
  return app
}

export async function buildProductionControlPlaneFromEnv(
  env: NodeJS.ProcessEnv,
) {
  const required = (name: string) => {
    const value = env[name]
    if (!value) throw new Error(`Production requires ${name}`)
    return value
  }
  const repository = createProductionPostgresRepository(
    required('TOPOLOGY_DATABASE_URL'),
  )
  const billing = createBillingPostgresRepository(
    required('TOPOLOGY_DATABASE_URL'),
    { productionBillingVerified: true },
  )
  const objectStore = new S3CompatibleObjectStore({
    endpoint: required('OBJECT_STORAGE_ENDPOINT'),
    bucket: required('OBJECT_STORAGE_BUCKET'),
    accessKeyId: required('OBJECT_STORAGE_ACCESS_KEY_ID'),
    secretAccessKey: required('OBJECT_STORAGE_SECRET_ACCESS_KEY'),
  })
  await objectStore.ensureBucket()
  const broker = new RabbitMqManagementBroker({
    endpoint: required('EVENT_BROKER_MANAGEMENT_URL'),
    username: required('EVENT_BROKER_USERNAME'),
    password: required('EVENT_BROKER_PASSWORD'),
    queue: required('EVENT_BROKER_QUEUE'),
  })
  await broker.ensureQueue()
  const telemetry = new ProductionTelemetry(
    () => new Date(),
    Number(env.TELEMETRY_MAX_RECORDS ?? 2_048),
  )
  // WP37: OIDC_SIGNING_KEY_FILE tanımlıysa self-hosted kullanıcı hesapları
  // etkinleşir; content key lease'leri için iç listener da burada başlar.
  const selfHostedAuth = createSelfHostedAuthFromEnv(
    env,
    repository.pool,
    required('TOPOLOGY_DATABASE_URL'),
  )
  if (selfHostedAuth) await selfHostedAuth.startInternalListener()
  const sharedFolders = new PostgresSharedFolderRepository(repository.pool)
  const app = await buildProductionControlPlane({
    instanceId: required('PERSISTENT_INSTANCE_ID'),
    repository,
    objectStore,
    broker,
    runtimeControlReadinessUrl: required('RUNTIME_CONTROL_READINESS_URL'),
    kmsReadinessUrl: required('KMS_READINESS_URL'),
    requiredRegionId: required('PERSISTENT_REGION_ID'),
    billing,
    logger: env.PERSISTENT_LOGGER === '1',
    telemetryScopeSalt: required('TELEMETRY_SCOPE_SALT'),
    telemetry,
    authentication: new OidcAuthenticationAdapter({
      issuer: required('OIDC_ISSUER'),
      audience: required('OIDC_AUDIENCE'),
    }),
    ...(env.PERSISTENT_DEPLOYMENT_PROFILE === 'cloud'
      ? {
          managedCloud: createManagedCloudProductionComposition({
            pool: repository.pool,
            productionRepository: repository,
            billing,
            objectStore,
            broker,
            regionId: required('PERSISTENT_REGION_ID'),
            runtimeResources: new HttpTenantRuntimeResources(
              required('RUNTIME_CONTROL_API_URL'),
              required('RUNTIME_CONTROL_SERVICE_TOKEN'),
            ),
            kms: new AwsKmsProvider(
              new HttpAwsKmsClient(
                required('KMS_API_URL'),
                required('KMS_SERVICE_TOKEN'),
              ),
              required('KMS_KEY_ID'),
              required('KMS_KEY_VERSION'),
            ),
            providerCapability: new StaticProviderAuthCapabilitySource({
              deploymentProfile: 'cloud',
              evidenceVersion: Number(
                required('PROVIDER_AUTH_EVIDENCE_VERSION'),
              ),
              featureFlags: JSON.parse(
                required('PROVIDER_AUTH_FEATURE_FLAGS_JSON'),
              ) as ProviderAuthFeatureFlags,
              evidenceProvider(provider, authMode) {
                const evidence = JSON.parse(
                  required('PROVIDER_AUTH_EVIDENCE_JSON'),
                ) as Record<string, ProviderAuthEvidence>
                return evidence[`${provider}:${authMode}`]
              },
            }),
            rolloutId: required('WP35_ROLLOUT_ID'),
            maxActiveTenants: Number(required('WP35_MAX_ACTIVE_TENANTS')),
          }),
        }
      : {}),
    ...(env.WEB_ALLOWED_ORIGIN
      ? { allowedWebOrigin: env.WEB_ALLOWED_ORIGIN }
      : {}),
    ...(selfHostedAuth ? { selfHostedAuth: selfHostedAuth.service } : {}),
    sharedFolders,
    ...(env.INTERNAL_RUNTIME_TOKEN_FILE
      ? {
          internalRuntimeToken: readFileSync(
            env.INTERNAL_RUNTIME_TOKEN_FILE,
            'utf8',
          ).trim(),
        }
      : {}),
  })
  app.addHook('onClose', async () => sharedFolders.close())
  if (selfHostedAuth) app.addHook('onClose', async () => selfHostedAuth.close())
  const exporter = env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OtlpHttpExporter(telemetry, env.OTEL_EXPORTER_OTLP_ENDPOINT)
    : null
  const telemetryTimer = exporter
    ? setInterval(() => void exporter.flush().catch(() => undefined), 1_000)
    : null
  telemetryTimer?.unref()
  app.addHook('onClose', async () =>
    Promise.all([
      repository.close(),
      billing.close(),
      ...(exporter ? [exporter.flush().catch(() => 0)] : []),
    ]),
  )
  app.addHook('onClose', async () => {
    if (telemetryTimer) clearInterval(telemetryTimer)
  })
  return app
}
