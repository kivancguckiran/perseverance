import { z } from 'zod'

export const TOPOLOGY_CONTRACT_VERSION = 1 as const
const id = z.string().trim().min(1).max(255)
const at = z.iso.datetime()
export const topologyScopeSchema = z.object({
  tenantId: id,
  organizationId: id,
  workspaceId: id,
})

export const capacityVectorSchema = z.object({
  schemaVersion: z.literal(TOPOLOGY_CONTRACT_VERSION),
  cpuMillis: z.number().int().nonnegative(),
  memoryBytes: z.number().int().nonnegative(),
  pids: z.number().int().nonnegative(),
  ioBytesPerSecond: z.number().int().nonnegative(),
  diskBytes: z.number().int().nonnegative(),
  diskInodes: z.number().int().nonnegative(),
  diskIops: z.number().int().nonnegative(),
  egressBytesPerSecond: z.number().int().nonnegative(),
  egressRequestsPerMinute: z.number().int().nonnegative(),
  eventBytesPerSecond: z.number().int().nonnegative(),
  artifactBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
  corpusIndexBytes: z.number().int().nonnegative(),
})

export const placementSchema = topologyScopeSchema.extend({
  schemaVersion: z.literal(TOPOLOGY_CONTRACT_VERSION),
  placementId: id,
  regionId: id,
  nodeId: id,
  runtimeId: id,
  generation: z.number().int().positive(),
  state: z.enum([
    'requested',
    'placed',
    'starting',
    'ready',
    'checkpointing',
    'rescheduling',
    'recovering',
    'drained',
    'failed',
  ]),
  affinity: z.object({
    requiredRegionId: id,
    preferredNodeIds: z.array(id).max(64),
  }),
  capacity: capacityVectorSchema,
  fencingToken: z.number().int().positive(),
  updatedAt: at,
})

export const schedulerQueueItemSchema = topologyScopeSchema.extend({
  schemaVersion: z.literal(TOPOLOGY_CONTRACT_VERSION),
  queueItemId: id,
  runId: id,
  sessionId: id,
  providerId: id,
  idempotencyKey: id,
  state: z.enum([
    'queued',
    'leased',
    'starting',
    'running',
    'retry_wait',
    'completed',
    'failed',
    'poisoned',
    'recovery_required',
  ]),
  priority: z.number().int().min(-100).max(100),
  virtualFinish: z.number().finite().nonnegative(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive().max(100),
  notBefore: at,
  enqueuedAt: at,
  lastErrorCode: id.nullable(),
})

export const tenantSchedulingPolicySchema = z.object({
  schemaVersion: z.literal(TOPOLOGY_CONTRACT_VERSION),
  tenantId: id,
  organizationId: id,
  policyVersion: z.number().int().positive(),
  algorithm: z.literal('weighted-fair-v1'),
  weight: z.number().int().positive().max(1_000),
  tenantConcurrency: z.number().int().positive(),
  workspaceConcurrency: z.literal(1),
  providerConcurrency: z.record(id, z.number().int().positive()),
  providerRequestsPerMinute: z.record(id, z.number().int().positive()),
  starvationAgeMs: z.number().int().positive(),
  retry: z.object({
    maxAttempts: z.number().int().positive(),
    initialBackoffMs: z.number().int().positive(),
    maxBackoffMs: z.number().int().positive(),
    poisonAfterAttempts: z.number().int().positive(),
  }),
  effectiveAt: at,
})

export const capacityReservationSchema = topologyScopeSchema.extend({
  schemaVersion: z.literal(TOPOLOGY_CONTRACT_VERSION),
  reservationId: id,
  queueItemId: id,
  regionId: id,
  nodeId: id,
  runtimeId: id.nullable(),
  state: z.enum(['held', 'bound', 'released', 'expired']),
  capacity: capacityVectorSchema,
  fencingToken: z.number().int().positive(),
  expiresAt: at,
  updatedAt: at,
})

export const workspaceLeaseSchema = topologyScopeSchema.extend({
  schemaVersion: z.literal(TOPOLOGY_CONTRACT_VERSION),
  leaseId: id,
  queueItemId: id,
  runId: id,
  ownerId: id,
  fencingToken: z.number().int().positive(),
  state: z.enum(['active', 'released', 'expired', 'revoked']),
  acquiredAt: at,
  renewedAt: at,
  expiresAt: at,
})

export const drainStateSchema = z.object({
  schemaVersion: z.literal(TOPOLOGY_CONTRACT_VERSION),
  drainId: id,
  targetKind: z.enum(['region', 'node']),
  regionId: id,
  nodeId: id.nullable(),
  state: z.enum([
    'accepting',
    'cordoned',
    'draining',
    'drained',
    'maintenance',
  ]),
  reasonCode: id,
  requestedAt: at,
  deadlineAt: at.nullable(),
  completedAt: at.nullable(),
})

export const recoveryOutcomeSchema = topologyScopeSchema.extend({
  schemaVersion: z.literal(TOPOLOGY_CONTRACT_VERSION),
  recoveryId: id,
  runId: id,
  previousPlacementId: id.nullable(),
  nextPlacementId: id.nullable(),
  previousFencingToken: z.number().int().nonnegative(),
  nextFencingToken: z.number().int().positive(),
  checkpointId: id.nullable(),
  outcome: z.enum([
    'rescheduled',
    'resumed',
    'replayed',
    'outcome_unknown',
    'failed',
  ]),
  reasonCode: id,
  rpoMs: z.number().int().nonnegative(),
  rtoMs: z.number().int().nonnegative(),
  occurredAt: at,
})

export const dependencyReadinessSchema = z.object({
  schemaVersion: z.literal(TOPOLOGY_CONTRACT_VERSION),
  instanceId: id,
  role: z.enum(['api', 'realtime', 'scheduler', 'workspace-agent']),
  mode: z.enum(['development', 'production']),
  ready: z.boolean(),
  checkedAt: at,
  dependencies: z.array(
    z.object({
      name: z.enum([
        'postgresql',
        'event-broker',
        'object-storage',
        'runtime-control',
        'kms',
      ]),
      required: z.boolean(),
      ready: z.boolean(),
      code: id.nullable(),
    }),
  ),
})

export const capacityLimitOutcomeSchema = topologyScopeSchema.extend({
  schemaVersion: z.literal(TOPOLOGY_CONTRACT_VERSION),
  outcomeId: id,
  runId: id,
  resource: z.enum([
    'cpu',
    'memory',
    'pids',
    'io',
    'disk_bytes',
    'disk_inodes',
    'disk_iops',
    'egress_bandwidth',
    'egress_requests',
    'event_bytes',
    'artifact_bytes',
    'output_bytes',
    'corpus_index_bytes',
  ]),
  action: z.enum(['throttled', 'rejected', 'terminated', 'spilled']),
  limit: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  reasonCode: id,
  occurredAt: at,
})

export type CapacityVector = z.infer<typeof capacityVectorSchema>
export type SchedulerQueueItem = z.infer<typeof schedulerQueueItemSchema>
export type TenantSchedulingPolicy = z.infer<
  typeof tenantSchedulingPolicySchema
>
export type WorkspaceLease = z.infer<typeof workspaceLeaseSchema>
export type DependencyReadiness = z.infer<typeof dependencyReadinessSchema>
