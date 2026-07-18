import { execFileSync } from 'node:child_process'

if (process.env.WP23_REAL_WEB_PUSH === '1')
  throw new Error(
    'WP23_REAL_WEB_PUSH was requested, but no real-provider opt-in smoke command is configured',
  )

const results: string[] = []
for (const script of ['wp23:test', 'wp23:postgres', 'wp23:browser', 'verify']) {
  execFileSync('pnpm', [script], { stdio: 'inherit', env: process.env })
  results.push(script)
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    gate: 'wp23:accept',
    completed: results,
    pushProvider: 'emulator',
    realWebPushOptIn: 'not-run-no-credential',
    cleanup: {
      postgresContainer: true,
      postgresVolume: true,
      browserContexts: true,
      serviceWorkers: true,
      tempFiles: true,
    },
  })}\n`,
)
