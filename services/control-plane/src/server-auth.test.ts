import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteEventStore } from '@persistent-codex/event-store'
import type {
  AuthPrincipal,
  OrganizationMembership,
  ServerMessage,
} from '@persistent-codex/control-plane-contracts'
import { serverMessageSchema } from '@persistent-codex/control-plane-contracts'
import type {
  AuthenticationAdapter,
  MembershipDirectory,
} from '@persistent-codex/authz'
import { AuthenticationError } from '@persistent-codex/authz'
import { afterEach, describe, expect, it } from 'vitest'
import { buildControlPlane, PUBLIC_ROUTE_AUTHORIZATION_CATALOG } from './server'

const issuer = 'https://issuer.test'
const principal: AuthPrincipal = {
  version: 1,
  kind: 'end_user',
  subject: 'user-a',
  issuer,
  audience: ['persistent-codex'],
  authenticatedAt: new Date(0).toISOString(),
  expiresAt: new Date(4_102_444_800_000).toISOString(),
  assurance: { level: 'mfa', mfa: true },
  memberships: [],
}

class FixedAuthentication implements AuthenticationAdapter {
  readonly value: AuthPrincipal
  constructor(value: AuthPrincipal = principal) {
    this.value = value
  }
  async authenticate(request: {
    authorization?: string
  }): Promise<AuthPrincipal> {
    if (request.authorization !== 'Bearer valid')
      throw new AuthenticationError('AUTH_REQUIRED')
    return this.value
  }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function setup(role: OrganizationMembership['role'] = 'developer') {
  const root = mkdtempSync(join(tmpdir(), 'wp18-auth-'))
  roots.push(root)
  const store = new SqliteEventStore(join(root, 'events.sqlite'))
  store.createSession({
    tenantId: 'org-a',
    workspaceId: 'wsp-a',
    sessionId: 'ses-a',
    status: 'active',
  })
  store.createSession({
    tenantId: 'org-b',
    workspaceId: 'wsp-b',
    sessionId: 'ses-b',
    status: 'active',
  })
  let status: OrganizationMembership['status'] = 'active'
  const directory: MembershipDirectory = {
    membershipsFor: () => [
      {
        version: 1,
        subject: 'user-a',
        issuer,
        organizationId: 'org-a',
        role,
        status,
        workspaceIds: ['wsp-a'],
        updatedAt: new Date().toISOString(),
      },
    ],
  }
  return {
    store,
    root,
    directory,
    revoke: () => {
      status = 'revoked'
    },
  }
}

describe('WP18 REST authorization boundary', () => {
  it('derives access from principal membership and rejects forged tenant/workspace scope', async () => {
    const fixture = setup()
    const app = await buildControlPlane({
      eventStore: fixture.store,
      artifactRoot: join(fixture.root, 'artifacts'),
      authenticationAdapter: new FixedAuthentication(),
      membershipDirectory: fixture.directory,
    })
    try {
      const own = await app.inject({
        method: 'GET',
        url: '/v1/sessions/ses-a',
        headers: {
          authorization: 'Bearer valid',
          'x-tenant-id': 'org-a',
          'x-workspace-id': 'wsp-a',
        },
      })
      expect(own.statusCode).toBe(200)

      const forged = await app.inject({
        method: 'GET',
        url: '/v1/sessions/ses-b',
        headers: {
          authorization: 'Bearer valid',
          'x-tenant-id': 'org-b',
          'x-workspace-id': 'wsp-b',
        },
      })
      expect(forged.statusCode).toBe(403)
      expect(forged.json()).toEqual({
        code: 'ACCESS_DENIED',
        message: 'Access is denied',
      })

      const guessed = await app.inject({
        method: 'GET',
        url: '/v1/sessions/ses-b',
        headers: {
          authorization: 'Bearer valid',
          'x-tenant-id': 'org-a',
          'x-workspace-id': 'wsp-a',
        },
      })
      expect(guessed.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('applies membership revocation immediately and keeps viewer mutations denied', async () => {
    const fixture = setup('viewer')
    const app = await buildControlPlane({
      eventStore: fixture.store,
      artifactRoot: join(fixture.root, 'artifacts'),
      authenticationAdapter: new FixedAuthentication(),
      membershipDirectory: fixture.directory,
    })
    const headers = {
      authorization: 'Bearer valid',
      'x-tenant-id': 'org-a',
      'x-workspace-id': 'wsp-a',
      'idempotency-key': 'turn-1',
    }
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/sessions/ses-a/turns',
            headers,
            payload: { prompt: 'denied' },
          })
        ).statusCode,
      ).toBe(403)
      fixture.revoke()
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/sessions/ses-a',
            headers,
          })
        ).statusCode,
      ).toBe(403)
    } finally {
      await app.close()
    }
  })

  it('rejects an end-user route authenticated as an internal service principal', async () => {
    const fixture = setup()
    const app = await buildControlPlane({
      eventStore: fixture.store,
      artifactRoot: join(fixture.root, 'artifacts'),
      authenticationAdapter: new FixedAuthentication({
        ...principal,
        kind: 'internal_service',
      }),
      membershipDirectory: fixture.directory,
    })
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/ses-a',
        headers: {
          authorization: 'Bearer valid',
          'x-tenant-id': 'org-a',
          'x-workspace-id': 'wsp-a',
        },
      })
      expect(response.statusCode).toBe(403)
    } finally {
      await app.close()
    }
  })

  it('rejects cross-tenant WebSocket subscribe before replay or ack state exists', async () => {
    const fixture = setup()
    const app = await buildControlPlane({
      eventStore: fixture.store,
      artifactRoot: join(fixture.root, 'artifacts'),
      authenticationAdapter: new FixedAuthentication(),
      membershipDirectory: fixture.directory,
    })
    interface TestSocket {
      send(data: string): void
      close(): void
      on(
        event: 'message',
        listener: (data: { toString(): string }) => void,
      ): void
    }
    try {
      await app.ready()
      const socket = (await app.injectWS(
        '/v1/realtime',
      )) as unknown as TestSocket
      const message = new Promise<ServerMessage>((resolve) => {
        socket.on('message', (data) =>
          resolve(serverMessageSchema.parse(JSON.parse(data.toString()))),
        )
      })
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          tenantId: 'org-b',
          workspaceId: 'wsp-b',
          sessionId: 'ses-b',
          afterSequence: 0,
          accessToken: 'valid',
        }),
      )
      await expect(message).resolves.toMatchObject({
        type: 'error',
        code: 'ACCESS_DENIED',
      })
      socket.close()
    } finally {
      await app.close()
    }
  })
})

describe('WP20 admin and support governance boundary', () => {
  const headers = {
    authorization: 'Bearer valid',
    'x-tenant-id': 'org-a',
    'x-workspace-id': 'wsp-a',
  }

  it('denies tenant content to normal admin and denies self-issued support grants', async () => {
    for (const role of ['admin', 'support'] as const) {
      const fixture = setup(role)
      const app = await buildControlPlane({
        eventStore: fixture.store,
        artifactRoot: join(fixture.root, 'artifacts'),
        authenticationAdapter: new FixedAuthentication(),
        membershipDirectory: fixture.directory,
      })
      try {
        expect(
          (
            await app.inject({
              method: 'GET',
              url: '/v1/sessions/ses-a/events',
              headers,
            })
          ).statusCode,
        ).toBe(403)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/sessions/ses-a/support-grants',
              headers: { ...headers, 'idempotency-key': `self-${role}` },
              payload: {
                actions: ['content.view'],
                reason: 'Self issued access must be rejected',
                supportPrincipalId: 'support-self',
                durationMinutes: 15,
              },
            })
          ).statusCode,
        ).toBe(403)
      } finally {
        await app.close()
      }
    }
  })

  it('lets an MFA tenant user create, inspect and revoke only a session-scoped grant', async () => {
    const fixture = setup('owner')
    const app = await buildControlPlane({
      eventStore: fixture.store,
      artifactRoot: join(fixture.root, 'artifacts'),
      authenticationAdapter: new FixedAuthentication(),
      membershipDirectory: fixture.directory,
    })
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/sessions/ses-a/support-grants',
        headers: { ...headers, 'idempotency-key': 'grant-create' },
        payload: {
          actions: ['content.view'],
          reason: 'User requested session-specific diagnosis',
          supportPrincipalId: 'support-principal-a',
          durationMinutes: 15,
        },
      })
      expect(created.statusCode, created.body).toBe(201)
      expect(created.json()).toMatchObject({
        sessionId: 'ses-a',
        status: 'pending_approval',
        requiredApprovals: 1,
      })
      const listed = await app.inject({
        method: 'GET',
        url: '/v1/sessions/ses-a/support-grants',
        headers,
      })
      expect(listed.json().grants).toHaveLength(1)
      const grant = created.json()
      const revoked = await app.inject({
        method: 'POST',
        url: `/v1/support-grants/${grant.grantId}/revoke`,
        headers: { ...headers, 'idempotency-key': 'grant-revoke' },
        payload: { expectedVersion: grant.version },
      })
      expect(revoked.json()).toMatchObject({ status: 'revoked', generation: 1 })
    } finally {
      await app.close()
    }
  })
})

describe('public route authorization coverage', () => {
  it('has a unique deny-by-default action for every protected route', () => {
    const keys = PUBLIC_ROUTE_AUTHORIZATION_CATALOG.map(
      (entry) => `${entry.method} ${entry.route}`,
    )
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toHaveLength(49)
    expect(
      PUBLIC_ROUTE_AUTHORIZATION_CATALOG.every(
        (entry) => entry.action && entry.resourceType,
      ),
    ).toBe(true)
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    const declared = [
      ...source.matchAll(
        /app\.(get|post|patch|delete)(?:<[\s\S]*?>)?\(\s*['"]([^'"]+)['"]/g,
      ),
    ].map((match) => `${match[1]!.toUpperCase()} ${match[2]!}`)
    const explicitlyPublic = new Set([
      'GET /healthz',
      'GET /v1/meta',
      'GET /v1/artifact-downloads/:token',
    ])
    expect(
      declared.filter((route) => !explicitlyPublic.has(route)).sort(),
    ).toEqual([...keys].sort())
  })
})
