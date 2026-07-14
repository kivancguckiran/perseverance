import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  accessSync,
  constants,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createReadStream, type ReadStream } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const DEFAULT_COMMAND_TAIL_BYTES = 64 * 1024
export const DEFAULT_ARTIFACT_CHUNK_BYTES = 64 * 1024

export interface ArtifactScope {
  tenantId: string
  workspaceId: string
  sessionId: string
  turnId: string
  itemId: string
}
export interface ArtifactRange {
  chunkIndex: number
  startByte: number
  endByte: number
  byteLength: number
  stream: 'stdout' | 'stderr' | 'combined'
}
export interface ArtifactMetadata extends ArtifactScope {
  artifactId: string
  kind: 'command-output' | 'git-diff'
  byteLength: number
  sha256: string | null
  chunkCount: number
  ranges: ArtifactRange[]
  finalized: boolean
  createdAt: string
  finalizedAt: string | null
  status: 'writing' | 'finalized' | 'recovery_required'
}
export interface AppendInput {
  artifactId: string
  scope: ArtifactScope
  chunkIndex: number
  stream: 'stdout' | 'stderr' | 'combined'
  data: Uint8Array | string
  sourceKey?: string
}
export interface ArtifactStorage {
  probe(): void
  create(
    scope: ArtifactScope,
    kind?: ArtifactMetadata['kind'],
  ): ArtifactMetadata
  append(input: AppendInput): ArtifactMetadata
  finalize(artifactId: string, scope: ArtifactScope): ArtifactMetadata
  metadata(
    artifactId: string,
    scope: Pick<ArtifactScope, 'tenantId' | 'workspaceId'>,
  ): ArtifactMetadata
  openReadStream(
    artifactId: string,
    scope: Pick<ArtifactScope, 'tenantId' | 'workspaceId'>,
    range?: { start: number; end: number },
  ): ReadStream
  recover(): void
  cleanupOrphans(maxAgeMs: number): number
}

export function redactCommandOutput(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, '[REDACTED]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(
      /["']?(?:api[_-]?key|access[_-]?token|secret|password)["']?\s*[:=]\s*["'][^"']+["']/gi,
      '[REDACTED]',
    )
}

export class StreamingRedactor {
  static readonly MAX_CARRY_BYTES = 4 * 1024
  #carry = ''
  get carryBytes() {
    return Buffer.byteLength(this.#carry)
  }
  push(input: string, final = false): string {
    const combined = this.#carry + input
    if (final) {
      this.#carry = ''
      return redactCommandOutput(combined)
    }
    const markers = [
      'bearer ',
      'sk-',
      'sess-',
      'api_key',
      'apikey',
      'access_token',
      'secret',
      'password',
    ]
    let cut = combined.length
    const lower = combined.toLowerCase()
    for (const marker of markers) {
      const found = lower.lastIndexOf(marker)
      if (found >= 0) {
        const tail = combined.slice(found + marker.length)
        const structured = [
          'api_key',
          'apikey',
          'access_token',
          'secret',
          'password',
        ].includes(marker)
        if (structured && !/^["']?\s*[:=]/.test(tail)) continue
        const terminated = structured
          ? /^["']?\s*[:=]\s*["'][^"']+["']/.test(tail)
          : /\s/.test(tail)
        if (!terminated) cut = Math.min(cut, found)
      }
      for (let length = 1; length < marker.length; length++)
        if (lower.endsWith(marker.slice(0, length)))
          cut = Math.min(cut, combined.length - length)
    }
    cut = Math.max(cut, combined.length - StreamingRedactor.MAX_CARRY_BYTES)
    this.#carry = combined.slice(cut)
    return redactCommandOutput(combined.slice(0, cut))
  }
}
function safePart(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..')
    throw new Error('INVALID_ARTIFACT_SCOPE')
  return value
}

export class LocalArtifactStorage implements ArtifactStorage {
  readonly #root: string
  readonly #redactors = new Map<string, StreamingRedactor>()
  constructor(root: string) {
    mkdirSync(root, { recursive: true })
    this.#root = realpathSync(root)
    this.recover()
  }
  probe(): void {
    const stat = lstatSync(this.#root)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('ARTIFACT_STORAGE_UNAVAILABLE')
    accessSync(this.#root, constants.R_OK | constants.W_OK | constants.X_OK)
  }
  #dir(scope: ArtifactScope) {
    return join(
      this.#root,
      ...[
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
        scope.turnId,
        scope.itemId,
      ].map(safePart),
    )
  }
  #paths(id: string, scope: ArtifactScope) {
    safePart(id)
    const dir = this.#dir(scope)
    const data = join(dir, `${id}.data`)
    const metadata = join(dir, `${id}.json`)
    this.#assert(data)
    return { dir, data, metadata, temp: `${data}.tmp` }
  }
  #assert(path: string) {
    const rel = relative(this.#root, resolve(path))
    if (
      rel.startsWith('..') ||
      rel.includes(`${sep}..${sep}`) ||
      resolve(path).startsWith('/proc') ||
      resolve(path).startsWith('/sys')
    )
      throw new Error('ARTIFACT_PATH_ESCAPE')
  }
  #find(id: string, scope: Pick<ArtifactScope, 'tenantId' | 'workspaceId'>) {
    safePart(id)
    const base = join(
      this.#root,
      safePart(scope.tenantId),
      safePart(scope.workspaceId),
    )
    if (!existsSync(base)) throw new Error('ARTIFACT_NOT_FOUND')
    const stack = [base]
    while (stack.length) {
      const dir = stack.pop()!
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        const st = lstatSync(path)
        if (st.isSymbolicLink()) throw new Error('ARTIFACT_SYMLINK_REJECTED')
        if (st.isDirectory()) stack.push(path)
        else if (name === `${id}.json`) {
          const meta = JSON.parse(
            readFileSync(path, 'utf8'),
          ) as ArtifactMetadata
          return {
            meta,
            metadata: path,
            data: join(dirname(path), `${id}.data`),
            temp: join(dirname(path), `${id}.data.tmp`),
          }
        }
      }
    }
    throw new Error('ARTIFACT_NOT_FOUND')
  }
  create(
    scope: ArtifactScope,
    kind: ArtifactMetadata['kind'] = 'command-output',
  ) {
    const artifactId = `art_${randomUUID()}`
    const p = this.#paths(artifactId, scope)
    mkdirSync(p.dir, { recursive: true })
    const now = new Date().toISOString()
    const meta: ArtifactMetadata = {
      ...scope,
      artifactId,
      kind,
      byteLength: 0,
      sha256: null,
      chunkCount: 0,
      ranges: [],
      finalized: false,
      createdAt: now,
      finalizedAt: null,
      status: 'writing',
    }
    writeFileSync(p.temp, '', { flag: 'wx', mode: 0o600 })
    this.#writeMeta(p.metadata, meta)
    return meta
  }
  append(input: AppendInput) {
    const found = this.#find(input.artifactId, input.scope)
    const m = found.meta
    if (m.finalized) return m
    if (
      Object.keys(input.scope).some(
        (k) =>
          input.scope[k as keyof ArtifactScope] !== m[k as keyof ArtifactScope],
      )
    )
      throw new Error('ARTIFACT_SCOPE_MISMATCH')
    const internal = m as ArtifactMetadata & {
      sourceKeys?: string[]
      sourceIndexes?: number[]
    }
    if (input.sourceKey && internal.sourceKeys?.includes(input.sourceKey))
      return m
    if (internal.sourceIndexes?.includes(input.chunkIndex)) return m
    if (input.chunkIndex !== (internal.sourceIndexes?.length ?? 0))
      throw new Error('ARTIFACT_CHUNK_ORDER')
    const redactor =
      this.#redactors.get(input.artifactId) ?? new StreamingRedactor()
    this.#redactors.set(input.artifactId, redactor)
    const source =
      typeof input.data === 'string'
        ? input.data
        : Buffer.from(input.data).toString('utf8')
    for (
      let offset = 0;
      offset < source.length;
      offset += DEFAULT_ARTIFACT_CHUNK_BYTES
    ) {
      const redacted = redactor.push(
        source.slice(offset, offset + DEFAULT_ARTIFACT_CHUNK_BYTES),
      )
      this.#writeRedacted(found.temp, m, input.stream, redacted)
    }
    if (input.sourceKey) (internal.sourceKeys ??= []).push(input.sourceKey)
    ;(internal.sourceIndexes ??= []).push(input.chunkIndex)
    this.#writeMeta(found.metadata, m)
    return m
  }
  #writeRedacted(
    path: string,
    m: ArtifactMetadata,
    stream: ArtifactRange['stream'],
    value: string,
  ) {
    const source = Buffer.from(value)
    const fd = openSync(path, 'a', 0o600)
    try {
      for (
        let offset = 0;
        offset < source.length;
        offset += DEFAULT_ARTIFACT_CHUNK_BYTES
      ) {
        const bytes = source.subarray(
          offset,
          offset + DEFAULT_ARTIFACT_CHUNK_BYTES,
        )
        writeSync(fd, bytes)
        m.ranges.push({
          chunkIndex: m.chunkCount,
          startByte: m.byteLength,
          endByte: m.byteLength + bytes.length - 1,
          byteLength: bytes.length,
          stream,
        })
        m.byteLength += bytes.length
        m.chunkCount++
      }
    } finally {
      closeSync(fd)
    }
  }
  finalize(id: string, scope: ArtifactScope) {
    const f = this.#find(id, scope)
    const m = f.meta
    if (m.finalized) return m
    if (m.status === 'recovery_required')
      throw new Error('ARTIFACT_RECOVERY_REQUIRED')
    const redactor = this.#redactors.get(id)
    if (redactor) {
      this.#writeRedacted(f.temp, m, 'combined', redactor.push('', true))
      this.#redactors.delete(id)
    }
    const hash = createHash('sha256')
    const fd = openSync(f.temp, 'r')
    const buf = Buffer.allocUnsafe(DEFAULT_ARTIFACT_CHUNK_BYTES)
    try {
      let n
      while ((n = readSync(fd, buf, 0, buf.length, null)) > 0)
        hash.update(buf.subarray(0, n))
    } finally {
      closeSync(fd)
    }
    renameSync(f.temp, f.data)
    m.sha256 = hash.digest('hex')
    m.finalized = true
    m.status = 'finalized'
    m.finalizedAt = new Date().toISOString()
    this.#writeMeta(f.metadata, m)
    return m
  }
  metadata(id: string, scope: Pick<ArtifactScope, 'tenantId' | 'workspaceId'>) {
    return this.#find(id, scope).meta
  }
  openReadStream(
    id: string,
    scope: Pick<ArtifactScope, 'tenantId' | 'workspaceId'>,
    range?: { start: number; end: number },
  ) {
    const f = this.#find(id, scope)
    if (!f.meta.finalized) throw new Error('ARTIFACT_NOT_FINALIZED')
    return createReadStream(
      f.data,
      range ? { start: range.start, end: range.end } : {},
    )
  }
  recover() {
    for (const metaPath of walk(this.#root, '.json')) {
      try {
        const m = JSON.parse(readFileSync(metaPath, 'utf8')) as ArtifactMetadata
        const tmp = join(dirname(metaPath), `${m.artifactId}.data.tmp`)
        const data = join(dirname(metaPath), `${m.artifactId}.data`)
        if (!m.finalized && !existsSync(tmp) && existsSync(data)) {
          m.finalized = true
          m.finalizedAt = new Date().toISOString()
          const hash = createHash('sha256')
          const fd = openSync(data, 'r')
          const buffer = Buffer.allocUnsafe(DEFAULT_ARTIFACT_CHUNK_BYTES)
          try {
            let n
            while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0)
              hash.update(buffer.subarray(0, n))
          } finally {
            closeSync(fd)
          }
          m.sha256 = hash.digest('hex')
          m.status = 'finalized'
          this.#writeMeta(metaPath, m)
        } else if (!m.finalized && existsSync(tmp)) {
          m.status = 'recovery_required'
          this.#writeMeta(metaPath, m)
        } else if (!m.finalized && !existsSync(tmp) && !existsSync(data)) {
          m.status = 'recovery_required'
          this.#writeMeta(metaPath, m)
        }
      } catch {}
    }
  }
  cleanupOrphans(maxAgeMs: number) {
    let count = 0
    for (const path of walk(this.#root, '.tmp'))
      if (Date.now() - statSync(path).mtimeMs > maxAgeMs) {
        rmSync(path)
        count++
      }
    return count
  }
  #writeMeta(path: string, m: ArtifactMetadata) {
    const tmp = `${path}.write`
    writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 })
    renameSync(tmp, path)
  }
}
function walk(root: string, suffix: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      const s = lstatSync(p)
      if (s.isSymbolicLink()) continue
      if (s.isDirectory()) stack.push(p)
      else if (n.endsWith(suffix)) out.push(p)
    }
  }
  return out
}

export function appendBoundedTail(
  current: string,
  chunk: string,
  limit = DEFAULT_COMMAND_TAIL_BYTES,
): string {
  let combined = current + chunk
  if (Buffer.byteLength(combined) > limit && combined.length > limit)
    combined = combined.slice(-limit)
  const bytes = Buffer.from(combined)
  if (bytes.length <= limit) return bytes.toString()
  let start = bytes.length - limit
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString()
}
