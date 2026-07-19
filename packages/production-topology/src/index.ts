export * from './contracts'

import type {
  CapacityVector,
  DependencyReadiness,
  SchedulerQueueItem,
  TenantSchedulingPolicy,
} from './contracts'

export const ZERO_CAPACITY: CapacityVector = {
  schemaVersion: 1,
  cpuMillis: 0,
  memoryBytes: 0,
  pids: 0,
  ioBytesPerSecond: 0,
  diskBytes: 0,
  diskInodes: 0,
  diskIops: 0,
  egressBytesPerSecond: 0,
  egressRequestsPerMinute: 0,
  eventBytesPerSecond: 0,
  artifactBytes: 0,
  outputBytes: 0,
  corpusIndexBytes: 0,
}

export function fitsCapacity(
  available: CapacityVector,
  requested: CapacityVector,
) {
  return (Object.keys(ZERO_CAPACITY) as (keyof CapacityVector)[]).every(
    (key) =>
      key === 'schemaVersion' ||
      Number(available[key]) >= Number(requested[key]),
  )
}

export function subtractCapacity(
  available: CapacityVector,
  requested: CapacityVector,
): CapacityVector {
  if (!fitsCapacity(available, requested)) throw new Error('CAPACITY_EXHAUSTED')
  const result = { ...available }
  for (const key of Object.keys(ZERO_CAPACITY) as (keyof CapacityVector)[]) {
    if (key !== 'schemaVersion') {
      ;(result[key] as number) = Number(available[key]) - Number(requested[key])
    }
  }
  return result
}

export interface FairQueueCandidate extends SchedulerQueueItem {
  tenantRunning: number
  workspaceRunning: number
  providerRunning: number
  providerRequestsLastMinute: number
}

export function selectWeightedFairCandidate(
  candidates: FairQueueCandidate[],
  policies: ReadonlyMap<string, TenantSchedulingPolicy>,
  now: Date,
): FairQueueCandidate | undefined {
  return candidates
    .filter((item) => {
      const policy = policies.get(item.tenantId)
      if (!policy || new Date(item.notBefore).getTime() > now.getTime())
        return false
      return (
        item.tenantRunning < policy.tenantConcurrency &&
        item.workspaceRunning < policy.workspaceConcurrency &&
        item.providerRunning <
          (policy.providerConcurrency[item.providerId] ?? 0) &&
        item.providerRequestsLastMinute <
          (policy.providerRequestsPerMinute[item.providerId] ?? 0)
      )
    })
    .sort((left, right) => {
      const lp = policies.get(left.tenantId)!
      const rp = policies.get(right.tenantId)!
      const lAge = Math.max(
        0,
        now.getTime() - new Date(left.enqueuedAt).getTime(),
      )
      const rAge = Math.max(
        0,
        now.getTime() - new Date(right.enqueuedAt).getTime(),
      )
      const lStarved = lAge >= lp.starvationAgeMs ? 1 : 0
      const rStarved = rAge >= rp.starvationAgeMs ? 1 : 0
      if (lStarved !== rStarved) return rStarved - lStarved
      const lScore = left.virtualFinish / lp.weight
      const rScore = right.virtualFinish / rp.weight
      return (
        lScore - rScore ||
        right.priority - left.priority ||
        left.enqueuedAt.localeCompare(right.enqueuedAt) ||
        left.queueItemId.localeCompare(right.queueItemId)
      )
    })[0]
}

export function boundedBackoffMs(
  attempt: number,
  policy: TenantSchedulingPolicy['retry'],
) {
  const exponent = Math.max(0, attempt - 1)
  return Math.min(policy.maxBackoffMs, policy.initialBackoffMs * 2 ** exponent)
}

export function assertCurrentFence(expectedToken: number, actualToken: number) {
  if (expectedToken !== actualToken) {
    const error = new Error('STALE_FENCING_TOKEN')
    error.name = 'FencingError'
    throw error
  }
}

export interface ProductionDependencyInput {
  instanceId: string
  role: DependencyReadiness['role']
  mode: DependencyReadiness['mode']
  checkedAt?: Date
  dependencies: DependencyReadiness['dependencies']
}

export function evaluateDependencyReadiness(
  input: ProductionDependencyInput,
): DependencyReadiness {
  const requiredNames = [
    'postgresql',
    'event-broker',
    'object-storage',
    'runtime-control',
    'kms',
  ] as const
  const dependencies = requiredNames.map((name) => {
    const supplied = input.dependencies.find((value) => value.name === name)
    return (
      supplied ?? {
        name,
        required: input.mode === 'production',
        ready: false,
        code: 'DEPENDENCY_NOT_CONFIGURED',
      }
    )
  })
  return {
    schemaVersion: 1,
    instanceId: input.instanceId,
    role: input.role,
    mode: input.mode,
    ready: !dependencies.some((value) => value.required && !value.ready),
    checkedAt: (input.checkedAt ?? new Date()).toISOString(),
    dependencies,
  }
}

export interface ProductionStorageConfig {
  eventStore: 'postgresql' | 'sqlite'
  queue: 'postgresql' | 'memory'
  locks: 'postgresql' | 'memory' | 'cache'
  artifacts: 'object-storage' | 'filesystem'
  attachments: 'object-storage' | 'filesystem'
  sources: 'object-storage' | 'filesystem'
}

export function assertProductionStorage(config: ProductionStorageConfig) {
  const invalid = Object.entries(config).filter(
    ([key, value]) =>
      (key === 'eventStore' && value !== 'postgresql') ||
      (key === 'queue' && value !== 'postgresql') ||
      (key === 'locks' && value !== 'postgresql') ||
      (['artifacts', 'attachments', 'sources'].includes(key) &&
        value !== 'object-storage'),
  )
  if (invalid.length > 0)
    throw new Error(
      `PRODUCTION_FALLBACK_FORBIDDEN:${invalid.map(([key]) => key).join(',')}`,
    )
}

export function cgroupV2Controls(capacity: CapacityVector) {
  return {
    'cpu.max': `${capacity.cpuMillis * 100} 100000`,
    'memory.max': String(capacity.memoryBytes),
    'memory.swap.max': '0',
    'pids.max': String(capacity.pids),
    'io.max': `rbps=${capacity.ioBytesPerSecond} wbps=${capacity.ioBytesPerSecond} riops=${capacity.diskIops} wiops=${capacity.diskIops}`,
  } as const
}

export interface SchedulerClaim {
  item: SchedulerQueueItem
  lease: import('./contracts').WorkspaceLease
  capacityReservationId: string
}

export interface SchedulerRepositoryPort {
  claim(input: {
    ownerId: string
    leaseId: string
    leaseMs: number
    capacityReservationId: string
    requestedCapacity: CapacityVector
    now?: Date
  }): Promise<SchedulerClaim | null>
  assertFence(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    runId: string
    fencingToken: number
  }): Promise<void>
  releaseLease(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    leaseId: string
    ownerId: string
    fencingToken: number
    terminalState: 'completed' | 'failed' | 'poisoned' | 'recovery_required'
    errorCode?: string | null
  }): Promise<boolean>
}

export interface WorkspaceRuntimeStartInput {
  tenantId: string
  organizationId: string
  workspaceId: string
  sessionId: string
  runId: string
  queueItemId: string
  leaseId: string
  fencingToken: number
  capacityReservationId: string
}

export type WorkspaceRuntimeExecutor = (
  input: WorkspaceRuntimeStartInput,
  fence: () => Promise<void>,
) => Promise<'completed' | 'failed' | 'recovery_required'>

export class DurableWorkspaceScheduler {
  readonly repository: SchedulerRepositoryPort
  readonly ownerId: string
  readonly leaseMs: number
  readonly requestedCapacity: CapacityVector
  readonly execute: WorkspaceRuntimeExecutor
  readonly idFactory: () => string

  constructor(input: {
    repository: SchedulerRepositoryPort
    ownerId: string
    leaseMs: number
    requestedCapacity: CapacityVector
    execute: WorkspaceRuntimeExecutor
    idFactory: () => string
  }) {
    this.repository = input.repository
    this.ownerId = input.ownerId
    this.leaseMs = input.leaseMs
    this.requestedCapacity = input.requestedCapacity
    this.execute = input.execute
    this.idFactory = input.idFactory
  }

  async runOnce(now = new Date()) {
    const claimed = await this.repository.claim({
      ownerId: this.ownerId,
      leaseId: this.idFactory(),
      leaseMs: this.leaseMs,
      capacityReservationId: this.idFactory(),
      requestedCapacity: this.requestedCapacity,
      now,
    })
    if (!claimed) return null
    const scope = {
      tenantId: claimed.item.tenantId,
      organizationId: claimed.item.organizationId,
      workspaceId: claimed.item.workspaceId,
    }
    const fence = () =>
      this.repository.assertFence({
        ...scope,
        runId: claimed.item.runId,
        fencingToken: claimed.lease.fencingToken,
      })
    try {
      await fence()
      const outcome = await this.execute(
        {
          ...scope,
          sessionId: claimed.item.sessionId,
          runId: claimed.item.runId,
          queueItemId: claimed.item.queueItemId,
          leaseId: claimed.lease.leaseId,
          fencingToken: claimed.lease.fencingToken,
          capacityReservationId: claimed.capacityReservationId,
        },
        fence,
      )
      await fence()
      await this.repository.releaseLease({
        ...scope,
        leaseId: claimed.lease.leaseId,
        ownerId: this.ownerId,
        fencingToken: claimed.lease.fencingToken,
        terminalState: outcome,
      })
      return { claimed, outcome }
    } catch (error) {
      await this.repository.releaseLease({
        ...scope,
        leaseId: claimed.lease.leaseId,
        ownerId: this.ownerId,
        fencingToken: claimed.lease.fencingToken,
        terminalState:
          error instanceof Error && error.message === 'STALE_FENCING_TOKEN'
            ? 'recovery_required'
            : 'failed',
        errorCode:
          error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)
            ? error.message
            : 'RUNTIME_START_FAILED',
      })
      throw error
    }
  }
}

export class FencedRuntimeWriter {
  readonly repository: SchedulerRepositoryPort
  readonly identity: {
    tenantId: string
    organizationId: string
    workspaceId: string
    runId: string
    fencingToken: number
  }

  constructor(
    repository: SchedulerRepositoryPort,
    identity: FencedRuntimeWriter['identity'],
  ) {
    this.repository = repository
    this.identity = identity
  }

  async write<T>(operation: () => Promise<T>): Promise<T> {
    await this.repository.assertFence(this.identity)
    const result = await operation()
    await this.repository.assertFence(this.identity)
    return result
  }
}
