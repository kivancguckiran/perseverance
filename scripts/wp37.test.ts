// WP37 — kullanıcı hesapları ve parola-türevli mahremiyet birim testleri
// (ADR-0037). Sandbox e2e kanıtı wp37:privacy gate'indedir; burada allowlist
// ayrıştırma, deneme sınırlayıcı, token mint/doğrulama, auth API sözleşmesi
// ve içerik zarfı yardımcıları statik olarak doğrulanır.
import {
  createPrivateKey,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AuthAttemptLimiter,
  mintRs256AccessToken,
  parseAllowedUsers,
} from '../services/control-plane/src/self-hosted-auth'
import {
  decryptUserContent,
  encryptUserContent,
  parseUserContentEnvelope,
} from '../services/control-plane/src/user-content-crypto'
import { provisionWorkspace } from '../services/control-plane/src/self-hosted-provisioning'
import { generateContentKey } from '../packages/workspace-security/src/index'
import type pg from 'pg'

describe('wp37 allowlist ayrıştırma', () => {
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

describe('wp37 deneme sınırlayıcı', () => {
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

describe('wp37 kayıt provisioning RLS kapsamı', () => {
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

describe('wp37 access token mint', () => {
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

describe('wp37 içerik zarfı yardımcıları', () => {
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
    const plaintext = new TextEncoder().encode('gizli wp37 mesajı')
    const bytes = await encryptUserContent(key, context, plaintext)
    expect(new TextDecoder().decode(bytes)).not.toContain('gizli wp37 mesajı')
    const envelope = parseUserContentEnvelope(bytes)
    expect(envelope).not.toBeNull()
    expect(envelope?.encryptedDek.provider).toBe('user-content-key')
    const decrypted = await decryptUserContent(key, context, envelope!)
    expect(new TextDecoder().decode(decrypted)).toBe('gizli wp37 mesajı')
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
