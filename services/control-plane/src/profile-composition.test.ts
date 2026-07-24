import { describe, expect, it } from 'vitest'
import {
  observedAdaptersFromEnv,
  resolveBootProfile,
} from './profile-composition'

const cloudEnv = {
  PERSISTENT_DEPLOYMENT_PROFILE: 'cloud',
  EVENT_STORE_BACKEND: 'postgresql',
  SCHEDULER_QUEUE_BACKEND: 'postgresql',
  SCHEDULER_LOCK_BACKEND: 'postgresql',
  ARTIFACT_STORAGE_BACKEND: 'object-storage',
  ATTACHMENT_STORAGE_BACKEND: 'object-storage',
  SOURCE_STORAGE_BACKEND: 'object-storage',
  PERSISTENT_SECRET_PROVIDER: 'aws-secrets-manager',
  PERSISTENT_KMS_PROVIDER: 'aws-kms',
  PERSISTENT_RUNTIME_BACKEND: 'kata-kubernetes',
} satisfies NodeJS.ProcessEnv

describe('resolveBootProfile', () => {
  it('geri uyumluluk: alpha bayrağı local, unset self-hosted çözülür', () => {
    expect(
      resolveBootProfile({ PERSISTENT_CODEX_LOCAL_ALPHA: '1' }).profile,
    ).toBe('local')
    expect(resolveBootProfile({}).profile).toBe('self-hosted')
    expect(resolveBootProfile({}).contract.edition).toBe('community')
  })

  it('bilinmeyen profil fail-closed reddedilir', () => {
    expect(() =>
      resolveBootProfile({ PERSISTENT_DEPLOYMENT_PROFILE: 'managed' }),
    ).toThrow('UNKNOWN_DEPLOYMENT_PROFILE:managed')
  })

  it('cloud profil tam production adapter seti ile boot eder', () => {
    const resolved = resolveBootProfile(cloudEnv)
    expect(resolved.profile).toBe('cloud')
    expect(resolved.contract.requiresManagedTenantRuntime).toBe(true)
  })

  it("cloud profil local filesystem/in-memory production fallback'lerinde fail-closed olur", () => {
    // Hiç production adapter bildirmeyen cloud boot'u tüm fallback'leri listeler.
    expect(() =>
      resolveBootProfile({ PERSISTENT_DEPLOYMENT_PROFILE: 'cloud' }),
    ).toThrow(/CLOUD_PROFILE_FALLBACK_FORBIDDEN:.*eventStoreBackend=sqlite/)
    expect(() =>
      resolveBootProfile({
        ...cloudEnv,
        PERSISTENT_SECRET_PROVIDER: 'development-local',
      }),
    ).toThrow(
      'CLOUD_PROFILE_FALLBACK_FORBIDDEN:secretProvider=development-local',
    )
    expect(() =>
      resolveBootProfile({ ...cloudEnv, EVENT_STORE_BACKEND: undefined }),
    ).toThrow('CLOUD_PROFILE_FALLBACK_FORBIDDEN:eventStoreBackend=sqlite')
    expect(() =>
      resolveBootProfile({
        ...cloudEnv,
        PERSISTENT_RUNTIME_BACKEND: 'local-process',
      }),
    ).toThrow('CLOUD_PROFILE_FALLBACK_FORBIDDEN:runtimeBackend=local-process')
  })

  it('local alpha ile cloud profili çelişkisi reddedilir', () => {
    expect(() =>
      resolveBootProfile({
        ...cloudEnv,
        PERSISTENT_CODEX_LOCAL_ALPHA: '1',
      }),
    ).toThrow('DEPLOYMENT_PROFILE_CONFLICT:cloud-with-local-alpha')
  })
})

describe('observedAdaptersFromEnv', () => {
  it('topology-composition ile aynı defaulting semantiğini kullanır', () => {
    expect(observedAdaptersFromEnv({})).toMatchObject({
      eventStoreBackend: 'sqlite',
      schedulerQueueBackend: 'memory',
      schedulerLockBackend: 'memory',
      artifactStorageBackend: 'filesystem',
      attachmentStorageBackend: 'filesystem',
      sourceStorageBackend: 'filesystem',
    })
    expect(observedAdaptersFromEnv({}).secretProvider).toBeUndefined()
    expect(
      observedAdaptersFromEnv({ SCHEDULER_LOCK_BACKEND: 'cache' })
        .schedulerLockBackend,
    ).toBe('cache')
  })
})
