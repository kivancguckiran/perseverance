BEGIN;

CREATE SCHEMA IF NOT EXISTS persistent_codex;

CREATE TABLE IF NOT EXISTS persistent_codex.security_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS persistent_codex.organizations (
  organization_id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS persistent_codex.principal_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  PRIMARY KEY (issuer, subject)
);

CREATE TABLE IF NOT EXISTS persistent_codex.organization_memberships (
  organization_id text NOT NULL REFERENCES persistent_codex.organizations,
  issuer text NOT NULL,
  subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','developer','viewer','billing')),
  status text NOT NULL CHECK (status IN ('active','disabled','revoked')),
  PRIMARY KEY (organization_id, issuer, subject),
  FOREIGN KEY (issuer, subject)
    REFERENCES persistent_codex.principal_identities (issuer, subject)
);

CREATE TABLE IF NOT EXISTS persistent_codex.workspaces (
  organization_id text NOT NULL REFERENCES persistent_codex.organizations,
  workspace_id text NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (organization_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.sessions (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (organization_id, workspace_id, session_id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.events (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  event_id text NOT NULL,
  sequence bigint NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (organization_id, workspace_id, session_id, event_id),
  UNIQUE (organization_id, workspace_id, session_id, sequence),
  FOREIGN KEY (organization_id, workspace_id, session_id)
    REFERENCES persistent_codex.sessions (organization_id, workspace_id, session_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.approvals (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  approval_id text NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (organization_id, workspace_id, session_id, approval_id),
  FOREIGN KEY (organization_id, workspace_id, session_id)
    REFERENCES persistent_codex.sessions (organization_id, workspace_id, session_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.artifacts (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  artifact_id text NOT NULL,
  object_key text NOT NULL,
  encryption_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (organization_id, workspace_id, session_id, artifact_id),
  UNIQUE (organization_id, workspace_id, object_key),
  FOREIGN KEY (organization_id, workspace_id, session_id)
    REFERENCES persistent_codex.sessions (organization_id, workspace_id, session_id),
  CHECK (object_key LIKE organization_id || '/' || workspace_id || '/%')
);

CREATE TABLE IF NOT EXISTS persistent_codex.attachments (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  attachment_id text NOT NULL,
  object_key text NOT NULL,
  encryption_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (organization_id, workspace_id, session_id, attachment_id),
  UNIQUE (organization_id, workspace_id, object_key),
  FOREIGN KEY (organization_id, workspace_id, session_id)
    REFERENCES persistent_codex.sessions (organization_id, workspace_id, session_id),
  CHECK (object_key LIKE organization_id || '/' || workspace_id || '/%')
);

CREATE TABLE IF NOT EXISTS persistent_codex.usage_ledger (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  ledger_id bigint GENERATED ALWAYS AS IDENTITY,
  quantity bigint NOT NULL,
  PRIMARY KEY (organization_id, workspace_id, session_id, ledger_id),
  FOREIGN KEY (organization_id, workspace_id, session_id)
    REFERENCES persistent_codex.sessions (organization_id, workspace_id, session_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.audit_records (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  audit_id bigint GENERATED ALWAYS AS IDENTITY,
  action text NOT NULL,
  outcome text NOT NULL,
  reason_code text NOT NULL,
  PRIMARY KEY (organization_id, workspace_id, audit_id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES persistent_codex.workspaces (organization_id, workspace_id)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspaces','sessions','events','approvals','artifacts',
    'attachments','usage_ledger','audit_records'
  ]
  LOOP
    EXECUTE format('ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON persistent_codex.%I', table_name);
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
VALUES (18) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION persistent_codex.security_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, persistent_codex
AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM persistent_codex.security_migrations
      WHERE version = 18
    )
    AND NOT EXISTS (
      SELECT 1
      FROM (
        VALUES
          ('workspaces'), ('sessions'), ('events'), ('approvals'),
          ('artifacts'), ('attachments'), ('usage_ledger'), ('audit_records')
      ) AS required_table(table_name)
      LEFT JOIN pg_catalog.pg_class relation
        ON relation.relname = required_table.table_name
       AND relation.relnamespace = 'persistent_codex'::regnamespace
      WHERE relation.oid IS NULL
         OR NOT relation.relrowsecurity
         OR NOT relation.relforcerowsecurity
         OR NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_policy policy
           WHERE policy.polrelid = relation.oid
             AND policy.polname = 'tenant_isolation'
         )
    );
$$;

REVOKE ALL ON FUNCTION persistent_codex.security_ready() FROM PUBLIC;

COMMIT;
