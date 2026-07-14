import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CodexAppServerClient,
  ProcessExitedError,
  ProtocolError,
  RequestTimeoutError,
  WorkspaceRuntimeRegistry,
  type CodexAppServerClientOptions,
  type ProcessHealth,
  type ProcessHealthState,
  type RuntimeDelivery,
  type WorkspaceRuntimeClient,
} from './index'

const fixture = fileURLToPath(
  new URL('../test/fixtures/fake-app-server.mjs', import.meta.url),
)
const clientInfo = {
  name: 'persistent_codex_poc',
  title: 'Persistent Codex PoC',
  version: '0.0.0',
}

function createClient(options: CodexAppServerClientOptions = {}) {
  return new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    ...options,
  })
}

async function waitForHealth(
  client: CodexAppServerClient,
  state: ProcessHealthState,
  timeoutMs = 10_000,
): Promise<void> {
  if (client.health.state === state) return

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(
        new Error(
          `Timed out waiting for health=${state}; current=${client.health.state}`,
        ),
      )
    }, timeoutMs)
    const unsubscribe = client.onHealthChange((health) => {
      if (health.state !== state) return
      clearTimeout(timeout)
      unsubscribe()
      resolve()
    })
  })
}

describe('CodexAppServerClient', () => {
  it('performs the initialize handshake and routes notifications', async () => {
    const client = createClient()
    const notifications: Array<Record<string, unknown>> = []
    client.onNotification((message) => notifications.push(message))

    try {
      expect(client.health.state).toBe('stopped')
      await expect(client.initialize(clientInfo)).resolves.toMatchObject({
        platformFamily: 'unix',
      })
      expect(client.health.state).toBe('ready')

      await expect(
        client.request<{ thread: { id: string } }>('thread/start', {}),
      ).resolves.toEqual({ thread: { id: 'thr_fixture' } })

      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(notifications).toContainEqual({
        method: 'thread/started',
        params: { thread: { id: 'thr_fixture' } },
      })
    } finally {
      await client.stop()
    }
  })

  it('rejects and removes every pending request when the process exits', async () => {
    const client = createClient({ restart: { maxRestarts: 0 } })

    try {
      await client.initialize(clientInfo)
      const exitsProcess = client.request('test/pending-exit', {})
      const remainsPending = client.request('test/timeout', {})
      expect(client.pendingRequestCount).toBe(2)

      const results = await Promise.allSettled([exitsProcess, remainsPending])
      expect(results).toHaveLength(2)
      for (const result of results) {
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({
            name: 'ProcessExitedError',
            code: 'CODEX_PROCESS_CRASHED',
            exitCode: 17,
          } satisfies Partial<ProcessExitedError>)
        }
      }
      expect(client.pendingRequestCount).toBe(0)
      await waitForHealth(client, 'failed')
    } finally {
      await client.stop()
    }
  })

  it('turns malformed stdout JSON into a fatal protocol error', async () => {
    const states: ProcessHealthState[] = []
    const client = createClient()
    client.onHealthChange((health) => states.push(health.state))

    try {
      await client.initialize(clientInfo)
      const pending = client.request('test/malformed', {})

      await expect(pending).rejects.toBeInstanceOf(ProtocolError)
      await waitForHealth(client, 'failed')
      expect(client.health.lastError).toMatchObject({
        name: 'ProtocolError',
        code: 'CODEX_PROTOCOL_MISMATCH',
      } satisfies Partial<ProtocolError>)
      expect(client.pendingRequestCount).toBe(0)
      expect(states).not.toContain('restarting')
      await waitForHealth(client, 'failed')
      expect(client.running).toBe(false)
    } finally {
      await client.stop()
    }
  })

  it('times out requests using the configurable default and clears pending state', async () => {
    const client = createClient({ requestTimeoutMs: 10_000 })

    try {
      await client.initialize(clientInfo)
      await expect(
        client.request('test/timeout', {}, { timeoutMs: 150 }),
      ).rejects.toMatchObject({
        name: 'RequestTimeoutError',
        code: 'CODEX_RPC_TIMEOUT',
        method: 'test/timeout',
        timeoutMs: 150,
      } satisfies Partial<RequestTimeoutError>)
      expect(client.pendingRequestCount).toBe(0)
      expect(client.health.state).toBe('ready')
    } finally {
      await client.stop()
    }
  })

  it('restarts with backoff and repeats the initialize handshake', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workspace-agent-restart-'))
    const stateFile = join(directory, 'initialize-count')
    const transitions: Array<{ state: ProcessHealthState; at: number }> = []
    const client = createClient({
      env: {
        ...process.env,
        FAKE_APP_SERVER_MODE: 'crash-once',
        FAKE_APP_SERVER_STATE_FILE: stateFile,
      },
      restart: {
        initialDelayMs: 30,
        maxDelayMs: 100,
        maxRestarts: 3,
        windowMs: 1_000,
      },
    })
    client.onHealthChange((health) =>
      transitions.push({ state: health.state, at: Date.now() }),
    )

    try {
      await client.initialize(clientInfo)
      await waitForHealth(client, 'restarting')
      await waitForHealth(client, 'ready')

      expect(await readFile(stateFile, 'utf8')).toBe('2')
      const restarting = transitions.find(
        (transition) => transition.state === 'restarting',
      )
      const restarted = transitions.find(
        (transition) =>
          transition.state === 'starting' &&
          restarting !== undefined &&
          transition.at >= restarting.at,
      )
      expect(restarting).toBeDefined()
      expect(restarted).toBeDefined()
      expect(
        (restarted?.at ?? 0) - (restarting?.at ?? 0),
      ).toBeGreaterThanOrEqual(20)
      expect(transitions.map(({ state }) => state)).toEqual(
        expect.arrayContaining([
          'restarting',
          'starting',
          'initializing',
          'ready',
        ]),
      )
    } finally {
      await client.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stops restarting and becomes failed after the crash-loop limit', async () => {
    const transitions: Array<{ state: ProcessHealthState; at: number }> = []
    const client = createClient({
      env: { ...process.env, FAKE_APP_SERVER_MODE: 'crash-always' },
      restart: {
        initialDelayMs: 20,
        maxDelayMs: 80,
        maxRestarts: 2,
        windowMs: 60_000,
      },
    })
    client.onHealthChange((health) =>
      transitions.push({ state: health.state, at: Date.now() }),
    )

    try {
      await client.initialize(clientInfo)
      await waitForHealth(client, 'failed')

      expect(client.health).toMatchObject({
        state: 'failed',
        restartAttempt: 2,
        lastError: { code: 'CODEX_PROCESS_CRASHED' },
      })
      const restarting = transitions.filter(
        (transition) => transition.state === 'restarting',
      )
      const starting = transitions.filter(
        (transition) => transition.state === 'starting',
      )
      expect(restarting).toHaveLength(2)
      expect(starting).toHaveLength(3)
      expect(starting[1]!.at - restarting[0]!.at).toBeGreaterThanOrEqual(10)
      expect(starting[2]!.at - restarting[1]!.at).toBeGreaterThanOrEqual(30)

      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(client.health.state).toBe('failed')
      expect(
        transitions.filter((transition) => transition.state === 'starting'),
      ).toHaveLength(3)
    } finally {
      await client.stop()
    }
  })

  it('does not restart after a graceful stop', async () => {
    const states: ProcessHealthState[] = []
    const client = createClient({
      restart: { initialDelayMs: 10, maxDelayMs: 20 },
    })
    client.onHealthChange((health) => states.push(health.state))

    await client.initialize(clientInfo)
    await client.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(client.health.state).toBe('stopped')
    expect(client.running).toBe(false)
    expect(states).not.toContain('restarting')
  })
})

describe('WorkspaceRuntimeRegistry', () => {
  it('coalesces concurrent initialization and stops the owned client', async () => {
    let factoryCalls = 0
    const registry = new WorkspaceRuntimeRegistry({
      clientFactory: () => {
        factoryCalls += 1
        return createClient()
      },
    })
    const identity = {
      tenantId: 'ten_test',
      workspaceId: 'wsp_test',
      cwd: process.cwd(),
    }

    const [first, second, third] = await Promise.all([
      registry.getOrInitialize(identity),
      registry.getOrInitialize(identity),
      registry.getOrInitialize(identity),
    ])

    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(factoryCalls).toBe(1)
    expect(registry.size).toBe(1)
    expect(first.client.health.state).toBe('ready')

    await registry.stopAll()
    expect(first.client.health.state).toBe('stopped')
    expect(registry.size).toBe(0)
  })

  it('keeps a runtime instance id across child generations and rotates it with the registry', async () => {
    class DeliveryClient implements WorkspaceRuntimeClient {
      health: ProcessHealth = { state: 'stopped', restartAttempt: 0 }
      processGeneration = 1
      notification: ((message: Record<string, unknown>) => void) | undefined

      async initialize() {
        this.health = { state: 'ready', restartAttempt: 0 }
        return {}
      }

      async request<TResult>(): Promise<TResult> {
        throw new Error('not implemented')
      }

      onNotification(listener: (message: Record<string, unknown>) => void) {
        this.notification = listener
        return () => {
          this.notification = undefined
        }
      }

      onServerRequest() {
        return () => undefined
      }

      async stop() {
        this.health = { state: 'stopped', restartAttempt: 0 }
      }

      emit(index: number) {
        this.notification?.({
          method: 'fixture/event',
          params: { threadId: 'thr_fixture', index },
        })
      }
    }

    const client = new DeliveryClient()
    const deliveries: RuntimeDelivery[] = []
    const errors: Array<{ delivery: RuntimeDelivery; error: unknown }> = []
    const registry = new WorkspaceRuntimeRegistry({
      clientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime-A',
      onMessage: (_runtime, message, delivery) => {
        deliveries.push(delivery)
        if ((message.params as { index: number }).index === 1) {
          throw new Error('fixture delivery failure')
        }
      },
      onDeliveryError: (_runtime, delivery, error) => {
        errors.push({ delivery, error })
      },
    })
    const identity = {
      tenantId: 'ten_test',
      workspaceId: 'wsp_test',
      cwd: process.cwd(),
    }
    const runtime = await registry.getOrInitialize(identity)
    client.emit(1)
    client.emit(2)
    client.processGeneration = 2
    client.emit(3)
    await registry.stopAll()

    expect(runtime.runtimeInstanceId).toBe('runtime-A')
    expect(deliveries).toMatchObject([
      {
        runtimeInstanceId: 'runtime-A',
        processGeneration: 1,
        receiveOrdinal: 1,
      },
      {
        runtimeInstanceId: 'runtime-A',
        processGeneration: 1,
        receiveOrdinal: 2,
      },
      {
        runtimeInstanceId: 'runtime-A',
        processGeneration: 2,
        receiveOrdinal: 1,
      },
    ])
    expect(
      deliveries.every(({ ingestKey }) => ingestKey.includes('runtime-A')),
    ).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      delivery: { receiveOrdinal: 1 },
      error: { message: 'fixture delivery failure' },
    })
    expect(deliveries).toHaveLength(3)

    const secondRegistry = new WorkspaceRuntimeRegistry({
      clientFactory: () => new DeliveryClient(),
      runtimeInstanceIdFactory: () => 'runtime-B',
    })
    const secondRuntime = await secondRegistry.getOrInitialize(identity)
    expect(secondRuntime.runtimeInstanceId).toBe('runtime-B')
    await secondRegistry.stopAll()
  })
})
