# ADR-0028 — Enterprise identity ve tenant data lifecycle

- Durum: Kabul edildi
- Tarih: 2026-07-20
- Kapsam: WP28

## Bağlam

ADR-0016/0018 tenant authorization ve support break-glass sınırını, ADR-0017
envelope encryption'ı, ADR-0026/0027 production placement ve backup authority'sini
kurdu. Enterprise onboarding/offboarding ise dış kimlik sağlayıcısını hesap yaşam
döngüsüne bağlarken retention, export, delete ve region politikasını tek tenant
authority'si altında fail-closed uygulamalıdır.

## Karar

### Federation authority

Her OIDC/SAML configuration tenant+organization scoped, versioned ve disabled-by-
default'tur. OIDC issuer, audience, callback, `kid`, RS256 signature, `iat`/`exp`,
bounded clock skew ve `jti` replay kaydı doğrulanır. SAML entity/issuer, ACS,
audience, signed response, assertion expiry ve assertion-ID replay kaydı doğrulanır.
Metadata/key rotation yeni version'ı atomik açar; önceki key yalnız tanımlı overlap
penceresinde verify-only kalabilir. Unknown key, unsigned response, expired assertion,
audience/issuer mismatch ve replay fail-closed'dur.

Domain ownership 256-bit süreli challenge'ın yalnız digest'i saklanarak ve
transactional single-use consume ile doğrulanır. Enforced SSO local/password login'i
kapatır. Authorization, IdP `amr`/assurance değerini tenant MFA politikasına göre
denetler. Emergency hesap normal IdP credential'ını paylaşmaz; güçlü phishing-
resistant MFA, immutable audit, anlık security bildirimi ve düzenli rotation ister.

### SCIM authority

SCIM 2.0 `/Users` ve `/Groups` kaynakları `(tenant, organization, provider,
resourceType, resourceId)` authority'sindedir. `externalId`, provider monoton version
ve idempotency key tutulur. Aynı key aynı sonucu döndürür; eski/eşit version güncel
state'i geri alamaz. External-ID ve group/role mapping tenant dışına taşamaz;
bilinmeyen group deny-by-default'tur. User deactivate transaction'ı login/session/token
epoch'unu ve tüm credential, folder, corpus, support/cache erişimini revoke eder;
aktif lease/turn interrupt ardından bounded drain olur.

### Retention, legal hold ve export

Event, raw envelope, audit, source, attachment, artifact, derived index,
usage/billing ve backup ayrı retention class'tır. Policy tenant/plan bazlı,
versioned/effective-dated'dir. Yeni kısalma effective date öncesi veriyi sessizce
erken silmez. Worker keyset checkpoint'li, bounded, idempotent ve auditlidir.
Yetkili compliance/legal rolünün gerekçeli, süreli legal hold'u retention ve delete'e
önceliklidir. Audit ve finansal kayıt statutory minimum dolmadan silinmez.

Export/DSAR ayrı privilege ve approval ister; support grant bu yetkiyi vermez.
Resumable job idempotency key ile tek archive/usage üretir. Manifest scope, schema,
watermark, object class/list/checksum/length/key-version taşır. Archive tenant key'i
ve tenant+job AAD ile şifrelenir; kısa TTL'li download aynı tenant principal'ına
bağlıdır. Secret, provider credential, internal support note ve yabancı citation
collector'a kabul edilmez.

### Delete/offboarding ve crypto-erasure

Durable sıra: access revoke → admission cordon → active-job drain/interrupt →
session/token revoke → cache purge → index purge → object delete → primary metadata
cleanup → backup expiry/tombstone → KMS crypto-erasure → deletion receipt. Her adım
CAS/version, idempotency ve audit-chain kaydı taşır. Delete başladıktan sonra turn,
upload, share, export ve provider connection admission'ı reddedilir. Hold/statutory
backup retention kalan class, reason ve expiry ile açıkça raporlanır; sona erince
reaper object/key materyalini siler. KMS key-version destroy kalıcı authority'dir;
receipt öncesi unwrap-denial doğrulanır ve eski ciphertext restore edilemez.

### Data residency

Tenant policy allowed/primary region ile izinli `(source,destination,object-class)`
transferlerini versioned tanımlar. Scheduler placement, object prefix/bucket, backup,
index ve export target aynı policy'yi uygular. Capacity/dependency uygun değilse başka
region'a fallback yoktur. İzinli transfer source/destination, reason, opaque actor,
class, byte count ve approval ile immutable audit'e yazılır. Restore dahil yasak
placement fail-closed'dur.

### PostgreSQL ve API sınırı

WP28 tabloları tenant+organization composite key taşır, `FORCE ROW LEVEL SECURITY`
uygular ve non-owner runtime role ile kullanılır. REST scope header/claim ile body ve
resource scope'u eşleşmeden repository çağrılmaz. Worker sistem erişimi ayrı workload
role, açık tenant batch scope'u ve bounded cursor ister; global unscoped scan yoktur.

## Sonuçlar

Identity provider authentication authority'sidir; platform tenant membership,
role-policy, session revoke, export/delete ve data placement authority'si olarak
kalır. Local test IdP/SCIM/Vault/MinIO/Redis gerçek protocol ve dependency davranışını
kanıtlar; external enterprise credential, managed KMS ve managed cross-region
durability ayrıca environment-specific evidence ister. WP29 bu kararla aktive edilmez.
