import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const name = `persistent-codex-wp18-${randomUUID()}`
const image = process.env.WP18_POSTGRES_IMAGE ?? 'postgres:17-alpine'
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
let result
let failure
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
    try {
      const logs = output('logs', name)
      const readyTransitions =
        logs.match(/database system is ready to accept connections/g)?.length ??
        0
      if (readyTransitions >= 2) {
        run(
          'exec',
          name,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'postgres',
          '-c',
          'SELECT 1',
        )
        ready = true
        break
      }
    } catch {
      // The official image starts and stops a temporary init server first.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error('PostgreSQL did not become ready')
  const serverVersion = run(
    'exec',
    name,
    'psql',
    '-At',
    '-U',
    'postgres',
    '-c',
    'SHOW server_version',
  ).trim()
  if (!serverVersion.startsWith('17.'))
    throw new Error(`Expected PostgreSQL 17, received ${serverVersion}`)
  const migration = readFileSync(
    new URL(
      '../infra/postgres/migrations/0018_oidc_authorization_rls.sql',
      import.meta.url,
    ),
    'utf8',
  )
  execFileSync(
    'docker',
    ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'],
    {
      input: `${migration}
CREATE ROLE app_runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT USAGE ON SCHEMA persistent_codex TO app_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA persistent_codex TO app_runtime;
INSERT INTO persistent_codex.organizations VALUES ('org_a','A','active'),('org_b','B','active');
INSERT INTO persistent_codex.workspaces VALUES ('org_a','wsp_a','A'),('org_b','wsp_b','B');
INSERT INTO persistent_codex.sessions VALUES ('org_a','wsp_a','ses_a','active'),('org_b','wsp_b','ses_b','active');
DO $$
BEGIN
  IF NOT persistent_codex.security_ready() THEN RAISE EXCEPTION 'security readiness missing'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'app_runtime' AND (rolsuper OR rolbypassrls)
  ) THEN RAISE EXCEPTION 'application role can bypass RLS'; END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
    WHERE namespace.nspname = 'persistent_codex'
      AND relation.relkind = 'r'
      AND owner_role.rolname = 'app_runtime'
  ) THEN RAISE EXCEPTION 'application role owns tenant table'; END IF;
END $$;
`,
      encoding: 'utf8',
    },
  )
  const sql = `
BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.organization_id','org_a',true);
SELECT set_config('app.workspace_id','wsp_a',true);
DO $$
BEGIN
  IF (SELECT count(*) FROM persistent_codex.sessions) <> 1 THEN RAISE EXCEPTION 'cross tenant select'; END IF;
  BEGIN
    INSERT INTO persistent_codex.sessions VALUES ('org_b','wsp_b','evil','active');
    RAISE EXCEPTION 'cross tenant insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE persistent_codex.sessions SET status='changed' WHERE organization_id='org_b';
    IF FOUND THEN RAISE EXCEPTION 'cross tenant update allowed'; END IF;
  END;
  BEGIN
    DELETE FROM persistent_codex.sessions WHERE organization_id='org_b';
    IF FOUND THEN RAISE EXCEPTION 'cross tenant delete allowed'; END IF;
  END;
  BEGIN
    INSERT INTO persistent_codex.events VALUES ('org_a','wsp_a','ses_b','bad',1,'{}');
    RAISE EXCEPTION 'cross tenant composite relation allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
COMMIT;
BEGIN;
SET LOCAL ROLE app_runtime;
DO $$
BEGIN
  IF COALESCE(current_setting('app.organization_id', true), '') <> '' THEN RAISE EXCEPTION 'pool context leaked'; END IF;
  IF COALESCE(current_setting('app.workspace_id', true), '') <> '' THEN RAISE EXCEPTION 'workspace pool context leaked'; END IF;
  IF (SELECT count(*) FROM persistent_codex.sessions) <> 0 THEN RAISE EXCEPTION 'unset context exposed rows'; END IF;
END $$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.organization_id','org_a',true);
SELECT set_config('app.workspace_id','wsp_a',true);
ROLLBACK;
BEGIN;
SET LOCAL ROLE app_runtime;
DO $$
BEGIN
  IF COALESCE(current_setting('app.organization_id', true), '') <> '' THEN RAISE EXCEPTION 'rollback organization context leaked'; END IF;
  IF COALESCE(current_setting('app.workspace_id', true), '') <> '' THEN RAISE EXCEPTION 'rollback workspace context leaked'; END IF;
  IF (SELECT count(*) FROM persistent_codex.sessions) <> 0 THEN RAISE EXCEPTION 'rollback reuse exposed rows'; END IF;
END $$;
ROLLBACK;
BEGIN;
ALTER TABLE persistent_codex.sessions NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF persistent_codex.security_ready() THEN RAISE EXCEPTION 'readiness ignored missing forced RLS'; END IF;
END $$;
ROLLBACK;
BEGIN;
DELETE FROM persistent_codex.security_migrations WHERE version = 18;
DO $$
BEGIN
  IF persistent_codex.security_ready() THEN RAISE EXCEPTION 'readiness ignored missing migration'; END IF;
END $$;
ROLLBACK;
`
  execFileSync(
    'docker',
    ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'],
    {
      input: sql,
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  )
  result = {
    migration: 18,
    image,
    serverVersion,
    applicationRole: {
      superuser: false,
      bypassRls: false,
      tableOwner: false,
    },
    forcedRls: true,
    failClosedReadiness: true,
    crossTenant: {
      select: 'hidden',
      insert: 'rejected',
      update: 'rejected',
      delete: 'rejected',
      compositeForeignKey: 'rejected',
    },
    transactionContext: {
      commitCleared: true,
      rollbackCleared: true,
      connectionReuseLeak: false,
    },
  }
} catch (error) {
  failure = error
} finally {
  try {
    run('rm', '-f', name)
  } catch (error) {
    failure ??= error
  }
}
let containerExists = true
try {
  run('inspect', name)
} catch {
  containerExists = false
}
if (containerExists)
  failure ??= new Error(
    `Temporary PostgreSQL container ${name} was not removed`,
  )
if (failure) throw failure
process.stdout.write(
  JSON.stringify({
    ...result,
    cleanup: { containerRemoved: true, anonymousStorageRemoved: true },
  }) + '\n',
)
