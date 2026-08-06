import { createHash, randomUUID } from 'node:crypto'
import type {
  ArtifactMetadata,
  ArtifactStorage,
  ArtifactScope,
} from '@perseverance/artifact-storage'
import {
  DEFAULT_ARTIFACT_CHUNK_BYTES,
  redactCommandOutput,
} from '@perseverance/artifact-storage'
import { parseTimelineEvent } from '@perseverance/domain-events'
import {
  CodexEventAdapter,
  CodexProviderRuntimeAdapter,
} from '@perseverance/codex-event-adapter'
import { codexV2 } from '@perseverance/codex-protocol-generated'
import {
  attachmentContextEnd,
  attachmentContextStart,
  readinessResponseSchema,
  sessionResponseSchema,
  turnAcceptedResponseSchema,
  type SessionResponse,
  type ReadinessResponse,
  type TurnAcceptedResponse,
} from '@perseverance/control-plane-contracts'
import {
  SqliteEventStore,
  StoreConflictError,
  StoreNotFoundError,
  type StoreScope,
  type ApprovalDecision,
  type ApprovalRecord,
} from '@perseverance/event-store'
import {
  DEFAULT_CONVERSATION_POLICY,
  DEFAULT_TITLE_POLICY,
  DEFAULT_MODEL_ALIAS_CONFIG,
  ProviderConfigurationError,
  resolveModelSelection,
  type ModelAliasConfig,
  type PriceCatalog,
  type ProviderId,
  type ProviderModelCatalog,
  type ProviderRuntimeAdapterV1,
  type ModelSelection,
} from '@perseverance/provider-platform'
import {
  ClaudeCodeRuntimeAdapter,
  CursorAgentRuntimeAdapter,
  GeminiCliRuntimeAdapter,
} from '@perseverance/provider-cli-adapters'
import { CodexTitleProcessRunner } from './title-process-runner'
import {
  codexAccountAuthMode,
  normalizeCodexAccountLimits,
  unavailableCodexAccountLimits,
} from './codex-account-limits'
import {
  archiveInstallGuidance,
  isArchiveAttachment,
} from './production-turn-input'
import {
  CodexAppServerError,
  ProcessExitedError,
  ProcessUnavailableError,
  RequestTimeoutError,
  GitSnapshotReader,
  WorkspaceRuntimeRegistry,
  type GitSnapshotResult,
  type RuntimeDelivery,
  type WorkspaceRuntime,
  type WorkspaceRuntimeClient,
  type WorkspaceRuntimeIdentity,
  type WorkspaceRuntimeServices,
  type WorkspaceRuntimeRegistryOptions,
} from '@perseverance/workspace-agent'

type ThreadStartParams = codexV2.ThreadStartParams
type ThreadStartResponse = codexV2.ThreadStartResponse
type TurnStartParams = codexV2.TurnStartParams
type TurnStartResponse = codexV2.TurnStartResponse
type ThreadReadResponse = codexV2.ThreadReadResponse
type ThreadResumeResponse = codexV2.ThreadResumeResponse
type ThreadArchiveParams = codexV2.ThreadArchiveParams
type ThreadArchiveResponse = codexV2.ThreadArchiveResponse
type ThreadDeleteParams = codexV2.ThreadDeleteParams
type ThreadDeleteResponse = codexV2.ThreadDeleteResponse
type ThreadUnarchiveParams = codexV2.ThreadUnarchiveParams
type ThreadUnarchiveResponse = codexV2.ThreadUnarchiveResponse
type TurnSteerParams = codexV2.TurnSteerParams
type TurnSteerResponse = codexV2.TurnSteerResponse
type TurnInterruptParams = codexV2.TurnInterruptParams

export interface TurnAttachmentInput {
  attachmentId: string
  name: string
  mediaType: string
  kind: 'image' | 'file'
  path: string
}

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
  runIdFactory?: () => string
  runtimeInstanceIdFactory?: () => string
  runtimeServicesFactory?: (
    identity: WorkspaceRuntimeIdentity,
  ) => WorkspaceRuntimeServices
  sourceVersion?: string
  onDeliveryError?: WorkspaceRuntimeRegistryOptions['onDeliveryError']
  approvalPolicy?: ThreadStartParams['approvalPolicy']
  onRecoveryError?: (input: StoreScope & { code: string }) => void
  onRuntimeHealth?: (
    input: Pick<WorkspaceRuntimeIdentity, 'tenantId' | 'workspaceId'> & {
      state:
        | 'stopped'
        | 'starting'
        | 'initializing'
        | 'ready'
        | 'restarting'
        | 'failed'
      restartAttempt: number
      processGeneration: number
    },
  ) => void
  onAuthTransition?: (input: {
    tenantId: string
    workspaceId: string
    fromState: string
    toState: string
  }) => void
  artifactStorage?: ArtifactStorage
  modelAliases?: ModelAliasConfig
  priceCatalog?: PriceCatalog
  providerCatalogs?: ProviderModelCatalog[]
  providerAdapterFactory?: (input: {
    provider: 'claude' | 'gemini' | 'cursor'
    catalog: ProviderModelCatalog
    scope: StoreScope
  }) => ProviderRuntimeAdapterV1
  cursorForceAllowed?: boolean
  titleGenerator?: (input: {
    scope: StoreScope
    modelId: string
    reasoningEffort: 'none'
    messages: string[]
  }) => Promise<{
    title: string
    usage?: import('@perseverance/provider-platform').UsageReport
  }>
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

function isUnauthorizedDisconnect(message: Record<string, unknown>): boolean {
  if (message.method !== 'error') return false
  const params = message.params as Record<string, unknown> | undefined
  const error = params?.error as Record<string, unknown> | undefined
  const info = error?.codexErrorInfo as Record<string, unknown> | undefined
  const disconnected = info?.responseStreamDisconnected as
    Record<string, unknown> | undefined
  return (
    disconnected?.httpStatusCode === 401 ||
    error?.codexErrorInfo === 'unauthorized'
  )
}

function requestHash(
  prompt: string,
  attachments: TurnAttachmentInput[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        prompt,
        attachmentIds: attachments.map((attachment) => attachment.attachmentId),
      }),
    )
    .digest('hex')
}

function turnPromptWithAttachmentContext(
  prompt: string,
  attachments: TurnAttachmentInput[],
): string {
  const files = attachments.filter((attachment) => attachment.kind === 'file')
  if (files.length === 0) return prompt
  const context = [
    attachmentContextStart,
    'The following local files are attached to this message. Open and inspect them using their exact paths when answering:',
    ...files.map(
      (file) => `- ${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`,
    ),
    ...(files.some(isArchiveAttachment) ? [archiveInstallGuidance] : []),
    attachmentContextEnd,
  ].join('\n')
  return prompt ? `${prompt}\n\n${context}` : context
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

function isThreadUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not found|missing|not loaded|rollout.*(?:corrupt|invalid)|history.*(?:corrupt|invalid)|identity mismatch|thread.*home/i.test(
    message,
  )
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
  if (isThreadUnavailableError(error))
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
  readonly #runIdFactory: () => string
  readonly #sourceVersion: string
  readonly #approvalPolicy: ThreadStartParams['approvalPolicy'] | undefined
  readonly #onRecoveryError: SessionOrchestratorOptions['onRecoveryError']
  readonly #artifactStorage: ArtifactStorage | undefined
  readonly #onRuntimeHealth: SessionOrchestratorOptions['onRuntimeHealth']
  readonly #onAuthTransition: SessionOrchestratorOptions['onAuthTransition']
  readonly #modelAliases: ModelAliasConfig
  readonly #priceCatalog: PriceCatalog | undefined
  readonly #providerCatalogs: Map<ProviderId, ProviderModelCatalog>
  readonly #providerAdapterFactory: SessionOrchestratorOptions['providerAdapterFactory']
  readonly #cursorForceAllowed: boolean
  readonly #titleGenerator: NonNullable<
    SessionOrchestratorOptions['titleGenerator']
  >
  readonly #cliAdapters = new Map<string, ProviderRuntimeAdapterV1>()
  readonly #titleJobsInFlight = new Set<string>()
  readonly #authStates = new Map<string, string>()
  readonly #gitReaders = new Map<string, GitSnapshotReader>()
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
  readonly #authFailures = new Set<string>()
  readonly #readinessInFlight = new Map<string, Promise<ReadinessResponse>>()
  readonly #activeTurns = new Map<
    string,
    { sessionId: string; turnId?: string }
  >()

  #persistArtifact(metadata: ArtifactMetadata): void {
    this.#store.upsertArtifact({
      artifactId: metadata.artifactId,
      tenantId: metadata.tenantId,
      workspaceId: metadata.workspaceId,
      sessionId: metadata.sessionId,
      turnId: metadata.turnId,
      itemId: metadata.itemId,
      kind: metadata.kind,
      byteLength: metadata.byteLength,
      sha256: metadata.sha256,
      chunkCount: metadata.chunkCount,
      finalized: metadata.finalized,
      status: metadata.status,
      createdAt: metadata.createdAt,
      finalizedAt: metadata.finalizedAt,
    })
  }

  constructor(options: SessionOrchestratorOptions) {
    this.#store = options.store
    this.#workspaceCwd = options.workspaceCwd
    this.#codexHome = options.codexHome
    this.#sessionIdFactory =
      options.sessionIdFactory ?? (() => `ses_${randomUUID()}`)
    this.#runIdFactory = options.runIdFactory ?? (() => `run_${randomUUID()}`)
    this.#sourceVersion = options.sourceVersion ?? '0.144.2'
    this.#approvalPolicy = options.approvalPolicy
    this.#onRecoveryError = options.onRecoveryError
    this.#artifactStorage = options.artifactStorage
    this.#onRuntimeHealth = options.onRuntimeHealth
    this.#onAuthTransition = options.onAuthTransition
    this.#modelAliases = options.modelAliases ?? DEFAULT_MODEL_ALIAS_CONFIG
    this.#priceCatalog = options.priceCatalog
    this.#providerCatalogs = new Map(
      (options.providerCatalogs ?? []).map((catalog) => [
        catalog.identity.provider,
        catalog,
      ]),
    )
    this.#providerAdapterFactory = options.providerAdapterFactory
    this.#cursorForceAllowed = options.cursorForceAllowed ?? false
    this.#store.markDetachedCliRunsRecoveryRequired()
    this.#titleGenerator =
      options.titleGenerator ?? ((input) => this.#generateCodexTitle(input))
    this.#registry = new WorkspaceRuntimeRegistry({
      ...(options.runtimeClientFactory
        ? { clientFactory: options.runtimeClientFactory }
        : {}),
      ...(options.runtimeInstanceIdFactory
        ? { runtimeInstanceIdFactory: options.runtimeInstanceIdFactory }
        : {}),
      ...(options.runtimeServicesFactory
        ? { runtimeServicesFactory: options.runtimeServicesFactory }
        : {}),
      ...(options.onDeliveryError
        ? { onDeliveryError: options.onDeliveryError }
        : {}),
      onMessage: (runtime, message, delivery) =>
        this.#ingestRuntimeMessage(runtime, message, delivery),
      onHealthChange: (runtime, health) => {
        this.#onRuntimeHealth?.({
          tenantId: runtime.tenantId,
          workspaceId: runtime.workspaceId,
          state: health.state,
          restartAttempt: health.restartAttempt,
          processGeneration: runtime.client.processGeneration,
        })
        if (health.state === 'ready') {
          this.#store.expireRuntimeApprovals({
            ...runtime,
            currentProcessGeneration: runtime.client.processGeneration,
          })
          for (const session of this.#store.listWorkspaceSessions(runtime)) {
            const hasDetachedActiveRun =
              this.#store.getActiveDurableRun(session) !== null
            if (
              session.codexThreadId &&
              session.status === 'active' &&
              (hasDetachedActiveRun ||
                (session.runtimeGeneration !== null &&
                  session.runtimeGeneration !==
                    runtime.client.processGeneration))
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
    queueMicrotask(() => {
      for (const job of this.#store.listRunnableConversationTitleJobs())
        this.#scheduleTitleJob(job)
    })
  }

  get registry(): WorkspaceRuntimeRegistry {
    return this.#registry
  }

  async getCodexAccountLimits(input: {
    tenantId: string
    workspaceId: string
  }) {
    const cwd =
      typeof this.#workspaceCwd === 'function'
        ? this.#workspaceCwd(input)
        : this.#workspaceCwd
    const runtime = await this.#registry.getOrInitialize({
      ...input,
      cwd,
      codexHome: this.#codexHome(input),
    })
    const account = await runtime.client.request<codexV2.GetAccountResponse>(
      'account/read',
      { refreshToken: false } satisfies codexV2.GetAccountParams,
    )
    const authMode = codexAccountAuthMode(account.account)
    if (authMode !== 'chatgpt')
      return unavailableCodexAccountLimits(authMode, 'unsupported')
    const limits =
      await runtime.client.request<codexV2.GetAccountRateLimitsResponse>(
        'account/rateLimits/read',
        undefined,
      )
    return normalizeCodexAccountLimits(limits)
  }

  async checkReadiness(
    input: { tenantId: string; workspaceId: string },
    refreshToken = false,
  ): Promise<ReadinessResponse> {
    const key = JSON.stringify([input.tenantId, input.workspaceId])
    const current = this.#readinessInFlight.get(key)
    if (current) return current
    const operation = this.#checkReadiness(input, refreshToken)
    this.#readinessInFlight.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.#readinessInFlight.get(key) === operation)
        this.#readinessInFlight.delete(key)
    }
  }

  async #checkReadiness(
    input: { tenantId: string; workspaceId: string },
    refreshToken: boolean,
  ): Promise<ReadinessResponse> {
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
      const response = await runtime.client.request<codexV2.GetAccountResponse>(
        'account/read',
        { refreshToken } satisfies codexV2.GetAccountParams,
      )
      const ready = response.account !== null || !response.requiresOpenaiAuth
      const authKey = JSON.stringify([input.tenantId, input.workspaceId])
      const nextAuthState = ready ? 'ready' : 'required'
      const previousAuthState = this.#authStates.get(authKey) ?? 'unknown'
      if (previousAuthState !== nextAuthState) {
        this.#authStates.set(authKey, nextAuthState)
        this.#onAuthTransition?.({
          ...input,
          fromState: previousAuthState,
          toState: nextAuthState,
        })
      }
      if (ready) {
        const prefix = JSON.stringify([
          input.tenantId,
          input.workspaceId,
        ]).slice(0, -1)
        for (const key of this.#authFailures)
          if (key.startsWith(prefix)) this.#authFailures.delete(key)
      }
      return readinessResponseSchema.parse({
        status: ready ? 'ready' : 'setup_required',
        checkedAt: new Date().toISOString(),
        checks: [
          {
            name: 'auth',
            status: ready ? 'ready' : 'failed',
            code: ready ? null : 'AUTH_REQUIRED',
          },
        ],
        recovery: {
          code: ready ? null : 'AUTH_REQUIRED',
          instruction: ready ? null : 'codex login',
          retryable: !ready,
          readOnlyAvailable: true,
        },
      })
    } catch {
      const authKey = JSON.stringify([input.tenantId, input.workspaceId])
      const previousAuthState = this.#authStates.get(authKey) ?? 'unknown'
      if (previousAuthState !== 'failed') {
        this.#authStates.set(authKey, 'failed')
        this.#onAuthTransition?.({
          ...input,
          fromState: previousAuthState,
          toState: 'failed',
        })
      }
      return readinessResponseSchema.parse({
        status: 'degraded',
        checkedAt: new Date().toISOString(),
        checks: [{ name: 'auth', status: 'failed', code: 'AUTH_CHECK_FAILED' }],
        recovery: {
          code: null,
          instruction: null,
          retryable: true,
          readOnlyAvailable: true,
        },
      })
    }
  }

  async requireAuthReady(input: {
    tenantId: string
    workspaceId: string
  }): Promise<void> {
    const readiness = await this.checkReadiness(input)
    if (readiness.status !== 'ready')
      throw new OrchestrationError(
        readiness.status === 'setup_required'
          ? 'AUTH_REQUIRED'
          : 'READINESS_DEGRADED',
        readiness.status === 'setup_required'
          ? 'Run codex login, then retry readiness'
          : 'Codex readiness check failed',
        readiness.status === 'setup_required' ? 401 : 503,
      )
  }

  #cliAdapter(
    provider: 'claude' | 'gemini' | 'cursor',
    scope: StoreScope,
  ): ProviderRuntimeAdapterV1 {
    const key = JSON.stringify([
      scope.tenantId,
      scope.workspaceId,
      scope.sessionId,
      provider,
    ])
    const existing = this.#cliAdapters.get(key)
    if (existing) return existing
    const catalog = this.#providerCatalogs.get(provider)
    if (!catalog)
      throw new OrchestrationError(
        'PROVIDER_CATALOG_NOT_CONFIGURED',
        `Configure ${provider} in PERSISTENT_PROVIDER_CATALOGS_JSON before creating this conversation`,
        409,
      )
    const adapter =
      this.#providerAdapterFactory?.({ provider, catalog, scope }) ??
      (provider === 'claude'
        ? new ClaudeCodeRuntimeAdapter({
            catalog,
            context: { ...scope, nextSequence: () => 0 },
          })
        : provider === 'gemini'
          ? new GeminiCliRuntimeAdapter({
              catalog,
              context: { ...scope, nextSequence: () => 0 },
            })
          : new CursorAgentRuntimeAdapter({
              catalog,
              context: { ...scope, nextSequence: () => 0 },
            }))
    this.#cliAdapters.set(key, adapter)
    return adapter
  }

  async listProviderCatalogs(input: {
    tenantId: string
    workspaceId: string
  }): Promise<ProviderModelCatalog[]> {
    const catalogs = [...this.#providerCatalogs.values()]
    try {
      const cwd =
        typeof this.#workspaceCwd === 'function'
          ? this.#workspaceCwd(input)
          : this.#workspaceCwd
      const runtime = await this.#registry.getOrInitialize({
        ...input,
        cwd,
        codexHome: this.#codexHome(input),
      })
      const adapter = new CodexProviderRuntimeAdapter({
        transport: runtime.client,
        events: this.#adapterFor({ ...input, sessionId: '__catalog__' }),
        sourceVersion: this.#sourceVersion,
      })
      catalogs.push(await adapter.discoverModelCatalog())
    } catch {
      // Catalog endpoint remains useful for configured providers when Codex is unavailable.
    }
    return catalogs.sort((left, right) =>
      left.identity.provider.localeCompare(right.identity.provider),
    )
  }

  async listProviderReadiness(input: {
    tenantId: string
    workspaceId: string
  }) {
    const entries = await Promise.all(
      (['claude', 'gemini', 'cursor'] as const).flatMap((provider) =>
        this.#providerCatalogs.has(provider)
          ? [
              (async () =>
                [
                  provider,
                  await this.#cliAdapter(provider, {
                    ...input,
                    sessionId: '__readiness__',
                  }).checkReadiness!(),
                ] as const)(),
            ]
          : [],
      ),
    )
    return Object.fromEntries(entries)
  }

  async createSession(input: {
    tenantId: string
    workspaceId: string
    folderId?: string | null
    title?: string
    provider?: ProviderId
    model?: ModelSelection
  }): Promise<SessionResponse> {
    const requestedProvider = input.provider ?? 'codex'
    if (requestedProvider === 'codex') await this.requireAuthReady(input)
    const scope: StoreScope = {
      ...input,
      sessionId: this.#sessionIdFactory(),
    }
    const cwd =
      typeof this.#workspaceCwd === 'function'
        ? this.#workspaceCwd(input)
        : this.#workspaceCwd

    const runtime =
      requestedProvider === 'codex'
        ? await this.#registry.getOrInitialize({
            ...input,
            cwd,
            codexHome: this.#codexHome(input),
          })
        : null
    const provider =
      requestedProvider === 'codex'
        ? new CodexProviderRuntimeAdapter({
            transport: runtime!.client,
            events: this.#adapterFor(scope),
            sourceVersion: this.#sourceVersion,
          })
        : this.#cliAdapter(requestedProvider, scope)
    let resolved
    try {
      const requested =
        input.model ??
        (requestedProvider === 'codex'
          ? DEFAULT_CONVERSATION_POLICY
          : (() => {
              const configured = this.#providerCatalogs
                .get(requestedProvider)
                ?.models.find((model) => model.isDefault && !model.hidden)
              if (!configured)
                throw new ProviderConfigurationError(
                  'MODEL_ALIAS_UNRESOLVED',
                  `Configure a default ${requestedProvider} model catalog before creating this conversation`,
                )
              return {
                modelId: configured.modelId,
                reasoningEffort: configured.defaultReasoningEffort,
              }
            })())
      resolved = resolveModelSelection(
        requestedProvider,
        requested,
        this.#modelAliases,
        await provider.discoverModelCatalog(),
      )
    } catch (error) {
      if (error instanceof ProviderConfigurationError)
        throw new OrchestrationError(
          error.code,
          error.message,
          ['REASONING_EFFORT_UNSUPPORTED', 'MODEL_ALIAS_UNRESOLVED'].includes(
            error.code,
          )
            ? 409
            : 500,
        )
      throw error
    }
    if (requestedProvider !== 'codex') {
      const readiness = await (
        provider as ProviderRuntimeAdapterV1
      ).checkReadiness?.()
      if (readiness && !readiness.ready)
        throw new OrchestrationError(
          readiness.code === 'auth_required'
            ? 'AUTH_REQUIRED'
            : 'PROVIDER_SETUP_REQUIRED',
          readiness.instruction ?? `${requestedProvider} provider is not ready`,
          readiness.code === 'auth_required' ? 401 : 503,
        )
    }
    this.#store.createSessionWithAudit(
      {
        ...scope,
        status: 'starting',
        folderId: input.folderId ?? null,
        title: input.title ?? 'Yeni konuşma',
        provider: resolved.provider,
        requestedPolicy: resolved.requested,
        resolvedModel: resolved.modelId,
        reasoningEffort: resolved.reasoningEffort,
        capabilitySnapshot: resolved.capabilitySnapshot,
      },
      {
        ...scope,
        actor: 'system',
        action: 'session.created',
        outcome: 'success',
        idempotencyKey: `session:${scope.sessionId}:created`,
        metadata: { toState: 'starting' },
      },
    )

    if (requestedProvider !== 'codex') {
      this.#store.updateSessionRecoveryWithAudit(
        scope,
        { status: 'active', runtimeGeneration: null },
        {
          ...scope,
          actor: 'system',
          action: 'session.lifecycle_changed',
          outcome: 'success',
          idempotencyKey: `session:${scope.sessionId}:active`,
          metadata: { fromState: 'starting', toState: 'active' },
        },
      )
      return this.getSession(scope)
    }
    try {
      const params: ThreadStartParams = {
        cwd,
        model: resolved.modelId,
        ...(this.#approvalPolicy
          ? { approvalPolicy: this.#approvalPolicy }
          : {}),
      }
      const response = await runtime!.client.request<ThreadStartResponse>(
        'thread/start',
        params,
      )
      const codexThreadId = response.thread.id
      this.#store.bindCodexThread(scope, codexThreadId)
      this.#store.updateSessionRecoveryWithAudit(
        scope,
        {
          status: 'active',
          runtimeGeneration: runtime!.client.processGeneration,
        },
        {
          ...scope,
          actor: 'system',
          action: 'session.lifecycle_changed',
          outcome: 'success',
          idempotencyKey: `session:${scope.sessionId}:active`,
          metadata: { fromState: 'starting', toState: 'active' },
        },
      )
      this.#threadScopes.set(this.#threadKey(input, codexThreadId), scope)
      return this.getSession(scope)
    } catch (error) {
      this.#store.updateSessionStatusWithAudit(scope, 'failed', {
        ...scope,
        actor: 'system',
        action: 'session.lifecycle_changed',
        outcome: 'failure',
        idempotencyKey: `session:${scope.sessionId}:failed`,
        metadata: {
          fromState: 'starting',
          toState: 'failed',
          reasonCode: 'SESSION_START_FAILED',
        },
      })
      throw new OrchestrationError(
        'SESSION_START_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  getSession(scope: StoreScope): SessionResponse {
    const session = this.#store.getSession(scope)
    const runtime = this.#registry.get(scope)
    const activeRun = this.#store.getActiveDurableRun(scope)
    const latestRun = this.#store.getLatestDurableRun(scope)
    return sessionResponseSchema.parse({
      ...session,
      runtimeConnected:
        session.provider === 'codex'
          ? runtime?.client.health.state === 'ready'
          : this.#cliAdapters.has(
              JSON.stringify([
                scope.tenantId,
                scope.workspaceId,
                scope.sessionId,
                session.provider,
              ]),
            ),
      activeRun,
      latestRun,
      replay: { afterSequence: 0, highWaterSequence: session.lastSequence },
      recoveryOptions:
        session.status === 'recovery_required'
          ? ['retry_resume', 'start_new_session', 'view_read_only']
          : session.status === 'recovering' && session.recoveryErrorCode
            ? ['retry_resume', 'view_read_only']
            : [],
    })
  }

  async setSessionArchived(
    scope: StoreScope,
    archived: boolean,
  ): Promise<SessionResponse> {
    const session = this.#store.getSession(scope)
    if ((session.archivedAt !== null) === archived)
      return this.getSession(scope)
    if (session.provider === 'codex' && session.codexThreadId) {
      const cwd =
        typeof this.#workspaceCwd === 'function'
          ? this.#workspaceCwd(scope)
          : this.#workspaceCwd
      const runtime = await this.#registry.getOrInitialize({
        ...scope,
        cwd,
        codexHome: this.#codexHome(scope),
      })
      if (archived)
        await runtime.client.request<ThreadArchiveResponse>('thread/archive', {
          threadId: session.codexThreadId,
        } satisfies ThreadArchiveParams)
      else
        await runtime.client.request<ThreadUnarchiveResponse>(
          'thread/unarchive',
          { threadId: session.codexThreadId } satisfies ThreadUnarchiveParams,
        )
    }
    this.#store.setSessionArchived(scope, archived)
    return this.getSession(scope)
  }

  async deleteSession(scope: StoreScope): Promise<void> {
    const session = this.#store.getSession(scope)
    if (this.#store.getActiveDurableRun(scope))
      throw new StoreConflictError(
        'SESSION_HAS_ACTIVE_RUN',
        'A conversation with an active turn cannot be deleted',
      )
    if (session.provider === 'codex' && session.codexThreadId) {
      const cwd =
        typeof this.#workspaceCwd === 'function'
          ? this.#workspaceCwd(scope)
          : this.#workspaceCwd
      const runtime = await this.#registry.getOrInitialize({
        ...scope,
        cwd,
        codexHome: this.#codexHome(scope),
      })
      await runtime.client.request<ThreadDeleteResponse>('thread/delete', {
        threadId: session.codexThreadId,
      } satisfies ThreadDeleteParams)
    }
    this.#store.deleteSession(scope)
  }

  async captureGitSnapshot(
    scope: StoreScope,
    phase: 'before' | 'after' | 'refresh',
    turnId: string | null,
    idempotencyKey: string,
  ) {
    this.#store.getSession(scope)
    const existing = this.#store.findGitSnapshotByIdempotency(
      scope,
      idempotencyKey,
    )
    if (existing) return existing
    const cwd =
      typeof this.#workspaceCwd === 'function'
        ? this.#workspaceCwd(scope)
        : this.#workspaceCwd
    const readerKey = JSON.stringify([scope.tenantId, scope.workspaceId])
    let reader = this.#gitReaders.get(readerKey)
    if (!reader) {
      reader = new GitSnapshotReader(cwd)
      this.#gitReaders.set(readerKey, reader)
    }
    return this.#persistGitSnapshot(
      scope,
      phase,
      turnId,
      idempotencyKey,
      await reader.capture(),
    )
  }

  #persistGitSnapshot(
    scope: StoreScope,
    phase: 'before' | 'after' | 'refresh',
    turnId: string | null,
    idempotencyKey: string,
    captured: GitSnapshotResult,
  ) {
    let artifactId: string | null = null
    const snapshotId = `git_${randomUUID()}`
    if (
      captured.diff.content &&
      captured.diff.truncated &&
      this.#artifactStorage
    ) {
      const artifactScope: ArtifactScope = {
        ...scope,
        turnId: turnId ?? snapshotId,
        itemId: `git-${phase}`,
      }
      let metadata = this.#artifactStorage.create(artifactScope, 'git-diff')
      const content = Buffer.from(captured.diff.content)
      for (
        let offset = 0, chunkIndex = 0;
        offset < content.length;
        chunkIndex++
      ) {
        const chunk = content.subarray(
          offset,
          offset + DEFAULT_ARTIFACT_CHUNK_BYTES,
        )
        offset += chunk.byteLength
        metadata = this.#artifactStorage.append({
          artifactId: metadata.artifactId,
          scope: artifactScope,
          chunkIndex,
          stream: 'combined',
          data: chunk,
          sourceKey: idempotencyKey,
        })
      }
      metadata = this.#artifactStorage.finalize(
        metadata.artifactId,
        artifactScope,
      )
      this.#persistArtifact(metadata)
      artifactId = metadata.artifactId
    }
    const eventChangeCount = turnId
      ? this.#store.countTurnFileChanges(scope, turnId)
      : 0
    return this.#store.putGitSnapshot({
      ...scope,
      snapshotId,
      turnId,
      phase,
      repositoryKind: captured.repositoryKind,
      branch: captured.branch ? redactCommandOutput(captured.branch) : null,
      headOid: captured.headOid,
      detached: captured.detached,
      clean: captured.clean,
      changes: captured.changes.map((change) => ({
        ...change,
        path: redactCommandOutput(change.path),
        previousPath: change.previousPath
          ? redactCommandOutput(change.previousPath)
          : null,
      })),
      diff: {
        preview: redactCommandOutput(captured.diff.preview),
        byteLength: captured.diff.byteLength,
        truncated: captured.diff.truncated,
        artifactId,
      },
      log: captured.log.map((entry) => ({
        ...entry,
        authorName: redactCommandOutput(entry.authorName),
        subject: redactCommandOutput(entry.subject),
      })),
      eventChangeCount,
      relationship:
        eventChangeCount === 0
          ? 'authoritative'
          : captured.changes.length >= eventChangeCount
            ? 'matches_events'
            : 'differs_from_events',
      capturedAt: captured.capturedAt,
      idempotencyKey,
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
    this.#store.updateSessionRecoveryWithAudit(
      scope,
      { status: 'recovering' },
      {
        ...scope,
        actor: 'system',
        action: 'recovery.started',
        outcome: 'requested',
        idempotencyKey: `recovery:${key}:started`,
        metadata: { operation: 'resume' },
      },
    )
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
      let read: ThreadReadResponse
      try {
        read = await runtime.client.request<ThreadReadResponse>('thread/read', {
          threadId,
          includeTurns: true,
        } satisfies codexV2.ThreadReadParams)
      } catch (error) {
        const pristine =
          this.#store.getLatestDurableRun(scope) === null &&
          this.#store.listDurableUserMessages(scope, 1).length === 0
        if (!pristine || !isThreadUnavailableError(error)) throw error
        const session = this.#store.getSession(scope)
        const started = await runtime.client.request<ThreadStartResponse>(
          'thread/start',
          {
            cwd,
            ...(session.resolvedModel ? { model: session.resolvedModel } : {}),
            ...(this.#approvalPolicy
              ? { approvalPolicy: this.#approvalPolicy }
              : {}),
          } satisfies ThreadStartParams,
        )
        const record = this.#store.rebindPristineCodexThreadWithAudit(
          scope,
          {
            expectedCodexThreadId: threadId,
            codexThreadId: started.thread.id,
            runtimeGeneration: runtime.client.processGeneration,
          },
          {
            ...scope,
            actor: 'system',
            action: 'recovery.completed',
            outcome: 'success',
            idempotencyKey: `recovery:${key}:rebound`,
            metadata: {
              operation: 'rebind_pristine_thread',
              toState: 'active',
            },
          },
        )
        this.#threadScopes.delete(this.#threadKey(scope, threadId))
        this.#threadScopes.set(this.#threadKey(scope, started.thread.id), scope)
        const response = this.getSession(record)
        this.#store.completeIdempotencyKey({
          ...scope,
          scope: keyScope,
          key,
          status: 'completed',
          response,
        })
        return response
      }
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
      this.#reconcileDurableRun(
        scope,
        resumed.thread.turns,
        runtime.client.processGeneration,
      )
      this.#threadScopes.set(this.#threadKey(scope, threadId), scope)
      const active = [...resumed.thread.turns]
        .reverse()
        .find((turn) => turn.status === 'inProgress')
      const reconciledRun = this.#store.getLatestDurableRun(scope)
      const runRecoveryRequired = reconciledRun?.status === 'recovery_required'
      if (active && !runRecoveryRequired)
        this.#activeTurns.set(this.#activeTurnKey(scope), {
          sessionId: scope.sessionId,
          turnId: active.id,
        })
      const record = this.#store.updateSessionRecoveryWithAudit(
        scope,
        {
          status: runRecoveryRequired ? 'recovery_required' : 'active',
          ...(runRecoveryRequired
            ? { recoveryErrorCode: 'RECOVERY_OUTCOME_UNKNOWN' }
            : {}),
          runtimeGeneration: runtime.client.processGeneration,
          resumed: true,
        },
        {
          ...scope,
          actor: 'system',
          action: 'recovery.completed',
          outcome: 'success',
          idempotencyKey: `recovery:${key}:completed`,
          metadata: {
            toState: runRecoveryRequired ? 'recovery_required' : 'active',
          },
        },
      )
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
      this.#store.updateSessionRecoveryWithAudit(
        scope,
        {
          status: failure.permanent ? 'recovery_required' : 'recovering',
          recoveryErrorCode: failure.code,
        },
        {
          ...scope,
          actor: 'system',
          action: 'recovery.failed',
          outcome: 'failure',
          idempotencyKey: `recovery:${key}:failed`,
          metadata: {
            recoveryCode: failure.code,
            toState: failure.permanent ? 'recovery_required' : 'recovering',
          },
        },
      )
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

  #reconcileDurableRun(
    scope: StoreScope,
    turns: codexV2.Turn[],
    runtimeGeneration: number,
  ): void {
    const active = this.#store.getActiveDurableRun(scope)
    const latest = this.#store.getLatestDurableRun(scope)
    let run =
      active ??
      (latest?.status === 'recovery_required' && latest.terminalOutcome === null
        ? latest
        : null)
    if (!run) {
      const upstreamActive = [...turns]
        .reverse()
        .find((turn) => turn.status === 'inProgress')
      if (!upstreamActive) return
      const session = this.#store.getSession(scope)
      const runId = `run_recovery_${createHash('sha256')
        .update(JSON.stringify([scope.sessionId, upstreamActive.id]))
        .digest('hex')
        .slice(0, 20)}`
      run = this.#store.createDurableRun({
        ...scope,
        runId,
        provider: session.provider,
        runtimeGeneration,
      })
      run = this.#store.bindDurableRunTurn({
        ...scope,
        runId,
        turnId: upstreamActive.id,
        providerTurnId: upstreamActive.id,
        runtimeGeneration,
      })
      if (
        session.resolvedModel &&
        session.reasoningEffort &&
        session.capabilitySnapshot
      )
        this.#store.createTurn({
          ...scope,
          turnId: upstreamActive.id,
          providerTurnId: upstreamActive.id,
          provider: session.provider,
          requestedPolicy: session.requestedPolicy,
          resolvedModel: session.resolvedModel,
          reasoningEffort: session.reasoningEffort,
          capabilitySnapshot: session.capabilitySnapshot,
          status: 'in_progress',
        })
    }
    if (!run.turnId) {
      this.#store.markDurableRunRecoveryRequired(
        scope,
        run.runId,
        'RECOVERY_OUTCOME_UNKNOWN',
        'Provider turn identity was not durable before restart; prompt was not resubmitted',
      )
      return
    }
    const turn = turns.find((candidate) => candidate.id === run.turnId)
    if (!turn) {
      this.#store.markDurableRunRecoveryRequired(
        scope,
        run.runId,
        'RECOVERY_OUTCOME_UNKNOWN',
        'Bound turn was absent from the provider thread snapshot; prompt was not resubmitted',
      )
      return
    }
    if (turn.status === 'inProgress') {
      this.#store.bindDurableRunTurn({
        ...scope,
        runId: run.runId,
        turnId: turn.id,
        providerTurnId: turn.id,
        runtimeGeneration,
      })
      return
    }
    const outcome = turn.status as 'completed' | 'failed' | 'interrupted'
    if (['completed', 'failed', 'interrupted'].includes(outcome))
      this.#store.finalizeDurableRun({
        ...scope,
        runId: run.runId,
        outcome,
        completeness: 'partial',
        ...(turn.completedAt
          ? { occurredAt: new Date(turn.completedAt * 1_000).toISOString() }
          : {}),
      })
  }

  #ingestRecoveryEnvelope(
    scope: StoreScope,
    envelope: Record<string, unknown>,
    ingestKey: string,
    snapshotMethod: string,
  ): void {
    const adapter = this.#adapterFor(scope)
    const adapted = adapter.adapt(envelope)
    if (this.#store.findIngestedEvent(scope, ingestKey, adapted.checksum))
      return
    if (this.#store.hasEquivalentTimelineEvent(scope, adapted.event)) return
    this.#spillCommandOutput(adapted, ingestKey)
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
    if (session.provider !== 'codex')
      throw new OrchestrationError(
        'CAPABILITY_UNSUPPORTED',
        `${session.provider} headless adapter does not support in-flight steering`,
        409,
      )
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
    const run = this.#store.getActiveDurableRun(scope)
    if (session.provider !== 'codex') {
      if (!run || (run.turnId && run.turnId !== turnId))
        throw new OrchestrationError(
          'NO_ACTIVE_TURN',
          'Turn is not active',
          409,
        )
      const adapter = this.#cliAdapter(session.provider, scope)
      this.#store.markDurableRunInterrupting(scope, run.runId)
      await adapter.interrupt({
        schemaVersion: 1,
        sessionId: session.codexThreadId ?? session.sessionId,
        turnId,
        reason: 'user',
      })
      return {
        ...scope,
        runId: run.runId,
        codexThreadId: session.codexThreadId ?? session.sessionId,
        codexTurnId: turnId,
        status: 'interrupted' as const,
      }
    }
    if (!session.codexThreadId)
      throw new OrchestrationError(
        'SESSION_NOT_ACTIVE',
        'Session has no thread',
        409,
      )
    if (!run) {
      const prior = this.#store.getDurableRunByTurn(scope, turnId)
      if (prior?.terminalOutcome === 'interrupted')
        return {
          ...scope,
          runId: prior.runId,
          codexThreadId: session.codexThreadId,
          codexTurnId: turnId,
          status: 'interrupted' as const,
        }
      throw new OrchestrationError('NO_ACTIVE_TURN', 'Turn is not active', 409)
    }
    if (run.turnId && run.turnId !== turnId)
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
    this.#store.markDurableRunInterrupting(scope, run.runId)
    try {
      await runtime.client.request('turn/interrupt', {
        threadId: session.codexThreadId,
        turnId,
      } satisfies TurnInterruptParams)
    } catch (error) {
      this.#store.markDurableRunRecoveryRequired(
        scope,
        run.runId,
        'RECOVERY_OUTCOME_UNKNOWN',
        'Provider interrupt outcome is unknown and will not be sent again automatically',
      )
      throw new OrchestrationError(
        'RECOVERY_OUTCOME_UNKNOWN',
        'Provider interrupt outcome is unknown and will not be retried',
        409,
      )
    }
    this.#store.finalizeDurableRun({
      ...scope,
      runId: run.runId,
      outcome: 'interrupted',
      completeness: 'partial',
    })
    this.#store.expireApprovals(scope, 'superseded')
    this.#activeTurns.delete(activeKey)
    return {
      ...scope,
      runId: run.runId,
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
          status:
            error instanceof OrchestrationError &&
            error.code === 'RECOVERY_OUTCOME_UNKNOWN'
              ? 'outcome_unknown'
              : 'failed',
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
    attachments: TurnAttachmentInput[] = [],
  ): Promise<TurnAcceptedResponse> {
    const session = this.#store.getSession(scope)
    if (session.provider !== 'codex')
      return this.#startCliTurn(
        scope,
        session.provider,
        prompt,
        idempotencyKey,
        attachments,
      )
    await this.requireAuthReady(scope)
    if (session.status !== 'active' || !session.codexThreadId) {
      throw new OrchestrationError(
        'SESSION_NOT_ACTIVE',
        'Session must be active and bound to a Codex thread',
        409,
      )
    }
    if (
      !this.#threadScopes.has(this.#threadKey(scope, session.codexThreadId))
    ) {
      await this.resumeSession(
        scope,
        `turn:${idempotencyKey}:ensure-thread-resumed`,
      )
    }
    const hash = requestHash(prompt, attachments)
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

    const runId = this.#runIdFactory()
    const runtime = this.#registry.get(scope)
    try {
      this.#store.createDurableRun({
        ...scope,
        runId,
        provider: session.provider,
        runtimeGeneration: runtime?.client.processGeneration ?? null,
      })
    } catch (error) {
      if (
        error instanceof StoreConflictError &&
        error.code === 'SESSION_TURN_ACTIVE'
      ) {
        const failure = {
          code: 'SESSION_TURN_ACTIVE',
          message: 'Session already has an active server-owned turn',
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
      throw error
    }
    const activeTurnKey = this.#activeTurnKey(scope)
    if (this.#activeTurns.has(activeTurnKey)) {
      const failure = {
        code: 'SESSION_TURN_ACTIVE',
        message: 'Session already has an active Codex turn',
      }
      this.#store.finalizeDurableRun({
        ...scope,
        runId,
        outcome: 'failed',
        completeness: 'partial',
      })
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
      runId,
      session.codexThreadId,
      prompt,
      idempotencyKey,
      keyScope,
      attachments,
    )
    this.#turnsInFlight.set(flightKey, operation)
    try {
      return await operation
    } finally {
      this.#turnsInFlight.delete(flightKey)
    }
  }

  async #startCliTurn(
    scope: StoreScope,
    provider: 'claude' | 'gemini' | 'cursor',
    prompt: string,
    idempotencyKey: string,
    attachments: TurnAttachmentInput[],
  ): Promise<TurnAcceptedResponse> {
    if (attachments.length > 0)
      throw new OrchestrationError(
        'CAPABILITY_UNSUPPORTED',
        `${provider} attachment input is not enabled by the configured adapter`,
        409,
      )
    const session = this.#store.getSession(scope)
    if (
      session.status !== 'active' ||
      !session.resolvedModel ||
      !session.reasoningEffort ||
      !session.capabilitySnapshot
    )
      throw new OrchestrationError(
        'SESSION_NOT_ACTIVE',
        'Session model policy must be resolved before starting a turn',
        409,
      )
    const keyScope = `turn:${scope.sessionId}`
    const reservation = this.#store.reserveIdempotencyKey({
      ...scope,
      scope: keyScope,
      key: idempotencyKey,
      requestHash: requestHash(prompt, []),
    })
    if (!reservation.created) {
      if (reservation.record.status === 'completed')
        return turnAcceptedResponseSchema.parse(reservation.record.response)
      throw new OrchestrationError(
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        'An earlier request with this idempotency key is pending or failed',
        409,
      )
    }
    const runId = this.#runIdFactory()
    const turnId = `turn_${randomUUID()}`
    try {
      this.#store.createDurableRun({
        ...scope,
        runId,
        provider,
        runtimeGeneration: null,
      })
      this.#store.bindDurableRunTurn({
        ...scope,
        runId,
        turnId,
        providerTurnId: turnId,
        runtimeGeneration: null,
      })
      this.#store.createTurn({
        ...scope,
        turnId,
        providerTurnId: turnId,
        provider,
        requestedPolicy: session.requestedPolicy,
        resolvedModel: session.resolvedModel,
        reasoningEffort: session.reasoningEffort,
        capabilitySnapshot: session.capabilitySnapshot,
        status: 'in_progress',
      })
      const count = this.#store.recordDurableUserMessage({
        ...scope,
        messageId: `msg_${turnId}`,
        idempotencyKey,
        content: prompt,
      })
      if (count >= 2) {
        const job = this.#store.enqueueConversationTitleJob(scope)
        if (job) this.#scheduleTitleJob(job)
      }
      const response = turnAcceptedResponseSchema.parse({
        ...scope,
        runId,
        codexThreadId: session.codexThreadId ?? session.sessionId,
        codexTurnId: turnId,
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
        turnId,
      })
      const adapter = this.#cliAdapter(provider, scope)
      const cwd =
        typeof this.#workspaceCwd === 'function'
          ? this.#workspaceCwd(scope)
          : this.#workspaceCwd
      let ordinal = 0
      void adapter.startTurn!(
        {
          sessionId: session.codexThreadId,
          prompt,
          cwd,
          modelId: session.resolvedModel,
          reasoningEffort: session.reasoningEffort,
          ...(provider === 'cursor'
            ? { allowFileChanges: this.#cursorForceAllowed }
            : {}),
        },
        (delivery) => {
          ordinal += 1
          const cursorInit =
            provider === 'cursor' &&
            delivery.rawEnvelope.type === 'system' &&
            delivery.rawEnvelope.subtype === 'init'
              ? {
                  cursorSessionId:
                    typeof delivery.rawEnvelope.session_id === 'string'
                      ? delivery.rawEnvelope.session_id
                      : null,
                  cursorModel:
                    typeof delivery.rawEnvelope.model === 'string'
                      ? delivery.rawEnvelope.model
                      : null,
                  cursorPermissionMode:
                    typeof delivery.rawEnvelope.permissionMode === 'string'
                      ? delivery.rawEnvelope.permissionMode
                      : null,
                }
              : {}
          if (
            delivery.spill &&
            this.#artifactStorage &&
            (delivery.normalized.event.type === 'command.completed' ||
              delivery.normalized.event.type === 'tool.completed')
          ) {
            const artifactScope: ArtifactScope = {
              ...scope,
              turnId,
              itemId:
                delivery.normalized.event.codexItemId ??
                `cursor-command-${ordinal}`,
            }
            let metadata = this.#artifactStorage.create(
              artifactScope,
              'command-output',
            )
            metadata = this.#artifactStorage.append({
              artifactId: metadata.artifactId,
              scope: artifactScope,
              chunkIndex: delivery.spill.chunkIndex,
              stream: delivery.spill.stream,
              data: delivery.spill.data,
              sourceKey: `${provider}:${runId}:${ordinal}`,
            })
            metadata = this.#artifactStorage.finalize(
              metadata.artifactId,
              artifactScope,
            )
            this.#persistArtifact(metadata)
            const artifact = {
              artifactId: metadata.artifactId,
              startByte: 0,
              endByte: metadata.byteLength,
              byteLength: metadata.byteLength,
            }
            if (delivery.normalized.event.type === 'command.completed')
              delivery.normalized.event.payload.output.artifact = artifact
            else if (
              delivery.normalized.event.payload.result &&
              typeof delivery.normalized.event.payload.result === 'object' &&
              !Array.isArray(delivery.normalized.event.payload.result)
            ) {
              const payloadResult = delivery.normalized.event.payload
                .result as Record<string, unknown>
              payloadResult.artifact = artifact
            }
          }
          this.#store.ingest({
            ...scope,
            ingestKey: `${provider}:${runId}:${ordinal}:${delivery.normalized.rawEnvelopeChecksum}`,
            raw: {
              envelope: delivery.rawEnvelope,
              checksum: delivery.normalized.rawEnvelopeChecksum,
              sourceMethod: delivery.normalized.event.sourceMethod,
              sourceVersion: adapter.identity.upstreamVersion,
              sourceMetadata: { provider, runId, ordinal, ...cursorInit },
              receivedAt: delivery.normalized.event.receivedAt,
            },
            event: delivery.normalized.event,
          })
          if (delivery.usage)
            this.#store.appendUsage({
              ...scope,
              turnId,
              modelId: session.resolvedModel!,
              report: delivery.usage,
              ...(provider !== 'cursor' &&
              this.#priceCatalog?.models.some(
                (price) =>
                  price.provider === provider &&
                  price.modelId === session.resolvedModel,
              )
                ? { priceCatalog: this.#priceCatalog }
                : {}),
            })
        },
      )
        .then((terminal) => {
          if (!session.codexThreadId)
            this.#store.bindCodexThread(scope, terminal.providerSessionId)
          if (terminal.usage)
            this.#store.appendUsage({
              ...scope,
              turnId,
              modelId: session.resolvedModel!,
              report: terminal.usage,
              ...(provider !== 'cursor' &&
              this.#priceCatalog?.models.some(
                (price) =>
                  price.provider === provider &&
                  price.modelId === session.resolvedModel,
              )
                ? { priceCatalog: this.#priceCatalog }
                : {}),
            })
          if (terminal.error) {
            const raw = {
              type: 'provider_terminal_error',
              code: terminal.error.code,
              message: terminal.error.message,
              upstreamCode: terminal.error.upstreamCode,
            }
            const checksum = createHash('sha256')
              .update(JSON.stringify(raw))
              .digest('hex')
            const occurredAt = new Date().toISOString()
            this.#store.ingest({
              ...scope,
              ingestKey: `${provider}:${runId}:terminal-error:${checksum}`,
              raw: {
                envelope: raw,
                checksum,
                sourceMethod: 'provider_terminal_error',
                sourceVersion: adapter.identity.upstreamVersion,
                sourceMetadata: { provider, runId },
                receivedAt: occurredAt,
              },
              event: parseTimelineEvent({
                eventId: `evt_${randomUUID()}`,
                schemaVersion: 1,
                tenantId: scope.tenantId,
                workspaceId: scope.workspaceId,
                sessionId: scope.sessionId,
                codexThreadId:
                  terminal.providerSessionId ??
                  session.codexThreadId ??
                  scope.sessionId,
                codexTurnId: turnId,
                sequence: 0,
                occurredAt,
                receivedAt: occurredAt,
                source:
                  provider === 'claude'
                    ? 'claude-code'
                    : provider === 'gemini'
                      ? 'gemini-cli'
                      : 'cursor-agent',
                sourceVersion: adapter.identity.upstreamVersion,
                sourceMethod: 'provider_terminal_error',
                visibility: 'user',
                type: 'error.reported',
                payload: {
                  message: terminal.error.message,
                  additionalDetails: terminal.error.upstreamCode,
                  codexErrorInfo: null,
                  willRetry: terminal.error.retryable,
                },
              }),
            })
          }
          this.#store.finalizeDurableRun({
            ...scope,
            runId,
            outcome: terminal.outcome,
            completeness: terminal.usage?.completeness ?? 'partial',
          })
          this.#store.completeTurn(scope, turnId, terminal.outcome)
          this.#activeTurns.delete(this.#activeTurnKey(scope))
        })
        .catch(() => {
          this.#store.finalizeDurableRun({
            ...scope,
            runId,
            outcome: 'failed',
            completeness: 'partial',
          })
          this.#store.completeTurn(scope, turnId, 'failed')
          this.#activeTurns.delete(this.#activeTurnKey(scope))
        })
      return response
    } catch (error) {
      this.#store.completeIdempotencyKey({
        ...scope,
        scope: keyScope,
        key: idempotencyKey,
        status: 'failed',
        response: errorPayload(error),
      })
      throw error
    }
  }

  #scheduleTitleJob(scope: StoreScope): void {
    const key = JSON.stringify([
      scope.tenantId,
      scope.workspaceId,
      scope.sessionId,
    ])
    if (this.#titleJobsInFlight.has(key)) return
    this.#titleJobsInFlight.add(key)
    queueMicrotask(() => {
      void this.#runTitleJob(scope).finally(() =>
        this.#titleJobsInFlight.delete(key),
      )
    })
  }

  async #runTitleJob(scope: StoreScope): Promise<void> {
    const job = this.#store.claimConversationTitleJob(scope)
    if (!job) return
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
      const provider = new CodexProviderRuntimeAdapter({
        transport: runtime.client,
        events: this.#adapterFor(scope),
        sourceVersion: this.#sourceVersion,
      })
      const resolved = resolveModelSelection(
        'codex',
        DEFAULT_TITLE_POLICY,
        this.#modelAliases,
        await provider.discoverModelCatalog(),
      )
      const generated = await this.#titleGenerator({
        scope,
        modelId: resolved.modelId,
        reasoningEffort: 'none',
        messages: this.#store.listDurableUserMessages(scope, 2),
      })
      if (generated.usage)
        this.#store.appendUsage({
          ...scope,
          turnId: `title:${job.jobId}`,
          modelId: resolved.modelId,
          report: generated.usage,
          purpose: 'conversation_title',
          ...(this.#priceCatalog?.models.some(
            (price) =>
              price.provider === 'codex' && price.modelId === resolved.modelId,
          )
            ? { priceCatalog: this.#priceCatalog }
            : {}),
        })
      if (!this.#store.completeConversationTitleJob(scope, generated.title))
        throw new OrchestrationError(
          'TITLE_EMPTY_OR_MANUAL',
          'Generated title was empty or a manual title already exists',
          409,
        )
      if (generated.usage)
        this.#store.appendUsageOutcome({
          ...scope,
          turnId: `title:${job.jobId}`,
          provider: 'codex',
          modelId: resolved.modelId,
          purpose: 'conversation_title',
          dedupeKey: `title:${job.jobId}:terminal`,
          outcome: 'completed',
          completeness: generated.usage.completeness,
        })
    } catch (error) {
      const failed = this.#store.failConversationTitleJob(
        scope,
        error instanceof ProviderConfigurationError
          ? error.code
          : 'TITLE_GENERATION_FAILED',
      )
      if (failed?.status === 'queued')
        setTimeout(() => this.#scheduleTitleJob(scope), 100)
    }
  }

  async #generateCodexTitle(input: {
    scope: StoreScope
    modelId: string
    reasoningEffort: 'none'
    messages: string[]
  }): Promise<{
    title: string
    usage?: import('@perseverance/provider-platform').UsageReport
  }> {
    const prompt = [
      'Produce only a short, safe, single-line Turkish conversation title (maximum 8 words).',
      'Do not use tools. Do not include quotes, markdown, or explanation.',
      ...input.messages.map(
        (message, index) => `Message ${index + 1}: ${message.slice(0, 2000)}`,
      ),
    ].join('\n')
    return await new CodexTitleProcessRunner().run({
      binary: process.env.CODEX_BINARY ?? 'codex',
      args: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--model',
        input.modelId,
        '--config',
        'model_reasoning_effort="none"',
        prompt,
      ],
      codexHome: this.#codexHome(input.scope),
      requestId: `title:${input.scope.sessionId}`,
    })
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
    correlationId?: string | null
    requestId?: string | null
    traceId?: string | null
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
    return this.#store.finishApprovalWithAudit(
      {
        ...input,
        upstreamResponseStatus: 'sent',
      },
      {
        tenantId: approval.tenantId,
        workspaceId: approval.workspaceId,
        sessionId: approval.sessionId,
        actor: 'user',
        action: 'approval.decided',
        outcome: 'success',
        idempotencyKey: `approval:${approval.approvalId}:resolved`,
        ...(input.correlationId !== undefined
          ? { correlationId: input.correlationId }
          : {}),
        ...(input.requestId !== undefined
          ? { requestId: input.requestId }
          : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        metadata: {
          approvalKind: approval.kind,
          decision: input.decision,
        },
      },
    )
  }

  async #startReservedTurn(
    scope: StoreScope,
    runId: string,
    codexThreadId: string,
    prompt: string,
    idempotencyKey: string,
    keyScope: string,
    attachments: TurnAttachmentInput[],
  ): Promise<TurnAcceptedResponse> {
    try {
      const before = await this.captureGitSnapshot(
        scope,
        'before',
        null,
        `turn-request:${idempotencyKey}:before`,
      ).catch(() => undefined)
      const runtime = this.#registry.get(scope)
      if (!runtime) {
        throw new OrchestrationError(
          'WORKSPACE_RUNTIME_UNAVAILABLE',
          'Workspace runtime is not initialized',
          503,
        )
      }
      const session = this.#store.getSession(scope)
      if (
        !session.resolvedModel ||
        !session.reasoningEffort ||
        !session.capabilitySnapshot
      )
        throw new OrchestrationError(
          'MODEL_POLICY_NOT_RESOLVED',
          'Session model policy is not resolved; recreate the session after configuring provider model aliases',
          409,
        )
      const params: TurnStartParams = {
        threadId: codexThreadId,
        model: session.resolvedModel,
        effort: session.reasoningEffort,
        input: [
          ...(prompt ||
          attachments.some((attachment) => attachment.kind === 'file')
            ? [
                {
                  type: 'text' as const,
                  text: turnPromptWithAttachmentContext(prompt, attachments),
                  text_elements: [],
                },
              ]
            : []),
          ...attachments.map((attachment) =>
            attachment.kind === 'image'
              ? ({ type: 'localImage', path: attachment.path } as const)
              : ({
                  type: 'mention',
                  name: attachment.name,
                  path: attachment.path,
                } as const),
          ),
        ],
      }
      const upstream = await runtime.client.request<TurnStartResponse>(
        'turn/start',
        params,
      )
      const response = turnAcceptedResponseSchema.parse({
        ...scope,
        runId,
        codexThreadId,
        codexTurnId: upstream.turn.id,
        idempotencyKey,
      })
      let run = this.#store.bindDurableRunTurn({
        ...scope,
        runId,
        turnId: upstream.turn.id,
        providerTurnId: upstream.turn.id,
        runtimeGeneration: runtime.client.processGeneration,
      })
      this.#store.createTurn({
        ...scope,
        turnId: upstream.turn.id,
        providerTurnId: upstream.turn.id,
        provider: session.provider,
        requestedPolicy: session.requestedPolicy,
        resolvedModel: session.resolvedModel,
        reasoningEffort: session.reasoningEffort,
        capabilitySnapshot: session.capabilitySnapshot,
        status:
          run.terminalOutcome === null ? 'in_progress' : run.terminalOutcome,
      })
      const durableMessage =
        prompt.trim() ||
        attachments.map((attachment) => attachment.name).join(', ')
      const messageCount = this.#store.recordDurableUserMessage({
        ...scope,
        messageId: `msg_${upstream.turn.id}`,
        idempotencyKey,
        content: durableMessage,
      })
      if (messageCount >= 2) {
        const job = this.#store.enqueueConversationTitleJob(scope)
        if (job) this.#scheduleTitleJob(job)
      }
      const terminalEvent = this.#store.findTurnTerminalOutcome(
        scope,
        upstream.turn.id,
      )
      if (terminalEvent && run.terminalOutcome === null)
        run = this.#store.finalizeDurableRun({
          ...scope,
          runId,
          outcome: terminalEvent.outcome,
          completeness: 'partial',
          occurredAt: terminalEvent.occurredAt,
        })
      if (run.terminalOutcome)
        this.#store.completeTurn(
          scope,
          upstream.turn.id,
          run.terminalOutcome,
          run.terminalAt ?? new Date().toISOString(),
        )
      this.#store.appendAudit({
        ...scope,
        actor: 'system',
        action: 'turn.started',
        outcome: 'success',
        idempotencyKey: `turn:${upstream.turn.id}:started`,
        metadata: { status: 'accepted' },
      })
      if (before)
        this.#store.bindGitSnapshotTurn(
          scope,
          before.snapshotId,
          upstream.turn.id,
        )
      this.#store.completeIdempotencyKey({
        ...scope,
        scope: keyScope,
        key: idempotencyKey,
        status: 'completed',
        response,
      })
      if (run.terminalOutcome === null)
        this.#activeTurns.set(this.#activeTurnKey(scope), {
          sessionId: scope.sessionId,
          turnId: upstream.turn.id,
        })
      return response
    } catch (error) {
      this.#activeTurns.delete(this.#activeTurnKey(scope))
      const outcomeUnknown =
        error instanceof ProcessExitedError ||
        error instanceof ProcessUnavailableError ||
        error instanceof RequestTimeoutError
      const run = this.#store.getDurableRun(scope, runId)
      if (run.terminalOutcome === null) {
        if (outcomeUnknown)
          this.#store.markDurableRunRecoveryRequired(
            scope,
            runId,
            'RECOVERY_OUTCOME_UNKNOWN',
            'Provider turn/start may have been accepted; the prompt will not be submitted again automatically',
          )
        else
          this.#store.finalizeDurableRun({
            ...scope,
            runId,
            outcome: 'failed',
            completeness: 'partial',
          })
      }
      const recoveryFailure = classifyRecoveryError(error)
      const turnError = recoveryFailure.permanent
        ? new OrchestrationError(
            recoveryFailure.code,
            recoveryFailure.message,
            recoveryFailure.statusCode,
          )
        : error
      if (recoveryFailure.permanent) {
        this.#store.updateSessionRecoveryWithAudit(
          scope,
          {
            status: 'recovery_required',
            recoveryErrorCode: recoveryFailure.code,
          },
          {
            ...scope,
            actor: 'system',
            action: 'recovery.failed',
            outcome: 'failure',
            idempotencyKey: `turn:${idempotencyKey}:recovery-required`,
            metadata: {
              recoveryCode: recoveryFailure.code,
              toState: 'recovery_required',
            },
          },
        )
      }
      const failure = errorPayload(turnError)
      this.#store.appendAudit({
        ...scope,
        actor: 'system',
        action: 'turn.failed',
        outcome: 'failure',
        idempotencyKey: `turn:${idempotencyKey}:failed`,
        metadata: { reasonCode: failure.code, turnOutcome: 'start_failed' },
      })
      this.#store.completeIdempotencyKey({
        ...scope,
        scope: keyScope,
        key: idempotencyKey,
        status: outcomeUnknown ? 'outcome_unknown' : 'failed',
        response: failure,
      })
      if (turnError instanceof OrchestrationError) throw turnError
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
    if (
      this.#store.findIngestedEvent(scope, delivery.ingestKey, adapted.checksum)
    )
      return
    if (isUnauthorizedDisconnect(message)) {
      const authKey = JSON.stringify([
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        codexThreadId,
      ])
      this.#store.updateSessionRecovery(scope, {
        status: 'recovering',
        recoveryErrorCode: 'RECOVERY_AUTH_REQUIRED',
        runtimeGeneration: runtime.client.processGeneration,
      })
      if (this.#authFailures.has(authKey)) {
        this.#store.ingestRawOnly({
          ...scope,
          ingestKey: delivery.ingestKey,
          raw: {
            envelope: adapted.envelope,
            checksum: adapted.checksum,
            sourceMethod: adapted.event.sourceMethod,
            sourceVersion: this.#sourceVersion,
            sourceMetadata: {
              authRecoveryCoalesced: true,
              processGeneration: delivery.processGeneration,
            },
            receivedAt: adapted.event.receivedAt,
          },
        })
        return
      }
      this.#authFailures.add(authKey)
      if (adapted.event.type === 'error.reported') {
        adapted.event.payload.message =
          'Codex authentication is required. Run codex login, then retry.'
        adapted.event.payload.additionalDetails = null
        adapted.event.payload.codexErrorInfo = 'unauthorized'
        adapted.event.payload.willRetry = false
      }
    }
    this.#spillCommandOutput(adapted, delivery.ingestKey)
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
    if (adapted.event.type === 'turn.started' && adapted.event.codexTurnId) {
      const queued = this.#store.getActiveDurableRun(scope)
      if (queued?.status === 'queued' && queued.turnId === null)
        this.#store.bindDurableRunTurn({
          ...scope,
          runId: queued.runId,
          turnId: adapted.event.codexTurnId,
          providerTurnId: adapted.event.codexTurnId,
          runtimeGeneration: runtime.client.processGeneration,
        })
    }
    if (
      adapted.event.type === 'token.usage.updated' &&
      adapted.event.codexTurnId
    ) {
      const session = this.#store.getSession(scope)
      if (session.resolvedModel)
        this.#store.appendUsage({
          ...scope,
          turnId: adapted.event.codexTurnId,
          modelId: session.resolvedModel,
          report: {
            schemaVersion: 1,
            kind: 'cumulative',
            provider: session.provider,
            requestId: adapted.event.codexTurnId,
            dedupeKey: `codex:${delivery.ingestKey}`,
            counters: {
              inputTokens: adapted.event.payload.total.inputTokens,
              cachedInputTokens: adapted.event.payload.total.cachedInputTokens,
              outputTokens: adapted.event.payload.total.outputTokens,
              reasoningTokens:
                adapted.event.payload.total.reasoningOutputTokens,
              toolUnits: 0,
            },
            completeness: 'partial',
            occurredAt: adapted.event.occurredAt,
          },
          ...(this.#priceCatalog ? { priceCatalog: this.#priceCatalog } : {}),
        })
    }
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
      const turnId = adapted.event.codexTurnId
      if (turnId) {
        const outcome = adapted.event.payload.status as
          'completed' | 'failed' | 'interrupted'
        const session = this.#store.getSession(scope)
        const run = this.#store.getDurableRunByTurn(scope, turnId)
        if (run)
          this.#store.finalizeDurableRun({
            ...scope,
            runId: run.runId,
            outcome,
            completeness: 'partial',
            occurredAt: adapted.event.occurredAt,
          })
        else {
          try {
            this.#store.completeTurn(scope, turnId, outcome)
          } catch (error) {
            if (!(error instanceof StoreNotFoundError)) throw error
          }
          if (session.resolvedModel)
            this.#store.appendUsageOutcome({
              ...scope,
              turnId,
              provider: session.provider,
              modelId: session.resolvedModel,
              dedupeKey: `terminal:${turnId}:${outcome}`,
              outcome,
              completeness: 'partial',
              occurredAt: adapted.event.occurredAt,
            })
        }
        if (
          session.status === 'recovery_required' &&
          session.recoveryErrorCode === 'RECOVERY_OUTCOME_UNKNOWN'
        )
          this.#store.updateSessionRecovery(scope, {
            status: 'active',
            runtimeGeneration: runtime.client.processGeneration,
          })
      }
      this.#store.expireApprovals(scope, 'superseded')
      const activeTurnKey = this.#activeTurnKey(scope)
      const active = this.#activeTurns.get(activeTurnKey)
      if (
        active?.sessionId === scope.sessionId &&
        (!active.turnId || active.turnId === adapted.event.codexTurnId)
      ) {
        this.#activeTurns.delete(activeTurnKey)
      }
      if (adapted.event.codexTurnId)
        await this.captureGitSnapshot(
          scope,
          'after',
          adapted.event.codexTurnId,
          `turn:${adapted.event.codexTurnId}:after`,
        ).catch(() => undefined)
    }
  }

  #spillCommandOutput(
    adapted: ReturnType<CodexEventAdapter['adapt']>,
    sourceKey: string,
  ): void {
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
    if (event.type === 'command.output.delta' && adapted.spill) {
      let record = this.#commandArtifacts.get(key)
      if (!record) {
        const created = this.#artifactStorage.create(scope)
        this.#persistArtifact(created)
        record = { artifactId: created.artifactId, scope }
        this.#commandArtifacts.set(key, record)
      }
      const metadata = this.#artifactStorage.append({
        artifactId: record.artifactId,
        scope,
        chunkIndex: event.payload.chunkIndex,
        stream: event.payload.stream,
        data: adapted.spill.data,
        sourceKey,
      })
      this.#persistArtifact(metadata)
      const range = metadata.ranges.at(-1)
      if (!range) return
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
        this.#persistArtifact(created)
        record = { artifactId: created.artifactId, scope }
        this.#commandArtifacts.set(key, record)
        if (adapted.spill?.data)
          this.#persistArtifact(
            this.#artifactStorage.append({
              artifactId: record.artifactId,
              scope,
              chunkIndex: 0,
              stream: 'combined',
              data: adapted.spill.data,
              sourceKey,
            }),
          )
      }
      const metadata = this.#artifactStorage.finalize(record.artifactId, scope)
      this.#persistArtifact(metadata)
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
    identity: Pick<WorkspaceRuntimeIdentity, 'tenantId' | 'workspaceId'> & {
      sessionId: string
    },
  ) {
    return JSON.stringify([
      identity.tenantId,
      identity.workspaceId,
      identity.sessionId,
    ])
  }
}

export function isIdempotencyConflict(error: unknown) {
  return (
    error instanceof StoreConflictError &&
    error.code === 'IDEMPOTENCY_HASH_CONFLICT'
  )
}
