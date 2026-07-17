# Faz 4 Corpus ve mobil ürün, Faz 5 Production hardening planı

- Plan durumu: Aktif
- Plan tarihi: 17 Temmuz 2026
- Aktif iş paketi: WP21 (Uygulandı / kabul bekliyor)
- Ön koşul: WP0–WP20 ve Faz 3 tamamlandı
- Kaynak spesifikasyon:
  `docs/architecture/persistent-codex-workspace-tasarim-spesifikasyonu.md`

## 1. Amaç ve numaralandırma

Ana ürün spesifikasyonundaki Corpus ve mobil ürün kilometre taşı, araya eklenen
Provider Platform ve Multi-tenant Security Beta fazlarından sonra bu planda Faz 4
olarak; Production hardening ise Faz 5 olarak numaralandırılır.

Faz 4, tenant-aware kaynak alma ve retrieval katmanını gerçek agent çalışmasına
kaynaklı bağlam olarak ekler; mobil/PWA approval-resume deneyimini ve ticari plan/kota
akışını tamamlar. Faz 5, kabul edilmiş ürün sınırlarını yüksek erişilebilirlik,
felaket kurtarma, kapasite, enterprise lifecycle, supply-chain güvenliği ve kontrollü
production rollout seviyesine taşır.

## 2. İş paketi özeti

| Paket | Faz | Durum                      | Hedef                                                                    |
| ----- | --- | -------------------------- | ------------------------------------------------------------------------ |
| WP21  | 4   | Uygulandı / kabul bekliyor | Tenant-aware source registry, extraction, chunk ve derived index temeli  |
| WP22  | 4   | Planlandı                  | Hybrid retrieval, citation, watcher/reindex ve workspace-local MCP       |
| WP23  | 4   | Planlandı                  | Mobil/PWA approval, push notification ve çoklu cihaz sürekliliği         |
| WP24  | 4   | Planlandı                  | Billing/plan/kota entegrasyonu ve birleşik Faz 4 ürün kabulü             |
| WP25  | 5   | Planlandı                  | HA production topology, multi-region yönü, scheduler ve kapasite sınırı  |
| WP26  | 5   | Planlandı                  | Observability/SLO, backup/restore, DR ve region-failover tatbikatı       |
| WP27  | 5   | Planlandı                  | Enterprise SSO/SCIM, retention/export/delete ve data-residency lifecycle |
| WP28  | 5   | Planlandı                  | Supply-chain, provider canary, güvenli upgrade ve compliance kontrolleri |
| WP29  | 5   | Planlandı                  | Pentest, load/soak/chaos ve kontrollü production rollout kabulü          |

Her zaman yalnız bir iş paketi aktif olabilir. WP21 kabul edilmeden WP22; Faz 4
tamamlanmadan WP25; WP28 tamamlanmadan nihai WP29 aktive edilmez.

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

### WP23 — Mobil/PWA approval, push ve çoklu cihaz sürekliliği

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

### WP24 — Billing, plan/kota ve Faz 4 birleşik kabul

#### Hedef

Provider, compute, storage, egress ve corpus kullanımını ticari plan/kota politikasıyla
birleştirmek; Faz 4'ü PDF'den citation'lı agent cevabına ve mobil approval'a kadar
uçtan uca kapatmak.

#### Kapsam

- ADR ile billing provider, merchant-of-record ve platform-managed/BYOK ücret ayrımı.
- Plan, entitlement, budget, quota, invoice reconciliation ve webhook event
  sözleşmeleri; webhook signature, replay ve idempotency.
- Mevcut append-only usage ledger'da provider token/cost, compute, storage, egress ve
  embedding meter'ları; failed/interrupted task kullanımını koru.
- Soft warning, hard limit ve in-flight turn politikası; tenant/session concurrency ve
  corpus kapasite limitleri.
- Billing UI: tahmini/ölçülmüş/faturalandırılmış ayrımı, fiyat version ve veri tazeliği;
  API key veya provider credential gösterilmez.
- Tek `pnpm phase4:accept` gate'i: ingestion, hybrid retrieval, MCP, delete/reindex,
  mobile/push, multi-device approval, billing webhook/quota ve responsive browser.
- Gerçek senaryo: PDF yükle -> extract/index -> agent retrieval -> citation -> mobil
  approval -> session resume -> ölçülmüş usage/cost.

#### Zorunlu kabul

- Duplicate/out-of-order webhook çift entitlement veya ücret üretmez.
- Provider-reported usage ledger ile reconcile edilir; eksik terminal usage görünür
  `incomplete` kalır, sıfır uydurulmaz.
- Hard quota yeni işi fail-closed engeller; mevcut işin politikası açık ve auditlidir.
- Cross-tenant billing, corpus ve notification verisi ayrıdır.
- `pnpm phase4:accept`, `pnpm verify`, gerçek PostgreSQL, browser ve varsa opt-in gerçek
  billing/push smoke'ları geçer.

#### Teslimat commit'i

`feat: complete corpus mobile and billing beta acceptance`

## 4. Faz 4 exit kriteri

Tenant kullanıcısı PDF veya workspace kaynağını ekleyebilir; kaynak güvenli ve durable
şekilde çıkarılıp indekslenir; agent yalnız yetkili corpus'tan citation'lı retrieval
yapar. Kaynak silme/reindex sonuçlara deterministik yansır. Kullanıcı telefondan güvenli
approval verip session'ı sürdürebilir. Kullanım ve ticari entitlement aynı append-only
ledger ile reconciliation'a girer.

## 5. Faz 5 — Production hardening

### WP25 — HA production topology, scheduler ve kapasite izolasyonu

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

### WP26 — Observability, SLO, backup/restore ve DR

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

### WP27 — Enterprise identity ve veri lifecycle

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

### WP28 — Supply-chain, provider canary ve compliance hazırlığı

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

### WP29 — Pentest, performance ve kontrollü production rollout kabulü

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
- Faz 4 WP24; Faz 5 WP29 bağımsız kabul edilmeden ilgili faz kapanmaz.
