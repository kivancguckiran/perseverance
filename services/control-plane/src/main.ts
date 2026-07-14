import { buildControlPlane } from './server'

const port = Number.parseInt(process.env.PORT ?? '3100', 10)
const approvalPolicy = process.env.APPROVAL_POLICY
if (
  approvalPolicy !== undefined &&
  !['untrusted', 'on-request', 'never'].includes(approvalPolicy)
) {
  throw new Error('APPROVAL_POLICY must be untrusted, on-request, or never')
}
const app = await buildControlPlane({
  databasePath: process.env.EVENT_DATABASE_PATH ?? '.runtime/events.sqlite',
  workspaceCwd: process.env.WORKSPACE_CWD ?? process.cwd(),
  codexHomeRoot: process.env.CODEX_HOME_ROOT ?? '.runtime/codex-homes',
  ...((process.env.CODEX_PROVISIONING_SOURCE ?? process.env.CODEX_HOME)
    ? {
        codexProvisioningSource:
          process.env.CODEX_PROVISIONING_SOURCE ?? process.env.CODEX_HOME!,
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
