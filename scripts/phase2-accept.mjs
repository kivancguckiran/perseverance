import { spawnSync } from 'node:child_process'

const steps = [
  {
    name: 'provider/durable/cost/PWA contracts',
    command: 'pnpm',
    args: [
      'test',
      '--',
      '--run',
      'packages/provider-platform/src/index.test.ts',
      'packages/provider-cli-adapters/src/index.test.ts',
      'packages/event-store/src/index.test.ts',
      'services/control-plane/src/server.test.ts',
      'services/control-plane/src/title-process-runner.test.ts',
      'apps/web/src/workspace-page.test.ts',
      'apps/web/src/pwa-assets.test.ts',
    ],
  },
  {
    name: 'unknown-event durable replay',
    command: 'pnpm',
    args: ['--filter', '@perseverance/workspace-agent', 'smoke:unknown-replay'],
  },
  {
    name: 'production PWA build',
    command: 'pnpm',
    args: ['--filter', '@perseverance/web', 'build'],
    env: { VITE_CONTROL_PLANE_URL: 'http://127.0.0.1:3216' },
  },
  {
    name: 'production browser offline/online acceptance',
    command: 'pnpm',
    args: ['exec', 'tsx', 'scripts/phase2-browser-accept.ts'],
  },
]

for (const step of steps) {
  console.log(`\n[phase2:accept] ${step.name}`)
  const result = spawnSync(step.command, step.args, {
    stdio: 'inherit',
    env: { ...process.env, ...step.env },
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      `[phase2:accept] ${step.name} failed with status ${result.status}`,
    )
}

console.log('\n[phase2:accept] deterministic Phase 2 acceptance passed')
