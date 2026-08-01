BEGIN;

ALTER TABLE persistent_codex.ha_sessions
  ADD COLUMN folder_id text,
  ADD COLUMN title text,
  ADD COLUMN requested_policy jsonb,
  ADD COLUMN resolved_model text,
  ADD COLUMN reasoning_effort text,
  ADD COLUMN title_generated_at timestamptz;

UPDATE persistent_codex.ha_sessions
SET folder_id = 'fol_default',
    title = 'Yeni konuşma',
    requested_policy = '{"alias":"sol","reasoningEffort":"medium"}'::jsonb,
    reasoning_effort = 'medium'
WHERE folder_id IS NULL
   OR title IS NULL
   OR requested_policy IS NULL
   OR reasoning_effort IS NULL;

ALTER TABLE persistent_codex.ha_sessions
  ALTER COLUMN folder_id SET DEFAULT 'fol_default',
  ALTER COLUMN folder_id SET NOT NULL,
  ALTER COLUMN title SET DEFAULT 'Yeni konuşma',
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN requested_policy SET DEFAULT '{"alias":"sol","reasoningEffort":"medium"}'::jsonb,
  ALTER COLUMN requested_policy SET NOT NULL,
  ALTER COLUMN reasoning_effort SET DEFAULT 'medium',
  ALTER COLUMN reasoning_effort SET NOT NULL,
  ADD CONSTRAINT ha_sessions_title_length CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  ADD CONSTRAINT ha_sessions_reasoning_effort CHECK (
    reasoning_effort IN ('none','minimal','low','medium','high','xhigh','max')
  );

CREATE INDEX ha_sessions_recent
  ON persistent_codex.ha_sessions
  (tenant_id, organization_id, workspace_id, status, updated_at DESC, session_id DESC);

COMMIT;
