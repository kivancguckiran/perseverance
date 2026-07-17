BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS persistent_codex.support_grants (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  grant_id text NOT NULL,
  tenant_id text NOT NULL,
  session_id text,
  artifact_id text,
  attachment_id text,
  actions text[] NOT NULL CHECK (cardinality(actions) BETWEEN 1 AND 4),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  requester_principal_id text NOT NULL,
  support_principal_id text NOT NULL,
  mfa_evidence_id text,
  required_approvals smallint NOT NULL CHECK (required_approvals IN (1,2)),
  status text NOT NULL CHECK (status IN (
    'pending_verification','pending_approval','active','revoked','expired','denied'
  )),
  issued_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workspace_id, grant_id),
  UNIQUE (organization_id, workspace_id, idempotency_key),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id),
  FOREIGN KEY (organization_id, workspace_id, session_id)
    REFERENCES persistent_codex.sessions (organization_id, workspace_id, session_id),
  CHECK (requester_principal_id <> support_principal_id),
  CHECK (session_id IS NOT NULL OR artifact_id IS NOT NULL OR attachment_id IS NOT NULL),
  CHECK (num_nonnulls(artifact_id, attachment_id) <= 1)
);

CREATE TABLE IF NOT EXISTS persistent_codex.support_grant_approvals (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  grant_id text NOT NULL,
  approval_id text NOT NULL,
  approver_principal_id text NOT NULL,
  approver_role text NOT NULL CHECK (approver_role IN ('support','security_approver','kms_operator')),
  decision text NOT NULL CHECK (decision IN ('approve','deny')),
  mfa_evidence_id text NOT NULL,
  idempotency_key text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workspace_id, approval_id),
  UNIQUE (organization_id, workspace_id, grant_id, approver_principal_id),
  UNIQUE (organization_id, workspace_id, idempotency_key),
  FOREIGN KEY (organization_id, workspace_id, grant_id)
    REFERENCES persistent_codex.support_grants (organization_id, workspace_id, grant_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.jit_access_leases (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  lease_id text NOT NULL,
  tenant_id text NOT NULL,
  grant_id text,
  break_glass_id text,
  session_id text,
  object_id text,
  action text NOT NULL CHECK (action IN (
    'content.view','artifact.download','attachment.download','content.decrypt'
  )),
  principal_id text NOT NULL,
  token_hash bytea NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (organization_id, workspace_id, lease_id),
  UNIQUE (organization_id, workspace_id, token_hash),
  CHECK (num_nonnulls(grant_id, break_glass_id) = 1),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.break_glass_requests (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  break_glass_id text NOT NULL,
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  object_id text NOT NULL,
  actions text[] NOT NULL CHECK (cardinality(actions) BETWEEN 1 AND 4),
  incident_id text NOT NULL CHECK (incident_id ~ '^INC-[A-Z0-9-]{4,64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  requester_principal_id text NOT NULL,
  mfa_evidence_id text,
  status text NOT NULL CHECK (status IN (
    'pending_verification','pending_approval','active','revoked','expired','denied'
  )),
  issued_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workspace_id, break_glass_id),
  UNIQUE (organization_id, workspace_id, idempotency_key),
  FOREIGN KEY (organization_id, workspace_id, session_id)
    REFERENCES persistent_codex.sessions (organization_id, workspace_id, session_id),
  CHECK (expires_at <= created_at + interval '15 minutes')
);

ALTER TABLE persistent_codex.jit_access_leases
  DROP CONSTRAINT IF EXISTS jit_access_leases_grant_fk;
ALTER TABLE persistent_codex.jit_access_leases
  ADD CONSTRAINT jit_access_leases_grant_fk
  FOREIGN KEY (organization_id, workspace_id, grant_id)
  REFERENCES persistent_codex.support_grants (organization_id, workspace_id, grant_id);
ALTER TABLE persistent_codex.jit_access_leases
  DROP CONSTRAINT IF EXISTS jit_access_leases_break_glass_fk;
ALTER TABLE persistent_codex.jit_access_leases
  ADD CONSTRAINT jit_access_leases_break_glass_fk
  FOREIGN KEY (organization_id, workspace_id, break_glass_id)
  REFERENCES persistent_codex.break_glass_requests (organization_id, workspace_id, break_glass_id);

CREATE TABLE IF NOT EXISTS persistent_codex.break_glass_approvals (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  break_glass_id text NOT NULL,
  approval_id text NOT NULL,
  approver_principal_id text NOT NULL,
  approver_role text NOT NULL CHECK (approver_role IN ('security_approver','kms_operator')),
  mfa_evidence_id text NOT NULL,
  idempotency_key text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workspace_id, approval_id),
  UNIQUE (organization_id, workspace_id, break_glass_id, approver_principal_id),
  UNIQUE (organization_id, workspace_id, idempotency_key),
  FOREIGN KEY (organization_id, workspace_id, break_glass_id)
    REFERENCES persistent_codex.break_glass_requests (organization_id, workspace_id, break_glass_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.security_audit_chain_heads (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0,
  last_hash bytea NOT NULL DEFAULT public.digest('GENESIS', 'sha256'),
  PRIMARY KEY (organization_id, workspace_id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.immutable_security_audit (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  audit_id bigint GENERATED ALWAYS AS IDENTITY,
  chain_sequence bigint NOT NULL,
  actor_principal_id text NOT NULL,
  scope_json jsonb NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('requested','success','failure')),
  reason_code text NOT NULL,
  grant_id text,
  break_glass_id text,
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  previous_hash bytea NOT NULL,
  record_hash bytea NOT NULL,
  PRIMARY KEY (organization_id, workspace_id, audit_id),
  UNIQUE (organization_id, workspace_id, chain_sequence),
  CHECK (scope_json ? 'actions'),
  CHECK (NOT (scope_json ? 'content' OR scope_json ? 'secret' OR scope_json ? 'token'))
);

CREATE TABLE IF NOT EXISTS persistent_codex.security_notification_outbox (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  outbox_id text NOT NULL,
  tenant_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('break_glass_alarm','tenant_notification')),
  aggregate_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','delivered')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  idempotency_key text NOT NULL,
  PRIMARY KEY (organization_id, workspace_id, outbox_id),
  UNIQUE (organization_id, workspace_id, idempotency_key),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.access_revocation_epochs (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  aggregate_kind text NOT NULL CHECK (aggregate_kind IN ('support_grant','break_glass')),
  aggregate_id text NOT NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workspace_id, aggregate_kind, aggregate_id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id)
);

CREATE OR REPLACE FUNCTION persistent_codex.reject_security_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'immutable security audit cannot be updated or deleted'
    USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS immutable_security_audit_no_mutation
  ON persistent_codex.immutable_security_audit;
CREATE TRIGGER immutable_security_audit_no_mutation
BEFORE UPDATE OR DELETE ON persistent_codex.immutable_security_audit
FOR EACH ROW EXECUTE FUNCTION persistent_codex.reject_security_audit_mutation();

CREATE OR REPLACE FUNCTION persistent_codex.append_security_audit(
  p_organization_id text,
  p_workspace_id text,
  p_actor_principal_id text,
  p_scope_json jsonb,
  p_action text,
  p_outcome text,
  p_reason_code text,
  p_grant_id text,
  p_break_glass_id text,
  p_correlation_id text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, persistent_codex AS $$
DECLARE head persistent_codex.security_audit_chain_heads%ROWTYPE;
DECLARE next_hash bytea;
DECLARE inserted_id bigint;
BEGIN
  IF p_organization_id <> current_setting('app.organization_id', true)
     OR p_workspace_id <> current_setting('app.workspace_id', true) THEN
    RAISE EXCEPTION 'tenant context mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_scope_json ? 'content' OR p_scope_json ? 'secret' OR p_scope_json ? 'token' THEN
    RAISE EXCEPTION 'sensitive audit field rejected' USING ERRCODE = '22023';
  END IF;
  INSERT INTO persistent_codex.security_audit_chain_heads
    (organization_id, workspace_id) VALUES (p_organization_id, p_workspace_id)
    ON CONFLICT DO NOTHING;
  SELECT * INTO head FROM persistent_codex.security_audit_chain_heads
    WHERE organization_id=p_organization_id AND workspace_id=p_workspace_id
    FOR UPDATE;
  next_hash := public.digest(
    head.last_hash || convert_to(jsonb_build_object(
      'sequence',head.last_sequence + 1,'actor',p_actor_principal_id,
      'scope',p_scope_json,'action',p_action,'outcome',p_outcome,
      'reason',p_reason_code,'grantId',p_grant_id,'breakGlassId',p_break_glass_id,
      'correlationId',p_correlation_id
    )::text,'utf8'), 'sha256');
  INSERT INTO persistent_codex.immutable_security_audit
    (organization_id,workspace_id,chain_sequence,actor_principal_id,scope_json,
     action,outcome,reason_code,grant_id,break_glass_id,correlation_id,
     previous_hash,record_hash)
  VALUES (p_organization_id,p_workspace_id,head.last_sequence + 1,
    p_actor_principal_id,p_scope_json,p_action,p_outcome,p_reason_code,p_grant_id,
    p_break_glass_id,p_correlation_id,head.last_hash,next_hash)
  RETURNING audit_id INTO inserted_id;
  UPDATE persistent_codex.security_audit_chain_heads
    SET last_sequence=head.last_sequence + 1,last_hash=next_hash
    WHERE organization_id=p_organization_id AND workspace_id=p_workspace_id;
  RETURN inserted_id;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'support_grants','support_grant_approvals','jit_access_leases',
    'break_glass_requests','break_glass_approvals','immutable_security_audit',
    'security_notification_outbox','access_revocation_epochs',
    'security_audit_chain_heads'
  ] LOOP
    EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON persistent_codex.%I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON persistent_codex.%I FOR ALL USING (
        organization_id=current_setting(''app.organization_id'',true)
        AND workspace_id=current_setting(''app.workspace_id'',true)
      ) WITH CHECK (
        organization_id=current_setting(''app.organization_id'',true)
        AND workspace_id=current_setting(''app.workspace_id'',true)
      )', table_name);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE, TRUNCATE ON persistent_codex.immutable_security_audit FROM PUBLIC;
REVOKE INSERT ON persistent_codex.immutable_security_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION persistent_codex.append_security_audit(text,text,text,jsonb,text,text,text,text,text,text) FROM PUBLIC;

INSERT INTO persistent_codex.security_migrations(version)
VALUES (20) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION persistent_codex.wp20_security_ready()
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, persistent_codex AS $$
  SELECT persistent_codex.wp19_security_ready()
    AND EXISTS (SELECT 1 FROM persistent_codex.security_migrations WHERE version=20)
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('support_grants'),('support_grant_approvals'),('jit_access_leases'),
        ('break_glass_requests'),('break_glass_approvals'),
        ('immutable_security_audit'),('security_notification_outbox'),
        ('access_revocation_epochs'),('security_audit_chain_heads')
      ) required(table_name)
      LEFT JOIN pg_catalog.pg_class relation
        ON relation.relname=required.table_name
       AND relation.relnamespace='persistent_codex'::regnamespace
      WHERE relation.oid IS NULL OR NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity
    );
$$;
REVOKE ALL ON FUNCTION persistent_codex.wp20_security_ready() FROM PUBLIC;

COMMIT;
