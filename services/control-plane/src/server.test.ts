import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { LocalArtifactStorage } from '@persistent-codex/artifact-storage'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ProcessHealth,
  WorkspaceRuntimeClient,
} from '@persistent-codex/workspace-agent'
import { RequestTimeoutError } from '@persistent-codex/workspace-agent'
import type { TimelineEvent } from '@persistent-codex/domain-events'
import {
  serverMessageSchema,
  sessionResponseSchema,
  type ServerMessage,
} from '@persistent-codex/control-plane-contracts'
import {
  SqliteEventStore,
  type StoreScope,
} from '@persistent-codex/event-store'
import {
  BoundedRealtimeSender,
  buildControlPlane,
  type ControlPlaneOptions,
} from './server'

const scope: StoreScope = {
  tenantId: 'ten_test',
  workspaceId: 'wsp_test',
  sessionId: 'ses_test',
}
const headers = {
  'x-tenant-id': scope.tenantId,
  'x-workspace-id': scope.workspaceId,
}
describe('bounded realtime sender', () => {
  it('bounds a slow socket and emits one typed resync', async () => {
    const sent: string[] = []
    const socket = {
      bufferedAmount: 10_000,
      send: (data: string) => sent.push(data),
    }
    const sender = new BoundedRealtimeSender(socket, 4, 1024)
    sender.updateCursor({ ...scope, afterSequence: 7, highWaterSequence: 12 })
    for (let index = 0; index < 20; index++)
      sender.enqueue({
        type: 'event',
        ...scope,
        event: { ...event(`slow_${index}`), sequence: index + 8 },
      })
    expect(sender.counters.events).toBeLessThanOrEqual(4)
    expect(sender.counters.bytes).toBeLessThanOrEqual(1024)
    socket.bufferedAmount = 0
    await new Promise((resolve) => setTimeout(resolve, 15))
    const messages = sent.map((value) =>
      serverMessageSchema.parse(JSON.parse(value)),
    )
    expect(
      messages.filter((message) => message.type === 'resync'),
    ).toHaveLength(1)
    expect(messages.find((message) => message.type === 'resync')).toMatchObject(
      { reason: 'queue_overflow', afterSequence: 7, highWaterSequence: 12 },
    )
  })
})

function event(eventId: string): TimelineEvent {
  return {
    eventId,
    schemaVersion: 1,
    ...scope,
    sequence: 0,
    occurredAt: '2026-07-14T00:00:00.000Z',
    receivedAt: '2026-07-14T00:00:00.001Z',
    source: 'codex-app-server',
    sourceVersion: '0.144.2',
    sourceMethod: 'item/agentMessage/delta',
    type: 'agent.message.delta',
    visibility: 'user',
    payload: { text: eventId },
  }
}

describe('artifact API', () => {
  it('serves scoped metadata, ranges and opaque download grants', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'artifact-api-'))
    const store = new SqliteEventStore(join(directory, 'events.sqlite'))
    store.createSession(scope)
    const storage = new LocalArtifactStorage(join(directory, 'artifacts'))
    const artifactScope = { ...scope, turnId: 'turn_a', itemId: 'item_a' }
    const created = storage.create(artifactScope)
    storage.append({
      artifactId: created.artifactId,
      scope: artifactScope,
      chunkIndex: 0,
      stream: 'combined',
      data: 'hello secret sk-ABCDEFGHIJK done',
    })
    const final = storage.finalize(created.artifactId, artifactScope)
    store.upsertArtifact({ ...final })
    const app = await buildControlPlane({
      eventStore: store,
      artifactRoot: join(directory, 'artifacts'),
    })
    try {
      const metadata = await app.inject({
        method: 'GET',
        url: `/v1/artifacts/${created.artifactId}?metadata=1`,
        headers,
      })
      expect(metadata.statusCode).toBe(200)
      expect(metadata.json()).not.toHaveProperty('path')
      const range = await app.inject({
        method: 'GET',
        url: `/v1/artifacts/${created.artifactId}`,
        headers: { ...headers, range: 'bytes=0-4' },
      })
      expect(range.statusCode).toBe(206)
      expect(range.body).toBe('hello')
      expect(range.headers['content-range']).toBe(
        `bytes 0-4/${final.byteLength}`,
      )
      const denied = await app.inject({
        method: 'GET',
        url: `/v1/artifacts/${created.artifactId}`,
        headers: { ...headers, 'x-tenant-id': 'other' },
      })
      expect(denied.statusCode).toBe(404)
      const grant = await app.inject({
        method: 'POST',
        url: `/v1/artifacts/${created.artifactId}/download-token`,
        headers,
      })
      expect(grant.statusCode).toBe(200)
      const download = await app.inject({
        method: 'GET',
        url: grant.json().downloadUrl,
      })
      expect(download.statusCode).toBe(200)
      expect(download.body).not.toContain('ABCDEFGHIJK')
      expect(download.headers['content-disposition']).toContain('attachment')
    } finally {
      await app.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function ingest(store: SqliteEventStore, key: string): TimelineEvent {
  return store.ingest({
    ...scope,
    ingestKey: key,
    raw: {
      envelope: { method: 'item/agentMessage/delta', params: { delta: key } },
      checksum: `checksum-${key}`,
      sourceMethod: 'item/agentMessage/delta',
      sourceVersion: '0.144.2',
      receivedAt: '2026-07-14T00:00:00.001Z',
    },
    event: event(`evt_${key}`),
  }).event
}

interface TestSocket {
  send(data: string): void
  close(): void
  on(event: 'message', listener: (data: { toString(): string }) => void): void
}

function messageReader(socket: TestSocket): { next(): Promise<ServerMessage> } {
  const queue: ServerMessage[] = []
  const waiters: Array<(message: ServerMessage) => void> = []
  socket.on('message', (data) => {
    const message = serverMessageSchema.parse(JSON.parse(data.toString()))
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else queue.push(message)
  })
  return {
    next() {
      const queued = queue.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for WebSocket message')),
          2_000,
        )
        waiters.push((message) => {
          clearTimeout(timeout)
          resolve(message)
        })
      })
    },
  }
}

let app: FastifyInstance | undefined
let store: SqliteEventStore | undefined
const sockets: TestSocket[] = []

async function setup(
  options: Omit<ControlPlaneOptions, 'eventStore'> = {},
): Promise<SqliteEventStore> {
  store = new SqliteEventStore()
  store.createSession(scope)
  app = await buildControlPlane({ eventStore: store, ...options })
  await app.ready()
  return store
}

class FakeRuntimeClient implements WorkspaceRuntimeClient {
  processGeneration = 1
  health: ProcessHealth = { state: 'stopped', restartAttempt: 0 }
  initializeCalls = 0
  turnStartCalls = 0
  failThreadStart = false
  snapshotTurns: unknown[] = []
  readonly requests: string[] = []
  readonly responses: Array<{ id: string | number; result: unknown }> = []
  readonly #notifications = new Set<
    (message: Record<string, unknown>) => void
  >()
  readonly #serverRequests = new Set<
    (message: Record<string, unknown>) => void
  >()
  readonly #healthListeners = new Set<(health: ProcessHealth) => void>()
  readonly fixture: {
    threadId: string
    turnId: string
    itemId: string
    delta: string
    finalText: string
  }

  constructor(fixture: Partial<FakeRuntimeClient['fixture']> = {}) {
    this.fixture = {
      threadId: 'thr_live',
      turnId: 'turn_live',
      itemId: 'msg_live',
      delta: 'taslak',
      finalText: 'Yetkili final',
      ...fixture,
    }
  }

  async initialize() {
    this.initializeCalls += 1
    this.health = { state: 'ready', restartAttempt: 0 }
    return {}
  }

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    this.requests.push(method)
    if (method === 'thread/start') {
      if (this.failThreadStart) throw new Error('fixture thread failure')
      return { thread: { id: this.fixture.threadId } } as TResult
    }
    if (method === 'turn/start') {
      this.turnStartCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      const input = params as { threadId: string }
      const identity = {
        threadId: input.threadId,
        turnId: this.fixture.turnId,
        itemId: this.fixture.itemId,
      }
      queueMicrotask(() => {
        this.emitNotification({
          method: 'turn/started',
          params: {
            threadId: input.threadId,
            turn: {
              id: this.fixture.turnId,
              status: 'inProgress',
              items: [],
              error: null,
            },
          },
        })
        this.emitNotification({
          method: 'item/agentMessage/delta',
          params: { ...identity, delta: this.fixture.delta },
        })
        this.emitNotification({
          method: 'item/completed',
          params: {
            threadId: input.threadId,
            turnId: this.fixture.turnId,
            item: {
              type: 'agentMessage',
              id: this.fixture.itemId,
              text: this.fixture.finalText,
              phase: null,
              memoryCitation: null,
            },
            completedAtMs: 1,
          },
        })
        this.emitNotification({
          method: 'future/notification',
          params: { threadId: input.threadId, value: true },
        })
        this.emitServerRequest({
          id: 77,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: input.threadId,
            turnId: this.fixture.turnId,
            itemId: 'cmd_live',
            startedAtMs: 1,
            approvalId: null,
            environmentId: null,
            reason: 'fixture approval',
            command: 'echo fixture',
            cwd: '/workspace',
            commandActions: null,
            proposedExecpolicyAmendment: null,
            proposedNetworkPolicyAmendments: null,
          },
        })
        this.emitNotification({
          method: 'turn/completed',
          params: {
            threadId: input.threadId,
            turn: {
              id: this.fixture.turnId,
              status: 'completed',
              items: [],
              error: null,
            },
          },
        })
      })
      return {
        turn: {
          id: this.fixture.turnId,
          status: 'inProgress',
          items: [],
          error: null,
        },
      } as TResult
    }
    if (method === 'thread/read' || method === 'thread/resume') {
      return {
        thread: {
          id: this.fixture.threadId,
          turns: this.snapshotTurns,
        },
      } as TResult
    }
    if (method === 'turn/steer') {
      return {
        turnId: (params as { expectedTurnId: string }).expectedTurnId,
      } as TResult
    }
    if (method === 'turn/interrupt') return {} as TResult
    throw new Error(`Unexpected method ${method}`)
  }

  onNotification(listener: (message: Record<string, unknown>) => void) {
    this.#notifications.add(listener)
    return () => this.#notifications.delete(listener)
  }

  onServerRequest(listener: (message: Record<string, unknown>) => void) {
    this.#serverRequests.add(listener)
    return () => this.#serverRequests.delete(listener)
  }

  onHealthChange(listener: (health: ProcessHealth) => void) {
    this.#healthListeners.add(listener)
    return () => this.#healthListeners.delete(listener)
  }

  respond(id: string | number, result: unknown) {
    this.responses.push({ id, result })
  }

  async stop() {
    this.health = { state: 'stopped', restartAttempt: 0 }
    this.emitHealth()
  }

  emitNotification(message: Record<string, unknown>) {
    for (const listener of this.#notifications) listener(message)
  }

  emitServerRequest(message: Record<string, unknown>) {
    for (const listener of this.#serverRequests) listener(message)
  }

  setHealth(
    state: ProcessHealth['state'],
    generation = this.processGeneration,
  ) {
    this.processGeneration = generation
    this.health = { state, restartAttempt: 0 }
    this.emitHealth()
  }

  private emitHealth() {
    for (const listener of this.#healthListeners) listener(this.health)
  }
}

async function connect(): Promise<{
  socket: TestSocket
  reader: ReturnType<typeof messageReader>
}> {
  if (!app) throw new Error('Control plane is not initialized')
  const socket = (await app.injectWS('/v1/realtime')) as unknown as TestSocket
  sockets.push(socket)
  return { socket, reader: messageReader(socket) }
}

function subscribe(socket: TestSocket, afterSequence = 0): void {
  socket.send(JSON.stringify({ type: 'subscribe', ...scope, afterSequence }))
}

async function waitForApprovals(expected: number, status = 'pending') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app!.inject({
      method: 'GET',
      url: `/v1/approvals?status=${status}`,
      headers,
    })
    const approvals = response.json().approvals as Array<
      Record<string, unknown>
    >
    if (approvals.length >= expected) return approvals
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${expected} ${status} approvals`)
}

function commandApproval(
  client: FakeRuntimeClient,
  id: string | number,
  itemId: string,
) {
  client.emitServerRequest({
    id,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: client.fixture.threadId,
      turnId: 'turn_approval',
      itemId,
      startedAtMs: 1,
      approvalId: null,
      environmentId: null,
      reason: 'Bearer secret-token-value',
      command: 'curl example.test',
      cwd: '/workspace',
      commandActions: [{ type: 'unknown', command: 'curl example.test' }],
      networkApprovalContext: { host: 'example.test', protocol: 'https' },
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
    },
  })
}

function fileApproval(
  client: FakeRuntimeClient,
  id: string | number,
  itemId: string,
  withDiff = true,
) {
  if (withDiff) {
    client.emitNotification({
      method: 'item/started',
      params: {
        threadId: client.fixture.threadId,
        turnId: 'turn_approval',
        startedAtMs: 1,
        item: {
          type: 'fileChange',
          id: itemId,
          status: 'inProgress',
          changes: [
            {
              path: 'src/safe.ts',
              kind: { type: 'update', move_path: null },
              diff: '@@ -1 +1 @@\n-old\n+new',
            },
          ],
        },
      },
    })
  }
  client.emitServerRequest({
    id,
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: client.fixture.threadId,
      turnId: 'turn_approval',
      itemId,
      startedAtMs: 2,
      reason: 'write required',
      grantRoot: '/workspace/src',
    },
  })
}

async function decide(
  approval: { approvalId: string; version: number },
  decision: string,
  key: string,
) {
  return app!.inject({
    method: 'POST',
    url: `/v1/approvals/${approval.approvalId}/decision`,
    headers: { ...headers, 'idempotency-key': key },
    payload: {
      decision,
      expectedVersion: approval.version,
      clientContext: { deviceId: key, reason: null },
    },
  })
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await app?.close()
  store?.close()
  app = undefined
  store = undefined
})

describe('control plane REST replay', () => {
  it('reports the pinned Codex protocol metadata', async () => {
    await setup()
    const response = await app!.inject({ method: 'GET', url: '/v1/meta' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      codexVersion: '0.144.2',
      transport: 'stdio-jsonl',
    })
  })

  it('returns an ordered limited replay with cursor metadata', async () => {
    const current = await setup()
    ingest(current, 'one')
    ingest(current, 'two')
    ingest(current, 'three')
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_test/events?after=1&limit=1',
      headers,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      highWaterSequence: 3,
      nextAfterSequence: 2,
      hasMore: true,
      events: [{ sequence: 2 }],
    })
  })

  it('returns explicit 4xx errors for invalid input and unknown scope', async () => {
    await setup()
    const invalidCursor = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_test/events?after=1x',
      headers,
    })
    expect(invalidCursor.statusCode).toBe(400)
    expect(invalidCursor.json()).toMatchObject({ code: 'INVALID_CURSOR' })

    const invalidLimit = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_test/events?limit=501',
      headers,
    })
    expect(invalidLimit.statusCode).toBe(400)
    expect(invalidLimit.json()).toMatchObject({ code: 'INVALID_LIMIT' })

    const missingScope = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_test/events',
    })
    expect(missingScope.statusCode).toBe(400)
    expect(missingScope.json()).toMatchObject({ code: 'MISSING_SCOPE' })

    const unknownTenant = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_test/events',
      headers: { ...headers, 'x-tenant-id': 'ten_other' },
    })
    expect(unknownTenant.statusCode).toBe(404)
    expect(unknownTenant.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })
})

describe('durable approval API', () => {
  it('keeps approval pending until an idempotent decision sends one upstream response', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_approval',
    })
    const created = await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    expect(created.statusCode).toBe(201)
    client.emitServerRequest({
      id: 91,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: client.fixture.threadId,
        turnId: 'turn_approval',
        itemId: 'cmd_approval',
        startedAtMs: 1,
        approvalId: null,
        environmentId: null,
        reason: 'safe fixture',
        command: 'echo safe',
        cwd: '/workspace',
        commandActions: [],
        networkApprovalContext: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const pending = await app!.inject({
      method: 'GET',
      url: '/v1/approvals?status=pending',
      headers,
    })
    expect(pending.statusCode).toBe(200)
    const approval = pending.json().approvals[0]
    expect(approval).toMatchObject({
      status: 'pending',
      kind: 'command_execution',
      version: 1,
    })
    expect(client.responses).toHaveLength(0)
    const decision = {
      decision: 'accept_for_session',
      expectedVersion: 1,
      clientContext: { deviceId: 'device-1', reason: null },
    }
    const first = await app!.inject({
      method: 'POST',
      url: `/v1/approvals/${approval.approvalId}/decision`,
      headers: { ...headers, 'idempotency-key': 'decision-1' },
      payload: decision,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({
      status: 'resolved',
      selectedDecision: 'accept_for_session',
    })
    expect(client.responses).toEqual([
      { id: 91, result: { decision: 'acceptForSession' } },
    ])
    const retry = await app!.inject({
      method: 'POST',
      url: `/v1/approvals/${approval.approvalId}/decision`,
      headers: { ...headers, 'idempotency-key': 'decision-1' },
      payload: decision,
    })
    expect(retry.statusCode).toBe(200)
    expect(client.responses).toHaveLength(1)
    const conflict = await app!.inject({
      method: 'POST',
      url: `/v1/approvals/${approval.approvalId}/decision`,
      headers: { ...headers, 'idempotency-key': 'decision-1' },
      payload: { ...decision, decision: 'decline' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_HASH_CONFLICT' })
    const isolated = await app!.inject({
      method: 'GET',
      url: `/v1/approvals/${approval.approvalId}`,
      headers: { ...headers, 'x-tenant-id': 'other' },
    })
    expect(isolated.statusCode).toBe(404)
  })

  it('ingests generated file approval with scoped diff context and redacts command context', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_context',
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    commandApproval(client, 'command-context', 'cmd_context')
    fileApproval(client, 'file-context', 'file_context')
    fileApproval(client, 'file-unavailable', 'file_unavailable', false)
    const approvals = await waitForApprovals(3)
    const command = approvals.find(
      (approval) => approval.itemId === 'cmd_context',
    )!
    expect(command.context).toMatchObject({
      reason: '[REDACTED]',
      commandActions: [{ type: 'unknown', command: 'curl example.test' }],
      networkApprovalContext: { host: 'example.test', protocol: 'https' },
    })
    expect(JSON.stringify(command)).not.toContain('secret-token-value')
    const file = approvals.find(
      (approval) => approval.itemId === 'file_context',
    )!
    expect(file.context).toMatchObject({
      filePath: 'src/safe.ts',
      diffAvailable: true,
    })
    expect(String((file.context as Record<string, unknown>).diff)).toContain(
      '+new',
    )
    const unavailable = approvals.find(
      (approval) => approval.itemId === 'file_unavailable',
    )!
    expect(unavailable.context).toMatchObject({
      filePath: null,
      diff: null,
      diffAvailable: false,
    })
  })

  it('maps all four public decisions for command and file approvals', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_mapping',
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    const decisions = [
      'accept',
      'accept_for_session',
      'decline',
      'cancel',
    ] as const
    for (const [index, decision] of decisions.entries()) {
      commandApproval(client, `command-${index}`, `cmd_${index}`)
      fileApproval(client, `file-${index}`, `file_${index}`, false)
    }
    const approvals = await waitForApprovals(8)
    for (const [index, decision] of decisions.entries()) {
      for (const itemId of [`cmd_${index}`, `file_${index}`]) {
        const approval = approvals.find(
          (candidate) => candidate.itemId === itemId,
        )! as { approvalId: string; version: number }
        const response = await decide(approval, decision, `mapping-${itemId}`)
        expect(response.statusCode).toBe(200)
      }
    }
    expect(client.responses.map(({ result }) => result)).toEqual(
      decisions.flatMap((decision) =>
        Array(2).fill({
          decision:
            decision === 'accept_for_session' ? 'acceptForSession' : decision,
        }),
      ),
    )
  })

  it('allows one concurrent winner and sends exactly one response', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_race',
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    commandApproval(client, 201, 'cmd_race')
    const [approval] = (await waitForApprovals(1)) as unknown as Array<{
      approvalId: string
      version: number
    }>
    const [first, second] = await Promise.all([
      decide(approval!, 'accept', 'race-a'),
      decide(approval!, 'decline', 'race-b'),
    ])
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409])
    expect([first.json().code, second.json().code]).toContain(
      'APPROVAL_ALREADY_RESOLVED',
    )
    expect(client.responses).toHaveLength(1)
  })

  it('blocks stale runtime/generation and expires approvals on health failure and turn completion', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_lifecycle',
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    store!.ingest({
      ...scope,
      ingestKey: 'runtime-mismatch-approval',
      raw: {
        envelope: {
          id: 300,
          method: 'item/commandExecution/requestApproval',
          params: {},
        },
        checksum: 'runtime-mismatch-checksum',
        sourceMethod: 'item/commandExecution/requestApproval',
        sourceVersion: '0.144.2',
        receivedAt: '2026-07-14T00:00:00.001Z',
      },
      event: event('evt_runtime_mismatch'),
      approval: {
        ...scope,
        approvalId: 'apr_runtime_mismatch',
        turnId: 'turn_approval',
        itemId: 'cmd_runtime_mismatch',
        requestId: 300,
        runtimeInstanceId: 'different_runtime',
        processGeneration: 1,
        kind: 'command_execution',
        context: {},
        availableDecisions: ['decline'],
        requestedAt: '2026-07-14T00:00:00.000Z',
      },
    })
    const mismatch = await decide(
      { approvalId: 'apr_runtime_mismatch', version: 1 },
      'decline',
      'runtime-mismatch',
    )
    expect(mismatch.statusCode).toBe(409)
    expect(mismatch.json()).toMatchObject({
      code: 'APPROVAL_RUNTIME_UNAVAILABLE',
    })
    expect(client.responses).toHaveLength(0)

    commandApproval(client, 301, 'cmd_generation')
    let approvals = await waitForApprovals(1)
    client.setHealth('ready', 2)
    await waitForApprovals(1, 'expired')
    const stale = await decide(
      approvals[0] as never,
      'decline',
      'stale-generation',
    )
    expect(stale.statusCode).toBe(409)
    expect(client.responses).toHaveLength(0)

    commandApproval(client, 302, 'cmd_crash')
    await waitForApprovals(1)
    client.setHealth('failed', 2)
    expect(
      (await waitForApprovals(2, 'expired')).map((item) => item.itemId),
    ).toContain('cmd_crash')

    client.setHealth('ready', 2)
    commandApproval(client, 303, 'cmd_completion')
    await waitForApprovals(1)
    client.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: client.fixture.threadId,
        turn: {
          id: 'turn_approval',
          status: 'interrupted',
          items: [],
          error: null,
        },
      },
    })
    expect(
      (await waitForApprovals(1, 'superseded')).map((item) => item.itemId),
    ).toContain('cmd_completion')
    expect(client.responses).toHaveLength(0)
  })

  it('reconciles serverRequest/resolved without a second upstream response', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_resolved',
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    commandApproval(client, 401, 'cmd_resolved')
    const [approval] = (await waitForApprovals(1)) as unknown as Array<{
      approvalId: string
      version: number
    }>
    expect(
      (await decide(approval!, 'decline', 'resolved-decision')).statusCode,
    ).toBe(200)
    expect(client.responses).toHaveLength(1)
    client.emitNotification({
      method: 'serverRequest/resolved',
      params: { threadId: client.fixture.threadId, requestId: 401 },
    })
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const detail = await app!.inject({
        method: 'GET',
        url: `/v1/approvals/${approval!.approvalId}`,
        headers,
      })
      if (detail.json().upstreamResponseStatus === 'acknowledged') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const detail = await app!.inject({
      method: 'GET',
      url: `/v1/approvals/${approval!.approvalId}`,
      headers,
    })
    expect(detail.json()).toMatchObject({
      status: 'resolved',
      upstreamResponseStatus: 'acknowledged',
    })
    expect(client.responses).toHaveLength(1)
  })
})

describe('control plane WebSocket replay/live stream', () => {
  it('streams pending, resolving, and resolved approval lifecycle and supports REST reconciliation', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_ws_approval',
      sessionIdFactory: () => scope.sessionId,
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    const { socket, reader } = await connect()
    subscribe(socket)
    await reader.next()
    await reader.next()
    commandApproval(client, 501, 'cmd_ws')
    let pendingMessage: ServerMessage | undefined
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const message = await reader.next()
      if (message.type === 'approval') {
        pendingMessage = message
        break
      }
    }
    expect(pendingMessage).toMatchObject({
      type: 'approval',
      approval: { status: 'pending' },
    })
    if (pendingMessage?.type !== 'approval')
      throw new Error('Pending approval message missing')
    const decisionPromise = decide(
      pendingMessage.approval,
      'decline',
      'ws-decision',
    )
    expect(await reader.next()).toMatchObject({
      type: 'approval',
      approval: { status: 'resolving' },
    })
    expect(await reader.next()).toMatchObject({
      type: 'approval',
      approval: { status: 'resolved' },
    })
    expect((await decisionPromise).statusCode).toBe(200)
    commandApproval(client, 502, 'cmd_ws_expired')
    let expiringPending: ServerMessage | undefined
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const message = await reader.next()
      if (
        message.type === 'approval' &&
        message.approval.itemId === 'cmd_ws_expired'
      ) {
        expiringPending = message
        break
      }
    }
    expect(expiringPending).toMatchObject({
      type: 'approval',
      approval: { itemId: 'cmd_ws_expired', status: 'pending' },
    })
    client.setHealth('failed')
    let expiredMessage: ServerMessage | undefined
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const message = await reader.next()
      if (message.type === 'approval') {
        expiredMessage = message
        break
      }
    }
    expect(expiredMessage).toMatchObject({
      type: 'approval',
      approval: { itemId: 'cmd_ws_expired', status: 'expired' },
    })
    socket.close()
    const reconciled = await app!.inject({
      method: 'GET',
      url: '/v1/approvals?status=resolved',
      headers,
    })
    expect(reconciled.json().approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'cmd_ws', status: 'resolved' }),
      ]),
    )
  })

  it('delivers a publish at the replay/live boundary without a gap or duplicate', async () => {
    const current = await setup()
    ingest(current, 'one')
    ingest(current, 'two')
    const { socket, reader } = await connect()
    subscribe(socket)

    const replay = await reader.next()
    expect(replay).toMatchObject({
      type: 'replay',
      highWaterSequence: 2,
      events: [{ sequence: 1 }, { sequence: 2 }],
    })
    ingest(current, 'during-replay')
    expect(await reader.next()).toMatchObject({
      type: 'subscribed',
      highWaterSequence: 2,
    })
    const live = await reader.next()
    expect(live).toMatchObject({ type: 'event', event: { sequence: 3 } })

    const delivered = [
      ...(replay.type === 'replay'
        ? replay.events.map(({ sequence }) => sequence)
        : []),
      ...(live.type === 'event' ? [live.event.sequence] : []),
    ]
    expect(delivered).toEqual([1, 2, 3])
    expect(new Set(delivered).size).toBe(delivered.length)
  })

  it('reconnects from the client cursor and returns only missing events', async () => {
    const current = await setup()
    ingest(current, 'one')
    ingest(current, 'two')
    ingest(current, 'three')
    const first = await connect()
    subscribe(first.socket, 1)
    const replay = await first.reader.next()
    expect(replay).toMatchObject({
      type: 'replay',
      events: [{ sequence: 2 }, { sequence: 3 }],
    })
    await first.reader.next()
    first.socket.close()

    ingest(current, 'four')
    const reconnect = await connect()
    subscribe(reconnect.socket, 3)
    expect(await reconnect.reader.next()).toMatchObject({
      type: 'replay',
      events: [{ sequence: 4 }],
    })
  })

  it('enforces monotonic, in-scope, non-ahead acknowledgements', async () => {
    const current = await setup()
    ingest(current, 'one')
    ingest(current, 'two')
    const { socket, reader } = await connect()
    subscribe(socket)
    await reader.next()
    await reader.next()

    socket.send(JSON.stringify({ type: 'ack', ...scope, sequence: 2 }))
    expect(await reader.next()).toMatchObject({ type: 'ack', sequence: 2 })

    socket.send(JSON.stringify({ type: 'ack', ...scope, sequence: 1 }))
    expect(await reader.next()).toMatchObject({
      type: 'error',
      code: 'ACK_REGRESSION',
    })

    socket.send(
      JSON.stringify({
        type: 'ack',
        ...scope,
        workspaceId: 'wsp_other',
        sequence: 2,
      }),
    )
    expect(await reader.next()).toMatchObject({
      type: 'error',
      code: 'ACK_SCOPE_MISMATCH',
    })

    socket.send(JSON.stringify({ type: 'ack', ...scope, sequence: 3 }))
    expect(await reader.next()).toMatchObject({
      type: 'error',
      code: 'ACK_AHEAD',
    })
  })

  it('rejects subscriptions outside the tenant/workspace/session scope', async () => {
    await setup()
    const { socket, reader } = await connect()
    socket.send(
      JSON.stringify({
        type: 'subscribe',
        ...scope,
        tenantId: 'ten_other',
        afterSequence: 0,
      }),
    )
    expect(await reader.next()).toMatchObject({
      type: 'error',
      code: 'SESSION_NOT_FOUND',
    })
  })
})

describe('WP4 session, turn and live event flow', () => {
  const liveHeaders = {
    'content-type': 'application/json',
    'x-tenant-id': 'ten_live',
    'x-workspace-id': 'wsp_live',
  }

  async function setupLive(client: FakeRuntimeClient) {
    const current = await setup({
      workspaceCwd: '/server/configured/workspace',
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_live',
    })
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: liveHeaders,
      payload: {},
    })
    return { current, response }
  }

  it('streams a controlled 100 MiB command through adapter, SQLite and artifact metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp7-e2e-'))
    const client = new FakeRuntimeClient()
    const current = await setup({
      workspaceCwd: '/workspace',
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_live',
      artifactRoot: join(directory, 'artifacts'),
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: liveHeaders,
      payload: {},
    })
    const hash = createHash('sha256')
    const sourceBytes = 1024 * 1024
    for (let index = 0; index < 100; index++) {
      const chunk =
        `${String(index).padStart(4, '0')}:`.padEnd(sourceBytes - 1, 'x') + '\n'
      hash.update(chunk)
      client.emitNotification({
        method: 'item/commandExecution/outputDelta',
        params: {
          threadId: 'thr_live',
          turnId: 'turn_big',
          itemId: 'cmd_big',
          delta: chunk,
        },
      })
    }
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thr_live',
        turnId: 'turn_big',
        item: {
          type: 'commandExecution',
          id: 'cmd_big',
          command: 'big-output',
          cwd: '/workspace',
          processId: 'proc_big',
          source: 'agent',
          commandActions: [],
          status: 'completed',
          aggregatedOutput: '',
          exitCode: 0,
          durationMs: 1,
        },
        completedAtMs: 1,
      },
    })
    let artifact
    for (let attempt = 0; attempt < 1200; attempt++) {
      artifact = current.listArtifacts({
        tenantId: 'ten_live',
        workspaceId: 'wsp_live',
      })[0]
      if (artifact?.finalized) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (!artifact?.finalized)
      throw new Error(
        JSON.stringify({
          artifact,
          eventTypes: current
            .replaySessionEvents(
              {
                tenantId: 'ten_live',
                workspaceId: 'wsp_live',
                sessionId: 'ses_live',
              },
              0,
              500,
            )
            .events.map((event) => event.type),
        }),
      )
    expect(artifact).toMatchObject({
      finalized: true,
      status: 'finalized',
      byteLength: 100 * sourceBytes,
      sha256: hash.digest('hex'),
    })
    const events = current.replaySessionEvents(
      { tenantId: 'ten_live', workspaceId: 'wsp_live', sessionId: 'ses_live' },
      0,
      500,
    ).events
    expect(
      Math.max(
        ...events.map((event) => Buffer.byteLength(JSON.stringify(event))),
      ),
    ).toBeLessThan(70 * 1024)
    expect(events.at(-1)).toMatchObject({
      type: 'command.completed',
      payload: {
        output: {
          totalBytes: 100 * sourceBytes,
          artifact: { artifactId: artifact!.artifactId },
        },
      },
    })
    rmSync(directory, { recursive: true, force: true })
  }, 30_000)
  it('spills a completed-only 100 MiB snapshot without persisting it inline', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp7-completed-'))
    const client = new FakeRuntimeClient()
    const current = await setup({
      workspaceCwd: '/workspace',
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_live',
      artifactRoot: join(directory, 'artifacts'),
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: liveHeaders,
      payload: {},
    })
    const snapshot = 'y'.repeat(100 * 1024 * 1024)
    const expected = createHash('sha256').update(snapshot).digest('hex')
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thr_live',
        turnId: 'turn_snapshot',
        item: {
          type: 'commandExecution',
          id: 'cmd_snapshot',
          command: 'snapshot',
          cwd: '/workspace',
          processId: 'proc_snapshot',
          source: 'agent',
          commandActions: [],
          status: 'completed',
          aggregatedOutput: snapshot,
          exitCode: 0,
          durationMs: 1,
        },
        completedAtMs: 1,
      },
    })
    let artifact
    for (let attempt = 0; attempt < 1200; attempt++) {
      artifact = current.listArtifacts({
        tenantId: 'ten_live',
        workspaceId: 'wsp_live',
      })[0]
      if (artifact?.finalized) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(artifact).toMatchObject({
      byteLength: 100 * 1024 * 1024,
      sha256: expected,
      finalized: true,
    })
    const replay = current.replaySessionEvents(
      { tenantId: 'ten_live', workspaceId: 'wsp_live', sessionId: 'ses_live' },
      0,
      10,
    ).events
    expect(Buffer.byteLength(JSON.stringify(replay[0]))).toBeLessThan(70 * 1024)
    rmSync(directory, { recursive: true, force: true })
  }, 30_000)

  it('binds a created session to thread/start and records failures explicitly', async () => {
    const client = new FakeRuntimeClient()
    const { current, response } = await setupLive(client)

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      tenantId: 'ten_live',
      workspaceId: 'wsp_live',
      sessionId: 'ses_live',
      codexThreadId: 'thr_live',
      status: 'active',
    })
    expect(client.initializeCalls).toBe(1)
    expect(client.requests).toEqual(['thread/start'])
    expect(
      current.getSession({
        tenantId: 'ten_live',
        workspaceId: 'wsp_live',
        sessionId: 'ses_live',
      }),
    ).toMatchObject({ codexThreadId: 'thr_live', status: 'active' })
  })

  it('returns a failed session state when thread/start fails', async () => {
    const client = new FakeRuntimeClient()
    client.failThreadStart = true
    const { current, response } = await setupLive(client)

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ code: 'SESSION_START_FAILED' })
    expect(
      current.getSession({
        tenantId: 'ten_live',
        workspaceId: 'wsp_live',
        sessionId: 'ses_live',
      }),
    ).toMatchObject({ codexThreadId: null, status: 'failed' })
  })

  it('coalesces concurrent idempotent turn requests and rejects hash conflicts', async () => {
    const client = new FakeRuntimeClient()
    await setupLive(client)
    const request = (prompt: string) =>
      app!.inject({
        method: 'POST',
        url: '/v1/sessions/ses_live/turns',
        headers: { ...liveHeaders, 'idempotency-key': 'idem-1' },
        payload: { prompt },
      })

    const [first, second] = await Promise.all([
      request('Merhaba'),
      request('Merhaba'),
    ])
    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(202)
    expect(second.json()).toEqual(first.json())
    expect(client.turnStartCalls).toBe(1)

    const replay = await request('Farklı gövde')
    expect(replay.statusCode).toBe(409)
    expect(replay.json()).toMatchObject({
      code: 'IDEMPOTENCY_HASH_CONFLICT',
    })
    expect(client.turnStartCalls).toBe(1)
  })

  it('preserves one active turn per workspace across different keys', async () => {
    const client = new FakeRuntimeClient()
    await setupLive(client)
    const request = (key: string) =>
      app!.inject({
        method: 'POST',
        url: '/v1/sessions/ses_live/turns',
        headers: { ...liveHeaders, 'idempotency-key': key },
        payload: { prompt: key },
      })

    const [first, competing] = await Promise.all([
      request('turn-a'),
      request('turn-b'),
    ])
    expect(first.statusCode).toBe(202)
    expect(competing.statusCode).toBe(409)
    expect(competing.json()).toMatchObject({ code: 'WORKSPACE_TURN_ACTIVE' })
    expect(client.turnStartCalls).toBe(1)
  })

  it('persists fake notifications and approval requests before publishing live events', async () => {
    const client = new FakeRuntimeClient()
    const { current } = await setupLive(client)
    const socket = (await app!.injectWS(
      '/v1/realtime',
    )) as unknown as TestSocket
    sockets.push(socket)
    const reader = messageReader(socket)
    const liveScope = {
      tenantId: 'ten_live',
      workspaceId: 'wsp_live',
      sessionId: 'ses_live',
    }
    socket.send(
      JSON.stringify({ type: 'subscribe', ...liveScope, afterSequence: 0 }),
    )
    expect(await reader.next()).toMatchObject({ type: 'replay', events: [] })
    expect(await reader.next()).toMatchObject({ type: 'subscribed' })

    const turn = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_live/turns',
      headers: { ...liveHeaders, 'idempotency-key': 'idem-live' },
      payload: { prompt: 'Kısa cevap' },
    })
    expect(turn.statusCode).toBe(202)

    const delivered: TimelineEvent[] = []
    while (delivered.length < 6) {
      const message = await reader.next()
      if (message.type === 'event') delivered.push(message.event)
    }
    expect(delivered.map((entry) => entry.type)).toEqual([
      'turn.started',
      'agent.message.delta',
      'agent.message.completed',
      'codex.unknown',
      'approval.requested',
      'turn.completed',
    ])
    expect(current.getRecordCounts(liveScope)).toEqual({
      rawEvents: 6,
      events: 6,
      workspaceSequence: 6,
    })
    expect(client.requests).toEqual(['thread/start', 'turn/start'])
    expect(delivered[2]).toMatchObject({
      type: 'agent.message.completed',
      payload: { text: 'Yetkili final' },
    })
  })

  it('rejects turn access from another tenant or workspace', async () => {
    const client = new FakeRuntimeClient()
    await setupLive(client)
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_live/turns',
      headers: {
        ...liveHeaders,
        'x-tenant-id': 'ten_other',
        'idempotency-key': 'idem-scope',
      },
      payload: { prompt: 'test' },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' })
    expect(client.turnStartCalls).toBe(0)
  })
})

describe('WP6 session resume and recovery', () => {
  it('reads before resuming, coalesces concurrent calls, and keeps the same thread', async () => {
    const client = new FakeRuntimeClient({ threadId: 'thr_resume' })
    await setup({
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_resume',
      runtimeInstanceIdFactory: () => 'runtime_resume',
    })
    const scoped = {
      'x-tenant-id': 'ten_resume',
      'x-workspace-id': 'wsp_resume',
    }
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: scoped,
          payload: {},
        })
      ).statusCode,
    ).toBe(201)
    client.requests.length = 0
    const [first, second] = await Promise.all([
      app!.inject({
        method: 'POST',
        url: '/v1/sessions/ses_resume/resume',
        headers: { ...scoped, 'idempotency-key': 'resume-key' },
        payload: {},
      }),
      app!.inject({
        method: 'POST',
        url: '/v1/sessions/ses_resume/resume',
        headers: { ...scoped, 'idempotency-key': 'resume-key' },
        payload: {},
      }),
    ])
    expect([first.statusCode, second.statusCode]).toEqual([200, 200])
    expect(client.requests).toEqual(['thread/read', 'thread/resume'])
    expect(first.json()).toMatchObject({
      codexThreadId: 'thr_resume',
      status: 'active',
      runtimeConnected: true,
    })
  })

  it('durably exposes THREAD_NOT_RESUMABLE without replacing the thread', async () => {
    class BrokenResumeClient extends FakeRuntimeClient {
      override async request<TResult>(
        method: string,
        params: unknown,
      ): Promise<TResult> {
        if (method === 'thread/read') throw new Error('rollout corrupt')
        return super.request(method, params)
      }
    }
    const client = new BrokenResumeClient({ threadId: 'thr_broken' })
    await setup({
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_broken',
    })
    const scoped = {
      'x-tenant-id': 'ten_broken',
      'x-workspace-id': 'wsp_broken',
    }
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: scoped,
      payload: {},
    })
    const failed = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_broken/resume',
      headers: { ...scoped, 'idempotency-key': 'broken-key' },
      payload: {},
    })
    expect(failed.statusCode).toBe(409)
    expect(failed.json()).toMatchObject({ code: 'THREAD_NOT_RESUMABLE' })
    const detail = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_broken',
      headers: scoped,
    })
    expect(detail.json()).toMatchObject({
      codexThreadId: 'thr_broken',
      status: 'recovery_required',
      recoveryErrorCode: 'THREAD_NOT_RESUMABLE',
      recoveryOptions: ['retry_resume', 'start_new_session', 'view_read_only'],
    })
  })

  it('reconciles completed snapshot items and terminal turns without duplicates', async () => {
    const client = new FakeRuntimeClient({ threadId: 'thr_snapshot' })
    client.snapshotTurns = [
      {
        id: 'turn_snapshot',
        status: 'completed',
        items: [
          {
            type: 'agentMessage',
            id: 'msg_snapshot',
            text: 'snapshot authoritative final',
            phase: null,
            memoryCitation: null,
          },
        ],
        itemsView: 'full',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
      },
    ]
    await setup({
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_snapshot',
    })
    const scoped = {
      'x-tenant-id': 'ten_snapshot',
      'x-workspace-id': 'wsp_snapshot',
    }
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: scoped,
      payload: {},
    })
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thr_snapshot',
        turnId: 'turn_snapshot',
        item: {
          type: 'agentMessage',
          id: 'msg_live_original',
          text: 'snapshot authoritative final',
          phase: null,
          memoryCitation: null,
        },
        completedAtMs: 2_000,
      },
    })
    client.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thr_snapshot',
        turn: client.snapshotTurns[0],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    for (const key of ['snapshot-a', 'snapshot-b']) {
      expect(
        (
          await app!.inject({
            method: 'POST',
            url: '/v1/sessions/ses_snapshot/resume',
            headers: { ...scoped, 'idempotency-key': key },
            payload: {},
          })
        ).statusCode,
      ).toBe(200)
    }
    const replay = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_snapshot/events?after=0&limit=100',
      headers: scoped,
    })
    expect(replay.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent.message.completed',
          payload: { text: 'snapshot authoritative final' },
        }),
        expect.objectContaining({ type: 'turn.completed' }),
      ]),
    )
    expect(replay.json().events).toHaveLength(2)
  })

  it('keeps transient recovery failures retryable and distinct', async () => {
    class TransientClient extends FakeRuntimeClient {
      override async request<TResult>(
        method: string,
        params: unknown,
      ): Promise<TResult> {
        if (method === 'thread/read') throw new Error('temporary upstream')
        return super.request(method, params)
      }
    }
    await setup({
      runtimeClientFactory: () => new TransientClient(),
      sessionIdFactory: () => 'ses_transient',
    })
    const scoped = {
      'x-tenant-id': 'ten_transient',
      'x-workspace-id': 'wsp_transient',
    }
    await app!.inject({ method: 'POST', url: '/v1/sessions', headers: scoped })
    const failed = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_transient/resume',
      headers: { ...scoped, 'idempotency-key': 'transient' },
    })
    expect(failed.statusCode).toBe(502)
    expect(failed.json()).toMatchObject({ code: 'RECOVERY_TRANSIENT_FAILURE' })
    const detail = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_transient',
      headers: scoped,
    })
    expect(detail.json()).toMatchObject({
      status: 'recovering',
      recoveryOptions: ['retry_resume', 'view_read_only'],
    })
  })

  it.each([
    {
      label: 'authentication',
      error: new Error('login required'),
      code: 'RECOVERY_AUTH_REQUIRED',
      status: 401,
    },
    {
      label: 'timeout',
      error: new RequestTimeoutError(9, 'thread/read', 10),
      code: 'RECOVERY_TIMEOUT',
      status: 504,
    },
  ])(
    'classifies $label recovery failures without marking the thread permanent',
    async ({ error, code, status }) => {
      class ClassifiedClient extends FakeRuntimeClient {
        override async request<TResult>(
          method: string,
          params: unknown,
        ): Promise<TResult> {
          if (method === 'thread/read') throw error
          return super.request(method, params)
        }
      }
      await setup({
        runtimeClientFactory: () => new ClassifiedClient(),
        sessionIdFactory: () => `ses_${code.toLowerCase()}`,
      })
      const scoped = {
        'x-tenant-id': `ten_${code.toLowerCase()}`,
        'x-workspace-id': `wsp_${code.toLowerCase()}`,
      }
      const created = sessionResponseSchema.parse(
        (
          await app!.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: scoped,
          })
        ).json(),
      )
      const failed = await app!.inject({
        method: 'POST',
        url: `/v1/sessions/${created.sessionId}/resume`,
        headers: { ...scoped, 'idempotency-key': `key-${code}` },
      })
      expect(failed.statusCode).toBe(status)
      expect(failed.json()).toMatchObject({ code })
      const detail = await app!.inject({
        method: 'GET',
        url: `/v1/sessions/${created.sessionId}`,
        headers: scoped,
      })
      expect(detail.json()).toMatchObject({
        codexThreadId: created.codexThreadId,
        status: 'recovering',
        recoveryErrorCode: code,
      })
    },
  )

  it('steers with expectedTurnId and idempotently interrupts the active turn', async () => {
    const client = new FakeRuntimeClient({ threadId: 'thr_actions' })
    client.snapshotTurns = [
      {
        id: 'turn_active',
        status: 'inProgress',
        items: [],
        itemsView: 'full',
        error: null,
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      },
    ]
    await setup({
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_actions',
    })
    const scoped = {
      'x-tenant-id': 'ten_actions',
      'x-workspace-id': 'wsp_actions',
    }
    await app!.inject({ method: 'POST', url: '/v1/sessions', headers: scoped })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_actions/resume',
      headers: { ...scoped, 'idempotency-key': 'actions-resume' },
    })
    const noMatch = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_actions/turns/wrong/steer',
      headers: { ...scoped, 'idempotency-key': 'steer-wrong' },
      payload: { expectedTurnId: 'wrong', prompt: 'wrong' },
    })
    expect(noMatch.statusCode).toBe(409)
    expect(noMatch.json()).toMatchObject({ code: 'ACTIVE_TURN_CONFLICT' })
    const steer = () =>
      app!.inject({
        method: 'POST',
        url: '/v1/sessions/ses_actions/turns/turn_active/steer',
        headers: { ...scoped, 'idempotency-key': 'steer-once' },
        payload: { expectedTurnId: 'turn_active', prompt: 'continue' },
      })
    expect((await steer()).statusCode).toBe(200)
    expect((await steer()).statusCode).toBe(200)
    expect(
      client.requests.filter((method) => method === 'turn/steer'),
    ).toHaveLength(1)
    const interrupt = () =>
      app!.inject({
        method: 'POST',
        url: '/v1/sessions/ses_actions/turns/turn_active/interrupt',
        headers: { ...scoped, 'idempotency-key': 'interrupt-once' },
        payload: {},
      })
    expect((await interrupt()).statusCode).toBe(200)
    expect((await interrupt()).statusCode).toBe(200)
    expect(
      client.requests.filter((method) => method === 'turn/interrupt'),
    ).toHaveLength(1)
    const noActive = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_actions/turns/turn_active/steer',
      headers: { ...scoped, 'idempotency-key': 'steer-after-interrupt' },
      payload: { expectedTurnId: 'turn_active', prompt: 'late' },
    })
    expect(noActive.statusCode).toBe(409)
    expect(noActive.json()).toMatchObject({ code: 'NO_ACTIVE_TURN' })
  })

  it('auto-recovers once when a ready runtime advances generation', async () => {
    const client = new FakeRuntimeClient({ threadId: 'thr_auto' })
    await setup({
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_auto',
      runtimeInstanceIdFactory: () => 'runtime_auto',
    })
    const scoped = {
      'x-tenant-id': 'ten_auto',
      'x-workspace-id': 'wsp_auto',
    }
    await app!.inject({ method: 'POST', url: '/v1/sessions', headers: scoped })
    client.requests.length = 0
    client.setHealth('restarting', 1)
    client.setHealth('ready', 2)
    for (
      let attempt = 0;
      attempt < 50 && client.requests.length < 2;
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 5))
    expect(client.requests).toEqual(['thread/read', 'thread/resume'])
    client.setHealth('ready', 2)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(client.requests).toEqual(['thread/read', 'thread/resume'])
  })
})

describe('WP4 restart-safe ingest regression', () => {
  it('keeps two control-plane instances and their authoritative finals isolated in one file DB', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp4-restart-ingest-'))
    const databasePath = join(directory, 'events.sqlite')
    const restartHeaders = {
      'content-type': 'application/json',
      'x-tenant-id': 'ten_restart',
      'x-workspace-id': 'wsp_restart',
    }
    const firstScope = {
      tenantId: 'ten_restart',
      workspaceId: 'wsp_restart',
      sessionId: 'ses_restart_a',
    }
    const secondScope = { ...firstScope, sessionId: 'ses_restart_b' }
    let firstApp: FastifyInstance | undefined
    let secondApp: FastifyInstance | undefined

    try {
      firstApp = await buildControlPlane({
        databasePath,
        workspaceCwd: '/server/configured/workspace',
        runtimeClientFactory: () =>
          new FakeRuntimeClient({
            threadId: 'thr_restart_a',
            turnId: 'turn_restart_a',
            itemId: 'msg_restart_a',
            delta: 'A delta',
            finalText: 'A authoritative final',
          }),
        runtimeInstanceIdFactory: () => 'runtime-instance-a',
        sessionIdFactory: () => firstScope.sessionId,
      })
      await firstApp.ready()
      expect(
        (
          await firstApp.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: restartHeaders,
            payload: {},
          })
        ).statusCode,
      ).toBe(201)
      expect(
        (
          await firstApp.inject({
            method: 'POST',
            url: `/v1/sessions/${firstScope.sessionId}/turns`,
            headers: { ...restartHeaders, 'idempotency-key': 'restart-a' },
            payload: { prompt: 'first' },
          })
        ).statusCode,
      ).toBe(202)
      await firstApp.close()
      firstApp = undefined

      secondApp = await buildControlPlane({
        databasePath,
        workspaceCwd: '/server/configured/workspace',
        runtimeClientFactory: () =>
          new FakeRuntimeClient({
            threadId: 'thr_restart_b',
            turnId: 'turn_restart_b',
            itemId: 'msg_restart_b',
            delta: 'B last delta only',
            finalText: 'B authoritative complete message',
          }),
        runtimeInstanceIdFactory: () => 'runtime-instance-b',
        sessionIdFactory: () => secondScope.sessionId,
      })
      await secondApp.ready()
      expect(
        (
          await secondApp.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: restartHeaders,
            payload: {},
          })
        ).statusCode,
      ).toBe(201)
      expect(
        (
          await secondApp.inject({
            method: 'POST',
            url: `/v1/sessions/${secondScope.sessionId}/turns`,
            headers: { ...restartHeaders, 'idempotency-key': 'restart-b' },
            payload: { prompt: 'second' },
          })
        ).statusCode,
      ).toBe(202)
      await secondApp.close()
      secondApp = undefined

      const evidence = new SqliteEventStore(databasePath)
      const firstEvents = evidence.replaySessionEvents(
        firstScope,
        0,
        100,
      ).events
      const secondEvents = evidence.replaySessionEvents(
        secondScope,
        0,
        100,
      ).events
      expect(evidence.getRecordCounts(firstScope)).toMatchObject({
        rawEvents: 6,
        events: 6,
      })
      expect(evidence.getRecordCounts(secondScope)).toEqual({
        rawEvents: 6,
        events: 6,
        workspaceSequence: 12,
      })
      expect(
        secondEvents.find((event) => event.type === 'agent.message.delta'),
      ).toMatchObject({ payload: { text: 'B last delta only' } })
      expect(
        secondEvents.find((event) => event.type === 'agent.message.completed'),
      ).toMatchObject({
        payload: { text: 'B authoritative complete message' },
      })
      expect(secondEvents.at(-1)).toMatchObject({ type: 'turn.completed' })
      const allSequences = [...firstEvents, ...secondEvents].map(
        (event) => event.sequence,
      )
      expect(allSequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
      expect(new Set(allSequences).size).toBe(allSequences.length)
      evidence.close()

      const database = new DatabaseSync(databasePath)
      const rawRows = database
        .prepare(
          `SELECT session_id, ingest_key FROM raw_events
           WHERE tenant_id = ? AND workspace_id = ? ORDER BY raw_event_id`,
        )
        .all(firstScope.tenantId, firstScope.workspaceId) as unknown as Array<{
        session_id: string
        ingest_key: string
      }>
      database.close()
      expect(
        rawRows.filter((row) => row.session_id === firstScope.sessionId),
      ).toHaveLength(6)
      expect(
        rawRows.filter((row) => row.session_id === secondScope.sessionId),
      ).toHaveLength(6)
      expect(
        rawRows
          .slice(0, 6)
          .every((row) => row.ingest_key.includes('runtime-instance-a')),
      ).toBe(true)
      expect(
        rawRows
          .slice(6)
          .every((row) => row.ingest_key.includes('runtime-instance-b')),
      ).toBe(true)
    } finally {
      await firstApp?.close()
      await secondApp?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
