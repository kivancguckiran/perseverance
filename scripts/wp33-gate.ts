// WP33 gerçek-ortam gate'leri (ADR-0033):
//   wp33:provisioning — postgres üzerinde provision/suspend/resume/delete/reconcile
//   wp33:isolation    — iki gerçek tenant ile adversarial sınır testleri
//   wp33:chaos        — runtime recreation + orphan bounded cleanup
// Evidence sözleşmesi wp30/wp31/wp32 ile aynıdır: machineEvidence/failNotRun,
// `.wp33/evidence/` (gitignored), timestamp'siz deterministik JSON, redaksiyon.
// PostgreSQL, Docker ile sağlanır; Docker yoksa WP33_DATABASE_URL (admin yetkili)
// kabul edilir; ikisi de yoksa gate `status:'not-run'` raporlar ve fail-closed
// sayılır. Hiçbir not-run sonucu başarıya terfi ettirilmez.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import pg from 'pg'
import {
  failNotRun,
  machineEvidence,
  redactWp30Evidence,
} from './wp30-evidence'
import { stableJson } from './wp31-release-lib'
import { ZERO_CAPACITY } from '../packages/production-topology/src/index'
import type { CapacityVector } from '../packages/production-topology/src/contracts'
import {
  InMemoryTenantRuntimeResources,
  RuntimeDataPlaneAuthority,
  TenantProvisioningService,
  TenantRuntimeError,
  TENANT_RUNTIME_CONTRACT_VERSION,
  assertReservationWithinBudgets,
  assertQueuePositionBudget,
  simulateWeightedFairSelection,
  type TenantCapacityBudget,
} from '../packages/tenant-runtime/src/index'
import { PostgresTenantRuntimeRepository } from '../packages/tenant-runtime/src/postgres'
import {
  DevSecretProvider,
  SecretLeaseManager,
  SecurityBoundaryError,
  WorkspaceNetworkPolicy,
  canonicalWorkspacePath,
  isDeniedNetworkAddress,
} from '../packages/workspace-security/src/index'

const root = resolve(import.meta.dirname, '..')
const stateDir = resolve(process.env.WP33_OUTPUT_DIR ?? join(root, '.wp33'))
const evidenceDir = join(stateDir, 'evidence')
const gate = process.argv[2] ?? ''

function emit(record: Record<string, unknown>) {
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(
    join(evidenceDir, `${gate.replaceAll(':', '-')}.json`),
    redactWp30Evidence(stableJson({ gate, ...record })),
  )
  machineEvidence(gate, record)
}

function has(command: string, args: string[] = ['--version']) {
  return spawnSync(command, args, { encoding: 'utf8' }).status === 0
}

const MIGRATIONS = [
  '0018_oidc_authorization_rls.sql',
  '0023_pwa_push_multi_device.sql',
  '0035_wp33_managed_tenant_runtime.sql',
] as const

const capacity = (cpuMillis: number): CapacityVector => ({
  ...ZERO_CAPACITY,
  cpuMillis,
  memoryBytes: cpuMillis * 1_000_000,
  pids: Math.ceil(cpuMillis / 10),
  diskBytes: cpuMillis * 1_000_000,
})

const budgetFor = (
  tenantId: string,
  cpuMillis: number,
): TenantCapacityBudget => ({
  schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
  tenantId,
  organizationId: tenantId,
  reservedCapacity: capacity(cpuMillis),
  queueLatencyBudgetMs: 30_000,
  maxStarvationPosition: 8,
  version: 1,
})

interface DatabaseHarness {
  adminPool: pg.Pool
  provisionerUrl: string
  runtimeUrl: string
  serverVersion: string
  source: 'operator-database' | 'docker-postgres'
  cleanup: () => Promise<void>
}

async function acquireDatabase(): Promise<DatabaseHarness> {
  const operatorUrl = process.env.WP33_DATABASE_URL?.trim()
  if (operatorUrl) {
    const adminPool = new pg.Pool({ connectionString: operatorUrl, max: 5 })
    const harness = await prepareDatabase(adminPool, operatorUrl)
    return {
      ...harness,
      source: 'operator-database',
      cleanup: async () => {
        await adminPool.end()
      },
    }
  }
  const missing: string[] = []
  if (!has('docker')) missing.push('docker-cli')
  else if (spawnSync('docker', ['info'], { encoding: 'utf8' }).status !== 0)
    missing.push('docker-daemon')
  if (missing.length > 0) failNotRun(gate, [...missing, 'WP33_DATABASE_URL'])
  const image = process.env.WP33_POSTGRES_TEST_IMAGE ?? 'postgres:17.5-alpine'
  const containerName = `persistent-wp33-postgres-${process.pid}`
  const password = randomBytes(24).toString('hex')
  const started = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      containerName,
      '--label',
      'persistent.wp33=true',
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      'POSTGRES_DB=wp33',
      '-p',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data:rw,size=512m',
      image,
    ],
    { encoding: 'utf8', env: { ...process.env, POSTGRES_PASSWORD: password } },
  )
  assert.equal(
    started.status,
    0,
    `wp33 postgres container başlatılamadı: ${started.stderr}`,
  )
  let ready = false
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = spawnSync(
      'docker',
      ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', 'wp33'],
      { encoding: 'utf8' },
    )
    if (probe.stdout.includes('accepting connections')) {
      ready = true
      break
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250))
  }
  assert.ok(ready, 'wp33 postgres readiness zaman aşımı')
  const portResult = spawnSync('docker', ['port', containerName, '5432/tcp'], {
    encoding: 'utf8',
  })
  const port = portResult.stdout.trim().split(':').at(-1)
  assert.ok(port, 'wp33 postgres portu çözülemedi')
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/wp33`
  const adminPool = new pg.Pool({ connectionString: url, max: 5 })
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await adminPool.query('SELECT 1')
      break
    } catch {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 250))
    }
  }
  const harness = await prepareDatabase(adminPool, url)
  return {
    ...harness,
    source: 'docker-postgres',
    cleanup: async () => {
      await adminPool.end().catch(() => undefined)
      spawnSync('docker', ['rm', '-f', '-v', containerName], {
        encoding: 'utf8',
      })
    },
  }
}

function roleUrl(baseUrl: string, user: string, password: string) {
  const url = new URL(baseUrl)
  url.username = user
  url.password = password
  return url.toString()
}

async function prepareDatabase(adminPool: pg.Pool, baseUrl: string) {
  const version = await adminPool.query('SHOW server_version')
  const serverVersion = String(version.rows[0]?.server_version ?? 'unknown')
  await adminPool.query('DROP SCHEMA IF EXISTS persistent_codex CASCADE')
  for (const migration of MIGRATIONS) {
    const content = readFileSync(
      join(root, 'infra/postgres/migrations', migration),
      'utf8',
    )
    await adminPool.query(content)
  }
  const rolePassword = randomBytes(24).toString('hex')
  for (const role of ['wp33_provisioner', 'wp33_runtime']) {
    await adminPool.query(`DROP ROLE IF EXISTS ${role}`)
    await adminPool.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    )
    await adminPool.query(`GRANT USAGE ON SCHEMA persistent_codex TO ${role}`)
    await adminPool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA persistent_codex TO ${role}`,
    )
  }
  await adminPool.query(
    'GRANT persistent_tenant_provisioner TO wp33_provisioner',
  )
  // İki gerçek tenant tohumu: organization + workspace kayıtları.
  for (const tenantId of ['ten_a', 'ten_b']) {
    await adminPool.query(
      `INSERT INTO persistent_codex.organizations (organization_id, name, status)
       VALUES ($1, $2, 'active') ON CONFLICT DO NOTHING`,
      [tenantId, `Tenant ${tenantId}`],
    )
    for (const workspaceId of ['wsp_main', 'wsp_two']) {
      const client = await adminPool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          "SELECT set_config('app.organization_id', $1, true)",
          [tenantId],
        )
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [
          workspaceId,
        ])
        await client.query(
          `INSERT INTO persistent_codex.workspaces (organization_id, workspace_id, name, tenant_id)
           VALUES ($1, $2, $3, $1) ON CONFLICT DO NOTHING`,
          [tenantId, workspaceId, `${tenantId}/${workspaceId}`],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
  }
  return {
    adminPool,
    provisionerUrl: roleUrl(baseUrl, 'wp33_provisioner', rolePassword),
    runtimeUrl: roleUrl(baseUrl, 'wp33_runtime', rolePassword),
    serverVersion,
  }
}

function buildService(repository: PostgresTenantRuntimeRepository) {
  const resources = new InMemoryTenantRuntimeResources({
    nodeCapacity: capacity(8_000),
    budgets: async () => repository.listCapacityBudgets(),
  })
  const service = new TenantProvisioningService({ repository, resources })
  return { resources, service }
}

const provisionInput = (tenantId: string, workspaceId = 'wsp_main') => ({
  tenantId,
  organizationId: tenantId,
  workspaceId,
  displayName: `Tenant ${tenantId}`,
  regionId: 'region-1',
  capacity: capacity(1_000),
  retentionDays: 30,
  domain: `${tenantId.replaceAll('_', '-')}.example.test`,
  idempotencyKey: `provision:${tenantId}:${workspaceId}`,
})

async function scopedQuery(
  pool: pg.Pool,
  gucs: Record<string, string>,
  sql: string,
  params: unknown[] = [],
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const [key, value] of Object.entries(gucs))
      await client.query('SELECT set_config($1, $2, true)', [key, value])
    const result = await client.query(sql, params)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function seedConversation(
  adminPool: pg.Pool,
  tenantId: string,
  workspaceId: string,
  sessionId: string,
  eventCount: number,
) {
  const gucs = {
    'app.organization_id': tenantId,
    'app.workspace_id': workspaceId,
  }
  await scopedQuery(
    adminPool,
    gucs,
    `INSERT INTO persistent_codex.sessions (organization_id, workspace_id, session_id, status)
     VALUES ($1, $2, $3, 'completed') ON CONFLICT DO NOTHING`,
    [tenantId, workspaceId, sessionId],
  )
  for (let sequence = 1; sequence <= eventCount; sequence += 1) {
    await scopedQuery(
      adminPool,
      gucs,
      `INSERT INTO persistent_codex.events
         (organization_id, workspace_id, session_id, event_id, sequence, payload)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [
        tenantId,
        workspaceId,
        sessionId,
        `evt_${String(sequence).padStart(3, '0')}`,
        sequence,
        JSON.stringify({ type: 'codex.item.completed', ordinal: sequence }),
      ],
    )
  }
  await scopedQuery(
    adminPool,
    gucs,
    `INSERT INTO persistent_codex.artifacts
       (organization_id, workspace_id, session_id, artifact_id, object_key)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [
      tenantId,
      workspaceId,
      sessionId,
      'art_output_1',
      `${tenantId}/${workspaceId}/completed-output.txt`,
    ],
  )
}

async function conversationCounts(
  adminPool: pg.Pool,
  tenantId: string,
  workspaceId: string,
) {
  const gucs = {
    'app.organization_id': tenantId,
    'app.workspace_id': workspaceId,
  }
  const sessions = await scopedQuery(
    adminPool,
    gucs,
    'SELECT count(*)::int AS count FROM persistent_codex.sessions WHERE organization_id = $1 AND workspace_id = $2',
    [tenantId, workspaceId],
  )
  const events = await scopedQuery(
    adminPool,
    gucs,
    'SELECT count(*)::int AS count, COALESCE(max(sequence), 0)::int AS high_water FROM persistent_codex.events WHERE organization_id = $1 AND workspace_id = $2',
    [tenantId, workspaceId],
  )
  const artifacts = await scopedQuery(
    adminPool,
    gucs,
    'SELECT count(*)::int AS count FROM persistent_codex.artifacts WHERE organization_id = $1 AND workspace_id = $2',
    [tenantId, workspaceId],
  )
  return {
    sessions: sessions.rows[0].count as number,
    events: events.rows[0].count as number,
    highWater: events.rows[0].high_water as number,
    completedOutputs: artifacts.rows[0].count as number,
  }
}

async function wp33Provisioning(harness: DatabaseHarness) {
  const repository = new PostgresTenantRuntimeRepository(
    new pg.Pool({ connectionString: harness.provisionerUrl, max: 5 }),
  )
  const { resources, service } = buildService(repository)
  try {
    await repository.putCapacityBudget(budgetFor('ten_a', 2_000), null)
    await repository.putCapacityBudget(budgetFor('ten_b', 2_000), null)

    // Provision: iki gerçek tenant.
    const tenantA = await service.provisionTenant(provisionInput('ten_a'))
    const tenantB = await service.provisionTenant(provisionInput('ten_b'))
    assert.equal(tenantA.tenant.state, 'active')
    assert.equal(tenantB.tenant.state, 'active')
    assert.equal(tenantA.runtime.state, 'ready')
    assert.equal(tenantA.runtime.volumeEncrypted, true)

    // Idempotent yeniden koşum: kaynak çağrısı artmaz.
    const callsBefore = resources.calls.length
    await service.provisionTenant(provisionInput('ten_a'))
    assert.equal(
      resources.calls.length,
      callsBefore,
      'provision idempotent değil',
    )

    // Yarım kalan işlem: fault injection sonrası reconcile aynı duruma yakınsar.
    resources.failNextCall('ensurePlacement')
    let interrupted = false
    try {
      await service.provisionTenant(provisionInput('ten_a', 'wsp_two'))
    } catch (error) {
      interrupted = error instanceof TenantRuntimeError
    }
    assert.ok(interrupted, 'fault injection tetiklenmedi')
    const reconcile = await service.reconcile({
      tenantId: 'ten_a',
      organizationId: 'ten_a',
    })
    assert.equal(reconcile.converged, true, 'reconcile yakınsamadı')
    const recovered = await repository.getRuntime(
      { tenantId: 'ten_a', organizationId: 'ten_a' },
      'wsp_two',
    )
    assert.equal(recovered?.state, 'ready')

    // Suspend/resume.
    await service.suspendTenant({
      tenantId: 'ten_a',
      organizationId: 'ten_a',
      idempotencyKey: 'suspend:a',
    })
    const suspended = await repository.getTenant({
      tenantId: 'ten_a',
      organizationId: 'ten_a',
    })
    assert.equal(suspended?.state, 'suspended')
    await service.resumeTenant({
      tenantId: 'ten_a',
      organizationId: 'ten_a',
      idempotencyKey: 'resume:a',
    })
    const resumed = await repository.getTenant({
      tenantId: 'ten_a',
      organizationId: 'ten_a',
    })
    assert.equal(resumed?.state, 'active')

    // Delete: ters söküm + receipt.
    await service.deleteTenant({
      tenantId: 'ten_b',
      organizationId: 'ten_b',
      idempotencyKey: 'delete:b',
    })
    const deleted = await repository.getTenant({
      tenantId: 'ten_b',
      organizationId: 'ten_b',
    })
    assert.equal(deleted?.state, 'deleted')

    // Optimistic concurrency: yanlış expectedVersion conflict üretir.
    let casEnforced = false
    try {
      await repository.putTenant(
        { ...resumed!, version: resumed!.version + 1 },
        999,
      )
    } catch (error) {
      casEnforced =
        error instanceof TenantRuntimeError &&
        error.code === 'TENANT_RUNTIME_VERSION_CONFLICT'
    }
    assert.ok(casEnforced, 'CAS conflict uygulanmadı')

    // Orphan detection + bounded cleanup.
    for (let index = 0; index < 3; index += 1)
      resources.injectObservedRuntime({
        runtimeId: `rt_ghost_${index}`,
        tenantId: 'ten_ghost',
        organizationId: 'ten_ghost',
        workspaceId: `wsp_${index}`,
        generation: 1,
      })
    const orphans = await service.detectOrphans()
    const firstCleanup = await service.cleanupOrphans(2)
    const secondCleanup = await service.cleanupOrphans(2)
    assert.deepEqual(
      [firstCleanup, secondCleanup],
      [
        { cleaned: 2, remaining: 1 },
        { cleaned: 1, remaining: 0 },
      ],
      'orphan cleanup bounded değil',
    )

    emit({
      accepted: true,
      status: 'passed',
      databaseSource: harness.source,
      postgresServerVersion: harness.serverVersion,
      migrationsApplied: [...MIGRATIONS],
      tenantsProvisioned: 2,
      provisionIdempotent: true,
      interruptedProvisionReconciled: true,
      suspendResumeVerified: true,
      deleteVerified: true,
      casConflictEnforced: true,
      orphansDetected: orphans.length,
      orphanCleanupBounded: [firstCleanup, secondCleanup],
      credentialValuesRecorded: false,
    })
  } finally {
    await repository.close().catch(() => undefined)
  }
}

async function wp33Isolation(harness: DatabaseHarness) {
  const repository = new PostgresTenantRuntimeRepository(
    new pg.Pool({ connectionString: harness.provisionerUrl, max: 5 }),
  )
  const runtimePool = new pg.Pool({
    connectionString: harness.runtimeUrl,
    max: 3,
  })
  const { service } = buildService(repository)
  try {
    await repository.putCapacityBudget(budgetFor('ten_a', 2_000), null)
    await repository.putCapacityBudget(budgetFor('ten_b', 2_000), null)
    await service.provisionTenant(provisionInput('ten_a'))
    await service.provisionTenant(provisionInput('ten_b'))
    await seedConversation(harness.adminPool, 'ten_a', 'wsp_main', 'ses_a', 5)
    await seedConversation(harness.adminPool, 'ten_b', 'wsp_main', 'ses_b', 5)

    // 1) PostgreSQL RLS: Tenant A scope'u tenant B satırlarını göremez.
    const scopeA = { 'app.tenant_id': 'ten_a', 'app.organization_id': 'ten_a' }
    const own = await scopedQuery(
      runtimePool,
      scopeA,
      'SELECT tenant_id FROM persistent_codex.managed_tenants',
    )
    assert.deepEqual(
      own.rows.map((row) => row.tenant_id),
      ['ten_a'],
      'tenant A kendi satırından fazlasını görüyor',
    )
    const crossRuntime = await scopedQuery(
      runtimePool,
      scopeA,
      "SELECT * FROM persistent_codex.tenant_runtimes WHERE tenant_id = 'ten_b'",
    )
    assert.equal(crossRuntime.rowCount, 0, 'cross-tenant runtime satırı sızdı')
    const noScope = await scopedQuery(
      runtimePool,
      {},
      'SELECT * FROM persistent_codex.managed_tenants',
    )
    assert.equal(noScope.rowCount, 0, 'scope`suz sorgu fail-closed değil')
    let crossWriteDenied = false
    try {
      await scopedQuery(
        runtimePool,
        scopeA,
        `INSERT INTO persistent_codex.managed_tenants
           (tenant_id, organization_id, display_name, state, desired_state,
            region_id, retention_days, capacity)
         VALUES ('ten_b','ten_b','forged','active','active','region-1',30,'{}')`,
      )
    } catch {
      crossWriteDenied = true
    }
    assert.ok(crossWriteDenied, 'cross-tenant yazma reddedilmedi')

    // 2) Event sınırı: A scope'u B event'lerini okuyamaz.
    const eventScopeA = {
      'app.organization_id': 'ten_a',
      'app.workspace_id': 'wsp_main',
    }
    const ownEvents = await scopedQuery(
      runtimePool,
      eventScopeA,
      "SELECT count(*)::int AS count FROM persistent_codex.events WHERE organization_id = 'ten_a'",
    )
    assert.equal(ownEvents.rows[0].count, 5)
    const crossEvents = await scopedQuery(
      runtimePool,
      eventScopeA,
      "SELECT count(*)::int AS count FROM persistent_codex.events WHERE organization_id = 'ten_b'",
    )
    assert.equal(crossEvents.rows[0].count, 0, 'cross-tenant event sızdı')

    // 3) Artifact sınırı: tenant prefix CHECK'i ve path traversal reddi.
    let artifactPrefixDenied = false
    try {
      await scopedQuery(
        runtimePool,
        eventScopeA,
        `INSERT INTO persistent_codex.artifacts
           (organization_id, workspace_id, session_id, artifact_id, object_key)
         VALUES ('ten_a','wsp_main','ses_a','art_forged','ten_b/wsp_main/stolen.txt')`,
      )
    } catch {
      artifactPrefixDenied = true
    }
    assert.ok(
      artifactPrefixDenied,
      'cross-tenant artifact object_key kabul edildi',
    )
    const workspaceRoot = join(stateDir, 'isolation', 'ten_a-root')
    mkdirSync(workspaceRoot, { recursive: true })
    let traversalDenied = false
    try {
      canonicalWorkspacePath(workspaceRoot, '../ten_b-root/secret.txt')
    } catch (error) {
      traversalDenied = error instanceof SecurityBoundaryError
    }
    assert.ok(traversalDenied, 'filesystem path traversal reddedilmedi')

    // 4) Secret sınırı: tenant başına ayrı lease kökü; A lease'i B kökünde yoktur.
    const secretValues = new Map([
      ['secret/ten_a/api', Buffer.from('tenant-a-secret')],
      ['secret/ten_b/api', Buffer.from('tenant-b-secret')],
    ])
    const managerA = new SecretLeaseManager(
      new DevSecretProvider(secretValues),
      join(stateDir, 'isolation', 'secrets-ten_a'),
    )
    const managerB = new SecretLeaseManager(
      new DevSecretProvider(secretValues),
      join(stateDir, 'isolation', 'secrets-ten_b'),
    )
    const leaseA = await managerA.issue(
      {
        tenantId: 'ten_a',
        organizationId: 'ten_a',
        workspaceId: 'wsp_main',
        runtimeId: 'rt_ten_a_wsp_main_g1',
        subject: 'runtime:ten_a:wsp_main',
      },
      'secret/ten_a/api',
      60_000,
    )
    assert.ok(
      leaseA.path.includes('secrets-ten_a'),
      'lease dosyası tenant kökünde değil',
    )
    assert.ok(
      !leaseA.path.includes('secrets-ten_b'),
      'lease dosyası yanlış tenant kökünde',
    )
    // B kökü temizliği A lease dosyasını etkilemez; A cleanup kendi dosyasını siler.
    managerB.cleanup('rt_ten_a_wsp_main_g1')
    assert.equal(
      readFileSync(leaseA.path, 'utf8'),
      'tenant-a-secret',
      'tenant A lease dosyası yabancı cleanup ile silindi',
    )
    managerA.cleanup('rt_ten_a_wsp_main_g1')
    let leaseGone = false
    try {
      readFileSync(leaseA.path)
    } catch {
      leaseGone = true
    }
    assert.ok(leaseGone, 'lease cleanup dosyayı silmedi')

    // 5) Network sınırı: default-deny egress + metadata IP reddi + tenant-scoped grant.
    const resolver = { resolve: async () => ['93.184.216.34'] }
    const policy = new WorkspaceNetworkPolicy(resolver)
    const target = {
      protocol: 'https' as const,
      hostname: 'api.example.test',
      port: 443,
    }
    const runtimeScopeA = {
      tenantId: 'ten_a',
      organizationId: 'ten_a',
      workspaceId: 'wsp_main',
      runtimeId: 'rt_ten_a_wsp_main_g1',
    }
    let defaultDeny = false
    try {
      await policy.authorize(runtimeScopeA, target)
    } catch (error) {
      defaultDeny =
        error instanceof SecurityBoundaryError &&
        error.message === 'EGRESS_DEFAULT_DENY'
    }
    assert.ok(defaultDeny, 'egress default-deny değil')
    policy.grant({
      ...runtimeScopeA,
      target,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: 'grant:ten_a',
    })
    const allowed = await policy.authorize(runtimeScopeA, target)
    assert.ok(allowed.grantId, 'scoped grant çalışmadı')
    let crossNetworkDenied = false
    try {
      await policy.authorize(
        { ...runtimeScopeA, tenantId: 'ten_b', organizationId: 'ten_b' },
        target,
      )
    } catch {
      crossNetworkDenied = true
    }
    assert.ok(crossNetworkDenied, 'tenant B, tenant A grant`ini kullanabildi')
    assert.equal(isDeniedNetworkAddress('169.254.169.254'), true)
    assert.equal(isDeniedNetworkAddress('10.0.0.7'), true)

    // 6) Internal auth: cross-tenant credential substitution deny-by-default.
    const authority = new RuntimeDataPlaneAuthority({ repository })
    const credential = await authority.issue({
      tenantId: 'ten_a',
      organizationId: 'ten_a',
      workspaceId: 'wsp_main',
      runtimeId: 'rt_ten_a_wsp_main_g1',
      generation: 1,
    })
    let missingDenied = false
    try {
      await authority.verify({
        action: 'event.append',
        tenantId: 'ten_a',
        organizationId: 'ten_a',
        workspaceId: 'wsp_main',
      })
    } catch (error) {
      missingDenied =
        error instanceof TenantRuntimeError &&
        error.code === 'RUNTIME_AUTH_REQUIRED'
    }
    assert.ok(missingDenied, 'kimliksiz istek reddedilmedi')
    let substitutionDenied = false
    try {
      await authority.verify({
        authorization: `Bearer ${credential.accessToken}`,
        action: 'event.append',
        tenantId: 'ten_b',
        organizationId: 'ten_b',
        workspaceId: 'wsp_main',
      })
    } catch (error) {
      substitutionDenied =
        error instanceof TenantRuntimeError &&
        error.code === 'RUNTIME_SCOPE_REJECTED'
    }
    assert.ok(
      substitutionDenied,
      'cross-tenant credential substitution reddedilmedi',
    )
    await authority.revoke(credential.credentialId)
    let revokedDenied = false
    try {
      await authority.verify({
        authorization: `Bearer ${credential.accessToken}`,
        action: 'event.append',
        tenantId: 'ten_a',
        organizationId: 'ten_a',
        workspaceId: 'wsp_main',
      })
    } catch (error) {
      revokedDenied =
        error instanceof TenantRuntimeError &&
        error.code === 'RUNTIME_TOKEN_REJECTED'
    }
    assert.ok(revokedDenied, 'revoke edilen credential kabul edildi')

    // 7) Noisy-neighbor: kapasite bütçesi + weighted-fair sıra bütçesi.
    const budgets = await repository.listCapacityBudgets()
    let reservationDeniedCode = ''
    try {
      assertReservationWithinBudgets({
        nodeCapacity: capacity(8_000),
        budgets,
        existingReservations: [
          { tenantId: 'ten_a', capacity: capacity(1_000) },
          { tenantId: 'ten_b', capacity: capacity(1_000) },
        ],
        tenantId: 'ten_a',
        requested: capacity(5_500),
      })
    } catch (error) {
      if (error instanceof TenantRuntimeError)
        reservationDeniedCode = error.code
    }
    assert.ok(
      reservationDeniedCode.startsWith('TENANT_BUDGET_ERODED'),
      'bütçeyi aşındıran rezervasyon reddedilmedi',
    )
    const now = new Date('2026-07-24T10:00:00.000Z')
    const at = now.toISOString()
    const fairItem = (tenantId: string, id: string, virtualFinish: number) => ({
      schemaVersion: 1 as const,
      tenantId,
      organizationId: tenantId,
      workspaceId: `wsp_${id}`,
      queueItemId: id,
      runId: `run_${id}`,
      sessionId: `ses_${id}`,
      providerId: 'codex',
      idempotencyKey: `idem_${id}`,
      state: 'queued' as const,
      priority: 0,
      virtualFinish,
      attempt: 0,
      maxAttempts: 4,
      notBefore: at,
      enqueuedAt: at,
      lastErrorCode: null,
      tenantRunning: 0,
      workspaceRunning: 0,
      providerRunning: 0,
      providerRequestsLastMinute: 0,
    })
    const fairPolicy = (tenantId: string, weight: number) => ({
      schemaVersion: 1 as const,
      tenantId,
      organizationId: tenantId,
      policyVersion: 33,
      algorithm: 'weighted-fair-v1' as const,
      weight,
      tenantConcurrency: 4,
      workspaceConcurrency: 1 as const,
      providerConcurrency: { codex: 8 },
      providerRequestsPerMinute: { codex: 6_000 },
      starvationAgeMs: 60_000,
      retry: {
        maxAttempts: 4,
        initialBackoffMs: 100,
        maxBackoffMs: 800,
        poisonAfterAttempts: 4,
      },
      effectiveAt: at,
    })
    const simulation = simulateWeightedFairSelection({
      items: [
        ...Array.from({ length: 500 }, (_, index) =>
          fairItem('ten_a', `a${String(index).padStart(4, '0')}`, index + 1),
        ),
        ...Array.from({ length: 5 }, (_, index) =>
          fairItem('ten_b', `b${index}`, index + 1),
        ),
      ],
      policies: new Map([
        ['ten_a', fairPolicy('ten_a', 1)],
        ['ten_b', fairPolicy('ten_b', 4)],
      ]),
      now,
    })
    const budgetB = budgets.find((entry) => entry.tenantId === 'ten_b')!
    assertQueuePositionBudget(simulation, budgetB)
    const tenantBFirstPosition = simulation.positionsByTenant['ten_b']![0]!

    emit({
      accepted: true,
      status: 'passed',
      databaseSource: harness.source,
      postgresServerVersion: harness.serverVersion,
      tenants: ['ten_a', 'ten_b'],
      boundaries: {
        postgresRls: {
          ownRows: 1,
          crossTenantRows: 0,
          scopelessRows: 0,
          crossTenantWriteDenied: true,
        },
        events: { ownEvents: 5, crossTenantEvents: 0 },
        artifacts: {
          crossTenantObjectKeyDenied: true,
          pathTraversalDenied: true,
        },
        secrets: {
          leaseScopedToTenantRoot: true,
          foreignCleanupIsolated: true,
          cleanupRemovesLease: true,
        },
        network: {
          egressDefaultDeny: true,
          tenantScopedGrantEnforced: true,
          metadataAddressDenied: true,
          privateAddressDenied: true,
        },
        internalAuth: {
          missingCredentialDenied: true,
          crossTenantSubstitutionDenied: true,
          revokedCredentialDenied: true,
        },
      },
      noisyNeighbor: {
        nodeCpuMillis: 8_000,
        tenantBudgetCpuMillis: 2_000,
        erodingReservationDenied: reservationDeniedCode,
        tenantAQueueItems: 500,
        tenantBQueueItems: 5,
        tenantBFirstSelectionPosition: tenantBFirstPosition,
        tenantBPositionBudget: budgetB.maxStarvationPosition,
        tenantBBudgetPreserved: true,
      },
      credentialValuesRecorded: false,
    })
  } finally {
    await runtimePool.end().catch(() => undefined)
    await repository.close().catch(() => undefined)
  }
}

async function wp33Chaos(harness: DatabaseHarness) {
  const repository = new PostgresTenantRuntimeRepository(
    new pg.Pool({ connectionString: harness.provisionerUrl, max: 5 }),
  )
  const { resources, service } = buildService(repository)
  try {
    await repository.putCapacityBudget(budgetFor('ten_a', 2_000), null)
    await service.provisionTenant(provisionInput('ten_a'))
    await seedConversation(harness.adminPool, 'ten_a', 'wsp_main', 'ses_a', 10)
    const before = await conversationCounts(
      harness.adminPool,
      'ten_a',
      'wsp_main',
    )
    assert.deepEqual(before, {
      sessions: 1,
      events: 10,
      highWater: 10,
      completedOutputs: 1,
    })

    const scope = { tenantId: 'ten_a', organizationId: 'ten_a' }
    const originalRuntime = await repository.getRuntime(scope, 'wsp_main')
    const authority = new RuntimeDataPlaneAuthority({ repository })
    const oldCredential = await authority.issue({
      ...scope,
      workspaceId: 'wsp_main',
      runtimeId: originalRuntime!.runtimeId,
      generation: originalRuntime!.generation,
    })

    // Runtime recreation, üstelik yarım kesilerek: fault injection + reconcile.
    resources.failNextCall('ensureVolume')
    let interrupted = false
    try {
      await service.recreateRuntime({
        ...scope,
        workspaceId: 'wsp_main',
        idempotencyKey: 'recreate:1',
      })
    } catch {
      interrupted = true
    }
    assert.ok(interrupted, 'recreation fault injection tetiklenmedi')
    const reconcile = await service.reconcile(scope)
    assert.equal(reconcile.converged, true, 'recreation reconcile yakınsamadı')
    const recreated = await repository.getRuntime(scope, 'wsp_main')
    assert.equal(recreated?.state, 'ready')
    assert.equal(recreated?.generation, 2, 'generation artmadı')

    // Durable conversation ve completed output korunur.
    const after = await conversationCounts(
      harness.adminPool,
      'ten_a',
      'wsp_main',
    )
    assert.deepEqual(after, before, 'runtime recreation durable veriyi bozdu')

    // Detached replay: high-water sonrası sıralı ve boşluksuz event akışı.
    const replay = await scopedQuery(
      harness.adminPool,
      { 'app.organization_id': 'ten_a', 'app.workspace_id': 'wsp_main' },
      `SELECT sequence FROM persistent_codex.events
       WHERE organization_id = 'ten_a' AND workspace_id = 'wsp_main' AND sequence > 5
       ORDER BY sequence`,
    )
    const sequences = replay.rows.map((row) => Number(row.sequence))
    assert.deepEqual(sequences, [6, 7, 8, 9, 10], 'replay boşluksuz değil')

    // Eski generation credential'ı yeni runtime'a yazamaz (stale write reddi).
    let staleDenied = false
    try {
      await authority.verify({
        authorization: `Bearer ${oldCredential.accessToken}`,
        action: 'event.append',
        ...scope,
        workspaceId: 'wsp_main',
        runtimeId: recreated!.runtimeId,
        generation: recreated!.generation,
      })
    } catch (error) {
      staleDenied =
        error instanceof TenantRuntimeError &&
        error.code === 'RUNTIME_SCOPE_REJECTED'
    }
    assert.ok(staleDenied, 'stale generation yazması reddedilmedi')

    // Eski runtime kaydı orphan olarak temizlenir (bounded).
    resources.injectObservedRuntime({
      runtimeId: originalRuntime!.runtimeId,
      tenantId: 'ten_a',
      organizationId: 'ten_a',
      workspaceId: 'wsp_main',
      generation: 1,
    })
    for (let index = 0; index < 2; index += 1)
      resources.injectObservedRuntime({
        runtimeId: `rt_ghost_${index}`,
        tenantId: 'ten_ghost',
        organizationId: 'ten_ghost',
        workspaceId: `wsp_${index}`,
        generation: 1,
      })
    const orphans = await service.detectOrphans()
    assert.equal(orphans.length, 3)
    const firstCleanup = await service.cleanupOrphans(2)
    const secondCleanup = await service.cleanupOrphans(2)
    assert.deepEqual(
      [firstCleanup, secondCleanup],
      [
        { cleaned: 2, remaining: 1 },
        { cleaned: 1, remaining: 0 },
      ],
    )

    emit({
      accepted: true,
      status: 'passed',
      databaseSource: harness.source,
      postgresServerVersion: harness.serverVersion,
      runtimeRecreation: {
        interruptedThenReconciled: true,
        generationBefore: 1,
        generationAfter: recreated!.generation,
      },
      durableConversation: { before, after, preserved: true },
      detachedReplay: {
        afterSequence: 5,
        replayedSequences: sequences,
        gapless: true,
      },
      staleGenerationWriteDenied: true,
      orphanCleanupBounded: [firstCleanup, secondCleanup],
      credentialValuesRecorded: false,
    })
  } finally {
    await repository.close().catch(() => undefined)
  }
}

async function main() {
  const harness = await acquireDatabase()
  try {
    switch (gate) {
      case 'wp33:provisioning':
        await wp33Provisioning(harness)
        return
      case 'wp33:isolation':
        await wp33Isolation(harness)
        return
      case 'wp33:chaos':
        await wp33Chaos(harness)
        return
      default:
        throw new Error(`unknown wp33 gate: ${gate}`)
    }
  } finally {
    await harness.cleanup()
  }
}

try {
  await main()
} catch (error) {
  if (process.exitCode !== 1) {
    emit({
      accepted: false,
      status: 'failed',
      errorCode:
        error instanceof TenantRuntimeError
          ? error.code
          : error instanceof Error
            ? error.message.slice(0, 255)
            : 'unknown',
    })
    process.exitCode = 1
  }
  throw error
}
