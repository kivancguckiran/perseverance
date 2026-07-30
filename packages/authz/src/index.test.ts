import {
  createHmac,
  generateKeyPairSync,
  sign,
  type JsonWebKey,
} from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  OidcAuthenticationAdapter,
  CorpusWorkloadCredentialAuthority,
  StaticMembershipDirectory,
  authorize,
} from './index'

const issuer = 'https://issuer.test'
const audience = 'persistent-codex'
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKey = pair.privateKey
const publicJwk = pair.publicKey.export({ format: 'jwk' }) as JsonWebKey
publicJwk.kid = 'key-1'
publicJwk.alg = 'RS256'
publicJwk.use = 'sig'

function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  signingKey = privateKey,
) {
  const now = Math.floor(Date.now() / 1000)
  const encodedHeader = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'key-1', ...header }),
  ).toString('base64url')
  const encodedClaims = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: 'user-1',
      iat: now - 1,
      auth_time: now - 1,
      nbf: now - 1,
      exp: now + 300,
      amr: ['pwd', 'mfa'],
      ...claims,
    }),
  ).toString('base64url')
  return `${encodedHeader}.${encodedClaims}.${sign(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    signingKey,
  ).toString('base64url')}`
}

function fixture(options: { keys?: JsonWebKey[] } = {}) {
  let calls = 0
  const fetcher: typeof fetch = async (input) => {
    calls++
    const url = String(input)
    if (url.endsWith('/.well-known/openid-configuration'))
      return new Response(
        JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }),
        { status: 200 },
      )
    if (url === `${issuer}/jwks`)
      return new Response(
        JSON.stringify({ keys: options.keys ?? [publicJwk] }),
        { status: 200 },
      )
    return new Response('not found', { status: 404 })
  }
  return {
    adapter: new OidcAuthenticationAdapter({
      issuer,
      audience,
      fetcher,
      jwksTtlMs: 1_000,
      maxJwksKeys: 2,
    }),
    calls: () => calls,
  }
}

describe('OIDC authentication', () => {
  it('verifies issuer, audience, signature, lifetime, assurance and bounded JWKS cache', async () => {
    const test = fixture()
    const now = new Date()
    const principal = await test.adapter.authenticate({
      authorization: `Bearer ${token()}`,
      headers: {},
      now,
    })
    expect(principal).toMatchObject({
      subject: 'user-1',
      issuer,
      assurance: { mfa: true },
      memberships: [],
    })
    await test.adapter.authenticate({
      authorization: `Bearer ${token()}`,
      headers: {},
      now,
    })
    expect(test.calls()).toBe(2)
  })

  it.each([
    ['alg none', token({}, { alg: 'none' }), 'TOKEN_ALGORITHM_REJECTED'],
    [
      'wrong issuer',
      token({ iss: 'https://evil.test' }),
      'TOKEN_ISSUER_INVALID',
    ],
    ['wrong audience', token({ aud: 'other' }), 'TOKEN_AUDIENCE_INVALID'],
    ['expired', token({ exp: 1 }), 'TOKEN_EXPIRED'],
    ['future nbf', token({ nbf: 4_102_444_800 }), 'TOKEN_NOT_ACTIVE'],
    [
      'future auth',
      token({ auth_time: 4_102_444_800 }),
      'TOKEN_AUTH_TIME_INVALID',
    ],
  ])('rejects %s tokens', async (_name, value, code) => {
    await expect(
      fixture().adapter.authenticate({
        authorization: `Bearer ${value}`,
        headers: {},
      }),
    ).rejects.toMatchObject({ code })
  })

  it('rejects invalid signatures and unknown keys without fail-open', async () => {
    const changed = `${token().slice(0, -2)}aa`
    await expect(
      fixture().adapter.authenticate({
        authorization: `Bearer ${changed}`,
        headers: {},
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_SIGNATURE_INVALID' })
    await expect(
      fixture({ keys: [{ ...publicJwk, kid: 'other' }] }).adapter.authenticate({
        authorization: `Bearer ${token()}`,
        headers: {},
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_KEY_UNKNOWN' })
  })

  it('refreshes JWKS for key rotation and after cache expiry', async () => {
    const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const rotatedJwk = rotated.publicKey.export({ format: 'jwk' }) as JsonWebKey
    rotatedJwk.kid = 'key-2'
    rotatedJwk.alg = 'RS256'
    rotatedJwk.use = 'sig'
    let keys: JsonWebKey[] = [publicJwk]
    let calls = 0
    const fetcher: typeof fetch = async (input) => {
      calls++
      if (String(input).endsWith('/.well-known/openid-configuration'))
        return new Response(
          JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }),
        )
      return new Response(JSON.stringify({ keys }))
    }
    const adapter = new OidcAuthenticationAdapter({
      issuer,
      audience,
      fetcher,
      jwksTtlMs: 1_000,
    })
    const now = new Date()
    await adapter.authenticate({
      authorization: `Bearer ${token()}`,
      headers: {},
      now,
    })
    keys = [rotatedJwk]
    await adapter.authenticate({
      authorization: `Bearer ${token(
        {},
        { kid: 'key-2' },
        rotated.privateKey,
      )}`,
      headers: {},
      now,
    })
    expect(calls).toBe(4)
    await adapter.authenticate({
      authorization: `Bearer ${token(
        { exp: Math.floor(now.getTime() / 1000) + 300 },
        { kid: 'key-2' },
        rotated.privateKey,
      )}`,
      headers: {},
      now: new Date(now.getTime() + 2_000),
    })
    expect(calls).toBe(6)
  })
})

describe('authorization policy', () => {
  const principal = {
    version: 1 as const,
    kind: 'end_user' as const,
    subject: 'user-1',
    issuer,
    audience: [audience],
    authenticatedAt: new Date(0).toISOString(),
    expiresAt: new Date(4_102_444_800_000).toISOString(),
    assurance: { level: 'mfa', mfa: true },
    memberships: [],
  }
  const membership = {
    version: 1 as const,
    subject: 'user-1',
    issuer,
    organizationId: 'org-a',
    role: 'developer' as const,
    status: 'active' as const,
    workspaceIds: ['wsp-a'],
    updatedAt: new Date(0).toISOString(),
  }

  it('allows role actions and denies unknown action, inactive membership and cross-workspace scope', () => {
    const directory = new StaticMembershipDirectory([membership])
    const memberships = directory.membershipsFor('user-1', issuer)
    expect(
      authorize({
        principal,
        action: 'turn.start',
        memberships,
        resource: {
          organizationId: 'org-a',
          workspaceId: 'wsp-a',
          resourceType: 'turn',
        },
      }),
    ).toMatchObject({ allow: true, reasonCode: 'ROLE_ALLOWED' })
    expect(
      authorize({
        principal,
        action: 'not.catalogued',
        memberships,
        resource: { organizationId: 'org-a', resourceType: 'unknown' },
      }),
    ).toMatchObject({ allow: false, reasonCode: 'UNKNOWN_ACTION' })
    expect(
      authorize({
        principal,
        action: 'session.read',
        memberships,
        resource: {
          organizationId: 'org-a',
          workspaceId: 'wsp-b',
          resourceType: 'session',
        },
      }),
    ).toMatchObject({
      allow: false,
      reasonCode: 'WORKSPACE_MEMBERSHIP_MISSING',
    })
    expect(
      authorize({
        principal,
        action: 'session.read',
        memberships: [{ ...membership, status: 'revoked' }],
        resource: { organizationId: 'org-a', resourceType: 'session' },
      }),
    ).toMatchObject({ allow: false, reasonCode: 'MEMBERSHIP_INACTIVE' })
  })
})

describe('corpus workload credentials', () => {
  it('binds audience, action and workspace, rejects replay/substitution, expiry and revoke', () => {
    const authority = new CorpusWorkloadCredentialAuthority({
      signingKey: Buffer.alloc(32, 7),
    })
    const now = new Date('2026-07-18T10:00:00.000Z')
    const credential = authority.issue({
      tenantId: 'tenant-a',
      organizationId: 'tenant-a',
      workspaceId: 'workspace-a',
      ttlMs: 60_000,
      now,
    })
    const request = (overrides: Record<string, unknown> = {}) => {
      const timestamp = String(now.getTime())
      const nonce = String(overrides.nonce ?? 'nonce-a')
      const action = (overrides.action ?? 'source.search') as 'source.search'
      const signature = createHmac('sha256', credential.proofKey)
        .update([credential.accessToken, timestamp, nonce, action].join('\n'))
        .digest('base64url')
      return {
        authorization: `Bearer ${credential.accessToken}`,
        proof: `${credential.proofKey}.${signature}`,
        timestamp,
        nonce,
        action,
        tenantId: 'tenant-a',
        organizationId: 'tenant-a',
        workspaceId: 'workspace-a',
        now,
        ...overrides,
      }
    }
    expect(authority.verify(request()).kind).toBe('internal_service')
    expect(() => authority.verify(request())).toThrow(/Authentication failed/)
    expect(() =>
      authority.verify(
        request({ nonce: 'nonce-b', workspaceId: 'workspace-b' }),
      ),
    ).toThrow(/Authentication failed/)
    expect(() =>
      authority.verify(
        request({ nonce: 'nonce-tenant', tenantId: 'tenant-b' }),
      ),
    ).toThrow(/Authentication failed/)
    expect(() =>
      authority.verify({
        ...request({ nonce: 'nonce-action', action: 'turn.start' }),
        action: 'turn.start' as never,
      }),
    ).toThrow(/Authentication failed/)
    const wrongAudience = new CorpusWorkloadCredentialAuthority({
      signingKey: Buffer.alloc(32, 7),
      audience: 'urn:perseverance:wrong-audience',
    })
    expect(() =>
      wrongAudience.verify(request({ nonce: 'nonce-audience' })),
    ).toThrow(/Authentication failed/)
    expect(() =>
      authority.verify({
        ...request({ nonce: 'nonce-c' }),
        proof: `substituted.${'x'.repeat(43)}`,
      }),
    ).toThrow(/Authentication failed/)
    expect(() =>
      authority.verify(
        request({ nonce: 'nonce-d', now: new Date(now.getTime() + 61_000) }),
      ),
    ).toThrow(/Authentication failed/)
    authority.revoke(credential.credentialId)
    expect(() => authority.verify(request({ nonce: 'nonce-e' }))).toThrow(
      /Authentication failed/,
    )
  })
})
