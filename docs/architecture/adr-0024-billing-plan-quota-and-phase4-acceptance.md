# ADR-0024: Billing adapter, ticari plan/kota ve Faz 4 kabul sınırı

- Durum: Kabul önerisi
- Tarih: 18 Temmuz 2026
- Kapsam: WP24

## Bağlam

ADR-0012 provider usage ve append-only ledger'ı; ADR-0021/0022 corpus embedding
meter'larını; ADR-0023 mobil approval ve push lifecycle'ını kurdu. Ticari plan ve
billing webhook'ları bu doğruluk kaynaklarını kopyalarsa aynı provider isteği, corpus
işi veya approval replay'i iki kez hak/maliyet üretebilir. Gerçek billing provider,
merchant-of-record, vergi ve invoice/refund operasyonu henüz seçilmemiştir.

## Karar

- Billing provider ve merchant-of-record seçimi ertelenir. Version 1
  `BillingProviderPort` sözleşmesi ve HMAC tabanlı deterministic emulator kullanılır.
  Emulator signature, timestamp tolerance, bounded payload, retry, replay ve
  idempotency kanıtıdır; production tahsilat, vergi, invoice veya refund kanıtı değildir.
- Normal runtime composition `services/control-plane/src/main.ts` içindedir. Local
  alpha, `BILLING_DATABASE_URL` yanında açık
  `PERSISTENT_BILLING_PROVIDER=emulator` seçimi olmadan başlamaz; emulator hiçbir
  koşulda production-capable sayılmaz. Production, durable billing database ile
  production provider ve secret adapter'ı birlikte bulunmadığında fail-closed
  kapanır; development emulator'a sessiz fallback yapmaz.
- Currency üç harfli ISO kodu olarak kaydedilir. İlk katalog `USD` kullanabilir; kur,
  vergi dahil/haricî fiyat, invoice numaralandırma ve refund davranışı provider ve hukuk
  kararı olmadan uygulanmış gerçek gibi sunulmaz. `taxBehavior=unknown` geçerli ve
  görünür bir durumdur.
- Platform-managed inference'ta provider token ve resmi/estimated AI maliyeti ticari
  kullanıma dahildir. BYOK'ta müşterinin provider ücretini platform tahsil etmez;
  platform compute, storage, egress, corpus indexing/retrieval ve abonelik bileşenlerini
  ölçmeye devam eder. `hybrid` plan bu ayrımı workspace/provider credential mode'una
  göre satır bazında korur; BYOK provider maliyetini sıfır diye uydurmaz.
- Mevcut append-only `usage_ledger` tek kullanım doğruluk kaynağıdır. Provider input,
  cached input, output ve reasoning token; provider-reported cost; compute millisecond;
  storage byte-millisecond; egress byte; index ve retrieval embedding token meter'ları
  version 1 olarak tanımlanır. Her satır deterministic dedupe key, price catalog
  version ve `measured|estimated|reconciled|incomplete` durumu taşır. Reconciliation
  yeni append-only kayıt/projection üretir; geçmiş satırı değiştirmez ve aynı provider
  reference ikinci maliyet oluşturmaz.
- Terminal usage yoksa failed, interrupted veya completed task'ın gerçekleşmiş ara
  kullanımı korunur; sonuç `incomplete/unreconciled`, cost nullable kalır. Sıfır
  provider veya corpus kullanımı varsayılmaz.
- Plan, entitlement, subscription, budget, quota, billing customer, webhook ve invoice
  reconciliation kayıtları tenant/organization/workspace scope'lu ve versioned'dır.
  PostgreSQL composite foreign key ile forced RLS uygular. Ham payment payload,
  signature, secret ve credential saklanmaz; yalnız digest, signature version ve
  allowlist metadata tutulur.
- Webhook identity `(tenant, organization, workspace, provider, eventId)`'dir. Aynı ID
  farklı digest ile conflict'tir. Claim `SKIP LOCKED`, retry bounded ve restart'ta stale
  `processing → retry` olur. Unknown event `unknown` state'inde güvenle korunur.
  Subscription/entitlement projection yalnız daha yüksek `(providerSequence,
effectiveAt)` uygular; duplicate ve out-of-order event eski state'i geri getirmez.
  Endpoint yalnız özel versioned content type ile bounded raw body kabul eder;
  timestamp ve signature doğrulamasından sonra raw body atılır. Retry/restart için
  yalnız allowlist şemasından geçmiş normalize komut saklanır. Unknown event'te
  provider `data` içeriği saklanmadan `unknown` state korunur.
- Admission; turn start, source upload, index, retrieval ve workspace concurrency
  girişinden önce çalışır. Entitlement eksik/kapalıysa ve hard limitte fail-closed
  `deny`; soft limitte iş devam ederken kullanıcı uyarısı ve append-only audit oluşur.
  Karar policy version, reason, in-flight policy ve usage measurement watermark taşır.
  Aynı watermark/policy replay'i tek karardır.
- Runtime admission, scope başına PostgreSQL transaction advisory lock ve durable
  request-key lease kullanır. İki control-plane instance aynı request'i tek quota
  decision'a bağlar; aktif turn lease'i provider turn kimliğine bind edilir ve terminal
  event'te idempotent bırakılır. Bu lease WP24 admission bütünlüğüdür; WP25'in HA
  scheduler/fair-queue kapsamını aktive etmez.
- Version 1 aktif turn politikası `continue` varsayılanıdır: hard limit yeni işi
  engeller, başlamış turn tamamlanır ve gerçekleşen kullanım ledger'a yazılır. Yalnız
  quota kaydında açık `interrupt` seçildiyse control plane mevcut idempotent interrupt
  yolunu bir kez çağırabilir. Billing webhook veya approval replay'i concurrency ya da
  quota ölçümünü ikinci kez artırmaz.
- Tenant ve session concurrency; provider spend; corpus source, byte ve chunk; storage
  limitleri desteklenir. Compute/egress meter'ları ticari ölçümdür; WP25 scheduler,
  distributed lease, HA admission veya noisy-neighbor çözümü bu ADR'ye dahil değildir.

## Faz 4 kabul ayrımı

`phase4:accept`, önce yeni `wp24:e2e` ve `wp24:browser` kapılarını doğrudan çalıştırır.
Bu iki kapı aynı harness içinde gerçek PostgreSQL + pgvector, pinli Codex `0.144.2`,
tek tenant/workspace/session, gerçek PDF upload/index, workspace-local MCP retrieval,
citation, command approval, iki browser context CAS, session resume, usage/cost ve
plan/budget görünümünü bağlar. Codex her turn için ayrı durable `runId` verdiğinden
retrieval ve approval run kimlikleri ortak `sessionId` altında ayrı evidence olarak
raporlanır. Delete/reindex, failed/interrupted incomplete accounting, hard quota,
restart persistence ve cross-tenant görünmezlik aynı cleanup-safe harness içindedir.
WP22/WP23 kapıları yalnız regresyondur; birleşik kanıt yerine geçmez. Billing ve Web
Push credential yoksa gerçek-provider smoke `not-run` raporlanır; emulator sonucu
production kanıtı sayılmaz.

## Sonuçlar

Ticari policy usage'ın sahibi değildir; ledger watermark üzerinden karar verir.
Out-of-order billing olayı hakları geri sarmaz ve failed/interrupted maliyet kaybolmaz.
Gerçek provider/MoR, tax, invoice/refund ve production Web Push doğrulaması bağımsız
karar ve credential gerektirir. WP24 uygulaması Faz 4'ü veya WP25'i aktive etmez;
bağımsız WP24 kabul task'ı bunu ayrıca yapar.
