import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CodexAppServerClient } from '../agents/workspace-agent/src/index'
import { SqliteEventStore } from '../packages/event-store/src/index'
import { LocalArtifactStorage } from '../packages/artifact-storage/src/index'

const evidenceDirectory = resolve('.runtime/acceptance')
mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 })
const root = mkdtempSync(join(tmpdir(), 'persistent-alpha-soak-'))
const fixture = resolve(
  'agents/workspace-agent/test/fixtures/fake-app-server.mjs',
)
const databasePath = join(root, 'events.sqlite')
const artifactRoot = join(root, 'artifacts')
const iterations = 12

function childPids(): number[] {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('process measurement unavailable')
  const pairs = result.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
  const found = new Set<number>()
  let parents = new Set([process.pid])
  while (parents.size) {
    const next = new Set<number>()
    for (const [pid, ppid] of pairs) {
      if (parents.has(ppid!) && !found.has(pid!)) {
        found.add(pid!)
        next.add(pid!)
      }
    }
    parents = next
  }
  return [...found]
}

function fdCount(): number {
  if (existsSync('/dev/fd')) return readdirSync('/dev/fd').length
  const result = spawnSync('lsof', ['-p', String(process.pid)], {
    encoding: 'utf8',
  })
  if (result.status !== 0)
    throw new Error('file descriptor measurement unavailable')
  return Math.max(0, result.stdout.trim().split('\n').length - 1)
}

function bytesUnder(path: string): number {
  if (!existsSync(path)) return 0
  const stat = statSync(path)
  if (stat.isFile()) return stat.size
  return readdirSync(path).reduce(
    (sum, entry) => sum + bytesUnder(join(path, entry)),
    0,
  )
}

const baseline = {
  childProcesses: childPids().length,
  fileDescriptors: fdCount(),
  rssBytes: process.memoryUsage.rss(),
}
let peakChildren = baseline.childProcesses
let peakFds = baseline.fileDescriptors
let peakRss = baseline.rssBytes
const cpuStart = process.cpuUsage()
const wallStart = Date.now()

const store = new SqliteEventStore(databasePath, {
  auditRetention: {
    maxAgeMs: 60_000,
    maxRecords: 100,
    maxMetadataBytes: 64 * 1024,
  },
})
const scope = {
  tenantId: 'ten_accept',
  workspaceId: 'wsp_accept',
  sessionId: 'ses_accept',
}
store.createSession(scope)
for (let index = 0; index < 250; index++) {
  store.appendAudit({
    ...scope,
    actor: 'system',
    action: 'runtime.restarted',
    outcome: 'success',
    idempotencyKey: `soak-${index}`,
    metadata: { runtimeState: 'ready', processGeneration: index },
  })
}

const artifacts = new LocalArtifactStorage(artifactRoot)
const artifact = artifacts.create(
  { ...scope, turnId: 'turn', itemId: 'item' },
  'command-output',
)
const chunk = Buffer.alloc(64 * 1024, 0x61)
for (let index = 0; index < 128; index++)
  artifacts.append({
    artifactId: artifact.artifactId,
    scope: { ...scope, turnId: 'turn', itemId: 'item' },
    chunkIndex: index,
    stream: 'combined',
    data: chunk,
  })
artifacts.finalize(artifact.artifactId, {
  ...scope,
  turnId: 'turn',
  itemId: 'item',
})

for (let index = 0; index < iterations; index++) {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    cwd: root,
    requestTimeoutMs: 5_000,
  })
  await client.initialize({
    name: 'alpha-soak',
    title: 'Alpha soak',
    version: '1',
  })
  await client.request('thread/start', { cwd: root })
  peakChildren = Math.max(peakChildren, childPids().length)
  peakFds = Math.max(peakFds, fdCount())
  peakRss = Math.max(peakRss, process.memoryUsage.rss())
  await client.stop()
  if (client.pendingRequestCount !== 0 || client.running)
    throw new Error('fake runtime did not stop cleanly')
}

const databaseBytes =
  bytesUnder(databasePath) +
  bytesUnder(`${databasePath}-wal`) +
  bytesUnder(`${databasePath}-shm`)
const artifactBytes = bytesUnder(artifactRoot)
const auditStats = store.getAuditStats()
store.close()
const final = {
  childProcesses: childPids().length,
  fileDescriptors: fdCount(),
  rssBytes: process.memoryUsage.rss(),
}
const cpu = process.cpuUsage(cpuStart)
const wallMs = Math.max(1, Date.now() - wallStart)
const cpuRatio = (cpu.user + cpu.system) / 1000 / wallMs

const thresholds = {
  peakChildProcesses: baseline.childProcesses + 1,
  finalChildProcesses: baseline.childProcesses,
  peakFileDescriptorDelta: 32,
  finalFileDescriptorDelta: 8,
  rssGrowthBytes: 128 * 1024 * 1024,
  cpuCoreRatio: Math.max(1, cpus().length) * 1.25,
  sqliteBytes: 16 * 1024 * 1024,
  artifactBytes: 9 * 1024 * 1024,
  auditRecords: 100,
  realtimeQueueEvents: 256,
  realtimeQueueBytes: 1024 * 1024,
  browserTimelineEvents: 2_000,
}
const checks = {
  childProcesses:
    peakChildren <= thresholds.peakChildProcesses &&
    final.childProcesses <= thresholds.finalChildProcesses,
  fileDescriptors:
    peakFds - baseline.fileDescriptors <= thresholds.peakFileDescriptorDelta &&
    final.fileDescriptors - baseline.fileDescriptors <=
      thresholds.finalFileDescriptorDelta,
  rss: final.rssBytes - baseline.rssBytes <= thresholds.rssGrowthBytes,
  cpu: cpuRatio <= thresholds.cpuCoreRatio,
  sqlite: databaseBytes <= thresholds.sqliteBytes,
  artifacts: artifactBytes <= thresholds.artifactBytes,
  auditRetention: auditStats.records <= thresholds.auditRecords,
  realtimeQueue: 'measured_by_integration_test',
  browserTimeline: 'measured_by_integration_test',
}
const passed = Object.values(checks).every(
  (value) => value === true || value === 'measured_by_integration_test',
)
rmSync(root, { recursive: true, force: true })
const summary = {
  schemaVersion: 1,
  status: passed && !existsSync(root) ? 'passed' : 'failed',
  platform: process.platform,
  iterations,
  measurements: {
    peakChildProcesses: peakChildren - baseline.childProcesses,
    finalChildProcesses: final.childProcesses - baseline.childProcesses,
    peakFileDescriptorDelta: peakFds - baseline.fileDescriptors,
    finalFileDescriptorDelta: final.fileDescriptors - baseline.fileDescriptors,
    rssGrowthBytes: Math.max(0, final.rssBytes - baseline.rssBytes),
    cpuCoreRatio: Number(cpuRatio.toFixed(3)),
    sqliteBytes: databaseBytes,
    artifactBytes,
    auditRecords: auditStats.records,
    temporaryRuntimeRemaining: existsSync(root) ? 1 : 0,
  },
  thresholds,
  checks,
}
writeFileSync(
  join(evidenceDirectory, 'alpha-soak.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  { mode: 0o600 },
)
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
if (summary.status !== 'passed') process.exitCode = 1
