# ADR-0033 — Deployment profilleri ve tenant-isolated managed runtime

- Durum: Kabul edildi
- Tarih: 2026-07-24
- Kapsam: WP33

## Bağlam

WP31 repository'yi open-source yayına hazırladı (ADR-0031), WP32 aynı production
contract'larını koruyan self-hosted dağıtımı teslim etti (ADR-0032). Faz 6 planı
WP33'te Community ve Managed Cloud'un aynı ürün contract'ları üzerinde kalmasını,
cloud workspace'lerinin ise tenant-isolated, sürekli ve operasyonel olarak
yönetilebilir olmasını istiyor.

Mevcut durum:

- Kodda tek "profil" mekanizması `PERSISTENT_CODEX_LOCAL_ALPHA=1` boolean'ıdır
  (`services/control-plane/src/entrypoint.ts`). `local`/`self-hosted`/`cloud`
  ayrımı yalnız dokümanlarda vardır; makinece doğrulanabilir bir profil contract'ı
  yoktur.
- Production storage fail-closed sınırı ADR-0026'nın `assertProductionStorage`
  fonksiyonundadır; fakat cloud'a özgü ek yasaklar (`development-local` secret
  provider, `local-memory` KMS, in-memory repository fallback'leri) tek noktadan
  ve profil bilinciyle uygulanmaz.
- Tenant yaşam döngüsü (WP28, ADR-0028) retention/export/delete için checkpointed
  worker desenini kurdu; fakat tenant'a özel _runtime_ kaynaklarının (identity,
  volume, key, secret namespace, network policy, placement, capacity reservation)
  provisioning'i, reconciliation'ı ve orphan temizliği modellenmedi.
- Control plane ile workspace data plane arasındaki sınır bugün PostgreSQL RLS +
  fencing token (ADR-0026) ve corpus MCP için kısa ömürlü workload credential'ıdır
  (ADR-0022). Runtime data-plane çağrıları için genel, tenant-scoped ve kısa
  ömürlü bir internal auth contract'ı yoktur.

## Değerlendirilen seçenekler

### Profil ayrımı

1. **Ayrı cloud fork'u / ayrı binary** — cloud özellikleri ayrı kod tabanında
   gelişir; contract drift'i ve çifte bakım kaçınılmaz olur. Faz 6 ilkesi
   ("cloud özellikleri ayrı ürün fork'u oluşturmaz") ile çelişir; elenmiştir.
2. **Build-time flag'ler** — tek kod tabanı kalır fakat üç ayrı artifact üretir;
   golden akış eşdeğerliği ancak üç build'in ayrı ayrı test edilmesiyle kanıtlanır
   ve WP29 reproducible-build hattını üçe katlar; elenmiştir.
3. **Runtime deployment profile contract'ı** _(seçildi)_ — tek kod tabanı, tek
   build; profil boot'ta env/config'den çözülür, bilinmeyen değer fail-closed
   reddedilir. Profil yalnız composition'ı (adapter seçimi, entitlement,
   fail-closed sınırlar) etkiler; core agent/conversation/event semantiği profil
   görmez. Bu, contract testleriyle (aynı golden akışın üç profilde bayt-eşdeğer
   çıktısı) makinece doğrulanır.

### Edition/entitlement modeli

1. **Kod içinde dağınık `if (cloud)` dalları** — zamanla fork'a dönüşür; denetimi
   yoktur; elenmiştir.
2. **Deny-by-default entitlement matrisi** _(seçildi)_ — her özellik
   (`feature id`) profil başına açıkça `entitled` değilse kapalıdır. Çekirdek
   semantik (`core.*` feature sınıfı: conversation, event, approval, detached
   run, replay) her profilde zorunlu olarak entitled'dır ve entitlement
   mekanizmasıyla kapatılamaz; bu değişmez contract testiyle korunur. Profil
   farkları yalnız `cloud.*` / `self-hosted.*` / `local.*` operasyonel feature
   sınıflarında yaşar.

### Tenant runtime izolasyon mimarisi

1. **Paylaşımlı runtime + yalnız RLS** — veri düzlemi izole olur fakat runtime
   (filesystem, secret, network, kapasite) paylaşılır; WP33 kabulünün adversarial
   sınır testlerini geçemez; elenmiştir.
2. **Tenant başına ayrılmış runtime kaynak seti** _(seçildi)_ — ADR-0017 ve
   ADR-0026 üzerine kurulur; yeni bir izolasyon teknolojisi icat etmez:
   - Runtime identity: workspace runtime'ı tenant-scoped workload identity ile
     çalışır (`WorkloadIdentity`, ADR-0017). Runtime identity kaydı
     `tenant_runtimes` tablosunda generation ile izlenir.
   - Filesystem/volume: her tenant workspace'i kendi encrypted volume'ünü
     kullanır (ADR-0017 Kata + encrypted CSI kararı); volume kimliği tenant
     runtime kaydına bağlanır, tenant'lar arasında volume paylaşımı şema ve
     adversarial testle yasaktır.
   - Encryption key: ADR-0017 KMS envelope modeli aynen kullanılır; her tenant
     workspace'inin DEK'leri tenant/organization/workspace encryption context'i
     ile wrap edilir; tenant silmede crypto-erasure uygulanır.
   - Secret namespace: SecretLeaseManager kökleri tenant runtime başına ayrıdır;
     lease dosyaları runtime dışına çıkamaz, path escape fail-closed'dur.
   - Network policy: ADR-0017 default-deny egress modeli tenant runtime'ına
     bağlanır; grant'lar tenant/organization/workspace/runtime scoped'dır.
   - Placement ve capacity: ADR-0026 scheduler'ı tek placement authority'dir;
     tenant başına `weighted-fair-v1` policy + atomik capacity reservation
     noisy-neighbor sınırını uygular. WP33 tenant'a belgelenmiş bir kapasite/SLO
     bütçesi (`tenant_capacity_budgets`) ekler ve bu bütçenin başka tenant
     yüküyle aşındırılamadığını ölçülebilir kanıtlar.

### Control plane ↔ runtime data plane internal auth

1. **Ağ topolojisine güven (private network)** — tek başına kimlik değildir;
   yanlış-tenant istekleri ayırt edemez; elenmiştir.
2. **Uzun ömürlü servis token'ı** — çalınması durumunda tüm tenant'ları etkiler;
   tenant scope taşımaz; elenmiştir.
3. **Kısa ömürlü, tenant-scoped workload credential** _(seçildi)_ — ADR-0022
   corpus workload credential deseni genelleştirilir:
   `RuntimeDataPlaneAuthority`, HMAC-SHA256 imzalı, audience
   `urn:persistent-codex:runtime-data-plane`, en fazla 5 dakika (varsayılan 60 s)
   TTL'li, `tenant/organization/workspace/runtime/generation` scoped ve action
   listesi taşıyan credential basar. Doğrulama deny-by-default'tur: kimliksiz,
   imzasız, süresi geçmiş, revoke edilmiş, yanlış audience, yanlış tenant veya
   listede olmayan action typed hata ile reddedilir. Credential digest'i durable
   kayda yazılır; plaintext token hiçbir kayda, loga veya evidence'a çıkmaz.
   PostgreSQL RLS + fencing (ADR-0026) veri düzlemi sınırı olarak aynen kalır;
   workload credential bu sınırın üstüne process-to-process kimlik ekler.

### Provisioning ve reconciliation

1. **Anlık imperative provisioning** — yarım kalan işlem tutarsız kaynak bırakır;
   elenmiştir.
2. **Checkpointed, idempotent, versioned adım makinesi** _(seçildi)_ — WP28
   deletion pipeline deseni provisioning'e uygulanır. `provision`, `suspend`,
   `resume`, `delete` işlemleri sıralı adımlar olarak modellenir; her adım
   idempotent'tir (adapter'lar aynı kimlikle çağrıldığında aynı kaynağa yakınsar)
   ve job kaydı `version` CAS + `idempotency_key` ile korunur. Yarım kalan job
   yeniden koşulduğunda aynı hedef duruma yakınsar. Orphan detection, runtime
   düzleminde görülen fakat durable kaydı aktif olmayan runtime'ları işaretler;
   cleanup her koşuda üst sınırlı (bounded) sayıda kaynağı, audit üreterek yok
   eder.

## Karar

### Deployment profile contract'ı

- Profil kümesi `local | self-hosted | cloud` olarak sabitlenir
  (`DEPLOYMENT_PROFILE_CONTRACT_VERSION = 1`,
  `packages/deployment-profiles`).
- Çözümleme kaynağı `PERSISTENT_DEPLOYMENT_PROFILE` environment değişkenidir.
  Değer bilinmiyorsa boot `UNKNOWN_DEPLOYMENT_PROFILE:<değer>` ile fail-closed
  durur. Değer verilmemişse geri uyumluluk kuralı uygulanır:
  `PERSISTENT_CODEX_LOCAL_ALPHA=1` → `local`, aksi halde `self-hosted`.
  `cloud` profili hiçbir zaman örtük seçilmez; açık opt-in ister.
  `PERSISTENT_DEPLOYMENT_PROFILE=cloud` ile `PERSISTENT_CODEX_LOCAL_ALPHA=1`
  birlikte verilirse çelişki fail-closed reddedilir.
- Her profil, makinece okunabilir bir contract taşır: edition
  (`community | cloud`), izinli storage backend'leri, izinli secret/KMS
  provider'ları, izinli runtime backend'leri, managed tenant runtime zorunluluğu
  ve development adapter izni. Cloud contract'ı ADR-0026
  `assertProductionStorage` kümesinin üstüne `development-local` secret
  provider, `local-memory` KMS, `local-process` runtime, SQLite event store,
  in-memory repository ve filesystem storage fallback'lerini
  `CLOUD_PROFILE_FALLBACK_FORBIDDEN:<alanlar>` ile boot'ta reddeder.
- Entitlement policy deny-by-default'tur; `core.*` feature'ları her profilde
  zorunlu entitled'dır. Fork-engelleyici contract testi, golden
  event/conversation akışını üç profil composition'ından geçirir ve üç çıktının
  bayt-eşdeğer olduğunu (sha256 eşitliği) doğrular; profil parametresinin event
  pipeline'ına sızması bu testi kırar.

### Managed tenant runtime modeli

- Yeni `packages/tenant-runtime` paketi ve
  `infra/postgres/migrations/0035_wp33_managed_tenant_runtime.sql` migration'ı
  eklenir. Tablolar: `managed_tenants` (tenant durumu + domain/region/retention/
  capacity metadata'sı), `tenant_capacity_budgets` (belgelenmiş kapasite/SLO
  bütçesi), `tenant_runtimes` (runtime identity, volume, key ref, secret
  namespace, network policy, placement, capacity reservation, generation),
  `tenant_provisioning_jobs` (checkpointed adım makinesi),
  `tenant_runtime_credentials` (yalnız digest), `tenant_runtime_orphans`
  (bounded cleanup kaydı). Tümü mevcut ev deseniyle `FORCE ROW LEVEL SECURITY`
  ve tenant scope policy'si altındadır; provisioning servisi tenant'lar arası
  çalışabilmek için 0028 scheduler deseninde olduğu gibi ayrı bir sistem rol
  üyeliğiyle (`persistent_tenant_provisioner`) yetkilendirilir.
- Tenant kimliği bu repo'nun mevcut değişmezine sadık kalır:
  `tenant_id = organization_id` (migration 0023 CHECK'i). WP33 bu değişmezi
  gevşetmez.
- Provisioning adımları: `runtime_identity → encryption_key → filesystem_volume →
secret_namespace → network_policy → placement → capacity_reservation →
runtime_ready`. Suspend capacity reservation'ı bırakır, runtime'ı durdurur ve
  durable state'i korur; resume aynı adımları idempotent yeniden koşar; delete
  ters sırada söker ve ADR-0017 crypto-erasure ile biter. Reconciliation,
  desired/observed state farkını kapatan tek yakınsama fonksiyonudur; kesilen
  her işlem yeniden koşulduğunda aynı hedef duruma ulaşır.
- Runtime silme/yeniden oluşturma (yeni generation) durable conversation,
  completed output ve detached task/replay akışını etkileyemez: bu veriler
  ADR-0026 gereği PostgreSQL/object storage'dadır, runtime yalnız hesaplama
  kabuğudur. Eski generation'ın yazma hakkı fencing + credential generation
  kontrolüyle reddedilir.

### Tenant metadata

`managed_tenants` tenant başına `domain` (WP28 domain-doğrulama akışına aday),
`region_id` (yalnız metadata + placement affinity; gerçek çoklu-region dağıtımı
kapsam dışı), `retention_days`/`retention_policy_id` (WP28 retention hattına
bağlanır) ve `capacity` (reserved kapasite vektörü) taşır. Bu metadata
`buildTenantRuntimeApi` üzerinden okunur/yazılır ve persistence katmanında RLS
altındadır.

### Kabul gate'leri

`pnpm wp33:test | wp33:provisioning | wp33:isolation | wp33:chaos | wp33:accept`.
Evidence sözleşmesi wp30/wp31/wp32 ile aynıdır: `machineEvidence`/`failNotRun`,
`.wp33/evidence/` (gitignored), timestamp'siz deterministik JSON, redaksiyon
zorunlu. PostgreSQL gate'leri Docker yoksa `WP33_DATABASE_URL` ile operatör
veritabanı kabul eder; ikisi de yoksa `status:'not-run'` + `accepted:false`
raporlar ve fail-closed sayılır; hiçbir not-run sonucu başarıya terfi
ettirilmez. `wp33:isolation` iki gerçek tenant ile secret/event/artifact/
filesystem/network sınırlarını adversarial dener ve noisy-neighbor bütçe
korumasını sayısal raporlar; `wp33:chaos` runtime recreation + orphan bounded
cleanup kanıtı üretir.

## İlgili ADR'lar

- ADR-0016 — OIDC, deny-by-default authorization ve PostgreSQL forced RLS tenant
  veri sınırı; WP33 RLS desenini yeni tablolara aynen uygular.
- ADR-0017 — Kata micro-VM runtime, default-deny egress, secret lease ve KMS
  envelope encryption; WP33 tenant runtime kaynak setinin izolasyon
  mekanizmalarını bu ADR'dan alır ve tenant yaşam döngüsüne bağlar.
- ADR-0026 — HA topology, scheduler, lease/fencing ve kapasite izolasyonu; WP33
  placement/capacity reservation'ı bu ADR'ın scheduler authority'sine bağlar ve
  noisy-neighbor bütçesini onun kapasite modeli üzerinden kanıtlar.
- ADR-0028 — Enterprise tenant lifecycle; WP33 provisioning adım makinesi bu
  ADR'ın checkpointed worker desenini runtime kaynaklarına genişletir.
- ADR-0032 — Self-hosted dağıtım; `self-hosted` profil contract'ı bu ADR'daki
  topolojiyi profil şemasına bağlar, davranışını değiştirmez.

## Sonuçlar

- Üç profil aynı kod tabanından, aynı build'den üretilmeye devam eder; profil
  farkı yalnız composition ve entitlement katmanındadır ve contract testleriyle
  korunur. `local` ve `self-hosted` davranışı değişmez.
- Cloud profili gerçek production adapter'ları olmadan boot edemez; geliştirme
  fallback'i ile "sessizce çalışan" bir cloud kurulumu mümkün değildir.
- Managed Cloud kontrol düzlemi tenant runtime'larını durable, idempotent ve
  denetlenebilir bir yaşam döngüsüyle yönetir; yarım kalan operasyonlar ve
  orphan kaynaklar operasyonel prosedür değil, contract gereğidir.
- Gerçek Kata/Kubernetes, AWS KMS ve çoklu-node kapasitesi olmayan geliştirme
  ortamı production izolasyon kanıtı üretemez; bu durumda ilgili gate'ler
  `not-run` raporlar (WP30 kuralı). Managed Cloud emulator sonucu production
  isolation kanıtı sayılmaz (Faz 6 kuralı).
- Provider OAuth ekranları, fiyatlandırma/ödeme ve public beta WP34/WP35
  sınırındadır; WP33 bu alanlarda karar üretmez.
