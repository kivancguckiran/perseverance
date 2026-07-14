import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SqliteEventStore,
  type AuditAction,
  type StoreScope,
} from '@persistent-codex/event-store'

const golden = JSON.parse(
  readFileSync(
    new URL('./fixtures/wp11-audit-golden.json', import.meta.url),
    'utf8',
  ),
) as Record<string, AuditAction[]>

describe('WP11 ordered golden audit chains', () => {
  for (const [scenario, actions] of Object.entries(golden)) {
    it(`persists the ${scenario} chain in order without user content`, () => {
      const store = new SqliteEventStore()
      const scope: StoreScope = {
        tenantId: 'ten_golden',
        workspaceId: 'wsp_golden',
        sessionId: `ses_${scenario}`,
      }
      store.createSession(scope)
      try {
        actions.forEach((action, index) =>
          store.appendAudit({
            ...scope,
            actor: action.startsWith('runtime.') ? 'runtime' : 'system',
            action,
            outcome: action.endsWith('requested') ? 'requested' : 'success',
            idempotencyKey: `${scenario}:${index}`,
            correlationId: `corr-${scenario}`,
            requestId: `req-${index}`,
            traceId: 'a'.repeat(32),
            metadata: { operation: scenario },
          }),
        )
        const persisted = store
          .listAudit(scope, { limit: 100 })
          .records.reverse()
        expect(persisted.map((record) => record.action)).toEqual(actions)
        expect(JSON.stringify(persisted)).not.toMatch(
          /Bearer|prompt|reasoning|command output|diff --git|credential|\/Users\//i,
        )
      } finally {
        store.close()
      }
    })
  }
})
