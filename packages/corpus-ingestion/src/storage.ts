import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  ChunkedEnvelopeEncryption,
  CryptoError,
  type EncryptionContextV1,
} from '@persistent-codex/workspace-security'
import { CorpusError, type CorpusScope } from './index'

export const CORPUS_SNAPSHOT_STORAGE_VERSION = 1 as const

export interface StoredCorpusSnapshot {
  version: typeof CORPUS_SNAPSHOT_STORAGE_VERSION
  storageKey: string
  byteLength: number
  contentHash: string
  encrypted: boolean
  createdAt: string
}

export interface CorpusSnapshotStorage {
  readonly version: typeof CORPUS_SNAPSHOT_STORAGE_VERSION
  readonly adapter: 'local-development' | 'encrypted-filesystem'
  readonly productionCapable: boolean
  put(input: {
    scope: CorpusScope
    revisionId: string
    chunks: AsyncIterable<Uint8Array>
    maxBytes: number
  }): Promise<StoredCorpusSnapshot>
  read(input: {
    scope: CorpusScope
    revisionId: string
    storageKey: string
    contentHash: string
    maxBytes: number
  }): Promise<Uint8Array>
  delete(input: { scope: CorpusScope; storageKey: string }): Promise<void>
}

function safePart(value: string, label: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..')
    throw new CorpusError('INVALID_CORPUS_SCOPE', `${label} is invalid`)
  return value
}

function expectedPrefix(scope: CorpusScope) {
  return `raw/${safePart(scope.tenantId, 'tenantId')}/${safePart(scope.organizationId, 'organizationId')}/${safePart(scope.workspaceId, 'workspaceId')}/`
}

abstract class FilesystemSnapshotStorage implements CorpusSnapshotStorage {
  readonly version = CORPUS_SNAPSHOT_STORAGE_VERSION
  abstract readonly adapter: CorpusSnapshotStorage['adapter']
  abstract readonly productionCapable: boolean
  abstract put(input: {
    scope: CorpusScope
    revisionId: string
    chunks: AsyncIterable<Uint8Array>
    maxBytes: number
  }): Promise<StoredCorpusSnapshot>
  abstract read(input: {
    scope: CorpusScope
    revisionId: string
    storageKey: string
    contentHash: string
    maxBytes: number
  }): Promise<Uint8Array>
  readonly root: string

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.root = realpathSync(root)
  }

  protected path(scope: CorpusScope, storageKey: string) {
    if (!storageKey.startsWith(expectedPrefix(scope)))
      throw new CorpusError(
        'INVALID_STORAGE_KEY',
        'Snapshot storage key is not tenant scoped',
      )
    const path = resolve(this.root, storageKey)
    const rel = relative(this.root, path)
    if (
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      path === '/proc' ||
      path.startsWith('/proc/') ||
      path === '/sys' ||
      path.startsWith('/sys/')
    )
      throw new CorpusError(
        'CORPUS_PATH_ESCAPE',
        'Corpus path escapes storage root',
      )
    return path
  }

  protected key(scope: CorpusScope, revisionId: string) {
    return `${expectedPrefix(scope)}${safePart(revisionId, 'revisionId')}.snapshot`
  }

  async delete(input: { scope: CorpusScope; storageKey: string }) {
    const path = this.path(input.scope, input.storageKey)
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new CorpusError(
        'CORPUS_SYMLINK_REJECTED',
        'Snapshot symlink is not allowed',
      )
    rmSync(path, { force: true })
  }
}

export class LocalCorpusSnapshotStorage extends FilesystemSnapshotStorage {
  readonly adapter = 'local-development' as const
  readonly productionCapable = false

  constructor(
    root: string,
    options: { explicitUsage: 'test' | 'development' },
  ) {
    if (!options.explicitUsage)
      throw new CorpusError(
        'EXPLICIT_LOCAL_STORAGE_USAGE_REQUIRED',
        'Local corpus storage requires explicit test or development usage',
      )
    super(root)
  }

  async put(input: {
    scope: CorpusScope
    revisionId: string
    chunks: AsyncIterable<Uint8Array>
    maxBytes: number
  }) {
    const storageKey = this.key(input.scope, input.revisionId)
    const path = this.path(input.scope, storageKey)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    let handle: number | undefined
    let byteLength = 0
    const hash = createHash('sha256')
    try {
      handle = openSync(temporary, 'wx', 0o600)
      for await (const chunk of input.chunks) {
        byteLength += chunk.byteLength
        if (byteLength > input.maxBytes)
          throw new CorpusError(
            'SOURCE_TOO_LARGE',
            'Source exceeds configured byte limit',
          )
        hash.update(chunk)
        writeSync(handle, chunk)
      }
      if (byteLength === 0)
        throw new CorpusError('EMPTY_SOURCE', 'Source must not be empty')
      closeSync(handle)
      handle = undefined
      renameSync(temporary, path)
      return {
        version: CORPUS_SNAPSHOT_STORAGE_VERSION,
        storageKey,
        byteLength,
        contentHash: `sha256:${hash.digest('hex')}`,
        encrypted: false,
        createdAt: new Date().toISOString(),
      }
    } catch (error) {
      if (handle !== undefined) closeSync(handle)
      rmSync(temporary, { force: true })
      rmSync(path, { force: true })
      throw error
    }
  }

  async read(input: {
    scope: CorpusScope
    revisionId: string
    storageKey: string
    contentHash: string
    maxBytes: number
  }) {
    const path = this.path(input.scope, input.storageKey)
    if (lstatSync(path).isSymbolicLink())
      throw new CorpusError(
        'CORPUS_SYMLINK_REJECTED',
        'Snapshot symlink is not allowed',
      )
    const parts: Buffer[] = []
    let length = 0
    for await (const part of createReadStream(path, {
      highWaterMark: 64 * 1024,
    })) {
      length += part.length
      if (length > input.maxBytes)
        throw new CorpusError(
          'SOURCE_TOO_LARGE',
          'Source exceeds configured byte limit',
        )
      parts.push(part)
    }
    return Buffer.concat(parts)
  }
}

export class EncryptedFilesystemCorpusSnapshotStorage extends FilesystemSnapshotStorage {
  readonly adapter = 'encrypted-filesystem' as const
  readonly productionCapable: boolean
  readonly encryption: ChunkedEnvelopeEncryption

  constructor(
    root: string,
    encryption: ChunkedEnvelopeEncryption,
    options: { explicitUsage?: 'test' | 'development' } = {},
  ) {
    if (!encryption.kms.production && !options.explicitUsage)
      throw new CorpusError(
        'PRODUCTION_CORPUS_KMS_REQUIRED',
        'A non-production corpus KMS requires explicit test or development usage',
      )
    super(root)
    this.encryption = encryption
    this.productionCapable = encryption.kms.production
  }

  #context(input: {
    scope: CorpusScope
    revisionId: string
    storageKey: string
    contentHash: string
  }): EncryptionContextV1 {
    return {
      ...input.scope,
      recordType: 'corpus_snapshot',
      recordId: safePart(input.revisionId, 'revisionId'),
      additionalAuthenticatedData: {
        purpose: 'immutable_raw_corpus_snapshot',
        revisionId: input.revisionId,
        storageKey: input.storageKey,
        contentHash: input.contentHash,
      },
    }
  }

  async put(input: {
    scope: CorpusScope
    revisionId: string
    chunks: AsyncIterable<Uint8Array>
    maxBytes: number
  }) {
    const storageKey = this.key(input.scope, input.revisionId)
    const path = this.path(input.scope, storageKey)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    let plaintextLength = 0
    const hash = createHash('sha256')
    const parts: Buffer[] = []
    let plaintext: Buffer | undefined
    try {
      for await (const chunk of input.chunks) {
        plaintextLength += chunk.byteLength
        if (plaintextLength > input.maxBytes)
          throw new CorpusError(
            'SOURCE_TOO_LARGE',
            'Source exceeds configured byte limit',
          )
        hash.update(chunk)
        parts.push(Buffer.from(chunk))
      }
      if (plaintextLength === 0)
        throw new CorpusError('EMPTY_SOURCE', 'Source must not be empty')
      const contentHash = `sha256:${hash.digest('hex')}`
      plaintext = Buffer.concat(parts)
      const envelope = await this.encryption.encrypt(
        this.#context({
          scope: input.scope,
          revisionId: input.revisionId,
          storageKey,
          contentHash,
        }),
        plaintext,
      )
      writeFileSync(
        temporary,
        JSON.stringify({
          format: 'persistent-codex-corpus-snapshot-envelope-v1',
          envelope,
        }),
        { flag: 'wx', mode: 0o600 },
      )
      renameSync(temporary, path)
      return {
        version: CORPUS_SNAPSHOT_STORAGE_VERSION,
        storageKey,
        byteLength: plaintextLength,
        contentHash,
        encrypted: true,
        createdAt: new Date().toISOString(),
      }
    } catch (error) {
      rmSync(temporary, { force: true })
      rmSync(path, { force: true })
      throw error
    } finally {
      plaintext?.fill(0)
      for (const part of parts) part.fill(0)
    }
  }

  async read(input: {
    scope: CorpusScope
    revisionId: string
    storageKey: string
    contentHash: string
    maxBytes: number
  }) {
    const path = this.path(input.scope, input.storageKey)
    if (lstatSync(path).isSymbolicLink())
      throw new CorpusError(
        'CORPUS_SYMLINK_REJECTED',
        'Snapshot symlink is not allowed',
      )
    if (
      !/^sha256:[a-f0-9]{64}$/.test(input.contentHash) ||
      statSync(path).size > input.maxBytes * 2 + 1024 * 1024
    )
      throw new CorpusError(
        'SNAPSHOT_INTEGRITY_FAILED',
        'Encrypted snapshot envelope is invalid',
      )
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8')) as {
        format?: unknown
        envelope?: unknown
      }
      if (
        stored.format !== 'persistent-codex-corpus-snapshot-envelope-v1' ||
        !stored.envelope
      )
        throw new CryptoError('CORPUS_SNAPSHOT_ENVELOPE_INVALID')
      const plaintext = await this.encryption.decrypt(
        this.#context(input),
        stored.envelope as Parameters<ChunkedEnvelopeEncryption['decrypt']>[1],
      )
      if (
        plaintext.byteLength > input.maxBytes ||
        `sha256:${createHash('sha256').update(plaintext).digest('hex')}` !==
          input.contentHash
      ) {
        plaintext.fill(0)
        throw new CryptoError('CORPUS_SNAPSHOT_CONTENT_MISMATCH')
      }
      return plaintext
    } catch {
      throw new CorpusError(
        'SNAPSHOT_INTEGRITY_FAILED',
        'Encrypted snapshot authentication failed',
      )
    }
  }
}
