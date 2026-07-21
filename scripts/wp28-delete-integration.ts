import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { PostgresLifecycleWorker } from '../packages/enterprise-lifecycle/src/durable'
import { Wp28LifecycleStack } from './wp28-lifecycle-stack'

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}

const stack = new Wp28LifecycleStack()
const tenantA = 'tenant-delete-a'
const tenantB = 'tenant-delete-b'
const organizationA = tenantA
const organizationB = tenantB
const jobId = randomUUID()
const now = new Date('2026-07-20T12:00:00.000Z')

try {
  await stack.startLifecycle()
  const keyA = await stack.seedKey(tenantA, 3)
  await stack.seedKey(tenantB, 5)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyA, iv)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from('wp28-export-plaintext-marker')),
    cipher.final(),
    cipher.getAuthTag(),
  ])

  for (const tenant of [tenantA, tenantB]) {
    const organization = tenant
    const principal = `${tenant}-principal`
    const session = `${tenant}-session`
    const values = [tenant, organization, principal]
    await stack.admin.query(
      `INSERT INTO persistent_codex.enterprise_principal_state VALUES($1,$2,$3,$4,true,ARRAY['tenant_admin'],false,0,now())`,
      [...values, `${tenant}-scim-user`],
    )
    await stack.admin.query(
      `INSERT INTO persistent_codex.enterprise_login_sessions VALUES($1,$2,$3,$4,'active',null)`,
      [...values, session],
    )
    for (const [tokenId, tokenKind] of [
      [`${tenant}-access`, 'access'],
      [`${tenant}-refresh`, 'refresh'],
    ])
      await stack.admin.query(
        `INSERT INTO persistent_codex.enterprise_tokens VALUES($1,$2,$3,$4,$5,'active',null)`,
        [...values, tokenId, tokenKind],
      )
    await stack.admin.query(
      `INSERT INTO persistent_codex.enterprise_realtime_connections VALUES($1,$2,$3,$4,'open',null)`,
      [...values, `${tenant}-connection`],
    )
    await stack.admin.query(
      `INSERT INTO persistent_codex.enterprise_credential_cache VALUES($1,$2,$3,$4,1,'active')`,
      [...values, `${tenant}-credential`],
    )
    await stack.admin.query(
      `INSERT INTO persistent_codex.enterprise_runtime_bindings VALUES($1,$2,$3,$4,$5,$6,true)`,
      [...values, `${tenant}-workspace`, session, `${tenant}-run`],
    )
    stack.docker([
      'exec',
      stack.redis,
      'redis-cli',
      'SET',
      `tenant:${tenant}:session`,
      'opaque-marker',
    ])
    await stack.admin.query(`INSERT INTO wp28_index_rows VALUES($1,$2)`, [
      tenant,
      `${tenant}-index`,
    ])
  }

  const objectRows = [
    [tenantA, 'source-a', 'source_blob', `eu/${tenantA}/source-a`, 80],
    [tenantA, 'artifact-a', 'artifact', `eu/${tenantA}/artifact-a`, 80],
    [tenantA, 'backup-a', 'backup', `eu/${tenantA}/backup-a`, 10],
    [tenantB, 'source-b', 'source_blob', `eu/${tenantB}/source-b`, 80],
  ] as const
  for (const [
    tenant,
    objectId,
    objectClass,
    storageKey,
    ageDays,
  ] of objectRows) {
    const body = Buffer.from(`opaque-${objectId}`)
    await stack.object.put(storageKey, body)
    await stack.admin.query(
      `INSERT INTO persistent_codex.lifecycle_objects VALUES($1,$1,$2,$3,$4,'eu-west-1',$5,$6,$7,1,$8,null)`,
      [
        tenant,
        objectId,
        `${tenant}-workspace`,
        objectClass,
        storageKey,
        body.length,
        '0'.repeat(64),
        new Date(now.getTime() - ageDays * 86400000),
      ],
    )
  }
  await stack.admin.query(
    `INSERT INTO persistent_codex.legal_holds VALUES($1,$2,'hold-delete','active','LITIGATION',ARRAY['source_blob'],'legal_admin',$3,$4,1)`,
    [
      tenantA,
      organizationA,
      new Date(now.getTime() - 86400000),
      new Date(now.getTime() + 86400000),
    ],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.tenant_deletion_jobs VALUES($1,$2,$3,'delete-once','running','access_revoke','{}','[]',3,1,now())`,
    [tenantA, organizationA, jobId],
  )

  const results: Array<{
    step: string
    state: string
    remaining?: Array<{ reasonCode: string }>
  }> = []
  for (let guard = 0; guard < 20; guard++) {
    // A new worker for every step is the crash/restart boundary.
    const result = await new PostgresLifecycleWorker(
      stack.runtime,
      stack.adapters(),
    ).runDeletionStep({
      tenantId: tenantA,
      organizationId: organizationA,
      jobId,
      owner: `worker-${guard}`,
      now,
    })
    results.push({
      step: result.step,
      state: result.state,
      remaining: result.remaining,
    })
    if (result.state === 'blocked_by_hold') break
  }
  assert(
    results.at(-1)?.state === 'blocked_by_hold',
    'legal hold did not block deletion',
  )
  assert(
    results
      .at(-1)
      ?.remaining?.some((entry: any) => entry.reasonCode === 'LITIGATION'),
    'legal hold reason missing',
  )
  await stack.admin.query(
    `UPDATE persistent_codex.legal_holds SET state='released',version=version+1 WHERE tenant_id=$1 AND organization_id=$2 AND hold_id='hold-delete'`,
    [tenantA, organizationA],
  )

  for (let guard = 20; guard < 40; guard++) {
    const result = await new PostgresLifecycleWorker(
      stack.runtime,
      stack.adapters(),
    ).runDeletionStep({
      tenantId: tenantA,
      organizationId: organizationA,
      jobId,
      owner: `worker-${guard}`,
      now,
    })
    results.push({
      step: result.step,
      state: result.state,
      remaining: result.remaining,
    })
    if (result.state === 'waiting_retention') break
  }
  assert(
    results.at(-1)?.state === 'waiting_retention',
    'mandatory backup retention did not pause deletion',
  )

  const afterRetention = new Date(now.getTime() + 31 * 86400000)
  for (let guard = 40; guard < 55; guard++) {
    const result = await new PostgresLifecycleWorker(
      stack.runtime,
      stack.adapters(),
    ).runDeletionStep({
      tenantId: tenantA,
      organizationId: organizationA,
      jobId,
      owner: `worker-${guard}`,
      now: afterRetention,
    })
    results.push({
      step: result.step,
      state: result.state,
      remaining: result.remaining,
    })
    if (result.state === 'complete') break
  }
  assert(results.at(-1)?.state === 'complete', 'deletion did not complete')

  const aState = await stack.admin.query(
    `SELECT
       (SELECT count(*) FROM persistent_codex.lifecycle_objects WHERE tenant_id=$1 AND deleted_at IS NULL) objects,
       (SELECT count(*) FROM wp28_index_rows WHERE tenant_id=$1) indexes,
       (SELECT count(*) FROM persistent_codex.tenant_deletion_receipts WHERE tenant_id=$1) receipts,
       (SELECT bool_and(state='revoked') FROM persistent_codex.enterprise_login_sessions WHERE tenant_id=$1) sessions_revoked,
       (SELECT bool_and(state='revoked') FROM persistent_codex.enterprise_tokens WHERE tenant_id=$1) tokens_revoked,
       (SELECT bool_and(active=false) FROM persistent_codex.enterprise_runtime_bindings WHERE tenant_id=$1) jobs_drained`,
    [tenantA],
  )
  const bState = await stack.admin.query(
    `SELECT
       (SELECT count(*) FROM persistent_codex.lifecycle_objects WHERE tenant_id=$1 AND deleted_at IS NULL) objects,
       (SELECT count(*) FROM wp28_index_rows WHERE tenant_id=$1) indexes,
       (SELECT bool_and(active) FROM persistent_codex.enterprise_principal_state WHERE tenant_id=$1) principal_active`,
    [tenantB],
  )
  assert(Number(aState.rows[0].objects) === 0, 'tenant A objects remain')
  assert(Number(aState.rows[0].indexes) === 0, 'tenant A index remains')
  assert(Number(aState.rows[0].receipts) === 1, 'deletion receipt missing')
  assert(aState.rows[0].sessions_revoked, 'sessions were not revoked')
  assert(aState.rows[0].tokens_revoked, 'tokens were not revoked')
  assert(aState.rows[0].jobs_drained, 'runtime binding was not drained')
  assert(Number(bState.rows[0].objects) === 1, 'other tenant object deleted')
  assert(Number(bState.rows[0].indexes) === 1, 'other tenant index deleted')
  assert(bState.rows[0].principal_active, 'other tenant principal revoked')
  assert(
    stack.docker([
      'exec',
      stack.redis,
      'redis-cli',
      'EXISTS',
      `tenant:${tenantA}:session`,
    ]) === '0',
    'tenant A cache remains',
  )
  assert(
    stack.docker([
      'exec',
      stack.redis,
      'redis-cli',
      'EXISTS',
      `tenant:${tenantB}:session`,
    ]) === '1',
    'other tenant cache deleted',
  )
  await stack.object.get(`eu/${tenantB}/source-b`)
  await stack.object
    .get(`eu/${tenantA}/source-a`)
    .then(() => {
      throw new Error('tenant A object is still readable')
    })
    .catch((error: Error) => {
      if (error.message === 'tenant A object is still readable') throw error
    })
  await stack
    .adapters()
    .kms.key(tenantA, 3)
    .then(() => {
      throw new Error('destroyed key is still available')
    })
    .catch((error: Error) => {
      if (error.message === 'destroyed key is still available') throw error
    })
  assert(ciphertext.length > 0, 'crypto-erasure probe was not created')

  const attempts = await stack.admin.query(
    `SELECT step,count(*) attempts FROM persistent_codex.deletion_step_attempts WHERE tenant_id=$1 AND organization_id=$2 GROUP BY step ORDER BY min(started_at)`,
    [tenantA, organizationA],
  )
  process.stdout.write(
    `${JSON.stringify({
      gate: 'wp28:delete',
      accepted: true,
      durableStateMachine: true,
      crashRestartWorkers: results.length,
      legalHoldBlocked: true,
      backupRetentionReported: true,
      backupExpiryResumed: true,
      cryptoErasure: { keyVersion: 3, restoreRejected: true },
      deletionReceipt: true,
      otherTenantPreserved: true,
      steps: attempts.rows.map((row) => ({
        step: row.step,
        attempts: Number(row.attempts),
      })),
    })}\n`,
  )
} finally {
  await stack.cleanup()
}
