import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ClaudeCodeRuntimeAdapter,
  GeminiCliRuntimeAdapter,
  normalizeCliEnvelope,
  SpawnCliProcessRunner,
  type CliRunResult,
  type CliProcessRunner,
} from './index'
import type { ProviderModelCatalog } from '@persistent-codex/provider-platform'

const fixture = (provider: 'claude' | 'gemini') =>
  readFileSync(
    fileURLToPath(
      new URL(`../test/fixtures/${provider}-stream.jsonl`, import.meta.url),
    ),
    'utf8',
  )
    .trim()
    .split('\n')

function context() {
  let sequence = 0
  return {
    tenantId: 'ten_test',
    workspaceId: 'wsp_test',
    sessionId: 'ses_test',
    nextSequence: () => ++sequence,
    nextEventId: () => `evt_${sequence + 1}`,
    now: () => new Date('2026-07-15T00:00:00.000Z'),
  }
}

function catalog(provider: 'claude' | 'gemini'): ProviderModelCatalog {
  return {
    schemaVersion: 1,
    identity: {
      provider,
      adapter: `${provider}-fixture`,
      adapterVersion: '1',
      upstreamVersion: 'fixture',
    },
    discoveredAt: '2026-07-15T00:00:00.000Z',
    models: [
      {
        provider,
        modelId: `${provider}-fixture-model`,
        displayName: 'Fixture model',
        hidden: false,
        isDefault: true,
        reasoningEfforts: ['none', 'medium'],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text'],
        capabilities: {
          streaming: 'supported',
          reasoningSummary: 'degraded',
          commandExecution: 'supported',
          fileChanges: 'supported',
          approvals: 'unsupported',
          interrupt: 'supported',
          resume: 'supported',
          toolCalls: 'supported',
          imageInput: 'unsupported',
        },
      },
    ],
  }
}

class FixtureRunner implements CliProcessRunner {
  interrupted = false
  readonly lines: string[]
  readonly exitCode: number
  constructor(lines: string[], exitCode = 0) {
    this.lines = lines
    this.exitCode = exitCode
  }
  async run(input: {
    onLine(line: string): void | Promise<void>
  }): Promise<CliRunResult> {
    for (const line of this.lines) await input.onLine(line)
    return {
      exitCode: this.interrupted ? null : this.exitCode,
      signal: this.interrupted ? ('SIGINT' as const) : null,
    }
  }
  interrupt() {
    this.interrupted = true
    return true
  }
  async version() {
    return 'fixture-version'
  }
  async probe() {
    return { exitCode: 0, stdout: '{"loggedIn":true}', stderr: '' }
  }
}

class ControlledRunner extends FixtureRunner {
  #onLine: ((line: string) => void | Promise<void>) | undefined
  #resolve: ((result: CliRunResult) => void) | undefined
  readonly started = Promise.withResolvers<void>()
  interruptCalls = 0

  constructor() {
    super([])
  }

  override async run(input: { onLine(line: string): void | Promise<void> }) {
    this.#onLine = input.onLine
    this.started.resolve()
    return await new Promise<CliRunResult>((resolve) => {
      this.#resolve = resolve
    })
  }

  async emit(envelope: unknown) {
    await this.#onLine?.(JSON.stringify(envelope))
  }

  finish(result: CliRunResult) {
    this.#resolve?.(result)
  }

  override interrupt() {
    this.interruptCalls += 1
    return true
  }
}

describe.each([
  ['claude', ClaudeCodeRuntimeAdapter],
  ['gemini', GeminiCliRuntimeAdapter],
] as const)('%s provider runtime contract', (provider, Adapter) => {
  it('discovers configured models and streams a terminal usage outcome', async () => {
    const events: string[] = []
    const adapter = new Adapter({
      catalog: catalog(provider),
      context: context(),
      runner: new FixtureRunner(fixture(provider)),
    })
    expect((await adapter.discoverModelCatalog()).models[0]?.modelId).toBe(
      `${provider}-fixture-model`,
    )
    const terminal = await adapter.startTurn!(
      {
        sessionId: null,
        prompt: 'fixture',
        cwd: '.',
        modelId: `${provider}-fixture-model`,
        reasoningEffort: provider === 'gemini' ? 'none' : 'medium',
      },
      (event) => {
        events.push(event.normalized.event.type)
      },
    )
    expect(events).toContain('turn.started')
    expect(events).toContain('agent.message.delta')
    expect(events).toContain('turn.completed')
    expect(terminal).toMatchObject({
      outcome: 'completed',
      usage: { completeness: 'complete' },
    })
    if (provider === 'gemini')
      expect(terminal.usage?.counters.cachedInputTokens).toBe(7)
  })

  it('builds exact machine-readable model, effort, and resume arguments', () => {
    const adapter = new Adapter({
      catalog: catalog(provider),
      context: context(),
      runner: new FixtureRunner([]),
    })
    const args = adapter.args({
      sessionId: 'upstream-session',
      prompt: 'next',
      cwd: '.',
      modelId: `${provider}-fixture-model`,
      reasoningEffort: provider === 'gemini' ? 'none' : 'high',
    })
    expect(args).toEqual(
      provider === 'claude'
        ? [
            '-p',
            'next',
            '--output-format',
            'stream-json',
            '--verbose',
            '--model',
            'claude-fixture-model',
            '--effort',
            'high',
            '--resume',
            'upstream-session',
          ]
        : [
            '-p',
            'next',
            '--output-format',
            'stream-json',
            '--model',
            'gemini-fixture-model',
            '--resume',
            'upstream-session',
          ],
    )
  })

  it('supports resume arguments and interrupt without emulating approvals', async () => {
    const runner = new FixtureRunner([])
    const adapter = new Adapter({
      catalog: catalog(provider),
      context: context(),
      runner,
    })
    expect(
      adapter.args({
        sessionId: 'upstream-session',
        prompt: 'next',
        cwd: '.',
        modelId: `${provider}-fixture-model`,
        reasoningEffort: 'none',
      }),
    ).toContain('upstream-session')
    await adapter.interrupt({
      schemaVersion: 1,
      sessionId: 'upstream-session',
      turnId: 'turn',
      reason: 'user',
    })
    expect(runner.interrupted).toBe(true)
    await expect(
      adapter.resolveApproval({
        schemaVersion: 1,
        providerRequestId: 'x',
        decision: 'accept',
      }),
    ).rejects.toThrow('unsupported')
  })

  it('returns typed auth failures and preserves malformed/unknown envelopes', async () => {
    const adapter = new Adapter({
      catalog: catalog(provider),
      context: context(),
      runner: new FixtureRunner([], 1),
    })
    const terminal = await adapter.startTurn!(
      {
        sessionId: null,
        prompt: 'fixture',
        cwd: '.',
        modelId: `${provider}-fixture-model`,
        reasoningEffort: 'none',
      },
      () => undefined,
    )
    expect(terminal.outcome).toBe('failed')
    const malformed = normalizeCliEnvelope({
      provider,
      envelope: 'not-json',
      context: context(),
      sourceVersion: 'fixture',
    })
    expect(malformed.normalized.event.type).toBe('provider.unknown')
    const unknown = normalizeCliEnvelope({
      provider,
      envelope: { type: 'future_event', apiKey: 'never-store-me' },
      context: context(),
      sourceVersion: 'fixture',
    })
    expect(unknown.normalized.event.type).toBe('provider.unknown')
    expect(JSON.stringify(unknown)).not.toContain('never-store-me')
  })
})

describe('provider-specific effort and readiness', () => {
  it('maps Claude efforts and rejects minimal before spawning', async () => {
    const runner = new FixtureRunner([])
    const adapter = new ClaudeCodeRuntimeAdapter({
      catalog: catalog('claude'),
      context: context(),
      runner,
    })
    expect(
      adapter.args({
        sessionId: null,
        prompt: 'x',
        cwd: '.',
        modelId: 'm',
        reasoningEffort: 'none',
      }),
    ).not.toContain('--effort')
    expect(
      adapter.args({
        sessionId: null,
        prompt: 'x',
        cwd: '.',
        modelId: 'm',
        reasoningEffort: 'xhigh',
      }),
    ).toContain('max')
    for (const effort of ['low', 'medium', 'high'] as const)
      expect(
        adapter.args({
          sessionId: null,
          prompt: 'x',
          cwd: '.',
          modelId: 'm',
          reasoningEffort: effort,
        }),
      ).toEqual(expect.arrayContaining(['--effort', effort]))
    await expect(
      adapter.startTurn!(
        {
          sessionId: null,
          prompt: 'x',
          cwd: '.',
          modelId: 'm',
          reasoningEffort: 'minimal',
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({
      outcome: 'failed',
      error: {
        code: 'capability_unsupported',
        upstreamCode: 'REASONING_EFFORT_UNSUPPORTED',
      },
    })
  })

  it('limits Gemini discovery to none and rejects overrides before spawning', async () => {
    const runner = new FixtureRunner([])
    const adapter = new GeminiCliRuntimeAdapter({
      catalog: catalog('gemini'),
      context: context(),
      runner,
    })
    expect((await adapter.discoverModelCatalog()).models[0]).toMatchObject({
      reasoningEfforts: ['none'],
      defaultReasoningEffort: 'none',
    })
    await expect(
      adapter.startTurn!(
        {
          sessionId: null,
          prompt: 'x',
          cwd: '.',
          modelId: 'm',
          reasoningEffort: 'medium',
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({
      outcome: 'failed',
      error: {
        code: 'capability_unsupported',
        upstreamCode: 'REASONING_EFFORT_UNSUPPORTED',
      },
    })
  })

  it('uses Claude auth status and models Gemini auth as unknown', async () => {
    class ReadyRunner extends FixtureRunner {
      override async version() {
        return '2.1.109 0.25.0'
      }
      override async probe() {
        return { exitCode: 1, stdout: '{"loggedIn":false}', stderr: '' }
      }
    }
    const claude = new ClaudeCodeRuntimeAdapter({
      catalog: catalog('claude'),
      context: context(),
      runner: new ReadyRunner([]),
    })
    expect(await claude.checkReadiness()).toMatchObject({
      ready: false,
      authReady: false,
      authStatus: 'required',
      code: 'auth_required',
    })
    const gemini = new GeminiCliRuntimeAdapter({
      catalog: catalog('gemini'),
      context: context(),
      runner: new ReadyRunner([]),
    })
    expect(await gemini.checkReadiness()).toMatchObject({
      ready: true,
      authReady: null,
      authStatus: 'unknown',
      code: 'auth_unknown',
    })
  })

  it('normalizes Gemini capacity without leaking stack or secrets', async () => {
    class CapacityRunner extends FixtureRunner {
      attempts = 0
      override async run(): Promise<never> {
        this.attempts += 1
        throw new Error(
          '429 RESOURCE_EXHAUSTED\nstack bearer secret-token-value',
        )
      }
    }
    const runner = new CapacityRunner([])
    const adapter = new GeminiCliRuntimeAdapter({
      catalog: catalog('gemini'),
      context: context(),
      runner,
    })
    const terminal = await adapter.startTurn!(
      {
        sessionId: null,
        prompt: 'x',
        cwd: '.',
        modelId: 'm',
        reasoningEffort: 'none',
      },
      () => undefined,
    )
    expect(terminal).toMatchObject({
      outcome: 'failed',
      error: { code: 'capacity_exhausted', retryable: true },
    })
    expect(JSON.stringify(terminal)).not.toMatch(/stack|secret-token/)
    expect(runner.attempts).toBe(3)
  })
})

describe('provider interrupt and timeout races', () => {
  const turnInput = {
    sessionId: null,
    prompt: 'fixture',
    cwd: '.',
    modelId: 'claude-fixture-model',
    reasoningEffort: 'none' as const,
  }
  const interruptInput = {
    schemaVersion: 1 as const,
    sessionId: 'fixture-session',
    turnId: 'fixture-turn',
    reason: 'user' as const,
  }

  it('preserves authoritative completion observed before interrupt', async () => {
    const runner = new ControlledRunner()
    const adapter = new ClaudeCodeRuntimeAdapter({
      catalog: catalog('claude'),
      context: context(),
      runner,
    })
    const turn = adapter.startTurn!(turnInput, () => undefined)
    await runner.started.promise
    await runner.emit({
      type: 'result',
      subtype: 'success',
      session_id: 'fixture-session',
    })
    await adapter.interrupt(interruptInput)
    runner.finish({
      exitCode: null,
      signal: 'SIGINT',
      interruptRequested: true,
    })
    await expect(turn).resolves.toMatchObject({ outcome: 'completed' })
  })

  it('finalizes interrupted when accepted interrupt precedes completion', async () => {
    const runner = new ControlledRunner()
    const adapter = new ClaudeCodeRuntimeAdapter({
      catalog: catalog('claude'),
      context: context(),
      runner,
    })
    const turn = adapter.startTurn!(turnInput, () => undefined)
    await runner.started.promise
    await adapter.interrupt(interruptInput)
    await runner.emit({
      type: 'result',
      subtype: 'success',
      session_id: 'fixture-session',
    })
    runner.finish({ exitCode: 0, signal: null, interruptRequested: true })
    await expect(turn).resolves.toMatchObject({ outcome: 'interrupted' })
  })

  it('treats provider error-after-interrupt as interrupted', async () => {
    const runner = new ControlledRunner()
    const adapter = new ClaudeCodeRuntimeAdapter({
      catalog: catalog('claude'),
      context: context(),
      runner,
    })
    const turn = adapter.startTurn!(turnInput, () => undefined)
    await runner.started.promise
    await adapter.interrupt(interruptInput)
    await runner.emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 'fixture-session',
    })
    runner.finish({ exitCode: 0, signal: null, interruptRequested: true })
    await expect(turn).resolves.toMatchObject({ outcome: 'interrupted' })
  })

  it('returns a typed timeout terminal', async () => {
    const runner = new ControlledRunner()
    const adapter = new ClaudeCodeRuntimeAdapter({
      catalog: catalog('claude'),
      context: context(),
      runner,
    })
    const turn = adapter.startTurn!(turnInput, () => undefined)
    await runner.started.promise
    runner.finish({ exitCode: null, signal: 'SIGKILL', timedOut: true })
    await expect(turn).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'timeout', retryable: true, upstreamCode: 'TURN_TIMEOUT' },
    })
  })

  it('interrupts an active process and keeps repeated interrupt idempotent', async () => {
    const runner = new SpawnCliProcessRunner({
      turnTimeoutMs: 2_000,
      interruptGraceMs: 100,
      terminateGraceMs: 100,
    })
    const lifecycle = fileURLToPath(
      new URL('../test/fixtures/process-lifecycle.mjs', import.meta.url),
    )
    const started = Promise.withResolvers<void>()
    const running = runner.run({
      binary: process.execPath,
      args: [lifecycle, 'interrupt-exit'],
      cwd: '.',
      onLine: () => started.resolve(),
    })
    await started.promise
    expect(runner.interrupt()).toBe(true)
    expect(runner.interrupt()).toBe(true)
    await expect(running).resolves.toMatchObject({ interruptRequested: true })
    expect(runner.active).toBe(false)
  })

  it('escalates a SIGINT-catching process after grace', async () => {
    const runner = new SpawnCliProcessRunner({
      turnTimeoutMs: 2_000,
      interruptGraceMs: 20,
      terminateGraceMs: 20,
    })
    const lifecycle = fileURLToPath(
      new URL('../test/fixtures/process-lifecycle.mjs', import.meta.url),
    )
    const started = Promise.withResolvers<void>()
    const running = runner.run({
      binary: process.execPath,
      args: [lifecycle, 'ignore-signals'],
      cwd: '.',
      onLine: () => started.resolve(),
    })
    await started.promise
    expect(runner.interrupt()).toBe(true)
    await expect(running).resolves.toMatchObject({
      signal: 'SIGKILL',
      interruptRequested: true,
    })
    expect(runner.active).toBe(false)
  })

  it('times out, closes readers, and leaves no active child', async () => {
    const runner = new SpawnCliProcessRunner({
      turnTimeoutMs: 250,
      interruptGraceMs: 10,
      terminateGraceMs: 20,
    })
    const lifecycle = fileURLToPath(
      new URL('../test/fixtures/process-lifecycle.mjs', import.meta.url),
    )
    const result = await runner.run({
      binary: process.execPath,
      args: [lifecycle, 'ignore-signals'],
      cwd: '.',
      onLine: () => undefined,
    })
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL' })
    expect(runner.active).toBe(false)
  })
})
