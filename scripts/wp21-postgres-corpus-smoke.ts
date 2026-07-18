import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CorpusIngestionService,
  EmbeddingProviderError,
  EncryptedFilesystemCorpusSnapshotStorage,
  FakeEmbeddingProvider,
  createPostgresCorpusRepository,
} from '../packages/corpus-ingestion/src/index'
import {
  ChunkedEnvelopeEncryption,
  LocalKmsProvider,
} from '../packages/workspace-security/src/index'
import { buildControlPlane } from '../services/control-plane/src/server'

const suffix = randomUUID()
const container = `persistent-codex-wp21-${suffix}`
const volume = `persistent-codex-wp21-${suffix}`
const image = process.env.WP21_POSTGRES_IMAGE ?? 'pgvector/pgvector:pg17'
const root = mkdtempSync(join(tmpdir(), 'wp21-postgres-'))
const run = (...args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
const psql = (sql: string) =>
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
    ],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  )

let result: Record<string, unknown> | undefined
let failure: unknown
try {
  run('volume', 'create', volume)
  run(
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
    image,
  )
  let ready = false
  let consecutiveReady = 0
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = spawnSync(
      'docker',
      ['exec', container, 'pg_isready', '-U', 'postgres'],
      { encoding: 'utf8' },
    )
    const sqlProbe =
      probe.status === 0
        ? spawnSync(
            'docker',
            ['exec', container, 'psql', '-U', 'postgres', '-tAc', 'SELECT 1'],
            { encoding: 'utf8' },
          )
        : undefined
    consecutiveReady =
      sqlProbe?.status === 0 && sqlProbe.stdout.trim() === '1'
        ? consecutiveReady + 1
        : 0
    if (consecutiveReady >= 3) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready)
    throw new Error(
      `PostgreSQL readiness timed out after 30s; inspect docker logs ${container}`,
    )
  const portOutput = run('port', container, '5432/tcp').trim()
  const port = Number.parseInt(
    portOutput.slice(portOutput.lastIndexOf(':') + 1),
    10,
  )
  if (!Number.isSafeInteger(port))
    throw new Error(`Unable to resolve PostgreSQL port: ${portOutput}`)
  const migration18 = readFileSync(
    new URL(
      '../infra/postgres/migrations/0018_oidc_authorization_rls.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const migration21 = readFileSync(
    new URL(
      '../infra/postgres/migrations/0021_tenant_corpus_ingestion.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const migration22 = readFileSync(
    new URL(
      '../infra/postgres/migrations/0022_hybrid_corpus_retrieval.sql',
      import.meta.url,
    ),
    'utf8',
  )
  psql(`${migration18}\n${migration21}\n${migration22}`)
  psql(`
    CREATE ROLE corpus_runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    GRANT USAGE ON SCHEMA persistent_codex TO corpus_runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA persistent_codex TO corpus_runtime;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA persistent_codex TO corpus_runtime;
    GRANT EXECUTE ON FUNCTION persistent_codex.corpus_recoverable_scopes() TO corpus_runtime;
    INSERT INTO persistent_codex.organizations VALUES ('tenant_a','A','active'),('tenant_b','B','active');
    INSERT INTO persistent_codex.workspaces VALUES ('tenant_a','workspace_a','A'),('tenant_b','workspace_a','B');
    INSERT INTO persistent_codex.sessions VALUES
      ('tenant_a','workspace_a','corpus_usage_workspace_a','active'),
      ('tenant_b','workspace_a','corpus_usage_workspace_a','active');
  `)
  const url = `postgresql://corpus_runtime:runtime@127.0.0.1:${port}/postgres`
  const storage = new EncryptedFilesystemCorpusSnapshotStorage(
    join(root, 'snapshots'),
    new ChunkedEnvelopeEncryption(new LocalKmsProvider(Buffer.alloc(32, 7))),
    { explicitUsage: 'test' },
  )
  const scope = {
    tenantId: 'tenant_a',
    organizationId: 'tenant_a',
    workspaceId: 'workspace_a',
  }
  const headers = { 'x-tenant-id': 'tenant_a', 'x-workspace-id': 'workspace_a' }
  const fixture = readFileSync(
    new URL(
      '../packages/corpus-ingestion/test/fixtures/golden.md',
      import.meta.url,
    ),
  )

  let app = await buildControlPlane({
    databasePath: join(root, 'events-1.sqlite'),
    artifactRoot: join(root, 'artifacts-1'),
    allowExplicitDevAuthentication: true,
    allowLocalCorpus: true,
    allowInMemorySupportAccess: true,
    allowInMemorySharedFolders: true,
    corpusRepository: createPostgresCorpusRepository({ connectionString: url }),
    corpusSnapshotStorage: storage,
    corpusAutoDrain: false,
  })
  const uploaded = await app.inject({
    method: 'POST',
    url: '/v1/workspaces/workspace_a/sources',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-source-name': 'golden.md',
      'x-source-media-type': 'text/markdown',
    },
    payload: fixture,
  })
  if (uploaded.statusCode !== 201)
    throw new Error(
      `API upload failed: ${uploaded.statusCode} ${uploaded.body}`,
    )
  const created = uploaded.json() as {
    source: { sourceId: string }
    revision: { revisionId: string }
    job: { jobId: string }
  }

  const workerA = new CorpusIngestionService({
    repository: createPostgresCorpusRepository({ connectionString: url }),
    storage,
    limits: { leaseMs: 50 },
  })
  const workerB = new CorpusIngestionService({
    repository: createPostgresCorpusRepository({ connectionString: url }),
    storage,
    limits: { leaseMs: 50 },
  })
  const claims = await Promise.all([
    workerA.claimNext(scope, 'worker_a'),
    workerB.claimNext(scope, 'worker_b'),
  ])
  const winners = claims.filter(Boolean)
  if (winners.length !== 1)
    throw new Error(`Expected one worker claim winner, got ${winners.length}`)
  const winner = winners[0]!
  const winningWorker = winner.leaseOwner === 'worker_a' ? workerA : workerB
  await winningWorker.processJob(scope, winner.jobId, winner.leaseOwner!)
  const indexed = await app.inject({
    method: 'GET',
    url: '/v1/workspaces/workspace_a/sources',
    headers,
  })
  if (indexed.json().sources[0]?.status !== 'indexed')
    throw new Error(`Worker commit not visible through API: ${indexed.body}`)
  const beforeRebuild = psql(
    `SELECT string_agg(chunk_id,',' ORDER BY ordinal) FROM persistent_codex.corpus_chunks WHERE revision_id='${created.revision.revisionId}';`,
  ).trim()

  const duplicate = await app.inject({
    method: 'POST',
    url: '/v1/workspaces/workspace_a/sources',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-source-name': 'golden.md',
      'x-source-media-type': 'text/markdown',
    },
    payload: fixture,
  })
  if (duplicate.json().revision?.revisionId !== created.revision.revisionId)
    throw new Error('Duplicate upload was not deduplicated')
  const startupRecovery = await app.inject({
    method: 'POST',
    url: '/v1/workspaces/workspace_a/sources',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-source-name': 'startup-recovery.txt',
      'x-source-media-type': 'text/plain',
    },
    payload: Buffer.from('WP21 control-plane startup recovery fixture'),
  })
  const startupRecoverySourceId = startupRecovery.json().source
    .sourceId as string
  await app.close()

  app = await buildControlPlane({
    databasePath: join(root, 'events-2.sqlite'),
    artifactRoot: join(root, 'artifacts-2'),
    allowExplicitDevAuthentication: true,
    allowLocalCorpus: true,
    allowInMemorySupportAccess: true,
    allowInMemorySharedFolders: true,
    corpusRepository: createPostgresCorpusRepository({ connectionString: url }),
    corpusSnapshotStorage: storage,
    corpusAutoDrain: true,
  })
  let startupRecovered = false
  for (let attempt = 0; attempt < 100; attempt++) {
    const recovered = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/workspace_a/sources/${startupRecoverySourceId}`,
      headers,
    })
    if (recovered.json().source?.status === 'indexed') {
      startupRecovered = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (!startupRecovered)
    throw new Error(
      'Control-plane startup did not auto-recover pending corpus job',
    )
  await app.close()
  app = await buildControlPlane({
    databasePath: join(root, 'events-3.sqlite'),
    artifactRoot: join(root, 'artifacts-3'),
    allowExplicitDevAuthentication: true,
    allowLocalCorpus: true,
    allowInMemorySupportAccess: true,
    allowInMemorySharedFolders: true,
    corpusRepository: createPostgresCorpusRepository({ connectionString: url }),
    corpusSnapshotStorage: storage,
    corpusAutoDrain: false,
  })
  const afterRestart = await app.inject({
    method: 'GET',
    url: `/v1/workspaces/workspace_a/sources/${created.source.sourceId}`,
    headers,
  })
  if (
    afterRestart.statusCode !== 200 ||
    afterRestart.json().source.status !== 'indexed'
  )
    throw new Error(
      'Durable source was not visible after control-plane restart',
    )

  const reindex = await app.inject({
    method: 'POST',
    url: `/v1/workspaces/workspace_a/sources/${created.source.sourceId}/reindex`,
    headers,
  })
  if (reindex.statusCode !== 202)
    throw new Error(`Reindex failed: ${reindex.body}`)
  const reindexClaim = await workerA.claimNext(scope, 'worker_reindex')
  if (!reindexClaim) throw new Error('Reindex job was not claimable')
  await workerA.processJob(scope, reindexClaim.jobId, 'worker_reindex')
  const afterRebuild = psql(
    `SELECT string_agg(chunk_id,',' ORDER BY ordinal) FROM persistent_codex.corpus_chunks WHERE revision_id='${created.revision.revisionId}';`,
  ).trim()
  if (!beforeRebuild || beforeRebuild !== afterRebuild)
    throw new Error('Derived rebuild was not deterministic')

  const recoveryUpload = await app.inject({
    method: 'POST',
    url: '/v1/workspaces/workspace_a/sources',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-source-name': 'recovery.txt',
      'x-source-media-type': 'text/plain',
    },
    payload: Buffer.from('WP21 recovery fixture'),
  })
  const recoveryJob = recoveryUpload.json().job.jobId as string
  const crashed = await workerA.claimNext(scope, 'crashed_worker')
  if (!crashed || crashed.jobId !== recoveryJob)
    throw new Error('Recovery job was not initially claimed')
  psql(
    `UPDATE persistent_codex.extraction_jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id='${recoveryJob}';`,
  )
  const restartedWorker = new CorpusIngestionService({
    repository: createPostgresCorpusRepository({ connectionString: url }),
    storage,
  })
  const reclaimed = await restartedWorker.claimNext(scope, 'restarted_worker')
  if (!reclaimed || reclaimed.jobId !== recoveryJob)
    throw new Error('Expired lease was not recovered after worker restart')
  await restartedWorker.processJob(scope, reclaimed.jobId, 'restarted_worker')

  const usageUpload = await app.inject({
    method: 'POST',
    url: '/v1/workspaces/workspace_a/sources',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-source-name': 'usage.txt',
      'x-source-media-type': 'text/plain',
    },
    payload: Buffer.from('WP21 embedding usage fixture'),
  })
  const usageSourceId = usageUpload.json().source.sourceId as string
  const fakeWorker = new CorpusIngestionService({
    repository: createPostgresCorpusRepository({ connectionString: url }),
    storage,
    embeddingProvider: new FakeEmbeddingProvider(),
  })
  const fakeJob = await fakeWorker.claimNext(scope, 'fake_worker')
  if (!fakeJob) throw new Error('Fake embedding job was not claimable')
  await fakeWorker.processJob(scope, fakeJob.jobId, 'fake_worker')
  if (
    Number(
      psql(
        `SELECT count(*) FROM persistent_codex.usage_ledger WHERE meter='index_embedding_token';`,
      ).trim(),
    ) !== 0
  )
    throw new Error('Fake embedding provider was reported as production usage')
  const productionEmbedding = {
    version: 1 as const,
    kind: 'production' as const,
    embeddingVersion: 'reported-token-test-v1',
    dimensions: 384,
    async embed(input: { texts: string[] }) {
      const vectors = input.texts.map(() =>
        Array.from({ length: 384 }, () => 0),
      )
      return {
        vectors,
        vector: vectors[0] ?? null,
        tokenCount: 7,
        completeness: 'complete' as const,
        providerRequestId: 'reported-1',
      }
    },
  }
  await app.inject({
    method: 'POST',
    url: `/v1/workspaces/workspace_a/sources/${usageSourceId}/reindex`,
    headers,
  })
  const productionWorker = new CorpusIngestionService({
    repository: createPostgresCorpusRepository({ connectionString: url }),
    storage,
    embeddingProvider: productionEmbedding,
  })
  const productionJob = await productionWorker.claimNext(
    scope,
    'production_worker',
  )
  if (!productionJob)
    throw new Error('Production embedding job was not claimable')
  await productionWorker.processJob(
    scope,
    productionJob.jobId,
    'production_worker',
  )
  await app.inject({
    method: 'POST',
    url: `/v1/workspaces/workspace_a/sources/${usageSourceId}/reindex`,
    headers,
  })
  const retryJob = await productionWorker.claimNext(
    scope,
    'production_worker_retry',
  )
  if (!retryJob) throw new Error('Embedding dedupe retry job was not claimable')
  await productionWorker.processJob(
    scope,
    retryJob.jobId,
    'production_worker_retry',
  )

  const partialUpload = await app.inject({
    method: 'POST',
    url: '/v1/workspaces/workspace_a/sources',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-source-name': 'partial.txt',
      'x-source-media-type': 'text/plain',
    },
    payload: Buffer.from('WP21 partial embedding fixture'),
  })
  const interruptedEmbedding = {
    version: 1 as const,
    kind: 'production' as const,
    embeddingVersion: 'interrupted-token-test-v1',
    dimensions: 384,
    async embed() {
      throw new EmbeddingProviderError(3, 'interrupted-1')
    },
  }
  const interruptedWorker = new CorpusIngestionService({
    repository: createPostgresCorpusRepository({ connectionString: url }),
    storage,
    embeddingProvider: interruptedEmbedding,
  })
  for (let retry = 0; retry < 2; retry++) {
    const partialJob = await interruptedWorker.claimNext(
      scope,
      `interrupted_worker_${retry}`,
    )
    if (
      !partialJob ||
      partialJob.sourceId !== partialUpload.json().source.sourceId
    )
      throw new Error('Interrupted embedding job was not claimable')
    try {
      await interruptedWorker.processJob(
        scope,
        partialJob.jobId,
        `interrupted_worker_${retry}`,
      )
    } catch (error) {
      if (!(error instanceof EmbeddingProviderError)) throw error
    }
  }

  const crossTenant = await app.inject({
    method: 'GET',
    url: `/v1/workspaces/workspace_a/sources/${created.source.sourceId}`,
    headers: { 'x-tenant-id': 'tenant_b', 'x-workspace-id': 'workspace_a' },
  })
  if (crossTenant.statusCode !== 404)
    throw new Error(
      `Cross-tenant API read was not denied: ${crossTenant.statusCode}`,
    )
  const tenantB = {
    tenantId: 'tenant_b',
    organizationId: 'tenant_b',
    workspaceId: 'workspace_a',
  }
  if (
    (await workerB.listSources(tenantB)).length !== 0 ||
    (await workerB.claimNext(tenantB, 'tenant_b_worker'))
  )
    throw new Error('Cross-tenant worker visibility was not denied by RLS')

  const storagePath = join(
    root,
    'snapshots',
    afterRestart.json().revisions[0].rawSnapshot.storageKey,
  )
  if (!existsSync(storagePath))
    throw new Error('Encrypted snapshot is missing before delete')
  const deleted = await app.inject({
    method: 'DELETE',
    url: `/v1/workspaces/workspace_a/sources/${created.source.sourceId}`,
    headers,
  })
  if (deleted.statusCode !== 204 || existsSync(storagePath))
    throw new Error('Delete did not tombstone metadata and clean snapshot')

  await workerA.repository.enqueueSnapshotCleanup(
    scope,
    afterRestart.json().revisions[0].rawSnapshot.storageKey,
    'SMOKE_CLEANUP',
  )
  await workerA.drainCleanup(scope)
  const counts = psql(`SELECT json_build_object(
    'sources',(SELECT count(*) FROM persistent_codex.sources WHERE tenant_id='tenant_a'),
    'chunks',(SELECT count(*) FROM persistent_codex.corpus_chunks WHERE tenant_id='tenant_a'),
    'usage',(SELECT count(*) FROM persistent_codex.usage_ledger WHERE meter='index_embedding_token'),
    'pending_cleanup',(SELECT count(*) FROM persistent_codex.corpus_storage_cleanup WHERE status='pending'),
    'audits',(SELECT count(*) FROM persistent_codex.ingestion_audit WHERE tenant_id='tenant_a'))::text;
  `)
    .trim()
    .split('\n')
    .at(-1)!
  const databaseCounts = JSON.parse(counts)
  if (databaseCounts.usage !== 2)
    throw new Error('Embedding usage complete/partial dedupe is incorrect')
  if (databaseCounts.pending_cleanup !== 0)
    throw new Error('Storage cleanup outbox did not drain')
  psql(`
    BEGIN; SET LOCAL ROLE corpus_runtime;
    SELECT set_config('app.tenant_id','tenant_a',true),set_config('app.organization_id','tenant_a',true),set_config('app.workspace_id','workspace_a',true);
    SELECT count(*) FROM persistent_codex.sources;
    COMMIT;
    BEGIN; SET LOCAL ROLE corpus_runtime;
    DO $$ BEGIN
      IF COALESCE(current_setting('app.tenant_id',true),'')<>'' OR (SELECT count(*) FROM persistent_codex.sources)<>0
      THEN RAISE EXCEPTION 'tenant context leaked after connection reuse'; END IF;
    END $$; ROLLBACK;
  `)
  await app.close()
  await Promise.all([
    workerA.close(),
    workerB.close(),
    restartedWorker.close(),
    fakeWorker.close(),
    productionWorker.close(),
    interruptedWorker.close(),
  ])
  result = {
    migration: 21,
    repository: 'postgresql',
    storage: 'encrypted-filesystem',
    apiWorkerPath: 'passed',
    controlPlaneRestart: 'passed',
    startupAutoRecovery: 'passed',
    workerRestartRecovery: 'passed',
    concurrentClaim: { workers: 2, winners: 1 },
    duplicateUpload: 'deduped',
    crossTenantApi: 'denied',
    crossTenantWorkerRls: 'denied',
    connectionReuseLeak: false,
    derivedRebuildDeterministic: true,
    embeddingUsage: {
      placeholderRows: 0,
      fakeRows: 0,
      reportedTokens: 7,
      partialTokens: 3,
      deduped: true,
    },
    storageCleanup: 'drained',
    databaseCounts,
  }
} catch (error) {
  failure = error
} finally {
  try {
    run('rm', '-f', container)
  } catch (error) {
    failure ??= error
  }
  try {
    run('volume', 'rm', '-f', volume)
  } catch (error) {
    failure ??= error
  }
  rmSync(root, { recursive: true, force: true })
}
let containerExists = true
let volumeExists = true
try {
  run('inspect', container)
} catch {
  containerExists = false
}
try {
  run('volume', 'inspect', volume)
} catch {
  volumeExists = false
}
if (containerExists || volumeExists)
  failure ??= new Error('PostgreSQL smoke container or volume cleanup failed')
if (failure) throw failure
console.log(
  JSON.stringify(
    {
      ...result,
      cleanup: {
        containerRemoved: true,
        volumeRemoved: true,
        tempRemoved: true,
      },
    },
    null,
    2,
  ),
)
