import { Pool, type PoolClient } from 'pg'
import {
  capacityReservationSchema,
  schedulerQueueItemSchema,
  workspaceLeaseSchema,
  type CapacityVector,
  type SchedulerQueueItem,
  type TenantSchedulingPolicy,
  type WorkspaceLease,
} from './contracts'

type Scope = {
  tenantId: string
  organizationId: string
  workspaceId: string
}
type Row = Record<string, unknown>
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value)
const json = <T>(value: unknown): T =>
  (typeof value === 'string' ? JSON.parse(value) : value) as T

function queueItem(row: Row): SchedulerQueueItem {
  return schedulerQueueItemSchema.parse({
    schemaVersion: 1,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    queueItemId: row.queue_item_id,
    runId: row.run_id,
    sessionId: row.session_id,
    providerId: row.provider_id,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    priority: Number(row.priority),
    virtualFinish: Number(row.virtual_finish),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    notBefore: iso(row.not_before),
    enqueuedAt: iso(row.enqueued_at),
    lastErrorCode:
      row.last_error_code == null ? null : String(row.last_error_code),
  })
}

function lease(row: Row): WorkspaceLease {
  return workspaceLeaseSchema.parse({
    schemaVersion: 1,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    leaseId: row.lease_id,
    queueItemId: row.queue_item_id,
    runId: row.run_id,
    ownerId: row.owner_id,
    fencingToken: Number(row.fencing_token),
    state: row.state,
    acquiredAt: iso(row.acquired_at),
    renewedAt: iso(row.renewed_at),
    expiresAt: iso(row.expires_at),
  })
}

export interface EnqueueInput extends Scope {
  queueItemId: string
  runId: string
  sessionId: string
  providerId: string
  idempotencyKey: string
  priority?: number
  virtualFinish: number
  maxAttempts: number
  notBefore: Date
  requiredRegionId: string
}

export interface ClaimedWork {
  item: SchedulerQueueItem
  lease: WorkspaceLease
  capacityReservationId: string
  regionId: string
  nodeId: string
}

export class PostgresTopologyRepository {
  readonly adapter = 'postgresql' as const
  readonly contractVersion = 1 as const
  readonly pool: Pool
  readonly ownsPool: boolean

  constructor(pool: Pool, options: { ownsPool?: boolean } = {}) {
    this.pool = pool
    this.ownsPool = options.ownsPool ?? false
  }

  async #tx<T>(scope: Scope, operation: (client: PoolClient) => Promise<T>) {
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

  async enqueue(input: EnqueueInput): Promise<SchedulerQueueItem> {
    return this.#tx(input, async (client) => {
      const result = await client.query(
        `INSERT INTO persistent_codex.scheduler_queue
          (tenant_id,organization_id,workspace_id,queue_item_id,run_id,session_id,
           provider_id,idempotency_key,state,priority,virtual_finish,attempt,
           max_attempts,not_before,required_region_id,enqueued_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,0,$11,$12,$13,now(),now())
         ON CONFLICT (tenant_id,organization_id,workspace_id,idempotency_key)
         DO UPDATE SET updated_at=persistent_codex.scheduler_queue.updated_at
         RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.queueItemId,
          input.runId,
          input.sessionId,
          input.providerId,
          input.idempotencyKey,
          input.priority ?? 0,
          input.virtualFinish,
          input.maxAttempts,
          input.notBefore,
          input.requiredRegionId,
        ],
      )
      return queueItem(result.rows[0] as Row)
    })
  }

  async claim(input: {
    ownerId: string
    leaseId: string
    leaseMs: number
    capacityReservationId: string
    requestedCapacity: CapacityVector
    now?: Date
  }): Promise<ClaimedWork | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.scheduler_system','1',true)`)
      const now = input.now ?? new Date()
      const candidate = await client.query(
        `WITH running AS (
           SELECT tenant_id,workspace_id,provider_id,
             count(*) FILTER (WHERE state IN ('leased','starting','running')) OVER
               (PARTITION BY tenant_id) AS tenant_running,
             count(*) FILTER (WHERE state IN ('leased','starting','running')) OVER
               (PARTITION BY tenant_id,workspace_id) AS workspace_running,
             count(*) FILTER (WHERE state IN ('leased','starting','running')) OVER
               (PARTITION BY provider_id) AS provider_running
           FROM persistent_codex.scheduler_queue
         ), eligible AS (
           SELECT q.*,p.weight,p.tenant_concurrency,p.workspace_concurrency,
                  COALESCE(r.tenant_running,0) tenant_running,
                  COALESCE(r.workspace_running,0) workspace_running,
                  COALESCE(r.provider_running,0) provider_running,
                  (SELECT count(*) FROM persistent_codex.scheduler_provider_admissions a
                   WHERE a.provider_id=q.provider_id
                     AND a.admitted_at>$1::timestamptz-interval '1 minute') provider_rate
           FROM persistent_codex.scheduler_queue q
           JOIN persistent_codex.tenant_scheduling_policies p
             ON p.tenant_id=q.tenant_id AND p.organization_id=q.organization_id
           LEFT JOIN running r ON r.tenant_id=q.tenant_id
             AND r.workspace_id=q.workspace_id AND r.provider_id=q.provider_id
           WHERE q.state IN ('queued','retry_wait') AND q.not_before <= $1::timestamptz
             AND COALESCE(r.tenant_running,0) < p.tenant_concurrency
             AND COALESCE(r.workspace_running,0) < p.workspace_concurrency
             AND COALESCE(r.provider_running,0) <
                 COALESCE((p.provider_concurrency->>q.provider_id)::integer,0)
             AND (SELECT count(*) FROM persistent_codex.scheduler_provider_admissions a
                  WHERE a.provider_id=q.provider_id
                    AND a.admitted_at>$1::timestamptz-interval '1 minute') <
                 COALESCE((p.provider_requests_per_minute->>q.provider_id)::integer,0)
             AND NOT EXISTS (
               SELECT 1 FROM persistent_codex.drain_states d
               WHERE d.region_id=q.required_region_id
                 AND d.target_kind='region' AND d.node_id IS NULL
                 AND d.state IN ('cordoned','draining','drained','maintenance'))
           ORDER BY
             (CASE WHEN $1::timestamptz-q.enqueued_at >= make_interval(secs => p.starvation_age_ms/1000.0)
               THEN 0 ELSE 1 END),
             q.virtual_finish/p.weight,q.priority DESC,q.enqueued_at,q.queue_item_id
           FOR UPDATE OF q SKIP LOCKED LIMIT 1
         ) SELECT * FROM eligible`,
        [now],
      )
      if (!candidate.rowCount) {
        await client.query('COMMIT')
        return null
      }
      const row = candidate.rows[0] as Row
      const workspaceLock = await client.query(
        `SELECT pg_try_advisory_xact_lock(hashtextextended($1,26)) AS acquired`,
        [
          JSON.stringify([
            row.tenant_id,
            row.organization_id,
            row.workspace_id,
          ]),
        ],
      )
      if (workspaceLock.rows[0]?.acquired !== true) {
        await client.query('COMMIT')
        return null
      }
      const workspaceActive = await client.query(
        `SELECT 1 FROM persistent_codex.scheduler_queue
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND state IN ('leased','starting','running') LIMIT 1`,
        [row.tenant_id, row.organization_id, row.workspace_id],
      )
      if (workspaceActive.rowCount) {
        await client.query('COMMIT')
        return null
      }
      const node = await client.query(
        `SELECT n.* FROM persistent_codex.runtime_nodes n
         WHERE n.region_id=$1 AND n.state='ready'
           AND NOT EXISTS (
             SELECT 1 FROM persistent_codex.drain_states d
             WHERE d.region_id=n.region_id AND (d.node_id IS NULL OR d.node_id=n.node_id)
               AND d.state IN ('cordoned','draining','drained','maintenance'))
           AND persistent_codex.capacity_fits(
             persistent_codex.capacity_subtract(n.capacity_total,n.capacity_reserved),$2::jsonb)
         ORDER BY n.capacity_score DESC,n.node_id
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [row.required_region_id, JSON.stringify(input.requestedCapacity)],
      )
      if (!node.rowCount) {
        await client.query('COMMIT')
        return null
      }
      const nodeRow = node.rows[0] as Row
      const tokenResult = await client.query(
        `INSERT INTO persistent_codex.workspace_fence_counters
          (tenant_id,organization_id,workspace_id,last_token,updated_at)
         VALUES ($1,$2,$3,1,$4)
         ON CONFLICT (tenant_id,organization_id,workspace_id)
         DO UPDATE SET last_token=persistent_codex.workspace_fence_counters.last_token+1,
                       updated_at=EXCLUDED.updated_at
         RETURNING last_token`,
        [row.tenant_id, row.organization_id, row.workspace_id, now],
      )
      const fencingToken = Number(tokenResult.rows[0]!.last_token)
      const expiresAt = new Date(now.getTime() + input.leaseMs)
      await client.query(
        `UPDATE persistent_codex.scheduler_queue
         SET state='leased',attempt=attempt+1,lease_owner_id=$1,
             fencing_token=$2,updated_at=$3
         WHERE tenant_id=$4 AND organization_id=$5 AND workspace_id=$6
           AND queue_item_id=$7`,
        [
          input.ownerId,
          fencingToken,
          now,
          row.tenant_id,
          row.organization_id,
          row.workspace_id,
          row.queue_item_id,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.scheduler_provider_admissions
          (tenant_id,organization_id,workspace_id,queue_item_id,provider_id,admitted_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id,organization_id,workspace_id,queue_item_id) DO NOTHING`,
        [
          row.tenant_id,
          row.organization_id,
          row.workspace_id,
          row.queue_item_id,
          row.provider_id,
          now,
        ],
      )
      const leaseResult = await client.query(
        `INSERT INTO persistent_codex.workspace_leases
          (tenant_id,organization_id,workspace_id,lease_id,queue_item_id,run_id,
           owner_id,fencing_token,state,acquired_at,renewed_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$9,$10)
         RETURNING *`,
        [
          row.tenant_id,
          row.organization_id,
          row.workspace_id,
          input.leaseId,
          row.queue_item_id,
          row.run_id,
          input.ownerId,
          fencingToken,
          now,
          expiresAt,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.capacity_reservations
          (tenant_id,organization_id,workspace_id,reservation_id,queue_item_id,
           region_id,node_id,state,capacity,fencing_token,expires_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'held',$8,$9,$10,$11)`,
        [
          row.tenant_id,
          row.organization_id,
          row.workspace_id,
          input.capacityReservationId,
          row.queue_item_id,
          nodeRow.region_id,
          nodeRow.node_id,
          JSON.stringify(input.requestedCapacity),
          fencingToken,
          expiresAt,
          now,
        ],
      )
      await client.query(
        `UPDATE persistent_codex.runtime_nodes
         SET capacity_reserved=persistent_codex.capacity_add(capacity_reserved,$1::jsonb),updated_at=$2
         WHERE region_id=$3 AND node_id=$4`,
        [
          JSON.stringify(input.requestedCapacity),
          now,
          nodeRow.region_id,
          nodeRow.node_id,
        ],
      )
      await client.query('COMMIT')
      return {
        item: queueItem({
          ...row,
          state: 'leased',
          attempt: Number(row.attempt) + 1,
        }),
        lease: lease(leaseResult.rows[0] as Row),
        capacityReservationId: input.capacityReservationId,
        regionId: String(nodeRow.region_id),
        nodeId: String(nodeRow.node_id),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async renewLease(
    input: Scope & {
      leaseId: string
      ownerId: string
      fencingToken: number
      expectedExpiresAt: Date
      nextExpiresAt: Date
    },
  ): Promise<WorkspaceLease | null> {
    return this.#tx(input, async (client) => {
      const result = await client.query(
        `UPDATE persistent_codex.workspace_leases
         SET renewed_at=now(),expires_at=$1
         WHERE tenant_id=$2 AND organization_id=$3 AND workspace_id=$4
           AND lease_id=$5 AND owner_id=$6 AND fencing_token=$7
           AND state='active' AND expires_at=$8 AND expires_at>now()
         RETURNING *`,
        [
          input.nextExpiresAt,
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.leaseId,
          input.ownerId,
          input.fencingToken,
          input.expectedExpiresAt,
        ],
      )
      if (result.rowCount)
        await client.query(
          `UPDATE persistent_codex.capacity_reservations SET expires_at=$1,updated_at=now()
           WHERE tenant_id=$2 AND organization_id=$3 AND workspace_id=$4
             AND fencing_token=$5 AND state IN ('held','bound')`,
          [
            input.nextExpiresAt,
            input.tenantId,
            input.organizationId,
            input.workspaceId,
            input.fencingToken,
          ],
        )
      return result.rowCount ? lease(result.rows[0] as Row) : null
    })
  }

  async assertFence(input: Scope & { runId: string; fencingToken: number }) {
    return this.#tx(input, async (client) => {
      const result = await client.query(
        `SELECT persistent_codex.assert_workspace_fence($1,$2,$3,$4,$5) AS valid`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.runId,
          input.fencingToken,
        ],
      )
      if (result.rows[0]?.valid !== true) throw new Error('STALE_FENCING_TOKEN')
    })
  }

  async releaseLease(
    input: Scope & {
      leaseId: string
      ownerId: string
      fencingToken: number
      terminalState: 'completed' | 'failed' | 'poisoned' | 'recovery_required'
      errorCode?: string | null
    },
  ): Promise<boolean> {
    return this.#tx(input, async (client) => {
      const locked = await client.query(
        `SELECT * FROM persistent_codex.workspace_leases
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND lease_id=$4 AND owner_id=$5 AND fencing_token=$6 AND state='active'
         FOR UPDATE`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.leaseId,
          input.ownerId,
          input.fencingToken,
        ],
      )
      if (!locked.rowCount) return false
      const current = locked.rows[0] as Row
      await client.query(
        `UPDATE persistent_codex.workspace_leases SET state='released',renewed_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND lease_id=$4`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.leaseId,
        ],
      )
      await client.query(
        `UPDATE persistent_codex.scheduler_queue
         SET state=$1,last_error_code=$2,lease_owner_id=NULL,updated_at=now()
         WHERE tenant_id=$3 AND organization_id=$4 AND workspace_id=$5
           AND queue_item_id=$6 AND fencing_token=$7`,
        [
          input.terminalState,
          input.errorCode ?? null,
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          current.queue_item_id,
          input.fencingToken,
        ],
      )
      await client.query(
        `UPDATE persistent_codex.capacity_reservations
         SET state='released',updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND queue_item_id=$4 AND fencing_token=$5 AND state IN ('held','bound')`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          current.queue_item_id,
          input.fencingToken,
        ],
      )
      return true
    })
  }

  async recoverExpired(now = new Date()): Promise<number> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.scheduler_system','1',true)`)
      const result = await client.query(
        `WITH expired AS (
           UPDATE persistent_codex.workspace_leases
           SET state='expired',renewed_at=$1
           WHERE state='active' AND expires_at <= $1
           RETURNING tenant_id,organization_id,workspace_id,queue_item_id,fencing_token
         )
         UPDATE persistent_codex.scheduler_queue q
         SET state=CASE WHEN q.attempt>=q.max_attempts THEN 'poisoned'
                        ELSE 'recovery_required' END,
             lease_owner_id=NULL,last_error_code='LEASE_EXPIRED',updated_at=$1
         FROM expired e
         WHERE q.tenant_id=e.tenant_id AND q.organization_id=e.organization_id
           AND q.workspace_id=e.workspace_id AND q.queue_item_id=e.queue_item_id
           AND q.fencing_token=e.fencing_token`,
        [now],
      )
      await client.query(
        `UPDATE persistent_codex.capacity_reservations
         SET state='expired',updated_at=$1
         WHERE state IN ('held','bound') AND expires_at <= $1`,
        [now],
      )
      await client.query('COMMIT')
      return result.rowCount ?? 0
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async rescheduleRecovery(
    input: Scope & {
      queueItemId: string
      expectedFencingToken: number
      notBefore: Date
    },
  ): Promise<boolean> {
    return this.#tx(input, async (client) => {
      const result = await client.query(
        `UPDATE persistent_codex.scheduler_queue
         SET state='queued',not_before=$1,updated_at=now()
         WHERE tenant_id=$2 AND organization_id=$3 AND workspace_id=$4
           AND queue_item_id=$5 AND fencing_token=$6
           AND state='recovery_required' AND attempt<max_attempts`,
        [
          input.notBefore,
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.queueItemId,
          input.expectedFencingToken,
        ],
      )
      return result.rowCount === 1
    })
  }

  async upsertTenantPolicy(policy: TenantSchedulingPolicy) {
    const client = await this.pool.connect()
    try {
      await client.query(`SELECT set_config('app.scheduler_system','1',false)`)
      await client.query(
        `INSERT INTO persistent_codex.tenant_scheduling_policies
          (tenant_id,organization_id,policy_version,algorithm,weight,
           tenant_concurrency,workspace_concurrency,provider_concurrency,
           provider_requests_per_minute,starvation_age_ms,retry_policy,effective_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (tenant_id,organization_id)
         DO UPDATE SET policy_version=EXCLUDED.policy_version,
           algorithm=EXCLUDED.algorithm,weight=EXCLUDED.weight,
           tenant_concurrency=EXCLUDED.tenant_concurrency,
           workspace_concurrency=EXCLUDED.workspace_concurrency,
           provider_concurrency=EXCLUDED.provider_concurrency,
           provider_requests_per_minute=EXCLUDED.provider_requests_per_minute,
           starvation_age_ms=EXCLUDED.starvation_age_ms,
           retry_policy=EXCLUDED.retry_policy,effective_at=EXCLUDED.effective_at
         WHERE persistent_codex.tenant_scheduling_policies.policy_version <= EXCLUDED.policy_version`,
        [
          policy.tenantId,
          policy.organizationId,
          policy.policyVersion,
          policy.algorithm,
          policy.weight,
          policy.tenantConcurrency,
          policy.workspaceConcurrency,
          JSON.stringify(policy.providerConcurrency),
          JSON.stringify(policy.providerRequestsPerMinute),
          policy.starvationAgeMs,
          JSON.stringify(policy.retry),
          policy.effectiveAt,
        ],
      )
    } finally {
      client.release()
    }
  }

  async close() {
    if (this.ownsPool) await this.pool.end()
  }
}

export function createPostgresTopologyRepository(connectionString: string) {
  if (!/^postgres(?:ql)?:\/\//.test(connectionString))
    throw new Error(
      'Topology repository requires a PostgreSQL connection string',
    )
  return new PostgresTopologyRepository(new Pool({ connectionString }), {
    ownsPool: true,
  })
}

export const parseCapacityReservation = (row: Row) =>
  capacityReservationSchema.parse({
    schemaVersion: 1,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    reservationId: row.reservation_id,
    queueItemId: row.queue_item_id,
    regionId: row.region_id,
    nodeId: row.node_id,
    runtimeId: row.runtime_id ?? null,
    state: row.state,
    capacity: json<CapacityVector>(row.capacity),
    fencingToken: Number(row.fencing_token),
    expiresAt: iso(row.expires_at),
    updatedAt: iso(row.updated_at),
  })
