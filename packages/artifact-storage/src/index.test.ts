import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendBoundedTail,
  LocalArtifactStorage,
  redactCommandOutput,
} from './index'

const roots: string[] = []
const scope = {
  tenantId: 'ten_a',
  workspaceId: 'wsp_a',
  sessionId: 'ses_a',
  turnId: 'turn_a',
  itemId: 'item_a',
}
function storage() {
  const root = mkdtempSync(join(tmpdir(), 'artifacts-'))
  roots.push(root)
  return new LocalArtifactStorage(root)
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('LocalArtifactStorage', () => {
  it('streams 100 MiB with bounded chunks, redaction, byte count and checksum', async () => {
    const store = storage()
    const created = store.create(scope)
    const chunkBytes = 64 * 1024
    const count = 1600
    const hash = createHash('sha256')
    let expectedBytes = 0
    let maxChunk = 0
    let tail = ''
    for (let index = 0; index < count; index++) {
      const marker = index === 777 ? 'Bearer ultra-secret-token\n' : ''
      const raw = (marker + `${index.toString().padStart(6, '0')}:`).padEnd(
        chunkBytes,
        'x',
      )
      const redacted = redactCommandOutput(raw)
      hash.update(redacted)
      expectedBytes += Buffer.byteLength(redacted)
      maxChunk = Math.max(maxChunk, Buffer.byteLength(raw))
      tail = appendBoundedTail(tail, redacted)
      store.append({
        artifactId: created.artifactId,
        scope,
        chunkIndex: index,
        stream: 'combined',
        data: raw,
      })
      if (index === 20)
        store.append({
          artifactId: created.artifactId,
          scope,
          chunkIndex: index,
          stream: 'combined',
          data: raw,
        })
    }
    const final = store.finalize(created.artifactId, scope)
    expect(maxChunk).toBe(chunkBytes)
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(64 * 1024)
    expect(final.byteLength).toBe(expectedBytes)
    expect(final.sha256).toBe(hash.digest('hex'))
    expect(final.ranges.every((range) => range.byteLength <= chunkBytes)).toBe(
      true,
    )
    const downloadedHash = createHash('sha256')
    let downloadedBytes = 0
    let scanCarry = ''
    let leaked = false
    for await (const chunk of store.openReadStream(created.artifactId, {
      tenantId: 'ten_a',
      workspaceId: 'wsp_a',
    })) {
      const bytes = Buffer.from(chunk)
      downloadedHash.update(bytes)
      downloadedBytes += bytes.length
      const scan = scanCarry + bytes.toString()
      leaked ||= scan.includes('ultra-secret-token')
      scanCarry = scan.slice(-64)
    }
    expect(leaked).toBe(false)
    expect(downloadedBytes).toBe(final.byteLength)
    expect(downloadedHash.digest('hex')).toBe(final.sha256)
  }, 30_000)
  it('enforces ordering, tenant isolation, traversal and symlink rejection', () => {
    const store = storage()
    const a = store.create(scope)
    expect(() =>
      store.append({
        artifactId: a.artifactId,
        scope,
        chunkIndex: 1,
        stream: 'combined',
        data: 'x',
      }),
    ).toThrow('ARTIFACT_CHUNK_ORDER')
    expect(() =>
      store.metadata(a.artifactId, { tenantId: 'ten_b', workspaceId: 'wsp_a' }),
    ).toThrow('ARTIFACT_NOT_FOUND')
    expect(() => store.create({ ...scope, tenantId: '..' })).toThrow(
      'INVALID_ARTIFACT_SCOPE',
    )
    expect(() => store.create({ ...scope, tenantId: '/proc' })).toThrow(
      'INVALID_ARTIFACT_SCOPE',
    )
    const tenantRoot = join(roots.at(-1)!, 'ten_a', 'wsp_a')
    mkdirSync(tenantRoot, { recursive: true })
    symlinkSync(tmpdir(), join(tenantRoot, 'escape'))
    expect(() =>
      store.metadata('missing', { tenantId: 'ten_a', workspaceId: 'wsp_a' }),
    ).toThrow('ARTIFACT_SYMLINK_REJECTED')
  })
  it('reopens finalized artifacts and cleans orphan temp files', () => {
    const store = storage()
    const a = store.create(scope)
    store.append({
      artifactId: a.artifactId,
      scope,
      chunkIndex: 0,
      stream: 'combined',
      data: 'ok',
    })
    store.finalize(a.artifactId, scope)
    expect(
      new LocalArtifactStorage(roots.at(-1)!).metadata(a.artifactId, {
        tenantId: 'ten_a',
        workspaceId: 'wsp_a',
      }).finalized,
    ).toBe(true)
    const orphan = join(roots.at(-1)!, 'orphan.tmp')
    writeFileSync(orphan, 'orphan')
    expect(store.cleanupOrphans(-1)).toBe(1)
  })
  it('marks half-written artifacts recovery-required after reopen', () => {
    const store = storage()
    const a = store.create(scope)
    store.append({
      artifactId: a.artifactId,
      scope,
      chunkIndex: 0,
      stream: 'combined',
      data: 'partial secret sk-ABCDEFGHIJK',
    })
    const reopened = new LocalArtifactStorage(roots.at(-1)!)
    expect(
      reopened.metadata(a.artifactId, {
        tenantId: 'ten_a',
        workspaceId: 'wsp_a',
      }).status,
    ).toBe('recovery_required')
    expect(() => reopened.finalize(a.artifactId, scope)).toThrow(
      'ARTIFACT_RECOVERY_REQUIRED',
    )
  })
  it('redacts credentials split across source chunk boundaries', async () => {
    const store = storage()
    const a = store.create(scope)
    const pieces = [
      'before Bear',
      'er split-token-123 ',
      'sk-ABC',
      'DEFGHIJK and sess-1234',
      '567890 structured {"api_key":"top',
      'secret"} after',
    ]
    pieces.forEach((data, index) =>
      store.append({
        artifactId: a.artifactId,
        scope,
        chunkIndex: index,
        stream: 'combined',
        data,
      }),
    )
    const final = store.finalize(a.artifactId, scope)
    let text = ''
    for await (const chunk of store.openReadStream(a.artifactId, {
      tenantId: 'ten_a',
      workspaceId: 'wsp_a',
    }))
      text += Buffer.from(chunk).toString()
    expect(text).toContain('before ')
    expect(text).toContain(' after')
    expect(text).not.toMatch(/split-token|ABCDEFGHIJK|1234567890|topsecret/)
    expect(text.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4)
    expect(final.byteLength).toBe(Buffer.byteLength(text))
  })
})
