import { createHash } from 'node:crypto'
import type {
  CreditReservation,
  CreditSettlement,
} from '@persistent-codex/billing-platform'
import {
  assertEntitled,
  type EntitlementFeature,
} from '@persistent-codex/deployment-profiles'
import {
  evaluateProductionBudget,
  transitionProductionRollout,
  type ProductionBudgetObservation,
  type ProductionBudgetPolicy,
  type ProductionRolloutRecord,
  type ProductionRolloutStage,
} from '@persistent-codex/production-readiness'
import type { CapacityVector } from '@persistent-codex/production-topology/contracts'
import type {
  ProviderAuthMode,
  ProviderAuthProfileMetadata,
  ProviderAuthScope,
} from '@persistent-codex/provider-auth'
import type { ProviderId } from '@persistent-codex/provider-platform'
import type {
  ManagedTenant,
  ProvisioningJob,
  TenantRuntime,
} from '@persistent-codex/tenant-runtime'
import {
  MANAGED_CLOUD_CONTRACT_VERSION,
  domainVerificationSchema,
  managedCloudPlanSchema,
  managedUsageEntrySchema,
  onboardingInputSchema,
  onboardingRecordSchema,
  type DomainVerification,
  type ManagedCloudPlan,
  type ManagedCloudScope,
  type ManagedUsageEntry,
  type OnboardingInput,
  type OnboardingRecord,
} from './contracts'

export * from './contracts'

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')
const deterministicId = (prefix: string, ...parts: string[]) =>
  `${prefix}_${digest(parts.join(':')).slice(0, 24)}`

export class ManagedCloudError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'ManagedCloudError'
    this.code = code
  }
}

export interface ManagedCloudRepository {
  getOnboarding(
    scope: ManagedCloudScope,
    idempotencyKey: string,
  ): Promise<OnboardingRecord | undefined>
  putOnboarding(
    value: OnboardingRecord,
    expectedVersion: number | null,
  ): Promise<void>
  getDomain(scope: ManagedCloudScope): Promise<DomainVerification | undefined>
  putDomain(
    value: DomainVerification,
    expectedVersion: number | null,
  ): Promise<void>
}

export class InMemoryManagedCloudRepository implements ManagedCloudRepository {
  readonly #onboardings = new Map<string, OnboardingRecord>()
  readonly #domains = new Map<string, DomainVerification>()
  #scope(scope: ManagedCloudScope) {
    return `${scope.tenantId}:${scope.organizationId}:${scope.workspaceId}`
  }
  #onboarding(scope: ManagedCloudScope, key: string) {
    return `${this.#scope(scope)}:${key}`
  }
  async getOnboarding(scope: ManagedCloudScope, key: string) {
    return this.#onboardings.get(this.#onboarding(scope, key))
  }
  async putOnboarding(value: OnboardingRecord, expectedVersion: number | null) {
    const key = this.#onboarding(value, value.idempotencyKey)
    const current = this.#onboardings.get(key)
    if ((current?.version ?? null) !== expectedVersion)
      throw new ManagedCloudError('ONBOARDING_VERSION_CONFLICT')
    this.#onboardings.set(key, onboardingRecordSchema.parse(value))
  }
  async getDomain(scope: ManagedCloudScope) {
    return this.#domains.get(this.#scope(scope))
  }
  async putDomain(value: DomainVerification, expectedVersion: number | null) {
    const key = this.#scope(value)
    const current = this.#domains.get(key)
    if ((current?.version ?? null) !== expectedVersion)
      throw new ManagedCloudError('DOMAIN_VERSION_CONFLICT')
    this.#domains.set(key, domainVerificationSchema.parse(value))
  }
}

export interface TenantProvisioningPort {
  provisionTenant(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    displayName: string
    regionId: string
    capacity: CapacityVector
    retentionDays: number
    retentionPolicyId: string | null
    domain: string | null
    idempotencyKey: string
  }): Promise<{
    tenant: ManagedTenant
    runtime: TenantRuntime
    job: ProvisioningJob
  }>
}

export interface AccountWorkspacePort {
  ensure(input: {
    scope: ManagedCloudScope
    accountId: string
    issuer: string
    subject: string
    principalDigest: string
    displayName: string
    workspaceName: string
    idempotencyKey: string
  }): Promise<void>
}

export interface ProviderConnectionPort {
  ensureConnected(input: {
    scope: ProviderAuthScope
    profileId?: string
    provider: ProviderId
    authMode: ProviderAuthMode
    accessToken: string
  }): Promise<ProviderAuthProfileMetadata>
}

interface ProviderProfileLookup {
  getProfile(
    scope: ProviderAuthScope,
    profileId: string,
  ): Promise<
    | (ProviderAuthProfileMetadata & {
        provider: ProviderId
        authMode: ProviderAuthMode
      })
    | undefined
  >
}

interface ProviderVaultConnect {
  connect(input: {
    scope: ProviderAuthScope
    profileId?: string
    provider: ProviderId
    authMode: ProviderAuthMode
    accessToken: string
  }): Promise<ProviderAuthProfileMetadata>
}

export class VaultProviderConnection implements ProviderConnectionPort {
  readonly #repository: ProviderProfileLookup
  readonly #vault: ProviderVaultConnect
  constructor(options: {
    repository: ProviderProfileLookup
    vault: ProviderVaultConnect
  }) {
    this.#repository = options.repository
    this.#vault = options.vault
  }
  async ensureConnected(
    input: Parameters<ProviderConnectionPort['ensureConnected']>[0],
  ) {
    if (!input.profileId)
      throw new ManagedCloudError('PROVIDER_PROFILE_ID_REQUIRED')
    const existing = await this.#repository.getProfile(
      input.scope,
      input.profileId,
    )
    if (existing) {
      if (
        existing.provider !== input.provider ||
        existing.authMode !== input.authMode ||
        existing.state !== 'active'
      )
        throw new ManagedCloudError('PROVIDER_CONNECTION_CONFLICT')
      return existing
    }
    return this.#vault.connect(input)
  }
}

export interface DurableTaskPort {
  start(input: {
    scope: ManagedCloudScope
    provider: ProviderId
    prompt: string
    idempotencyKey: string
  }): Promise<{ taskId: string; state: 'running' | 'completed' }>
  replay(
    scope: ManagedCloudScope,
    taskId: string,
  ): Promise<{
    taskId: string
    state: 'running' | 'completed' | 'failed' | 'interrupted'
    output: string | null
  }>
}

export interface ManagedCloudCommercialPolicyPort {
  assignPlan(scope: ManagedCloudScope, plan: ManagedCloudPlan): Promise<void>
  admitFirstTask(input: {
    scope: ManagedCloudScope
    plan: ManagedCloudPlan
  }): Promise<{ allowed: boolean; reason: string; inFlightPolicy: string }>
}

export interface ManagedCloudPlanCatalogPort {
  resolve(planId: string, planVersion: number): Promise<ManagedCloudPlan>
}

export interface ManagedCloudUsageViewPort {
  listUsage(scope: ManagedCloudScope): Promise<ManagedUsageEntry[]>
}

export interface RolloutAdmissionPort {
  assertAdmission(input: {
    scope: ManagedCloudScope
    provider: ProviderId
    authMode: ProviderAuthMode
  }): void | Promise<void>
}

export interface ManagedCloudLifecyclePort {
  exportTenant(
    input: ManagedCloudScope & {
      idempotencyKey: string
    },
  ): Promise<{ jobId: string; state: string }>
  deleteTenant(
    input: ManagedCloudScope & {
      idempotencyKey: string
    },
  ): Promise<{ jobId: string; state: string }>
}

export interface ManagedCloudCredentialLifecyclePort {
  listProfiles(
    scope: ManagedCloudScope,
  ): Promise<Array<{ profileId: string; state: string }>>
  revoke(scope: ManagedCloudScope, profileId: string): Promise<unknown>
  cryptoErase(scope: ManagedCloudScope, profileId: string): Promise<unknown>
}

export interface ManagedTenantDeletePort {
  deleteTenant(input: {
    tenantId: string
    organizationId: string
    idempotencyKey: string
  }): Promise<{ tenant: { state: string } }>
}

export class ManagedCloudLifecycleService {
  readonly #lifecycle: ManagedCloudLifecyclePort
  readonly #credentials: ManagedCloudCredentialLifecyclePort
  readonly #tenants: ManagedTenantDeletePort
  constructor(options: {
    lifecycle: ManagedCloudLifecyclePort
    credentials: ManagedCloudCredentialLifecyclePort
    tenants: ManagedTenantDeletePort
  }) {
    this.#lifecycle = options.lifecycle
    this.#credentials = options.credentials
    this.#tenants = options.tenants
  }
  exportTenant(scope: ManagedCloudScope, idempotencyKey: string) {
    return this.#lifecycle.exportTenant({ ...scope, idempotencyKey })
  }
  async deleteTenant(scope: ManagedCloudScope, idempotencyKey: string) {
    const lifecycle = await this.#lifecycle.deleteTenant({
      ...scope,
      idempotencyKey: `${idempotencyKey}:lifecycle`,
    })
    const profiles = await this.#credentials.listProfiles(scope)
    let cryptoErased = 0
    for (const profile of profiles) {
      if (profile.state !== 'crypto-erased') {
        await this.#credentials.revoke(scope, profile.profileId)
        await this.#credentials.cryptoErase(scope, profile.profileId)
        cryptoErased += 1
      }
    }
    const tenant = await this.#tenants.deleteTenant({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      idempotencyKey: `${idempotencyKey}:tenant`,
    })
    if (tenant.tenant.state !== 'deleted')
      throw new ManagedCloudError('TENANT_DELETE_INCOMPLETE')
    return {
      lifecycleJobId: lifecycle.jobId,
      lifecycleState: lifecycle.state,
      credentialsCryptoErased: cryptoErased,
      tenantState: tenant.tenant.state,
    }
  }
}

export interface ManagedCloudPushOutboxPort {
  enqueue(
    scope: ManagedCloudScope,
    input: {
      notificationId: string
      sessionId: string
      approvalId: string | null
      status: 'turn_completed' | 'approval_required'
    },
  ): Promise<number>
}

export interface ManagedCloudEmailOutboxPort {
  enqueue(input: {
    scope: ManagedCloudScope
    template: 'task-completed' | 'approval-required'
    taskId: string
    dedupeKey: string
  }): Promise<void>
}

export class ManagedCloudNotificationService {
  readonly #push: ManagedCloudPushOutboxPort
  readonly #email: ManagedCloudEmailOutboxPort
  constructor(options: {
    push: ManagedCloudPushOutboxPort
    email: ManagedCloudEmailOutboxPort
  }) {
    this.#push = options.push
    this.#email = options.email
  }
  async taskEvent(input: {
    scope: ManagedCloudScope
    taskId: string
    approvalId?: string | null
  }) {
    const approvalId = input.approvalId ?? null
    const kind = approvalId ? 'approval-required' : 'task-completed'
    const notificationId = deterministicId(
      'notification',
      input.scope.tenantId,
      input.taskId,
      kind,
    )
    const delivered = await this.#push.enqueue(input.scope, {
      notificationId,
      sessionId: input.taskId,
      approvalId,
      status: approvalId ? 'approval_required' : 'turn_completed',
    })
    await this.#email.enqueue({
      scope: input.scope,
      template: kind,
      taskId: input.taskId,
      dedupeKey: notificationId,
    })
    return { notificationId, pushRecipients: delivered, emailQueued: true }
  }
}

export class ManagedBetaAdmissionAuthority implements RolloutAdmissionPort {
  readonly #current: () => ProductionRolloutRecord
  readonly #providerKillSwitch: {
    assertNewWork(
      provider: ProviderId,
      authMode: ProviderAuthMode,
    ): void | Promise<void>
  }
  readonly #capacityAvailable: (scope: ManagedCloudScope) => boolean
  readonly #rateAllowed: (scope: ManagedCloudScope) => boolean
  constructor(options: {
    current: () => ProductionRolloutRecord
    providerKillSwitch: {
      assertNewWork(
        provider: ProviderId,
        authMode: ProviderAuthMode,
      ): void | Promise<void>
    }
    capacityAvailable: (scope: ManagedCloudScope) => boolean
    rateAllowed: (scope: ManagedCloudScope) => boolean
  }) {
    this.#current = options.current
    this.#providerKillSwitch = options.providerKillSwitch
    this.#capacityAvailable = options.capacityAvailable
    this.#rateAllowed = options.rateAllowed
  }
  async assertAdmission(input: {
    scope: ManagedCloudScope
    provider: ProviderId
    authMode: ProviderAuthMode
  }) {
    const rollout = this.#current()
    if (
      !rollout.featureFlagEnabled ||
      rollout.killSwitch ||
      !['internal', 'design_partner', 'limited_beta'].includes(rollout.stage)
    )
      throw new ManagedCloudError('MANAGED_BETA_ROLLOUT_HALTED')
    if (!this.#capacityAvailable(input.scope))
      throw new ManagedCloudError('MANAGED_BETA_CAPACITY_HALT')
    if (!this.#rateAllowed(input.scope))
      throw new ManagedCloudError('MANAGED_BETA_RATE_LIMIT')
    await this.#providerKillSwitch.assertNewWork(input.provider, input.authMode)
  }
}

const requiredPlanFeatures: readonly EntitlementFeature[] = [
  'cloud.managed-tenant-provisioning',
  'cloud.tenant-runtime-isolation',
  'cloud.tenant-capacity-budgets',
  'cloud.runtime-data-plane-credentials',
  'core.provider-adapters',
  'core.detached-runs',
]

export function assertManagedCloudPlan(planInput: ManagedCloudPlan): void {
  const plan = managedCloudPlanSchema.parse(planInput)
  const enabled = new Set<string>(plan.entitlements)
  for (const feature of requiredPlanFeatures) {
    assertEntitled('cloud', feature)
    if (!enabled.has(feature))
      throw new ManagedCloudError(`PLAN_ENTITLEMENT_DENIED:${feature}`)
  }
}

const stateOrder = [
  'signed_up',
  'tenant_ready',
  'provider_connected',
  'first_task_started',
  'completed',
] as const
const atLeast = (
  state: OnboardingRecord['state'],
  expected: OnboardingRecord['state'],
) => stateOrder.indexOf(state) >= stateOrder.indexOf(expected)

export class ManagedCloudOnboardingService {
  readonly #repository: ManagedCloudRepository
  readonly #accounts: AccountWorkspacePort
  readonly #provisioning: TenantProvisioningPort
  readonly #providers: ProviderConnectionPort
  readonly #tasks: DurableTaskPort
  readonly #rollout: RolloutAdmissionPort
  readonly #commercial: ManagedCloudCommercialPolicyPort
  readonly #catalog: ManagedCloudPlanCatalogPort

  constructor(options: {
    repository: ManagedCloudRepository
    accounts: AccountWorkspacePort
    provisioning: TenantProvisioningPort
    providers: ProviderConnectionPort
    tasks: DurableTaskPort
    rollout: RolloutAdmissionPort
    commercial: ManagedCloudCommercialPolicyPort
    catalog: ManagedCloudPlanCatalogPort
  }) {
    this.#repository = options.repository
    this.#accounts = options.accounts
    this.#provisioning = options.provisioning
    this.#providers = options.providers
    this.#tasks = options.tasks
    this.#rollout = options.rollout
    this.#commercial = options.commercial
    this.#catalog = options.catalog
  }

  async run(inputValue: OnboardingInput): Promise<OnboardingRecord> {
    const input = onboardingInputSchema.parse(inputValue)
    const plan = await this.#catalog.resolve(input.planId, input.planVersion)
    if (plan.planId !== input.planId || plan.planVersion !== input.planVersion)
      throw new ManagedCloudError('PLAN_CATALOG_CONFLICT')
    assertManagedCloudPlan(plan)
    const principalDigest = digest(
      `${input.principal.issuer}\0${input.principal.subject}`,
    )
    const seed = digest(`${principalDigest}:${input.idempotencyKey}`)
    const scope: ManagedCloudScope = {
      tenantId: deterministicId('tenant', seed),
      organizationId: deterministicId('tenant', seed),
      workspaceId: deterministicId('workspace', seed, input.workspaceName),
    }
    const accountId = deterministicId('account', seed)
    await this.#accounts.ensure({
      scope,
      accountId,
      issuer: input.principal.issuer,
      subject: input.principal.subject,
      principalDigest,
      displayName: input.displayName,
      workspaceName: input.workspaceName,
      idempotencyKey: `${input.idempotencyKey}:account-workspace`,
    })
    let record = await this.#repository.getOnboarding(
      scope,
      input.idempotencyKey,
    )
    if (record) {
      if (
        record.emailDigest !== principalDigest ||
        record.planId !== plan.planId ||
        record.planVersion !== plan.planVersion
      )
        throw new ManagedCloudError('ONBOARDING_IDEMPOTENCY_CONFLICT')
    } else {
      record = onboardingRecordSchema.parse({
        schemaVersion: MANAGED_CLOUD_CONTRACT_VERSION,
        ...scope,
        onboardingId: deterministicId('onboarding', input.idempotencyKey),
        accountId,
        emailDigest: principalDigest,
        state: 'signed_up',
        planId: plan.planId,
        planVersion: plan.planVersion,
        providerProfileId: null,
        firstTaskId: null,
        idempotencyKey: input.idempotencyKey,
        version: 1,
      })
      await this.#repository.putOnboarding(record, null)
    }
    // The WP24-backed assignment port is idempotent. Repeating it closes the
    // checkpoint gap when a process stops after persisting signup state.
    await this.#commercial.assignPlan(scope, plan)
    if (record.state === 'completed') return record

    await this.#rollout.assertAdmission({
      scope,
      provider: input.provider,
      authMode: input.authMode,
    })

    if (!atLeast(record.state, 'tenant_ready')) {
      const result = await this.#provisioning.provisionTenant({
        ...scope,
        displayName: input.displayName,
        regionId: input.regionId,
        capacity: plan.computeQuota,
        retentionDays: input.retentionDays,
        retentionPolicyId: `managed:${input.retentionDays}`,
        domain: input.domain,
        idempotencyKey: `${input.idempotencyKey}:tenant`,
      })
      if (
        result.tenant.state !== 'active' ||
        result.runtime.state !== 'ready' ||
        result.job.state !== 'completed'
      )
        throw new ManagedCloudError('TENANT_PROVISIONING_INCOMPLETE')
      record = await this.#advance(record, { state: 'tenant_ready' })
    }

    if (!atLeast(record.state, 'provider_connected')) {
      const profile = await this.#providers.ensureConnected({
        scope,
        profileId: deterministicId('provider', input.idempotencyKey),
        provider: input.provider,
        authMode: input.authMode,
        accessToken: input.accessToken,
      })
      record = await this.#advance(record, {
        state: 'provider_connected',
        providerProfileId: profile.profileId,
      })
    }

    if (!atLeast(record.state, 'first_task_started')) {
      const admission = await this.#commercial.admitFirstTask({
        scope,
        plan,
      })
      if (!admission.allowed) throw new ManagedCloudError(admission.reason)
      const task = await this.#tasks.start({
        scope,
        provider: input.provider,
        prompt: input.firstTaskPrompt,
        idempotencyKey: `${input.idempotencyKey}:first-task`,
      })
      record = await this.#advance(record, {
        state: 'first_task_started',
        firstTaskId: task.taskId,
      })
    }
    return this.#advance(record, { state: 'completed' })
  }

  async #advance(current: OnboardingRecord, patch: Partial<OnboardingRecord>) {
    const next = onboardingRecordSchema.parse({
      ...current,
      ...patch,
      version: current.version + 1,
    })
    await this.#repository.putOnboarding(next, current.version)
    return next
  }
}

const capacityKeys = [
  'cpuMillis',
  'memoryBytes',
  'pids',
  'ioBytesPerSecond',
  'diskBytes',
  'diskInodes',
  'diskIops',
  'egressBytesPerSecond',
  'egressRequestsPerMinute',
  'eventBytesPerSecond',
  'artifactBytes',
  'outputBytes',
  'corpusIndexBytes',
] as const

export function evaluateManagedCloudLimits(input: {
  plan: ManagedCloudPlan
  usage: readonly ManagedUsageEntry[]
  requestedCompute: CapacityVector
  requestedStorageBytes: number
}) {
  const plan = managedCloudPlanSchema.parse(input.plan)
  assertManagedCloudPlan(plan)
  for (const key of capacityKeys) {
    if (input.requestedCompute[key] > plan.computeQuota[key])
      return {
        allowed: false,
        reason: `HARD_LIMIT_${key.toUpperCase()}`,
        inFlightPolicy: 'safe-completion',
      } as const
  }
  if (input.requestedStorageBytes > plan.storageQuotaBytes)
    return {
      allowed: false,
      reason: 'HARD_LIMIT_STORAGE_BYTE',
      inFlightPolicy: 'safe-completion',
    } as const
  const usage = input.usage.map((entry) => managedUsageEntrySchema.parse(entry))
  const computeCpuMillis = usage
    .filter(
      (entry) => entry.category === 'compute' && entry.unit === 'cpu-millis',
    )
    .reduce((sum, entry) => sum + entry.quantity, 0)
  if (
    computeCpuMillis + input.requestedCompute.cpuMillis >
    plan.computeQuota.cpuMillis
  )
    return {
      allowed: false,
      reason: 'HARD_LIMIT_COMPUTE_USAGE',
      inFlightPolicy: 'safe-completion',
    } as const
  const storageBytes = usage
    .filter((entry) => entry.category === 'storage' && entry.unit === 'byte')
    .reduce((sum, entry) => sum + entry.quantity, 0)
  if (storageBytes + input.requestedStorageBytes > plan.storageQuotaBytes)
    return {
      allowed: false,
      reason: 'HARD_LIMIT_STORAGE_USAGE',
      inFlightPolicy: 'safe-completion',
    } as const
  const spend = usage.reduce(
    (sum, entry) =>
      sum + (entry.billable && entry.amountMicros ? entry.amountMicros : 0),
    0,
  )
  if (spend >= plan.monthlyBudgetMicros)
    return {
      allowed: false,
      reason: 'BUDGET_HALT',
      inFlightPolicy: 'safe-completion',
    } as const
  return {
    allowed: true,
    reason: 'WITHIN_POLICY',
    inFlightPolicy: 'safe-completion',
  } as const
}

export interface BillingPlatformCreditPort {
  reserveCredits(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    idempotencyKey: string
    operation: 'turn.start'
    maximumCreditsMicros: number
    runId: string
    operationReference: string
  }): Promise<CreditReservation>
  settleCredits(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    reservationId: string
    idempotencyKey: string
    measuredCreditsMicros: number
    usageStatus: 'measured' | 'estimated' | 'incomplete'
    outcome: 'completed' | 'failed' | 'interrupted' | 'incomplete'
    terminal: boolean
    usageDedupeKey: string
    runId?: string
  }): Promise<CreditSettlement>
}

export class ManagedCloudBillingService {
  readonly #billing: BillingPlatformCreditPort
  constructor(billing: BillingPlatformCreditPort) {
    this.#billing = billing
  }
  async reserve(input: {
    scope: ManagedCloudScope
    taskId: string
    maximumCreditsMicros: number
    idempotencyKey: string
  }) {
    if (input.maximumCreditsMicros <= 0)
      throw new ManagedCloudError('CREDIT_RESERVATION_INVALID')
    return this.#billing.reserveCredits({
      ...input.scope,
      operation: 'turn.start',
      maximumCreditsMicros: input.maximumCreditsMicros,
      idempotencyKey: input.idempotencyKey,
      runId: input.taskId,
      operationReference: input.taskId,
    })
  }
  async settle(input: {
    scope: ManagedCloudScope
    reservationId: string
    measuredCreditsMicros: number
    outcome: 'completed' | 'failed' | 'interrupted' | 'incomplete'
    idempotencyKey?: string
  }) {
    const key =
      input.idempotencyKey ?? `settle:${input.reservationId}:${input.outcome}`
    return this.#billing.settleCredits({
      ...input.scope,
      reservationId: input.reservationId,
      idempotencyKey: key,
      measuredCreditsMicros: input.measuredCreditsMicros,
      usageStatus: input.outcome === 'completed' ? 'measured' : 'incomplete',
      outcome: input.outcome,
      terminal: true,
      usageDedupeKey: key,
    })
  }
  refund(
    scope: ManagedCloudScope,
    reservationId: string,
    idempotencyKey = `release:${reservationId}`,
  ) {
    return this.#billing.settleCredits({
      ...scope,
      reservationId,
      idempotencyKey,
      measuredCreditsMicros: 0,
      usageStatus: 'measured',
      outcome: 'interrupted',
      terminal: true,
      usageDedupeKey: idempotencyKey,
    })
  }
}

export function subscriptionQuotaUsage(input: {
  scope: ManagedCloudScope
  usageId: string
  taskId: string | null
  quantity: number
  unit: string
  dedupeKey: string
}): ManagedUsageEntry {
  return managedUsageEntrySchema.parse({
    schemaVersion: MANAGED_CLOUD_CONTRACT_VERSION,
    ...input.scope,
    usageId: input.usageId,
    taskId: input.taskId,
    category: 'model',
    quantity: input.quantity,
    unit: input.unit,
    amountMicros: null,
    currency: null,
    estimated: true,
    billable: false,
    status: 'estimated',
    outcome: 'completed',
    dedupeKey: input.dedupeKey,
  })
}

export class DomainVerificationService {
  readonly #repository: ManagedCloudRepository
  constructor(repository: ManagedCloudRepository) {
    this.#repository = repository
  }
  async request(scope: ManagedCloudScope, domain: string) {
    const current = await this.#repository.getDomain(scope)
    const challenge = `dns:${scope.tenantId}:${domain}`
    if (current?.domain === domain) return { verification: current, challenge }
    const value = domainVerificationSchema.parse({
      schemaVersion: MANAGED_CLOUD_CONTRACT_VERSION,
      ...scope,
      domain,
      challengeDigest: digest(challenge),
      state: 'pending',
      httpsState: 'pending',
      version: (current?.version ?? 0) + 1,
    })
    await this.#repository.putDomain(value, current?.version ?? null)
    return { verification: value, challenge }
  }
  async verify(scope: ManagedCloudScope, observedChallenge: string) {
    const current = await this.#repository.getDomain(scope)
    if (!current) throw new ManagedCloudError('DOMAIN_NOT_FOUND')
    const matched = digest(observedChallenge) === current.challengeDigest
    const value = domainVerificationSchema.parse({
      ...current,
      state: matched ? 'verified' : 'failed',
      httpsState: matched ? 'active' : 'failed',
      version: current.version + 1,
    })
    await this.#repository.putDomain(value, current.version)
    return value
  }
}

export function advanceManagedBetaRollout(input: {
  current: ProductionRolloutRecord
  next: ProductionRolloutStage
  cohortId: string
  idempotencyKey: string
  commandSha256: string
  budget?: {
    observation: ProductionBudgetObservation
    policy: ProductionBudgetPolicy
  }
  operatorHalt?: boolean
  rollbackVerified?: boolean
}) {
  const budget = input.budget
    ? evaluateProductionBudget(input.budget.observation, input.budget.policy)
    : undefined
  return transitionProductionRollout(input.current, {
    expectedVersion: input.current.version,
    idempotencyKey: input.idempotencyKey,
    commandSha256: input.commandSha256,
    next: input.next,
    cohortId: input.cohortId,
    ...(budget ? { budget } : {}),
    ...(input.operatorHalt !== undefined
      ? { operatorHalt: input.operatorHalt }
      : {}),
    ...(input.rollbackVerified !== undefined
      ? { rollbackVerified: input.rollbackVerified }
      : {}),
  })
}
