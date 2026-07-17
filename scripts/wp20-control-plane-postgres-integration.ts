import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AuthenticationAdapter,
  MembershipDirectory,
} from '../packages/authz/src/index'
import type {
  AuthPrincipal,
  OrganizationMembership,
} from '../packages/control-plane-contracts/src/index'
import { SqliteEventStore } from '../packages/event-store/src/index'
import { createPostgresSupportAccessRepository } from '../packages/support-access/src/index'
import { buildControlPlane } from '../services/control-plane/src/server'

const connectionString = process.env.WP20_DATABASE_URL
if (!connectionString) throw new Error('WP20_DATABASE_URL is required')
const organizationId = 'org_cp'
const workspaceId = 'wsp_cp'
const sessionId = 'ses_cp'
const issuer = 'urn:wp20:postgres-integration'
const root = mkdtempSync(join(tmpdir(), 'wp20-control-plane-'))
const roles: Record<string, OrganizationMembership['role']> = {
  user: 'owner',
  support: 'support',
  security: 'security_approver',
  kms: 'kms_operator',
  operator: 'operator',
}
const opaque = (subject: string) =>
  `sha256:${createHash('sha256').update(`${issuer}\0${subject}`).digest('hex')}`

class Authentication implements AuthenticationAdapter {
  async authenticate(input: {
    authorization?: string
  }): Promise<AuthPrincipal> {
    const subject = input.authorization?.replace('Bearer ', '') ?? ''
    if (!roles[subject]) throw new Error('AUTH_REQUIRED')
    const now = new Date()
    return {
      version: 1,
      kind: 'end_user',
      subject,
      issuer,
      audience: ['wp20'],
      authenticatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      assurance: { level: 'strong-mfa', mfa: true },
      memberships: [],
    }
  }
}

const membershipDirectory: MembershipDirectory = {
  membershipsFor(subject) {
    return [
      {
        version: 1,
        subject,
        issuer,
        organizationId,
        role: roles[subject]!,
        status: 'active',
        workspaceIds: [workspaceId],
        updatedAt: new Date().toISOString(),
      },
    ]
  },
}
const headers = {
  'content-type': 'application/json',
  'x-tenant-id': organizationId,
  'x-workspace-id': workspaceId,
}
const store = new SqliteEventStore(join(root, 'events.sqlite'))
store.createSession({
  tenantId: organizationId,
  workspaceId,
  sessionId,
  status: 'active',
})

async function start() {
  const repository = createPostgresSupportAccessRepository({ connectionString })
  const app = await buildControlPlane({
    eventStore: store,
    artifactRoot: join(root, 'artifacts'),
    attachmentRoot: join(root, 'attachments'),
    codexHomeRoot: join(root, 'codex-homes'),
    workspaceCwd: root,
    authenticationAdapter: new Authentication(),
    membershipDirectory,
    supportAccessRepository: repository,
  })
  return { app, repository }
}

async function call(
  app: Awaited<ReturnType<typeof buildControlPlane>>,
  path: string,
  subject: string,
  init: { method?: string; body?: unknown; key?: string } = {},
) {
  return app.inject({
    method: init.method ?? 'GET',
    url: path,
    headers: {
      ...headers,
      authorization: `Bearer ${subject}`,
      ...(init.key ? { 'idempotency-key': init.key } : {}),
    },
    ...(init.body === undefined ? {} : { payload: init.body }),
  })
}

let running = await start()
try {
  const createGrant = async (key: string) => {
    const response = await call(
      running.app,
      `/v1/sessions/${sessionId}/support-grants`,
      'user',
      {
        method: 'POST',
        key,
        body: {
          sessionId,
          actions: ['content.view'],
          reason: 'Restart kalıcılığı için dar kapsamlı support tanısı',
          supportPrincipalId: opaque('support'),
          durationMinutes: 30,
        },
      },
    )
    assert.equal(response.statusCode, 201, response.body)
    return response.json()
  }
  const pending = await createGrant('pending-grant')
  let active = await createGrant('active-grant')
  const decision = await call(
    running.app,
    `/v1/support-grants/${active.grantId}/decision`,
    'support',
    {
      method: 'POST',
      key: 'activate-grant',
      body: {
        decision: 'approve',
        expectedVersion: active.version,
        mfaEvidenceId: 'mfa-support',
      },
    },
  )
  assert.equal(decision.statusCode, 200, decision.body)
  active = decision.json()
  assert.equal(active.status, 'active')

  await running.app.close()
  running = await start()
  const recovered = await call(
    running.app,
    `/v1/sessions/${sessionId}/support-grants`,
    'user',
  )
  assert.equal(recovered.statusCode, 200, recovered.body)
  const recoveredGrants = recovered.json().grants
  assert.equal(
    recoveredGrants.find(
      (value: { grantId: string }) => value.grantId === pending.grantId,
    ).status,
    'pending_approval',
  )
  active = recoveredGrants.find(
    (value: { grantId: string }) => value.grantId === active.grantId,
  )
  assert.equal(active.status, 'active')

  const issue = await call(
    running.app,
    '/v1/support-access/leases',
    'support',
    {
      method: 'POST',
      key: 'lease-one',
      body: {
        schemaVersion: 1,
        grantId: active.grantId,
        sessionId,
        objectId: null,
        action: 'content.view',
      },
    },
  )
  assert.equal(issue.statusCode, 200, issue.body)
  const lease = issue.json()
  const consume = await call(
    running.app,
    `/v1/support-access/leases/${lease.lease.leaseId}/consume`,
    'support',
    {
      method: 'POST',
      body: {
        schemaVersion: 1,
        token: lease.token,
        sessionId,
        objectId: null,
        action: 'content.view',
      },
    },
  )
  assert.equal(consume.statusCode, 200, consume.body)
  assert.equal(consume.json().action, 'content.view')
  await running.app.close()
  running = await start()
  const replay = await call(
    running.app,
    `/v1/support-access/leases/${lease.lease.leaseId}/consume`,
    'support',
    {
      method: 'POST',
      body: {
        schemaVersion: 1,
        token: lease.token,
        sessionId,
        objectId: null,
        action: 'content.view',
      },
    },
  )
  assert.equal(replay.statusCode, 403, replay.body)

  const revoke = await call(
    running.app,
    `/v1/support-grants/${active.grantId}/revoke`,
    'user',
    {
      method: 'POST',
      key: 'revoke-active',
      body: { expectedVersion: active.version },
    },
  )
  assert.equal(revoke.statusCode, 200, revoke.body)
  assert.equal(revoke.json().generation, 1)
  await running.app.close()
  running = await start()
  const afterRevoke = await call(
    running.app,
    `/v1/sessions/${sessionId}/support-grants`,
    'user',
  )
  const revoked = afterRevoke
    .json()
    .grants.find(
      (value: { grantId: string }) => value.grantId === active.grantId,
    )
  assert.equal(revoked.status, 'revoked')
  assert.equal(revoked.generation, 1)

  let breakGlassResponse = await call(
    running.app,
    '/v1/break-glass',
    'operator',
    {
      method: 'POST',
      key: 'break-create',
      body: {
        schemaVersion: 1,
        sessionId,
        objectId: 'protected-object',
        actions: ['content.view'],
        incidentId: 'INC-SEV1-2026',
        reason: 'Production repository break glass integration',
        durationMinutes: 10,
      },
    },
  )
  assert.equal(breakGlassResponse.statusCode, 201, breakGlassResponse.body)
  let breakGlass = breakGlassResponse.json()
  for (const [subject, key] of [
    ['security', 'break-security'],
    ['kms', 'break-kms'],
  ] as const) {
    breakGlassResponse = await call(
      running.app,
      `/v1/break-glass/${breakGlass.breakGlassId}/approve`,
      subject,
      {
        method: 'POST',
        key,
        body: {
          schemaVersion: 1,
          expectedVersion: breakGlass.version,
          mfaEvidenceId: `mfa-${subject}`,
        },
      },
    )
    assert.equal(breakGlassResponse.statusCode, 200, breakGlassResponse.body)
    breakGlass = breakGlassResponse.json()
  }
  assert.equal(breakGlass.status, 'active')
  let outbox = await running.repository.transaction(
    { tenantId: organizationId, organizationId, workspaceId },
    (service) => service.listOutbox({ organizationId, workspaceId }),
  )
  assert.equal(outbox[0]?.kind, 'break_glass_alarm')
  const failedDelivery = await call(
    running.app,
    `/v1/security-outbox/${outbox[0]!.outboxId}/result`,
    'operator',
    {
      method: 'POST',
      key: 'outbox-fail-1',
      body: {
        schemaVersion: 1,
        delivered: false,
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  )
  assert.equal(failedDelivery.statusCode, 200, failedDelivery.body)
  await running.app.close()
  running = await start()
  const replayedDelivery = await call(
    running.app,
    `/v1/security-outbox/${outbox[0]!.outboxId}/result`,
    'operator',
    {
      method: 'POST',
      key: 'outbox-fail-1',
      body: {
        schemaVersion: 1,
        delivered: false,
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  )
  assert.equal(replayedDelivery.statusCode, 200, replayedDelivery.body)
  outbox = await running.repository.transaction(
    { tenantId: organizationId, organizationId, workspaceId },
    (service) => service.listOutbox({ organizationId, workspaceId }),
  )
  assert.equal(outbox[0]?.status, 'pending')
  assert.equal(outbox[0]?.attempts, 1)
  assert.equal(
    await running.repository.verifyAuditChain({
      tenantId: organizationId,
      organizationId,
      workspaceId,
    }),
    true,
  )
  console.log(
    JSON.stringify({
      status: 'passed',
      adapter: running.repository.adapter,
      restartRecovery: [
        'pending-grant',
        'active-grant',
        'revocation-generation',
      ],
      jitContent: 'route-consumed+restart-replay-denied',
      auditChain: 'preserved',
      breakGlass: 'api-activated',
      outbox: 'pending-retry-recovered',
    }),
  )
} finally {
  await running.app.close().catch(() => undefined)
  store.close()
  rmSync(root, { recursive: true, force: true })
}
