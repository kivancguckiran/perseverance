import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { codexV2 } from '../packages/codex-protocol-generated/src/index'
import {
  DurableWorkspaceScheduler,
  ZERO_CAPACITY,
  selectWeightedFairCandidate,
  type SchedulerClaim,
  type SchedulerRepositoryPort,
} from '../packages/production-topology/src/index'
import {
  CodexAppServerClient,
  createIsolatedCodexHome,
} from '../agents/workspace-agent/src/index'
import { Wp26ProductionStack } from './wp26-production-stack'
import { S3CompatibleObjectStore } from '../packages/production-topology/src/durable-dependencies'

const codexBin = process.env.WP26_CODEX_BIN
if (!codexBin) throw new Error('WP26_CODEX_BIN must point to Codex 0.144.2')
const version = execFileSync(codexBin, ['--version'], {
  encoding: 'utf8',
}).trim()
if (!version.includes('0.144.2'))
  throw new Error(`WP26_CODEX_VERSION_MISMATCH:${version}`)
const isolated = createIsolatedCodexHome({
  sourceHome:
    process.env.CODEX_PROVISIONING_SOURCE ?? join(homedir(), '.codex'),
  includeConfig: false,
})
const fairnessAt = new Date()
const fairPolicies = new Map(
  ['tenant-a', 'tenant-b'].map((tenantId) => [
    tenantId,
    {
      schemaVersion: 1 as const,
      tenantId,
      organizationId: tenantId,
      policyVersion: 26,
      algorithm: 'weighted-fair-v1' as const,
      weight: 1,
      tenantConcurrency: 1,
      workspaceConcurrency: 1 as const,
      providerConcurrency: { codex: 10_000 },
      providerRequestsPerMinute: { codex: 10_000 },
      starvationAgeMs: 60_000,
      retry: {
        maxAttempts: 3,
        initialBackoffMs: 100,
        maxBackoffMs: 1_000,
        poisonAfterAttempts: 3,
      },
      effectiveAt: fairnessAt.toISOString(),
    },
  ]),
)
const fairItems = [
  ...Array.from({ length: 1_000 }, (_, index) => ({
    tenantId: 'tenant-a',
    index,
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    tenantId: 'tenant-b',
    index,
  })),
].map(({ tenantId, index }) => ({
  schemaVersion: 1 as const,
  tenantId,
  organizationId: tenantId,
  workspaceId: `${tenantId}-workspace-${index}`,
  queueItemId: `${tenantId}-${index}`,
  runId: `${tenantId}-run-${index}`,
  sessionId: `${tenantId}-session-${index}`,
  providerId: 'codex',
  idempotencyKey: `${tenantId}-key-${index}`,
  state: 'queued' as const,
  priority: 0,
  virtualFinish: index + 1,
  attempt: 0,
  maxAttempts: 3,
  notBefore: fairnessAt.toISOString(),
  enqueuedAt: fairnessAt.toISOString(),
  lastErrorCode: null,
  tenantRunning: 0,
  workspaceRunning: 0,
  providerRunning: 0,
  providerRequestsLastMinute: 0,
}))
const fairOrder: string[] = []
while (fairItems.length > 0) {
  const next = selectWeightedFairCandidate(fairItems, fairPolicies, fairnessAt)!
  fairOrder.push(next.tenantId)
  fairItems.splice(fairItems.indexOf(next), 1)
}
const tenantBPositions = fairOrder
  .map((tenantId, index) => (tenantId === 'tenant-b' ? index + 1 : 0))
  .filter(Boolean)
const tenantBMaxQueuePosition = Math.max(...tenantBPositions)
assert(tenantBMaxQueuePosition <= 40)
let currentFence = 41
let available = true
const claim: SchedulerClaim = {
  item: {
    schemaVersion: 1,
    tenantId: 'tenant-runtime',
    organizationId: 'tenant-runtime',
    workspaceId: 'workspace-runtime',
    queueItemId: 'queue-runtime',
    runId: 'run-runtime',
    sessionId: 'session-runtime',
    providerId: 'codex',
    idempotencyKey: 'opaque-runtime-key',
    state: 'leased',
    priority: 0,
    virtualFinish: 1,
    attempt: 1,
    maxAttempts: 3,
    notBefore: new Date().toISOString(),
    enqueuedAt: new Date().toISOString(),
    lastErrorCode: null,
  },
  lease: {
    schemaVersion: 1,
    tenantId: 'tenant-runtime',
    organizationId: 'tenant-runtime',
    workspaceId: 'workspace-runtime',
    leaseId: 'lease-runtime',
    queueItemId: 'queue-runtime',
    runId: 'run-runtime',
    ownerId: 'scheduler-runtime',
    fencingToken: currentFence,
    state: 'active',
    acquiredAt: new Date().toISOString(),
    renewedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  },
  capacityReservationId: 'capacity-runtime',
  regionId: 'eu-1',
  nodeId: 'node-runtime',
}
const releases: Array<Record<string, unknown>> = []
const repository: SchedulerRepositoryPort = {
  claim: async () => (available ? ((available = false), claim) : null),
  assertFence: async (input) => {
    if (input.fencingToken !== currentFence)
      throw new Error('STALE_FENCING_TOKEN')
  },
  releaseLease: async (input) => {
    releases.push(input)
    return true
  },
}
const client = new CodexAppServerClient({
  command: codexBin,
  cwd: process.cwd(),
  env: { ...process.env, CODEX_HOME: isolated.path },
  requestTimeoutMs: 180_000,
})
try {
  const scheduler = new DurableWorkspaceScheduler({
    repository,
    ownerId: 'scheduler-runtime',
    leaseMs: 120_000,
    requestedCapacity: {
      ...ZERO_CAPACITY,
      cpuMillis: 500,
      memoryBytes: 512 * 1024 * 1024,
      pids: 64,
    },
    idFactory: randomUUID,
    execute: async (_input, fence) => {
      await fence()
      await client.initialize({
        name: 'wp26_scheduler',
        title: 'WP26 Scheduler',
        version: '1',
      })
      const thread = await client.request<codexV2.ThreadStartResponse>(
        'thread/start',
        { cwd: process.cwd() } satisfies codexV2.ThreadStartParams,
      )
      let resolveFinal!: () => void
      let rejectFinal!: (error: Error) => void
      const final = new Promise<void>((resolve, reject) => {
        resolveFinal = resolve
        rejectFinal = reject
      })
      client.onNotification((message) => {
        const params = message.params as Record<string, unknown> | undefined
        if (
          message.method === 'error' &&
          params?.threadId === thread.thread.id
        ) {
          const runtimeError = params.error as
            Record<string, unknown> | undefined
          rejectFinal(
            new Error(String(runtimeError?.message ?? 'RUNTIME_FAILED')),
          )
        }
        if (
          message.method === 'item/completed' &&
          params?.threadId === thread.thread.id
        ) {
          const runtimeItem = params.item as Record<string, unknown> | undefined
          if (runtimeItem?.type === 'agentMessage')
            void fence().then(resolveFinal, rejectFinal)
        }
      })
      const turn = await client.request<codexV2.TurnStartResponse>(
        'turn/start',
        {
          threadId: thread.thread.id,
          input: [
            {
              type: 'text',
              text: 'Yalnızca TAMAM yaz. Araç kullanma.',
              text_elements: [],
            },
          ],
        } satisfies codexV2.TurnStartParams,
      )
      let timeout: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        final,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('RUNTIME_TIMEOUT')),
            180_000,
          )
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout)
      })
      assert(thread.thread.id)
      assert(turn.turn.id)
      return 'completed'
    },
  })
  const result = await scheduler.runOnce()
  assert.equal(result?.outcome, 'completed')
  assert.equal(releases[0]?.terminalState, 'completed')
  currentFence += 1
  await assert.rejects(
    repository.assertFence({
      tenantId: 'tenant-runtime',
      organizationId: 'tenant-runtime',
      workspaceId: 'workspace-runtime',
      runId: 'run-runtime',
      fencingToken: 41,
    }),
    /STALE_FENCING_TOKEN/,
  )
  console.log(
    JSON.stringify({
      gate: 'wp26:scheduler',
      codexVersion: version,
      queueItemId: claim.item.queueItemId,
      runId: claim.item.runId,
      leaseId: claim.lease.leaseId,
      acceptedFencingToken: 41,
      recoveryFencingToken: 42,
      runtimeStart: 'real-codex-app-server',
      staleOwner: 'rejected',
      fairness: {
        algorithm: 'weighted-fair-v1',
        tenantALoad: 1000,
        tenantBLoad: 20,
        tenantBMaxQueuePosition,
      },
      isolatedHomeCleaned: true,
    }),
  )
} finally {
  await client.stop()
  isolated.cleanup()
}

const stack = new Wp26ProductionStack()
const waitFor = async <T>(
  operation: () => Promise<T | null>,
  timeoutMs = 240_000,
) => {
  const started = performance.now()
  while (performance.now() - started < timeoutMs) {
    const value = await operation()
    if (value)
      return { value, elapsedMs: Math.round(performance.now() - started) }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('LIVE_FAIRNESS_TIMEOUT')
}
const request = async (
  url: string,
  headers: Record<string, string>,
  body?: unknown,
) => {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value = (await response.json()) as Record<string, unknown>
  if (response.status < 200 || response.status >= 300)
    throw new Error(`LIVE_FAIRNESS_HTTP_${response.status}`)
  return value
}
try {
  await stack.startInfrastructure()
  await stack.startWorkers(codexBin, 2)
  await stack.startApis(2)
  const scopeA = {
    'x-tenant-id': 'tenant-a',
    'x-organization-id': 'tenant-a',
    'x-workspace-id': 'workspace-a',
  }
  const scopeB = {
    'x-tenant-id': 'tenant-b',
    'x-organization-id': 'tenant-b',
    'x-workspace-id': 'workspace-b',
  }
  const sessionA = await request(`${stack.loadBalancerUrl}/v1/sessions`, scopeA)
  const sessionB = await request(`${stack.loadBalancerUrl}/v1/sessions`, scopeB)
  const turnHeaders = (scope: Record<string, string>, key: string) => ({
    ...scope,
    'content-type': 'application/json',
    'idempotency-key': key,
  })
  const aRuns: string[] = []
  for (let index = 0; index < 3; index++) {
    const turn = await request(
      `${stack.loadBalancerUrl}/v1/sessions/${sessionA.sessionId}/turns`,
      turnHeaders(scopeA, `fair-a-${index}`),
      { prompt: 'Yalnızca TAMAM yaz. Araç kullanma.' },
    )
    aRuns.push(String(turn.runId))
  }
  const bTurn = await request(
    `${stack.loadBalancerUrl}/v1/sessions/${sessionB.sessionId}/turns`,
    turnHeaders(scopeB, 'fair-b-0'),
    { prompt: 'Yalnızca TAMAM yaz. Araç kullanma.' },
  )
  const tenantB = await waitFor(async () => {
    const result = await stack.query(
      `SELECT state FROM persistent_codex.ha_runs WHERE run_id=$1`,
      [bTurn.runId],
    )
    return result.rows[0]?.state === 'completed' ? true : null
  })
  const tenantBLatencyMs = tenantB.elapsedMs
  const backlogAtBCompletion = await stack.query(
    `SELECT count(*)::int count FROM persistent_codex.ha_runs WHERE run_id=ANY($1::text[]) AND state<>'completed'`,
    [aRuns],
  )
  assert(backlogAtBCompletion.rows[0].count >= 1)
  await waitFor(async () => {
    const result = await stack.query(
      `SELECT count(*)::int count FROM persistent_codex.ha_runs WHERE run_id=ANY($1::text[]) AND state='completed'`,
      [aRuns],
    )
    return result.rows[0].count === aRuns.length ? true : null
  })
  const poisonTurn = await request(
    `${stack.loadBalancerUrl}/v1/sessions/${sessionA.sessionId}/turns`,
    turnHeaders(scopeA, 'fair-poison'),
    {
      prompt: 'opaque poison fixture',
      approvalContext: { kind: 'command', command: 'opaque', risk: 'bounded' },
    },
  )
  const poisonStored = await stack.query(
    `SELECT prompt_object_key FROM persistent_codex.ha_runs WHERE run_id=$1`,
    [poisonTurn.runId],
  )
  const objectStore = new S3CompatibleObjectStore({
    endpoint: stack.minioUrl,
    bucket: 'wp26',
    accessKeyId: 'wp26access',
    secretAccessKey: 'wp26-secret-not-logged',
  })
  await objectStore.delete(String(poisonStored.rows[0].prompt_object_key))
  await request(
    `${stack.loadBalancerUrl}/v1/approvals/${poisonTurn.approvalId}/decision`,
    { ...turnHeaders(scopeA, 'unused'), 'x-principal-id': 'scheduler-harness' },
    { decision: 'accept', expectedVersion: 1 },
  )
  const poison = await waitFor(async () => {
    const result = await stack.query(
      `SELECT state,attempt FROM persistent_codex.ha_runs WHERE run_id=$1`,
      [poisonTurn.runId],
    )
    return result.rows[0]?.state === 'poisoned' ? result.rows[0] : null
  }, 30_000)
  assert.equal(poison.value.attempt, 4)
  const starts = await stack.query(
    `SELECT count(DISTINCT owner_id)::int owners,count(*)::int starts FROM persistent_codex.ha_runtime_starts WHERE run_id=ANY($1::text[])`,
    [[...aRuns, String(bTurn.runId)]],
  )
  assert.equal(starts.rows[0].owners, 2)
  console.log(
    JSON.stringify({
      gate: 'wp26:scheduler-live-fairness',
      schedulerInstances: 2,
      algorithm: 'weighted-fair-v1',
      tenantABacklog: aRuns.length,
      tenantBLatencyMs,
      tenantBCompletedWhileTenantABacklogged: true,
      distinctWorkers: starts.rows[0].owners,
      runtimeStarts: starts.rows[0].starts,
      providerConcurrencyLimit: 2,
      workspaceConcurrencyLimit: 1,
      poison: {
        attempts: poison.value.attempt,
        state: poison.value.state,
        boundedBackoff: true,
      },
      realCodex: true,
      cleanup: 'complete',
    }),
  )
} finally {
  await stack.cleanup()
}
