import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AttachmentStorageError,
  LocalAttachmentStorage,
} from './attachment-storage'

const directories: string[] = []
const scope = {
  tenantId: 'ten_test',
  workspaceId: 'wsp_test',
  sessionId: 'ses_test',
}

function storage() {
  const directory = mkdtempSync(join(tmpdir(), 'attachment-storage-'))
  directories.push(directory)
  return { directory, storage: new LocalAttachmentStorage(directory) }
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('LocalAttachmentStorage', () => {
  it('stores binary data with scoped metadata and resolves a canonical path', () => {
    const fixture = storage()
    const data = Uint8Array.from([0, 1, 2, 255])
    const attachment = fixture.storage.store({
      scope,
      name: 'image.png',
      mediaType: 'image/png',
      data,
    })
    const resolved = fixture.storage.resolve(scope, attachment.attachmentId)

    expect(attachment).toMatchObject({
      ...scope,
      name: 'image.png',
      kind: 'image',
      byteLength: 4,
    })
    expect(resolved.path).toMatch(/image\.png$/)
    expect(readFileSync(resolved.path)).toEqual(Buffer.from(data))
    expect(() =>
      fixture.storage.resolve(
        { ...scope, tenantId: 'ten_other' },
        attachment.attachmentId,
      ),
    ).toThrow()
    fixture.storage.remove(scope, attachment.attachmentId)
    expect(() =>
      fixture.storage.resolve(scope, attachment.attachmentId),
    ).toThrow()
  })

  it('stores attachments larger than the former 10 MB limit', () => {
    const fixture = storage()
    const data = Buffer.alloc(10 * 1024 * 1024 + 1, 1)
    const attachment = fixture.storage.store({
      scope,
      name: 'large.pdf',
      mediaType: 'application/pdf',
      data,
    })

    expect(attachment.byteLength).toBe(data.byteLength)
    expect(
      readFileSync(fixture.storage.resolve(scope, attachment.attachmentId).path)
        .byteLength,
    ).toBe(data.byteLength)
  })

  it('rejects traversal names, unsupported types, and symlink substitution', () => {
    const fixture = storage()
    expect(() =>
      fixture.storage.store({
        scope,
        name: '../secret.txt',
        mediaType: 'text/plain',
        data: Buffer.from('safe'),
      }),
    ).toThrowError(AttachmentStorageError)
    expect(() =>
      fixture.storage.store({
        scope,
        name: 'archive.zip',
        mediaType: 'application/zip',
        data: Buffer.from('safe'),
      }),
    ).toThrow('Attachment type is not supported')

    const attachment = fixture.storage.store({
      scope,
      name: 'note.txt',
      mediaType: 'text/plain',
      data: Buffer.from('safe'),
    })
    const resolved = fixture.storage.resolve(scope, attachment.attachmentId)
    rmSync(resolved.path)
    symlinkSync('/etc/hosts', resolved.path)
    expect(() =>
      fixture.storage.resolve(scope, attachment.attachmentId),
    ).toThrow('Attachment symlink is not allowed')
  })
})
