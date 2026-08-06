import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProductionSession } from '@perseverance/production-topology/production-postgres'
import {
  buildProductionControlPlane,
  productionUserMessageEvent,
} from './production-server'
import { decodeProductionTurnInput } from './production-turn-input'
import {
  decryptUserContent,
  parseUserContentEnvelope,
} from './user-content-crypto'

const headers = {
  authorization: 'Bearer user-a',
  'content-type': 'application/json',
  'x-tenant-id': 'org-a',
  'x-organization-id': 'org-a',
  'x-workspace-id': 'workspace-a',
}

const session: ProductionSession = {
  tenantId: 'org-a',
  organizationId: 'org-a',
  workspaceId: 'workspace-a',
  sessionId: 'ses_a',
  folderId: 'fol_default',
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
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

afterEach(() => vi.unstubAllGlobals())

describe('production attachments', () => {
  it('uploads a ZIP, binds it to the turn envelope, and projects its chip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    )
    const objects = new Map<string, Uint8Array>()
    const contentKey = {
      contentKey: Buffer.alloc(32, 7),
      keyVersion: 'content-key-v1',
    }
    let enqueued: Record<string, unknown> | undefined
    const app = await buildProductionControlPlane({
      instanceId: 'production-attachment-test',
      repository: {
        pool: {
          query: async () => ({ rowCount: 1, rows: [{ role: 'admin' }] }),
        },
        listOutbox: async () => [],
        markOutboxPublished: async () => {},
        getSession: async () => session,
        enqueueTurn: async (input: Record<string, unknown>) => {
          enqueued = input
          return {
            created: true,
            run: {
              runId: String(input.runId),
              queueItemId: 'queue_attachment',
            },
            approval: null,
          }
        },
      } as never,
      objectStore: {
        ready: async () => true,
        put: async (key: string, value: Uint8Array) => {
          objects.set(key, value)
        },
        get: async (key: string) => {
          const value = objects.get(key)
          if (!value) throw new Error('OBJECT_GET_FAILED:404')
          return value
        },
        delete: async (key: string) => {
          objects.delete(key)
        },
      },
      broker: {
        ready: async () => true,
        publish: async () => {},
      } as never,
      runtimeControlReadinessUrl: 'http://workspace-agent',
      kmsReadinessUrl: 'http://kms',
      requiredRegionId: 'self-hosted-1',
      billing: {
        admit: async () => ({
          outcome: 'allow',
          decisionId: 'decision_attachment',
        }),
        bindDecision: async () => {},
        cancelDecision: async () => {},
      } as never,
      authentication: {
        async authenticate() {
          return {
            version: 1 as const,
            kind: 'end_user' as const,
            issuer: 'https://identity.example.test',
            subject: 'user-a',
            audience: ['production-attachment-test'],
            authenticatedAt: '2026-08-01T00:00:00.000Z',
            expiresAt: '2030-01-01T00:00:00.000Z',
            assurance: { level: 'mfa' as const, mfa: true },
            memberships: [],
          }
        },
      },
      selfHostedAuth: {
        isUserWorkspace: async () => true,
        leases: { acquire: () => contentKey },
      } as never,
    })

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/sessions/ses_a/attachments',
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-attachment-name': encodeURIComponent('project.zip'),
        'x-attachment-media-type': 'application/zip',
      },
      payload: Buffer.from('PK fixture'),
    })
    expect(upload.statusCode, upload.body).toBe(201)
    const attachment = upload.json()
    expect(attachment).toMatchObject({
      name: 'project.zip',
      mediaType: 'application/zip',
      kind: 'file',
    })
    expect(
      [...objects.values()].every(
        (value) => parseUserContentEnvelope(value) !== null,
      ),
    ).toBe(true)

    const largeUpload = await app.inject({
      method: 'POST',
      url: '/v1/sessions/ses_a/attachments',
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-attachment-name': encodeURIComponent('large-project.zip'),
        'x-attachment-media-type': 'application/zip',
      },
      payload: Buffer.alloc(22 * 1024 * 1024, 1),
    })
    expect(largeUpload.statusCode, largeUpload.body).toBe(201)
    expect(largeUpload.json().byteLength).toBe(22 * 1024 * 1024)

    const turn = await app.inject({
      method: 'POST',
      url: '/v1/sessions/ses_a/turns',
      headers: { ...headers, 'idempotency-key': 'turn-with-zip' },
      payload: {
        prompt: 'Arşivi incele',
        attachmentIds: [attachment.attachmentId],
      },
    })
    expect(turn.statusCode, turn.body).toBe(202)
    expect(enqueued?.maxAttempts).toBe(5)
    const promptObjectKey = String(enqueued?.promptObjectKey)
    const storedPrompt = objects.get(promptObjectKey)!
    const promptEnvelope = parseUserContentEnvelope(storedPrompt)
    expect(promptEnvelope).not.toBeNull()
    const envelope = decodeProductionTurnInput(
      new TextDecoder().decode(
        await decryptUserContent(
          contentKey,
          {
            tenantId: 'org-a',
            organizationId: 'org-a',
            workspaceId: 'workspace-a',
            recordType: 'prompt',
            recordId: String(enqueued?.runId),
          },
          promptEnvelope!,
        ),
      ),
    )
    expect(envelope).toMatchObject({
      prompt: 'Arşivi incele',
      attachments: [{ name: 'project.zip', kind: 'file' }],
    })

    const event = productionUserMessageEvent(
      {
        eventId: 'event_attachment',
        tenantId: 'org-a',
        organizationId: 'org-a',
        workspaceId: 'workspace-a',
        sessionId: 'ses_a',
        runId: String(enqueued?.runId),
        sequence: 1,
        eventType: 'turn.started',
        fencingToken: null,
        payload: {},
        byteLength: 0,
        occurredAt: '2026-08-01T00:00:00.000Z',
      },
      JSON.stringify(envelope),
    )
    expect(event.payload).toMatchObject({
      params: {
        item: {
          content: [
            { type: 'text', text: 'Arşivi incele' },
            { type: 'mention', name: 'project.zip' },
          ],
        },
      },
    })
    await app.close()
  })
})
