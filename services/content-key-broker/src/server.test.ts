import { describe, expect, it, vi } from 'vitest'
import {
  CONTENT_KEY_BROKER_CONTRACT_VERSION,
  CONTENT_KEY_BROKER_ROUTES,
  contentKeyLeaseAcquireResponseSchema,
} from '@perseverance/control-plane-contracts'
import { buildContentKeyBroker } from './server'

const token = 'internal-runtime-token'
const auth = { authorization: `Bearer ${token}` }
const scope = {
  tenantId: 'org_1',
  organizationId: 'org_1',
  workspaceId: 'wsp_1',
}

describe('memory-only content-key broker', () => {
  it('issues, acquires, reports and revokes a scoped lease', async () => {
    const audit = vi.fn(async () => new Response(null, { status: 204 }))
    const app = await buildContentKeyBroker({
      internalToken: token,
      ttlMs: 60_000,
      auditEndpoint: 'http://control.test',
      request: audit,
    })
    const contentKey = Buffer.alloc(32, 7).toString('base64')
    const issued = await app.inject({
      method: 'POST',
      url: CONTENT_KEY_BROKER_ROUTES.issue,
      headers: auth,
      payload: {
        schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
        scope,
        userId: 'usr_1',
        keyVersion: '1',
        contentKey,
      },
    })
    expect(issued.statusCode).toBe(201)

    const acquired = await app.inject({
      method: 'POST',
      url: CONTENT_KEY_BROKER_ROUTES.acquire,
      headers: auth,
      payload: {
        schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
        workspaceId: scope.workspaceId,
      },
    })
    expect(
      contentKeyLeaseAcquireResponseSchema.parse(acquired.json()).contentKey,
    ).toBe(contentKey)

    const revoked = await app.inject({
      method: 'POST',
      url: CONTENT_KEY_BROKER_ROUTES.revoke,
      headers: auth,
      payload: {
        schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
        workspaceId: scope.workspaceId,
      },
    })
    expect(revoked.json()).toMatchObject({ revoked: true })
    expect(audit).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(audit.mock.calls)).not.toContain(contentKey)
    await app.close()
  })

  it('rejects unauthenticated and malformed requests without key disclosure', async () => {
    const app = await buildContentKeyBroker({
      internalToken: token,
      ttlMs: 60_000,
    })
    const unauthorized = await app.inject({
      method: 'POST',
      url: CONTENT_KEY_BROKER_ROUTES.acquire,
      payload: { workspaceId: 'wsp_1' },
    })
    expect(unauthorized.statusCode).toBe(401)
    const malformed = await app.inject({
      method: 'POST',
      url: CONTENT_KEY_BROKER_ROUTES.issue,
      headers: auth,
      payload: {
        schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
        scope,
        userId: 'usr_1',
        keyVersion: '1',
        contentKey: 'not-a-key',
      },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toEqual({ code: 'INVALID_REQUEST' })
    await app.close()
  })

  it('retains non-secret audit events while the control plane restarts', async () => {
    const audit = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('control plane restarting'))
      .mockResolvedValue(new Response(null, { status: 204 }))
    const app = await buildContentKeyBroker({
      internalToken: token,
      ttlMs: 60_000,
      auditEndpoint: 'http://control.test',
      request: audit,
      auditRetryMs: 5,
    })
    await app.inject({
      method: 'POST',
      url: CONTENT_KEY_BROKER_ROUTES.issue,
      headers: auth,
      payload: {
        schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
        scope,
        userId: 'usr_1',
        keyVersion: '1',
        contentKey: Buffer.alloc(32, 9).toString('base64'),
      },
    })

    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(2))
    const ready = await app.inject({
      method: 'GET',
      url: CONTENT_KEY_BROKER_ROUTES.readiness,
    })
    expect(ready.json()).toMatchObject({ ready: true, auditQueueDepth: 0 })
    await app.close()
  })
})
