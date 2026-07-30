import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ChunkedEnvelopeEncryption,
  LocalKmsProvider,
} from '@perseverance/workspace-security'
import {
  CorpusError,
  EncryptedFilesystemCorpusSnapshotStorage,
  extractDocument,
  extractDocumentBounded,
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
  options: ConstructorParameters<typeof LocalCorpusRegistry>[1] = {
    explicitUsage: 'test',
  },
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
    async (name, mediaType, locator) => {
      const bytes = fixture(name)
      expect(sniffMediaType(name, bytes)).toBe(mediaType)
      const extracted = await extractDocumentBounded({ mediaType, bytes })
      expect(extracted.length).toBeGreaterThan(0)
      expect(extracted[0]!.locator.kind).toBe(locator)
      expect(extracted.map((entry) => entry.text).join('\n')).toContain('WP21')
    },
  )

  it('rejects malformed, MIME mismatch, oversized, timeout and archive input without plaintext errors', async () => {
    await expect(
      extractDocumentBounded({
        mediaType: 'application/pdf',
        bytes: Buffer.from('%PDF-broken'),
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_PDF' })
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
    const { value } = registry({
      explicitUsage: 'test',
      limits: { maxBytes: 8 },
    })
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

  it('handles multipage/compressed/Unicode PDFs and returns typed unsupported outcomes', async () => {
    const multipage = await extractDocumentBounded({
      mediaType: 'application/pdf',
      bytes: fixture('golden.pdf'),
    })
    expect(multipage.map((entry) => entry.locator)).toEqual([
      { kind: 'page', pageStart: 1, pageEnd: 1 },
      { kind: 'page', pageStart: 2, pageEnd: 2 },
    ])
    const unicode = await extractDocumentBounded({
      mediaType: 'application/pdf',
      bytes: fixture('unicode.pdf'),
    })
    expect(unicode.map((entry) => entry.text).join('\n')).toContain(
      'İstanbul Türkiye café Ελληνικά',
    )
    const tjArray = await extractDocumentBounded({
      mediaType: 'application/pdf',
      bytes: fixture('tj-array.pdf'),
    })
    expect(tjArray[0]?.text).toContain('WP21 TJ array operator fixture')
    await expect(
      extractDocumentBounded({
        mediaType: 'application/pdf',
        bytes: fixture('password-protected.pdf'),
      }),
    ).rejects.toMatchObject({ code: 'PDF_PASSWORD_PROTECTED' })
    await expect(
      extractDocumentBounded({
        mediaType: 'application/pdf',
        bytes: fixture('image-only.pdf'),
      }),
    ).rejects.toMatchObject({ code: 'OCR_REQUIRED' })
    await expect(
      extractDocumentBounded({
        mediaType: 'application/pdf',
        bytes: fixture('golden.pdf'),
        limits: { parserTimeoutMs: 1 },
      }),
    ).rejects.toMatchObject({ code: 'PARSER_TIMEOUT' })
    await expect(
      extractDocumentBounded({
        mediaType: 'application/pdf',
        bytes: fixture('golden.pdf'),
        limits: { maxPdfPages: 1 },
      }),
    ).rejects.toMatchObject({ code: 'PDF_PAGE_LIMIT' })
    await expect(
      extractDocumentBounded({
        mediaType: 'application/pdf',
        bytes: fixture('golden.pdf'),
        limits: { maxParserOutputBytes: 32 },
      }),
    ).rejects.toMatchObject({ code: 'PDF_OUTPUT_LIMIT' })
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
    expect(before.usage).toHaveLength(0)
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
    expect(after.usage).toHaveLength(0)
    expect(after.indexDocuments[0]).toMatchObject({
      embeddingVersion: 'unembedded-placeholder-v1',
      embeddingTokenCount: 0,
    })
  })

  it('recovers an expired worker lease after restart', async () => {
    let now = new Date('2026-07-17T10:00:00.000Z')
    const { root, value } = registry({
      explicitUsage: 'test',
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
      explicitUsage: 'test',
      now: () => now,
      limits: { leaseMs: 10 },
    })
    expect(restarted.recoverableScopes()).toEqual([scope])
    const reclaimed = restarted.claimNext(scope, 'restarted_worker')!
    await restarted.processJob(scope, reclaimed.jobId, 'restarted_worker')
    expect(restarted.listSources(scope)[0]?.status).toBe('indexed')
  })

  it('moves poison input to failed without blocking the next source', async () => {
    const { value } = registry({
      explicitUsage: 'test',
      limits: { maxAttempts: 3 },
    })
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
      errorCode: 'MALFORMED_PDF',
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

describe('WP21 corpus snapshot envelope encryption', () => {
  function encryptedStorage(root: string, kms: LocalKmsProvider) {
    return new EncryptedFilesystemCorpusSnapshotStorage(
      root,
      new ChunkedEnvelopeEncryption(kms, 1024),
      { explicitUsage: 'test' },
    )
  }

  it('binds tenant, workspace, revision, storage key, content hash and envelope fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wp21-envelope-'))
    roots.push(root)
    const storage = encryptedStorage(
      root,
      new LocalKmsProvider(Buffer.alloc(32, 11)),
    )
    const revisionId = 'rev_context_bound'
    const stored = await storage.put({
      scope,
      revisionId,
      chunks: singleChunk(Buffer.from('context-bound-snapshot')),
      maxBytes: 1024,
    })
    const valid = {
      scope,
      revisionId,
      storageKey: stored.storageKey,
      contentHash: stored.contentHash,
      maxBytes: 1024,
    }
    await expect(storage.read(valid)).resolves.toEqual(
      Buffer.from('context-bound-snapshot'),
    )
    const originalPath = join(root, stored.storageKey)
    const original = readFileSync(originalPath)
    const copiedRead = async (
      changedScope: typeof scope,
      changedRevisionId: string,
      changedStorageKey: string,
      changedContentHash = stored.contentHash,
    ) => {
      const copiedPath = join(root, changedStorageKey)
      mkdirSync(dirname(copiedPath), { recursive: true })
      writeFileSync(copiedPath, original)
      return storage.read({
        scope: changedScope,
        revisionId: changedRevisionId,
        storageKey: changedStorageKey,
        contentHash: changedContentHash,
        maxBytes: 1024,
      })
    }
    const tenantScope = {
      ...scope,
      tenantId: 'tenant_b',
      organizationId: 'tenant_b',
    }
    const tenantKey = stored.storageKey.replace(
      '/tenant_a/tenant_a/',
      '/tenant_b/tenant_b/',
    )
    await expect(
      copiedRead(tenantScope, revisionId, tenantKey),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_INTEGRITY_FAILED' })
    const organizationScope = { ...scope, organizationId: 'organization_b' }
    const organizationKey = stored.storageKey.replace(
      '/tenant_a/tenant_a/',
      '/tenant_a/organization_b/',
    )
    await expect(
      copiedRead(organizationScope, revisionId, organizationKey),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_INTEGRITY_FAILED' })
    const workspaceScope = { ...scope, workspaceId: 'workspace_b' }
    const workspaceKey = stored.storageKey.replace(
      '/workspace_a/',
      '/workspace_b/',
    )
    await expect(
      copiedRead(workspaceScope, revisionId, workspaceKey),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_INTEGRITY_FAILED' })
    await expect(
      copiedRead(scope, 'rev_substituted', stored.storageKey),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_INTEGRITY_FAILED' })
    const substitutedKey = stored.storageKey.replace(
      revisionId,
      'rev_storage_substituted',
    )
    await expect(
      copiedRead(scope, revisionId, substitutedKey),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_INTEGRITY_FAILED' })
    await expect(
      copiedRead(
        scope,
        revisionId,
        stored.storageKey,
        `sha256:${'0'.repeat(64)}`,
      ),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_INTEGRITY_FAILED' })

    const mutate = async (change: (value: any) => void) => {
      const value = JSON.parse(original.toString())
      change(value)
      writeFileSync(originalPath, JSON.stringify(value))
      try {
        await expect(storage.read(valid)).rejects.toMatchObject({
          code: 'SNAPSHOT_INTEGRITY_FAILED',
        })
      } finally {
        writeFileSync(originalPath, original)
      }
    }
    await mutate((value) => {
      value.envelope.chunks[0].ciphertext =
        Buffer.from('tampered').toString('base64')
    })
    await mutate((value) => {
      value.envelope.chunks[0].authenticationTag = Buffer.alloc(16, 1).toString(
        'base64',
      )
    })
    await mutate((value) => {
      value.envelope.encryptedDek.ciphertext = Buffer.alloc(60, 2).toString(
        'base64',
      )
    })
  })

  it('supports rotation and fails closed for revoked keys and workspace crypto-erasure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wp21-envelope-lifecycle-'))
    roots.push(root)
    const kms = new LocalKmsProvider(Buffer.alloc(32, 12))
    const storage = encryptedStorage(root, kms)
    const old = await storage.put({
      scope,
      revisionId: 'rev_old_key',
      chunks: singleChunk(Buffer.from('old-key-snapshot')),
      maxBytes: 1024,
    })
    const oldVersion = '1'
    kms.rotate(Buffer.alloc(32, 13))
    const current = await storage.put({
      scope,
      revisionId: 'rev_current_key',
      chunks: singleChunk(Buffer.from('current-key-snapshot')),
      maxBytes: 1024,
    })
    const read = (revisionId: string, snapshot: typeof old) =>
      storage.read({
        scope,
        revisionId,
        storageKey: snapshot.storageKey,
        contentHash: snapshot.contentHash,
        maxBytes: 1024,
      })
    await expect(read('rev_old_key', old)).resolves.toEqual(
      Buffer.from('old-key-snapshot'),
    )
    await expect(read('rev_current_key', current)).resolves.toEqual(
      Buffer.from('current-key-snapshot'),
    )
    kms.revokeKeyVersion(oldVersion)
    await expect(read('rev_old_key', old)).rejects.toMatchObject({
      code: 'SNAPSHOT_INTEGRITY_FAILED',
    })
    await expect(read('rev_current_key', current)).resolves.toEqual(
      Buffer.from('current-key-snapshot'),
    )
    await storage.encryption.kms.revokeWorkspace(scope)
    await expect(read('rev_current_key', current)).rejects.toMatchObject({
      code: 'SNAPSHOT_INTEGRITY_FAILED',
    })
  })

  it('requires explicit test or development use for a local KMS', () => {
    const root = mkdtempSync(join(tmpdir(), 'wp21-envelope-local-kms-'))
    roots.push(root)
    expect(
      () =>
        new EncryptedFilesystemCorpusSnapshotStorage(
          root,
          new ChunkedEnvelopeEncryption(
            new LocalKmsProvider(Buffer.alloc(32, 14)),
          ),
        ),
    ).toThrowError(
      expect.objectContaining({ code: 'PRODUCTION_CORPUS_KMS_REQUIRED' }),
    )
  })
})
