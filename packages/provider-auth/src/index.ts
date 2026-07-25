import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DeploymentProfile } from '@persistent-codex/deployment-profiles'
import type { ProviderId } from '@persistent-codex/provider-platform'
import {
  RuntimeDataPlaneAuthority,
  type RuntimeCredentialClaims,
} from '@persistent-codex/tenant-runtime'
import {
  EnvelopeEncryption,
  type EncryptionContextV1,
  type EnvelopeV1,
} from '@persistent-codex/workspace-security'
import {
  PROVIDER_AUTH_CONTRACT_VERSION,
  oauthTransactionSchema,
  providerAuthEvidenceSchema,
  providerAuthProfileMetadataSchema,
  providerCapabilityDecisionKeySchema,
  providerUsageLedgerEntrySchema,
  type OAuthFlowKind,
  type OAuthTransaction,
  type ProviderAuthEvidence,
  type ProviderAuthMode,
  type ProviderAuthProfileMetadata,
  type ProviderAuthScope,
  type ProviderCapabilityDecision,
  type ProviderUsageLedgerEntry,
} from './contracts'

export * from './contracts'

export class ProviderAuthError extends Error {
  readonly code: string
  readonly actionable: boolean
  constructor(code: string, message = code, actionable = false) {
    super(message)
    this.name = 'ProviderAuthError'
    this.code = code
    this.actionable = actionable
  }
}

const SENSITIVE_FIELD =
  /(?:authorization|access.?token|refresh.?token|api.?key|secret|password|cookie|device.?code|pkce.?verifier)/i
const TOKEN_LIKE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b|\bsk-[A-Za-z0-9_-]{12,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/gi

// Tek telemetry/support/export sınırı: sensitive key'ler ve token-benzeri string'ler
// shape korunarak redakte edilir. Vault decrypt sonucu bu yüzeylere verilmez.
export function redactProviderAuthSurface(value: unknown): unknown {
  if (typeof value === 'string')
    return value.replace(TOKEN_LIKE, '[REDACTED:PROVIDER_CREDENTIAL]')
  if (Array.isArray(value)) return value.map(redactProviderAuthSurface)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_FIELD.test(key)
          ? '[REDACTED:PROVIDER_CREDENTIAL]'
          : redactProviderAuthSurface(entry),
      ]),
    )
  return value
}

export type ProviderAuthFeatureFlags = Readonly<
  Partial<Record<`${ProviderId}:${ProviderAuthMode}`, boolean>>
>

export interface CapabilityDecisionInput {
  provider: ProviderId
  authMode: ProviderAuthMode
  deploymentProfile: DeploymentProfile
  evidenceVersion: number
  evidence?: ProviderAuthEvidence | undefined
  featureFlags?: ProviderAuthFeatureFlags | undefined
  trustedPrivateRunner?: boolean | undefined
}

const deny = (
  input: CapabilityDecisionInput,
  reasonCode: string,
  actionableMessage: string,
  requiredEvidenceKind: ProviderAuthEvidence['kind'] | null = null,
): ProviderCapabilityDecision => ({
  schemaVersion: PROVIDER_AUTH_CONTRACT_VERSION,
  ...providerCapabilityDecisionKeySchema.parse(input),
  outcome: 'deny',
  reasonCode,
  actionableMessage,
  requiredEvidenceKind,
})

const allow = (
  input: CapabilityDecisionInput,
  reasonCode: string,
): ProviderCapabilityDecision => ({
  schemaVersion: PROVIDER_AUTH_CONTRACT_VERSION,
  ...providerCapabilityDecisionKeySchema.parse(input),
  outcome: 'allow',
  reasonCode,
  actionableMessage:
    'Provider auth mode is enabled for this deployment profile.',
  requiredEvidenceKind: null,
})

function validEvidence(
  input: CapabilityDecisionInput,
  kind: ProviderAuthEvidence['kind'],
): boolean {
  const parsed = providerAuthEvidenceSchema.safeParse(input.evidence)
  return (
    parsed.success &&
    parsed.data.kind === kind &&
    parsed.data.evidenceVersion === input.evidenceVersion
  )
}

// Tek capability authority: bilinmeyen/flag'siz kombinasyonlar deny-by-default.
// Gemini consumer subscription OAuth koşulsuz unsupported'tur.
export function decideProviderAuthCapability(
  rawInput: CapabilityDecisionInput,
): ProviderCapabilityDecision {
  const input = {
    ...rawInput,
    ...providerCapabilityDecisionKeySchema.parse(rawInput),
  }
  if (input.provider === 'gemini' && input.authMode === 'subscription-oauth')
    return deny(
      input,
      'GEMINI_CONSUMER_SUBSCRIPTION_OAUTH_UNSUPPORTED',
      'Use a Gemini API key or an approved Vertex AI identity.',
    )
  if (input.provider === 'cursor')
    return deny(
      input,
      'PROVIDER_AUTH_MODE_NOT_IMPLEMENTED',
      'No account-connection capability is registered for this provider.',
    )

  const flagKey = `${input.provider}:${input.authMode}` as const
  if (input.featureFlags?.[flagKey] !== true)
    return deny(
      input,
      'PROVIDER_AUTH_FEATURE_DISABLED',
      `Enable the reviewed ${flagKey} feature flag after satisfying provider terms evidence.`,
    )

  if (input.authMode === 'platform-credit')
    return allow(input, 'PLATFORM_CREDIT_SUPPORTED')

  if (input.authMode === 'customer-api-key') {
    if (input.deploymentProfile !== 'cloud')
      return allow(input, 'CUSTOMER_API_KEY_SELF_CUSTODY_SUPPORTED')
    if (!validEvidence(input, 'customer-key-custody'))
      return deny(
        input,
        'CUSTOMER_KEY_CUSTODY_EVIDENCE_REQUIRED',
        'Attach dated provider key-custody evidence URI and SHA-256 before enabling this cloud mode.',
        'customer-key-custody',
      )
    return allow(input, 'CUSTOMER_API_KEY_CUSTODY_APPROVED')
  }

  if (
    input.authMode === 'local-cli-credential' &&
    (input.provider === 'gemini' || input.deploymentProfile === 'cloud')
  )
    return deny(
      input,
      'LOCAL_CLI_CREDENTIAL_UNSUPPORTED',
      'Use an API key or supported cloud-provider identity; do not import another client credential cache.',
    )

  if (input.provider === 'claude') {
    if (!validEvidence(input, 'previously-approved'))
      return deny(
        input,
        'CLAUDE_PREVIOUS_APPROVAL_REQUIRED',
        'Attach Anthropic previously-approved evidence URI, date, and SHA-256; otherwise use an API key or supported cloud provider.',
        'previously-approved',
      )
    return allow(input, 'CLAUDE_PREVIOUS_APPROVAL_VERIFIED')
  }

  if (input.provider === 'codex') {
    if (input.deploymentProfile === 'cloud') {
      if (!validEvidence(input, 'third-party-application-approval'))
        return deny(
          input,
          'CODEX_MANAGED_SUBSCRIPTION_EVIDENCE_REQUIRED',
          'Attach dated Sign in with ChatGPT third-party application registration/approval URI and SHA-256.',
          'third-party-application-approval',
        )
      return allow(input, 'CODEX_MANAGED_SUBSCRIPTION_APPROVED')
    }
    if (!input.trustedPrivateRunner)
      return deny(
        input,
        'CODEX_TRUSTED_PRIVATE_RUNNER_REQUIRED',
        'Run the documented Codex PKCE/device-code flow only on a trusted private runner.',
      )
    return allow(input, 'CODEX_PRIVATE_RUNNER_SUPPORTED')
  }

  return deny(
    input,
    'PROVIDER_AUTH_MODE_UNSUPPORTED',
    'Select a supported API or cloud-provider authentication mode.',
  )
}

export function assertProviderAuthCapability(
  input: CapabilityDecisionInput,
): ProviderCapabilityDecision {
  const decision = decideProviderAuthCapability(input)
  if (decision.outcome === 'deny')
    throw new ProviderAuthError(
      decision.reasonCode,
      decision.actionableMessage,
      true,
    )
  return decision
}

export interface ProviderAuthCapabilitySource {
  resolve(
    provider: ProviderId,
    authMode: ProviderAuthMode,
  ): CapabilityDecisionInput
}

export class StaticProviderAuthCapabilitySource implements ProviderAuthCapabilitySource {
  readonly #deploymentProfile: DeploymentProfile
  readonly #evidenceVersion: number
  readonly #featureFlags: ProviderAuthFeatureFlags
  readonly #trustedPrivateRunner: boolean
  readonly #evidenceProvider:
    | ((
        provider: ProviderId,
        authMode: ProviderAuthMode,
      ) => ProviderAuthEvidence | undefined)
    | undefined

  constructor(options: {
    deploymentProfile: DeploymentProfile
    evidenceVersion: number
    featureFlags: ProviderAuthFeatureFlags
    trustedPrivateRunner?: boolean
    evidenceProvider?: (
      provider: ProviderId,
      authMode: ProviderAuthMode,
    ) => ProviderAuthEvidence | undefined
  }) {
    this.#deploymentProfile = options.deploymentProfile
    this.#evidenceVersion = options.evidenceVersion
    this.#featureFlags = options.featureFlags
    this.#trustedPrivateRunner = options.trustedPrivateRunner ?? false
    this.#evidenceProvider = options.evidenceProvider
  }

  resolve(provider: ProviderId, authMode: ProviderAuthMode) {
    return {
      provider,
      authMode,
      deploymentProfile: this.#deploymentProfile,
      evidenceVersion: this.#evidenceVersion,
      featureFlags: this.#featureFlags,
      trustedPrivateRunner: this.#trustedPrivateRunner,
      evidence: this.#evidenceProvider?.(provider, authMode),
    }
  }
}

export interface ProviderAuthKillSwitchAuthority {
  assertNewWork(
    provider: ProviderId,
    authMode: ProviderAuthMode,
  ): void | Promise<void>
}

export interface StoredProviderCredential extends ProviderAuthProfileMetadata {
  envelope: EnvelopeV1 | null
}

export interface ProviderAuthKillSwitchRecord extends ProviderAuthScope {
  provider: ProviderId
  authMode: ProviderAuthMode
  enabled: boolean
  termsEvidenceHash: string
  version: number
}

export interface ProviderAuthRepository {
  putProfile(
    profile: StoredProviderCredential,
    expectedVersion: number | null,
  ): Promise<void>
  getProfile(
    scope: ProviderAuthScope,
    profileId: string,
  ): Promise<StoredProviderCredential | undefined>
  listProfiles(scope: ProviderAuthScope): Promise<ProviderAuthProfileMetadata[]>
  acquireRefreshLock(input: {
    scope: ProviderAuthScope
    profileId: string
    ownerId: string
    expiresAt: string
  }): Promise<boolean>
  releaseRefreshLock(input: {
    scope: ProviderAuthScope
    profileId: string
    ownerId: string
  }): Promise<void>
  putOAuthTransaction(transaction: OAuthTransaction): Promise<void>
  getOAuthTransaction(
    scope: ProviderAuthScope,
    transactionId: string,
  ): Promise<OAuthTransaction | undefined>
  findOAuthTransactionByStateDigest(
    scope: ProviderAuthScope,
    stateDigest: string,
  ): Promise<OAuthTransaction | undefined>
  putUsage(entry: ProviderUsageLedgerEntry): Promise<void>
  listUsage(scope: ProviderAuthScope): Promise<ProviderUsageLedgerEntry[]>
  putKillSwitch(
    record: ProviderAuthKillSwitchRecord,
    expectedVersion: number | null,
  ): Promise<void>
  getKillSwitch(
    scope: ProviderAuthScope,
    provider: ProviderId,
    authMode: ProviderAuthMode,
  ): Promise<ProviderAuthKillSwitchRecord | undefined>
}

const scopeKey = (scope: ProviderAuthScope) =>
  `${scope.tenantId}\0${scope.organizationId}\0${scope.workspaceId}`
const profileKey = (scope: ProviderAuthScope, profileId: string) =>
  `${scopeKey(scope)}\0${profileId}`

export class InMemoryProviderAuthRepository implements ProviderAuthRepository {
  readonly #profiles = new Map<string, StoredProviderCredential>()
  readonly #locks = new Map<string, { ownerId: string; expiresAt: number }>()
  readonly #oauth = new Map<string, OAuthTransaction>()
  readonly #usage: ProviderUsageLedgerEntry[] = []
  readonly #killSwitches = new Map<string, ProviderAuthKillSwitchRecord>()

  async putProfile(
    profile: StoredProviderCredential,
    expectedVersion: number | null,
  ) {
    const parsed = providerAuthProfileMetadataSchema.parse(profile)
    const key = profileKey(parsed, parsed.profileId)
    const current = this.#profiles.get(key)
    if (
      (expectedVersion === null && current) ||
      (expectedVersion !== null && current?.version !== expectedVersion)
    )
      throw new ProviderAuthError('PROVIDER_AUTH_VERSION_CONFLICT')
    this.#profiles.set(key, structuredClone(profile))
  }
  async getProfile(scope: ProviderAuthScope, profileId: string) {
    const found = this.#profiles.get(profileKey(scope, profileId))
    return found ? structuredClone(found) : undefined
  }
  async listProfiles(scope: ProviderAuthScope) {
    return [...this.#profiles.values()]
      .filter((entry) => scopeKey(entry) === scopeKey(scope))
      .map(({ envelope: _envelope, ...metadata }) => structuredClone(metadata))
  }
  async acquireRefreshLock(input: {
    scope: ProviderAuthScope
    profileId: string
    ownerId: string
    expiresAt: string
  }) {
    const key = profileKey(input.scope, input.profileId)
    const current = this.#locks.get(key)
    if (current && current.expiresAt > Date.now()) return false
    this.#locks.set(key, {
      ownerId: input.ownerId,
      expiresAt: Date.parse(input.expiresAt),
    })
    return true
  }
  async releaseRefreshLock(input: {
    scope: ProviderAuthScope
    profileId: string
    ownerId: string
  }) {
    const key = profileKey(input.scope, input.profileId)
    if (this.#locks.get(key)?.ownerId === input.ownerId) this.#locks.delete(key)
  }
  async putOAuthTransaction(transaction: OAuthTransaction) {
    const parsed = oauthTransactionSchema.parse(transaction)
    const key = profileKey(parsed, parsed.transactionId)
    const current = this.#oauth.get(key)
    if (current && current.version >= parsed.version)
      throw new ProviderAuthError('OAUTH_TRANSACTION_VERSION_CONFLICT')
    this.#oauth.set(key, structuredClone(parsed))
  }
  async getOAuthTransaction(scope: ProviderAuthScope, transactionId: string) {
    const found = this.#oauth.get(profileKey(scope, transactionId))
    return found ? structuredClone(found) : undefined
  }
  async findOAuthTransactionByStateDigest(
    scope: ProviderAuthScope,
    stateDigest: string,
  ) {
    const found = [...this.#oauth.values()].find(
      (entry) =>
        scopeKey(entry) === scopeKey(scope) &&
        entry.stateDigest === stateDigest,
    )
    return found ? structuredClone(found) : undefined
  }
  async putUsage(entry: ProviderUsageLedgerEntry) {
    this.#usage.push(
      structuredClone(providerUsageLedgerEntrySchema.parse(entry)),
    )
  }
  async listUsage(scope: ProviderAuthScope) {
    return this.#usage
      .filter((entry) => scopeKey(entry) === scopeKey(scope))
      .map((entry) => structuredClone(entry))
  }
  async putKillSwitch(
    record: ProviderAuthKillSwitchRecord,
    expectedVersion: number | null,
  ) {
    const key = `${scopeKey(record)}\0${record.provider}\0${record.authMode}`
    const current = this.#killSwitches.get(key)
    if (
      (expectedVersion === null && current) ||
      (expectedVersion !== null && current?.version !== expectedVersion)
    )
      throw new ProviderAuthError('PROVIDER_AUTH_VERSION_CONFLICT')
    this.#killSwitches.set(key, structuredClone(record))
  }
  async getKillSwitch(
    scope: ProviderAuthScope,
    provider: ProviderId,
    authMode: ProviderAuthMode,
  ) {
    const found = this.#killSwitches.get(
      `${scopeKey(scope)}\0${provider}\0${authMode}`,
    )
    return found ? structuredClone(found) : undefined
  }
}

interface ProviderCredentialSecret {
  accessToken: string
  refreshToken: string | null
}

const credentialContext = (
  scope: ProviderAuthScope,
  recordId: string,
): EncryptionContextV1 => ({
  ...scope,
  recordType: 'provider_credential',
  recordId,
})

export class ProviderCredentialVault {
  readonly #repository: ProviderAuthRepository
  readonly #encryption: EnvelopeEncryption
  readonly #runtimeAuthority: RuntimeDataPlaneAuthority
  readonly #capability: ProviderAuthCapabilitySource
  readonly #killSwitch: ProviderAuthKillSwitchAuthority
  readonly #leaseTtlMs: number

  constructor(options: {
    repository: ProviderAuthRepository
    encryption: EnvelopeEncryption
    runtimeAuthority: RuntimeDataPlaneAuthority
    capability: ProviderAuthCapabilitySource
    killSwitch: ProviderAuthKillSwitchAuthority
    leaseTtlMs?: number
  }) {
    this.#repository = options.repository
    this.#encryption = options.encryption
    this.#runtimeAuthority = options.runtimeAuthority
    this.#capability = options.capability
    this.#killSwitch = options.killSwitch
    this.#leaseTtlMs = Math.min(options.leaseTtlMs ?? 60_000, 5 * 60_000)
  }

  async #assertNewWork(provider: ProviderId, authMode: ProviderAuthMode) {
    assertProviderAuthCapability(this.#capability.resolve(provider, authMode))
    await this.#killSwitch.assertNewWork(provider, authMode)
  }

  async connect(input: {
    scope: ProviderAuthScope
    profileId?: string
    provider: ProviderId
    authMode: ProviderAuthMode
    accessToken: string
    refreshToken?: string | null
    expiresAt?: string | null
  }): Promise<ProviderAuthProfileMetadata> {
    await this.#assertNewWork(input.provider, input.authMode)
    if (input.accessToken.length < 8)
      throw new ProviderAuthError('PROVIDER_CREDENTIAL_INVALID')
    const profileId = input.profileId ?? randomUUID()
    const bytes = Buffer.from(
      JSON.stringify({
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? null,
      } satisfies ProviderCredentialSecret),
    )
    try {
      const envelope = await this.#encryption.encrypt(
        credentialContext(input.scope, profileId),
        bytes,
      )
      const profile: StoredProviderCredential = {
        schemaVersion: PROVIDER_AUTH_CONTRACT_VERSION,
        ...input.scope,
        profileId,
        provider: input.provider,
        authMode: input.authMode,
        state: 'active',
        credentialVersion: 1,
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
        disconnectedAt: null,
        cryptoErasedAt: null,
        version: 1,
        envelope,
      }
      await this.#repository.putProfile(profile, null)
      const { envelope: _envelope, ...metadata } = profile
      return metadata
    } finally {
      bytes.fill(0)
    }
  }

  async #decrypt(
    scope: ProviderAuthScope,
    profile: StoredProviderCredential,
  ): Promise<ProviderCredentialSecret> {
    if (!profile.envelope)
      throw new ProviderAuthError('PROVIDER_CREDENTIAL_CRYPTO_ERASED')
    const bytes = await this.#encryption.decrypt(
      credentialContext(scope, profile.profileId),
      profile.envelope,
    )
    try {
      return JSON.parse(
        Buffer.from(bytes).toString('utf8'),
      ) as ProviderCredentialSecret
    } finally {
      bytes.fill(0)
    }
  }

  async leaseToRuntime(input: {
    scope: ProviderAuthScope
    profileId: string
    runtimeAuthorization: string
    runtimeId: string
    generation: number
    now?: Date
  }): Promise<{
    accessToken: string
    leaseExpiresAt: string
    credentialVersion: number
    runtimeClaims: RuntimeCredentialClaims
  }> {
    const now = input.now ?? new Date()
    const claims = await this.#runtimeAuthority.verify({
      authorization: input.runtimeAuthorization,
      action: 'provider-credential.lease',
      ...input.scope,
      runtimeId: input.runtimeId,
      generation: input.generation,
      now,
    })
    const profile = await this.#repository.getProfile(
      input.scope,
      input.profileId,
    )
    if (!profile) throw new ProviderAuthError('PROVIDER_PROFILE_NOT_FOUND')
    await this.#assertNewWork(profile.provider, profile.authMode)
    if (profile.state !== 'active')
      throw new ProviderAuthError('PROVIDER_CREDENTIAL_REVOKED')
    if (profile.expiresAt && Date.parse(profile.expiresAt) <= now.getTime()) {
      await this.#repository.putProfile(
        { ...profile, state: 'expired', version: profile.version + 1 },
        profile.version,
      )
      throw new ProviderAuthError('PROVIDER_CREDENTIAL_STALE')
    }
    const secret = await this.#decrypt(input.scope, profile)
    return {
      accessToken: secret.accessToken,
      leaseExpiresAt: new Date(now.getTime() + this.#leaseTtlMs).toISOString(),
      credentialVersion: profile.credentialVersion,
      runtimeClaims: claims,
    }
  }

  async refresh(input: {
    scope: ProviderAuthScope
    profileId: string
    refresh: (refreshToken: string) => Promise<{
      accessToken: string
      refreshToken?: string | undefined
      expiresAt: string
    }>
  }): Promise<ProviderAuthProfileMetadata> {
    const candidate = await this.#repository.getProfile(
      input.scope,
      input.profileId,
    )
    if (!candidate) throw new ProviderAuthError('PROVIDER_PROFILE_NOT_FOUND')
    await this.#assertNewWork(candidate.provider, candidate.authMode)
    const ownerId = randomUUID()
    const acquired = await this.#repository.acquireRefreshLock({
      scope: input.scope,
      profileId: input.profileId,
      ownerId,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    })
    if (!acquired) throw new ProviderAuthError('PROVIDER_REFRESH_IN_PROGRESS')
    try {
      const profile = await this.#repository.getProfile(
        input.scope,
        input.profileId,
      )
      if (!profile || profile.state !== 'active')
        throw new ProviderAuthError('PROVIDER_CREDENTIAL_REVOKED')
      const current = await this.#decrypt(input.scope, profile)
      if (!current.refreshToken)
        throw new ProviderAuthError('PROVIDER_REFRESH_TOKEN_MISSING')
      const next = await input.refresh(current.refreshToken)
      const bytes = Buffer.from(
        JSON.stringify({
          accessToken: next.accessToken,
          refreshToken: next.refreshToken ?? current.refreshToken,
        } satisfies ProviderCredentialSecret),
      )
      try {
        const envelope = await this.#encryption.encrypt(
          credentialContext(input.scope, profile.profileId),
          bytes,
        )
        const updated: StoredProviderCredential = {
          ...profile,
          envelope,
          credentialVersion: profile.credentialVersion + 1,
          expiresAt: next.expiresAt,
          version: profile.version + 1,
        }
        await this.#repository.putProfile(updated, profile.version)
        const { envelope: _envelope, ...metadata } = updated
        return metadata
      } finally {
        bytes.fill(0)
      }
    } finally {
      await this.#repository.releaseRefreshLock({
        scope: input.scope,
        profileId: input.profileId,
        ownerId,
      })
    }
  }

  async rotate(scope: ProviderAuthScope, profileId: string) {
    const profile = await this.#repository.getProfile(scope, profileId)
    if (!profile?.envelope)
      throw new ProviderAuthError('PROVIDER_PROFILE_NOT_FOUND')
    const updated = {
      ...profile,
      envelope: await this.#encryption.rotate(
        credentialContext(scope, profileId),
        profile.envelope,
      ),
      credentialVersion: profile.credentialVersion + 1,
      version: profile.version + 1,
    }
    await this.#repository.putProfile(updated, profile.version)
    const { envelope: _envelope, ...metadata } = updated
    return metadata
  }

  async revoke(scope: ProviderAuthScope, profileId: string) {
    return this.#transition(scope, profileId, 'revoked')
  }
  async disconnect(scope: ProviderAuthScope, profileId: string) {
    await this.#transition(scope, profileId, 'disconnected')
    return this.cryptoErase(scope, profileId)
  }
  async cryptoErase(scope: ProviderAuthScope, profileId: string) {
    const profile = await this.#repository.getProfile(scope, profileId)
    if (!profile) throw new ProviderAuthError('PROVIDER_PROFILE_NOT_FOUND')
    const updated: StoredProviderCredential = {
      ...profile,
      state: 'crypto-erased',
      envelope: null,
      cryptoErasedAt: new Date().toISOString(),
      version: profile.version + 1,
    }
    await this.#repository.putProfile(updated, profile.version)
    const { envelope: _envelope, ...metadata } = updated
    return metadata
  }
  async #transition(
    scope: ProviderAuthScope,
    profileId: string,
    state: 'revoked' | 'disconnected',
  ) {
    const profile = await this.#repository.getProfile(scope, profileId)
    if (!profile) throw new ProviderAuthError('PROVIDER_PROFILE_NOT_FOUND')
    const now = new Date().toISOString()
    const updated: StoredProviderCredential = {
      ...profile,
      state,
      revokedAt: state === 'revoked' ? now : profile.revokedAt,
      disconnectedAt: state === 'disconnected' ? now : profile.disconnectedAt,
      version: profile.version + 1,
    }
    await this.#repository.putProfile(updated, profile.version)
    const { envelope: _envelope, ...metadata } = updated
    return metadata
  }
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex')
const base64url = (value: Uint8Array) =>
  Buffer.from(value).toString('base64url')

export class DurableOAuthCoordinator {
  readonly #repository: ProviderAuthRepository
  readonly #encryption: EnvelopeEncryption
  constructor(
    repository: ProviderAuthRepository,
    encryption: EnvelopeEncryption,
  ) {
    this.#repository = repository
    this.#encryption = encryption
  }

  async startPkce(input: {
    scope: ProviderAuthScope
    provider: ProviderId
    ttlMs?: number
    now?: Date
  }) {
    const now = input.now ?? new Date()
    const transactionId = randomUUID()
    const state = base64url(randomBytes(32))
    const verifier = base64url(randomBytes(48))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const bytes = Buffer.from(JSON.stringify({ verifier }))
    try {
      const secretEnvelope = await this.#encryption.encrypt(
        credentialContext(input.scope, `oauth-${transactionId}`),
        bytes,
      )
      const transaction = oauthTransactionSchema.parse({
        schemaVersion: PROVIDER_AUTH_CONTRACT_VERSION,
        ...input.scope,
        transactionId,
        provider: input.provider,
        flowKind: 'authorization-code-pkce',
        stateDigest: sha256(state),
        pkceChallenge: challenge,
        secretEnvelope,
        status: 'pending',
        expiresAt: new Date(
          now.getTime() + (input.ttlMs ?? 10 * 60_000),
        ).toISOString(),
        version: 1,
      })
      await this.#repository.putOAuthTransaction(transaction)
      return { transactionId, state, verifier: undefined, challenge }
    } finally {
      bytes.fill(0)
    }
  }

  async consumeCallback(input: {
    scope: ProviderAuthScope
    state: string
    now?: Date
  }): Promise<{ transactionId: string; pkceVerifier: string }> {
    const transaction =
      await this.#repository.findOAuthTransactionByStateDigest(
        input.scope,
        sha256(input.state),
      )
    return this.#consumeSecret(input.scope, transaction, input.now)
  }

  async startDeviceCode(input: {
    scope: ProviderAuthScope
    provider: ProviderId
    deviceCode: string
    expiresAt: string
  }) {
    const transactionId = randomUUID()
    const bytes = Buffer.from(JSON.stringify({ deviceCode: input.deviceCode }))
    try {
      const secretEnvelope = await this.#encryption.encrypt(
        credentialContext(input.scope, `oauth-${transactionId}`),
        bytes,
      )
      const transaction = oauthTransactionSchema.parse({
        schemaVersion: PROVIDER_AUTH_CONTRACT_VERSION,
        ...input.scope,
        transactionId,
        provider: input.provider,
        flowKind: 'device-code',
        stateDigest: null,
        pkceChallenge: null,
        secretEnvelope,
        status: 'pending',
        expiresAt: input.expiresAt,
        version: 1,
      })
      await this.#repository.putOAuthTransaction(transaction)
      return { transactionId }
    } finally {
      bytes.fill(0)
    }
  }

  async consumeDeviceCode(input: {
    scope: ProviderAuthScope
    transactionId: string
    now?: Date
  }): Promise<{ transactionId: string; deviceCode: string }> {
    const transaction = await this.#repository.getOAuthTransaction(
      input.scope,
      input.transactionId,
    )
    const consumed = await this.#consumeSecret(
      input.scope,
      transaction,
      input.now,
    )
    return {
      transactionId: consumed.transactionId,
      deviceCode: consumed.pkceVerifier,
    }
  }

  async #consumeSecret(
    scope: ProviderAuthScope,
    transaction: OAuthTransaction | undefined,
    now = new Date(),
  ) {
    if (!transaction || transaction.status !== 'pending')
      throw new ProviderAuthError('OAUTH_TRANSACTION_REJECTED')
    if (Date.parse(transaction.expiresAt) <= now.getTime()) {
      await this.#repository.putOAuthTransaction({
        ...transaction,
        status: 'expired',
        version: transaction.version + 1,
      })
      throw new ProviderAuthError('OAUTH_TRANSACTION_EXPIRED')
    }
    const envelope = transaction.secretEnvelope as unknown as EnvelopeV1
    const bytes = await this.#encryption.decrypt(
      credentialContext(scope, `oauth-${transaction.transactionId}`),
      envelope,
    )
    try {
      const secret = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
        verifier?: string
        deviceCode?: string
      }
      await this.#repository.putOAuthTransaction({
        ...transaction,
        secretEnvelope: {},
        status: 'consumed',
        version: transaction.version + 1,
      })
      return {
        transactionId: transaction.transactionId,
        pkceVerifier: secret.verifier ?? secret.deviceCode ?? '',
      }
    } finally {
      bytes.fill(0)
    }
  }
}

export class ProviderUsageLedger {
  readonly #repository: ProviderAuthRepository
  constructor(repository: ProviderAuthRepository) {
    this.#repository = repository
  }
  async record(entry: ProviderUsageLedgerEntry) {
    const parsed = providerUsageLedgerEntrySchema.parse(entry)
    if (
      parsed.billingMode === 'subscription-quota' &&
      (!parsed.estimated || parsed.monetaryAmountMicros !== null)
    )
      throw new ProviderAuthError(
        'SUBSCRIPTION_USAGE_MUST_BE_ESTIMATED_NON_BILLABLE',
      )
    if (
      parsed.billingMode === 'customer-api-billing' &&
      parsed.authMode !== 'customer-api-key'
    )
      throw new ProviderAuthError('AUTH_BILLING_MODE_MISMATCH')
    if (
      parsed.billingMode === 'platform-credit' &&
      parsed.authMode !== 'platform-credit'
    )
      throw new ProviderAuthError('AUTH_BILLING_MODE_MISMATCH')
    await this.#repository.putUsage(parsed)
  }
  list(scope: ProviderAuthScope) {
    return this.#repository.listUsage(scope)
  }
}

export type KillSwitchState = Readonly<
  Partial<Record<`${ProviderId}:${ProviderAuthMode}`, boolean>>
>

export class ProviderAuthKillSwitch implements ProviderAuthKillSwitchAuthority {
  #state: KillSwitchState
  constructor(initial: KillSwitchState = {}) {
    this.#state = initial
  }
  update(next: KillSwitchState) {
    this.#state = next
  }
  assertNewWork(provider: ProviderId, authMode: ProviderAuthMode) {
    if (this.#state[`${provider}:${authMode}`] !== true)
      throw new ProviderAuthError(
        'PROVIDER_AUTH_KILL_SWITCH_ACTIVE',
        `New ${provider}/${authMode} work is safely halted; disconnect or migrate the auth profile.`,
        true,
      )
  }
}

export class RepositoryProviderAuthKillSwitch implements ProviderAuthKillSwitchAuthority {
  readonly #repository: ProviderAuthRepository
  readonly #scope: ProviderAuthScope
  constructor(repository: ProviderAuthRepository, scope: ProviderAuthScope) {
    this.#repository = repository
    this.#scope = scope
  }
  async assertNewWork(provider: ProviderId, authMode: ProviderAuthMode) {
    const record = await this.#repository.getKillSwitch(
      this.#scope,
      provider,
      authMode,
    )
    if (record?.enabled !== true)
      throw new ProviderAuthError(
        'PROVIDER_AUTH_KILL_SWITCH_ACTIVE',
        `New ${provider}/${authMode} work is safely halted; disconnect or migrate the auth profile.`,
        true,
      )
  }
}
