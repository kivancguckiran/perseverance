import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'

const localEnvironmentFile = resolve('.env.local')
if (existsSync(localEnvironmentFile)) loadEnvFile(localEnvironmentFile)

const runtime = resolve('.runtime/alpha')
mkdirSync(runtime, { recursive: true, mode: 0o700 })
for (const directory of ['codex-homes', 'artifacts'])
  mkdirSync(resolve(runtime, directory), { recursive: true, mode: 0o700 })

const child = spawn('pnpm', ['dev'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PERSISTENT_CODEX_LOCAL_ALPHA: '1',
    EVENT_DATABASE_PATH:
      process.env.EVENT_DATABASE_PATH ?? resolve(runtime, 'events.sqlite'),
    CODEX_HOME_ROOT:
      process.env.CODEX_HOME_ROOT ?? resolve(runtime, 'codex-homes'),
    ARTIFACT_ROOT: process.env.ARTIFACT_ROOT ?? resolve(runtime, 'artifacts'),
    CODEX_BIN: process.env.CODEX_BIN ?? resolve('node_modules/.bin/codex'),
  },
})
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal))
child.on(
  'exit',
  (code, signal) =>
    (process.exitCode =
      code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)),
)
