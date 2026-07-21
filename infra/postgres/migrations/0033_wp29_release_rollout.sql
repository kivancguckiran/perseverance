CREATE TABLE IF NOT EXISTS persistent_codex.release_rollouts (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  rollout_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('build','verified','internal','canary','limited_cohort','production_ready','halted','rolled_back')),
  version bigint NOT NULL DEFAULT 1,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  previous_artifact_sha256 text CHECK (previous_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL,
  provider_version text NOT NULL,
  runtime_version text NOT NULL,
  protocol_schema_sha256 text NOT NULL CHECK (protocol_schema_sha256 ~ '^[0-9a-f]{64}$'),
  migration_compatible boolean NOT NULL DEFAULT false,
  cohort text NOT NULL,
  kill_switch boolean NOT NULL DEFAULT false,
  previous_record_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, rollout_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.release_rollout_commands (
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
    REFERENCES persistent_codex.release_rollouts(tenant_id, organization_id, workspace_id, rollout_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.release_evidence_chain (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  evidence_id text NOT NULL,
  control_id text NOT NULL,
  automation_run_id text NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  previous_evidence_sha256 text,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.release_rollout_approvals (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  rollout_id text NOT NULL,
  approval_id text NOT NULL,
  expected_version bigint NOT NULL,
  approver_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  decision_sha256 text NOT NULL CHECK (decision_sha256 ~ '^[0-9a-f]{64}$'),
  decided_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, rollout_id, approval_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, rollout_id)
    REFERENCES persistent_codex.release_rollouts(tenant_id, organization_id, workspace_id, rollout_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.release_rollout_history (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  rollout_id text NOT NULL,
  sequence bigint NOT NULL,
  from_state text,
  to_state text NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  cohort text NOT NULL,
  reason text NOT NULL,
  previous_history_sha256 text,
  history_sha256 text NOT NULL CHECK (history_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, rollout_id, sequence),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, rollout_id)
    REFERENCES persistent_codex.release_rollouts(tenant_id, organization_id, workspace_id, rollout_id)
);

ALTER TABLE persistent_codex.release_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.release_rollouts FORCE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.release_rollout_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.release_rollout_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.release_evidence_chain ENABLE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.release_evidence_chain FORCE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.release_rollout_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.release_rollout_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.release_rollout_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.release_rollout_history FORCE ROW LEVEL SECURITY;

CREATE POLICY release_rollouts_scope ON persistent_codex.release_rollouts
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
  );

CREATE POLICY release_rollout_commands_scope ON persistent_codex.release_rollout_commands
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
  );

CREATE POLICY release_evidence_chain_scope ON persistent_codex.release_evidence_chain
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
  );

CREATE POLICY release_rollout_approvals_scope ON persistent_codex.release_rollout_approvals
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
  );

CREATE POLICY release_rollout_history_scope ON persistent_codex.release_rollout_history
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
  );
