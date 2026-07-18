import { describe, expect, it } from 'vitest'
import { InMemorySharedFolderRepository, SharedFolderError } from './index'

const owner = {
  tenantId: 'tenant-a',
  organizationId: 'tenant-a',
  workspaceId: 'workspace-a',
  principalId: 'principal-owner',
}
const friend = { ...owner, principalId: 'principal-friend' }
const outsider = { ...owner, principalId: 'principal-outsider' }

function shared(role: 'viewer' | 'editor' = 'viewer') {
  const repository = new InMemorySharedFolderRepository()
  const created = repository.createFolder({ ...owner, name: 'Paylaşılan' })
  const invitation = repository.createInvitation({
    ...owner,
    folderId: created.folder.folderId,
    role,
    expiresInSeconds: 600,
  })
  const accepted = repository.acceptInvitation({
    ...friend,
    token: invitation.token,
  })
  return { repository, created, invitation, accepted }
}

describe('secure shared folders', () => {
  it('is private by default and exposes only explicitly shared folders', () => {
    const { repository, created } = shared()
    const sibling = repository.createFolder({
      ...owner,
      name: 'Private sibling',
    })
    expect(
      repository.listFolders(friend).map((value) => value.folder.folderId),
    ).toEqual([created.folder.folderId])
    expect(() =>
      repository.getFolder(friend, sibling.folder.folderId),
    ).toThrowError(expect.objectContaining({ code: 'FOLDER_ACCESS_DENIED' }))
    expect(repository.listFolders(outsider)).toEqual([])
  })

  it('uses unpredictable single-use expiring invitations bound to the accepting principal', () => {
    const repository = new InMemorySharedFolderRepository()
    const created = repository.createFolder({ ...owner, name: 'Shared' })
    const invite = repository.createInvitation({
      ...owner,
      folderId: created.folder.folderId,
      role: 'editor',
      expiresInSeconds: 60,
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(invite.invitation)).not.toContain(invite.token)
    expect(() =>
      repository.acceptInvitation({ ...friend, token: 'x'.repeat(43) }),
    ).toThrowError(expect.objectContaining({ code: 'INVITATION_INVALID' }))
    const accepted = repository.acceptInvitation({
      ...friend,
      token: invite.token,
      now: new Date('2026-01-01T00:00:30.000Z'),
    })
    expect(accepted.idempotent).toBe(false)
    expect(
      repository.acceptInvitation({
        ...friend,
        token: invite.token,
        now: new Date('2026-01-01T00:00:31.000Z'),
      }).idempotent,
    ).toBe(true)
    expect(() =>
      repository.acceptInvitation({
        ...outsider,
        token: invite.token,
        now: new Date('2026-01-01T00:00:31.000Z'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVITATION_ACCEPTED' }))
    const expired = repository.createInvitation({
      ...owner,
      folderId: created.folder.folderId,
      role: 'viewer',
      expiresInSeconds: 60,
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(() =>
      repository.acceptInvitation({
        ...outsider,
        token: expired.token,
        now: new Date('2026-01-01T00:01:00.000Z'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVITATION_EXPIRED' }))
  })

  it('enforces viewer/editor/owner capabilities and last-owner protection', () => {
    const viewer = shared('viewer')
    expect(
      viewer.repository.getFolder(
        friend,
        viewer.created.folder.folderId,
        'read',
      ),
    ).toBeTruthy()
    for (const capability of [
      'mutate',
      'turn',
      'approval',
      'manage',
      'export',
    ] as const)
      expect(() =>
        viewer.repository.getFolder(
          friend,
          viewer.created.folder.folderId,
          capability,
        ),
      ).toThrowError(expect.objectContaining({ code: 'FOLDER_ACCESS_DENIED' }))

    const editor = shared('editor')
    expect(
      editor.repository.getFolder(
        friend,
        editor.created.folder.folderId,
        'turn',
      ),
    ).toBeTruthy()
    expect(() =>
      editor.repository.getFolder(
        friend,
        editor.created.folder.folderId,
        'manage',
      ),
    ).toThrowError(expect.objectContaining({ code: 'FOLDER_ACCESS_DENIED' }))
    expect(() =>
      editor.repository.changeRole({
        ...owner,
        folderId: editor.created.folder.folderId,
        targetPrincipalId: owner.principalId,
        role: 'editor',
        expectedVersion: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'LAST_OWNER_PROTECTED' }))
  })

  it('invalidates authorization immediately after role change, revoke and move', () => {
    const { repository, created, accepted } = shared('editor')
    const events: string[] = []
    repository.onAccessChanged((event) => events.push(event.reason))
    repository.getFolder(friend, created.folder.folderId, 'turn')
    const changed = repository.changeRole({
      ...owner,
      folderId: created.folder.folderId,
      targetPrincipalId: friend.principalId,
      role: 'viewer',
      expectedVersion: accepted.membership.version,
    })
    expect(() =>
      repository.getFolder(friend, created.folder.folderId, 'turn'),
    ).toThrowError(expect.objectContaining({ code: 'FOLDER_ACCESS_DENIED' }))
    repository.revokeMembership({
      ...owner,
      folderId: created.folder.folderId,
      targetPrincipalId: friend.principalId,
      expectedVersion: changed.version,
    })
    expect(repository.listFolders(friend)).toEqual([])

    const target = repository.createFolder({ ...owner, name: 'Target' })
    const binding = repository.bindResource({
      ...owner,
      folderId: created.folder.folderId,
      resourceType: 'source',
      resourceId: 'source-a',
    })
    repository.moveResource({
      ...owner,
      sourceFolderId: created.folder.folderId,
      targetFolderId: target.folder.folderId,
      resourceType: 'source',
      resourceId: 'source-a',
      expectedVersion: binding.version,
    })
    expect(events).toEqual([
      'role_changed',
      'revoked',
      'resource_moved',
      'resource_moved',
    ])
  })

  it('deduplicates concurrent task, approval and billing settlements', async () => {
    const { repository, created } = shared('editor')
    const [left, right] = await Promise.all([
      Promise.resolve().then(() =>
        repository.reserveTask({
          ...owner,
          folderId: created.folder.folderId,
          idempotencyKey: 'same-task',
        }),
      ),
      Promise.resolve().then(() =>
        repository.reserveTask({
          ...friend,
          folderId: created.folder.folderId,
          idempotencyKey: 'same-task',
        }),
      ),
    ])
    expect([left.created, right.created].filter(Boolean)).toHaveLength(1)
    expect(left.reservation.upstreamWorkId).toBe(
      right.reservation.upstreamWorkId,
    )
    const approvalA = repository.reserveApprovalResolution(
      'approval-a',
      1,
      'decision-a',
    )
    const approvalB = repository.reserveApprovalResolution(
      'approval-a',
      1,
      'decision-b',
    )
    expect(approvalA.resolutionId).toBe(approvalB.resolutionId)
    expect([approvalA.created, approvalB.created].filter(Boolean)).toHaveLength(
      1,
    )
    const settlementA = repository.settleTask({
      ...owner,
      idempotencyKey: 'same-task',
      settlementKey: 'settle-a',
    })
    const settlementB = repository.settleTask({
      ...owner,
      idempotencyKey: 'same-task',
      settlementKey: 'settle-a',
    })
    expect(settlementA.billingSettlementId).toBe(
      settlementB.billingSettlementId,
    )
  })

  it('keeps audit immutable and free of invite token/content fields', () => {
    const { repository, created, invitation } = shared()
    const audit = repository.audit(owner, created.folder.folderId)
    expect(audit.length).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(audit)).not.toContain(invitation.token)
    expect(JSON.stringify(audit)).not.toContain('tokenDigest')
    expect(audit[0]?.previousHash).toBe('GENESIS')
    expect(audit.at(-1)?.recordHash).toMatch(/^[a-f0-9]{64}$/)
    expect(() => {
      ;(audit[0] as { action: string }).action = 'changed'
    }).not.toThrow()
    expect(repository.audit(owner, created.folder.folderId)[0]?.action).toBe(
      'folder.created',
    )
  })

  it('rejects cross-tenant and guessed identifiers without revealing existence', () => {
    const { repository, created } = shared()
    const crossTenant = {
      ...friend,
      tenantId: 'tenant-b',
      organizationId: 'tenant-b',
    }
    for (const identity of [crossTenant, outsider]) {
      try {
        repository.getFolder(identity, created.folder.folderId)
        throw new Error('expected rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(SharedFolderError)
        expect((error as SharedFolderError).code).toMatch(
          /FOLDER_(NOT_FOUND|ACCESS_DENIED)/,
        )
      }
    }
  })
})
