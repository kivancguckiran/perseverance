import { timelineEventSchema } from '@persistent-codex/domain-events'
import {
  capabilityMatrixSchema,
  modelSelectionSchema,
  providerModelCatalogSchema,
  providerIdSchema,
  reasoningEffortSchema,
  turnOutcomeSchema,
  usageCountersSchema,
} from '@persistent-codex/provider-platform'
import { z } from 'zod'

const identifierSchema = z.string().min(1)
const sequenceSchema = z.number().int().nonnegative()
export const organizationRoleSchema = z.enum([
  'owner',
  'admin',
  'developer',
  'viewer',
  'billing',
  'support',
  'operator',
  'security_approver',
  'kms_operator',
])
export const organizationMembershipSchema = z.object({
  version: z.literal(1),
  subject: identifierSchema,
  issuer: identifierSchema,
  organizationId: identifierSchema,
  role: organizationRoleSchema,
  status: z.enum(['active', 'disabled', 'revoked']),
  workspaceIds: z.array(identifierSchema).max(1_000),
  updatedAt: z.iso.datetime(),
})
export const organizationSchema = z.object({
  version: z.literal(1),
  organizationId: identifierSchema,
  name: z.string().trim().min(1).max(120),
  status: z.enum(['active', 'disabled']),
  createdAt: z.iso.datetime(),
})
export const principalIdentitySchema = z.object({
  version: z.literal(1),
  subject: identifierSchema,
  issuer: identifierSchema,
  status: z.enum(['active', 'disabled']),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
})
export const authPrincipalSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['end_user', 'internal_service']),
  subject: identifierSchema,
  issuer: identifierSchema,
  audience: z.array(identifierSchema).min(1).max(16),
  authenticatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  assurance: z.object({
    level: z.string().min(1).max(128),
    mfa: z.boolean(),
  }),
  memberships: z.array(organizationMembershipSchema).max(1_000),
})
export const meResponseSchema = authPrincipalSchema
  .omit({ memberships: true })
  .extend({
    memberships: z.array(organizationMembershipSchema),
    activeOrganizationId: identifierSchema,
    activeWorkspaceId: identifierSchema,
  })
export const authorizationActionSchema = z.enum([
  'session.read',
  'session.create',
  'session.update',
  'turn.start',
  'turn.interrupt',
  'turn.steer',
  'event.replay',
  'event.subscribe',
  'approval.read',
  'approval.decide',
  'attachment.upload',
  'attachment.read',
  'attachment.delete',
  'artifact.metadata.read',
  'artifact.read',
  'artifact.download',
  'workspace.snapshot.read',
  'usage.read',
  'usage.reconcile',
  'audit.read',
  'metrics.read',
  'folder.read',
  'folder.manage',
  'provider.catalog.read',
  'provider.readiness.read',
  'support.grant.create',
  'support.grant.read',
  'support.grant.revoke',
  'support.grant.approve',
  'support.access.use',
  'break_glass.request',
  'break_glass.approve',
])
export const authorizationDecisionSchema = z.object({
  version: z.literal(1),
  allow: z.boolean(),
  reasonCode: z.enum([
    'ROLE_ALLOWED',
    'ROLE_DENIED',
    'UNKNOWN_ACTION',
    'RESOURCE_SCOPE_MISSING',
    'PRINCIPAL_KIND_MISMATCH',
    'MEMBERSHIP_INACTIVE',
    'WORKSPACE_MEMBERSHIP_MISSING',
  ]),
})
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
    'runtimeIsolation',
    'kms',
    'encryption',
  ]),
  status: z.enum(['ready', 'failed']),
  code: z.string().min(1).nullable(),
})
export const readinessResponseSchema = z.object({
  status: readinessStatusSchema,
  checkedAt: z.iso.datetime(),
  checks: z.array(readinessCheckSchema),
  security: z
    .object({
      runtimeBackend: z.enum(['local-process', 'kata-kubernetes']),
      isolationLevel: z.enum(['development_only', 'container', 'microvm']),
      encryptedVolume: z.boolean(),
      egressDefaultDeny: z.boolean(),
      secretProvider: z.string().min(1),
      secretProviderProduction: z.boolean(),
      kmsProvider: z.string().min(1),
      kmsProviderProduction: z.boolean(),
      encryptionFormatVersion: z.number().int().positive(),
      chunkedEncryptionFormatVersion: z.number().int().positive(),
    })
    .optional(),
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
export const durableRunStatusSchema = z.enum([
  'queued',
  'running',
  'interrupting',
  'completed',
  'failed',
  'interrupted',
  'recovery_required',
])
export const durableRunSchema = scopeSchema.extend({
  runId: identifierSchema,
  turnId: identifierSchema.nullable(),
  providerTurnId: identifierSchema.nullable(),
  provider: providerIdSchema,
  status: durableRunStatusSchema,
  attempt: z.number().int().positive(),
  runtimeGeneration: z.number().int().nonnegative().nullable(),
  terminalOutcome: turnOutcomeSchema.exclude(['in_progress']).nullable(),
  recoveryCode: z.string().min(1).nullable(),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  interruptRequestedAt: z.iso.datetime().nullable(),
  terminalAt: z.iso.datetime().nullable(),
  lastReconciledAt: z.iso.datetime().nullable(),
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
  accessToken: z.string().min(1).max(16_384).optional(),
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

export const conversationTitleSchema = z.string().trim().min(1).max(120)
export const folderNameSchema = z.string().trim().min(1).max(80)

export const createSessionRequestSchema = z
  .object({
    folderId: identifierSchema.nullable().optional(),
    title: conversationTitleSchema.optional(),
    provider: providerIdSchema.optional().default('codex'),
    model: modelSelectionSchema.optional(),
  })
  .strict()

export const sessionResponseSchema = scopeSchema.extend({
  folderId: identifierSchema.nullable(),
  title: conversationTitleSchema,
  provider: providerIdSchema,
  requestedPolicy: modelSelectionSchema,
  resolvedModel: identifierSchema.nullable(),
  reasoningEffort: reasoningEffortSchema.nullable(),
  capabilitySnapshot: capabilityMatrixSchema.nullable(),
  codexThreadId: identifierSchema.nullable(),
  status: sessionStatusSchema,
  recoveryErrorCode: recoveryErrorCodeSchema.nullable(),
  lastResumedAt: z.iso.datetime().nullable(),
  runtimeGeneration: z.number().int().nonnegative().nullable(),
  runtimeConnected: z.boolean(),
  activeRun: durableRunSchema.nullable().default(null),
  latestRun: durableRunSchema.nullable().default(null),
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
    folderId: true,
    title: true,
    provider: true,
    requestedPolicy: true,
    resolvedModel: true,
    reasoningEffort: true,
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

export const providerCatalogListResponseSchema = z.object({
  catalogs: z.array(providerModelCatalogSchema),
  readiness: z.partialRecord(
    providerIdSchema,
    z.object({
      ready: z.boolean(),
      version: z.string().nullable(),
      authReady: z.boolean().nullable(),
      authStatus: z.enum(['ready', 'required', 'unknown']),
      code: z.enum([
        'ready',
        'binary_missing',
        'binary_not_executable',
        'version_unparseable',
        'version_mismatch',
        'auth_required',
        'auth_unknown',
      ]),
      instruction: z.string().nullable(),
    }),
  ),
})

export const conversationFolderSchema = scopeSchema
  .omit({ sessionId: true })
  .extend({
    folderId: identifierSchema,
    name: folderNameSchema,
    archivedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })

export const createConversationFolderRequestSchema = z
  .object({ name: folderNameSchema })
  .strict()
export const conversationFolderListResponseSchema = z.object({
  folders: z.array(conversationFolderSchema),
})
export const updateConversationFolderRequestSchema = z
  .object({ archived: z.boolean() })
  .strict()
export const updateConversationRequestSchema = z
  .object({
    folderId: identifierSchema.nullable().optional(),
    title: conversationTitleSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.folderId !== undefined || value.title !== undefined,
    {
      message: 'folderId or title is required',
    },
  )

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
  'authorization.decided',
])
export const auditOutcomeSchema = z.enum(['requested', 'success', 'failure'])
export const auditRecordSchema = scopeSchema.extend({
  auditId: z.number().int().positive(),
  actor: auditActorSchema,
  actorPrincipalId: z.string().min(1).nullable(),
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

export const attachmentMediaTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/pdf',
])
export const attachmentContextStart = '<persistent-codex-attachments>'
export const attachmentContextEnd = '</persistent-codex-attachments>'
export const conversationAttachmentSchema = scopeSchema.extend({
  attachmentId: identifierSchema,
  name: z.string().trim().min(1).max(255),
  mediaType: attachmentMediaTypeSchema,
  byteLength: z.number().int().positive(),
  kind: z.enum(['image', 'file']),
  createdAt: z.iso.datetime(),
})
export const createTurnRequestSchema = z
  .object({
    prompt: z.string().trim().max(100_000),
    attachmentIds: z.array(identifierSchema).default([]),
  })
  .refine(
    (value) => value.prompt.length > 0 || value.attachmentIds.length > 0,
    { message: 'prompt or attachment is required' },
  )
export const steerTurnRequestSchema = z.object({
  expectedTurnId: identifierSchema,
  prompt: z.string().trim().min(1).max(100_000),
})
export const interruptTurnRequestSchema = z.object({}).strict()

export const turnActionResponseSchema = scopeSchema.extend({
  runId: identifierSchema.optional(),
  codexThreadId: identifierSchema,
  codexTurnId: identifierSchema,
  status: z.enum(['accepted', 'interrupted']),
})

export const turnAcceptedResponseSchema = scopeSchema.extend({
  runId: identifierSchema,
  codexThreadId: identifierSchema,
  codexTurnId: identifierSchema,
  idempotencyKey: identifierSchema,
})

export const usageCostSummarySchema = scopeSchema.extend({
  turnId: identifierSchema.nullable(),
  counters: usageCountersSchema,
  outcome: turnOutcomeSchema.exclude(['in_progress']).nullable(),
  completeness: z.enum(['complete', 'partial']),
  reconciliationStatus: z.enum(['unreconciled', 'reconciled']),
  estimatedCostMicros: z.number().int().nonnegative().nullable(),
  officialCostMicros: z.number().int().nonnegative().nullable(),
  currency: z.literal('USD'),
  priceCatalogVersions: z.array(identifierSchema),
})

export const usageCostItemSchema = usageCostSummarySchema.extend({
  turnId: identifierSchema,
  provider: z.enum(['codex', 'claude', 'gemini']),
  modelId: identifierSchema,
  purpose: z.enum(['conversation_turn', 'conversation_title']),
  occurredAt: z.iso.datetime(),
})

export const conversationUsageCostSchema = z.object({
  total: usageCostSummarySchema,
  items: z.array(usageCostItemSchema),
})

export const usageReconciliationResponseSchema = z.object({
  status: z.enum(['reconciled', 'unavailable', 'unsupported']),
  provider: z.enum(['codex', 'claude', 'gemini']).nullable(),
  reconciledItems: z.number().int().nonnegative(),
  message: z.string().min(1),
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

export const supportGrantStatusSchema = z.enum([
  'pending_verification',
  'pending_approval',
  'active',
  'revoked',
  'expired',
  'denied',
])
export const supportAccessActionSchema = z.enum([
  'content.view',
  'artifact.download',
  'attachment.download',
  'content.decrypt',
])
export const supportGrantSchema = z.object({
  schemaVersion: z.literal(1),
  grantId: identifierSchema,
  tenantId: identifierSchema,
  organizationId: identifierSchema,
  workspaceId: identifierSchema,
  sessionId: identifierSchema.nullable(),
  artifactId: identifierSchema.nullable(),
  attachmentId: identifierSchema.nullable(),
  actions: z.array(supportAccessActionSchema).min(1).max(4),
  reason: z.string().trim().min(8).max(500),
  requesterPrincipalId: identifierSchema,
  supportPrincipalId: identifierSchema,
  mfaEvidenceId: identifierSchema.nullable(),
  requiredApprovals: z.number().int().min(1).max(2),
  approvalPrincipalIds: z.array(identifierSchema).max(2),
  status: supportGrantStatusSchema,
  issuedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  idempotencyKey: identifierSchema,
})
export const createSupportGrantRequestSchema = z
  .object({
    sessionId: identifierSchema.nullable().optional(),
    artifactId: identifierSchema.nullable().optional(),
    attachmentId: identifierSchema.nullable().optional(),
    actions: z.array(supportAccessActionSchema).min(1).max(4),
    reason: z.string().trim().min(8).max(500),
    supportPrincipalId: identifierSchema,
    durationMinutes: z.number().int().min(5).max(60),
  })
  .strict()
export const supportGrantListResponseSchema = z.object({
  grants: z.array(supportGrantSchema),
})
export const securityAuditRecordSchema = z.object({
  sequence: z.number().int().positive(),
  tenantId: identifierSchema,
  organizationId: identifierSchema,
  workspaceId: identifierSchema,
  actorPrincipalId: identifierSchema,
  scope: z.string().min(1),
  action: identifierSchema,
  outcome: z.enum(['requested', 'success', 'failure']),
  reason: identifierSchema,
  grantId: identifierSchema.nullable(),
  breakGlassId: identifierSchema.nullable(),
  occurredAt: z.iso.datetime(),
  correlationId: identifierSchema,
  previousHash: z.string().regex(/^(GENESIS|[a-f0-9]{64})$/),
  recordHash: z.string().regex(/^[a-f0-9]{64}$/),
})
export const securityAuditListResponseSchema = z.object({
  records: z.array(securityAuditRecordSchema),
  chainValid: z.boolean(),
})
export const supportGrantDecisionRequestSchema = z
  .object({
    decision: z.enum(['approve', 'deny']),
    expectedVersion: z.number().int().positive(),
    mfaEvidenceId: identifierSchema,
  })
  .strict()
export const supportGrantRevokeRequestSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict()

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
export type DurableRun = z.infer<typeof durableRunSchema>
export type SessionSummary = z.infer<typeof sessionSummarySchema>
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>
export type ProviderCatalogListResponse = z.infer<
  typeof providerCatalogListResponseSchema
>
export type ConversationFolder = z.infer<typeof conversationFolderSchema>
export type ConversationFolderListResponse = z.infer<
  typeof conversationFolderListResponseSchema
>
export type CreateConversationFolderRequest = z.infer<
  typeof createConversationFolderRequestSchema
>
export type UpdateConversationFolderRequest = z.infer<
  typeof updateConversationFolderRequestSchema
>
export type UpdateConversationRequest = z.infer<
  typeof updateConversationRequestSchema
>
export type GitSnapshot = z.infer<typeof gitSnapshotSchema>
export type GitSnapshotListResponse = z.infer<
  typeof gitSnapshotListResponseSchema
>
export type CreateTurnRequest = z.infer<typeof createTurnRequestSchema>
export type ConversationAttachment = z.infer<
  typeof conversationAttachmentSchema
>
export type TurnAcceptedResponse = z.infer<typeof turnAcceptedResponseSchema>
export type SteerTurnRequest = z.infer<typeof steerTurnRequestSchema>
export type TurnActionResponse = z.infer<typeof turnActionResponseSchema>
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>
export type OrganizationRole = z.infer<typeof organizationRoleSchema>
export type OrganizationMembership = z.infer<
  typeof organizationMembershipSchema
>
export type Organization = z.infer<typeof organizationSchema>
export type PrincipalIdentity = z.infer<typeof principalIdentitySchema>
export type AuthPrincipal = z.infer<typeof authPrincipalSchema>
export type MeResponse = z.infer<typeof meResponseSchema>
export type AuthorizationAction = z.infer<typeof authorizationActionSchema>
export type AuthorizationDecision = z.infer<typeof authorizationDecisionSchema>
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
export type UsageCostSummary = z.infer<typeof usageCostSummarySchema>
export type UsageCostItem = z.infer<typeof usageCostItemSchema>
export type ConversationUsageCost = z.infer<typeof conversationUsageCostSchema>
export type UsageReconciliationResponse = z.infer<
  typeof usageReconciliationResponseSchema
>
export type SupportGrant = z.infer<typeof supportGrantSchema>
export type SupportGrantStatus = z.infer<typeof supportGrantStatusSchema>
export type SupportAccessAction = z.infer<typeof supportAccessActionSchema>
export type CreateSupportGrantRequest = z.infer<
  typeof createSupportGrantRequestSchema
>
export type SupportGrantDecisionRequest = z.infer<
  typeof supportGrantDecisionRequestSchema
>
export type SecurityAuditRecord = z.infer<typeof securityAuditRecordSchema>
