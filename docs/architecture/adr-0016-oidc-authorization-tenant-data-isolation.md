# ADR-0016: OIDC kimliği, merkezi authorization ve tenant data isolation

- Durum: Kabul önerisi
- Tarih: 2026-07-16
- Kapsam: Faz 3 WP18

## Bağlam

Tek kiracılı alfa, end-user isteklerinin `x-tenant-id` ve `x-workspace-id`
header'larına güveniyordu. Tenant kolonlarının bulunması tek başına güvenlik garantisi
değildir: forged scope, IDOR, confused deputy, WebSocket cursor/ack karışması,
connection-pool context leakage, signed grant replay ve cache poisoning ayrıca
engellenmelidir.

## Karar

- Production end-user authentication doğrulanmış OIDC access token ile yapılır.
  Issuer discovery, JWKS, `RS256`, `kid`, signature, issuer, audience, `exp`, `nbf`
  ve authentication time fail-closed doğrulanır. `alg=none`, bilinmeyen algorithm/key
  ve JWKS/network arızası reddedilir. JWKS cache TTL'li ve en çok 16 key'dir; bilinmeyen
  `kid` bir kez zorunlu refresh tetikler.
- Versioned principal yalnız subject, issuer, audience, auth/expiry zamanı ve güvenli
  assurance/MFA özetini taşır. Raw JWT ve hassas claim audit, event, log, fixture veya
  UI'a yazılmaz.
- OIDC token organization yetkisi taşıyan doğruluk kaynağı değildir. Organization,
  principal identity ve membership server-side kayıttır. Disabled/revoked membership
  sonraki REST kararı ve WebSocket ack'inde yeniden okunur.
- End-user ve trusted internal service principal ayrıdır. End-user route'u internal
  service principal'ı kabul etmez. Gelecekteki internal ingest/runtime route'ları ayrı
  service audience ve action kataloğu kullanmalıdır.
- Bütün protected public route'lar versioned merkezi action kataloğuna bağlıdır.
  Bilinmeyen route/action, eksik resource scope, rol veya workspace membership'i
  deny'dır. Header/path/body scope yalnız istenen resource'u belirtir; yetki principal
  ve server-side membership'ten gelir.
- Kaynak varlığını gereksiz sızdırmamak için membership/scope ihlali `403
ACCESS_DENIED`, yetkili scope içinde bulunmayan opaque resource ise tutarlı `404`
  üretir.
- WebSocket ilk `subscribe` mesajında authenticate edilir. Scope principal membership
  ve durable session ile doğrulanır; connection auth context'i connection-local'dır.
  Token expiry bağlantıyı `4401`, revoke ise sonraki ack'te `4403` ile kapatır.
- Local SQLite ve filesystem adapter'ları yalnız açıkça etkinleştirilen local/test
  geliştirme modudur. Production varsayılanı OIDC configuration olmadan başlamaz.
  Multi-tenant beta garantisi PostgreSQL migration 18, composite FK, forced RLS ve
  non-bypass application role doğrulamasına bağlıdır.
- PostgreSQL transaction başında `SET LOCAL`/`set_config(..., true)` ile
  `app.organization_id` ve `app.workspace_id` kurulur. Transaction sonrasında değerler
  temizlenir; pool checkout global `SET` kullanamaz. RLS migration kaydı olmadan
  production readiness başarısız kabul edilir.
- Artifact/attachment object path'leri server-owned
  `organization/workspace/session/...` prefix'idir. Metadata scope ile prefix scope
  uyuşmalıdır. Opaque artifact grant 60 saniye, tek resource, full-download operation
  ve tek kullanımlıdır; değiştirilmiş token, replay ve grant dışı Range reddedilir.
- WP19 şifreleme yapmaz. Migration yalnız daha sonraki encryption context için
  organization/workspace metadata alanını hazırlar.
- Client query ve offline snapshot anahtarları
  `principal:organization:workspace` namespace'i taşır. Organization/principal değişimi
  önceki snapshot'ı adreslenemez yapar. Logout anonymous principal namespace'ine,
  membership revoke erişimsiz duruma ve organization switch yeni organization
  namespace'ine geçer; önceki tenant snapshot'ı fallback olarak aranmaz veya ekranda
  gösterilmez. Legacy global `offline-conversation-v1:<session>` anahtarı okunmaz ve
  yazılmaz. Token veya secret cache'lenmez.
- Authorization allow/deny audit'i actor opaque principal bağlamı, scope, action,
  outcome, reason ve correlation bilgisiyle bounded kalır; içerik ve token taşımaz.
  Metrics action/outcome/reason gibi düşük cardinality değerlerle sınırlıdır.

## Tehditler ve kontroller

| Tehdit                                    | Kontrol                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| Forged tenant/workspace                   | Principal + server membership karşılaştırması            |
| Confused deputy / service token karışması | Principal kind ve ayrı audience sınırı                   |
| IDOR                                      | Resource server-side scoped lookup + 403/404 politikası  |
| Cross-tenant WebSocket                    | Connection-local auth, subscribe/ack scope validation    |
| Pool context leakage                      | Transaction-local context ve gerçek reuse smoke          |
| Signed grant replay/path değişimi         | Opaque random token, TTL, consume-once, no Range         |
| Cache poisoning                           | Principal/org/workspace namespace ve scoped invalidation |

## Sonuçlar

SQLite geliştirme kolaylığını korur fakat production multi-tenant güvenliği iddia etmez.
WP19 runtime, egress, KMS ve application-level encryption; WP20 support grant,
JIT/MFA/break-glass kapsamlarını taşır.
