import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync, type JsonWebKey } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { createBillingPostgresRepository } from '../packages/billing-platform/src/index'
import { S3CompatibleObjectStore } from '../packages/production-topology/src/durable-dependencies'
import {
  WP30_LOCAL_ENV,
  WP30_LOCAL_LABEL,
  WP30_LOCAL_ROOT,
  WP30_LOCAL_STATE,
  assertAbsoluteCodex,
  composeArgs,
  randomSecret,
  readLocalEnv,
  readPinnedImages,
  redactInventoryName,
  run,
  sha256,
} from './wp30-local'
import { machineEvidence } from './wp30-evidence'

const sourceCommit = run('git', ['rev-parse', 'HEAD']).stdout.trim()
const codexBin = join(WP30_LOCAL_ROOT, 'node_modules/.bin/codex')

const jwt = (
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  subject: string,
) => {
  const now = Math.floor(Date.now() / 1_000)
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'RS256', kid: 'wp30-local', typ: 'JWT' })}.${encode({ iss: 'http://oidc-stub:3303', aud: 'persistent-codex-wp30-local', sub: subject, iat: now, auth_time: now, exp: now + 4 * 60 * 60, amr: ['pwd', 'mfa'] })}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`
}

const writeEnvironment = () => {
  mkdirSync(WP30_LOCAL_STATE, { recursive: true, mode: 0o700 })
  if (!existsSync(WP30_LOCAL_ENV)) {
    const password = randomSecret()
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey
    publicJwk.kid = 'wp30-local'
    publicJwk.use = 'sig'
    publicJwk.alg = 'RS256'
    const values = {
      ...readPinnedImages(),
      WP30_MODE: 'local-production-like',
      WP30_EVIDENCE_CLASS: 'local-operator',
      WP30_EXTERNAL_PRODUCTION_READY: 'false',
      WP30_TARGET_SCOPE: 'loopback-only',
      WP30_SOURCE_COMMIT: sourceCommit,
      WP30_TARGET_URL: 'http://127.0.0.1:3300',
      WP30_DOCKER_TARGET_URL: 'http://control-plane:3300',
      WP30_REALTIME_URL: 'ws://127.0.0.1:3300/v1/realtime',
      WP30_WEB_URL: 'http://127.0.0.1:3301',
      WP30_AGENT_URL: 'http://127.0.0.1:3302',
      WP30_POSTGRES_HOST: '127.0.0.1',
      WP30_POSTGRES_PORT: '55430',
      WP30_POSTGRES_DATABASE: 'wp30_local',
      WP30_POSTGRES_USER: 'wp30_admin',
      WP30_POSTGRES_PASSWORD: password,
      WP30_BROKER_PASSWORD: randomSecret(),
      WP30_CODEX_BIN: codexBin,
      WP30_TENANT_A_ID: 'organization-a',
      WP30_TENANT_A_ORG_ID: 'organization-a',
      WP30_TENANT_A_WORKSPACE_ID: 'workspace-a',
      WP30_TENANT_A_TOKEN: jwt(privateKey, 'user-a'),
      WP30_TENANT_B_ID: 'organization-b',
      WP30_TENANT_B_ORG_ID: 'organization-b',
      WP30_TENANT_B_WORKSPACE_ID: 'workspace-b',
      WP30_TENANT_B_TOKEN: jwt(privateKey, 'user-b'),
      WP30_FOREIGN_SESSION_ID: 'session-b',
      WP30_OBJECT_A_ID: 'object-a',
      WP30_OBJECT_ID: 'object-b',
      WP30_COHORT_ID: 'cohort-a',
      WP30_ROLLOUT_ID: 'rollout-local-a',
      WP30_LOAD_DURATION: process.env.WP30_LOCAL_LOAD_DURATION ?? '20s',
      WP30_SOAK_DURATION: process.env.WP30_LOCAL_SOAK_DURATION ?? '30s',
      MINIO_ROOT_USER: 'wp30-local-operator',
      MINIO_ROOT_PASSWORD: randomSecret(),
    }
    writeFileSync(
      WP30_LOCAL_ENV,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      { mode: 0o600 },
    )
    writeFileSync(
      join(WP30_LOCAL_STATE, 'oidc-public.jwk'),
      `${JSON.stringify(publicJwk)}\n`,
      { mode: 0o600 },
    )
    writeFileSync(
      join(WP30_LOCAL_STATE, 'oidc-private.pem'),
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      { mode: 0o600 },
    )
    writeFileSync(
      join(WP30_LOCAL_STATE, 'postgres-password'),
      `${password}\n`,
      {
        mode: 0o600,
      },
    )
  }
  chmodSync(WP30_LOCAL_ENV, 0o600)
  chmodSync(join(WP30_LOCAL_STATE, 'postgres-password'), 0o600)
  chmodSync(join(WP30_LOCAL_STATE, 'oidc-public.jwk'), 0o600)
  chmodSync(join(WP30_LOCAL_STATE, 'oidc-private.pem'), 0o600)
}

const seed = async () => {
  const env = readLocalEnv()
  const pool = new pg.Pool({
    host: env.WP30_POSTGRES_HOST,
    port: Number(env.WP30_POSTGRES_PORT),
    database: env.WP30_POSTGRES_DATABASE,
    user: env.WP30_POSTGRES_USER,
    password: env.WP30_POSTGRES_PASSWORD,
  })
  try {
    await pool.query('BEGIN')
    await pool.query(
      `INSERT INTO persistent_codex.organizations(organization_id,name,status)
       VALUES ($1,'Tenant A','active'),($2,'Tenant B','active')`,
      [env.WP30_TENANT_A_ORG_ID, env.WP30_TENANT_B_ORG_ID],
    )
    await pool.query(
      `INSERT INTO persistent_codex.principal_identities(issuer,subject,status)
       VALUES ('http://oidc-stub:3303','user-a','active'),('http://oidc-stub:3303','user-b','active')`,
    )
    await pool.query(
      `INSERT INTO persistent_codex.organization_memberships(organization_id,issuer,subject,role,status)
       VALUES ($1,'http://oidc-stub:3303','user-a','owner','active'),($2,'http://oidc-stub:3303','user-b','owner','active')`,
      [env.WP30_TENANT_A_ORG_ID, env.WP30_TENANT_B_ORG_ID],
    )
    await pool.query(
      `INSERT INTO persistent_codex.workspaces(tenant_id,organization_id,workspace_id,name)
       VALUES ($1,$1,$2,'Workspace A'),($3,$3,$4,'Workspace B')`,
      [
        env.WP30_TENANT_A_ORG_ID,
        env.WP30_TENANT_A_WORKSPACE_ID,
        env.WP30_TENANT_B_ORG_ID,
        env.WP30_TENANT_B_WORKSPACE_ID,
      ],
    )
    await pool.query(
      `INSERT INTO persistent_codex.regions(region_id,state,control_plane_role)
       VALUES ('local-1','ready','active')`,
    )
    const capacity = {
      schemaVersion: 1,
      cpuMillis: 8000,
      memoryBytes: 8589934592,
      pids: 1024,
      ioBytesPerSecond: 200000000,
      diskBytes: 200000000000,
      diskInodes: 2000000,
      diskIops: 20000,
      egressBytesPerSecond: 200000000,
      egressRequestsPerMinute: 20000,
      eventBytesPerSecond: 20000000,
      artifactBytes: 100000000000,
      outputBytes: 20000000000,
      corpusIndexBytes: 100000000000,
    }
    const zeroCapacity = Object.fromEntries(
      Object.entries(capacity).map(([key, value]) => [
        key,
        key === 'schemaVersion' ? value : 0,
      ]),
    )
    await pool.query(
      `INSERT INTO persistent_codex.runtime_nodes(region_id,node_id,state,capacity_total,capacity_reserved,capacity_score,heartbeat_at)
       VALUES ('local-1','node-1','ready',$1,$2,100,now())`,
      [capacity, zeroCapacity],
    )
    for (const tenant of [
      [env.WP30_TENANT_A_ID, env.WP30_TENANT_A_ORG_ID],
      [env.WP30_TENANT_B_ID, env.WP30_TENANT_B_ORG_ID],
    ])
      await pool.query(
        `INSERT INTO persistent_codex.tenant_scheduling_policies
         (tenant_id,organization_id,policy_version,algorithm,weight,tenant_concurrency,workspace_concurrency,provider_concurrency,provider_requests_per_minute,starvation_age_ms,retry_policy,effective_at)
         VALUES ($1,$2,30,'weighted-fair-v1',1,2,1,'{"codex":2}','{"codex":120}',5000,'{"maxAttempts":4,"initialBackoffMs":100,"maxBackoffMs":1000,"poisonAfterAttempts":4}',now())`,
        tenant,
      )
    await pool.query(
      `INSERT INTO persistent_codex.sessions(organization_id,workspace_id,session_id,status)
       VALUES ($1,$2,$3,'active')`,
      [
        env.WP30_TENANT_B_ORG_ID,
        env.WP30_TENANT_B_WORKSPACE_ID,
        env.WP30_FOREIGN_SESSION_ID,
      ],
    )
    await pool.query(
      `INSERT INTO persistent_codex.artifacts(organization_id,workspace_id,session_id,artifact_id,object_key)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        env.WP30_TENANT_B_ORG_ID,
        env.WP30_TENANT_B_WORKSPACE_ID,
        env.WP30_FOREIGN_SESSION_ID,
        env.WP30_OBJECT_ID,
        `${env.WP30_TENANT_B_ORG_ID}/${env.WP30_TENANT_B_WORKSPACE_ID}/artifacts/${env.WP30_OBJECT_ID}`,
      ],
    )
    await pool.query('COMMIT')

    const billingSeed = {
      initialPromotionalCreditsMicros: 10_000_000,
      plan: {
        schemaVersion: 1 as const,
        planId: 'wp30-local',
        planVersion: 30,
        displayName: 'WP30 Local',
        currency: 'USD' as const,
        effectiveAt: '2026-01-01T00:00:00.000Z',
        retiredAt: null,
        billingMode: 'platform_managed' as const,
        taxBehavior: 'unknown' as const,
      },
      entitlements: ['turn.start', 'workspace.concurrency'].map(
        (key, index) => ({
          schemaVersion: 1 as const,
          entitlementId: `wp30-entitlement-${index}`,
          planId: 'wp30-local',
          planVersion: 30,
          key: key as 'turn.start' | 'workspace.concurrency',
          enabled: true,
          effectiveAt: '2026-01-01T00:00:00.000Z',
          expiresAt: null,
          sourceWebhookEventId: null,
        }),
      ),
      budgets: [
        {
          schemaVersion: 1 as const,
          budgetId: 'wp30-monthly',
          period: 'month' as const,
          currency: 'USD' as const,
          softLimitMicros: 8_000_000,
          hardLimitMicros: 10_000_000,
          effectiveAt: '2026-01-01T00:00:00.000Z',
          expiresAt: null,
        },
      ],
      quotas: [
        {
          schemaVersion: 1 as const,
          quotaId: 'wp30-concurrency',
          policyVersion: 30,
          meter: 'tenant_concurrent_turn' as const,
          softLimit: 3,
          hardLimit: 4,
          inFlightPolicy: 'continue' as const,
          effectiveAt: '2026-01-01T00:00:00.000Z',
          expiresAt: null,
        },
      ],
      retailPriceCatalog: {
        schemaVersion: 1 as const,
        catalogId: 'wp30-retail',
        catalogVersion: 'wp30-retail-v1',
        currency: 'USD' as const,
        rates: [
          { meter: 'provider_input_token' as const, creditsMicrosPerUnit: 1 },
          { meter: 'provider_output_token' as const, creditsMicrosPerUnit: 2 },
          { meter: 'compute_millisecond' as const, creditsMicrosPerUnit: 1 },
        ],
        operationMaximums: [
          { operation: 'turn.start' as const, maximumCreditsMicros: 100_000 },
          {
            operation: 'workspace.concurrency' as const,
            maximumCreditsMicros: 100_000,
          },
        ],
        idempotencyKey: 'wp30-retail-v1',
        paymentReference: null,
        usageDedupeKey: null,
        runId: null,
        operationReference: null,
        occurredAt: '2026-01-01T00:00:00.000Z',
        effectiveAt: '2026-01-01T00:00:00.000Z',
        retiredAt: null,
      },
    }
    const databaseUrl = `postgresql://${env.WP30_POSTGRES_USER}:${env.WP30_POSTGRES_PASSWORD}@${env.WP30_POSTGRES_HOST}:${env.WP30_POSTGRES_PORT}/${env.WP30_POSTGRES_DATABASE}`
    const billing = createBillingPostgresRepository(databaseUrl, {
      developmentSeed: billingSeed,
    })
    try {
      for (const scope of [
        {
          tenantId: env.WP30_TENANT_A_ID,
          organizationId: env.WP30_TENANT_A_ORG_ID,
          workspaceId: env.WP30_TENANT_A_WORKSPACE_ID,
        },
        {
          tenantId: env.WP30_TENANT_B_ID,
          organizationId: env.WP30_TENANT_B_ORG_ID,
          workspaceId: env.WP30_TENANT_B_WORKSPACE_ID,
        },
      ])
        await billing.snapshot(scope)
    } finally {
      await billing.close()
    }
    const objects = new S3CompatibleObjectStore({
      endpoint: 'http://127.0.0.1:59000',
      bucket: 'wp30-local',
      accessKeyId: env.MINIO_ROOT_USER,
      secretAccessKey: env.MINIO_ROOT_PASSWORD,
    })
    await objects.ensureBucket()
    await objects.put(
      `${env.WP30_TENANT_B_ORG_ID}/${env.WP30_TENANT_B_WORKSPACE_ID}/artifacts/${env.WP30_OBJECT_ID}`,
      new TextEncoder().encode('tenant-b-artifact'),
      'text/plain',
    )

    const createSession = async (prefix: 'A' | 'B') => {
      const upper = prefix === 'A' ? 'A' : 'B'
      const response = await fetch(`${env.WP30_TARGET_URL}/v1/sessions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env[`WP30_TENANT_${upper}_TOKEN`]}`,
          'content-type': 'application/json',
          'x-tenant-id': env[`WP30_TENANT_${upper}_ID`],
          'x-organization-id': env[`WP30_TENANT_${upper}_ORG_ID`],
          'x-workspace-id': env[`WP30_TENANT_${upper}_WORKSPACE_ID`],
        },
        body: '{}',
      })
      const responseBody = await response.text()
      assert.equal(response.status, 201, responseBody)
      return JSON.parse(responseBody) as { sessionId: string }
    }
    const sessionA = await createSession('A')
    const sessionB = await createSession('B')
    await pool.query(
      `INSERT INTO persistent_codex.sessions(organization_id,workspace_id,session_id,status)
       VALUES ($1,$2,$3,'active')`,
      [
        env.WP30_TENANT_A_ORG_ID,
        env.WP30_TENANT_A_WORKSPACE_ID,
        sessionA.sessionId,
      ],
    )
    await pool.query(
      `INSERT INTO persistent_codex.artifacts(organization_id,workspace_id,session_id,artifact_id,object_key)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        env.WP30_TENANT_A_ORG_ID,
        env.WP30_TENANT_A_WORKSPACE_ID,
        sessionA.sessionId,
        env.WP30_OBJECT_A_ID,
        `${env.WP30_TENANT_A_ORG_ID}/${env.WP30_TENANT_A_WORKSPACE_ID}/artifacts/${env.WP30_OBJECT_A_ID}`,
      ],
    )
    await objects.put(
      `${env.WP30_TENANT_A_ORG_ID}/${env.WP30_TENANT_A_WORKSPACE_ID}/artifacts/${env.WP30_OBJECT_A_ID}`,
      new TextEncoder().encode('tenant-a-artifact'),
      'text/plain',
    )
    writeFileSync(
      join(WP30_LOCAL_STATE, 'seed.json'),
      `${JSON.stringify({ sessionA: sessionA.sessionId, sessionB: sessionB.sessionId })}\n`,
      { mode: 0o600 },
    )
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await pool.end()
  }
}

const up = async () => {
  writeEnvironment()
  const env = readLocalEnv()
  assert.equal(
    env.WP30_SOURCE_COMMIT,
    sourceCommit,
    'local.env belongs to another source commit; run lab:down',
  )
  assertAbsoluteCodex(env.WP30_CODEX_BIN)
  for (const image of Object.values(readPinnedImages()))
    run('docker', ['pull', image])
  const buildDirectory = join(WP30_LOCAL_STATE, 'build')
  mkdirSync(buildDirectory, { recursive: true, mode: 0o700 })
  const bundle = (entry: string, output: string) =>
    run('pnpm', [
      'exec',
      'esbuild',
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--external:pg-native',
      "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      `--outfile=${join(buildDirectory, output)}`,
    ])
  bundle(
    'services/control-plane/src/production-api-process.ts',
    'control-plane.mjs',
  )
  bundle(
    'services/control-plane/src/production-worker-process.ts',
    'workspace-agent.mjs',
  )
  const productImage = `persistent-wp30-local-product:${sourceCommit}`
  if (
    run('docker', ['image', 'inspect', productImage], { allowFailure: true })
      .status !== 0
  )
    run('docker', [
      'build',
      '--tag',
      productImage,
      '--file',
      'infra/wp30-local/product.Dockerfile',
      '.',
    ])
  run('docker', composeArgs('up', '-d', '--wait', '--wait-timeout', '600'))
  await seed()
  for (const url of [
    env.WP30_TARGET_URL,
    env.WP30_WEB_URL,
    env.WP30_AGENT_URL,
  ]) {
    const response = await fetch(`${url}/readyz`)
    assert.equal(response.status, 200, `${url} not ready`)
  }
  machineEvidence('wp30:lab:up', {
    status: 'ready',
    evidenceClass: 'local-operator',
    targetScope: 'loopback-only',
    sourceCommit,
  })
}

export const down = () => {
  assert.equal(
    run('docker', ['info'], { allowFailure: true }).status,
    0,
    'Docker daemon unavailable; cleanup not verified',
  )
  const listed = (type: 'container' | 'volume' | 'network') => {
    const args =
      type === 'container'
        ? ['ps', '-aq', '--filter', `label=${WP30_LOCAL_LABEL}`]
        : [type, 'ls', '-q', '--filter', `label=${WP30_LOCAL_LABEL}`]
    return run('docker', args, { allowFailure: true })
      .stdout.trim()
      .split('\n')
      .filter(Boolean)
  }
  const containerIds = listed('container')
  const volumeNames = listed('volume')
  const networkIds = listed('network')
  for (const id of containerIds) {
    const label = run('docker', [
      'inspect',
      '--format',
      '{{index .Config.Labels "persistent.wp30.local"}}',
      id,
    ]).stdout.trim()
    assert.equal(label, 'true', 'refusing to remove an unlabeled resource')
  }
  if (existsSync(WP30_LOCAL_ENV))
    run('docker', composeArgs('down', '--volumes', '--remove-orphans'), {
      allowFailure: true,
    })
  else {
    if (containerIds.length) run('docker', ['rm', '-f', ...containerIds])
    if (volumeNames.length) run('docker', ['volume', 'rm', ...volumeNames])
    if (networkIds.length) run('docker', ['network', 'rm', ...networkIds])
  }
  assert.deepEqual(
    [listed('container'), listed('volume'), listed('network')],
    [[], [], []],
    'labeled WP30 local resources remain',
  )
  const inventory = [...containerIds, ...volumeNames, ...networkIds].map(
    redactInventoryName,
  )
  rmSync(WP30_LOCAL_ENV, { force: true })
  rmSync(join(WP30_LOCAL_STATE, 'postgres-password'), { force: true })
  rmSync(join(WP30_LOCAL_STATE, 'local-operator-private.pem'), { force: true })
  rmSync(join(WP30_LOCAL_STATE, 'oidc-private.pem'), { force: true })
  rmSync(join(WP30_LOCAL_STATE, 'oidc-public.jwk'), { force: true })
  rmSync(join(WP30_LOCAL_STATE, 'seed.json'), { force: true })
  rmSync(join(WP30_LOCAL_STATE, 'build'), { recursive: true, force: true })
  machineEvidence('wp30:lab:down', {
    status: 'clean',
    removedCount: inventory.length,
    resources: inventory,
    secretsRemoved: true,
  })
}

const command = process.argv[2]
if (command === 'up') await up()
else if (command === 'down') down()
else throw new Error('usage: wp30-local-lab.ts <up|down>')
