BEGIN;

ALTER TABLE persistent_codex.scheduler_queue
  ADD COLUMN IF NOT EXISTS trace_id text NULL CHECK (trace_id IS NULL OR trace_id ~ '^[a-f0-9]{32}$');
ALTER TABLE persistent_codex.ha_runs
  ADD COLUMN IF NOT EXISTS trace_id text NULL CHECK (trace_id IS NULL OR trace_id ~ '^[a-f0-9]{32}$');
ALTER TABLE persistent_codex.ha_events
  ADD COLUMN IF NOT EXISTS trace_id text NULL CHECK (trace_id IS NULL OR trace_id ~ '^[a-f0-9]{32}$');
ALTER TABLE persistent_codex.ha_approvals
  ADD COLUMN IF NOT EXISTS trace_id text NULL CHECK (trace_id IS NULL OR trace_id ~ '^[a-f0-9]{32}$');
ALTER TABLE persistent_codex.ha_runtime_starts
  ADD COLUMN IF NOT EXISTS trace_id text NULL CHECK (trace_id IS NULL OR trace_id ~ '^[a-f0-9]{32}$');

CREATE TABLE IF NOT EXISTS persistent_codex.dr_backup_manifests (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  manifest_id text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  source_region text NOT NULL,
  consistency_watermark jsonb NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  previous_manifest_sha256 text NULL CHECK (previous_manifest_sha256 IS NULL OR previous_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, manifest_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces(tenant_id, organization_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.dr_acceptance_evidence (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  evidence_id text NOT NULL,
  manifest_id text NOT NULL,
  scenario text NOT NULL,
  status text NOT NULL CHECK (status IN ('passed','failed')),
  rpo_ms bigint NOT NULL CHECK (rpo_ms >= 0),
  rto_ms bigint NOT NULL CHECK (rto_ms >= 0),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  previous_evidence_sha256 text NULL CHECK (previous_evidence_sha256 IS NULL OR previous_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, evidence_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, manifest_id)
    REFERENCES persistent_codex.dr_backup_manifests(tenant_id, organization_id, workspace_id, manifest_id)
);

ALTER TABLE persistent_codex.dr_backup_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.dr_backup_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.dr_acceptance_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE persistent_codex.dr_acceptance_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY dr_backup_manifest_scope ON persistent_codex.dr_backup_manifests
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY dr_acceptance_evidence_scope ON persistent_codex.dr_acceptance_evidence
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND organization_id = current_setting('app.organization_id', true)
    AND workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION persistent_codex.reject_wp27_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WP27_IMMUTABLE_RECORD';
END;
$$;
DROP TRIGGER IF EXISTS dr_backup_manifest_immutable ON persistent_codex.dr_backup_manifests;
CREATE TRIGGER dr_backup_manifest_immutable BEFORE UPDATE OR DELETE ON persistent_codex.dr_backup_manifests
  FOR EACH ROW EXECUTE FUNCTION persistent_codex.reject_wp27_immutable_mutation();
DROP TRIGGER IF EXISTS dr_acceptance_evidence_immutable ON persistent_codex.dr_acceptance_evidence;
CREATE TRIGGER dr_acceptance_evidence_immutable BEFORE UPDATE OR DELETE ON persistent_codex.dr_acceptance_evidence
  FOR EACH ROW EXECUTE FUNCTION persistent_codex.reject_wp27_immutable_mutation();

COMMIT;
