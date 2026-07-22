import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { failNotRun, machineEvidence } from './wp30-evidence'

const gate = 'wp30:rollout'
const required = [
  'WP30_ROLLOUT_DATABASE_URL',
  'WP30_ROLLOUT_APPROVED',
  'WP30_ROLLOUT_RUNTIME_ROLE',
  'WP30_COHORT_TENANT_ID',
  'WP30_COHORT_ORGANIZATION_ID',
  'WP30_COHORT_WORKSPACE_ID',
  'WP30_ROLLOUT_ID',
  'WP30_CANDIDATE_ARTIFACT_SHA256',
  'WP30_PREVIOUS_ARTIFACT_SHA256',
] as const
const missing = required.filter((name) => !process.env[name])
if (missing.length) failNotRun(gate, missing)
assert.equal(process.env.WP30_ROLLOUT_APPROVED, 'approved')
assert.match(process.env.WP30_ROLLOUT_RUNTIME_ROLE!, /^[a-z_][a-z0-9_]{0,62}$/)
assert.match(process.env.WP30_CANDIDATE_ARTIFACT_SHA256!, /^[a-f0-9]{64}$/)
assert.match(process.env.WP30_PREVIOUS_ARTIFACT_SHA256!, /^[a-f0-9]{64}$/)
const role = process.env.WP30_ROLLOUT_RUNTIME_ROLE!
const scope = [
  process.env.WP30_COHORT_TENANT_ID!,
  process.env.WP30_COHORT_ORGANIZATION_ID!,
  process.env.WP30_COHORT_WORKSPACE_ID!,
  process.env.WP30_ROLLOUT_ID!,
] as const
const sha256 = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const pool = new pg.Pool({
  connectionString: process.env.WP30_ROLLOUT_DATABASE_URL,
  max: 8,
  application_name: 'persistent-codex-wp30-rollout',
  ssl:
    process.env.WP30_POSTGRES_SSL === 'disable'
      ? false
      : { rejectUnauthorized: true },
})
const protectedTables = [
  'sessions',
  'events',
  'approvals',
  'artifacts',
  'usage_ledger',
  'sources',
  'index_documents',
  'billing_subscriptions',
]
const integrity = async () => {
  const records: Record<string, { count: number; checksum: string | null }> = {}
  for (const table of protectedTables) {
    const exists = await pool.query('SELECT to_regclass($1) name', [
      `persistent_codex.${table}`,
    ])
    assert(exists.rows[0]?.name, `protected table missing: ${table}`)
    const result = await pool.query(
      `SELECT count(*)::int count, md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text))) checksum FROM persistent_codex.${table} t WHERE tenant_id=$1`,
      [scope[0]],
    )
    records[table] = result.rows[0]
  }
  return records
}
const appendHistory = async (
  client: pg.PoolClient,
  sequence: number,
  from: string | null,
  to: string,
  cohort: string,
  artifact: string,
  reason: string,
  previous: string | null,
) => {
  const hash = sha256({
    sequence,
    from,
    to,
    cohort,
    artifact,
    reason,
    previous,
  })
  await client.query(
    `INSERT INTO persistent_codex.production_rollout_history
      (tenant_id,organization_id,workspace_id,rollout_id,sequence,from_stage,to_stage,cohort_id,artifact_sha256,reason_code,previous_history_sha256,history_sha256,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`,
    [...scope, sequence, from, to, cohort, artifact, reason, previous, hash],
  )
  return hash
}
const transition = async (input: {
  expected: number
  next: string
  cohort: string
  idempotency: string
  command: string
  sequence: number
  from: string
  artifact?: string
  killSwitch?: boolean
  reason: string
  previousHistory: string | null
}) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const commandSha = sha256(input.command)
    await client.query(
      `INSERT INTO persistent_codex.production_rollout_commands
        (tenant_id,organization_id,workspace_id,rollout_id,idempotency_key,command_sha256,expected_version,resulting_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        ...scope,
        input.idempotency,
        commandSha,
        input.expected,
        input.expected + 1,
      ],
    )
    const artifact =
      input.artifact ?? process.env.WP30_CANDIDATE_ARTIFACT_SHA256!
    const history = await appendHistory(
      client,
      input.sequence,
      input.from,
      input.next,
      input.cohort,
      artifact,
      input.reason,
      input.previousHistory,
    )
    const result = await client.query(
      `UPDATE persistent_codex.production_rollouts
       SET stage=$5,cohort_id=$6,artifact_sha256=$7,kill_switch=$8,history_head_sha256=$9,version=version+1,updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND rollout_id=$4 AND version=$10
       RETURNING stage,version,cohort_id,artifact_sha256,kill_switch,history_head_sha256`,
      [
        ...scope,
        input.next,
        input.cohort,
        artifact,
        input.killSwitch ?? false,
        history,
        input.expected,
      ],
    )
    if (result.rowCount !== 1)
      throw new Error('PRODUCTION_ROLLOUT_VERSION_CONFLICT')
    await client.query('COMMIT')
    return result.rows[0]
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

try {
  const migration = await pool.query(
    "SELECT to_regclass('persistent_codex.production_rollouts') name",
  )
  assert(migration.rows[0]?.name, 'migration 0034 is not applied')
  const before = await integrity()
  await pool.query(
    `INSERT INTO persistent_codex.production_rollouts
      (tenant_id,organization_id,workspace_id,rollout_id,stage,cohort_id,artifact_sha256,previous_artifact_sha256,feature_flag_enabled)
      VALUES($1,$2,$3,$4,'internal','internal',$5,$6,true)`,
    [
      ...scope,
      process.env.WP30_CANDIDATE_ARTIFACT_SHA256,
      process.env.WP30_PREVIOUS_ARTIFACT_SHA256,
    ],
  )
  let previous: string | null = null
  const design = await transition({
    expected: 1,
    next: 'design_partner',
    cohort: 'design-partner',
    idempotency: 'promote-design-partner',
    command: 'promote-design-partner',
    sequence: 1,
    from: 'internal',
    reason: 'SUCCESS_BUDGET_MET',
    previousHistory: previous,
  })
  previous = design.history_head_sha256
  const stale = await Promise.allSettled([
    transition({
      expected: 2,
      next: 'limited_beta',
      cohort: 'limited-beta',
      idempotency: 'promote-limited-winner',
      command: 'promote-limited-winner',
      sequence: 2,
      from: 'design_partner',
      reason: 'SUCCESS_BUDGET_MET',
      previousHistory: previous,
    }),
    transition({
      expected: 2,
      next: 'limited_beta',
      cohort: 'limited-beta',
      idempotency: 'promote-limited-loser',
      command: 'promote-limited-loser',
      sequence: 2,
      from: 'design_partner',
      reason: 'SUCCESS_BUDGET_MET',
      previousHistory: previous,
    }),
  ])
  assert.equal(
    stale.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  const limited = stale.find(
    (result): result is PromiseFulfilledResult<any> =>
      result.status === 'fulfilled',
  )!.value
  previous = limited.history_head_sha256
  const production = await transition({
    expected: 3,
    next: 'production_cohort',
    cohort: 'production-cohort',
    idempotency: 'promote-production',
    command: 'promote-production',
    sequence: 3,
    from: 'limited_beta',
    reason: 'SUCCESS_BUDGET_MET',
    previousHistory: previous,
  })
  previous = production.history_head_sha256
  const halted = await transition({
    expected: 4,
    next: 'halted',
    cohort: 'production-cohort',
    idempotency: 'halt-drill',
    command: 'halt-drill',
    sequence: 4,
    from: 'production_cohort',
    reason: 'OPERATOR_ROLLBACK_DRILL',
    previousHistory: previous,
    killSwitch: true,
  })
  previous = halted.history_head_sha256
  const rolledBack = await transition({
    expected: 5,
    next: 'rolled_back',
    cohort: 'stable',
    idempotency: 'rollback-drill',
    command: 'rollback-drill',
    sequence: 5,
    from: 'halted',
    reason: 'ROLLBACK_INTEGRITY_VERIFIED',
    previousHistory: previous,
    artifact: process.env.WP30_PREVIOUS_ARTIFACT_SHA256!,
    killSwitch: true,
  })
  const after = await integrity()
  assert.deepEqual(after, before)
  assert.equal(
    rolledBack.artifact_sha256,
    process.env.WP30_PREVIOUS_ARTIFACT_SHA256,
  )

  const rlsClient = await pool.connect()
  try {
    await rlsClient.query('BEGIN')
    await rlsClient.query(`SET LOCAL ROLE ${role}`)
    await rlsClient.query("SELECT set_config('app.tenant_id',$1,true)", [
      scope[0],
    ])
    await rlsClient.query("SELECT set_config('app.organization_id',$1,true)", [
      scope[1],
    ])
    await rlsClient.query("SELECT set_config('app.workspace_id',$1,true)", [
      scope[2],
    ])
    const visible = await rlsClient.query(
      'SELECT tenant_id,organization_id,workspace_id FROM persistent_codex.production_rollouts',
    )
    assert(
      visible.rows.every(
        (row) =>
          row.tenant_id === scope[0] &&
          row.organization_id === scope[1] &&
          row.workspace_id === scope[2],
      ),
    )
    await rlsClient.query('ROLLBACK')
  } finally {
    rlsClient.release()
  }
  machineEvidence(gate, {
    accepted: true,
    status: 'passed',
    rolloutId: scope[3],
    stages: [
      'internal',
      'design_partner',
      'limited_beta',
      'production_cohort',
      'halted',
      'rolled_back',
    ],
    optimisticLockRace: { contenders: 2, winners: 1 },
    haltDrill: true,
    killSwitch: rolledBack.kill_switch,
    rollbackDrill: true,
    finalStage: rolledBack.stage,
    dataLoss: 0,
    protectedDomains: protectedTables,
    integrityBeforeSha256: sha256(before),
    integrityAfterSha256: sha256(after),
    tenantScopedRls: true,
  })
} finally {
  await pool.end()
}
