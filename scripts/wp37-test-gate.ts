// WP37 — deterministik test gate'i: kullanıcı hesapları / parola-türevli
// mahremiyet birim testlerini (wp37.test.ts + workspace-security wp37
// testleri) vitest ile koşar ve evidence üretir. Docker gerektirmez.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { machineEvidence } from './wp30-evidence'
import { stableJson } from './wp31-release-lib'

const gate = 'wp37:test'
const root = resolve(import.meta.dirname, '..')
const evidenceDir = join(
  resolve(process.env.WP37_OUTPUT_DIR ?? join(root, '.wp37')),
  'evidence',
)
const testFiles = [
  'scripts/wp37.test.ts',
  'services/control-plane/src/self-hosted-auth-api.test.ts',
  'packages/workspace-security/src/index.test.ts',
]

const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...testFiles], {
  cwd: root,
  stdio: 'inherit',
})
if (result.status !== 0) {
  machineEvidence(gate, { accepted: false, status: 'failed', testFiles })
  throw new Error('WP37_TEST_FAILED')
}
mkdirSync(evidenceDir, { recursive: true })
const record = {
  gate,
  accepted: true,
  status: 'passed',
  runner: 'vitest',
  testFiles,
}
writeFileSync(join(evidenceDir, 'wp37-test.json'), stableJson(record))
machineEvidence(gate, {
  accepted: true,
  status: 'passed',
  runner: 'vitest',
  testFiles,
})
