import { describe, expect, it } from 'vitest'
import {
  InMemorySharedFolderRepository,
  SharedFolderError,
  type FolderIdentity,
  type SharedFolderRepository,
} from './index'

const owner: FolderIdentity = {
  tenantId: 'tenant-a',
  organizationId: 'tenant-a',
  workspaceId: 'workspace-a',
  principalId: 'owner',
}
const friend = { ...owner, principalId: 'friend' }
const outsider = { ...owner, principalId: 'outsider' }

async function shared(
  repository: SharedFolderRepository,
  role: 'viewer' | 'editor' = 'viewer',
) {
  const created = await repository.createFolder({ ...owner, name: 'Shared' })
  const issued = await repository.createInvitation({
    ...owner,
    folderId: created.folder.folderId,
    role,
    expiresInSeconds: 600,
  })
  const accepted = await repository.acceptInvitation({
    ...friend,
    token: issued.token,
  })
  return { created, issued, accepted }
}

describe('async shared folder repository contract', () => {
  it('tombstones a folder and revokes access when its owner deletes it', async () => {
    const repository = new InMemorySharedFolderRepository()
    const { created } = await shared(repository)
    await repository.deleteFolder({
      ...owner,
      folderId: created.folder.folderId,
    })
    expect(await repository.listFolders(owner)).toEqual([])
    expect(await repository.listFolders(friend)).toEqual([])
    await expect(
      repository.getFolder(owner, created.folder.folderId),
    ).rejects.toMatchObject({ code: 'FOLDER_ACCESS_DENIED' })
  })

  it('is private by default and binds an idempotent invitation to one principal', async () => {
    const repository = new InMemorySharedFolderRepository()
    const { created, issued, accepted } = await shared(repository)
    expect(await repository.listFolders(outsider)).toEqual([])
    expect(accepted.membership.role).toBe('viewer')
    expect(
      (await repository.acceptInvitation({ ...friend, token: issued.token }))
        .idempotent,
    ).toBe(true)
    await expect(
      repository.acceptInvitation({ ...outsider, token: issued.token }),
    ).rejects.toMatchObject({ code: 'INVITATION_ACCEPTED' })
    expect(JSON.stringify(issued.invitation)).not.toContain(issued.token)
    expect((await repository.listFolders(friend))[0]?.folder.folderId).toBe(
      created.folder.folderId,
    )
  })

  it('expires and revokes single-use invitation tokens', async () => {
    const repository = new InMemorySharedFolderRepository()
    const created = await repository.createFolder({ ...owner, name: 'Shared' })
    const expired = await repository.createInvitation({
      ...owner,
      folderId: created.folder.folderId,
      role: 'viewer',
      expiresInSeconds: 60,
      now: new Date('2026-01-01T00:00:00Z'),
    })
    await expect(
      repository.acceptInvitation({
        ...friend,
        token: expired.token,
        now: new Date('2026-01-01T00:01:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' })
    const revoked = await repository.createInvitation({
      ...owner,
      folderId: created.folder.folderId,
      role: 'viewer',
      expiresInSeconds: 600,
    })
    await repository.revokeInvitation({
      ...owner,
      folderId: created.folder.folderId,
      invitationId: revoked.invitation.invitationId,
      expectedVersion: revoked.invitation.version,
    })
    await expect(
      repository.acceptInvitation({ ...friend, token: revoked.token }),
    ).rejects.toMatchObject({ code: 'INVITATION_REVOKED' })
  })

  it('enforces viewer/editor/owner capabilities and revoke', async () => {
    const repository = new InMemorySharedFolderRepository()
    const { created, accepted } = await shared(repository)
    await expect(
      repository.getFolder(friend, created.folder.folderId, 'turn'),
    ).rejects.toMatchObject({ code: 'FOLDER_ACCESS_DENIED' })
    const editor = await repository.changeRole({
      ...owner,
      folderId: created.folder.folderId,
      targetPrincipalId: friend.principalId,
      role: 'editor',
      expectedVersion: accepted.membership.version,
    })
    await expect(
      repository.getFolder(friend, created.folder.folderId, 'turn'),
    ).resolves.toMatchObject({ folderId: created.folder.folderId })
    await repository.revokeMembership({
      ...owner,
      folderId: created.folder.folderId,
      targetPrincipalId: friend.principalId,
      expectedVersion: editor.version,
    })
    await expect(
      repository.getFolder(friend, created.folder.folderId),
    ).rejects.toMatchObject({ code: 'FOLDER_ACCESS_DENIED' })
  })

  it('protects the last owner and transfers ownership optimistically', async () => {
    const repository = new InMemorySharedFolderRepository()
    const { created } = await shared(repository, 'editor')
    await expect(
      repository.changeRole({
        ...owner,
        folderId: created.folder.folderId,
        targetPrincipalId: owner.principalId,
        role: 'editor',
        expectedVersion: created.membership.version,
      }),
    ).rejects.toMatchObject({ code: 'LAST_OWNER_PROTECTED' })
    const transferred = await repository.transferOwnership({
      ...owner,
      folderId: created.folder.folderId,
      targetPrincipalId: friend.principalId,
      expectedVersion: created.folder.version + 1,
      previousOwnerRole: 'editor',
    })
    expect(transferred.owner.role).toBe('owner')
    expect(transferred.previousOwner.role).toBe('editor')
    await expect(
      repository.transferOwnership({
        ...friend,
        folderId: created.folder.folderId,
        targetPrincipalId: owner.principalId,
        expectedVersion: created.folder.version,
        previousOwnerRole: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('authorizes resource moves and emits access epochs', async () => {
    const repository = new InMemorySharedFolderRepository()
    const first = await repository.createFolder({ ...owner, name: 'First' })
    const second = await repository.createFolder({ ...owner, name: 'Second' })
    const events: string[] = []
    const unsubscribe = await repository.onAccessChanged((event) =>
      events.push(`${event.reason}:${event.cacheEpoch}`),
    )
    const bound = await repository.bindResource({
      ...owner,
      folderId: first.folder.folderId,
      resourceType: 'conversation',
      resourceId: 'conversation-1',
    })
    const moved = await repository.moveResource({
      ...owner,
      sourceFolderId: first.folder.folderId,
      targetFolderId: second.folder.folderId,
      resourceType: 'conversation',
      resourceId: 'conversation-1',
      expectedVersion: bound.version,
    })
    expect(moved.folderId).toBe(second.folder.folderId)
    await expect(
      repository.authorizeResource(
        outsider,
        'conversation',
        'conversation-1',
        'read',
      ),
    ).rejects.toBeInstanceOf(SharedFolderError)
    expect(events).toHaveLength(2)
    unsubscribe()
  })

  it('deduplicates task, approval and billing settlements', async () => {
    const repository = new InMemorySharedFolderRepository()
    const { created } = await shared(repository, 'editor')
    const [first, second] = await Promise.all([
      repository.reserveTask({
        ...owner,
        folderId: created.folder.folderId,
        sessionId: 'session-1',
        idempotencyKey: 'task-key',
        requestHash: 'a'.repeat(64),
      }),
      repository.reserveTask({
        ...friend,
        folderId: created.folder.folderId,
        sessionId: 'session-1',
        idempotencyKey: 'task-key',
        requestHash: 'a'.repeat(64),
      }),
    ])
    expect(first.reservation.taskId).toBe(second.reservation.taskId)
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1)
    await expect(
      repository.reserveTask({
        ...owner,
        folderId: created.folder.folderId,
        sessionId: 'session-1',
        idempotencyKey: 'task-key',
        requestHash: 'b'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'TASK_IDEMPOTENCY_CONFLICT' })
    const approvalInput = {
      ...owner,
      folderId: created.folder.folderId,
      approvalId: 'approval-1',
      expectedVersion: 1,
      durableEventId: 'evt-approval-resolved',
      codexTurnId: 'turn-1',
      decision: 'accept',
    }
    const approvalA = await repository.reserveApprovalResolution(approvalInput)
    const approvalB = await repository.reserveApprovalResolution({
      ...approvalInput,
      durableEventId: 'evt-other',
    })
    expect(approvalA.resolutionId).toBe(approvalB.resolutionId)
    const settlementInput = {
      ...owner,
      taskId: first.reservation.taskId,
      status: 'completed' as const,
      usageDedupeKey: 'runtime-usage:session-1:turn-1',
      creditReservationId: 'cres-1',
      billingSettlementId: 'cset-1',
    }
    const settlementA = await repository.settleTask(settlementInput)
    const settlementB = await repository.settleTask(settlementInput)
    expect(settlementA.billingSettlementId).toBe(
      settlementB.billingSettlementId,
    )
  })

  it('keeps an immutable hash-linked audit projection', async () => {
    const repository = new InMemorySharedFolderRepository()
    const { created } = await shared(repository)
    await repository.recordExport(owner, created.folder.folderId, 'export-1')
    const audit = await repository.audit(owner, created.folder.folderId)
    expect(audit.length).toBeGreaterThan(2)
    expect(audit[0]?.previousHash).toBe('GENESIS')
    expect(audit.at(-1)?.action).toBe('folder.exported')
    expect(Object.isFrozen(audit[0])).toBe(false)
  })
})
