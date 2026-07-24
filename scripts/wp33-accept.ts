// WP33 kabul orkestratörü: tüm wp33 gate'lerini koşturur, sonuçları toplar ve
// hiçbir not-run sonucunu başarıya terfi ettirmeden raporlar (WP30 kuralı).
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { machineEvidence } from './wp30-evidence'
import { stableJson } from './wp31-release-lib'
import { summarizeWp33Gates, type Wp33GateResult } from './wp33-lib'

const gate = 'wp33:accept'
const root = resolve(import.meta.dirname, '..')
const stateDir = resolve(process.env.WP33_OUTPUT_DIR ?? join(root, '.wp33'))
const evidenceDir = join(stateDir, 'evidence')

const gates: { name: string; command: string[] }[] = [
  { name: 'wp33:test', command: ['scripts/wp33-test-gate.ts'] },
  {
    name: 'wp33:provisioning',
    command: ['scripts/wp33-gate.ts', 'wp33:provisioning'],
  },
  {
    name: 'wp33:isolation',
    command: ['scripts/wp33-gate.ts', 'wp33:isolation'],
  },
  { name: 'wp33:chaos', command: ['scripts/wp33-gate.ts', 'wp33:chaos'] },
]

const results: Wp33GateResult[] = []
for (const entry of gates) {
  const run = spawnSync('node', ['--import', 'tsx', ...entry.command], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  })
  if (run.stderr) process.stderr.write(run.stderr)
  const line = run.stdout
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith(`{"gate":"${entry.name}"`))
  if (!line) {
    results.push({
      gate: entry.name,
      accepted: false,
      status: 'failed',
      exitStatus: run.status,
    })
    continue
  }
  results.push(JSON.parse(line) as Wp33GateResult)
}

const summary = summarizeWp33Gates(results)
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'wp33-accept.json'),
  stableJson({ gate, summary, results }),
)
machineEvidence(gate, {
  ...summary,
  evidence: '.wp33/evidence/wp33-accept.json',
})
if (!summary.accepted) process.exitCode = 1
