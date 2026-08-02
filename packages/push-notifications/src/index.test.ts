import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  EnvelopeEncryption,
  LocalKmsProvider,
} from '@perseverance/workspace-security'
import {
  InMemoryPushRepository,
  PushProviderEmulator,
  PushRepositoryError,
} from './index'

function repository() {
  return new InMemoryPushRepository(
    new EnvelopeEncryption(
      new LocalKmsProvider(
        createHash('sha256').update('fixture-test').digest(),
      ),
    ),
  )
}

const scope = {
  tenantId: 'ten_a',
  organizationId: 'org_a',
  workspaceId: 'wsp_a',
  principalId: 'prn_a',
}
const request = {
  version: 1 as const,
  deviceId: 'device_a',
  endpoint: 'https://push.example.test/delivery/opaque',
  keys: { p256dh: 'p'.repeat(32), auth: 'a'.repeat(16) },
  expiresAt: null,
}

describe('push subscription lifecycle', () => {
  it('rotates without exposing endpoint material and revokes with CAS', async () => {
    const repo = repository()
    const created = await repo.upsert(scope, request)
    expect(JSON.stringify(created)).not.toContain(request.endpoint)
    expect(created).toMatchObject({ status: 'active', revision: 1 })
    const rotated = await repo.upsert(scope, {
      ...request,
      endpoint: 'https://push.example.test/delivery/rotated',
    })
    expect(rotated).toMatchObject({
      subscriptionId: created.subscriptionId,
      revision: 2,
    })
    await expect(
      repo.revoke(scope, created.subscriptionId, 1),
    ).rejects.toMatchObject({
      code: 'PUSH_SUBSCRIPTION_VERSION_CONFLICT',
    } satisfies Partial<PushRepositoryError>)
    expect(await repo.revoke(scope, created.subscriptionId, 2)).toMatchObject({
      status: 'revoked',
      revision: 3,
    })
  })

  it('isolates principal/device scope and expires subscriptions', async () => {
    const repo = repository()
    await repo.upsert(scope, {
      ...request,
      expiresAt: '2026-07-18T10:00:00.000Z',
    })
    expect(await repo.list({ ...scope, principalId: 'prn_b' })).toEqual([])
    expect(await repo.expire(new Date('2026-07-18T10:00:01.000Z'))).toBe(1)
    expect((await repo.list(scope))[0]?.status).toBe('expired')
  })

  it('deduplicates delivery and invalidates dead endpoints', async () => {
    const repo = repository()
    await repo.upsert(scope, request)
    const notification = {
      notificationId: 'not_1',
      sessionId: 'ses_1',
      approvalId: 'apr_1',
      status: 'approval_required' as const,
    }
    const workspaceScope = {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
    }
    expect(await repo.enqueue(workspaceScope, notification)).toBe(1)
    expect(await repo.enqueue(workspaceScope, notification)).toBe(0)
    const emulator = new PushProviderEmulator()
    const receipts = await repo.drain(emulator, new Date())
    expect(receipts).toHaveLength(1)
    expect(emulator.deliveries[0]?.payload).toEqual({
      version: 1,
      ...notification,
    })
    expect(
      await repo.resolveNotification('prn_a', 'not_1', new Date()),
    ).toMatchObject({ workspaceId: 'wsp_a', sessionId: 'ses_1' })
    expect(
      await repo.resolveNotification('prn_b', 'not_1', new Date()),
    ).toBeUndefined()
    const serialized = JSON.stringify(emulator.deliveries)
    for (const forbidden of [
      'prompt',
      'output',
      'reasoning',
      'command',
      'diff',
      'filename',
      'Bearer ',
      'sk-',
    ])
      expect(serialized).not.toContain(forbidden)

    await repo.upsert(scope, {
      ...request,
      endpoint: 'https://push.example.test/retry',
    })
    await repo.enqueue(workspaceScope, {
      ...notification,
      notificationId: 'not_retry',
    })
    expect((await repo.drain(emulator, new Date()))[0]?.outcome).toBe('retry')

    await repo.upsert(scope, {
      ...request,
      endpoint: 'https://push.example.test/invalid',
    })
    await repo.enqueue(workspaceScope, {
      ...notification,
      notificationId: 'not_2',
    })
    expect((await repo.drain(emulator, new Date()))[0]?.outcome).toBe(
      'invalid_endpoint',
    )
    expect((await repo.list(scope))[0]?.status).toBe('invalid')
  })
})
