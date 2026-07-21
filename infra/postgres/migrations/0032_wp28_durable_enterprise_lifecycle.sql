-- WP28 durable acceptance hardening. Additive because 0031 may already be deployed.
ALTER TABLE persistent_codex.tenant_export_jobs
  ADD COLUMN workspace_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN target_region text;
CREATE TABLE persistent_codex.scim_credentials (
 tenant_id text NOT NULL, organization_id text NOT NULL, provider_id text NOT NULL,
 credential_digest text NOT NULL CHECK (credential_digest ~ '^[a-f0-9]{64}$'),
 active boolean NOT NULL DEFAULT true, version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), rotated_at timestamptz,
 PRIMARY KEY(tenant_id,organization_id,provider_id),
 UNIQUE(tenant_id,organization_id,credential_digest));

CREATE TABLE persistent_codex.scim_group_memberships (
 tenant_id text NOT NULL, organization_id text NOT NULL, provider_id text NOT NULL,
 group_resource_id text NOT NULL, user_resource_id text NOT NULL,
 group_resource_type text GENERATED ALWAYS AS ('Group') STORED,
 user_resource_type text GENERATED ALWAYS AS ('User') STORED,
 provider_version bigint NOT NULL, active boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,organization_id,provider_id,group_resource_id,user_resource_id),
 FOREIGN KEY(tenant_id,organization_id,provider_id,group_resource_type,group_resource_id)
  REFERENCES persistent_codex.scim_resources(tenant_id,organization_id,provider_id,resource_type,resource_id),
 FOREIGN KEY(tenant_id,organization_id,provider_id,user_resource_type,user_resource_id)
  REFERENCES persistent_codex.scim_resources(tenant_id,organization_id,provider_id,resource_type,resource_id));

CREATE TABLE persistent_codex.scim_role_mappings (
 tenant_id text NOT NULL, organization_id text NOT NULL, provider_id text NOT NULL,
 group_external_id text NOT NULL, role_key text NOT NULL,
 version bigint NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,organization_id,provider_id,group_external_id));

CREATE TABLE persistent_codex.enterprise_principal_state (
 tenant_id text NOT NULL, organization_id text NOT NULL, principal_id text NOT NULL,
 scim_resource_id text NOT NULL, active boolean NOT NULL DEFAULT true,
 roles text[] NOT NULL DEFAULT '{}',
 admission_cordoned boolean NOT NULL DEFAULT false, revocation_epoch bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,organization_id,principal_id),
 UNIQUE(tenant_id,organization_id,scim_resource_id));
CREATE TABLE persistent_codex.enterprise_login_sessions (
 tenant_id text NOT NULL, organization_id text NOT NULL, principal_id text NOT NULL,
 session_id text NOT NULL, state text NOT NULL CHECK(state IN('active','revoked','expired')),
 revoked_at timestamptz, PRIMARY KEY(tenant_id,organization_id,session_id));
CREATE TABLE persistent_codex.enterprise_tokens (
 tenant_id text NOT NULL, organization_id text NOT NULL, principal_id text NOT NULL,
 token_id text NOT NULL, token_kind text NOT NULL CHECK(token_kind IN('access','refresh')),
 state text NOT NULL CHECK(state IN('active','revoked','expired')), revoked_at timestamptz,
 PRIMARY KEY(tenant_id,organization_id,token_id));
CREATE TABLE persistent_codex.enterprise_realtime_connections (
 tenant_id text NOT NULL, organization_id text NOT NULL, principal_id text NOT NULL,
 connection_id text NOT NULL, state text NOT NULL CHECK(state IN('open','revoked','closed')),
 revoked_at timestamptz, PRIMARY KEY(tenant_id,organization_id,connection_id));
CREATE TABLE persistent_codex.enterprise_credential_cache (
 tenant_id text NOT NULL, organization_id text NOT NULL, principal_id text NOT NULL,
 cache_key text NOT NULL, cache_epoch bigint NOT NULL, state text NOT NULL,
 PRIMARY KEY(tenant_id,organization_id,principal_id,cache_key));
CREATE TABLE persistent_codex.enterprise_runtime_bindings (
 tenant_id text NOT NULL, organization_id text NOT NULL, principal_id text NOT NULL,
 workspace_id text NOT NULL, session_id text NOT NULL, run_id text,
 active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,organization_id,principal_id,workspace_id,session_id));

CREATE TABLE persistent_codex.retention_purge_jobs (
 tenant_id text NOT NULL, organization_id text NOT NULL, job_id text NOT NULL,
 policy_id text NOT NULL, policy_version bigint NOT NULL, state text NOT NULL,
 checkpoint text, lease_owner text, fencing_token bigint NOT NULL DEFAULT 0,
 lease_expires_at timestamptz, processed_count bigint NOT NULL DEFAULT 0,
 version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,organization_id,job_id));
CREATE TABLE persistent_codex.lifecycle_objects (
 tenant_id text NOT NULL, organization_id text NOT NULL, object_id text NOT NULL,
 workspace_id text NOT NULL,
 object_class text NOT NULL, region_id text NOT NULL, storage_key text,
 byte_length bigint NOT NULL DEFAULT 0, sha256 text NOT NULL,
 key_version bigint NOT NULL, created_at timestamptz NOT NULL,
 deleted_at timestamptz, PRIMARY KEY(tenant_id,organization_id,object_id));
CREATE TABLE persistent_codex.export_download_grants (
 tenant_id text NOT NULL, organization_id text NOT NULL, job_id text NOT NULL,
 grant_digest text NOT NULL, actor_id text NOT NULL, expires_at timestamptz NOT NULL,
 consumed_bytes bigint NOT NULL DEFAULT 0, version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,organization_id,job_id,grant_digest));
CREATE TABLE persistent_codex.residency_transfer_audit (
 tenant_id text NOT NULL, organization_id text NOT NULL, transfer_id text NOT NULL,
 source_region text NOT NULL, destination_region text NOT NULL, reason_code text NOT NULL,
 actor_id text NOT NULL, object_class text NOT NULL, byte_count bigint NOT NULL,
 approval_id text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,organization_id,transfer_id));
CREATE TABLE persistent_codex.deletion_step_attempts (
 tenant_id text NOT NULL, organization_id text NOT NULL, job_id text NOT NULL,
 step text NOT NULL, attempt bigint NOT NULL, state text NOT NULL,
 fencing_token bigint NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 PRIMARY KEY(tenant_id,organization_id,job_id,step,attempt));
CREATE TABLE persistent_codex.tenant_deletion_receipts (
 tenant_id text NOT NULL, organization_id text NOT NULL, job_id text NOT NULL,
 receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),
 completed_steps text[] NOT NULL, remaining_classes jsonb NOT NULL,
 key_version bigint NOT NULL, completed_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,organization_id,job_id));

DO $body$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY[
 'scim_credentials','scim_group_memberships','scim_role_mappings','enterprise_principal_state',
 'enterprise_login_sessions','enterprise_tokens','enterprise_realtime_connections',
 'enterprise_credential_cache','enterprise_runtime_bindings','retention_purge_jobs','lifecycle_objects','export_download_grants',
 'residency_transfer_audit','deletion_step_attempts','tenant_deletion_receipts'] LOOP
 EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY wp28_tenant_scope ON persistent_codex.%I USING (persistent_codex.wp28_scope_ok(tenant_id,organization_id)) WITH CHECK (persistent_codex.wp28_scope_ok(tenant_id,organization_id))',t);
END LOOP; END $body$;
