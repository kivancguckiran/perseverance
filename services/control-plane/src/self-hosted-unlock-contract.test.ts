import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('content-key unlock audit migration', () => {
  const migration = readFileSync(
    new URL(
      '../../../infra/postgres/migrations/0039_content_key_unlock_audit.sql',
      import.meta.url,
    ),
    'utf8',
  )

  it('expands and validates the auth audit action constraint', () => {
    expect(migration).toContain("'user.content_key_unlocked'")
    expect(migration).toContain('ADD CONSTRAINT user_auth_audit_action_check')
    expect(migration).toContain('NOT VALID')
    expect(migration).toContain(
      'VALIDATE CONSTRAINT user_auth_audit_action_check',
    )
  })
})
