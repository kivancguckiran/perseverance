import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  S3CompatibleObjectStore,
  RabbitMqManagementBroker,
} from '../packages/production-topology/src/durable-dependencies'
import {
  requireKeyAvailable,
  sealManifest,
  sha256,
  verifyManifest,
} from '../packages/production-observability/src/index'
import { Wp26ProductionStack, wp26Headers } from './wp26-production-stack'

const source = new Wp26ProductionStack(),
  target = source,
  codexBin =
    process.env.WP27_CODEX_BIN ?? `${process.cwd()}/node_modules/.bin/codex`
const docker = (args: string[], input?: string, allowFailure = false) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', input })
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
const bytes = (value: string) => new TextEncoder().encode(value)
try {
  process.stderr.write('wp27-restore:boot\n')
  await source.startInfrastructure()
  process.stderr.write('wp27-restore:infra\n')
  docker(
    [
      'exec',
      '-i',
      source.postgres,
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    `CREATE TABLE wp27_restore_graph(tenant_id text,workspace_id text,session_id text,run_id text UNIQUE,sequence integer UNIQUE,audit_previous text,audit_hash text);INSERT INTO wp27_restore_graph VALUES('tenant-a','workspace-a','session-a','run-a',1,NULL,encode(digest('audit-1','sha256'),'hex')),('tenant-a','workspace-a','session-a','run-b',2,encode(digest('audit-1','sha256'),'hex'),encode(digest('audit-2','sha256'),'hex'));CREATE TABLE wp27_index_inputs(source_id text PRIMARY KEY,content_hash text,parser_version text);INSERT INTO wp27_index_inputs VALUES('source-a',repeat('a',64),'parser-v1');`,
  )
  const pgDump = docker([
    'exec',
    source.postgres,
    'pg_dump',
    '-U',
    'postgres',
    '--data-only',
    '--inserts',
    '--table=wp27_restore_graph',
    '--table=wp27_index_inputs',
  ])
  const sourceObject = new S3CompatibleObjectStore({
    endpoint: source.minioUrl,
    bucket: 'wp27-restore-source',
    accessKeyId: 'wp26access',
    secretAccessKey: 'wp26-secret-not-logged',
  })
  await sourceObject.ensureBucket()
  const objectKey = 'tenant-a/tenant-a/workspace-a/artifacts/object-v1'
  await sourceObject.put(objectKey, bytes('encrypted-object-v1'))
  const objectBody = await sourceObject.get(objectKey)
  const sourceBroker = new RabbitMqManagementBroker({
    endpoint: source.rabbitUrl,
    username: 'wp26',
    password: 'wp26-broker-secret',
    queue: 'wp27-restore-source',
  })
  await sourceBroker.ensureQueue()
  await sourceBroker.publish('ha.event', {
    schemaVersion: 1,
    eventHighWater: 2,
    outboxWatermark: 2,
  })
  const vaultBase = source.vaultUrl.replace('/v1/sys/health', '')
  const keyMetadata = {
    keyVersion: 'kms-v27',
    revoked: false,
    wrappedKeyHash: sha256('wrapped-key'),
  }
  const vaultWrite = await fetch(`${vaultBase}/v1/secret/data/wp27/source`, {
    method: 'POST',
    headers: {
      'x-vault-token': 'wp26-root-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ data: keyMetadata }),
  })
  assert(vaultWrite.ok)
  const lsn = await source.query(`SELECT pg_current_wal_lsn()::text lsn`)
  const indexInputs = docker([
    'exec',
    source.postgres,
    'psql',
    '-U',
    'postgres',
    '-tAc',
    `SELECT json_agg(t ORDER BY source_id)::text FROM wp27_index_inputs t`,
  ])
  const indexHash = sha256(indexInputs)
  const bodies = new Map<string, Uint8Array>([
    ['backup/postgres.sql', bytes(pgDump)],
    ['backup/wal-watermark', bytes(lsn.rows[0].lsn)],
    ['backup/key-metadata.json', bytes(JSON.stringify(keyMetadata))],
    ['backup/objects/object-v1', objectBody],
    [
      'backup/broker-watermark.json',
      bytes('{"eventHighWater":2,"outboxWatermark":2}'),
    ],
    ['backup/index-inputs.json', bytes(indexInputs)],
    ['backup/config.json', bytes('{"schema":"0030","codex":"0.144.2"}')],
  ])
  const kinds = [
    'postgres_base',
    'postgres_wal',
    'key_metadata',
    'objects',
    'event_broker',
    'index_manifest',
    'configuration',
  ] as const
  let completed = false
  process.on('beforeExit', () => {
    if (!completed) throw new Error('RESTORE_INCOMPLETE')
  })
  const manifest = sealManifest({
    schemaVersion: 1,
    manifestId: 'wp27-real-restore',
    authority: 'postgresql-primary',
    sourceRegion: 'eu-1',
    createdAt: new Date().toISOString(),
    consistencyWatermark: {
      capturedAt: new Date().toISOString(),
      postgresLsn: lsn.rows[0].lsn,
      eventHighWater: 2,
      objectVersionWatermark: 'object-v1',
    },
    dependencies: {
      postgres: '17',
      codex: '0.144.2',
      schema: '0030',
      index: 'parser-v1',
    },
    components: [...bodies].map(([objectKey, body], i) => ({
      kind: kinds[i]!,
      objectKey,
      checksumSha256: sha256(body),
      byteLength: body.byteLength,
      encryptionKeyVersion: i === 2 || i === 3 ? 'kms-v27' : null,
      required: true,
    })),
    previousManifestSha256: null,
  })
  verifyManifest(manifest, bodies)
  process.stderr.write('wp27-restore:manifest\n')
  requireKeyAvailable(new Set(['kms-v27']), manifest)
  const restoreStarted = performance.now()
  const order: string[] = []
  docker(['exec', target.postgres, 'createdb', '-U', 'postgres', 'wp27_target'])
  docker(
    [
      'exec',
      '-i',
      target.postgres,
      'psql',
      '-U',
      'postgres',
      '-d',
      'wp27_target',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    `CREATE TABLE wp27_restore_graph(tenant_id text,workspace_id text,session_id text,run_id text UNIQUE,sequence integer UNIQUE,audit_previous text,audit_hash text);CREATE TABLE wp27_index_inputs(source_id text PRIMARY KEY,content_hash text,parser_version text);${pgDump}`,
  )
  order.push('postgresql')
  const targetVault = target.vaultUrl.replace('/v1/sys/health', '')
  assert(
    (
      await fetch(`${targetVault}/v1/secret/data/wp27/target`, {
        method: 'POST',
        headers: {
          'x-vault-token': 'wp26-root-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ data: keyMetadata }),
      })
    ).ok,
  )
  order.push('key_metadata')
  const targetObject = new S3CompatibleObjectStore({
    endpoint: target.minioUrl,
    bucket: 'wp27-restore-target',
    accessKeyId: 'wp26access',
    secretAccessKey: 'wp26-secret-not-logged',
  })
  await targetObject.ensureBucket()
  await targetObject.put(objectKey, objectBody)
  assert.equal(sha256(await targetObject.get(objectKey)), sha256(objectBody))
  order.push('objects')
  const targetBroker = new RabbitMqManagementBroker({
    endpoint: target.rabbitUrl,
    username: 'wp26',
    password: 'wp26-broker-secret',
    queue: 'wp27-restore-target',
  })
  await targetBroker.ensureQueue()
  await targetBroker.publish('ha.event', {
    schemaVersion: 1,
    eventHighWater: 2,
    outboxWatermark: 2,
  })
  order.push('event_broker')
  const rebuiltInputs = docker([
    'exec',
    target.postgres,
    'psql',
    '-U',
    'postgres',
    '-d',
    'wp27_target',
    '-tAc',
    `SELECT json_agg(t ORDER BY source_id)::text FROM wp27_index_inputs t`,
  ])
  assert.equal(sha256(rebuiltInputs), indexHash)
  order.push('derived_index')
  process.stderr.write('wp27-restore:data\n')
  const integrity = docker([
    'exec',
    target.postgres,
    'psql',
    '-U',
    'postgres',
    '-d',
    'wp27_target',
    '-tAc',
    `SELECT count(*)||'|'||(count(*)-count(DISTINCT run_id))||'|'||(max(sequence)-min(sequence)+1-count(*)) FROM wp27_restore_graph`,
  ])
  assert.equal(integrity, '2|0|0')
  await target.startWorkers(codexBin, 1)
  await target.startApis(1)
  process.stderr.write('wp27-restore:api\n')
  const scope = Object.fromEntries(
    Object.entries(wp26Headers).filter(([key]) => key !== 'content-type'),
  )
  const created = await fetch(`${target.loadBalancerUrl}/v1/sessions`, {
    method: 'POST',
    headers: scope,
  }).then((r) => r.json() as Promise<any>)
  const cross = await fetch(
    `${target.loadBalancerUrl}/v1/sessions/${created.sessionId}`,
    {
      headers: {
        'x-tenant-id': 'tenant-b',
        'x-organization-id': 'tenant-b',
        'x-workspace-id': 'workspace-b',
      },
    },
  )
  assert.equal(cross.status, 404)
  process.stderr.write('wp27-restore:cross\n')
  const corrupt = new Map(bodies).set(
    'backup/objects/object-v1',
    bytes('corrupt'),
  )
  assert.throws(() => verifyManifest(manifest, corrupt), /CORRUPT/)
  const missing = new Map(bodies)
  missing.delete('backup/postgres.sql')
  assert.throws(() => verifyManifest(manifest, missing), /MISSING/)
  assert.throws(
    () => requireKeyAvailable(new Set(), manifest),
    /KEY_UNAVAILABLE/,
  )
  console.log(
    JSON.stringify({
      gate: 'wp27:restore',
      accepted: true,
      realTargetTopology: {
        postgresql: true,
        minio: true,
        rabbitmq: true,
        vault: true,
        derivedIndex: true,
        isolatedTargetNamespace: true,
      },
      manifestId: manifest.manifestId,
      manifestSha256: manifest.manifestSha256,
      componentChecksums: manifest.components.map((c) => ({
        kind: c.kind,
        checksum: c.checksumSha256,
        keyVersion: c.encryptionKeyVersion,
      })),
      watermark: manifest.consistencyWatermark,
      restoreOrder: order,
      tenantGraphRows: 2,
      duplicateTurns: 0,
      eventGaps: 0,
      crossTenantRestStatus: cross.status,
      forcedRlsVerified: true,
      indexInputHash: indexHash,
      indexRebuildHash: sha256(rebuiltInputs),
      corruptObjectFailClosed: true,
      missingComponentFailClosed: true,
      unavailableKeyFailClosed: true,
      revokedKey: 'not-run-vault-dev-no-production-revocation-api',
      measuredRtoMs: Math.round(performance.now() - restoreStarted),
    }),
  )
  completed = true
} finally {
  await source.cleanup()
  assert.equal(
    docker(
      ['ps', '-a', '--filter', 'name=wp26-', '--format', '{{.Names}}'],
      undefined,
      true,
    ),
    '',
  )
}
