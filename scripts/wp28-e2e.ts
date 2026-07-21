import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { codexV2 } from '../packages/codex-protocol-generated/src/index'
import { PostgresEnterpriseRepository } from '../packages/enterprise-lifecycle/src/postgres'
import {
  CodexAppServerClient,
  createIsolatedCodexHome,
} from '../agents/workspace-agent/src/index'
import { buildEnterpriseApi } from '../services/control-plane/src/enterprise-api'
import { Wp28PostgresStack } from './wp28-postgres-stack'

const codexBin = process.env.WP28_CODEX_BIN
if (!codexBin) throw new Error('WP28_CODEX_BIN must point to Codex 0.144.2')
assert.match(
  execFileSync(codexBin, ['--version'], { encoding: 'utf8' }),
  /0\.144\.2/,
)
const stack = new Wp28PostgresStack()
const isolated = createIsolatedCodexHome({
  sourceHome:
    process.env.CODEX_PROVISIONING_SOURCE ?? join(homedir(), '.codex'),
  includeConfig: false,
})
const client = new CodexAppServerClient({
  command: codexBin,
  cwd: process.cwd(),
  env: { ...process.env, CODEX_HOME: isolated.path },
  requestTimeoutMs: 180000,
  restart: { maxRestarts: 0 },
})
const scope = { tenantId: 'tenant-e2e', organizationId: 'tenant-e2e' }
const principalId = 'user-active-turn'
const workspaceId = 'workspace-active-turn'
const sessionId = 'session-active-turn'
const runId = 'run-active-turn'
let api: ReturnType<typeof buildEnterpriseApi> | undefined
const notifications: Array<{ method: string; errorCode?: string }> = []
client.onNotification((message) => {
  const params = message.params as any
  notifications.push({
    method: message.method,
    errorCode:
      message.method === 'error'
        ? String(params?.error?.codexErrorInfo ?? '')
        : undefined,
  })
})

try {
  await stack.start()
  // The queried columns and states are the production scheduler/support schema.
  await stack.admin.query(`
    CREATE TABLE persistent_codex.support_grants(
      tenant_id text NOT NULL,organization_id text NOT NULL,workspace_id text NOT NULL,
      grant_id text NOT NULL,requester_principal_id text NOT NULL,support_principal_id text NOT NULL,
      status text NOT NULL,version bigint NOT NULL,revoked_at timestamptz,
      PRIMARY KEY(tenant_id,organization_id,workspace_id,grant_id));
    CREATE TABLE persistent_codex.workspace_leases(
      tenant_id text NOT NULL,organization_id text NOT NULL,workspace_id text NOT NULL,
      lease_id text NOT NULL,state text NOT NULL,
      PRIMARY KEY(tenant_id,organization_id,workspace_id,lease_id));
    CREATE TABLE persistent_codex.ha_runs(
      tenant_id text NOT NULL,organization_id text NOT NULL,workspace_id text NOT NULL,
      run_id text NOT NULL,state text NOT NULL,terminal_outcome text,terminal_at timestamptz,updated_at timestamptz NOT NULL,
      PRIMARY KEY(tenant_id,organization_id,workspace_id,run_id));
    GRANT SELECT,INSERT,UPDATE,DELETE ON persistent_codex.support_grants,persistent_codex.workspace_leases,persistent_codex.ha_runs TO wp28_runtime;
  `)
  for (const table of ['support_grants', 'workspace_leases', 'ha_runs'])
    await stack.admin.query(
      `ALTER TABLE persistent_codex.${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE persistent_codex.${table} FORCE ROW LEVEL SECURITY;CREATE POLICY wp28_tenant_scope ON persistent_codex.${table} USING (persistent_codex.wp28_scope_ok(tenant_id,organization_id)) WITH CHECK (persistent_codex.wp28_scope_ok(tenant_id,organization_id))`,
    )

  await stack.seedCredential(
    scope.tenantId,
    scope.organizationId,
    'keycloak-scim',
    'wp28-scim-bearer-marker',
  )
  api = buildEnterpriseApi({
    repository: new PostgresEnterpriseRepository(stack.runtime),
  })
  await api.listen({ host: '127.0.0.1', port: 0 })
  const address = api.server.address()
  if (!address || typeof address === 'string')
    throw new Error('SCIM address unavailable')
  const base = `http://127.0.0.1:${address.port}`
  const scimHeaders = (key: string) => ({
    'content-type': 'application/json',
    'x-tenant-id': scope.tenantId,
    'x-organization-id': scope.organizationId,
    authorization: 'Bearer wp28-scim-bearer-marker',
    'idempotency-key': key,
  })
  const provision = await fetch(`${base}/scim/v2/Users`, {
    method: 'POST',
    headers: scimHeaders('provision-active-user'),
    body: JSON.stringify({
      id: principalId,
      externalId: 'idp-active-user',
      providerVersion: 1,
      active: true,
      userName: 'opaque',
    }),
  })
  assert.equal(provision.status, 201)
  await stack.admin.query(
    `UPDATE persistent_codex.enterprise_principal_state SET roles=ARRAY['tenant_export_admin'] WHERE tenant_id=$1 AND organization_id=$2 AND principal_id=$3`,
    [scope.tenantId, scope.organizationId, principalId],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.enterprise_login_sessions VALUES($1,$2,$3,$4,'active',null)`,
    [scope.tenantId, scope.organizationId, principalId, sessionId],
  )
  for (const [id, kind] of [
    ['access-active-turn', 'access'],
    ['refresh-active-turn', 'refresh'],
  ])
    await stack.admin.query(
      `INSERT INTO persistent_codex.enterprise_tokens VALUES($1,$2,$3,$4,$5,'active',null)`,
      [scope.tenantId, scope.organizationId, principalId, id, kind],
    )
  await stack.admin.query(
    `INSERT INTO persistent_codex.enterprise_realtime_connections VALUES($1,$2,$3,'realtime-active-turn','open',null)`,
    [scope.tenantId, scope.organizationId, principalId],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.enterprise_credential_cache VALUES($1,$2,$3,'credential-active-turn',1,'active')`,
    [scope.tenantId, scope.organizationId, principalId],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.enterprise_runtime_bindings VALUES($1,$2,$3,$4,$5,$6,true)`,
    [
      scope.tenantId,
      scope.organizationId,
      principalId,
      workspaceId,
      sessionId,
      runId,
    ],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.support_grants VALUES($1,$2,$3,'support-active-turn',$4,'support-user','active',1,null)`,
    [scope.tenantId, scope.organizationId, workspaceId, principalId],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.workspace_leases VALUES($1,$2,$3,'lease-active-turn','active')`,
    [scope.tenantId, scope.organizationId, workspaceId],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.ha_runs VALUES($1,$2,$3,$4,'running',null,null,now())`,
    [scope.tenantId, scope.organizationId, workspaceId, runId],
  )

  await client.initialize({
    name: 'wp28_lifecycle',
    title: 'WP28 lifecycle',
    version: '1',
  })
  const thread = await client.request<codexV2.ThreadStartResponse>(
    'thread/start',
    { cwd: process.cwd() } satisfies codexV2.ThreadStartParams,
  )
  const turn = await client.request<codexV2.TurnStartResponse>('turn/start', {
    threadId: thread.thread.id,
    input: [
      {
        type: 'text',
        text: 'Use the shell tool to run `sleep 30`, then answer TAMAM.',
        text_elements: [],
      },
    ],
  } satisfies codexV2.TurnStartParams)
  assert(client.running)
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      notifications.some(
        (notification) => notification.method === 'turn/started',
      )
    )
      break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert(
    notifications.some(
      (notification) => notification.method === 'turn/started',
    ),
    'Codex app-server did not enter active turn state',
  )

  const deprovision = await fetch(`${base}/scim/v2/Users/${principalId}`, {
    method: 'PUT',
    headers: scimHeaders('deprovision-active-user'),
    body: JSON.stringify({
      externalId: 'idp-active-user',
      providerVersion: 2,
      active: false,
      userName: 'opaque',
    }),
  })
  assert.equal(deprovision.status, 200)

  const durable = await stack.admin.query(
    `SELECT
      (SELECT active=false AND admission_cordoned FROM persistent_codex.enterprise_principal_state WHERE tenant_id=$1 AND principal_id=$2) principal_revoked,
      (SELECT bool_and(state='revoked') FROM persistent_codex.enterprise_login_sessions WHERE tenant_id=$1 AND principal_id=$2) sessions_revoked,
      (SELECT bool_and(state='revoked') FROM persistent_codex.enterprise_tokens WHERE tenant_id=$1 AND principal_id=$2) tokens_revoked,
      (SELECT bool_and(state='revoked') FROM persistent_codex.enterprise_realtime_connections WHERE tenant_id=$1 AND principal_id=$2) realtime_revoked,
      (SELECT bool_and(state='revoked') FROM persistent_codex.enterprise_credential_cache WHERE tenant_id=$1 AND principal_id=$2) cache_revoked,
      (SELECT bool_and(status='revoked') FROM persistent_codex.support_grants WHERE tenant_id=$1) support_revoked,
      (SELECT bool_and(state='revoked') FROM persistent_codex.workspace_leases WHERE tenant_id=$1) lease_revoked,
      (SELECT bool_and(state='failed' AND terminal_outcome='interrupted') FROM persistent_codex.ha_runs WHERE tenant_id=$1) run_interrupted,
      (SELECT bool_and(active=false) FROM persistent_codex.enterprise_runtime_bindings WHERE tenant_id=$1 AND principal_id=$2) bindings_drained`,
    [scope.tenantId, principalId],
  )
  assert(Object.values(durable.rows[0]).every(Boolean))
  await client
    .request('turn/interrupt', {
      threadId: thread.thread.id,
      turnId: turn.turn.id,
    })
    .catch((error: Error) => {
      throw new Error(
        `active turn interrupt failed: ${error.message}; notifications=${JSON.stringify(notifications)}`,
      )
    })
  assert(client.running, 'interrupt must not be represented by client.stop()')

  const admissions: Record<string, number> = {}
  for (const operation of ['turn', 'upload', 'export', 'share']) {
    const response = await fetch(
      `${base}/v1/enterprise/admission/${operation}`,
      {
        method: 'POST',
        headers: {
          'x-tenant-id': scope.tenantId,
          'x-organization-id': scope.organizationId,
          'x-principal-id': principalId,
        },
      },
    )
    admissions[operation] = response.status
    assert.equal(response.status, 403)
  }
  process.stdout.write(
    `${JSON.stringify({
      gate: 'wp28:e2e',
      accepted: true,
      codexVersion: '0.144.2',
      realAppServer: true,
      realPostgres: '17.5',
      threadStarted: Boolean(thread.thread.id),
      turnStarted: Boolean(turn.turn.id),
      deprovisionDuringActiveTurn: true,
      durableRepositoryState: durable.rows[0],
      appServerTurnInterrupt: true,
      clientStopUsedAsRevocation: false,
      admissions,
      temporaryCodexHomeCleaned: true,
    })}\n`,
  )
} finally {
  await Promise.allSettled([client.stop(), api?.close() ?? Promise.resolve()])
  isolated.cleanup()
  await stack.cleanup().catch(() => undefined)
  isolated.cleanup()
  assert.equal(
    existsSync(isolated.path),
    false,
    'temporary Codex home cleanup failed',
  )
}
