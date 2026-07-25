-- WP34 — provider auth profiles, durable OAuth and credential lifecycle (ADR-0034).
-- Plaintext credential/token/state/device-code is forbidden in every table.

BEGIN;

CREATE TABLE IF NOT EXISTS persistent_codex.provider_auth_profiles (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  profile_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('codex','claude','gemini','cursor')),
  auth_mode text NOT NULL CHECK (auth_mode IN (
    'subscription-oauth','customer-api-key','platform-credit','local-cli-credential'
  )),
  state text NOT NULL CHECK (state IN (
    'active','expired','revoked','disconnected','crypto-erased'
  )),
  credential_version bigint NOT NULL CHECK (credential_version > 0),
  credential_envelope jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  disconnected_at timestamptz,
  crypto_erased_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, profile_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id, organization_id, workspace_id),
  CONSTRAINT provider_auth_profiles_tenant_matches_organization
    CHECK (tenant_id = organization_id),
  CONSTRAINT provider_auth_profiles_crypto_erasure
    CHECK ((state = 'crypto-erased') = (credential_envelope IS NULL))
);

CREATE TABLE IF NOT EXISTS persistent_codex.provider_credential_refresh_locks (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  profile_id text NOT NULL,
  owner_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, profile_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, profile_id)
    REFERENCES persistent_codex.provider_auth_profiles(
      tenant_id, organization_id, workspace_id, profile_id
    ) ON DELETE CASCADE,
  CONSTRAINT provider_refresh_locks_tenant_matches_organization
    CHECK (tenant_id = organization_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.provider_oauth_transactions (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  transaction_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('codex','claude','gemini','cursor')),
  flow_kind text NOT NULL CHECK (flow_kind IN ('authorization-code-pkce','device-code')),
  state_digest text CHECK (state_digest IS NULL OR state_digest ~ '^[0-9a-f]{64}$'),
  pkce_challenge text,
  secret_envelope jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','consumed','expired','revoked')),
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, transaction_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id, organization_id, workspace_id),
  CONSTRAINT provider_oauth_transactions_tenant_matches_organization
    CHECK (tenant_id = organization_id),
  CONSTRAINT provider_oauth_flow_fields CHECK (
    (flow_kind = 'authorization-code-pkce' AND state_digest IS NOT NULL
      AND pkce_challenge IS NOT NULL)
    OR
    (flow_kind = 'device-code' AND state_digest IS NULL AND pkce_challenge IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_oauth_pending_state_idx
  ON persistent_codex.provider_oauth_transactions(
    tenant_id, organization_id, workspace_id, state_digest
  ) WHERE state_digest IS NOT NULL AND status = 'pending';

CREATE TABLE IF NOT EXISTS persistent_codex.provider_usage_ledger (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  usage_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('codex','claude','gemini','cursor')),
  auth_mode text NOT NULL CHECK (auth_mode IN (
    'subscription-oauth','customer-api-key','platform-credit','local-cli-credential'
  )),
  billing_mode text NOT NULL CHECK (billing_mode IN (
    'subscription-quota','customer-api-billing','platform-credit'
  )),
  quantity numeric NOT NULL CHECK (quantity >= 0),
  unit text NOT NULL,
  monetary_amount_micros bigint CHECK (monetary_amount_micros IS NULL OR monetary_amount_micros >= 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  estimated boolean NOT NULL,
  quota_limit numeric CHECK (quota_limit IS NULL OR quota_limit >= 0),
  quota_remaining numeric CHECK (quota_remaining IS NULL OR quota_remaining >= 0),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, usage_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id, organization_id, workspace_id),
  CONSTRAINT provider_usage_ledger_tenant_matches_organization
    CHECK (tenant_id = organization_id),
  CONSTRAINT subscription_usage_not_billed CHECK (
    billing_mode <> 'subscription-quota'
    OR (estimated = true AND monetary_amount_micros IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS persistent_codex.provider_auth_kill_switches (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('codex','claude','gemini','cursor')),
  auth_mode text NOT NULL CHECK (auth_mode IN (
    'subscription-oauth','customer-api-key','platform-credit','local-cli-credential'
  )),
  enabled boolean NOT NULL,
  terms_evidence_hash text NOT NULL CHECK (terms_evidence_hash ~ '^[0-9a-f]{64}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, provider, auth_mode),
  FOREIGN KEY (tenant_id, organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id, organization_id, workspace_id),
  CONSTRAINT provider_auth_kill_switches_tenant_matches_organization
    CHECK (tenant_id = organization_id)
);

DO $body$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'provider_auth_profiles',
    'provider_credential_refresh_locks',
    'provider_oauth_transactions',
    'provider_usage_ledger',
    'provider_auth_kill_switches'
  ] LOOP
    EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON persistent_codex.%I', table_name || '_scope', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON persistent_codex.%I FOR ALL USING (
         tenant_id = current_setting(''app.tenant_id'', true)
         AND organization_id = current_setting(''app.organization_id'', true)
         AND workspace_id = current_setting(''app.workspace_id'', true)
       ) WITH CHECK (
         tenant_id = current_setting(''app.tenant_id'', true)
         AND organization_id = current_setting(''app.organization_id'', true)
         AND workspace_id = current_setting(''app.workspace_id'', true)
       )',
      table_name || '_scope', table_name
    );
  END LOOP;
END;
$body$;

COMMIT;
