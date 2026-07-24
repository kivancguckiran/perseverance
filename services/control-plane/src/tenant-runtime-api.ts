import Fastify from 'fastify'
import {
  DeploymentProfileError,
  assertEntitled,
  type DeploymentProfile,
} from '@persistent-codex/deployment-profiles'
import {
  TenantRuntimeError,
  tenantCapacityBudgetSchema,
  TENANT_RUNTIME_CONTRACT_VERSION,
  type RuntimeDataPlaneAction,
  type RuntimeDataPlaneAuthority,
  type TenantProvisioningService,
  type TenantRuntimeRepository,
} from '@persistent-codex/tenant-runtime'
import { capacityVectorSchema } from '@persistent-codex/production-topology/contracts'
import { z } from 'zod'

// WP33 — managed tenant runtime admin/internal API'si (ADR-0033).
// WP28 `buildEnterpriseApi` deseniyle standalone composition seam'i olarak
// kurulur; WP35 SaaS onboarding'i bu yüzeyin üstüne oturur. Tenant metadata
// (domain/region/retention/capacity) persistence katmanına buradan bağlanır.

type Scope = { tenantId: string; organizationId: string }

const scopeFrom = (headers: Record<string, unknown>): Scope => {
  const tenantId = headers['x-tenant-id'],
    organizationId = headers['x-organization-id']
  if (typeof tenantId !== 'string' || typeof organizationId !== 'string')
    throw new TenantRuntimeError('MISSING_TENANT_SCOPE')
  return { tenantId, organizationId }
}

const provisionBodySchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
  displayName: z.string().trim().min(1).max(255),
  regionId: z.string().trim().min(1).max(255),
  capacity: capacityVectorSchema,
  retentionDays: z.number().int().min(1).max(3650).optional(),
  retentionPolicyId: z.string().trim().min(1).max(255).nullish(),
  domain: z.string().trim().min(1).max(255).nullish(),
})

const credentialBodySchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
  runtimeId: z.string().trim().min(1).max(255),
  generation: z.number().int().positive(),
  ttlMs: z.number().int().positive().optional(),
})

export function buildTenantRuntimeApi(options: {
  profile: DeploymentProfile
  repository: TenantRuntimeRepository
  service: TenantProvisioningService
  authority: RuntimeDataPlaneAuthority
}) {
  const app = Fastify({ logger: false })
  const { profile, repository, service, authority } = options

  app.setErrorHandler((error, _request, reply) => {
    const code =
      error instanceof TenantRuntimeError ||
      error instanceof DeploymentProfileError
        ? error.code
        : 'TENANT_RUNTIME_REQUEST_INVALID'
    const status = code.startsWith('ENTITLEMENT_DENIED')
      ? 403
      : code === 'RUNTIME_AUTH_REQUIRED'
        ? 401
        : code.startsWith('RUNTIME_TOKEN') || code.startsWith('RUNTIME_SCOPE')
          ? 403
          : code === 'MISSING_TENANT_SCOPE'
            ? 400
            : code.includes('NOT_FOUND')
              ? 404
              : code.includes('CONFLICT') || code.includes('BUDGET_ERODED')
                ? 409
                : 400
    void reply.status(status).send({ error: code })
  })

  // Managed tenant provisioning yalnız cloud profilinde entitled'dır
  // (deny-by-default entitlement policy, ADR-0033).
  const requireEntitlement = () =>
    assertEntitled(profile, 'cloud.managed-tenant-provisioning')

  app.post('/v1/tenants', async (request, reply) => {
    requireEntitlement()
    const scope = scopeFrom(request.headers)
    const body = provisionBodySchema.parse(request.body)
    const idempotencyKey = String(
      request.headers['idempotency-key'] ?? `provision:${body.workspaceId}`,
    )
    const result = await service.provisionTenant({
      ...scope,
      workspaceId: body.workspaceId,
      displayName: body.displayName,
      regionId: body.regionId,
      capacity: body.capacity,
      ...(body.retentionDays !== undefined
        ? { retentionDays: body.retentionDays }
        : {}),
      retentionPolicyId: body.retentionPolicyId ?? null,
      domain: body.domain ?? null,
      idempotencyKey,
    })
    return reply.status(201).send(result)
  })

  app.get('/v1/tenants/:tenantId', async (request) => {
    requireEntitlement()
    const scope = scopeFrom(request.headers)
    const tenant = await repository.getTenant(scope)
    if (!tenant) throw new TenantRuntimeError('TENANT_NOT_FOUND')
    return tenant
  })

  app.get('/v1/tenants/:tenantId/runtimes/:workspaceId', async (request) => {
    requireEntitlement()
    const scope = scopeFrom(request.headers)
    const { workspaceId } = request.params as { workspaceId: string }
    const runtime = await repository.getRuntime(scope, workspaceId)
    if (!runtime) throw new TenantRuntimeError('TENANT_RUNTIME_NOT_FOUND')
    return runtime
  })

  for (const operation of ['suspend', 'resume', 'delete'] as const) {
    app.post(`/v1/tenants/:tenantId/${operation}`, async (request) => {
      requireEntitlement()
      const scope = scopeFrom(request.headers)
      const idempotencyKey = String(
        request.headers['idempotency-key'] ?? `${operation}:${scope.tenantId}`,
      )
      const method =
        operation === 'suspend'
          ? service.suspendTenant.bind(service)
          : operation === 'resume'
            ? service.resumeTenant.bind(service)
            : service.deleteTenant.bind(service)
      const { tenant } = await method({ ...scope, idempotencyKey })
      return { tenant }
    })
  }

  app.post('/v1/tenants/:tenantId/reconcile', async (request) => {
    requireEntitlement()
    const scope = scopeFrom(request.headers)
    return service.reconcile(scope)
  })

  app.put('/v1/tenants/:tenantId/capacity-budget', async (request) => {
    requireEntitlement()
    const scope = scopeFrom(request.headers)
    const budget = tenantCapacityBudgetSchema.parse({
      schemaVersion: TENANT_RUNTIME_CONTRACT_VERSION,
      ...scope,
      ...(request.body as Record<string, unknown>),
    })
    const existing = await repository.getCapacityBudget(scope)
    await repository.putCapacityBudget(budget, existing?.version ?? null)
    return budget
  })

  // Runtime data plane credential ucu: kısa ömürlü, tenant-scoped.
  app.post('/v1/runtime/credentials', async (request, reply) => {
    requireEntitlement()
    const scope = scopeFrom(request.headers)
    const body = credentialBodySchema.parse(request.body)
    const issued = await authority.issue({
      ...scope,
      workspaceId: body.workspaceId,
      runtimeId: body.runtimeId,
      generation: body.generation,
      ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
    })
    // Plaintext token yalnız yanıtın içindedir; durable kayıt digest taşır.
    return reply.status(201).send(issued)
  })

  // Data-plane doğrulama ucu: deny-by-default. Kimliksiz veya yanlış-tenant
  // istekler typed hata ile reddedilir.
  app.post('/v1/runtime/verify', async (request) => {
    requireEntitlement()
    const scope = scopeFrom(request.headers)
    const body = request.body as {
      workspaceId?: string
      action?: RuntimeDataPlaneAction
    }
    if (!body?.workspaceId || !body?.action)
      throw new TenantRuntimeError('RUNTIME_SCOPE_REJECTED')
    const claims = await authority.verify({
      authorization:
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined,
      action: body.action,
      ...scope,
      workspaceId: body.workspaceId,
    })
    return { allowed: true, credentialId: claims.credentialId }
  })

  return app
}
