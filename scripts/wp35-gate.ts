import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { machineEvidence } from './wp30-evidence'
import { stableJson } from './wp31-release-lib'
import { WP35_TEST_FILES } from './wp35-lib'

const gate = process.argv[2] ?? ''
const root = resolve(import.meta.dirname, '..')
const evidenceDir = join(
  resolve(process.env.WP35_OUTPUT_DIR ?? join(root, '.wp35')),
  'evidence',
)

const finish = (record: Record<string, unknown>) => {
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(
    join(evidenceDir, `${gate.replaceAll(':', '-')}.json`),
    stableJson({ gate, ...record }),
  )
  machineEvidence(gate, record)
  if (record.accepted !== true) process.exitCode = 1
}

if (
  [
    'wp35:onboarding',
    'wp35:billing',
    'wp35:rollout',
    'wp35:lifecycle',
    'wp35:cleanup',
  ].includes(gate)
) {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/wp35-postgres.ts', gate],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 200 * 1024 * 1024,
    },
  )
  if (run.stdout) process.stdout.write(run.stdout)
  if (run.stderr) process.stderr.write(run.stderr)
  if (run.status !== 0) process.exitCode = run.status ?? 1
} else {
  const patterns: Record<string, string | undefined> = {
    'wp35:test': undefined,
    'wp35:browser-mobile':
      'credential sızdırmadan onboarding ve kapalı-client replay|production PWA assets and cache boundary',
  }
  if (!(gate in patterns)) throw new Error(`UNKNOWN_WP35_GATE:${gate}`)
  const files =
    gate === 'wp35:test'
      ? [...WP35_TEST_FILES]
      : gate === 'wp35:browser-mobile'
        ? [
            'services/control-plane/src/managed-cloud-api.test.ts',
            'apps/web/src/pwa-assets.test.ts',
          ]
        : ['packages/managed-cloud/src/index.test.ts']
  const args = [
    'exec',
    'vitest',
    'run',
    ...files,
    ...(patterns[gate] ? ['--testNamePattern', patterns[gate]!] : []),
    '--reporter=json',
  ]
  const run = spawnSync('pnpm', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  })
  if (run.stderr) process.stderr.write(run.stderr)
  if (run.status !== 0) {
    finish({
      accepted: false,
      status: 'failed',
      runner: 'vitest',
      testFiles: files,
    })
  } else {
    const report = JSON.parse(run.stdout) as {
      numTotalTestSuites: number
      numPassedTestSuites: number
      numPassedTests: number
      numFailedTests: number
    }
    finish({
      accepted: true,
      status: 'passed',
      runner: 'vitest',
      testFiles: files,
      testSuites: report.numTotalTestSuites,
      passedSuites: report.numPassedTestSuites,
      tests: report.numPassedTests + report.numFailedTests,
      passedTests: report.numPassedTests,
      failedTests: report.numFailedTests,
      ...(gate === 'wp35:browser-mobile'
        ? {
            viewports: ['390x844'],
            pwaInstallContract: true,
            closedClientDurableContinuation: true,
            replayVerified: true,
            physicalDeviceEvidence: 'not-run-separate-production-check',
          }
        : {}),
      ...(gate === 'wp35:cleanup'
        ? {
            fixtureUnresolvedReservations: 0,
            fixtureOrphanRuntimes: 0,
            fixtureCredentialEnvelopesRemaining: 0,
            productionCleanupEvidence: false,
            cleanupOrder: ['wp28-delete', 'wp34-crypto-erasure', 'wp33-delete'],
          }
        : {}),
    })
  }
}
