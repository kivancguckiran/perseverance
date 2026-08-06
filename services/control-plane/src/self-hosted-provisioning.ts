//  self-hosted kullanıcı workspace provisioning'i (ADR-0037).
// İlk kurulum bootstrap'i (infra/self-hosted/bootstrap) ile kayıt akışının
// paylaştığı idempotent kurulum adımları: organization, principal, owner
// üyeliği, workspace, scheduling policy ve byok billing snapshot'ı.
import type pg from 'pg'
import { createBillingPostgresRepository } from '@perseverance/billing-platform'

export const SELF_HOSTED_PLAN_VERSION = 32

export function selfHostedBillingSeed() {
  return {
    // gerçek-ortam bulgusu: byok planında promosyon kredisi bilinçli
    // olarak yoktur. Alan 0 olarak gönderilirse seedDevelopmentScope
    // (!== undefined guard'ı) bunu seedDevelopmentCredits'e iletir ve
    // creditsMicros <= 0 DEVELOPMENT_CREDIT_SEED_INVALID fırlatır; bu yüzden
    // alan hiç gönderilmez.
    plan: {
      schemaVersion: 1 as const,
      planId: 'self-hosted',
      planVersion: SELF_HOSTED_PLAN_VERSION,
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
      planVersion: SELF_HOSTED_PLAN_VERSION,
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
        policyVersion: SELF_HOSTED_PLAN_VERSION,
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
}

export interface ProvisionWorkspaceInput {
  issuer: string
  subject: string
  supportSubject?: string
  organizationId: string
  organizationName: string
  workspaceId: string
  workspaceName: string
}

// Tek transaction'da idempotent org/principal/membership/workspace/policy
// kurulumu. Region ve runtime node kaydı ilk kurulum bootstrap'inde yapılır;
// kullanıcı workspace'leri mevcut node kapasitesini paylaşır.
export async function provisionWorkspace(
  client: pg.PoolClient,
  input: ProvisionWorkspaceInput,
): Promise<void> {
  // Registration starts before request authentication has a tenant scope.
  // Keep the existing RLS policy fail-closed and bind this transaction to the
  // newly generated scope before inserting the workspace or scoped policies.
  await client.query(
    `SELECT set_config('app.tenant_id',$1,true),
            set_config('app.organization_id',$1,true),
            set_config('app.workspace_id',$2,true)`,
    [input.organizationId, input.workspaceId],
  )
  await client.query(
    `INSERT INTO persistent_codex.organizations(organization_id,name,status)
     VALUES ($1,$2,'active') ON CONFLICT DO NOTHING`,
    [input.organizationId, input.organizationName],
  )
  await client.query(
    `INSERT INTO persistent_codex.principal_identities(issuer,subject,status)
     VALUES ($1,$2,'active') ON CONFLICT DO NOTHING`,
    [input.issuer, input.subject],
  )
  await client.query(
    `INSERT INTO persistent_codex.organization_memberships(organization_id,issuer,subject,role,status)
     VALUES ($1,$2,$3,'owner','active') ON CONFLICT DO NOTHING`,
    [input.organizationId, input.issuer, input.subject],
  )
  if (input.supportSubject && input.supportSubject !== input.subject) {
    await client.query(
      `INSERT INTO persistent_codex.principal_identities(issuer,subject,status)
       VALUES ($1,$2,'active') ON CONFLICT DO NOTHING`,
      [input.issuer, input.supportSubject],
    )
    await client.query(
      `INSERT INTO persistent_codex.organization_memberships(organization_id,issuer,subject,role,status)
       VALUES ($1,$2,$3,'support','active')
       ON CONFLICT (organization_id,issuer,subject)
       DO UPDATE SET role='support', status='active'`,
      [input.organizationId, input.issuer, input.supportSubject],
    )
  }
  await client.query(
    `INSERT INTO persistent_codex.workspaces(tenant_id,organization_id,workspace_id,name)
     VALUES ($1,$1,$2,$3) ON CONFLICT DO NOTHING`,
    [input.organizationId, input.workspaceId, input.workspaceName],
  )
  await client.query(
    `INSERT INTO persistent_codex.workspace_membership_overrides
       (organization_id,workspace_id,issuer,subject,access)
     VALUES ($1,$2,$3,$4,'allow')
     ON CONFLICT (organization_id,workspace_id,issuer,subject)
     DO UPDATE SET access='allow', updated_at=now()`,
    [input.organizationId, input.workspaceId, input.issuer, input.subject],
  )
  if (input.supportSubject && input.supportSubject !== input.subject) {
    await client.query(
      `INSERT INTO persistent_codex.workspace_membership_overrides
         (organization_id,workspace_id,issuer,subject,access)
       VALUES ($1,$2,$3,$4,'allow')
       ON CONFLICT (organization_id,workspace_id,issuer,subject)
       DO UPDATE SET access='allow', updated_at=now()`,
      [
        input.organizationId,
        input.workspaceId,
        input.issuer,
        input.supportSubject,
      ],
    )
  }
  await client.query(
    `INSERT INTO persistent_codex.tenant_scheduling_policies
       (tenant_id,organization_id,policy_version,algorithm,weight,tenant_concurrency,workspace_concurrency,provider_concurrency,provider_requests_per_minute,starvation_age_ms,retry_policy,effective_at)
     VALUES ($1,$2,$3,'weighted-fair-v1',1,2,1,'{"codex":2}','{"codex":120}',5000,'{"maxAttempts":4,"initialBackoffMs":100,"maxBackoffMs":1000,"poisonAfterAttempts":4}',now())
     ON CONFLICT DO NOTHING`,
    [input.organizationId, input.organizationId, SELF_HOSTED_PLAN_VERSION],
  )
}

export async function snapshotSelfHostedBilling(
  databaseUrl: string,
  scope: { tenantId: string; organizationId: string; workspaceId: string },
): Promise<void> {
  const billing = createBillingPostgresRepository(databaseUrl, {
    developmentSeed: selfHostedBillingSeed(),
  })
  try {
    await billing.snapshot(scope)
  } finally {
    await billing.close()
  }
}
