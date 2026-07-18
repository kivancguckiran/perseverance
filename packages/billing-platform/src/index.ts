import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import {
  BILLING_CONTRACT_VERSION,
  admissionDecisionSchema,
  admissionRequestSchema,
  billingWebhookPayloadSchema,
  billingWebhookSubscriptionDataSchema,
  billingScopeSchema,
  billingWebhookEventSchema,
  budgetSchema,
  commercialPlanSchema,
  entitlementSchema,
  quotaPolicySchema,
  subscriptionStateSchema,
  type AdmissionDecision,
  type AdmissionRequest,
  type BillingScope,
  type BillingWebhookEvent,
  type BillingWebhookPayload,
  type BillingWebhookSubscriptionData,
  type Budget,
  type CommercialPolicySnapshot,
  type CommercialPlan,
  type Entitlement,
  type QuotaPolicy,
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
  | { kind: 'unknown' }

export function normalizeBillingWebhookPayload(input: unknown): {
  envelope: BillingWebhookPayload
  command: NormalizedBillingWebhookCommand
} {
  const envelope = billingWebhookPayloadSchema.parse(input)
  if (envelope.eventType !== 'subscription.updated')
    return { envelope, command: { kind: 'unknown' } }
  return {
    envelope,
    command: {
      kind: 'subscription.updated',
      data: billingWebhookSubscriptionDataSchema.parse(envelope.data),
    },
  }
}

export interface DevelopmentCommercialSeed {
  plan: Omit<CommercialPlan, keyof BillingScope>
  entitlements: Array<Omit<Entitlement, keyof BillingScope>>
  budgets: Array<Omit<Budget, keyof BillingScope>>
  quotas: Array<Omit<QuotaPolicy, keyof BillingScope>>
}

export interface DurableAdmissionInput extends BillingScope {
  operation: AdmissionRequest['operation']
  requestKey: string
  sessionId?: string
  requestedBytes?: number
  evaluatedAt?: Date
}

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
    if (!value && this.#developmentSeed) {
      await this.seedDevelopmentScope(scope)
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
    return this.withScope(scope, async (client) => {
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
  }

  async bindDecision(
    scopeInput: BillingScope,
    decisionId: string,
    resourceId: string,
  ) {
    return this.withScope(scopeInput, async (client) =>
      client.query(
        `UPDATE persistent_codex.commercial_admission_leases
         SET resource_id=coalesce(resource_id,$2)
         WHERE decision_id=$1 AND (resource_id IS NULL OR resource_id=$2)`,
        [decisionId, resourceId],
      ),
    )
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
    return this.withScope(scopeInput, async (client) =>
      client.query(
        `UPDATE persistent_codex.commercial_admission_leases
         SET released_at=coalesce(released_at,now()) WHERE decision_id=$1`,
        [decisionId],
      ),
    )
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
