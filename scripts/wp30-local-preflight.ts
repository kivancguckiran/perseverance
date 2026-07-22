import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import {
  assertAbsoluteCodex,
  assertEnvFileSecurity,
  assertLocalInvariant,
  assertLocalUrl,
  assertPinnedImage,
  composeArgs,
  readLocalEnv,
  readPinnedImages,
  run,
  sha256,
} from './wp30-local'
import { machineEvidence } from './wp30-evidence'

const env = readLocalEnv()
assertLocalInvariant(env)
for (const name of [
  'WP30_TARGET_URL',
  'WP30_DOCKER_TARGET_URL',
  'WP30_REALTIME_URL',
  'WP30_WEB_URL',
  'WP30_AGENT_URL',
] as const)
  assertLocalUrl(name, env[name]!)
assertEnvFileSecurity()
assertAbsoluteCodex(env.WP30_CODEX_BIN)
assert.equal(
  run('docker', ['info'], { allowFailure: true }).status,
  0,
  'Docker daemon unavailable',
)
for (const [name, image] of Object.entries(readPinnedImages())) {
  assert.equal(env[name], image, `${name} differs from the reviewed pin`)
  assertPinnedImage(image)
}
const serviceOutput = run(
  'docker',
  composeArgs('ps', '--format', 'json'),
).stdout.trim()
const services = serviceOutput.startsWith('[')
  ? JSON.parse(serviceOutput)
  : serviceOutput
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
const rows = Array.isArray(services) ? services : [services]
for (const service of [
  'postgres',
  'cache',
  'broker',
  'object-storage',
  'oidc-stub',
  'workspace-agent',
  'control-plane',
  'web',
]) {
  const row = rows.find((value: any) => value.Service === service)
  assert(row, `missing service ${service}`)
  assert.equal(row.State, 'running', `${service} is not running`)
}

const pool = new pg.Pool({
  host: env.WP30_POSTGRES_HOST,
  port: Number(env.WP30_POSTGRES_PORT),
  database: env.WP30_POSTGRES_DATABASE,
  user: env.WP30_POSTGRES_USER,
  password: env.WP30_POSTGRES_PASSWORD,
})
try {
  const seeded = JSON.parse(
    readFileSync(join(process.cwd(), '.wp30/seed.json'), 'utf8'),
  ) as { sessionA: string; sessionB: string }
  const entities = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM persistent_codex.organizations) organizations,
       (SELECT count(*)::int FROM persistent_codex.principal_identities) identities,
       (SELECT count(*)::int FROM persistent_codex.organization_memberships) memberships,
       (SELECT count(*)::int FROM persistent_codex.workspaces) workspaces,
       (SELECT count(*)::int FROM persistent_codex.ha_sessions) sessions,
       (SELECT count(*)::int FROM persistent_codex.sessions) conversation_records,
       (SELECT count(*)::int FROM persistent_codex.artifacts) artifacts,
       (SELECT count(*)::int FROM persistent_codex.tenant_scheduling_policies) scheduling_policies`,
  )
  const counts = entities.rows[0]
  for (const [name, count] of Object.entries(counts))
    assert(Number(count) >= (name === 'sessions' ? 2 : 1), `${name} missing`)
  const sessions = await pool.query(
    `SELECT session_id FROM persistent_codex.ha_sessions WHERE session_id=ANY($1)`,
    [[seeded.sessionA, seeded.sessionB]],
  )
  assert.equal(sessions.rowCount, 2)
  const rls = await pool.query(
    `SELECT count(*)::int count FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='persistent_codex' AND c.relrowsecurity AND c.relforcerowsecurity`,
  )
  assert(Number(rls.rows[0].count) >= 20)
} finally {
  await pool.end()
}

const scopedHeaders = {
  authorization: `Bearer ${env.WP30_TENANT_A_TOKEN}`,
  'x-tenant-id': env.WP30_TENANT_A_ID,
  'x-organization-id': env.WP30_TENANT_A_ORG_ID,
  'x-workspace-id': env.WP30_TENANT_A_WORKSPACE_ID,
}
const own = await fetch(
  `${env.WP30_TARGET_URL}/v1/workspaces/${env.WP30_TENANT_A_WORKSPACE_ID}`,
  { headers: scopedHeaders },
)
assert.equal(own.status, 200)
const invalidToken = await fetch(
  `${env.WP30_TARGET_URL}/v1/workspaces/${env.WP30_TENANT_A_WORKSPACE_ID}`,
  { headers: { ...scopedHeaders, authorization: 'Bearer invalid' } },
)
assert.equal(invalidToken.status, 401)
const foreignScope = await fetch(
  `${env.WP30_TARGET_URL}/v1/workspaces/${env.WP30_TENANT_B_WORKSPACE_ID}`,
  {
    headers: {
      ...scopedHeaders,
      'x-tenant-id': env.WP30_TENANT_B_ID,
      'x-organization-id': env.WP30_TENANT_B_ORG_ID,
      'x-workspace-id': env.WP30_TENANT_B_WORKSPACE_ID,
    },
  },
)
assert.equal(foreignScope.status, 403)
const rlsHidden = await fetch(
  `${env.WP30_TARGET_URL}/v1/workspaces/${env.WP30_TENANT_B_WORKSPACE_ID}`,
  { headers: scopedHeaders },
)
assert.equal(rlsHidden.status, 404)
const codexVersion = run('docker', [
  'compose',
  '--project-name',
  'persistent-wp30-local',
  '--env-file',
  join(process.cwd(), '.wp30/local.env'),
  '-f',
  join(process.cwd(), 'infra/wp30-local/compose.yml'),
  'exec',
  '-T',
  'workspace-agent',
  '/app/codex/bin/codex.js',
  '--version',
]).stdout.trim()
assert.match(codexVersion, /0\.144\.2/)

machineEvidence('wp30:local:preflight', {
  accepted: true,
  status: 'passed',
  evidenceClass: 'local-operator',
  externalProductionReady: false,
  targetScope: 'loopback-only',
  realSchemaSeedVerified: true,
  authMiddlewareVerified: true,
  tenantAuthorizationStatus: foreignScope.status,
  rlsHiddenStatus: rlsHidden.status,
  codexVersion,
  tokenFingerprints: [
    sha256(env.WP30_TENANT_A_TOKEN),
    sha256(env.WP30_TENANT_B_TOKEN),
  ],
  pinnedImagesVerified: Object.keys(readPinnedImages()).sort(),
})
