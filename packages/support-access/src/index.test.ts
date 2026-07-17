import { describe, expect, it } from 'vitest'
import { SupportAccessError, SupportAccessService } from './index'
import type { SupportAccessAction } from '@persistent-codex/control-plane-contracts'

const tenant = {
  tenantId: 'ten_a',
  organizationId: 'org_a',
  workspaceId: 'wsp_a',
}
const user = { principalId: 'usr_a', role: 'tenant_user' as const }
const support = { principalId: 'sup_a', role: 'support' as const }
const approver = { principalId: 'sec_a', role: 'security_approver' as const }
const kms = { principalId: 'kms_a', role: 'kms_operator' as const }

function fixture(actions: SupportAccessAction[] = ['content.view']) {
  let time = Date.parse('2026-07-17T10:00:00.000Z')
  const service = new SupportAccessService(() => new Date(time))
  let grant = service.createGrant({
    ...tenant,
    sessionId: 'ses_a',
    actions: [...actions],
    reason: 'Kullanıcı tarafından açıklanan support tanısı',
    requester: user,
    supportPrincipalId: support.principalId,
    durationMinutes: 15,
    idempotencyKey: 'create-a',
    correlationId: 'corr-a',
  })
  grant = service.verifyGrantMfa({
    grantId: grant.grantId,
    actor: user,
    mfaEvidenceId: 'mfa-a',
    expectedVersion: grant.version,
    idempotencyKey: 'mfa-a',
    correlationId: 'corr-a',
  })
  return {
    service,
    grant,
    advance(ms: number) {
      time += ms
    },
  }
}

describe('WP20 support access governance', () => {
  it('requires tenant-user initiation, narrow scope, MFA and separation of duty', () => {
    const service = new SupportAccessService()
    expect(() =>
      service.createGrant({
        ...tenant,
        sessionId: 'ses_a',
        actions: ['content.view'],
        reason: 'Support cannot issue its own grant',
        requester: support,
        supportPrincipalId: support.principalId,
        durationMinutes: 15,
        idempotencyKey: 'bad',
        correlationId: 'corr',
      }),
    ).toThrowError(new SupportAccessError('TENANT_USER_INITIATION_REQUIRED'))
    expect(() =>
      service.createGrant({
        ...tenant,
        actions: ['content.view'],
        reason: 'Scope is deliberately absent here',
        requester: user,
        supportPrincipalId: support.principalId,
        durationMinutes: 15,
        idempotencyKey: 'broad',
        correlationId: 'corr',
      }),
    ).toThrowError(new SupportAccessError('NARROW_OBJECT_SCOPE_REQUIRED'))
  })

  it('activates low-risk access once and rejects wrong session, object, action and principal', () => {
    const test = fixture()
    const active = test.service.decideGrant({
      grantId: test.grant.grantId,
      actor: support,
      decision: 'approve',
      expectedVersion: test.grant.version,
      idempotencyKey: 'approve-a',
      correlationId: 'corr-a',
    })
    expect(active.status).toBe('active')
    expect(() =>
      test.service.issueLease({
        grantId: active.grantId,
        actor: support,
        sessionId: 'ses_wrong',
        action: 'content.view',
        correlationId: 'corr',
      }),
    ).toThrowError(new SupportAccessError('SESSION_SCOPE_MISMATCH'))
    expect(() =>
      test.service.issueLease({
        grantId: active.grantId,
        actor: { ...support, principalId: 'sup_other' },
        sessionId: 'ses_a',
        action: 'content.view',
        correlationId: 'corr',
      }),
    ).toThrowError(new SupportAccessError('SUPPORT_PRINCIPAL_MISMATCH'))
    expect(() =>
      test.service.issueLease({
        grantId: active.grantId,
        actor: support,
        sessionId: 'ses_a',
        action: 'artifact.download',
        correlationId: 'corr',
      }),
    ).toThrowError(new SupportAccessError('ACTION_SCOPE_MISMATCH'))
  })

  it('requires distinct double approval and a separated KMS operator for decrypt', () => {
    const test = fixture(['content.decrypt'])
    let grant = test.service.decideGrant({
      grantId: test.grant.grantId,
      actor: approver,
      decision: 'approve',
      expectedVersion: test.grant.version,
      idempotencyKey: 'approve-1',
      correlationId: 'corr',
    })
    expect(grant.status).toBe('pending_approval')
    expect(() =>
      test.service.decideGrant({
        grantId: grant.grantId,
        actor: approver,
        decision: 'approve',
        expectedVersion: grant.version,
        idempotencyKey: 'approve-duplicate',
        correlationId: 'corr',
      }),
    ).toThrowError(new SupportAccessError('DISTINCT_APPROVER_REQUIRED'))
    grant = test.service.decideGrant({
      grantId: grant.grantId,
      actor: kms,
      decision: 'approve',
      expectedVersion: grant.version,
      idempotencyKey: 'approve-2',
      correlationId: 'corr',
    })
    expect(grant.status).toBe('active')
    expect(() =>
      test.service.issueLease({
        grantId: grant.grantId,
        actor: support,
        sessionId: 'ses_a',
        action: 'content.decrypt',
        correlationId: 'corr',
      }),
    ).toThrowError(new SupportAccessError('KMS_DECRYPT_ROLE_REQUIRED'))
  })

  it('invalidates one-use leases immediately through generation on revoke and expiry', () => {
    const test = fixture()
    let grant = test.service.decideGrant({
      grantId: test.grant.grantId,
      actor: support,
      decision: 'approve',
      expectedVersion: test.grant.version,
      idempotencyKey: 'approve',
      correlationId: 'corr',
    })
    const issued = test.service.issueLease({
      grantId: grant.grantId,
      actor: support,
      sessionId: 'ses_a',
      action: 'content.view',
      correlationId: 'corr',
    })
    grant = test.service.revokeGrant({
      grantId: grant.grantId,
      actor: user,
      expectedVersion: grant.version,
      idempotencyKey: 'revoke',
      correlationId: 'corr',
    })
    expect(() =>
      test.service.consumeLease({
        leaseId: issued.lease.leaseId,
        token: issued.token,
        ...tenant,
        sessionId: 'ses_a',
        action: 'content.view',
        principalId: support.principalId,
        correlationId: 'corr',
      }),
    ).toThrowError(new SupportAccessError('LEASE_REVOKED_OR_EXPIRED'))
    expect(grant.generation).toBe(1)

    const expiring = fixture()
    const active = expiring.service.decideGrant({
      grantId: expiring.grant.grantId,
      actor: support,
      decision: 'approve',
      expectedVersion: expiring.grant.version,
      idempotencyKey: 'approve-expiry',
      correlationId: 'corr',
    })
    expiring.advance(16 * 60_000)
    expect(
      expiring.service
        .listGrants(tenant)
        .find((v) => v.grantId === active.grantId)?.status,
    ).toBe('expired')
  })

  it('makes retries idempotent, stale concurrent decisions conflict and survives restart', () => {
    const test = fixture()
    const active = test.service.decideGrant({
      grantId: test.grant.grantId,
      actor: support,
      decision: 'approve',
      expectedVersion: test.grant.version,
      idempotencyKey: 'decision',
      correlationId: 'corr',
    })
    expect(
      test.service.decideGrant({
        grantId: test.grant.grantId,
        actor: support,
        decision: 'approve',
        expectedVersion: test.grant.version,
        idempotencyKey: 'decision',
        correlationId: 'corr',
      }).version,
    ).toBe(active.version)
    expect(() =>
      test.service.revokeGrant({
        grantId: active.grantId,
        actor: user,
        expectedVersion: test.grant.version,
        idempotencyKey: 'stale',
        correlationId: 'corr',
      }),
    ).toThrowError(new SupportAccessError('VERSION_CONFLICT'))
    const restarted = new SupportAccessService(
      test.service.now,
      test.service.snapshot(),
    )
    expect(restarted.listGrants(tenant)[0]?.status).toBe('active')
    expect(restarted.verifyAuditChain()).toBe(true)
  })

  it('keeps cross-tenant records hidden and audit content-free/hash-chained', () => {
    const test = fixture()
    expect(
      test.service.listGrants({
        organizationId: 'org_b',
        workspaceId: 'wsp_b',
      }),
    ).toEqual([])
    const audit = test.service.listAudit(tenant)
    expect(audit).toHaveLength(2)
    expect(JSON.stringify(audit)).not.toContain('plaintext-secret')
    expect(test.service.verifyAuditChain()).toBe(true)
    const state = test.service.snapshot()
    state.audit[0]!.reason = 'tampered'
    expect(
      new SupportAccessService(test.service.now, state).verifyAuditChain(),
    ).toBe(false)
  })
})

describe('WP20 break-glass', () => {
  it('requires incident, strong MFA, two distinct approvers, alarm and notification outbox', () => {
    const service = new SupportAccessService(
      () => new Date('2026-07-17T10:00:00.000Z'),
    )
    const operator = { principalId: 'ops_a', role: 'operator' as const }
    expect(() =>
      service.createBreakGlass({
        ...tenant,
        sessionId: 'ses_a',
        objectId: 'art_a',
        actions: ['artifact.download'],
        incidentId: 'bad',
        reason: 'Emergency diagnosis',
        requester: operator,
        durationMinutes: 10,
        idempotencyKey: 'bad',
        correlationId: 'corr',
      }),
    ).toThrowError(new SupportAccessError('INCIDENT_ID_REQUIRED'))
    let request = service.createBreakGlass({
      ...tenant,
      sessionId: 'ses_a',
      objectId: 'art_a',
      actions: ['artifact.download'],
      incidentId: 'INC-SEV1-1234',
      reason: 'Emergency diagnosis',
      requester: operator,
      durationMinutes: 10,
      idempotencyKey: 'bg',
      correlationId: 'corr',
    })
    request = service.verifyBreakGlassMfa({
      breakGlassId: request.breakGlassId,
      actor: operator,
      mfaEvidenceId: 'mfa-strong',
      expectedVersion: request.version,
      idempotencyKey: 'bg-mfa',
      correlationId: 'corr',
    })
    request = service.approveBreakGlass({
      breakGlassId: request.breakGlassId,
      actor: approver,
      expectedVersion: request.version,
      idempotencyKey: 'bg-approve-1',
      correlationId: 'corr',
    })
    expect(request.status).toBe('pending_approval')
    expect(() =>
      service.approveBreakGlass({
        breakGlassId: request.breakGlassId,
        actor: approver,
        expectedVersion: request.version,
        idempotencyKey: 'same',
        correlationId: 'corr',
      }),
    ).toThrowError(new SupportAccessError('SEPARATION_OF_DUTY_REQUIRED'))
    request = service.approveBreakGlass({
      breakGlassId: request.breakGlassId,
      actor: kms,
      expectedVersion: request.version,
      idempotencyKey: 'bg-approve-2',
      correlationId: 'corr',
    })
    expect(request.status).toBe('active')
    expect(service.listOutbox(tenant)).toMatchObject([
      { kind: 'break_glass_alarm', status: 'pending' },
    ])
    const lease = service.issueBreakGlassLease({
      breakGlassId: request.breakGlassId,
      actor: kms,
      sessionId: 'ses_a',
      objectId: 'art_a',
      action: 'artifact.download',
      correlationId: 'corr',
    })
    expect(lease.lease.expiresAt).toBeTruthy()
    const alarm = service.listOutbox(tenant)[0]!
    service.failOutbox(alarm.outboxId, '2026-07-17T10:01:00.000Z')
    const restarted = new SupportAccessService(service.now, service.snapshot())
    expect(restarted.listOutbox(tenant)[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
    })
    request = restarted.revokeBreakGlass({
      breakGlassId: request.breakGlassId,
      actor: operator,
      expectedVersion: request.version,
      correlationId: 'corr',
    })
    expect(restarted.listOutbox(tenant).map((v) => v.kind)).toEqual([
      'break_glass_alarm',
      'tenant_notification',
    ])
    expect(restarted.listAudit(tenant).map((v) => v.action)).toContain(
      'break_glass.ended',
    )
  })
})
