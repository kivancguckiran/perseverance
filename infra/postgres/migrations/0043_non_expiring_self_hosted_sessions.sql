-- Self-hosted sessions remain valid until explicit revocation. Access tokens
-- stay short-lived and refresh tokens continue to rotate on every refresh.
BEGIN;

-- Do not revive sessions that had already expired before this policy change.
UPDATE persistent_codex.user_refresh_tokens
SET revoked_at = now()
WHERE revoked_at IS NULL
  AND expires_at <= now();

ALTER TABLE persistent_codex.user_refresh_tokens
  ALTER COLUMN expires_at DROP NOT NULL;

-- Preserve every session that was valid when the migration ran.
UPDATE persistent_codex.user_refresh_tokens
SET expires_at = NULL
WHERE revoked_at IS NULL;

DROP INDEX IF EXISTS persistent_codex.user_refresh_tokens_user_idx;
CREATE INDEX user_refresh_tokens_active_user_idx
  ON persistent_codex.user_refresh_tokens (user_id)
  WHERE revoked_at IS NULL;

COMMIT;
