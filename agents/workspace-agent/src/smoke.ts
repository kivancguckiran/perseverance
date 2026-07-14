import { codexV2 } from '@persistent-codex/codex-protocol-generated'
import { CodexAppServerClient } from './index'

type ThreadStartResponse = codexV2.ThreadStartResponse
type TurnStartResponse = codexV2.TurnStartResponse

const timeoutMs = Number.parseInt(
  process.env.CODEX_FLOW_SMOKE_TIMEOUT_MS ?? '120000',
  10,
)
const client = new CodexAppServerClient({
  cwd: process.cwd(),
  onStderr: (chunk) => process.stderr.write(chunk),
  requestTimeoutMs: timeoutMs,
})

let resolveFinal: ((value: string) => void) | undefined
let rejectFinal: ((error: Error) => void) | undefined
let expectedThreadId: string | undefined
const finalMessage = new Promise<string>((resolve, reject) => {
  resolveFinal = resolve
  rejectFinal = reject
})

client.onNotification((message) => {
  const params = message.params as Record<string, unknown> | undefined
  if (!params || !expectedThreadId || params.threadId !== expectedThreadId)
    return
  if (message.method === 'item/completed') {
    const item = params.item as Record<string, unknown> | undefined
    if (item?.type === 'agentMessage' && typeof item.text === 'string') {
      resolveFinal?.(item.text)
    }
  }
  if (message.method === 'error') {
    const error = params.error as Record<string, unknown> | undefined
    rejectFinal?.(new Error(String(error?.message ?? 'Codex flow failed')))
  }
})

try {
  await client.initialize({
    name: 'persistent_codex_flow_smoke',
    title: 'Persistent Codex Flow Smoke',
    version: '0.0.0',
  })
  const thread = await client.request<ThreadStartResponse>('thread/start', {
    cwd: process.cwd(),
  } satisfies codexV2.ThreadStartParams)
  expectedThreadId = thread.thread.id
  const turn = await client.request<TurnStartResponse>('turn/start', {
    threadId: expectedThreadId,
    input: [
      {
        type: 'text',
        text: 'Yalnızca TAMAM yaz. Araç kullanma ve dosya değiştirme.',
        text_elements: [],
      },
    ],
  } satisfies codexV2.TurnStartParams)
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Final agent message timeout (${timeoutMs} ms)`)),
      timeoutMs,
    )
  })
  const text = await Promise.race([finalMessage, timeout]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  })
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        codexThreadId: expectedThreadId,
        codexTurnId: turn.turn.id,
        finalAgentMessage: text,
      },
      null,
      2,
    )}\n`,
  )
} finally {
  await client.stop()
}
