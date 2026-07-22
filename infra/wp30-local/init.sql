CREATE ROLE wp30_runtime LOGIN PASSWORD :'wp30_runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

GRANT persistent_topology_scheduler TO wp30_runtime;
GRANT USAGE ON SCHEMA persistent_codex TO wp30_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA persistent_codex TO wp30_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA persistent_codex TO wp30_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA persistent_codex TO wp30_runtime;
