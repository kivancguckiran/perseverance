import { spawnSync } from 'node:child_process'

const codexBin = process.env.WP26_CODEX_BIN
if (!codexBin) throw new Error('WP26_CODEX_BIN must point to Codex 0.144.2')
const run = (script: string, extra: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync('node', ['--import', 'tsx', script], {
    stdio: 'inherit',
    env: { ...process.env, CODEX_BIN: codexBin, ...extra },
  })
  if (result.status !== 0) throw new Error(`${script} failed`)
}
run('services/control-plane/src/recovery-smoke.ts', { NODE_ENV: 'test' })
run('scripts/wp25-browser-accept.ts', { WP25_CODEX_BIN: codexBin })
console.log(
  JSON.stringify({
    gate: 'wp26:browser',
    browser: 'chromium',
    apiInstances: 2,
    instanceLifecycle: 'sequential-kill-restart',
    durableRunReplay: 'continued',
    highWaterReplay: 'continued',
    approvalContext: 'continued',
    productionHaEvidence: false,
    limitation:
      'Browser restart harness uses the local adapter; production multi-process HA evidence requires the external WP26 HA topology.',
  }),
)
