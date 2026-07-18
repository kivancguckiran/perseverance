export const EMBEDDING_PROVIDER_PORT_VERSION = 1 as const

export interface EmbeddingResult {
  vectors: Array<number[] | null>
  /** @deprecated Use vectors; retained for provider adapter compatibility. */
  vector: number[] | null
  tokenCount: number
  completeness: 'complete' | 'partial'
  providerRequestId: string | null
}

export interface EmbeddingProvider {
  readonly version: typeof EMBEDDING_PROVIDER_PORT_VERSION
  readonly kind: 'production' | 'fake-test'
  readonly embeddingVersion: string
  readonly dimensions: number | null
  embed(input: {
    texts: string[]
    idempotencyKey: string
    signal: AbortSignal
  }): Promise<EmbeddingResult>
}

export class EmbeddingProviderError extends Error {
  readonly tokenCount: number
  readonly providerRequestId: string | null
  constructor(tokenCount: number, providerRequestId: string | null = null) {
    super('Embedding provider call was interrupted')
    this.name = 'EmbeddingProviderError'
    this.tokenCount = tokenCount
    this.providerRequestId = providerRequestId
  }
}

export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly version = EMBEDDING_PROVIDER_PORT_VERSION
  readonly kind = 'production' as const
  readonly embeddingVersion = 'unembedded-placeholder-v1'
  readonly dimensions = null

  async embed(input: { texts: string[] }): Promise<EmbeddingResult> {
    return {
      vectors: input.texts.map(() => null),
      vector: null,
      tokenCount: 0,
      completeness: 'complete',
      providerRequestId: null,
    }
  }
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly version = EMBEDDING_PROVIDER_PORT_VERSION
  readonly kind = 'fake-test' as const
  readonly embeddingVersion = 'fake-embedding-test-v1'
  readonly dimensions = 384
  calls = 0

  async embed(input: { texts: string[] }): Promise<EmbeddingResult> {
    this.calls++
    const vectors = input.texts.map((text) => deterministicVector(text))
    return {
      vectors,
      vector: vectors[0] ?? null,
      tokenCount: input.texts.reduce(
        (total, text) => total + Math.ceil(Buffer.byteLength(text, 'utf8') / 4),
        0,
      ),
      completeness: 'complete',
      providerRequestId: `fake-${this.calls}`,
    }
  }
}

function deterministicVector(text: string) {
  const tokens =
    text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_-]+/gu) ?? []
  const vector = Array.from({ length: 384 }, () => 0)
  for (const token of tokens) {
    let hash = 2166136261
    for (const character of token) {
      hash ^= character.codePointAt(0) ?? 0
      hash = Math.imul(hash, 16777619)
    }
    vector[Math.abs(hash) % vector.length]! += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm === 0 ? vector : vector.map((value) => value / norm)
}
