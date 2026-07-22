import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import pg from 'pg'
import { machineEvidence } from './wp30-evidence'

const gate = 'wp30:postgres-migration'
const root = resolve(import.meta.dirname, '..')
const name = `persistent-wp30-postgres-${process.pid}`
const password = randomBytes(24).toString('hex')
const postgresImage =
  process.env.WP30_POSTGRES_TEST_IMAGE ?? 'postgres:17.5-alpine'
const docker = (args: string[], allowFailure = false) => {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, POSTGRES_PASSWORD: password },
  })
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
let pool: pg.Pool | undefined
try {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'persistent.wp30=true',
    '-e',
    'POSTGRES_PASSWORD',
    '-e',
    'POSTGRES_DB=wp30',
    '-p',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql/data:rw,size=512m',
    postgresImage,
  ])
  let containerReady = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (
      docker(
        ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'wp30'],
        true,
      ).includes('accepting connections')
    ) {
      containerReady = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert(containerReady, 'temporary PostgreSQL container did not become ready')
  const port = docker(['port', name, '5432/tcp']).split(':').at(-1)!
  pool = new pg.Pool({
    connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/wp30`,
  })
  let sqlReady = false
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await pool.query('SELECT 1')
      sqlReady = true
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  assert(sqlReady, 'temporary PostgreSQL SQL endpoint did not become ready')
  const serverVersion = String(
    (await pool.query('SHOW server_version')).rows[0].server_version,
  )
  assert.match(serverVersion, /^17\./)
  await pool.query('CREATE SCHEMA persistent_codex')
  await pool.query(
    readFileSync(
      join(root, 'infra/postgres/migrations/0034_wp30_production_rollout.sql'),
      'utf8',
    ),
  )
  const forced = await pool.query(
    "SELECT count(*)::int count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='persistent_codex' AND c.relname LIKE 'production_%' AND c.relforcerowsecurity",
  )
  assert.equal(forced.rows[0].count, 5)
  await pool.query(
    `INSERT INTO persistent_codex.production_rollouts(tenant_id,organization_id,workspace_id,rollout_id,stage,cohort_id,artifact_sha256,feature_flag_enabled) VALUES('tenant-a','org-a','workspace-a','rollout-a','internal','internal',$1,true)`,
    ['a'.repeat(64)],
  )
  await pool.query(
    `INSERT INTO persistent_codex.production_rollout_history(tenant_id,organization_id,workspace_id,rollout_id,sequence,to_stage,cohort_id,artifact_sha256,reason_code,history_sha256,occurred_at) VALUES('tenant-a','org-a','workspace-a','rollout-a',1,'internal','internal',$1,'CREATED',$2,now())`,
    ['a'.repeat(64), 'b'.repeat(64)],
  )
  await assert.rejects(
    () =>
      pool!.query(
        "UPDATE persistent_codex.production_rollout_history SET reason_code='tampered'",
      ),
    /immutable record/,
  )
  machineEvidence(gate, {
    accepted: true,
    status: 'passed',
    postgres: serverVersion,
    image: postgresImage,
    migration: '0034',
    forcedRlsTables: 5,
    immutableHistory: true,
  })
} finally {
  await pool?.end().catch(() => undefined)
  docker(['rm', '-f', '-v', name], true)
}
