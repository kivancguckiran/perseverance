# Faz 4 Corpus ve mobil ürün, Faz 5 Production hardening planı

- Plan durumu: Aktif
- Plan tarihi: 17 Temmuz 2026
- Aktif iş paketi: WP29
- Ön koşul: WP0–WP20 ve Faz 3 tamamlandı
- Kaynak spesifikasyon:
  `docs/architecture/persistent-codex-workspace-tasarim-spesifikasyonu.md`

## 1. Amaç ve numaralandırma

Ana ürün spesifikasyonundaki Corpus ve mobil ürün kilometre taşı, araya eklenen
Provider Platform ve Multi-tenant Security Beta fazlarından sonra bu planda Faz 4
olarak; Production hardening ise Faz 5 olarak numaralandırılır.

Faz 4, tenant-aware kaynak alma ve retrieval katmanını gerçek agent çalışmasına
kaynaklı bağlam olarak ekler; mobil/PWA approval-resume deneyimini, ticari plan/kota
akışını ve güvenli paylaşımlı klasör ortak çalışmasını tamamlar. Faz 5, kabul edilmiş
ürün sınırlarını yüksek erişilebilirlik, felaket kurtarma, kapasite, enterprise
lifecycle, supply-chain güvenliği ve kontrollü production rollout seviyesine taşır.

## 2. İş paketi özeti

| Paket | Faz | Durum      | Hedef                                                                    |
| ----- | --- | ---------- | ------------------------------------------------------------------------ |
| WP21  | 4   | Tamamlandı | Tenant-aware source registry, extraction, chunk ve derived index temeli  |
| WP22  | 4   | Tamamlandı | Hybrid retrieval, citation, watcher/reindex ve workspace-local MCP       |
| WP23  | 4   | Tamamlandı | Mobil/PWA approval, push notification ve çoklu cihaz sürekliliği         |
| WP24  | 4   | Tamamlandı | Billing, prepaid kredi ve gelir/COGS/marj kabulü                         |
| WP25  | 4   | Tamamlandı | Paylaşımlı klasör, güvenli ortak çalışma ve birleşik Faz 4 kabulü        |
| WP26  | 5   | Tamamlandı | HA production topology, multi-region yönü, scheduler ve kapasite sınırı  |
| WP27  | 5   | Tamamlandı | Observability/SLO, backup/restore, DR ve region-failover tatbikatı       |
| WP28  | 5   | Tamamlandı | Enterprise SSO/SCIM, retention/export/delete ve data-residency lifecycle |
| WP29  | 5   | Aktif      | Supply-chain, provider canary, güvenli upgrade ve compliance kontrolleri |
| WP30  | 5   | Planlandı  | Pentest, load/soak/chaos ve kontrollü production rollout kabulü          |

Her zaman yalnız bir iş paketi aktif olabilir. WP21 kabul edilmeden WP22; WP24 kabul
edilmeden WP25; Faz 4 tamamlanmadan WP26; WP29 tamamlanmadan nihai WP30 aktive edilmez.

## 3. Faz 4 — Corpus ve mobil ürün

### WP21 — Source registry, extraction ve tenant-aware index temeli

#### Hedef

Dosya sistemini ve yüklenen kaynak snapshot'larını doğruluk kaynağı; search index'i
yeniden üretilebilir derived data kabul eden, tenant ve workspace sınırları zorunlu
bir ingestion omurgası kurmak.

#### Kapsam

- Versioned source, source revision, extraction job, chunk, index document ve
  ingestion audit sözleşmeleri.
- PDF, Markdown, text ve desteklenen kod dosyaları için bounded streaming extraction;
  MIME sniffing, boyut/sayfa limitleri, zip-bomb ve parser sandbox koruması.
- Her kaynakta content hash, immutable raw snapshot, parser version, language,
  provenance ve lifecycle durumu.
- İdempotent queue/job state machine: pending, extracting, indexed, failed, deleted;
  retry, poison item/DLQ ve crash/restart recovery.
- PostgreSQL forced RLS ve composite tenant/workspace foreign key'leri; MVP vector
  seçimi için ADR. Varsayılan yön pgvector, fakat ölçüm olmadan kesin performans
  iddiası yoktur.
- Chunk sınırları, overlap, metadata ve embedding version kaydı. Embedding usage
  mevcut append-only usage ledger'a `index_embedding_token` olarak yazılır.
- Index silinse dahi raw source doğruluk kaynağından deterministik rebuild.
- Source içeriği log, trace ve hata mesajlarına plaintext taşınmaz.

#### Zorunlu kabul

- Aynı kaynak/revision tekrar işlendiğinde duplicate chunk veya usage oluşmaz.
- Crash/restart kaldığı yerden güvenli devam eder; poison source diğer işleri durdurmaz.
- Tenant A source/chunk/index/job verisi Tenant B tarafından REST, worker veya DB/RLS
  üzerinden görülemez.
- PDF/Markdown/text extraction golden fixture'ları; malformed, oversized ve parser
  timeout testleri geçer.
- Delete ve tam rebuild sonunda derived index deterministik olarak aynı corpus
  durumuna gelir.
- `pnpm verify` ve gerçek PostgreSQL ingestion smoke'u geçer.

#### Teslimat commit'i

`feat: add tenant-aware corpus ingestion foundation`

#### Bağımsız kabul sonucu

Karar: **Tamamlandı**

- Uygulama ve hardening commit'leri `f843b35`, `3afad1a`, `98d5f88` ve `94a7a77`
  birlikte tenant-aware ingestion omurgasını tamamladı.
- PostgreSQL repository, forced RLS, API/worker restart recovery, concurrent claim,
  idempotent upload, deterministic rebuild, usage ledger ve cleanup gerçek
  PostgreSQL smoke'unda iki ardışık çalışmada geçti.
- Snapshot storage workspace-security KMS/envelope katmanına bağlandı. Tenant,
  organization, workspace, revision, storage key ve content hash AAD ile
  doğrulanıyor; ciphertext/tag/wrapped-key substitution, revoked key ve crypto-erasure
  testleri fail-closed sonuçlandı.
- PDF/Markdown/text extraction, parser limitleri ve timeout, poison source, delete ve
  reindex kontrolleri geçti.
- Browser kabulü doğru API URL'siyle temiz build alarak 1280x720 ve 390x844
  görünümde iki ardışık kez geçti; pending/extracting/indexed/failed/delete-reindex,
  reload durability ve cross-tenant görünmezlik doğrulandı. Page error, yatay taşma
  ve içerik/credential sızıntısı oluşmadı.
- `pnpm verify` 23 test dosyasında 283 test, typecheck, production build ve SSR HTTP
  smoke ile tamamlandı. Geçici PostgreSQL container, volume ve test dizinleri
  temizlendi.

WP21 tamamlandı. WP22 tek aktif iş paketidir.

### WP22 — Hybrid retrieval, citations, watcher ve workspace-local MCP

#### Hedef

Corpus'u agent'ın güvenli biçimde kullanabileceği, ACL filtreli, kaynak gösteren ve
silme/reindex semantiği deterministik bir retrieval hizmetine dönüştürmek.

#### Kapsam

- Tenant/workspace scoped search contract ve cursor pagination.
- Lexical + vector hybrid retrieval, versioned ranking policy, bounded top-k/token
  budget ve ölçülebilir latency/quality metrikleri.
- ACL filtresi ranking öncesinde uygulanır; sonuçlar source/revision/page/line veya
  chunk locator citation taşır.
- Workspace-local MCP retrieval server; scoped workload identity, read-only tools,
  bounded output ve unknown-tool/event güvenli fallback'i.
- Prompt-injection ve malicious-source işaretleri; retrieval içeriği talimat değil
  untrusted context olarak açıkça ayrılır.
- Workspace watcher debounce, `.gitignore`, `.codexignore` ve `index.ignore` politikası;
  rename/delete/update, backlog ve tam reindex.
- Source silindiğinde search ve MCP sonucundan bounded süre içinde kaybolma; tombstone
  ve cache invalidation.
- Offline index rebuild, embedding/ranking version migration ve rollback.

#### Zorunlu kabul

- Exact lexical, semantic ve mixed query golden setleri beklenen citation'ları verir.
- Cross-tenant ve unauthorized source sonuçları ranking/cache/MCP katmanlarının
  hiçbirinde görünmez.
- PDF silme veya workspace dosya değişikliği search sonucuna deterministik yansır.
- Malicious corpus metni tool policy veya system instruction gibi yürütülmez.
- Agent gerçek görevde retrieval çağırır, citation'lı cevabı timeline'da görünür ve
  raw reasoning saklanmaz.
- Büyük corpus, reconnect ve reindex sırasında bounded memory/backpressure korunur.

#### Teslimat commit'i

`feat: add hybrid corpus retrieval and workspace MCP`

#### Uygulama ve bağımsız kabul kaydı

Durum: **Tamamlandı**. WP22 bağımsız kabul edildi; WP23 tek aktif iş paketidir.

- Contract/repository: search/citation schema v1, repository v2, ranking policy
  `hybrid-rrf-v1`, `corpus-index-v1`, bounded cursor/top-k/token/timeout ve immutable
  source/revision/chunk citation.
- Migration: `0022_hybrid_corpus_retrieval.sql`; pgvector(384), FTS, source ACL,
  workspace path binding, tombstone/cache epoch, watcher/reindex ve explicit
  expand/backfill/active/rolling-back/rolled-back state'leri forced RLS ve composite
  scope foreign key'leriyle eklendi.
- Retrieval/MCP: lexical ve vector adayları ACL filtresinden sonra değil, her aday
  sorgusunda önce filtrelenir. Cache principal/scope/epoch namespace'lidir. MCP fixed
  workload identity kullanır; yalnız read-only `search_corpus`/`get_citation` sunar ve
  corpus'u `untrusted_context` olarak işaretler.
- Runtime provisioning: normal session bootstrap `WorkspaceRuntimeRegistry` üzerinden
  required workspace corpus MCP'yi managed Codex-home config katmanına ekler. Kullanıcı
  provisioning config'i değişmez; token/proof değeri config'e yazılmaz. App-server
  restart generation'ında credential rotate/revoke edilir; MCP unavailable ise session
  açık hata ile fail-closed olur.
- Workload identity: kısa ömürlü signed claim + request proof key; fixed audience,
  tenant/organization/workspace ve yalnız `source.search`/`citation.read`. Timestamp,
  nonce ve action-bound proof replay, expiry, revoke, scope/audience/action mismatch ve
  token substitution'ı reddeder.
- Watcher: debounce, bounded backlog, deterministic ordered ignore policy,
  create/update/rename/delete; update aynı source altında immutable revision,
  supersede/delete tombstone ve cache invalidation üretir. Runtime startup full scan,
  gerçek filesystem signal + bounded reconciliation, canonical-root/symlink kontrolü
  ve durable `corpus_watch_jobs` claim/recovery/complete hattına bağlıdır.
- `pnpm wp22:test`: retrieval golden/policy, malicious content, MCP unknown fallback,
  watcher debounce/ignore/backpressure ve API search/citation/delete testleri.
- `pnpm wp22:postgres`: gerçek `pgvector/pgvector:pg17` üzerinde migration, forced RLS,
  cross-tenant/source ACL, lexical+vector+cache+MCP, workspace lifecycle, PDF delete ve
  rollback state smoke'u. Geçici container/volume cleanup ayrıca doğrulanır.
- `WP22_CODEX_BIN=<pinned-0.144.2> pnpm wp22:agent-e2e`: gerçek pinli app-server turn,
  normal ürün session bootstrap, managed MCP provisioning, PostgreSQL watcher index,
  tool start/complete, citation'lı final timeline, malicious instruction ve raw
  reasoning bulunmadığı kontrolü.
- `WP22_CODEX_BIN=<pinned-0.144.2> pnpm wp22:browser`: gerçek PostgreSQL/pgvector +
  Codex turn üzerinde watcher create/update/rename/delete, cross-tenant/unauthorized
  zero-result, reconnect citation/tool görünümü, keyboard/screen-reader label ve
  1280x720, 768x1024, 390x844 overflow/page-error/credential leak kontrolleri.
- `WP22_CODEX_BIN=<pinned-0.144.2> pnpm wp22:accept`: WP22 test, PostgreSQL, agent E2E
  ve browser gate'lerini tek cleanup-safe kabul zincirinde çalıştırır.
- `pnpm verify`: format, typecheck, bütün unit/contract testleri, build ve SSR HTTP gate'i.
- Provider ayrımı: deterministic fake-test embedding mekanik vector/ACL ve golden
  sıralama fixture'ıdır; usage ledger'a billable kanıt yazmaz ve production semantic
  quality kanıtı olarak sunulmaz. Gerçek Codex provider yalnız agent tool/citation E2E
  için kullanılır.
- Encryption ayrımı: agent/browser E2E gerçek PostgreSQL/pgvector kullanır; snapshot
  KMS explicit local test fixture'dır ve production KMS kanıtı sayılmaz.

Production runtime wiring düzeltme commit'i:
`fix: integrate WP22 retrieval into workspace runtime`.

Bağımsız kabulte `WP22_CODEX_BIN=<pinned-0.144.2> pnpm wp22:accept` bütünüyle geçti:
24 hedefli test, gerçek PostgreSQL/pgvector ve forced RLS, normal session bootstrap,
managed MCP provisioning, proof-bound workload credential, watcher
create/update/rename/delete lifecycle, gerçek Codex tool/citation turn'ü ve browser
timeline doğrulandı. Browser 1280x720, 768x1024 ve 390x844 görünümde reconnect,
keyboard/screen-reader label, sıfır yatay taşma/page error/credential leak ile geçti.
`pnpm verify` 27 test dosyasında 294 test, typecheck, build ve SSR HTTP smoke'u
tamamladı. Geçici Codex kurulumu, PostgreSQL container/volume, browser session ve test
dizinleri temizlendi.

Uygulama commit'leri: `e7b9b40`, `cd24e14`.

WP22 tamamlandı. WP23 tek aktif iş paketidir; WP23 tamamlanmadan WP24'e geçilemez.

### WP23 — Mobil/PWA approval, push ve çoklu cihaz sürekliliği

Durum: **Tamamlandı**. WP23 bağımsız kabul edildi; WP24 tek aktif iş paketidir.

#### Hedef

Mevcut PWA'yı, uzun süren agent işlerini telefondan güvenle izleme, approval verme ve
session'a geri dönme açısından private-beta ürün seviyesine taşımak.

#### Kapsam

- ADR ile PWA-first yaklaşımını yeniden doğrula; native shell gereksinimini ölçülebilir
  boşluklara bağla, sırf teknoloji tercihi için native uygulama açma.
- Web Push subscription lifecycle, tenant/device binding, key rotation, revoke,
  expiry ve delivery receipt/outbox.
- Bildirim payload'ında prompt, output, filename, secret veya tenant içeriği bulunmaz;
  yalnız opaque session/approval kimliği ve genel durum.
- Mobil approval/diff görünümü: exact command/file/network context, risk, scope ve
  expiry; küçük ekranda güvenli karar verme.
- Deep link ile ilgili session/approval'a dönüş; auth refresh ve expired notification
  davranışı.
- İki cihazdan concurrent approval için mevcut CAS/idempotency; kazanan kararın diğer
  cihazda realtime reconciliation'ı.
- Offline shell/history salt-okunur; offline approval kuyruğa alınıp sonradan körlemesine
  gönderilmez.
- Uzun çalışan task için background/detached execution, reconnect, scroll lock ve
  accessibility/mobile performance kabulü.

#### Zorunlu kabul

- Telefon bağlantısı kesilip açıldığında aynı session high-water'dan boşluksuz sürer.
- İki cihaz aynı approval'a karar verdiğinde yalnız biri kazanır, diğeri terminal
  sonucu gösterir.
- Push revoke edilmiş/başka tenant device'ına gönderilmez; payload secret scan'i geçer.
- 390x844, tablet ve desktop browser E2E; keyboard, screen reader label ve yatay taşma
  kontrolleri geçer.
- Gerçek push provider credential'ı yoksa emülatör testi production delivery kanıtı
  sayılmaz; gerçek opt-in smoke ayrıca raporlanır.

#### Teslimat commit'i

`feat: complete secure mobile approval and push experience`

#### Uygulama kabul adayı kaydı

- ADR-0023 PWA-first yönünü doğrular; native shell açılmadı. Production manifest,
  installability iconları, versioned service worker, kullanıcı kontrollü update,
  notification click deep link ve offline read-only shell production build'e bağlıdır.
- Push contract version 1 device/subscription/outbox/receipt lifecycle'ını; subscribe,
  rotation, expiry, CAS revoke, sign-out cleanup, invalid endpoint, bounded retry ve
  duplicate/out-of-order idempotency ile tanımlar. Endpoint ve Web Push key materyali
  KMS envelope içinde tenant/organization/workspace/subscription/principal AAD ile
  saklanır; public response yalnız fingerprint döndürür.
- Migration `0023_pwa_push_multi_device.sql`; workspace tenant scope genişletmesi,
  composite tenant/organization/workspace foreign key zinciri, principal-bound forced
  RLS, `SKIP LOCKED` outbox claim ve idempotent delivery receipt ekler.
- Notification payload exact allowlist'tir: opaque notification/session/approval ID ve
  genel durum. Service worker unknown alan içeren payload'ı reddeder. Emulator secret/
  content taraması prompt, output, reasoning, command, diff, filename, citation,
  bearer ve API key için sıfır sızıntıyla geçti.
- Mobil approval 390x844 görünümde exact command/cwd/network context, risk, scope ve
  expiry gösterir. Keyboard focus, screen-reader label, reduced motion ve en az 44 px
  touch target kontrolleri eklendi.
- `pnpm wp23:accept`: 99 hedefli unit/contract test; gerçek PostgreSQL forced-RLS,
  rotation/revoke/expiry, delivered/retry/invalid endpoint, duplicate outbox/receipt ve
  cross-tenant/principal zero visibility smoke'u; iki bağımsız browser context CAS
  yarışı; realtime reconciliation, browser kapalıyken server-side completion,
  high-water replay, offline read-only shell ve cleanup kapılarını çalıştırdı.
- İki cihaz yarışında bir CAS kazananı, bir upstream response, sıfır duplicate karar ve
  iki cihazda aynı terminal sonuç görüldü. 390x844, 768x1024 ve 1280x720 görünümde sıfır
  yatay taşma/page error; service worker production build ve offline reload geçti.
- `pnpm verify`: 29 test dosyasında 299 test, typecheck, production build ve SSR HTTP
  smoke geçti.
- Push provider ayrımı: Web Push provider emulator kullanıldı. Gerçek VAPID/provider
  credential'ı bulunmadığı için gerçek opt-in/delivery smoke'u çalıştırılmadı; emulator
  production delivery kanıtı sayılmaz.

Bağımsız kabulte `pnpm wp23:accept` bütünüyle geçti: 99 hedefli test, gerçek
PostgreSQL/forced RLS push lifecycle, iki cihazlı approval CAS/realtime reconciliation,
background completion, high-water replay, offline read-only shell ve üç viewport PWA
browser doğrulandı. `pnpm verify` 29 test dosyasında 299 test, typecheck, production
build ve SSR HTTP smoke'u tamamladı. Container, volume, browser context, service worker
ve geçici dosya cleanup'ı geçti.

Uygulama commit'i: `3962844`.

WP23 tamamlandı. WP24 tek aktif iş paketidir; Faz 4 WP24 bağımsız kabul edilmeden
kapatılamaz ve WP25 aktive edilemez.

### WP24 — Billing, prepaid kredi ve gelir/COGS/marj kabulü

#### Hedef

Provider, compute, storage, egress ve corpus kullanımını ticari plan/kota ve prepaid
kredi politikasıyla birleştirmek; tahsilat, tüketilen kredi geliri ve COGS/marjı
birbirinden ayırmak; Faz 4'ü PDF'den citation'lı agent cevabına ve mobil approval'a
kadar uçtan uca kapatmak.

#### Kapsam

- ADR ile billing provider, merchant-of-record ve platform-managed/BYOK ücret ayrımı.
- Plan, entitlement, budget, quota, invoice reconciliation ve webhook event
  sözleşmeleri; webhook signature, replay ve idempotency.
- Append-only prepaid kredi ledger'ı: satın alma/top-up, promotional grant,
  reservation, reservation release, usage settlement, refund, chargeback, expiration
  ve admin adjustment. Mutable balance doğruluk kaynağı olamaz; available/reserved
  balance ledger projection'ından türetilir.
- Ödeme webhook'u doğrulandıktan sonra idempotent credit lot üretimi. Her lot paid veya
  promotional niteliği, para birimi, parasal değer, kredi miktarı, grant/expiry ve
  refund/chargeback bağını taşır.
- İş başlamadan bounded kredi reservation; ölçülen kullanım geldikten sonra versioned
  retail price catalog ile kredi settlement ve kullanılmayan reservation release.
  Failed/interrupted/incomplete işte gerçekleşmiş kullanım ücretlenir; bilinmeyen
  terminal kullanım sıfırlaştırılmaz.
- Mevcut append-only usage ledger'da provider token/cost, compute, storage, egress ve
  embedding meter'ları; failed/interrupted task kullanımını koru.
- Soft warning, hard limit ve in-flight turn politikası; tenant/session concurrency ve
  corpus kapasite limitleri.
- Revenue projection: cash collected, paid credits outstanding liability, consumed
  paid-credit revenue, promotional consumption, refund/chargeback, provider COGS,
  infrastructure COGS ve gross margin. Cash collection ile revenue recognition aynı
  metrik gibi sunulmaz.
- Billing UI: available/reserved credits, credit history, tahmini/ölçülmüş/
  faturalandırılmış ayrımı, fiyat version ve veri tazeliği. Admin görünümü cash,
  outstanding credits, recognized usage revenue, COGS ve gross margin gösterir; API
  key veya provider credential gösterilmez.
- Tek `pnpm phase4:accept` gate'i: ingestion, hybrid retrieval, MCP, delete/reindex,
  mobile/push, multi-device approval, billing webhook/quota ve responsive browser.
- Gerçek senaryo: PDF yükle -> extract/index -> agent retrieval -> citation -> mobil
  approval -> session resume -> ölçülmüş usage/cost.

#### Zorunlu kabul

- Duplicate/out-of-order webhook çift entitlement veya ücret üretmez.
- Duplicate payment webhook ikinci credit lot üretmez. Aynı reservation/settlement
  replay'i krediyi ikinci kez düşmez; hard credit shortage yeni işi fail-closed
  engeller.
- Reservation maksimum tahmini tüketimi ayırır; terminal settlement yalnız ölçülen
  retail kredi tutarını tüketir ve artanı serbest bırakır. Failed/interrupted işte
  gerçekleşmiş kullanım kaybolmaz; incomplete kullanım görünür kalır.
- Paid ve promotional kredi tüketimi ayrıdır. Cash collected, outstanding paid-credit
  liability, consumed-credit revenue, provider/infrastructure COGS ve gross margin
  aynı ledger watermark'ında deterministik reconcile edilir.
- Refund, chargeback ve expiry available balance ile revenue/liability projection'ını
  idempotent günceller; negatife düşme ve concurrent double-spend engellenir.
- Provider-reported usage ledger ile reconcile edilir; eksik terminal usage görünür
  `incomplete` kalır, sıfır uydurulmaz.
- Hard quota yeni işi fail-closed engeller; mevcut işin politikası açık ve auditlidir.
- Cross-tenant billing, corpus ve notification verisi ayrıdır.
- `pnpm phase4:accept`, `pnpm verify`, gerçek PostgreSQL, browser ve varsa opt-in gerçek
  billing/push smoke'ları geçer.

#### Teslimat commit'i

`feat: complete corpus mobile and billing beta acceptance`

#### Uygulama ve kabul adayı kanıtı

Durum: **Uygulandı / kabul bekliyor**. Bu kayıt uygulama doğrulamasıdır; bağımsız WP24
kabulü tamamlanmadan Faz 4 kapatılmaz ve WP25 aktive edilmez.

- Ticari sınır `adr-0024-billing-plan-quota-and-phase4-acceptance.md` ile
  versioned plan/entitlement/budget/quota sözleşmelerine bağlandı. Platform-managed
  provider maliyeti ile BYOK ayrıdır; gerçek provider/MoR seçimi, tax, invoice ve
  refund davranışı uygulanmış gerçek olarak sunulmaz.
- `0024_billing_plan_quota.sql`, `0025_billing_runtime_composition.sql` ve
  `0026_prepaid_credit_financial_projection.sql`;
  tenant/organization/workspace scoped billing
  customer, webhook, subscription, entitlement, budget, quota decision ve invoice
  reconciliation tablolarına normalize webhook komutu ve durable admission lease
  ekledi. Tümü composite foreign key ve forced RLS sınırındadır. Gerçek
  PostgreSQL smoke'unda cross-tenant görünürlük sıfır; duplicate webhook ek etkisi
  sıfır; out-of-order event eski state'i geri getirmedi ve stale processing restart
  recovery ile yeniden claim edildi.
- Mevcut append-only usage ledger tek kaynak olarak korundu. Provider input, cached
  input, output, reasoning token ve reported cost yanında compute millisecond,
  storage byte-millisecond, egress byte, index embedding token ve retrieval embedding
  token meter'ları; price catalog/version, currency, deterministic dedupe ve
  measured/estimated/reconciled/incomplete durumu taşır. Failed/interrupted kullanım
  korunur; eksik terminal usage sıfırlaştırılmaz.
- Turn, source upload/reindex, retrieval ve concurrency girişlerinde aynı policy
  evaluator uygulanır. Soft limit warning+audit üretir; hard limit yeni işi
  fail-closed reddeder. Başlamış turn varsayılan olarak deterministik biçimde devam
  eder; karar policy version, reason ve measurement watermark ile audit edilir.
  PostgreSQL advisory transaction lock + request-key lease iki control-plane
  instance'ında aynı decision/watermark'ın duplicate oluşmasını engeller; terminal
  event turn lease'ini idempotent bırakır.
- `main.ts`, billing repository/commercial policy, price catalog ve provider portunu
  normal bootstrap hattına bağlar. Local alpha emulator'ı yalnız explicit seçimle
  açar. Production database/provider/secret adapter eksikse fail-closed kapanır ve
  emulator'a düşmez. Gerçek main process smoke'unda billing UI snapshot'ı PostgreSQL
  repository'den okundu; subscription, budget, quota/webhook ve reconciliation
  restart sonrasında korundu.
- Billing UI plan/version, platform-managed/BYOK modu, budget tüketimi, quota kararı,
  measured/estimated/reconciled/incomplete ayrımı, currency, price version,
  freshness ve reconciliation zamanını gösterir; credential veya ham provider
  payload göstermez.
- `wp24:e2e`, ayrı WP22/WP23 harness'lerini ardışık başarı saymak yerine tek gerçek
  environment/session kurar. Evidence; `sessionId`, retrieval ve approval `runId`,
  `sourceId`, `revisionId`, `chunkId`, `approvalId`, usage dedupe key ve quota decision
  ID'yi assertion'larla bağlar. Gerçek PDF -> extraction/index -> normal session MCP
  -> citation -> command approval -> CAS -> resume -> usage/reconciliation -> billing
  görünümü geçti. Delete/reindex, failed/interrupted incomplete usage, hard turn/source
  denial, restart persistence ve billing/usage/corpus/notification/timeline
  cross-tenant sıfır görünürlük aynı harness içinde doğrulandı.
- Son birleşik E2E evidence zinciri: session
  `ses_88070e90-7680-4416-8d76-26d32207801b`; retrieval run
  `run_9fc99df4-9697-4907-af62-6187371de278`; approval run
  `run_237a91cc-9f9d-437c-89c1-1d00002e908f`; source
  `src_ff446071-2053-4137-a71e-f212194ece95`; revision
  `rev_8dee2a25-c675-41b5-a0f2-8313952a74e5`; chunk
  `chk_980c76fd1288c08a1bd068635bde7c11e0d14858177424592cf971d79c8cd70e`;
  approval `apr_238fbcb07bc3ee7bae0412af`; usage dedupe
  `usage:ses_88070e90-7680-4416-8d76-26d32207801b:019f75cf-b336-7ca3-93c7-95bb7c69a1af`;
  quota decision `qad_1960c89771115414ce17c3ab2e99b6cf`. Harness bu
  kimliklerin aynı tenant/workspace/session zincirine ait olduğunu assertion ile
  doğruladı; Codex'in turn başına ayrı run üretmesi gizlenmedi.
- `wp24:browser` aynı gerçek harness/session'ı iki browser context'inde açtı; fake WP23
  runtime kullanmadı. Citation, resolved approval, terminal cevap,
  measured/estimated/reconciled/incomplete usage, price version, currency, freshness,
  budget ve quota birlikte doğrulandı. 390x844, 768x1024 ve 1280x720 görünümde
  keyboard/screen-reader label, yatay taşma, page error ve credential/payment payload
  leak kontrolleri geçti.
- `WP24_CODEX_BIN=<codex-cli-0.144.2> pnpm phase4:accept` geçti. Kapı 164 hedefli WP24
  testini, prepaid hedefli testi, gerçek PostgreSQL/main runtime smoke'unu, unified
  E2E/browser'ı, WP22/WP23 regresyonlarını ve `pnpm verify` adımını tamamladı. `pnpm
verify`; 32 test dosyasında 319 test, typecheck, production build ve SSR HTTP smoke
  ile geçti. Container, volume,
  browser context, managed Codex config, service worker ve harness temp dosyaları
  başarı/hata cleanup yolunda temizlendi.
- Billing provider deterministic HMAC emulator'dır; gerçek billing provider
  seçilmediği/credential olmadığı için gerçek tahsilat smoke'u `not-run` durumundadır.
  Web Push emulator kullanıldı; gerçek Web Push credential olmadığı için opt-in
  smoke'u `not-run` durumundadır. Emulator sonuçları production tahsilat veya delivery
  kanıtı değildir.

#### Prepaid kredi genişletmesi — uygulandı / bağımsız kabul bekliyor

Prepaid kredi zinciri mevcut billing repository ve birleşik Faz 4 harness'i içinde
uygulandı; paralel balance veya entitlement sistemi kurulmadı. Bağımsız WP24 kabulü
henüz yapılmadığından iş paketi `Uygulandı / kabul bekliyor` durumundadır.

- Payment webhook -> paid/promotional credit lot -> derived available balance.
- Turn/source/retrieval öncesi atomic reservation -> measured usage settlement ->
  unused release; concurrent double-spend ve replay reddi.
- Completed, failed, interrupted ve incomplete run'ların aynı usage dedupe kimliğiyle
  kredi tüketimine bağlanması.
- Refund, chargeback, expiration ve admin adjustment'ın append-only ve idempotent
  işlenmesi.
- Customer credit balance/history ile admin cash, outstanding liability, consumed
  paid-credit revenue, provider/infrastructure COGS ve gross-margin görünümü.
- Cross-tenant kredi, ödeme, revenue ve margin görünürlüğünün REST, repository, RLS,
  cache ve browser katmanlarında sıfır olması.

Gerçek PostgreSQL smoke; forced RLS, immutable ledger trigger, out-of-order
chargeback→purchase, replay etkisinin sıfır olması, iki repository instance'ında
double-spend engeli ve restart projection persistence'ını doğruladı. Birleşik E2E
evidence zinciri: session `ses_848efb7e-0110-47b6-871f-32c988fb215b`; approval run
`run_83851acb-9574-4c28-bf4d-49b90a152805`; retrieval run
`run_7a6cd330-604c-450d-afa9-8a8b1fcbac0e`; usage dedupe
`runtime-usage:ses_848efb7e-0110-47b6-871f-32c988fb215b:019f7609-4e68-75d0-88a6-0d56a2f02661`;
paid lot `clot_835d4dd7c5e718e8c5f3ecb0ae8148bc`; promotional lot
`clot_59068e2753807bc20880e3d1092d4ce1`; reservation
`cres_ad1d5a472dbb0e01b0adfd16765f6b46`; settlement
`cset_4359932fcc5eebfc8a962fc758d5185d`; credit ledger watermark `clw_31` ve
financial projection `fprj_d8cfe1c124a432eb9a78d0db8f2385bb`. Harness bu kimlikleri
aynı tenant/workspace/session/run ve usage zincirine assertion ile bağladı.

İki gerçek browser context'inin aynı approval üzerindeki `Accept once` yarışı,
sleep kullanmayan kontrollü request barrier ile kararlı hale getirildi. İki decision
request'i de bariyere ulaşmadan CAS serbest bırakılmıyor; kayıp context'in butonunun
yokluğu/disabled durumu açıklayıcı assertion üretiyor. Pinli Codex `0.144.2` ile üç
ardışık `wp24:browser` koşusu geçti:

- session `ses_dcb36c9b-a5ca-41fe-8145-3214e736a2f6`, approval
  `apr_edcf04a36ba2d4a660664c4e`, resolved sequence `238` (`a=409`, `b=200`);
- session `ses_02a5c909-67d3-4731-aa61-29ab40973f8f`, approval
  `apr_109982d77e7323c5c872dc1b`, resolved sequence `248` (`a=409`, `b=200`);
- session `ses_3bbc011b-d780-440a-8447-c9a32accded2`, approval
  `apr_8f014ee5ed4b839c72f0e459`, resolved sequence `233` (`a=409`, `b=200`).

Son `phase4:accept` browser kanıtı session
`ses_6392d8a4-df8d-445e-8b50-c05300c750ea`, approval run
`run_d3503785-60c1-4f1d-be43-962beec74b56`, approval
`apr_576a4699f8fc5922a7b9985b`, resolved sequence `252`, CAS sonucu `a=200` / `b=409`,
usage dedupe
`runtime-usage:ses_6392d8a4-df8d-445e-8b50-c05300c750ea:019f768e-65a7-74b2-b8c8-d027c2129c12`,
settlement `cset_bfbcff8794d7da7aca9c91b6cd9c9b27` ve ledger watermark `clw_30`
üretti. Her iki context aynı resolved approval card'ına reconcile oldu; durable
timeline'da tam bir `approval.resolved`, bir upstream command completion, bir resumed
terminal answer ve usage dedupe başına bir billing settlement assertion ile
doğrulandı. Deterministic billing ve Web Push emulator sonuçları production
tahsilat/delivery kanıtı değildir.

#### Bağımsız kabul sonucu

Karar: **Tamamlandı**

- Uygulama commit'leri `133d547`, `be0c74f`, `dac703c` ve browser yarışını
  deterministik yapan `3dff308` birlikte kabul edildi.
- Pinli Codex `0.144.2` ile üç bağımsız ardışık `wp24:browser` koşusu geçti. Her
  koşuda iki browser context'i kontrollü barrier'a ulaştı; CAS sonucu tam bir `200`
  ve bir `409`, durable timeline'da tek resolution/upstream completion ve usage
  dedupe başına tek billing settlement oldu.
- `WP24_CODEX_BIN=<codex-cli-0.144.2> pnpm phase4:accept`; 164 hedefli WP24 testi,
  10 prepaid testi, gerçek PostgreSQL/forced-RLS smoke'u, birleşik runtime/browser
  E2E, WP22/WP23 regresyonları ve repo-wide verify ile geçti.
- Repo-wide doğrulamada 32 test dosyasında 319 test, typecheck, production build ve
  SSR HTTP smoke geçti. PostgreSQL container/volume, browser context, managed Codex
  config, service worker ve geçici dosya cleanup'ı doğrulandı.
- Billing ve Web Push emulator sonuçları production tahsilat veya delivery kanıtı
  sayılmadı; gerçek credential gerektiren kanıtlar açıkça `not-run` kaldı.

WP24 tamamlandı. WP25 tek aktif iş paketidir; Faz 4, WP25 bağımsız kabul edilmeden
kapatılamaz.

### WP25 — Paylaşımlı klasör, güvenli ortak çalışma ve Faz 4 kabulü

Durum: **Tamamlandı**. WP25 bağımsız kabul edildi ve Faz 4 kapatıldı.

#### Hedef

Bir kullanıcının bir klasörü arkadaşına davet yoluyla paylaşabildiği; iki kullanıcının
yalnız bu klasöre bağlı kaynak, konuşma, attachment/artifact ve agent görevlerini rol
sınırları içinde birlikte kullanabildiği güvenli consumer collaboration akışını
tamamlamak.

#### Kapsam

- ADR: folder resource modeli, tenant/workspace/folder sınırı, ACL inheritance,
  ownership transfer, invitation güvenliği ve revoke sonrası cache/realtime davranışı.
- Versioned `folder`, `folder_membership` ve `folder_invitation` sözleşmeleri; her
  kayıtta açık tenant, workspace, folder ve principal scope'u.
- Klasörler varsayılan private olur. `owner`, `editor` ve `viewer` rolleri; davet için
  pending, accepted, expired ve revoked durumları tanımlanır. Ownership transfer ve
  son owner koruması açık bir state machine ile uygulanır.
- Davetler tahmin edilemez, süreli, tek kullanımlık token ile yapılır; yalnız digest
  saklanır. Token, URL, log, event ve telemetry tenant/source adı, secret veya içerik
  taşımaz. Kabul işlemi idempotenttir ve authenticated principal'a bağlanır.
- Conversation, source, attachment/artifact ve agent task'ı klasöre atanabilir.
  Folder ACL; REST, realtime/replay, retrieval/index, workspace-local MCP, object
  storage, cache ve browser yüzeylerinin tümünde kaynak okunmadan önce uygulanır.
- Viewer yalnız okuyabilir; editor klasör içinde kaynak/conversation/task oluşturup
  agent çalıştırabilir; owner üye ve rol yönetebilir. Move, role change ve revoke
  işlemleri authorization cache'lerini geçersiz kılar ve yeni erişimde fail-closed olur.
- Ortak kullanım; paylaşılan geçmişi görme, aynı klasörde agent görevi başlatma,
  sonucu/realtime durumunu izleme ve yetkili approval verme anlamına gelir. İlk sürüm
  aynı dosya içeriğini Google Docs benzeri eşzamanlı düzenlemeyi kapsamaz.
- Tek workspace'te tek aktif turn, idempotency ve optimistic-locking değişmezleri
  korunur. İki kullanıcının eşzamanlı turn/approval yarışında duplicate upstream iş
  veya çift ücret oluşmaz.
- Invite create/accept/revoke, role change, ownership transfer, resource move ve
  yetkili export işlemleri immutable audit'e yazılır; içerik ve secret audit'e girmez.
- Responsive/PWA UI; klasör oluşturma, paylaşma, davet kabulü, üye/rol yönetimi ve
  erişimi kaybeden kullanıcı için güvenli geri dönüş durumlarını içerir.
- Tek `pnpm phase4:accept` gate'i WP21–WP25 ingestion, retrieval/MCP, mobile/PWA,
  billing/prepaid kredi ve paylaşımlı klasör kanıtlarını temiz bir ortamda birlikte
  çalıştırır.

#### Zorunlu kabul

- İki bağımsız hesapla owner klasörü paylaşır, arkadaş daveti kabul eder ve yalnız
  paylaşılan klasörü; ona bağlı konuşma, kaynak ve task geçmişini görür.
- Viewer mutation/turn/approval yapamaz; editor klasör içinde çalışabilir fakat kardeş
  private klasörlere veya workspace'in paylaşılmamış köküne erişemez.
- Cross-tenant kimlik, tahmin edilen ID, replay edilen veya süresi dolmuş davet ve
  revoke edilmiş üyelik REST, realtime, retrieval/MCP, object ve cache katmanlarında
  fail-closed reddedilir.
- Resource move, role change ve revoke; açık browser/realtime session'ı dahil sonraki
  erişimlerde deterministik uygulanır ve eski cache/search sonucu veri sızdırmaz.
- Eşzamanlı ortak task/approval yarışı tek kazanan ve tek billing settlement üretir;
  her iki kullanıcı aynı durable timeline sonucunu replay ile görür.
- Gerçek PostgreSQL forced-RLS/adversarial testleri ve 390x844, 768x1024, 1280x720
  browser E2E geçer; kullanıcı A'nın private verisi kullanıcı B'ye hiçbir yüzeyde
  görünmez.
- `pnpm phase4:accept` WP21–WP25'in tüm zorunlu kapılarını geçer; eksik gerçek
  credential/provider kanıtı açıkça `not-run` kalır ve emulator sonucu production
  kanıtı sayılmaz.

#### Teslimat commit'i

`feat: add secure shared-folder collaboration`

#### Bağımsız kabul sonucu

Karar: **Tamamlandı**

- Uygulama ve hardening commit'leri `5b4a026`, `e47f1f9` ve `93185a3` birlikte
  contract, PostgreSQL/RLS, runtime lifecycle, billing ve browser zincirini tamamladı.
- Durable PostgreSQL adapter production `main.ts` composition'ına bağlandı; eksik
  production repository fail-closed olur. Forced RLS, invitation replay/expiry/revoke,
  ownership yarışı, restart persistence, resource move ve cross-instance access
  invalidation testleri geçti.
- Pinli Codex `0.144.2` ile iki authenticated principal aynı shared session'da tek
  gerçek `runId/codexTurnId` üretti. Citation'lı MCP retrieval, attachment, artifact,
  approval `200/409`, usage dedupe, credit reservation ve gerçek billing settlement
  aynı durable task zincirinde doğrulandı.
- Viewer reddi, editor ortak task'ı, private sibling izolasyonu, stale artifact grant
  reddi, interrupted/start-failed/admission-denied lifecycle ve realtime revoke geçti.
- İki browser context'inde invite→viewer→editor, ortak task/approval, erişim kaybı ve
  390x844, 768x1024, 1280x720 görünümleri yatay taşma veya page error olmadan geçti.
- `WP25_CODEX_BIN=<codex-cli-0.144.2> pnpm phase4:accept`, WP21–WP25'in bütün zorunlu
  kapılarını tamamladı. Repo-wide verify 34 test dosyasında 327 test, typecheck,
  production build ve SSR HTTP smoke ile geçti; geçici kaynak cleanup'ı doğrulandı.
- Billing ve Web Push emulator sonuçları production tahsilat/delivery kanıtı sayılmadı;
  gerçek credential gerektiren kontroller açıkça `not-run` kaldı.

WP25 ve Faz 4 tamamlandı. WP26 Faz 5'in tek aktif iş paketidir.

## 4. Faz 4 exit kriteri — sağlandı

Tenant kullanıcısı PDF veya workspace kaynağını ekleyebilir; kaynak güvenli ve durable
şekilde çıkarılıp indekslenir; agent yalnız yetkili corpus'tan citation'lı retrieval
yapar. Kaynak silme/reindex sonuçlara deterministik yansır. Kullanıcı telefondan güvenli
approval verip session'ı sürdürebilir. Kullanım ve ticari entitlement aynı append-only
ledger ile reconciliation'a girer. Kullanıcı bir klasörü arkadaşına güvenli davetle
paylaşabilir; iki kullanıcı yalnız yetkili klasör kapsamındaki kaynak, conversation ve
agent görevlerini rol sınırları içinde birlikte kullanabilir.

## 5. Faz 5 — Production hardening

### WP26 — HA production topology, scheduler ve kapasite izolasyonu

#### Hedef

Tek-node/geliştirme bağımlılıklarını kaldırıp control plane ve workspace data plane'i
yatay ölçeklenebilir, tenant-fair ve arızaya dayanıklı production topolojisine taşımak.

#### Kapsam

- ADR: başlangıç multi-region modeli; önerilen dar başlangıç active/passive control
  plane ve region-pinned workspace, ölçüm olmadan active/active iddiası yoktur.
- Stateless/horizontally scalable API ve realtime gateway; PostgreSQL HA, object
  storage, cache/lock ve durable event broker sınırları.
- SQLite/local filesystem production fallback'lerini fail-closed kapat; online migration
  ve rollback stratejisi.
- Workspace scheduler: tenant plan kotası, fair queue, per-workspace tek aktif turn,
  global provider limitleri ve admission control.
- cgroup CPU/memory/pids/io, disk/inode/IOPS, egress bandwidth, event byte/s ve index
  kapasite limitleri; noisy-neighbor testleri.
- Regional placement, capacity drain, runtime reschedule ve maintenance mode.

#### Zorunlu kabul

- API/gateway instance kaybında durable run ve realtime replay kaybolmaz.
- Tenant A yükü Tenant B latency/queue/capacity sınırını belirlenen bütçenin dışında
  bozamaz.
- Scheduler duplicate workspace turn başlatmaz; crash/lease expiry güvenli recovery
  üretir.
- Region/node drain sırasında kabul edilen RPO/RTO hedefi korunur.
- Production dependency readiness yoksa servis fail-closed olur.

#### Teslimat commit'i

`feat: add highly available tenant-fair production topology`

#### Bağımsız kabul sonucu

Karar: **Tamamlandı**

- Uygulama commit'leri `ffa8032` ve `b12957e` kabul edildi.
- Gerçek PostgreSQL, RabbitMQ, MinIO ve Vault bağımlılıklarıyla iki API/realtime ve
  iki scheduler process'i çalıştırıldı. API ve scheduler kaybında durable replay,
  approval context, node drain ve fencing recovery korundu.
- Scheduler recovery RPO değeri `0 ms`, ölçülen RTO değeri `14.306 sn` oldu. Eski
  fencing token ile yazma reddedildi; aynı run için tek Codex turn başlatıldı.
- İki tenant'lı live fairness, provider/workspace concurrency, bounded retry ve
  poison davranışı gerçek Codex `0.144.2` runtime'ıyla geçti.
- Gerçek Linux cgroup v2 üzerinde CPU, memory/OOM, pids, IO/IOPS, disk byte/inode ve
  default-deny egress sınırları doğrulandı. Event/output/artifact/index kapasite
  ihlalleri durable ve tenant-scoped biçimde reddedildi.
- PostgreSQL, broker, object storage, runtime-control ve KMS kaybında yeni admission
  `503` ile fail-closed oldu; committed replay restore sonrasında korundu.
- `wp26:accept` bütün zorunlu kapıları `accepted:true` ve
  `productionHaEvidence:true` ile tamamladı. Repo genelinde format, typecheck, 345
  test, build ve SSR HTTP smoke geçti; geçici container ve volume kalmadı.

WP26 tamamlandı. WP27 Faz 5'in tek aktif iş paketidir.

### WP27 — Observability, SLO, backup/restore ve DR

#### Hedef

Sistemin kullanıcı etkisini ölçülebilir hale getirmek; backup, restore ve region kaybı
senaryolarını belgeli RPO/RTO ile tekrarlanabilir kılmak.

#### Kapsam

- OpenTelemetry trace/metric/log correlation; tenant kimliği opaque, prompt/output ve
  secret telemetry dışında.
- SLI/SLO: API availability, turn start latency, event lag, reconnect recovery,
  approval latency, queue wait, indexing freshness ve restore başarısı.
- Dashboard, burn-rate alert, paging, ownership ve runbook linkleri.
- PostgreSQL PITR, object/index backup, encrypted key metadata ve config backup.
- Restore order, consistency watermark, tenant/context validation ve index rebuild.
- Region outage/failover, event broker loss, cache loss, corrupt backup ve key
  unavailability game day'leri.
- Düzenli otomatik DR tatbikatı ve immutable evidence raporu.

#### Zorunlu kabul

- Belirlenen RPO/RTO içinde bağımsız restore ve region failover tatbikatı geçer.
- Restore sonrası cross-tenant karışma, duplicate turn veya audit-chain kopması yoktur.
- SLO alertleri kontrollü failure injection ile tetiklenir ve recovery sonrası kapanır.
- Telemetry secret/PII corpus taramasından geçer.

#### Teslimat commit'i

`feat: add production observability and disaster recovery`

#### Bağımsız kabul sonucu

Karar: **Tamamlandı**

- Uygulama ve gerçek DR düzeltme commit'leri `229c91d` ve `c40d655` kabul edildi.
- Continuous WAL archive kullanan gerçek PostgreSQL PITR hedef timestamp/LSN'e açıldı;
  hedef sonrası veri dışarıda kaldı. Son bağımsız koşuda RPO `1.217 sn`, RTO
  `2.047 sn` ölçüldü.
- PostgreSQL, MinIO, RabbitMQ, Vault ve derived index ayrı target namespace'e doğru
  sırada restore edildi. Tenant/RLS, event gap, duplicate runtime, checksum, eksik ve
  bozuk component ile unavailable key kontrolleri geçti; restore RTO `2.145 sn` oldu.
- Gerçek WP26 stack üzerinde RabbitMQ, MinIO, Vault ve Redis failure injection'ları;
  active/passive API-scheduler failover'u çalıştırıldı. Region failover RPO `0 ms`,
  RTO `1.119 sn`; stale fence ve duplicate runtime reddi doğrulandı.
- Prometheus dört gerçek alert rule'unu yükledi; burn-rate, restore ve region-budget
  failure injection'ları `firing`, recovery sonrasında `inactive` oldu.
- Pinli Codex `0.144.2` ile gerçek turn API→scheduler→Workspace Agent→Codex→event→
  broker/replay trace zincirini taşıdı. Collector kaybında ürün devam etti, bounded
  drop metriği oluştu ve secret/prompt/output/PII/corpus marker sızıntısı bulunmadı.
- `wp27:accept` `accepted:true`, gerçek evidence hash zinciri ve checksum ile geçti.
  Repo genelinde format, typecheck, 355 test, build ve SSR HTTP smoke tamamlandı;
  geçici WP27 container/volume/process kalmadı.
- External paging, managed cross-region replication, production KMS revocation ve
  cloud object replication credential/ortam yokluğu nedeniyle açıkça `not-run` kaldı.

WP27 tamamlandı. WP28 Faz 5'in tek aktif iş paketidir.

### WP28 — Enterprise identity ve veri lifecycle

#### Hedef

Enterprise tenant onboarding/offboarding, kimlik provisioning ve yasal veri yaşam
döngüsünü tenant izolasyonu ve crypto-erasure garantileriyle tamamlamak.

#### Kapsam

- Enterprise OIDC/SAML federation yönü için ADR; SCIM user/group provisioning,
  deprovision ve role mapping.
- Domain verification, enforced SSO, MFA policy ve emergency recovery account.
- Retention policy: event/raw/audit/source/artifact/backup sınıfları, legal hold ve
  plan bazlı süreler.
- Tenant-scoped export manifest, checksum, encryption ve resumable download.
- Delete/offboarding state machine: access revoke, job drain, search purge, object
  delete, backup expiry ve KMS crypto-erasure.
- Region/data-residency placement ve cross-region transfer audit'i.
- DSAR/admin workflow; normal support grant veri export yetkisine dönüşmez.

#### Zorunlu kabul

- SCIM duplicate/out-of-order event idempotent; deprovision aktif session/lease'i keser.
- Export yalnız talep eden tenant scope'unu içerir ve bütünlük doğrulanır.
- Delete sonrası primary/cache/index/object erişimi kapanır; backup/legal-hold istisnası
  açıkça raporlanır ve sonunda doğrulanır.
- Region policy ihlali fail-closed ve auditlidir.

#### Teslimat commit'i

`feat: add enterprise identity and tenant data lifecycle`

#### Bağımsız kabul sonucu

Karar: **Tamamlandı**

- Uygulama ve entegrasyon düzeltme commit'leri `dd225ff` ve `13cd5cf` kabul edildi.
- Keycloak `26.3.2` ile gerçek OIDC authorization-code/PKCE, JWKS rotation ve SAML
  AuthnRequest/signed response/ACS akışları geçti; replay, audience, expiry, clock-skew
  ve MFA assurance kontrolleri doğrulandı.
- Üç API instance'ı aynı PostgreSQL SCIM authority'sini kullandı. Restart persistence,
  concurrent duplicate, out-of-order event, credential digest, group-role mapping ve
  cross-tenant membership reddi geçti.
- Retention/legal-hold worker dokuz veri sınıfında bounded, leased/fenced ve restart-safe
  çalıştı. Hold release sonrası purge devam etti; stale policy CAS ve erken silme
  reddedildi.
- PostgreSQL/MinIO/Vault tenant export'u checkpoint'ten devam etti; duplicate archive
  oluşmadı. Encrypted manifest, range download, expiring grant, cross-tenant ret ve
  support `403` doğrulandı.
- Durable offboarding 11 adımı crash/restart ile tamamladı; backup expiry sonrası
  crypto-erasure eski ciphertext restore'unu reddetti ve diğer tenant korundu.
- Scheduler, MinIO, index ve export residency adapter'ları yasak region yollarını
  fail-closed reddetti; izinli transfer audit'i source/destination/byte count taşıdı.
- Gerçek Codex `0.144.2` turn'ü sırasında deprovision durable session/lease/run ve
  yetki state'lerini kapattı; turn/upload/export/share admission'ları `403` oldu.
- Chromium kabulü üç viewport'ta canlı web/API, support `403`, re-auth `401`, stale
  version `409` ve range download `206` akışlarını geçti.
- `wp28:accept` gerçek servislerle `accepted:true` verdi; scanner 21 kaynakta sıfır
  bulgu ve cleanup sıfır kaynak doğruladı. Repo genelinde 362 test, typecheck, build
  ve SSR HTTP smoke geçti.

WP28 tamamlandı. WP29 Faz 5'in tek aktif iş paketidir.

### WP29 — Supply-chain, provider canary ve compliance hazırlığı

#### Hedef

Kod, image, migration ve provider runtime değişikliklerini provenance, canary ve hızlı
rollback ile güvenli hale getirmek; SOC 2/ISO 27001 hazırlık kanıtlarını otomatik
kontrollere bağlamak.

#### Kapsam

- Reproducible build, dependency lock, SBOM, signed image/artifact, provenance ve
  vulnerability/license scan.
- Secret scan, SAST, IaC/policy scan, migration lint ve destructive-change gate'i.
- Codex/Claude/Gemini/Cursor version discovery; generated schema/capability drift
  canary, golden replay ve unknown-event rate alarmı.
- Staged provider/runtime rollout, cohort, kill switch, automatic rollback ve version
  compatibility matrix.
- Database expand/contract migration ve rollback rehearsal.
- SOC 2/ISO 27001 control mapping: access review, change management, incident,
  vulnerability, backup/DR, logging ve vendor evidence.
- Release evidence bundle ve immutable approval record.

#### Zorunlu kabul

- Bozuk provider/schema ve vulnerable image canary'de production cohort'a ulaşmadan
  durur.
- Rollback conversation, event ve migration verisini kaybetmez.
- Release yalnız imzalı/provenance doğrulanmış artifact ile ilerler.
- Compliance evidence gerçek otomasyon çıktısına bağlıdır; elle yazılmış başarı beyanı
  kabul edilmez.

#### Teslimat commit'i

`feat: secure the release supply chain and provider upgrades`

### WP30 — Pentest, performance ve kontrollü production rollout kabulü

#### Hedef

Faz 0–5'in bütün kritik akışlarını bağımsız güvenlik, performans, chaos ve operasyon
kanıtlarıyla kapatmak; sınırlı cohort'tan production rollout'a geri alınabilir biçimde
geçmek.

#### Kapsam

- Bağımsız tenant-boundary ve agent/tool prompt-injection pentest; bulgu SLA ve retest.
- Load/soak: API, realtime fanout, event lag, scheduler, provider rate, corpus ingest,
  retrieval, object streaming ve mobile reconnect.
- Chaos: API/worker/node/region/broker/cache/DB replica/provider/KMS/push/billing
  failure; bounded degradation ve recovery.
- Security incident ve break-glass game day; on-call, notification ve postmortem.
- Tek `pnpm production:accept` orchestrator'ı; Faz 1–4 gates, production Kata/KMS,
  HA/DR, SLO, lifecycle, canary ve rollout preflight kanıtlarını toplar.
- Internal -> design partner -> limited beta -> production cohort rollout; feature
  flag, halt, rollback ve success/error budget kriterleri.
- Launch checklist, known limitations, ownership ve go/no-go kaydı.

#### Zorunlu kabul

- Kritik/yüksek pentest bulgusu açık kalmaz; düzeltmeler bağımsız retest edilir.
- Hedef yükte SLO ve tenant fairness bütçeleri sağlanır; soak boyunca leak/backlog yoktur.
- Region/provider/KMS arızası veri karışması veya kontrolsüz duplicate iş üretmez.
- Rollout halt ve rollback gerçek cohort üzerinde prova edilir.
- `pnpm production:accept` ve production browser/mobile golden senaryoları geçer;
  cleanup ve maliyetli geçici kaynak envanteri temizdir.

#### Teslimat commit'i

`feat: complete production readiness and controlled rollout`

## 6. Faz 5 exit kriteri

Ürün belgelenmiş SLO, RPO/RTO ve kapasite hedeflerinde tenant-fair çalışır; node/region
ve bağımlılık arızalarından veri karışması olmadan kurtulur. Enterprise identity ve veri
lifecycle politikaları uygulanır. Release artifact'leri doğrulanabilir provenance ve
canary ile dağıtılır. Bağımsız pentest, load/soak/chaos ve rollback kanıtlarıyla
kontrollü production rollout tamamlanır.

## 7. Faz geçiş kuralları

- Her paketin uygulama commit'i ayrı olmalı; bağımsız kabul task'ı tamamlanmadan sıradaki
  paket aktif edilmez.
- Gerçek provider, billing, push, Kata/KMS, multi-region veya pentest kanıtı yoksa mock
  sonucu production kanıtı gibi raporlanmaz.
- Yeni contract; schema, migration, RLS/ACL, service, client ve test zinciriyle birlikte
  teslim edilir.
- Secret, API key, push token, billing credential, source içeriği veya decrypted tenant
  verisi fixture, log, trace ve kabul raporuna yazılmaz.
- Faz 4 WP25; Faz 5 WP30 bağımsız kabul edilmeden ilgili faz kapanmaz.
