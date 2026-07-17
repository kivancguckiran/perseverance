import { Pool, type PoolClient } from 'pg'
import {
  SupportAccessError,
  SupportAccessService,
  type AccessLease,
  type BreakGlassRequest,
  type SecurityAuditRecord,
  type SecurityOutboxRecord,
  type SupportAccessState,
  type SupportApprovalRecord,
} from './index'
import type { SupportGrant } from '@persistent-codex/control-plane-contracts'

export interface SupportAccessScope {
  tenantId: string
  organizationId: string
  workspaceId: string
}

export interface SupportAccessRepository {
  readonly adapter: 'in-memory' | 'postgresql'
  transaction<T>(
    scope: SupportAccessScope,
    operation: (service: SupportAccessService) => T | Promise<T>,
  ): Promise<T>
  verifyAuditChain(scope: SupportAccessScope): Promise<boolean>
  close(): Promise<void>
}

export class InMemorySupportAccessRepository implements SupportAccessRepository {
  readonly adapter = 'in-memory' as const
  readonly #states = new Map<string, SupportAccessState>()
  readonly #now: () => Date

  constructor(options: {
    explicitUsage: 'test' | 'development'
    now?: () => Date
  }) {
    if (!options.explicitUsage)
      throw new SupportAccessError('EXPLICIT_IN_MEMORY_USAGE_REQUIRED')
    this.#now = options.now ?? (() => new Date())
  }

  async transaction<T>(
    scope: SupportAccessScope,
    operation: (service: SupportAccessService) => T | Promise<T>,
  ) {
    const key = `${scope.organizationId}:${scope.workspaceId}`
    const service = new SupportAccessService(this.#now, this.#states.get(key))
    const result = await operation(service)
    this.#states.set(key, service.snapshot())
    return result
  }

  async verifyAuditChain(scope: SupportAccessScope) {
    return this.transaction(scope, (service) => service.verifyAuditChain())
  }

  async close() {}
}

type Row = Record<string, unknown>

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function byAggregate(
  approvals: SupportApprovalRecord[],
  kind: SupportApprovalRecord['aggregateKind'],
  id: string,
) {
  return approvals
    .filter(
      (approval) =>
        approval.aggregateKind === kind &&
        approval.aggregateId === id &&
        approval.decision === 'approve',
    )
    .map((approval) => approval.approverPrincipalId)
}

export class PostgresSupportAccessRepository implements SupportAccessRepository {
  readonly adapter = 'postgresql' as const
  readonly #pool: Pool
  readonly #now: () => Date
  readonly #ownsPool: boolean

  constructor(
    pool: Pool,
    options: { now?: () => Date; ownsPool?: boolean } = {},
  ) {
    this.#pool = pool
    this.#now = options.now ?? (() => new Date())
    this.#ownsPool = options.ownsPool ?? false
  }

  async transaction<T>(
    scope: SupportAccessScope,
    operation: (service: SupportAccessService) => T | Promise<T>,
  ) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.organization_id',$1,true),
                set_config('app.workspace_id',$2,true)`,
        [scope.organizationId, scope.workspaceId],
      )
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
        [scope.organizationId, scope.workspaceId],
      )
      const before = await this.#load(client, scope)
      const service = new SupportAccessService(this.#now, before)
      const result = await operation(service)
      await this.#save(client, scope, before, service.snapshot())
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async verifyAuditChain(scope: SupportAccessScope) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await client.query(
        `SELECT set_config('app.organization_id',$1,true),
                set_config('app.workspace_id',$2,true)`,
        [scope.organizationId, scope.workspaceId],
      )
      const result = await client.query<{ valid: boolean }>(
        `SELECT NOT EXISTS (
           SELECT 1
           FROM persistent_codex.immutable_security_audit current_row
           LEFT JOIN persistent_codex.immutable_security_audit previous_row
             ON previous_row.organization_id=current_row.organization_id
            AND previous_row.workspace_id=current_row.workspace_id
            AND previous_row.chain_sequence=current_row.chain_sequence-1
           WHERE current_row.organization_id=$1 AND current_row.workspace_id=$2
             AND ((current_row.chain_sequence=1 AND current_row.previous_hash<>public.digest('GENESIS','sha256'))
               OR (current_row.chain_sequence>1 AND current_row.previous_hash<>previous_row.record_hash))
         ) AND COALESCE((
           SELECT head.last_sequence=COALESCE(MAX(a.chain_sequence),0)
              AND head.last_hash=COALESCE(
                (array_agg(a.record_hash ORDER BY a.chain_sequence DESC))[1],
                public.digest('GENESIS','sha256'))
           FROM persistent_codex.security_audit_chain_heads head
           LEFT JOIN persistent_codex.immutable_security_audit a
             ON a.organization_id=head.organization_id AND a.workspace_id=head.workspace_id
           WHERE head.organization_id=$1 AND head.workspace_id=$2
           GROUP BY head.last_sequence,head.last_hash
         ),true) AS valid`,
        [scope.organizationId, scope.workspaceId],
      )
      await client.query('COMMIT')
      return result.rows[0]?.valid ?? false
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async close() {
    if (this.#ownsPool) await this.#pool.end()
  }

  async #load(
    client: PoolClient,
    scope: SupportAccessScope,
  ): Promise<SupportAccessState> {
    const params = [scope.organizationId, scope.workspaceId]
    const grantRows = await client.query(
      `SELECT * FROM persistent_codex.support_grants WHERE organization_id=$1 AND workspace_id=$2 FOR UPDATE`,
      params,
    )
    const grantApprovalRows = await client.query(
      `SELECT * FROM persistent_codex.support_grant_approvals WHERE organization_id=$1 AND workspace_id=$2 ORDER BY decided_at,approval_id`,
      params,
    )
    const breakRows = await client.query(
      `SELECT * FROM persistent_codex.break_glass_requests WHERE organization_id=$1 AND workspace_id=$2 FOR UPDATE`,
      params,
    )
    const breakApprovalRows = await client.query(
      `SELECT * FROM persistent_codex.break_glass_approvals WHERE organization_id=$1 AND workspace_id=$2 ORDER BY approved_at,approval_id`,
      params,
    )
    const leaseRows = await client.query(
      `SELECT * FROM persistent_codex.jit_access_leases WHERE organization_id=$1 AND workspace_id=$2 FOR UPDATE`,
      params,
    )
    const auditRows = await client.query(
      `SELECT chain_sequence,actor_principal_id,scope_json,action,outcome,reason_code,grant_id,break_glass_id,correlation_id,occurred_at,encode(previous_hash,'hex') previous_hash,encode(record_hash,'hex') record_hash FROM persistent_codex.immutable_security_audit WHERE organization_id=$1 AND workspace_id=$2 ORDER BY chain_sequence`,
      params,
    )
    const outboxRows = await client.query(
      `SELECT * FROM persistent_codex.security_notification_outbox WHERE organization_id=$1 AND workspace_id=$2 FOR UPDATE`,
      params,
    )
    const approvals: SupportApprovalRecord[] = [
      ...grantApprovalRows.rows.map((row: Row) => ({
        aggregateKind: 'support_grant' as const,
        aggregateId: String(row.grant_id),
        approvalId: String(row.approval_id),
        approverPrincipalId: String(row.approver_principal_id),
        approverRole:
          row.approver_role as SupportApprovalRecord['approverRole'],
        decision: row.decision as 'approve' | 'deny',
        mfaEvidenceId: String(row.mfa_evidence_id),
        idempotencyKey: String(row.idempotency_key),
        decidedAt: iso(row.decided_at),
      })),
      ...breakApprovalRows.rows.map((row: Row) => ({
        aggregateKind: 'break_glass' as const,
        aggregateId: String(row.break_glass_id),
        approvalId: String(row.approval_id),
        approverPrincipalId: String(row.approver_principal_id),
        approverRole:
          row.approver_role as SupportApprovalRecord['approverRole'],
        decision: 'approve' as const,
        mfaEvidenceId: String(row.mfa_evidence_id),
        idempotencyKey: String(row.idempotency_key),
        decidedAt: iso(row.approved_at),
      })),
    ]
    const grants: SupportGrant[] = grantRows.rows.map((row: Row) => ({
      schemaVersion: 1,
      grantId: String(row.grant_id),
      tenantId: String(row.tenant_id),
      organizationId: String(row.organization_id),
      workspaceId: String(row.workspace_id),
      sessionId: row.session_id == null ? null : String(row.session_id),
      artifactId: row.artifact_id == null ? null : String(row.artifact_id),
      attachmentId:
        row.attachment_id == null ? null : String(row.attachment_id),
      actions: stringArray(row.actions) as SupportGrant['actions'],
      reason: String(row.reason),
      requesterPrincipalId: String(row.requester_principal_id),
      supportPrincipalId: String(row.support_principal_id),
      mfaEvidenceId:
        row.mfa_evidence_id == null ? null : String(row.mfa_evidence_id),
      requiredApprovals: Number(row.required_approvals),
      approvalPrincipalIds: byAggregate(
        approvals,
        'support_grant',
        String(row.grant_id),
      ),
      status: row.status as SupportGrant['status'],
      issuedAt: nullableIso(row.issued_at),
      expiresAt: iso(row.expires_at),
      revokedAt: nullableIso(row.revoked_at),
      version: Number(row.version),
      generation: Number(row.generation),
      idempotencyKey: String(row.idempotency_key),
    }))
    const breakGlass: BreakGlassRequest[] = breakRows.rows.map((row: Row) => ({
      schemaVersion: 1,
      breakGlassId: String(row.break_glass_id),
      tenantId: String(row.tenant_id),
      organizationId: String(row.organization_id),
      workspaceId: String(row.workspace_id),
      sessionId: row.session_id == null ? null : String(row.session_id),
      objectId: String(row.object_id),
      actions: stringArray(row.actions) as BreakGlassRequest['actions'],
      incidentId: String(row.incident_id),
      reason: String(row.reason),
      requesterPrincipalId: String(row.requester_principal_id),
      mfaEvidenceId:
        row.mfa_evidence_id == null ? null : String(row.mfa_evidence_id),
      approvalPrincipalIds: byAggregate(
        approvals,
        'break_glass',
        String(row.break_glass_id),
      ),
      status: row.status as BreakGlassRequest['status'],
      issuedAt: nullableIso(row.issued_at),
      expiresAt: iso(row.expires_at),
      revokedAt: nullableIso(row.revoked_at),
      version: Number(row.version),
      generation: Number(row.generation),
      idempotencyKey: String(row.idempotency_key),
    }))
    const leases: AccessLease[] = leaseRows.rows.map((row: Row) => ({
      leaseId: String(row.lease_id),
      grantId: row.grant_id == null ? null : String(row.grant_id),
      breakGlassId:
        row.break_glass_id == null ? null : String(row.break_glass_id),
      tenantId: String(row.tenant_id),
      organizationId: String(row.organization_id),
      workspaceId: String(row.workspace_id),
      sessionId: row.session_id == null ? null : String(row.session_id),
      objectId: row.object_id == null ? null : String(row.object_id),
      action: row.action as AccessLease['action'],
      principalId: String(row.principal_id),
      generation: Number(row.generation),
      issuedAt: iso(row.issued_at),
      expiresAt: iso(row.expires_at),
      consumedAt: nullableIso(row.consumed_at),
      revokedAt: nullableIso(row.revoked_at),
      tokenHash: Buffer.from(row.token_hash as Buffer).toString('hex'),
    }))
    const audit: SecurityAuditRecord[] = auditRows.rows.map((row: Row) => ({
      sequence: Number(row.chain_sequence),
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      actorPrincipalId: String(row.actor_principal_id),
      scope: JSON.stringify(row.scope_json),
      action: String(row.action),
      outcome: row.outcome as SecurityAuditRecord['outcome'],
      reason: String(row.reason_code),
      grantId: row.grant_id == null ? null : String(row.grant_id),
      breakGlassId:
        row.break_glass_id == null ? null : String(row.break_glass_id),
      occurredAt: iso(row.occurred_at),
      correlationId: String(row.correlation_id),
      previousHash: String(row.previous_hash),
      recordHash: String(row.record_hash),
    }))
    const outbox: SecurityOutboxRecord[] = outboxRows.rows.map((row: Row) => ({
      outboxId: String(row.outbox_id),
      tenantId: String(row.tenant_id),
      organizationId: String(row.organization_id),
      workspaceId: String(row.workspace_id),
      kind: row.kind as SecurityOutboxRecord['kind'],
      aggregateId: String(row.aggregate_id),
      status: row.status as SecurityOutboxRecord['status'],
      attempts: Number(row.attempts),
      availableAt: iso(row.available_at),
      deliveredAt: nullableIso(row.delivered_at),
      idempotencyKey: String(row.idempotency_key),
      lastResultIdempotencyKey:
        row.result_idempotency_key == null
          ? null
          : String(row.result_idempotency_key),
    }))
    const idempotency = [
      ...grantRows.rows.flatMap((row: Row) =>
        stringArray(row.operation_idempotency_keys).map((key) => ({
          key,
          aggregateId: String(row.grant_id),
        })),
      ),
      ...breakRows.rows.flatMap((row: Row) =>
        stringArray(row.operation_idempotency_keys).map((key) => ({
          key,
          aggregateId: String(row.break_glass_id),
        })),
      ),
    ]
    return { grants, breakGlass, leases, approvals, idempotency, audit, outbox }
  }

  async #save(
    client: PoolClient,
    scope: SupportAccessScope,
    before: SupportAccessState,
    after: SupportAccessState,
  ) {
    const params = [scope.organizationId, scope.workspaceId]
    const oldGrants = new Map(
      before.grants.map((value) => [value.grantId, value]),
    )
    for (const grant of after.grants) {
      const old = oldGrants.get(grant.grantId)
      const operationKeys = after.idempotency
        .filter((v) => v.aggregateId === grant.grantId)
        .map((v) => v.key)
      if (!old)
        await client.query(
          `INSERT INTO persistent_codex.support_grants (organization_id,workspace_id,grant_id,tenant_id,session_id,artifact_id,attachment_id,actions,reason,requester_principal_id,support_principal_id,mfa_evidence_id,required_approvals,status,issued_at,expires_at,revoked_at,version,generation,idempotency_key,operation_idempotency_keys) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [
            ...params,
            grant.grantId,
            grant.tenantId,
            grant.sessionId,
            grant.artifactId,
            grant.attachmentId,
            grant.actions,
            grant.reason,
            grant.requesterPrincipalId,
            grant.supportPrincipalId,
            grant.mfaEvidenceId,
            grant.requiredApprovals,
            grant.status,
            grant.issuedAt,
            grant.expiresAt,
            grant.revokedAt,
            grant.version,
            grant.generation,
            grant.idempotencyKey,
            operationKeys,
          ],
        )
      else if (JSON.stringify(old) !== JSON.stringify(grant)) {
        const result = await client.query(
          `UPDATE persistent_codex.support_grants SET mfa_evidence_id=$4,status=$5,issued_at=$6,expires_at=$7,revoked_at=$8,version=$9,generation=$10,operation_idempotency_keys=$11 WHERE organization_id=$1 AND workspace_id=$2 AND grant_id=$3 AND version=$12`,
          [
            ...params,
            grant.grantId,
            grant.mfaEvidenceId,
            grant.status,
            grant.issuedAt,
            grant.expiresAt,
            grant.revokedAt,
            grant.version,
            grant.generation,
            operationKeys,
            old.version,
          ],
        )
        if (result.rowCount !== 1)
          throw new SupportAccessError('VERSION_CONFLICT')
      }
      await client.query(
        `INSERT INTO persistent_codex.access_revocation_epochs (organization_id,workspace_id,aggregate_kind,aggregate_id,generation) VALUES ($1,$2,'support_grant',$3,$4) ON CONFLICT (organization_id,workspace_id,aggregate_kind,aggregate_id) DO UPDATE SET generation=EXCLUDED.generation,updated_at=now()`,
        [...params, grant.grantId, grant.generation],
      )
    }
    const oldBreak = new Map(
      before.breakGlass.map((value) => [value.breakGlassId, value]),
    )
    for (const request of after.breakGlass) {
      const old = oldBreak.get(request.breakGlassId)
      const operationKeys = after.idempotency
        .filter((v) => v.aggregateId === request.breakGlassId)
        .map((v) => v.key)
      if (!old)
        await client.query(
          `INSERT INTO persistent_codex.break_glass_requests (organization_id,workspace_id,break_glass_id,tenant_id,session_id,object_id,actions,incident_id,reason,requester_principal_id,mfa_evidence_id,status,issued_at,expires_at,revoked_at,version,generation,idempotency_key,operation_idempotency_keys) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            ...params,
            request.breakGlassId,
            request.tenantId,
            request.sessionId,
            request.objectId,
            request.actions,
            request.incidentId,
            request.reason,
            request.requesterPrincipalId,
            request.mfaEvidenceId,
            request.status,
            request.issuedAt,
            request.expiresAt,
            request.revokedAt,
            request.version,
            request.generation,
            request.idempotencyKey,
            operationKeys,
          ],
        )
      else if (JSON.stringify(old) !== JSON.stringify(request)) {
        const result = await client.query(
          `UPDATE persistent_codex.break_glass_requests SET mfa_evidence_id=$4,status=$5,issued_at=$6,expires_at=$7,revoked_at=$8,version=$9,generation=$10,operation_idempotency_keys=$11 WHERE organization_id=$1 AND workspace_id=$2 AND break_glass_id=$3 AND version=$12`,
          [
            ...params,
            request.breakGlassId,
            request.mfaEvidenceId,
            request.status,
            request.issuedAt,
            request.expiresAt,
            request.revokedAt,
            request.version,
            request.generation,
            operationKeys,
            old.version,
          ],
        )
        if (result.rowCount !== 1)
          throw new SupportAccessError('VERSION_CONFLICT')
      }
      await client.query(
        `INSERT INTO persistent_codex.access_revocation_epochs (organization_id,workspace_id,aggregate_kind,aggregate_id,generation) VALUES ($1,$2,'break_glass',$3,$4) ON CONFLICT (organization_id,workspace_id,aggregate_kind,aggregate_id) DO UPDATE SET generation=EXCLUDED.generation,updated_at=now()`,
        [...params, request.breakGlassId, request.generation],
      )
    }
    const oldApprovals = new Set(
      before.approvals.map((value) => value.approvalId),
    )
    for (const approval of after.approvals.filter(
      (value) => !oldApprovals.has(value.approvalId),
    )) {
      if (approval.aggregateKind === 'support_grant')
        await client.query(
          `INSERT INTO persistent_codex.support_grant_approvals (organization_id,workspace_id,grant_id,approval_id,approver_principal_id,approver_role,decision,mfa_evidence_id,idempotency_key,decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            ...params,
            approval.aggregateId,
            approval.approvalId,
            approval.approverPrincipalId,
            approval.approverRole,
            approval.decision,
            approval.mfaEvidenceId,
            approval.idempotencyKey,
            approval.decidedAt,
          ],
        )
      else
        await client.query(
          `INSERT INTO persistent_codex.break_glass_approvals (organization_id,workspace_id,break_glass_id,approval_id,approver_principal_id,approver_role,mfa_evidence_id,idempotency_key,approved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            ...params,
            approval.aggregateId,
            approval.approvalId,
            approval.approverPrincipalId,
            approval.approverRole,
            approval.mfaEvidenceId,
            approval.idempotencyKey,
            approval.decidedAt,
          ],
        )
    }
    const oldLeases = new Map(
      before.leases.map((value) => [value.leaseId, value]),
    )
    for (const lease of after.leases) {
      const old = oldLeases.get(lease.leaseId)
      if (!old)
        await client.query(
          `INSERT INTO persistent_codex.jit_access_leases (organization_id,workspace_id,lease_id,tenant_id,grant_id,break_glass_id,session_id,object_id,action,principal_id,token_hash,generation,issued_at,expires_at,consumed_at,revoked_at,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,decode($11,'hex'),$12,$13,$14,$15,$16,$17)`,
          [
            ...params,
            lease.leaseId,
            lease.tenantId,
            lease.grantId,
            lease.breakGlassId,
            lease.sessionId,
            lease.objectId,
            lease.action,
            lease.principalId,
            lease.tokenHash,
            lease.generation,
            lease.issuedAt,
            lease.expiresAt,
            lease.consumedAt,
            lease.revokedAt,
            `lease:${lease.leaseId}`,
          ],
        )
      else if (
        old.consumedAt !== lease.consumedAt ||
        old.revokedAt !== lease.revokedAt
      )
        await client.query(
          `UPDATE persistent_codex.jit_access_leases SET consumed_at=$4,revoked_at=$5 WHERE organization_id=$1 AND workspace_id=$2 AND lease_id=$3 AND consumed_at IS NOT DISTINCT FROM $6 AND revoked_at IS NOT DISTINCT FROM $7`,
          [
            ...params,
            lease.leaseId,
            lease.consumedAt,
            lease.revokedAt,
            old.consumedAt,
            old.revokedAt,
          ],
        )
    }
    for (const record of after.audit.slice(before.audit.length))
      await client.query(
        `SELECT persistent_codex.append_security_audit($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)`,
        [
          ...params,
          record.actorPrincipalId,
          record.scope,
          record.action,
          record.outcome,
          record.reason,
          record.grantId,
          record.breakGlassId,
          record.correlationId,
        ],
      )
    const oldOutbox = new Map(
      before.outbox.map((value) => [value.outboxId, value]),
    )
    for (const record of after.outbox) {
      const old = oldOutbox.get(record.outboxId)
      if (!old)
        await client.query(
          `INSERT INTO persistent_codex.security_notification_outbox (organization_id,workspace_id,outbox_id,tenant_id,kind,aggregate_id,status,attempts,available_at,delivered_at,idempotency_key,result_idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            ...params,
            record.outboxId,
            record.tenantId,
            record.kind,
            record.aggregateId,
            record.status,
            record.attempts,
            record.availableAt,
            record.deliveredAt,
            record.idempotencyKey,
            record.lastResultIdempotencyKey,
          ],
        )
      else if (JSON.stringify(old) !== JSON.stringify(record))
        await client.query(
          `UPDATE persistent_codex.security_notification_outbox SET status=$4,attempts=$5,available_at=$6,delivered_at=$7,result_idempotency_key=$8 WHERE organization_id=$1 AND workspace_id=$2 AND outbox_id=$3`,
          [
            ...params,
            record.outboxId,
            record.status,
            record.attempts,
            record.availableAt,
            record.deliveredAt,
            record.lastResultIdempotencyKey,
          ],
        )
    }
  }
}

export function createPostgresSupportAccessRepository(input: {
  connectionString: string
  now?: () => Date
}) {
  const pool = new Pool({ connectionString: input.connectionString })
  return new PostgresSupportAccessRepository(pool, {
    ownsPool: true,
    ...(input.now ? { now: input.now } : {}),
  })
}
