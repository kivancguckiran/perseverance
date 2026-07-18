import { z } from 'zod'

export const BILLING_CONTRACT_VERSION = 1 as const
const id = z.string().trim().min(1).max(255)
export const billingScopeSchema = z.object({
  tenantId: id,
  organizationId: id,
  workspaceId: id,
})
export const commercialPlanSchema = billingScopeSchema.extend({
  schemaVersion: z.literal(1),
  planId: id,
  planVersion: z.number().int().positive(),
  displayName: id,
  currency: z.string().regex(/^[A-Z]{3}$/),
  effectiveAt: z.iso.datetime(),
  retiredAt: z.iso.datetime().nullable(),
  billingMode: z.enum(['platform_managed', 'byok', 'hybrid']),
  taxBehavior: z.enum([
    'provider_determined',
    'exclusive',
    'inclusive',
    'unknown',
  ]),
})
export const entitlementKeySchema = z.enum([
  'turn.start',
  'source.upload',
  'source.index',
  'source.retrieval',
  'workspace.concurrency',
])
export const entitlementSchema = billingScopeSchema.extend({
  schemaVersion: z.literal(1),
  entitlementId: id,
  planId: id,
  planVersion: z.number().int().positive(),
  key: entitlementKeySchema,
  enabled: z.boolean(),
  effectiveAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  sourceWebhookEventId: id.nullable(),
})
export const subscriptionStateSchema = billingScopeSchema.extend({
  schemaVersion: z.literal(1),
  subscriptionId: id,
  billingCustomerId: id,
  planId: id,
  planVersion: z.number().int().positive(),
  state: z.enum([
    'trialing',
    'active',
    'past_due',
    'paused',
    'cancelled',
    'unknown',
  ]),
  provider: id,
  providerSequence: z.number().int().nonnegative(),
  effectiveAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  sourceWebhookEventId: id.nullable(),
})
export const budgetSchema = billingScopeSchema.extend({
  schemaVersion: z.literal(1),
  budgetId: id,
  period: z.enum(['day', 'month']),
  currency: z.string().regex(/^[A-Z]{3}$/),
  softLimitMicros: z.number().int().nonnegative().nullable(),
  hardLimitMicros: z.number().int().positive().nullable(),
  effectiveAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
})
export const quotaMeterSchema = z.enum([
  'tenant_concurrent_turn',
  'session_concurrent_turn',
  'provider_spend_micros',
  'corpus_source',
  'corpus_byte',
  'corpus_chunk',
  'storage_byte',
])
export const quotaPolicySchema = billingScopeSchema.extend({
  schemaVersion: z.literal(1),
  quotaId: id,
  policyVersion: z.number().int().positive(),
  meter: quotaMeterSchema,
  softLimit: z.number().int().nonnegative().nullable(),
  hardLimit: z.number().int().positive().nullable(),
  inFlightPolicy: z.enum(['continue', 'interrupt']),
  effectiveAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
})
export const billingCustomerSchema = billingScopeSchema.extend({
  schemaVersion: z.literal(1),
  billingCustomerId: id,
  provider: id,
  providerCustomerReference: id,
  createdAt: z.iso.datetime(),
})
export const webhookProcessingStateSchema = z.enum([
  'received',
  'processing',
  'processed',
  'unknown',
  'retry',
  'dead_letter',
])
export const billingWebhookEventSchema = billingScopeSchema.extend({
  schemaVersion: z.literal(1),
  webhookEventId: id,
  provider: id,
  signatureVersion: id,
  eventType: id,
  providerSequence: z.number().int().nonnegative(),
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  receivedAt: z.iso.datetime(),
  effectiveAt: z.iso.datetime(),
  processingState: webhookProcessingStateSchema,
  attempt: z.number().int().nonnegative(),
  lastErrorCode: id.nullable(),
})
export const invoiceReconciliationSchema = billingScopeSchema.extend({
  schemaVersion: z.literal(1),
  reconciliationId: id,
  invoiceId: id,
  provider: id,
  currency: z.string().regex(/^[A-Z]{3}$/),
  ledgerWatermark: id,
  measuredAmountMicros: z.number().int().nonnegative(),
  providerAmountMicros: z.number().int().nonnegative(),
  differenceMicros: z.number().int(),
  state: z.enum(['pending', 'matched', 'variance', 'incomplete']),
  reconciledAt: z.iso.datetime().nullable(),
})
export const usageMeterSchema = z.enum([
  'provider_input_token',
  'provider_cached_input_token',
  'provider_output_token',
  'provider_reasoning_token',
  'provider_reported_cost_micros',
  'compute_millisecond',
  'storage_byte_millisecond',
  'egress_byte',
  'index_embedding_token',
  'retrieval_embedding_token',
])
export const commercialUsageStatusSchema = z.enum([
  'measured',
  'estimated',
  'reconciled',
  'incomplete',
])
export const commercialUsageEntrySchema = billingScopeSchema.extend({
  schemaVersion: z.literal(1),
  ledgerEntryId: id,
  sessionId: id.nullable(),
  turnId: id.nullable(),
  sourceId: id.nullable(),
  meter: usageMeterSchema,
  quantity: z.number().int().nonnegative(),
  status: commercialUsageStatusSchema,
  priceCatalogVersion: id.nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  estimatedCostMicros: z.number().int().nonnegative().nullable(),
  officialCostMicros: z.number().int().nonnegative().nullable(),
  dedupeKey: id,
  occurredAt: z.iso.datetime(),
})
export const admissionRequestSchema = billingScopeSchema.extend({
  schemaVersion: z.literal(1),
  operation: entitlementKeySchema,
  measurements: z.partialRecord(
    quotaMeterSchema,
    z.number().int().nonnegative(),
  ),
  measurementWatermark: id,
  evaluatedAt: z.iso.datetime(),
})
export const admissionDecisionSchema = billingScopeSchema.extend({
  schemaVersion: z.literal(1),
  decisionId: id,
  operation: entitlementKeySchema,
  outcome: z.enum(['allow', 'warn', 'deny']),
  reason: id,
  policyVersion: z.number().int().positive(),
  measurementWatermark: id,
  evaluatedAt: z.iso.datetime(),
  inFlightPolicy: z.enum(['continue', 'interrupt']),
})
export type CommercialPlan = z.infer<typeof commercialPlanSchema>
export type Entitlement = z.infer<typeof entitlementSchema>
export type SubscriptionState = z.infer<typeof subscriptionStateSchema>
export type Budget = z.infer<typeof budgetSchema>
export type QuotaPolicy = z.infer<typeof quotaPolicySchema>
export type BillingCustomer = z.infer<typeof billingCustomerSchema>
export type BillingWebhookEvent = z.infer<typeof billingWebhookEventSchema>
export type InvoiceReconciliation = z.infer<typeof invoiceReconciliationSchema>
export type CommercialUsageEntry = z.infer<typeof commercialUsageEntrySchema>
export type AdmissionRequest = z.infer<typeof admissionRequestSchema>
export type AdmissionDecision = z.infer<typeof admissionDecisionSchema>
export interface CommercialPolicySnapshot {
  plan: CommercialPlan
  entitlements: Entitlement[]
  budgets: Budget[]
  quotas: QuotaPolicy[]
}
