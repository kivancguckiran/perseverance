import { describe, expect, it } from 'vitest'
import { InMemorySharedFolderRepository } from '@perseverance/shared-folders'
import { buildProductionControlPlane } from './production-server'

const headers = {
  authorization: 'Bearer user-a',
  'content-type': 'application/json',
  'x-tenant-id': 'org-a',
  'x-organization-id': 'org-a',
  'x-workspace-id': 'workspace-a',
}

async function productionApi() {
  return buildProductionControlPlane({
    instanceId: 'production-folder-test',
    repository: {
      pool: {
        query: async () => ({ rowCount: 1, rows: [{ role: 'admin' }] }),
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
      async authenticate() {
        return {
          version: 1 as const,
          kind: 'end_user' as const,
          issuer: 'https://identity.example.test',
          subject: 'user-a',
          audience: ['production-folder-test'],
          authenticatedAt: '2026-07-31T00:00:00.000Z',
          expiresAt: '2030-01-01T00:00:00.000Z',
          assurance: { level: 'mfa' as const, mfa: true },
          memberships: [],
        }
      },
    },
    sharedFolders: new InMemorySharedFolderRepository(),
  })
}

describe('production folder compatibility routes', () => {
  it('creates and lists sidebar folders through the durable folder adapter', async () => {
    const app = await productionApi()
    const created = await app.inject({
      method: 'POST',
      url: '/v1/conversation-folders',
      headers,
      payload: { name: 'Research' },
    })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json()).toMatchObject({ name: 'Research' })

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/conversation-folders',
      headers,
    })
    expect(listed.statusCode, listed.body).toBe(200)
    expect(listed.json().folders).toEqual([
      expect.objectContaining({ folderId: 'fol_default', name: 'Default' }),
      expect.objectContaining({ name: 'Research' }),
    ])

    const canonical = await app.inject({
      method: 'GET',
      url: '/v1/folders',
      headers,
    })
    expect(canonical.statusCode, canonical.body).toBe(200)
    expect(canonical.json().folders).toHaveLength(1)
    await app.close()
  })
})
