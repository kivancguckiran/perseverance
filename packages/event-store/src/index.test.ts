import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ingestRawCodexEnvelope } from '@persistent-codex/codex-event-adapter'
import type { TimelineEvent } from '@persistent-codex/domain-events'
import { describe, expect, it } from 'vitest'
import {
  SqliteEventStore,
  StoreConflictError,
  StoreNotFoundError,
  type IngestEventInput,
  type StoreScope,
} from './index'

const scope: StoreScope = {
  tenantId: 'ten_test',
  workspaceId: 'wsp_test',
  sessionId: 'ses_test',
}

function event(eventId: string, text = eventId): TimelineEvent {
  return {
    eventId,
    schemaVersion: 1,
    ...scope,
    sequence: 0,
    occurredAt: '2026-07-14T00:00:00.000Z',
    receivedAt: '2026-07-14T00:00:00.001Z',
    source: 'codex-app-server',
    sourceVersion: '0.144.2',
    sourceMethod: 'item/agentMessage/delta',
    type: 'agent.message.delta',
    visibility: 'user',
    payload: { text },
  }
}

function ingestInput(
  ingestKey: string,
  eventId = `evt_${ingestKey}`,
  overrides: Partial<IngestEventInput> = {},
): IngestEventInput {
  return {
    ...scope,
    ingestKey,
    raw: {
      envelope: {
        method: 'item/agentMessage/delta',
        params: { delta: ingestKey },
      },
      checksum: `checksum-${ingestKey}`,
      sourceMethod: 'item/agentMessage/delta',
      sourceVersion: '0.144.2',
      receivedAt: '2026-07-14T00:00:00.001Z',
    },
    event: event(eventId),
    ...overrides,
  }
}

function withStore(run: (store: SqliteEventStore) => void): void {
  const store = new SqliteEventStore()
  store.createSession(scope)
  try {
    run(store)
  } finally {
    store.close()
  }
}

describe('SqliteEventStore sessions', () => {
  it('creates, reads, and conflict-safely binds a Codex thread', () => {
    withStore((store) => {
      expect(store.getSession(scope)).toMatchObject({
        ...scope,
        codexThreadId: null,
        lastSequence: 0,
      })
      expect(store.bindCodexThread(scope, 'thr_1').codexThreadId).toBe('thr_1')
      expect(store.bindCodexThread(scope, 'thr_1').codexThreadId).toBe('thr_1')
      expect(() => store.bindCodexThread(scope, 'thr_2')).toThrow(
        StoreConflictError,
      )
    })
  })

  it('keeps tenant, workspace, and session lookups isolated', () => {
    withStore((store) => {
      expect(() =>
        store.getSession({ ...scope, tenantId: 'ten_other' }),
      ).toThrow(StoreNotFoundError)
      expect(() =>
        store.replaySessionEvents({ ...scope, workspaceId: 'wsp_other' }),
      ).toThrow(StoreNotFoundError)
      expect(() =>
        store.getSession({ ...scope, sessionId: 'ses_other' }),
      ).toThrow(StoreNotFoundError)
    })
  })
})

describe('SqliteEventStore atomic ingest', () => {
  it('persists an approval atomically and enforces optimistic locking', () => {
    withStore((store) => {
      const input = ingestInput('approval', 'evt_approval', {
        approval: {
          ...scope,
          approvalId: 'apr_1',
          turnId: 'turn_1',
          itemId: 'item_1',
          requestId: 7,
          runtimeInstanceId: 'runtime_1',
          processGeneration: 1,
          kind: 'command_execution',
          context: { command: 'echo safe', token: '[REDACTED]' },
          availableDecisions: [
            'accept',
            'accept_for_session',
            'decline',
            'cancel',
          ],
          requestedAt: '2026-07-14T00:00:00.000Z',
        },
      })
      store.ingest(input)
      expect(store.getApproval(scope, 'apr_1')).toMatchObject({
        status: 'pending',
        version: 1,
        requestId: 7,
      })
      expect(store.ingest(input).duplicate).toBe(true)
      expect(store.listApprovals(scope, 'pending')).toHaveLength(1)
      const winner = store.beginApprovalResolution({
        ...scope,
        approvalId: 'apr_1',
        expectedVersion: 1,
        decision: 'decline',
        userId: 'user_1',
      })
      expect(winner).toMatchObject({
        status: 'resolving',
        version: 2,
        selectedDecision: 'decline',
      })
      expect(() =>
        store.beginApprovalResolution({
          ...scope,
          approvalId: 'apr_1',
          expectedVersion: 1,
          decision: 'accept',
          userId: 'user_2',
        }),
      ).toThrowError(
        expect.objectContaining({ code: 'APPROVAL_ALREADY_RESOLVED' }),
      )
      expect(
        store.finishApproval({
          ...scope,
          approvalId: 'apr_1',
          upstreamResponseStatus: 'sent',
        }),
      ).toMatchObject({ status: 'resolved', version: 3 })
      expect(() =>
        store.getApproval({ ...scope, tenantId: 'other' }, 'apr_1'),
      ).toThrowError(expect.objectContaining({ code: 'APPROVAL_NOT_FOUND' }))
    })
  })

  it('allocates unique monotonic workspace sequences across connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'event-store-concurrency-'))
    const path = join(directory, 'events.sqlite')
    const first = new SqliteEventStore(path)
    first.createSession(scope)
    const second = new SqliteEventStore(path)
    try {
      const results = await Promise.all([
        Promise.resolve().then(() => first.ingest(ingestInput('one'))),
        Promise.resolve().then(() => second.ingest(ingestInput('two'))),
        Promise.resolve().then(() => first.ingest(ingestInput('three'))),
        Promise.resolve().then(() => second.ingest(ingestInput('four'))),
      ])
      expect(results.map((result) => result.event.sequence).sort()).toEqual([
        1, 2, 3, 4,
      ])
      expect(first.getRecordCounts(scope)).toEqual({
        rawEvents: 4,
        events: 4,
        workspaceSequence: 4,
      })
    } finally {
      first.close()
      second.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('returns the prior result for duplicate ingest without allocating sequence', () => {
    withStore((store) => {
      const first = store.ingest(ingestInput('same'))
      const duplicate = store.ingest(
        ingestInput('same', 'evt_would_not_be_inserted'),
      )
      expect(first).toMatchObject({ duplicate: false, event: { sequence: 1 } })
      expect(duplicate).toEqual({ ...first, duplicate: true })
      expect(store.getRecordCounts(scope)).toEqual({
        rawEvents: 1,
        events: 1,
        workspaceSequence: 1,
      })
    })
  })

  it('rejects ingest-key reuse across sessions or checksums without allocating state', () => {
    withStore((store) => {
      const otherScope = { ...scope, sessionId: 'ses_other' }
      store.createSession(otherScope)
      store.ingest(ingestInput('collision'))

      const checksumConflict = ingestInput('collision', 'evt_checksum_conflict')
      checksumConflict.raw = {
        ...checksumConflict.raw,
        checksum: 'different-checksum',
      }
      expect(() => store.ingest(checksumConflict)).toThrowError(
        expect.objectContaining({ code: 'INGEST_KEY_CONFLICT' }),
      )

      const sessionConflict = ingestInput('collision', 'evt_session_conflict')
      sessionConflict.sessionId = otherScope.sessionId
      sessionConflict.event = {
        ...sessionConflict.event,
        sessionId: otherScope.sessionId,
      }
      expect(() => store.ingest(sessionConflict)).toThrowError(
        expect.objectContaining({ code: 'INGEST_KEY_CONFLICT' }),
      )

      expect(store.getRecordCounts(scope)).toEqual({
        rawEvents: 1,
        events: 1,
        workspaceSequence: 1,
      })
      expect(store.getRecordCounts(otherScope)).toEqual({
        rawEvents: 0,
        events: 0,
        workspaceSequence: 1,
      })
    })
  })

  it('does not use checksum as a deduplication key', () => {
    withStore((store) => {
      const first = ingestInput('first')
      const second = ingestInput('second')
      second.raw = structuredClone(first.raw)
      store.ingest(first)
      store.ingest(second)
      expect(store.getRecordCounts(scope)).toMatchObject({
        rawEvents: 2,
        events: 2,
        workspaceSequence: 2,
      })
    })
  })

  it('rolls sequence, raw event, and normalized event back on failure', () => {
    withStore((store) => {
      store.ingest(ingestInput('first', 'evt_fixed'))
      expect(() => store.ingest(ingestInput('failing', 'evt_fixed'))).toThrow()
      expect(store.getRecordCounts(scope)).toEqual({
        rawEvents: 1,
        events: 1,
        workspaceSequence: 1,
      })
      expect(store.ingest(ingestInput('after')).event.sequence).toBe(2)
    })
  })

  it('publishes only after commit and never publishes duplicate ingest', () => {
    withStore((store) => {
      const published: number[] = []
      store.onCommitted((committed) => published.push(committed.sequence))
      store.ingest(ingestInput('first'))
      store.ingest(ingestInput('first'))
      expect(published).toEqual([1])
    })
  })

  it('persists only the WP2-redacted envelope', () => {
    withStore((store) => {
      const secret = 'sk-secret-value-123456789'
      const redacted = ingestRawCodexEnvelope({
        method: 'item/agentMessage/delta',
        params: { authorization: `Bearer ${secret}`, delta: 'safe' },
      })
      store.ingest({
        ...ingestInput('redacted'),
        raw: {
          ...redacted,
          sourceMethod: 'item/agentMessage/delta',
          sourceVersion: '0.144.2',
          receivedAt: '2026-07-14T00:00:00.001Z',
        },
      })
      const persisted = store.getRawInlineJson(scope, 'redacted') ?? ''
      expect(persisted).toContain('[REDACTED]')
      expect(persisted).not.toContain(secret)
    })
  })
})

describe('SqliteEventStore replay and durability', () => {
  it('returns ordered, limited, complete replay pages', () => {
    withStore((store) => {
      for (let index = 1; index <= 5; index += 1) {
        store.ingest(ingestInput(String(index)))
      }
      const first = store.replaySessionEvents(scope, 1, 2)
      expect(first.events.map(({ sequence }) => sequence)).toEqual([2, 3])
      expect(first).toMatchObject({
        highWaterSequence: 5,
        nextAfterSequence: 3,
        hasMore: true,
      })
      const second = store.replaySessionEvents(
        scope,
        first.nextAfterSequence,
        2,
      )
      expect(second.events.map(({ sequence }) => sequence)).toEqual([4, 5])
      expect(second.hasMore).toBe(false)
    })
  })

  it('retains sessions, binding, raw events, and events after reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'event-store-durable-'))
    const path = join(directory, 'events.sqlite')
    const first = new SqliteEventStore(path)
    first.createSession(scope)
    first.bindCodexThread(scope, 'thr_durable')
    first.ingest(ingestInput('durable'))
    first.close()

    const reopened = new SqliteEventStore(path)
    try {
      expect(reopened.getSession(scope)).toMatchObject({
        codexThreadId: 'thr_durable',
        lastSequence: 1,
      })
      expect(reopened.replaySessionEvents(scope).events).toHaveLength(1)
      expect(reopened.getRawInlineJson(scope, 'durable')).not.toBeNull()
    } finally {
      reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('bootstraps the WP2 events table without data loss', () => {
    const directory = mkdtempSync(join(tmpdir(), 'event-store-migration-'))
    const path = join(directory, 'events.sqlite')
    const legacy = new DatabaseSync(path)
    const legacyEvent = { ...event('evt_legacy'), sequence: 7 }
    legacy.exec(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE(workspace_id, sequence)
      );
    `)
    legacy
      .prepare(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        legacyEvent.eventId,
        legacyEvent.workspaceId,
        legacyEvent.sessionId,
        legacyEvent.sequence,
        legacyEvent.type,
        JSON.stringify(legacyEvent),
        legacyEvent.occurredAt,
      )
    legacy.close()

    const migrated = new SqliteEventStore(path)
    try {
      expect(migrated.getSession(scope).lastSequence).toBe(7)
      expect(migrated.replaySessionEvents(scope).events).toEqual([legacyEvent])
    } finally {
      migrated.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('migrates schema v2 sessions to v3 without losing bindings or cursors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'event-store-v2-v3-'))
    const path = join(directory, 'events.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE sessions (
        tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL, codex_thread_id TEXT,
        status TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, session_id)
      );
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      PRAGMA user_version = 2;
    `)
    legacy
      .prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        'thr_v2',
        'active',
        9,
        '2026-07-14T00:00:00.000Z',
        '2026-07-14T00:00:01.000Z',
      )
    legacy.close()
    const migrated = new SqliteEventStore(path)
    try {
      expect(migrated.getSession(scope)).toMatchObject({
        codexThreadId: 'thr_v2',
        lastSequence: 9,
        recoveryErrorCode: null,
        lastResumedAt: null,
        runtimeGeneration: null,
      })
      const database = new DatabaseSync(path)
      expect(database.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 3,
      })
      database.close()
    } finally {
      migrated.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('SqliteEventStore idempotency keys', () => {
  it('reserves, reuses, hash-checks, and completes keys', () => {
    withStore((store) => {
      const input = {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        scope: 'turn-start',
        key: 'idem_1',
        requestHash: 'hash_1',
      }
      expect(store.reserveIdempotencyKey(input).created).toBe(true)
      expect(store.reserveIdempotencyKey(input).created).toBe(false)
      expect(() =>
        store.reserveIdempotencyKey({ ...input, requestHash: 'hash_2' }),
      ).toThrow(StoreConflictError)
      expect(
        store.completeIdempotencyKey({
          ...input,
          status: 'completed',
          response: { turnId: 'turn_1' },
        }),
      ).toMatchObject({ status: 'completed', response: { turnId: 'turn_1' } })
    })
  })

  it('marks pending turn/resume/interrupt outcomes unknown after reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'event-store-idem-crash-'))
    const path = join(directory, 'events.sqlite')
    const first = new SqliteEventStore(path)
    first.createSession(scope)
    for (const actionScope of [
      'turn:ses_1',
      'resume:ses_1',
      'interrupt:ses_1:turn_1',
    ]) {
      first.reserveIdempotencyKey({
        ...scope,
        scope: actionScope,
        key: 'crash-key',
        requestHash: actionScope,
      })
    }
    first.close()
    const reopened = new SqliteEventStore(path)
    try {
      for (const actionScope of [
        'turn:ses_1',
        'resume:ses_1',
        'interrupt:ses_1:turn_1',
      ]) {
        expect(
          reopened.getIdempotencyKey({
            ...scope,
            scope: actionScope,
            key: 'crash-key',
          }),
        ).toMatchObject({
          status: 'outcome_unknown',
          response: { code: 'RECOVERY_OUTCOME_UNKNOWN' },
        })
      }
    } finally {
      reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
