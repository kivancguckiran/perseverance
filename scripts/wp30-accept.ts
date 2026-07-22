import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { format } from 'prettier'
import { scanWp30Evidence } from './wp30-evidence'

const root = resolve(import.meta.dirname, '..')
const output = resolve(process.env.WP30_OUTPUT_DIR ?? join(root, '.wp30'))
mkdirSync(output, { recursive: true })
const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).stdout.trim()
const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')
type Observation = {
  gate: string
  accepted: boolean
  status: 'passed' | 'failed' | 'not-run'
  exitCode: number | null
  evidence: Record<string, unknown> | null
  stdoutSha256: string
  stderrSha256: string
  previousEvidenceSha256: string | null
  evidenceSha256: string
}
const observations: Observation[] = []
const processEvidence: Array<{ name: string; content: string }> = []
let previous: string | null = null

const parseMachineEvidence = (stdout: string, gate: string) => {
  for (const line of stdout.trim().split('\n').reverse()) {
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line)
      if (
        parsed.gate === gate ||
        parsed.accepted !== undefined ||
        parsed.status
      )
        return parsed as Record<string, unknown>
    } catch {}
  }
  return null
}
const run = (
  gate: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = root,
) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 300 * 1024 * 1024,
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  processEvidence.push(
    { name: `${gate}:stdout`, content: result.stdout },
    { name: `${gate}:stderr`, content: result.stderr },
  )
  const machine = parseMachineEvidence(result.stdout, gate)
  const accepted = result.status === 0 && machine?.accepted !== false
  const status: Observation['status'] = accepted
    ? 'passed'
    : machine?.status === 'not-run'
      ? 'not-run'
      : 'failed'
  const recordBase = {
    gate,
    accepted,
    status,
    exitCode: result.status,
    evidence: machine,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    previousEvidenceSha256: previous,
  } as const
  previous = sha256(JSON.stringify(recordBase))
  const record = { ...recordBase, evidenceSha256: previous }
  observations.push(record)
  return record
}
const serialize = async (value: unknown) =>
  format(JSON.stringify(value), { parser: 'json' })
const writeRejected = async (reason: string) => {
  const report = await serialize({
    schemaVersion: 1,
    workPackage: 'WP30',
    sourceCommit,
    generatedAt: new Date().toISOString(),
    status: 'rejected-not-production-ready',
    accepted: false,
    reason,
    observations,
    evidenceChainHead: previous,
    syntheticEvidenceAccepted: false,
  })
  writeFileSync(join(output, 'wp30-acceptance-report.v1.json'), report)
  writeFileSync(
    join(output, 'wp30-acceptance-report.v1.sha256'),
    `${sha256(report)}  wp30-acceptance-report.v1.json\n`,
  )
}

const preflight = run('wp30:preflight', 'pnpm', ['wp30:preflight'])
if (!preflight.accepted) {
  await writeRejected(
    'production preflight not satisfied; downstream gates not run',
  )
  process.exitCode = 1
} else {
  const commonEnv = {
    ...process.env,
    WP26_CODEX_BIN: process.env.WP30_CODEX_BIN,
    WP27_CODEX_BIN: process.env.WP30_CODEX_BIN,
    WP28_CODEX_BIN: process.env.WP30_CODEX_BIN,
    WP29_CODEX_BIN: process.env.WP30_CODEX_BIN,
  }
  const prepareWorktree = (label: string) => {
    const directory = mkdtempSync(join(tmpdir(), `persistent-wp30-${label}-`))
    rmSync(directory, { recursive: true, force: true })
    const added = run(
      `wp30:${label}-worktree`,
      'git',
      ['worktree', 'add', '--detach', directory, sourceCommit],
      process.env,
    )
    if (!added.accepted) {
      rmSync(directory, { recursive: true, force: true })
      return null
    }
    const installed = run(
      `wp30:${label}-install`,
      'pnpm',
      ['install', '--frozen-lockfile'],
      process.env,
      directory,
    )
    if (!installed.accepted) {
      spawnSync('git', ['worktree', 'remove', '--force', directory], {
        cwd: root,
      })
      rmSync(directory, { recursive: true, force: true })
      return null
    }
    return directory
  }
  const removeWorktree = (directory: string) => {
    const removed = spawnSync(
      'git',
      ['worktree', 'remove', '--force', directory],
      { cwd: root, encoding: 'utf8' },
    )
    assert.equal(removed.status, 0, removed.stderr || removed.stdout)
    rmSync(directory, { recursive: true, force: true })
  }
  const priorGates: Array<[string, string, string[]]> = [
    ['alpha:accept', 'pnpm', ['alpha:accept']],
    ['phase2:accept', 'pnpm', ['phase2:accept']],
    ['phase3:accept', 'pnpm', ['phase3:accept']],
    ['phase4:accept', 'pnpm', ['phase4:accept']],
    ['wp26:accept', 'pnpm', ['wp26:accept']],
    ['wp27:accept', 'pnpm', ['wp27:accept']],
    ['wp28:accept', 'pnpm', ['wp28:accept']],
  ]
  const priorWorktree = prepareWorktree('prior')
  if (priorWorktree) {
    try {
      for (const [gate, command, args] of priorGates)
        run(gate, command, args, commonEnv, priorWorktree)
    } finally {
      removeWorktree(priorWorktree)
    }
  }
  const supplyChainWorktree = prepareWorktree('supply-chain')
  if (supplyChainWorktree) {
    try {
      run(
        'wp29:accept',
        'pnpm',
        ['wp29:accept'],
        commonEnv,
        supplyChainWorktree,
      )
    } finally {
      removeWorktree(supplyChainWorktree)
    }
  }
  const gates: Array<[string, string, string[]]> = [
    ['wp30:test', 'pnpm', ['wp30:test']],
    ['wp30:postgres-migration', 'pnpm', ['wp30:postgres-migration']],
    ['wp30:pentest', 'pnpm', ['wp30:pentest']],
    ['wp30:load-soak', 'pnpm', ['wp30:load-soak']],
    ['wp30:chaos', 'pnpm', ['wp30:chaos']],
    ['wp30:incident-game-day', 'pnpm', ['wp30:incident-game-day']],
    ['wp30:rollout', 'pnpm', ['wp30:rollout']],
    ['wp30:browser-mobile', 'pnpm', ['wp30:browser-mobile']],
    ['verify', 'pnpm', ['verify']],
  ]
  for (const [gate, command, args] of gates) run(gate, command, args, commonEnv)
  run('wp30:cleanup', 'pnpm', ['wp30:cleanup'], commonEnv)

  const allPassed = observations.every((observation) => observation.accepted)
  const scan = scanWp30Evidence(processEvidence)
  if (!allPassed || !scan.passed) {
    await writeRejected(
      !scan.passed
        ? 'acceptance process evidence content safety failed'
        : 'one or more mandatory gates failed',
    )
    process.exitCode = 1
  } else {
    const evidenceRoot = join(output, 'evidence')
    const walk = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name)
        return entry.isDirectory() ? walk(path) : [path]
      })
    const evidenceFiles = walk(evidenceRoot)
      .sort()
      .map((path) => {
        const bytes = readFileSync(path)
        return {
          path: relative(evidenceRoot, path),
          byteLength: statSync(path).size,
          sha256: sha256(bytes),
          contentBase64: bytes.toString('base64'),
        }
      })
    const bundleBase = {
      schemaVersion: 1,
      workPackage: 'WP30',
      sourceCommit,
      generatedAt: new Date().toISOString(),
      evidenceChainHead: previous,
      evidenceFiles,
    }
    const bundle = await serialize(bundleBase)
    const bundleSha256 = sha256(bundle)
    const preliminary = await serialize({
      schemaVersion: 1,
      workPackage: 'WP30',
      sourceCommit,
      status: 'acceptance-candidate',
      observations,
      evidenceChainHead: previous,
      evidenceBundleSha256: bundleSha256,
    })
    const candidateSha256 = sha256(preliminary)
    const goNoGo = run('wp30:go-no-go', 'pnpm', ['wp30:go-no-go'], {
      ...commonEnv,
      WP30_ACCEPTANCE_CANDIDATE_SHA256: candidateSha256,
      WP30_SOURCE_COMMIT: sourceCommit,
    })
    assert(goNoGo.accepted, 'durable go/no-go write failed')
    const reportBase = {
      schemaVersion: 1,
      workPackage: 'WP30',
      sourceCommit,
      generatedAt: new Date().toISOString(),
      status: 'accepted-real-production-like',
      accepted: true,
      observations,
      evidenceChainHead: previous,
      evidenceBundleSha256: bundleSha256,
      acceptanceCandidateSha256: candidateSha256,
      goNoGo: goNoGo.evidence,
      contentScanner: scan,
      cleanup: observations.find(({ gate }) => gate === 'wp30:cleanup')
        ?.evidence,
      knownNotRun: [],
      syntheticEvidenceAccepted: false,
    }
    const report = await serialize(reportBase)
    const acceptanceDir = join(root, 'docs/acceptance')
    writeFileSync(join(acceptanceDir, 'wp30-evidence-bundle.v1.json'), bundle)
    writeFileSync(
      join(acceptanceDir, 'wp30-evidence-bundle.v1.sha256'),
      `${bundleSha256}  wp30-evidence-bundle.v1.json\n`,
    )
    writeFileSync(join(acceptanceDir, 'wp30-acceptance-report.v1.json'), report)
    writeFileSync(
      join(acceptanceDir, 'wp30-acceptance-report.v1.sha256'),
      `${sha256(report)}  wp30-acceptance-report.v1.json\n`,
    )
    process.stdout.write(
      `${JSON.stringify({
        gate: 'production:accept',
        accepted: true,
        sourceCommit,
        requiredGates: observations.map(({ gate }) => gate),
        evidenceChainHead: previous,
        reportChecksum: sha256(report),
        evidenceBundleChecksum: bundleSha256,
        cleanup: 'verified-zero',
      })}\n`,
    )
  }
}
