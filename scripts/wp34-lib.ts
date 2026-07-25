export interface Wp34GateResult {
  gate: string
  accepted: boolean
  status: 'passed' | 'not-run' | 'failed'
  [key: string]: unknown
}

export const WP34_GATES = [
  'wp34:test',
  'wp34:oauth',
  'wp34:vault',
  'wp34:kill-switch',
  'wp34:leak-scan',
  'wp34:accept',
] as const

export const WP34_REQUIRED_FILES = [
  'docs/architecture/adr-0034-provider-auth-profiles-and-credential-lifecycle.md',
  'docs/security/provider-terms-watch-list.json',
  'docs/operations/provider-credential-lifecycle-runbook.md',
  'infra/postgres/migrations/0036_wp34_provider_auth_profiles.sql',
  'packages/provider-auth/src/contracts.ts',
  'packages/provider-auth/src/index.ts',
  'packages/provider-auth/src/postgres.ts',
  'packages/provider-auth/src/index.test.ts',
  'services/control-plane/src/provider-auth-api.ts',
  'services/control-plane/src/provider-auth-api.test.ts',
  'scripts/wp34-lib.ts',
  'scripts/wp34-lib.test.ts',
  'scripts/wp34-gate.ts',
  'scripts/wp34-vault.ts',
  'scripts/wp34-accept.ts',
] as const

export const WP34_TEST_FILES = [
  'scripts/wp34-lib.test.ts',
  'packages/provider-auth/src/index.test.ts',
  'services/control-plane/src/provider-auth-api.test.ts',
] as const

export function summarizeWp34Gates(results: readonly Wp34GateResult[]) {
  return {
    total: results.length,
    passed: results.filter((entry) => entry.status === 'passed').length,
    notRun: results.filter((entry) => entry.status === 'not-run').length,
    failed: results.filter((entry) => entry.status === 'failed').length,
    accepted:
      results.length > 0 && results.every((entry) => entry.status === 'passed'),
  }
}

export function checkWp34Migration(content: string): string[] {
  const findings: string[] = []
  const fragments: readonly [string, string][] = [
    ['profile-table', 'persistent_codex.provider_auth_profiles'],
    ['refresh-lock', 'persistent_codex.provider_credential_refresh_locks'],
    ['oauth-table', 'persistent_codex.provider_oauth_transactions'],
    ['usage-ledger', 'persistent_codex.provider_usage_ledger'],
    ['kill-switch', 'persistent_codex.provider_auth_kill_switches'],
    ['state-digest', "state_digest ~ '^[0-9a-f]{64}$'"],
    ['envelope', 'credential_envelope jsonb'],
    ['tenant-check', 'CHECK (tenant_id = organization_id)'],
    ['workspace-guc', "current_setting(''app.workspace_id'', true)"],
    ['crypto-erasure', 'credential_envelope IS NULL'],
  ]
  for (const [id, fragment] of fragments)
    if (!content.includes(fragment)) findings.push(`missing:${id}`)
  if ((content.match(/FORCE ROW LEVEL SECURITY/g)?.length ?? 0) < 1)
    findings.push('missing:force-row-level-security')
  for (const forbidden of [
    'access_token text',
    'refresh_token text',
    'device_code text',
    'pkce_verifier text',
    'oauth_state text',
  ])
    if (content.toLowerCase().includes(forbidden))
      findings.push(`forbidden:${forbidden}`)
  return findings
}

export function checkTermsWatchList(value: unknown): string[] {
  const findings: string[] = []
  if (!value || typeof value !== 'object') return ['invalid:root']
  const entries = (value as { entries?: unknown }).entries
  if (!Array.isArray(entries) || entries.length < 3) return ['invalid:entries']
  for (const [index, raw] of entries.entries()) {
    if (!raw || typeof raw !== 'object') {
      findings.push(`invalid:entry-${index}`)
      continue
    }
    const entry = raw as Record<string, unknown>
    for (const key of [
      'provider',
      'authMode',
      'url',
      'observedUpdateDate',
      'effectiveDate',
      'evidenceSha256',
      'lastCheckedAt',
      'status',
    ])
      if (!(key in entry)) findings.push(`missing:entry-${index}-${key}`)
    if (
      typeof entry.evidenceSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.evidenceSha256)
    )
      findings.push(`invalid:entry-${index}-evidenceSha256`)
  }
  return findings
}
