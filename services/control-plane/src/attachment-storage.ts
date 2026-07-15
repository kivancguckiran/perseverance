import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { ConversationAttachment } from '@persistent-codex/control-plane-contracts'
import type { StoreScope } from '@persistent-codex/event-store'

const supportedMediaTypes = new Set<ConversationAttachment['mediaType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/pdf',
])

function safePart(value: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..')
    throw new AttachmentStorageError(
      'INVALID_ATTACHMENT_SCOPE',
      `${name} is invalid`,
    )
  return value
}

function safeName(value: string): string {
  const name = value.trim()
  if (
    !name ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    /[\\/\0\r\n]/.test(name)
  )
    throw new AttachmentStorageError(
      'INVALID_ATTACHMENT_NAME',
      'Attachment name is invalid',
    )
  return name
}

export class AttachmentStorageError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'AttachmentStorageError'
  }
}

export class LocalAttachmentStorage {
  readonly #root: string

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.#root = realpathSync(root)
  }

  #directory(scope: StoreScope): string {
    const directory = join(
      this.#root,
      safePart(scope.tenantId, 'tenantId'),
      safePart(scope.workspaceId, 'workspaceId'),
      safePart(scope.sessionId, 'sessionId'),
    )
    this.#assertInside(directory)
    return directory
  }

  #paths(scope: StoreScope, attachmentId: string) {
    safePart(attachmentId, 'attachmentId')
    const directory = this.#directory(scope)
    const metadata = join(directory, `${attachmentId}.json`)
    this.#assertInside(metadata)
    return { directory, metadata }
  }

  #dataPath(scope: StoreScope, attachmentId: string, name: string): string {
    const path = join(
      this.#directory(scope),
      safePart(attachmentId, 'attachmentId'),
      safeName(name),
    )
    this.#assertInside(path)
    return path
  }

  #legacyDataPath(scope: StoreScope, attachmentId: string): string {
    const path = join(
      this.#directory(scope),
      `${safePart(attachmentId, 'attachmentId')}.data`,
    )
    this.#assertInside(path)
    return path
  }

  #assertInside(path: string): void {
    const resolved = resolve(path)
    const rel = relative(this.#root, resolved)
    if (
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      resolved.startsWith('/proc') ||
      resolved.startsWith('/sys')
    )
      throw new AttachmentStorageError(
        'ATTACHMENT_PATH_ESCAPE',
        'Attachment path escapes storage root',
      )
  }

  store(input: {
    scope: StoreScope
    name: string
    mediaType: string
    data: Uint8Array
  }): ConversationAttachment {
    const name = safeName(input.name)
    if (!supportedMediaTypes.has(input.mediaType as never))
      throw new AttachmentStorageError(
        'UNSUPPORTED_ATTACHMENT_TYPE',
        'Attachment type is not supported',
      )
    if (input.data.byteLength < 1)
      throw new AttachmentStorageError(
        'INVALID_ATTACHMENT_SIZE',
        'Attachment must not be empty',
      )
    const attachmentId = `att_${randomUUID()}`
    const paths = this.#paths(input.scope, attachmentId)
    const dataPath = this.#dataPath(input.scope, attachmentId, name)
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 })
    mkdirSync(dirname(dataPath), { recursive: true, mode: 0o700 })
    const attachment: ConversationAttachment = {
      ...input.scope,
      attachmentId,
      name,
      mediaType: input.mediaType as ConversationAttachment['mediaType'],
      byteLength: input.data.byteLength,
      kind: input.mediaType.startsWith('image/') ? 'image' : 'file',
      createdAt: new Date().toISOString(),
    }
    try {
      writeFileSync(dataPath, input.data, { flag: 'wx', mode: 0o600 })
      writeFileSync(paths.metadata, JSON.stringify(attachment), {
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      rmSync(dirname(dataPath), { recursive: true, force: true })
      rmSync(paths.metadata, { force: true })
      throw error
    }
    return attachment
  }

  resolve(
    scope: StoreScope,
    attachmentId: string,
  ): ConversationAttachment & { path: string } {
    const paths = this.#paths(scope, attachmentId)
    for (const path of [paths.directory, paths.metadata]) {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink())
        throw new AttachmentStorageError(
          'ATTACHMENT_SYMLINK_REJECTED',
          'Attachment symlink is not allowed',
        )
    }
    const attachment = JSON.parse(
      readFileSync(paths.metadata, 'utf8'),
    ) as ConversationAttachment
    if (
      attachment.tenantId !== scope.tenantId ||
      attachment.workspaceId !== scope.workspaceId ||
      attachment.sessionId !== scope.sessionId ||
      attachment.attachmentId !== attachmentId
    )
      throw new AttachmentStorageError(
        'ATTACHMENT_SCOPE_MISMATCH',
        'Attachment scope does not match',
      )
    const preferredPath = this.#dataPath(scope, attachmentId, attachment.name)
    const dataPath = existsSync(preferredPath)
      ? preferredPath
      : this.#legacyDataPath(scope, attachmentId)
    for (const path of [dirname(dataPath), dataPath]) {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink())
        throw new AttachmentStorageError(
          'ATTACHMENT_SYMLINK_REJECTED',
          'Attachment symlink is not allowed',
        )
    }
    return { ...attachment, path: realpathSync(dataPath) }
  }

  remove(scope: StoreScope, attachmentId: string): void {
    const resolved = this.resolve(scope, attachmentId)
    const paths = this.#paths(scope, attachmentId)
    rmSync(resolved.path)
    if (dirname(resolved.path) !== paths.directory)
      rmSync(dirname(resolved.path), { recursive: true, force: true })
    rmSync(paths.metadata)
  }
}
