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
export const billingWebhookPayloadSchema = billingScopeSchema
  .extend({
    schemaVersion: z.literal(1),
    eventId: id,
    eventType: id,
    providerSequence: z.number().int().nonnegative(),
    effectiveAt: z.iso.datetime(),
    data: z.unknown().optional(),
  })
  .strict()
export const billingWebhookSubscriptionDataSchema = z
  .object({
    subscriptionId: id,
    billingCustomerId: id,
    providerCustomerReference: id,
    plan: commercialPlanSchema.omit({
      tenantId: true,
      organizationId: true,
      workspaceId: true,
    }),
    state: subscriptionStateSchema.shape.state,
    entitlements: z.array(
      entitlementSchema.omit({
        tenantId: true,
        organizationId: true,
        workspaceId: true,
        sourceWebhookEventId: true,
      }),
    ),
    budgets: z.array(
      budgetSchema.omit({
        tenantId: true,
        organizationId: true,
        workspaceId: true,
      }),
    ),
    quotas: z.array(
      quotaPolicySchema.omit({
        tenantId: true,
        organizationId: true,
        workspaceId: true,
      }),
    ),
  })
  .strict()
export const billingWebhookCreditPurchaseDataSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    creditsMicros: z.number().int().positive(),
    cashAmountMicros: z.number().int().positive(),
    paymentReference: id,
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict()
export const billingWebhookPromotionalGrantDataSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    creditsMicros: z.number().int().positive(),
    grantReference: id,
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict()
export const billingWebhookCreditReversalDataSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    creditsMicros: z.number().int().positive(),
    cashAmountMicros: z.number().int().nonnegative(),
    paymentReference: id,
  })
  .strict()
export const billingWebhookResponseSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: id,
  state: webhookProcessingStateSchema,
  duplicate: z.boolean(),
  productionEvidence: z.boolean(),
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
export const creditEntryTypeSchema = z.enum([
  'purchase',
  'promotional_grant',
  'reservation',
  'reservation_release',
  'usage_settlement',
  'refund',
  'chargeback',
  'expiration',
  'admin_adjustment',
])
export const creditLotKindSchema = z.enum(['paid', 'promotional'])
const creditReferencesSchema = z.object({
  paymentReference: id.nullable(),
  usageDedupeKey: id.nullable(),
  runId: id.nullable(),
  operationReference: id.nullable(),
})
export const creditLotSchema = billingScopeSchema
  .merge(creditReferencesSchema)
  .extend({
    schemaVersion: z.literal(1),
    lotId: id,
    kind: creditLotKindSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    originalCreditsMicros: z.number().int().nonnegative(),
    originalCashMicros: z.number().int().nonnegative(),
    idempotencyKey: id,
    occurredAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    sourceWebhookEventId: id.nullable(),
    consumptionPolicyVersion: z.number().int().positive(),
  })
export const creditLedgerEntrySchema = billingScopeSchema
  .merge(creditReferencesSchema)
  .extend({
    schemaVersion: z.literal(1),
    ledgerEntryId: id,
    ledgerSequence: z.number().int().nonnegative(),
    lotId: id,
    entryType: creditEntryTypeSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    creditAmountMicros: z.number().int(),
    cashAmountMicros: z.number().int().nonnegative(),
    idempotencyKey: id,
    occurredAt: z.iso.datetime(),
    reservationId: id.nullable(),
    settlementId: id.nullable(),
    sourceWebhookEventId: id.nullable(),
  })
export const creditReservationSchema = billingScopeSchema
  .merge(creditReferencesSchema)
  .extend({
    schemaVersion: z.literal(1),
    reservationId: id,
    currency: z.string().regex(/^[A-Z]{3}$/),
    idempotencyKey: id,
    operation: entitlementKeySchema,
    retailPriceCatalogVersion: id,
    maximumCreditsMicros: z.number().int().positive(),
    settledCreditsMicros: z.number().int().nonnegative(),
    releasedCreditsMicros: z.number().int().nonnegative(),
    unresolvedCreditsMicros: z.number().int().nonnegative(),
    state: z.enum(['reserved', 'partially_settled', 'settled', 'released']),
    version: z.number().int().positive(),
    occurredAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
  })
export const creditSettlementSchema = billingScopeSchema
  .merge(creditReferencesSchema)
  .extend({
    schemaVersion: z.literal(1),
    settlementId: id,
    reservationId: id,
    currency: z.string().regex(/^[A-Z]{3}$/),
    idempotencyKey: id,
    retailPriceCatalogVersion: id,
    measuredCreditsMicros: z.number().int().nonnegative(),
    releasedCreditsMicros: z.number().int().nonnegative(),
    usageStatus: commercialUsageStatusSchema,
    outcome: z.enum(['completed', 'failed', 'interrupted', 'incomplete']),
    terminal: z.boolean(),
    occurredAt: z.iso.datetime(),
  })
export const retailPriceRateSchema = z.object({
  meter: usageMeterSchema,
  creditsMicrosPerUnit: z.number().int().nonnegative(),
})
export const retailOperationMaximumSchema = z.object({
  operation: entitlementKeySchema,
  maximumCreditsMicros: z.number().int().positive(),
})
export const retailPriceCatalogSchema = billingScopeSchema
  .merge(creditReferencesSchema)
  .extend({
    schemaVersion: z.literal(1),
    catalogId: id,
    catalogVersion: id,
    currency: z.string().regex(/^[A-Z]{3}$/),
    rates: z.array(retailPriceRateSchema).min(1),
    operationMaximums: z.array(retailOperationMaximumSchema).min(1),
    idempotencyKey: id,
    occurredAt: z.iso.datetime(),
    effectiveAt: z.iso.datetime(),
    retiredAt: z.iso.datetime().nullable(),
  })
export const creditBalanceSchema = billingScopeSchema.extend({
  schemaVersion: z.literal(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  availableCreditsMicros: z.number().int(),
  reservedCreditsMicros: z.number().int().nonnegative(),
  consumedCreditsMicros: z.number().int().nonnegative(),
  paidAvailableCreditsMicros: z.number().int(),
  promotionalAvailableCreditsMicros: z.number().int(),
  paidReservedCreditsMicros: z.number().int().nonnegative(),
  promotionalReservedCreditsMicros: z.number().int().nonnegative(),
  ledgerWatermark: id,
  freshnessAt: z.iso.datetime(),
})
export const financialProjectionSchema = billingScopeSchema
  .merge(creditReferencesSchema)
  .extend({
    schemaVersion: z.literal(1),
    projectionId: id,
    currency: z.string().regex(/^[A-Z]{3}$/),
    retailPriceCatalogVersion: id,
    ledgerWatermark: id,
    idempotencyKey: id,
    occurredAt: z.iso.datetime(),
    cashCollectedMicros: z.number().int(),
    outstandingPaidCreditLiabilityMicros: z.number().int(),
    consumedPaidCreditRevenueMicros: z.number().int().nonnegative(),
    promotionalConsumptionMicros: z.number().int().nonnegative(),
    refundsMicros: z.number().int().nonnegative(),
    chargebacksMicros: z.number().int().nonnegative(),
    providerCogsMicros: z.number().int().nonnegative(),
    infrastructureCogsMicros: z.number().int().nonnegative(),
    grossMarginMicros: z.number().int(),
    projectedAt: z.iso.datetime(),
    accountingStatus: z.literal('operational_projection_not_tax_advice'),
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
export type BillingScope = z.infer<typeof billingScopeSchema>
export type Entitlement = z.infer<typeof entitlementSchema>
export type SubscriptionState = z.infer<typeof subscriptionStateSchema>
export type Budget = z.infer<typeof budgetSchema>
export type QuotaPolicy = z.infer<typeof quotaPolicySchema>
export type BillingCustomer = z.infer<typeof billingCustomerSchema>
export type BillingWebhookEvent = z.infer<typeof billingWebhookEventSchema>
export type BillingWebhookPayload = z.infer<typeof billingWebhookPayloadSchema>
export type BillingWebhookSubscriptionData = z.infer<
  typeof billingWebhookSubscriptionDataSchema
>
export type BillingWebhookCreditPurchaseData = z.infer<
  typeof billingWebhookCreditPurchaseDataSchema
>
export type BillingWebhookPromotionalGrantData = z.infer<
  typeof billingWebhookPromotionalGrantDataSchema
>
export type BillingWebhookCreditReversalData = z.infer<
  typeof billingWebhookCreditReversalDataSchema
>
export type BillingWebhookResponse = z.infer<
  typeof billingWebhookResponseSchema
>
export type InvoiceReconciliation = z.infer<typeof invoiceReconciliationSchema>
export type CommercialUsageEntry = z.infer<typeof commercialUsageEntrySchema>
export type CreditEntryType = z.infer<typeof creditEntryTypeSchema>
export type CreditLot = z.infer<typeof creditLotSchema>
export type CreditLedgerEntry = z.infer<typeof creditLedgerEntrySchema>
export type CreditReservation = z.infer<typeof creditReservationSchema>
export type CreditSettlement = z.infer<typeof creditSettlementSchema>
export type RetailPriceCatalog = z.infer<typeof retailPriceCatalogSchema>
export type CreditBalance = z.infer<typeof creditBalanceSchema>
export type FinancialProjection = z.infer<typeof financialProjectionSchema>
export type AdmissionRequest = z.infer<typeof admissionRequestSchema>
export type AdmissionDecision = z.infer<typeof admissionDecisionSchema>
export interface CommercialPolicySnapshot {
  plan: CommercialPlan
  entitlements: Entitlement[]
  budgets: Budget[]
  quotas: QuotaPolicy[]
}
