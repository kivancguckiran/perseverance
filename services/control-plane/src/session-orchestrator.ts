import { createHash, randomUUID } from 'node:crypto'
import type {
  ArtifactStorage,
  ArtifactScope,
} from '@persistent-codex/artifact-storage'
import { CodexEventAdapter } from '@persistent-codex/codex-event-adapter'
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
  CodexAppServerError,
  ProcessExitedError,
  ProcessUnavailableError,
  RequestTimeoutError,
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
type ThreadReadResponse = codexV2.ThreadReadResponse
type ThreadResumeResponse = codexV2.ThreadResumeResponse
type TurnSteerParams = codexV2.TurnSteerParams
type TurnSteerResponse = codexV2.TurnSteerResponse
type TurnInterruptParams = codexV2.TurnInterruptParams

interface RecoveryFailure {
  code:
    | 'THREAD_NOT_RESUMABLE'
    | 'RECOVERY_RUNTIME_UNAVAILABLE'
    | 'RECOVERY_TIMEOUT'
    | 'RECOVERY_AUTH_REQUIRED'
    | 'RECOVERY_TRANSIENT_FAILURE'
  message: string
  permanent: boolean
  statusCode: number
}

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
    | string
    | ((
        identity: Pick<WorkspaceRuntimeIdentity, 'tenantId' | 'workspaceId'>,
      ) => string)
  codexHome: (
    identity: Pick<WorkspaceRuntimeIdentity, 'tenantId' | 'workspaceId'>,
  ) => string
  runtimeClientFactory?: (
    identity: WorkspaceRuntimeIdentity,
  ) => WorkspaceRuntimeClient
  sessionIdFactory?: () => string
  runtimeInstanceIdFactory?: () => string
  sourceVersion?: string
  onDeliveryError?: WorkspaceRuntimeRegistryOptions['onDeliveryError']
  approvalPolicy?: ThreadStartParams['approvalPolicy']
  onRecoveryError?: (input: StoreScope & { code: string }) => void
  artifactStorage?: ArtifactStorage
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

function classifyRecoveryError(error: unknown): RecoveryFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof RequestTimeoutError)
    return {
      code: 'RECOVERY_TIMEOUT',
      message: 'Codex recovery request timed out',
      permanent: false,
      statusCode: 504,
    }
  if (
    error instanceof ProcessExitedError ||
    error instanceof ProcessUnavailableError
  )
    return {
      code: 'RECOVERY_RUNTIME_UNAVAILABLE',
      message: 'Codex runtime became unavailable during recovery',
      permanent: false,
      statusCode: 503,
    }
  if (/auth|unauthori[sz]ed|credential|login required/i.test(message))
    return {
      code: 'RECOVERY_AUTH_REQUIRED',
      message: 'Codex authentication is required before recovery can continue',
      permanent: false,
      statusCode: 401,
    }
  if (
    /not found|missing|rollout.*(?:corrupt|invalid)|history.*(?:corrupt|invalid)|identity mismatch|thread.*home/i.test(
      message,
    )
  )
    return {
      code: 'THREAD_NOT_RESUMABLE',
      message: 'The bound Codex thread cannot be read from this workspace home',
      permanent: true,
      statusCode: 409,
    }
  return {
    code: 'RECOVERY_TRANSIENT_FAILURE',
    message: 'Codex recovery failed temporarily',
    permanent: false,
    statusCode: error instanceof CodexAppServerError ? 503 : 502,
  }
}

export class SessionOrchestrator {
  readonly #store: SqliteEventStore
  readonly #workspaceCwd: SessionOrchestratorOptions['workspaceCwd']
  readonly #codexHome: SessionOrchestratorOptions['codexHome']
  readonly #sessionIdFactory: () => string
  readonly #sourceVersion: string
  readonly #approvalPolicy: ThreadStartParams['approvalPolicy'] | undefined
  readonly #onRecoveryError: SessionOrchestratorOptions['onRecoveryError']
  readonly #artifactStorage: ArtifactStorage | undefined
  readonly #commandArtifacts = new Map<
    string,
    { artifactId: string; scope: ArtifactScope }
  >()
  readonly #registry: WorkspaceRuntimeRegistry
  readonly #threadScopes = new Map<string, StoreScope>()
  readonly #adapters = new Map<string, CodexEventAdapter>()
  readonly #turnsInFlight = new Map<string, Promise<TurnAcceptedResponse>>()
  readonly #resumesInFlight = new Map<string, Promise<SessionResponse>>()
  readonly #actionsInFlight = new Map<string, Promise<unknown>>()
  readonly #activeTurns = new Map<
    string,
    { sessionId: string; turnId?: string }
  >()

  constructor(options: SessionOrchestratorOptions) {
    this.#store = options.store
    this.#workspaceCwd = options.workspaceCwd
    this.#codexHome = options.codexHome
    this.#sessionIdFactory =
      options.sessionIdFactory ?? (() => `ses_${randomUUID()}`)
    this.#sourceVersion = options.sourceVersion ?? '0.144.2'
    this.#approvalPolicy = options.approvalPolicy
    this.#onRecoveryError = options.onRecoveryError
    this.#artifactStorage = options.artifactStorage
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
          for (const session of this.#store.listWorkspaceSessions(runtime)) {
            if (
              session.codexThreadId &&
              session.status === 'active' &&
              session.runtimeGeneration !== null &&
              session.runtimeGeneration !== runtime.client.processGeneration
            ) {
              void this.resumeSession(
                session,
                `auto-runtime-${runtime.runtimeInstanceId}-${runtime.client.processGeneration}`,
              ).catch((error) => {
                this.#onRecoveryError?.({
                  ...session,
                  code:
                    error instanceof OrchestrationError
                      ? error.code
                      : 'RECOVERY_TRANSIENT_FAILURE',
                })
              })
            }
          }
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
      const runtime = await this.#registry.getOrInitialize({
        ...input,
        cwd,
        codexHome: this.#codexHome(input),
      })
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
      this.#store.updateSessionRecovery(scope, {
        status: 'active',
        runtimeGeneration: runtime.client.processGeneration,
      })
      this.#threadScopes.set(this.#threadKey(input, codexThreadId), scope)
      return this.getSession(scope)
    } catch (error) {
      this.#store.updateSessionStatus(scope, 'failed')
      throw new OrchestrationError(
        'SESSION_START_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  getSession(scope: StoreScope): SessionResponse {
    const session = this.#store.getSession(scope)
    const runtime = this.#registry.get(scope)
    return sessionResponseSchema.parse({
      ...session,
      runtimeConnected: runtime?.client.health.state === 'ready',
      replay: { afterSequence: 0, highWaterSequence: session.lastSequence },
      recoveryOptions:
        session.status === 'recovery_required'
          ? ['retry_resume', 'start_new_session', 'view_read_only']
          : session.status === 'recovering' && session.recoveryErrorCode
            ? ['retry_resume', 'view_read_only']
            : [],
    })
  }

  async resumeSession(
    scope: StoreScope,
    idempotencyKey: string,
  ): Promise<SessionResponse> {
    const session = this.#store.getSession(scope)
    if (!session.codexThreadId)
      throw new OrchestrationError(
        'THREAD_NOT_RESUMABLE',
        'Session has no Codex thread binding',
        409,
      )
    const keyScope = `resume:${scope.sessionId}`
    const hash = createHash('sha256')
      .update(session.codexThreadId)
      .digest('hex')
    const reservation = this.#store.reserveIdempotencyKey({
      ...scope,
      scope: keyScope,
      key: idempotencyKey,
      requestHash: hash,
    })
    if (!reservation.created) {
      if (reservation.record.status === 'completed')
        return sessionResponseSchema.parse(reservation.record.response)
      if (reservation.record.status === 'outcome_unknown')
        throw new OrchestrationError(
          'RECOVERY_OUTCOME_UNKNOWN',
          'Previous resume outcome is unknown; use a new explicit retry key',
          409,
        )
      const flight = this.#resumesInFlight.get(
        JSON.stringify([scope.tenantId, scope.workspaceId, scope.sessionId]),
      )
      if (flight) return flight
      throw new OrchestrationError(
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        'Resume is already in progress',
        409,
      )
    }
    const flightKey = JSON.stringify([
      scope.tenantId,
      scope.workspaceId,
      scope.sessionId,
    ])
    const existing = this.#resumesInFlight.get(flightKey)
    if (existing) return existing
    const operation = this.#resumeReserved(
      scope,
      session.codexThreadId,
      keyScope,
      idempotencyKey,
    )
    this.#resumesInFlight.set(flightKey, operation)
    try {
      return await operation
    } finally {
      this.#resumesInFlight.delete(flightKey)
    }
  }

  async #resumeReserved(
    scope: StoreScope,
    threadId: string,
    keyScope: string,
    key: string,
  ): Promise<SessionResponse> {
    this.#store.updateSessionRecovery(scope, { status: 'recovering' })
    try {
      const cwd =
        typeof this.#workspaceCwd === 'function'
          ? this.#workspaceCwd(scope)
          : this.#workspaceCwd
      const runtime = await this.#registry.getOrInitialize({
        ...scope,
        cwd,
        codexHome: this.#codexHome(scope),
      })
      const read = await runtime.client.request<ThreadReadResponse>(
        'thread/read',
        { threadId, includeTurns: true } satisfies codexV2.ThreadReadParams,
      )
      if (read.thread.id !== threadId)
        throw new Error('Thread identity mismatch')
      this.#reconcileSnapshot(scope, read.thread, 'thread/read')
      const resumed = await runtime.client.request<ThreadResumeResponse>(
        'thread/resume',
        {
          threadId,
          cwd,
          ...(this.#approvalPolicy
            ? { approvalPolicy: this.#approvalPolicy }
            : {}),
        } satisfies codexV2.ThreadResumeParams,
      )
      if (resumed.thread.id !== threadId)
        throw new Error('Thread identity mismatch')
      this.#reconcileSnapshot(scope, resumed.thread, 'thread/resume')
      this.#threadScopes.set(this.#threadKey(scope, threadId), scope)
      const active = [...resumed.thread.turns]
        .reverse()
        .find((turn) => turn.status === 'inProgress')
      if (active)
        this.#activeTurns.set(this.#activeTurnKey(scope), {
          sessionId: scope.sessionId,
          turnId: active.id,
        })
      const record = this.#store.updateSessionRecovery(scope, {
        status: 'active',
        runtimeGeneration: runtime.client.processGeneration,
        resumed: true,
      })
      const response = this.getSession(record)
      this.#store.completeIdempotencyKey({
        ...scope,
        scope: keyScope,
        key,
        status: 'completed',
        response,
      })
      return response
    } catch (error) {
      const failure = classifyRecoveryError(error)
      this.#store.updateSessionRecovery(scope, {
        status: failure.permanent ? 'recovery_required' : 'recovering',
        recoveryErrorCode: failure.code,
      })
      this.#store.completeIdempotencyKey({
        ...scope,
        scope: keyScope,
        key,
        status: 'failed',
        response: failure,
      })
      throw new OrchestrationError(
        failure.code,
        failure.message,
        failure.statusCode,
      )
    }
  }

  #reconcileSnapshot(
    scope: StoreScope,
    thread: codexV2.Thread,
    snapshotMethod: 'thread/read' | 'thread/resume',
  ): void {
    for (const turn of thread.turns) {
      for (const item of turn.items) {
        const envelope = {
          method: 'item/completed',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item,
            completedAtMs: turn.completedAt ? turn.completedAt * 1_000 : 0,
          },
        }
        this.#ingestRecoveryEnvelope(
          scope,
          envelope,
          `recovery:item:${thread.id}:${turn.id}:${item.id}`,
          snapshotMethod,
        )
      }
      if (turn.status !== 'inProgress') {
        const envelope = {
          method: 'turn/completed',
          params: { threadId: thread.id, turn },
        }
        this.#ingestRecoveryEnvelope(
          scope,
          envelope,
          `recovery:turn:${thread.id}:${turn.id}:${turn.status}`,
          snapshotMethod,
        )
      }
    }
  }

  #ingestRecoveryEnvelope(
    scope: StoreScope,
    envelope: Record<string, unknown>,
    ingestKey: string,
    snapshotMethod: string,
  ): void {
    const adapter = this.#adapterFor(scope)
    const adapted = adapter.adapt(envelope)
    this.#spillCommandOutput(adapted)
    if (this.#store.hasEquivalentTimelineEvent(scope, adapted.event)) return
    this.#store.ingest({
      ...scope,
      ingestKey,
      raw: {
        envelope: adapted.envelope,
        checksum: adapted.checksum,
        sourceMethod: adapted.event.sourceMethod,
        sourceVersion: this.#sourceVersion,
        sourceMetadata: {
          recoverySnapshot: true,
          snapshotMethod,
        },
        receivedAt: adapted.event.receivedAt,
      },
      event: adapted.event,
    })
  }

  #adapterFor(scope: StoreScope): CodexEventAdapter {
    const adapterKey = JSON.stringify([
      scope.tenantId,
      scope.workspaceId,
      scope.sessionId,
    ])
    let adapter = this.#adapters.get(adapterKey)
    if (!adapter) {
      adapter = new CodexEventAdapter({
        ...scope,
        sourceVersion: this.#sourceVersion,
        nextSequence: () => 0,
      })
      this.#adapters.set(adapterKey, adapter)
    }
    return adapter
  }

  async steerTurn(
    scope: StoreScope,
    turnId: string,
    expectedTurnId: string,
    prompt: string,
    idempotencyKey: string,
  ) {
    return this.#idempotentTurnAction(
      scope,
      `steer:${scope.sessionId}:${turnId}`,
      idempotencyKey,
      createHash('sha256')
        .update(JSON.stringify({ expectedTurnId, prompt }))
        .digest('hex'),
      () => this.#steerTurn(scope, turnId, expectedTurnId, prompt),
    )
  }

  async #steerTurn(
    scope: StoreScope,
    turnId: string,
    expectedTurnId: string,
    prompt: string,
  ) {
    const session = this.#store.getSession(scope)
    const active = this.#activeTurns.get(this.#activeTurnKey(scope))
    if (!active?.turnId)
      throw new OrchestrationError(
        'NO_ACTIVE_TURN',
        'There is no active turn',
        409,
      )
    if (turnId !== expectedTurnId || active.turnId !== expectedTurnId)
      throw new OrchestrationError(
        'ACTIVE_TURN_CONFLICT',
        'expectedTurnId does not match the active turn',
        409,
      )
    const runtime = this.#registry.get(scope)
    if (!runtime || !session.codexThreadId)
      throw new OrchestrationError(
        'WORKSPACE_RUNTIME_UNAVAILABLE',
        'Workspace runtime is unavailable',
        503,
      )
    const params: TurnSteerParams = {
      threadId: session.codexThreadId,
      expectedTurnId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    }
    const response = await runtime.client.request<TurnSteerResponse>(
      'turn/steer',
      params,
    )
    return {
      ...scope,
      codexThreadId: session.codexThreadId,
      codexTurnId: response.turnId,
      status: 'accepted' as const,
    }
  }

  async interruptTurn(
    scope: StoreScope,
    turnId: string,
    idempotencyKey: string,
  ) {
    return this.#idempotentTurnAction(
      scope,
      `interrupt:${scope.sessionId}:${turnId}`,
      idempotencyKey,
      createHash('sha256').update(JSON.stringify({ turnId })).digest('hex'),
      () => this.#interruptTurn(scope, turnId),
    )
  }

  async #interruptTurn(scope: StoreScope, turnId: string) {
    const session = this.#store.getSession(scope)
    const activeKey = this.#activeTurnKey(scope)
    const active = this.#activeTurns.get(activeKey)
    if (!session.codexThreadId)
      throw new OrchestrationError(
        'SESSION_NOT_ACTIVE',
        'Session has no thread',
        409,
      )
    if (!active)
      return {
        ...scope,
        codexThreadId: session.codexThreadId,
        codexTurnId: turnId,
        status: 'interrupted' as const,
      }
    if (active.turnId && active.turnId !== turnId)
      throw new OrchestrationError(
        'ACTIVE_TURN_CONFLICT',
        'Turn is not active',
        409,
      )
    const runtime = this.#registry.get(scope)
    if (!runtime)
      throw new OrchestrationError(
        'WORKSPACE_RUNTIME_UNAVAILABLE',
        'Workspace runtime is unavailable',
        503,
      )
    await runtime.client.request('turn/interrupt', {
      threadId: session.codexThreadId,
      turnId,
    } satisfies TurnInterruptParams)
    this.#store.expireApprovals(scope, 'superseded')
    this.#activeTurns.delete(activeKey)
    return {
      ...scope,
      codexThreadId: session.codexThreadId,
      codexTurnId: turnId,
      status: 'interrupted' as const,
    }
  }

  async #idempotentTurnAction<T>(
    scope: StoreScope,
    keyScope: string,
    key: string,
    requestHash: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const reservation = this.#store.reserveIdempotencyKey({
      ...scope,
      scope: keyScope,
      key,
      requestHash,
    })
    const flightKey = JSON.stringify([
      scope.tenantId,
      scope.workspaceId,
      keyScope,
      key,
    ])
    if (!reservation.created) {
      if (reservation.record.status === 'completed')
        return reservation.record.response as T
      if (reservation.record.status === 'outcome_unknown')
        throw new OrchestrationError(
          'RECOVERY_OUTCOME_UNKNOWN',
          'Previous upstream action outcome is unknown and will not be retried',
          409,
        )
      if (reservation.record.status === 'failed') {
        const failure = reservation.record.response as {
          code: string
          message: string
        }
        throw new OrchestrationError(failure.code, failure.message, 409)
      }
      const pending = this.#actionsInFlight.get(flightKey) as
        Promise<T> | undefined
      if (pending) return pending
      throw new OrchestrationError(
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        'The turn action is already in progress',
        409,
      )
    }
    const running = (async () => {
      try {
        const response = await operation()
        this.#store.completeIdempotencyKey({
          ...scope,
          scope: keyScope,
          key,
          status: 'completed',
          response,
        })
        return response
      } catch (error) {
        this.#store.completeIdempotencyKey({
          ...scope,
          scope: keyScope,
          key,
          status: 'failed',
          response: errorPayload(error),
        })
        throw error
      }
    })()
    this.#actionsInFlight.set(flightKey, running)
    try {
      return await running
    } finally {
      this.#actionsInFlight.delete(flightKey)
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
    const adapter = this.#adapterFor(scope)
    const adapted = adapter.adapt(message)
    this.#spillCommandOutput(adapted)
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

  #spillCommandOutput(adapted: ReturnType<CodexEventAdapter['adapt']>): void {
    const event = adapted.event
    if (!this.#artifactStorage || !event.codexTurnId || !event.codexItemId)
      return
    const key = JSON.stringify([
      event.tenantId,
      event.workspaceId,
      event.sessionId,
      event.codexTurnId,
      event.codexItemId,
    ])
    const scope: ArtifactScope = {
      tenantId: event.tenantId,
      workspaceId: event.workspaceId,
      sessionId: event.sessionId,
      turnId: event.codexTurnId,
      itemId: event.codexItemId,
    }
    if (event.type === 'command.output.delta') {
      let record = this.#commandArtifacts.get(key)
      if (!record) {
        const created = this.#artifactStorage.create(scope)
        record = { artifactId: created.artifactId, scope }
        this.#commandArtifacts.set(key, record)
      }
      const metadata = this.#artifactStorage.append({
        artifactId: record.artifactId,
        scope,
        chunkIndex: event.payload.chunkIndex,
        stream: event.payload.stream,
        data: event.payload.text,
      })
      const range = metadata.ranges.at(-1)!
      event.payload.artifact = {
        artifactId: record.artifactId,
        startByte: range.startByte,
        endByte: range.endByte,
        byteLength: range.byteLength,
      }
      const params = adapted.envelope.params as { delta?: unknown } | undefined
      if (params && 'delta' in params) params.delta = event.payload.text
      return
    }
    if (event.type === 'command.completed') {
      let record = this.#commandArtifacts.get(key)
      if (!record) {
        const created = this.#artifactStorage.create(scope)
        record = { artifactId: created.artifactId, scope }
        this.#commandArtifacts.set(key, record)
        if (event.payload.output.previewTail)
          this.#artifactStorage.append({
            artifactId: record.artifactId,
            scope,
            chunkIndex: 0,
            stream: 'combined',
            data: event.payload.output.previewTail,
          })
      }
      const metadata = this.#artifactStorage.finalize(record.artifactId, scope)
      event.payload.output = {
        ...event.payload.output,
        totalBytes: metadata.byteLength,
        sha256: metadata.sha256,
        artifact: {
          artifactId: record.artifactId,
          startByte: 0,
          endByte: Math.max(0, metadata.byteLength - 1),
          byteLength: metadata.byteLength,
        },
      }
      const params = adapted.envelope.params as
        { item?: { aggregatedOutput?: unknown } } | undefined
      if (params?.item && 'aggregatedOutput' in params.item)
        params.item.aggregatedOutput = event.payload.output.previewTail
      this.#commandArtifacts.delete(key)
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
