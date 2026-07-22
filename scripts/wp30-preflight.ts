import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { resolve } from 'node:path'
import { failNotRun, machineEvidence } from './wp30-evidence'

const gate = 'wp30:preflight'
const requiredEnvironment = [
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
  'WP30_FOREIGN_SESSION_ID',
  'WP30_OBJECT_ID',
  'WP30_SECURITY_AUTHORIZATION',
  'WP30_PENTEST_ATTESTATION_PATH',
  'WP30_PENTEST_ATTESTATION_SIGNATURE_PATH',
  'WP30_PENTEST_ASSESSOR_PUBLIC_KEY_PATH',
  'WP30_LOAD_DURATION',
  'WP30_SOAK_DURATION',
  'WP30_CHAOS_APPROVED',
  'WP30_CHAOS_ATTESTATION_PATH',
  'WP30_CHAOS_ATTESTATION_SIGNATURE_PATH',
  'WP30_CHAOS_ASSESSOR_PUBLIC_KEY_PATH',
  'WP30_INCIDENT_ATTESTATION_PATH',
  'WP30_INCIDENT_ATTESTATION_SIGNATURE_PATH',
  'WP30_INCIDENT_ASSESSOR_PUBLIC_KEY_PATH',
  'WP30_RESOURCE_INVENTORY_ATTESTATION_PATH',
  'WP30_RESOURCE_INVENTORY_SIGNATURE_PATH',
  'WP30_RESOURCE_INVENTORY_PUBLIC_KEY_PATH',
  'WP30_ROLLOUT_DATABASE_URL',
  'WP30_ROLLOUT_APPROVED',
  'WP30_ROLLOUT_RUNTIME_ROLE',
  'WP30_COHORT_TENANT_ID',
  'WP30_COHORT_ORGANIZATION_ID',
  'WP30_COHORT_WORKSPACE_ID',
  'WP30_ROLLOUT_ID',
  'WP30_CANDIDATE_ARTIFACT_SHA256',
  'WP30_PREVIOUS_ARTIFACT_SHA256',
  'WP30_GO_NO_GO_OWNER',
  'WP30_GO_NO_GO_RECORD_ID',
  'WP30_PRODUCTION_GOLDEN_URL',
  'WP30_BROWSER_SESSION',
  'WP30_GOLDEN_READY_SELECTOR',
  'WP30_GOLDEN_APPROVAL_SELECTOR',
  'WP30_GOLDEN_APPROVAL_BUTTON',
  'WP30_GOLDEN_RESOLVED_SELECTOR',
  'WP30_CODEX_BIN',
  'WP30_ZAP_IMAGE',
  'WP30_NUCLEI_IMAGE',
  'WP30_K6_IMAGE',
] as const
const missing = requiredEnvironment.filter((name) => !process.env[name])
for (const pathName of requiredEnvironment.filter(
  (name) => name.endsWith('_PATH') || name === 'WP30_CODEX_BIN',
)) {
  const path = process.env[pathName]
  if (!path) continue
  try {
    accessSync(resolve(path), constants.R_OK)
  } catch {
    missing.push(`${pathName}:unreadable` as any)
  }
}
for (const command of ['docker', 'agent-browser', 'git', 'pnpm']) {
  const check = spawnSync(command, ['--version'], { encoding: 'utf8' })
  if (check.status !== 0) missing.push(`command:${command}` as any)
}
const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
  encoding: 'utf8',
})
if (docker.status !== 0) missing.push('docker:daemon-unavailable' as any)
const status = spawnSync(
  'git',
  ['status', '--porcelain=v1', '--untracked-files=all'],
  { encoding: 'utf8' },
)
if (status.stdout.trim()) missing.push('git:dirty-worktree' as any)
if (missing.length) failNotRun(gate, missing)
const codex = spawnSync(process.env.WP30_CODEX_BIN!, ['--version'], {
  encoding: 'utf8',
})
if (codex.status !== 0 || !/0\.144\.2/.test(codex.stdout))
  failNotRun(gate, ['WP30_CODEX_BIN:not-0.144.2'])
for (const name of [
  'WP30_ZAP_IMAGE',
  'WP30_NUCLEI_IMAGE',
  'WP30_K6_IMAGE',
] as const) {
  const image = process.env[name]!
  if (
    /:(?:latest|stable)$/.test(image) ||
    !(
      /@sha256:[a-f0-9]{64}$/.test(image) ||
      /:v?\d+\.\d+\.\d+(?:[-.][a-z0-9.-]+)?$/i.test(image)
    )
  )
    failNotRun(gate, [`${name}:must-be-version-or-digest-pinned`])
}
const target = await fetch(new URL('/readyz', process.env.WP30_TARGET_URL), {
  headers: { Authorization: `Bearer ${process.env.WP30_TENANT_A_TOKEN}` },
}).catch(() => null)
if (!target || target.status !== 200)
  failNotRun(gate, ['production-target:not-ready'])
machineEvidence(gate, {
  accepted: true,
  status: 'passed',
  cleanImplementationCommit: true,
  dockerDaemon: docker.stdout.trim(),
  codexVersion: '0.144.2',
  productionTargetReady: true,
  requiredInputsPresent: requiredEnvironment.length,
  secretValuesRecorded: false,
})
