# ADR-0035: Managed Cloud onboarding, billing ve kontrollü public beta

- Durum: Kabul edildi
- Tarih: 25 Temmuz 2026
- Kapsam: Faz 6 WP35

## Bağlam

WP35, altyapı işletmek istemeyen kullanıcının kayıt olup provider bağlayarak
telefondan durable task çalıştırabildiği Managed Cloud ürününü kontrollü public
beta'ya çıkarır. Bu karar yeni bir runtime, credential, billing veya rollout
otoritesi kurmaz:

- ADR-0024 plan, entitlement, quota, budget ve usage doğruluk kaynağıdır.
- ADR-0026 production scheduler, kapasite ve çalışan iş güvenliği kaynağıdır.
- ADR-0030 production readiness, rollout, go/no-go, halt ve rollback otoritesidir.
- ADR-0033 deployment profile, tenant provisioning ve runtime data-plane auth
  kaynağıdır.
- ADR-0034 provider capability, vault, usage sınıflaması ve kill switch kaynağıdır.

## Karar

### Onboarding state machine

`signup → tenant_ready → provider_connected → first_task_started → completed`
akışı `packages/managed-cloud` içindeki versioned onboarding kaydında ilerler.
Tenant ve workspace kimliği doğrulanmış OIDC `issuer + subject` digest'i ile
idempotency key'den deterministik türetilir; plaintext e-posta durable onboarding
kaydına yazılmaz. Signup sonrasındaki scope, istemcinin
`x-tenant-id`/`x-organization-id` header'ından alınmaz. Production control-plane
önce OIDC principal'ı doğrular, sonra active membership ve workspace authorization
ile tenant/organization/workspace scope'u üretir. Read, domain yönetimi, export ve
delete action'ları role göre ayrı authorize edilir.
Her adım tamamlandıktan sonra checkpoint edilir. Aynı idempotency key aynı komutla
yeniden çalıştırıldığında tamamlanan adımlar atlanır ve aynı duruma yakınsar;
kimlik veya plan değişirse `ONBOARDING_IDEMPOTENCY_CONFLICT` olur.

Tenant/workspace kurulumunu yalnız WP33 `TenantProvisioningService` yapar. Provider
bağlama yalnız WP34 `ProviderCredentialVault.connect` portundan geçer; böylece her
denemede capability evidence ve provider/auth-mode kill switch kontrol edilir.
WP34 capability matrisi gevşetilmez. Özellikle Gemini consumer
`subscription-oauth` `unsupported` pininde kalır. İlk task mevcut durable task
portundan idempotent başlatılır; istemci bağlantısı task sahipliğinin parçası
değildir. PWA kapansa da runtime sürer, dönüşte event replay/snapshot tamamlanmış
çıktıyı getirir.

Managed Cloud route'ları test-only standalone Fastify uygulamasında değil,
`production-server.ts` cloud boot composition'ında kayıtlıdır. Bu composition
gerçek PostgreSQL repository'leri, WP33 runtime-control adapter'ı, WP34 KMS vault
ve kill switch'i, WP24 ledger'ı, WP30 rollout authority'yi, HA durable
task/replay'i ve WP28 lifecycle adapter'ını birlikte kurar.

### Plan, entitlement, quota ve bütçe

Managed beta planı WP33 `deployment-profiles` cloud entitlement contract'ındaki
şu yetkileri birlikte taşımak zorundadır:

- `cloud.managed-tenant-provisioning`
- `cloud.tenant-runtime-isolation`
- `cloud.tenant-capacity-budgets`
- `cloud.runtime-data-plane-credentials`
- `core.provider-adapters`
- `core.detached-runs`

İstemci yalnız server-side catalog'daki `planId + planVersion` kimliğini seçebilir.
Plan, entitlement, compute/storage quota, bütçe ve fiyat kataloğu istemci
payload'ında kabul edilmez. Cloud boot bunları immutable version'lı
`managed_cloud_plan_catalog` kaydından çözer ve WP24 durable commercial
repository'lerine yansıtır. Bilinmeyen plan/version veya ek commercial policy
alanı fail-closed reddedilir.

Plan ayrıca compute vector, storage bytes ve aylık bütçe limiti taşır. Bilinmeyen
veya eksik entitlement deny-by-default reddedilir. Compute/storage hard quota ve
budget halt yeni iş admission'ında fail-closed uygulanır. Halt yeni task, yeni
provider lease ve yeni rezervasyonu durdurur. Halttan önce çalışan durable task
ADR-0026 drain/fencing sınırında güvenli terminal duruma gelir; yeni tool/network
işi alamaz, ölçülen gerçek kullanım settlement'a girer. Çalışan iş zorla
kaybedilmiş sayılmaz.

### Faturalama ayrımı ve credit semantiği

Usage görünümü dört ayrı category taşır: `hosting`, `compute`, `storage`, `model`.
Hosting/compute/storage model ücretinin içine gizlenmez. Her satır `estimated`,
`billable`, status, outcome ve dedupe key taşır.

Platform-credit akışı:

1. Task admission'ında fiyat kataloğundaki üst sınır kadar `reservation`.
2. Terminal kullanım ölçüldüğünde gerçek tutar kadar `settlement`.
3. Kullanılmayan fark `refund/release`; toplam settlement + refund rezervasyonu
   aşamaz.

Failed/interrupted task sıfır maliyet varsayılmaz: ölçülebilen kullanım settle
edilir, kalan rezervasyon serbest bırakılır ve status `incomplete`/`estimated`
olarak görünür. Reconciliation farkı
`ölçülen billable kullanım − ledger settlement` olarak sayısal hesaplanır ve sıfır
olmadan beta exit kabul edilmez.

WP34 `subscription-quota` yalnız provider limit görünümüdür: daima `estimated`,
`non-billable`, monetary amount/currency `null` kalır. Tahmini değer kesin fatura
veya tahsilat kanıtı olarak sunulmaz. Gerçek ödeme sağlayıcısı emulator/port
arkasındadır; gerçek tahsilat kanıtı yoksa gate `not-run` olur.

### Domain, bildirim, mobil ve yaşam döngüsü

Custom domain, WP33 `managed_tenants.domain` metadata'sına bağlı challenge digest
kaydıdır. DNS challenge doğrulanmadan HTTPS `active` olamaz. Challenge secret
değil digest olarak tutulur. Task tamamlandı/approval gerekli olayları WP23 email
ve push outbox hattına verilir; ikinci notification queue kurulmaz.

Privacy, Terms, subprocessors, retention, export/delete ve support yüzeyleri
ürünün bağlantı yüzeyleridir. Retention/export/delete WP28 lifecycle job'larını,
credential revoke/crypto-erasure WP34 vault'u ve tenant metadata silme WP33
delete/reconcile akışını çağırır. Yeni silme veya retention mekanizması icat
edilmez.

### Kontrollü rollout ve operasyon

Rollout sırası `internal → design_partner → limited_beta`dır.
`managed_cloud_beta_admissions` yalnız tenant/cohort, feature flag, rate ve capacity
metadata'sı tutar; karar otoritesi değildir. Kademe geçişi, error budget, halt,
kill switch ve rollback yalnız ADR-0030 `production-readiness` state machine'inden
geçer. Sınırsız genel erişim ve kontrolsüz autoscaling yoktur.

Abuse/rate kontrolü tenant/workspace/provider scope'unda fail-closed'dur.
Capacity ceiling dolduğunda signup/admission durur. Security/privacy critical veya
high bulgu, SLO breach, billing variance, provider terms değişikliği ya da
operator kararı rollout'u halt eder. Rollback önceki doğrulanmış artifact'e döner.

Operasyon kaynağı `docs/operations/managed-cloud-public-beta-runbook.md`;
reconciliation ve beta exit kaynağı
`docs/operations/managed-cloud-billing-reconciliation.md` ile
`docs/operations/managed-cloud-beta-exit-report-template.md` dosyalarıdır.

## Veri modeli ve güvenlik

Migration `0037_wp35_managed_cloud_beta.sql`, yalnız onboarding, domain,
notification preference ve rollout admission metadata'sı ekler. Plan/entitlement/
quota/budget, usage ve credit operation kayıtları WP24 `billing-platform`
tablolarında kalır; migration bunların WP35 kopyasını oluşturmaz. Her domain kaydı
tenant/organization/workspace scope taşır,
`tenant_id = organization_id` CHECK'i ile `ENABLE` + `FORCE ROW LEVEL SECURITY`
altındadır. Token, API key, bearer value, plaintext e-posta veya DNS challenge
evidence/log/fixture/snapshot'a yazılmaz.

## Sonuçlar

- Managed Cloud mevcut contract'ların composition katmanıdır; core event/UI/task
  semantiğini fork etmez.
- Quota/budget/kill-switch başarısızlığında yeni iş açılmaz; mevcut durable işler
  güvenli terminal duruma yakınsar.
- Public beta capacity ceiling, cohort ve feature flag ile sınırlıdır.
- `WP35-L` engineering acceptance; Docker PostgreSQL migration/FORCE RLS,
  iki-tenant adversarial onboarding, production composition, gerçek local
  browser/SSR golden, billing/rollout/lifecycle ve residual cleanup gate'lerinden
  oluşur.
- `WP35-E` external beta acceptance; fiziksel cihaz, gerçek provider network,
  gerçek ödeme/billing ve dış limited-beta ortamı kanıtlarını gerektirir. Bu
  prerequisites yoksa her biri `not-run` kalır. `WP35-L` geçse bile Faz 6
  `WP35-E` tamamlanmadan kapanmış sayılmaz; fixture kanıtı dış kanıta terfi
  ettirilmez.
