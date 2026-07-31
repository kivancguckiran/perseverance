import { describe, expect, it, vi } from 'vitest'
import { settleTerminalRunBilling } from './production-scheduler-worker'

describe('production scheduler billing cleanup', () => {
  it('settles and releases admission for a terminal failed run', async () => {
    const billing = {
      settleOperation: vi.fn(async () => undefined),
      completeOperation: vi.fn(async () => undefined),
    }
    const scope = {
      tenantId: 'tenant-a',
      organizationId: 'organization-a',
      workspaceId: 'workspace-a',
    }

    await settleTerminalRunBilling(billing as never, scope, 'run-a', 'failed')

    expect(billing.settleOperation).toHaveBeenCalledWith(
      scope,
      'run-a',
      expect.objectContaining({
        idempotencyKey: 'wp26:run-a:failed',
        outcome: 'failed',
        terminal: true,
      }),
    )
    expect(billing.completeOperation).toHaveBeenCalledWith(scope, 'run-a')
  })
})
