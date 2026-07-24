# Managed tenant runtime runbook'u (WP33)

- Kapsam: Managed Cloud (`cloud` deployment profili) tenant runtime operasyonu
- ADR: `docs/architecture/adr-0033-deployment-profiles-and-managed-tenant-runtime.md`
- Migration: `infra/postgres/migrations/0035_wp33_managed_tenant_runtime.sql`
- İlgili paketler: `packages/deployment-profiles`, `packages/tenant-runtime`

## 1. Profil ve boot davranışı

- Profil `PERSISTENT_DEPLOYMENT_PROFILE` ile seçilir (`local | self-hosted | cloud`).
  Bilinmeyen değer `UNKNOWN_DEPLOYMENT_PROFILE` ile boot'u durdurur; `cloud`
  hiçbir zaman örtük seçilmez.
- Cloud boot'u tam production adapter seti ister. Eksik veya development
  fallback değeri (`sqlite`, in-memory, `filesystem`, `development-local`,
  `local-memory`, `local-process`) boot'ta
  `CLOUD_PROFILE_FALLBACK_FORBIDDEN:<alan=değer,...>` hatasıyla fail-closed
  reddedilir. Bu hata görülürse config'i düzeltin; hatayı bastırmayın — bu bir
  operasyon hatası değil, güvenlik sınırıdır.
- `local` ve `self-hosted` davranışı WP32 öncesiyle aynıdır; bu runbook onları
  değiştirmez.

## 2. Tenant yaşam döngüsü operasyonları

Tenant provisioning `TenantProvisioningService` üzerinden checkpointed adım
makinesiyle yürür (`tenant_provisioning_jobs`). Adımlar idempotenttir; yarım
kalan her işlem yeniden koşulduğunda aynı hedef duruma yakınsar.

- Provision adımları: `runtime_identity → encryption_key → filesystem_volume →
secret_namespace → network_policy → placement → capacity_reservation →
runtime_ready`.
- Suspend: `runtime_drain → capacity_release → runtime_stop` — kapasite
  rezervasyonu bırakılır, durable veri korunur.
- Resume: provision adımlarının idempotent yeniden koşumudur.
- Delete: ters söküm + `key_crypto_erase` (ADR-0017 crypto-erasure) +
  `deletion_receipt`.

Operasyon komutu (API): `POST /v1/tenants`, `POST /v1/tenants/:id/suspend`,
`/resume`, `/delete`, `POST /v1/tenants/:id/reconcile` (bkz.
`services/control-plane/src/tenant-runtime-api.ts`). Tenant metadata'sı
(domain, region, retention, kapasite) `GET /v1/tenants/:id` ile okunur.

### Yarım kalan işlem (stuck job) prosedürü

1. `tenant_provisioning_jobs` tablosunda `state IN ('requested','running','failed')`
   kayıtlarını listeleyin; `last_error_code` kök nedeni gösterir.
2. Kök neden (ör. kapasite, KMS erişimi) giderildikten sonra
   `POST /v1/tenants/:id/reconcile` çağırın. reconcile idempotenttir; birden çok
   koşum güvenlidir.
3. reconcile `converged:false` dönerse `actions` listesindeki
   `job-failed:<jobId>:<code>` kaydına göre ilerleyin. Adımlar hiçbir durumda
   elle "tamamlandı" işaretlenmez.

## 3. Orphan runtime tespiti ve bounded cleanup

- `detectOrphans` runtime düzleminde görülen fakat durable kaydı aktif olmayan
  runtime'ları (`missing-durable-record`) ve eski generation kalıntılarını
  (`stale-generation`) `tenant_runtime_orphans` tablosuna işler.
- `cleanupOrphans(limit)` her koşuda en fazla `limit` kaynağı yok eder ve kaydı
  `cleaned` işaretler. Cleanup her zaman üst sınırlıdır; tek koşuda toplu imha
  yapılmaz. Önerilen operasyon değeri: `limit ≤ 10`, kalan varsa sonraki koşum.

## 4. Runtime recreation ve dayanıklılık

Runtime yalnız hesaplama kabuğudur; durable conversation, completed output ve
replay verisi PostgreSQL/object storage'dadır (ADR-0026). Runtime silme/yeniden
oluşturma (`recreateRuntime`) yeni `generation` kurar; eski generation'ın
credential'ları `RUNTIME_SCOPE_REJECTED` ile reddedilir. Recreation sonrası
yapılacak doğrulama: conversation/event/output sayımlarının değişmediği ve
high-water sonrası replay'in boşluksuz olduğu (`wp33:chaos` gate'i bunu
otomatik kanıtlar).

## 5. Internal auth (control plane ↔ runtime data plane)

- Credential'lar `RuntimeDataPlaneAuthority` ile basılır: tenant/workspace/
  runtime/generation scoped, en fazla 5 dakika TTL (varsayılan 60 sn), HMAC
  imzalı. Durable kayıt yalnız digest taşır; plaintext token loglanmaz.
- Şüpheli kullanım durumunda `revoke(credentialId)` çağırın; revocation
  `tenant_runtime_credentials.revoked_at` ile kalıcıdır ve doğrulamada
  fail-closed uygulanır.

## 6. Noisy-neighbor bütçesi

- Tenant başına belgelenmiş bütçe `tenant_capacity_budgets` tablosundadır
  (`reservedCapacity`, `queueLatencyBudgetMs`, `maxStarvationPosition`).
- Kapasite rezervasyonu, diğer tenant'ların bütçe kalanını aşındıracaksa
  `TENANT_BUDGET_ERODED` ile reddedilir. Bu hata kapasite ekleme (yeni node)
  veya bütçe revizyonu gerektirir; sınırın gevşetilmesi bir ürün kararıdır.
- Scheduler sıra bütçesi ADR-0026 `weighted-fair-v1` üzerinden korunur;
  `wp33:isolation` gate'i Tenant B'nin ilk seçim pozisyonunu sayısal raporlar.

## 7. Kabul gate'leri ve kanıt

- `pnpm wp33:test` — ortam gerektirmeyen contract/profil testleri.
- `pnpm wp33:provisioning` — postgres üzerinde provision/suspend/resume/delete/
  reconcile + orphan cleanup.
- `pnpm wp33:isolation` — iki gerçek tenant ile secret/event/artifact/
  filesystem/network adversarial sınır testleri + noisy-neighbor ölçümü.
- `pnpm wp33:chaos` — runtime recreation + durable veri/replay + bounded cleanup.
- `pnpm wp33:accept` — orkestratör; hiçbir not-run sonucu başarıya terfi etmez.

PostgreSQL gate'leri Docker ister; Docker yoksa `WP33_DATABASE_URL` (admin
yetkili, üzerine yazılabilir bir test veritabanı) verilebilir. İkisi de yoksa
gate `status:'not-run'` raporlar ve fail-closed sayılır. Evidence dosyaları
`.wp33/evidence/` altındadır (gitignored, timestamp'siz, redakte); gerçek
Kata/Kubernetes + AWS KMS ortamı olmadan bu gate'ler production izolasyon
kanıtı yerine geçmez (ADR-0017/ADR-0033 sınırı).
