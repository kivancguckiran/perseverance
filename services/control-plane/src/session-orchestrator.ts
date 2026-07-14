import { createHash, randomUUID } from 'node:crypto'
import {
  CodexEventAdapter,
  type EventAdapterContext,
} from '@persistent-codex/codex-event-adapter'
import { codexV2 } from '@persistent-codex/codex-protocol-generated'
import {
  sessionResponseSchema,
  turnAcceptedResponseSchema,
  type SessionResponse,
  type TurnAcceptedResponse,
} from '@persistent-codex/control-plane-contracts'
import {
  SqliteEventStore,
  StoreConflictError,
  type StoreScope,
  type ApprovalDecision,
  type ApprovalRecord,
} from '@persistent-codex/event-store'
import {
  WorkspaceRuntimeRegistry,
  type RuntimeDelivery,
  type WorkspaceRuntime,
  type WorkspaceRuntimeClient,
  type WorkspaceRuntimeIdentity,
  type WorkspaceRuntimeRegistryOptions,
} from '@persistent-codex/workspace-agent'

type ThreadStartParams = codexV2.ThreadStartParams
type ThreadStartResponse = codexV2.ThreadStartResponse
type TurnStartParams = codexV2.TurnStartParams
type TurnStartResponse = codexV2.TurnStartResponse

export class OrchestrationError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(code: string, message: string, statusCode = 502) {
    super(message)
    this.name = 'OrchestrationError'
    this.code = code
    this.statusCode = statusCode
  }
}

export interface SessionOrchestratorOptions {
  store: SqliteEventStore
  workspaceCwd:
    string | ((identity: Omit<WorkspaceRuntimeIdentity, 'cwd'>) => string)
  runtimeClientFactory?: (
    identity: WorkspaceRuntimeIdentity,
  ) => WorkspaceRuntimeClient
  sessionIdFactory?: () => string
  runtimeInstanceIdFactory?: () => string
  sourceVersion?: string
  onDeliveryError?: WorkspaceRuntimeRegistryOptions['onDeliveryError']
  approvalPolicy?: ThreadStartParams['approvalPolicy']
}

function threadIdOf(message: Record<string, unknown>): string | undefined {
  const params = message.params
  if (!params || typeof params !== 'object' || Array.isArray(params))
    return undefined
  const record = params as Record<string, unknown>
  if (typeof record.threadId === 'string') return record.threadId
  const thread = record.thread
  if (thread && typeof thread === 'object' && !Array.isArray(thread)) {
    const id = (thread as Record<string, unknown>).id
    if (typeof id === 'string') return id
  }
  return undefined
}

function requestHash(prompt: string): string {
  return createHash('sha256').update(JSON.stringify({ prompt })).digest('hex')
}

function approvalResponse(
  decision: ApprovalDecision,
):
  | codexV2.CommandExecutionRequestApprovalResponse
  | codexV2.FileChangeRequestApprovalResponse {
  return {
    decision: decision === 'accept_for_session' ? 'acceptForSession' : decision,
  }
}

function errorPayload(error: unknown) {
  return {
    code:
      error instanceof OrchestrationError
        ? error.code
        : 'CODEX_TURN_START_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }
}

export class SessionOrchestrator {
  readonly #store: SqliteEventStore
  readonly #workspaceCwd: SessionOrchestratorOptions['workspaceCwd']
  readonly #sessionIdFactory: () => string
  readonly #sourceVersion: string
  readonly #approvalPolicy: ThreadStartParams['approvalPolicy'] | undefined
  readonly #registry: WorkspaceRuntimeRegistry
  readonly #threadScopes = new Map<string, StoreScope>()
  readonly #adapters = new Map<string, CodexEventAdapter>()
  readonly #turnsInFlight = new Map<string, Promise<TurnAcceptedResponse>>()
  readonly #activeTurns = new Map<
    string,
    { sessionId: string; turnId?: string }
  >()

  constructor(options: SessionOrchestratorOptions) {
    this.#store = options.store
    this.#workspaceCwd = options.workspaceCwd
    this.#sessionIdFactory =
      options.sessionIdFactory ?? (() => `ses_${randomUUID()}`)
    this.#sourceVersion = options.sourceVersion ?? '0.144.2'
    this.#approvalPolicy = options.approvalPolicy
    this.#registry = new WorkspaceRuntimeRegistry({
      ...(options.runtimeClientFactory
        ? { clientFactory: options.runtimeClientFactory }
        : {}),
      ...(options.runtimeInstanceIdFactory
        ? { runtimeInstanceIdFactory: options.runtimeInstanceIdFactory }
        : {}),
      ...(options.onDeliveryError
        ? { onDeliveryError: options.onDeliveryError }
        : {}),
      onMessage: (runtime, message, delivery) =>
        this.#ingestRuntimeMessage(runtime, message, delivery),
      onHealthChange: (runtime, health) => {
        if (health.state === 'ready') {
          this.#store.expireRuntimeApprovals({
            ...runtime,
            currentProcessGeneration: runtime.client.processGeneration,
          })
        } else if (['restarting', 'failed', 'stopped'].includes(health.state)) {
          this.#store.expireRuntimeApprovals(runtime)
        }
      },
    })
  }

  get registry(): WorkspaceRuntimeRegistry {
    return this.#registry
  }

  async createSession(input: {
    tenantId: string
    workspaceId: string
  }): Promise<SessionResponse> {
    const scope: StoreScope = {
      ...input,
      sessionId: this.#sessionIdFactory(),
    }
    this.#store.createSession({ ...scope, status: 'starting' })
    const cwd =
      typeof this.#workspaceCwd === 'function'
        ? this.#workspaceCwd(input)
        : this.#workspaceCwd

    try {
      const runtime = await this.#registry.getOrInitialize({ ...input, cwd })
      const params: ThreadStartParams = {
        cwd,
        ...(this.#approvalPolicy
          ? { approvalPolicy: this.#approvalPolicy }
          : {}),
      }
      const response = await runtime.client.request<ThreadStartResponse>(
        'thread/start',
        params,
      )
      const codexThreadId = response.thread.id
      this.#store.bindCodexThread(scope, codexThreadId)
      this.#store.updateSessionStatus(scope, 'active')
      this.#threadScopes.set(this.#threadKey(input, codexThreadId), scope)
      return sessionResponseSchema.parse({
        ...scope,
        codexThreadId,
        status: 'active',
      })
    } catch (error) {
      this.#store.updateSessionStatus(scope, 'failed')
      throw new OrchestrationError(
        'SESSION_START_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  async startTurn(
    scope: StoreScope,
    prompt: string,
    idempotencyKey: string,
  ): Promise<TurnAcceptedResponse> {
    const session = this.#store.getSession(scope)
    if (session.status !== 'active' || !session.codexThreadId) {
      throw new OrchestrationError(
        'SESSION_NOT_ACTIVE',
        'Session must be active and bound to a Codex thread',
        409,
      )
    }
    const hash = requestHash(prompt)
    const keyScope = `turn:${scope.sessionId}`
    const reservation = this.#store.reserveIdempotencyKey({
      ...scope,
      scope: keyScope,
      key: idempotencyKey,
      requestHash: hash,
    })
    const flightKey = JSON.stringify([
      scope.tenantId,
      scope.workspaceId,
      keyScope,
      idempotencyKey,
    ])

    if (!reservation.created) {
      if (reservation.record.status === 'completed') {
        return turnAcceptedResponseSchema.parse(reservation.record.response)
      }
      if (reservation.record.status === 'failed') {
        const failure = reservation.record.response as {
          code?: string
          message?: string
        } | null
        throw new OrchestrationError(
          failure?.code ?? 'CODEX_TURN_START_FAILED',
          failure?.message ?? 'Previous turn start failed',
        )
      }
      const pending = this.#turnsInFlight.get(flightKey)
      if (pending) return pending
      throw new OrchestrationError(
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        'An earlier request with this idempotency key is still pending',
        409,
      )
    }

    const activeTurnKey = this.#activeTurnKey(scope)
    if (this.#activeTurns.has(activeTurnKey)) {
      const failure = {
        code: 'WORKSPACE_TURN_ACTIVE',
        message: 'Workspace already has an active Codex turn',
      }
      this.#store.completeIdempotencyKey({
        ...scope,
        scope: keyScope,
        key: idempotencyKey,
        status: 'failed',
        response: failure,
      })
      throw new OrchestrationError(failure.code, failure.message, 409)
    }
    this.#activeTurns.set(activeTurnKey, { sessionId: scope.sessionId })

    const operation = this.#startReservedTurn(
      scope,
      session.codexThreadId,
      prompt,
      idempotencyKey,
      keyScope,
    )
    this.#turnsInFlight.set(flightKey, operation)
    try {
      return await operation
    } finally {
      this.#turnsInFlight.delete(flightKey)
    }
  }

  async close(): Promise<void> {
    await this.#registry.stopAll()
  }

  async decideApproval(input: {
    tenantId: string
    workspaceId: string
    approvalId: string
    decision: ApprovalDecision
    expectedVersion: number
    userId: string
  }): Promise<ApprovalRecord> {
    const approval = this.#store.getApproval(input, input.approvalId)
    if (!approval.availableDecisions.includes(input.decision)) {
      throw new OrchestrationError(
        'INVALID_APPROVAL_DECISION',
        'Decision is not available for this approval',
        400,
      )
    }
    const runtime = this.#registry.get(input)
    if (!runtime || runtime.runtimeInstanceId !== approval.runtimeInstanceId) {
      this.#store.finishApproval({
        ...input,
        status: 'expired',
        upstreamResponseStatus: 'unknown',
      })
      throw new OrchestrationError(
        'APPROVAL_RUNTIME_UNAVAILABLE',
        'Original approval runtime is unavailable',
        409,
      )
    }
    if (runtime.client.processGeneration !== approval.processGeneration) {
      this.#store.finishApproval({
        ...input,
        status: 'expired',
        upstreamResponseStatus: 'unknown',
      })
      throw new OrchestrationError(
        'APPROVAL_GENERATION_MISMATCH',
        'Approval belongs to an earlier process generation',
        409,
      )
    }
    this.#store.beginApprovalResolution(input)
    try {
      runtime.client.respond(
        approval.requestId,
        approvalResponse(input.decision),
      )
    } catch (error) {
      this.#store.finishApproval({
        ...input,
        status: 'expired',
        upstreamResponseStatus: 'unknown',
      })
      throw new OrchestrationError(
        'APPROVAL_RUNTIME_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
        503,
      )
    }
    return this.#store.finishApproval({
      ...input,
      upstreamResponseStatus: 'sent',
    })
  }

  async #startReservedTurn(
    scope: StoreScope,
    codexThreadId: string,
    prompt: string,
    idempotencyKey: string,
    keyScope: string,
  ): Promise<TurnAcceptedResponse> {
    try {
      const runtime = this.#registry.get(scope)
      if (!runtime) {
        throw new OrchestrationError(
          'WORKSPACE_RUNTIME_UNAVAILABLE',
          'Workspace runtime is not initialized',
          503,
        )
      }
      const params: TurnStartParams = {
        threadId: codexThreadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      }
      const upstream = await runtime.client.request<TurnStartResponse>(
        'turn/start',
        params,
      )
      const response = turnAcceptedResponseSchema.parse({
        ...scope,
        codexThreadId,
        codexTurnId: upstream.turn.id,
        idempotencyKey,
      })
      this.#store.completeIdempotencyKey({
        ...scope,
        scope: keyScope,
        key: idempotencyKey,
        status: 'completed',
        response,
      })
      this.#activeTurns.set(this.#activeTurnKey(scope), {
        sessionId: scope.sessionId,
        turnId: upstream.turn.id,
      })
      return response
    } catch (error) {
      this.#activeTurns.delete(this.#activeTurnKey(scope))
      const failure = errorPayload(error)
      this.#store.completeIdempotencyKey({
        ...scope,
        scope: keyScope,
        key: idempotencyKey,
        status: 'failed',
        response: failure,
      })
      if (error instanceof OrchestrationError) throw error
      throw new OrchestrationError(failure.code, failure.message)
    }
  }

  async #ingestRuntimeMessage(
    runtime: WorkspaceRuntime,
    message: Record<string, unknown>,
    delivery: RuntimeDelivery,
  ): Promise<void> {
    const codexThreadId = threadIdOf(message)
    if (!codexThreadId) return
    const scope = this.#threadScopes.get(
      this.#threadKey(runtime, codexThreadId),
    )
    if (!scope) return
    const adapterKey = JSON.stringify([
      scope.tenantId,
      scope.workspaceId,
      scope.sessionId,
    ])
    let adapter = this.#adapters.get(adapterKey)
    if (!adapter) {
      const context: EventAdapterContext = {
        ...scope,
        sourceVersion: this.#sourceVersion,
        nextSequence: () => 0,
      }
      adapter = new CodexEventAdapter(context)
      this.#adapters.set(adapterKey, adapter)
    }
    const adapted = adapter.adapt(message)
    const approvalPayload =
      adapted.event.type === 'approval.requested'
        ? adapted.event.payload
        : undefined
    const approval =
      approvalPayload && delivery.kind === 'request'
        ? (() => {
            const fileContext =
              approvalPayload.approvalKind === 'file'
                ? this.#store.findFileApprovalContext({
                    ...scope,
                    turnId: adapted.event.codexTurnId!,
                    itemId: adapted.event.codexItemId!,
                  })
                : { filePath: null, diff: null, diffAvailable: false }
            return {
              ...scope,
              approvalId: `apr_${createHash('sha256')
                .update(
                  JSON.stringify([
                    runtime.runtimeInstanceId,
                    delivery.processGeneration,
                    approvalPayload.requestId,
                  ]),
                )
                .digest('hex')
                .slice(0, 24)}`,
              turnId: adapted.event.codexTurnId!,
              itemId: adapted.event.codexItemId!,
              requestId: approvalPayload.requestId,
              runtimeInstanceId: runtime.runtimeInstanceId,
              processGeneration: delivery.processGeneration,
              kind:
                approvalPayload.approvalKind === 'command'
                  ? ('command_execution' as const)
                  : ('file_change' as const),
              context: {
                command: approvalPayload.command,
                cwd: approvalPayload.cwd,
                reason: approvalPayload.reason,
                grantRoot: approvalPayload.grantRoot,
                commandActions:
                  (adapted.envelope.params as Record<string, unknown>)
                    ?.commandActions ?? null,
                networkApprovalContext:
                  (adapted.envelope.params as Record<string, unknown>)
                    ?.networkApprovalContext ?? null,
                filePath: fileContext.filePath,
                diff: fileContext.diff,
                diffAvailable: fileContext.diffAvailable,
              },
              availableDecisions: [
                'accept',
                'accept_for_session',
                'decline',
                'cancel',
              ] as ApprovalDecision[],
              requestedAt: adapted.event.occurredAt,
            }
          })()
        : undefined
    this.#store.ingest({
      ...scope,
      ingestKey: delivery.ingestKey,
      raw: {
        envelope: adapted.envelope,
        checksum: adapted.checksum,
        sourceMethod: adapted.event.sourceMethod,
        sourceVersion: this.#sourceVersion,
        sourceMetadata: {
          processGeneration: delivery.processGeneration,
          receiveOrdinal: delivery.receiveOrdinal,
          envelopeKind: delivery.kind,
        },
        receivedAt: adapted.event.receivedAt,
      },
      event: adapted.event,
      ...(approval ? { approval } : {}),
    })
    if (message.method === 'serverRequest/resolved') {
      const params = message.params as { requestId?: string | number }
      if (params?.requestId !== undefined) {
        const found = this.#store.findApprovalByRequest({
          ...scope,
          runtimeInstanceId: runtime.runtimeInstanceId,
          processGeneration: delivery.processGeneration,
          requestId: params.requestId,
        })
        if (found && found.upstreamResponseStatus !== 'acknowledged')
          this.#store.finishApproval({
            ...scope,
            approvalId: found.approvalId,
            upstreamResponseStatus: 'acknowledged',
          })
      }
    }
    if (adapted.event.type === 'turn.completed') {
      this.#store.expireApprovals(scope, 'superseded')
      const activeTurnKey = this.#activeTurnKey(scope)
      const active = this.#activeTurns.get(activeTurnKey)
      if (
        active?.sessionId === scope.sessionId &&
        (!active.turnId || active.turnId === adapted.event.codexTurnId)
      ) {
        this.#activeTurns.delete(activeTurnKey)
      }
    }
  }

  #threadKey(
    identity: Pick<WorkspaceRuntimeIdentity, 'tenantId' | 'workspaceId'>,
    codexThreadId: string,
  ) {
    return JSON.stringify([
      identity.tenantId,
      identity.workspaceId,
      codexThreadId,
    ])
  }

  #activeTurnKey(
    identity: Pick<WorkspaceRuntimeIdentity, 'tenantId' | 'workspaceId'>,
  ) {
    return JSON.stringify([identity.tenantId, identity.workspaceId])
  }
}

export function isIdempotencyConflict(error: unknown) {
  return (
    error instanceof StoreConflictError &&
    error.code === 'IDEMPOTENCY_HASH_CONFLICT'
  )
}
