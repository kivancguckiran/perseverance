BEGIN;

CREATE TABLE IF NOT EXISTS persistent_codex.workspace_crypto_state (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  kms_provider text NOT NULL,
  kms_key_id text NOT NULL,
  current_key_version text NOT NULL,
  envelope_format_version integer NOT NULL CHECK (envelope_format_version = 1),
  crypto_erased_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workspace_id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.workspace_security_audit (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  audit_id bigint GENERATED ALWAYS AS IDENTITY,
  runtime_id text,
  action text NOT NULL CHECK (action IN (
    'network.decision', 'secret.lease_issued', 'secret.lease_revoked',
    'key.rotated', 'workspace.crypto_erased', 'backup.created',
    'backup.restored', 'backfill.completed'
  )),
  outcome text NOT NULL CHECK (outcome IN ('allow','deny','success','failure')),
  reason_code text NOT NULL,
  key_version text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workspace_id, audit_id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.sensitive_records (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  record_type text NOT NULL CHECK (record_type IN (
    'prompt','model_output','raw_event'
  )),
  record_id text NOT NULL,
  envelope_format_version integer NOT NULL CHECK (envelope_format_version = 1),
  algorithm text NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  encryption_key_version text NOT NULL,
  encrypted_dek bytea NOT NULL,
  nonce bytea NOT NULL,
  authentication_tag bytea NOT NULL,
  aad_sha256 bytea NOT NULL,
  ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    organization_id, workspace_id, session_id, record_type, record_id
  ),
  FOREIGN KEY (organization_id, workspace_id, session_id)
    REFERENCES persistent_codex.sessions (
      organization_id, workspace_id, session_id
    )
);

ALTER TABLE persistent_codex.events
  ADD COLUMN IF NOT EXISTS payload_envelope bytea,
  ADD COLUMN IF NOT EXISTS encryption_format_version integer,
  ADD COLUMN IF NOT EXISTS encryption_key_version text,
  ALTER COLUMN payload DROP NOT NULL;

ALTER TABLE persistent_codex.events
  DROP CONSTRAINT IF EXISTS events_encrypted_payload_check;
ALTER TABLE persistent_codex.events
  ADD CONSTRAINT events_encrypted_payload_check CHECK (
    (payload IS NOT NULL AND payload_envelope IS NULL)
    OR
    (
      payload IS NULL
      AND payload_envelope IS NOT NULL
      AND encryption_format_version = 1
      AND encryption_key_version IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE persistent_codex.artifacts
  ADD COLUMN IF NOT EXISTS encryption_format_version integer,
  ADD COLUMN IF NOT EXISTS encryption_key_version text,
  ADD COLUMN IF NOT EXISTS encrypted_dek bytea,
  ADD COLUMN IF NOT EXISTS chunk_manifest jsonb;

ALTER TABLE persistent_codex.attachments
  ADD COLUMN IF NOT EXISTS encryption_format_version integer,
  ADD COLUMN IF NOT EXISTS encryption_key_version text,
  ADD COLUMN IF NOT EXISTS encrypted_dek bytea,
  ADD COLUMN IF NOT EXISTS chunk_manifest jsonb;

CREATE TABLE IF NOT EXISTS persistent_codex.encryption_backfill_jobs (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  job_id text NOT NULL,
  record_type text NOT NULL CHECK (record_type IN (
    'event','artifact','attachment'
  )),
  status text NOT NULL CHECK (status IN (
    'queued','running','completed','failed'
  )),
  cursor text,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workspace_id, job_id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_crypto_state','workspace_security_audit','sensitive_records',
    'encryption_backfill_jobs'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY',
      table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON persistent_codex.%I',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON persistent_codex.%I
       FOR ALL
       USING (
         organization_id = current_setting(''app.organization_id'', true)
         AND workspace_id = current_setting(''app.workspace_id'', true)
       )
       WITH CHECK (
         organization_id = current_setting(''app.organization_id'', true)
         AND workspace_id = current_setting(''app.workspace_id'', true)
       )',
      table_name
    );
  END LOOP;
END $$;

INSERT INTO persistent_codex.security_migrations(version)
VALUES (19) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION persistent_codex.wp19_security_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, persistent_codex
AS $$
  SELECT
    persistent_codex.security_ready()
    AND EXISTS (
      SELECT 1 FROM persistent_codex.security_migrations WHERE version = 19
    )
    AND NOT EXISTS (
      SELECT 1
      FROM (
        VALUES
          ('workspace_crypto_state'),
          ('workspace_security_audit'),
          ('sensitive_records'),
          ('encryption_backfill_jobs')
      ) AS required_table(table_name)
      LEFT JOIN pg_catalog.pg_class relation
        ON relation.relname = required_table.table_name
       AND relation.relnamespace = 'persistent_codex'::regnamespace
      WHERE relation.oid IS NULL
         OR NOT relation.relrowsecurity
         OR NOT relation.relforcerowsecurity
         OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_policy policy
           WHERE policy.polrelid = relation.oid
             AND policy.polname = 'tenant_isolation'
         )
    );
$$;

REVOKE ALL ON FUNCTION persistent_codex.wp19_security_ready() FROM PUBLIC;

COMMIT;
