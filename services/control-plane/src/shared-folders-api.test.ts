import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AuthPrincipal,
  OrganizationMembership,
} from '@perseverance/control-plane-contracts'
import type {
  AuthenticationAdapter,
  MembershipDirectory,
} from '@perseverance/authz'
import { AuthenticationError } from '@perseverance/authz'
import { InMemorySharedFolderRepository } from '@perseverance/shared-folders'
import { afterEach, describe, expect, it } from 'vitest'
import { buildControlPlane } from './server'

const issuer = 'https://fixture.test'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

class PrincipalAuthentication implements AuthenticationAdapter {
  async authenticate(request: {
    authorization?: string
  }): Promise<AuthPrincipal> {
    const subject = request.authorization?.match(
      /^Bearer (owner|friend|outsider)$/,
    )?.[1]
    if (!subject) throw new AuthenticationError('AUTH_REQUIRED')
    return {
      version: 1,
      kind: 'end_user',
      subject,
      issuer,
      audience: ['persistent-codex'],
      authenticatedAt: new Date(0).toISOString(),
      expiresAt: new Date('2099-01-01T00:00:00.000Z').toISOString(),
      assurance: { level: 'mfa', mfa: true },
      memberships: [],
    }
  }
}

const directory: MembershipDirectory = {
  membershipsFor(subject) {
    return [
      {
        version: 1,
        subject,
        issuer,
        organizationId: 'org-a',
        role: 'developer',
        status: 'active',
        workspaceIds: ['wsp-a'],
        updatedAt: new Date(0).toISOString(),
      } satisfies OrganizationMembership,
    ]
  },
}

const headers = (principal: 'owner' | 'friend' | 'outsider') => ({
  authorization: `Bearer ${principal}`,
  'x-tenant-id': 'org-a',
  'x-workspace-id': 'wsp-a',
  'content-type': 'application/json',
})

describe('shared folder REST boundary', () => {
  it('shares only the invited folder and applies role/revoke changes fail-closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fixture-api-'))
    roots.push(root)
    const repository = new InMemorySharedFolderRepository()
    const app = await buildControlPlane({
      databasePath: join(root, 'events.sqlite'),
      artifactRoot: join(root, 'artifacts'),
      authenticationAdapter: new PrincipalAuthentication(),
      membershipDirectory: directory,
      sharedFolderRepository: repository,
    })
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/folders',
        headers: headers('owner'),
        payload: { schemaVersion: 1, name: 'Shared' },
      })
      expect(created.statusCode).toBe(201)
      const folderId = created.json().folder.folderId as string
      const privateFolder = await app.inject({
        method: 'POST',
        url: '/v1/folders',
        headers: headers('owner'),
        payload: { schemaVersion: 1, name: 'Private sibling' },
      })
      expect(privateFolder.statusCode).toBe(201)
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/folders',
            headers: headers('friend'),
          })
        ).json(),
      ).toEqual({ folders: [] })

      const invite = await app.inject({
        method: 'POST',
        url: `/v1/folders/${folderId}/invitations`,
        headers: headers('owner'),
        payload: { schemaVersion: 1, role: 'viewer', expiresInSeconds: 600 },
      })
      expect(invite.statusCode).toBe(201)
      const token = invite.json().token as string
      expect(JSON.stringify(invite.json().invitation)).not.toContain(token)
      const accepted = await app.inject({
        method: 'POST',
        url: '/v1/folder-invitations/accept',
        headers: headers('friend'),
        payload: { schemaVersion: 1, token },
      })
      expect(accepted.statusCode).toBe(200)
      expect(accepted.json().membership.role).toBe('viewer')
      const visible = await app.inject({
        method: 'GET',
        url: '/v1/folders',
        headers: headers('friend'),
      })
      expect(
        visible
          .json()
          .folders.map(
            (entry: { folder: { folderId: string } }) => entry.folder.folderId,
          ),
      ).toEqual([folderId])

      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/folders/${folderId}/invitations`,
            headers: headers('friend'),
            payload: {
              schemaVersion: 1,
              role: 'viewer',
              expiresInSeconds: 600,
            },
          })
        ).statusCode,
      ).toBe(403)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/folder-invitations/accept',
            headers: headers('outsider'),
            payload: { schemaVersion: 1, token },
          })
        ).statusCode,
      ).toBe(403)

      const member = accepted.json().membership as {
        principalId: string
        version: number
      }
      const promoted = await app.inject({
        method: 'PATCH',
        url: `/v1/folders/${folderId}/members/${encodeURIComponent(member.principalId)}`,
        headers: headers('owner'),
        payload: {
          schemaVersion: 1,
          role: 'editor',
          expectedVersion: member.version,
        },
      })
      expect(promoted.statusCode).toBe(200)
      expect(promoted.json().role).toBe('editor')
      const revoked = await app.inject({
        method: 'DELETE',
        url: `/v1/folders/${folderId}/members/${encodeURIComponent(member.principalId)}`,
        headers: headers('owner'),
        payload: { schemaVersion: 1, expectedVersion: promoted.json().version },
      })
      expect(revoked.statusCode).toBe(200)
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/folders',
            headers: headers('friend'),
          })
        ).json(),
      ).toEqual({ folders: [] })
    } finally {
      await app.close()
    }
  })
})
