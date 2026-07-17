import { spawnSync } from 'node:child_process'

const production = process.env.PHASE3_PRODUCTION_ACCEPTANCE === '1'
const steps = [
  [
    'WP18 OIDC/authz/IDOR/WebSocket/cache/signed URL contracts',
    'pnpm',
    [
      'test',
      '--',
      '--run',
      'packages/authz/src/index.test.ts',
      'packages/artifact-storage/src/index.test.ts',
      'services/control-plane/src/server-auth.test.ts',
      'services/control-plane/src/server.test.ts',
      'apps/web/src/workspace-page.test.ts',
    ],
  ],
  ['WP18 PostgreSQL forced-RLS isolation', 'pnpm', ['wp18:postgres']],
  ['WP19 path/network/secret/encryption adversarial', 'pnpm', ['wp19:test']],
  ['WP19 PostgreSQL application encryption', 'pnpm', ['wp19:postgres']],
  ['WP19 key rotation', 'pnpm', ['wp19:key-rotation']],
  ['WP19 crypto-erasure', 'pnpm', ['wp19:crypto-erasure']],
  ['WP19 encrypted backup/restore', 'pnpm', ['wp19:backup-restore']],
  ['WP20 grant/JIT/audit/break-glass adversarial', 'pnpm', ['wp20:test']],
  ['WP20 PostgreSQL RLS and immutable hash-chain', 'pnpm', ['wp20:postgres']],
  [
    'production build for security browser',
    'pnpm',
    ['--filter', '@persistent-codex/web', 'build'],
    { VITE_CONTROL_PLANE_URL: 'http://127.0.0.1:3217' },
  ],
  [
    'responsive browser security E2E',
    'pnpm',
    ['exec', 'tsx', 'scripts/phase3-browser-security-accept.ts'],
  ],
  ['repository verify including build and SSR HTTP smoke', 'pnpm', ['verify']],
]

if (production) {
  const missing = [
    'WP19_KATA_RUNTIME_CLASS',
    'WP19_ENCRYPTED_STORAGE_CLASS',
    'WP19_AWS_KMS_KEY_ID',
  ].filter((name) => !process.env[name])
  if (missing.length)
    throw new Error(
      `Production acceptance prerequisites missing: ${missing.join(', ')}`,
    )
  steps.splice(
    9,
    0,
    ['real Kata runtime isolation profile', 'pnpm', ['wp19:runtime-smoke']],
    ['real AWS KMS encryption-context profile', 'pnpm', ['wp19:kms-smoke']],
  )
}

for (const [name, command, args, extraEnv = {}] of steps) {
  console.log(`\n[phase3:accept] ${name}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      `[phase3:accept] ${name} failed with status ${result.status}`,
    )
}

const credentialScan = spawnSync(
  'git',
  [
    'grep',
    '-nEI',
    '(AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer [A-Za-z0-9_-]{32,})',
    '--',
    ':!pnpm-lock.yaml',
  ],
  { encoding: 'utf8' },
)
if (credentialScan.status === 0)
  throw new Error(
    `Credential-shaped plaintext found:\n${credentialScan.stdout}`,
  )
if (credentialScan.status !== 1)
  throw new Error(`Credential scan failed: ${credentialScan.stderr}`)

const containers = spawnSync(
  'docker',
  [
    'ps',
    '-a',
    '--filter',
    'name=persistent-codex-wp',
    '--format',
    '{{.Names}}',
  ],
  { encoding: 'utf8' },
)
if (containers.status !== 0)
  throw new Error(`Cleanup inspection failed: ${containers.stderr}`)
if (containers.stdout.trim())
  throw new Error(
    `Temporary PostgreSQL containers remain: ${containers.stdout.trim()}`,
  )

console.log(
  JSON.stringify({
    phase3Acceptance: 'passed',
    mode: production ? 'production' : 'local-adversarial',
    realKata: production
      ? 'passed'
      : 'not-run; set PHASE3_PRODUCTION_ACCEPTANCE=1 with Kata prerequisites',
    realAwsKms: production
      ? 'passed'
      : 'not-run; set PHASE3_PRODUCTION_ACCEPTANCE=1 with AWS KMS key',
    mockDisclaimer:
      'local process and local-memory KMS are not production isolation evidence',
    credentialScan: 'passed',
    cleanup: 'passed',
  }) + '\n',
)
