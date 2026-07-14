import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  replayResponseSchema,
  sessionResponseSchema,
  turnAcceptedResponseSchema,
} from '@persistent-codex/control-plane-contracts'
import type { TimelineEvent } from '@persistent-codex/domain-events'
import { buildControlPlane } from './server'

const timeoutMs = Number(process.env.CODEX_RECOVERY_SMOKE_TIMEOUT_MS ?? 180_000)
const tenantId = 'ten_recovery_smoke'
const workspaceId = 'wsp_recovery_smoke'
const headers = { 'x-tenant-id': tenantId, 'x-workspace-id': workspaceId }
const runtimeRoot = mkdtempSync(join(tmpdir(), 'persistent-recovery-smoke-'))
const workspaceCwd = join(runtimeRoot, 'workspace')
const databasePath = join(runtimeRoot, 'events.sqlite')
const codexHomeRoot = join(runtimeRoot, 'codex-homes')
const artifactRoot = join(runtimeRoot, 'artifacts')
const provisioningSource =
  process.env.CODEX_PROVISIONING_SOURCE ??
  process.env.CODEX_HOME ??
  join(homedir(), '.codex')
mkdirSync(workspaceCwd)

async function pollEvents(
  app: Awaited<ReturnType<typeof buildControlPlane>>,
  sessionId: string,
  predicate: (event: TimelineEvent) => boolean,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/events?after=0&limit=500`,
      headers,
    })
    const replay = replayResponseSchema.parse(response.json())
    if (replay.events.some(predicate)) return replay
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `Timed out waiting for recovery smoke timeline (${timeoutMs} ms)`,
  )
}

const build = () =>
  buildControlPlane({
    databasePath,
    artifactRoot,
    workspaceCwd,
    codexHomeRoot,
    codexProvisioningSource: provisioningSource,
    approvalPolicy: 'never',
  })

let firstApp: Awaited<ReturnType<typeof buildControlPlane>> | undefined
let secondApp: Awaited<ReturnType<typeof buildControlPlane>> | undefined
let evidence: Record<string, unknown> | undefined
try {
  firstApp = await build()
  await firstApp.ready()
  const createdReply = await firstApp.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers,
    payload: {},
  })
  if (createdReply.statusCode !== 201)
    throw new Error(`First session failed: ${createdReply.body}`)
  const session = sessionResponseSchema.parse(createdReply.json())
  const firstTurnReply = await firstApp.inject({
    method: 'POST',
    url: `/v1/sessions/${session.sessionId}/turns`,
    headers: { ...headers, 'idempotency-key': 'recovery-smoke-first' },
    payload: { prompt: 'Reply with exactly FIRST_RECOVERY_SMOKE_FINAL' },
  })
  if (firstTurnReply.statusCode !== 202)
    throw new Error(`First turn failed: ${firstTurnReply.body}`)
  turnAcceptedResponseSchema.parse(firstTurnReply.json())
  const firstReplay = await pollEvents(
    firstApp,
    session.sessionId,
    (event) =>
      event.type === 'agent.message.completed' &&
      event.payload.text.includes('FIRST_RECOVERY_SMOKE_FINAL'),
  )
  const firstHighWater = firstReplay.highWaterSequence
  await firstApp.close()
  firstApp = undefined

  secondApp = await build()
  await secondApp.ready()
  const resumeReply = await secondApp.inject({
    method: 'POST',
    url: `/v1/sessions/${session.sessionId}/resume`,
    headers: { ...headers, 'idempotency-key': 'recovery-smoke-resume' },
    payload: {},
  })
  if (resumeReply.statusCode !== 200)
    throw new Error(`Resume failed: ${resumeReply.body}`)
  const resumed = sessionResponseSchema.parse(resumeReply.json())
  if (resumed.codexThreadId !== session.codexThreadId)
    throw new Error('Resume changed Codex thread id')
  const afterResumeHighWater = resumed.replay.highWaterSequence
  const afterResumeReplay = replayResponseSchema.parse(
    (
      await secondApp.inject({
        method: 'GET',
        url: `/v1/sessions/${session.sessionId}/events?after=0&limit=500`,
        headers,
      })
    ).json(),
  )
  const firstFinal = afterResumeReplay.events.find(
    (event) =>
      event.type === 'agent.message.completed' &&
      event.payload.text.includes('FIRST_RECOVERY_SMOKE_FINAL'),
  )
  if (!firstFinal?.codexTurnId || !firstFinal.codexItemId)
    throw new Error('First authoritative final identity missing after resume')
  const snapshotIdentityCount = (events: TimelineEvent[]) =>
    events.filter(
      (event) =>
        (event.type === 'agent.message.completed' &&
          event.codexTurnId === firstFinal.codexTurnId &&
          event.codexItemId === firstFinal.codexItemId) ||
        (event.type === 'turn.completed' &&
          event.codexTurnId === firstFinal.codexTurnId),
    ).length
  const snapshotCountBeforeRepeat = snapshotIdentityCount(
    afterResumeReplay.events,
  )
  const repeatedResume = await secondApp.inject({
    method: 'POST',
    url: `/v1/sessions/${session.sessionId}/resume`,
    headers: { ...headers, 'idempotency-key': 'recovery-smoke-resume-repeat' },
    payload: {},
  })
  if (repeatedResume.statusCode !== 200)
    throw new Error(`Repeated resume failed: ${repeatedResume.body}`)
  const repeated = sessionResponseSchema.parse(repeatedResume.json())
  const repeatedReplay = replayResponseSchema.parse(
    (
      await secondApp.inject({
        method: 'GET',
        url: `/v1/sessions/${session.sessionId}/events?after=0&limit=500`,
        headers,
      })
    ).json(),
  )
  const snapshotCountAfterRepeat = snapshotIdentityCount(repeatedReplay.events)
  if (snapshotCountAfterRepeat !== snapshotCountBeforeRepeat)
    throw new Error('Repeated snapshot reconciliation produced duplicates')

  const secondTurnReply = await secondApp.inject({
    method: 'POST',
    url: `/v1/sessions/${session.sessionId}/turns`,
    headers: { ...headers, 'idempotency-key': 'recovery-smoke-second' },
    payload: { prompt: 'Reply with exactly SECOND_RECOVERY_SMOKE_FINAL' },
  })
  if (secondTurnReply.statusCode !== 202)
    throw new Error(`Second turn failed: ${secondTurnReply.body}`)
  turnAcceptedResponseSchema.parse(secondTurnReply.json())
  const finalReplay = await pollEvents(
    secondApp,
    session.sessionId,
    (event) =>
      event.type === 'agent.message.completed' &&
      event.payload.text.includes('SECOND_RECOVERY_SMOKE_FINAL'),
  )
  const sequences = finalReplay.events.map((event) => event.sequence)
  const eventIds = finalReplay.events.map((event) => event.eventId)
  if (new Set(sequences).size !== sequences.length)
    throw new Error('Duplicate sequence detected')
  if (new Set(eventIds).size !== eventIds.length)
    throw new Error('Duplicate event id detected')
  if (finalReplay.highWaterSequence <= firstHighWater)
    throw new Error('Sequence did not advance after restart')
  const readiness = await secondApp.inject({
    method: 'GET',
    url: '/readyz',
    headers,
  })
  if (readiness.statusCode !== 200)
    throw new Error(`Recovered runtime is not ready: ${readiness.body}`)
  const auditReply = await secondApp.inject({
    method: 'GET',
    url: `/v1/sessions/${session.sessionId}/audit?limit=100`,
    headers,
  })
  const auditRecords = auditReply.json().records as Array<{
    action: string
    outcome: string
  }>
  const auditActions = auditRecords.map((record) => record.action)
  for (const required of [
    'recovery.started',
    'recovery.completed',
    'runtime.restarted',
  ])
    if (!auditActions.includes(required))
      throw new Error(`Missing restart audit action: ${required}`)
  if (
    auditActions.filter((action) => action === 'runtime.restarted').length !== 2
  )
    throw new Error('Restart audit actions were duplicated or missing')
  const metrics = (
    await secondApp.inject({ method: 'GET', url: '/metrics' })
  ).json() as {
    series: Array<{
      name: string
      labels: Record<string, string>
      value: number
    }>
  }
  const restartMetric = metrics.series.find(
    (series) =>
      series.name === 'app_server_restarts_total' &&
      series.labels.outcome === 'ready',
  )
  if (!restartMetric || restartMetric.value !== 2)
    throw new Error(
      'Restart metric did not record both bounded recovery resumes',
    )
  if (
    metrics.series.some((series) =>
      Object.keys(series.labels).some((label) =>
        /tenant|workspace|session|turn|request|path|prompt/i.test(label),
      ),
    )
  )
    throw new Error('Restart metrics contain unbounded labels')
  evidence = {
    ok: true,
    sessionId: session.sessionId,
    codexThreadId: session.codexThreadId,
    resumedThreadId: resumed.codexThreadId,
    firstHighWater,
    afterResumeHighWater,
    repeatedResumeHighWater: repeated.replay.highWaterSequence,
    finalHighWater: finalReplay.highWaterSequence,
    snapshotCountBeforeRepeat,
    snapshotCountAfterRepeat,
    snapshotDedupeStable:
      snapshotCountAfterRepeat === snapshotCountBeforeRepeat,
    uniqueSequences: true,
    uniqueEventIds: true,
    firstFinalObserved: true,
    secondFinalObserved: true,
    readinessReady: true,
    recoveryAuditVerified: true,
    restartAuditCount: 2,
    boundedRestartMetric: true,
    databasePath,
    codexHomeRoot,
    artifactRoot,
  }
} finally {
  await firstApp?.close().catch(() => undefined)
  await secondApp?.close().catch(() => undefined)
  rmSync(runtimeRoot, { recursive: true, force: true })
}

if (evidence)
  process.stdout.write(
    `${JSON.stringify(
      {
        ...evidence,
        databaseCleaned: !existsSync(String(evidence.databasePath)),
        codexHomeRootCleaned: !existsSync(String(evidence.codexHomeRoot)),
        artifactRootCleaned: !existsSync(String(evidence.artifactRoot)),
        runtimeRootCleaned: !existsSync(runtimeRoot),
      },
      null,
      2,
    )}\n`,
  )
