import assert from 'node:assert/strict'
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
  'object-storage',
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
  const fixtures = await pool.query(
    `SELECT fixture_type,fixture_id,tenant_id,organization_id,workspace_id,token_sha256,expires_at FROM persistent_codex.wp30_local_fixtures ORDER BY fixture_type,fixture_id`,
  )
  for (const expected of [
    ['tenant', 'tenant-a'],
    ['tenant', 'tenant-b'],
    ['token', 'token-a'],
    ['token', 'token-b'],
    ['session', 'session-b'],
    ['object', 'object-b'],
    ['cohort', 'cohort-a'],
  ])
    assert(
      fixtures.rows.some(
        (row) =>
          row.fixture_type === expected[0] && row.fixture_id === expected[1],
      ),
      `missing fixture ${expected.join(':')}`,
    )
  const tokenA = fixtures.rows.find((row) => row.fixture_id === 'token-a')
  const tokenB = fixtures.rows.find((row) => row.fixture_id === 'token-b')
  assert.equal(tokenA.token_sha256, sha256(env.WP30_TENANT_A_TOKEN))
  assert.equal(tokenB.token_sha256, sha256(env.WP30_TENANT_B_TOKEN))
  assert(new Date(tokenA.expires_at).getTime() > Date.now())
  assert(new Date(tokenB.expires_at).getTime() > Date.now())
  const rollout = await pool.query(
    `SELECT count(*)::int count FROM persistent_codex.production_rollouts WHERE tenant_id='tenant-a' AND rollout_id=$1`,
    [env.WP30_ROLLOUT_ID],
  )
  assert.equal(rollout.rows[0].count, 1)
} finally {
  await pool.end()
}

machineEvidence('wp30:local:preflight', {
  accepted: true,
  status: 'passed',
  evidenceClass: 'local-operator',
  externalProductionReady: false,
  targetScope: 'loopback-only',
  fixturesVerified: true,
  pinnedImagesVerified: Object.keys(readPinnedImages()).sort(),
})
