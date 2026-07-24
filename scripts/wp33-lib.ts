// WP33 gate'lerinin deterministik, yan-etkisiz kütüphanesi (ADR-0033).
// Evidence sözleşmesi wp30/wp31/wp32 ile aynıdır: machineEvidence/failNotRun,
// `.wp33/evidence/` (gitignored), timestamp'siz deterministik JSON, redaksiyon.

export interface Wp33GateResult {
  gate: string
  accepted: boolean
  status: 'passed' | 'not-run' | 'failed'
  [key: string]: unknown
}

export const WP33_GATES = [
  'wp33:test',
  'wp33:provisioning',
  'wp33:isolation',
  'wp33:chaos',
  'wp33:accept',
] as const

export const WP33_REQUIRED_FILES = [
  'docs/architecture/adr-0033-deployment-profiles-and-managed-tenant-runtime.md',
  'docs/operations/managed-tenant-runtime-runbook.md',
  'infra/postgres/migrations/0035_wp33_managed_tenant_runtime.sql',
  'packages/deployment-profiles/src/index.ts',
  'packages/deployment-profiles/src/index.test.ts',
  'packages/deployment-profiles/src/profile-golden-equivalence.test.ts',
  'packages/tenant-runtime/src/contracts.ts',
  'packages/tenant-runtime/src/index.ts',
  'packages/tenant-runtime/src/postgres.ts',
  'packages/tenant-runtime/src/index.test.ts',
  'services/control-plane/src/profile-composition.ts',
  'services/control-plane/src/profile-composition.test.ts',
  'services/control-plane/src/tenant-runtime-api.ts',
  'services/control-plane/src/tenant-runtime-api.test.ts',
  'scripts/wp33-lib.ts',
  'scripts/wp33-test-gate.ts',
  'scripts/wp33-gate.ts',
  'scripts/wp33-accept.ts',
] as const

// wp33:test gate'inin koşturduğu deterministik test dosyaları.
export const WP33_TEST_FILES = [
  'scripts/wp33-lib.test.ts',
  'packages/deployment-profiles/src/index.test.ts',
  'packages/deployment-profiles/src/profile-golden-equivalence.test.ts',
  'packages/tenant-runtime/src/index.test.ts',
  'services/control-plane/src/profile-composition.test.ts',
  'services/control-plane/src/tenant-runtime-api.test.ts',
] as const

export function summarizeWp33Gates(results: readonly Wp33GateResult[]) {
  return {
    total: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    notRun: results.filter((result) => result.status === 'not-run').length,
    failed: results.filter((result) => result.status === 'failed').length,
    // Hiçbir not-run sonucu başarıya terfi ettirilmez.
    accepted:
      results.length > 0 &&
      results.every((result) => result.status === 'passed'),
  }
}

// Migration 0035 değişmezleri: FORCE RLS, provisioner sistem rolü, tenant
// scope policy'leri, tenant_id=organization_id CHECK'i ve credential digest'i.
export function checkWp33Migration(content: string): string[] {
  const findings: string[] = []
  const requiredFragments: readonly [string, string][] = [
    [
      'provisioner-role',
      'CREATE ROLE persistent_tenant_provisioner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
    ],
    ['tenant-scope-guc', "current_setting(''app.tenant_id'', true)"],
    [
      'organization-scope-guc',
      "current_setting(''app.organization_id'', true)",
    ],
    ['tenant-matches-organization', 'CHECK (tenant_id = organization_id)'],
    [
      'workspace-fk',
      'REFERENCES persistent_codex.workspaces(tenant_id, organization_id, workspace_id)',
    ],
    ['credential-digest', "token_digest ~ '^[0-9a-f]{64}$'"],
    ['orphan-bounded-states', "state IN ('detected','cleaned')"],
    [
      'provisioner-policy',
      "pg_has_role(current_user, ''persistent_tenant_provisioner'', ''member'')",
    ],
  ]
  for (const [findingId, fragment] of requiredFragments) {
    if (!content.includes(fragment)) findings.push(`missing:${findingId}`)
  }
  const forceRls = content.match(/FORCE ROW LEVEL SECURITY/g)?.length ?? 0
  if (forceRls < 2) findings.push('missing:force-row-level-security')
  const enableRls = content.match(/ENABLE ROW LEVEL SECURITY/g)?.length ?? 0
  if (enableRls < 2) findings.push('missing:enable-row-level-security')
  for (const table of [
    'managed_tenants',
    'tenant_capacity_budgets',
    'tenant_runtimes',
    'tenant_provisioning_jobs',
    'tenant_runtime_credentials',
    'tenant_runtime_orphans',
  ]) {
    if (!content.includes(`persistent_codex.${table}`))
      findings.push(`missing:table-${table}`)
  }
  return findings
}

// ADR-0033'ün zorunlu bağları: ADR-0017, ADR-0026, ADR-0032 ve üç profil.
export function checkWp33Adr(content: string): string[] {
  const findings: string[] = []
  for (const reference of [
    'ADR-0017',
    'ADR-0026',
    'ADR-0028',
    'ADR-0032',
    '`local`',
    '`self-hosted`',
    '`cloud`',
    'deny-by-default',
    'fail-closed',
    'CLOUD_PROFILE_FALLBACK_FORBIDDEN',
  ]) {
    if (!content.includes(reference)) findings.push(`missing:${reference}`)
  }
  return findings
}
