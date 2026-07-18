BEGIN;

CREATE TABLE persistent_codex.retail_price_catalogs (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  catalog_id text NOT NULL,
  catalog_version text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rates jsonb NOT NULL CHECK (jsonb_typeof(rates)='array' AND pg_column_size(rates)<=32768),
  operation_maximums jsonb NOT NULL CHECK (jsonb_typeof(operation_maximums)='array' AND pg_column_size(operation_maximums)<=16384),
  idempotency_key text NOT NULL,
  payment_reference text,
  usage_dedupe_key text,
  run_id text,
  operation_reference text,
  occurred_at timestamptz NOT NULL,
  effective_at timestamptz NOT NULL,
  retired_at timestamptz,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,catalog_id,catalog_version),
  UNIQUE (tenant_id,organization_id,workspace_id,idempotency_key),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id)
);

CREATE TABLE persistent_codex.credit_lots (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  lot_id text NOT NULL,
  lot_kind text NOT NULL CHECK (lot_kind IN ('paid','promotional')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  original_credits_micros bigint NOT NULL CHECK (original_credits_micros>=0),
  original_cash_micros bigint NOT NULL CHECK (original_cash_micros>=0),
  idempotency_key text NOT NULL,
  payment_reference text,
  usage_dedupe_key text,
  run_id text,
  operation_reference text,
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz,
  source_webhook_event_id text,
  consumption_policy_version integer NOT NULL CHECK (consumption_policy_version>0),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,lot_id),
  UNIQUE (tenant_id,organization_id,workspace_id,idempotency_key),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id)
);
CREATE UNIQUE INDEX credit_lots_payment_ref_unique
  ON persistent_codex.credit_lots(tenant_id,organization_id,workspace_id,payment_reference)
  WHERE payment_reference IS NOT NULL AND lot_kind='paid';

CREATE TABLE persistent_codex.credit_reservations (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  reservation_id text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('turn.start','source.upload','source.index','source.retrieval','workspace.concurrency')),
  retail_price_catalog_version text NOT NULL,
  maximum_credits_micros bigint NOT NULL CHECK (maximum_credits_micros>0),
  settled_credits_micros bigint NOT NULL DEFAULT 0 CHECK (settled_credits_micros>=0),
  released_credits_micros bigint NOT NULL DEFAULT 0 CHECK (released_credits_micros>=0),
  state text NOT NULL CHECK (state IN ('reserved','partially_settled','settled','released')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  payment_reference text,
  usage_dedupe_key text,
  run_id text,
  operation_reference text,
  occurred_at timestamptz NOT NULL,
  resolved_at timestamptz,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,reservation_id),
  UNIQUE (tenant_id,organization_id,workspace_id,idempotency_key),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id),
  CHECK (settled_credits_micros+released_credits_micros<=maximum_credits_micros)
);

CREATE TABLE persistent_codex.credit_reservation_allocations (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  reservation_id text NOT NULL,
  lot_id text NOT NULL,
  allocation_order integer NOT NULL CHECK (allocation_order>0),
  reserved_credits_micros bigint NOT NULL CHECK (reserved_credits_micros>0),
  settled_credits_micros bigint NOT NULL DEFAULT 0 CHECK (settled_credits_micros>=0),
  released_credits_micros bigint NOT NULL DEFAULT 0 CHECK (released_credits_micros>=0),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,reservation_id,lot_id),
  UNIQUE (tenant_id,organization_id,workspace_id,reservation_id,allocation_order),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,reservation_id)
    REFERENCES persistent_codex.credit_reservations(tenant_id,organization_id,workspace_id,reservation_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,lot_id)
    REFERENCES persistent_codex.credit_lots(tenant_id,organization_id,workspace_id,lot_id),
  CHECK (tenant_id=organization_id),
  CHECK (settled_credits_micros+released_credits_micros<=reserved_credits_micros)
);

CREATE TABLE persistent_codex.credit_settlements (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  settlement_id text NOT NULL,
  reservation_id text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key text NOT NULL,
  retail_price_catalog_version text NOT NULL,
  measured_credits_micros bigint NOT NULL CHECK (measured_credits_micros>=0),
  released_credits_micros bigint NOT NULL CHECK (released_credits_micros>=0),
  usage_status text NOT NULL CHECK (usage_status IN ('measured','estimated','reconciled','incomplete')),
  outcome text NOT NULL CHECK (outcome IN ('completed','failed','interrupted','incomplete')),
  terminal boolean NOT NULL,
  payment_reference text,
  usage_dedupe_key text NOT NULL,
  run_id text,
  operation_reference text,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,settlement_id),
  UNIQUE (tenant_id,organization_id,workspace_id,idempotency_key),
  UNIQUE (tenant_id,organization_id,workspace_id,usage_dedupe_key),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,reservation_id)
    REFERENCES persistent_codex.credit_reservations(tenant_id,organization_id,workspace_id,reservation_id),
  CHECK (tenant_id=organization_id)
);

CREATE TABLE persistent_codex.credit_ledger_entries (
  ledger_sequence bigserial,
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  ledger_entry_id text NOT NULL,
  lot_id text NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('purchase','promotional_grant','reservation','reservation_release','usage_settlement','refund','chargeback','expiration','admin_adjustment')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  credit_amount_micros bigint NOT NULL CHECK (credit_amount_micros<>0),
  cash_amount_micros bigint NOT NULL DEFAULT 0 CHECK (cash_amount_micros>=0),
  idempotency_key text NOT NULL,
  payment_reference text,
  usage_dedupe_key text,
  run_id text,
  operation_reference text,
  reservation_id text,
  settlement_id text,
  source_webhook_event_id text,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id,workspace_id,ledger_entry_id),
  UNIQUE (tenant_id,organization_id,workspace_id,idempotency_key),
  UNIQUE (tenant_id,organization_id,workspace_id,ledger_sequence),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,lot_id)
    REFERENCES persistent_codex.credit_lots(tenant_id,organization_id,workspace_id,lot_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,reservation_id)
    REFERENCES persistent_codex.credit_reservations(tenant_id,organization_id,workspace_id,reservation_id),
  FOREIGN KEY (tenant_id,organization_id,workspace_id,settlement_id)
    REFERENCES persistent_codex.credit_settlements(tenant_id,organization_id,workspace_id,settlement_id),
  CHECK (tenant_id=organization_id)
);
CREATE INDEX credit_ledger_lot_order_idx ON persistent_codex.credit_ledger_entries
  (tenant_id,organization_id,workspace_id,lot_id,ledger_sequence);

CREATE TABLE persistent_codex.financial_projection_checkpoints (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  projection_id text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  retail_price_catalog_version text NOT NULL,
  ledger_watermark text NOT NULL,
  idempotency_key text NOT NULL,
  payment_reference text,
  usage_dedupe_key text,
  run_id text,
  operation_reference text,
  occurred_at timestamptz NOT NULL,
  cash_collected_micros bigint NOT NULL,
  outstanding_paid_credit_liability_micros bigint NOT NULL,
  consumed_paid_credit_revenue_micros bigint NOT NULL CHECK (consumed_paid_credit_revenue_micros>=0),
  promotional_consumption_micros bigint NOT NULL CHECK (promotional_consumption_micros>=0),
  refunds_micros bigint NOT NULL CHECK (refunds_micros>=0),
  chargebacks_micros bigint NOT NULL CHECK (chargebacks_micros>=0),
  provider_cogs_micros bigint NOT NULL CHECK (provider_cogs_micros>=0),
  infrastructure_cogs_micros bigint NOT NULL CHECK (infrastructure_cogs_micros>=0),
  gross_margin_micros bigint NOT NULL,
  projected_at timestamptz NOT NULL,
  accounting_status text NOT NULL CHECK (accounting_status='operational_projection_not_tax_advice'),
  PRIMARY KEY (tenant_id,organization_id,workspace_id,projection_id),
  UNIQUE (tenant_id,organization_id,workspace_id,idempotency_key),
  UNIQUE (tenant_id,organization_id,workspace_id,ledger_watermark,retail_price_catalog_version),
  FOREIGN KEY (tenant_id,organization_id,workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id,organization_id,workspace_id),
  CHECK (tenant_id=organization_id)
);

CREATE FUNCTION persistent_codex.reject_credit_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'credit ledger is append-only' USING ERRCODE='55000';
END $$;
CREATE TRIGGER credit_ledger_no_update_delete
BEFORE UPDATE OR DELETE ON persistent_codex.credit_ledger_entries
FOR EACH ROW EXECUTE FUNCTION persistent_codex.reject_credit_ledger_mutation();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'retail_price_catalogs','credit_lots','credit_reservations',
    'credit_reservation_allocations','credit_settlements','credit_ledger_entries',
    'financial_projection_checkpoints'
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

INSERT INTO persistent_codex.security_migrations(version) VALUES (26) ON CONFLICT DO NOTHING;
COMMIT;
