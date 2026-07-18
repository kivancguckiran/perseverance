import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createPostgresSharedFolderRepository } from '../packages/shared-folders/src/postgres.ts'

const container = `persistent-wp25-${randomUUID()}`
const volume = `${container}-data`
const image = process.env.WP25_POSTGRES_IMAGE ?? 'postgres:17-alpine'

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
      INSERT INTO persistent_codex.organizations VALUES ('org_a','A','active'),('org_b','B','active');
      INSERT INTO persistent_codex.workspaces (organization_id,workspace_id,name)
        VALUES ('org_a','wsp_a','A'),('org_b','wsp_b','B');
    `,
  )
  const port = docker(['port', container, '5432/tcp']).split(':').at(-1)!
  const connectionString = `postgresql://folder_runtime:runtime@127.0.0.1:${port}/postgres`
  const repository = createPostgresSharedFolderRepository(connectionString)
  const pool = repository.pool

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
  assert.equal(Number(forced), 8)
  const tokenColumns = adminSql(
    `SELECT count(*) FROM information_schema.columns
     WHERE table_schema='persistent_codex' AND table_name='folder_invitations'
       AND column_name IN ('token','raw_token','invitation_token')`,
  )
  assert.equal(Number(tokenColumns), 0)

  const raceClient = await pool.connect()
  try {
    await raceClient.query('BEGIN')
    await raceClient.query(
      `SELECT set_config('app.tenant_id','org_a',true),
              set_config('app.organization_id','org_a',true),
              set_config('app.workspace_id','wsp_a',true),
              set_config('app.principal_id','principal_owner',true)`,
    )
    const taskId = `tsk_${randomUUID()}`
    const first = await raceClient.query(
      `INSERT INTO persistent_codex.folder_task_reservations
        (tenant_id,organization_id,workspace_id,folder_id,principal_id,task_id,
         idempotency_key,upstream_work_id,status)
       VALUES ('org_a','org_a','wsp_a',$1,'principal_owner',$2,'race-key',$3,'reserved')
       ON CONFLICT (tenant_id,organization_id,workspace_id,idempotency_key)
       DO NOTHING RETURNING upstream_work_id`,
      [created.folder.folderId, taskId, `up_${randomUUID()}`],
    )
    const second = await raceClient.query(
      `INSERT INTO persistent_codex.folder_task_reservations
        (tenant_id,organization_id,workspace_id,folder_id,principal_id,task_id,
         idempotency_key,upstream_work_id,status)
       VALUES ('org_a','org_a','wsp_a',$1,'principal_owner',$2,'race-key',$3,'reserved')
       ON CONFLICT (tenant_id,organization_id,workspace_id,idempotency_key)
       DO NOTHING RETURNING upstream_work_id`,
      [created.folder.folderId, `tsk_${randomUUID()}`, `up_${randomUUID()}`],
    )
    assert.equal(first.rowCount, 1)
    assert.equal(second.rowCount, 0)
    await raceClient.query('COMMIT')
  } finally {
    raceClient.release()
  }

  console.log(
    JSON.stringify({
      gate: 'wp25:postgres',
      forcedRlsTables: 8,
      tenantIsolation: 'pass',
      principalIsolation: 'pass',
      folderId: created.folder.folderId,
      privateFolderId: privateSibling.folder.folderId,
      invitationId: issued.invitation.invitationId,
      ownerPrincipalId: owner.principalId,
      friendPrincipalId: friend.principalId,
      taskRace: 'single-upstream',
      cleanup: { container, volume, status: 'scheduled' },
    }),
  )
  await repository.close()
} finally {
  spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' })
  spawnSync('docker', ['volume', 'rm', '-f', volume], { encoding: 'utf8' })
}
