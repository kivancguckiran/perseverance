import { createHash } from 'node:crypto'
import {
  backupManifestSchema,
  restoreEvidenceSchema,
  type BackupManifest,
  type RestoreEvidence,
} from './contracts'

export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export function sealManifest(
  input: Omit<BackupManifest, 'manifestSha256'>,
): BackupManifest {
  return backupManifestSchema.parse({
    ...input,
    manifestSha256: sha256(canonical(input)),
  })
}

export function verifyManifest(
  manifest: BackupManifest,
  bodies: ReadonlyMap<string, Uint8Array>,
) {
  const parsed = backupManifestSchema.parse(manifest)
  const { manifestSha256, ...unsigned } = parsed
  if (sha256(canonical(unsigned)) !== manifestSha256)
    throw new Error('BACKUP_MANIFEST_CHECKSUM_MISMATCH')
  for (const component of parsed.components) {
    const body = bodies.get(component.objectKey)
    if (!body) {
      if (component.required)
        throw new Error(`BACKUP_COMPONENT_MISSING:${component.kind}`)
      continue
    }
    if (
      body.byteLength !== component.byteLength ||
      sha256(body) !== component.checksumSha256
    )
      throw new Error(`BACKUP_COMPONENT_CORRUPT:${component.kind}`)
    if (component.kind === 'key_metadata' && !component.encryptionKeyVersion)
      throw new Error('BACKUP_KEY_METADATA_VERSION_MISSING')
  }
  return parsed
}

export interface RestoreGraph {
  tenants: string[]
  workspaces: Array<{ tenantId: string; workspaceId: string }>
  sessions: Array<{ tenantId: string; workspaceId: string; sessionId: string }>
  runs: Array<{
    tenantId: string
    workspaceId: string
    sessionId: string
    runId: string
  }>
  events: Array<{
    tenantId: string
    workspaceId: string
    sessionId: string
    eventId: string
    sequence: number
  }>
  audit: Array<{
    id: string
    previousHash: string | null
    hash: string
    payloadHash: string
  }>
}

export function validateRestoreGraph(graph: RestoreGraph) {
  const tenants = new Set(graph.tenants)
  const workspace = new Map(
    graph.workspaces.map((item) => [
      `${item.tenantId}/${item.workspaceId}`,
      item,
    ]),
  )
  const session = new Map(
    graph.sessions.map((item) => [
      `${item.tenantId}/${item.workspaceId}/${item.sessionId}`,
      item,
    ]),
  )
  const runIds = new Set<string>()
  for (const item of graph.workspaces)
    if (!tenants.has(item.tenantId))
      throw new Error('RESTORE_CROSS_TENANT_WORKSPACE')
  for (const item of graph.sessions)
    if (!workspace.has(`${item.tenantId}/${item.workspaceId}`))
      throw new Error('RESTORE_ORPHAN_SESSION')
  for (const item of graph.runs) {
    if (!session.has(`${item.tenantId}/${item.workspaceId}/${item.sessionId}`))
      throw new Error('RESTORE_CROSS_TENANT_RUN')
    if (runIds.has(item.runId)) throw new Error('RESTORE_DUPLICATE_TURN')
    runIds.add(item.runId)
  }
  const sequences = new Map<string, number[]>()
  const eventIds = new Set<string>()
  for (const item of graph.events) {
    if (!session.has(`${item.tenantId}/${item.workspaceId}/${item.sessionId}`))
      throw new Error('RESTORE_CROSS_TENANT_EVENT')
    if (eventIds.has(item.eventId)) throw new Error('RESTORE_DUPLICATE_EVENT')
    eventIds.add(item.eventId)
    const key = `${item.tenantId}/${item.workspaceId}/${item.sessionId}`
    sequences.set(key, [...(sequences.get(key) ?? []), item.sequence])
  }
  for (const values of sequences.values()) {
    values.sort((a, b) => a - b)
    for (let index = 0; index < values.length; index++)
      if (values[index] !== index + 1) throw new Error('RESTORE_EVENT_GAP')
  }
  let previous: string | null = null
  for (const item of graph.audit) {
    if (item.previousHash !== previous)
      throw new Error('RESTORE_AUDIT_CHAIN_BREAK')
    const expected = sha256(
      `${item.id}:${item.payloadHash}:${item.previousHash ?? ''}`,
    )
    if (expected !== item.hash) throw new Error('RESTORE_AUDIT_HASH_MISMATCH')
    previous = item.hash
  }
}

export function sealRestoreEvidence(
  input: Omit<RestoreEvidence, 'evidenceSha256'>,
): RestoreEvidence {
  return restoreEvidenceSchema.parse({
    ...input,
    evidenceSha256: sha256(canonical(input)),
  })
}

export function requireKeyAvailable(
  availableVersions: ReadonlySet<string>,
  manifest: BackupManifest,
) {
  const required = manifest.components
    .filter((item) => item.kind === 'key_metadata' || item.encryptionKeyVersion)
    .flatMap((item) =>
      item.encryptionKeyVersion ? [item.encryptionKeyVersion] : [],
    )
  for (const version of required)
    if (!availableVersions.has(version))
      throw new Error(`RESTORE_KEY_UNAVAILABLE:${version}`)
}
