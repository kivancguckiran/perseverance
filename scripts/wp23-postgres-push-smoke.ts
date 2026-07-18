import { strict as assert } from 'node:assert'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  EnvelopeEncryption,
  LocalKmsProvider,
} from '../packages/workspace-security/src/index.ts'
import {
  createPostgresPushRepository,
  PushProviderEmulator,
} from '../packages/push-notifications/src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'wp23-postgres-'))
const container = `persistent-wp23-${randomUUID()}`
const volume = `${container}-data`
const image = process.env.WP23_POSTGRES_IMAGE ?? 'postgres:17-alpine'
const claimableNow = () => new Date(Date.now() + 1_000)

function docker(args: string[], input?: string) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input })
  if (result.status !== 0)
    throw new Error(
      result.stderr || result.stdout || `docker ${args.join(' ')} failed`,
    )
  return result.stdout.trim()
}

try {
  docker(['volume', 'create', volume])
  docker([
    'run',
    '-d',
    '--name',
    container,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-v',
    `${volume}:/var/lib/postgresql/data`,
    '-p',
    '127.0.0.1::5432',
    image,
  ])
  let ready = false
  let consecutiveReady = 0
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = spawnSync('docker', [
      'exec',
      container,
      'pg_isready',
      '-U',
      'postgres',
    ])
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
      `PostgreSQL did not become ready: ${docker(['logs', container])}`,
    )
  for (const migration of [
    '0018_oidc_authorization_rls.sql',
    '0023_pwa_push_multi_device.sql',
  ])
    docker(
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
      readFileSync(join('infra/postgres/migrations', migration), 'utf8'),
    )

  docker(
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
    `
    CREATE ROLE push_runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    GRANT USAGE ON SCHEMA persistent_codex TO push_runtime;
    GRANT SELECT,INSERT,UPDATE ON persistent_codex.push_devices,persistent_codex.push_subscriptions,persistent_codex.push_notification_outbox,persistent_codex.push_delivery_receipts TO push_runtime;
    GRANT EXECUTE ON FUNCTION persistent_codex.push_enqueue_notification(text,text,text,text,jsonb), persistent_codex.push_claim_deliveries(timestamptz,integer), persistent_codex.push_complete_delivery(text,text,text,text,text,text,integer,text,text,timestamptz), persistent_codex.push_expire_subscriptions(timestamptz), persistent_codex.push_resolve_notification(text,text,timestamptz) TO push_runtime;
    INSERT INTO persistent_codex.organizations VALUES ('org_a','A','active'),('org_b','B','active');
    INSERT INTO persistent_codex.workspaces (tenant_id,organization_id,workspace_id,name) VALUES ('org_a','org_a','wsp_a','A'),('org_b','org_b','wsp_b','B');
  `,
  )
  const port = docker(['port', container, '5432/tcp']).split(':').at(-1)!
  const connectionString = `postgresql://push_runtime:runtime@127.0.0.1:${port}/postgres`
  const repository = createPostgresPushRepository({
    connectionString,
    encryption: new EnvelopeEncryption(
      new LocalKmsProvider(
        createHash('sha256').update('wp23-postgres').digest(),
      ),
    ),
  })
  const scopeA = {
    tenantId: 'org_a',
    organizationId: 'org_a',
    workspaceId: 'wsp_a',
    principalId: 'principal_a',
  }
  const scopeB = {
    tenantId: 'org_b',
    organizationId: 'org_b',
    workspaceId: 'wsp_b',
    principalId: 'principal_b',
  }
  const subscription = await repository.upsert(scopeA, {
    version: 1,
    deviceId: 'device_a',
    endpoint: 'https://push.invalid.test/ok',
    keys: { p256dh: 'p'.repeat(32), auth: 'a'.repeat(16) },
    expiresAt: null,
  })
  await repository.upsert(scopeB, {
    version: 1,
    deviceId: 'device_b',
    endpoint: 'https://push.invalid.test/tenant-b',
    keys: { p256dh: 'q'.repeat(32), auth: 'b'.repeat(16) },
    expiresAt: null,
  })
  assert.equal((await repository.list(scopeA)).length, 1)
  assert.equal(
    (await repository.list({ ...scopeA, principalId: 'principal_b' })).length,
    0,
  )
  assert.equal(
    await repository.enqueue(
      { tenantId: 'org_a', organizationId: 'org_a', workspaceId: 'wsp_a' },
      {
        notificationId: 'notification_1',
        sessionId: 'session_1',
        approvalId: 'approval_1',
        status: 'approval_required',
      },
    ),
    1,
  )
  assert.equal(
    await repository.enqueue(
      { tenantId: 'org_a', organizationId: 'org_a', workspaceId: 'wsp_a' },
      {
        notificationId: 'notification_1',
        sessionId: 'session_1',
        approvalId: 'approval_1',
        status: 'approval_required',
      },
    ),
    0,
  )
  const emulator = new PushProviderEmulator()
  assert.equal(
    (await repository.drain(emulator, claimableNow())).at(0)?.outcome,
    'delivered',
  )
  assert.equal(
    (
      await repository.resolveNotification(
        'principal_a',
        'notification_1',
        new Date(),
      )
    )?.workspaceId,
    'wsp_a',
  )
  assert.equal(
    await repository.resolveNotification(
      'principal_b',
      'notification_1',
      new Date(),
    ),
    undefined,
  )
  const payload = JSON.stringify(emulator.deliveries)
  for (const forbidden of [
    'prompt',
    'output',
    'reasoning',
    'command',
    'diff',
    'filename',
    'citation',
    'Bearer ',
    'sk-',
  ])
    assert(!payload.includes(forbidden))

  await repository.upsert(scopeA, {
    version: 1,
    deviceId: 'device_a',
    endpoint: 'https://push.invalid.test/retry',
    keys: { p256dh: 'r'.repeat(32), auth: 'c'.repeat(16) },
    expiresAt: null,
  })
  await repository.enqueue(
    { tenantId: 'org_a', organizationId: 'org_a', workspaceId: 'wsp_a' },
    {
      notificationId: 'notification_retry',
      sessionId: 'session_1',
      approvalId: null,
      status: 'turn_failed',
    },
  )
  assert.equal(
    (await repository.drain(emulator, claimableNow())).at(0)?.outcome,
    'retry',
  )
  await repository.upsert(scopeA, {
    version: 1,
    deviceId: 'device_a',
    endpoint: 'https://push.invalid.test/invalid',
    keys: { p256dh: 'r'.repeat(32), auth: 'c'.repeat(16) },
    expiresAt: null,
  })
  await repository.enqueue(
    { tenantId: 'org_a', organizationId: 'org_a', workspaceId: 'wsp_a' },
    {
      notificationId: 'notification_2',
      sessionId: 'session_1',
      approvalId: null,
      status: 'turn_completed',
    },
  )
  assert.equal(
    (await repository.drain(emulator, claimableNow())).at(0)?.outcome,
    'invalid_endpoint',
  )
  assert.equal((await repository.list(scopeA))[0]?.status, 'invalid')
  await assert.rejects(
    repository.revoke(
      scopeA,
      subscription.subscriptionId,
      subscription.revision,
    ),
    { code: 'PUSH_SUBSCRIPTION_VERSION_CONFLICT' },
  )

  await repository.upsert(scopeA, {
    version: 1,
    deviceId: 'device_expired',
    endpoint: 'https://push.invalid.test/expired',
    keys: { p256dh: 's'.repeat(32), auth: 'd'.repeat(16) },
    expiresAt: '2026-07-18T00:00:00.000Z',
  })
  assert.equal(await repository.expire(new Date('2026-07-18T00:00:01.000Z')), 1)
  docker(
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
    `SELECT persistent_codex.push_complete_delivery(tenant_id,organization_id,workspace_id,principal_id,outbox_id,subscription_id,attempt,'delivered',NULL,now()) FROM persistent_codex.push_notification_outbox WHERE notification_id='notification_1';`,
  )
  assert.equal(
    Number(
      docker([
        'exec',
        container,
        'psql',
        '-U',
        'postgres',
        '-tAc',
        'SELECT count(*) FROM persistent_codex.push_delivery_receipts',
      ]),
    ),
    3,
  )
  await repository.close()
  console.log(
    JSON.stringify({
      migration: '0023_pwa_push_multi_device.sql',
      forcedRls: true,
      crossTenantVisible: 0,
      duplicateOutbox: 0,
      duplicateDeliveryReceipt: 0,
      delivered: 1,
      retried: 1,
      invalidEndpoint: 1,
      expired: 1,
      provider: 'emulator',
    }),
  )
} finally {
  spawnSync('docker', ['rm', '-f', container])
  spawnSync('docker', ['volume', 'rm', '-f', volume])
  rmSync(root, { recursive: true, force: true })
}
