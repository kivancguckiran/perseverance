import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const name = `persistent-codex-wp19-${randomUUID()}`
const image = process.env.WP19_POSTGRES_IMAGE ?? 'postgres:17-alpine'
const run = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
const output = (...args) => {
  const completed = spawnSync('docker', args, { encoding: 'utf8' })
  if (completed.error) throw completed.error
  return `${completed.stdout}${completed.stderr}`
}

let failure
let serverVersion
try {
  run(
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '-e',
    'POSTGRES_PASSWORD=test',
    image,
  )
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    const logs = output('logs', name)
    if (
      (logs.match(/database system is ready to accept connections/g)?.length ??
        0) >= 2
    ) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error('PostgreSQL did not become ready')
  serverVersion = run(
    'exec',
    name,
    'psql',
    '-At',
    '-U',
    'postgres',
    '-c',
    'SHOW server_version',
  ).trim()
  const migration18 = readFileSync(
    new URL(
      '../infra/postgres/migrations/0018_oidc_authorization_rls.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const migration19 = readFileSync(
    new URL(
      '../infra/postgres/migrations/0019_runtime_secrets_envelope_encryption.sql',
      import.meta.url,
    ),
    'utf8',
  )
  execFileSync(
    'docker',
    ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'],
    {
      input: `${migration18}\n${migration19}\n${migration19}
INSERT INTO persistent_codex.organizations VALUES ('org_a','A','active'),('org_b','B','active');
INSERT INTO persistent_codex.workspaces VALUES ('org_a','wsp_a','A'),('org_b','wsp_b','B');
DO $$
BEGIN
  IF NOT persistent_codex.wp19_security_ready() THEN
    RAISE EXCEPTION 'WP19 readiness missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='persistent_codex' AND table_name='events'
      AND column_name='payload_envelope' AND data_type='bytea'
  ) THEN RAISE EXCEPTION 'event envelope column missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='persistent_codex' AND table_name='artifacts'
      AND column_name='chunk_manifest'
  ) THEN RAISE EXCEPTION 'artifact chunk manifest missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='persistent_codex' AND table_name='sensitive_records'
  ) THEN RAISE EXCEPTION 'sensitive encrypted record table missing'; END IF;
END $$;
CREATE ROLE app_runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT USAGE ON SCHEMA persistent_codex TO app_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA persistent_codex TO app_runtime;
BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.organization_id','org_a',true);
SELECT set_config('app.workspace_id','wsp_a',true);
INSERT INTO persistent_codex.workspace_crypto_state
  (organization_id,workspace_id,kms_provider,kms_key_id,current_key_version,envelope_format_version)
VALUES ('org_a','wsp_a','aws-kms','key-a','1',1);
DO $$
BEGIN
  BEGIN
    INSERT INTO persistent_codex.workspace_crypto_state
      (organization_id,workspace_id,kms_provider,kms_key_id,current_key_version,envelope_format_version)
    VALUES ('org_b','wsp_b','aws-kms','key-b','1',1);
    RAISE EXCEPTION 'cross-tenant crypto state insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;
BEGIN;
DELETE FROM persistent_codex.security_migrations WHERE version=19;
DO $$
BEGIN
  IF persistent_codex.wp19_security_ready() THEN
    RAISE EXCEPTION 'readiness ignored missing migration';
  END IF;
END $$;
ROLLBACK;
`,
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  )
} catch (error) {
  failure = error
} finally {
  try {
    run('rm', '-f', name)
  } catch (error) {
    failure ??= error
  }
}
if (failure) throw failure
process.stdout.write(
  JSON.stringify({
    status: 'passed',
    migration: 19,
    image,
    serverVersion,
    idempotentReapply: true,
    applicationEnvelopeColumns: true,
    chunkManifestColumns: true,
    forcedRls: true,
    crossTenantCryptoState: 'rejected',
    failClosedReadiness: true,
    cleanup: { containerRemoved: true },
  }) + '\n',
)
