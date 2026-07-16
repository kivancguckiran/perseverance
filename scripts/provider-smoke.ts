import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaudeCodeRuntimeAdapter,
  CursorAgentRuntimeAdapter,
  GeminiCliRuntimeAdapter,
} from '../packages/provider-cli-adapters/src/index'
import type { ProviderModelCatalog } from '../packages/provider-platform/src/index'

const provider = process.argv[2]
if (provider !== 'claude' && provider !== 'gemini' && provider !== 'cursor')
  throw new Error('Usage: provider-smoke.ts claude|gemini|cursor')
const configuredModelId =
  process.env[
    provider === 'claude'
      ? 'CLAUDE_SMOKE_MODEL'
      : provider === 'gemini'
        ? 'GEMINI_SMOKE_MODEL'
        : 'CURSOR_SMOKE_MODEL'
  ]
const modelId = configuredModelId ?? '__SMOKE_MODEL_REQUIRED__'
let sequence = 0
const catalog: ProviderModelCatalog = {
  schemaVersion: 1,
  identity: {
    provider,
    adapter: 'real-smoke',
    adapterVersion: '1',
    upstreamVersion: 'real',
  },
  discoveredAt: new Date().toISOString(),
  models: [
    {
      provider,
      modelId,
      displayName: modelId,
      hidden: false,
      isDefault: true,
      reasoningEfforts:
        provider === 'claude'
          ? ['none', 'low', 'medium', 'high', 'xhigh']
          : ['none'],
      defaultReasoningEffort: 'none',
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
        usage: provider === 'cursor' ? 'degraded' : 'supported',
        cost: 'unsupported',
      },
    },
  ],
}
const Adapter =
  provider === 'claude'
    ? ClaudeCodeRuntimeAdapter
    : provider === 'gemini'
      ? GeminiCliRuntimeAdapter
      : CursorAgentRuntimeAdapter
const smokeRoot =
  provider === 'cursor'
    ? mkdtempSync(join(tmpdir(), 'cursor-provider-smoke-'))
    : '/private/tmp'
if (provider === 'cursor') {
  mkdirSync(join(smokeRoot, '.cursor'))
  writeFileSync(join(smokeRoot, 'README.md'), '# Cursor provider smoke\n')
  writeFileSync(
    join(smokeRoot, '.cursor/cli.json'),
    JSON.stringify({
      permissions: {
        allow: ['Read(README.md)'],
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
}
const adapter = new Adapter({
  catalog,
  context: {
    tenantId: 'smoke',
    workspaceId: 'smoke',
    sessionId: randomUUID(),
    nextSequence: () => ++sequence,
  },
  ...(provider === 'cursor'
    ? {
        binary:
          process.env.CURSOR_AGENT_BIN ??
          (existsSync(join(homedir(), '.local/bin/cursor-agent'))
            ? join(homedir(), '.local/bin/cursor-agent')
            : 'cursor-agent'),
      }
    : {}),
})
const observed = new Set<string>()
let rawSeen = false
let unsafeRawSeen = false
let unsuppressedReasoningSeen = false
const progress = (stage: string, status: 'started' | 'passed' | 'cleanup') =>
  console.error(JSON.stringify({ smoke: provider, stage, status }))
const stage = async <T>(
  name: string,
  operation: Promise<T>,
  timeoutMs = 135_000,
) => {
  progress(name, 'started')
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`SMOKE_TIMEOUT:${name}`)),
          timeoutMs,
        )
      }),
    ])
    progress(name, 'passed')
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const run = async (
  sessionId: string | null,
  prompt: string,
  onStream?: () => void,
) =>
  adapter.startTurn!(
    {
      sessionId,
      prompt,
      cwd: smokeRoot,
      modelId,
      reasoningEffort: 'none',
    },
    (event) => {
      rawSeen ||= Object.keys(event.rawEnvelope).length > 0
      const serializedRaw = JSON.stringify(event.rawEnvelope)
      unsafeRawSeen ||= serializedRaw.includes(prompt)
      unsuppressedReasoningSeen ||=
        event.normalized.event.type === 'cursor.unknown' &&
        event.rawEnvelope.type === 'thinking' &&
        serializedRaw.includes('"text":') &&
        !serializedRaw.includes('[SUPPRESSED_REASONING]')
      observed.add(event.normalized.event.type)
      if (
        event.normalized.event.type === 'turn.started' ||
        event.normalized.event.type === 'agent.message.delta'
      )
        onStream?.()
    },
  )

async function smoke() {
  const readiness = await stage('readiness', adapter.checkReadiness(), 15_000)
  if (
    (provider === 'claude' || provider === 'cursor') &&
    readiness.code === 'auth_required'
  )
    throw new Error(
      `AUTH_REQUIRED: run \`${provider === 'cursor' ? 'cursor-agent login' : 'claude auth login'}\`; interactive login is not automated`,
    )
  if (!readiness.ready)
    throw new Error(
      `${readiness.code}: ${readiness.instruction ?? 'provider not ready'}`,
    )
  if (!configuredModelId)
    throw new Error(`${provider.toUpperCase()}_SMOKE_MODEL is required`)
  const first = await stage(
    'start-stream',
    run(
      null,
      provider === 'cursor'
        ? 'Read README.md, then reply with exactly SMOKE_ONE.'
        : 'Reply with exactly SMOKE_ONE. Do not use tools.',
    ),
  )
  if (first.error?.code === 'unauthorized')
    throw new Error(
      `AUTH_REQUIRED: run \`${provider === 'cursor' ? 'cursor-agent login' : 'claude auth login'}\`; interactive login is not automated`,
    )
  if (
    first.outcome !== 'completed' ||
    (provider !== 'cursor' && !first.usage) ||
    !rawSeen ||
    unsafeRawSeen ||
    unsuppressedReasoningSeen ||
    (provider === 'cursor' &&
      (!observed.has('tool.started') || !observed.has('tool.completed')))
  )
    throw new Error(`start/stream failed: ${JSON.stringify(first)}`)
  if (
    first.usage &&
    (first.usage.completeness !== 'complete' ||
      first.usage.requestId === 'unknown' ||
      first.usage.counters.inputTokens < 0 ||
      first.usage.counters.cachedInputTokens < 0 ||
      first.usage.counters.outputTokens < 0)
  )
    throw new Error(`usage ledger failed: ${JSON.stringify(first.usage)}`)
  const resumed = await stage(
    'resume',
    run(
      first.providerSessionId,
      'Reply with exactly SMOKE_TWO. Do not use tools.',
    ),
  )
  if (
    resumed.outcome !== 'completed' ||
    resumed.providerSessionId !== first.providerSessionId ||
    (provider !== 'cursor' && !resumed.usage)
  )
    throw new Error(`resume failed: ${JSON.stringify(resumed)}`)

  const streamStarted = Promise.withResolvers<void>()
  const interruptTurn = run(
    resumed.providerSessionId,
    'Without using tools, write the integers from 1 through 10000, one integer per line. Do not stop early.',
    () => streamStarted.resolve(),
  )
  await stage('interrupt-stream-started', streamStarted.promise, 60_000)
  await stage(
    'interrupt-request',
    adapter.interrupt({
      schemaVersion: 1,
      sessionId: resumed.providerSessionId,
      turnId: resumed.providerTurnId,
      reason: 'smoke',
    }),
    5_000,
  )
  const interrupted = await stage('interrupt-terminal', interruptTurn, 15_000)
  if (interrupted.outcome !== 'interrupted')
    throw new Error(`interrupt failed: ${JSON.stringify(interrupted)}`)
  const unknown = adapter.normalizeEvent({
    type: 'future_smoke_event',
    secret: 'do-not-store',
  })
  if (
    (provider === 'cursor'
      ? unknown.event.type !== 'cursor.unknown'
      : unknown.event.type !== 'provider.unknown') ||
    JSON.stringify(unknown).includes('do-not-store')
  )
    throw new Error('unknown/raw safety failed')
  if (unsafeRawSeen || unsuppressedReasoningSeen)
    throw new Error('provider raw stream safety failed')
  return {
    provider,
    modelId,
    start: first.outcome,
    resume: resumed.outcome,
    interrupt: interrupted.outcome,
    usage: Boolean(first.usage),
    usageCompleteness: first.usage?.completeness ?? 'unreported',
    usageCounters: first.usage?.counters ?? null,
    durableSession: resumed.providerSessionId === first.providerSessionId,
    raw: rawSeen,
    unknown: true,
    cleanup: true,
    events: [...observed],
  }
}

let totalTimer: NodeJS.Timeout | undefined
try {
  const result = await Promise.race([
    smoke(),
    new Promise<never>((_, reject) => {
      totalTimer = setTimeout(
        () => reject(new Error('SMOKE_TIMEOUT:total')),
        240_000,
      )
    }),
  ])
  console.log(JSON.stringify(result))
} finally {
  if (totalTimer) clearTimeout(totalTimer)
  await adapter
    .interrupt({
      schemaVersion: 1,
      sessionId: 'cleanup',
      turnId: 'cleanup',
      reason: 'system',
    })
    .catch(() => undefined)
  if (provider === 'cursor') rmSync(smokeRoot, { recursive: true, force: true })
  progress('process', 'cleanup')
}
