import { describe, expect, it, vi } from 'vitest'
import {
  CONTENT_KEY_BROKER_CONTRACT_VERSION,
  CONTENT_KEY_BROKER_ROUTES,
} from '@perseverance/control-plane-contracts'
import { buildProductionControlPlane } from './production-server'

describe('content-key broker audit sink', () => {
  it('accepts only the internal token and persists no key material', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values })
        return { rowCount: 1, rows: [] }
      }),
      release: vi.fn(),
    }
    const app = await buildProductionControlPlane({
      instanceId: 'content-key-audit-test',
      repository: {
        pool: {
          query: async () => ({ rowCount: 1, rows: [] }),
          connect: async () => client,
        },
        listOutbox: async () => [],
        markOutboxPublished: async () => {},
      } as never,
      objectStore: { ready: async () => true } as never,
      broker: { ready: async () => true } as never,
      runtimeControlReadinessUrl: 'http://unused',
      kmsReadinessUrl: 'http://unused',
      requiredRegionId: 'self-hosted-1',
      billing: {} as never,
      authentication: {
        authenticate: async () => {
          throw new Error('OIDC must not handle the internal audit route')
        },
      },
      internalRuntimeToken: 'runtime-token',
    })
    const event = {
      schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
      scope: {
        tenantId: 'org_1',
        organizationId: 'org_1',
        workspaceId: 'wsp_1',
      },
      userId: 'usr_1',
      action: 'secret.lease_issued',
      leaseId: 'ckl_1',
    }
    const denied = await app.inject({
      method: 'POST',
      url: CONTENT_KEY_BROKER_ROUTES.audit,
      headers: { authorization: 'Bearer wrong-token' },
      payload: event,
    })
    expect(denied.statusCode).toBe(401)

    const accepted = await app.inject({
      method: 'POST',
      url: CONTENT_KEY_BROKER_ROUTES.audit,
      headers: { authorization: 'Bearer runtime-token' },
      payload: event,
    })
    expect(accepted.statusCode).toBe(204)
    expect(
      queries.some(({ sql }) => sql.includes('workspace_security_audit')),
    ).toBe(true)
    expect(JSON.stringify(queries)).not.toMatch(/contentKey|base64/i)
    await app.close()
  })
})
