import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  approvalListResponseSchema,
  approvalSchema,
  replayResponseSchema,
  sessionResponseSchema,
  turnAcceptedResponseSchema,
} from '@persistent-codex/control-plane-contracts'
import { SqliteEventStore } from '@persistent-codex/event-store'
import {
  CodexAppServerClient,
  createIsolatedCodexHome,
  type ProcessHealth,
  type WorkspaceRuntimeClient,
} from '@persistent-codex/workspace-agent'
import { buildControlPlane } from './server'

const timeoutMs = Number(process.env.CODEX_APPROVAL_SMOKE_TIMEOUT_MS ?? 120_000)
const tenantId = 'ten_smoke'
const workspaceId = 'wsp_smoke'
const headers = { 'x-tenant-id': tenantId, 'x-workspace-id': workspaceId }
const isolatedHome = createIsolatedCodexHome({ includeConfig: false })
const runtimeRoot = mkdtempSync(
  join(tmpdir(), 'persistent-approval-smoke-runtime-'),
)
const workspaceCwd = join(runtimeRoot, 'workspace')
const databasePath = join(runtimeRoot, 'events.sqlite')
mkdirSync(workspaceCwd)
const store = new SqliteEventStore(databasePath)

class CountingRuntimeClient implements WorkspaceRuntimeClient {
  readonly inner: CodexAppServerClient
  upstreamResponseCount = 0

  constructor() {
    this.inner = new CodexAppServerClient({
      cwd: workspaceCwd,
      env: { ...process.env, CODEX_HOME: isolatedHome.path },
      requestTimeoutMs: timeoutMs,
    })
  }

  get health(): ProcessHealth {
    return this.inner.health
  }
  get processGeneration(): number {
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
  respond(id: string | number, result: unknown): void {
    this.upstreamResponseCount += 1
    this.inner.respond(id, result)
  }
}

const client = new CountingRuntimeClient()
const app = await buildControlPlane({
  allowExplicitDevAuthentication: true,
  eventStore: store,
  workspaceCwd,
  runtimeClientFactory: () => client,
  runtimeInstanceIdFactory: () => 'runtime_real_approval_smoke',
  approvalPolicy: 'untrusted',
})

async function poll<T>(
  read: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label} (${timeoutMs} ms)`)
}

let result: Record<string, unknown> | undefined
try {
  await app.ready()
  const sessionReply = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers,
    payload: {},
  })
  if (sessionReply.statusCode !== 201)
    throw new Error(`Session failed: ${sessionReply.body}`)
  const session = sessionResponseSchema.parse(sessionReply.json())
  const turnReply = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${session.sessionId}/turns`,
    headers: { ...headers, 'idempotency-key': 'real-approval-smoke-turn' },
    payload: {
      prompt:
        'Run exactly this harmless command once: printf WP5_APPROVAL_SMOKE. Do not use another tool.',
    },
  })
  if (turnReply.statusCode !== 202)
    throw new Error(`Turn failed: ${turnReply.body}`)
  const turn = turnAcceptedResponseSchema.parse(turnReply.json())

  const approval = await poll(async () => {
    const reply = await app.inject({
      method: 'GET',
      url: '/v1/approvals?status=pending',
      headers,
    })
    const pending = approvalListResponseSchema.parse(reply.json()).approvals
    return pending.find(
      (candidate) => candidate.sessionId === session.sessionId,
    )
  }, 'durable pending approval')
  const upstreamResponsesBeforeDecision = client.upstreamResponseCount
  if (upstreamResponsesBeforeDecision !== 0) {
    throw new Error(
      `Expected zero responses before decision, got ${upstreamResponsesBeforeDecision}`,
    )
  }

  const decisionReply = await app.inject({
    method: 'POST',
    url: `/v1/approvals/${approval.approvalId}/decision`,
    headers: { ...headers, 'idempotency-key': 'real-approval-smoke-decision' },
    payload: {
      decision: 'decline',
      expectedVersion: approval.version,
      clientContext: { deviceId: 'real-smoke', reason: null },
    },
  })
  if (decisionReply.statusCode !== 200)
    throw new Error(`Decision failed: ${decisionReply.body}`)
  const resolved = approvalSchema.parse(decisionReply.json())
  await poll(async () => {
    const reply = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${session.sessionId}/events?after=0&limit=500`,
      headers,
    })
    const replay = replayResponseSchema.parse(reply.json())
    return replay.events.some(
      (event) =>
        event.type === 'turn.completed' &&
        event.codexTurnId === turn.codexTurnId,
    )
      ? true
      : undefined
  }, 'terminal turn')
  if (client.upstreamResponseCount !== 1) {
    throw new Error(
      `Expected one upstream response, got ${client.upstreamResponseCount}`,
    )
  }
  result = {
    ok: true,
    isolatedCodexHome: isolatedHome.path,
    databasePath,
    approvalId: approval.approvalId,
    pendingStatusObserved: approval.status,
    upstreamResponsesBeforeDecision,
    upstreamResponsesAfterDecision: client.upstreamResponseCount,
    resolvedStatus: resolved.status,
    selectedDecision: resolved.selectedDecision,
    terminalTurnObserved: true,
  }
} finally {
  await app.close().catch(() => undefined)
  store.close()
  isolatedHome.cleanup()
  rmSync(runtimeRoot, { recursive: true, force: true })
}

if (result) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ...result,
        isolatedCodexHomeCleaned: !existsSync(String(result.isolatedCodexHome)),
        databaseCleaned: !existsSync(String(result.databasePath)),
      },
      null,
      2,
    )}\n`,
  )
}
