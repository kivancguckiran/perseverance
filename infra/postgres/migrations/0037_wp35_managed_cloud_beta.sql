-- WP35 — Managed Cloud onboarding, accounting surfaces and controlled beta.
-- Existing authorities remain canonical:
--   tenant provisioning -> 0035/WP33
--   provider capability/vault/kill switch -> 0036/WP34
--   commercial billing/credit ledger -> 0024-0026/WP24
--   rollout/go-no-go -> 0034/WP30

BEGIN;

-- Server-owned selection catalog. Clients can name only this immutable
-- plan/version pair; policy fields are never accepted from an API request.
CREATE TABLE IF NOT EXISTS persistent_codex.managed_cloud_plan_catalog (
  plan_id text NOT NULL,
  plan_version bigint NOT NULL CHECK (plan_version > 0),
  plan jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (plan_id, plan_version),
  CHECK (plan->>'planId' = plan_id),
  CHECK ((plan->>'planVersion')::bigint = plan_version)
);

INSERT INTO persistent_codex.managed_cloud_plan_catalog
  (plan_id,plan_version,plan,enabled)
VALUES (
  'limited-beta',
  1,
  '{
    "schemaVersion": 1,
    "planId": "limited-beta",
    "planVersion": 1,
    "displayName": "Managed Cloud Limited Beta",
    "currency": "USD",
    "entitlements": [
      "cloud.managed-tenant-provisioning",
      "cloud.tenant-runtime-isolation",
      "cloud.tenant-capacity-budgets",
      "cloud.runtime-data-plane-credentials",
      "core.provider-adapters",
      "core.detached-runs"
    ],
    "computeQuota": {
      "schemaVersion": 1,
      "cpuMillis": 2000,
      "memoryBytes": 4294967296,
      "pids": 512,
      "ioBytesPerSecond": 104857600,
      "diskBytes": 21474836480,
      "diskInodes": 1000000,
      "diskIops": 3000,
      "egressBytesPerSecond": 10485760,
      "egressRequestsPerMinute": 600,
      "eventBytesPerSecond": 1048576,
      "artifactBytes": 10737418240,
      "outputBytes": 1073741824,
      "corpusIndexBytes": 5368709120
    },
    "storageQuotaBytes": 21474836480,
    "monthlyBudgetMicros": 25000000
  }'::jsonb,
  true
)
ON CONFLICT (plan_id,plan_version) DO NOTHING;

CREATE TABLE IF NOT EXISTS persistent_codex.managed_cloud_onboardings (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  onboarding_id text NOT NULL,
  account_id text NOT NULL,
  email_digest text NOT NULL CHECK (email_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'signed_up','tenant_ready','provider_connected','first_task_started','completed'
  )),
  plan_id text NOT NULL,
  plan_version bigint NOT NULL CHECK (plan_version > 0),
  provider_profile_id text,
  first_task_id text,
  idempotency_key text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, onboarding_id),
  UNIQUE (tenant_id, organization_id, idempotency_key),
  FOREIGN KEY (tenant_id, organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id, organization_id, workspace_id),
  CONSTRAINT managed_cloud_onboarding_tenant_matches_organization
    CHECK (tenant_id = organization_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.managed_cloud_domains (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  domain text NOT NULL,
  challenge_digest text NOT NULL CHECK (challenge_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('pending','verified','failed','revoked')),
  https_state text NOT NULL CHECK (https_state IN ('pending','active','failed','revoked')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id),
  UNIQUE (domain),
  FOREIGN KEY (tenant_id, organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id, organization_id, workspace_id),
  FOREIGN KEY (tenant_id, organization_id)
    REFERENCES persistent_codex.managed_tenants(tenant_id, organization_id),
  CONSTRAINT managed_cloud_domain_tenant_matches_organization
    CHECK (tenant_id = organization_id),
  CONSTRAINT managed_cloud_https_requires_verified CHECK (
    https_state <> 'active' OR state = 'verified'
  )
);

CREATE TABLE IF NOT EXISTS persistent_codex.managed_cloud_notification_preferences (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  email_enabled boolean NOT NULL DEFAULT true,
  push_enabled boolean NOT NULL DEFAULT true,
  task_completed boolean NOT NULL DEFAULT true,
  approval_required boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id, organization_id, workspace_id),
  CONSTRAINT managed_cloud_notifications_tenant_matches_organization
    CHECK (tenant_id = organization_id)
);

-- WP30 rollout remains the authority. This table only maps an admitted tenant
-- to a WP30 rollout/cohort and adds bounded beta rate/capacity metadata.
CREATE TABLE IF NOT EXISTS persistent_codex.managed_cloud_beta_admissions (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  rollout_id text NOT NULL,
  cohort_id text NOT NULL,
  feature_flag_enabled boolean NOT NULL,
  capacity_ceiling jsonb NOT NULL,
  requests_per_minute integer NOT NULL CHECK (requests_per_minute > 0),
  admitted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, organization_id, workspace_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id, organization_id, workspace_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, rollout_id)
    REFERENCES persistent_codex.production_rollouts(
      tenant_id, organization_id, workspace_id, rollout_id
    ),
  CONSTRAINT managed_cloud_beta_tenant_matches_organization
    CHECK (tenant_id = organization_id)
);

DO $body$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'managed_cloud_onboardings',
    'managed_cloud_domains',
    'managed_cloud_notification_preferences',
    'managed_cloud_beta_admissions'
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
