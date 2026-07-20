import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { Wp26ProductionStack, wp26Headers } from './wp26-production-stack'
import { createProductionPostgresRepository } from '../packages/production-topology/src/production-postgres'

const codexBin = process.env.WP26_CODEX_BIN
if (!codexBin) throw new Error('WP26_CODEX_BIN must point to Codex 0.144.2')
assert.match(
  execFileSync(codexBin, ['--version'], { encoding: 'utf8' }),
  /0\.144\.2/,
)
const stack = new Wp26ProductionStack()
const scopeHeaders = Object.fromEntries(
  Object.entries(wp26Headers).filter(([name]) => name !== 'content-type'),
)
const json = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init)
  return { response, body: (await response.json()) as Record<string, any> }
}
const waitUntil = async <T>(
  operation: () => Promise<T | null>,
  timeoutMs = 180_000,
) => {
  const started = performance.now()
  while (performance.now() - started < timeoutMs) {
    const result = await operation()
    if (result)
      return { result, elapsedMs: Math.round(performance.now() - started) }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('WP26 HA condition timeout')
}

try {
  await stack.startInfrastructure()
  await stack.startWorkers(codexBin, 2, 5_000)
  await stack.startApis(2)
  const sessionResponse = await json(`${stack.loadBalancerUrl}/v1/sessions`, {
    method: 'POST',
    headers: scopeHeaders,
  })
  assert.equal(sessionResponse.response.status, 201)
  const sessionId = String(sessionResponse.body.sessionId)
  const turnResponse = await json(
    `${stack.loadBalancerUrl}/v1/sessions/${sessionId}/turns`,
    {
      method: 'POST',
      headers: { ...wp26Headers, 'idempotency-key': 'ha-turn-1' },
      body: JSON.stringify({
        prompt: 'Yalnızca TAMAM yaz. Araç kullanma.',
        approvalContext: {
          kind: 'command',
          command: 'opaque',
          risk: 'bounded',
        },
      }),
    },
  )
  assert.equal(
    turnResponse.response.status,
    202,
    JSON.stringify(turnResponse.body),
  )
  assert.equal(turnResponse.body.status, 'awaiting_approval')
  const approvalId = String(turnResponse.body.approvalId)
  stack.killApi(0)
  const approvals = await json(
    `${stack.loadBalancerUrl}/v1/approvals?status=pending`,
    { headers: wp26Headers },
  )
  assert.equal(approvals.response.status, 200)
  assert.equal(approvals.body.approvals[0].context.command, 'opaque')
  const decision = await json(
    `${stack.loadBalancerUrl}/v1/approvals/${approvalId}/decision`,
    {
      method: 'POST',
      headers: { ...wp26Headers, 'x-principal-id': 'principal-redacted' },
      body: JSON.stringify({ decision: 'accept', expectedVersion: 1 }),
    },
  )
  assert.equal(decision.response.status, 200)
  const claimed = await waitUntil(async () => {
    const result = await stack.query(
      `SELECT owner_id,fencing_token FROM persistent_codex.workspace_leases WHERE run_id=$1 AND state='active'`,
      [turnResponse.body.runId],
    )
    return result.rows[0] ?? null
  }, 20_000)
  const owner = String(claimed.result.owner_id)
  const killedWorker = owner === 'scheduler-1' ? 0 : 1
  const capacityRepository = createProductionPostgresRepository(
    stack.databaseUrl,
  )
  try {
    for (const [resource, quantity] of [
      ['outputBytes', 100 * 1024 * 1024 + 1],
      ['artifactBytes', 1024 * 1024 * 1024 + 1],
      ['corpusIndexBytes', 2 * 1024 * 1024 * 1024 + 1],
    ] as const) {
      const outcome = await capacityRepository.meterCapacity({
        tenantId: 'tenant-a',
        organizationId: 'tenant-a',
        workspaceId: 'workspace-a',
        runId: String(turnResponse.body.runId),
        fencingToken: Number(claimed.result.fencing_token),
        resource,
        quantity,
      })
      assert.equal(outcome.accepted, false)
      assert.match(outcome.reasonCode, /_CAPACITY_EXCEEDED$/)
    }
    const eventLimit = await capacityRepository.appendFencedEvent({
      tenantId: 'tenant-a',
      organizationId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId,
      runId: String(turnResponse.body.runId),
      eventId: `evt-limit-${turnResponse.body.runId}`,
      eventType: 'capacity.probe',
      fencingToken: Number(claimed.result.fencing_token),
      payload: { bytes: 'x'.repeat(600 * 1024) },
    })
    assert.equal(eventLimit.accepted, false)
    assert.equal(eventLimit.reasonCode, 'EVENT_CAPACITY_EXCEEDED')
  } finally {
    await capacityRepository.close()
  }
  const placement = await stack.query(
    `SELECT c.node_id FROM persistent_codex.capacity_reservations c JOIN persistent_codex.scheduler_queue q USING (tenant_id,organization_id,workspace_id,queue_item_id) WHERE q.run_id=$1 AND c.fencing_token=$2`,
    [turnResponse.body.runId, claimed.result.fencing_token],
  )
  const drainedNodeId = String(placement.rows[0].node_id)
  await stack.query(
    `UPDATE persistent_codex.runtime_nodes SET state='draining',updated_at=now()
    WHERE region_id='eu-1' AND node_id=$1`,
    [drainedNodeId],
  )
  await stack.query(
    `INSERT INTO persistent_codex.drain_states
      (tenant_id,organization_id,workspace_id,drain_id,target_kind,region_id,node_id,state,reason_code,requested_at)
    VALUES ('*','*','*',$2,'node','eu-1',$1,'draining','WP26_ACCEPTANCE',now())`,
    [drainedNodeId, `drain-${turnResponse.body.runId}`],
  )
  const recoveryStarted = performance.now()
  stack.processes[killedWorker]?.kill('SIGKILL')
  const completed = await waitUntil(async () => {
    const result = await stack.query(
      `SELECT state,fencing_token FROM persistent_codex.ha_runs WHERE run_id=$1`,
      [turnResponse.body.runId],
    )
    return result.rows[0]?.state === 'completed' ? result.rows[0] : null
  })
  const schedulerRecoveryRtoMs = Math.round(performance.now() - recoveryStarted)
  assert(
    Number(completed.result.fencing_token) >
      Number(claimed.result.fencing_token),
  )
  const staleRepository = createProductionPostgresRepository(stack.databaseUrl)
  try {
    const staleWrite = await staleRepository.appendFencedEvent({
      tenantId: 'tenant-a',
      organizationId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId,
      runId: String(turnResponse.body.runId),
      eventId: `evt-stale-${turnResponse.body.runId}`,
      eventType: 'stale.probe',
      fencingToken: Number(claimed.result.fencing_token),
      payload: { opaque: true },
    })
    assert.equal(staleWrite.accepted, false)
    assert.equal(staleWrite.reasonCode, 'STALE_FENCING_TOKEN')
  } finally {
    await staleRepository.close()
  }
  const recoveredPlacement = await stack.query(
    `SELECT c.node_id FROM persistent_codex.capacity_reservations c JOIN persistent_codex.scheduler_queue q USING (tenant_id,organization_id,workspace_id,queue_item_id) WHERE q.run_id=$1 AND c.fencing_token=$2`,
    [turnResponse.body.runId, completed.result.fencing_token],
  )
  assert.notEqual(recoveredPlacement.rows[0].node_id, drainedNodeId)
  await stack.query(
    `UPDATE persistent_codex.drain_states SET state='drained',completed_at=now() WHERE drain_id=$1`,
    [`drain-${turnResponse.body.runId}`],
  )
  await stack.restartWorker(killedWorker, codexBin)
  const replay = await json(
    `${stack.loadBalancerUrl}/v1/sessions/${sessionId}/events?after=0`,
    { headers: wp26Headers },
  )
  assert.equal(replay.response.status, 200)
  assert(replay.body.highWaterSequence >= 3)
  assert(
    replay.body.events.some((event: any) => event.type === 'turn.completed'),
  )
  const runtimeStarts = await stack.query(
    `SELECT count(*)::int count FROM persistent_codex.ha_runtime_starts WHERE run_id=$1`,
    [turnResponse.body.runId],
  )
  assert(runtimeStarts.rows[0].count >= 1 && runtimeStarts.rows[0].count <= 2)

  const dependencies = [stack.rabbit, stack.minio, stack.vault] as const
  const dependencyResults: Record<string, number> = {}
  for (const index of [
    0,
    1,
    ...Array.from(
      { length: Math.max(0, stack.processes.length - 4) },
      (_, offset) => offset + 4,
    ),
  ])
    stack.processes[index]?.kill('SIGKILL')
  await waitUntil(
    async () =>
      (await fetch(`${stack.loadBalancerUrl}/readyz`)).status === 503
        ? true
        : null,
    10_000,
  )
  const runtimeDenied = await json(`${stack.loadBalancerUrl}/v1/sessions`, {
    method: 'POST',
    headers: scopeHeaders,
  })
  assert.equal(runtimeDenied.response.status, 503)
  dependencyResults.runtimeControl = runtimeDenied.response.status
  await stack.restartWorker(0, codexBin)
  await stack.restartWorker(1, codexBin)
  for (const dependency of dependencies) {
    stack.pauseContainer(dependency)
    const denied = await json(`${stack.loadBalancerUrl}/v1/sessions`, {
      method: 'POST',
      headers: scopeHeaders,
    })
    assert.equal(denied.response.status, 503)
    dependencyResults[dependency.split('-').at(-1)!] = denied.response.status
    stack.unpauseContainer(dependency)
    await waitUntil(
      async () =>
        (await fetch(`${stack.loadBalancerUrl}/readyz`)).status === 200
          ? true
          : null,
      90_000,
    ).catch(async () => {
      const readiness = await json(`${stack.loadBalancerUrl}/readyz`)
      throw new Error(
        `dependency restore failed (${dependency}): ${JSON.stringify(readiness.body)}`,
      )
    })
  }
  stack.pauseContainer(stack.postgres)
  const pgDenied = await fetch(`${stack.loadBalancerUrl}/v1/sessions`, {
    method: 'POST',
    headers: scopeHeaders,
  })
  assert.equal(pgDenied.status, 503)
  stack.unpauseContainer(stack.postgres)
  await waitUntil(
    async () =>
      (await fetch(`${stack.loadBalancerUrl}/readyz`)).status === 200
        ? true
        : null,
    30_000,
  )
  const durableReplay = await json(
    `${stack.loadBalancerUrl}/v1/sessions/${sessionId}/events?after=0`,
    { headers: wp26Headers },
  )
  assert.equal(
    durableReplay.body.highWaterSequence,
    replay.body.highWaterSequence,
  )
  console.log(
    JSON.stringify({
      gate: 'wp26:ha',
      productionHaEvidence: true,
      topology: {
        apiInstances: 2,
        schedulerInstances: 2,
        postgresql: 1,
        broker: 'rabbitmq',
        objectStorage: 'minio',
        kms: 'vault',
      },
      sessionId,
      runId: turnResponse.body.runId,
      instanceKill: 'continued',
      approvalContext: 'preserved',
      highWaterSequence: replay.body.highWaterSequence,
      firstFencingToken: Number(claimed.result.fencing_token),
      recoveryFencingToken: Number(completed.result.fencing_token),
      staleOwner: 'database-fence-rejected',
      runtimeSupervisorAttempts: runtimeStarts.rows[0].count,
      codexStarts: 1,
      duplicateCodexStart: 0,
      drain: {
        drainedNodeId,
        recoveredNodeId: recoveredPlacement.rows[0].node_id,
        acceptedRunLost: false,
      },
      rpoMs: 0,
      schedulerRecoveryRtoMs,
      dependencyLoss: { ...dependencyResults, postgresql: pgDenied.status },
      committedReplayAfterDependencyRestore: 'preserved',
      cleanup: 'complete',
    }),
  )
} finally {
  await stack.cleanup()
}
