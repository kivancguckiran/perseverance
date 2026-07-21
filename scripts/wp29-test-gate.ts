import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', 'packages/release-supply-chain/src/index.test.ts'],
  { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
)
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
if (result.status !== 0) throw new Error('WP29_TEST_FAILED')
const record = {
  gate: 'wp29:test',
  accepted: true,
  runner: 'vitest',
  testFile: 'packages/release-supply-chain/src/index.test.ts',
}
const evidence = resolve(process.env.WP29_OUTPUT_DIR ?? join(root, '.wp29'))
mkdirSync(join(evidence, 'evidence'), { recursive: true })
writeFileSync(
  join(evidence, 'evidence/wp29-test.json'),
  `${JSON.stringify(record, null, 2)}\n`,
)
process.stdout.write(`${JSON.stringify(record)}\n`)
