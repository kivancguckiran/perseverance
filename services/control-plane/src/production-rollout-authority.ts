import { createHash } from 'node:crypto'
import {
  transitionProductionRollout,
  type ProductionRolloutRecord,
  type ProductionRolloutStage,
} from '@persistent-codex/production-readiness'
import type { Pool, PoolClient } from 'pg'
import type { ProductionScope } from '@persistent-codex/production-topology/production-postgres'

const commandSha256 = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

type StoredRow = Record<string, unknown>

export class ProductionRolloutAuthority {
  readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
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

  async create(
    input: ProductionScope & {
      rolloutId: string
      cohortId: string
      artifactSha256: string
      previousArtifactSha256: string
    },
  ) {
    return this.#tx(input, async (client) => {
      const result = await client.query(
        `INSERT INTO persistent_codex.production_rollouts
          (tenant_id,organization_id,workspace_id,rollout_id,stage,cohort_id,
           artifact_sha256,previous_artifact_sha256,feature_flag_enabled)
         VALUES ($1,$2,$3,$4,'internal',$5,$6,$7,true)
         RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.rolloutId,
          input.cohortId,
          input.artifactSha256,
          input.previousArtifactSha256,
        ],
      )
      return result.rows[0]!
    })
  }

  async transition(
    input: ProductionScope & {
      rolloutId: string
      expectedVersion: number
      idempotencyKey: string
      next: ProductionRolloutStage
      cohortId: string
      operatorHalt?: boolean
      rollbackVerified?: boolean
      budgetHealthy?: boolean
    },
  ) {
    return this.#tx(input, async (client) => {
      const stored = await client.query(
        `SELECT * FROM persistent_codex.production_rollouts
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND rollout_id=$4 FOR UPDATE`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.rolloutId,
        ],
      )
      if (!stored.rowCount) throw new Error('PRODUCTION_ROLLOUT_NOT_FOUND')
      const commands = await client.query(
        `SELECT idempotency_key,command_sha256
         FROM persistent_codex.production_rollout_commands
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND rollout_id=$4`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.rolloutId,
        ],
      )
      const row = stored.rows[0] as StoredRow
      const current: ProductionRolloutRecord = {
        contractVersion: 1,
        tenantId: String(row.tenant_id),
        organizationId: String(row.organization_id),
        workspaceId: String(row.workspace_id),
        rolloutId: String(row.rollout_id),
        stage: row.stage as ProductionRolloutStage,
        version: Number(row.version),
        cohortId: String(row.cohort_id),
        artifactSha256: String(row.artifact_sha256),
        previousArtifactSha256:
          row.previous_artifact_sha256 == null
            ? null
            : String(row.previous_artifact_sha256),
        featureFlagEnabled: Boolean(row.feature_flag_enabled),
        killSwitch: Boolean(row.kill_switch),
        idempotency: Object.fromEntries(
          commands.rows.map((value) => [
            String(value.idempotency_key),
            String(value.command_sha256),
          ]),
        ),
        historyHeadSha256:
          row.history_head_sha256 == null
            ? null
            : String(row.history_head_sha256),
      }
      const command = commandSha256({
        rolloutId: input.rolloutId,
        expectedVersion: input.expectedVersion,
        next: input.next,
        cohortId: input.cohortId,
        operatorHalt: input.operatorHalt ?? false,
        rollbackVerified: input.rollbackVerified ?? false,
        budgetHealthy: input.budgetHealthy,
      })
      const next = transitionProductionRollout(current, {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        commandSha256: command,
        next: input.next,
        cohortId: input.cohortId,
        ...(input.operatorHalt ? { operatorHalt: true } : {}),
        ...(input.rollbackVerified ? { rollbackVerified: true } : {}),
        ...(input.budgetHealthy === undefined
          ? {}
          : {
              budget: {
                healthy: input.budgetHealthy,
                breached: input.budgetHealthy ? [] : ['operator-observation'],
              },
            }),
      })
      if (next.version === current.version) return row
      await client.query(
        `INSERT INTO persistent_codex.production_rollout_commands
          (tenant_id,organization_id,workspace_id,rollout_id,idempotency_key,
           command_sha256,expected_version,resulting_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.rolloutId,
          input.idempotencyKey,
          command,
          input.expectedVersion,
          next.version,
        ],
      )
      await client.query(
        `INSERT INTO persistent_codex.production_rollout_history
          (tenant_id,organization_id,workspace_id,rollout_id,sequence,from_stage,
           to_stage,cohort_id,artifact_sha256,reason_code,
           previous_history_sha256,history_sha256,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.rolloutId,
          next.version - 1,
          current.stage,
          next.stage,
          next.cohortId,
          next.artifactSha256,
          next.stage === 'halted'
            ? 'OPERATOR_HALT'
            : next.stage === 'rolled_back'
              ? 'ROLLBACK_INTEGRITY_VERIFIED'
              : 'SUCCESS_BUDGET_MET',
          current.historyHeadSha256,
          next.historyHeadSha256,
        ],
      )
      const updated = await client.query(
        `UPDATE persistent_codex.production_rollouts
         SET stage=$5,version=$6,cohort_id=$7,artifact_sha256=$8,
             kill_switch=$9,history_head_sha256=$10,updated_at=now()
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND rollout_id=$4 AND version=$11 RETURNING *`,
        [
          input.tenantId,
          input.organizationId,
          input.workspaceId,
          input.rolloutId,
          next.stage,
          next.version,
          next.cohortId,
          next.artifactSha256,
          next.killSwitch,
          next.historyHeadSha256,
          current.version,
        ],
      )
      if (!updated.rowCount)
        throw new Error('PRODUCTION_ROLLOUT_VERSION_CONFLICT')
      return updated.rows[0]!
    })
  }
}
