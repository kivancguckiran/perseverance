// WP32 — deterministik test gate'i: statik kabul katmanını (wp32-lib.test.ts)
// vitest ile koşar ve evidence üretir. Docker gerektirmez, her ortamda çalışır.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { machineEvidence } from './wp30-evidence'
import { stableJson } from './wp31-release-lib'

const gate = 'wp32:test'
const root = resolve(import.meta.dirname, '..')
const evidenceDir = join(
  resolve(process.env.WP32_OUTPUT_DIR ?? join(root, '.wp32')),
  'evidence',
)
const testFile = 'scripts/wp32-lib.test.ts'

const result = spawnSync('pnpm', ['exec', 'vitest', 'run', testFile], {
  cwd: root,
  stdio: 'inherit',
})
if (result.status !== 0) {
  machineEvidence(gate, { accepted: false, status: 'failed', testFile })
  throw new Error('WP32_TEST_FAILED')
}
mkdirSync(evidenceDir, { recursive: true })
const record = {
  gate,
  accepted: true,
  status: 'passed',
  runner: 'vitest',
  testFile,
}
writeFileSync(join(evidenceDir, 'wp32-test.json'), stableJson(record))
machineEvidence(gate, {
  accepted: true,
  status: 'passed',
  runner: 'vitest',
  testFile,
})
