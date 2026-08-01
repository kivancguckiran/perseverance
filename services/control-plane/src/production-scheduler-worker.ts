import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import {
  ProductionTelemetry,
  OtlpHttpExporter,
  createTrace,
  type TraceContext,
} from '@perseverance/production-observability'
import {
  createBillingPostgresRepository,
  PrepaidCreditError,
  type BillingPostgresRepository,
} from '@perseverance/billing-platform'
import { codexV2 } from '@perseverance/codex-protocol-generated'
import {
  ZERO_CAPACITY,
  type CapacityVector,
} from '@perseverance/production-topology'
import {
  createPostgresTopologyRepository,
  type ClaimedWork,
  type PostgresTopologyRepository,
} from '@perseverance/production-topology/postgres'
import {
  createProductionPostgresRepository,
  type ProductionPostgresRepository,
  type ProductionScope,
} from '@perseverance/production-topology/production-postgres'
import {
  S3CompatibleObjectStore,
  type ObjectStore,
} from '@perseverance/production-topology/durable-dependencies'
import {
  CodexAppServerClient,
  createIsolatedCodexHome,
} from '@perseverance/workspace-agent'
import {
  decryptUserContent,
  encryptUserContent,
  parseUserContentEnvelope,
  type UserContentKeyMaterial,
} from './user-content-crypto'

// WP37: workspace-agent, kullanıcı workspace'lerinin content key'ini
// control-plane'in iç listener'ından alır (anahtar diske yazılmaz).
export interface ContentKeyResolver {
  resolve(scope: ProductionScope): Promise<UserContentKeyMaterial | null>
}

export class HttpContentKeyResolver implements ContentKeyResolver {
  readonly #endpoint: string
  readonly #token: string

  constructor(endpoint: string, token: string) {
    this.#endpoint = endpoint.replace(/\/$/, '')
    this.#token = token
  }

  async resolve(
    scope: ProductionScope,
  ): Promise<UserContentKeyMaterial | null> {
    const response = await fetch(
      `${this.#endpoint}/internal/v1/content-key-leases`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#token}`,
        },
        body: JSON.stringify({ workspaceId: scope.workspaceId }),
      },
    )
    if (response.status === 404) return null
    if (!response.ok) throw new Error('CONTENT_KEY_SERVICE_UNAVAILABLE')
    const body = (await response.json()) as {
      contentKey: string
      keyVersion: string
    }
    return {
      contentKey: Buffer.from(body.contentKey, 'base64'),
      keyVersion: body.keyVersion,
    }
  }
}

export interface ProductionSchedulerWorkerOptions {
  ownerId: string
  repository: ProductionPostgresRepository
  topology: PostgresTopologyRepository
  objectStore: ObjectStore
  requestedCapacity: CapacityVector
  leaseMs: number
  pollMs: number
  runtimeHoldMs: number
  codexBin: string
  codexProvisioningSource?: string
  workspaceCwd: string
  healthPort?: number
  healthHost?: string
  runtimeTimeoutMs?: number
  billing: BillingPostgresRepository
  telemetry?: ProductionTelemetry
  telemetryExporter?: OtlpHttpExporter
  contentKeys?: ContentKeyResolver
}

const ACTIVITY_ITEM_TYPES = new Set([
  'plan',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'contextCompaction',
])

/**
 * Only user-visible activity is retained. In particular, reasoning text deltas
 * are deliberately excluded; explicit reasoning summaries are the sole
 * reasoning representation that may reach the timeline.
 */
export function shouldPersistProductionActivityNotification(
  input: unknown,
): boolean {
  if (!input || typeof input !== 'object') return false
  const message = input as { method?: unknown; params?: unknown }
  if (typeof message.method !== 'string') return false
  if (
    message.method === 'item/agentMessage/delta' ||
    message.method === 'item/reasoning/summaryTextDelta' ||
    message.method === 'item/plan/delta' ||
    message.method === 'turn/diff/updated' ||
    message.method === 'thread/compacted'
  )
    return true
  if (message.method !== 'item/started' && message.method !== 'item/completed')
    return false
  const params = message.params as Record<string, unknown> | undefined
  const item = params?.item as Record<string, unknown> | undefined
  return typeof item?.type === 'string' && ACTIVITY_ITEM_TYPES.has(item.type)
}

/**
 * Self-hosted turns may modify their mounted workspace, but they must never
 * pause on an escalation request that this background worker cannot present.
 * `never` keeps denied operations denied; it does not widen the sandbox.
 */
export function productionThreadStartParams(
  workspaceCwd: string,
): codexV2.ThreadStartParams {
  return {
    cwd: workspaceCwd,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
  }
}

export function productionTurnCompletion(
  input: unknown,
  latestAgentMessage?: string,
  latestAgentMessageItemId?: string,
): { text: string; itemId?: string } | { error: string } | null {
  if (!input || typeof input !== 'object') return null
  const message = input as { method?: unknown; params?: unknown }
  if (message.method !== 'turn/completed') return null
  const params = message.params as Record<string, unknown> | undefined
  const turn = params?.turn as Record<string, unknown> | undefined
  const status = typeof turn?.status === 'string' ? turn.status : 'failed'
  if (status !== 'completed') {
    const turnError = turn?.error as Record<string, unknown> | undefined
    return {
      error: String(
        turnError?.message ??
          (status === 'interrupted'
            ? 'CODEX_TURN_INTERRUPTED'
            : 'CODEX_TURN_FAILED'),
      ),
    }
  }
  const items = Array.isArray(turn?.items) ? turn.items : []
  const snapshotMessage = [...items]
    .reverse()
    .find((item): item is Record<string, unknown> =>
      Boolean(
        item &&
        typeof item === 'object' &&
        (item as Record<string, unknown>).type === 'agentMessage' &&
        typeof (item as Record<string, unknown>).text === 'string',
      ),
    )
  const text =
    typeof snapshotMessage?.text === 'string'
      ? snapshotMessage.text
      : latestAgentMessage
  const itemId =
    typeof snapshotMessage?.id === 'string'
      ? snapshotMessage.id
      : latestAgentMessageItemId
  return text
    ? { text, ...(itemId ? { itemId } : {}) }
    : { error: 'CODEX_EMPTY_RESPONSE' }
}

export async function settleTerminalRunBilling(
  billing: Pick<
    BillingPostgresRepository,
    'settleOperation' | 'completeOperation'
  >,
  scope: ProductionScope,
  runId: string,
  outcome: 'completed' | 'failed',
) {
  try {
    await billing.settleOperation(scope, runId, {
      idempotencyKey: `wp26:${runId}:${outcome}`,
      usageDedupeKey: `wp26:${runId}:${outcome}`,
      measuredCreditsMicros: 0,
      usageStatus: 'measured',
      outcome,
      terminal: true,
      runId,
    })
  } catch (error) {
    // BYOK/self-hosted plans do not create prepaid credit reservations. A
    // missing reservation is therefore a valid terminal path, not a failed
    // Codex run. Other settlement failures must remain visible to recovery.
    if (
      !(error instanceof PrepaidCreditError) ||
      error.code !== 'RESERVATION_NOT_FOUND'
    )
      throw error
  } finally {
    // Concurrency admission is independent from prepaid settlement and must
    // always be released once the run is terminal.
    await billing.completeOperation(scope, runId)
  }
}

export class ProductionSchedulerWorker {
  readonly options: ProductionSchedulerWorkerOptions
  #running = false
  #healthServer: Server | null = null
  #activeClient: CodexAppServerClient | null = null
  #telemetryTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: ProductionSchedulerWorkerOptions) {
    this.options = options
  }

  async start() {
    if (this.#running) return
    this.#running = true
    if (this.options.telemetryExporter) {
      this.#telemetryTimer = setInterval(
        () =>
          void this.options.telemetryExporter!.flush().catch(() => undefined),
        1_000,
      )
      this.#telemetryTimer.unref()
    }
    if (this.options.healthPort) {
      this.#healthServer = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            status: 'ready',
            role: 'scheduler',
            ownerId: this.options.ownerId,
          }),
        )
      })
      await new Promise<void>((resolve, reject) => {
        this.#healthServer!.once('error', reject)
        this.#healthServer!.listen(
          this.options.healthPort,
          this.options.healthHost ?? '127.0.0.1',
          resolve,
        )
      })
    }
    while (this.#running) {
      await this.options.repository
        .requeueExpired(this.options.topology)
        .catch(() => 0)
      const claimed = await this.options.topology.claim({
        ownerId: this.options.ownerId,
        leaseId: `lease_${randomUUID()}`,
        leaseMs: this.options.leaseMs,
        capacityReservationId: `capacity_${randomUUID()}`,
        requestedCapacity: this.options.requestedCapacity,
      })
      if (!claimed) {
        await new Promise((resolve) => setTimeout(resolve, this.options.pollMs))
        continue
      }
      await this.#execute(claimed).catch(() => undefined)
    }
  }

  async stop() {
    this.#running = false
    if (this.#telemetryTimer) clearInterval(this.#telemetryTimer)
    this.#telemetryTimer = null
    await this.options.telemetryExporter?.flush().catch(() => 0)
    await this.#activeClient?.stop().catch(() => undefined)
    this.#activeClient = null
    if (this.#healthServer)
      await new Promise<void>((resolve) =>
        this.#healthServer!.close(() => resolve()),
      )
    this.#healthServer = null
  }

  async #execute(claimed: ClaimedWork) {
    const runtimeId = `runtime_${randomUUID()}`
    const scope: ProductionScope = {
      tenantId: claimed.item.tenantId,
      organizationId: claimed.item.organizationId,
      workspaceId: claimed.item.workspaceId,
    }
    const stored = await this.options.repository.bindClaim(claimed, {
      runtimeId,
      ownerId: this.options.ownerId,
    })
    const generatedParent = createTrace()
    const parent: TraceContext = stored.traceId
      ? { ...generatedParent, traceId: stored.traceId }
      : generatedParent
    const telemetry = this.options.telemetry ?? new ProductionTelemetry()
    const schedulerSpan = telemetry.startSpan('scheduler.claim', {
      parent,
      attributes: {
        'service.name': 'workspace-scheduler',
        'service.role': 'scheduler',
        operation: 'claim',
        outcome: 'claimed',
      },
    })
    telemetry.recordMetric(
      'scheduler_queue_wait',
      Math.max(0, Date.now() - new Date(stored.queuedAt).getTime()),
      { context: schedulerSpan.context, attributes: { outcome: 'claimed' } },
    )
    schedulerSpan.end('ok')
    const runtimeSpan = telemetry.startSpan('workspace.runtime', {
      parent: schedulerSpan.context,
      attributes: {
        'service.role': 'workspace-agent',
        operation: 'runtime.start',
      },
    })
    let expectedExpiry = new Date(claimed.lease.expiresAt)
    let leaseValid = true
    let upstreamStartIntent = false
    const renewal = setInterval(
      () => {
        void (async () => {
          const nextExpiry = new Date(Date.now() + this.options.leaseMs)
          const renewed = await this.options.topology.renewLease({
            ...scope,
            leaseId: claimed.lease.leaseId,
            ownerId: this.options.ownerId,
            fencingToken: claimed.lease.fencingToken,
            expectedExpiresAt: expectedExpiry,
            nextExpiresAt: nextExpiry,
          })
          if (!renewed) leaseValid = false
          else expectedExpiry = new Date(renewed.expiresAt)
        })().catch(() => {
          leaseValid = false
        })
      },
      Math.max(100, Math.floor(this.options.leaseMs / 3)),
    )
    renewal.unref()
    const fence = async () => {
      if (!leaseValid) throw new Error('STALE_FENCING_TOKEN')
      await this.options.topology.assertFence({
        ...scope,
        runId: stored.runId,
        fencingToken: claimed.lease.fencingToken,
      })
    }
    const append = async (
      eventType: string,
      payload: Record<string, unknown>,
      suffix: string = randomUUID(),
    ) => {
      const eventSpan = telemetry.startSpan('event.append', {
        parent: runtimeSpan.context,
        attributes: { operation: 'event.append', 'event.type': eventType },
      })
      await fence()
      const result = await this.options.repository.appendFencedEvent({
        ...scope,
        sessionId: stored.sessionId,
        runId: stored.runId,
        eventId: `evt_${stored.runId}_${suffix}`,
        eventType,
        fencingToken: claimed.lease.fencingToken,
        payload,
      })
      if (!result.accepted) {
        eventSpan.end('error', { 'error.code': result.reasonCode })
        throw new Error(result.reasonCode)
      }
      eventSpan.end('ok')
      return result
    }
    try {
      await append(
        'turn.started',
        {
          runId: stored.runId,
          runtimeId,
          regionId: claimed.regionId,
          nodeId: claimed.nodeId,
          fencingToken: claimed.lease.fencingToken,
          attempt: stored.attempt,
          recovery: stored.attempt > 1,
        },
        `started_${claimed.lease.fencingToken}`,
      )
      telemetry.recordMetric(
        'turn_start_latency',
        Math.max(0, Date.now() - new Date(stored.queuedAt).getTime()),
        {
          context: runtimeSpan.context,
          attributes: { outcome: 'started' },
        },
      )
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.runtimeHoldMs),
      )
      await fence()
      const promptBytes = await this.options.objectStore.get(
        stored.promptObjectKey,
      )
      // WP37: envelope-şifreli prompt yalnız content key lease'i ile açılır;
      // lease yoksa run fail-closed düşer (düz metin fallback yoktur).
      const promptEnvelope = parseUserContentEnvelope(promptBytes)
      let userContentKey: UserContentKeyMaterial | null = null
      let prompt: string
      if (promptEnvelope) {
        if (!this.options.contentKeys) throw new Error('CONTENT_KEY_LOCKED')
        userContentKey = await this.options.contentKeys.resolve(scope)
        if (!userContentKey) throw new Error('CONTENT_KEY_LOCKED')
        prompt = new TextDecoder().decode(
          await decryptUserContent(
            userContentKey,
            { ...scope, recordType: 'prompt', recordId: stored.runId },
            promptEnvelope,
          ),
        )
      } else {
        prompt = new TextDecoder().decode(promptBytes)
      }
      const isolatedHome = createIsolatedCodexHome({
        ...(this.options.codexProvisioningSource
          ? { sourceHome: this.options.codexProvisioningSource }
          : {}),
        includeConfig: false,
      })
      const client = new CodexAppServerClient({
        command: this.options.codexBin,
        cwd: this.options.workspaceCwd,
        env: { ...process.env, CODEX_HOME: isolatedHome.path },
        requestTimeoutMs: this.options.runtimeTimeoutMs ?? 180_000,
        restart: { maxRestarts: 0 },
      })
      this.#activeClient = client
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await client.initialize({
          name: 'persistent_wp26_scheduler',
          title: 'Persistent WP26 Scheduler',
          version: '1',
        })
        await fence()
        const thread = await client.request<codexV2.ThreadStartResponse>(
          'thread/start',
          productionThreadStartParams(this.options.workspaceCwd),
        )
        let resolveFinal!: (message: { text: string; itemId?: string }) => void
        let rejectFinal!: (error: Error) => void
        let latestAgentMessage: string | undefined
        let latestAgentMessageItemId: string | undefined
        const final = new Promise<{ text: string; itemId?: string }>(
          (resolve, reject) => {
            resolveFinal = resolve
            rejectFinal = reject
          },
        )
        let activityOrdinal = 0
        let activityWriteError: unknown
        let activityWriteChain = Promise.resolve()
        client.onNotification((message) => {
          const params = message.params as Record<string, unknown> | undefined
          if (params?.threadId !== thread.thread.id) return
          if (shouldPersistProductionActivityNotification(message)) {
            const ordinal = ++activityOrdinal
            activityWriteChain = activityWriteChain
              .then(async () => {
                const recordId = `${stored.runId}:activity:${ordinal}`
                const activityObjectKey = `${scope.tenantId}/${scope.organizationId}/${scope.workspaceId}/runs/${stored.runId}/activity/${String(ordinal).padStart(6, '0')}`
                const activityBytes = new TextEncoder().encode(
                  JSON.stringify(message),
                )
                await this.options.objectStore.put(
                  activityObjectKey,
                  userContentKey
                    ? await encryptUserContent(
                        userContentKey,
                        { ...scope, recordType: 'raw_event', recordId },
                        activityBytes,
                      )
                    : activityBytes,
                  'application/json; charset=utf-8',
                )
                await append(
                  'codex.notification',
                  {
                    runId: stored.runId,
                    activityObjectKey,
                    recordType: 'raw_event',
                    recordId,
                    method: message.method,
                  },
                  `activity_${ordinal}`,
                )
              })
              .catch((error: unknown) => {
                activityWriteError ??= error
              })
          }
          if (message.method === 'error') {
            const value = params.error as Record<string, unknown> | undefined
            rejectFinal(
              new Error(String(value?.message ?? 'CODEX_RUNTIME_ERROR')),
            )
          }
          if (message.method === 'item/completed') {
            const item = params.item as Record<string, unknown> | undefined
            if (
              item?.type === 'agentMessage' &&
              typeof item.text === 'string'
            ) {
              latestAgentMessage = item.text
              latestAgentMessageItemId =
                typeof item.id === 'string' ? item.id : undefined
            }
          }
          const completion = productionTurnCompletion(
            message,
            latestAgentMessage,
            latestAgentMessageItemId,
          )
          if (completion) {
            if ('error' in completion) rejectFinal(new Error(completion.error))
            else resolveFinal(completion)
          }
        })
        const startIntent =
          await this.options.repository.markUpstreamStartIntent({
            ...scope,
            runId: stored.runId,
            fencingToken: claimed.lease.fencingToken,
            codexThreadId: thread.thread.id,
          })
        if (!startIntent) throw new Error('STALE_FENCING_TOKEN')
        upstreamStartIntent = true
        const codexSpan = telemetry.startSpan('codex.turn', {
          parent: runtimeSpan.context,
          attributes: {
            'service.role': 'codex-app-server',
            operation: 'turn.start',
          },
        })
        const turn = await client.request<codexV2.TurnStartResponse>(
          'turn/start',
          {
            threadId: thread.thread.id,
            input: [{ type: 'text', text: prompt, text_elements: [] }],
          } satisfies codexV2.TurnStartParams,
        )
        const marked = await this.options.repository.markRunRunning({
          ...scope,
          runId: stored.runId,
          fencingToken: claimed.lease.fencingToken,
          codexThreadId: thread.thread.id,
          codexTurnId: turn.turn.id,
        })
        if (!marked) throw new Error('STALE_FENCING_TOKEN')
        const completedMessage = await Promise.race([
          final,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('RUNTIME_TIMEOUT')),
              this.options.runtimeTimeoutMs ?? 180_000,
            )
          }),
        ])
        await activityWriteChain
        if (activityWriteError) throw activityWriteError
        codexSpan.end('ok')
        await fence()
        const { text } = completedMessage
        const outputBytes = new TextEncoder().encode(text)
        const capacity = await this.options.repository.meterCapacity({
          ...scope,
          runId: stored.runId,
          fencingToken: claimed.lease.fencingToken,
          resource: 'outputBytes',
          quantity: outputBytes.byteLength,
        })
        if (!capacity.accepted) throw new Error(capacity.reasonCode)
        const outputObjectKey = `${scope.tenantId}/${scope.organizationId}/${scope.workspaceId}/runs/${stored.runId}/output`
        await this.options.objectStore.put(
          outputObjectKey,
          userContentKey
            ? await encryptUserContent(
                userContentKey,
                {
                  ...scope,
                  recordType: 'model_output',
                  recordId: stored.runId,
                },
                outputBytes,
              )
            : outputBytes,
          userContentKey
            ? 'application/json; charset=utf-8'
            : 'text/plain; charset=utf-8',
        )
        await append('agent.message.completed', {
          runId: stored.runId,
          codexThreadId: thread.thread.id,
          ...(completedMessage.itemId
            ? { codexItemId: completedMessage.itemId }
            : {}),
          outputObjectKey,
          byteLength: outputBytes.byteLength,
          reconciled: true,
        })
        await append(
          'turn.completed',
          { runId: stored.runId, outcome: 'completed', reconciled: true },
          'completed',
        )
        runtimeSpan.end('ok')
        await settleTerminalRunBilling(
          this.options.billing,
          scope,
          stored.runId,
          'completed',
        )
        const completed = await this.options.repository.completeRun({
          ...scope,
          runId: stored.runId,
          fencingToken: claimed.lease.fencingToken,
          outcome: 'completed',
          outputObjectKey,
        })
        if (!completed) throw new Error('STALE_FENCING_TOKEN')
        await this.options.topology.releaseLease({
          ...scope,
          leaseId: claimed.lease.leaseId,
          ownerId: this.options.ownerId,
          fencingToken: claimed.lease.fencingToken,
          terminalState: 'completed',
        })
      } finally {
        if (timeout) clearTimeout(timeout)
        await client.stop().catch(() => undefined)
        this.#activeClient = null
        isolatedHome.cleanup()
      }
    } catch (error) {
      runtimeSpan.end('error', {
        'error.code':
          error instanceof Error
            ? error.message.slice(0, 64).replaceAll(/[^A-Za-z0-9_:-]/g, '_')
            : 'UNKNOWN',
      })
      if (!(
        error instanceof Error && error.message === 'STALE_FENCING_TOKEN'
      )) {
        const errorCode =
          error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)
            ? error.message
            : 'RUNTIME_FAILED'
        if (upstreamStartIntent) {
          const terminal = await this.options.repository
            .completeRun({
              ...scope,
              runId: claimed.item.runId,
              fencingToken: claimed.lease.fencingToken,
              outcome: 'outcome_unknown',
            })
            .catch(() => false)
          if (terminal)
            await settleTerminalRunBilling(
              this.options.billing,
              scope,
              claimed.item.runId,
              'failed',
            ).catch(() => undefined)
          await this.options.topology
            .releaseLease({
              ...scope,
              leaseId: claimed.lease.leaseId,
              ownerId: this.options.ownerId,
              fencingToken: claimed.lease.fencingToken,
              terminalState: 'failed',
              errorCode: 'UPSTREAM_OUTCOME_UNKNOWN',
            })
            .catch(() => false)
          throw error
        }
        const poisoned = claimed.item.attempt >= claimed.item.maxAttempts
        await this.options.repository
          .markRunRetry({
            ...scope,
            runId: claimed.item.runId,
            fencingToken: claimed.lease.fencingToken,
            state: poisoned ? 'poisoned' : 'recovery_required',
            errorCode,
          })
          .catch(() => false)
        const released = await this.options.topology
          .releaseLease({
            ...scope,
            leaseId: claimed.lease.leaseId,
            ownerId: this.options.ownerId,
            fencingToken: claimed.lease.fencingToken,
            terminalState: poisoned ? 'poisoned' : 'recovery_required',
            errorCode,
          })
          .catch(() => false)
        if (released && !poisoned) {
          const delay = Math.min(
            30_000,
            100 * 2 ** Math.max(0, claimed.item.attempt - 1),
          )
          await this.options.topology
            .rescheduleRecovery({
              ...scope,
              queueItemId: claimed.item.queueItemId,
              expectedFencingToken: claimed.lease.fencingToken,
              notBefore: new Date(Date.now() + delay),
            })
            .catch(() => false)
        }
      }
      throw error
    } finally {
      clearInterval(renewal)
    }
  }
}

export function defaultWp26Capacity(): CapacityVector {
  return {
    ...ZERO_CAPACITY,
    cpuMillis: 500,
    memoryBytes: 512 * 1024 * 1024,
    pids: 64,
    ioBytesPerSecond: 5 * 1024 * 1024,
    diskBytes: 5 * 1024 * 1024 * 1024,
    diskInodes: 50_000,
    diskIops: 500,
    egressBytesPerSecond: 2 * 1024 * 1024,
    egressRequestsPerMinute: 300,
    eventBytesPerSecond: 512 * 1024,
    artifactBytes: 1024 * 1024 * 1024,
    outputBytes: 100 * 1024 * 1024,
    corpusIndexBytes: 2 * 1024 * 1024 * 1024,
  }
}

export function productionSchedulerWorkerFromEnv(env: NodeJS.ProcessEnv) {
  const required = (name: string) => {
    const value = env[name]
    if (!value) throw new Error(`Scheduler requires ${name}`)
    return value
  }
  const databaseUrl = required('TOPOLOGY_DATABASE_URL')
  const telemetry = new ProductionTelemetry(
    () => new Date(),
    Number(env.TELEMETRY_MAX_RECORDS ?? 2_048),
  )
  return new ProductionSchedulerWorker({
    ownerId: required('SCHEDULER_OWNER_ID'),
    repository: createProductionPostgresRepository(databaseUrl),
    topology: createPostgresTopologyRepository(databaseUrl),
    billing: createBillingPostgresRepository(databaseUrl, {
      productionBillingVerified: true,
    }),
    objectStore: new S3CompatibleObjectStore({
      endpoint: required('OBJECT_STORAGE_ENDPOINT'),
      bucket: required('OBJECT_STORAGE_BUCKET'),
      accessKeyId: required('OBJECT_STORAGE_ACCESS_KEY_ID'),
      secretAccessKey: required('OBJECT_STORAGE_SECRET_ACCESS_KEY'),
    }),
    requestedCapacity: defaultWp26Capacity(),
    leaseMs: Number(env.SCHEDULER_LEASE_MS ?? 5_000),
    pollMs: Number(env.SCHEDULER_POLL_MS ?? 100),
    runtimeHoldMs: Number(env.SCHEDULER_RUNTIME_HOLD_MS ?? 0),
    codexBin: required('WP26_CODEX_BIN'),
    ...(env.CODEX_PROVISIONING_SOURCE
      ? { codexProvisioningSource: env.CODEX_PROVISIONING_SOURCE }
      : {}),
    workspaceCwd: env.WORKSPACE_CWD ?? process.cwd(),
    ...(Number(env.SCHEDULER_HEALTH_PORT ?? 0) > 0
      ? {
          healthPort: Number(env.SCHEDULER_HEALTH_PORT),
          healthHost: env.SCHEDULER_HEALTH_HOST ?? '127.0.0.1',
        }
      : {}),
    runtimeTimeoutMs: Number(env.SCHEDULER_RUNTIME_TIMEOUT_MS ?? 180_000),
    ...(env.CONTENT_KEY_SERVICE_URL && env.INTERNAL_RUNTIME_TOKEN_FILE
      ? {
          contentKeys: new HttpContentKeyResolver(
            env.CONTENT_KEY_SERVICE_URL,
            readFileSync(env.INTERNAL_RUNTIME_TOKEN_FILE, 'utf8').trim(),
          ),
        }
      : {}),
    telemetry,
    ...(env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? {
          telemetryExporter: new OtlpHttpExporter(
            telemetry,
            env.OTEL_EXPORTER_OTLP_ENDPOINT,
          ),
        }
      : {}),
  })
}
