BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE persistent_codex.workspaces ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE persistent_codex.workspaces SET tenant_id=organization_id WHERE tenant_id IS NULL;
ALTER TABLE persistent_codex.workspaces ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE persistent_codex.workspaces DROP CONSTRAINT IF EXISTS workspaces_tenant_matches_organization;
ALTER TABLE persistent_codex.workspaces ADD CONSTRAINT workspaces_tenant_matches_organization CHECK (tenant_id=organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_tenant_scope
  ON persistent_codex.workspaces(tenant_id,organization_id,workspace_id);

CREATE TABLE persistent_codex.push_devices (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  principal_id text NOT NULL,
  device_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,principal_id,device_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id) REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id)
);

CREATE TABLE persistent_codex.push_subscriptions (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  principal_id text NOT NULL,
  subscription_id text NOT NULL,
  device_id text NOT NULL,
  endpoint_fingerprint text NOT NULL CHECK (endpoint_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  secret_envelope jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked','invalid')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,subscription_id),
  UNIQUE (tenant_id,organization_id,workspace_id,principal_id,device_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,principal_id,device_id) REFERENCES persistent_codex.push_devices(tenant_id,organization_id,workspace_id,principal_id,device_id)
);

CREATE TABLE persistent_codex.push_notification_outbox (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  principal_id text NOT NULL,
  outbox_id text NOT NULL,
  notification_id text NOT NULL,
  subscription_id text NOT NULL,
  device_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivering','delivered','retry','discarded')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,outbox_id),
  UNIQUE (tenant_id,organization_id,workspace_id,notification_id,subscription_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,subscription_id) REFERENCES persistent_codex.push_subscriptions(tenant_id,organization_id,workspace_id,subscription_id)
);

CREATE TABLE persistent_codex.push_delivery_receipts (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  principal_id text NOT NULL,
  delivery_id text NOT NULL,
  outbox_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  outcome text NOT NULL CHECK (outcome IN ('delivered','retry','invalid_endpoint')),
  provider_message_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,delivery_id),
  UNIQUE (tenant_id,organization_id,workspace_id,outbox_id,attempt),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,outbox_id) REFERENCES persistent_codex.push_notification_outbox(tenant_id,organization_id,workspace_id,outbox_id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['push_devices','push_subscriptions','push_notification_outbox','push_delivery_receipts'] LOOP
    EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I_scope ON persistent_codex.%I USING (organization_id = current_setting(''app.organization_id'',true) AND workspace_id = current_setting(''app.workspace_id'',true) AND principal_id = current_setting(''app.principal_id'',true)) WITH CHECK (organization_id = current_setting(''app.organization_id'',true) AND workspace_id = current_setting(''app.workspace_id'',true) AND principal_id = current_setting(''app.principal_id'',true))', t, t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION persistent_codex.push_enqueue_notification(
  p_tenant_id text,
  p_organization_id text,
  p_workspace_id text,
  p_notification_id text,
  p_payload jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, persistent_codex AS $$
DECLARE inserted_count integer;
BEGIN
  IF p_payload ?| ARRAY['prompt','output','reasoning','command','diff','filename','source','citation','tenantName','apiKey','bearerToken'] THEN
    RAISE EXCEPTION 'unsafe notification payload';
  END IF;
  INSERT INTO persistent_codex.push_notification_outbox
    (tenant_id,organization_id,workspace_id,principal_id,outbox_id,notification_id,subscription_id,device_id,payload)
  SELECT tenant_id,organization_id,workspace_id,principal_id,
    encode(public.digest((p_notification_id || ':' || subscription_id)::bytea,'sha256'),'hex'),
    p_notification_id,subscription_id,device_id,p_payload
  FROM persistent_codex.push_subscriptions
  WHERE tenant_id=p_tenant_id AND organization_id=p_organization_id AND workspace_id=p_workspace_id
    AND status='active' AND (expires_at IS NULL OR expires_at > now())
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END $$;
REVOKE ALL ON FUNCTION persistent_codex.push_enqueue_notification(text,text,text,text,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION persistent_codex.push_claim_deliveries(
  p_now timestamptz,
  p_limit integer
) RETURNS TABLE (
  tenant_id text, organization_id text, workspace_id text, principal_id text,
  outbox_id text, subscription_id text, secret_envelope jsonb, payload jsonb,
  attempt integer
)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, persistent_codex AS $$
  WITH claimed AS (
    SELECT o.tenant_id,o.organization_id,o.workspace_id,o.outbox_id
    FROM persistent_codex.push_notification_outbox o
    JOIN persistent_codex.push_subscriptions s
      USING (tenant_id,organization_id,workspace_id,subscription_id)
    WHERE o.status IN ('pending','retry') AND o.available_at <= p_now
      AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at > p_now)
    ORDER BY o.available_at,o.outbox_id
    FOR UPDATE OF o SKIP LOCKED LIMIT greatest(1,least(p_limit,100))
  ), updated AS (
    UPDATE persistent_codex.push_notification_outbox o
    SET status='delivering',attempt=o.attempt+1
    FROM claimed c
    WHERE (o.tenant_id,o.organization_id,o.workspace_id,o.outbox_id)=
      (c.tenant_id,c.organization_id,c.workspace_id,c.outbox_id)
    RETURNING o.*
  )
  SELECT u.tenant_id,u.organization_id,u.workspace_id,u.principal_id,
    u.outbox_id,u.subscription_id,s.secret_envelope,u.payload,u.attempt
  FROM updated u JOIN persistent_codex.push_subscriptions s
    USING (tenant_id,organization_id,workspace_id,subscription_id);
$$;
REVOKE ALL ON FUNCTION persistent_codex.push_claim_deliveries(timestamptz,integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION persistent_codex.push_complete_delivery(
  p_tenant_id text,p_organization_id text,p_workspace_id text,p_principal_id text,
  p_outbox_id text,p_subscription_id text,p_attempt integer,p_outcome text,
  p_provider_message_id text,p_now timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, persistent_codex AS $$
BEGIN
  IF p_outcome NOT IN ('delivered','retry','invalid_endpoint') THEN
    RAISE EXCEPTION 'invalid push delivery outcome';
  END IF;
  INSERT INTO persistent_codex.push_delivery_receipts
    (tenant_id,organization_id,workspace_id,principal_id,delivery_id,outbox_id,attempt,outcome,provider_message_id,occurred_at)
  VALUES (p_tenant_id,p_organization_id,p_workspace_id,p_principal_id,
    encode(public.digest((p_outbox_id || ':' || p_attempt::text)::bytea,'sha256'),'hex'),
    p_outbox_id,p_attempt,p_outcome,p_provider_message_id,p_now)
  ON CONFLICT DO NOTHING;
  UPDATE persistent_codex.push_notification_outbox SET
    status=CASE p_outcome WHEN 'delivered' THEN 'delivered' WHEN 'retry' THEN 'retry' ELSE 'discarded' END,
    delivered_at=CASE WHEN p_outcome='delivered' THEN p_now ELSE delivered_at END,
    available_at=CASE WHEN p_outcome='retry' THEN p_now + make_interval(secs => least(300,2 ^ least(p_attempt,8))) ELSE available_at END
  WHERE tenant_id=p_tenant_id AND organization_id=p_organization_id AND workspace_id=p_workspace_id
    AND principal_id=p_principal_id AND outbox_id=p_outbox_id AND attempt=p_attempt;
  IF p_outcome='invalid_endpoint' THEN
    UPDATE persistent_codex.push_subscriptions SET status='invalid',row_version=row_version+1
    WHERE tenant_id=p_tenant_id AND organization_id=p_organization_id AND workspace_id=p_workspace_id
      AND principal_id=p_principal_id AND subscription_id=p_subscription_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION persistent_codex.push_complete_delivery(text,text,text,text,text,text,integer,text,text,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION persistent_codex.push_expire_subscriptions(p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, persistent_codex AS $$
DECLARE changed integer;
BEGIN
  UPDATE persistent_codex.push_subscriptions SET status='expired',row_version=row_version+1
  WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= p_now;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION persistent_codex.push_expire_subscriptions(timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION persistent_codex.push_resolve_notification(
  p_principal_id text,p_notification_id text,p_now timestamptz
) RETURNS TABLE (tenant_id text,organization_id text,workspace_id text,payload jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, persistent_codex AS $$
  SELECT o.tenant_id,o.organization_id,o.workspace_id,o.payload
  FROM persistent_codex.push_notification_outbox o
  JOIN persistent_codex.push_subscriptions s
    USING (tenant_id,organization_id,workspace_id,subscription_id,principal_id)
  WHERE o.principal_id=p_principal_id AND o.notification_id=p_notification_id
    AND o.status IN ('delivered','pending','retry') AND s.status='active'
    AND (s.expires_at IS NULL OR s.expires_at > p_now)
  ORDER BY o.created_at DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION persistent_codex.push_resolve_notification(text,text,timestamptz) FROM PUBLIC;
COMMIT;
