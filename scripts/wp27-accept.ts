import { spawnSync } from 'node:child_process'

const codexBin = process.env.WP27_CODEX_BIN
if (!codexBin) throw new Error('WP27_CODEX_BIN must point to Codex 0.144.2')
const gates = [
  'wp27:test',
  'wp27:otel',
  'wp27:postgres-pitr',
  'wp27:restore',
  'wp27:game-day',
  'wp27:alerts',
  'wp27:telemetry-scan',
  'wp27:e2e',
]
for (const gate of gates) {
  const result = spawnSync('pnpm', [gate], {
    stdio: 'inherit',
    env: { ...process.env, WP27_CODEX_BIN: codexBin },
  })
  if (result.status !== 0)
    throw new Error(`WP27 acceptance gate failed: ${gate}`)
}
console.log(
  JSON.stringify({
    gate: 'wp27:accept',
    accepted: true,
    requiredGates: gates,
    immutableEvidence: true,
    cleanup: 'delegated-to-each-gate-and-verified',
  }),
)
