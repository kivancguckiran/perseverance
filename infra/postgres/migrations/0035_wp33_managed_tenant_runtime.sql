-- WP33 — tenant-isolated managed runtime (ADR-0033).
-- managed_tenants + tenant_capacity_budgets + tenant_runtimes +
-- tenant_provisioning_jobs + tenant_runtime_credentials + tenant_runtime_orphans.
-- Tenant kimliği repo değişmezine sadıktır: tenant_id = organization_id (0023).

BEGIN;

DO $$ BEGIN
  CREATE ROLE persistent_tenant_provisioner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS persistent_codex.managed_tenants (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  display_name text NOT NULL,
  state text NOT NULL CHECK (state IN ('provisioning','active','suspended','deleting','deleted')),
  desired_state text NOT NULL CHECK (desired_state IN ('active','suspended','deleted')),
  domain text CHECK (domain IS NULL OR domain ~ '^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$'),
  region_id text NOT NULL,
  retention_policy_id text,
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  capacity jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id),
  CONSTRAINT managed_tenants_tenant_matches_organization CHECK (tenant_id = organization_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.tenant_capacity_budgets (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  reserved_capacity jsonb NOT NULL,
  queue_latency_budget_ms bigint NOT NULL CHECK (queue_latency_budget_ms > 0),
  max_starvation_position integer NOT NULL CHECK (max_starvation_position > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id),
  CONSTRAINT tenant_capacity_budgets_tenant_matches_organization CHECK (tenant_id = organization_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.tenant_runtimes (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  runtime_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('requested','provisioning','ready','suspended','deleting','deleted')),
  identity_subject text,
  volume_id text,
  volume_encrypted boolean NOT NULL DEFAULT false,
  kms_provider text,
  kms_key_id text,
  kms_key_version bigint CHECK (kms_key_version IS NULL OR kms_key_version > 0),
  secret_namespace text,
  network_policy_id text,
  region_id text NOT NULL,
  node_id text,
  capacity_reservation_id text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id, organization_id, workspace_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_runtimes_runtime_id_idx
  ON persistent_codex.tenant_runtimes(runtime_id);

CREATE TABLE IF NOT EXISTS persistent_codex.tenant_provisioning_jobs (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  job_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('provision','suspend','resume','delete')),
  workspace_id text NOT NULL,
  runtime_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('requested','running','completed','failed')),
  current_step text,
  completed_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key text NOT NULL,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  last_error_code text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, job_id),
  CONSTRAINT tenant_provisioning_jobs_idempotency
    UNIQUE (tenant_id, organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS persistent_codex.tenant_runtime_credentials (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  credential_id text NOT NULL,
  workspace_id text NOT NULL,
  runtime_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  actions jsonb NOT NULL,
  token_digest text NOT NULL CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, organization_id, credential_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.tenant_runtime_orphans (
  observed_runtime_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('missing-durable-record','stale-generation')),
  state text NOT NULL CHECK (state IN ('detected','cleaned')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (observed_runtime_id)
);

-- Tenant-scoped tablolar: tenant scope'u veya provisioner sistem rolü.
DO $body$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'managed_tenants',
    'tenant_capacity_budgets',
    'tenant_runtimes',
    'tenant_provisioning_jobs',
    'tenant_runtime_credentials'
  ] LOOP
    EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON persistent_codex.%I', table_name || '_scope', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON persistent_codex.%I FOR ALL USING (
         (tenant_id = current_setting(''app.tenant_id'', true)
          AND organization_id = current_setting(''app.organization_id'', true))
         OR pg_has_role(current_user, ''persistent_tenant_provisioner'', ''member'')
       ) WITH CHECK (
         (tenant_id = current_setting(''app.tenant_id'', true)
          AND organization_id = current_setting(''app.organization_id'', true))
         OR pg_has_role(current_user, ''persistent_tenant_provisioner'', ''member'')
       )',
      table_name || '_scope', table_name
    );
  END LOOP;
END;
$body$;

-- Orphan kaydı tenant scope taşımaz; yalnız provisioner sistem rolü erişir.
ALTER TABLE persistent_codex.tenant_runtime_orphans ENABLE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.tenant_runtime_orphans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_runtime_orphans_scope ON persistent_codex.tenant_runtime_orphans;
CREATE POLICY tenant_runtime_orphans_scope ON persistent_codex.tenant_runtime_orphans
  FOR ALL USING (pg_has_role(current_user, 'persistent_tenant_provisioner', 'member'))
  WITH CHECK (pg_has_role(current_user, 'persistent_tenant_provisioner', 'member'));

COMMIT;
