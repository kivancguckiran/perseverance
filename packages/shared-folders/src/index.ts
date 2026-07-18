import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type {
  FolderAccessChanged,
  FolderInvitation,
  FolderMembership,
  FolderResourceType,
  FolderRole,
  SharedFolder,
} from '@persistent-codex/control-plane-contracts'

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

interface TaskReservation {
  key: string
  taskId: string
  upstreamWorkId: string
  billingSettlementId: string | null
  status: 'reserved' | 'completed'
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

export class InMemorySharedFolderRepository {
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
    input: FolderIdentity & { folderId: string; idempotencyKey: string },
  ) {
    this.getFolder(input, input.folderId, 'turn')
    const key = `${scopeKey(input)}:${input.idempotencyKey}`
    const current = this.#tasks.get(key)
    if (current) return { reservation: clone(current), created: false }
    const reservation: TaskReservation = {
      key,
      taskId: `tsk_${randomUUID()}`,
      upstreamWorkId: `up_${randomUUID()}`,
      billingSettlementId: null,
      status: 'reserved',
    }
    this.#tasks.set(key, reservation)
    return { reservation: clone(reservation), created: true }
  }

  settleTask(
    input: FolderScope & { idempotencyKey: string; settlementKey: string },
  ) {
    const task = this.#tasks.get(`${scopeKey(input)}:${input.idempotencyKey}`)
    if (!task) throw new SharedFolderError('TASK_NOT_FOUND')
    const existing = this.#billingSettlements.get(input.settlementKey)
    if (existing && existing !== task.taskId)
      throw new SharedFolderError('BILLING_SETTLEMENT_CONFLICT')
    if (!existing)
      this.#billingSettlements.set(input.settlementKey, task.taskId)
    task.billingSettlementId ??= `set_${digest(input.settlementKey).slice(0, 24)}`
    task.status = 'completed'
    return clone(task)
  }

  reserveApprovalResolution(
    approvalId: string,
    expectedVersion: number,
    resolutionKey: string,
  ) {
    const key = `${approvalId}:${expectedVersion}`
    const current = this.#approvalSettlements.get(key)
    if (current) return { resolutionId: current, created: false }
    const resolutionId = `apr_${digest(resolutionKey).slice(0, 24)}`
    this.#approvalSettlements.set(key, resolutionId)
    return { resolutionId, created: true }
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

export type SharedFolderRepository = InMemorySharedFolderRepository
