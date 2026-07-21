import assert from 'node:assert/strict'
import {
  PostgresLifecycleWorker,
  PostgresResidencyEnforcer,
} from '../packages/enterprise-lifecycle/src/durable'
import { Wp28LifecycleStack } from './wp28-lifecycle-stack'

const stack = new Wp28LifecycleStack()
const scope = {
  tenantId: 'tenant-residency',
  organizationId: 'tenant-residency',
}
const denied: string[] = []
const expectDenied = async (name: string, action: () => Promise<unknown>) => {
  await action().then(
    () => {
      throw new Error(`${name} unexpectedly succeeded`)
    },
    () => denied.push(name),
  )
}

try {
  await stack.startLifecycle()
  await stack.seedKey(scope.tenantId, 1)
  const policy = {
    schemaVersion: 1,
    ...scope,
    policyId: 'residency-v1',
    policyVersion: 1,
    allowedRegions: ['eu-1'],
    primaryRegion: 'eu-1',
    crossRegionTransfers: [
      {
        sourceRegion: 'eu-1',
        destinationRegion: 'eu-2',
        objectClasses: ['backup'],
      },
    ],
    effectiveAt: new Date().toISOString(),
  }
  await stack.admin.query(
    `INSERT INTO persistent_codex.tenant_residency_policies VALUES($1,$2,$3,1,$4,now())`,
    [scope.tenantId, scope.organizationId, policy.policyId, policy],
  )
  const enforcer = new PostgresResidencyEnforcer(stack.runtime, stack.object)
  assert.equal(await enforcer.placeWorkspace(scope, ['eu-1']), 'eu-1')
  await expectDenied('placement', () =>
    enforcer.placeWorkspace(scope, ['us-1']),
  )

  const body = Buffer.from('opaque-residency-bytes')
  const sourceKey = `eu-1/${scope.tenantId}/backups/source.bin`
  await enforcer.putObject({
    ...scope,
    region: 'eu-1',
    key: sourceKey,
    body,
    kind: 'backup',
  })
  await expectDenied('object-write', () =>
    enforcer.putObject({
      ...scope,
      region: 'us-1',
      key: `us-1/${scope.tenantId}/objects/forbidden.bin`,
      body,
      kind: 'object',
    }),
  )
  await expectDenied('backup-target', () =>
    enforcer.putObject({
      ...scope,
      region: 'us-1',
      key: `us-1/${scope.tenantId}/backups/forbidden.bin`,
      body,
      kind: 'backup',
    }),
  )
  await expectDenied('backup-restore', () =>
    enforcer.restoreBackup({
      ...scope,
      sourceKey,
      destinationRegion: 'us-1',
      destinationKey: `us-1/${scope.tenantId}/restore/forbidden.bin`,
    }),
  )
  await expectDenied('index', () =>
    enforcer.writeIndex({ ...scope, region: 'us-1' }, async () => {
      await stack.admin.query(`INSERT INTO wp28_index_rows VALUES($1,'bad')`, [
        scope.tenantId,
      ])
    }),
  )
  await enforcer.writeIndex({ ...scope, region: 'eu-1' }, async () => {
    await stack.admin.query(`INSERT INTO wp28_index_rows VALUES($1,'good')`, [
      scope.tenantId,
    ])
  })

  await stack.admin.query(
    `INSERT INTO persistent_codex.tenant_export_jobs(tenant_id,organization_id,job_id,idempotency_key,state,version,workspace_ids,target_region) VALUES($1,$2,'forbidden-export','forbidden-export','requested',1,ARRAY['workspace-r'],'us-1')`,
    [scope.tenantId, scope.organizationId],
  )
  await expectDenied('export', () =>
    new PostgresLifecycleWorker(stack.runtime, stack.adapters()).resumeExport({
      ...scope,
      jobId: 'forbidden-export',
      workspaceIds: ['workspace-r'],
      region: 'us-1',
      keyVersion: 1,
      now: new Date(),
    }),
  )

  await expectDenied('transfer-without-approval', () =>
    enforcer.transfer({
      ...scope,
      sourceRegion: 'eu-1',
      destinationRegion: 'eu-2',
      sourceKey,
      destinationKey: `eu-2/${scope.tenantId}/backups/no-approval.bin`,
      objectClass: 'backup',
      actorId: 'tenant-admin',
      reasonCode: 'DR_APPROVED',
      approvalId: '',
    }),
  )
  const transfer = await enforcer.transfer({
    ...scope,
    sourceRegion: 'eu-1',
    destinationRegion: 'eu-2',
    sourceKey,
    destinationKey: `eu-2/${scope.tenantId}/backups/approved.bin`,
    objectClass: 'backup',
    actorId: 'tenant-admin',
    reasonCode: 'DR_APPROVED',
    approvalId: 'approval-1',
  })
  assert.equal(transfer.byteCount, body.byteLength)
  assert.deepEqual(
    Buffer.from(
      await stack.object.get(`eu-2/${scope.tenantId}/backups/approved.bin`),
    ),
    body,
  )
  const audit = await stack.admin.query(
    `SELECT source_region,destination_region,byte_count FROM persistent_codex.residency_transfer_audit WHERE tenant_id=$1`,
    [scope.tenantId],
  )
  assert.equal(audit.rowCount, 1)
  assert.equal(Number(audit.rows[0].byte_count), body.byteLength)
  assert.deepEqual(denied.sort(), [
    'backup-restore',
    'backup-target',
    'export',
    'index',
    'object-write',
    'placement',
    'transfer-without-approval',
  ])
  process.stdout.write(
    `${JSON.stringify({
      gate: 'wp28:residency',
      accepted: true,
      productionAdapters: ['scheduler', 'minio', 'postgres-index', 'export'],
      failClosedNoRegion: true,
      forbiddenPaths: denied,
      transferAudit: {
        sourceRegion: audit.rows[0].source_region,
        destinationRegion: audit.rows[0].destination_region,
        byteCount: Number(audit.rows[0].byte_count),
      },
    })}\n`,
  )
} finally {
  await stack.cleanup()
}
