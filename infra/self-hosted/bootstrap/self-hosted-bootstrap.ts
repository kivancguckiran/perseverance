// WP32 — self-hosted ilk kurulum bootstrap'i (ADR-0032).
// `bootstrap` one-shot compose servisi olarak product imajında koşar. İdempotenttir:
// ilk organizasyonu, admin principal'ını, owner üyeliğini, workspace'i, region ve
// runtime node kaydını, scheduling policy'yi, byok billing planını ve object
// storage bucket'ını oluşturur. Secret değerleri asla stdout'a yazmaz.
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { createBillingPostgresRepository } from '../../../packages/billing-platform/src/index'
import { S3CompatibleObjectStore } from '../../../packages/production-topology/src/durable-dependencies'

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`bootstrap requires ${name}`)
  return value
}

const issuer = required('BOOTSTRAP_ISSUER')
const adminSubject = required('BOOTSTRAP_ADMIN_SUBJECT')
const organizationId = required('BOOTSTRAP_ORGANIZATION_ID')
const workspaceId = required('BOOTSTRAP_WORKSPACE_ID')
const organizationName = required('BOOTSTRAP_ORGANIZATION_NAME')
const regionId = required('BOOTSTRAP_REGION_ID')
const nodeId = required('BOOTSTRAP_NODE_ID')
const cpuMillis = Number(required('BOOTSTRAP_NODE_CPU_MILLIS'))
const memoryBytes = Number(required('BOOTSTRAP_NODE_MEMORY_BYTES'))
if (!Number.isFinite(cpuMillis) || cpuMillis <= 0)
  throw new Error('invalid BOOTSTRAP_NODE_CPU_MILLIS')
if (!Number.isFinite(memoryBytes) || memoryBytes <= 0)
  throw new Error('invalid BOOTSTRAP_NODE_MEMORY_BYTES')

const password = readFileSync(required('POSTGRES_PASSWORD_FILE'), 'utf8').trim()
const host = required('PGHOST')
const port = Number(required('PGPORT'))
const database = required('PGDATABASE')
const user = required('PGUSER')

const capacity = {
  schemaVersion: 1,
  cpuMillis,
  memoryBytes,
  pids: 1024,
  ioBytesPerSecond: 200_000_000,
  diskBytes: 100_000_000_000,
  diskInodes: 2_000_000,
  diskIops: 20_000,
  egressBytesPerSecond: 200_000_000,
  egressRequestsPerMinute: 20_000,
  eventBytesPerSecond: 20_000_000,
  artifactBytes: 100_000_000_000,
  outputBytes: 20_000_000_000,
  corpusIndexBytes: 100_000_000_000,
}
const zeroCapacity = Object.fromEntries(
  Object.entries(capacity).map(([key, value]) => [
    key,
    key === 'schemaVersion' ? value : 0,
  ]),
)

const pool = new pg.Pool({ host, port, database, user, password })
try {
  await pool.query('BEGIN')
  await pool.query(
    `INSERT INTO persistent_codex.organizations(organization_id,name,status)
     VALUES ($1,$2,'active') ON CONFLICT DO NOTHING`,
    [organizationId, organizationName],
  )
  await pool.query(
    `INSERT INTO persistent_codex.principal_identities(issuer,subject,status)
     VALUES ($1,$2,'active') ON CONFLICT DO NOTHING`,
    [issuer, adminSubject],
  )
  await pool.query(
    `INSERT INTO persistent_codex.organization_memberships(organization_id,issuer,subject,role,status)
     VALUES ($1,$2,$3,'owner','active') ON CONFLICT DO NOTHING`,
    [organizationId, issuer, adminSubject],
  )
  await pool.query(
    `INSERT INTO persistent_codex.workspaces(tenant_id,organization_id,workspace_id,name)
     VALUES ($1,$1,$2,'Self-hosted workspace') ON CONFLICT DO NOTHING`,
    [organizationId, workspaceId],
  )
  await pool.query(
    `INSERT INTO persistent_codex.regions(region_id,state,control_plane_role)
     VALUES ($1,'ready','active') ON CONFLICT DO NOTHING`,
    [regionId],
  )
  await pool.query(
    `INSERT INTO persistent_codex.runtime_nodes(region_id,node_id,state,capacity_total,capacity_reserved,capacity_score,heartbeat_at)
     VALUES ($1,$2,'ready',$3,$4,100,now()) ON CONFLICT DO NOTHING`,
    [regionId, nodeId, capacity, zeroCapacity],
  )
  await pool.query(
    `INSERT INTO persistent_codex.tenant_scheduling_policies
       (tenant_id,organization_id,policy_version,algorithm,weight,tenant_concurrency,workspace_concurrency,provider_concurrency,provider_requests_per_minute,starvation_age_ms,retry_policy,effective_at)
     VALUES ($1,$2,32,'weighted-fair-v1',1,2,1,'{"codex":2}','{"codex":120}',5000,'{"maxAttempts":4,"initialBackoffMs":100,"maxBackoffMs":1000,"poisonAfterAttempts":4}',now())
     ON CONFLICT DO NOTHING`,
    [organizationId, organizationId],
  )
  await pool.query('COMMIT')
} catch (error) {
  await pool.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  await pool.end()
}

const billingSeed = {
  initialPromotionalCreditsMicros: 0,
  plan: {
    schemaVersion: 1 as const,
    planId: 'self-hosted',
    planVersion: 32,
    displayName: 'Self-hosted',
    currency: 'USD' as const,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null,
    billingMode: 'byok' as const,
    taxBehavior: 'unknown' as const,
  },
  entitlements: ['turn.start', 'workspace.concurrency'].map((key, index) => ({
    schemaVersion: 1 as const,
    entitlementId: `self-hosted-entitlement-${index}`,
    planId: 'self-hosted',
    planVersion: 32,
    key: key as 'turn.start' | 'workspace.concurrency',
    enabled: true,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    sourceWebhookEventId: null,
  })),
  budgets: [
    {
      schemaVersion: 1 as const,
      budgetId: 'self-hosted-monthly',
      period: 'month' as const,
      currency: 'USD' as const,
      softLimitMicros: 8_000_000_000,
      hardLimitMicros: 10_000_000_000,
      effectiveAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    },
  ],
  quotas: [
    {
      schemaVersion: 1 as const,
      quotaId: 'self-hosted-concurrency',
      policyVersion: 32,
      meter: 'tenant_concurrent_turn' as const,
      softLimit: 3,
      hardLimit: 4,
      inFlightPolicy: 'continue' as const,
      effectiveAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    },
  ],
  retailPriceCatalog: {
    schemaVersion: 1 as const,
    catalogId: 'self-hosted-retail',
    catalogVersion: 'self-hosted-retail-v1',
    currency: 'USD' as const,
    rates: [
      { meter: 'provider_input_token' as const, creditsMicrosPerUnit: 1 },
      { meter: 'provider_output_token' as const, creditsMicrosPerUnit: 2 },
      { meter: 'compute_millisecond' as const, creditsMicrosPerUnit: 1 },
    ],
    operationMaximums: [
      { operation: 'turn.start' as const, maximumCreditsMicros: 100_000 },
      {
        operation: 'workspace.concurrency' as const,
        maximumCreditsMicros: 100_000,
      },
    ],
    idempotencyKey: 'self-hosted-retail-v1',
    paymentReference: null,
    usageDedupeKey: null,
    runId: null,
    operationReference: null,
    occurredAt: '2026-01-01T00:00:00.000Z',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null,
  },
}

const databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`
const billing = createBillingPostgresRepository(databaseUrl, {
  developmentSeed: billingSeed,
})
try {
  await billing.snapshot({
    tenantId: organizationId,
    organizationId,
    workspaceId,
  })
} finally {
  await billing.close()
}

const objects = new S3CompatibleObjectStore({
  endpoint: required('OBJECT_STORAGE_ENDPOINT'),
  bucket: required('OBJECT_STORAGE_BUCKET'),
  accessKeyId: required('OBJECT_STORAGE_ACCESS_KEY_ID'),
  secretAccessKey: required('OBJECT_STORAGE_SECRET_ACCESS_KEY'),
})
await objects.ensureBucket()

process.stdout.write(
  `${JSON.stringify({
    bootstrap: 'self-hosted',
    organizationId,
    workspaceId,
    adminSubject,
    regionId,
    nodeId,
    billingPlan: 'self-hosted@32',
  })}\n`,
)
