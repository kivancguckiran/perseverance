import { buildControlPlane } from './server'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  runAlphaPreflight,
  type AlphaConfig,
} from '@persistent-codex/workspace-agent'

const port = Number.parseInt(process.env.PORT ?? '3100', 10)
const approvalPolicy = process.env.APPROVAL_POLICY
if (
  approvalPolicy !== undefined &&
  !['untrusted', 'on-request', 'never'].includes(approvalPolicy)
) {
  throw new Error('APPROVAL_POLICY must be untrusted, on-request, or never')
}
const localAlpha = process.env.PERSISTENT_CODEX_LOCAL_ALPHA === '1'
const provisioningSource =
  process.env.CODEX_PROVISIONING_SOURCE ??
  (localAlpha
    ? (process.env.CODEX_HOME ?? join(homedir(), '.codex'))
    : undefined)
const config: AlphaConfig = {
  databasePath: resolve(
    process.env.EVENT_DATABASE_PATH ?? '.runtime/alpha/events.sqlite',
  ),
  workspaceCwd: resolve(process.env.WORKSPACE_CWD ?? process.cwd()),
  codexHomeRoot: resolve(
    process.env.CODEX_HOME_ROOT ?? '.runtime/alpha/codex-homes',
  ),
  artifactRoot: resolve(
    process.env.ARTIFACT_ROOT ?? '.runtime/alpha/artifacts',
  ),
  codexBin: process.env.CODEX_BIN ?? 'codex',
  ...(provisioningSource ? { provisioningSource } : {}),
}
const preflightChecks = runAlphaPreflight(config)
const provisioningReady = !preflightChecks.some(
  (check) =>
    check.name === 'provisioning' &&
    check.status === 'failed' &&
    check.code !== 'AUTH_CONFIG_MISSING',
)
const app = await buildControlPlane({
  databasePath: config.databasePath,
  workspaceCwd: config.workspaceCwd,
  codexHomeRoot: config.codexHomeRoot,
  artifactRoot: config.artifactRoot,
  preflightChecks,
  ...(provisioningSource && provisioningReady
    ? {
        codexProvisioningSource: provisioningSource,
      }
    : {}),
  logger: true,
  ...(approvalPolicy
    ? {
        approvalPolicy: approvalPolicy as 'untrusted' | 'on-request' | 'never',
      }
    : {}),
})

await app.listen({ host: '127.0.0.1', port })
