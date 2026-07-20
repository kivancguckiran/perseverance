import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  createTrace,
  traceparent,
} from '../packages/production-observability/src/index'
import { Wp26ProductionStack, wp26Headers } from './wp26-production-stack'

const codexBin = process.env.WP27_CODEX_BIN
if (!codexBin) throw new Error('WP27_CODEX_BIN must point to Codex 0.144.2')
assert.match(
  execFileSync(codexBin, ['--version'], { encoding: 'utf8' }),
  /0\.144\.2/,
)
const collector = `persistent-wp27-e2e-otel-${randomUUID()}`
const docker = (args: string[], allowFailure = false) => {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
const dockerLogs = (name: string) => {
  const result = spawnSync('docker', ['logs', name], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return `${result.stdout}${result.stderr}`
}
const stack = new Wp26ProductionStack()
const markers = [
  'WP27_SECRET_MARKER_7f91',
  'WP27_PROMPT_MARKER_42e1',
  'WP27_OUTPUT_MARKER_91ba',
  'WP27_PII_MARKER_person@example.invalid',
  'WP27_CORPUS_MARKER_a81d',
]
try {
  docker([
    'run',
    '-d',
    '--name',
    collector,
    '-v',
    `${process.cwd()}/infra/observability/otel-collector.v1.yaml:/etc/otelcol/config.yaml:ro`,
    '-p',
    '127.0.0.1::4318',
    '-p',
    '127.0.0.1::13133',
    'otel/opentelemetry-collector-contrib:0.130.1',
    '--config=/etc/otelcol/config.yaml',
  ])
  const port = (value: string) =>
    docker(['port', collector, value]).split(':').at(-1)!
  for (let i = 0; i < 80; i++) {
    if (
      (await fetch(`http://127.0.0.1:${port('13133/tcp')}`).catch(() => null))
        ?.ok
    )
      break
    await new Promise((r) => setTimeout(r, 250))
  }
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port('4318/tcp')}`
  process.env.TELEMETRY_MAX_RECORDS = '16'
  await stack.startInfrastructure()
  await stack.startWorkers(codexBin, 1)
  await stack.startApis(1)
  const scopeHeaders = Object.fromEntries(
    Object.entries(wp26Headers).filter(([key]) => key !== 'content-type'),
  )
  const root = createTrace()
  const sessionResponse = await fetch(`${stack.loadBalancerUrl}/v1/sessions`, {
    method: 'POST',
    headers: { ...scopeHeaders, traceparent: traceparent(root) },
  })
  assert.equal(sessionResponse.status, 201)
  const session = (await sessionResponse.json()) as any
  const prompt = `Acceptance fixture: ${markers.join(' ')}. Reply with exactly WP27_OUTPUT_MARKER_91ba.`
  const turnResponse = await fetch(
    `${stack.loadBalancerUrl}/v1/sessions/${session.sessionId}/turns`,
    {
      method: 'POST',
      headers: {
        ...wp26Headers,
        'idempotency-key': 'wp27-real-trace-turn',
        traceparent: traceparent(root),
      },
      body: JSON.stringify({ prompt }),
    },
  )
  assert.equal(turnResponse.status, 202)
  const turn = (await turnResponse.json()) as any
  let completed = false
  for (let i = 0; i < 900; i++) {
    const row = await stack.query(
      `SELECT state FROM persistent_codex.ha_runs WHERE run_id=$1`,
      [turn.runId],
    )
    if (row.rows[0]?.state === 'completed') {
      completed = true
      break
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  assert(completed, 'real Codex turn did not complete')
  const replayResponse = await fetch(
    `${stack.loadBalancerUrl}/v1/sessions/${session.sessionId}/events?after=0`,
    { headers: { ...scopeHeaders, traceparent: traceparent(root) } },
  )
  assert.equal(replayResponse.status, 200)
  const replay = (await replayResponse.json()) as any
  assert(replay.events.some((event: any) => event.type === 'turn.completed'))
  const correlation = await stack.query(
    `SELECT r.trace_id,count(DISTINCT e.trace_id)::int event_traces,count(DISTINCT s.trace_id)::int runtime_traces,count(DISTINCT s.runtime_id)::int runtimes FROM persistent_codex.ha_runs r JOIN persistent_codex.ha_events e USING(tenant_id,organization_id,workspace_id,run_id) JOIN persistent_codex.ha_runtime_starts s USING(tenant_id,organization_id,workspace_id,run_id) WHERE r.run_id=$1 GROUP BY r.trace_id`,
    [turn.runId],
  )
  assert.equal(correlation.rows[0].trace_id, root.traceId)
  assert.equal(correlation.rows[0].event_traces, 1)
  assert.equal(correlation.rows[0].runtime_traces, 1)
  assert.equal(correlation.rows[0].runtimes, 1)
  await new Promise((r) => setTimeout(r, 1800))
  let collectorLogs = dockerLogs(collector)
  const spans = [
    'api.request',
    'turn.admission',
    'scheduler.claim',
    'workspace.runtime',
    'codex.turn',
    'event.append',
    'event.publish',
    'event.replay',
  ]
  for (const span of spans)
    assert(collectorLogs.includes(span), `collector missing ${span}`)
  assert(collectorLogs.toLowerCase().includes(root.traceId.toLowerCase()))
  docker(['pause', collector])
  const duringLoss = await Promise.all(
    Array.from({ length: 40 }, () => fetch(`${stack.loadBalancerUrl}/healthz`)),
  )
  assert(duringLoss.every((r) => r.status === 200))
  await new Promise((r) => setTimeout(r, 1200))
  docker(['unpause', collector])
  await new Promise((r) => setTimeout(r, 1800))
  collectorLogs = dockerLogs(collector)
  assert(collectorLogs.includes('persistent_codex_telemetry_dropped'))
  const dependencyLogs = [
    stack.postgres,
    stack.rabbit,
    stack.minio,
    stack.vault,
  ]
    .map((name) => dockerLogs(name))
    .join('\n')
  const allTelemetry = [
    collectorLogs,
    ...stack.processDiagnostics,
    dependencyLogs,
  ].join('\n')
  for (const marker of markers)
    assert(!allTelemetry.includes(marker), `TELEMETRY_LEAK:${marker}`)
  console.log(
    JSON.stringify({
      gate: 'wp27:e2e',
      accepted: true,
      codexVersion: '0.144.2',
      providerTurnExecuted: true,
      externalFixtureAuthorized: true,
      traceId: root.traceId,
      collectorSpans: spans,
      durableTraceCorrelation: true,
      runtimeStarts: Number(correlation.rows[0].runtimes),
      duplicateCodexTurns: 0,
      collectorFailureProductContinued: true,
      telemetryDropMetricObserved: true,
      telemetryMarkerMatches: 0,
      replayCompleted: true,
    }),
  )
} finally {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete process.env.TELEMETRY_MAX_RECORDS
  await stack.cleanup()
  docker(['rm', '-f', collector], true)
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
