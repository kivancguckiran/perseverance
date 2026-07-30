-- WP37 — Kullanıcı hesapları ve parola-türevli at-rest mahremiyet (ADR-0037).
-- users: allowlist'li kayıt/giriş kimliği (Argon2id parola hash'i, recovery key hash'i).
-- user_content_keys: kullanıcı content key'inin parola-KEK ve recovery-KEK ile
--   sarılmış kopyaları; düz anahtar hiçbir kolonda bulunmaz.
-- user_refresh_tokens: opak refresh token'ların yalnız sha256 hash'i.
-- user_auth_audit: kayıt/giriş/recovery/crypto-erase denetim izi (allowlist
--   redleri dahil; bu satırlar scope ataması öncesi oluştuğundan tenant_id
--   'self-hosted-auth' sabitiyle yazılır).
-- RLS: auth akışı scope'suz çalıştığından politika, transaction-yerel
--   app.self_hosted_auth_flow GUC'u set edilmiş güvenilir auth servis
--   transaction'larına ya da tenant eşleşmesine izin verir; runtime rolü
--   NOBYPASSRLS olduğundan diğer tüm erişimler tenant kapsamındadır.
BEGIN;

CREATE TABLE IF NOT EXISTS persistent_codex.users (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  username text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'disabled')),
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  recovery_key_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  disabled_at timestamptz,
  PRIMARY KEY (user_id),
  UNIQUE (username),
  CHECK (tenant_id = organization_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.user_content_keys (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  user_id text NOT NULL REFERENCES persistent_codex.users (user_id),
  wrap_type text NOT NULL CHECK (wrap_type IN ('password', 'recovery')),
  key_version integer NOT NULL CHECK (key_version >= 1),
  kdf_params jsonb NOT NULL,
  wrapped_key jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  PRIMARY KEY (user_id, wrap_type),
  CHECK (tenant_id = organization_id)
);

CREATE TABLE IF NOT EXISTS persistent_codex.user_refresh_tokens (
  tenant_id text NOT NULL,
  user_id text NOT NULL REFERENCES persistent_codex.users (user_id),
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (token_hash),
  CHECK (tenant_id != '')
);

CREATE INDEX IF NOT EXISTS user_refresh_tokens_user_idx
  ON persistent_codex.user_refresh_tokens (user_id, expires_at);

CREATE TABLE IF NOT EXISTS persistent_codex.user_auth_audit (
  tenant_id text NOT NULL DEFAULT 'self-hosted-auth',
  audit_id bigint GENERATED ALWAYS AS IDENTITY,
  username text NOT NULL,
  action text NOT NULL CHECK (action IN (
    'user.registered',
    'user.register_denied',
    'user.login',
    'user.login_denied',
    'user.recovered',
    'user.recover_denied',
    'user.logout',
    'user.disabled',
    'user.crypto_erased'
  )),
  outcome text NOT NULL CHECK (outcome IN ('allow', 'deny')),
  reason_code text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, audit_id)
);

CREATE INDEX IF NOT EXISTS user_auth_audit_username_idx
  ON persistent_codex.user_auth_audit (username, occurred_at);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users',
    'user_content_keys',
    'user_refresh_tokens',
    'user_auth_audit'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE persistent_codex.%I ENABLE ROW LEVEL SECURITY',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE persistent_codex.%I FORCE ROW LEVEL SECURITY',
      table_name
    );
    IF NOT EXISTS (
      SELECT FROM pg_policies
      WHERE schemaname = 'persistent_codex'
        AND tablename = table_name
        AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON persistent_codex.%I FOR ALL '
        || 'USING (current_setting(''app.self_hosted_auth_flow'', true) = ''1'' '
        || 'OR tenant_id = current_setting(''app.tenant_id'', true)) '
        || 'WITH CHECK (current_setting(''app.self_hosted_auth_flow'', true) = ''1'' '
        || 'OR tenant_id = current_setting(''app.tenant_id'', true))',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

COMMIT;
