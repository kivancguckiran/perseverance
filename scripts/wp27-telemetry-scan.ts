import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ProductionTelemetry } from '../packages/production-observability/src/index'

const markers = [
  'WP27_SECRET_MARKER_7f91',
  'WP27_PROMPT_MARKER_42e1',
  'WP27_OUTPUT_MARKER_91ba',
  'WP27_PII_MARKER_person@example.invalid',
  'WP27_CORPUS_MARKER_a81d',
]
const telemetry = new ProductionTelemetry()
for (const marker of markers) {
  assert.throws(
    () =>
      telemetry.startSpan('api.request', { attributes: { content: marker } }),
    /FORBIDDEN/,
  )
}
const safe = telemetry.startSpan('unknown.event', {
  attributes: { 'event.type': 'codex.unknown', outcome: 'rejected-content' },
})
telemetry.log('warn', 'UNKNOWN_EVENT_PRESERVED', {
  context: safe.context,
  attributes: { 'event.type': 'codex.unknown' },
})
safe.end()
const outputs = [
  JSON.stringify(telemetry.snapshot()),
  readFileSync(
    'infra/observability/dashboards/wp27-dashboards.v1.json',
    'utf8',
  ),
  readFileSync('infra/observability/alerts.v1.yml', 'utf8'),
  readFileSync('infra/observability/slo-targets.v1.json', 'utf8'),
  readFileSync('infra/observability/otel-collector.v1.yaml', 'utf8'),
  readFileSync('docs/acceptance/wp27-acceptance-report.v1.json', 'utf8'),
  readFileSync('docs/acceptance/wp27-acceptance-report.v1.sha256', 'utf8'),
]
for (const output of outputs)
  for (const marker of markers)
    assert(!output.includes(marker), `TELEMETRY_LEAK:${marker}`)
assert(
  !JSON.stringify(telemetry.snapshot()).match(
    /tenant-a|workspace-a|Bearer|sk-/,
  ),
)
console.log(
  JSON.stringify({
    gate: 'wp27:telemetry-scan',
    accepted: true,
    fixtureClasses: ['secret', 'prompt', 'output', 'pii', 'corpus'],
    scannedSurfaces: [
      'trace',
      'metric',
      'log',
      'dashboard-label',
      'alert',
      'slo',
      'collector',
      'acceptance-evidence',
    ],
    markerCount: markers.length,
    matches: 0,
    failClosed: true,
  }),
)
