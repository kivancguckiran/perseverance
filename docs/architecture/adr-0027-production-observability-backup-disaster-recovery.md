# ADR-0027 — Production observability, backup/restore ve disaster recovery

- Durum: Kabul edildi
- Tarih: 2026-07-20
- Kapsam: WP27

## Bağlam

ADR-0026 tek active region, warm passive region, PostgreSQL authority, durable broker,
versioned object storage, KMS ve fenced Workspace Agent topolojisini kurdu. Bu topoloji
ölçülebilir kullanıcı etkisi, içerik sızdırmayan telemetry, bağımsız restore ve gerçek
failure rehearsal olmadan production recovery garantisi vermez.

## Karar

### OpenTelemetry mimarisi ve veri sınırı

API/realtime girişinde W3C `traceparent` doğrulanır veya yeni trace üretilir. Trace ID
durable run/queue kaydında korunur ve scheduler claim, Workspace Agent runtime, gerçek
Codex turn, event append/outbox/broker/replay, approval ve index akışlarının parent
bağıdır. Metric exemplar ve structured log aynı trace/span ID'yi taşır. Collector OTLP
HTTP/gRPC kabul eder; batch processor sonrasında ayrı trace, metric ve log backend'ine
gönderir. Collector veya backend kaybı ürün authority'sini ve admission kararını
değiştirmez; bounded buffer dolar ise telemetry drop metriği üretilir.

Tenant ve workspace yalnız deployment-secret salt ile irreversible SHA-256 değer
olarak taşınabilir. Route, operation, outcome, error code, bounded event type, region,
service ve provider allowlist dışındaki attribute reddedilir. Prompt, model output,
reasoning, command/diff, source/corpus metni, attachment/filename, email/PII, secret,
API key, bearer token ve decrypted tenant içeriği trace, metric, log, label veya
evidence'a yazılmaz. Unknown event yalnız `codex.unknown`, bounded family ve error code
ile ölçülür; raw envelope telemetry'ye girmez.

### SLI/SLO ve error budget

28 günlük rolling production hedefleri:

| SLI                    |                                                 Hedef |
| ---------------------- | ----------------------------------------------------: |
| API availability       |                            ≥ %99,9 successful/non-5xx |
| API error rate         |                                            ≤ %0,1 5xx |
| Turn admission latency |                                          p95 ≤ 500 ms |
| Turn start latency     |                                           p95 ≤ 30 sn |
| Scheduler queue wait   |                                           p95 ≤ 15 sn |
| Lease recovery         |                                           p99 ≤ 60 sn |
| Broker/replay lag      |                              p99 ≤ 5 sn / ≤ 100 event |
| Reconnect recovery     |                                            p95 ≤ 5 sn |
| Approval latency       | p95 ≤ 15 dk; kullanıcı bekleme süresi ayrı raporlanır |
| Indexing freshness     |                                            p95 ≤ 5 dk |
| Backup success         |                 ≥ %99; ardışık günlük başarılı backup |
| Restore success        |                         %100 scheduled isolated drill |

Operation hedefleri: metadata/event/approval/queue ve acknowledged object RPO `0`;
active runtime son durable checkpoint RPO `≤5 sn`; PostgreSQL PITR restore RPO `≤5 dk`;
isolated restore RTO `≤15 dk`; active/passive region failover RPO `≤5 dk`, RTO
`≤30 dk`. RPO source watermark ile target doğrulanmış watermark arasındaki zaman/veri
farkı; RTO failure injection ile readiness + admission + replay consistency'nin
yeniden sağlanması arasındaki monotonic süredir.

Availability için 1 saat/5 dakika 14,4x ve 6 saat/30 dakika 6x burn birlikte paging;
12 saat/2 saat 3x ve 3 gün/6 saat 1x ticket üretir. Alert owner, severity ve repository
runbook URL'si taşır. Recovery pencerelerinin ikisi de eşik altına düşünce alert
otomatik kapanır.

### Backup authority, watermark ve immutable manifest

Backup authority active PostgreSQL primary'dir. Backup transaction'ı PostgreSQL LSN,
event high-water, object version watermark ve capture zamanını tek consistency
watermark olarak sabitler. Sıralı içerik: PostgreSQL base backup, continuous WAL/PITR,
wrapped encryption-key metadata, versioned attachment/artifact/source objects, durable
broker watermark/state, deterministic derived-index rebuild manifesti ve secret
içermeyen versioned configuration'dır.

Her backup append-only/immutable manifest taşır: schema version, region, zaman,
watermark, her component için SHA-256/byte length/key version, PostgreSQL/Codex/schema/
index/config dependency sürümleri ve önceki manifest hash'i. Backup credential ve
plaintext tenant içeriği manifest/evidence/log'a girmez. Backup writer restore
authority değildir; isolated restore verifier ayrı workload identity kullanır.

### Restore sırası ve fail-closed doğrulama

Restore yalnız temiz, ayrı network/storage/KMS namespace'li target topology'ye şu
sırayla yapılır: `PostgreSQL → key metadata → objects → event broker → derived index`.
Önce manifest/hash zinciri ve tüm required checksum'lar, sonra key erişilebilirliği,
sonra watermark doğrulanır. Tenant→organization→workspace→session→run ilişkileri,
unique idempotency/run/runtime-start, gapless session sequence, object references ve
audit hash-chain kontrol edilir. Index snapshot eksik veya uyumsuzsa raw encrypted
source revision + versioned parser/chunker/embedding/ranking manifestinden deterministik
rebuild edilir.

Cross-tenant karışma, duplicate turn/runtime-start, missing event, object/checksum
farkı, watermark gerilemesi veya audit-chain kopması admission açılmadan restore'u
reddeder. Corrupt/incomplete backup `BACKUP_COMPONENT_CORRUPT|MISSING`; unavailable,
revoked veya yanlış-version key `RESTORE_KEY_UNAVAILABLE` ile fail-closed durur. Başka
key deneme, plaintext fallback veya eksik component ile devam yoktur.

### Active/passive region failover

Model single-writer active/passive'tir. Failover coordinator eski region authority'sini
fence edip admission'ı kapatır; PostgreSQL replica/PITR watermark'ını, broker/object/KMS
readiness ve contract compatibility'yi doğrular; ardından passive region'ı atomik
epoch/fencing artışıyla active yapar. Split-brain şüphesinde iki region da write
admission açmaz. Stale lease ve eski fencing token tüm runtime-start/event/approval
side effect'lerinde reddedilir. Cache kaybı correctness'i etkilemez. Region promotion
sonrası replay, tenant graph, event gap, duplicate runtime-start ve audit chain yeniden
kontrol edilmeden başarı raporlanmaz.

### Game day, evidence ve schedule

Active API/scheduler/region, PostgreSQL PITR, broker, cache, object storage, corrupt
backup, KMS unavailability, stale lease ve duplicate runtime-start senaryoları aynı
harness'te failure injection → kullanıcı etkisi → recovery → integrity kontrolü
izler. RPO/RTO ölçümleri ve scenario sonucu önceki evidence hash'ine bağlı immutable
JSON olarak saklanır. Haftalık isolated restore, aylık region failover çalışır;
retention 400 gündür. Failure on-call paging ve DR owner bildirimi üretir. Her koşum
geçici process/container/volume/credential envanterini sıfıra indiren cleanup gate'iyle
biter.

## Sonuçlar ve sınırlar

WP27 repository harness'i ve yerel gerçek servis tatbikatı, cloud sağlayıcısının
managed multi-AZ durability, cross-region replication gecikmesi, production KMS SLA,
network partition davranışı veya on-call teslimatını kanıtlamaz. Bu varsayımlar rollout
öncesi environment-specific evidence ister. WP28 enterprise lifecycle ve WP29
supply-chain bu kararla aktive edilmez.
