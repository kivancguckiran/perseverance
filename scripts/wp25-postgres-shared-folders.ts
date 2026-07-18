import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createPostgresSharedFolderRepository } from '../packages/shared-folders/src/postgres.ts'
import { SharedFolderError } from '../packages/shared-folders/src/index.ts'

const container = `persistent-wp25-${randomUUID()}`
const volume = `${container}-data`
const image = process.env.WP25_POSTGRES_IMAGE ?? 'pgvector/pgvector:pg17'

function docker(args: string[], input?: string) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input })
  if (result.status !== 0)
    throw new Error(
      result.stderr || result.stdout || `docker ${args.join(' ')} failed`,
    )
  return result.stdout.trim()
}

const owner = {
  tenantId: 'org_a',
  organizationId: 'org_a',
  workspaceId: 'wsp_a',
  principalId: 'principal_owner',
}
const friend = { ...owner, principalId: 'principal_friend' }
const secondFriend = { ...owner, principalId: 'principal_second_friend' }

try {
  docker(['volume', 'create', volume])
  docker([
    'run',
    '-d',
    '--name',
    container,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-v',
    `${volume}:/var/lib/postgresql/data`,
    '-p',
    '127.0.0.1::5432',
    image,
  ])
  let ready = false
  let consecutiveReady = 0
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = spawnSync('docker', [
      'exec',
      container,
      'pg_isready',
      '-U',
      'postgres',
    ])
    const sqlProbe =
      probe.status === 0
        ? spawnSync(
            'docker',
            ['exec', container, 'psql', '-U', 'postgres', '-tAc', 'SELECT 1'],
            { encoding: 'utf8' },
          )
        : undefined
    consecutiveReady =
      sqlProbe?.status === 0 && sqlProbe.stdout.trim() === '1'
        ? consecutiveReady + 1
        : 0
    if (consecutiveReady >= 3) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error('PostgreSQL did not become ready')
  for (const migration of [
    '0018_oidc_authorization_rls.sql',
    '0021_tenant_corpus_ingestion.sql',
    '0022_hybrid_corpus_retrieval.sql',
    '0023_pwa_push_multi_device.sql',
    '0024_billing_plan_quota.sql',
    '0025_billing_runtime_composition.sql',
    '0026_prepaid_credit_financial_projection.sql',
    '0027_secure_shared_folders.sql',
  ])
    docker(
      [
        'exec',
        '-i',
        container,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
      ],
      readFileSync(`infra/postgres/migrations/${migration}`, 'utf8'),
    )

  docker(
    [
      'exec',
      '-i',
      container,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
    ],
    `
      CREATE ROLE folder_runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      GRANT USAGE ON SCHEMA persistent_codex TO folder_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA persistent_codex TO folder_runtime;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA persistent_codex TO folder_runtime;
      GRANT EXECUTE ON FUNCTION persistent_codex.folder_role(text,text,text,text,text) TO folder_runtime;
      GRANT EXECUTE ON FUNCTION persistent_codex.accept_folder_invitation(bytea,text,timestamptz) TO folder_runtime;
      GRANT EXECUTE ON FUNCTION persistent_codex.authorize_folder_workload_resource(text,text,text,text,text) TO folder_runtime;
      GRANT EXECUTE ON FUNCTION persistent_codex.shared_folder_scope_exists(text,text,text) TO folder_runtime;
      GRANT EXECUTE ON FUNCTION persistent_codex.shared_folder_task_for_turn(text,text,text,text) TO folder_runtime;
      INSERT INTO persistent_codex.organizations VALUES ('org_a','A','active'),('org_b','B','active');
      INSERT INTO persistent_codex.workspaces (tenant_id,organization_id,workspace_id,name)
        VALUES ('org_a','org_a','wsp_a','A'),('org_b','org_b','wsp_b','B');
    `,
  )
  const port = docker(['port', container, '5432/tcp']).split(':').at(-1)!
  const connectionString = `postgresql://folder_runtime:runtime@127.0.0.1:${port}/postgres`
  let repository = createPostgresSharedFolderRepository(connectionString)
  let pool = repository.pool

  const created = await repository.createFolder({ ...owner, name: 'Shared' })
  const privateSibling = await repository.createFolder({
    ...owner,
    name: 'Private sibling',
  })
  assert.equal((await repository.listFolders(friend)).length, 0)
  const issued = await repository.createInvitation({
    ...owner,
    folderId: created.folder.folderId,
    role: 'viewer',
    expiresInSeconds: 600,
  })
  assert(!JSON.stringify(issued.invitation).includes(issued.token))
  const accepted = await repository.acceptInvitation({
    ...friend,
    token: issued.token,
  })
  assert.equal(accepted.membership.role, 'viewer')
  assert.equal(accepted.idempotent, false)
  assert.equal(
    (await repository.acceptInvitation({ ...friend, token: issued.token }))
      .idempotent,
    true,
  )
  assert.deepEqual(
    (await repository.listFolders(friend)).map(
      (entry) => entry.folder.folderId,
    ),
    [created.folder.folderId],
  )
  assert.notEqual(created.folder.folderId, privateSibling.folder.folderId)
  assert.equal(
    (await repository.getFolder(friend, created.folder.folderId)).folderId,
    created.folder.folderId,
  )
  assert.equal(
    (await repository.listMembers(owner, created.folder.folderId)).length,
    2,
  )
  assert.equal(
    (await repository.listInvitations(owner, created.folder.folderId)).length,
    1,
  )
  await assert.rejects(
    repository.getFolder(friend, privateSibling.folder.folderId),
    (error: unknown) => error instanceof SharedFolderError,
  )

  const revokedInvite = await repository.createInvitation({
    ...owner,
    folderId: created.folder.folderId,
    role: 'viewer',
    expiresInSeconds: 600,
  })
  await repository.revokeInvitation({
    ...owner,
    folderId: created.folder.folderId,
    invitationId: revokedInvite.invitation.invitationId,
    expectedVersion: revokedInvite.invitation.version,
  })
  await assert.rejects(
    repository.acceptInvitation({
      ...secondFriend,
      token: revokedInvite.token,
    }),
    (error: unknown) =>
      error instanceof SharedFolderError && error.code === 'INVITATION_REVOKED',
  )

  const expiredInvite = await repository.createInvitation({
    ...owner,
    folderId: created.folder.folderId,
    role: 'viewer',
    expiresInSeconds: 600,
  })
  docker(
    [
      'exec',
      '-i',
      container,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
    ],
    `UPDATE persistent_codex.folder_invitations
     SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 second'
     WHERE invitation_id='${expiredInvite.invitation.invitationId}';`,
  )
  await assert.rejects(
    repository.acceptInvitation({
      ...secondFriend,
      token: expiredInvite.token,
    }),
    (error: unknown) =>
      error instanceof SharedFolderError && error.code === 'INVITATION_EXPIRED',
  )
  assert.equal(
    (await repository.listInvitations(owner, created.folder.folderId)).find(
      (value) => value.invitationId === expiredInvite.invitation.invitationId,
    )?.status,
    'expired',
  )

  const notificationRepository =
    createPostgresSharedFolderRepository(connectionString)
  const invalidations: string[] = []
  const unsubscribe = await notificationRepository.onAccessChanged((event) =>
    invalidations.push(event.reason),
  )
  const promoted = await repository.changeRole({
    ...owner,
    folderId: created.folder.folderId,
    targetPrincipalId: friend.principalId,
    role: 'editor',
    expectedVersion: accepted.membership.version,
  })
  const binding = await repository.bindResource({
    ...owner,
    folderId: created.folder.folderId,
    resourceType: 'conversation',
    resourceId: 'conversation_wp25_postgres',
  })
  assert.equal(
    (
      await repository.authorizeResource(
        friend,
        'conversation',
        'conversation_wp25_postgres',
        'read',
      )
    ).folderId,
    created.folder.folderId,
  )
  const moved = await repository.moveResource({
    ...owner,
    sourceFolderId: created.folder.folderId,
    targetFolderId: privateSibling.folder.folderId,
    resourceType: 'conversation',
    resourceId: 'conversation_wp25_postgres',
    expectedVersion: binding.version,
  })
  await assert.rejects(
    repository.moveResource({
      ...owner,
      sourceFolderId: created.folder.folderId,
      targetFolderId: privateSibling.folder.folderId,
      resourceType: 'conversation',
      resourceId: 'conversation_wp25_postgres',
      expectedVersion: binding.version,
    }),
    (error: unknown) => error instanceof SharedFolderError,
  )
  assert.equal(moved.folderId, privateSibling.folder.folderId)

  const ownershipInvite = await repository.createInvitation({
    ...owner,
    folderId: created.folder.folderId,
    role: 'editor',
    expiresInSeconds: 600,
  })
  const ownershipMember = await repository.acceptInvitation({
    ...secondFriend,
    token: ownershipInvite.token,
  })
  const beforeTransfer = await repository.getFolder(
    owner,
    created.folder.folderId,
  )
  const transferResults = await Promise.allSettled([
    repository.transferOwnership({
      ...owner,
      folderId: created.folder.folderId,
      targetPrincipalId: friend.principalId,
      expectedVersion: beforeTransfer.version,
      previousOwnerRole: 'editor',
    }),
    repository.transferOwnership({
      ...owner,
      folderId: created.folder.folderId,
      targetPrincipalId: secondFriend.principalId,
      expectedVersion: beforeTransfer.version,
      previousOwnerRole: 'editor',
    }),
  ])
  assert.equal(
    transferResults.filter((value) => value.status === 'fulfilled').length,
    1,
  )
  assert.equal(
    transferResults.filter((value) => value.status === 'rejected').length,
    1,
  )
  assert.equal(ownershipMember.membership.role, 'editor')

  await new Promise((resolve) => setTimeout(resolve, 100))
  assert(invalidations.includes('role_changed'))
  assert(invalidations.includes('resource_moved'))
  assert(invalidations.includes('ownership_transferred'))
  unsubscribe()
  await notificationRepository.close()

  await repository.close()
  repository = createPostgresSharedFolderRepository(connectionString)
  pool = repository.pool
  assert(
    (await repository.listFolders(friend)).some(
      (entry) => entry.folder.folderId === created.folder.folderId,
    ),
  )
  const restartPersistence = 'pass'

  const adversarial = await pool.connect()
  try {
    await adversarial.query('BEGIN')
    await adversarial.query(
      `SELECT set_config('app.tenant_id','org_b',true),
              set_config('app.organization_id','org_b',true),
              set_config('app.workspace_id','wsp_b',true),
              set_config('app.principal_id','principal_friend',true)`,
    )
    assert.equal(
      Number(
        (
          await adversarial.query(
            'SELECT count(*) AS count FROM persistent_codex.folders WHERE folder_id=$1',
            [created.folder.folderId],
          )
        ).rows[0].count,
      ),
      0,
    )
    await adversarial.query('ROLLBACK')
  } finally {
    adversarial.release()
  }

  const adminSql = (sql: string) =>
    docker([
      'exec',
      '-i',
      container,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-tAc',
      sql,
    ])
  const forced = adminSql(
    `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='persistent_codex' AND c.relname LIKE 'folder%'
       AND c.relrowsecurity AND c.relforcerowsecurity`,
  )
  assert.equal(Number(forced), 9)
  const tokenColumns = adminSql(
    `SELECT count(*) FROM information_schema.columns
     WHERE table_schema='persistent_codex' AND table_name='folder_invitations'
       AND column_name IN ('token','raw_token','invitation_token')`,
  )
  assert.equal(Number(tokenColumns), 0)

  const currentOwner = transferResults.find(
    (
      value,
    ): value is PromiseFulfilledResult<
      Awaited<ReturnType<typeof repository.transferOwnership>>
    > => value.status === 'fulfilled',
  )!.value.owner.principalId
  const executionIdentity = { ...owner, principalId: currentOwner }
  const [taskA, taskB] = await Promise.all([
    repository.reserveTask({
      ...executionIdentity,
      folderId: created.folder.folderId,
      sessionId: 'session-race',
      idempotencyKey: 'race-key',
      requestHash: 'a'.repeat(64),
    }),
    repository.reserveTask({
      ...executionIdentity,
      folderId: created.folder.folderId,
      sessionId: 'session-race',
      idempotencyKey: 'race-key',
      requestHash: 'a'.repeat(64),
    }),
  ])
  assert.equal(taskA.reservation.taskId, taskB.reservation.taskId)
  assert.equal([taskA.created, taskB.created].filter(Boolean).length, 1)
  const approvalInput = {
    ...executionIdentity,
    folderId: created.folder.folderId,
    approvalId: 'approval_wp25_postgres',
    expectedVersion: 1,
    durableEventId: 'evt-resolution-a',
    codexTurnId: 'turn-race',
    decision: 'accept',
  }
  const [approvalA, approvalB] = await Promise.all([
    repository.reserveApprovalResolution(approvalInput),
    repository.reserveApprovalResolution({
      ...approvalInput,
      durableEventId: 'evt-resolution-b',
    }),
  ])
  assert.equal(approvalA.resolutionId, approvalB.resolutionId)
  assert.equal([approvalA.created, approvalB.created].filter(Boolean).length, 1)
  const settlementInput = {
    ...executionIdentity,
    taskId: taskA.reservation.taskId,
    status: 'completed' as const,
  }
  const [settlementA, settlementB] = await Promise.all([
    repository.settleTask(settlementInput),
    repository.settleTask(settlementInput),
  ])
  assert.equal(settlementA.billingSettlementId, settlementB.billingSettlementId)

  console.log(
    JSON.stringify({
      gate: 'wp25:postgres',
      forcedRlsTables: 9,
      tenantIsolation: 'pass',
      principalIsolation: 'pass',
      folderId: created.folder.folderId,
      privateFolderId: privateSibling.folder.folderId,
      invitationId: issued.invitation.invitationId,
      ownerPrincipalId: owner.principalId,
      friendPrincipalId: friend.principalId,
      taskRace: 'single-upstream',
      approvalId: approvalInput.approvalId,
      approvalResolutionId: approvalA.resolutionId,
      billingSettlementId: settlementA.billingSettlementId,
      restartPersistence,
      invalidations,
      resourceId: moved.resourceId,
      cleanup: { container, volume, status: 'scheduled' },
    }),
  )
  await repository.close()
} finally {
  spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' })
  spawnSync('docker', ['volume', 'rm', '-f', volume], { encoding: 'utf8' })
}
