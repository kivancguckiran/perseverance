import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import {
  BILLING_CONTRACT_VERSION,
  admissionDecisionSchema,
  admissionRequestSchema,
  billingWebhookPayloadSchema,
  billingWebhookCreditPurchaseDataSchema,
  billingWebhookCreditReversalDataSchema,
  billingWebhookPromotionalGrantDataSchema,
  billingWebhookSubscriptionDataSchema,
  billingScopeSchema,
  billingWebhookEventSchema,
  budgetSchema,
  commercialPlanSchema,
  creditBalanceSchema,
  creditLedgerEntrySchema,
  creditLotSchema,
  creditReservationSchema,
  creditSettlementSchema,
  entitlementSchema,
  financialProjectionSchema,
  quotaPolicySchema,
  retailPriceCatalogSchema,
  subscriptionStateSchema,
  type AdmissionDecision,
  type AdmissionRequest,
  type BillingScope,
  type BillingWebhookEvent,
  type BillingWebhookPayload,
  type BillingWebhookCreditPurchaseData,
  type BillingWebhookCreditReversalData,
  type BillingWebhookPromotionalGrantData,
  type BillingWebhookSubscriptionData,
  type Budget,
  type CommercialPolicySnapshot,
  type CommercialPlan,
  type CreditBalance,
  type CreditLedgerEntry,
  type CreditLot,
  type CreditReservation,
  type CreditSettlement,
  type Entitlement,
  type QuotaPolicy,
  type RetailPriceCatalog,
  type FinancialProjection,
  type SubscriptionState,
} from './contracts.js'

export * from './contracts.js'

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
    | 'EVENT_CONFLICT'
  constructor(
    code:
      | 'PAYLOAD_TOO_LARGE'
      | 'SIGNATURE_INVALID'
      | 'TIMESTAMP_INVALID'
      | 'REPLAY_REJECTED'
      | 'PAYLOAD_INVALID'
      | 'EVENT_CONFLICT',
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

export type NormalizedBillingWebhookCommand =
  | {
      kind: 'subscription.updated'
      data: BillingWebhookSubscriptionData
    }
  | { kind: 'credit.purchase'; data: BillingWebhookCreditPurchaseData }
  | {
      kind: 'credit.promotional_grant'
      data: BillingWebhookPromotionalGrantData
    }
  | {
      kind: 'credit.refund' | 'credit.chargeback'
      data: BillingWebhookCreditReversalData
    }
  | { kind: 'unknown' }

export function normalizeBillingWebhookPayload(input: unknown): {
  envelope: BillingWebhookPayload
  command: NormalizedBillingWebhookCommand
} {
  const envelope = billingWebhookPayloadSchema.parse(input)
  if (envelope.eventType === 'subscription.updated')
    return {
      envelope,
      command: {
        kind: 'subscription.updated',
        data: billingWebhookSubscriptionDataSchema.parse(envelope.data),
      },
    }
  if (envelope.eventType === 'credit.purchase')
    return {
      envelope,
      command: {
        kind: 'credit.purchase',
        data: billingWebhookCreditPurchaseDataSchema.parse(envelope.data),
      },
    }
  if (envelope.eventType === 'credit.promotional_grant')
    return {
      envelope,
      command: {
        kind: 'credit.promotional_grant',
        data: billingWebhookPromotionalGrantDataSchema.parse(envelope.data),
      },
    }
  if (
    envelope.eventType === 'credit.refund' ||
    envelope.eventType === 'credit.chargeback'
  )
    return {
      envelope,
      command: {
        kind: envelope.eventType,
        data: billingWebhookCreditReversalDataSchema.parse(envelope.data),
      },
    }
  return { envelope, command: { kind: 'unknown' } }
}

export interface DevelopmentCommercialSeed {
  plan: Omit<CommercialPlan, keyof BillingScope>
  entitlements: Array<Omit<Entitlement, keyof BillingScope>>
  budgets: Array<Omit<Budget, keyof BillingScope>>
  quotas: Array<Omit<QuotaPolicy, keyof BillingScope>>
  retailPriceCatalog?: Omit<RetailPriceCatalog, keyof BillingScope>
  initialPromotionalCreditsMicros?: number
}

export interface DurableAdmissionInput extends BillingScope {
  operation: AdmissionRequest['operation']
  requestKey: string
  sessionId?: string
  requestedBytes?: number
  evaluatedAt?: Date
}

export class PrepaidCreditError extends Error {
  readonly code:
    | 'CREDIT_INSUFFICIENT'
    | 'RESERVATION_NOT_FOUND'
    | 'SETTLEMENT_EXCEEDS_RESERVATION'
    | 'RETAIL_PRICE_CATALOG_MISSING'
    | 'CREDIT_CURRENCY_MISMATCH'
    | 'NEGATIVE_BALANCE_FORBIDDEN'
  constructor(code: PrepaidCreditError['code']) {
    super(code)
    this.code = code
    this.name = 'PrepaidCreditError'
  }
}

export interface CreditLotInput extends BillingScope {
  kind: CreditLot['kind']
  currency: string
  creditsMicros: number
  cashAmountMicros: number
  idempotencyKey: string
  paymentReference?: string
  operationReference?: string
  sourceWebhookEventId?: string
  occurredAt?: Date
  expiresAt?: Date | null
}

export interface CreditReservationInput extends BillingScope {
  operation: AdmissionRequest['operation']
  idempotencyKey: string
  maximumCreditsMicros?: number
  runId?: string
  operationReference?: string
  occurredAt?: Date
}

export interface CreditSettlementInput extends BillingScope {
  reservationId: string
  idempotencyKey: string
  usageDedupeKey: string
  measuredCreditsMicros: number
  usageStatus: CreditSettlement['usageStatus']
  outcome: CreditSettlement['outcome']
  terminal: boolean
  runId?: string
  occurredAt?: Date
}

const deterministicId = (prefix: string, ...parts: unknown[]) =>
  `${prefix}_${createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 32)}`

export class BillingPostgresRepository {
  private readonly pool: Pool
  readonly productionBillingVerified: boolean
  readonly #developmentSeed: DevelopmentCommercialSeed | undefined
  constructor(
    pool: Pool,
    options: {
      productionBillingVerified?: boolean
      developmentSeed?: DevelopmentCommercialSeed
    } = {},
  ) {
    this.pool = pool
    this.productionBillingVerified = options.productionBillingVerified === true
    this.#developmentSeed = options.developmentSeed
  }

  async withScope<T>(
    scopeInput: BillingScope,
    fn: (client: PoolClient) => Promise<T>,
  ) {
    const value = billingScopeSchema.parse(scopeInput)
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

  async upsertRetailPriceCatalog(input: RetailPriceCatalog) {
    const catalog = retailPriceCatalogSchema.parse(input)
    return this.withScope(catalog, async (client) => {
      await client.query(
        `INSERT INTO persistent_codex.retail_price_catalogs
          (tenant_id,organization_id,workspace_id,catalog_id,catalog_version,currency,rates,operation_maximums,idempotency_key,payment_reference,usage_dedupe_key,run_id,operation_reference,occurred_at,effective_at,retired_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (tenant_id,organization_id,workspace_id,catalog_id,catalog_version) DO NOTHING`,
        [
          catalog.tenantId,
          catalog.organizationId,
          catalog.workspaceId,
          catalog.catalogId,
          catalog.catalogVersion,
          catalog.currency,
          JSON.stringify(catalog.rates),
          JSON.stringify(catalog.operationMaximums),
          catalog.idempotencyKey,
          catalog.paymentReference,
          catalog.usageDedupeKey,
          catalog.runId,
          catalog.operationReference,
          catalog.occurredAt,
          catalog.effectiveAt,
          catalog.retiredAt,
        ],
      )
      return catalog
    })
  }

  async createCreditLot(input: CreditLotInput): Promise<CreditLot> {
    const scope = billingScopeSchema.parse(input)
    const occurredAt = input.occurredAt ?? new Date()
    const paymentReference = input.paymentReference?.trim() || null
    const lotId = deterministicId(
      'clot',
      scope.tenantId,
      scope.organizationId,
      scope.workspaceId,
      input.kind,
      paymentReference ?? input.idempotencyKey,
    )
    return this.withScope(scope, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [
          JSON.stringify([
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            paymentReference ?? input.idempotencyKey,
          ]),
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.credit_lots
          (tenant_id,organization_id,workspace_id,lot_id,lot_kind,currency,original_credits_micros,original_cash_micros,idempotency_key,payment_reference,usage_dedupe_key,run_id,operation_reference,occurred_at,expires_at,source_webhook_event_id,consumption_policy_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11,$12,$13,$14,1)
         ON CONFLICT (tenant_id,organization_id,workspace_id,payment_reference)
           WHERE payment_reference IS NOT NULL AND lot_kind='paid'
         DO UPDATE SET original_credits_micros=GREATEST(persistent_codex.credit_lots.original_credits_micros,EXCLUDED.original_credits_micros),
           original_cash_micros=GREATEST(persistent_codex.credit_lots.original_cash_micros,EXCLUDED.original_cash_micros),
           expires_at=coalesce(EXCLUDED.expires_at,persistent_codex.credit_lots.expires_at)`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          lotId,
          input.kind,
          input.currency,
          input.creditsMicros,
          input.cashAmountMicros,
          input.idempotencyKey,
          paymentReference,
          input.operationReference ?? null,
          occurredAt.toISOString(),
          input.expiresAt?.toISOString() ?? null,
          input.sourceWebhookEventId ?? null,
        ],
      )
      const lotRow = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.credit_lots
           WHERE lot_id=$1 OR ($2::text IS NOT NULL AND payment_reference=$2) LIMIT 1`,
          [lotId, paymentReference],
        )
      ).rows[0]!
      const actualLotId = String(lotRow.lot_id)
      const entryType = input.kind === 'paid' ? 'purchase' : 'promotional_grant'
      await client.query(
        `INSERT INTO persistent_codex.credit_ledger_entries
          (tenant_id,organization_id,workspace_id,ledger_entry_id,lot_id,entry_type,currency,credit_amount_micros,cash_amount_micros,idempotency_key,payment_reference,usage_dedupe_key,run_id,operation_reference,reservation_id,settlement_id,source_webhook_event_id,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NULL,$12,NULL,NULL,$13,$14)
         ON CONFLICT (tenant_id,organization_id,workspace_id,idempotency_key) DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          deterministicId('cle', input.idempotencyKey, entryType),
          actualLotId,
          entryType,
          input.currency,
          input.creditsMicros,
          input.cashAmountMicros,
          input.idempotencyKey,
          paymentReference,
          input.operationReference ?? null,
          input.sourceWebhookEventId ?? null,
          occurredAt.toISOString(),
        ],
      )
      return creditLotSchema.parse({
        schemaVersion: 1,
        ...scope,
        lotId: actualLotId,
        kind: lotRow.lot_kind,
        currency: lotRow.currency,
        originalCreditsMicros: Number(lotRow.original_credits_micros),
        originalCashMicros: Number(lotRow.original_cash_micros),
        idempotencyKey: lotRow.idempotency_key,
        paymentReference: lotRow.payment_reference,
        usageDedupeKey: null,
        runId: null,
        operationReference: lotRow.operation_reference,
        occurredAt: (lotRow.occurred_at as Date).toISOString(),
        expiresAt: lotRow.expires_at
          ? (lotRow.expires_at as Date).toISOString()
          : null,
        sourceWebhookEventId: lotRow.source_webhook_event_id,
        consumptionPolicyVersion: Number(lotRow.consumption_policy_version),
      })
    })
  }

  async appendCreditLifecycle(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    entryType: 'refund' | 'chargeback' | 'expiration' | 'admin_adjustment'
    currency: string
    creditsMicros: number
    cashAmountMicros?: number
    idempotencyKey: string
    lotId?: string
    paymentReference?: string
    sourceWebhookEventId?: string
    occurredAt?: Date
  }) {
    const scope = billingScopeSchema.parse(input)
    const occurredAt = input.occurredAt ?? new Date()
    return this.withScope(scope, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [
          JSON.stringify([
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            input.paymentReference ?? input.lotId ?? input.idempotencyKey,
          ]),
        ],
      )
      let lotRow = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.credit_lots
           WHERE ($1::text IS NOT NULL AND lot_id=$1)
              OR ($2::text IS NOT NULL AND payment_reference=$2)
           ORDER BY occurred_at,lot_id LIMIT 1`,
          [input.lotId ?? null, input.paymentReference ?? null],
        )
      ).rows[0]
      if (!lotRow && input.paymentReference) {
        const placeholderId = deterministicId(
          'clot',
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          'paid',
          input.paymentReference,
        )
        await client.query(
          `INSERT INTO persistent_codex.credit_lots
            (tenant_id,organization_id,workspace_id,lot_id,lot_kind,currency,original_credits_micros,original_cash_micros,idempotency_key,payment_reference,usage_dedupe_key,run_id,operation_reference,occurred_at,expires_at,source_webhook_event_id,consumption_policy_version)
           VALUES ($1,$2,$3,$4,'paid',$5,0,0,$6,$7,NULL,NULL,NULL,$8,NULL,$9,1)
           ON CONFLICT DO NOTHING`,
          [
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            placeholderId,
            input.currency,
            `placeholder:${input.paymentReference}`,
            input.paymentReference,
            occurredAt.toISOString(),
            input.sourceWebhookEventId ?? null,
          ],
        )
        lotRow = (
          await client.query<Record<string, unknown>>(
            `SELECT * FROM persistent_codex.credit_lots WHERE payment_reference=$1`,
            [input.paymentReference],
          )
        ).rows[0]
      }
      if (!lotRow) throw new PrepaidCreditError('RESERVATION_NOT_FOUND')
      if (lotRow.currency !== input.currency)
        throw new PrepaidCreditError('CREDIT_CURRENCY_MISMATCH')
      const signedAmount =
        input.entryType === 'admin_adjustment'
          ? input.creditsMicros
          : Math.abs(input.creditsMicros)
      await client.query(
        `INSERT INTO persistent_codex.credit_ledger_entries
          (tenant_id,organization_id,workspace_id,ledger_entry_id,lot_id,entry_type,currency,credit_amount_micros,cash_amount_micros,idempotency_key,payment_reference,usage_dedupe_key,run_id,operation_reference,reservation_id,settlement_id,source_webhook_event_id,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NULL,NULL,NULL,NULL,$12,$13)
         ON CONFLICT (tenant_id,organization_id,workspace_id,idempotency_key) DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          deterministicId('cle', input.idempotencyKey, input.entryType),
          lotRow.lot_id,
          input.entryType,
          input.currency,
          signedAmount,
          input.cashAmountMicros ?? 0,
          input.idempotencyKey,
          input.paymentReference ?? lotRow.payment_reference,
          input.sourceWebhookEventId ?? null,
          occurredAt.toISOString(),
        ],
      )
      return { lotId: String(lotRow.lot_id) }
    })
  }

  async creditBalance(scopeInput: BillingScope): Promise<CreditBalance> {
    const scope = billingScopeSchema.parse(scopeInput)
    return this.withScope(scope, async (client) => {
      const row = (
        await client.query<Record<string, unknown>>(
          `SELECT
            coalesce(max(e.ledger_sequence),0) AS watermark,
            coalesce(max(e.currency),'USD') AS currency,
            coalesce(sum(CASE
              WHEN e.entry_type IN ('purchase','promotional_grant','reservation_release') THEN e.credit_amount_micros
              WHEN e.entry_type='admin_adjustment' THEN e.credit_amount_micros
              WHEN e.entry_type IN ('reservation','refund','chargeback','expiration') THEN -e.credit_amount_micros
              ELSE 0 END),0) AS available,
            coalesce(sum(CASE WHEN e.entry_type='reservation' THEN e.credit_amount_micros
              WHEN e.entry_type IN ('reservation_release','usage_settlement') THEN -e.credit_amount_micros ELSE 0 END),0) AS reserved,
            coalesce(sum(CASE WHEN e.entry_type='usage_settlement' THEN e.credit_amount_micros ELSE 0 END),0) AS consumed,
            coalesce(sum(CASE WHEN l.lot_kind='paid' THEN CASE
              WHEN e.entry_type IN ('purchase','reservation_release') THEN e.credit_amount_micros
              WHEN e.entry_type='admin_adjustment' THEN e.credit_amount_micros
              WHEN e.entry_type IN ('reservation','refund','chargeback','expiration') THEN -e.credit_amount_micros ELSE 0 END ELSE 0 END),0) AS paid_available,
            coalesce(sum(CASE WHEN l.lot_kind='promotional' THEN CASE
              WHEN e.entry_type IN ('promotional_grant','reservation_release') THEN e.credit_amount_micros
              WHEN e.entry_type='admin_adjustment' THEN e.credit_amount_micros
              WHEN e.entry_type IN ('reservation','refund','chargeback','expiration') THEN -e.credit_amount_micros ELSE 0 END ELSE 0 END),0) AS promo_available,
            coalesce(sum(CASE WHEN l.lot_kind='paid' THEN CASE WHEN e.entry_type='reservation' THEN e.credit_amount_micros WHEN e.entry_type IN ('reservation_release','usage_settlement') THEN -e.credit_amount_micros ELSE 0 END ELSE 0 END),0) AS paid_reserved,
            coalesce(sum(CASE WHEN l.lot_kind='promotional' THEN CASE WHEN e.entry_type='reservation' THEN e.credit_amount_micros WHEN e.entry_type IN ('reservation_release','usage_settlement') THEN -e.credit_amount_micros ELSE 0 END ELSE 0 END),0) AS promo_reserved
           FROM persistent_codex.credit_ledger_entries e
           JOIN persistent_codex.credit_lots l USING(tenant_id,organization_id,workspace_id,lot_id)`,
        )
      ).rows[0]!
      return creditBalanceSchema.parse({
        schemaVersion: 1,
        ...scope,
        currency: row.currency,
        availableCreditsMicros: Number(row.available),
        reservedCreditsMicros: Math.max(0, Number(row.reserved)),
        consumedCreditsMicros: Number(row.consumed),
        paidAvailableCreditsMicros: Number(row.paid_available),
        promotionalAvailableCreditsMicros: Number(row.promo_available),
        paidReservedCreditsMicros: Math.max(0, Number(row.paid_reserved)),
        promotionalReservedCreditsMicros: Math.max(
          0,
          Number(row.promo_reserved),
        ),
        ledgerWatermark: `clw_${row.watermark}`,
        freshnessAt: new Date().toISOString(),
      })
    })
  }

  async reserveCredits(
    input: CreditReservationInput,
  ): Promise<CreditReservation> {
    const scope = billingScopeSchema.parse(input)
    const occurredAt = input.occurredAt ?? new Date()
    return this.withScope(scope, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [
          JSON.stringify([
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            'prepaid-credit',
          ]),
        ],
      )
      const existing = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.credit_reservations WHERE idempotency_key=$1`,
          [input.idempotencyKey],
        )
      ).rows[0]
      if (existing) return this.#parseReservation(scope, existing)
      const catalogRow = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.retail_price_catalogs
           WHERE effective_at<=$1 AND (retired_at IS NULL OR retired_at>$1)
           ORDER BY effective_at DESC,catalog_version DESC LIMIT 1`,
          [occurredAt.toISOString()],
        )
      ).rows[0]
      if (!catalogRow)
        throw new PrepaidCreditError('RETAIL_PRICE_CATALOG_MISSING')
      const maximums = catalogRow.operation_maximums as Array<{
        operation: string
        maximumCreditsMicros: number
      }>
      const maximum =
        input.maximumCreditsMicros ??
        maximums.find((value) => value.operation === input.operation)
          ?.maximumCreditsMicros
      if (!maximum || maximum <= 0)
        throw new PrepaidCreditError('RETAIL_PRICE_CATALOG_MISSING')
      const aggregateAvailable = Number(
        (
          await client.query<{ available: string }>(
            `SELECT coalesce(sum(CASE
              WHEN entry_type IN ('purchase','promotional_grant','reservation_release') THEN credit_amount_micros
              WHEN entry_type='admin_adjustment' THEN credit_amount_micros
              WHEN entry_type IN ('reservation','refund','chargeback','expiration') THEN -credit_amount_micros
              ELSE 0 END),0) AS available
             FROM persistent_codex.credit_ledger_entries`,
          )
        ).rows[0]!.available,
      )
      if (aggregateAvailable < maximum)
        throw new PrepaidCreditError(
          aggregateAvailable < 0
            ? 'NEGATIVE_BALANCE_FORBIDDEN'
            : 'CREDIT_INSUFFICIENT',
        )
      const lots = (
        await client.query<Record<string, unknown>>(
          `SELECT l.*,
             coalesce(sum(CASE
               WHEN e.entry_type IN ('purchase','promotional_grant','reservation_release') THEN e.credit_amount_micros
               WHEN e.entry_type='admin_adjustment' THEN e.credit_amount_micros
               WHEN e.entry_type IN ('reservation','refund','chargeback','expiration') THEN -e.credit_amount_micros
               ELSE 0 END),0) AS available
           FROM persistent_codex.credit_lots l
           LEFT JOIN persistent_codex.credit_ledger_entries e
             USING(tenant_id,organization_id,workspace_id,lot_id)
           WHERE (l.expires_at IS NULL OR l.expires_at>$1)
           GROUP BY l.tenant_id,l.organization_id,l.workspace_id,l.lot_id
           HAVING coalesce(sum(CASE
             WHEN e.entry_type IN ('purchase','promotional_grant','reservation_release') THEN e.credit_amount_micros
             WHEN e.entry_type='admin_adjustment' THEN e.credit_amount_micros
             WHEN e.entry_type IN ('reservation','refund','chargeback','expiration') THEN -e.credit_amount_micros
             ELSE 0 END),0)>0
           ORDER BY CASE WHEN l.lot_kind='promotional' THEN 0 ELSE 1 END,
             l.expires_at NULLS LAST,l.occurred_at,l.lot_id`,
          [occurredAt.toISOString()],
        )
      ).rows
      const currency = String(catalogRow.currency)
      let remaining = maximum
      const allocations: Array<{ lotId: string; amount: number }> = []
      for (const lot of lots) {
        if (lot.currency !== currency) continue
        const amount = Math.min(remaining, Number(lot.available))
        if (amount <= 0) continue
        allocations.push({ lotId: String(lot.lot_id), amount })
        remaining -= amount
        if (remaining === 0) break
      }
      if (remaining > 0) throw new PrepaidCreditError('CREDIT_INSUFFICIENT')
      const reservationId = deterministicId(
        'cres',
        scope.tenantId,
        scope.workspaceId,
        input.idempotencyKey,
      )
      await client.query(
        `INSERT INTO persistent_codex.credit_reservations
          (tenant_id,organization_id,workspace_id,reservation_id,currency,idempotency_key,operation,retail_price_catalog_version,maximum_credits_micros,state,version,payment_reference,usage_dedupe_key,run_id,operation_reference,occurred_at,resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved',1,NULL,NULL,$10,$11,$12,NULL)`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          reservationId,
          currency,
          input.idempotencyKey,
          input.operation,
          catalogRow.catalog_version,
          maximum,
          input.runId ?? null,
          input.operationReference ?? null,
          occurredAt.toISOString(),
        ],
      )
      for (const [index, allocation] of allocations.entries()) {
        await client.query(
          `INSERT INTO persistent_codex.credit_reservation_allocations
            (tenant_id,organization_id,workspace_id,reservation_id,lot_id,allocation_order,reserved_credits_micros)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            reservationId,
            allocation.lotId,
            index + 1,
            allocation.amount,
          ],
        )
        await client.query(
          `INSERT INTO persistent_codex.credit_ledger_entries
            (tenant_id,organization_id,workspace_id,ledger_entry_id,lot_id,entry_type,currency,credit_amount_micros,cash_amount_micros,idempotency_key,payment_reference,usage_dedupe_key,run_id,operation_reference,reservation_id,settlement_id,source_webhook_event_id,occurred_at)
           VALUES ($1,$2,$3,$4,$5,'reservation',$6,$7,0,$8,NULL,NULL,$9,$10,$11,NULL,NULL,$12)`,
          [
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            deterministicId('cle', input.idempotencyKey, allocation.lotId),
            allocation.lotId,
            currency,
            allocation.amount,
            `${input.idempotencyKey}:lot:${allocation.lotId}`,
            input.runId ?? null,
            input.operationReference ?? null,
            reservationId,
            occurredAt.toISOString(),
          ],
        )
      }
      const row = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.credit_reservations WHERE reservation_id=$1`,
          [reservationId],
        )
      ).rows[0]!
      return this.#parseReservation(scope, row)
    })
  }

  async settleCredits(input: CreditSettlementInput): Promise<CreditSettlement> {
    const scope = billingScopeSchema.parse(input)
    const occurredAt = input.occurredAt ?? new Date()
    return this.withScope(scope, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [
          JSON.stringify([
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            input.reservationId,
          ]),
        ],
      )
      const existing = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.credit_settlements
           WHERE idempotency_key=$1 OR usage_dedupe_key=$2 LIMIT 1`,
          [input.idempotencyKey, input.usageDedupeKey],
        )
      ).rows[0]
      if (existing) return this.#parseSettlement(scope, existing)
      const reservation = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.credit_reservations
           WHERE reservation_id=$1 FOR UPDATE`,
          [input.reservationId],
        )
      ).rows[0]
      if (!reservation) throw new PrepaidCreditError('RESERVATION_NOT_FOUND')
      const unresolved =
        Number(reservation.maximum_credits_micros) -
        Number(reservation.settled_credits_micros) -
        Number(reservation.released_credits_micros)
      if (input.measuredCreditsMicros > unresolved)
        throw new PrepaidCreditError('SETTLEMENT_EXCEEDS_RESERVATION')
      const release = input.terminal
        ? unresolved - input.measuredCreditsMicros
        : 0
      const settlementId = deterministicId(
        'cset',
        scope.tenantId,
        scope.workspaceId,
        input.usageDedupeKey,
      )
      await client.query(
        `INSERT INTO persistent_codex.credit_settlements
          (tenant_id,organization_id,workspace_id,settlement_id,reservation_id,currency,idempotency_key,retail_price_catalog_version,measured_credits_micros,released_credits_micros,usage_status,outcome,terminal,payment_reference,usage_dedupe_key,run_id,operation_reference,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14,$15,$16,$17)`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          settlementId,
          input.reservationId,
          reservation.currency,
          input.idempotencyKey,
          reservation.retail_price_catalog_version,
          input.measuredCreditsMicros,
          release,
          input.usageStatus,
          input.outcome,
          input.terminal,
          input.usageDedupeKey,
          input.runId ?? reservation.run_id,
          reservation.operation_reference,
          occurredAt.toISOString(),
        ],
      )
      const allocations = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.credit_reservation_allocations
           WHERE reservation_id=$1 ORDER BY allocation_order FOR UPDATE`,
          [input.reservationId],
        )
      ).rows
      let measuredRemaining = input.measuredCreditsMicros
      let releaseRemaining = release
      for (const allocation of allocations) {
        const allocationRemaining =
          Number(allocation.reserved_credits_micros) -
          Number(allocation.settled_credits_micros) -
          Number(allocation.released_credits_micros)
        const measured = Math.min(measuredRemaining, allocationRemaining)
        const released = Math.min(
          releaseRemaining,
          allocationRemaining - measured,
        )
        measuredRemaining -= measured
        releaseRemaining -= released
        if (measured > 0)
          await client.query(
            `INSERT INTO persistent_codex.credit_ledger_entries
              (tenant_id,organization_id,workspace_id,ledger_entry_id,lot_id,entry_type,currency,credit_amount_micros,cash_amount_micros,idempotency_key,payment_reference,usage_dedupe_key,run_id,operation_reference,reservation_id,settlement_id,source_webhook_event_id,occurred_at)
             VALUES ($1,$2,$3,$4,$5,'usage_settlement',$6,$7,0,$8,NULL,$9,$10,$11,$12,$13,NULL,$14)`,
            [
              scope.tenantId,
              scope.organizationId,
              scope.workspaceId,
              deterministicId(
                'cle',
                input.idempotencyKey,
                allocation.lot_id,
                'settle',
              ),
              allocation.lot_id,
              reservation.currency,
              measured,
              `${input.idempotencyKey}:settle:${allocation.lot_id}`,
              input.usageDedupeKey,
              input.runId ?? reservation.run_id,
              reservation.operation_reference,
              input.reservationId,
              settlementId,
              occurredAt.toISOString(),
            ],
          )
        if (released > 0)
          await client.query(
            `INSERT INTO persistent_codex.credit_ledger_entries
              (tenant_id,organization_id,workspace_id,ledger_entry_id,lot_id,entry_type,currency,credit_amount_micros,cash_amount_micros,idempotency_key,payment_reference,usage_dedupe_key,run_id,operation_reference,reservation_id,settlement_id,source_webhook_event_id,occurred_at)
             VALUES ($1,$2,$3,$4,$5,'reservation_release',$6,$7,0,$8,NULL,$9,$10,$11,$12,$13,NULL,$14)`,
            [
              scope.tenantId,
              scope.organizationId,
              scope.workspaceId,
              deterministicId(
                'cle',
                input.idempotencyKey,
                allocation.lot_id,
                'release',
              ),
              allocation.lot_id,
              reservation.currency,
              released,
              `${input.idempotencyKey}:release:${allocation.lot_id}`,
              input.usageDedupeKey,
              input.runId ?? reservation.run_id,
              reservation.operation_reference,
              input.reservationId,
              settlementId,
              occurredAt.toISOString(),
            ],
          )
        if (measured > 0 || released > 0)
          await client.query(
            `UPDATE persistent_codex.credit_reservation_allocations
             SET settled_credits_micros=settled_credits_micros+$3,
                 released_credits_micros=released_credits_micros+$4
             WHERE reservation_id=$1 AND lot_id=$2`,
            [input.reservationId, allocation.lot_id, measured, released],
          )
      }
      const nextSettled =
        Number(reservation.settled_credits_micros) + input.measuredCreditsMicros
      const nextReleased = Number(reservation.released_credits_micros) + release
      const nextUnresolved =
        Number(reservation.maximum_credits_micros) - nextSettled - nextReleased
      const state =
        nextUnresolved > 0
          ? nextSettled > 0
            ? 'partially_settled'
            : 'reserved'
          : nextSettled > 0
            ? 'settled'
            : 'released'
      const updated = await client.query(
        `UPDATE persistent_codex.credit_reservations
         SET settled_credits_micros=$2,released_credits_micros=$3,state=$4,
             version=version+1,usage_dedupe_key=coalesce(usage_dedupe_key,$5),
             run_id=coalesce(run_id,$6),resolved_at=CASE WHEN $7=0 THEN $8::timestamptz ELSE NULL END
         WHERE reservation_id=$1 AND version=$9`,
        [
          input.reservationId,
          nextSettled,
          nextReleased,
          state,
          input.usageDedupeKey,
          input.runId ?? null,
          nextUnresolved,
          occurredAt.toISOString(),
          Number(reservation.version),
        ],
      )
      if ((updated.rowCount ?? 0) !== 1)
        throw new PrepaidCreditError('SETTLEMENT_EXCEEDS_RESERVATION')
      const row = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.credit_settlements WHERE settlement_id=$1`,
          [settlementId],
        )
      ).rows[0]!
      return this.#parseSettlement(scope, row)
    })
  }

  async settleOperation(
    scopeInput: BillingScope,
    resourceId: string,
    input: Omit<CreditSettlementInput, keyof BillingScope | 'reservationId'>,
  ) {
    const scope = billingScopeSchema.parse(scopeInput)
    const reservationId = await this.withScope(scope, async (client) => {
      const row = (
        await client.query<{ reservation_id: string }>(
          `SELECT reservation_id FROM persistent_codex.credit_reservations
           WHERE run_id=$1 OR operation_reference=$1
           ORDER BY occurred_at DESC LIMIT 1`,
          [resourceId],
        )
      ).rows[0]
      return row?.reservation_id ?? null
    })
    if (!reservationId) throw new PrepaidCreditError('RESERVATION_NOT_FOUND')
    return this.settleCredits({ ...scope, ...input, reservationId })
  }

  async creditReservationForOperation(
    scopeInput: BillingScope,
    resourceId: string,
  ): Promise<CreditReservation | null> {
    const scope = billingScopeSchema.parse(scopeInput)
    return this.withScope(scope, async (client) => {
      const row = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.credit_reservations
           WHERE run_id=$1 OR operation_reference=$1
           ORDER BY occurred_at DESC LIMIT 1`,
          [resourceId],
        )
      ).rows[0]
      return row ? this.#parseReservation(scope, row) : null
    })
  }

  #parseReservation(
    scope: BillingScope,
    row: Record<string, unknown>,
  ): CreditReservation {
    const maximum = Number(row.maximum_credits_micros)
    const settled = Number(row.settled_credits_micros)
    const released = Number(row.released_credits_micros)
    return creditReservationSchema.parse({
      schemaVersion: 1,
      ...scope,
      reservationId: row.reservation_id,
      currency: row.currency,
      idempotencyKey: row.idempotency_key,
      operation: row.operation,
      retailPriceCatalogVersion: row.retail_price_catalog_version,
      maximumCreditsMicros: maximum,
      settledCreditsMicros: settled,
      releasedCreditsMicros: released,
      unresolvedCreditsMicros: maximum - settled - released,
      state: row.state,
      version: Number(row.version),
      paymentReference: row.payment_reference,
      usageDedupeKey: row.usage_dedupe_key,
      runId: row.run_id,
      operationReference: row.operation_reference,
      occurredAt: (row.occurred_at as Date).toISOString(),
      resolvedAt: row.resolved_at
        ? (row.resolved_at as Date).toISOString()
        : null,
    })
  }

  #parseSettlement(
    scope: BillingScope,
    row: Record<string, unknown>,
  ): CreditSettlement {
    return creditSettlementSchema.parse({
      schemaVersion: 1,
      ...scope,
      settlementId: row.settlement_id,
      reservationId: row.reservation_id,
      currency: row.currency,
      idempotencyKey: row.idempotency_key,
      retailPriceCatalogVersion: row.retail_price_catalog_version,
      measuredCreditsMicros: Number(row.measured_credits_micros),
      releasedCreditsMicros: Number(row.released_credits_micros),
      usageStatus: row.usage_status,
      outcome: row.outcome,
      terminal: row.terminal,
      paymentReference: row.payment_reference,
      usageDedupeKey: row.usage_dedupe_key,
      runId: row.run_id,
      operationReference: row.operation_reference,
      occurredAt: (row.occurred_at as Date).toISOString(),
    })
  }

  async creditAccount(scopeInput: BillingScope) {
    const scope = billingScopeSchema.parse(scopeInput)
    const [balance, details] = await Promise.all([
      this.creditBalance(scope),
      this.withScope(scope, async (client) => {
        const ledgerRows = (
          await client.query<Record<string, unknown>>(
            `SELECT * FROM persistent_codex.credit_ledger_entries
             ORDER BY ledger_sequence DESC LIMIT 100`,
          )
        ).rows
        const reservationRows = (
          await client.query<Record<string, unknown>>(
            `SELECT * FROM persistent_codex.credit_reservations
             ORDER BY occurred_at DESC,reservation_id DESC LIMIT 50`,
          )
        ).rows
        const settlementRows = (
          await client.query<Record<string, unknown>>(
            `SELECT * FROM persistent_codex.credit_settlements
             ORDER BY occurred_at DESC,settlement_id DESC LIMIT 50`,
          )
        ).rows
        return {
          ledger: ledgerRows.map((row) =>
            creditLedgerEntrySchema.parse({
              schemaVersion: 1,
              ...scope,
              ledgerEntryId: row.ledger_entry_id,
              ledgerSequence: Number(row.ledger_sequence),
              lotId: row.lot_id,
              entryType: row.entry_type,
              currency: row.currency,
              creditAmountMicros: Number(row.credit_amount_micros),
              cashAmountMicros: Number(row.cash_amount_micros),
              idempotencyKey: row.idempotency_key,
              paymentReference: row.payment_reference,
              usageDedupeKey: row.usage_dedupe_key,
              runId: row.run_id,
              operationReference: row.operation_reference,
              occurredAt: (row.occurred_at as Date).toISOString(),
              reservationId: row.reservation_id,
              settlementId: row.settlement_id,
              sourceWebhookEventId: row.source_webhook_event_id,
            }),
          ),
          reservations: reservationRows.map((row) =>
            this.#parseReservation(scope, row),
          ),
          settlements: settlementRows.map((row) =>
            this.#parseSettlement(scope, row),
          ),
        }
      }),
    ])
    return { balance, ...details }
  }

  async retailCreditsForUsage(
    scopeInput: BillingScope,
    quantities: Partial<Record<string, number>>,
  ) {
    const scope = billingScopeSchema.parse(scopeInput)
    return this.withScope(scope, async (client) => {
      const row = (
        await client.query<Record<string, unknown>>(
          `SELECT catalog_version,currency,rates FROM persistent_codex.retail_price_catalogs
           WHERE effective_at<=now() AND (retired_at IS NULL OR retired_at>now())
           ORDER BY effective_at DESC,catalog_version DESC LIMIT 1`,
        )
      ).rows[0]
      if (!row) throw new PrepaidCreditError('RETAIL_PRICE_CATALOG_MISSING')
      const rates = row.rates as Array<{
        meter: string
        creditsMicrosPerUnit: number
      }>
      return {
        catalogVersion: String(row.catalog_version),
        currency: String(row.currency),
        creditsMicros: rates.reduce(
          (total, rate) =>
            total +
            Math.max(0, quantities[rate.meter] ?? 0) *
              rate.creditsMicrosPerUnit,
          0,
        ),
      }
    })
  }

  async financialProjection(
    scopeInput: BillingScope,
  ): Promise<FinancialProjection> {
    const scope = billingScopeSchema.parse(scopeInput)
    const projectedAt = new Date()
    return this.withScope(scope, async (client) => {
      const catalog = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.retail_price_catalogs
           WHERE effective_at<=$1 AND (retired_at IS NULL OR retired_at>$1)
           ORDER BY effective_at DESC,catalog_version DESC LIMIT 1`,
          [projectedAt.toISOString()],
        )
      ).rows[0]
      if (!catalog) throw new PrepaidCreditError('RETAIL_PRICE_CATALOG_MISSING')
      const credit = (
        await client.query<Record<string, unknown>>(
          `SELECT coalesce(max(e.ledger_sequence),0) AS watermark,
            coalesce(sum(CASE WHEN e.entry_type='purchase' THEN e.cash_amount_micros
              WHEN e.entry_type IN ('refund','chargeback') THEN -e.cash_amount_micros ELSE 0 END),0) AS cash,
            coalesce(sum(CASE WHEN e.entry_type='refund' THEN e.cash_amount_micros ELSE 0 END),0) AS refunds,
            coalesce(sum(CASE WHEN e.entry_type='chargeback' THEN e.cash_amount_micros ELSE 0 END),0) AS chargebacks,
            coalesce(sum(CASE WHEN l.lot_kind='paid' THEN CASE
              WHEN e.entry_type='purchase' THEN e.credit_amount_micros
              WHEN e.entry_type='admin_adjustment' THEN e.credit_amount_micros
              WHEN e.entry_type IN ('usage_settlement','refund','chargeback','expiration') THEN -e.credit_amount_micros ELSE 0 END ELSE 0 END),0) AS liability,
            coalesce(sum(CASE WHEN l.lot_kind='paid' AND e.entry_type='usage_settlement' THEN e.credit_amount_micros ELSE 0 END),0) AS paid_revenue,
            coalesce(sum(CASE WHEN l.lot_kind='promotional' AND e.entry_type='usage_settlement' THEN e.credit_amount_micros ELSE 0 END),0) AS promo_consumption
           FROM persistent_codex.credit_ledger_entries e
           JOIN persistent_codex.credit_lots l USING(tenant_id,organization_id,workspace_id,lot_id)`,
        )
      ).rows[0]!
      const costs = (
        await client.query<Record<string, unknown>>(
          `SELECT
            coalesce(sum(CASE WHEN meter IN ('provider_input_token','provider_cached_input_token','provider_output_token','provider_reasoning_token','provider_reported_cost_micros')
              THEN coalesce(official_cost_micros,estimated_cost_micros,0) ELSE 0 END),0) AS provider_cogs,
            coalesce(sum(CASE WHEN meter IN ('compute_millisecond','storage_byte_millisecond','egress_byte','index_embedding_token','retrieval_embedding_token')
              THEN coalesce(official_cost_micros,estimated_cost_micros,0) ELSE 0 END),0) AS infrastructure_cogs
           FROM persistent_codex.usage_ledger`,
        )
      ).rows[0]!
      const watermark = `clw_${credit.watermark}`
      const projectionId = deterministicId(
        'fprj',
        scope.tenantId,
        scope.workspaceId,
        watermark,
        catalog.catalog_version,
      )
      const paidRevenue = Number(credit.paid_revenue)
      const providerCogs = Number(costs.provider_cogs)
      const infrastructureCogs = Number(costs.infrastructure_cogs)
      const value = financialProjectionSchema.parse({
        schemaVersion: 1,
        ...scope,
        projectionId,
        currency: catalog.currency,
        retailPriceCatalogVersion: catalog.catalog_version,
        ledgerWatermark: watermark,
        idempotencyKey: `projection:${watermark}:${catalog.catalog_version}`,
        paymentReference: null,
        usageDedupeKey: null,
        runId: null,
        operationReference: null,
        occurredAt: projectedAt.toISOString(),
        cashCollectedMicros: Number(credit.cash),
        outstandingPaidCreditLiabilityMicros: Number(credit.liability),
        consumedPaidCreditRevenueMicros: paidRevenue,
        promotionalConsumptionMicros: Number(credit.promo_consumption),
        refundsMicros: Number(credit.refunds),
        chargebacksMicros: Number(credit.chargebacks),
        providerCogsMicros: providerCogs,
        infrastructureCogsMicros: infrastructureCogs,
        grossMarginMicros: paidRevenue - providerCogs - infrastructureCogs,
        projectedAt: projectedAt.toISOString(),
        accountingStatus: 'operational_projection_not_tax_advice',
      })
      await client.query(
        `INSERT INTO persistent_codex.financial_projection_checkpoints
          (tenant_id,organization_id,workspace_id,projection_id,currency,retail_price_catalog_version,ledger_watermark,idempotency_key,payment_reference,usage_dedupe_key,run_id,operation_reference,occurred_at,cash_collected_micros,outstanding_paid_credit_liability_micros,consumed_paid_credit_revenue_micros,promotional_consumption_micros,refunds_micros,chargebacks_micros,provider_cogs_micros,infrastructure_cogs_micros,gross_margin_micros,projected_at,accounting_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,NULL,NULL,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (tenant_id,organization_id,workspace_id,ledger_watermark,retail_price_catalog_version) DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          value.projectionId,
          value.currency,
          value.retailPriceCatalogVersion,
          value.ledgerWatermark,
          value.idempotencyKey,
          value.occurredAt,
          value.cashCollectedMicros,
          value.outstandingPaidCreditLiabilityMicros,
          value.consumedPaidCreditRevenueMicros,
          value.promotionalConsumptionMicros,
          value.refundsMicros,
          value.chargebacksMicros,
          value.providerCogsMicros,
          value.infrastructureCogsMicros,
          value.grossMarginMicros,
          value.projectedAt,
          value.accountingStatus,
        ],
      )
      return value
    })
  }

  async recordWebhook(
    eventInput: BillingWebhookEvent,
    command: NormalizedBillingWebhookCommand = { kind: 'unknown' },
  ) {
    const event = billingWebhookEventSchema.parse(eventInput)
    return this.withScope(event, async (client) => {
      const result = await client.query<{
        processing_state: BillingWebhookEvent['processingState']
        payload_digest: string
        effective_at: Date
        duplicate: boolean
      }>(
        `INSERT INTO persistent_codex.billing_webhook_events
          (tenant_id,organization_id,workspace_id,webhook_event_id,provider,signature_version,event_type,provider_sequence,payload_digest,received_at,effective_at,processing_state,attempt,normalized_command)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
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
          JSON.stringify(command),
        ],
      )
      const row = result.rows[0]!
      if (row.payload_digest !== event.payloadDigest)
        throw new BillingWebhookError(
          'EVENT_CONFLICT',
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
    scopeInput: BillingScope,
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
    scopeInput: BillingScope,
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

  async seedDevelopmentScope(scopeInput: BillingScope) {
    if (!this.#developmentSeed)
      throw new Error('DEVELOPMENT_BILLING_SEED_NOT_CONFIGURED')
    const scope = billingScopeSchema.parse(scopeInput)
    const seed = this.#developmentSeed
    await this.withScope(scope, async (client) => {
      await client.query(
        `INSERT INTO persistent_codex.organizations(organization_id,name,status)
         VALUES ($1,'Local billing organization','active') ON CONFLICT DO NOTHING`,
        [scope.organizationId],
      )
      await client.query(
        `INSERT INTO persistent_codex.workspaces(tenant_id,organization_id,workspace_id,name)
         VALUES ($1,$2,$3,'Local billing workspace') ON CONFLICT DO NOTHING`,
        [scope.tenantId, scope.organizationId, scope.workspaceId],
      )
      const plan = commercialPlanSchema.parse({ ...seed.plan, ...scope })
      await client.query(
        `INSERT INTO persistent_codex.commercial_plans
          (tenant_id,organization_id,workspace_id,plan_id,plan_version,display_name,currency,billing_mode,tax_behavior,effective_at,retired_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          plan.planId,
          plan.planVersion,
          plan.displayName,
          plan.currency,
          plan.billingMode,
          plan.taxBehavior,
          plan.effectiveAt,
          plan.retiredAt,
        ],
      )
      for (const input of seed.entitlements) {
        const value = entitlementSchema.parse({ ...input, ...scope })
        await client.query(
          `INSERT INTO persistent_codex.entitlements
            (tenant_id,organization_id,workspace_id,entitlement_id,plan_id,plan_version,entitlement_key,enabled,effective_at,expires_at,source_webhook_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
          [
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            value.entitlementId,
            value.planId,
            value.planVersion,
            value.key,
            value.enabled,
            value.effectiveAt,
            value.expiresAt,
            value.sourceWebhookEventId,
          ],
        )
      }
      for (const input of seed.budgets) {
        const value = budgetSchema.parse({ ...input, ...scope })
        await client.query(
          `INSERT INTO persistent_codex.budgets
            (tenant_id,organization_id,workspace_id,budget_id,period,currency,soft_limit_micros,hard_limit_micros,effective_at,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            value.budgetId,
            value.period,
            value.currency,
            value.softLimitMicros,
            value.hardLimitMicros,
            value.effectiveAt,
            value.expiresAt,
          ],
        )
      }
      for (const input of seed.quotas) {
        const value = quotaPolicySchema.parse({ ...input, ...scope })
        await client.query(
          `INSERT INTO persistent_codex.quota_policies
            (tenant_id,organization_id,workspace_id,quota_id,policy_version,meter,soft_limit,hard_limit,in_flight_policy,effective_at,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
          [
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            value.quotaId,
            value.policyVersion,
            value.meter,
            value.softLimit,
            value.hardLimit,
            value.inFlightPolicy,
            value.effectiveAt,
            value.expiresAt,
          ],
        )
      }
      if (seed.retailPriceCatalog) {
        const catalog = retailPriceCatalogSchema.parse({
          ...seed.retailPriceCatalog,
          ...scope,
        })
        await client.query(
          `INSERT INTO persistent_codex.retail_price_catalogs
            (tenant_id,organization_id,workspace_id,catalog_id,catalog_version,currency,rates,operation_maximums,idempotency_key,payment_reference,usage_dedupe_key,run_id,operation_reference,occurred_at,effective_at,retired_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT DO NOTHING`,
          [
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            catalog.catalogId,
            catalog.catalogVersion,
            catalog.currency,
            JSON.stringify(catalog.rates),
            JSON.stringify(catalog.operationMaximums),
            catalog.idempotencyKey,
            catalog.paymentReference,
            catalog.usageDedupeKey,
            catalog.runId,
            catalog.operationReference,
            catalog.occurredAt,
            catalog.effectiveAt,
            catalog.retiredAt,
          ],
        )
      }
    })
    if (seed.initialPromotionalCreditsMicros !== undefined)
      await this.seedDevelopmentCredits(
        scope,
        seed.initialPromotionalCreditsMicros,
      )
  }

  private async seedDevelopmentCredits(
    scopeInput: BillingScope,
    creditsMicros: number,
  ) {
    const scope = billingScopeSchema.parse(scopeInput)
    if (!Number.isSafeInteger(creditsMicros) || creditsMicros <= 0)
      throw new Error('DEVELOPMENT_CREDIT_SEED_INVALID')
    const amount = creditsMicros
    const idempotencyKey = 'development-seed:promotional-credit-v1'
    const lotId = deterministicId(
      'clt',
      scope.tenantId,
      scope.organizationId,
      scope.workspaceId,
      idempotencyKey,
    )
    const occurredAt = this.#developmentSeed!.plan.effectiveAt
    const currency = this.#developmentSeed!.plan.currency
    await this.withScope(scope, async (client) => {
      await client.query(
        `INSERT INTO persistent_codex.credit_lots
          (tenant_id,organization_id,workspace_id,lot_id,lot_kind,currency,original_credits_micros,original_cash_micros,idempotency_key,payment_reference,usage_dedupe_key,run_id,operation_reference,occurred_at,expires_at,source_webhook_event_id,consumption_policy_version)
         VALUES ($1,$2,$3,$4,'promotional',$5,$6,0,$7,NULL,NULL,NULL,'development-seed',$8,NULL,NULL,1)
         ON CONFLICT DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          lotId,
          currency,
          amount,
          idempotencyKey,
          occurredAt,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.credit_ledger_entries
          (tenant_id,organization_id,workspace_id,ledger_entry_id,lot_id,entry_type,currency,credit_amount_micros,cash_amount_micros,idempotency_key,payment_reference,usage_dedupe_key,run_id,operation_reference,reservation_id,settlement_id,source_webhook_event_id,occurred_at)
         VALUES ($1,$2,$3,$4,$5,'promotional_grant',$6,$7,0,$8,NULL,NULL,NULL,'development-seed',NULL,NULL,NULL,$9)
         ON CONFLICT DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          deterministicId('cle', lotId, idempotencyKey),
          lotId,
          currency,
          amount,
          idempotencyKey,
          occurredAt,
        ],
      )
    })
  }

  async snapshot(scopeInput: BillingScope): Promise<CommercialPolicySnapshot> {
    const scope = billingScopeSchema.parse(scopeInput)
    const load = () =>
      this.withScope(scope, async (client) => {
        const planRow = (
          await client.query<Record<string, unknown>>(
            `SELECT * FROM persistent_codex.commercial_plans
             WHERE effective_at<=now() AND (retired_at IS NULL OR retired_at>now())
             ORDER BY plan_version DESC,effective_at DESC LIMIT 1`,
          )
        ).rows[0]
        if (!planRow) return null
        const plan = commercialPlanSchema.parse({
          schemaVersion: 1,
          ...scope,
          planId: planRow.plan_id,
          planVersion: Number(planRow.plan_version),
          displayName: planRow.display_name,
          currency: planRow.currency,
          billingMode: planRow.billing_mode,
          taxBehavior: planRow.tax_behavior,
          effectiveAt: (planRow.effective_at as Date).toISOString(),
          retiredAt: planRow.retired_at
            ? (planRow.retired_at as Date).toISOString()
            : null,
        })
        const entitlementRows = (
          await client.query<Record<string, unknown>>(
            `SELECT * FROM persistent_codex.entitlements
             WHERE plan_id=$1 AND plan_version=$2 AND effective_at<=now()
               AND (expires_at IS NULL OR expires_at>now()) ORDER BY entitlement_key`,
            [plan.planId, plan.planVersion],
          )
        ).rows
        const budgetRows = (
          await client.query<Record<string, unknown>>(
            `SELECT * FROM persistent_codex.budgets WHERE effective_at<=now()
             AND (expires_at IS NULL OR expires_at>now()) ORDER BY budget_id`,
          )
        ).rows
        const quotaRows = (
          await client.query<Record<string, unknown>>(
            `SELECT DISTINCT ON (quota_id) * FROM persistent_codex.quota_policies
             WHERE effective_at<=now() AND (expires_at IS NULL OR expires_at>now())
             ORDER BY quota_id,policy_version DESC`,
          )
        ).rows
        return {
          plan,
          entitlements: entitlementRows.map((row) =>
            entitlementSchema.parse({
              schemaVersion: 1,
              ...scope,
              entitlementId: row.entitlement_id,
              planId: row.plan_id,
              planVersion: Number(row.plan_version),
              key: row.entitlement_key,
              enabled: row.enabled,
              effectiveAt: (row.effective_at as Date).toISOString(),
              expiresAt: row.expires_at
                ? (row.expires_at as Date).toISOString()
                : null,
              sourceWebhookEventId: row.source_webhook_event_id,
            }),
          ),
          budgets: budgetRows.map((row) =>
            budgetSchema.parse({
              schemaVersion: 1,
              ...scope,
              budgetId: row.budget_id,
              period: row.period,
              currency: row.currency,
              softLimitMicros:
                row.soft_limit_micros === null
                  ? null
                  : Number(row.soft_limit_micros),
              hardLimitMicros:
                row.hard_limit_micros === null
                  ? null
                  : Number(row.hard_limit_micros),
              effectiveAt: (row.effective_at as Date).toISOString(),
              expiresAt: row.expires_at
                ? (row.expires_at as Date).toISOString()
                : null,
            }),
          ),
          quotas: quotaRows.map((row) =>
            quotaPolicySchema.parse({
              schemaVersion: 1,
              ...scope,
              quotaId: row.quota_id,
              policyVersion: Number(row.policy_version),
              meter: row.meter,
              softLimit:
                row.soft_limit === null ? null : Number(row.soft_limit),
              hardLimit:
                row.hard_limit === null ? null : Number(row.hard_limit),
              inFlightPolicy: row.in_flight_policy,
              effectiveAt: (row.effective_at as Date).toISOString(),
              expiresAt: row.expires_at
                ? (row.expires_at as Date).toISOString()
                : null,
            }),
          ),
        }
      })
    let value = await load()
    if (this.#developmentSeed) {
      if (!value) await this.seedDevelopmentScope(scope)
      else if (this.#developmentSeed.initialPromotionalCreditsMicros)
        await this.seedDevelopmentCredits(
          scope,
          this.#developmentSeed.initialPromotionalCreditsMicros,
        )
      value = await load()
    }
    if (!value) throw new Error('BILLING_POLICY_MISSING')
    return value
  }

  async measurements(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    sessionId?: string
    operation: AdmissionRequest['operation']
    requestedBytes?: number
  }) {
    const scope = billingScopeSchema.parse(input)
    return this.withScope(scope, async (client) => {
      const row = (
        await client.query<Record<string, unknown>>(
          `SELECT
             (SELECT count(*) FROM persistent_codex.commercial_admission_leases
               WHERE operation='turn.start' AND released_at IS NULL) AS tenant_turns,
             (SELECT count(*) FROM persistent_codex.commercial_admission_leases
               WHERE operation='turn.start' AND released_at IS NULL AND session_id=$1) AS session_turns,
             (SELECT coalesce(sum(coalesce(official_cost_micros,estimated_cost_micros,0)),0)
               FROM persistent_codex.usage_ledger) AS provider_spend,
             (SELECT count(*) FROM persistent_codex.sources WHERE status<>'deleted') AS corpus_sources,
             (SELECT coalesce(sum(r.byte_length),0) FROM persistent_codex.source_revisions r
               JOIN persistent_codex.sources s USING(tenant_id,organization_id,workspace_id,source_id)
               WHERE s.status<>'deleted' AND r.revision_id=s.current_revision_id) AS corpus_bytes,
             (SELECT count(*) FROM persistent_codex.corpus_chunks c
               JOIN persistent_codex.sources s USING(tenant_id,organization_id,workspace_id,source_id)
               WHERE s.status<>'deleted') AS corpus_chunks,
             (SELECT coalesce(max(ledger_id),0) FROM persistent_codex.usage_ledger) AS ledger_mark,
             (SELECT coalesce(max(updated_at),'epoch'::timestamptz) FROM persistent_codex.sources) AS corpus_mark,
             (SELECT coalesce(max(created_at),'epoch'::timestamptz) FROM persistent_codex.commercial_admission_leases) AS lease_mark`,
          [input.sessionId ?? null],
        )
      ).rows[0]!
      const corpusBytes = Number(row.corpus_bytes)
      const values: AdmissionRequest['measurements'] = {
        tenant_concurrent_turn: Number(row.tenant_turns),
        session_concurrent_turn: Number(row.session_turns),
        provider_spend_micros: Number(row.provider_spend),
        corpus_source: Number(row.corpus_sources),
        corpus_byte:
          corpusBytes +
          (input.operation === 'source.upload'
            ? (input.requestedBytes ?? 0)
            : 0),
        corpus_chunk: Number(row.corpus_chunks),
        storage_byte: corpusBytes,
      }
      const measuredAt = new Date().toISOString()
      return {
        values,
        watermark: `bwm_${createHash('sha256')
          .update(
            JSON.stringify([
              values,
              row.ledger_mark,
              row.corpus_mark,
              row.lease_mark,
            ]),
          )
          .digest('hex')
          .slice(0, 32)}`,
        measuredAt,
      }
    })
  }

  async recordDecision(decisionInput: AdmissionDecision) {
    const decision = admissionDecisionSchema.parse(decisionInput)
    return this.withScope(decision, async (client) => {
      const result = await client.query(
        `INSERT INTO persistent_codex.quota_decisions
          (tenant_id,organization_id,workspace_id,decision_id,operation,outcome,reason_code,policy_version,measurement_watermark,in_flight_policy,evaluated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING`,
        [
          decision.tenantId,
          decision.organizationId,
          decision.workspaceId,
          decision.decisionId,
          decision.operation,
          decision.outcome,
          decision.reason,
          decision.policyVersion,
          decision.measurementWatermark,
          decision.inFlightPolicy,
          decision.evaluatedAt,
        ],
      )
      void result
    })
  }

  async admit(input: DurableAdmissionInput): Promise<AdmissionDecision> {
    const scope = billingScopeSchema.parse(input)
    const evaluatedAt = input.evaluatedAt ?? new Date()
    const snapshot = await this.snapshot(scope)
    const decision = await this.withScope(scope, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [
          JSON.stringify([
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
          ]),
        ],
      )
      const existing = (
        await client.query<Record<string, unknown>>(
          `SELECT q.* FROM persistent_codex.commercial_admission_leases l
           JOIN persistent_codex.quota_decisions q USING(tenant_id,organization_id,workspace_id,decision_id)
           WHERE l.request_key=$1`,
          [input.requestKey],
        )
      ).rows[0]
      if (existing)
        return admissionDecisionSchema.parse({
          schemaVersion: 1,
          ...scope,
          decisionId: existing.decision_id,
          operation: existing.operation,
          outcome: existing.outcome,
          reason: existing.reason_code,
          policyVersion: Number(existing.policy_version),
          measurementWatermark: existing.measurement_watermark,
          evaluatedAt: (existing.evaluated_at as Date).toISOString(),
          inFlightPolicy: existing.in_flight_policy,
        })
      const row = (
        await client.query<Record<string, unknown>>(
          `SELECT
             (SELECT count(*) FROM persistent_codex.commercial_admission_leases
               WHERE operation='turn.start' AND released_at IS NULL) AS tenant_turns,
             (SELECT count(*) FROM persistent_codex.commercial_admission_leases
               WHERE operation='turn.start' AND released_at IS NULL AND session_id=$1) AS session_turns,
             (SELECT coalesce(sum(coalesce(official_cost_micros,estimated_cost_micros,0)),0)
               FROM persistent_codex.usage_ledger) AS provider_spend,
             (SELECT count(*) FROM persistent_codex.sources WHERE status<>'deleted') AS corpus_sources,
             (SELECT coalesce(sum(r.byte_length),0) FROM persistent_codex.source_revisions r
               JOIN persistent_codex.sources s USING(tenant_id,organization_id,workspace_id,source_id)
               WHERE s.status<>'deleted' AND r.revision_id=s.current_revision_id) AS corpus_bytes,
             (SELECT count(*) FROM persistent_codex.corpus_chunks c
               JOIN persistent_codex.sources s USING(tenant_id,organization_id,workspace_id,source_id)
               WHERE s.status<>'deleted') AS corpus_chunks,
             (SELECT coalesce(max(ledger_id),0) FROM persistent_codex.usage_ledger) AS ledger_mark,
             (SELECT coalesce(max(updated_at),'epoch'::timestamptz) FROM persistent_codex.sources) AS corpus_mark,
             (SELECT count(*) FROM persistent_codex.commercial_admission_leases WHERE released_at IS NULL) AS active_mark`,
          [input.sessionId ?? null],
        )
      ).rows[0]!
      const corpusBytes = Number(row.corpus_bytes)
      const values: AdmissionRequest['measurements'] = {
        tenant_concurrent_turn: Number(row.tenant_turns),
        session_concurrent_turn: Number(row.session_turns),
        provider_spend_micros: Number(row.provider_spend),
        corpus_source: Number(row.corpus_sources),
        corpus_byte:
          corpusBytes +
          (input.operation === 'source.upload'
            ? (input.requestedBytes ?? 0)
            : 0),
        corpus_chunk: Number(row.corpus_chunks),
        storage_byte: corpusBytes,
      }
      const watermark = `bwm_${createHash('sha256')
        .update(
          JSON.stringify([
            values,
            row.ledger_mark,
            row.corpus_mark,
            row.active_mark,
            input.requestKey,
          ]),
        )
        .digest('hex')
        .slice(0, 32)}`
      const decision = evaluateAdmission(
        {
          schemaVersion: 1,
          ...scope,
          operation: input.operation,
          measurements: values,
          measurementWatermark: watermark,
          evaluatedAt: evaluatedAt.toISOString(),
        },
        snapshot,
      )
      await client.query(
        `INSERT INTO persistent_codex.quota_decisions
          (tenant_id,organization_id,workspace_id,decision_id,operation,outcome,reason_code,policy_version,measurement_watermark,in_flight_policy,evaluated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          decision.decisionId,
          decision.operation,
          decision.outcome,
          decision.reason,
          decision.policyVersion,
          decision.measurementWatermark,
          decision.inFlightPolicy,
          decision.evaluatedAt,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.commercial_admission_leases
          (tenant_id,organization_id,workspace_id,request_key,decision_id,operation,session_id,reserved_count,reserved_bytes,created_at,released_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          input.requestKey,
          decision.decisionId,
          decision.operation,
          input.sessionId ?? null,
          input.operation === 'turn.start' ? 1 : 0,
          input.operation === 'source.upload' ? (input.requestedBytes ?? 0) : 0,
          decision.evaluatedAt,
          decision.outcome === 'deny' ? decision.evaluatedAt : null,
        ],
      )
      return decision
    })
    if (decision.outcome === 'deny') return decision
    try {
      await this.reserveCredits({
        ...scope,
        operation: input.operation,
        idempotencyKey: `admission:${input.requestKey}`,
        operationReference: input.requestKey,
        occurredAt: evaluatedAt,
      })
      return decision
    } catch (error) {
      if (!(error instanceof PrepaidCreditError)) throw error
      if (
        error.code !== 'CREDIT_INSUFFICIENT' &&
        error.code !== 'NEGATIVE_BALANCE_FORBIDDEN'
      )
        throw error
      await this.cancelDecision(scope, decision.decisionId)
      const denied = admissionDecisionSchema.parse({
        ...decision,
        decisionId: deterministicId(
          'qad',
          decision.decisionId,
          'credit-insufficient',
        ),
        outcome: 'deny',
        reason: 'HARD_LIMIT_PREPAID_CREDIT',
        measurementWatermark: `${decision.measurementWatermark}:credit`,
      })
      await this.recordDecision(denied)
      return denied
    }
  }

  async bindDecision(
    scopeInput: BillingScope,
    decisionId: string,
    resourceId: string,
  ) {
    return this.withScope(scopeInput, async (client) => {
      const result = await client.query(
        `UPDATE persistent_codex.commercial_admission_leases
         SET resource_id=coalesce(resource_id,$2)
         WHERE decision_id=$1 AND (resource_id IS NULL OR resource_id=$2)`,
        [decisionId, resourceId],
      )
      await client.query(
        `UPDATE persistent_codex.credit_reservations r
         SET run_id=coalesce(r.run_id,$2),operation_reference=coalesce(r.operation_reference,$2)
         FROM persistent_codex.commercial_admission_leases l
         WHERE l.decision_id=$1 AND r.idempotency_key='admission:' || l.request_key`,
        [decisionId, resourceId],
      )
      return result
    })
  }

  async completeOperation(scopeInput: BillingScope, resourceId: string) {
    return this.withScope(scopeInput, async (client) =>
      client.query(
        `UPDATE persistent_codex.commercial_admission_leases
         SET released_at=coalesce(released_at,now())
         WHERE resource_id=$1`,
        [resourceId],
      ),
    )
  }

  async cancelDecision(scopeInput: BillingScope, decisionId: string) {
    const scope = billingScopeSchema.parse(scopeInput)
    const value = await this.withScope(scope, async (client) => {
      const reservation = (
        await client.query<{ reservation_id: string }>(
          `SELECT r.reservation_id FROM persistent_codex.credit_reservations r
           JOIN persistent_codex.commercial_admission_leases l
             ON r.idempotency_key='admission:' || l.request_key
           WHERE l.decision_id=$1`,
          [decisionId],
        )
      ).rows[0]
      const result = await client.query(
        `UPDATE persistent_codex.commercial_admission_leases
         SET released_at=coalesce(released_at,now()) WHERE decision_id=$1`,
        [decisionId],
      )
      return { result, reservationId: reservation?.reservation_id ?? null }
    })
    if (value.reservationId)
      await this.settleCredits({
        ...scope,
        reservationId: value.reservationId,
        idempotencyKey: `cancel:${decisionId}`,
        usageDedupeKey: `cancel:${decisionId}`,
        measuredCreditsMicros: 0,
        usageStatus: 'measured',
        outcome: 'failed',
        terminal: true,
      })
    return value.result
  }

  async latestDecision(scopeInput: BillingScope) {
    const scope = billingScopeSchema.parse(scopeInput)
    return this.withScope(scope, async (client) => {
      const row = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.quota_decisions
           ORDER BY evaluated_at DESC,decision_id DESC LIMIT 1`,
        )
      ).rows[0]
      return row
        ? admissionDecisionSchema.parse({
            schemaVersion: 1,
            ...scope,
            decisionId: row.decision_id,
            operation: row.operation,
            outcome: row.outcome,
            reason: row.reason_code,
            policyVersion: Number(row.policy_version),
            measurementWatermark: row.measurement_watermark,
            evaluatedAt: (row.evaluated_at as Date).toISOString(),
            inFlightPolicy: row.in_flight_policy,
          })
        : null
    })
  }

  async subscription(scopeInput: BillingScope) {
    const scope = billingScopeSchema.parse(scopeInput)
    return this.withScope(scope, async (client) => {
      const row = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.billing_subscriptions
           ORDER BY provider_sequence DESC,effective_at DESC LIMIT 1`,
        )
      ).rows[0]
      return row
        ? subscriptionStateSchema.parse({
            schemaVersion: 1,
            ...scope,
            subscriptionId: row.subscription_id,
            billingCustomerId: row.billing_customer_id,
            planId: row.plan_id,
            planVersion: Number(row.plan_version),
            state: row.state,
            provider: row.provider,
            providerSequence: Number(row.provider_sequence),
            effectiveAt: (row.effective_at as Date).toISOString(),
            updatedAt: (row.updated_at as Date).toISOString(),
            sourceWebhookEventId: row.source_webhook_event_id,
          })
        : null
    })
  }

  async lastReconciledAt(scopeInput: BillingScope) {
    return this.withScope(scopeInput, async (client) => {
      const row = (
        await client.query<{ reconciled_at: Date | null }>(
          `SELECT reconciled_at FROM persistent_codex.invoice_reconciliations
           WHERE reconciled_at IS NOT NULL ORDER BY reconciled_at DESC LIMIT 1`,
        )
      ).rows[0]
      return row?.reconciled_at?.toISOString() ?? null
    })
  }

  async drainWebhooks(now = new Date(), limit = 25, maxAttempts = 5) {
    await this.recoverStale(now)
    const claims = (
      await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM persistent_codex.billing_claim_webhooks($1,$2)`,
        [now.toISOString(), limit],
      )
    ).rows
    const results: Array<{ eventId: string; state: string }> = []
    for (const claim of claims) {
      const scope = billingScopeSchema.parse({
        tenantId: claim.tenant_id,
        organizationId: claim.organization_id,
        workspaceId: claim.workspace_id,
      })
      const eventId = String(claim.webhook_event_id)
      try {
        const command = claim.normalized_command as
          NormalizedBillingWebhookCommand | undefined
        if (!command || command.kind === 'unknown') {
          await this.withScope(scope, (client) =>
            client.query(
              `UPDATE persistent_codex.billing_webhook_events
               SET processing_state='unknown',last_error_code=NULL,updated_at=$2
               WHERE webhook_event_id=$1`,
              [eventId, now.toISOString()],
            ),
          )
          results.push({ eventId, state: 'unknown' })
          continue
        }
        if (command.kind === 'credit.purchase') {
          await this.createCreditLot({
            ...scope,
            kind: 'paid',
            currency: command.data.currency,
            creditsMicros: command.data.creditsMicros,
            cashAmountMicros: command.data.cashAmountMicros,
            idempotencyKey: `webhook:${claim.provider}:${eventId}:purchase`,
            paymentReference: command.data.paymentReference,
            sourceWebhookEventId: eventId,
            occurredAt: claim.effective_at as Date,
            expiresAt: command.data.expiresAt
              ? new Date(command.data.expiresAt)
              : null,
          })
          await this.withScope(scope, (client) =>
            client.query(
              `UPDATE persistent_codex.billing_webhook_events
               SET processing_state='processed',last_error_code=NULL,updated_at=$2
               WHERE webhook_event_id=$1`,
              [eventId, now.toISOString()],
            ),
          )
          results.push({ eventId, state: 'processed' })
          continue
        }
        if (command.kind === 'credit.promotional_grant') {
          await this.createCreditLot({
            ...scope,
            kind: 'promotional',
            currency: command.data.currency,
            creditsMicros: command.data.creditsMicros,
            cashAmountMicros: 0,
            idempotencyKey: `webhook:${claim.provider}:${eventId}:grant`,
            operationReference: command.data.grantReference,
            sourceWebhookEventId: eventId,
            occurredAt: claim.effective_at as Date,
            expiresAt: command.data.expiresAt
              ? new Date(command.data.expiresAt)
              : null,
          })
          await this.withScope(scope, (client) =>
            client.query(
              `UPDATE persistent_codex.billing_webhook_events
               SET processing_state='processed',last_error_code=NULL,updated_at=$2
               WHERE webhook_event_id=$1`,
              [eventId, now.toISOString()],
            ),
          )
          results.push({ eventId, state: 'processed' })
          continue
        }
        if (
          command.kind === 'credit.refund' ||
          command.kind === 'credit.chargeback'
        ) {
          await this.appendCreditLifecycle({
            ...scope,
            entryType:
              command.kind === 'credit.refund' ? 'refund' : 'chargeback',
            currency: command.data.currency,
            creditsMicros: command.data.creditsMicros,
            cashAmountMicros: command.data.cashAmountMicros,
            idempotencyKey: `webhook:${claim.provider}:${eventId}:${command.kind}`,
            paymentReference: command.data.paymentReference,
            sourceWebhookEventId: eventId,
            occurredAt: claim.effective_at as Date,
          })
          await this.withScope(scope, (client) =>
            client.query(
              `UPDATE persistent_codex.billing_webhook_events
               SET processing_state='processed',last_error_code=NULL,updated_at=$2
               WHERE webhook_event_id=$1`,
              [eventId, now.toISOString()],
            ),
          )
          results.push({ eventId, state: 'processed' })
          continue
        }
        const data = billingWebhookSubscriptionDataSchema.parse(command.data)
        await this.withScope(scope, async (client) => {
          const plan = commercialPlanSchema.parse({ ...data.plan, ...scope })
          await client.query(
            `INSERT INTO persistent_codex.commercial_plans
              (tenant_id,organization_id,workspace_id,plan_id,plan_version,display_name,currency,billing_mode,tax_behavior,effective_at,retired_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
            [
              scope.tenantId,
              scope.organizationId,
              scope.workspaceId,
              plan.planId,
              plan.planVersion,
              plan.displayName,
              plan.currency,
              plan.billingMode,
              plan.taxBehavior,
              plan.effectiveAt,
              plan.retiredAt,
            ],
          )
          await client.query(
            `INSERT INTO persistent_codex.billing_customers
              (tenant_id,organization_id,workspace_id,billing_customer_id,provider,provider_customer_reference,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [
              scope.tenantId,
              scope.organizationId,
              scope.workspaceId,
              data.billingCustomerId,
              claim.provider,
              data.providerCustomerReference,
              now.toISOString(),
            ],
          )
          const applied = await client.query(
            `INSERT INTO persistent_codex.billing_subscriptions
              (tenant_id,organization_id,workspace_id,subscription_id,billing_customer_id,plan_id,plan_version,state,provider,provider_sequence,effective_at,updated_at,source_webhook_event_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT (tenant_id,organization_id,workspace_id,subscription_id)
             DO UPDATE SET billing_customer_id=EXCLUDED.billing_customer_id,plan_id=EXCLUDED.plan_id,
               plan_version=EXCLUDED.plan_version,state=EXCLUDED.state,provider=EXCLUDED.provider,
               provider_sequence=EXCLUDED.provider_sequence,effective_at=EXCLUDED.effective_at,
               updated_at=EXCLUDED.updated_at,source_webhook_event_id=EXCLUDED.source_webhook_event_id
             WHERE (EXCLUDED.provider_sequence,EXCLUDED.effective_at) >
               (persistent_codex.billing_subscriptions.provider_sequence,persistent_codex.billing_subscriptions.effective_at)`,
            [
              scope.tenantId,
              scope.organizationId,
              scope.workspaceId,
              data.subscriptionId,
              data.billingCustomerId,
              plan.planId,
              plan.planVersion,
              data.state,
              claim.provider,
              Number(claim.provider_sequence),
              (claim.effective_at as Date).toISOString(),
              now.toISOString(),
              eventId,
            ],
          )
          if ((applied.rowCount ?? 0) > 0) {
            for (const input of data.entitlements) {
              const value = entitlementSchema.parse({
                ...input,
                ...scope,
                sourceWebhookEventId: eventId,
              })
              await client.query(
                `INSERT INTO persistent_codex.entitlements
                  (tenant_id,organization_id,workspace_id,entitlement_id,plan_id,plan_version,entitlement_key,enabled,effective_at,expires_at,source_webhook_event_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                 ON CONFLICT (tenant_id,organization_id,workspace_id,plan_id,plan_version,entitlement_key)
                 DO UPDATE SET enabled=EXCLUDED.enabled,effective_at=EXCLUDED.effective_at,
                   expires_at=EXCLUDED.expires_at,source_webhook_event_id=EXCLUDED.source_webhook_event_id`,
                [
                  scope.tenantId,
                  scope.organizationId,
                  scope.workspaceId,
                  value.entitlementId,
                  value.planId,
                  value.planVersion,
                  value.key,
                  value.enabled,
                  value.effectiveAt,
                  value.expiresAt,
                  eventId,
                ],
              )
            }
            for (const input of data.budgets) {
              const value = budgetSchema.parse({ ...input, ...scope })
              await client.query(
                `INSERT INTO persistent_codex.budgets
                  (tenant_id,organization_id,workspace_id,budget_id,period,currency,soft_limit_micros,hard_limit_micros,effective_at,expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 ON CONFLICT (tenant_id,organization_id,workspace_id,budget_id)
                 DO UPDATE SET period=EXCLUDED.period,currency=EXCLUDED.currency,
                   soft_limit_micros=EXCLUDED.soft_limit_micros,hard_limit_micros=EXCLUDED.hard_limit_micros,
                   effective_at=EXCLUDED.effective_at,expires_at=EXCLUDED.expires_at`,
                [
                  scope.tenantId,
                  scope.organizationId,
                  scope.workspaceId,
                  value.budgetId,
                  value.period,
                  value.currency,
                  value.softLimitMicros,
                  value.hardLimitMicros,
                  value.effectiveAt,
                  value.expiresAt,
                ],
              )
            }
            for (const input of data.quotas) {
              const value = quotaPolicySchema.parse({ ...input, ...scope })
              await client.query(
                `INSERT INTO persistent_codex.quota_policies
                  (tenant_id,organization_id,workspace_id,quota_id,policy_version,meter,soft_limit,hard_limit,in_flight_policy,effective_at,expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
                [
                  scope.tenantId,
                  scope.organizationId,
                  scope.workspaceId,
                  value.quotaId,
                  value.policyVersion,
                  value.meter,
                  value.softLimit,
                  value.hardLimit,
                  value.inFlightPolicy,
                  value.effectiveAt,
                  value.expiresAt,
                ],
              )
            }
          }
          await client.query(
            `UPDATE persistent_codex.billing_webhook_events
             SET processing_state='processed',last_error_code=NULL,updated_at=$2
             WHERE webhook_event_id=$1`,
            [eventId, now.toISOString()],
          )
        })
        results.push({ eventId, state: 'processed' })
      } catch {
        const attempt = Number(claim.attempt)
        const state = attempt >= maxAttempts ? 'dead_letter' : 'retry'
        await this.withScope(scope, (client) =>
          client.query(
            `UPDATE persistent_codex.billing_webhook_events
             SET processing_state=$2,last_error_code='NORMALIZED_COMMAND_FAILED',updated_at=$3
             WHERE webhook_event_id=$1`,
            [eventId, state, now.toISOString()],
          ),
        )
        results.push({ eventId, state })
      }
    }
    return results
  }

  async close() {
    await this.pool.end()
  }
}

export function createBillingPostgresRepository(
  connectionString: string,
  options: {
    productionBillingVerified?: boolean
    developmentSeed?: DevelopmentCommercialSeed
  } = {},
) {
  return new BillingPostgresRepository(new Pool({ connectionString }), options)
}
