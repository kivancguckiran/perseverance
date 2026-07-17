import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  supportGrantSchema,
  type SupportAccessAction,
  type SupportGrant,
} from '@persistent-codex/control-plane-contracts'

export type SupportRole =
  | 'tenant_user'
  | 'admin'
  | 'support'
  | 'operator'
  | 'security_approver'
  | 'kms_operator'

export interface SupportActor {
  principalId: string
  role: SupportRole
}

export class SupportAccessError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
    this.name = 'SupportAccessError'
  }
}

export interface SecurityAuditRecord {
  sequence: number
  tenantId: string
  organizationId: string
  workspaceId: string
  actorPrincipalId: string
  scope: string
  action: string
  outcome: 'requested' | 'success' | 'failure'
  reason: string
  grantId: string | null
  breakGlassId: string | null
  occurredAt: string
  correlationId: string
  previousHash: string
  recordHash: string
}

export interface AccessLease {
  leaseId: string
  grantId: string | null
  breakGlassId: string | null
  tenantId: string
  organizationId: string
  workspaceId: string
  sessionId: string | null
  objectId: string | null
  action: SupportAccessAction
  principalId: string
  generation: number
  issuedAt: string
  expiresAt: string
  revokedAt: string | null
  tokenHash: string
}

export interface IssuedAccessLease {
  lease: Omit<AccessLease, 'tokenHash'>
  token: string
}

export interface BreakGlassRequest {
  schemaVersion: 1
  breakGlassId: string
  tenantId: string
  organizationId: string
  workspaceId: string
  sessionId: string | null
  objectId: string | null
  actions: SupportAccessAction[]
  incidentId: string
  reason: string
  requesterPrincipalId: string
  mfaEvidenceId: string | null
  approvalPrincipalIds: string[]
  status:
    | 'pending_verification'
    | 'pending_approval'
    | 'active'
    | 'revoked'
    | 'expired'
    | 'denied'
  issuedAt: string | null
  expiresAt: string
  revokedAt: string | null
  version: number
  generation: number
  idempotencyKey: string
}

export interface SecurityOutboxRecord {
  outboxId: string
  tenantId: string
  organizationId: string
  workspaceId: string
  kind: 'break_glass_alarm' | 'tenant_notification'
  aggregateId: string
  status: 'pending' | 'delivered'
  attempts: number
  availableAt: string
  deliveredAt: string | null
}

interface PersistedState {
  grants: SupportGrant[]
  breakGlass: BreakGlassRequest[]
  leases: AccessLease[]
  audit: SecurityAuditRecord[]
  outbox: SecurityOutboxRecord[]
}

const HIGH_RISK = new Set<SupportAccessAction>([
  'artifact.download',
  'attachment.download',
  'content.decrypt',
])

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function objectId(input: {
  artifactId?: string | null
  attachmentId?: string | null
  objectId?: string | null
}) {
  return input.artifactId ?? input.attachmentId ?? input.objectId ?? null
}

function terminal(status: string) {
  return ['revoked', 'expired', 'denied'].includes(status)
}

export class SupportAccessService {
  readonly #grants = new Map<string, SupportGrant>()
  readonly #breakGlass = new Map<string, BreakGlassRequest>()
  readonly #leases = new Map<string, AccessLease>()
  readonly #idempotency = new Map<string, string>()
  readonly #audit: SecurityAuditRecord[] = []
  readonly #outbox: SecurityOutboxRecord[] = []

  readonly now: () => Date
  constructor(now: () => Date = () => new Date(), state?: PersistedState) {
    this.now = now
    for (const grant of state?.grants ?? []) {
      const parsed = supportGrantSchema.parse(grant)
      this.#grants.set(parsed.grantId, parsed)
      this.#idempotency.set(`grant:${parsed.idempotencyKey}`, parsed.grantId)
    }
    for (const request of state?.breakGlass ?? []) {
      this.#breakGlass.set(request.breakGlassId, structuredClone(request))
      this.#idempotency.set(
        `break-glass:${request.idempotencyKey}`,
        request.breakGlassId,
      )
    }
    for (const lease of state?.leases ?? [])
      this.#leases.set(lease.leaseId, structuredClone(lease))
    this.#audit.push(...(state?.audit ?? []).map((v) => structuredClone(v)))
    this.#outbox.push(...(state?.outbox ?? []).map((v) => structuredClone(v)))
  }

  snapshot(): PersistedState {
    return structuredClone({
      grants: [...this.#grants.values()],
      breakGlass: [...this.#breakGlass.values()],
      leases: [...this.#leases.values()],
      audit: this.#audit,
      outbox: this.#outbox,
    })
  }

  listGrants(scope: { organizationId: string; workspaceId: string }) {
    this.expire()
    return [...this.#grants.values()]
      .filter(
        (grant) =>
          grant.organizationId === scope.organizationId &&
          grant.workspaceId === scope.workspaceId,
      )
      .map((grant) => structuredClone(grant))
  }

  createGrant(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    sessionId?: string | null
    artifactId?: string | null
    attachmentId?: string | null
    actions: SupportAccessAction[]
    reason: string
    requester: SupportActor
    supportPrincipalId: string
    durationMinutes: number
    idempotencyKey: string
    correlationId: string
  }): SupportGrant {
    if (input.requester.role !== 'tenant_user')
      throw new SupportAccessError('TENANT_USER_INITIATION_REQUIRED')
    if (input.requester.principalId === input.supportPrincipalId)
      throw new SupportAccessError('SEPARATION_OF_DUTY_REQUIRED')
    if (input.durationMinutes < 5 || input.durationMinutes > 60)
      throw new SupportAccessError('TTL_OUT_OF_RANGE')
    if (!input.sessionId && !input.artifactId && !input.attachmentId)
      throw new SupportAccessError('NARROW_OBJECT_SCOPE_REQUIRED')
    if (input.artifactId && input.attachmentId)
      throw new SupportAccessError('AMBIGUOUS_OBJECT_SCOPE')
    const key = `grant:${input.idempotencyKey}`
    const existing = this.#idempotency.get(key)
    if (existing) return structuredClone(this.#grants.get(existing)!)
    const createdAt = this.now()
    const highRisk = input.actions.some((action) => HIGH_RISK.has(action))
    const grant = supportGrantSchema.parse({
      schemaVersion: 1,
      grantId: `sgr_${randomUUID()}`,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId ?? null,
      artifactId: input.artifactId ?? null,
      attachmentId: input.attachmentId ?? null,
      actions: [...new Set(input.actions)],
      reason: input.reason,
      requesterPrincipalId: input.requester.principalId,
      supportPrincipalId: input.supportPrincipalId,
      mfaEvidenceId: null,
      requiredApprovals: highRisk ? 2 : 1,
      approvalPrincipalIds: [],
      status: 'pending_verification',
      issuedAt: null,
      expiresAt: new Date(
        createdAt.getTime() + input.durationMinutes * 60_000,
      ).toISOString(),
      revokedAt: null,
      version: 1,
      generation: 0,
      idempotencyKey: input.idempotencyKey,
    })
    this.#grants.set(grant.grantId, grant)
    this.#idempotency.set(key, grant.grantId)
    this.#appendAudit(
      grant,
      input.requester.principalId,
      'grant.created',
      'requested',
      input.reason,
      input.correlationId,
    )
    return structuredClone(grant)
  }

  verifyGrantMfa(input: {
    grantId: string
    actor: SupportActor
    mfaEvidenceId: string
    expectedVersion: number
    idempotencyKey: string
    correlationId: string
  }) {
    const grant = this.#grant(input.grantId)
    const replay = this.#decisionReplay(
      `grant-mfa:${input.idempotencyKey}`,
      grant.grantId,
    )
    if (replay) return structuredClone(grant)
    this.#version(grant, input.expectedVersion)
    if (input.actor.principalId !== grant.requesterPrincipalId)
      throw new SupportAccessError('REQUESTER_MFA_REQUIRED')
    if (grant.status !== 'pending_verification')
      throw new SupportAccessError('INVALID_STATE')
    grant.mfaEvidenceId = input.mfaEvidenceId
    grant.status = 'pending_approval'
    grant.version++
    this.#idempotency.set(`grant-mfa:${input.idempotencyKey}`, grant.grantId)
    this.#appendAudit(
      grant,
      input.actor.principalId,
      'grant.mfa_verified',
      'success',
      'strong_mfa',
      input.correlationId,
    )
    return structuredClone(grant)
  }

  decideGrant(input: {
    grantId: string
    actor: SupportActor
    decision: 'approve' | 'deny'
    expectedVersion: number
    idempotencyKey: string
    correlationId: string
  }) {
    const grant = this.#grant(input.grantId)
    if (
      this.#decisionReplay(
        `grant-decision:${input.idempotencyKey}`,
        grant.grantId,
      )
    )
      return structuredClone(grant)
    this.#version(grant, input.expectedVersion)
    if (grant.status !== 'pending_approval')
      throw new SupportAccessError('INVALID_STATE')
    if (
      !['support', 'security_approver', 'kms_operator'].includes(
        input.actor.role,
      )
    )
      throw new SupportAccessError('APPROVER_ROLE_REQUIRED')
    if (input.actor.principalId === grant.requesterPrincipalId)
      throw new SupportAccessError('SEPARATION_OF_DUTY_REQUIRED')
    if (grant.approvalPrincipalIds.includes(input.actor.principalId))
      throw new SupportAccessError('DISTINCT_APPROVER_REQUIRED')
    if (input.decision === 'deny') {
      grant.status = 'denied'
      grant.generation++
    } else {
      grant.approvalPrincipalIds.push(input.actor.principalId)
      if (grant.approvalPrincipalIds.length >= grant.requiredApprovals) {
        if (
          grant.actions.includes('content.decrypt') &&
          !grant.approvalPrincipalIds.some((id) =>
            id === input.actor.principalId
              ? input.actor.role === 'kms_operator'
              : false,
          )
        )
          throw new SupportAccessError('KMS_OPERATOR_APPROVAL_REQUIRED')
        grant.status = 'active'
        grant.issuedAt = this.now().toISOString()
      }
    }
    grant.version++
    this.#idempotency.set(
      `grant-decision:${input.idempotencyKey}`,
      grant.grantId,
    )
    this.#appendAudit(
      grant,
      input.actor.principalId,
      input.decision === 'approve' ? 'grant.approved' : 'grant.denied',
      'success',
      input.decision,
      input.correlationId,
    )
    if (grant.status === 'active')
      this.#appendAudit(
        grant,
        input.actor.principalId,
        'grant.activated',
        'success',
        'approval_threshold_met',
        input.correlationId,
      )
    return structuredClone(grant)
  }

  revokeGrant(input: {
    grantId: string
    actor: SupportActor
    expectedVersion: number
    idempotencyKey: string
    correlationId: string
  }) {
    const grant = this.#grant(input.grantId)
    if (
      this.#decisionReplay(
        `grant-revoke:${input.idempotencyKey}`,
        grant.grantId,
      )
    )
      return structuredClone(grant)
    this.#version(grant, input.expectedVersion)
    if (
      input.actor.principalId !== grant.requesterPrincipalId &&
      input.actor.role !== 'security_approver'
    )
      throw new SupportAccessError('REVOKE_FORBIDDEN')
    if (terminal(grant.status)) return structuredClone(grant)
    grant.status = 'revoked'
    grant.revokedAt = this.now().toISOString()
    grant.generation++
    grant.version++
    this.#revokeLeases(grant.grantId, null)
    this.#idempotency.set(`grant-revoke:${input.idempotencyKey}`, grant.grantId)
    this.#appendAudit(
      grant,
      input.actor.principalId,
      'grant.revoked',
      'success',
      'early_revoke',
      input.correlationId,
    )
    return structuredClone(grant)
  }

  issueLease(input: {
    grantId: string
    actor: SupportActor
    sessionId?: string | null
    objectId?: string | null
    action: SupportAccessAction
    correlationId: string
  }): IssuedAccessLease {
    this.expire()
    const grant = this.#grant(input.grantId)
    if (grant.status !== 'active')
      throw new SupportAccessError('GRANT_INACTIVE')
    if (input.actor.principalId !== grant.supportPrincipalId)
      throw new SupportAccessError('SUPPORT_PRINCIPAL_MISMATCH')
    if (!grant.actions.includes(input.action))
      throw new SupportAccessError('ACTION_SCOPE_MISMATCH')
    if ((grant.sessionId ?? null) !== (input.sessionId ?? null))
      throw new SupportAccessError('SESSION_SCOPE_MISMATCH')
    if (objectId(grant) !== (input.objectId ?? null))
      throw new SupportAccessError('OBJECT_SCOPE_MISMATCH')
    if (
      input.action === 'content.decrypt' &&
      input.actor.role !== 'kms_operator'
    )
      throw new SupportAccessError('KMS_DECRYPT_ROLE_REQUIRED')
    const token = randomBytes(32).toString('base64url')
    const issuedAt = this.now()
    const expiresAt = new Date(
      Math.min(Date.parse(grant.expiresAt), issuedAt.getTime() + 5 * 60_000),
    ).toISOString()
    const lease: AccessLease = {
      leaseId: `jit_${randomUUID()}`,
      grantId: grant.grantId,
      breakGlassId: null,
      tenantId: grant.tenantId,
      organizationId: grant.organizationId,
      workspaceId: grant.workspaceId,
      sessionId: grant.sessionId,
      objectId: objectId(grant),
      action: input.action,
      principalId: input.actor.principalId,
      generation: grant.generation,
      issuedAt: issuedAt.toISOString(),
      expiresAt,
      revokedAt: null,
      tokenHash: hash(token),
    }
    this.#leases.set(lease.leaseId, lease)
    this.#appendAudit(
      grant,
      input.actor.principalId,
      'lease.issued',
      'success',
      input.action,
      input.correlationId,
    )
    const { tokenHash: _hidden, ...publicLease } = lease
    return { lease: publicLease, token }
  }

  issueBreakGlassLease(input: {
    breakGlassId: string
    actor: SupportActor
    sessionId: string
    objectId: string
    action: SupportAccessAction
    correlationId: string
  }): IssuedAccessLease {
    this.expire()
    const request = this.#breakGlassRequest(input.breakGlassId)
    if (request.status !== 'active')
      throw new SupportAccessError('BREAK_GLASS_INACTIVE')
    if (
      input.actor.principalId !== request.requesterPrincipalId &&
      !request.approvalPrincipalIds.includes(input.actor.principalId)
    )
      throw new SupportAccessError('BREAK_GLASS_PRINCIPAL_MISMATCH')
    if (
      request.sessionId !== input.sessionId ||
      request.objectId !== input.objectId ||
      !request.actions.includes(input.action)
    )
      throw new SupportAccessError('BREAK_GLASS_SCOPE_MISMATCH')
    if (
      input.action === 'content.decrypt' &&
      input.actor.role !== 'kms_operator'
    )
      throw new SupportAccessError('KMS_DECRYPT_ROLE_REQUIRED')
    const token = randomBytes(32).toString('base64url')
    const issuedAt = this.now()
    const lease: AccessLease = {
      leaseId: `jit_${randomUUID()}`,
      grantId: null,
      breakGlassId: request.breakGlassId,
      tenantId: request.tenantId,
      organizationId: request.organizationId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      objectId: request.objectId,
      action: input.action,
      principalId: input.actor.principalId,
      generation: request.generation,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(
        Math.min(
          Date.parse(request.expiresAt),
          issuedAt.getTime() + 2 * 60_000,
        ),
      ).toISOString(),
      revokedAt: null,
      tokenHash: hash(token),
    }
    this.#leases.set(lease.leaseId, lease)
    this.#appendAggregateAudit(
      request,
      input.actor.principalId,
      'lease.issued',
      'success',
      input.action,
      input.correlationId,
    )
    const { tokenHash: _hidden, ...publicLease } = lease
    return { lease: publicLease, token }
  }

  consumeLease(input: {
    leaseId: string
    token: string
    tenantId: string
    organizationId: string
    workspaceId: string
    sessionId?: string | null
    objectId?: string | null
    action: SupportAccessAction
    principalId: string
    correlationId: string
  }) {
    this.expire()
    const lease = this.#leases.get(input.leaseId)
    if (!lease || lease.tokenHash !== hash(input.token))
      throw new SupportAccessError('LEASE_INVALID')
    const aggregate = lease.grantId
      ? this.#grant(lease.grantId)
      : this.#breakGlassRequest(lease.breakGlassId!)
    if (
      aggregate.status !== 'active' ||
      aggregate.generation !== lease.generation ||
      lease.revokedAt ||
      Date.parse(lease.expiresAt) <= this.now().getTime()
    )
      throw new SupportAccessError('LEASE_REVOKED_OR_EXPIRED')
    if (
      lease.tenantId !== input.tenantId ||
      lease.organizationId !== input.organizationId ||
      lease.workspaceId !== input.workspaceId ||
      lease.sessionId !== (input.sessionId ?? null) ||
      lease.objectId !== (input.objectId ?? null) ||
      lease.action !== input.action ||
      lease.principalId !== input.principalId
    )
      throw new SupportAccessError('LEASE_SCOPE_MISMATCH')
    lease.revokedAt = this.now().toISOString()
    const auditAction =
      input.action === 'content.view'
        ? 'content.viewed'
        : input.action === 'content.decrypt'
          ? 'content.decrypted'
          : 'content.downloaded'
    this.#appendAggregateAudit(
      aggregate,
      input.principalId,
      auditAction,
      'success',
      input.action,
      input.correlationId,
    )
    return true
  }

  createBreakGlass(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    sessionId?: string | null
    objectId: string
    actions: SupportAccessAction[]
    incidentId: string
    reason: string
    requester: SupportActor
    durationMinutes: number
    idempotencyKey: string
    correlationId: string
  }): BreakGlassRequest {
    if (input.requester.role !== 'operator')
      throw new SupportAccessError('OPERATOR_REQUIRED')
    if (!/^INC-[A-Z0-9-]{4,64}$/.test(input.incidentId))
      throw new SupportAccessError('INCIDENT_ID_REQUIRED')
    if (!input.sessionId || !input.objectId || input.actions.length === 0)
      throw new SupportAccessError('NARROW_OBJECT_SCOPE_REQUIRED')
    if (input.durationMinutes < 1 || input.durationMinutes > 15)
      throw new SupportAccessError('TTL_OUT_OF_RANGE')
    const key = `break-glass:${input.idempotencyKey}`
    const existing = this.#idempotency.get(key)
    if (existing) return structuredClone(this.#breakGlass.get(existing)!)
    const createdAt = this.now()
    const request: BreakGlassRequest = {
      schemaVersion: 1,
      breakGlassId: `bgr_${randomUUID()}`,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId ?? null,
      objectId: input.objectId,
      actions: [...new Set(input.actions)],
      incidentId: input.incidentId,
      reason: input.reason,
      requesterPrincipalId: input.requester.principalId,
      mfaEvidenceId: null,
      approvalPrincipalIds: [],
      status: 'pending_verification',
      issuedAt: null,
      expiresAt: new Date(
        createdAt.getTime() + input.durationMinutes * 60_000,
      ).toISOString(),
      revokedAt: null,
      version: 1,
      generation: 0,
      idempotencyKey: input.idempotencyKey,
    }
    this.#breakGlass.set(request.breakGlassId, request)
    this.#idempotency.set(key, request.breakGlassId)
    this.#appendAggregateAudit(
      request,
      input.requester.principalId,
      'break_glass.started',
      'requested',
      input.incidentId,
      input.correlationId,
    )
    return structuredClone(request)
  }

  verifyBreakGlassMfa(input: {
    breakGlassId: string
    actor: SupportActor
    mfaEvidenceId: string
    expectedVersion: number
    idempotencyKey: string
    correlationId: string
  }) {
    const request = this.#breakGlassRequest(input.breakGlassId)
    if (
      this.#decisionReplay(
        `break-mfa:${input.idempotencyKey}`,
        request.breakGlassId,
      )
    )
      return structuredClone(request)
    this.#version(request, input.expectedVersion)
    if (input.actor.principalId !== request.requesterPrincipalId)
      throw new SupportAccessError('REQUESTER_MFA_REQUIRED')
    request.mfaEvidenceId = input.mfaEvidenceId
    request.status = 'pending_approval'
    request.version++
    this.#idempotency.set(
      `break-mfa:${input.idempotencyKey}`,
      request.breakGlassId,
    )
    this.#appendAggregateAudit(
      request,
      input.actor.principalId,
      'break_glass.mfa_verified',
      'success',
      'strong_mfa',
      input.correlationId,
    )
    return structuredClone(request)
  }

  approveBreakGlass(input: {
    breakGlassId: string
    actor: SupportActor
    expectedVersion: number
    idempotencyKey: string
    correlationId: string
  }) {
    const request = this.#breakGlassRequest(input.breakGlassId)
    if (
      this.#decisionReplay(
        `break-approval:${input.idempotencyKey}`,
        request.breakGlassId,
      )
    )
      return structuredClone(request)
    this.#version(request, input.expectedVersion)
    if (request.status !== 'pending_approval')
      throw new SupportAccessError('INVALID_STATE')
    if (!['security_approver', 'kms_operator'].includes(input.actor.role))
      throw new SupportAccessError('APPROVER_ROLE_REQUIRED')
    if (
      input.actor.principalId === request.requesterPrincipalId ||
      request.approvalPrincipalIds.includes(input.actor.principalId)
    )
      throw new SupportAccessError('SEPARATION_OF_DUTY_REQUIRED')
    request.approvalPrincipalIds.push(input.actor.principalId)
    request.version++
    if (request.approvalPrincipalIds.length === 2) {
      const alarm: SecurityOutboxRecord = {
        outboxId: `out_${randomUUID()}`,
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        workspaceId: request.workspaceId,
        kind: 'break_glass_alarm',
        aggregateId: request.breakGlassId,
        status: 'pending',
        attempts: 0,
        availableAt: this.now().toISOString(),
        deliveredAt: null,
      }
      this.#outbox.push(alarm)
      request.status = 'active'
      request.issuedAt = this.now().toISOString()
      this.#appendAggregateAudit(
        request,
        input.actor.principalId,
        'alarm.enqueued',
        'success',
        'durable_outbox',
        input.correlationId,
      )
      this.#appendAggregateAudit(
        request,
        input.actor.principalId,
        'break_glass.activated',
        'success',
        'double_approval',
        input.correlationId,
      )
    }
    this.#idempotency.set(
      `break-approval:${input.idempotencyKey}`,
      request.breakGlassId,
    )
    return structuredClone(request)
  }

  revokeBreakGlass(input: {
    breakGlassId: string
    actor: SupportActor
    expectedVersion: number
    correlationId: string
  }) {
    const request = this.#breakGlassRequest(input.breakGlassId)
    this.#version(request, input.expectedVersion)
    if (!['operator', 'security_approver'].includes(input.actor.role))
      throw new SupportAccessError('REVOKE_FORBIDDEN')
    request.status = 'revoked'
    request.revokedAt = this.now().toISOString()
    request.generation++
    request.version++
    this.#revokeLeases(null, request.breakGlassId)
    this.#queueTenantNotification(request)
    this.#appendAggregateAudit(
      request,
      input.actor.principalId,
      'break_glass.ended',
      'success',
      'early_revoke',
      input.correlationId,
    )
    return structuredClone(request)
  }

  expire() {
    const now = this.now().getTime()
    for (const grant of this.#grants.values())
      if (!terminal(grant.status) && Date.parse(grant.expiresAt) <= now) {
        grant.status = 'expired'
        grant.generation++
        grant.version++
        this.#revokeLeases(grant.grantId, null)
        this.#appendAudit(
          grant,
          'system',
          'grant.expired',
          'success',
          'ttl',
          `expiry:${grant.grantId}`,
        )
      }
    for (const request of this.#breakGlass.values())
      if (!terminal(request.status) && Date.parse(request.expiresAt) <= now) {
        request.status = 'expired'
        request.generation++
        request.version++
        this.#revokeLeases(null, request.breakGlassId)
        this.#queueTenantNotification(request)
        this.#appendAggregateAudit(
          request,
          'system',
          'break_glass.ended',
          'success',
          'ttl',
          `expiry:${request.breakGlassId}`,
        )
      }
  }

  listAudit(scope: { organizationId: string; workspaceId: string }) {
    return this.#audit
      .filter(
        (v) =>
          v.organizationId === scope.organizationId &&
          v.workspaceId === scope.workspaceId,
      )
      .map((v) => structuredClone(v))
  }
  listOutbox(scope: { organizationId: string; workspaceId: string }) {
    return this.#outbox
      .filter(
        (v) =>
          v.organizationId === scope.organizationId &&
          v.workspaceId === scope.workspaceId,
      )
      .map((v) => structuredClone(v))
  }
  deliverOutbox(outboxId: string) {
    const record = this.#outbox.find((v) => v.outboxId === outboxId)
    if (!record) throw new SupportAccessError('OUTBOX_NOT_FOUND')
    record.attempts++
    record.status = 'delivered'
    record.deliveredAt = this.now().toISOString()
    return structuredClone(record)
  }
  failOutbox(outboxId: string, retryAt: string) {
    const record = this.#outbox.find((value) => value.outboxId === outboxId)
    if (!record) throw new SupportAccessError('OUTBOX_NOT_FOUND')
    record.attempts++
    record.status = 'pending'
    record.availableAt = retryAt
    record.deliveredAt = null
    return structuredClone(record)
  }
  verifyAuditChain() {
    let previousHash = 'GENESIS'
    for (const record of this.#audit) {
      const { recordHash, ...unsigned } = record
      if (
        record.previousHash !== previousHash ||
        hash(JSON.stringify(unsigned)) !== recordHash
      )
        return false
      previousHash = recordHash
    }
    return true
  }

  #grant(id: string) {
    const value = this.#grants.get(id)
    if (!value) throw new SupportAccessError('GRANT_NOT_FOUND')
    return value
  }
  #breakGlassRequest(id: string) {
    const value = this.#breakGlass.get(id)
    if (!value) throw new SupportAccessError('BREAK_GLASS_NOT_FOUND')
    return value
  }
  #version(value: { version: number }, expected: number) {
    if (value.version !== expected)
      throw new SupportAccessError('VERSION_CONFLICT')
  }
  #decisionReplay(key: string, aggregateId: string) {
    const seen = this.#idempotency.get(key)
    if (seen && seen !== aggregateId)
      throw new SupportAccessError('IDEMPOTENCY_CONFLICT')
    return Boolean(seen)
  }
  #revokeLeases(grantId: string | null, breakGlassId: string | null) {
    for (const lease of this.#leases.values())
      if (
        lease.grantId === grantId &&
        lease.breakGlassId === breakGlassId &&
        !lease.revokedAt
      )
        lease.revokedAt = this.now().toISOString()
  }
  #queueTenantNotification(request: BreakGlassRequest) {
    if (
      this.#outbox.some(
        (v) =>
          v.kind === 'tenant_notification' &&
          v.aggregateId === request.breakGlassId,
      )
    )
      return
    this.#outbox.push({
      outboxId: `out_${randomUUID()}`,
      tenantId: request.tenantId,
      organizationId: request.organizationId,
      workspaceId: request.workspaceId,
      kind: 'tenant_notification',
      aggregateId: request.breakGlassId,
      status: 'pending',
      attempts: 0,
      availableAt: this.now().toISOString(),
      deliveredAt: null,
    })
  }
  #appendAudit(
    grant: SupportGrant,
    actor: string,
    action: string,
    outcome: SecurityAuditRecord['outcome'],
    reason: string,
    correlationId: string,
  ) {
    this.#appendAggregateAudit(
      grant,
      actor,
      action,
      outcome,
      reason,
      correlationId,
    )
  }
  #appendAggregateAudit(
    aggregate: SupportGrant | BreakGlassRequest,
    actor: string,
    action: string,
    outcome: SecurityAuditRecord['outcome'],
    reason: string,
    correlationId: string,
  ) {
    const previousHash = this.#audit.at(-1)?.recordHash ?? 'GENESIS'
    const unsigned = {
      sequence: this.#audit.length + 1,
      tenantId: aggregate.tenantId,
      organizationId: aggregate.organizationId,
      workspaceId: aggregate.workspaceId,
      actorPrincipalId: actor,
      scope: JSON.stringify({
        workspaceId: aggregate.workspaceId,
        sessionId: aggregate.sessionId,
        objectId:
          'grantId' in aggregate ? objectId(aggregate) : aggregate.objectId,
        actions: aggregate.actions,
      }),
      action,
      outcome,
      reason,
      grantId: 'grantId' in aggregate ? aggregate.grantId : null,
      breakGlassId: 'breakGlassId' in aggregate ? aggregate.breakGlassId : null,
      occurredAt: this.now().toISOString(),
      correlationId,
      previousHash,
    }
    this.#audit.push({
      ...unsigned,
      recordHash: hash(JSON.stringify(unsigned)),
    })
  }
}
