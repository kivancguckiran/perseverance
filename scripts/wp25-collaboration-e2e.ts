import { strict as assert } from 'node:assert'
import { InMemorySharedFolderRepository } from '../packages/shared-folders/src/index.ts'

const repository = new InMemorySharedFolderRepository()
const owner = {
  tenantId: 'tenant_wp25',
  organizationId: 'tenant_wp25',
  workspaceId: 'workspace_wp25',
  principalId: 'principal_wp25_owner',
}
const friend = { ...owner, principalId: 'principal_wp25_friend' }
const outsider = { ...owner, principalId: 'principal_wp25_outsider' }

const shared = repository.createFolder({ ...owner, name: 'Shared evidence' })
const privateSibling = repository.createFolder({
  ...owner,
  name: 'Private evidence',
})
const invite = repository.createInvitation({
  ...owner,
  folderId: shared.folder.folderId,
  role: 'editor',
  expiresInSeconds: 900,
})
const accepted = repository.acceptInvitation({ ...friend, token: invite.token })
assert.equal(accepted.membership.role, 'editor')
assert.deepEqual(
  repository.listFolders(friend).map((entry) => entry.folder.folderId),
  [shared.folder.folderId],
)
assert.equal(repository.listFolders(outsider).length, 0)
assert.throws(
  () => repository.getFolder(friend, privateSibling.folder.folderId),
  /Shared folder operation was rejected/,
)

const resourceIds = {
  conversation: 'conversation_wp25_shared',
  source: 'source_wp25_shared',
  attachment: 'attachment_wp25_shared',
  artifact: 'artifact_wp25_shared',
  agent_task: 'task_wp25_shared',
} as const
for (const [resourceType, resourceId] of Object.entries(resourceIds))
  repository.bindResource({
    ...owner,
    folderId: shared.folder.folderId,
    resourceType: resourceType as keyof typeof resourceIds,
    resourceId,
  })
for (const [resourceType, resourceId] of Object.entries(resourceIds))
  repository.authorizeResource(
    friend,
    resourceType as keyof typeof resourceIds,
    resourceId,
    'read',
  )

const [taskA, taskB] = await Promise.all([
  Promise.resolve().then(() =>
    repository.reserveTask({
      ...owner,
      folderId: shared.folder.folderId,
      idempotencyKey: 'wp25-concurrent-task',
    }),
  ),
  Promise.resolve().then(() =>
    repository.reserveTask({
      ...friend,
      folderId: shared.folder.folderId,
      idempotencyKey: 'wp25-concurrent-task',
    }),
  ),
])
assert.equal(taskA.reservation.upstreamWorkId, taskB.reservation.upstreamWorkId)
assert.equal([taskA.created, taskB.created].filter(Boolean).length, 1)
const approvalA = repository.reserveApprovalResolution(
  'approval_wp25_shared',
  1,
  'owner-decision',
)
const approvalB = repository.reserveApprovalResolution(
  'approval_wp25_shared',
  1,
  'friend-decision',
)
assert.equal(approvalA.resolutionId, approvalB.resolutionId)
const settlementA = repository.settleTask({
  ...owner,
  idempotencyKey: 'wp25-concurrent-task',
  settlementKey: 'billing_wp25_shared',
})
const settlementB = repository.settleTask({
  ...owner,
  idempotencyKey: 'wp25-concurrent-task',
  settlementKey: 'billing_wp25_shared',
})
assert.equal(settlementA.billingSettlementId, settlementB.billingSettlementId)

const invalidations: string[] = []
repository.onAccessChanged((event) => invalidations.push(event.reason))
const viewer = repository.changeRole({
  ...owner,
  folderId: shared.folder.folderId,
  targetPrincipalId: friend.principalId,
  role: 'viewer',
  expectedVersion: accepted.membership.version,
})
assert.throws(
  () => repository.getFolder(friend, shared.folder.folderId, 'turn'),
  /Shared folder operation was rejected/,
)
repository.revokeMembership({
  ...owner,
  folderId: shared.folder.folderId,
  targetPrincipalId: friend.principalId,
  expectedVersion: viewer.version,
})
assert.equal(repository.listFolders(friend).length, 0)
assert.deepEqual(invalidations, ['role_changed', 'revoked'])

process.stdout.write(
  `${JSON.stringify({
    gate: 'wp25:e2e',
    principals: [owner.principalId, friend.principalId],
    folderId: shared.folder.folderId,
    privateFolderId: privateSibling.folder.folderId,
    invitationId: invite.invitation.invitationId,
    resourceIds,
    taskId: taskA.reservation.taskId,
    upstreamWorkId: taskA.reservation.upstreamWorkId,
    approvalId: 'approval_wp25_shared',
    approvalResolutionId: approvalA.resolutionId,
    billingSettlementId: settlementA.billingSettlementId,
    invalidations,
    singleUpstreamWork: true,
    singleApprovalResolution: true,
    singleBillingSettlement: true,
    cleanup: { temp: true, services: true },
  })}\n`,
)
