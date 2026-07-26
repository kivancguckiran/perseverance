import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { machineEvidence, scanWp30Evidence } from './wp30-evidence'
import { stableJson } from './wp31-release-lib'

const gate = 'wp35:external-accept'
const root = resolve(import.meta.dirname, '..')
const output = resolve(process.env.WP35_OUTPUT_DIR ?? join(root, '.wp35'))
const evidenceDir = join(output, 'evidence')
const expectedSourceCommit = '36f41c2bc2c53913fc672eaf1d2dfc12364a7216'
const requiredEnvironment = [
  'WP35_E_APPROVED',
  'WP35_E_TARGET_URL',
  'WP35_E_ATTESTATION_PATH',
  'WP35_E_ATTESTATION_SIGNATURE_PATH',
  'WP35_E_ASSESSOR_PUBLIC_KEY_PATH',
  'WP35_E_ARTIFACT_PATH',
  'WP35_E_ARTIFACT_SIGNATURE_PATH',
  'WP35_E_ARTIFACT_PUBLIC_KEY_PATH',
  'WP35_E_TENANT_A_TOKEN_FILE',
  'WP35_E_TENANT_B_TOKEN_FILE',
  'WP35_E_WP30_ACCEPTANCE_REPORT_PATH',
] as const
const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')
let resultWritten = false

const writeResult = (result: Record<string, unknown>) => {
  mkdirSync(evidenceDir, { recursive: true })
  const path = join(evidenceDir, 'wp35-external-accept.json')
  const content = stableJson({ gate, ...result })
  writeFileSync(path, content)
  resultWritten = true
  machineEvidence(gate, {
    ...result,
    evidence: '.wp35/evidence/wp35-external-accept.json',
    evidenceSha256: sha256(content),
  })
}
const rejectInvalidEvidence = () => {
  if (!resultWritten)
    writeResult({
      accepted: false,
      status: 'failed',
      sourceCommit: expectedSourceCommit,
      reason: 'external-evidence-validation-failed',
      productionEvidence: false,
      decision: 'no-go',
    })
  process.exit(1)
}
process.on('uncaughtException', rejectInvalidEvidence)
process.on('unhandledRejection', rejectInvalidEvidence)

const missing = requiredEnvironment.filter((name) => !process.env[name])
if (missing.length > 0) {
  writeResult({
    accepted: false,
    status: 'not-run',
    sourceCommit: expectedSourceCommit,
    missing: [...missing].sort(),
    wp30ExternalAcceptance: 'required',
    productionEvidence: false,
    decision: 'no-go',
  })
  process.exit(1)
}

assert.equal(process.env.WP35_E_APPROVED, 'approved')
const target = new URL(process.env.WP35_E_TARGET_URL!)
assert.equal(target.protocol, 'https:', 'WP35-E target must use HTTPS')
assert.equal(target.username, '', 'target URL must not contain credentials')
assert.equal(target.password, '', 'target URL must not contain credentials')

const readProtected = (name: string) => {
  const path = resolve(process.env[name]!)
  assert.equal(
    statSync(path).mode & 0o077,
    0,
    `${name} must not be group/world accessible`,
  )
  return readFileSync(path)
}
const attestationBytes = readFileSync(
  resolve(process.env.WP35_E_ATTESTATION_PATH!),
)
const attestationSignature = readFileSync(
  resolve(process.env.WP35_E_ATTESTATION_SIGNATURE_PATH!),
)
const assessorKey = readFileSync(
  resolve(process.env.WP35_E_ASSESSOR_PUBLIC_KEY_PATH!),
)
assert(
  verify(
    null,
    attestationBytes,
    createPublicKey(assessorKey),
    attestationSignature,
  ),
  'independent WP35-E attestation signature is invalid',
)

const artifactBytes = readFileSync(resolve(process.env.WP35_E_ARTIFACT_PATH!))
const artifactSignature = readFileSync(
  resolve(process.env.WP35_E_ARTIFACT_SIGNATURE_PATH!),
)
const artifactKey = readFileSync(
  resolve(process.env.WP35_E_ARTIFACT_PUBLIC_KEY_PATH!),
)
assert(
  verify(null, artifactBytes, createPublicKey(artifactKey), artifactSignature),
  'artifact signature is invalid',
)

type Attestation = {
  schemaVersion: number
  acceptanceClass: string
  independent: boolean
  sourceCommit: string
  artifactSha256: string
  cohort: string
  deployment: Record<string, boolean>
  provider: Record<string, boolean>
  rollout: { stages: string[] }
  mobile: Record<string, boolean>
  billing: {
    hostingAndModelSeparated: boolean
    reconciliationDifferenceMicros: number
    failedTaskSettled: boolean
    interruptedTaskSettled: boolean
  }
  drills: Record<string, boolean>
  lifecycle: Record<string, boolean>
  security: { criticalFindings: number; highFindings: number }
  cleanup: {
    orphanRuntimes: number
    unresolvedReservations: number
    credentialEnvelopes: number
  }
  liveProbes: {
    deploymentMetadataPath: string
    tenantAWorkspacePath: string
    tenantBWorkspacePath: string
  }
  evidenceDigests: Record<string, string>
}
const attestation = JSON.parse(attestationBytes.toString('utf8')) as Attestation
const attestationSchema = JSON.parse(
  readFileSync(
    join(root, 'docs/security/wp35-external-beta-attestation.schema.json'),
    'utf8',
  ),
)
const validateAttestation = new Ajv2020({
  allErrors: true,
  strict: true,
}).compile(attestationSchema)
assert.equal(
  validateAttestation(attestation),
  true,
  'WP35-E attestation does not satisfy its JSON Schema',
)
const assertTrueFields = (
  record: Record<string, boolean>,
  fields: readonly string[],
) => {
  for (const field of fields) assert.equal(record[field], true, field)
}
assert.equal(attestation.schemaVersion, 1)
assert.equal(attestation.acceptanceClass, 'WP35-E')
assert.equal(attestation.independent, true)
assert.equal(attestation.sourceCommit, expectedSourceCommit)
assert.match(attestation.artifactSha256, /^[a-f0-9]{64}$/)
assert.equal(sha256(artifactBytes), attestation.artifactSha256)
assert(attestation.cohort.length > 0)
assertTrueFields(attestation.deployment, [
  'realOidc',
  'productionPostgres',
  'objectStorage',
  'broker',
  'kms',
  'isolatedRuntime',
])
assertTrueFields(attestation.provider, ['allowed', 'realNetwork', 'connected'])
assert.deepEqual(attestation.rollout.stages, [
  'internal',
  'design_partner',
  'limited_beta',
])
assertTrueFields(attestation.mobile, [
  'physicalDevice',
  'pwa',
  'closedClientContinuation',
  'durableReplay',
])
assert.equal(attestation.billing.hostingAndModelSeparated, true)
assert.equal(attestation.billing.reconciliationDifferenceMicros, 0)
assert.equal(attestation.billing.failedTaskSettled, true)
assert.equal(attestation.billing.interruptedTaskSettled, true)
assertTrueFields(attestation.drills, ['capacityHalt', 'incident', 'rollback'])
assertTrueFields(attestation.lifecycle, [
  'tenantExport',
  'tenantDelete',
  'credentialRevoked',
  'cryptoErasure',
])
assert.equal(attestation.security.criticalFindings, 0)
assert.equal(attestation.security.highFindings, 0)
assert.deepEqual(attestation.cleanup, {
  orphanRuntimes: 0,
  unresolvedReservations: 0,
  credentialEnvelopes: 0,
})
const requiredEvidence = [
  'deployment',
  'oidcAuthorization',
  'infrastructure',
  'provider',
  'rollout',
  'mobilePwa',
  'billing',
  'failedInterruptedSettlement',
  'drills',
  'lifecycle',
  'securityPrivacy',
  'cleanup',
]
for (const name of requiredEvidence)
  assert.match(attestation.evidenceDigests[name] ?? '', /^[a-f0-9]{64}$/)

const wp30Bytes = readFileSync(
  resolve(process.env.WP35_E_WP30_ACCEPTANCE_REPORT_PATH!),
)
const wp30 = JSON.parse(wp30Bytes.toString('utf8')) as {
  workPackage?: string
  sourceCommit?: string
  status?: string
  accepted?: boolean
  knownNotRun?: unknown[]
  syntheticEvidenceAccepted?: boolean
}
assert.equal(wp30.workPackage, 'WP30')
assert.equal(wp30.sourceCommit, expectedSourceCommit)
assert.equal(wp30.status, 'accepted-real-production-like')
assert.equal(wp30.accepted, true)
assert.deepEqual(wp30.knownNotRun, [])
assert.equal(wp30.syntheticEvidenceAccepted, false)

const tokenA = readProtected('WP35_E_TENANT_A_TOKEN_FILE')
  .toString('utf8')
  .trim()
const tokenB = readProtected('WP35_E_TENANT_B_TOKEN_FILE')
  .toString('utf8')
  .trim()
assert(tokenA.length >= 20 && tokenB.length >= 20 && tokenA !== tokenB)
const probe = async (path: string, token: string) => {
  assert(path.startsWith('/') && !path.startsWith('//'))
  return fetch(new URL(path, target), {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
  })
}
const metadataResponse = await probe(
  attestation.liveProbes.deploymentMetadataPath,
  tokenA,
)
assert.equal(metadataResponse.status, 200)
const metadata = (await metadataResponse.json()) as {
  sourceCommit?: string
  artifactSha256?: string
}
assert.equal(metadata.sourceCommit, expectedSourceCommit)
assert.equal(metadata.artifactSha256, attestation.artifactSha256)
const ownA = await probe(attestation.liveProbes.tenantAWorkspacePath, tokenA)
const crossA = await probe(attestation.liveProbes.tenantBWorkspacePath, tokenA)
const ownB = await probe(attestation.liveProbes.tenantBWorkspacePath, tokenB)
assert.equal(ownA.status, 200)
assert([403, 404].includes(crossA.status))
assert.equal(ownB.status, 200)

const scanned = scanWp30Evidence([
  { name: 'attestation', content: attestationBytes.toString('utf8') },
  { name: 'wp30-acceptance', content: wp30Bytes.toString('utf8') },
])
assert.equal(scanned.passed, true, 'evidence contains credential-like material')
writeResult({
  accepted: true,
  status: 'passed',
  sourceCommit: expectedSourceCommit,
  artifactSha256: attestation.artifactSha256,
  artifactSignatureVerified: true,
  attestationSha256: sha256(attestationBytes),
  attestationSignatureVerified: true,
  attestationSchemaValidated: true,
  cohort: attestation.cohort,
  evidenceDigests: attestation.evidenceDigests,
  wp30ExternalAcceptance: {
    accepted: true,
    reportSha256: sha256(wp30Bytes),
  },
  liveAuthorization: {
    ownTenantA: ownA.status,
    crossTenantA: crossA.status,
    ownTenantB: ownB.status,
  },
  cleanup: attestation.cleanup,
  productionEvidence: true,
  decision: 'go',
})
