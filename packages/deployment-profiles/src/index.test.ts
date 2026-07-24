import { describe, expect, it } from 'vitest'
import {
  CORE_ENTITLEMENT_FEATURES,
  DEPLOYMENT_PROFILES,
  DEPLOYMENT_PROFILE_CONTRACTS,
  DeploymentProfileError,
  ENTITLEMENT_FEATURES,
  PROFILE_ENTITLEMENTS,
  assertCoreSemanticsEntitled,
  assertEntitled,
  assertProfileProductionAdapters,
  deploymentProfileContractSchema,
  isEntitled,
  resolveDeploymentProfile,
} from './index'

const cloudProductionAdapters = {
  eventStoreBackend: 'postgresql',
  schedulerQueueBackend: 'postgresql',
  schedulerLockBackend: 'postgresql',
  artifactStorageBackend: 'object-storage',
  attachmentStorageBackend: 'object-storage',
  sourceStorageBackend: 'object-storage',
  secretProvider: 'aws-secrets-manager',
  kmsProvider: 'aws-kms',
  runtimeBackend: 'kata-kubernetes',
}

describe('deployment profile çözümleme', () => {
  it('unset profil geri uyumluluk kuralıyla çözülür', () => {
    expect(
      resolveDeploymentProfile({ PERSISTENT_CODEX_LOCAL_ALPHA: '1' }),
    ).toBe('local')
    expect(resolveDeploymentProfile({})).toBe('self-hosted')
    expect(
      resolveDeploymentProfile({ PERSISTENT_DEPLOYMENT_PROFILE: '' }),
    ).toBe('self-hosted')
  })

  it('açık profil değerleri kabul edilir', () => {
    expect(
      resolveDeploymentProfile({
        PERSISTENT_DEPLOYMENT_PROFILE: 'local',
        PERSISTENT_CODEX_LOCAL_ALPHA: '1',
      }),
    ).toBe('local')
    expect(
      resolveDeploymentProfile({
        PERSISTENT_DEPLOYMENT_PROFILE: 'self-hosted',
      }),
    ).toBe('self-hosted')
    expect(
      resolveDeploymentProfile({ PERSISTENT_DEPLOYMENT_PROFILE: 'cloud' }),
    ).toBe('cloud')
  })

  it('bilinmeyen profil fail-closed reddedilir', () => {
    expect(() =>
      resolveDeploymentProfile({ PERSISTENT_DEPLOYMENT_PROFILE: 'saas' }),
    ).toThrow('UNKNOWN_DEPLOYMENT_PROFILE:saas')
    expect(() =>
      resolveDeploymentProfile({ PERSISTENT_DEPLOYMENT_PROFILE: 'CLOUD' }),
    ).toThrow(DeploymentProfileError)
  })

  it('çelişkili profil/alpha kombinasyonları fail-closed reddedilir', () => {
    expect(() =>
      resolveDeploymentProfile({
        PERSISTENT_DEPLOYMENT_PROFILE: 'cloud',
        PERSISTENT_CODEX_LOCAL_ALPHA: '1',
      }),
    ).toThrow('DEPLOYMENT_PROFILE_CONFLICT:cloud-with-local-alpha')
    expect(() =>
      resolveDeploymentProfile({ PERSISTENT_DEPLOYMENT_PROFILE: 'local' }),
    ).toThrow('DEPLOYMENT_PROFILE_CONFLICT:local-without-local-alpha')
  })
})

describe('deployment profile contract', () => {
  it('üç profil de geçerli contract taşır ve cloud dışında edition community kalır', () => {
    for (const profile of DEPLOYMENT_PROFILES) {
      const contract = deploymentProfileContractSchema.parse(
        DEPLOYMENT_PROFILE_CONTRACTS[profile],
      )
      expect(contract.profile).toBe(profile)
      expect(contract.edition).toBe(profile === 'cloud' ? 'cloud' : 'community')
    }
    expect(
      DEPLOYMENT_PROFILE_CONTRACTS.cloud.requiresManagedTenantRuntime,
    ).toBe(true)
    expect(DEPLOYMENT_PROFILE_CONTRACTS.local.allowsDevelopmentAdapters).toBe(
      true,
    )
    expect(
      DEPLOYMENT_PROFILE_CONTRACTS['self-hosted'].allowsDevelopmentAdapters,
    ).toBe(false)
  })
})

describe('profil-bilinçli production adapter doğrulaması', () => {
  it('local profil development adapter kullanabilir', () => {
    expect(() =>
      assertProfileProductionAdapters('local', {
        eventStoreBackend: 'sqlite',
        secretProvider: 'development-local',
      }),
    ).not.toThrow()
  })

  it('cloud profil tam production adapter seti ile boot eder', () => {
    expect(() =>
      assertProfileProductionAdapters('cloud', cloudProductionAdapters),
    ).not.toThrow()
  })

  it('cloud profil development fallback değerlerinde fail-closed olur', () => {
    expect(() =>
      assertProfileProductionAdapters('cloud', {
        ...cloudProductionAdapters,
        eventStoreBackend: 'sqlite',
        secretProvider: 'development-local',
        kmsProvider: 'local-memory',
        runtimeBackend: 'local-process',
      }),
    ).toThrow(
      'CLOUD_PROFILE_FALLBACK_FORBIDDEN:eventStoreBackend=sqlite,kmsProvider=local-memory,runtimeBackend=local-process,secretProvider=development-local',
    )
  })

  it('cloud profilde bildirilmeyen adapter alanı da fail-closed ihlaldir', () => {
    expect(() => assertProfileProductionAdapters('cloud', {})).toThrow(
      DeploymentProfileError,
    )
    expect(() =>
      assertProfileProductionAdapters('cloud', {
        ...cloudProductionAdapters,
        secretProvider: undefined,
      }),
    ).toThrow('CLOUD_PROFILE_FALLBACK_FORBIDDEN:secretProvider=missing')
  })

  it('self-hosted profil development fallback bildirirse reddedilir', () => {
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
})

describe('entitlement policy', () => {
  it('deny-by-default: bilinmeyen feature hiçbir profilde entitled değildir', () => {
    for (const profile of DEPLOYMENT_PROFILES) {
      expect(isEntitled(profile, 'unknown.feature')).toBe(false)
      expect(() => assertEntitled(profile, 'unknown.feature')).toThrow(
        `ENTITLEMENT_DENIED:${profile}:unknown.feature`,
      )
    }
  })

  it('profil-spesifik feature yalnız kendi profilinde entitled olur', () => {
    expect(isEntitled('cloud', 'cloud.managed-tenant-provisioning')).toBe(true)
    expect(isEntitled('self-hosted', 'cloud.managed-tenant-provisioning')).toBe(
      false,
    )
    expect(isEntitled('local', 'cloud.tenant-runtime-isolation')).toBe(false)
    expect(isEntitled('self-hosted', 'self-hosted.encrypted-backup')).toBe(true)
    expect(isEntitled('cloud', 'local.dev-adapters')).toBe(false)
  })

  it('fork-engelleyici değişmez: core semantik her profilde entitled kalır', () => {
    expect(CORE_ENTITLEMENT_FEATURES.length).toBeGreaterThanOrEqual(7)
    expect(() => assertCoreSemanticsEntitled()).not.toThrow()
    for (const profile of DEPLOYMENT_PROFILES) {
      for (const feature of CORE_ENTITLEMENT_FEATURES) {
        expect(isEntitled(profile, feature)).toBe(true)
      }
    }
  })

  it('entitlement kümeleri yalnız bilinen feature listesinden oluşur', () => {
    for (const profile of DEPLOYMENT_PROFILES) {
      for (const feature of PROFILE_ENTITLEMENTS[profile]) {
        expect(ENTITLEMENT_FEATURES).toContain(feature)
      }
    }
  })
})
