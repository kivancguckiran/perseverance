import { strict as assert } from 'node:assert'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBillingPostgresRepository,
  DeterministicBillingEmulator,
  type BillingWebhookEvent,
} from '../packages/billing-platform/src/index.ts'
import { freePort } from './wp22-e2e-harness.ts'

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
  let consecutiveReady = 0
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = spawnSync('docker', [
      'exec',
      container,
      'pg_isready',
      '-U',
      'postgres',
    ])
    if (probe.status === 0) {
      consecutiveReady += 1
      if (consecutiveReady >= 3) {
        ready = true
        break
      }
    } else consecutiveReady = 0
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error('PostgreSQL did not become ready')
  for (const migration of [
    '0018_oidc_authorization_rls.sql',
    '0021_tenant_corpus_ingestion.sql',
    '0022_hybrid_corpus_retrieval.sql',
    '0023_pwa_push_multi_device.sql',
    '0024_billing_plan_quota.sql',
    '0025_billing_runtime_composition.sql',
    '0026_prepaid_credit_financial_projection.sql',
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
    GRANT EXECUTE ON FUNCTION persistent_codex.corpus_recoverable_scopes() TO billing_runtime;
    GRANT EXECUTE ON FUNCTION persistent_codex.push_enqueue_notification(text,text,text,text,jsonb),persistent_codex.push_claim_deliveries(timestamptz,integer),persistent_codex.push_complete_delivery(text,text,text,text,text,text,integer,text,text,timestamptz),persistent_codex.push_expire_subscriptions(timestamptz),persistent_codex.push_resolve_notification(text,text,timestamptz) TO billing_runtime;
    INSERT INTO persistent_codex.organizations VALUES ('org_a','A','active'),('org_b','B','active');
    INSERT INTO persistent_codex.workspaces (tenant_id,organization_id,workspace_id,name) VALUES ('org_a','org_a','wsp_a','A'),('org_b','org_b','wsp_b','B');
    INSERT INTO persistent_codex.sessions (organization_id,workspace_id,session_id,status) VALUES ('org_a','wsp_a','ses_a','active'),('org_b','wsp_b','ses_b','active');
    INSERT INTO persistent_codex.commercial_plans (tenant_id,organization_id,workspace_id,plan_id,plan_version,display_name,currency,billing_mode,tax_behavior,effective_at)
      VALUES ('org_a','org_a','wsp_a','beta',1,'Beta','USD','hybrid','unknown','2026-07-18T00:00:00Z'),('org_b','org_b','wsp_b','beta',1,'Beta','USD','hybrid','unknown','2026-07-18T00:00:00Z');
    INSERT INTO persistent_codex.billing_customers (tenant_id,organization_id,workspace_id,billing_customer_id,provider,provider_customer_reference)
      VALUES ('org_a','org_a','wsp_a','cus_a','deterministic-billing-emulator','ref_a'),('org_b','org_b','wsp_b','cus_b','deterministic-billing-emulator','ref_b');
    INSERT INTO persistent_codex.entitlements
      (tenant_id,organization_id,workspace_id,entitlement_id,plan_id,plan_version,entitlement_key,enabled,effective_at)
      SELECT 'org_a','org_a','wsp_a','ent_' || key,'beta',1,key,true,'2026-07-18T00:00:00Z'
      FROM unnest(ARRAY['turn.start','source.upload','source.index','source.retrieval','workspace.concurrency']) key;
    INSERT INTO persistent_codex.budgets
      (tenant_id,organization_id,workspace_id,budget_id,period,currency,soft_limit_micros,hard_limit_micros,effective_at)
      VALUES ('org_a','org_a','wsp_a','monthly','month','USD',800,1000,'2026-07-18T00:00:00Z');
    INSERT INTO persistent_codex.quota_policies
      (tenant_id,organization_id,workspace_id,quota_id,policy_version,meter,soft_limit,hard_limit,in_flight_policy,effective_at)
      VALUES ('org_a','org_a','wsp_a','turns',1,'tenant_concurrent_turn',0,1,'continue','2026-07-18T00:00:00Z');
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

  await repository.upsertRetailPriceCatalog({
    schemaVersion: 1,
    ...scopedA,
    catalogId: 'retail',
    catalogVersion: 'retail-v1',
    currency: 'USD',
    rates: [
      { meter: 'provider_input_token', creditsMicrosPerUnit: 1 },
      { meter: 'provider_output_token', creditsMicrosPerUnit: 2 },
    ],
    operationMaximums: (
      [
        'turn.start',
        'source.upload',
        'source.index',
        'source.retrieval',
        'workspace.concurrency',
      ] as const
    ).map((operation) => ({ operation, maximumCreditsMicros: 100 })),
    idempotencyKey: 'retail-v1',
    paymentReference: null,
    usageDedupeKey: null,
    runId: null,
    operationReference: null,
    occurredAt: '2026-07-18T00:00:00.000Z',
    effectiveAt: '2026-07-18T00:00:00.000Z',
    retiredAt: null,
  })
  const paidLot = await repository.createCreditLot({
    ...scopedA,
    kind: 'paid',
    currency: 'USD',
    creditsMicros: 1_000,
    cashAmountMicros: 1_000,
    idempotencyKey: 'purchase-a',
    paymentReference: 'payment-a',
  })
  const paidLotReplay = await repository.createCreditLot({
    ...scopedA,
    kind: 'paid',
    currency: 'USD',
    creditsMicros: 1_000,
    cashAmountMicros: 1_000,
    idempotencyKey: 'purchase-a',
    paymentReference: 'payment-a',
  })
  assert.equal(paidLotReplay.lotId, paidLot.lotId)
  await repository.createCreditLot({
    ...scopedA,
    kind: 'promotional',
    currency: 'USD',
    creditsMicros: 500,
    cashAmountMicros: 0,
    idempotencyKey: 'promo-a',
    operationReference: 'grant-a',
  })
  assert.equal(
    (await repository.creditBalance(scopedA)).availableCreditsMicros,
    1_500,
  )
  await repository.appendCreditLifecycle({
    ...scopedA,
    entryType: 'chargeback',
    currency: 'USD',
    creditsMicros: 50,
    cashAmountMicros: 50,
    idempotencyKey: 'late-chargeback',
    paymentReference: 'payment-late',
  })
  await repository.createCreditLot({
    ...scopedA,
    kind: 'paid',
    currency: 'USD',
    creditsMicros: 100,
    cashAmountMicros: 100,
    idempotencyKey: 'late-purchase',
    paymentReference: 'payment-late',
  })
  assert.equal(
    (await repository.creditBalance(scopedA)).availableCreditsMicros,
    1_550,
  )

  const secondRepository = createBillingPostgresRepository(
    `postgresql://billing_runtime:runtime@127.0.0.1:${port}/postgres`,
  )
  const firstAdmission = await repository.admit({
    ...scopedA,
    operation: 'turn.start',
    requestKey: 'turn-request-1',
    sessionId: 'ses_a',
    evaluatedAt: new Date('2026-07-18T12:00:00.000Z'),
  })
  assert.equal(firstAdmission.outcome, 'warn')
  assert.equal(
    (
      await secondRepository.admit({
        ...scopedA,
        operation: 'turn.start',
        requestKey: 'turn-request-1',
        sessionId: 'ses_a',
        evaluatedAt: new Date('2026-07-18T12:00:01.000Z'),
      })
    ).decisionId,
    firstAdmission.decisionId,
  )
  const deniedAdmission = await secondRepository.admit({
    ...scopedA,
    operation: 'turn.start',
    requestKey: 'turn-request-2',
    sessionId: 'ses_a',
    evaluatedAt: new Date('2026-07-18T12:00:02.000Z'),
  })
  assert.equal(deniedAdmission.outcome, 'deny')
  await repository.bindDecision(
    scopedA,
    firstAdmission.decisionId,
    'turn_runtime_1',
  )
  await repository.completeOperation(scopedA, 'turn_runtime_1')
  const firstSettlement = await repository.settleOperation(
    scopedA,
    'turn_runtime_1',
    {
      idempotencyKey: 'usage-turn-runtime-1',
      usageDedupeKey: 'usage-turn-runtime-1',
      measuredCreditsMicros: 40,
      usageStatus: 'measured',
      outcome: 'completed',
      terminal: true,
      runId: 'turn_runtime_1',
    },
  )
  assert.equal(
    (
      await repository.settleCredits({
        ...scopedA,
        reservationId: firstSettlement.reservationId,
        idempotencyKey: 'usage-turn-runtime-1',
        usageDedupeKey: 'usage-turn-runtime-1',
        measuredCreditsMicros: 40,
        usageStatus: 'measured',
        outcome: 'completed',
        terminal: true,
        runId: 'turn_runtime_1',
      })
    ).settlementId,
    firstSettlement.settlementId,
  )
  const spendable = (await repository.creditBalance(scopedA))
    .availableCreditsMicros
  const concurrent = await Promise.allSettled([
    repository.reserveCredits({
      ...scopedA,
      operation: 'turn.start',
      idempotencyKey: 'double-spend-a',
      maximumCreditsMicros: spendable,
    }),
    secondRepository.reserveCredits({
      ...scopedA,
      operation: 'turn.start',
      idempotencyKey: 'double-spend-b',
      maximumCreditsMicros: spendable,
    }),
  ])
  assert.equal(
    concurrent.filter((value) => value.status === 'fulfilled').length,
    1,
  )
  const winner = concurrent.find(
    (value) => value.status === 'fulfilled',
  ) as PromiseFulfilledResult<{ reservationId: string }>
  await repository.settleCredits({
    ...scopedA,
    reservationId: winner.value.reservationId,
    idempotencyKey: 'double-spend-release',
    usageDedupeKey: 'double-spend-release',
    measuredCreditsMicros: 0,
    usageStatus: 'measured',
    outcome: 'failed',
    terminal: true,
  })
  await assert.rejects(
    repository.withScope(scopedA, (client) =>
      client.query(
        `UPDATE persistent_codex.credit_ledger_entries SET credit_amount_micros=1`,
      ),
    ),
    /append-only/,
  )
  await repository.appendCreditLifecycle({
    ...scopedA,
    entryType: 'refund',
    currency: 'USD',
    creditsMicros: 10,
    cashAmountMicros: 10,
    idempotencyKey: 'refund-a',
    paymentReference: 'payment-a',
  })
  const projection = await repository.financialProjection(scopedA)
  assert.equal(projection.cashCollectedMicros, 1_040)
  assert.equal(
    projection.grossMarginMicros,
    projection.consumedPaidCreditRevenueMicros -
      projection.providerCogsMicros -
      projection.infrastructureCogsMicros,
  )
  assert.equal(
    (
      await repository.creditAccount({
        ...scopedA,
        tenantId: 'org_b',
        organizationId: 'org_b',
        workspaceId: 'wsp_b',
      })
    ).ledger.length,
    0,
  )
  assert.equal(
    (await secondRepository.latestDecision(scopedA))?.decisionId,
    deniedAdmission.decisionId,
  )
  assert.equal((await secondRepository.snapshot(scopedA)).plan.planId, 'beta')
  await secondRepository.close()

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
  const prepaidForcedRls = Number(
    docker([
      'exec',
      container,
      'psql',
      '-U',
      'postgres',
      '-tAc',
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='persistent_codex' AND c.relname IN ('retail_price_catalogs','credit_lots','credit_reservations','credit_reservation_allocations','credit_settlements','credit_ledger_entries','financial_projection_checkpoints') AND c.relrowsecurity AND c.relforcerowsecurity",
    ]),
  )
  assert.equal(prepaidForcedRls, 7)
  await repository.close()

  const runtimeRoot = mkdtempSync(join(tmpdir(), 'wp24-main-runtime-'))
  mkdirSync(join(runtimeRoot, 'workspace'))
  const runtimePort = await freePort()
  const runtimeConnection = `postgresql://billing_runtime:runtime@127.0.0.1:${port}/postgres`
  const main = spawn(
    'pnpm',
    ['--filter', '@persistent-codex/control-plane', 'start'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(runtimePort),
        PERSISTENT_CODEX_LOCAL_ALPHA: '1',
        PERSISTENT_BILLING_PROVIDER: 'emulator',
        BILLING_DATABASE_URL: runtimeConnection,
        PUSH_DATABASE_URL: runtimeConnection,
        SUPPORT_DATABASE_URL: runtimeConnection,
        CORPUS_DATABASE_URL: runtimeConnection,
        CORPUS_SNAPSHOT_LOCAL_KEY_BASE64: Buffer.alloc(32, 25).toString(
          'base64',
        ),
        CORPUS_SNAPSHOT_ROOT: join(runtimeRoot, 'corpus'),
        EVENT_DATABASE_PATH: join(runtimeRoot, 'events.sqlite'),
        ARTIFACT_ROOT: join(runtimeRoot, 'artifacts'),
        CODEX_HOME_ROOT: join(runtimeRoot, 'codex-homes'),
        WORKSPACE_CWD: join(runtimeRoot, 'workspace'),
        BILLING_EMULATOR_SEED: 'explicit-wp24-main-runtime-smoke',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let mainError = ''
  main.stderr.on('data', (value) => {
    mainError = `${mainError}${String(value)}`.slice(-4_096)
  })
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtimePort}/healthz`)
        if (response.ok) {
          ready = true
          break
        }
      } catch {}
      if (main.exitCode !== null)
        throw new Error(`main runtime exited early: ${mainError}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    assert.equal(ready, true, mainError)
    const mainEmulator = new DeterministicBillingEmulator({
      secret: createHash('sha256')
        .update('explicit-wp24-main-runtime-smoke')
        .digest(),
    })
    const mainWebhookPayload = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        tenantId: 'org_a',
        organizationId: 'org_a',
        workspaceId: 'wsp_a',
        eventId: 'evt_main_runtime_unknown',
        eventType: 'future.invoice.event',
        providerSequence: 100,
        effectiveAt: '2026-07-18T12:00:00.000Z',
        data: { paymentCredential: 'must-not-persist' },
      }),
    )
    const postWebhook = async (payload: Buffer, timestamp: number) =>
      fetch(
        `http://127.0.0.1:${runtimePort}/v1/billing/webhooks/${mainEmulator.provider}`,
        {
          method: 'POST',
          headers: {
            'content-type':
              'application/vnd.persistent-codex.billing-webhook+json',
            'x-billing-event-id': 'evt_main_runtime_unknown',
            'x-billing-timestamp': String(timestamp),
            'x-billing-signature': mainEmulator.sign(payload, timestamp),
          },
          body: payload,
        },
      )
    const firstTimestamp = Date.now()
    assert.equal(
      (await postWebhook(mainWebhookPayload, firstTimestamp)).status,
      202,
    )
    assert.equal(
      (await postWebhook(mainWebhookPayload, firstTimestamp + 1)).status,
      200,
    )
    const conflictPayload = Buffer.from(
      mainWebhookPayload
        .toString('utf8')
        .replace('future.invoice.event', 'future.refund.event'),
    )
    assert.equal(
      (await postWebhook(conflictPayload, firstTimestamp + 2)).status,
      409,
    )
    const runtimeBilling = await fetch(
      `http://127.0.0.1:${runtimePort}/v1/workspaces/wsp_a/billing?sessionId=ses_a`,
      {
        headers: { 'x-tenant-id': 'org_a', 'x-workspace-id': 'wsp_a' },
      },
    )
    const runtimeSnapshot = await runtimeBilling.json()
    assert.equal(runtimeBilling.status, 200, JSON.stringify(runtimeSnapshot))
    assert.equal(runtimeSnapshot.plan.planId, 'beta')
    assert.equal(runtimeSnapshot.productionBillingVerified, false)
  } finally {
    main.kill('SIGTERM')
    await new Promise<void>((resolveExit) => {
      if (main.exitCode !== null) resolveExit()
      else main.once('exit', () => resolveExit())
    })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
  console.log(
    JSON.stringify({
      migrations: [
        '0024_billing_plan_quota.sql',
        '0025_billing_runtime_composition.sql',
        '0026_prepaid_credit_financial_projection.sql',
      ],
      forcedRls: true,
      crossTenantVisible: 0,
      duplicateWebhookApplied: 0,
      outOfOrderRollback: 0,
      restartRecovered: 1,
      twoInstanceAdmissionIdempotent: true,
      prepaidCredit: true,
      creditLotId: paidLot.lotId,
      creditSettlementId: firstSettlement.settlementId,
      financialProjectionId: projection.projectionId,
      creditLedgerWatermark: projection.ledgerWatermark,
      concurrentDoubleSpend: 0,
      appendOnlyCreditLedger: true,
      durableQuotaWatermark: deniedAdmission.measurementWatermark,
      signature: 'hmac-sha256-v1',
      boundedPayload: true,
      rawPayloadStored: false,
      provider: 'deterministic-billing-emulator',
      productionBillingVerified: false,
      mainRuntimeComposition: true,
    }),
  )
} finally {
  spawnSync('docker', ['rm', '-f', container])
  spawnSync('docker', ['volume', 'rm', '-f', volume])
}
