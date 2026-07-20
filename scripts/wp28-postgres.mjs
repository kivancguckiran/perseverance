import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const name = `persistent-wp28-postgres-${randomUUID()}`,
  docker = (args, ok = false) => {
    const r = spawnSync('docker', args, { encoding: 'utf8' })
    if (!ok && r.status !== 0) throw new Error(r.stderr || r.stdout)
    return r.stdout.trim()
  }
try {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-e',
    'POSTGRES_DB=wp28',
    '-p',
    '127.0.0.1::5432',
    'postgres:17.5-alpine',
  ])
  for (let i = 0; i < 80; i++) {
    if (
      spawnSync('docker', [
        'exec',
        name,
        'pg_isready',
        '-U',
        'postgres',
        '-d',
        'wp28',
      ]).status === 0
    )
      break
    await new Promise((r) => setTimeout(r, 250))
  }
  const sql = readFileSync(
    'infra/postgres/migrations/0031_wp28_enterprise_lifecycle.sql',
    'utf8',
  )
  let r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      name,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'wp28',
    ],
    { input: sql, encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      name,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'wp28',
    ],
    {
      input: `CREATE ROLE wp28_runtime LOGIN PASSWORD 'runtime'; GRANT USAGE ON SCHEMA persistent_codex TO wp28_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA persistent_codex TO wp28_runtime; INSERT INTO persistent_codex.scim_resources VALUES('tenant-a','org-a','idp','User','u1','e1',1,true,'{"displayName":"opaque"}',1,now()); SET ROLE wp28_runtime; SELECT set_config('app.tenant_id','tenant-b',false),set_config('app.organization_id','org-b',false); DO $$BEGIN IF EXISTS(SELECT 1 FROM persistent_codex.scim_resources) THEN RAISE EXCEPTION 'RLS leak'; END IF; END$$; SELECT set_config('app.tenant_id','tenant-a',false),set_config('app.organization_id','org-a',false); DO $$BEGIN IF (SELECT count(*) FROM persistent_codex.scim_resources)<>1 THEN RAISE EXCEPTION 'RLS missing own row'; END IF; END$$;`,
      encoding: 'utf8',
    },
  )
  assert.equal(r.status, 0, r.stderr)
  console.log(
    JSON.stringify({
      gate: 'wp28:postgres',
      accepted: true,
      postgres: '17.5',
      forcedRls: true,
      tenants: 2,
      crossTenantRows: 0,
      migration: '0031',
    }),
  )
} finally {
  docker(['rm', '-f', name], true)
}
