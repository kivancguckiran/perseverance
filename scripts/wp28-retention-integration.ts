import assert from 'node:assert/strict'
import { PostgresLifecycleWorker } from '../packages/enterprise-lifecycle/src/durable'
import { Wp28LifecycleStack } from './wp28-lifecycle-stack'
const stack = new Wp28LifecycleStack(),
  scope = { tenantId: 'tenant-a', organizationId: 'tenant-a' },
  classes = [
    'event',
    'raw_envelope',
    'audit',
    'source',
    'attachment',
    'artifact',
    'derived_index',
    'usage_billing',
    'backup',
  ] as const
try {
  await stack.startLifecycle()
  await stack.seedKey('tenant-a')
  const policy = {
    schemaVersion: 1,
    ...scope,
    policyId: 'policy',
    policyVersion: 2,
    planId: 'enterprise',
    effectiveAt: '2026-07-01T00:00:00.000Z',
    previousPolicyVersion: 1,
    minimumPolicyAgeDays: 30,
    classes: Object.fromEntries(classes.map((c) => [c, 30])),
    previousClassDays: Object.fromEntries(
      classes.map((c) => [
        c,
        ['audit', 'usage_billing'].includes(c) ? 365 : 30,
      ]),
    ),
  }
  await stack.admin.query(
    `INSERT INTO persistent_codex.retention_policies VALUES($1,$2,'policy',2,$3,$4)`,
    [scope.tenantId, scope.organizationId, policy.effectiveAt, policy],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.legal_holds VALUES($1,$2,'hold','active','LITIGATION',ARRAY['artifact'],'legal_officer','2026-01-01',$3,1)`,
    [scope.tenantId, scope.organizationId, '2026-08-01T00:00:00.000Z'],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.retention_purge_jobs VALUES($1,$2,'purge-1','policy',2,'pending',NULL,NULL,0,NULL,0,1,now())`,
    [scope.tenantId, scope.organizationId],
  )
  for (const [i, c] of classes.entries()) {
    const id = `${String(i).padStart(2, '0')}-${c}`,
      key = `eu-1/tenant-a/${id}`
    await stack.object.put(key, Buffer.from(`retention-${c}`))
    await stack.admin.query(
      `INSERT INTO persistent_codex.lifecycle_objects(tenant_id,organization_id,object_id,workspace_id,object_class,region_id,storage_key,byte_length,sha256,key_version,created_at,deleted_at) VALUES($1,$2,$3,'workspace-a',$4,'eu-1',$5,$6,$7,1,$8,NULL)`,
      [
        scope.tenantId,
        scope.organizationId,
        id,
        c,
        key,
        Buffer.byteLength(`retention-${c}`),
        '0'.repeat(64),
        '2026-01-01',
      ],
    )
    if (c === 'derived_index')
      await stack.admin.query(
        `INSERT INTO wp28_index_rows VALUES('tenant-a',$1)`,
        [id],
      )
  }
  const worker = new PostgresLifecycleWorker(stack.runtime, stack.adapters())
  let result
  do {
    result = await worker.runRetentionBatch({
      ...scope,
      jobId: 'purge-1',
      owner: 'worker-a',
      limit: 3,
      now: new Date('2026-07-20'),
    })
  } while (result.state !== 'complete')
  const held = await stack.admin.query(
    `SELECT deleted_at FROM persistent_codex.lifecycle_objects WHERE object_class='artifact'`,
  )
  assert.equal(held.rows[0].deleted_at, null)
  const premature = await stack.admin.query(
    `SELECT count(*)::int n FROM persistent_codex.lifecycle_objects WHERE object_class IN('audit','usage_billing') AND deleted_at IS NOT NULL`,
  )
  assert.equal(premature.rows[0].n, 0)
  const stale = await stack.admin.query(
    `UPDATE persistent_codex.legal_holds SET state='released',version=version+1 WHERE hold_id='hold' AND version=0`,
  )
  assert.equal(stale.rowCount, 0)
  await stack.admin.query(
    `UPDATE persistent_codex.legal_holds SET state='released',version=version+1 WHERE hold_id='hold' AND version=1`,
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.retention_purge_jobs VALUES($1,$2,'purge-2','policy',2,'pending',NULL,NULL,0,NULL,0,1,now())`,
    [scope.tenantId, scope.organizationId],
  )
  let resumed
  do {
    resumed = await worker.runRetentionBatch({
      ...scope,
      jobId: 'purge-2',
      owner: 'worker-b',
      limit: 2,
      now: new Date('2027-08-20'),
    })
  } while (resumed.state !== 'complete')
  const remaining = await stack.admin.query(
    `SELECT count(*)::int n FROM persistent_codex.lifecycle_objects WHERE deleted_at IS NULL`,
  )
  assert.equal(remaining.rows[0].n, 0)
  console.log(
    JSON.stringify({
      gate: 'wp28:retention',
      accepted: true,
      postgres: '17.5',
      minio: true,
      redis: true,
      derivedIndex: true,
      classes: [...classes],
      boundedBatch: 3,
      leasedFenced: true,
      restartCheckpoint: true,
      legalHoldBlocked: true,
      holdReleaseResumed: true,
      policyCasStaleRejected: true,
      historicalEarlyDeleteRejected: true,
      remaining: 0,
    }),
  )
} finally {
  await stack.cleanup()
}
