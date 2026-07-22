import http from 'k6/http'
import ws from 'k6/ws'
import { check, sleep } from 'k6'
import { Counter, Gauge, Rate, Trend } from 'k6/metrics'

const baseUrl = __ENV.WP30_TARGET_URL
const wsUrl = __ENV.WP30_REALTIME_URL
const duration = __ENV.WP30_LOAD_DURATION || '10m'
const soakDuration = __ENV.WP30_SOAK_DURATION || '2h'
const targetRate = Number(__ENV.WP30_TARGET_RATE || 50)
const tenantA = {
  token: __ENV.WP30_TENANT_A_TOKEN,
  tenant: __ENV.WP30_TENANT_A_ID,
  org: __ENV.WP30_TENANT_A_ORG_ID,
  workspace: __ENV.WP30_TENANT_A_WORKSPACE_ID,
}
const tenantB = {
  token: __ENV.WP30_TENANT_B_TOKEN,
  tenant: __ENV.WP30_TENANT_B_ID,
  org: __ENV.WP30_TENANT_B_ORG_ID,
  workspace: __ENV.WP30_TENANT_B_WORKSPACE_ID,
}

const apiFailures = new Rate('wp30_api_failures')
const eventLag = new Trend('wp30_event_lag_ms', true)
const objectBytes = new Counter('wp30_object_stream_bytes')
const tenantACompleted = new Counter('wp30_tenant_a_completed')
const tenantBCompleted = new Counter('wp30_tenant_b_completed')
const realtimeReconnects = new Counter('wp30_realtime_reconnects')
const backlog = new Gauge('wp30_backlog')
const processRssBytes = new Gauge('wp30_process_rss_bytes')
const providerRateLimitWait = new Trend(
  'wp30_provider_rate_limit_wait_ms',
  true,
)

export const options = {
  discardResponseBodies: false,
  scenarios: {
    api_and_scheduler: {
      executor: 'constant-arrival-rate',
      rate: targetRate,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: Math.max(20, targetRate),
      maxVUs: Math.max(100, targetRate * 4),
      exec: 'apiFlow',
    },
    realtime_mobile_reconnect: {
      executor: 'constant-vus',
      vus: Number(__ENV.WP30_REALTIME_VUS || 20),
      duration,
      exec: 'realtimeFlow',
    },
    corpus_and_objects: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.WP30_CORPUS_RATE || 5),
      timeUnit: '1s',
      duration,
      preAllocatedVUs: 10,
      maxVUs: 50,
      exec: 'corpusAndObjectFlow',
    },
    soak: {
      executor: 'constant-vus',
      vus: Number(__ENV.WP30_SOAK_VUS || 10),
      duration: soakDuration,
      startTime: duration,
      exec: 'apiFlow',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.005'],
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
    wp30_api_failures: ['rate<0.005'],
    wp30_event_lag_ms: ['p(95)<1000'],
    wp30_backlog: ['value==0'],
    wp30_provider_rate_limit_wait_ms: ['p(95)<2000'],
  },
}

const headers = (scope) => ({
  Authorization: `Bearer ${scope.token}`,
  'Content-Type': 'application/json',
  'X-Tenant-Id': scope.tenant,
  'X-Organization-Id': scope.org,
  'X-Workspace-Id': scope.workspace,
})

const chooseTenant = () => (__VU % 2 === 0 ? tenantA : tenantB)

export function apiFlow() {
  const tenant = chooseTenant()
  const response = http.get(`${baseUrl}/readyz`, { headers: headers(tenant) })
  const ok = check(response, { 'API ready': (r) => r.status === 200 })
  apiFailures.add(!ok)
  if (ok) {
    if (tenant === tenantA) tenantACompleted.add(1)
    else tenantBCompleted.add(1)
  }
  const metrics = http.get(`${baseUrl}/metrics`, { headers: headers(tenant) })
  if (metrics.status === 200) {
    const lag = /persistent_event_lag_ms[^\n]*\s([0-9.]+)/.exec(metrics.body)
    const pending = /persistent_scheduler_backlog[^\n]*\s([0-9.]+)/.exec(
      metrics.body,
    )
    const rss = /process_resident_memory_bytes[^\n]*\s([0-9.]+)/.exec(
      metrics.body,
    )
    const providerWait =
      /persistent_provider_rate_limit_wait_ms[^\n]*\s([0-9.]+)/.exec(
        metrics.body,
      )
    if (lag) eventLag.add(Number(lag[1]))
    if (pending) backlog.add(Number(pending[1]))
    if (rss) processRssBytes.add(Number(rss[1]))
    if (providerWait) providerRateLimitWait.add(Number(providerWait[1]))
  }
  sleep(0.05)
}

export function realtimeFlow() {
  const tenant = chooseTenant()
  const response = ws.connect(wsUrl, { headers: headers(tenant) }, (socket) => {
    socket.on('open', () => {
      realtimeReconnects.add(1)
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          workspaceId: tenant.workspace,
          after: 0,
        }),
      )
    })
    socket.on('message', (message) => {
      const parsed = JSON.parse(message)
      if (parsed.occurredAt)
        eventLag.add(Math.max(0, Date.now() - Date.parse(parsed.occurredAt)))
    })
    socket.setTimeout(() => socket.close(), 2_000)
  })
  check(response, { 'realtime upgraded': (r) => r?.status === 101 })
}

export function corpusAndObjectFlow() {
  const tenant = chooseTenant()
  const corpus = http.post(
    `${baseUrl}/v1/corpus/search`,
    JSON.stringify({ query: 'bounded readiness probe', limit: 5 }),
    { headers: headers(tenant) },
  )
  apiFailures.add(corpus.status !== 200)
  const objectId = __ENV.WP30_OBJECT_ID
  if (objectId) {
    const object = http.get(`${baseUrl}/v1/artifacts/${objectId}/content`, {
      headers: { ...headers(tenant), Range: 'bytes=0-65535' },
    })
    check(object, {
      'object range streamed': (r) => [200, 206].includes(r.status),
    })
    objectBytes.add(object.body?.length || 0)
  }
}

export function handleSummary(data) {
  const a = data.metrics.wp30_tenant_a_completed?.values?.count || 0
  const b = data.metrics.wp30_tenant_b_completed?.values?.count || 0
  const fairness = Math.min(a, b) / Math.max(1, Math.max(a, b))
  return {
    '/evidence/k6-summary.json': JSON.stringify({
      schemaVersion: 1,
      tool: 'k6',
      metrics: data.metrics,
      tenantFairnessRatio: fairness,
      soakDuration,
    }),
  }
}
