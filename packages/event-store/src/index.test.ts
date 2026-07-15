import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { once } from 'node:events'
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

  it('persists scoped conversation folders and organization metadata', () => {
    withStore((store) => {
      const folder = store.createConversationFolder({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        folderId: 'fol_product',
        name: 'Product',
      })
      expect(store.listConversationFolders(scope)).toEqual([folder])
      expect(
        store.updateConversation(scope, {
          folderId: folder.folderId,
          title: 'Folder destekli chat',
        }),
      ).toMatchObject({
        folderId: 'fol_product',
        title: 'Folder destekli chat',
      })
      expect(
        store.listConversationFolders({
          tenantId: 'ten_other',
          workspaceId: scope.workspaceId,
        }),
      ).toEqual([])
      expect(
        store.setConversationFolderArchived(
          {
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            folderId: folder.folderId,
          },
          true,
        ).archivedAt,
      ).not.toBeNull()
      store.deleteConversationFolder({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        folderId: folder.folderId,
      })
      expect(store.listConversationFolders(scope)).toEqual([])
      expect(store.getSession(scope).folderId).toBeNull()
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
      expect(
        store
          .listAudit(scope)
          .records.filter((record) => record.action === 'approval.requested'),
      ).toHaveLength(1)
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
        store.finishApprovalWithAudit(
          {
            ...scope,
            approvalId: 'apr_1',
            upstreamResponseStatus: 'sent',
          },
          {
            ...scope,
            actor: 'user',
            action: 'approval.decided',
            outcome: 'success',
            idempotencyKey: 'approval:apr_1:resolved',
            metadata: {
              approvalKind: 'command_execution',
              decision: 'decline',
            },
          },
        ),
      ).toMatchObject({ status: 'resolved', version: 3 })
      expect(
        store
          .listAudit(scope)
          .records.filter((record) => record.action === 'approval.decided'),
      ).toHaveLength(1)
      expect(() =>
        store.getApproval({ ...scope, tenantId: 'other' }, 'apr_1'),
      ).toThrowError(expect.objectContaining({ code: 'APPROVAL_NOT_FOUND' }))
    })
  })

  it('rolls back approval resolution and audit together on injected failure', () => {
    const store = new SqliteEventStore(':memory:', {
      beforeAtomicAuditCommit: (action) => {
        if (action === 'approval.decided') throw new Error('injected crash')
      },
    })
    store.createSession(scope)
    store.ingest(
      ingestInput('approval-crash', 'evt_approval_crash', {
        approval: {
          ...scope,
          approvalId: 'apr_crash',
          turnId: 'turn_crash',
          itemId: 'item_crash',
          requestId: 8,
          runtimeInstanceId: 'runtime_1',
          processGeneration: 1,
          kind: 'file_change',
          context: {},
          availableDecisions: ['accept', 'decline'],
          requestedAt: '2026-07-14T00:00:00.000Z',
        },
      }),
    )
    store.beginApprovalResolution({
      ...scope,
      approvalId: 'apr_crash',
      expectedVersion: 1,
      decision: 'accept',
      userId: 'user_1',
    })
    expect(() =>
      store.finishApprovalWithAudit(
        {
          ...scope,
          approvalId: 'apr_crash',
          upstreamResponseStatus: 'sent',
        },
        {
          ...scope,
          actor: 'user',
          action: 'approval.decided',
          outcome: 'success',
          idempotencyKey: 'approval:apr_crash:resolved',
          metadata: { approvalKind: 'file_change', decision: 'accept' },
        },
      ),
    ).toThrow('injected crash')
    expect(store.getApproval(scope, 'apr_crash')).toMatchObject({
      status: 'resolving',
      version: 2,
    })
    expect(
      store
        .listAudit(scope)
        .records.filter((record) => record.action === 'approval.decided'),
    ).toHaveLength(0)
    store.close()
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
  it('persists scoped artifact metadata across reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'artifact-db-'))
    const path = join(directory, 'events.sqlite')
    const artifactScope = {
      tenantId: 'ten_a',
      workspaceId: 'wsp_a',
      sessionId: 'ses_a',
    }
    let store = new SqliteEventStore(path)
    store.createSession(artifactScope)
    store.upsertArtifact({
      ...artifactScope,
      artifactId: 'art_a',
      turnId: 'turn_a',
      itemId: 'item_a',
      kind: 'command-output',
      byteLength: 12,
      sha256: null,
      chunkCount: 1,
      finalized: false,
      status: 'writing',
      createdAt: '2026-07-14T00:00:00.000Z',
      finalizedAt: null,
    })
    store.close()
    store = new SqliteEventStore(path)
    expect(
      store.getArtifact({ tenantId: 'ten_a', workspaceId: 'wsp_a' }, 'art_a'),
    ).toMatchObject({ status: 'writing', byteLength: 12 })
    expect(() =>
      store.getArtifact({ tenantId: 'ten_b', workspaceId: 'wsp_a' }, 'art_a'),
    ).toThrow('Artifact not found')
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
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
        user_version: 9,
      })
      database.close()
    } finally {
      migrated.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('WP10 sessions and Git snapshot persistence', () => {
  it('paginates recent sessions with tenant/workspace isolation', () => {
    withStore((store) => {
      store.createSession({ ...scope, sessionId: 'ses_2' })
      store.createSession({ ...scope, sessionId: 'ses_3' })
      store.createSession({
        ...scope,
        tenantId: 'ten_other',
        sessionId: 'hidden',
      })
      const first = store.listRecentSessions(
        { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
        2,
      )
      expect(first.sessions).toHaveLength(2)
      expect(first.hasMore).toBe(true)
      const last = first.sessions.at(-1)!
      const second = store.listRecentSessions(
        { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
        2,
        { updatedAt: last.updatedAt, sessionId: last.sessionId },
      )
      expect(second.sessions).toHaveLength(1)
      expect(
        [...first.sessions, ...second.sessions].every(
          (item) => item.tenantId === scope.tenantId,
        ),
      ).toBe(true)
    })
  })

  it('keeps idempotent scoped Git snapshots after reload', () => {
    const directory = mkdtempSync(join(tmpdir(), 'event-store-git-'))
    const path = join(directory, 'events.sqlite')
    const first = new SqliteEventStore(path)
    first.createSession(scope)
    const input = {
      ...scope,
      snapshotId: 'git_1',
      turnId: 'turn_1',
      phase: 'before' as const,
      repositoryKind: 'repository' as const,
      branch: 'main',
      headOid: 'a'.repeat(40),
      detached: false,
      clean: false,
      changes: [],
      diff: {
        preview: 'diff',
        byteLength: 4,
        truncated: false,
        artifactId: null,
      },
      log: [],
      eventChangeCount: 0,
      relationship: 'authoritative' as const,
      capturedAt: '2026-07-14T12:00:00.000Z',
      idempotencyKey: 'turn:turn_1:before',
    }
    expect(first.putGitSnapshot(input).snapshotId).toBe('git_1')
    expect(
      first.putGitSnapshot({ ...input, snapshotId: 'git_duplicate' })
        .snapshotId,
    ).toBe('git_1')
    first.close()
    const reopened = new SqliteEventStore(path)
    try {
      expect(reopened.listGitSnapshots(scope)).toEqual([
        expect.objectContaining({ snapshotId: 'git_1', turnId: 'turn_1' }),
      ])
      expect(
        reopened.listGitSnapshots({ ...scope, tenantId: 'ten_other' }),
      ).toEqual([])
    } finally {
      reopened.close()
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

describe('WP11 durable audit', () => {
  const audit = (key: string, overrides = {}) => ({
    ...scope,
    actor: 'system' as const,
    action: 'session.lifecycle_changed' as const,
    outcome: 'success' as const,
    idempotencyKey: key,
    metadata: { fromState: 'starting', toState: 'active' },
    ...overrides,
  })

  it('rolls back session lifecycle state when its audit cannot commit', () => {
    const store = new SqliteEventStore(':memory:', {
      beforeAtomicAuditCommit: (action) => {
        if (action === 'session.lifecycle_changed')
          throw new Error('injected lifecycle failure')
      },
    })
    store.createSession(scope)
    expect(() =>
      store.updateSessionStatusWithAudit(
        scope,
        'failed',
        audit('lifecycle-failure'),
      ),
    ).toThrow('injected lifecycle failure')
    expect(store.getSession(scope).status).toBe('active')
    expect(store.listAudit(scope).records).toHaveLength(0)
    store.close()
  })

  it('is idempotent, scoped, cursor-paginated, and rejects unsafe metadata', () => {
    withStore((store) => {
      store.createSession({ ...scope, sessionId: 'ses_other' })
      expect(store.appendAudit(audit('one')).auditId).toBe(
        store.appendAudit(audit('one')).auditId,
      )
      store.appendAudit(audit('two'))
      store.appendAudit(audit('hidden', { sessionId: 'ses_other' }))
      const first = store.listAudit(scope, { limit: 1 })
      expect(first.records).toHaveLength(1)
      expect(first.nextCursor).not.toBeNull()
      expect(
        store.listAudit(scope, { cursor: first.nextCursor!, limit: 2 }).records,
      ).toHaveLength(1)
      expect(
        store.listAudit({ ...scope, tenantId: 'ten_other' }).records,
      ).toEqual([])
      expect(() =>
        store.appendAudit(
          audit('secret', { metadata: { prompt: 'do not persist' } }),
        ),
      ).toThrowError(/not allowed/)
      expect(() =>
        store.appendAudit(
          audit('sensitive', {
            correlationId: 'Bearer fixture-secret',
          }),
        ),
      ).toThrowError(/safe audit identifier/)
      expect(() =>
        store.appendAudit(
          audit('path', {
            metadata: { reasonCode: '/Users/example/.codex/auth.json' },
          }),
        ),
      ).toThrowError(/sensitive/)
      expect(JSON.stringify(store.listAudit(scope))).not.toContain(
        'do not persist',
      )
    })
  })

  it('survives reopen and migrates schema v5 to v6', () => {
    const directory = mkdtempSync(join(tmpdir(), 'event-store-audit-'))
    const path = join(directory, 'events.sqlite')
    const first = new SqliteEventStore(path)
    first.createSession(scope)
    first.appendAudit(audit('durable'))
    first.close()
    const reopened = new SqliteEventStore(path)
    try {
      expect(reopened.listAudit(scope).records).toHaveLength(1)
      const database = new DatabaseSync(path)
      expect(database.prepare('PRAGMA user_version').get()).toMatchObject({
        user_version: 9,
      })
      database.close()
    } finally {
      reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('enforces record and total metadata retention bounds with an injectable clock', () => {
    let tick = 0
    const store = new SqliteEventStore(':memory:', {
      now: () => new Date(Date.UTC(2026, 6, 14, 0, 0, tick++)),
      auditRetention: {
        maxRecords: 2,
        maxMetadataBytes: 100,
        maxAgeMs: 60_000,
      },
    })
    store.createSession(scope)
    try {
      store.appendAudit(audit('a'))
      store.appendAudit(audit('b'))
      store.appendAudit(audit('c'))
      expect(store.getAuditStats().records).toBeLessThanOrEqual(2)
      expect(store.getAuditStats().metadataBytes).toBeLessThanOrEqual(100)
    } finally {
      store.close()
    }
  })

  it('serializes two store instances under WAL contention and preserves idempotency', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'event-store-contention-'))
    const path = join(directory, 'events.sqlite')
    const first = new SqliteEventStore(path)
    const second = new SqliteEventStore(path)
    first.createSession(scope)
    const worker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads')
        const { DatabaseSync } = require('node:sqlite')
        const database = new DatabaseSync(workerData.path)
        database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
        database.prepare('UPDATE sessions SET updated_at=updated_at WHERE tenant_id=? AND workspace_id=? AND session_id=?').run('ten_test','wsp_test','ses_test')
        parentPort.postMessage('locked')
        setTimeout(() => {
          database.exec('COMMIT')
          database.close()
          parentPort.postMessage('released')
        }, 150)
      `,
      { eval: true, workerData: { path } },
    )
    try {
      expect((await once(worker, 'message'))[0]).toBe('locked')
      const startedAt = Date.now()
      const inserted = second.appendAudit(audit('contended'))
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
      expect(first.appendAudit(audit('contended')).auditId).toBe(
        inserted.auditId,
      )
      expect(first.getAuditStats().records).toBe(1)
      await once(worker, 'exit')
    } finally {
      await worker.terminate()
      first.close()
      second.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('WP13 provider persistence and append-only usage ledger', () => {
  const capabilities = {
    streaming: 'supported' as const,
    reasoningSummary: 'supported' as const,
    commandExecution: 'supported' as const,
    fileChanges: 'supported' as const,
    approvals: 'supported' as const,
    interrupt: 'supported' as const,
    resume: 'supported' as const,
    toolCalls: 'supported' as const,
    imageInput: 'supported' as const,
  }
  const prices = {
    version: 'fixture-prices-v1',
    currency: 'USD' as const,
    effectiveAt: '2026-07-15T00:00:00.000Z',
    models: [
      {
        provider: 'codex' as const,
        modelId: 'fixture-model',
        inputPerMillionMicros: 1_000_000,
        cachedInputPerMillionMicros: 100_000,
        outputPerMillionMicros: 4_000_000,
        reasoningPerMillionMicros: 4_000_000,
        toolUnitMicros: 25_000,
      },
    ],
  }
  const createProviderSession = (store: SqliteEventStore) => {
    store.createSession({
      ...scope,
      provider: 'codex',
      requestedPolicy: { alias: 'sol', reasoningEffort: 'medium' },
      resolvedModel: 'fixture-model',
      reasoningEffort: 'medium',
      capabilitySnapshot: capabilities,
    })
  }
  const createTurn = (store: SqliteEventStore, turnId: string) =>
    store.createTurn({
      ...scope,
      turnId,
      providerTurnId: turnId,
      provider: 'codex',
      requestedPolicy: { alias: 'sol', reasoningEffort: 'medium' },
      resolvedModel: 'fixture-model',
      reasoningEffort: 'medium',
      capabilitySnapshot: capabilities,
      status: 'in_progress',
    })
  const usage = (
    store: SqliteEventStore,
    turnId: string,
    dedupeKey: string,
    kind: 'delta' | 'cumulative',
    inputTokens: number,
  ) =>
    store.appendUsage({
      ...scope,
      turnId,
      modelId: 'fixture-model',
      priceCatalog: prices,
      report: {
        schemaVersion: 1,
        kind,
        provider: 'codex',
        requestId: `request-${turnId}`,
        dedupeKey,
        counters: {
          inputTokens,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          toolUnits: 0,
        },
        completeness: kind === 'cumulative' ? 'complete' : 'partial',
        occurredAt: '2026-07-15T00:00:00.000Z',
      },
    })

  it('deduplicates mixed cumulative/delta reports across replay and reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'usage-reopen-'))
    const path = join(directory, 'events.sqlite')
    const first = new SqliteEventStore(path)
    createProviderSession(first)
    createTurn(first, 'turn_mix')
    usage(first, 'turn_mix', 'delta-1', 'delta', 100)
    usage(first, 'turn_mix', 'cumulative-1', 'cumulative', 150)
    expect(
      usage(first, 'turn_mix', 'cumulative-1', 'cumulative', 150).effective,
    ).toMatchObject({ inputTokens: 50 })
    expect(() =>
      usage(first, 'turn_mix', 'cumulative-1', 'cumulative', 151),
    ).toThrowError(/dedupe key was reused/)
    usage(first, 'turn_mix', 'delta-2', 'delta', 10)
    usage(first, 'turn_mix', 'cumulative-2', 'cumulative', 160)
    expect(first.getUsageSummary(scope, 'turn_mix').counters.inputTokens).toBe(
      160,
    )
    first.close()
    const reopened = new SqliteEventStore(path)
    try {
      expect(
        usage(reopened, 'turn_mix', 'replayed-lower', 'cumulative', 160)
          .effective.inputTokens,
      ).toBe(0)
      expect(
        reopened.getUsageSummary(scope, 'turn_mix').counters.inputTokens,
      ).toBe(160)
    } finally {
      reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['completed', 'failed', 'interrupted'] as const)(
    'preserves measured usage for %s turns',
    (outcome) => {
      const store = new SqliteEventStore(':memory:')
      createProviderSession(store)
      createTurn(store, `turn-${outcome}`)
      usage(store, `turn-${outcome}`, `usage-${outcome}`, 'cumulative', 25)
      store.completeTurn(scope, `turn-${outcome}`, outcome)
      store.appendUsageOutcome({
        ...scope,
        turnId: `turn-${outcome}`,
        provider: 'codex',
        modelId: 'fixture-model',
        dedupeKey: `terminal-${outcome}`,
        outcome,
        completeness: 'complete',
      })
      expect(store.getUsageSummary(scope, `turn-${outcome}`)).toMatchObject({
        outcome,
        completeness: 'complete',
        counters: { inputTokens: 25 },
        estimatedCostMicros: 25,
      })
      store.close()
    },
  )

  it('keeps missing terminal usage partial/unreconciled and never presents zero cost', () => {
    const store = new SqliteEventStore(':memory:')
    createProviderSession(store)
    createTurn(store, 'turn_partial')
    store.appendUsageOutcome({
      ...scope,
      turnId: 'turn_partial',
      provider: 'codex',
      modelId: 'fixture-model',
      dedupeKey: 'terminal-partial',
      outcome: 'failed',
      completeness: 'partial',
    })
    expect(store.getUsageSummary(scope, 'turn_partial')).toMatchObject({
      completeness: 'partial',
      reconciliationStatus: 'unreconciled',
      estimatedCostMicros: null,
    })
    store.close()
  })

  it('appends official reconciliation without overwriting the versioned estimate', () => {
    const store = new SqliteEventStore(':memory:')
    createProviderSession(store)
    createTurn(store, 'turn_reconciled')
    usage(store, 'turn_reconciled', 'usage-reconciled', 'cumulative', 100)
    store.appendUsageOutcome({
      ...scope,
      turnId: 'turn_reconciled',
      provider: 'codex',
      modelId: 'fixture-model',
      dedupeKey: 'terminal-reconciled',
      outcome: 'completed',
      completeness: 'complete',
    })
    store.appendUsageReconciliation({
      ...scope,
      turnId: 'turn_reconciled',
      provider: 'codex',
      modelId: 'fixture-model',
      dedupeKey: 'official-fixture-1',
      result: {
        sourceReference: 'provider-export-fixture-1',
        officialCostMicros: 111,
        currency: 'USD',
        reconciledAt: '2026-07-15T01:00:00.000Z',
      },
    })
    expect(store.getUsageSummary(scope, 'turn_reconciled')).toMatchObject({
      estimatedCostMicros: 100,
      officialCostMicros: 111,
      reconciliationStatus: 'reconciled',
      priceCatalogVersions: ['fixture-prices-v1'],
    })
    expect(JSON.stringify(store.getUsageSummary(scope))).not.toMatch(
      /prompt|credential|Bearer|model response/i,
    )
    store.close()
  })
})
