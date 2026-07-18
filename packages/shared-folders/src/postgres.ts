import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import type {
  FolderInvitation,
  FolderMembership,
  FolderRole,
  SharedFolder,
} from '@persistent-codex/control-plane-contracts'
import type { FolderIdentity, FolderScope } from './index'
import { SharedFolderError } from './index'

type Row = Record<string, unknown>
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value)
const nullableIso = (value: unknown) => (value == null ? null : iso(value))
const digestBuffer = (token: string) =>
  createHash('sha256').update(token).digest()

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

export class PostgresSharedFolderRepository {
  readonly adapter = 'postgresql' as const
  readonly version = 1 as const
  readonly pool: Pool
  readonly options: { ownsPool?: boolean }

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
      throw error
    } finally {
      client.release()
    }
  }

  async createFolder(input: FolderIdentity & { name: string }) {
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
          input.name.trim(),
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
      const result = await client.query(
        `SELECT * FROM persistent_codex.folders
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND folder_id=$4`,
        [input.tenantId, input.organizationId, input.workspaceId, folderId],
      )
      const members = await client.query(
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
      return {
        folder: folder(result.rows[0] as Row),
        membership: membership(members.rows[0] as Row),
      }
    })
  }

  async listFolders(identity: FolderIdentity) {
    return this.#transaction(identity, async (client) => {
      const result = await client.query(
        `SELECT f.*,m.role,m.status,m.version AS membership_version,
                m.accepted_invitation_id,m.revoked_at,
                m.created_at AS membership_created_at,m.updated_at AS membership_updated_at
         FROM persistent_codex.folders f
         JOIN persistent_codex.folder_memberships m USING
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

  async createInvitation(
    input: FolderIdentity & {
      folderId: string
      role: 'editor' | 'viewer'
      expiresInSeconds: number
    },
  ) {
    const token = randomBytes(32).toString('base64url')
    return this.#transaction(input, async (client) => {
      const invitationId = `inv_${randomUUID()}`
      const result = await client.query(
        `INSERT INTO persistent_codex.folder_invitations
          (tenant_id,organization_id,workspace_id,folder_id,invitation_id,principal_id,
           token_digest,invited_by_principal_id,role,expires_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$6,$8,
                now()+make_interval(secs => $9::double precision)
         WHERE persistent_codex.folder_role($1,$2,$3,$4,$6)='owner'
         RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.folderId,
          invitationId,
          input.principalId,
          digestBuffer(token),
          input.role,
          input.expiresInSeconds,
        ],
      )
      if (!result.rowCount) throw new SharedFolderError('FOLDER_ACCESS_DENIED')
      return { invitation: invitation(result.rows[0] as Row), token }
    })
  }

  async acceptInvitation(input: FolderIdentity & { token: string }) {
    return this.#transaction(input, async (client) => {
      const accepted = await client.query(
        `SELECT * FROM persistent_codex.accept_folder_invitation($1,$2,now())`,
        [digestBuffer(input.token), input.principalId],
      )
      if (!accepted.rowCount) throw new SharedFolderError('INVITATION_INVALID')
      const value = accepted.rows[0] as Row
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

  async close() {
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
    { ownsPool: true },
  )
}
