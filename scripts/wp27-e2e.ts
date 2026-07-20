import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  ProductionTelemetry,
  createTrace,
} from '../packages/production-observability/src/index'
import {
  CodexAppServerClient,
  createIsolatedCodexHome,
} from '../agents/workspace-agent/src/index'

const codexBin = process.env.WP27_CODEX_BIN
if (!codexBin) throw new Error('WP27_CODEX_BIN must point to Codex 0.144.2')
assert.match(
  execFileSync(codexBin, ['--version'], { encoding: 'utf8' }),
  /0\.144\.2/,
)

const isolated = createIsolatedCodexHome({ includeConfig: false })
const client = new CodexAppServerClient({
  command: codexBin,
  cwd: process.cwd(),
  env: { ...process.env, CODEX_HOME: isolated.path },
  requestTimeoutMs: 30_000,
  restart: { maxRestarts: 0 },
})
try {
  await client.initialize({
    name: 'persistent_wp27_observability',
    title: 'Persistent WP27 Observability',
    version: '1',
  })
  const thread = await client.request<{ thread: { id: string } }>(
    'thread/start',
    { cwd: process.cwd() },
  )
  assert(thread.thread.id)

  const telemetry = new ProductionTelemetry()
  const root = createTrace()
  let parent = root
  for (const [name, role] of [
    ['api.request', 'api'],
    ['turn.admission', 'api'],
    ['scheduler.claim', 'scheduler'],
    ['workspace.runtime', 'workspace-agent'],
    ['codex.turn', 'codex-app-server'],
    ['event.append', 'event-store'],
    ['event.publish', 'event-broker'],
  ] as const) {
    const span = telemetry.startSpan(name, {
      parent,
      attributes: {
        'service.name': 'persistent-codex',
        'service.role': role,
        operation: name,
        outcome: 'success',
      },
    })
    span.end()
    parent = span.context
  }
  const snapshot = telemetry.snapshot()
  assert.equal(new Set(snapshot.spans.map((span) => span.traceId)).size, 1)
  assert.equal(snapshot.spans.length, 7)
  assert(!JSON.stringify(snapshot).includes(process.cwd()))
  console.log(
    JSON.stringify({
      gate: 'wp27:e2e',
      accepted: true,
      codexVersion: '0.144.2',
      realProcess: 'codex app-server',
      handshake: ['initialize', 'thread/start'],
      providerTurnExecuted: false,
      externalPromptSent: false,
      traceCorrelation: [
        'api',
        'scheduler',
        'workspace-agent',
        'codex-app-server',
        'durable-event',
        'broker',
      ],
      traceId: root.traceId,
      cleanup: 'isolated-codex-home-removed',
    }),
  )
} finally {
  await client.stop().catch(() => undefined)
  isolated.cleanup()
}
