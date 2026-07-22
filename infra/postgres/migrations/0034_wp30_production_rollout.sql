CREATE TABLE IF NOT EXISTS persistent_codex.production_rollouts (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  rollout_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('internal','design_partner','limited_beta','production_cohort','halted','rolled_back')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  cohort_id text NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  previous_artifact_sha256 text CHECK (previous_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  feature_flag_enabled boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT false,
  history_head_sha256 text CHECK (history_head_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, rollout_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.production_rollout_commands (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  rollout_id text NOT NULL,
  idempotency_key text NOT NULL,
  command_sha256 text NOT NULL CHECK (command_sha256 ~ '^[0-9a-f]{64}$'),
  expected_version bigint NOT NULL,
  resulting_version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, rollout_id, idempotency_key),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, rollout_id)
    REFERENCES persistent_codex.production_rollouts(tenant_id, organization_id, workspace_id, rollout_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.production_rollout_observations (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  rollout_id text NOT NULL,
  cohort_id text NOT NULL,
  observation_id text NOT NULL,
  request_count bigint NOT NULL CHECK (request_count >= 0),
  success_rate double precision NOT NULL CHECK (success_rate BETWEEN 0 AND 1),
  error_budget_burn_rate double precision NOT NULL CHECK (error_budget_burn_rate >= 0),
  tenant_fairness_ratio double precision NOT NULL CHECK (tenant_fairness_ratio BETWEEN 0 AND 1),
  p95_latency_ms double precision NOT NULL CHECK (p95_latency_ms >= 0),
  event_lag_p95_ms double precision NOT NULL CHECK (event_lag_p95_ms >= 0),
  backlog bigint NOT NULL CHECK (backlog >= 0),
  data_loss bigint NOT NULL CHECK (data_loss >= 0),
  uncontrolled_duplicates bigint NOT NULL CHECK (uncontrolled_duplicates >= 0),
  fence_violations bigint NOT NULL CHECK (fence_violations >= 0),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, rollout_id, cohort_id, observation_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, rollout_id)
    REFERENCES persistent_codex.production_rollouts(tenant_id, organization_id, workspace_id, rollout_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.production_rollout_history (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  rollout_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  from_stage text,
  to_stage text NOT NULL,
  cohort_id text NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  reason_code text NOT NULL,
  previous_history_sha256 text CHECK (previous_history_sha256 ~ '^[0-9a-f]{64}$'),
  history_sha256 text NOT NULL CHECK (history_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, rollout_id, sequence),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, rollout_id)
    REFERENCES persistent_codex.production_rollouts(tenant_id, organization_id, workspace_id, rollout_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.production_go_no_go_records (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  record_id text NOT NULL,
  rollout_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('go','no_go')),
  owner text NOT NULL,
  source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40,64}$'),
  acceptance_report_sha256 text NOT NULL CHECK (acceptance_report_sha256 ~ '^[0-9a-f]{64}$'),
  previous_record_sha256 text CHECK (previous_record_sha256 ~ '^[0-9a-f]{64}$'),
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
  decided_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, record_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, rollout_id)
    REFERENCES persistent_codex.production_rollouts(tenant_id, organization_id, workspace_id, rollout_id)
);

CREATE OR REPLACE FUNCTION persistent_codex.reject_wp30_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'WP30 immutable record cannot be changed' USING ERRCODE = '55000';
END;
$body$;

DROP TRIGGER IF EXISTS production_rollout_history_immutable ON persistent_codex.production_rollout_history;
CREATE TRIGGER production_rollout_history_immutable
BEFORE UPDATE OR DELETE ON persistent_codex.production_rollout_history
FOR EACH ROW EXECUTE FUNCTION persistent_codex.reject_wp30_immutable_mutation();

DROP TRIGGER IF EXISTS production_go_no_go_immutable ON persistent_codex.production_go_no_go_records;
CREATE TRIGGER production_go_no_go_immutable
BEFORE UPDATE OR DELETE ON persistent_codex.production_go_no_go_records
FOR EACH ROW EXECUTE FUNCTION persistent_codex.reject_wp30_immutable_mutation();

DO $body$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'production_rollouts',
    'production_rollout_commands',
    'production_rollout_observations',
    'production_rollout_history',
    'production_go_no_go_records'
  ] LOOP
    EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON persistent_codex.%I', table_name || '_scope', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON persistent_codex.%I USING (tenant_id = current_setting(''app.tenant_id'', true) AND organization_id = current_setting(''app.organization_id'', true) AND workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) AND organization_id = current_setting(''app.organization_id'', true) AND workspace_id = current_setting(''app.workspace_id'', true))',
      table_name || '_scope', table_name
    );
  END LOOP;
END;
$body$;

REVOKE UPDATE, DELETE, TRUNCATE ON persistent_codex.production_rollout_history FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON persistent_codex.production_go_no_go_records FROM PUBLIC;
