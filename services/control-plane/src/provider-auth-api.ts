import Fastify from 'fastify'
import {
  DeploymentProfileError,
  assertEntitled,
  type DeploymentProfile,
} from '@persistent-codex/deployment-profiles'
import {
  ProviderAuthError,
  providerAuthModeSchema,
  providerAuthScopeSchema,
  type ProviderAuthRepository,
  type ProviderCredentialVault,
} from '@persistent-codex/provider-auth'
import { providerIdSchema } from '@persistent-codex/provider-platform'
import { TenantRuntimeError } from '@persistent-codex/tenant-runtime'
import { z } from 'zod'

const workspaceIdSchema = z.string().trim().min(1).max(255)

const scopeFrom = (headers: Record<string, unknown>, workspaceId: string) =>
  providerAuthScopeSchema.parse({
    tenantId: headers['x-tenant-id'],
    organizationId: headers['x-organization-id'],
    workspaceId,
  })

const workspaceBodySchema = z.object({ workspaceId: workspaceIdSchema })
const connectBodySchema = workspaceBodySchema.extend({
  profileId: z.string().trim().min(1).max(255).optional(),
  provider: providerIdSchema,
  authMode: providerAuthModeSchema,
  accessToken: z.string().min(8),
  refreshToken: z.string().min(8).nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
})
const leaseBodySchema = workspaceBodySchema.extend({
  runtimeId: z.string().trim().min(1).max(255),
  generation: z.number().int().positive(),
})

export function buildProviderAuthApi(options: {
  profile: DeploymentProfile
  repository: ProviderAuthRepository
  vault: ProviderCredentialVault
}) {
  const app = Fastify({ logger: false })
  const { profile, repository, vault } = options

  app.setErrorHandler((error, _request, reply) => {
    const code =
      error instanceof ProviderAuthError ||
      error instanceof TenantRuntimeError ||
      error instanceof DeploymentProfileError
        ? error.code
        : error instanceof z.ZodError &&
            error.issues.some((issue) =>
              issue.path.some(
                (part) => part === 'tenantId' || part === 'organizationId',
              ),
            )
          ? 'MISSING_TENANT_SCOPE'
          : 'PROVIDER_AUTH_REQUEST_INVALID'
    const status = code.startsWith('ENTITLEMENT_DENIED')
      ? 403
      : code === 'RUNTIME_AUTH_REQUIRED'
        ? 401
        : code.startsWith('RUNTIME_TOKEN') || code.startsWith('RUNTIME_SCOPE')
          ? 403
          : code === 'MISSING_TENANT_SCOPE'
            ? 400
            : code === 'PROVIDER_PROFILE_NOT_FOUND'
              ? 404
              : code === 'PROVIDER_AUTH_KILL_SWITCH_ACTIVE' ||
                  code.includes('CONFLICT') ||
                  code.includes('STALE') ||
                  code.includes('REVOKED')
                ? 409
                : error instanceof ProviderAuthError && error.actionable
                  ? 403
                  : 400
    void reply.status(status).send({ error: code })
  })

  const requireEntitlement = () =>
    assertEntitled(profile, 'core.provider-adapters')

  app.post('/v1/provider-auth/profiles', async (request, reply) => {
    requireEntitlement()
    const body = connectBodySchema.parse(request.body)
    const scope = scopeFrom(request.headers, body.workspaceId)
    const metadata = await vault.connect({
      scope,
      ...(body.profileId ? { profileId: body.profileId } : {}),
      provider: body.provider,
      authMode: body.authMode,
      accessToken: body.accessToken,
      ...(body.refreshToken !== undefined
        ? { refreshToken: body.refreshToken }
        : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
    })
    return reply.status(201).send(metadata)
  })

  app.get('/v1/provider-auth/profiles', async (request) => {
    requireEntitlement()
    const query = workspaceBodySchema.parse(request.query)
    return {
      profiles: await repository.listProfiles(
        scopeFrom(request.headers, query.workspaceId),
      ),
    }
  })

  for (const operation of ['revoke', 'disconnect'] as const) {
    app.post(
      `/v1/provider-auth/profiles/:profileId/${operation}`,
      async (request) => {
        requireEntitlement()
        const body = workspaceBodySchema.parse(request.body)
        const { profileId } = request.params as { profileId: string }
        const scope = scopeFrom(request.headers, body.workspaceId)
        return operation === 'revoke'
          ? vault.revoke(scope, profileId)
          : vault.disconnect(scope, profileId)
      },
    )
  }

  app.post(
    '/v1/runtime/provider-auth/profiles/:profileId/lease',
    async (request) => {
      requireEntitlement()
      const body = leaseBodySchema.parse(request.body)
      const { profileId } = request.params as { profileId: string }
      return vault.leaseToRuntime({
        scope: scopeFrom(request.headers, body.workspaceId),
        profileId,
        runtimeAuthorization:
          typeof request.headers.authorization === 'string'
            ? request.headers.authorization
            : '',
        runtimeId: body.runtimeId,
        generation: body.generation,
      })
    },
  )

  return app
}
