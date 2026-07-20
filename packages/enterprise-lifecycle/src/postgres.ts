import { Pool, type PoolClient } from 'pg'
import { scimResourceSchema, type ScimResource } from './contracts'

type Scope = { tenantId: string; organizationId: string }
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
  async upsertScim(
    input: Omit<ScimResource, 'schemaVersion' | 'version' | 'updatedAt'> & {
      idempotencyKey: string
    },
  ) {
    return this.#tx(
      { tenantId: input.tenantId, organizationId: input.organizationId },
      async (client) => {
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
      },
    )
  }
  async close() {
    if (this.ownsPool) await this.pool.end()
  }
}
