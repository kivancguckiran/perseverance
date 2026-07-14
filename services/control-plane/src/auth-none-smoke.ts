import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildControlPlane } from './server'

const root = mkdtempSync(join(tmpdir(), 'persistent-codex-auth-none-'))
const hiddenEnvironment = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const
const saved = new Map(hiddenEnvironment.map((key) => [key, process.env[key]]))
for (const key of hiddenEnvironment) delete process.env[key]

const app = await buildControlPlane({
  databasePath: join(root, 'events.sqlite'),
  artifactRoot: join(root, 'artifacts'),
  codexHomeRoot: join(root, 'codex-homes'),
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
  evidence = {
    ok: true,
    readiness: body.status,
    instruction: body.recovery.instruction,
    sessionBlocked: true,
  }
} finally {
  await app.close()
  rmSync(root, { recursive: true, force: true })
  for (const key of hiddenEnvironment) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
console.log(JSON.stringify({ ...evidence, temporaryRuntimeCleaned: true }))
