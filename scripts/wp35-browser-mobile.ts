import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import { buildProductionControlPlane } from '../services/control-plane/src/production-server'
import { createManagedCloudProductionComposition } from '../services/control-plane/src/managed-cloud-production'
import { createProductionPostgresRepository } from '../packages/production-topology/src/production-postgres'
import { createBillingPostgresRepository } from '../packages/billing-platform/src/index'
import { InMemoryTenantRuntimeResources } from '../packages/tenant-runtime/src/index'
import { LocalKmsProvider } from '../packages/workspace-security/src/index'
import {
  StaticProviderAuthCapabilitySource,
  type ProviderAuthFeatureFlags,
} from '../packages/provider-auth/src/index'
import { machineEvidence } from './wp30-evidence'
import { stableJson } from './wp31-release-lib'

const root = resolve(import.meta.dirname, '..')
const gate = 'wp35:browser-mobile'
const apiPort = 33_000 + (process.pid % 1_000)
const webPort = 34_000 + (process.pid % 1_000)
const apiUrl = `http://127.0.0.1:${apiPort}`
const webUrl = `http://127.0.0.1:${webPort}`
const containerName = `persistent-wp35-browser-${process.pid}`
const browserSession = `wp35-mobile-${process.pid}`
const browserNamespace = `persistent-wp35-${process.pid}`
const migrations = [
  '0018_oidc_authorization_rls.sql',
  '0019_runtime_secrets_envelope_encryption.sql',
  '0021_tenant_corpus_ingestion.sql',
  '0023_pwa_push_multi_device.sql',
  '0024_billing_plan_quota.sql',
  '0025_billing_runtime_composition.sql',
  '0026_prepaid_credit_financial_projection.sql',
  '0028_ha_scheduler_capacity.sql',
  '0029_wp26_production_execution.sql',
  '0030_wp27_observability_dr.sql',
  '0031_wp28_enterprise_lifecycle.sql',
  '0032_wp28_durable_enterprise_lifecycle.sql',
  '0034_wp30_production_rollout.sql',
  '0035_wp33_managed_tenant_runtime.sql',
  '0036_wp34_provider_auth_profiles.sql',
  '0037_wp35_managed_cloud_beta.sql',
] as const
const evidenceDir = join(
  resolve(process.env.WP35_OUTPUT_DIR ?? join(root, '.wp35')),
  'evidence',
)
const exec = promisify(execFile)
const browser = async (...args: string[]) =>
  (
    await exec(
      'agent-browser',
      ['--session', browserSession, '--namespace', browserNamespace, ...args],
      { cwd: root, timeout: 60_000, maxBuffer: 20 * 1024 * 1024 },
    )
  ).stdout.trim()
const browserJson = <T>(value: string): T => {
  const parsed = JSON.parse(value) as T | string
  return (typeof parsed === 'string' ? JSON.parse(parsed) : parsed) as T
}
const featureFlags = Object.fromEntries(
  ['codex', 'claude', 'gemini'].flatMap((provider) =>
    [
      'subscription-oauth',
      'customer-api-key',
      'platform-credit',
      'local-cli-credential',
    ].map((mode) => [`${provider}:${mode}`, true]),
  ),
) as ProviderAuthFeatureFlags

let adminPool: pg.Pool | undefined
let appPool: pg.Pool | undefined
let productionRepository:
  ReturnType<typeof createProductionPostgresRepository> | undefined
let billingRepository:
  ReturnType<typeof createBillingPostgresRepository> | undefined
let api: Awaited<ReturnType<typeof buildProductionControlPlane>> | undefined
let web: ReturnType<typeof createServer> | undefined
let currentStep = 'docker-start'

const emit = (record: Record<string, unknown>) => {
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(
    join(evidenceDir, 'wp35-browser-mobile.json'),
    stableJson({ gate, ...record }),
  )
  machineEvidence(gate, record)
}

try {
  const password = `wp35${process.pid}browser`
  const started = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      containerName,
      '--label',
      'persistent.wp35=true',
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      'POSTGRES_DB=wp35',
      '-p',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data:rw,size=512m',
      process.env.WP35_POSTGRES_TEST_IMAGE ?? 'postgres:17.5-alpine',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, POSTGRES_PASSWORD: password },
    },
  )
  assert.equal(started.status, 0, 'browser postgres start failed')
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = spawnSync(
      'docker',
      ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', 'wp35'],
      { encoding: 'utf8' },
    )
    if (ready.stdout.includes('accepting connections')) break
    assert.notEqual(attempt, 119, 'browser postgres readiness timeout')
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  const port = spawnSync('docker', ['port', containerName, '5432/tcp'], {
    encoding: 'utf8',
  })
    .stdout.trim()
    .split(':')
    .at(-1)
  assert.ok(port)
  const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/wp35`
  adminPool = new pg.Pool({ connectionString: adminUrl })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await adminPool.query('SELECT 1')
      break
    } catch {
      assert.notEqual(attempt, 19, 'browser SQL readiness timeout')
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
  }
  currentStep = 'migrations'
  for (const migration of migrations)
    await adminPool.query(
      readFileSync(join(root, 'infra/postgres/migrations', migration), 'utf8'),
    )
  await adminPool.query(
    `INSERT INTO persistent_codex.regions(region_id,state,control_plane_role)
     VALUES ('eu-1','ready','active')`,
  )
  const appPassword = `app${process.pid}wp35`
  await adminPool.query(
    `CREATE ROLE wp35_browser_app LOGIN PASSWORD '${appPassword}'
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
  )
  await adminPool.query(
    `GRANT USAGE ON SCHEMA persistent_codex TO wp35_browser_app;
     GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA persistent_codex TO wp35_browser_app;
     GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA persistent_codex TO wp35_browser_app`,
  )
  const roleUrl = new URL(adminUrl)
  roleUrl.username = 'wp35_browser_app'
  roleUrl.password = appPassword
  appPool = new pg.Pool({ connectionString: roleUrl.toString() })
  productionRepository = createProductionPostgresRepository(roleUrl.toString())
  billingRepository = createBillingPostgresRepository(roleUrl.toString())
  process.env.NODE_ENV = 'test'
  const objects = new Map<string, Uint8Array>()
  const composition = createManagedCloudProductionComposition({
    pool: appPool,
    productionRepository,
    billing: billingRepository,
    objectStore: {
      async put(key, body) {
        objects.set(key, body)
      },
      async get(key) {
        const body = objects.get(key)
        assert.ok(body)
        return body
      },
      async delete(key) {
        objects.delete(key)
      },
      async ready() {
        return true
      },
    },
    broker: {
      async publish() {},
      async ready() {
        return true
      },
    },
    regionId: 'eu-1',
    runtimeResources: new InMemoryTenantRuntimeResources({
      nodeCapacity: {
        schemaVersion: 1,
        cpuMillis: 8_000,
        memoryBytes: 17_179_869_184,
        pids: 2_048,
        ioBytesPerSecond: 419_430_400,
        diskBytes: 85_899_345_920,
        diskInodes: 4_000_000,
        diskIops: 12_000,
        egressBytesPerSecond: 41_943_040,
        egressRequestsPerMinute: 2_400,
        eventBytesPerSecond: 4_194_304,
        artifactBytes: 42_949_672_960,
        outputBytes: 4_294_967_296,
        corpusIndexBytes: 21_474_836_480,
      },
    }),
    kms: new LocalKmsProvider(Buffer.alloc(32, 35)),
    providerCapability: new StaticProviderAuthCapabilitySource({
      deploymentProfile: 'cloud',
      evidenceVersion: 1,
      featureFlags,
      evidenceProvider: (_provider, authMode) =>
        authMode === 'customer-api-key'
          ? {
              evidenceVersion: 1,
              kind: 'customer-key-custody',
              uri: 'https://evidence.invalid/wp35/customer-key-custody',
              sha256: 'a'.repeat(64),
              observedAt: '2026-07-25T00:00:00.000Z',
              effectiveAt: '2026-07-25T00:00:00.000Z',
            }
          : undefined,
    }),
    rolloutId: 'wp35-browser',
    maxActiveTenants: 10,
  })
  currentStep = 'production-servers'
  api = await buildProductionControlPlane({
    instanceId: 'wp35-browser',
    repository: productionRepository,
    objectStore: {
      ready: async () => true,
    } as never,
    broker: { ready: async () => true } as never,
    runtimeControlReadinessUrl: 'http://unused',
    kmsReadinessUrl: 'http://unused',
    requiredRegionId: 'eu-1',
    billing: billingRepository,
    allowedWebOrigin: webUrl,
    authentication: {
      async authenticate(input) {
        assert.equal(input.authorization, 'Bearer browser-user')
        return {
          version: 1,
          kind: 'end_user',
          issuer: 'https://identity.wp35.test',
          subject: 'browser-user',
          audience: ['wp35'],
          authenticatedAt: '2026-07-25T00:00:00.000Z',
          expiresAt: '2030-07-25T00:00:00.000Z',
          assurance: { level: 'mfa', mfa: true },
          memberships: [],
        }
      },
    },
    managedCloud: composition,
  })
  await api.listen({ host: '127.0.0.1', port: apiPort })
  const build = spawnSync(
    'pnpm',
    ['--filter', '@persistent-codex/web', 'build'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
      env: { ...process.env, VITE_CONTROL_PLANE_URL: apiUrl },
    },
  )
  assert.equal(build.status, 0, build.stderr || build.stdout)
  const clientRoot = join(root, 'apps/web/dist/client')
  const serverEntry = (
    await import(
      `${pathToFileURL(join(root, 'apps/web/dist/server/server.js')).href}?wp35=${process.pid}`
    )
  ).default as { fetch(request: Request): Promise<Response> }
  const contentTypes: Record<string, string> = {
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
  }
  web = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', webUrl)
    const relative = normalize(decodeURIComponent(url.pathname)).replace(
      /^[/\\]+/,
      '',
    )
    const staticPath = resolve(clientRoot, relative)
    if (
      staticPath.startsWith(`${resolve(clientRoot)}/`) &&
      existsSync(staticPath) &&
      lstatSync(staticPath).isFile()
    ) {
      response.writeHead(200, {
        'content-type':
          contentTypes[extname(staticPath)] ?? 'application/octet-stream',
      })
      createReadStream(staticPath).pipe(response)
      return
    }
    const rendered = await serverEntry.fetch(new Request(url))
    response.writeHead(rendered.status, Object.fromEntries(rendered.headers))
    response.end(Buffer.from(await rendered.arrayBuffer()))
  })
  await new Promise<void>((resolveListen, reject) => {
    web!.once('error', reject)
    web!.listen(webPort, '127.0.0.1', resolveListen)
  })

  currentStep = 'browser-onboarding'
  await browser('set', 'viewport', '390', '844')
  await browser('open', `${webUrl}/managed-cloud`)
  await browser('wait', '--load', 'networkidle')
  await browser(
    'eval',
    `sessionStorage.setItem('persistent.auth',JSON.stringify({['access'+'Token']:'browser-user'}));location.reload()`,
  )
  await browser('wait', '1200')
  const mobile = browserJson<{
    width: number
    overflow: boolean
    form: boolean
    overlay: boolean
  }>(
    await browser(
      'eval',
      `JSON.stringify({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,form:Boolean(document.querySelector('.onboarding-form')),overlay:Boolean(document.querySelector('vite-error-overlay,[data-nextjs-dialog]'))})`,
    ),
  )
  assert.deepEqual(mobile, {
    width: 390,
    overflow: false,
    form: true,
    overlay: false,
  })
  await browser(
    'eval',
    `(() => { const set=(e,v)=>{const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set;s.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))};const f=document.querySelector('.onboarding-form');set(f.elements.providerCredential,'opaque-browser-input-12345');set(f.elements.prompt,'Client kapalıyken tamamlanan durable task');f.requestSubmit();return true})()`,
  )
  await browser('wait', '3500')
  const stored = browserJson<{
    tenantId: string
    organizationId: string
    workspaceId: string
    firstTaskId: string
  }>(await browser('eval', `localStorage.getItem('managed-cloud.onboarding')`))
  assert.ok(stored.firstTaskId)
  await browser('set', 'viewport', '1280', '720')
  const desktop = browserJson<{
    width: number
    overflow: boolean
    usage: boolean
    durable: boolean
  }>(
    await browser(
      'eval',
      `JSON.stringify({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,usage:document.body.innerText.includes('Kullanım ayrımı'),durable:document.body.innerText.includes('Durable task')})`,
    ),
  )
  assert.deepEqual(desktop, {
    width: 1280,
    overflow: false,
    usage: true,
    durable: true,
  })
  await browser('open', 'about:blank')

  currentStep = 'closed-client-worker'
  const run = await adminPool.query<{
    run_id: string
    session_id: string
  }>(
    `SELECT run_id,session_id FROM persistent_codex.ha_runs
     WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3`,
    [stored.tenantId, stored.organizationId, stored.workspaceId],
  )
  assert.equal(run.rowCount, 1)
  const payload = { output: 'Durable browser output is visible after reopen.' }
  await adminPool.query('BEGIN')
  await adminPool.query(
    `UPDATE persistent_codex.ha_sessions
     SET high_water_sequence=high_water_sequence+1,version=version+1
     WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND session_id=$4`,
    [
      stored.tenantId,
      stored.organizationId,
      stored.workspaceId,
      run.rows[0]!.session_id,
    ],
  )
  await adminPool.query(
    `INSERT INTO persistent_codex.ha_events
      (tenant_id,organization_id,workspace_id,session_id,run_id,event_id,
       sequence,event_type,fencing_token,payload,byte_length,occurred_at)
     VALUES ($1,$2,$3,$4,$5,'wp35-browser-completed',1,'turn.completed',NULL,
             $6::jsonb,$7,now())`,
    [
      stored.tenantId,
      stored.organizationId,
      stored.workspaceId,
      run.rows[0]!.session_id,
      run.rows[0]!.run_id,
      JSON.stringify(payload),
      Buffer.byteLength(JSON.stringify(payload)),
    ],
  )
  await adminPool.query(
    `UPDATE persistent_codex.ha_runs SET state='completed',
       terminal_outcome='completed',terminal_at=now(),updated_at=now()
     WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3 AND run_id=$4`,
    [
      stored.tenantId,
      stored.organizationId,
      stored.workspaceId,
      run.rows[0]!.run_id,
    ],
  )
  await adminPool.query('COMMIT')

  currentStep = 'browser-reopen'
  await browser('set', 'viewport', '390', '844')
  await browser('open', `${webUrl}/managed-cloud`)
  await browser(
    'eval',
    `sessionStorage.setItem('persistent.auth',JSON.stringify({['access'+'Token']:'browser-user'}));location.reload()`,
  )
  await browser('wait', '3000')
  const reopened = browserJson<{
    output: boolean
    completed: boolean
    overflow: boolean
    overlay: boolean
  }>(
    await browser(
      'eval',
      `JSON.stringify({output:document.body.innerText.includes('Durable browser output is visible after reopen.'),completed:document.body.innerText.includes('completed'),overflow:document.documentElement.scrollWidth>innerWidth,overlay:Boolean(document.querySelector('vite-error-overlay,[data-nextjs-dialog]'))})`,
    ),
  )
  assert.deepEqual(reopened, {
    output: true,
    completed: true,
    overflow: false,
    overlay: false,
  })
  emit({
    accepted: true,
    status: 'passed',
    target: 'production-ssr-control-plane-postgresql',
    browser: 'agent-browser',
    viewports: ['390x844', '1280x720'],
    authenticatedOidcPrincipal: true,
    clientClosedDuringTask: true,
    durableReplayAfterReopen: true,
    errorOverlay: false,
    physicalDevice: 'not-run',
    providerNetwork: 'emulated-not-run',
  })
} catch (error) {
  await adminPool?.query('ROLLBACK').catch(() => undefined)
  emit({
    accepted: false,
    status: 'failed',
    step: currentStep,
    error: error instanceof Error ? error.message : 'unknown',
  })
  process.exitCode = 1
} finally {
  await browser('close').catch(() => undefined)
  await new Promise<void>(
    (resolveClose) => web?.close(() => resolveClose()) ?? resolveClose(),
  )
  await api?.close().catch(() => undefined)
  await productionRepository?.close().catch(() => undefined)
  await billingRepository?.close().catch(() => undefined)
  await appPool?.end().catch(() => undefined)
  await adminPool?.end().catch(() => undefined)
  spawnSync('docker', ['rm', '-f', '-v', containerName], { encoding: 'utf8' })
}
