import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const id = `persistent-wp27-pitr-${randomUUID()}`
const source = `${id}-source`,
  target = `${id}-target`
const sourceVolume = `${id}-source-data`,
  targetVolume = `${id}-target-data`,
  archiveVolume = `${id}-wal-archive`
const image = process.env.WP27_POSTGRES_IMAGE ?? 'pgvector/pgvector:pg17'
const docker = (args: string[], input?: string, allowFailure = false) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', input })
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
const psql = (container: string, sql: string) =>
  docker([
    'exec',
    '-i',
    container,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-tAc',
    sql,
  ])
const ready = async (container: string) => {
  let consecutive = 0
  for (let attempt = 0; attempt < 160; attempt++) {
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
const migrations = [
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
]
const zeroCapacity = JSON.stringify({
  schemaVersion: 1,
  cpuMillis: 0,
  memoryBytes: 0,
  pids: 0,
  ioBytesPerSecond: 0,
  diskBytes: 0,
  diskInodes: 0,
  diskIops: 0,
  egressBytesPerSecond: 0,
  egressRequestsPerMinute: 0,
  eventBytesPerSecond: 0,
  artifactBytes: 0,
  outputBytes: 0,
  corpusIndexBytes: 0,
})
const lsnWatermark = (output: string) => {
  const match = output.match(
    /([A-F0-9]+\/[A-F0-9]+)\|(\d{4}-\d{2}-\d{2}[^\n]+)/,
  )
  if (!match) throw new Error('PITR_WATERMARK_NOT_OBSERVED')
  return [match[1]!, match[2]!] as const
}

try {
  for (const volume of [sourceVolume, targetVolume, archiveVolume])
    docker(['volume', 'create', volume])
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
    '-v',
    `${archiveVolume}:/archive`,
    image,
    '-c',
    'wal_level=replica',
    '-c',
    'max_wal_senders=5',
    '-c',
    'archive_mode=on',
    '-c',
    `archive_command=test ! -f /archive/%f && cp %p /archive/%f`,
    '-c',
    'archive_timeout=1s',
    '-c',
    'full_page_writes=on',
  ])
  await ready(source)
  docker(['exec', source, 'chown', 'postgres:postgres', '/backup', '/archive'])
  for (const migration of migrations)
    psql(source, readFileSync(`infra/postgres/migrations/${migration}`, 'utf8'))
  psql(
    source,
    `
    INSERT INTO persistent_codex.organizations VALUES ('tenant-a','A','active'),('tenant-b','B','active');
    INSERT INTO persistent_codex.workspaces(tenant_id,organization_id,workspace_id,name) VALUES ('tenant-a','tenant-a','workspace-a','A'),('tenant-b','tenant-b','workspace-b','B');
    INSERT INTO persistent_codex.regions(region_id,state,control_plane_role) VALUES ('eu-1','ready','active');
    INSERT INTO persistent_codex.tenant_scheduling_policies(tenant_id,organization_id,policy_version,algorithm,weight,tenant_concurrency,workspace_concurrency,provider_concurrency,provider_requests_per_minute,starvation_age_ms,retry_policy,effective_at) VALUES ('tenant-a','tenant-a',27,'weighted-fair-v1',1,1,1,'{"codex":1}','{"codex":60}',5000,'{"maxAttempts":4,"initialBackoffMs":100,"maxBackoffMs":1000,"poisonAfterAttempts":4}',now());
    INSERT INTO persistent_codex.scheduler_queue(tenant_id,organization_id,workspace_id,queue_item_id,run_id,session_id,provider_id,idempotency_key,required_region_id,state,virtual_finish,max_attempts,not_before) VALUES ('tenant-a','tenant-a','workspace-a','queue-a','run-a','session-a','codex','pitr-a','eu-1','completed',1,4,now());
    INSERT INTO persistent_codex.workspace_fence_counters VALUES ('tenant-a','tenant-a','workspace-a',1,now());
    INSERT INTO persistent_codex.workspace_leases(tenant_id,organization_id,workspace_id,lease_id,queue_item_id,run_id,owner_id,fencing_token,state,acquired_at,renewed_at,expires_at) VALUES ('tenant-a','tenant-a','workspace-a','lease-a','queue-a','run-a','scheduler-a',1,'released',now()-interval '2 minutes',now()-interval '1 minute',now()+interval '1 minute');
    INSERT INTO persistent_codex.ha_sessions(tenant_id,organization_id,workspace_id,session_id,status,high_water_sequence) VALUES ('tenant-a','tenant-a','workspace-a','session-a','active',1);
    INSERT INTO persistent_codex.ha_runs(tenant_id,organization_id,workspace_id,session_id,run_id,queue_item_id,idempotency_key,request_hash,prompt_object_key,state,fencing_token,terminal_outcome,attempt) VALUES ('tenant-a','tenant-a','workspace-a','session-a','run-a','queue-a','pitr-a',repeat('a',64),'tenant-a/tenant-a/workspace-a/runs/run-a/input','completed',1,'completed',1);
    INSERT INTO persistent_codex.ha_events(tenant_id,organization_id,workspace_id,session_id,run_id,event_id,sequence,event_type,fencing_token,payload,byte_length,occurred_at) VALUES ('tenant-a','tenant-a','workspace-a','session-a','run-a','event-1',1,'turn.started',1,'{"watermark":1}',15,now());
    INSERT INTO persistent_codex.ha_runtime_starts(tenant_id,organization_id,workspace_id,run_id,fencing_token,runtime_id,owner_id,started_at) VALUES ('tenant-a','tenant-a','workspace-a','run-a',1,'runtime-a','scheduler-a',now());
    SELECT set_config('app.organization_id','tenant-a',false),set_config('app.workspace_id','workspace-a',false);
    SELECT persistent_codex.append_security_audit('tenant-a','workspace-a','principal-a','{"actions":["pitr"]}','backup.seed','success','WP27',NULL,NULL,'corr-1');
    CREATE TABLE wp27_pitr_watermarks(id integer PRIMARY KEY, label text UNIQUE, committed_at timestamptz NOT NULL DEFAULT clock_timestamp());
    INSERT INTO wp27_pitr_watermarks(id,label) VALUES (0,'base'); CHECKPOINT;
  `,
  )
  const baseBackupStarted = performance.now()
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
    'none',
    '-c',
    'fast',
  ])
  const backupMs = Math.round(performance.now() - baseBackupStarted)
  const watermark1 = psql(
    source,
    `BEGIN; INSERT INTO wp27_pitr_watermarks(id,label) VALUES (1,'after-backup-1'); INSERT INTO persistent_codex.ha_events VALUES ('tenant-a','tenant-a','workspace-a','session-a','run-a','event-2',2,'turn.delta',1,'{"watermark":2}',15,clock_timestamp(),NULL); UPDATE persistent_codex.ha_sessions SET high_water_sequence=2 WHERE tenant_id='tenant-a' AND workspace_id='workspace-a'; COMMIT; SELECT pg_current_wal_lsn()||'|'||clock_timestamp();`,
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  const watermark2 = psql(
    source,
    `BEGIN; INSERT INTO wp27_pitr_watermarks(id,label) VALUES (2,'after-backup-2'); INSERT INTO persistent_codex.ha_events VALUES ('tenant-a','tenant-a','workspace-a','session-a','run-a','event-3',3,'turn.completed',1,'{"watermark":3}',15,clock_timestamp(),NULL); UPDATE persistent_codex.ha_sessions SET high_water_sequence=3 WHERE tenant_id='tenant-a' AND workspace_id='workspace-a'; SELECT set_config('app.organization_id','tenant-a',true),set_config('app.workspace_id','workspace-a',true); SELECT persistent_codex.append_security_audit('tenant-a','workspace-a','principal-a','{"actions":["pitr"]}','backup.watermark','success','WP27',NULL,NULL,'corr-2'); COMMIT; SELECT pg_current_wal_lsn()||'|'||clock_timestamp();`,
  )
  const [targetLsn, targetTime] = lsnWatermark(watermark2)
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const failureStarted = performance.now()
  const corrupted = psql(
    source,
    `BEGIN; INSERT INTO wp27_pitr_watermarks(id,label) VALUES (3,'after-target-corrupt'); INSERT INTO persistent_codex.ha_events VALUES ('tenant-a','tenant-a','workspace-a','session-a','run-a','event-4',4,'corrupt.marker',1,'{"watermark":4}',15,clock_timestamp(),NULL); DELETE FROM persistent_codex.ha_events WHERE event_id IN ('event-2','event-3'); COMMIT; SELECT pg_current_wal_lsn()||'|'||clock_timestamp(); SELECT pg_switch_wal();`,
  )
  const [sourceFinalLsn, failureTime] = lsnWatermark(corrupted)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  docker(['stop', source])
  const recoveryConfig = `restore_command = 'cp /archive/%f %p'\nrecovery_target_time = '${targetTime}'\nrecovery_target_action = 'promote'\nrecovery_target_inclusive = true\n`
  docker([
    'run',
    '--rm',
    '-v',
    `${targetVolume}:/target`,
    '-v',
    `${archiveVolume}:/archive`,
    image,
    'sh',
    '-c',
    `printf "%s" "$1" >> /target/postgresql.auto.conf && touch /target/recovery.signal && chown postgres:postgres /target/postgresql.auto.conf /target/recovery.signal`,
    'wp27',
    recoveryConfig,
  ])
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
    '-v',
    `${archiveVolume}:/archive:ro`,
    image,
  ])
  await ready(target)
  const restored = psql(
    target,
    `SELECT (SELECT string_agg(id::text,',' ORDER BY id) FROM wp27_pitr_watermarks)||'|'||(SELECT string_agg(sequence::text,',' ORDER BY sequence) FROM persistent_codex.ha_events)||'|'||(SELECT high_water_sequence FROM persistent_codex.ha_sessions WHERE session_id='session-a')||'|'||(SELECT count(*) FROM persistent_codex.ha_runtime_starts)||'|'||(SELECT count(*)-count(DISTINCT runtime_id) FROM persistent_codex.ha_runtime_starts)||'|'||(SELECT count(*) FROM persistent_codex.workspace_leases WHERE fencing_token=1)||'|'||(SELECT last_sequence FROM persistent_codex.security_audit_chain_heads WHERE organization_id='tenant-a')||'|'||COALESCE(pg_last_wal_replay_lsn()::text,pg_current_wal_lsn()::text);`,
  )
  const [
    watermarks,
    sequences,
    highWater,
    runtimeStarts,
    duplicateRuntimeStarts,
    leases,
    auditSequence,
    restoredLsn,
  ] = restored.split('|')
  const crossTenant = Number(
    psql(
      target,
      `DO $$ BEGIN CREATE ROLE wp27_tenant LOGIN PASSWORD 'tenant' NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$; GRANT USAGE ON SCHEMA persistent_codex TO wp27_tenant; GRANT SELECT ON ALL TABLES IN SCHEMA persistent_codex TO wp27_tenant; SET ROLE wp27_tenant; SELECT set_config('app.tenant_id','tenant-b',false),set_config('app.organization_id','tenant-b',false),set_config('app.workspace_id','workspace-b',false); SELECT count(*) FROM persistent_codex.ha_events;`,
    )
      .split('\n')
      .at(-1),
  )
  const lsnGapBytes = Number(
    psql(
      target,
      `SELECT pg_wal_lsn_diff('${sourceFinalLsn}','${restoredLsn}')`,
    ),
  )
  const measuredRpoMs = Math.max(
    0,
    new Date(failureTime).getTime() - new Date(targetTime).getTime(),
  )
  const measuredRtoMs = Math.round(performance.now() - restoreStarted)
  assert.equal(watermarks, '0,1,2')
  assert.equal(sequences, '1,2,3')
  assert.equal(highWater, '3')
  assert.equal(runtimeStarts, '1')
  assert.equal(duplicateRuntimeStarts, '0')
  assert.equal(leases, '1')
  assert.equal(auditSequence, '2')
  assert.equal(crossTenant, 0)
  assert(
    measuredRtoMs <= 900_000 &&
      measuredRpoMs <= 300_000 &&
      performance.now() - failureStarted >= 0,
  )
  console.log(
    JSON.stringify({
      gate: 'wp27:postgres-pitr',
      accepted: true,
      service: `PostgreSQL ${image}`,
      continuousWalArchive: true,
      recoveryTarget: { type: 'timestamp', value: targetTime, lsn: targetLsn },
      watermark1,
      watermark2,
      sourceFinalLsn,
      targetRestoredLsn: restoredLsn,
      sourceTargetLsnGapBytes: lsnGapBytes,
      restoredWatermarks: watermarks,
      excludedAfterTarget: true,
      eventSequences: sequences,
      highWater: Number(highWater),
      tenantGraphVerified: true,
      crossTenantRows: crossTenant,
      auditChainSequence: Number(auditSequence),
      leases: Number(leases),
      runtimeStarts: Number(runtimeStarts),
      duplicateRuntimeStarts: Number(duplicateRuntimeStarts),
      measuredBackupMs: backupMs,
      measuredRpoMs,
      measuredRtoMs,
    }),
  )
} finally {
  docker(['rm', '-f', source, target], undefined, true)
  docker(
    ['volume', 'rm', '-f', sourceVolume, targetVolume, archiveVolume],
    undefined,
    true,
  )
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
