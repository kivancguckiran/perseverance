import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
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
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import type {
  CorpusChunk,
  CorpusLocator,
  ExtractionJob,
  IndexDocument,
  IngestionAudit,
  Source,
  SourceRevision,
} from '@persistent-codex/control-plane-contracts'
import { extractPdfInSandbox, PDF_PARSER_VERSION } from './pdf-parser'

export * from './storage'
export * from './pdf-parser'
export * from './embedding'
export * from './repository'
export * from './service'

export const DEFAULT_CORPUS_LIMITS = {
  maxBytes: 16 * 1024 * 1024,
  maxPdfPages: 500,
  parserTimeoutMs: 30_000,
  maxParserOutputBytes: 32 * 1024 * 1024,
  maxParserMemoryBytes: 512 * 1024 * 1024,
  maxChunkCharacters: 2_000,
  overlapCharacters: 200,
  maxAttempts: 3,
  leaseMs: 60_000,
} as const
export interface CorpusLimits {
  maxBytes: number
  maxPdfPages: number
  parserTimeoutMs: number
  maxParserOutputBytes: number
  maxParserMemoryBytes: number
  maxChunkCharacters: number
  overlapCharacters: number
  maxAttempts: number
  leaseMs: number
}

export interface CorpusScope {
  tenantId: string
  organizationId: string
  workspaceId: string
}

export interface EmbeddingUsageRecord extends CorpusScope {
  usageId: string
  sourceId: string
  revisionId: string
  jobId: string
  meter: 'index_embedding_token'
  quantity: number
  completeness: 'complete' | 'partial'
  dedupeKey: string
  occurredAt: string
}

interface RegistryState {
  version: 1
  sources: Source[]
  revisions: SourceRevision[]
  jobs: ExtractionJob[]
  chunks: CorpusChunk[]
  indexDocuments: IndexDocument[]
  usage: EmbeddingUsageRecord[]
  audit: IngestionAudit[]
}

export class CorpusError extends Error {
  readonly code: string
  constructor(code: string, message = 'Corpus operation failed') {
    super(message)
    this.code = code
    this.name = 'CorpusError'
  }
}

function emptyState(): RegistryState {
  return {
    version: 1,
    sources: [],
    revisions: [],
    jobs: [],
    chunks: [],
    indexDocuments: [],
    usage: [],
    audit: [],
  }
}

function safePart(value: string, label: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..')
    throw new CorpusError('INVALID_CORPUS_SCOPE', `${label} is invalid`)
  return value
}

function safeName(value: string) {
  const result = basename(value.trim())
  if (
    !result ||
    result !== value.trim() ||
    result.length > 255 ||
    /[\\/\0\r\n]/.test(result)
  )
    throw new CorpusError('INVALID_SOURCE_NAME', 'Source name is invalid')
  return result
}

function scoped<T extends CorpusScope>(row: T, scope: CorpusScope) {
  return (
    row.tenantId === scope.tenantId &&
    row.organizationId === scope.organizationId &&
    row.workspaceId === scope.workspaceId
  )
}

function sha256(value: Uint8Array | string) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function inferTextMediaType(name: string, sample: Uint8Array) {
  if (sample.includes(0)) return undefined
  const text = Buffer.from(sample).toString('utf8')
  if (text.includes('\uFFFD')) return undefined
  const extension = extname(name).toLowerCase()
  if (extension === '.md' || extension === '.markdown') return 'text/markdown'
  if (extension === '.json') return 'application/json'
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension))
    return 'application/javascript'
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension))
    return 'application/typescript'
  if (extension === '.py') return 'text/x-python'
  if (extension === '.rs') return 'text/x-rust'
  if (['.sh', '.bash', '.zsh'].includes(extension)) return 'text/x-shellscript'
  if (extension === '.css') return 'text/css'
  if (['.html', '.htm'].includes(extension)) return 'text/html'
  if (['.txt', '.text', ''].includes(extension)) return 'text/plain'
  if (extension === '.pdf') return 'text/plain'
  return undefined
}

export function sniffMediaType(nameInput: string, sample: Uint8Array) {
  const name = safeName(nameInput)
  if (
    sample.byteLength >= 5 &&
    Buffer.from(sample.subarray(0, 5)).toString() === '%PDF-'
  )
    return 'application/pdf' as const
  if (
    sample.byteLength >= 4 &&
    sample[0] === 0x50 &&
    sample[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(sample[2]!) &&
    [0x04, 0x06, 0x08].includes(sample[3]!)
  )
    throw new CorpusError(
      'ARCHIVE_REJECTED',
      'Archive sources are not supported',
    )
  const mediaType = inferTextMediaType(name, sample)
  if (!mediaType)
    throw new CorpusError(
      'UNSUPPORTED_SOURCE_TYPE',
      'Source type is not supported',
    )
  return mediaType
}

function sourceKind(mediaType: SourceRevision['mediaType']): Source['kind'] {
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType === 'text/markdown') return 'markdown'
  if (mediaType === 'text/plain') return 'text'
  return 'code'
}

function inferredLanguage(mediaType: SourceRevision['mediaType']) {
  const values: Partial<Record<SourceRevision['mediaType'], string>> = {
    'application/json': 'json',
    'application/javascript': 'javascript',
    'application/typescript': 'typescript',
    'text/css': 'css',
    'text/html': 'html',
    'text/x-python': 'python',
    'text/x-rust': 'rust',
    'text/x-shellscript': 'shell',
  }
  return values[mediaType] ?? 'und'
}

export function extractDocument(input: {
  mediaType: SourceRevision['mediaType']
  bytes: Uint8Array
  limits?: Partial<CorpusLimits>
  elapsedMs?: () => number
}): Array<{ text: string; locator: CorpusLocator }> {
  const limits = { ...DEFAULT_CORPUS_LIMITS, ...input.limits }
  if (input.bytes.byteLength > limits.maxBytes)
    throw new CorpusError(
      'SOURCE_TOO_LARGE',
      'Source exceeds configured byte limit',
    )
  const started = Date.now()
  const elapsed = input.elapsedMs ?? (() => Date.now() - started)
  const assertTime = () => {
    if (elapsed() > limits.parserTimeoutMs)
      throw new CorpusError('PARSER_TIMEOUT', 'Source parser timed out')
  }
  if (input.mediaType === 'application/pdf') {
    throw new CorpusError(
      'ASYNC_PDF_PARSER_REQUIRED',
      'PDF extraction requires the isolated async parser',
    )
  }
  const text = Buffer.from(input.bytes).toString('utf8')
  if (text.includes('\uFFFD'))
    throw new CorpusError('INVALID_TEXT_ENCODING', 'Source must be valid UTF-8')
  const lines = text.split(/\r?\n/)
  const result: Array<{ text: string; locator: CorpusLocator }> = []
  for (let start = 0; start < lines.length;) {
    assertTime()
    let end = start
    let length = 0
    while (
      end < lines.length &&
      length + lines[end]!.length + 1 <= limits.maxChunkCharacters
    ) {
      length += lines[end]!.length + 1
      end++
    }
    if (end === start) end++
    const value = lines.slice(start, end).join('\n')
    if (value.trim())
      result.push({
        text: value,
        locator: { kind: 'line', lineStart: start + 1, lineEnd: end },
      })
    if (end >= lines.length) break
    let overlap = 0
    let next = end
    while (next > start + 1 && overlap < limits.overlapCharacters) {
      next--
      overlap += lines[next]!.length + 1
    }
    start = next
  }
  return result
}

export async function extractDocumentBounded(input: {
  mediaType: SourceRevision['mediaType']
  bytes: Uint8Array
  limits?: Partial<CorpusLimits>
}) {
  const limits = { ...DEFAULT_CORPUS_LIMITS, ...input.limits }
  if (input.mediaType !== 'application/pdf') return extractDocument(input)
  const pages = await extractPdfInSandbox({
    bytes: input.bytes,
    limits: {
      maxBytes: limits.maxBytes,
      maxPdfPages: limits.maxPdfPages,
      parserTimeoutMs: limits.parserTimeoutMs,
      maxOutputBytes: limits.maxParserOutputBytes,
      maxMemoryBytes: limits.maxParserMemoryBytes,
    },
  })
  return pages.map(({ text, page }) => ({
    text,
    locator: { kind: 'page' as const, pageStart: page, pageEnd: page },
  }))
}

export class LocalCorpusRegistry {
  readonly #root: string
  readonly #statePath: string
  readonly #limits: CorpusLimits
  readonly #now: () => Date

  constructor(
    root: string,
    options: {
      explicitUsage: 'test' | 'development'
      limits?: Partial<CorpusLimits>
      now?: () => Date
    },
  ) {
    if (!options.explicitUsage)
      throw new CorpusError(
        'EXPLICIT_LOCAL_REGISTRY_USAGE_REQUIRED',
        'Local corpus registry requires explicit test or development usage',
      )
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.#root = realpathSync(root)
    this.#statePath = join(this.#root, 'registry.v1.json')
    this.#limits = { ...DEFAULT_CORPUS_LIMITS, ...options.limits }
    this.#now = options.now ?? (() => new Date())
    if (!existsSync(this.#statePath)) this.#save(emptyState())
  }

  #assertInside(path: string) {
    const resolved = resolve(path)
    const rel = relative(this.#root, resolved)
    if (
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      resolved === '/proc' ||
      resolved.startsWith('/proc/') ||
      resolved === '/sys' ||
      resolved.startsWith('/sys/')
    )
      throw new CorpusError(
        'CORPUS_PATH_ESCAPE',
        'Corpus path escapes storage root',
      )
  }

  #load() {
    if (lstatSync(this.#statePath).isSymbolicLink())
      throw new CorpusError(
        'CORPUS_SYMLINK_REJECTED',
        'Corpus registry symlink is not allowed',
      )
    return JSON.parse(readFileSync(this.#statePath, 'utf8')) as RegistryState
  }

  #save(state: RegistryState) {
    const temporary = `${this.#statePath}.${randomUUID()}.tmp`
    this.#assertInside(temporary)
    writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, this.#statePath)
  }

  #snapshotPath(scope: CorpusScope, revisionId: string) {
    const path = join(
      this.#root,
      'raw',
      safePart(scope.tenantId, 'tenantId'),
      safePart(scope.organizationId, 'organizationId'),
      safePart(scope.workspaceId, 'workspaceId'),
      `${safePart(revisionId, 'revisionId')}.snapshot`,
    )
    this.#assertInside(path)
    return path
  }

  async createSource(input: {
    scope: CorpusScope
    name: string
    declaredMediaType?: string
    chunks: AsyncIterable<Uint8Array>
    provenance?: { kind: 'upload' | 'workspace_file'; workspacePath?: string }
  }) {
    const name = safeName(input.name)
    const sourceId = `src_${randomUUID()}`
    const revisionId = `rev_${randomUUID()}`
    const snapshotPath = this.#snapshotPath(input.scope, revisionId)
    mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 })
    const temporary = `${snapshotPath}.tmp`
    let handle: number | undefined
    let length = 0
    const hash = createHash('sha256')
    const sample: Buffer[] = []
    let sampleLength = 0
    try {
      handle = openSync(temporary, 'wx', 0o600)
      for await (const chunk of input.chunks) {
        length += chunk.byteLength
        if (length > this.#limits.maxBytes)
          throw new CorpusError(
            'SOURCE_TOO_LARGE',
            'Source exceeds configured byte limit',
          )
        if (sampleLength < 8192) {
          const part = Buffer.from(chunk.subarray(0, 8192 - sampleLength))
          sample.push(part)
          sampleLength += part.length
        }
        hash.update(chunk)
        writeSync(handle, chunk)
      }
      if (length === 0)
        throw new CorpusError('EMPTY_SOURCE', 'Source must not be empty')
      fsyncSync(handle)
      closeSync(handle)
      handle = undefined
      const mediaType = sniffMediaType(name, Buffer.concat(sample))
      if (
        input.declaredMediaType &&
        input.declaredMediaType !== 'application/octet-stream' &&
        input.declaredMediaType !== mediaType
      )
        throw new CorpusError(
          'MIME_MISMATCH',
          'Declared and detected media types differ',
        )
      renameSync(temporary, snapshotPath)
      const timestamp = this.#now().toISOString()
      const contentHash = `sha256:${hash.digest('hex')}`
      const state = this.#load()
      const duplicateRevision = state.revisions.find(
        (revision) =>
          scoped(revision, input.scope) && revision.contentHash === contentHash,
      )
      if (duplicateRevision) {
        rmSync(snapshotPath)
        const source = state.sources.find(
          (candidate) =>
            scoped(candidate, input.scope) &&
            candidate.sourceId === duplicateRevision.sourceId,
        )!
        const job = state.jobs.find(
          (candidate) =>
            scoped(candidate, input.scope) &&
            candidate.revisionId === duplicateRevision.revisionId,
        )!
        return jsonClone({ source, revision: duplicateRevision, job })
      }
      const storageKey = relative(this.#root, snapshotPath)
      if (
        !storageKey.startsWith(
          `raw/${input.scope.tenantId}/${input.scope.organizationId}/${input.scope.workspaceId}/`,
        )
      )
        throw new CorpusError(
          'INVALID_STORAGE_KEY',
          'Snapshot storage key is not tenant scoped',
        )
      const source: Source = {
        version: 1,
        ...input.scope,
        sourceId,
        kind: sourceKind(mediaType),
        displayName: name,
        status: 'pending',
        currentRevisionId: revisionId,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      }
      const revision: SourceRevision = {
        version: 1,
        ...input.scope,
        sourceId,
        revisionId,
        contentHash,
        byteLength: length,
        mediaType,
        parserVersion:
          mediaType === 'application/pdf'
            ? PDF_PARSER_VERSION
            : 'corpus-text-parser-v1',
        language: inferredLanguage(mediaType),
        provenance: {
          kind: input.provenance?.kind ?? 'upload',
          originalName: name,
          workspacePath: input.provenance?.workspacePath ?? null,
        },
        rawSnapshot: { immutable: true, storageKey, createdAt: timestamp },
        status: 'pending',
        createdAt: timestamp,
      }
      const job: ExtractionJob = {
        version: 1,
        ...input.scope,
        jobId: `job_${randomUUID()}`,
        sourceId,
        revisionId,
        status: 'pending',
        attempt: 1,
        maxAttempts: this.#limits.maxAttempts,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAt: null,
        errorCode: null,
        usageCompleteness: 'partial',
        startedAt: null,
        completedAt: null,
        updatedAt: timestamp,
      }
      state.sources.push(source)
      state.revisions.push(revision)
      state.jobs.push(job)
      this.#audit(
        state,
        input.scope,
        sourceId,
        revisionId,
        job.jobId,
        'source.created',
        'success',
        'SOURCE_REGISTERED',
      )
      this.#save(state)
      return jsonClone({ source, revision, job })
    } catch (error) {
      if (handle !== undefined) closeSync(handle)
      rmSync(temporary, { force: true })
      rmSync(snapshotPath, { force: true })
      throw error
    }
  }

  #audit(
    state: RegistryState,
    scope: CorpusScope,
    sourceId: string,
    revisionId: string | null,
    jobId: string | null,
    action: IngestionAudit['action'],
    outcome: IngestionAudit['outcome'],
    reasonCode: string,
  ) {
    state.audit.push({
      version: 1,
      ...scope,
      auditId: `iaud_${randomUUID()}`,
      sourceId,
      revisionId,
      jobId,
      action,
      outcome,
      reasonCode,
      occurredAt: this.#now().toISOString(),
    })
  }

  listSources(scope: CorpusScope) {
    return jsonClone(
      this.#load().sources.filter((source) => scoped(source, scope)),
    )
  }

  recoverableScopes() {
    const scopes = new Map<string, CorpusScope>()
    for (const job of this.#load().jobs) {
      if (!['pending', 'extracting'].includes(job.status)) continue
      const scope = {
        tenantId: job.tenantId,
        organizationId: job.organizationId,
        workspaceId: job.workspaceId,
      }
      scopes.set(
        JSON.stringify([
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
        ]),
        scope,
      )
    }
    return jsonClone([...scopes.values()])
  }

  sourceDetail(scope: CorpusScope, sourceId: string) {
    const state = this.#load()
    const source = state.sources.find(
      (candidate) =>
        scoped(candidate, scope) && candidate.sourceId === sourceId,
    )
    if (!source)
      throw new CorpusError('SOURCE_NOT_FOUND', 'Source was not found')
    return jsonClone({
      source,
      revisions: state.revisions.filter(
        (revision) => scoped(revision, scope) && revision.sourceId === sourceId,
      ),
      jobs: state.jobs.filter(
        (job) => scoped(job, scope) && job.sourceId === sourceId,
      ),
    })
  }

  claimNext(scope: CorpusScope, workerId: string) {
    safePart(workerId, 'workerId')
    const state = this.#load()
    const now = this.#now()
    const job = state.jobs.find(
      (candidate) =>
        scoped(candidate, scope) &&
        (candidate.status === 'pending' ||
          (candidate.status === 'extracting' &&
            candidate.leaseExpiresAt !== null &&
            new Date(candidate.leaseExpiresAt) <= now)) &&
        (candidate.retryAt === null || new Date(candidate.retryAt) <= now),
    )
    if (!job) return null
    job.status = 'extracting'
    job.leaseOwner = workerId
    job.leaseExpiresAt = new Date(
      now.getTime() + this.#limits.leaseMs,
    ).toISOString()
    job.startedAt ??= now.toISOString()
    job.updatedAt = now.toISOString()
    const source = state.sources.find(
      (candidate) =>
        scoped(candidate, scope) && candidate.sourceId === job.sourceId,
    )!
    const revision = state.revisions.find(
      (candidate) =>
        scoped(candidate, scope) && candidate.revisionId === job.revisionId,
    )!
    source.status = revision.status = 'extracting'
    source.updatedAt = now.toISOString()
    this.#audit(
      state,
      scope,
      source.sourceId,
      revision.revisionId,
      job.jobId,
      'extraction.started',
      'success',
      'JOB_CLAIMED',
    )
    this.#save(state)
    return jsonClone(job)
  }

  async processJob(scope: CorpusScope, jobId: string, workerId: string) {
    let state = this.#load()
    const job = state.jobs.find(
      (candidate) => scoped(candidate, scope) && candidate.jobId === jobId,
    )
    if (!job)
      throw new CorpusError('JOB_NOT_FOUND', 'Extraction job was not found')
    if (job.status === 'indexed') return jsonClone(job)
    if (job.status !== 'extracting' || job.leaseOwner !== workerId)
      throw new CorpusError(
        'JOB_LEASE_REQUIRED',
        'Worker does not own the extraction lease',
      )
    const revision = state.revisions.find(
      (candidate) =>
        scoped(candidate, scope) && candidate.revisionId === job.revisionId,
    )!
    const source = state.sources.find(
      (candidate) =>
        scoped(candidate, scope) && candidate.sourceId === job.sourceId,
    )!
    const path = join(this.#root, revision.rawSnapshot.storageKey)
    this.#assertInside(path)
    try {
      if (lstatSync(path).isSymbolicLink())
        throw new CorpusError(
          'CORPUS_SYMLINK_REJECTED',
          'Snapshot symlink is not allowed',
        )
      if (statSync(path).size !== revision.byteLength)
        throw new CorpusError(
          'SNAPSHOT_INTEGRITY_FAILED',
          'Snapshot length changed',
        )
      const buffers: Buffer[] = []
      let total = 0
      for await (const buffer of createReadStream(path, {
        highWaterMark: 64 * 1024,
      })) {
        total += buffer.length
        if (total > this.#limits.maxBytes)
          throw new CorpusError(
            'SOURCE_TOO_LARGE',
            'Source exceeds configured byte limit',
          )
        buffers.push(buffer)
      }
      const bytes = Buffer.concat(buffers)
      if (sha256(bytes) !== revision.contentHash)
        throw new CorpusError(
          'SNAPSHOT_INTEGRITY_FAILED',
          'Snapshot hash changed',
        )
      const extracted = await extractDocumentBounded({
        mediaType: revision.mediaType,
        bytes,
        limits: this.#limits,
      })
      state = this.#load()
      const liveJob = state.jobs.find(
        (candidate) => scoped(candidate, scope) && candidate.jobId === jobId,
      )!
      if (liveJob.status === 'indexed') return jsonClone(liveJob)
      const liveSource = state.sources.find(
        (candidate) =>
          scoped(candidate, scope) && candidate.sourceId === source.sourceId,
      )!
      const liveRevision = state.revisions.find(
        (candidate) =>
          scoped(candidate, scope) &&
          candidate.revisionId === revision.revisionId,
      )!
      state.chunks = state.chunks.filter(
        (chunk) =>
          !(scoped(chunk, scope) && chunk.revisionId === revision.revisionId),
      )
      state.indexDocuments = state.indexDocuments.filter(
        (document) =>
          !(
            scoped(document, scope) &&
            document.revisionId === revision.revisionId
          ),
      )
      extracted.forEach((entry, ordinal) => {
        const chunkHash = sha256(entry.text)
        const chunkId = `chk_${createHash('sha256')
          .update(`${revision.revisionId}\0${ordinal}\0${chunkHash}`)
          .digest('hex')}`
        const chunk: CorpusChunk = {
          version: 1,
          ...scope,
          chunkId,
          sourceId: source.sourceId,
          revisionId: revision.revisionId,
          ordinal,
          contentHash: chunkHash,
          locator: entry.locator,
          chunkingPolicy: {
            version: 'character-lines-v1',
            maxCharacters: this.#limits.maxChunkCharacters,
            overlapCharacters: this.#limits.overlapCharacters,
          },
          metadata: {
            mediaType: revision.mediaType,
            parserVersion: revision.parserVersion,
          },
          createdAt: this.#now().toISOString(),
        }
        state.chunks.push(chunk)
        state.indexDocuments.push({
          version: 1,
          ...scope,
          indexDocumentId: `idx_${chunkId.slice(4)}`,
          chunkId,
          sourceId: source.sourceId,
          revisionId: revision.revisionId,
          contentHash: chunkHash,
          embeddingVersion: 'unembedded-placeholder-v1',
          embeddingTokenCount: 0,
          status: 'indexed',
          derivedAt: this.#now().toISOString(),
        })
      })
      liveJob.status = 'indexed'
      liveJob.leaseOwner = null
      liveJob.leaseExpiresAt = null
      liveJob.completedAt = this.#now().toISOString()
      liveJob.updatedAt = liveJob.completedAt
      liveJob.usageCompleteness = 'complete'
      liveSource.status = liveRevision.status = 'indexed'
      liveSource.updatedAt = liveJob.completedAt
      this.#audit(
        state,
        scope,
        liveSource.sourceId,
        liveRevision.revisionId,
        jobId,
        'extraction.completed',
        'success',
        'INDEX_DERIVED',
      )
      this.#save(state)
      return jsonClone(liveJob)
    } catch (error) {
      state = this.#load()
      const liveJob = state.jobs.find(
        (candidate) => scoped(candidate, scope) && candidate.jobId === jobId,
      )!
      const liveSource = state.sources.find(
        (candidate) =>
          scoped(candidate, scope) && candidate.sourceId === job.sourceId,
      )!
      const liveRevision = state.revisions.find(
        (candidate) =>
          scoped(candidate, scope) && candidate.revisionId === job.revisionId,
      )!
      const code = error instanceof CorpusError ? error.code : 'PARSER_FAILED'
      liveJob.errorCode = code
      liveJob.leaseOwner = null
      liveJob.leaseExpiresAt = null
      liveJob.updatedAt = this.#now().toISOString()
      liveJob.usageCompleteness = 'partial'
      if (liveJob.attempt >= liveJob.maxAttempts) {
        liveJob.status = 'failed'
        liveSource.status = liveRevision.status = 'failed'
      } else {
        liveJob.status = 'pending'
        liveJob.attempt += 1
        liveJob.retryAt = this.#now().toISOString()
        liveSource.status = liveRevision.status = 'pending'
      }
      liveSource.updatedAt = liveJob.updatedAt
      this.#audit(
        state,
        scope,
        liveSource.sourceId,
        liveRevision.revisionId,
        jobId,
        'extraction.failed',
        'failure',
        code,
      )
      this.#save(state)
      throw error
    }
  }

  deleteSource(scope: CorpusScope, sourceId: string) {
    const state = this.#load()
    const source = state.sources.find(
      (candidate) =>
        scoped(candidate, scope) && candidate.sourceId === sourceId,
    )
    if (!source)
      throw new CorpusError('SOURCE_NOT_FOUND', 'Source was not found')
    if (source.status === 'deleted') return jsonClone(source)
    const timestamp = this.#now().toISOString()
    source.status = 'deleted'
    source.deletedAt = timestamp
    source.updatedAt = timestamp
    state.revisions
      .filter(
        (revision) => scoped(revision, scope) && revision.sourceId === sourceId,
      )
      .forEach((revision) => (revision.status = 'deleted'))
    state.jobs
      .filter((job) => scoped(job, scope) && job.sourceId === sourceId)
      .forEach((job) => {
        job.status = 'deleted'
        job.updatedAt = timestamp
      })
    state.chunks = state.chunks.filter(
      (chunk) => !(scoped(chunk, scope) && chunk.sourceId === sourceId),
    )
    state.indexDocuments = state.indexDocuments.filter(
      (document) =>
        !(scoped(document, scope) && document.sourceId === sourceId),
    )
    this.#audit(
      state,
      scope,
      sourceId,
      source.currentRevisionId,
      null,
      'source.deleted',
      'success',
      'SOURCE_TOMBSTONED',
    )
    this.#save(state)
    return jsonClone(source)
  }

  reindexSource(scope: CorpusScope, sourceId: string) {
    const state = this.#load()
    const source = state.sources.find(
      (candidate) =>
        scoped(candidate, scope) && candidate.sourceId === sourceId,
    )
    if (!source || source.status === 'deleted')
      throw new CorpusError('SOURCE_NOT_FOUND', 'Source was not found')
    const existing = state.jobs.find(
      (job) =>
        scoped(job, scope) &&
        job.revisionId === source.currentRevisionId &&
        ['pending', 'extracting'].includes(job.status),
    )
    if (existing) return jsonClone(existing)
    const timestamp = this.#now().toISOString()
    const job: ExtractionJob = {
      version: 1,
      ...scope,
      jobId: `job_${randomUUID()}`,
      sourceId,
      revisionId: source.currentRevisionId!,
      status: 'pending',
      attempt: 1,
      maxAttempts: this.#limits.maxAttempts,
      leaseOwner: null,
      leaseExpiresAt: null,
      retryAt: null,
      errorCode: null,
      usageCompleteness: 'partial',
      startedAt: null,
      completedAt: null,
      updatedAt: timestamp,
    }
    source.status = 'pending'
    source.updatedAt = timestamp
    state.jobs.push(job)
    this.#audit(
      state,
      scope,
      sourceId,
      job.revisionId,
      job.jobId,
      'source.reindexed',
      'success',
      'REINDEX_QUEUED',
    )
    this.#save(state)
    return jsonClone(job)
  }

  rebuildDerivedIndex(scope: CorpusScope) {
    const state = this.#load()
    state.chunks = state.chunks.filter((chunk) => !scoped(chunk, scope))
    state.indexDocuments = state.indexDocuments.filter(
      (document) => !scoped(document, scope),
    )
    const timestamp = this.#now().toISOString()
    const jobs: ExtractionJob[] = []
    for (const source of state.sources.filter(
      (candidate) => scoped(candidate, scope) && candidate.status !== 'deleted',
    )) {
      const revision = state.revisions.find(
        (candidate) =>
          scoped(candidate, scope) &&
          candidate.revisionId === source.currentRevisionId,
      )!
      const active = state.jobs.find(
        (candidate) =>
          scoped(candidate, scope) &&
          candidate.revisionId === revision.revisionId &&
          ['pending', 'extracting'].includes(candidate.status),
      )
      if (active) {
        jobs.push(active)
        continue
      }
      const job: ExtractionJob = {
        version: 1,
        ...scope,
        jobId: `job_${randomUUID()}`,
        sourceId: source.sourceId,
        revisionId: revision.revisionId,
        status: 'pending',
        attempt: 1,
        maxAttempts: this.#limits.maxAttempts,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAt: null,
        errorCode: null,
        usageCompleteness: 'partial',
        startedAt: null,
        completedAt: null,
        updatedAt: timestamp,
      }
      source.status = revision.status = 'pending'
      source.updatedAt = timestamp
      state.jobs.push(job)
      jobs.push(job)
      this.#audit(
        state,
        scope,
        source.sourceId,
        revision.revisionId,
        job.jobId,
        'source.reindexed',
        'success',
        'FULL_REBUILD_QUEUED',
      )
    }
    this.#save(state)
    return jsonClone(jobs)
  }

  derivedSnapshot(scope: CorpusScope) {
    const state = this.#load()
    return jsonClone({
      chunks: state.chunks.filter((chunk) => scoped(chunk, scope)),
      indexDocuments: state.indexDocuments.filter((document) =>
        scoped(document, scope),
      ),
      usage: state.usage.filter((entry) => scoped(entry, scope)),
      audits: state.audit.filter((entry) => scoped(entry, scope)),
    })
  }
}

export function singleChunk(value: Uint8Array) {
  return {
    async *[Symbol.asyncIterator]() {
      yield value
    },
  }
}
