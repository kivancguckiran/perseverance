// WP33 deterministik test gate'i: ortam gerektirmeyen contract/profil
// testlerini koşturur ve wp30 evidence sözleşmesiyle raporlar.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { machineEvidence } from './wp30-evidence'
import { stableJson } from './wp31-release-lib'
import { WP33_TEST_FILES } from './wp33-lib'

const gate = 'wp33:test'
const root = resolve(import.meta.dirname, '..')
const stateDir = resolve(process.env.WP33_OUTPUT_DIR ?? join(root, '.wp33'))
const evidenceDir = join(stateDir, 'evidence')

const run = spawnSync('pnpm', ['exec', 'vitest', 'run', ...WP33_TEST_FILES], {
  cwd: root,
  stdio: 'inherit',
})

if (run.status !== 0) {
  machineEvidence(gate, {
    accepted: false,
    status: 'failed',
    runner: 'vitest',
    testFiles: [...WP33_TEST_FILES],
  })
  throw new Error('WP33_TEST_FAILED')
}

const record = {
  gate,
  accepted: true,
  status: 'passed',
  runner: 'vitest',
  purpose: 'profile-contract-and-tenant-runtime-regression',
  testFiles: [...WP33_TEST_FILES],
}
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(join(evidenceDir, 'wp33-test.json'), stableJson(record))
machineEvidence(gate, {
  accepted: true,
  status: 'passed',
  runner: 'vitest',
  purpose: record.purpose,
  testFiles: record.testFiles,
})
