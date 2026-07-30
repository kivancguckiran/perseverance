import {
  DEPLOYMENT_PROFILE_CONTRACTS,
  assertProfileProductionAdapters,
  resolveDeploymentProfile,
  type DeploymentProfile,
  type DeploymentProfileContract,
  type ObservedProfileAdapters,
} from '@perseverance/deployment-profiles'

// WP33 — boot-time profil çözümleme ve cloud fail-closed sınırı (ADR-0033).
// `local`/`self-hosted` davranışı değişmez; `cloud` profili development/local
// production fallback'lerinde boot'ta fail-closed durur.

export function observedAdaptersFromEnv(
  env: NodeJS.ProcessEnv,
): ObservedProfileAdapters {
  return {
    eventStoreBackend:
      env.EVENT_STORE_BACKEND === 'postgresql' ? 'postgresql' : 'sqlite',
    schedulerQueueBackend:
      env.SCHEDULER_QUEUE_BACKEND === 'postgresql' ? 'postgresql' : 'memory',
    schedulerLockBackend:
      env.SCHEDULER_LOCK_BACKEND === 'postgresql'
        ? 'postgresql'
        : env.SCHEDULER_LOCK_BACKEND === 'cache'
          ? 'cache'
          : 'memory',
    artifactStorageBackend:
      env.ARTIFACT_STORAGE_BACKEND === 'object-storage'
        ? 'object-storage'
        : 'filesystem',
    attachmentStorageBackend:
      env.ATTACHMENT_STORAGE_BACKEND === 'object-storage'
        ? 'object-storage'
        : 'filesystem',
    sourceStorageBackend:
      env.SOURCE_STORAGE_BACKEND === 'object-storage'
        ? 'object-storage'
        : 'filesystem',
    secretProvider: env.PERSISTENT_SECRET_PROVIDER?.trim() || undefined,
    kmsProvider: env.PERSISTENT_KMS_PROVIDER?.trim() || undefined,
    runtimeBackend: env.PERSISTENT_RUNTIME_BACKEND?.trim() || undefined,
  }
}

export interface ResolvedBootProfile {
  profile: DeploymentProfile
  contract: DeploymentProfileContract
}

// Boot profili: bilinmeyen profil fail-closed reddedilir; cloud profili tam
// production adapter seti olmadan boot edemez. `self-hosted` için ADR-0026
// `assertProductionStorage` sınırı (topology-composition) aynen geçerli kalır.
export function resolveBootProfile(
  env: NodeJS.ProcessEnv,
): ResolvedBootProfile {
  const profile = resolveDeploymentProfile({
    PERSISTENT_DEPLOYMENT_PROFILE: env.PERSISTENT_DEPLOYMENT_PROFILE,
    PERSISTENT_CODEX_LOCAL_ALPHA: env.PERSISTENT_CODEX_LOCAL_ALPHA,
  })
  if (profile === 'cloud')
    assertProfileProductionAdapters('cloud', observedAdaptersFromEnv(env))
  return { profile, contract: DEPLOYMENT_PROFILE_CONTRACTS[profile] }
}
