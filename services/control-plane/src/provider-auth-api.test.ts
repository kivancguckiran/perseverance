import { describe, expect, it } from 'vitest'
import {
  InMemoryProviderAuthRepository,
  ProviderAuthKillSwitch,
  ProviderCredentialVault,
  StaticProviderAuthCapabilitySource,
} from '@perseverance/provider-auth'
import { RuntimeDataPlaneAuthority } from '@perseverance/tenant-runtime'
import {
  EnvelopeEncryption,
  LocalKmsProvider,
} from '@perseverance/workspace-security'
import { buildProviderAuthApi } from './provider-auth-api'

const headers = {
  'x-tenant-id': 'tenant-a',
  'x-organization-id': 'tenant-a',
}

function harness(options?: { evidence?: boolean }) {
  const repository = new InMemoryProviderAuthRepository()
  const runtimeAuthority = new RuntimeDataPlaneAuthority({
    signingKey: Buffer.alloc(32, 9),
  })
  const killSwitch = new ProviderAuthKillSwitch({
    'codex:subscription-oauth': true,
  })
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
        options?.evidence
          ? {
              evidenceVersion: 7,
              kind: 'third-party-application-approval',
              uri: 'https://provider.example.test/approval',
              sha256: 'a'.repeat(64),
              observedAt: '2026-07-20T00:00:00.000Z',
              effectiveAt: '2026-07-20T00:00:00.000Z',
            }
          : undefined,
    }),
    killSwitch,
  })
  return {
    app: buildProviderAuthApi({
      profile: 'cloud',
      repository,
      vault,
    }),
    repository,
    runtimeAuthority,
    killSwitch,
  }
}

describe('provider auth control-plane API', () => {
  it('scope olmadan reddeder; evidence deny 403 reason code taşır', async () => {
    const { app } = harness()
    const missingScope = await app.inject({
      method: 'GET',
      url: '/v1/provider-auth/profiles?workspaceId=workspace-a',
    })
    expect(missingScope.statusCode).toBe(400)
    expect(missingScope.json().error).toBe('MISSING_TENANT_SCOPE')

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/provider-auth/profiles',
      headers,
      payload: {
        workspaceId: 'workspace-a',
        provider: 'codex',
        authMode: 'subscription-oauth',
        accessToken: 'a'.repeat(48),
      },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error).toBe(
      'CODEX_MANAGED_SUBSCRIPTION_EVIDENCE_REQUIRED',
    )
  })

  it('plaintext yalnız runtime lease yanıtında görünür', async () => {
    const { app, runtimeAuthority } = harness({ evidence: true })
    const accessToken = 't'.repeat(48)
    const connected = await app.inject({
      method: 'POST',
      url: '/v1/provider-auth/profiles',
      headers,
      payload: {
        workspaceId: 'workspace-a',
        profileId: 'profile-a',
        provider: 'codex',
        authMode: 'subscription-oauth',
        accessToken,
      },
    })
    expect(connected.statusCode).toBe(201)
    expect(connected.body).not.toContain(accessToken)

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/provider-auth/profiles?workspaceId=workspace-a',
      headers,
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.body).not.toContain(accessToken)

    const runtime = await runtimeAuthority.issue({
      tenantId: 'tenant-a',
      organizationId: 'tenant-a',
      workspaceId: 'workspace-a',
      runtimeId: 'runtime-a',
      generation: 1,
      actions: ['provider-credential.lease'],
    })
    const lease = await app.inject({
      method: 'POST',
      url: '/v1/runtime/provider-auth/profiles/profile-a/lease',
      headers: {
        ...headers,
        authorization: `Bearer ${runtime.accessToken}`,
      },
      payload: {
        workspaceId: 'workspace-a',
        runtimeId: 'runtime-a',
        generation: 1,
      },
    })
    expect(lease.statusCode).toBe(200)
    expect(lease.json().accessToken).toBe(accessToken)
  })

  it('kill switch lease için 409 üretir; disconnect çalışmaya devam eder', async () => {
    const { app, runtimeAuthority, killSwitch } = harness({ evidence: true })
    await app.inject({
      method: 'POST',
      url: '/v1/provider-auth/profiles',
      headers,
      payload: {
        workspaceId: 'workspace-a',
        profileId: 'profile-a',
        provider: 'codex',
        authMode: 'subscription-oauth',
        accessToken: 'a'.repeat(48),
      },
    })
    const runtime = await runtimeAuthority.issue({
      tenantId: 'tenant-a',
      organizationId: 'tenant-a',
      workspaceId: 'workspace-a',
      runtimeId: 'runtime-a',
      generation: 1,
      actions: ['provider-credential.lease'],
    })
    killSwitch.update({})
    const halted = await app.inject({
      method: 'POST',
      url: '/v1/runtime/provider-auth/profiles/profile-a/lease',
      headers: {
        ...headers,
        authorization: `Bearer ${runtime.accessToken}`,
      },
      payload: {
        workspaceId: 'workspace-a',
        runtimeId: 'runtime-a',
        generation: 1,
      },
    })
    expect(halted.statusCode).toBe(409)
    expect(halted.json().error).toBe('PROVIDER_AUTH_KILL_SWITCH_ACTIVE')

    const disconnected = await app.inject({
      method: 'POST',
      url: '/v1/provider-auth/profiles/profile-a/disconnect',
      headers,
      payload: { workspaceId: 'workspace-a' },
    })
    expect(disconnected.statusCode).toBe(200)
    expect(disconnected.json().state).toBe('crypto-erased')
  })
})
