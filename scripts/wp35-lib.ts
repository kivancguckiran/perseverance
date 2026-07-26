export interface Wp35GateResult {
  gate: string
  accepted: boolean
  status: 'passed' | 'not-run' | 'failed'
  [key: string]: unknown
}

export const WP35_GATES = [
  'wp35:test',
  'wp35:onboarding',
  'wp35:billing',
  'wp35:rollout',
  'wp35:browser-mobile',
  'wp35:lifecycle',
  'wp35:cleanup',
  'wp35:accept',
  'wp35:reliability',
  'wp35:external-accept',
] as const

export const WP35_TEST_FILES = [
  'scripts/wp35-lib.test.ts',
  'packages/managed-cloud/src/index.test.ts',
  'services/control-plane/src/managed-cloud-api.test.ts',
] as const

export const WP35_REQUIRED_FILES = [
  'docs/architecture/adr-0035-managed-cloud-onboarding-billing-and-beta.md',
  'docs/operations/managed-cloud-public-beta-runbook.md',
  'docs/operations/managed-cloud-billing-reconciliation.md',
  'docs/operations/managed-cloud-beta-exit-report-template.md',
  'docs/legal/privacy.md',
  'docs/legal/terms.md',
  'docs/legal/subprocessors.md',
  'infra/postgres/migrations/0037_wp35_managed_cloud_beta.sql',
  'packages/managed-cloud/src/contracts.ts',
  'packages/managed-cloud/src/index.ts',
  'packages/managed-cloud/src/postgres.ts',
  'packages/managed-cloud/src/index.test.ts',
  'services/control-plane/src/managed-cloud-api.ts',
  'services/control-plane/src/managed-cloud-api.test.ts',
  'services/control-plane/src/managed-cloud-production.ts',
  'services/control-plane/src/managed-cloud-infrastructure.ts',
  'apps/web/src/managed-cloud-page.tsx',
  'apps/web/src/routes/managed-cloud.tsx',
  'scripts/wp35-lib.ts',
  'scripts/wp35-lib.test.ts',
  'scripts/wp35-gate.ts',
  'scripts/wp35-postgres.ts',
  'scripts/wp35-postgres-readiness.ts',
  'scripts/wp35-browser-mobile.ts',
  'scripts/wp35-accept.ts',
  'scripts/wp35-reliability.ts',
  'scripts/wp35-external-accept.ts',
  'docs/security/wp35-external-beta-attestation.schema.json',
] as const

export function summarizeWp35Gates(results: readonly Wp35GateResult[]) {
  return {
    total: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    notRun: results.filter((result) => result.status === 'not-run').length,
    failed: results.filter((result) => result.status === 'failed').length,
    accepted:
      results.length > 0 &&
      results.every(
        (result) => result.status === 'passed' && result.accepted === true,
      ),
  }
}

export function checkWp35Migration(content: string): string[] {
  const findings: string[] = []
  for (const fragment of [
    'managed_cloud_plan_catalog',
    'managed_cloud_onboardings',
    'managed_cloud_domains',
    'managed_cloud_notification_preferences',
    'managed_cloud_beta_admissions',
    'CHECK (tenant_id = organization_id)',
    'FORCE ROW LEVEL SECURITY',
    "current_setting(''app.workspace_id'', true)",
    'REFERENCES persistent_codex.production_rollouts',
  ]) {
    if (!content.includes(fragment)) findings.push(`missing:${fragment}`)
  }
  for (const forbidden of [
    'access_token text',
    'refresh_token text',
    'api_key text',
    'email text',
    'managed_cloud_credit_operations',
    'managed_cloud_usage',
    'managed_cloud_plan_assignments',
  ]) {
    if (content.toLowerCase().includes(forbidden))
      findings.push(`forbidden:${forbidden}`)
  }
  if ((content.match(/FORCE ROW LEVEL SECURITY/g)?.length ?? 0) < 1)
    findings.push('missing:force-row-level-security')
  return findings.sort()
}

export function checkWp35Adr(content: string): string[] {
  const findings: string[] = []
  for (const reference of [
    'ADR-0024',
    'ADR-0026',
    'ADR-0030',
    'ADR-0033',
    'ADR-0034',
    'WP34 capability matrisi gevşetilmez',
    'reservation',
    'settlement',
    'refund',
    'estimated',
    'non-billable',
    'internal → design_partner → limited_beta',
  ]) {
    if (!content.includes(reference)) findings.push(`missing:${reference}`)
  }
  return findings
}
