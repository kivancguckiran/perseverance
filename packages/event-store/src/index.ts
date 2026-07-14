import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  parseTimelineEvent,
  type TimelineEvent,
} from '@persistent-codex/domain-events'
import { bootstrapSchema } from './schema'

export interface StoreScope {
  tenantId: string
  workspaceId: string
  sessionId: string
}
export interface ArtifactRecord extends StoreScope {
  artifactId: string
  turnId: string
  itemId: string
  kind: 'command-output'
  byteLength: number
  sha256: string | null
  chunkCount: number
  finalized: boolean
  status: 'writing' | 'finalized' | 'recovery_required'
  createdAt: string
  finalizedAt: string | null
}

export interface SessionRecord extends StoreScope {
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
  codex_thread_id: string | null
  status: string
  recovery_error_code: string | null
  last_resumed_at: string | null
  runtime_generation: number | null
  last_sequence: number
  created_at: string
  updated_at: string
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

export class SqliteEventStore {
  readonly #database: DatabaseSync
  readonly #listeners = new Set<CommitListener>()
  readonly #approvalListeners = new Set<ApprovalListener>()
  readonly #now: () => Date
  #closed = false

  constructor(path = ':memory:', options: { now?: () => Date } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#now = options.now ?? (() => new Date())
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

  createSession(input: CreateSessionInput): SessionRecord {
    assertScope(input)
    const status = input.status ?? 'active'
    assertIdentifier(status, 'status')
    const timestamp = this.#timestamp()
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO sessions (
          tenant_id, workspace_id, session_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tenantId,
        input.workspaceId,
        input.sessionId,
        status,
        timestamp,
        timestamp,
      )
    return this.getSession(input)
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
