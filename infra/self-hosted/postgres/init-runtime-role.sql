-- WP32 — self-hosted runtime rolü (ADR-0032, wp30 init.sql deseni).
-- apply-migrations.sh her koşuda (install + upgrade) idempotent uygular; rol varsa
-- yalnız parola tazelenir, grant'lar yeni tablolar için yeniden verilir.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'self_hosted_runtime') THEN
    CREATE ROLE self_hosted_runtime LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE self_hosted_runtime PASSWORD :'self_hosted_runtime_password';
GRANT persistent_topology_scheduler TO self_hosted_runtime;
GRANT USAGE ON SCHEMA persistent_codex TO self_hosted_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA persistent_codex TO self_hosted_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA persistent_codex TO self_hosted_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA persistent_codex TO self_hosted_runtime;
