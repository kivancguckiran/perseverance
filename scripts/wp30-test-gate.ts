import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { machineEvidence } from './wp30-evidence'

const results = [
  [
    'unit',
    [
      'exec',
      'vitest',
      'run',
      'packages/production-readiness/src/index.test.ts',
      'packages/production-readiness/src/evidence.test.ts',
    ],
  ],
  [
    'contracts',
    ['--filter', '@persistent-codex/production-readiness', 'typecheck'],
  ],
] as const
for (const [name, args] of results) {
  const run = spawnSync('pnpm', args, { encoding: 'utf8', env: process.env })
  process.stdout.write(run.stdout)
  process.stderr.write(run.stderr)
  assert.equal(run.status, 0, `WP30 ${name} gate failed`)
}
machineEvidence('wp30:test', {
  accepted: true,
  status: 'passed',
  realEvidenceClaimed: false,
  purpose: 'contract-and-state-machine-regression',
  checks: results.map(([name]) => name),
})
