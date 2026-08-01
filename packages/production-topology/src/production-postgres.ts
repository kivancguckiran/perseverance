import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import type { CapacityVector } from './contracts'
import type { ClaimedWork, PostgresTopologyRepository } from './postgres'

export interface ProductionScope {
  tenantId: string
  organizationId: string
  workspaceId: string
}

export interface ProductionSession extends ProductionScope {
  sessionId: string
  folderId: string
  title: string
  status: 'active' | 'archived' | 'recovery_required'
  providerId: string
  requestedPolicy: Record<string, unknown>
  resolvedModel: string | null
  reasoningEffort: string
  titleGeneratedAt: string | null
  codexThreadId: string | null
  highWaterSequence: number
  version: number
  createdAt: string
  updatedAt: string
}

export interface ProductionRun extends ProductionScope {
  sessionId: string
  runId: string
  traceId: string | null
  queueItemId: string
  idempotencyKey: string
  promptObjectKey: string
  outputObjectKey: string | null
  state:
    | 'queued'
    | 'awaiting_approval'
    | 'leased'
    | 'starting'
    | 'running'
    | 'completed'
    | 'failed'
    | 'poisoned'
    | 'recovery_required'
    | 'outcome_unknown'
  fencingToken: number | null
  leaseId: string | null
  runtimeId: string | null
  regionId: string | null
  nodeId: string | null
  codexThreadId: string | null
  codexTurnId: string | null
  upstreamStartIntent: boolean
  upstreamStartCommitted: boolean
  attempt: number
  queuedAt: string
  startedAt: string | null
  terminalAt: string | null
  updatedAt: string
}

export interface ProductionEvent extends ProductionScope {
  sessionId: string
  runId: string | null
  eventId: string
  sequence: number
  eventType: string
  fencingToken: number | null
  payload: Record<string, unknown>
  byteLength: number
  occurredAt: string
}

export interface ProductionApproval extends ProductionScope {
  sessionId: string
  runId: string
  approvalId: string
  kind: 'command' | 'file' | 'network'
  context: Record<string, unknown>
  state: 'pending' | 'accepted' | 'declined' | 'expired'
  version: number
  decidedBy: string | null
  createdAt: string
  decidedAt: string | null
}

export interface ProductionArtifact {
  organizationId: string
  workspaceId: string
  sessionId: string
  artifactId: string
  objectKey: string
}

type Row = Record<string, unknown>
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value)
const nullable = (value: unknown) => (value == null ? null : String(value))
const asJson = (value: unknown): Record<string, unknown> =>
  (typeof value === 'string' ? JSON.parse(value) : value) as Record<
    string,
    unknown
  >

function session(row: Row): ProductionSession {
  return {
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    sessionId: String(row.session_id),
    folderId: String(row.folder_id),
    title: String(row.title),
    status: row.status as ProductionSession['status'],
    providerId: String(row.provider_id),
    requestedPolicy: asJson(row.requested_policy),
    resolvedModel: nullable(row.resolved_model),
    reasoningEffort: String(row.reasoning_effort),
    titleGeneratedAt:
      row.title_generated_at == null ? null : iso(row.title_generated_at),
    codexThreadId: nullable(row.codex_thread_id),
    highWaterSequence: Number(row.high_water_sequence),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function run(row: Row): ProductionRun {
  return {
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    traceId: nullable(row.trace_id),
    queueItemId: String(row.queue_item_id),
    idempotencyKey: String(row.idempotency_key),
    promptObjectKey: String(row.prompt_object_key),
    outputObjectKey: nullable(row.output_object_key),
    state: row.state as ProductionRun['state'],
    fencingToken: row.fencing_token == null ? null : Number(row.fencing_token),
    leaseId: nullable(row.lease_id),
    runtimeId: nullable(row.runtime_id),
    regionId: nullable(row.region_id),
    nodeId: nullable(row.node_id),
    codexThreadId: nullable(row.codex_thread_id),
    codexTurnId: nullable(row.codex_turn_id),
    upstreamStartIntent: Boolean(row.upstream_start_intent),
    upstreamStartCommitted: Boolean(row.upstream_start_committed),
    attempt: Number(row.attempt),
    queuedAt: iso(row.queued_at),
    startedAt: row.started_at == null ? null : iso(row.started_at),
    terminalAt: row.terminal_at == null ? null : iso(row.terminal_at),
    updatedAt: iso(row.updated_at),
  }
}

function event(row: Row): ProductionEvent {
  return {
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    sessionId: String(row.session_id),
    runId: nullable(row.run_id),
    eventId: String(row.event_id),
    sequence: Number(row.sequence),
    eventType: String(row.event_type),
    fencingToken: row.fencing_token == null ? null : Number(row.fencing_token),
    payload: asJson(row.payload),
    byteLength: Number(row.byte_length),
    occurredAt: iso(row.occurred_at),
  }
}

function approval(row: Row): ProductionApproval {
  return {
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    approvalId: String(row.approval_id),
    kind: row.kind as ProductionApproval['kind'],
    context: asJson(row.context),
    state: row.state as ProductionApproval['state'],
    version: Number(row.version),
    decidedBy: nullable(row.decided_by),
    createdAt: iso(row.created_at),
    decidedAt: row.decided_at == null ? null : iso(row.decided_at),
  }
}

export class ProductionPostgresRepository {
  readonly pool: Pool
  readonly ownsPool: boolean

  constructor(pool: Pool, options: { ownsPool?: boolean } = {}) {
    this.pool = pool
    this.ownsPool = options.ownsPool ?? false
  }

  async #tx<T>(
    scope: ProductionScope,
    operation: (client: PoolClient) => Promise<T>,
  ) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.tenant_id',$1,true),
                set_config('app.organization_id',$2,true),
                set_config('app.workspace_id',$3,true)`,
        [scope.tenantId, scope.organizationId, scope.workspaceId],
      )
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async #system<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async createSession(
    input: ProductionScope & {
      sessionId?: string
      folderId: string
      title: string
      providerId: string
      requestedPolicy: Record<string, unknown>
      resolvedModel?: string | null
      reasoningEffort: string
    },
  ): Promise<ProductionSession> {
    const sessionId = input.sessionId ?? `ses_${randomUUID()}`
    return this.#tx(input, async (client) => {
      const result = await client.query(
        `INSERT INTO persistent_codex.ha_sessions
          (tenant_id,organization_id,workspace_id,session_id,status,folder_id,title,
           provider_id,requested_policy,resolved_model,reasoning_effort)
         VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8::jsonb,$9,$10)
         ON CONFLICT (tenant_id,organization_id,workspace_id,session_id)
         DO UPDATE SET updated_at=persistent_codex.ha_sessions.updated_at
         RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          sessionId,
          input.folderId,
          input.title,
          input.providerId,
          JSON.stringify(input.requestedPolicy),
          input.resolvedModel ?? null,
          input.reasoningEffort,
        ],
      )
      return session(result.rows[0] as Row)
    })
  }

  async getWorkspace(scope: ProductionScope, workspaceId: string) {
    return this.#tx(scope, async (client) => {
      const result = await client.query(
        `SELECT organization_id,workspace_id,name
         FROM persistent_codex.workspaces
         WHERE organization_id=$1 AND workspace_id=$2`,
        [scope.organizationId, workspaceId],
      )
      if (!result.rowCount) return null
      return {
        tenantId: scope.tenantId,
        organizationId: String(result.rows[0]!.organization_id),
        workspaceId: String(result.rows[0]!.workspace_id),
        name: String(result.rows[0]!.name),
      }
    })
  }

  async getArtifact(
    scope: ProductionScope,
    artifactId: string,
  ): Promise<ProductionArtifact | null> {
    return this.#tx(scope, async (client) => {
      const result = await client.query(
        `SELECT organization_id,workspace_id,session_id,artifact_id,object_key
         FROM persistent_codex.artifacts
         WHERE organization_id=$1 AND workspace_id=$2 AND artifact_id=$3`,
        [scope.organizationId, scope.workspaceId, artifactId],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]!
      return {
        organizationId: String(row.organization_id),
        workspaceId: String(row.workspace_id),
        sessionId: String(row.session_id),
        artifactId: String(row.artifact_id),
        objectKey: String(row.object_key),
      }
    })
  }

  async getSession(
    scope: ProductionScope,
    sessionId: string,
  ): Promise<ProductionSession | null> {
    return this.#tx(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.ha_sessions
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND session_id=$4`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, sessionId],
      )
      return result.rowCount ? session(result.rows[0] as Row) : null
    })
  }

  async listSessions(
    scope: ProductionScope,
    input: {
      limit: number
      archived: boolean
      cursor?: { updatedAt: string; sessionId: string }
    },
  ): Promise<{ sessions: ProductionSession[]; hasMore: boolean }> {
    return this.#tx(scope, async (client) => {
      const values: unknown[] = [
        scope.tenantId,
        scope.organizationId,
        scope.workspaceId,
        input.archived,
        input.limit + 1,
      ]
      const cursorClause = input.cursor
        ? `AND (updated_at,session_id) < ($6::timestamptz,$7)`
        : ''
      if (input.cursor)
        values.push(input.cursor.updatedAt, input.cursor.sessionId)
      const result = await client.query(
        `SELECT * FROM persistent_codex.ha_sessions
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND (($4::boolean AND status='archived') OR
                (NOT $4::boolean AND status<>'archived')) ${cursorClause}
         ORDER BY updated_at DESC,session_id DESC LIMIT $5`,
        values,
      )
      const sessions = result.rows
        .slice(0, input.limit)
        .map((row) => session(row as Row))
      return { sessions, hasMore: result.rows.length > input.limit }
    })
  }

  async updateConversation(
    scope: ProductionScope,
    sessionId: string,
    changes: { folderId?: string; title?: string },
  ): Promise<ProductionSession | null> {
    return this.#tx(scope, async (client) => {
      const result = await client.query(
        `UPDATE persistent_codex.ha_sessions
         SET folder_id=COALESCE($5,folder_id),title=COALESCE($6,title),
             title_generated_at=CASE WHEN $6 IS NULL THEN title_generated_at ELSE NULL END,
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND session_id=$4
         RETURNING *`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          sessionId,
          changes.folderId ?? null,
          changes.title ?? null,
        ],
      )
      return result.rowCount ? session(result.rows[0] as Row) : null
    })
  }

  async setSessionArchived(
    scope: ProductionScope,
    sessionId: string,
    archived: boolean,
  ): Promise<ProductionSession | null> {
    return this.#tx(scope, async (client) => {
      const result = await client.query(
        `UPDATE persistent_codex.ha_sessions
         SET status=$5,version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND session_id=$4
         RETURNING *`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          sessionId,
          archived ? 'archived' : 'active',
        ],
      )
      return result.rowCount ? session(result.rows[0] as Row) : null
    })
  }

  async setGeneratedTitle(
    scope: ProductionScope,
    sessionId: string,
    title: string,
  ): Promise<boolean> {
    return this.#tx(scope, async (client) => {
      const result = await client.query(
        `UPDATE persistent_codex.ha_sessions
         SET title=$5,title_generated_at=now(),version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND session_id=$4
           AND title='Yeni konuşma' AND title_generated_at IS NULL`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          sessionId,
          title,
        ],
      )
      return (result.rowCount ?? 0) > 0
    })
  }

  async enqueueTurn(
    input: ProductionScope & {
      sessionId: string
      runId?: string
      queueItemId?: string
      idempotencyKey: string
      promptObjectKey: string
      requestBody: unknown
      requiredRegionId: string
      maxAttempts: number
      traceId?: string | null
      approval?: {
        approvalId?: string
        kind: ProductionApproval['kind']
        context: Record<string, unknown>
      }
    },
  ): Promise<{
    run: ProductionRun
    approval: ProductionApproval | null
    created: boolean
  }> {
    const runId = input.runId ?? `run_${randomUUID()}`
    const queueItemId = input.queueItemId ?? `queue_${randomUUID()}`
    const requestHash = createHash('sha256')
      .update(JSON.stringify(input.requestBody))
      .digest('hex')
    return this.#tx(input, async (client) => {
      const current = await client.query(
        `SELECT * FROM persistent_codex.ha_runs
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND idempotency_key=$4`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.idempotencyKey,
        ],
      )
      if (current.rowCount) {
        const existing = current.rows[0] as Row
        if (existing.request_hash !== requestHash)
          throw new Error('IDEMPOTENCY_KEY_REUSED')
        const existingApproval = await client.query(
          `SELECT * FROM persistent_codex.ha_approvals
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND run_id=$4`,
          [
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            existing.run_id,
          ],
        )
        return {
          run: run(existing),
          approval: existingApproval.rowCount
            ? approval(existingApproval.rows[0] as Row)
            : null,
          created: false,
        }
      }
      const finish = await client.query(
        `SELECT COALESCE(max(virtual_finish),0)+1 AS next_finish
         FROM persistent_codex.scheduler_queue WHERE tenant_id=$1`,
        [input.tenantId],
      )
      const initialState = input.approval ? 'retry_wait' : 'queued'
      const notBefore = input.approval
        ? new Date(Date.now() + 24 * 60 * 60 * 1_000)
        : new Date()
      await client.query(
        `INSERT INTO persistent_codex.scheduler_queue
          (tenant_id,organization_id,workspace_id,queue_item_id,run_id,session_id,
           provider_id,idempotency_key,required_region_id,state,priority,
           virtual_finish,attempt,max_attempts,not_before,trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,'codex',$7,$8,$9,0,$10,0,$11,$12,$13)`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          queueItemId,
          runId,
          input.sessionId,
          input.idempotencyKey,
          input.requiredRegionId,
          initialState,
          finish.rows[0]!.next_finish,
          input.maxAttempts,
          notBefore,
          input.traceId ?? null,
        ],
      )
      const inserted = await client.query(
        `INSERT INTO persistent_codex.ha_runs
          (tenant_id,organization_id,workspace_id,session_id,run_id,queue_item_id,
           idempotency_key,request_hash,prompt_object_key,state,trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.sessionId,
          runId,
          queueItemId,
          input.idempotencyKey,
          requestHash,
          input.promptObjectKey,
          input.approval ? 'awaiting_approval' : 'queued',
          input.traceId ?? null,
        ],
      )
      let createdApproval: ProductionApproval | null = null
      if (input.approval) {
        const approvalId = input.approval.approvalId ?? `apr_${randomUUID()}`
        const approvalResult = await client.query(
          `INSERT INTO persistent_codex.ha_approvals
            (tenant_id,organization_id,workspace_id,session_id,run_id,approval_id,
             kind,context,state,trace_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING *`,
          [
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            input.sessionId,
            runId,
            approvalId,
            input.approval.kind,
            JSON.stringify(input.approval.context),
            input.traceId ?? null,
          ],
        )
        createdApproval = approval(approvalResult.rows[0] as Row)
      }
      return {
        run: run(inserted.rows[0] as Row),
        approval: createdApproval,
        created: true,
      }
    })
  }

  async decideApproval(
    input: ProductionScope & {
      approvalId: string
      expectedVersion: number
      decision: 'accept' | 'decline'
      principalId: string
    },
  ): Promise<ProductionApproval | null> {
    return this.#tx(input, async (client) => {
      const result = await client.query(
        `UPDATE persistent_codex.ha_approvals
         SET state=$1,version=version+1,decided_by=$2,decided_at=now()
         WHERE tenant_id=$3 AND organization_id=$4 AND workspace_id=$5
           AND approval_id=$6 AND state='pending' AND version=$7
         RETURNING *`,
        [
          input.decision === 'accept' ? 'accepted' : 'declined',
          input.principalId,
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.approvalId,
          input.expectedVersion,
        ],
      )
      if (!result.rowCount) return null
      const decided = approval(result.rows[0] as Row)
      if (input.decision === 'accept') {
        await client.query(
          `UPDATE persistent_codex.ha_runs SET state='queued',updated_at=now()
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND run_id=$4`,
          [
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            decided.runId,
          ],
        )
        await client.query(
          `UPDATE persistent_codex.scheduler_queue SET state='queued',not_before=now(),updated_at=now()
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND run_id=$4
             AND state='retry_wait'`,
          [
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            decided.runId,
          ],
        )
      } else {
        await client.query(
          `UPDATE persistent_codex.ha_runs SET state='failed',terminal_outcome='failed',
             terminal_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND run_id=$4`,
          [
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            decided.runId,
          ],
        )
        await client.query(
          `UPDATE persistent_codex.scheduler_queue SET state='failed',updated_at=now()
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND run_id=$4`,
          [
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            decided.runId,
          ],
        )
      }
      return decided
    })
  }

  async listApprovals(
    scope: ProductionScope,
    state?: ProductionApproval['state'],
  ): Promise<ProductionApproval[]> {
    return this.#tx(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.ha_approvals
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND ($4::text IS NULL OR state=$4)
         ORDER BY created_at,approval_id`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          state ?? null,
        ],
      )
      return result.rows.map((row) => approval(row as Row))
    })
  }

  async replay(
    scope: ProductionScope,
    sessionId: string,
    afterSequence = 0,
    limit = 500,
  ): Promise<{ events: ProductionEvent[]; highWaterSequence: number }> {
    return this.#tx(scope, async (client) => {
      const [events, highWater] = await Promise.all([
        client.query(
          `SELECT * FROM persistent_codex.ha_events
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
             AND session_id=$4 AND sequence>$5 ORDER BY sequence LIMIT $6`,
          [
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            sessionId,
            afterSequence,
            limit,
          ],
        ),
        client.query(
          `SELECT high_water_sequence FROM persistent_codex.ha_sessions
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND session_id=$4`,
          [scope.tenantId, scope.organizationId, scope.workspaceId, sessionId],
        ),
      ])
      return {
        events: events.rows.map((row) => event(row as Row)),
        highWaterSequence: Number(highWater.rows[0]?.high_water_sequence ?? 0),
      }
    })
  }

  async getRun(
    scope: ProductionScope,
    runId: string,
  ): Promise<ProductionRun | null> {
    return this.#tx(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.ha_runs
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND run_id=$4`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, runId],
      )
      return result.rowCount ? run(result.rows[0] as Row) : null
    })
  }

  async bindClaim(
    claimed: ClaimedWork,
    input: { runtimeId: string; ownerId: string },
  ): Promise<ProductionRun> {
    const scope = {
      tenantId: claimed.item.tenantId,
      organizationId: claimed.item.organizationId,
      workspaceId: claimed.item.workspaceId,
    }
    return this.#system(async (client) => {
      const result = await client.query(
        `UPDATE persistent_codex.ha_runs SET state='starting',fencing_token=$1,
           lease_id=$2,runtime_id=$3,region_id=$4,node_id=$5,
           attempt=attempt+1,started_at=COALESCE(started_at,now()),updated_at=now()
         WHERE tenant_id=$6 AND organization_id=$7 AND workspace_id=$8 AND run_id=$9
           AND state IN ('queued','recovery_required') RETURNING *`,
        [
          claimed.lease.fencingToken,
          claimed.lease.leaseId,
          input.runtimeId,
          claimed.regionId,
          claimed.nodeId,
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          claimed.item.runId,
        ],
      )
      if (!result.rowCount) throw new Error('RUN_NOT_CLAIMABLE')
      await client.query(
        `INSERT INTO persistent_codex.ha_runtime_starts
          (tenant_id,organization_id,workspace_id,run_id,fencing_token,runtime_id,owner_id,started_at,trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          claimed.item.runId,
          claimed.lease.fencingToken,
          input.runtimeId,
          input.ownerId,
          run(result.rows[0] as Row).traceId,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.ha_capacity_usage
          (tenant_id,organization_id,workspace_id,run_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          claimed.item.runId,
        ],
      )
      await client.query(
        `UPDATE persistent_codex.capacity_reservations
         SET state='bound',runtime_id=$1,updated_at=now()
         WHERE tenant_id=$2 AND organization_id=$3 AND workspace_id=$4
           AND reservation_id=$5 AND fencing_token=$6`,
        [
          input.runtimeId,
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          claimed.capacityReservationId,
          claimed.lease.fencingToken,
        ],
      )
      const placementId = `placement_${randomUUID()}`
      await client.query(
        `INSERT INTO persistent_codex.workspace_placements
          (tenant_id,organization_id,workspace_id,placement_id,region_id,node_id,
           runtime_id,generation,state,affinity,capacity,fencing_token)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,'starting',
                jsonb_build_object('requiredRegionId',$5::text,'preferredNodeIds','[]'::jsonb),
                capacity,$9
         FROM persistent_codex.capacity_reservations
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND reservation_id=$10`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          placementId,
          claimed.regionId,
          claimed.nodeId,
          input.runtimeId,
          claimed.lease.fencingToken,
          claimed.lease.fencingToken,
          claimed.capacityReservationId,
        ],
      )
      if (claimed.item.attempt > 1)
        await client.query(
          `INSERT INTO persistent_codex.recovery_outcomes
            (tenant_id,organization_id,workspace_id,recovery_id,run_id,
             previous_placement_id,next_placement_id,previous_fencing_token,
             next_fencing_token,checkpoint_id,outcome,reason_code,rpo_ms,rto_ms,occurred_at)
           VALUES ($1,$2,$3,$4,$5,
             (SELECT placement_id FROM persistent_codex.workspace_placements
              WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
                AND fencing_token<$6 ORDER BY fencing_token DESC LIMIT 1),
             $7,$6-1,$6,NULL,'rescheduled','LEASE_EXPIRED',0,0,now())
           ON CONFLICT DO NOTHING`,
          [
            scope.tenantId,
            scope.organizationId,
            scope.workspaceId,
            `recovery_${claimed.item.runId}_${claimed.lease.fencingToken}`,
            claimed.item.runId,
            claimed.lease.fencingToken,
            placementId,
          ],
        )
      return run(result.rows[0] as Row)
    })
  }

  async appendFencedEvent(
    input: ProductionScope & {
      sessionId: string
      runId: string
      eventId: string
      eventType: string
      fencingToken: number
      payload: Record<string, unknown>
      occurredAt?: Date
    },
  ): Promise<{ accepted: boolean; sequence: number; reasonCode: string }> {
    return this.#system(async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.append_fenced_ha_event(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.sessionId,
          input.runId,
          input.eventId,
          input.eventType,
          input.fencingToken,
          JSON.stringify(input.payload),
          input.occurredAt ?? new Date(),
        ],
      )
      if (result.rows[0]?.accepted)
        await client.query(
          `UPDATE persistent_codex.ha_events e SET trace_id=r.trace_id
           FROM persistent_codex.ha_runs r
           WHERE e.tenant_id=$1 AND e.organization_id=$2 AND e.workspace_id=$3
             AND e.event_id=$4 AND r.tenant_id=e.tenant_id
             AND r.organization_id=e.organization_id AND r.workspace_id=e.workspace_id
             AND r.run_id=$5`,
          [
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            input.eventId,
            input.runId,
          ],
        )
      return {
        accepted: Boolean(result.rows[0]?.accepted),
        sequence: Number(result.rows[0]?.sequence ?? 0),
        reasonCode: String(result.rows[0]?.reason_code ?? 'EVENT_REJECTED'),
      }
    })
  }

  async markRunRunning(
    input: ProductionScope & {
      runId: string
      fencingToken: number
      codexThreadId: string
      codexTurnId: string
    },
  ) {
    return this.#system(async (client) => {
      const valid = await client.query(
        `SELECT persistent_codex.assert_workspace_fence($1,$2,$3,$4,$5) valid`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.runId,
          input.fencingToken,
        ],
      )
      if (!valid.rows[0]?.valid) return false
      await client.query(
        `UPDATE persistent_codex.ha_runs SET state='running',codex_thread_id=$1,
           codex_turn_id=$2,upstream_start_committed=true,updated_at=now()
         WHERE tenant_id=$3 AND organization_id=$4 AND workspace_id=$5
           AND run_id=$6 AND fencing_token=$7`,
        [
          input.codexThreadId,
          input.codexTurnId,
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.runId,
          input.fencingToken,
        ],
      )
      await client.query(
        `UPDATE persistent_codex.ha_sessions SET codex_thread_id=$1,updated_at=now()
         WHERE tenant_id=$2 AND organization_id=$3 AND workspace_id=$4
           AND session_id=(SELECT session_id FROM persistent_codex.ha_runs
             WHERE tenant_id=$2 AND organization_id=$3 AND workspace_id=$4 AND run_id=$5)`,
        [
          input.codexThreadId,
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.runId,
        ],
      )
      await client.query(
        `UPDATE persistent_codex.scheduler_queue SET state='running',updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND run_id=$4
           AND fencing_token=$5`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.runId,
          input.fencingToken,
        ],
      )
      return true
    })
  }

  async markUpstreamStartIntent(
    input: ProductionScope & {
      runId: string
      fencingToken: number
      codexThreadId: string
    },
  ) {
    return this.#system(async (client) => {
      const result = await client.query(
        `UPDATE persistent_codex.ha_runs r SET upstream_start_intent=true,
           codex_thread_id=$1,updated_at=now()
         WHERE tenant_id=$2 AND organization_id=$3 AND workspace_id=$4
           AND run_id=$5 AND fencing_token=$6
           AND persistent_codex.assert_workspace_fence($2,$3,$4,$5,$6)`,
        [
          input.codexThreadId,
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.runId,
          input.fencingToken,
        ],
      )
      return result.rowCount === 1
    })
  }

  async completeRun(
    input: ProductionScope & {
      runId: string
      fencingToken: number
      outcome: 'completed' | 'failed' | 'outcome_unknown'
      outputObjectKey?: string | null
    },
  ) {
    return this.#system(async (client) => {
      const valid = await client.query(
        `SELECT persistent_codex.assert_workspace_fence($1,$2,$3,$4,$5) valid`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.runId,
          input.fencingToken,
        ],
      )
      if (!valid.rows[0]?.valid) return false
      await client.query(
        `UPDATE persistent_codex.ha_runs SET state=$1,terminal_outcome=$1,
           output_object_key=$2,terminal_at=now(),updated_at=now()
         WHERE tenant_id=$3 AND organization_id=$4 AND workspace_id=$5
           AND run_id=$6 AND fencing_token=$7`,
        [
          input.outcome,
          input.outputObjectKey ?? null,
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.runId,
          input.fencingToken,
        ],
      )
      return true
    })
  }

  async markRunRetry(
    input: ProductionScope & {
      runId: string
      fencingToken: number
      state: 'recovery_required' | 'poisoned'
      errorCode: string
    },
  ) {
    return this.#system(async (client) => {
      const valid = await client.query(
        `SELECT persistent_codex.assert_workspace_fence($1,$2,$3,$4,$5) valid`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.runId,
          input.fencingToken,
        ],
      )
      if (!valid.rows[0]?.valid) return false
      const result = await client.query(
        `UPDATE persistent_codex.ha_runs SET state=$1,
           terminal_outcome=CASE WHEN $1='poisoned' THEN 'failed' ELSE NULL END,
           terminal_at=CASE WHEN $1='poisoned' THEN now() ELSE NULL END,updated_at=now()
         WHERE tenant_id=$2 AND organization_id=$3 AND workspace_id=$4
           AND run_id=$5 AND fencing_token=$6`,
        [
          input.state,
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.runId,
          input.fencingToken,
        ],
      )
      return result.rowCount === 1
    })
  }

  async meterCapacity(
    input: ProductionScope & {
      runId: string
      fencingToken: number
      resource: 'outputBytes' | 'artifactBytes' | 'corpusIndexBytes'
      quantity: number
    },
  ): Promise<{ accepted: boolean; reasonCode: string }> {
    return this.#system(async (client) => {
      const column =
        input.resource === 'outputBytes'
          ? 'output_bytes'
          : input.resource === 'artifactBytes'
            ? 'artifact_bytes'
            : 'corpus_index_bytes'
      const reservation = await client.query(
        `SELECT capacity FROM persistent_codex.capacity_reservations
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND fencing_token=$4 AND state IN ('held','bound') FOR UPDATE`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.fencingToken,
        ],
      )
      if (!reservation.rowCount)
        return { accepted: false, reasonCode: 'CAPACITY_RESERVATION_MISSING' }
      const limit = Number(
        asJson(reservation.rows[0]!.capacity)[input.resource] ?? 0,
      )
      const usage = await client.query(
        `SELECT ${column} value FROM persistent_codex.ha_capacity_usage
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND run_id=$4
         FOR UPDATE`,
        [input.tenantId, input.organizationId, input.workspaceId, input.runId],
      )
      const observed = Number(usage.rows[0]?.value ?? 0) + input.quantity
      if (observed > limit) {
        await client.query(
          `INSERT INTO persistent_codex.capacity_limit_outcomes
            (tenant_id,organization_id,workspace_id,outcome_id,run_id,resource,action,
             limit_value,observed_value,reason_code,occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,'rejected',$7,$8,$9,now())`,
          [
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            `limit_${randomUUID()}`,
            input.runId,
            input.resource === 'outputBytes'
              ? 'output_bytes'
              : input.resource === 'artifactBytes'
                ? 'artifact_bytes'
                : 'corpus_index_bytes',
            limit,
            observed,
            `${input.resource.toUpperCase()}_CAPACITY_EXCEEDED`,
          ],
        )
        return {
          accepted: false,
          reasonCode: `${input.resource.toUpperCase()}_CAPACITY_EXCEEDED`,
        }
      }
      await client.query(
        `UPDATE persistent_codex.ha_capacity_usage SET ${column}=$1,updated_at=now()
         WHERE tenant_id=$2 AND organization_id=$3 AND workspace_id=$4 AND run_id=$5`,
        [
          observed,
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.runId,
        ],
      )
      return { accepted: true, reasonCode: 'CAPACITY_RESERVED' }
    })
  }

  async listOutbox(limit = 100) {
    return this.#system(async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.ha_event_outbox
         WHERE published_at IS NULL ORDER BY outbox_id FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      )
      return result.rows as Row[]
    })
  }

  async markOutboxPublished(ids: number[]) {
    if (ids.length === 0) return
    await this.#system(async (client) => {
      await client.query(
        `UPDATE persistent_codex.ha_event_outbox SET published_at=now()
         WHERE outbox_id=ANY($1::bigint[])`,
        [ids],
      )
    })
  }

  async requeueExpired(topology: PostgresTopologyRepository, now = new Date()) {
    const recovered = await topology.recoverExpired(now)
    if (recovered === 0) return 0
    return this.#system(async (client) => {
      const rows = await client.query(
        `SELECT r.tenant_id,r.organization_id,r.workspace_id,r.queue_item_id,
                q.fencing_token,r.run_id,r.upstream_start_intent,r.upstream_start_committed
         FROM persistent_codex.ha_runs r
         JOIN persistent_codex.scheduler_queue q
           ON q.tenant_id=r.tenant_id AND q.organization_id=r.organization_id
          AND q.workspace_id=r.workspace_id AND q.queue_item_id=r.queue_item_id
         WHERE q.state='recovery_required'
           AND NOT EXISTS (
             SELECT 1 FROM persistent_codex.workspace_leases l
             WHERE l.tenant_id=r.tenant_id AND l.organization_id=r.organization_id
               AND l.workspace_id=r.workspace_id AND l.run_id=r.run_id
               AND l.state='active')
         FOR UPDATE OF r,q`,
      )
      let count = 0
      for (const row of rows.rows as Row[]) {
        if (row.upstream_start_intent || row.upstream_start_committed) {
          await client.query(
            `UPDATE persistent_codex.ha_runs SET state='outcome_unknown',
               terminal_outcome='outcome_unknown',terminal_at=now(),updated_at=now()
             WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND run_id=$4`,
            [row.tenant_id, row.organization_id, row.workspace_id, row.run_id],
          )
          continue
        }
        await client.query(
          `UPDATE persistent_codex.ha_runs SET state='recovery_required',updated_at=now()
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND run_id=$4`,
          [row.tenant_id, row.organization_id, row.workspace_id, row.run_id],
        )
        await client.query(
          `UPDATE persistent_codex.scheduler_queue SET state='queued',not_before=now(),updated_at=now()
           WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
             AND queue_item_id=$4 AND state='recovery_required'`,
          [
            row.tenant_id,
            row.organization_id,
            row.workspace_id,
            row.queue_item_id,
          ],
        )
        count += 1
      }
      return count
    })
  }

  async setDrain(input: {
    drainId: string
    targetKind: 'region' | 'node'
    regionId: string
    nodeId?: string | null
    state: 'cordoned' | 'draining' | 'drained' | 'maintenance'
    reasonCode: string
  }) {
    return this.#system(async (client) => {
      await client.query(
        `INSERT INTO persistent_codex.drain_states
          (tenant_id,organization_id,workspace_id,drain_id,target_kind,region_id,node_id,
           state,reason_code,requested_at)
         VALUES ('*','*','*',$1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (tenant_id,organization_id,workspace_id,drain_id)
         DO UPDATE SET state=EXCLUDED.state,reason_code=EXCLUDED.reason_code`,
        [
          input.drainId,
          input.targetKind,
          input.regionId,
          input.nodeId ?? null,
          input.state,
          input.reasonCode,
        ],
      )
    })
  }

  async close() {
    if (this.ownsPool) await this.pool.end()
  }
}

export function createProductionPostgresRepository(connectionString: string) {
  return new ProductionPostgresRepository(new Pool({ connectionString }), {
    ownsPool: true,
  })
}
