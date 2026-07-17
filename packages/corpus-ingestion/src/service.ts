import { createHash, randomUUID } from 'node:crypto'
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
  DEFAULT_CORPUS_LIMITS,
  extractDocumentBounded,
  sniffMediaType,
  type CorpusLimits,
  type CorpusScope,
  type EmbeddingUsageRecord,
} from './index'
import {
  EmbeddingProviderError,
  NoopEmbeddingProvider,
  type EmbeddingProvider,
} from './embedding'
import type { CorpusRepository } from './repository'
import type { CorpusSnapshotStorage } from './storage'
import { PDF_PARSER_VERSION } from './pdf-parser'

export const CORPUS_INGESTION_SERVICE_VERSION = 1 as const

const digest = (value: Uint8Array | string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

function safeName(value: string) {
  const name = value.trim()
  if (
    !name ||
    name.length > 255 ||
    /[\\/\0\r\n]/.test(name) ||
    name === '.' ||
    name === '..'
  )
    throw new CorpusError('INVALID_SOURCE_NAME', 'Source name is invalid')
  return name
}

function sourceKind(mediaType: SourceRevision['mediaType']): Source['kind'] {
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType === 'text/markdown') return 'markdown'
  if (mediaType === 'text/plain') return 'text'
  return 'code'
}

function language(mediaType: SourceRevision['mediaType']) {
  return (
    (
      {
        'application/json': 'json',
        'application/javascript': 'javascript',
        'application/typescript': 'typescript',
        'text/css': 'css',
        'text/html': 'html',
        'text/x-python': 'python',
        'text/x-rust': 'rust',
        'text/x-shellscript': 'shell',
      } as Partial<Record<SourceRevision['mediaType'], string>>
    )[mediaType] ?? 'und'
  )
}

export class CorpusIngestionService {
  readonly version = CORPUS_INGESTION_SERVICE_VERSION
  readonly repository: CorpusRepository
  readonly storage: CorpusSnapshotStorage
  readonly #limits: CorpusLimits
  readonly #embedding: EmbeddingProvider
  readonly #now: () => Date

  constructor(input: {
    repository: CorpusRepository
    storage: CorpusSnapshotStorage
    embeddingProvider?: EmbeddingProvider
    limits?: Partial<CorpusLimits>
    now?: () => Date
  }) {
    this.repository = input.repository
    this.storage = input.storage
    this.#embedding = input.embeddingProvider ?? new NoopEmbeddingProvider()
    this.#limits = { ...DEFAULT_CORPUS_LIMITS, ...input.limits }
    this.#now = input.now ?? (() => new Date())
  }

  async createSource(input: {
    scope: CorpusScope
    name: string
    declaredMediaType?: string
    chunks: AsyncIterable<Uint8Array>
    provenance?: { kind: 'upload' | 'workspace_file'; workspacePath?: string }
  }) {
    const name = safeName(input.name)
    const sourceId = `src_${randomUUID()}`
    const revisionId = `rev_${randomUUID()}`
    const stored = await this.storage.put({
      scope: input.scope,
      revisionId,
      chunks: input.chunks,
      maxBytes: this.#limits.maxBytes,
    })
    let registered = false
    try {
      const bytes = await this.storage.read({
        scope: input.scope,
        storageKey: stored.storageKey,
        maxBytes: this.#limits.maxBytes,
      })
      const mediaType = sniffMediaType(name, bytes.subarray(0, 8192))
      if (
        input.declaredMediaType &&
        input.declaredMediaType !== 'application/octet-stream' &&
        input.declaredMediaType !== mediaType
      )
        throw new CorpusError(
          'MIME_MISMATCH',
          'Declared and detected media types differ',
        )
      const timestamp = this.#now().toISOString()
      const source: Source = {
        version: 1,
        ...input.scope,
        sourceId,
        kind: sourceKind(mediaType),
        displayName: name,
        status: 'pending',
        currentRevisionId: revisionId,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      }
      const revision: SourceRevision = {
        version: 1,
        ...input.scope,
        sourceId,
        revisionId,
        contentHash: stored.contentHash,
        byteLength: stored.byteLength,
        mediaType,
        parserVersion:
          mediaType === 'application/pdf'
            ? PDF_PARSER_VERSION
            : 'corpus-text-parser-v1',
        language: language(mediaType),
        provenance: {
          kind: input.provenance?.kind ?? 'upload',
          originalName: name,
          workspacePath: input.provenance?.workspacePath ?? null,
        },
        rawSnapshot: {
          immutable: true,
          storageKey: stored.storageKey,
          createdAt: stored.createdAt,
        },
        status: 'pending',
        createdAt: timestamp,
      }
      const job: ExtractionJob = {
        version: 1,
        ...input.scope,
        jobId: `job_${randomUUID()}`,
        sourceId,
        revisionId,
        status: 'pending',
        attempt: 1,
        maxAttempts: this.#limits.maxAttempts,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAt: null,
        errorCode: null,
        usageCompleteness: 'partial',
        startedAt: null,
        completedAt: null,
        updatedAt: timestamp,
      }
      const audit: IngestionAudit = {
        version: 1,
        ...input.scope,
        auditId: `iaud_${randomUUID()}`,
        sourceId,
        revisionId,
        jobId: job.jobId,
        action: 'source.created',
        outcome: 'success',
        reasonCode: 'SOURCE_REGISTERED',
        occurredAt: timestamp,
      }
      const result = await this.repository.registerSource({
        scope: input.scope,
        source,
        revision,
        job,
        audit,
      })
      registered = result.created
      if (!result.created)
        await this.storage.delete({
          scope: input.scope,
          storageKey: stored.storageKey,
        })
      return {
        source: result.source,
        revision: result.revision,
        job: result.job,
      }
    } catch (error) {
      if (!registered) {
        try {
          await this.storage.delete({
            scope: input.scope,
            storageKey: stored.storageKey,
          })
        } catch {
          await this.repository.enqueueSnapshotCleanup(
            input.scope,
            stored.storageKey,
            'SOURCE_CREATE_ROLLBACK',
          )
        }
      }
      throw error
    }
  }

  listSources(scope: CorpusScope) {
    return this.repository.listSources(scope)
  }
  sourceDetail(scope: CorpusScope, sourceId: string) {
    return this.repository.sourceDetail(scope, sourceId)
  }
  recoverableScopes() {
    return this.repository.recoverableScopes()
  }
  claimNext(scope: CorpusScope, workerId: string) {
    return this.repository.claimNext(scope, workerId, this.#limits.leaseMs)
  }

  async processJob(scope: CorpusScope, jobId: string, workerId: string) {
    const context = await this.repository.jobContext(scope, jobId, workerId)
    let interruptedUsage: EmbeddingUsageRecord | null = null
    try {
      const bytes = await this.storage.read({
        scope,
        storageKey: context.revision.rawSnapshot.storageKey,
        maxBytes: this.#limits.maxBytes,
      })
      if (
        bytes.byteLength !== context.revision.byteLength ||
        digest(bytes) !== context.revision.contentHash
      )
        throw new CorpusError(
          'SNAPSHOT_INTEGRITY_FAILED',
          'Snapshot integrity check failed',
        )
      const extracted = await extractDocumentBounded({
        mediaType: context.revision.mediaType,
        bytes,
        limits: this.#limits,
      })
      const chunks: CorpusChunk[] = extracted.map((entry, ordinal) => {
        const contentHash = digest(entry.text)
        const chunkId = `chk_${createHash('sha256').update(`${context.revision.revisionId}\0${ordinal}\0${contentHash}`).digest('hex')}`
        return {
          version: 1,
          ...scope,
          chunkId,
          sourceId: context.source.sourceId,
          revisionId: context.revision.revisionId,
          ordinal,
          contentHash,
          locator: entry.locator,
          chunkingPolicy: {
            version: 'character-lines-v1',
            maxCharacters: this.#limits.maxChunkCharacters,
            overlapCharacters: this.#limits.overlapCharacters,
          },
          metadata: {
            mediaType: context.revision.mediaType,
            parserVersion: context.revision.parserVersion,
          },
          createdAt: this.#now().toISOString(),
        }
      })
      const embeddingKey = `embedding:${context.revision.revisionId}:${this.#embedding.embeddingVersion}`
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(),
        this.#limits.parserTimeoutMs,
      )
      let embedding
      try {
        embedding = await this.#embedding.embed({
          texts: extracted.map((entry) => entry.text),
          idempotencyKey: embeddingKey,
          signal: controller.signal,
        })
      } catch (error) {
        if (
          error instanceof EmbeddingProviderError &&
          this.#embedding.kind === 'production' &&
          this.#embedding.embeddingVersion !== 'unembedded-placeholder-v1' &&
          error.tokenCount > 0
        )
          interruptedUsage = {
            ...scope,
            usageId: `iusg_${randomUUID()}`,
            sourceId: context.source.sourceId,
            revisionId: context.revision.revisionId,
            jobId,
            meter: 'index_embedding_token',
            quantity: error.tokenCount,
            completeness: 'partial',
            dedupeKey: embeddingKey,
            occurredAt: this.#now().toISOString(),
          }
        throw error
      } finally {
        clearTimeout(timer)
      }
      const documents: IndexDocument[] = chunks.map((chunk) => ({
        version: 1,
        ...scope,
        indexDocumentId: `idx_${chunk.chunkId.slice(4)}`,
        chunkId: chunk.chunkId,
        sourceId: chunk.sourceId,
        revisionId: chunk.revisionId,
        contentHash: chunk.contentHash,
        embeddingVersion: this.#embedding.embeddingVersion,
        embeddingTokenCount:
          this.#embedding.embeddingVersion === 'unembedded-placeholder-v1'
            ? 0
            : embedding.tokenCount,
        status: 'indexed',
        derivedAt: this.#now().toISOString(),
      }))
      const usage: EmbeddingUsageRecord | null =
        this.#embedding.kind === 'production' &&
        this.#embedding.embeddingVersion !== 'unembedded-placeholder-v1' &&
        embedding.tokenCount > 0
          ? {
              ...scope,
              usageId: `iusg_${randomUUID()}`,
              sourceId: context.source.sourceId,
              revisionId: context.revision.revisionId,
              jobId,
              meter: 'index_embedding_token',
              quantity: embedding.tokenCount,
              completeness: embedding.completeness,
              dedupeKey: embeddingKey,
              occurredAt: this.#now().toISOString(),
            }
          : null
      return await this.repository.completeJob({
        scope,
        jobId,
        workerId,
        chunks,
        indexDocuments: documents,
        usage,
      })
    } catch (error) {
      const code = error instanceof CorpusError ? error.code : 'PARSER_FAILED'
      await this.repository.failJob({
        scope,
        jobId,
        workerId,
        errorCode: code,
        usage: interruptedUsage,
      })
      throw error
    }
  }

  async deleteSource(scope: CorpusScope, sourceId: string) {
    const detail = await this.repository.sourceDetail(scope, sourceId)
    const deleted = await this.repository.deleteSource(scope, sourceId)
    for (const revision of detail.revisions) {
      try {
        await this.storage.delete({
          scope,
          storageKey: revision.rawSnapshot.storageKey,
        })
        const cleanup = (await this.repository.listPendingCleanup(scope)).find(
          (item) => item.storageKey === revision.rawSnapshot.storageKey,
        )
        if (cleanup)
          await this.repository.completeCleanup(scope, cleanup.cleanupId)
      } catch {
        await this.repository.enqueueSnapshotCleanup(
          scope,
          revision.rawSnapshot.storageKey,
          'SOURCE_DELETE',
        )
      }
    }
    return deleted
  }

  reindexSource(scope: CorpusScope, sourceId: string) {
    return this.repository.reindexSource(
      scope,
      sourceId,
      this.#limits.maxAttempts,
    )
  }

  async drainCleanup(scope: CorpusScope) {
    for (const pending of await this.repository.listPendingCleanup(scope)) {
      await this.storage.delete({ scope, storageKey: pending.storageKey })
      await this.repository.completeCleanup(scope, pending.cleanupId)
    }
  }

  async close() {
    await this.repository.close()
  }
}
