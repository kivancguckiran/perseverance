import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CorpusError,
  extractDocument,
  LocalCorpusRegistry,
  singleChunk,
  sniffMediaType,
} from './index'

const fixture = (name: string) =>
  readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url))
const scope = {
  tenantId: 'tenant_a',
  organizationId: 'tenant_a',
  workspaceId: 'workspace_a',
}
const roots: string[] = []
function registry(
  options: ConstructorParameters<typeof LocalCorpusRegistry>[1] = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'wp21-corpus-'))
  roots.push(root)
  return { root, value: new LocalCorpusRegistry(root, options) }
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('WP21 golden extraction', () => {
  it.each([
    ['golden.pdf', 'application/pdf', 'page'],
    ['golden.md', 'text/markdown', 'line'],
    ['golden.txt', 'text/plain', 'line'],
  ] as const)(
    'extracts %s with stable citation locators',
    (name, mediaType, locator) => {
      const bytes = fixture(name)
      expect(sniffMediaType(name, bytes)).toBe(mediaType)
      const extracted = extractDocument({ mediaType, bytes })
      expect(extracted.length).toBeGreaterThan(0)
      expect(extracted[0]!.locator.kind).toBe(locator)
      expect(extracted.map((entry) => entry.text).join('\n')).toContain('WP21')
    },
  )

  it('rejects malformed, MIME mismatch, oversized, timeout and archive input without plaintext errors', async () => {
    expect(() =>
      extractDocument({
        mediaType: 'application/pdf',
        bytes: Buffer.from('%PDF-broken'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_PDF' }))
    expect(() =>
      sniffMediaType('archive.zip', Buffer.from('PK\x03\x04')),
    ).toThrowError(expect.objectContaining({ code: 'ARCHIVE_REJECTED' }))
    expect(() =>
      extractDocument({
        mediaType: 'text/plain',
        bytes: Buffer.from('private-source-value'),
        limits: { parserTimeoutMs: 1 },
        elapsedMs: () => 2,
      }),
    ).toThrowError(expect.objectContaining({ code: 'PARSER_TIMEOUT' }))
    const { value } = registry({ limits: { maxBytes: 8 } })
    await expect(
      value.createSource({
        scope,
        name: 'large.txt',
        chunks: singleChunk(Buffer.from('more than eight bytes')),
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' })
    await expect(
      registry().value.createSource({
        scope,
        name: 'mismatch.pdf',
        declaredMediaType: 'application/pdf',
        chunks: singleChunk(Buffer.from('plain text only')),
      }),
    ).rejects.toMatchObject({ code: 'MIME_MISMATCH' })
  })
})

describe('WP21 idempotent registry and worker', () => {
  it('dedupes duplicate ingest, chunk and embedding usage and rebuilds deterministically', async () => {
    const { value } = registry()
    const first = await value.createSource({
      scope,
      name: 'golden.md',
      chunks: singleChunk(fixture('golden.md')),
    })
    const duplicate = await value.createSource({
      scope,
      name: 'golden.md',
      chunks: singleChunk(fixture('golden.md')),
    })
    expect(duplicate.revision.revisionId).toBe(first.revision.revisionId)
    expect(value.listSources(scope)).toHaveLength(1)
    const job = value.claimNext(scope, 'worker_1')!
    await value.processJob(scope, job.jobId, 'worker_1')
    await value.processJob(scope, job.jobId, 'worker_1')
    const before = value.derivedSnapshot(scope)
    expect(before.usage).toHaveLength(1)
    const [reindex] = value.rebuildDerivedIndex(scope)
    const claimed = value.claimNext(scope, 'worker_1')!
    expect(claimed.jobId).toBe(reindex!.jobId)
    await value.processJob(scope, claimed.jobId, 'worker_1')
    const after = value.derivedSnapshot(scope)
    expect(after.chunks.map(({ chunkId }) => chunkId)).toEqual(
      before.chunks.map(({ chunkId }) => chunkId),
    )
    expect(
      after.indexDocuments.map(({ indexDocumentId }) => indexDocumentId),
    ).toEqual(
      before.indexDocuments.map(({ indexDocumentId }) => indexDocumentId),
    )
    expect(after.usage).toHaveLength(1)
    expect(after.usage[0]).toMatchObject({
      meter: 'index_embedding_token',
      completeness: 'complete',
    })
  })

  it('recovers an expired worker lease after restart', async () => {
    let now = new Date('2026-07-17T10:00:00.000Z')
    const { root, value } = registry({
      now: () => now,
      limits: { leaseMs: 10 },
    })
    await value.createSource({
      scope,
      name: 'golden.txt',
      chunks: singleChunk(fixture('golden.txt')),
    })
    expect(value.claimNext(scope, 'crashed_worker')?.status).toBe('extracting')
    now = new Date('2026-07-17T10:00:01.000Z')
    const restarted = new LocalCorpusRegistry(root, {
      now: () => now,
      limits: { leaseMs: 10 },
    })
    expect(restarted.recoverableScopes()).toEqual([scope])
    const reclaimed = restarted.claimNext(scope, 'restarted_worker')!
    await restarted.processJob(scope, reclaimed.jobId, 'restarted_worker')
    expect(restarted.listSources(scope)[0]?.status).toBe('indexed')
  })

  it('moves poison input to failed without blocking the next source', async () => {
    const { value } = registry({ limits: { maxAttempts: 3 } })
    const poison = await value.createSource({
      scope,
      name: 'poison.pdf',
      chunks: singleChunk(Buffer.from('%PDF-1.4\n%%EOF')),
    })
    await value.createSource({
      scope,
      name: 'healthy.txt',
      chunks: singleChunk(fixture('golden.txt')),
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      const job = value.claimNext(scope, 'worker')!
      await expect(
        value.processJob(scope, job.jobId, 'worker'),
      ).rejects.toBeInstanceOf(CorpusError)
    }
    expect(
      value.sourceDetail(scope, poison.source.sourceId).source.status,
    ).toBe('failed')
    expect(
      value.sourceDetail(scope, poison.source.sourceId).jobs[0],
    ).toMatchObject({
      usageCompleteness: 'partial',
      errorCode: 'PDF_TEXT_UNAVAILABLE',
    })
    expect(value.derivedSnapshot(scope).usage).toEqual([])
    const healthy = value.claimNext(scope, 'worker')!
    await value.processJob(scope, healthy.jobId, 'worker')
    expect(
      value
        .listSources(scope)
        .find((source) => source.sourceId === healthy.sourceId)?.status,
    ).toBe('indexed')
  })

  it('tombstones source, removes derived rows and denies cross-tenant access', async () => {
    const { value } = registry()
    const created = await value.createSource({
      scope,
      name: 'golden.txt',
      chunks: singleChunk(fixture('golden.txt')),
    })
    const job = value.claimNext(scope, 'worker')!
    await value.processJob(scope, job.jobId, 'worker')
    expect(
      value.listSources({
        ...scope,
        tenantId: 'tenant_b',
        organizationId: 'tenant_b',
      }),
    ).toEqual([])
    expect(() =>
      value.sourceDetail(
        { ...scope, tenantId: 'tenant_b', organizationId: 'tenant_b' },
        created.source.sourceId,
      ),
    ).toThrowError(expect.objectContaining({ code: 'SOURCE_NOT_FOUND' }))
    expect(value.deleteSource(scope, created.source.sourceId).status).toBe(
      'deleted',
    )
    expect(value.derivedSnapshot(scope).chunks).toEqual([])
    expect(value.derivedSnapshot(scope).indexDocuments).toEqual([])
  })

  it('rejects registry and snapshot symlinks', async () => {
    const { root, value } = registry()
    const created = await value.createSource({
      scope,
      name: 'golden.txt',
      chunks: singleChunk(fixture('golden.txt')),
    })
    const snapshot = join(root, created.revision.rawSnapshot.storageKey)
    rmSync(snapshot)
    symlinkSync('/proc/version', snapshot)
    const job = value.claimNext(scope, 'worker')!
    await expect(
      value.processJob(scope, job.jobId, 'worker'),
    ).rejects.toMatchObject({ code: 'CORPUS_SYMLINK_REJECTED' })
  })

  it('keeps plaintext out of registry, audit and error metadata', async () => {
    const { root, value } = registry()
    const secretLikeContent =
      'Bearer should-remain-only-in-the-immutable-snapshot'
    const created = await value.createSource({
      scope,
      name: 'private.txt',
      chunks: singleChunk(Buffer.from(secretLikeContent)),
    })
    const job = value.claimNext(scope, 'worker')!
    await value.processJob(scope, job.jobId, 'worker')
    const registryJson = readFileSync(join(root, 'registry.v1.json'), 'utf8')
    expect(registryJson).not.toContain(secretLikeContent)
    expect(JSON.stringify(value.derivedSnapshot(scope).audits)).not.toContain(
      secretLikeContent,
    )
    expect(created.revision.rawSnapshot.storageKey).not.toContain('private.txt')
  })
})
