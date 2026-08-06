import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ObjectStore } from '@perseverance/production-topology/durable-dependencies'
import type { ProductionScope } from '@perseverance/production-topology/production-postgres'
import {
  decryptUserContent,
  encryptUserContent,
  parseUserContentEnvelope,
  type UserContentKeyMaterial,
} from './user-content-crypto'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const MAX_SNAPSHOT_FILES = 20_000
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
const PROVISIONED_ROOT_FILES = new Set(['auth.json', 'config.toml'])

interface CodexRolloutSnapshotV1 {
  schemaVersion: 1
  files: Array<{ path: string; data: string }>
}

function assertSnapshotPath(path: string) {
  if (
    !path ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split(/[\\/]+/).some((part) => !part || part === '..')
  )
    throw new Error('INVALID_CODEX_ROLLOUT_PATH')
}

export function productionCodexRolloutObjectKey(
  scope: ProductionScope,
  sessionId: string,
) {
  return `${scope.tenantId}/${scope.organizationId}/${scope.workspaceId}/sessions/${sessionId}/codex-rollout`
}

export async function captureCodexRolloutSnapshot(
  codexHome: string,
): Promise<Uint8Array> {
  const root = resolve(codexHome)
  const files: CodexRolloutSnapshotV1['files'] = []
  let totalBytes = 0

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name)
      const path = relative(root, absolute)
      assertSnapshotPath(path)
      if (!path.includes('/') && PROVISIONED_ROOT_FILES.has(path)) continue
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink())
        throw new Error('CODEX_ROLLOUT_SYMLINK_REJECTED')
      if (metadata.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (!metadata.isFile())
        throw new Error('CODEX_ROLLOUT_SPECIAL_FILE_REJECTED')
      if (files.length >= MAX_SNAPSHOT_FILES)
        throw new Error('CODEX_ROLLOUT_FILE_LIMIT_EXCEEDED')
      const bytes = await readFile(absolute)
      totalBytes += bytes.byteLength
      if (totalBytes > MAX_SNAPSHOT_BYTES)
        throw new Error('CODEX_ROLLOUT_SIZE_LIMIT_EXCEEDED')
      files.push({ path, data: bytes.toString('base64') })
    }
  }

  await visit(root)
  return encoder.encode(JSON.stringify({ schemaVersion: 1, files }))
}

export async function restoreCodexRolloutSnapshot(
  codexHome: string,
  bytes: Uint8Array,
): Promise<void> {
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes))
  } catch {
    throw new Error('INVALID_CODEX_ROLLOUT_SNAPSHOT')
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((value as { files?: unknown }).files)
  )
    throw new Error('INVALID_CODEX_ROLLOUT_SNAPSHOT')

  const root = resolve(codexHome)
  const files = (value as CodexRolloutSnapshotV1).files
  if (files.length > MAX_SNAPSHOT_FILES)
    throw new Error('CODEX_ROLLOUT_FILE_LIMIT_EXCEEDED')
  const seen = new Set<string>()
  let totalBytes = 0
  for (const file of files) {
    if (
      typeof file !== 'object' ||
      file === null ||
      typeof file.path !== 'string' ||
      typeof file.data !== 'string'
    )
      throw new Error('INVALID_CODEX_ROLLOUT_SNAPSHOT')
    assertSnapshotPath(file.path)
    if (!file.path.includes('/') && PROVISIONED_ROOT_FILES.has(file.path))
      throw new Error('CODEX_ROLLOUT_PROVISIONED_FILE_REJECTED')
    if (seen.has(file.path)) throw new Error('CODEX_ROLLOUT_DUPLICATE_PATH')
    seen.add(file.path)
    const target = resolve(root, file.path)
    const scoped = relative(root, target)
    if (scoped.startsWith('..') || isAbsolute(scoped))
      throw new Error('INVALID_CODEX_ROLLOUT_PATH')
    if (
      file.data.length > Math.ceil((MAX_SNAPSHOT_BYTES * 4) / 3) + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.data,
      )
    )
      throw new Error('INVALID_CODEX_ROLLOUT_SNAPSHOT')
    const data = Buffer.from(file.data, 'base64')
    if (data.toString('base64') !== file.data)
      throw new Error('INVALID_CODEX_ROLLOUT_SNAPSHOT')
    totalBytes += data.byteLength
    if (totalBytes > MAX_SNAPSHOT_BYTES)
      throw new Error('CODEX_ROLLOUT_SIZE_LIMIT_EXCEEDED')
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
    await writeFile(target, data, { mode: 0o600, flag: 'wx' })
  }
}

export async function loadProductionCodexRollout(input: {
  objectStore: ObjectStore
  scope: ProductionScope
  sessionId: string
  codexHome: string
  contentKey: UserContentKeyMaterial
}): Promise<boolean> {
  const objectKey = productionCodexRolloutObjectKey(
    input.scope,
    input.sessionId,
  )
  let stored: Uint8Array
  try {
    stored = await input.objectStore.get(objectKey)
  } catch (error) {
    if (error instanceof Error && error.message === 'OBJECT_GET_FAILED:404')
      return false
    throw error
  }
  const envelope = parseUserContentEnvelope(stored)
  if (!envelope) throw new Error('INVALID_CODEX_ROLLOUT_ENVELOPE')
  const snapshot = await decryptUserContent(
    input.contentKey,
    {
      ...input.scope,
      recordType: 'codex_rollout',
      recordId: input.sessionId,
    },
    envelope,
  )
  await restoreCodexRolloutSnapshot(input.codexHome, snapshot)
  return true
}

export async function saveProductionCodexRollout(input: {
  objectStore: ObjectStore
  scope: ProductionScope
  sessionId: string
  codexHome: string
  contentKey: UserContentKeyMaterial
}): Promise<void> {
  const snapshot = await captureCodexRolloutSnapshot(input.codexHome)
  const encrypted = await encryptUserContent(
    input.contentKey,
    {
      ...input.scope,
      recordType: 'codex_rollout',
      recordId: input.sessionId,
    },
    snapshot,
  )
  await input.objectStore.put(
    productionCodexRolloutObjectKey(input.scope, input.sessionId),
    encrypted,
    'application/json; charset=utf-8',
  )
}
