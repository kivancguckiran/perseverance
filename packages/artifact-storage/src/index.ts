import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
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
  kind: 'command-output'
  byteLength: number
  sha256: string | null
  chunkCount: number
  ranges: ArtifactRange[]
  finalized: boolean
  createdAt: string
  finalizedAt: string | null
}
export interface AppendInput {
  artifactId: string
  scope: ArtifactScope
  chunkIndex: number
  stream: 'stdout' | 'stderr' | 'combined'
  data: Uint8Array | string
}
export interface ArtifactStorage {
  create(scope: ArtifactScope): ArtifactMetadata
  append(input: AppendInput): ArtifactMetadata
  finalize(artifactId: string, scope: ArtifactScope): ArtifactMetadata
  metadata(
    artifactId: string,
    scope: Pick<ArtifactScope, 'tenantId' | 'workspaceId'>,
  ): ArtifactMetadata
  read(
    artifactId: string,
    scope: Pick<ArtifactScope, 'tenantId' | 'workspaceId'>,
    range?: { start: number; end: number },
  ): Uint8Array
  recover(): void
  cleanupOrphans(maxAgeMs: number): number
}

const secretPatterns = [
  /\bBearer\s+\S+/gi,
  /\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g,
]
export function redactCommandOutput(value: string): string {
  return secretPatterns.reduce((v, p) => v.replace(p, '[REDACTED]'), value)
}
function safePart(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..')
    throw new Error('INVALID_ARTIFACT_SCOPE')
  return value
}

export class LocalArtifactStorage implements ArtifactStorage {
  readonly #root: string
  constructor(root: string) {
    mkdirSync(root, { recursive: true })
    this.#root = realpathSync(root)
    this.recover()
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
  create(scope: ArtifactScope) {
    const artifactId = `art_${randomUUID()}`
    const p = this.#paths(artifactId, scope)
    mkdirSync(p.dir, { recursive: true })
    const now = new Date().toISOString()
    const meta: ArtifactMetadata = {
      ...scope,
      artifactId,
      kind: 'command-output',
      byteLength: 0,
      sha256: null,
      chunkCount: 0,
      ranges: [],
      finalized: false,
      createdAt: now,
      finalizedAt: null,
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
    const existing = m.ranges.find((r) => r.chunkIndex === input.chunkIndex)
    if (existing) return m
    if (input.chunkIndex !== m.chunkCount)
      throw new Error('ARTIFACT_CHUNK_ORDER')
    const bytes = Buffer.from(
      redactCommandOutput(
        typeof input.data === 'string'
          ? input.data
          : Buffer.from(input.data).toString('utf8'),
      ),
    )
    const fd = openSync(found.temp, 'a', 0o600)
    try {
      writeSync(fd, bytes)
    } finally {
      closeSync(fd)
    }
    m.ranges.push({
      chunkIndex: input.chunkIndex,
      startByte: m.byteLength,
      endByte: m.byteLength + bytes.length - 1,
      byteLength: bytes.length,
      stream: input.stream,
    })
    m.byteLength += bytes.length
    m.chunkCount++
    this.#writeMeta(found.metadata, m)
    return m
  }
  finalize(id: string, scope: ArtifactScope) {
    const f = this.#find(id, scope)
    const m = f.meta
    if (m.finalized) return m
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
    m.finalizedAt = new Date().toISOString()
    this.#writeMeta(f.metadata, m)
    return m
  }
  metadata(id: string, scope: Pick<ArtifactScope, 'tenantId' | 'workspaceId'>) {
    return this.#find(id, scope).meta
  }
  read(
    id: string,
    scope: Pick<ArtifactScope, 'tenantId' | 'workspaceId'>,
    range?: { start: number; end: number },
  ) {
    const f = this.#find(id, scope)
    if (!f.meta.finalized) throw new Error('ARTIFACT_NOT_FINALIZED')
    const all = readFileSync(f.data)
    return range ? all.subarray(range.start, range.end + 1) : all
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
          m.sha256 = createHash('sha256')
            .update(readFileSync(data))
            .digest('hex')
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
  const bytes = Buffer.from(current + chunk)
  if (bytes.length <= limit) return bytes.toString()
  let start = bytes.length - limit
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString()
}
