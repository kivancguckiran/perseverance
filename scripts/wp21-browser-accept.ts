import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  CorpusIngestionService,
  EncryptedFilesystemCorpusSnapshotStorage,
  createPostgresCorpusRepository,
} from '../packages/corpus-ingestion/src/index'
import { SqliteEventStore } from '../packages/event-store/src/index'
import {
  ChunkedEnvelopeEncryption,
  LocalKmsProvider,
} from '../packages/workspace-security/src/index'
import { buildControlPlane } from '../services/control-plane/src/server'

const root = resolve(new URL('..', import.meta.url).pathname)
const clientRoot = join(root, 'apps/web/dist/client')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'wp21-browser-'))
const container = `persistent-wp21-browser-${process.pid}`
const volume = container
const apiPort = 3231
const webPort = 4231
const apiUrl = `http://127.0.0.1:${apiPort}`
const baseUrl = `http://127.0.0.1:${webPort}`
const sessionName = `wp21-browser-${process.pid}`
const namespace = `persistent-wp21-${process.pid}`
const organizationId = 'tenant_browser'
const workspaceId = 'workspace_browser'
const sessionId = 'session_browser'
const docker = (...args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
const execAsync = promisify(execFile)
const browser = async (...args: string[]) =>
  (
    await execAsync(
      'agent-browser',
      ['--session', sessionName, '--namespace', namespace, ...args],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    )
  ).stdout.trim()
const evaluate = (expression: string) => browser('eval', expression)
const waitFor = async (
  label: string,
  expression: string,
  expected: string,
  timeoutMs = 10_000,
) => {
  const deadline = Date.now() + timeoutMs
  let actual = ''
  while (Date.now() < deadline) {
    actual = await evaluate(expression)
    if (actual === expected) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(
    `${label} timed out after ${timeoutMs}ms; expected ${expected}, received ${actual}`,
  )
}
const migration = (name: string) =>
  readFileSync(join(root, 'infra/postgres/migrations', name), 'utf8')
let api: Awaited<ReturnType<typeof buildControlPlane>> | undefined
let web: ReturnType<typeof createServer> | undefined
let store: SqliteEventStore | undefined
const workers: CorpusIngestionService[] = []
let failure: unknown
try {
  execFileSync('pnpm', ['--filter', '@persistent-codex/web', 'build'], {
    cwd: root,
    env: { ...process.env, VITE_CONTROL_PLANE_URL: apiUrl },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  docker('volume', 'create', volume)
  docker(
    'run',
    '--rm',
    '-d',
    '--name',
    container,
    '-e',
    'POSTGRES_PASSWORD=test',
    '-p',
    '127.0.0.1::5432',
    '-v',
    `${volume}:/var/lib/postgresql/data`,
    'pgvector/pgvector:pg17',
  )
  let consecutive = 0
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = spawnSync('docker', [
      'exec',
      container,
      'pg_isready',
      '-U',
      'postgres',
    ])
    const sql =
      ready.status === 0
        ? spawnSync(
            'docker',
            ['exec', container, 'psql', '-U', 'postgres', '-tAc', 'SELECT 1'],
            { encoding: 'utf8' },
          )
        : undefined
    consecutive =
      sql?.status === 0 && sql.stdout.trim() === '1' ? consecutive + 1 : 0
    if (consecutive >= 3) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    if (attempt === 59)
      throw new Error(
        `Browser PostgreSQL readiness timed out; inspect docker logs ${container}`,
      )
  }
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
    ],
    {
      input: `${migration('0018_oidc_authorization_rls.sql')}\n${migration('0021_tenant_corpus_ingestion.sql')}\n${migration('0022_hybrid_corpus_retrieval.sql')}
      CREATE ROLE corpus_browser LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      GRANT USAGE ON SCHEMA persistent_codex TO corpus_browser;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA persistent_codex TO corpus_browser;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA persistent_codex TO corpus_browser;
      GRANT EXECUTE ON FUNCTION persistent_codex.corpus_recoverable_scopes() TO corpus_browser;
      INSERT INTO persistent_codex.organizations VALUES ('${organizationId}','Browser','active'),('tenant_other','Other','active');
      INSERT INTO persistent_codex.workspaces VALUES ('${organizationId}','${workspaceId}','Browser'),('tenant_other','${workspaceId}','Other');
      INSERT INTO persistent_codex.sessions VALUES ('${organizationId}','${workspaceId}','corpus_usage_${workspaceId}','active'),('tenant_other','${workspaceId}','corpus_usage_${workspaceId}','active');`,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  )
  const postgresPort = docker('port', container, '5432/tcp')
    .trim()
    .split(':')
    .at(-1)!
  const connectionString = `postgresql://corpus_browser:runtime@127.0.0.1:${postgresPort}/postgres`
  const storage = new EncryptedFilesystemCorpusSnapshotStorage(
    join(temporaryRoot, 'snapshots'),
    new ChunkedEnvelopeEncryption(new LocalKmsProvider(Buffer.alloc(32, 9))),
    { explicitUsage: 'test' },
  )
  const scope = { tenantId: organizationId, organizationId, workspaceId }
  store = new SqliteEventStore(join(temporaryRoot, 'events.sqlite'))
  store.createSession({
    tenantId: organizationId,
    workspaceId,
    sessionId,
    status: 'active',
  })
  api = await buildControlPlane({
    eventStore: store,
    artifactRoot: join(temporaryRoot, 'artifacts'),
    allowExplicitDevAuthentication: true,
    allowLocalCorpus: true,
    allowInMemorySupportAccess: true,
    allowInMemorySharedFolders: true,
    corpusRepository: createPostgresCorpusRepository({ connectionString }),
    corpusSnapshotStorage: storage,
    corpusAutoDrain: false,
  })
  await api.listen({ host: '127.0.0.1', port: apiPort })
  const contentTypes: Record<string, string> = {
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
  }
  const serverEntry = (
    await import(
      pathToFileURL(join(root, 'apps/web/dist/server/server.js')).href
    )
  ).default as { fetch(request: Request): Promise<Response> }
  web = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', baseUrl)
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
      const rendered = await serverEntry.fetch(
        new Request(url, {
          method: request.method,
          headers: request.headers as HeadersInit,
        }),
      )
      response.writeHead(rendered.status, Object.fromEntries(rendered.headers))
      response.end(Buffer.from(await rendered.arrayBuffer()))
    } catch (error) {
      response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise<void>((resolveListen, reject) => {
    web!.once('error', reject)
    web!.listen(webPort, '127.0.0.1', resolveListen)
  })
  const url = `${baseUrl}/sessions/${sessionId}?organization=${organizationId}&workspace=${workspaceId}`
  await browser('set', 'viewport', '1280', '720')
  await browser('open', url)
  await waitFor(
    'workspace page content',
    `document.body.innerText.trim().length > 0`,
    'true',
  )
  await evaluate(
    `document.querySelector('.source-panel')?.setAttribute('open','')`,
  )
  await browser(
    'upload',
    'input[type=file][accept^=".pdf"]',
    join(root, 'packages/corpus-ingestion/test/fixtures/golden.md'),
  )
  await waitFor(
    'pending source status',
    `document.querySelector('[data-source-status]')?.textContent`,
    '"pending"',
  )
  const slowEmbedding = {
    version: 1 as const,
    kind: 'fake-test' as const,
    embeddingVersion: 'browser-fake-test-v1',
    dimensions: 384,
    async embed(input: { texts: string[] }) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1300))
      const vectors = input.texts.map(() =>
        Array.from({ length: 384 }, () => 0),
      )
      return {
        vectors,
        vector: vectors[0] ?? null,
        tokenCount: 5,
        completeness: 'complete' as const,
        providerRequestId: 'browser',
      }
    },
  }
  const worker = new CorpusIngestionService({
    repository: createPostgresCorpusRepository({ connectionString }),
    storage,
    embeddingProvider: slowEmbedding,
  })
  workers.push(worker)
  const pending = await worker.claimNext(scope, 'browser_worker')
  assert(pending)
  const processing = worker.processJob(scope, pending.jobId, 'browser_worker')
  await waitFor(
    'extracting source status',
    `document.querySelector('[data-source-status]')?.textContent`,
    '"extracting"',
  )
  await processing
  await waitFor(
    'indexed source status',
    `document.querySelector('[data-source-status]')?.textContent`,
    '"indexed"',
  )
  await browser('reload')
  await waitFor(
    'workspace page after reload',
    `document.querySelector('.source-panel') !== null`,
    'true',
  )
  await evaluate(
    `document.querySelector('.source-panel')?.setAttribute('open','')`,
  )
  await waitFor(
    'durable indexed source after reload',
    `document.querySelector('[data-source-status]')?.textContent`,
    '"indexed"',
  )

  await browser(
    'upload',
    'input[type=file][accept^=".pdf"]',
    join(root, 'packages/corpus-ingestion/test/fixtures/image-only.pdf'),
  )
  const poisonWorker = new CorpusIngestionService({
    repository: createPostgresCorpusRepository({ connectionString }),
    storage,
  })
  workers.push(poisonWorker)
  for (let attempt = 0; attempt < 3; attempt++) {
    const poison = await poisonWorker.claimNext(scope, 'browser_poison')
    assert(poison)
    try {
      await poisonWorker.processJob(scope, poison.jobId, 'browser_poison')
    } catch {}
  }
  await waitFor(
    'failed poison source status',
    `[...document.querySelectorAll('[data-source-status]')].some(v=>v.textContent==='failed')`,
    'true',
  )
  const sourceId = pending.sourceId
  const reindexStatus = await evaluate(
    `fetch('${apiUrl}/v1/workspaces/${workspaceId}/sources/${sourceId}/reindex',{method:'POST',headers:{'x-tenant-id':'${organizationId}','x-workspace-id':'${workspaceId}'}}).then(r=>r.status)`,
  )
  assert.equal(reindexStatus, '202')
  const reindexJob = await worker.claimNext(scope, 'browser_reindex')
  assert(reindexJob)
  await worker.processJob(scope, reindexJob.jobId, 'browser_reindex')
  await waitFor(
    'reindexed source status',
    `[...document.querySelectorAll('[data-source-status]')].some(v=>v.textContent==='indexed')`,
    'true',
  )
  const otherTenantCount = await evaluate(
    `fetch('${apiUrl}/v1/workspaces/${workspaceId}/sources',{headers:{'x-tenant-id':'tenant_other','x-workspace-id':'${workspaceId}'}}).then(r=>r.json()).then(v=>v.sources.length)`,
  )
  assert.equal(otherTenantCount, '0')
  const deleteStatus = await evaluate(
    `fetch('${apiUrl}/v1/workspaces/${workspaceId}/sources/${sourceId}',{method:'DELETE',headers:{'x-tenant-id':'${organizationId}','x-workspace-id':'${workspaceId}'}}).then(r=>r.status)`,
  )
  assert.equal(deleteStatus, '204')
  await browser('reload')
  await waitFor(
    'workspace page after delete reload',
    `document.querySelector('.source-panel') !== null`,
    'true',
  )
  await evaluate(
    `document.querySelector('.source-panel')?.setAttribute('open','')`,
  )
  await waitFor(
    'durable deleted source removal',
    `[...document.querySelectorAll('[data-source-status]')].some(v=>v.textContent==='indexed')`,
    'false',
  )
  await evaluate(
    `(() => { if(document.documentElement.scrollWidth>document.documentElement.clientWidth) throw new Error('desktop overflow'); const text=document.body.innerText; if(text.includes('WP21 embedding usage fixture')||text.includes('Bearer ')) throw new Error('source or credential leak'); return true })()`,
  )
  await browser('set', 'viewport', '390', '844')
  await waitFor(
    'mobile viewport layout',
    `document.documentElement.scrollWidth<=document.documentElement.clientWidth && document.querySelector('.source-panel')!==null`,
    'true',
  )
  const errors = await browser('errors', '--json')
  assert(
    errors === '[]' || /"errors"\s*:\s*\[\s*\]/.test(errors),
    `Browser errors: ${errors}`,
  )
  console.log(
    JSON.stringify({
      browser: 'passed',
      apiRepository: 'postgresql',
      viewports: ['1280x720', '390x844'],
      states: [
        'pending',
        'extracting',
        'indexed',
        'failed',
        'deleted/reindexed',
      ],
      reload: 'durable',
      crossTenant: 'hidden',
      pageErrors: 0,
      horizontalOverflow: 0,
      leaks: 0,
    }),
  )
} catch (error) {
  failure = error
} finally {
  try {
    await browser('close')
  } catch {}
  for (const worker of workers)
    try {
      await worker.close()
    } catch {}
  if (api)
    try {
      await api.close()
    } catch {}
  if (web)
    await new Promise<void>((resolveClose) => web!.close(() => resolveClose()))
  if (store)
    try {
      store.close()
    } catch {}
  try {
    docker('rm', '-f', container)
  } catch {}
  try {
    docker('volume', 'rm', '-f', volume)
  } catch {}
  rmSync(temporaryRoot, { recursive: true, force: true })
}
if (failure) throw failure
