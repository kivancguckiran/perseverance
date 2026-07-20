import { randomUUID } from 'node:crypto'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import {
  ProductionTelemetry,
  OtlpHttpExporter,
  opaqueScope,
  parseTraceparent,
  type TraceContext,
} from '@persistent-codex/production-observability'
import {
  createBillingPostgresRepository,
  type BillingPostgresRepository,
} from '@persistent-codex/billing-platform'
import {
  createProductionPostgresRepository,
  type ProductionPostgresRepository,
  type ProductionScope,
} from '@persistent-codex/production-topology/production-postgres'
import {
  RabbitMqManagementBroker,
  S3CompatibleObjectStore,
  httpDependencyReady,
  type DurableEventBroker,
  type ObjectStore,
} from '@persistent-codex/production-topology/durable-dependencies'

export interface ProductionControlPlaneOptions {
  instanceId: string
  repository: ProductionPostgresRepository
  objectStore: ObjectStore
  broker: DurableEventBroker
  runtimeControlReadinessUrl: string
  kmsReadinessUrl: string
  requiredRegionId: string
  billing: BillingPostgresRepository
  logger?: boolean
  dependencyTimeoutMs?: number
  now?: () => Date
  telemetry?: ProductionTelemetry
  telemetryScopeSalt?: string
}

function header(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function scope(headers: Record<string, string | string[] | undefined>) {
  const tenantId = header(headers['x-tenant-id'])
  const organizationId = header(headers['x-organization-id']) ?? tenantId
  const workspaceId = header(headers['x-workspace-id'])
  if (!tenantId || !organizationId || !workspaceId) return null
  return { tenantId, organizationId, workspaceId } satisfies ProductionScope
}

async function bounded<T>(timeoutMs: number, operation: () => Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('DEPENDENCY_TIMEOUT')),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function buildProductionControlPlane(
  options: ProductionControlPlaneOptions,
) {
  const app = Fastify({ logger: options.logger ?? false })
  await app.register(websocket)
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const timeoutMs = options.dependencyTimeoutMs ?? 2_000
  const now = options.now ?? (() => new Date())
  const telemetry = options.telemetry ?? new ProductionTelemetry(now)
  const telemetrySalt = options.telemetryScopeSalt ?? 'wp27-test-scope-salt'
  const requestTelemetry = new WeakMap<
    object,
    {
      context: TraceContext
      end: (
        status?: 'ok' | 'error',
        extra?: Record<string, string | number | boolean>,
      ) => void
      started: number
    }
  >()

  app.addHook('onRequest', async (request) => {
    const requestScope = scope(request.headers)
    const span = telemetry.startSpan('api.request', {
      parent: parseTraceparent(header(request.headers.traceparent)),
      attributes: {
        'service.name': 'control-plane',
        'service.role': 'api',
        operation: request.url.startsWith('/v1/realtime') ? 'realtime' : 'http',
        method: request.method,
        ...(requestScope
          ? {
              'tenant.opaque': opaqueScope(
                requestScope.tenantId,
                telemetrySalt,
              ),
              'workspace.opaque': opaqueScope(
                requestScope.workspaceId,
                telemetrySalt,
              ),
            }
          : {}),
      },
    })
    requestTelemetry.set(request, { ...span, started: performance.now() })
  })
  app.addHook('onResponse', async (request, reply) => {
    const observed = requestTelemetry.get(request)
    if (!observed) return
    const ok = reply.statusCode < 500
    telemetry.recordMetric('api_availability', ok ? 1 : 0, {
      context: observed.context,
      attributes: { status: ok ? 'success' : 'error', method: request.method },
    })
    telemetry.recordMetric('api_error_rate', ok ? 0 : 1, {
      context: observed.context,
      attributes: { status: `${Math.floor(reply.statusCode / 100)}xx` },
    })
    observed.end(ok ? 'ok' : 'error', {
      status: `${reply.statusCode}`,
      outcome: ok ? 'success' : 'error',
    })
  })

  const dependencyReadiness = async () => {
    const probes = await Promise.allSettled([
      bounded(timeoutMs, () => options.repository.pool.query('SELECT 1')),
      bounded(timeoutMs, () => options.broker.ready()),
      bounded(timeoutMs, () => options.objectStore.ready()),
      bounded(timeoutMs, () =>
        httpDependencyReady(options.runtimeControlReadinessUrl),
      ),
      bounded(timeoutMs, () => httpDependencyReady(options.kmsReadinessUrl)),
    ])
    const names = [
      'postgresql',
      'event-broker',
      'object-storage',
      'runtime-control',
      'kms',
    ] as const
    const dependencies = names.map((name, index) => ({
      name,
      ready:
        probes[index]?.status === 'fulfilled' &&
        (typeof (probes[index] as PromiseFulfilledResult<unknown>).value !==
          'boolean' ||
          (probes[index] as PromiseFulfilledResult<boolean>).value),
      code:
        probes[index]?.status === 'fulfilled' &&
        (typeof (probes[index] as PromiseFulfilledResult<unknown>).value !==
          'boolean' ||
          (probes[index] as PromiseFulfilledResult<boolean>).value)
          ? null
          : `${name.toUpperCase().replaceAll('-', '_')}_UNAVAILABLE`,
    }))
    return {
      schemaVersion: 1 as const,
      instanceId: options.instanceId,
      mode: 'production' as const,
      ready: dependencies.every((dependency) => dependency.ready),
      checkedAt: now().toISOString(),
      dependencies,
    }
  }

  const requireReady = async () => {
    const readiness = await dependencyReadiness()
    return readiness.ready ? null : readiness
  }

  app.get('/healthz', async () => ({
    status: 'ok',
    instanceId: options.instanceId,
    mode: 'production',
  }))
  app.get('/readyz', async (_request, reply) => {
    const readiness = await dependencyReadiness()
    return reply.code(readiness.ready ? 200 : 503).send(readiness)
  })
  app.get('/v1/meta', async () => ({
    service: 'persistent-codex-control-plane',
    topology: 'active-passive-region-pinned',
    persistence: 'postgresql-object-storage-durable-broker',
    instanceId: options.instanceId,
    codexVersion: '0.144.2',
  }))

  app.post('/v1/sessions', async (request, reply) => {
    const requestScope = scope(request.headers)
    if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
    const unavailable = await requireReady()
    if (unavailable)
      return reply.code(503).send({
        code: 'PRODUCTION_DEPENDENCY_UNAVAILABLE',
        readiness: unavailable,
      })
    const created = await options.repository.createSession(requestScope)
    return reply.code(201).send({
      ...created,
      replay: { events: [], highWaterSequence: 0 },
    })
  })

  app.get<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const stored = await options.repository.getSession(
        requestScope,
        request.params.sessionId,
      )
      if (!stored) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' })
      const replay = await options.repository.replay(
        requestScope,
        request.params.sessionId,
      )
      return { ...stored, replay }
    },
  )

  app.post<{
    Params: { sessionId: string }
    Body: {
      prompt?: unknown
      approvalContext?: {
        kind?: unknown
        command?: unknown
        risk?: unknown
      }
    }
  }>('/v1/sessions/:sessionId/turns', async (request, reply) => {
    const admissionStarted = performance.now()
    const admissionSpan = telemetry.startSpan('turn.admission', {
      parent: requestTelemetry.get(request)?.context ?? null,
      attributes: { operation: 'turn.start' },
    })
    const requestScope = scope(request.headers)
    if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
    const unavailable = await requireReady()
    if (unavailable)
      return reply.code(503).send({
        code: 'PRODUCTION_DEPENDENCY_UNAVAILABLE',
        readiness: unavailable,
      })
    if (
      typeof request.body?.prompt !== 'string' ||
      request.body.prompt.length === 0 ||
      request.body.prompt.length > 100_000
    )
      return reply.code(400).send({ code: 'INVALID_PROMPT' })
    const idempotencyKey = header(request.headers['idempotency-key'])
    if (!idempotencyKey)
      return reply.code(400).send({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
    const storedSession = await options.repository.getSession(
      requestScope,
      request.params.sessionId,
    )
    if (!storedSession)
      return reply.code(404).send({ code: 'SESSION_NOT_FOUND' })
    const billingDecision = await options.billing.admit({
      ...requestScope,
      requestKey: idempotencyKey,
      operation: 'turn.start',
      sessionId: request.params.sessionId,
    })
    if (billingDecision.outcome === 'deny')
      return reply.code(429).send({
        code: 'COMMERCIAL_ADMISSION_DENIED',
        reason: billingDecision.reason,
      })
    const runId = `run_${randomUUID()}`
    const objectKey = `${requestScope.tenantId}/${requestScope.organizationId}/${requestScope.workspaceId}/runs/${runId}/input`
    try {
      await options.objectStore.put(
        objectKey,
        encoder.encode(request.body.prompt),
        'text/plain; charset=utf-8',
      )
      const approvalContext = request.body.approvalContext
      const accepted = await options.repository.enqueueTurn({
        ...requestScope,
        sessionId: request.params.sessionId,
        runId,
        idempotencyKey,
        promptObjectKey: objectKey,
        requestBody: request.body,
        requiredRegionId: options.requiredRegionId,
        maxAttempts: 4,
        traceId: admissionSpan.context.traceId,
        ...(approvalContext
          ? {
              approval: {
                kind:
                  approvalContext.kind === 'file' ||
                  approvalContext.kind === 'network'
                    ? approvalContext.kind
                    : ('command' as const),
                context: {
                  command:
                    typeof approvalContext.command === 'string'
                      ? approvalContext.command
                      : 'opaque-command',
                  risk:
                    typeof approvalContext.risk === 'string'
                      ? approvalContext.risk
                      : 'bounded',
                },
              },
            }
          : {}),
      })
      if (!accepted.created)
        await options.objectStore.delete(objectKey).catch(() => undefined)
      await options.billing.bindDecision(
        requestScope,
        billingDecision.decisionId,
        accepted.run.runId,
      )
      const brokerSpan = telemetry.startSpan('event.publish', {
        parent: admissionSpan.context,
        attributes: { operation: 'broker.publish', 'event.type': 'run.queued' },
      })
      await options.broker.publish('ha.event', {
        schemaVersion: 1,
        type: 'run.queued',
        tenantId: requestScope.tenantId,
        workspaceId: requestScope.workspaceId,
        sessionId: request.params.sessionId,
        runId: accepted.run.runId,
        traceId: admissionSpan.context.traceId,
      })
      brokerSpan.end('ok')
      telemetry.recordMetric(
        'turn_admission_latency',
        performance.now() - admissionStarted,
        {
          context: admissionSpan.context,
          attributes: { outcome: accepted.created ? 'created' : 'idempotent' },
        },
      )
      admissionSpan.end('ok')
      return reply.code(202).send({
        tenantId: requestScope.tenantId,
        workspaceId: requestScope.workspaceId,
        sessionId: request.params.sessionId,
        runId: accepted.run.runId,
        queueItemId: accepted.run.queueItemId,
        codexThreadId: storedSession.codexThreadId ?? request.params.sessionId,
        codexTurnId: accepted.run.runId,
        idempotencyKey,
        status: accepted.approval ? 'awaiting_approval' : 'queued',
        approvalId: accepted.approval?.approvalId ?? null,
      })
    } catch (error) {
      admissionSpan.end('error', {
        'error.code':
          error instanceof Error
            ? error.message.slice(0, 64).replaceAll(/[^A-Za-z0-9_:-]/g, '_')
            : 'UNKNOWN',
      })
      await options.objectStore.delete(objectKey).catch(() => undefined)
      await options.billing
        .cancelDecision(requestScope, billingDecision.decisionId)
        .catch(() => undefined)
      if (error instanceof Error && error.message === 'IDEMPOTENCY_KEY_REUSED')
        return reply.code(409).send({ code: error.message })
      throw error
    }
  })

  app.get<{ Querystring: { status?: string } }>(
    '/v1/approvals',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const status = request.query.status
      const approvals = await options.repository.listApprovals(
        requestScope,
        status === 'pending' ||
          status === 'accepted' ||
          status === 'declined' ||
          status === 'expired'
          ? status
          : undefined,
      )
      return { approvals }
    },
  )

  app.post<{
    Params: { approvalId: string }
    Body: { decision?: unknown; expectedVersion?: unknown }
  }>('/v1/approvals/:approvalId/decision', async (request, reply) => {
    const approvalStarted = performance.now()
    const approvalSpan = telemetry.startSpan('approval.decision', {
      parent: requestTelemetry.get(request)?.context ?? null,
      attributes: { operation: 'approval.decision' },
    })
    const requestScope = scope(request.headers)
    if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
    const unavailable = await requireReady()
    if (unavailable)
      return reply.code(503).send({
        code: 'PRODUCTION_DEPENDENCY_UNAVAILABLE',
        readiness: unavailable,
      })
    if (
      (request.body?.decision !== 'accept' &&
        request.body?.decision !== 'decline') ||
      !Number.isInteger(request.body.expectedVersion)
    )
      return reply.code(400).send({ code: 'INVALID_APPROVAL_DECISION' })
    const decided = await options.repository.decideApproval({
      ...requestScope,
      approvalId: request.params.approvalId,
      expectedVersion: Number(request.body.expectedVersion),
      decision: request.body.decision,
      principalId:
        header(request.headers['x-principal-id']) ?? 'opaque-principal',
    })
    if (!decided)
      return reply.code(409).send({ code: 'APPROVAL_VERSION_CONFLICT' })
    await options.broker.publish('ha.event', {
      schemaVersion: 1,
      type: 'approval.decided',
      tenantId: requestScope.tenantId,
      workspaceId: requestScope.workspaceId,
      sessionId: decided.sessionId,
      approvalId: decided.approvalId,
      runId: decided.runId,
      state: decided.state,
      traceId: approvalSpan.context.traceId,
    })
    telemetry.recordMetric(
      'approval_latency',
      performance.now() - approvalStarted,
      {
        context: approvalSpan.context,
        attributes: { outcome: decided.state },
      },
    )
    approvalSpan.end('ok')
    return decided
  })

  app.get<{
    Params: { sessionId: string }
    Querystring: { after?: string; limit?: string }
  }>('/v1/sessions/:sessionId/events', async (request, reply) => {
    const replayStarted = performance.now()
    const replaySpan = telemetry.startSpan('event.replay', {
      parent: requestTelemetry.get(request)?.context ?? null,
      attributes: { operation: 'event.replay' },
    })
    const requestScope = scope(request.headers)
    if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
    const after = Number.parseInt(request.query.after ?? '0', 10)
    const limit = Math.min(
      500,
      Math.max(1, Number.parseInt(request.query.limit ?? '500', 10)),
    )
    const replay = await options.repository.replay(
      requestScope,
      request.params.sessionId,
      Number.isFinite(after) ? after : 0,
      limit,
    )
    telemetry.recordMetric(
      'event_replay_lag',
      Math.max(0, performance.now() - replayStarted),
      {
        context: replaySpan.context,
        attributes: { outcome: 'success' },
      },
    )
    replaySpan.end('ok')
    return {
      ...requestScope,
      sessionId: request.params.sessionId,
      ...replay,
      events: replay.events.map((stored) => ({
        version: 1,
        eventId: stored.eventId,
        sequence: stored.sequence,
        tenantId: stored.tenantId,
        workspaceId: stored.workspaceId,
        sessionId: stored.sessionId,
        codexTurnId: stored.runId,
        codexItemId: null,
        type: stored.eventType,
        payload: stored.payload,
        occurredAt: stored.occurredAt,
      })),
    }
  })

  app.get<{ Params: { runId: string } }>(
    '/v1/runs/:runId/output',
    async (request, reply) => {
      const requestScope = scope(request.headers)
      if (!requestScope) return reply.code(400).send({ code: 'MISSING_SCOPE' })
      const stored = await options.repository.getRun(
        requestScope,
        request.params.runId,
      )
      if (!stored?.outputObjectKey)
        return reply.code(404).send({ code: 'OUTPUT_NOT_FOUND' })
      const bytes = await options.objectStore.get(stored.outputObjectKey)
      return reply.type('text/plain; charset=utf-8').send(decoder.decode(bytes))
    },
  )

  app.get('/wp26', async (_request, reply) =>
    reply.type('text/html').send(`<!doctype html><meta charset="utf-8">
      <title>WP26 Production HA</title><main><h1>WP26 Production HA</h1>
      <div id="state">connecting</div><ol id="timeline"></ol><pre id="approval"></pre></main>
      <script>
      const q=new URLSearchParams(location.search),tenant=q.get('tenant'),workspace=q.get('workspace'),session=q.get('session');
      const headers={'x-tenant-id':tenant,'x-organization-id':tenant,'x-workspace-id':workspace};let after=0;
      function connect(){const protocol=location.protocol==='https:'?'wss:':'ws:';const socket=new WebSocket(protocol+'//'+location.host+'/v1/realtime?sessionId='+encodeURIComponent(session)+'&after='+after+'&tenant='+encodeURIComponent(tenant)+'&workspace='+encodeURIComponent(workspace));
        socket.onmessage=message=>{const value=JSON.parse(message.data);if(value.type==='hello'){document.body.dataset.instance=value.instanceId;document.querySelector('#state').textContent='connected high-water '+after;return}const event=value.event;if(event.sequence<=after)return;after=event.sequence;const li=document.createElement('li');li.dataset.sequence=event.sequence;li.textContent=event.eventType;document.querySelector('#timeline').append(li);document.querySelector('#state').textContent='connected high-water '+value.highWaterSequence};
        socket.onclose=()=>{document.querySelector('#state').textContent='reconnecting';setTimeout(connect,100)}}
      async function approvals(){try{const a=await fetch('/v1/approvals?status=pending',{headers}).then(r=>r.json());document.querySelector('#approval').textContent=JSON.stringify(a.approvals||[])}finally{setTimeout(approvals,100)}}connect();approvals();
      </script>`),
  )

  app.get('/v1/realtime', { websocket: true }, (socket, request) => {
    const query = request.query as {
      sessionId?: string
      after?: string
      tenant?: string
      workspace?: string
    }
    const requestScope =
      scope(request.headers) ??
      (query.tenant && query.workspace
        ? {
            tenantId: query.tenant,
            organizationId: query.tenant,
            workspaceId: query.workspace,
          }
        : null)
    if (!requestScope || !query.sessionId) return socket.close(4400)
    socket.send(
      JSON.stringify({ type: 'hello', instanceId: options.instanceId }),
    )
    let after = Number.parseInt(query.after ?? '0', 10) || 0
    let closed = false
    socket.on('close', () => {
      closed = true
    })
    const pump = async () => {
      while (!closed) {
        const replay = await options.repository.replay(
          requestScope,
          query.sessionId!,
          after,
          100,
        )
        for (const stored of replay.events) {
          after = stored.sequence
          socket.send(
            JSON.stringify({
              type: 'event',
              event: stored,
              highWaterSequence: replay.highWaterSequence,
            }),
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    void pump().catch(() => socket.close(1011))
  })

  const outboxTimer = setInterval(() => {
    void (async () => {
      const rows = await options.repository.listOutbox(100)
      const published: number[] = []
      for (const row of rows) {
        await options.broker.publish('ha.event', {
          schemaVersion: 1,
          type: 'timeline.event',
          tenantId: row.tenant_id,
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
          eventId: row.event_id,
          sequence: Number(row.sequence),
        })
        published.push(Number(row.outbox_id))
      }
      await options.repository.markOutboxPublished(published)
    })().catch(() => undefined)
  }, 100)
  outboxTimer.unref()
  app.addHook('onClose', async () => clearInterval(outboxTimer))
  return app
}

export async function buildProductionControlPlaneFromEnv(
  env: NodeJS.ProcessEnv,
) {
  const required = (name: string) => {
    const value = env[name]
    if (!value) throw new Error(`Production requires ${name}`)
    return value
  }
  const repository = createProductionPostgresRepository(
    required('TOPOLOGY_DATABASE_URL'),
  )
  const billing = createBillingPostgresRepository(
    required('TOPOLOGY_DATABASE_URL'),
    { productionBillingVerified: true },
  )
  const objectStore = new S3CompatibleObjectStore({
    endpoint: required('OBJECT_STORAGE_ENDPOINT'),
    bucket: required('OBJECT_STORAGE_BUCKET'),
    accessKeyId: required('OBJECT_STORAGE_ACCESS_KEY_ID'),
    secretAccessKey: required('OBJECT_STORAGE_SECRET_ACCESS_KEY'),
  })
  await objectStore.ensureBucket()
  const broker = new RabbitMqManagementBroker({
    endpoint: required('EVENT_BROKER_MANAGEMENT_URL'),
    username: required('EVENT_BROKER_USERNAME'),
    password: required('EVENT_BROKER_PASSWORD'),
    queue: required('EVENT_BROKER_QUEUE'),
  })
  await broker.ensureQueue()
  const telemetry = new ProductionTelemetry(
    () => new Date(),
    Number(env.TELEMETRY_MAX_RECORDS ?? 2_048),
  )
  const app = await buildProductionControlPlane({
    instanceId: required('PERSISTENT_INSTANCE_ID'),
    repository,
    objectStore,
    broker,
    runtimeControlReadinessUrl: required('RUNTIME_CONTROL_READINESS_URL'),
    kmsReadinessUrl: required('KMS_READINESS_URL'),
    requiredRegionId: required('PERSISTENT_REGION_ID'),
    billing,
    logger: env.PERSISTENT_LOGGER === '1',
    telemetryScopeSalt: required('TELEMETRY_SCOPE_SALT'),
    telemetry,
  })
  const exporter = env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OtlpHttpExporter(telemetry, env.OTEL_EXPORTER_OTLP_ENDPOINT)
    : null
  const telemetryTimer = exporter
    ? setInterval(() => void exporter.flush().catch(() => undefined), 1_000)
    : null
  telemetryTimer?.unref()
  app.addHook('onClose', async () =>
    Promise.all([
      repository.close(),
      billing.close(),
      ...(exporter ? [exporter.flush().catch(() => 0)] : []),
    ]),
  )
  app.addHook('onClose', async () => {
    if (telemetryTimer) clearInterval(telemetryTimer)
  })
  return app
}
