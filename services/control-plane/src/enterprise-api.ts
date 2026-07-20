import Fastify from 'fastify'
import {
  ScimDirectory,
  EnterpriseBoundaryError,
  planDeprovision,
} from '@persistent-codex/enterprise-lifecycle'

const scope = (headers: Record<string, unknown>) => {
  const tenantId = headers['x-tenant-id'],
    organizationId = headers['x-organization-id']
  if (typeof tenantId !== 'string' || typeof organizationId !== 'string')
    throw new EnterpriseBoundaryError('MISSING_TENANT_SCOPE')
  return { tenantId, organizationId }
}

export function buildEnterpriseApi(
  options: {
    onDeprovision?: (
      scope: { tenantId: string; organizationId: string },
      resourceId: string,
      revocations: readonly string[],
    ) => Promise<void> | void
  } = {},
) {
  const app = Fastify({ logger: false }),
    directory = new ScimDirectory()
  app.setErrorHandler((error, _request, reply) => {
    const code =
      error instanceof EnterpriseBoundaryError
        ? error.code
        : 'ENTERPRISE_REQUEST_INVALID'
    void reply
      .code(
        code === 'SCIM_NOT_FOUND' ? 404 : code.includes('CONFLICT') ? 409 : 400,
      )
      .send({ code })
  })
  app.post('/scim/v2/Users', async (request, reply) => {
    const s = scope(request.headers),
      body = request.body as any
    const resource = directory.upsert({
      ...s,
      resourceType: 'User',
      resourceId: String(body.id),
      externalId: String(body.externalId),
      providerId: String(body.providerId),
      providerVersion: Number(body.providerVersion),
      active: body.active !== false,
      displayName: String(body.displayName ?? body.userName ?? body.id),
      members: [],
      idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
    })
    return reply.code(201).send(resource)
  })
  app.get('/scim/v2/Users/:id', async (request) =>
    directory.get(scope(request.headers), 'User', (request.params as any).id),
  )
  app.put('/scim/v2/Users/:id', async (request) => {
    const s = scope(request.headers),
      body = request.body as any,
      id = (request.params as any).id
    const resource = directory.upsert({
      ...s,
      resourceType: 'User',
      resourceId: id,
      externalId: String(body.externalId),
      providerId: String(body.providerId),
      providerVersion: Number(body.providerVersion),
      active: body.active !== false,
      displayName: String(body.displayName ?? body.userName ?? id),
      members: [],
      idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
    })
    if (!resource.active)
      await options.onDeprovision?.(s, id, planDeprovision())
    return resource
  })
  app.delete('/scim/v2/Users/:id', async (request, reply) => {
    const s = scope(request.headers),
      prior = directory.get(s, 'User', (request.params as any).id),
      version = Number(request.headers['x-provider-version'])
    const resource = directory.upsert({
      ...prior,
      providerVersion: version,
      active: false,
      idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
    })
    await options.onDeprovision?.(s, prior.resourceId, planDeprovision())
    return reply.code(200).send(resource)
  })
  app.post('/scim/v2/Groups', async (request, reply) => {
    const s = scope(request.headers),
      body = request.body as any
    return reply.code(201).send(
      directory.upsert({
        ...s,
        resourceType: 'Group',
        resourceId: String(body.id),
        externalId: String(body.externalId),
        providerId: String(body.providerId),
        providerVersion: Number(body.providerVersion),
        active: body.active !== false,
        displayName: String(body.displayName ?? body.id),
        members: Array.isArray(body.members) ? body.members.map(String) : [],
        idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
      }),
    )
  })
  app.get('/scim/v2/Groups/:id', async (request) =>
    directory.get(scope(request.headers), 'Group', (request.params as any).id),
  )
  app.put('/scim/v2/Groups/:id', async (request) => {
    const s = scope(request.headers),
      body = request.body as any,
      id = (request.params as any).id
    return directory.upsert({
      ...s,
      resourceType: 'Group',
      resourceId: id,
      externalId: String(body.externalId),
      providerId: String(body.providerId),
      providerVersion: Number(body.providerVersion),
      active: body.active !== false,
      displayName: String(body.displayName ?? id),
      members: Array.isArray(body.members) ? body.members.map(String) : [],
      idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
    })
  })
  app.delete('/scim/v2/Groups/:id', async (request) => {
    const s = scope(request.headers),
      prior = directory.get(s, 'Group', (request.params as any).id)
    return directory.upsert({
      ...prior,
      providerVersion: Number(request.headers['x-provider-version']),
      active: false,
      idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
    })
  })
  return app
}
