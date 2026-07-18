import { execFileSync } from 'node:child_process'

const codexBin = process.env.WP22_CODEX_BIN
if (!codexBin) throw new Error('WP22_CODEX_BIN is required')
for (const script of [
  'wp22:test',
  'wp22:postgres',
  'wp22:agent-e2e',
  'wp22:browser',
]) {
  execFileSync('pnpm', [script], {
    stdio: 'inherit',
    env: { ...process.env, WP22_CODEX_BIN: codexBin },
  })
}
process.stdout.write(`${JSON.stringify({ ok: true, gate: 'wp22:accept' })}\n`)
