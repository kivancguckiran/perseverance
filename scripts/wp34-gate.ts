import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { redactProviderAuthSurface } from '../packages/provider-auth/src/index'
import {
  machineEvidence,
  scanWp30Evidence,
  type EvidenceSource,
} from './wp30-evidence'
import { stableJson } from './wp31-release-lib'
import { WP34_REQUIRED_FILES, WP34_TEST_FILES } from './wp34-lib'

const gate = process.argv[2]
const root = resolve(import.meta.dirname, '..')
const evidenceDir = join(
  resolve(process.env.WP34_OUTPUT_DIR ?? join(root, '.wp34')),
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

function runVitest(testNamePattern?: string) {
  const args = [
    'run',
    ...WP34_TEST_FILES,
    '--reporter=json',
    ...(testNamePattern ? ['--testNamePattern', testNamePattern] : []),
  ]
  const run = spawnSync(
    process.execPath,
    [resolve(root, 'node_modules/vitest/vitest.mjs'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    },
  )
  if (run.stderr) process.stderr.write(run.stderr)
  if (run.status !== 0) {
    finish({
      accepted: false,
      status: 'failed',
      runner: 'vitest',
      testFiles: [...WP34_TEST_FILES],
    })
    process.exitCode = 1
    return
  }
  const report = JSON.parse(run.stdout) as {
    numTotalTestSuites: number
    numPassedTestSuites: number
    numTotalTests: number
    numPassedTests: number
    numFailedTests: number
  }
  finish({
    accepted: true,
    status: 'passed',
    runner: 'vitest',
    testFiles: [...WP34_TEST_FILES],
    testNamePattern: testNamePattern ?? null,
    testSuites: report.numTotalTestSuites,
    passedSuites: report.numPassedTestSuites,
    tests: report.numPassedTests + report.numFailedTests,
    passedTests: report.numPassedTests,
    failedTests: report.numFailedTests,
  })
}

function runDatabaseGate() {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/wp34-vault.ts', gate],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    },
  )
  if (run.stderr) process.stderr.write(run.stderr)
  if (run.stdout) process.stdout.write(run.stdout)
  if (run.status !== 0) process.exitCode = run.status ?? 1
}

function walk(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path).flatMap((name) => walk(join(path, name)))
}

if (gate === 'wp34:test') runVitest()
else if (gate === 'wp34:oauth' || gate === 'wp34:kill-switch') runDatabaseGate()
else if (gate === 'wp34:leak-scan') {
  const paths = [
    ...WP34_REQUIRED_FILES,
    'packages/workspace-security/src/index.ts',
    'packages/tenant-runtime/src/contracts.ts',
  ]
  const sources: EvidenceSource[] = paths.flatMap((path) => {
    const absolute = join(root, path)
    return walk(absolute).map((file) => ({
      name: relative(root, file),
      content: readFileSync(file, 'utf8'),
    }))
  })
  if (statSync(evidenceDir, { throwIfNoEntry: false }))
    sources.push(
      ...walk(evidenceDir).map((file) => ({
        name: relative(root, file),
        content: readFileSync(file, 'utf8'),
      })),
    )
  const scan = scanWp30Evidence(sources)
  const allowlistReasons: Record<string, string> = {
    'packages/provider-auth/src/index.ts:SECRET_ASSIGNMENT':
      'scanner/redaction implementation contains field-name patterns but no literal credential',
    'packages/provider-auth/src/index.test.ts:COOKIE':
      'generated adversarial sentinel exercises cookie redaction and is never persisted',
    'scripts/wp34-gate.ts:COOKIE':
      'generated adversarial sentinel exercises cookie redaction and is never persisted',
    'scripts/wp34-gate.ts:SECRET_ASSIGNMENT':
      'generated adversarial sentinel uses expressions, not a literal credential',
    'scripts/wp34-vault.ts:SECRET_ASSIGNMENT':
      'ephemeral test harness secret is generated at runtime and never emitted',
    'scripts/wp34-vault.ts:DATABASE_URI_USERINFO':
      'ephemeral local PostgreSQL URI is assembled from a runtime-generated password and never emitted',
  }
  const allowlisted = scan.findings.flatMap((finding) => {
    const key = `${finding.source}:${finding.ruleId}`
    const reason = allowlistReasons[key]
    return reason ? [{ ...finding, reason }] : []
  })
  const findings = scan.findings.filter(
    (finding) => !allowlistReasons[`${finding.source}:${finding.ruleId}`],
  )
  const sentinel = `sk-${'q'.repeat(48)}`
  const redacted = JSON.stringify(
    redactProviderAuthSurface({
      log: { accessToken: sentinel },
      event: { authorization: `Bearer ${'w'.repeat(48)}` },
      trace: { nested: sentinel },
      fixture: { refreshToken: sentinel },
      snapshot: { apiKey: sentinel },
      backup: { cookie: sentinel },
      supportExport: { deviceCode: sentinel },
    }),
  )
  const adversarialPassed =
    !redacted.includes(sentinel) && !redacted.includes('w'.repeat(48))
  finish({
    accepted: findings.length === 0 && adversarialPassed,
    status: findings.length === 0 && adversarialPassed ? 'passed' : 'failed',
    scanner: scan.scanner,
    sourcesScanned: scan.sourcesScanned,
    bytesScanned: scan.bytesScanned,
    findings,
    adversarialSurfaces: [
      'log',
      'event',
      'trace',
      'fixture',
      'snapshot',
      'backup',
      'support-export',
    ],
    adversarialPassed,
    allowlist: allowlisted,
  })
} else {
  throw new Error(`UNKNOWN_WP34_GATE:${gate}`)
}
