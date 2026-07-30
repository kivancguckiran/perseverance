import { describe, expect, it } from 'vitest'
import {
  ProductionTelemetry,
  createTrace,
  traceparent,
} from '@perseverance/production-observability'
import { buildProductionControlPlane } from './production-server'

const scope = {
  tenantId: 'tenant-a',
  organizationId: 'tenant-a',
  workspaceId: 'workspace-a',
}

describe('WP27 production API telemetry integration', () => {
  it('correlates incoming trace without retaining scope plaintext', async () => {
    const telemetry = new ProductionTelemetry()
    const app = await buildProductionControlPlane({
      instanceId: 'api-test',
      telemetry,
      telemetryScopeSalt: 'wp27-test-scope-salt',
      repository: {
        pool: { query: async () => ({}) },
        close: async () => {},
      } as never,
      objectStore: { ready: async () => true } as never,
      broker: { ready: async () => true } as never,
      runtimeControlReadinessUrl: 'http://unused',
      kmsReadinessUrl: 'http://unused',
      requiredRegionId: 'eu-1',
      billing: {} as never,
      dependencyTimeoutMs: 1,
    })
    const parent = createTrace()
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: {
        ...Object.fromEntries(
          Object.entries(scope).map(([key, value]) => [
            `x-${key.replace('Id', '-id')}`,
            value,
          ]),
        ),
        traceparent: traceparent(parent),
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    const snapshot = JSON.stringify(telemetry.snapshot())
    expect(snapshot).toContain(parent.traceId)
    expect(snapshot).not.toContain('tenant-a')
    expect(snapshot).not.toContain('workspace-a')
    await app.close()
  })
})
