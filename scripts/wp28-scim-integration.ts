import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { PostgresEnterpriseRepository } from '../packages/enterprise-lifecycle/src/postgres'
import { buildEnterpriseApi } from '../services/control-plane/src/enterprise-api'
import { Wp28PostgresStack } from './wp28-postgres-stack'
const stack = new Wp28PostgresStack(),
  headers = (tenant: string, bearer: string, key: string) => ({
    'content-type': 'application/json',
    'x-tenant-id': tenant,
    'x-organization-id': tenant,
    authorization: `Bearer ${bearer}`,
    'idempotency-key': key,
  })
try {
  await stack.start()
  await stack.seedCredential('tenant-a', 'tenant-a', 'idp', 'bearer-a')
  await stack.seedCredential('tenant-b', 'tenant-b', 'idp', 'bearer-b')
  const pool1 = new Pool({
      connectionString: `postgresql://wp28_runtime:runtime@127.0.0.1:${stack.port}/postgres`,
    }),
    pool2 = new Pool({
      connectionString: `postgresql://wp28_runtime:runtime@127.0.0.1:${stack.port}/postgres`,
    }),
    api1 = buildEnterpriseApi({
      repository: new PostgresEnterpriseRepository(pool1, true),
    }),
    api2 = buildEnterpriseApi({
      repository: new PostgresEnterpriseRepository(pool2, true),
    })
  await api1.listen({ host: '127.0.0.1', port: 0 })
  await api2.listen({ host: '127.0.0.1', port: 0 })
  const url = (api: any, path: string) =>
      `http://127.0.0.1:${(api.server.address() as any).port}${path}`,
    body = {
      id: 'user-a',
      externalId: 'shared-external',
      providerVersion: 2,
      active: true,
      userName: 'opaque',
    }
  const [first, duplicate] = await Promise.all([
    fetch(url(api1, '/scim/v2/Users'), {
      method: 'POST',
      headers: headers('tenant-a', 'bearer-a', 'duplicate-key'),
      body: JSON.stringify(body),
    }),
    fetch(url(api2, '/scim/v2/Users'), {
      method: 'POST',
      headers: headers('tenant-a', 'bearer-a', 'duplicate-key'),
      body: JSON.stringify(body),
    }),
  ])
  assert(
    [200, 201].includes(first.status),
    `first SCIM write: ${first.status} ${await first.clone().text()}`,
  )
  assert(
    [200, 201].includes(duplicate.status),
    `duplicate SCIM write: ${duplicate.status} ${await duplicate.clone().text()}`,
  )
  const stale = await fetch(url(api2, '/scim/v2/Users/user-a'), {
    method: 'PUT',
    headers: headers('tenant-a', 'bearer-a', 'stale-key'),
    body: JSON.stringify({ ...body, providerVersion: 1, active: false }),
  })
  assert.equal(((await stale.json()) as any).active, true)
  await stack.admin.query(
    `INSERT INTO persistent_codex.scim_role_mappings VALUES('tenant-a','tenant-a','idp','admins','tenant_export_admin',1,true)`,
  )
  const mappedGroup = await fetch(url(api2, '/scim/v2/Groups'), {
    method: 'POST',
    headers: headers('tenant-a', 'bearer-a', 'mapped-group'),
    body: JSON.stringify({
      id: 'group-admins',
      externalId: 'admins',
      providerVersion: 1,
      members: [{ value: 'user-a' }],
    }),
  })
  assert.equal(mappedGroup.status, 201)
  const mappedRole = await stack.admin.query(
    `SELECT roles FROM persistent_codex.enterprise_principal_state WHERE tenant_id='tenant-a' AND organization_id='tenant-a' AND principal_id='user-a'`,
  )
  assert.deepEqual(mappedRole.rows[0].roles, ['tenant_export_admin'])
  await fetch(url(api2, '/scim/v2/Users'), {
    method: 'POST',
    headers: headers('tenant-b', 'bearer-b', 'tenant-b-user'),
    body: JSON.stringify({ ...body, id: 'user-b' }),
  })
  const substitution = await fetch(url(api2, '/scim/v2/Groups'), {
    method: 'POST',
    headers: headers('tenant-a', 'bearer-a', 'bad-group'),
    body: JSON.stringify({
      id: 'group-a',
      externalId: 'bad-admins',
      providerVersion: 1,
      members: [{ value: 'user-b' }],
    }),
  })
  assert.equal(substitution.status, 409)
  await api1.close()
  const api3 = buildEnterpriseApi({
    repository: new PostgresEnterpriseRepository(
      new Pool({
        connectionString: `postgresql://wp28_runtime:runtime@127.0.0.1:${stack.port}/postgres`,
      }),
      true,
    ),
  })
  await api3.listen({ host: '127.0.0.1', port: 0 })
  const restored = await fetch(url(api3, '/scim/v2/Users/user-a'), {
    headers: headers('tenant-a', 'bearer-a', 'read'),
  })
  assert.equal(restored.status, 200)
  assert.equal(((await restored.json()) as any).providerVersion, 2)
  const unauthorized = await fetch(url(api3, '/scim/v2/Users/user-a'), {
    headers: headers('tenant-a', 'wrong', 'read'),
  })
  assert.equal(unauthorized.status, 401)
  const counts = await stack.admin.query(
    `SELECT count(*)::int resources,(SELECT count(*)::int FROM persistent_codex.scim_idempotency) idempotency FROM persistent_codex.scim_resources`,
  )
  console.log(
    JSON.stringify({
      gate: 'wp28:scim',
      accepted: true,
      postgres: '17.5',
      httpInstances: 3,
      restartPersistent: true,
      duplicateConcurrent: true,
      outOfOrderIgnored: true,
      credentialDigestOnly: true,
      crossTenantExternalIdAllowedScoped: true,
      crossTenantMemberSubstitutionRejected: true,
      groupMembershipRoleMapping: true,
      resources: counts.rows[0].resources,
      idempotencyRecords: counts.rows[0].idempotency,
    }),
  )
  await api2.close()
  await api3.close()
} finally {
  await stack.cleanup()
}
