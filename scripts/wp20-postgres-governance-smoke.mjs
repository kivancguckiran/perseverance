import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const name = `persistent-codex-wp20-${randomUUID()}`
const image = process.env.WP20_POSTGRES_IMAGE ?? 'postgres:17-alpine'
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
const migration = (version, file) =>
  readFileSync(
    new URL(`../infra/postgres/migrations/${file}`, import.meta.url),
    'utf8',
  )
const psql = (sql) =>
  execFileSync(
    'docker',
    ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'],
    { input: sql, stdio: ['pipe', 'inherit', 'inherit'] },
  )
const concurrentPsql = (sql) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    )
    let error = ''
    child.stderr.on('data', (chunk) => {
      error += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(error)),
    )
    child.stdin.end(sql)
  })

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
    if (
      (output('logs', name).match(
        /database system is ready to accept connections/g,
      )?.length ?? 0) >= 2
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
  psql(`${migration(18, '0018_oidc_authorization_rls.sql')}\n${migration(19, '0019_runtime_secrets_envelope_encryption.sql')}\n${migration(20, '0020_admin_access_governance.sql')}\n${migration(20, '0020_admin_access_governance.sql')}
INSERT INTO persistent_codex.organizations VALUES ('org_a','A','active'),('org_b','B','active');
INSERT INTO persistent_codex.workspaces VALUES ('org_a','wsp_a','A'),('org_b','wsp_b','B');
INSERT INTO persistent_codex.sessions VALUES ('org_a','wsp_a','ses_a','active'),('org_b','wsp_b','ses_b','active');
CREATE ROLE app_runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT USAGE ON SCHEMA persistent_codex TO app_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON persistent_codex.support_grants,persistent_codex.support_grant_approvals,persistent_codex.jit_access_leases,persistent_codex.break_glass_requests,persistent_codex.break_glass_approvals,persistent_codex.security_notification_outbox,persistent_codex.access_revocation_epochs TO app_runtime;
GRANT SELECT ON persistent_codex.immutable_security_audit TO app_runtime;
GRANT EXECUTE ON FUNCTION persistent_codex.append_security_audit(text,text,text,jsonb,text,text,text,text,text,text) TO app_runtime;
DO $$ BEGIN IF NOT persistent_codex.wp20_security_ready() THEN RAISE EXCEPTION 'WP20 readiness missing'; END IF; END $$;
BEGIN; SET LOCAL ROLE app_runtime; SELECT set_config('app.organization_id','org_a',true); SELECT set_config('app.workspace_id','wsp_a',true);
INSERT INTO persistent_codex.support_grants (organization_id,workspace_id,grant_id,tenant_id,session_id,actions,reason,requester_principal_id,support_principal_id,required_approvals,status,expires_at,idempotency_key) VALUES ('org_a','wsp_a','grant_a','ten_a','ses_a',ARRAY['content.view'],'User initiated narrow support diagnosis','user_a','support_a',1,'pending_verification',now()+interval '15 min','create-a');
DO $$ BEGIN
  BEGIN INSERT INTO persistent_codex.support_grants (organization_id,workspace_id,grant_id,tenant_id,session_id,actions,reason,requester_principal_id,support_principal_id,required_approvals,status,expires_at,idempotency_key) VALUES ('org_b','wsp_b','evil','ten_b','ses_b',ARRAY['content.view'],'Cross tenant support diagnosis','user_b','support_b',1,'pending_verification',now()+interval '15 min','evil'); RAISE EXCEPTION 'cross tenant grant allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF (SELECT count(*) FROM persistent_codex.support_grants) <> 1 THEN RAISE EXCEPTION 'cross tenant grant visible'; END IF;
END $$;
SELECT persistent_codex.append_security_audit('org_a','wsp_a','user_a','{"actions":["content.view"],"sessionId":"ses_a"}'::jsonb,'grant.created','success','created','grant_a',NULL,'corr-1');
DO $$ BEGIN
  BEGIN UPDATE persistent_codex.immutable_security_audit SET reason_code='tampered'; RAISE EXCEPTION 'audit update allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM persistent_codex.immutable_security_audit; RAISE EXCEPTION 'audit delete allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$; COMMIT;
BEGIN; SET LOCAL ROLE app_runtime; DO $$ BEGIN IF (SELECT count(*) FROM persistent_codex.support_grants) <> 0 THEN RAISE EXCEPTION 'transaction tenant context leaked'; END IF; END $$; ROLLBACK;
`)
  const auditSql = (correlation) =>
    `BEGIN; SET LOCAL ROLE app_runtime; SELECT set_config('app.organization_id','org_a',true); SELECT set_config('app.workspace_id','wsp_a',true); SELECT persistent_codex.append_security_audit('org_a','wsp_a','support_a','{"actions":["content.view"],"sessionId":"ses_a"}'::jsonb,'content.viewed','success','lease','grant_a',NULL,'${correlation}'); COMMIT;`
  await Promise.all([
    concurrentPsql(auditSql('corr-2')),
    concurrentPsql(auditSql('corr-3')),
  ])
  psql(
    `DO $$ DECLARE invalid_count integer; BEGIN SELECT count(*) INTO invalid_count FROM (SELECT chain_sequence,previous_hash,lag(record_hash) OVER (ORDER BY chain_sequence) expected FROM persistent_codex.immutable_security_audit WHERE organization_id='org_a' AND workspace_id='wsp_a') chain WHERE chain_sequence > 1 AND previous_hash <> expected; IF invalid_count <> 0 THEN RAISE EXCEPTION 'audit hash chain broken'; END IF; IF (SELECT count(*) FROM persistent_codex.immutable_security_audit WHERE organization_id='org_a' AND workspace_id='wsp_a') <> 3 THEN RAISE EXCEPTION 'concurrent audit insert lost'; END IF; END $$;`,
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
    migration: 20,
    image,
    serverVersion,
    idempotentReapply: true,
    forcedRls: true,
    crossTenantGrant: 'rejected',
    immutableAuditMutation: 'rejected',
    concurrentHashChain: 'verified',
    transactionContextLeak: false,
    cleanup: { containerRemoved: true },
  }) + '\n',
)
