import { describe, expect, it } from 'vitest'
import { ProductionPostgresRepository } from './production-postgres'

const scope = {
  tenantId: 'tenant-a',
  organizationId: 'tenant-a',
  workspaceId: 'workspace-a',
}

function deletionRepository(input: { activeRun?: boolean; exists?: boolean }) {
  const queries: string[] = []
  const client = {
    async query(sql: string) {
      queries.push(sql)
      if (sql.includes('FROM persistent_codex.ha_sessions'))
        return { rowCount: input.exists === false ? 0 : 1, rows: [{}] }
      if (sql.includes('FROM persistent_codex.ha_runs'))
        return { rowCount: input.activeRun ? 1 : 0, rows: [] }
      if (sql.includes('UPDATE persistent_codex.ha_sessions'))
        return { rowCount: 1, rows: [] }
      return { rowCount: 0, rows: [] }
    },
    release() {},
  }
  return {
    queries,
    repository: new ProductionPostgresRepository({
      connect: async () => client,
    } as never),
  }
}

describe('production conversation deletion', () => {
  it('soft-deletes a tenant-scoped session with no active run', async () => {
    const { repository, queries } = deletionRepository({})
    await expect(repository.deleteSession(scope, 'session-a')).resolves.toBe(
      'deleted',
    )
    expect(
      queries.some(
        (sql) =>
          sql.includes('SET deleted_at=now()') &&
          sql.includes('AND deleted_at IS NULL'),
      ),
    ).toBe(true)
  })

  it('does not delete missing sessions or conversations with an active run', async () => {
    await expect(
      deletionRepository({ exists: false }).repository.deleteSession(
        scope,
        'missing',
      ),
    ).resolves.toBe('not_found')
    const active = deletionRepository({ activeRun: true })
    await expect(
      active.repository.deleteSession(scope, 'running'),
    ).resolves.toBe('active_run')
    expect(
      active.queries.some((sql) =>
        sql.includes('UPDATE persistent_codex.ha_sessions'),
      ),
    ).toBe(false)
  })
})
