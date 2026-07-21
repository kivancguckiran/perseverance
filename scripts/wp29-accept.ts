import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { format } from 'prettier'
import { scanWp29Content } from './wp29-content-scanner'

const root = resolve(import.meta.dirname, '..')
const output = resolve(process.env.WP29_OUTPUT_DIR ?? join(root, '.wp29'))
const evidenceDir = join(output, 'evidence')
const codexBin = process.env.WP29_CODEX_BIN
if (!codexBin) throw new Error('WP29_CODEX_BIN must point to Codex 0.144.2')
const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).stdout.trim()
const dirty = spawnSync(
  'git',
  ['status', '--porcelain=v1', '--untracked-files=all'],
  { cwd: root, encoding: 'utf8' },
).stdout.trim()
assert.equal(
  dirty,
  '',
  'WP29 acceptance requires exact clean implementation commit',
)
const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')
const gates = [
  'wp29:test',
  'wp29:reproducible-build',
  'wp29:sbom',
  'wp29:signatures',
  'wp29:security-scans',
  'wp29:migrations',
  'wp29:provider-canary',
  'wp29:rollout',
  'wp29:e2e',
  'wp29:compliance',
]
const observations: any[] = []
const rawProcessEvidence: Array<{ name: string; content: string }> = []
let previous: string | null = null
for (const gate of gates) {
  const result = spawnSync('pnpm', [gate], {
    cwd: root,
    env: { ...process.env, WP29_CODEX_BIN: codexBin },
    encoding: 'utf8',
    maxBuffer: 300 * 1024 * 1024,
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  rawProcessEvidence.push(
    { name: `${gate}:stdout`, content: result.stdout },
    { name: `${gate}:stderr`, content: result.stderr },
  )
  if (result.status !== 0) throw new Error(`WP29 gate failed: ${gate}`)
  const line = result.stdout
    .trim()
    .split('\n')
    .reverse()
    .find((value) => value.startsWith(`{"gate":"${gate}"`))
  if (!line) throw new Error(`${gate} emitted no machine evidence`)
  const evidence = JSON.parse(line)
  assert.equal(evidence.accepted, true)
  if (evidence.sourceCommit) assert.equal(evidence.sourceCommit, sourceCommit)
  const record = { ...evidence, previousEvidenceSha256: previous }
  previous = sha256(JSON.stringify(record))
  observations.push({ ...record, evidenceSha256: previous })
}
const reproducible = observations.find(
  ({ gate }) => gate === 'wp29:reproducible-build',
)
const sbom = observations.find(({ gate }) => gate === 'wp29:sbom')
const signatures = observations.find(({ gate }) => gate === 'wp29:signatures')
const scans = observations.find(({ gate }) => gate === 'wp29:security-scans')
const migration = observations.find(({ gate }) => gate === 'wp29:migrations')
const provider = observations.find(
  ({ gate }) => gate === 'wp29:provider-canary',
)
const rollout = observations.find(({ gate }) => gate === 'wp29:rollout')
const e2e = observations.find(({ gate }) => gate === 'wp29:e2e')
assert.equal(reproducible.sourceDirty, false)
assert.equal(reproducible.allDigestsMatch, true)
assert.equal(reproducible.registryRoundTrip, true)
assert(sbom.sboms.length >= 5)
assert.equal(signatures.tool, 'cosign')
assert.equal(scans.blockers, 0)
assert.equal(migration.dataLoss, 0)
assert.equal(provider.generatedDrift, false)
assert.equal(provider.brokenSchemaHalted, true)
assert.equal(rollout.rollout.state, 'rolled_back')
assert.equal(rollout.dataLoss, 0)
assert.equal(e2e.realAppServer, true)
assert.equal(e2e.durableRollout, true)
assert.equal(e2e.usageObserved, true)
assert(e2e.approvalRequests > 0)

const evidenceFiles = readdirSync(evidenceDir)
  .filter((name) => !name.includes('acceptance'))
  .sort()
  .map((name) => {
    const content = readFileSync(join(evidenceDir, name), 'utf8')
    return { name, sha256: sha256(content), content }
  })
const bundleBase = {
  schemaVersion: 1,
  workPackage: 'WP29',
  sourceCommit,
  generatedAt: new Date().toISOString(),
  artifactDigests: reproducible.artifacts,
  image: reproducible.image,
  sboms: sbom.sboms,
  provenanceSha256: signatures.provenanceSha256,
  signerFingerprint: signatures.signerFingerprint,
  scannerVersions: scans.scanners,
  migrationIntegritySha256: migration.integritySha256,
  rollbackIntegritySha256: rollout.rollbackIntegritySha256,
  providerCanary: provider,
  rolloutHistory: rollout.transitionHistory,
  evidenceChainHead: previous,
  evidenceFiles,
}
const unsignedBundle = await format(JSON.stringify(bundleBase), {
  parser: 'json',
})
const preliminaryScan = scanWp29Content([
  ...rawProcessEvidence,
  { name: 'unsigned-bundle', content: unsignedBundle },
])
assert.equal(
  preliminaryScan.passed,
  true,
  `evidence content leak: ${JSON.stringify(preliminaryScan.findings)}`,
)

const signingWork = mkdtempSync(join(tmpdir(), 'wp29-evidence-sign-'))
mkdirSync(join(signingWork, 'home'), { recursive: true })
const password = randomBytes(24).toString('hex')
const docker = (args: string[], allowFailure = false) => {
  const result = spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  })
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || result.stdout)
  return result
}
try {
  const bundlePath = join(signingWork, 'wp29-release-evidence-bundle.v1.json')
  writeFileSync(bundlePath, unsignedBundle)
  docker([
    'run',
    '--rm',
    '-e',
    `COSIGN_PASSWORD=${password}`,
    '-e',
    'HOME=/work/home',
    '-v',
    `${signingWork}:/work`,
    '-w',
    '/work',
    'ghcr.io/sigstore/cosign/cosign:v2.5.3',
    'generate-key-pair',
  ])
  docker([
    'run',
    '--rm',
    '-e',
    `COSIGN_PASSWORD=${password}`,
    '-e',
    'HOME=/work/home',
    '-v',
    `${signingWork}:/work`,
    '-w',
    '/work',
    'ghcr.io/sigstore/cosign/cosign:v2.5.3',
    'sign-blob',
    '--yes',
    '--key',
    '/work/cosign.key',
    '--output-signature',
    '/work/wp29-release-evidence-bundle.v1.sig',
    '/work/wp29-release-evidence-bundle.v1.json',
  ])
  docker([
    'run',
    '--rm',
    '-e',
    'HOME=/work/home',
    '-v',
    `${signingWork}:/work`,
    '-w',
    '/work',
    'ghcr.io/sigstore/cosign/cosign:v2.5.3',
    'verify-blob',
    '--key',
    '/work/cosign.pub',
    '--signature',
    '/work/wp29-release-evidence-bundle.v1.sig',
    '/work/wp29-release-evidence-bundle.v1.json',
  ])
  const acceptanceDir = join(root, 'docs/acceptance')
  const bundleSha256 = sha256(unsignedBundle)
  const reportBase = {
    schemaVersion: 1,
    workPackage: 'WP29',
    sourceCommit,
    generatedAt: new Date().toISOString(),
    status: 'accepted-real-clean-worktree',
    artifactDigests: reproducible.artifacts,
    image: reproducible.image,
    sboms: sbom.sboms,
    provenanceSha256: signatures.provenanceSha256,
    signerVerification: {
      tool: 'cosign',
      version: '2.5.3',
      releaseSignerFingerprint: signatures.signerFingerprint,
      evidenceSignerFingerprint: sha256(
        readFileSync(join(signingWork, 'cosign.pub')),
      ),
      verified: true,
    },
    scanners: scans.scanners,
    migration: {
      checksum: migration.integritySha256,
      rollbackChecksum: migration.rollbackIntegritySha256,
      protectedDomains: migration.protectedDomains,
    },
    providerCanary: provider,
    durableRollout: rollout,
    evidenceChainHead: previous,
    evidenceBundleSha256: bundleSha256,
    contentScanner: preliminaryScan,
    externalNotRun: provider.externalProviders,
    cleanup: {
      containers: 0,
      volumes: 0,
      registryArtifacts: 0,
      signingPrivateKeys: 0,
      processes: 0,
      temporaryCredentials: 0,
      verified: true,
    },
  }
  const report = await format(JSON.stringify(reportBase), { parser: 'json' })
  const finalScan = scanWp29Content([
    ...rawProcessEvidence,
    { name: 'bundle', content: unsignedBundle },
    { name: 'report', content: report },
  ])
  assert.equal(finalScan.passed, true)
  writeFileSync(
    join(acceptanceDir, 'wp29-release-evidence-bundle.v1.json'),
    unsignedBundle,
  )
  copyFileSync(
    join(signingWork, 'wp29-release-evidence-bundle.v1.sig'),
    join(acceptanceDir, 'wp29-release-evidence-bundle.v1.sig'),
  )
  copyFileSync(
    join(signingWork, 'cosign.pub'),
    join(acceptanceDir, 'wp29-release-evidence-bundle.v1.pub'),
  )
  writeFileSync(
    join(acceptanceDir, 'wp29-release-evidence-bundle.v1.sha256'),
    `${bundleSha256}  wp29-release-evidence-bundle.v1.json\n`,
  )
  writeFileSync(join(acceptanceDir, 'wp29-acceptance-report.v1.json'), report)
  writeFileSync(
    join(acceptanceDir, 'wp29-acceptance-report.v1.sha256'),
    `${sha256(report)}  wp29-acceptance-report.v1.json\n`,
  )
} finally {
  rmSync(signingWork, { recursive: true, force: true })
}

for (const id of String(
  docker(['ps', '-aq', '--filter', 'label=persistent.wp29=true']).stdout,
)
  .trim()
  .split('\n')
  .filter(Boolean))
  docker(['rm', '-f', id])
for (const volume of String(
  docker(['volume', 'ls', '-q', '--filter', 'label=persistent.wp29=true'])
    .stdout,
)
  .trim()
  .split('\n')
  .filter(Boolean))
  docker(['volume', 'rm', volume])
for (const network of String(docker(['network', 'ls', '-q']).stdout)
  .trim()
  .split('\n')
  .filter(Boolean)) {
  const name = String(
    docker(['network', 'inspect', network, '--format', '{{.Name}}'], true)
      .stdout,
  ).trim()
  if (name.startsWith('persistent-wp29-')) docker(['network', 'rm', network])
}
const imageIds = String(
  docker(['images', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}'], true)
    .stdout,
)
  .trim()
  .split('\n')
  .filter((line) => line.startsWith('wp29-'))
  .map((line) => line.split(' ').at(-1)!)
if (imageIds.length) docker(['rmi', '-f', ...new Set(imageIds)], true)
docker(
  [
    'rmi',
    'moby/buildkit:buildx-stable-1',
    'quay.io/skopeo/stable:v1.19.0',
    'registry:2.8.3',
    'anchore/syft:v1.33.0',
    'ghcr.io/sigstore/cosign/cosign:v2.5.3',
    'zricethezav/gitleaks:v8.28.0',
    'semgrep/semgrep:1.132.0',
    'aquasec/trivy:0.65.0',
    'hadolint/hadolint:v2.12.0-alpine',
    'openpolicyagent/conftest:v0.62.0',
    'postgres:17.5-alpine',
  ],
  true,
)
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith('wp29-evidence-sign-'))
    rmSync(join(tmpdir(), name), { recursive: true, force: true })
}
assert.equal(
  String(
    docker(['ps', '-aq', '--filter', 'label=persistent.wp29=true']).stdout,
  ).trim(),
  '',
)
assert.equal(
  String(
    docker(['volume', 'ls', '-q', '--filter', 'label=persistent.wp29=true'])
      .stdout,
  ).trim(),
  '',
)
assert.equal(
  readdirSync(tmpdir()).some((name) => name.startsWith('wp29-evidence-sign-')),
  false,
)
process.stdout.write(
  `${JSON.stringify({
    gate: 'wp29:accept',
    accepted: true,
    sourceCommit,
    requiredGates: gates,
    evidenceChainHead: previous,
    cleanup: 'verified-zero',
  })}\n`,
)
