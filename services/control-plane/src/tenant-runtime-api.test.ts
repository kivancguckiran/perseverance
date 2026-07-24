import { describe, expect, it } from 'vitest'
import { ZERO_CAPACITY } from '@persistent-codex/production-topology'
import {
  InMemoryTenantRuntimeRepository,
  InMemoryTenantRuntimeResources,
  RuntimeDataPlaneAuthority,
  TenantProvisioningService,
} from '@persistent-codex/tenant-runtime'
import { buildTenantRuntimeApi } from './tenant-runtime-api'

const capacity = { ...ZERO_CAPACITY, cpuMillis: 1_000, memoryBytes: 1_000_000 }

function harness(profile: 'cloud' | 'self-hosted' = 'cloud') {
  const repository = new InMemoryTenantRuntimeRepository()
  const resources = new InMemoryTenantRuntimeResources()
  const service = new TenantProvisioningService({ repository, resources })
  const authority = new RuntimeDataPlaneAuthority({ repository })
  const app = buildTenantRuntimeApi({ profile, repository, service, authority })
  return { app, repository, service, authority }
}

const scopeHeaders = {
  'x-tenant-id': 'ten_a',
  'x-organization-id': 'ten_a',
}

const provisionPayload = {
  workspaceId: 'wsp_main',
  displayName: 'Tenant A',
  regionId: 'region-1',
  capacity,
  retentionDays: 45,
  domain: 'ten-a.example.test',
}

describe('tenant runtime API', () => {
  it('cloud profilinde tenant provision eder ve metadata döner', async () => {
    const { app } = harness()
    const created = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: { ...scopeHeaders, 'idempotency-key': 'prov:1' },
      payload: provisionPayload,
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().tenant.state).toBe('active')

    const fetched = await app.inject({
      method: 'GET',
      url: '/v1/tenants/ten_a',
      headers: scopeHeaders,
    })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.json()).toMatchObject({
      domain: 'ten-a.example.test',
      regionId: 'region-1',
      retentionDays: 45,
      capacity: { cpuMillis: 1_000 },
    })

    const runtime = await app.inject({
      method: 'GET',
      url: '/v1/tenants/ten_a/runtimes/wsp_main',
      headers: scopeHeaders,
    })
    expect(runtime.json()).toMatchObject({
      state: 'ready',
      volumeEncrypted: true,
      generation: 1,
    })
  })

  it('suspend/resume/reconcile uçları çalışır', async () => {
    const { app } = harness()
    await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: scopeHeaders,
      payload: provisionPayload,
    })
    const suspended = await app.inject({
      method: 'POST',
      url: '/v1/tenants/ten_a/suspend',
      headers: scopeHeaders,
    })
    expect(suspended.json().tenant.state).toBe('suspended')
    const reconciled = await app.inject({
      method: 'POST',
      url: '/v1/tenants/ten_a/reconcile',
      headers: scopeHeaders,
    })
    expect(reconciled.json().converged).toBe(true)
    const resumed = await app.inject({
      method: 'POST',
      url: '/v1/tenants/ten_a/resume',
      headers: scopeHeaders,
    })
    expect(resumed.json().tenant.state).toBe('active')
  })

  it('cloud dışı profillerde entitlement deny-by-default 403 döner', async () => {
    const { app } = harness('self-hosted')
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: scopeHeaders,
      payload: provisionPayload,
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe(
      'ENTITLEMENT_DENIED:self-hosted:cloud.managed-tenant-provisioning',
    )
  })

  it('tenant scope başlığı olmadan istekler reddedilir', async () => {
    const { app } = harness()
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/ten_a',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('MISSING_TENANT_SCOPE')
  })

  it('runtime credential ucu kısa ömürlü token basar; verify deny-by-default çalışır', async () => {
    const { app } = harness()
    await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: scopeHeaders,
      payload: provisionPayload,
    })
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/runtime/credentials',
      headers: scopeHeaders,
      payload: {
        workspaceId: 'wsp_main',
        runtimeId: 'rt_ten_a_wsp_main_g1',
        generation: 1,
      },
    })
    expect(issued.statusCode).toBe(201)
    const token = issued.json().accessToken as string

    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/runtime/verify',
      headers: { ...scopeHeaders, authorization: `Bearer ${token}` },
      payload: { workspaceId: 'wsp_main', action: 'event.append' },
    })
    expect(allowed.json()).toMatchObject({ allowed: true })

    // Kimliksiz istek 401.
    const anonymous = await app.inject({
      method: 'POST',
      url: '/v1/runtime/verify',
      headers: scopeHeaders,
      payload: { workspaceId: 'wsp_main', action: 'event.append' },
    })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json().error).toBe('RUNTIME_AUTH_REQUIRED')

    // Yanlış-tenant istek 403.
    const crossTenant = await app.inject({
      method: 'POST',
      url: '/v1/runtime/verify',
      headers: {
        'x-tenant-id': 'ten_b',
        'x-organization-id': 'ten_b',
        authorization: `Bearer ${token}`,
      },
      payload: { workspaceId: 'wsp_main', action: 'event.append' },
    })
    expect(crossTenant.statusCode).toBe(403)
    expect(crossTenant.json().error).toBe('RUNTIME_SCOPE_REJECTED')
  })

  it('kapasite bütçesi API üzerinden yazılır ve okunan tenant metadata ile uyumludur', async () => {
    const { app, repository } = harness()
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/tenants/ten_a/capacity-budget',
      headers: scopeHeaders,
      payload: {
        reservedCapacity: capacity,
        queueLatencyBudgetMs: 30_000,
        maxStarvationPosition: 8,
        version: 1,
      },
    })
    expect(response.statusCode).toBe(200)
    const stored = await repository.getCapacityBudget({
      tenantId: 'ten_a',
      organizationId: 'ten_a',
    })
    expect(stored?.queueLatencyBudgetMs).toBe(30_000)
  })
})
