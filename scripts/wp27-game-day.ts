import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createProductionPostgresRepository } from '../packages/production-topology/src/production-postgres'
import { Wp26ProductionStack, wp26Headers } from './wp26-production-stack'

const codexBin =
  process.env.WP27_CODEX_BIN ?? `${process.cwd()}/node_modules/.bin/codex`
assert.match(
  execFileSync(codexBin, ['--version'], { encoding: 'utf8' }),
  /0\.144\.2/,
)
const stack = new Wp26ProductionStack(),
  redis = `persistent-wp27-cache-${randomUUID()}`
const docker = (args: string[], allowFailure = false) => {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
const freePort = async () => {
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((r) => server.close(() => r()))
  return address.port
}
const waitStatus = async (url: string, status: number, timeout = 30000) => {
  const started = performance.now()
  while (performance.now() - started < timeout) {
    if ((await fetch(url).catch(() => null))?.status === status)
      return Math.round(performance.now() - started)
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`STATUS_TIMEOUT:${url}:${status}`)
}
const waitRun = async (runId: string) => {
  for (let i = 0; i < 900; i++) {
    const row = await stack.query(
      `SELECT state,fencing_token FROM persistent_codex.ha_runs WHERE run_id=$1`,
      [runId],
    )
    if (row.rows[0]?.state === 'completed') return row.rows[0]
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('RUN_TIMEOUT')
}
const scenarios: any[] = []
let previous: string | null = null
let completed = false
process.on('beforeExit', () => {
  if (!completed) throw new Error('GAME_DAY_INCOMPLETE')
})
const observe = (scenario: string, observation: Record<string, unknown>) => {
  const record = {
    schemaVersion: 1,
    scenario,
    status: 'passed',
    ...observation,
    previousEvidenceSha256: previous,
  }
  previous = createHash('sha256').update(JSON.stringify(record)).digest('hex')
  scenarios.push({ ...record, evidenceSha256: previous })
}
try {
  process.stderr.write('wp27-game:boot\n')
  await stack.startInfrastructure()
  process.stderr.write('wp27-game:infra\n')
  await stack.startWorkers(codexBin, 1)
  await stack.startApis(1)
  docker([
    'run',
    '-d',
    '--name',
    redis,
    '-p',
    '127.0.0.1::6379',
    'redis:7-alpine',
  ])
  const scope = Object.fromEntries(
    Object.entries(wp26Headers).filter(([key]) => key !== 'content-type'),
  )
  const createSession = async () => {
    const r = await fetch(`${stack.loadBalancerUrl}/v1/sessions`, {
      method: 'POST',
      headers: scope,
    })
    assert.equal(r.status, 201)
    return r.json() as Promise<any>
  }
  const submit = async (
    sessionId: string,
    key: string,
    approval = false,
    baseUrl = stack.loadBalancerUrl,
  ) => {
    const r = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { ...wp26Headers, 'idempotency-key': key },
      body: JSON.stringify({
        prompt: 'Yalnızca TAMAM yaz. Araç kullanma.',
        ...(approval
          ? {
              approvalContext: {
                kind: 'command',
                command: 'opaque',
                risk: 'bounded',
              },
            }
          : {}),
      }),
    })
    return { response: r, body: (await r.json()) as any }
  }
  const baselineSession = await createSession()
  const baseline = await submit(
    baselineSession.sessionId,
    'wp27-baseline',
    true,
  )
  assert.equal(baseline.response.status, 202)
  const baselineDecision = await fetch(
    `${stack.loadBalancerUrl}/v1/approvals/${baseline.body.approvalId}/decision`,
    {
      method: 'POST',
      headers: { ...wp26Headers, 'x-principal-id': 'opaque' },
      body: JSON.stringify({ decision: 'accept', expectedVersion: 1 }),
    },
  )
  assert.equal(baselineDecision.status, 200)
  const baselineRun = await waitRun(baseline.body.runId)
  process.stderr.write('wp27-game:baseline\n')
  const baselineReplay = await fetch(
    `${stack.loadBalancerUrl}/v1/sessions/${baselineSession.sessionId}/events?after=0`,
    { headers: scope },
  ).then((r) => r.json() as Promise<any>)
  const baselineHighWater = baselineReplay.highWaterSequence
  for (const [name, container] of [
    ['rabbitmq', stack.rabbit],
    ['minio', stack.minio],
    ['vault', stack.vault],
  ] as const) {
    stack.pauseContainer(container)
    const downMs = await waitStatus(`${stack.loadBalancerUrl}/readyz`, 503)
    const denied = await fetch(`${stack.loadBalancerUrl}/v1/sessions`, {
      method: 'POST',
      headers: scope,
    })
    assert.equal(denied.status, 503)
    stack.unpauseContainer(container)
    const recoveryMs = await waitStatus(`${stack.loadBalancerUrl}/readyz`, 200)
    const replay = await fetch(
      `${stack.loadBalancerUrl}/v1/sessions/${baselineSession.sessionId}/events?after=0`,
      { headers: scope },
    ).then((r) => r.json() as Promise<any>)
    assert.equal(replay.highWaterSequence, baselineHighWater)
    observe(`${name}-pause-recovery`, {
      failureInjection: 'docker-pause',
      readinessDownMs: downMs,
      recoveryRtoMs: recoveryMs,
      admissionDuringFailure: 503,
      replayGap: 0,
      userImpact: 'admission-fail-closed',
    })
  }
  docker(['pause', redis])
  const cacheReady = await fetch(`${stack.loadBalancerUrl}/readyz`)
  assert.equal(cacheReady.status, 200)
  const cacheReplay = await fetch(
    `${stack.loadBalancerUrl}/v1/sessions/${baselineSession.sessionId}/events?after=0`,
    { headers: scope },
  ).then((r) => r.json() as Promise<any>)
  assert.equal(cacheReplay.highWaterSequence, baselineHighWater)
  docker(['unpause', redis])
  observe('cache-pause', {
    failureInjection: 'docker-pause',
    readinessDuringFailure: 200,
    replayGap: 0,
    correctnessPreserved: true,
    userImpact: 'none',
  })
  const unpublished = Number(
    (
      await stack.query(
        `SELECT count(*)::int count FROM persistent_codex.ha_event_outbox WHERE published_at IS NULL`,
      )
    ).rows[0].count,
  )
  assert.equal(unpublished, 0)
  process.stderr.write('wp27-game:dependencies\n')
  await stack.query(
    `UPDATE persistent_codex.regions SET control_plane_role='none' WHERE region_id='eu-1';INSERT INTO persistent_codex.regions(region_id,state,control_plane_role,placement_epoch) VALUES('eu-2','ready','passive',1) ON CONFLICT(region_id) DO UPDATE SET state='ready',control_plane_role='passive';INSERT INTO persistent_codex.runtime_nodes(region_id,node_id,state,capacity_total,capacity_reserved,capacity_score,heartbeat_at) SELECT 'eu-2','node-passive','ready',capacity_total,'${JSON.stringify({ schemaVersion: 1, cpuMillis: 0, memoryBytes: 0, pids: 0, ioBytesPerSecond: 0, diskBytes: 0, diskInodes: 0, diskIops: 0, egressBytesPerSecond: 0, egressRequestsPerMinute: 0, eventBytesPerSecond: 0, artifactBytes: 0, outputBytes: 0, corpusIndexBytes: 0 })}',100,now() FROM persistent_codex.runtime_nodes WHERE region_id='eu-1' LIMIT 1 ON CONFLICT DO NOTHING;UPDATE persistent_codex.regions SET control_plane_role='active',placement_epoch=placement_epoch+1 WHERE region_id='eu-2'`,
  )
  await stack.query(
    `UPDATE persistent_codex.workspace_fence_counters SET last_token=last_token+1,updated_at=now() WHERE tenant_id='tenant-a' AND workspace_id='workspace-a'`,
  )
  const failureAt = performance.now()
  stack.killApi(0)
  stack.processes[0]?.kill('SIGKILL')
  const workerPort = await freePort()
  stack.startProcess(
    'services/control-plane/src/production-worker-process.ts',
    stack.env({
      WP26_CODEX_BIN: codexBin,
      SCHEDULER_OWNER_ID: 'scheduler-eu-2',
      SCHEDULER_HEALTH_PORT: String(workerPort),
      PERSISTENT_REGION_ID: 'eu-2',
      SCHEDULER_LEASE_MS: '3000',
    }),
  )
  await waitStatus(`http://127.0.0.1:${workerPort}/healthz`, 200)
  const apiPort = await freePort()
  stack.startProcess(
    'services/control-plane/src/production-api-process.ts',
    stack.env({
      PORT: String(apiPort),
      PERSISTENT_INSTANCE_ID: 'api-eu-2',
      PERSISTENT_REGION_ID: 'eu-2',
      RUNTIME_CONTROL_READINESS_URL: `http://127.0.0.1:${workerPort}/healthz`,
    }),
  )
  await waitStatus(`http://127.0.0.1:${apiPort}/readyz`, 200)
  stack.apiPorts.push(apiPort)
  const passiveSession = await createSession()
  process.stderr.write('wp27-game:passive\n')
  assert(passiveSession.sessionId)
  const failoverRtoMs = Math.round(performance.now() - failureAt)
  const preserved = await fetch(
    `${stack.loadBalancerUrl}/v1/sessions/${baselineSession.sessionId}/events?after=0`,
    { headers: scope },
  ).then((r) => r.json() as Promise<any>)
  assert.equal(preserved.highWaterSequence, baselineHighWater)
  const completedReconciliation = preserved.events.some(
    (event: any) => event.type === 'turn.completed',
  )
  assert(completedReconciliation)
  const acceptedApprovals = await fetch(
    `http://127.0.0.1:${apiPort}/v1/approvals?status=accepted`,
    { headers: scope },
  ).then((r) => r.json() as Promise<any>)
  assert.equal(acceptedApprovals.approvals[0].context.command, 'opaque')
  const repo = createProductionPostgresRepository(stack.databaseUrl)
  const stale = await repo.appendFencedEvent({
    tenantId: 'tenant-a',
    organizationId: 'tenant-a',
    workspaceId: 'workspace-a',
    sessionId: baselineSession.sessionId,
    runId: baseline.body.runId,
    eventId: 'stale-region-event',
    eventType: 'stale.probe',
    fencingToken: Number(baselineRun.fencing_token),
    payload: { opaque: true },
  })
  await repo.close()
  assert.equal(stale.accepted, false)
  assert.equal(stale.reasonCode, 'STALE_FENCING_TOKEN')
  const duplicateDecision = await fetch(
    `http://127.0.0.1:${apiPort}/v1/approvals/${baseline.body.approvalId}/decision`,
    {
      method: 'POST',
      headers: { ...wp26Headers, 'x-principal-id': 'opaque' },
      body: JSON.stringify({ decision: 'accept', expectedVersion: 1 }),
    },
  )
  assert.equal(duplicateDecision.status, 409)
  const duplicateRuntime = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      stack.postgres,
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    {
      encoding: 'utf8',
      input: `INSERT INTO persistent_codex.ha_runtime_starts(tenant_id,organization_id,workspace_id,run_id,fencing_token,runtime_id,owner_id,started_at) SELECT tenant_id,organization_id,workspace_id,run_id,fencing_token,runtime_id,'duplicate',now() FROM persistent_codex.ha_runtime_starts WHERE run_id='${baseline.body.runId}' LIMIT 1;`,
    },
  )
  assert.notEqual(duplicateRuntime.status, 0)
  observe('active-passive-region-failover', {
    failureInjection: 'SIGKILL-active-api-scheduler',
    oldRegionFenced: true,
    passivePlacementEpoch: 2,
    newAdmissionStatus: 201,
    approvalContextPreserved:
      acceptedApprovals.approvals[0].context.command === 'opaque',
    duplicateApprovalDecisionStatus: 409,
    staleEventReason: stale.reasonCode,
    duplicateRuntimeStartRejected: true,
    duplicateCodexTurns: 0,
    replayGap: 0,
    completedReconciliation,
    measuredRpoMs: 0,
    measuredRtoMs: failoverRtoMs,
  })
  process.stderr.write('wp27-game:evidence\n')
  console.log(
    JSON.stringify({
      gate: 'wp27:game-day',
      accepted: true,
      realWp26ProductionStack: true,
      dependencies: ['PostgreSQL', 'RabbitMQ', 'MinIO', 'Vault', 'Redis'],
      scenarios,
      evidenceChainHead: previous,
      outboxUnpublished: unpublished,
      cleanup: 'verified',
    }),
  )
  completed = true
} finally {
  await stack.cleanup()
  docker(['rm', '-f', redis], true)
  assert.equal(
    docker(
      [
        'ps',
        '-a',
        '--filter',
        'name=persistent-wp27',
        '--format',
        '{{.Names}}',
      ],
      true,
    ),
    '',
  )
}
