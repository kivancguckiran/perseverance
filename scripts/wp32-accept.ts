// WP32 — kabul orchestrator'ı: tüm wp32 gate'lerini sırayla koşar, tek satırlık
// machineEvidence çıktılarının son durumunu toplar ve `.wp32/evidence/
// wp32-accept.json` altında deterministik özet üretir. not-run hiçbir zaman
// başarıya terfi etmez; herhangi bir gate passed değilse exit 1 (fail-closed).
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { machineEvidence } from './wp30-evidence'
import { stableJson } from './wp31-release-lib'
import { summarizeGates, type Wp32GateResult } from './wp32-lib'

const gate = 'wp32:accept'
const root = resolve(import.meta.dirname, '..')
const evidenceDir = join(
  resolve(process.env.WP32_OUTPUT_DIR ?? join(root, '.wp32')),
  'evidence',
)

const gates: { name: string; command: string[] }[] = [
  { name: 'wp32:test', command: ['scripts/wp32-test-gate.ts'] },
  {
    name: 'wp32:preflight',
    command: ['scripts/wp32-gate.ts', 'wp32:preflight'],
  },
  {
    name: 'wp32:install-smoke',
    command: ['scripts/wp32-gate.ts', 'wp32:install-smoke'],
  },
  {
    name: 'wp32:lifecycle',
    command: ['scripts/wp32-gate.ts', 'wp32:lifecycle'],
  },
  {
    name: 'wp32:credential-scan',
    command: ['scripts/wp32-gate.ts', 'wp32:credential-scan'],
  },
  { name: 'wp32:golden', command: ['scripts/wp32-gate.ts', 'wp32:golden'] },
]

const results: Wp32GateResult[] = []
for (const entry of gates) {
  const run = spawnSync('node', ['--import', 'tsx', ...entry.command], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  })
  process.stderr.write(run.stderr ?? '')
  const lines = (run.stdout ?? '').split('\n').filter(Boolean)
  const evidenceLine = [...lines]
    .reverse()
    .find((line) => line.startsWith(`{"gate":"${entry.name}"`))
  if (evidenceLine) {
    process.stdout.write(`${evidenceLine}\n`)
    results.push(JSON.parse(evidenceLine) as Wp32GateResult)
  } else {
    results.push({
      gate: entry.name,
      accepted: false,
      status: 'failed',
      exitStatus: run.status,
    })
    process.stdout.write(
      `${JSON.stringify({ gate: entry.name, accepted: false, status: 'failed', exitStatus: run.status })}\n`,
    )
  }
}

const summary = summarizeGates(results)
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'wp32-accept.json'),
  stableJson({ gate, summary, results }),
)
machineEvidence(gate, {
  ...summary,
  evidence: '.wp32/evidence/wp32-accept.json',
})
if (!summary.accepted) process.exitCode = 1
