CREATE SCHEMA IF NOT EXISTS persistent_codex;

CREATE TABLE IF NOT EXISTS persistent_codex.wp30_local_fixtures (
  fixture_type text NOT NULL,
  fixture_id text NOT NULL,
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  token_sha256 text,
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (fixture_type, fixture_id)
);

CREATE ROLE wp30_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA persistent_codex TO wp30_runtime;
