-- Deploy sonrasında parola ile yeniden açılan content-key lease'lerini ayrı
-- bir auth audit eylemi olarak kaydet. 0038'deki CHECK listesi bu yeni,
-- güvenlik açısından anlamlı eylem eklenmeden önce oluşturulmuştu.
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
    'user.content_key_unlocked'
  )) NOT VALID;

ALTER TABLE persistent_codex.user_auth_audit
  VALIDATE CONSTRAINT user_auth_audit_action_check;

COMMIT;
