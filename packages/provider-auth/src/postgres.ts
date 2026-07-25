import pg from 'pg'
import type { ProviderId } from '@persistent-codex/provider-platform'
import type { EnvelopeV1 } from '@persistent-codex/workspace-security'
import {
  PROVIDER_AUTH_CONTRACT_VERSION,
  oauthTransactionSchema,
  providerAuthProfileMetadataSchema,
  providerUsageLedgerEntrySchema,
  type OAuthTransaction,
  type ProviderAuthMode,
  type ProviderAuthProfileMetadata,
  type ProviderAuthScope,
  type ProviderUsageLedgerEntry,
} from './contracts'
import {
  ProviderAuthError,
  type ProviderAuthKillSwitchRecord,
  type ProviderAuthRepository,
  type StoredProviderCredential,
} from './index'

export class PostgresProviderAuthRepository implements ProviderAuthRepository {
  readonly #pool: pg.Pool
  constructor(pool: pg.Pool) {
    this.#pool = pool
  }
  async close() {
    await this.#pool.end()
  }
  async #withScope<T>(
    scope: ProviderAuthScope,
    run: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        scope.tenantId,
      ])
      await client.query("SELECT set_config('app.organization_id', $1, true)", [
        scope.organizationId,
      ])
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [
        scope.workspaceId,
      ])
      const value = await run(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  #profile(row: Record<string, unknown>): StoredProviderCredential {
    const metadata = providerAuthProfileMetadataSchema.parse({
      schemaVersion: PROVIDER_AUTH_CONTRACT_VERSION,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      profileId: row.profile_id,
      provider: row.provider,
      authMode: row.auth_mode,
      state: row.state,
      credentialVersion: Number(row.credential_version),
      expiresAt: row.expires_at
        ? new Date(String(row.expires_at)).toISOString()
        : null,
      revokedAt: row.revoked_at
        ? new Date(String(row.revoked_at)).toISOString()
        : null,
      disconnectedAt: row.disconnected_at
        ? new Date(String(row.disconnected_at)).toISOString()
        : null,
      cryptoErasedAt: row.crypto_erased_at
        ? new Date(String(row.crypto_erased_at)).toISOString()
        : null,
      version: Number(row.version),
    })
    return {
      ...metadata,
      envelope: (row.credential_envelope as EnvelopeV1 | null) ?? null,
    }
  }

  async putProfile(
    profile: StoredProviderCredential,
    expectedVersion: number | null,
  ) {
    const parsed = providerAuthProfileMetadataSchema.parse(profile)
    await this.#withScope(parsed, async (client) => {
      const values = [
        parsed.tenantId,
        parsed.organizationId,
        parsed.workspaceId,
        parsed.profileId,
        parsed.provider,
        parsed.authMode,
        parsed.state,
        parsed.credentialVersion,
        profile.envelope === null ? null : JSON.stringify(profile.envelope),
        parsed.expiresAt,
        parsed.revokedAt,
        parsed.disconnectedAt,
        parsed.cryptoErasedAt,
        parsed.version,
      ]
      const result =
        expectedVersion === null
          ? await client.query(
              `INSERT INTO persistent_codex.provider_auth_profiles
                (tenant_id, organization_id, workspace_id, profile_id, provider,
                 auth_mode, state, credential_version, credential_envelope,
                 expires_at, revoked_at, disconnected_at, crypto_erased_at, version)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
               ON CONFLICT DO NOTHING`,
              values,
            )
          : await client.query(
              `UPDATE persistent_codex.provider_auth_profiles SET
                 provider=$5, auth_mode=$6, state=$7, credential_version=$8,
                 credential_envelope=$9::jsonb, expires_at=$10, revoked_at=$11,
                 disconnected_at=$12, crypto_erased_at=$13, version=$14,
                 updated_at=now()
               WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
                 AND profile_id=$4 AND version=$15`,
              [...values, expectedVersion],
            )
      if (result.rowCount !== 1)
        throw new ProviderAuthError('PROVIDER_AUTH_VERSION_CONFLICT')
    })
  }

  async getProfile(scope: ProviderAuthScope, profileId: string) {
    return this.#withScope(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.provider_auth_profiles
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND profile_id=$4`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, profileId],
      )
      return result.rows[0] ? this.#profile(result.rows[0]) : undefined
    })
  }

  async listProfiles(scope: ProviderAuthScope) {
    return this.#withScope(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.provider_auth_profiles
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
         ORDER BY provider, profile_id`,
        [scope.tenantId, scope.organizationId, scope.workspaceId],
      )
      return result.rows.map((row) => {
        const { envelope: _envelope, ...metadata } = this.#profile(row)
        return metadata
      })
    })
  }

  async acquireRefreshLock(input: {
    scope: ProviderAuthScope
    profileId: string
    ownerId: string
    expiresAt: string
  }) {
    return this.#withScope(input.scope, async (client) => {
      const result = await client.query(
        `INSERT INTO persistent_codex.provider_credential_refresh_locks
          (tenant_id, organization_id, workspace_id, profile_id, owner_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, organization_id, workspace_id, profile_id)
         DO UPDATE SET owner_id=EXCLUDED.owner_id, expires_at=EXCLUDED.expires_at
         WHERE persistent_codex.provider_credential_refresh_locks.expires_at <= now()`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          input.profileId,
          input.ownerId,
          input.expiresAt,
        ],
      )
      return result.rowCount === 1
    })
  }

  async releaseRefreshLock(input: {
    scope: ProviderAuthScope
    profileId: string
    ownerId: string
  }) {
    await this.#withScope(input.scope, async (client) => {
      await client.query(
        `DELETE FROM persistent_codex.provider_credential_refresh_locks
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND profile_id=$4 AND owner_id=$5`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          input.scope.workspaceId,
          input.profileId,
          input.ownerId,
        ],
      )
    })
  }

  #oauth(row: Record<string, unknown>): OAuthTransaction {
    return oauthTransactionSchema.parse({
      schemaVersion: PROVIDER_AUTH_CONTRACT_VERSION,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      transactionId: row.transaction_id,
      provider: row.provider,
      flowKind: row.flow_kind,
      stateDigest: row.state_digest ?? null,
      pkceChallenge: row.pkce_challenge ?? null,
      secretEnvelope: row.secret_envelope,
      status: row.status,
      expiresAt: new Date(String(row.expires_at)).toISOString(),
      version: Number(row.version),
    })
  }

  async putOAuthTransaction(transaction: OAuthTransaction) {
    const parsed = oauthTransactionSchema.parse(transaction)
    await this.#withScope(parsed, async (client) => {
      const result = await client.query(
        `INSERT INTO persistent_codex.provider_oauth_transactions
          (tenant_id, organization_id, workspace_id, transaction_id, provider,
           flow_kind, state_digest, pkce_challenge, secret_envelope, status,
           expires_at, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
         ON CONFLICT (tenant_id, organization_id, workspace_id, transaction_id)
         DO UPDATE SET secret_envelope=EXCLUDED.secret_envelope,
           status=EXCLUDED.status, version=EXCLUDED.version, updated_at=now()
         WHERE persistent_codex.provider_oauth_transactions.version < EXCLUDED.version`,
        [
          parsed.tenantId,
          parsed.organizationId,
          parsed.workspaceId,
          parsed.transactionId,
          parsed.provider,
          parsed.flowKind,
          parsed.stateDigest,
          parsed.pkceChallenge,
          JSON.stringify(parsed.secretEnvelope),
          parsed.status,
          parsed.expiresAt,
          parsed.version,
        ],
      )
      if (result.rowCount !== 1)
        throw new ProviderAuthError('OAUTH_TRANSACTION_VERSION_CONFLICT')
    })
  }

  async getOAuthTransaction(scope: ProviderAuthScope, transactionId: string) {
    return this.#withScope(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.provider_oauth_transactions
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND transaction_id=$4`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          transactionId,
        ],
      )
      return result.rows[0] ? this.#oauth(result.rows[0]) : undefined
    })
  }

  async findOAuthTransactionByStateDigest(
    scope: ProviderAuthScope,
    stateDigest: string,
  ) {
    return this.#withScope(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.provider_oauth_transactions
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND state_digest=$4`,
        [scope.tenantId, scope.organizationId, scope.workspaceId, stateDigest],
      )
      return result.rows[0] ? this.#oauth(result.rows[0]) : undefined
    })
  }

  async putUsage(entry: ProviderUsageLedgerEntry) {
    const parsed = providerUsageLedgerEntrySchema.parse(entry)
    await this.#withScope(parsed, async (client) => {
      await client.query(
        `INSERT INTO persistent_codex.provider_usage_ledger
          (tenant_id, organization_id, workspace_id, usage_id, provider,
           auth_mode, billing_mode, quantity, unit, monetary_amount_micros,
           currency, estimated, quota_limit, quota_remaining)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          parsed.tenantId,
          parsed.organizationId,
          parsed.workspaceId,
          parsed.usageId,
          parsed.provider,
          parsed.authMode,
          parsed.billingMode,
          parsed.quantity,
          parsed.unit,
          parsed.monetaryAmountMicros,
          parsed.currency,
          parsed.estimated,
          parsed.quotaLimit,
          parsed.quotaRemaining,
        ],
      )
    })
  }

  async listUsage(scope: ProviderAuthScope) {
    return this.#withScope(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.provider_usage_ledger
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
         ORDER BY usage_id`,
        [scope.tenantId, scope.organizationId, scope.workspaceId],
      )
      return result.rows.map((row): ProviderUsageLedgerEntry =>
        providerUsageLedgerEntrySchema.parse({
          schemaVersion: PROVIDER_AUTH_CONTRACT_VERSION,
          tenantId: row.tenant_id,
          organizationId: row.organization_id,
          workspaceId: row.workspace_id,
          usageId: row.usage_id,
          provider: row.provider,
          authMode: row.auth_mode,
          billingMode: row.billing_mode,
          quantity: Number(row.quantity),
          unit: row.unit,
          monetaryAmountMicros:
            row.monetary_amount_micros === null
              ? null
              : Number(row.monetary_amount_micros),
          currency: row.currency,
          estimated: row.estimated,
          quotaLimit: row.quota_limit === null ? null : Number(row.quota_limit),
          quotaRemaining:
            row.quota_remaining === null ? null : Number(row.quota_remaining),
        }),
      )
    })
  }

  async putKillSwitch(
    record: ProviderAuthKillSwitchRecord,
    expectedVersion: number | null,
  ) {
    await this.#withScope(record, async (client) => {
      const values = [
        record.tenantId,
        record.organizationId,
        record.workspaceId,
        record.provider,
        record.authMode,
        record.enabled,
        record.termsEvidenceHash,
        record.version,
      ]
      const result =
        expectedVersion === null
          ? await client.query(
              `INSERT INTO persistent_codex.provider_auth_kill_switches
                (tenant_id, organization_id, workspace_id, provider, auth_mode,
                 enabled, terms_evidence_hash, version)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT DO NOTHING`,
              values,
            )
          : await client.query(
              `UPDATE persistent_codex.provider_auth_kill_switches SET
                 enabled=$6, terms_evidence_hash=$7, version=$8, updated_at=now()
               WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
                 AND provider=$4 AND auth_mode=$5 AND version=$9`,
              [...values, expectedVersion],
            )
      if (result.rowCount !== 1)
        throw new ProviderAuthError('PROVIDER_AUTH_VERSION_CONFLICT')
    })
  }

  async getKillSwitch(
    scope: ProviderAuthScope,
    provider: ProviderId,
    authMode: ProviderAuthMode,
  ) {
    return this.#withScope(scope, async (client) => {
      const result = await client.query(
        `SELECT * FROM persistent_codex.provider_auth_kill_switches
         WHERE tenant_id=$1 AND organization_id=$2 AND workspace_id=$3
           AND provider=$4 AND auth_mode=$5`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          provider,
          authMode,
        ],
      )
      const row = result.rows[0]
      if (!row) return undefined
      return {
        ...scope,
        provider,
        authMode,
        enabled: Boolean(row.enabled),
        termsEvidenceHash: String(row.terms_evidence_hash),
        version: Number(row.version),
      }
    })
  }
}
