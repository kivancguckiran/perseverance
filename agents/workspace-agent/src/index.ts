import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface, type Interface } from 'node:readline'
export {
  createIsolatedCodexHome,
  type IsolatedCodexHome,
} from './isolated-codex-home'
export {
  PersistentCodexHomeManager,
  CodexHomePathError,
} from './persistent-codex-home'
export {
  GitSnapshotReader,
  GIT_COMMAND_TIMEOUT_MS,
  GIT_DIFF_OUTPUT_BYTES,
  GIT_DIFF_PREVIEW_BYTES,
  type GitChange,
  type GitChangeArea,
  type GitLogEntry,
  type GitRepositoryKind,
  type GitSnapshotResult,
} from './git-snapshot'
export {
  AlphaPreflightError,
  PINNED_CODEX_VERSION,
  runAlphaPreflight,
  validateProvisioningSource,
  type AlphaConfig,
  type PreflightCheck,
} from './alpha-preflight'
export {
  HttpWorkspaceCorpusRetrievalClient,
  McpRequestError,
  WorkspaceCorpusMcpServer,
  MCP_MAX_OUTPUT_BYTES,
  MCP_MAX_OUTPUT_TOKENS,
  WORKSPACE_CORPUS_MCP_VERSION,
  type CorpusWorkloadIdentity,
  type WorkspaceCorpusRetrievalClient,
} from './corpus-mcp'
export {
  DeterministicIgnorePolicy,
  WorkspaceCorpusWatcher,
  WorkspaceWatcherError,
  WORKSPACE_CORPUS_WATCHER_VERSION,
  loadWorkspaceIgnorePolicy,
  type WorkspaceFileEvent,
  type WorkspaceFileOperation,
  type WorkspaceWatchJob,
} from './workspace-corpus-watcher'

export type JsonRpcId = number | string

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export type ProcessHealthState =
  'stopped' | 'starting' | 'initializing' | 'ready' | 'restarting' | 'failed'

export interface ProcessHealth {
  state: ProcessHealthState
  restartAttempt: number
  lastError?: Error
}

export interface RestartPolicy {
  initialDelayMs: number
  maxDelayMs: number
  maxRestarts: number
  windowMs: number
}

export interface RequestOptions {
  timeoutMs?: number
}

export interface CodexAppServerClientOptions {
  command?: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  onStderr?: (chunk: string) => void
  requestTimeoutMs?: number
  restart?: Partial<RestartPolicy>
}

export interface InitializeClientInfo {
  name: string
  title: string
  version: string
}

export class CodexAppServerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CodexAppServerError'
    this.code = code
  }
}

export class ProcessExitedError extends CodexAppServerError {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null

  constructor(exitCode: number | null, signal: NodeJS.Signals | null) {
    super(
      'CODEX_PROCESS_CRASHED',
      `codex app-server exited (code=${exitCode}, signal=${signal})`,
    )
    this.name = 'ProcessExitedError'
    this.exitCode = exitCode
    this.signal = signal
  }
}

export class ProtocolError extends CodexAppServerError {
  constructor(message = 'codex app-server emitted malformed JSON') {
    super('CODEX_PROTOCOL_MISMATCH', message)
    this.name = 'ProtocolError'
  }
}

export class RequestTimeoutError extends CodexAppServerError {
  readonly requestId: JsonRpcId
  readonly method: string
  readonly timeoutMs: number

  constructor(requestId: JsonRpcId, method: string, timeoutMs: number) {
    super(
      'CODEX_RPC_TIMEOUT',
      `codex app-server request timed out (method=${method}, id=${requestId}, timeoutMs=${timeoutMs})`,
    )
    this.name = 'RequestTimeoutError'
    this.requestId = requestId
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

export class ProcessUnavailableError extends CodexAppServerError {
  constructor() {
    super('CODEX_PROCESS_NOT_RUNNING', 'codex app-server is not running')
    this.name = 'ProcessUnavailableError'
  }
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

type MessageListener = (message: Record<string, unknown>) => void
type HealthListener = (health: ProcessHealth) => void

const defaultRestartPolicy: RestartPolicy = {
  initialDelayMs: 100,
  maxDelayMs: 5_000,
  maxRestarts: 5,
  windowMs: 60_000,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

export class CodexAppServerClient {
  readonly #options: Required<
    Pick<CodexAppServerClientOptions, 'command' | 'args' | 'requestTimeoutMs'>
  > &
    CodexAppServerClientOptions
  readonly #restartPolicy: RestartPolicy
  readonly #pending = new Map<JsonRpcId, PendingRequest>()
  readonly #notificationListeners = new Set<MessageListener>()
  readonly #serverRequestListeners = new Set<MessageListener>()
  readonly #healthListeners = new Set<HealthListener>()
  readonly #restartTimestamps: number[] = []
  #health: ProcessHealth = { state: 'stopped', restartAttempt: 0 }
  #nextRequestId = 0
  #process: ChildProcessWithoutNullStreams | undefined
  #lines: Interface | undefined
  #startPromise: Promise<void> | undefined
  #restartTimer: ReturnType<typeof setTimeout> | undefined
  #lastClientInfo: InitializeClientInfo | undefined
  #intentionalStop = false
  #fatalError: Error | undefined
  #processGeneration = 0

  constructor(options: CodexAppServerClientOptions = {}) {
    this.#options = {
      ...options,
      command: options.command ?? process.env.CODEX_BIN ?? 'codex',
      args: options.args ?? ['app-server'],
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    }
    this.#restartPolicy = {
      ...defaultRestartPolicy,
      ...options.restart,
    }

    requirePositiveInteger(this.#options.requestTimeoutMs, 'requestTimeoutMs')
    requireNonNegativeInteger(
      this.#restartPolicy.initialDelayMs,
      'restart.initialDelayMs',
    )
    requireNonNegativeInteger(
      this.#restartPolicy.maxDelayMs,
      'restart.maxDelayMs',
    )
    requireNonNegativeInteger(
      this.#restartPolicy.maxRestarts,
      'restart.maxRestarts',
    )
    requirePositiveInteger(this.#restartPolicy.windowMs, 'restart.windowMs')
    if (this.#restartPolicy.maxDelayMs < this.#restartPolicy.initialDelayMs) {
      throw new RangeError(
        'restart.maxDelayMs must be greater than or equal to restart.initialDelayMs',
      )
    }
  }

  get running(): boolean {
    return this.#process !== undefined && this.#process.exitCode === null
  }

  get health(): ProcessHealth {
    return { ...this.#health }
  }

  get pendingRequestCount(): number {
    return this.#pending.size
  }

  get processGeneration(): number {
    return this.#processGeneration
  }

  async start(): Promise<void> {
    if (this.running) return
    if (this.#startPromise) return this.#startPromise

    this.#intentionalStop = false
    this.#fatalError = undefined
    this.#cancelRestart()
    if (this.#health.state === 'failed') {
      this.#restartTimestamps.length = 0
    }

    const startPromise = this.#launch(0)
    this.#startPromise = startPromise
    try {
      await startPromise
    } catch (error) {
      if (!this.#intentionalStop) {
        this.#scheduleRestart(
          error instanceof Error ? error : new Error(String(error)),
        )
      }
      throw error
    } finally {
      if (this.#startPromise === startPromise) this.#startPromise = undefined
    }
  }

  async initialize(clientInfo: InitializeClientInfo): Promise<unknown> {
    this.#lastClientInfo = { ...clientInfo }
    await this.start()
    return this.#performInitialize(clientInfo)
  }

  request<TResult = unknown>(
    method: string,
    params: unknown,
    options: RequestOptions = {},
  ): Promise<TResult> {
    const id = ++this.#nextRequestId
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs
    requirePositiveInteger(timeoutMs, 'request timeoutMs')

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return
        reject(new RequestTimeoutError(id, method, timeoutMs))
      }, timeoutMs)

      this.#pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timeout,
      })

      try {
        this.#write({ method, id, params })
      } catch (error) {
        const pending = this.#pending.get(id)
        if (pending) {
          clearTimeout(pending.timeout)
          this.#pending.delete(id)
        }
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params: unknown): void {
    this.#write({ method, params })
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.#write({ id, result })
  }

  respondWithError(id: JsonRpcId, error: JsonRpcError): void {
    this.#write({ id, error })
  }

  onNotification(listener: MessageListener): () => void {
    this.#notificationListeners.add(listener)
    return () => this.#notificationListeners.delete(listener)
  }

  onServerRequest(listener: MessageListener): () => void {
    this.#serverRequestListeners.add(listener)
    return () => this.#serverRequestListeners.delete(listener)
  }

  onHealthChange(listener: HealthListener): () => void {
    this.#healthListeners.add(listener)
    return () => this.#healthListeners.delete(listener)
  }

  async stop(): Promise<void> {
    this.#intentionalStop = true
    this.#fatalError = undefined
    this.#cancelRestart()

    const child = this.#process
    if (!child) {
      this.#setHealth('stopped', 0)
      return
    }

    await new Promise<void>((resolve) => {
      child.once('close', () => resolve())
      child.kill('SIGTERM')
    })
  }

  async #launch(restartAttempt: number): Promise<void> {
    this.#setHealth('starting', restartAttempt)
    this.#processGeneration += 1
    const child = spawn(this.#options.command, this.#options.args, {
      cwd: this.#options.cwd,
      env: this.#options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#process = child
    const lines = createInterface({ input: child.stdout })
    this.#lines = lines
    lines.on('line', (line) => this.#handleLine(child, line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.#options.onStderr?.(chunk))
    child.on('close', (code, signal) => this.#handleClose(child, code, signal))

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
    } catch (error) {
      this.#cleanupChild(child)
      throw error
    }
  }

  async #performInitialize(clientInfo: InitializeClientInfo): Promise<unknown> {
    this.#setHealth('initializing', this.#health.restartAttempt)
    const child = this.#process
    const result = await this.request('initialize', { clientInfo })
    if (this.#process !== child || !this.running) {
      throw new ProcessUnavailableError()
    }
    this.notify('initialized', {})
    this.#setHealth('ready', this.#health.restartAttempt)
    return result
  }

  #write(message: Record<string, unknown>): void {
    const child = this.#process
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      throw new ProcessUnavailableError()
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (child !== this.#process) return

    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      const error = new ProtocolError()
      this.#fatalError = error
      this.#rejectAll(error)
      child.kill('SIGTERM')
      return
    }

    if (!isRecord(message)) return

    const id = message.id
    if (
      (typeof id === 'string' || typeof id === 'number') &&
      !('method' in message)
    ) {
      const pending = this.#pending.get(id)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.#pending.delete(id)

      if (isRecord(message.error)) {
        pending.reject(
          new Error(
            typeof message.error.message === 'string'
              ? message.error.message
              : 'Unknown app-server error',
          ),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof message.method !== 'string') return
    const listeners =
      id === undefined
        ? this.#notificationListeners
        : this.#serverRequestListeners
    for (const listener of listeners) listener(message)
  }

  #handleClose(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (child !== this.#process) return

    const error = new ProcessExitedError(code, signal)
    this.#cleanupChild(child)
    this.#rejectAll(error)

    if (this.#intentionalStop) {
      this.#setHealth('stopped', 0)
      return
    }
    if (this.#fatalError) {
      this.#setHealth('failed', this.#health.restartAttempt, this.#fatalError)
      return
    }

    this.#scheduleRestart(error)
  }

  #cleanupChild(child: ChildProcessWithoutNullStreams): void {
    if (child !== this.#process) return
    this.#process = undefined
    this.#lines?.close()
    this.#lines = undefined
  }

  #scheduleRestart(error: Error): void {
    if (this.#intentionalStop || this.#fatalError || this.#restartTimer) return

    const now = Date.now()
    const windowStart = now - this.#restartPolicy.windowMs
    while ((this.#restartTimestamps[0] ?? now) < windowStart) {
      this.#restartTimestamps.shift()
    }

    if (this.#restartTimestamps.length >= this.#restartPolicy.maxRestarts) {
      this.#setHealth('failed', this.#restartTimestamps.length, error)
      return
    }

    const restartAttempt = this.#restartTimestamps.length + 1
    this.#restartTimestamps.push(now)
    const delayMs = Math.min(
      this.#restartPolicy.initialDelayMs * 2 ** (restartAttempt - 1),
      this.#restartPolicy.maxDelayMs,
    )
    this.#setHealth('restarting', restartAttempt, error)
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined
      void this.#restart(restartAttempt)
    }, delayMs)
  }

  async #restart(restartAttempt: number): Promise<void> {
    if (this.#intentionalStop || this.#fatalError) return

    try {
      await this.#launch(restartAttempt)
      if (this.#lastClientInfo) {
        await this.#performInitialize(this.#lastClientInfo)
      }
    } catch (error) {
      const restartError =
        error instanceof Error ? error : new Error(String(error))
      const child = this.#process
      if (child && child.exitCode === null) {
        child.kill('SIGTERM')
      } else {
        this.#scheduleRestart(restartError)
      }
    }
  }

  #cancelRestart(): void {
    if (!this.#restartTimer) return
    clearTimeout(this.#restartTimer)
    this.#restartTimer = undefined
  }

  #setHealth(
    state: ProcessHealthState,
    restartAttempt: number,
    lastError?: Error,
  ): void {
    const health: ProcessHealth = lastError
      ? { state, restartAttempt, lastError }
      : { state, restartAttempt }
    this.#health = health
    for (const listener of this.#healthListeners) listener({ ...health })
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

export interface WorkspaceRuntimeClient {
  readonly health: ProcessHealth
  readonly processGeneration: number
  initialize(clientInfo: InitializeClientInfo): Promise<unknown>
  request<TResult = unknown>(
    method: string,
    params: unknown,
    options?: RequestOptions,
  ): Promise<TResult>
  onNotification(listener: MessageListener): () => void
  onServerRequest(listener: MessageListener): () => void
  onHealthChange?(listener: HealthListener): () => void
  respond(id: JsonRpcId, result: unknown): void
  stop(): Promise<void>
}

export interface WorkspaceRuntimeIdentity {
  tenantId: string
  workspaceId: string
  cwd: string
  codexHome?: string
}

export interface RuntimeDelivery {
  kind: 'notification' | 'request'
  runtimeInstanceId: string
  processGeneration: number
  receiveOrdinal: number
  ingestKey: string
}

export interface WorkspaceRuntime extends WorkspaceRuntimeIdentity {
  runtimeInstanceId: string
  client: WorkspaceRuntimeClient
  initializedAt: string
}

export interface WorkspaceRuntimeRegistryOptions {
  clientInfo?: InitializeClientInfo
  clientFactory?: (identity: WorkspaceRuntimeIdentity) => WorkspaceRuntimeClient
  runtimeInstanceIdFactory?: () => string
  onMessage?: (
    runtime: WorkspaceRuntime,
    message: Record<string, unknown>,
    delivery: RuntimeDelivery,
  ) => void | Promise<void>
  onDeliveryError?: (
    runtime: WorkspaceRuntime,
    delivery: RuntimeDelivery,
    error: unknown,
  ) => void
  onHealthChange?: (runtime: WorkspaceRuntime, health: ProcessHealth) => void
}

function runtimeKey(
  identity: Pick<WorkspaceRuntimeIdentity, 'tenantId' | 'workspaceId'>,
) {
  return JSON.stringify([identity.tenantId, identity.workspaceId])
}

const defaultClientInfo: InitializeClientInfo = {
  name: 'persistent_codex_workspace',
  title: 'Persistent Codex Workspace',
  version: '0.0.0',
}

export class WorkspaceRuntimeRegistry {
  readonly #options: Required<
    Pick<WorkspaceRuntimeRegistryOptions, 'clientInfo'>
  > &
    WorkspaceRuntimeRegistryOptions
  readonly #runtimes = new Map<string, WorkspaceRuntime>()
  readonly #initializing = new Map<string, Promise<WorkspaceRuntime>>()
  readonly #deliveryQueues = new Map<string, Promise<void>>()
  #stopping = false

  constructor(options: WorkspaceRuntimeRegistryOptions = {}) {
    this.#options = {
      ...options,
      clientInfo: options.clientInfo ?? defaultClientInfo,
    }
  }

  get size(): number {
    return this.#runtimes.size
  }

  get(identity: Pick<WorkspaceRuntimeIdentity, 'tenantId' | 'workspaceId'>) {
    return this.#runtimes.get(runtimeKey(identity))
  }

  async getOrInitialize(
    identity: WorkspaceRuntimeIdentity,
  ): Promise<WorkspaceRuntime> {
    if (this.#stopping) {
      throw new CodexAppServerError(
        'RUNTIME_REGISTRY_STOPPING',
        'Workspace runtime registry is stopping',
      )
    }
    const key = runtimeKey(identity)
    const current = this.#runtimes.get(key)
    if (current) {
      if (
        current.cwd !== identity.cwd ||
        current.codexHome !== identity.codexHome
      ) {
        throw new CodexAppServerError(
          'WORKSPACE_CWD_CONFLICT',
          'Workspace runtime is already initialized with a different cwd',
        )
      }
      return current
    }
    const pending = this.#initializing.get(key)
    if (pending) return pending

    const initialization = this.#initialize(identity, key)
    this.#initializing.set(key, initialization)
    try {
      return await initialization
    } finally {
      if (this.#initializing.get(key) === initialization) {
        this.#initializing.delete(key)
      }
    }
  }

  async stopAll(): Promise<void> {
    this.#stopping = true
    await Promise.allSettled(this.#initializing.values())
    await Promise.allSettled(this.#deliveryQueues.values())
    await Promise.allSettled(
      [...this.#runtimes.values()].map((runtime) => runtime.client.stop()),
    )
    this.#runtimes.clear()
    this.#deliveryQueues.clear()
  }

  async #initialize(
    identity: WorkspaceRuntimeIdentity,
    key: string,
  ): Promise<WorkspaceRuntime> {
    const runtimeInstanceId =
      this.#options.runtimeInstanceIdFactory?.() ?? randomUUID()
    if (runtimeInstanceId.length === 0) {
      throw new CodexAppServerError(
        'INVALID_RUNTIME_INSTANCE_ID',
        'runtimeInstanceId must be a non-empty string',
      )
    }
    const client =
      this.#options.clientFactory?.(identity) ??
      new CodexAppServerClient({
        cwd: identity.cwd,
        env: identity.codexHome
          ? { ...process.env, CODEX_HOME: identity.codexHome }
          : process.env,
      })
    let runtime: WorkspaceRuntime | undefined
    const ordinals = new Map<number, number>()
    const deliver = (
      kind: RuntimeDelivery['kind'],
      message: Record<string, unknown>,
    ) => {
      if (!runtime || !this.#options.onMessage) return
      const processGeneration = client.processGeneration
      const receiveOrdinal = (ordinals.get(processGeneration) ?? 0) + 1
      ordinals.set(processGeneration, receiveOrdinal)
      const delivery: RuntimeDelivery = {
        kind,
        runtimeInstanceId,
        processGeneration,
        receiveOrdinal,
        ingestKey: JSON.stringify([
          'codex',
          identity.tenantId,
          identity.workspaceId,
          runtimeInstanceId,
          processGeneration,
          receiveOrdinal,
        ]),
      }
      const previous = this.#deliveryQueues.get(key) ?? Promise.resolve()
      const next = previous
        .then(() => this.#options.onMessage?.(runtime!, message, delivery))
        .then(() => undefined)
      this.#deliveryQueues.set(
        key,
        next.catch((error: unknown) => {
          if (this.#options.onDeliveryError) {
            try {
              this.#options.onDeliveryError(runtime!, delivery, error)
            } catch (callbackError) {
              console.error(
                'workspace runtime delivery error callback failed',
                {
                  runtimeInstanceId,
                  delivery,
                  error: callbackError,
                  deliveryError: error,
                },
              )
            }
          } else {
            console.error('workspace runtime delivery failed', {
              runtimeInstanceId,
              delivery,
              error,
            })
          }
        }),
      )
    }

    client.onNotification((message) => deliver('notification', message))
    client.onServerRequest((message) => deliver('request', message))
    client.onHealthChange?.((health) => {
      if (runtime) this.#options.onHealthChange?.(runtime, health)
    })
    try {
      await client.initialize(this.#options.clientInfo)
      runtime = {
        ...identity,
        runtimeInstanceId,
        client,
        initializedAt: new Date().toISOString(),
      }
      this.#runtimes.set(key, runtime)
      this.#options.onHealthChange?.(runtime, client.health)
      return runtime
    } catch (error) {
      await client.stop().catch(() => undefined)
      throw error
    }
  }
}
