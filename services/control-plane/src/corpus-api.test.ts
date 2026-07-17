import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sourceListResponseSchema } from '@persistent-codex/control-plane-contracts'
import { buildControlPlane } from './server'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('WP21 workspace source API', () => {
  it('fails closed without a production corpus repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wp21-api-production-'))
    roots.push(root)
    vi.stubEnv('NODE_ENV', 'production')
    try {
      await expect(
        buildControlPlane({
          databasePath: ':memory:',
          artifactRoot: join(root, 'artifacts'),
          allowInMemorySupportAccess: true,
        }),
      ).rejects.toMatchObject({ code: 'CORPUS_REPOSITORY_REQUIRED' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('creates, lists, details, reindexes and deletes within the authorized workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wp21-api-'))
    roots.push(root)
    const app = await buildControlPlane({
      databasePath: ':memory:',
      artifactRoot: join(root, 'artifacts'),
      corpusRoot: join(root, 'corpus'),
      allowExplicitDevAuthentication: true,
      allowInMemorySupportAccess: true,
    })
    const headers = {
      'x-tenant-id': 'tenant_api',
      'x-workspace-id': 'workspace_api',
    }
    try {
      const uploaded = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/workspace_api/sources',
        headers: {
          ...headers,
          'content-type': 'application/octet-stream',
          'x-source-name': encodeURIComponent('golden.md'),
          'x-source-media-type': 'text/markdown',
        },
        payload: readFileSync(
          new URL(
            '../../../packages/corpus-ingestion/test/fixtures/golden.md',
            import.meta.url,
          ),
        ),
      })
      expect(uploaded.statusCode, uploaded.body).toBe(201)
      const created = uploaded.json() as { source: { sourceId: string } }

      let listed = await app.inject({
        method: 'GET',
        url: '/v1/workspaces/workspace_api/sources',
        headers,
      })
      for (let attempt = 0; attempt < 20; attempt++) {
        if (
          sourceListResponseSchema.parse(listed.json()).sources[0]?.status ===
          'indexed'
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 5))
        listed = await app.inject({
          method: 'GET',
          url: '/v1/workspaces/workspace_api/sources',
          headers,
        })
      }
      expect(listed.statusCode).toBe(200)
      expect(
        sourceListResponseSchema.parse(listed.json()).sources[0],
      ).toMatchObject({
        sourceId: created.source.sourceId,
        status: 'indexed',
      })

      const detail = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/workspace_api/sources/${created.source.sourceId}`,
        headers,
      })
      expect(detail.statusCode).toBe(200)
      expect(detail.json()).not.toHaveProperty('content')

      const reindex = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/workspace_api/sources/${created.source.sourceId}/reindex`,
        headers,
      })
      expect(reindex.statusCode).toBe(202)
      expect(reindex.json()).toMatchObject({ status: 'pending' })

      const crossTenant = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/workspace_api/sources/${created.source.sourceId}`,
        headers: {
          'x-tenant-id': 'tenant_other',
          'x-workspace-id': 'workspace_api',
        },
      })
      expect(crossTenant.statusCode).toBe(404)

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/workspace_api/sources/${created.source.sourceId}`,
        headers,
      })
      expect(deleted.statusCode).toBe(204)
    } finally {
      await app.close()
    }
  })
})
