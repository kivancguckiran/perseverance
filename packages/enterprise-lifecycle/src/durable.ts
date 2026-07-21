import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import {
  assertResidency,
  authorizeTransfer,
  buildEncryptedExport,
  retentionDecision,
} from './index'
import { EnterpriseBoundaryError } from './identity'
import type {
  ExportManifest,
  LegalHold,
  ResidencyPolicy,
  RetentionClass,
} from './contracts'

export type LifecycleScope = { tenantId: string; organizationId: string }
export interface LifecycleAdapters {
  object: {
    put(key: string, body: Uint8Array): Promise<void>
    get(key: string): Promise<Uint8Array>
    delete(key: string): Promise<void>
  }
  cache: { purgeTenant(tenantId: string): Promise<void> }
  index: {
    purgeTenant(tenantId: string): Promise<void>
    delete(objectId: string): Promise<void>
  }
  kms: {
    key(tenantId: string, keyVersion: number): Promise<Buffer>
    destroy(tenantId: string, keyVersion: number): Promise<void>
  }
}
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v))
export class PostgresLifecycleWorker {
  readonly pool: Pool
  readonly adapters: LifecycleAdapters
  constructor(pool: Pool, adapters: LifecycleAdapters) {
    this.pool = pool
    this.adapters = adapters
  }
  async #tx<T>(scope: LifecycleScope, fn: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.tenant_id',$1,true),set_config('app.organization_id',$2,true)`,
        [scope.tenantId, scope.organizationId],
      )
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  async runRetentionBatch(
    input: LifecycleScope & {
      jobId: string
      owner: string
      limit: number
      now: Date
    },
  ) {
    return this.#tx(input, async (client) => {
      const job = (
        await client.query(
          `UPDATE persistent_codex.retention_purge_jobs SET lease_owner=$4,fencing_token=fencing_token+1,lease_expires_at=$5,updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND job_id=$3 AND (lease_expires_at IS NULL OR lease_expires_at<$6 OR lease_owner=$4) RETURNING *`,
          [
            input.tenantId,
            input.organizationId,
            input.jobId,
            input.owner,
            new Date(input.now.getTime() + 30000),
            input.now,
          ],
        )
      ).rows[0]
      if (!job) throw new EnterpriseBoundaryError('RETENTION_LEASE_HELD')
      const policy = (
        await client.query(
          `SELECT policy,effective_at FROM persistent_codex.retention_policies WHERE tenant_id=$1 AND organization_id=$2 AND policy_id=$3 AND policy_version=$4`,
          [
            input.tenantId,
            input.organizationId,
            job.policy_id,
            job.policy_version,
          ],
        )
      ).rows[0]
      if (!policy) throw new EnterpriseBoundaryError('RETENTION_POLICY_MISSING')
      const holds = (
        await client.query(
          `SELECT * FROM persistent_codex.legal_holds WHERE tenant_id=$1 AND organization_id=$2 AND state='active' AND expires_at>$3`,
          [input.tenantId, input.organizationId, input.now],
        )
      ).rows.map((row: any): LegalHold => ({
        schemaVersion: 1,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        holdId: row.hold_id,
        objectClasses: row.object_classes,
        reasonCode: row.reason_code,
        actorRole: row.actor_role,
        state: row.state,
        startsAt: iso(row.starts_at),
        expiresAt: iso(row.expires_at),
        version: Number(row.version),
      }))
      const rows = (
        await client.query(
          `SELECT * FROM persistent_codex.lifecycle_objects WHERE tenant_id=$1 AND organization_id=$2 AND deleted_at IS NULL AND object_id>$3 ORDER BY object_id LIMIT $4`,
          [
            input.tenantId,
            input.organizationId,
            job.checkpoint ?? '',
            input.limit,
          ],
        )
      ).rows
      let deleted = 0,
        held = 0
      for (const row of rows) {
        const objectClass = row.object_class as RetentionClass,
          days = Number(policy.policy.classes[objectClass]),
          decision = retentionDecision({
            objectClass,
            createdAt: new Date(row.created_at),
            now: input.now,
            policyDays: days,
            previousPolicyDays: Number(
              policy.policy.previousClassDays?.[objectClass] ?? days,
            ),
            policyEffectiveAt: new Date(policy.effective_at),
            holds,
            statutoryMinimumDays: ['audit', 'usage_billing'].includes(
              objectClass,
            )
              ? 400
              : 0,
          })
        if (decision.delete) {
          if (row.storage_key)
            await this.adapters.object.delete(row.storage_key)
          if (objectClass === 'derived_index')
            await this.adapters.index.delete(row.object_id)
          await client.query(
            `UPDATE persistent_codex.lifecycle_objects SET deleted_at=$4 WHERE tenant_id=$1 AND organization_id=$2 AND object_id=$3 AND deleted_at IS NULL`,
            [input.tenantId, input.organizationId, row.object_id, input.now],
          )
          deleted++
        } else if (decision.reason === 'LEGAL_HOLD') held++
      }
      const checkpoint = rows.at(-1)?.object_id ?? job.checkpoint
      await client.query(
        `UPDATE persistent_codex.retention_purge_jobs SET checkpoint=$4,processed_count=processed_count+$5,state=$6,version=version+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND job_id=$3 AND fencing_token=$7`,
        [
          input.tenantId,
          input.organizationId,
          input.jobId,
          checkpoint,
          rows.length,
          rows.length < input.limit ? 'complete' : 'running',
          job.fencing_token,
        ],
      )
      return {
        fencingToken: Number(job.fencing_token),
        processed: rows.length,
        deleted,
        held,
        checkpoint,
        state: rows.length < input.limit ? 'complete' : 'running',
      }
    })
  }
  async resumeExport(
    input: LifecycleScope & {
      jobId: string
      workspaceIds: string[]
      region: string
      keyVersion: number
      now: Date
    },
  ) {
    return this.#tx(input, async (client) => {
      const policyRow = (
        await client.query(
          `SELECT policy FROM persistent_codex.tenant_residency_policies WHERE tenant_id=$1 AND organization_id=$2 ORDER BY policy_version DESC LIMIT 1`,
          [input.tenantId, input.organizationId],
        )
      ).rows[0]
      if (!policyRow)
        throw new EnterpriseBoundaryError('RESIDENCY_POLICY_MISSING')
      const policy = policyRow.policy as ResidencyPolicy
      if (!policy.allowedRegions.includes(input.region))
        throw new EnterpriseBoundaryError('RESIDENCY_EXPORT_DENIED')
      const job = (
        await client.query(
          `SELECT * FROM persistent_codex.tenant_export_jobs WHERE tenant_id=$1 AND organization_id=$2 AND job_id=$3 FOR UPDATE`,
          [input.tenantId, input.organizationId, input.jobId],
        )
      ).rows[0]
      if (
        !job ||
        JSON.stringify([...job.workspace_ids].sort()) !==
          JSON.stringify([...input.workspaceIds].sort()) ||
        job.target_region !== input.region
      )
        throw new EnterpriseBoundaryError('CROSS_TENANT_EXPORT')
      if (job?.state === 'ready') return job.manifest as ExportManifest
      const rows = (
          await client.query(
            `SELECT * FROM persistent_codex.lifecycle_objects WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=ANY($3) AND deleted_at IS NULL ORDER BY object_id`,
            [input.tenantId, input.organizationId, input.workspaceIds],
          )
        ).rows,
        objects = [] as Array<{
          tenantId: string
          objectId: string
          objectClass: RetentionClass
          body: Buffer
          keyVersion: number
        }>
      for (const row of rows) {
        if (row.region_id !== input.region)
          throw new EnterpriseBoundaryError('RESIDENCY_EXPORT_DENIED')
        const body = row.storage_key
          ? Buffer.from(await this.adapters.object.get(row.storage_key))
          : Buffer.from(
              JSON.stringify({
                objectId: row.object_id,
                objectClass: row.object_class,
              }),
            )
        objects.push({
          tenantId: input.tenantId,
          objectId: row.object_id,
          objectClass: row.object_class,
          body,
          keyVersion: Number(row.key_version),
        })
      }
      if (
        new Set(rows.map((row: any) => row.workspace_id)).size !==
        new Set(input.workspaceIds).size
      )
        throw new EnterpriseBoundaryError('CROSS_TENANT_EXPORT')
      const key = await this.adapters.kms.key(input.tenantId, input.keyVersion),
        result = buildEncryptedExport({
          ...input,
          watermark: `${rows.length}:${rows.at(-1)?.object_id ?? 'empty'}`,
          objects,
          key,
          createdAt: input.now,
        }),
        archiveKey = `${input.region}/${input.tenantId}/exports/${input.jobId}.enc`
      await this.adapters.object.put(archiveKey, result.archive)
      await client.query(
        `UPDATE persistent_codex.tenant_export_jobs SET state='ready',checkpoint=$4,manifest=$5,encrypted_object_key=$6,version=version+1,updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND job_id=$3`,
        [
          input.tenantId,
          input.organizationId,
          input.jobId,
          rows.length,
          result.manifest,
          archiveKey,
        ],
      )
      return result.manifest
    })
  }
  async downloadRange(
    input: LifecycleScope & {
      jobId: string
      grant: string
      start: number
      end: number
      now: Date
    },
  ) {
    return this.#tx(input, async (client) => {
      const digest = createHash('sha256').update(input.grant).digest('hex'),
        grant = (
          await client.query(
            `SELECT * FROM persistent_codex.export_download_grants WHERE tenant_id=$1 AND organization_id=$2 AND job_id=$3 AND grant_digest=$4 AND expires_at>$5 FOR UPDATE`,
            [
              input.tenantId,
              input.organizationId,
              input.jobId,
              digest,
              input.now,
            ],
          )
        ).rows[0]
      if (!grant) throw new EnterpriseBoundaryError('EXPORT_DOWNLOAD_DENIED')
      const job = (
        await client.query(
          `SELECT encrypted_object_key FROM persistent_codex.tenant_export_jobs WHERE tenant_id=$1 AND organization_id=$2 AND job_id=$3 AND state='ready'`,
          [input.tenantId, input.organizationId, input.jobId],
        )
      ).rows[0]
      if (!job) throw new EnterpriseBoundaryError('EXPORT_NOT_READY')
      const archive = Buffer.from(
          await this.adapters.object.get(job.encrypted_object_key),
        ),
        end = Math.min(input.end, archive.length - 1)
      await client.query(
        `UPDATE persistent_codex.export_download_grants SET consumed_bytes=consumed_bytes+$5,version=version+1 WHERE tenant_id=$1 AND organization_id=$2 AND job_id=$3 AND grant_digest=$4`,
        [
          input.tenantId,
          input.organizationId,
          input.jobId,
          digest,
          end - input.start + 1,
        ],
      )
      return {
        body: archive.subarray(input.start, end + 1),
        total: archive.length,
        start: input.start,
        end,
      }
    })
  }
  async runDeletionStep(
    input: LifecycleScope & { jobId: string; owner: string; now: Date },
  ) {
    return this.#tx(input, async (client) => {
      const job = (
        await client.query(
          `SELECT * FROM persistent_codex.tenant_deletion_jobs WHERE tenant_id=$1 AND organization_id=$2 AND job_id=$3 FOR UPDATE`,
          [input.tenantId, input.organizationId, input.jobId],
        )
      ).rows[0]
      if (!job) throw new EnterpriseBoundaryError('DELETE_JOB_MISSING')
      if (job.state === 'complete')
        return { state: 'complete', step: 'deletion_receipt' }
      const step = job.current_step as string,
        attempt = (
          await client.query(
            `SELECT COALESCE(max(attempt),0)+1 n FROM persistent_codex.deletion_step_attempts WHERE tenant_id=$1 AND organization_id=$2 AND job_id=$3 AND step=$4`,
            [input.tenantId, input.organizationId, input.jobId, step],
          )
        ).rows[0].n,
        fence = Number(job.version) + 1
      await client.query(
        `INSERT INTO persistent_codex.deletion_step_attempts VALUES($1,$2,$3,$4,$5,'running',$6,now(),null)`,
        [
          input.tenantId,
          input.organizationId,
          input.jobId,
          step,
          attempt,
          fence,
        ],
      )
      let blocked = false,
        remaining: any[] = []
      if (step === 'access_revoke')
        await client.query(
          `UPDATE persistent_codex.enterprise_principal_state SET active=false,revocation_epoch=revocation_epoch+1 WHERE tenant_id=$1 AND organization_id=$2`,
          [input.tenantId, input.organizationId],
        )
      else if (step === 'admission_cordon')
        await client.query(
          `UPDATE persistent_codex.enterprise_principal_state SET admission_cordoned=true WHERE tenant_id=$1 AND organization_id=$2`,
          [input.tenantId, input.organizationId],
        )
      else if (step === 'active_job_drain')
        await client.query(
          `UPDATE persistent_codex.enterprise_runtime_bindings SET active=false WHERE tenant_id=$1 AND organization_id=$2`,
          [input.tenantId, input.organizationId],
        )
      else if (step === 'session_token_revoke') {
        await client.query(
          `UPDATE persistent_codex.enterprise_login_sessions SET state='revoked',revoked_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND state='active'`,
          [input.tenantId, input.organizationId],
        )
        await client.query(
          `UPDATE persistent_codex.enterprise_tokens SET state='revoked',revoked_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND state='active'`,
          [input.tenantId, input.organizationId],
        )
      } else if (step === 'cache_purge')
        await this.adapters.cache.purgeTenant(input.tenantId)
      else if (step === 'index_purge')
        await this.adapters.index.purgeTenant(input.tenantId)
      else if (step === 'object_delete') {
        const hold = (
          await client.query(
            `SELECT object_classes,expires_at,reason_code FROM persistent_codex.legal_holds WHERE tenant_id=$1 AND organization_id=$2 AND state='active' AND expires_at>$3`,
            [input.tenantId, input.organizationId, input.now],
          )
        ).rows
        const objects = (
          await client.query(
            `SELECT * FROM persistent_codex.lifecycle_objects WHERE tenant_id=$1 AND organization_id=$2 AND deleted_at IS NULL`,
            [input.tenantId, input.organizationId],
          )
        ).rows
        for (const object of objects) {
          if (object.object_class === 'backup') continue
          const h = hold.find((x: any) =>
            x.object_classes.includes(object.object_class),
          )
          if (h) {
            remaining.push({
              objectClass: object.object_class,
              reasonCode: h.reason_code,
              expiresAt: iso(h.expires_at),
            })
            continue
          }
          if (object.storage_key)
            await this.adapters.object.delete(object.storage_key)
          await client.query(
            `UPDATE persistent_codex.lifecycle_objects SET deleted_at=$4 WHERE tenant_id=$1 AND organization_id=$2 AND object_id=$3`,
            [input.tenantId, input.organizationId, object.object_id, input.now],
          )
        }
        blocked = remaining.length > 0
      } else if (step === 'metadata_cleanup')
        await client.query(
          `UPDATE persistent_codex.scim_resources SET active=false WHERE tenant_id=$1 AND organization_id=$2`,
          [input.tenantId, input.organizationId],
        )
      else if (step === 'backup_expiry') {
        const backups = (
          await client.query(
            `SELECT * FROM persistent_codex.lifecycle_objects WHERE tenant_id=$1 AND organization_id=$2 AND object_class='backup' AND deleted_at IS NULL`,
            [input.tenantId, input.organizationId],
          )
        ).rows
        remaining = backups
          .map((b: any) => ({
            objectClass: 'backup',
            reasonCode: 'MANDATORY_BACKUP_RETENTION',
            expiresAt: new Date(
              new Date(b.created_at).getTime() + 30 * 86400000,
            ).toISOString(),
          }))
          .filter((r: any) => new Date(r.expiresAt) > input.now)
        for (const backup of backups) {
          const expiresAt = new Date(
            new Date(backup.created_at).getTime() + 30 * 86400000,
          )
          if (expiresAt <= input.now) {
            if (backup.storage_key)
              await this.adapters.object.delete(backup.storage_key)
            await client.query(
              `UPDATE persistent_codex.lifecycle_objects SET deleted_at=$4 WHERE tenant_id=$1 AND organization_id=$2 AND object_id=$3`,
              [
                input.tenantId,
                input.organizationId,
                backup.object_id,
                input.now,
              ],
            )
          }
        }
        blocked = remaining.length > 0
      } else if (step === 'kms_crypto_erasure')
        await this.adapters.kms.destroy(input.tenantId, Number(job.key_version))
      else if (step === 'deletion_receipt') {
        const completedSteps = [...job.completed_steps, step]
        const receiptHash = createHash('sha256')
          .update(
            JSON.stringify({
              tenantId: input.tenantId,
              organizationId: input.organizationId,
              jobId: input.jobId,
              completedSteps,
              remainingClasses: job.remaining_classes,
              keyVersion: Number(job.key_version),
              completedAt: input.now.toISOString(),
            }),
          )
          .digest('hex')
        await client.query(
          `INSERT INTO persistent_codex.tenant_deletion_receipts VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,organization_id,job_id) DO NOTHING`,
          [
            input.tenantId,
            input.organizationId,
            input.jobId,
            receiptHash,
            completedSteps,
            JSON.stringify(job.remaining_classes),
            Number(job.key_version),
            input.now,
          ],
        )
      }
      const steps = [
          'access_revoke',
          'admission_cordon',
          'active_job_drain',
          'session_token_revoke',
          'cache_purge',
          'index_purge',
          'object_delete',
          'metadata_cleanup',
          'backup_expiry',
          'kms_crypto_erasure',
          'deletion_receipt',
        ],
        next = steps[steps.indexOf(step) + 1],
        state = blocked
          ? step === 'backup_expiry'
            ? 'waiting_retention'
            : 'blocked_by_hold'
          : next
            ? 'running'
            : 'complete'
      await client.query(
        `UPDATE persistent_codex.deletion_step_attempts SET state=$5,completed_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND job_id=$3 AND step=$4 AND attempt=$6`,
        [
          input.tenantId,
          input.organizationId,
          input.jobId,
          step,
          blocked ? 'blocked' : 'complete',
          attempt,
        ],
      )
      await client.query(
        `UPDATE persistent_codex.tenant_deletion_jobs SET state=$5,current_step=$6,completed_steps=CASE WHEN $5 IN('blocked_by_hold','waiting_retention') THEN completed_steps ELSE array_append(completed_steps,$4) END,remaining_classes=$7,version=version+1,updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND job_id=$3`,
        [
          input.tenantId,
          input.organizationId,
          input.jobId,
          step,
          state,
          blocked ? step : (next ?? step),
          JSON.stringify(remaining),
        ],
      )
      return {
        state,
        step,
        next: blocked ? step : next,
        remaining,
        fencingToken: fence,
      }
    })
  }
}
export const createDownloadGrant = () => {
  const value = randomUUID() + randomUUID()
  return { value, digest: createHash('sha256').update(value).digest('hex') }
}

export class PostgresResidencyEnforcer {
  readonly pool: Pool
  readonly object: LifecycleAdapters['object']
  constructor(pool: Pool, object: LifecycleAdapters['object']) {
    this.pool = pool
    this.object = object
  }
  async #policy(scope: LifecycleScope) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.tenant_id',$1,true),set_config('app.organization_id',$2,true)`,
        [scope.tenantId, scope.organizationId],
      )
      const row = (
        await client.query(
          `SELECT policy FROM persistent_codex.tenant_residency_policies WHERE tenant_id=$1 AND organization_id=$2 ORDER BY policy_version DESC LIMIT 1`,
          [scope.tenantId, scope.organizationId],
        )
      ).rows[0]
      await client.query('COMMIT')
      if (!row) throw new EnterpriseBoundaryError('RESIDENCY_POLICY_MISSING')
      return row.policy as ResidencyPolicy
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  async placeWorkspace(scope: LifecycleScope, availableRegions: string[]) {
    const policy = await this.#policy(scope)
    const region = [policy.primaryRegion, ...policy.allowedRegions].find((r) =>
      availableRegions.includes(r),
    )
    if (!region) throw new EnterpriseBoundaryError('RESIDENCY_PLACEMENT_DENIED')
    assertResidency(policy, { region, kind: 'placement' })
    return region
  }
  async putObject(
    scope: LifecycleScope & {
      region: string
      key: string
      body: Uint8Array
      kind: 'object' | 'backup' | 'export'
    },
  ) {
    const policy = await this.#policy(scope)
    assertResidency(policy, { region: scope.region, kind: scope.kind })
    if (!scope.key.startsWith(`${scope.region}/${scope.tenantId}/`))
      throw new EnterpriseBoundaryError('RESIDENCY_OBJECT_KEY_DENIED')
    await this.object.put(scope.key, scope.body)
    return { region: scope.region, byteCount: scope.body.byteLength }
  }
  async writeIndex(
    scope: LifecycleScope & { region: string },
    write: () => Promise<void>,
  ) {
    const policy = await this.#policy(scope)
    assertResidency(policy, { region: scope.region, kind: 'index' })
    await write()
  }
  async restoreBackup(
    scope: LifecycleScope & {
      sourceKey: string
      destinationRegion: string
      destinationKey: string
    },
  ) {
    const body = await this.object.get(scope.sourceKey)
    return this.putObject({
      ...scope,
      region: scope.destinationRegion,
      key: scope.destinationKey,
      body,
      kind: 'backup',
    })
  }
  async transfer(
    scope: LifecycleScope & {
      sourceRegion: string
      destinationRegion: string
      sourceKey: string
      destinationKey: string
      objectClass: RetentionClass
      actorId: string
      reasonCode: string
      approvalId: string
    },
  ) {
    const policy = await this.#policy(scope)
    authorizeTransfer(policy, scope)
    if (
      !scope.sourceKey.startsWith(`${scope.sourceRegion}/${scope.tenantId}/`) ||
      !scope.destinationKey.startsWith(
        `${scope.destinationRegion}/${scope.tenantId}/`,
      )
    )
      throw new EnterpriseBoundaryError('RESIDENCY_OBJECT_KEY_DENIED')
    const body = await this.object.get(scope.sourceKey)
    await this.object.put(scope.destinationKey, body)
    const transferId = randomUUID()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.tenant_id',$1,true),set_config('app.organization_id',$2,true)`,
        [scope.tenantId, scope.organizationId],
      )
      await client.query(
        `INSERT INTO persistent_codex.residency_transfer_audit VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
        [
          scope.tenantId,
          scope.organizationId,
          transferId,
          scope.sourceRegion,
          scope.destinationRegion,
          scope.reasonCode,
          scope.actorId,
          scope.objectClass,
          body.byteLength,
          scope.approvalId,
        ],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      await this.object.delete(scope.destinationKey).catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    return { transferId, byteCount: body.byteLength }
  }
}
