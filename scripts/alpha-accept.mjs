import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const evidenceDirectory = resolve('.runtime/acceptance')
const evidenceFile = resolve(evidenceDirectory, 'alpha-accept.json')
mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 })
writeFileSync(
  evidenceFile,
  `${JSON.stringify({ schemaVersion: 1, gate: 'single_tenant_alpha_deterministic', status: 'running' }, null, 2)}\n`,
  { mode: 0o600 },
)

const stages = [
  { name: 'deterministic_soak', command: 'pnpm', args: ['alpha:soak'] },
  { name: 'integration_build_ssr_security', command: 'pnpm', args: ['verify'] },
  { name: 'lifecycle_recovery', command: 'pnpm', args: ['alpha:lifecycle'] },
]

function run(stage) {
  process.stderr.write(`[alpha:accept] ${stage.name}\n`)
  const startedAt = Date.now()
  return new Promise((resolveStage) => {
    const child = spawn(stage.command, stage.args, {
      cwd: process.cwd(),
      env: { ...process.env, ALPHA_ACCEPTANCE: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (chunk) => {
      output += chunk.toString()
      if (output.length > 2_000_000) output = output.slice(-2_000_000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', () =>
      resolveStage({
        name: stage.name,
        status: 'failed',
        exitCode: null,
        durationMs: Date.now() - startedAt,
        output,
      }),
    )
    child.on('exit', (code) =>
      resolveStage({
        name: stage.name,
        status: code === 0 ? 'passed' : 'failed',
        exitCode: code,
        durationMs: Date.now() - startedAt,
        output,
      }),
    )
  })
}

const results = []
for (const stage of stages) {
  const result = await run(stage)
  results.push(result)
  if (result.status !== 'passed') break
}

function readSafeSummary(name) {
  try {
    return JSON.parse(readFileSync(resolve(evidenceDirectory, name), 'utf8'))
  } catch {
    return { status: 'not_run' }
  }
}

const passed =
  results.length === stages.length &&
  results.every((stage) => stage.status === 'passed')
const stagePassed = (name) =>
  results.some((stage) => stage.name === name && stage.status === 'passed')
const summary = {
  schemaVersion: 1,
  gate: 'single_tenant_alpha_deterministic',
  status: passed ? 'passed' : 'failed',
  canaryExecuted: false,
  stages: results.map(({ name, status, exitCode, durationMs }) => ({
    name,
    status,
    exitCode,
    durationMs,
  })),
  resources: stagePassed('deterministic_soak')
    ? readSafeSummary('alpha-soak.json')
    : { status: 'not_run' },
  lifecycle: stagePassed('lifecycle_recovery')
    ? readSafeSummary('alpha-lifecycle.json')
    : { status: 'not_run' },
  evidencePolicy: {
    containsUserContent: false,
    containsCredentials: false,
    containsRuntimePaths: false,
    containsModelOutput: false,
  },
}
writeFileSync(evidenceFile, `${JSON.stringify(summary, null, 2)}\n`, {
  mode: 0o600,
})
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

if (!passed) {
  const failed = results.find((stage) => stage.status === 'failed')
  process.stderr.write(
    `[alpha:accept] failed stage: ${failed?.name ?? 'unknown'}; detailed command output was intentionally excluded from acceptance evidence\n`,
  )
  process.exitCode = 1
}
