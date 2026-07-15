import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  parseTimelineEvent,
  type TimelineEvent,
} from '@persistent-codex/domain-events'
import {
  PROVIDER_CONTRACT_VERSION,
  providerModelCatalogSchema,
  providerNormalizedEventSchema,
  type ProviderApprovalResolution,
  type ProviderIdentity,
  ProviderConfigurationError,
  type ProviderInterrupt,
  type ProviderModelCatalog,
  type ProviderNormalizedEvent,
  type ProviderReadiness,
  type ProviderRuntimeAdapterV1,
  type ProviderTurnStartInput,
  type ProviderTurnStreamEvent,
  type ProviderTurnTerminal,
  type ProviderId,
  type UsageCounters,
  type UsageReport,
} from '@persistent-codex/provider-platform'

export const CLAUDE_CODE_VERSION = '2.1.109'
export const GEMINI_CLI_VERSION = '0.25.0'

const secretKey =
  /(?:authorization|api[-_]?key|access[-_]?token|bearer|password|secret)/i
const secretValue = /\b(?:bearer\s+\S+|(?:sk|sess)-[A-Za-z0-9_-]{8,})\b/gi
const homePath = /(?:\/Users|\/home)\/[^/\s]+/g

function redactText(value: string): string {
  return value.replace(secretValue, '[REDACTED]').replace(homePath, '[HOME]')
}

function safeErrorMessage(value: unknown): string {
  const text = redactText(
    value instanceof Error
      ? value.message
      : typeof value === 'object'
        ? JSON.stringify(redact(value))
        : String(value),
  )
  return text.split(/\r?\n/)[0]?.slice(0, 500) || 'Provider process failed'
}

function classifyProviderFailure(
  provider: 'claude' | 'gemini',
  value: unknown,
) {
  const message = safeErrorMessage(value)
  if (
    value instanceof ProviderConfigurationError &&
    value.code === 'REASONING_EFFORT_UNSUPPORTED'
  )
    return {
      code: 'capability_unsupported' as const,
      message,
      retryable: false,
      upstreamCode: 'REASONING_EFFORT_UNSUPPORTED',
    }
  if (/429|resource[_ ]exhausted|capacity|quota/i.test(message))
    return {
      code: 'capacity_exhausted' as const,
      message: `${provider} capacity is currently exhausted; retry later.`,
      retryable: true,
      upstreamCode: /429/.test(message) ? '429' : 'RESOURCE_EXHAUSTED',
    }
  if (/auth|login|credential|unauthor/i.test(message))
    return {
      code: 'unauthorized' as const,
      message: `${provider} authentication is required.`,
      retryable: false,
      upstreamCode: null,
    }
  return {
    code: 'process_failed' as const,
    message,
    retryable: false,
    upstreamCode: null,
  }
}

function redact(value: unknown, key?: string): unknown {
  if (key && secretKey.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(
      ([childKey, child]) => [childKey, redact(child, childKey)],
    ),
  )
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`
}

export interface CliRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
}
export interface CliProcessRunner {
  run(input: {
    binary: string
    args: string[]
    cwd: string
    onLine(line: string): void | Promise<void>
  }): Promise<CliRunResult>
  interrupt(): boolean
  version(binary: string): Promise<string | null>
  probe(input: { binary: string; args: string[] }): Promise<{
    exitCode: number | null
    stdout: string
    stderr: string
  }>
}

export class SpawnCliProcessRunner implements CliProcessRunner {
  #active: ChildProcessWithoutNullStreams | null = null

  async run(input: {
    binary: string
    args: string[]
    cwd: string
    onLine(line: string): void | Promise<void>
  }): Promise<CliRunResult> {
    if (this.#active) throw new Error('Provider process already active')
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end()
    this.#active = child
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192)
    })
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    const pending: Promise<void>[] = []
    lines.on('line', (line) =>
      pending.push(Promise.resolve(input.onLine(line))),
    )
    try {
      const result = await new Promise<CliRunResult>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
      })
      await Promise.all(pending)
      if (result.exitCode && stderr)
        throw new Error(redactText(stderr).replace(/\s+/g, ' ').trim())
      return result
    } finally {
      this.#active = null
    }
  }

  interrupt(): boolean {
    return this.#active?.kill('SIGINT') ?? false
  }

  async version(binary: string): Promise<string | null> {
    return await new Promise((resolve) => {
      const child = spawn(binary, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let output = ''
      child.stdout.on(
        'data',
        (chunk: Buffer) => (output += chunk.toString('utf8')),
      )
      child.once('error', () => resolve(null))
      child.once('exit', (code) => resolve(code === 0 ? output.trim() : null))
    })
  }

  async probe(input: { binary: string; args: string[] }) {
    return await new Promise<{
      exitCode: number | null
      stdout: string
      stderr: string
    }>((resolve) => {
      const child = spawn(input.binary, input.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (result: {
        exitCode: number | null
        stdout: string
        stderr: string
      }) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(result)
      }
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
        finish({ exitCode: null, stdout: '', stderr: 'probe timeout' })
      }, 5_000)
      timeout.unref()
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = `${stdout}${chunk.toString('utf8')}`.slice(-8192)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192)
      })
      child.once('error', () =>
        finish({ exitCode: null, stdout: '', stderr: '' }),
      )
      child.once('exit', (exitCode) =>
        finish({
          exitCode,
          stdout: redactText(stdout),
          stderr: redactText(stderr),
        }),
      )
    })
  }
}

export interface ProviderEventContext {
  tenantId: string
  workspaceId: string
  sessionId: string
  nextSequence(): number
  now?(): Date
  nextEventId?(): string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function textParts(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const part = record(item)
    return part?.type === 'text' && typeof part.text === 'string'
      ? [part.text]
      : []
  })
}

function counters(value: unknown): UsageCounters | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const number = (...keys: string[]) => {
    for (const key of keys)
      if (typeof usage[key] === 'number') return usage[key] as number
    return 0
  }
  return {
    inputTokens: number('input_tokens', 'promptTokenCount', 'input'),
    cachedInputTokens: number(
      'cache_read_input_tokens',
      'cachedContentTokenCount',
      'cached',
    ),
    outputTokens: number('output_tokens', 'candidatesTokenCount', 'output'),
    reasoningTokens: number('reasoning_tokens', 'thoughtsTokenCount'),
    toolUnits: 0,
  }
}

export function normalizeCliEnvelope(input: {
  provider: 'claude' | 'gemini'
  envelope: unknown
  context: ProviderEventContext
  sourceVersion: string
}): {
  rawEnvelope: Record<string, unknown>
  normalized: ProviderNormalizedEvent
  usage?: UsageReport
} {
  const raw = redact(
    record(input.envelope) ?? { malformed: input.envelope },
  ) as Record<string, unknown>
  const checksum = createHash('sha256').update(canonical(raw)).digest('hex')
  const type = typeof raw.type === 'string' ? raw.type : 'malformed'
  const now = (input.context.now?.() ?? new Date()).toISOString()
  const base = {
    eventId: input.context.nextEventId?.() ?? `evt_${randomUUID()}`,
    schemaVersion: 1 as const,
    tenantId: input.context.tenantId,
    workspaceId: input.context.workspaceId,
    sessionId: input.context.sessionId,
    sequence: input.context.nextSequence(),
    occurredAt: now,
    receivedAt: now,
    source:
      input.provider === 'claude'
        ? ('claude-code' as const)
        : ('gemini-cli' as const),
    sourceVersion: input.sourceVersion,
    sourceMethod: type,
    visibility: 'user' as const,
  }
  let event: TimelineEvent
  if (type === 'init' || (type === 'system' && raw.subtype === 'init')) {
    event = parseTimelineEvent({
      ...base,
      type: 'turn.started',
      payload: { status: 'in_progress' },
    })
  } else if (type === 'message' || type === 'assistant') {
    const message = record(raw.message)
    const text = textParts(raw.content ?? message?.content ?? raw.delta).join(
      '',
    )
    event = parseTimelineEvent({
      ...base,
      type: 'agent.message.delta',
      payload: { text },
    })
  } else if (type === 'tool_use') {
    event = parseTimelineEvent({
      ...base,
      type: 'tool.started',
      payload: {
        toolKind: 'dynamic',
        tool: String(raw.name ?? 'unknown'),
        provider: input.provider,
        status: 'in_progress',
        arguments: raw.parameters ?? raw.input ?? null,
      },
    })
  } else if (type === 'tool_result') {
    event = parseTimelineEvent({
      ...base,
      type: 'tool.completed',
      payload: {
        toolKind: 'dynamic',
        tool: String(raw.name ?? 'unknown'),
        provider: input.provider,
        status: 'completed',
        result: raw.output ?? raw.result ?? null,
        error: null,
        success: true,
        durationMs: null,
      },
    })
  } else if (type === 'result') {
    const failed =
      raw.is_error === true ||
      record(raw.error) !== undefined ||
      (typeof raw.status === 'string' && raw.status !== 'success') ||
      (typeof raw.subtype === 'string' && raw.subtype.startsWith('error'))
    event = parseTimelineEvent({
      ...base,
      type: 'turn.completed',
      payload: {
        status: failed ? 'failed' : 'completed',
        ...(failed ? { errorCode: 'PROVIDER_RESULT_ERROR' } : {}),
      },
    })
  } else if (type === 'error') {
    event = parseTimelineEvent({
      ...base,
      type: 'error.reported',
      payload: {
        message: String(
          record(raw.error)?.message ?? raw.message ?? 'Provider error',
        ),
        additionalDetails: null,
        codexErrorInfo: null,
        willRetry: false,
      },
    })
  } else {
    event = parseTimelineEvent({
      ...base,
      type: 'provider.unknown',
      visibility: 'internal',
      payload: { provider: input.provider, eventType: type, envelope: raw },
    })
  }
  const usageCounters = counters(
    raw.usage ?? raw.stats ?? record(raw.result)?.stats,
  )
  const usage = usageCounters
    ? {
        schemaVersion: 1 as const,
        kind: 'cumulative' as const,
        provider: input.provider,
        requestId: String(
          raw.request_id ?? raw.session_id ?? raw.sessionId ?? 'unknown',
        ),
        dedupeKey: `${input.provider}:${checksum}:usage`,
        counters: usageCounters,
        completeness:
          type === 'result' ? ('complete' as const) : ('partial' as const),
        occurredAt: now,
      }
    : undefined
  return {
    rawEnvelope: raw,
    normalized: providerNormalizedEventSchema.parse({
      schemaVersion: 1,
      provider: input.provider,
      rawEnvelopeChecksum: checksum,
      event,
    }),
    ...(usage ? { usage } : {}),
  }
}

interface CliAdapterOptions {
  catalog: ProviderModelCatalog
  context: ProviderEventContext
  runner?: CliProcessRunner
  binary?: string
}

abstract class CliProviderAdapter implements ProviderRuntimeAdapterV1 {
  readonly contractVersion = PROVIDER_CONTRACT_VERSION
  readonly identity: ProviderIdentity
  readonly catalog: ProviderModelCatalog
  readonly context: ProviderEventContext
  readonly runner: CliProcessRunner
  readonly binary: string
  readonly provider: 'claude' | 'gemini'
  readonly pinnedVersion: string

  constructor(
    provider: 'claude' | 'gemini',
    options: CliAdapterOptions,
    defaults: { binary: string; version: string; adapter: string },
  ) {
    this.provider = provider
    const configuredCatalog = providerModelCatalogSchema.parse(options.catalog)
    this.catalog =
      provider === 'gemini'
        ? providerModelCatalogSchema.parse({
            ...configuredCatalog,
            models: configuredCatalog.models.map((model) => ({
              ...model,
              reasoningEfforts: ['none'],
              defaultReasoningEffort: 'none',
            })),
          })
        : configuredCatalog
    if (this.catalog.identity.provider !== provider)
      throw new Error(`Catalog provider must be ${provider}`)
    this.context = options.context
    this.runner = options.runner ?? new SpawnCliProcessRunner()
    this.binary = options.binary ?? defaults.binary
    this.pinnedVersion = defaults.version
    this.identity = {
      provider,
      adapter: defaults.adapter,
      adapterVersion: '1',
      upstreamVersion: defaults.version,
    }
  }

  async discoverModelCatalog() {
    return this.catalog
  }
  normalizeEvent(input: unknown) {
    return normalizeCliEnvelope({
      provider: this.provider,
      envelope: input,
      context: this.context,
      sourceVersion: this.pinnedVersion,
    }).normalized
  }
  async interrupt(_input: ProviderInterrupt) {
    if (!this.runner.interrupt())
      throw new Error('No active provider turn to interrupt')
  }
  async resolveApproval(_input: ProviderApprovalResolution) {
    throw new Error(
      `${this.provider} headless approval resolution is unsupported`,
    )
  }
  async checkReadiness(): Promise<ProviderReadiness> {
    const output = await this.runner.version(this.binary)
    if (!output)
      return {
        ready: false,
        version: null,
        authReady: false,
        authStatus: 'required',
        code: 'binary_missing',
        instruction: this.installInstruction(),
      }
    const matches = output.includes(this.pinnedVersion)
    if (!matches)
      return {
        ready: false,
        version: output,
        authReady: false,
        authStatus: 'required',
        code: 'version_mismatch',
        instruction: this.installInstruction(),
      }
    if (this.provider === 'gemini')
      return {
        ready: true,
        version: output,
        authReady: null,
        authStatus: 'unknown',
        code: 'auth_unknown',
        instruction:
          'Gemini CLI authentication cannot be checked without starting a request; run a provider smoke before relying on it.',
      }
    const auth = await this.runner.probe({
      binary: this.binary,
      args: ['auth', 'status', '--json'],
    })
    let loggedIn = false
    try {
      loggedIn = record(JSON.parse(auth.stdout))?.loggedIn === true
    } catch {
      loggedIn = false
    }
    return {
      ready: loggedIn,
      version: output,
      authReady: loggedIn,
      authStatus: loggedIn ? 'ready' : 'required',
      code: loggedIn ? 'ready' : 'auth_required',
      instruction: loggedIn ? null : 'Run `claude auth login`, then retry.',
    }
  }

  abstract installInstruction(): string
  abstract args(input: ProviderTurnStartInput): string[]

  async startTurn(
    input: ProviderTurnStartInput,
    onEvent: (event: ProviderTurnStreamEvent) => void | Promise<void>,
  ): Promise<ProviderTurnTerminal> {
    const attempts = this.provider === 'gemini' ? 3 : 1
    let terminal: ProviderTurnTerminal | undefined
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      terminal = await this.startTurnOnce(input, onEvent)
      if (terminal.error?.code !== 'capacity_exhausted') return terminal
      if (attempt < attempts)
        await new Promise((resolve) => setTimeout(resolve, attempt * 250))
    }
    return terminal!
  }

  private async startTurnOnce(
    input: ProviderTurnStartInput,
    onEvent: (event: ProviderTurnStreamEvent) => void | Promise<void>,
  ): Promise<ProviderTurnTerminal> {
    let providerSessionId = input.sessionId
    let providerTurnId = `turn_${randomUUID()}`
    let terminal: 'completed' | 'failed' | 'interrupted' | undefined
    let terminalUsage: UsageReport | undefined
    let terminalFailure: ReturnType<typeof classifyProviderFailure> | undefined
    try {
      const result = await this.runner.run({
        binary: this.binary,
        args: this.args(input),
        cwd: input.cwd,
        onLine: async (line) => {
          let envelope: unknown
          try {
            envelope = JSON.parse(line)
          } catch {
            envelope = { type: 'malformed', line }
          }
          const parsed = record(envelope)
          if (
            parsed?.type === 'system' &&
            parsed.subtype === 'api_retry' &&
            (parsed.error_status === 401 ||
              parsed.error === 'authentication_failed')
          ) {
            terminal = 'failed'
            terminalFailure = classifyProviderFailure(
              this.provider,
              'authentication_failed',
            )
            this.runner.interrupt()
          }
          const discoveredSession = parsed?.session_id ?? parsed?.sessionId
          if (typeof discoveredSession === 'string')
            providerSessionId = discoveredSession
          const discoveredTurn = parsed?.turn_id ?? parsed?.turnId
          if (typeof discoveredTurn === 'string')
            providerTurnId = discoveredTurn
          const normalized = normalizeCliEnvelope({
            provider: this.provider,
            envelope,
            context: this.context,
            sourceVersion: this.pinnedVersion,
          })
          if (normalized.normalized.event.type === 'turn.completed')
            terminal = normalized.normalized.event.payload.status as
              'completed' | 'failed'
          if (terminal === 'failed')
            terminalFailure ??= classifyProviderFailure(this.provider, envelope)
          if (normalized.usage) terminalUsage = normalized.usage
          await onEvent(normalized)
        },
      })
      if (result.signal === 'SIGINT' && !terminalFailure)
        terminal = 'interrupted'
      else if (result.exitCode !== 0) terminal = 'failed'
      else terminal ??= 'completed'
    } catch (error) {
      const failure = classifyProviderFailure(this.provider, error)
      return {
        providerSessionId: providerSessionId ?? `session_${randomUUID()}`,
        providerTurnId,
        outcome: 'failed',
        ...(terminalUsage ? { usage: terminalUsage } : {}),
        error: {
          schemaVersion: 1,
          provider: this.provider,
          ...failure,
        },
      }
    }
    return {
      providerSessionId: providerSessionId ?? `session_${randomUUID()}`,
      providerTurnId,
      outcome: terminal,
      ...(terminalUsage ? { usage: terminalUsage } : {}),
      ...(terminal === 'failed'
        ? {
            error: {
              schemaVersion: 1 as const,
              provider: this.provider,
              ...(terminalFailure ??
                classifyProviderFailure(
                  this.provider,
                  'Provider result error',
                )),
            },
          }
        : {}),
    }
  }
}

export class ClaudeCodeRuntimeAdapter extends CliProviderAdapter {
  constructor(options: CliAdapterOptions) {
    super('claude', options, {
      binary: 'claude',
      version: CLAUDE_CODE_VERSION,
      adapter: 'claude-code-stream-json',
    })
  }
  installInstruction() {
    return `npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && claude login`
  }
  args(input: ProviderTurnStartInput) {
    const effort =
      input.reasoningEffort === 'xhigh' ? 'max' : input.reasoningEffort
    if (effort === 'minimal')
      throw new ProviderConfigurationError(
        'REASONING_EFFORT_UNSUPPORTED',
        'Claude Code does not support reasoning effort minimal; choose none, low, medium, high, or xhigh (mapped to max).',
      )
    return [
      '-p',
      input.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      input.modelId,
      ...(effort === 'none' ? [] : ['--effort', effort]),
      ...(input.sessionId ? ['--resume', input.sessionId] : []),
    ]
  }
}

export class GeminiCliRuntimeAdapter extends CliProviderAdapter {
  constructor(options: CliAdapterOptions) {
    super('gemini', options, {
      binary: 'gemini',
      version: GEMINI_CLI_VERSION,
      adapter: 'gemini-cli-stream-json',
    })
  }
  installInstruction() {
    return `npm install -g @google/gemini-cli@${GEMINI_CLI_VERSION} && gemini`
  }
  args(input: ProviderTurnStartInput) {
    if (input.reasoningEffort !== 'none')
      throw new ProviderConfigurationError(
        'REASONING_EFFORT_UNSUPPORTED',
        `Gemini CLI ${GEMINI_CLI_VERSION} does not support reasoning effort overrides; choose none.`,
      )
    return [
      '-p',
      input.prompt,
      '--output-format',
      'stream-json',
      '--model',
      input.modelId,
      ...(input.sessionId ? ['--resume', input.sessionId] : []),
    ]
  }
}
