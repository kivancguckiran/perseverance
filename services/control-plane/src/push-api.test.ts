import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExplicitDevAuthenticationAdapter } from '@perseverance/authz'
import {
  EnvelopeEncryption,
  LocalKmsProvider,
} from '@perseverance/workspace-security'
import {
  InMemoryPushRepository,
  PushProviderEmulator,
} from '@perseverance/push-notifications'
import { buildControlPlane } from './server'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('push API authorization and lifecycle', () => {
  it('binds subscription to authenticated principal and never echoes endpoint secrets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fixture-push-api-'))
    roots.push(root)
    const repository = new InMemoryPushRepository(
      new EnvelopeEncryption(
        new LocalKmsProvider(createHash('sha256').update('push-api').digest()),
      ),
    )
    const app = await buildControlPlane({
      databasePath: join(root, 'events.sqlite'),
      artifactRoot: join(root, 'artifacts'),
      workspaceCwd: root,
      authenticationAdapter: new ExplicitDevAuthenticationAdapter({
        subject: 'user-a',
      }),
      pushRepository: repository,
      pushProvider: new PushProviderEmulator(),
      allowLocalCorpus: true,
      allowInMemorySupportAccess: true,
    })
    const headers = { 'x-tenant-id': 'org-a', 'x-workspace-id': 'wsp-a' }
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/push-subscriptions',
        headers,
        payload: {
          version: 1,
          deviceId: 'device-a',
          endpoint: 'https://push.example.test/opaque-endpoint',
          keys: { p256dh: 'p'.repeat(32), auth: 'a'.repeat(16) },
          expiresAt: null,
        },
      })
      expect(created.statusCode, created.body).toBe(200)
      expect(created.body).not.toContain('opaque-endpoint')
      expect(created.body).not.toContain('p'.repeat(32))
      const subscription = created.json()
      await repository.enqueue(
        {
          tenantId: 'org-a',
          organizationId: 'org-a',
          workspaceId: 'wsp-a',
        },
        {
          notificationId: 'notification-a',
          sessionId: 'session-a',
          approvalId: null,
          status: 'turn_completed',
        },
      )
      const resolved = await app.inject({
        method: 'GET',
        url: '/v1/notifications/notification-a',
        headers,
      })
      expect(resolved.statusCode).toBe(200)
      expect(resolved.json()).toMatchObject({
        organizationId: 'org-a',
        workspaceId: 'wsp-a',
        sessionId: 'session-a',
      })
      const revoked = await app.inject({
        method: 'POST',
        url: `/v1/push-subscriptions/${subscription.subscriptionId}/revoke`,
        headers,
        payload: { expectedVersion: subscription.revision },
      })
      expect(revoked.json()).toMatchObject({ status: 'revoked', revision: 2 })
      const repeated = await app.inject({
        method: 'POST',
        url: `/v1/push-subscriptions/${subscription.subscriptionId}/revoke`,
        headers,
        payload: { expectedVersion: subscription.revision },
      })
      expect(repeated.statusCode).toBe(409)
    } finally {
      await app.close()
    }
  })
})
