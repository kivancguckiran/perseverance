# WP18 PostgreSQL/RLS runbook

Migration:
`infra/postgres/migrations/0018_oidc_authorization_rls.sql`

Gerçek lokal test:

```bash
pnpm wp18:postgres
```

Komut geçici `postgres:17-alpine` container'ı açar, migration'ı uygular, normal
`NOSUPERUSER` application role ile Tenant A context'i kurar ve şunları doğrular:

- Tenant B `SELECT` görünmez.
- Cross-tenant `INSERT`, `UPDATE`, `DELETE` etkisiz/reddedilir.
- Composite FK ile Tenant A event'inin Tenant B session'ına bağlanması reddedilir.
- Transaction bittikten sonraki reuse işleminde tenant context'i yoktur ve satır
  görünmez.

Production connection superuser, table owner veya `BYPASSRLS` olamaz. Her request
transaction'ı şu sırayı izler:

```sql
BEGIN;
SELECT set_config('app.organization_id', $1, true);
SELECT set_config('app.workspace_id', $2, true);
-- authorized query set
COMMIT;
```

Global `SET`, connection-level session variable veya transaction dışı query yasaktır.
`persistent_codex.security_migrations` içinde version 18 yoksa ya da tenant tablolarında
forced RLS etkin değilse readiness başarısız olmalıdır.

Container runtime veya image yoksa test geçmiş sayılmaz; exact hata final raporda
çalıştırılamayan kontrol olarak yazılır.

## 16 Temmuz 2026 gerçek smoke kaydı

`postgres:17-alpine` image’ı gerçek PostgreSQL `17.10` server’ı ile çalıştırıldı.
Migration 18 ve security readiness geçti; `app_runtime` rolü `NOSUPERUSER`,
`NOBYPASSRLS` ve tenant tablolarının owner’ı değil. Tenant A context’inde Tenant B
SELECT görünmedi; INSERT reddedildi, UPDATE/DELETE sıfır satır etkiledi ve composite FK
cross-tenant ilişkiyi reddetti. Commit ve rollback sonrasındaki aynı connection reuse
kontrollerinde context boş ve görünür satır sayısı sıfırdı. Forced RLS veya migration
kaydı geçici olarak kaldırıldığında readiness false döndü. Geçici container ve anonymous
storage cleanup sonunda mevcut değildi.
