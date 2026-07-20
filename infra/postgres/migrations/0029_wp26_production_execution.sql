BEGIN;

CREATE TABLE persistent_codex.ha_sessions (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','archived','recovery_required')),
  provider_id text NOT NULL DEFAULT 'codex',
  codex_thread_id text,
  high_water_sequence bigint NOT NULL DEFAULT 0 CHECK (high_water_sequence>=0),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,session_id),
  FOREIGN KEY (organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(organization_id,workspace_id),
  CHECK (tenant_id=organization_id)
);

CREATE TABLE persistent_codex.ha_runs (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  run_id text NOT NULL,
  queue_item_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  prompt_object_key text NOT NULL,
  output_object_key text,
  state text NOT NULL CHECK (state IN (
    'queued','awaiting_approval','leased','starting','running','completed',
    'failed','poisoned','recovery_required','outcome_unknown')),
  fencing_token bigint,
  lease_id text,
  runtime_id text,
  region_id text,
  node_id text,
  codex_thread_id text,
  codex_turn_id text,
  upstream_start_intent boolean NOT NULL DEFAULT false,
  upstream_start_committed boolean NOT NULL DEFAULT false,
  terminal_outcome text CHECK (terminal_outcome IS NULL OR terminal_outcome IN
    ('completed','failed','interrupted','outcome_unknown')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt>=0),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  terminal_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,run_id),
  UNIQUE (tenant_id,organization_id,workspace_id,queue_item_id),
  UNIQUE (tenant_id,organization_id,workspace_id,idempotency_key),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,session_id)
    REFERENCES persistent_codex.ha_sessions(tenant_id,organization_id,workspace_id,session_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,queue_item_id)
    REFERENCES persistent_codex.scheduler_queue(tenant_id,organization_id,workspace_id,queue_item_id),
  CHECK (prompt_object_key LIKE tenant_id || '/' || organization_id || '/' || workspace_id || '/%')
);
CREATE UNIQUE INDEX ha_one_active_run_per_workspace ON persistent_codex.ha_runs
  (tenant_id,organization_id,workspace_id)
  WHERE state IN ('leased','starting','running');

CREATE TABLE persistent_codex.ha_events (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  run_id text,
  event_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence>0),
  event_type text NOT NULL,
  fencing_token bigint,
  payload jsonb NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length>=0),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,session_id,event_id),
  UNIQUE (tenant_id,organization_id,workspace_id,session_id,sequence),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,session_id)
    REFERENCES persistent_codex.ha_sessions(tenant_id,organization_id,workspace_id,session_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,run_id)
    REFERENCES persistent_codex.ha_runs(tenant_id,organization_id,workspace_id,run_id)
);

CREATE TABLE persistent_codex.ha_approvals (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  run_id text NOT NULL,
  approval_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('command','file','network')),
  context jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','accepted','declined','expired')),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,approval_id),
  UNIQUE (tenant_id,organization_id,workspace_id,run_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,run_id)
    REFERENCES persistent_codex.ha_runs(tenant_id,organization_id,workspace_id,run_id)
);

CREATE TABLE persistent_codex.ha_event_outbox (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  outbox_id bigint GENERATED ALWAYS AS IDENTITY,
  session_id text NOT NULL,
  event_id text NOT NULL,
  sequence bigint NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,outbox_id),
  UNIQUE (tenant_id,organization_id,workspace_id,session_id,event_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,session_id,event_id)
    REFERENCES persistent_codex.ha_events(tenant_id,organization_id,workspace_id,session_id,event_id)
);

CREATE TABLE persistent_codex.ha_runtime_starts (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token>0),
  runtime_id text NOT NULL,
  owner_id text NOT NULL,
  started_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,run_id,fencing_token),
  UNIQUE (tenant_id,organization_id,workspace_id,runtime_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,run_id)
    REFERENCES persistent_codex.ha_runs(tenant_id,organization_id,workspace_id,run_id)
);

CREATE TABLE persistent_codex.ha_capacity_usage (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  event_bytes bigint NOT NULL DEFAULT 0 CHECK (event_bytes>=0),
  output_bytes bigint NOT NULL DEFAULT 0 CHECK (output_bytes>=0),
  artifact_bytes bigint NOT NULL DEFAULT 0 CHECK (artifact_bytes>=0),
  corpus_index_bytes bigint NOT NULL DEFAULT 0 CHECK (corpus_index_bytes>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,run_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,run_id)
    REFERENCES persistent_codex.ha_runs(tenant_id,organization_id,workspace_id,run_id)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ha_sessions','ha_runs','ha_events','ha_approvals','ha_event_outbox',
    'ha_runtime_starts','ha_capacity_usage'
  ] LOOP
    EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY ha_tenant_isolation ON persistent_codex.%I
      FOR ALL USING (
        (tenant_id=current_setting(''app.tenant_id'',true)
         AND organization_id=current_setting(''app.organization_id'',true)
         AND workspace_id=current_setting(''app.workspace_id'',true))
        OR pg_has_role(current_user,''persistent_topology_scheduler'',''member'')
      ) WITH CHECK (
        (tenant_id=current_setting(''app.tenant_id'',true)
         AND organization_id=current_setting(''app.organization_id'',true)
         AND workspace_id=current_setting(''app.workspace_id'',true))
        OR pg_has_role(current_user,''persistent_topology_scheduler'',''member'')
      )',table_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION persistent_codex.append_fenced_ha_event(
  p_tenant text,p_organization text,p_workspace text,p_session text,p_run text,
  p_event_id text,p_event_type text,p_token bigint,p_payload jsonb,
  p_occurred_at timestamptz DEFAULT now()
) RETURNS TABLE(accepted boolean,sequence bigint,reason_code text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,persistent_codex SET row_security=off AS $$
DECLARE next_sequence bigint;
DECLARE event_length bigint;
DECLARE event_limit bigint;
DECLARE current_event_bytes bigint;
BEGIN
  IF NOT persistent_codex.assert_workspace_fence(
    p_tenant,p_organization,p_workspace,p_run,p_token) THEN
    RETURN QUERY SELECT false,0::bigint,'STALE_FENCING_TOKEN'::text;
    RETURN;
  END IF;
  SELECT octet_length(p_payload::text),
         persistent_codex.capacity_value(r.capacity,'eventBytesPerSecond'),
         u.event_bytes
    INTO event_length,event_limit,current_event_bytes
  FROM persistent_codex.capacity_reservations r
  JOIN persistent_codex.ha_capacity_usage u
    ON u.tenant_id=r.tenant_id AND u.organization_id=r.organization_id
   AND u.workspace_id=r.workspace_id AND u.run_id=p_run
  WHERE r.tenant_id=p_tenant AND r.organization_id=p_organization
    AND r.workspace_id=p_workspace AND r.fencing_token=p_token
    AND r.state IN ('held','bound')
  FOR UPDATE OF u;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,0::bigint,'CAPACITY_RESERVATION_MISSING'::text;
    RETURN;
  END IF;
  IF event_length > event_limit OR current_event_bytes + event_length > event_limit*60 THEN
    INSERT INTO persistent_codex.capacity_limit_outcomes
      (tenant_id,organization_id,workspace_id,outcome_id,run_id,resource,action,
       limit_value,observed_value,reason_code,occurred_at)
    VALUES (p_tenant,p_organization,p_workspace,p_event_id,p_run,'event_bytes','rejected',
            event_limit,current_event_bytes+event_length,'EVENT_CAPACITY_EXCEEDED',p_occurred_at)
    ON CONFLICT DO NOTHING;
    RETURN QUERY SELECT false,0::bigint,'EVENT_CAPACITY_EXCEEDED'::text;
    RETURN;
  END IF;
  UPDATE persistent_codex.ha_sessions SET high_water_sequence=high_water_sequence+1,
    updated_at=p_occurred_at,version=version+1
  WHERE tenant_id=p_tenant AND organization_id=p_organization
    AND workspace_id=p_workspace AND session_id=p_session
  RETURNING high_water_sequence INTO next_sequence;
  INSERT INTO persistent_codex.ha_events
    (tenant_id,organization_id,workspace_id,session_id,run_id,event_id,sequence,
     event_type,fencing_token,payload,byte_length,occurred_at)
  VALUES (p_tenant,p_organization,p_workspace,p_session,p_run,p_event_id,next_sequence,
          p_event_type,p_token,p_payload,event_length,p_occurred_at)
  ON CONFLICT (tenant_id,organization_id,workspace_id,session_id,event_id)
  DO NOTHING;
  IF NOT FOUND THEN
    SELECT e.sequence INTO next_sequence FROM persistent_codex.ha_events e
    WHERE e.tenant_id=p_tenant AND e.organization_id=p_organization
      AND e.workspace_id=p_workspace AND e.session_id=p_session AND e.event_id=p_event_id;
    UPDATE persistent_codex.ha_sessions SET high_water_sequence=high_water_sequence-1,
      version=version-1 WHERE tenant_id=p_tenant AND organization_id=p_organization
      AND workspace_id=p_workspace AND session_id=p_session;
    RETURN QUERY SELECT true,next_sequence,'IDEMPOTENT'::text;
    RETURN;
  END IF;
  UPDATE persistent_codex.ha_capacity_usage SET event_bytes=event_bytes+event_length,
    updated_at=p_occurred_at
  WHERE tenant_id=p_tenant AND organization_id=p_organization
    AND workspace_id=p_workspace AND run_id=p_run;
  INSERT INTO persistent_codex.ha_event_outbox
    (tenant_id,organization_id,workspace_id,session_id,event_id,sequence)
  VALUES (p_tenant,p_organization,p_workspace,p_session,p_event_id,next_sequence);
  PERFORM pg_notify('persistent_ha_event',jsonb_build_object(
    'tenantId',p_tenant,'workspaceId',p_workspace,'sessionId',p_session,
    'sequence',next_sequence)::text);
  RETURN QUERY SELECT true,next_sequence,'APPENDED'::text;
END $$;

REVOKE ALL ON FUNCTION persistent_codex.append_fenced_ha_event(
  text,text,text,text,text,text,text,bigint,jsonb,timestamptz) FROM PUBLIC;

INSERT INTO persistent_codex.security_migrations(version)
VALUES (29) ON CONFLICT DO NOTHING;

COMMIT;
