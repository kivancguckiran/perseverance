# ADR-0025 — Güvenli paylaşımlı klasör ve ortak çalışma sınırı

- Durum: Kabul edildi
- Tarih: 2026-07-18
- Kapsam: WP25

## Bağlam

Mevcut `conversation_folders` kaydı conversation düzenlemek için tenant/workspace
kapsamlı bir etiket sağlar; principal ACL'si, güvenli davet, ownership state machine'i
ve revoke sonrası canlı bağlantı davranışı tanımlamaz. WP25'te klasör; conversation,
source, attachment/artifact ve agent task için ortak authorization aggregate'i olur.
Bu sınır yalnız REST'te uygulanırsa replay, retrieval, MCP, object storage veya cache
üzerinden eski yetkiyle içerik sızabilir.

## Karar

### Resource ve scope modeli

`folder` bağımsız, versioned bir aggregate'tir. Her folder, membership, invitation,
resource binding ve audit kaydında `tenant_id`, `organization_id`, `workspace_id` ve
`folder_id`; principal taşıyan kayıtlarda ayrıca opaque `principal_id` açıkça bulunur.
Tenant ile organization bugün aynı değeri kullansa da kolonlar ve composite key'ler
ayrıdır. Bu, ilerideki tenant/organization ayrımını veri yeniden yazmadan mümkün kılar.

Folder private-by-default yaratılır ve yaratan authenticated principal tek başlangıç
owner'ıdır. Workspace root ve kardeş private folder için örtük erişim doğmaz. Folder
ACL yalnız doğrudan, aktif membership'ten gelir; workspace/organization rolü folder
içeriğine inherit edilmez. Organizasyon authorization'ı bir önkoşuldur, folder
membership onun yerine geçmez. Child resource (`conversation`, `source`,
`attachment`, `artifact`, `agent_task`) parent folder'ın güncel ACL'sini inherit eder;
child üzerinde bağımsız allow list tutulmaz.

### Roller

- `viewer`: folder ve bağlı içeriği okuyabilir; mutation, turn başlatma/steer,
  approval kararı ve export yapamaz.
- `editor`: viewer yetkilerine ek olarak folder içinde resource/task yaratabilir,
  taşıma hedefinde editor ise resource taşıyabilir ve agent çalıştırabilir; membership,
  invite, role ve ownership yönetemez.
- `owner`: editor yetkilerine ek olarak invite, membership, role, ownership ve export
  yönetebilir.

Bir folder her zaman en az bir aktif owner taşır. Son owner düşürülemez veya revoke
edilemez. Ownership transfer tek transaction içinde, `expected_version` optimistic
lock ile hedefi owner yapar ve istenirse eski owner'ı editor'a indirir. Version
uyuşmazlığı fail-closed conflict üretir.

### Davet güvenliği

Davet token'ı CSPRNG ile en az 256 bit üretilir, kısa TTL taşır ve tek kullanımlıdır.
Veritabanında yalnız SHA-256 digest saklanır; raw token yalnız create response'unda bir
kez döner. Token query string'e, log'a, event'e, audit'e, telemetry'ye veya cache key'e
girmez. Accept işlemi token digest'ini transaction içinde kilitler; pending ve süresi
dolmamış daveti authenticated principal'a bağlar. Aynı principal'ın aynı daveti tekrar
kabulü önceki sonucu idempotent döndürür; başka principal replay'i, expired veya
revoked token reddedilir. Invitation hedef e-postası tutulmaz; teslimat sistemi opaque
`invite_id` ve kullanıcı tarafından seçilmiş kanal ile ayrıca çalışır.

### Enforcement ve invalidation

Authorization kaynak okunmadan önce iki kapıda uygulanır:

1. organization/workspace ön kapısı;
2. resource binding çözümü ve güncel folder membership kapısı.

REST handler, realtime subscribe/replay ve her live event gönderimi, retrieval/index
candidate ve citation çözümü, workspace-local MCP tool çağrısı, object metadata/body
okuması ve authorization/result cache hit'i bu iki kapıdan geçer. Storage key'leri
`tenant/organization/workspace/folder/resource` scope'unu içerir; guessed ID tek başına
lookup anahtarı değildir.

Her folder `acl_version` ve `cache_epoch` taşır. Invite accept, revoke, role change,
ownership transfer ve resource move transaction'ı epoch'u artırır ve commit sonrası
`folder.access.changed` invalidation yayınlar. Cache key principal + tüm scope + epoch
içerir. Realtime bağlantısı her replay sayfasından ve live event'ten önce güncel ACL'yi
yeniden doğrular; erişim kaybında içerik göndermeden `access_revoked` kontrol mesajı
verip 4403 ile kapanır. Invalidation gecikir veya repository erişilemezse sonuç deny'dır.
Search result/cursor eski epoch ile kullanılamaz. Move hem kaynak hem hedef ACL'sini
kilitler, binding'i atomik değiştirir ve iki epoch'u geçersiz kılar.

### Audit, concurrency ve billing

Invite create/accept/revoke, role change, ownership transfer, resource move ve export
append-only, hash-chain korumalı audit'e yazılır. Audit yalnız opaque principal,
aggregate/resource ID, action, outcome, reason, version ve correlation taşır; token,
isim, prompt, source content, secret ve URL taşımaz.

Workspace'te tek aktif upstream turn değişmezi sürer. Ortak task create için
`(tenant, workspace, idempotency_key)` ve approval için `(approval_id, version)` unique
reservation kullanılır. Kazanan transaction upstream işi/billing reservation'ını
yaratır; diğer principal aynı durable task sonucunu okur. Approval resolution ve
billing settlement ayrı unique idempotency key'lerle exactly-once kaydedilir.

### PostgreSQL sınırı

WP25 tablolarında Forced RLS zorunludur. Policy hem transaction-local tenant,
organization, workspace hem de principal bağlamını denetler. Composite foreign key'ler
scope'suz ilişki kurulmasını engeller. Uygulama owner/table-owner bağlantısıyla
çalışmaz; migration adversarial testleri non-owner runtime role ile yürütülür.

## Sonuçlar

Mevcut conversation folder API'si geçiş süresince uyumluluk yüzeyi olarak kalabilir;
yeni paylaşım özellikleri yalnız shared-folder aggregate'ini kullanır. Same-document
eşzamanlı içerik düzenleme ve public/anonymous sharing bu kararın dışındadır. WP25
kanıtlarının geçmesi Faz 4'ü kendiliğinden kapatmaz; bağımsız kabul task'ı gerekir.
