import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  ManagedCloudError,
  managedCloudOnboardingRequestSchema,
  managedUsageEntrySchema,
  type DomainVerificationService,
  type DurableTaskPort,
  type ManagedCloudLifecycleService,
  type ManagedCloudOnboardingService,
  type ManagedCloudScope,
  type ManagedCloudUsageViewPort,
} from '@persistent-codex/managed-cloud'

export interface ManagedCloudAuthenticatedPrincipal {
  issuer: string
  subject: string
}

export type ManagedCloudWorkspaceAction =
  'read' | 'manage-domain' | 'export' | 'delete'

export interface ManagedCloudAuthorizationPort {
  resolveWorkspace(
    principal: ManagedCloudAuthenticatedPrincipal,
    workspaceId: string,
    action: ManagedCloudWorkspaceAction,
  ): Promise<ManagedCloudScope>
}

const id = z.string().trim().min(1).max(255)

export function registerManagedCloudRoutes(
  app: FastifyInstance,
  options: {
    onboarding: ManagedCloudOnboardingService
    usage: ManagedCloudUsageViewPort
    domains: DomainVerificationService
    tasks: DurableTaskPort
    lifecycle: ManagedCloudLifecycleService
    authorization: ManagedCloudAuthorizationPort
    overview: {
      get(scope: ManagedCloudScope): Promise<unknown>
    }
    principalFor(request: FastifyRequest): ManagedCloudAuthenticatedPrincipal
  },
) {
  const principal = (request: FastifyRequest) => {
    const value = options.principalFor(request)
    if (!value) throw new ManagedCloudError('AUTH_REQUIRED')
    return value
  }
  const scope = (
    request: FastifyRequest,
    workspaceId: string,
    action: ManagedCloudWorkspaceAction,
  ) =>
    options.authorization.resolveWorkspace(
      principal(request),
      workspaceId,
      action,
    )

  app.post('/v1/managed-cloud/onboarding', async (request, reply) => {
    const body = managedCloudOnboardingRequestSchema.parse({
      ...(request.body as object),
      idempotencyKey:
        request.headers['idempotency-key'] ??
        (request.body as { idempotencyKey?: string }).idempotencyKey,
    })
    const result = await options.onboarding.run({
      ...body,
      principal: principal(request),
    })
    return reply.status(201).send(result)
  })

  app.get<{
    Params: { workspaceId: string }
  }>('/v1/managed-cloud/workspaces/:workspaceId/usage', async (request) => {
    const authorized = await scope(request, request.params.workspaceId, 'read')
    const usage = (await options.usage.listUsage(authorized)).map((entry) =>
      managedUsageEntrySchema.parse(entry),
    )
    return {
      usage,
      totals: {
        hostingMicros: total(usage, 'hosting'),
        computeMicros: total(usage, 'compute'),
        storageMicros: total(usage, 'storage'),
        modelMicros: total(usage, 'model'),
      },
      estimatesAreNotInvoices: true,
    }
  })

  app.get<{
    Params: { workspaceId: string }
  }>('/v1/managed-cloud/workspaces/:workspaceId/overview', async (request) => {
    const authorized = await scope(request, request.params.workspaceId, 'read')
    return options.overview.get(authorized)
  })

  app.post<{
    Params: { workspaceId: string }
  }>('/v1/managed-cloud/workspaces/:workspaceId/domains', async (request) => {
    const authorized = await scope(
      request,
      request.params.workspaceId,
      'manage-domain',
    )
    const body = z
      .object({
        domain: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/),
      })
      .parse(request.body)
    return options.domains.request(authorized, body.domain)
  })

  app.post<{
    Params: { workspaceId: string }
  }>(
    '/v1/managed-cloud/workspaces/:workspaceId/domains/verify',
    async (request) => {
      const authorized = await scope(
        request,
        request.params.workspaceId,
        'manage-domain',
      )
      const body = z
        .object({ observedChallenge: z.string().min(1).max(1_024) })
        .parse(request.body)
      return options.domains.verify(authorized, body.observedChallenge)
    },
  )

  app.get<{
    Params: { workspaceId: string; taskId: string }
  }>(
    '/v1/managed-cloud/workspaces/:workspaceId/tasks/:taskId/replay',
    async (request) => {
      const authorized = await scope(
        request,
        request.params.workspaceId,
        'read',
      )
      return options.tasks.replay(authorized, request.params.taskId)
    },
  )

  for (const operation of ['export', 'delete'] as const)
    app.post<{
      Params: { workspaceId: string }
    }>(
      `/v1/managed-cloud/workspaces/:workspaceId/lifecycle/${operation}`,
      async (request, reply) => {
        const authorized = await scope(
          request,
          request.params.workspaceId,
          operation,
        )
        const body = z.object({ idempotencyKey: id }).parse(request.body)
        const result =
          operation === 'export'
            ? await options.lifecycle.exportTenant(
                authorized,
                body.idempotencyKey,
              )
            : await options.lifecycle.deleteTenant(
                authorized,
                body.idempotencyKey,
              )
        return reply.status(202).send(result)
      },
    )
}

const total = (
  entries: Awaited<ReturnType<ManagedCloudUsageViewPort['listUsage']>>,
  category: 'hosting' | 'compute' | 'storage' | 'model',
) =>
  entries
    .filter((entry) => entry.category === category && entry.billable)
    .reduce((sum, entry) => sum + (entry.amountMicros ?? 0), 0)
