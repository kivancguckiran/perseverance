#!/bin/sh
set -eu
for migration in /docker-entrypoint-initdb.d/migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$migration"
done
runtime_password="$(cat /run/secrets/postgres_password)"
psql -v ON_ERROR_STOP=1 -v wp30_runtime_password="$runtime_password" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /opt/wp30/init.sql
