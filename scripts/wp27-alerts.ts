import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const id = `persistent-wp27-prom-${randomUUID()}`,
  image = process.env.WP27_PROMETHEUS_IMAGE ?? 'prom/prometheus:v3.5.0'
const dir = await mkdtemp(join(tmpdir(), 'wp27-prometheus-'))
const docker = (args: string[], allowFailure = false) => {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
let values = {
  burn5: 0,
  burn1h: 0,
  burn30: 0,
  burn6h: 0,
  restore: 1,
  regionRpo: 0,
  regionRto: 0,
}
const metrics = createServer((_request, response) =>
  response
    .writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
    .end(
      `persistent_codex_slo_burn_rate_5m ${values.burn5}\npersistent_codex_slo_burn_rate_1h ${values.burn1h}\npersistent_codex_slo_burn_rate_30m ${values.burn30}\npersistent_codex_slo_burn_rate_6h ${values.burn6h}\npersistent_codex_restore_success ${values.restore}\npersistent_codex_region_failover_rpo_ms ${values.regionRpo}\npersistent_codex_region_failover_rto_ms ${values.regionRto}\n`,
    ),
)
await new Promise<void>((resolve) => metrics.listen(0, '0.0.0.0', resolve))
const address = metrics.address()
assert(address && typeof address !== 'string')
const rules = await readFile('infra/observability/alerts.v1.yml', 'utf8')
await writeFile(join(dir, 'alerts.yml'), rules)
await writeFile(
  join(dir, 'prometheus.yml'),
  `global:\n  scrape_interval: 1s\n  evaluation_interval: 1s\nrule_files:\n  - /etc/prometheus/alerts.yml\nscrape_configs:\n  - job_name: wp27-real-sli\n    static_configs:\n      - targets: ['host.docker.internal:${address.port}']\n`,
)
const waitAlerts = async (port: string, expected: string[]) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/alerts`,
    ).catch(() => null)
    if (response?.ok) {
      const body = (await response.json()) as any
      const firing = body.data.alerts
        .filter((item: any) => item.state === 'firing')
        .map((item: any) => item.labels.alertname)
        .sort()
      if (JSON.stringify(firing) === JSON.stringify([...expected].sort()))
        return firing
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`PROMETHEUS_ALERT_STATE_TIMEOUT:${expected.join(',')}`)
}
try {
  docker([
    'run',
    '-d',
    '--name',
    id,
    '--add-host',
    'host.docker.internal:host-gateway',
    '-v',
    `${dir}/prometheus.yml:/etc/prometheus/prometheus.yml:ro`,
    '-v',
    `${dir}/alerts.yml:/etc/prometheus/alerts.yml:ro`,
    '-p',
    '127.0.0.1::9090',
    image,
    '--config.file=/etc/prometheus/prometheus.yml',
  ])
  const port = docker(['port', id, '9090/tcp']).split(':').at(-1)!
  for (let i = 0; i < 40; i++) {
    if ((await fetch(`http://127.0.0.1:${port}/-/ready`).catch(() => null))?.ok)
      break
    await new Promise((r) => setTimeout(r, 250))
  }
  const loaded = await fetch(`http://127.0.0.1:${port}/api/v1/rules`).then(
    (r) => r.json() as Promise<any>,
  )
  assert.equal(loaded.status, 'success')
  assert.equal(loaded.data.groups[0].rules.length, 4)
  await waitAlerts(port, [])
  values = {
    burn5: 20,
    burn1h: 20,
    burn30: 8,
    burn6h: 8,
    restore: 0,
    regionRpo: 300001,
    regionRto: 1800001,
  }
  const firing = await waitAlerts(port, [
    'ApiAvailabilityFastBurn',
    'ApiAvailabilityMediumBurn',
    'RestoreOrBackupFailed',
    'RegionFailoverBudgetExceeded',
  ])
  values = {
    burn5: 0,
    burn1h: 0,
    burn30: 0,
    burn6h: 0,
    restore: 1,
    regionRpo: 0,
    regionRto: 0,
  }
  const recovered = await waitAlerts(port, [])
  console.log(
    JSON.stringify({
      gate: 'wp27:alerts',
      accepted: true,
      prometheus: image,
      rulesLoaded: 4,
      realScrapeTarget: true,
      failureInjection: firing,
      recoveryState: recovered.length ? 'firing' : 'inactive',
      restoreAlertTriggered: true,
      regionBudgetAlertTriggered: true,
      externalPagingDelivery: 'not-run-no-credential',
    }),
  )
} finally {
  await new Promise<void>((resolve) => metrics.close(() => resolve()))
  docker(['rm', '-f', id], true)
  await rm(dir, { recursive: true, force: true })
  assert.equal(
    docker(
      ['ps', '-a', '--filter', `name=${id}`, '--format', '{{.Names}}'],
      true,
    ),
    '',
  )
}
