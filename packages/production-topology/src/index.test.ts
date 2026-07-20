import { describe, expect, it, vi } from 'vitest'
import {
  DurableWorkspaceScheduler,
  FencedRuntimeWriter,
  ZERO_CAPACITY,
  assertCurrentFence,
  assertProductionStorage,
  boundedBackoffMs,
  cgroupV2Controls,
  evaluateDependencyReadiness,
  fitsCapacity,
  selectWeightedFairCandidate,
  subtractCapacity,
  type FairQueueCandidate,
  type SchedulerRepositoryPort,
} from './index'
import {
  capacityLimitOutcomeSchema,
  capacityReservationSchema,
  dependencyReadinessSchema,
  drainStateSchema,
  placementSchema,
  recoveryOutcomeSchema,
  schedulerQueueItemSchema,
  tenantSchedulingPolicySchema,
  workspaceLeaseSchema,
  type CapacityVector,
  type TenantSchedulingPolicy,
} from './contracts'

const at = '2026-07-19T10:00:00.000Z'
const capacity: CapacityVector = {
  ...ZERO_CAPACITY,
  cpuMillis: 1_000,
  memoryBytes: 1_073_741_824,
  pids: 64,
  ioBytesPerSecond: 10_000_000,
  diskBytes: 5_000_000_000,
  diskInodes: 50_000,
  diskIops: 1_000,
  egressBytesPerSecond: 1_000_000,
  egressRequestsPerMinute: 600,
  eventBytesPerSecond: 500_000,
  artifactBytes: 1_000_000_000,
  outputBytes: 100_000_000,
  corpusIndexBytes: 2_000_000_000,
}
const policy = (tenantId: string, weight = 1): TenantSchedulingPolicy => ({
  schemaVersion: 1,
  tenantId,
  organizationId: tenantId,
  policyVersion: 26,
  algorithm: 'weighted-fair-v1',
  weight,
  tenantConcurrency: 2,
  workspaceConcurrency: 1,
  providerConcurrency: { codex: 4 },
  providerRequestsPerMinute: { codex: 60 },
  starvationAgeMs: 10_000,
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
  enqueuedAt = at,
): FairQueueCandidate => ({
  schemaVersion: 1,
  tenantId,
  organizationId: tenantId,
  workspaceId: `workspace-${queueItemId}`,
  queueItemId,
  runId: `run-${queueItemId}`,
  sessionId: `session-${queueItemId}`,
  providerId: 'codex',
  idempotencyKey: `key-${queueItemId}`,
  state: 'queued',
  priority: 0,
  virtualFinish,
  attempt: 0,
  maxAttempts: 4,
  notBefore: at,
  enqueuedAt,
  lastErrorCode: null,
  tenantRunning: 0,
  workspaceRunning: 0,
  providerRunning: 0,
  providerRequestsLastMinute: 0,
})

describe('WP26 versioned contracts', () => {
  it('parses every placement, lease, drain, recovery and capacity boundary as v1', () => {
    const scope = {
      tenantId: 'tenant-a',
      organizationId: 'tenant-a',
      workspaceId: 'workspace-a',
    }
    expect(
      placementSchema.parse({
        schemaVersion: 1,
        ...scope,
        placementId: 'placement-a',
        regionId: 'eu-1',
        nodeId: 'node-1',
        runtimeId: 'runtime-1',
        generation: 1,
        state: 'ready',
        affinity: { requiredRegionId: 'eu-1', preferredNodeIds: [] },
        capacity,
        fencingToken: 1,
        updatedAt: at,
      }).state,
    ).toBe('ready')
    expect(
      workspaceLeaseSchema.parse({
        schemaVersion: 1,
        ...scope,
        leaseId: 'lease-1',
        queueItemId: 'queue-1',
        runId: 'run-1',
        ownerId: 'scheduler-1',
        fencingToken: 1,
        state: 'active',
        acquiredAt: at,
        renewedAt: at,
        expiresAt: '2026-07-19T10:01:00.000Z',
      }).fencingToken,
    ).toBe(1)
    expect(
      drainStateSchema.parse({
        schemaVersion: 1,
        drainId: 'drain-1',
        targetKind: 'node',
        regionId: 'eu-1',
        nodeId: 'node-1',
        state: 'draining',
        reasonCode: 'MAINTENANCE',
        requestedAt: at,
        deadlineAt: null,
        completedAt: null,
      }).state,
    ).toBe('draining')
    expect(
      recoveryOutcomeSchema.parse({
        schemaVersion: 1,
        ...scope,
        recoveryId: 'recovery-1',
        runId: 'run-1',
        previousPlacementId: 'placement-1',
        nextPlacementId: 'placement-2',
        previousFencingToken: 1,
        nextFencingToken: 2,
        checkpointId: 'checkpoint-1',
        outcome: 'resumed',
        reasonCode: 'LEASE_EXPIRED',
        rpoMs: 0,
        rtoMs: 1250,
        occurredAt: at,
      }).nextFencingToken,
    ).toBe(2)
    expect(
      capacityReservationSchema.parse({
        schemaVersion: 1,
        ...scope,
        reservationId: 'capacity-1',
        queueItemId: 'queue-1',
        regionId: 'eu-1',
        nodeId: 'node-1',
        runtimeId: null,
        state: 'held',
        capacity,
        fencingToken: 1,
        expiresAt: at,
        updatedAt: at,
      }).capacity.pids,
    ).toBe(64)
    expect(
      capacityLimitOutcomeSchema.parse({
        schemaVersion: 1,
        ...scope,
        outcomeId: 'limit-1',
        runId: 'run-1',
        resource: 'memory',
        action: 'terminated',
        limit: capacity.memoryBytes,
        observed: capacity.memoryBytes + 1,
        reasonCode: 'CGROUP_OOM',
        occurredAt: at,
      }).resource,
    ).toBe('memory')
  })
})

describe('weighted-fair-v1', () => {
  it('is deterministic, honors weights/concurrency and prevents starvation', () => {
    const policies = new Map([
      ['tenant-a', policy('tenant-a', 1)],
      ['tenant-b', policy('tenant-b', 4)],
    ])
    expect(
      selectWeightedFairCandidate(
        [item('tenant-a', 'a', 4), item('tenant-b', 'b', 4)],
        policies,
        new Date(at),
      )?.queueItemId,
    ).toBe('b')
    const blocked = item('tenant-b', 'blocked', 0)
    blocked.tenantRunning = 2
    expect(
      selectWeightedFairCandidate(
        [blocked, item('tenant-a', 'eligible', 9)],
        policies,
        new Date(at),
      )?.queueItemId,
    ).toBe('eligible')
    expect(
      selectWeightedFairCandidate(
        [
          item('tenant-b', 'fresh', 0),
          item('tenant-a', 'starved', 100, '2026-07-19T09:59:40.000Z'),
        ],
        policies,
        new Date(at),
      )?.queueItemId,
    ).toBe('starved')
  })

  it('bounds retry and marks schema poison behavior explicitly', () => {
    const retry = policy('tenant-a').retry
    expect(
      [1, 2, 3, 4].map((attempt) => boundedBackoffMs(attempt, retry)),
    ).toEqual([100, 200, 400, 800])
    expect(
      schedulerQueueItemSchema.parse({
        ...item('tenant-a', 'poison', 0),
        state: 'poisoned',
        attempt: 4,
        lastErrorCode: 'RUNTIME_CRASH_LOOP',
      }).state,
    ).toBe('poisoned')
    expect(
      tenantSchedulingPolicySchema.parse(policy('tenant-a')).algorithm,
    ).toBe('weighted-fair-v1')
  })
})

describe('capacity and production fail-closed', () => {
  it('reserves vectors without overcommit and emits cgroup v2 controls', () => {
    expect(fitsCapacity(capacity, { ...capacity, cpuMillis: 999 })).toBe(true)
    expect(fitsCapacity(capacity, { ...capacity, pids: 65 })).toBe(false)
    expect(subtractCapacity(capacity, { ...ZERO_CAPACITY, pids: 4 }).pids).toBe(
      60,
    )
    expect(() => subtractCapacity(capacity, { ...capacity, pids: 65 })).toThrow(
      'CAPACITY_EXHAUSTED',
    )
    expect(cgroupV2Controls(capacity)).toMatchObject({
      'cpu.max': '100000 100000',
      'memory.max': String(capacity.memoryBytes),
      'memory.swap.max': '0',
      'pids.max': '64',
    })
  })

  it('rejects every local or in-memory production fallback', () => {
    expect(() =>
      assertProductionStorage({
        eventStore: 'sqlite',
        queue: 'memory',
        locks: 'cache',
        artifacts: 'filesystem',
        attachments: 'filesystem',
        sources: 'filesystem',
      }),
    ).toThrow('PRODUCTION_FALLBACK_FORBIDDEN')
    expect(() =>
      assertProductionStorage({
        eventStore: 'postgresql',
        queue: 'postgresql',
        locks: 'postgresql',
        artifacts: 'object-storage',
        attachments: 'object-storage',
        sources: 'object-storage',
      }),
    ).not.toThrow()
  })

  it('requires every production dependency and treats cache as non-authoritative', () => {
    const readiness = evaluateDependencyReadiness({
      instanceId: 'api-1',
      role: 'api',
      mode: 'production',
      checkedAt: new Date(at),
      dependencies: [
        { name: 'postgresql', required: true, ready: true, code: null },
        {
          name: 'event-broker',
          required: true,
          ready: false,
          code: 'BROKER_DOWN',
        },
      ],
    })
    expect(readiness.ready).toBe(false)
    expect(
      dependencyReadinessSchema.parse(readiness).dependencies,
    ).toHaveLength(5)
  })
})

describe('fenced real-runtime scheduler seam', () => {
  it('starts one claimed runtime and fences before and after execution', async () => {
    const claimedItem = item('tenant-a', 'queue-1', 0)
    const activeLease = workspaceLeaseSchema.parse({
      schemaVersion: 1,
      tenantId: 'tenant-a',
      organizationId: 'tenant-a',
      workspaceId: claimedItem.workspaceId,
      leaseId: 'lease-1',
      queueItemId: 'queue-1',
      runId: claimedItem.runId,
      ownerId: 'scheduler-1',
      fencingToken: 7,
      state: 'active',
      acquiredAt: at,
      renewedAt: at,
      expiresAt: '2026-07-19T10:01:00.000Z',
    })
    const repository: SchedulerRepositoryPort = {
      claim: vi.fn(async () => ({
        item: claimedItem,
        lease: activeLease,
        capacityReservationId: 'capacity-1',
        regionId: 'eu-1',
        nodeId: 'node-1',
      })),
      assertFence: vi.fn(async () => undefined),
      releaseLease: vi.fn(async () => true),
    }
    const execute = vi.fn(async (_input, fence: () => Promise<void>) => {
      await fence()
      return 'completed' as const
    })
    const scheduler = new DurableWorkspaceScheduler({
      repository,
      ownerId: 'scheduler-1',
      leaseMs: 60_000,
      requestedCapacity: capacity,
      execute,
      idFactory: (() => {
        let n = 0
        return () => `opaque-${++n}`
      })(),
    })
    expect((await scheduler.runOnce(new Date(at)))?.outcome).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(repository.assertFence).toHaveBeenCalledTimes(3)
    expect(repository.releaseLease).toHaveBeenCalledWith(
      expect.objectContaining({ fencingToken: 7, terminalState: 'completed' }),
    )
  })

  it('rejects stale owners without leaking task content', async () => {
    expect(() => assertCurrentFence(8, 9)).toThrow('STALE_FENCING_TOKEN')
    expect(() => assertCurrentFence(9, 9)).not.toThrow()
  })

  it('does not execute turn/event/artifact writes for a stale owner', async () => {
    const mutation = vi.fn(async () => 'written')
    const repository: SchedulerRepositoryPort = {
      claim: vi.fn(async () => null),
      assertFence: vi.fn(async () => {
        throw new Error('STALE_FENCING_TOKEN')
      }),
      releaseLease: vi.fn(async () => false),
    }
    const writer = new FencedRuntimeWriter(repository, {
      tenantId: 'tenant-a',
      organizationId: 'tenant-a',
      workspaceId: 'workspace-a',
      runId: 'run-a',
      fencingToken: 1,
    })
    await expect(writer.write(mutation)).rejects.toThrow('STALE_FENCING_TOKEN')
    expect(mutation).not.toHaveBeenCalled()
  })
})
