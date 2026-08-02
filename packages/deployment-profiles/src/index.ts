import { z } from 'zod'

export const DEPLOYMENT_PROFILE_CONTRACT_VERSION = 1 as const

// Local is a development mode. Self-hosted is the only supported deployment.
export const deploymentProfileSchema = z.enum(['local', 'self-hosted'])
export type DeploymentProfile = z.infer<typeof deploymentProfileSchema>
export const DEPLOYMENT_PROFILES = deploymentProfileSchema.options

export const deploymentEditionSchema = z.literal('community')
export type DeploymentEdition = z.infer<typeof deploymentEditionSchema>

export class DeploymentProfileError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'DeploymentProfileError'
    this.code = code
  }
}

export interface DeploymentProfileEnvironment {
  PERSISTENT_DEPLOYMENT_PROFILE?: string | undefined
  PERSISTENT_CODEX_LOCAL_ALPHA?: string | undefined
}

export function resolveDeploymentProfile(
  env: DeploymentProfileEnvironment,
): DeploymentProfile {
  const raw = env.PERSISTENT_DEPLOYMENT_PROFILE?.trim()
  const localAlpha = env.PERSISTENT_CODEX_LOCAL_ALPHA === '1'
  if (!raw) return localAlpha ? 'local' : 'self-hosted'
  const parsed = deploymentProfileSchema.safeParse(raw)
  if (!parsed.success)
    throw new DeploymentProfileError('UNKNOWN_DEPLOYMENT_PROFILE:' + raw)
  if (parsed.data === 'local' && !localAlpha)
    throw new DeploymentProfileError(
      'DEPLOYMENT_PROFILE_CONFLICT:local-without-local-alpha',
    )
  return parsed.data
}

export const deploymentProfileContractSchema = z.object({
  schemaVersion: z.literal(DEPLOYMENT_PROFILE_CONTRACT_VERSION),
  profile: deploymentProfileSchema,
  edition: deploymentEditionSchema,
  requiresManagedTenantRuntime: z.literal(false),
  allowsDevelopmentAdapters: z.boolean(),
  requiresProductionStorage: z.boolean(),
})
export type DeploymentProfileContract = z.infer<
  typeof deploymentProfileContractSchema
>

export const DEPLOYMENT_PROFILE_CONTRACTS: Readonly<
  Record<DeploymentProfile, DeploymentProfileContract>
> = {
  local: {
    schemaVersion: DEPLOYMENT_PROFILE_CONTRACT_VERSION,
    profile: 'local',
    edition: 'community',
    requiresManagedTenantRuntime: false,
    allowsDevelopmentAdapters: true,
    requiresProductionStorage: false,
  },
  'self-hosted': {
    schemaVersion: DEPLOYMENT_PROFILE_CONTRACT_VERSION,
    profile: 'self-hosted',
    edition: 'community',
    requiresManagedTenantRuntime: false,
    allowsDevelopmentAdapters: false,
    requiresProductionStorage: true,
  },
}

export interface ObservedProfileAdapters {
  eventStoreBackend?: string | undefined
  schedulerQueueBackend?: string | undefined
  schedulerLockBackend?: string | undefined
  artifactStorageBackend?: string | undefined
  attachmentStorageBackend?: string | undefined
  sourceStorageBackend?: string | undefined
  secretProvider?: string | undefined
  kmsProvider?: string | undefined
  runtimeBackend?: string | undefined
}

export const DEVELOPMENT_FALLBACK_ADAPTERS: Readonly<
  Record<keyof ObservedProfileAdapters, readonly string[]>
> = {
  eventStoreBackend: ['sqlite', 'memory'],
  schedulerQueueBackend: ['memory'],
  schedulerLockBackend: ['memory'],
  artifactStorageBackend: ['filesystem', 'memory'],
  attachmentStorageBackend: ['filesystem', 'memory'],
  sourceStorageBackend: ['filesystem', 'memory'],
  secretProvider: ['development-local', 'development-memory'],
  kmsProvider: ['local-memory'],
  runtimeBackend: ['local-process'],
}

const OBSERVED_ADAPTER_KEYS = Object.keys(
  DEVELOPMENT_FALLBACK_ADAPTERS,
) as (keyof ObservedProfileAdapters)[]

export function assertProfileProductionAdapters(
  profile: DeploymentProfile,
  observed: ObservedProfileAdapters,
): void {
  if (profile === 'local') return
  const violations = OBSERVED_ADAPTER_KEYS.flatMap((key) => {
    const value = observed[key]
    return value !== undefined &&
      DEVELOPMENT_FALLBACK_ADAPTERS[key].includes(value)
      ? [key + '=' + value]
      : []
  })
  if (violations.length)
    throw new DeploymentProfileError(
      'SELF_HOSTED_PROFILE_FALLBACK_FORBIDDEN:' + violations.sort().join(','),
    )
}

export const ENTITLEMENT_FEATURES = [
  'core.conversations',
  'core.events',
  'core.approvals',
  'core.detached-runs',
  'core.replay',
  'core.artifacts',
  'core.provider-adapters',
  'local.dev-adapters',
  'self-hosted.single-command-install',
  'self-hosted.encrypted-backup',
] as const
export type EntitlementFeature = (typeof ENTITLEMENT_FEATURES)[number]

export const CORE_ENTITLEMENT_FEATURES = ENTITLEMENT_FEATURES.filter(
  (feature) => feature.startsWith('core.'),
) as readonly EntitlementFeature[]

const withCore = (features: readonly EntitlementFeature[]) =>
  new Set<EntitlementFeature>([...CORE_ENTITLEMENT_FEATURES, ...features])

export const PROFILE_ENTITLEMENTS: Readonly<
  Record<DeploymentProfile, ReadonlySet<EntitlementFeature>>
> = {
  local: withCore(['local.dev-adapters']),
  'self-hosted': withCore([
    'self-hosted.single-command-install',
    'self-hosted.encrypted-backup',
  ]),
}

export function isEntitled(
  profile: DeploymentProfile,
  feature: string,
): boolean {
  if (!ENTITLEMENT_FEATURES.includes(feature as EntitlementFeature))
    return false
  return PROFILE_ENTITLEMENTS[profile].has(feature as EntitlementFeature)
}

export function assertEntitled(
  profile: DeploymentProfile,
  feature: string,
): void {
  if (!isEntitled(profile, feature))
    throw new DeploymentProfileError(
      'ENTITLEMENT_DENIED:' + profile + ':' + feature,
    )
}

export function assertCoreSemanticsEntitled(): void {
  for (const profile of DEPLOYMENT_PROFILES)
    for (const feature of CORE_ENTITLEMENT_FEATURES)
      if (!isEntitled(profile, feature))
        throw new DeploymentProfileError(
          'CORE_SEMANTICS_FORKED:' + profile + ':' + feature,
        )
}
