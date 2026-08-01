import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemorySharedFolderRepository } from '@perseverance/shared-folders'
import { buildProductionControlPlane } from './production-server'

const headers = {
  authorization: 'Bearer user-a',
  'content-type': 'application/json',
  'x-tenant-id': 'org-a',
  'x-organization-id': 'org-a',
  'x-workspace-id': 'workspace-a',
}

async function productionApi(sessionCount = 0) {
  return buildProductionControlPlane({
    instanceId: 'production-folder-test',
    repository: {
      pool: {
        query: async () => ({ rowCount: 1, rows: [{ role: 'admin' }] }),
      },
      listOutbox: async () => [],
      markOutboxPublished: async () => {},
      countSessionsInFolder: async () => sessionCount,
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
    internalRuntimeToken: 'runtime-token',
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('production folder compatibility routes', () => {
  it('creates and lists sidebar folders through the durable folder adapter', async () => {
    const runtimeFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'created' }), { status: 201 }),
      )
    vi.stubGlobal('fetch', runtimeFetch)
    const app = await productionApi()
    const created = await app.inject({
      method: 'POST',
      url: '/v1/conversation-folders',
      headers,
      payload: { name: 'Research' },
    })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json()).toMatchObject({ name: 'Research' })
    expect(runtimeFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: expect.stringContaining('/conversation-workspaces/'),
      }),
      expect.objectContaining({ method: 'POST' }),
    )

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

  it('deletes an empty named folder in the runtime and durable aggregate', async () => {
    const runtimeFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'created' }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'deleted' }), { status: 200 }),
      )
    vi.stubGlobal('fetch', runtimeFetch)
    const app = await productionApi()
    const created = await app.inject({
      method: 'POST',
      url: '/v1/conversation-folders',
      headers,
      payload: { name: 'Temporary' },
    })
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/conversation-folders/${created.json().folderId}`,
      headers,
      payload: {},
    })
    expect(deleted.statusCode, deleted.body).toBe(204)
    expect(runtimeFetch).toHaveBeenLastCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: 'DELETE' }),
    )
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/conversation-folders',
      headers,
    })
    expect(listed.json().folders).toEqual([
      expect.objectContaining({ folderId: 'fol_default' }),
    ])
    await app.close()
  })

  it('protects Default and refuses to delete a folder with conversations', async () => {
    const runtimeFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'created' }), { status: 201 }),
      )
    vi.stubGlobal('fetch', runtimeFetch)
    const app = await productionApi(1)
    const created = await app.inject({
      method: 'POST',
      url: '/v1/conversation-folders',
      headers,
      payload: { name: 'In use' },
    })
    const occupied = await app.inject({
      method: 'DELETE',
      url: `/v1/conversation-folders/${created.json().folderId}`,
      headers,
      payload: {},
    })
    expect(occupied.statusCode, occupied.body).toBe(409)
    expect(occupied.json()).toEqual({ code: 'FOLDER_NOT_EMPTY' })
    const protectedDefault = await app.inject({
      method: 'DELETE',
      url: '/v1/conversation-folders/fol_default',
      headers,
      payload: {},
    })
    expect(protectedDefault.statusCode, protectedDefault.body).toBe(409)
    expect(protectedDefault.json()).toEqual({
      code: 'DEFAULT_CONVERSATION_FOLDER_PROTECTED',
    })
    expect(runtimeFetch).toHaveBeenCalledTimes(1)
    await app.close()
  })
})
