import { spawnSync } from 'node:child_process'

const codexBin = process.env.WP26_CODEX_BIN
if (!codexBin) throw new Error('WP26_CODEX_BIN must point to Codex 0.144.2')
if (!process.env.WP26_IO_DEVICE)
  throw new Error(
    'WP26_IO_DEVICE is required; capacity evidence must come from real Linux cgroup v2',
  )
const gates: Array<[string, string[]]> = [
  ['pnpm', ['wp26:test']],
  ['pnpm', ['wp26:postgres']],
  ['pnpm', ['wp26:ha']],
  ['pnpm', ['wp26:scheduler']],
  ['pnpm', ['wp26:capacity']],
  ['pnpm', ['wp26:browser']],
]
for (const [command, args] of gates) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, WP26_CODEX_BIN: codexBin },
  })
  if (result.status !== 0)
    throw new Error(`WP26 acceptance gate failed: ${command} ${args.join(' ')}`)
}
console.log(
  JSON.stringify({
    gate: 'wp26:accept',
    accepted: true,
    productionHaEvidence: true,
    requiredGates: gates.map(([, args]) => args[0]),
    cleanup: 'delegated-to-each-gate-and-verified',
  }),
)
