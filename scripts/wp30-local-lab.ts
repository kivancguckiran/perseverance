import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import {
  WP30_LOCAL_ENV,
  WP30_LOCAL_LABEL,
  WP30_LOCAL_ROOT,
  WP30_LOCAL_STATE,
  assertAbsoluteCodex,
  composeArgs,
  randomSecret,
  readLocalEnv,
  readPinnedImages,
  redactInventoryName,
  run,
  sha256,
} from './wp30-local'
import { machineEvidence } from './wp30-evidence'

const sourceCommit = run('git', ['rev-parse', 'HEAD']).stdout.trim()
const codexBin = join(WP30_LOCAL_ROOT, 'node_modules/.bin/codex')

const writeEnvironment = () => {
  mkdirSync(WP30_LOCAL_STATE, { recursive: true, mode: 0o700 })
  if (!existsSync(WP30_LOCAL_ENV)) {
    const password = randomSecret()
    const values = {
      ...readPinnedImages(),
      WP30_MODE: 'local-production-like',
      WP30_EVIDENCE_CLASS: 'local-operator',
      WP30_EXTERNAL_PRODUCTION_READY: 'false',
      WP30_TARGET_SCOPE: 'loopback-only',
      WP30_SOURCE_COMMIT: sourceCommit,
      WP30_TARGET_URL: 'http://127.0.0.1:3300',
      WP30_DOCKER_TARGET_URL: 'http://control-plane:3300',
      WP30_REALTIME_URL: 'ws://127.0.0.1:3300/v1/realtime',
      WP30_WEB_URL: 'http://127.0.0.1:3301',
      WP30_AGENT_URL: 'http://127.0.0.1:3302',
      WP30_POSTGRES_HOST: '127.0.0.1',
      WP30_POSTGRES_PORT: '55430',
      WP30_POSTGRES_DATABASE: 'wp30_local',
      WP30_POSTGRES_USER: 'wp30_admin',
      WP30_POSTGRES_PASSWORD: password,
      WP30_CODEX_BIN: codexBin,
      WP30_TENANT_A_ID: 'tenant-a',
      WP30_TENANT_A_ORG_ID: 'organization-a',
      WP30_TENANT_A_WORKSPACE_ID: 'workspace-a',
      WP30_TENANT_A_TOKEN: randomSecret(),
      WP30_TENANT_B_ID: 'tenant-b',
      WP30_TENANT_B_ORG_ID: 'organization-b',
      WP30_TENANT_B_WORKSPACE_ID: 'workspace-b',
      WP30_TENANT_B_TOKEN: randomSecret(),
      WP30_FOREIGN_SESSION_ID: 'session-b',
      WP30_OBJECT_ID: 'object-b',
      WP30_COHORT_ID: 'cohort-a',
      WP30_ROLLOUT_ID: 'rollout-local-a',
      WP30_LOAD_DURATION: process.env.WP30_LOCAL_LOAD_DURATION ?? '20s',
      WP30_SOAK_DURATION: process.env.WP30_LOCAL_SOAK_DURATION ?? '30s',
      MINIO_ROOT_USER: 'wp30-local-operator',
      MINIO_ROOT_PASSWORD: randomSecret(),
    }
    writeFileSync(
      WP30_LOCAL_ENV,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      { mode: 0o600 },
    )
    writeFileSync(
      join(WP30_LOCAL_STATE, 'postgres-password'),
      `${password}\n`,
      {
        mode: 0o600,
      },
    )
  }
  chmodSync(WP30_LOCAL_ENV, 0o600)
  chmodSync(join(WP30_LOCAL_STATE, 'postgres-password'), 0o600)
}

const seed = async () => {
  const env = readLocalEnv()
  const pool = new pg.Pool({
    host: env.WP30_POSTGRES_HOST,
    port: Number(env.WP30_POSTGRES_PORT),
    database: env.WP30_POSTGRES_DATABASE,
    user: env.WP30_POSTGRES_USER,
    password: env.WP30_POSTGRES_PASSWORD,
  })
  try {
    const fixtures = [
      ['tenant', 'tenant-a', 'tenant-a', 'organization-a', 'workspace-a', null],
      ['tenant', 'tenant-b', 'tenant-b', 'organization-b', 'workspace-b', null],
      [
        'token',
        'token-a',
        'tenant-a',
        'organization-a',
        'workspace-a',
        sha256(env.WP30_TENANT_A_TOKEN),
      ],
      [
        'token',
        'token-b',
        'tenant-b',
        'organization-b',
        'workspace-b',
        sha256(env.WP30_TENANT_B_TOKEN),
      ],
      [
        'session',
        'session-b',
        'tenant-b',
        'organization-b',
        'workspace-b',
        null,
      ],
      ['object', 'object-b', 'tenant-b', 'organization-b', 'workspace-b', null],
      ['cohort', 'cohort-a', 'tenant-a', 'organization-a', 'workspace-a', null],
    ]
    await pool.query('BEGIN')
    for (const fixture of fixtures)
      await pool.query(
        `INSERT INTO persistent_codex.wp30_local_fixtures(fixture_type,fixture_id,tenant_id,organization_id,workspace_id,token_sha256,expires_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $1='token' THEN now()+interval '4 hours' ELSE NULL END) ON CONFLICT(fixture_type,fixture_id) DO UPDATE SET token_sha256=excluded.token_sha256,expires_at=excluded.expires_at`,
        fixture,
      )
    await pool.query(
      `INSERT INTO persistent_codex.production_rollouts(tenant_id,organization_id,workspace_id,rollout_id,stage,cohort_id,artifact_sha256,previous_artifact_sha256,feature_flag_enabled) VALUES('tenant-a','organization-a','workspace-a',$1,'internal','cohort-a',$2,$3,true) ON CONFLICT DO NOTHING`,
      [env.WP30_ROLLOUT_ID, sha256('local-candidate'), sha256('local-stable')],
    )
    await pool.query('COMMIT')
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await pool.end()
  }
}

const up = async () => {
  writeEnvironment()
  const env = readLocalEnv()
  assert.equal(
    env.WP30_SOURCE_COMMIT,
    sourceCommit,
    'local.env belongs to another source commit; run lab:down',
  )
  assertAbsoluteCodex(env.WP30_CODEX_BIN)
  for (const image of Object.values(readPinnedImages()))
    run('docker', ['pull', image])
  run('docker', composeArgs('up', '-d', '--wait', '--wait-timeout', '240'))
  await seed()
  for (const url of [
    env.WP30_TARGET_URL,
    env.WP30_WEB_URL,
    env.WP30_AGENT_URL,
  ]) {
    const response = await fetch(`${url}/readyz`)
    assert.equal(response.status, 200, `${url} not ready`)
  }
  machineEvidence('wp30:lab:up', {
    status: 'ready',
    evidenceClass: 'local-operator',
    targetScope: 'loopback-only',
    sourceCommit,
  })
}

export const down = () => {
  assert.equal(
    run('docker', ['info'], { allowFailure: true }).status,
    0,
    'Docker daemon unavailable; cleanup not verified',
  )
  const listed = (type: 'container' | 'volume' | 'network') => {
    const args =
      type === 'container'
        ? ['ps', '-aq', '--filter', `label=${WP30_LOCAL_LABEL}`]
        : [type, 'ls', '-q', '--filter', `label=${WP30_LOCAL_LABEL}`]
    return run('docker', args, { allowFailure: true })
      .stdout.trim()
      .split('\n')
      .filter(Boolean)
  }
  const containerIds = listed('container')
  const volumeNames = listed('volume')
  const networkIds = listed('network')
  for (const id of containerIds) {
    const label = run('docker', [
      'inspect',
      '--format',
      '{{index .Config.Labels "persistent.wp30.local"}}',
      id,
    ]).stdout.trim()
    assert.equal(label, 'true', 'refusing to remove an unlabeled resource')
  }
  if (existsSync(WP30_LOCAL_ENV))
    run('docker', composeArgs('down', '--volumes', '--remove-orphans'), {
      allowFailure: true,
    })
  else {
    if (containerIds.length) run('docker', ['rm', '-f', ...containerIds])
    if (volumeNames.length) run('docker', ['volume', 'rm', ...volumeNames])
    if (networkIds.length) run('docker', ['network', 'rm', ...networkIds])
  }
  assert.deepEqual(
    [listed('container'), listed('volume'), listed('network')],
    [[], [], []],
    'labeled WP30 local resources remain',
  )
  const inventory = [...containerIds, ...volumeNames, ...networkIds].map(
    redactInventoryName,
  )
  rmSync(WP30_LOCAL_ENV, { force: true })
  rmSync(join(WP30_LOCAL_STATE, 'postgres-password'), { force: true })
  rmSync(join(WP30_LOCAL_STATE, 'local-operator-private.pem'), { force: true })
  machineEvidence('wp30:lab:down', {
    status: 'clean',
    removedCount: inventory.length,
    resources: inventory,
    secretsRemoved: true,
  })
}

const command = process.argv[2]
if (command === 'up') await up()
else if (command === 'down') down()
else throw new Error('usage: wp30-local-lab.ts <up|down>')
