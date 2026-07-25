import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { machineEvidence } from './wp30-evidence'
import { stableJson } from './wp31-release-lib'
import { summarizeWp35Gates, type Wp35GateResult } from './wp35-lib'

const gate = 'wp35:accept'
const root = resolve(import.meta.dirname, '..')
const evidenceDir = join(
  resolve(process.env.WP35_OUTPUT_DIR ?? join(root, '.wp35')),
  'evidence',
)
const gates = [
  ['wp35:test', 'scripts/wp35-gate.ts', 'wp35:test'],
  ['wp35:onboarding', 'scripts/wp35-gate.ts', 'wp35:onboarding'],
  ['wp35:billing', 'scripts/wp35-gate.ts', 'wp35:billing'],
  ['wp35:rollout', 'scripts/wp35-gate.ts', 'wp35:rollout'],
  ['wp35:browser-mobile', 'scripts/wp35-browser-mobile.ts'],
  ['wp35:lifecycle', 'scripts/wp35-gate.ts', 'wp35:lifecycle'],
  ['wp35:cleanup', 'scripts/wp35-gate.ts', 'wp35:cleanup'],
] as const
const results: Wp35GateResult[] = []
for (const [name, ...command] of gates) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', ...command], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  })
  if (run.stderr) process.stderr.write(run.stderr)
  const line = run.stdout
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith(`{"gate":"${name}"`))
  if (line) {
    process.stdout.write(`${line}\n`)
    results.push(JSON.parse(line) as Wp35GateResult)
  } else
    results.push({
      gate: name,
      accepted: false,
      status: 'failed',
      exitStatus: run.status,
    })
}
const summary = summarizeWp35Gates(results)
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'wp35-accept.json'),
  stableJson({
    gate,
    summary,
    results,
    productionChecks: {
      acceptanceClass: 'WP35-E',
      phase6ClosureAllowed: false,
      physicalMobileDevice: 'not-run',
      realPaymentProvider: 'not-run',
      realProviderNetwork: 'not-run',
      externalLimitedBetaEnvironment: 'not-run',
    },
  }),
)
machineEvidence(gate, {
  ...summary,
  evidence: '.wp35/evidence/wp35-accept.json',
  engineeringAcceptance: 'WP35-L',
  externalAcceptance: 'WP35-E:not-run',
  phase6ClosureAllowed: false,
})
if (!summary.accepted) process.exitCode = 1
