import { setImmediate as waitForImmediate } from 'node:timers/promises'
import { LocalArtifactStorage } from '@persistent-codex/artifact-storage'
import { artifactMetadataSchema } from '@persistent-codex/control-plane-contracts'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import {
  ackMessageSchema,
  approvalDecisionRequestSchema,
  approvalListResponseSchema,
  approvalSchema,
  apiErrorResponseSchema,
  clientMessageSchema,
  createSessionRequestSchema,
  createTurnRequestSchema,
  steerTurnRequestSchema,
  interruptTurnRequestSchema,
  sessionResponseSchema,
  turnActionResponseSchema,
  replayResponseSchema,
  serverMessageSchema,
  type ServerMessage,
  type SubscribeMessage,
  type Approval,
} from '@persistent-codex/control-plane-contracts'
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
} from './session-orchestrator'

interface RealtimeSocket {
  send(data: string): void
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
  runtimeInstanceIdFactory?: () => string
  approvalPolicy?: 'untrusted' | 'on-request' | 'never'
  codexHomeRoot?: string
  codexProvisioningSource?: string
  artifactRoot?: string
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

function workspaceScope(
  headers: Record<string, string | string[] | undefined>,
): { tenantId: string; workspaceId: string } | undefined {
  const tenantId = headerValue(headers['x-tenant-id'])
  const workspaceId = headerValue(headers['x-workspace-id'])
  if (!tenantId || !workspaceId) return undefined
  return { tenantId, workspaceId }
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

function send(socket: RealtimeSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(serverMessageSchema.parse(message)))
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
  const store = options.eventStore ?? new SqliteEventStore(options.databasePath)
  const ownsStore = options.eventStore === undefined
  const artifacts = new LocalArtifactStorage(
    options.artifactRoot ?? '.runtime/artifacts',
  )
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
    ...(options.runtimeInstanceIdFactory
      ? { runtimeInstanceIdFactory: options.runtimeInstanceIdFactory }
      : {}),
    ...(options.approvalPolicy
      ? { approvalPolicy: options.approvalPolicy }
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
  })

  await app.register(cors, { origin: true })
  await app.register(websocket)

  app.addHook('onClose', async () => {
    await orchestrator.close()
    if (ownsStore) store.close()
  })

  app.get('/healthz', async () => ({ status: 'ok' }))
  app.get('/v1/meta', async () => ({
    service: 'persistent-codex-control-plane',
    phase: 'poc',
    codexVersion: '0.144.2',
    transport: 'stdio-jsonl',
  }))

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
    try {
      const metadata = artifacts.metadata(request.params.artifactId, scope)
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
      const body = artifacts.read(request.params.artifactId, scope, selected)
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
      return reply.send(Buffer.from(body))
    } catch {
      return reply
        .code(404)
        .send({ code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found' })
    }
  })

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
        })
        const safe = approvalSchema.parse(result)
        store.completeIdempotencyKey({
          ...scope,
          scope: `approval:${request.params.approvalId}`,
          key,
          status: 'completed',
          response: safe,
        })
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
      return reply.code(201).send(await orchestrator.createSession(scope))
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
        return sessionResponseSchema.parse(
          await orchestrator.resumeSession(scope, key),
        )
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
        return turnActionResponseSchema.parse(
          await orchestrator.steerTurn(
            scope,
            request.params.turnId,
            body.data.expectedTurnId,
            body.data.prompt,
            idempotencyKey,
          ),
        )
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
        return turnActionResponseSchema.parse(
          await orchestrator.interruptTurn(
            scope,
            request.params.turnId,
            idempotencyKey,
          ),
        )
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
        return reply
          .code(202)
          .send(
            await orchestrator.startTurn(
              scope,
              body.data.prompt,
              idempotencyKey,
            ),
          )
      } catch (error) {
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

  app.get('/v1/realtime', { websocket: true }, (socket) => {
    let subscription: SubscriptionState | undefined

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
      send(socket, ack)
    })
  })

  return app
}
