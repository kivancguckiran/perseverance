-- Allow password-based support step-up verification actions in the auth audit
-- constraint. The application has emitted these actions since support access
-- was enabled, but the older constraint rejected both success and denial rows.
BEGIN;

ALTER TABLE persistent_codex.user_auth_audit
  DROP CONSTRAINT IF EXISTS user_auth_audit_action_check;

ALTER TABLE persistent_codex.user_auth_audit
  ADD CONSTRAINT user_auth_audit_action_check CHECK (action IN (
    'user.registered',
    'user.register_denied',
    'user.login',
    'user.login_denied',
    'user.recovered',
    'user.recover_denied',
    'user.logout',
    'user.disabled',
    'user.crypto_erased',
    'user.content_key_unlocked',
    'user.unlock_denied',
    'user.support_access_verified',
    'user.support_access_verification_denied'
  )) NOT VALID;

ALTER TABLE persistent_codex.user_auth_audit
  VALIDATE CONSTRAINT user_auth_audit_action_check;

COMMIT;
