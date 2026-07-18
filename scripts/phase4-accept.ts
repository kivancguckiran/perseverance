import { execFileSync } from 'node:child_process'

const codexBin =
  process.env.WP25_CODEX_BIN ??
  process.env.WP24_CODEX_BIN ??
  process.env.WP22_CODEX_BIN
if (!codexBin)
  throw new Error(
    'WP25_CODEX_BIN must point to the pinned Codex 0.144.2 binary',
  )
if (process.env.WP24_REAL_BILLING === '1')
  throw new Error(
    'WP24_REAL_BILLING was requested, but no real billing provider/MoR adapter is configured',
  )

const completed: string[] = []
const run = (script: string, env: NodeJS.ProcessEnv = process.env) => {
  execFileSync('pnpm', [script], { stdio: 'inherit', env })
  completed.push(script)
}

run('wp21:test')
run('wp21:postgres')
run('wp21:browser')
run('wp22:accept', { ...process.env, WP22_CODEX_BIN: codexBin })
run('wp23:accept')
run('wp24:test')
run('wp24:prepaid')
run('wp24:postgres')
run('wp24:e2e', { ...process.env, WP24_CODEX_BIN: codexBin })
run('wp24:browser', { ...process.env, WP24_CODEX_BIN: codexBin })
run('wp25:test')
run('wp25:postgres')
run('wp25:e2e')
run('wp25:browser')
run('verify')

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    gate: 'phase4:accept',
    codexVersion: '0.144.2',
    completed,
    billingProvider: 'deterministic-billing-emulator',
    realBillingProvider: 'not-run-no-provider-selected-or-credential',
    webPushProvider: 'emulator',
    sharedFolderCollaboration: 'verified-awaiting-independent-acceptance',
    realWebPushOptIn:
      process.env.WP23_REAL_WEB_PUSH === '1'
        ? 'requested-in-wp23-gate'
        : 'not-run-no-credential',
    productionCollectionEvidence: false,
    cleanup: {
      postgresContainers: true,
      postgresVolumes: true,
      browserContexts: true,
      managedCodexConfig: true,
      serviceWorkers: true,
      tempFiles: true,
    },
  })}\n`,
)
