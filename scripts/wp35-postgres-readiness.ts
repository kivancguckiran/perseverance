import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import pg from 'pg'

const configuredTimeout = Number(
  process.env.WP35_POSTGRES_READINESS_TIMEOUT_MS ?? 60_000,
)
export const WP35_POSTGRES_READINESS_TIMEOUT_MS =
  Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.max(60_000, configuredTimeout)
    : 60_000
const POLL_INTERVAL_MS = 500
const SQL_PROBE_TIMEOUT_MS = 2_000

export interface Wp35PostgresAttemptDiagnostic {
  attempt: number
  containerName: string
  startExitStatus: number | null
  containerState: {
    status: string
    running: boolean
    exitCode: number | null
    health: string
  } | null
  portDiscovery: {
    exitStatus: number | null
    output: string
    hostPort: number | null
  }
  pgIsReady: {
    probes: number
    exitStatus: number | null
    output: string
  }
  sql: {
    probes: number
    lastError: string | null
  }
  logs: string[]
  elapsedMs: number
  cleanup: {
    attempted: boolean
    exitStatus: number | null
  }
}

export class Wp35PostgresReadinessError extends Error {
  readonly diagnostics: Wp35PostgresAttemptDiagnostic[]

  constructor(message: string, diagnostics: Wp35PostgresAttemptDiagnostic[]) {
    super(message)
    this.name = 'Wp35PostgresReadinessError'
    this.diagnostics = diagnostics
  }
}

const sleep = (milliseconds: number) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const safeText = (value: string) =>
  value
    .replace(
      /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
      '[timestamp]',
    )
    .replace(/[a-f0-9]{32,}/gi, '[redacted-digest]')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-uri]')
    .trim()

const docker = (args: string[]) =>
  spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })

const initialDiagnostic = (
  attempt: number,
  containerName: string,
): Wp35PostgresAttemptDiagnostic => ({
  attempt,
  containerName,
  startExitStatus: null,
  containerState: null,
  portDiscovery: { exitStatus: null, output: '', hostPort: null },
  pgIsReady: { probes: 0, exitStatus: null, output: '' },
  sql: { probes: 0, lastError: null },
  logs: [],
  elapsedMs: 0,
  cleanup: { attempted: false, exitStatus: null },
})

const inspectContainer = (diagnostic: Wp35PostgresAttemptDiagnostic) => {
  const inspected = docker([
    'inspect',
    '--format',
    '{{json .State}}',
    diagnostic.containerName,
  ])
  if (inspected.status !== 0) return
  try {
    const state = JSON.parse(inspected.stdout) as {
      Status?: string
      Running?: boolean
      ExitCode?: number
      Health?: { Status?: string }
    }
    diagnostic.containerState = {
      status: String(state.Status ?? 'unknown'),
      running: state.Running === true,
      exitCode: Number.isInteger(state.ExitCode)
        ? Number(state.ExitCode)
        : null,
      health: String(state.Health?.Status ?? 'none'),
    }
  } catch {
    diagnostic.containerState = {
      status: 'unparseable',
      running: false,
      exitCode: null,
      health: 'unknown',
    }
  }
}

const discoverPort = (diagnostic: Wp35PostgresAttemptDiagnostic) => {
  const discovered = docker(['port', diagnostic.containerName, '5432/tcp'])
  const output = safeText(discovered.stdout || discovered.stderr)
  const port = Number(output.split(':').at(-1))
  diagnostic.portDiscovery = {
    exitStatus: discovered.status,
    output,
    hostPort: Number.isInteger(port) && port > 0 ? port : null,
  }
  return diagnostic.portDiscovery.hostPort
}

const captureLogs = (diagnostic: Wp35PostgresAttemptDiagnostic) => {
  inspectContainer(diagnostic)
  discoverPort(diagnostic)
  const logs = docker(['logs', '--tail', '80', diagnostic.containerName])
  diagnostic.logs = safeText(`${logs.stdout}\n${logs.stderr}`)
    .split('\n')
    .filter(Boolean)
    .slice(-40)
}

const removeContainer = (diagnostic: Wp35PostgresAttemptDiagnostic) => {
  diagnostic.cleanup.attempted = true
  const removed = docker(['rm', '-f', '-v', diagnostic.containerName])
  diagnostic.cleanup.exitStatus = removed.status
}

const sqlProbe = async (
  databaseUrl: string,
  diagnostic: Wp35PostgresAttemptDiagnostic,
) => {
  diagnostic.sql.probes += 1
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: SQL_PROBE_TIMEOUT_MS,
    query_timeout: SQL_PROBE_TIMEOUT_MS,
  })
  try {
    await client.connect()
    const result = await client.query<{ ready: number }>('SELECT 1 AS ready')
    if (result.rows[0]?.ready !== 1) throw new Error('SELECT_1_MISMATCH')
    diagnostic.sql.lastError = null
    return true
  } catch (error) {
    diagnostic.sql.lastError = safeText(
      error instanceof Error ? error.message : 'unknown SQL readiness error',
    )
    return false
  } finally {
    await client.end().catch(() => undefined)
  }
}

const waitForDockerPostgres = async (
  diagnostic: Wp35PostgresAttemptDiagnostic,
  databaseUrlForPort: (port: number) => string,
) => {
  const startedAt = Date.now()
  const deadline = startedAt + WP35_POSTGRES_READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    inspectContainer(diagnostic)
    if (
      diagnostic.containerState &&
      !diagnostic.containerState.running &&
      diagnostic.containerState.status === 'exited'
    )
      throw new Error('container exited before PostgreSQL became ready')

    const ready = docker([
      'exec',
      diagnostic.containerName,
      'pg_isready',
      '-U',
      'postgres',
      '-d',
      'wp35',
    ])
    diagnostic.pgIsReady = {
      probes: diagnostic.pgIsReady.probes + 1,
      exitStatus: ready.status,
      output: safeText(ready.stdout || ready.stderr),
    }
    const healthReady =
      diagnostic.containerState?.health === 'healthy' ||
      diagnostic.pgIsReady.output.includes('accepting connections')
    if (healthReady) {
      const port = discoverPort(diagnostic)
      if (port && (await sqlProbe(databaseUrlForPort(port), diagnostic))) {
        diagnostic.elapsedMs = Date.now() - startedAt
        captureLogs(diagnostic)
        return { port, elapsedMs: diagnostic.elapsedMs }
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
  diagnostic.elapsedMs = Date.now() - startedAt
  throw new Error(
    `PostgreSQL readiness exceeded ${WP35_POSTGRES_READINESS_TIMEOUT_MS}ms`,
  )
}

export interface Wp35DockerPostgresLease {
  databaseUrl: string
  containerName: string
  diagnostics: Wp35PostgresAttemptDiagnostic[]
  captureDiagnostics(): Wp35PostgresAttemptDiagnostic[]
  cleanup(): void
}

export const startWp35DockerPostgres = async (input: {
  namePrefix: string
  image: string
}): Promise<Wp35DockerPostgresLease> => {
  const diagnostics: Wp35PostgresAttemptDiagnostic[] = []
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const containerName = `${input.namePrefix}-${process.pid}-${attempt}`
    const diagnostic = initialDiagnostic(attempt, containerName)
    diagnostics.push(diagnostic)
    const password = randomBytes(24).toString('hex')
    const startedAt = Date.now()
    const started = spawnSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        containerName,
        '--label',
        'persistent.wp35=true',
        '--health-cmd',
        'pg_isready -U postgres -d wp35',
        '--health-interval',
        '1s',
        '--health-timeout',
        '5s',
        '--health-retries',
        '60',
        '-e',
        'POSTGRES_PASSWORD',
        '-e',
        'POSTGRES_DB=wp35',
        '-p',
        '127.0.0.1::5432',
        '--tmpfs',
        '/var/lib/postgresql/data:rw,size=512m',
        input.image,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, POSTGRES_PASSWORD: password },
      },
    )
    diagnostic.startExitStatus = started.status
    try {
      if (started.status !== 0)
        throw new Error(
          `container start failed: ${safeText(started.stderr || started.stdout)}`,
        )
      const databaseUrlForPort = (port: number) =>
        `postgresql://postgres:${password}@127.0.0.1:${port}/wp35`
      const ready = await waitForDockerPostgres(diagnostic, databaseUrlForPort)
      const databaseUrl = databaseUrlForPort(ready.port)
      return {
        databaseUrl,
        containerName,
        diagnostics,
        captureDiagnostics() {
          captureLogs(diagnostic)
          return diagnostics
        },
        cleanup() {
          captureLogs(diagnostic)
          removeContainer(diagnostic)
        },
      }
    } catch (error) {
      diagnostic.elapsedMs = Date.now() - startedAt
      captureLogs(diagnostic)
      removeContainer(diagnostic)
      if (attempt === 2)
        throw new Wp35PostgresReadinessError(
          safeText(
            error instanceof Error
              ? error.message
              : 'unknown PostgreSQL readiness failure',
          ),
          diagnostics,
        )
    }
  }
  throw new Wp35PostgresReadinessError(
    'PostgreSQL readiness exhausted',
    diagnostics,
  )
}

export const waitForWp35OperatorPostgres = async (databaseUrl: string) => {
  const diagnostic = initialDiagnostic(1, 'operator-database')
  const startedAt = Date.now()
  const deadline = startedAt + WP35_POSTGRES_READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await sqlProbe(databaseUrl, diagnostic)) {
      diagnostic.elapsedMs = Date.now() - startedAt
      return diagnostic
    }
    await sleep(POLL_INTERVAL_MS)
  }
  diagnostic.elapsedMs = Date.now() - startedAt
  throw new Wp35PostgresReadinessError(
    `operator PostgreSQL readiness exceeded ${WP35_POSTGRES_READINESS_TIMEOUT_MS}ms`,
    [diagnostic],
  )
}
