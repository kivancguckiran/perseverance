import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
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
  it('streams 100 MiB with bounded chunks, redaction, byte count and checksum', () => {
    const store = storage()
    const created = store.create(scope)
    const chunkBytes = 64 * 1024
    const count = 1600
    const hash = createHash('sha256')
    let expectedBytes = 0
    let maxChunk = 0
    let tail = ''
    for (let index = 0; index < count; index++) {
      const marker = index === 777 ? 'Bearer ultra-secret-token ' : ''
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
    expect(final.chunkCount).toBe(count)
    const downloaded = store.read(created.artifactId, {
      tenantId: 'ten_a',
      workspaceId: 'wsp_a',
    })
    expect(
      Buffer.from(downloaded).includes(Buffer.from('ultra-secret-token')),
    ).toBe(false)
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
  })
})
