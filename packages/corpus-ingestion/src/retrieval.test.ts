import { describe, expect, it } from 'vitest'
import type { CorpusSearchRequest } from '@perseverance/control-plane-contracts'
import {
  CorpusSearchCache,
  HybridCorpusRetrievalService,
  type CorpusRetrievalRepository,
  type RetrievalCandidate,
  type RetrievalIdentity,
} from './retrieval'
import type { EmbeddingProvider } from './embedding'

const identity: RetrievalIdentity = {
  tenantId: 'tenant_a',
  organizationId: 'tenant_a',
  workspaceId: 'workspace_a',
  principalId: 'principal_a',
}

const request = (query: string): CorpusSearchRequest => ({
  schemaVersion: 1,
  tenantId: identity.tenantId,
  organizationId: identity.organizationId,
  workspaceId: identity.workspaceId,
  query,
  topK: 10,
  tokenBudget: 2_048,
  cursor: null,
  rankingPolicyVersion: 'hybrid-rrf-v1',
  queryTimeoutMs: 500,
})

function candidate(
  input: Partial<RetrievalCandidate> & Pick<RetrievalCandidate, 'chunkId'>,
): RetrievalCandidate {
  return {
    ...identity,
    sourceId: input.sourceId ?? `src_${input.chunkId}`,
    revisionId: input.revisionId ?? `rev_${input.chunkId}`,
    chunkId: input.chunkId,
    sourceDisplayName: input.sourceDisplayName ?? `${input.chunkId}.md`,
    sourceContentHash: `sha256:${'a'.repeat(64)}`,
    chunkContentHash: `sha256:${'b'.repeat(64)}`,
    content: input.content ?? 'bounded corpus content',
    locator: input.locator ?? { kind: 'line', lineStart: 1, lineEnd: 2 },
    embeddingVersion: 'fixture-384-v1',
    lexicalRank: input.lexicalRank ?? null,
    lexicalScore: input.lexicalScore ?? 0,
    vectorRank: input.vectorRank ?? null,
    vectorScore: input.vectorScore ?? 0,
  }
}

class FixtureRepository implements CorpusRetrievalRepository {
  epoch = 1
  calls = 0
  usage: Array<{ quantity: number; completeness: string; dedupeKey: string }> =
    []
  candidates: RetrievalCandidate[] = []
  async retrievalCandidates() {
    this.calls++
    return this.candidates
  }
  async citation(input: {
    sourceId: string
    revisionId: string
    chunkId: string
  }) {
    return (
      this.candidates.find(
        (value) =>
          value.sourceId === input.sourceId &&
          value.revisionId === input.revisionId &&
          value.chunkId === input.chunkId,
      ) ?? null
    )
  }
  async corpusCacheEpoch() {
    return this.epoch
  }
  async recordRetrievalEmbeddingUsage(input: {
    quantity: number
    completeness: 'complete' | 'partial'
    dedupeKey: string
  }) {
    if (!this.usage.some((value) => value.dedupeKey === input.dedupeKey))
      this.usage.push(input)
  }
}

const productionEmbedding: EmbeddingProvider = {
  version: 1,
  kind: 'production',
  embeddingVersion: 'fixture-384-v1',
  dimensions: 384,
  async embed({ texts }) {
    return {
      vectors: texts.map(() => Array.from({ length: 384 }, () => 0.01)),
      vector: Array.from({ length: 384 }, () => 0.01),
      tokenCount: 7,
      completeness: 'complete',
      providerRequestId: 'fixture-request',
    }
  },
}

describe('WP22 hybrid retrieval policy', () => {
  it('deterministically ranks exact lexical, semantic and mixed candidates with immutable citations', async () => {
    const repository = new FixtureRepository()
    repository.candidates = [
      candidate({ chunkId: 'semantic', vectorRank: 1, vectorScore: 0.96 }),
      candidate({
        chunkId: 'mixed',
        content: 'the exact mixed needle appears here',
        lexicalRank: 2,
        lexicalScore: 0.7,
        vectorRank: 2,
        vectorScore: 0.8,
      }),
      candidate({
        chunkId: 'lexical',
        content: 'exact mixed needle',
        lexicalRank: 1,
        lexicalScore: 1,
      }),
    ]
    const service = new HybridCorpusRetrievalService({
      repository,
      embeddingProvider: productionEmbedding,
    })
    const response = await service.search(identity, request('mixed needle'))
    expect(response.results.map((result) => result.chunkId)).toEqual([
      'mixed',
      'lexical',
      'semantic',
    ])
    expect(response.results[0]).toMatchObject({
      trust: 'untrusted_context',
      citation: {
        sourceId: 'src_mixed',
        revisionId: 'rev_mixed',
        chunkId: 'mixed',
        locator: { kind: 'line', lineStart: 1, lineEnd: 2 },
      },
    })
    expect(repository.usage).toHaveLength(1)
  })

  it('namespaces cache by principal and epoch and keeps memory bounded', async () => {
    const repository = new FixtureRepository()
    repository.candidates = [candidate({ chunkId: 'one', lexicalRank: 1 })]
    const cache = new CorpusSearchCache({ maxEntries: 1, maxBytes: 8_192 })
    const service = new HybridCorpusRetrievalService({ repository, cache })
    await service.search(identity, request('one'))
    await service.search(identity, request('one'))
    expect(repository.calls).toBe(1)
    await service.search(
      { ...identity, principalId: 'principal_b' },
      request('one'),
    )
    expect(repository.calls).toBe(2)
    repository.epoch++
    await service.search(identity, request('one'))
    expect(repository.calls).toBe(3)
    expect(cache.size).toBe(1)
    expect(cache.byteLength).toBeLessThanOrEqual(8_192)
  })

  it('enforces token budget and rejects a cross-scope request before retrieval', async () => {
    const repository = new FixtureRepository()
    repository.candidates = [
      candidate({
        chunkId: 'large',
        lexicalRank: 1,
        content: 'x'.repeat(2_000),
      }),
    ]
    const service = new HybridCorpusRetrievalService({ repository })
    const bounded = await service.search(identity, {
      ...request('large'),
      tokenBudget: 64,
    })
    expect(bounded.results).toEqual([])
    expect(bounded.truncatedByTokenBudget).toBe(true)
    await expect(
      service.search(identity, { ...request('large'), tenantId: 'tenant_b' }),
    ).rejects.toMatchObject({ code: 'SEARCH_SCOPE_MISMATCH' })
  })
})
