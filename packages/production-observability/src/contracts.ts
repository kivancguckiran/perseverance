import { z } from 'zod'

export const OBSERVABILITY_CONTRACT_VERSION = 1 as const
const opaqueId = z.string().regex(/^[A-Za-z0-9._:-]{1,255}$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.iso.datetime()

export const traceContextSchema = z.object({
  schemaVersion: z.literal(OBSERVABILITY_CONTRACT_VERSION),
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  spanId: z.string().regex(/^[a-f0-9]{16}$/),
  parentSpanId: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .nullable(),
  traceFlags: z.literal('01'),
})

export const sliNameSchema = z.enum([
  'api_availability',
  'api_error_rate',
  'turn_admission_latency',
  'turn_start_latency',
  'scheduler_queue_wait',
  'scheduler_lease_recovery',
  'event_broker_lag',
  'event_replay_lag',
  'reconnect_recovery',
  'approval_latency',
  'indexing_freshness',
  'backup_success',
  'restore_success',
  'region_failover_rpo',
  'region_failover_rto',
])

export const sloTargetSchema = z.object({
  schemaVersion: z.literal(OBSERVABILITY_CONTRACT_VERSION),
  sli: sliNameSchema,
  objective: z.number().positive(),
  unit: z.enum(['ratio', 'milliseconds']),
  comparison: z.enum(['gte', 'lte']),
  window: z.enum(['rolling_28d', 'per_operation']),
  owner: opaqueId,
  runbook: z.string().startsWith('docs/runbooks/'),
})

export const backupComponentSchema = z.object({
  kind: z.enum([
    'postgres_base',
    'postgres_wal',
    'key_metadata',
    'objects',
    'event_broker',
    'index_manifest',
    'configuration',
  ]),
  objectKey: opaqueId,
  checksumSha256: sha256,
  byteLength: z.number().int().nonnegative(),
  encryptionKeyVersion: opaqueId.nullable(),
  required: z.boolean(),
})

export const backupManifestSchema = z.object({
  schemaVersion: z.literal(OBSERVABILITY_CONTRACT_VERSION),
  manifestId: opaqueId,
  authority: z.literal('postgresql-primary'),
  sourceRegion: opaqueId,
  createdAt: timestamp,
  consistencyWatermark: z.object({
    capturedAt: timestamp,
    postgresLsn: z.string().regex(/^[A-F0-9]+\/[A-F0-9]+$/),
    eventHighWater: z.number().int().nonnegative(),
    objectVersionWatermark: opaqueId,
  }),
  dependencies: z.record(opaqueId, opaqueId),
  components: z.array(backupComponentSchema).min(6),
  previousManifestSha256: sha256.nullable(),
  manifestSha256: sha256,
})

export const restoreEvidenceSchema = z.object({
  schemaVersion: z.literal(OBSERVABILITY_CONTRACT_VERSION),
  evidenceId: opaqueId,
  manifestId: opaqueId,
  isolatedTargetId: opaqueId,
  targetRegion: opaqueId,
  startedAt: timestamp,
  completedAt: timestamp,
  restoreOrder: z.tuple([
    z.literal('postgresql'),
    z.literal('key_metadata'),
    z.literal('objects'),
    z.literal('event_broker'),
    z.literal('derived_index'),
  ]),
  checksumVerified: z.literal(true),
  watermarkVerified: z.literal(true),
  tenantGraphVerified: z.literal(true),
  duplicateTurns: z.literal(0),
  eventGaps: z.literal(0),
  auditChainBreaks: z.literal(0),
  rpoMs: z.number().int().nonnegative(),
  rtoMs: z.number().int().nonnegative(),
  previousEvidenceSha256: sha256.nullable(),
  evidenceSha256: sha256,
})

export type TraceContext = z.infer<typeof traceContextSchema>
export type SliName = z.infer<typeof sliNameSchema>
export type SloTarget = z.infer<typeof sloTargetSchema>
export type BackupManifest = z.infer<typeof backupManifestSchema>
export type RestoreEvidence = z.infer<typeof restoreEvidenceSchema>
