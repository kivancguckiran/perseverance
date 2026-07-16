import {
  metricsResponseSchema,
  type MetricsResponse,
} from '@persistent-codex/control-plane-contracts'

type MetricKind = 'counter' | 'histogram' | 'gauge'
interface MetricDefinition {
  kind: MetricKind
  labels: Record<string, readonly string[]>
  buckets?: readonly number[]
}

export const METRIC_DEFINITIONS = {
  api_request_latency_ms: {
    kind: 'histogram',
    labels: {
      route: [
        'healthz',
        'readyz',
        'metrics',
        'sessions',
        'turns',
        'approvals',
        'audit',
        'artifacts',
        'git',
        'realtime',
        'other',
      ],
      method: ['GET', 'POST', 'OTHER'],
      status: ['2xx', '4xx', '5xx'],
    },
    buckets: [10, 50, 100, 250, 500, 1_000, 5_000],
  },
  api_errors_total: {
    kind: 'counter',
    labels: {
      route: [
        'healthz',
        'readyz',
        'metrics',
        'sessions',
        'turns',
        'approvals',
        'audit',
        'artifacts',
        'git',
        'realtime',
        'other',
      ],
      code: ['4xx', '5xx'],
    },
  },
  turn_duration_ms: {
    kind: 'histogram',
    labels: { outcome: ['completed', 'failed', 'interrupted'] },
    buckets: [100, 500, 1_000, 5_000, 30_000, 120_000],
  },
  turn_token_usage_total: {
    kind: 'counter',
    labels: { kind: ['input', 'output', 'cached', 'reasoning'] },
  },
  approval_wait_ms: {
    kind: 'histogram',
    labels: {
      outcome: [
        'accept',
        'accept_for_session',
        'decline',
        'cancel',
        'expired',
        'superseded',
      ],
    },
    buckets: [100, 1_000, 5_000, 30_000, 120_000, 600_000],
  },
  realtime_reconnects_total: {
    kind: 'counter',
    labels: { reason: ['client', 'resync', 'transport'] },
  },
  replay_lag_events: {
    kind: 'gauge',
    labels: { state: ['connected', 'replaying'] },
  },
  app_server_restarts_total: {
    kind: 'counter',
    labels: { outcome: ['ready', 'failed', 'crash_loop'] },
  },
  artifacts_total: {
    kind: 'counter',
    labels: {
      kind: ['command-output', 'git-diff'],
      status: ['writing', 'finalized', 'recovery_required', 'accessed'],
    },
  },
  artifact_bytes_total: {
    kind: 'counter',
    labels: {
      kind: ['command-output', 'git-diff'],
      status: ['written', 'accessed'],
    },
  },
  runtime_health: {
    kind: 'gauge',
    labels: { state: ['ready', 'restarting', 'failed', 'stopped'] },
  },
  disk_health: { kind: 'gauge', labels: { state: ['ready', 'failed'] } },
  authorization_decisions_total: {
    kind: 'counter',
    labels: {
      action: [
        'session',
        'turn',
        'event',
        'approval',
        'attachment',
        'artifact',
        'workspace',
        'usage',
        'audit',
        'metrics',
        'folder',
        'provider',
      ],
      outcome: ['allow', 'deny'],
      reason: [
        'ROLE_ALLOWED',
        'ROLE_DENIED',
        'UNKNOWN_ACTION',
        'RESOURCE_SCOPE_MISSING',
        'PRINCIPAL_KIND_MISMATCH',
        'MEMBERSHIP_INACTIVE',
        'WORKSPACE_MEMBERSHIP_MISSING',
      ],
    },
  },
} as const satisfies Record<string, MetricDefinition>

type MetricName = keyof typeof METRIC_DEFINITIONS
interface SeriesState {
  value: number
  count?: number
  sum?: number
  buckets?: Record<string, number>
}

export class BoundedMetricRecorder {
  readonly #now: () => Date
  readonly #series = new Map<
    string,
    { name: MetricName; labels: Record<string, string>; state: SeriesState }
  >()

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date())
  }

  record(
    name: MetricName,
    value: number,
    labels: Record<string, string>,
  ): void {
    if (!Number.isFinite(value) || value < 0)
      throw new Error('Metric value must be finite and non-negative')
    const definition = METRIC_DEFINITIONS[name]
    const expected = Object.keys(definition.labels).sort()
    if (JSON.stringify(Object.keys(labels).sort()) !== JSON.stringify(expected))
      throw new Error(`Invalid labels for ${name}`)
    for (const [key, label] of Object.entries(labels)) {
      const allowed = (definition.labels as Record<string, readonly string[]>)[
        key
      ]
      if (!allowed?.includes(label))
        throw new Error(`Unbounded metric label ${key}=${label}`)
    }
    const orderedLabels = Object.fromEntries(
      expected.map((key) => [key, labels[key]!]),
    )
    const key = JSON.stringify([name, orderedLabels])
    let current = this.#series.get(key)
    if (!current) {
      const state: SeriesState = { value: 0 }
      if ('buckets' in definition) {
        state.count = 0
        state.sum = 0
        state.buckets = Object.fromEntries(
          definition.buckets.map((bucket) => [String(bucket), 0]),
        )
      }
      current = { name, labels: orderedLabels, state }
      this.#series.set(key, current)
    }
    if (definition.kind === 'gauge') current.state.value = value
    else current.state.value += value
    if (definition.kind === 'histogram') {
      current.state.count! += 1
      current.state.sum! += value
      for (const bucket of definition.buckets)
        if (value <= bucket) current.state.buckets![String(bucket)]! += 1
    }
  }

  snapshot(): MetricsResponse {
    return metricsResponseSchema.parse({
      generatedAt: this.#now().toISOString(),
      series: [...this.#series.values()].map(({ name, labels, state }) => ({
        name,
        kind: METRIC_DEFINITIONS[name].kind,
        labels,
        ...state,
      })),
    })
  }
}

export function metricRoute(url: string): string {
  if (url === '/healthz') return 'healthz'
  if (url === '/readyz') return 'readyz'
  if (url === '/metrics') return 'metrics'
  if (url.includes('/audit')) return 'audit'
  if (url.includes('/approvals')) return 'approvals'
  if (url.includes('/turns')) return 'turns'
  if (url.includes('/artifacts')) return 'artifacts'
  if (url.includes('/git-snapshots')) return 'git'
  if (url.includes('/sessions')) return 'sessions'
  if (url.includes('/realtime')) return 'realtime'
  return 'other'
}
