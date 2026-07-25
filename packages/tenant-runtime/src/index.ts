import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  ZERO_CAPACITY,
  fitsCapacity,
  selectWeightedFairCandidate,
  type FairQueueCandidate,
} from '@persistent-codex/production-topology'
import type {
  CapacityVector,
  TenantSchedulingPolicy,
} from '@persistent-codex/production-topology/contracts'
import {
  DELETE_STEPS,
  PROVISION_STEPS,
  RUNTIME_DATA_PLANE_ACTIONS,
  RUNTIME_DATA_PLANE_AUDIENCE,
  SUSPEND_STEPS,
  TENANT_RUNTIME_CONTRACT_VERSION,
  issuedRuntimeCredentialSchema,
  managedTenantSchema,
  orphanRuntimeSchema,
  provisioningJobSchema,
  runtimeCredentialClaimsSchema,
  tenantRuntimeSchema,
  type IssuedRuntimeCredential,
  type ManagedTenant,
  type OrphanRuntime,
  type ProvisioningJob,
  type ProvisioningJobKind,
  type RuntimeCredentialClaims,
  type RuntimeDataPlaneAction,
  type TenantCapacityBudget,
  type TenantRuntime,
  type TenantRuntimeScope,
} from './contracts'

export * from './contracts'

export class TenantRuntimeError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'TenantRuntimeError'
    this.code = code
  }
}

// --- Kapasite bütçesi (noisy-neighbor sınırı) yardımcıları ---

const CAPACITY_KEYS = Object.keys(ZERO_CAPACITY).filter(
  (key) => key !== 'schemaVersion',
) as Exclude<keyof CapacityVector, 'schemaVersion'>[]

export function addCapacity(
  left: CapacityVector,
  right: CapacityVector,
): CapacityVector {
  const result = { ...ZERO_CAPACITY }
  for (const key of CAPACITY_KEYS)
    result[key] = Number(left[key]) + Number(right[key])
  return result
}

export function sumCapacity(
  vectors: readonly CapacityVector[],
): CapacityVector {
  return vectors.reduce(addCapacity, ZERO_CAPACITY)
}

export interface ReservationWithinBudgetsInput {
  nodeCapacity: CapacityVector
  budgets: readonly TenantCapacityBudget[]
  existingReservations: readonly {
    tenantId: string
    capacity: CapacityVector
  }[]
  tenantId: string
  requested: CapacityVector
}

// Tenant A'nın rezervasyonu, diğer tenant'ların belgelenmiş bütçe kalanını
// aşındıramaz: rezervasyon ancak (mevcut + istenen + diğer bütçe kalanları)
// node kapasitesine sığıyorsa kabul edilir.
export function assertReservationWithinBudgets(
  input: ReservationWithinBudgetsInput,
): void {
  const reservedByTenant = new Map<string, CapacityVector>()
  for (const reservation of input.existingReservations) {
    reservedByTenant.set(
      reservation.tenantId,
      addCapacity(
        reservedByTenant.get(reservation.tenantId) ?? ZERO_CAPACITY,
        reservation.capacity,
      ),
    )
  }
  const erodedTenants: string[] = []
  let required = addCapacity(
    sumCapacity(input.existingReservations.map((entry) => entry.capacity)),
    input.requested,
  )
  for (const budget of input.budgets) {
    if (budget.tenantId === input.tenantId) continue
    const alreadyReserved =
      reservedByTenant.get(budget.tenantId) ?? ZERO_CAPACITY
    const remainder = { ...ZERO_CAPACITY }
    for (const key of CAPACITY_KEYS)
      remainder[key] = Math.max(
        0,
        Number(budget.reservedCapacity[key]) - Number(alreadyReserved[key]),
      )
    required = addCapacity(required, remainder)
    if (!fitsCapacity(input.nodeCapacity, required))
      erodedTenants.push(budget.tenantId)
  }
  if (!fitsCapacity(input.nodeCapacity, required))
    throw new TenantRuntimeError(
      `TENANT_BUDGET_ERODED:${[...new Set(erodedTenants)].sort().join(',') || input.tenantId}`,
    )
}

export interface FairShareSimulationResult {
  selectionOrder: { tenantId: string; queueItemId: string }[]
  positionsByTenant: Record<string, number[]>
  maxPositionByTenant: Record<string, number>
}

// Deterministik weighted-fair seçim simülasyonu: ADR-0026 scheduler
// algoritmasının kendisini kullanır; gate'ler bunun üzerinden Tenant B'nin
// sıra pozisyon bütçesini sayısal raporlar.
export function simulateWeightedFairSelection(input: {
  items: readonly FairQueueCandidate[]
  policies: ReadonlyMap<string, TenantSchedulingPolicy>
  now: Date
}): FairShareSimulationResult {
  const remaining = [...input.items]
  const selectionOrder: { tenantId: string; queueItemId: string }[] = []
  const positionsByTenant: Record<string, number[]> = {}
  for (;;) {
    const candidate = selectWeightedFairCandidate(
      remaining,
      input.policies,
      input.now,
    )
    if (!candidate) break
    const index = remaining.indexOf(candidate)
    remaining.splice(index, 1)
    selectionOrder.push({
      tenantId: candidate.tenantId,
      queueItemId: candidate.queueItemId,
    })
    const positions = (positionsByTenant[candidate.tenantId] ??= [])
    positions.push(selectionOrder.length)
  }
  const maxPositionByTenant: Record<string, number> = {}
  for (const [tenantId, positions] of Object.entries(positionsByTenant))
    maxPositionByTenant[tenantId] = Math.max(...positions)
  return { selectionOrder, positionsByTenant, maxPositionByTenant }
}

export function assertQueuePositionBudget(
  result: FairShareSimulationResult,
  budget: TenantCapacityBudget,
): void {
  const positions = result.positionsByTenant[budget.tenantId]
  if (!positions || positions.length === 0)
    throw new TenantRuntimeError(`TENANT_BUDGET_ERODED:${budget.tenantId}`)
  const firstPosition = positions[0]!
  if (firstPosition > budget.maxStarvationPosition)
    throw new TenantRuntimeError(
      `TENANT_BUDGET_ERODED:${budget.tenantId}:first-position-${firstPosition}`,
    )
}

// --- Repository ve resource port'ları ---

export interface RecordedRuntimeCredential {
  credentialId: string
  tenantId: string
  organizationId: string
  workspaceId: string
  runtimeId: string
  generation: number
  actions: readonly RuntimeDataPlaneAction[]
  tokenDigest: string
  expiresAt: string
}

export interface TenantRuntimeRepository {
  getTenant(scope: TenantRuntimeScope): Promise<ManagedTenant | undefined>
  putTenant(
    tenant: ManagedTenant,
    expectedVersion: number | null,
  ): Promise<void>
  listTenants(): Promise<ManagedTenant[]>
  getRuntime(
    scope: TenantRuntimeScope,
    workspaceId: string,
  ): Promise<TenantRuntime | undefined>
  putRuntime(
    runtime: TenantRuntime,
    expectedVersion: number | null,
  ): Promise<void>
  listRuntimes(scope?: TenantRuntimeScope): Promise<TenantRuntime[]>
  getJob(
    scope: TenantRuntimeScope,
    jobId: string,
  ): Promise<ProvisioningJob | undefined>
  getJobByIdempotencyKey(
    scope: TenantRuntimeScope,
    idempotencyKey: string,
  ): Promise<ProvisioningJob | undefined>
  putJob(job: ProvisioningJob, expectedVersion: number | null): Promise<void>
  listIncompleteJobs(scope: TenantRuntimeScope): Promise<ProvisioningJob[]>
  recordCredential(credential: RecordedRuntimeCredential): Promise<void>
  revokeCredential(credentialId: string): Promise<void>
  isCredentialRevoked(credentialId: string): Promise<boolean>
  recordOrphan(orphan: OrphanRuntime): Promise<void>
  listOrphans(state?: OrphanRuntime['state']): Promise<OrphanRuntime[]>
  markOrphanCleaned(observedRuntimeId: string): Promise<void>
  getCapacityBudget(
    scope: TenantRuntimeScope,
  ): Promise<TenantCapacityBudget | undefined>
  putCapacityBudget(
    budget: TenantCapacityBudget,
    expectedVersion: number | null,
  ): Promise<void>
  listCapacityBudgets(): Promise<TenantCapacityBudget[]>
}

export interface ObservedRuntime {
  runtimeId: string
  tenantId: string
  organizationId: string
  workspaceId: string
  generation: number
}

export interface TenantResourceScope extends TenantRuntimeScope {
  workspaceId: string
  runtimeId: string
}

export interface TenantRuntimeResources {
  ensureRuntimeIdentity(
    input: TenantResourceScope,
  ): Promise<{ identitySubject: string }>
  ensureEncryptionKey(input: TenantResourceScope): Promise<{
    kmsProvider: string
    kmsKeyId: string
    kmsKeyVersion: number
  }>
  cryptoEraseKey(input: TenantResourceScope): Promise<void>
  ensureVolume(
    input: TenantResourceScope,
  ): Promise<{ volumeId: string; encrypted: boolean }>
  releaseVolume(input: TenantResourceScope): Promise<void>
  ensureSecretNamespace(
    input: TenantResourceScope,
  ): Promise<{ secretNamespace: string }>
  purgeSecretNamespace(input: TenantResourceScope): Promise<void>
  ensureNetworkPolicy(
    input: TenantResourceScope,
  ): Promise<{ networkPolicyId: string; defaultDeny: boolean }>
  removeNetworkPolicy(input: TenantResourceScope): Promise<void>
  ensurePlacement(
    input: TenantResourceScope & { regionId: string; capacity: CapacityVector },
  ): Promise<{ nodeId: string }>
  releasePlacement(input: TenantResourceScope): Promise<void>
  reserveCapacity(
    input: TenantResourceScope & { capacity: CapacityVector },
  ): Promise<{ capacityReservationId: string }>
  releaseCapacity(input: TenantResourceScope): Promise<void>
  startRuntime(
    input: TenantResourceScope & { generation: number },
  ): Promise<void>
  drainRuntime(input: TenantResourceScope): Promise<void>
  destroyRuntime(observedRuntimeId: string): Promise<void>
  listObservedRuntimes(): Promise<ObservedRuntime[]>
}

// --- In-memory implementasyonlar (test ve gate harness'i) ---

const scopeKey = (scope: TenantRuntimeScope, ...rest: string[]) =>
  JSON.stringify([scope.tenantId, scope.organizationId, ...rest])

export class InMemoryTenantRuntimeRepository implements TenantRuntimeRepository {
  readonly #tenants = new Map<string, ManagedTenant>()
  readonly #runtimes = new Map<string, TenantRuntime>()
  readonly #jobs = new Map<string, ProvisioningJob>()
  readonly #credentials = new Map<string, RecordedRuntimeCredential>()
  readonly #revokedCredentials = new Set<string>()
  readonly #orphans = new Map<string, OrphanRuntime>()
  readonly #budgets = new Map<string, TenantCapacityBudget>()

  #cas(currentVersion: number | undefined, expectedVersion: number | null) {
    if ((currentVersion ?? null) !== expectedVersion)
      throw new TenantRuntimeError('TENANT_RUNTIME_VERSION_CONFLICT')
  }

  async getTenant(scope: TenantRuntimeScope) {
    return this.#tenants.get(scopeKey(scope))
  }
  async putTenant(tenant: ManagedTenant, expectedVersion: number | null) {
    const parsed = managedTenantSchema.parse(tenant)
    this.#cas(this.#tenants.get(scopeKey(parsed))?.version, expectedVersion)
    this.#tenants.set(scopeKey(parsed), parsed)
  }
  async listTenants() {
    return [...this.#tenants.values()]
  }
  async getRuntime(scope: TenantRuntimeScope, workspaceId: string) {
    return this.#runtimes.get(scopeKey(scope, workspaceId))
  }
  async putRuntime(runtime: TenantRuntime, expectedVersion: number | null) {
    const parsed = tenantRuntimeSchema.parse(runtime)
    const key = scopeKey(parsed, parsed.workspaceId)
    this.#cas(this.#runtimes.get(key)?.version, expectedVersion)
    this.#runtimes.set(key, parsed)
  }
  async listRuntimes(_scope?: TenantRuntimeScope) {
    return [...this.#runtimes.values()]
  }
  async getJob(scope: TenantRuntimeScope, jobId: string) {
    return this.#jobs.get(scopeKey(scope, jobId))
  }
  async getJobByIdempotencyKey(
    scope: TenantRuntimeScope,
    idempotencyKey: string,
  ) {
    return [...this.#jobs.values()].find(
      (job) =>
        job.tenantId === scope.tenantId &&
        job.organizationId === scope.organizationId &&
        job.idempotencyKey === idempotencyKey,
    )
  }
  async putJob(job: ProvisioningJob, expectedVersion: number | null) {
    const parsed = provisioningJobSchema.parse(job)
    const key = scopeKey(parsed, parsed.jobId)
    this.#cas(this.#jobs.get(key)?.version, expectedVersion)
    this.#jobs.set(key, parsed)
  }
  async listIncompleteJobs(scope: TenantRuntimeScope) {
    return [...this.#jobs.values()]
      .filter(
        (job) =>
          job.tenantId === scope.tenantId &&
          job.organizationId === scope.organizationId &&
          job.state !== 'completed',
      )
      .sort((left, right) => left.jobId.localeCompare(right.jobId))
  }
  async recordCredential(credential: RecordedRuntimeCredential) {
    this.#credentials.set(credential.credentialId, credential)
  }
  async revokeCredential(credentialId: string) {
    this.#revokedCredentials.add(credentialId)
  }
  async isCredentialRevoked(credentialId: string) {
    return this.#revokedCredentials.has(credentialId)
  }
  async recordOrphan(orphan: OrphanRuntime) {
    const parsed = orphanRuntimeSchema.parse(orphan)
    const existing = this.#orphans.get(parsed.observedRuntimeId)
    if (existing?.state === 'cleaned') return
    this.#orphans.set(parsed.observedRuntimeId, parsed)
  }
  async listOrphans(state?: OrphanRuntime['state']) {
    return [...this.#orphans.values()]
      .filter((orphan) => state === undefined || orphan.state === state)
      .sort((left, right) =>
        left.observedRuntimeId.localeCompare(right.observedRuntimeId),
      )
  }
  async markOrphanCleaned(observedRuntimeId: string) {
    const orphan = this.#orphans.get(observedRuntimeId)
    if (orphan)
      this.#orphans.set(observedRuntimeId, { ...orphan, state: 'cleaned' })
  }
  async getCapacityBudget(scope: TenantRuntimeScope) {
    return this.#budgets.get(scopeKey(scope))
  }
  async putCapacityBudget(
    budget: TenantCapacityBudget,
    expectedVersion: number | null,
  ) {
    this.#cas(this.#budgets.get(scopeKey(budget))?.version, expectedVersion)
    this.#budgets.set(scopeKey(budget), budget)
  }
  async listCapacityBudgets() {
    return [...this.#budgets.values()]
  }
}

export class InMemoryTenantRuntimeResources implements TenantRuntimeResources {
  readonly #nodeCapacity: CapacityVector
  readonly #budgets: () => Promise<TenantCapacityBudget[]>
  readonly #reservations = new Map<
    string,
    { tenantId: string; capacity: CapacityVector }
  >()
  readonly #observed = new Map<string, ObservedRuntime>()
  readonly #erasedKeys = new Set<string>()
  readonly #faults = new Set<string>()
  readonly calls: string[] = []

  constructor(
    options: {
      nodeCapacity?: CapacityVector
      budgets?: () => Promise<TenantCapacityBudget[]>
    } = {},
  ) {
    this.#nodeCapacity = options.nodeCapacity ?? {
      ...ZERO_CAPACITY,
      cpuMillis: 8_000,
      memoryBytes: 16_000_000_000,
      pids: 4_096,
      diskBytes: 100_000_000_000,
    }
    this.#budgets = options.budgets ?? (async () => [])
  }

  failNextCall(method: string) {
    this.#faults.add(method)
  }

  #trace(method: string, input: TenantResourceScope | { runtimeId: string }) {
    this.calls.push(`${method}:${'tenantId' in input ? input.tenantId : ''}`)
    if (this.#faults.delete(method))
      throw new TenantRuntimeError(`INJECTED_FAULT:${method}`)
  }

  async ensureRuntimeIdentity(input: TenantResourceScope) {
    this.#trace('ensureRuntimeIdentity', input)
    return {
      identitySubject: `runtime:${input.tenantId}:${input.workspaceId}`,
    }
  }
  async ensureEncryptionKey(input: TenantResourceScope) {
    this.#trace('ensureEncryptionKey', input)
    const keyId = `key_${input.tenantId}_${input.workspaceId}`
    if (this.#erasedKeys.has(keyId))
      throw new TenantRuntimeError('WORKSPACE_CRYPTO_ERASED')
    return { kmsProvider: 'local-memory', kmsKeyId: keyId, kmsKeyVersion: 1 }
  }
  async cryptoEraseKey(input: TenantResourceScope) {
    this.#trace('cryptoEraseKey', input)
    this.#erasedKeys.add(`key_${input.tenantId}_${input.workspaceId}`)
  }
  isKeyErased(scope: TenantRuntimeScope, workspaceId: string) {
    return this.#erasedKeys.has(`key_${scope.tenantId}_${workspaceId}`)
  }
  async ensureVolume(input: TenantResourceScope) {
    this.#trace('ensureVolume', input)
    return {
      volumeId: `vol_${input.tenantId}_${input.workspaceId}`,
      encrypted: true,
    }
  }
  async releaseVolume(input: TenantResourceScope) {
    this.#trace('releaseVolume', input)
  }
  async ensureSecretNamespace(input: TenantResourceScope) {
    this.#trace('ensureSecretNamespace', input)
    return { secretNamespace: `secrets/${input.tenantId}/${input.workspaceId}` }
  }
  async purgeSecretNamespace(input: TenantResourceScope) {
    this.#trace('purgeSecretNamespace', input)
  }
  async ensureNetworkPolicy(input: TenantResourceScope) {
    this.#trace('ensureNetworkPolicy', input)
    return {
      networkPolicyId: `netpol_${input.tenantId}_${input.workspaceId}`,
      defaultDeny: true,
    }
  }
  async removeNetworkPolicy(input: TenantResourceScope) {
    this.#trace('removeNetworkPolicy', input)
  }
  async ensurePlacement(
    input: TenantResourceScope & { regionId: string; capacity: CapacityVector },
  ) {
    this.#trace('ensurePlacement', input)
    return { nodeId: `${input.regionId}-node-1` }
  }
  async releasePlacement(input: TenantResourceScope) {
    this.#trace('releasePlacement', input)
  }
  async reserveCapacity(
    input: TenantResourceScope & { capacity: CapacityVector },
  ) {
    this.#trace('reserveCapacity', input)
    const reservationId = `resv_${input.tenantId}_${input.workspaceId}`
    if (!this.#reservations.has(reservationId)) {
      assertReservationWithinBudgets({
        nodeCapacity: this.#nodeCapacity,
        budgets: await this.#budgets(),
        existingReservations: [...this.#reservations.values()],
        tenantId: input.tenantId,
        requested: input.capacity,
      })
      this.#reservations.set(reservationId, {
        tenantId: input.tenantId,
        capacity: input.capacity,
      })
    }
    return { capacityReservationId: reservationId }
  }
  async releaseCapacity(input: TenantResourceScope) {
    this.#trace('releaseCapacity', input)
    this.#reservations.delete(`resv_${input.tenantId}_${input.workspaceId}`)
  }
  listReservations() {
    return [...this.#reservations.entries()].map(([id, entry]) => ({
      capacityReservationId: id,
      ...entry,
    }))
  }
  async startRuntime(input: TenantResourceScope & { generation: number }) {
    this.#trace('startRuntime', input)
    this.#observed.set(input.runtimeId, {
      runtimeId: input.runtimeId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      generation: input.generation,
    })
  }
  async drainRuntime(input: TenantResourceScope) {
    this.#trace('drainRuntime', input)
  }
  async destroyRuntime(observedRuntimeId: string) {
    this.#trace('destroyRuntime', { runtimeId: observedRuntimeId })
    this.#observed.delete(observedRuntimeId)
  }
  injectObservedRuntime(runtime: ObservedRuntime) {
    this.#observed.set(runtime.runtimeId, runtime)
  }
  async listObservedRuntimes() {
    return [...this.#observed.values()].sort((left, right) =>
      left.runtimeId.localeCompare(right.runtimeId),
    )
  }
}

// --- Provisioning yaşam döngüsü ---

export interface ProvisionTenantInput extends TenantRuntimeScope {
  workspaceId: string
  displayName: string
  regionId: string
  capacity: CapacityVector
  retentionDays?: number
  retentionPolicyId?: string | null
  domain?: string | null
  idempotencyKey: string
}

const stepsFor = (kind: ProvisioningJobKind): readonly string[] => {
  switch (kind) {
    case 'provision':
    case 'resume':
      return PROVISION_STEPS
    case 'suspend':
      return SUSPEND_STEPS
    case 'delete':
      return DELETE_STEPS
  }
}

export class TenantProvisioningService {
  readonly #repository: TenantRuntimeRepository
  readonly #resources: TenantRuntimeResources

  constructor(options: {
    repository: TenantRuntimeRepository
    resources: TenantRuntimeResources
  }) {
    this.#repository = options.repository
    this.#resources = options.resources
  }

  async provisionTenant(input: ProvisionTenantInput): Promise<{
    tenant: ManagedTenant
    runtime: TenantRuntime
    job: ProvisioningJob
  }> {
    const scope = {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    }
    let tenant = await this.#repository.getTenant(scope)
    if (!tenant) {
      tenant = managedTenantSchema.parse({
        schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
        ...scope,
        displayName: input.displayName,
        state: 'provisioning',
        desiredState: 'active',
        domain: input.domain ?? null,
        regionId: input.regionId,
        retentionPolicyId: input.retentionPolicyId ?? null,
        retentionDays: input.retentionDays ?? 90,
        capacity: input.capacity,
        version: 1,
      })
      await this.#repository.putTenant(tenant, null)
    }
    let runtime = await this.#repository.getRuntime(scope, input.workspaceId)
    if (!runtime) {
      runtime = tenantRuntimeSchema.parse({
        schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
        ...scope,
        workspaceId: input.workspaceId,
        runtimeId: `rt_${input.tenantId}_${input.workspaceId}_g1`,
        generation: 1,
        state: 'requested',
        identitySubject: null,
        volumeId: null,
        volumeEncrypted: false,
        kmsProvider: null,
        kmsKeyId: null,
        kmsKeyVersion: null,
        secretNamespace: null,
        networkPolicyId: null,
        regionId: input.regionId,
        nodeId: null,
        capacityReservationId: null,
        version: 1,
      })
      await this.#repository.putRuntime(runtime, null)
    }
    const job = await this.#ensureJob(scope, {
      kind: 'provision',
      workspaceId: input.workspaceId,
      runtimeId: runtime.runtimeId,
      idempotencyKey: input.idempotencyKey,
    })
    const finished = await this.runJob(scope, job.jobId)
    return {
      tenant: (await this.#repository.getTenant(scope))!,
      runtime: (await this.#repository.getRuntime(scope, input.workspaceId))!,
      job: finished,
    }
  }

  async suspendTenant(input: TenantRuntimeScope & { idempotencyKey: string }) {
    return this.#lifecycle(input, 'suspend', 'suspended')
  }

  async resumeTenant(input: TenantRuntimeScope & { idempotencyKey: string }) {
    return this.#lifecycle(input, 'resume', 'active')
  }

  async deleteTenant(input: TenantRuntimeScope & { idempotencyKey: string }) {
    return this.#lifecycle(input, 'delete', 'deleted')
  }

  async #lifecycle(
    input: TenantRuntimeScope & { idempotencyKey: string },
    kind: ProvisioningJobKind,
    desiredState: ManagedTenant['desiredState'],
  ) {
    const scope = {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    }
    const tenant = await this.#repository.getTenant(scope)
    if (!tenant) throw new TenantRuntimeError('TENANT_NOT_FOUND')
    if (tenant.desiredState !== desiredState)
      await this.#repository.putTenant(
        { ...tenant, desiredState, version: tenant.version + 1 },
        tenant.version,
      )
    const runtimes = (await this.#repository.listRuntimes(scope)).filter(
      (runtime) =>
        runtime.tenantId === scope.tenantId &&
        runtime.organizationId === scope.organizationId &&
        runtime.state !== 'deleted',
    )
    let lastJob: ProvisioningJob | undefined
    for (const runtime of runtimes) {
      const job = await this.#ensureJob(scope, {
        kind,
        workspaceId: runtime.workspaceId,
        runtimeId: runtime.runtimeId,
        idempotencyKey: `${input.idempotencyKey}:${runtime.workspaceId}`,
      })
      lastJob = await this.runJob(scope, job.jobId)
    }
    return {
      tenant: (await this.#repository.getTenant(scope))!,
      job: lastJob,
    }
  }

  async #ensureJob(
    scope: TenantRuntimeScope,
    input: {
      kind: ProvisioningJobKind
      workspaceId: string
      runtimeId: string
      idempotencyKey: string
    },
  ): Promise<ProvisioningJob> {
    const existing = await this.#repository.getJobByIdempotencyKey(
      scope,
      input.idempotencyKey,
    )
    if (existing) {
      if (existing.kind !== input.kind)
        throw new TenantRuntimeError('PROVISIONING_IDEMPOTENCY_CONFLICT')
      return existing
    }
    const job = provisioningJobSchema.parse({
      schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
      ...scope,
      jobId: `job_${createHash('sha256')
        .update(`${scope.tenantId}:${input.idempotencyKey}`)
        .digest('hex')
        .slice(0, 24)}`,
      kind: input.kind,
      workspaceId: input.workspaceId,
      runtimeId: input.runtimeId,
      state: 'requested',
      currentStep: null,
      completedSteps: [],
      idempotencyKey: input.idempotencyKey,
      attempt: 0,
      lastErrorCode: null,
      version: 1,
    })
    await this.#repository.putJob(job, null)
    return job
  }

  // Checkpointed, idempotent adım yürütücüsü: yarım kalan job yeniden
  // koşulduğunda tamamlanmış adımları atlar ve aynı hedef duruma yakınsar.
  async runJob(
    scope: TenantRuntimeScope,
    jobId: string,
  ): Promise<ProvisioningJob> {
    let job = await this.#repository.getJob(scope, jobId)
    if (!job) throw new TenantRuntimeError('PROVISIONING_JOB_NOT_FOUND')
    if (job.state === 'completed') return job
    job = await this.#saveJob(job, {
      state: 'running',
      attempt: job.attempt + 1,
      lastErrorCode: null,
    })
    const steps = stepsFor(job.kind)
    for (const step of steps) {
      if (job.completedSteps.includes(step)) continue
      job = await this.#saveJob(job, { currentStep: step })
      try {
        await this.#executeStep(scope, job, step)
      } catch (error) {
        const code =
          error instanceof TenantRuntimeError
            ? error.code
            : 'PROVISIONING_STEP_FAILED'
        await this.#saveJob(job, {
          state: 'failed',
          lastErrorCode: code.slice(0, 255),
        })
        throw error
      }
      job = await this.#saveJob(job, {
        completedSteps: [...job.completedSteps, step],
      })
    }
    return this.#saveJob(job, { state: 'completed', currentStep: null })
  }

  async #saveJob(
    job: ProvisioningJob,
    patch: Partial<ProvisioningJob>,
  ): Promise<ProvisioningJob> {
    const next = provisioningJobSchema.parse({
      ...job,
      ...patch,
      version: job.version + 1,
    })
    await this.#repository.putJob(next, job.version)
    return next
  }

  async #saveRuntime(
    runtime: TenantRuntime,
    patch: Partial<TenantRuntime>,
  ): Promise<TenantRuntime> {
    const next = tenantRuntimeSchema.parse({
      ...runtime,
      ...patch,
      version: runtime.version + 1,
    })
    await this.#repository.putRuntime(next, runtime.version)
    return next
  }

  async #saveTenant(
    tenant: ManagedTenant,
    patch: Partial<ManagedTenant>,
  ): Promise<ManagedTenant> {
    const next = managedTenantSchema.parse({
      ...tenant,
      ...patch,
      version: tenant.version + 1,
    })
    await this.#repository.putTenant(next, tenant.version)
    return next
  }

  async #executeStep(
    scope: TenantRuntimeScope,
    job: ProvisioningJob,
    step: string,
  ): Promise<void> {
    const runtime = await this.#repository.getRuntime(scope, job.workspaceId)
    if (!runtime) throw new TenantRuntimeError('TENANT_RUNTIME_NOT_FOUND')
    const tenant = await this.#repository.getTenant(scope)
    if (!tenant) throw new TenantRuntimeError('TENANT_NOT_FOUND')
    const resourceScope = {
      ...scope,
      workspaceId: runtime.workspaceId,
      runtimeId: runtime.runtimeId,
    }
    switch (step) {
      case 'runtime_identity': {
        const identity =
          await this.#resources.ensureRuntimeIdentity(resourceScope)
        await this.#saveRuntime(runtime, {
          state: 'provisioning',
          identitySubject: identity.identitySubject,
        })
        return
      }
      case 'encryption_key': {
        const key = await this.#resources.ensureEncryptionKey(resourceScope)
        await this.#saveRuntime(runtime, {
          kmsProvider: key.kmsProvider,
          kmsKeyId: key.kmsKeyId,
          kmsKeyVersion: key.kmsKeyVersion,
        })
        return
      }
      case 'filesystem_volume': {
        const volume = await this.#resources.ensureVolume(resourceScope)
        if (!volume.encrypted)
          throw new TenantRuntimeError('TENANT_VOLUME_UNENCRYPTED')
        await this.#saveRuntime(runtime, {
          volumeId: volume.volumeId,
          volumeEncrypted: true,
        })
        return
      }
      case 'secret_namespace': {
        const namespace =
          await this.#resources.ensureSecretNamespace(resourceScope)
        await this.#saveRuntime(runtime, {
          secretNamespace: namespace.secretNamespace,
        })
        return
      }
      case 'network_policy': {
        const policy = await this.#resources.ensureNetworkPolicy(resourceScope)
        if (!policy.defaultDeny)
          throw new TenantRuntimeError('TENANT_NETWORK_POLICY_NOT_DEFAULT_DENY')
        await this.#saveRuntime(runtime, {
          networkPolicyId: policy.networkPolicyId,
        })
        return
      }
      case 'placement': {
        const placement = await this.#resources.ensurePlacement({
          ...resourceScope,
          regionId: runtime.regionId,
          capacity: tenant.capacity,
        })
        await this.#saveRuntime(runtime, { nodeId: placement.nodeId })
        return
      }
      case 'capacity_reservation': {
        const reservation = await this.#resources.reserveCapacity({
          ...resourceScope,
          capacity: tenant.capacity,
        })
        await this.#saveRuntime(runtime, {
          capacityReservationId: reservation.capacityReservationId,
        })
        return
      }
      case 'runtime_ready': {
        await this.#resources.startRuntime({
          ...resourceScope,
          generation: runtime.generation,
        })
        await this.#saveRuntime(runtime, { state: 'ready' })
        await this.#saveTenant(tenant, { state: 'active' })
        return
      }
      case 'runtime_drain': {
        await this.#resources.drainRuntime(resourceScope)
        return
      }
      case 'capacity_release': {
        await this.#resources.releaseCapacity(resourceScope)
        await this.#saveRuntime(runtime, { capacityReservationId: null })
        return
      }
      case 'runtime_stop': {
        await this.#resources.destroyRuntime(runtime.runtimeId)
        await this.#saveRuntime(runtime, { state: 'suspended' })
        await this.#saveTenant(tenant, { state: 'suspended' })
        return
      }
      case 'runtime_destroy': {
        await this.#resources.destroyRuntime(runtime.runtimeId)
        await this.#saveRuntime(runtime, { state: 'deleting' })
        await this.#saveTenant(tenant, { state: 'deleting' })
        return
      }
      case 'secret_namespace_purge': {
        await this.#resources.purgeSecretNamespace(resourceScope)
        await this.#saveRuntime(runtime, { secretNamespace: null })
        return
      }
      case 'network_policy_remove': {
        await this.#resources.removeNetworkPolicy(resourceScope)
        await this.#saveRuntime(runtime, { networkPolicyId: null })
        return
      }
      case 'volume_release': {
        await this.#resources.releaseVolume(resourceScope)
        await this.#saveRuntime(runtime, { volumeId: null })
        return
      }
      case 'key_crypto_erase': {
        await this.#resources.cryptoEraseKey(resourceScope)
        return
      }
      case 'metadata_cleanup': {
        await this.#resources.releasePlacement(resourceScope)
        await this.#saveRuntime(runtime, {
          state: 'deleted',
          identitySubject: null,
          nodeId: null,
        })
        return
      }
      case 'deletion_receipt': {
        await this.#saveTenant(tenant, { state: 'deleted' })
        return
      }
      default:
        throw new TenantRuntimeError(`PROVISIONING_STEP_UNKNOWN:${step}`)
    }
  }

  // Idempotent reconciliation: kesilen işlemler yeniden koşulduğunda aynı
  // hedef duruma yakınsar. Yakınsayamayan durumlar action listesiyle raporlanır.
  async reconcile(
    scope: TenantRuntimeScope,
  ): Promise<{ converged: boolean; actions: string[] }> {
    const actions: string[] = []
    for (let round = 0; round < 4; round += 1) {
      const incomplete = await this.#repository.listIncompleteJobs(scope)
      for (const job of incomplete) {
        try {
          await this.runJob(scope, job.jobId)
          actions.push(`job-resumed:${job.kind}:${job.jobId}`)
        } catch (error) {
          actions.push(
            `job-failed:${job.jobId}:${
              error instanceof TenantRuntimeError ? error.code : 'unknown'
            }`,
          )
          return { converged: false, actions }
        }
      }
      const tenant = await this.#repository.getTenant(scope)
      if (!tenant) return { converged: true, actions }
      const targetState = tenant.desiredState
      if (tenant.state === targetState) return { converged: true, actions }
      const kind: ProvisioningJobKind =
        targetState === 'active'
          ? tenant.state === 'provisioning'
            ? 'provision'
            : 'resume'
          : targetState === 'suspended'
            ? 'suspend'
            : 'delete'
      const runtimes = (await this.#repository.listRuntimes(scope)).filter(
        (runtime) =>
          runtime.tenantId === scope.tenantId &&
          runtime.organizationId === scope.organizationId &&
          runtime.state !== 'deleted',
      )
      if (runtimes.length === 0) return { converged: true, actions }
      for (const runtime of runtimes) {
        const job = await this.#ensureJob(scope, {
          kind,
          workspaceId: runtime.workspaceId,
          runtimeId: runtime.runtimeId,
          idempotencyKey: `reconcile:${kind}:${runtime.workspaceId}:${tenant.version}`,
        })
        try {
          await this.runJob(scope, job.jobId)
          actions.push(`job-created:${kind}:${job.jobId}`)
        } catch (error) {
          actions.push(
            `job-failed:${job.jobId}:${
              error instanceof TenantRuntimeError ? error.code : 'unknown'
            }`,
          )
          return { converged: false, actions }
        }
      }
    }
    const tenant = await this.#repository.getTenant(scope)
    return {
      converged: tenant ? tenant.state === tenant.desiredState : true,
      actions,
    }
  }

  // Runtime silme/yeniden oluşturma: yeni generation ile aynı workspace için
  // taze runtime kurar; durable conversation/output bu paketin dışında
  // (PostgreSQL/object storage) yaşadığı için etkilenmez.
  async recreateRuntime(
    input: TenantRuntimeScope & { workspaceId: string; idempotencyKey: string },
  ): Promise<TenantRuntime> {
    const scope = {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    }
    const runtime = await this.#repository.getRuntime(scope, input.workspaceId)
    if (!runtime) throw new TenantRuntimeError('TENANT_RUNTIME_NOT_FOUND')
    await this.#resources.destroyRuntime(runtime.runtimeId)
    const generation = runtime.generation + 1
    const recreated = await this.#saveRuntime(runtime, {
      runtimeId: `rt_${input.tenantId}_${input.workspaceId}_g${generation}`,
      generation,
      state: 'requested',
      identitySubject: null,
      volumeId: null,
      volumeEncrypted: false,
      kmsProvider: null,
      kmsKeyId: null,
      kmsKeyVersion: null,
      secretNamespace: null,
      networkPolicyId: null,
      nodeId: null,
      capacityReservationId: null,
    })
    const job = await this.#ensureJob(scope, {
      kind: 'resume',
      workspaceId: input.workspaceId,
      runtimeId: recreated.runtimeId,
      idempotencyKey: input.idempotencyKey,
    })
    await this.runJob(scope, job.jobId)
    return (await this.#repository.getRuntime(scope, input.workspaceId))!
  }

  // Orphan runtime tespiti: runtime düzleminde görülen fakat durable kaydı
  // aktif olmayan runtime'lar işaretlenir.
  async detectOrphans(): Promise<OrphanRuntime[]> {
    const observed = await this.#resources.listObservedRuntimes()
    const durable = await this.#repository.listRuntimes()
    const detected: OrphanRuntime[] = []
    for (const candidate of observed) {
      const record = durable.find(
        (runtime) =>
          runtime.tenantId === candidate.tenantId &&
          runtime.organizationId === candidate.organizationId &&
          runtime.workspaceId === candidate.workspaceId,
      )
      let reason: OrphanRuntime['reason'] | undefined
      if (!record || record.state === 'deleted')
        reason = 'missing-durable-record'
      else if (
        record.runtimeId !== candidate.runtimeId ||
        record.generation !== candidate.generation
      )
        reason = 'stale-generation'
      if (!reason) continue
      const orphan: OrphanRuntime = {
        schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
        observedRuntimeId: candidate.runtimeId,
        reason,
        state: 'detected',
      }
      await this.#repository.recordOrphan(orphan)
      detected.push(orphan)
    }
    return detected
  }

  // Bounded cleanup: her koşuda en fazla `limit` orphan yok edilir.
  async cleanupOrphans(
    limit: number,
  ): Promise<{ cleaned: number; remaining: number }> {
    if (!Number.isInteger(limit) || limit < 1)
      throw new TenantRuntimeError('ORPHAN_CLEANUP_LIMIT_INVALID')
    const detected = await this.#repository.listOrphans('detected')
    const batch = detected.slice(0, limit)
    for (const orphan of batch) {
      await this.#resources.destroyRuntime(orphan.observedRuntimeId)
      await this.#repository.markOrphanCleaned(orphan.observedRuntimeId)
    }
    return { cleaned: batch.length, remaining: detected.length - batch.length }
  }
}

// --- Control plane ↔ runtime data plane internal auth ---

const constantTimeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false
  let mismatch = 0
  for (let index = 0; index < leftBuffer.byteLength; index += 1)
    mismatch |= leftBuffer[index]! ^ rightBuffer[index]!
  return mismatch === 0
}

export class RuntimeDataPlaneAuthority {
  readonly #signingKey: Buffer
  readonly #maxTtlMs: number
  readonly #revoked = new Set<string>()
  readonly #repository: TenantRuntimeRepository | undefined

  constructor(
    options: {
      signingKey?: Uint8Array
      maxTtlMs?: number
      repository?: TenantRuntimeRepository
    } = {},
  ) {
    this.#signingKey = Buffer.from(options.signingKey ?? randomBytes(32))
    if (this.#signingKey.byteLength < 32)
      throw new TenantRuntimeError('RUNTIME_SIGNING_KEY_TOO_SHORT')
    this.#maxTtlMs = options.maxTtlMs ?? 5 * 60_000
    this.#repository = options.repository
  }

  async issue(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    runtimeId: string
    generation: number
    actions?: readonly RuntimeDataPlaneAction[]
    ttlMs?: number
    now?: Date
  }): Promise<IssuedRuntimeCredential> {
    const now = input.now ?? new Date()
    const ttlMs = Math.min(input.ttlMs ?? 60_000, this.#maxTtlMs)
    if (ttlMs < 1_000)
      throw new TenantRuntimeError('RUNTIME_CREDENTIAL_TTL_INVALID')
    const claims: RuntimeCredentialClaims = runtimeCredentialClaimsSchema.parse(
      {
        version: TENANT_RUNTIME_CONTRACT_VERSION,
        credentialId: randomUUID(),
        subject: `runtime-data-plane:${input.runtimeId}`,
        audience: RUNTIME_DATA_PLANE_AUDIENCE,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        runtimeId: input.runtimeId,
        generation: input.generation,
        actions: [...(input.actions ?? RUNTIME_DATA_PLANE_ACTIONS)],
        issuedAt: now.getTime(),
        expiresAt: now.getTime() + ttlMs,
      },
    )
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString(
      'base64url',
    )
    const signature = createHmac('sha256', this.#signingKey)
      .update(payload)
      .digest('base64url')
    const accessToken = `pdp1.${payload}.${signature}`
    const credential = issuedRuntimeCredentialSchema.parse({
      credentialId: claims.credentialId,
      accessToken,
      tokenDigest: createHash('sha256').update(accessToken).digest('hex'),
      expiresAt: new Date(claims.expiresAt).toISOString(),
    })
    if (this.#repository)
      await this.#repository.recordCredential({
        credentialId: claims.credentialId,
        tenantId: claims.tenantId,
        organizationId: claims.organizationId,
        workspaceId: claims.workspaceId,
        runtimeId: claims.runtimeId,
        generation: claims.generation,
        actions: claims.actions,
        tokenDigest: credential.tokenDigest,
        expiresAt: credential.expiresAt,
      })
    return credential
  }

  async revoke(credentialId: string): Promise<void> {
    this.#revoked.add(credentialId)
    if (this.#repository) await this.#repository.revokeCredential(credentialId)
  }

  // Deny-by-default doğrulama: kimliksiz, imzasız, süresi geçmiş, revoke
  // edilmiş, yanlış tenant/workspace/runtime/generation veya listede olmayan
  // action typed hata ile reddedilir.
  async verify(input: {
    authorization?: string | undefined
    action: RuntimeDataPlaneAction
    tenantId: string
    organizationId: string
    workspaceId: string
    runtimeId?: string
    generation?: number
    now?: Date
  }): Promise<RuntimeCredentialClaims> {
    const token = input.authorization?.match(/^Bearer (pdp1\.[^\s]+)$/)?.[1]
    if (!token) throw new TenantRuntimeError('RUNTIME_AUTH_REQUIRED')
    const [, payload, signature] = token.split('.')
    if (!payload || !signature)
      throw new TenantRuntimeError('RUNTIME_TOKEN_MALFORMED')
    const expected = createHmac('sha256', this.#signingKey)
      .update(payload)
      .digest('base64url')
    if (!constantTimeEqual(signature, expected))
      throw new TenantRuntimeError('RUNTIME_TOKEN_SIGNATURE_INVALID')
    let claims: RuntimeCredentialClaims
    try {
      claims = runtimeCredentialClaimsSchema.parse(
        JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      )
    } catch {
      throw new TenantRuntimeError('RUNTIME_TOKEN_MALFORMED')
    }
    const now = input.now ?? new Date()
    const revoked =
      this.#revoked.has(claims.credentialId) ||
      (this.#repository
        ? await this.#repository.isCredentialRevoked(claims.credentialId)
        : false)
    if (
      claims.audience !== RUNTIME_DATA_PLANE_AUDIENCE ||
      claims.expiresAt <= now.getTime() ||
      claims.issuedAt > now.getTime() + 5_000 ||
      revoked
    )
      throw new TenantRuntimeError('RUNTIME_TOKEN_REJECTED')
    if (
      claims.tenantId !== input.tenantId ||
      claims.organizationId !== input.organizationId ||
      claims.workspaceId !== input.workspaceId ||
      (input.runtimeId !== undefined && claims.runtimeId !== input.runtimeId) ||
      (input.generation !== undefined &&
        claims.generation !== input.generation) ||
      !claims.actions.includes(input.action)
    )
      throw new TenantRuntimeError('RUNTIME_SCOPE_REJECTED')
    return claims
  }
}
