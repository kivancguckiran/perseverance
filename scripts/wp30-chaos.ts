import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  failNotRun,
  machineEvidence,
  redactWp30Evidence,
  scanWp30Evidence,
} from './wp30-evidence'

const gate = 'wp30:chaos'
const required = [
  'WP30_CHAOS_APPROVED',
  'WP30_CHAOS_ATTESTATION_PATH',
  'WP30_CHAOS_ATTESTATION_SIGNATURE_PATH',
  'WP30_CHAOS_ASSESSOR_PUBLIC_KEY_PATH',
] as const
const missing = required.filter((name) => !process.env[name])
if (missing.length) failNotRun(gate, missing)
assert.equal(process.env.WP30_CHAOS_APPROVED, 'approved')
const root = resolve(import.meta.dirname, '..')

const runGate = (command: string) => {
  const run = spawnSync('pnpm', [command], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  })
  process.stdout.write(run.stdout)
  process.stderr.write(run.stderr)
  assert.equal(run.status, 0, `${command} failed`)
  const line = run.stdout
    .trim()
    .split('\n')
    .reverse()
    .find((value) => value.startsWith('{'))
  assert(line, `${command} emitted no evidence`)
  return {
    command,
    stdout: run.stdout,
    stderr: run.stderr,
    evidence: JSON.parse(line),
  }
}

const ha = runGate('wp26:ha')
const gameDay = runGate('wp27:game-day')
assert.equal(ha.evidence.productionHaEvidence, true)
assert.equal(gameDay.evidence.accepted, true)
assert(
  gameDay.evidence.scenarios.some(
    (item: any) => item.scenario === 'active-passive-region-failover',
  ),
)

const attestationBytes = readFileSync(process.env.WP30_CHAOS_ATTESTATION_PATH!)
const signature = readFileSync(
  process.env.WP30_CHAOS_ATTESTATION_SIGNATURE_PATH!,
)
const publicKey = readFileSync(process.env.WP30_CHAOS_ASSESSOR_PUBLIC_KEY_PATH!)
assert(verify(null, attestationBytes, createPublicKey(publicKey), signature))
const attestation = JSON.parse(attestationBytes.toString('utf8'))
assert.equal(attestation.schemaVersion, 1)
assert.equal(attestation.independent, true)
const requiredScenarios = [
  'api',
  'worker',
  'node',
  'region',
  'broker',
  'cache',
  'postgres_replica',
  'provider',
  'kms',
  'push',
  'billing',
]
for (const scenario of requiredScenarios) {
  const observed = attestation.scenarios.find(
    (value: any) => value.component === scenario,
  )
  assert(observed, `missing chaos scenario ${scenario}`)
  assert(['process', 'container'].includes(observed.injection))
  assert.equal(observed.tenantMixing, 0)
  assert.equal(observed.uncontrolledDuplicates, 0)
  assert.equal(observed.fenceViolations, 0)
  assert.equal(observed.recovered, true)
}
const output = resolve(process.env.WP30_OUTPUT_DIR ?? join(root, '.wp30'))
const rawDirectory = join(output, 'evidence', 'raw', 'chaos')
const redactedDirectory = join(output, 'evidence', 'redacted', 'chaos')
mkdirSync(rawDirectory, { recursive: true })
mkdirSync(redactedDirectory, { recursive: true })
writeFileSync(
  join(rawDirectory, 'independent-chaos-attestation.json'),
  attestationBytes,
)
writeFileSync(
  join(redactedDirectory, 'independent-chaos-attestation.json'),
  redactWp30Evidence(attestationBytes.toString('utf8')),
)
const contentScanner = scanWp30Evidence([
  { name: 'wp26-ha-stdout', content: ha.stdout },
  { name: 'wp26-ha-stderr', content: ha.stderr },
  { name: 'wp27-game-day-stdout', content: gameDay.stdout },
  { name: 'wp27-game-day-stderr', content: gameDay.stderr },
  { name: 'chaos-attestation', content: attestationBytes.toString('utf8') },
])
assert.equal(
  contentScanner.passed,
  true,
  JSON.stringify(contentScanner.findings),
)
machineEvidence(gate, {
  accepted: true,
  status: 'passed',
  realProcessAndContainerInjection: true,
  scenarios: requiredScenarios,
  tenantMixing: 0,
  uncontrolledDuplicates: 0,
  fenceViolations: 0,
  localEvidence: [ha.evidence, gameDay.evidence],
  independentAttestationSha256: createHash('sha256')
    .update(attestationBytes)
    .digest('hex'),
  assessorPublicKeySha256: createHash('sha256').update(publicKey).digest('hex'),
  contentScanner,
})
