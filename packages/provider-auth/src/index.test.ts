import { describe, expect, it } from 'vitest'
import {
  LocalKmsProvider,
  EnvelopeEncryption,
} from '@perseverance/workspace-security'
import { RuntimeDataPlaneAuthority } from '@perseverance/tenant-runtime'
import {
  DurableOAuthCoordinator,
  InMemoryProviderAuthRepository,
  ProviderAuthError,
  ProviderAuthKillSwitch,
  ProviderCredentialVault,
  ProviderUsageLedger,
  StaticProviderAuthCapabilitySource,
  assertProviderAuthCapability,
  decideProviderAuthCapability,
  redactProviderAuthSurface,
  type ProviderAuthFeatureFlags,
  type ProviderAuthScope,
} from './index'

const scope: ProviderAuthScope = {
  tenantId: 'tenant-a',
  organizationId: 'tenant-a',
  workspaceId: 'workspace-a',
}
const otherScope: ProviderAuthScope = {
  tenantId: 'tenant-b',
  organizationId: 'tenant-b',
  workspaceId: 'workspace-b',
}
const flags: ProviderAuthFeatureFlags = {
  'codex:subscription-oauth': true,
  'codex:customer-api-key': true,
  'codex:platform-credit': true,
  'codex:local-cli-credential': true,
  'claude:subscription-oauth': true,
  'claude:customer-api-key': true,
  'claude:platform-credit': true,
  'claude:local-cli-credential': true,
  'gemini:subscription-oauth': true,
  'gemini:customer-api-key': true,
  'gemini:platform-credit': true,
  'gemini:local-cli-credential': true,
}
const evidence = (
  kind:
    | 'third-party-application-approval'
    | 'previously-approved'
    | 'customer-key-custody',
) => ({
  evidenceVersion: 7,
  kind,
  uri: 'https://provider.example.test/evidence/approved',
  sha256: 'a'.repeat(64),
  observedAt: '2026-07-20T00:00:00.000Z',
  effectiveAt: '2026-07-20T00:00:00.000Z',
})

describe('provider auth capability contract', () => {
  it('provider × authMode × deploymentProfile matrisinin 48 kararını deterministik çözer', () => {
    const providers = ['codex', 'claude', 'gemini', 'cursor'] as const
    const authModes = [
      'subscription-oauth',
      'customer-api-key',
      'platform-credit',
      'local-cli-credential',
    ] as const
    const profiles = ['local', 'self-hosted', 'cloud'] as const
    const decisions = providers.flatMap((provider) =>
      authModes.flatMap((authMode) =>
        profiles.map((deploymentProfile) =>
          decideProviderAuthCapability({
            provider,
            authMode,
            deploymentProfile,
            evidenceVersion: 0,
            featureFlags: {},
          }),
        ),
      ),
    )
    expect(decisions).toHaveLength(48)
    expect(decisions.every((entry) => entry.outcome === 'deny')).toBe(true)
  })

  it('Gemini consumer subscription OAuth flag/evidence olsa da unsupported kalır', () => {
    const result = decideProviderAuthCapability({
      provider: 'gemini',
      authMode: 'subscription-oauth',
      deploymentProfile: 'cloud',
      evidenceVersion: 7,
      evidence: evidence('third-party-application-approval'),
      featureFlags: flags,
    })
    expect(result).toMatchObject({
      outcome: 'deny',
      reasonCode: 'GEMINI_CONSUMER_SUBSCRIPTION_OAUTH_UNSUPPORTED',
    })
  })

  it('Codex managed subscription tarihli ve sürümü eşleşen evidence olmadan fail-closed olur', () => {
    const missing = decideProviderAuthCapability({
      provider: 'codex',
      authMode: 'subscription-oauth',
      deploymentProfile: 'cloud',
      evidenceVersion: 7,
      featureFlags: flags,
    })
    expect(missing).toMatchObject({
      outcome: 'deny',
      reasonCode: 'CODEX_MANAGED_SUBSCRIPTION_EVIDENCE_REQUIRED',
      requiredEvidenceKind: 'third-party-application-approval',
    })
    expect(missing.actionableMessage).toContain('URI')
    expect(() =>
      assertProviderAuthCapability({
        provider: 'codex',
        authMode: 'subscription-oauth',
        deploymentProfile: 'cloud',
        evidenceVersion: 7,
        featureFlags: flags,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CODEX_MANAGED_SUBSCRIPTION_EVIDENCE_REQUIRED',
        actionable: true,
      }),
    )
    expect(
      decideProviderAuthCapability({
        provider: 'codex',
        authMode: 'subscription-oauth',
        deploymentProfile: 'cloud',
        evidenceVersion: 7,
        evidence: evidence('third-party-application-approval'),
        featureFlags: flags,
      }).outcome,
    ).toBe('allow')
  })

  it('Claude subscription self-hosted dahil previously-approved evidence ister', () => {
    expect(
      decideProviderAuthCapability({
        provider: 'claude',
        authMode: 'subscription-oauth',
        deploymentProfile: 'self-hosted',
        evidenceVersion: 7,
        featureFlags: flags,
      }),
    ).toMatchObject({
      outcome: 'deny',
      reasonCode: 'CLAUDE_PREVIOUS_APPROVAL_REQUIRED',
    })
    expect(
      decideProviderAuthCapability({
        provider: 'claude',
        authMode: 'subscription-oauth',
        deploymentProfile: 'self-hosted',
        evidenceVersion: 7,
        evidence: evidence('previously-approved'),
        featureFlags: flags,
      }).outcome,
    ).toBe('allow')
  })
})

const harness = () => {
  const repository = new InMemoryProviderAuthRepository()
  const encryption = new EnvelopeEncryption(
    new LocalKmsProvider(Buffer.alloc(32, 7)),
  )
  const runtimeAuthority = new RuntimeDataPlaneAuthority({
    signingKey: Buffer.alloc(32, 9),
  })
  const vault = new ProviderCredentialVault({
    repository,
    encryption,
    runtimeAuthority,
    capability: new StaticProviderAuthCapabilitySource({
      deploymentProfile: 'self-hosted',
      evidenceVersion: 7,
      featureFlags: flags,
      trustedPrivateRunner: true,
      evidenceProvider: (provider, authMode) =>
        provider === 'claude' && authMode === 'subscription-oauth'
          ? evidence('previously-approved')
          : undefined,
    }),
    killSwitch: new ProviderAuthKillSwitch(flags),
  })
  return { repository, encryption, runtimeAuthority, vault }
}

describe('durable OAuth flow', () => {
  it('state digest + PKCE S256 doğrular ve callback tek kullanımlıdır', async () => {
    const { repository, encryption } = harness()
    const oauth = new DurableOAuthCoordinator(repository, encryption)
    const started = await oauth.startPkce({
      scope,
      provider: 'codex',
      now: new Date('2026-07-25T00:00:00.000Z'),
    })
    expect(started.challenge).toHaveLength(43)
    expect(started.verifier).toBeUndefined()
    const stored = await repository.getOAuthTransaction(
      scope,
      started.transactionId,
    )
    expect(JSON.stringify(stored)).not.toContain(started.state)
    await expect(
      oauth.consumeCallback({
        scope,
        state: `${started.state}wrong`,
        now: new Date('2026-07-25T00:01:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_TRANSACTION_REJECTED' })
    const consumed = await oauth.consumeCallback({
      scope,
      state: started.state,
      now: new Date('2026-07-25T00:01:00.000Z'),
    })
    expect(consumed.pkceVerifier.length).toBeGreaterThanOrEqual(43)
    await expect(
      oauth.consumeCallback({
        scope,
        state: started.state,
        now: new Date('2026-07-25T00:01:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_TRANSACTION_REJECTED' })

    const concurrent = await oauth.startPkce({
      scope,
      provider: 'codex',
      now: new Date('2026-07-25T00:00:00.000Z'),
    })
    const outcomes = await Promise.allSettled([
      oauth.consumeCallback({
        scope,
        state: concurrent.state,
        now: new Date('2026-07-25T00:01:00.000Z'),
      }),
      oauth.consumeCallback({
        scope,
        state: concurrent.state,
        now: new Date('2026-07-25T00:01:00.000Z'),
      }),
    ])
    expect(
      outcomes.filter((entry) => entry.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(
      outcomes.filter((entry) => entry.status === 'rejected'),
    ).toHaveLength(1)
  })

  it('device code encrypted tutulur, expiry ve tüketim durable olur', async () => {
    const { repository, encryption } = harness()
    const oauth = new DurableOAuthCoordinator(repository, encryption)
    const deviceCode = 'd'.repeat(48)
    const started = await oauth.startDeviceCode({
      scope,
      provider: 'codex',
      deviceCode,
      expiresAt: '2026-07-25T00:10:00.000Z',
    })
    const stored = await repository.getOAuthTransaction(
      scope,
      started.transactionId,
    )
    expect(JSON.stringify(stored)).not.toContain(deviceCode)
    expect(
      await oauth.consumeDeviceCode({
        scope,
        transactionId: started.transactionId,
        now: new Date('2026-07-25T00:01:00.000Z'),
      }),
    ).toEqual({ transactionId: started.transactionId, deviceCode })

    const expired = await oauth.startDeviceCode({
      scope,
      provider: 'codex',
      deviceCode,
      expiresAt: '2026-07-25T00:00:00.000Z',
    })
    await expect(
      oauth.consumeDeviceCode({
        scope,
        transactionId: expired.transactionId,
        now: new Date('2026-07-25T00:01:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_TRANSACTION_EXPIRED' })
  })
})

describe('tenant-scoped credential vault', () => {
  it('cloud Codex subscription connect evidence olmadan actionable fail-closed olur', async () => {
    const repository = new InMemoryProviderAuthRepository()
    const vault = new ProviderCredentialVault({
      repository,
      encryption: new EnvelopeEncryption(
        new LocalKmsProvider(Buffer.alloc(32, 7)),
      ),
      runtimeAuthority: new RuntimeDataPlaneAuthority({
        signingKey: Buffer.alloc(32, 9),
      }),
      capability: new StaticProviderAuthCapabilitySource({
        deploymentProfile: 'cloud',
        evidenceVersion: 7,
        featureFlags: { 'codex:subscription-oauth': true },
      }),
      killSwitch: new ProviderAuthKillSwitch({
        'codex:subscription-oauth': true,
      }),
    })
    await expect(
      vault.connect({
        scope,
        provider: 'codex',
        authMode: 'subscription-oauth',
        accessToken: 'a'.repeat(48),
      }),
    ).rejects.toMatchObject({
      code: 'CODEX_MANAGED_SUBSCRIPTION_EVIDENCE_REQUIRED',
      actionable: true,
    })
    expect(await repository.listProfiles(scope)).toEqual([])
  })

  it('cloud Codex evidence sonradan kalkarsa yeni runtime lease fail-closed olur', async () => {
    const repository = new InMemoryProviderAuthRepository()
    const runtimeAuthority = new RuntimeDataPlaneAuthority({
      signingKey: Buffer.alloc(32, 9),
    })
    let evidenceAvailable = true
    const vault = new ProviderCredentialVault({
      repository,
      encryption: new EnvelopeEncryption(
        new LocalKmsProvider(Buffer.alloc(32, 7)),
      ),
      runtimeAuthority,
      capability: new StaticProviderAuthCapabilitySource({
        deploymentProfile: 'cloud',
        evidenceVersion: 7,
        featureFlags: { 'codex:subscription-oauth': true },
        evidenceProvider: () =>
          evidenceAvailable
            ? evidence('third-party-application-approval')
            : undefined,
      }),
      killSwitch: new ProviderAuthKillSwitch({
        'codex:subscription-oauth': true,
      }),
    })
    const profile = await vault.connect({
      scope,
      provider: 'codex',
      authMode: 'subscription-oauth',
      accessToken: 'a'.repeat(48),
    })
    const runtime = await runtimeAuthority.issue({
      ...scope,
      runtimeId: 'runtime-a',
      generation: 1,
      actions: ['provider-credential.lease'],
    })
    evidenceAvailable = false
    await expect(
      vault.leaseToRuntime({
        scope,
        profileId: profile.profileId,
        runtimeAuthorization: `Bearer ${runtime.accessToken}`,
        runtimeId: 'runtime-a',
        generation: 1,
      }),
    ).rejects.toMatchObject({
      code: 'CODEX_MANAGED_SUBSCRIPTION_EVIDENCE_REQUIRED',
      actionable: true,
    })
  })

  it('kill switch connect/refresh/lease işini durdurur; disconnect açık kalır', async () => {
    const repository = new InMemoryProviderAuthRepository()
    const killSwitch = new ProviderAuthKillSwitch({
      'codex:subscription-oauth': true,
    })
    const runtimeAuthority = new RuntimeDataPlaneAuthority({
      signingKey: Buffer.alloc(32, 9),
    })
    const vault = new ProviderCredentialVault({
      repository,
      encryption: new EnvelopeEncryption(
        new LocalKmsProvider(Buffer.alloc(32, 7)),
      ),
      runtimeAuthority,
      capability: new StaticProviderAuthCapabilitySource({
        deploymentProfile: 'self-hosted',
        evidenceVersion: 7,
        featureFlags: flags,
        trustedPrivateRunner: true,
      }),
      killSwitch,
    })
    const profile = await vault.connect({
      scope,
      provider: 'codex',
      authMode: 'subscription-oauth',
      accessToken: 'a'.repeat(48),
      refreshToken: 'r'.repeat(48),
    })
    const runtime = await runtimeAuthority.issue({
      ...scope,
      runtimeId: 'runtime-a',
      generation: 1,
      actions: ['provider-credential.lease'],
    })
    killSwitch.update({})
    await expect(
      vault.refresh({
        scope,
        profileId: profile.profileId,
        refresh: async () => ({
          accessToken: 'n'.repeat(48),
          expiresAt: '2030-01-01T00:00:00.000Z',
        }),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH_KILL_SWITCH_ACTIVE' })
    await expect(
      vault.leaseToRuntime({
        scope,
        profileId: profile.profileId,
        runtimeAuthorization: `Bearer ${runtime.accessToken}`,
        runtimeId: 'runtime-a',
        generation: 1,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH_KILL_SWITCH_ACTIVE' })
    expect((await vault.disconnect(scope, profile.profileId)).state).toBe(
      'crypto-erased',
    )
  })

  it('yalnız doğru runtime scope/generation için kısa lease verir', async () => {
    const { vault, repository, runtimeAuthority } = harness()
    const accessToken = 't'.repeat(48)
    const profile = await vault.connect({
      scope,
      provider: 'codex',
      authMode: 'subscription-oauth',
      accessToken,
      refreshToken: 'r'.repeat(48),
      expiresAt: '2026-07-25T02:00:00.000Z',
    })
    expect(JSON.stringify(await repository.listProfiles(scope))).not.toContain(
      accessToken,
    )
    const runtime = await runtimeAuthority.issue({
      ...scope,
      runtimeId: 'runtime-a',
      generation: 2,
      actions: ['provider-credential.lease'],
      now: new Date('2026-07-25T00:00:00.000Z'),
    })
    const lease = await vault.leaseToRuntime({
      scope,
      profileId: profile.profileId,
      runtimeAuthorization: `Bearer ${runtime.accessToken}`,
      runtimeId: 'runtime-a',
      generation: 2,
      now: new Date('2026-07-25T00:00:01.000Z'),
    })
    expect(lease.accessToken).toBe(accessToken)
    expect(Date.parse(lease.leaseExpiresAt)).toBe(
      Date.parse('2026-07-25T00:01:01.000Z'),
    )
    await expect(
      vault.leaseToRuntime({
        scope: otherScope,
        profileId: profile.profileId,
        runtimeAuthorization: `Bearer ${runtime.accessToken}`,
        runtimeId: 'runtime-a',
        generation: 2,
        now: new Date('2026-07-25T00:00:01.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_REJECTED' })
    await expect(
      vault.leaseToRuntime({
        scope,
        profileId: profile.profileId,
        runtimeAuthorization: `Bearer ${runtime.accessToken}`,
        runtimeId: 'runtime-a',
        generation: 3,
        now: new Date('2026-07-25T00:00:01.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_REJECTED' })
  })

  it('concurrent refresh tekilleşir; revoke/stale/crypto-erasure fail-closed olur', async () => {
    const { vault, runtimeAuthority } = harness()
    const profile = await vault.connect({
      scope,
      provider: 'codex',
      authMode: 'subscription-oauth',
      accessToken: 'a'.repeat(48),
      refreshToken: 'r'.repeat(48),
      expiresAt: '2026-07-25T02:00:00.000Z',
    })
    let refreshCalls = 0
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const refresh = async () => {
      refreshCalls += 1
      await blocked
      return {
        accessToken: 'n'.repeat(48),
        expiresAt: '2026-07-25T03:00:00.000Z',
      }
    }
    const first = vault.refresh({
      scope,
      profileId: profile.profileId,
      refresh,
    })
    await Promise.resolve()
    const second = vault.refresh({
      scope,
      profileId: profile.profileId,
      refresh,
    })
    await expect(second).rejects.toMatchObject({
      code: 'PROVIDER_REFRESH_IN_PROGRESS',
    })
    release()
    await first
    expect(refreshCalls).toBe(1)

    await vault.revoke(scope, profile.profileId)
    const runtime = await runtimeAuthority.issue({
      ...scope,
      runtimeId: 'runtime-a',
      generation: 1,
      actions: ['provider-credential.lease'],
    })
    await expect(
      vault.leaseToRuntime({
        scope,
        profileId: profile.profileId,
        runtimeAuthorization: `Bearer ${runtime.accessToken}`,
        runtimeId: 'runtime-a',
        generation: 1,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CREDENTIAL_REVOKED' })
    expect((await vault.cryptoErase(scope, profile.profileId)).state).toBe(
      'crypto-erased',
    )
  })

  it('expired provider credential durable expired geçişiyle reddedilir', async () => {
    const { vault, runtimeAuthority, repository } = harness()
    const profile = await vault.connect({
      scope,
      provider: 'codex',
      authMode: 'customer-api-key',
      accessToken: 'a'.repeat(48),
      expiresAt: '2026-07-25T00:00:00.000Z',
    })
    const runtime = await runtimeAuthority.issue({
      ...scope,
      runtimeId: 'runtime-a',
      generation: 1,
      actions: ['provider-credential.lease'],
      now: new Date('2026-07-25T00:00:00.000Z'),
    })
    await expect(
      vault.leaseToRuntime({
        scope,
        profileId: profile.profileId,
        runtimeAuthorization: `Bearer ${runtime.accessToken}`,
        runtimeId: 'runtime-a',
        generation: 1,
        now: new Date('2026-07-25T00:00:01.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CREDENTIAL_STALE' })
    expect((await repository.getProfile(scope, profile.profileId))?.state).toBe(
      'expired',
    )
  })
})

describe('kill switch ve muhasebe ayrımı', () => {
  it('log/event/trace/snapshot/backup/support export credential yüzeyini redakte eder', () => {
    const sentinel = `sk-${'z'.repeat(40)}`
    const rendered = JSON.stringify(
      redactProviderAuthSurface({
        log: { authorization: `Bearer ${'b'.repeat(40)}` },
        event: { accessToken: sentinel },
        trace: { nested: `prefix ${sentinel}` },
        fixture: { refresh_token: 'r'.repeat(40) },
        snapshot: { apiKey: 'k'.repeat(40) },
        backup: { cookie: 'c'.repeat(40) },
        supportExport: { deviceCode: 'd'.repeat(40) },
      }),
    )
    expect(rendered).not.toContain(sentinel)
    expect(rendered).not.toContain('b'.repeat(40))
    expect(rendered).not.toContain('r'.repeat(40))
    expect(rendered).not.toContain('k'.repeat(40))
    expect(rendered).not.toContain('c'.repeat(40))
    expect(rendered).not.toContain('d'.repeat(40))
  })

  it('kill switch yeni işi durdurur ve alternatif auth modu ayrı açılabilir', () => {
    const switches = new ProviderAuthKillSwitch({
      'claude:subscription-oauth': true,
      'claude:customer-api-key': true,
    })
    expect(() =>
      switches.assertNewWork('claude', 'subscription-oauth'),
    ).not.toThrow()
    switches.update({ 'claude:customer-api-key': true })
    expect(() =>
      switches.assertNewWork('claude', 'subscription-oauth'),
    ).toThrowError(
      expect.objectContaining({
        code: 'PROVIDER_AUTH_KILL_SWITCH_ACTIVE',
        actionable: true,
      }),
    )
    expect(() =>
      switches.assertNewWork('claude', 'customer-api-key'),
    ).not.toThrow()
  })

  it('subscription quota tahmini/non-billable, API ve platform maliyeti ayrıdır', async () => {
    const repository = new InMemoryProviderAuthRepository()
    const ledger = new ProviderUsageLedger(repository)
    await ledger.record({
      schemaVersion: 1,
      ...scope,
      usageId: 'usage-subscription',
      provider: 'codex',
      authMode: 'subscription-oauth',
      billingMode: 'subscription-quota',
      quantity: 23,
      unit: 'request',
      monetaryAmountMicros: null,
      currency: null,
      estimated: true,
      quotaLimit: 100,
      quotaRemaining: 77,
    })
    await ledger.record({
      schemaVersion: 1,
      ...scope,
      usageId: 'usage-api',
      provider: 'claude',
      authMode: 'customer-api-key',
      billingMode: 'customer-api-billing',
      quantity: 1_000,
      unit: 'token',
      monetaryAmountMicros: 9_000,
      currency: 'USD',
      estimated: false,
      quotaLimit: null,
      quotaRemaining: null,
    })
    expect(
      (await ledger.list(scope)).map((entry) => entry.billingMode),
    ).toEqual(['subscription-quota', 'customer-api-billing'])
    await expect(
      ledger.record({
        schemaVersion: 1,
        ...scope,
        usageId: 'invalid',
        provider: 'codex',
        authMode: 'subscription-oauth',
        billingMode: 'subscription-quota',
        quantity: 1,
        unit: 'request',
        monetaryAmountMicros: 1,
        currency: 'USD',
        estimated: false,
        quotaLimit: null,
        quotaRemaining: null,
      }),
    ).rejects.toBeInstanceOf(ProviderAuthError)
  })
})
