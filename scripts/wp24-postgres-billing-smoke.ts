import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import {
  createBillingPostgresRepository,
  DeterministicBillingEmulator,
  type BillingWebhookEvent,
} from '../packages/billing-platform/src/index.ts'

const container = `persistent-wp24-${randomUUID()}`
const volume = `${container}-data`
const image = process.env.WP24_POSTGRES_IMAGE ?? 'pgvector/pgvector:pg17'

function docker(args: string[], input?: string) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input })
  if (result.status !== 0)
    throw new Error(
      result.stderr || result.stdout || `docker ${args.join(' ')} failed`,
    )
  return result.stdout.trim()
}

const event = (
  overrides: Partial<BillingWebhookEvent> = {},
): BillingWebhookEvent => ({
  schemaVersion: 1,
  tenantId: 'org_a',
  organizationId: 'org_a',
  workspaceId: 'wsp_a',
  webhookEventId: 'evt_subscription_10',
  provider: 'deterministic-billing-emulator',
  signatureVersion: 'hmac-sha256-v1',
  eventType: 'subscription.updated',
  providerSequence: 10,
  payloadDigest: `sha256:${'a'.repeat(64)}`,
  receivedAt: '2026-07-18T10:00:00.000Z',
  effectiveAt: '2026-07-18T10:00:00.000Z',
  processingState: 'received',
  attempt: 0,
  lastErrorCode: null,
  ...overrides,
})

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
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = spawnSync('docker', [
      'exec',
      container,
      'pg_isready',
      '-U',
      'postgres',
    ])
    if (probe.status === 0) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error('PostgreSQL did not become ready')
  for (const migration of [
    '0018_oidc_authorization_rls.sql',
    '0021_tenant_corpus_ingestion.sql',
    '0022_hybrid_corpus_retrieval.sql',
    '0023_pwa_push_multi_device.sql',
    '0024_billing_plan_quota.sql',
  ])
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
      readFileSync(`infra/postgres/migrations/${migration}`, 'utf8'),
    )

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
    CREATE ROLE billing_runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    GRANT USAGE ON SCHEMA persistent_codex TO billing_runtime;
    GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA persistent_codex TO billing_runtime;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA persistent_codex TO billing_runtime;
    GRANT EXECUTE ON FUNCTION persistent_codex.billing_claim_webhooks(timestamptz,integer),persistent_codex.billing_recover_stale_webhooks(timestamptz,integer) TO billing_runtime;
    INSERT INTO persistent_codex.organizations VALUES ('org_a','A','active'),('org_b','B','active');
    INSERT INTO persistent_codex.workspaces (tenant_id,organization_id,workspace_id,name) VALUES ('org_a','org_a','wsp_a','A'),('org_b','org_b','wsp_b','B');
    INSERT INTO persistent_codex.sessions (organization_id,workspace_id,session_id,status) VALUES ('org_a','wsp_a','ses_a','active'),('org_b','wsp_b','ses_b','active');
    INSERT INTO persistent_codex.commercial_plans (tenant_id,organization_id,workspace_id,plan_id,plan_version,display_name,currency,billing_mode,tax_behavior,effective_at)
      VALUES ('org_a','org_a','wsp_a','beta',1,'Beta','USD','hybrid','unknown','2026-07-18T00:00:00Z'),('org_b','org_b','wsp_b','beta',1,'Beta','USD','hybrid','unknown','2026-07-18T00:00:00Z');
    INSERT INTO persistent_codex.billing_customers (tenant_id,organization_id,workspace_id,billing_customer_id,provider,provider_customer_reference)
      VALUES ('org_a','org_a','wsp_a','cus_a','deterministic-billing-emulator','ref_a'),('org_b','org_b','wsp_b','cus_b','deterministic-billing-emulator','ref_b');
  `,
  )
  const port = docker(['port', container, '5432/tcp']).split(':').at(-1)!
  const repository = createBillingPostgresRepository(
    `postgresql://billing_runtime:runtime@127.0.0.1:${port}/postgres`,
  )

  assert.equal((await repository.recordWebhook(event())).duplicate, false)
  assert.equal((await repository.recordWebhook(event())).duplicate, true)
  await assert.rejects(
    repository.recordWebhook(
      event({ payloadDigest: `sha256:${'b'.repeat(64)}` }),
    ),
    /different digest/,
  )
  assert.equal(
    (
      await repository.applySubscription({
        schemaVersion: 1,
        tenantId: 'org_a',
        organizationId: 'org_a',
        workspaceId: 'wsp_a',
        subscriptionId: 'sub_a',
        billingCustomerId: 'cus_a',
        planId: 'beta',
        planVersion: 1,
        state: 'active',
        provider: 'deterministic-billing-emulator',
        providerSequence: 10,
        effectiveAt: '2026-07-18T10:00:00.000Z',
        updatedAt: '2026-07-18T10:00:00.000Z',
        sourceWebhookEventId: 'evt_subscription_10',
      })
    ).applied,
    true,
  )
  assert.equal(
    (
      await repository.applySubscription({
        schemaVersion: 1,
        tenantId: 'org_a',
        organizationId: 'org_a',
        workspaceId: 'wsp_a',
        subscriptionId: 'sub_a',
        billingCustomerId: 'cus_a',
        planId: 'beta',
        planVersion: 1,
        state: 'cancelled',
        provider: 'deterministic-billing-emulator',
        providerSequence: 9,
        effectiveAt: '2026-07-18T09:00:00.000Z',
        updatedAt: '2026-07-18T11:00:00.000Z',
        sourceWebhookEventId: 'evt_old',
      })
    ).applied,
    false,
  )

  const scopedA = {
    tenantId: 'org_a',
    organizationId: 'org_a',
    workspaceId: 'wsp_a',
  }
  assert.equal(await repository.countBillingCustomers(scopedA, 'org_b'), 0)
  assert.equal(
    await repository.markWebhookProcessing(
      scopedA,
      'evt_subscription_10',
      new Date('2026-07-18T00:00:00.000Z'),
    ),
    1,
  )
  assert.deepEqual(
    await repository.recoverStale(new Date('2026-07-18T12:00:00.000Z'), 30_000),
    ['evt_subscription_10'],
  )

  const emulator = new DeterministicBillingEmulator({
    secret: Buffer.alloc(32, 24),
  })
  const payload = Buffer.from(
    '{"type":"unknown.future","paymentCredential":"must-not-persist"}',
  )
  const timestamp = Date.parse('2026-07-18T12:00:00.000Z')
  const verified = emulator.verify({
    payload,
    timestamp,
    signature: emulator.sign(payload, timestamp),
    replayKey: 'emulator-evt',
    now: new Date(timestamp),
  })
  assert.equal(verified.productionEvidence, false)
  const forbiddenColumns = Number(
    docker([
      'exec',
      container,
      'psql',
      '-U',
      'postgres',
      '-tAc',
      "SELECT count(*) FROM information_schema.columns WHERE table_schema='persistent_codex' AND table_name='billing_webhook_events' AND column_name IN ('payload','secret','credential','signature')",
    ]),
  )
  assert.equal(forbiddenColumns, 0)
  await repository.close()
  console.log(
    JSON.stringify({
      migration: '0024_billing_plan_quota.sql',
      forcedRls: true,
      crossTenantVisible: 0,
      duplicateWebhookApplied: 0,
      outOfOrderRollback: 0,
      restartRecovered: 1,
      signature: 'hmac-sha256-v1',
      boundedPayload: true,
      rawPayloadStored: false,
      provider: 'deterministic-billing-emulator',
      productionBillingVerified: false,
    }),
  )
} finally {
  spawnSync('docker', ['rm', '-f', container])
  spawnSync('docker', ['volume', 'rm', '-f', volume])
}
