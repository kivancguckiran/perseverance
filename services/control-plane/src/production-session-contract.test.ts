import { describe, expect, it } from 'vitest'
import { sessionResponseSchema } from '@perseverance/control-plane-contracts'
import { productionSessionResponse } from './production-server'
import type { ProductionSession } from '@perseverance/production-topology/production-postgres'

const storedSession = (
  overrides: Partial<ProductionSession> = {},
): ProductionSession => ({
  tenantId: 'tenant-a',
  organizationId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
  status: 'active',
  providerId: 'codex',
  codexThreadId: null,
  highWaterSequence: 0,
  version: 1,
  createdAt: '2026-07-31T09:00:00.000Z',
  updatedAt: '2026-07-31T09:00:00.000Z',
  ...overrides,
})

describe('production session API contract', () => {
  it('maps a durable production session to the public SessionResponse', () => {
    const response = productionSessionResponse(
      storedSession({ highWaterSequence: 7 }),
    )

    expect(sessionResponseSchema.parse(response)).toMatchObject({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      provider: 'codex',
      status: 'active',
      replay: { afterSequence: 7, highWaterSequence: 7 },
    })
  })

  it('preserves a recovery-required session with actionable options', () => {
    const response = productionSessionResponse(
      storedSession({ status: 'recovery_required' }),
    )

    expect(response.recoveryErrorCode).toBe('RECOVERY_OUTCOME_UNKNOWN')
    expect(response.recoveryOptions).toEqual([
      'retry_resume',
      'start_new_session',
      'view_read_only',
    ])
  })
})
