import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import {
  ManagedCloudBillingService,
  ManagedCloudError,
  ManagedCloudLifecycleService,
  ManagedCloudOnboardingService,
  DomainVerificationService,
  VaultProviderConnection,
  type DurableTaskPort,
  type ManagedCloudCommercialPolicyPort,
  type ManagedCloudPlan,
  type ManagedCloudScope,
  type ManagedCloudUsageViewPort,
  type RolloutAdmissionPort,
} from '@persistent-codex/managed-cloud'
import {
  PostgresAccountWorkspaceProvisioner,
  PostgresManagedCloudAuthorization,
  PostgresManagedCloudPlanCatalog,
  PostgresManagedCloudRepository,
} from '@persistent-codex/managed-cloud/postgres'
import {
  ProviderCredentialVault,
  RepositoryProviderAuthKillSwitch,
  assertProviderAuthCapability,
  type ProviderAuthCapabilitySource,
} from '@persistent-codex/provider-auth'
import { PostgresProviderAuthRepository } from '@persistent-codex/provider-auth/postgres'
import {
  RuntimeDataPlaneAuthority,
  TenantProvisioningService,
  type TenantRuntimeResources,
} from '@persistent-codex/tenant-runtime'
import { PostgresTenantRuntimeRepository } from '@persistent-codex/tenant-runtime/postgres'
import {
  EnvelopeEncryption,
  type KmsProvider,
} from '@persistent-codex/workspace-security'
import type { BillingPostgresRepository } from '@persistent-codex/billing-platform'
import type {
  ProductionPostgresRepository,
  ProductionScope,
} from '@persistent-codex/production-topology/production-postgres'
import type {
  DurableEventBroker,
  ObjectStore,
} from '@persistent-codex/production-topology/durable-dependencies'
import { ProductionRolloutAuthority } from './production-rollout-authority'

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')

class PostgresCommercialPolicy implements ManagedCloudCommercialPolicyPort {
  readonly #billing: BillingPostgresRepository
  constructor(billing: BillingPostgresRepository) {
    this.#billing = billing
  }
  async assignPlan(scope: ManagedCloudScope, plan: ManagedCloudPlan) {
    const effectiveAt = '2026-01-01T00:00:00.000Z'
    await this.#billing.withScope(scope, async (client) => {
      await client.query(
        `INSERT INTO persistent_codex.commercial_plans
          (tenant_id,organization_id,workspace_id,plan_id,plan_version,
           display_name,currency,billing_mode,tax_behavior,effective_at,retired_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'platform_managed','unknown',$8,NULL)
         ON CONFLICT DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          plan.planId,
          plan.planVersion,
          plan.displayName,
          plan.currency,
          effectiveAt,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.entitlements
          (tenant_id,organization_id,workspace_id,entitlement_id,plan_id,
           plan_version,entitlement_key,enabled,effective_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'turn.start',true,$7,NULL)
         ON CONFLICT DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          `managed-turn-${plan.planId}-${plan.planVersion}`,
          plan.planId,
          plan.planVersion,
          effectiveAt,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.budgets
          (tenant_id,organization_id,workspace_id,budget_id,period,currency,
           soft_limit_micros,hard_limit_micros,effective_at,expires_at)
         VALUES ($1,$2,$3,$4,'month',$5,$6,$7,$8,NULL)
         ON CONFLICT DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          `managed-budget-${plan.planId}-${plan.planVersion}`,
          plan.currency,
          Math.floor(plan.monthlyBudgetMicros * 0.8),
          plan.monthlyBudgetMicros,
          effectiveAt,
        ],
      )
      const quotas = [
        {
          id: `managed-storage-${plan.planId}-${plan.planVersion}`,
          meter: 'storage_byte',
          soft: Math.floor(plan.storageQuotaBytes * 0.8),
          hard: plan.storageQuotaBytes,
        },
        {
          id: `managed-turns-${plan.planId}-${plan.planVersion}`,
          meter: 'tenant_concurrent_turn',
          soft: 2,
          hard: 4,
        },
      ]
      for (const quota of quotas)
        await client.query(
          `INSERT INTO persistent_codex.quota_policies
            (tenant_id,organization_id,workspace_id,quota_id,policy_version,
             meter,soft_limit,hard_limit,in_flight_policy,effective_at,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'continue',$9,NULL)
           ON CONFLICT DO NOTHING`,
          [
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            quota.id,
            plan.planVersion,
            quota.meter,
            quota.soft,
            quota.hard,
            effectiveAt,
          ],
        )
      await client.query(
        `INSERT INTO persistent_codex.tenant_scheduling_policies
          (tenant_id,organization_id,workspace_id,policy_version,algorithm,
           weight,tenant_concurrency,workspace_concurrency,provider_concurrency,
           provider_requests_per_minute,starvation_age_ms,retry_policy,effective_at)
         VALUES ($1,$2,$3,$4,'weighted-fair-v1',1,4,1,$5::jsonb,$6::jsonb,
                 5000,$7::jsonb,$8)
         ON CONFLICT (tenant_id,organization_id) DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          plan.planVersion,
          JSON.stringify({ codex: 4 }),
          JSON.stringify({ codex: 120 }),
          JSON.stringify({
            maxAttempts: 4,
            initialBackoffMs: 100,
            maxBackoffMs: 1_000,
            poisonAfterAttempts: 4,
          }),
          effectiveAt,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.retail_price_catalogs
          (tenant_id,organization_id,workspace_id,catalog_id,catalog_version,
           currency,rates,operation_maximums,idempotency_key,occurred_at,
           effective_at,retired_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$10,NULL)
         ON CONFLICT DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          `managed-retail-${plan.planId}`,
          `managed-${plan.planId}-v${plan.planVersion}`,
          plan.currency,
          JSON.stringify([
            { meter: 'provider_input_token', creditsMicrosPerUnit: 1 },
            { meter: 'provider_output_token', creditsMicrosPerUnit: 2 },
            { meter: 'compute_millisecond', creditsMicrosPerUnit: 1 },
          ]),
          JSON.stringify([
            {
              operation: 'turn.start',
              maximumCreditsMicros: Math.min(plan.monthlyBudgetMicros, 100_000),
            },
          ]),
          `managed-retail-${plan.planId}-${plan.planVersion}`,
          effectiveAt,
        ],
      )
    })
    await this.#billing.createCreditLot({
      ...scope,
      kind: 'promotional',
      currency: plan.currency,
      creditsMicros: plan.monthlyBudgetMicros,
      cashAmountMicros: 0,
      idempotencyKey: `managed-beta-credit:${plan.planId}:${plan.planVersion}`,
      operationReference: 'managed-beta-onboarding',
    })
  }
  async admitFirstTask(input: {
    scope: ManagedCloudScope
    plan: ManagedCloudPlan
  }) {
    const decision = await this.#billing.admit({
      ...input.scope,
      operation: 'turn.start',
      requestKey: `managed-first-task:${input.scope.workspaceId}`,
    })
    return {
      allowed: decision.outcome !== 'deny',
      reason: decision.reason,
      inFlightPolicy: decision.inFlightPolicy,
    }
  }
}

class PostgresManagedUsage implements ManagedCloudUsageViewPort {
  readonly #pool: Pool
  constructor(pool: Pool) {
    this.#pool = pool
  }
  async listUsage(scope: ManagedCloudScope) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.tenant_id',$1,true),
                set_config('app.organization_id',$2,true),
                set_config('app.workspace_id',$3,true)`,
        [scope.tenantId, scope.organizationId, scope.workspaceId],
      )
      const rows = (
        await client.query<Record<string, unknown>>(
          `SELECT ledger_id,meter,quantity,usage_status,currency,
                  estimated_cost_micros,official_cost_micros,dedupe_key
           FROM persistent_codex.usage_ledger ORDER BY ledger_id`,
        )
      ).rows
      const providerRows = (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM persistent_codex.provider_usage_ledger
           ORDER BY usage_id`,
        )
      ).rows
      await client.query('COMMIT')
      return [
        ...rows.map((row) => {
          const meter = String(row.meter)
          const category = meter.startsWith('storage_')
            ? ('storage' as const)
            : meter.startsWith('compute_')
              ? ('compute' as const)
              : ('model' as const)
          const amount =
            row.official_cost_micros ?? row.estimated_cost_micros ?? null
          return {
            schemaVersion: 1 as const,
            ...scope,
            usageId: `wp24-${row.ledger_id}`,
            taskId: null,
            category,
            quantity: Number(row.quantity),
            unit: meter,
            amountMicros: amount === null ? null : Number(amount),
            currency: row.currency === null ? null : String(row.currency),
            estimated:
              row.official_cost_micros === null &&
              row.estimated_cost_micros !== null,
            billable: amount !== null,
            status: row.usage_status as
              'measured' | 'estimated' | 'reconciled' | 'incomplete',
            outcome: 'completed' as const,
            dedupeKey: String(row.dedupe_key ?? `wp24-${row.ledger_id}`),
          }
        }),
        ...providerRows.map((row) => ({
          schemaVersion: 1 as const,
          ...scope,
          usageId: `wp34-${row.usage_id}`,
          taskId: null,
          category: 'model' as const,
          quantity: Number(row.quantity),
          unit: String(row.unit),
          amountMicros:
            row.monetary_amount_micros === null
              ? null
              : Number(row.monetary_amount_micros),
          currency: row.currency === null ? null : String(row.currency),
          estimated: Boolean(row.estimated),
          billable: row.billing_mode !== 'subscription-quota',
          status: Boolean(row.estimated)
            ? ('estimated' as const)
            : ('measured' as const),
          outcome: 'completed' as const,
          dedupeKey: `wp34-${row.usage_id}`,
        })),
      ]
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

class ProductionDurableTaskAdapter implements DurableTaskPort {
  readonly #repository: ProductionPostgresRepository
  readonly #objectStore: ObjectStore
  readonly #broker: DurableEventBroker
  readonly #billing: BillingPostgresRepository
  readonly #regionId: string
  constructor(options: {
    repository: ProductionPostgresRepository
    objectStore: ObjectStore
    broker: DurableEventBroker
    billing: BillingPostgresRepository
    regionId: string
  }) {
    this.#repository = options.repository
    this.#objectStore = options.objectStore
    this.#broker = options.broker
    this.#billing = options.billing
    this.#regionId = options.regionId
  }
  async start(input: Parameters<DurableTaskPort['start']>[0]) {
    const sessionId = `mcs_${digest(
      `${input.scope.tenantId}:${input.idempotencyKey}`,
    ).slice(0, 24)}`
    await this.#repository.createSession({ ...input.scope, sessionId })
    const promptObjectKey = `${input.scope.tenantId}/${input.scope.organizationId}/${input.scope.workspaceId}/runs/${sessionId}/input`
    await this.#objectStore.put(
      promptObjectKey,
      new TextEncoder().encode(input.prompt),
      'text/plain; charset=utf-8',
    )
    const accepted = await this.#repository.enqueueTurn({
      ...input.scope,
      sessionId,
      runId: `mcr_${digest(input.idempotencyKey).slice(0, 24)}`,
      idempotencyKey: input.idempotencyKey,
      promptObjectKey,
      requestBody: {
        promptDigest: digest(input.prompt),
        provider: input.provider,
      },
      requiredRegionId: this.#regionId,
      maxAttempts: 4,
    })
    const decision = await this.#billing.latestDecision(input.scope)
    if (decision)
      await this.#billing.bindDecision(
        input.scope,
        decision.decisionId,
        accepted.run.runId,
      )
    await this.#broker.publish('ha.event', {
      schemaVersion: 1,
      type: 'run.queued',
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      sessionId,
      runId: accepted.run.runId,
    })
    return {
      taskId: sessionId,
      state:
        accepted.run.state === 'completed'
          ? ('completed' as const)
          : ('running' as const),
    }
  }
  async replay(scope: ManagedCloudScope, taskId: string) {
    const session = await this.#repository.getSession(scope, taskId)
    if (!session) throw new ManagedCloudError('TASK_NOT_FOUND')
    const replay = await this.#repository.replay(scope, taskId)
    const terminal = [...replay.events]
      .reverse()
      .find((event) =>
        ['turn.completed', 'turn.failed', 'error.reported'].includes(
          event.eventType,
        ),
      )
    return {
      taskId,
      state:
        terminal?.eventType === 'turn.completed'
          ? ('completed' as const)
          : terminal
            ? ('failed' as const)
            : ('running' as const),
      output:
        typeof terminal?.payload.output === 'string'
          ? terminal.payload.output
          : null,
    }
  }
}

class PostgresRolloutAdmission implements RolloutAdmissionPort {
  readonly #pool: Pool
  readonly #authority: ProductionRolloutAuthority
  readonly #rolloutId: string
  readonly #maxActiveTenants: number
  readonly #providerRepository: PostgresProviderAuthRepository
  readonly #providerCapability: ProviderAuthCapabilitySource
  constructor(options: {
    pool: Pool
    rolloutId: string
    maxActiveTenants: number
    providerRepository: PostgresProviderAuthRepository
    providerCapability: ProviderAuthCapabilitySource
  }) {
    this.#pool = options.pool
    this.#authority = new ProductionRolloutAuthority(options.pool)
    this.#rolloutId = options.rolloutId
    this.#maxActiveTenants = options.maxActiveTenants
    this.#providerRepository = options.providerRepository
    this.#providerCapability = options.providerCapability
  }
  async #rollout(scope: ManagedCloudScope) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.tenant_id',$1,true),
                set_config('app.organization_id',$2,true),
                set_config('app.workspace_id',$3,true)`,
        [scope.tenantId, scope.organizationId, scope.workspaceId],
      )
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM persistent_codex.production_rollouts
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND rollout_id=$4`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          this.#rolloutId,
        ],
      )
      await client.query('COMMIT')
      return result.rows[0]
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  async assertAdmission(
    input: Parameters<RolloutAdmissionPort['assertAdmission']>[0],
  ) {
    const scope = input.scope as ProductionScope
    if (!(await this.#rollout(scope)))
      await this.#authority.create({
        ...scope,
        rolloutId: this.#rolloutId,
        cohortId: 'internal',
        artifactSha256: digest('wp35-managed-cloud-artifact'),
        previousArtifactSha256: digest('wp34-managed-cloud-artifact'),
      })
    const rollout = (await this.#rollout(scope))!
    if (
      !Boolean(rollout.feature_flag_enabled) ||
      Boolean(rollout.kill_switch) ||
      !['internal', 'design_partner', 'limited_beta'].includes(
        String(rollout.stage),
      )
    )
      throw new ManagedCloudError('MANAGED_BETA_ROLLOUT_HALTED')
    const active = await this.#pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM persistent_codex.managed_tenants
       WHERE state='active'`,
    )
    if (Number(active.rows[0]?.count ?? 0) >= this.#maxActiveTenants)
      throw new ManagedCloudError('MANAGED_BETA_CAPACITY_HALT')
    const existingSwitch = await this.#providerRepository.getKillSwitch(
      input.scope,
      input.provider,
      input.authMode,
    )
    if (!existingSwitch) {
      const approved = assertProviderAuthCapability(
        this.#providerCapability.resolve(input.provider, input.authMode),
      )
      await this.#providerRepository.putKillSwitch(
        {
          ...input.scope,
          provider: input.provider,
          authMode: input.authMode,
          enabled: true,
          termsEvidenceHash: digest(
            `${approved.reasonCode}:${approved.evidenceVersion}`,
          ),
          version: 1,
        },
        null,
      )
    }
    await new RepositoryProviderAuthKillSwitch(
      this.#providerRepository,
      input.scope,
    ).assertNewWork(input.provider, input.authMode)
  }
}

class PostgresLifecycleQueue {
  readonly #pool: Pool
  constructor(pool: Pool) {
    this.#pool = pool
  }
  async #withScope<T>(
    scope: ManagedCloudScope,
    run: (client: import('pg').PoolClient) => Promise<T>,
  ) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.tenant_id',$1,true),
                set_config('app.organization_id',$2,true),
                set_config('app.workspace_id',$3,true)`,
        [scope.tenantId, scope.organizationId, scope.workspaceId],
      )
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  async exportTenant(input: ManagedCloudScope & { idempotencyKey: string }) {
    const jobId = `exp_${digest(input.idempotencyKey).slice(0, 24)}`
    await this.#withScope(input, (client) =>
      client.query(
        `INSERT INTO persistent_codex.tenant_export_jobs
          (tenant_id,organization_id,job_id,idempotency_key,state,version)
         VALUES ($1,$2,$3,$4,'requested',1)
         ON CONFLICT (tenant_id,organization_id,idempotency_key) DO NOTHING`,
        [input.tenantId, input.organizationId, jobId, input.idempotencyKey],
      ),
    )
    return { jobId, state: 'requested' }
  }
  async deleteTenant(input: ManagedCloudScope & { idempotencyKey: string }) {
    const jobId = `del_${digest(input.idempotencyKey).slice(0, 24)}`
    await this.#withScope(input, (client) =>
      client.query(
        `INSERT INTO persistent_codex.tenant_deletion_jobs
          (tenant_id,organization_id,job_id,idempotency_key,state,current_step,
           key_version,version)
         VALUES ($1,$2,$3,$4,'requested','sessions',1,1)
         ON CONFLICT (tenant_id,organization_id,idempotency_key) DO NOTHING`,
        [input.tenantId, input.organizationId, jobId, input.idempotencyKey],
      ),
    )
    return { jobId, state: 'requested' }
  }
}

export function createManagedCloudProductionComposition(options: {
  pool: Pool
  productionRepository: ProductionPostgresRepository
  billing: BillingPostgresRepository
  objectStore: ObjectStore
  broker: DurableEventBroker
  regionId: string
  runtimeResources: TenantRuntimeResources
  kms: KmsProvider
  providerCapability: ProviderAuthCapabilitySource
  rolloutId: string
  maxActiveTenants: number
}) {
  if (!options.kms.production && process.env.NODE_ENV !== 'test')
    throw new Error('MANAGED_CLOUD_PRODUCTION_KMS_REQUIRED')
  const repository = new PostgresManagedCloudRepository(options.pool)
  const tenantRepository = new PostgresTenantRuntimeRepository(options.pool)
  const providerRepository = new PostgresProviderAuthRepository(options.pool)
  const runtimeAuthority = new RuntimeDataPlaneAuthority({
    repository: tenantRepository,
  })
  const providers = new VaultProviderConnection({
    repository: providerRepository,
    vault: {
      connect: (input) =>
        new ProviderCredentialVault({
          repository: providerRepository,
          encryption: new EnvelopeEncryption(options.kms),
          runtimeAuthority,
          capability: options.providerCapability,
          killSwitch: new RepositoryProviderAuthKillSwitch(
            providerRepository,
            input.scope,
          ),
        }).connect(input),
    },
  })
  const tasks = new ProductionDurableTaskAdapter({
    repository: options.productionRepository,
    objectStore: options.objectStore,
    broker: options.broker,
    billing: options.billing,
    regionId: options.regionId,
  })
  const lifecycle = new ManagedCloudLifecycleService({
    lifecycle: new PostgresLifecycleQueue(options.pool),
    credentials: {
      listProfiles: (scope) => providerRepository.listProfiles(scope),
      revoke: (scope, profileId) =>
        new ProviderCredentialVault({
          repository: providerRepository,
          encryption: new EnvelopeEncryption(options.kms),
          runtimeAuthority,
          capability: options.providerCapability,
          killSwitch: new RepositoryProviderAuthKillSwitch(
            providerRepository,
            scope,
          ),
        }).revoke(scope, profileId),
      cryptoErase: (scope, profileId) =>
        new ProviderCredentialVault({
          repository: providerRepository,
          encryption: new EnvelopeEncryption(options.kms),
          runtimeAuthority,
          capability: options.providerCapability,
          killSwitch: new RepositoryProviderAuthKillSwitch(
            providerRepository,
            scope,
          ),
        }).cryptoErase(scope, profileId),
    },
    tenants: new TenantProvisioningService({
      repository: tenantRepository,
      resources: options.runtimeResources,
    }),
  })
  return {
    onboarding: new ManagedCloudOnboardingService({
      repository,
      accounts: new PostgresAccountWorkspaceProvisioner(options.pool),
      provisioning: new TenantProvisioningService({
        repository: tenantRepository,
        resources: options.runtimeResources,
      }),
      providers,
      tasks,
      rollout: new PostgresRolloutAdmission({
        pool: options.pool,
        rolloutId: options.rolloutId,
        maxActiveTenants: options.maxActiveTenants,
        providerRepository,
        providerCapability: options.providerCapability,
      }),
      commercial: new PostgresCommercialPolicy(options.billing),
      catalog: new PostgresManagedCloudPlanCatalog(options.pool),
    }),
    usage: new PostgresManagedUsage(options.pool),
    domains: new DomainVerificationService(repository),
    tasks,
    lifecycle,
    authorization: new PostgresManagedCloudAuthorization(options.pool),
    overview: {
      async get(scope: ManagedCloudScope) {
        const [policy, credits, lastReconciledAt] = await Promise.all([
          options.billing.snapshot(scope),
          options.billing.creditAccount(scope),
          options.billing.lastReconciledAt(scope),
        ])
        return {
          schemaVersion: 1,
          plan: policy.plan,
          entitlements: policy.entitlements,
          quotas: policy.quotas,
          budgets: policy.budgets,
          credits,
          lastReconciledAt,
          hostingAndModelUsageAreSeparate: true,
          estimatesAreNotInvoices: true,
        }
      },
    },
    credits: new ManagedCloudBillingService(options.billing),
  }
}
