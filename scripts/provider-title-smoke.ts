import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SqliteEventStore } from '../packages/event-store/src/index'
import { DEFAULT_TITLE_POLICY } from '../packages/provider-platform/src/index'
import { CodexTitleProcessRunner } from '../services/control-plane/src/title-process-runner'

const modelId = process.env.CODEX_TITLE_SMOKE_MODEL
if (!modelId) throw new Error('CODEX_TITLE_SMOKE_MODEL is required')
if (
  DEFAULT_TITLE_POLICY.alias !== 'luna' ||
  DEFAULT_TITLE_POLICY.reasoningEffort !== 'none'
)
  throw new Error('title policy must be luna + none')
const scope = {
  tenantId: 'smoke',
  workspaceId: 'smoke',
  sessionId: `ses_${randomUUID()}`,
}
const store = new SqliteEventStore()
const progress = (stage: string, status: 'started' | 'passed' | 'cleanup') =>
  console.error(JSON.stringify({ smoke: 'title', stage, status }))

async function smoke() {
  progress('threshold', 'started')
  store.createSession(scope)
  store.recordDurableUserMessage({
    ...scope,
    messageId: 'one',
    idempotencyKey: 'one',
    content: 'Kalıcı ajan mimarisini konuşalım.',
  })
  if (store.enqueueConversationTitleJob(scope) !== null)
    throw new Error('title job appeared after first message')
  store.recordDurableUserMessage({
    ...scope,
    messageId: 'two',
    idempotencyKey: 'two',
    content: 'Provider readiness sınırlarını tamamlayalım.',
  })
  const job = store.enqueueConversationTitleJob(scope)
  if (!job || !store.claimConversationTitleJob(scope))
    throw new Error('single title job was not claimed')
  if (store.enqueueConversationTitleJob(scope)?.jobId !== job.jobId)
    throw new Error('a duplicate title job was created')
  progress('threshold', 'passed')
  progress('generation', 'started')
  const prompt =
    'Produce only a short, safe, single-line Turkish conversation title (maximum 8 words).\nDo not use tools.\nMessage 1: Kalıcı ajan mimarisini konuşalım.\nMessage 2: Provider readiness sınırlarını tamamlayalım.'
  const generated = await new CodexTitleProcessRunner().run({
    binary: process.env.CODEX_BINARY ?? 'codex',
    args: [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--model',
      modelId,
      '--config',
      'model_reasoning_effort="none"',
      prompt,
    ],
    codexHome: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    requestId: `title:${scope.sessionId}`,
  })
  progress('generation', 'passed')
  if (!generated.usage) throw new Error('title usage missing')
  const usage = store.appendUsage({
    ...scope,
    turnId: `title:${job.jobId}`,
    modelId,
    report: generated.usage,
    purpose: 'conversation_title',
  })
  if (!store.completeConversationTitleJob(scope, generated.title))
    throw new Error('title completion failed')
  if (store.replaySessionEvents(scope, 0, 100).events.length !== 0)
    throw new Error('title added an artificial timeline message')
  if (usage.purpose !== 'conversation_title')
    throw new Error('title usage purpose mismatch')
  return {
    title: generated.title,
    modelId,
    policy: DEFAULT_TITLE_POLICY,
    firstMessageJob: false,
    singleJob: true,
    artificialTimelineMessage: false,
    usagePurpose: 'conversation_title',
    cleanup: true,
  }
}

let timeout: NodeJS.Timeout | undefined
try {
  const result = await Promise.race([
    smoke(),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error('SMOKE_TIMEOUT:title')),
        90_000,
      )
    }),
  ])
  console.log(JSON.stringify(result))
} finally {
  if (timeout) clearTimeout(timeout)
  store.close()
  progress('store', 'cleanup')
}
