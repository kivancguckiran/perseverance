import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type {
  ProcessHealth,
  WorkspaceRuntimeClient,
} from '../agents/workspace-agent/src/index'
import { buildControlPlane } from '../services/control-plane/src/server'
import type { AuthPrincipal } from '../packages/control-plane-contracts/src/index'
import { InMemoryPushRepository } from '../packages/push-notifications/src/index'
import {
  EnvelopeEncryption,
  LocalKmsProvider,
} from '../packages/workspace-security/src/index'
import { freePort, repositoryRoot } from './wp22-e2e-harness'

class MobileRuntimeClient implements WorkspaceRuntimeClient {
  processGeneration = 1
  health: ProcessHealth = { state: 'stopped', restartAttempt: 0 }
  readonly responses: Array<{ id: string | number; result: unknown }> = []
  readonly notifications = new Set<(message: Record<string, unknown>) => void>()
  readonly serverRequests = new Set<
    (message: Record<string, unknown>) => void
  >()
  readonly healthListeners = new Set<(health: ProcessHealth) => void>()
  async initialize() {
    this.health = { state: 'ready', restartAttempt: 0 }
    return {}
  }
  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    if (method === 'account/read')
      return {
        account: { type: 'chatgpt' },
        requiresOpenaiAuth: true,
      } as TResult
    if (method === 'model/list')
      return {
        data: [
          {
            id: 'fixture-default',
            model: 'fixture-default',
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: 'Fixture default',
            description: 'WP23 fixture',
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium', description: 'Medium' },
            ],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text'],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
          },
        ],
        nextCursor: null,
      } as TResult
    if (method === 'thread/start')
      return { thread: { id: 'thr_wp23' } } as TResult
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emitNotification({
          method: 'turn/started',
          params: {
            threadId: 'thr_wp23',
            turn: {
              id: 'turn_wp23',
              status: 'inProgress',
              items: [],
              error: null,
            },
          },
        })
        this.emitNotification({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thr_wp23',
            turnId: 'turn_wp23',
            itemId: 'msg_wp23',
            delta: 'Uzun görev server üzerinde sürüyor.',
          },
        })
        this.emitServerRequest({
          id: 23,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thr_wp23',
            turnId: 'turn_wp23',
            itemId: 'cmd_wp23',
            startedAtMs: Date.now(),
            approvalId: null,
            environmentId: null,
            reason: 'Production registry erişimi gerekiyor',
            command: 'curl https://registry.example.test/package',
            cwd: '/workspace/project',
            commandActions: [
              {
                type: 'unknown',
                command: 'curl https://registry.example.test/package',
              },
            ],
            networkApprovalContext: {
              host: 'registry.example.test',
              protocol: 'https',
              port: 443,
            },
            proposedExecpolicyAmendment: null,
            proposedNetworkPolicyAmendments: null,
          },
        })
      })
      return {
        turn: { id: 'turn_wp23', status: 'inProgress', items: [], error: null },
      } as TResult
    }
    if (method === 'thread/read' || method === 'thread/resume')
      return { thread: { id: 'thr_wp23', turns: [] } } as TResult
    if (method === 'turn/interrupt') return {} as TResult
    throw new Error(`Unexpected method ${method}: ${JSON.stringify(params)}`)
  }
  onNotification(listener: (message: Record<string, unknown>) => void) {
    this.notifications.add(listener)
    return () => this.notifications.delete(listener)
  }
  onServerRequest(listener: (message: Record<string, unknown>) => void) {
    this.serverRequests.add(listener)
    return () => this.serverRequests.delete(listener)
  }
  onHealthChange(listener: (health: ProcessHealth) => void) {
    this.healthListeners.add(listener)
    return () => this.healthListeners.delete(listener)
  }
  respond(id: string | number, result: unknown) {
    this.responses.push({ id, result })
  }
  async stop() {
    this.health = { state: 'stopped', restartAttempt: 0 }
  }
  emitNotification(message: Record<string, unknown>) {
    for (const listener of this.notifications) listener(message)
  }
  emitServerRequest(message: Record<string, unknown>) {
    for (const listener of this.serverRequests) listener(message)
  }
  completeLongTask() {
    this.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thr_wp23',
        turnId: 'turn_wp23',
        item: {
          type: 'agentMessage',
          id: 'msg_wp23',
          text: 'Uzun görev browser kapalıyken tamamlandı.',
          phase: null,
          memoryCitation: null,
        },
        completedAtMs: Date.now(),
      },
    })
    this.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thr_wp23',
        turn: { id: 'turn_wp23', status: 'completed', items: [], error: null },
      },
    })
  }
}

class BrowserAuthentication {
  async authenticate(): Promise<AuthPrincipal> {
    const now = new Date()
    return {
      version: 1,
      kind: 'end_user',
      subject: 'wp23-user',
      issuer: 'urn:wp23-browser',
      audience: ['wp23-browser'],
      authenticatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      assurance: { level: 'test', mfa: true },
      memberships: [
        {
          version: 1,
          subject: 'wp23-user',
          issuer: 'urn:wp23-browser',
          organizationId: tenantId,
          role: 'owner',
          status: 'active',
          workspaceIds: [workspaceId],
          updatedAt: now.toISOString(),
        },
      ],
    }
  }
}

const root = mkdtempSync(join(tmpdir(), 'wp23-browser-'))
const apiPort = await freePort()
const webPort = await freePort()
const apiUrl = `http://127.0.0.1:${apiPort}`
const webUrl = `http://127.0.0.1:${webPort}`
const wp24Billing = process.env.WP24_BROWSER === '1'
const tenantId = 'tenant_wp23'
const workspaceId = 'workspace_wp23'
const client = new MobileRuntimeClient()
const principalId = `sha256:${createHash('sha256')
  .update('urn:wp23-browser\0wp23-user')
  .digest('hex')}`
const pushRepository = new InMemoryPushRepository(
  new EnvelopeEncryption(
    new LocalKmsProvider(
      createHash('sha256').update('wp23-browser-push').digest(),
    ),
  ),
)
const execAsync = promisify(execFile)
const browser = (device: 'a' | 'b', ...args: string[]) =>
  execAsync(
    'agent-browser',
    [
      '--session',
      `wp23-${device}-${process.pid}`,
      '--namespace',
      `persistent-wp23-${device}-${process.pid}`,
      ...args,
    ],
    { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000 },
  ).then((result) => result.stdout.trim())
const evaluate = (device: 'a' | 'b', expression: string) =>
  browser(device, 'eval', expression)
const waitFor = async (
  label: string,
  predicate: () => Promise<boolean>,
  timeout = 30_000,
) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`${label} timed out`)
}
let app: Awaited<ReturnType<typeof buildControlPlane>> | undefined
let web: ReturnType<typeof createServer> | undefined
try {
  mkdirSync(join(root, 'workspace'))
  app = await buildControlPlane({
    databasePath: join(root, 'events.sqlite'),
    artifactRoot: join(root, 'artifacts'),
    workspaceCwd: join(root, 'workspace'),
    codexHomeRoot: join(root, 'codex-home'),
    runtimeClientFactory: () => client,
    authenticationAdapter: new BrowserAuthentication(),
    pushRepository,
    allowLocalCorpus: true,
    allowInMemorySupportAccess: true,
    allowInMemorySharedFolders: true,
    ...(wp24Billing
      ? {
          commercialPolicy: {
            snapshot: () => ({
              plan: {
                schemaVersion: 1 as const,
                tenantId,
                organizationId: tenantId,
                workspaceId,
                planId: 'phase4-beta',
                planVersion: 24,
                displayName: 'Phase 4 Beta',
                currency: 'USD',
                effectiveAt: '2026-07-18T00:00:00.000Z',
                retiredAt: null,
                billingMode: 'hybrid' as const,
                taxBehavior: 'unknown' as const,
              },
              entitlements: (
                [
                  'turn.start',
                  'source.upload',
                  'source.index',
                  'source.retrieval',
                  'workspace.concurrency',
                ] as const
              ).map((key, index) => ({
                schemaVersion: 1 as const,
                tenantId,
                organizationId: tenantId,
                workspaceId,
                entitlementId: `wp24-ent-${index}`,
                planId: 'phase4-beta',
                planVersion: 24,
                key,
                enabled: true,
                effectiveAt: '2026-07-18T00:00:00.000Z',
                expiresAt: null,
                sourceWebhookEventId: null,
              })),
              budgets: [
                {
                  schemaVersion: 1 as const,
                  tenantId,
                  organizationId: tenantId,
                  workspaceId,
                  budgetId: 'wp24-monthly',
                  period: 'month' as const,
                  currency: 'USD',
                  softLimitMicros: 8_000_000,
                  hardLimitMicros: 10_000_000,
                  effectiveAt: '2026-07-18T00:00:00.000Z',
                  expiresAt: null,
                },
              ],
              quotas: [],
            }),
            measurements: () => ({
              values: {},
              watermark: 'ledger-browser-24',
              measuredAt: '2026-07-18T10:00:00.000Z',
            }),
            productionBillingVerified: false,
          },
        }
      : {}),
  })
  await app.listen({ host: '127.0.0.1', port: apiPort })
  const headers = { 'x-tenant-id': tenantId, 'x-workspace-id': workspaceId }
  const sessionReply = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers,
    payload: {},
  })
  assert.equal(sessionReply.statusCode, 201)
  const sessionId = sessionReply.json().sessionId as string
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/turns`,
        headers: { ...headers, 'idempotency-key': 'wp23-long-task' },
        payload: { prompt: 'Uzun görevi başlat' },
      })
    ).statusCode,
    202,
  )
  let approvalId = ''
  await waitFor('approval creation', async () => {
    const pending = await app!.inject({
      method: 'GET',
      url: '/v1/approvals?status=pending',
      headers,
    })
    approvalId = pending.json().approvals[0]?.approvalId ?? ''
    return Boolean(approvalId)
  })
  await pushRepository.upsert(
    {
      tenantId,
      organizationId: tenantId,
      workspaceId,
      principalId,
    },
    {
      version: 1,
      deviceId: 'browser-device',
      endpoint: 'https://push.example.test/browser',
      keys: { p256dh: 'p'.repeat(32), auth: 'a'.repeat(16) },
      expiresAt: null,
    },
  )
  await pushRepository.enqueue(
    { tenantId, organizationId: tenantId, workspaceId },
    {
      notificationId: 'notification_wp23',
      sessionId,
      approvalId,
      status: 'approval_required',
    },
  )

  execFileSync('pnpm', ['--filter', '@persistent-codex/web', 'build'], {
    cwd: repositoryRoot,
    env: { ...process.env, VITE_CONTROL_PLANE_URL: apiUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const clientRoot = join(repositoryRoot, 'apps/web/dist/client')
  const serverEntry = (
    await import(
      pathToFileURL(join(repositoryRoot, 'apps/web/dist/server/server.js')).href
    )
  ).default as { fetch(request: Request): Promise<Response> }
  const contentTypes: Record<string, string> = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  }
  web = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', webUrl)
    const relativePath = normalize(decodeURIComponent(url.pathname)).replace(
      /^[/\\]+/,
      '',
    )
    const staticPath = resolve(clientRoot, relativePath)
    if (
      staticPath.startsWith(`${resolve(clientRoot)}/`) &&
      existsSync(staticPath) &&
      lstatSync(staticPath).isFile()
    ) {
      response.writeHead(200, {
        'content-type':
          contentTypes[extname(staticPath)] ?? 'application/octet-stream',
        'cache-control': 'public,max-age=60',
      })
      createReadStream(staticPath).pipe(response)
      return
    }
    const rendered = await serverEntry.fetch(
      new Request(url, { headers: request.headers as HeadersInit }),
    )
    response.writeHead(rendered.status, Object.fromEntries(rendered.headers))
    response.end(Buffer.from(await rendered.arrayBuffer()))
  })
  await new Promise<void>((resolveListen, reject) => {
    web!.once('error', reject)
    web!.listen(webPort, '127.0.0.1', resolveListen)
  })
  const url = `${webUrl}/sessions/${sessionId}?notification=notification_wp23&approval=${approvalId}`
  await Promise.all([
    browser('a', 'set', 'viewport', '390', '844'),
    browser('b', 'set', 'viewport', '768', '1024'),
  ])
  await Promise.all([browser('a', 'open', url), browser('b', 'open', url)])
  await waitFor(
    'both devices approval',
    async () =>
      (await evaluate(
        'a',
        `document.body.innerText.includes('Komut onayı')`,
      )) === 'true' &&
      (await evaluate(
        'b',
        `document.body.innerText.includes('Komut onayı')`,
      )) === 'true',
  )
  assert.equal(
    await evaluate(
      'a',
      `location.search.includes('organization=${tenantId}')&&location.search.includes('workspace=${workspaceId}')`,
    ),
    'true',
  )
  for (const device of ['a', 'b'] as const) {
    assert.equal(
      await evaluate(
        device,
        `['registry.example.test','/workspace/project','Risk','Scope','Expiry'].every(v=>document.body.innerText.includes(v))`,
      ),
      'true',
    )
    assert.equal(
      await evaluate(
        device,
        `document.documentElement.scrollWidth<=document.documentElement.clientWidth`,
      ),
      'true',
    )
    assert.equal(
      await evaluate(
        device,
        `[...document.querySelectorAll('.approval-actions button')].filter(b=>b.offsetParent!==null).every(b=>b.getBoundingClientRect().height>=44&&b.getBoundingClientRect().width>=44)`,
      ),
      'true',
    )
    assert.equal(
      await evaluate(
        device,
        `document.activeElement?.classList.contains('approval-card')===true`,
      ),
      'true',
    )
    assert.equal(
      await evaluate(
        device,
        `[...document.querySelectorAll('.approval-actions button')].filter(b=>b.offsetParent!==null).every(b=>b.textContent.trim().length>0)&&document.querySelector('.approval-card')?.getAttribute('aria-live')==='assertive'`,
      ),
      'true',
    )
  }
  await Promise.all([
    evaluate(
      'a',
      `([...document.querySelectorAll('.approval-actions button')].find(b=>b.textContent.includes('Accept once'))).click()`,
    ),
    evaluate(
      'b',
      `([...document.querySelectorAll('.approval-actions button')].find(b=>b.textContent.includes('Decline'))).click()`,
    ),
  ])
  await waitFor(
    'CAS reconciliation',
    async () =>
      (await evaluate(
        'a',
        `document.querySelector('.approval-card')?.textContent.includes('resolved')`,
      )) === 'true' &&
      (await evaluate(
        'b',
        `document.querySelector('.approval-card')?.textContent.includes('resolved')`,
      )) === 'true',
  )
  assert.equal(client.responses.length, 1)
  await browser('a', 'close')
  client.completeLongTask()
  await waitFor(
    'background completion device b',
    async () =>
      (await evaluate(
        'b',
        `document.body.innerText.includes('Uzun görev browser kapalıyken tamamlandı.')`,
      )) === 'true',
  )
  await browser('a', 'open', url)
  await waitFor(
    'replay after reopen',
    async () =>
      (await evaluate(
        'a',
        `document.body.innerText.includes('Uzun görev browser kapalıyken tamamlandı.')`,
      )) === 'true',
  )
  assert.equal(
    await evaluate(
      'a',
      `document.querySelectorAll('.approval-actions button').length===0`,
    ),
    'true',
  )
  assert.equal(
    await evaluate(
      'a',
      `Boolean(document.querySelector('link[rel="manifest"]')) && 'serviceWorker' in navigator`,
    ),
    'true',
  )
  if (wp24Billing) {
    await evaluate(
      'a',
      `document.querySelector('.usage-summary > summary')?.click()`,
    )
    await waitFor(
      'billing overview',
      async () =>
        (await evaluate(
          'a',
          `document.body.innerText.includes('Phase 4 Beta') && document.body.innerText.includes('Billing emulator') && document.body.innerText.includes('currency USD') && document.body.innerText.includes('Kota uygun')`,
        )) === 'true',
    )
    assert.equal(
      await evaluate(
        'a',
        `!document.body.innerText.match(/webhook secret|api key|payment credential|Bearer\s|sk-/i)`,
      ),
      'true',
    )
  }
  await browser('a', 'set', 'viewport', '1280', '720')
  assert.equal(
    await evaluate(
      'a',
      `document.documentElement.scrollWidth<=document.documentElement.clientWidth`,
    ),
    'true',
  )
  await browser('b', 'set', 'offline', 'on')
  await browser('b', 'reload')
  await waitFor(
    'offline read only shell',
    async () =>
      (await evaluate(
        'b',
        `document.body.innerText.includes('Çevrimdışı') && Boolean(document.querySelector('textarea[disabled]'))`,
      )) === 'true',
  )
  assert.equal(
    await evaluate(
      'b',
      `document.querySelectorAll('.approval-actions button').length===0`,
    ),
    'true',
  )
  await browser('b', 'set', 'offline', 'off')
  const errorsA = await browser('a', 'errors', '--json')
  const errorsB = await browser('b', 'errors', '--json')
  assert(errorsA === '[]' || /"errors"\s*:\s*\[\s*\]/.test(errorsA), errorsA)
  assert(errorsB === '[]' || /"errors"\s*:\s*\[\s*\]/.test(errorsB), errorsB)
  console.log(
    JSON.stringify({
      twoDevices: true,
      casWinners: 1,
      upstreamResponses: client.responses.length,
      realtimeReconciled: true,
      highWaterReplay: true,
      backgroundCompletion: true,
      duplicateDecision: 0,
      viewports: ['390x844', '768x1024', '1280x720'],
      keyboardFocus: true,
      screenReaderLabels: true,
      touchTargets: '>=44px',
      horizontalOverflow: 0,
      pageErrors: 0,
      offline: 'read-only-shell',
      serviceWorker: 'production-build',
      billing: wp24Billing
        ? 'plan-budget-usage-emulator-visible'
        : 'not-requested',
    }),
  )
} finally {
  for (const device of ['a', 'b'] as const) {
    try {
      await browser(device, 'set', 'offline', 'off')
      await browser(device, 'close')
    } catch {}
  }
  if (web)
    await new Promise<void>((resolveClose) => web!.close(() => resolveClose()))
  await app?.close().catch(() => undefined)
  rmSync(root, { recursive: true, force: true })
}
