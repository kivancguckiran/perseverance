import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { TimelineEvent } from '../packages/domain-events/src/index'
import { SqliteEventStore } from '../packages/event-store/src/index'
import type { ProviderModelCatalog } from '../packages/provider-platform/src/index'
import { buildControlPlane } from '../services/control-plane/src/server'
import {
  offlineConversationKey,
  tenantCacheNamespace,
} from '../apps/web/src/tenant-cache'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const webRoot = join(repositoryRoot, 'apps/web')
const clientRoot = join(webRoot, 'dist/client')
const apiPort = 3216
const webPort = 41_000 + (process.pid % 1_000)
const baseUrl = `http://127.0.0.1:${webPort}`
const sessionName = `phase2-accept-${process.pid}`
const namespace = `persistent-phase2-${process.pid}`
const temporaryRoot = mkdtempSync(join(tmpdir(), 'persistent-phase2-accept-'))
const scope = {
  tenantId: 'ten_local',
  workspaceId: 'wsp_local',
  sessionId: 'ses_phase2_accept',
}
const principalId = 'dev-user'
const cacheNamespace = tenantCacheNamespace(
  principalId,
  scope.tenantId,
  scope.workspaceId,
)
const conversationSnapshotKey = offlineConversationKey(
  cacheNamespace,
  scope.sessionId,
)
const initialUrl = `${baseUrl}/sessions/${scope.sessionId}?organization=${scope.tenantId}&workspace=${scope.workspaceId}`
const execFileAsync = promisify(execFile)

assert(existsSync(join(clientRoot, 'sw.js')), 'Production PWA build is missing')

const capabilities = {
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
} as const

const catalog: ProviderModelCatalog = {
  schemaVersion: 1,
  identity: {
    provider: 'claude',
    adapter: 'phase2-browser-fixture',
    adapterVersion: '1',
    upstreamVersion: 'fixture',
  },
  discoveredAt: '2026-07-15T00:00:00.000Z',
  models: [
    {
      provider: 'claude',
      modelId: 'fixture-claude-model',
      displayName: 'Fixture Claude',
      hidden: false,
      isDefault: true,
      reasoningEfforts: ['none'],
      defaultReasoningEffort: 'none',
      inputModalities: ['text'],
      capabilities,
    },
  ],
}

const store = new SqliteEventStore(join(temporaryRoot, 'events.sqlite'))
store.createSession({
  ...scope,
  title: 'Phase 2 offline acceptance',
  provider: 'claude',
  requestedPolicy: { modelId: 'fixture-claude-model', reasoningEffort: 'none' },
  resolvedModel: 'fixture-claude-model',
  reasoningEffort: 'none',
  capabilitySnapshot: capabilities,
})
store.bindCodexThread(scope, 'provider-session-phase2')
store.createTurn({
  ...scope,
  turnId: 'turn_phase2_1',
  providerTurnId: 'provider-turn-phase2-1',
  provider: 'claude',
  requestedPolicy: { modelId: 'fixture-claude-model', reasoningEffort: 'none' },
  resolvedModel: 'fixture-claude-model',
  reasoningEffort: 'none',
  capabilitySnapshot: capabilities,
  status: 'completed',
})

function timelineEvent(
  eventId: string,
  type: TimelineEvent['type'],
  payload: TimelineEvent['payload'],
  sequence = 0,
): TimelineEvent {
  return {
    eventId,
    schemaVersion: 1,
    ...scope,
    codexThreadId: 'provider-session-phase2',
    codexTurnId: 'turn_phase2_1',
    sequence,
    occurredAt: '2026-07-15T00:00:00.000Z',
    receivedAt: '2026-07-15T00:00:00.001Z',
    source: 'claude-code',
    sourceVersion: 'fixture',
    sourceMethod: type,
    visibility: 'user',
    type,
    payload,
  } as TimelineEvent
}

function ingest(event: TimelineEvent) {
  store.ingest({
    ...scope,
    ingestKey: `phase2:${event.eventId}`,
    raw: {
      envelope: { type: event.type },
      checksum: 'a'.repeat(64),
      sourceMethod: event.sourceMethod,
      sourceVersion: event.sourceVersion,
      receivedAt: event.receivedAt,
    },
    event,
  })
}

ingest(
  timelineEvent('evt_user', 'codex.unknown', {
    envelopeKind: 'notification',
    method: 'item/completed',
    params: {
      item: {
        id: 'user-item-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Offline geçmişi doğrula' }],
      },
    },
  }),
)
ingest(
  timelineEvent('evt_agent_initial', 'agent.message.completed', {
    text: 'Son senkronize cevap çevrimdışıyken okunabilir.',
  }),
)
store.appendUsage({
  ...scope,
  turnId: 'turn_phase2_1',
  modelId: 'fixture-claude-model',
  priceCatalog: {
    version: 'phase2-browser-price-v1',
    currency: 'USD',
    effectiveAt: '2026-07-15T00:00:00.000Z',
    models: [
      {
        provider: 'claude',
        modelId: 'fixture-claude-model',
        inputPerMillionMicros: 1_000_000,
        cachedInputPerMillionMicros: 100_000,
        outputPerMillionMicros: 4_000_000,
        reasoningPerMillionMicros: 4_000_000,
        toolUnitMicros: 0,
      },
    ],
  },
  report: {
    schemaVersion: 1,
    kind: 'cumulative',
    provider: 'claude',
    requestId: 'request-phase2-1',
    dedupeKey: 'phase2-browser-usage',
    counters: {
      inputTokens: 1_000,
      cachedInputTokens: 100,
      outputTokens: 100,
      reasoningTokens: 0,
      toolUnits: 0,
    },
    completeness: 'complete',
    occurredAt: '2026-07-15T00:00:01.000Z',
  },
})
store.appendUsageOutcome({
  ...scope,
  turnId: 'turn_phase2_1',
  provider: 'claude',
  modelId: 'fixture-claude-model',
  dedupeKey: 'phase2-browser-terminal',
  outcome: 'completed',
  completeness: 'complete',
})

const api = await buildControlPlane({
  allowExplicitDevAuthentication: true,
  eventStore: store,
  artifactRoot: join(temporaryRoot, 'artifacts'),
  attachmentRoot: join(temporaryRoot, 'attachments'),
  codexHomeRoot: join(temporaryRoot, 'codex-homes'),
  workspaceCwd: repositoryRoot,
  providerCatalogs: [catalog],
})

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

const serverEntry = (
  await import(pathToFileURL(join(webRoot, 'dist/server/server.js')).href)
).default as { fetch(request: Request): Promise<Response> }

const web = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', baseUrl)
    const relative = normalize(decodeURIComponent(url.pathname)).replace(
      /^[/\\]+/,
      '',
    )
    const staticPath = resolve(clientRoot, relative)
    if (
      staticPath.startsWith(`${resolve(clientRoot)}/`) &&
      existsSync(staticPath) &&
      lstatSync(staticPath).isFile()
    ) {
      response.writeHead(200, {
        'content-type':
          contentTypes[extname(staticPath)] ?? 'application/octet-stream',
        ...(url.pathname === '/sw.js'
          ? { 'cache-control': 'no-cache, no-store, must-revalidate' }
          : {}),
      })
      createReadStream(staticPath).pipe(response)
      return
    }
    const rendered = await serverEntry.fetch(
      new Request(url, {
        method: request.method,
        headers: request.headers as HeadersInit,
      }),
    )
    response.writeHead(rendered.status, Object.fromEntries(rendered.headers))
    response.end(Buffer.from(await rendered.arrayBuffer()))
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end(error instanceof Error ? error.message : String(error))
  }
})

async function browser(...args: string[]) {
  const result = await execFileAsync(
    'agent-browser',
    ['--session', sessionName, '--namespace', namespace, ...args],
    { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000 },
  )
  return result.stdout.trim()
}

async function browserEval(expression: string) {
  return browser('eval', expression)
}

try {
  await api.listen({ host: '127.0.0.1', port: apiPort })
  await new Promise<void>((resolveListen, reject) => {
    web.once('error', reject)
    web.listen(webPort, '127.0.0.1', () => resolveListen())
  })
  const productionPage = await fetch(initialUrl, {
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(productionPage.status, 200, 'Production SSR route did not load')
  assert.match(await productionPage.text(), /Persistent Codex Workspace/)

  console.log('[phase2-browser] desktop + service worker')
  await browser('set', 'viewport', '1280', '720')
  await browser('open', initialUrl)
  await browser('wait', '1500')
  await browserEval(
    `(async () => { await navigator.serviceWorker.ready; return true })()`,
  )
  await browser('reload')
  await browser('wait', '1200')
  await browserEval(`(() => {
    const text = document.body.innerText
    if (!text.includes('Son senkronize cevap çevrimdışıyken okunabilir.')) throw new Error('initial conversation missing')
    if (!text.includes('tahmini · unreconciled · complete')) throw new Error('cost state missing')
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) throw new Error('desktop horizontal overflow')
    if (!document.querySelector('link[rel="manifest"]')) throw new Error('manifest link missing')
    if (!navigator.serviceWorker.controller) throw new Error('service worker is not controlling production page')
    if (!localStorage.getItem(${JSON.stringify(conversationSnapshotKey)})) throw new Error('tenant-aware offline conversation snapshot missing')
    if (localStorage.getItem('offline-conversation-v1:${scope.sessionId}')) throw new Error('legacy global offline conversation key was written')
    return true
  })()`)
  await browser('set', 'viewport', '390', '844')
  await browser('wait', '300')
  await browserEval(`(() => {
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) throw new Error('mobile horizontal overflow')
    if (!document.querySelector('textarea:not([disabled])')) throw new Error('online composer is unavailable')
    return true
  })()`)
  await browser('set', 'offline', 'on')
  await browser('reload')
  await browser('wait', '2500')
  console.log(
    '[phase2-browser] offline state',
    await browserEval(`JSON.stringify({
      online: navigator.onLine,
      controlled: Boolean(navigator.serviceWorker.controller),
      url: location.href,
      text: document.body.innerText.slice(0, 160)
    })`),
  )
  await browserEval(`(() => {
    const text = document.body.innerText
    if (!text.includes('Çevrimdışı')) throw new Error('offline warning missing')
    if (!text.includes('Son senkronize cevap çevrimdışıyken okunabilir.')) throw new Error('offline history missing')
    if (!document.querySelector('textarea[disabled]')) throw new Error('offline prompt was not disabled')
    if (!document.querySelector('input[type="file"][disabled]')) throw new Error('offline attachment was not disabled')
    return true
  })()`)
  ingest(
    timelineEvent('evt_agent_reconciled', 'agent.message.completed', {
      text: 'Online dönüş high-water replay ile uzlaştırıldı.',
    }),
  )
  await browser('set', 'offline', 'off')
  await browser('wait', '3000')
  await browserEval(`(() => {
    const text = document.body.innerText
    if (!text.includes('Online dönüş high-water replay ile uzlaştırıldı.')) throw new Error('online replay reconciliation missing')
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) throw new Error('reconnected horizontal overflow')
    if (document.querySelector('.vite-error-overlay')) throw new Error('vite error overlay present')
    return true
  })()`)
  console.log('[phase2-browser] tenant switch isolation')
  const tenantBUrl = `${baseUrl}/sessions/${scope.sessionId}?organization=ten_other&workspace=wsp_other`
  const tenantBSnapshotKey = offlineConversationKey(
    tenantCacheNamespace(principalId, 'ten_other', 'wsp_other'),
    scope.sessionId,
  )
  await browser('set', 'offline', 'on')
  await browser('open', tenantBUrl)
  await browser('wait', '1800')
  await browserEval(`(() => {
    const text = document.body.innerText
    if (text.includes('Son senkronize cevap çevrimdışıyken okunabilir.')) throw new Error('tenant A snapshot leaked after organization switch')
    if (localStorage.getItem(${JSON.stringify(tenantBSnapshotKey)})) throw new Error('tenant B snapshot was synthesized from tenant A')
    if (!localStorage.getItem(${JSON.stringify(conversationSnapshotKey)})) throw new Error('tenant A snapshot unexpectedly removed')
    return true
  })()`)
  await browser('set', 'offline', 'off')
  await browser('open', initialUrl)
  await browser('wait', '1200')
  const errors = await browser('errors', '--json')
  assert(
    errors === '[]' || /"errors"\s*:\s*\[\s*\]/.test(errors),
    `Browser page errors detected: ${errors}`,
  )

  console.log(
    JSON.stringify({
      browser: 'passed',
      viewports: ['1280x720', '390x844'],
      installability: 'manifest+icons+controlled-service-worker',
      offline: 'shell+read-only-history+send-blocked',
      online: 'snapshot+high-water-replay',
      tenantSwitch:
        'principal+organization+workspace scoped snapshot isolation',
      evidence: 'DOM/runtime assertions with zero page errors',
    }),
  )
} finally {
  try {
    await browser('set', 'offline', 'off')
    await browser('close')
  } catch {
    // Best-effort cleanup after a browser bootstrap failure.
  }
  await api.close()
  await new Promise<void>((resolveClose) => web.close(() => resolveClose()))
  store.close()
  rmSync(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })
}
