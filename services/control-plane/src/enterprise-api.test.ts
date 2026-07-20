import { describe, expect, it, vi } from 'vitest'
import { buildEnterpriseApi } from './enterprise-api'
const headers = {
  'x-tenant-id': 'tenant-a',
  'x-organization-id': 'org-a',
  'idempotency-key': 'create-1',
}
describe('SCIM HTTP contract', () => {
  it('serves Users/Groups and deprovisions every cached access surface', async () => {
    const onDeprovision = vi.fn(),
      app = buildEnterpriseApi({ onDeprovision })
    const body = {
      id: 'u1',
      externalId: 'e1',
      providerId: 'idp',
      providerVersion: 2,
      active: true,
      userName: 'opaque',
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/scim/v2/Users',
          headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(201)
    const stale = await app.inject({
      method: 'PUT',
      url: '/scim/v2/Users/u1',
      headers: { ...headers, 'idempotency-key': 'stale' },
      payload: { ...body, providerVersion: 1, active: false },
    })
    expect(stale.json().active).toBe(true)
    const removed = await app.inject({
      method: 'DELETE',
      url: '/scim/v2/Users/u1',
      headers: {
        ...headers,
        'idempotency-key': 'delete',
        'x-provider-version': '3',
      },
    })
    expect(removed.json().active).toBe(false)
    expect(onDeprovision.mock.calls[0]?.[2]).toEqual(
      expect.arrayContaining([
        'sessions',
        'tokens',
        'leases',
        'turns',
        'authorization_cache',
      ]),
    )
    const cross = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users/u1',
      headers: { ...headers, 'x-tenant-id': 'tenant-b' },
    })
    expect(cross.statusCode).toBe(404)
    await app.close()
  })
})
