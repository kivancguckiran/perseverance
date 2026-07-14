import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CodexAppServerClient } from '../agents/workspace-agent/src/index'
import { SqliteEventStore } from '../packages/event-store/src/index'

const evidenceDirectory = resolve('.runtime/acceptance')
mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 })
const root = mkdtempSync(join(tmpdir(), 'persistent-alpha-lifecycle-'))
const databasePath = join(root, 'events.sqlite')
const backupPath = join(root, 'events.backup.sqlite')
const restorePath = join(root, 'events.restored.sqlite')
const fixture = resolve(
  'agents/workspace-agent/test/fixtures/fake-app-server.mjs',
)
const scope = {
  tenantId: 'ten_lifecycle',
  workspaceId: 'wsp_lifecycle',
  sessionId: 'ses_lifecycle',
}

let store = new SqliteEventStore(databasePath)
store.createSession(scope)
store.appendAudit({
  ...scope,
  actor: 'system',
  action: 'session.created',
  outcome: 'success',
  idempotencyKey: 'lifecycle-seed',
})
store.close()

const downgradeMarker = new DatabaseSync(databasePath)
downgradeMarker.exec('PRAGMA user_version=5')
downgradeMarker.close()
store = new SqliteEventStore(databasePath)
store.close()
const migrated = new DatabaseSync(databasePath)
const schemaVersion = Number(
  (migrated.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version,
)
migrated.exec('PRAGMA wal_checkpoint(TRUNCATE)')
const integrityBefore = String(
  (
    migrated.prepare('PRAGMA integrity_check').get() as {
      integrity_check: string
    }
  ).integrity_check,
)
migrated.close()

copyFileSync(databasePath, backupPath)
copyFileSync(backupPath, restorePath)
const restored = new DatabaseSync(restorePath)
const integrityAfter = String(
  (
    restored.prepare('PRAGMA integrity_check').get() as {
      integrity_check: string
    }
  ).integrity_check,
)
const restoredAuditCount = Number(
  (
    restored.prepare('SELECT COUNT(*) AS count FROM audit_records').get() as {
      count: number
    }
  ).count,
)
restored.close()

const client = new CodexAppServerClient({
  command: process.execPath,
  args: [fixture],
  cwd: root,
})
await client.initialize({
  name: 'alpha-lifecycle',
  title: 'Alpha lifecycle',
  version: '1',
})
const firstGeneration = client.processGeneration
await client.stop()
await client.initialize({
  name: 'alpha-lifecycle',
  title: 'Alpha lifecycle',
  version: '1',
})
const secondGeneration = client.processGeneration
await client.stop()

const checks = {
  migration: schemaVersion === 6,
  backupIntegrity: integrityBefore === 'ok' && statSync(backupPath).size > 0,
  restoreIntegrity: integrityAfter === 'ok' && restoredAuditCount === 1,
  startStopRestart:
    firstGeneration === 1 && secondGeneration === 2 && !client.running,
  walCheckpointed:
    !existsSync(`${databasePath}-wal`) ||
    statSync(`${databasePath}-wal`).size === 0,
  shmClosed: !existsSync(`${databasePath}-shm`),
}
rmSync(root, { recursive: true, force: true })
const passed = Object.values(checks).every(Boolean) && !existsSync(root)
const summary = {
  schemaVersion: 1,
  status: passed ? 'passed' : 'failed',
  migration: { from: 5, to: schemaVersion },
  backup: { integrity: integrityBefore, nonEmpty: true },
  restore: {
    integrity: integrityAfter,
    durableAuditRecovered: restoredAuditCount === 1,
  },
  runtime: { generationsObserved: 2, stopped: !client.running },
  cleanup: { temporaryRuntimeRemaining: existsSync(root) ? 1 : 0 },
  checks,
}
writeFileSync(
  join(evidenceDirectory, 'alpha-lifecycle.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  { mode: 0o600 },
)
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
if (!passed) process.exitCode = 1
