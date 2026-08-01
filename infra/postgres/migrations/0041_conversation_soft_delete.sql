BEGIN;

ALTER TABLE persistent_codex.ha_sessions
  ADD COLUMN deleted_at timestamptz;

CREATE INDEX ha_sessions_visible_recent
  ON persistent_codex.ha_sessions
  (tenant_id, organization_id, workspace_id, updated_at DESC, session_id DESC)
  WHERE deleted_at IS NULL;

COMMIT;
