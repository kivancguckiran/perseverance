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

export interface SessionRecord extends StoreScope {
  codexThreadId: string | null
  status: string
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

type CommitListener = (event: TimelineEvent) => void

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

export class SqliteEventStore {
  readonly #database: DatabaseSync
  readonly #listeners = new Set<CommitListener>()
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
    return { event: committedEvent, duplicate: false }
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

  getHighWaterSequence(scope: StoreScope): number {
    return this.getSession(scope).lastSequence
  }

  onCommitted(listener: CommitListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
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
    status: 'completed' | 'failed'
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
    this.#database.close()
  }
}

export { CURRENT_SCHEMA_VERSION } from './schema'
