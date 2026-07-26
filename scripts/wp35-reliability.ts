import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { machineEvidence, redactWp30Evidence } from './wp30-evidence'
import { stableJson } from './wp31-release-lib'

const gate = 'wp35:reliability'
const root = resolve(import.meta.dirname, '..')
const output = resolve(process.env.WP35_OUTPUT_DIR ?? join(root, '.wp35'))
const reliabilityRoot = join(output, 'reliability')
const evidenceDir = join(output, 'evidence')
const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')
const sleep = (milliseconds: number) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

const dockerCount = (kind: 'container' | 'volume' | 'network') => {
  const command =
    kind === 'container'
      ? ['ps', '-aq', '--filter', 'label=persistent.wp35=true']
      : [kind, 'ls', '-q', '--filter', 'label=persistent.wp35=true']
  const result = spawnSync('docker', command, { encoding: 'utf8' })
  return {
    exitStatus: result.status,
    count: result.status === 0 ? lines(result.stdout).length : -1,
  }
}

const wp35ProcessCount = () => {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
  })
  const patterns = [
    /persistent-wp35-(?:postgres|browser)-\d+-\d+/,
    /--namespace persistent-wp35-\d+/,
    /--session wp35-mobile-\d+/,
  ]
  return {
    exitStatus: result.status,
    count:
      result.status === 0
        ? lines(result.stdout).filter((line) =>
            patterns.some((pattern) => pattern.test(line)),
          ).length
        : -1,
  }
}

const residualInventory = () => ({
  containers: dockerCount('container'),
  volumes: dockerCount('volume'),
  networks: dockerCount('network'),
  processes: wp35ProcessCount(),
})
const inventoryIsZero = (inventory: ReturnType<typeof residualInventory>) =>
  Object.values(inventory).every(
    ({ exitStatus, count }) => exitStatus === 0 && count === 0,
  )
const waitForZeroResidual = async () => {
  const timeoutMs = 30_000
  const deadline = Date.now() + timeoutMs
  let inventory = residualInventory()
  while (!inventoryIsZero(inventory) && Date.now() < deadline) {
    await sleep(500)
    inventory = residualInventory()
  }
  return { timeoutMs, inventory, zero: inventoryIsZero(inventory) }
}

const evidenceHashes = (directory: string) => {
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const target = join(path, entry.name)
      return entry.isDirectory() ? walk(target) : [target]
    })
  return walk(directory)
    .sort()
    .map((path) => ({
      path: relative(directory, path),
      bytes: statSync(path).size,
      sha256: sha256(readFileSync(path)),
    }))
}

rmSync(reliabilityRoot, { recursive: true, force: true })
mkdirSync(reliabilityRoot, { recursive: true })
const runs: Array<Record<string, unknown>> = []
for (const runNumber of [1, 2]) {
  const runOutput = join(reliabilityRoot, `run-${runNumber}`)
  const run = spawnSync('pnpm', ['wp35:accept'], {
    cwd: root,
    env: { ...process.env, WP35_OUTPUT_DIR: runOutput },
    encoding: 'utf8',
    maxBuffer: 300 * 1024 * 1024,
  })
  const stdout = redactWp30Evidence(run.stdout ?? '')
  const stderr = redactWp30Evidence(run.stderr ?? '')
  writeFileSync(join(reliabilityRoot, `run-${runNumber}.stdout.log`), stdout)
  writeFileSync(join(reliabilityRoot, `run-${runNumber}.stderr.log`), stderr)
  const machineLine = stdout
    .split('\n')
    .findLast((line) => line.startsWith('{"gate":"wp35:accept"'))
  const acceptance = machineLine
    ? (JSON.parse(machineLine) as Record<string, unknown>)
    : null
  const residual = await waitForZeroResidual()
  const hashes =
    run.status === 0 && acceptance?.accepted === true
      ? evidenceHashes(join(runOutput, 'evidence'))
      : []
  runs.push({
    run: runNumber,
    accepted:
      run.status === 0 &&
      acceptance?.accepted === true &&
      residual.zero === true,
    exitStatus: run.status,
    exitReason: run.error
      ? `spawn-error:${redactWp30Evidence(run.error.message)}`
      : run.signal
        ? `signal:${run.signal}`
        : `exit-code:${run.status ?? 'unknown'}`,
    acceptance,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    stdoutEvidence: `.wp35/reliability/run-${runNumber}.stdout.log`,
    stderrEvidence: `.wp35/reliability/run-${runNumber}.stderr.log`,
    residual,
    evidenceHashes: hashes,
  })
  if (runs.at(-1)?.accepted !== true) break
}
const accepted = runs.length === 2 && runs.every((run) => run.accepted === true)
const record = {
  accepted,
  status: accepted ? 'passed' : 'failed',
  requiredConsecutiveRuns: 2,
  completedRuns: runs.length,
  runs,
}
mkdirSync(evidenceDir, { recursive: true })
const content = stableJson({ gate, ...record })
writeFileSync(join(evidenceDir, 'wp35-reliability.json'), content)
machineEvidence(gate, {
  accepted,
  status: record.status,
  requiredConsecutiveRuns: 2,
  completedRuns: runs.length,
  runEvidenceSha256: runs.map((run) =>
    (run.evidenceHashes as Array<{ path: string; sha256: string }>).find(
      ({ path }) => path === 'wp35-accept.json',
    ),
  ),
  residualZeroAfterEveryRun: runs.every(
    (run) => (run.residual as { zero: boolean } | undefined)?.zero === true,
  ),
  evidence: '.wp35/evidence/wp35-reliability.json',
  evidenceSha256: sha256(content),
})
if (!accepted) process.exitCode = 1
