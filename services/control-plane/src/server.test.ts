import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ProcessHealth,
  WorkspaceRuntimeClient,
} from '@persistent-codex/workspace-agent'
import type { TimelineEvent } from '@persistent-codex/domain-events'
import {
  serverMessageSchema,
  type ServerMessage,
} from '@persistent-codex/control-plane-contracts'
import {
  SqliteEventStore,
  type StoreScope,
} from '@persistent-codex/event-store'
import { buildControlPlane, type ControlPlaneOptions } from './server'

const scope: StoreScope = {
  tenantId: 'ten_test',
  workspaceId: 'wsp_test',
  sessionId: 'ses_test',
}
const headers = {
  'x-tenant-id': scope.tenantId,
  'x-workspace-id': scope.workspaceId,
}

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
  readonly processGeneration = 1
  health: ProcessHealth = { state: 'stopped', restartAttempt: 0 }
  initializeCalls = 0
  turnStartCalls = 0
  failThreadStart = false
  readonly requests: string[] = []
  readonly #notifications = new Set<
    (message: Record<string, unknown>) => void
  >()
  readonly #serverRequests = new Set<
    (message: Record<string, unknown>) => void
  >()
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

  async stop() {
    this.health = { state: 'stopped', restartAttempt: 0 }
  }

  emitNotification(message: Record<string, unknown>) {
    for (const listener of this.#notifications) listener(message)
  }

  emitServerRequest(message: Record<string, unknown>) {
    for (const listener of this.#serverRequests) listener(message)
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

describe('control plane WebSocket replay/live stream', () => {
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

  it('binds a created session to thread/start and records failures explicitly', async () => {
    const client = new FakeRuntimeClient()
    const { current, response } = await setupLive(client)

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
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
