import { describe, expect, it } from 'vitest'
import { ZERO_CAPACITY } from '@persistent-codex/production-topology'
import {
  DomainVerificationService,
  InMemoryManagedCloudRepository,
  ManagedCloudError,
  ManagedCloudLifecycleService,
  ManagedCloudOnboardingService,
  evaluateManagedCloudLimits,
  type DurableTaskPort,
  type ManagedCloudPlan,
  type ManagedUsageEntry,
} from '@persistent-codex/managed-cloud'
import {
  InMemoryTenantRuntimeRepository,
  InMemoryTenantRuntimeResources,
  TenantProvisioningService,
} from '@persistent-codex/tenant-runtime'
import { buildProductionControlPlane } from './production-server'

const plan: ManagedCloudPlan = {
  schemaVersion: 1,
  planId: 'limited-beta',
  planVersion: 1,
  displayName: 'Limited Beta',
  currency: 'USD',
  entitlements: [
    'cloud.managed-tenant-provisioning',
    'cloud.tenant-runtime-isolation',
    'cloud.tenant-capacity-budgets',
    'cloud.runtime-data-plane-credentials',
    'core.provider-adapters',
    'core.detached-runs',
  ],
  computeQuota: { ...ZERO_CAPACITY, cpuMillis: 100 },
  storageQuotaBytes: 1_000,
  monthlyBudgetMicros: 5_000,
}

async function productionApi() {
  const repository = new InMemoryManagedCloudRepository()
  const usage: ManagedUsageEntry[] = []
  const workspaceOwners = new Map<string, string>()
  const tasks: DurableTaskPort = {
    async start(input) {
      workspaceOwners.set(input.scope.workspaceId, 'user-a')
      return { taskId: 'task-mobile', state: 'running' }
    },
    async replay(scope, taskId) {
      if (
        taskId !== 'task-mobile' ||
        workspaceOwners.get(scope.workspaceId) !== 'user-a'
      )
        throw new ManagedCloudError('TASK_NOT_FOUND')
      return { taskId, state: 'completed', output: 'durable output' }
    },
  }
  const onboarding = new ManagedCloudOnboardingService({
    repository,
    accounts: {
      async ensure(input) {
        workspaceOwners.set(input.scope.workspaceId, input.subject)
      },
    },
    provisioning: new TenantProvisioningService({
      repository: new InMemoryTenantRuntimeRepository(),
      resources: new InMemoryTenantRuntimeResources(),
    }),
    providers: {
      async ensureConnected(input) {
        return {
          schemaVersion: 1,
          ...input.scope,
          profileId: input.profileId!,
          provider: input.provider,
          authMode: input.authMode,
          state: 'active',
          credentialVersion: 1,
          expiresAt: null,
          revokedAt: null,
          disconnectedAt: null,
          cryptoErasedAt: null,
          version: 1,
        }
      },
    },
    tasks,
    rollout: { assertAdmission() {} },
    commercial: {
      async assignPlan() {},
      async admitFirstTask({ plan: assigned }) {
        return evaluateManagedCloudLimits({
          plan: assigned,
          usage,
          requestedCompute: assigned.computeQuota,
          requestedStorageBytes: 0,
        })
      },
    },
    catalog: {
      async resolve(planId, planVersion) {
        if (planId !== plan.planId || planVersion !== plan.planVersion)
          throw new ManagedCloudError('PLAN_NOT_FOUND')
        return plan
      },
    },
  })
  const lifecycle = new ManagedCloudLifecycleService({
    lifecycle: {
      async exportTenant() {
        return { jobId: 'export', state: 'requested' }
      },
      async deleteTenant() {
        return { jobId: 'delete', state: 'requested' }
      },
    },
    credentials: {
      async listProfiles() {
        return []
      },
      async revoke() {},
      async cryptoErase() {},
    },
    tenants: {
      async deleteTenant() {
        return { tenant: { state: 'deleted' } }
      },
    },
  })
  const app = await buildProductionControlPlane({
    instanceId: 'wp35-production-test',
    repository: {
      pool: { query: async () => ({ rowCount: 1, rows: [] }) },
      listOutbox: async () => [],
      markOutboxPublished: async () => {},
    } as never,
    objectStore: { ready: async () => true } as never,
    broker: { ready: async () => true } as never,
    runtimeControlReadinessUrl: 'http://unused',
    kmsReadinessUrl: 'http://unused',
    requiredRegionId: 'eu-1',
    billing: {} as never,
    authentication: {
      async authenticate(input) {
        const token = input.authorization?.replace('Bearer ', '')
        if (token !== 'user-a' && token !== 'user-b' && token !== 'viewer-a')
          throw new ManagedCloudError('AUTH_REQUIRED')
        return {
          version: 1,
          kind: 'end_user',
          issuer: 'https://identity.example.test',
          subject: token,
          audience: ['wp35'],
          authenticatedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2030-01-01T00:00:00.000Z',
          assurance: { level: 'mfa', mfa: true },
          memberships: [],
        }
      },
    },
    managedCloud: {
      onboarding,
      usage: {
        async listUsage() {
          return usage
        },
      },
      domains: new DomainVerificationService(repository),
      tasks,
      lifecycle,
      authorization: {
        async resolveWorkspace(
          principal: { issuer: string; subject: string },
          workspaceId: string,
          action: 'read' | 'manage-domain' | 'export' | 'delete',
        ) {
          const owner = workspaceOwners.get(workspaceId)
          if (
            owner !== principal.subject &&
            !(principal.subject === 'viewer-a' && owner === 'user-a')
          )
            throw new ManagedCloudError('WORKSPACE_ACCESS_DENIED')
          if (principal.subject === 'viewer-a' && action !== 'read')
            throw new ManagedCloudError('WORKSPACE_ACTION_DENIED')
          return {
            tenantId: `tenant-${principal.subject}`,
            organizationId: `tenant-${principal.subject}`,
            workspaceId,
          }
        },
      },
    } as never,
  })
  return app
}

describe('managed cloud production plugin', () => {
  it('production server üzerinde trusted principal ile onboarding ve replay yapar', async () => {
    const app = await productionApi()
    const response = await app.inject({
      method: 'POST',
      url: '/v1/managed-cloud/onboarding',
      headers: {
        authorization: 'Bearer user-a',
        'idempotency-key': 'mobile-signup',
      },
      payload: {
        displayName: 'Mobile',
        workspaceName: 'Phone',
        regionId: 'eu-1',
        planId: 'limited-beta',
        planVersion: 1,
        provider: 'claude',
        authMode: 'customer-api-key',
        accessToken: 'credential-material-for-test',
        firstTaskPrompt: 'continue while closed',
      },
    })
    expect(response.statusCode, response.body).toBe(201)
    expect(response.body).not.toContain('credential-material-for-test')
    const created = response.json()
    const replay = await app.inject({
      method: 'GET',
      url: `/v1/managed-cloud/workspaces/${created.workspaceId}/tasks/${created.firstTaskId}/replay`,
      headers: { authorization: 'Bearer user-a' },
    })
    expect(replay.json()).toEqual({
      taskId: 'task-mobile',
      state: 'completed',
      output: 'durable output',
    })
    await app.close()
  })

  it('usage/domain/replay/export/delete cross-tenant saldırılarını reddeder', async () => {
    const app = await productionApi()
    const created = (
      await app.inject({
        method: 'POST',
        url: '/v1/managed-cloud/onboarding',
        headers: {
          authorization: 'Bearer user-a',
          'idempotency-key': 'adversarial-signup',
        },
        payload: {
          displayName: 'Tenant A',
          workspaceName: 'Workspace A',
          regionId: 'eu-1',
          planId: 'limited-beta',
          planVersion: 1,
          provider: 'claude',
          authMode: 'customer-api-key',
          accessToken: 'credential-material-for-test',
          firstTaskPrompt: 'durable',
        },
      })
    ).json()
    const base = `/v1/managed-cloud/workspaces/${created.workspaceId}`
    const attacks = [
      { method: 'GET', url: `${base}/usage` },
      {
        method: 'POST',
        url: `${base}/domains`,
        payload: { domain: 'evil.example.test' },
      },
      {
        method: 'POST',
        url: `${base}/domains/verify`,
        payload: { observedChallenge: 'forged' },
      },
      { method: 'GET', url: `${base}/tasks/${created.firstTaskId}/replay` },
      {
        method: 'POST',
        url: `${base}/lifecycle/export`,
        payload: { idempotencyKey: 'attack-export' },
      },
      {
        method: 'POST',
        url: `${base}/lifecycle/delete`,
        payload: { idempotencyKey: 'attack-delete' },
      },
    ] as const
    for (const attack of attacks) {
      const response = await app.inject({
        ...attack,
        headers: {
          authorization: 'Bearer user-b',
          'x-tenant-id': created.tenantId,
          'x-organization-id': created.organizationId,
          'x-workspace-id': created.workspaceId,
        },
      })
      expect(response.statusCode, `${attack.method} ${attack.url}`).toBe(403)
      expect(response.json()).toEqual({ code: 'WORKSPACE_ACCESS_DENIED' })
    }
    for (const attack of attacks) {
      const anonymous = await app.inject(attack)
      expect(anonymous.statusCode, `${attack.method} ${attack.url}`).toBe(401)
    }
    const viewerRead = await app.inject({
      method: 'GET',
      url: `${base}/usage`,
      headers: { authorization: 'Bearer viewer-a' },
    })
    expect(viewerRead.statusCode).toBe(200)
    for (const path of [
      `${base}/domains`,
      `${base}/domains/verify`,
      `${base}/lifecycle/export`,
      `${base}/lifecycle/delete`,
    ]) {
      const viewerMutation = await app.inject({
        method: 'POST',
        url: path,
        headers: { authorization: 'Bearer viewer-a' },
        payload: path.endsWith('/domains')
          ? { domain: 'viewer.example.test' }
          : path.endsWith('/verify')
            ? { observedChallenge: 'forged' }
            : { idempotencyKey: 'viewer-denied' },
      })
      expect(viewerMutation.statusCode, path).toBe(403)
      expect(viewerMutation.json()).toEqual({
        code: 'WORKSPACE_ACTION_DENIED',
      })
    }
    for (const operation of ['reservations', 'settlements', 'refunds']) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/managed-cloud/credits/${operation}`,
        headers: { authorization: 'Bearer user-a' },
        payload: {
          workspaceId: created.workspaceId,
          reservationId: 'forged',
          measuredCreditsMicros: 0,
        },
      })
      expect(response.statusCode).toBe(404)
    }
    await app.close()
  })

  it('client-supplied plan policy alanlarını ve bilinmeyen planı reddeder', async () => {
    const app = await productionApi()
    const forgedPolicy = await app.inject({
      method: 'POST',
      url: '/v1/managed-cloud/onboarding',
      headers: {
        authorization: 'Bearer user-a',
        'idempotency-key': 'forged-plan',
      },
      payload: {
        displayName: 'Forged',
        workspaceName: 'Forged',
        regionId: 'eu-1',
        planId: 'limited-beta',
        planVersion: 1,
        plan,
        computeQuota: { cpuMillis: Number.MAX_SAFE_INTEGER },
        monthlyBudgetMicros: Number.MAX_SAFE_INTEGER,
        provider: 'claude',
        authMode: 'customer-api-key',
        accessToken: 'credential-material-for-test',
        firstTaskPrompt: 'attack',
      },
    })
    expect(forgedPolicy.statusCode).toBe(400)
    expect(forgedPolicy.json()).toEqual({ code: 'INVALID_REQUEST' })
    const unknownPlan = await app.inject({
      method: 'POST',
      url: '/v1/managed-cloud/onboarding',
      headers: {
        authorization: 'Bearer user-a',
        'idempotency-key': 'unknown-plan',
      },
      payload: {
        displayName: 'Unknown',
        workspaceName: 'Unknown',
        regionId: 'eu-1',
        planId: 'attacker-plan',
        planVersion: 999,
        provider: 'claude',
        authMode: 'customer-api-key',
        accessToken: 'credential-material-for-test',
        firstTaskPrompt: 'attack',
      },
    })
    expect(unknownPlan.statusCode).toBe(404)
    expect(unknownPlan.json()).toEqual({ code: 'PLAN_NOT_FOUND' })
    await app.close()
  })
})
