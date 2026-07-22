import http from 'k6/http'
import ws from 'k6/ws'
import { check, sleep } from 'k6'
import { Counter, Rate } from 'k6/metrics'

const baseUrl = __ENV.WP30_TARGET_URL
const requestsA = new Counter('wp30_local_tenant_a')
const requestsB = new Counter('wp30_local_tenant_b')
const failures = new Rate('wp30_local_failures')
const headers = (tenant) => ({
  Authorization: `Bearer ${tenant.token}`,
  'Content-Type': 'application/json',
  'X-Tenant-Id': tenant.id,
  'X-Organization-Id': tenant.organization,
  'X-Workspace-Id': tenant.workspace,
})
const tenants = [
  {
    token: __ENV.WP30_TENANT_A_TOKEN,
    id: __ENV.WP30_TENANT_A_ID,
    organization: __ENV.WP30_TENANT_A_ORG_ID,
    workspace: __ENV.WP30_TENANT_A_WORKSPACE_ID,
    artifact: __ENV.WP30_OBJECT_A_ID,
  },
  {
    token: __ENV.WP30_TENANT_B_TOKEN,
    id: __ENV.WP30_TENANT_B_ID,
    organization: __ENV.WP30_TENANT_B_ORG_ID,
    workspace: __ENV.WP30_TENANT_B_WORKSPACE_ID,
    artifact: __ENV.WP30_OBJECT_ID,
  },
]

export const options = {
  scenarios: {
    load: {
      executor: 'constant-vus',
      vus: Number(__ENV.WP30_LOCAL_VUS || 4),
      duration: __ENV.WP30_LOAD_DURATION || '20s',
      exec: 'flow',
    },
    soak: {
      executor: 'constant-vus',
      vus: 2,
      duration: __ENV.WP30_SOAK_DURATION || '30s',
      startTime: __ENV.WP30_LOAD_DURATION || '20s',
      exec: 'flow',
    },
    realtime: {
      executor: 'per-vu-iterations',
      vus: 2,
      iterations: 1,
      exec: 'realtime',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    wp30_local_failures: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
}

export function setup() {
  return {
    sessions: tenants.map((tenant, index) => {
      const created = http.post(`${baseUrl}/v1/sessions`, '{}', {
        headers: headers(tenant),
      })
      check(created, {
        'real session created': (value) => value.status === 201,
      })
      const sessionId = created.json('sessionId')
      const turn = http.post(
        `${baseUrl}/v1/sessions/${sessionId}/turns`,
        JSON.stringify({ prompt: `WP30 scheduler probe tenant ${index}` }),
        {
          headers: {
            ...headers(tenant),
            'Idempotency-Key': `k6-scheduler-${index}-${Date.now()}`,
          },
        },
      )
      check(turn, { 'scheduler job queued': (value) => value.status === 202 })
      return sessionId
    }),
  }
}

export function flow(data) {
  const index = (__VU + __ITER) % 2
  const tenant = tenants[index]
  const params = { headers: headers(tenant) }
  const responses = http.batch([
    ['GET', `${baseUrl}/v1/workspaces/${tenant.workspace}`, null, params],
    ['GET', `${baseUrl}/v1/sessions/${data.sessions[index]}`, null, params],
    [
      'GET',
      `${baseUrl}/v1/sessions/${data.sessions[index]}/events?after=0&limit=100`,
      null,
      params,
    ],
    ['GET', `${baseUrl}/v1/artifacts/${tenant.artifact}`, null, params],
  ])
  const ok = check(responses, {
    'api realtime scheduler object flow accepted': (values) =>
      values.every((value) => value.status === 200),
  })
  failures.add(!ok)
  if (index === 0) requestsA.add(1)
  else requestsB.add(1)
  sleep(0.05)
}

export function realtime(data) {
  const index = (__VU - 1) % 2
  const tenant = tenants[index]
  const url = baseUrl.replace(/^http/, 'ws') + '/v1/realtime'
  const response = ws.connect(url, {}, (socket) => {
    socket.on('open', () =>
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          accessToken: tenant.token,
          tenantId: tenant.id,
          organizationId: tenant.organization,
          workspaceId: tenant.workspace,
          sessionId: data.sessions[index],
          afterSequence: 0,
        }),
      ),
    )
    socket.on('message', () => socket.close())
    socket.setTimeout(() => socket.close(), 3000)
  })
  check(response, { 'realtime upgraded': (value) => value?.status === 101 })
}

export function handleSummary(data) {
  const a = data.metrics.wp30_local_tenant_a?.values?.count || 0
  const b = data.metrics.wp30_local_tenant_b?.values?.count || 0
  return {
    '/evidence/k6-local-summary.json': JSON.stringify({
      schemaVersion: 1,
      profile: 'real-service-local-short',
      actualDurationSeconds: data.state.testRunDurationMs / 1000,
      tenantARequests: a,
      tenantBRequests: b,
      tenantFairnessRatio: Math.min(a, b) / Math.max(1, Math.max(a, b)),
      metrics: data.metrics,
    }),
  }
}
