import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemorySupportAccessRepository } from '@perseverance/support-access'
import type { ProductionSession } from '@perseverance/production-topology/production-postgres'
import { buildProductionControlPlane } from './production-server'

const issuer = 'https://identity.example.test'
const scopeHeaders = {
  'content-type': 'application/json',
  'x-tenant-id': 'org-user',
  'x-organization-id': 'org-user',
  'x-workspace-id': 'workspace-user',
}

const session: ProductionSession = {
  tenantId: 'org-user',
  organizationId: 'org-user',
  workspaceId: 'workspace-user',
  sessionId: 'ses_support',
  folderId: 'fol_default',
  title: 'Support fixture',
  status: 'active',
  providerId: 'codex',
  requestedPolicy: { alias: 'sol', reasoningEffort: 'medium' },
  resolvedModel: null,
  reasoningEffort: 'medium',
  titleGeneratedAt: null,
  codexThreadId: null,
  highWaterSequence: 0,
  version: 1,
  createdAt: '2026-08-05T10:00:00.000Z',
  updatedAt: '2026-08-05T10:00:00.000Z',
}

const opaque = (subject: string) =>
  `sha256:${createHash('sha256').update(`${issuer}\0${subject}`).digest('hex')}`

afterEach(() => vi.unstubAllGlobals())

describe('production user-consented support access', () => {
  it('requires requester step-up and MFA support approval, gates ordinary routes, and consumes a scoped lease once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    )
    const supportAccess = new InMemorySupportAccessRepository({
      explicitUsage: 'test',
      now: () => new Date('2026-08-05T10:00:00.000Z'),
    })
    const repository = {
      pool: {
        query: async (_sql: string, values: unknown[]) => ({
          rowCount: 1,
          rows: [
            { role: values?.[1] === 'self-hosted-admin' ? 'support' : 'owner' },
          ],
        }),
      },
      listOutbox: async () => [],
      markOutboxPublished: async () => {},
      getSession: async () => session,
      replay: async () => ({ events: [], highWaterSequence: 0 }),
    }
    const app = await buildProductionControlPlane({
      instanceId: 'support-access-test',
      repository: repository as never,
      objectStore: { ready: async () => true } as never,
      broker: { ready: async () => true } as never,
      runtimeControlReadinessUrl: 'http://workspace-agent',
      kmsReadinessUrl: 'http://kms',
      requiredRegionId: 'self-hosted-1',
      billing: {} as never,
      supportAccess,
      supportPrincipal: {
        issuer,
        subject: 'self-hosted-admin',
        displayName: 'Self-hosted administrator',
      },
      selfHostedAuth: {
        verifySupportStepUp: vi.fn(async ({ password }) => {
          expect(password).toBe('correct horse battery staple')
          return {
            evidenceId: 'reauth_evidence',
            authenticatedAt: '2026-08-05T10:00:00.000Z',
          }
        }),
      } as never,
      authentication: {
        async authenticate(input) {
          const support = input.authorization === 'Bearer admin'
          return {
            version: 1 as const,
            kind: 'end_user' as const,
            issuer,
            subject: support ? 'self-hosted-admin' : 'user:alice',
            audience: ['support-access-test'],
            authenticatedAt: '2026-08-05T09:59:00.000Z',
            expiresAt: '2030-01-01T00:00:00.000Z',
            assurance: {
              level: support ? 'mfa' : 'pwd',
              mfa: support,
            },
            memberships: [],
          }
        },
      },
    })

    const userHeaders = { ...scopeHeaders, authorization: 'Bearer user' }
    const adminHeaders = { ...scopeHeaders, authorization: 'Bearer admin' }
    const profile = await app.inject({
      method: 'GET',
      url: '/v1/support-profile',
      headers: userHeaders,
    })
    expect(profile.statusCode, profile.body).toBe(200)
    expect(profile.json()).toMatchObject({
      available: true,
      supportPrincipalId: opaque('self-hosted-admin'),
    })

    const created = await app.inject({
      method: 'POST',
      url: '/v1/sessions/ses_support/support-grants',
      headers: { ...userHeaders, 'idempotency-key': 'create-one' },
      payload: {
        sessionId: 'ses_support',
        actions: ['content.view'],
        reason: 'Investigate the reported stuck turn',
        supportPrincipalId: opaque('self-hosted-admin'),
        durationMinutes: 10,
      },
    })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json().status).toBe('pending_verification')

    const verified = await app.inject({
      method: 'POST',
      url: `/v1/support-grants/${created.json().grantId}/verify`,
      headers: userHeaders,
      payload: {
        expectedVersion: created.json().version,
        password: 'correct horse battery staple',
      },
    })
    expect(verified.statusCode, verified.body).toBe(200)
    expect(verified.json().status).toBe('pending_approval')

    const regularRoute = await app.inject({
      method: 'GET',
      url: '/v1/sessions/ses_support',
      headers: adminHeaders,
    })
    expect(regularRoute.statusCode).toBe(403)
    expect(regularRoute.json()).toEqual({ code: 'SUPPORT_ROUTE_REQUIRED' })

    const approved = await app.inject({
      method: 'POST',
      url: `/v1/support-grants/${created.json().grantId}/decision`,
      headers: { ...adminHeaders, 'idempotency-key': 'approve-one' },
      payload: {
        decision: 'approve',
        expectedVersion: verified.json().version,
        mfaEvidenceId: 'ignored-client-evidence',
      },
    })
    expect(approved.statusCode, approved.body).toBe(200)
    expect(approved.json().status).toBe('active')

    const issued = await app.inject({
      method: 'POST',
      url: '/v1/support-access/leases',
      headers: adminHeaders,
      payload: {
        schemaVersion: 1,
        grantId: created.json().grantId,
        sessionId: 'ses_support',
        objectId: null,
        action: 'content.view',
      },
    })
    expect(issued.statusCode, issued.body).toBe(200)

    const consumePayload = {
      schemaVersion: 1,
      token: issued.json().token,
      sessionId: 'ses_support',
      objectId: null,
      action: 'content.view',
    }
    const consumed = await app.inject({
      method: 'POST',
      url: `/v1/support-access/leases/${issued.json().lease.leaseId}/consume`,
      headers: adminHeaders,
      payload: consumePayload,
    })
    expect(consumed.statusCode, consumed.body).toBe(200)
    expect(consumed.json()).toMatchObject({
      action: 'content.view',
      content: [],
    })

    const replayed = await app.inject({
      method: 'POST',
      url: `/v1/support-access/leases/${issued.json().lease.leaseId}/consume`,
      headers: adminHeaders,
      payload: consumePayload,
    })
    expect(replayed.statusCode).toBe(403)
    expect(replayed.json().code).toBe('LEASE_REVOKED_OR_EXPIRED')
    await app.close()
  })
})
