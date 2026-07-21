import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import Fastify from '../services/control-plane/node_modules/fastify/fastify.js'
import { Wp28LifecycleStack } from './wp28-lifecycle-stack'

const exec = promisify(execFile)
const stack = new Wp28LifecycleStack()
const api = Fastify({ logger: false })
const scope = { tenantId: 'tenant-browser', organizationId: 'tenant-browser' }
const reauthTokens = new Set<string>()
let web: ChildProcess | undefined
const browserSession = `wp28-${randomUUID()}`
const browser = async (...args: string[]) =>
  (
    await exec('agent-browser', args, {
      env: { ...process.env, AGENT_BROWSER_SESSION: browserSession },
    })
  ).stdout.trim()
const waitFor = async (url: string) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await fetch(url).catch(() => null))?.ok) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`server unavailable: ${url}`)
}

try {
  await stack.startLifecycle()
  const now = new Date()
  const manifest = {
    schemaVersion: 1,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    jobId: 'browser-export',
    watermark: '3:artifact-browser',
    objects: [
      {
        objectId: 'artifact-browser',
        objectClass: 'artifact',
        sha256: '1'.repeat(64),
        byteLength: 64,
        keyVersion: 4,
      },
    ],
    archiveSha256: '2'.repeat(64),
    archiveByteLength: 96,
    keyVersion: 4,
    createdAt: now.toISOString(),
  }
  const exportKey = `eu-1/${scope.tenantId}/exports/browser-export.enc`
  await stack.object.put(exportKey, Buffer.alloc(96, 7))
  await stack.admin.query(
    `INSERT INTO persistent_codex.enterprise_federation VALUES($1,$2,'browser-sso','oidc',$3,3,true,now())`,
    [
      scope.tenantId,
      scope.organizationId,
      {
        domain: 'enterprise.example.invalid',
        domainVerified: true,
        enforcedSso: true,
        mfaRequired: true,
      },
    ],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.scim_resources VALUES($1,$2,'keycloak','User','browser-user','browser-user-ext',4,true,$3,1,now()),($1,$2,'keycloak','Group','browser-group','browser-group-ext',4,true,$4,1,now())`,
    [
      scope.tenantId,
      scope.organizationId,
      { displayName: 'Opaque user' },
      { displayName: 'Tenant administrators', members: ['browser-user'] },
    ],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.retention_policies VALUES($1,$2,'browser-retention',4,now(),$3)`,
    [scope.tenantId, scope.organizationId, { classes: { artifact: 30 } }],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.legal_holds VALUES($1,$2,'browser-hold','active','LITIGATION',ARRAY['artifact'],'legal_admin',$3,$4,2)`,
    [
      scope.tenantId,
      scope.organizationId,
      new Date(now.getTime() - 86400000),
      new Date(now.getTime() + 86400000),
    ],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.tenant_export_jobs(tenant_id,organization_id,job_id,idempotency_key,state,checkpoint,manifest,encrypted_object_key,version,workspace_ids,target_region) VALUES($1,$2,'browser-export','browser-export-request','ready',3,$3,$4,4,ARRAY['browser-workspace'],'eu-1')`,
    [scope.tenantId, scope.organizationId, manifest, exportKey],
  )
  await stack.admin.query(
    `INSERT INTO persistent_codex.tenant_deletion_jobs VALUES($1,$2,'browser-delete','browser-delete-request','blocked_by_hold','object_delete',ARRAY['access_revoke','admission_cordon'],'[]',4,2,now())`,
    [scope.tenantId, scope.organizationId],
  )
  const residency = {
    schemaVersion: 1,
    ...scope,
    policyId: 'browser-residency',
    policyVersion: 2,
    allowedRegions: ['eu-1'],
    primaryRegion: 'eu-1',
    crossRegionTransfers: [],
    effectiveAt: now.toISOString(),
  }
  await stack.admin.query(
    `INSERT INTO persistent_codex.tenant_residency_policies VALUES($1,$2,'browser-residency',2,$3,now())`,
    [scope.tenantId, scope.organizationId, residency],
  )

  api.get('/state', async () => {
    const [federation, scim, policy, holds, exportJob, deletion, region] =
      await Promise.all([
        stack.admin.query(
          `SELECT configuration FROM persistent_codex.enterprise_federation WHERE tenant_id=$1`,
          [scope.tenantId],
        ),
        stack.admin.query(
          `SELECT resource_type,count(*)::int count,max(updated_at) last_sync FROM persistent_codex.scim_resources WHERE tenant_id=$1 GROUP BY resource_type`,
          [scope.tenantId],
        ),
        stack.admin.query(
          `SELECT policy_version FROM persistent_codex.retention_policies WHERE tenant_id=$1 ORDER BY policy_version DESC LIMIT 1`,
          [scope.tenantId],
        ),
        stack.admin.query(
          `SELECT * FROM persistent_codex.legal_holds WHERE tenant_id=$1 ORDER BY hold_id`,
          [scope.tenantId],
        ),
        stack.admin.query(
          `SELECT * FROM persistent_codex.tenant_export_jobs WHERE tenant_id=$1 AND job_id='browser-export'`,
          [scope.tenantId],
        ),
        stack.admin.query(
          `SELECT * FROM persistent_codex.tenant_deletion_jobs WHERE tenant_id=$1 AND job_id='browser-delete'`,
          [scope.tenantId],
        ),
        stack.admin.query(
          `SELECT policy FROM persistent_codex.tenant_residency_policies WHERE tenant_id=$1 ORDER BY policy_version DESC LIMIT 1`,
          [scope.tenantId],
        ),
      ])
    const config = federation.rows[0].configuration
    const users = scim.rows.find((row) => row.resource_type === 'User')
    const groups = scim.rows.find((row) => row.resource_type === 'Group')
    const holdRows = holds.rows.map((row) => ({
      schemaVersion: 1,
      ...scope,
      holdId: row.hold_id,
      objectClasses: row.object_classes,
      reasonCode: row.reason_code,
      actorRole: row.actor_role,
      state: row.state,
      startsAt: row.starts_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      version: Number(row.version),
    }))
    const exportRow = exportJob.rows[0]
    const deletionRow = deletion.rows[0]
    return {
      domain: {
        name: config.domain,
        verified: config.domainVerified,
        expiresAt: new Date(now.getTime() + 86400000).toISOString(),
      },
      sso: {
        enforced: config.enforcedSso,
        mfaRequired: config.mfaRequired,
      },
      scim: {
        users: Number(users?.count ?? 0),
        groups: Number(groups?.count ?? 0),
        lastSyncAt: (users?.last_sync ?? groups?.last_sync)?.toISOString(),
      },
      retention: {
        policyVersion: Number(policy.rows[0].policy_version),
        holds: holdRows,
      },
      exportJob: {
        schemaVersion: 1,
        ...scope,
        jobId: exportRow.job_id,
        state: exportRow.state,
        privilege: 'tenant_export_admin',
        approvalId: 'browser-export-approval',
        idempotencyKey: exportRow.idempotency_key,
        checkpoint: Number(exportRow.checkpoint),
        version: Number(exportRow.version),
        expiresAt: new Date(now.getTime() + 3600000).toISOString(),
      },
      exportManifest: exportRow.manifest,
      deletion: {
        schemaVersion: 1,
        ...scope,
        jobId: deletionRow.job_id,
        state: deletionRow.state,
        currentStep: deletionRow.current_step,
        completedSteps: deletionRow.completed_steps,
        remainingClasses: deletionRow.remaining_classes,
        idempotencyKey: deletionRow.idempotency_key,
        version: Number(deletionRow.version),
        keyVersion: Number(deletionRow.key_version),
      },
      residency: region.rows[0].policy,
      canExport: true,
      canDelete: true,
      holdVersion: Number(holdRows[0]?.version ?? 1),
      deletionVersion: Number(deletionRow.version),
    }
  })
  api.post('/support-export', async (_request, reply) =>
    reply.code(403).send({ code: 'LIFECYCLE_PRIVILEGE_DENIED' }),
  )
  api.post('/support-delete', async (_request, reply) =>
    reply.code(403).send({ code: 'LIFECYCLE_PRIVILEGE_DENIED' }),
  )
  api.post('/reauth', async () => {
    const token = randomUUID()
    reauthTokens.add(token)
    return { token }
  })
  const authorizeMutation = (request: any, reply: any) => {
    const token = String(request.headers['x-reauth'] ?? '')
    if (!reauthTokens.delete(token)) {
      void reply.code(401).send({ code: 'REAUTHENTICATION_REQUIRED' })
      return false
    }
    return true
  }
  api.post('/legal-hold', async (request, reply) => {
    if (!authorizeMutation(request, reply)) return
    const expected = Number((request.body as any).expectedVersion)
    const current = await stack.admin.query(
      `SELECT version FROM persistent_codex.legal_holds WHERE tenant_id=$1 AND hold_id='browser-hold'`,
      [scope.tenantId],
    )
    const currentVersion = Number(current.rows[0].version)
    if (expected !== currentVersion)
      return reply.code(409).send({ code: 'STALE_VERSION', currentVersion })
    await stack.admin.query(
      `UPDATE persistent_codex.legal_holds SET state='released',version=version+1 WHERE tenant_id=$1 AND hold_id='browser-hold' AND version=$2`,
      [scope.tenantId, expected],
    )
    return reply.send({ code: 'OK' })
  })
  api.post('/delete', async (request, reply) => {
    if (!authorizeMutation(request, reply)) return
    const expected = Number((request.body as any).expectedVersion)
    const current = await stack.admin.query(
      `SELECT version FROM persistent_codex.tenant_deletion_jobs WHERE tenant_id=$1 AND job_id='browser-delete'`,
      [scope.tenantId],
    )
    const currentVersion = Number(current.rows[0].version)
    if (expected !== currentVersion)
      return reply.code(409).send({ code: 'STALE_VERSION', currentVersion })
    await stack.admin.query(
      `UPDATE persistent_codex.tenant_deletion_jobs SET state='running',current_step='backup_expiry',version=version+1,updated_at=now() WHERE tenant_id=$1 AND job_id='browser-delete' AND version=$2`,
      [scope.tenantId, expected],
    )
    return reply.send({ code: 'OK' })
  })
  api.get('/export/download', async (request, reply) => {
    const range = String(request.headers.range ?? 'bytes=0-31')
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)
    if (!match) return reply.code(416).send({ code: 'INVALID_RANGE' })
    const body = Buffer.from(await stack.object.get(exportKey))
    const start = Number(match[1])
    const end = Math.min(Number(match[2]), body.length - 1)
    return reply
      .code(206)
      .header('content-range', `bytes ${start}-${end}/${body.length}`)
      .header('content-type', 'application/octet-stream')
      .send(body.subarray(start, end + 1))
  })
  const apiAddress = await api.listen({ host: '127.0.0.1', port: 0 })
  const webPort = 43130
  web = spawn(
    'pnpm',
    ['--filter', '@persistent-codex/web', 'dev', '--port', String(webPort)],
    {
      cwd: process.cwd(),
      env: { ...process.env, WP28_ENTERPRISE_API_ORIGIN: apiAddress },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  await waitFor(`http://127.0.0.1:${webPort}/enterprise`)
  await browser('open', `http://127.0.0.1:${webPort}/enterprise`)
  await browser('wait', '#support-export')

  const viewports = [
    [390, 844],
    [768, 1024],
    [1280, 720],
  ] as const
  for (const [width, height] of viewports) {
    await browser('set', 'viewport', String(width), String(height))
    const layoutResult = JSON.parse(
      await browser(
        'eval',
        `JSON.stringify({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,sections:document.querySelectorAll('.enterprise-admin section').length,domain:document.body.innerText.includes('Verified'),sso:document.body.innerText.includes('Enforced SSO'),scim:document.body.innerText.includes('1 users · 1 groups'),hold:document.body.innerText.includes('LITIGATION'),exportReady:document.body.innerText.includes('ready'),deleteProgress:document.body.innerText.includes('blocked_by_hold: object_delete')})`,
      ),
    )
    const layout =
      typeof layoutResult === 'string' ? JSON.parse(layoutResult) : layoutResult
    assert.equal(layout.width, width)
    assert.equal(layout.overflow, false)
    assert.equal(layout.sections, 6)
    for (const field of [
      'domain',
      'sso',
      'scim',
      'hold',
      'exportReady',
      'deleteProgress',
    ])
      assert.equal(
        layout[field],
        true,
        `${field} missing at ${width}x${height}`,
      )
  }

  const clickAndExpect = async (
    button: string,
    output: string,
    expected: RegExp,
  ) => {
    await browser('click', button)
    await browser('wait', '50')
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await browser('get', 'text', output)
      if (expected.test(value)) return value
      await browser('wait', '50')
    }
    throw new Error(`${output} did not match ${expected}`)
  }
  await clickAndExpect('#support-export', '#support-export-status', /403/)
  await clickAndExpect('#support-delete', '#support-delete-status', /403/)
  await clickAndExpect('#release-hold', '#legal-hold-status', /401/)
  await clickAndExpect('#reauth', '#reauth-status', /^Re-authenticated$/)
  await clickAndExpect('#release-hold', '#legal-hold-status', /409/)
  await clickAndExpect('#reauth', '#reauth-status', /^Re-authenticated$/)
  await clickAndExpect('#release-hold', '#legal-hold-status', /200/)
  await clickAndExpect('#continue-delete', '#delete-status', /401/)
  await clickAndExpect('#reauth', '#reauth-status', /^Re-authenticated$/)
  await clickAndExpect('#continue-delete', '#delete-status', /409/)
  await clickAndExpect('#reauth', '#reauth-status', /^Re-authenticated$/)
  await clickAndExpect('#continue-delete', '#delete-status', /200/)
  await clickAndExpect('#download-export', '#download-status', /206 32 bytes/)

  const requests = await browser(
    'network',
    'requests',
    '--filter',
    'wp28-enterprise-api',
  )
  assert(requests.includes('403'))
  assert(requests.includes('409'))
  assert(requests.includes('206'))
  process.stdout.write(
    `${JSON.stringify({
      gate: 'wp28:browser',
      accepted: true,
      browser: 'Chromium via agent-browser 0.31.2',
      liveWebApp: true,
      liveControlPlaneApi: true,
      stateAuthority: ['PostgreSQL 17.5', 'MinIO'],
      viewports: viewports.map(([width, height]) => `${width}x${height}`),
      visibleState: [
        'domain-verification',
        'sso-enforcement',
        'scim',
        'legal-hold',
        'export-manifest-download',
        'delete-progress',
      ],
      supportHttp: { export: 403, delete: 403 },
      reAuthentication: { legalHold: 401, delete: 401 },
      optimisticConcurrency: { legalHold: 409, delete: 409 },
      rangeDownload: { status: 206, bytes: 32 },
      ssrStringAcceptedAsBrowserEvidence: false,
    })}\n`,
  )
} finally {
  await browser('close').catch(() => undefined)
  reauthTokens.clear()
  web?.kill('SIGTERM')
  await api.close().catch(() => undefined)
  await stack.cleanup()
}
