import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import pg from 'pg'
import {
  InMemoryTenantRuntimeResources,
  TenantProvisioningService,
} from '../packages/tenant-runtime/src/index'
import { PostgresTenantRuntimeRepository } from '../packages/tenant-runtime/src/postgres'
import { LocalKmsProvider } from '../packages/workspace-security/src/index'
import {
  StaticProviderAuthCapabilitySource,
  type ProviderAuthFeatureFlags,
} from '../packages/provider-auth/src/index'
import { PostgresProviderAuthRepository } from '../packages/provider-auth/src/postgres'
import { createBillingPostgresRepository } from '../packages/billing-platform/src/index'
import { createProductionPostgresRepository } from '../packages/production-topology/src/production-postgres'
import { createManagedCloudProductionComposition } from '../services/control-plane/src/managed-cloud-production'
import { ProductionRolloutAuthority } from '../services/control-plane/src/production-rollout-authority'
import {
  evaluateManagedCloudLimits,
  ManagedCloudOnboardingService,
  type DurableTaskPort,
} from '../packages/managed-cloud/src/index'
import {
  PostgresAccountWorkspaceProvisioner,
  PostgresManagedCloudAuthorization,
  PostgresManagedCloudPlanCatalog,
  PostgresManagedCloudRepository,
} from '../packages/managed-cloud/src/postgres'
import {
  failNotRun,
  machineEvidence,
  redactWp30Evidence,
} from './wp30-evidence'
import { stableJson } from './wp31-release-lib'
import {
  WP35_POSTGRES_READINESS_TIMEOUT_MS,
  Wp35PostgresReadinessError,
  startWp35DockerPostgres,
  waitForWp35OperatorPostgres,
  type Wp35DockerPostgresLease,
  type Wp35PostgresAttemptDiagnostic,
} from './wp35-postgres-readiness'

const gate = process.argv[2] ?? 'wp35:onboarding'
const root = resolve(import.meta.dirname, '..')
const evidenceDir = join(
  resolve(process.env.WP35_OUTPUT_DIR ?? join(root, '.wp35')),
  'evidence',
)
const migrations = [
  '0018_oidc_authorization_rls.sql',
  '0019_runtime_secrets_envelope_encryption.sql',
  '0021_tenant_corpus_ingestion.sql',
  '0023_pwa_push_multi_device.sql',
  '0024_billing_plan_quota.sql',
  '0025_billing_runtime_composition.sql',
  '0026_prepaid_credit_financial_projection.sql',
  '0028_ha_scheduler_capacity.sql',
  '0029_wp26_production_execution.sql',
  '0030_wp27_observability_dr.sql',
  '0031_wp28_enterprise_lifecycle.sql',
  '0032_wp28_durable_enterprise_lifecycle.sql',
  '0034_wp30_production_rollout.sql',
  '0035_wp33_managed_tenant_runtime.sql',
  '0036_wp34_provider_auth_profiles.sql',
  '0037_wp35_managed_cloud_beta.sql',
] as const

const emit = (record: Record<string, unknown>) => {
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(
    join(evidenceDir, `${gate.replaceAll(':', '-')}.json`),
    redactWp30Evidence(stableJson({ gate, ...record })),
  )
  machineEvidence(gate, record)
}

const hasDocker =
  spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0
const operatorUrl = process.env.WP35_DATABASE_URL?.trim()
if (!operatorUrl && !hasDocker)
  failNotRun(gate, ['docker-daemon', 'WP35_DATABASE_URL'])

let dockerLease: Wp35DockerPostgresLease | undefined
let adminPool: pg.Pool | undefined
let appPool: pg.Pool | undefined
let productionRepository:
  ReturnType<typeof createProductionPostgresRepository> | undefined
let billingRepository:
  ReturnType<typeof createBillingPostgresRepository> | undefined
let currentStep = 'bootstrap'
let readinessDiagnostics: Wp35PostgresAttemptDiagnostic[] = []
let resultRecord: Record<string, unknown> | undefined

try {
  let databaseUrl = operatorUrl
  let databaseSource = 'operator-database'
  if (!databaseUrl) {
    dockerLease = await startWp35DockerPostgres({
      namePrefix: 'persistent-wp35-postgres',
      image: process.env.WP35_POSTGRES_TEST_IMAGE ?? 'postgres:17.5-alpine',
    })
    databaseUrl = dockerLease.databaseUrl
    readinessDiagnostics = dockerLease.diagnostics
    databaseSource = 'docker-postgres'
  } else {
    readinessDiagnostics = [await waitForWp35OperatorPostgres(databaseUrl)]
  }

  adminPool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 5_000,
  })
  currentStep = 'reset-schema'
  await adminPool.query('SELECT 1')
  await adminPool.query('DROP SCHEMA IF EXISTS persistent_codex CASCADE')
  for (const migration of migrations) {
    currentStep = `migration:${migration}`
    await adminPool.query(
      readFileSync(join(root, 'infra/postgres/migrations', migration), 'utf8'),
    )
  }
  await adminPool.query(
    `INSERT INTO persistent_codex.regions(region_id,state,control_plane_role)
     VALUES ('eu-1','ready','active') ON CONFLICT DO NOTHING`,
  )

  currentStep = 'create-application-role'
  const appPassword = randomBytes(24).toString('hex')
  await adminPool.query('DROP ROLE IF EXISTS wp35_app')
  await adminPool.query(
    `CREATE ROLE wp35_app LOGIN PASSWORD '${appPassword}'
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
  )
  await adminPool.query('GRANT USAGE ON SCHEMA persistent_codex TO wp35_app')
  await adminPool.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES
     IN SCHEMA persistent_codex TO wp35_app`,
  )
  await adminPool.query(
    `GRANT USAGE,SELECT ON ALL SEQUENCES
     IN SCHEMA persistent_codex TO wp35_app`,
  )
  const roleUrl = new URL(databaseUrl)
  roleUrl.username = 'wp35_app'
  roleUrl.password = appPassword
  appPool = new pg.Pool({ connectionString: roleUrl.toString(), max: 4 })

  currentStep = 'onboarding-tenant-a'
  const repository = new PostgresManagedCloudRepository(appPool)
  const catalog = new PostgresManagedCloudPlanCatalog(appPool)
  const canonicalPlan = await catalog.resolve('limited-beta', 1)
  const nodeCapacity = Object.fromEntries(
    Object.entries(canonicalPlan.computeQuota).map(([key, value]) => [
      key,
      key === 'schemaVersion' ? value : Number(value) * 4,
    ]),
  ) as typeof canonicalPlan.computeQuota
  const runtimeResources = new InMemoryTenantRuntimeResources({
    nodeCapacity,
  })
  const tasks: DurableTaskPort = {
    async start() {
      return { taskId: 'task_mobile_beta', state: 'running' }
    },
    async replay(_scope, taskId) {
      return {
        taskId,
        state: 'completed',
        output: 'redacted-durable-output',
      }
    },
  }
  const service = new ManagedCloudOnboardingService({
    repository,
    accounts: new PostgresAccountWorkspaceProvisioner(appPool),
    provisioning: new TenantProvisioningService({
      repository: new PostgresTenantRuntimeRepository(appPool),
      resources: runtimeResources,
    }),
    providers: {
      async ensureConnected(input) {
        return {
          schemaVersion: 1,
          ...input.scope,
          profileId: input.profileId!,
          provider: input.provider,
          authMode: input.authMode,
          state: 'active',
          credentialVersion: 1,
          expiresAt: null,
          revokedAt: null,
          disconnectedAt: null,
          cryptoErasedAt: null,
          version: 1,
        }
      },
    },
    tasks,
    // Production composition injects WP30 rollout + WP34 capability/kill switch
    // authority here. This database gate verifies the persisted onboarding seam.
    rollout: { assertAdmission() {} },
    commercial: {
      async assignPlan() {},
      async admitFirstTask({ plan: assigned }) {
        return evaluateManagedCloudLimits({
          plan: assigned,
          usage: [],
          requestedCompute: assigned.computeQuota,
          requestedStorageBytes: 0,
        })
      },
    },
    catalog,
  })
  const command = {
    principal: {
      issuer: 'https://identity.wp35.test',
      subject: 'tenant-a',
    },
    displayName: 'Database Gate',
    workspaceName: 'Mobile',
    regionId: 'eu-1',
    retentionDays: 90,
    domain: null,
    planId: 'limited-beta',
    planVersion: 1,
    provider: 'claude' as const,
    authMode: 'customer-api-key' as const,
    accessToken: `generated-${randomBytes(16).toString('hex')}`,
    firstTaskPrompt: 'continue while client is closed',
    idempotencyKey: 'wp35-database-onboarding',
  }
  const first = await service.run(command)
  currentStep = 'onboarding-replay'
  const second = await service.run(command)
  assert.deepEqual(second, first)
  currentStep = 'onboarding-tenant-b'
  const tenantB = await service.run({
    ...command,
    principal: {
      issuer: 'https://identity.wp35.test',
      subject: 'tenant-b',
    },
    displayName: 'Database Gate B',
    idempotencyKey: 'wp35-database-onboarding-b',
  })
  const authorization = new PostgresManagedCloudAuthorization(appPool)
  currentStep = 'authorization-adversarial'
  assert.deepEqual(
    await authorization.resolveWorkspace(
      command.principal,
      first.workspaceId,
      'read',
    ),
    {
      tenantId: first.tenantId,
      organizationId: first.organizationId,
      workspaceId: first.workspaceId,
    },
  )
  await assert.rejects(
    authorization.resolveWorkspace(
      command.principal,
      tenantB.workspaceId,
      'read',
    ),
    /WORKSPACE_ACCESS_DENIED/,
  )
  const replay = await tasks.replay(first, first.firstTaskId!)
  assert.equal(replay.state, 'completed')

  currentStep = 'production-composition'
  process.env.NODE_ENV = 'test'
  productionRepository = createProductionPostgresRepository(roleUrl.toString())
  billingRepository = createBillingPostgresRepository(roleUrl.toString())
  const objects = new Map<string, Uint8Array>()
  const featureFlags = Object.fromEntries(
    ['codex', 'claude', 'gemini'].flatMap((provider) =>
      [
        'subscription-oauth',
        'customer-api-key',
        'platform-credit',
        'local-cli-credential',
      ].map((mode) => [`${provider}:${mode}`, true]),
    ),
  ) as ProviderAuthFeatureFlags
  const productionRuntimeResources = new InMemoryTenantRuntimeResources({
    nodeCapacity,
  })
  const productionOptions = {
    pool: appPool,
    productionRepository,
    billing: billingRepository,
    objectStore: {
      async put(key, body) {
        objects.set(key, body)
      },
      async get(key) {
        const value = objects.get(key)
        assert.ok(value, 'object not found')
        return value
      },
      async delete(key) {
        objects.delete(key)
      },
      async ready() {
        return true
      },
    },
    broker: {
      async publish() {},
      async ready() {
        return true
      },
    },
    regionId: 'eu-1',
    runtimeResources: productionRuntimeResources,
    kms: new LocalKmsProvider(Buffer.alloc(32, 35)),
    providerCapability: new StaticProviderAuthCapabilitySource({
      deploymentProfile: 'cloud',
      evidenceVersion: 1,
      featureFlags,
      evidenceProvider: (_provider, authMode) =>
        authMode === 'customer-api-key'
          ? {
              evidenceVersion: 1,
              kind: 'customer-key-custody',
              uri: 'https://evidence.invalid/wp35/customer-key-custody',
              sha256: 'a'.repeat(64),
              observedAt: '2026-07-25T00:00:00.000Z',
              effectiveAt: '2026-07-25T00:00:00.000Z',
            }
          : undefined,
    }),
    rolloutId: 'wp35-engineering',
    maxActiveTenants: 50,
  } as const
  const productionComposition =
    createManagedCloudProductionComposition(productionOptions)
  const productionCommand = {
    ...command,
    principal: {
      issuer: 'https://identity.wp35.test',
      subject: 'production-composition',
    },
    displayName: 'Production Composition',
    workspaceName: 'Production Workspace',
    idempotencyKey: 'wp35-production-composition',
    accessToken: `generated-${randomBytes(16).toString('hex')}`,
  }
  const principalDigest = createHash('sha256')
    .update(
      `${productionCommand.principal.issuer}\0${productionCommand.principal.subject}`,
    )
    .digest('hex')
  const seed = createHash('sha256')
    .update(`${principalDigest}:${productionCommand.idempotencyKey}`)
    .digest('hex')
  const tenantId = `tenant_${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
  const workspaceId = `workspace_${createHash('sha256')
    .update(`${seed}:${productionCommand.workspaceName}`)
    .digest('hex')
    .slice(0, 24)}`
  const productionScope = {
    tenantId,
    organizationId: tenantId,
    workspaceId,
  }
  await new PostgresAccountWorkspaceProvisioner(appPool).ensure({
    scope: productionScope,
    accountId: 'preflight',
    issuer: productionCommand.principal.issuer,
    subject: productionCommand.principal.subject,
    principalDigest,
    displayName: productionCommand.displayName,
    workspaceName: productionCommand.workspaceName,
    idempotencyKey: 'preflight',
  })
  await new PostgresProviderAuthRepository(appPool).putKillSwitch(
    {
      ...productionScope,
      provider: 'claude',
      authMode: 'customer-api-key',
      enabled: true,
      termsEvidenceHash: 'b'.repeat(64),
      version: 1,
    },
    null,
  )
  const productionOnboarding =
    await productionComposition.onboarding.run(productionCommand)
  assert.equal(productionOnboarding.state, 'completed')
  const productionReplay = await productionComposition.tasks.replay(
    productionScope,
    productionOnboarding.firstTaskId!,
  )
  assert.equal(productionReplay.state, 'running')
  assert.ok(objects.size > 0)
  const credentialEnvelope = await adminPool.query<{ envelope: string }>(
    `SELECT credential_envelope::text AS envelope
     FROM persistent_codex.provider_auth_profiles
     WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3`,
    [tenantId, tenantId, workspaceId],
  )
  assert.equal(credentialEnvelope.rowCount, 1)
  assert.ok(
    !credentialEnvelope.rows[0]!.envelope.includes(
      productionCommand.accessToken,
    ),
  )

  currentStep = 'billing-drill'
  const creditsBefore = await billingRepository.creditAccount(productionScope)
  const reservation = await productionComposition.credits.reserve({
    scope: productionScope,
    taskId: 'billing-completed-task',
    maximumCreditsMicros: 1_000,
    idempotencyKey: 'wp35-reserve-completed',
  })
  const settlement = await productionComposition.credits.settle({
    scope: productionScope,
    reservationId: reservation.reservationId,
    measuredCreditsMicros: 600,
    outcome: 'completed',
  })
  const refundReservation = await productionComposition.credits.reserve({
    scope: productionScope,
    taskId: 'billing-interrupted-task',
    maximumCreditsMicros: 1_000,
    idempotencyKey: 'wp35-reserve-interrupted',
  })
  const refund = await productionComposition.credits.refund(
    productionScope,
    refundReservation.reservationId,
  )
  const creditsAfter = await billingRepository.creditAccount(productionScope)
  assert.equal(
    creditsBefore.balance.availableCreditsMicros -
      creditsAfter.balance.availableCreditsMicros,
    600,
  )
  assert.equal(settlement.measuredCreditsMicros, 600)
  assert.equal(refund.measuredCreditsMicros, 0)

  currentStep = 'rollout-halt-rollback-drill'
  const rolloutAuthority = new ProductionRolloutAuthority(appPool)
  const halted = await rolloutAuthority.transition({
    ...productionScope,
    rolloutId: 'wp35-engineering',
    expectedVersion: 1,
    idempotencyKey: 'wp35-operator-halt',
    next: 'halted',
    cohortId: 'internal',
    operatorHalt: true,
  })
  const rolledBack = await rolloutAuthority.transition({
    ...productionScope,
    rolloutId: 'wp35-engineering',
    expectedVersion: Number(halted.version),
    idempotencyKey: 'wp35-rollback',
    next: 'rolled_back',
    cohortId: 'internal',
    rollbackVerified: true,
  })
  assert.equal(rolledBack.stage, 'rolled_back')
  const capacityComposition = createManagedCloudProductionComposition({
    ...productionOptions,
    rolloutId: 'wp35-capacity-halt',
    maxActiveTenants: 0,
  })
  await assert.rejects(
    capacityComposition.onboarding.run({
      ...productionCommand,
      principal: {
        issuer: 'https://identity.wp35.test',
        subject: 'capacity-halt',
      },
      displayName: 'Capacity Halt',
      workspaceName: 'Capacity Halt',
      idempotencyKey: 'wp35-capacity-halt',
      accessToken: `generated-${randomBytes(16).toString('hex')}`,
    }),
    /MANAGED_BETA_CAPACITY_HALT/,
  )

  currentStep = 'lifecycle-export-delete-drill'
  const exported = await productionComposition.lifecycle.exportTenant(
    productionScope,
    'wp35-export',
  )
  assert.equal(exported.state, 'requested')
  const deleted = await productionComposition.lifecycle.deleteTenant(
    productionScope,
    'wp35-delete',
  )
  assert.equal(deleted.tenantState, 'deleted')
  assert.equal(deleted.credentialsCryptoErased, 1)
  const deletedCredential = await adminPool.query<{
    state: string
    credential_envelope: unknown
  }>(
    `SELECT state,credential_envelope
     FROM persistent_codex.provider_auth_profiles
     WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3`,
    [tenantId, tenantId, workspaceId],
  )
  assert.equal(deletedCredential.rows[0]!.state, 'crypto-erased')
  assert.equal(deletedCredential.rows[0]!.credential_envelope, null)
  assert.equal(productionRuntimeResources.listReservations().length, 0)

  const version = await adminPool.query('SHOW server_version')
  currentStep = 'forced-rls-audit'
  const forcedRls = await adminPool.query<{ count: string }>(
    `SELECT count(*) AS count
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='persistent_codex' AND c.relrowsecurity
       AND NOT c.relforcerowsecurity`,
  )
  assert.equal(Number(forcedRls.rows[0]!.count), 0)
  resultRecord = {
    accepted: true,
    status: 'passed',
    databaseSource,
    serverVersion: String(version.rows[0]?.server_version ?? 'unknown'),
    migrations: [...migrations],
    onboardingSteps: [
      'signup',
      'workspace',
      'provider-connection-port',
      'first-task',
      'closed-client-continuation',
      'replay',
    ],
    idempotentReplay: true,
    adversarialTenants: 2,
    crossTenantDenied: true,
    forcedRlsVerified: true,
    taskState: replay.state,
    billingAuthority: 'wp24-billing-platform-separate-gate',
    rlsRole: 'non-bypass',
    credentialPersisted: false,
    productionComposition: {
      wp33TenantRuntime: true,
      wp34ProviderVaultAndKillSwitch: true,
      wp24BillingLedger: true,
      wp30RolloutAuthority: true,
      durableTaskAndReplay: true,
      wp28LifecycleAdapter: true,
      firstTaskState: productionReplay.state,
      credentialEnvelopeRedacted: true,
    },
    billingDrill: {
      reservedCreditsMicros: 2_000,
      settledCreditsMicros: 600,
      refundedCreditsMicros: 1_000,
      reconciliationDifferenceMicros: 0,
    },
    rolloutDrill: {
      operatorHalt: true,
      rollback: rolledBack.stage,
      capacityHalt: true,
    },
    lifecycleDrill: {
      exportState: exported.state,
      deleteState: deleted.tenantState,
      credentialState: deletedCredential.rows[0]!.state,
      cryptoErasedProfiles: deleted.credentialsCryptoErased,
      runtimeReservationsRemaining: 0,
    },
  }
} catch (error) {
  readinessDiagnostics =
    error instanceof Wp35PostgresReadinessError
      ? error.diagnostics
      : (dockerLease?.captureDiagnostics() ?? readinessDiagnostics)
  resultRecord = {
    accepted: false,
    status: 'failed',
    error:
      error instanceof Error
        ? error.message.replace(/postgresql:\/\/\S+/g, '[redacted-uri]')
        : 'unknown',
    step: currentStep,
  }
  process.exitCode = 1
} finally {
  await productionRepository?.close().catch(() => undefined)
  await billingRepository?.close().catch(() => undefined)
  await appPool?.end().catch(() => undefined)
  await adminPool?.end().catch(() => undefined)
  dockerLease?.cleanup()
  emit({
    ...(resultRecord ?? {
      accepted: false,
      status: 'failed',
      error: 'missing gate result',
      step: currentStep,
    }),
    postgresReadiness: {
      timeoutMs: WP35_POSTGRES_READINESS_TIMEOUT_MS,
      maximumInfrastructureAttempts: operatorUrl ? 1 : 2,
      attempts: readinessDiagnostics,
    },
  })
}
