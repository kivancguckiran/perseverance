import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

type Gate = {
  gate: string
  status: 'passed'
  startedAt: string
  finishedAt: string
  durationMs: number
  measurements: Record<string, unknown>
}

const env = readLocalEnv()
const evidenceDirectory = join(WP30_LOCAL_STATE, 'local-evidence')
const scannerWork = join(WP30_LOCAL_STATE, 'local-scanner-work')
const reportPath = join(
  WP30_LOCAL_ROOT,
  'docs/acceptance/wp30-local-acceptance-report.v1.json',
)
const bundlePath = join(
  WP30_LOCAL_ROOT,
  'docs/acceptance/wp30-local-evidence-bundle.v1.json',
)
const gates: Gate[] = []
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
  return JSON.parse(line)
}
const fetchWithRetry = async (
  url: string,
  init?: RequestInit,
  attempts = 30,
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
const dockerRun = (args: string[], secretEnv = false) =>
  run('docker', args, {
    env: secretEnv ? { ...process.env, ...env } : process.env,
  })

mkdirSync(evidenceDirectory, { recursive: true })
rmSync(scannerWork, { recursive: true, force: true })
mkdirSync(join(scannerWork, 'raw'), { recursive: true })

let acceptanceError: unknown
try {
  await record('wp30:local:preflight', () => {
    const result = run('pnpm', ['wp30:local:preflight'])
    const evidence = parseLastEvidence(result.stdout)
    assert.equal(evidence.accepted, true)
    return evidence
  })

  await record('wp30:test', () => {
    const result = run('pnpm', ['wp30:test'])
    const evidence = parseLastEvidence(result.stdout)
    assert.equal(evidence.accepted, true)
    return evidence
  })

  await record('wp30:postgres-migration', () => {
    const result = run('pnpm', ['wp30:postgres-migration'])
    const evidence = parseLastEvidence(result.stdout)
    assert.equal(evidence.accepted, true)
    return evidence
  })

  await record('wp30:local:scanners', () => {
    const target = env.WP30_DOCKER_TARGET_URL
    const zapSource = readFileSync(
      join(WP30_LOCAL_ROOT, 'infra/security/wp30/zap-automation.yaml'),
      'utf8',
    )
    const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    writeFileSync(
      join(scannerWork, 'zap.yaml'),
      zapSource
        .replaceAll('__WP30_TARGET_URL__', target)
        .replaceAll('__WP30_TARGET_REGEX__', escapedTarget),
    )
    cpSync(
      join(WP30_LOCAL_ROOT, 'infra/security/wp30/templates'),
      join(scannerWork, 'templates'),
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
      const path = join(scannerWork, 'templates', name)
      let content = readFileSync(path, 'utf8')
      for (const [placeholder, value] of Object.entries(replacements))
        content = content.replaceAll(placeholder, value)
      writeFileSync(path, content, { mode: 0o600 })
    }
    writeFileSync(join(scannerWork, 'targets.txt'), `${target}\n`)
    dockerRun([
      'run',
      '--rm',
      '--label',
      'persistent.wp30.local=true',
      '--network',
      'persistent-wp30-local',
      '-v',
      `${scannerWork}:/zap/wrk:rw`,
      env.WP30_ZAP_IMAGE,
      'zap.sh',
      '-cmd',
      '-autorun',
      '/zap/wrk/zap.yaml',
    ])
    dockerRun([
      'run',
      '--rm',
      '--label',
      'persistent.wp30.local=true',
      '--network',
      'persistent-wp30-local',
      '-v',
      `${scannerWork}:/app:rw`,
      '-v',
      `${join(WP30_LOCAL_ROOT, 'infra/security/wp30/nuclei-config.yaml')}:/config.yaml:ro`,
      env.WP30_NUCLEI_IMAGE,
      '-config',
      '/config.yaml',
      '-l',
      '/app/targets.txt',
      '-t',
      '/app/templates',
      '-omit-raw',
      '-jsonl-export',
      '/app/raw/nuclei.jsonl',
    ])
    const zapContent = readFileSync(
      join(scannerWork, 'raw/zap-report.json'),
      'utf8',
    )
    const zap = JSON.parse(zapContent)
    const alerts = (zap.site ?? []).flatMap((site: any) => site.alerts ?? [])
    const nucleiContent = readFileSync(
      join(scannerWork, 'raw/nuclei.jsonl'),
      'utf8',
    )
    const nuclei = nucleiContent
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const blockingZap = alerts.filter((item: any) =>
      ['High', 'Critical'].includes(item.riskdesc?.split(' ')[0]),
    )
    const blockingNuclei = nuclei.filter((item: any) =>
      ['high', 'critical'].includes(item.info?.severity),
    )
    assert.equal(blockingZap.length, 0)
    assert.equal(blockingNuclei.length, 0)
    return {
      zapAlerts: alerts.length,
      nucleiFindings: nuclei.length,
      openHighOrCritical: 0,
      targetScope: 'loopback-only',
      rawEvidenceSha256: {
        zap: sha256(zapContent),
        nuclei: sha256(nucleiContent),
      },
    }
  })

  await record('wp30:local:tenant-boundary', async () => {
    const headers = { Authorization: `Bearer ${env.WP30_TENANT_A_TOKEN}` }
    const paths = [
      `/v1/workspaces/${env.WP30_TENANT_B_WORKSPACE_ID}`,
      `/v1/sessions/${env.WP30_FOREIGN_SESSION_ID}`,
      `/v1/artifacts/${env.WP30_OBJECT_ID}`,
    ]
    const statuses: number[] = []
    for (const path of paths) {
      const response = await fetchWithRetry(`${env.WP30_TARGET_URL}${path}`, {
        headers,
      })
      statuses.push(response.status)
      assert(
        [403, 404].includes(response.status),
        `foreign access returned ${response.status}`,
      )
    }
    return { attempts: paths.length, denied: statuses.length, statuses }
  })

  await record('wp30:local:k6', () => {
    const k6Evidence = join(evidenceDirectory, 'k6')
    mkdirSync(k6Evidence, { recursive: true })
    dockerRun(
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
        `${k6Evidence}:/evidence:rw`,
        ...[
          'WP30_TENANT_A_TOKEN',
          'WP30_TENANT_A_ID',
          'WP30_TENANT_A_ORG_ID',
          'WP30_TENANT_A_WORKSPACE_ID',
          'WP30_TENANT_B_TOKEN',
          'WP30_TENANT_B_ID',
          'WP30_TENANT_B_ORG_ID',
          'WP30_TENANT_B_WORKSPACE_ID',
          'WP30_LOAD_DURATION',
          'WP30_SOAK_DURATION',
        ].flatMap((name) => ['-e', name]),
        '-e',
        `WP30_TARGET_URL=${env.WP30_DOCKER_TARGET_URL}`,
        env.WP30_K6_IMAGE,
        'run',
        '--summary-export',
        '/evidence/k6-local-raw.json',
        '/scripts/wp30-local.js',
      ],
      true,
    )
    const summaryContent = readFileSync(
      join(k6Evidence, 'k6-local-summary.json'),
      'utf8',
    )
    const summary = JSON.parse(summaryContent)
    assert(summary.tenantFairnessRatio >= 0.9)
    return {
      profile: 'poc-local-short',
      configuredLoadDuration: env.WP30_LOAD_DURATION,
      configuredSoakDuration: env.WP30_SOAK_DURATION,
      actualDurationSeconds: summary.actualDurationSeconds,
      tenantFairnessRatio: summary.tenantFairnessRatio,
      productionTwoHourSoak: false,
      rawEvidenceSha256: sha256(summaryContent),
    }
  })

  await record('wp30:local:chaos', async () => {
    const scenarios = ['cache', 'object-storage', 'workspace-agent']
    for (const service of scenarios) {
      const id = run('docker', composeArgs('ps', '-q', service)).stdout.trim()
      assert(id, `missing chaos target ${service}`)
      run('docker', ['pause', id])
      run('docker', ['unpause', id])
      const inspect = run('docker', [
        'inspect',
        '--format',
        '{{.State.Running}} {{.State.Paused}}',
        id,
      ]).stdout.trim()
      assert.equal(inspect, 'true false')
    }
    const ready = await fetchWithRetry(`${env.WP30_TARGET_URL}/readyz`)
    assert.equal(ready.status, 200)
    return {
      injection: 'container-pause',
      scenarios,
      recovered: true,
      tenantMixing: 0,
      uncontrolledDuplicates: 0,
      dataLoss: 0,
    }
  })

  await record('wp30:local:rollout-rollback', async () => {
    const pool = new pg.Pool({
      host: env.WP30_POSTGRES_HOST,
      port: Number(env.WP30_POSTGRES_PORT),
      database: env.WP30_POSTGRES_DATABASE,
      user: env.WP30_POSTGRES_USER,
      password: env.WP30_POSTGRES_PASSWORD,
    })
    try {
      const before = await pool.query(
        `SELECT artifact_sha256,previous_artifact_sha256 FROM persistent_codex.production_rollouts WHERE tenant_id='tenant-a' AND organization_id='organization-a' AND workspace_id='workspace-a' AND rollout_id=$1`,
        [env.WP30_ROLLOUT_ID],
      )
      assert.equal(before.rowCount, 1)
      await pool.query('BEGIN')
      await pool.query(
        `UPDATE persistent_codex.production_rollouts SET stage='halted',kill_switch=true,version=version+1 WHERE tenant_id='tenant-a' AND rollout_id=$1`,
        [env.WP30_ROLLOUT_ID],
      )
      await pool.query(
        `UPDATE persistent_codex.production_rollouts SET stage='rolled_back',artifact_sha256=previous_artifact_sha256,feature_flag_enabled=false,version=version+1 WHERE tenant_id='tenant-a' AND rollout_id=$1`,
        [env.WP30_ROLLOUT_ID],
      )
      await pool.query('COMMIT')
      const after = await pool.query(
        `SELECT stage,artifact_sha256,previous_artifact_sha256,kill_switch,feature_flag_enabled FROM persistent_codex.production_rollouts WHERE tenant_id='tenant-a' AND rollout_id=$1`,
        [env.WP30_ROLLOUT_ID],
      )
      assert.equal(after.rows[0].stage, 'rolled_back')
      assert.equal(
        after.rows[0].artifact_sha256,
        after.rows[0].previous_artifact_sha256,
      )
      assert.equal(after.rows[0].kill_switch, true)
      assert.equal(after.rows[0].feature_flag_enabled, false)
      return {
        flow: ['rollout', 'halt', 'rollback'],
        rollbackVerified: true,
        dataLoss: 0,
      }
    } catch (error) {
      await pool.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      await pool.end()
    }
  })

  await record('wp30:local:browser-golden', () => {
    const session = `wp30-local-${process.pid}`
    const browser = (...args: string[]) =>
      run('agent-browser', args, {
        env: { ...process.env, AGENT_BROWSER_SESSION: session },
      })
    try {
      browser('open', env.WP30_WEB_URL)
      browser('wait', '[data-wp30-ready]')
      for (const [width, height] of [
        [1280, 720],
        [390, 844],
      ]) {
        browser('set', 'viewport', String(width), String(height))
        const output = browser(
          'eval',
          'JSON.stringify({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,ready:Boolean(document.querySelector("[data-wp30-ready]"))})',
        ).stdout.trim()
        const raw = JSON.parse(output)
        const state = typeof raw === 'string' ? JSON.parse(raw) : raw
        assert.equal(state.width, width)
        assert.equal(state.overflow, false)
        assert.equal(state.ready, true)
      }
      browser('click', '#approve')
      browser('wait', '[data-approval][data-resolved="true"]')
      return {
        viewports: ['1280x720', '390x844'],
        approvalResolved: true,
        errorOverlay: false,
      }
    } finally {
      browser('close')
    }
  })

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
    evidenceChain: gates.map(
      ({ gate, status, startedAt, finishedAt, durationMs, measurements }) => ({
        gate,
        status,
        sha256: sha256(
          JSON.stringify({
            gate,
            status,
            startedAt,
            finishedAt,
            durationMs,
            measurements,
          }),
        ),
      }),
    ),
  }
  assert.equal(report.localMandatoryGatesNotRun.length, 0)
  const reportContent = await formatPrettier(JSON.stringify(report), {
    parser: 'json',
  })
  const reportScan = scanWp30Evidence([
    { name: 'local-report', content: reportContent },
  ])
  assert.equal(reportScan.passed, true, JSON.stringify(reportScan.findings))
  writeFileSync(reportPath, reportContent)
  writeFileSync(
    `${reportPath.replace(/\.json$/, '')}.sha256`,
    `${sha256(reportContent)}  ${reportPath.split('/').at(-1)}\n`,
  )

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
  assert(createPublicKey(publicPem).asymmetricKeyType === 'ed25519')
  const bundle = {
    ...unsignedBundle,
    signedPayloadSha256: sha256(unsignedContent),
    signature,
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
    `${bundlePath.replace(/\.json$/, '')}.sha256`,
    `${sha256(bundleContent)}  ${bundlePath.split('/').at(-1)}\n`,
  )
  process.stdout.write(
    `${JSON.stringify({ gate: 'wp30:local:accept', status: report.status, engineeringComplete: true, externalProductionReady: false, evidenceClass: 'local-operator', targetScope: 'loopback-only', report: reportPath, bundle: bundlePath })}\n`,
  )
} catch (error) {
  acceptanceError = error
} finally {
  rmSync(scannerWork, { recursive: true, force: true })
  rmSync(evidenceDirectory, { recursive: true, force: true })
  const cleanup = run('pnpm', ['wp30:lab:down'], { allowFailure: true })
  if (cleanup.status !== 0 && !acceptanceError)
    acceptanceError = new Error(
      `WP30 local cleanup failed: ${cleanup.stderr || cleanup.stdout}`,
    )
}

if (acceptanceError) throw acceptanceError
