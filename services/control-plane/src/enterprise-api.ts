import Fastify from 'fastify'
import { EnterpriseBoundaryError } from '@perseverance/enterprise-lifecycle'
import type {
  EnterpriseRepository,
  ScimWrite,
} from '@perseverance/enterprise-lifecycle/postgres'

type Scope = { tenantId: string; organizationId: string }
const scope = (headers: Record<string, unknown>): Scope => {
  const tenantId = headers['x-tenant-id'],
    organizationId = headers['x-organization-id']
  if (typeof tenantId !== 'string' || typeof organizationId !== 'string')
    throw new EnterpriseBoundaryError('MISSING_TENANT_SCOPE')
  return { tenantId, organizationId }
}
const bearer = (headers: Record<string, unknown>) => {
  const value = headers.authorization
  if (
    typeof value !== 'string' ||
    !value.startsWith('Bearer ') ||
    value.length <= 7
  )
    throw new EnterpriseBoundaryError('SCIM_UNAUTHORIZED')
  return value.slice(7)
}
const version = (body: any, headers: Record<string, unknown>) =>
  Number(
    body?.meta?.version ??
      body?.providerVersion ??
      headers['x-provider-version'],
  )
const write = (
  s: Scope,
  providerId: string,
  type: 'User' | 'Group',
  id: string,
  body: any,
  headers: Record<string, unknown>,
): ScimWrite => {
  if (body.providerId !== undefined && body.providerId !== providerId)
    throw new EnterpriseBoundaryError('SCIM_PROVIDER_SUBSTITUTION')
  return {
    ...s,
    resourceType: type,
    resourceId: id,
    externalId: String(body.externalId),
    providerId,
    providerVersion: version(body, headers),
    active: body.active !== false,
    displayName: String(body.displayName ?? body.userName ?? id),
    members:
      type === 'Group' && Array.isArray(body.members)
        ? body.members.map((member: any) => String(member.value ?? member))
        : [],
    idempotencyKey: String(headers['idempotency-key'] ?? ''),
  }
}

export function buildEnterpriseApi(options: {
  repository: EnterpriseRepository
}) {
  const app = Fastify({ logger: false }),
    repo = options.repository
  app.setErrorHandler((error, _request, reply) => {
    const code =
      error instanceof EnterpriseBoundaryError
        ? error.code
        : typeof (error as any).code === 'string'
          ? (error as any).code
          : 'ENTERPRISE_REQUEST_INVALID'
    const status =
      code === 'SCIM_UNAUTHORIZED'
        ? 401
        : code.includes('DEPROVISIONED') || code.includes('PRIVILEGE')
          ? 403
          : code === 'SCIM_NOT_FOUND'
            ? 404
            : code.includes('CONFLICT') ||
                code.includes('SUBSTITUTION') ||
                code.includes('SCOPE')
              ? 409
              : 400
    void reply.code(status).send({ code })
  })
  const authority = async (headers: Record<string, unknown>) => {
    const s = scope(headers),
      auth = await repo.authenticateScim(s, bearer(headers))
    return { ...s, ...auth }
  }
  app.post('/scim/v2/Users', async (request, reply) => {
    const a = await authority(request.headers),
      body = request.body as any
    return reply
      .code(201)
      .send(
        await repo.upsertScim(
          write(
            a,
            a.providerId,
            'User',
            String(body.id),
            body,
            request.headers,
          ),
        ),
      )
  })
  app.get('/scim/v2/Users/:id', async (request) => {
    const a = await authority(request.headers)
    return repo.getScim(a, a.providerId, 'User', (request.params as any).id)
  })
  app.put('/scim/v2/Users/:id', async (request) => {
    const a = await authority(request.headers),
      input = write(
        a,
        a.providerId,
        'User',
        (request.params as any).id,
        request.body,
        request.headers,
      )
    return input.active
      ? repo.upsertScim(input)
      : repo.deprovisionScimUser(
          a,
          a.providerId,
          input.resourceId,
          input.providerVersion,
          input.idempotencyKey,
        )
  })
  app.delete('/scim/v2/Users/:id', async (request) => {
    const a = await authority(request.headers)
    return repo.deprovisionScimUser(
      a,
      a.providerId,
      (request.params as any).id,
      Number(request.headers['x-provider-version']),
      String(request.headers['idempotency-key'] ?? ''),
    )
  })
  app.post('/scim/v2/Groups', async (request, reply) => {
    const a = await authority(request.headers),
      body = request.body as any
    return reply
      .code(201)
      .send(
        await repo.replaceGroupMemberships(
          write(
            a,
            a.providerId,
            'Group',
            String(body.id),
            body,
            request.headers,
          ),
        ),
      )
  })
  app.get('/scim/v2/Groups/:id', async (request) => {
    const a = await authority(request.headers)
    return repo.getScim(a, a.providerId, 'Group', (request.params as any).id)
  })
  app.put('/scim/v2/Groups/:id', async (request) => {
    const a = await authority(request.headers)
    return repo.replaceGroupMemberships(
      write(
        a,
        a.providerId,
        'Group',
        (request.params as any).id,
        request.body,
        request.headers,
      ),
    )
  })
  app.delete('/scim/v2/Groups/:id', async (request) => {
    const a = await authority(request.headers),
      prior = await repo.getScim(
        a,
        a.providerId,
        'Group',
        (request.params as any).id,
      )
    return repo.replaceGroupMemberships({
      ...prior,
      providerVersion: Number(request.headers['x-provider-version']),
      active: false,
      idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
    })
  })
  app.post('/v1/enterprise/admission/:operation', async (request, reply) => {
    const s = scope(request.headers),
      operation = (request.params as any).operation as
        'turn' | 'upload' | 'export' | 'share',
      principalId = String(request.headers['x-principal-id'] ?? '')
    await repo.assertAdmission(s, principalId, operation)
    return reply.code(204).send()
  })
  app.addHook('onClose', async () => repo.close?.())
  return app
}
