import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  redactWp30Evidence,
  scanWp30Evidence,
} from '../../../scripts/wp30-evidence'

describe('WP30 fail-closed evidence boundary', () => {
  it('detects and redacts credential, database and tenant content markers', () => {
    const unsafe = [
      'Authorization: Bearer opaque-credential-value-123456789',
      'postgresql://runtime:plaintext-password@database.invalid/app',
      'WP30_DECRYPTED_TENANT_MARKER',
    ].join('\n')
    expect(scanWp30Evidence([{ name: 'unsafe', content: unsafe }]).passed).toBe(
      false,
    )
    const redacted = redactWp30Evidence(unsafe)
    expect(redacted).not.toContain('opaque-credential-value')
    expect(redacted).not.toContain('plaintext-password')
    expect(redacted).not.toContain('WP30_DECRYPTED_TENANT_MARKER')
    expect(
      scanWp30Evidence([{ name: 'redacted', content: redacted }]).passed,
    ).toBe(true)
  })

  it('keeps production rollout persistence tenant-scoped and immutable', () => {
    const migration = readFileSync(
      resolve('infra/postgres/migrations/0034_wp30_production_rollout.sql'),
      'utf8',
    )
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(1)
    expect(migration).toContain('production_rollout_history_immutable')
    expect(migration).toContain('production_go_no_go_immutable')
    expect(migration).toContain("current_setting(''app.tenant_id'', true)")
    expect(migration).toContain("current_setting(''app.workspace_id'', true)")
  })

  it('keeps every external production gate in the orchestrator', () => {
    const orchestrator = readFileSync(resolve('scripts/wp30-accept.ts'), 'utf8')
    for (const gate of [
      'wp30:pentest',
      'wp30:load-soak',
      'wp30:chaos',
      'wp30:incident-game-day',
      'wp30:rollout',
      'wp30:browser-mobile',
      'wp30:cleanup',
      'wp30:go-no-go',
    ])
      expect(orchestrator).toContain(gate)
    expect(orchestrator).toContain('syntheticEvidenceAccepted: false')
  })
})
