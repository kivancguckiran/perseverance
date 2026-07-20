import { createHash, randomBytes } from 'node:crypto'
import type { SliName, TraceContext } from './contracts'

const spanNames = new Set([
  'api.request',
  'realtime.reconnect',
  'turn.admission',
  'scheduler.queue',
  'scheduler.claim',
  'workspace.runtime',
  'codex.turn',
  'event.append',
  'event.publish',
  'event.replay',
  'approval.decision',
  'index.rebuild',
  'backup.create',
  'restore.execute',
  'region.failover',
  'unknown.event',
])
const allowedAttributeKeys = new Set([
  'service.name',
  'service.role',
  'deployment.region',
  'operation',
  'route',
  'method',
  'status',
  'outcome',
  'error.code',
  'event.type',
  'provider',
  'tenant.opaque',
  'workspace.opaque',
  'recovery.reason',
])
const forbiddenKey =
  /(prompt|output|content|attachment|source|corpus|secret|api.?key|bearer|authorization|token|command|filename|email)/i

export type SafeAttributes = Readonly<Record<string, string | number | boolean>>
export interface SpanRecord {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
  startedAt: string
  endedAt: string
  durationMs: number
  status: 'ok' | 'error'
  attributes: SafeAttributes
}
export interface MetricRecord {
  sli: SliName
  value: number
  observedAt: string
  traceId: string | null
  attributes: SafeAttributes
}
export interface LogRecord {
  severity: 'info' | 'warn' | 'error'
  code: string
  observedAt: string
  traceId: string | null
  spanId: string | null
  attributes: SafeAttributes
}

export function opaqueScope(value: string, salt: string) {
  if (salt.length < 16) throw new Error('TELEMETRY_SCOPE_SALT_TOO_SHORT')
  return createHash('sha256')
    .update(salt)
    .update('\0')
    .update(value)
    .digest('hex')
}

export function parseTraceparent(
  value: string | undefined,
): TraceContext | null {
  const match = value?.match(/^00-([a-f0-9]{32})-([a-f0-9]{16})-01$/)
  return match
    ? {
        schemaVersion: 1,
        traceId: match[1]!,
        spanId: randomBytes(8).toString('hex'),
        parentSpanId: match[2]!,
        traceFlags: '01',
      }
    : null
}

export function createTrace(parent?: TraceContext | null): TraceContext {
  return {
    schemaVersion: 1,
    traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    parentSpanId: parent?.spanId ?? null,
    traceFlags: '01',
  }
}

export function traceparent(context: TraceContext) {
  return `00-${context.traceId}-${context.spanId}-01`
}

export function safeAttributes(input: SafeAttributes): SafeAttributes {
  const result: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(input)) {
    if (forbiddenKey.test(key) || !allowedAttributeKeys.has(key))
      throw new Error(`TELEMETRY_ATTRIBUTE_FORBIDDEN:${key}`)
    if (typeof value === 'string' && value.length > 128)
      throw new Error(`TELEMETRY_ATTRIBUTE_UNBOUNDED:${key}`)
    result[key] = value
  }
  return Object.freeze(result)
}

export class ProductionTelemetry {
  readonly spans: SpanRecord[] = []
  readonly metrics: MetricRecord[] = []
  readonly logs: LogRecord[] = []
  readonly now: () => Date
  readonly maxRecords: number
  droppedRecords = 0

  constructor(now: () => Date = () => new Date(), maxRecords = 2_048) {
    this.now = now
    this.maxRecords = maxRecords
  }

  #boundedPush<T>(target: T[], value: T) {
    if (target.length >= this.maxRecords) {
      target.shift()
      this.droppedRecords++
    }
    target.push(value)
  }

  startSpan(
    name: string,
    input: { parent?: TraceContext | null; attributes?: SafeAttributes } = {},
  ) {
    if (!spanNames.has(name))
      throw new Error(`TELEMETRY_SPAN_FORBIDDEN:${name}`)
    const context = createTrace(input.parent)
    const startedAt = this.now()
    const attributes = safeAttributes(input.attributes ?? {})
    let ended = false
    return {
      context,
      end: (status: 'ok' | 'error' = 'ok', extra: SafeAttributes = {}) => {
        if (ended) return
        ended = true
        const endedAt = this.now()
        this.#boundedPush(this.spans, {
          traceId: context.traceId,
          spanId: context.spanId,
          parentSpanId: context.parentSpanId,
          name,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
          status,
          attributes: safeAttributes({ ...attributes, ...extra }),
        })
      },
    }
  }

  recordMetric(
    sli: SliName,
    value: number,
    input: { context?: TraceContext | null; attributes?: SafeAttributes } = {},
  ) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error('TELEMETRY_METRIC_INVALID')
    this.#boundedPush(this.metrics, {
      sli,
      value,
      observedAt: this.now().toISOString(),
      traceId: input.context?.traceId ?? null,
      attributes: safeAttributes(input.attributes ?? {}),
    })
  }

  log(
    severity: LogRecord['severity'],
    code: string,
    input: { context?: TraceContext | null; attributes?: SafeAttributes } = {},
  ) {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(code))
      throw new Error('TELEMETRY_LOG_CODE_INVALID')
    this.#boundedPush(this.logs, {
      severity,
      code,
      observedAt: this.now().toISOString(),
      traceId: input.context?.traceId ?? null,
      spanId: input.context?.spanId ?? null,
      attributes: safeAttributes(input.attributes ?? {}),
    })
  }

  snapshot() {
    const metrics = [...this.metrics]
    if (this.droppedRecords > 0)
      metrics.push({
        sli: 'telemetry_dropped' as const,
        value: this.droppedRecords,
        observedAt: this.now().toISOString(),
        traceId: null,
        attributes: Object.freeze({ outcome: 'collector_unavailable' }),
      })
    return structuredClone({
      spans: this.spans,
      metrics,
      logs: this.logs,
    })
  }
}

const otlpId = (hex: string) => hex
const unixNano = (value: string) =>
  (BigInt(new Date(value).getTime()) * 1_000_000n).toString()
const otlpAttributes = (attributes: SafeAttributes) =>
  Object.entries(attributes).map(([key, value]) => ({
    key,
    value:
      typeof value === 'string'
        ? { stringValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : { doubleValue: value },
  }))

export class OtlpHttpExporter {
  readonly telemetry: ProductionTelemetry
  readonly endpoint: string

  constructor(telemetry: ProductionTelemetry, endpoint: string) {
    this.telemetry = telemetry
    this.endpoint = endpoint.replace(/\/$/, '')
  }

  async flush() {
    const snapshot = this.telemetry.snapshot()
    const requests: Promise<Response>[] = []
    if (snapshot.spans.length)
      requests.push(
        fetch(`${this.endpoint}/v1/traces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceSpans: [
              {
                resource: { attributes: [] },
                scopeSpans: [
                  {
                    scope: { name: 'persistent-codex-wp27' },
                    spans: snapshot.spans.map((span) => ({
                      traceId: otlpId(span.traceId),
                      spanId: otlpId(span.spanId),
                      ...(span.parentSpanId
                        ? { parentSpanId: otlpId(span.parentSpanId) }
                        : {}),
                      name: span.name,
                      kind: 1,
                      startTimeUnixNano: unixNano(span.startedAt),
                      endTimeUnixNano: unixNano(span.endedAt),
                      attributes: otlpAttributes(span.attributes),
                      status: { code: span.status === 'ok' ? 1 : 2 },
                    })),
                  },
                ],
              },
            ],
          }),
        }),
      )
    if (snapshot.metrics.length)
      requests.push(
        fetch(`${this.endpoint}/v1/metrics`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceMetrics: [
              {
                resource: { attributes: [] },
                scopeMetrics: [
                  {
                    scope: { name: 'persistent-codex-wp27' },
                    metrics: snapshot.metrics.map((metric) => ({
                      name: `persistent_codex_${metric.sli}`,
                      gauge: {
                        dataPoints: [
                          {
                            timeUnixNano: unixNano(metric.observedAt),
                            asDouble: metric.value,
                            attributes: otlpAttributes(metric.attributes),
                            ...(metric.traceId
                              ? { traceId: otlpId(metric.traceId) }
                              : {}),
                          },
                        ],
                      },
                    })),
                  },
                ],
              },
            ],
          }),
        }),
      )
    if (snapshot.logs.length)
      requests.push(
        fetch(`${this.endpoint}/v1/logs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceLogs: [
              {
                resource: { attributes: [] },
                scopeLogs: [
                  {
                    scope: { name: 'persistent-codex-wp27' },
                    logRecords: snapshot.logs.map((log) => ({
                      timeUnixNano: unixNano(log.observedAt),
                      severityText: log.severity.toUpperCase(),
                      body: { stringValue: log.code },
                      attributes: otlpAttributes(log.attributes),
                      ...(log.traceId ? { traceId: otlpId(log.traceId) } : {}),
                      ...(log.spanId ? { spanId: otlpId(log.spanId) } : {}),
                    })),
                  },
                ],
              },
            ],
          }),
        }),
      )
    const responses = await Promise.all(requests)
    if (responses.some((response) => !response.ok))
      throw new Error('OTLP_EXPORT_FAILED')
    this.telemetry.spans.splice(0, snapshot.spans.length)
    this.telemetry.metrics.splice(0, snapshot.metrics.length)
    this.telemetry.logs.splice(0, snapshot.logs.length)
    this.telemetry.droppedRecords = 0
    return responses.length
  }
}
