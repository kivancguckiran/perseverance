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
    this.catalog = providerModelCatalogSchema.parse(options.catalog)
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
        code: 'binary_missing',
        instruction: this.installInstruction(),
      }
    const matches = output.includes(this.pinnedVersion)
    return {
      ready: matches,
      version: output,
      authReady: matches,
      code: matches ? 'ready' : 'version_mismatch',
      instruction: matches ? null : this.installInstruction(),
    }
  }

  abstract installInstruction(): string
  abstract args(input: ProviderTurnStartInput): string[]

  async startTurn(
    input: ProviderTurnStartInput,
    onEvent: (event: ProviderTurnStreamEvent) => void | Promise<void>,
  ): Promise<ProviderTurnTerminal> {
    let providerSessionId = input.sessionId
    let providerTurnId = `turn_${randomUUID()}`
    let terminal: 'completed' | 'failed' | 'interrupted' | undefined
    let terminalUsage: UsageReport | undefined
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
          if (normalized.usage) terminalUsage = normalized.usage
          await onEvent(normalized)
        },
      })
      if (result.signal === 'SIGINT') terminal = 'interrupted'
      else if (result.exitCode !== 0) terminal = 'failed'
      else terminal ??= 'completed'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        providerSessionId: providerSessionId ?? `session_${randomUUID()}`,
        providerTurnId,
        outcome: 'failed',
        ...(terminalUsage ? { usage: terminalUsage } : {}),
        error: {
          schemaVersion: 1,
          provider: this.provider,
          code: /auth|login|credential|unauthor/i.test(message)
            ? 'unauthorized'
            : 'process_failed',
          message,
          retryable: false,
          upstreamCode: null,
        },
      }
    }
    return {
      providerSessionId: providerSessionId ?? `session_${randomUUID()}`,
      providerTurnId,
      outcome: terminal,
      ...(terminalUsage ? { usage: terminalUsage } : {}),
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
    return [
      '-p',
      input.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      input.modelId,
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
