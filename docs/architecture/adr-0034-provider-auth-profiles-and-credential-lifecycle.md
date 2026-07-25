# ADR-0034: Provider auth profilleri ve credential yaşam döngüsü

- Durum: Kabul edildi
- Tarih: 25 Temmuz 2026
- Kapsam: Faz 6 WP34

## Bağlam

WP33 (`ADR-0033`) `local`, `self-hosted` ve `cloud` deployment profile'larını,
tenant-isolated runtime'ı ve kısa ömürlü `RuntimeDataPlaneAuthority` kimliğini kurdu.
`ADR-0017` KMS envelope encryption, secret lease ve crypto-erasure sınırını tanımladı.
Bağlayıcı provider koşulları ve destek kararları
`docs/security/wp34-provider-subscription-auth-research.md` içindedir. Provider
subscription erişiminin bir private runner'da belgelenmiş olması, aynı credential'ın
Managed Cloud'da tutulmasına izin verildiği anlamına gelmez.

## Karar

### Ortak auth profile contract'ı

`packages/provider-auth` version 1 contract'ı dört ve yalnız dört auth modu taşır:

- `subscription-oauth`: provider subscription kotası; model faturası üretmez ve
  usage her zaman `estimated` olarak raporlanır.
- `customer-api-key`: tenant'ın provider API hesabı; provider API billing'i olarak
  ayrı raporlanır.
- `platform-credit`: platform tarafından sağlanan ve ayrı reconcile edilen kredi.
- `local-cli-credential`: yalnız belgelenmiş resmî CLI akışı ve trusted private
  runner; başka istemcinin auth cache'ini toplama anlamına gelmez.

Tek capability karar anahtarı
`(provider, authMode, deploymentProfile, evidenceVersion)` bileşimidir. Kararlar
versioned, deny-by-default ve feature flag arkasındadır. Bilinmeyen provider/mod,
kapalı flag, geçersiz veya sürümü uyuşmayan evidence fail-closed sonuç üretir.
Evidence; tür, HTTPS URI, SHA-256, gözlem tarihi ve varsa yürürlük tarihi taşır.

Gemini consumer `subscription-oauth` bütün profillerde değişmez biçimde
`GEMINI_CONSUMER_SUBSCRIPTION_OAUTH_UNSUPPORTED` sonucudur. Gemini için yalnız
customer Gemini API key ve platform-managed/Vertex yolları açılabilir.

Codex subscription/local CLI:

- `local`/`self-hosted`: yalnız resmî Sign in with ChatGPT PKCE veya device-code
  akışı, explicit feature flag ve trusted private runner.
- `cloud`: tarihli `third-party-application-approval` URI/hash evidence olmadan
  `CODEX_MANAGED_SUBSCRIPTION_EVIDENCE_REQUIRED`; flag tek başına yetmez.
- Başka OAuth client kimliği veya `auth.json` cache'i toplanmaz/kopyalanmaz.

Claude subscription/local CLI, `local` ve `self-hosted` dahil,
`previously-approved` evidence olmadan açılamaz. Actionable hata API key veya
desteklenen cloud provider yolunu gösterir. Platform credit varsayılan Managed Cloud
yoludur. Customer API key cloud custody'si `customer-key-custody` evidence ister.

### Credential vault

Credential ciphertext'i `provider_auth_profiles.credential_envelope` alanında
ADR-0017 `EnvelopeEncryption` ile AES-256-GCM ve KMS-wrapped per-record DEK olarak
tutulur. AAD; tenant, organization, workspace, record type
`provider_credential` ve profile/transaction kimliğini bağlar. Yanlış tenant,
workspace, key veya ciphertext substitution decrypt olmadan reddedilir.

OAuth state plaintext tutulmaz; SHA-256 digest tutulur. PKCE verifier ve device code
aynı envelope sınırında durur, tek kullanım sonrası durable transaction consumed
olur ve envelope alanı temizlenir. Expiry fail-closed'dur.

Refresh lock `(tenant, organization, workspace, profile)` anahtarında atomik,
süreli ve tek-owner'dır. Rotation yeni envelope/key version üretir. Revoke yeni lease
vermez. Disconnect revoke semantiğini tamamlar ve encrypted DEK/envelope'i silerek
record-level crypto-erasure yapar. Workspace silme akışı ayrıca ADR-0017 KMS grant
revoke'unu uygular.

Vault plaintext'i yalnız hedef runtime'a, WP33
`provider-credential.lease` action'lı, tenant/workspace/runtime/generation scoped
workload credential doğrulandıktan sonra en çok beş dakikalık memory-only lease ile
verir. UI, support, backup/export, event ve telemetry contract'larında decrypt port'u
yoktur.

Enforcement seam vault sınırındadır: `connect`, `refresh` ve
`leaseToRuntime` her çağrıda enjekte edilen deployment profile/feature
flag/evidence authority'sinden capability kararı alır ve provider/auth-mode
kill-switch kaydını doğrular. Bu kontrolleri atlayan ikinci bir üretim credential
yolu yoktur. Revoke, disconnect ve alternatif auth-mode'a geçiş ise kill switch
kapalıyken de açık kalır. Süresi geçen aktif profil ilk lease denemesinde durable
olarak `expired` durumuna geçirilir.

Migration `0036_wp34_provider_auth_profiles.sql`; profile, refresh lock, OAuth
transaction, usage ledger ve kill-switch tablolarını mevcut tracking-runner lexical
sırasıyla ekler. Her domain kaydı `tenant_id = organization_id` değişmezini ve
workspace scope'unu taşır; tüm tablolar `ENABLE` + `FORCE ROW LEVEL SECURITY`
altındadır.

### Kill switch ve provider koşulları

Kill switch anahtarı provider/auth-mode specific'tir ve allow-list gibi çalışır:
explicit `true` yoksa yeni iş `PROVIDER_AUTH_KILL_SWITCH_ACTIVE` ile güvenli durur.
Aktif task'a yeni credential lease verilmez; operatör profile'ı revoke/disconnect
edebilir veya kullanıcıyı desteklenen alternatif auth moduna geçirir. Durable kayıt
silinmek zorunda değildir; crypto-erasure ile ciphertext geri döndürülemez yapılabilir.

`docs/security/provider-terms-watch-list.json` URL, observed update/effective date,
evidence hash ve last checked değerlerini taşır. Bir terms değişikliği tatbikatı
`wp34:kill-switch` gate'inde Claude subscription allow → kill switch deny → API key
alternatifi olarak deterministik yürütülür.

### Sızıntı ve evidence

Token, refresh token, device code, API key, cookie ve PKCE verifier hiçbir log, event,
trace, fixture, snapshot, backup, support export veya committed evidence'a yazılmaz.
Evidence yalnız karar kodu, count, digest ve redakte metadata taşır.
`.wp34/evidence/` gitignored ve timestamp'sizdir. Gerçek provider credential smoke'u
yalnız explicit izinli ortamda çalışır; ortam yoksa `not-run`, `accepted:false`
raporlanır ve acceptance'a terfi ettirilmez.

## Provider capability/terms matrisi

| Provider | Auth modu            | local                  | self-hosted            | cloud                        |
| -------- | -------------------- | ---------------------- | ---------------------- | ---------------------------- |
| Codex    | subscription-oauth   | trusted private runner | trusted private runner | written third-party approval |
| Codex    | customer-api-key     | supported              | supported              | custody evidence             |
| Codex    | platform-credit      | supported              | supported              | supported                    |
| Codex    | local-cli-credential | trusted private runner | trusted private runner | unsupported                  |
| Claude   | subscription-oauth   | previously approved    | previously approved    | previously approved          |
| Claude   | customer-api-key     | supported              | supported              | custody evidence             |
| Claude   | platform-credit      | supported              | supported              | supported                    |
| Claude   | local-cli-credential | previously approved    | previously approved    | unsupported                  |
| Gemini   | subscription-oauth   | unsupported            | unsupported            | unsupported                  |
| Gemini   | customer-api-key     | supported              | supported              | custody evidence             |
| Gemini   | platform-credit      | supported              | supported              | supported/Vertex             |
| Gemini   | local-cli-credential | unsupported            | unsupported            | unsupported                  |

`written approval`, `previously approved` ve `custody evidence` runtime'da evidence
yoksa supported sayılmaz.

## Sonuçlar

- Provider eklemek yalnız provider adapter'ı eklemek değildir; capability contract,
  terms evidence, kill switch ve leak testleri birlikte gerekir.
- Account sharing, credential/rate-limit pooling ve tenant'lar arası credential
  havuzlama yasaktır.
- Final fiyatlandırma, ödeme, onboarding ve public beta WP35 kapsamındadır.
- Bu ADR, ADR-0017 ve ADR-0033'ü gevşetmez; provider araştırma kararıyla çelişen
  capability açılmaz.
