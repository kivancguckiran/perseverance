BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE persistent_codex.source_revisions
  DROP CONSTRAINT IF EXISTS source_revisions_status_check;
ALTER TABLE persistent_codex.source_revisions
  ADD CONSTRAINT source_revisions_status_check
  CHECK (status IN ('pending','extracting','indexed','failed','deleted','superseded'));

ALTER TABLE persistent_codex.sources
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'workspace'
    CHECK (visibility IN ('workspace','principals'));
ALTER TABLE persistent_codex.sources
  ADD COLUMN IF NOT EXISTS acl_version bigint NOT NULL DEFAULT 1
    CHECK (acl_version > 0);

CREATE TABLE IF NOT EXISTS persistent_codex.source_acl_principals (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  source_id text NOT NULL,
  principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, source_id, principal_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, source_id)
    REFERENCES persistent_codex.sources
      (tenant_id, organization_id, workspace_id, source_id) ON DELETE CASCADE,
  CHECK (tenant_id = organization_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.workspace_source_paths (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  workspace_path text NOT NULL,
  source_id text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, workspace_path),
  UNIQUE (tenant_id, organization_id, workspace_id, source_id),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, source_id)
    REFERENCES persistent_codex.sources
      (tenant_id, organization_id, workspace_id, source_id) ON DELETE CASCADE,
  CHECK (tenant_id = organization_id),
  CHECK (workspace_path !~ '(^|/)\.\.(/|$)' AND workspace_path !~ '^/')
);

ALTER TABLE persistent_codex.corpus_chunks
  ADD COLUMN IF NOT EXISTS content_text text;
ALTER TABLE persistent_codex.corpus_chunks
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content_text, ''))) STORED;
ALTER TABLE persistent_codex.corpus_chunks
  ADD CONSTRAINT corpus_chunks_content_bound
    CHECK (content_text IS NULL OR octet_length(content_text) BETWEEN 1 AND 65536)
    NOT VALID;

ALTER TABLE persistent_codex.index_documents
  ADD COLUMN IF NOT EXISTS embedding vector(384);
ALTER TABLE persistent_codex.index_documents
  ADD COLUMN IF NOT EXISTS index_version text NOT NULL DEFAULT 'corpus-index-v1';
ALTER TABLE persistent_codex.index_documents
  ADD COLUMN IF NOT EXISTS ranking_policy_version text NOT NULL DEFAULT 'hybrid-rrf-v1';

CREATE INDEX IF NOT EXISTS corpus_chunks_lexical_idx
  ON persistent_codex.corpus_chunks USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS index_documents_embedding_idx
  ON persistent_codex.index_documents USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND status = 'indexed';

CREATE TABLE IF NOT EXISTS persistent_codex.corpus_index_migrations (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  migration_id text NOT NULL,
  from_index_version text NOT NULL,
  to_index_version text NOT NULL,
  embedding_version text NOT NULL,
  ranking_policy_version text NOT NULL,
  state text NOT NULL CHECK (state IN (
    'expanding','backfilling','active','rolling_back','rolled_back','failed'
  )),
  checkpoint_revision_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  lock_version bigint NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, migration_id),
  UNIQUE (tenant_id, organization_id, workspace_id, to_index_version),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id),
  CHECK (tenant_id = organization_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.corpus_reindex_jobs (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  reindex_job_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('full_rebuild','version_migration','rollback')),
  target_index_version text NOT NULL,
  target_embedding_version text NOT NULL,
  target_ranking_policy_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','running','completed','failed','interrupted')),
  checkpoint_revision_id text,
  processed_revisions bigint NOT NULL DEFAULT 0 CHECK (processed_revisions >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, organization_id, workspace_id, reindex_job_id),
  UNIQUE (tenant_id, organization_id, workspace_id, idempotency_key),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id),
  CHECK (tenant_id = organization_id),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS persistent_codex.corpus_watch_jobs (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  watch_job_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('create','update','rename','delete')),
  workspace_path text NOT NULL,
  previous_workspace_path text,
  content_hash text,
  status text NOT NULL CHECK (status IN ('pending','processing','completed','failed','superseded')),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, watch_job_id),
  UNIQUE (tenant_id, organization_id, workspace_id, idempotency_key),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id),
  CHECK (tenant_id = organization_id),
  CHECK (workspace_path !~ '(^|/)\.\.(/|$)')
);

CREATE TABLE IF NOT EXISTS persistent_codex.corpus_tombstones (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  source_id text NOT NULL,
  revision_id text,
  reason text NOT NULL CHECK (reason IN ('source_deleted','revision_superseded','workspace_file_changed')),
  tombstoned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id, source_id, tombstoned_at),
  FOREIGN KEY (tenant_id, organization_id, workspace_id, source_id)
    REFERENCES persistent_codex.sources (tenant_id, organization_id, workspace_id, source_id),
  CHECK (tenant_id = organization_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.corpus_cache_epochs (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id, workspace_id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id),
  CHECK (tenant_id = organization_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_retrieval_embedding_dedupe
  ON persistent_codex.usage_ledger
  (organization_id, workspace_id, meter, dedupe_key)
  WHERE meter = 'retrieval_embedding_token';

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'source_acl_principals','workspace_source_paths','corpus_index_migrations','corpus_reindex_jobs',
    'corpus_watch_jobs','corpus_tombstones','corpus_cache_epochs'
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

INSERT INTO persistent_codex.security_migrations(version)
VALUES (22) ON CONFLICT DO NOTHING;

COMMIT;
