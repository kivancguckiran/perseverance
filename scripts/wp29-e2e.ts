import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { codexV2 } from '../packages/codex-protocol-generated/src/index'
import {
  CodexAppServerClient,
  createIsolatedCodexHome,
} from '../agents/workspace-agent/src/index'

const root = resolve(import.meta.dirname, '..')
const codexBin = process.env.WP29_CODEX_BIN
if (!codexBin) throw new Error('WP29_CODEX_BIN must point to Codex 0.144.2')
assert.match(
  execFileSync(codexBin, ['--version'], { encoding: 'utf8' }),
  /0\.144\.2/,
)
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown) =>
  JSON.stringify(value, Object.keys(value as object).sort())
const isolated = createIsolatedCodexHome({
  sourceHome:
    process.env.CODEX_PROVISIONING_SOURCE ?? join(homedir(), '.codex'),
  includeConfig: false,
})
const client = new CodexAppServerClient({
  command: codexBin,
  cwd: root,
  env: { ...process.env, CODEX_HOME: isolated.path },
  requestTimeoutMs: 240_000,
  restart: { maxRestarts: 0 },
})
let evidence: Record<string, unknown> | undefined
const notifications: any[] = []
let approvals = 0
client.onNotification((message) => notifications.push(message))
client.onServerRequest((message) => {
  const request = message as { method?: string; id?: number | string }
  if (request.method?.includes('requestApproval') && request.id !== undefined) {
    approvals += 1
    client.respond(request.id, { decision: 'accept' })
  }
})
const waitForTurn = async (turnId: string) => {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const completed = notifications.find(
      (message) =>
        message.method === 'turn/completed' &&
        message.params?.turn?.id === turnId,
    )
    if (completed) return completed
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Codex canary turn did not complete: ${turnId}`)
}
try {
  await client.initialize({
    name: 'wp29_canary',
    title: 'WP29 provider canary',
    version: '1',
  })
  const thread = await client.request<codexV2.ThreadStartResponse>(
    'thread/start',
    {
      cwd: root,
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
    } satisfies codexV2.ThreadStartParams,
  )
  const turn = await client.request<codexV2.TurnStartResponse>('turn/start', {
    threadId: thread.thread.id,
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [root],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    input: [
      {
        type: 'text',
        text: 'You must run `curl --max-time 5 https://example.com` with the shell tool. Request approval for network access when prompted, then answer exactly WP29_CANARY_COMPLETE even if curl is denied by the outer environment.',
        text_elements: [],
      },
    ],
  } satisfies codexV2.TurnStartParams)
  const firstCompleted = await waitForTurn(turn.turn.id)
  assert.equal(firstCompleted.params.turn.status, 'completed')
  for (let attempt = 0; approvals === 0 && attempt < 3; attempt++) {
    const probe = await client.request<codexV2.TurnStartResponse>(
      'turn/start',
      {
        threadId: thread.thread.id,
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [root],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        input: [
          {
            type: 'text',
            text: 'Approval canary: you must invoke the shell tool now and run exactly `printf WP29_APPROVAL_PROBE`. Do not answer until the tool call completes.',
            text_elements: [],
          },
        ],
      } satisfies codexV2.TurnStartParams,
    )
    const probeCompleted = await waitForTurn(probe.turn.id)
    assert.equal(probeCompleted.params.turn.status, 'completed')
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      notifications.some(
        (message) => message.method === 'thread/tokenUsage/updated',
      )
    )
      break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const methods = new Set(notifications.map(({ method }) => method))
  assert(methods.has('turn/started'))
  assert(methods.has('turn/completed'))
  const usage = [...methods].some((method) => method.includes('tokenUsage'))
  const protectedState = {
    conversation: thread.thread.id,
    events: notifications.length,
    approvals,
    billingUsageObserved: usage,
    migration: 'N',
  }
  const before = sha256(canonical(protectedState))
  const durableRollout = spawnSync('pnpm', ['wp29:rollout'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  })
  process.stdout.write(durableRollout.stdout)
  process.stderr.write(durableRollout.stderr)
  assert.equal(durableRollout.status, 0, 'durable PostgreSQL rollout failed')
  const durableLine = durableRollout.stdout
    .trim()
    .split('\n')
    .reverse()
    .find((line) => line.startsWith('{"gate":"wp29:rollout"'))
  assert(durableLine, 'durable rollout emitted no evidence')
  const rollback = JSON.parse(durableLine)
  assert.equal(rollback.rollout.state, 'rolled_back')
  assert.equal(rollback.dataLoss, 0)
  const after = sha256(canonical(protectedState))
  assert.equal(after, before)
  const continuation = await client.request<codexV2.TurnStartResponse>(
    'turn/start',
    {
      threadId: thread.thread.id,
      approvalPolicy: 'never',
      input: [
        {
          type: 'text',
          text: 'Reply exactly WP29_ROLLBACK_CONTINUATION_OK.',
          text_elements: [],
        },
      ],
    } satisfies codexV2.TurnStartParams,
  )
  const continuationCompleted = await waitForTurn(continuation.turn.id)
  assert.equal(continuationCompleted.params.turn.status, 'completed')
  const replay = await client.request<any>('thread/read', {
    threadId: thread.thread.id,
    includeTurns: true,
  })
  assert(approvals > 0, 'real command approval was not observed')
  assert.equal(usage, true, 'real token usage event was not observed')
  evidence = {
    gate: 'wp29:e2e',
    accepted: true,
    codexVersion: '0.144.2',
    realAppServer: true,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    threadStarted: Boolean(thread.thread.id),
    turnCompleted: true,
    replayTurns: replay.thread?.turns?.length ?? 0,
    approvalRequests: approvals,
    usageObserved: usage,
    rollbackState: rollback.rollout.state,
    durableRollout: true,
    durableRolloutEvidenceSha256: sha256(durableLine),
    rollbackIntegritySha256: after,
    conversationContinues:
      Boolean(replay.thread?.id) && (replay.thread?.turns?.length ?? 0) >= 2,
    externalProviders: {
      claude: 'not-run-no-explicit-credential',
      gemini: 'not-run-no-explicit-credential',
      cursor: 'not-run-no-explicit-credential',
    },
  }
} finally {
  await client.stop().catch(() => undefined)
  isolated.cleanup()
}
assert(evidence, 'WP29 E2E produced no evidence')
assert.equal(
  existsSync(isolated.path),
  false,
  'temporary Codex home was not cleaned',
)
evidence.temporaryCodexHomeCleaned = true
const evidenceDir = join(
  resolve(process.env.WP29_OUTPUT_DIR ?? join(root, '.wp29')),
  'evidence',
)
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'wp29-e2e.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
)
process.stdout.write(`${JSON.stringify(evidence)}\n`)
