CREATE SCHEMA IF NOT EXISTS persistent_codex;
CREATE OR REPLACE FUNCTION persistent_codex.wp28_scope_ok(t text,o text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT t=current_setting('app.tenant_id',true) AND o=current_setting('app.organization_id',true) $$;

CREATE TABLE IF NOT EXISTS persistent_codex.enterprise_federation (
 tenant_id text NOT NULL, organization_id text NOT NULL, configuration_id text NOT NULL,
 protocol text NOT NULL CHECK(protocol IN('oidc','saml')), configuration jsonb NOT NULL,
 metadata_version bigint NOT NULL, enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,organization_id,configuration_id));
CREATE TABLE IF NOT EXISTS persistent_codex.scim_resources (
 tenant_id text NOT NULL, organization_id text NOT NULL, provider_id text NOT NULL,
 resource_type text NOT NULL CHECK(resource_type IN('User','Group')), resource_id text NOT NULL,
 external_id text NOT NULL, provider_version bigint NOT NULL, active boolean NOT NULL,
 representation jsonb NOT NULL, version bigint NOT NULL, updated_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,organization_id,provider_id,resource_type,resource_id),
 UNIQUE(tenant_id,organization_id,provider_id,resource_type,external_id));
CREATE TABLE IF NOT EXISTS persistent_codex.scim_idempotency (
 tenant_id text NOT NULL, organization_id text NOT NULL, provider_id text NOT NULL,
 idempotency_key text NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL,
 provider_version bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,organization_id,provider_id,idempotency_key));
CREATE TABLE IF NOT EXISTS persistent_codex.retention_policies (
 tenant_id text NOT NULL, organization_id text NOT NULL, policy_id text NOT NULL,
 policy_version bigint NOT NULL, effective_at timestamptz NOT NULL, policy jsonb NOT NULL,
 PRIMARY KEY(tenant_id,organization_id,policy_id,policy_version));
CREATE TABLE IF NOT EXISTS persistent_codex.legal_holds (
 tenant_id text NOT NULL, organization_id text NOT NULL, hold_id text NOT NULL,
 state text NOT NULL, reason_code text NOT NULL, object_classes text[] NOT NULL,
 actor_role text NOT NULL, starts_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 version bigint NOT NULL, PRIMARY KEY(tenant_id,organization_id,hold_id));
CREATE TABLE IF NOT EXISTS persistent_codex.tenant_export_jobs (
 tenant_id text NOT NULL, organization_id text NOT NULL, job_id text NOT NULL,
 idempotency_key text NOT NULL, state text NOT NULL, checkpoint bigint NOT NULL DEFAULT 0,
 manifest jsonb, encrypted_object_key text, version bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,organization_id,job_id), UNIQUE(tenant_id,organization_id,idempotency_key));
CREATE TABLE IF NOT EXISTS persistent_codex.tenant_deletion_jobs (
 tenant_id text NOT NULL, organization_id text NOT NULL, job_id text NOT NULL,
 idempotency_key text NOT NULL, state text NOT NULL, current_step text NOT NULL,
 completed_steps text[] NOT NULL DEFAULT '{}', remaining_classes jsonb NOT NULL DEFAULT '[]',
 key_version bigint NOT NULL, version bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,organization_id,job_id), UNIQUE(tenant_id,organization_id,idempotency_key));
CREATE TABLE IF NOT EXISTS persistent_codex.tenant_residency_policies (
 tenant_id text NOT NULL, organization_id text NOT NULL, policy_id text NOT NULL,
 policy_version bigint NOT NULL, policy jsonb NOT NULL, effective_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,organization_id,policy_id,policy_version));
CREATE TABLE IF NOT EXISTS persistent_codex.enterprise_audit_chain (
 tenant_id text NOT NULL, organization_id text NOT NULL, audit_id text NOT NULL,
 action text NOT NULL, outcome text NOT NULL, reason_code text NOT NULL,
 previous_hash text, record_hash text NOT NULL, occurred_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,organization_id,audit_id));

DO $body$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['enterprise_federation','scim_resources','scim_idempotency','retention_policies','legal_holds','tenant_export_jobs','tenant_deletion_jobs','tenant_residency_policies','enterprise_audit_chain'] LOOP
 EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('DROP POLICY IF EXISTS wp28_tenant_scope ON persistent_codex.%I',t);
 EXECUTE format('CREATE POLICY wp28_tenant_scope ON persistent_codex.%I USING (persistent_codex.wp28_scope_ok(tenant_id,organization_id)) WITH CHECK (persistent_codex.wp28_scope_ok(tenant_id,organization_id))',t);
END LOOP; END $body$;
