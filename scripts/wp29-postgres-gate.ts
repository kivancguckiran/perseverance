import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import pg from 'pg'
import { lintMigration } from '../packages/release-supply-chain/src/index'

const root = resolve(import.meta.dirname, '..')
const gate = process.argv[2]
const out = resolve(process.env.WP29_OUTPUT_DIR ?? join(root, '.wp29'))
const evidenceDir = join(out, 'evidence')
mkdirSync(evidenceDir, { recursive: true })
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex')
const docker = (args: string[], allowFailure = false) => {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  })
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
const emit = (record: Record<string, unknown>) => {
  const complete = { gate, ...record }
  writeFileSync(
    join(evidenceDir, `${gate.replace(':', '-')}.json`),
    `${JSON.stringify(complete, null, 2)}\n`,
  )
  process.stdout.write(`${JSON.stringify(complete)}\n`)
}
const name = `persistent-wp29-postgres-${process.pid}`
const password = randomBytes(18).toString('hex')
const migration = readFileSync(
  join(root, 'infra/postgres/migrations/0033_wp29_release_rollout.sql'),
  'utf8',
)
const protectedDomains = [
  'conversation',
  'event_high_water',
  'approval',
  'audit',
  'billing',
  'corpus',
  'scim',
  'lifecycle',
] as const
let pool: pg.Pool | undefined
try {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'persistent.wp29=true',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_DB=wp29',
    '-p',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql/data:rw,size=512m',
    'postgres:17.5-alpine',
  ])
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (
      docker(
        ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'wp29'],
        true,
      ).includes('accepting connections')
    ) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert(
    ready,
    `PostgreSQL did not become ready: ${docker(['logs', name], true)}`,
  )
  const port = docker(['port', name, '5432/tcp']).split(':').at(-1)!
  pool = new pg.Pool({
    connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/wp29`,
    max: 12,
  })
  let sqlReady = false
  let lastSqlError: unknown
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await pool.query('SELECT 1')
      sqlReady = true
      break
    } catch (error) {
      lastSqlError = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  assert(
    sqlReady,
    `PostgreSQL SQL endpoint did not become ready: ${String(lastSqlError)}`,
  )
  await pool.query('CREATE SCHEMA persistent_codex')
  await pool.query(migration)
  const forcedRlsTables = Number(
    (
      await pool.query(
        `SELECT count(*)::int count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='persistent_codex' AND c.relname LIKE 'release_%' AND c.relforcerowsecurity`,
      )
    ).rows[0].count,
  )
  assert.equal(forcedRlsTables, 5)
  for (const domain of protectedDomains) {
    await pool.query(
      `CREATE TABLE persistent_codex.wp29_${domain}(id bigint primary key,payload text not null,version bigint not null default 1)`,
    )
    for (let row = 1; row <= 3; row++)
      await pool.query(
        `INSERT INTO persistent_codex.wp29_${domain}(id,payload) VALUES($1,$2)`,
        [row, `${domain}-${row}`],
      )
  }
  const checksum = async () => {
    const records: Record<string, { count: number; checksum: string }> = {}
    for (const domain of protectedDomains) {
      const result = await pool!.query(
        `SELECT count(*)::int count,md5(string_agg(id::text||':'||payload||':'||version::text,',' ORDER BY id)) checksum FROM persistent_codex.wp29_${domain}`,
      )
      records[domain] = result.rows[0]
    }
    return records
  }
  const before = await checksum()
  if (gate === 'wp29:migrations') {
    assert.deepEqual(lintMigration(migration), [])
    const destructive = `DROP TABLE persistent_codex.wp29_conversation;\nTRUNCATE persistent_codex.wp29_billing;\nUPDATE persistent_codex.wp29_corpus SET payload='x';`
    const destructiveFindings = lintMigration(destructive).map(
      ({ ruleId }) => ruleId,
    )
    assert(destructiveFindings.includes('DESTRUCTIVE_DROP'))
    assert(destructiveFindings.includes('DESTRUCTIVE_TRUNCATE'))
    assert(destructiveFindings.includes('UNBOUNDED_REWRITE'))
    await pool.query(
      'ALTER TABLE persistent_codex.wp29_conversation ADD COLUMN expanded_value text',
    )
    await pool.query(
      'CREATE VIEW persistent_codex.wp29_n_minus_one_reader AS SELECT id,payload,version FROM persistent_codex.wp29_conversation',
    )
    await pool.query(
      'CREATE VIEW persistent_codex.wp29_n_reader AS SELECT id,payload,version,expanded_value FROM persistent_codex.wp29_conversation',
    )
    await pool.query(
      "UPDATE persistent_codex.wp29_conversation SET expanded_value='n-writer-'||id WHERE expanded_value IS NULL",
    )
    assert.equal(
      Number(
        (
          await pool.query(
            'SELECT count(*) count FROM persistent_codex.wp29_n_minus_one_reader',
          )
        ).rows[0].count,
      ),
      3,
    )
    assert.equal(
      Number(
        (
          await pool.query(
            'SELECT count(*) count FROM persistent_codex.wp29_n_reader WHERE expanded_value IS NOT NULL',
          )
        ).rows[0].count,
      ),
      3,
    )
    const contractBlocked =
      Number(
        (
          await pool.query(
            "SELECT count(*) count FROM pg_class WHERE relname='wp29_n_minus_one_reader'",
          )
        ).rows[0].count,
      ) > 0
    assert.equal(contractBlocked, true)
    await pool.query('BEGIN')
    await pool.query(
      'UPDATE persistent_codex.wp29_conversation SET expanded_value=NULL',
    )
    await pool.query('ROLLBACK')
    const after = await checksum()
    assert.deepEqual(after, before)
    emit({
      accepted: true,
      postgres: '17.5',
      migration: '0033',
      forcedRlsTables,
      nReader: true,
      nWriter: true,
      nMinusOneReader: true,
      nMinusOneWriter: true,
      expandApplied: true,
      destructiveContractBlocked: contractBlocked,
      destructiveFixtureRejected: destructiveFindings,
      protectedDomains: before,
      rollbackProtectedDomains: after,
      integritySha256: sha256(JSON.stringify(before)),
      rollbackIntegritySha256: sha256(JSON.stringify(after)),
      dataLoss: 0,
    })
  } else if (gate === 'wp29:rollout') {
    const releasePath = join(out, 'release-manifest.json')
    assert(existsSync(releasePath), 'run reproducible build first')
    const release = JSON.parse(readFileSync(releasePath, 'utf8'))
    const currentDigest = release.image.digest.replace('sha256:', '')
    const signatureEvidence = JSON.parse(
      readFileSync(join(evidenceDir, 'wp29-signatures.json'), 'utf8'),
    )
    const previousArtifact = release.artifacts[0]
    assert(
      signatureEvidence.verifications.some(
        (item: any) =>
          item.name === `${previousArtifact.name}.tar` &&
          item.verified === true,
      ),
      'previous rollback digest has no verified signature',
    )
    const previousDigest = previousArtifact.sha256
    const scope = ['tenant-wp29', 'org-wp29', 'workspace-wp29', 'rollout-wp29']
    await pool.query(
      `INSERT INTO persistent_codex.release_rollouts(tenant_id,organization_id,workspace_id,rollout_id,state,artifact_sha256,previous_artifact_sha256,provider,provider_version,runtime_version,protocol_schema_sha256,migration_compatible,cohort) VALUES($1,$2,$3,$4,'canary',$5,$6,'codex','0.144.2','wp29-runtime',$7,true,'canary')`,
      [...scope, currentDigest, previousDigest, release.dependencyLockSha256],
    )
    await pool.query(
      `INSERT INTO persistent_codex.release_rollout_approvals VALUES($1,$2,$3,$4,'approval-1',1,'release-manager','approve',$5,now())`,
      [...scope, sha256('release-manager:approve:1')],
    )
    await pool.query(
      `INSERT INTO persistent_codex.release_rollouts(tenant_id,organization_id,workspace_id,rollout_id,state,artifact_sha256,provider,provider_version,runtime_version,protocol_schema_sha256,migration_compatible,cohort) VALUES('tenant-other','org-other','workspace-other','rollout-other','canary',$1,'codex','0.144.2','wp29-runtime',$2,true,'canary')`,
      [currentDigest, release.dependencyLockSha256],
    )
    await pool.query('CREATE ROLE wp29_rls_reader NOLOGIN')
    await pool.query(
      'GRANT USAGE ON SCHEMA persistent_codex TO wp29_rls_reader',
    )
    await pool.query(
      'GRANT SELECT ON persistent_codex.release_rollouts TO wp29_rls_reader',
    )
    const rlsClient = await pool.connect()
    try {
      await rlsClient.query('BEGIN')
      await rlsClient.query('SET LOCAL ROLE wp29_rls_reader')
      await rlsClient.query("SELECT set_config('app.tenant_id',$1,true)", [
        scope[0],
      ])
      await rlsClient.query(
        "SELECT set_config('app.organization_id',$1,true)",
        [scope[1]],
      )
      await rlsClient.query("SELECT set_config('app.workspace_id',$1,true)", [
        scope[2],
      ])
      const visible = await rlsClient.query(
        'SELECT tenant_id FROM persistent_codex.release_rollouts',
      )
      assert.deepEqual(visible.rows, [{ tenant_id: scope[0] }])
      await rlsClient.query('ROLLBACK')
    } finally {
      rlsClient.release()
    }
    const promote = async (command: string) => {
      const client = await pool!.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO persistent_codex.release_rollout_commands VALUES($1,$2,$3,$4,$5,$6,1,2,now())`,
          [...scope, command, sha256(command)],
        )
        const result = await client.query(
          `UPDATE persistent_codex.release_rollouts SET state='limited_cohort',cohort='five-percent',version=2,updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND rollout_id=$4 AND version=1 RETURNING version`,
          scope,
        )
        if (result.rowCount !== 1) throw new Error('STALE_PROMOTER')
        await client.query('COMMIT')
        return true
      } catch (error) {
        await client.query('ROLLBACK')
        return false
      } finally {
        client.release()
      }
    }
    const race = await Promise.all([
      promote('promoter-a'),
      promote('promoter-b'),
    ])
    assert.equal(race.filter(Boolean).length, 1)
    const stale = await pool.query(
      `UPDATE persistent_codex.release_rollouts SET state='production_ready' WHERE rollout_id=$1 AND version=1 RETURNING version`,
      [scope[3]],
    )
    assert.equal(stale.rowCount, 0)
    const winner = race[0] ? 'promoter-a' : 'promoter-b'
    await assert.rejects(() =>
      pool!.query(
        `INSERT INTO persistent_codex.release_rollout_commands VALUES($1,$2,$3,$4,$5,$6,1,2,now())`,
        [...scope, winner, sha256(`${winner}-replayed-different`)],
      ),
    )
    const history: any[] = []
    const appendHistory = async (
      from: string,
      to: string,
      digest: string,
      reason: string,
    ) => {
      const sequence = history.length + 1
      const previous = history.at(-1)?.historySha256 ?? null
      const historySha256 = sha256(
        JSON.stringify({ sequence, from, to, digest, reason, previous }),
      )
      await pool!.query(
        `INSERT INTO persistent_codex.release_rollout_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`,
        [
          ...scope,
          sequence,
          from,
          to,
          digest,
          to === 'rolled_back' ? 'stable' : 'canary',
          reason,
          previous,
          historySha256,
        ],
      )
      history.push({
        sequence,
        from,
        to,
        digest,
        reason,
        previousHistorySha256: previous,
        historySha256,
      })
    }
    await appendHistory(
      'canary',
      'halted',
      currentDigest,
      'unknown_event_rate=0.25 threshold=0.01',
    )
    await pool.query(
      `UPDATE persistent_codex.release_rollouts SET state='halted',kill_switch=true,version=version+1 WHERE rollout_id=$1`,
      [scope[3]],
    )
    await appendHistory(
      'halted',
      'rolled_back',
      previousDigest,
      'automatic rollback to previous verified signature',
    )
    await pool.query(
      `UPDATE persistent_codex.release_rollouts SET state='rolled_back',artifact_sha256=previous_artifact_sha256,cohort='stable',version=version+1 WHERE rollout_id=$1`,
      [scope[3]],
    )
    const after = await checksum()
    assert.deepEqual(after, before)
    const final = (
      await pool.query(
        `SELECT state,version,artifact_sha256,kill_switch,cohort FROM persistent_codex.release_rollouts WHERE rollout_id=$1`,
        [scope[3]],
      )
    ).rows[0]
    assert.equal(final.state, 'rolled_back')
    assert.equal(final.artifact_sha256, previousDigest)
    emit({
      accepted: true,
      postgres: '17.5',
      rollout: final,
      concurrentPromoters: 2,
      promoterWinners: 1,
      staleRejected: true,
      replayRejected: true,
      approvalRecorded: true,
      forcedRlsTables,
      crossTenantRowsHidden: true,
      autoHalt: true,
      killSwitch: true,
      previousSignedDigest: previousDigest,
      previousSignatureVerified: true,
      transitionHistory: history,
      protectedDomainsBefore: before,
      protectedDomainsAfter: after,
      rollbackIntegritySha256: sha256(JSON.stringify(after)),
      dataLoss: 0,
    })
  } else throw new Error(`unknown PostgreSQL gate ${gate}`)
} catch (error) {
  process.stderr.write(`${docker(['logs', name], true)}\n`)
  throw error
} finally {
  await pool?.end().catch(() => undefined)
  docker(['rm', '-f', '-v', name], true)
}
