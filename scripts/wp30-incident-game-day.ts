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

const gate = 'wp30:incident-game-day'
const required = [
  'WP30_INCIDENT_ATTESTATION_PATH',
  'WP30_INCIDENT_ATTESTATION_SIGNATURE_PATH',
  'WP30_INCIDENT_ASSESSOR_PUBLIC_KEY_PATH',
] as const
const missing = required.filter((name) => !process.env[name])
if (missing.length) failNotRun(gate, missing)
const root = resolve(import.meta.dirname, '..')
const run = spawnSync(
  'node',
  ['--import', 'tsx', 'scripts/wp20-control-plane-postgres-integration.ts'],
  {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  },
)
process.stdout.write(run.stdout)
process.stderr.write(run.stderr)
assert.equal(run.status, 0, 'durable break-glass integration failed')
const integrationLine = run.stdout
  .trim()
  .split('\n')
  .reverse()
  .find((line) => line.startsWith('{'))
assert(integrationLine, 'break-glass integration emitted no evidence')
const integration = JSON.parse(integrationLine)
assert.equal(integration.status, 'passed')
assert.equal(integration.auditChain, 'preserved')
assert.equal(integration.breakGlass, 'api-activated')

const attestationBytes = readFileSync(
  process.env.WP30_INCIDENT_ATTESTATION_PATH!,
)
const signature = readFileSync(
  process.env.WP30_INCIDENT_ATTESTATION_SIGNATURE_PATH!,
)
const publicKey = readFileSync(
  process.env.WP30_INCIDENT_ASSESSOR_PUBLIC_KEY_PATH!,
)
assert(verify(null, attestationBytes, createPublicKey(publicKey), signature))
const attestation = JSON.parse(attestationBytes.toString('utf8'))
assert.equal(attestation.schemaVersion, 1)
assert.equal(attestation.independent, true)
assert.equal(attestation.notificationDelivered, true)
assert.equal(attestation.immutableAuditVerified, true)
assert.equal(attestation.accessRevoked, true)
assert.equal(attestation.postmortemRecorded, true)
assert(Number(attestation.onCallAcknowledgeMs) > 0)
assert(Number(attestation.breakGlassAccessMs) > 0)
assert(Number(attestation.revocationMs) > 0)
const output = resolve(process.env.WP30_OUTPUT_DIR ?? join(root, '.wp30'))
const rawDirectory = join(output, 'evidence', 'raw', 'incident')
const redactedDirectory = join(output, 'evidence', 'redacted', 'incident')
mkdirSync(rawDirectory, { recursive: true })
mkdirSync(redactedDirectory, { recursive: true })
writeFileSync(
  join(rawDirectory, 'independent-incident-attestation.json'),
  attestationBytes,
)
writeFileSync(
  join(redactedDirectory, 'independent-incident-attestation.json'),
  redactWp30Evidence(attestationBytes.toString('utf8')),
)
const contentScanner = scanWp30Evidence([
  { name: 'break-glass-stdout', content: run.stdout },
  { name: 'break-glass-stderr', content: run.stderr },
  { name: 'incident-attestation', content: attestationBytes.toString('utf8') },
])
assert.equal(
  contentScanner.passed,
  true,
  JSON.stringify(contentScanner.findings),
)
machineEvidence(gate, {
  accepted: true,
  status: 'passed',
  durableBreakGlass: integration,
  onCallAcknowledgeMs: attestation.onCallAcknowledgeMs,
  breakGlassAccessMs: attestation.breakGlassAccessMs,
  revocationMs: attestation.revocationMs,
  notificationDelivered: true,
  immutableAuditVerified: true,
  accessRevoked: true,
  postmortemRecorded: true,
  independentAttestationSha256: createHash('sha256')
    .update(attestationBytes)
    .digest('hex'),
  assessorPublicKeySha256: createHash('sha256').update(publicKey).digest('hex'),
  contentScanner,
})
