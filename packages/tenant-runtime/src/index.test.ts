import { describe, expect, it } from 'vitest'
import { ZERO_CAPACITY } from '@persistent-codex/production-topology'
import type {
  CapacityVector,
  TenantSchedulingPolicy,
} from '@persistent-codex/production-topology/contracts'
import type { FairQueueCandidate } from '@persistent-codex/production-topology'
import {
  InMemoryTenantRuntimeRepository,
  InMemoryTenantRuntimeResources,
  PROVISION_STEPS,
  RuntimeDataPlaneAuthority,
  TENANT_RUNTIME_CONTRACT_VERSION,
  TenantProvisioningService,
  TenantRuntimeError,
  assertQueuePositionBudget,
  assertReservationWithinBudgets,
  simulateWeightedFairSelection,
  type TenantCapacityBudget,
} from './index'

const capacity = (cpuMillis: number): CapacityVector => ({
  ...ZERO_CAPACITY,
  cpuMillis,
  memoryBytes: cpuMillis * 1_000_000,
  pids: Math.ceil(cpuMillis / 10),
  diskBytes: cpuMillis * 1_000_000,
})

const scopeA = { tenantId: 'ten_a', organizationId: 'ten_a' }
const scopeB = { tenantId: 'ten_b', organizationId: 'ten_b' }

const budget = (
  tenantId: string,
  cpuMillis: number,
  maxStarvationPosition = 8,
): TenantCapacityBudget => ({
  schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
  tenantId,
  organizationId: tenantId,
  reservedCapacity: capacity(cpuMillis),
  queueLatencyBudgetMs: 30_000,
  maxStarvationPosition,
  version: 1,
})

function harness(options: { budgets?: TenantCapacityBudget[] } = {}) {
  const repository = new InMemoryTenantRuntimeRepository()
  const resources = new InMemoryTenantRuntimeResources({
    nodeCapacity: capacity(8_000),
    budgets: async () => options.budgets ?? [],
  })
  const service = new TenantProvisioningService({ repository, resources })
  return { repository, resources, service }
}

const provisionInput = (scope: typeof scopeA, workspaceId = 'wsp_main') => ({
  ...scope,
  workspaceId,
  displayName: `Tenant ${scope.tenantId}`,
  regionId: 'region-1',
  capacity: capacity(1_000),
  retentionDays: 30,
  domain: `${scope.tenantId.replaceAll('_', '-')}.example.test`,
  idempotencyKey: `provision:${scope.tenantId}:${workspaceId}`,
})

describe('tenant provisioning yaşam döngüsü', () => {
  it('provision tüm izolasyon kaynaklarını kurar ve tenant metadata taşır', async () => {
    const { service } = harness()
    const { tenant, runtime, job } = await service.provisionTenant(
      provisionInput(scopeA),
    )
    expect(tenant.state).toBe('active')
    expect(tenant.domain).toBe('ten-a.example.test')
    expect(tenant.regionId).toBe('region-1')
    expect(tenant.retentionDays).toBe(30)
    expect(tenant.capacity.cpuMillis).toBe(1_000)
    expect(runtime.state).toBe('ready')
    expect(runtime.generation).toBe(1)
    expect(runtime.identitySubject).toBe('runtime:ten_a:wsp_main')
    expect(runtime.volumeId).toBe('vol_ten_a_wsp_main')
    expect(runtime.volumeEncrypted).toBe(true)
    expect(runtime.kmsKeyId).toBe('key_ten_a_wsp_main')
    expect(runtime.secretNamespace).toBe('secrets/ten_a/wsp_main')
    expect(runtime.networkPolicyId).toBe('netpol_ten_a_wsp_main')
    expect(runtime.nodeId).toBe('region-1-node-1')
    expect(runtime.capacityReservationId).toBe('resv_ten_a_wsp_main')
    expect(job.state).toBe('completed')
    expect(job.completedSteps).toEqual([...PROVISION_STEPS])
  })

  it('provision idempotenttir: aynı idempotency key ikinci kez aynı duruma yakınsar', async () => {
    const { service, resources } = harness()
    await service.provisionTenant(provisionInput(scopeA))
    const callsAfterFirst = resources.calls.length
    const second = await service.provisionTenant(provisionInput(scopeA))
    expect(second.tenant.state).toBe('active')
    expect(second.runtime.version).toBeGreaterThan(0)
    // Tamamlanmış job yeniden koşulmaz; kaynak çağrısı artmaz.
    expect(resources.calls.length).toBe(callsAfterFirst)
  })

  it('yarım kalan provision reconcile ile aynı hedef duruma yakınsar', async () => {
    const { service, repository, resources } = harness()
    resources.failNextCall('ensureNetworkPolicy')
    await expect(
      service.provisionTenant(provisionInput(scopeA)),
    ).rejects.toThrow('INJECTED_FAULT:ensureNetworkPolicy')
    const halfway = await repository.getRuntime(scopeA, 'wsp_main')
    expect(halfway?.secretNamespace).toBe('secrets/ten_a/wsp_main')
    expect(halfway?.networkPolicyId).toBeNull()
    const result = await service.reconcile(scopeA)
    expect(result.converged).toBe(true)
    const tenant = await repository.getTenant(scopeA)
    const runtime = await repository.getRuntime(scopeA, 'wsp_main')
    expect(tenant?.state).toBe('active')
    expect(runtime?.state).toBe('ready')
    expect(runtime?.networkPolicyId).toBe('netpol_ten_a_wsp_main')
  })

  it('suspend/resume kapasite rezervasyonunu bırakır ve idempotent geri kurar', async () => {
    const { service, repository, resources } = harness()
    await service.provisionTenant(provisionInput(scopeA))
    await service.suspendTenant({ ...scopeA, idempotencyKey: 'suspend:1' })
    const suspended = await repository.getTenant(scopeA)
    expect(suspended?.state).toBe('suspended')
    expect(resources.listReservations()).toHaveLength(0)
    expect(
      (await repository.getRuntime(scopeA, 'wsp_main'))?.capacityReservationId,
    ).toBeNull()
    await service.resumeTenant({ ...scopeA, idempotencyKey: 'resume:1' })
    const resumed = await repository.getTenant(scopeA)
    expect(resumed?.state).toBe('active')
    expect(resources.listReservations()).toHaveLength(1)
  })

  it('delete ters sökümü çalıştırır ve crypto-erasure ile biter', async () => {
    const { service, repository, resources } = harness()
    await service.provisionTenant(provisionInput(scopeA))
    await service.deleteTenant({ ...scopeA, idempotencyKey: 'delete:1' })
    const tenant = await repository.getTenant(scopeA)
    const runtime = await repository.getRuntime(scopeA, 'wsp_main')
    expect(tenant?.state).toBe('deleted')
    expect(runtime?.state).toBe('deleted')
    expect(runtime?.volumeId).toBeNull()
    expect(runtime?.secretNamespace).toBeNull()
    expect(resources.isKeyErased(scopeA, 'wsp_main')).toBe(true)
    expect(await resources.listObservedRuntimes()).toHaveLength(0)
    // Silinen anahtar yeniden kullanılamaz (fail-closed).
    await expect(
      resources.ensureEncryptionKey({
        ...scopeA,
        workspaceId: 'wsp_main',
        runtimeId: 'rt_x',
      }),
    ).rejects.toThrow('WORKSPACE_CRYPTO_ERASED')
  })

  it('runtime recreation yeni generation kurar; eski runtime orphan olarak yakalanır', async () => {
    const { service, repository, resources } = harness()
    await service.provisionTenant(provisionInput(scopeA))
    const before = await repository.getRuntime(scopeA, 'wsp_main')
    const recreated = await service.recreateRuntime({
      ...scopeA,
      workspaceId: 'wsp_main',
      idempotencyKey: 'recreate:1',
    })
    expect(recreated.generation).toBe(2)
    expect(recreated.state).toBe('ready')
    expect(recreated.runtimeId).not.toBe(before?.runtimeId)
    // Eski generation'dan kalan gözlenen runtime stale-generation orphan'dır.
    resources.injectObservedRuntime({
      runtimeId: before!.runtimeId,
      tenantId: scopeA.tenantId,
      organizationId: scopeA.organizationId,
      workspaceId: 'wsp_main',
      generation: 1,
    })
    const orphans = await service.detectOrphans()
    expect(orphans).toEqual([
      {
        schemaVersion: 1,
        observedRuntimeId: before!.runtimeId,
        reason: 'stale-generation',
        state: 'detected',
      },
    ])
  })

  it('orphan cleanup üst sınırlıdır (bounded)', async () => {
    const { service, resources, repository } = harness()
    for (let index = 0; index < 5; index += 1)
      resources.injectObservedRuntime({
        runtimeId: `rt_orphan_${index}`,
        tenantId: 'ten_ghost',
        organizationId: 'ten_ghost',
        workspaceId: `wsp_${index}`,
        generation: 1,
      })
    const detected = await service.detectOrphans()
    expect(detected).toHaveLength(5)
    expect(detected.every((o) => o.reason === 'missing-durable-record')).toBe(
      true,
    )
    const first = await service.cleanupOrphans(2)
    expect(first).toEqual({ cleaned: 2, remaining: 3 })
    const second = await service.cleanupOrphans(2)
    expect(second).toEqual({ cleaned: 2, remaining: 1 })
    const third = await service.cleanupOrphans(2)
    expect(third).toEqual({ cleaned: 1, remaining: 0 })
    expect(await repository.listOrphans('detected')).toHaveLength(0)
    await expect(service.cleanupOrphans(0)).rejects.toThrow(
      'ORPHAN_CLEANUP_LIMIT_INVALID',
    )
  })
})

describe('noisy-neighbor kapasite/SLO bütçesi', () => {
  it('Tenant A rezervasyonu Tenant B bütçesini aşındıramaz', () => {
    expect(() =>
      assertReservationWithinBudgets({
        nodeCapacity: capacity(8_000),
        budgets: [budget('ten_b', 2_000)],
        existingReservations: [],
        tenantId: 'ten_a',
        requested: capacity(6_000),
      }),
    ).not.toThrow()
    expect(() =>
      assertReservationWithinBudgets({
        nodeCapacity: capacity(8_000),
        budgets: [budget('ten_b', 2_000)],
        existingReservations: [
          { tenantId: 'ten_a', capacity: capacity(6_000) },
        ],
        tenantId: 'ten_a',
        requested: capacity(1_000),
      }),
    ).toThrow('TENANT_BUDGET_ERODED:ten_b')
    // Tenant B kendi bütçesini kullanabilir.
    expect(() =>
      assertReservationWithinBudgets({
        nodeCapacity: capacity(8_000),
        budgets: [budget('ten_b', 2_000)],
        existingReservations: [
          { tenantId: 'ten_a', capacity: capacity(6_000) },
        ],
        tenantId: 'ten_b',
        requested: capacity(2_000),
      }),
    ).not.toThrow()
  })

  it('provisioning servis bütçe ihlalinde rezervasyon adımında fail-closed olur', async () => {
    const budgets = [budget('ten_b', 6_000)]
    const { service } = harness({ budgets })
    await expect(
      service.provisionTenant({
        ...provisionInput(scopeA),
        capacity: capacity(4_000),
      }),
    ).rejects.toThrow('TENANT_BUDGET_ERODED:ten_b')
    // Tenant B kendi bütçesi içinde provision olabilir.
    const okB = await service.provisionTenant({
      ...provisionInput(scopeB),
      capacity: capacity(4_000),
    })
    expect(okB.tenant.state).toBe('active')
  })

  it('weighted-fair seçim Tenant B sıra pozisyon bütçesini korur', () => {
    const now = new Date('2026-07-24T10:00:00.000Z')
    const at = now.toISOString()
    const policy = (
      tenantId: string,
      weight: number,
    ): TenantSchedulingPolicy => ({
      schemaVersion: 1,
      tenantId,
      organizationId: tenantId,
      policyVersion: 33,
      algorithm: 'weighted-fair-v1',
      weight,
      tenantConcurrency: 4,
      workspaceConcurrency: 1,
      providerConcurrency: { codex: 4 },
      providerRequestsPerMinute: { codex: 600 },
      starvationAgeMs: 60_000,
      retry: {
        maxAttempts: 4,
        initialBackoffMs: 100,
        maxBackoffMs: 800,
        poisonAfterAttempts: 4,
      },
      effectiveAt: at,
    })
    const item = (
      tenantId: string,
      queueItemId: string,
      virtualFinish: number,
    ): FairQueueCandidate => ({
      schemaVersion: 1,
      tenantId,
      organizationId: tenantId,
      workspaceId: `wsp_${queueItemId}`,
      queueItemId,
      runId: `run_${queueItemId}`,
      sessionId: `ses_${queueItemId}`,
      providerId: 'codex',
      idempotencyKey: `idem_${queueItemId}`,
      state: 'queued',
      priority: 0,
      virtualFinish,
      attempt: 0,
      maxAttempts: 4,
      notBefore: at,
      enqueuedAt: at,
      lastErrorCode: null,
      tenantRunning: 0,
      workspaceRunning: 0,
      providerRunning: 0,
      providerRequestsLastMinute: 0,
    })
    const items = [
      ...Array.from({ length: 200 }, (_, index) =>
        item('ten_a', `a${String(index).padStart(3, '0')}`, index + 1),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        item('ten_b', `b${index}`, index + 1),
      ),
    ]
    const policies = new Map([
      ['ten_a', policy('ten_a', 1)],
      ['ten_b', policy('ten_b', 4)],
    ])
    const result = simulateWeightedFairSelection({ items, policies, now })
    expect(result.selectionOrder).toHaveLength(204)
    expect(result.positionsByTenant['ten_b']![0]).toBeLessThanOrEqual(8)
    expect(() =>
      assertQueuePositionBudget(result, budget('ten_b', 2_000, 8)),
    ).not.toThrow()
    // Hiç seçilmeyen tenant bütçe ihlali olarak raporlanır (deny-by-default).
    expect(() =>
      assertQueuePositionBudget(result, budget('ten_c', 2_000, 8)),
    ).toThrow(TenantRuntimeError)
  })
})

describe('runtime data plane internal auth', () => {
  const authorityInput = {
    tenantId: 'ten_a',
    organizationId: 'ten_a',
    workspaceId: 'wsp_main',
    runtimeId: 'rt_ten_a_wsp_main_g1',
    generation: 1,
  }

  it('kısa ömürlü tenant-scoped credential basar ve doğrular', async () => {
    const repository = new InMemoryTenantRuntimeRepository()
    const authority = new RuntimeDataPlaneAuthority({ repository })
    const issued = await authority.issue(authorityInput)
    expect(issued.accessToken.startsWith('pdp1.')).toBe(true)
    const claims = await authority.verify({
      authorization: `Bearer ${issued.accessToken}`,
      action: 'event.append',
      ...authorityInput,
    })
    expect(claims.tenantId).toBe('ten_a')
    expect(claims.generation).toBe(1)
  })

  it('kimliksiz ve bozuk istekler deny-by-default reddedilir', async () => {
    const authority = new RuntimeDataPlaneAuthority()
    await expect(
      authority.verify({ action: 'event.append', ...authorityInput }),
    ).rejects.toThrow('RUNTIME_AUTH_REQUIRED')
    await expect(
      authority.verify({
        authorization: 'Bearer pdp1.malformed',
        action: 'event.append',
        ...authorityInput,
      }),
    ).rejects.toThrow('RUNTIME_TOKEN_MALFORMED')
    const issued = await authority.issue(authorityInput)
    const [prefix, payload] = issued.accessToken.split('.')
    await expect(
      authority.verify({
        authorization: `Bearer ${prefix}.${payload}.forged-signature`,
        action: 'event.append',
        ...authorityInput,
      }),
    ).rejects.toThrow('RUNTIME_TOKEN_SIGNATURE_INVALID')
  })

  it('yanlış-tenant, yanlış generation ve tanımsız action reddedilir', async () => {
    const authority = new RuntimeDataPlaneAuthority()
    const issued = await authority.issue(authorityInput)
    const header = { authorization: `Bearer ${issued.accessToken}` }
    await expect(
      authority.verify({
        ...header,
        action: 'event.append',
        ...authorityInput,
        tenantId: 'ten_b',
        organizationId: 'ten_b',
      }),
    ).rejects.toThrow('RUNTIME_SCOPE_REJECTED')
    await expect(
      authority.verify({
        ...header,
        action: 'event.append',
        ...authorityInput,
        generation: 2,
      }),
    ).rejects.toThrow('RUNTIME_SCOPE_REJECTED')
    const limited = await authority.issue({
      ...authorityInput,
      actions: ['replay.read'],
    })
    await expect(
      authority.verify({
        authorization: `Bearer ${limited.accessToken}`,
        action: 'artifact.write',
        ...authorityInput,
      }),
    ).rejects.toThrow('RUNTIME_SCOPE_REJECTED')
  })

  it('expiry ve revoke fail-closed çalışır; TTL üst sınırı 5 dakikadır', async () => {
    const repository = new InMemoryTenantRuntimeRepository()
    const authority = new RuntimeDataPlaneAuthority({ repository })
    const now = new Date('2026-07-24T10:00:00.000Z')
    const issued = await authority.issue({
      ...authorityInput,
      ttlMs: 60 * 60_000,
      now,
    })
    expect(new Date(issued.expiresAt).getTime() - now.getTime()).toBe(300_000)
    await expect(
      authority.verify({
        authorization: `Bearer ${issued.accessToken}`,
        action: 'event.append',
        ...authorityInput,
        now: new Date(now.getTime() + 300_001),
      }),
    ).rejects.toThrow('RUNTIME_TOKEN_REJECTED')
    await authority.revoke(issued.credentialId)
    await expect(
      authority.verify({
        authorization: `Bearer ${issued.accessToken}`,
        action: 'event.append',
        ...authorityInput,
        now,
      }),
    ).rejects.toThrow('RUNTIME_TOKEN_REJECTED')
    expect(await repository.isCredentialRevoked(issued.credentialId)).toBe(true)
    await expect(
      authority.issue({ ...authorityInput, ttlMs: 500 }),
    ).rejects.toThrow('RUNTIME_CREDENTIAL_TTL_INVALID')
  })
})
