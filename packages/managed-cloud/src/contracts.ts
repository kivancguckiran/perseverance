import { z } from 'zod'
import { capacityVectorSchema } from '@perseverance/production-topology/contracts'
import { providerAuthModeSchema } from '@perseverance/provider-auth'
import { providerIdSchema } from '@perseverance/provider-platform'

export const MANAGED_CLOUD_CONTRACT_VERSION = 1 as const
const id = z.string().trim().min(1).max(255)
const at = z.iso.datetime()

export const managedCloudScopeSchema = z
  .object({
    tenantId: id,
    organizationId: id,
    workspaceId: id,
  })
  .refine((value) => value.tenantId === value.organizationId, {
    message: 'tenantId must equal organizationId',
  })
export type ManagedCloudScope = z.infer<typeof managedCloudScopeSchema>

export const managedCloudPlanSchema = z.object({
  schemaVersion: z.literal(MANAGED_CLOUD_CONTRACT_VERSION),
  planId: id,
  planVersion: z.number().int().positive(),
  displayName: id,
  currency: z.string().regex(/^[A-Z]{3}$/),
  entitlements: z.array(
    z.enum([
      'cloud.managed-tenant-provisioning',
      'cloud.tenant-runtime-isolation',
      'cloud.tenant-capacity-budgets',
      'cloud.runtime-data-plane-credentials',
      'core.provider-adapters',
      'core.detached-runs',
    ]),
  ),
  computeQuota: capacityVectorSchema,
  storageQuotaBytes: z.number().int().positive(),
  monthlyBudgetMicros: z.number().int().positive(),
})
export type ManagedCloudPlan = z.infer<typeof managedCloudPlanSchema>

export const onboardingStateSchema = z.enum([
  'signed_up',
  'tenant_ready',
  'provider_connected',
  'first_task_started',
  'completed',
])
export type OnboardingState = z.infer<typeof onboardingStateSchema>

export const onboardingRecordSchema = managedCloudScopeSchema.extend({
  schemaVersion: z.literal(MANAGED_CLOUD_CONTRACT_VERSION),
  onboardingId: id,
  accountId: id,
  emailDigest: z.string().regex(/^[a-f0-9]{64}$/),
  state: onboardingStateSchema,
  planId: id,
  planVersion: z.number().int().positive(),
  providerProfileId: id.nullable(),
  firstTaskId: id.nullable(),
  idempotencyKey: id,
  version: z.number().int().positive(),
})
export type OnboardingRecord = z.infer<typeof onboardingRecordSchema>

export const managedCloudOnboardingRequestSchema = z
  .object({
    displayName: id,
    workspaceName: id,
    regionId: id,
    retentionDays: z.number().int().min(1).max(3650).default(90),
    domain: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/)
      .nullable()
      .default(null),
    planId: id,
    planVersion: z.number().int().positive(),
    provider: providerIdSchema,
    authMode: providerAuthModeSchema,
    accessToken: z.string().min(8),
    firstTaskPrompt: z.string().trim().min(1).max(20_000),
    idempotencyKey: id,
  })
  .strict()
export type ManagedCloudOnboardingRequest = z.input<
  typeof managedCloudOnboardingRequestSchema
>

export const usageCategorySchema = z.enum([
  'hosting',
  'compute',
  'storage',
  'model',
])
export const managedUsageEntrySchema = managedCloudScopeSchema.extend({
  schemaVersion: z.literal(MANAGED_CLOUD_CONTRACT_VERSION),
  usageId: id,
  taskId: id.nullable(),
  category: usageCategorySchema,
  quantity: z.number().int().nonnegative(),
  unit: id,
  amountMicros: z.number().int().nonnegative().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  estimated: z.boolean(),
  billable: z.boolean(),
  status: z.enum(['measured', 'estimated', 'reconciled', 'incomplete']),
  outcome: z.enum(['running', 'completed', 'failed', 'interrupted']),
  dedupeKey: id,
})
export type ManagedUsageEntry = z.infer<typeof managedUsageEntrySchema>

export const domainVerificationSchema = managedCloudScopeSchema.extend({
  schemaVersion: z.literal(MANAGED_CLOUD_CONTRACT_VERSION),
  domain: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/),
  challengeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['pending', 'verified', 'failed', 'revoked']),
  httpsState: z.enum(['pending', 'active', 'failed', 'revoked']),
  version: z.number().int().positive(),
})
export type DomainVerification = z.infer<typeof domainVerificationSchema>

export const notificationPreferenceSchema = managedCloudScopeSchema.extend({
  schemaVersion: z.literal(MANAGED_CLOUD_CONTRACT_VERSION),
  emailEnabled: z.boolean(),
  pushEnabled: z.boolean(),
  taskCompleted: z.boolean(),
  approvalRequired: z.boolean(),
})
export type NotificationPreference = z.infer<
  typeof notificationPreferenceSchema
>

export const onboardingInputSchema = managedCloudOnboardingRequestSchema.extend(
  {
    principal: z.object({
      issuer: id,
      subject: id,
    }),
  },
)
export type OnboardingInput = z.input<typeof onboardingInputSchema>
