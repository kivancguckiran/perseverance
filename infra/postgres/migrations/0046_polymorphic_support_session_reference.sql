BEGIN;

-- Support access is shared by the generic control plane (`sessions`) and the
-- production/self-hosted control plane (`ha_sessions`). A single foreign key
-- cannot target both storage backends, so preserve database-level existence
-- validation with a scoped trigger that accepts either canonical session row.
ALTER TABLE persistent_codex.support_grants
  DROP CONSTRAINT IF EXISTS support_grants_organization_id_workspace_id_session_id_fkey;

ALTER TABLE persistent_codex.break_glass_requests
  DROP CONSTRAINT IF EXISTS break_glass_requests_organization_id_workspace_id_session_id_fkey;

CREATE OR REPLACE FUNCTION persistent_codex.validate_support_session_reference()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, persistent_codex
AS $$
BEGIN
  IF NEW.session_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM persistent_codex.sessions session_row
    WHERE session_row.organization_id = NEW.organization_id
      AND session_row.workspace_id = NEW.workspace_id
      AND session_row.session_id = NEW.session_id
  ) OR EXISTS (
    SELECT 1
    FROM persistent_codex.ha_sessions session_row
    WHERE session_row.tenant_id = NEW.tenant_id
      AND session_row.organization_id = NEW.organization_id
      AND session_row.workspace_id = NEW.workspace_id
      AND session_row.session_id = NEW.session_id
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'support session reference does not exist'
    USING ERRCODE = '23503', CONSTRAINT = 'support_session_reference';
END;
$$;

DROP TRIGGER IF EXISTS support_grants_session_reference
  ON persistent_codex.support_grants;
CREATE TRIGGER support_grants_session_reference
BEFORE INSERT OR UPDATE OF tenant_id, organization_id, workspace_id, session_id
ON persistent_codex.support_grants
FOR EACH ROW
EXECUTE FUNCTION persistent_codex.validate_support_session_reference();

DROP TRIGGER IF EXISTS break_glass_requests_session_reference
  ON persistent_codex.break_glass_requests;
CREATE TRIGGER break_glass_requests_session_reference
BEFORE INSERT OR UPDATE OF tenant_id, organization_id, workspace_id, session_id
ON persistent_codex.break_glass_requests
FOR EACH ROW
EXECUTE FUNCTION persistent_codex.validate_support_session_reference();

COMMIT;
