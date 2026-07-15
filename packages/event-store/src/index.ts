import { createHash } from 'node:crypto'
import { accessSync, constants, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  parseTimelineEvent,
  type TimelineEvent,
} from '@persistent-codex/domain-events'
import {
  estimateUsageCostMicros,
  modelPolicySchema,
  capabilityMatrixSchema,
  usageCountersSchema,
  type CapabilityMatrix,
  type ModelPolicy,
  type PriceCatalog,
  type ProviderCostReconciliationResult,
  type ProviderId,
  type ReasoningEffort,
  type UsageCounters,
  type UsageReport,
} from '@persistent-codex/provider-platform'
import { bootstrapSchema } from './schema'

export interface StoreScope {
  tenantId: string
  workspaceId: string
  sessionId: string
}

export const AUDIT_ACTIONS = [
  'session.created',
  'session.lifecycle_changed',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'approval.requested',
  'approval.decided',
  'auth.state_changed',
  'runtime.restarted',
  'runtime.crash_loop',
  'recovery.started',
  'recovery.completed',
  'recovery.failed',
  'turn.steered',
  'turn.interrupted',
  'git.snapshot_refreshed',
  'artifact.accessed',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]
export type AuditActor = 'user' | 'system' | 'runtime'
export type AuditOutcome = 'requested' | 'success' | 'failure'
export interface AuditRecord {
  auditId: number
  tenantId: string
  workspaceId: string
  sessionId: string | null
  actor: AuditActor
  action: AuditAction
  outcome: AuditOutcome
  correlationId: string | null
  requestId: string | null
  traceId: string | null
  metadata: Record<string, string | number | boolean | null>
  occurredAt: string
}
export interface AppendAuditInput {
  tenantId: string
  workspaceId: string
  sessionId?: string | null
  actor: AuditActor
  action: AuditAction
  outcome: AuditOutcome
  idempotencyKey: string
  correlationId?: string | null
  requestId?: string | null
  traceId?: string | null
  metadata?: Record<string, string | number | boolean | null>
  occurredAt?: string
}
export interface AuditPage {
  records: AuditRecord[]
  nextCursor: number | null
}
export interface AuditRetentionPolicy {
  maxAgeMs: number
  maxRecords: number
  maxMetadataBytes: number
}
export const DEFAULT_AUDIT_RETENTION: AuditRetentionPolicy = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  maxRecords: 10_000,
  maxMetadataBytes: 8 * 1024 * 1024,
}
const AUDIT_METADATA_KEYS = new Set([
  'fromState',
  'toState',
  'turnOutcome',
  'approvalKind',
  'decision',
  'authState',
  'runtimeState',
  'processGeneration',
  'recoveryCode',
  'operation',
  'phase',
  'artifactKind',
  'byteBucket',
  'status',
  'reasonCode',
])
const SAFE_AUDIT_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/
const SENSITIVE_AUDIT_VALUE =
  /(?:bearer\s|\b(?:sk|sess)-[A-Za-z0-9_-]+|\/(?:Users|home|proc|sys)\/|\.\.|[\r\n])/i
function auditStorageKey(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
export interface ArtifactRecord extends StoreScope {
  artifactId: string
  turnId: string
  itemId: string
  kind: 'command-output' | 'git-diff'
  byteLength: number
  sha256: string | null
  chunkCount: number
  finalized: boolean
  status: 'writing' | 'finalized' | 'recovery_required'
  createdAt: string
  finalizedAt: string | null
}

export interface SessionRecord extends StoreScope {
  folderId: string | null
  title: string
  provider: ProviderId
  requestedPolicy: ModelPolicy
  resolvedModel: string | null
  reasoningEffort: ReasoningEffort | null
  capabilitySnapshot: CapabilityMatrix | null
  codexThreadId: string | null
  status: string
  recoveryErrorCode: string | null
  lastResumedAt: string | null
  runtimeGeneration: number | null
  lastSequence: number
  createdAt: string
  updatedAt: string
}

export interface CreateSessionInput extends StoreScope {
  status?: string
  folderId?: string | null
  title?: string
  provider?: ProviderId
  requestedPolicy?: ModelPolicy
  resolvedModel?: string | null
  reasoningEffort?: ReasoningEffort | null
  capabilitySnapshot?: CapabilityMatrix | null
}

export interface TurnRecord extends StoreScope {
  turnId: string
  providerTurnId: string | null
  provider: ProviderId
  requestedPolicy: ModelPolicy
  resolvedModel: string
  reasoningEffort: ReasoningEffort
  capabilitySnapshot: CapabilityMatrix
  status: 'in_progress' | 'completed' | 'failed' | 'interrupted'
  startedAt: string
  completedAt: string | null
}

export interface UsageLedgerRecord extends StoreScope {
  ledgerId: number
  turnId: string
  requestId: string | null
  provider: ProviderId
  modelId: string
  entryKind: 'usage' | 'terminal' | 'reconciliation'
  reportKind: 'delta' | 'cumulative' | null
  dedupeKey: string
  reported: UsageCounters
  effective: UsageCounters
  outcome: 'completed' | 'failed' | 'interrupted' | null
  completeness: 'complete' | 'partial'
  reconciliationStatus: 'unreconciled' | 'reconciled'
  priceCatalogVersion: string | null
  estimatedCostMicros: number | null
  officialCostMicros: number | null
  sourceReference: string | null
  occurredAt: string
}

export interface UsageSummary extends StoreScope {
  turnId: string | null
  counters: UsageCounters
  outcome: 'completed' | 'failed' | 'interrupted' | null
  completeness: 'complete' | 'partial'
  reconciliationStatus: 'unreconciled' | 'reconciled'
  estimatedCostMicros: number | null
  officialCostMicros: number | null
  currency: 'USD'
  priceCatalogVersions: string[]
}

export interface ConversationFolderRecord {
  tenantId: string
  workspaceId: string
  folderId: string
  name: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface GitSnapshotRecord extends StoreScope {
  snapshotId: string
  turnId: string | null
  phase: 'before' | 'after' | 'refresh'
  repositoryKind: 'repository' | 'worktree' | 'submodule' | 'none'
  branch: string | null
  headOid: string | null
  detached: boolean
  clean: boolean
  changes: Array<{
    path: string
    previousPath: string | null
    areas: Array<'staged' | 'unstaged' | 'untracked'>
    stagedStatus: string | null
    unstagedStatus: string | null
    renamed: boolean
    binary: boolean
    submodule: boolean
  }>
  diff: {
    preview: string
    byteLength: number
    truncated: boolean
    artifactId: string | null
  }
  log: Array<{
    oid: string
    shortOid: string
    authoredAt: string
    authorName: string
    subject: string
  }>
  eventChangeCount: number
  relationship: 'authoritative' | 'matches_events' | 'differs_from_events'
  capturedAt: string
}

interface RawEventMetadata {
  checksum: string
  sourceMethod: string
  sourceVersion: string
  sourceMetadata?: Record<string, unknown>
  receivedAt: string
}

export type RawEventInput = RawEventMetadata &
  (
    | { envelope: Record<string, unknown>; artifactPointer?: never }
    | { envelope?: never; artifactPointer: string }
  )

export interface IngestEventInput extends StoreScope {
  ingestKey: string
  raw: RawEventInput
  event: TimelineEvent
  approval?: NewApprovalInput
}

export interface IngestRawOnlyInput extends StoreScope {
  ingestKey: string
  raw: RawEventInput
}

export type ApprovalDecision =
  'accept' | 'accept_for_session' | 'decline' | 'cancel'
export type ApprovalStatus =
  'pending' | 'resolving' | 'resolved' | 'expired' | 'superseded'
export interface ApprovalRecord extends StoreScope {
  approvalId: string
  turnId: string
  itemId: string
  requestId: string | number
  runtimeInstanceId: string
  processGeneration: number
  kind: 'command_execution' | 'file_change'
  status: ApprovalStatus
  context: Record<string, unknown>
  availableDecisions: ApprovalDecision[]
  requestedAt: string
  resolvedAt: string | null
  resolvingUserId: string | null
  selectedDecision: ApprovalDecision | null
  version: number
  upstreamResponseStatus: 'pending' | 'sent' | 'acknowledged' | 'unknown'
}
export interface NewApprovalInput extends StoreScope {
  approvalId: string
  turnId: string
  itemId: string
  requestId: string | number
  runtimeInstanceId: string
  processGeneration: number
  kind: ApprovalRecord['kind']
  context: Record<string, unknown>
  availableDecisions: ApprovalDecision[]
  requestedAt: string
}

export interface FileApprovalContext {
  filePath: string | null
  diff: string | null
  diffAvailable: boolean
}

export interface IngestEventResult {
  event: TimelineEvent
  duplicate: boolean
}

export interface ReplayPage {
  events: TimelineEvent[]
  highWaterSequence: number
  nextAfterSequence: number
  hasMore: boolean
}

export interface IdempotencyRecord {
  tenantId: string
  workspaceId: string
  sessionId: string | null
  scope: string
  key: string
  requestHash: string
  status: string
  response: unknown | null
  createdAt: string
  updatedAt: string
}

export class StoreError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

export class StoreNotFoundError extends StoreError {
  constructor(message = 'Session not found in the requested scope') {
    super('SESSION_NOT_FOUND', message)
    this.name = 'StoreNotFoundError'
  }
}

export class StoreConflictError extends StoreError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = 'StoreConflictError'
  }
}

interface SessionRow {
  tenant_id: string
  workspace_id: string
  session_id: string
  folder_id: string | null
  title: string
  provider: ProviderId
  requested_policy_json: string
  resolved_model: string | null
  reasoning_effort: ReasoningEffort | null
  capability_snapshot_json: string | null
  codex_thread_id: string | null
  status: string
  recovery_error_code: string | null
  last_resumed_at: string | null
  runtime_generation: number | null
  last_sequence: number
  created_at: string
  updated_at: string
}

interface TurnRow {
  tenant_id: string
  workspace_id: string
  session_id: string
  turn_id: string
  provider_turn_id: string | null
  provider: ProviderId
  requested_policy_json: string
  resolved_model: string
  reasoning_effort: ReasoningEffort
  capability_snapshot_json: string
  status: TurnRecord['status']
  started_at: string
  completed_at: string | null
}

interface UsageLedgerRow {
  ledger_id: number
  tenant_id: string
  workspace_id: string
  session_id: string
  turn_id: string
  request_id: string | null
  provider: ProviderId
  model_id: string
  entry_kind: UsageLedgerRecord['entryKind']
  report_kind: UsageLedgerRecord['reportKind']
  dedupe_key: string
  reported_json: string
  effective_json: string
  outcome: UsageLedgerRecord['outcome']
  completeness: UsageLedgerRecord['completeness']
  reconciliation_status: UsageLedgerRecord['reconciliationStatus']
  price_catalog_version: string | null
  estimated_cost_micros: number | null
  official_cost_micros: number | null
  source_reference: string | null
  occurred_at: string
}

interface EventRow {
  payload_json: string
}

interface DuplicateEventRow extends EventRow {
  session_id: string
  checksum: string
}

interface SequenceRow {
  last_sequence: number
}

interface IdempotencyRow {
  tenant_id: string
  workspace_id: string
  session_id: string | null
  scope: string
  key: string
  request_hash: string
  status: string
  response_json: string | null
  created_at: string
  updated_at: string
}
interface ApprovalRow {
  approval_id: string
  tenant_id: string
  workspace_id: string
  session_id: string
  turn_id: string
  item_id: string
  request_id_json: string
  runtime_instance_id: string
  process_generation: number
  kind: ApprovalRecord['kind']
  status: ApprovalStatus
  context_json: string
  available_decisions_json: string
  requested_at: string
  resolved_at: string | null
  resolving_user_id: string | null
  selected_decision: ApprovalDecision | null
  version: number
  upstream_response_status: ApprovalRecord['upstreamResponseStatus']
}
interface AuditRow {
  audit_id: number
  tenant_id: string
  workspace_id: string
  session_id: string | null
  actor: AuditActor
  action: AuditAction
  outcome: AuditOutcome
  correlation_id: string | null
  request_id: string | null
  trace_id: string | null
  metadata_json: string
  occurred_at: string
}

type CommitListener = (event: TimelineEvent) => void
type ApprovalListener = (approval: ApprovalRecord) => void

function assertIdentifier(value: string, name: string): void {
  if (value.length === 0)
    throw new StoreError('INVALID_ARGUMENT', `${name} is required`)
}

function assertScope(scope: StoreScope): void {
  assertIdentifier(scope.tenantId, 'tenantId')
  assertIdentifier(scope.workspaceId, 'workspaceId')
  assertIdentifier(scope.sessionId, 'sessionId')
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    folderId: row.folder_id,
    title: row.title,
    provider: row.provider,
    requestedPolicy: modelPolicySchema.parse(
      JSON.parse(row.requested_policy_json),
    ),
    resolvedModel: row.resolved_model,
    reasoningEffort: row.reasoning_effort,
    capabilitySnapshot:
      row.capability_snapshot_json === null
        ? null
        : capabilityMatrixSchema.parse(
            JSON.parse(row.capability_snapshot_json),
          ),
    codexThreadId: row.codex_thread_id,
    status: row.status,
    recoveryErrorCode: row.recovery_error_code,
    lastResumedAt: row.last_resumed_at,
    runtimeGeneration: row.runtime_generation,
    lastSequence: row.last_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function turnFromRow(row: TurnRow): TurnRecord {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    providerTurnId: row.provider_turn_id,
    provider: row.provider,
    requestedPolicy: modelPolicySchema.parse(
      JSON.parse(row.requested_policy_json),
    ),
    resolvedModel: row.resolved_model,
    reasoningEffort: row.reasoning_effort,
    capabilitySnapshot: capabilityMatrixSchema.parse(
      JSON.parse(row.capability_snapshot_json),
    ),
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

function usageFromRow(row: UsageLedgerRow): UsageLedgerRecord {
  return {
    ledgerId: row.ledger_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    requestId: row.request_id,
    provider: row.provider,
    modelId: row.model_id,
    entryKind: row.entry_kind,
    reportKind: row.report_kind,
    dedupeKey: row.dedupe_key,
    reported: usageCountersSchema.parse(JSON.parse(row.reported_json)),
    effective: usageCountersSchema.parse(JSON.parse(row.effective_json)),
    outcome: row.outcome,
    completeness: row.completeness,
    reconciliationStatus: row.reconciliation_status,
    priceCatalogVersion: row.price_catalog_version,
    estimatedCostMicros: row.estimated_cost_micros,
    officialCostMicros: row.official_cost_micros,
    sourceReference: row.source_reference,
    occurredAt: row.occurred_at,
  }
}

const USAGE_COUNTER_KEYS = [
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningTokens',
  'toolUnits',
] as const

function zeroUsageCounters(): UsageCounters {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    toolUnits: 0,
  }
}

function addUsageCounters(
  left: UsageCounters,
  right: UsageCounters,
): UsageCounters {
  return Object.fromEntries(
    USAGE_COUNTER_KEYS.map((key) => [key, left[key] + right[key]]),
  ) as unknown as UsageCounters
}

function idempotencyFromRow(row: IdempotencyRow): IdempotencyRecord {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    scope: row.scope,
    key: row.key,
    requestHash: row.request_hash,
    status: row.status,
    response: row.response_json === null ? null : JSON.parse(row.response_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function approvalFromRow(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    requestId: JSON.parse(row.request_id_json),
    runtimeInstanceId: row.runtime_instance_id,
    processGeneration: row.process_generation,
    kind: row.kind,
    status: row.status,
    context: JSON.parse(row.context_json),
    availableDecisions: JSON.parse(row.available_decisions_json),
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    resolvingUserId: row.resolving_user_id,
    selectedDecision: row.selected_decision,
    version: row.version,
    upstreamResponseStatus: row.upstream_response_status,
  }
}

function auditFromRow(row: AuditRow): AuditRecord {
  return {
    auditId: row.audit_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    actor: row.actor,
    action: row.action,
    outcome: row.outcome,
    correlationId: row.correlation_id,
    requestId: row.request_id,
    traceId: row.trace_id,
    metadata: JSON.parse(row.metadata_json),
    occurredAt: row.occurred_at,
  }
}

export class SqliteEventStore {
  readonly #database: DatabaseSync
  readonly #listeners = new Set<CommitListener>()
  readonly #approvalListeners = new Set<ApprovalListener>()
  readonly #now: () => Date
  readonly #auditRetention: AuditRetentionPolicy
  readonly #databasePath: string
  readonly #beforeAtomicAuditCommit: ((action: AuditAction) => void) | undefined
  #closed = false

  constructor(
    path = ':memory:',
    options: {
      now?: () => Date
      auditRetention?: Partial<AuditRetentionPolicy>
      beforeAtomicAuditCommit?: (action: AuditAction) => void
    } = {},
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#now = options.now ?? (() => new Date())
    this.#auditRetention = {
      ...DEFAULT_AUDIT_RETENTION,
      ...options.auditRetention,
    }
    this.#databasePath = path
    this.#beforeAtomicAuditCommit = options.beforeAtomicAuditCommit
    this.#database = new DatabaseSync(path)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `)
    bootstrapSchema(this.#database, this.#timestamp())
    this.#database
      .prepare(
        `UPDATE idempotency_keys SET status = 'outcome_unknown',
       response_json = ?, updated_at = ? WHERE status = 'pending'`,
      )
      .run(
        JSON.stringify({ code: 'RECOVERY_OUTCOME_UNKNOWN' }),
        this.#timestamp(),
      )
    this.#database
      .prepare(
        `UPDATE approvals SET status = 'expired', upstream_response_status = 'unknown', resolved_at = ?, version = version + 1 WHERE status = 'resolving'`,
      )
      .run(this.#timestamp())
  }

  #timestamp(): string {
    return this.#now().toISOString()
  }

  probe(): void {
    if (this.#closed) throw new StoreError('STORE_CLOSED', 'Store is closed')
    if (this.#databasePath !== ':memory:') {
      accessSync(dirname(this.#databasePath), constants.R_OK | constants.W_OK)
      accessSync(this.#databasePath, constants.R_OK | constants.W_OK)
    }
    const row = this.#database.prepare('SELECT 1 AS ok').get() as { ok: number }
    if (row.ok !== 1)
      throw new StoreError('DATABASE_PROBE_FAILED', 'Database probe failed')
  }

  appendAudit(input: AppendAuditInput): AuditRecord {
    const timestamp = this.#timestamp()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#insertAudit(input, timestamp)
      this.#pruneAudit(timestamp)
      const row = this.#findAudit(input)
      if (!row)
        throw new StoreError(
          'AUDIT_RETENTION_CONFLICT',
          'Audit record exceeds retention capacity',
        )
      this.#database.exec('COMMIT')
      return auditFromRow(row)
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #insertAudit(input: AppendAuditInput, timestamp: string): void {
    assertIdentifier(input.tenantId, 'tenantId')
    assertIdentifier(input.workspaceId, 'workspaceId')
    assertIdentifier(input.idempotencyKey, 'idempotencyKey')
    for (const [name, value] of [
      ['correlationId', input.correlationId],
      ['requestId', input.requestId],
      ['traceId', input.traceId],
    ] as const)
      if (
        value !== undefined &&
        value !== null &&
        (!SAFE_AUDIT_IDENTIFIER.test(value) ||
          SENSITIVE_AUDIT_VALUE.test(value))
      )
        throw new StoreError(
          'AUDIT_IDENTIFIER_REJECTED',
          `${name} is not a safe audit identifier`,
        )
    const metadata = input.metadata ?? {}
    for (const [key, value] of Object.entries(metadata)) {
      if (!AUDIT_METADATA_KEYS.has(key))
        throw new StoreError(
          'AUDIT_METADATA_REJECTED',
          `Audit metadata key is not allowed: ${key}`,
        )
      if (typeof value === 'string' && value.length > 128)
        throw new StoreError(
          'AUDIT_METADATA_REJECTED',
          `Audit metadata value is too long: ${key}`,
        )
      if (typeof value === 'string' && SENSITIVE_AUDIT_VALUE.test(value))
        throw new StoreError(
          'AUDIT_METADATA_REJECTED',
          `Audit metadata value is sensitive: ${key}`,
        )
    }
    const metadataJson = JSON.stringify(metadata)
    const metadataBytes = Buffer.byteLength(metadataJson)
    if (metadataBytes > 2_048)
      throw new StoreError(
        'AUDIT_METADATA_REJECTED',
        'Audit metadata exceeds 2048 bytes',
      )
    const occurredAt = input.occurredAt ?? timestamp
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO audit_records (
          tenant_id, workspace_id, session_id, actor, action, outcome,
          correlation_id, request_id, trace_id, idempotency_key,
          metadata_json, metadata_bytes, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tenantId,
        input.workspaceId,
        input.sessionId ?? null,
        input.actor,
        input.action,
        input.outcome,
        input.correlationId ?? null,
        input.requestId ?? null,
        input.traceId ?? null,
        auditStorageKey(input.idempotencyKey),
        metadataJson,
        metadataBytes,
        occurredAt,
        timestamp,
      )
  }

  #findAudit(
    input: Pick<
      AppendAuditInput,
      'tenantId' | 'workspaceId' | 'idempotencyKey'
    >,
  ): AuditRow | undefined {
    return this.#database
      .prepare(
        `SELECT * FROM audit_records WHERE tenant_id=? AND workspace_id=? AND idempotency_key=?`,
      )
      .get(
        input.tenantId,
        input.workspaceId,
        auditStorageKey(input.idempotencyKey),
      ) as unknown as AuditRow | undefined
  }

  #pruneAudit(timestamp: string): void {
    const cutoff = new Date(
      new Date(timestamp).getTime() - this.#auditRetention.maxAgeMs,
    ).toISOString()
    this.#database
      .prepare(`DELETE FROM audit_records WHERE created_at < ?`)
      .run(cutoff)
    this.#database
      .prepare(
        `DELETE FROM audit_records WHERE audit_id IN (
        SELECT audit_id FROM audit_records ORDER BY audit_id DESC LIMIT -1 OFFSET ?
      )`,
      )
      .run(this.#auditRetention.maxRecords)
    const total = this.#database
      .prepare(
        `SELECT COALESCE(SUM(metadata_bytes),0) AS total FROM audit_records`,
      )
      .get() as { total: number }
    if (total.total > this.#auditRetention.maxMetadataBytes) {
      let remaining = total.total
      const rows = this.#database
        .prepare(
          `SELECT audit_id, metadata_bytes FROM audit_records ORDER BY audit_id`,
        )
        .all() as unknown as Array<{ audit_id: number; metadata_bytes: number }>
      for (const row of rows) {
        if (remaining <= this.#auditRetention.maxMetadataBytes) break
        this.#database
          .prepare(`DELETE FROM audit_records WHERE audit_id=?`)
          .run(row.audit_id)
        remaining -= row.metadata_bytes
      }
    }
  }

  listAudit(
    scope: StoreScope,
    options: { cursor?: number; limit?: number } = {},
  ): AuditPage {
    assertScope(scope)
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100)
    const rows = this.#database
      .prepare(
        `SELECT * FROM audit_records
       WHERE tenant_id=? AND workspace_id=? AND session_id=? AND audit_id < ?
       ORDER BY audit_id DESC LIMIT ?`,
      )
      .all(
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        options.cursor ?? Number.MAX_SAFE_INTEGER,
        limit + 1,
      ) as unknown as AuditRow[]
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    return {
      records: page.map(auditFromRow),
      nextCursor: hasMore ? page.at(-1)!.audit_id : null,
    }
  }

  listWorkspaceAudit(
    scope: Pick<StoreScope, 'tenantId' | 'workspaceId'>,
    limit = 100,
  ): AuditRecord[] {
    assertIdentifier(scope.tenantId, 'tenantId')
    assertIdentifier(scope.workspaceId, 'workspaceId')
    const boundedLimit = Math.min(Math.max(limit, 1), 100)
    const rows = this.#database
      .prepare(
        `SELECT * FROM audit_records WHERE tenant_id=? AND workspace_id=?
         ORDER BY audit_id DESC LIMIT ?`,
      )
      .all(
        scope.tenantId,
        scope.workspaceId,
        boundedLimit,
      ) as unknown as AuditRow[]
    return rows.map(auditFromRow)
  }

  getAuditStats(): { records: number; metadataBytes: number } {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS records, COALESCE(SUM(metadata_bytes),0) AS metadataBytes FROM audit_records`,
      )
      .get() as { records: number; metadataBytes: number }
    return row
  }

  createSession(input: CreateSessionInput): SessionRecord {
    assertScope(input)
    const status = input.status ?? 'active'
    const requestedPolicy = modelPolicySchema.parse(
      input.requestedPolicy ?? {
        alias: 'sol',
        reasoningEffort: 'medium',
      },
    )
    assertIdentifier(status, 'status')
    const timestamp = this.#timestamp()
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO sessions (
          tenant_id, workspace_id, session_id, folder_id, title, provider,
          requested_policy_json, resolved_model, reasoning_effort,
          capability_snapshot_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tenantId,
        input.workspaceId,
        input.sessionId,
        input.folderId ?? null,
        input.title ?? 'Yeni konuşma',
        input.provider ?? 'codex',
        JSON.stringify(requestedPolicy),
        input.resolvedModel ?? null,
        input.reasoningEffort ?? null,
        input.capabilitySnapshot
          ? JSON.stringify(
              capabilityMatrixSchema.parse(input.capabilitySnapshot),
            )
          : null,
        status,
        timestamp,
        timestamp,
      )
    return this.getSession(input)
  }

  createSessionWithAudit(
    input: CreateSessionInput,
    audit: AppendAuditInput,
  ): SessionRecord {
    assertScope(input)
    const status = input.status ?? 'active'
    const requestedPolicy = modelPolicySchema.parse(
      input.requestedPolicy ?? {
        alias: 'sol',
        reasoningEffort: 'medium',
      },
    )
    assertIdentifier(status, 'status')
    const timestamp = this.#timestamp()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO sessions (
            tenant_id, workspace_id, session_id, folder_id, title, provider,
            requested_policy_json, resolved_model, reasoning_effort,
            capability_snapshot_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.workspaceId,
          input.sessionId,
          input.folderId ?? null,
          input.title ?? 'Yeni konuşma',
          input.provider ?? 'codex',
          JSON.stringify(requestedPolicy),
          input.resolvedModel ?? null,
          input.reasoningEffort ?? null,
          input.capabilitySnapshot
            ? JSON.stringify(
                capabilityMatrixSchema.parse(input.capabilitySnapshot),
              )
            : null,
          status,
          timestamp,
          timestamp,
        )
      this.#insertAudit(audit, timestamp)
      this.#pruneAudit(timestamp)
      this.#beforeAtomicAuditCommit?.(audit.action)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    return this.getSession(input)
  }

  createConversationFolder(input: {
    tenantId: string
    workspaceId: string
    folderId: string
    name: string
  }): ConversationFolderRecord {
    assertIdentifier(input.tenantId, 'tenantId')
    assertIdentifier(input.workspaceId, 'workspaceId')
    assertIdentifier(input.folderId, 'folderId')
    const name = input.name.trim()
    if (!name || name.length > 80)
      throw new StoreError('INVALID_FOLDER_NAME', 'Folder name is invalid')
    const timestamp = this.#timestamp()
    this.#database
      .prepare(
        `INSERT INTO conversation_folders
         (tenant_id, workspace_id, folder_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tenantId,
        input.workspaceId,
        input.folderId,
        name,
        timestamp,
        timestamp,
      )
    return {
      ...input,
      name,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
  }

  listConversationFolders(scope: {
    tenantId: string
    workspaceId: string
  }): ConversationFolderRecord[] {
    assertIdentifier(scope.tenantId, 'tenantId')
    assertIdentifier(scope.workspaceId, 'workspaceId')
    const rows = this.#database
      .prepare(
        `SELECT folder_id, name, archived_at, created_at, updated_at
         FROM conversation_folders
         WHERE tenant_id = ? AND workspace_id = ?
         ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE, folder_id`,
      )
      .all(scope.tenantId, scope.workspaceId) as unknown as Array<{
      folder_id: string
      name: string
      archived_at: string | null
      created_at: string
      updated_at: string
    }>
    return rows.map((row) => ({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      folderId: row.folder_id,
      name: row.name,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  setConversationFolderArchived(
    scope: { tenantId: string; workspaceId: string; folderId: string },
    archived: boolean,
  ): ConversationFolderRecord {
    assertIdentifier(scope.tenantId, 'tenantId')
    assertIdentifier(scope.workspaceId, 'workspaceId')
    assertIdentifier(scope.folderId, 'folderId')
    const timestamp = this.#timestamp()
    const result = this.#database
      .prepare(
        `UPDATE conversation_folders
         SET archived_at = ?, updated_at = ?
         WHERE tenant_id = ? AND workspace_id = ? AND folder_id = ?`,
      )
      .run(
        archived ? timestamp : null,
        timestamp,
        scope.tenantId,
        scope.workspaceId,
        scope.folderId,
      )
    if (Number(result.changes) !== 1) throw new StoreNotFoundError()
    return this.listConversationFolders(scope).find(
      (folder) => folder.folderId === scope.folderId,
    )!
  }

  deleteConversationFolder(scope: {
    tenantId: string
    workspaceId: string
    folderId: string
  }): void {
    assertIdentifier(scope.tenantId, 'tenantId')
    assertIdentifier(scope.workspaceId, 'workspaceId')
    assertIdentifier(scope.folderId, 'folderId')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const timestamp = this.#timestamp()
      this.#database
        .prepare(
          `UPDATE sessions SET folder_id = NULL, updated_at = ?
           WHERE tenant_id = ? AND workspace_id = ? AND folder_id = ?`,
        )
        .run(timestamp, scope.tenantId, scope.workspaceId, scope.folderId)
      const result = this.#database
        .prepare(
          `DELETE FROM conversation_folders
           WHERE tenant_id = ? AND workspace_id = ? AND folder_id = ?`,
        )
        .run(scope.tenantId, scope.workspaceId, scope.folderId)
      if (Number(result.changes) !== 1) throw new StoreNotFoundError()
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  updateConversation(
    scope: StoreScope,
    changes: { folderId?: string | null; title?: string },
  ): SessionRecord {
    assertScope(scope)
    const current = this.getSession(scope)
    const title = changes.title?.trim() ?? current.title
    if (!title || title.length > 120)
      throw new StoreError('INVALID_CONVERSATION_TITLE', 'Title is invalid')
    const folderId =
      changes.folderId === undefined ? current.folderId : changes.folderId
    const result = this.#database
      .prepare(
        `UPDATE sessions SET folder_id = ?, title = ?, updated_at = ?
         WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?`,
      )
      .run(
        folderId,
        title,
        this.#timestamp(),
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
      )
    if (Number(result.changes) !== 1) throw new StoreNotFoundError()
    return this.getSession(scope)
  }

  upsertArtifact(input: ArtifactRecord): ArtifactRecord {
    assertScope(input)
    this.#database
      .prepare(
        `INSERT INTO artifacts (artifact_id,tenant_id,workspace_id,session_id,turn_id,item_id,kind,byte_length,sha256,chunk_count,finalized,status,metadata_json,created_at,finalized_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET byte_length=excluded.byte_length,sha256=excluded.sha256,chunk_count=excluded.chunk_count,finalized=excluded.finalized,status=excluded.status,metadata_json=excluded.metadata_json,finalized_at=excluded.finalized_at WHERE artifacts.tenant_id=excluded.tenant_id AND artifacts.workspace_id=excluded.workspace_id`,
      )
      .run(
        input.artifactId,
        input.tenantId,
        input.workspaceId,
        input.sessionId,
        input.turnId,
        input.itemId,
        input.kind,
        input.byteLength,
        input.sha256,
        input.chunkCount,
        input.finalized ? 1 : 0,
        input.status,
        JSON.stringify({ rangesPersisted: false }),
        input.createdAt,
        input.finalizedAt,
      )
    return this.getArtifact(input, input.artifactId)
  }
  getArtifact(
    scope: Pick<StoreScope, 'tenantId' | 'workspaceId'>,
    artifactId: string,
  ): ArtifactRecord {
    const row = this.#database
      .prepare(
        `SELECT * FROM artifacts WHERE tenant_id=? AND workspace_id=? AND artifact_id=?`,
      )
      .get(scope.tenantId, scope.workspaceId, artifactId) as any
    if (!row) throw new StoreError('ARTIFACT_NOT_FOUND', 'Artifact not found')
    return {
      artifactId: row.artifact_id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      itemId: row.item_id,
      kind: row.kind,
      byteLength: row.byte_length,
      sha256: row.sha256,
      chunkCount: row.chunk_count,
      finalized: Boolean(row.finalized),
      status: row.status,
      createdAt: row.created_at,
      finalizedAt: row.finalized_at,
    }
  }
  listRecoverableArtifacts() {
    const rows = this.#database
      .prepare(
        `SELECT artifact_id,tenant_id,workspace_id FROM artifacts WHERE status!='finalized'`,
      )
      .all() as any[]
    return rows.map((row) =>
      this.getArtifact(
        { tenantId: row.tenant_id, workspaceId: row.workspace_id },
        row.artifact_id,
      ),
    )
  }
  listArtifacts(
    scope: Pick<StoreScope, 'tenantId' | 'workspaceId'>,
  ): ArtifactRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT artifact_id FROM artifacts WHERE tenant_id=? AND workspace_id=? ORDER BY created_at`,
      )
      .all(scope.tenantId, scope.workspaceId) as unknown as Array<{
      artifact_id: string
    }>
    return rows.map((row) => this.getArtifact(scope, row.artifact_id))
  }

  getSession(scope: StoreScope): SessionRecord {
    assertScope(scope)
    const row = this.#database
      .prepare(
        `SELECT * FROM sessions
         WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?`,
      )
      .get(scope.tenantId, scope.workspaceId, scope.sessionId) as unknown as
      SessionRow | undefined
    if (!row) throw new StoreNotFoundError()
    return sessionFromRow(row)
  }

  createTurn(
    input: Omit<TurnRecord, 'startedAt' | 'completedAt'> & {
      startedAt?: string
    },
  ): TurnRecord {
    assertScope(input)
    assertIdentifier(input.turnId, 'turnId')
    const startedAt = input.startedAt ?? this.#timestamp()
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO turns (
          tenant_id, workspace_id, session_id, turn_id, provider_turn_id,
          provider, requested_policy_json, resolved_model, reasoning_effort,
          capability_snapshot_json, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tenantId,
        input.workspaceId,
        input.sessionId,
        input.turnId,
        input.providerTurnId,
        input.provider,
        JSON.stringify(modelPolicySchema.parse(input.requestedPolicy)),
        input.resolvedModel,
        input.reasoningEffort,
        JSON.stringify(capabilityMatrixSchema.parse(input.capabilitySnapshot)),
        input.status,
        startedAt,
      )
    return this.getTurn(input, input.turnId)
  }

  getTurn(scope: StoreScope, turnId: string): TurnRecord {
    assertScope(scope)
    assertIdentifier(turnId, 'turnId')
    const row = this.#database
      .prepare(
        `SELECT * FROM turns WHERE tenant_id=? AND workspace_id=? AND session_id=? AND turn_id=?`,
      )
      .get(
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        turnId,
      ) as unknown as TurnRow | undefined
    if (!row)
      throw new StoreNotFoundError('Turn not found in the requested scope')
    return turnFromRow(row)
  }

  completeTurn(
    scope: StoreScope,
    turnId: string,
    outcome: 'completed' | 'failed' | 'interrupted',
    completedAt = this.#timestamp(),
  ): TurnRecord {
    const result = this.#database
      .prepare(
        `UPDATE turns SET status=?, completed_at=?
         WHERE tenant_id=? AND workspace_id=? AND session_id=? AND turn_id=?`,
      )
      .run(
        outcome,
        completedAt,
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        turnId,
      )
    if (Number(result.changes) !== 1)
      throw new StoreNotFoundError('Turn not found in the requested scope')
    return this.getTurn(scope, turnId)
  }

  appendUsage(
    input: StoreScope & {
      turnId: string
      modelId: string
      report: UsageReport
      priceCatalog?: PriceCatalog
    },
  ): UsageLedgerRecord {
    assertScope(input)
    assertIdentifier(input.turnId, 'turnId')
    assertIdentifier(input.modelId, 'modelId')
    const report = input.report
    const counters = usageCountersSchema.parse(report.counters)
    const timestamp = this.#timestamp()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const duplicate = this.#database
        .prepare(
          `SELECT * FROM usage_ledger
           WHERE tenant_id=? AND workspace_id=? AND session_id=? AND dedupe_key=?`,
        )
        .get(
          input.tenantId,
          input.workspaceId,
          input.sessionId,
          report.dedupeKey,
        ) as unknown as UsageLedgerRow | undefined
      if (duplicate) {
        if (
          duplicate.turn_id !== input.turnId ||
          duplicate.request_id !== report.requestId ||
          duplicate.provider !== report.provider ||
          duplicate.model_id !== input.modelId ||
          duplicate.report_kind !== report.kind ||
          duplicate.reported_json !== JSON.stringify(counters)
        )
          throw new StoreConflictError(
            'USAGE_DEDUPE_CONFLICT',
            'Usage dedupe key was reused with different reported usage',
          )
        this.#database.exec('COMMIT')
        return usageFromRow(duplicate)
      }
      const cursor = this.#database
        .prepare(
          `SELECT accounted_json, provider, model_id FROM usage_cursors
           WHERE tenant_id=? AND workspace_id=? AND session_id=? AND turn_id=? AND request_id=?`,
        )
        .get(
          input.tenantId,
          input.workspaceId,
          input.sessionId,
          input.turnId,
          report.requestId,
        ) as
        | { accounted_json: string; provider: string; model_id: string }
        | undefined
      if (
        cursor &&
        (cursor.provider !== report.provider ||
          cursor.model_id !== input.modelId)
      )
        throw new StoreConflictError(
          'USAGE_IDENTITY_CONFLICT',
          'Usage request identity changed provider or model',
        )
      const accounted = cursor
        ? usageCountersSchema.parse(JSON.parse(cursor.accounted_json))
        : zeroUsageCounters()
      const effective = usageCountersSchema.parse(
        Object.fromEntries(
          USAGE_COUNTER_KEYS.map((key) => [
            key,
            report.kind === 'delta'
              ? counters[key]
              : Math.max(0, counters[key] - accounted[key]),
          ]),
        ),
      )
      const nextAccounted = addUsageCounters(accounted, effective)
      const estimate = input.priceCatalog
        ? estimateUsageCostMicros({
            provider: report.provider,
            modelId: input.modelId,
            counters: effective,
            catalog: input.priceCatalog,
          })
        : null
      this.#database
        .prepare(
          `INSERT INTO usage_ledger (
            tenant_id, workspace_id, session_id, turn_id, request_id,
            provider, model_id, entry_kind, report_kind, dedupe_key,
            reported_json, effective_json, completeness,
            reconciliation_status, price_catalog_version,
            estimated_cost_micros, occurred_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'usage', ?, ?, ?, ?, ?,
                    'unreconciled', ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.workspaceId,
          input.sessionId,
          input.turnId,
          report.requestId,
          report.provider,
          input.modelId,
          report.kind,
          report.dedupeKey,
          JSON.stringify(counters),
          JSON.stringify(effective),
          report.completeness,
          estimate?.priceCatalogVersion ?? null,
          estimate?.amountMicros ?? null,
          report.occurredAt,
          timestamp,
        )
      this.#database
        .prepare(
          `INSERT INTO usage_cursors (
            tenant_id, workspace_id, session_id, turn_id, request_id,
            provider, model_id, accounted_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id,workspace_id,session_id,turn_id,request_id)
          DO UPDATE SET accounted_json=excluded.accounted_json,
                        updated_at=excluded.updated_at`,
        )
        .run(
          input.tenantId,
          input.workspaceId,
          input.sessionId,
          input.turnId,
          report.requestId,
          report.provider,
          input.modelId,
          JSON.stringify(nextAccounted),
          timestamp,
        )
      const row = this.#database
        .prepare(
          `SELECT * FROM usage_ledger WHERE ledger_id=last_insert_rowid()`,
        )
        .get() as unknown as UsageLedgerRow
      this.#database.exec('COMMIT')
      return usageFromRow(row)
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  appendUsageOutcome(
    input: StoreScope & {
      turnId: string
      provider: ProviderId
      modelId: string
      dedupeKey: string
      outcome: 'completed' | 'failed' | 'interrupted'
      completeness: 'complete' | 'partial'
      occurredAt?: string
    },
  ): UsageLedgerRecord {
    const timestamp = this.#timestamp()
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO usage_ledger (
          tenant_id, workspace_id, session_id, turn_id, provider, model_id,
          entry_kind, dedupe_key, reported_json, effective_json, outcome,
          completeness, reconciliation_status, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'terminal', ?, ?, ?, ?, ?,
                  'unreconciled', ?, ?)`,
      )
      .run(
        input.tenantId,
        input.workspaceId,
        input.sessionId,
        input.turnId,
        input.provider,
        input.modelId,
        input.dedupeKey,
        JSON.stringify(zeroUsageCounters()),
        JSON.stringify(zeroUsageCounters()),
        input.outcome,
        input.completeness,
        input.occurredAt ?? timestamp,
        timestamp,
      )
    const row = this.#database
      .prepare(
        `SELECT * FROM usage_ledger
         WHERE tenant_id=? AND workspace_id=? AND session_id=? AND dedupe_key=?`,
      )
      .get(
        input.tenantId,
        input.workspaceId,
        input.sessionId,
        input.dedupeKey,
      ) as unknown as UsageLedgerRow
    return usageFromRow(row)
  }

  appendUsageReconciliation(
    input: StoreScope & {
      turnId: string
      provider: ProviderId
      modelId: string
      dedupeKey: string
      result: ProviderCostReconciliationResult
    },
  ): UsageLedgerRecord {
    const timestamp = this.#timestamp()
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO usage_ledger (
          tenant_id, workspace_id, session_id, turn_id, provider, model_id,
          entry_kind, dedupe_key, reported_json, effective_json,
          completeness, reconciliation_status, official_cost_micros,
          source_reference, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'reconciliation', ?, ?, ?, 'complete',
                  'reconciled', ?, ?, ?, ?)`,
      )
      .run(
        input.tenantId,
        input.workspaceId,
        input.sessionId,
        input.turnId,
        input.provider,
        input.modelId,
        input.dedupeKey,
        JSON.stringify(zeroUsageCounters()),
        JSON.stringify(zeroUsageCounters()),
        input.result.officialCostMicros,
        input.result.sourceReference,
        input.result.reconciledAt,
        timestamp,
      )
    const row = this.#database
      .prepare(
        `SELECT * FROM usage_ledger
         WHERE tenant_id=? AND workspace_id=? AND session_id=? AND dedupe_key=?`,
      )
      .get(
        input.tenantId,
        input.workspaceId,
        input.sessionId,
        input.dedupeKey,
      ) as unknown as UsageLedgerRow
    return usageFromRow(row)
  }

  getUsageSummary(scope: StoreScope, turnId?: string): UsageSummary {
    assertScope(scope)
    const rows = this.#database
      .prepare(
        `SELECT * FROM usage_ledger
         WHERE tenant_id=? AND workspace_id=? AND session_id=?
           AND (? IS NULL OR turn_id=?) ORDER BY ledger_id`,
      )
      .all(
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        turnId ?? null,
        turnId ?? null,
      ) as unknown as UsageLedgerRow[]
    const records = rows.map(usageFromRow)
    const usage = records.filter((record) => record.entryKind === 'usage')
    const terminals = records.filter(
      (record) => record.entryKind === 'terminal',
    )
    const terminal = terminals.at(-1)
    const reconciliations = records.filter(
      (record) => record.entryKind === 'reconciliation',
    )
    const counters = usage.reduce(
      (total, record) => addUsageCounters(total, record.effective),
      zeroUsageCounters(),
    )
    const pricedUsage = usage.filter(
      (record) => record.estimatedCostMicros !== null,
    )
    const estimatedCostMicros =
      pricedUsage.length === 0
        ? null
        : pricedUsage.reduce(
            (total, record) => total + (record.estimatedCostMicros ?? 0),
            0,
          )
    const measuredTurns = new Set(usage.map((record) => record.turnId))
    const terminalByTurn = new Map(
      terminals.map((record) => [record.turnId, record]),
    )
    const reconciledTurns = new Set(
      reconciliations.map((record) => record.turnId),
    )
    const complete =
      measuredTurns.size > 0 &&
      pricedUsage.length === usage.length &&
      [...measuredTurns].every(
        (id) => terminalByTurn.get(id)?.completeness === 'complete',
      )
    return {
      ...scope,
      turnId: turnId ?? null,
      counters,
      outcome: terminal?.outcome ?? null,
      completeness: complete ? 'complete' : 'partial',
      reconciliationStatus:
        measuredTurns.size > 0 &&
        [...measuredTurns].every((id) => reconciledTurns.has(id))
          ? 'reconciled'
          : 'unreconciled',
      estimatedCostMicros,
      officialCostMicros:
        reconciliations.length === 0
          ? null
          : reconciliations.reduce(
              (total, record) => total + (record.officialCostMicros ?? 0),
              0,
            ),
      currency: 'USD',
      priceCatalogVersions: [
        ...new Set(
          usage.flatMap((record) =>
            record.priceCatalogVersion ? [record.priceCatalogVersion] : [],
          ),
        ),
      ],
    }
  }

  hasUsage(scope: StoreScope, turnId: string): boolean {
    assertScope(scope)
    return Boolean(
      this.#database
        .prepare(
          `SELECT 1 FROM usage_ledger
           WHERE tenant_id=? AND workspace_id=? AND session_id=?
             AND turn_id=? AND entry_kind='usage' LIMIT 1`,
        )
        .get(scope.tenantId, scope.workspaceId, scope.sessionId, turnId),
    )
  }

  listWorkspaceSessions(scope: {
    tenantId: string
    workspaceId: string
  }): SessionRecord[] {
    assertIdentifier(scope.tenantId, 'tenantId')
    assertIdentifier(scope.workspaceId, 'workspaceId')
    const rows = this.#database
      .prepare(
        `SELECT * FROM sessions WHERE tenant_id = ? AND workspace_id = ? ORDER BY created_at`,
      )
      .all(scope.tenantId, scope.workspaceId) as unknown as SessionRow[]
    return rows.map(sessionFromRow)
  }

  listRecentSessions(
    scope: { tenantId: string; workspaceId: string },
    limit: number,
    cursor?: { updatedAt: string; sessionId: string },
  ): { sessions: SessionRecord[]; hasMore: boolean } {
    assertIdentifier(scope.tenantId, 'tenantId')
    assertIdentifier(scope.workspaceId, 'workspaceId')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new StoreError('INVALID_LIMIT', 'limit must be between 1 and 100')
    const rows = this.#database
      .prepare(
        `SELECT * FROM sessions
         WHERE tenant_id = ? AND workspace_id = ?
           AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND session_id < ?))
         ORDER BY updated_at DESC, session_id DESC LIMIT ?`,
      )
      .all(
        scope.tenantId,
        scope.workspaceId,
        cursor?.updatedAt ?? null,
        cursor?.updatedAt ?? null,
        cursor?.updatedAt ?? null,
        cursor?.sessionId ?? null,
        limit + 1,
      ) as unknown as SessionRow[]
    return {
      sessions: rows.slice(0, limit).map(sessionFromRow),
      hasMore: rows.length > limit,
    }
  }

  putGitSnapshot(
    input: GitSnapshotRecord & { idempotencyKey: string },
  ): GitSnapshotRecord {
    assertScope(input)
    assertIdentifier(input.snapshotId, 'snapshotId')
    assertIdentifier(input.idempotencyKey, 'idempotencyKey')
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO git_snapshots
         (snapshot_id,tenant_id,workspace_id,session_id,turn_id,phase,idempotency_key,payload_json,captured_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.snapshotId,
        input.tenantId,
        input.workspaceId,
        input.sessionId,
        input.turnId,
        input.phase,
        input.idempotencyKey,
        JSON.stringify(input),
        input.capturedAt,
      )
    const row = this.#database
      .prepare(
        `SELECT payload_json FROM git_snapshots
         WHERE tenant_id=? AND workspace_id=? AND session_id=? AND idempotency_key=?`,
      )
      .get(
        input.tenantId,
        input.workspaceId,
        input.sessionId,
        input.idempotencyKey,
      ) as { payload_json: string }
    return JSON.parse(row.payload_json) as GitSnapshotRecord
  }

  findGitSnapshotByIdempotency(
    scope: StoreScope,
    idempotencyKey: string,
  ): GitSnapshotRecord | undefined {
    assertScope(scope)
    const row = this.#database
      .prepare(
        `SELECT payload_json FROM git_snapshots
         WHERE tenant_id=? AND workspace_id=? AND session_id=? AND idempotency_key=?`,
      )
      .get(
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        idempotencyKey,
      ) as { payload_json: string } | undefined
    return row ? (JSON.parse(row.payload_json) as GitSnapshotRecord) : undefined
  }

  bindGitSnapshotTurn(
    scope: StoreScope,
    snapshotId: string,
    turnId: string,
  ): GitSnapshotRecord {
    assertScope(scope)
    const existing = this.#database
      .prepare(
        `SELECT payload_json FROM git_snapshots
         WHERE tenant_id=? AND workspace_id=? AND session_id=? AND snapshot_id=?`,
      )
      .get(scope.tenantId, scope.workspaceId, scope.sessionId, snapshotId) as
      { payload_json: string } | undefined
    if (!existing)
      throw new StoreError('GIT_SNAPSHOT_NOT_FOUND', 'Git snapshot not found')
    const payload = {
      ...(JSON.parse(existing.payload_json) as GitSnapshotRecord),
      turnId,
    }
    this.#database
      .prepare(
        `UPDATE git_snapshots SET turn_id=?, payload_json=?
         WHERE tenant_id=? AND workspace_id=? AND session_id=? AND snapshot_id=?`,
      )
      .run(
        turnId,
        JSON.stringify(payload),
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        snapshotId,
      )
    return payload
  }

  listGitSnapshots(scope: StoreScope, limit = 20): GitSnapshotRecord[] {
    assertScope(scope)
    const rows = this.#database
      .prepare(
        `SELECT payload_json FROM git_snapshots
         WHERE tenant_id=? AND workspace_id=? AND session_id=?
         ORDER BY captured_at DESC, snapshot_id DESC LIMIT ?`,
      )
      .all(scope.tenantId, scope.workspaceId, scope.sessionId, limit) as Array<{
      payload_json: string
    }>
    return rows.map((row) => JSON.parse(row.payload_json) as GitSnapshotRecord)
  }

  countTurnFileChanges(scope: StoreScope, turnId: string): number {
    assertScope(scope)
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM events
         WHERE tenant_id=? AND workspace_id=? AND session_id=?
           AND type='file.change.completed'
           AND json_extract(payload_json, '$.codexTurnId')=?`,
      )
      .get(scope.tenantId, scope.workspaceId, scope.sessionId, turnId) as {
      count: number
    }
    return row.count
  }

  bindCodexThread(scope: StoreScope, codexThreadId: string): SessionRecord {
    assertScope(scope)
    assertIdentifier(codexThreadId, 'codexThreadId')
    const session = this.getSession(scope)
    if (session.codexThreadId === codexThreadId) return session
    if (session.codexThreadId !== null) {
      throw new StoreConflictError(
        'SESSION_THREAD_CONFLICT',
        'Session is already bound to a different Codex thread',
      )
    }

    try {
      const result = this.#database
        .prepare(
          `UPDATE sessions
           SET codex_thread_id = ?, updated_at = ?
           WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?
             AND codex_thread_id IS NULL`,
        )
        .run(
          codexThreadId,
          this.#timestamp(),
          scope.tenantId,
          scope.workspaceId,
          scope.sessionId,
        )
      if (Number(result.changes) !== 1) {
        return this.bindCodexThread(scope, codexThreadId)
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed')
      ) {
        throw new StoreConflictError(
          'CODEX_THREAD_CONFLICT',
          'Codex thread is already bound to another session in this workspace',
        )
      }
      throw error
    }
    return this.getSession(scope)
  }

  updateSessionStatus(scope: StoreScope, status: string): SessionRecord {
    assertScope(scope)
    assertIdentifier(status, 'status')
    const result = this.#database
      .prepare(
        `UPDATE sessions SET status = ?, updated_at = ?
         WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?`,
      )
      .run(
        status,
        this.#timestamp(),
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
      )
    if (Number(result.changes) !== 1) throw new StoreNotFoundError()
    return this.getSession(scope)
  }

  updateSessionStatusWithAudit(
    scope: StoreScope,
    status: string,
    audit: AppendAuditInput,
  ): SessionRecord {
    assertScope(scope)
    assertIdentifier(status, 'status')
    const timestamp = this.#timestamp()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#database
        .prepare(
          `UPDATE sessions SET status = ?, updated_at = ?
           WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?`,
        )
        .run(
          status,
          timestamp,
          scope.tenantId,
          scope.workspaceId,
          scope.sessionId,
        )
      if (Number(result.changes) !== 1) throw new StoreNotFoundError()
      this.#insertAudit(audit, timestamp)
      this.#pruneAudit(timestamp)
      this.#beforeAtomicAuditCommit?.(audit.action)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    return this.getSession(scope)
  }

  updateSessionRecovery(
    scope: StoreScope,
    input: {
      status: 'active' | 'recovering' | 'recovery_required' | 'failed'
      recoveryErrorCode?: string | null
      runtimeGeneration?: number | null
      resumed?: boolean
    },
  ): SessionRecord {
    assertScope(scope)
    const timestamp = this.#timestamp()
    const result = this.#database
      .prepare(
        `UPDATE sessions SET status = ?, recovery_error_code = ?,
       runtime_generation = ?, last_resumed_at = CASE WHEN ? THEN ? ELSE last_resumed_at END,
       updated_at = ? WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?`,
      )
      .run(
        input.status,
        input.recoveryErrorCode ?? null,
        input.runtimeGeneration ?? null,
        input.resumed ? 1 : 0,
        timestamp,
        timestamp,
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
      )
    if (Number(result.changes) !== 1) throw new StoreNotFoundError()
    return this.getSession(scope)
  }

  updateSessionRecoveryWithAudit(
    scope: StoreScope,
    input: {
      status: 'active' | 'recovering' | 'recovery_required' | 'failed'
      recoveryErrorCode?: string | null
      runtimeGeneration?: number | null
      resumed?: boolean
    },
    audit: AppendAuditInput,
  ): SessionRecord {
    assertScope(scope)
    const timestamp = this.#timestamp()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#database
        .prepare(
          `UPDATE sessions SET status = ?, recovery_error_code = ?,
           runtime_generation = ?, last_resumed_at = CASE WHEN ? THEN ? ELSE last_resumed_at END,
           updated_at = ? WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?`,
        )
        .run(
          input.status,
          input.recoveryErrorCode ?? null,
          input.runtimeGeneration ?? null,
          input.resumed ? 1 : 0,
          timestamp,
          timestamp,
          scope.tenantId,
          scope.workspaceId,
          scope.sessionId,
        )
      if (Number(result.changes) !== 1) throw new StoreNotFoundError()
      this.#insertAudit(audit, timestamp)
      this.#pruneAudit(timestamp)
      this.#beforeAtomicAuditCommit?.(audit.action)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    return this.getSession(scope)
  }

  ingestRawOnly(input: IngestRawOnlyInput): void {
    assertScope(input)
    assertIdentifier(input.ingestKey, 'ingestKey')
    this.getSession(input)
    const hasInlineEnvelope = input.raw.envelope !== undefined
    const hasArtifactPointer = input.raw.artifactPointer !== undefined
    if (hasInlineEnvelope === hasArtifactPointer)
      throw new StoreError(
        'INVALID_RAW_STORAGE',
        'Raw event must use either inline JSON or an artifact pointer',
      )
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO raw_events (
        tenant_id, workspace_id, session_id, ingest_key, checksum,
        inline_json, artifact_pointer, source_method, source_version,
        source_metadata_json, received_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tenantId,
        input.workspaceId,
        input.sessionId,
        input.ingestKey,
        input.raw.checksum,
        hasInlineEnvelope ? JSON.stringify(input.raw.envelope) : null,
        input.raw.artifactPointer ?? null,
        input.raw.sourceMethod,
        input.raw.sourceVersion,
        JSON.stringify(input.raw.sourceMetadata ?? {}),
        input.raw.receivedAt,
        this.#timestamp(),
      )
  }

  ingest(input: IngestEventInput): IngestEventResult {
    assertScope(input)
    assertIdentifier(input.ingestKey, 'ingestKey')
    if (
      input.event.tenantId !== input.tenantId ||
      input.event.workspaceId !== input.workspaceId ||
      input.event.sessionId !== input.sessionId
    ) {
      throw new StoreError(
        'EVENT_SCOPE_MISMATCH',
        'Event identity does not match ingest scope',
      )
    }
    const hasInlineEnvelope = input.raw.envelope !== undefined
    const hasArtifactPointer = input.raw.artifactPointer !== undefined
    if (hasInlineEnvelope === hasArtifactPointer) {
      throw new StoreError(
        'INVALID_RAW_STORAGE',
        'Raw event must use either inline JSON or an artifact pointer',
      )
    }

    this.#database.exec('BEGIN IMMEDIATE')
    let committedEvent: TimelineEvent | undefined
    try {
      this.getSession(input)
      const duplicate = this.#database
        .prepare(
          `SELECT events.payload_json, raw_events.session_id, raw_events.checksum
           FROM raw_events
           JOIN events ON events.raw_event_id = raw_events.raw_event_id
           WHERE raw_events.tenant_id = ? AND raw_events.workspace_id = ?
             AND raw_events.ingest_key = ?`,
        )
        .get(input.tenantId, input.workspaceId, input.ingestKey) as unknown as
        DuplicateEventRow | undefined
      if (duplicate) {
        if (
          duplicate.session_id !== input.sessionId ||
          duplicate.checksum !== input.raw.checksum
        ) {
          throw new StoreConflictError(
            'INGEST_KEY_CONFLICT',
            'Ingest key is already bound to a different session or checksum',
          )
        }
        this.#database.exec('COMMIT')
        return {
          event: parseTimelineEvent(JSON.parse(duplicate.payload_json)),
          duplicate: true,
        }
      }

      const timestamp = this.#timestamp()
      this.#database
        .prepare(
          `INSERT INTO workspace_sequence (
            workspace_id, tenant_id, last_sequence, updated_at
          ) VALUES (?, ?, 0, ?)
          ON CONFLICT(workspace_id) DO NOTHING`,
        )
        .run(input.workspaceId, input.tenantId, timestamp)
      const sequenceRow = this.#database
        .prepare(
          `UPDATE workspace_sequence
           SET last_sequence = last_sequence + 1, updated_at = ?
           WHERE tenant_id = ? AND workspace_id = ?
           RETURNING last_sequence`,
        )
        .get(timestamp, input.tenantId, input.workspaceId) as unknown as
        SequenceRow | undefined
      if (!sequenceRow) {
        throw new StoreConflictError(
          'WORKSPACE_TENANT_CONFLICT',
          'Workspace sequence belongs to a different tenant',
        )
      }

      committedEvent = parseTimelineEvent({
        ...input.event,
        sequence: sequenceRow.last_sequence,
      })
      const inlineJson = hasInlineEnvelope
        ? JSON.stringify(input.raw.envelope)
        : null
      const rawResult = this.#database
        .prepare(
          `INSERT INTO raw_events (
            tenant_id, workspace_id, session_id, ingest_key, checksum,
            inline_json, artifact_pointer, source_method, source_version,
            source_metadata_json, received_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.workspaceId,
          input.sessionId,
          input.ingestKey,
          input.raw.checksum,
          inlineJson,
          input.raw.artifactPointer ?? null,
          input.raw.sourceMethod,
          input.raw.sourceVersion,
          JSON.stringify(input.raw.sourceMetadata ?? {}),
          input.raw.receivedAt,
          timestamp,
        )
      const rawEventId = Number(rawResult.lastInsertRowid)

      this.#database
        .prepare(
          `INSERT INTO events (
            event_id, tenant_id, workspace_id, session_id, sequence, type,
            source_method, source_version, payload_json, occurred_at,
            received_at, raw_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          committedEvent.eventId,
          committedEvent.tenantId,
          committedEvent.workspaceId,
          committedEvent.sessionId,
          committedEvent.sequence,
          committedEvent.type,
          committedEvent.sourceMethod,
          committedEvent.sourceVersion,
          JSON.stringify(committedEvent),
          committedEvent.occurredAt,
          committedEvent.receivedAt,
          rawEventId,
        )
      this.#database
        .prepare(
          `UPDATE sessions SET last_sequence = ?, updated_at = ?
           WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?`,
        )
        .run(
          committedEvent.sequence,
          timestamp,
          input.tenantId,
          input.workspaceId,
          input.sessionId,
        )
      if (input.approval) {
        const approval = input.approval
        this.#database
          .prepare(
            `INSERT OR IGNORE INTO approvals (
            approval_id, tenant_id, workspace_id, session_id, turn_id, item_id,
            request_id_json, runtime_instance_id, process_generation, kind, status,
            context_json, available_decisions_json, requested_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          )
          .run(
            approval.approvalId,
            approval.tenantId,
            approval.workspaceId,
            approval.sessionId,
            approval.turnId,
            approval.itemId,
            JSON.stringify(approval.requestId),
            approval.runtimeInstanceId,
            approval.processGeneration,
            approval.kind,
            JSON.stringify(approval.context),
            JSON.stringify(approval.availableDecisions),
            approval.requestedAt,
          )
        this.#insertAudit(
          {
            ...input,
            actor: 'runtime',
            action: 'approval.requested',
            outcome: 'requested',
            idempotencyKey: `event:${committedEvent.eventId}`,
            requestId: String(approval.requestId),
            metadata: {
              approvalKind:
                approval.kind === 'command_execution' ? 'command' : 'file',
            },
            occurredAt: committedEvent.occurredAt,
          },
          timestamp,
        )
      }
      if (committedEvent.type === 'turn.started')
        this.#insertAudit(
          {
            ...input,
            actor: 'runtime',
            action: 'turn.started',
            outcome: 'success',
            idempotencyKey: `turn:${committedEvent.codexTurnId ?? committedEvent.eventId}:started`,
            metadata: { status: committedEvent.payload.status },
            occurredAt: committedEvent.occurredAt,
          },
          timestamp,
        )
      if (committedEvent.type === 'turn.completed') {
        const failed = !['completed', 'success'].includes(
          committedEvent.payload.status,
        )
        this.#insertAudit(
          {
            ...input,
            actor: 'runtime',
            action: failed ? 'turn.failed' : 'turn.completed',
            outcome: failed ? 'failure' : 'success',
            idempotencyKey: `turn:${committedEvent.codexTurnId ?? committedEvent.eventId}:completed`,
            metadata: { turnOutcome: committedEvent.payload.status },
            occurredAt: committedEvent.occurredAt,
          },
          timestamp,
        )
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }

    for (const listener of this.#listeners) {
      try {
        listener(committedEvent)
      } catch {
        // Persistence succeeded; a realtime consumer cannot roll it back.
      }
    }
    if (input.approval) {
      const approval = this.getApproval(input, input.approval.approvalId)
      for (const listener of this.#approvalListeners) listener(approval)
    }
    return { event: committedEvent, duplicate: false }
  }

  findIngestedEvent(
    scope: StoreScope,
    ingestKey: string,
    checksum: string,
  ): TimelineEvent | undefined {
    assertScope(scope)
    const row = this.#database
      .prepare(
        `SELECT events.payload_json, raw_events.session_id, raw_events.checksum FROM raw_events JOIN events ON events.raw_event_id=raw_events.raw_event_id WHERE raw_events.tenant_id=? AND raw_events.workspace_id=? AND raw_events.ingest_key=?`,
      )
      .get(scope.tenantId, scope.workspaceId, ingestKey) as unknown as
      DuplicateEventRow | undefined
    if (!row) return undefined
    if (row.session_id !== scope.sessionId || row.checksum !== checksum)
      throw new StoreConflictError(
        'INGEST_KEY_CONFLICT',
        'Ingest key is already bound to a different session or checksum',
      )
    return parseTimelineEvent(JSON.parse(row.payload_json))
  }

  replaySessionEvents(
    scope: StoreScope,
    afterSequence = 0,
    limit = 100,
    throughSequence?: number,
  ): ReplayPage {
    assertScope(scope)
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new StoreError(
        'INVALID_CURSOR',
        'afterSequence must be a non-negative integer',
      )
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new StoreError(
        'INVALID_LIMIT',
        'limit must be an integer between 1 and 500',
      )
    }
    const session = this.getSession(scope)
    const highWaterSequence = throughSequence ?? session.lastSequence
    if (!Number.isInteger(highWaterSequence) || highWaterSequence < 0) {
      throw new StoreError(
        'INVALID_CURSOR',
        'throughSequence must be a non-negative integer',
      )
    }
    const rows = this.#database
      .prepare(
        `SELECT payload_json FROM events
         WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?
           AND sequence > ? AND sequence <= ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        afterSequence,
        highWaterSequence,
        limit + 1,
      ) as unknown as EventRow[]
    const hasMore = rows.length > limit
    const events = rows
      .slice(0, limit)
      .map((row) => parseTimelineEvent(JSON.parse(row.payload_json)))
    return {
      events,
      highWaterSequence,
      nextAfterSequence: events.at(-1)?.sequence ?? afterSequence,
      hasMore,
    }
  }

  hasTimelineEvent(
    scope: StoreScope,
    identity: {
      type: TimelineEvent['type']
      codexThreadId: string
      codexTurnId: string
      codexItemId?: string
    },
  ): boolean {
    assertScope(scope)
    const row = this.#database
      .prepare(
        `SELECT 1 FROM events WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?
         AND type = ? AND json_extract(payload_json, '$.codexThreadId') = ?
         AND json_extract(payload_json, '$.codexTurnId') = ?
         AND (? IS NULL OR json_extract(payload_json, '$.codexItemId') = ?)
         LIMIT 1`,
      )
      .get(
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        identity.type,
        identity.codexThreadId,
        identity.codexTurnId,
        identity.codexItemId ?? null,
        identity.codexItemId ?? null,
      )
    return Boolean(row)
  }

  hasEquivalentTimelineEvent(scope: StoreScope, event: TimelineEvent): boolean {
    assertScope(scope)
    if (!event.codexThreadId || !event.codexTurnId) return false
    const rows = this.#database
      .prepare(
        `SELECT payload_json FROM events WHERE tenant_id = ? AND workspace_id = ?
         AND session_id = ? AND type = ?
         AND json_extract(payload_json, '$.codexThreadId') = ?
         AND json_extract(payload_json, '$.codexTurnId') = ?`,
      )
      .all(
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        event.type,
        event.codexThreadId,
        event.codexTurnId,
      ) as unknown as EventRow[]
    return rows.some((row) => {
      const candidate = parseTimelineEvent(JSON.parse(row.payload_json))
      return (
        (event.codexItemId !== undefined &&
          candidate.codexItemId === event.codexItemId) ||
        JSON.stringify(candidate.payload) === JSON.stringify(event.payload)
      )
    })
  }

  getHighWaterSequence(scope: StoreScope): number {
    return this.getSession(scope).lastSequence
  }

  onCommitted(listener: CommitListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  onApprovalChanged(listener: ApprovalListener): () => void {
    this.#approvalListeners.add(listener)
    return () => this.#approvalListeners.delete(listener)
  }

  getApproval(
    scope: Pick<StoreScope, 'tenantId' | 'workspaceId'>,
    approvalId: string,
  ): ApprovalRecord {
    const row = this.#database
      .prepare(
        `SELECT * FROM approvals WHERE tenant_id = ? AND workspace_id = ? AND approval_id = ?`,
      )
      .get(scope.tenantId, scope.workspaceId, approvalId) as unknown as
      ApprovalRow | undefined
    if (!row)
      throw new StoreError(
        'APPROVAL_NOT_FOUND',
        'Approval not found in the requested scope',
      )
    return approvalFromRow(row)
  }

  findApprovalByRequest(
    input: Pick<StoreScope, 'tenantId' | 'workspaceId'> & {
      runtimeInstanceId: string
      processGeneration: number
      requestId: string | number
    },
  ): ApprovalRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM approvals WHERE tenant_id = ? AND workspace_id = ? AND runtime_instance_id = ? AND process_generation = ? AND request_id_json = ?`,
      )
      .get(
        input.tenantId,
        input.workspaceId,
        input.runtimeInstanceId,
        input.processGeneration,
        JSON.stringify(input.requestId),
      ) as unknown as ApprovalRow | undefined
    return row ? approvalFromRow(row) : undefined
  }

  findFileApprovalContext(
    input: StoreScope & { turnId: string; itemId: string },
  ): FileApprovalContext {
    const rows = this.#database
      .prepare(
        `SELECT payload_json FROM events
       WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?
         AND type IN ('file.change.proposed', 'file.change.completed', 'diff.updated')
       ORDER BY sequence DESC`,
      )
      .all(
        input.tenantId,
        input.workspaceId,
        input.sessionId,
      ) as unknown as EventRow[]
    let filePath: string | null = null
    let diff: string | null = null
    for (const row of rows) {
      const event = parseTimelineEvent(JSON.parse(row.payload_json))
      if (
        event.codexTurnId !== input.turnId ||
        event.codexItemId !== input.itemId
      )
        continue
      if (
        event.type === 'file.change.proposed' ||
        event.type === 'file.change.completed'
      ) {
        const change = event.payload.changes[0]
        filePath ??= change?.path ?? null
        diff ??= change?.diff || null
      } else if (event.type === 'diff.updated') {
        diff ??=
          'diff' in event.payload
            ? event.payload.diff || null
            : event.payload.changes
                .map((change) => change.diff)
                .filter(Boolean)
                .join('\n') || null
        filePath ??=
          'changes' in event.payload
            ? (event.payload.changes[0]?.path ?? null)
            : null
      }
      if (filePath && diff) break
    }
    return { filePath, diff, diffAvailable: diff !== null }
  }

  listApprovals(
    scope: Pick<StoreScope, 'tenantId' | 'workspaceId'>,
    status?: ApprovalStatus,
  ): ApprovalRecord[] {
    const rows = (status
      ? this.#database
          .prepare(
            `SELECT * FROM approvals WHERE tenant_id = ? AND workspace_id = ? AND status = ? ORDER BY requested_at`,
          )
          .all(scope.tenantId, scope.workspaceId, status)
      : this.#database
          .prepare(
            `SELECT * FROM approvals WHERE tenant_id = ? AND workspace_id = ? ORDER BY requested_at`,
          )
          .all(scope.tenantId, scope.workspaceId)) as unknown as ApprovalRow[]
    return rows.map(approvalFromRow)
  }

  beginApprovalResolution(
    input: Pick<StoreScope, 'tenantId' | 'workspaceId'> & {
      approvalId: string
      expectedVersion: number
      decision: ApprovalDecision
      userId: string
    },
  ): ApprovalRecord {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.getApproval(input, input.approvalId)
      if (current.status !== 'pending')
        throw new StoreConflictError(
          'APPROVAL_ALREADY_RESOLVED',
          'Approval is no longer pending',
        )
      if (current.version !== input.expectedVersion)
        throw new StoreConflictError(
          'APPROVAL_VERSION_CONFLICT',
          'Approval version is stale',
        )
      const result = this.#database
        .prepare(
          `UPDATE approvals SET status = 'resolving', selected_decision = ?, resolving_user_id = ?, version = version + 1
         WHERE tenant_id = ? AND workspace_id = ? AND approval_id = ? AND status = 'pending' AND version = ?`,
        )
        .run(
          input.decision,
          input.userId,
          input.tenantId,
          input.workspaceId,
          input.approvalId,
          input.expectedVersion,
        )
      if (Number(result.changes) !== 1)
        throw new StoreConflictError(
          'APPROVAL_ALREADY_RESOLVED',
          'Approval was resolved concurrently',
        )
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    const record = this.getApproval(input, input.approvalId)
    for (const listener of this.#approvalListeners) listener(record)
    return record
  }

  finishApproval(
    input: Pick<StoreScope, 'tenantId' | 'workspaceId'> & {
      approvalId: string
      status?: 'resolved' | 'expired' | 'superseded'
      upstreamResponseStatus: ApprovalRecord['upstreamResponseStatus']
    },
  ): ApprovalRecord {
    const status = input.status ?? 'resolved'
    const result = this.#database
      .prepare(
        `UPDATE approvals SET status = ?, upstream_response_status = ?, resolved_at = ?, version = version + 1
       WHERE tenant_id = ? AND workspace_id = ? AND approval_id = ? AND status IN ('pending','resolving','resolved')`,
      )
      .run(
        status,
        input.upstreamResponseStatus,
        this.#timestamp(),
        input.tenantId,
        input.workspaceId,
        input.approvalId,
      )
    if (Number(result.changes) !== 1)
      return this.getApproval(input, input.approvalId)
    const record = this.getApproval(input, input.approvalId)
    for (const listener of this.#approvalListeners) listener(record)
    return record
  }

  finishApprovalWithAudit(
    input: Pick<StoreScope, 'tenantId' | 'workspaceId'> & {
      approvalId: string
      upstreamResponseStatus: ApprovalRecord['upstreamResponseStatus']
    },
    audit: AppendAuditInput,
  ): ApprovalRecord {
    const timestamp = this.#timestamp()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#database
        .prepare(
          `UPDATE approvals SET status = 'resolved', upstream_response_status = ?,
           resolved_at = ?, version = version + 1
           WHERE tenant_id = ? AND workspace_id = ? AND approval_id = ?
             AND status = 'resolving'`,
        )
        .run(
          input.upstreamResponseStatus,
          timestamp,
          input.tenantId,
          input.workspaceId,
          input.approvalId,
        )
      if (Number(result.changes) !== 1)
        throw new StoreConflictError(
          'APPROVAL_ALREADY_RESOLVED',
          'Approval was resolved concurrently',
        )
      this.#insertAudit(audit, timestamp)
      this.#pruneAudit(timestamp)
      this.#beforeAtomicAuditCommit?.(audit.action)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    const record = this.getApproval(input, input.approvalId)
    for (const listener of this.#approvalListeners) listener(record)
    return record
  }

  expireApprovals(
    scope: StoreScope,
    status: 'expired' | 'superseded' = 'expired',
  ): ApprovalRecord[] {
    const pending = this.listApprovals(scope, 'pending').filter(
      (item) => item.sessionId === scope.sessionId,
    )
    return pending.map((item) =>
      this.finishApproval({
        ...scope,
        approvalId: item.approvalId,
        status,
        upstreamResponseStatus: 'unknown',
      }),
    )
  }

  expireRuntimeApprovals(
    input: Pick<StoreScope, 'tenantId' | 'workspaceId'> & {
      runtimeInstanceId: string
      currentProcessGeneration?: number
    },
  ): ApprovalRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM approvals WHERE tenant_id = ? AND workspace_id = ?
       AND runtime_instance_id = ? AND status IN ('pending','resolving')
       ${input.currentProcessGeneration === undefined ? '' : 'AND process_generation <> ?'}`,
      )
      .all(
        input.tenantId,
        input.workspaceId,
        input.runtimeInstanceId,
        ...(input.currentProcessGeneration === undefined
          ? []
          : [input.currentProcessGeneration]),
      ) as unknown as ApprovalRow[]
    return rows.map(approvalFromRow).map((approval) =>
      this.finishApproval({
        ...input,
        approvalId: approval.approvalId,
        status: 'expired',
        upstreamResponseStatus: 'unknown',
      }),
    )
  }

  getRecordCounts(scope: StoreScope): {
    rawEvents: number
    events: number
    workspaceSequence: number
  } {
    assertScope(scope)
    const counts = this.#database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM raw_events WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?) AS raw_events,
          (SELECT COUNT(*) FROM events WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?) AS events,
          COALESCE((SELECT last_sequence FROM workspace_sequence WHERE tenant_id = ? AND workspace_id = ?), 0) AS workspace_sequence`,
      )
      .get(
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        scope.tenantId,
        scope.workspaceId,
      ) as unknown as {
      raw_events: number
      events: number
      workspace_sequence: number
    }
    return {
      rawEvents: counts.raw_events,
      events: counts.events,
      workspaceSequence: counts.workspace_sequence,
    }
  }

  getRawInlineJson(scope: StoreScope, ingestKey: string): string | null {
    assertScope(scope)
    const row = this.#database
      .prepare(
        `SELECT inline_json FROM raw_events
         WHERE tenant_id = ? AND workspace_id = ? AND session_id = ? AND ingest_key = ?`,
      )
      .get(
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        ingestKey,
      ) as unknown as { inline_json: string | null } | undefined
    if (!row)
      throw new StoreNotFoundError('Raw event not found in the requested scope')
    return row.inline_json
  }

  reserveIdempotencyKey(input: {
    tenantId: string
    workspaceId: string
    sessionId?: string
    scope: string
    key: string
    requestHash: string
  }): { record: IdempotencyRecord; created: boolean } {
    assertIdentifier(input.tenantId, 'tenantId')
    assertIdentifier(input.workspaceId, 'workspaceId')
    assertIdentifier(input.scope, 'scope')
    assertIdentifier(input.key, 'key')
    assertIdentifier(input.requestHash, 'requestHash')
    const timestamp = this.#timestamp()
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO idempotency_keys (
          tenant_id, workspace_id, session_id, scope, key, request_hash,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.tenantId,
        input.workspaceId,
        input.sessionId ?? null,
        input.scope,
        input.key,
        input.requestHash,
        timestamp,
        timestamp,
      )
    const record = this.getIdempotencyKey(input)
    if (record.requestHash !== input.requestHash) {
      throw new StoreConflictError(
        'IDEMPOTENCY_HASH_CONFLICT',
        'Idempotency key was already used with a different request hash',
      )
    }
    return { record, created: Number(result.changes) === 1 }
  }

  getIdempotencyKey(input: {
    tenantId: string
    workspaceId: string
    scope: string
    key: string
  }): IdempotencyRecord {
    const row = this.#database
      .prepare(
        `SELECT * FROM idempotency_keys
         WHERE tenant_id = ? AND workspace_id = ? AND scope = ? AND key = ?`,
      )
      .get(
        input.tenantId,
        input.workspaceId,
        input.scope,
        input.key,
      ) as unknown as IdempotencyRow | undefined
    if (!row)
      throw new StoreError(
        'IDEMPOTENCY_KEY_NOT_FOUND',
        'Idempotency key not found',
      )
    return idempotencyFromRow(row)
  }

  completeIdempotencyKey(input: {
    tenantId: string
    workspaceId: string
    scope: string
    key: string
    status: 'completed' | 'failed' | 'outcome_unknown'
    response: unknown
  }): IdempotencyRecord {
    const result = this.#database
      .prepare(
        `UPDATE idempotency_keys
         SET status = ?, response_json = ?, updated_at = ?
         WHERE tenant_id = ? AND workspace_id = ? AND scope = ? AND key = ?
           AND status = 'pending'`,
      )
      .run(
        input.status,
        JSON.stringify(input.response),
        this.#timestamp(),
        input.tenantId,
        input.workspaceId,
        input.scope,
        input.key,
      )
    if (Number(result.changes) !== 1) {
      const existing = this.getIdempotencyKey(input)
      if (
        existing.status === input.status &&
        JSON.stringify(existing.response) === JSON.stringify(input.response)
      ) {
        return existing
      }
      throw new StoreConflictError(
        'IDEMPOTENCY_STATE_CONFLICT',
        'Idempotency key is no longer pending',
      )
    }
    return this.getIdempotencyKey(input)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#listeners.clear()
    this.#approvalListeners.clear()
    this.#database.close()
  }
}

export { CURRENT_SCHEMA_VERSION } from './schema'
