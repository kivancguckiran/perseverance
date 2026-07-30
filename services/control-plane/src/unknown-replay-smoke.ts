import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { replayResponseSchema } from '@perseverance/control-plane-contracts'
import { CodexEventAdapter } from '@perseverance/codex-event-adapter'
import { SqliteEventStore } from '@perseverance/event-store'
import { buildControlPlane } from './server'

const root = mkdtempSync(join(tmpdir(), 'persistent-codex-unknown-replay-'))
const databasePath = join(root, 'events.sqlite')
const store = new SqliteEventStore(databasePath)
const scope = {
  tenantId: 'ten_poc_demo',
  workspaceId: 'wsp_poc_demo_unknown',
  sessionId: 'ses_poc_demo_unknown',
}
store.createSession(scope)
let sequence = 0
const adapter = new CodexEventAdapter({
  ...scope,
  sourceVersion: '0.144.2',
  nextSequence: () => ++sequence,
})
const input = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../tests/golden-sessions/unknown.input.jsonl',
        import.meta.url,
      ),
    ),
    'utf8',
  ).trim(),
)
const adapted = adapter.adapt(input)
store.ingest({
  ...scope,
  ingestKey: 'wp8-unknown-replay',
  raw: {
    envelope: adapted.envelope,
    checksum: adapted.checksum,
    sourceMethod: adapted.event.sourceMethod,
    sourceVersion: adapted.event.sourceVersion,
    receivedAt: adapted.event.receivedAt,
  },
  event: adapted.event,
})
const app = await buildControlPlane({
  eventStore: store,
  allowExplicitDevAuthentication: true,
})
let preserved = false
try {
  await app.ready()
  const response = await app.inject({
    method: 'GET',
    url: `/v1/sessions/${scope.sessionId}/events?after=0&limit=10`,
    headers: {
      'x-tenant-id': scope.tenantId,
      'x-workspace-id': scope.workspaceId,
    },
  })
  const replay = replayResponseSchema.parse(response.json())
  preserved =
    replay.events.length === 1 && replay.events[0]?.type === 'codex.unknown'
  if (!preserved)
    throw new Error('Unknown event was not preserved by REST replay')
} finally {
  await app.close()
  store.close()
  rmSync(root, { recursive: true, force: true })
}
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      path: 'event-store -> REST replay',
      preservedAs: 'codex.unknown',
      continued: preserved,
      cleanup: {
        databaseRemoved: !existsSync(databasePath),
        walRemoved: !existsSync(`${databasePath}-wal`),
        shmRemoved: !existsSync(`${databasePath}-shm`),
        temporaryRootRemoved: !existsSync(root),
      },
    },
    null,
    2,
  )}\n`,
)
