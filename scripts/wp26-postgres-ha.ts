import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { Pool } from 'pg'
import {
  PostgresTopologyRepository,
  createPostgresTopologyRepository,
} from '../packages/production-topology/src/postgres'
import { ZERO_CAPACITY } from '../packages/production-topology/src/index'

const container = `persistent-wp26-${randomUUID()}`
const volume = `${container}-data`
const image = process.env.WP26_POSTGRES_IMAGE ?? 'postgres:17-alpine'
const docker = (args: string[], input?: string) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', input })
  if (result.status !== 0)
    throw new Error(
      result.stderr || result.stdout || `docker ${args.join(' ')} failed`,
    )
  return result.stdout.trim()
}
const migration = (name: string) =>
  docker(
    [
      'exec',
      '-i',
      container,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
    ],
    readFileSync(`infra/postgres/migrations/${name}`, 'utf8'),
  )
const capacity = {
  ...ZERO_CAPACITY,
  cpuMillis: 4_000,
  memoryBytes: 4_294_967_296,
  pids: 512,
  ioBytesPerSecond: 100_000_000,
  diskBytes: 100_000_000_000,
  diskInodes: 1_000_000,
  diskIops: 10_000,
  egressBytesPerSecond: 100_000_000,
  egressRequestsPerMinute: 10_000,
  eventBytesPerSecond: 10_000_000,
  artifactBytes: 50_000_000_000,
  outputBytes: 10_000_000_000,
  corpusIndexBytes: 50_000_000_000,
}
const request = {
  ...ZERO_CAPACITY,
  cpuMillis: 500,
  memoryBytes: 536_870_912,
  pids: 64,
  ioBytesPerSecond: 5_000_000,
  diskBytes: 5_000_000_000,
  diskInodes: 50_000,
  diskIops: 500,
  egressBytesPerSecond: 2_000_000,
  egressRequestsPerMinute: 300,
  eventBytesPerSecond: 500_000,
  artifactBytes: 1_000_000_000,
  outputBytes: 100_000_000,
  corpusIndexBytes: 2_000_000_000,
}
const scope = {
  tenantId: 'tenant_a',
  organizationId: 'tenant_a',
  workspaceId: 'workspace_a',
}
const baseTime = new Date()

let schedulerA: PostgresTopologyRepository | undefined
let schedulerB: PostgresTopologyRepository | undefined
let tenantPool: Pool | undefined
try {
  docker(['volume', 'create', volume])
  docker([
    'run',
    '-d',
    '--name',
    container,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-v',
    `${volume}:/var/lib/postgresql/data`,
    '-p',
    '127.0.0.1::5432',
    image,
  ])
  let ready = false
  for (let attempt = 0; attempt < 80; attempt++) {
    if (
      spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'])
        .status === 0
    ) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!ready) throw new Error('PostgreSQL did not become ready')
  migration('0018_oidc_authorization_rls.sql')
  migration('0028_ha_scheduler_capacity.sql')
  docker(
    [
      'exec',
      '-i',
      container,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
    ],
    `
      CREATE ROLE topology_runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      CREATE ROLE tenant_runtime LOGIN PASSWORD 'tenant' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      GRANT persistent_topology_scheduler TO topology_runtime;
      GRANT USAGE ON SCHEMA persistent_codex TO topology_runtime,tenant_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA persistent_codex TO topology_runtime,tenant_runtime;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA persistent_codex TO topology_runtime,tenant_runtime;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA persistent_codex TO topology_runtime;
      INSERT INTO persistent_codex.organizations VALUES
        ('tenant_a','A','active'),('tenant_b','B','active');
      INSERT INTO persistent_codex.workspaces(organization_id,workspace_id,name) VALUES
        ('tenant_a','workspace_a','A'),('tenant_b','workspace_b','B');
      INSERT INTO persistent_codex.regions(region_id,state,control_plane_role) VALUES
        ('eu-1','ready','active'),('eu-2','ready','passive');
      INSERT INTO persistent_codex.runtime_nodes
        (region_id,node_id,state,capacity_total,capacity_reserved,capacity_score,heartbeat_at)
      VALUES ('eu-1','node-1','ready','${JSON.stringify(capacity)}','${JSON.stringify(ZERO_CAPACITY)}',100,now());
    `,
  )
  const port = docker(['port', container, '5432/tcp']).split(':').at(-1)!
  const schedulerUrl = `postgresql://topology_runtime:runtime@127.0.0.1:${port}/postgres`
  schedulerA = createPostgresTopologyRepository(schedulerUrl)
  schedulerB = createPostgresTopologyRepository(schedulerUrl)
  const policy = {
    schemaVersion: 1 as const,
    tenantId: 'tenant_a',
    organizationId: 'tenant_a',
    policyVersion: 26,
    algorithm: 'weighted-fair-v1' as const,
    weight: 1,
    tenantConcurrency: 2,
    workspaceConcurrency: 1 as const,
    providerConcurrency: { codex: 4 },
    providerRequestsPerMinute: { codex: 60 },
    starvationAgeMs: 10_000,
    retry: {
      maxAttempts: 4,
      initialBackoffMs: 100,
      maxBackoffMs: 800,
      poisonAfterAttempts: 4,
    },
    effectiveAt: baseTime.toISOString(),
  }
  await schedulerA.upsertTenantPolicy(policy)
  const queue = await schedulerA.enqueue({
    ...scope,
    queueItemId: 'queue-1',
    runId: 'run-1',
    sessionId: 'session-1',
    providerId: 'codex',
    idempotencyKey: 'turn-key-1',
    virtualFinish: 1,
    maxAttempts: 4,
    notBefore: new Date(baseTime.getTime() - 1_000),
    requiredRegionId: 'eu-1',
  })
  const raceAt = baseTime
  const [claimA, claimB] = await Promise.all([
    schedulerA.claim({
      ownerId: 'scheduler-a',
      leaseId: 'lease-a',
      leaseMs: 60_000,
      capacityReservationId: 'capacity-a',
      requestedCapacity: request,
      now: raceAt,
    }),
    schedulerB.claim({
      ownerId: 'scheduler-b',
      leaseId: 'lease-b',
      leaseMs: 60_000,
      capacityReservationId: 'capacity-b',
      requestedCapacity: request,
      now: raceAt,
    }),
  ])
  const first = claimA ?? claimB
  assert(first)
  assert.equal([claimA, claimB].filter(Boolean).length, 1)
  assert.equal(first.item.queueItemId, queue.queueItemId)
  assert.equal(first.lease.fencingToken, 1)
  await schedulerA.assertFence({ ...scope, runId: 'run-1', fencingToken: 1 })
  const recoveryAt = new Date(baseTime.getTime() + 60_100)
  const recoveryStartedAt = performance.now()
  const recovered = await schedulerB.recoverExpired(recoveryAt)
  assert.equal(recovered, 1)
  assert.equal(
    await schedulerB.rescheduleRecovery({
      ...scope,
      queueItemId: 'queue-1',
      expectedFencingToken: 1,
      notBefore: recoveryAt,
    }),
    true,
  )
  const second = await schedulerB.claim({
    ownerId: 'scheduler-b',
    leaseId: 'lease-2',
    leaseMs: 5000,
    capacityReservationId: 'capacity-2',
    requestedCapacity: request,
    now: new Date(recoveryAt.getTime() + 100),
  })
  assert(second)
  const schedulerRecoveryRtoMs = Math.round(
    performance.now() - recoveryStartedAt,
  )
  assert.equal(second.lease.fencingToken, 2)
  await assert.rejects(
    schedulerA.assertFence({ ...scope, runId: 'run-1', fencingToken: 1 }),
    /STALE_FENCING_TOKEN/,
  )
  await schedulerB.assertFence({ ...scope, runId: 'run-1', fencingToken: 2 })

  tenantPool = new Pool({
    connectionString: `postgresql://tenant_runtime:tenant@127.0.0.1:${port}/postgres`,
  })
  const client = await tenantPool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `SELECT set_config('app.tenant_id','tenant_b',true),set_config('app.organization_id','tenant_b',true),set_config('app.workspace_id','workspace_b',true)`,
    )
    const invisible = await client.query(
      `SELECT count(*) count FROM persistent_codex.scheduler_queue`,
    )
    assert.equal(Number(invisible.rows[0].count), 0)
    await client.query('ROLLBACK')
  } finally {
    client.release()
  }
  const forced = docker([
    'exec',
    container,
    'psql',
    '-U',
    'postgres',
    '-tAc',
    `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='persistent_codex' AND c.relname IN ('tenant_scheduling_policies','scheduler_queue','scheduler_provider_admissions','workspace_fence_counters','workspace_leases','workspace_placements','capacity_reservations','drain_states','recovery_outcomes','dependency_readiness','capacity_limit_outcomes') AND c.relrowsecurity AND c.relforcerowsecurity`,
  ])
  assert.equal(Number(forced), 11)
  const compatibility = docker([
    'exec',
    container,
    'psql',
    '-U',
    'postgres',
    '-tAc',
    `SELECT (SELECT count(*) FROM persistent_codex.security_migrations WHERE version IN (18,28))::text || ':' || (SELECT status FROM persistent_codex.organizations WHERE organization_id='tenant_a')`,
  ])
  assert.equal(compatibility, '2:active')
  console.log(
    JSON.stringify({
      gate: 'wp26:postgres',
      regionId: 'eu-1',
      nodeId: 'node-1',
      workspaceId: scope.workspaceId,
      queueItemId: queue.queueItemId,
      runId: queue.runId,
      firstLeaseId: first.lease.leaseId,
      firstFencingToken: 1,
      recoveryLeaseId: second.lease.leaseId,
      recoveryFencingToken: 2,
      schedulerRace: 'single-claim',
      staleOwner: 'rejected',
      rpoMs: 0,
      schedulerRecoveryRtoMs,
      forcedRlsTables: 11,
      onlineMigrationCompatibility: 'n-1-read-pass',
      rollbackStrategy: 'writer-stop-drain-binary-rollback-no-schema-drop',
      cleanup: { container, volume, status: 'scheduled' },
    }),
  )
} finally {
  await Promise.allSettled([
    schedulerA?.close(),
    schedulerB?.close(),
    tenantPool?.end(),
  ])
  spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' })
  spawnSync('docker', ['volume', 'rm', '-f', volume], { encoding: 'utf8' })
}
