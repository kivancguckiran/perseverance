import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { failNotRun, machineEvidence } from './wp30-evidence'

const gate = 'wp30:go-no-go'
const required = [
  'WP30_ROLLOUT_DATABASE_URL',
  'WP30_COHORT_TENANT_ID',
  'WP30_COHORT_ORGANIZATION_ID',
  'WP30_COHORT_WORKSPACE_ID',
  'WP30_ROLLOUT_ID',
  'WP30_GO_NO_GO_OWNER',
  'WP30_GO_NO_GO_RECORD_ID',
  'WP30_ACCEPTANCE_CANDIDATE_SHA256',
  'WP30_SOURCE_COMMIT',
] as const
const missing = required.filter((name) => !process.env[name])
if (missing.length) failNotRun(gate, missing)
assert.match(process.env.WP30_ACCEPTANCE_CANDIDATE_SHA256!, /^[a-f0-9]{64}$/)
assert.match(process.env.WP30_SOURCE_COMMIT!, /^[a-f0-9]{40,64}$/)
const scope = [
  process.env.WP30_COHORT_TENANT_ID!,
  process.env.WP30_COHORT_ORGANIZATION_ID!,
  process.env.WP30_COHORT_WORKSPACE_ID!,
] as const
const base: {
  tenantId: string
  organizationId: string
  workspaceId: string
  recordId: string
  rolloutId: string
  decision: 'go'
  owner: string
  sourceCommit: string
  acceptanceReportSha256: string
  previousRecordSha256: string | null
  decidedAt: string
} = {
  tenantId: scope[0],
  organizationId: scope[1],
  workspaceId: scope[2],
  recordId: process.env.WP30_GO_NO_GO_RECORD_ID!,
  rolloutId: process.env.WP30_ROLLOUT_ID!,
  decision: 'go',
  owner: process.env.WP30_GO_NO_GO_OWNER!,
  sourceCommit: process.env.WP30_SOURCE_COMMIT!,
  acceptanceReportSha256: process.env.WP30_ACCEPTANCE_CANDIDATE_SHA256!,
  previousRecordSha256: null,
  decidedAt: new Date().toISOString(),
}
const recordSha256 = createHash('sha256')
  .update(JSON.stringify(base))
  .digest('hex')
const pool = new pg.Pool({
  connectionString: process.env.WP30_ROLLOUT_DATABASE_URL,
  application_name: 'persistent-codex-wp30-go-no-go',
  ssl:
    process.env.WP30_POSTGRES_SSL === 'disable'
      ? false
      : { rejectUnauthorized: true },
})
try {
  const prior = await pool.query(
    `SELECT record_sha256 FROM persistent_codex.production_go_no_go_records
     WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 ORDER BY decided_at DESC LIMIT 1`,
    [...scope],
  )
  base.previousRecordSha256 = prior.rows[0]?.record_sha256 ?? null
  const finalHash = createHash('sha256')
    .update(JSON.stringify(base))
    .digest('hex')
  await pool.query(
    `INSERT INTO persistent_codex.production_go_no_go_records
      (tenant_id,organization_id,workspace_id,record_id,rollout_id,decision,owner,source_commit,acceptance_report_sha256,previous_record_sha256,record_sha256,decided_at)
      VALUES($1,$2,$3,$4,$5,'go',$6,$7,$8,$9,$10,$11)`,
    [
      ...scope,
      base.recordId,
      base.rolloutId,
      base.owner,
      base.sourceCommit,
      base.acceptanceReportSha256,
      base.previousRecordSha256,
      finalHash,
      base.decidedAt,
    ],
  )
  machineEvidence(gate, {
    accepted: true,
    status: 'passed',
    recordId: base.recordId,
    decision: 'go',
    recordSha256: finalHash,
    previousRecordSha256: base.previousRecordSha256,
    immutable: true,
    preliminaryHashDiscarded:
      recordSha256 !== finalHash && base.previousRecordSha256 !== null,
  })
} finally {
  await pool.end()
}
