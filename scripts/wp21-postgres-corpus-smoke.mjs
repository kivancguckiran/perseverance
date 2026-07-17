import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const name = `persistent-codex-wp21-${randomUUID()}`
const image = process.env.WP21_POSTGRES_IMAGE ?? 'postgres:17-alpine'
const run = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
const psql = (sql) =>
  execFileSync(
    'docker',
    ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  )
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
    const probe = spawnSync(
      'docker',
      ['exec', name, 'pg_isready', '-U', 'postgres'],
      {
        encoding: 'utf8',
      },
    )
    if (probe.status === 0) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error('PostgreSQL did not become ready')
  const migration18 = readFileSync(
    new URL(
      '../infra/postgres/migrations/0018_oidc_authorization_rls.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const migration21 = readFileSync(
    new URL(
      '../infra/postgres/migrations/0021_tenant_corpus_ingestion.sql',
      import.meta.url,
    ),
    'utf8',
  )
  psql(`${migration18}\n${migration21}\n${migration21}`)
  psql(`
    CREATE ROLE corpus_runtime LOGIN PASSWORD 'runtime'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    GRANT USAGE ON SCHEMA persistent_codex TO corpus_runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA persistent_codex TO corpus_runtime;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA persistent_codex TO corpus_runtime;
    INSERT INTO persistent_codex.organizations VALUES
      ('tenant_a','A','active'),('tenant_b','B','active');
    INSERT INTO persistent_codex.workspaces VALUES
      ('tenant_a','workspace_a','A'),('tenant_b','workspace_b','B');
    INSERT INTO persistent_codex.sessions VALUES
      ('tenant_a','workspace_a','corpus_usage_a','active'),
      ('tenant_b','workspace_b','corpus_usage_b','active');
    BEGIN;
    SET LOCAL ROLE corpus_runtime;
    SELECT set_config('app.tenant_id','tenant_a',true);
    SELECT set_config('app.organization_id','tenant_a',true);
    SELECT set_config('app.workspace_id','workspace_a',true);
    INSERT INTO persistent_codex.sources
      (tenant_id,organization_id,workspace_id,source_id,kind,display_name,status)
      VALUES ('tenant_a','tenant_a','workspace_a','source_a','text','fixture.txt','pending');
    INSERT INTO persistent_codex.source_revisions
      (tenant_id,organization_id,workspace_id,source_id,revision_id,content_hash,
       byte_length,media_type,parser_version,language,provenance,
       raw_snapshot_metadata,storage_key,status)
      VALUES ('tenant_a','tenant_a','workspace_a','source_a','revision_a',
       'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',10,
       'text/plain','v1','und','{"kind":"upload"}',
       '{"immutable":true}','raw/tenant_a/tenant_a/workspace_a/revision_a.snapshot','pending');
    UPDATE persistent_codex.sources SET current_revision_id='revision_a'
      WHERE source_id='source_a';
    INSERT INTO persistent_codex.extraction_jobs
      (tenant_id,organization_id,workspace_id,job_id,source_id,revision_id,status,
       attempt,max_attempts,usage_completeness)
      VALUES ('tenant_a','tenant_a','workspace_a','job_a','source_a','revision_a',
       'pending',1,3,'partial');
    INSERT INTO persistent_codex.corpus_chunks
      (tenant_id,organization_id,workspace_id,chunk_id,source_id,revision_id,
       ordinal,content_hash,locator,chunking_policy)
      VALUES ('tenant_a','tenant_a','workspace_a','chunk_a','source_a','revision_a',0,
       'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
       '{"kind":"line","lineStart":1,"lineEnd":1}',
       '{"version":"v1","maxCharacters":2000,"overlapCharacters":200}');
    INSERT INTO persistent_codex.index_documents
      (tenant_id,organization_id,workspace_id,index_document_id,chunk_id,source_id,
       revision_id,content_hash,embedding_version,embedding_token_count,status)
      VALUES ('tenant_a','tenant_a','workspace_a','index_a','chunk_a','source_a',
       'revision_a','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
       'embedding-v1',3,'indexed');
    INSERT INTO persistent_codex.usage_ledger
      (organization_id,workspace_id,session_id,quantity,tenant_id,meter,dedupe_key,
       source_id,revision_id,extraction_job_id,completeness)
      VALUES ('tenant_a','workspace_a','corpus_usage_a',3,'tenant_a',
       'index_embedding_token','embedding:revision_a:embedding-v1','source_a',
       'revision_a','job_a','complete');
    DO $$
    BEGIN
      IF (SELECT count(*) FROM persistent_codex.sources) <> 1 THEN
        RAISE EXCEPTION 'tenant source visibility failed';
      END IF;
      IF (SELECT count(*) FROM persistent_codex.index_documents) <> 1 THEN
        RAISE EXCEPTION 'tenant index visibility failed';
      END IF;
      BEGIN
        INSERT INTO persistent_codex.sources
          (tenant_id,organization_id,workspace_id,source_id,kind,display_name,status)
          VALUES ('tenant_b','tenant_b','workspace_b','cross_tenant','text','x','pending');
        RAISE EXCEPTION 'cross tenant worker insert allowed';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      BEGIN
        INSERT INTO persistent_codex.usage_ledger
          (organization_id,workspace_id,session_id,quantity,tenant_id,meter,dedupe_key,
           source_id,revision_id,extraction_job_id,completeness)
          VALUES ('tenant_a','workspace_a','corpus_usage_a',3,'tenant_a',
           'index_embedding_token','embedding:revision_a:embedding-v1','source_a',
           'revision_a','job_a','complete');
        RAISE EXCEPTION 'embedding usage duplicate allowed';
      EXCEPTION WHEN unique_violation THEN NULL;
      END;
    END $$;
    COMMIT;
    BEGIN;
    SET LOCAL ROLE corpus_runtime;
    DO $$
    BEGIN
      IF COALESCE(current_setting('app.tenant_id', true), '') <> '' OR
         COALESCE(current_setting('app.organization_id', true), '') <> '' OR
         COALESCE(current_setting('app.workspace_id', true), '') <> '' THEN
        RAISE EXCEPTION 'tenant context leaked after connection reuse';
      END IF;
      IF (SELECT count(*) FROM persistent_codex.sources) <> 0 THEN
        RAISE EXCEPTION 'unset context exposed corpus rows';
      END IF;
    END $$;
    ROLLBACK;
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname='corpus_runtime' AND (rolsuper OR rolbypassrls)
      ) THEN RAISE EXCEPTION 'runtime role bypasses RLS'; END IF;
      IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_roles r ON r.oid=c.relowner
        WHERE n.nspname='persistent_codex' AND c.relkind='r' AND r.rolname='corpus_runtime'
      ) THEN RAISE EXCEPTION 'runtime role owns corpus table'; END IF;
      IF (SELECT count(*) FROM persistent_codex.security_migrations WHERE version=21) <> 1
      THEN RAISE EXCEPTION 'migration reapply was not idempotent'; END IF;
    END $$;
  `)
  result = {
    migration: 21,
    image,
    forcedRls: true,
    applicationRole: { superuser: false, bypassRls: false, tableOwner: false },
    crossTenant: {
      source: 'rejected',
      index: 'hidden',
      workerWrite: 'rejected',
    },
    embeddingUsageDedupe: true,
    migrationReapply: 'idempotent',
    connectionReuseLeak: false,
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
  failure ??= new Error('PostgreSQL smoke container cleanup failed')
if (failure) throw failure
console.log(
  JSON.stringify({ ...result, cleanup: { containerRemoved: true } }, null, 2),
)
