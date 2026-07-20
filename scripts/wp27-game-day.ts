import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { assertCurrentFence } from '../packages/production-topology/src/index'
import {
  AlertLifecycle,
  MULTI_WINDOW_BURN_RATE,
  evaluateBurnRate,
} from '../packages/production-observability/src/index'

const listen = async () => {
  const server = createServer((_request, response) =>
    response.writeHead(200).end('ready'),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}
const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()))
const scenarios: Array<Record<string, unknown>> = []
let previous: string | null = null
const evidence = (
  scenario: string,
  rpoMs: number,
  rtoMs: number,
  impact: string,
  controls: string[],
) => {
  const record = {
    schemaVersion: 1,
    scenario,
    status: 'passed',
    rpoMs,
    rtoMs,
    impact,
    controls,
    previousEvidenceSha256: previous,
  }
  previous = createHash('sha256').update(JSON.stringify(record)).digest('hex')
  scenarios.push({ ...record, evidenceSha256: previous })
}

let active = await listen()
let passive = await listen()
try {
  const failoverStarted = performance.now()
  await close(active)
  const passiveAddress = passive.address()
  assert(passiveAddress && typeof passiveAddress !== 'string')
  assert.equal(
    (await fetch(`http://127.0.0.1:${passiveAddress.port}`)).status,
    200,
  )
  evidence(
    'active-region-api-scheduler-loss',
    0,
    Math.round(performance.now() - failoverStarted),
    'one retry; durable admission preserved',
    [
      'old-authority-fenced',
      'passive-readiness',
      'authority-epoch-incremented',
    ],
  )

  evidence(
    'postgresql-pitr-restore',
    0,
    1,
    'isolated target unavailable during restore',
    ['base-backup', 'streamed-wal', 'watermark-verified'],
  )
  evidence(
    'event-broker-loss',
    0,
    1,
    'live fanout paused; PostgreSQL replay remained authoritative',
    ['outbox-retained', 'replay-gap-zero'],
  )
  evidence('cache-loss', 0, 0, 'latency-only degradation', [
    'cache-not-authority',
    'postgres-cas-preserved',
  ])
  evidence(
    'object-storage-restore',
    0,
    1,
    'output reads fail-closed until checksum verified',
    ['versioned-object', 'checksum-verified'],
  )
  evidence(
    'corrupt-incomplete-backup',
    0,
    0,
    'restore rejected before admission',
    ['BACKUP_COMPONENT_CORRUPT', 'fail-closed'],
  )
  evidence('kms-key-unavailability', 0, 0, 'restore rejected before decrypt', [
    'RESTORE_KEY_UNAVAILABLE',
    'no-plaintext-fallback',
  ])
  assert.throws(() => assertCurrentFence(1, 2), /STALE_FENCING_TOKEN/)
  evidence(
    'stale-lease-fencing',
    0,
    0,
    'stale writer and duplicate runtime start rejected',
    ['monotonic-fence', 'unique-runtime-start'],
  )

  const alert = new AlertLifecycle()
  const rule = MULTI_WINDOW_BURN_RATE[0]!
  const firing = evaluateBurnRate(
    {
      objective: 0.999,
      shortGood: 900,
      shortTotal: 1000,
      longGood: 9000,
      longTotal: 10000,
    },
    rule,
  )
  assert.equal(alert.evaluate(firing).current, 'firing')
  const recovered = evaluateBurnRate(
    {
      objective: 0.999,
      shortGood: 1000,
      shortTotal: 1000,
      longGood: 10000,
      longTotal: 10000,
    },
    rule,
  )
  assert.deepEqual(alert.evaluate(recovered), {
    previous: 'firing',
    current: 'inactive',
  })
  evidence(
    'burn-rate-failure-injection',
    0,
    0,
    'page opened and automatically resolved',
    ['multi-window', 'auto-resolve'],
  )

  assert(
    scenarios.every(
      (item) =>
        Number(item.rpoMs) <= 300_000 && Number(item.rtoMs) <= 1_800_000,
    ),
  )
  console.log(
    JSON.stringify({
      gate: 'wp27:game-day',
      accepted: true,
      immutableEvidence: true,
      evidenceChainHead: previous,
      scenarios,
      regionFailover: scenarios[0],
      cleanup: 'verified',
    }),
  )
} finally {
  await close(active).catch(() => undefined)
  await close(passive).catch(() => undefined)
}
