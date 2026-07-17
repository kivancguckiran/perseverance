BEGIN;

CREATE TABLE IF NOT EXISTS persistent_codex.sources (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  source_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pdf','markdown','text','code')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 255),
  status text NOT NULL CHECK (status IN ('pending','extracting','indexed','failed','deleted')),
  current_revision_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, source_id),
  UNIQUE (tenant_id, organization_id, workspace_id, source_id, current_revision_id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id),
  CHECK (tenant_id = organization_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.source_revisions (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  source_id text NOT NULL,
  revision_id text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  media_type text NOT NULL,
  parser_version text NOT NULL,
  language text NOT NULL,
  provenance jsonb NOT NULL,
  raw_snapshot_metadata jsonb NOT NULL,
  storage_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','extracting','indexed','failed','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, revision_id),
  UNIQUE (tenant_id, organization_id, workspace_id, source_id, revision_id),
  UNIQUE (tenant_id, organization_id, workspace_id, content_hash),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, source_id)
    REFERENCES persistent_codex.sources (tenant_id, organization_id, workspace_id, source_id),
  CHECK (tenant_id = organization_id),
  CHECK (storage_key LIKE 'raw/' || tenant_id || '/' || organization_id || '/' || workspace_id || '/%'),
  CHECK (raw_snapshot_metadata @> '{"immutable":true}'::jsonb),
  CHECK (NOT (provenance ?| ARRAY['content','secret','token'])),
  CHECK (NOT (raw_snapshot_metadata ?| ARRAY['content','secret','token']))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sources_current_revision_fk'
      AND conrelid = 'persistent_codex.sources'::regclass
  ) THEN
    ALTER TABLE persistent_codex.sources
      ADD CONSTRAINT sources_current_revision_fk
      FOREIGN KEY (tenant_id, organization_id, workspace_id, source_id, current_revision_id)
      REFERENCES persistent_codex.source_revisions
        (tenant_id, organization_id, workspace_id, source_id, revision_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS persistent_codex.extraction_jobs (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  job_id text NOT NULL,
  source_id text NOT NULL,
  revision_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','extracting','indexed','failed','deleted')),
  attempt integer NOT NULL CHECK (attempt > 0),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  lease_owner text,
  lease_expires_at timestamptz,
  retry_at timestamptz,
  error_code text,
  usage_completeness text NOT NULL CHECK (usage_completeness IN ('complete','partial')),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  lock_version bigint NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, job_id),
  UNIQUE (tenant_id, organization_id, workspace_id, revision_id, job_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, source_id, revision_id)
    REFERENCES persistent_codex.source_revisions
      (tenant_id, organization_id, workspace_id, source_id, revision_id),
  CHECK (tenant_id = organization_id),
  CHECK ((status = 'extracting') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS extraction_jobs_one_active_revision
  ON persistent_codex.extraction_jobs
  (tenant_id, organization_id, workspace_id, revision_id)
  WHERE status IN ('pending','extracting');
CREATE INDEX IF NOT EXISTS extraction_jobs_claim_idx
  ON persistent_codex.extraction_jobs
  (tenant_id, organization_id, workspace_id, status, retry_at, lease_expires_at);
ALTER TABLE persistent_codex.extraction_jobs
  ADD COLUMN IF NOT EXISTS lock_version bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION persistent_codex.corpus_recoverable_scopes()
RETURNS TABLE (tenant_id text, organization_id text, workspace_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, persistent_codex
SET row_security = off
AS $$
  SELECT DISTINCT jobs.tenant_id, jobs.organization_id, jobs.workspace_id
  FROM persistent_codex.extraction_jobs AS jobs
  WHERE jobs.status = 'pending'
     OR (jobs.status = 'extracting' AND jobs.lease_expires_at <= now())
$$;
REVOKE ALL ON FUNCTION persistent_codex.corpus_recoverable_scopes() FROM PUBLIC;

CREATE TABLE IF NOT EXISTS persistent_codex.corpus_chunks (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  chunk_id text NOT NULL,
  source_id text NOT NULL,
  revision_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  locator jsonb NOT NULL,
  chunking_policy jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, chunk_id),
  UNIQUE (tenant_id, organization_id, workspace_id, revision_id, ordinal),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, source_id, revision_id)
    REFERENCES persistent_codex.source_revisions
      (tenant_id, organization_id, workspace_id, source_id, revision_id),
  CHECK (tenant_id = organization_id),
  CHECK (NOT (metadata ?| ARRAY['content','secret','token']))
);

CREATE TABLE IF NOT EXISTS persistent_codex.index_documents (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  index_document_id text NOT NULL,
  chunk_id text NOT NULL,
  source_id text NOT NULL,
  revision_id text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  embedding_version text NOT NULL,
  embedding_token_count bigint NOT NULL CHECK (embedding_token_count >= 0),
  status text NOT NULL CHECK (status IN ('pending','extracting','indexed','failed','deleted')),
  derived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, index_document_id),
  UNIQUE (tenant_id, organization_id, workspace_id, chunk_id, embedding_version),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, chunk_id)
    REFERENCES persistent_codex.corpus_chunks
      (tenant_id, organization_id, workspace_id, chunk_id),
  CHECK (tenant_id = organization_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.ingestion_audit (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  audit_id text NOT NULL,
  source_id text NOT NULL,
  revision_id text,
  job_id text,
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success','failure')),
  reason_code text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, audit_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, source_id)
    REFERENCES persistent_codex.sources (tenant_id, organization_id, workspace_id, source_id),
  CHECK (tenant_id = organization_id),
  CHECK (reason_code !~* '(content|secret|token|bearer)\s*[:=]')
);

CREATE TABLE IF NOT EXISTS persistent_codex.corpus_storage_cleanup (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  cleanup_id text NOT NULL,
  storage_key text NOT NULL,
  reason_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, cleanup_id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id),
  CHECK (tenant_id = organization_id),
  CHECK (storage_key LIKE 'raw/' || tenant_id || '/' || organization_id || '/' || workspace_id || '/%')
);
CREATE UNIQUE INDEX IF NOT EXISTS corpus_storage_cleanup_pending_key
  ON persistent_codex.corpus_storage_cleanup
  (tenant_id, organization_id, workspace_id, storage_key)
  WHERE status = 'pending';

ALTER TABLE persistent_codex.usage_ledger
  ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE persistent_codex.usage_ledger
  ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE persistent_codex.usage_ledger
  ADD COLUMN IF NOT EXISTS meter text NOT NULL DEFAULT 'provider_token';
ALTER TABLE persistent_codex.usage_ledger
  ADD COLUMN IF NOT EXISTS dedupe_key text;
ALTER TABLE persistent_codex.usage_ledger
  ADD COLUMN IF NOT EXISTS revision_id text;
ALTER TABLE persistent_codex.usage_ledger
  ADD COLUMN IF NOT EXISTS extraction_job_id text;
ALTER TABLE persistent_codex.usage_ledger
  ADD COLUMN IF NOT EXISTS completeness text NOT NULL DEFAULT 'complete';
UPDATE persistent_codex.usage_ledger
SET tenant_id = organization_id
WHERE tenant_id IS NULL;
ALTER TABLE persistent_codex.usage_ledger
  ALTER COLUMN tenant_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_corpus_dedupe
  ON persistent_codex.usage_ledger
  (organization_id, workspace_id, meter, dedupe_key)
  WHERE meter = 'index_embedding_token';
ALTER TABLE persistent_codex.usage_ledger
  DROP CONSTRAINT IF EXISTS usage_ledger_corpus_completeness;
ALTER TABLE persistent_codex.usage_ledger
  ADD CONSTRAINT usage_ledger_corpus_completeness
  CHECK (completeness IN ('complete','partial','incomplete'));

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sources','source_revisions','extraction_jobs','corpus_chunks',
    'index_documents','ingestion_audit','corpus_storage_cleanup'
  ] LOOP
    EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON persistent_codex.%I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON persistent_codex.%I FOR ALL
       USING (
         tenant_id = current_setting(''app.tenant_id'', true)
         AND organization_id = current_setting(''app.organization_id'', true)
         AND workspace_id = current_setting(''app.workspace_id'', true)
       )
       WITH CHECK (
         tenant_id = current_setting(''app.tenant_id'', true)
         AND organization_id = current_setting(''app.organization_id'', true)
         AND workspace_id = current_setting(''app.workspace_id'', true)
       )', table_name
    );
  END LOOP;
END $$;

DROP POLICY IF EXISTS tenant_isolation ON persistent_codex.usage_ledger;
CREATE POLICY tenant_isolation ON persistent_codex.usage_ledger FOR ALL
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

INSERT INTO persistent_codex.security_migrations(version)
VALUES (21) ON CONFLICT DO NOTHING;

COMMIT;
