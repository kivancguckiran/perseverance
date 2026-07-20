import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { Pool } from 'pg'
import {
  createBillingPostgresRepository,
  type DevelopmentCommercialSeed,
} from '../packages/billing-platform/src/index'

const ROOT = new URL('../', import.meta.url).pathname
const billingSeed: DevelopmentCommercialSeed = {
  initialPromotionalCreditsMicros: 10_000_000,
  plan: {
    schemaVersion: 1,
    planId: 'wp26-production',
    planVersion: 26,
    displayName: 'WP26 Production',
    currency: 'USD',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null,
    billingMode: 'platform_managed',
    taxBehavior: 'unknown',
  },
  entitlements: ['turn.start', 'workspace.concurrency'].map((key, index) => ({
    schemaVersion: 1 as const,
    entitlementId: `wp26-entitlement-${index}`,
    planId: 'wp26-production',
    planVersion: 26,
    key: key as 'turn.start' | 'workspace.concurrency',
    enabled: true,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    sourceWebhookEventId: null,
  })),
  budgets: [
    {
      schemaVersion: 1,
      budgetId: 'wp26-monthly',
      period: 'month',
      currency: 'USD',
      softLimitMicros: 8_000_000,
      hardLimitMicros: 10_000_000,
      effectiveAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    },
  ],
  quotas: [
    {
      schemaVersion: 1,
      quotaId: 'wp26-concurrency',
      policyVersion: 26,
      meter: 'tenant_concurrent_turn',
      softLimit: 3,
      hardLimit: 4,
      inFlightPolicy: 'continue',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    },
  ],
  retailPriceCatalog: {
    schemaVersion: 1,
    catalogId: 'wp26-retail',
    catalogVersion: 'wp26-retail-v1',
    currency: 'USD',
    rates: [
      { meter: 'provider_input_token', creditsMicrosPerUnit: 1 },
      { meter: 'provider_output_token', creditsMicrosPerUnit: 2 },
      { meter: 'compute_millisecond', creditsMicrosPerUnit: 1 },
    ],
    operationMaximums: [
      { operation: 'turn.start', maximumCreditsMicros: 100_000 },
      { operation: 'workspace.concurrency', maximumCreditsMicros: 100_000 },
    ],
    idempotencyKey: 'wp26-retail-v1',
    paymentReference: null,
    usageDedupeKey: null,
    runId: null,
    operationReference: null,
    occurredAt: '2026-01-01T00:00:00.000Z',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null,
  },
}

function docker(args: string[], input?: string, allowFailure = false) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
  })
  if (!allowFailure && result.status !== 0)
    throw new Error(
      result.stderr || result.stdout || `docker ${args.join(' ')} failed`,
    )
  return result.stdout.trim()
}

async function waitFor(
  url: string,
  expected = 200,
  attempts = 120,
  headers?: HeadersInit,
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { headers })
      if (response.status === expected) return response
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Dependency did not become ready: ${url}`)
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('free port unavailable')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

export class Wp26ProductionStack {
  readonly id = `wp26-${randomUUID()}`
  readonly postgres = `${this.id}-postgres`
  readonly rabbit = `${this.id}-rabbit`
  readonly minio = `${this.id}-minio`
  readonly vault = `${this.id}-vault`
  readonly volume = `${this.id}-pgdata`
  readonly processes: ChildProcess[] = []
  apiPorts: number[] = []
  workerPorts: number[] = []
  databaseUrl = ''
  rabbitUrl = ''
  minioUrl = ''
  vaultUrl = ''
  loadBalancer?: Server
  loadBalancerUrl = ''
  #nextApi = 0

  async startInfrastructure() {
    docker(['volume', 'create', this.volume])
    docker([
      'run',
      '-d',
      '--name',
      this.postgres,
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-v',
      `${this.volume}:/var/lib/postgresql/data`,
      '-p',
      '127.0.0.1::5432',
      'pgvector/pgvector:pg17',
    ])
    docker([
      'run',
      '-d',
      '--name',
      this.rabbit,
      '-e',
      'RABBITMQ_DEFAULT_USER=wp26',
      '-e',
      'RABBITMQ_DEFAULT_PASS=wp26-broker-secret',
      '-p',
      '127.0.0.1::15672',
      'rabbitmq:4-management',
    ])
    docker([
      'run',
      '-d',
      '--name',
      this.minio,
      '--tmpfs',
      '/data:size=1g',
      '-e',
      'MINIO_ROOT_USER=wp26access',
      '-e',
      'MINIO_ROOT_PASSWORD=wp26-secret-not-logged',
      '-p',
      '127.0.0.1::9000',
      'minio/minio:latest',
      'server',
      '/data',
    ])
    docker([
      'run',
      '-d',
      '--name',
      this.vault,
      '-e',
      'VAULT_DEV_ROOT_TOKEN_ID=wp26-root-token',
      '-p',
      '127.0.0.1::8200',
      'hashicorp/vault:1.20',
    ])
    for (let attempt = 0; attempt < 120; attempt++) {
      if (
        spawnSync('docker', [
          'exec',
          this.postgres,
          'pg_isready',
          '-U',
          'postgres',
        ]).status === 0
      )
        break
      if (attempt === 119) throw new Error('PostgreSQL readiness timeout')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const pgPort = docker(['port', this.postgres, '5432/tcp'])
      .split(':')
      .at(-1)!
    const rabbitPort = docker(['port', this.rabbit, '15672/tcp'])
      .split(':')
      .at(-1)!
    const minioPort = docker(['port', this.minio, '9000/tcp'])
      .split(':')
      .at(-1)!
    const vaultPort = docker(['port', this.vault, '8200/tcp'])
      .split(':')
      .at(-1)!
    this.databaseUrl = `postgresql://topology_runtime:runtime@127.0.0.1:${pgPort}/postgres`
    this.rabbitUrl = `http://127.0.0.1:${rabbitPort}`
    this.minioUrl = `http://127.0.0.1:${minioPort}`
    this.vaultUrl = `http://127.0.0.1:${vaultPort}/v1/sys/health`
    await Promise.all([
      waitFor(`${this.rabbitUrl}/api/health/checks/alarms`, 200, 120, {
        authorization: `Basic ${Buffer.from('wp26:wp26-broker-secret').toString('base64')}`,
      }),
      waitFor(`${this.minioUrl}/minio/health/ready`),
      waitFor(this.vaultUrl),
    ])
    for (const migration of [
      '0018_oidc_authorization_rls.sql',
      '0019_runtime_secrets_envelope_encryption.sql',
      '0020_admin_access_governance.sql',
      '0021_tenant_corpus_ingestion.sql',
      '0022_hybrid_corpus_retrieval.sql',
      '0023_pwa_push_multi_device.sql',
      '0024_billing_plan_quota.sql',
      '0025_billing_runtime_composition.sql',
      '0026_prepaid_credit_financial_projection.sql',
      '0027_secure_shared_folders.sql',
      '0028_ha_scheduler_capacity.sql',
      '0029_wp26_production_execution.sql',
    ]) {
      docker(
        [
          'exec',
          '-i',
          this.postgres,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'postgres',
        ],
        readFileSync(`${ROOT}infra/postgres/migrations/${migration}`, 'utf8'),
      )
    }
    docker(
      [
        'exec',
        '-i',
        this.postgres,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
      ],
      `
      CREATE ROLE topology_runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      GRANT persistent_topology_scheduler TO topology_runtime;
      GRANT USAGE ON SCHEMA persistent_codex TO topology_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA persistent_codex TO topology_runtime;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA persistent_codex TO topology_runtime;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA persistent_codex TO topology_runtime;
      INSERT INTO persistent_codex.organizations VALUES ('tenant-a','Tenant A','active'),('tenant-b','Tenant B','active');
      INSERT INTO persistent_codex.workspaces(tenant_id,organization_id,workspace_id,name) VALUES ('tenant-a','tenant-a','workspace-a','A'),('tenant-b','tenant-b','workspace-b','B');
      INSERT INTO persistent_codex.regions(region_id,state,control_plane_role) VALUES ('eu-1','ready','active');
      INSERT INTO persistent_codex.runtime_nodes(region_id,node_id,state,capacity_total,capacity_reserved,capacity_score,heartbeat_at)
      VALUES ('eu-1','node-1','ready','{"cpuMillis":8000,"memoryBytes":8589934592,"pids":1024,"ioBytesPerSecond":200000000,"diskBytes":200000000000,"diskInodes":2000000,"diskIops":20000,"egressBytesPerSecond":200000000,"egressRequestsPerMinute":20000,"eventBytesPerSecond":20000000,"artifactBytes":100000000000,"outputBytes":20000000000,"corpusIndexBytes":100000000000}','{"cpuMillis":0,"memoryBytes":0,"pids":0,"ioBytesPerSecond":0,"diskBytes":0,"diskInodes":0,"diskIops":0,"egressBytesPerSecond":0,"egressRequestsPerMinute":0,"eventBytesPerSecond":0,"artifactBytes":0,"outputBytes":0,"corpusIndexBytes":0}',100,now());
      INSERT INTO persistent_codex.runtime_nodes(region_id,node_id,state,capacity_total,capacity_reserved,capacity_score,heartbeat_at)
      SELECT region_id,'node-2','ready',capacity_total,capacity_reserved,90,now()
      FROM persistent_codex.runtime_nodes WHERE region_id='eu-1' AND node_id='node-1';
      INSERT INTO persistent_codex.tenant_scheduling_policies
        (tenant_id,organization_id,policy_version,algorithm,weight,tenant_concurrency,workspace_concurrency,provider_concurrency,provider_requests_per_minute,starvation_age_ms,retry_policy,effective_at)
      VALUES
        ('tenant-a','tenant-a',26,'weighted-fair-v1',1,2,1,'{"codex":2}','{"codex":60}',5000,'{"maxAttempts":4,"initialBackoffMs":100,"maxBackoffMs":1000,"poisonAfterAttempts":4}',now()),
        ('tenant-b','tenant-b',26,'weighted-fair-v1',1,2,1,'{"codex":2}','{"codex":60}',5000,'{"maxAttempts":4,"initialBackoffMs":100,"maxBackoffMs":1000,"poisonAfterAttempts":4}',now());
    `,
    )
    const billing = createBillingPostgresRepository(this.databaseUrl, {
      developmentSeed: billingSeed,
    })
    try {
      await billing.snapshot({
        tenantId: 'tenant-a',
        organizationId: 'tenant-a',
        workspaceId: 'workspace-a',
      })
      await billing.snapshot({
        tenantId: 'tenant-b',
        organizationId: 'tenant-b',
        workspaceId: 'workspace-b',
      })
    } finally {
      await billing.close()
    }
  }

  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NODE_ENV: 'production',
      TOPOLOGY_DATABASE_URL: this.databaseUrl,
      OBJECT_STORAGE_ENDPOINT: this.minioUrl,
      OBJECT_STORAGE_BUCKET: 'wp26',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'wp26access',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'wp26-secret-not-logged',
      EVENT_BROKER_MANAGEMENT_URL: this.rabbitUrl,
      EVENT_BROKER_USERNAME: 'wp26',
      EVENT_BROKER_PASSWORD: 'wp26-broker-secret',
      EVENT_BROKER_QUEUE: 'wp26-events',
      KMS_READINESS_URL: this.vaultUrl,
      PERSISTENT_REGION_ID: 'eu-1',
      WORKSPACE_CWD: ROOT.replace(/\/$/, ''),
      ...extra,
    }
  }

  startProcess(file: string, env: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, ['--import', 'tsx', file], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let diagnostic = ''
    child.stdout?.on('data', (chunk) => {
      diagnostic = `${diagnostic}${String(chunk)}`.slice(-4000)
    })
    child.stderr?.on('data', (chunk) => {
      diagnostic = `${diagnostic}${String(chunk)}`.slice(-4000)
    })
    child.once('exit', (code) => {
      if (code && !child.killed)
        process.stderr.write(
          `WP26 child exited ${code}: ${diagnostic.replaceAll(/(password|secret|token)=[^\s]+/gi, '$1=[REDACTED]')}\n`,
        )
    })
    this.processes.push(child)
    return child
  }

  async startWorkers(codexBin: string, count = 2, holdMs = 0) {
    for (let index = 0; index < count; index++) {
      const port = await freePort()
      this.workerPorts.push(port)
      this.startProcess(
        'services/control-plane/src/production-worker-process.ts',
        this.env({
          WP26_CODEX_BIN: codexBin,
          SCHEDULER_OWNER_ID: `scheduler-${index + 1}`,
          SCHEDULER_HEALTH_PORT: String(port),
          SCHEDULER_RUNTIME_HOLD_MS: String(holdMs),
          SCHEDULER_LEASE_MS: '3000',
        }),
      )
      await waitFor(`http://127.0.0.1:${port}/healthz`)
    }
  }

  async restartWorker(index: number, codexBin: string) {
    const port = this.workerPorts[index]
    if (!port) throw new Error(`Unknown worker index ${index}`)
    this.startProcess(
      'services/control-plane/src/production-worker-process.ts',
      this.env({
        WP26_CODEX_BIN: codexBin,
        SCHEDULER_OWNER_ID: `scheduler-replacement-${index + 1}`,
        SCHEDULER_HEALTH_PORT: String(port),
        SCHEDULER_LEASE_MS: '3000',
      }),
    )
    await waitFor(`http://127.0.0.1:${port}/healthz`)
  }

  async startApis(count = 2) {
    if (this.workerPorts.length === 0)
      throw new Error('runtime-control workers must start first')
    for (let index = 0; index < count; index++) {
      const port = await freePort()
      this.apiPorts.push(port)
      this.startProcess(
        'services/control-plane/src/production-api-process.ts',
        this.env({
          PORT: String(port),
          PERSISTENT_INSTANCE_ID: `api-${index + 1}`,
          RUNTIME_CONTROL_READINESS_URL: `http://127.0.0.1:${this.workerPorts[index % this.workerPorts.length]}/healthz`,
        }),
      )
      await waitFor(`http://127.0.0.1:${port}/readyz`)
    }
    this.loadBalancer = createServer((request, response) => {
      const live = this.apiPorts.filter(
        (_, index) => !this.processes[this.workerPorts.length + index]?.killed,
      )
      const port = live[this.#nextApi++ % live.length]
      if (!port) {
        response.writeHead(503).end()
        return
      }
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: request.url,
          method: request.method,
          headers: request.headers,
        },
        (value) => {
          response.writeHead(value.statusCode ?? 502, value.headers)
          value.pipe(response)
        },
      )
      upstream.once('error', () => response.writeHead(503).end())
      request.pipe(upstream)
    })
    this.loadBalancer.on('upgrade', (request, socket, head) => {
      const live = this.apiPorts.filter(
        (_, index) => !this.processes[this.workerPorts.length + index]?.killed,
      )
      const port = live[this.#nextApi++ % live.length]
      if (!port) return socket.destroy()
      const upstream = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: request.url,
        method: request.method,
        headers: request.headers,
      })
      upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
        const headers = Object.entries(response.headers)
          .flatMap(([name, value]) =>
            Array.isArray(value)
              ? value.map((item) => `${name}: ${item}`)
              : value === undefined
                ? []
                : [`${name}: ${value}`],
          )
          .join('\r\n')
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`)
        if (head.length) upstreamSocket.write(head)
        if (upstreamHead.length) socket.write(upstreamHead)
        upstreamSocket.pipe(socket)
        socket.pipe(upstreamSocket)
      })
      upstream.once('error', () => socket.destroy())
      upstream.end()
    })
    await new Promise<void>((resolve) =>
      this.loadBalancer!.listen(0, '127.0.0.1', resolve),
    )
    const address = this.loadBalancer.address()
    if (!address || typeof address === 'string')
      throw new Error('load balancer address unavailable')
    this.loadBalancerUrl = `http://127.0.0.1:${address.port}`
  }

  killApi(index: number) {
    const processIndex = this.workerPorts.length + index
    this.processes[processIndex]?.kill('SIGKILL')
  }

  stopContainer(name: string) {
    docker(['stop', name])
  }
  startContainer(name: string) {
    docker(['start', name])
  }
  pauseContainer(name: string) {
    docker(['pause', name])
  }
  unpauseContainer(name: string) {
    docker(['unpause', name])
  }

  async query(sql: string, params: unknown[] = []) {
    const pool = new Pool({ connectionString: this.databaseUrl })
    try {
      return await pool.query(sql, params)
    } finally {
      await pool.end()
    }
  }

  async cleanup() {
    await new Promise<void>(
      (resolve) => this.loadBalancer?.close(() => resolve()) ?? resolve(),
    )
    for (const child of this.processes) child.kill('SIGKILL')
    docker(
      ['rm', '-f', this.postgres, this.rabbit, this.minio, this.vault],
      undefined,
      true,
    )
    docker(['volume', 'rm', '-f', this.volume], undefined, true)
  }
}

export const wp26Headers = {
  'content-type': 'application/json',
  'x-tenant-id': 'tenant-a',
  'x-organization-id': 'tenant-a',
  'x-workspace-id': 'workspace-a',
}
