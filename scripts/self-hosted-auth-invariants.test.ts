// Self-hosted account and passphrase-derived privacy invariant tests.
// (ADR-0037). Sandbox e2e kanıtı self-hosted-auth:privacy gate'indedir; burada allowlist
// ayrıştırma, deneme sınırlayıcı, token mint/doğrulama, auth API sözleşmesi
// ve içerik zarfı yardımcıları statik olarak doğrulanır.
import {
  createPrivateKey,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { selfHostedSessionTokensSchema } from '../packages/control-plane-contracts/src/index'
import {
  AuthAttemptLimiter,
  SelfHostedAuthService,
  mintRs256AccessToken,
  parseAllowedUsers,
} from '../services/control-plane/src/self-hosted-auth'
import {
  decryptUserContent,
  encryptUserContent,
  parseUserContentEnvelope,
} from '../services/control-plane/src/user-content-crypto'
import { provisionWorkspace } from '../services/control-plane/src/self-hosted-provisioning'
import {
  ContentKeyLeaseManager,
  generateContentKey,
} from '../packages/workspace-security/src/index'
import type pg from 'pg'

describe('self-hosted-auth allowlist ayrıştırma', () => {
  it('normalize eder, boşları atar ve tekilleştirir', () => {
    expect(parseAllowedUsers(' Alice, bob ,,ALICE,carol ')).toEqual([
      'alice',
      'bob',
      'carol',
    ])
    expect(parseAllowedUsers(undefined)).toEqual([])
    expect(parseAllowedUsers('')).toEqual([])
  })
})

describe('self-hosted-auth deneme sınırlayıcı', () => {
  it('pencere içinde eşiği uygular, pencere sonunda sıfırlar', () => {
    let now = 0
    const limiter = new AuthAttemptLimiter({
      limit: 3,
      windowMs: 1_000,
      now: () => now,
    })
    expect(limiter.allowed('u')).toBe(true)
    limiter.recordFailure('u')
    limiter.recordFailure('u')
    limiter.recordFailure('u')
    expect(limiter.allowed('u')).toBe(false)
    expect(limiter.allowed('other')).toBe(true)
    now += 1_001
    expect(limiter.allowed('u')).toBe(true)
    limiter.recordFailure('u')
    limiter.reset('u')
    expect(limiter.allowed('u')).toBe(true)
  })
})

describe('self-hosted-auth kayıt provisioning RLS kapsamı', () => {
  it('workspace insertinden önce transaction-local tenant kapsamını bağlar', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = []
    const client = {
      query: async (text: string, values: unknown[] = []) => {
        calls.push({ text, values })
        return { rowCount: 1, rows: [] }
      },
    } as unknown as pg.PoolClient

    await provisionWorkspace(client, {
      issuer: 'https://identity.test',
      subject: 'user:alice',
      organizationId: 'org_u_test',
      organizationName: 'Test organization',
      workspaceId: 'wsp_u_test',
      workspaceName: 'Test workspace',
    })

    expect(calls[0]?.text).toContain("set_config('app.tenant_id',$1,true)")
    expect(calls[0]?.text).toContain(
      "set_config('app.organization_id',$1,true)",
    )
    expect(calls[0]?.text).toContain("set_config('app.workspace_id',$2,true)")
    expect(calls[0]?.values).toEqual(['org_u_test', 'wsp_u_test'])
    expect(
      calls.findIndex(({ text }) =>
        text.includes('INSERT INTO persistent_codex.workspaces'),
      ),
    ).toBeGreaterThan(0)
  })
})

describe('self-hosted-auth access token mint', () => {
  it('identity issuer şekliyle RS256 imzalar; amr yalnız pwd', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const minted = mintRs256AccessToken({
      signingKey: createPrivateKey(
        privateKey.export({ type: 'pkcs8', format: 'pem' }),
      ),
      keyId: 'self-hosted',
      issuer: 'http://identity:3303',
      audience: 'persistent-codex-self-hosted',
      subject: 'user:alice',
      ttlSeconds: 3600,
      now: new Date('2026-07-28T00:00:00.000Z'),
    })
    const [header, payload, signature] = minted.token.split('.')
    expect(
      JSON.parse(Buffer.from(String(header), 'base64url').toString()),
    ).toEqual({ alg: 'RS256', kid: 'self-hosted', typ: 'JWT' })
    const claims = JSON.parse(
      Buffer.from(String(payload), 'base64url').toString(),
    ) as Record<string, unknown>
    expect(claims.iss).toBe('http://identity:3303')
    expect(claims.aud).toBe('persistent-codex-self-hosted')
    expect(claims.sub).toBe('user:alice')
    expect(claims.amr).toEqual(['pwd'])
    expect(claims.exp).toBe(Number(claims.iat) + 3600)
    expect(claims.auth_time).toBe(claims.iat)
    const verifier = createVerify('RSA-SHA256').update(`${header}.${payload}`)
    expect(
      verifier.verify(publicKey, Buffer.from(String(signature), 'base64url')),
    ).toBe(true)
    expect(minted.expiresAt.toISOString()).toBe('2026-07-28T01:00:00.000Z')
  })
})

describe('self-hosted-auth persistent refresh session', () => {
  it('rotates an active refresh token without assigning a new deadline', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const queries: Array<{ text: string; values: unknown[] }> = []
    const client = {
      query: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values })
        if (text.includes('SELECT t.user_id'))
          return {
            rowCount: 1,
            rows: [
              {
                user_id: 'usr_1',
                revoked_at: null,
                // Time no longer participates in refresh authorization.
                expires_at: '2020-01-01T00:00:00.000Z',
                username: 'alice',
                status: 'approved',
                organization_id: 'org_u_1',
                workspace_id: 'wsp_u_1',
                password_hash: 'unused',
                recovery_key_hash: 'unused',
              },
            ],
          }
        return { rowCount: 1, rows: [] }
      },
      release: () => undefined,
    } as unknown as pg.PoolClient
    const service = new SelfHostedAuthService({
      pool: {
        connect: async () => client,
      } as unknown as pg.Pool,
      databaseUrl: 'postgres://unused',
      allowedUsers: ['alice'],
      issuer: 'http://identity.test',
      audience: 'persistent-codex-self-hosted',
      signingKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      signingKeyId: 'self-hosted',
      leases: new ContentKeyLeaseManager({ ttlMs: 1_000 }),
      now: () => new Date('2026-08-02T00:00:00.000Z'),
    })

    const refreshed = await service.refresh({
      refreshToken: 'rt1_existing_refresh_token',
    })

    expect(
      selfHostedSessionTokensSchema.parse(refreshed.session),
    ).toMatchObject({
      refreshTokenExpiresAt: null,
    })
    const insert = queries.find(({ text }) =>
      text.includes('INSERT INTO persistent_codex.user_refresh_tokens'),
    )
    expect(insert?.values[3]).toBeNull()
  })

  it('revokes expired rows before making only valid sessions permanent', () => {
    const migration = readFileSync(
      new URL(
        '../infra/postgres/migrations/0043_non_expiring_self_hosted_sessions.sql',
        import.meta.url,
      ),
      'utf8',
    )
    const revokeExpired = migration.indexOf('AND expires_at <= now()')
    const dropNotNull = migration.indexOf(
      'ALTER COLUMN expires_at DROP NOT NULL',
    )
    const clearDeadline = migration.indexOf('SET expires_at = NULL')

    expect(revokeExpired).toBeGreaterThan(-1)
    expect(dropNotNull).toBeGreaterThan(revokeExpired)
    expect(clearDeadline).toBeGreaterThan(dropNotNull)
    expect(migration.slice(clearDeadline)).toContain('WHERE revoked_at IS NULL')
  })
})

describe('self-hosted-auth içerik zarfı yardımcıları', () => {
  const scope = {
    tenantId: 'org_u_1',
    organizationId: 'org_u_1',
    workspaceId: 'wsp_u_1',
  }

  it('düz metni zarflar, zarfı tanır ve yalnız doğru anahtarla çözer', async () => {
    const key = { contentKey: generateContentKey(), keyVersion: '1' }
    const context = {
      ...scope,
      recordType: 'prompt' as const,
      recordId: 'run_1',
    }
    const plaintext = new TextEncoder().encode('gizli self-hosted-auth mesajı')
    const bytes = await encryptUserContent(key, context, plaintext)
    expect(new TextDecoder().decode(bytes)).not.toContain(
      'gizli self-hosted-auth mesajı',
    )
    const envelope = parseUserContentEnvelope(bytes)
    expect(envelope).not.toBeNull()
    expect(envelope?.encryptedDek.provider).toBe('user-content-key')
    const decrypted = await decryptUserContent(key, context, envelope!)
    expect(new TextDecoder().decode(decrypted)).toBe(
      'gizli self-hosted-auth mesajı',
    )
    const wrongKey = { contentKey: generateContentKey(), keyVersion: '1' }
    await expect(
      decryptUserContent(wrongKey, context, envelope!),
    ).rejects.toThrowError()
  })

  it('düz metin ve rastgele JSON zarf sayılmaz', () => {
    expect(
      parseUserContentEnvelope(new TextEncoder().encode('düz metin')),
    ).toBeNull()
    expect(
      parseUserContentEnvelope(
        new TextEncoder().encode('{"formatVersion":1,"algorithm":"none"}'),
      ),
    ).toBeNull()
  })
})
