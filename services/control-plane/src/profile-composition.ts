import {
  DEPLOYMENT_PROFILE_CONTRACTS,
  assertProfileProductionAdapters,
  resolveDeploymentProfile,
  type DeploymentProfile,
  type DeploymentProfileContract,
  type ObservedProfileAdapters,
} from '@perseverance/deployment-profiles'

// Boot-time profile resolution for local development and self-hosted runtime.

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

export function resolveBootProfile(
  env: NodeJS.ProcessEnv,
): ResolvedBootProfile {
  const profile = resolveDeploymentProfile({
    PERSISTENT_DEPLOYMENT_PROFILE: env.PERSISTENT_DEPLOYMENT_PROFILE,
    PERSISTENT_CODEX_LOCAL_ALPHA: env.PERSISTENT_CODEX_LOCAL_ALPHA,
  })
  if (profile === 'self-hosted')
    assertProfileProductionAdapters('self-hosted', observedAdaptersFromEnv(env))
  return { profile, contract: DEPLOYMENT_PROFILE_CONTRACTS[profile] }
}
