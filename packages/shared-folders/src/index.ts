import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type {
  FolderAccessChanged,
  FolderInvitation,
  FolderMembership,
  FolderResourceType,
  FolderRole,
  SharedFolder,
} from '@perseverance/control-plane-contracts'

export const SHARED_FOLDER_SERVICE_VERSION = 1 as const

export interface FolderScope {
  tenantId: string
  organizationId: string
  workspaceId: string
}

export interface FolderIdentity extends FolderScope {
  principalId: string
}

export interface FolderResourceBinding extends FolderScope {
  folderId: string
  resourceType: FolderResourceType
  resourceId: string
  version: number
  createdAt: string
  updatedAt: string
}

export type FolderAuditAction =
  | 'folder.created'
  | 'folder.deleted'
  | 'invitation.created'
  | 'invitation.accepted'
  | 'invitation.revoked'
  | 'membership.role_changed'
  | 'membership.revoked'
  | 'ownership.transferred'
  | 'resource.moved'
  | 'folder.exported'

export interface FolderAuditRecord extends FolderScope {
  schemaVersion: 1
  sequence: number
  auditId: string
  folderId: string
  actorPrincipalId: string
  subjectPrincipalId: string | null
  resourceType: FolderResourceType | null
  resourceId: string | null
  action: FolderAuditAction
  outcome: 'success' | 'failure'
  reasonCode: string
  aggregateVersion: number
  correlationId: string | null
  occurredAt: string
  previousHash: string
  recordHash: string
}

export class SharedFolderError extends Error {
  readonly code: string
  constructor(code: string, message = 'Shared folder operation was rejected') {
    super(message)
    this.code = code
    this.name = 'SharedFolderError'
  }
}

interface StoredInvitation extends FolderInvitation {
  tokenDigest: string
}

export interface TaskReservation {
  key: string
  folderId: string
  principalId: string
  sessionId: string
  requestHash: string
  taskId: string
  runId: string | null
  codexTurnId: string | null
  upstreamWorkId: string | null
  admissionDecisionId: string | null
  usageDedupeKey: string | null
  creditReservationId: string | null
  billingSettlementId: string | null
  status:
    | 'reserved'
    | 'running'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'incomplete'
    | 'admission_denied'
    | 'start_failed'
    | 'recovery_required'
}

const scopeKey = (scope: FolderScope) =>
  JSON.stringify([scope.tenantId, scope.organizationId, scope.workspaceId])
const folderKey = (scope: FolderScope, folderId: string) =>
  `${scopeKey(scope)}:${folderId}`
const memberKey = (scope: FolderScope, folderId: string, principalId: string) =>
  `${folderKey(scope, folderId)}:${principalId}`
const bindingKey = (
  scope: FolderScope,
  resourceType: FolderResourceType,
  resourceId: string,
) => `${scopeKey(scope)}:${resourceType}:${resourceId}`
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')
const clone = <T>(value: T): T => structuredClone(value)

export const folderRoleAllows = (
  role: FolderRole,
  capability: 'read' | 'mutate' | 'turn' | 'approval' | 'manage' | 'export',
) => {
  if (capability === 'read') return true
  if (capability === 'manage' || capability === 'export')
    return role === 'owner'
  return role === 'owner' || role === 'editor'
}

class InMemorySharedFolderCore {
  readonly #folders = new Map<string, SharedFolder>()
  readonly #memberships = new Map<string, FolderMembership>()
  readonly #invitations = new Map<string, StoredInvitation>()
  readonly #invitationByDigest = new Map<string, string>()
  readonly #bindings = new Map<string, FolderResourceBinding>()
  readonly #audit: FolderAuditRecord[] = []
  readonly #listeners = new Set<(event: FolderAccessChanged) => void>()
  readonly #authorizationCache = new Map<
    string,
    { epoch: number; role: FolderRole | null }
  >()
  readonly #tasks = new Map<string, TaskReservation>()
  readonly #approvalSettlements = new Map<string, string>()
  readonly #billingSettlements = new Map<string, string>()

  createFolder(input: FolderIdentity & { name: string; now?: Date }) {
    const now = (input.now ?? new Date()).toISOString()
    const folderId = `fld_${randomUUID()}`
    const folder: SharedFolder = {
      schemaVersion: 1,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      folderId,
      name: input.name.trim(),
      visibility: 'private',
      aclVersion: 1,
      cacheEpoch: 0,
      version: 1,
      createdByPrincipalId: input.principalId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
    if (!folder.name || folder.name.length > 80)
      throw new SharedFolderError('FOLDER_NAME_INVALID')
    const membership: FolderMembership = {
      schemaVersion: 1,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      folderId,
      principalId: input.principalId,
      role: 'owner',
      status: 'active',
      version: 1,
      acceptedInvitationId: null,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    }
    this.#folders.set(folderKey(input, folderId), folder)
    this.#memberships.set(
      memberKey(input, folderId, input.principalId),
      membership,
    )
    this.#appendAudit(input, folder, 'folder.created', 'success', 'CREATED')
    return clone({ folder, membership })
  }

  deleteFolder(input: FolderIdentity & { folderId: string; now?: Date }) {
    const folder = this.getFolder(input, input.folderId, 'manage')
    const now = input.now ?? new Date()
    const changed = this.#bump(input, input.folderId, 'revoked', null, now)
    this.#appendAudit(input, changed, 'folder.deleted', 'success', 'DELETED')
    const prefix = `${folderKey(input, input.folderId)}:`
    for (const [key, membership] of this.#memberships.entries()) {
      if (!key.startsWith(prefix) || membership.status !== 'active') continue
      membership.status = 'revoked'
      membership.revokedAt = now.toISOString()
      membership.updatedAt = now.toISOString()
      membership.version++
    }
    const stored = this.#folders.get(folderKey(input, input.folderId))!
    stored.archivedAt = now.toISOString()
    return clone({ ...folder, ...stored })
  }

  listFolders(identity: FolderIdentity) {
    const prefix = `${scopeKey(identity)}:`
    return [...this.#folders.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, folder]) => {
        const membership = this.#activeMembership(identity, folder.folderId)
        return membership ? [{ folder: clone(folder), membership }] : []
      })
  }

  getFolder(
    identity: FolderIdentity,
    folderId: string,
    capability: Parameters<typeof folderRoleAllows>[1] = 'read',
  ) {
    const folder = this.#folder(identity, folderId)
    const role = this.role(identity, folderId)
    if (!role || !folderRoleAllows(role, capability))
      throw new SharedFolderError('FOLDER_ACCESS_DENIED')
    return clone(folder)
  }

  role(identity: FolderIdentity, folderId: string): FolderRole | null {
    const folder = this.#folders.get(folderKey(identity, folderId))
    if (!folder || folder.archivedAt) return null
    const key = memberKey(identity, folderId, identity.principalId)
    const cached = this.#authorizationCache.get(key)
    if (cached !== undefined && cached.epoch === folder.cacheEpoch)
      return cached.role
    const membership = this.#memberships.get(key)
    const role = membership?.status === 'active' ? membership.role : null
    this.#authorizationCache.set(key, { epoch: folder.cacheEpoch, role })
    return role
  }

  listMembers(identity: FolderIdentity, folderId: string) {
    this.getFolder(identity, folderId, 'manage')
    const prefix = `${folderKey(identity, folderId)}:`
    return [...this.#memberships.entries()]
      .filter(
        ([key, value]) => key.startsWith(prefix) && value.status === 'active',
      )
      .map(([, value]) => clone(value))
  }

  createInvitation(
    input: FolderIdentity & {
      folderId: string
      role: 'editor' | 'viewer'
      expiresInSeconds: number
      now?: Date
    },
  ) {
    const folder = this.getFolder(input, input.folderId, 'manage')
    if (input.expiresInSeconds < 60 || input.expiresInSeconds > 604_800)
      throw new SharedFolderError('INVITATION_TTL_INVALID')
    const date = input.now ?? new Date()
    const now = date.toISOString()
    const invitationId = `inv_${randomUUID()}`
    const token = randomBytes(32).toString('base64url')
    const invitation: StoredInvitation = {
      schemaVersion: 1,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      folderId: input.folderId,
      invitationId,
      invitedByPrincipalId: input.principalId,
      acceptedByPrincipalId: null,
      role: input.role,
      status: 'pending',
      expiresAt: new Date(
        date.getTime() + input.expiresInSeconds * 1_000,
      ).toISOString(),
      acceptedAt: null,
      revokedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      tokenDigest: digest(token),
    }
    this.#invitations.set(invitationId, invitation)
    this.#invitationByDigest.set(invitation.tokenDigest, invitationId)
    this.#appendAudit(input, folder, 'invitation.created', 'success', 'CREATED')
    return { invitation: this.#publicInvitation(invitation), token }
  }

  listInvitations(
    identity: FolderIdentity,
    folderId: string,
    now = new Date(),
  ) {
    this.getFolder(identity, folderId, 'manage')
    return [...this.#invitations.values()]
      .filter(
        (value) =>
          value.folderId === folderId && scopeKey(value) === scopeKey(identity),
      )
      .map((value) => {
        this.#expire(value, now)
        return this.#publicInvitation(value)
      })
  }

  acceptInvitation(input: FolderIdentity & { token: string; now?: Date }) {
    const invitationId = this.#invitationByDigest.get(digest(input.token))
    if (!invitationId) throw new SharedFolderError('INVITATION_INVALID')
    const invitation = this.#invitations.get(invitationId)!
    if (scopeKey(invitation) !== scopeKey(input))
      throw new SharedFolderError('INVITATION_SCOPE_MISMATCH')
    const nowDate = input.now ?? new Date()
    this.#expire(invitation, nowDate)
    const existing = this.#memberships.get(
      memberKey(input, invitation.folderId, input.principalId),
    )
    if (
      invitation.status === 'accepted' &&
      invitation.acceptedByPrincipalId === input.principalId &&
      existing?.status === 'active'
    )
      return {
        invitation: this.#publicInvitation(invitation),
        membership: clone(existing),
        idempotent: true,
      }
    if (invitation.status !== 'pending')
      throw new SharedFolderError(
        `INVITATION_${invitation.status.toUpperCase()}`,
      )
    const now = nowDate.toISOString()
    invitation.status = 'accepted'
    invitation.acceptedByPrincipalId = input.principalId
    invitation.acceptedAt = now
    invitation.updatedAt = now
    invitation.version++
    const membership: FolderMembership = {
      schemaVersion: 1,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      folderId: invitation.folderId,
      principalId: input.principalId,
      role: invitation.role,
      status: 'active',
      version: (existing?.version ?? 0) + 1,
      acceptedInvitationId: invitation.invitationId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      revokedAt: null,
    }
    this.#memberships.set(
      memberKey(input, invitation.folderId, input.principalId),
      membership,
    )
    const folder = this.#bump(
      input,
      invitation.folderId,
      'accepted',
      input.principalId,
      nowDate,
    )
    this.#appendAudit(
      input,
      folder,
      'invitation.accepted',
      'success',
      'ACCEPTED',
      input.principalId,
    )
    return {
      invitation: this.#publicInvitation(invitation),
      membership: clone(membership),
      idempotent: false,
    }
  }

  revokeInvitation(
    input: FolderIdentity & {
      folderId: string
      invitationId: string
      expectedVersion: number
      now?: Date
    },
  ) {
    const folder = this.getFolder(input, input.folderId, 'manage')
    const invitation = this.#invitations.get(input.invitationId)
    if (
      !invitation ||
      invitation.folderId !== input.folderId ||
      scopeKey(invitation) !== scopeKey(input)
    )
      throw new SharedFolderError('INVITATION_NOT_FOUND')
    if (invitation.version !== input.expectedVersion)
      throw new SharedFolderError('VERSION_CONFLICT')
    if (invitation.status === 'revoked')
      return this.#publicInvitation(invitation)
    if (invitation.status !== 'pending')
      throw new SharedFolderError('INVITATION_NOT_PENDING')
    const now = (input.now ?? new Date()).toISOString()
    invitation.status = 'revoked'
    invitation.revokedAt = now
    invitation.updatedAt = now
    invitation.version++
    this.#appendAudit(input, folder, 'invitation.revoked', 'success', 'REVOKED')
    return this.#publicInvitation(invitation)
  }

  changeRole(
    input: FolderIdentity & {
      folderId: string
      targetPrincipalId: string
      role: FolderRole
      expectedVersion: number
      now?: Date
    },
  ) {
    this.getFolder(input, input.folderId, 'manage')
    const key = memberKey(input, input.folderId, input.targetPrincipalId)
    const membership = this.#memberships.get(key)
    if (!membership || membership.status !== 'active')
      throw new SharedFolderError('MEMBERSHIP_NOT_FOUND')
    if (membership.version !== input.expectedVersion)
      throw new SharedFolderError('VERSION_CONFLICT')
    if (
      membership.role === 'owner' &&
      input.role !== 'owner' &&
      this.#ownerCount(input, input.folderId) === 1
    )
      throw new SharedFolderError('LAST_OWNER_PROTECTED')
    const nowDate = input.now ?? new Date()
    membership.role = input.role
    membership.version++
    membership.updatedAt = nowDate.toISOString()
    const folder = this.#bump(
      input,
      input.folderId,
      'role_changed',
      input.targetPrincipalId,
      nowDate,
    )
    this.#appendAudit(
      input,
      folder,
      'membership.role_changed',
      'success',
      'ROLE_CHANGED',
      input.targetPrincipalId,
    )
    return clone(membership)
  }

  revokeMembership(
    input: FolderIdentity & {
      folderId: string
      targetPrincipalId: string
      expectedVersion: number
      now?: Date
    },
  ) {
    this.getFolder(input, input.folderId, 'manage')
    const key = memberKey(input, input.folderId, input.targetPrincipalId)
    const membership = this.#memberships.get(key)
    if (!membership || membership.status !== 'active')
      throw new SharedFolderError('MEMBERSHIP_NOT_FOUND')
    if (membership.version !== input.expectedVersion)
      throw new SharedFolderError('VERSION_CONFLICT')
    if (
      membership.role === 'owner' &&
      this.#ownerCount(input, input.folderId) === 1
    )
      throw new SharedFolderError('LAST_OWNER_PROTECTED')
    const nowDate = input.now ?? new Date()
    membership.status = 'revoked'
    membership.version++
    membership.updatedAt = nowDate.toISOString()
    membership.revokedAt = membership.updatedAt
    const folder = this.#bump(
      input,
      input.folderId,
      'revoked',
      input.targetPrincipalId,
      nowDate,
    )
    this.#appendAudit(
      input,
      folder,
      'membership.revoked',
      'success',
      'REVOKED',
      input.targetPrincipalId,
    )
    return clone(membership)
  }

  transferOwnership(
    input: FolderIdentity & {
      folderId: string
      targetPrincipalId: string
      expectedVersion: number
      previousOwnerRole: 'owner' | 'editor'
      now?: Date
    },
  ) {
    const folder = this.getFolder(input, input.folderId, 'manage')
    if (folder.version !== input.expectedVersion)
      throw new SharedFolderError('VERSION_CONFLICT')
    const target = this.#memberships.get(
      memberKey(input, input.folderId, input.targetPrincipalId),
    )
    const actor = this.#memberships.get(
      memberKey(input, input.folderId, input.principalId),
    )!
    if (!target || target.status !== 'active')
      throw new SharedFolderError('MEMBERSHIP_NOT_FOUND')
    const nowDate = input.now ?? new Date()
    const now = nowDate.toISOString()
    target.role = 'owner'
    target.version++
    target.updatedAt = now
    if (
      input.targetPrincipalId !== input.principalId &&
      input.previousOwnerRole === 'editor'
    ) {
      actor.role = 'editor'
      actor.version++
      actor.updatedAt = now
    }
    const changed = this.#bump(
      input,
      input.folderId,
      'ownership_transferred',
      input.targetPrincipalId,
      nowDate,
    )
    this.#appendAudit(
      input,
      changed,
      'ownership.transferred',
      'success',
      'TRANSFERRED',
      input.targetPrincipalId,
    )
    return {
      folder: changed,
      previousOwner: clone(actor),
      owner: clone(target),
    }
  }

  bindResource(
    input: FolderIdentity & {
      folderId: string
      resourceType: FolderResourceType
      resourceId: string
      now?: Date
    },
  ) {
    this.getFolder(input, input.folderId, 'mutate')
    const key = bindingKey(input, input.resourceType, input.resourceId)
    if (this.#bindings.has(key))
      throw new SharedFolderError('RESOURCE_ALREADY_BOUND')
    const now = (input.now ?? new Date()).toISOString()
    const binding: FolderResourceBinding = {
      ...input,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    this.#bindings.set(key, binding)
    return clone(binding)
  }

  moveResource(
    input: FolderIdentity & {
      sourceFolderId: string | null
      targetFolderId: string
      resourceType: FolderResourceType
      resourceId: string
      expectedVersion: number
      now?: Date
    },
  ) {
    this.getFolder(input, input.targetFolderId, 'mutate')
    const key = bindingKey(input, input.resourceType, input.resourceId)
    const binding = this.#bindings.get(key)
    if (!binding || binding.folderId !== input.sourceFolderId)
      throw new SharedFolderError('RESOURCE_NOT_FOUND')
    if (binding.version !== input.expectedVersion)
      throw new SharedFolderError('VERSION_CONFLICT')
    if (input.sourceFolderId)
      this.getFolder(input, input.sourceFolderId, 'mutate')
    const nowDate = input.now ?? new Date()
    binding.folderId = input.targetFolderId
    binding.version++
    binding.updatedAt = nowDate.toISOString()
    if (input.sourceFolderId)
      this.#bump(input, input.sourceFolderId, 'resource_moved', null, nowDate)
    const folder = this.#bump(
      input,
      input.targetFolderId,
      'resource_moved',
      null,
      nowDate,
    )
    this.#appendAudit(
      input,
      folder,
      'resource.moved',
      'success',
      'MOVED',
      null,
      input.resourceType,
      input.resourceId,
    )
    return clone(binding)
  }

  authorizeResource(
    identity: FolderIdentity,
    resourceType: FolderResourceType,
    resourceId: string,
    capability: Parameters<typeof folderRoleAllows>[1],
  ) {
    const binding = this.#bindings.get(
      bindingKey(identity, resourceType, resourceId),
    )
    if (!binding) throw new SharedFolderError('RESOURCE_NOT_FOUND')
    this.getFolder(identity, binding.folderId, capability)
    return clone(binding)
  }

  authorizeWorkloadResource(
    scope: FolderScope,
    resourceType: FolderResourceType,
    resourceId: string,
  ) {
    const binding = this.#bindings.get(
      bindingKey(scope, resourceType, resourceId),
    )
    if (!binding) throw new SharedFolderError('RESOURCE_NOT_FOUND')
    const reservation = [...this.#tasks.values()]
      .reverse()
      .find(
        (task) =>
          task.folderId === binding.folderId &&
          this.#activeMembership(
            { ...scope, principalId: task.principalId },
            binding.folderId,
          ),
      )
    if (!reservation) throw new SharedFolderError('FOLDER_ACCESS_DENIED')
    return clone(binding)
  }

  hasSharedFolders(scope: FolderScope) {
    const prefix = `${scopeKey(scope)}:`
    return [...this.#folders.keys()].some((key) => key.startsWith(prefix))
  }

  recordExport(
    identity: FolderIdentity,
    folderId: string,
    correlationId?: string,
  ) {
    const folder = this.getFolder(identity, folderId, 'export')
    this.#appendAudit(
      identity,
      folder,
      'folder.exported',
      'success',
      'EXPORTED',
      null,
      null,
      null,
      correlationId,
    )
  }

  audit(identity: FolderIdentity, folderId: string) {
    this.getFolder(identity, folderId, 'manage')
    return this.#audit
      .filter(
        (record) =>
          record.folderId === folderId &&
          scopeKey(record) === scopeKey(identity),
      )
      .map(clone)
  }

  reserveTask(
    input: FolderIdentity & {
      folderId: string
      sessionId: string
      idempotencyKey: string
      requestHash: string
    },
  ) {
    this.getFolder(input, input.folderId, 'turn')
    const key = `${scopeKey(input)}:${input.idempotencyKey}`
    const current = this.#tasks.get(key)
    if (current) {
      if (
        current.folderId !== input.folderId ||
        current.sessionId !== input.sessionId ||
        current.requestHash !== input.requestHash
      )
        throw new SharedFolderError('TASK_IDEMPOTENCY_CONFLICT')
      return { reservation: clone(current), created: false }
    }
    const reservation: TaskReservation = {
      key,
      folderId: input.folderId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      requestHash: input.requestHash,
      taskId: `tsk_${randomUUID()}`,
      runId: null,
      codexTurnId: null,
      upstreamWorkId: null,
      admissionDecisionId: null,
      usageDedupeKey: null,
      creditReservationId: null,
      billingSettlementId: null,
      status: 'reserved',
    }
    this.#tasks.set(key, reservation)
    return { reservation: clone(reservation), created: true }
  }

  getTask(identity: FolderIdentity, sessionId: string, idempotencyKey: string) {
    const task = this.#tasks.get(`${scopeKey(identity)}:${idempotencyKey}`)
    if (!task || task.sessionId !== sessionId)
      throw new SharedFolderError('TASK_NOT_FOUND')
    this.getFolder(identity, task.folderId, 'read')
    return clone(task)
  }

  findTaskByTurn(scope: FolderScope, codexTurnId: string) {
    const task = [...this.#tasks.values()].find(
      (value) => value.codexTurnId === codexTurnId,
    )
    return task
      ? {
          identity: { ...scope, principalId: task.principalId },
          taskId: task.taskId,
        }
      : null
  }

  bindTaskRuntime(
    input: FolderIdentity & {
      taskId: string
      runId: string
      codexTurnId: string
      upstreamWorkId: string
      admissionDecisionId: string | null
      creditReservationId: string | null
    },
  ) {
    const task = [...this.#tasks.values()].find(
      (value) => value.taskId === input.taskId,
    )
    if (!task) throw new SharedFolderError('TASK_NOT_FOUND')
    task.runId ??= input.runId
    task.codexTurnId ??= input.codexTurnId
    task.upstreamWorkId ??= input.upstreamWorkId
    task.admissionDecisionId ??= input.admissionDecisionId
    task.creditReservationId ??= input.creditReservationId
    task.status = 'running'
    return clone(task)
  }

  settleTask(
    input: FolderIdentity & {
      taskId: string
      status: TaskReservation['status']
      usageDedupeKey?: string | null
      creditReservationId?: string | null
      billingSettlementId?: string | null
    },
  ) {
    const task = [...this.#tasks.values()].find(
      (value) => value.taskId === input.taskId,
    )
    if (!task) throw new SharedFolderError('TASK_NOT_FOUND')
    const settlementId = input.billingSettlementId ?? null
    const existing = settlementId
      ? this.#billingSettlements.get(settlementId)
      : undefined
    if (existing && existing !== task.taskId)
      throw new SharedFolderError('BILLING_SETTLEMENT_CONFLICT')
    if (settlementId && !existing)
      this.#billingSettlements.set(settlementId, task.taskId)
    task.usageDedupeKey ??= input.usageDedupeKey ?? null
    task.creditReservationId ??= input.creditReservationId ?? null
    task.billingSettlementId ??= settlementId
    task.status = input.status
    return clone(task)
  }

  reserveApprovalResolution(
    approvalId: string,
    expectedVersion: number,
    durableEventId: string,
  ) {
    const key = `${approvalId}:${expectedVersion}`
    const current = this.#approvalSettlements.get(key)
    if (current) return { resolutionId: current, created: false }
    const resolutionId = durableEventId
    this.#approvalSettlements.set(key, resolutionId)
    return { resolutionId, created: true }
  }

  getApprovalResolution(approvalId: string) {
    const value = [...this.#approvalSettlements.entries()].find(([key]) =>
      key.startsWith(`${approvalId}:`),
    )
    return value ? { resolutionId: value[1] } : null
  }

  onAccessChanged(listener: (event: FolderAccessChanged) => void) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #folder(scope: FolderScope, folderId: string) {
    const folder = this.#folders.get(folderKey(scope, folderId))
    if (!folder) throw new SharedFolderError('FOLDER_NOT_FOUND')
    return folder
  }

  #activeMembership(identity: FolderIdentity, folderId: string) {
    const value = this.#memberships.get(
      memberKey(identity, folderId, identity.principalId),
    )
    return value?.status === 'active' ? clone(value) : null
  }

  #ownerCount(scope: FolderScope, folderId: string) {
    const prefix = `${folderKey(scope, folderId)}:`
    return [...this.#memberships.entries()].filter(
      ([key, value]) =>
        key.startsWith(prefix) &&
        value.status === 'active' &&
        value.role === 'owner',
    ).length
  }

  #expire(invitation: StoredInvitation, now: Date) {
    if (
      invitation.status === 'pending' &&
      Date.parse(invitation.expiresAt) <= now.getTime()
    ) {
      invitation.status = 'expired'
      invitation.updatedAt = now.toISOString()
      invitation.version++
    }
  }

  #publicInvitation(value: StoredInvitation): FolderInvitation {
    const { tokenDigest: _secret, ...invitation } = value
    return clone(invitation)
  }

  #bump(
    scope: FolderScope,
    folderId: string,
    reason: FolderAccessChanged['reason'],
    affectedPrincipalId: string | null,
    now: Date,
  ) {
    const folder = this.#folder(scope, folderId)
    folder.aclVersion++
    folder.cacheEpoch++
    folder.version++
    folder.updatedAt = now.toISOString()
    const prefix = `${folderKey(scope, folderId)}:`
    for (const key of this.#authorizationCache.keys())
      if (key.startsWith(prefix)) this.#authorizationCache.delete(key)
    const event: FolderAccessChanged = {
      schemaVersion: 1,
      type: 'folder.access.changed',
      tenantId: folder.tenantId,
      organizationId: folder.organizationId,
      workspaceId: folder.workspaceId,
      folderId,
      aclVersion: folder.aclVersion,
      cacheEpoch: folder.cacheEpoch,
      reason,
      affectedPrincipalId,
      occurredAt: now.toISOString(),
    }
    for (const listener of this.#listeners) listener(clone(event))
    return clone(folder)
  }

  #appendAudit(
    identity: FolderIdentity,
    folder: SharedFolder,
    action: FolderAuditAction,
    outcome: 'success' | 'failure',
    reasonCode: string,
    subjectPrincipalId: string | null = null,
    resourceType: FolderResourceType | null = null,
    resourceId: string | null = null,
    correlationId: string | null = null,
  ) {
    const previousHash = this.#audit.at(-1)?.recordHash ?? 'GENESIS'
    const record = {
      schemaVersion: 1 as const,
      sequence: this.#audit.length + 1,
      auditId: `fau_${randomUUID()}`,
      tenantId: folder.tenantId,
      organizationId: folder.organizationId,
      workspaceId: folder.workspaceId,
      folderId: folder.folderId,
      actorPrincipalId: identity.principalId,
      subjectPrincipalId,
      resourceType,
      resourceId,
      action,
      outcome,
      reasonCode,
      aggregateVersion: folder.version,
      correlationId,
      occurredAt: folder.updatedAt,
      previousHash,
    }
    const recordHash = digest(JSON.stringify(record))
    this.#audit.push(Object.freeze({ ...record, recordHash }))
  }
}

type Core = InMemorySharedFolderCore
type Capability = Parameters<typeof folderRoleAllows>[1]

export interface SharedFolderRepository {
  createFolder(
    input: Parameters<Core['createFolder']>[0],
  ): Promise<ReturnType<Core['createFolder']>>
  deleteFolder(
    input: Parameters<Core['deleteFolder']>[0],
  ): Promise<SharedFolder>
  listFolders(
    identity: FolderIdentity,
  ): Promise<ReturnType<Core['listFolders']>>
  getFolder(
    identity: FolderIdentity,
    folderId: string,
    capability?: Capability,
  ): Promise<SharedFolder>
  role(identity: FolderIdentity, folderId: string): Promise<FolderRole | null>
  listMembers(
    identity: FolderIdentity,
    folderId: string,
  ): Promise<FolderMembership[]>
  createInvitation(
    input: Parameters<Core['createInvitation']>[0],
  ): Promise<ReturnType<Core['createInvitation']>>
  listInvitations(
    identity: FolderIdentity,
    folderId: string,
    now?: Date,
  ): Promise<FolderInvitation[]>
  acceptInvitation(
    input: Parameters<Core['acceptInvitation']>[0],
  ): Promise<ReturnType<Core['acceptInvitation']>>
  revokeInvitation(
    input: Parameters<Core['revokeInvitation']>[0],
  ): Promise<FolderInvitation>
  changeRole(
    input: Parameters<Core['changeRole']>[0],
  ): Promise<FolderMembership>
  revokeMembership(
    input: Parameters<Core['revokeMembership']>[0],
  ): Promise<FolderMembership>
  transferOwnership(
    input: Parameters<Core['transferOwnership']>[0],
  ): Promise<ReturnType<Core['transferOwnership']>>
  bindResource(
    input: Parameters<Core['bindResource']>[0],
  ): Promise<FolderResourceBinding>
  hasSharedFolders(scope: FolderScope): Promise<boolean>
  moveResource(
    input: Parameters<Core['moveResource']>[0],
  ): Promise<FolderResourceBinding>
  authorizeResource(
    identity: FolderIdentity,
    resourceType: FolderResourceType,
    resourceId: string,
    capability: Capability,
  ): Promise<FolderResourceBinding>
  authorizeWorkloadResource(
    scope: FolderScope,
    resourceType: FolderResourceType,
    resourceId: string,
  ): Promise<FolderResourceBinding>
  recordExport(
    identity: FolderIdentity,
    folderId: string,
    correlationId?: string,
  ): Promise<void>
  audit(
    identity: FolderIdentity,
    folderId: string,
  ): Promise<FolderAuditRecord[]>
  reserveTask(
    input: Parameters<Core['reserveTask']>[0],
  ): Promise<ReturnType<Core['reserveTask']>>
  getTask(
    identity: FolderIdentity,
    sessionId: string,
    idempotencyKey: string,
  ): Promise<TaskReservation>
  findTaskByTurn(
    scope: FolderScope,
    codexTurnId: string,
  ): Promise<{ identity: FolderIdentity; taskId: string } | null>
  bindTaskRuntime(
    input: Parameters<Core['bindTaskRuntime']>[0],
  ): Promise<ReturnType<Core['bindTaskRuntime']>>
  settleTask(
    input: Parameters<Core['settleTask']>[0],
  ): Promise<ReturnType<Core['settleTask']>>
  reserveApprovalResolution(
    input: FolderIdentity & {
      folderId: string
      approvalId: string
      expectedVersion: number
      durableEventId: string
      codexTurnId: string | null
      decision: string
    },
  ): Promise<{ resolutionId: string; created: boolean }>
  getApprovalResolution(
    identity: FolderIdentity,
    approvalId: string,
  ): Promise<{ resolutionId: string } | null>
  onAccessChanged(
    listener: (event: FolderAccessChanged) => void,
  ): Promise<() => void>
  close(): Promise<void>
}

export class InMemorySharedFolderRepository implements SharedFolderRepository {
  readonly adapter = 'memory' as const
  readonly version = 1 as const
  readonly #core = new InMemorySharedFolderCore()

  async createFolder(input: Parameters<Core['createFolder']>[0]) {
    return this.#core.createFolder(input)
  }
  async deleteFolder(input: Parameters<Core['deleteFolder']>[0]) {
    return this.#core.deleteFolder(input)
  }
  async listFolders(identity: FolderIdentity) {
    return this.#core.listFolders(identity)
  }
  async getFolder(
    identity: FolderIdentity,
    folderId: string,
    capability: Capability = 'read',
  ) {
    return this.#core.getFolder(identity, folderId, capability)
  }
  async role(identity: FolderIdentity, folderId: string) {
    return this.#core.role(identity, folderId)
  }
  async listMembers(identity: FolderIdentity, folderId: string) {
    return this.#core.listMembers(identity, folderId)
  }
  async createInvitation(input: Parameters<Core['createInvitation']>[0]) {
    return this.#core.createInvitation(input)
  }
  async listInvitations(
    identity: FolderIdentity,
    folderId: string,
    now?: Date,
  ) {
    return this.#core.listInvitations(identity, folderId, now)
  }
  async acceptInvitation(input: Parameters<Core['acceptInvitation']>[0]) {
    return this.#core.acceptInvitation(input)
  }
  async revokeInvitation(input: Parameters<Core['revokeInvitation']>[0]) {
    return this.#core.revokeInvitation(input)
  }
  async changeRole(input: Parameters<Core['changeRole']>[0]) {
    return this.#core.changeRole(input)
  }
  async revokeMembership(input: Parameters<Core['revokeMembership']>[0]) {
    return this.#core.revokeMembership(input)
  }
  async transferOwnership(input: Parameters<Core['transferOwnership']>[0]) {
    return this.#core.transferOwnership(input)
  }
  async bindResource(input: Parameters<Core['bindResource']>[0]) {
    return this.#core.bindResource(input)
  }
  async moveResource(input: Parameters<Core['moveResource']>[0]) {
    return this.#core.moveResource(input)
  }
  async authorizeResource(
    identity: FolderIdentity,
    resourceType: FolderResourceType,
    resourceId: string,
    capability: Capability,
  ) {
    return this.#core.authorizeResource(
      identity,
      resourceType,
      resourceId,
      capability,
    )
  }
  async authorizeWorkloadResource(
    scope: FolderScope,
    resourceType: FolderResourceType,
    resourceId: string,
  ) {
    return this.#core.authorizeWorkloadResource(scope, resourceType, resourceId)
  }
  async hasSharedFolders(scope: FolderScope) {
    return this.#core.hasSharedFolders(scope)
  }
  async recordExport(
    identity: FolderIdentity,
    folderId: string,
    correlationId?: string,
  ) {
    this.#core.recordExport(identity, folderId, correlationId)
  }
  async audit(identity: FolderIdentity, folderId: string) {
    return this.#core.audit(identity, folderId)
  }
  async reserveTask(input: Parameters<Core['reserveTask']>[0]) {
    return this.#core.reserveTask(input)
  }
  async getTask(
    identity: FolderIdentity,
    sessionId: string,
    idempotencyKey: string,
  ) {
    return this.#core.getTask(identity, sessionId, idempotencyKey)
  }
  async findTaskByTurn(scope: FolderScope, codexTurnId: string) {
    return this.#core.findTaskByTurn(scope, codexTurnId)
  }
  async bindTaskRuntime(input: Parameters<Core['bindTaskRuntime']>[0]) {
    return this.#core.bindTaskRuntime(input)
  }
  async settleTask(input: Parameters<Core['settleTask']>[0]) {
    return this.#core.settleTask(input)
  }
  async reserveApprovalResolution(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    principalId: string
    folderId: string
    approvalId: string
    expectedVersion: number
    durableEventId: string
    codexTurnId: string | null
    decision: string
  }) {
    this.#core.getFolder(input, input.folderId, 'approval')
    return this.#core.reserveApprovalResolution(
      input.approvalId,
      input.expectedVersion,
      input.durableEventId,
    )
  }
  async getApprovalResolution(_identity: FolderIdentity, approvalId: string) {
    return this.#core.getApprovalResolution(approvalId)
  }
  async onAccessChanged(listener: (event: FolderAccessChanged) => void) {
    return this.#core.onAccessChanged(listener)
  }
  async close() {}
}
