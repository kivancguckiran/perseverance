import { createHash, timingSafeEqual } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { scimResourceSchema, type ScimResource } from './contracts'

type Scope = { tenantId: string; organizationId: string }
export type ScimWrite = Omit<
  ScimResource,
  'schemaVersion' | 'version' | 'updatedAt'
> & { idempotencyKey: string }
export interface EnterpriseRepository {
  authenticateScim(
    scope: Scope,
    bearer: string,
  ): Promise<{ providerId: string }>
  getScim(
    scope: Scope,
    providerId: string,
    type: 'User' | 'Group',
    id: string,
  ): Promise<ScimResource>
  upsertScim(input: ScimWrite): Promise<ScimResource>
  deprovisionScimUser(
    scope: Scope,
    providerId: string,
    resourceId: string,
    providerVersion: number,
    idempotencyKey: string,
  ): Promise<ScimResource>
  replaceGroupMemberships(input: ScimWrite): Promise<ScimResource>
  assertAdmission(
    scope: Scope,
    principalId: string,
    operation: 'turn' | 'upload' | 'export' | 'share',
  ): Promise<void>
  close?(): Promise<void>
}
export const bearerDigest = (bearer: string) =>
  createHash('sha256').update(bearer).digest('hex')
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value)
const rowToScim = (row: Record<string, unknown>): ScimResource =>
  scimResourceSchema.parse({
    schemaVersion: 1,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    externalId: row.external_id,
    providerId: row.provider_id,
    providerVersion: Number(row.provider_version),
    active: row.active,
    displayName: (row.representation as { displayName: string }).displayName,
    members: (row.representation as { members?: string[] }).members ?? [],
    version: Number(row.version),
    updatedAt: iso(row.updated_at),
  })

export class PostgresEnterpriseRepository {
  readonly adapter = 'postgresql' as const
  readonly pool: Pool
  readonly ownsPool: boolean
  constructor(pool: Pool, ownsPool = false) {
    this.pool = pool
    this.ownsPool = ownsPool
  }
  async authenticateScim(scope: Scope, bearer: string) {
    const supplied = Buffer.from(bearerDigest(bearer), 'hex')
    return this.#tx(scope, async (client) => {
      const rows = await client.query(
        `SELECT provider_id,credential_digest FROM persistent_codex.scim_credentials WHERE tenant_id=$1 AND organization_id=$2 AND active`,
        [scope.tenantId, scope.organizationId],
      )
      const match = rows.rows.find((row) => {
        const expected = Buffer.from(String(row.credential_digest), 'hex')
        return (
          expected.length === supplied.length &&
          timingSafeEqual(expected, supplied)
        )
      })
      if (!match)
        throw Object.assign(new Error('SCIM_UNAUTHORIZED'), {
          code: 'SCIM_UNAUTHORIZED',
        })
      return { providerId: String(match.provider_id) }
    })
  }
  async getScim(
    scope: Scope,
    providerId: string,
    type: 'User' | 'Group',
    id: string,
  ) {
    return this.#tx(scope, async (client) => {
      const row = (
        await client.query(
          `SELECT * FROM persistent_codex.scim_resources WHERE tenant_id=$1 AND organization_id=$2 AND provider_id=$3 AND resource_type=$4 AND resource_id=$5`,
          [scope.tenantId, scope.organizationId, providerId, type, id],
        )
      ).rows[0]
      if (!row)
        throw Object.assign(new Error('SCIM_NOT_FOUND'), {
          code: 'SCIM_NOT_FOUND',
        })
      return rowToScim(row)
    })
  }
  async #tx<T>(scope: Scope, fn: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.tenant_id',$1,true),set_config('app.organization_id',$2,true)`,
        [scope.tenantId, scope.organizationId],
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
  async upsertScim(input: ScimWrite) {
    return this.#tx(
      { tenantId: input.tenantId, organizationId: input.organizationId },
      async (client) => {
        const value = await this.#upsertScimClient(client, input)
        if (value.resourceType === 'User' && value.active)
          await this.#syncUserPrincipal(client, value)
        return value
      },
    )
  }
  async replaceGroupMemberships(input: ScimWrite) {
    return this.#tx(
      { tenantId: input.tenantId, organizationId: input.organizationId },
      async (client) => {
        const group = await this.#upsertScimClient(client, input)
        if (input.providerVersion < group.providerVersion) return group
        for (const userResourceId of input.members) {
          const user = (
            await client.query(
              `SELECT 1 FROM persistent_codex.scim_resources WHERE tenant_id=$1 AND organization_id=$2 AND provider_id=$3 AND resource_type='User' AND resource_id=$4`,
              [
                input.tenantId,
                input.organizationId,
                input.providerId,
                userResourceId,
              ],
            )
          ).rows[0]
          if (!user)
            throw Object.assign(new Error('SCIM_MEMBER_SCOPE_INVALID'), {
              code: 'SCIM_MEMBER_SCOPE_INVALID',
            })
        }
        await client.query(
          `UPDATE persistent_codex.scim_group_memberships SET active=false,provider_version=$5,updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND provider_id=$3 AND group_resource_id=$4`,
          [
            input.tenantId,
            input.organizationId,
            input.providerId,
            input.resourceId,
            input.providerVersion,
          ],
        )
        for (const user of input.members)
          await client.query(
            `INSERT INTO persistent_codex.scim_group_memberships(tenant_id,organization_id,provider_id,group_resource_id,user_resource_id,provider_version,active) VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(tenant_id,organization_id,provider_id,group_resource_id,user_resource_id) DO UPDATE SET provider_version=EXCLUDED.provider_version,active=true,updated_at=now() WHERE EXCLUDED.provider_version>persistent_codex.scim_group_memberships.provider_version`,
            [
              input.tenantId,
              input.organizationId,
              input.providerId,
              input.resourceId,
              user,
              input.providerVersion,
            ],
          )
        await this.#recomputeRoles(client, input)
        return group
      },
    )
  }
  async #syncUserPrincipal(client: PoolClient, value: ScimResource) {
    await client.query(
      `INSERT INTO persistent_codex.enterprise_principal_state(tenant_id,organization_id,principal_id,scim_resource_id,active,roles,admission_cordoned,revocation_epoch) VALUES($1,$2,$3,$3,true,'{}',false,0) ON CONFLICT(tenant_id,organization_id,scim_resource_id) DO UPDATE SET active=true,admission_cordoned=false,updated_at=now()`,
      [value.tenantId, value.organizationId, value.resourceId],
    )
  }
  async #recomputeRoles(client: PoolClient, input: ScimWrite) {
    await client.query(
      `UPDATE persistent_codex.enterprise_principal_state p SET roles=COALESCE((
         SELECT array_agg(DISTINCT rm.role_key ORDER BY rm.role_key)
         FROM persistent_codex.scim_group_memberships gm
         JOIN persistent_codex.scim_resources g ON g.tenant_id=gm.tenant_id AND g.organization_id=gm.organization_id AND g.provider_id=gm.provider_id AND g.resource_type='Group' AND g.resource_id=gm.group_resource_id
         JOIN persistent_codex.scim_role_mappings rm ON rm.tenant_id=g.tenant_id AND rm.organization_id=g.organization_id AND rm.provider_id=g.provider_id AND rm.group_external_id=g.external_id AND rm.active
         WHERE gm.tenant_id=p.tenant_id AND gm.organization_id=p.organization_id AND gm.user_resource_id=p.scim_resource_id AND gm.active AND g.active
       ),'{}') WHERE p.tenant_id=$1 AND p.organization_id=$2`,
      [input.tenantId, input.organizationId],
    )
  }
  async #upsertScimClient(client: PoolClient, input: ScimWrite) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
      `${input.tenantId}:${input.organizationId}:${input.providerId}:${input.idempotencyKey}`,
    ])
    const duplicate = await client.query(
      `SELECT r.* FROM persistent_codex.scim_idempotency i JOIN persistent_codex.scim_resources r USING(tenant_id,organization_id,provider_id,resource_type,resource_id) WHERE i.tenant_id=$1 AND i.organization_id=$2 AND i.provider_id=$3 AND i.idempotency_key=$4`,
      [
        input.tenantId,
        input.organizationId,
        input.providerId,
        input.idempotencyKey,
      ],
    )
    if (duplicate.rows[0]) return rowToScim(duplicate.rows[0])
    const result = await client.query(
      `INSERT INTO persistent_codex.scim_resources(tenant_id,organization_id,provider_id,resource_type,resource_id,external_id,provider_version,active,representation,version,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,now()) ON CONFLICT(tenant_id,organization_id,provider_id,resource_type,resource_id) DO UPDATE SET external_id=EXCLUDED.external_id,provider_version=EXCLUDED.provider_version,active=EXCLUDED.active,representation=EXCLUDED.representation,version=persistent_codex.scim_resources.version+1,updated_at=now() WHERE EXCLUDED.provider_version>persistent_codex.scim_resources.provider_version RETURNING *`,
      [
        input.tenantId,
        input.organizationId,
        input.providerId,
        input.resourceType,
        input.resourceId,
        input.externalId,
        input.providerVersion,
        input.active,
        JSON.stringify({
          displayName: input.displayName,
          members: input.members,
        }),
      ],
    )
    const current =
      result.rows[0] ??
      (
        await client.query(
          `SELECT * FROM persistent_codex.scim_resources WHERE tenant_id=$1 AND organization_id=$2 AND provider_id=$3 AND resource_type=$4 AND resource_id=$5`,
          [
            input.tenantId,
            input.organizationId,
            input.providerId,
            input.resourceType,
            input.resourceId,
          ],
        )
      ).rows[0]
    await client.query(
      `INSERT INTO persistent_codex.scim_idempotency(tenant_id,organization_id,provider_id,idempotency_key,resource_type,resource_id,provider_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        input.tenantId,
        input.organizationId,
        input.providerId,
        input.idempotencyKey,
        input.resourceType,
        input.resourceId,
        input.providerVersion,
      ],
    )
    return rowToScim(current)
  }
  async deprovisionScimUser(
    scope: Scope,
    providerId: string,
    resourceId: string,
    providerVersion: number,
    idempotencyKey: string,
  ) {
    return this.#tx(scope, async (client) => {
      const prior = (
        await client.query(
          `SELECT * FROM persistent_codex.scim_resources WHERE tenant_id=$1 AND organization_id=$2 AND provider_id=$3 AND resource_type='User' AND resource_id=$4 FOR UPDATE`,
          [scope.tenantId, scope.organizationId, providerId, resourceId],
        )
      ).rows[0]
      if (!prior)
        throw Object.assign(new Error('SCIM_NOT_FOUND'), {
          code: 'SCIM_NOT_FOUND',
        })
      const value = await this.#upsertScimClient(client, {
        ...rowToScim(prior),
        providerVersion,
        active: false,
        idempotencyKey,
      })
      if (value.active) return value
      const principal = (
        await client.query(
          `UPDATE persistent_codex.enterprise_principal_state SET active=false,admission_cordoned=true,revocation_epoch=revocation_epoch+1,updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND scim_resource_id=$3 RETURNING principal_id`,
          [scope.tenantId, scope.organizationId, resourceId],
        )
      ).rows[0]
      if (principal) {
        const p = principal.principal_id
        const parameters = [scope.tenantId, scope.organizationId, p]
        for (const statement of [
          `UPDATE persistent_codex.enterprise_login_sessions SET state='revoked',revoked_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND principal_id=$3 AND state='active'`,
          `UPDATE persistent_codex.enterprise_tokens SET state='revoked',revoked_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND principal_id=$3 AND state='active'`,
          `UPDATE persistent_codex.enterprise_realtime_connections SET state='revoked',revoked_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND principal_id=$3 AND state='open'`,
          `UPDATE persistent_codex.enterprise_credential_cache SET state='revoked',cache_epoch=cache_epoch+1 WHERE tenant_id=$1 AND organization_id=$2 AND principal_id=$3`,
          `UPDATE persistent_codex.support_grants SET status='revoked',version=version+1,revoked_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND (requester_principal_id=$3 OR support_principal_id=$3) AND status='active'`,
          `UPDATE persistent_codex.workspace_leases l SET state='revoked' FROM persistent_codex.enterprise_runtime_bindings b WHERE b.tenant_id=$1 AND b.organization_id=$2 AND b.principal_id=$3 AND b.active AND l.tenant_id=b.tenant_id AND l.organization_id=b.organization_id AND l.workspace_id=b.workspace_id AND l.state='active'`,
          `UPDATE persistent_codex.ha_runs r SET state='failed',terminal_outcome='interrupted',terminal_at=now(),updated_at=now() FROM persistent_codex.enterprise_runtime_bindings b WHERE b.tenant_id=$1 AND b.organization_id=$2 AND b.principal_id=$3 AND b.active AND r.tenant_id=b.tenant_id AND r.organization_id=b.organization_id AND r.workspace_id=b.workspace_id AND (b.run_id IS NULL OR r.run_id=b.run_id) AND r.state IN('queued','leased','starting','running')`,
          `UPDATE persistent_codex.enterprise_runtime_bindings SET active=false WHERE tenant_id=$1 AND organization_id=$2 AND principal_id=$3`,
        ])
          await client.query(statement, parameters)
      }
      return value
    })
  }
  async assertAdmission(
    scope: Scope,
    principalId: string,
    operation: 'turn' | 'upload' | 'export' | 'share',
  ) {
    return this.#tx(scope, async (client) => {
      const row = (
        await client.query(
          `SELECT active,admission_cordoned,roles FROM persistent_codex.enterprise_principal_state WHERE tenant_id=$1 AND organization_id=$2 AND principal_id=$3`,
          [scope.tenantId, scope.organizationId, principalId],
        )
      ).rows[0]
      if (!row || !row.active || row.admission_cordoned)
        throw Object.assign(
          new Error(`ADMISSION_${operation.toUpperCase()}_DENIED`),
          { code: 'PRINCIPAL_DEPROVISIONED' },
        )
      if (operation === 'export' && !row.roles.includes('tenant_export_admin'))
        throw Object.assign(new Error('LIFECYCLE_PRIVILEGE_DENIED'), {
          code: 'LIFECYCLE_PRIVILEGE_DENIED',
        })
    })
  }
  async close() {
    if (this.ownsPool) await this.pool.end()
  }
}
