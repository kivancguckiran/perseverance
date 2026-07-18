import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import type {
  CorpusChunk,
  ExtractionJob,
  IndexDocument,
  IngestionAudit,
  Source,
  SourceRevision,
} from '@persistent-codex/control-plane-contracts'
import {
  CorpusError,
  type CorpusScope,
  type EmbeddingUsageRecord,
} from './index'
import type {
  CorpusRetrievalRepository,
  RetrievalCandidate,
  RetrievalIdentity,
} from './retrieval'

export const CORPUS_REPOSITORY_VERSION = 2 as const

export interface CorpusChunkWrite {
  chunk: CorpusChunk
  content: string
}

export interface IndexDocumentWrite {
  document: IndexDocument
  embedding: number[] | null
}

export interface CorpusRepository extends CorpusRetrievalRepository {
  readonly version: typeof CORPUS_REPOSITORY_VERSION
  readonly adapter: 'postgresql'
  recoverableScopes(): Promise<CorpusScope[]>
  registerSource(input: {
    scope: CorpusScope
    source: Source
    revision: SourceRevision
    job: ExtractionJob
    audit: IngestionAudit
  }): Promise<{
    source: Source
    revision: SourceRevision
    job: ExtractionJob
    created: boolean
  }>
  registerRevision(input: {
    scope: CorpusScope
    sourceId: string
    revision: SourceRevision
    job: ExtractionJob
    audit: IngestionAudit
  }): Promise<{ source: Source; revision: SourceRevision; job: ExtractionJob }>
  sourceByWorkspacePath(
    scope: CorpusScope,
    workspacePath: string,
  ): Promise<{ source: Source; revision: SourceRevision } | null>
  renameWorkspaceSource(input: {
    scope: CorpusScope
    sourceId: string
    fromPath: string
    toPath: string
    displayName: string
  }): Promise<Source>
  listSources(scope: CorpusScope): Promise<Source[]>
  sourceDetail(
    scope: CorpusScope,
    sourceId: string,
  ): Promise<{
    source: Source
    revisions: SourceRevision[]
    jobs: ExtractionJob[]
  }>
  claimNext(
    scope: CorpusScope,
    workerId: string,
    leaseMs: number,
  ): Promise<ExtractionJob | null>
  jobContext(
    scope: CorpusScope,
    jobId: string,
    workerId: string,
  ): Promise<{
    source: Source
    revision: SourceRevision
    job: ExtractionJob
  }>
  completeJob(input: {
    scope: CorpusScope
    jobId: string
    workerId: string
    chunks: CorpusChunkWrite[]
    indexDocuments: IndexDocumentWrite[]
    usage: EmbeddingUsageRecord | null
  }): Promise<ExtractionJob>
  failJob(input: {
    scope: CorpusScope
    jobId: string
    workerId: string
    errorCode: string
    usage?: EmbeddingUsageRecord | null
  }): Promise<ExtractionJob>
  deleteSource(scope: CorpusScope, sourceId: string): Promise<Source>
  reindexSource(
    scope: CorpusScope,
    sourceId: string,
    maxAttempts: number,
  ): Promise<ExtractionJob>
  enqueueSnapshotCleanup(
    scope: CorpusScope,
    storageKey: string,
    reasonCode: string,
  ): Promise<void>
  listPendingCleanup(
    scope: CorpusScope,
  ): Promise<Array<{ cleanupId: string; storageKey: string }>>
  completeCleanup(scope: CorpusScope, cleanupId: string): Promise<void>
  close(): Promise<void>
}

type Row = Record<string, unknown>
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value)
const nullableIso = (value: unknown) => (value == null ? null : iso(value))

function source(row: Row): Source {
  return {
    version: 1,
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    sourceId: String(row.source_id),
    kind: row.kind as Source['kind'],
    displayName: String(row.display_name),
    status: row.status as Source['status'],
    currentRevisionId:
      row.current_revision_id == null ? null : String(row.current_revision_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: nullableIso(row.deleted_at),
  }
}

function revision(row: Row): SourceRevision {
  const raw = row.raw_snapshot_metadata as Record<string, unknown>
  return {
    version: 1,
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    sourceId: String(row.source_id),
    revisionId: String(row.revision_id),
    contentHash: String(row.content_hash),
    byteLength: Number(row.byte_length),
    mediaType: row.media_type as SourceRevision['mediaType'],
    parserVersion: String(row.parser_version),
    language: String(row.language),
    provenance: row.provenance as SourceRevision['provenance'],
    rawSnapshot: {
      immutable: true,
      storageKey: String(row.storage_key),
      createdAt: String(raw.createdAt ?? iso(row.created_at)),
    },
    status: row.status as SourceRevision['status'],
    createdAt: iso(row.created_at),
  }
}

function job(row: Row): ExtractionJob {
  return {
    version: 1,
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    jobId: String(row.job_id),
    sourceId: String(row.source_id),
    revisionId: String(row.revision_id),
    status: row.status as ExtractionJob['status'],
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseExpiresAt: nullableIso(row.lease_expires_at),
    retryAt: nullableIso(row.retry_at),
    errorCode: row.error_code == null ? null : String(row.error_code),
    usageCompleteness:
      row.usage_completeness as ExtractionJob['usageCompleteness'],
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    updatedAt: iso(row.updated_at),
  }
}

export class PostgresCorpusRepository implements CorpusRepository {
  readonly version = CORPUS_REPOSITORY_VERSION
  readonly adapter = 'postgresql' as const
  readonly #pool: Pool
  readonly #ownsPool: boolean

  constructor(pool: Pool, options: { ownsPool?: boolean } = {}) {
    this.#pool = pool
    this.#ownsPool = options.ownsPool ?? false
  }

  async recoverableScopes() {
    const result = await this.#pool.query(
      `SELECT tenant_id,organization_id,workspace_id
       FROM persistent_codex.corpus_recoverable_scopes()`,
    )
    return result.rows.map((row) => ({
      tenantId: String(row.tenant_id),
      organizationId: String(row.organization_id),
      workspaceId: String(row.workspace_id),
    }))
  }

  async #transaction<T>(
    scope: CorpusScope,
    fn: (client: PoolClient) => Promise<T>,
  ) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.tenant_id',$1,true),
                set_config('app.organization_id',$2,true),
                set_config('app.workspace_id',$3,true)`,
        [scope.tenantId, scope.organizationId, scope.workspaceId],
      )
      const value = await fn(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async registerSource(input: {
    scope: CorpusScope
    source: Source
    revision: SourceRevision
    job: ExtractionJob
    audit: IngestionAudit
  }) {
    return this.#transaction(input.scope, async (client) => {
      const duplicate = await client.query(
        `SELECT * FROM persistent_codex.source_revisions
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND content_hash=$4`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          input.revision.contentHash,
        ],
      )
      if (duplicate.rowCount) {
        const duplicateRevision = revision(duplicate.rows[0] as Row)
        const sourceRow = await client.query(
          `SELECT * FROM persistent_codex.sources WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
          [
            input.scope.tenantId,
            input.scope.organizationId,
            input.scope.workspaceId,
            duplicateRevision.sourceId,
          ],
        )
        const jobRow = await client.query(
          `SELECT * FROM persistent_codex.extraction_jobs WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND revision_id=$4 ORDER BY updated_at DESC LIMIT 1`,
          [
            input.scope.tenantId,
            input.scope.organizationId,
            input.scope.workspaceId,
            duplicateRevision.revisionId,
          ],
        )
        return {
          source: source(sourceRow.rows[0] as Row),
          revision: duplicateRevision,
          job: job(jobRow.rows[0] as Row),
          created: false,
        }
      }
      const s = input.source
      const r = input.revision
      const j = input.job
      await client.query(
        `INSERT INTO persistent_codex.sessions
         (organization_id,workspace_id,session_id,status)
         VALUES ($1,$2,$3,'active')
         ON CONFLICT (organization_id,workspace_id,session_id) DO NOTHING`,
        [
          input.scope.organizationId,
          input.scope.workspaceId,
          `corpus_usage_${input.scope.workspaceId}`,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.sources
         (tenant_id,organization_id,workspace_id,source_id,kind,display_name,status,current_revision_id,created_at,updated_at,deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10)`,
        [
          s.tenantId,
          s.organizationId,
          s.workspaceId,
          s.sourceId,
          s.kind,
          s.displayName,
          s.status,
          s.createdAt,
          s.updatedAt,
          s.deletedAt,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.source_revisions
         (tenant_id,organization_id,workspace_id,source_id,revision_id,content_hash,byte_length,media_type,parser_version,language,provenance,raw_snapshot_metadata,storage_key,status,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          r.tenantId,
          r.organizationId,
          r.workspaceId,
          r.sourceId,
          r.revisionId,
          r.contentHash,
          r.byteLength,
          r.mediaType,
          r.parserVersion,
          r.language,
          JSON.stringify(r.provenance),
          JSON.stringify({
            immutable: true,
            encrypted: true,
            createdAt: r.rawSnapshot.createdAt,
          }),
          r.rawSnapshot.storageKey,
          r.status,
          r.createdAt,
        ],
      )
      await client.query(
        `UPDATE persistent_codex.sources SET current_revision_id=$5
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
        [s.tenantId, s.organizationId, s.workspaceId, s.sourceId, r.revisionId],
      )
      await client.query(
        `INSERT INTO persistent_codex.extraction_jobs
         (tenant_id,organization_id,workspace_id,job_id,source_id,revision_id,status,attempt,max_attempts,usage_completeness,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          j.tenantId,
          j.organizationId,
          j.workspaceId,
          j.jobId,
          j.sourceId,
          j.revisionId,
          j.status,
          j.attempt,
          j.maxAttempts,
          j.usageCompleteness,
          j.updatedAt,
        ],
      )
      if (r.provenance.kind === 'workspace_file' && r.provenance.workspacePath)
        await client.query(
          `INSERT INTO persistent_codex.workspace_source_paths
           (tenant_id,organization_id,workspace_id,workspace_path,source_id,content_hash)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            input.scope.tenantId,
            input.scope.organizationId,
            input.scope.workspaceId,
            r.provenance.workspacePath,
            r.sourceId,
            r.contentHash,
          ],
        )
      await this.#insertAudit(client, input.audit)
      await this.#bumpCacheEpoch(client, input.scope)
      return { source: s, revision: r, job: j, created: true }
    })
  }

  async registerRevision(input: {
    scope: CorpusScope
    sourceId: string
    revision: SourceRevision
    job: ExtractionJob
    audit: IngestionAudit
  }) {
    return this.#transaction(input.scope, async (client) => {
      const locked = await client.query(
        `SELECT * FROM persistent_codex.sources
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND source_id=$4 AND status<>'deleted' FOR UPDATE`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          input.sourceId,
        ],
      )
      if (!locked.rowCount)
        throw new CorpusError('SOURCE_NOT_FOUND', 'Source was not found')
      const current = source(locked.rows[0] as Row)
      const r = input.revision
      const j = input.job
      const duplicate = await client.query(
        `SELECT * FROM persistent_codex.source_revisions
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND source_id=$4 AND content_hash=$5`,
        [
          r.tenantId,
          r.organizationId,
          r.workspaceId,
          r.sourceId,
          r.contentHash,
        ],
      )
      if (duplicate.rowCount) {
        const existing = revision(duplicate.rows[0] as Row)
        const existingJob = await client.query(
          `SELECT * FROM persistent_codex.extraction_jobs
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
             AND revision_id=$4 ORDER BY updated_at DESC LIMIT 1`,
          [r.tenantId, r.organizationId, r.workspaceId, existing.revisionId],
        )
        return {
          source: current,
          revision: existing,
          job: job(existingJob.rows[0] as Row),
        }
      }
      if (current.currentRevisionId) {
        await client.query(
          `DELETE FROM persistent_codex.index_documents
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND revision_id=$4`,
          [
            r.tenantId,
            r.organizationId,
            r.workspaceId,
            current.currentRevisionId,
          ],
        )
        await client.query(
          `DELETE FROM persistent_codex.corpus_chunks
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND revision_id=$4`,
          [
            r.tenantId,
            r.organizationId,
            r.workspaceId,
            current.currentRevisionId,
          ],
        )
        await client.query(
          `UPDATE persistent_codex.source_revisions SET status='superseded'
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND revision_id=$4`,
          [
            r.tenantId,
            r.organizationId,
            r.workspaceId,
            current.currentRevisionId,
          ],
        )
        await client.query(
          `INSERT INTO persistent_codex.corpus_tombstones
           (tenant_id,organization_id,workspace_id,source_id,revision_id,reason)
           VALUES ($1,$2,$3,$4,$5,'revision_superseded')`,
          [
            r.tenantId,
            r.organizationId,
            r.workspaceId,
            r.sourceId,
            current.currentRevisionId,
          ],
        )
      }
      await client.query(
        `INSERT INTO persistent_codex.source_revisions
         (tenant_id,organization_id,workspace_id,source_id,revision_id,content_hash,byte_length,media_type,parser_version,language,provenance,raw_snapshot_metadata,storage_key,status,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          r.tenantId,
          r.organizationId,
          r.workspaceId,
          r.sourceId,
          r.revisionId,
          r.contentHash,
          r.byteLength,
          r.mediaType,
          r.parserVersion,
          r.language,
          JSON.stringify(r.provenance),
          JSON.stringify({
            immutable: true,
            encrypted: true,
            createdAt: r.rawSnapshot.createdAt,
          }),
          r.rawSnapshot.storageKey,
          r.status,
          r.createdAt,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.extraction_jobs
         (tenant_id,organization_id,workspace_id,job_id,source_id,revision_id,status,attempt,max_attempts,usage_completeness,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          j.tenantId,
          j.organizationId,
          j.workspaceId,
          j.jobId,
          j.sourceId,
          j.revisionId,
          j.status,
          j.attempt,
          j.maxAttempts,
          j.usageCompleteness,
          j.updatedAt,
        ],
      )
      const updated = await client.query(
        `UPDATE persistent_codex.sources
         SET current_revision_id=$5,status='pending',updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4
         RETURNING *`,
        [r.tenantId, r.organizationId, r.workspaceId, r.sourceId, r.revisionId],
      )
      if (r.provenance.kind === 'workspace_file' && r.provenance.workspacePath)
        await client.query(
          `UPDATE persistent_codex.workspace_source_paths
           SET content_hash=$5,updated_at=now()
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND workspace_path=$4`,
          [
            r.tenantId,
            r.organizationId,
            r.workspaceId,
            r.provenance.workspacePath,
            r.contentHash,
          ],
        )
      await this.#insertAudit(client, input.audit)
      await this.#bumpCacheEpoch(client, input.scope)
      return { source: source(updated.rows[0] as Row), revision: r, job: j }
    })
  }

  async sourceByWorkspacePath(scope: CorpusScope, workspacePath: string) {
    return this.#transaction(scope, async (client) => {
      const rows = await client.query(
        `SELECT to_jsonb(s.*) source_row,to_jsonb(r.*) revision_row
         FROM persistent_codex.workspace_source_paths p
         JOIN persistent_codex.sources s USING (tenant_id,organization_id,workspace_id,source_id)
         JOIN persistent_codex.source_revisions r
           ON r.tenant_id=s.tenant_id AND r.organization_id=s.organization_id
          AND r.workspace_id=s.workspace_id AND r.source_id=s.source_id
          AND r.revision_id=s.current_revision_id
         WHERE p.tenant_id=$1 AND p.organization_id=$2 AND p.workspace_id=$3
           AND p.workspace_path=$4 AND s.status<>'deleted'`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          workspacePath,
        ],
      )
      if (!rows.rowCount) return null
      return {
        source: source(rows.rows[0]!.source_row as Row),
        revision: revision(rows.rows[0]!.revision_row as Row),
      }
    })
  }

  async renameWorkspaceSource(input: {
    scope: CorpusScope
    sourceId: string
    fromPath: string
    toPath: string
    displayName: string
  }) {
    return this.#transaction(input.scope, async (client) => {
      const path = await client.query(
        `UPDATE persistent_codex.workspace_source_paths
         SET workspace_path=$6,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND source_id=$4 AND workspace_path=$5`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          input.sourceId,
          input.fromPath,
          input.toPath,
        ],
      )
      if (!path.rowCount)
        throw new CorpusError(
          'SOURCE_NOT_FOUND',
          'Workspace source was not found',
        )
      const updated = await client.query(
        `UPDATE persistent_codex.sources SET display_name=$5,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4
         RETURNING *`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          input.sourceId,
          input.displayName,
        ],
      )
      await this.#bumpCacheEpoch(client, input.scope)
      return source(updated.rows[0] as Row)
    })
  }

  async listSources(scope: CorpusScope) {
    return this.#transaction(scope, async (client) =>
      (
        await client.query(
          `SELECT * FROM persistent_codex.sources
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
         ORDER BY created_at,source_id`,
          [scope.tenantId, scope.organizationId, scope.workspaceId],
        )
      ).rows.map((row) => source(row as Row)),
    )
  }

  async sourceDetail(scope: CorpusScope, sourceId: string) {
    return this.#transaction(scope, async (client) => {
      const sourceRows = await client.query(
        `SELECT * FROM persistent_codex.sources WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sourceId],
      )
      const revisionRows = await client.query(
        `SELECT * FROM persistent_codex.source_revisions WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4 ORDER BY created_at`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sourceId],
      )
      const jobRows = await client.query(
        `SELECT * FROM persistent_codex.extraction_jobs WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4 ORDER BY updated_at`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sourceId],
      )
      if (!sourceRows.rowCount)
        throw new CorpusError('SOURCE_NOT_FOUND', 'Source was not found')
      return {
        source: source(sourceRows.rows[0] as Row),
        revisions: revisionRows.rows.map((r) => revision(r as Row)),
        jobs: jobRows.rows.map((r) => job(r as Row)),
      }
    })
  }

  async claimNext(scope: CorpusScope, workerId: string, leaseMs: number) {
    return this.#transaction(scope, async (client) => {
      const result = await client.query(
        `WITH candidate AS (
           SELECT job_id FROM persistent_codex.extraction_jobs
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
             AND (status='pending' OR (status='extracting' AND lease_expires_at <= now()))
             AND (retry_at IS NULL OR retry_at <= now())
           ORDER BY updated_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE persistent_codex.extraction_jobs j
         SET status='extracting',lease_owner=$4,
             lease_expires_at=now()+($5::text || ' milliseconds')::interval,
             started_at=COALESCE(started_at,now()),updated_at=now(),
             lock_version=lock_version+1
         FROM candidate WHERE j.tenant_id=$1 AND j.organization_id=$2 AND j.workspace_id=$3
           AND j.job_id=candidate.job_id RETURNING j.*`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          workerId,
          leaseMs,
        ],
      )
      if (!result.rowCount) return null
      const claimed = job(result.rows[0] as Row)
      await client.query(
        `UPDATE persistent_codex.sources SET status='extracting',updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          claimed.sourceId,
        ],
      )
      await client.query(
        `UPDATE persistent_codex.source_revisions SET status='extracting' WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND revision_id=$4`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          claimed.revisionId,
        ],
      )
      await this.#insertAudit(client, {
        version: 1,
        ...scope,
        auditId: `iaud_${randomUUID()}`,
        sourceId: claimed.sourceId,
        revisionId: claimed.revisionId,
        jobId: claimed.jobId,
        action: 'extraction.started',
        outcome: 'success',
        reasonCode: 'JOB_CLAIMED',
        occurredAt: new Date().toISOString(),
      })
      return claimed
    })
  }

  async jobContext(scope: CorpusScope, jobId: string, workerId: string) {
    return this.#transaction(scope, async (client) => {
      const rows = await client.query(
        `SELECT j.*,to_jsonb(s.*) source_row,to_jsonb(r.*) revision_row
         FROM persistent_codex.extraction_jobs j
         JOIN persistent_codex.sources s USING (tenant_id,organization_id,workspace_id,source_id)
         JOIN persistent_codex.source_revisions r ON r.tenant_id=j.tenant_id AND r.organization_id=j.organization_id AND r.workspace_id=j.workspace_id AND r.revision_id=j.revision_id
         WHERE j.tenant_id=$1 AND j.organization_id=$2 AND j.workspace_id=$3 AND j.job_id=$4
           AND j.status='extracting' AND j.lease_owner=$5 AND j.lease_expires_at>now()`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          jobId,
          workerId,
        ],
      )
      if (!rows.rowCount)
        throw new CorpusError(
          'JOB_LEASE_REQUIRED',
          'Worker does not own an active extraction lease',
        )
      const row = rows.rows[0] as Row
      return {
        source: source(row.source_row as Row),
        revision: revision(row.revision_row as Row),
        job: job(row),
      }
    })
  }

  async completeJob(input: {
    scope: CorpusScope
    jobId: string
    workerId: string
    chunks: CorpusChunkWrite[]
    indexDocuments: IndexDocumentWrite[]
    usage: EmbeddingUsageRecord | null
  }) {
    return this.#transaction(input.scope, async (client) => {
      const locked = await client.query(
        `SELECT * FROM persistent_codex.extraction_jobs WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND job_id=$4 FOR UPDATE`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          input.jobId,
        ],
      )
      if (!locked.rowCount)
        throw new CorpusError('JOB_NOT_FOUND', 'Extraction job was not found')
      const current = job(locked.rows[0] as Row)
      if (current.status === 'indexed') return current
      if (
        current.status !== 'extracting' ||
        current.leaseOwner !== input.workerId ||
        !current.leaseExpiresAt ||
        new Date(current.leaseExpiresAt) <= new Date()
      )
        throw new CorpusError(
          'JOB_LEASE_REQUIRED',
          'Worker does not own an active extraction lease',
        )
      await client.query(
        `DELETE FROM persistent_codex.index_documents WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND revision_id=$4`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          current.revisionId,
        ],
      )
      await client.query(
        `DELETE FROM persistent_codex.corpus_chunks WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND revision_id=$4`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          current.revisionId,
        ],
      )
      for (const entry of input.chunks) {
        const chunk = entry.chunk
        await client.query(
          `INSERT INTO persistent_codex.corpus_chunks
           (tenant_id,organization_id,workspace_id,chunk_id,source_id,revision_id,ordinal,content_hash,locator,chunking_policy,metadata,created_at,content_text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (tenant_id,organization_id,workspace_id,revision_id,ordinal)
           DO UPDATE SET content_text=EXCLUDED.content_text`,
          [
            chunk.tenantId,
            chunk.organizationId,
            chunk.workspaceId,
            chunk.chunkId,
            chunk.sourceId,
            chunk.revisionId,
            chunk.ordinal,
            chunk.contentHash,
            JSON.stringify(chunk.locator),
            JSON.stringify(chunk.chunkingPolicy),
            JSON.stringify(chunk.metadata),
            chunk.createdAt,
            entry.content,
          ],
        )
      }
      for (const entry of input.indexDocuments) {
        const doc = entry.document
        await client.query(
          `INSERT INTO persistent_codex.index_documents
           (tenant_id,organization_id,workspace_id,index_document_id,chunk_id,source_id,revision_id,content_hash,embedding_version,embedding_token_count,status,derived_at,embedding,index_version,ranking_policy_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::vector,$14,$15)
           ON CONFLICT (tenant_id,organization_id,workspace_id,chunk_id,embedding_version)
           DO UPDATE SET embedding=EXCLUDED.embedding,index_version=EXCLUDED.index_version,
             ranking_policy_version=EXCLUDED.ranking_policy_version,status=EXCLUDED.status,derived_at=EXCLUDED.derived_at`,
          [
            doc.tenantId,
            doc.organizationId,
            doc.workspaceId,
            doc.indexDocumentId,
            doc.chunkId,
            doc.sourceId,
            doc.revisionId,
            doc.contentHash,
            doc.embeddingVersion,
            doc.embeddingTokenCount,
            doc.status,
            doc.derivedAt,
            entry.embedding ? `[${entry.embedding.join(',')}]` : null,
            'corpus-index-v1',
            'hybrid-rrf-v1',
          ],
        )
      }
      if (input.usage)
        await client.query(
          `INSERT INTO persistent_codex.usage_ledger
           (organization_id,workspace_id,session_id,quantity,tenant_id,meter,dedupe_key,source_id,revision_id,extraction_job_id,completeness)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
          [
            input.scope.organizationId,
            input.scope.workspaceId,
            `corpus_usage_${input.scope.workspaceId}`,
            input.usage.quantity,
            input.scope.tenantId,
            input.usage.meter,
            input.usage.dedupeKey,
            input.usage.sourceId,
            input.usage.revisionId,
            input.usage.jobId,
            input.usage.completeness,
          ],
        )
      const completed = await client.query(
        `UPDATE persistent_codex.extraction_jobs SET status='indexed',lease_owner=NULL,lease_expires_at=NULL,retry_at=NULL,error_code=NULL,
         usage_completeness=$5,completed_at=now(),updated_at=now()
         ,lock_version=lock_version+1
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND job_id=$4 RETURNING *`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          input.jobId,
          input.usage?.completeness ?? 'complete',
        ],
      )
      await client.query(
        `UPDATE persistent_codex.sources SET status='indexed',updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          current.sourceId,
        ],
      )
      await client.query(
        `UPDATE persistent_codex.source_revisions SET status='indexed' WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND revision_id=$4`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          current.revisionId,
        ],
      )
      await this.#insertAudit(client, {
        version: 1,
        ...input.scope,
        auditId: `iaud_${randomUUID()}`,
        sourceId: current.sourceId,
        revisionId: current.revisionId,
        jobId: current.jobId,
        action: 'extraction.completed',
        outcome: 'success',
        reasonCode: 'INDEX_DERIVED',
        occurredAt: new Date().toISOString(),
      })
      await this.#bumpCacheEpoch(client, input.scope)
      return job(completed.rows[0] as Row)
    })
  }

  async failJob(input: {
    scope: CorpusScope
    jobId: string
    workerId: string
    errorCode: string
    usage?: EmbeddingUsageRecord | null
  }) {
    return this.#transaction(input.scope, async (client) => {
      const locked = await client.query(
        `SELECT * FROM persistent_codex.extraction_jobs WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND job_id=$4 FOR UPDATE`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          input.jobId,
        ],
      )
      if (!locked.rowCount)
        throw new CorpusError('JOB_NOT_FOUND', 'Extraction job was not found')
      const current = job(locked.rows[0] as Row)
      if (
        current.status !== 'extracting' ||
        current.leaseOwner !== input.workerId
      )
        throw new CorpusError(
          'JOB_LEASE_REQUIRED',
          'Worker does not own the extraction lease',
        )
      const terminal = current.attempt >= current.maxAttempts
      if (input.usage)
        await client.query(
          `INSERT INTO persistent_codex.usage_ledger
           (organization_id,workspace_id,session_id,quantity,tenant_id,meter,dedupe_key,source_id,revision_id,extraction_job_id,completeness)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
          [
            input.scope.organizationId,
            input.scope.workspaceId,
            `corpus_usage_${input.scope.workspaceId}`,
            input.usage.quantity,
            input.scope.tenantId,
            input.usage.meter,
            input.usage.dedupeKey,
            input.usage.sourceId,
            input.usage.revisionId,
            input.usage.jobId,
            input.usage.completeness,
          ],
        )
      const result = await client.query(
        `UPDATE persistent_codex.extraction_jobs SET status=$5,attempt=CASE WHEN $6 THEN attempt ELSE attempt+1 END,
         lease_owner=NULL,lease_expires_at=NULL,retry_at=CASE WHEN $6 THEN NULL ELSE now() END,error_code=$7,
         usage_completeness='partial',completed_at=CASE WHEN $6 THEN now() ELSE NULL END,updated_at=now()
         ,lock_version=lock_version+1
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND job_id=$4 RETURNING *`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          input.jobId,
          terminal ? 'failed' : 'pending',
          terminal,
          input.errorCode,
        ],
      )
      await client.query(
        `UPDATE persistent_codex.sources SET status=$5,updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          current.sourceId,
          terminal ? 'failed' : 'pending',
        ],
      )
      await client.query(
        `UPDATE persistent_codex.source_revisions SET status=$5 WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND revision_id=$4`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          current.revisionId,
          terminal ? 'failed' : 'pending',
        ],
      )
      await this.#insertAudit(client, {
        version: 1,
        ...input.scope,
        auditId: `iaud_${randomUUID()}`,
        sourceId: current.sourceId,
        revisionId: current.revisionId,
        jobId: current.jobId,
        action: 'extraction.failed',
        outcome: 'failure',
        reasonCode: input.errorCode,
        occurredAt: new Date().toISOString(),
      })
      return job(result.rows[0] as Row)
    })
  }

  async deleteSource(scope: CorpusScope, sourceId: string) {
    return this.#transaction(scope, async (client) => {
      const rows = await client.query(
        `SELECT * FROM persistent_codex.sources WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4 FOR UPDATE`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sourceId],
      )
      if (!rows.rowCount)
        throw new CorpusError('SOURCE_NOT_FOUND', 'Source was not found')
      const cleanupRows = await client.query(
        `SELECT storage_key FROM persistent_codex.source_revisions
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sourceId],
      )
      for (const cleanup of cleanupRows.rows)
        await client.query(
          `INSERT INTO persistent_codex.corpus_storage_cleanup
           (tenant_id,organization_id,workspace_id,cleanup_id,storage_key,reason_code,status)
           VALUES ($1,$2,$3,$4,$5,'SOURCE_DELETE','pending')
           ON CONFLICT (tenant_id,organization_id,workspace_id,storage_key) WHERE status='pending' DO NOTHING`,
          [
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            `clean_${randomUUID()}`,
            cleanup.storage_key,
          ],
        )
      const currentRevisionId = source(rows.rows[0] as Row).currentRevisionId
      await client.query(
        `INSERT INTO persistent_codex.corpus_tombstones
         (tenant_id,organization_id,workspace_id,source_id,revision_id,reason)
         VALUES ($1,$2,$3,$4,$5,'source_deleted')`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          sourceId,
          currentRevisionId,
        ],
      )
      await client.query(
        `DELETE FROM persistent_codex.index_documents WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sourceId],
      )
      await client.query(
        `DELETE FROM persistent_codex.corpus_chunks WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sourceId],
      )
      await client.query(
        `UPDATE persistent_codex.extraction_jobs SET status='deleted',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sourceId],
      )
      await client.query(
        `UPDATE persistent_codex.source_revisions SET status='deleted' WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sourceId],
      )
      const result = await client.query(
        `UPDATE persistent_codex.sources SET status='deleted',deleted_at=now(),updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4 RETURNING *`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sourceId],
      )
      await this.#insertAudit(client, {
        version: 1,
        ...scope,
        auditId: `iaud_${randomUUID()}`,
        sourceId,
        revisionId: currentRevisionId,
        jobId: null,
        action: 'source.deleted',
        outcome: 'success',
        reasonCode: 'SOURCE_TOMBSTONED',
        occurredAt: new Date().toISOString(),
      })
      await this.#bumpCacheEpoch(client, scope)
      return source(result.rows[0] as Row)
    })
  }

  async reindexSource(
    scope: CorpusScope,
    sourceId: string,
    maxAttempts: number,
  ) {
    return this.#transaction(scope, async (client) => {
      const rows = await client.query(
        `SELECT * FROM persistent_codex.sources WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4 AND status<>'deleted' FOR UPDATE`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sourceId],
      )
      if (!rows.rowCount)
        throw new CorpusError('SOURCE_NOT_FOUND', 'Source was not found')
      const currentSource = source(rows.rows[0] as Row)
      const existing = await client.query(
        `SELECT * FROM persistent_codex.extraction_jobs WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND revision_id=$4 AND status IN ('pending','extracting') LIMIT 1`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          currentSource.currentRevisionId,
        ],
      )
      if (existing.rowCount) return job(existing.rows[0] as Row)
      const id = `job_${randomUUID()}`
      const result = await client.query(
        `INSERT INTO persistent_codex.extraction_jobs (tenant_id,organization_id,workspace_id,job_id,source_id,revision_id,status,attempt,max_attempts,usage_completeness) VALUES ($1,$2,$3,$4,$5,$6,'pending',1,$7,'partial') RETURNING *`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          id,
          sourceId,
          currentSource.currentRevisionId,
          maxAttempts,
        ],
      )
      await client.query(
        `UPDATE persistent_codex.sources SET status='pending',updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sourceId],
      )
      await client.query(
        `UPDATE persistent_codex.source_revisions SET status='pending' WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND revision_id=$4`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          currentSource.currentRevisionId,
        ],
      )
      await this.#insertAudit(client, {
        version: 1,
        ...scope,
        auditId: `iaud_${randomUUID()}`,
        sourceId,
        revisionId: currentSource.currentRevisionId,
        jobId: id,
        action: 'source.reindexed',
        outcome: 'success',
        reasonCode: 'REINDEX_QUEUED',
        occurredAt: new Date().toISOString(),
      })
      return job(result.rows[0] as Row)
    })
  }

  async enqueueSnapshotCleanup(
    scope: CorpusScope,
    storageKey: string,
    reasonCode: string,
  ) {
    await this.#transaction(scope, async (client) => {
      await client.query(
        `INSERT INTO persistent_codex.corpus_storage_cleanup (tenant_id,organization_id,workspace_id,cleanup_id,storage_key,reason_code,status) VALUES ($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT (tenant_id,organization_id,workspace_id,storage_key) WHERE status='pending' DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          `clean_${randomUUID()}`,
          storageKey,
          reasonCode,
        ],
      )
    })
  }

  async listPendingCleanup(scope: CorpusScope) {
    return this.#transaction(scope, async (client) =>
      (
        await client.query(
          `SELECT cleanup_id,storage_key FROM persistent_codex.corpus_storage_cleanup WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND status='pending' ORDER BY created_at`,
          [scope.tenantId, scope.organizationId, scope.workspaceId],
        )
      ).rows.map((row) => ({
        cleanupId: String(row.cleanup_id),
        storageKey: String(row.storage_key),
      })),
    )
  }

  async completeCleanup(scope: CorpusScope, cleanupId: string) {
    await this.#transaction(scope, async (client) => {
      await client.query(
        `UPDATE persistent_codex.corpus_storage_cleanup SET status='completed',completed_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND cleanup_id=$4`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, cleanupId],
      )
    })
  }

  async corpusCacheEpoch(scope: CorpusScope) {
    return this.#transaction(scope, async (client) => {
      await client.query(
        `INSERT INTO persistent_codex.corpus_cache_epochs
         (tenant_id,organization_id,workspace_id,epoch)
         VALUES ($1,$2,$3,1) ON CONFLICT DO NOTHING`,
        [scope.tenantId, scope.organizationId, scope.workspaceId],
      )
      const result = await client.query(
        `SELECT epoch FROM persistent_codex.corpus_cache_epochs
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3`,
        [scope.tenantId, scope.organizationId, scope.workspaceId],
      )
      return Number(result.rows[0]!.epoch)
    })
  }

  async setSourceAcl(input: {
    identity: RetrievalIdentity
    sourceId: string
    visibility: 'workspace' | 'principals'
    allowedPrincipalIds: string[]
  }) {
    await this.#transaction(input.identity, async (client) => {
      const updated = await client.query(
        `UPDATE persistent_codex.sources
         SET visibility=$5,acl_version=acl_version+1,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND source_id=$4 AND status<>'deleted'`,
        [
          input.identity.tenantId,
          input.identity.organizationId,
          input.identity.workspaceId,
          input.sourceId,
          input.visibility,
        ],
      )
      if (!updated.rowCount)
        throw new CorpusError('SOURCE_NOT_FOUND', 'Source was not found')
      await client.query(
        `DELETE FROM persistent_codex.source_acl_principals
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND source_id=$4`,
        [
          input.identity.tenantId,
          input.identity.organizationId,
          input.identity.workspaceId,
          input.sourceId,
        ],
      )
      for (const principalId of [...new Set(input.allowedPrincipalIds)].sort())
        await client.query(
          `INSERT INTO persistent_codex.source_acl_principals
           (tenant_id,organization_id,workspace_id,source_id,principal_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            input.identity.tenantId,
            input.identity.organizationId,
            input.identity.workspaceId,
            input.sourceId,
            principalId,
          ],
        )
      await this.#bumpCacheEpoch(client, input.identity)
    })
  }

  async retrievalCandidates(input: {
    identity: RetrievalIdentity
    query: string
    vector: number[] | null
    candidateLimit: number
    timeoutMs: number
  }) {
    return this.#transaction(input.identity, async (client) => {
      await client.query(`SELECT set_config('statement_timeout',$1,true)`, [
        String(input.timeoutMs),
      ])
      const scope = input.identity
      const acl = `(
        s.visibility='workspace' OR (
          s.visibility='principals' AND EXISTS (
            SELECT 1 FROM persistent_codex.source_acl_principals acl
            WHERE acl.tenant_id=s.tenant_id AND acl.organization_id=s.organization_id
              AND acl.workspace_id=s.workspace_id AND acl.source_id=s.source_id
              AND acl.principal_id=$4
          )
        )
      )`
      const lexical = await client.query(
        `SELECT s.tenant_id,s.organization_id,s.workspace_id,s.source_id,
                s.display_name,r.revision_id,r.content_hash source_content_hash,
                c.chunk_id,c.content_hash chunk_content_hash,c.content_text,c.locator,
                d.embedding_version,
                row_number() OVER (
                  ORDER BY ts_rank_cd(c.content_tsv,websearch_to_tsquery('simple',$5)) DESC,
                           s.source_id,c.chunk_id
                )::integer lexical_rank,
                ts_rank_cd(c.content_tsv,websearch_to_tsquery('simple',$5)) lexical_score
         FROM persistent_codex.corpus_chunks c
         JOIN persistent_codex.sources s USING (tenant_id,organization_id,workspace_id,source_id)
         JOIN persistent_codex.source_revisions r
           ON r.tenant_id=c.tenant_id AND r.organization_id=c.organization_id
          AND r.workspace_id=c.workspace_id AND r.source_id=c.source_id
          AND r.revision_id=c.revision_id
         JOIN persistent_codex.index_documents d
           ON d.tenant_id=c.tenant_id AND d.organization_id=c.organization_id
          AND d.workspace_id=c.workspace_id AND d.chunk_id=c.chunk_id
         WHERE c.tenant_id=$1 AND c.organization_id=$2 AND c.workspace_id=$3
           AND s.status='indexed' AND r.status='indexed' AND d.status='indexed'
           AND s.current_revision_id=r.revision_id AND c.content_text IS NOT NULL
           AND c.content_tsv @@ websearch_to_tsquery('simple',$5)
           AND ${acl}
         ORDER BY lexical_score DESC,s.source_id,c.chunk_id LIMIT $6`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          scope.principalId,
          input.query,
          input.candidateLimit,
        ],
      )
      const vector = input.vector
        ? await client.query(
            `SELECT s.tenant_id,s.organization_id,s.workspace_id,s.source_id,
                    s.display_name,r.revision_id,r.content_hash source_content_hash,
                    c.chunk_id,c.content_hash chunk_content_hash,c.content_text,c.locator,
                    d.embedding_version,
                    row_number() OVER (ORDER BY d.embedding <=> $5::vector,s.source_id,c.chunk_id)::integer vector_rank,
                    greatest(0,1-(d.embedding <=> $5::vector)) vector_score
             FROM persistent_codex.index_documents d
             JOIN persistent_codex.corpus_chunks c USING (tenant_id,organization_id,workspace_id,chunk_id,source_id,revision_id)
             JOIN persistent_codex.sources s USING (tenant_id,organization_id,workspace_id,source_id)
             JOIN persistent_codex.source_revisions r
               ON r.tenant_id=d.tenant_id AND r.organization_id=d.organization_id
              AND r.workspace_id=d.workspace_id AND r.source_id=d.source_id
              AND r.revision_id=d.revision_id
             WHERE d.tenant_id=$1 AND d.organization_id=$2 AND d.workspace_id=$3
               AND s.status='indexed' AND r.status='indexed' AND d.status='indexed'
               AND s.current_revision_id=r.revision_id AND c.content_text IS NOT NULL
               AND d.embedding IS NOT NULL AND ${acl}
             ORDER BY d.embedding <=> $5::vector,s.source_id,c.chunk_id LIMIT $6`,
            [
              scope.tenantId,
              scope.organizationId,
              scope.workspaceId,
              scope.principalId,
              `[${input.vector.join(',')}]`,
              input.candidateLimit,
            ],
          )
        : { rows: [] }
      const merged = new Map<string, RetrievalCandidate>()
      const read = (
        row: Row,
        kind: 'lexical' | 'vector',
      ): RetrievalCandidate => ({
        tenantId: String(row.tenant_id),
        organizationId: String(row.organization_id),
        workspaceId: String(row.workspace_id),
        sourceId: String(row.source_id),
        revisionId: String(row.revision_id),
        chunkId: String(row.chunk_id),
        sourceDisplayName: String(row.display_name),
        sourceContentHash: String(row.source_content_hash),
        chunkContentHash: String(row.chunk_content_hash),
        content: String(row.content_text),
        locator: row.locator as RetrievalCandidate['locator'],
        embeddingVersion: String(row.embedding_version),
        lexicalRank: kind === 'lexical' ? Number(row.lexical_rank) : null,
        lexicalScore: kind === 'lexical' ? Number(row.lexical_score) : 0,
        vectorRank: kind === 'vector' ? Number(row.vector_rank) : null,
        vectorScore: kind === 'vector' ? Number(row.vector_score) : 0,
      })
      for (const row of lexical.rows) {
        const value = read(row as Row, 'lexical')
        merged.set(value.chunkId, value)
      }
      for (const row of vector.rows) {
        const value = read(row as Row, 'vector')
        const current = merged.get(value.chunkId)
        merged.set(
          value.chunkId,
          current
            ? {
                ...current,
                vectorRank: value.vectorRank,
                vectorScore: value.vectorScore,
              }
            : value,
        )
      }
      return [...merged.values()]
    })
  }

  async citation(input: {
    identity: RetrievalIdentity
    sourceId: string
    revisionId: string
    chunkId: string
    timeoutMs: number
  }) {
    return this.#transaction(input.identity, async (client) => {
      await client.query(`SELECT set_config('statement_timeout',$1,true)`, [
        String(input.timeoutMs),
      ])
      const rows = await client.query(
        `SELECT s.tenant_id,s.organization_id,s.workspace_id,s.source_id,
                s.display_name,r.revision_id,r.content_hash source_content_hash,
                c.chunk_id,c.content_hash chunk_content_hash,c.content_text,c.locator,
                d.embedding_version
         FROM persistent_codex.corpus_chunks c
         JOIN persistent_codex.sources s USING (tenant_id,organization_id,workspace_id,source_id)
         JOIN persistent_codex.source_revisions r
           ON r.tenant_id=c.tenant_id AND r.organization_id=c.organization_id
          AND r.workspace_id=c.workspace_id AND r.source_id=c.source_id AND r.revision_id=c.revision_id
         JOIN persistent_codex.index_documents d
           ON d.tenant_id=c.tenant_id AND d.organization_id=c.organization_id
          AND d.workspace_id=c.workspace_id AND d.chunk_id=c.chunk_id
         WHERE c.tenant_id=$1 AND c.organization_id=$2 AND c.workspace_id=$3
           AND c.source_id=$4 AND c.revision_id=$5 AND c.chunk_id=$6
           AND s.status='indexed' AND r.status='indexed' AND d.status='indexed'
           AND s.current_revision_id=r.revision_id AND c.content_text IS NOT NULL
           AND (s.visibility='workspace' OR (s.visibility='principals' AND EXISTS (
             SELECT 1 FROM persistent_codex.source_acl_principals acl
             WHERE acl.tenant_id=s.tenant_id AND acl.organization_id=s.organization_id
               AND acl.workspace_id=s.workspace_id AND acl.source_id=s.source_id
               AND acl.principal_id=$7
           ))) LIMIT 1`,
        [
          input.identity.tenantId,
          input.identity.organizationId,
          input.identity.workspaceId,
          input.sourceId,
          input.revisionId,
          input.chunkId,
          input.identity.principalId,
        ],
      )
      if (!rows.rowCount) return null
      const row = rows.rows[0] as Row
      return {
        tenantId: String(row.tenant_id),
        organizationId: String(row.organization_id),
        workspaceId: String(row.workspace_id),
        sourceId: String(row.source_id),
        revisionId: String(row.revision_id),
        chunkId: String(row.chunk_id),
        sourceDisplayName: String(row.display_name),
        sourceContentHash: String(row.source_content_hash),
        chunkContentHash: String(row.chunk_content_hash),
        content: String(row.content_text),
        locator: row.locator as RetrievalCandidate['locator'],
        embeddingVersion: String(row.embedding_version),
        lexicalRank: null,
        lexicalScore: 0,
        vectorRank: null,
        vectorScore: 0,
      }
    })
  }

  async recordRetrievalEmbeddingUsage(input: {
    identity: RetrievalIdentity
    quantity: number
    completeness: 'complete' | 'partial'
    dedupeKey: string
  }) {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) return
    await this.#transaction(input.identity, async (client) => {
      await client.query(
        `INSERT INTO persistent_codex.sessions
         (organization_id,workspace_id,session_id,status)
         VALUES ($1,$2,$3,'active') ON CONFLICT DO NOTHING`,
        [
          input.identity.organizationId,
          input.identity.workspaceId,
          `corpus_usage_${input.identity.workspaceId}`,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.usage_ledger
         (organization_id,workspace_id,session_id,quantity,tenant_id,meter,dedupe_key,completeness)
         VALUES ($1,$2,$3,$4,$5,'retrieval_embedding_token',$6,$7)
         ON CONFLICT DO NOTHING`,
        [
          input.identity.organizationId,
          input.identity.workspaceId,
          `corpus_usage_${input.identity.workspaceId}`,
          input.quantity,
          input.identity.tenantId,
          input.dedupeKey,
          input.completeness,
        ],
      )
    })
  }

  async #bumpCacheEpoch(client: PoolClient, scope: CorpusScope) {
    await client.query(
      `INSERT INTO persistent_codex.corpus_cache_epochs
       (tenant_id,organization_id,workspace_id,epoch)
       VALUES ($1,$2,$3,1)
       ON CONFLICT (tenant_id,organization_id,workspace_id)
       DO UPDATE SET epoch=persistent_codex.corpus_cache_epochs.epoch+1,updated_at=now()`,
      [scope.tenantId, scope.organizationId, scope.workspaceId],
    )
  }

  async #insertAudit(client: PoolClient, audit: IngestionAudit) {
    await client.query(
      `INSERT INTO persistent_codex.ingestion_audit (tenant_id,organization_id,workspace_id,audit_id,source_id,revision_id,job_id,action,outcome,reason_code,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        audit.tenantId,
        audit.organizationId,
        audit.workspaceId,
        audit.auditId,
        audit.sourceId,
        audit.revisionId,
        audit.jobId,
        audit.action,
        audit.outcome,
        audit.reasonCode,
        audit.occurredAt,
      ],
    )
  }

  async close() {
    if (this.#ownsPool) await this.#pool.end()
  }
}

export function createPostgresCorpusRepository(input: {
  connectionString: string
}) {
  return new PostgresCorpusRepository(
    new Pool({ connectionString: input.connectionString }),
    { ownsPool: true },
  )
}
