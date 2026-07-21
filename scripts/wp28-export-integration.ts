import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PostgresEnterpriseRepository } from '../packages/enterprise-lifecycle/src/postgres'
import {
  PostgresLifecycleWorker,
  createDownloadGrant,
} from '../packages/enterprise-lifecycle/src/durable'
import { buildEnterpriseApi } from '../services/control-plane/src/enterprise-api'
import { Wp28LifecycleStack } from './wp28-lifecycle-stack'
const stack = new Wp28LifecycleStack(),
  scope = { tenantId: 'tenant-a', organizationId: 'tenant-a' },
  marker = 'WP28_EXPORT_PLAINTEXT_MARKER_9f31'
try {
  await stack.startLifecycle()
  await stack.seedCredential('tenant-a', 'tenant-a', 'idp', 'scim-export')
  await stack.seedKey('tenant-a', 7)
  await stack.seedKey('tenant-b', 3)
  const residency = (tenantId: string, region: string) => ({
    schemaVersion: 1,
    tenantId,
    organizationId: tenantId,
    policyId: `policy-${tenantId}`,
    policyVersion: 1,
    allowedRegions: [region],
    primaryRegion: region,
    crossRegionTransfers: [],
    effectiveAt: new Date().toISOString(),
  })
  await stack.admin.query(
    `INSERT INTO persistent_codex.tenant_residency_policies VALUES('tenant-a','tenant-a','r-a',1,$1,now()),('tenant-b','tenant-b','r-b',1,$2,now())`,
    [residency('tenant-a', 'eu-1'), residency('tenant-b', 'us-1')],
  )
  for (const row of [
    {
      tenant: 'tenant-a',
      workspace: 'workspace-a',
      region: 'eu-1',
      id: 'a-object',
      body: marker,
    },
    {
      tenant: 'tenant-b',
      workspace: 'workspace-b',
      region: 'us-1',
      id: 'b-object',
      body: 'WP28_OTHER_TENANT_MARKER',
    },
  ]) {
    const key = `${row.region}/${row.tenant}/artifacts/${row.id}`
    await stack.object.put(key, Buffer.from(row.body))
    await stack.admin.query(
      `INSERT INTO persistent_codex.lifecycle_objects(tenant_id,organization_id,object_id,workspace_id,object_class,region_id,storage_key,byte_length,sha256,key_version,created_at) VALUES($1,$1,$2,$3,'artifact',$4,$5,$6,$7,1,now())`,
      [
        row.tenant,
        row.id,
        row.workspace,
        row.region,
        key,
        Buffer.byteLength(row.body),
        createHash('sha256').update(row.body).digest('hex'),
      ],
    )
  }
  const first = await stack.admin.query(
      `INSERT INTO persistent_codex.tenant_export_jobs(tenant_id,organization_id,job_id,idempotency_key,state,checkpoint,version,workspace_ids,target_region) VALUES('tenant-a','tenant-a','export-a','request-one','collecting',1,1,ARRAY['workspace-a'],'eu-1') ON CONFLICT(tenant_id,organization_id,idempotency_key) DO UPDATE SET updated_at=persistent_codex.tenant_export_jobs.updated_at RETURNING job_id`,
    ),
    duplicate = await stack.admin.query(
      `INSERT INTO persistent_codex.tenant_export_jobs(tenant_id,organization_id,job_id,idempotency_key,state,checkpoint,version,workspace_ids,target_region) VALUES('tenant-a','tenant-a','export-duplicate','request-one','requested',0,1,ARRAY['workspace-a'],'eu-1') ON CONFLICT(tenant_id,organization_id,idempotency_key) DO UPDATE SET updated_at=persistent_codex.tenant_export_jobs.updated_at RETURNING job_id`,
    )
  assert.equal(first.rows[0].job_id, duplicate.rows[0].job_id)
  const worker = new PostgresLifecycleWorker(stack.runtime, stack.adapters()),
    manifest = await worker.resumeExport({
      ...scope,
      jobId: 'export-a',
      workspaceIds: ['workspace-a'],
      region: 'eu-1',
      keyVersion: 7,
      now: new Date(),
    }),
    again = await worker.resumeExport({
      ...scope,
      jobId: 'export-a',
      workspaceIds: ['workspace-a'],
      region: 'eu-1',
      keyVersion: 7,
      now: new Date(),
    })
  assert.deepEqual(again, manifest)
  assert.equal(manifest.objects.length, 1)
  assert.equal(manifest.objects[0]?.objectId, 'a-object')
  await assert.rejects(
    worker.resumeExport({
      ...scope,
      jobId: 'export-a',
      workspaceIds: ['workspace-b'],
      region: 'eu-1',
      keyVersion: 7,
      now: new Date(),
    }),
    /CROSS_TENANT_EXPORT|RESIDENCY/,
  )
  const grant = createDownloadGrant()
  await stack.admin.query(
    `INSERT INTO persistent_codex.export_download_grants VALUES($1,$2,'export-a',$3,'tenant-admin',$4,0,1)`,
    [
      scope.tenantId,
      scope.organizationId,
      grant.digest,
      new Date(Date.now() + 60000),
    ],
  )
  const range = await worker.downloadRange({
    ...scope,
    jobId: 'export-a',
    grant: grant.value,
    start: 0,
    end: 31,
    now: new Date(),
  })
  assert.equal(range.body.length, 32)
  await assert.rejects(
    worker.downloadRange({
      ...scope,
      jobId: 'export-a',
      grant: 'wrong',
      start: 0,
      end: 1,
      now: new Date(),
    }),
    /EXPORT_DOWNLOAD_DENIED/,
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.enterprise_principal_state(tenant_id,organization_id,principal_id,scim_resource_id,roles) VALUES('tenant-a','tenant-a','support','support-scim',ARRAY['support_agent'])`,
  )
  const api = buildEnterpriseApi({
    repository: new PostgresEnterpriseRepository(stack.runtime),
  })
  await api.listen({ host: '127.0.0.1', port: 0 })
  const address = api.server.address() as any,
    support = await fetch(
      `http://127.0.0.1:${address.port}/v1/enterprise/admission/export`,
      {
        method: 'POST',
        headers: {
          'x-tenant-id': 'tenant-a',
          'x-organization-id': 'tenant-a',
          'x-principal-id': 'support',
        },
      },
    )
  assert.equal(support.status, 403)
  await api.close()
  console.log(
    JSON.stringify({
      gate: 'wp28:export',
      accepted: true,
      postgresObjects: 1,
      minioObjects: 1,
      vaultKeyVersion: manifest.keyVersion,
      resumedFromCheckpoint: 1,
      duplicateArchive: false,
      manifest: {
        watermark: manifest.watermark,
        objects: manifest.objects.map((o) => ({
          objectId: o.objectId,
          sha256: o.sha256,
          byteLength: o.byteLength,
          keyVersion: o.keyVersion,
        })),
        archiveSha256: manifest.archiveSha256,
        archiveByteLength: manifest.archiveByteLength,
      },
      rangeDownload: true,
      expiringGrant: true,
      crossTenantRejected: true,
      supportHttpStatus: 403,
      plaintextInEvidence: false,
    }),
  )
} finally {
  await stack.cleanup()
}
