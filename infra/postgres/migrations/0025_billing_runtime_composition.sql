BEGIN;

ALTER TABLE persistent_codex.billing_webhook_events
  ADD COLUMN IF NOT EXISTS normalized_command jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE persistent_codex.billing_webhook_events
  ADD CONSTRAINT billing_webhook_normalized_command_object
  CHECK (jsonb_typeof(normalized_command) = 'object' AND pg_column_size(normalized_command) <= 16384);

CREATE TABLE persistent_codex.commercial_admission_leases (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  request_key text NOT NULL,
  decision_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('turn.start','source.upload','source.index','source.retrieval','workspace.concurrency')),
  session_id text,
  resource_id text,
  reserved_count bigint NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  created_at timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,request_key),
  UNIQUE (tenant_id,organization_id,workspace_id,decision_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,decision_id)
    REFERENCES persistent_codex.quota_decisions(tenant_id,organization_id,workspace_id,decision_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id)
);

ALTER TABLE persistent_codex.commercial_admission_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.commercial_admission_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON persistent_codex.commercial_admission_leases FOR ALL
  USING (
    tenant_id=current_setting('app.tenant_id',true) AND
    organization_id=current_setting('app.organization_id',true) AND
    workspace_id=current_setting('app.workspace_id',true)
  )
  WITH CHECK (
    tenant_id=current_setting('app.tenant_id',true) AND
    organization_id=current_setting('app.organization_id',true) AND
    workspace_id=current_setting('app.workspace_id',true)
  );

CREATE INDEX commercial_admission_active_idx
  ON persistent_codex.commercial_admission_leases
  (tenant_id,organization_id,workspace_id,operation,session_id)
  WHERE released_at IS NULL;

DROP FUNCTION persistent_codex.billing_claim_webhooks(timestamptz,integer);
CREATE FUNCTION persistent_codex.billing_claim_webhooks(p_now timestamptz,p_limit integer)
RETURNS TABLE (
  tenant_id text,organization_id text,workspace_id text,provider text,
  webhook_event_id text,event_type text,provider_sequence bigint,
  payload_digest text,effective_at timestamptz,attempt integer,
  normalized_command jsonb
)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,persistent_codex AS $$
  WITH claimed AS (
    SELECT e.tenant_id,e.organization_id,e.workspace_id,e.provider,e.webhook_event_id
    FROM persistent_codex.billing_webhook_events e
    WHERE e.processing_state IN ('received','retry')
    ORDER BY e.received_at,e.webhook_event_id
    FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(p_limit,100))
  ), updated AS (
    UPDATE persistent_codex.billing_webhook_events e
    SET processing_state='processing',attempt=e.attempt+1,updated_at=p_now
    FROM claimed c WHERE (e.tenant_id,e.organization_id,e.workspace_id,e.provider,e.webhook_event_id)=
      (c.tenant_id,c.organization_id,c.workspace_id,c.provider,c.webhook_event_id)
    RETURNING e.*
  ) SELECT tenant_id,organization_id,workspace_id,provider,webhook_event_id,
      event_type,provider_sequence,payload_digest,effective_at,attempt,
      normalized_command FROM updated;
$$;
REVOKE ALL ON FUNCTION persistent_codex.billing_claim_webhooks(timestamptz,integer) FROM PUBLIC;

INSERT INTO persistent_codex.security_migrations(version) VALUES (25) ON CONFLICT DO NOTHING;
COMMIT;
