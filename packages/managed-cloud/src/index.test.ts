import { describe, expect, it } from 'vitest'
import { ZERO_CAPACITY } from '@persistent-codex/production-topology'
import {
  InMemoryTenantRuntimeRepository,
  InMemoryTenantRuntimeResources,
  TenantProvisioningService,
} from '@persistent-codex/tenant-runtime'
import type { ProviderAuthProfileMetadata } from '@persistent-codex/provider-auth'
import type { ProductionRolloutRecord } from '@persistent-codex/production-readiness'
import type {
  CreditReservation,
  CreditSettlement,
} from '@persistent-codex/billing-platform'
import {
  DomainVerificationService,
  InMemoryManagedCloudRepository,
  ManagedCloudError,
  ManagedCloudOnboardingService,
  ManagedCloudLifecycleService,
  ManagedBetaAdmissionAuthority,
  ManagedCloudBillingService,
  ManagedCloudNotificationService,
  VaultProviderConnection,
  advanceManagedBetaRollout,
  evaluateManagedCloudLimits,
  subscriptionQuotaUsage,
  type DurableTaskPort,
  type BillingPlatformCreditPort,
  type ManagedCloudPlan,
  type ManagedCloudScope,
  type ProviderConnectionPort,
} from './index'

const capacity = {
  ...ZERO_CAPACITY,
  cpuMillis: 1_000,
  memoryBytes: 512_000_000,
  pids: 128,
  diskBytes: 10_000_000_000,
}

const plan: ManagedCloudPlan = {
  schemaVersion: 1,
  planId: 'beta',
  planVersion: 1,
  displayName: 'Limited Public Beta',
  currency: 'USD',
  entitlements: [
    'cloud.managed-tenant-provisioning',
    'cloud.tenant-runtime-isolation',
    'cloud.tenant-capacity-budgets',
    'cloud.runtime-data-plane-credentials',
    'core.provider-adapters',
    'core.detached-runs',
  ],
  computeQuota: capacity,
  storageQuotaBytes: 20_000_000_000,
  monthlyBudgetMicros: 10_000,
}

function fixture() {
  const repository = new InMemoryManagedCloudRepository()
  const tenantRepository = new InMemoryTenantRuntimeRepository()
  const provisioning = new TenantProvisioningService({
    repository: tenantRepository,
    resources: new InMemoryTenantRuntimeResources({
      nodeCapacity: { ...capacity, cpuMillis: 8_000 },
    }),
  })
  const providerCalls: string[] = []
  const providers: ProviderConnectionPort = {
    async ensureConnected(input) {
      providerCalls.push(`${input.provider}:${input.authMode}`)
      return {
        schemaVersion: 1,
        ...input.scope,
        profileId: input.profileId ?? 'profile',
        provider: input.provider,
        authMode: input.authMode,
        state: 'active',
        credentialVersion: 1,
        expiresAt: null,
        revokedAt: null,
        disconnectedAt: null,
        cryptoErasedAt: null,
        version: 1,
      } satisfies ProviderAuthProfileMetadata
    },
  }
  const taskCalls: string[] = []
  const tasks: DurableTaskPort = {
    async start(input) {
      taskCalls.push(input.idempotencyKey)
      return { taskId: 'task_first', state: 'running' }
    },
    async replay(scope, taskId) {
      return {
        taskId,
        state: 'completed',
        output: `completed:${scope.workspaceId}`,
      }
    },
  }
  const rolloutCalls: string[] = []
  const planAssignmentCalls: string[] = []
  const service = new ManagedCloudOnboardingService({
    repository,
    accounts: { async ensure() {} },
    provisioning,
    providers,
    tasks,
    rollout: {
      assertAdmission(input) {
        rolloutCalls.push(`${input.provider}:${input.authMode}`)
      },
    },
    commercial: {
      async assignPlan(scope) {
        planAssignmentCalls.push(scope.workspaceId)
      },
      async admitFirstTask({ plan: assigned }) {
        return evaluateManagedCloudLimits({
          plan: assigned,
          usage: [],
          requestedCompute: assigned.computeQuota,
          requestedStorageBytes: 0,
        })
      },
    },
    catalog: {
      async resolve(planId, planVersion) {
        if (planId !== plan.planId || planVersion !== plan.planVersion)
          throw new ManagedCloudError('PLAN_NOT_FOUND')
        return plan
      },
    },
  })
  return {
    repository,
    tenantRepository,
    providers,
    providerCalls,
    tasks,
    taskCalls,
    rolloutCalls,
    planAssignmentCalls,
    service,
  }
}

const onboarding = {
  principal: {
    issuer: 'https://identity.example.test',
    subject: 'beta-user',
  },
  displayName: 'Beta Tenant',
  workspaceName: 'Mobile',
  regionId: 'eu-1',
  retentionDays: 30,
  domain: 'agent.example.test',
  planId: plan.planId,
  planVersion: plan.planVersion,
  provider: 'claude' as const,
  authMode: 'customer-api-key' as const,
  accessToken: 'generated-test-credential',
  firstTaskPrompt: 'Durable task',
  idempotencyKey: 'signup-beta-1',
}

describe('managed cloud onboarding', () => {
  it('signup → tenant → provider → first task akışını tamamlar ve replay eder', async () => {
    const value = fixture()
    const result = await value.service.run(onboarding)
    expect(result.state).toBe('completed')
    expect(result.providerProfileId).toMatch(/^provider_/)
    expect(result.firstTaskId).toBe('task_first')
    expect(value.providerCalls).toEqual(['claude:customer-api-key'])
    expect(value.rolloutCalls).toEqual(['claude:customer-api-key'])
    const runtime = await value.tenantRepository.getRuntime(
      result,
      result.workspaceId,
    )
    expect(runtime?.state).toBe('ready')
    const replay = await value.tasks.replay(result, result.firstTaskId!)
    expect(replay).toMatchObject({ state: 'completed' })
  })

  it('aynı idempotency key ile yeniden koşunca kaynakları çoğaltmaz', async () => {
    const value = fixture()
    const first = await value.service.run(onboarding)
    const second = await value.service.run(onboarding)
    expect(second).toEqual(first)
    expect(value.providerCalls).toHaveLength(1)
    expect(value.taskCalls).toHaveLength(1)
    expect(value.planAssignmentCalls).toHaveLength(2)
  })

  it('catalog dışı plan seçimini fail-closed reddeder', async () => {
    const value = fixture()
    await value.service.run(onboarding)
    await expect(
      value.service.run({
        ...onboarding,
        planId: 'conflicting-plan',
      }),
    ).rejects.toThrow('PLAN_NOT_FOUND')
  })

  it('WP34 vault bağlantısını bir kez yapar, tekrarında mevcut profili kullanır', async () => {
    let existing:
      | (ProviderAuthProfileMetadata & {
          provider: 'claude'
          authMode: 'customer-api-key'
        })
      | undefined
    let vaultCalls = 0
    const connection = new VaultProviderConnection({
      repository: {
        async getProfile() {
          return existing
        },
      },
      vault: {
        async connect(input) {
          vaultCalls += 1
          existing = {
            schemaVersion: 1,
            ...input.scope,
            profileId: input.profileId!,
            provider: 'claude',
            authMode: 'customer-api-key',
            state: 'active',
            credentialVersion: 1,
            expiresAt: null,
            revokedAt: null,
            disconnectedAt: null,
            cryptoErasedAt: null,
            version: 1,
          }
          return existing
        },
      },
    })
    const input = {
      scope: {
        tenantId: 'tenant',
        organizationId: 'tenant',
        workspaceId: 'workspace',
      },
      profileId: 'profile',
      provider: 'claude' as const,
      authMode: 'customer-api-key' as const,
      accessToken: 'generated-test-credential',
    }
    expect(await connection.ensureConnected(input)).toEqual(existing)
    expect(await connection.ensureConnected(input)).toEqual(existing)
    expect(vaultCalls).toBe(1)
  })
})

describe('quota, budget ve billing ayrımı', () => {
  const scope: ManagedCloudScope = {
    tenantId: 'tenant',
    organizationId: 'tenant',
    workspaceId: 'workspace',
  }

  it('compute/storage quota ve budget halt admission noktasında fail-closed olur', () => {
    expect(
      evaluateManagedCloudLimits({
        plan,
        usage: [],
        requestedCompute: { ...capacity, cpuMillis: 1_001 },
        requestedStorageBytes: 0,
      }),
    ).toMatchObject({ allowed: false, reason: 'HARD_LIMIT_CPUMILLIS' })
    const budgetUsage = {
      schemaVersion: 1,
      ...scope,
      usageId: 'usage-budget',
      taskId: 'task',
      category: 'hosting',
      quantity: 1,
      unit: 'month',
      amountMicros: 10_000,
      currency: 'USD',
      estimated: false,
      billable: true,
      status: 'measured',
      outcome: 'completed',
      dedupeKey: 'budget',
    } as const
    expect(
      evaluateManagedCloudLimits({
        plan,
        usage: [budgetUsage],
        requestedCompute: capacity,
        requestedStorageBytes: 1,
      }),
    ).toEqual({
      allowed: false,
      reason: 'BUDGET_HALT',
      inFlightPolicy: 'safe-completion',
    })
  })

  it('reservation → settlement → refund sayısal olarak kapanır', async () => {
    const reservations = new Map<string, number>()
    const settlementRunIds: Array<string | undefined> = []
    const port: BillingPlatformCreditPort = {
      async reserveCredits(input) {
        const reservationId = `canonical-${input.idempotencyKey}`
        reservations.set(reservationId, input.maximumCreditsMicros)
        return {
          reservationId,
          maximumCreditsMicros: input.maximumCreditsMicros,
        } as CreditReservation
      },
      async settleCredits(input) {
        settlementRunIds.push(input.runId)
        const maximum = reservations.get(input.reservationId) ?? 0
        return {
          reservationId: input.reservationId,
          measuredCreditsMicros: input.measuredCreditsMicros,
          releasedCreditsMicros: maximum - input.measuredCreditsMicros,
          outcome: input.outcome,
          usageStatus: input.usageStatus,
        } as CreditSettlement
      },
    }
    const ledger = new ManagedCloudBillingService(port)
    const reserved = await ledger.reserve({
      scope,
      taskId: 'task-failed',
      maximumCreditsMicros: 1_000,
      idempotencyKey: 'reserve-1',
    })
    expect(reserved.maximumCreditsMicros).toBe(1_000)
    const settled = await ledger.settle({
      scope,
      reservationId: reserved.reservationId,
      measuredCreditsMicros: 350,
      outcome: 'failed',
    })
    expect(settled).toMatchObject({
      measuredCreditsMicros: 350,
      releasedCreditsMicros: 650,
      outcome: 'failed',
    })
    const second = await ledger.reserve({
      scope,
      taskId: 'task-interrupted',
      maximumCreditsMicros: 500,
      idempotencyKey: 'reserve-2',
    })
    const refunded = await ledger.refund(scope, second.reservationId)
    expect(
      refunded.measuredCreditsMicros + refunded.releasedCreditsMicros,
    ).toBe(500)
    expect(refunded.outcome).toBe('interrupted')
    expect(settlementRunIds).toEqual([undefined, undefined])
  })

  it('subscription quota estimated ve non-billable kalır', () => {
    expect(
      subscriptionQuotaUsage({
        scope,
        usageId: 'subscription-1',
        taskId: 'task',
        quantity: 42,
        unit: 'provider-quota-unit',
        dedupeKey: 'subscription-1',
      }),
    ).toMatchObject({
      category: 'model',
      amountMicros: null,
      estimated: true,
      billable: false,
      status: 'estimated',
    })
  })
})

describe('domain ve kontrollü rollout', () => {
  const scope: ManagedCloudScope = {
    tenantId: 'tenant',
    organizationId: 'tenant',
    workspaceId: 'workspace',
  }

  it('domain challenge doğrulanmadan HTTPS aktif olmaz', async () => {
    const service = new DomainVerificationService(
      new InMemoryManagedCloudRepository(),
    )
    const pending = await service.request(scope, 'agent.example.test')
    expect(pending.verification.httpsState).toBe('pending')
    const failed = await service.verify(scope, 'wrong')
    expect(failed.httpsState).toBe('failed')
    const requested = await service.request(scope, 'verified.example.test')
    const verified = await service.verify(scope, requested.challenge)
    expect(verified.httpsState).toBe('active')
  })

  it('WP30 rollout makinesiyle ilerler, halt olur ve rollback yapar', () => {
    const hash = 'a'.repeat(64)
    const initial: ProductionRolloutRecord = {
      contractVersion: 1,
      ...scope,
      rolloutId: 'managed-beta',
      stage: 'internal',
      version: 1,
      cohortId: 'internal',
      artifactSha256: hash,
      previousArtifactSha256: 'b'.repeat(64),
      featureFlagEnabled: true,
      killSwitch: false,
      idempotency: {},
      historyHeadSha256: null,
    }
    const healthy = {
      observation: {
        requestCount: 1_000,
        successRate: 0.999,
        errorBudgetBurnRate: 0.5,
        tenantFairnessRatio: 0.99,
        p95LatencyMs: 100,
        eventLagP95Ms: 100,
        backlog: 0,
        dataLoss: 0,
        uncontrolledDuplicates: 0,
        fenceViolations: 0,
      },
      policy: {
        minimumRequests: 100,
        minimumSuccessRate: 0.99,
        maximumErrorBudgetBurnRate: 1,
        minimumTenantFairnessRatio: 0.95,
        maximumP95LatencyMs: 500,
        maximumEventLagP95Ms: 500,
        maximumBacklog: 10,
      },
    }
    const design = advanceManagedBetaRollout({
      current: initial,
      next: 'design_partner',
      cohortId: 'partners',
      idempotencyKey: 'design',
      commandSha256: hash,
      budget: healthy,
    })
    const limited = advanceManagedBetaRollout({
      current: design,
      next: 'limited_beta',
      cohortId: 'limited-public',
      idempotencyKey: 'limited',
      commandSha256: 'e'.repeat(64),
      budget: healthy,
    })
    const halted = advanceManagedBetaRollout({
      current: limited,
      next: 'halted',
      cohortId: 'partners',
      idempotencyKey: 'halt',
      commandSha256: 'c'.repeat(64),
      operatorHalt: true,
    })
    expect(halted.killSwitch).toBe(true)
    const rolledBack = advanceManagedBetaRollout({
      current: halted,
      next: 'rolled_back',
      cohortId: 'partners',
      idempotencyKey: 'rollback',
      commandSha256: 'd'.repeat(64),
      rollbackVerified: true,
    })
    expect(rolledBack.stage).toBe('rolled_back')
  })

  it('feature flag, provider kill switch, capacity ve rate admission aynı sınırda fail-closed olur', async () => {
    const rollout: ProductionRolloutRecord = {
      contractVersion: 1,
      ...scope,
      rolloutId: 'managed-beta',
      stage: 'design_partner',
      version: 1,
      cohortId: 'partners',
      artifactSha256: 'a'.repeat(64),
      previousArtifactSha256: null,
      featureFlagEnabled: true,
      killSwitch: false,
      idempotency: {},
      historyHeadSha256: null,
    }
    const authority = new ManagedBetaAdmissionAuthority({
      current: () => rollout,
      providerKillSwitch: { assertNewWork() {} },
      capacityAvailable: () => false,
      rateAllowed: () => true,
    })
    await expect(
      authority.assertAdmission({
        scope,
        provider: 'claude',
        authMode: 'customer-api-key',
      }),
    ).rejects.toThrow('MANAGED_BETA_CAPACITY_HALT')
  })

  it('eksik plan entitlement reddedilir', async () => {
    const value = fixture()
    await expect(
      value.service.run({
        ...onboarding,
        idempotencyKey: 'bad-plan',
        planId: 'client-forged-entitlements',
      }),
    ).rejects.toBeInstanceOf(ManagedCloudError)
  })
})

describe('WP28/WP34/WP33 lifecycle composition', () => {
  it('export mevcut lifecycle portunu kullanır; delete revoke ve crypto-erasure ile kapanır', async () => {
    const scope: ManagedCloudScope = {
      tenantId: 'tenant',
      organizationId: 'tenant',
      workspaceId: 'workspace',
    }
    const calls: string[] = []
    const service = new ManagedCloudLifecycleService({
      lifecycle: {
        async exportTenant() {
          calls.push('wp28:export')
          return { jobId: 'export-job', state: 'completed' }
        },
        async deleteTenant() {
          calls.push('wp28:delete')
          return { jobId: 'delete-job', state: 'completed' }
        },
      },
      credentials: {
        async listProfiles() {
          return [{ profileId: 'profile', state: 'active' }]
        },
        async revoke() {
          calls.push('wp34:revoke')
        },
        async cryptoErase() {
          calls.push('wp34:crypto-erase')
        },
      },
      tenants: {
        async deleteTenant() {
          calls.push('wp33:delete')
          return { tenant: { state: 'deleted' } }
        },
      },
    })
    await expect(service.exportTenant(scope, 'export')).resolves.toMatchObject({
      state: 'completed',
    })
    await expect(service.deleteTenant(scope, 'delete')).resolves.toEqual({
      lifecycleJobId: 'delete-job',
      lifecycleState: 'completed',
      credentialsCryptoErased: 1,
      tenantState: 'deleted',
    })
    expect(calls).toEqual([
      'wp28:export',
      'wp28:delete',
      'wp34:revoke',
      'wp34:crypto-erase',
      'wp33:delete',
    ])
  })
})

describe('WP23 notification composition', () => {
  it('task completion için aynı opaque id ile push ve email outbox kullanır', async () => {
    const calls: string[] = []
    const service = new ManagedCloudNotificationService({
      push: {
        async enqueue(_scope, input) {
          calls.push(`push:${input.status}:${input.notificationId}`)
          return 2
        },
      },
      email: {
        async enqueue(input) {
          calls.push(`email:${input.template}:${input.dedupeKey}`)
        },
      },
    })
    const scope: ManagedCloudScope = {
      tenantId: 'tenant',
      organizationId: 'tenant',
      workspaceId: 'workspace',
    }
    const result = await service.taskEvent({ scope, taskId: 'task' })
    expect(result).toMatchObject({ pushRecipients: 2, emailQueued: true })
    expect(calls[0]).toContain('push:turn_completed:notification_')
    expect(calls[1]).toContain('email:task-completed:notification_')
  })
})
