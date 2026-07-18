import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { Pool, type PoolClient } from 'pg'

export const BILLING_CONTRACT_VERSION = 1 as const
const id = z.string().trim().min(1).max(255)
const scope = z.object({
  tenantId: id,
  organizationId: id,
  workspaceId: id,
})

export const commercialPlanSchema = scope.extend({
  schemaVersion: z.literal(BILLING_CONTRACT_VERSION),
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
export const entitlementSchema = scope.extend({
  schemaVersion: z.literal(BILLING_CONTRACT_VERSION),
  entitlementId: id,
  planId: id,
  planVersion: z.number().int().positive(),
  key: entitlementKeySchema,
  enabled: z.boolean(),
  effectiveAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  sourceWebhookEventId: id.nullable(),
})

export const subscriptionStateSchema = scope.extend({
  schemaVersion: z.literal(BILLING_CONTRACT_VERSION),
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

export const budgetSchema = scope.extend({
  schemaVersion: z.literal(BILLING_CONTRACT_VERSION),
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
export const quotaPolicySchema = scope.extend({
  schemaVersion: z.literal(BILLING_CONTRACT_VERSION),
  quotaId: id,
  policyVersion: z.number().int().positive(),
  meter: quotaMeterSchema,
  softLimit: z.number().int().nonnegative().nullable(),
  hardLimit: z.number().int().positive().nullable(),
  inFlightPolicy: z.enum(['continue', 'interrupt']),
  effectiveAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
})

export const billingCustomerSchema = scope.extend({
  schemaVersion: z.literal(BILLING_CONTRACT_VERSION),
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
export const billingWebhookEventSchema = scope.extend({
  schemaVersion: z.literal(BILLING_CONTRACT_VERSION),
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

export const invoiceReconciliationSchema = scope.extend({
  schemaVersion: z.literal(BILLING_CONTRACT_VERSION),
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
export const commercialUsageEntrySchema = scope.extend({
  schemaVersion: z.literal(BILLING_CONTRACT_VERSION),
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

export const admissionRequestSchema = scope.extend({
  schemaVersion: z.literal(BILLING_CONTRACT_VERSION),
  operation: entitlementKeySchema,
  measurements: z.partialRecord(
    quotaMeterSchema,
    z.number().int().nonnegative(),
  ),
  measurementWatermark: id,
  evaluatedAt: z.iso.datetime(),
})
export const admissionDecisionSchema = scope.extend({
  schemaVersion: z.literal(BILLING_CONTRACT_VERSION),
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

const operationMeters: Record<
  AdmissionRequest['operation'],
  QuotaPolicy['meter'][]
> = {
  'turn.start': [
    'tenant_concurrent_turn',
    'session_concurrent_turn',
    'provider_spend_micros',
  ],
  'source.upload': ['corpus_source', 'corpus_byte', 'storage_byte'],
  'source.index': ['corpus_chunk', 'provider_spend_micros'],
  'source.retrieval': ['provider_spend_micros'],
  'workspace.concurrency': ['tenant_concurrent_turn'],
}

export function evaluateAdmission(
  requestInput: AdmissionRequest,
  snapshot: CommercialPolicySnapshot,
): AdmissionDecision {
  const request = admissionRequestSchema.parse(requestInput)
  commercialPlanSchema.parse(snapshot.plan)
  const entitlement = snapshot.entitlements
    .map((value) => entitlementSchema.parse(value))
    .find((value) => value.key === request.operation)
  const base = {
    ...request,
    schemaVersion: BILLING_CONTRACT_VERSION,
    decisionId: `qad_${createHash('sha256')
      .update(
        JSON.stringify([
          request.tenantId,
          request.organizationId,
          request.workspaceId,
          request.operation,
          request.measurementWatermark,
          snapshot.plan.planVersion,
        ]),
      )
      .digest('hex')
      .slice(0, 32)}`,
    policyVersion: snapshot.plan.planVersion,
  } as const
  if (!entitlement?.enabled)
    return admissionDecisionSchema.parse({
      ...base,
      outcome: 'deny',
      reason: 'ENTITLEMENT_DISABLED',
      inFlightPolicy: 'continue',
    })

  let warning: { reason: string; policy: QuotaPolicy } | null = null
  for (const policy of snapshot.quotas.map((value) =>
    quotaPolicySchema.parse(value),
  )) {
    if (!(operationMeters[request.operation] ?? []).includes(policy.meter))
      continue
    const measured = request.measurements[policy.meter] ?? 0
    if (policy.hardLimit !== null && measured >= policy.hardLimit)
      return admissionDecisionSchema.parse({
        ...base,
        policyVersion: policy.policyVersion,
        outcome: 'deny',
        reason: `HARD_LIMIT_${policy.meter.toUpperCase()}`,
        inFlightPolicy: policy.inFlightPolicy,
      })
    if (policy.softLimit !== null && measured >= policy.softLimit)
      warning ??= { reason: `SOFT_LIMIT_${policy.meter.toUpperCase()}`, policy }
  }
  if (warning)
    return admissionDecisionSchema.parse({
      ...base,
      policyVersion: warning.policy.policyVersion,
      outcome: 'warn',
      reason: warning.reason,
      inFlightPolicy: warning.policy.inFlightPolicy,
    })
  return admissionDecisionSchema.parse({
    ...base,
    outcome: 'allow',
    reason: 'WITHIN_POLICY',
    inFlightPolicy: 'continue',
  })
}

export class BillingWebhookError extends Error {
  readonly code:
    | 'PAYLOAD_TOO_LARGE'
    | 'SIGNATURE_INVALID'
    | 'TIMESTAMP_INVALID'
    | 'REPLAY_REJECTED'
    | 'PAYLOAD_INVALID'
  constructor(
    code:
      | 'PAYLOAD_TOO_LARGE'
      | 'SIGNATURE_INVALID'
      | 'TIMESTAMP_INVALID'
      | 'REPLAY_REJECTED'
      | 'PAYLOAD_INVALID',
    message: string = code,
  ) {
    super(message)
    this.code = code
    this.name = 'BillingWebhookError'
  }
}

export interface BillingProviderPort {
  readonly provider: string
  readonly signatureVersion: string
  readonly productionEvidence: boolean
  verify(input: {
    payload: Buffer
    timestamp: number
    signature: string
    replayKey: string
    now?: Date
  }): {
    payload: unknown
    payloadDigest: string
    provider: string
    signatureVersion: string
    productionEvidence: boolean
  }
}

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class DeterministicBillingEmulator implements BillingProviderPort {
  readonly provider = 'deterministic-billing-emulator'
  readonly signatureVersion = 'hmac-sha256-v1'
  readonly productionEvidence = false
  readonly #secret: Buffer
  readonly #maxPayloadBytes: number
  readonly #toleranceMs: number
  readonly #seen = new Set<string>()

  constructor(input: {
    secret: Uint8Array
    maxPayloadBytes?: number
    toleranceMs?: number
  }) {
    this.#secret = Buffer.from(input.secret)
    if (this.#secret.byteLength < 32)
      throw new BillingWebhookError('SIGNATURE_INVALID')
    this.#maxPayloadBytes = input.maxPayloadBytes ?? 64 * 1024
    this.#toleranceMs = input.toleranceMs ?? 5 * 60_000
  }

  sign(payload: Buffer, timestamp: number) {
    if (payload.byteLength > this.#maxPayloadBytes)
      throw new BillingWebhookError('PAYLOAD_TOO_LARGE')
    return createHmac('sha256', this.#secret)
      .update(`${timestamp}.`)
      .update(payload)
      .digest('hex')
  }

  verify(input: {
    payload: Buffer
    timestamp: number
    signature: string
    replayKey: string
    now?: Date
  }) {
    if (input.payload.byteLength > this.#maxPayloadBytes)
      throw new BillingWebhookError('PAYLOAD_TOO_LARGE')
    const now = input.now ?? new Date()
    if (
      !Number.isSafeInteger(input.timestamp) ||
      Math.abs(now.getTime() - input.timestamp) > this.#toleranceMs
    )
      throw new BillingWebhookError('TIMESTAMP_INVALID')
    const expected = this.sign(input.payload, input.timestamp)
    if (!safeEqual(input.signature, expected))
      throw new BillingWebhookError('SIGNATURE_INVALID')
    if (this.#seen.has(input.replayKey))
      throw new BillingWebhookError('REPLAY_REJECTED')
    this.#seen.add(input.replayKey)
    let payload: unknown
    try {
      payload = JSON.parse(input.payload.toString('utf8'))
    } catch {
      throw new BillingWebhookError('PAYLOAD_INVALID')
    }
    return {
      payload,
      payloadDigest: `sha256:${createHash('sha256').update(input.payload).digest('hex')}`,
      provider: this.provider,
      signatureVersion: this.signatureVersion,
      productionEvidence: this.productionEvidence,
    }
  }
}

export class BillingPostgresRepository {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async withScope<T>(
    scopeInput: z.infer<typeof scope>,
    fn: (client: PoolClient) => Promise<T>,
  ) {
    const value = scope.parse(scopeInput)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.organization_id',$2,true),set_config('app.workspace_id',$3,true)",
        [value.tenantId, value.organizationId, value.workspaceId],
      )
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async recordWebhook(eventInput: BillingWebhookEvent) {
    const event = billingWebhookEventSchema.parse(eventInput)
    return this.withScope(event, async (client) => {
      const result = await client.query<{
        processing_state: BillingWebhookEvent['processingState']
        payload_digest: string
        effective_at: Date
        duplicate: boolean
      }>(
        `INSERT INTO persistent_codex.billing_webhook_events
          (tenant_id,organization_id,workspace_id,webhook_event_id,provider,signature_version,event_type,provider_sequence,payload_digest,received_at,effective_at,processing_state,attempt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (tenant_id,organization_id,workspace_id,provider,webhook_event_id)
         DO UPDATE SET received_at=LEAST(persistent_codex.billing_webhook_events.received_at,EXCLUDED.received_at)
         RETURNING processing_state,payload_digest,effective_at,(xmax <> 0) AS duplicate`,
        [
          event.tenantId,
          event.organizationId,
          event.workspaceId,
          event.webhookEventId,
          event.provider,
          event.signatureVersion,
          event.eventType,
          event.providerSequence,
          event.payloadDigest,
          event.receivedAt,
          event.effectiveAt,
          event.processingState,
          event.attempt,
        ],
      )
      const row = result.rows[0]!
      if (row.payload_digest !== event.payloadDigest)
        throw new BillingWebhookError(
          'PAYLOAD_INVALID',
          'Webhook event ID was reused with a different digest',
        )
      return {
        duplicate: row.duplicate,
        processingState: row.processing_state,
        effectiveAt: row.effective_at.toISOString(),
      }
    })
  }

  async applySubscription(input: SubscriptionState) {
    const state = subscriptionStateSchema.parse(input)
    return this.withScope(state, async (client) => {
      const result = await client.query(
        `INSERT INTO persistent_codex.billing_subscriptions
          (tenant_id,organization_id,workspace_id,subscription_id,billing_customer_id,plan_id,plan_version,state,provider,provider_sequence,effective_at,updated_at,source_webhook_event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (tenant_id,organization_id,workspace_id,subscription_id)
         DO UPDATE SET billing_customer_id=EXCLUDED.billing_customer_id,plan_id=EXCLUDED.plan_id,plan_version=EXCLUDED.plan_version,state=EXCLUDED.state,provider=EXCLUDED.provider,provider_sequence=EXCLUDED.provider_sequence,effective_at=EXCLUDED.effective_at,updated_at=EXCLUDED.updated_at,source_webhook_event_id=EXCLUDED.source_webhook_event_id
         WHERE (EXCLUDED.provider_sequence,EXCLUDED.effective_at) > (persistent_codex.billing_subscriptions.provider_sequence,persistent_codex.billing_subscriptions.effective_at)`,
        [
          state.tenantId,
          state.organizationId,
          state.workspaceId,
          state.subscriptionId,
          state.billingCustomerId,
          state.planId,
          state.planVersion,
          state.state,
          state.provider,
          state.providerSequence,
          state.effectiveAt,
          state.updatedAt,
          state.sourceWebhookEventId,
        ],
      )
      return { applied: (result.rowCount ?? 0) > 0 }
    })
  }

  async recoverStale(now: Date, leaseMs = 30_000) {
    const result = await this.pool.query(
      `SELECT webhook_event_id FROM persistent_codex.billing_recover_stale_webhooks($1,$2)`,
      [now.toISOString(), leaseMs],
    )
    return result.rows.map((row: { webhook_event_id: unknown }) =>
      String(row.webhook_event_id),
    )
  }

  async markWebhookProcessing(
    scopeInput: z.infer<typeof scope>,
    webhookEventId: string,
    updatedAt: Date,
  ) {
    return this.withScope(scopeInput, async (client) => {
      const result = await client.query(
        `UPDATE persistent_codex.billing_webhook_events
         SET processing_state='processing',updated_at=$1
         WHERE webhook_event_id=$2`,
        [updatedAt.toISOString(), webhookEventId],
      )
      return result.rowCount ?? 0
    })
  }

  async countBillingCustomers(
    scopeInput: z.infer<typeof scope>,
    organizationId?: string,
  ) {
    return this.withScope(scopeInput, async (client) =>
      Number(
        (
          await client.query<{ count: string }>(
            `SELECT count(*) AS count FROM persistent_codex.billing_customers
             WHERE ($1::text IS NULL OR organization_id=$1)`,
            [organizationId ?? null],
          )
        ).rows[0]?.count ?? 0,
      ),
    )
  }

  async close() {
    await this.pool.end()
  }
}

export function createBillingPostgresRepository(connectionString: string) {
  return new BillingPostgresRepository(new Pool({ connectionString }))
}
