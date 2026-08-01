import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { isAbsolute, relative, resolve } from 'node:path'
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
import { CodexTitleProcessRunner } from './title-process-runner'
import {
  decodeProductionTurnInput,
  productionAttachmentObjectKeys,
  productionPromptWithAttachmentContext,
  type MaterializedProductionAttachment,
} from './production-turn-input'

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
  workspaceSandboxBin?: string
  codexProvisioningSource?: string
  workspaceCwd: string
  healthPort?: number
  healthHost?: string
  runtimeTimeoutMs?: number
  billing: BillingPostgresRepository
  telemetry?: ProductionTelemetry
  telemetryExporter?: OtlpHttpExporter
  contentKeys?: ContentKeyResolver
  titleModelId?: string
  internalRuntimeToken?: string
}

export const CODEX_SCOPED_WORKSPACE_CWD = '/scoped-workspace'
export const CODEX_SCOPED_HOME = '/codex-session'

function safeWorkspaceEnvironment(codexHome: string): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: codexHome,
    HOME: process.env.HOME ?? '/home/workspace',
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    ...(process.env.TERM ? { TERM: process.env.TERM } : {}),
    ...(process.env.SSL_CERT_FILE
      ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE }
      : {}),
  }
}

export async function ensureConversationWorkspaceRoot(
  workspaceCwd: string,
  scope: ProductionScope,
  folderId: string,
) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(folderId))
    throw new Error('INVALID_CONVERSATION_FOLDER_ID')
  const root = await realpath(workspaceCwd)
  const scopeKey = createHash('sha256')
    .update(
      `${scope.tenantId}\0${scope.organizationId}\0${scope.workspaceId}`,
      'utf8',
    )
    .digest('hex')
  const requested = resolve(
    root,
    '.perseverance',
    'conversation-homes',
    scopeKey,
    folderId,
  )
  await mkdir(requested, { recursive: true, mode: 0o700 })
  const physical = await realpath(requested)
  const scoped = relative(root, physical)
  if (scoped.startsWith('..') || isAbsolute(scoped))
    throw new Error('CONVERSATION_WORKSPACE_ESCAPE')
  return physical
}

export async function materializeProductionAttachments(input: {
  scope: ProductionScope
  sessionId: string
  physicalWorkspace: string
  sandboxed: boolean
  attachments:
    | MaterializedProductionAttachment[]
    | Array<Omit<MaterializedProductionAttachment, 'path'>>
  objectStore: ObjectStore
  contentKey: UserContentKeyMaterial | null
}): Promise<MaterializedProductionAttachment[]> {
  return await Promise.all(
    input.attachments.map(async (attachment) => {
      if (
        !/^[A-Za-z0-9._-]{1,160}$/.test(attachment.attachmentId) ||
        !/^[A-Za-z0-9._-]{1,160}$/.test(input.sessionId) ||
        !attachment.name ||
        attachment.name === '.' ||
        attachment.name === '..' ||
        /[\\/\0\r\n]/.test(attachment.name) ||
        attachment.tenantId !== input.scope.tenantId ||
        attachment.organizationId !== input.scope.organizationId ||
        attachment.workspaceId !== input.scope.workspaceId ||
        attachment.sessionId !== input.sessionId
      )
        throw new Error('ATTACHMENT_SCOPE_MISMATCH')
      const keys = productionAttachmentObjectKeys({
        ...input.scope,
        sessionId: input.sessionId,
        attachmentId: attachment.attachmentId,
      })
      if (attachment.dataObjectKey !== keys.data)
        throw new Error('ATTACHMENT_SCOPE_MISMATCH')
      const stored = await input.objectStore.get(keys.data)
      const envelope = parseUserContentEnvelope(stored)
      if (envelope && !input.contentKey) throw new Error('CONTENT_KEY_LOCKED')
      const bytes = envelope
        ? await decryptUserContent(
            input.contentKey!,
            {
              ...input.scope,
              recordType: 'attachment',
              recordId: `${attachment.attachmentId}:data`,
            },
            envelope,
          )
        : stored
      if (bytes.byteLength !== attachment.byteLength)
        throw new Error('ATTACHMENT_SIZE_MISMATCH')
      const directory = resolve(
        input.physicalWorkspace,
        '.perseverance',
        'attachments',
        input.sessionId,
        attachment.attachmentId,
      )
      const dataPath = resolve(directory, attachment.name)
      const scoped = relative(input.physicalWorkspace, dataPath)
      if (scoped.startsWith('..') || isAbsolute(scoped))
        throw new Error('ATTACHMENT_PATH_ESCAPE')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(dataPath, bytes, { mode: 0o600 })
      return {
        ...attachment,
        path: input.sandboxed
          ? resolve(CODEX_SCOPED_WORKSPACE_CWD, scoped)
          : dataPath,
      }
    }),
  )
}

export async function deleteConversationWorkspaceRoot(
  workspaceCwd: string,
  scope: ProductionScope,
  folderId: string,
) {
  if (folderId === 'fol_default')
    throw new Error('DEFAULT_CONVERSATION_FOLDER_PROTECTED')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(folderId))
    throw new Error('INVALID_CONVERSATION_FOLDER_ID')
  const root = await realpath(workspaceCwd)
  const scopeKey = createHash('sha256')
    .update(
      `${scope.tenantId}\0${scope.organizationId}\0${scope.workspaceId}`,
      'utf8',
    )
    .digest('hex')
  const requested = resolve(
    root,
    '.perseverance',
    'conversation-homes',
    scopeKey,
    folderId,
  )
  let physical: string
  try {
    physical = await realpath(requested)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return false
    throw error
  }
  if (physical !== requested)
    throw new Error('CONVERSATION_WORKSPACE_SYMLINK_REJECTED')
  const scoped = relative(root, physical)
  if (scoped.startsWith('..') || isAbsolute(scoped))
    throw new Error('CONVERSATION_WORKSPACE_ESCAPE')
  await rm(physical, { recursive: true })
  return true
}

export function productionWorkspaceSandboxArgs(input: {
  codexBin: string
  physicalWorkspace: string
  isolatedCodexHome: string
  sourceAuthFile: string
  codexArgs?: string[]
}) {
  return [
    '--die-with-parent',
    '--new-session',
    // Bubblewrap already creates the mount/user namespace needed for this
    // filesystem boundary. Docker Desktop rejects mounting /proc after
    // --unshare-all; extra PID/cgroup namespaces do not strengthen folder
    // visibility and would make every production turn fail before launch.
    '--dir',
    '/app',
    '--ro-bind',
    '/app/codex',
    '/app/codex',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/etc',
    '/etc',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/home',
    '--dir',
    '/home/workspace',
    '--dir',
    '/codex-home',
    '--ro-bind-try',
    input.sourceAuthFile,
    '/codex-home/auth.json',
    '--bind',
    input.physicalWorkspace,
    CODEX_SCOPED_WORKSPACE_CWD,
    '--bind',
    input.isolatedCodexHome,
    CODEX_SCOPED_HOME,
    '--chdir',
    CODEX_SCOPED_WORKSPACE_CWD,
    '--',
    input.codexBin,
    ...(input.codexArgs ?? ['app-server']),
  ]
}

export const DEFAULT_LUNA_TITLE_MODEL_ID = 'gpt-5.6-terra'

export function normalizeGeneratedConversationTitle(value: string) {
  const title = value
    .replaceAll(/[\r\n]+/g, ' ')
    .replace(/^\s*[#>*`"'“”]+|[#>*`"'“”]+\s*$/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim()
  return title || null
}

function authorizedInternalRequest(
  authorization: string | undefined,
  expected: string | undefined,
) {
  if (!authorization || !expected) return false
  const supplied = Buffer.from(authorization.replace(/^Bearer\s+/i, ''))
  const target = Buffer.from(expected)
  return supplied.length === target.length && timingSafeEqual(supplied, target)
}

export async function readWorkspaceEntry(workspaceCwd: string, input: string) {
  if (
    input.includes('\0') ||
    isAbsolute(input) ||
    input.split(/[\\/]+/).includes('..')
  )
    throw new Error('INVALID_WORKSPACE_PATH')
  const root = await realpath(workspaceCwd)
  const target = await realpath(resolve(root, input || '.'))
  const scoped = relative(root, target)
  if (scoped.startsWith('..') || isAbsolute(scoped))
    throw new Error('WORKSPACE_PATH_ESCAPE')
  const info = await stat(target)
  if (info.isDirectory()) {
    const entries = await readdir(target, { withFileTypes: true })
    return {
      kind: 'directory' as const,
      path: scoped,
      entries: entries.slice(0, 500).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      })),
    }
  }
  if (!info.isFile() || info.size > 2 * 1024 * 1024)
    throw new Error('WORKSPACE_FILE_UNSUPPORTED')
  const bytes = await readFile(target)
  if (bytes.includes(0)) throw new Error('WORKSPACE_FILE_BINARY')
  return {
    kind: 'file' as const,
    path: scoped,
    content: bytes.toString('utf8'),
  }
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
    if (status === 'interrupted') return { error: 'CODEX_TURN_INTERRUPTED' }
    const turnError = turn?.error as Record<string, unknown> | undefined
    return {
      error: String(turnError?.message ?? 'CODEX_TURN_FAILED'),
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
  #activeTurn:
    | {
        runId: string
        threadId: string
        turnId: string
        physicalWorkspace: string
      }
    | undefined
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
      this.#healthServer = createServer((request, response) => {
        void (async () => {
          const url = new URL(request.url ?? '/', 'http://workspace-agent')
          response.setHeader('content-type', 'application/json')
          const interruptMatch = url.pathname.match(
            /^\/internal\/v1\/runs\/([^/]+)\/interrupt$/,
          )
          if (interruptMatch) {
            if (
              !authorizedInternalRequest(
                request.headers.authorization,
                this.options.internalRuntimeToken,
              )
            ) {
              response.writeHead(401)
              response.end(JSON.stringify({ code: 'UNAUTHORIZED' }))
              return
            }
            const runId = decodeURIComponent(interruptMatch[1]!)
            if (!this.#activeClient || this.#activeTurn?.runId !== runId) {
              response.writeHead(409)
              response.end(JSON.stringify({ code: 'RUN_NOT_ACTIVE' }))
              return
            }
            await this.#activeClient.request<codexV2.TurnInterruptResponse>(
              'turn/interrupt',
              {
                threadId: this.#activeTurn.threadId,
                turnId: this.#activeTurn.turnId,
              } satisfies codexV2.TurnInterruptParams,
            )
            response.writeHead(202)
            response.end(JSON.stringify({ status: 'accepted' }))
            return
          }
          const workspaceMatch = url.pathname.match(
            /^\/internal\/v1\/conversation-workspaces\/([^/]+)$/,
          )
          if (workspaceMatch) {
            if (
              !authorizedInternalRequest(
                request.headers.authorization,
                this.options.internalRuntimeToken,
              )
            ) {
              response.writeHead(401)
              response.end(JSON.stringify({ code: 'UNAUTHORIZED' }))
              return
            }
            try {
              const scope = {
                tenantId: url.searchParams.get('tenantId') ?? '',
                organizationId: url.searchParams.get('organizationId') ?? '',
                workspaceId: url.searchParams.get('workspaceId') ?? '',
              }
              if (
                !scope.tenantId ||
                !scope.organizationId ||
                !scope.workspaceId
              )
                throw new Error('INVALID_WORKSPACE_SCOPE')
              const folderId = decodeURIComponent(workspaceMatch[1]!)
              if (request.method === 'POST') {
                await ensureConversationWorkspaceRoot(
                  this.options.workspaceCwd,
                  scope,
                  folderId,
                )
                response.writeHead(201)
                response.end(JSON.stringify({ status: 'created' }))
                return
              }
              if (request.method === 'DELETE') {
                const root = await realpath(this.options.workspaceCwd)
                const scopeKey = createHash('sha256')
                  .update(
                    `${scope.tenantId}\0${scope.organizationId}\0${scope.workspaceId}`,
                    'utf8',
                  )
                  .digest('hex')
                const requestedWorkspace = resolve(
                  root,
                  '.perseverance',
                  'conversation-homes',
                  scopeKey,
                  folderId,
                )
                if (
                  this.#activeTurn?.physicalWorkspace === requestedWorkspace
                ) {
                  response.writeHead(409)
                  response.end(JSON.stringify({ code: 'FOLDER_RUN_ACTIVE' }))
                  return
                }
                const deleted = await deleteConversationWorkspaceRoot(
                  this.options.workspaceCwd,
                  scope,
                  folderId,
                )
                response.writeHead(200)
                response.end(JSON.stringify({ status: 'deleted', deleted }))
                return
              }
              response.writeHead(405)
              response.end(JSON.stringify({ code: 'METHOD_NOT_ALLOWED' }))
            } catch (error) {
              response.writeHead(400)
              response.end(
                JSON.stringify({
                  code:
                    error instanceof Error
                      ? error.message
                      : 'WORKSPACE_MUTATION_FAILED',
                }),
              )
            }
            return
          }
          if (url.pathname === '/internal/v1/workspace-files') {
            if (
              !authorizedInternalRequest(
                request.headers.authorization,
                this.options.internalRuntimeToken,
              )
            ) {
              response.writeHead(401)
              response.end(JSON.stringify({ code: 'UNAUTHORIZED' }))
              return
            }
            try {
              const scope = {
                tenantId: url.searchParams.get('tenantId') ?? '',
                organizationId: url.searchParams.get('organizationId') ?? '',
                workspaceId: url.searchParams.get('workspaceId') ?? '',
              }
              const sessionId = url.searchParams.get('sessionId') ?? ''
              if (
                !scope.tenantId ||
                !scope.organizationId ||
                !scope.workspaceId ||
                !sessionId
              )
                throw new Error('INVALID_WORKSPACE_SCOPE')
              const session = await this.options.repository.getSession(
                scope,
                sessionId,
              )
              if (!session) throw new Error('SESSION_NOT_FOUND')
              const workspaceRoot = await ensureConversationWorkspaceRoot(
                this.options.workspaceCwd,
                scope,
                session.folderId,
              )
              const entry = await readWorkspaceEntry(
                workspaceRoot,
                url.searchParams.get('path') ?? '',
              )
              response.writeHead(200)
              response.end(JSON.stringify(entry))
            } catch (error) {
              response.writeHead(404)
              response.end(
                JSON.stringify({
                  code:
                    error instanceof Error
                      ? error.message
                      : 'WORKSPACE_FILE_NOT_FOUND',
                }),
              )
            }
            return
          }
          response.writeHead(200)
          response.end(
            JSON.stringify({
              status: 'ready',
              role: 'scheduler',
              ownerId: this.options.ownerId,
            }),
          )
        })().catch(() => {
          response.writeHead(500)
          response.end(JSON.stringify({ code: 'INTERNAL_ERROR' }))
        })
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
    this.#activeTurn = undefined
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
      let turnInputText: string
      if (promptEnvelope) {
        if (!this.options.contentKeys) throw new Error('CONTENT_KEY_LOCKED')
        userContentKey = await this.options.contentKeys.resolve(scope)
        if (!userContentKey) throw new Error('CONTENT_KEY_LOCKED')
        turnInputText = new TextDecoder().decode(
          await decryptUserContent(
            userContentKey,
            { ...scope, recordType: 'prompt', recordId: stored.runId },
            promptEnvelope,
          ),
        )
      } else {
        turnInputText = new TextDecoder().decode(promptBytes)
      }
      const turnInput = decodeProductionTurnInput(turnInputText)
      const prompt = turnInput.prompt
      const currentSession = await this.options.repository.getSession(
        scope,
        stored.sessionId,
      )
      if (!currentSession) throw new Error('SESSION_NOT_FOUND')
      const physicalWorkspace = await ensureConversationWorkspaceRoot(
        this.options.workspaceCwd,
        scope,
        currentSession.folderId,
      )
      const sandboxed = Boolean(this.options.workspaceSandboxBin)
      const materializedAttachments = await materializeProductionAttachments({
        scope,
        sessionId: stored.sessionId,
        physicalWorkspace,
        sandboxed,
        attachments: turnInput.attachments,
        objectStore: this.options.objectStore,
        contentKey: userContentKey,
      })
      const isolatedHomeRoot = resolve(
        this.options.codexProvisioningSource ?? '/codex-home',
        'runtime',
      )
      await mkdir(isolatedHomeRoot, { recursive: true, mode: 0o700 })
      const titleHome =
        currentSession?.title === 'Yeni konuşma' &&
        currentSession.titleGeneratedAt === null
          ? createIsolatedCodexHome({
              ...(this.options.codexProvisioningSource
                ? { sourceHome: this.options.codexProvisioningSource }
                : {}),
              temporaryRoot: isolatedHomeRoot,
              includeConfig: false,
            })
          : null
      const titlePromise = titleHome
        ? (() => {
            const titleArgs = [
              'exec',
              '--json',
              '--skip-git-repo-check',
              '--sandbox',
              'read-only',
              '--model',
              this.options.titleModelId ?? DEFAULT_LUNA_TITLE_MODEL_ID,
              '--config',
              'model_reasoning_effort="none"',
              [
                'Produce only a short, safe, single-line Turkish conversation title (maximum 8 words).',
                'Do not use tools. Do not include quotes, markdown, or explanation.',
                `Message 1: ${prompt.slice(0, 2_000)}`,
              ].join('\n'),
            ]
            return new CodexTitleProcessRunner()
              .run({
                binary:
                  this.options.workspaceSandboxBin ?? this.options.codexBin,
                args: sandboxed
                  ? productionWorkspaceSandboxArgs({
                      codexBin: this.options.codexBin,
                      physicalWorkspace,
                      isolatedCodexHome: titleHome.path,
                      sourceAuthFile: resolve(
                        titleHome.sourceHome,
                        'auth.json',
                      ),
                      codexArgs: titleArgs,
                    })
                  : titleArgs,
                codexHome: sandboxed ? CODEX_SCOPED_HOME : titleHome.path,
                cwd: physicalWorkspace,
                requestId: `title:${stored.sessionId}`,
              })
              .then(async ({ title }) => {
                const normalized = normalizeGeneratedConversationTitle(title)
                if (normalized)
                  await this.options.repository.setGeneratedTitle(
                    scope,
                    stored.sessionId,
                    normalized,
                  )
              })
              .catch(() => undefined)
              .finally(() => titleHome.cleanup())
          })()
        : Promise.resolve()
      const isolatedHome = createIsolatedCodexHome({
        ...(this.options.codexProvisioningSource
          ? { sourceHome: this.options.codexProvisioningSource }
          : {}),
        temporaryRoot: isolatedHomeRoot,
        includeConfig: false,
      })
      const client = new CodexAppServerClient({
        command: this.options.workspaceSandboxBin ?? this.options.codexBin,
        ...(sandboxed
          ? {
              args: productionWorkspaceSandboxArgs({
                codexBin: this.options.codexBin,
                physicalWorkspace,
                isolatedCodexHome: isolatedHome.path,
                sourceAuthFile: resolve(isolatedHome.sourceHome, 'auth.json'),
              }),
            }
          : {}),
        cwd: physicalWorkspace,
        env: safeWorkspaceEnvironment(
          sandboxed ? CODEX_SCOPED_HOME : isolatedHome.path,
        ),
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
          productionThreadStartParams(
            sandboxed ? CODEX_SCOPED_WORKSPACE_CWD : physicalWorkspace,
          ),
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
            input: [
              ...(prompt ||
              materializedAttachments.some(
                (attachment) => attachment.kind === 'file',
              )
                ? [
                    {
                      type: 'text' as const,
                      text: productionPromptWithAttachmentContext(
                        prompt,
                        materializedAttachments,
                      ),
                      text_elements: [],
                    },
                  ]
                : []),
              ...materializedAttachments.map((attachment) =>
                attachment.kind === 'image'
                  ? ({ type: 'localImage', path: attachment.path } as const)
                  : ({
                      type: 'mention',
                      name: attachment.name,
                      path: attachment.path,
                    } as const),
              ),
            ],
          } satisfies codexV2.TurnStartParams,
        )
        this.#activeTurn = {
          runId: stored.runId,
          threadId: thread.thread.id,
          turnId: turn.turn.id,
          physicalWorkspace,
        }
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
        // Başlık işi ana Codex turn'ünden ayrı bir Luna çağrısıdır; kullanıcı
        // cevabını geciktirmeden paralel başlar, lease bırakılmadan kalıcılaşır.
        await titlePromise
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
        this.#activeTurn = undefined
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
        if (
          error instanceof Error &&
          error.message === 'CODEX_TURN_INTERRUPTED'
        ) {
          await append(
            'turn.completed',
            {
              runId: claimed.item.runId,
              outcome: 'interrupted',
              reconciled: true,
            },
            'interrupted',
          ).catch(() => undefined)
          const terminal = await this.options.repository
            .completeRun({
              ...scope,
              runId: claimed.item.runId,
              fencingToken: claimed.lease.fencingToken,
              outcome: 'interrupted',
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
              terminalState: 'completed',
            })
            .catch(() => false)
          return
        }
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
    workspaceSandboxBin: required('WP26_BWRAP_BIN'),
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
          internalRuntimeToken: readFileSync(
            env.INTERNAL_RUNTIME_TOKEN_FILE,
            'utf8',
          ).trim(),
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
