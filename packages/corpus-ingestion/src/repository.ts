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

export const CORPUS_REPOSITORY_VERSION = 1 as const

export interface CorpusRepository {
  readonly version: typeof CORPUS_REPOSITORY_VERSION
  readonly adapter: 'postgresql'
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
    chunks: CorpusChunk[]
    indexDocuments: IndexDocument[]
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
      await this.#insertAudit(client, input.audit)
      return { source: s, revision: r, job: j, created: true }
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
    chunks: CorpusChunk[]
    indexDocuments: IndexDocument[]
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
      for (const chunk of input.chunks)
        await client.query(
          `INSERT INTO persistent_codex.corpus_chunks
           (tenant_id,organization_id,workspace_id,chunk_id,source_id,revision_id,ordinal,content_hash,locator,chunking_policy,metadata,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (tenant_id,organization_id,workspace_id,revision_id,ordinal) DO NOTHING`,
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
          ],
        )
      for (const doc of input.indexDocuments)
        await client.query(
          `INSERT INTO persistent_codex.index_documents
           (tenant_id,organization_id,workspace_id,index_document_id,chunk_id,source_id,revision_id,content_hash,embedding_version,embedding_token_count,status,derived_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (tenant_id,organization_id,workspace_id,chunk_id,embedding_version) DO NOTHING`,
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
          ],
        )
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
        revisionId: source(rows.rows[0] as Row).currentRevisionId,
        jobId: null,
        action: 'source.deleted',
        outcome: 'success',
        reasonCode: 'SOURCE_TOMBSTONED',
        occurredAt: new Date().toISOString(),
      })
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
