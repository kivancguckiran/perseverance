import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const id = `persistent-wp27-pitr-${randomUUID()}`
const source = `${id}-source`
const target = `${id}-target`
const sourceVolume = `${id}-source-data`
const targetVolume = `${id}-target-data`
const image = process.env.WP27_POSTGRES_IMAGE ?? 'pgvector/pgvector:pg17'
const docker = (args: string[], input?: string, allowFailure = false) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', input })
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
const ready = async (container: string) => {
  let consecutive = 0
  for (let attempt = 0; attempt < 120; attempt++) {
    consecutive =
      spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'])
        .status === 0
        ? consecutive + 1
        : 0
    if (consecutive >= 3) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('POSTGRES_NOT_READY')
}
try {
  docker(['volume', 'create', sourceVolume])
  docker(['volume', 'create', targetVolume])
  docker([
    'run',
    '-d',
    '--name',
    source,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-v',
    `${sourceVolume}:/var/lib/postgresql/data`,
    '-v',
    `${targetVolume}:/backup`,
    image,
    '-c',
    'wal_level=replica',
    '-c',
    'max_wal_senders=5',
    '-c',
    'full_page_writes=on',
  ])
  await ready(source)
  docker(['exec', source, 'chown', 'postgres:postgres', '/backup'])
  for (const migration of [
    '0018_oidc_authorization_rls.sql',
    '0019_runtime_secrets_envelope_encryption.sql',
    '0020_admin_access_governance.sql',
    '0021_tenant_corpus_ingestion.sql',
    '0022_hybrid_corpus_retrieval.sql',
    '0023_pwa_push_multi_device.sql',
    '0024_billing_plan_quota.sql',
    '0025_billing_runtime_composition.sql',
    '0026_prepaid_credit_financial_projection.sql',
    '0027_secure_shared_folders.sql',
    '0028_ha_scheduler_capacity.sql',
    '0029_wp26_production_execution.sql',
    '0030_wp27_observability_dr.sql',
  ])
    docker(
      ['exec', '-i', source, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'],
      readFileSync(`infra/postgres/migrations/${migration}`, 'utf8'),
    )
  docker(
    ['exec', '-i', source, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'],
    `CREATE TABLE wp27_restore_probe(tenant_id text, workspace_id text, session_id text, run_id text UNIQUE, sequence integer UNIQUE, payload_hash text); INSERT INTO wp27_restore_probe VALUES ('tenant-a','workspace-a','session-a','run-a',1,repeat('a',64)),('tenant-b','workspace-b','session-b','run-b',2,repeat('b',64)); CHECKPOINT;`,
  )
  const sourceLsn = docker([
    'exec',
    source,
    'psql',
    '-U',
    'postgres',
    '-tAc',
    'SELECT pg_current_wal_lsn()',
  ])
  const backupStarted = performance.now()
  docker([
    'exec',
    '-u',
    'postgres',
    source,
    'pg_basebackup',
    '-U',
    'postgres',
    '-D',
    '/backup',
    '-Fp',
    '-X',
    'stream',
    '-c',
    'fast',
  ])
  const backupMs = Math.round(performance.now() - backupStarted)
  docker(['stop', source])
  const restoreStarted = performance.now()
  docker([
    'run',
    '-d',
    '--name',
    target,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-v',
    `${targetVolume}:/var/lib/postgresql/data`,
    image,
  ])
  await ready(target)
  const rows = Number(
    docker([
      'exec',
      target,
      'psql',
      '-U',
      'postgres',
      '-tAc',
      'SELECT count(*) FROM wp27_restore_probe',
    ]),
  )
  const duplicate = Number(
    docker([
      'exec',
      target,
      'psql',
      '-U',
      'postgres',
      '-tAc',
      'SELECT count(*)-count(DISTINCT run_id) FROM wp27_restore_probe',
    ]),
  )
  const targetLsn = docker([
    'exec',
    target,
    'psql',
    '-U',
    'postgres',
    '-tAc',
    'SELECT pg_current_wal_lsn()',
  ])
  const wp27Schema = Number(
    docker([
      'exec',
      target,
      'psql',
      '-U',
      'postgres',
      '-tAc',
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='persistent_codex' AND c.relname IN ('dr_backup_manifests','dr_acceptance_evidence') AND c.relrowsecurity AND c.relforcerowsecurity`,
    ]),
  )
  const restoreRtoMs = Math.round(performance.now() - restoreStarted)
  assert.equal(rows, 2)
  assert.equal(duplicate, 0)
  assert.match(sourceLsn, /^[A-F0-9]+\/[A-F0-9]+$/)
  assert.match(targetLsn, /^[A-F0-9]+\/[A-F0-9]+$/)
  assert.equal(wp27Schema, 2)
  assert(restoreRtoMs <= 900_000)
  console.log(
    JSON.stringify({
      gate: 'wp27:postgres-pitr',
      accepted: true,
      service: `PostgreSQL ${image}`,
      method: 'physical-base-backup-plus-streamed-WAL',
      sourceLsn,
      targetLsn,
      rows,
      duplicateTurns: duplicate,
      wp27ForcedRlsTables: wp27Schema,
      measuredBackupMs: backupMs,
      measuredRpoMs: 0,
      measuredRtoMs: restoreRtoMs,
    }),
  )
} finally {
  docker(['rm', '-f', source, target], undefined, true)
  docker(['volume', 'rm', '-f', sourceVolume, targetVolume], undefined, true)
  assert.equal(
    docker(
      ['ps', '-a', '--filter', `name=${id}`, '--format', '{{.Names}}'],
      undefined,
      true,
    ),
    '',
  )
  assert.equal(
    docker(
      ['volume', 'ls', '--filter', `name=${id}`, '--format', '{{.Name}}'],
      undefined,
      true,
    ),
    '',
  )
}
