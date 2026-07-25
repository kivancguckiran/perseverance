import pg from 'pg'
import {
  managedTenantSchema,
  orphanRuntimeSchema,
  provisioningJobSchema,
  tenantCapacityBudgetSchema,
  tenantRuntimeSchema,
  TENANT_RUNTIME_CONTRACT_VERSION,
  type ManagedTenant,
  type OrphanRuntime,
  type ProvisioningJob,
  type TenantCapacityBudget,
  type TenantRuntime,
  type TenantRuntimeScope,
} from './contracts'
import {
  TenantRuntimeError,
  type RecordedRuntimeCredential,
  type TenantRuntimeRepository,
} from './index'

// PostgreSQL destekli tenant runtime repository'si (migration 0035).
// Scoped işlemler transaction-lokal app.tenant_id/app.organization_id GUC'ları
// ile RLS altındadır; cross-tenant listelemeler `persistent_tenant_provisioner`
// sistem rol üyeliği ister (0028 scheduler deseni).

export class PostgresTenantRuntimeRepository implements TenantRuntimeRepository {
  readonly #pool: pg.Pool

  constructor(pool: pg.Pool) {
    this.#pool = pool
  }

  async close() {
    await this.#pool.end()
  }

  async #withScope<T>(
    scope: TenantRuntimeScope | null,
    run: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      if (scope) {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [
          scope.tenantId,
        ])
        await client.query(
          "SELECT set_config('app.organization_id', $1, true)",
          [scope.organizationId],
        )
      }
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

  #tenantFromRow(row: Record<string, unknown>): ManagedTenant {
    return managedTenantSchema.parse({
      schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      displayName: row.display_name,
      state: row.state,
      desiredState: row.desired_state,
      domain: row.domain ?? null,
      regionId: row.region_id,
      retentionPolicyId: row.retention_policy_id ?? null,
      retentionDays: Number(row.retention_days),
      capacity: row.capacity,
      version: Number(row.version),
    })
  }

  async getTenant(scope: TenantRuntimeScope) {
    return this.#withScope(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.managed_tenants
         WHERE tenant_id = $1 AND organization_id = $2`,
        [scope.tenantId, scope.organizationId],
      )
      const row = result.rows[0]
      return row ? this.#tenantFromRow(row) : undefined
    })
  }

  async putTenant(tenant: ManagedTenant, expectedVersion: number | null) {
    const parsed = managedTenantSchema.parse(tenant)
    await this.#withScope(parsed, async (client) => {
      const result =
        expectedVersion === null
          ? await client.query(
              `INSERT INTO persistent_codex.managed_tenants
                 (tenant_id, organization_id, display_name, state, desired_state,
                  domain, region_id, retention_policy_id, retention_days, capacity, version)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT DO NOTHING`,
              [
                parsed.tenantId,
                parsed.organizationId,
                parsed.displayName,
                parsed.state,
                parsed.desiredState,
                parsed.domain,
                parsed.regionId,
                parsed.retentionPolicyId,
                parsed.retentionDays,
                JSON.stringify(parsed.capacity),
                parsed.version,
              ],
            )
          : await client.query(
              `UPDATE persistent_codex.managed_tenants SET
                 display_name = $3, state = $4, desired_state = $5, domain = $6,
                 region_id = $7, retention_policy_id = $8, retention_days = $9,
                 capacity = $10, version = $11, updated_at = now()
               WHERE tenant_id = $1 AND organization_id = $2 AND version = $12`,
              [
                parsed.tenantId,
                parsed.organizationId,
                parsed.displayName,
                parsed.state,
                parsed.desiredState,
                parsed.domain,
                parsed.regionId,
                parsed.retentionPolicyId,
                parsed.retentionDays,
                JSON.stringify(parsed.capacity),
                parsed.version,
                expectedVersion,
              ],
            )
      if (result.rowCount !== 1)
        throw new TenantRuntimeError('TENANT_RUNTIME_VERSION_CONFLICT')
    })
  }

  async listTenants() {
    return this.#withScope(null, async (client) => {
      const result = await client.query(
        'SELECT * FROM persistent_codex.managed_tenants ORDER BY tenant_id',
      )
      return result.rows.map((row) => this.#tenantFromRow(row))
    })
  }

  #runtimeFromRow(row: Record<string, unknown>): TenantRuntime {
    return tenantRuntimeSchema.parse({
      schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      runtimeId: row.runtime_id,
      generation: Number(row.generation),
      state: row.state,
      identitySubject: row.identity_subject ?? null,
      volumeId: row.volume_id ?? null,
      volumeEncrypted: Boolean(row.volume_encrypted),
      kmsProvider: row.kms_provider ?? null,
      kmsKeyId: row.kms_key_id ?? null,
      kmsKeyVersion:
        row.kms_key_version === null || row.kms_key_version === undefined
          ? null
          : Number(row.kms_key_version),
      secretNamespace: row.secret_namespace ?? null,
      networkPolicyId: row.network_policy_id ?? null,
      regionId: row.region_id,
      nodeId: row.node_id ?? null,
      capacityReservationId: row.capacity_reservation_id ?? null,
      version: Number(row.version),
    })
  }

  async getRuntime(scope: TenantRuntimeScope, workspaceId: string) {
    return this.#withScope(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.tenant_runtimes
         WHERE tenant_id = $1 AND organization_id = $2 AND workspace_id = $3`,
        [scope.tenantId, scope.organizationId, workspaceId],
      )
      const row = result.rows[0]
      return row ? this.#runtimeFromRow(row) : undefined
    })
  }

  async putRuntime(runtime: TenantRuntime, expectedVersion: number | null) {
    const parsed = tenantRuntimeSchema.parse(runtime)
    await this.#withScope(parsed, async (client) => {
      const values = [
        parsed.tenantId,
        parsed.organizationId,
        parsed.workspaceId,
        parsed.runtimeId,
        parsed.generation,
        parsed.state,
        parsed.identitySubject,
        parsed.volumeId,
        parsed.volumeEncrypted,
        parsed.kmsProvider,
        parsed.kmsKeyId,
        parsed.kmsKeyVersion,
        parsed.secretNamespace,
        parsed.networkPolicyId,
        parsed.regionId,
        parsed.nodeId,
        parsed.capacityReservationId,
        parsed.version,
      ]
      const result =
        expectedVersion === null
          ? await client.query(
              `INSERT INTO persistent_codex.tenant_runtimes
                 (tenant_id, organization_id, workspace_id, runtime_id, generation, state,
                  identity_subject, volume_id, volume_encrypted, kms_provider, kms_key_id,
                  kms_key_version, secret_namespace, network_policy_id, region_id, node_id,
                  capacity_reservation_id, version)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
               ON CONFLICT DO NOTHING`,
              values,
            )
          : await client.query(
              `UPDATE persistent_codex.tenant_runtimes SET
                 runtime_id = $4, generation = $5, state = $6, identity_subject = $7,
                 volume_id = $8, volume_encrypted = $9, kms_provider = $10, kms_key_id = $11,
                 kms_key_version = $12, secret_namespace = $13, network_policy_id = $14,
                 region_id = $15, node_id = $16, capacity_reservation_id = $17,
                 version = $18, updated_at = now()
               WHERE tenant_id = $1 AND organization_id = $2 AND workspace_id = $3
                 AND version = $19`,
              [...values, expectedVersion],
            )
      if (result.rowCount !== 1)
        throw new TenantRuntimeError('TENANT_RUNTIME_VERSION_CONFLICT')
    })
  }

  async listRuntimes(scope?: TenantRuntimeScope) {
    return this.#withScope(scope ?? null, async (client) => {
      const result = await client.query(
        'SELECT * FROM persistent_codex.tenant_runtimes ORDER BY tenant_id, workspace_id',
      )
      return result.rows.map((row) => this.#runtimeFromRow(row))
    })
  }

  #jobFromRow(row: Record<string, unknown>): ProvisioningJob {
    return provisioningJobSchema.parse({
      schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      jobId: row.job_id,
      kind: row.kind,
      workspaceId: row.workspace_id,
      runtimeId: row.runtime_id,
      state: row.state,
      currentStep: row.current_step ?? null,
      completedSteps: row.completed_steps,
      idempotencyKey: row.idempotency_key,
      attempt: Number(row.attempt),
      lastErrorCode: row.last_error_code ?? null,
      version: Number(row.version),
    })
  }

  async getJob(scope: TenantRuntimeScope, jobId: string) {
    return this.#withScope(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.tenant_provisioning_jobs
         WHERE tenant_id = $1 AND organization_id = $2 AND job_id = $3`,
        [scope.tenantId, scope.organizationId, jobId],
      )
      const row = result.rows[0]
      return row ? this.#jobFromRow(row) : undefined
    })
  }

  async getJobByIdempotencyKey(
    scope: TenantRuntimeScope,
    idempotencyKey: string,
  ) {
    return this.#withScope(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.tenant_provisioning_jobs
         WHERE tenant_id = $1 AND organization_id = $2 AND idempotency_key = $3`,
        [scope.tenantId, scope.organizationId, idempotencyKey],
      )
      const row = result.rows[0]
      return row ? this.#jobFromRow(row) : undefined
    })
  }

  async putJob(job: ProvisioningJob, expectedVersion: number | null) {
    const parsed = provisioningJobSchema.parse(job)
    await this.#withScope(parsed, async (client) => {
      const result =
        expectedVersion === null
          ? await client.query(
              `INSERT INTO persistent_codex.tenant_provisioning_jobs
                 (tenant_id, organization_id, job_id, kind, workspace_id, runtime_id,
                  state, current_step, completed_steps, idempotency_key, attempt,
                  last_error_code, version)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
               ON CONFLICT DO NOTHING`,
              [
                parsed.tenantId,
                parsed.organizationId,
                parsed.jobId,
                parsed.kind,
                parsed.workspaceId,
                parsed.runtimeId,
                parsed.state,
                parsed.currentStep,
                JSON.stringify(parsed.completedSteps),
                parsed.idempotencyKey,
                parsed.attempt,
                parsed.lastErrorCode,
                parsed.version,
              ],
            )
          : await client.query(
              `UPDATE persistent_codex.tenant_provisioning_jobs SET
                 state = $4, current_step = $5, completed_steps = $6, attempt = $7,
                 last_error_code = $8, version = $9, updated_at = now()
               WHERE tenant_id = $1 AND organization_id = $2 AND job_id = $3
                 AND version = $10`,
              [
                parsed.tenantId,
                parsed.organizationId,
                parsed.jobId,
                parsed.state,
                parsed.currentStep,
                JSON.stringify(parsed.completedSteps),
                parsed.attempt,
                parsed.lastErrorCode,
                parsed.version,
                expectedVersion,
              ],
            )
      if (result.rowCount !== 1)
        throw new TenantRuntimeError('TENANT_RUNTIME_VERSION_CONFLICT')
    })
  }

  async listIncompleteJobs(scope: TenantRuntimeScope) {
    return this.#withScope(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.tenant_provisioning_jobs
         WHERE tenant_id = $1 AND organization_id = $2 AND state <> 'completed'
         ORDER BY job_id`,
        [scope.tenantId, scope.organizationId],
      )
      return result.rows.map((row) => this.#jobFromRow(row))
    })
  }

  async recordCredential(credential: RecordedRuntimeCredential) {
    await this.#withScope(
      {
        tenantId: credential.tenantId,
        organizationId: credential.organizationId,
      },
      async (client) => {
        await client.query(
          `INSERT INTO persistent_codex.tenant_runtime_credentials
             (tenant_id, organization_id, credential_id, workspace_id, runtime_id,
              generation, actions, token_digest, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING`,
          [
            credential.tenantId,
            credential.organizationId,
            credential.credentialId,
            credential.workspaceId,
            credential.runtimeId,
            credential.generation,
            JSON.stringify(credential.actions),
            credential.tokenDigest,
            credential.expiresAt,
          ],
        )
      },
    )
  }

  async revokeCredential(credentialId: string) {
    await this.#withScope(null, async (client) => {
      await client.query(
        `UPDATE persistent_codex.tenant_runtime_credentials
         SET revoked_at = now() WHERE credential_id = $1`,
        [credentialId],
      )
    })
  }

  async isCredentialRevoked(credentialId: string) {
    return this.#withScope(null, async (client) => {
      const result = await client.query(
        `SELECT revoked_at FROM persistent_codex.tenant_runtime_credentials
         WHERE credential_id = $1`,
        [credentialId],
      )
      const row = result.rows[0]
      return row ? row.revoked_at !== null : false
    })
  }

  async recordOrphan(orphan: OrphanRuntime) {
    const parsed = orphanRuntimeSchema.parse(orphan)
    await this.#withScope(null, async (client) => {
      await client.query(
        `INSERT INTO persistent_codex.tenant_runtime_orphans
           (observed_runtime_id, reason, state)
         VALUES ($1,$2,$3)
         ON CONFLICT (observed_runtime_id) DO UPDATE
           SET reason = EXCLUDED.reason, updated_at = now()
           WHERE persistent_codex.tenant_runtime_orphans.state <> 'cleaned'`,
        [parsed.observedRuntimeId, parsed.reason, parsed.state],
      )
    })
  }

  async listOrphans(state?: OrphanRuntime['state']) {
    return this.#withScope(null, async (client) => {
      const result = state
        ? await client.query(
            `SELECT * FROM persistent_codex.tenant_runtime_orphans
             WHERE state = $1 ORDER BY observed_runtime_id`,
            [state],
          )
        : await client.query(
            `SELECT * FROM persistent_codex.tenant_runtime_orphans
             ORDER BY observed_runtime_id`,
          )
      return result.rows.map((row) =>
        orphanRuntimeSchema.parse({
          schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
          observedRuntimeId: row.observed_runtime_id,
          reason: row.reason,
          state: row.state,
        }),
      )
    })
  }

  async markOrphanCleaned(observedRuntimeId: string) {
    await this.#withScope(null, async (client) => {
      await client.query(
        `UPDATE persistent_codex.tenant_runtime_orphans
         SET state = 'cleaned', updated_at = now()
         WHERE observed_runtime_id = $1`,
        [observedRuntimeId],
      )
    })
  }

  async getCapacityBudget(scope: TenantRuntimeScope) {
    return this.#withScope(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.tenant_capacity_budgets
         WHERE tenant_id = $1 AND organization_id = $2`,
        [scope.tenantId, scope.organizationId],
      )
      const row = result.rows[0]
      return row
        ? tenantCapacityBudgetSchema.parse({
            schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
            tenantId: row.tenant_id,
            organizationId: row.organization_id,
            reservedCapacity: row.reserved_capacity,
            queueLatencyBudgetMs: Number(row.queue_latency_budget_ms),
            maxStarvationPosition: Number(row.max_starvation_position),
            version: Number(row.version),
          })
        : undefined
    })
  }

  async putCapacityBudget(
    budget: TenantCapacityBudget,
    expectedVersion: number | null,
  ) {
    const parsed = tenantCapacityBudgetSchema.parse(budget)
    await this.#withScope(parsed, async (client) => {
      const result =
        expectedVersion === null
          ? await client.query(
              `INSERT INTO persistent_codex.tenant_capacity_budgets
                 (tenant_id, organization_id, reserved_capacity,
                  queue_latency_budget_ms, max_starvation_position, version)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT DO NOTHING`,
              [
                parsed.tenantId,
                parsed.organizationId,
                JSON.stringify(parsed.reservedCapacity),
                parsed.queueLatencyBudgetMs,
                parsed.maxStarvationPosition,
                parsed.version,
              ],
            )
          : await client.query(
              `UPDATE persistent_codex.tenant_capacity_budgets SET
                 reserved_capacity = $3, queue_latency_budget_ms = $4,
                 max_starvation_position = $5, version = $6, updated_at = now()
               WHERE tenant_id = $1 AND organization_id = $2 AND version = $7`,
              [
                parsed.tenantId,
                parsed.organizationId,
                JSON.stringify(parsed.reservedCapacity),
                parsed.queueLatencyBudgetMs,
                parsed.maxStarvationPosition,
                parsed.version,
                expectedVersion,
              ],
            )
      if (result.rowCount !== 1)
        throw new TenantRuntimeError('TENANT_RUNTIME_VERSION_CONFLICT')
    })
  }

  async listCapacityBudgets() {
    return this.#withScope(null, async (client) => {
      const result = await client.query(
        'SELECT * FROM persistent_codex.tenant_capacity_budgets ORDER BY tenant_id',
      )
      return result.rows.map((row) =>
        tenantCapacityBudgetSchema.parse({
          schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
          tenantId: row.tenant_id,
          organizationId: row.organization_id,
          reservedCapacity: row.reserved_capacity,
          queueLatencyBudgetMs: Number(row.queue_latency_budget_ms),
          maxStarvationPosition: Number(row.max_starvation_position),
          version: Number(row.version),
        }),
      )
    })
  }
}

export function createPostgresTenantRuntimeRepository(
  connectionString: string,
): PostgresTenantRuntimeRepository {
  return new PostgresTenantRuntimeRepository(
    new pg.Pool({ connectionString, max: 5 }),
  )
}
