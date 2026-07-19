import { spawnSync } from 'node:child_process'

const codexBin = process.env.WP26_CODEX_BIN
if (!codexBin) throw new Error('WP26_CODEX_BIN must point to Codex 0.144.2')
const run = (command: string, args: string[], env = process.env) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed`)
}
run('node', ['--import', 'tsx', 'scripts/wp26-postgres-ha.ts'])
run('node', ['--import', 'tsx', 'scripts/wp26-scheduler-runtime.ts'], {
  ...process.env,
  WP26_CODEX_BIN: codexBin,
})
console.log(
  JSON.stringify({
    gate: 'wp26:ha',
    schedulerInstances: 2,
    runtime: 'real-codex',
    durableStore: 'postgresql',
    note: 'API/realtime browser restart continuity is a separate wp26:browser gate',
  }),
)
