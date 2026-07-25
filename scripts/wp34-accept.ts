import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { machineEvidence } from './wp30-evidence'
import { stableJson } from './wp31-release-lib'
import { summarizeWp34Gates, type Wp34GateResult } from './wp34-lib'

const gate = 'wp34:accept'
const root = resolve(import.meta.dirname, '..')
const evidenceDir = join(
  resolve(process.env.WP34_OUTPUT_DIR ?? join(root, '.wp34')),
  'evidence',
)
const gates = [
  ['wp34:test', 'scripts/wp34-gate.ts', 'wp34:test'],
  ['wp34:oauth', 'scripts/wp34-gate.ts', 'wp34:oauth'],
  ['wp34:vault', 'scripts/wp34-vault.ts'],
  ['wp34:kill-switch', 'scripts/wp34-gate.ts', 'wp34:kill-switch'],
  ['wp34:leak-scan', 'scripts/wp34-gate.ts', 'wp34:leak-scan'],
] as const

const results: Wp34GateResult[] = []
for (const [name, ...command] of gates) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', ...command], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  })
  if (run.stderr) process.stderr.write(run.stderr)
  const line = (run.stdout ?? '')
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith(`{"gate":"${name}"`))
  if (line) {
    process.stdout.write(`${line}\n`)
    results.push(JSON.parse(line) as Wp34GateResult)
  } else
    results.push({
      gate: name,
      accepted: false,
      status: 'failed',
      exitStatus: run.status,
    })
}
const summary = summarizeWp34Gates(results)
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'wp34-accept.json'),
  stableJson({
    gate,
    summary,
    results,
    realProviderSmoke: {
      status: 'not-run-unless-explicitly-authorized',
      gate: 'wp34:provider-smoke',
    },
  }),
)
machineEvidence(gate, {
  ...summary,
  evidence: '.wp34/evidence/wp34-accept.json',
  realProviderSmoke: 'separate-fail-closed-gate',
})
if (!summary.accepted) process.exitCode = 1
