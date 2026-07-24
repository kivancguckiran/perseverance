import { z } from 'zod'
import { capacityVectorSchema } from '@persistent-codex/production-topology/contracts'

// WP33 — tenant-isolated managed runtime contract'ları (ADR-0033).
// Tenant kimliği repo değişmezine sadıktır: tenant_id = organization_id
// (migration 0023 CHECK'i); bu paket o değişmezi gevşetmez.

export const TENANT_RUNTIME_CONTRACT_VERSION = 1 as const

const id = z.string().trim().min(1).max(255)
const at = z.iso.datetime()

export const tenantRuntimeScopeSchema = z.object({
  tenantId: id,
  organizationId: id,
})
export type TenantRuntimeScope = z.infer<typeof tenantRuntimeScopeSchema>

export const managedTenantStateSchema = z.enum([
  'provisioning',
  'active',
  'suspended',
  'deleting',
  'deleted',
])
export type ManagedTenantState = z.infer<typeof managedTenantStateSchema>

export const managedTenantDesiredStateSchema = z.enum([
  'active',
  'suspended',
  'deleted',
])
export type ManagedTenantDesiredState = z.infer<
  typeof managedTenantDesiredStateSchema
>

// Tenant bazlı domain, region, retention ve kapasite metadata'sı.
export const managedTenantSchema = tenantRuntimeScopeSchema.extend({
  schemaVersion: z.literal(TENANT_RUNTIME_CONTRACT_VERSION),
  displayName: id,
  state: managedTenantStateSchema,
  desiredState: managedTenantDesiredStateSchema,
  domain: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/)
    .nullable(),
  regionId: id,
  retentionPolicyId: id.nullable(),
  retentionDays: z.number().int().min(1).max(3650),
  capacity: capacityVectorSchema,
  version: z.number().int().positive(),
})
export type ManagedTenant = z.infer<typeof managedTenantSchema>

// Belgelenmiş tenant kapasite/SLO bütçesi (noisy-neighbor sınırının kaynağı).
export const tenantCapacityBudgetSchema = tenantRuntimeScopeSchema.extend({
  schemaVersion: z.literal(TENANT_RUNTIME_CONTRACT_VERSION),
  reservedCapacity: capacityVectorSchema,
  queueLatencyBudgetMs: z.number().int().positive(),
  maxStarvationPosition: z.number().int().positive(),
  version: z.number().int().positive(),
})
export type TenantCapacityBudget = z.infer<typeof tenantCapacityBudgetSchema>

export const tenantRuntimeStateSchema = z.enum([
  'requested',
  'provisioning',
  'ready',
  'suspended',
  'deleting',
  'deleted',
])
export type TenantRuntimeState = z.infer<typeof tenantRuntimeStateSchema>

// Tenant'a özel runtime kaynak seti: identity, volume, key, secret namespace,
// network policy, placement ve capacity reservation (ADR-0017 + ADR-0026).
export const tenantRuntimeSchema = tenantRuntimeScopeSchema.extend({
  schemaVersion: z.literal(TENANT_RUNTIME_CONTRACT_VERSION),
  workspaceId: id,
  runtimeId: id,
  generation: z.number().int().positive(),
  state: tenantRuntimeStateSchema,
  identitySubject: id.nullable(),
  volumeId: id.nullable(),
  volumeEncrypted: z.boolean(),
  kmsProvider: id.nullable(),
  kmsKeyId: id.nullable(),
  kmsKeyVersion: z.number().int().positive().nullable(),
  secretNamespace: id.nullable(),
  networkPolicyId: id.nullable(),
  regionId: id,
  nodeId: id.nullable(),
  capacityReservationId: id.nullable(),
  version: z.number().int().positive(),
})
export type TenantRuntime = z.infer<typeof tenantRuntimeSchema>

export const PROVISION_STEPS = [
  'runtime_identity',
  'encryption_key',
  'filesystem_volume',
  'secret_namespace',
  'network_policy',
  'placement',
  'capacity_reservation',
  'runtime_ready',
] as const
export type ProvisionStep = (typeof PROVISION_STEPS)[number]

export const SUSPEND_STEPS = [
  'runtime_drain',
  'capacity_release',
  'runtime_stop',
] as const
export type SuspendStep = (typeof SUSPEND_STEPS)[number]

export const DELETE_STEPS = [
  'runtime_drain',
  'capacity_release',
  'runtime_destroy',
  'secret_namespace_purge',
  'network_policy_remove',
  'volume_release',
  'key_crypto_erase',
  'metadata_cleanup',
  'deletion_receipt',
] as const
export type DeleteStep = (typeof DELETE_STEPS)[number]

export const provisioningJobKindSchema = z.enum([
  'provision',
  'suspend',
  'resume',
  'delete',
])
export type ProvisioningJobKind = z.infer<typeof provisioningJobKindSchema>

export const provisioningJobStateSchema = z.enum([
  'requested',
  'running',
  'completed',
  'failed',
])
export type ProvisioningJobState = z.infer<typeof provisioningJobStateSchema>

export const provisioningJobSchema = tenantRuntimeScopeSchema.extend({
  schemaVersion: z.literal(TENANT_RUNTIME_CONTRACT_VERSION),
  jobId: id,
  kind: provisioningJobKindSchema,
  workspaceId: id,
  runtimeId: id,
  state: provisioningJobStateSchema,
  currentStep: id.nullable(),
  completedSteps: z.array(id).max(32),
  idempotencyKey: id,
  attempt: z.number().int().nonnegative(),
  lastErrorCode: id.nullable(),
  version: z.number().int().positive(),
})
export type ProvisioningJob = z.infer<typeof provisioningJobSchema>

export const orphanReasonSchema = z.enum([
  'missing-durable-record',
  'stale-generation',
])
export type OrphanReason = z.infer<typeof orphanReasonSchema>

export const orphanRuntimeSchema = z.object({
  schemaVersion: z.literal(TENANT_RUNTIME_CONTRACT_VERSION),
  observedRuntimeId: id,
  reason: orphanReasonSchema,
  state: z.enum(['detected', 'cleaned']),
})
export type OrphanRuntime = z.infer<typeof orphanRuntimeSchema>

// Control plane ↔ runtime data plane internal auth contract'ı.
export const RUNTIME_DATA_PLANE_AUDIENCE =
  'urn:persistent-codex:runtime-data-plane' as const

export const RUNTIME_DATA_PLANE_ACTIONS = [
  'event.append',
  'artifact.write',
  'run.checkpoint',
  'secret.lease',
  'replay.read',
] as const
export type RuntimeDataPlaneAction = (typeof RUNTIME_DATA_PLANE_ACTIONS)[number]

export const runtimeCredentialClaimsSchema = z.object({
  version: z.literal(TENANT_RUNTIME_CONTRACT_VERSION),
  credentialId: id,
  subject: id,
  audience: z.literal(RUNTIME_DATA_PLANE_AUDIENCE),
  tenantId: id,
  organizationId: id,
  workspaceId: id,
  runtimeId: id,
  generation: z.number().int().positive(),
  actions: z.array(z.enum(RUNTIME_DATA_PLANE_ACTIONS)).min(1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
})
export type RuntimeCredentialClaims = z.infer<
  typeof runtimeCredentialClaimsSchema
>

export const issuedRuntimeCredentialSchema = z.object({
  credentialId: id,
  accessToken: z.string().min(1),
  tokenDigest: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: at,
})
export type IssuedRuntimeCredential = z.infer<
  typeof issuedRuntimeCredentialSchema
>
