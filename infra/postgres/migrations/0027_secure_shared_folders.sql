BEGIN;

CREATE TABLE persistent_codex.folders (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  folder_id text NOT NULL,
  principal_id text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility = 'private'),
  created_by_principal_id text NOT NULL,
  acl_version bigint NOT NULL DEFAULT 1 CHECK (acl_version > 0),
  cache_epoch bigint NOT NULL DEFAULT 0 CHECK (cache_epoch >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, folder_id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id),
  CHECK (tenant_id = organization_id)
);

CREATE TABLE persistent_codex.folder_memberships (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  folder_id text NOT NULL,
  principal_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  accepted_invitation_id text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, folder_id, principal_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, folder_id)
    REFERENCES persistent_codex.folders
      (tenant_id, organization_id, workspace_id, folder_id) ON DELETE CASCADE,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE persistent_codex.folder_invitations (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  folder_id text NOT NULL,
  invitation_id text NOT NULL,
  principal_id text NOT NULL,
  token_digest bytea NOT NULL CHECK (octet_length(token_digest) = 32),
  invited_by_principal_id text NOT NULL,
  accepted_by_principal_id text,
  role text NOT NULL CHECK (role IN ('editor','viewer')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','expired','revoked')),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, folder_id, invitation_id),
  UNIQUE (tenant_id, organization_id, workspace_id, token_digest),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, folder_id)
    REFERENCES persistent_codex.folders
      (tenant_id, organization_id, workspace_id, folder_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (status <> 'accepted' OR accepted_by_principal_id IS NOT NULL)
);

ALTER TABLE persistent_codex.folder_memberships
  ADD CONSTRAINT folder_membership_invitation_fk
  FOREIGN KEY (tenant_id, organization_id, workspace_id, folder_id, accepted_invitation_id)
  REFERENCES persistent_codex.folder_invitations
    (tenant_id, organization_id, workspace_id, folder_id, invitation_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE persistent_codex.folder_resource_bindings (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  folder_id text NOT NULL,
  principal_id text NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN
    ('conversation','source','attachment','artifact','agent_task')),
  resource_id text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, resource_type, resource_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, folder_id)
    REFERENCES persistent_codex.folders
      (tenant_id, organization_id, workspace_id, folder_id),
  UNIQUE (tenant_id, organization_id, workspace_id, folder_id, resource_type, resource_id)
);

CREATE TABLE persistent_codex.folder_audit_records (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  folder_id text NOT NULL,
  principal_id text NOT NULL,
  audit_id bigint GENERATED ALWAYS AS IDENTITY,
  action text NOT NULL CHECK (action IN (
    'folder.created','invitation.created','invitation.accepted','invitation.revoked',
    'membership.role_changed','membership.revoked','ownership.transferred',
    'resource.moved','folder.exported')),
  outcome text NOT NULL CHECK (outcome IN ('success','failure')),
  reason_code text NOT NULL,
  subject_principal_id text,
  resource_type text,
  resource_id text,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  correlation_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  previous_hash text NOT NULL CHECK (previous_hash = 'GENESIS' OR previous_hash ~ '^[a-f0-9]{64}$'),
  record_hash text NOT NULL CHECK (record_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, audit_id),
  UNIQUE (tenant_id, organization_id, workspace_id, record_hash),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, folder_id)
    REFERENCES persistent_codex.folders
      (tenant_id, organization_id, workspace_id, folder_id),
  CHECK (resource_type IS NULL OR resource_type IN
    ('conversation','source','attachment','artifact','agent_task'))
);

CREATE OR REPLACE FUNCTION persistent_codex.reject_folder_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'folder audit is immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER folder_audit_immutable
BEFORE UPDATE OR DELETE ON persistent_codex.folder_audit_records
FOR EACH ROW EXECUTE FUNCTION persistent_codex.reject_folder_audit_mutation();

CREATE TABLE persistent_codex.folder_task_reservations (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  folder_id text NOT NULL,
  principal_id text NOT NULL,
  task_id text NOT NULL,
  session_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  run_id text,
  codex_turn_id text,
  upstream_work_id text,
  admission_decision_id text,
  usage_dedupe_key text,
  credit_reservation_id text,
  billing_settlement_id text,
  status text NOT NULL CHECK (status IN ('reserved','running','completed','failed','interrupted','incomplete','admission_denied','start_failed','recovery_required')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, folder_id, task_id),
  UNIQUE (tenant_id, organization_id, workspace_id, idempotency_key),
  UNIQUE (tenant_id, organization_id, workspace_id, run_id),
  UNIQUE (tenant_id, organization_id, workspace_id, codex_turn_id),
  UNIQUE (tenant_id, organization_id, workspace_id, upstream_work_id),
  UNIQUE (tenant_id, organization_id, workspace_id, usage_dedupe_key),
  UNIQUE (tenant_id, organization_id, workspace_id, billing_settlement_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, folder_id)
    REFERENCES persistent_codex.folders
      (tenant_id, organization_id, workspace_id, folder_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, credit_reservation_id)
    REFERENCES persistent_codex.credit_reservations
      (tenant_id, organization_id, workspace_id, reservation_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, billing_settlement_id)
    REFERENCES persistent_codex.credit_settlements
      (tenant_id, organization_id, workspace_id, settlement_id)
);

CREATE TABLE persistent_codex.folder_approval_resolutions (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  folder_id text NOT NULL,
  principal_id text NOT NULL,
  approval_id text NOT NULL,
  approval_version bigint NOT NULL CHECK (approval_version > 0),
  resolution_id text NOT NULL,
  durable_event_id text NOT NULL,
  codex_turn_id text,
  decision text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, approval_id, approval_version),
  UNIQUE (tenant_id, organization_id, workspace_id, resolution_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, folder_id)
    REFERENCES persistent_codex.folders
      (tenant_id, organization_id, workspace_id, folder_id)
);

CREATE TABLE persistent_codex.folder_billing_settlements (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  folder_id text NOT NULL,
  principal_id text NOT NULL,
  task_id text NOT NULL,
  usage_dedupe_key text NOT NULL,
  credit_reservation_id text NOT NULL,
  settlement_id text NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, usage_dedupe_key),
  UNIQUE (tenant_id, organization_id, workspace_id, task_id),
  UNIQUE (tenant_id, organization_id, workspace_id, settlement_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, folder_id, task_id)
    REFERENCES persistent_codex.folder_task_reservations
      (tenant_id, organization_id, workspace_id, folder_id, task_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, credit_reservation_id)
    REFERENCES persistent_codex.credit_reservations
      (tenant_id, organization_id, workspace_id, reservation_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, settlement_id)
    REFERENCES persistent_codex.credit_settlements
      (tenant_id, organization_id, workspace_id, settlement_id)
);

CREATE TABLE persistent_codex.folder_access_outbox (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  folder_id text NOT NULL,
  principal_id text NOT NULL,
  event_id bigint GENERATED ALWAYS AS IDENTITY,
  acl_version bigint NOT NULL CHECK (acl_version > 0),
  cache_epoch bigint NOT NULL CHECK (cache_epoch > 0),
  reason text NOT NULL CHECK (reason IN
    ('accepted','role_changed','revoked','ownership_transferred','resource_moved')),
  affected_principal_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, event_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, folder_id)
    REFERENCES persistent_codex.folders
      (tenant_id, organization_id, workspace_id, folder_id)
);

CREATE OR REPLACE FUNCTION persistent_codex.publish_folder_access_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('persistent_folder_access_changed', NEW.event_payload::text);
  RETURN NEW;
END $$;

CREATE TRIGGER publish_folder_access_change
AFTER INSERT ON persistent_codex.folder_access_outbox
FOR EACH ROW EXECUTE FUNCTION persistent_codex.publish_folder_access_change();

CREATE OR REPLACE FUNCTION persistent_codex.folder_role(
  p_tenant text, p_organization text, p_workspace text, p_folder text, p_principal text
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, persistent_codex
SET row_security = off
AS $$
  SELECT role FROM persistent_codex.folder_memberships
  WHERE tenant_id = p_tenant AND organization_id = p_organization
    AND workspace_id = p_workspace AND folder_id = p_folder
    AND principal_id = p_principal AND status = 'active'
$$;

REVOKE ALL ON FUNCTION persistent_codex.folder_role(text,text,text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION persistent_codex.authorize_folder_workload_resource(
  p_tenant text, p_organization text, p_workspace text,
  p_resource_type text, p_resource_id text
) RETURNS TABLE(
  tenant_id text, organization_id text, workspace_id text, folder_id text,
  resource_type text, resource_id text, version bigint,
  created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, persistent_codex
SET row_security = off
AS $$
  SELECT b.tenant_id,b.organization_id,b.workspace_id,b.folder_id,
         b.resource_type,b.resource_id,b.version,b.created_at,b.updated_at
  FROM persistent_codex.folder_resource_bindings b
  JOIN persistent_codex.folder_task_reservations t
    ON t.tenant_id=b.tenant_id AND t.organization_id=b.organization_id
   AND t.workspace_id=b.workspace_id AND t.folder_id=b.folder_id
  JOIN persistent_codex.folder_memberships m
    ON m.tenant_id=t.tenant_id AND m.organization_id=t.organization_id
   AND m.workspace_id=t.workspace_id AND m.folder_id=t.folder_id
   AND m.principal_id=t.principal_id AND m.status='active'
  WHERE b.tenant_id=p_tenant AND b.organization_id=p_organization
    AND b.workspace_id=p_workspace AND b.resource_type=p_resource_type
    AND b.resource_id=p_resource_id AND t.status IN ('reserved','running')
  ORDER BY t.updated_at DESC LIMIT 1
$$;

REVOKE ALL ON FUNCTION persistent_codex.authorize_folder_workload_resource(text,text,text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION persistent_codex.shared_folder_scope_exists(
  p_tenant text, p_organization text, p_workspace text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, persistent_codex
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1 FROM persistent_codex.folders f
    WHERE f.tenant_id=p_tenant AND f.organization_id=p_organization
      AND f.workspace_id=p_workspace AND f.archived_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION persistent_codex.shared_folder_task_for_turn(
  p_tenant_id text, p_organization_id text, p_workspace_id text, p_codex_turn_id text
) RETURNS TABLE(task_id text, principal_id text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, persistent_codex
AS $$
  SELECT t.task_id,t.principal_id
  FROM persistent_codex.folder_task_reservations t
  WHERE t.tenant_id=p_tenant_id AND t.organization_id=p_organization_id
    AND t.workspace_id=p_workspace_id AND t.codex_turn_id=p_codex_turn_id
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION persistent_codex.shared_folder_scope_exists(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION persistent_codex.shared_folder_task_for_turn(text,text,text,text) FROM PUBLIC;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'folders','folder_memberships','folder_invitations','folder_resource_bindings',
    'folder_audit_records','folder_task_reservations','folder_approval_resolutions',
    'folder_billing_settlements','folder_access_outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

CREATE POLICY folders_read ON persistent_codex.folders FOR SELECT USING (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
    current_setting('app.principal_id',true)) IS NOT NULL
);
CREATE POLICY folder_creator_insert ON persistent_codex.folders FOR INSERT
WITH CHECK (
  tenant_id = current_setting('app.tenant_id', true)
  AND organization_id = current_setting('app.organization_id', true)
  AND workspace_id = current_setting('app.workspace_id', true)
  AND principal_id = current_setting('app.principal_id', true)
  AND created_by_principal_id = current_setting('app.principal_id', true)
);
CREATE POLICY folders_member_mutation_update ON persistent_codex.folders FOR UPDATE USING (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
    current_setting('app.principal_id',true)) IN ('owner','editor')
) WITH CHECK (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
);

CREATE POLICY memberships_read ON persistent_codex.folder_memberships FOR SELECT USING (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
    current_setting('app.principal_id',true)) IS NOT NULL
);
CREATE POLICY membership_bootstrap_or_owner_insert ON persistent_codex.folder_memberships FOR INSERT
WITH CHECK (
  tenant_id = current_setting('app.tenant_id', true)
  AND organization_id = current_setting('app.organization_id', true)
  AND workspace_id = current_setting('app.workspace_id', true)
  AND (
    principal_id=current_setting('app.principal_id',true)
    OR persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
      current_setting('app.principal_id',true))='owner'
  )
);
CREATE POLICY memberships_owner_update ON persistent_codex.folder_memberships FOR UPDATE USING (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
    current_setting('app.principal_id',true))='owner'
) WITH CHECK (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
);

CREATE POLICY invitations_owner_all ON persistent_codex.folder_invitations FOR ALL USING (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
    current_setting('app.principal_id',true))='owner'
) WITH CHECK (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND principal_id=current_setting('app.principal_id',true)
);
CREATE POLICY invitations_acceptor_read ON persistent_codex.folder_invitations FOR SELECT USING (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND status='accepted'
  AND accepted_by_principal_id=current_setting('app.principal_id',true)
);

CREATE POLICY bindings_member_read ON persistent_codex.folder_resource_bindings FOR SELECT USING (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
    current_setting('app.principal_id',true)) IS NOT NULL
);
CREATE POLICY bindings_editor_write ON persistent_codex.folder_resource_bindings FOR ALL USING (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
    current_setting('app.principal_id',true)) IN ('owner','editor')
) WITH CHECK (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND principal_id=current_setting('app.principal_id',true)
  AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
    current_setting('app.principal_id',true)) IN ('owner','editor')
);

CREATE POLICY audit_member_read ON persistent_codex.folder_audit_records FOR SELECT USING (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
    current_setting('app.principal_id',true)) IS NOT NULL
);
CREATE POLICY audit_member_insert ON persistent_codex.folder_audit_records FOR INSERT WITH CHECK (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND principal_id=current_setting('app.principal_id',true)
  AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
    current_setting('app.principal_id',true)) IS NOT NULL
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'folder_task_reservations','folder_approval_resolutions','folder_billing_settlements'
  ] LOOP
    EXECUTE format('CREATE POLICY folder_execution_access ON persistent_codex.%I
      FOR ALL USING (
        tenant_id=current_setting(''app.tenant_id'',true)
        AND organization_id=current_setting(''app.organization_id'',true)
        AND workspace_id=current_setting(''app.workspace_id'',true)
        AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
          current_setting(''app.principal_id'',true)) IN (''owner'',''editor'')
      ) WITH CHECK (
        tenant_id=current_setting(''app.tenant_id'',true)
        AND organization_id=current_setting(''app.organization_id'',true)
        AND workspace_id=current_setting(''app.workspace_id'',true)
        AND principal_id=current_setting(''app.principal_id'',true)
        AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
          current_setting(''app.principal_id'',true)) IN (''owner'',''editor'')
      )',table_name);
  END LOOP;
END $$;

CREATE POLICY outbox_member_insert ON persistent_codex.folder_access_outbox FOR INSERT WITH CHECK (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND principal_id=current_setting('app.principal_id',true)
  AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
    current_setting('app.principal_id',true)) IS NOT NULL
);
CREATE POLICY outbox_owner_read ON persistent_codex.folder_access_outbox FOR SELECT USING (
  tenant_id=current_setting('app.tenant_id',true)
  AND organization_id=current_setting('app.organization_id',true)
  AND workspace_id=current_setting('app.workspace_id',true)
  AND persistent_codex.folder_role(tenant_id,organization_id,workspace_id,folder_id,
    current_setting('app.principal_id',true))='owner'
);

CREATE OR REPLACE FUNCTION persistent_codex.accept_folder_invitation(
  p_token_digest bytea, p_principal_id text, p_now timestamptz DEFAULT now()
) RETURNS TABLE(folder_id text, invitation_id text, role text, invitation_status text, idempotent boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, persistent_codex
SET row_security = off
AS $$
DECLARE invitation persistent_codex.folder_invitations%ROWTYPE;
BEGIN
  IF p_principal_id IS DISTINCT FROM current_setting('app.principal_id', true) THEN
    RAISE EXCEPTION 'principal mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO invitation FROM persistent_codex.folder_invitations i
  WHERE i.tenant_id = current_setting('app.tenant_id', true)
    AND i.organization_id = current_setting('app.organization_id', true)
    AND i.workspace_id = current_setting('app.workspace_id', true)
    AND i.token_digest = p_token_digest
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF invitation.status = 'accepted' AND invitation.accepted_by_principal_id = p_principal_id THEN
    RETURN QUERY SELECT invitation.folder_id, invitation.invitation_id, invitation.role, invitation.status, true;
    RETURN;
  END IF;
  IF invitation.status <> 'pending' THEN
    RETURN QUERY SELECT invitation.folder_id, invitation.invitation_id, invitation.role, invitation.status, false;
    RETURN;
  END IF;
  IF invitation.expires_at <= p_now THEN
    UPDATE persistent_codex.folder_invitations i SET status='expired', version=version+1, updated_at=p_now
    WHERE i.tenant_id=invitation.tenant_id AND i.organization_id=invitation.organization_id
      AND i.workspace_id=invitation.workspace_id AND i.folder_id=invitation.folder_id
      AND i.invitation_id=invitation.invitation_id;
    RETURN QUERY SELECT invitation.folder_id, invitation.invitation_id, invitation.role, 'expired'::text, false;
    RETURN;
  END IF;
  UPDATE persistent_codex.folder_invitations i
    SET status='accepted', accepted_by_principal_id=p_principal_id,
        accepted_at=p_now, updated_at=p_now, version=version+1
  WHERE i.tenant_id=invitation.tenant_id AND i.organization_id=invitation.organization_id
    AND i.workspace_id=invitation.workspace_id AND i.folder_id=invitation.folder_id
    AND i.invitation_id=invitation.invitation_id;
  INSERT INTO persistent_codex.folder_memberships
    (tenant_id,organization_id,workspace_id,folder_id,principal_id,role,status,
     accepted_invitation_id,created_at,updated_at)
  VALUES (invitation.tenant_id,invitation.organization_id,invitation.workspace_id,
          invitation.folder_id,p_principal_id,invitation.role,'active',
          invitation.invitation_id,p_now,p_now)
  ON CONFLICT ON CONSTRAINT folder_memberships_pkey
  DO UPDATE SET role=EXCLUDED.role,status='active',accepted_invitation_id=EXCLUDED.accepted_invitation_id,
                revoked_at=NULL,version=folder_memberships.version+1,updated_at=p_now;
  UPDATE persistent_codex.folders f SET acl_version=acl_version+1,cache_epoch=cache_epoch+1,
    version=version+1,updated_at=p_now
  WHERE f.tenant_id=invitation.tenant_id AND f.organization_id=invitation.organization_id
    AND f.workspace_id=invitation.workspace_id AND f.folder_id=invitation.folder_id;
  INSERT INTO persistent_codex.folder_access_outbox
    (tenant_id,organization_id,workspace_id,folder_id,principal_id,acl_version,
     cache_epoch,reason,affected_principal_id,occurred_at,event_payload)
  SELECT f.tenant_id,f.organization_id,f.workspace_id,f.folder_id,p_principal_id,
         f.acl_version,f.cache_epoch,'accepted',p_principal_id,p_now,
         jsonb_build_object('schemaVersion',1,'type','folder.access.changed',
           'tenantId',f.tenant_id,'organizationId',f.organization_id,
           'workspaceId',f.workspace_id,'folderId',f.folder_id,
           'aclVersion',f.acl_version,'cacheEpoch',f.cache_epoch,
           'reason','accepted','affectedPrincipalId',p_principal_id,
           'occurredAt',p_now)
  FROM persistent_codex.folders f
  WHERE f.tenant_id=invitation.tenant_id AND f.organization_id=invitation.organization_id
    AND f.workspace_id=invitation.workspace_id AND f.folder_id=invitation.folder_id;
  RETURN QUERY SELECT invitation.folder_id, invitation.invitation_id, invitation.role, 'accepted'::text, false;
END $$;

REVOKE ALL ON FUNCTION persistent_codex.accept_folder_invitation(bytea,text,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION persistent_codex.protect_last_folder_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM persistent_codex.folders f
  WHERE f.tenant_id=OLD.tenant_id AND f.organization_id=OLD.organization_id
    AND f.workspace_id=OLD.workspace_id AND f.folder_id=OLD.folder_id
  FOR UPDATE;
  IF OLD.status='active' AND OLD.role='owner'
     AND (NEW.status <> 'active' OR NEW.role <> 'owner')
     AND NOT EXISTS (
       SELECT 1 FROM persistent_codex.folder_memberships m
       WHERE m.tenant_id=OLD.tenant_id AND m.organization_id=OLD.organization_id
         AND m.workspace_id=OLD.workspace_id AND m.folder_id=OLD.folder_id
         AND m.principal_id<>OLD.principal_id AND m.status='active' AND m.role='owner'
     ) THEN
    RAISE EXCEPTION 'last owner protected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER protect_last_folder_owner
BEFORE UPDATE ON persistent_codex.folder_memberships
FOR EACH ROW EXECUTE FUNCTION persistent_codex.protect_last_folder_owner();

INSERT INTO persistent_codex.security_migrations(version)
VALUES (27) ON CONFLICT DO NOTHING;

COMMIT;
