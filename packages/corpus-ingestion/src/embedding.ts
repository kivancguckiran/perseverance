export const EMBEDDING_PROVIDER_PORT_VERSION = 1 as const

export interface EmbeddingResult {
  vector: number[] | null
  tokenCount: number
  completeness: 'complete' | 'partial'
  providerRequestId: string | null
}

export interface EmbeddingProvider {
  readonly version: typeof EMBEDDING_PROVIDER_PORT_VERSION
  readonly kind: 'production' | 'fake-test'
  readonly embeddingVersion: string
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

  async embed(): Promise<EmbeddingResult> {
    return {
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
  calls = 0

  async embed(input: { texts: string[] }): Promise<EmbeddingResult> {
    this.calls++
    return {
      vector: null,
      tokenCount: input.texts.reduce(
        (total, text) => total + Math.ceil(Buffer.byteLength(text, 'utf8') / 4),
        0,
      ),
      completeness: 'complete',
      providerRequestId: `fake-${this.calls}`,
    }
  }
}
