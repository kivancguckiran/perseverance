import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const evidenceDirectory = resolve('.runtime/acceptance')
const evidenceFile = resolve(evidenceDirectory, 'alpha-canary.json')
const tsx = resolve('node_modules/.bin/tsx')
mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 })
writeFileSync(
  evidenceFile,
  `${JSON.stringify({ schemaVersion: 1, gate: 'single_tenant_alpha_real_canary', status: 'running' }, null, 2)}\n`,
  { mode: 0o600 },
)

const stages = [
  {
    name: 'read_only_turn',
    command: tsx,
    args: ['services/control-plane/src/poc-demo-smoke.ts'],
    env: { WP8_GOLDEN_SCENARIO: 'read-only' },
  },
  {
    name: 'file_change_targeted_test_git',
    command: tsx,
    args: ['services/control-plane/src/poc-demo-smoke.ts'],
    env: { WP8_GOLDEN_SCENARIO: 'change' },
  },
  {
    name: 'approval_single_decision',
    command: tsx,
    args: ['services/control-plane/src/approval-smoke.ts'],
  },
  {
    name: 'restart_resume_readiness_audit_metrics',
    command: tsx,
    args: ['services/control-plane/src/recovery-smoke.ts'],
  },
]

function orphanSmokeProcesses() {
  const measured = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
  if (measured.status !== 0) throw new Error('orphan process probe unavailable')
  return measured.stdout
    .split('\n')
    .filter((line) =>
      /persistent-(?:codex-poc-demo|approval-smoke|recovery-smoke)-/.test(line),
    ).length
}

function run(stage) {
  process.stderr.write(`[alpha:canary] ${stage.name}\n`)
  const startedAt = Date.now()
  return new Promise((resolveStage) => {
    const child = spawn(stage.command, stage.args, {
      cwd: process.cwd(),
      env: { ...process.env, ...stage.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    // Canary subprocess output can contain generated session IDs, local paths, prompts,
    // or model text. Keep a bounded in-memory copy only to verify cleanup; never copy it
    // into acceptance evidence.
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
      }),
    )
    child.on('exit', (code) => {
      let cleanupVerified = false
      if (code === 0) {
        try {
          const start = output.lastIndexOf('\n{')
          const parsed = JSON.parse(output.slice(start < 0 ? 0 : start + 1))
          cleanupVerified =
            stage.name === 'restart_resume_readiness_audit_metrics'
              ? parsed.databaseCleaned === true &&
                parsed.codexHomeRootCleaned === true &&
                parsed.artifactRootCleaned === true &&
                parsed.runtimeRootCleaned === true
              : stage.name === 'approval_single_decision'
                ? parsed.isolatedCodexHomeCleaned === true &&
                  parsed.databaseCleaned === true
                : Object.values(parsed.cleanup ?? {}).every(
                    (value) => value === true,
                  )
          cleanupVerified = cleanupVerified && orphanSmokeProcesses() === 0
        } catch {
          cleanupVerified = false
        }
      }
      resolveStage({
        name: stage.name,
        status: code === 0 && cleanupVerified ? 'passed' : 'failed',
        exitCode: code === 0 && cleanupVerified ? 0 : (code ?? 1),
        durationMs: Date.now() - startedAt,
        cleanupVerified,
      })
    })
  })
}

const results = []
for (const stage of stages) {
  const result = await run(stage)
  results.push(result)
  if (result.status !== 'passed') break
}
const passed =
  results.length === stages.length &&
  results.every((stage) => stage.status === 'passed')
const summary = {
  schemaVersion: 1,
  gate: 'single_tenant_alpha_real_canary',
  status: passed ? 'passed' : 'failed',
  isolatedTemporaryRuntime: true,
  stages: results,
  evidencePolicy: {
    containsUserContent: false,
    containsCredentials: false,
    containsRuntimePaths: false,
    containsPrompts: false,
    containsModelOutput: false,
    containsReasoning: false,
  },
}
writeFileSync(evidenceFile, `${JSON.stringify(summary, null, 2)}\n`, {
  mode: 0o600,
})
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
if (!passed) process.exitCode = 1
