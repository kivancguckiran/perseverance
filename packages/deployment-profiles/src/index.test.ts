import { describe, expect, it } from 'vitest'
import {
  CORE_ENTITLEMENT_FEATURES,
  DEPLOYMENT_PROFILES,
  DEPLOYMENT_PROFILE_CONTRACTS,
  assertCoreSemanticsEntitled,
  assertProfileProductionAdapters,
  deploymentProfileContractSchema,
  isEntitled,
  resolveDeploymentProfile,
} from './index'

describe('deployment profile resolution', () => {
  it('uses local only for explicit local development', () => {
    expect(
      resolveDeploymentProfile({ PERSISTENT_CODEX_LOCAL_ALPHA: '1' }),
    ).toBe('local')
    expect(resolveDeploymentProfile({})).toBe('self-hosted')
    expect(
      resolveDeploymentProfile({
        PERSISTENT_DEPLOYMENT_PROFILE: 'self-hosted',
      }),
    ).toBe('self-hosted')
  })

  it('rejects unsupported or conflicting profiles', () => {
    expect(() =>
      resolveDeploymentProfile({ PERSISTENT_DEPLOYMENT_PROFILE: 'cloud' }),
    ).toThrow('UNKNOWN_DEPLOYMENT_PROFILE:cloud')
    expect(() =>
      resolveDeploymentProfile({ PERSISTENT_DEPLOYMENT_PROFILE: 'local' }),
    ).toThrow('DEPLOYMENT_PROFILE_CONFLICT:local-without-local-alpha')
  })
})

describe('self-hosted deployment contract', () => {
  it('keeps a community-only product boundary', () => {
    for (const profile of DEPLOYMENT_PROFILES) {
      const contract = deploymentProfileContractSchema.parse(
        DEPLOYMENT_PROFILE_CONTRACTS[profile],
      )
      expect(contract.edition).toBe('community')
      expect(contract.requiresManagedTenantRuntime).toBe(false)
    }
  })

  it('rejects development adapters in self-hosted mode', () => {
    expect(() =>
      assertProfileProductionAdapters('self-hosted', {
        secretProvider: 'development-local',
      }),
    ).toThrow(
      'SELF_HOSTED_PROFILE_FALLBACK_FORBIDDEN:secretProvider=development-local',
    )
    expect(() =>
      assertProfileProductionAdapters('self-hosted', {}),
    ).not.toThrow()
  })

  it('keeps core semantics available in every mode', () => {
    expect(() => assertCoreSemanticsEntitled()).not.toThrow()
    for (const profile of DEPLOYMENT_PROFILES)
      for (const feature of CORE_ENTITLEMENT_FEATURES)
        expect(isEntitled(profile, feature)).toBe(true)
    expect(isEntitled('self-hosted', 'unknown.feature')).toBe(false)
  })
})
