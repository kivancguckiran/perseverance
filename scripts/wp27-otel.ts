import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  OtlpHttpExporter,
  ProductionTelemetry,
  createTrace,
} from '../packages/production-observability/src/index'

const name = `persistent-wp27-otel-${randomUUID()}`
const image =
  process.env.WP27_OTEL_IMAGE ?? 'otel/opentelemetry-collector-contrib:0.130.1'
const config = `${process.cwd()}/infra/observability/otel-collector.v1.yaml`
const docker = (args: string[], allowFailure = false) => {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
try {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '-v',
    `${config}:/etc/otelcol/config.yaml:ro`,
    '-p',
    '127.0.0.1::4318',
    '-p',
    '127.0.0.1::9464',
    '-p',
    '127.0.0.1::13133',
    image,
    '--config=/etc/otelcol/config.yaml',
  ])
  const port = (containerPort: string) =>
    docker(['port', name, containerPort]).split(':').at(-1)!
  const healthUrl = `http://127.0.0.1:${port('13133/tcp')}`
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await fetch(healthUrl).catch(() => null))?.ok) break
    if (attempt === 119) throw new Error('OTEL_COLLECTOR_NOT_READY')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const endpoint = `http://127.0.0.1:${port('4318/tcp')}`
  const telemetry = new ProductionTelemetry()
  const parent = createTrace()
  const span = telemetry.startSpan('backup.create', {
    parent,
    attributes: { 'service.name': 'wp27-harness', outcome: 'success' },
  })
  telemetry.recordMetric('backup_success', 1, {
    context: span.context,
    attributes: { outcome: 'success' },
  })
  telemetry.log('info', 'BACKUP_CREATED', { context: span.context })
  span.end()
  assert.equal(await new OtlpHttpExporter(telemetry, endpoint).flush(), 3)
  let prometheus = ''
  for (let attempt = 0; attempt < 40; attempt++) {
    const scrape = await fetch(
      `http://127.0.0.1:${port('9464/tcp')}/metrics`,
    ).catch(() => null)
    if (scrape?.ok) prometheus = await scrape.text()
    if (prometheus.includes('persistent_codex_backup_success')) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.match(prometheus, /persistent_codex_backup_success/)
  const logs = docker(['logs', name])
  assert(!/(prompt|bearer|api[_-]?key|authorization)=/i.test(logs))
  console.log(
    JSON.stringify({
      gate: 'wp27:otel',
      accepted: true,
      collector: image,
      otlpHttp: true,
      metricExport: true,
      traceLogMetricCorrelation: parent.traceId,
      productionExporter: true,
      leakedMarkers: 0,
    }),
  )
} finally {
  docker(['rm', '-f', name], true)
  assert.equal(
    docker(
      ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}'],
      true,
    ),
    '',
  )
}
