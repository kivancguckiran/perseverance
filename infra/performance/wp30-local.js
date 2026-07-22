import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter, Rate } from 'k6/metrics'

const baseUrl = __ENV.WP30_TARGET_URL
const requestsA = new Counter('wp30_local_tenant_a')
const requestsB = new Counter('wp30_local_tenant_b')
const failures = new Rate('wp30_local_failures')
const headers = (tenant) => ({
  Authorization: `Bearer ${tenant.token}`,
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
  },
  {
    token: __ENV.WP30_TENANT_B_TOKEN,
    id: __ENV.WP30_TENANT_B_ID,
    organization: __ENV.WP30_TENANT_B_ORG_ID,
    workspace: __ENV.WP30_TENANT_B_WORKSPACE_ID,
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
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    wp30_local_failures: ['rate==0'],
    http_req_duration: ['p(95)<500'],
  },
}

export function flow() {
  const index = __VU % 2
  const response = http.get(
    `${baseUrl}/v1/workspaces/${tenants[index].workspace}`,
    { headers: headers(tenants[index]) },
  )
  const ok = check(response, {
    'tenant request accepted': (value) => value.status === 200,
  })
  failures.add(!ok)
  if (index === 0) requestsA.add(1)
  else requestsB.add(1)
  sleep(0.05)
}

export function handleSummary(data) {
  const a = data.metrics.wp30_local_tenant_a?.values?.count || 0
  const b = data.metrics.wp30_local_tenant_b?.values?.count || 0
  return {
    '/evidence/k6-local-summary.json': JSON.stringify({
      schemaVersion: 1,
      profile: 'poc-local-short',
      actualDurationSeconds: data.state.testRunDurationMs / 1000,
      tenantARequests: a,
      tenantBRequests: b,
      tenantFairnessRatio: Math.min(a, b) / Math.max(1, Math.max(a, b)),
      metrics: data.metrics,
    }),
  }
}
