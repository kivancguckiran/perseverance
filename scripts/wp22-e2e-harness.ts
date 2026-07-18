import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  EncryptedFilesystemCorpusSnapshotStorage,
  createPostgresCorpusRepository,
} from '../packages/corpus-ingestion/src/index'
import {
  ChunkedEnvelopeEncryption,
  LocalKmsProvider,
} from '../packages/workspace-security/src/index'

export const repositoryRoot = resolve(new URL('..', import.meta.url).pathname)

export async function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Unable to reserve local port'))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

export class Wp22E2eHarness {
  readonly tenantId: string
  readonly workspaceId: string
  readonly root: string
  readonly container: string
  readonly volume: string
  connectionString = ''
  #started = false

  constructor(input: { tenantId: string; workspaceId: string }) {
    this.tenantId = input.tenantId
    this.workspaceId = input.workspaceId
    this.root = mkdtempSync(join(tmpdir(), 'wp22-product-e2e-'))
    const suffix = randomUUID()
    this.container = `persistent-codex-wp22-e2e-${suffix}`
    this.volume = this.container
  }

  #docker(...args: string[]) {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  async start() {
    this.#docker('volume', 'create', this.volume)
    this.#docker(
      'run',
      '--rm',
      '-d',
      '--name',
      this.container,
      '-e',
      'POSTGRES_PASSWORD=test',
      '-p',
      '127.0.0.1::5432',
      '-v',
      `${this.volume}:/var/lib/postgresql/data`,
      'pgvector/pgvector:pg17',
    )
    this.#started = true
    let consecutive = 0
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = spawnSync('docker', [
        'exec',
        this.container,
        'pg_isready',
        '-U',
        'postgres',
      ])
      consecutive = result.status === 0 ? consecutive + 1 : 0
      if (consecutive >= 3) break
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
    if (consecutive < 3) throw new Error('WP22 PostgreSQL readiness timed out')
    const migration = (name: string) =>
      readFileSync(
        join(repositoryRoot, 'infra/postgres/migrations', name),
        'utf8',
      )
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        this.container,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
      ],
      {
        input: `${migration('0018_oidc_authorization_rls.sql')}\n${migration('0021_tenant_corpus_ingestion.sql')}\n${migration('0022_hybrid_corpus_retrieval.sql')}
CREATE ROLE corpus_runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA persistent_codex TO corpus_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA persistent_codex TO corpus_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA persistent_codex TO corpus_runtime;
GRANT EXECUTE ON FUNCTION persistent_codex.corpus_recoverable_scopes() TO corpus_runtime;
INSERT INTO persistent_codex.organizations VALUES ('${this.tenantId}','WP22','active'),('tenant_other','Other','active');
INSERT INTO persistent_codex.workspaces VALUES ('${this.tenantId}','${this.workspaceId}','WP22'),('tenant_other','${this.workspaceId}','Other');`,
        encoding: 'utf8',
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    )
    const port = this.#docker('port', this.container, '5432/tcp')
      .trim()
      .split(':')
      .at(-1)!
    this.connectionString = `postgresql://corpus_runtime:runtime@127.0.0.1:${port}/postgres`
  }

  repository() {
    return createPostgresCorpusRepository({
      connectionString: this.connectionString,
    })
  }

  storage() {
    return new EncryptedFilesystemCorpusSnapshotStorage(
      join(this.root, 'snapshots'),
      new ChunkedEnvelopeEncryption(new LocalKmsProvider(Buffer.alloc(32, 22))),
      { explicitUsage: 'test' },
    )
  }

  async cleanup() {
    if (this.#started) {
      try {
        this.#docker('rm', '-f', this.container)
      } catch {}
      try {
        this.#docker('volume', 'rm', '-f', this.volume)
      } catch {}
    }
    rmSync(this.root, { recursive: true, force: true })
  }
}
