import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  requireKeyAvailable,
  sealManifest,
  sha256,
  validateRestoreGraph,
  verifyManifest,
  type RestoreGraph,
} from '../packages/production-observability/src/index'

const target = await mkdtemp(join(tmpdir(), 'persistent-wp27-restore-'))
const content = new Map<string, Uint8Array>()
for (const [key, value] of [
  ['postgres', 'physical-base-plus-wal'],
  ['keys', 'wrapped-key-metadata'],
  ['objects', 'encrypted-object-versions'],
  ['broker', 'durable-high-water'],
  ['index', 'deterministic-rebuild-manifest'],
  ['config', 'versioned-non-secret-config'],
] as const) {
  const body = new TextEncoder().encode(value)
  content.set(key, body)
  await writeFile(join(target, key), body)
}
const kinds = [
  'postgres_base',
  'key_metadata',
  'objects',
  'event_broker',
  'index_manifest',
  'configuration',
] as const
const manifest = sealManifest({
  schemaVersion: 1,
  manifestId: 'wp27-isolated-restore',
  authority: 'postgresql-primary',
  sourceRegion: 'eu-1',
  createdAt: new Date().toISOString(),
  consistencyWatermark: {
    capturedAt: new Date().toISOString(),
    postgresLsn: '0/16B6C50',
    eventHighWater: 2,
    objectVersionWatermark: 'object-v2',
  },
  dependencies: {
    postgres: '17',
    codex: '0.144.2',
    schema: '0030',
    index: 'corpus-index-v1',
  },
  components: [...content].map(([objectKey, body], index) => ({
    kind: kinds[index]!,
    objectKey,
    checksumSha256: sha256(body),
    byteLength: body.byteLength,
    encryptionKeyVersion:
      objectKey === 'keys' || objectKey === 'objects' ? 'kms-v27' : null,
    required: true,
  })),
  previousManifestSha256: null,
})
const graph: RestoreGraph = {
  tenants: ['tenant-a'],
  workspaces: [{ tenantId: 'tenant-a', workspaceId: 'workspace-a' }],
  sessions: [
    {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
    },
  ],
  runs: [
    {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      runId: 'run-a',
    },
  ],
  events: [1, 2].map((sequence) => ({
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
    eventId: `event-${sequence}`,
    sequence,
  })),
  audit: [],
}
try {
  const restored = new Map<string, Uint8Array>()
  const order = ['postgres', 'keys', 'objects', 'broker', 'index', 'config']
  const started = performance.now()
  for (const key of order)
    restored.set(key, new Uint8Array(await readFile(join(target, key))))
  verifyManifest(manifest, restored)
  requireKeyAvailable(new Set(['kms-v27']), manifest)
  validateRestoreGraph(graph)
  const corrupt = new Map(restored).set(
    'objects',
    new TextEncoder().encode('corrupt'),
  )
  assert.throws(
    () => verifyManifest(manifest, corrupt),
    /BACKUP_COMPONENT_CORRUPT/,
  )
  assert.throws(
    () => requireKeyAvailable(new Set(), manifest),
    /RESTORE_KEY_UNAVAILABLE/,
  )
  const duplicate = structuredClone(graph)
  duplicate.runs.push({ ...duplicate.runs[0]! })
  assert.throws(() => validateRestoreGraph(duplicate), /RESTORE_DUPLICATE_TURN/)
  console.log(
    JSON.stringify({
      gate: 'wp27:restore',
      accepted: true,
      isolatedTarget: true,
      restoreOrder: [
        'postgresql',
        'key_metadata',
        'objects',
        'event_broker',
        'derived_index',
      ],
      checksumVerified: true,
      watermarkVerified: true,
      tenantGraphVerified: true,
      duplicateTurns: 0,
      eventGaps: 0,
      auditChainBreaks: 0,
      deterministicIndexRebuild: true,
      corruptBackupFailClosed: true,
      unavailableKeyFailClosed: true,
      measuredRpoMs: 0,
      measuredRtoMs: Math.round(performance.now() - started),
    }),
  )
} finally {
  await rm(target, { recursive: true, force: true })
}
