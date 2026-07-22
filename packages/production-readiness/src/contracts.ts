import { z } from 'zod'

export const PRODUCTION_READINESS_CONTRACT_VERSION = 1 as const

const identifier = z.string().trim().min(1).max(160)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const sourceCommit = z.string().regex(/^[a-f0-9]{40,64}$/)

export const productionRolloutStageSchema = z.enum([
  'internal',
  'design_partner',
  'limited_beta',
  'production_cohort',
  'halted',
  'rolled_back',
])

export const productionRolloutScopeSchema = z.object({
  tenantId: identifier,
  organizationId: identifier,
  workspaceId: identifier,
})

export const productionBudgetObservationSchema = z.object({
  requestCount: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  errorBudgetBurnRate: z.number().nonnegative(),
  tenantFairnessRatio: z.number().min(0).max(1),
  p95LatencyMs: z.number().nonnegative(),
  eventLagP95Ms: z.number().nonnegative(),
  backlog: z.number().int().nonnegative(),
  dataLoss: z.number().int().nonnegative(),
  uncontrolledDuplicates: z.number().int().nonnegative(),
  fenceViolations: z.number().int().nonnegative(),
})

export const productionBudgetPolicySchema = z.object({
  minimumRequests: z.number().int().positive(),
  minimumSuccessRate: z.number().min(0).max(1),
  maximumErrorBudgetBurnRate: z.number().nonnegative(),
  minimumTenantFairnessRatio: z.number().min(0).max(1),
  maximumP95LatencyMs: z.number().positive(),
  maximumEventLagP95Ms: z.number().positive(),
  maximumBacklog: z.number().int().nonnegative(),
})

export const productionRolloutRecordSchema =
  productionRolloutScopeSchema.extend({
    contractVersion: z.literal(PRODUCTION_READINESS_CONTRACT_VERSION),
    rolloutId: identifier,
    stage: productionRolloutStageSchema,
    version: z.number().int().positive(),
    cohortId: identifier,
    artifactSha256: sha256,
    previousArtifactSha256: sha256.nullable(),
    featureFlagEnabled: z.boolean(),
    killSwitch: z.boolean(),
    idempotency: z.record(identifier, sha256),
    historyHeadSha256: sha256.nullable(),
  })

export const goNoGoRecordSchema = productionRolloutScopeSchema.extend({
  contractVersion: z.literal(PRODUCTION_READINESS_CONTRACT_VERSION),
  recordId: identifier,
  rolloutId: identifier,
  decision: z.enum(['go', 'no_go']),
  owner: identifier,
  sourceCommit,
  acceptanceReportSha256: sha256,
  decidedAt: z.iso.datetime(),
  previousRecordSha256: sha256.nullable(),
  recordSha256: sha256,
})

export type ProductionRolloutStage = z.infer<
  typeof productionRolloutStageSchema
>
export type ProductionBudgetObservation = z.infer<
  typeof productionBudgetObservationSchema
>
export type ProductionBudgetPolicy = z.infer<
  typeof productionBudgetPolicySchema
>
export type ProductionRolloutRecord = z.infer<
  typeof productionRolloutRecordSchema
>
export type GoNoGoRecord = z.infer<typeof goNoGoRecordSchema>
