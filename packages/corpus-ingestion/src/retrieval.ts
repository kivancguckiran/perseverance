import { createHash } from 'node:crypto'
import type {
  CorpusCitationLookupRequest,
  CorpusCitationLookupResponse,
  CorpusLocator,
  CorpusSearchRequest,
  CorpusSearchResponse,
  CorpusSearchResult,
} from '@persistent-codex/control-plane-contracts'
import { CorpusError, type CorpusScope } from './index'
import {
  EmbeddingProviderError,
  NoopEmbeddingProvider,
  type EmbeddingProvider,
} from './embedding'

export const CORPUS_RETRIEVAL_SERVICE_VERSION = 1 as const
export const ACTIVE_INDEX_VERSION = 'corpus-index-v1'
export const ACTIVE_RANKING_POLICY_VERSION = 'hybrid-rrf-v1'

export interface RetrievalIdentity extends CorpusScope {
  principalId: string
}

export interface RetrievalCandidate extends CorpusScope {
  sourceId: string
  revisionId: string
  chunkId: string
  sourceDisplayName: string
  sourceContentHash: string
  chunkContentHash: string
  content: string
  locator: CorpusLocator
  embeddingVersion: string
  lexicalRank: number | null
  lexicalScore: number
  vectorRank: number | null
  vectorScore: number
}

export interface CorpusRetrievalRepository {
  retrievalCandidates(input: {
    identity: RetrievalIdentity
    query: string
    vector: number[] | null
    candidateLimit: number
    timeoutMs: number
  }): Promise<RetrievalCandidate[]>
  citation(input: {
    identity: RetrievalIdentity
    sourceId: string
    revisionId: string
    chunkId: string
    timeoutMs: number
  }): Promise<RetrievalCandidate | null>
  corpusCacheEpoch(scope: CorpusScope): Promise<number>
  recordRetrievalEmbeddingUsage(input: {
    identity: RetrievalIdentity
    quantity: number
    completeness: 'complete' | 'partial'
    dedupeKey: string
  }): Promise<void>
}

interface CacheEntry {
  expiresAt: number
  bytes: number
  value: CorpusSearchResponse
}

export class CorpusSearchCache {
  readonly #entries = new Map<string, CacheEntry>()
  readonly #maxEntries: number
  readonly #maxBytes: number
  readonly #ttlMs: number
  #bytes = 0

  constructor(
    options: { maxEntries?: number; maxBytes?: number; ttlMs?: number } = {},
  ) {
    this.#maxEntries = options.maxEntries ?? 256
    this.#maxBytes = options.maxBytes ?? 8 * 1024 * 1024
    this.#ttlMs = options.ttlMs ?? 30_000
  }

  get(key: string, now = Date.now()) {
    const entry = this.#entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= now) {
      this.#delete(key, entry)
      return null
    }
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return structuredClone(entry.value)
  }

  set(key: string, value: CorpusSearchResponse, now = Date.now()) {
    const serialized = JSON.stringify(value)
    const bytes = Buffer.byteLength(serialized)
    if (bytes > this.#maxBytes) return
    const previous = this.#entries.get(key)
    if (previous) this.#delete(key, previous)
    this.#entries.set(key, {
      expiresAt: now + this.#ttlMs,
      bytes,
      value: structuredClone(value),
    })
    this.#bytes += bytes
    while (
      this.#entries.size > this.#maxEntries ||
      this.#bytes > this.#maxBytes
    ) {
      const oldest = this.#entries.entries().next().value as
        [string, CacheEntry] | undefined
      if (!oldest) break
      this.#delete(oldest[0], oldest[1])
    }
  }

  get size() {
    return this.#entries.size
  }

  get byteLength() {
    return this.#bytes
  }

  #delete(key: string, entry: CacheEntry) {
    this.#entries.delete(key)
    this.#bytes -= entry.bytes
  }
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function estimateTokens(value: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 4))
}

function encodeCursor(input: {
  offset: number
  fingerprint: string
  epoch: number
}) {
  return Buffer.from(JSON.stringify({ version: 1, ...input })).toString(
    'base64url',
  )
}

function decodeCursor(
  value: string | null,
  fingerprint: string,
  epoch: number,
) {
  if (!value) return 0
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as {
      version?: unknown
      offset?: unknown
      fingerprint?: unknown
      epoch?: unknown
    }
    if (
      parsed.version !== 1 ||
      !Number.isInteger(parsed.offset) ||
      Number(parsed.offset) < 0 ||
      parsed.fingerprint !== fingerprint ||
      parsed.epoch !== epoch
    )
      throw new Error('invalid')
    return Number(parsed.offset)
  } catch {
    throw new CorpusError(
      'INVALID_SEARCH_CURSOR',
      'Search cursor is invalid or stale',
    )
  }
}

export class HybridCorpusRetrievalService {
  readonly version = CORPUS_RETRIEVAL_SERVICE_VERSION
  readonly #repository: CorpusRetrievalRepository
  readonly #embedding: EmbeddingProvider
  readonly #cache: CorpusSearchCache
  readonly #now: () => Date

  constructor(input: {
    repository: CorpusRetrievalRepository
    embeddingProvider?: EmbeddingProvider
    cache?: CorpusSearchCache
    now?: () => Date
  }) {
    this.#repository = input.repository
    this.#embedding = input.embeddingProvider ?? new NoopEmbeddingProvider()
    this.#cache = input.cache ?? new CorpusSearchCache()
    this.#now = input.now ?? (() => new Date())
  }

  async search(identity: RetrievalIdentity, request: CorpusSearchRequest) {
    if (
      identity.tenantId !== request.tenantId ||
      identity.organizationId !== request.organizationId ||
      identity.workspaceId !== request.workspaceId
    )
      throw new CorpusError(
        'SEARCH_SCOPE_MISMATCH',
        'Search scope does not match runtime identity',
      )
    const epoch = await this.#repository.corpusCacheEpoch(identity)
    const fingerprint = digest(
      JSON.stringify([
        identity.tenantId,
        identity.organizationId,
        identity.workspaceId,
        identity.principalId,
        request.query,
        request.topK,
        request.tokenBudget,
        request.rankingPolicyVersion,
      ]),
    )
    const offset = decodeCursor(request.cursor, fingerprint, epoch)
    const cacheKey = JSON.stringify([fingerprint, epoch, offset])
    const cached = this.#cache.get(cacheKey)
    if (cached) return cached

    const embeddingKey = `retrieval:${this.#embedding.embeddingVersion}:${epoch}:${digest(request.query)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), request.queryTimeoutMs)
    let vector: number[] | null = null
    try {
      const embedded = await this.#embedding.embed({
        texts: [request.query],
        idempotencyKey: embeddingKey,
        signal: controller.signal,
      })
      vector = embedded.vectors[0] ?? embedded.vector
      if (
        vector &&
        (this.#embedding.dimensions !== 384 || vector.length !== 384)
      )
        throw new CorpusError(
          'EMBEDDING_DIMENSION_MISMATCH',
          'Query embedding does not match the active index',
        )
      if (
        this.#embedding.kind === 'production' &&
        this.#embedding.embeddingVersion !== 'unembedded-placeholder-v1' &&
        embedded.tokenCount > 0
      )
        await this.#repository.recordRetrievalEmbeddingUsage({
          identity,
          quantity: embedded.tokenCount,
          completeness: embedded.completeness,
          dedupeKey: embeddingKey,
        })
    } catch (error) {
      if (error instanceof EmbeddingProviderError && error.tokenCount > 0)
        await this.#repository.recordRetrievalEmbeddingUsage({
          identity,
          quantity: error.tokenCount,
          completeness: 'partial',
          dedupeKey: embeddingKey,
        })
      throw error
    } finally {
      clearTimeout(timer)
    }

    const candidateLimit = Math.min(
      200,
      Math.max(request.topK * 8, request.topK + offset),
    )
    const candidates = await this.#repository.retrievalCandidates({
      identity,
      query: request.query,
      vector,
      candidateLimit,
      timeoutMs: request.queryTimeoutMs,
    })
    const ranked = candidates
      .map((candidate) => {
        const reciprocalRankFusion =
          (candidate.lexicalRank ? 1 / (60 + candidate.lexicalRank) : 0) +
          (candidate.vectorRank ? 1 / (60 + candidate.vectorRank) : 0)
        const exactBoost = candidate.content
          .toLocaleLowerCase('en-US')
          .includes(request.query.toLocaleLowerCase('en-US'))
          ? 0.01
          : 0
        return {
          candidate,
          reciprocalRankFusion,
          final: reciprocalRankFusion + exactBoost,
        }
      })
      .sort(
        (left, right) =>
          right.final - left.final ||
          left.candidate.sourceId.localeCompare(right.candidate.sourceId) ||
          left.candidate.chunkId.localeCompare(right.candidate.chunkId),
      )
    const page = ranked.slice(offset, offset + request.topK)
    const results: CorpusSearchResult[] = []
    let tokens = 0
    let truncatedByTokenBudget = false
    for (const entry of page) {
      const estimatedTokens = estimateTokens(entry.candidate.content)
      if (tokens + estimatedTokens > request.tokenBudget) {
        truncatedByTokenBudget = true
        break
      }
      tokens += estimatedTokens
      results.push({
        sourceId: entry.candidate.sourceId,
        revisionId: entry.candidate.revisionId,
        chunkId: entry.candidate.chunkId,
        content: entry.candidate.content,
        trust: 'untrusted_context',
        score: {
          lexical: entry.candidate.lexicalScore,
          vector: entry.candidate.vectorScore,
          reciprocalRankFusion: entry.reciprocalRankFusion,
          final: entry.final,
        },
        citation: {
          citationVersion: 1,
          sourceId: entry.candidate.sourceId,
          revisionId: entry.candidate.revisionId,
          chunkId: entry.candidate.chunkId,
          sourceDisplayName: entry.candidate.sourceDisplayName,
          sourceContentHash: entry.candidate.sourceContentHash,
          chunkContentHash: entry.candidate.chunkContentHash,
          locator: entry.candidate.locator,
        },
        estimatedTokens,
      })
    }
    const nextOffset = offset + results.length
    const exhausted = nextOffset >= ranked.length || results.length === 0
    const response: CorpusSearchResponse = {
      schemaVersion: 1,
      tenantId: identity.tenantId,
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      rankingPolicyVersion: ACTIVE_RANKING_POLICY_VERSION,
      indexVersion: ACTIVE_INDEX_VERSION,
      embeddingVersion: this.#embedding.embeddingVersion,
      results,
      nextCursor: exhausted
        ? null
        : encodeCursor({ offset: nextOffset, fingerprint, epoch }),
      exhausted,
      truncatedByTokenBudget,
    }
    this.#cache.set(cacheKey, response, this.#now().getTime())
    return response
  }

  async getCitation(
    identity: RetrievalIdentity,
    request: CorpusCitationLookupRequest,
    timeoutMs = 1_500,
  ): Promise<CorpusCitationLookupResponse> {
    if (
      identity.tenantId !== request.tenantId ||
      identity.organizationId !== request.organizationId ||
      identity.workspaceId !== request.workspaceId
    )
      throw new CorpusError(
        'CITATION_SCOPE_MISMATCH',
        'Citation scope does not match runtime identity',
      )
    const candidate = await this.#repository.citation({
      identity,
      sourceId: request.sourceId,
      revisionId: request.revisionId,
      chunkId: request.chunkId,
      timeoutMs,
    })
    if (!candidate)
      throw new CorpusError(
        'CITATION_NOT_FOUND',
        'Citation is not current or accessible',
      )
    return {
      schemaVersion: 1,
      trust: 'untrusted_context',
      content: candidate.content,
      citation: {
        citationVersion: 1,
        sourceId: candidate.sourceId,
        revisionId: candidate.revisionId,
        chunkId: candidate.chunkId,
        sourceDisplayName: candidate.sourceDisplayName,
        sourceContentHash: candidate.sourceContentHash,
        chunkContentHash: candidate.chunkContentHash,
        locator: candidate.locator,
      },
    }
  }
}
