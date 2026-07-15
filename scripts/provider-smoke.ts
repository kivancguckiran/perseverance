import { randomUUID } from 'node:crypto'
import {
  ClaudeCodeRuntimeAdapter,
  GeminiCliRuntimeAdapter,
} from '../packages/provider-cli-adapters/src/index'
import type { ProviderModelCatalog } from '../packages/provider-platform/src/index'

const provider = process.argv[2]
if (provider !== 'claude' && provider !== 'gemini')
  throw new Error('Usage: provider-smoke.ts claude|gemini')
const modelId =
  process.env[
    provider === 'claude' ? 'CLAUDE_SMOKE_MODEL' : 'GEMINI_SMOKE_MODEL'
  ]
if (!modelId)
  throw new Error(`${provider.toUpperCase()}_SMOKE_MODEL is required`)
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
      },
    },
  ],
}
const Adapter =
  provider === 'claude' ? ClaudeCodeRuntimeAdapter : GeminiCliRuntimeAdapter
const adapter = new Adapter({
  catalog,
  context: {
    tenantId: 'smoke',
    workspaceId: 'smoke',
    sessionId: randomUUID(),
    nextSequence: () => ++sequence,
  },
})
const observed = new Set<string>()
let rawSeen = false
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
      cwd: '/private/tmp',
      modelId,
      reasoningEffort: 'none',
    },
    (event) => {
      rawSeen ||= Object.keys(event.rawEnvelope).length > 0
      observed.add(event.normalized.event.type)
      if (event.normalized.event.type === 'agent.message.delta') onStream?.()
    },
  )

async function smoke() {
  const readiness = await stage('readiness', adapter.checkReadiness(), 15_000)
  if (provider === 'claude' && readiness.code === 'auth_required')
    throw new Error(
      'AUTH_REQUIRED: run `claude auth login`; interactive login is not automated',
    )
  if (!readiness.ready)
    throw new Error(
      `${readiness.code}: ${readiness.instruction ?? 'provider not ready'}`,
    )
  const first = await stage(
    'start-stream',
    run(null, 'Reply with exactly SMOKE_ONE. Do not use tools.'),
  )
  if (first.error?.code === 'unauthorized')
    throw new Error(
      'AUTH_REQUIRED: run `claude auth login`; interactive login is not automated',
    )
  if (first.outcome !== 'completed' || !first.usage || !rawSeen)
    throw new Error(`start/stream failed: ${JSON.stringify(first)}`)
  const resumed = await stage(
    'resume',
    run(
      first.providerSessionId,
      'Reply with exactly SMOKE_TWO. Do not use tools.',
    ),
  )
  if (resumed.outcome !== 'completed' || !resumed.usage)
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
    unknown.event.type !== 'provider.unknown' ||
    JSON.stringify(unknown).includes('do-not-store')
  )
    throw new Error('unknown/raw safety failed')
  return {
    provider,
    modelId,
    start: first.outcome,
    resume: resumed.outcome,
    interrupt: interrupted.outcome,
    usage: true,
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
  progress('process', 'cleanup')
}
