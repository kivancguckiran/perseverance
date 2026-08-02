import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sourceListResponseSchema } from '@perseverance/control-plane-contracts'
import {
  createPostgresCorpusRepository,
  EncryptedFilesystemCorpusSnapshotStorage,
} from '@perseverance/corpus-ingestion'
import {
  ChunkedEnvelopeEncryption,
  LocalKmsProvider,
} from '@perseverance/workspace-security'
import { buildControlPlane } from './server'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('workspace source API', () => {
  it('fails closed without a production corpus repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fixture-api-production-'))
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

  it('fails closed when durable corpus storage uses a development KMS', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fixture-api-local-kms-'))
    roots.push(root)
    const repository = createPostgresCorpusRepository({
      connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
    })
    const storage = new EncryptedFilesystemCorpusSnapshotStorage(
      join(root, 'snapshots'),
      new ChunkedEnvelopeEncryption(new LocalKmsProvider(Buffer.alloc(32, 15))),
      { explicitUsage: 'test' },
    )
    vi.stubEnv('NODE_ENV', 'production')
    try {
      await expect(
        buildControlPlane({
          databasePath: ':memory:',
          artifactRoot: join(root, 'artifacts'),
          allowInMemorySupportAccess: true,
          corpusRepository: repository,
          corpusSnapshotStorage: storage,
          corpusAutoDrain: false,
        }),
      ).rejects.toMatchObject({ code: 'PRODUCTION_CORPUS_KMS_REQUIRED' })
    } finally {
      vi.unstubAllEnvs()
      await repository.close()
    }
  })

  it('creates, lists, details, reindexes and deletes within the authorized workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fixture-api-'))
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

      const searchBody = {
        schemaVersion: 1,
        tenantId: 'tenant_api',
        organizationId: 'tenant_api',
        workspaceId: 'workspace_api',
        query: 'Tenant-aware Markdown extraction',
        topK: 5,
        tokenBudget: 512,
        cursor: null,
        rankingPolicyVersion: 'hybrid-rrf-v1',
        queryTimeoutMs: 500,
      }
      const search = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/workspace_api/search',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: searchBody,
      })
      expect(search.statusCode, search.body).toBe(200)
      expect(search.json()).toMatchObject({
        rankingPolicyVersion: 'hybrid-rrf-v1',
        results: [
          {
            sourceId: created.source.sourceId,
            trust: 'untrusted_context',
            citation: {
              sourceId: created.source.sourceId,
              locator: { kind: 'line' },
            },
          },
        ],
      })
      const firstResult = search.json().results[0] as {
        revisionId: string
        chunkId: string
      }
      const citation = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/workspace_api/citations/resolve',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: {
          schemaVersion: 1,
          tenantId: 'tenant_api',
          organizationId: 'tenant_api',
          workspaceId: 'workspace_api',
          sourceId: created.source.sourceId,
          revisionId: firstResult.revisionId,
          chunkId: firstResult.chunkId,
        },
      })
      expect(citation.statusCode, citation.body).toBe(200)
      expect(citation.json()).toMatchObject({ trust: 'untrusted_context' })

      const crossTenantSearch = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/workspace_api/search',
        headers: {
          'x-tenant-id': 'tenant_other',
          'x-workspace-id': 'workspace_api',
          'content-type': 'application/json',
        },
        payload: {
          ...searchBody,
          tenantId: 'tenant_other',
          organizationId: 'tenant_other',
        },
      })
      expect(crossTenantSearch.statusCode).toBe(200)
      expect(crossTenantSearch.json().results).toEqual([])

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
      const afterDelete = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/workspace_api/search',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: searchBody,
      })
      expect(afterDelete.statusCode, afterDelete.body).toBe(200)
      expect(afterDelete.json().results).toEqual([])
      const deletedCitation = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/workspace_api/citations/resolve',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: {
          schemaVersion: 1,
          tenantId: 'tenant_api',
          organizationId: 'tenant_api',
          workspaceId: 'workspace_api',
          sourceId: created.source.sourceId,
          revisionId: firstResult.revisionId,
          chunkId: firstResult.chunkId,
        },
      })
      expect(deletedCitation.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })
})
