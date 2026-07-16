import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ClaudeCodeRuntimeAdapter,
  CursorAgentRuntimeAdapter,
  GEMINI_CLI_SUPPORTED_VERSIONS,
  GeminiCliRuntimeAdapter,
  loadCursorProjectPolicy,
  normalizeCliEnvelope,
  SpawnCliProcessRunner,
  type CliRunResult,
  type CliProcessRunner,
} from './index'
import type { ProviderModelCatalog } from '@persistent-codex/provider-platform'

const fixture = (provider: 'claude' | 'gemini' | 'cursor') =>
  readFileSync(
    fileURLToPath(
      new URL(`../test/fixtures/${provider}-stream.jsonl`, import.meta.url),
    ),
    'utf8',
  )
    .trim()
    .split('\n')

const cursorFailureFixture = () =>
  readFileSync(
    fileURLToPath(
      new URL('../test/fixtures/cursor-failure.jsonl', import.meta.url),
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

function catalog(
  provider: 'claude' | 'gemini' | 'cursor',
): ProviderModelCatalog {
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
          usage: 'supported',
          cost: 'unsupported',
        },
      },
    ],
  }
}

function cursorWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), 'cursor-policy-'))
  mkdirSync(join(workspace, '.cursor'))
  writeFileSync(
    join(workspace, '.cursor/cli.json'),
    JSON.stringify({
      permissions: {
        allow: ['Read(src/**)', 'Write(src/**)', 'Shell(rg)', 'Shell(pnpm)'],
        deny: [
          'Read(.env*)',
          'Write(.env*)',
          'Read(**/*.pem)',
          'Write(**/*.key)',
          'Read(**/*private-key*)',
          'Read(**/*credential*)',
        ],
      },
    }),
  )
  return workspace
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
  async probe(_input?: { binary: string; args: string[] }): Promise<{
    exitCode: number | null
    stdout: string
    stderr: string
    errorCode?: string
  }> {
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
      usage: {
        completeness: 'complete',
        requestId:
          provider === 'gemini' ? 'gemini-session-fixture' : expect.any(String),
      },
    })
    if (provider === 'gemini')
      expect(terminal.usage?.counters.cachedInputTokens).toBe(7)
    if (provider === 'gemini') expect(events).toContain('provider.unknown')
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
        return '2.1.109 0.50.0'
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
    expect(GEMINI_CLI_SUPPORTED_VERSIONS).toEqual(['0.25.0', '0.50.0'])
    expect(
      gemini.args({
        sessionId: null,
        prompt: 'x',
        cwd: '.',
        modelId: 'm',
        reasoningEffort: 'none',
      }),
    ).toContain('--skip-trust')
  })

  it('fails closed for unverified Gemini CLI versions', async () => {
    class UnsupportedRunner extends FixtureRunner {
      override async version() {
        return '0.49.0'
      }
    }
    const gemini = new GeminiCliRuntimeAdapter({
      catalog: catalog('gemini'),
      context: context(),
      runner: new UnsupportedRunner([]),
    })
    expect(await gemini.checkReadiness()).toMatchObject({
      ready: false,
      version: '0.49.0',
      code: 'version_mismatch',
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

describe('Cursor Agent adapter', () => {
  class CursorRunner extends FixtureRunner {
    lastRun:
      | { binary: string; args: string[]; cwd: string; stdinText?: string }
      | undefined

    override async run(input: {
      binary: string
      args: string[]
      cwd: string
      stdinText?: string
      onLine(line: string): void | Promise<void>
    }) {
      this.lastRun = {
        binary: input.binary,
        args: input.args,
        cwd: input.cwd,
        ...(input.stdinText !== undefined
          ? { stdinText: input.stdinText }
          : {}),
      }
      return super.run(input)
    }

    override async probe(input?: { binary: string; args: string[] }): Promise<{
      exitCode: number | null
      stdout: string
      stderr: string
      errorCode?: string
    }> {
      if (input?.args[0] === '--version')
        return {
          exitCode: 0,
          stdout: '2026.07.09-a3815c0',
          stderr: '',
        }
      return {
        exitCode: 0,
        stdout: '{"status":"authenticated","isAuthenticated":true}',
        stderr: '',
      }
    }
  }

  it('streams the verified 2026 system, assistant, tool, and terminal contract', async () => {
    const workspace = cursorWorkspace()
    try {
      const runner = new CursorRunner(fixture('cursor'))
      const adapter = new CursorAgentRuntimeAdapter({
        catalog: catalog('cursor'),
        context: context(),
        runner,
      })
      const observed: string[] = []
      const raw: Record<string, unknown>[] = []
      const terminal = await adapter.startTurn!(
        {
          sessionId: null,
          prompt: 'secret prompt',
          cwd: workspace,
          modelId: 'cursor-fixture-model',
          reasoningEffort: 'none',
          allowFileChanges: false,
        },
        (event) => {
          observed.push(event.normalized.event.type)
          raw.push(event.rawEnvelope)
        },
      )
      expect(observed).toEqual(
        expect.arrayContaining([
          'turn.started',
          'agent.message.delta',
          'agent.message.completed',
          'tool.started',
          'tool.completed',
          'turn.completed',
        ]),
      )
      expect(terminal).toMatchObject({
        providerSessionId: 'cursor-session-2026-fixture',
        outcome: 'completed',
        usage: {
          completeness: 'complete',
          requestId: 'cursor-request-2026-fixture',
          counters: {
            inputTokens: 6999,
            cachedInputTokens: 23936,
            outputTokens: 99,
          },
        },
      })
      expect(runner.lastRun?.args).not.toContain('secret prompt')
      expect(runner.lastRun?.stdinText).toBe('secret prompt')
      expect(runner.lastRun?.args).not.toContain('--force')
      expect(
        observed.filter((type) => type === 'agent.message.completed'),
      ).toHaveLength(1)
      expect(JSON.stringify(raw)).not.toContain('SYNTHETIC_FIXTURE_PROMPT')
      expect(JSON.stringify(raw)).not.toContain(
        'SYNTHETIC_REASONING_MUST_BE_SUPPRESSED',
      )
      expect(JSON.stringify(raw)).toContain('[REDACTED_USER_INPUT]')
      expect(JSON.stringify(raw)).toContain('[SUPPRESSED_REASONING]')
      expect(
        raw.some((envelope) => envelope.model_call_id === 'model-call-fixture'),
      ).toBe(true)
      expect(observed.filter((type) => type === 'cursor.unknown')).toHaveLength(
        3,
      )
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('preserves Cursor write tool lifecycle as file change events', () => {
    const started = normalizeCliEnvelope({
      provider: 'cursor',
      envelope: {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'write-fixture',
        tool_call: {
          writeToolCall: {
            args: { path: 'notes.txt', fileText: 'synthetic' },
          },
        },
        session_id: 'cursor-session-2026-fixture',
      },
      context: context(),
      sourceVersion: '2026.07.09-a3815c0',
    })
    const completed = normalizeCliEnvelope({
      provider: 'cursor',
      envelope: {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'write-fixture',
        tool_call: {
          writeToolCall: {
            args: { path: 'notes.txt', fileText: 'synthetic' },
            result: {
              success: {
                path: '/workspace/notes.txt',
                linesCreated: 1,
                fileSize: 9,
              },
            },
          },
        },
        session_id: 'cursor-session-2026-fixture',
      },
      context: context(),
      sourceVersion: '2026.07.09-a3815c0',
    })
    expect(started.normalized.event.type).toBe('file.change.proposed')
    expect(completed.normalized.event.type).toBe('file.change.completed')
  })

  it('enables --force only with explicit platform and project write permission', () => {
    const workspace = cursorWorkspace()
    try {
      const adapter = new CursorAgentRuntimeAdapter({
        catalog: catalog('cursor'),
        context: context(),
        runner: new CursorRunner([]),
      })
      const args = adapter.args({
        sessionId: 'chat-id',
        prompt: 'next',
        cwd: workspace,
        modelId: 'cursor-fixture-model',
        reasoningEffort: 'none',
        allowFileChanges: true,
      })
      expect(args).toEqual([
        '--print',
        '--trust',
        '--output-format',
        'stream-json',
        '--model',
        'cursor-fixture-model',
        '--resume',
        'chat-id',
        '--force',
      ])
      expect(args).not.toContain('next')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('reports binary, version, and auth readiness without exposing an API key', async () => {
    class ReadinessRunner extends CursorRunner {
      readonly mode:
        'missing' | 'nonexec' | 'unparseable' | 'mismatch' | 'auth' | 'ready'
      constructor(
        mode:
          'missing' | 'nonexec' | 'unparseable' | 'mismatch' | 'auth' | 'ready',
      ) {
        super([])
        this.mode = mode
      }
      override async probe(input?: {
        binary: string
        args: string[]
      }): Promise<{
        exitCode: number | null
        stdout: string
        stderr: string
        errorCode?: string
      }> {
        if (input?.args[0] === '--version') {
          if (this.mode === 'missing')
            return {
              exitCode: null,
              stdout: '',
              stderr: '',
              errorCode: 'ENOENT',
            }
          if (this.mode === 'nonexec')
            return {
              exitCode: null,
              stdout: '',
              stderr: '',
              errorCode: 'EACCES',
            }
          return {
            exitCode: 0,
            stdout:
              this.mode === 'unparseable'
                ? 'Cursor beta'
                : this.mode === 'mismatch'
                  ? '2026.07.09-unverified'
                  : '2026.07.09-a3815c0',
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          stdout:
            this.mode === 'ready'
              ? '{"status":"authenticated","isAuthenticated":true}'
              : '{"status":"unauthenticated","isAuthenticated":false}',
          stderr: '',
        }
      }
    }
    for (const [mode, code] of [
      ['missing', 'binary_missing'],
      ['nonexec', 'binary_not_executable'],
      ['unparseable', 'version_unparseable'],
      ['mismatch', 'version_mismatch'],
      ['auth', 'auth_required'],
    ] as const) {
      const adapter = new CursorAgentRuntimeAdapter({
        catalog: catalog('cursor'),
        context: context(),
        runner: new ReadinessRunner(mode),
      })
      expect(await adapter.checkReadiness()).toMatchObject({
        ready: false,
        code,
      })
    }
    const authenticated = new CursorAgentRuntimeAdapter({
      catalog: catalog('cursor'),
      context: context(),
      runner: new ReadinessRunner('ready'),
    })
    expect(await authenticated.checkReadiness()).toMatchObject({
      ready: true,
      authStatus: 'ready',
    })
    expect(JSON.stringify(await authenticated.checkReadiness())).not.toContain(
      'CURSOR_API_KEY',
    )
  })

  it('fails malformed JSON, early EOF, and terminal result errors', async () => {
    const workspace = cursorWorkspace()
    try {
      for (const [lines, expected] of [
        [['not-json'], 'protocol_mismatch'],
        [
          [
            JSON.stringify({
              type: 'system',
              subtype: 'init',
              session_id: 'early',
            }),
          ],
          'protocol_mismatch',
        ],
        [cursorFailureFixture(), 'process_failed'],
      ] as const) {
        const adapter = new CursorAgentRuntimeAdapter({
          catalog: catalog('cursor'),
          context: context(),
          runner: new CursorRunner([...lines]),
        })
        const terminal = await adapter.startTurn!(
          {
            sessionId: null,
            prompt: 'x',
            cwd: workspace,
            modelId: 'cursor-fixture-model',
            reasoningEffort: 'none',
          },
          () => undefined,
        )
        expect(terminal).toMatchObject({
          outcome: 'failed',
          error: { code: expected },
        })
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('bounds large Cursor tool output and exposes artifact spill data', () => {
    const content = `CURSOR_TOOL_OUTPUT:${'x'.repeat(70 * 1024)}`
    const normalized = normalizeCliEnvelope({
      provider: 'cursor',
      envelope: {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'large-read',
        tool_call: {
          readToolCall: {
            args: { path: 'large.txt' },
            result: { success: { content } },
          },
        },
      },
      context: context(),
      sourceVersion: '2026.07.09-a3815c0',
    })
    expect(normalized.spill?.data.byteLength).toBeGreaterThan(64 * 1024)
    expect(normalized.normalized.event).toMatchObject({
      type: 'tool.completed',
      payload: { result: { truncated: true, artifact: null } },
    })
    expect(JSON.stringify(normalized.rawEnvelope)).not.toContain(content)
  })

  it('validates deny precedence, sensitive paths, traversal, broad rules, and symlinks', () => {
    const workspace = cursorWorkspace()
    try {
      expect(loadCursorProjectPolicy(workspace)).toMatchObject({
        allowsWrites: true,
      })
      const config = join(workspace, '.cursor/cli.json')
      writeFileSync(
        config,
        JSON.stringify({
          permissions: {
            allow: ['Read(**/*)'],
            deny: [
              'Read(.env*)',
              'Read(**/*.pem)',
              'Write(**/*.key)',
              'Read(**/*private-key*)',
              'Read(**/*credential*)',
            ],
          },
        }),
      )
      expect(() => loadCursorProjectPolicy(workspace)).toThrow('broader')
      writeFileSync(
        config,
        JSON.stringify({
          permissions: {
            allow: ['Shell(rm)'],
            deny: [
              'Read(.env*)',
              'Read(**/*.pem)',
              'Write(**/*.key)',
              'Read(**/*private-key*)',
              'Read(**/*credential*)',
            ],
          },
        }),
      )
      expect(() => loadCursorProjectPolicy(workspace)).toThrow(
        'platform shell allowlist',
      )
      writeFileSync(
        config,
        JSON.stringify({
          permissions: {
            allow: ['Read(../outside)'],
            deny: [
              'Read(.env*)',
              'Read(**/*.pem)',
              'Write(**/*.key)',
              'Read(**/*private-key*)',
              'Read(**/*credential*)',
            ],
          },
        }),
      )
      expect(() => loadCursorProjectPolicy(workspace)).toThrow('traversal')
      symlinkSync('/tmp', join(workspace, 'escape'))
      writeFileSync(
        config,
        JSON.stringify({
          permissions: {
            allow: ['Read(escape/**)'],
            deny: [
              'Read(.env*)',
              'Read(**/*.pem)',
              'Write(**/*.key)',
              'Read(**/*private-key*)',
              'Read(**/*credential*)',
            ],
          },
        }),
      )
      expect(() => loadCursorProjectPolicy(workspace)).toThrow('symlink')
      rmSync(config)
      symlinkSync('/tmp', config)
      expect(() => loadCursorProjectPolicy(workspace)).toThrow('symlink')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('provider interrupt and timeout races', () => {
  const isReady = (line: string, mode: string) => {
    const event = JSON.parse(line) as Record<string, unknown>
    return event.type === 'ready' && event.mode === mode
  }
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
      onLine: (line) => {
        if (isReady(line, 'interrupt-exit')) started.resolve()
      },
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
      onLine: (line) => {
        if (isReady(line, 'ignore-signals')) started.resolve()
      },
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
      turnTimeoutMs: 2_000,
      interruptGraceMs: 10,
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
      onLine: (line) => {
        if (isReady(line, 'ignore-signals')) started.resolve()
      },
    })
    await started.promise
    const result = await running
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL' })
    expect(runner.active).toBe(false)
  }, 10_000)

  it('rejects oversized NDJSON lines with bounded stdout buffering', async () => {
    const runner = new SpawnCliProcessRunner({
      turnTimeoutMs: 20_000,
      maxLineBytes: 1_024,
      maxBufferBytes: 2_048,
    })
    const lifecycle = fileURLToPath(
      new URL('../test/fixtures/process-lifecycle.mjs', import.meta.url),
    )
    await expect(
      runner.run({
        binary: process.execPath,
        args: [lifecycle, 'oversized-line'],
        cwd: '.',
        onLine: () => undefined,
      }),
    ).rejects.toThrow(/limit/)
    expect(runner.active).toBe(false)
  }, 30_000)
})
