import { Pool, type PoolClient } from 'pg'
import {
  managedCloudPlanSchema,
  domainVerificationSchema,
  onboardingRecordSchema,
  type DomainVerification,
  type ManagedCloudScope,
  type OnboardingRecord,
  type ManagedCloudPlan,
} from './contracts'
import {
  type AccountWorkspacePort,
  ManagedCloudError,
  type ManagedCloudRepository,
  type ManagedCloudPlanCatalogPort,
} from './index'

export interface ManagedCloudPrincipal {
  issuer: string
  subject: string
}

export type ManagedCloudWorkspaceAction =
  'read' | 'manage-domain' | 'export' | 'delete'

export class PostgresManagedCloudPlanCatalog implements ManagedCloudPlanCatalogPort {
  readonly #pool: Pool
  constructor(pool: Pool) {
    this.#pool = pool
  }
  async resolve(
    planId: string,
    planVersion: number,
  ): Promise<ManagedCloudPlan> {
    const result = await this.#pool.query<{ plan: unknown }>(
      `SELECT plan FROM persistent_codex.managed_cloud_plan_catalog
       WHERE plan_id=$1 AND plan_version=$2 AND enabled=true`,
      [planId, planVersion],
    )
    if (!result.rowCount) throw new ManagedCloudError('PLAN_NOT_FOUND')
    return managedCloudPlanSchema.parse(result.rows[0]!.plan)
  }
}

export class PostgresManagedCloudAuthorization {
  readonly #pool: Pool
  constructor(pool: Pool) {
    this.#pool = pool
  }
  async resolveWorkspace(
    principal: ManagedCloudPrincipal,
    workspaceId: string,
    action: ManagedCloudWorkspaceAction,
  ): Promise<ManagedCloudScope> {
    const client = await this.#pool.connect()
    let matched:
      | {
          tenant_id: string
          organization_id: string
          workspace_id: string
          role: string
        }
      | undefined
    try {
      await client.query('BEGIN')
      const memberships = await client.query<{
        organization_id: string
        role: string
      }>(
        `SELECT m.organization_id,m.role
         FROM persistent_codex.principal_identities p
         JOIN persistent_codex.organization_memberships m
           ON m.issuer=p.issuer AND m.subject=p.subject
         WHERE p.issuer=$1 AND p.subject=$2 AND p.status='active'
           AND m.status='active'`,
        [principal.issuer, principal.subject],
      )
      for (const membership of memberships.rows) {
        await client.query(
          `SELECT set_config('app.tenant_id',$1,true),
                  set_config('app.organization_id',$1,true),
                  set_config('app.workspace_id',$2,true)`,
          [membership.organization_id, workspaceId],
        )
        const workspace = await client.query<{
          tenant_id: string
          organization_id: string
          workspace_id: string
        }>(
          `SELECT tenant_id,organization_id,workspace_id
           FROM persistent_codex.workspaces
           WHERE organization_id=$1 AND workspace_id=$2`,
          [membership.organization_id, workspaceId],
        )
        if (workspace.rowCount === 1) {
          if (matched) throw new ManagedCloudError('WORKSPACE_ID_AMBIGUOUS')
          matched = { ...workspace.rows[0]!, role: membership.role }
        }
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    if (!matched) throw new ManagedCloudError('WORKSPACE_ACCESS_DENIED')
    const role = matched.role
    const permitted =
      action === 'read'
        ? ['owner', 'admin', 'developer', 'viewer', 'billing'].includes(role)
        : action === 'manage-domain'
          ? ['owner', 'admin'].includes(role)
          : action === 'export'
            ? ['owner', 'admin'].includes(role)
            : role === 'owner'
    if (!permitted) throw new ManagedCloudError('WORKSPACE_ACTION_DENIED')
    return {
      tenantId: matched.tenant_id,
      organizationId: matched.organization_id,
      workspaceId: matched.workspace_id,
    }
  }
}

export class PostgresAccountWorkspaceProvisioner implements AccountWorkspacePort {
  readonly #pool: Pool
  constructor(pool: Pool) {
    this.#pool = pool
  }
  async ensure(input: Parameters<AccountWorkspacePort['ensure']>[0]) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.tenant_id',$1,true),
                set_config('app.organization_id',$2,true),
                set_config('app.workspace_id',$3,true)`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.organizations(organization_id,name,status)
         VALUES ($1,$2,'active') ON CONFLICT (organization_id) DO NOTHING`,
        [input.scope.organizationId, input.displayName],
      )
      await client.query(
        `INSERT INTO persistent_codex.principal_identities(issuer,subject,status)
         VALUES ($1,$2,'active')
         ON CONFLICT (issuer,subject) DO NOTHING`,
        [input.issuer, input.subject],
      )
      await client.query(
        `INSERT INTO persistent_codex.organization_memberships
           (organization_id,issuer,subject,role,status)
         VALUES ($1,$2,$3,'owner','active')
         ON CONFLICT (organization_id,issuer,subject) DO NOTHING`,
        [input.scope.organizationId, input.issuer, input.subject],
      )
      await client.query(
        `INSERT INTO persistent_codex.workspaces
           (tenant_id,organization_id,workspace_id,name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (organization_id,workspace_id) DO NOTHING`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          input.workspaceName,
        ],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

const withScope = async <T>(
  pool: Pool,
  scope: ManagedCloudScope,
  run: (client: PoolClient) => Promise<T>,
) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `SELECT set_config('app.tenant_id',$1,true),
              set_config('app.organization_id',$2,true),
              set_config('app.workspace_id',$3,true)`,
      [scope.tenantId, scope.organizationId, scope.workspaceId],
    )
    const value = await run(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

const parseOnboarding = (row: Record<string, unknown>) =>
  onboardingRecordSchema.parse({
    schemaVersion: 1,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    onboardingId: row.onboarding_id,
    accountId: row.account_id,
    emailDigest: row.email_digest,
    state: row.state,
    planId: row.plan_id,
    planVersion: Number(row.plan_version),
    providerProfileId: row.provider_profile_id,
    firstTaskId: row.first_task_id,
    idempotencyKey: row.idempotency_key,
    version: Number(row.version),
  })

const parseDomain = (row: Record<string, unknown>) =>
  domainVerificationSchema.parse({
    schemaVersion: 1,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    domain: row.domain,
    challengeDigest: row.challenge_digest,
    state: row.state,
    httpsState: row.https_state,
    version: Number(row.version),
  })

export class PostgresManagedCloudRepository implements ManagedCloudRepository {
  readonly #pool: Pool
  constructor(pool: Pool) {
    this.#pool = pool
  }

  async getOnboarding(scope: ManagedCloudScope, idempotencyKey: string) {
    return withScope(this.#pool, scope, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM persistent_codex.managed_cloud_onboardings
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND idempotency_key=$4`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          idempotencyKey,
        ],
      )
      return result.rows[0] ? parseOnboarding(result.rows[0]) : undefined
    })
  }

  async putOnboarding(value: OnboardingRecord, expectedVersion: number | null) {
    await withScope(this.#pool, value, async (client) => {
      if (expectedVersion === null) {
        const result = await client.query(
          `INSERT INTO persistent_codex.managed_cloud_onboardings
             (tenant_id,organization_id,workspace_id,onboarding_id,account_id,
              email_digest,state,plan_id,plan_version,provider_profile_id,
              first_task_id,idempotency_key,version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (tenant_id,organization_id,idempotency_key) DO NOTHING`,
          [
            value.tenantId,
            value.organizationId,
            value.workspaceId,
            value.onboardingId,
            value.accountId,
            value.emailDigest,
            value.state,
            value.planId,
            value.planVersion,
            value.providerProfileId,
            value.firstTaskId,
            value.idempotencyKey,
            value.version,
          ],
        )
        if (result.rowCount !== 1)
          throw new ManagedCloudError('ONBOARDING_VERSION_CONFLICT')
        return
      }
      const result = await client.query(
        `UPDATE persistent_codex.managed_cloud_onboardings
         SET state=$1,provider_profile_id=$2,first_task_id=$3,version=$4,
             updated_at=now()
         WHERE tenant_id=$5 AND organization_id=$6 AND workspace_id=$7
           AND onboarding_id=$8 AND version=$9`,
        [
          value.state,
          value.providerProfileId,
          value.firstTaskId,
          value.version,
          value.tenantId,
          value.organizationId,
          value.workspaceId,
          value.onboardingId,
          expectedVersion,
        ],
      )
      if (result.rowCount !== 1)
        throw new ManagedCloudError('ONBOARDING_VERSION_CONFLICT')
    })
  }

  async getDomain(scope: ManagedCloudScope) {
    return withScope(this.#pool, scope, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM persistent_codex.managed_cloud_domains
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3`,
        [scope.tenantId, scope.organizationId, scope.workspaceId],
      )
      return result.rows[0] ? parseDomain(result.rows[0]) : undefined
    })
  }

  async putDomain(value: DomainVerification, expectedVersion: number | null) {
    const parsed = domainVerificationSchema.parse(value)
    await withScope(this.#pool, parsed, async (client) => {
      if (expectedVersion === null) {
        const result = await client.query(
          `INSERT INTO persistent_codex.managed_cloud_domains
             (tenant_id,organization_id,workspace_id,domain,challenge_digest,
              state,https_state,version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [
            parsed.tenantId,
            parsed.organizationId,
            parsed.workspaceId,
            parsed.domain,
            parsed.challengeDigest,
            parsed.state,
            parsed.httpsState,
            parsed.version,
          ],
        )
        if (result.rowCount !== 1)
          throw new ManagedCloudError('DOMAIN_VERSION_CONFLICT')
        return
      }
      const result = await client.query(
        `UPDATE persistent_codex.managed_cloud_domains
         SET domain=$1,challenge_digest=$2,state=$3,https_state=$4,version=$5,
             updated_at=now()
         WHERE tenant_id=$6 AND organization_id=$7 AND workspace_id=$8
           AND version=$9`,
        [
          parsed.domain,
          parsed.challengeDigest,
          parsed.state,
          parsed.httpsState,
          parsed.version,
          parsed.tenantId,
          parsed.organizationId,
          parsed.workspaceId,
          expectedVersion,
        ],
      )
      if (result.rowCount !== 1)
        throw new ManagedCloudError('DOMAIN_VERSION_CONFLICT')
    })
  }
}
