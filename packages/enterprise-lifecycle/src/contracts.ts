import { z } from 'zod'

export const ENTERPRISE_LIFECYCLE_VERSION = 1 as const
const id = z.string().trim().min(1).max(255)
const at = z.iso.datetime()
export const tenantScopeSchema = z.object({ tenantId: id, organizationId: id })

export const federationConfigurationSchema = tenantScopeSchema.extend({
  schemaVersion: z.literal(1),
  configurationId: id,
  protocol: z.enum(['oidc', 'saml']),
  issuer: z.url(),
  entityId: id.nullable(),
  audience: id,
  callbackUrl: z.url(),
  acsUrl: z.url().nullable(),
  keyId: id,
  verificationKeyPem: z.string().min(64),
  clockSkewSeconds: z.number().int().min(0).max(300),
  enforcedSso: z.boolean(),
  requiredMfa: z.boolean(),
  allowedAmr: z.array(id).min(1),
  metadataVersion: z.number().int().positive(),
  enabled: z.boolean(),
  updatedAt: at,
})

export const domainChallengeSchema = tenantScopeSchema.extend({
  schemaVersion: z.literal(1),
  challengeId: id,
  domain: z.string().regex(/^[a-z0-9.-]+$/),
  tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['pending', 'verified', 'expired']),
  expiresAt: at,
  verifiedAt: at.nullable(),
  version: z.number().int().positive(),
})

export const scimResourceSchema = tenantScopeSchema.extend({
  schemaVersion: z.literal(1),
  resourceType: z.enum(['User', 'Group']),
  resourceId: id,
  externalId: id,
  providerId: id,
  providerVersion: z.number().int().nonnegative(),
  active: z.boolean(),
  displayName: id,
  members: z.array(id).max(10_000),
  version: z.number().int().positive(),
  updatedAt: at,
})

export const retentionClassSchema = z.enum([
  'event',
  'raw_envelope',
  'audit',
  'source',
  'attachment',
  'artifact',
  'derived_index',
  'usage_billing',
  'backup',
])
export const retentionPolicySchema = tenantScopeSchema.extend({
  schemaVersion: z.literal(1),
  policyId: id,
  policyVersion: z.number().int().positive(),
  planId: id,
  effectiveAt: at,
  previousPolicyVersion: z.number().int().positive().nullable(),
  minimumPolicyAgeDays: z.number().int().nonnegative(),
  classes: z.record(retentionClassSchema, z.number().int().positive()),
})
export const legalHoldSchema = tenantScopeSchema.extend({
  schemaVersion: z.literal(1),
  holdId: id,
  objectClasses: z.array(retentionClassSchema).min(1),
  reasonCode: id,
  actorRole: z.enum(['tenant_compliance_admin', 'legal_officer']),
  state: z.enum(['active', 'released', 'expired']),
  startsAt: at,
  expiresAt: at,
  version: z.number().int().positive(),
})

export const exportManifestSchema = tenantScopeSchema.extend({
  schemaVersion: z.literal(1),
  jobId: id,
  workspaceIds: z.array(id),
  watermark: id,
  objects: z.array(
    z.object({
      objectId: id,
      objectClass: retentionClassSchema,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      byteLength: z.number().int().nonnegative(),
      keyVersion: z.number().int().positive(),
    }),
  ),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  archiveByteLength: z.number().int().positive(),
  keyVersion: z.number().int().positive(),
  createdAt: at,
})
export const exportJobSchema = tenantScopeSchema.extend({
  schemaVersion: z.literal(1),
  jobId: id,
  state: z.enum([
    'requested',
    'approved',
    'collecting',
    'encrypting',
    'ready',
    'expired',
    'failed',
  ]),
  privilege: z.enum(['tenant_export_admin', 'dsar_officer']),
  approvalId: id,
  idempotencyKey: id,
  checkpoint: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  expiresAt: at.nullable(),
})

export const deletionStepSchema = z.enum([
  'access_revoke',
  'admission_cordon',
  'active_job_drain',
  'session_token_revoke',
  'cache_purge',
  'index_purge',
  'object_delete',
  'metadata_cleanup',
  'backup_expiry',
  'kms_crypto_erasure',
  'deletion_receipt',
])
export const deletionJobSchema = tenantScopeSchema.extend({
  schemaVersion: z.literal(1),
  jobId: id,
  state: z.enum([
    'requested',
    'running',
    'blocked_by_hold',
    'waiting_retention',
    'complete',
    'failed',
  ]),
  currentStep: deletionStepSchema,
  completedSteps: z.array(deletionStepSchema),
  remainingClasses: z.array(
    z.object({
      objectClass: retentionClassSchema,
      reasonCode: id,
      expiresAt: at,
    }),
  ),
  idempotencyKey: id,
  version: z.number().int().positive(),
  keyVersion: z.number().int().positive(),
})

export const residencyPolicySchema = tenantScopeSchema.extend({
  schemaVersion: z.literal(1),
  policyId: id,
  policyVersion: z.number().int().positive(),
  allowedRegions: z.array(id).min(1),
  primaryRegion: id,
  crossRegionTransfers: z.array(
    z.object({
      sourceRegion: id,
      destinationRegion: id,
      objectClasses: z.array(retentionClassSchema),
    }),
  ),
  effectiveAt: at,
})
export const transferAuditSchema = tenantScopeSchema.extend({
  schemaVersion: z.literal(1),
  transferId: id,
  sourceRegion: id,
  destinationRegion: id,
  reasonCode: id,
  actorId: id,
  objectClass: retentionClassSchema,
  byteCount: z.number().int().nonnegative(),
  approvalId: id,
  occurredAt: at,
})

export type FederationConfiguration = z.infer<
  typeof federationConfigurationSchema
>
export type ScimResource = z.infer<typeof scimResourceSchema>
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>
export type LegalHold = z.infer<typeof legalHoldSchema>
export type ExportManifest = z.infer<typeof exportManifestSchema>
export type ExportJob = z.infer<typeof exportJobSchema>
export type DeletionJob = z.infer<typeof deletionJobSchema>
export type ResidencyPolicy = z.infer<typeof residencyPolicySchema>
export type RetentionClass = z.infer<typeof retentionClassSchema>
export type TransferAudit = z.infer<typeof transferAuditSchema>
