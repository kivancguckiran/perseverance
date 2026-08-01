import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemorySharedFolderRepository } from '@perseverance/shared-folders'
import type { ProductionSession } from '@perseverance/production-topology/production-postgres'
import {
  buildProductionControlPlane,
  DEFAULT_CONVERSATION_FOLDER_ID,
} from './production-server'

const headers = {
  authorization: 'Bearer user-a',
  'content-type': 'application/json',
  'x-tenant-id': 'org-a',
  'x-organization-id': 'org-a',
  'x-workspace-id': 'workspace-a',
}

function stored(overrides: Partial<ProductionSession> = {}): ProductionSession {
  return {
    tenantId: 'org-a',
    organizationId: 'org-a',
    workspaceId: 'workspace-a',
    sessionId: 'ses_a',
    folderId: DEFAULT_CONVERSATION_FOLDER_ID,
    title: 'Yeni konuşma',
    status: 'active',
    providerId: 'codex',
    requestedPolicy: { alias: 'sol', reasoningEffort: 'medium' },
    resolvedModel: null,
    reasoningEffort: 'medium',
    titleGeneratedAt: null,
    codexThreadId: null,
    highWaterSequence: 0,
    version: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('production conversation persistence routes', () => {
  it('persists folder metadata and lists default conversations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    )
    let session = stored()
    const repository = {
      pool: {
        query: async () => ({ rowCount: 1, rows: [{ role: 'admin' }] }),
      },
      listOutbox: async () => [],
      markOutboxPublished: async () => {},
      createSession: vi.fn(async (input: Record<string, unknown>) => {
        session = stored({
          folderId: String(input.folderId),
          title: String(input.title),
        })
        return session
      }),
      listSessions: async () => ({ sessions: [session], hasMore: false }),
      getSession: async () => session,
      updateConversation: async (
        _scope: unknown,
        _sessionId: string,
        changes: { folderId?: string; title?: string },
      ) => {
        session = stored({ ...session, ...changes })
        return session
      },
    }
    const app = await buildProductionControlPlane({
      instanceId: 'production-conversation-test',
      repository: repository as never,
      objectStore: { ready: async () => true } as never,
      broker: { ready: async () => true } as never,
      runtimeControlReadinessUrl: 'http://workspace-agent',
      kmsReadinessUrl: 'http://kms',
      requiredRegionId: 'self-hosted-1',
      billing: {} as never,
      authentication: {
        async authenticate() {
          return {
            version: 1 as const,
            kind: 'end_user' as const,
            issuer: 'https://identity.example.test',
            subject: 'user-a',
            audience: ['production-conversation-test'],
            authenticatedAt: '2026-08-01T00:00:00.000Z',
            expiresAt: '2030-01-01T00:00:00.000Z',
            assurance: { level: 'mfa' as const, mfa: true },
            memberships: [],
          }
        },
      },
      sharedFolders: new InMemorySharedFolderRepository(),
    })

    const created = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json()).toMatchObject({
      folderId: DEFAULT_CONVERSATION_FOLDER_ID,
      title: 'Yeni konuşma',
    })

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/sessions?limit=12',
      headers,
    })
    expect(listed.statusCode, listed.body).toBe(200)
    expect(listed.json().sessions).toEqual([
      expect.objectContaining({ folderId: DEFAULT_CONVERSATION_FOLDER_ID }),
    ])

    const updated = await app.inject({
      method: 'PATCH',
      url: '/v1/sessions/ses_a/conversation',
      headers,
      payload: { folderId: null, title: 'Kalıcı başlık' },
    })
    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.json()).toMatchObject({
      folderId: DEFAULT_CONVERSATION_FOLDER_ID,
      title: 'Kalıcı başlık',
    })
    await app.close()
  })
})
