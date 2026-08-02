import { describe, expect, it } from 'vitest'
import { BoundedMetricRecorder, METRIC_DEFINITIONS } from './metrics'

describe('bounded metrics', () => {
  it('uses an injectable clock and bounded allowlisted labels', () => {
    const recorder = new BoundedMetricRecorder({
      now: () => new Date('2026-07-15T10:00:00.000Z'),
    })
    recorder.record('api_request_latency_ms', 12, {
      route: 'sessions',
      method: 'GET',
      status: '2xx',
    })
    recorder.record('api_request_latency_ms', 30, {
      route: 'sessions',
      method: 'GET',
      status: '2xx',
    })
    expect(recorder.snapshot()).toMatchObject({
      generatedAt: '2026-07-15T10:00:00.000Z',
      series: [{ name: 'api_request_latency_ms', count: 2, sum: 42 }],
    })
    expect(() =>
      recorder.record('api_errors_total', 1, {
        route: 'sessions',
        code: 'secret-session-id',
      }),
    ).toThrow(/Unbounded metric label/)
    expect(() =>
      recorder.record('api_errors_total', 1, {
        route: 'sessions',
        code: '4xx',
        tenantId: 'ten_secret',
      }),
    ).toThrow(/Invalid labels/)
  })

  it('keeps the complete metric label schema free of high-cardinality fields', () => {
    const serialized = JSON.stringify(
      Object.values(METRIC_DEFINITIONS).map((definition) => definition.labels),
    )
    for (const forbidden of [
      'tenantId',
      'workspaceId',
      'sessionId',
      'turnId',
      'requestId',
      'path',
      'prompt',
      'token',
      'credential',
    ])
      expect(serialized).not.toContain(forbidden)
  })
})
