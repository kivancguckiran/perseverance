import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildControlPlane } from './server'
import { SqliteEventStore } from '@persistent-codex/event-store'

const root = mkdtempSync(join(tmpdir(), 'persistent-codex-auth-none-'))
const hiddenEnvironment = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const
const saved = new Map(hiddenEnvironment.map((key) => [key, process.env[key]]))
for (const key of hiddenEnvironment) delete process.env[key]

const databasePath = join(root, 'events.sqlite')
const artifactRoot = join(root, 'artifacts')
const codexHomeRoot = join(root, 'codex-homes')
const store = new SqliteEventStore(databasePath)
const app = await buildControlPlane({
  eventStore: store,
  artifactRoot,
  codexHomeRoot,
  workspaceCwd: process.cwd(),
})
let evidence: Record<string, unknown> | undefined
try {
  const headers = { 'x-tenant-id': 'ten_smoke', 'x-workspace-id': 'wsp_smoke' }
  const readiness = await app.inject({ method: 'GET', url: '/readyz', headers })
  const session = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers,
    payload: {},
  })
  const body = readiness.json() as {
    status?: string
    recovery?: { instruction?: string }
  }
  if (
    readiness.statusCode !== 503 ||
    body.status !== 'setup_required' ||
    body.recovery?.instruction !== 'codex login'
  )
    throw new Error('Isolated auth readiness did not require codex login')
  if (
    session.statusCode !== 401 ||
    (session.json() as { code?: string }).code !== 'AUTH_REQUIRED'
  )
    throw new Error('Session was not blocked before upstream thread/start')
  const audit = store.listWorkspaceAudit({
    tenantId: 'ten_smoke',
    workspaceId: 'wsp_smoke',
  })
  if (!audit.some((record) => record.action === 'auth.state_changed'))
    throw new Error('Auth transition audit was not persisted')
  const metrics = (
    await app.inject({ method: 'GET', url: '/metrics' })
  ).json() as {
    series?: Array<{ name: string; labels: Record<string, string> }>
  }
  const runtimeHealth = metrics.series?.find(
    (series) => series.name === 'runtime_health',
  )
  if (
    !runtimeHealth ||
    Object.keys(runtimeHealth.labels).some((key) => key !== 'state')
  )
    throw new Error('Auth smoke metrics are missing or unbounded')
  if (
    JSON.stringify(metrics).match(
      /ten_smoke|wsp_smoke|sessionId|requestId|path|prompt/i,
    )
  )
    throw new Error('Auth smoke metrics leaked scoped data')
  evidence = {
    ok: true,
    readiness: body.status,
    instruction: body.recovery.instruction,
    sessionBlocked: true,
    authTransitionAudited: true,
    boundedRuntimeMetric: true,
  }
} finally {
  await app.close()
  store.close()
  rmSync(root, { recursive: true, force: true })
  for (const key of hiddenEnvironment) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
console.log(
  JSON.stringify({
    ...evidence,
    databaseCleaned: !existsSync(databasePath),
    artifactRootCleaned: !existsSync(artifactRoot),
    codexHomeRootCleaned: !existsSync(codexHomeRoot),
    temporaryRuntimeCleaned: !existsSync(root),
  }),
)
