import { timelineEventSchema } from '@persistent-codex/domain-events'
import { z } from 'zod'

const identifierSchema = z.string().min(1)
const sequenceSchema = z.number().int().nonnegative()
export const readinessStatusSchema = z.enum([
  'checking',
  'ready',
  'setup_required',
  'degraded',
])
export const readinessCheckSchema = z.object({
  name: z.enum([
    'codex',
    'workspace',
    'database',
    'artifacts',
    'codexHome',
    'provisioning',
    'auth',
    'appServer',
    'disk',
  ]),
  status: z.enum(['ready', 'failed']),
  code: z.string().min(1).nullable(),
})
export const readinessResponseSchema = z.object({
  status: readinessStatusSchema,
  checkedAt: z.iso.datetime(),
  checks: z.array(readinessCheckSchema),
  recovery: z.object({
    code: z.literal('AUTH_REQUIRED').nullable(),
    instruction: z.literal('codex login').nullable(),
    retryable: z.boolean(),
    readOnlyAvailable: z.boolean(),
  }),
})
export const sessionStatusSchema = z.enum([
  'starting',
  'active',
  'recovering',
  'recovery_required',
  'failed',
])
export const recoveryErrorCodeSchema = z.enum([
  'THREAD_NOT_RESUMABLE',
  'RECOVERY_OUTCOME_UNKNOWN',
  'RECOVERY_RUNTIME_UNAVAILABLE',
  'RECOVERY_TIMEOUT',
  'RECOVERY_AUTH_REQUIRED',
  'RECOVERY_TRANSIENT_FAILURE',
])
export const recoveryOptionSchema = z.enum([
  'retry_resume',
  'start_new_session',
  'view_read_only',
])
export const approvalDecisionSchema = z.enum([
  'accept',
  'accept_for_session',
  'decline',
  'cancel',
])
export const approvalStatusSchema = z.enum([
  'pending',
  'resolving',
  'resolved',
  'expired',
  'superseded',
])
const scopeSchema = z.object({
  tenantId: identifierSchema,
  workspaceId: identifierSchema,
  sessionId: identifierSchema,
})
export const artifactMetadataSchema = scopeSchema.extend({
  artifactId: identifierSchema,
  turnId: identifierSchema,
  itemId: identifierSchema,
  kind: z.enum(['command-output', 'git-diff']),
  byteLength: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  chunkCount: z.number().int().nonnegative(),
  finalized: z.boolean(),
  status: z.enum(['writing', 'finalized', 'recovery_required']),
  downloadUrl: z.string().min(1),
})
export const artifactDownloadTokenSchema = z.object({
  downloadUrl: z.string().min(1),
  expiresAt: z.iso.datetime(),
})
export const resyncMessageSchema = scopeSchema.extend({
  type: z.literal('resync'),
  reason: z.enum(['slow_consumer', 'queue_overflow', 'sequence_gap']),
  afterSequence: sequenceSchema,
  highWaterSequence: sequenceSchema,
  droppedEventCount: z.number().int().nonnegative(),
})

export const subscribeMessageSchema = scopeSchema.extend({
  type: z.literal('subscribe'),
  afterSequence: sequenceSchema.default(0),
})

export const replayMessageSchema = scopeSchema.extend({
  type: z.literal('replay'),
  highWaterSequence: sequenceSchema,
  events: z.array(timelineEventSchema),
})

export const subscribedMessageSchema = scopeSchema.extend({
  type: z.literal('subscribed'),
  highWaterSequence: sequenceSchema,
})

export const eventMessageSchema = scopeSchema.extend({
  type: z.literal('event'),
  event: timelineEventSchema,
})

export const ackMessageSchema = scopeSchema.extend({
  type: z.literal('ack'),
  sequence: sequenceSchema,
})

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string().min(1),
})

export const approvalSchema = z.object({
  approvalId: identifierSchema,
  tenantId: identifierSchema,
  workspaceId: identifierSchema,
  sessionId: identifierSchema,
  turnId: identifierSchema,
  itemId: identifierSchema,
  kind: z.enum(['command_execution', 'file_change']),
  status: approvalStatusSchema,
  context: z.record(z.string(), z.unknown()),
  availableDecisions: z.array(approvalDecisionSchema),
  requestedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvingUserId: z.string().nullable(),
  selectedDecision: approvalDecisionSchema.nullable(),
  version: z.number().int().positive(),
  upstreamResponseStatus: z.enum([
    'pending',
    'sent',
    'acknowledged',
    'unknown',
  ]),
})

export const approvalStateMessageSchema = z.object({
  type: z.literal('approval'),
  tenantId: identifierSchema,
  workspaceId: identifierSchema,
  sessionId: identifierSchema,
  approval: approvalSchema,
})

export const clientMessageSchema = z.discriminatedUnion('type', [
  subscribeMessageSchema,
  ackMessageSchema,
])

export const serverMessageSchema = z.discriminatedUnion('type', [
  replayMessageSchema,
  subscribedMessageSchema,
  eventMessageSchema,
  ackMessageSchema,
  errorMessageSchema,
  approvalStateMessageSchema,
  resyncMessageSchema,
])

export const replayResponseSchema = z.object({
  events: z.array(timelineEventSchema),
  highWaterSequence: sequenceSchema,
  nextAfterSequence: sequenceSchema,
  hasMore: z.boolean(),
})

export const createSessionRequestSchema = z.object({}).strict()

export const sessionResponseSchema = scopeSchema.extend({
  codexThreadId: identifierSchema.nullable(),
  status: sessionStatusSchema,
  recoveryErrorCode: recoveryErrorCodeSchema.nullable(),
  lastResumedAt: z.iso.datetime().nullable(),
  runtimeGeneration: z.number().int().nonnegative().nullable(),
  runtimeConnected: z.boolean(),
  replay: z.object({
    afterSequence: sequenceSchema,
    highWaterSequence: sequenceSchema,
  }),
  recoveryOptions: z.array(recoveryOptionSchema),
})

export const sessionSummarySchema = sessionResponseSchema
  .pick({
    tenantId: true,
    workspaceId: true,
    sessionId: true,
    codexThreadId: true,
    status: true,
  })
  .extend({
    lastSequence: sequenceSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })

export const sessionListResponseSchema = z.object({
  sessions: z.array(sessionSummarySchema),
  nextCursor: z.string().min(1).nullable(),
})

export const auditActorSchema = z.enum(['user', 'system', 'runtime'])
export const auditActionSchema = z.enum([
  'session.created',
  'session.lifecycle_changed',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'approval.requested',
  'approval.decided',
  'auth.state_changed',
  'runtime.restarted',
  'runtime.crash_loop',
  'recovery.started',
  'recovery.completed',
  'recovery.failed',
  'turn.steered',
  'turn.interrupted',
  'git.snapshot_refreshed',
  'artifact.accessed',
])
export const auditOutcomeSchema = z.enum(['requested', 'success', 'failure'])
export const auditRecordSchema = scopeSchema.extend({
  auditId: z.number().int().positive(),
  actor: auditActorSchema,
  action: auditActionSchema,
  outcome: auditOutcomeSchema,
  correlationId: z.string().min(1).nullable(),
  requestId: z.string().min(1).nullable(),
  traceId: z.string().min(1).nullable(),
  metadata: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
  occurredAt: z.iso.datetime(),
})
export const auditListResponseSchema = z.object({
  records: z.array(auditRecordSchema),
  nextCursor: z.string().min(1).nullable(),
  staleAfter: z.iso.datetime(),
})

export const metricSeriesSchema = z.object({
  name: identifierSchema,
  kind: z.enum(['counter', 'histogram', 'gauge']),
  labels: z.record(z.string(), z.string()),
  value: z.number().finite(),
  count: z.number().int().nonnegative().optional(),
  sum: z.number().finite().optional(),
  buckets: z.record(z.string(), z.number().int().nonnegative()).optional(),
})
export const metricsResponseSchema = z.object({
  generatedAt: z.iso.datetime(),
  series: z.array(metricSeriesSchema).max(500),
})

export const gitChangeSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  areas: z.array(z.enum(['staged', 'unstaged', 'untracked'])),
  stagedStatus: z.string().nullable(),
  unstagedStatus: z.string().nullable(),
  renamed: z.boolean(),
  binary: z.boolean(),
  submodule: z.boolean(),
})
export const gitLogEntrySchema = z.object({
  oid: z.string(),
  shortOid: z.string(),
  authoredAt: z.string(),
  authorName: z.string(),
  subject: z.string(),
})
export const gitSnapshotSchema = scopeSchema.extend({
  snapshotId: identifierSchema,
  turnId: identifierSchema.nullable(),
  phase: z.enum(['before', 'after', 'refresh']),
  repositoryKind: z.enum(['repository', 'worktree', 'submodule', 'none']),
  branch: z.string().nullable(),
  headOid: z.string().nullable(),
  detached: z.boolean(),
  clean: z.boolean(),
  changes: z.array(gitChangeSchema),
  diff: z.object({
    preview: z.string(),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean(),
    artifactId: identifierSchema.nullable(),
  }),
  log: z.array(gitLogEntrySchema),
  eventChangeCount: z.number().int().nonnegative(),
  relationship: z.enum([
    'authoritative',
    'matches_events',
    'differs_from_events',
  ]),
  capturedAt: z.iso.datetime(),
  stale: z.boolean(),
})
export const gitSnapshotListResponseSchema = z.object({
  snapshots: z.array(gitSnapshotSchema),
})

export const createTurnRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
})
export const steerTurnRequestSchema = z.object({
  expectedTurnId: identifierSchema,
  prompt: z.string().trim().min(1).max(100_000),
})
export const interruptTurnRequestSchema = z.object({}).strict()

export const turnActionResponseSchema = scopeSchema.extend({
  codexThreadId: identifierSchema,
  codexTurnId: identifierSchema,
  status: z.enum(['accepted', 'interrupted']),
})

export const turnAcceptedResponseSchema = scopeSchema.extend({
  codexThreadId: identifierSchema,
  codexTurnId: identifierSchema,
  idempotencyKey: identifierSchema,
})

export const approvalListResponseSchema = z.object({
  approvals: z.array(approvalSchema),
})
export const approvalDecisionRequestSchema = z.object({
  decision: approvalDecisionSchema,
  expectedVersion: z.number().int().positive(),
  clientContext: z
    .object({
      deviceId: z.string().min(1).optional(),
      reason: z.string().nullable(),
    })
    .optional(),
})

export const apiErrorResponseSchema = z.object({
  code: identifierSchema,
  message: identifierSchema,
  issues: z.array(z.string()).optional(),
})

export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>
export type ReplayMessage = z.infer<typeof replayMessageSchema>
export type SubscribedMessage = z.infer<typeof subscribedMessageSchema>
export type EventMessage = z.infer<typeof eventMessageSchema>
export type AckMessage = z.infer<typeof ackMessageSchema>
export type ErrorMessage = z.infer<typeof errorMessageSchema>
export type ClientMessage = z.infer<typeof clientMessageSchema>
export type ServerMessage = z.infer<typeof serverMessageSchema>
export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>
export type ArtifactDownloadToken = z.infer<typeof artifactDownloadTokenSchema>
export type ReplayResponse = z.infer<typeof replayResponseSchema>
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>
export type SessionResponse = z.infer<typeof sessionResponseSchema>
export type SessionSummary = z.infer<typeof sessionSummarySchema>
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>
export type GitSnapshot = z.infer<typeof gitSnapshotSchema>
export type GitSnapshotListResponse = z.infer<
  typeof gitSnapshotListResponseSchema
>
export type CreateTurnRequest = z.infer<typeof createTurnRequestSchema>
export type TurnAcceptedResponse = z.infer<typeof turnAcceptedResponseSchema>
export type SteerTurnRequest = z.infer<typeof steerTurnRequestSchema>
export type TurnActionResponse = z.infer<typeof turnActionResponseSchema>
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>
export type Approval = z.infer<typeof approvalSchema>
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>
export type ApprovalDecisionRequest = z.infer<
  typeof approvalDecisionRequestSchema
>
export type ReadinessStatus = z.infer<typeof readinessStatusSchema>
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>
export type AuditRecord = z.infer<typeof auditRecordSchema>
export type AuditListResponse = z.infer<typeof auditListResponseSchema>
export type MetricsResponse = z.infer<typeof metricsResponseSchema>
