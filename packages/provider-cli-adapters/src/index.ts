import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
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
  type ProviderError,
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
export const GEMINI_CLI_VERSION = '0.50.0'
export const GEMINI_CLI_SUPPORTED_VERSIONS = ['0.25.0', '0.50.0'] as const
export const GEMINI_CLI_VERSION_POLICY =
  GEMINI_CLI_SUPPORTED_VERSIONS.join(', ')
export const CURSOR_AGENT_SUPPORTED_VERSIONS = [
  '2026.07.09-a3815c0',
  '2026.07.16-899851b',
] as const
export const CURSOR_AGENT_VERSION_POLICY =
  CURSOR_AGENT_SUPPORTED_VERSIONS.join(', ')
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_INLINE_TOOL_BYTES = 64 * 1024

type CliProvider = 'claude' | 'gemini' | 'cursor'

const secretKey =
  /(?:authorization|api[-_]?key|access[-_]?token|bearer|password|secret)/i
const secretValue = /\b(?:bearer\s+\S+|(?:sk|sess)-[A-Za-z0-9_-]{8,})\b/gi
const assignedSecret =
  /\b(?:CURSOR_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|OPENAI_API_KEY)\s*=\s*[^\s"']+/gi
const homePath = /(?:\/Users|\/home)\/[^/\s]+/g

function redactText(value: string): string {
  return value
    .replace(assignedSecret, '[REDACTED]')
    .replace(secretValue, '[REDACTED]')
    .replace(homePath, '[HOME]')
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

type ClassifiedProviderFailure = Omit<
  ProviderError,
  'schemaVersion' | 'provider'
>

function classifyProviderFailure(
  provider: CliProvider,
  value: unknown,
): ClassifiedProviderFailure {
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
  if (
    value instanceof ProviderConfigurationError &&
    value.code.startsWith('CURSOR_PERMISSION_')
  )
    return {
      code: 'invalid_request' as const,
      message,
      retryable: false,
      upstreamCode: value.code,
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
  if (
    /malformed|json|line.*large|buffer|terminal event|early eof/i.test(message)
  )
    return {
      code: 'protocol_mismatch' as const,
      message,
      retryable: false,
      upstreamCode: 'STREAM_PROTOCOL_MISMATCH',
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
  interruptRequested?: boolean
  timedOut?: boolean
}
export interface CliProcessRunner {
  run(input: {
    binary: string
    args: string[]
    cwd: string
    stdinText?: string
    onLine(line: string): void | Promise<void>
  }): Promise<CliRunResult>
  interrupt(): boolean
  version(binary: string): Promise<string | null>
  probe(input: { binary: string; args: string[] }): Promise<{
    exitCode: number | null
    stdout: string
    stderr: string
    errorCode?: string
  }>
}

interface ActiveCliProcess {
  child: ChildProcessWithoutNullStreams
  interruptRequested: boolean
  timedOut: boolean
  timers: Set<NodeJS.Timeout>
}

export class SpawnCliProcessRunner implements CliProcessRunner {
  readonly #limits: {
    turnTimeoutMs: number
    interruptGraceMs: number
    terminateGraceMs: number
    maxLineBytes: number
    maxBufferBytes: number
  }
  #active: ActiveCliProcess | undefined

  constructor(
    limits: Partial<{
      turnTimeoutMs: number
      interruptGraceMs: number
      terminateGraceMs: number
      maxLineBytes: number
      maxBufferBytes: number
    }> = {},
  ) {
    this.#limits = {
      turnTimeoutMs: limits.turnTimeoutMs ?? 120_000,
      interruptGraceMs: limits.interruptGraceMs ?? 1_000,
      terminateGraceMs: limits.terminateGraceMs ?? 1_000,
      maxLineBytes: limits.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      maxBufferBytes: limits.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
    }
  }

  get active(): boolean {
    return this.#active !== undefined
  }

  #schedule(active: ActiveCliProcess, callback: () => void, delay: number) {
    const timer = setTimeout(callback, delay)
    timer.unref()
    active.timers.add(timer)
  }

  #escalate(active: ActiveCliProcess, firstSignal: 'SIGINT' | 'SIGTERM') {
    if (active.child.exitCode !== null || active.child.signalCode !== null)
      return false
    const sent = active.child.kill(firstSignal)
    this.#schedule(
      active,
      () => {
        if (active.child.exitCode === null && active.child.signalCode === null)
          active.child.kill('SIGTERM')
      },
      firstSignal === 'SIGINT' ? this.#limits.interruptGraceMs : 0,
    )
    this.#schedule(
      active,
      () => {
        if (active.child.exitCode === null && active.child.signalCode === null)
          active.child.kill('SIGKILL')
      },
      (firstSignal === 'SIGINT' ? this.#limits.interruptGraceMs : 0) +
        this.#limits.terminateGraceMs,
    )
    return sent
  }

  async run(input: {
    binary: string
    args: string[]
    cwd: string
    stdinText?: string
    onLine(line: string): void | Promise<void>
  }): Promise<CliRunResult> {
    if (this.#active) throw new Error('Provider process already active')
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end(input.stdinText)
    const active = {
      child,
      interruptRequested: false,
      timedOut: false,
      timers: new Set<NodeJS.Timeout>(),
    }
    this.#active = active
    this.#schedule(
      active,
      () => {
        active.timedOut = true
        this.#escalate(active, 'SIGTERM')
      },
      this.#limits.turnTimeoutMs,
    )
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192)
    })
    let stdoutBuffer = Buffer.alloc(0)
    let lineFailure: Error | undefined
    let lineChain = Promise.resolve()
    child.stdout.on('data', (chunk: Buffer) => {
      if (lineFailure) return
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk])
      if (stdoutBuffer.byteLength > this.#limits.maxBufferBytes) {
        lineFailure = new Error('Provider stdout buffer exceeded its limit')
        child.kill('SIGKILL')
        return
      }
      let newline = stdoutBuffer.indexOf(0x0a)
      while (newline >= 0) {
        const lineBytes = stdoutBuffer.subarray(0, newline)
        stdoutBuffer = stdoutBuffer.subarray(newline + 1)
        if (lineBytes.byteLength > this.#limits.maxLineBytes) {
          lineFailure = new Error('Provider stdout line exceeded its limit')
          child.kill('SIGKILL')
          return
        }
        const line = lineBytes.toString('utf8').replace(/\r$/, '')
        child.stdout.pause()
        lineChain = lineChain
          .then(() => input.onLine(line))
          .then(() => {
            child.stdout.resume()
          })
          .catch((error) => {
            lineFailure =
              error instanceof Error ? error : new Error(String(error))
            child.kill('SIGKILL')
          })
        newline = stdoutBuffer.indexOf(0x0a)
      }
    })
    try {
      const result = await new Promise<CliRunResult>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (exitCode, signal) =>
          resolve({
            exitCode,
            signal,
            interruptRequested: active.interruptRequested,
            timedOut: active.timedOut,
          }),
        )
      })
      await lineChain
      if (stdoutBuffer.byteLength > 0) {
        if (stdoutBuffer.byteLength > this.#limits.maxLineBytes)
          throw new Error('Provider stdout line exceeded its limit')
        await input.onLine(stdoutBuffer.toString('utf8').replace(/\r$/, ''))
      }
      if (lineFailure) throw lineFailure
      if (
        result.exitCode &&
        stderr &&
        !result.interruptRequested &&
        !result.timedOut
      )
        throw new Error(redactText(stderr).replace(/\s+/g, ' ').trim())
      return result
    } finally {
      for (const timer of active.timers) clearTimeout(timer)
      child.stdout.destroy()
      child.stderr.destroy()
      if (this.#active === active) this.#active = undefined
    }
  }

  interrupt(): boolean {
    const active = this.#active
    if (!active) return false
    if (active.interruptRequested) return true
    if (!this.#escalate(active, 'SIGINT')) return false
    active.interruptRequested = true
    return true
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
      child.once('error', (error: NodeJS.ErrnoException) =>
        finish({
          exitCode: null,
          stdout: '',
          stderr: '',
          ...(error.code ? { errorCode: error.code } : {}),
        }),
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
  turnId?: string
  nextSequence(): number
  now?(): Date
  nextEventId?(): string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export interface CursorProjectPolicy {
  allow: string[]
  deny: string[]
  allowsWrites: boolean
}

const cursorPermission = /^(Shell|Read|Write)\((.*)\)$/
const sensitiveDenyChecks = [
  /\.env/i,
  /\.(?:pem|key)/i,
  /credential/i,
  /private.?key/i,
]
const cursorPlatformShellAllow = new Set([
  'cat',
  'find',
  'git',
  'ls',
  'node',
  'npm',
  'pnpm',
  'rg',
  'sed',
  'tsc',
  'tsx',
  'vitest',
])

function assertWorkspacePath(workspace: string, candidate: string) {
  if (candidate.includes('\0') || candidate.split(/[\\/]/).includes('..'))
    throw new ProviderConfigurationError(
      'CURSOR_PERMISSION_POLICY_INVALID',
      `Cursor permission path ${candidate} contains traversal`,
    )
  if (/^\/(?:proc|sys)(?:\/|$)/.test(candidate))
    throw new ProviderConfigurationError(
      'CURSOR_PERMISSION_POLICY_INVALID',
      `Cursor permission path ${candidate} targets a forbidden system path`,
    )
  if (isAbsolute(candidate)) {
    const normalizedWorkspace = realpathSync(workspace)
    const normalizedCandidate = resolve(candidate)
    const scoped = relative(normalizedWorkspace, normalizedCandidate)
    if (scoped.startsWith('..') || isAbsolute(scoped))
      throw new ProviderConfigurationError(
        'CURSOR_PERMISSION_POLICY_INVALID',
        `Cursor permission path ${candidate} escapes the workspace`,
      )
  }
  const staticPrefix = candidate.split(/[*?]/, 1)[0]!.replace(/\/+$/, '')
  if (staticPrefix) {
    const prefixPath = resolve(workspace, staticPrefix)
    if (existsSync(prefixPath)) {
      const canonical = realpathSync(prefixPath)
      const scoped = relative(workspace, canonical)
      if (scoped.startsWith('..') || isAbsolute(scoped))
        throw new ProviderConfigurationError(
          'CURSOR_PERMISSION_POLICY_INVALID',
          `Cursor permission path ${candidate} follows a symlink outside the workspace`,
        )
    }
  }
}

export function loadCursorProjectPolicy(
  workspace: string,
): CursorProjectPolicy {
  const root = realpathSync(workspace)
  const configPath = resolve(root, '.cursor/cli.json')
  const configRelative = relative(root, configPath)
  if (configRelative.startsWith('..') || isAbsolute(configRelative))
    throw new ProviderConfigurationError(
      'CURSOR_PERMISSION_POLICY_INVALID',
      'Cursor project policy path escapes the workspace',
    )
  let config: unknown
  try {
    const cursorDirectory = dirname(configPath)
    if (lstatSync(cursorDirectory).isSymbolicLink())
      throw new Error('.cursor directory must not be a symlink')
    if (lstatSync(configPath).isSymbolicLink())
      throw new Error('cli.json must not be a symlink')
    const canonical = realpathSync(configPath)
    const scoped = relative(root, canonical)
    if (scoped.startsWith('..') || isAbsolute(scoped))
      throw new Error('cli.json resolves outside the workspace')
    if (!statSync(canonical).isFile()) throw new Error('cli.json is not a file')
    config = JSON.parse(readFileSync(canonical, 'utf8')) as unknown
  } catch (error) {
    throw new ProviderConfigurationError(
      'CURSOR_PERMISSION_POLICY_INVALID',
      `Create a valid <workspace>/.cursor/cli.json before starting Cursor: ${safeErrorMessage(error)}`,
    )
  }
  const permissions = record(record(config)?.permissions)
  if (
    !permissions ||
    !Array.isArray(permissions.allow) ||
    !Array.isArray(permissions.deny)
  )
    throw new ProviderConfigurationError(
      'CURSOR_PERMISSION_POLICY_INVALID',
      'Cursor cli.json must contain permissions.allow and permissions.deny arrays',
    )
  const parseRules = (value: unknown[], kind: 'allow' | 'deny') =>
    value.map((rule) => {
      if (typeof rule !== 'string')
        throw new ProviderConfigurationError(
          'CURSOR_PERMISSION_POLICY_INVALID',
          `Cursor permissions.${kind} entries must be strings`,
        )
      const matched = cursorPermission.exec(rule)
      if (!matched)
        throw new ProviderConfigurationError(
          'CURSOR_PERMISSION_POLICY_INVALID',
          `Cursor permission ${rule} is not a supported Shell/Read/Write token`,
        )
      const permissionKind = matched[1]!
      const target = matched[2]!.trim()
      if (!target)
        throw new ProviderConfigurationError(
          'CURSOR_PERMISSION_POLICY_INVALID',
          `Cursor permission ${rule} has an empty target`,
        )
      if (permissionKind === 'Read' || permissionKind === 'Write') {
        assertWorkspacePath(root, target)
        if (
          kind === 'allow' &&
          ['*', '**', '**/*', './**', `${root}/**`].includes(target)
        )
          throw new ProviderConfigurationError(
            'CURSOR_PERMISSION_POLICY_TOO_BROAD',
            `Cursor permission ${rule} is broader than the platform policy`,
          )
      }
      if (
        permissionKind === 'Shell' &&
        kind === 'allow' &&
        !cursorPlatformShellAllow.has(target)
      )
        throw new ProviderConfigurationError(
          'CURSOR_PERMISSION_POLICY_TOO_BROAD',
          `Cursor permission ${rule} is outside the platform shell allowlist`,
        )
      return rule
    })
  const allow = parseRules(permissions.allow, 'allow')
  const deny = parseRules(permissions.deny, 'deny')
  for (const required of sensitiveDenyChecks)
    if (!deny.some((rule) => required.test(rule)))
      throw new ProviderConfigurationError(
        'CURSOR_PERMISSION_POLICY_INVALID',
        'Cursor deny policy must cover .env, private-key, key/pem, and credential files',
      )
  return {
    allow,
    deny,
    allowsWrites: allow.some((rule) => rule.startsWith('Write(')),
  }
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
    inputTokens: number(
      'input_tokens',
      'inputTokens',
      'promptTokenCount',
      'input',
    ),
    cachedInputTokens: number(
      'cache_read_input_tokens',
      'cacheReadTokens',
      'cachedContentTokenCount',
      'cached',
    ),
    outputTokens: number(
      'output_tokens',
      'outputTokens',
      'candidatesTokenCount',
      'output',
    ),
    reasoningTokens: number(
      'reasoning_tokens',
      'reasoningTokens',
      'thoughtsTokenCount',
    ),
    toolUnits: 0,
  }
}

export function normalizeCliEnvelope(input: {
  provider: CliProvider
  envelope: unknown
  context: ProviderEventContext
  sourceVersion: string
}): {
  rawEnvelope: Record<string, unknown>
  normalized: ProviderNormalizedEvent
  usage?: UsageReport
  spill?: NonNullable<ProviderTurnStreamEvent['spill']>
} {
  const raw = redact(
    record(input.envelope) ?? { malformed: input.envelope },
  ) as Record<string, unknown>
  if (input.provider === 'cursor' && raw.type === 'thinking') {
    if ('text' in raw) raw.text = '[SUPPRESSED_REASONING]'
    if ('message' in raw) raw.message = '[SUPPRESSED_REASONING]'
    if ('content' in raw) raw.content = '[SUPPRESSED_REASONING]'
  }
  if (input.provider === 'cursor' && raw.type === 'user' && 'message' in raw)
    raw.message = {
      role: 'user',
      content: [{ type: 'text', text: '[REDACTED_USER_INPUT]' }],
    }
  if (
    input.provider === 'gemini' &&
    raw.type === 'message' &&
    raw.role === 'user' &&
    'content' in raw
  )
    raw.content = '[REDACTED_USER_INPUT]'
  let checksum = ''
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
        : input.provider === 'gemini'
          ? ('gemini-cli' as const)
          : ('cursor-agent' as const),
    sourceVersion: input.sourceVersion,
    sourceMethod: type,
    visibility: 'user' as const,
    ...(typeof raw.session_id === 'string'
      ? { codexThreadId: raw.session_id }
      : {}),
    ...(input.context.turnId ? { codexTurnId: input.context.turnId } : {}),
    ...(typeof raw.call_id === 'string' ? { codexItemId: raw.call_id } : {}),
  }
  let event: TimelineEvent
  let spill: NonNullable<ProviderTurnStreamEvent['spill']> | undefined
  if (type === 'init' || (type === 'system' && raw.subtype === 'init')) {
    event = parseTimelineEvent({
      ...base,
      type: 'turn.started',
      payload: { status: 'in_progress' },
    })
  } else if (
    (type === 'message' && raw.role !== 'user') ||
    type === 'assistant'
  ) {
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
  } else if (type === 'tool_call' && input.provider === 'cursor') {
    const toolCall = record(raw.tool_call)
    const [toolName = 'unknown', toolValue] =
      Object.entries(toolCall ?? {})[0] ?? []
    const tool = record(toolValue)
    const args = record(tool?.args)
    const result = record(tool?.result)
    const started = raw.subtype === 'started'
    const write = /write|edit|delete|move/i.test(toolName)
    const shell = /shell|terminal|command/i.test(toolName)
    if (shell) {
      const command = String(
        args?.command ?? args?.cmd ?? args?.commandLine ?? toolName,
      )
      if (started)
        event = parseTimelineEvent({
          ...base,
          type: 'command.proposed',
          payload: {
            command,
            cwd: typeof raw.cwd === 'string' ? raw.cwd : '.',
            status: 'in_progress',
          },
        })
      else {
        const outputValue =
          record(result?.success)?.output ??
          record(result?.success)?.content ??
          result?.success ??
          result?.error ??
          ''
        const output = redactText(
          typeof outputValue === 'string'
            ? outputValue
            : JSON.stringify(redact(outputValue)),
        )
        const bytes = Buffer.byteLength(output)
        const preview = Buffer.from(output)
          .subarray(Math.max(0, bytes - DEFAULT_MAX_INLINE_TOOL_BYTES))
          .toString('utf8')
        if (bytes > DEFAULT_MAX_INLINE_TOOL_BYTES)
          spill = {
            data: Buffer.from(output),
            stream: 'combined',
            chunkIndex: 0,
          }
        if (bytes > DEFAULT_MAX_INLINE_TOOL_BYTES) {
          const success = record(result?.success)
          if (success && 'output' in success) success.output = preview
          if (success && 'content' in success) success.content = preview
        }
        event = parseTimelineEvent({
          ...base,
          type: 'command.completed',
          payload: {
            command,
            cwd: typeof raw.cwd === 'string' ? raw.cwd : '.',
            status: result?.error ? 'failed' : 'completed',
            output: {
              previewTail: preview,
              previewByteLength: Buffer.byteLength(preview),
              truncated: bytes > DEFAULT_MAX_INLINE_TOOL_BYTES,
              totalBytes: bytes,
              artifact: null,
              sha256: createHash('sha256').update(output).digest('hex'),
            },
            exitCode: result?.error ? 1 : 0,
            durationMs: null,
          },
        })
      }
    } else if (write) {
      const path = String(
        args?.path ?? record(result?.success)?.path ?? 'unknown',
      )
      event = parseTimelineEvent({
        ...base,
        type: started ? 'file.change.proposed' : 'file.change.completed',
        payload: {
          status: started
            ? 'in_progress'
            : result?.error
              ? 'failed'
              : 'completed',
          changes: [
            {
              path,
              kind: { type: /delete/i.test(toolName) ? 'delete' : 'update' },
              diff: '',
            },
          ],
        },
      })
    } else {
      let completedResult: unknown = result?.success ?? null
      if (!started && completedResult !== null) {
        const serialized =
          typeof completedResult === 'string'
            ? redactText(completedResult)
            : JSON.stringify(redact(completedResult))
        const totalBytes = Buffer.byteLength(serialized)
        if (totalBytes > DEFAULT_MAX_INLINE_TOOL_BYTES) {
          const preview = Buffer.from(serialized)
            .subarray(totalBytes - DEFAULT_MAX_INLINE_TOOL_BYTES)
            .toString('utf8')
          spill = {
            data: Buffer.from(serialized),
            stream: 'combined',
            chunkIndex: 0,
          }
          completedResult = {
            preview,
            totalBytes,
            truncated: true,
            artifact: null,
          }
          if (result) result.success = completedResult
        } else completedResult = redact(completedResult)
      }
      event = parseTimelineEvent({
        ...base,
        type: started ? 'tool.started' : 'tool.completed',
        payload: started
          ? {
              toolKind: 'dynamic',
              tool: toolName,
              provider: 'cursor',
              status: 'in_progress',
              arguments: args ?? null,
            }
          : {
              toolKind: 'dynamic',
              tool: toolName,
              provider: 'cursor',
              status: result?.error ? 'failed' : 'completed',
              result: completedResult,
              error: result?.error ? safeErrorMessage(result.error) : null,
              success: result?.error ? false : true,
              durationMs: null,
            },
      })
    }
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
    event =
      input.provider === 'cursor'
        ? parseTimelineEvent({
            ...base,
            type: 'cursor.unknown',
            visibility: 'internal',
            payload: { eventType: type, envelope: raw },
          })
        : parseTimelineEvent({
            ...base,
            type: 'provider.unknown',
            visibility: 'internal',
            payload: {
              provider: input.provider,
              eventType: type,
              envelope: raw,
            },
          })
  }
  checksum = createHash('sha256').update(canonical(raw)).digest('hex')
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
    ...(spill ? { spill } : {}),
  }
}

export interface CliAdapterOptions {
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
  readonly provider: CliProvider
  readonly pinnedVersion: string
  readonly supportedVersions: readonly string[]
  protected runtimeVersion: string | undefined
  #activeTurn:
    | {
        completionObserved: boolean
        interruptAccepted: boolean
        completionBeforeInterrupt: boolean
      }
    | undefined

  constructor(
    provider: CliProvider,
    options: CliAdapterOptions,
    defaults: {
      binary: string
      versions: readonly string[]
      adapter: string
    },
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
        : provider === 'cursor'
          ? providerModelCatalogSchema.parse({
              ...configuredCatalog,
              models: configuredCatalog.models.map((model) => ({
                ...model,
                capabilities: {
                  ...model.capabilities,
                  streaming: 'supported',
                  reasoningSummary: 'unsupported',
                  commandExecution: 'supported',
                  fileChanges: 'degraded',
                  approvals: 'unsupported',
                  interrupt: 'supported',
                  resume: 'supported',
                  toolCalls: 'supported',
                  imageInput: 'unsupported',
                  usage: 'degraded',
                  cost: 'unsupported',
                },
              })),
            })
          : configuredCatalog
    if (this.catalog.identity.provider !== provider)
      throw new Error(`Catalog provider must be ${provider}`)
    this.context = options.context
    this.runner = options.runner ?? new SpawnCliProcessRunner()
    this.binary = options.binary ?? defaults.binary
    this.supportedVersions = defaults.versions
    this.pinnedVersion = defaults.versions.join(', ')
    this.identity = {
      provider,
      adapter: defaults.adapter,
      adapterVersion: '1',
      upstreamVersion: this.pinnedVersion,
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
      sourceVersion: this.runtimeVersion ?? this.pinnedVersion,
    }).normalized
  }
  async interrupt(_input: ProviderInterrupt) {
    const state = this.#activeTurn
    if (!this.runner.interrupt())
      throw new Error('No active provider turn to interrupt')
    if (state && !state.interruptAccepted) {
      state.interruptAccepted = true
      state.completionBeforeInterrupt = state.completionObserved
    }
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
    const reportedVersions = output.split(/\s+/)
    const matchedVersion = this.supportedVersions.find((version) =>
      reportedVersions.includes(version),
    )
    if (!matchedVersion)
      return {
        ready: false,
        version: output,
        authReady: false,
        authStatus: 'required',
        code: 'version_mismatch',
        instruction: this.installInstruction(),
      }
    this.runtimeVersion = matchedVersion
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
  stdinText(_input: ProviderTurnStartInput): string | undefined {
    return undefined
  }

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
    let terminalFailure: ClassifiedProviderFailure | undefined
    let terminalObserved = false
    let malformedObserved = false
    let assistantText = ''
    const turnState = {
      completionObserved: false,
      interruptAccepted: false,
      completionBeforeInterrupt: false,
    }
    this.#activeTurn = turnState
    try {
      const stdinText = this.stdinText(input)
      const result = await this.runner.run({
        binary: this.binary,
        args: this.args(input),
        cwd: input.cwd,
        ...(stdinText !== undefined ? { stdinText } : {}),
        onLine: async (line) => {
          let envelope: unknown
          try {
            envelope = JSON.parse(line)
          } catch {
            envelope = { type: 'malformed', line }
            malformedObserved = true
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
            sourceVersion: this.runtimeVersion ?? this.pinnedVersion,
          })
          if (normalized.usage?.requestId === 'unknown' && providerSessionId)
            normalized.usage.requestId = providerSessionId
          if (normalized.normalized.event.type === 'agent.message.delta')
            assistantText += normalized.normalized.event.payload.text
          if (normalized.normalized.event.type === 'turn.completed') {
            turnState.completionObserved = true
            terminalObserved = true
            terminal = normalized.normalized.event.payload.status as
              'completed' | 'failed'
          }
          if (
            this.provider === 'cursor' &&
            parsed?.type === 'result' &&
            terminal === 'completed' &&
            typeof parsed.result === 'string'
          ) {
            const completed = normalizeCliEnvelope({
              provider: this.provider,
              envelope: {
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: parsed.result }],
                },
                session_id: parsed.session_id,
                call_id: `assistant-${providerTurnId}`,
              },
              context: this.context,
              sourceVersion: this.runtimeVersion ?? this.pinnedVersion,
            })
            completed.normalized.event = parseTimelineEvent({
              ...completed.normalized.event,
              type: 'agent.message.completed',
              payload: { text: parsed.result || assistantText },
            })
            await onEvent(completed)
          }
          if (terminal === 'failed')
            terminalFailure ??= classifyProviderFailure(this.provider, envelope)
          if (normalized.usage) terminalUsage = normalized.usage
          await onEvent(normalized)
        },
      })
      if (result.timedOut) {
        terminal = 'failed'
        terminalFailure = {
          code: 'timeout',
          message: `${this.provider} turn timed out and was terminated.`,
          retryable: true,
          upstreamCode: 'TURN_TIMEOUT',
        }
      } else if (
        turnState.interruptAccepted &&
        !turnState.completionBeforeInterrupt
      ) {
        terminal = 'interrupted'
        terminalFailure = undefined
      } else if (
        result.signal === 'SIGINT' &&
        !turnState.completionBeforeInterrupt &&
        !terminalFailure
      )
        terminal = 'interrupted'
      else if (result.exitCode !== null && result.exitCode !== 0)
        terminal = 'failed'
      else if (malformedObserved || !terminalObserved) {
        terminal = 'failed'
        terminalFailure = classifyProviderFailure(
          this.provider,
          malformedObserved
            ? 'Malformed JSON in provider stream'
            : 'Provider stream ended without a terminal event (early EOF)',
        )
      } else terminal ??= 'completed'
    } catch (error) {
      if (turnState.interruptAccepted && !turnState.completionBeforeInterrupt) {
        if (this.#activeTurn === turnState) this.#activeTurn = undefined
        return {
          providerSessionId: providerSessionId ?? `session_${randomUUID()}`,
          providerTurnId,
          outcome: 'interrupted',
          ...(terminalUsage ? { usage: terminalUsage } : {}),
        }
      }
      const failure = classifyProviderFailure(this.provider, error)
      if (this.#activeTurn === turnState) this.#activeTurn = undefined
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
    if (this.#activeTurn === turnState) this.#activeTurn = undefined
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
      versions: [CLAUDE_CODE_VERSION],
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
      versions: GEMINI_CLI_SUPPORTED_VERSIONS,
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
      ...(this.runtimeVersion === '0.50.0' ? ['--skip-trust'] : []),
      ...(input.sessionId ? ['--resume', input.sessionId] : []),
    ]
  }
}

export class CursorAgentRuntimeAdapter extends CliProviderAdapter {
  constructor(options: CliAdapterOptions) {
    super('cursor', options, {
      binary: options.binary ?? process.env.CURSOR_AGENT_BIN ?? 'cursor-agent',
      versions: CURSOR_AGENT_SUPPORTED_VERSIONS,
      adapter: 'cursor-agent-stream-json',
    })
  }

  installInstruction() {
    return 'Install Cursor Agent from the official Cursor CLI documentation, then run `cursor-agent login`; automatic install/update is disabled.'
  }

  override async checkReadiness(): Promise<ProviderReadiness> {
    const version = await this.runner.probe({
      binary: this.binary,
      args: ['--version'],
    })
    if (version.errorCode === 'EACCES')
      return {
        ready: false,
        version: null,
        authReady: false,
        authStatus: 'required',
        code: 'binary_not_executable',
        instruction:
          'Make cursor-agent executable and ensure it is on the server PATH.',
      }
    if (version.errorCode === 'ENOENT' || version.exitCode === null)
      return {
        ready: false,
        version: null,
        authReady: false,
        authStatus: 'required',
        code: 'binary_missing',
        instruction: this.installInstruction(),
      }
    const output = version.stdout.trim()
    const parsed = /^(\d{4}\.\d{2}\.\d{2})-([A-Za-z0-9]+)$/.exec(output)
    if (!parsed)
      return {
        ready: false,
        version: output || null,
        authReady: false,
        authStatus: 'required',
        code: 'version_unparseable',
        instruction: `Expected an exact tested Cursor Agent release (${CURSOR_AGENT_VERSION_POLICY}); verify the official binary and disable version drift.`,
      }
    if (
      !CURSOR_AGENT_SUPPORTED_VERSIONS.includes(
        output as (typeof CURSOR_AGENT_SUPPORTED_VERSIONS)[number],
      )
    )
      return {
        ready: false,
        version: output,
        authReady: false,
        authStatus: 'required',
        code: 'version_mismatch',
        instruction: `Cursor Agent ${output} is outside the exact tested releases (${CURSOR_AGENT_VERSION_POLICY}); validate fixture and real smoke before adding it.`,
      }
    this.runtimeVersion = output
    const auth = await this.runner.probe({
      binary: this.binary,
      args: ['status', '--format', 'json'],
    })
    let loggedIn = false
    try {
      const status = record(JSON.parse(auth.stdout))
      loggedIn =
        auth.exitCode === 0 &&
        (status?.isAuthenticated === true || status?.status === 'authenticated')
    } catch {
      const status = `${auth.stdout}\n${auth.stderr}`
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .toLowerCase()
      loggedIn =
        auth.exitCode === 0 &&
        !/not logged in|not authenticated|login required/.test(status) &&
        /logged in|authenticated/.test(status)
    }
    return {
      ready: loggedIn,
      version: output,
      authReady: loggedIn,
      authStatus: loggedIn ? 'ready' : 'required',
      code: loggedIn ? 'ready' : 'auth_required',
      instruction: loggedIn
        ? null
        : 'Run `cursor-agent login` on the server or set CURSOR_API_KEY only in the server environment.',
    }
  }

  args(input: ProviderTurnStartInput) {
    const policy = loadCursorProjectPolicy(input.cwd)
    const force = input.allowFileChanges === true && policy.allowsWrites
    const configuredModel = this.catalog.models.find(
      (model) => model.modelId === input.modelId,
    )
    const hasEffortVariants =
      configuredModel !== undefined &&
      (configuredModel.reasoningEfforts.length > 1 ||
        !configuredModel.reasoningEfforts.includes('none'))
    const model = hasEffortVariants
      ? `${input.modelId}-${input.reasoningEffort}`
      : input.modelId
    return [
      '--print',
      '--trust',
      '--output-format',
      'stream-json',
      ...(model ? ['--model', model] : []),
      ...(input.sessionId ? ['--resume', input.sessionId] : []),
      ...(force ? ['--force'] : []),
    ]
  }

  override stdinText(input: ProviderTurnStartInput) {
    return input.prompt
  }

  override async startTurn(
    input: ProviderTurnStartInput,
    onEvent: (event: ProviderTurnStreamEvent) => void | Promise<void>,
  ): Promise<ProviderTurnTerminal> {
    const readiness = await this.checkReadiness()
    if (!readiness.ready)
      return {
        providerSessionId: input.sessionId ?? `session_${randomUUID()}`,
        providerTurnId: `turn_${randomUUID()}`,
        outcome: 'failed',
        error: {
          schemaVersion: 1,
          provider: 'cursor',
          code:
            readiness.code === 'auth_required'
              ? 'unauthorized'
              : 'protocol_mismatch',
          message:
            readiness.instruction ?? 'Cursor Agent is not ready to start.',
          retryable: false,
          upstreamCode: readiness.code,
        },
      }
    return super.startTurn(input, onEvent)
  }
}
