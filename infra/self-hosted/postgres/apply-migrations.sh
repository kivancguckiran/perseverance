#!/bin/sh
# WP32 — tracking tablolu, idempotent migration runner (ADR-0032).
# `migrate` one-shot compose servisi olarak pinlenmiş postgres imajında koşar.
# - Uygulanmamış migration'ları dosya adı sırasıyla ON_ERROR_STOP ile uygular.
# - Uygulanmış bir dosyanın sha256'sı değişmişse fail-closed durur.
# - Her koşuda runtime rolünü ve grant'ları tazeler (upgrade sonrası yeni tablolar).
set -eu

MIGRATIONS_DIR=/opt/self-hosted/migrations
RUNTIME_ROLE_SQL=/opt/self-hosted/init-runtime-role.sql

PGPASSWORD="$(cat "${POSTGRES_PASSWORD_FILE}")"
export PGPASSWORD
RUNTIME_PASSWORD="$(cat "${RUNTIME_PASSWORD_FILE}")"

psql -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS persistent_codex_ops;
CREATE TABLE IF NOT EXISTS persistent_codex_ops.schema_migrations (
  filename text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

applied=0
skipped=0
for file in "${MIGRATIONS_DIR}"/*.sql; do
  [ -e "${file}" ] || continue
  name="$(basename "${file}")"
  digest="$(sha256sum "${file}" | cut -d' ' -f1)"
  recorded="$(psql -tA -v ON_ERROR_STOP=1 \
    -c "SELECT sha256 FROM persistent_codex_ops.schema_migrations WHERE filename = '${name}'")"
  if [ -n "${recorded}" ]; then
    if [ "${recorded}" != "${digest}" ]; then
      echo "FAIL-CLOSED: ${name} daha önce sha256=${recorded} ile uygulandı," >&2
      echo "dosyanın guncel sha256'sı ${digest}. Migration içeriği değiştirilemez." >&2
      exit 1
    fi
    skipped=$((skipped + 1))
    continue
  fi
  echo "migration uygulanıyor: ${name}"
  psql -v ON_ERROR_STOP=1 -q -f "${file}"
  psql -v ON_ERROR_STOP=1 -q \
    -c "INSERT INTO persistent_codex_ops.schema_migrations(filename, sha256) VALUES ('${name}', '${digest}')"
  applied=$((applied + 1))
done

psql -v ON_ERROR_STOP=1 -q \
  -v self_hosted_runtime_password="${RUNTIME_PASSWORD}" \
  -f "${RUNTIME_ROLE_SQL}"

echo "migrate tamam: ${applied} uygulandı, ${skipped} atlandı"
