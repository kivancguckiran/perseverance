import { describe, expect, it, vi } from 'vitest'
import {
  CONTENT_KEY_BROKER_CONTRACT_VERSION,
  CONTENT_KEY_BROKER_ROUTES,
} from '@perseverance/control-plane-contracts'
import { HttpContentKeyLeaseStore } from './content-key-lease-client'

describe('content-key broker client', () => {
  it('validates scope and key material from the shared contract', async () => {
    const key = Buffer.alloc(32, 11)
    const request = vi.fn(async () =>
      Response.json({
        schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
        leaseId: 'ckl_1',
        scope: {
          tenantId: 'org_1',
          organizationId: 'org_1',
          workspaceId: 'wsp_1',
        },
        userId: 'usr_1',
        keyVersion: '1',
        expiresAt: Date.now() + 1_000,
        contentKey: key.toString('base64'),
      }),
    )
    const client = new HttpContentKeyLeaseStore(
      'http://broker.test/',
      'runtime-token',
      request,
    )

    await expect(client.acquire('wsp_1')).resolves.toMatchObject({
      leaseId: 'ckl_1',
      contentKey: key,
    })
    expect(request).toHaveBeenCalledWith(
      `http://broker.test${CONTENT_KEY_BROKER_ROUTES.acquire}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer runtime-token',
        }),
      }),
    )
  })

  it('maps a locked lease to null and transport failure to a stable code', async () => {
    const locked = new HttpContentKeyLeaseStore(
      'http://broker.test',
      'runtime-token',
      vi.fn(async () => Response.json({}, { status: 404 })),
    )
    await expect(locked.acquire('wsp_1')).resolves.toBeNull()

    const unavailable = new HttpContentKeyLeaseStore(
      'http://broker.test',
      'runtime-token',
      vi.fn(async () => {
        throw new Error('secret transport detail')
      }),
    )
    await expect(unavailable.hasActiveLease('wsp_1')).rejects.toThrow(
      'CONTENT_KEY_BROKER_UNAVAILABLE',
    )
  })
})
