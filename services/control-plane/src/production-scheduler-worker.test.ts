import { describe, expect, it, vi } from 'vitest'
import { PrepaidCreditError } from '@perseverance/billing-platform'
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

  it('releases admission when a non-prepaid run has no credit reservation', async () => {
    const billing = {
      settleOperation: vi.fn(async () => {
        throw new PrepaidCreditError('RESERVATION_NOT_FOUND')
      }),
      completeOperation: vi.fn(async () => undefined),
    }
    const scope = {
      tenantId: 'tenant-a',
      organizationId: 'organization-a',
      workspaceId: 'workspace-a',
    }

    await expect(
      settleTerminalRunBilling(billing as never, scope, 'run-byok', 'completed'),
    ).resolves.toBeUndefined()

    expect(billing.completeOperation).toHaveBeenCalledWith(scope, 'run-byok')
  })

  it('releases admission but preserves real settlement failures', async () => {
    const settlementError = new PrepaidCreditError(
      'SETTLEMENT_EXCEEDS_RESERVATION',
    )
    const billing = {
      settleOperation: vi.fn(async () => {
        throw settlementError
      }),
      completeOperation: vi.fn(async () => undefined),
    }
    const scope = {
      tenantId: 'tenant-a',
      organizationId: 'organization-a',
      workspaceId: 'workspace-a',
    }

    await expect(
      settleTerminalRunBilling(billing as never, scope, 'run-bad', 'failed'),
    ).rejects.toBe(settlementError)

    expect(billing.completeOperation).toHaveBeenCalledWith(scope, 'run-bad')
  })
})
