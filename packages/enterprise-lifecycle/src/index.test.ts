import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  advanceDeletion,
  assertLifecyclePrivilege,
  assertLoginPolicy,
  assertResidency,
  authorizeTransfer,
  buildEncryptedExport,
  decryptExport,
  mapGroupsToRoles,
  planDeprovision,
  retentionDecision,
  ScimDirectory,
  TenantKeyAuthority,
  validateOidcAssertion,
  validateSamlResponse,
} from './index'
import type {
  DeletionJob,
  FederationConfiguration,
  LegalHold,
  ResidencyPolicy,
} from './contracts'

const at = '2026-07-20T10:00:00.000Z'
const scope = { tenantId: 'tenant-a', organizationId: 'org-a' }
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
const config: FederationConfiguration = {
  schemaVersion: 1,
  ...scope,
  configurationId: 'fed-1',
  protocol: 'oidc',
  issuer: 'https://idp.test',
  entityId: null,
  audience: 'persistent-codex',
  callbackUrl: 'https://app.test/callback',
  acsUrl: null,
  keyId: 'key-1',
  verificationKeyPem: publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString(),
  clockSkewSeconds: 30,
  enforcedSso: true,
  requiredMfa: true,
  allowedAmr: ['mfa', 'webauthn'],
  metadataVersion: 1,
  enabled: true,
  updatedAt: at,
}
const jwt = (claims: Record<string, unknown>) => {
  const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'key-1' }),
    ).toString('base64url'),
    body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${body}.${sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`
}

describe('enterprise federation', () => {
  it('validates authority, signature, MFA and replay fail-closed', () => {
    const seen = new Set<string>(),
      consume = (d: string) => !seen.has(d) && (seen.add(d), true)
    const token = jwt({
      iss: config.issuer,
      aud: config.audience,
      sub: 'opaque-user',
      iat: 1753005590,
      exp: 1753005700,
      jti: 'jti-1',
      amr: ['webauthn'],
    })
    expect(
      validateOidcAssertion({
        token,
        configuration: config,
        now: new Date('2025-07-20T10:00:00Z'),
        consumeReplay: consume,
      }).subject,
    ).toBe('opaque-user')
    expect(() =>
      validateOidcAssertion({
        token,
        configuration: config,
        now: new Date('2025-07-20T10:00:00Z'),
        consumeReplay: consume,
      }),
    ).toThrow('OIDC_REPLAY')
    expect(() =>
      assertLoginPolicy({
        enforcedSso: true,
        method: 'password',
        strongMfa: false,
        separateCredential: false,
      }),
    ).toThrow('LOCAL_LOGIN_DISABLED')
    expect(() =>
      assertLoginPolicy({
        enforcedSso: true,
        method: 'emergency',
        strongMfa: false,
        separateCredential: true,
      }),
    ).toThrow('BREAK_GLASS_REQUIREMENTS')
  })
  it('requires a signed, unexpired SAML response with matching audience', () => {
    const base =
      '<Response><Issuer>https://idp.test</Issuer><Audience>persistent-codex</Audience><AssertionID>a1</AssertionID><NotOnOrAfter>2026-07-20T10:05:00.000Z</NotOnOrAfter><NameID>opaque</NameID><Signature><SignatureValue></SignatureValue></Signature></Response>'
    const signature = sign(
        'RSA-SHA256',
        Buffer.from(base),
        privateKey,
      ).toString('base64'),
      xml = base.replace(
        '<SignatureValue></SignatureValue>',
        `<SignatureValue>${signature}</SignatureValue>`,
      )
    const saml = { ...config, protocol: 'saml' as const }
    expect(
      validateSamlResponse({
        xml,
        configuration: saml,
        now: new Date(at),
        consumeReplay: () => true,
      }).subject,
    ).toBe('opaque')
    expect(() =>
      validateSamlResponse({
        xml: xml.replace(
          '<Audience>persistent-codex</Audience>',
          '<Audience>other</Audience>',
        ),
        configuration: saml,
        now: new Date(at),
        consumeReplay: () => true,
      }),
    ).toThrow('SAML_AUTHORITY_MISMATCH')
  })
})

describe('SCIM lifecycle', () => {
  it('makes duplicate/out-of-order events idempotent and mappings tenant scoped', () => {
    const scim = new ScimDirectory(),
      common = {
        ...scope,
        resourceType: 'User' as const,
        resourceId: 'u1',
        externalId: 'e1',
        providerId: 'idp',
        displayName: 'Opaque user',
        members: [],
      }
    const current = scim.upsert({
      ...common,
      providerVersion: 2,
      active: false,
      idempotencyKey: 'k2',
      updatedAt: at,
    })
    expect(
      scim.upsert({
        ...common,
        providerVersion: 1,
        active: true,
        idempotencyKey: 'k1',
        updatedAt: at,
      }),
    ).toEqual(current)
    expect(
      scim.upsert({
        ...common,
        providerVersion: 2,
        active: true,
        idempotencyKey: 'k2',
        updatedAt: at,
      }),
    ).toEqual(current)
    const group = scim.upsert({
      ...scope,
      resourceType: 'Group',
      resourceId: 'g1',
      externalId: 'admins',
      providerId: 'idp',
      providerVersion: 1,
      active: true,
      displayName: 'Admins',
      members: ['u1'],
      idempotencyKey: 'g1',
      updatedAt: at,
    })
    expect(
      mapGroupsToRoles([group], { admins: 'tenant_admin' }, 'tenant-a'),
    ).toEqual(['tenant_admin'])
    expect(
      mapGroupsToRoles([group], { admins: 'tenant_admin' }, 'tenant-b'),
    ).toEqual([])
    expect(planDeprovision()).toContain('turns')
    expect(planDeprovision()).toContain('authorization_cache')
  })
})

describe('retention/export/delete/residency', () => {
  it('gives legal hold and statutory retention explicit precedence', () => {
    const hold: LegalHold = {
      schemaVersion: 1,
      ...scope,
      holdId: 'h1',
      objectClasses: ['artifact'],
      reasonCode: 'LITIGATION',
      actorRole: 'legal_officer',
      state: 'active',
      startsAt: at,
      expiresAt: '2026-08-20T10:00:00.000Z',
      version: 1,
    }
    expect(
      retentionDecision({
        objectClass: 'artifact',
        createdAt: new Date('2025-01-01'),
        now: new Date(at),
        policyDays: 30,
        policyEffectiveAt: new Date('2026-01-01'),
        holds: [hold],
      }).reason,
    ).toBe('LEGAL_HOLD')
    expect(
      retentionDecision({
        objectClass: 'usage_billing',
        createdAt: new Date('2026-01-01'),
        now: new Date(at),
        policyDays: 30,
        statutoryMinimumDays: 400,
        policyEffectiveAt: new Date('2026-01-01'),
        holds: [],
      }).delete,
    ).toBe(false)
  })
  it('exports only one tenant with a verifiable encrypted manifest', () => {
    const key = randomBytes(32),
      result = buildEncryptedExport({
        ...scope,
        jobId: 'job-1',
        workspaceIds: ['w1'],
        watermark: '42',
        objects: [
          {
            tenantId: 'tenant-a',
            objectId: 'o1',
            objectClass: 'artifact',
            body: Buffer.from('tenant payload'),
            keyVersion: 2,
          },
        ],
        key,
        createdAt: new Date(at),
      })
    expect(result.manifest.objects[0]?.byteLength).toBe(14)
    const payload = JSON.parse(
      decryptExport(result.archive, key, 'tenant-a', 'job-1').toString(),
    ) as Array<{ body: string }>
    expect(Buffer.from(payload[0]!.body, 'base64').toString()).toBe(
      'tenant payload',
    )
    expect(() =>
      decryptExport(result.archive, key, 'tenant-b', 'job-1'),
    ).toThrow()
    expect(() =>
      buildEncryptedExport({
        ...scope,
        jobId: 'bad',
        workspaceIds: [],
        watermark: '1',
        objects: [
          {
            tenantId: 'tenant-b',
            objectId: 'x',
            objectClass: 'source',
            body: Buffer.from('x'),
            keyVersion: 1,
          },
        ],
        key,
      }),
    ).toThrow('CROSS_TENANT_EXPORT')
  })
  it('blocks delete on hold, completes after expiry, and rejects forbidden regions', () => {
    let job: DeletionJob = {
      schemaVersion: 1,
      ...scope,
      jobId: 'd1',
      state: 'running',
      currentStep: 'object_delete',
      completedSteps: ['access_revoke'],
      remainingClasses: [],
      idempotencyKey: 'idem',
      version: 1,
      keyVersion: 3,
    }
    const hold: LegalHold = {
      schemaVersion: 1,
      ...scope,
      holdId: 'h1',
      objectClasses: ['backup'],
      reasonCode: 'LEGAL',
      actorRole: 'legal_officer',
      state: 'active',
      startsAt: at,
      expiresAt: '2026-08-01T00:00:00Z',
      version: 1,
    }
    job = advanceDeletion(job, [hold], new Date(at))
    expect(job.state).toBe('blocked_by_hold')
    expect(job.remainingClasses[0]?.reasonCode).toBe('LEGAL_HOLD')
    job = { ...job, state: 'running' }
    for (let i = 0; i < 12 && job.state !== 'complete'; i++)
      job = advanceDeletion(job, [hold], new Date('2026-09-01'))
    expect(job.state).toBe('complete')
    expect(job.completedSteps).toContain('kms_crypto_erasure')
    const policy: ResidencyPolicy = {
      schemaVersion: 1,
      ...scope,
      policyId: 'r1',
      policyVersion: 1,
      allowedRegions: ['eu-1'],
      primaryRegion: 'eu-1',
      crossRegionTransfers: [],
      effectiveAt: at,
    }
    expect(() =>
      assertResidency(policy, {
        region: 'us-1',
        kind: 'restore' as 'placement',
      }),
    ).toThrow('RESIDENCY_RESTORE_DENIED')
    expect(() =>
      authorizeTransfer(policy, {
        sourceRegion: 'eu-1',
        destinationRegion: 'us-1',
        objectClass: 'backup',
        approvalId: 'a1',
      }),
    ).toThrow('CROSS_REGION_TRANSFER_DENIED')
    expect(() => assertLifecyclePrivilege(['support_agent'], 'export')).toThrow(
      'LIFECYCLE_PRIVILEGE_DENIED',
    )
    const keys = new TenantKeyAuthority()
    keys.put('tenant-a', 3, Buffer.alloc(32, 7))
    expect(keys.unwrap('tenant-a', 3)).toHaveLength(32)
    keys.cryptoErase('tenant-a', 3)
    expect(() => keys.unwrap('tenant-a', 3)).toThrow('KMS_KEY_UNAVAILABLE')
  })
})
