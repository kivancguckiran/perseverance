import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import pg from 'pg'
import { format as formatPrettier } from 'prettier'
import {
  WP30_LOCAL_ROOT,
  WP30_LOCAL_STATE,
  composeArgs,
  readLocalEnv,
  run,
  sha256,
} from './wp30-local'
import { scanWp30Evidence } from './wp30-evidence'
import { runZapScan } from './wp30-zap-scanner'

type Gate = {
  gate: string
  status: 'passed'
  startedAt: string
  finishedAt: string
  durationMs: number
  measurements: Record<string, unknown>
}

const env = readLocalEnv()
const scannerWork = join(WP30_LOCAL_STATE, 'local-scanner-work')
const rawDirectory = join(
  WP30_LOCAL_ROOT,
  'docs/acceptance/wp30-local-evidence',
)
const reportPath = join(
  WP30_LOCAL_ROOT,
  'docs/acceptance/wp30-local-acceptance-report.v1.json',
)
const bundlePath = join(
  WP30_LOCAL_ROOT,
  'docs/acceptance/wp30-local-evidence-bundle.v1.json',
)
const gates: Gate[] = []
const zapMaxScanDuration = Number.parseInt(
  process.env.WP30_ZAP_MAX_SCAN_MINUTES ?? '8',
  10,
)
assert(
  Number.isInteger(zapMaxScanDuration) && zapMaxScanDuration > 0,
  'WP30_ZAP_MAX_SCAN_MINUTES must be a positive integer',
)
const rawEvidence: Array<{
  path: string
  byteLength: number
  sha256: string
}> = []

const secrets = [
  env.WP30_TENANT_A_TOKEN,
  env.WP30_TENANT_B_TOKEN,
  env.WP30_POSTGRES_PASSWORD,
  env.WP30_BROKER_PASSWORD,
  env.MINIO_ROOT_PASSWORD,
].filter(Boolean)
const redact = (value: string) => {
  let result = value
  for (const secret of secrets) result = result.replaceAll(secret, '[REDACTED]')
  return result
    .replaceAll(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replaceAll(
      /(password|secret|token|authorization)(["'=:\s]+)[^\s,"'}]+/gi,
      '$1$2[REDACTED]',
    )
}
const persistRaw = (name: string, value: string | Buffer) => {
  const path = join(rawDirectory, name)
  mkdirSync(join(path, '..'), { recursive: true })
  const content = Buffer.from(
    redact(Buffer.isBuffer(value) ? value.toString('utf8') : value),
  )
  writeFileSync(path, content)
  const descriptor = {
    path: relative(WP30_LOCAL_ROOT, path),
    byteLength: content.byteLength,
    sha256: sha256(content),
  }
  rawEvidence.push(descriptor)
  return descriptor
}
const record = async (
  gate: string,
  action: () => Promise<Record<string, unknown>> | Record<string, unknown>,
) => {
  const start = Date.now()
  const startedAt = new Date(start).toISOString()
  const measurements = await action()
  const finish = Date.now()
  gates.push({
    gate,
    status: 'passed',
    startedAt,
    finishedAt: new Date(finish).toISOString(),
    durationMs: finish - start,
    measurements,
  })
}
const parseLastEvidence = (stdout: string) => {
  const line = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((value) => value.trim().startsWith('{'))
  assert(line, 'gate emitted no JSON evidence')
  return JSON.parse(line) as Record<string, unknown>
}
const fetchWithRetry = async (
  url: string,
  init?: RequestInit,
  attempts = 40,
) => {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetch(url, init)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw lastError
}
const dockerRun = (args: string[], secretEnv = false, allowFailure = false) =>
  run('docker', args, {
    env: secretEnv ? { ...process.env, ...env } : process.env,
    allowFailure,
  })
const headers = (tenant: 'A' | 'B') => ({
  authorization: `Bearer ${env[`WP30_TENANT_${tenant}_TOKEN`]}`,
  'content-type': 'application/json',
  'x-tenant-id': env[`WP30_TENANT_${tenant}_ID`],
  'x-organization-id': env[`WP30_TENANT_${tenant}_ORG_ID`],
  'x-workspace-id': env[`WP30_TENANT_${tenant}_WORKSPACE_ID`],
})
const database = () =>
  new pg.Pool({
    host: env.WP30_POSTGRES_HOST,
    port: Number(env.WP30_POSTGRES_PORT),
    database: env.WP30_POSTGRES_DATABASE,
    user: env.WP30_POSTGRES_USER,
    password: env.WP30_POSTGRES_PASSWORD,
  })
const tableChecksum = async (
  pool: pg.Pool,
  table: string,
  where: string,
  values: unknown[],
) => {
  assert.match(table, /^[a-z_]+$/)
  const result = await pool.query(
    `SELECT count(*)::int count,
      COALESCE(md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text))),'empty') checksum
     FROM persistent_codex.${table} t WHERE ${where}`,
    values,
  )
  return result.rows[0] as { count: number; checksum: string }
}

rmSync(rawDirectory, { recursive: true, force: true })
mkdirSync(rawDirectory, { recursive: true })
rmSync(scannerWork, { recursive: true, force: true })
mkdirSync(scannerWork, { recursive: true })

let cleaned = false
let acceptanceError: unknown
try {
  await record('wp30:local:preflight', () => {
    const result = run('pnpm', ['wp30:local:preflight'])
    persistRaw('gates/preflight.jsonl', `${result.stdout}${result.stderr}`)
    const evidence = parseLastEvidence(result.stdout)
    assert.equal(evidence.accepted, true)
    return evidence
  })

  await record('wp30:test', () => {
    const result = run('pnpm', ['wp30:test'])
    persistRaw('gates/wp30-test.jsonl', `${result.stdout}${result.stderr}`)
    const evidence = parseLastEvidence(result.stdout)
    assert.equal(evidence.accepted, true)
    return evidence
  })

  await record('wp30:postgres-migration', () => {
    const result = run('pnpm', ['wp30:postgres-migration'])
    persistRaw(
      'gates/postgres-migration.jsonl',
      `${result.stdout}${result.stderr}`,
    )
    const evidence = parseLastEvidence(result.stdout)
    assert.equal(evidence.accepted, true)
    return evidence
  })

  await record('wp30:local:scanners', () => {
    const zapSource = readFileSync(
      join(WP30_LOCAL_ROOT, 'infra/security/wp30/zap-automation.yaml'),
      'utf8',
    )
    const zapDescriptors: typeof rawEvidence = []
    const zapExitCodes: Record<string, number> = {}
    const zapRetryCounts: Record<string, number> = {}
    const zapReportSha256: Record<string, string> = {}
    let zapAlerts = 0
    for (const [label, target] of [
      ['control-plane', env.WP30_DOCKER_TARGET_URL],
      ['web', 'http://web:3301'],
    ]) {
      const work = join(scannerWork, `zap-${label}`)
      const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const descriptorStart = rawEvidence.length
      const scan = runZapScan({
        label,
        target,
        work,
        image: env.WP30_ZAP_IMAGE,
        planContent: zapSource
          .replaceAll('__WP30_TARGET_URL__', target)
          .replaceAll('__WP30_TARGET_REGEX__', escapedTarget)
          .replace(
            'maxScanDurationInMins: 30',
            `maxScanDurationInMins: ${zapMaxScanDuration}`,
          )
          .replace('maxRuleDurationInMins: 5', 'maxRuleDurationInMins: 2'),
        execute: (args) => dockerRun(args, false, true),
        persistRaw,
      })
      zapDescriptors.push(...rawEvidence.slice(descriptorStart))
      zapAlerts += scan.alerts.length
      zapExitCodes[label] = scan.exitCode
      zapRetryCounts[label] = scan.retryCount
      zapReportSha256[label] = sha256(scan.content)
      assert.equal(scan.highOrCritical, 0)
    }

    const nucleiWork = join(scannerWork, 'nuclei')
    mkdirSync(join(nucleiWork, 'raw'), { recursive: true })
    cpSync(
      join(WP30_LOCAL_ROOT, 'infra/security/wp30/templates'),
      join(nucleiWork, 'templates'),
      { recursive: true },
    )
    const replacements: Record<string, string> = {
      __WP30_TENANT_A_TOKEN__: env.WP30_TENANT_A_TOKEN,
      __WP30_TENANT_A_ID__: env.WP30_TENANT_A_ID,
      __WP30_TENANT_A_ORG_ID__: env.WP30_TENANT_A_ORG_ID,
      __WP30_TENANT_A_WORKSPACE_ID__: env.WP30_TENANT_A_WORKSPACE_ID,
      __WP30_TENANT_B_WORKSPACE_ID__: env.WP30_TENANT_B_WORKSPACE_ID,
      __WP30_FOREIGN_SESSION_ID__: env.WP30_FOREIGN_SESSION_ID,
    }
    for (const name of ['tenant-boundary.yaml', 'realtime-boundary.yaml']) {
      const path = join(nucleiWork, 'templates', name)
      let content = readFileSync(path, 'utf8')
      for (const [placeholder, value] of Object.entries(replacements))
        content = content.replaceAll(placeholder, value)
      writeFileSync(path, content, { mode: 0o600 })
    }
    writeFileSync(
      join(nucleiWork, 'targets.txt'),
      `${env.WP30_DOCKER_TARGET_URL}\nhttp://web:3301\n`,
    )
    const nucleiResult = dockerRun(
      [
        'run',
        '--rm',
        '--label',
        'persistent.wp30.local=true',
        '--network',
        'persistent-wp30-local',
        '-v',
        `${nucleiWork}:/app:rw`,
        '-v',
        `${join(WP30_LOCAL_ROOT, 'infra/security/wp30/nuclei-config.yaml')}:/config.yaml:ro`,
        env.WP30_NUCLEI_IMAGE,
        '-config',
        '/config.yaml',
        '-l',
        '/app/targets.txt',
        '-t',
        '/app/templates',
        '-jsonl-export',
        '/app/raw/nuclei.jsonl',
      ],
      false,
      true,
    )
    persistRaw(
      'scanners/nuclei.log',
      `${nucleiResult.stdout}${nucleiResult.stderr}`,
    )
    const nucleiContent = readFileSync(
      join(nucleiWork, 'raw/nuclei.jsonl'),
      'utf8',
    )
    const nucleiDescriptor = persistRaw('scanners/nuclei.jsonl', nucleiContent)
    const findings = nucleiContent
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    assert.equal(
      findings.filter((item) =>
        ['high', 'critical'].includes(item.info?.severity),
      ).length,
      0,
    )
    assert.equal(nucleiResult.status, 0)
    return {
      targets: ['control-plane', 'web-production-ssr'],
      zapAlerts,
      zapExitCodes,
      zapRetryCounts,
      zapReportSha256,
      nucleiFindings: findings.length,
      openHighOrCritical: 0,
      rawEvidence: [...zapDescriptors, nucleiDescriptor],
    }
  })

  await record('wp30:local:tenant-boundary', async () => {
    const paths = [
      `/v1/workspaces/${env.WP30_TENANT_B_WORKSPACE_ID}`,
      `/v1/sessions/${env.WP30_FOREIGN_SESSION_ID}`,
      `/v1/artifacts/${env.WP30_OBJECT_ID}`,
    ]
    const statuses: number[] = []
    for (const path of paths) {
      const response = await fetch(`${env.WP30_TARGET_URL}${path}`, {
        headers: headers('A'),
      })
      statuses.push(response.status)
      assert.equal(response.status, 404)
    }
    const authz = await fetch(
      `${env.WP30_TARGET_URL}/v1/workspaces/${env.WP30_TENANT_B_WORKSPACE_ID}`,
      {
        headers: {
          ...headers('A'),
          'x-tenant-id': env.WP30_TENANT_B_ID,
          'x-organization-id': env.WP30_TENANT_B_ORG_ID,
          'x-workspace-id': env.WP30_TENANT_B_WORKSPACE_ID,
        },
      },
    )
    assert.equal(authz.status, 403)
    const pool = database()
    let rlsVisible = -1
    try {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL ROLE wp30_runtime')
        await client.query(
          `SELECT set_config('app.organization_id',$1,true),set_config('app.workspace_id',$2,true)`,
          [env.WP30_TENANT_A_ORG_ID, env.WP30_TENANT_A_WORKSPACE_ID],
        )
        const result = await client.query(
          `SELECT count(*)::int count FROM persistent_codex.artifacts WHERE artifact_id=$1`,
          [env.WP30_OBJECT_ID],
        )
        rlsVisible = Number(result.rows[0].count)
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    } finally {
      await pool.end()
    }
    assert.equal(rlsVisible, 0)
    const evidence = { statuses, authzStatus: authz.status, rlsVisible }
    persistRaw('tenant/boundary.json', JSON.stringify(evidence))
    return evidence
  })

  await record('wp30:local:k6', () => {
    const work = join(scannerWork, 'k6')
    mkdirSync(work, { recursive: true })
    const result = dockerRun(
      [
        'run',
        '--rm',
        '--label',
        'persistent.wp30.local=true',
        '--network',
        'persistent-wp30-local',
        '-v',
        `${join(WP30_LOCAL_ROOT, 'infra/performance')}:/scripts:ro`,
        '-v',
        `${work}:/evidence:rw`,
        ...[
          'WP30_TENANT_A_TOKEN',
          'WP30_TENANT_A_ID',
          'WP30_TENANT_A_ORG_ID',
          'WP30_TENANT_A_WORKSPACE_ID',
          'WP30_TENANT_B_TOKEN',
          'WP30_TENANT_B_ID',
          'WP30_TENANT_B_ORG_ID',
          'WP30_TENANT_B_WORKSPACE_ID',
          'WP30_OBJECT_A_ID',
          'WP30_OBJECT_ID',
          'WP30_LOAD_DURATION',
          'WP30_SOAK_DURATION',
        ].flatMap((name) => ['-e', name]),
        '-e',
        `WP30_TARGET_URL=${env.WP30_DOCKER_TARGET_URL}`,
        env.WP30_K6_IMAGE,
        'run',
        '--summary-export',
        '/evidence/k6-raw.json',
        '/scripts/wp30-local.js',
      ],
      true,
    )
    persistRaw('load/k6.log', `${result.stdout}${result.stderr}`)
    const summaryContent = readFileSync(
      join(work, 'k6-local-summary.json'),
      'utf8',
    )
    const rawContent = readFileSync(join(work, 'k6-raw.json'), 'utf8')
    const summaryDescriptor = persistRaw('load/k6-summary.json', summaryContent)
    const rawDescriptor = persistRaw('load/k6-raw.json', rawContent)
    const summary = JSON.parse(summaryContent)
    assert(summary.tenantFairnessRatio >= 0.9)
    assert(Number(summary.metrics?.http_req_failed?.values?.rate ?? 1) < 0.01)
    return {
      profile: summary.profile,
      configuredLoadDuration: env.WP30_LOAD_DURATION,
      configuredSoakDuration: env.WP30_SOAK_DURATION,
      actualDurationSeconds: summary.actualDurationSeconds,
      tenantFairnessRatio: summary.tenantFairnessRatio,
      apiRealtimeSchedulerObjectFlows: true,
      productionTwoHourSoak: false,
      rawEvidence: [summaryDescriptor, rawDescriptor],
    }
  })

  await record('wp30:local:chaos', async () => {
    const seed = JSON.parse(
      readFileSync(join(WP30_LOCAL_STATE, 'seed.json'), 'utf8'),
    ) as { sessionA: string }
    const controlled = await fetch(
      `${env.WP30_TARGET_URL}/v1/sessions/${seed.sessionA}/turns`,
      {
        method: 'POST',
        headers: {
          ...headers('A'),
          'idempotency-key': 'wp30-chaos-controlled',
        },
        body: JSON.stringify({
          prompt: 'WP30 controlled chaos record',
          approvalContext: { kind: 'command', command: 'true', risk: 'low' },
        }),
      },
    )
    const controlledBody = await controlled.text()
    assert.equal(controlled.status, 202, controlledBody)
    const controlledRun = JSON.parse(controlledBody) as { runId: string }
    const pool = database()
    const protectedState = async () => ({
      sessions: await tableChecksum(
        pool,
        'ha_sessions',
        'tenant_id=$1 AND session_id=$2',
        [env.WP30_TENANT_A_ID, seed.sessionA],
      ),
      run: await tableChecksum(pool, 'ha_runs', 'tenant_id=$1 AND run_id=$2', [
        env.WP30_TENANT_A_ID,
        controlledRun.runId,
      ]),
      events: await tableChecksum(
        pool,
        'ha_events',
        'tenant_id=$1 AND session_id=$2',
        [env.WP30_TENANT_A_ID, seed.sessionA],
      ),
    })
    try {
      const before = await protectedState()
      const observations: Array<Record<string, unknown>> = []
      for (const service of ['cache', 'object-storage', 'workspace-agent']) {
        const id = run('docker', composeArgs('ps', '-q', service)).stdout.trim()
        assert(id)
        run('docker', ['pause', id])
        const started = Date.now()
        const response = await fetchWithRetry(
          service === 'cache'
            ? `${env.WP30_TARGET_URL}/v1/sessions/${seed.sessionA}`
            : `${env.WP30_TARGET_URL}/v1/sessions`,
          service === 'cache'
            ? { headers: headers('A') }
            : { method: 'POST', headers: headers('A'), body: '{}' },
          1,
        )
        const durationMs = Date.now() - started
        run('docker', ['unpause', id])
        assert(
          service === 'cache'
            ? response.status === 200
            : [201, 503].includes(response.status),
        )
        assert(durationMs < 5_000)
        const recovered = await fetchWithRetry(
          `${env.WP30_TARGET_URL}/v1/sessions/${seed.sessionA}`,
          { headers: headers('A') },
        )
        assert.equal(recovered.status, 200)
        observations.push({
          service,
          degradedStatus: response.status,
          boundedDurationMs: durationMs,
          recoveryStatus: recovered.status,
        })
      }
      const after = await protectedState()
      const mixing = await pool.query(
        `SELECT count(*)::int count FROM persistent_codex.ha_sessions
         WHERE tenant_id<>organization_id`,
      )
      const duplicates = await pool.query(
        `SELECT
          (SELECT count(*)::int FROM (
             SELECT tenant_id,workspace_id,session_id,event_id,count(*)
             FROM persistent_codex.ha_events GROUP BY 1,2,3,4 HAVING count(*)>1
           ) d) event_duplicates,
          (SELECT count(*)::int FROM (
             SELECT tenant_id,workspace_id,idempotency_key,count(*)
             FROM persistent_codex.ha_runs GROUP BY 1,2,3 HAVING count(*)>1
           ) d) job_duplicates`,
      )
      const dataLoss =
        before.sessions.checksum === after.sessions.checksum &&
        before.run.checksum === after.run.checksum &&
        before.sessions.count === after.sessions.count &&
        before.run.count === after.run.count
          ? 0
          : 1
      assert.equal(Number(mixing.rows[0].count), 0)
      assert.equal(Number(duplicates.rows[0].event_duplicates), 0)
      assert.equal(Number(duplicates.rows[0].job_duplicates), 0)
      assert.equal(dataLoss, 0)
      const evidence = {
        injection: 'container-pause-with-live-request',
        observations,
        conversationId: seed.sessionA,
        runId: controlledRun.runId,
        before,
        after,
        tenantMixing: Number(mixing.rows[0].count),
        uncontrolledDuplicates:
          Number(duplicates.rows[0].event_duplicates) +
          Number(duplicates.rows[0].job_duplicates),
        dataLoss,
      }
      persistRaw('chaos/measurements.json', JSON.stringify(evidence))
      return evidence
    } finally {
      await pool.end()
    }
  })

  await record('wp30:local:rollout-rollback', async () => {
    const scopeHeaders = headers('A')
    const candidate = sha256('wp30-local-candidate')
    const previous = sha256('wp30-local-stable')
    const pool = database()
    const protectedTables = ['sessions', 'events', 'approvals', 'artifacts']
    const integrity = async () =>
      Object.fromEntries(
        await Promise.all(
          protectedTables.map(async (table) => [
            table,
            await tableChecksum(pool, table, 'organization_id=$1', [
              env.WP30_TENANT_A_ORG_ID,
            ]),
          ]),
        ),
      )
    const transition = (
      expectedVersion: number,
      idempotencyKey: string,
      next: string,
      cohortId: string,
      extra: Record<string, unknown> = {},
    ) =>
      fetch(
        `${env.WP30_TARGET_URL}/v1/production-rollouts/${env.WP30_ROLLOUT_ID}/transitions`,
        {
          method: 'POST',
          headers: scopeHeaders,
          body: JSON.stringify({
            expectedVersion,
            idempotencyKey,
            next,
            cohortId,
            ...extra,
          }),
        },
      )
    try {
      const before = await integrity()
      const created = await fetch(
        `${env.WP30_TARGET_URL}/v1/production-rollouts`,
        {
          method: 'POST',
          headers: scopeHeaders,
          body: JSON.stringify({
            rolloutId: env.WP30_ROLLOUT_ID,
            cohortId: env.WP30_COHORT_ID,
            artifactSha256: candidate,
            previousArtifactSha256: previous,
          }),
        },
      )
      assert.equal(created.status, 201, await created.text())
      assert.equal(
        (
          await transition(1, 'promote-design', 'design_partner', 'design', {
            budgetHealthy: true,
          })
        ).status,
        200,
      )
      const contenders = await Promise.all([
        transition(2, 'promote-limited-a', 'limited_beta', 'limited', {
          budgetHealthy: true,
        }),
        transition(2, 'promote-limited-b', 'limited_beta', 'limited', {
          budgetHealthy: true,
        }),
      ])
      assert.deepEqual(
        contenders.map((value) => value.status).sort(),
        [200, 409],
      )
      const winner = contenders.find((value) => value.status === 200)!
      const winnerIndex = contenders.indexOf(winner)
      const replay = await transition(
        2,
        winnerIndex === 0 ? 'promote-limited-a' : 'promote-limited-b',
        'limited_beta',
        'limited',
        { budgetHealthy: true },
      )
      assert.equal(replay.status, 200)
      const stale = await transition(
        2,
        'stale-promotion',
        'limited_beta',
        'limited',
        { budgetHealthy: true },
      )
      assert.equal(stale.status, 409)
      assert.equal(
        (
          await transition(
            3,
            'promote-production',
            'production_cohort',
            'production',
            {
              budgetHealthy: true,
            },
          )
        ).status,
        200,
      )
      assert.equal(
        (
          await transition(4, 'halt', 'halted', 'production', {
            operatorHalt: true,
          })
        ).status,
        200,
      )
      const rolledBack = await transition(
        5,
        'rollback',
        'rolled_back',
        'stable',
        {
          rollbackVerified: true,
        },
      )
      assert.equal(rolledBack.status, 200)
      const rollbackBody = (await rolledBack.json()) as {
        stage: string
        artifact_sha256: string
      }
      assert.equal(rollbackBody.stage, 'rolled_back')
      assert.equal(rollbackBody.artifact_sha256, previous)
      const after = await integrity()
      const dataLoss =
        sha256(JSON.stringify(before)) === sha256(JSON.stringify(after)) ? 0 : 1
      assert.equal(dataLoss, 0)
      const evidence = {
        authority: 'production-readiness-domain-via-control-plane-api',
        flow: [
          'internal',
          'design_partner',
          'limited_beta',
          'production_cohort',
          'halted',
          'rolled_back',
        ],
        concurrentPromotion: { contenders: 2, winners: 1 },
        optimisticLocking: true,
        replayStatus: replay.status,
        staleStatus: stale.status,
        protectedDomains: protectedTables,
        integrityBeforeSha256: sha256(JSON.stringify(before)),
        integrityAfterSha256: sha256(JSON.stringify(after)),
        dataLoss,
      }
      persistRaw('rollout/measurements.json', JSON.stringify(evidence))
      return evidence
    } finally {
      await pool.end()
    }
  })

  await record('wp30:local:browser-golden', async () => {
    const seed = JSON.parse(
      readFileSync(join(WP30_LOCAL_STATE, 'seed.json'), 'utf8'),
    ) as { sessionA: string }
    const approvalResponse = await fetch(
      `${env.WP30_TARGET_URL}/v1/sessions/${seed.sessionA}/turns`,
      {
        method: 'POST',
        headers: {
          ...headers('A'),
          'idempotency-key': 'wp30-browser-approval',
        },
        body: JSON.stringify({
          prompt: 'WP30 browser approval',
          approvalContext: {
            kind: 'command',
            command: 'printf wp30-browser',
            risk: 'bounded',
          },
        }),
      },
    )
    const approvalBody = await approvalResponse.text()
    assert.equal(approvalResponse.status, 202, approvalBody)
    const approvalId = String(JSON.parse(approvalBody).approvalId)
    const browserSession = `wp30-local-${process.pid}`
    const browser = (...args: string[]) =>
      run('agent-browser', args, {
        env: { ...process.env, AGENT_BROWSER_SESSION: browserSession },
      })
    const parseEval = (output: string) => {
      const parsed = JSON.parse(output.trim())
      return typeof parsed === 'string' ? JSON.parse(parsed) : parsed
    }
    try {
      browser('open', env.WP30_WEB_URL)
      browser(
        'eval',
        `sessionStorage.setItem('persistent.auth',${JSON.stringify(JSON.stringify({ accessToken: env.WP30_TENANT_A_TOKEN }))})`,
      )
      const url = `${env.WP30_WEB_URL}/sessions/${encodeURIComponent(seed.sessionA)}?surface=production-ha&tenant=${encodeURIComponent(env.WP30_TENANT_A_ID)}&organization=${encodeURIComponent(env.WP30_TENANT_A_ORG_ID)}&workspace=${encodeURIComponent(env.WP30_TENANT_A_WORKSPACE_ID)}`
      browser('open', url)
      browser('wait', '[data-production-session-ready="true"]')
      browser('wait', `[data-approval-id="${approvalId}"]`)
      const viewports = []
      for (const [width, height] of [
        [1280, 720],
        [390, 844],
      ]) {
        browser('set', 'viewport', String(width), String(height))
        const state = parseEval(
          browser(
            'eval',
            `JSON.stringify({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,errorOverlay:Boolean(document.querySelector('[data-error-overlay]')),ready:Boolean(document.querySelector('[data-production-session-ready="true"]'))})`,
          ).stdout,
        )
        assert.equal(state.width, width)
        assert.equal(state.overflow, false)
        assert.equal(state.errorOverlay, false)
        assert.equal(state.ready, true)
        viewports.push(state)
      }
      browser('click', `[data-approval-id="${approvalId}"] button`)
      browser(
        'wait',
        `[data-approval-id="${approvalId}"][data-approval-state="accepted"]`,
      )
      const controlPlaneId = run(
        'docker',
        composeArgs('ps', '-q', 'control-plane'),
      ).stdout.trim()
      run('docker', ['restart', controlPlaneId])
      browser('wait', '1000')
      browser('wait', '[data-realtime-state="connected"]')
      const reconnect = parseEval(
        browser(
          'eval',
          `JSON.stringify({reconnectCount:Number(document.querySelector('[data-production-session-ready]')?.getAttribute('data-reconnect-count')||0),state:document.querySelector('[data-realtime]')?.textContent,errorOverlay:Boolean(document.querySelector('[data-error-overlay]'))})`,
        ).stdout,
      )
      assert(reconnect.reconnectCount >= 1)
      assert.equal(reconnect.state, 'connected')
      assert.equal(reconnect.errorOverlay, false)
      const snapshot = browser('snapshot').stdout
      const snapshotDescriptor = persistRaw('browser/snapshot.txt', snapshot)
      assert(snapshotDescriptor.byteLength > 0, 'browser snapshot is empty')
      const screenshotPath = join(rawDirectory, 'browser/golden.png')
      mkdirSync(join(screenshotPath, '..'), { recursive: true })
      const screenshotResult = run(
        'agent-browser',
        ['screenshot', screenshotPath],
        {
          env: { ...process.env, AGENT_BROWSER_SESSION: browserSession },
          allowFailure: true,
        },
      )
      persistRaw(
        'browser/screenshot.log',
        `${screenshotResult.stdout}${screenshotResult.stderr}`,
      )
      let screenshotDescriptor: (typeof rawEvidence)[number] | null = null
      try {
        const screenshot = Buffer.from(readFileSync(screenshotPath))
        assert(screenshot.byteLength > 0)
        screenshotDescriptor = {
          path: relative(WP30_LOCAL_ROOT, screenshotPath),
          byteLength: screenshot.byteLength,
          sha256: sha256(screenshot),
        }
        rawEvidence.push(screenshotDescriptor)
      } catch {
        assert.notEqual(
          screenshotResult.status,
          0,
          'browser reported screenshot success without an artifact',
        )
      }
      return {
        route: `/sessions/${seed.sessionA}`,
        productionSsr: true,
        approvalCreatedByApi: true,
        approvalResolvedInUi: true,
        viewports,
        reconnect,
        screenshot: screenshotDescriptor,
        screenshotExitCode: screenshotResult.status,
        snapshot: snapshotDescriptor,
      }
    } finally {
      browser('close', '--all')
    }
  })

  await record('wp30:lab:down', () => {
    const before = run('docker', [
      'ps',
      '-a',
      '--filter',
      'label=persistent.wp30.local=true',
      '--format',
      '{{json .}}',
    ]).stdout
    const volumes = run('docker', [
      'volume',
      'ls',
      '--filter',
      'label=persistent.wp30.local=true',
      '--format',
      '{{json .}}',
    ]).stdout
    const networks = run('docker', [
      'network',
      'ls',
      '--filter',
      'label=persistent.wp30.local=true',
      '--format',
      '{{json .}}',
    ]).stdout
    const browserSessions = run('agent-browser', ['session', 'list'], {
      allowFailure: true,
    }).stdout
    const processInventory = run('ps', ['-axo', 'pid=,command='], {
      allowFailure: true,
    })
      .stdout.split('\n')
      .filter((line) => /wp30|agent-browser/i.test(line))
      .join('\n')
    persistRaw(
      'cleanup/pre-cleanup.json',
      JSON.stringify({
        containers: before.split('\n').filter(Boolean),
        volumes: volumes.split('\n').filter(Boolean),
        networks: networks.split('\n').filter(Boolean),
        browserSessions: browserSessions.split('\n').filter(Boolean),
        processes: processInventory.split('\n').filter(Boolean),
        secretFiles: [
          '.wp30/local.env',
          '.wp30/postgres-password',
          '.wp30/oidc-private.pem',
          '.wp30/oidc-public.jwk',
        ].filter((path) => {
          try {
            return statSync(join(WP30_LOCAL_ROOT, path)).isFile()
          } catch {
            return false
          }
        }),
      }),
    )
    const cleanup = run('pnpm', ['wp30:lab:down'], { allowFailure: true })
    persistRaw('cleanup/lab-down.log', `${cleanup.stdout}${cleanup.stderr}`)
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout)
    cleaned = true
    const remaining = run('docker', [
      'ps',
      '-aq',
      '--filter',
      'label=persistent.wp30.local=true',
    ])
      .stdout.trim()
      .split('\n')
      .filter(Boolean)
    const remainingVolumes = run('docker', [
      'volume',
      'ls',
      '-q',
      '--filter',
      'label=persistent.wp30.local=true',
    ])
      .stdout.trim()
      .split('\n')
      .filter(Boolean)
    const remainingNetworks = run('docker', [
      'network',
      'ls',
      '-q',
      '--filter',
      'label=persistent.wp30.local=true',
    ])
      .stdout.trim()
      .split('\n')
      .filter(Boolean)
    const secretsRemoved = [
      'local.env',
      'postgres-password',
      'oidc-private.pem',
      'oidc-public.jwk',
      'seed.json',
    ].every((name) => {
      try {
        statSync(join(WP30_LOCAL_STATE, name))
        return false
      } catch {
        return true
      }
    })
    assert.deepEqual(
      [remaining, remainingVolumes, remainingNetworks],
      [[], [], []],
    )
    assert.equal(secretsRemoved, true)
    const evidence = {
      cleanupStatus: 'clean',
      remainingContainers: remaining.length,
      remainingVolumes: remainingVolumes.length,
      remainingNetworks: remainingNetworks.length,
      browserSessionsClosed: true,
      secretsRemoved,
    }
    persistRaw('cleanup/post-cleanup.json', JSON.stringify(evidence))
    return evidence
  })

  assert(cleaned, 'cleanup must pass before report generation')
  const finishedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    workPackage: 'WP30-L',
    status: 'accepted-local-production-like',
    engineeringComplete: true,
    externalProductionReady: false,
    evidenceClass: 'local-operator',
    targetScope: 'loopback-only',
    independentPentest: 'not-run',
    multiRegionFailover: 'not-run',
    productionKmsFailure: 'not-run',
    realPushBillingFailure: 'not-run',
    sourceCommit: env.WP30_SOURCE_COMMIT,
    startedAt: gates[0]?.startedAt,
    finishedAt,
    durationMs: gates.reduce((sum, gate) => sum + gate.durationMs, 0),
    gates,
    localMandatoryGatesNotRun: [],
    evidenceChain: gates.map((gate) => ({
      gate: gate.gate,
      status: gate.status,
      sha256: sha256(JSON.stringify(gate)),
    })),
  }
  const reportContent = await formatPrettier(JSON.stringify(report), {
    parser: 'json',
  })
  const reportScan = scanWp30Evidence([
    { name: 'local-report', content: reportContent },
  ])
  assert.equal(reportScan.passed, true, JSON.stringify(reportScan.findings))
  writeFileSync(reportPath, reportContent)
  writeFileSync(
    reportPath.replace(/\.json$/, '.sha256'),
    `${sha256(reportContent)}  ${reportPath.split('/').at(-1)}\n`,
  )

  const embeddedRawEvidence = rawEvidence
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((descriptor) => ({
      ...descriptor,
      encoding: 'base64' as const,
      content: readFileSync(join(WP30_LOCAL_ROOT, descriptor.path)).toString(
        'base64',
      ),
    }))
  for (const item of embeddedRawEvidence) {
    const bytes = Buffer.from(item.content, item.encoding)
    assert.equal(bytes.byteLength, item.byteLength)
    assert.equal(sha256(bytes), item.sha256)
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const unsignedBundle = {
    schemaVersion: 1,
    evidenceClass: 'local-operator',
    independentAttestation: false,
    externalProductionReady: false,
    sourceCommit: env.WP30_SOURCE_COMMIT,
    reportSha256: sha256(reportContent),
    evidenceChain: report.evidenceChain,
    rawEvidence: embeddedRawEvidence,
    publicKey: publicPem,
    signatureAlgorithm: 'Ed25519',
    generatedAt: finishedAt,
  }
  const unsignedContent = JSON.stringify(unsignedBundle)
  const signature = sign(
    null,
    Buffer.from(unsignedContent),
    privateKey,
  ).toString('base64')
  const signatureVerified = verify(
    null,
    Buffer.from(unsignedContent),
    createPublicKey(publicPem),
    Buffer.from(signature, 'base64'),
  )
  assert.equal(signatureVerified, true)
  const bundle = {
    ...unsignedBundle,
    signedPayloadSha256: sha256(unsignedContent),
    signature,
    signatureVerified,
  }
  const bundleContent = await formatPrettier(JSON.stringify(bundle), {
    parser: 'json',
  })
  const bundleScan = scanWp30Evidence([
    { name: 'local-bundle', content: bundleContent },
  ])
  assert.equal(bundleScan.passed, true, JSON.stringify(bundleScan.findings))
  writeFileSync(bundlePath, bundleContent)
  writeFileSync(
    bundlePath.replace(/\.json$/, '.sha256'),
    `${sha256(bundleContent)}  ${bundlePath.split('/').at(-1)}\n`,
  )
  process.stdout.write(
    `${JSON.stringify({ gate: 'wp30:local:accept', status: report.status, engineeringComplete: true, externalProductionReady: false, evidenceClass: 'local-operator', targetScope: 'loopback-only', report: reportPath, reportSha256: sha256(reportContent), bundle: bundlePath, bundleSha256: sha256(bundleContent), signatureVerified })}\n`,
  )
} catch (error) {
  acceptanceError = error
} finally {
  rmSync(scannerWork, { recursive: true, force: true })
  if (!cleaned) {
    const cleanup = run('pnpm', ['wp30:lab:down'], { allowFailure: true })
    persistRaw(
      'cleanup/failure-cleanup.log',
      `${cleanup.stdout}${cleanup.stderr}`,
    )
    rmSync(reportPath, { force: true })
    rmSync(reportPath.replace(/\.json$/, '.sha256'), { force: true })
    rmSync(bundlePath, { force: true })
    rmSync(bundlePath.replace(/\.json$/, '.sha256'), { force: true })
    if (cleanup.status !== 0 && !acceptanceError)
      acceptanceError = new Error(
        `WP30 local cleanup failed: ${cleanup.stderr || cleanup.stdout}`,
      )
  }
}

if (acceptanceError) throw acceptanceError
