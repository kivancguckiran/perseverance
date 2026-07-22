import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  failNotRun,
  machineEvidence,
  redactWp30Evidence,
  scanWp30Evidence,
} from './wp30-evidence'

const gate = 'wp30:load-soak'
const root = resolve(import.meta.dirname, '..')
const output = resolve(process.env.WP30_OUTPUT_DIR ?? join(root, '.wp30'))
const raw = join(output, 'evidence', 'raw', 'load-soak')
const redacted = join(output, 'evidence', 'redacted', 'load-soak')
const required = [
  'WP30_TARGET_URL',
  'WP30_REALTIME_URL',
  'WP30_TENANT_A_TOKEN',
  'WP30_TENANT_A_ID',
  'WP30_TENANT_A_ORG_ID',
  'WP30_TENANT_A_WORKSPACE_ID',
  'WP30_TENANT_B_TOKEN',
  'WP30_TENANT_B_ID',
  'WP30_TENANT_B_ORG_ID',
  'WP30_TENANT_B_WORKSPACE_ID',
  'WP30_LOAD_DURATION',
  'WP30_SOAK_DURATION',
  'WP30_K6_IMAGE',
] as const
const missing = required.filter((name) => !process.env[name])
if (missing.length) failNotRun(gate, missing)
assert.match(process.env.WP30_LOAD_DURATION!, /^(?:[1-9]\d*)[mh]$/)
assert.match(process.env.WP30_SOAK_DURATION!, /^(?:[1-9]\d*)h$/)
assert(
  Number(process.env.WP30_SOAK_DURATION!.slice(0, -1)) >= 2,
  'production soak must run for at least 2h',
)

mkdirSync(raw, { recursive: true })
mkdirSync(redacted, { recursive: true })
const target = new URL(process.env.WP30_TARGET_URL!)
assert(!target.username && !target.password)
const metricsText = async () => {
  const response = await fetch(`${target.origin}/metrics`, {
    headers: { Authorization: `Bearer ${process.env.WP30_TENANT_A_TOKEN}` },
  })
  assert.equal(response.status, 200, 'production metrics endpoint unavailable')
  return response.text()
}
const metric = (source: string, name: string) => {
  const match = new RegExp(
    `^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`,
    'm',
  ).exec(source)
  return match ? Number(match[1]) : null
}
const before = await metricsText()
const envNames = required.filter(
  (name) => name !== 'WP30_TENANT_A_TOKEN' && name !== 'WP30_TENANT_B_TOKEN',
)
const dockerArgs = [
  'run',
  '--rm',
  '--label',
  'persistent.wp30=true',
  '-v',
  `${join(root, 'infra/performance')}:/scripts:ro`,
  '-v',
  `${raw}:/evidence:rw`,
  ...envNames.flatMap((name) => ['-e', name]),
  '-e',
  'WP30_TENANT_A_TOKEN',
  '-e',
  'WP30_TENANT_B_TOKEN',
  process.env.WP30_K6_IMAGE!,
  'run',
  '--summary-export',
  '/evidence/k6-raw-summary.json',
  '/scripts/wp30-production.js',
]
const run = spawnSync('docker', dockerArgs, {
  cwd: root,
  env: process.env,
  encoding: 'utf8',
  maxBuffer: 200 * 1024 * 1024,
})
writeFileSync(
  join(raw, 'k6-process.json'),
  JSON.stringify({
    tool: 'k6',
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
  }),
)
if (run.status !== 0) throw new Error('k6 threshold or execution failure')
const after = await metricsText()
const summary = JSON.parse(readFileSync(join(raw, 'k6-summary.json'), 'utf8'))
const rawSummary = JSON.parse(
  readFileSync(join(raw, 'k6-raw-summary.json'), 'utf8'),
)
const fairness = Number(summary.tenantFairnessRatio)
assert(fairness >= Number(process.env.WP30_MIN_TENANT_FAIRNESS ?? 0.9))
const backlogValue = rawSummary.metrics?.wp30_backlog?.value ?? 0
assert.equal(backlogValue, 0)
const rssBefore = metric(before, 'process_resident_memory_bytes')
const rssAfter = metric(after, 'process_resident_memory_bytes')
assert(rssBefore !== null && rssAfter !== null, 'RSS metrics unavailable')
const rssGrowth = rssAfter - rssBefore
const maxRssGrowth = Number(
  process.env.WP30_MAX_RSS_GROWTH_BYTES ?? 64 * 1024 * 1024,
)
assert(
  rssGrowth <= maxRssGrowth,
  `RSS growth ${rssGrowth} exceeds ${maxRssGrowth}`,
)

const files = ['k6-summary.json', 'k6-raw-summary.json', 'k6-process.json'].map(
  (name) => {
    const content = readFileSync(join(raw, name), 'utf8')
    const safe = redactWp30Evidence(content)
    writeFileSync(join(redacted, name), safe)
    return {
      name,
      rawSha256: createHash('sha256').update(content).digest('hex'),
      redactedSha256: createHash('sha256').update(safe).digest('hex'),
      content: safe,
    }
  },
)
const scan = scanWp30Evidence(files)
assert.equal(scan.passed, true, JSON.stringify(scan.findings))
machineEvidence(gate, {
  accepted: true,
  status: 'passed',
  tool: 'Grafana k6',
  loadDuration: process.env.WP30_LOAD_DURATION,
  soakDuration: process.env.WP30_SOAK_DURATION,
  targetRate: Number(process.env.WP30_TARGET_RATE ?? 50),
  tenantFairnessRatio: fairness,
  rssBefore,
  rssAfter,
  rssGrowthBytes: rssGrowth,
  backlog: backlogValue,
  thresholdsPassed: true,
  evidenceFiles: files.map(({ content: _content, ...file }) => file),
  contentScanner: scan,
})
