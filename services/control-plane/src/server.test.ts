import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { LocalArtifactStorage } from '@persistent-codex/artifact-storage'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ProcessHealth,
  WorkspaceRuntimeClient,
} from '@persistent-codex/workspace-agent'
import { RequestTimeoutError } from '@persistent-codex/workspace-agent'
import type { TimelineEvent } from '@persistent-codex/domain-events'
import type {
  ProviderModelCatalog,
  ProviderRuntimeAdapterV1,
} from '@persistent-codex/provider-platform'
import {
  serverMessageSchema,
  sessionResponseSchema,
  type ServerMessage,
} from '@persistent-codex/control-plane-contracts'
import {
  SqliteEventStore,
  type StoreScope,
} from '@persistent-codex/event-store'
import {
  BoundedRealtimeSender,
  buildControlPlane,
  type ControlPlaneOptions,
} from './server'
import {
  DeterministicBillingEmulator,
  type CommercialPolicySnapshot,
} from '@persistent-codex/billing-platform'

const scope: StoreScope = {
  tenantId: 'ten_test',
  workspaceId: 'wsp_test',
  sessionId: 'ses_test',
}
const headers = {
  'x-tenant-id': scope.tenantId,
  'x-workspace-id': scope.workspaceId,
}
describe('bounded realtime sender', () => {
  it('bounds a slow socket and emits one typed resync', async () => {
    const sent: string[] = []
    const socket = {
      bufferedAmount: 10_000,
      send: (data: string) => sent.push(data),
    }
    const sender = new BoundedRealtimeSender(socket, 4, 1024)
    sender.updateCursor({ ...scope, afterSequence: 7, highWaterSequence: 12 })
    for (let index = 0; index < 20; index++)
      sender.enqueue({
        type: 'event',
        ...scope,
        event: { ...event(`slow_${index}`), sequence: index + 8 },
      })
    expect(sender.counters.events).toBeLessThanOrEqual(4)
    expect(sender.counters.bytes).toBeLessThanOrEqual(1024)
    socket.bufferedAmount = 0
    await new Promise((resolve) => setTimeout(resolve, 15))
    const messages = sent.map((value) =>
      serverMessageSchema.parse(JSON.parse(value)),
    )
    expect(
      messages.filter((message) => message.type === 'resync'),
    ).toHaveLength(1)
    expect(messages.find((message) => message.type === 'resync')).toMatchObject(
      { reason: 'queue_overflow', afterSequence: 7, highWaterSequence: 12 },
    )
  })
})

describe('WP13 scoped usage and cost API', () => {
  it('returns session/turn usage without content or cross-tenant leakage', async () => {
    const store = new SqliteEventStore(':memory:')
    store.createSession({
      ...scope,
      resolvedModel: 'fixture-model',
      reasoningEffort: 'medium',
      capabilitySnapshot: {
        streaming: 'supported',
        reasoningSummary: 'supported',
        commandExecution: 'supported',
        fileChanges: 'supported',
        approvals: 'supported',
        interrupt: 'supported',
        resume: 'supported',
        toolCalls: 'supported',
        imageInput: 'unsupported',
        usage: 'supported',
        cost: 'unsupported',
      },
    })
    store.createTurn({
      ...scope,
      turnId: 'turn_usage_api',
      providerTurnId: 'provider_turn_usage_api',
      provider: 'codex',
      requestedPolicy: { alias: 'sol', reasoningEffort: 'medium' },
      resolvedModel: 'fixture-model',
      reasoningEffort: 'medium',
      capabilitySnapshot: store.getSession(scope).capabilitySnapshot!,
      status: 'in_progress',
    })
    store.appendUsage({
      ...scope,
      turnId: 'turn_usage_api',
      modelId: 'fixture-model',
      priceCatalog: {
        version: 'api-fixture-v1',
        currency: 'USD',
        effectiveAt: '2026-07-15T00:00:00.000Z',
        models: [
          {
            provider: 'codex',
            modelId: 'fixture-model',
            inputPerMillionMicros: 1_000_000,
            cachedInputPerMillionMicros: 0,
            outputPerMillionMicros: 0,
            reasoningPerMillionMicros: 0,
            toolUnitMicros: 0,
          },
        ],
      },
      report: {
        schemaVersion: 1,
        kind: 'cumulative',
        provider: 'codex',
        requestId: 'request_usage_api',
        dedupeKey: 'usage_api_1',
        counters: {
          inputTokens: 123,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          toolUnits: 0,
        },
        completeness: 'complete',
        occurredAt: '2026-07-15T00:00:00.000Z',
      },
    })
    store.appendUsageOutcome({
      ...scope,
      turnId: 'turn_usage_api',
      provider: 'codex',
      modelId: 'fixture-model',
      dedupeKey: 'terminal_usage_api',
      outcome: 'failed',
      completeness: 'complete',
    })
    const reconcile = vi.fn(async () => [
      {
        sourceReference: 'fixture:official-cost:turn_usage_api',
        officialCostMicros: 100,
        currency: 'USD' as const,
        reconciledAt: '2026-07-15T01:00:00.000Z',
      },
    ])
    const app = await buildControlPlane({
      eventStore: store,
      costReconciliationPorts: { codex: { reconcile } },
    })
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/ses_test/turns/turn_usage_api/usage',
        headers,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        outcome: 'failed',
        counters: { inputTokens: 123 },
        estimatedCostMicros: 123,
        reconciliationStatus: 'unreconciled',
      })
      expect(response.body).not.toMatch(
        /prompt|credential|Bearer|model response/i,
      )
      const sessionUsage = await app.inject({
        method: 'GET',
        url: '/v1/sessions/ses_test/usage',
        headers,
      })
      expect(sessionUsage.json()).toMatchObject({
        total: { counters: { inputTokens: 123 } },
        items: [
          {
            turnId: 'turn_usage_api',
            purpose: 'conversation_turn',
            outcome: 'failed',
          },
        ],
      })
      const reconciled = await app.inject({
        method: 'POST',
        url: '/v1/sessions/ses_test/usage/reconcile',
        headers,
      })
      expect(reconciled.json()).toMatchObject({
        status: 'reconciled',
        provider: 'codex',
        reconciledItems: 1,
      })
      const repeated = await app.inject({
        method: 'POST',
        url: '/v1/sessions/ses_test/usage/reconcile',
        headers,
      })
      expect(repeated.json()).toMatchObject({
        status: 'reconciled',
        reconciledItems: 0,
      })
      expect(reconcile).toHaveBeenCalledOnce()
      const official = await app.inject({
        method: 'GET',
        url: '/v1/sessions/ses_test/usage',
        headers,
      })
      expect(official.json()).toMatchObject({
        total: {
          reconciliationStatus: 'reconciled',
          officialCostMicros: 100,
        },
        items: [
          {
            reconciliationStatus: 'reconciled',
            officialCostMicros: 100,
          },
        ],
      })
      const hidden = await app.inject({
        method: 'GET',
        url: '/v1/sessions/ses_test/usage',
        headers: { ...headers, 'x-tenant-id': 'ten_other' },
      })
      expect(hidden.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })
})

describe('WP24 commercial admission and billing API', () => {
  it('audits soft warnings, denies hard quota before provider work, and exposes no credentials', async () => {
    const store = new SqliteEventStore(':memory:')
    store.createSession(scope)
    const policyScope = {
      tenantId: scope.tenantId,
      organizationId: scope.tenantId,
      workspaceId: scope.workspaceId,
    }
    const snapshot: CommercialPolicySnapshot = {
      plan: {
        ...policyScope,
        schemaVersion: 1,
        planId: 'beta',
        planVersion: 24,
        displayName: 'Beta',
        currency: 'USD',
        effectiveAt: '2026-07-18T00:00:00.000Z',
        retiredAt: null,
        billingMode: 'hybrid',
        taxBehavior: 'unknown',
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
        ...policyScope,
        schemaVersion: 1 as const,
        entitlementId: `ent-${index}`,
        planId: 'beta',
        planVersion: 24,
        key,
        enabled: true,
        effectiveAt: '2026-07-18T00:00:00.000Z',
        expiresAt: null,
        sourceWebhookEventId: null,
      })),
      budgets: [],
      quotas: [
        {
          ...policyScope,
          schemaVersion: 1,
          quotaId: 'spend',
          policyVersion: 3,
          meter: 'provider_spend_micros',
          softLimit: 80,
          hardLimit: 100,
          inFlightPolicy: 'continue',
          effectiveAt: '2026-07-18T00:00:00.000Z',
          expiresAt: null,
        },
      ],
    }
    let spend = 80
    const decisions: string[] = []
    const app = await buildControlPlane({
      eventStore: store,
      commercialPolicy: {
        snapshot: () => snapshot,
        measurements: () => ({
          values: { provider_spend_micros: spend },
          watermark: `ledger-${spend}`,
          measuredAt: '2026-07-18T10:00:00.000Z',
        }),
        recordDecision: (decision) => {
          decisions.push(decision.outcome)
        },
        productionBillingVerified: false,
      },
    })
    try {
      const warned = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${scope.sessionId}/turns`,
        headers: { ...headers, 'idempotency-key': 'soft-warning' },
        payload: { prompt: 'test' },
      })
      expect(warned.headers['x-usage-warning']).toBe(
        'SOFT_LIMIT_PROVIDER_SPEND_MICROS',
      )
      spend = 100
      const denied = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${scope.sessionId}/turns`,
        headers: { ...headers, 'idempotency-key': 'hard-limit' },
        payload: { prompt: 'must not reach provider' },
      })
      expect(denied.statusCode).toBe(429)
      expect(denied.json()).toMatchObject({
        code: 'USAGE_LIMIT_REACHED',
        message: 'Workspace usage limit reached',
        reasonCode: 'HARD_LIMIT_PROVIDER_SPEND_MICROS',
        policyVersion: 3,
        measurementWatermark: 'ledger-100',
      })
      const billing = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${scope.workspaceId}/billing?sessionId=${scope.sessionId}`,
        headers,
      })
      expect(billing.statusCode).toBe(200)
      expect(billing.json()).toMatchObject({
        plan: { planId: 'beta', planVersion: 24, billingMode: 'hybrid' },
        latestDecision: { outcome: 'deny' },
        productionBillingVerified: false,
        credits: {
          balance: {
            availableCreditsMicros: 0,
            reservedCreditsMicros: 0,
            ledgerWatermark: 'clw_0',
          },
          ledger: [],
          reservations: [],
          settlements: [],
        },
      })
      expect(billing.body).not.toMatch(
        /api.?key|webhook.?secret|credential|payload/i,
      )
      expect(decisions).toEqual(['warn', 'deny'])
      expect(store.listAudit(scope).records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'quota.decided' }),
        ]),
      )
    } finally {
      await app.close()
    }
  })

  it('returns a retryable dependency error when commercial admission is unavailable', async () => {
    const store = new SqliteEventStore(':memory:')
    store.createSession(scope)
    const app = await buildControlPlane({
      eventStore: store,
      commercialPolicy: {
        snapshot: async () => {
          throw Object.assign(new Error('database is in recovery'), {
            code: '57P03',
          })
        },
        measurements: async () => ({
          values: {},
          watermark: 'unavailable',
          measuredAt: '2026-07-18T10:00:00.000Z',
        }),
        productionBillingVerified: false,
      },
    })
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${scope.sessionId}/turns`,
        headers: { ...headers, 'idempotency-key': 'dependency-unavailable' },
        payload: { prompt: 'test' },
      })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({
        code: 'COMMERCIAL_DEPENDENCY_UNAVAILABLE',
        message: 'Commercial policy dependency is unavailable',
      })
    } finally {
      await app.close()
    }
  })

  it('authenticates a bounded raw webhook without persisting provider payload material', async () => {
    const provider = new DeterministicBillingEmulator({
      secret: Buffer.alloc(32, 24),
    })
    const recorded: unknown[] = []
    const repository = {
      async recordWebhook(event: unknown, command: unknown) {
        recorded.push({ event, command })
        return {
          duplicate: false,
          processingState: 'received' as const,
          effectiveAt: '2026-07-18T10:00:00.000Z',
        }
      },
      async drainWebhooks() {
        return [{ eventId: 'evt_unknown_1', state: 'unknown' }]
      },
    }
    const app = await buildControlPlane({
      eventStore: new SqliteEventStore(':memory:'),
      billingWebhook: { provider, repository },
    })
    try {
      const timestamp = Date.now()
      const payload = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          tenantId: 'ten_test',
          organizationId: 'ten_test',
          workspaceId: 'wsp_test',
          eventId: 'evt_unknown_1',
          eventType: 'future.payment.event',
          providerSequence: 1,
          effectiveAt: '2026-07-18T10:00:00.000Z',
          data: { paymentCredential: 'must-not-survive-normalization' },
        }),
      )
      const response = await app.inject({
        method: 'POST',
        url: `/v1/billing/webhooks/${provider.provider}`,
        headers: {
          'content-type':
            'application/vnd.persistent-codex.billing-webhook+json',
          'x-billing-event-id': 'evt_unknown_1',
          'x-billing-timestamp': String(timestamp),
          'x-billing-signature': provider.sign(payload, timestamp),
        },
        payload,
      })
      expect(response.statusCode, response.body).toBe(202)
      expect(response.json()).toEqual({
        schemaVersion: 1,
        eventId: 'evt_unknown_1',
        state: 'unknown',
        duplicate: false,
        productionEvidence: false,
      })
      expect(recorded).toHaveLength(1)
      expect(JSON.stringify(recorded)).not.toContain('paymentCredential')
      expect(response.body).not.toContain('must-not-survive-normalization')
    } finally {
      await app.close()
    }
  })
})

describe('WP10 session navigation and Git API', () => {
  it('paginates scoped sessions, persists refresh, and rejects Git operations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp10-api-'))
    const repository = join(directory, 'repo')
    const databasePath = join(directory, 'events.sqlite')
    const artifactRoot = join(directory, 'artifacts')
    mkdirSync(repository)
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], {
      cwd: repository,
    })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    writeFileSync(join(repository, 'file.txt'), 'one\n')
    execFileSync('git', ['add', 'file.txt'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repository })
    writeFileSync(join(repository, 'file.txt'), 'two\n')
    const store = new SqliteEventStore(databasePath)
    store.createSession(scope)
    store.createSession({ ...scope, sessionId: 'ses_second' })
    store.createSession({ ...scope, sessionId: 'ses_blank' })
    store.createSession({
      ...scope,
      tenantId: 'ten_other',
      sessionId: 'ses_hidden',
    })
    for (const sessionId of [scope.sessionId, 'ses_second'])
      store.recordDurableUserMessage({
        ...scope,
        sessionId,
        messageId: `msg_${sessionId}`,
        idempotencyKey: `turn_${sessionId}`,
        content: `Message for ${sessionId}`,
      })
    const app = await buildControlPlane({
      eventStore: store,
      workspaceCwd: repository,
      artifactRoot,
      codexHomeRoot: join(directory, 'homes'),
    })
    try {
      const first = await app.inject({
        method: 'GET',
        url: '/v1/sessions?limit=1',
        headers,
      })
      expect(first.statusCode).toBe(200)
      expect(first.json().sessions).toHaveLength(1)
      expect(first.json().nextCursor).toBeTruthy()
      const second = await app.inject({
        method: 'GET',
        url: `/v1/sessions?limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
        headers,
      })
      expect(second.json().sessions).toHaveLength(1)
      expect(second.json().sessions[0].tenantId).toBe(scope.tenantId)
      expect([...first.json().sessions, ...second.json().sessions]).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: 'ses_blank' }),
        ]),
      )

      const createdFolder = await app.inject({
        method: 'POST',
        url: '/v1/conversation-folders',
        headers,
        payload: { name: 'Product' },
      })
      expect(createdFolder.statusCode).toBe(201)
      expect(createdFolder.json()).toMatchObject({ name: 'Product' })
      const folders = await app.inject({
        method: 'GET',
        url: '/v1/conversation-folders',
        headers,
      })
      expect(folders.json().folders).toHaveLength(1)
      const organized = await app.inject({
        method: 'PATCH',
        url: `/v1/sessions/${scope.sessionId}/conversation`,
        headers,
        payload: {
          folderId: createdFolder.json().folderId,
          title: 'Architecture chat',
        },
      })
      expect(organized.statusCode).toBe(200)
      expect(organized.json()).toMatchObject({
        folderId: createdFolder.json().folderId,
        title: 'Architecture chat',
      })
      const archivedConversation = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${scope.sessionId}/archive`,
        headers,
        payload: { archived: true },
      })
      expect(archivedConversation.statusCode).toBe(200)
      expect(archivedConversation.json().archivedAt).toBeTruthy()
      const archivedTurn = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${scope.sessionId}/turns`,
        headers: { ...headers, 'idempotency-key': 'archived-turn' },
        payload: { prompt: 'must be rejected' },
      })
      expect(archivedTurn.statusCode).toBe(409)
      expect(archivedTurn.json()).toMatchObject({ code: 'SESSION_ARCHIVED' })
      const activeConversations = await app.inject({
        method: 'GET',
        url: '/v1/sessions?limit=10',
        headers,
      })
      expect(
        activeConversations
          .json()
          .sessions.map((item: { sessionId: string }) => item.sessionId),
      ).not.toContain(scope.sessionId)
      const archivedConversations = await app.inject({
        method: 'GET',
        url: '/v1/sessions?limit=10&archived=true',
        headers,
      })
      expect(archivedConversations.json().sessions).toEqual([
        expect.objectContaining({ sessionId: scope.sessionId }),
      ])
      const restoredConversation = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${scope.sessionId}/archive`,
        headers,
        payload: { archived: false },
      })
      expect(restoredConversation.statusCode).toBe(200)
      expect(restoredConversation.json().archivedAt).toBeNull()
      const archived = await app.inject({
        method: 'PATCH',
        url: `/v1/conversation-folders/${createdFolder.json().folderId}`,
        headers,
        payload: { archived: true },
      })
      expect(archived.statusCode).toBe(200)
      expect(archived.json().archivedAt).toBeTruthy()
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/conversation-folders/${createdFolder.json().folderId}`,
        headers,
      })
      expect(deleted.statusCode).toBe(204)
      expect(store.getSession(scope).folderId).toBeNull()

      const mutation = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${scope.sessionId}/git-snapshots/refresh`,
        headers: { ...headers, 'idempotency-key': 'mutate' },
        payload: { operation: 'checkout', args: ['--force'], cwd: '..' },
      })
      expect(mutation.statusCode).toBe(400)
      const refresh = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${scope.sessionId}/git-snapshots/refresh`,
        headers: { ...headers, 'idempotency-key': 'refresh-1' },
        payload: {},
      })
      expect(refresh.statusCode).toBe(200)
      expect(refresh.json()).toMatchObject({
        repositoryKind: 'repository',
        clean: false,
        phase: 'refresh',
      })
      const list = await app.inject({
        method: 'GET',
        url: `/v1/sessions/${scope.sessionId}/git-snapshots`,
        headers,
      })
      expect(list.json().snapshots).toHaveLength(1)
      expect(list.json().snapshots[0].headOid).toBe(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repository,
          encoding: 'utf8',
        }).trim(),
      )
      writeFileSync(join(repository, 'large.txt'), 'old line\n'.repeat(12_000))
      execFileSync('git', ['add', 'large.txt'], { cwd: repository })
      execFileSync('git', ['commit', '-qm', 'large base'], { cwd: repository })
      writeFileSync(join(repository, 'large.txt'), 'new line\n'.repeat(12_000))
      const large = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${scope.sessionId}/git-snapshots/refresh`,
        headers: { ...headers, 'idempotency-key': 'refresh-large' },
        payload: {},
      })
      expect(large.statusCode).toBe(200)
      expect(large.json().diff).toMatchObject({ truncated: true })
      expect(Buffer.byteLength(large.json().diff.preview)).toBeLessThanOrEqual(
        64 * 1024,
      )
      const artifact = store
        .listArtifacts(scope)
        .find((item) => item.kind === 'git-diff')
      expect(artifact).toMatchObject({ finalized: true, kind: 'git-diff' })
      const wrongTenant = await app.inject({
        method: 'POST',
        url: `/v1/artifacts/${artifact!.artifactId}/download-token`,
        headers: { ...headers, 'x-tenant-id': 'ten_other' },
      })
      expect(wrongTenant.statusCode).toBe(404)
    } finally {
      await app.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('WP11 health, readiness, metrics, and audit API', () => {
  it('keeps liveness dependency-free and reports deterministic dependency recovery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp11-health-'))
    const databaseRoot = join(directory, 'database')
    const artifactRoot = join(directory, 'artifacts')
    const workspace = join(directory, 'workspace')
    mkdirSync(databaseRoot)
    mkdirSync(workspace)
    const instance = await buildControlPlane({
      databasePath: join(databaseRoot, 'events.sqlite'),
      artifactRoot,
      codexHomeRoot: join(directory, 'homes'),
      workspaceCwd: workspace,
      runtimeClientFactory: () => new FakeRuntimeClient(),
      now: () => new Date('2026-07-15T09:00:00.000Z'),
    })
    try {
      expect(
        (await instance.inject({ method: 'GET', url: '/healthz' })).json(),
      ).toEqual({ status: 'ok' })
      const ready = await instance.inject({
        method: 'GET',
        url: '/readyz',
        headers,
      })
      expect(ready.statusCode).toBe(200)
      expect(ready.json()).toMatchObject({
        security: {
          runtimeBackend: 'local-process',
          isolationLevel: 'development_only',
          encryptedVolume: false,
          egressDefaultDeny: true,
          secretProvider: 'development-local',
          secretProviderProduction: false,
          kmsProvider: 'local-memory',
          kmsProviderProduction: false,
          encryptionFormatVersion: 1,
          chunkedEncryptionFormatVersion: 1,
        },
        checks: expect.arrayContaining([
          {
            name: 'runtimeIsolation',
            status: 'ready',
            code: 'DEVELOPMENT_RUNTIME_ONLY',
          },
          {
            name: 'kms',
            status: 'ready',
            code: 'DEVELOPMENT_KMS_ONLY',
          },
          { name: 'encryption', status: 'ready', code: null },
        ]),
      })
      expect(JSON.stringify(ready.json())).not.toMatch(
        /api[_-]?key|bearer|secret-value|credential-value/i,
      )
      for (const [name, path] of [
        ['database', databaseRoot],
        ['artifacts', artifactRoot],
        ['workspace', workspace],
      ] as const) {
        const unavailable = `${path}.unavailable`
        renameSync(path, unavailable)
        const failed = await instance.inject({
          method: 'GET',
          url: '/readyz',
          headers,
        })
        expect(failed.statusCode).toBe(503)
        expect(failed.json().checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name, status: 'failed' }),
          ]),
        )
        expect(JSON.stringify(failed.json())).not.toContain(path)
        renameSync(unavailable, path)
        const recovered = await instance.inject({
          method: 'GET',
          url: '/readyz',
          headers,
        })
        expect(recovered.statusCode).toBe(200)
        expect(recovered.json()).toMatchObject({ status: 'ready' })
      }
      const metrics = (
        await instance.inject({ method: 'GET', url: '/metrics', headers })
      ).json()
      expect(metrics.generatedAt).toBe('2026-07-15T09:00:00.000Z')
      expect(
        JSON.stringify(
          metrics.series.map((item: { labels: unknown }) => item.labels),
        ),
      ).not.toMatch(/ten_test|wsp_test|sessionId|prompt|path|credential/)
    } finally {
      await instance.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('produces ordered audit chains through real control-plane flows and survives reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp11-audit-flow-'))
    const repository = join(directory, 'workspace')
    mkdirSync(repository)
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'audit@example.invalid'], {
      cwd: repository,
    })
    execFileSync('git', ['config', 'user.name', 'Audit Fixture'], {
      cwd: repository,
    })
    writeFileSync(join(repository, 'tracked.txt'), 'before\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repository })
    const databasePath = join(directory, 'events.sqlite')
    class AuditFlowClient extends FakeRuntimeClient {
      override async request<TResult>(
        method: string,
        params: unknown,
      ): Promise<TResult> {
        if (method === 'turn/start') {
          this.requests.push(method)
          this.turnStartCalls += 1
          return {
            turn: {
              id: this.fixture.turnId,
              status: 'inProgress',
              items: [],
              error: null,
            },
          } as TResult
        }
        return super.request(method, params)
      }
    }
    const client = new AuditFlowClient()
    const scopedHeaders = {
      'x-tenant-id': 'ten_audit_flow',
      'x-workspace-id': 'wsp_audit_flow',
    }
    const build = () =>
      buildControlPlane({
        databasePath,
        artifactRoot: join(directory, 'artifacts'),
        codexHomeRoot: join(directory, 'homes'),
        workspaceCwd: repository,
        runtimeClientFactory: () => client,
        runtimeInstanceIdFactory: () => 'runtime_audit_flow',
        sessionIdFactory: () => 'ses_audit_flow',
      })
    let first = await build()
    try {
      const created = await first.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: scopedHeaders,
        payload: {},
      })
      expect(created.statusCode).toBe(201)
      writeFileSync(join(repository, 'tracked.txt'), 'after\n')
      const turn = await first.inject({
        method: 'POST',
        url: '/v1/sessions/ses_audit_flow/turns',
        headers: { ...scopedHeaders, 'idempotency-key': 'audit-turn' },
        payload: { prompt: 'sensitive fixture prompt' },
      })
      expect(turn.statusCode).toBe(202)
      client.emitNotification({
        method: 'turn/started',
        params: {
          threadId: client.fixture.threadId,
          turn: {
            id: client.fixture.turnId,
            status: 'inProgress',
            items: [],
            error: null,
          },
        },
      })
      client.emitServerRequest({
        id: 707,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: client.fixture.threadId,
          turnId: client.fixture.turnId,
          itemId: 'cmd_audit_flow',
          startedAtMs: 1,
          approvalId: null,
          environmentId: null,
          reason: 'fixture approval',
          command: 'echo fixture',
          cwd: '/workspace',
          commandActions: null,
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
        },
      })
      let approval: { approvalId: string; version: number } | undefined
      for (let attempt = 0; attempt < 50 && !approval; attempt++) {
        const pending = await first.inject({
          method: 'GET',
          url: '/v1/approvals?status=pending',
          headers: scopedHeaders,
        })
        approval = pending.json().approvals[0] as
          { approvalId: string; version: number } | undefined
        if (!approval) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(approval).toBeDefined()
      const durableApproval = approval as {
        approvalId: string
        version: number
      }
      const decisions = await Promise.all([
        first.inject({
          method: 'POST',
          url: `/v1/approvals/${durableApproval.approvalId}/decision`,
          headers: { ...scopedHeaders, 'idempotency-key': 'audit-decision-a' },
          payload: {
            decision: 'accept',
            expectedVersion: durableApproval.version,
          },
        }),
        first.inject({
          method: 'POST',
          url: `/v1/approvals/${durableApproval.approvalId}/decision`,
          headers: { ...scopedHeaders, 'idempotency-key': 'audit-decision-b' },
          payload: {
            decision: 'decline',
            expectedVersion: durableApproval.version,
          },
        }),
      ])
      expect(decisions.map((reply) => reply.statusCode).sort()).toEqual([
        200, 409,
      ])
      client.emitNotification({
        method: 'turn/completed',
        params: {
          threadId: client.fixture.threadId,
          turn: {
            id: client.fixture.turnId,
            status: 'completed',
            items: [],
            error: null,
          },
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      const refresh = await first.inject({
        method: 'POST',
        url: '/v1/sessions/ses_audit_flow/git-snapshots/refresh',
        headers: { ...scopedHeaders, 'idempotency-key': 'audit-refresh' },
        payload: {},
      })
      expect(refresh.statusCode).toBe(200)
      const auditReply = await first.inject({
        method: 'GET',
        url: '/v1/sessions/ses_audit_flow/audit?limit=100',
        headers: scopedHeaders,
      })
      const records = [...auditReply.json().records].reverse() as Array<{
        action: string
        outcome: string
      }>
      const actions = records.map((record) => record.action)
      const assertSubsequence = (expected: string[]) => {
        let cursor = -1
        for (const action of expected) {
          cursor = actions.indexOf(action, cursor + 1)
          expect(
            cursor,
            `missing ordered audit action ${action}`,
          ).toBeGreaterThan(-1)
        }
      }
      assertSubsequence([
        'session.created',
        'session.lifecycle_changed',
        'turn.started',
        'turn.completed',
      ])
      assertSubsequence(['approval.requested', 'approval.decided'])
      assertSubsequence(['turn.started', 'git.snapshot_refreshed'])
      expect(
        records.filter(
          (record) =>
            record.action === 'approval.decided' &&
            record.outcome === 'success',
        ),
      ).toHaveLength(1)
      expect(JSON.stringify(records)).not.toMatch(
        /sensitive fixture prompt|model output|reasoning|command output|diff --git|credential|Bearer|\/Users\//i,
      )
      const beforeReopen = JSON.stringify(records)
      await first.close()
      first = await build()
      const reopened = await first.inject({
        method: 'GET',
        url: '/v1/sessions/ses_audit_flow/audit?limit=100',
        headers: scopedHeaders,
      })
      expect(JSON.stringify([...reopened.json().records].reverse())).toBe(
        beforeReopen,
      )
    } finally {
      await first.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('WP9 auth readiness and recovery', () => {
  it('blocks session creation before thread/start when account setup is required', async () => {
    class LoggedOutClient extends FakeRuntimeClient {
      override async request<TResult>(
        method: string,
        params: unknown,
      ): Promise<TResult> {
        if (method === 'account/read') {
          this.requests.push(method)
          return { account: null, requiresOpenaiAuth: true } as TResult
        }
        return super.request(method, params)
      }
    }
    const client = new LoggedOutClient()
    const instance = await buildControlPlane({
      runtimeClientFactory: () => client,
    })
    try {
      const [readiness, concurrent] = await Promise.all([
        instance.inject({ method: 'GET', url: '/readyz', headers }),
        instance.inject({ method: 'GET', url: '/readyz', headers }),
      ])
      expect(readiness.statusCode).toBe(503)
      expect(concurrent.statusCode).toBe(503)
      expect(readiness.json()).toMatchObject({
        status: 'setup_required',
        recovery: { code: 'AUTH_REQUIRED', instruction: 'codex login' },
      })
      const created = await instance.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers,
        payload: {},
      })
      expect(created.statusCode).toBe(401)
      expect(client.requests).not.toContain('thread/start')
      expect(
        client.requests.filter((method) => method === 'account/read'),
      ).toHaveLength(2)
    } finally {
      await instance.close()
    }
  })

  it('coalesces repeated 401 disconnects while retaining scoped raw evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp9-auth-'))
    const eventStore = new SqliteEventStore(join(directory, 'events.sqlite'))
    const client = new FakeRuntimeClient()
    const sessionId = 'ses_auth_recovery'
    const instance = await buildControlPlane({
      eventStore,
      artifactRoot: join(directory, 'artifacts'),
      codexHomeRoot: join(directory, 'homes'),
      sessionIdFactory: () => sessionId,
      runtimeClientFactory: () => client,
    })
    try {
      const created = await instance.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers,
        payload: {},
      })
      expect(created.statusCode).toBe(201)
      const notification = {
        method: 'error',
        params: {
          threadId: client.fixture.threadId,
          turnId: client.fixture.turnId,
          willRetry: true,
          error: {
            message: 'Reconnecting 1/5 with secret Bearer fixture-token',
            additionalDetails: 'private home /Users/example/.codex',
            codexErrorInfo: {
              responseStreamDisconnected: { httpStatusCode: 401 },
            },
          },
        },
      }
      client.emitNotification(notification)
      client.emitNotification({
        ...notification,
        params: {
          ...notification.params,
          error: { ...notification.params.error, message: 'Reconnecting 2/5' },
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const detail = await instance.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}`,
        headers,
      })
      expect(detail.json()).toMatchObject({
        codexThreadId: client.fixture.threadId,
        status: 'recovering',
        recoveryErrorCode: 'RECOVERY_AUTH_REQUIRED',
      })
      const events = eventStore.replaySessionEvents(
        { ...scope, sessionId },
        0,
        100,
      ).events
      const errors = events.filter((event) => event.type === 'error.reported')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({
        payload: {
          message:
            'Codex authentication is required. Run codex login, then retry.',
          willRetry: false,
          codexErrorInfo: 'unauthorized',
        },
      })
      expect(eventStore.getRecordCounts({ ...scope, sessionId })).toMatchObject(
        { rawEvents: 2, events: 1 },
      )
      expect(JSON.stringify(events)).not.toMatch(/fixture-token|Users\/example/)
      const evidence = new DatabaseSync(join(directory, 'events.sqlite'))
      const raw = evidence
        .prepare('SELECT inline_json FROM raw_events WHERE session_id = ?')
        .all(sessionId)
      evidence.close()
      expect(JSON.stringify(raw)).not.toMatch(/fixture-token|Users\/example/)
    } finally {
      await instance.close()
      eventStore.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps non-auth reconnects visible and resumes the same session after auth retry', async () => {
    class MutableAuthClient extends FakeRuntimeClient {
      accountReady = true
      override async request<TResult>(
        method: string,
        params: unknown,
      ): Promise<TResult> {
        if (method === 'account/read')
          return {
            account: this.accountReady ? { type: 'chatgpt' } : null,
            requiresOpenaiAuth: true,
          } as TResult
        return super.request(method, params)
      }
    }
    const directory = mkdtempSync(join(tmpdir(), 'wp9-retry-'))
    const eventStore = new SqliteEventStore(join(directory, 'events.sqlite'))
    const client = new MutableAuthClient()
    const sessionId = 'ses_retry_same'
    const instance = await buildControlPlane({
      eventStore,
      artifactRoot: join(directory, 'artifacts'),
      codexHomeRoot: join(directory, 'homes'),
      sessionIdFactory: () => sessionId,
      runtimeClientFactory: () => client,
    })
    const error = (status: number) => ({
      method: 'error',
      params: {
        threadId: client.fixture.threadId,
        turnId: client.fixture.turnId,
        willRetry: true,
        error: {
          message: `network ${status}`,
          additionalDetails: null,
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: status },
          },
        },
      },
    })
    try {
      expect(
        (
          await instance.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(201)
      client.emitNotification(error(502))
      client.emitNotification(error(502))
      await new Promise((resolve) => setTimeout(resolve, 15))
      expect(
        eventStore
          .replaySessionEvents({ ...scope, sessionId }, 0, 100)
          .events.filter((event) => event.type === 'error.reported'),
      ).toHaveLength(2)
      expect(eventStore.getSession({ ...scope, sessionId }).status).toBe(
        'active',
      )
      client.accountReady = false
      const blockedTurn = await instance.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/turns`,
        headers: { ...headers, 'idempotency-key': 'blocked-auth-turn' },
        payload: { prompt: 'must not reach upstream' },
      })
      expect(blockedTurn.statusCode).toBe(401)
      expect(client.turnStartCalls).toBe(0)
      client.emitNotification(error(401))
      await new Promise((resolve) => setTimeout(resolve, 15))
      expect(
        (
          await instance.inject({ method: 'GET', url: '/readyz', headers })
        ).json().status,
      ).toBe('setup_required')
      client.accountReady = true
      expect(
        (
          await instance.inject({
            method: 'GET',
            url: '/readyz',
            headers: { ...headers, 'x-readiness-retry': '1' },
          })
        ).json().status,
      ).toBe('ready')
      const resumed = await instance.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/resume`,
        headers: { ...headers, 'idempotency-key': 'auth-retry-resume' },
        payload: {},
      })
      expect(resumed.statusCode).toBe(200)
      expect(resumed.json()).toMatchObject({
        sessionId,
        codexThreadId: client.fixture.threadId,
        status: 'active',
      })
    } finally {
      await instance.close()
      eventStore.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function event(eventId: string): TimelineEvent {
  return {
    eventId,
    schemaVersion: 1,
    ...scope,
    sequence: 0,
    occurredAt: '2026-07-14T00:00:00.000Z',
    receivedAt: '2026-07-14T00:00:00.001Z',
    source: 'codex-app-server',
    sourceVersion: '0.144.2',
    sourceMethod: 'item/agentMessage/delta',
    type: 'agent.message.delta',
    visibility: 'user',
    payload: { text: eventId },
  }
}

describe('artifact API', () => {
  it('serves scoped metadata, ranges and opaque download grants', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'artifact-api-'))
    const store = new SqliteEventStore(join(directory, 'events.sqlite'))
    store.createSession(scope)
    const storage = new LocalArtifactStorage(join(directory, 'artifacts'))
    const artifactScope = { ...scope, turnId: 'turn_a', itemId: 'item_a' }
    const created = storage.create(artifactScope)
    storage.append({
      artifactId: created.artifactId,
      scope: artifactScope,
      chunkIndex: 0,
      stream: 'combined',
      data: 'hello secret sk-ABCDEFGHIJK done',
    })
    const final = storage.finalize(created.artifactId, artifactScope)
    store.upsertArtifact({ ...final })
    let clock = new Date('2026-07-16T12:00:00.000Z')
    const app = await buildControlPlane({
      eventStore: store,
      artifactRoot: join(directory, 'artifacts'),
      now: () => clock,
    })
    try {
      const metadata = await app.inject({
        method: 'GET',
        url: `/v1/artifacts/${created.artifactId}?metadata=1`,
        headers,
      })
      expect(metadata.statusCode).toBe(200)
      expect(metadata.json()).not.toHaveProperty('path')
      const range = await app.inject({
        method: 'GET',
        url: `/v1/artifacts/${created.artifactId}`,
        headers: { ...headers, range: 'bytes=0-4' },
      })
      expect(range.statusCode).toBe(206)
      expect(range.body).toBe('hello')
      expect(range.headers['content-range']).toBe(
        `bytes 0-4/${final.byteLength}`,
      )
      const denied = await app.inject({
        method: 'GET',
        url: `/v1/artifacts/${created.artifactId}`,
        headers: { ...headers, 'x-tenant-id': 'other' },
      })
      expect(denied.statusCode).toBe(404)
      const grant = await app.inject({
        method: 'POST',
        url: `/v1/artifacts/${created.artifactId}/download-token`,
        headers,
      })
      expect(grant.statusCode).toBe(200)
      const crossTenantGrant = await app.inject({
        method: 'POST',
        url: `/v1/artifacts/${created.artifactId}/download-token`,
        headers: {
          ...headers,
          'x-tenant-id': 'ten_b',
          'x-workspace-id': 'wsp_b',
        },
      })
      expect(crossTenantGrant.statusCode).toBe(404)
      const download = await app.inject({
        method: 'GET',
        url: grant.json().downloadUrl,
      })
      expect(download.statusCode).toBe(200)
      expect(download.body).not.toContain('ABCDEFGHIJK')
      expect(download.headers['content-disposition']).toContain('attachment')
      const replay = await app.inject({
        method: 'GET',
        url: grant.json().downloadUrl,
      })
      expect(replay.statusCode).toBe(404)
      const tampered = await app.inject({
        method: 'GET',
        url: `${grant.json().downloadUrl}x`,
      })
      expect(tampered.statusCode).toBe(404)

      const rangedGrant = await app.inject({
        method: 'POST',
        url: `/v1/artifacts/${created.artifactId}/download-token`,
        headers,
      })
      expect(
        (
          await app.inject({
            method: 'GET',
            url: rangedGrant.json().downloadUrl,
            headers: { range: 'bytes=0-4' },
          })
        ).statusCode,
      ).toBe(416)
      const expiringGrant = await app.inject({
        method: 'POST',
        url: `/v1/artifacts/${created.artifactId}/download-token`,
        headers,
      })
      clock = new Date(clock.getTime() + 61_000)
      expect(
        (
          await app.inject({
            method: 'GET',
            url: expiringGrant.json().downloadUrl,
          })
        ).statusCode,
      ).toBe(404)
    } finally {
      await app.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function ingest(store: SqliteEventStore, key: string): TimelineEvent {
  return store.ingest({
    ...scope,
    ingestKey: key,
    raw: {
      envelope: { method: 'item/agentMessage/delta', params: { delta: key } },
      checksum: `checksum-${key}`,
      sourceMethod: 'item/agentMessage/delta',
      sourceVersion: '0.144.2',
      receivedAt: '2026-07-14T00:00:00.001Z',
    },
    event: event(`evt_${key}`),
  }).event
}

describe('WP15 provider selection API', () => {
  it('persists a direct provider/model/effort snapshot and rejects unsupported effort before start', async () => {
    const catalog: ProviderModelCatalog = {
      schemaVersion: 1,
      identity: {
        provider: 'claude',
        adapter: 'fixture',
        adapterVersion: '1',
        upstreamVersion: 'fixture',
      },
      discoveredAt: '2026-07-15T00:00:00.000Z',
      models: [
        {
          provider: 'claude',
          modelId: 'claude-fixture',
          displayName: 'Claude fixture',
          hidden: false,
          isDefault: true,
          reasoningEfforts: ['none', 'medium'],
          defaultReasoningEffort: 'medium',
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
            usage: 'supported',
            cost: 'unsupported',
          },
        },
      ],
    }
    let starts = 0
    let titleCalls = 0
    const adapter: ProviderRuntimeAdapterV1 = {
      contractVersion: 1,
      identity: catalog.identity,
      discoverModelCatalog: async () => catalog,
      normalizeEvent: () => {
        throw new Error('not used')
      },
      interrupt: async () => undefined,
      resolveApproval: async () => {
        throw new Error('unsupported')
      },
      checkReadiness: async () => ({
        ready: true,
        version: 'fixture',
        authReady: true,
        authStatus: 'ready',
        code: 'ready',
        instruction: null,
      }),
      startTurn: async () => {
        starts += 1
        return {
          providerSessionId: 'claude-session',
          providerTurnId: 'claude-turn',
          outcome: 'completed',
        }
      },
    }
    const localStore = new SqliteEventStore()
    const localApp = await buildControlPlane({
      eventStore: localStore,
      runtimeClientFactory: () => new FakeRuntimeClient(),
      providerCatalogs: [catalog],
      providerAdapterFactory: () => adapter,
      titleGenerator: async ({ scope: titleScope }) => {
        titleCalls += 1
        return {
          title: 'İki Mesajlık Başlık',
          usage: {
            schemaVersion: 1,
            kind: 'cumulative',
            provider: 'codex',
            requestId: `title:${titleScope.sessionId}`,
            dedupeKey: `title:${titleScope.sessionId}:v1`,
            counters: {
              inputTokens: 3,
              cachedInputTokens: 0,
              outputTokens: 2,
              reasoningTokens: 0,
              toolUnits: 0,
            },
            completeness: 'complete',
            occurredAt: '2026-07-15T00:00:00.000Z',
          },
        }
      },
      sessionIdFactory: (() => {
        let id = 0
        return () => `ses_provider_${++id}`
      })(),
    })
    const localHeaders = {
      'x-tenant-id': 'ten_provider',
      'x-workspace-id': 'wsp_provider',
    }
    try {
      const invalid = await localApp.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: localHeaders,
        payload: {
          provider: 'claude',
          model: { modelId: 'claude-fixture', reasoningEffort: 'xhigh' },
        },
      })
      expect(invalid.statusCode).toBe(409)
      expect(invalid.json()).toMatchObject({
        code: 'REASONING_EFFORT_UNSUPPORTED',
      })
      expect(starts).toBe(0)

      const created = await localApp.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: localHeaders,
        payload: {
          provider: 'claude',
          model: { modelId: 'claude-fixture', reasoningEffort: 'none' },
        },
      })
      expect(created.statusCode).toBe(201)
      expect(created.json()).toMatchObject({
        provider: 'claude',
        resolvedModel: 'claude-fixture',
        reasoningEffort: 'none',
        requestedPolicy: { modelId: 'claude-fixture', reasoningEffort: 'none' },
      })
      expect(
        localStore.getSession({
          ...localHeaders,
          tenantId: localHeaders['x-tenant-id'],
          workspaceId: localHeaders['x-workspace-id'],
          sessionId: 'ses_provider_2',
        } as any),
      ).toMatchObject({
        provider: 'claude',
        resolvedModel: 'claude-fixture',
        reasoningEffort: 'none',
      })
      const sessionScope = {
        tenantId: localHeaders['x-tenant-id'],
        workspaceId: localHeaders['x-workspace-id'],
        sessionId: 'ses_provider_2',
      }
      expect(
        (
          await localApp.inject({
            method: 'POST',
            url: '/v1/sessions/ses_provider_2/turns',
            headers: {
              ...localHeaders,
              'idempotency-key': 'provider-turn-1',
            },
            payload: { prompt: 'İlk durable mesaj' },
          })
        ).statusCode,
      ).toBe(202)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(localStore.getSession(sessionScope).title).toBe('Yeni konuşma')
      expect(titleCalls).toBe(0)
      expect(
        (
          await localApp.inject({
            method: 'POST',
            url: '/v1/sessions/ses_provider_2/turns',
            headers: {
              ...localHeaders,
              'idempotency-key': 'provider-turn-2',
            },
            payload: { prompt: 'İkinci durable mesaj' },
          })
        ).statusCode,
      ).toBe(202)
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (localStore.getSession(sessionScope).title !== 'Yeni konuşma') break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(localStore.getSession(sessionScope).title).toBe(
        'İki Mesajlık Başlık',
      )
      expect(titleCalls).toBe(1)
      expect(localStore.getUsageSummary(sessionScope).counters).toMatchObject({
        inputTokens: 3,
        outputTokens: 2,
      })
      const catalogs = await localApp.inject({
        method: 'GET',
        url: '/v1/provider-catalogs',
        headers: localHeaders,
      })
      expect(catalogs.statusCode).toBe(200)
      expect(catalogs.json().catalogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identity: expect.objectContaining({ provider: 'claude' }),
          }),
        ]),
      )
    } finally {
      await localApp.close()
      localStore.close()
    }
  })

  it('exposes Cursor catalog/readiness and creates a Cursor conversation with honest capabilities', async () => {
    const cursorCatalog: ProviderModelCatalog = {
      schemaVersion: 1,
      identity: {
        provider: 'cursor',
        adapter: 'cursor-agent-stream-json',
        adapterVersion: '1',
        upstreamVersion: '2026.07.09-a3815c0',
      },
      discoveredAt: '2026-07-16T00:00:00.000Z',
      models: [
        {
          provider: 'cursor',
          modelId: 'cursor-fixture-model',
          displayName: 'Cursor fixture',
          hidden: false,
          isDefault: true,
          reasoningEfforts: ['none'],
          defaultReasoningEffort: 'none',
          inputModalities: ['text'],
          capabilities: {
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
        },
      ],
    }
    const adapter: ProviderRuntimeAdapterV1 = {
      contractVersion: 1,
      identity: cursorCatalog.identity,
      discoverModelCatalog: async () => cursorCatalog,
      normalizeEvent: () => {
        throw new Error('not used')
      },
      interrupt: async () => undefined,
      resolveApproval: async () => {
        throw new Error('unsupported')
      },
      checkReadiness: async () => ({
        ready: true,
        version: '2026.07.09-a3815c0',
        authReady: true,
        authStatus: 'ready',
        code: 'ready',
        instruction: null,
      }),
    }
    const localStore = new SqliteEventStore()
    const localApp = await buildControlPlane({
      eventStore: localStore,
      runtimeClientFactory: () => new FakeRuntimeClient(),
      providerCatalogs: [cursorCatalog],
      providerAdapterFactory: () => adapter,
      sessionIdFactory: () => 'ses_cursor_api',
    })
    const headers = {
      'x-tenant-id': 'ten_cursor',
      'x-workspace-id': 'wsp_cursor',
    }
    try {
      const catalogs = await localApp.inject({
        method: 'GET',
        url: '/v1/provider-catalogs',
        headers,
      })
      expect(catalogs.statusCode).toBe(200)
      expect(catalogs.json().catalogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identity: expect.objectContaining({ provider: 'cursor' }),
            models: expect.arrayContaining([
              expect.objectContaining({
                reasoningEfforts: ['none'],
                capabilities: expect.objectContaining({
                  approvals: 'unsupported',
                  reasoningSummary: 'unsupported',
                  usage: 'degraded',
                  cost: 'unsupported',
                }),
              }),
            ]),
          }),
        ]),
      )
      expect(catalogs.json().readiness).toMatchObject({
        cursor: { ready: true, authStatus: 'ready' },
      })
      const created = await localApp.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers,
        payload: {
          provider: 'cursor',
          model: {
            modelId: 'cursor-fixture-model',
            reasoningEffort: 'none',
          },
        },
      })
      expect(created.statusCode).toBe(201)
      expect(created.json()).toMatchObject({
        provider: 'cursor',
        resolvedModel: 'cursor-fixture-model',
        reasoningEffort: 'none',
        capabilitySnapshot: {
          fileChanges: 'degraded',
          approvals: 'unsupported',
        },
      })
    } finally {
      await localApp.close()
      localStore.close()
    }
  })
})

interface TestSocket {
  send(data: string): void
  close(): void
  on(event: 'message', listener: (data: { toString(): string }) => void): void
}

function messageReader(socket: TestSocket): { next(): Promise<ServerMessage> } {
  const queue: ServerMessage[] = []
  const waiters: Array<(message: ServerMessage) => void> = []
  socket.on('message', (data) => {
    const message = serverMessageSchema.parse(JSON.parse(data.toString()))
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else queue.push(message)
  })
  return {
    next() {
      const queued = queue.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for WebSocket message')),
          2_000,
        )
        waiters.push((message) => {
          clearTimeout(timeout)
          resolve(message)
        })
      })
    },
  }
}

let app: FastifyInstance | undefined
let store: SqliteEventStore | undefined
const sockets: TestSocket[] = []

async function setup(
  options: Omit<ControlPlaneOptions, 'eventStore'> = {},
): Promise<SqliteEventStore> {
  store = new SqliteEventStore()
  store.createSession(scope)
  app = await buildControlPlane({ eventStore: store, ...options })
  await app.ready()
  return store
}

class FakeRuntimeClient implements WorkspaceRuntimeClient {
  processGeneration = 1
  health: ProcessHealth = { state: 'stopped', restartAttempt: 0 }
  initializeCalls = 0
  turnStartCalls = 0
  failThreadStart = false
  snapshotTurns: unknown[] = []
  readonly requests: string[] = []
  readonly turnStartParams: unknown[] = []
  readonly responses: Array<{ id: string | number; result: unknown }> = []
  readonly #notifications = new Set<
    (message: Record<string, unknown>) => void
  >()
  readonly #serverRequests = new Set<
    (message: Record<string, unknown>) => void
  >()
  readonly #healthListeners = new Set<(health: ProcessHealth) => void>()
  readonly fixture: {
    threadId: string
    turnId: string
    itemId: string
    delta: string
    finalText: string
  }

  constructor(fixture: Partial<FakeRuntimeClient['fixture']> = {}) {
    this.fixture = {
      threadId: 'thr_live',
      turnId: 'turn_live',
      itemId: 'msg_live',
      delta: 'taslak',
      finalText: 'Yetkili final',
      ...fixture,
    }
  }

  async initialize() {
    this.initializeCalls += 1
    this.health = { state: 'ready', restartAttempt: 0 }
    return {}
  }

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    this.requests.push(method)
    if (method === 'account/read') {
      return {
        account: { type: 'chatgpt' },
        requiresOpenaiAuth: true,
      } as TResult
    }
    if (method === 'model/list') {
      return {
        data: [
          {
            id: 'fixture-default',
            model: 'fixture-default',
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: 'Fixture default',
            description: 'Control-plane test model',
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'none', description: 'None' },
              { reasoningEffort: 'medium', description: 'Medium' },
            ],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
          },
        ],
        nextCursor: null,
      } as TResult
    }
    if (method === 'thread/start') {
      if (this.failThreadStart) throw new Error('fixture thread failure')
      return { thread: { id: this.fixture.threadId } } as TResult
    }
    if (method === 'turn/start') {
      this.turnStartCalls += 1
      this.turnStartParams.push(params)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const input = params as { threadId: string }
      const identity = {
        threadId: input.threadId,
        turnId: this.fixture.turnId,
        itemId: this.fixture.itemId,
      }
      queueMicrotask(() => {
        this.emitNotification({
          method: 'turn/started',
          params: {
            threadId: input.threadId,
            turn: {
              id: this.fixture.turnId,
              status: 'inProgress',
              items: [],
              error: null,
            },
          },
        })
        this.emitNotification({
          method: 'item/agentMessage/delta',
          params: { ...identity, delta: this.fixture.delta },
        })
        this.emitNotification({
          method: 'item/completed',
          params: {
            threadId: input.threadId,
            turnId: this.fixture.turnId,
            item: {
              type: 'agentMessage',
              id: this.fixture.itemId,
              text: this.fixture.finalText,
              phase: null,
              memoryCitation: null,
            },
            completedAtMs: 1,
          },
        })
        this.emitNotification({
          method: 'future/notification',
          params: { threadId: input.threadId, value: true },
        })
        this.emitServerRequest({
          id: 77,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: input.threadId,
            turnId: this.fixture.turnId,
            itemId: 'cmd_live',
            startedAtMs: 1,
            approvalId: null,
            environmentId: null,
            reason: 'fixture approval',
            command: 'echo fixture',
            cwd: '/workspace',
            commandActions: null,
            proposedExecpolicyAmendment: null,
            proposedNetworkPolicyAmendments: null,
          },
        })
        this.emitNotification({
          method: 'turn/completed',
          params: {
            threadId: input.threadId,
            turn: {
              id: this.fixture.turnId,
              status: 'completed',
              items: [],
              error: null,
            },
          },
        })
      })
      return {
        turn: {
          id: this.fixture.turnId,
          status: 'inProgress',
          items: [],
          error: null,
        },
      } as TResult
    }
    if (method === 'thread/read' || method === 'thread/resume') {
      return {
        thread: {
          id: this.fixture.threadId,
          turns: this.snapshotTurns,
        },
      } as TResult
    }
    if (method === 'thread/archive' || method === 'thread/unarchive')
      return {} as TResult
    if (method === 'turn/steer') {
      return {
        turnId: (params as { expectedTurnId: string }).expectedTurnId,
      } as TResult
    }
    if (method === 'turn/interrupt') return {} as TResult
    throw new Error(`Unexpected method ${method}`)
  }

  onNotification(listener: (message: Record<string, unknown>) => void) {
    this.#notifications.add(listener)
    return () => this.#notifications.delete(listener)
  }

  onServerRequest(listener: (message: Record<string, unknown>) => void) {
    this.#serverRequests.add(listener)
    return () => this.#serverRequests.delete(listener)
  }

  onHealthChange(listener: (health: ProcessHealth) => void) {
    this.#healthListeners.add(listener)
    return () => this.#healthListeners.delete(listener)
  }

  respond(id: string | number, result: unknown) {
    this.responses.push({ id, result })
  }

  async stop() {
    this.health = { state: 'stopped', restartAttempt: 0 }
    this.emitHealth()
  }

  emitNotification(message: Record<string, unknown>) {
    for (const listener of this.#notifications) listener(message)
  }

  emitServerRequest(message: Record<string, unknown>) {
    for (const listener of this.#serverRequests) listener(message)
  }

  setHealth(
    state: ProcessHealth['state'],
    generation = this.processGeneration,
  ) {
    this.processGeneration = generation
    this.health = { state, restartAttempt: 0 }
    this.emitHealth()
  }

  private emitHealth() {
    for (const listener of this.#healthListeners) listener(this.health)
  }
}

describe('WP10 turn Git checkpoints', () => {
  it('links before/after snapshots, diff and HEAD to a file-changing turn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp10-turn-git-'))
    const repository = join(directory, 'repo')
    mkdirSync(repository)
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], {
      cwd: repository,
    })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    writeFileSync(join(repository, 'turn.txt'), 'before\n')
    execFileSync('git', ['add', 'turn.txt'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repository })
    class ChangingClient extends FakeRuntimeClient {
      override emitNotification(message: Record<string, unknown>) {
        if (message.method === 'turn/completed')
          writeFileSync(join(repository, 'turn.txt'), 'after\n')
        super.emitNotification(message)
      }
    }
    const client = new ChangingClient({ turnId: 'turn_git' })
    const store = new SqliteEventStore(join(directory, 'events.sqlite'))
    const localApp = await buildControlPlane({
      eventStore: store,
      workspaceCwd: repository,
      artifactRoot: join(directory, 'artifacts'),
      codexHomeRoot: join(directory, 'homes'),
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_git',
    })
    const localHeaders = {
      'x-tenant-id': 'ten_git',
      'x-workspace-id': 'wsp_git',
    }
    try {
      expect(
        (
          await localApp.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: localHeaders,
            payload: {},
          })
        ).statusCode,
      ).toBe(201)
      expect(
        (
          await localApp.inject({
            method: 'POST',
            url: '/v1/sessions/ses_git/turns',
            headers: { ...localHeaders, 'idempotency-key': 'turn-git' },
            payload: { prompt: 'turn.txt dosyasını değiştir' },
          })
        ).statusCode,
      ).toBe(202)
      for (let attempt = 0; attempt < 1_500; attempt++) {
        if (
          store.listGitSnapshots({
            tenantId: 'ten_git',
            workspaceId: 'wsp_git',
            sessionId: 'ses_git',
          }).length === 2
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const snapshots = store.listGitSnapshots({
        tenantId: 'ten_git',
        workspaceId: 'wsp_git',
        sessionId: 'ses_git',
      })
      expect(snapshots.map((item) => item.phase).sort()).toEqual([
        'after',
        'before',
      ])
      expect(snapshots.every((item) => item.turnId === 'turn_git')).toBe(true)
      expect(
        snapshots.every(
          (item) =>
            item.headOid ===
            execFileSync('git', ['rev-parse', 'HEAD'], {
              cwd: repository,
              encoding: 'utf8',
            }).trim(),
        ),
      ).toBe(true)
      expect(snapshots.find((item) => item.phase === 'before')?.clean).toBe(
        true,
      )
      expect(
        snapshots.find((item) => item.phase === 'after')?.diff.preview,
      ).toContain('+after')
    } finally {
      await localApp.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
})

async function connect(): Promise<{
  socket: TestSocket
  reader: ReturnType<typeof messageReader>
}> {
  if (!app) throw new Error('Control plane is not initialized')
  const socket = (await app.injectWS('/v1/realtime')) as unknown as TestSocket
  sockets.push(socket)
  return { socket, reader: messageReader(socket) }
}

function subscribe(socket: TestSocket, afterSequence = 0): void {
  socket.send(JSON.stringify({ type: 'subscribe', ...scope, afterSequence }))
}

async function waitForApprovals(expected: number, status = 'pending') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app!.inject({
      method: 'GET',
      url: `/v1/approvals?status=${status}`,
      headers,
    })
    const approvals = response.json().approvals as Array<
      Record<string, unknown>
    >
    if (approvals.length >= expected) return approvals
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${expected} ${status} approvals`)
}

function commandApproval(
  client: FakeRuntimeClient,
  id: string | number,
  itemId: string,
) {
  client.emitServerRequest({
    id,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: client.fixture.threadId,
      turnId: 'turn_approval',
      itemId,
      startedAtMs: 1,
      approvalId: null,
      environmentId: null,
      reason: 'Bearer secret-token-value',
      command: 'curl example.test',
      cwd: '/workspace',
      commandActions: [{ type: 'unknown', command: 'curl example.test' }],
      networkApprovalContext: { host: 'example.test', protocol: 'https' },
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
    },
  })
}

function fileApproval(
  client: FakeRuntimeClient,
  id: string | number,
  itemId: string,
  withDiff = true,
) {
  if (withDiff) {
    client.emitNotification({
      method: 'item/started',
      params: {
        threadId: client.fixture.threadId,
        turnId: 'turn_approval',
        startedAtMs: 1,
        item: {
          type: 'fileChange',
          id: itemId,
          status: 'inProgress',
          changes: [
            {
              path: 'src/safe.ts',
              kind: { type: 'update', move_path: null },
              diff: '@@ -1 +1 @@\n-old\n+new',
            },
          ],
        },
      },
    })
  }
  client.emitServerRequest({
    id,
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: client.fixture.threadId,
      turnId: 'turn_approval',
      itemId,
      startedAtMs: 2,
      reason: 'write required',
      grantRoot: '/workspace/src',
    },
  })
}

async function decide(
  approval: { approvalId: string; version: number },
  decision: string,
  key: string,
) {
  return app!.inject({
    method: 'POST',
    url: `/v1/approvals/${approval.approvalId}/decision`,
    headers: { ...headers, 'idempotency-key': key },
    payload: {
      decision,
      expectedVersion: approval.version,
      clientContext: { deviceId: key, reason: null },
    },
  })
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await app?.close()
  store?.close()
  app = undefined
  store = undefined
})

describe('control plane REST replay', () => {
  it('reports the pinned Codex protocol metadata', async () => {
    await setup()
    const response = await app!.inject({ method: 'GET', url: '/v1/meta' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      codexVersion: '0.144.2',
      transport: 'stdio-jsonl',
    })
  })

  it('returns an ordered limited replay with cursor metadata', async () => {
    const current = await setup()
    ingest(current, 'one')
    ingest(current, 'two')
    ingest(current, 'three')
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_test/events?after=1&limit=1',
      headers,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      highWaterSequence: 3,
      nextAfterSequence: 2,
      hasMore: true,
      events: [{ sequence: 2 }],
    })
  })

  it('returns explicit 4xx errors for invalid input and unknown scope', async () => {
    await setup()
    const invalidCursor = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_test/events?after=1x',
      headers,
    })
    expect(invalidCursor.statusCode).toBe(400)
    expect(invalidCursor.json()).toMatchObject({ code: 'INVALID_CURSOR' })

    const invalidLimit = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_test/events?limit=501',
      headers,
    })
    expect(invalidLimit.statusCode).toBe(400)
    expect(invalidLimit.json()).toMatchObject({ code: 'INVALID_LIMIT' })

    const missingScope = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_test/events',
    })
    expect(missingScope.statusCode).toBe(401)
    expect(missingScope.json()).toMatchObject({ code: 'AUTH_REQUIRED' })

    const unknownTenant = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_test/events',
      headers: { ...headers, 'x-tenant-id': 'ten_other' },
    })
    expect(unknownTenant.statusCode).toBe(404)
    expect(unknownTenant.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })
})

describe('durable approval API', () => {
  it('keeps approval pending until an idempotent decision sends one upstream response', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_approval',
    })
    const created = await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    expect(created.statusCode).toBe(201)
    client.emitServerRequest({
      id: 91,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: client.fixture.threadId,
        turnId: 'turn_approval',
        itemId: 'cmd_approval',
        startedAtMs: 1,
        approvalId: null,
        environmentId: null,
        reason: 'safe fixture',
        command: 'echo safe',
        cwd: '/workspace',
        commandActions: [],
        networkApprovalContext: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const pending = await app!.inject({
      method: 'GET',
      url: '/v1/approvals?status=pending',
      headers,
    })
    expect(pending.statusCode).toBe(200)
    const approval = pending.json().approvals[0]
    expect(approval).toMatchObject({
      status: 'pending',
      kind: 'command_execution',
      version: 1,
    })
    expect(client.responses).toHaveLength(0)
    const decision = {
      decision: 'accept_for_session',
      expectedVersion: 1,
      clientContext: { deviceId: 'device-1', reason: null },
    }
    const first = await app!.inject({
      method: 'POST',
      url: `/v1/approvals/${approval.approvalId}/decision`,
      headers: { ...headers, 'idempotency-key': 'decision-1' },
      payload: decision,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({
      status: 'resolved',
      selectedDecision: 'accept_for_session',
    })
    expect(client.responses).toEqual([
      { id: 91, result: { decision: 'acceptForSession' } },
    ])
    const retry = await app!.inject({
      method: 'POST',
      url: `/v1/approvals/${approval.approvalId}/decision`,
      headers: { ...headers, 'idempotency-key': 'decision-1' },
      payload: decision,
    })
    expect(retry.statusCode).toBe(200)
    expect(client.responses).toHaveLength(1)
    const conflict = await app!.inject({
      method: 'POST',
      url: `/v1/approvals/${approval.approvalId}/decision`,
      headers: { ...headers, 'idempotency-key': 'decision-1' },
      payload: { ...decision, decision: 'decline' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_HASH_CONFLICT' })
    const isolated = await app!.inject({
      method: 'GET',
      url: `/v1/approvals/${approval.approvalId}`,
      headers: { ...headers, 'x-tenant-id': 'other' },
    })
    expect(isolated.statusCode).toBe(404)
  })

  it('ingests generated file approval with scoped diff context and redacts command context', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_context',
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    commandApproval(client, 'command-context', 'cmd_context')
    fileApproval(client, 'file-context', 'file_context')
    fileApproval(client, 'file-unavailable', 'file_unavailable', false)
    const approvals = await waitForApprovals(3)
    const command = approvals.find(
      (approval) => approval.itemId === 'cmd_context',
    )!
    expect(command.context).toMatchObject({
      reason: '[REDACTED]',
      commandActions: [{ type: 'unknown', command: 'curl example.test' }],
      networkApprovalContext: { host: 'example.test', protocol: 'https' },
    })
    expect(JSON.stringify(command)).not.toContain('secret-token-value')
    const file = approvals.find(
      (approval) => approval.itemId === 'file_context',
    )!
    expect(file.context).toMatchObject({
      filePath: 'src/safe.ts',
      diffAvailable: true,
    })
    expect(String((file.context as Record<string, unknown>).diff)).toContain(
      '+new',
    )
    const unavailable = approvals.find(
      (approval) => approval.itemId === 'file_unavailable',
    )!
    expect(unavailable.context).toMatchObject({
      filePath: null,
      diff: null,
      diffAvailable: false,
    })
  })

  it('maps all four public decisions for command and file approvals', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_mapping',
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    const decisions = [
      'accept',
      'accept_for_session',
      'decline',
      'cancel',
    ] as const
    for (const [index, decision] of decisions.entries()) {
      commandApproval(client, `command-${index}`, `cmd_${index}`)
      fileApproval(client, `file-${index}`, `file_${index}`, false)
    }
    const approvals = await waitForApprovals(8)
    for (const [index, decision] of decisions.entries()) {
      for (const itemId of [`cmd_${index}`, `file_${index}`]) {
        const approval = approvals.find(
          (candidate) => candidate.itemId === itemId,
        )! as { approvalId: string; version: number }
        const response = await decide(approval, decision, `mapping-${itemId}`)
        expect(response.statusCode).toBe(200)
      }
    }
    expect(client.responses.map(({ result }) => result)).toEqual(
      decisions.flatMap((decision) =>
        Array(2).fill({
          decision:
            decision === 'accept_for_session' ? 'acceptForSession' : decision,
        }),
      ),
    )
  })

  it('allows one concurrent winner and sends exactly one response', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_race',
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    commandApproval(client, 201, 'cmd_race')
    const [approval] = (await waitForApprovals(1)) as unknown as Array<{
      approvalId: string
      version: number
    }>
    const [first, second] = await Promise.all([
      decide(approval!, 'accept', 'race-a'),
      decide(approval!, 'decline', 'race-b'),
    ])
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409])
    expect([first.json().code, second.json().code]).toContain(
      'APPROVAL_ALREADY_RESOLVED',
    )
    expect(client.responses).toHaveLength(1)
    const durableApproval = store!.getApproval(scope, approval!.approvalId)
    expect(
      store!
        .listAudit({ ...scope, sessionId: durableApproval.sessionId })
        .records.filter(
          (record) =>
            record.action === 'approval.decided' &&
            record.outcome === 'success',
        ),
    ).toHaveLength(1)
  })

  it('blocks stale runtime/generation and expires approvals on health failure and turn completion', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_lifecycle',
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    store!.ingest({
      ...scope,
      ingestKey: 'runtime-mismatch-approval',
      raw: {
        envelope: {
          id: 300,
          method: 'item/commandExecution/requestApproval',
          params: {},
        },
        checksum: 'runtime-mismatch-checksum',
        sourceMethod: 'item/commandExecution/requestApproval',
        sourceVersion: '0.144.2',
        receivedAt: '2026-07-14T00:00:00.001Z',
      },
      event: event('evt_runtime_mismatch'),
      approval: {
        ...scope,
        approvalId: 'apr_runtime_mismatch',
        turnId: 'turn_approval',
        itemId: 'cmd_runtime_mismatch',
        requestId: 300,
        runtimeInstanceId: 'different_runtime',
        processGeneration: 1,
        kind: 'command_execution',
        context: {},
        availableDecisions: ['decline'],
        requestedAt: '2026-07-14T00:00:00.000Z',
      },
    })
    const mismatch = await decide(
      { approvalId: 'apr_runtime_mismatch', version: 1 },
      'decline',
      'runtime-mismatch',
    )
    expect(mismatch.statusCode).toBe(409)
    expect(mismatch.json()).toMatchObject({
      code: 'APPROVAL_RUNTIME_UNAVAILABLE',
    })
    expect(client.responses).toHaveLength(0)

    commandApproval(client, 301, 'cmd_generation')
    let approvals = await waitForApprovals(1)
    client.setHealth('ready', 2)
    await waitForApprovals(1, 'expired')
    const stale = await decide(
      approvals[0] as never,
      'decline',
      'stale-generation',
    )
    expect(stale.statusCode).toBe(409)
    expect(client.responses).toHaveLength(0)

    commandApproval(client, 302, 'cmd_crash')
    await waitForApprovals(1)
    client.setHealth('failed', 2)
    expect(
      (await waitForApprovals(2, 'expired')).map((item) => item.itemId),
    ).toContain('cmd_crash')

    client.setHealth('ready', 2)
    commandApproval(client, 303, 'cmd_completion')
    await waitForApprovals(1)
    client.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: client.fixture.threadId,
        turn: {
          id: 'turn_approval',
          status: 'interrupted',
          items: [],
          error: null,
        },
      },
    })
    expect(
      (await waitForApprovals(1, 'superseded')).map((item) => item.itemId),
    ).toContain('cmd_completion')
    expect(client.responses).toHaveLength(0)
  })

  it('reconciles serverRequest/resolved without a second upstream response', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_resolved',
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    commandApproval(client, 401, 'cmd_resolved')
    const [approval] = (await waitForApprovals(1)) as unknown as Array<{
      approvalId: string
      version: number
    }>
    expect(
      (await decide(approval!, 'decline', 'resolved-decision')).statusCode,
    ).toBe(200)
    expect(client.responses).toHaveLength(1)
    client.emitNotification({
      method: 'serverRequest/resolved',
      params: { threadId: client.fixture.threadId, requestId: 401 },
    })
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const detail = await app!.inject({
        method: 'GET',
        url: `/v1/approvals/${approval!.approvalId}`,
        headers,
      })
      if (detail.json().upstreamResponseStatus === 'acknowledged') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const detail = await app!.inject({
      method: 'GET',
      url: `/v1/approvals/${approval!.approvalId}`,
      headers,
    })
    expect(detail.json()).toMatchObject({
      status: 'resolved',
      upstreamResponseStatus: 'acknowledged',
    })
    expect(client.responses).toHaveLength(1)
  })
})

describe('control plane WebSocket replay/live stream', () => {
  it('streams pending, resolving, and resolved approval lifecycle and supports REST reconciliation', async () => {
    const client = new FakeRuntimeClient()
    await setup({
      runtimeClientFactory: () => client,
      runtimeInstanceIdFactory: () => 'runtime_ws_approval',
      sessionIdFactory: () => scope.sessionId,
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {},
    })
    const { socket, reader } = await connect()
    subscribe(socket)
    await reader.next()
    await reader.next()
    commandApproval(client, 501, 'cmd_ws')
    let pendingMessage: ServerMessage | undefined
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const message = await reader.next()
      if (message.type === 'approval') {
        pendingMessage = message
        break
      }
    }
    expect(pendingMessage).toMatchObject({
      type: 'approval',
      approval: { status: 'pending' },
    })
    if (pendingMessage?.type !== 'approval')
      throw new Error('Pending approval message missing')
    const decisionPromise = decide(
      pendingMessage.approval,
      'decline',
      'ws-decision',
    )
    expect(await reader.next()).toMatchObject({
      type: 'approval',
      approval: { status: 'resolving' },
    })
    expect(await reader.next()).toMatchObject({
      type: 'approval',
      approval: { status: 'resolved' },
    })
    expect((await decisionPromise).statusCode).toBe(200)
    commandApproval(client, 502, 'cmd_ws_expired')
    let expiringPending: ServerMessage | undefined
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const message = await reader.next()
      if (
        message.type === 'approval' &&
        message.approval.itemId === 'cmd_ws_expired'
      ) {
        expiringPending = message
        break
      }
    }
    expect(expiringPending).toMatchObject({
      type: 'approval',
      approval: { itemId: 'cmd_ws_expired', status: 'pending' },
    })
    client.setHealth('failed')
    let expiredMessage: ServerMessage | undefined
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const message = await reader.next()
      if (message.type === 'approval') {
        expiredMessage = message
        break
      }
    }
    expect(expiredMessage).toMatchObject({
      type: 'approval',
      approval: { itemId: 'cmd_ws_expired', status: 'expired' },
    })
    socket.close()
    const reconciled = await app!.inject({
      method: 'GET',
      url: '/v1/approvals?status=resolved',
      headers,
    })
    expect(reconciled.json().approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'cmd_ws', status: 'resolved' }),
      ]),
    )
  })

  it('delivers a publish at the replay/live boundary without a gap or duplicate', async () => {
    const current = await setup()
    ingest(current, 'one')
    ingest(current, 'two')
    const { socket, reader } = await connect()
    subscribe(socket)

    const replay = await reader.next()
    expect(replay).toMatchObject({
      type: 'replay',
      highWaterSequence: 2,
      events: [{ sequence: 1 }, { sequence: 2 }],
    })
    ingest(current, 'during-replay')
    expect(await reader.next()).toMatchObject({
      type: 'subscribed',
      highWaterSequence: 2,
    })
    const live = await reader.next()
    expect(live).toMatchObject({ type: 'event', event: { sequence: 3 } })

    const delivered = [
      ...(replay.type === 'replay'
        ? replay.events.map(({ sequence }) => sequence)
        : []),
      ...(live.type === 'event' ? [live.event.sequence] : []),
    ]
    expect(delivered).toEqual([1, 2, 3])
    expect(new Set(delivered).size).toBe(delivered.length)
  })

  it('reconnects from the client cursor and returns only missing events', async () => {
    const current = await setup()
    ingest(current, 'one')
    ingest(current, 'two')
    ingest(current, 'three')
    const first = await connect()
    subscribe(first.socket, 1)
    const replay = await first.reader.next()
    expect(replay).toMatchObject({
      type: 'replay',
      events: [{ sequence: 2 }, { sequence: 3 }],
    })
    await first.reader.next()
    first.socket.close()

    ingest(current, 'four')
    const reconnect = await connect()
    subscribe(reconnect.socket, 3)
    expect(await reconnect.reader.next()).toMatchObject({
      type: 'replay',
      events: [{ sequence: 4 }],
    })
  })

  it('keeps a delayed turn running after WebSocket disconnect and replays its terminal output', async () => {
    class DelayedClient extends FakeRuntimeClient {
      override async request<TResult>(method: string, params: unknown) {
        if (method !== 'turn/start')
          return super.request<TResult>(method, params)
        this.requests.push(method)
        this.turnStartCalls += 1
        const threadId = (params as { threadId: string }).threadId
        setTimeout(() => {
          this.emitNotification({
            method: 'turn/started',
            params: {
              threadId,
              turn: {
                id: this.fixture.turnId,
                status: 'inProgress',
                items: [],
                error: null,
              },
            },
          })
          this.emitNotification({
            method: 'item/completed',
            params: {
              threadId,
              turnId: this.fixture.turnId,
              item: {
                type: 'agentMessage',
                id: this.fixture.itemId,
                text: 'detached completion',
                phase: null,
                memoryCitation: null,
              },
              completedAtMs: 1,
            },
          })
          this.emitNotification({
            method: 'thread/tokenUsage/updated',
            params: {
              threadId,
              turnId: this.fixture.turnId,
              tokenUsage: {
                total: {
                  totalTokens: 15,
                  inputTokens: 10,
                  cachedInputTokens: 2,
                  outputTokens: 5,
                  reasoningOutputTokens: 1,
                },
                last: {
                  totalTokens: 15,
                  inputTokens: 10,
                  cachedInputTokens: 2,
                  outputTokens: 5,
                  reasoningOutputTokens: 1,
                },
                modelContextWindow: 200000,
              },
            },
          })
          this.emitNotification({
            method: 'turn/completed',
            params: {
              threadId,
              turn: {
                id: this.fixture.turnId,
                status: 'completed',
                items: [],
                error: null,
              },
            },
          })
        }, 60)
        return {
          turn: {
            id: this.fixture.turnId,
            status: 'inProgress',
            items: [],
            error: null,
          },
        } as TResult
      }
    }
    const client = new DelayedClient({ turnId: 'turn_detached' })
    store = new SqliteEventStore()
    app = await buildControlPlane({
      eventStore: store,
      runtimeClientFactory: () => client,
      sessionIdFactory: () => scope.sessionId,
      runIdFactory: () => 'run_detached',
    })
    await app.ready()
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(201)
    const first = await connect()
    subscribe(first.socket)
    await first.reader.next()
    await first.reader.next()
    const accepted = await app!.inject({
      method: 'POST',
      url: `/v1/sessions/${scope.sessionId}/turns`,
      headers: { ...headers, 'idempotency-key': 'detached-start' },
      payload: { prompt: 'finish after disconnect' },
    })
    expect(accepted.statusCode).toBe(202)
    expect(accepted.json()).toMatchObject({
      runId: 'run_detached',
      codexTurnId: 'turn_detached',
    })
    first.socket.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.requests).not.toContain('turn/interrupt')
    const reconnect = await connect()
    subscribe(reconnect.socket)
    const replay = await reconnect.reader.next()
    expect(replay).toMatchObject({ type: 'replay' })
    if (replay.type !== 'replay') throw new Error('Replay was not delivered')
    expect(replay.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent.message.completed',
          codexTurnId: 'turn_detached',
          payload: { text: 'detached completion' },
        }),
        expect.objectContaining({
          type: 'turn.completed',
          codexTurnId: 'turn_detached',
          payload: { status: 'completed' },
        }),
      ]),
    )
    const detail = await app!.inject({
      method: 'GET',
      url: `/v1/sessions/${scope.sessionId}`,
      headers,
    })
    expect(detail.json()).toMatchObject({
      activeRun: null,
      latestRun: {
        runId: 'run_detached',
        turnId: 'turn_detached',
        terminalOutcome: 'completed',
      },
    })
    const usage = await app!.inject({
      method: 'GET',
      url: `/v1/sessions/${scope.sessionId}/turns/turn_detached/usage`,
      headers,
    })
    expect(usage.json()).toMatchObject({
      outcome: 'completed',
      completeness: 'partial',
      reconciliationStatus: 'unreconciled',
      counters: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningTokens: 1,
      },
    })
    reconnect.socket.close()
  })

  it('enforces monotonic, in-scope, non-ahead acknowledgements', async () => {
    const current = await setup()
    ingest(current, 'one')
    ingest(current, 'two')
    const { socket, reader } = await connect()
    subscribe(socket)
    await reader.next()
    await reader.next()

    socket.send(JSON.stringify({ type: 'ack', ...scope, sequence: 2 }))
    expect(await reader.next()).toMatchObject({ type: 'ack', sequence: 2 })

    socket.send(JSON.stringify({ type: 'ack', ...scope, sequence: 1 }))
    expect(await reader.next()).toMatchObject({
      type: 'error',
      code: 'ACK_REGRESSION',
    })

    socket.send(
      JSON.stringify({
        type: 'ack',
        ...scope,
        workspaceId: 'wsp_other',
        sequence: 2,
      }),
    )
    expect(await reader.next()).toMatchObject({
      type: 'error',
      code: 'ACK_SCOPE_MISMATCH',
    })

    socket.send(JSON.stringify({ type: 'ack', ...scope, sequence: 3 }))
    expect(await reader.next()).toMatchObject({
      type: 'error',
      code: 'ACK_AHEAD',
    })
  })

  it('rejects subscriptions outside the tenant/workspace/session scope', async () => {
    await setup()
    const { socket, reader } = await connect()
    socket.send(
      JSON.stringify({
        type: 'subscribe',
        ...scope,
        tenantId: 'ten_other',
        afterSequence: 0,
      }),
    )
    expect(await reader.next()).toMatchObject({
      type: 'error',
      code: 'SESSION_NOT_FOUND',
    })
  })
})

describe('WP4 session, turn and live event flow', () => {
  const liveHeaders = {
    'content-type': 'application/json',
    'x-tenant-id': 'ten_live',
    'x-workspace-id': 'wsp_live',
  }

  async function setupLive(
    client: FakeRuntimeClient,
    options: Pick<ControlPlaneOptions, 'attachmentRoot'> = {},
  ) {
    const current = await setup({
      workspaceCwd: '/server/configured/workspace',
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_live',
      ...options,
    })
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: liveHeaders,
      payload: {},
    })
    return { current, response }
  }

  it('streams a controlled 100 MiB command through adapter, SQLite and artifact metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp7-e2e-'))
    const client = new FakeRuntimeClient()
    const current = await setup({
      workspaceCwd: '/workspace',
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_live',
      artifactRoot: join(directory, 'artifacts'),
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: liveHeaders,
      payload: {},
    })
    const hash = createHash('sha256')
    const sourceBytes = 1024 * 1024
    for (let index = 0; index < 100; index++) {
      const chunk =
        `${String(index).padStart(4, '0')}:`.padEnd(sourceBytes - 1, 'x') + '\n'
      hash.update(chunk)
      client.emitNotification({
        method: 'item/commandExecution/outputDelta',
        params: {
          threadId: 'thr_live',
          turnId: 'turn_big',
          itemId: 'cmd_big',
          delta: chunk,
        },
      })
    }
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thr_live',
        turnId: 'turn_big',
        item: {
          type: 'commandExecution',
          id: 'cmd_big',
          command: 'big-output',
          cwd: '/workspace',
          processId: 'proc_big',
          source: 'agent',
          commandActions: [],
          status: 'completed',
          aggregatedOutput: '',
          exitCode: 0,
          durationMs: 1,
        },
        completedAtMs: 1,
      },
    })
    let artifact
    for (let attempt = 0; attempt < 1200; attempt++) {
      artifact = current.listArtifacts({
        tenantId: 'ten_live',
        workspaceId: 'wsp_live',
      })[0]
      if (artifact?.finalized) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (!artifact?.finalized)
      throw new Error(
        JSON.stringify({
          artifact,
          eventTypes: current
            .replaySessionEvents(
              {
                tenantId: 'ten_live',
                workspaceId: 'wsp_live',
                sessionId: 'ses_live',
              },
              0,
              500,
            )
            .events.map((event) => event.type),
        }),
      )
    expect(artifact).toMatchObject({
      finalized: true,
      status: 'finalized',
      byteLength: 100 * sourceBytes,
      sha256: hash.digest('hex'),
    })
    const events = current.replaySessionEvents(
      { tenantId: 'ten_live', workspaceId: 'wsp_live', sessionId: 'ses_live' },
      0,
      500,
    ).events
    expect(
      Math.max(
        ...events.map((event) => Buffer.byteLength(JSON.stringify(event))),
      ),
    ).toBeLessThan(70 * 1024)
    expect(events.at(-1)).toMatchObject({
      type: 'command.completed',
      payload: {
        output: {
          totalBytes: 100 * sourceBytes,
          artifact: { artifactId: artifact!.artifactId },
        },
      },
    })
    rmSync(directory, { recursive: true, force: true })
  }, 30_000)
  it('spills a completed-only 100 MiB snapshot without persisting it inline', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp7-completed-'))
    const client = new FakeRuntimeClient()
    const current = await setup({
      workspaceCwd: '/workspace',
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_live',
      artifactRoot: join(directory, 'artifacts'),
    })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: liveHeaders,
      payload: {},
    })
    const snapshot = 'y'.repeat(100 * 1024 * 1024)
    const expected = createHash('sha256').update(snapshot).digest('hex')
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thr_live',
        turnId: 'turn_snapshot',
        item: {
          type: 'commandExecution',
          id: 'cmd_snapshot',
          command: 'snapshot',
          cwd: '/workspace',
          processId: 'proc_snapshot',
          source: 'agent',
          commandActions: [],
          status: 'completed',
          aggregatedOutput: snapshot,
          exitCode: 0,
          durationMs: 1,
        },
        completedAtMs: 1,
      },
    })
    let artifact
    for (let attempt = 0; attempt < 1200; attempt++) {
      artifact = current.listArtifacts({
        tenantId: 'ten_live',
        workspaceId: 'wsp_live',
      })[0]
      if (artifact?.finalized) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(artifact).toMatchObject({
      byteLength: 100 * 1024 * 1024,
      sha256: expected,
      finalized: true,
    })
    const replay = current.replaySessionEvents(
      { tenantId: 'ten_live', workspaceId: 'wsp_live', sessionId: 'ses_live' },
      0,
      10,
    ).events
    expect(Buffer.byteLength(JSON.stringify(replay[0]))).toBeLessThan(70 * 1024)
    rmSync(directory, { recursive: true, force: true })
  }, 30_000)

  it('binds a created session to thread/start and records failures explicitly', async () => {
    const client = new FakeRuntimeClient()
    const { current, response } = await setupLive(client)

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      tenantId: 'ten_live',
      workspaceId: 'wsp_live',
      sessionId: 'ses_live',
      codexThreadId: 'thr_live',
      status: 'active',
    })
    expect(client.initializeCalls).toBe(1)
    expect(client.requests).toEqual([
      'account/read',
      'model/list',
      'thread/start',
    ])
    expect(
      current.getSession({
        tenantId: 'ten_live',
        workspaceId: 'wsp_live',
        sessionId: 'ses_live',
      }),
    ).toMatchObject({ codexThreadId: 'thr_live', status: 'active' })
  })

  it('returns a failed session state when thread/start fails', async () => {
    const client = new FakeRuntimeClient()
    client.failThreadStart = true
    const { current, response } = await setupLive(client)

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ code: 'SESSION_START_FAILED' })
    expect(
      current.getSession({
        tenantId: 'ten_live',
        workspaceId: 'wsp_live',
        sessionId: 'ses_live',
      }),
    ).toMatchObject({ codexThreadId: null, status: 'failed' })
  })

  it('coalesces concurrent idempotent turn requests and rejects hash conflicts', async () => {
    const client = new FakeRuntimeClient()
    await setupLive(client)
    const request = (prompt: string) =>
      app!.inject({
        method: 'POST',
        url: '/v1/sessions/ses_live/turns',
        headers: { ...liveHeaders, 'idempotency-key': 'idem-1' },
        payload: { prompt },
      })

    const [first, second] = await Promise.all([
      request('Merhaba'),
      request('Merhaba'),
    ])
    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(202)
    expect(second.json()).toEqual(first.json())
    expect(client.turnStartCalls).toBe(1)

    const replay = await request('Farklı gövde')
    expect(replay.statusCode).toBe(409)
    expect(replay.json()).toMatchObject({
      code: 'IDEMPOTENCY_HASH_CONFLICT',
    })
    expect(client.turnStartCalls).toBe(1)
  })

  it('preserves one active turn per workspace across different keys', async () => {
    const client = new FakeRuntimeClient()
    await setupLive(client)
    const request = (key: string) =>
      app!.inject({
        method: 'POST',
        url: '/v1/sessions/ses_live/turns',
        headers: { ...liveHeaders, 'idempotency-key': key },
        payload: { prompt: key },
      })

    const [first, competing] = await Promise.all([
      request('turn-a'),
      request('turn-b'),
    ])
    expect(first.statusCode).toBe(202)
    expect(competing.statusCode).toBe(409)
    expect(competing.json()).toMatchObject({ code: 'SESSION_TURN_ACTIVE' })
    expect(client.turnStartCalls).toBe(1)
  })

  it('resumes a persisted thread before the first turn after a control-plane restart', async () => {
    const firstClient = new FakeRuntimeClient({ threadId: 'thr_persisted' })
    const { current } = await setupLive(firstClient)
    await app!.close()

    const restartedClient = new FakeRuntimeClient({
      threadId: 'thr_persisted',
      turnId: 'turn_after_restart',
    })
    app = await buildControlPlane({
      eventStore: current,
      workspaceCwd: '/server/configured/workspace',
      runtimeClientFactory: () => restartedClient,
      sessionIdFactory: () => 'ses_unused',
    })
    await app.ready()

    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/sessions/ses_live/turns',
      headers: { ...liveHeaders, 'idempotency-key': 'after-restart' },
      payload: { prompt: 'Devam et' },
    })
    expect(accepted.statusCode).toBe(202)
    expect(accepted.json()).toMatchObject({
      codexThreadId: 'thr_persisted',
      codexTurnId: 'turn_after_restart',
    })
    expect(restartedClient.requests).toEqual([
      'account/read',
      'thread/read',
      'thread/resume',
      'turn/start',
    ])
  })

  it('reconciles a durable run after restart without submitting the prompt twice', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp14-run-recovery-'))
    const databasePath = join(directory, 'events.sqlite')
    class HoldingClient extends FakeRuntimeClient {
      override async request<TResult>(method: string, params: unknown) {
        if (method !== 'turn/start')
          return super.request<TResult>(method, params)
        this.requests.push(method)
        this.turnStartCalls += 1
        return {
          turn: {
            id: this.fixture.turnId,
            status: 'inProgress',
            items: [],
            error: null,
          },
        } as TResult
      }
    }
    const firstClient = new HoldingClient({
      threadId: 'thr_durable_restart',
      turnId: 'turn_durable_restart',
    })
    const firstStore = new SqliteEventStore(databasePath)
    const first = await buildControlPlane({
      eventStore: firstStore,
      runtimeClientFactory: () => firstClient,
      sessionIdFactory: () => 'ses_durable_restart',
      runIdFactory: () => 'run_durable_restart',
    })
    const scoped = {
      'x-tenant-id': 'ten_durable_restart',
      'x-workspace-id': 'wsp_durable_restart',
    }
    try {
      expect(
        (
          await first.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: scoped,
            payload: {},
          })
        ).statusCode,
      ).toBe(201)
      const accepted = await first.inject({
        method: 'POST',
        url: '/v1/sessions/ses_durable_restart/turns',
        headers: { ...scoped, 'idempotency-key': 'durable-start' },
        payload: { prompt: 'submit exactly once' },
      })
      expect(accepted.statusCode).toBe(202)
      expect(firstClient.turnStartCalls).toBe(1)
    } finally {
      await first.close()
      firstStore.close()
    }

    const recoveredClient = new FakeRuntimeClient({
      threadId: 'thr_durable_restart',
      turnId: 'turn_durable_restart',
    })
    recoveredClient.snapshotTurns = [
      {
        id: 'turn_durable_restart',
        status: 'completed',
        items: [
          {
            type: 'agentMessage',
            id: 'msg_recovered',
            text: 'recovered output',
            phase: null,
            memoryCitation: null,
          },
        ],
        itemsView: 'full',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    ]
    const recoveredStore = new SqliteEventStore(databasePath)
    const recovered = await buildControlPlane({
      eventStore: recoveredStore,
      runtimeClientFactory: () => recoveredClient,
    })
    try {
      expect(
        recoveredStore.getSession({
          tenantId: scoped['x-tenant-id'],
          workspaceId: scoped['x-workspace-id'],
          sessionId: 'ses_durable_restart',
        }).runtimeGeneration,
      ).toBe(recoveredClient.processGeneration)
      expect(
        (
          await recovered.inject({
            method: 'GET',
            url: '/readyz',
            headers: scoped,
          })
        ).statusCode,
      ).toBe(200)
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          recoveredStore.getActiveDurableRun({
            tenantId: scoped['x-tenant-id'],
            workspaceId: scoped['x-workspace-id'],
            sessionId: 'ses_durable_restart',
          }) === null
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const reconciled = await recovered.inject({
        method: 'GET',
        url: '/v1/sessions/ses_durable_restart',
        headers: scoped,
      })
      expect(reconciled.statusCode).toBe(200)
      expect(reconciled.json()).toMatchObject({
        activeRun: null,
        latestRun: {
          runId: 'run_durable_restart',
          turnId: 'turn_durable_restart',
          terminalOutcome: 'completed',
        },
      })
      expect(recoveredClient.turnStartCalls).toBe(0)
      expect(
        recoveredStore
          .replaySessionEvents(
            {
              tenantId: 'ten_durable_restart',
              workspaceId: 'wsp_durable_restart',
              sessionId: 'ses_durable_restart',
            },
            0,
            100,
          )
          .events.filter((event) => event.type === 'turn.completed'),
      ).toHaveLength(1)
    } finally {
      await recovered.close()
      recoveredStore.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('moves a session to recovery_required when its bound thread is missing', async () => {
    class MissingThreadClient extends FakeRuntimeClient {
      override async request<TResult>(
        method: string,
        params: unknown,
      ): Promise<TResult> {
        if (method === 'turn/start')
          throw new Error(`thread not found: ${this.fixture.threadId}`)
        return super.request(method, params)
      }
    }
    const client = new MissingThreadClient({ threadId: 'thr_missing' })
    await setupLive(client)

    const failed = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_live/turns',
      headers: { ...liveHeaders, 'idempotency-key': 'missing-thread' },
      payload: { prompt: 'Devam et' },
    })
    expect(failed.statusCode).toBe(409)
    expect(failed.json()).toEqual({
      code: 'THREAD_NOT_RESUMABLE',
      message: 'The bound Codex thread cannot be read from this workspace home',
    })

    const detail = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_live',
      headers: liveHeaders,
    })
    expect(detail.json()).toMatchObject({
      codexThreadId: 'thr_missing',
      status: 'recovery_required',
      recoveryErrorCode: 'THREAD_NOT_RESUMABLE',
      recoveryOptions: ['retry_resume', 'start_new_session', 'view_read_only'],
    })
  })

  it('rebinds a pristine conversation when its empty Codex thread was not persisted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pristine-thread-rebind-'))
    const databasePath = join(directory, 'events.sqlite')
    const scoped = {
      'x-tenant-id': 'ten_pristine_rebind',
      'x-workspace-id': 'wsp_pristine_rebind',
    }
    const firstStore = new SqliteEventStore(databasePath)
    const firstClient = new FakeRuntimeClient({ threadId: 'thr_unpersisted' })
    const first = await buildControlPlane({
      eventStore: firstStore,
      runtimeClientFactory: () => firstClient,
      sessionIdFactory: () => 'ses_pristine_rebind',
    })
    try {
      const created = await first.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: scoped,
        payload: {},
      })
      expect(created.statusCode).toBe(201)
      expect(created.json()).toMatchObject({
        codexThreadId: 'thr_unpersisted',
        status: 'active',
      })
    } finally {
      await first.close()
      firstStore.close()
    }

    class UnloadedThreadClient extends FakeRuntimeClient {
      override async request<TResult>(method: string, params: unknown) {
        if (method === 'thread/read')
          throw new Error('thread not loaded: thr_unpersisted')
        return super.request<TResult>(method, params)
      }
    }
    const recoveredStore = new SqliteEventStore(databasePath)
    const recoveredClient = new UnloadedThreadClient({
      threadId: 'thr_recreated',
    })
    const recovered = await buildControlPlane({
      eventStore: recoveredStore,
      runtimeClientFactory: () => recoveredClient,
    })
    try {
      const resumed = await recovered.inject({
        method: 'POST',
        url: '/v1/sessions/ses_pristine_rebind/resume',
        headers: { ...scoped, 'idempotency-key': 'recover-pristine-thread' },
        payload: {},
      })
      expect(resumed.statusCode).toBe(200)
      expect(resumed.json()).toMatchObject({
        codexThreadId: 'thr_recreated',
        status: 'active',
        recoveryErrorCode: null,
      })
      expect(recoveredClient.requests).toContain('thread/start')
    } finally {
      await recovered.close()
      recoveredStore.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('persists fake notifications and approval requests before publishing live events', async () => {
    const client = new FakeRuntimeClient()
    const { current } = await setupLive(client)
    const socket = (await app!.injectWS(
      '/v1/realtime',
    )) as unknown as TestSocket
    sockets.push(socket)
    const reader = messageReader(socket)
    const liveScope = {
      tenantId: 'ten_live',
      workspaceId: 'wsp_live',
      sessionId: 'ses_live',
    }
    socket.send(
      JSON.stringify({ type: 'subscribe', ...liveScope, afterSequence: 0 }),
    )
    expect(await reader.next()).toMatchObject({ type: 'replay', events: [] })
    expect(await reader.next()).toMatchObject({ type: 'subscribed' })

    const turn = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_live/turns',
      headers: { ...liveHeaders, 'idempotency-key': 'idem-live' },
      payload: { prompt: 'Kısa cevap' },
    })
    expect(turn.statusCode).toBe(202)

    const delivered: TimelineEvent[] = []
    while (delivered.length < 6) {
      const message = await reader.next()
      if (message.type === 'event') delivered.push(message.event)
    }
    expect(delivered.map((entry) => entry.type)).toEqual([
      'turn.started',
      'agent.message.delta',
      'agent.message.completed',
      'codex.unknown',
      'approval.requested',
      'turn.completed',
    ])
    expect(current.getRecordCounts(liveScope)).toEqual({
      rawEvents: 6,
      events: 6,
      workspaceSequence: 6,
    })
    expect(client.requests).toEqual([
      'account/read',
      'model/list',
      'thread/start',
      'account/read',
      'turn/start',
    ])
    expect(delivered[2]).toMatchObject({
      type: 'agent.message.completed',
      payload: { text: 'Yetkili final' },
    })
  })

  it('uploads a scoped attachment and sends its canonical local path to Codex', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'attachment-api-'))
    const client = new FakeRuntimeClient()
    await setupLive(client, { attachmentRoot: directory })
    const upload = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_live/attachments',
      headers: {
        ...liveHeaders,
        'content-type': 'application/octet-stream',
        'x-attachment-name': encodeURIComponent('fixture.png'),
        'x-attachment-media-type': 'image/png',
      },
      payload: Buffer.from([0, 1, 2, 3]),
    })
    expect(upload.statusCode).toBe(201)
    const attachment = upload.json()
    expect(attachment).toMatchObject({
      name: 'fixture.png',
      mediaType: 'image/png',
      kind: 'image',
      byteLength: 4,
    })

    const turn = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_live/turns',
      headers: { ...liveHeaders, 'idempotency-key': 'idem-attachment' },
      payload: {
        prompt: 'Bu görseli incele',
        attachmentIds: [attachment.attachmentId],
      },
    })
    expect(turn.statusCode).toBe(202)
    expect(client.turnStartParams.at(-1)).toMatchObject({
      input: [
        { type: 'text', text: 'Bu görseli incele' },
        { type: 'localImage', path: expect.stringMatching(/fixture\.png$/) },
      ],
    })
  })

  it('sends a file mention using a canonical path with its original extension', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'file-attachment-api-'))
    const client = new FakeRuntimeClient()
    await setupLive(client, { attachmentRoot: directory })
    const upload = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_live/attachments',
      headers: {
        ...liveHeaders,
        'content-type': 'application/octet-stream',
        'x-attachment-name': encodeURIComponent('document.pdf'),
        'x-attachment-media-type': 'application/pdf',
      },
      payload: Buffer.from('%PDF-1.5 fixture'),
    })
    expect(upload.statusCode).toBe(201)

    const turn = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_live/turns',
      headers: { ...liveHeaders, 'idempotency-key': 'idem-pdf-attachment' },
      payload: {
        prompt: 'Bu belgeyi incele',
        attachmentIds: [upload.json().attachmentId],
      },
    })
    expect(turn.statusCode).toBe(202)
    expect(client.turnStartParams.at(-1)).toMatchObject({
      input: [
        {
          type: 'text',
          text: expect.stringMatching(
            /^Bu belgeyi incele[\s\S]*<persistent-codex-attachments>[\s\S]*document\.pdf[\s\S]*<\/persistent-codex-attachments>$/,
          ),
        },
        {
          type: 'mention',
          name: 'document.pdf',
          path: expect.stringMatching(/document\.pdf$/),
        },
      ],
    })
  })

  it('accepts more than five attachments in one turn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'many-attachment-api-'))
    const client = new FakeRuntimeClient()
    await setupLive(client, { attachmentRoot: directory })
    const uploads = await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const upload = await app!.inject({
          method: 'POST',
          url: '/v1/sessions/ses_live/attachments',
          headers: {
            ...liveHeaders,
            'content-type': 'application/octet-stream',
            'x-attachment-name': encodeURIComponent(`document-${index}.txt`),
            'x-attachment-media-type': 'text/plain',
          },
          payload: Buffer.from(`fixture ${index}`),
        })
        expect(upload.statusCode).toBe(201)
        return upload.json()
      }),
    )

    const turn = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_live/turns',
      headers: { ...liveHeaders, 'idempotency-key': 'idem-many-attachments' },
      payload: {
        prompt: 'Bu belgeleri incele',
        attachmentIds: uploads.map((attachment) => attachment.attachmentId),
      },
    })

    expect(turn.statusCode).toBe(202)
    const input = (client.turnStartParams.at(-1) as { input: unknown[] }).input
    expect(input).toHaveLength(11)
    expect(input.slice(1)).toEqual(
      uploads.map((attachment) =>
        expect.objectContaining({
          type: 'mention',
          name: attachment.name,
        }),
      ),
    )
  })

  it('rejects turn access from another tenant or workspace', async () => {
    const client = new FakeRuntimeClient()
    await setupLive(client)
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_live/turns',
      headers: {
        ...liveHeaders,
        'x-tenant-id': 'ten_other',
        'idempotency-key': 'idem-scope',
      },
      payload: { prompt: 'test' },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' })
    expect(client.turnStartCalls).toBe(0)
  })
})

describe('WP6 session resume and recovery', () => {
  it('reads before resuming, coalesces concurrent calls, and keeps the same thread', async () => {
    const client = new FakeRuntimeClient({ threadId: 'thr_resume' })
    await setup({
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_resume',
      runtimeInstanceIdFactory: () => 'runtime_resume',
    })
    const scoped = {
      'x-tenant-id': 'ten_resume',
      'x-workspace-id': 'wsp_resume',
    }
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: scoped,
          payload: {},
        })
      ).statusCode,
    ).toBe(201)
    client.requests.length = 0
    const [first, second] = await Promise.all([
      app!.inject({
        method: 'POST',
        url: '/v1/sessions/ses_resume/resume',
        headers: { ...scoped, 'idempotency-key': 'resume-key' },
        payload: {},
      }),
      app!.inject({
        method: 'POST',
        url: '/v1/sessions/ses_resume/resume',
        headers: { ...scoped, 'idempotency-key': 'resume-key' },
        payload: {},
      }),
    ])
    expect([first.statusCode, second.statusCode]).toEqual([200, 200])
    expect(client.requests).toEqual(['thread/read', 'thread/resume'])
    expect(first.json()).toMatchObject({
      codexThreadId: 'thr_resume',
      status: 'active',
      runtimeConnected: true,
    })
  })

  it('durably exposes THREAD_NOT_RESUMABLE without replacing a thread that has history', async () => {
    class BrokenResumeClient extends FakeRuntimeClient {
      override async request<TResult>(
        method: string,
        params: unknown,
      ): Promise<TResult> {
        if (method === 'thread/read') throw new Error('rollout corrupt')
        return super.request(method, params)
      }
    }
    const client = new BrokenResumeClient({ threadId: 'thr_broken' })
    const current = await setup({
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_broken',
    })
    const scoped = {
      'x-tenant-id': 'ten_broken',
      'x-workspace-id': 'wsp_broken',
    }
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: scoped,
      payload: {},
    })
    current.recordDurableUserMessage({
      tenantId: 'ten_broken',
      workspaceId: 'wsp_broken',
      sessionId: 'ses_broken',
      messageId: 'msg_broken_history',
      idempotencyKey: 'broken-history',
      content: 'Korunması gereken mevcut sohbet geçmişi',
    })
    const failed = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_broken/resume',
      headers: { ...scoped, 'idempotency-key': 'broken-key' },
      payload: {},
    })
    expect(failed.statusCode).toBe(409)
    expect(failed.json()).toMatchObject({ code: 'THREAD_NOT_RESUMABLE' })
    const detail = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_broken',
      headers: scoped,
    })
    expect(detail.json()).toMatchObject({
      codexThreadId: 'thr_broken',
      status: 'recovery_required',
      recoveryErrorCode: 'THREAD_NOT_RESUMABLE',
      recoveryOptions: ['retry_resume', 'start_new_session', 'view_read_only'],
    })
  })

  it('reconciles completed snapshot items and terminal turns without duplicates', async () => {
    const client = new FakeRuntimeClient({ threadId: 'thr_snapshot' })
    client.snapshotTurns = [
      {
        id: 'turn_snapshot',
        status: 'completed',
        items: [
          {
            type: 'agentMessage',
            id: 'msg_snapshot',
            text: 'snapshot authoritative final',
            phase: null,
            memoryCitation: null,
          },
        ],
        itemsView: 'full',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
      },
    ]
    await setup({
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_snapshot',
    })
    const scoped = {
      'x-tenant-id': 'ten_snapshot',
      'x-workspace-id': 'wsp_snapshot',
    }
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: scoped,
      payload: {},
    })
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thr_snapshot',
        turnId: 'turn_snapshot',
        item: {
          type: 'agentMessage',
          id: 'msg_live_original',
          text: 'snapshot authoritative final',
          phase: null,
          memoryCitation: null,
        },
        completedAtMs: 2_000,
      },
    })
    client.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thr_snapshot',
        turn: client.snapshotTurns[0],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    for (const key of ['snapshot-a', 'snapshot-b']) {
      expect(
        (
          await app!.inject({
            method: 'POST',
            url: '/v1/sessions/ses_snapshot/resume',
            headers: { ...scoped, 'idempotency-key': key },
            payload: {},
          })
        ).statusCode,
      ).toBe(200)
    }
    const replay = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_snapshot/events?after=0&limit=100',
      headers: scoped,
    })
    expect(replay.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent.message.completed',
          payload: { text: 'snapshot authoritative final' },
        }),
        expect.objectContaining({ type: 'turn.completed' }),
      ]),
    )
    expect(replay.json().events).toHaveLength(2)
  })

  it('keeps transient recovery failures retryable and distinct', async () => {
    class TransientClient extends FakeRuntimeClient {
      readFailures = 1
      override async request<TResult>(
        method: string,
        params: unknown,
      ): Promise<TResult> {
        if (method === 'thread/read' && this.readFailures-- > 0)
          throw new Error('temporary upstream')
        return super.request(method, params)
      }
    }
    await setup({
      runtimeClientFactory: () => new TransientClient(),
      sessionIdFactory: () => 'ses_transient',
    })
    const scoped = {
      'x-tenant-id': 'ten_transient',
      'x-workspace-id': 'wsp_transient',
    }
    await app!.inject({ method: 'POST', url: '/v1/sessions', headers: scoped })
    const failed = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_transient/resume',
      headers: { ...scoped, 'idempotency-key': 'transient' },
    })
    expect(failed.statusCode).toBe(502)
    expect(failed.json()).toMatchObject({ code: 'RECOVERY_TRANSIENT_FAILURE' })
    const detail = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_transient',
      headers: scoped,
    })
    expect(detail.json()).toMatchObject({
      status: 'recovering',
      recoveryOptions: ['retry_resume', 'view_read_only'],
    })
    const retried = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_transient/resume',
      headers: { ...scoped, 'idempotency-key': 'transient-retry' },
    })
    expect(retried.statusCode).toBe(200)
    const audit = await app!.inject({
      method: 'GET',
      url: '/v1/sessions/ses_transient/audit?limit=100',
      headers: scoped,
    })
    const actions = [...audit.json().records]
      .reverse()
      .map((record: { action: string }) => record.action)
    expect(
      actions.filter((action) => action === 'recovery.started'),
    ).toHaveLength(2)
    const failureIndex = actions.indexOf('recovery.failed')
    expect(failureIndex).toBeGreaterThan(actions.indexOf('recovery.started'))
    expect(actions.lastIndexOf('recovery.started')).toBeGreaterThan(
      failureIndex,
    )
    expect(actions.indexOf('recovery.completed')).toBeGreaterThan(
      actions.lastIndexOf('recovery.started'),
    )
  })

  it.each([
    {
      label: 'authentication',
      error: new Error('login required'),
      code: 'RECOVERY_AUTH_REQUIRED',
      status: 401,
    },
    {
      label: 'timeout',
      error: new RequestTimeoutError(9, 'thread/read', 10),
      code: 'RECOVERY_TIMEOUT',
      status: 504,
    },
  ])(
    'classifies $label recovery failures without marking the thread permanent',
    async ({ error, code, status }) => {
      class ClassifiedClient extends FakeRuntimeClient {
        override async request<TResult>(
          method: string,
          params: unknown,
        ): Promise<TResult> {
          if (method === 'thread/read') throw error
          return super.request(method, params)
        }
      }
      await setup({
        runtimeClientFactory: () => new ClassifiedClient(),
        sessionIdFactory: () => `ses_${code.toLowerCase()}`,
      })
      const scoped = {
        'x-tenant-id': `ten_${code.toLowerCase()}`,
        'x-workspace-id': `wsp_${code.toLowerCase()}`,
      }
      const created = sessionResponseSchema.parse(
        (
          await app!.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: scoped,
          })
        ).json(),
      )
      const failed = await app!.inject({
        method: 'POST',
        url: `/v1/sessions/${created.sessionId}/resume`,
        headers: { ...scoped, 'idempotency-key': `key-${code}` },
      })
      expect(failed.statusCode).toBe(status)
      expect(failed.json()).toMatchObject({ code })
      const detail = await app!.inject({
        method: 'GET',
        url: `/v1/sessions/${created.sessionId}`,
        headers: scoped,
      })
      expect(detail.json()).toMatchObject({
        codexThreadId: created.codexThreadId,
        status: 'recovering',
        recoveryErrorCode: code,
      })
    },
  )

  it('steers with expectedTurnId and idempotently interrupts the active turn', async () => {
    const client = new FakeRuntimeClient({ threadId: 'thr_actions' })
    client.snapshotTurns = [
      {
        id: 'turn_active',
        status: 'inProgress',
        items: [],
        itemsView: 'full',
        error: null,
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      },
    ]
    await setup({
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_actions',
    })
    const scoped = {
      'x-tenant-id': 'ten_actions',
      'x-workspace-id': 'wsp_actions',
    }
    await app!.inject({ method: 'POST', url: '/v1/sessions', headers: scoped })
    await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_actions/resume',
      headers: { ...scoped, 'idempotency-key': 'actions-resume' },
    })
    const noMatch = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_actions/turns/wrong/steer',
      headers: { ...scoped, 'idempotency-key': 'steer-wrong' },
      payload: { expectedTurnId: 'wrong', prompt: 'wrong' },
    })
    expect(noMatch.statusCode).toBe(409)
    expect(noMatch.json()).toMatchObject({ code: 'ACTIVE_TURN_CONFLICT' })
    const steer = () =>
      app!.inject({
        method: 'POST',
        url: '/v1/sessions/ses_actions/turns/turn_active/steer',
        headers: { ...scoped, 'idempotency-key': 'steer-once' },
        payload: { expectedTurnId: 'turn_active', prompt: 'continue' },
      })
    expect((await steer()).statusCode).toBe(200)
    expect((await steer()).statusCode).toBe(200)
    expect(
      client.requests.filter((method) => method === 'turn/steer'),
    ).toHaveLength(1)
    const interrupt = () =>
      app!.inject({
        method: 'POST',
        url: '/v1/sessions/ses_actions/turns/turn_active/interrupt',
        headers: { ...scoped, 'idempotency-key': 'interrupt-once' },
        payload: {},
      })
    expect((await interrupt()).statusCode).toBe(200)
    expect((await interrupt()).statusCode).toBe(200)
    expect(
      client.requests.filter((method) => method === 'turn/interrupt'),
    ).toHaveLength(1)
    const noActive = await app!.inject({
      method: 'POST',
      url: '/v1/sessions/ses_actions/turns/turn_active/steer',
      headers: { ...scoped, 'idempotency-key': 'steer-after-interrupt' },
      payload: { expectedTurnId: 'turn_active', prompt: 'late' },
    })
    expect(noActive.statusCode).toBe(409)
    expect(noActive.json()).toMatchObject({ code: 'NO_ACTIVE_TURN' })
  })

  it('auto-recovers once when a ready runtime advances generation', async () => {
    const client = new FakeRuntimeClient({ threadId: 'thr_auto' })
    await setup({
      runtimeClientFactory: () => client,
      sessionIdFactory: () => 'ses_auto',
      runtimeInstanceIdFactory: () => 'runtime_auto',
    })
    const scoped = {
      'x-tenant-id': 'ten_auto',
      'x-workspace-id': 'wsp_auto',
    }
    await app!.inject({ method: 'POST', url: '/v1/sessions', headers: scoped })
    client.requests.length = 0
    client.setHealth('restarting', 1)
    client.setHealth('ready', 2)
    for (
      let attempt = 0;
      attempt < 50 && client.requests.length < 2;
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 5))
    expect(client.requests).toEqual(['thread/read', 'thread/resume'])
    client.setHealth('ready', 2)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(client.requests).toEqual(['thread/read', 'thread/resume'])
  })
})

describe('WP4 restart-safe ingest regression', () => {
  it('keeps two control-plane instances and their authoritative finals isolated in one file DB', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp4-restart-ingest-'))
    const databasePath = join(directory, 'events.sqlite')
    const restartHeaders = {
      'content-type': 'application/json',
      'x-tenant-id': 'ten_restart',
      'x-workspace-id': 'wsp_restart',
    }
    const firstScope = {
      tenantId: 'ten_restart',
      workspaceId: 'wsp_restart',
      sessionId: 'ses_restart_a',
    }
    const secondScope = { ...firstScope, sessionId: 'ses_restart_b' }
    let firstApp: FastifyInstance | undefined
    let secondApp: FastifyInstance | undefined

    try {
      firstApp = await buildControlPlane({
        databasePath,
        workspaceCwd: '/server/configured/workspace',
        runtimeClientFactory: () =>
          new FakeRuntimeClient({
            threadId: 'thr_restart_a',
            turnId: 'turn_restart_a',
            itemId: 'msg_restart_a',
            delta: 'A delta',
            finalText: 'A authoritative final',
          }),
        runtimeInstanceIdFactory: () => 'runtime-instance-a',
        sessionIdFactory: () => firstScope.sessionId,
      })
      await firstApp.ready()
      expect(
        (
          await firstApp.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: restartHeaders,
            payload: {},
          })
        ).statusCode,
      ).toBe(201)
      expect(
        (
          await firstApp.inject({
            method: 'POST',
            url: `/v1/sessions/${firstScope.sessionId}/turns`,
            headers: { ...restartHeaders, 'idempotency-key': 'restart-a' },
            payload: { prompt: 'first' },
          })
        ).statusCode,
      ).toBe(202)
      await firstApp.close()
      firstApp = undefined

      secondApp = await buildControlPlane({
        databasePath,
        workspaceCwd: '/server/configured/workspace',
        runtimeClientFactory: () =>
          new FakeRuntimeClient({
            threadId: 'thr_restart_b',
            turnId: 'turn_restart_b',
            itemId: 'msg_restart_b',
            delta: 'B last delta only',
            finalText: 'B authoritative complete message',
          }),
        runtimeInstanceIdFactory: () => 'runtime-instance-b',
        sessionIdFactory: () => secondScope.sessionId,
      })
      await secondApp.ready()
      expect(
        (
          await secondApp.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: restartHeaders,
            payload: {},
          })
        ).statusCode,
      ).toBe(201)
      expect(
        (
          await secondApp.inject({
            method: 'POST',
            url: `/v1/sessions/${secondScope.sessionId}/turns`,
            headers: { ...restartHeaders, 'idempotency-key': 'restart-b' },
            payload: { prompt: 'second' },
          })
        ).statusCode,
      ).toBe(202)
      await secondApp.close()
      secondApp = undefined

      const evidence = new SqliteEventStore(databasePath)
      const firstEvents = evidence.replaySessionEvents(
        firstScope,
        0,
        100,
      ).events
      const secondEvents = evidence.replaySessionEvents(
        secondScope,
        0,
        100,
      ).events
      expect(evidence.getRecordCounts(firstScope)).toMatchObject({
        rawEvents: 6,
        events: 6,
      })
      expect(evidence.getRecordCounts(secondScope)).toEqual({
        rawEvents: 6,
        events: 6,
        workspaceSequence: 12,
      })
      expect(
        secondEvents.find((event) => event.type === 'agent.message.delta'),
      ).toMatchObject({ payload: { text: 'B last delta only' } })
      expect(
        secondEvents.find((event) => event.type === 'agent.message.completed'),
      ).toMatchObject({
        payload: { text: 'B authoritative complete message' },
      })
      expect(secondEvents.at(-1)).toMatchObject({ type: 'turn.completed' })
      const allSequences = [...firstEvents, ...secondEvents].map(
        (event) => event.sequence,
      )
      expect(allSequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
      expect(new Set(allSequences).size).toBe(allSequences.length)
      evidence.close()

      const database = new DatabaseSync(databasePath)
      const rawRows = database
        .prepare(
          `SELECT session_id, ingest_key FROM raw_events
           WHERE tenant_id = ? AND workspace_id = ? ORDER BY raw_event_id`,
        )
        .all(firstScope.tenantId, firstScope.workspaceId) as unknown as Array<{
        session_id: string
        ingest_key: string
      }>
      database.close()
      expect(
        rawRows.filter((row) => row.session_id === firstScope.sessionId),
      ).toHaveLength(6)
      expect(
        rawRows.filter((row) => row.session_id === secondScope.sessionId),
      ).toHaveLength(6)
      expect(
        rawRows
          .slice(0, 6)
          .every((row) => row.ingest_key.includes('runtime-instance-a')),
      ).toBe(true)
      expect(
        rawRows
          .slice(6)
          .every((row) => row.ingest_key.includes('runtime-instance-b')),
      ).toBe(true)
    } finally {
      await firstApp?.close()
      await secondApp?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
