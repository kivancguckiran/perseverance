import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import type {
  FolderAccessChanged,
  FolderInvitation,
  FolderMembership,
  FolderResourceType,
  FolderRole,
  SharedFolder,
} from '@perseverance/control-plane-contracts'
import {
  folderRoleAllows,
  SharedFolderError,
  type FolderAuditAction,
  type FolderAuditRecord,
  type FolderIdentity,
  type FolderResourceBinding,
  type FolderScope,
  type SharedFolderRepository,
} from './index'

type Row = Record<string, unknown>
type Capability = Parameters<typeof folderRoleAllows>[1]
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value)
const nullableIso = (value: unknown) => (value == null ? null : iso(value))
const digestBuffer = (token: string) =>
  createHash('sha256').update(token).digest()
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')

function folder(row: Row): SharedFolder {
  return {
    schemaVersion: 1,
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    folderId: String(row.folder_id),
    name: String(row.name),
    visibility: 'private',
    aclVersion: Number(row.acl_version),
    cacheEpoch: Number(row.cache_epoch),
    version: Number(row.version),
    createdByPrincipalId: String(row.created_by_principal_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: nullableIso(row.archived_at),
  }
}

function membership(row: Row): FolderMembership {
  return {
    schemaVersion: 1,
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    folderId: String(row.folder_id),
    principalId: String(row.principal_id),
    role: row.role as FolderRole,
    status: row.status as FolderMembership['status'],
    version: Number(row.version),
    acceptedInvitationId:
      row.accepted_invitation_id == null
        ? null
        : String(row.accepted_invitation_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revokedAt: nullableIso(row.revoked_at),
  }
}

function invitation(row: Row): FolderInvitation {
  return {
    schemaVersion: 1,
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    folderId: String(row.folder_id),
    invitationId: String(row.invitation_id),
    invitedByPrincipalId: String(row.invited_by_principal_id),
    acceptedByPrincipalId:
      row.accepted_by_principal_id == null
        ? null
        : String(row.accepted_by_principal_id),
    role: row.role as FolderInvitation['role'],
    status: row.status as FolderInvitation['status'],
    expiresAt: iso(row.expires_at),
    acceptedAt: nullableIso(row.accepted_at),
    revokedAt: nullableIso(row.revoked_at),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function binding(row: Row): FolderResourceBinding {
  return {
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    folderId: String(row.folder_id),
    resourceType: row.resource_type as FolderResourceType,
    resourceId: String(row.resource_id),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function auditRecord(row: Row): FolderAuditRecord {
  return {
    schemaVersion: 1,
    sequence: Number(row.audit_id),
    auditId: `fau_${String(row.audit_id)}`,
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    folderId: String(row.folder_id),
    actorPrincipalId: String(row.principal_id),
    subjectPrincipalId:
      row.subject_principal_id == null
        ? null
        : String(row.subject_principal_id),
    resourceType:
      row.resource_type == null
        ? null
        : (row.resource_type as FolderResourceType),
    resourceId: row.resource_id == null ? null : String(row.resource_id),
    action: row.action as FolderAuditAction,
    outcome: row.outcome as FolderAuditRecord['outcome'],
    reasonCode: String(row.reason_code),
    aggregateVersion: Number(row.aggregate_version),
    correlationId:
      row.correlation_id == null ? null : String(row.correlation_id),
    occurredAt: iso(row.occurred_at),
    previousHash: String(row.previous_hash),
    recordHash: String(row.record_hash),
  }
}

const translate = (error: unknown): never => {
  const value = error as { code?: string; message?: string }
  const message = value.message ?? ''
  if (/last owner/i.test(message))
    throw new SharedFolderError('LAST_OWNER_PROTECTED')
  if (value.code === '23505' && /folder_task_reservations/i.test(message))
    throw new SharedFolderError('TASK_IDEMPOTENCY_CONFLICT')
  if (value.code === '23505') throw new SharedFolderError('VERSION_CONFLICT')
  if (value.code === '42501')
    throw new SharedFolderError('FOLDER_ACCESS_DENIED')
  if (value.code === 'P0002') throw new SharedFolderError('RESOURCE_NOT_FOUND')
  throw error
}

export class PostgresSharedFolderRepository implements SharedFolderRepository {
  readonly adapter = 'postgresql' as const
  readonly version = 1 as const
  readonly pool: Pool
  readonly options: { ownsPool?: boolean }
  readonly #listeners = new Set<(event: FolderAccessChanged) => void>()
  #listenerClient: PoolClient | null = null

  constructor(pool: Pool, options: { ownsPool?: boolean } = {}) {
    this.pool = pool
    this.options = options
  }

  async #transaction<T>(
    identity: FolderIdentity,
    operation: (client: PoolClient) => Promise<T>,
  ) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.tenant_id',$1,true),
                set_config('app.organization_id',$2,true),
                set_config('app.workspace_id',$3,true),
                set_config('app.principal_id',$4,true)`,
        [
          identity.tenantId,
          identity.organizationId,
          identity.workspaceId,
          identity.principalId,
        ],
      )
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      return translate(error)
    } finally {
      client.release()
    }
  }

  async #folder(
    client: PoolClient,
    identity: FolderIdentity,
    folderId: string,
    capability: Capability,
    lock = false,
  ) {
    const result = await client.query(
      `SELECT f.*,persistent_codex.folder_role($1,$2,$3,$4,$5) AS actor_role
       FROM persistent_codex.folders f
       WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
         AND folder_id=$4 AND archived_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [
        identity.tenantId,
        identity.organizationId,
        identity.workspaceId,
        folderId,
        identity.principalId,
      ],
    )
    if (!result.rowCount) throw new SharedFolderError('FOLDER_NOT_FOUND')
    const role = result.rows[0].actor_role as FolderRole | null
    if (!role || !folderRoleAllows(role, capability))
      throw new SharedFolderError('FOLDER_ACCESS_DENIED')
    return folder(result.rows[0] as Row)
  }

  async #appendAudit(
    client: PoolClient,
    identity: FolderIdentity,
    current: SharedFolder,
    action: FolderAuditAction,
    reasonCode: string,
    options: {
      subjectPrincipalId?: string | null
      resourceType?: FolderResourceType | null
      resourceId?: string | null
      correlationId?: string | null
    } = {},
  ) {
    const previous = await client.query(
      `SELECT record_hash FROM persistent_codex.folder_audit_records
       WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
       ORDER BY audit_id DESC LIMIT 1`,
      [identity.tenantId, identity.organizationId, identity.workspaceId],
    )
    const previousHash = String(previous.rows[0]?.record_hash ?? 'GENESIS')
    const occurredAt = current.updatedAt
    const recordHash = digest(
      JSON.stringify({
        ...identity,
        folderId: current.folderId,
        action,
        reasonCode,
        aggregateVersion: current.version,
        occurredAt,
        previousHash,
        ...options,
      }),
    )
    await client.query(
      `INSERT INTO persistent_codex.folder_audit_records
       (tenant_id,organization_id,workspace_id,folder_id,principal_id,action,outcome,
        reason_code,subject_principal_id,resource_type,resource_id,aggregate_version,
        correlation_id,occurred_at,previous_hash,record_hash)
       VALUES ($1,$2,$3,$4,$5,$6,'success',$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        identity.tenantId,
        identity.organizationId,
        identity.workspaceId,
        current.folderId,
        identity.principalId,
        action,
        reasonCode,
        options.subjectPrincipalId ?? null,
        options.resourceType ?? null,
        options.resourceId ?? null,
        current.version,
        options.correlationId ?? null,
        occurredAt,
        previousHash,
        recordHash,
      ],
    )
  }

  async #bump(
    client: PoolClient,
    identity: FolderIdentity,
    folderId: string,
    reason: FolderAccessChanged['reason'],
    affectedPrincipalId: string | null,
  ) {
    const changed = await client.query(
      `UPDATE persistent_codex.folders SET acl_version=acl_version+1,
         cache_epoch=cache_epoch+1,version=version+1,updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND folder_id=$4
       RETURNING *`,
      [
        identity.tenantId,
        identity.organizationId,
        identity.workspaceId,
        folderId,
      ],
    )
    if (!changed.rowCount) throw new SharedFolderError('FOLDER_NOT_FOUND')
    const current = folder(changed.rows[0] as Row)
    const event: FolderAccessChanged = {
      schemaVersion: 1,
      type: 'folder.access.changed',
      tenantId: current.tenantId,
      organizationId: current.organizationId,
      workspaceId: current.workspaceId,
      folderId,
      aclVersion: current.aclVersion,
      cacheEpoch: current.cacheEpoch,
      reason,
      affectedPrincipalId,
      occurredAt: current.updatedAt,
    }
    await client.query(
      `INSERT INTO persistent_codex.folder_access_outbox
       (tenant_id,organization_id,workspace_id,folder_id,principal_id,acl_version,
        cache_epoch,reason,affected_principal_id,occurred_at,event_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        identity.tenantId,
        identity.organizationId,
        identity.workspaceId,
        folderId,
        identity.principalId,
        current.aclVersion,
        current.cacheEpoch,
        reason,
        affectedPrincipalId,
        current.updatedAt,
        JSON.stringify(event),
      ],
    )
    return current
  }

  async createFolder(input: FolderIdentity & { name: string }) {
    const name = input.name.trim()
    if (!name || name.length > 80)
      throw new SharedFolderError('FOLDER_NAME_INVALID')
    return this.#transaction(input, async (client) => {
      const folderId = `fld_${randomUUID()}`
      await client.query(
        `INSERT INTO persistent_codex.folders
         (tenant_id,organization_id,workspace_id,folder_id,principal_id,name,created_by_principal_id)
         VALUES ($1,$2,$3,$4,$5,$6,$5)`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          folderId,
          input.principalId,
          name,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.folder_memberships
         (tenant_id,organization_id,workspace_id,folder_id,principal_id,role,status)
         VALUES ($1,$2,$3,$4,$5,'owner','active')`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          folderId,
          input.principalId,
        ],
      )
      const inserted = await client.query(
        `SELECT * FROM persistent_codex.folders
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND folder_id=$4`,
        [input.tenantId, input.organizationId, input.workspaceId, folderId],
      )
      const member = await client.query(
        `SELECT * FROM persistent_codex.folder_memberships
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND folder_id=$4 AND principal_id=$5`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          folderId,
          input.principalId,
        ],
      )
      const current = folder(inserted.rows[0] as Row)
      await this.#appendAudit(
        client,
        input,
        current,
        'folder.created',
        'CREATED',
      )
      return { folder: current, membership: membership(member.rows[0] as Row) }
    })
  }

  async deleteFolder(input: FolderIdentity & { folderId: string }) {
    return this.#transaction(input, async (client) => {
      await this.#folder(client, input, input.folderId, 'manage', true)
      const changed = await this.#bump(
        client,
        input,
        input.folderId,
        'revoked',
        null,
      )
      await this.#appendAudit(
        client,
        input,
        changed,
        'folder.deleted',
        'DELETED',
      )
      const result = await client.query(
        `UPDATE persistent_codex.folders
         SET archived_at=now(),updated_at=now(),version=version+1
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND folder_id=$4 RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.folderId,
        ],
      )
      return folder(result.rows[0] as Row)
    })
  }

  async listFolders(identity: FolderIdentity) {
    return this.#transaction(identity, async (client) => {
      const result = await client.query(
        `SELECT f.*,m.role,m.status,m.version AS membership_version,
                m.accepted_invitation_id,m.revoked_at,
                m.created_at AS membership_created_at,m.updated_at AS membership_updated_at
         FROM persistent_codex.folders f JOIN persistent_codex.folder_memberships m USING
           (tenant_id,organization_id,workspace_id,folder_id)
         WHERE f.tenant_id=$1 AND f.organization_id=$2 AND f.workspace_id=$3
           AND m.principal_id=$4 AND m.status='active' AND f.archived_at IS NULL
         ORDER BY f.updated_at DESC,f.folder_id`,
        [
          identity.tenantId,
          identity.organizationId,
          identity.workspaceId,
          identity.principalId,
        ],
      )
      return result.rows.map((row) => ({
        folder: folder(row as Row),
        membership: membership({
          ...row,
          principal_id: identity.principalId,
          version: row.membership_version,
          created_at: row.membership_created_at,
          updated_at: row.membership_updated_at,
        } as Row),
      }))
    })
  }

  async getFolder(
    identity: FolderIdentity,
    folderId: string,
    capability: Capability = 'read',
  ) {
    return this.#transaction(identity, (client) =>
      this.#folder(client, identity, folderId, capability),
    )
  }

  async role(identity: FolderIdentity, folderId: string) {
    return this.#transaction(identity, async (client) => {
      const result = await client.query(
        `SELECT persistent_codex.folder_role($1,$2,$3,$4,$5) AS role`,
        [
          identity.tenantId,
          identity.organizationId,
          identity.workspaceId,
          folderId,
          identity.principalId,
        ],
      )
      return (result.rows[0]?.role as FolderRole | null) ?? null
    })
  }

  async listMembers(identity: FolderIdentity, folderId: string) {
    return this.#transaction(identity, async (client) => {
      await this.#folder(client, identity, folderId, 'manage')
      const result = await client.query(
        `SELECT * FROM persistent_codex.folder_memberships
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND folder_id=$4 AND status='active' ORDER BY created_at,principal_id`,
        [
          identity.tenantId,
          identity.organizationId,
          identity.workspaceId,
          folderId,
        ],
      )
      return result.rows.map((row) => membership(row as Row))
    })
  }

  async createInvitation(
    input: FolderIdentity & {
      folderId: string
      role: 'editor' | 'viewer'
      expiresInSeconds: number
    },
  ) {
    if (input.expiresInSeconds < 60 || input.expiresInSeconds > 604_800)
      throw new SharedFolderError('INVITATION_TTL_INVALID')
    const token = randomBytes(32).toString('base64url')
    return this.#transaction(input, async (client) => {
      const current = await this.#folder(
        client,
        input,
        input.folderId,
        'manage',
      )
      const result = await client.query(
        `INSERT INTO persistent_codex.folder_invitations
         (tenant_id,organization_id,workspace_id,folder_id,invitation_id,principal_id,
          token_digest,invited_by_principal_id,role,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$8,now()+make_interval(secs=>$9::double precision))
         RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.folderId,
          `inv_${randomUUID()}`,
          input.principalId,
          digestBuffer(token),
          input.role,
          input.expiresInSeconds,
        ],
      )
      await this.#appendAudit(
        client,
        input,
        current,
        'invitation.created',
        'CREATED',
      )
      return { invitation: invitation(result.rows[0] as Row), token }
    })
  }

  async listInvitations(
    identity: FolderIdentity,
    folderId: string,
    now = new Date(),
  ) {
    return this.#transaction(identity, async (client) => {
      await this.#folder(client, identity, folderId, 'manage')
      await client.query(
        `UPDATE persistent_codex.folder_invitations SET status='expired',
           version=version+1,updated_at=$5
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND folder_id=$4
           AND status='pending' AND expires_at<=$5`,
        [
          identity.tenantId,
          identity.organizationId,
          identity.workspaceId,
          folderId,
          now,
        ],
      )
      const result = await client.query(
        `SELECT * FROM persistent_codex.folder_invitations
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND folder_id=$4
         ORDER BY created_at DESC`,
        [
          identity.tenantId,
          identity.organizationId,
          identity.workspaceId,
          folderId,
        ],
      )
      return result.rows.map((row) => invitation(row as Row))
    })
  }

  async acceptInvitation(input: FolderIdentity & { token: string }) {
    const accepted = await this.#transaction(input, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.accept_folder_invitation($1,$2,now())`,
        [digestBuffer(input.token), input.principalId],
      )
      if (!result.rowCount) return { rejection: 'INVITATION_INVALID' as const }
      const value = result.rows[0] as Row
      if (value.invitation_status !== 'accepted')
        return {
          rejection: `INVITATION_${String(value.invitation_status).toUpperCase()}`,
        }
      const invitations = await client.query(
        `SELECT * FROM persistent_codex.folder_invitations
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND folder_id=$4 AND invitation_id=$5`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          value.folder_id,
          value.invitation_id,
        ],
      )
      const memberships = await client.query(
        `SELECT * FROM persistent_codex.folder_memberships
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND folder_id=$4 AND principal_id=$5`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          value.folder_id,
          input.principalId,
        ],
      )
      return {
        invitation: invitation(invitations.rows[0] as Row),
        membership: membership(memberships.rows[0] as Row),
        idempotent: Boolean(value.idempotent),
      }
    })
    if ('rejection' in accepted) throw new SharedFolderError(accepted.rejection)
    return accepted
  }

  async revokeInvitation(
    input: FolderIdentity & {
      folderId: string
      invitationId: string
      expectedVersion: number
    },
  ) {
    return this.#transaction(input, async (client) => {
      const current = await this.#folder(
        client,
        input,
        input.folderId,
        'manage',
      )
      const result = await client.query(
        `UPDATE persistent_codex.folder_invitations SET status='revoked',revoked_at=now(),
           updated_at=now(),version=version+1
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND folder_id=$4
           AND invitation_id=$5 AND version=$6 AND status='pending' RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.folderId,
          input.invitationId,
          input.expectedVersion,
        ],
      )
      if (!result.rowCount) throw new SharedFolderError('VERSION_CONFLICT')
      await this.#appendAudit(
        client,
        input,
        current,
        'invitation.revoked',
        'REVOKED',
      )
      return invitation(result.rows[0] as Row)
    })
  }

  async changeRole(
    input: FolderIdentity & {
      folderId: string
      targetPrincipalId: string
      role: FolderRole
      expectedVersion: number
    },
  ) {
    return this.#transaction(input, async (client) => {
      await this.#folder(client, input, input.folderId, 'manage', true)
      const result = await client.query(
        `UPDATE persistent_codex.folder_memberships SET role=$6,version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND folder_id=$4
           AND principal_id=$5 AND version=$7 AND status='active' RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.folderId,
          input.targetPrincipalId,
          input.role,
          input.expectedVersion,
        ],
      )
      if (!result.rowCount) throw new SharedFolderError('VERSION_CONFLICT')
      const current = await this.#bump(
        client,
        input,
        input.folderId,
        'role_changed',
        input.targetPrincipalId,
      )
      await this.#appendAudit(
        client,
        input,
        current,
        'membership.role_changed',
        'ROLE_CHANGED',
        { subjectPrincipalId: input.targetPrincipalId },
      )
      return membership(result.rows[0] as Row)
    })
  }

  async revokeMembership(
    input: FolderIdentity & {
      folderId: string
      targetPrincipalId: string
      expectedVersion: number
    },
  ) {
    return this.#transaction(input, async (client) => {
      await this.#folder(client, input, input.folderId, 'manage', true)
      const result = await client.query(
        `UPDATE persistent_codex.folder_memberships SET status='revoked',revoked_at=now(),
           version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND folder_id=$4
           AND principal_id=$5 AND version=$6 AND status='active' RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.folderId,
          input.targetPrincipalId,
          input.expectedVersion,
        ],
      )
      if (!result.rowCount) throw new SharedFolderError('VERSION_CONFLICT')
      const current = await this.#bump(
        client,
        input,
        input.folderId,
        'revoked',
        input.targetPrincipalId,
      )
      await this.#appendAudit(
        client,
        input,
        current,
        'membership.revoked',
        'REVOKED',
        { subjectPrincipalId: input.targetPrincipalId },
      )
      return membership(result.rows[0] as Row)
    })
  }

  async transferOwnership(
    input: FolderIdentity & {
      folderId: string
      targetPrincipalId: string
      expectedVersion: number
      previousOwnerRole: 'owner' | 'editor'
    },
  ) {
    return this.#transaction(input, async (client) => {
      const before = await this.#folder(
        client,
        input,
        input.folderId,
        'manage',
        true,
      )
      if (before.version !== input.expectedVersion)
        throw new SharedFolderError('VERSION_CONFLICT')
      const target = await client.query(
        `UPDATE persistent_codex.folder_memberships SET role='owner',version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND folder_id=$4
           AND principal_id=$5 AND status='active' RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.folderId,
          input.targetPrincipalId,
        ],
      )
      if (!target.rowCount) throw new SharedFolderError('MEMBERSHIP_NOT_FOUND')
      let previous = await client.query(
        `SELECT * FROM persistent_codex.folder_memberships
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND folder_id=$4 AND principal_id=$5`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.folderId,
          input.principalId,
        ],
      )
      if (
        input.targetPrincipalId !== input.principalId &&
        input.previousOwnerRole === 'editor'
      )
        previous = await client.query(
          `UPDATE persistent_codex.folder_memberships SET role='editor',version=version+1,updated_at=now()
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND folder_id=$4
             AND principal_id=$5 AND status='active' RETURNING *`,
          [
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            input.folderId,
            input.principalId,
          ],
        )
      const current = await this.#bump(
        client,
        input,
        input.folderId,
        'ownership_transferred',
        input.targetPrincipalId,
      )
      await this.#appendAudit(
        client,
        input,
        current,
        'ownership.transferred',
        'TRANSFERRED',
        { subjectPrincipalId: input.targetPrincipalId },
      )
      return {
        folder: current,
        previousOwner: membership(previous.rows[0] as Row),
        owner: membership(target.rows[0] as Row),
      }
    })
  }

  async bindResource(
    input: FolderIdentity & {
      folderId: string
      resourceType: FolderResourceType
      resourceId: string
    },
  ) {
    return this.#transaction(input, async (client) => {
      await this.#folder(client, input, input.folderId, 'mutate')
      const result = await client.query(
        `INSERT INTO persistent_codex.folder_resource_bindings
         (tenant_id,organization_id,workspace_id,folder_id,principal_id,resource_type,resource_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.folderId,
          input.principalId,
          input.resourceType,
          input.resourceId,
        ],
      )
      return binding(result.rows[0] as Row)
    })
  }

  async moveResource(
    input: FolderIdentity & {
      sourceFolderId: string | null
      targetFolderId: string
      resourceType: FolderResourceType
      resourceId: string
      expectedVersion: number
    },
  ) {
    return this.#transaction(input, async (client) => {
      await this.#folder(client, input, input.targetFolderId, 'mutate', true)
      if (input.sourceFolderId)
        await this.#folder(client, input, input.sourceFolderId, 'mutate', true)
      const result = await client.query(
        `UPDATE persistent_codex.folder_resource_bindings
         SET folder_id=$5,principal_id=$6,version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND resource_type=$4 AND resource_id=$7 AND folder_id IS NOT DISTINCT FROM $8
           AND version=$9 RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.resourceType,
          input.targetFolderId,
          input.principalId,
          input.resourceId,
          input.sourceFolderId,
          input.expectedVersion,
        ],
      )
      if (!result.rowCount) throw new SharedFolderError('VERSION_CONFLICT')
      if (input.sourceFolderId)
        await this.#bump(
          client,
          input,
          input.sourceFolderId,
          'resource_moved',
          null,
        )
      const current = await this.#bump(
        client,
        input,
        input.targetFolderId,
        'resource_moved',
        null,
      )
      await this.#appendAudit(
        client,
        input,
        current,
        'resource.moved',
        'MOVED',
        { resourceType: input.resourceType, resourceId: input.resourceId },
      )
      return binding(result.rows[0] as Row)
    })
  }

  async authorizeResource(
    identity: FolderIdentity,
    resourceType: FolderResourceType,
    resourceId: string,
    capability: Capability,
  ) {
    return this.#transaction(identity, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.folder_resource_bindings
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND resource_type=$4 AND resource_id=$5`,
        [
          identity.tenantId,
          identity.organizationId,
          identity.workspaceId,
          resourceType,
          resourceId,
        ],
      )
      if (!result.rowCount) throw new SharedFolderError('RESOURCE_NOT_FOUND')
      const current = binding(result.rows[0] as Row)
      await this.#folder(client, identity, current.folderId, capability)
      return current
    })
  }

  async authorizeWorkloadResource(
    scope: FolderScope,
    resourceType: FolderResourceType,
    resourceId: string,
  ) {
    const client = await this.pool.connect()
    try {
      const result = await client.query(
        `SELECT * FROM persistent_codex.authorize_folder_workload_resource($1,$2,$3,$4,$5)`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          resourceType,
          resourceId,
        ],
      )
      if (!result.rowCount) throw new SharedFolderError('FOLDER_ACCESS_DENIED')
      return binding(result.rows[0] as Row)
    } finally {
      client.release()
    }
  }

  async hasSharedFolders(scope: FolderScope) {
    const result = await this.pool.query(
      `SELECT persistent_codex.shared_folder_scope_exists($1,$2,$3) AS present`,
      [scope.tenantId, scope.organizationId, scope.workspaceId],
    )
    return Boolean(result.rows[0]?.present)
  }

  async recordExport(
    identity: FolderIdentity,
    folderId: string,
    correlationId?: string,
  ) {
    await this.#transaction(identity, async (client) => {
      const current = await this.#folder(client, identity, folderId, 'export')
      await this.#appendAudit(
        client,
        identity,
        current,
        'folder.exported',
        'EXPORTED',
        {
          ...(correlationId ? { correlationId } : {}),
        },
      )
    })
  }

  async audit(identity: FolderIdentity, folderId: string) {
    return this.#transaction(identity, async (client) => {
      await this.#folder(client, identity, folderId, 'manage')
      const result = await client.query(
        `SELECT * FROM persistent_codex.folder_audit_records
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND folder_id=$4
         ORDER BY audit_id`,
        [
          identity.tenantId,
          identity.organizationId,
          identity.workspaceId,
          folderId,
        ],
      )
      return result.rows.map((row) => auditRecord(row as Row))
    })
  }

  async reserveTask(
    input: FolderIdentity & {
      folderId: string
      sessionId: string
      idempotencyKey: string
      requestHash: string
    },
  ) {
    return this.#transaction(input, async (client) => {
      await this.#folder(client, input, input.folderId, 'turn')
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [
          JSON.stringify([
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            input.idempotencyKey,
          ]),
        ],
      )
      const current = (
        await client.query(
          `SELECT * FROM persistent_codex.folder_task_reservations
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND idempotency_key=$4`,
          [
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            input.idempotencyKey,
          ],
        )
      ).rows[0]
      if (current) {
        if (
          String(current.folder_id) !== input.folderId ||
          String(current.session_id) !== input.sessionId ||
          String(current.request_hash) !== input.requestHash
        )
          throw new SharedFolderError('TASK_IDEMPOTENCY_CONFLICT')
        return {
          reservation: {
            key: input.idempotencyKey,
            folderId: String(current.folder_id),
            principalId: String(current.principal_id),
            taskId: String(current.task_id),
            sessionId: String(current.session_id),
            requestHash: String(current.request_hash),
            runId: current.run_id ? String(current.run_id) : null,
            codexTurnId: current.codex_turn_id
              ? String(current.codex_turn_id)
              : null,
            upstreamWorkId: current.upstream_work_id
              ? String(current.upstream_work_id)
              : null,
            admissionDecisionId: current.admission_decision_id
              ? String(current.admission_decision_id)
              : null,
            usageDedupeKey: current.usage_dedupe_key
              ? String(current.usage_dedupe_key)
              : null,
            creditReservationId: current.credit_reservation_id
              ? String(current.credit_reservation_id)
              : null,
            billingSettlementId: current.billing_settlement_id
              ? String(current.billing_settlement_id)
              : null,
            status: current.status,
          },
          created: false,
        }
      }
      const taskId = `tsk_${randomUUID()}`
      const inserted = await client.query(
        `INSERT INTO persistent_codex.folder_task_reservations
         (tenant_id,organization_id,workspace_id,folder_id,principal_id,task_id,session_id,idempotency_key,request_hash,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved')
         RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.folderId,
          input.principalId,
          taskId,
          input.sessionId,
          input.idempotencyKey,
          input.requestHash,
        ],
      )
      const row =
        inserted.rows[0] ??
        (
          await client.query(
            `SELECT * FROM persistent_codex.folder_task_reservations
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND idempotency_key=$4`,
            [
              input.tenantId,
              input.organizationId,
              input.workspaceId,
              input.idempotencyKey,
            ],
          )
        ).rows[0]
      if (!row) throw new SharedFolderError('TASK_IDEMPOTENCY_CONFLICT')
      if (
        String(row.folder_id) !== input.folderId ||
        String(row.session_id) !== input.sessionId ||
        String(row.request_hash) !== input.requestHash
      )
        throw new SharedFolderError('TASK_IDEMPOTENCY_CONFLICT')
      return {
        reservation: {
          key: input.idempotencyKey,
          folderId: String(row.folder_id),
          principalId: String(row.principal_id),
          taskId: String(row.task_id),
          sessionId: String(row.session_id),
          requestHash: String(row.request_hash),
          runId: row.run_id ? String(row.run_id) : null,
          codexTurnId: row.codex_turn_id ? String(row.codex_turn_id) : null,
          upstreamWorkId: row.upstream_work_id
            ? String(row.upstream_work_id)
            : null,
          admissionDecisionId: row.admission_decision_id
            ? String(row.admission_decision_id)
            : null,
          usageDedupeKey: row.usage_dedupe_key
            ? String(row.usage_dedupe_key)
            : null,
          creditReservationId: row.credit_reservation_id
            ? String(row.credit_reservation_id)
            : null,
          billingSettlementId: row.billing_settlement_id
            ? String(row.billing_settlement_id)
            : null,
          status: row.status,
        },
        created: Boolean(inserted.rowCount),
      }
    })
  }

  async getTask(
    identity: FolderIdentity,
    sessionId: string,
    idempotencyKey: string,
  ) {
    return this.#transaction(identity, async (client) => {
      const row = (
        await client.query(
          `SELECT * FROM persistent_codex.folder_task_reservations WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND session_id=$4 AND idempotency_key=$5`,
          [
            identity.tenantId,
            identity.organizationId,
            identity.workspaceId,
            sessionId,
            idempotencyKey,
          ],
        )
      ).rows[0]
      if (!row) throw new SharedFolderError('TASK_NOT_FOUND')
      await this.#folder(client, identity, String(row.folder_id), 'read')
      return {
        key: String(row.idempotency_key),
        folderId: String(row.folder_id),
        principalId: String(row.principal_id),
        sessionId: String(row.session_id),
        requestHash: String(row.request_hash),
        taskId: String(row.task_id),
        runId: row.run_id ? String(row.run_id) : null,
        codexTurnId: row.codex_turn_id ? String(row.codex_turn_id) : null,
        upstreamWorkId: row.upstream_work_id
          ? String(row.upstream_work_id)
          : null,
        admissionDecisionId: row.admission_decision_id
          ? String(row.admission_decision_id)
          : null,
        usageDedupeKey: row.usage_dedupe_key
          ? String(row.usage_dedupe_key)
          : null,
        creditReservationId: row.credit_reservation_id
          ? String(row.credit_reservation_id)
          : null,
        billingSettlementId: row.billing_settlement_id
          ? String(row.billing_settlement_id)
          : null,
        status: row.status,
      }
    })
  }

  async findTaskByTurn(scope: FolderScope, codexTurnId: string) {
    const row = (
      await this.pool.query(
        `SELECT * FROM persistent_codex.shared_folder_task_for_turn($1,$2,$3,$4)`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, codexTurnId],
      )
    ).rows[0]
    return row
      ? {
          identity: { ...scope, principalId: String(row.principal_id) },
          taskId: String(row.task_id),
        }
      : null
  }

  async bindTaskRuntime(
    input: FolderIdentity & {
      taskId: string
      runId: string
      codexTurnId: string
      upstreamWorkId: string
      admissionDecisionId: string | null
      creditReservationId: string | null
    },
  ) {
    return this.#transaction(input, async (client) => {
      const result = await client.query(
        `UPDATE persistent_codex.folder_task_reservations SET run_id=coalesce(run_id,$5),codex_turn_id=coalesce(codex_turn_id,$6),upstream_work_id=coalesce(upstream_work_id,$7),admission_decision_id=coalesce(admission_decision_id,$8),credit_reservation_id=coalesce(credit_reservation_id,$9),status='running',version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND task_id=$4 RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.taskId,
          input.runId,
          input.codexTurnId,
          input.upstreamWorkId,
          input.admissionDecisionId,
          input.creditReservationId,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new SharedFolderError('TASK_NOT_FOUND')
      return {
        key: String(row.idempotency_key),
        folderId: String(row.folder_id),
        principalId: String(row.principal_id),
        sessionId: String(row.session_id),
        requestHash: String(row.request_hash),
        taskId: String(row.task_id),
        runId: String(row.run_id),
        codexTurnId: String(row.codex_turn_id),
        upstreamWorkId: String(row.upstream_work_id),
        admissionDecisionId: row.admission_decision_id
          ? String(row.admission_decision_id)
          : null,
        usageDedupeKey: row.usage_dedupe_key
          ? String(row.usage_dedupe_key)
          : null,
        creditReservationId: row.credit_reservation_id
          ? String(row.credit_reservation_id)
          : null,
        billingSettlementId: row.billing_settlement_id
          ? String(row.billing_settlement_id)
          : null,
        status: row.status,
      }
    })
  }

  async settleTask(
    input: FolderIdentity & {
      taskId: string
      status: import('./index.js').TaskReservation['status']
      usageDedupeKey?: string | null
      creditReservationId?: string | null
      billingSettlementId?: string | null
    },
  ) {
    return this.#transaction(input, async (client) => {
      const tasks = await client.query(
        `SELECT * FROM persistent_codex.folder_task_reservations
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND task_id=$4
         FOR UPDATE`,
        [input.tenantId, input.organizationId, input.workspaceId, input.taskId],
      )
      if (!tasks.rowCount) throw new SharedFolderError('TASK_NOT_FOUND')
      const task = tasks.rows[0]
      await this.#folder(client, input, String(task.folder_id), 'turn')
      if (
        input.billingSettlementId &&
        input.usageDedupeKey &&
        input.creditReservationId
      )
        await client.query(
          `INSERT INTO persistent_codex.folder_billing_settlements (tenant_id,organization_id,workspace_id,folder_id,principal_id,task_id,usage_dedupe_key,credit_reservation_id,settlement_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id,organization_id,workspace_id,usage_dedupe_key) DO NOTHING`,
          [
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            task.folder_id,
            task.principal_id,
            task.task_id,
            input.usageDedupeKey,
            input.creditReservationId,
            input.billingSettlementId,
          ],
        )
      await client.query(
        `UPDATE persistent_codex.folder_task_reservations SET status=$5,usage_dedupe_key=coalesce(usage_dedupe_key,$6),credit_reservation_id=coalesce(credit_reservation_id,$7),billing_settlement_id=coalesce(billing_settlement_id,$8),version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND task_id=$4`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          task.task_id,
          input.status,
          input.usageDedupeKey ?? null,
          input.creditReservationId ?? null,
          input.billingSettlementId ?? null,
        ],
      )
      return {
        key: String(task.idempotency_key),
        folderId: String(task.folder_id),
        principalId: String(task.principal_id),
        taskId: String(task.task_id),
        sessionId: String(task.session_id),
        requestHash: String(task.request_hash),
        runId: task.run_id ? String(task.run_id) : null,
        codexTurnId: task.codex_turn_id ? String(task.codex_turn_id) : null,
        upstreamWorkId: task.upstream_work_id
          ? String(task.upstream_work_id)
          : null,
        admissionDecisionId: task.admission_decision_id
          ? String(task.admission_decision_id)
          : null,
        usageDedupeKey: input.usageDedupeKey ?? task.usage_dedupe_key ?? null,
        creditReservationId:
          input.creditReservationId ?? task.credit_reservation_id ?? null,
        billingSettlementId:
          input.billingSettlementId ?? task.billing_settlement_id ?? null,
        status: input.status,
      }
    })
  }

  async reserveApprovalResolution(
    input: FolderIdentity & {
      folderId: string
      approvalId: string
      expectedVersion: number
      durableEventId: string
      codexTurnId: string | null
      decision: string
    },
  ) {
    return this.#transaction(input, async (client) => {
      await this.#folder(client, input, input.folderId, 'approval')
      const resolutionId = input.durableEventId
      const inserted = await client.query(
        `INSERT INTO persistent_codex.folder_approval_resolutions
         (tenant_id,organization_id,workspace_id,folder_id,principal_id,approval_id,approval_version,resolution_id,durable_event_id,codex_turn_id,decision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id,organization_id,workspace_id,approval_id,approval_version) DO NOTHING
         RETURNING resolution_id`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.folderId,
          input.principalId,
          input.approvalId,
          input.expectedVersion,
          resolutionId,
          input.durableEventId,
          input.codexTurnId,
          input.decision,
        ],
      )
      const current =
        inserted.rows[0] ??
        (
          await client.query(
            `SELECT resolution_id FROM persistent_codex.folder_approval_resolutions
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
             AND approval_id=$4 AND approval_version=$5`,
            [
              input.tenantId,
              input.organizationId,
              input.workspaceId,
              input.approvalId,
              input.expectedVersion,
            ],
          )
        ).rows[0]
      return {
        resolutionId: String(current.resolution_id),
        created: Boolean(inserted.rowCount),
      }
    })
  }

  async getApprovalResolution(identity: FolderIdentity, approvalId: string) {
    return this.#transaction(identity, async (client) => {
      const row = (
        await client.query(
          `SELECT resolution_id,folder_id FROM persistent_codex.folder_approval_resolutions WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND approval_id=$4 ORDER BY resolved_at DESC LIMIT 1`,
          [
            identity.tenantId,
            identity.organizationId,
            identity.workspaceId,
            approvalId,
          ],
        )
      ).rows[0]
      if (!row) return null
      await this.#folder(client, identity, String(row.folder_id), 'read')
      return { resolutionId: String(row.resolution_id) }
    })
  }

  async onAccessChanged(listener: (event: FolderAccessChanged) => void) {
    this.#listeners.add(listener)
    if (!this.#listenerClient) {
      const client = await this.pool.connect()
      client.on('notification', (notification) => {
        if (!notification.payload) return
        try {
          const event = JSON.parse(notification.payload) as FolderAccessChanged
          for (const current of this.#listeners) current(structuredClone(event))
        } catch {}
      })
      client.on('error', () => {
        if (this.#listenerClient === client) this.#listenerClient = null
      })
      await client.query('LISTEN persistent_folder_access_changed')
      this.#listenerClient = client
    }
    return () => this.#listeners.delete(listener)
  }

  async close() {
    if (this.#listenerClient) {
      await this.#listenerClient
        .query('UNLISTEN persistent_folder_access_changed')
        .catch(() => undefined)
      this.#listenerClient.release()
      this.#listenerClient = null
    }
    this.#listeners.clear()
    if (this.options.ownsPool) await this.pool.end()
  }
}

export const postgresFolderIdentity = (
  scope: FolderScope,
  principalId: string,
): FolderIdentity => ({ ...scope, principalId })

export function createPostgresSharedFolderRepository(connectionString: string) {
  return new PostgresSharedFolderRepository(
    new Pool({ connectionString, max: 8 }),
    {
      ownsPool: true,
    },
  )
}
