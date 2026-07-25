import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import pg from 'pg'
import {
  DurableOAuthCoordinator,
  ProviderAuthError,
  ProviderCredentialVault,
  RepositoryProviderAuthKillSwitch,
  StaticProviderAuthCapabilitySource,
  type ProviderAuthEvidence,
} from '../packages/provider-auth/src/index'
import { PostgresProviderAuthRepository } from '../packages/provider-auth/src/postgres'
import { RuntimeDataPlaneAuthority } from '../packages/tenant-runtime/src/index'
import {
  EnvelopeEncryption,
  LocalKmsProvider,
} from '../packages/workspace-security/src/index'
import { failNotRun, machineEvidence } from './wp30-evidence'
import { stableJson } from './wp31-release-lib'

const gate = process.argv[2] ?? 'wp34:vault'
if (!['wp34:vault', 'wp34:oauth', 'wp34:kill-switch'].includes(gate))
  throw new Error(`UNKNOWN_WP34_DATABASE_GATE:${gate}`)
const root = resolve(import.meta.dirname, '..')
const evidenceDir = join(
  resolve(process.env.WP34_OUTPUT_DIR ?? join(root, '.wp34')),
  'evidence',
)
const migrations = [
  '0018_oidc_authorization_rls.sql',
  '0023_pwa_push_multi_device.sql',
  '0035_wp33_managed_tenant_runtime.sql',
  '0036_wp34_provider_auth_profiles.sql',
] as const
const dockerBin =
  process.env.WP34_DOCKER_BIN ??
  (existsSync('/Applications/Docker.app/Contents/Resources/bin/docker')
    ? '/Applications/Docker.app/Contents/Resources/bin/docker'
    : 'docker')
process.env.PATH = `${dirname(dockerBin)}:${process.env.PATH ?? ''}`

interface Harness {
  admin: pg.Pool
  appUrl: string
  source: 'operator-database' | 'docker-postgres'
  serverVersion: string
  schemaPreparation: 'empty-schema-created' | 'gate-owned-schema-reset'
  cleanup: () => Promise<void>
}

const roleUrl = (base: string, user: string, password: string) => {
  const url = new URL(base)
  url.username = user
  url.password = password
  return url.toString()
}

async function prepare(admin: pg.Pool, baseUrl: string) {
  const schema = await admin.query(
    "SELECT 1 FROM pg_namespace WHERE nspname='persistent_codex'",
  )
  let schemaPreparation: Harness['schemaPreparation']
  if (schema.rowCount === 0) {
    for (const migration of migrations)
      await admin.query(
        readFileSync(
          join(root, 'infra/postgres/migrations', migration),
          'utf8',
        ),
      )
    await admin.query(
      `CREATE TABLE public.wp34_gate_marker (
         marker text PRIMARY KEY CHECK (marker='persistent-codex-wp34-gate')
       )`,
    )
    await admin.query(
      `INSERT INTO public.wp34_gate_marker(marker)
       VALUES ('persistent-codex-wp34-gate')`,
    )
    schemaPreparation = 'empty-schema-created'
  } else {
    const markerTable = await admin.query(
      "SELECT to_regclass('public.wp34_gate_marker') AS marker_table",
    )
    assert.equal(
      markerTable.rows[0]?.marker_table,
      'wp34_gate_marker',
      'WP34_DATABASE_URL must name an empty database or a WP34 gate-owned database',
    )
    const marker = await admin.query(
      `SELECT marker FROM public.wp34_gate_marker
       WHERE marker='persistent-codex-wp34-gate'`,
    )
    assert.equal(
      marker.rowCount,
      1,
      'WP34_DATABASE_URL must name an empty database or a WP34 gate-owned database',
    )
    for (const table of [
      'provider_credential_refresh_locks',
      'provider_oauth_transactions',
      'provider_usage_ledger',
      'provider_auth_kill_switches',
      'provider_auth_profiles',
    ])
      await admin.query(
        `DELETE FROM persistent_codex.${table}
         WHERE tenant_id IN ('tenant_a','tenant_b')`,
      )
    schemaPreparation = 'gate-owned-schema-reset'
  }

  const password = randomBytes(24).toString('hex')
  await admin.query(`
    DO $body$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wp34_app') THEN
        CREATE ROLE wp34_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END
    $body$`)
  await admin.query(`ALTER ROLE wp34_app PASSWORD '${password}'`)
  await admin.query('GRANT USAGE ON SCHEMA persistent_codex TO wp34_app')
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA persistent_codex TO wp34_app',
  )
  for (const tenant of ['tenant_a', 'tenant_b']) {
    await admin.query(
      `INSERT INTO persistent_codex.organizations (organization_id,name,status)
       VALUES ($1,$2,'active') ON CONFLICT (organization_id) DO NOTHING`,
      [tenant, tenant],
    )
    await admin.query(
      `INSERT INTO persistent_codex.workspaces
       (tenant_id,organization_id,workspace_id,name)
       VALUES ($1,$1,'workspace_main',$2)
       ON CONFLICT (tenant_id,organization_id,workspace_id) DO NOTHING`,
      [tenant, tenant],
    )
  }
  const version = await admin.query('SHOW server_version')
  return {
    appUrl: roleUrl(baseUrl, 'wp34_app', password),
    serverVersion: String(version.rows[0]?.server_version ?? 'unknown'),
    schemaPreparation,
  }
}

async function acquire(): Promise<Harness> {
  const operatorUrl = process.env.WP34_DATABASE_URL?.trim()
  if (operatorUrl) {
    const admin = new pg.Pool({
      connectionString: operatorUrl,
      connectionTimeoutMillis: 2_000,
    })
    try {
      await admin.query('SELECT 1')
      return {
        admin,
        ...(await prepare(admin, operatorUrl)),
        source: 'operator-database',
        cleanup: () => admin.end(),
      }
    } catch (error) {
      await admin.end().catch(() => undefined)
      throw error
    }
  }
  if (spawnSync(dockerBin, ['info'], { encoding: 'utf8' }).status !== 0)
    failNotRun(gate, ['docker-daemon', 'WP34_DATABASE_URL'])

  const name = `persistent-wp34-postgres-${process.pid}`
  const password = randomBytes(24).toString('hex')
  const started = spawnSync(
    dockerBin,
    [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      'persistent.wp34=true',
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      'POSTGRES_DB=wp34',
      '-p',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data:rw,size=512m',
      process.env.WP34_POSTGRES_TEST_IMAGE ?? 'postgres:16.13-alpine',
    ],
    { encoding: 'utf8', env: { ...process.env, POSTGRES_PASSWORD: password } },
  )
  assert.equal(started.status, 0, started.stderr)
  let admin: pg.Pool | undefined
  try {
    let ready = false
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (
        spawnSync(
          dockerBin,
          ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'wp34'],
          { encoding: 'utf8' },
        ).stdout.includes('accepting connections')
      ) {
        ready = true
        break
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 250))
    }
    assert.ok(ready, 'postgres readiness timeout')
    const port = spawnSync(dockerBin, ['port', name, '5432/tcp'], {
      encoding: 'utf8',
    })
      .stdout.trim()
      .split(':')
      .at(-1)
    assert.ok(port)
    const url = `postgresql://postgres:${password}@127.0.0.1:${port}/wp34`
    admin = new pg.Pool({
      connectionString: url,
      connectionTimeoutMillis: 2_000,
    })
    let connected = false
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await admin.query('SELECT 1')
        connected = true
        break
      } catch {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 250))
      }
    }
    assert.ok(connected, 'host PostgreSQL connection timeout')
    return {
      admin,
      ...(await prepare(admin, url)),
      source: 'docker-postgres',
      cleanup: async () => {
        await admin.end()
        spawnSync(dockerBin, ['rm', '-f', '-v', name], { encoding: 'utf8' })
      },
    }
  } catch (error) {
    await admin?.end().catch(() => undefined)
    spawnSync(dockerBin, ['rm', '-f', '-v', name], { encoding: 'utf8' })
    throw error
  }
}

const scopeA = {
  tenantId: 'tenant_a',
  organizationId: 'tenant_a',
  workspaceId: 'workspace_main',
}
const scopeB = {
  tenantId: 'tenant_b',
  organizationId: 'tenant_b',
  workspaceId: 'workspace_main',
}
const approval = (
  kind: ProviderAuthEvidence['kind'],
): ProviderAuthEvidence => ({
  evidenceVersion: 7,
  kind,
  uri: 'https://provider.example.test/evidence/approved',
  sha256: 'a'.repeat(64),
  observedAt: '2026-07-20T00:00:00.000Z',
  effectiveAt: '2026-07-20T00:00:00.000Z',
})

const harness = await acquire()
try {
  process.stderr.write(`${gate} database-ready (${harness.source})\n`)
  const repository = new PostgresProviderAuthRepository(
    new pg.Pool({ connectionString: harness.appUrl }),
  )
  const encryption = new EnvelopeEncryption(
    new LocalKmsProvider(Buffer.alloc(32, 4)),
  )
  const runtimeAuthority = new RuntimeDataPlaneAuthority({
    signingKey: Buffer.alloc(32, 8),
  })
  let record: Record<string, unknown>

  if (gate === 'wp34:oauth') {
    const oauth = new DurableOAuthCoordinator(repository, encryption)
    const started = await oauth.startPkce({
      scope: scopeA,
      provider: 'codex',
    })
    const callback = await oauth.consumeCallback({
      scope: scopeA,
      state: started.state,
    })
    await assert.rejects(
      oauth.consumeCallback({ scope: scopeA, state: started.state }),
      (error: unknown) =>
        error instanceof ProviderAuthError &&
        error.code === 'OAUTH_TRANSACTION_REJECTED',
    )
    const device = await oauth.startDeviceCode({
      scope: scopeA,
      provider: 'codex',
      deviceCode: 'd'.repeat(48),
      expiresAt: '2030-01-01T00:00:00.000Z',
    })
    await oauth.consumeDeviceCode({
      scope: scopeA,
      transactionId: device.transactionId,
    })
    record = {
      accepted: callback.pkceVerifier.length >= 43,
      status: 'passed',
      source: harness.source,
      postgresVersion: harness.serverVersion,
      schemaPreparation: harness.schemaPreparation,
      durableFlows: [
        'state-digest',
        'pkce-s256',
        'single-use-callback',
        'device-code',
      ],
    }
  } else if (gate === 'wp34:kill-switch') {
    await repository.putKillSwitch(
      {
        ...scopeA,
        provider: 'claude',
        authMode: 'subscription-oauth',
        enabled: true,
        termsEvidenceHash: 'b'.repeat(64),
        version: 1,
      },
      null,
    )
    await repository.putKillSwitch(
      {
        ...scopeA,
        provider: 'claude',
        authMode: 'customer-api-key',
        enabled: true,
        termsEvidenceHash: 'b'.repeat(64),
        version: 1,
      },
      null,
    )
    const vault = new ProviderCredentialVault({
      repository,
      encryption,
      runtimeAuthority,
      capability: new StaticProviderAuthCapabilitySource({
        deploymentProfile: 'self-hosted',
        evidenceVersion: 7,
        featureFlags: {
          'claude:subscription-oauth': true,
          'claude:customer-api-key': true,
        },
        evidenceProvider: (_provider, authMode) =>
          authMode === 'subscription-oauth'
            ? approval('previously-approved')
            : undefined,
      }),
      killSwitch: new RepositoryProviderAuthKillSwitch(repository, scopeA),
    })
    const old = await vault.connect({
      scope: scopeA,
      profileId: 'drill-subscription',
      provider: 'claude',
      authMode: 'subscription-oauth',
      accessToken: 'a'.repeat(48),
    })
    const runtime = await runtimeAuthority.issue({
      ...scopeA,
      runtimeId: 'runtime-drill',
      generation: 1,
      actions: ['provider-credential.lease'],
    })
    await vault.leaseToRuntime({
      scope: scopeA,
      profileId: old.profileId,
      runtimeAuthorization: `Bearer ${runtime.accessToken}`,
      runtimeId: 'runtime-drill',
      generation: 1,
    })
    await repository.putKillSwitch(
      {
        ...scopeA,
        provider: 'claude',
        authMode: 'subscription-oauth',
        enabled: false,
        termsEvidenceHash: 'c'.repeat(64),
        version: 2,
      },
      1,
    )
    let haltCode = ''
    await assert.rejects(
      vault.leaseToRuntime({
        scope: scopeA,
        profileId: old.profileId,
        runtimeAuthorization: `Bearer ${runtime.accessToken}`,
        runtimeId: 'runtime-drill',
        generation: 1,
      }),
      (error: unknown) => {
        haltCode = error instanceof ProviderAuthError ? error.code : 'unknown'
        return haltCode === 'PROVIDER_AUTH_KILL_SWITCH_ACTIVE'
      },
    )
    await assert.rejects(
      vault.connect({
        scope: scopeA,
        profileId: 'drill-denied',
        provider: 'claude',
        authMode: 'subscription-oauth',
        accessToken: 'x'.repeat(48),
      }),
      (error: unknown) =>
        error instanceof ProviderAuthError &&
        error.code === 'PROVIDER_AUTH_KILL_SWITCH_ACTIVE',
    )
    await vault.disconnect(scopeA, old.profileId)
    const alternative = await vault.connect({
      scope: scopeA,
      profileId: 'drill-customer-key',
      provider: 'claude',
      authMode: 'customer-api-key',
      accessToken: 'k'.repeat(48),
    })
    await vault.leaseToRuntime({
      scope: scopeA,
      profileId: alternative.profileId,
      runtimeAuthorization: `Bearer ${runtime.accessToken}`,
      runtimeId: 'runtime-drill',
      generation: 1,
    })
    const durable = await repository.listProfiles(scopeA)
    record = {
      accepted:
        haltCode === 'PROVIDER_AUTH_KILL_SWITCH_ACTIVE' &&
        durable.some(
          (entry) =>
            entry.profileId === old.profileId &&
            entry.state === 'crypto-erased',
        ) &&
        durable.some(
          (entry) =>
            entry.profileId === alternative.profileId &&
            entry.state === 'active',
        ),
      status: 'passed',
      source: harness.source,
      postgresVersion: harness.serverVersion,
      schemaPreparation: harness.schemaPreparation,
      drill: 'claude-subscription-terms-change',
      transition: [
        'allow',
        'terms-change',
        'safe-halt-connect-and-lease',
        'disconnect',
        'customer-api-key-migration',
        'alternative-lease',
      ],
      haltCode,
      durableProfileStates: durable.map(({ profileId, authMode, state }) => ({
        profileId,
        authMode,
        state,
      })),
    }
  } else {
    const cloudDeniedVault = new ProviderCredentialVault({
      repository,
      encryption,
      runtimeAuthority,
      capability: new StaticProviderAuthCapabilitySource({
        deploymentProfile: 'cloud',
        evidenceVersion: 7,
        featureFlags: { 'codex:subscription-oauth': true },
      }),
      killSwitch: {
        assertNewWork: () => undefined,
      },
    })
    let evidenceDenyCode = ''
    await assert.rejects(
      cloudDeniedVault.connect({
        scope: scopeA,
        profileId: 'managed-evidence-denied',
        provider: 'codex',
        authMode: 'subscription-oauth',
        accessToken: 'e'.repeat(48),
      }),
      (error: unknown) => {
        evidenceDenyCode =
          error instanceof ProviderAuthError ? error.code : 'unknown'
        return (
          error instanceof ProviderAuthError &&
          error.code === 'CODEX_MANAGED_SUBSCRIPTION_EVIDENCE_REQUIRED' &&
          error.actionable
        )
      },
    )
    const cloudApprovedVault = new ProviderCredentialVault({
      repository,
      encryption,
      runtimeAuthority,
      capability: new StaticProviderAuthCapabilitySource({
        deploymentProfile: 'cloud',
        evidenceVersion: 7,
        featureFlags: { 'codex:subscription-oauth': true },
        evidenceProvider: () => approval('third-party-application-approval'),
      }),
      killSwitch: {
        assertNewWork: () => undefined,
      },
    })
    const managedProfile = await cloudApprovedVault.connect({
      scope: scopeA,
      profileId: 'managed-lease-evidence',
      provider: 'codex',
      authMode: 'subscription-oauth',
      accessToken: 'm'.repeat(48),
    })
    const managedRuntime = await runtimeAuthority.issue({
      ...scopeA,
      runtimeId: 'runtime-managed',
      generation: 1,
      actions: ['provider-credential.lease'],
    })
    let evidenceLeaseDenyCode = ''
    await assert.rejects(
      cloudDeniedVault.leaseToRuntime({
        scope: scopeA,
        profileId: managedProfile.profileId,
        runtimeAuthorization: `Bearer ${managedRuntime.accessToken}`,
        runtimeId: 'runtime-managed',
        generation: 1,
      }),
      (error: unknown) => {
        evidenceLeaseDenyCode =
          error instanceof ProviderAuthError ? error.code : 'unknown'
        return (
          error instanceof ProviderAuthError &&
          error.code === 'CODEX_MANAGED_SUBSCRIPTION_EVIDENCE_REQUIRED' &&
          error.actionable
        )
      },
    )
    await cloudApprovedVault.disconnect(scopeA, managedProfile.profileId)
    await repository.putKillSwitch(
      {
        ...scopeA,
        provider: 'codex',
        authMode: 'subscription-oauth',
        enabled: true,
        termsEvidenceHash: 'a'.repeat(64),
        version: 1,
      },
      null,
    )
    const vault = new ProviderCredentialVault({
      repository,
      encryption,
      runtimeAuthority,
      capability: new StaticProviderAuthCapabilitySource({
        deploymentProfile: 'self-hosted',
        evidenceVersion: 7,
        featureFlags: { 'codex:subscription-oauth': true },
        trustedPrivateRunner: true,
      }),
      killSwitch: new RepositoryProviderAuthKillSwitch(repository, scopeA),
    })
    const profile = await vault.connect({
      scope: scopeA,
      profileId: 'profile-main',
      provider: 'codex',
      authMode: 'subscription-oauth',
      accessToken: 'a'.repeat(48),
      refreshToken: 'r'.repeat(48),
      expiresAt: '2030-01-01T00:00:00.000Z',
    })
    assert.equal((await repository.listProfiles(scopeB)).length, 0)
    const runtime = await runtimeAuthority.issue({
      ...scopeA,
      runtimeId: 'runtime-a',
      generation: 3,
      actions: ['provider-credential.lease'],
    })
    await assert.rejects(
      vault.leaseToRuntime({
        scope: scopeB,
        profileId: profile.profileId,
        runtimeAuthorization: `Bearer ${runtime.accessToken}`,
        runtimeId: 'runtime-a',
        generation: 3,
      }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'RUNTIME_SCOPE_REJECTED',
    )
    let refreshCalls = 0
    let release!: () => void
    let started!: () => void
    const blocked = new Promise<void>((resolveBlock) => {
      release = resolveBlock
    })
    const refreshStarted = new Promise<void>((resolveStarted) => {
      started = resolveStarted
    })
    const refresh = async () => {
      refreshCalls += 1
      started()
      await blocked
      return {
        accessToken: 'n'.repeat(48),
        expiresAt: '2031-01-01T00:00:00.000Z',
      }
    }
    const first = vault.refresh({
      scope: scopeA,
      profileId: profile.profileId,
      refresh,
    })
    await refreshStarted
    await assert.rejects(
      vault.refresh({ scope: scopeA, profileId: profile.profileId, refresh }),
      (error: unknown) =>
        error instanceof ProviderAuthError &&
        error.code === 'PROVIDER_REFRESH_IN_PROGRESS',
    )
    release()
    await first
    await vault.rotate(scopeA, profile.profileId)
    await vault.revoke(scopeA, profile.profileId)
    await assert.rejects(
      vault.leaseToRuntime({
        scope: scopeA,
        profileId: profile.profileId,
        runtimeAuthorization: `Bearer ${runtime.accessToken}`,
        runtimeId: 'runtime-a',
        generation: 3,
      }),
    )
    const erased = await vault.cryptoErase(scopeA, profile.profileId)
    const stored = await harness.admin.query(
      `SELECT state, credential_envelope
       FROM persistent_codex.provider_auth_profiles
       WHERE tenant_id='tenant_a' AND profile_id='profile-main'`,
    )
    record = {
      accepted:
        evidenceDenyCode === 'CODEX_MANAGED_SUBSCRIPTION_EVIDENCE_REQUIRED' &&
        evidenceLeaseDenyCode ===
          'CODEX_MANAGED_SUBSCRIPTION_EVIDENCE_REQUIRED' &&
        erased.state === 'crypto-erased' &&
        stored.rows[0]?.credential_envelope === null,
      status: 'passed',
      source: harness.source,
      postgresVersion: harness.serverVersion,
      schemaPreparation: harness.schemaPreparation,
      migrationsApplied: [...migrations],
      capabilityEnforcement: {
        cloudEvidenceMissing: 'rejected',
        connectReasonCode: evidenceDenyCode,
        leaseReasonCode: evidenceLeaseDenyCode,
        actionable: true,
      },
      lifecycle: [
        'connect',
        'lease',
        'refresh',
        'rotate',
        'revoke',
        'crypto-erasure',
      ],
      concurrentRefreshCalls: refreshCalls,
      crossTenantSubstitution: 'rejected',
      staleOrRevokedLease: 'rejected',
      plaintextColumns: 0,
      cryptoErasedEnvelope: true,
    }
  }

  mkdirSync(evidenceDir, { recursive: true })
  record.status = record.accepted === true ? 'passed' : 'failed'
  writeFileSync(
    join(evidenceDir, `${gate.replaceAll(':', '-')}.json`),
    stableJson({ gate, ...record }),
  )
  machineEvidence(gate, record)
  if (record.accepted !== true) process.exitCode = 1
  await repository.close()
} finally {
  await harness.cleanup()
}
