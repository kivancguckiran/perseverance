import { z } from 'zod'

// WP33 — deployment profile ve entitlement contract'ı (ADR-0033).
// `local`, `self-hosted` ve `cloud` aynı kod tabanından üretilir; profil yalnız
// composition/entitlement katmanını etkiler. Çekirdek agent/conversation/event
// semantiği profil görmez; bu değişmez contract testleriyle korunur.

export const DEPLOYMENT_PROFILE_CONTRACT_VERSION = 1 as const

export const deploymentProfileSchema = z.enum(['local', 'self-hosted', 'cloud'])
export type DeploymentProfile = z.infer<typeof deploymentProfileSchema>
export const DEPLOYMENT_PROFILES = deploymentProfileSchema.options

export const deploymentEditionSchema = z.enum(['community', 'cloud'])
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

// Profil çözümleme: bilinmeyen değer fail-closed reddedilir. `cloud` hiçbir
// zaman örtük seçilmez; unset değer geri uyumluluk kuralıyla `local` (alpha
// bayrağı açıksa) veya `self-hosted` olur.
export function resolveDeploymentProfile(
  env: DeploymentProfileEnvironment,
): DeploymentProfile {
  const raw = env.PERSISTENT_DEPLOYMENT_PROFILE?.trim()
  const localAlpha = env.PERSISTENT_CODEX_LOCAL_ALPHA === '1'
  if (raw === undefined || raw === '')
    return localAlpha ? 'local' : 'self-hosted'
  const parsed = deploymentProfileSchema.safeParse(raw)
  if (!parsed.success)
    throw new DeploymentProfileError(`UNKNOWN_DEPLOYMENT_PROFILE:${raw}`)
  if (parsed.data === 'cloud' && localAlpha)
    throw new DeploymentProfileError(
      'DEPLOYMENT_PROFILE_CONFLICT:cloud-with-local-alpha',
    )
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
  requiresManagedTenantRuntime: z.boolean(),
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
  cloud: {
    schemaVersion: DEPLOYMENT_PROFILE_CONTRACT_VERSION,
    profile: 'cloud',
    edition: 'cloud',
    requiresManagedTenantRuntime: true,
    allowsDevelopmentAdapters: false,
    requiresProductionStorage: true,
  },
}

// Cloud profilinde boot'ta reddedilen development/local fallback değerleri.
// Alan gözlenmemişse (undefined) cloud'da fail-closed ihlal sayılır.
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

const CLOUD_ALLOWED_ADAPTERS: Readonly<
  Record<keyof ObservedProfileAdapters, readonly string[]>
> = {
  eventStoreBackend: ['postgresql'],
  schedulerQueueBackend: ['postgresql'],
  schedulerLockBackend: ['postgresql'],
  artifactStorageBackend: ['object-storage'],
  attachmentStorageBackend: ['object-storage'],
  sourceStorageBackend: ['object-storage'],
  secretProvider: ['aws-secrets-manager'],
  kmsProvider: ['aws-kms'],
  runtimeBackend: ['kata-kubernetes'],
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
  CLOUD_ALLOWED_ADAPTERS,
) as (keyof ObservedProfileAdapters)[]

// Profil-bilinçli production adapter doğrulaması.
// - `local`: no-op (development adapter'ları explicit olarak izinlidir).
// - `self-hosted`: bildirilen her alan development fallback'i olamaz; alan
//   bildirilmemişse mevcut ADR-0026 `assertProductionStorage` sınırı geçerli
//   kalır (bu fonksiyon onu gevşetmez).
// - `cloud`: her alan bildirilmek ve allowed listede olmak zorundadır; eksik
//   veya fallback değer `CLOUD_PROFILE_FALLBACK_FORBIDDEN` ile fail-closed olur.
export function assertProfileProductionAdapters(
  profile: DeploymentProfile,
  observed: ObservedProfileAdapters,
): void {
  if (profile === 'local') return
  const violations: string[] = []
  for (const key of OBSERVED_ADAPTER_KEYS) {
    const value = observed[key]
    if (profile === 'cloud') {
      if (value === undefined || !CLOUD_ALLOWED_ADAPTERS[key].includes(value))
        violations.push(`${key}=${value ?? 'missing'}`)
    } else if (
      value !== undefined &&
      DEVELOPMENT_FALLBACK_ADAPTERS[key].includes(value)
    ) {
      violations.push(`${key}=${value}`)
    }
  }
  if (violations.length > 0) {
    const code =
      profile === 'cloud'
        ? 'CLOUD_PROFILE_FALLBACK_FORBIDDEN'
        : 'SELF_HOSTED_PROFILE_FALLBACK_FORBIDDEN'
    throw new DeploymentProfileError(`${code}:${violations.sort().join(',')}`)
  }
}

// --- Entitlement / edition policy (deny-by-default) ---

export const ENTITLEMENT_FEATURES = [
  // Çekirdek semantik: her profilde zorunlu entitled; fork edilemez.
  'core.conversations',
  'core.events',
  'core.approvals',
  'core.detached-runs',
  'core.replay',
  'core.artifacts',
  'core.provider-adapters',
  // Profil-spesifik operasyonel yüzeyler.
  'local.dev-adapters',
  'self-hosted.single-command-install',
  'self-hosted.encrypted-backup',
  'cloud.managed-tenant-provisioning',
  'cloud.tenant-runtime-isolation',
  'cloud.tenant-capacity-budgets',
  'cloud.runtime-data-plane-credentials',
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
  cloud: withCore([
    'cloud.managed-tenant-provisioning',
    'cloud.tenant-runtime-isolation',
    'cloud.tenant-capacity-budgets',
    'cloud.runtime-data-plane-credentials',
  ]),
}

// Deny-by-default: bilinmeyen feature hiçbir profilde entitled değildir.
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
    throw new DeploymentProfileError(`ENTITLEMENT_DENIED:${profile}:${feature}`)
}

// Fork-engelleyici değişmez: entitlement mekanizması çekirdek semantiği hiçbir
// profilde kapatamaz. Contract testleri bu fonksiyonu çağırır.
export function assertCoreSemanticsEntitled(): void {
  for (const profile of DEPLOYMENT_PROFILES) {
    for (const feature of CORE_ENTITLEMENT_FEATURES) {
      if (!isEntitled(profile, feature))
        throw new DeploymentProfileError(
          `CORE_SEMANTICS_FORKED:${profile}:${feature}`,
        )
    }
  }
}
