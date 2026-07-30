import { describe, expect, it, vi } from 'vitest'
import type {
  EnterpriseRepository,
  ScimWrite,
} from '@perseverance/enterprise-lifecycle/postgres'
import type { ScimResource } from '@perseverance/enterprise-lifecycle/contracts'
import { buildEnterpriseApi } from './enterprise-api'
const value = (input: ScimWrite): ScimResource => ({
  ...input,
  schemaVersion: 1,
  version: 1,
  updatedAt: new Date().toISOString(),
})
describe('enterprise SCIM API boundary', () => {
  it('requires bearer authority and delegates deprovision/admission to durable repository', async () => {
    const rows = new Map<string, ScimResource>(),
      deprovision = vi.fn(async (s, p, id, v, k) => {
        const prior = rows.get(id)!
        const next = { ...prior, active: false, providerVersion: v }
        rows.set(id, next)
        return next
      })
    const repository: EnterpriseRepository = {
      authenticateScim: async (_s, b) => {
        if (b !== 'secret')
          throw Object.assign(new Error('SCIM_UNAUTHORIZED'), {
            code: 'SCIM_UNAUTHORIZED',
          })
        return { providerId: 'idp' }
      },
      getScim: async (_s, _p, _t, id) => rows.get(id)!,
      upsertScim: async (input) => {
        const result = value(input)
        rows.set(input.resourceId, result)
        return result
      },
      replaceGroupMemberships: async (input) => value(input),
      deprovisionScimUser: deprovision,
      assertAdmission: vi.fn(async () => {}),
    }
    const app = buildEnterpriseApi({ repository }),
      headers = {
        'x-tenant-id': 'tenant-a',
        'x-organization-id': 'org-a',
        authorization: 'Bearer secret',
        'idempotency-key': 'one',
      }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/scim/v2/Users',
          headers,
          payload: {
            id: 'u1',
            externalId: 'e1',
            providerVersion: 1,
            active: true,
          },
        })
      ).statusCode,
    ).toBe(201)
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/scim/v2/Users/u1',
          headers: { ...headers, 'idempotency-key': 'two' },
          payload: { externalId: 'e1', providerVersion: 2, active: false },
        })
      ).statusCode,
    ).toBe(200)
    expect(deprovision).toHaveBeenCalled()
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/scim/v2/Users/u1',
          headers: { ...headers, authorization: 'Bearer wrong' },
        })
      ).statusCode,
    ).toBe(401)
    await app.close()
  })
})
