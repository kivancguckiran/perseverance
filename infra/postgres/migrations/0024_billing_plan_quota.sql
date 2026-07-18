BEGIN;

CREATE TABLE persistent_codex.commercial_plans (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  plan_id text NOT NULL,
  plan_version integer NOT NULL CHECK (plan_version > 0),
  display_name text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_mode text NOT NULL CHECK (billing_mode IN ('platform_managed','byok','hybrid')),
  tax_behavior text NOT NULL CHECK (tax_behavior IN ('provider_determined','exclusive','inclusive','unknown')),
  effective_at timestamptz NOT NULL,
  retired_at timestamptz,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,plan_id,plan_version),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id)
);

CREATE TABLE persistent_codex.billing_customers (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  billing_customer_id text NOT NULL,
  provider text NOT NULL,
  provider_customer_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,billing_customer_id),
  UNIQUE (tenant_id,organization_id,workspace_id,provider,provider_customer_reference),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id),
  CHECK (provider_customer_reference !~* '(secret|token|bearer|credential)\s*[:=]')
);

CREATE TABLE persistent_codex.billing_webhook_events (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  webhook_event_id text NOT NULL,
  provider text NOT NULL,
  signature_version text NOT NULL,
  event_type text NOT NULL,
  provider_sequence bigint NOT NULL CHECK (provider_sequence >= 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL,
  effective_at timestamptz NOT NULL,
  processing_state text NOT NULL CHECK (processing_state IN ('received','processing','processed','unknown','retry','dead_letter')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,provider,webhook_event_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id),
  CHECK (last_error_code IS NULL OR last_error_code !~* '(secret|token|bearer|credential|payload)\s*[:=]')
);
CREATE INDEX billing_webhook_recovery_idx ON persistent_codex.billing_webhook_events
  (processing_state,updated_at) WHERE processing_state IN ('received','processing','retry');

CREATE TABLE persistent_codex.billing_subscriptions (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  subscription_id text NOT NULL,
  billing_customer_id text NOT NULL,
  plan_id text NOT NULL,
  plan_version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('trialing','active','past_due','paused','cancelled','unknown')),
  provider text NOT NULL,
  provider_sequence bigint NOT NULL CHECK (provider_sequence >= 0),
  effective_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  source_webhook_event_id text,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,subscription_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,billing_customer_id)
    REFERENCES persistent_codex.billing_customers(tenant_id,organization_id,workspace_id,billing_customer_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,plan_id,plan_version)
    REFERENCES persistent_codex.commercial_plans(tenant_id,organization_id,workspace_id,plan_id,plan_version),
  CHECK (tenant_id=organization_id)
);

CREATE TABLE persistent_codex.entitlements (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  entitlement_id text NOT NULL,
  plan_id text NOT NULL,
  plan_version integer NOT NULL,
  entitlement_key text NOT NULL CHECK (entitlement_key IN ('turn.start','source.upload','source.index','source.retrieval','workspace.concurrency')),
  enabled boolean NOT NULL,
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  source_webhook_event_id text,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,entitlement_id),
  UNIQUE (tenant_id,organization_id,workspace_id,plan_id,plan_version,entitlement_key),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,plan_id,plan_version)
    REFERENCES persistent_codex.commercial_plans(tenant_id,organization_id,workspace_id,plan_id,plan_version),
  CHECK (tenant_id=organization_id)
);

CREATE TABLE persistent_codex.budgets (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  budget_id text NOT NULL,
  period text NOT NULL CHECK (period IN ('day','month')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  soft_limit_micros bigint CHECK (soft_limit_micros >= 0),
  hard_limit_micros bigint CHECK (hard_limit_micros > 0),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,budget_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id),
  CHECK (hard_limit_micros IS NULL OR soft_limit_micros IS NULL OR hard_limit_micros >= soft_limit_micros)
);

CREATE TABLE persistent_codex.quota_policies (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  quota_id text NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  meter text NOT NULL CHECK (meter IN ('tenant_concurrent_turn','session_concurrent_turn','provider_spend_micros','corpus_source','corpus_byte','corpus_chunk','storage_byte')),
  soft_limit bigint CHECK (soft_limit >= 0),
  hard_limit bigint CHECK (hard_limit > 0),
  in_flight_policy text NOT NULL CHECK (in_flight_policy IN ('continue','interrupt')),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,quota_id,policy_version),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id),
  CHECK (hard_limit IS NULL OR soft_limit IS NULL OR hard_limit >= soft_limit)
);

CREATE TABLE persistent_codex.quota_decisions (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  decision_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('turn.start','source.upload','source.index','source.retrieval','workspace.concurrency')),
  outcome text NOT NULL CHECK (outcome IN ('allow','warn','deny')),
  reason_code text NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  measurement_watermark text NOT NULL,
  in_flight_policy text NOT NULL CHECK (in_flight_policy IN ('continue','interrupt')),
  evaluated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,decision_id),
  UNIQUE (tenant_id,organization_id,workspace_id,operation,measurement_watermark,policy_version),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id),
  CHECK (reason_code !~* '(secret|token|bearer|credential|payload)\s*[:=]')
);

CREATE TABLE persistent_codex.invoice_reconciliations (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  reconciliation_id text NOT NULL,
  invoice_id text NOT NULL,
  provider text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  ledger_watermark text NOT NULL,
  measured_amount_micros bigint NOT NULL CHECK (measured_amount_micros >= 0),
  provider_amount_micros bigint NOT NULL CHECK (provider_amount_micros >= 0),
  difference_micros bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','matched','variance','incomplete')),
  reconciled_at timestamptz,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,reconciliation_id),
  UNIQUE (tenant_id,organization_id,workspace_id,provider,invoice_id,ledger_watermark),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id)
);

ALTER TABLE persistent_codex.usage_ledger ADD COLUMN IF NOT EXISTS meter_version integer NOT NULL DEFAULT 1;
ALTER TABLE persistent_codex.usage_ledger ADD COLUMN IF NOT EXISTS usage_status text NOT NULL DEFAULT 'measured';
ALTER TABLE persistent_codex.usage_ledger ADD COLUMN IF NOT EXISTS price_catalog_version text;
ALTER TABLE persistent_codex.usage_ledger ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE persistent_codex.usage_ledger ADD COLUMN IF NOT EXISTS estimated_cost_micros bigint;
ALTER TABLE persistent_codex.usage_ledger ADD COLUMN IF NOT EXISTS official_cost_micros bigint;
ALTER TABLE persistent_codex.usage_ledger ADD COLUMN IF NOT EXISTS occurred_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE persistent_codex.usage_ledger ADD CONSTRAINT usage_ledger_meter_v1
  CHECK (meter IN ('provider_token','provider_input_token','provider_cached_input_token','provider_output_token','provider_reasoning_token','provider_reported_cost_micros','compute_millisecond','storage_byte_millisecond','egress_byte','index_embedding_token','retrieval_embedding_token'));
ALTER TABLE persistent_codex.usage_ledger ADD CONSTRAINT usage_ledger_status_v1
  CHECK (usage_status IN ('measured','estimated','reconciled','incomplete'));
ALTER TABLE persistent_codex.usage_ledger ADD CONSTRAINT usage_ledger_cost_nonnegative
  CHECK ((estimated_cost_micros IS NULL OR estimated_cost_micros >= 0) AND (official_cost_micros IS NULL OR official_cost_micros >= 0));
CREATE UNIQUE INDEX usage_ledger_wp24_dedupe ON persistent_codex.usage_ledger
  (tenant_id,organization_id,workspace_id,meter,dedupe_key) WHERE dedupe_key IS NOT NULL;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commercial_plans','billing_customers','billing_webhook_events','billing_subscriptions',
    'entitlements','budgets','quota_policies','quota_decisions','invoice_reconciliations'
  ] LOOP
    EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON persistent_codex.%I FOR ALL USING (
        tenant_id=current_setting(''app.tenant_id'',true) AND
        organization_id=current_setting(''app.organization_id'',true) AND
        workspace_id=current_setting(''app.workspace_id'',true)
      ) WITH CHECK (
        tenant_id=current_setting(''app.tenant_id'',true) AND
        organization_id=current_setting(''app.organization_id'',true) AND
        workspace_id=current_setting(''app.workspace_id'',true)
      )',table_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION persistent_codex.billing_claim_webhooks(p_now timestamptz,p_limit integer)
RETURNS TABLE (tenant_id text,organization_id text,workspace_id text,provider text,webhook_event_id text,event_type text,provider_sequence bigint,payload_digest text,effective_at timestamptz,attempt integer)
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
  ) SELECT tenant_id,organization_id,workspace_id,provider,webhook_event_id,event_type,provider_sequence,payload_digest,effective_at,attempt FROM updated;
$$;
REVOKE ALL ON FUNCTION persistent_codex.billing_claim_webhooks(timestamptz,integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION persistent_codex.billing_recover_stale_webhooks(p_now timestamptz,p_lease_ms integer)
RETURNS TABLE (webhook_event_id text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,persistent_codex AS $$
  UPDATE persistent_codex.billing_webhook_events
  SET processing_state='retry',last_error_code='PROCESS_RESTART',updated_at=p_now
  WHERE processing_state='processing'
    AND updated_at < p_now - greatest(1,p_lease_ms) * interval '1 millisecond'
  RETURNING webhook_event_id;
$$;
REVOKE ALL ON FUNCTION persistent_codex.billing_recover_stale_webhooks(timestamptz,integer) FROM PUBLIC;

INSERT INTO persistent_codex.security_migrations(version) VALUES (24) ON CONFLICT DO NOTHING;
COMMIT;
