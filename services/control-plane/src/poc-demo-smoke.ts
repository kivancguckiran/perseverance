import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  approvalListResponseSchema,
  replayResponseSchema,
  sessionResponseSchema,
  turnAcceptedResponseSchema,
} from '@perseverance/control-plane-contracts'
import { CodexEventAdapter } from '@perseverance/codex-event-adapter'
import type { TimelineEvent } from '@perseverance/domain-events'
import { SqliteEventStore } from '@perseverance/event-store'
import {
  CodexAppServerClient,
  createIsolatedCodexHome,
  type ProcessHealth,
  type WorkspaceRuntimeClient,
} from '@perseverance/workspace-agent'
import { buildControlPlane } from './server'

const timeoutMs = Number(process.env.CODEX_POC_DEMO_TIMEOUT_MS ?? 300_000)
const scenario = process.env.WP8_GOLDEN_SCENARIO ?? 'read-only'
const tenantId = 'ten_poc_demo'
let workspaceId = 'wsp_poc_demo_read'
let headers = { 'x-tenant-id': tenantId, 'x-workspace-id': workspaceId }
const root = mkdtempSync(join(tmpdir(), 'persistent-codex-poc-demo-'))
const workspaceCwd = join(root, 'workspace')
const databasePath = join(root, 'events.sqlite')
const codexHomeRoot = join(root, 'codex-homes')
const isolatedHome = createIsolatedCodexHome({
  sourceHome:
    process.env.CODEX_PROVISIONING_SOURCE ??
    process.env.CODEX_HOME ??
    join(homedir(), '.codex'),
  temporaryRoot: root,
  includeConfig: false,
})
mkdirSync(workspaceCwd)
writeFileSync(
  join(workspaceCwd, 'math.mjs'),
  'export const add = (left, right) => left + right\n',
)
writeFileSync(
  join(workspaceCwd, 'math.test.mjs'),
  "import assert from 'node:assert/strict'\nimport { add } from './math.mjs'\nassert.equal(add(2, 3), 5)\n",
)
writeFileSync(
  join(workspaceCwd, 'README.md'),
  '# Demo fixture\n\nA tiny, disposable repository for WP8.\n',
)
execFileSync('git', ['init', '--quiet'], { cwd: workspaceCwd })
execFileSync('git', ['add', '.'], { cwd: workspaceCwd })
execFileSync(
  'git',
  [
    '-c',
    'user.name=WP8 Demo',
    '-c',
    'user.email=wp8@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ],
  { cwd: workspaceCwd },
)

const store = new SqliteEventStore(databasePath)
class CountingRuntimeClient implements WorkspaceRuntimeClient {
  readonly inner = new CodexAppServerClient({
    cwd: workspaceCwd,
    env: { ...process.env, CODEX_HOME: isolatedHome.path },
    requestTimeoutMs: timeoutMs,
  })
  upstreamResponseCount = 0
  get health(): ProcessHealth {
    return this.inner.health
  }
  get processGeneration() {
    return this.inner.processGeneration
  }
  initialize(info: Parameters<WorkspaceRuntimeClient['initialize']>[0]) {
    return this.inner.initialize(info)
  }
  request<TResult = unknown>(
    method: string,
    params: unknown,
    options?: Parameters<WorkspaceRuntimeClient['request']>[2],
  ) {
    return this.inner.request<TResult>(method, params, options)
  }
  onNotification(
    listener: Parameters<WorkspaceRuntimeClient['onNotification']>[0],
  ) {
    return this.inner.onNotification(listener)
  }
  onServerRequest(
    listener: Parameters<WorkspaceRuntimeClient['onServerRequest']>[0],
  ) {
    return this.inner.onServerRequest(listener)
  }
  onHealthChange(
    listener: Parameters<
      NonNullable<WorkspaceRuntimeClient['onHealthChange']>
    >[0],
  ) {
    return this.inner.onHealthChange(listener)
  }
  stop() {
    return this.inner.stop()
  }
  respond(id: string | number, result: unknown) {
    this.upstreamResponseCount += 1
    this.inner.respond(id, result)
  }
}
const runtime = new CountingRuntimeClient()
const build = () =>
  buildControlPlane({
    allowExplicitDevAuthentication: true,
    eventStore: store,
    workspaceCwd,
    runtimeClientFactory: () => runtime,
    approvalPolicy: 'on-request',
  })
let app = await build()
const mark = (value: string) => process.stderr.write(`[wp8-demo] ${value}\n`)

async function poll<T>(read: () => Promise<T | undefined>, label: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 125))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function createSession() {
  const reply = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers,
    payload: {},
  })
  if (reply.statusCode !== 201) throw new Error(`Session failed: ${reply.body}`)
  return sessionResponseSchema.parse(reply.json())
}

async function replay(sessionId: string) {
  const reply = await app.inject({
    method: 'GET',
    url: `/v1/sessions/${sessionId}/events?after=0&limit=500`,
    headers,
  })
  return replayResponseSchema.parse(reply.json())
}

async function pending(sessionId: string) {
  const reply = await app.inject({
    method: 'GET',
    url: '/v1/approvals?status=pending',
    headers,
  })
  return approvalListResponseSchema
    .parse(reply.json())
    .approvals.find((approval) => approval.sessionId === sessionId)
}

async function decide(
  approval: NonNullable<Awaited<ReturnType<typeof pending>>>,
  decision: 'accept' | 'decline',
  key: string,
) {
  return app.inject({
    method: 'POST',
    url: `/v1/approvals/${approval.approvalId}/decision`,
    headers: { ...headers, 'idempotency-key': key },
    payload: {
      decision,
      expectedVersion: approval.version,
      clientContext: { deviceId: 'wp8-smoke', reason: null },
    },
  })
}

async function runGolden(
  session: Awaited<ReturnType<typeof createSession>>,
  name: string,
  prompt: string,
  options: { raceFirstApproval?: boolean } = {},
) {
  const turnReply = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${session.sessionId}/turns`,
    headers: { ...headers, 'idempotency-key': `wp8-${name}-turn` },
    payload: { prompt },
  })
  if (turnReply.statusCode !== 202)
    throw new Error(`${name} turn failed: ${turnReply.body}`)
  const turn = turnAcceptedResponseSchema.parse(turnReply.json())
  let race: { statuses: number[]; winnerCount: number } | undefined
  const handled = new Set<string>()
  const final = await poll(async () => {
    const approval = await pending(session.sessionId)
    if (approval && !handled.has(approval.approvalId)) {
      handled.add(approval.approvalId)
      if (options.raceFirstApproval && !race) {
        const replies = await Promise.all([
          decide(approval, 'accept', `wp8-${name}-race-a`),
          decide(approval, 'decline', `wp8-${name}-race-b`),
        ])
        const statuses = replies.map((reply) => reply.statusCode).sort()
        race = {
          statuses,
          winnerCount: statuses.filter((status) => status === 200).length,
        }
        if (statuses.join(',') !== '200,409')
          throw new Error(`Unexpected approval race: ${statuses}`)
      } else {
        const reply = await decide(
          approval,
          'accept',
          `wp8-${name}-${handled.size}`,
        )
        if (reply.statusCode !== 200)
          throw new Error(`Approval failed: ${reply.body}`)
      }
    }
    const page = await replay(session.sessionId)
    return page.events.some(
      (event) =>
        event.type === 'turn.completed' &&
        event.codexTurnId === turn.codexTurnId,
    )
      ? page
      : undefined
  }, `${name} terminal turn`)
  const types = [...new Set(final.events.map((event) => event.type))]
  const sequences = final.events.map((event) => event.sequence)
  const sequenceStart = sequences[0] ?? 0
  const contiguousSequences = sequences.every(
    (sequence, index) => sequence === sequenceStart + index,
  )
  if (
    !types.includes('agent.message.completed') ||
    !types.includes('turn.completed')
  )
    throw new Error(`${name} missed terminal timeline semantics`)
  return {
    sessionId: session.sessionId,
    codexThreadId: session.codexThreadId,
    codexTurnId: turn.codexTurnId,
    highWaterSequence: final.highWaterSequence,
    eventTypes: types,
    uniqueSequences:
      new Set(final.events.map((event) => event.sequence)).size ===
      final.events.length,
    uniqueEventIds:
      new Set(final.events.map((event) => event.eventId)).size ===
      final.events.length,
    contiguousSequences,
    monotonicSequences: sequences.every(
      (sequence, index) => index === 0 || sequence > sequences[index - 1]!,
    ),
    commandExitCodes: final.events
      .filter((event) => event.type === 'command.completed')
      .map((event) => event.payload.exitCode),
    approvalLifecycle: final.events
      .filter(
        (event) =>
          event.type === 'approval.requested' ||
          event.type === 'approval.resolved',
      )
      .map((event) => event.type),
    approvalRace: race,
  }
}

let evidence: Record<string, unknown> | undefined
try {
  await app.ready()
  mark('control plane ready')
  const cleanBefore = execFileSync('git', ['status', '--porcelain'], {
    cwd: workspaceCwd,
    encoding: 'utf8',
  })
  const prompts: Record<string, string> = {
    'read-only':
      'Read README.md and math.mjs without changing any file. Summarize the repository in exactly two short bullet points. You may run read-only commands.',
    change:
      'Add an exported subtract(left, right) function to math.mjs, add an assertion for subtract(5, 2) === 3 to math.test.mjs, then run node math.test.mjs. Finish with a concise summary.',
    approval:
      'Run exactly this harmless command once with escalated sandbox permissions so it requires user approval: printf WP8_APPROVAL_DEMO. Do not use another tool. Then summarize the result.',
  }
  if (!prompts[scenario]) throw new Error(`Unknown scenario: ${scenario}`)
  const result = await runGolden(
    await createSession(),
    scenario,
    prompts[scenario],
    {
      raceFirstApproval: scenario === 'approval',
    },
  )
  mark(`${scenario} golden complete`)
  if (!result.contiguousSequences || !result.monotonicSequences)
    throw new Error('Timeline sequence has a gap or regression')
  if (scenario === 'read-only') {
    const cleanAfter = execFileSync('git', ['status', '--porcelain'], {
      cwd: workspaceCwd,
      encoding: 'utf8',
    })
    if (cleanBefore !== '' || cleanAfter !== '')
      throw new Error('Read-only golden changed the fixture repository')
  }
  if (scenario === 'change') {
    if (
      !readFileSync(join(workspaceCwd, 'math.mjs'), 'utf8').includes('subtract')
    )
      throw new Error('Change missing')
    if (!result.eventTypes.includes('command.completed'))
      throw new Error('Test command missing')
    if (
      !readFileSync(join(workspaceCwd, 'math.test.mjs'), 'utf8').includes(
        'subtract(5, 2)',
      )
    )
      throw new Error('Subtract assertion missing')
    if (!result.commandExitCodes.includes(0))
      throw new Error('Targeted test command did not exit successfully')
    if (
      !result.eventTypes.some(
        (type) => type === 'diff.updated' || type === 'file.change.completed',
      )
    )
      throw new Error('Diff missing')
  }
  if (
    scenario === 'approval' &&
    (!result.approvalRace || result.approvalRace.winnerCount !== 1)
  )
    throw new Error('Approval race failed')
  if (scenario === 'approval') {
    if (result.approvalRace?.statuses.join(',') !== '200,409')
      throw new Error('Approval race must return 200/409')
    if (
      !result.approvalLifecycle.includes('approval.requested') ||
      !result.approvalLifecycle.includes('approval.resolved')
    )
      throw new Error('Approval requested/resolved lifecycle missing')
    if (runtime.upstreamResponseCount !== 1)
      throw new Error(
        `Expected one upstream response, got ${runtime.upstreamResponseCount}`,
      )
  }
  evidence = {
    ok: true,
    scenario,
    result,
    readOnlyFixtureUnchanged: scenario === 'read-only' ? true : null,
    upstreamApprovalResponses: runtime.upstreamResponseCount,
  }
} finally {
  mark('cleanup started')
  await app.close().catch(() => undefined)
  store.close()
  isolatedHome.cleanup()
  rmSync(root, { recursive: true, force: true })
}

if (evidence)
  process.stdout.write(
    `${JSON.stringify(
      {
        ...evidence,
        cleanup: {
          appServerStopped: runtime.health.state === 'stopped',
          databaseRemoved: !existsSync(databasePath),
          walRemoved: !existsSync(`${databasePath}-wal`),
          shmRemoved: !existsSync(`${databasePath}-shm`),
          artifactRootRemoved: !existsSync(join(root, 'artifacts')),
          workspaceRemoved: !existsSync(workspaceCwd),
          temporaryCodexHomeRemoved: !existsSync(isolatedHome.path),
          temporaryRootRemoved: !existsSync(root),
        },
      },
      null,
      2,
    )}\n`,
  )
