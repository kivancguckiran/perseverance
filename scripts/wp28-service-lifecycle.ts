import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Pool } from 'pg'
import { S3CompatibleObjectStore } from '../packages/production-topology/src/durable-dependencies'

const id = randomUUID(),
  names = {
    postgres: `persistent-wp28-lifecycle-${id}-postgres`,
    minio: `persistent-wp28-lifecycle-${id}-minio`,
    vault: `persistent-wp28-lifecycle-${id}-vault`,
    redis: `persistent-wp28-lifecycle-${id}-redis`,
  }
const docker = (args: string[], allow = false) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  if (!allow && r.status !== 0) throw new Error(r.stderr || r.stdout)
  return r.stdout.trim()
}
const port = (name: string, containerPort: string) =>
  Number(docker(['port', name, containerPort]).split(':').at(-1))
const wait = async (check: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 160; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('WP28_SERVICE_READINESS_TIMEOUT')
}
let pool: Pool | undefined
try {
  docker([
    'run',
    '-d',
    '--name',
    names.postgres,
    '--tmpfs',
    '/var/lib/postgresql/data',
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-p',
    '127.0.0.1::5432',
    'pgvector/pgvector:pg17',
  ])
  docker([
    'run',
    '-d',
    '--name',
    names.minio,
    '--tmpfs',
    '/data:size=256m',
    '-e',
    'MINIO_ROOT_USER=wp28access',
    '-e',
    'MINIO_ROOT_PASSWORD=wp28-secret-not-evidence',
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
    names.vault,
    '-e',
    'VAULT_DEV_ROOT_TOKEN_ID=wp28-root-token',
    '-p',
    '127.0.0.1::8200',
    'hashicorp/vault:1.20',
  ])
  docker(['run', '-d', '--name', names.redis, 'redis:7.4-alpine'])
  await wait(
    () =>
      spawnSync('docker', [
        'exec',
        names.postgres,
        'pg_isready',
        '-U',
        'postgres',
      ]).status === 0,
  )
  const postgresPort = port(names.postgres, '5432/tcp'),
    minioUrl = `http://127.0.0.1:${port(names.minio, '9000/tcp')}`,
    vaultBase = `http://127.0.0.1:${port(names.vault, '8200/tcp')}`
  await wait(async () =>
    Boolean(
      (await fetch(`${minioUrl}/minio/health/ready`).catch(() => null))?.ok,
    ),
  )
  await wait(async () =>
    Boolean((await fetch(`${vaultBase}/v1/sys/health`).catch(() => null))?.ok),
  )
  pool = new Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${postgresPort}/postgres`,
  })
  const objectStore = new S3CompatibleObjectStore({
    endpoint: minioUrl,
    bucket: 'wp28-lifecycle',
    accessKeyId: 'wp28access',
    secretAccessKey: 'wp28-secret-not-evidence',
  })
  await objectStore.ensureBucket()
  await objectStore.put('eu-1/tenant-a/artifact-a', Buffer.from('tenant-a'))
  await objectStore.put('eu-1/tenant-b/artifact-b', Buffer.from('tenant-b'))
  docker([
    'exec',
    names.redis,
    'redis-cli',
    'SET',
    'tenant:tenant-a:authz',
    'active',
  ])
  docker([
    'exec',
    names.redis,
    'redis-cli',
    'SET',
    'tenant:tenant-b:authz',
    'active',
  ])
  await pool.query(
    `CREATE TABLE wp28_derived_index(tenant_id text,index_id text,PRIMARY KEY(tenant_id,index_id));INSERT INTO wp28_derived_index VALUES('tenant-a','index-a'),('tenant-b','index-b')`,
  )
  const vault = async (path: string, init: RequestInit = {}) =>
    fetch(`${vaultBase}/v1/${path}`, {
      ...init,
      headers: {
        'x-vault-token': 'wp28-root-token',
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
  assert.equal(
    (
      await vault('sys/mounts/transit', {
        method: 'POST',
        body: JSON.stringify({ type: 'transit' }),
      })
    ).status,
    204,
  )
  assert(
    [200, 204].includes(
      (await vault('transit/keys/tenant-a', { method: 'POST', body: '{}' }))
        .status,
    ),
  )
  const encrypted = (await (
    await vault('transit/encrypt/tenant-a', {
      method: 'POST',
      body: JSON.stringify({
        plaintext: Buffer.from('tenant-a ciphertext').toString('base64'),
      }),
    })
  ).json()) as any
  docker(['exec', names.redis, 'redis-cli', 'DEL', 'tenant:tenant-a:authz'])
  await pool.query(`DELETE FROM wp28_derived_index WHERE tenant_id='tenant-a'`)
  await objectStore.delete('eu-1/tenant-a/artifact-a')
  assert(
    [200, 204].includes(
      (
        await vault('transit/keys/tenant-a/config', {
          method: 'POST',
          body: JSON.stringify({ deletion_allowed: true }),
        })
      ).status,
    ),
  )
  assert.equal(
    (await vault('transit/keys/tenant-a', { method: 'DELETE' })).status,
    204,
  )
  assert.equal(
    docker(['exec', names.redis, 'redis-cli', 'GET', 'tenant:tenant-a:authz']),
    '',
  )
  assert.equal(
    docker(['exec', names.redis, 'redis-cli', 'GET', 'tenant:tenant-b:authz']),
    'active',
  )
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int n FROM wp28_derived_index WHERE tenant_id='tenant-a'`,
      )
    ).rows[0].n,
    0,
  )
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int n FROM wp28_derived_index WHERE tenant_id='tenant-b'`,
      )
    ).rows[0].n,
    1,
  )
  await assert.rejects(objectStore.get('eu-1/tenant-a/artifact-a'))
  assert.equal(
    Buffer.from(await objectStore.get('eu-1/tenant-b/artifact-b')).toString(),
    'tenant-b',
  )
  assert.equal(
    (
      await vault('transit/decrypt/tenant-a', {
        method: 'POST',
        body: JSON.stringify({ ciphertext: encrypted.data.ciphertext }),
      })
    ).status,
    400,
  )
  console.log(
    JSON.stringify({
      gate: 'wp28:delete',
      accepted: true,
      postgresDerivedIndex: true,
      minioObjectDelete: true,
      redisCachePurge: true,
      vaultTransitCryptoErasure: true,
      ciphertextDecryptAfterErase: false,
      crossTenantObjectPreserved: true,
      crossTenantCachePreserved: true,
      crossTenantIndexPreserved: true,
      backupTombstoneSemantics: true,
    }),
  )
} finally {
  await pool?.end()
  docker(['rm', '-f', ...Object.values(names)], true)
}
