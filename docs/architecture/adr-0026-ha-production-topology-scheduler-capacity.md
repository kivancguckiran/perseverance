# ADR-0026 — HA production topology, scheduler ve kapasite izolasyonu

- Durum: Kabul edildi
- Tarih: 2026-07-19
- Kapsam: WP26

## Bağlam

Faz 0–4 control plane'i tek process, SQLite event store, process-local aktif-turn
kilidi ve local filesystem artifact/source yüzeyleriyle doğrulandı. Bunlar development
ve kabul harness'i için uygundur; API instance kaybı, scheduler yarışı, node drain veya
noisy-neighbor durumunda production doğruluk ve erişilebilirlik sınırı olamaz.

Bu ADR production topolojisinin ilk, ölçülebilir basamağını tanımlar. Active/active
multi-region yazma veya ölçülmemiş cross-region consistency iddiası yapmaz.

## Karar

### Topoloji ve authority sınırı

Control plane başlangıçta tek active region ve warm passive region ile çalışır. API ve
realtime gateway stateless ve active region içinde yatay ölçeklenebilir. Load balancer
instance health'e göre yönlendirir; durable session/run/event/approval/high-water,
scheduler queue/lease/placement/reservation/recovery ve billing state PostgreSQL'dedir.
Object body'leri versioned object storage'da, fanout ve invalidation durable event
broker'dadır. Cache yalnız hızlandırıcıdır; cache veya distributed-lock servisi kaybı
PostgreSQL'deki CAS/fencing kararını değiştiremez.

Workspace bir anda tam bir `region_id`'ye pinlidir. Placement authority yalnız active
region scheduler transaction'ıdır. API bir node/runtime seçmez; durable queue item
yaratır. Scheduler region affinity, drain state, tenant/provider admission ve atomik
capacity reservation'a göre node seçer. Workspace Agent yalnız kendisine verilen
placement, lease ve fencing token ile gerçek, pinli Codex app-server runtime'ını
başlatır. Sentetik ikinci scheduler veya billing ledger doğruluk kaynağı değildir.

Control plane ile workspace data plane ayrı süreç ve güvenlik sınırıdır. App-server
internete veya public gateway'e açılmaz. Runtime event/write yolu her durable mutation
öncesinde workspace'in güncel fencing token'ını doğrular.

### Queue, fairness ve admission

Scheduler algoritması `weighted-fair-v1`'dir. Tenant policy; plan/billing entitlement
ve quota snapshot'ından weight, tenant concurrency, zorunlu workspace concurrency=1,
provider concurrency/rate ve retry sınırlarını alır. Billing admission ve credit
reservation queue insertion ile aynı idempotency key/run kimliğine bağlanır; scheduler
billing'i yeniden hesaplayan paralel bir kaynak oluşturmaz.

Eligible item'lar önce starvation yaşı, sonra `virtual_finish / weight`, explicit
priority, enqueue zamanı ve opaque queue ID ile deterministik sıralanır. Provider ve
tenant sayaçları durable running state'ten hesaplanır. Retry exponential ve bounded'dır;
`max_attempts`/`poison_after_attempts` sonrasında item `poisoned` olur ve diğer tenant
işlerini durdurmaz.

İki scheduler `FOR UPDATE SKIP LOCKED` ile yarışır. Partial unique active-workspace
index'i, active lease unique index'i, idempotent queue/run key'leri ve capacity row
lock'u birlikte yalnız bir başlangıç hakkı verir.

### Lease ve fencing

Her claim, workspace-scoped monotonik counter'ı atomik artırır. Lease acquire yeni
`fencing_token` üretir; renew `owner_id + token + expected_expires_at` CAS'idir; release
aynı owner/token ile idempotenttir. Expired lease yeniden claim edildiğinde daha yüksek
token alır. Eski owner'ın turn/start, event append, approval side effect, checkpoint,
artifact finalize veya billing settlement yazısı `assert_workspace_fence` tarafından
reddedilir. Cache lock'u bu karara katılmaz.

Kimlik zinciri şu şekilde korunur:

`tenant/organization/workspace → queue_item → run → lease/fencing_token → placement →
region/node/runtime/generation → Codex thread/turn`.

### Placement, drain ve recovery

Region/node önce `cordoned` olur ve yeni claim kabul etmez; ardından `draining` olur.
Queued işler durable kaldığı için kaybolmaz. Aktif workspace state machine'i
`ready → checkpointing → rescheduling → recovering → ready|failed` ilerler. Durable
run, pending approval, event high-water ve object references checkpoint sınırının
dışında PostgreSQL/object storage'da kaldığından gateway instance veya runtime node
kaybında replay edilir. Outcome bilinmiyorsa prompt tekrar gönderilmez;
`outcome_unknown` ve operator recovery gerekir.

Region kaybında passive control plane ancak fencing/placement authority devri,
PostgreSQL promotion ve broker/object readiness doğrulandıktan sonra active olur.
Split-brain şüphesinde admission kapalı kalır. Region-pinned workspace başka region'a
otomatik taşınmaz; data-residency ve restore kararı WP27/WP28 sınırındadır.

### Capacity izolasyonu

Her runtime için cgroup v2 `cpu.max`, `memory.max`, `memory.swap.max=0`, `pids.max` ve
device-specific `io.max` uygulanır. Ayrı tenant volume/project quota disk byte ve inode;
I/O controller IOPS; egress proxy bandwidth/request; event gateway byte/s; object
policy artifact/output; index service corpus-index byte limitini uygular. Reservation
CPU, memory, pids, I/O, disk/inode/IOPS, egress, event, artifact/output ve corpus index
boyutlarını tek vector'da atomik ayırır.

Limit aşımı tenant/workspace/run-scoped `capacity_limit_outcome.v1` üretir; içerik,
prompt, output veya secret telemetry'ye yazılmaz. OOM/PID exhaustion runtime cgroup'u,
disk-full tenant volume'u, egress saturation tenant workload identity bucket'ını
etkiler; node system reserve ve diğer tenant reservation'ı tüketilemez.

### Readiness ve production fail-closed

Production'da PostgreSQL, durable event broker, object storage, runtime-control ve KMS
zorunludur. Readiness bunlardan biri eksik/timeout ise false; admission 503 olur.
SQLite event store, filesystem artifact/attachment/source, in-memory queue/lock ve
cache-as-lock configuration başlangıçta `PRODUCTION_FALLBACK_FORBIDDEN` ile reddedilir.
Local-alpha bu adapter'ları explicit development mode'da kullanmaya devam edebilir.

### RPO/RTO ve failover koşulları

WP26 hedefleri metadata/event/approval/queue için committed transaction düzeyinde
RPO=0; acknowledged object upload için versioned-object RPO=0; active workspace için
son durable event/checkpoint sonrası en fazla 5 saniye RPO'dur. API/realtime instance
RTO hedefi 30 saniye, scheduler lease recovery 60 saniye, node drain tek workspace RTO
5 dakika, control-plane region promotion RTO 30 dakikadır. Bunlar hedef ve kabul
budget'ıdır; yalnız gerçek HA/container tatbikatında ölçülen değer raporlanır.

Failover ancak şu koşullarda açılır: eski authority fenced/ulaşılamaz ve split-brain
engellenmiş, PostgreSQL primary writable, broker/object/KMS/runtime-control ready,
schema compatibility window içinde ve passive instance aynı contract'ı destekliyor.
Koşullardan biri yoksa readiness/admission fail-closed kalır.

### Online migration ve rollback

Migration expand-first'tür. N sürümü yeni nullable/defaulted alan ve tabloları ekler;
N-1 API/readers en az bir rollout window'u çalışır. Önce dual-read/compatibility probe,
sonra scheduler writer, ardından backfill ve constraint validation açılır. Contract
fields silinmez veya anlamı değiştirilmez. Rollback önce yeni admission/scheduler
writer'ı durdurur, leased işleri drain eder, N-1 binary'ye döner; 0028 tablolarını
drop etmez. Destructive contract ancak sonraki bağımsız migration ve tüm N-1 reader'lar
drain edildikten sonra yapılabilir.

## Sonuçlar

İlk production modeli single-writer active/passive control plane ve region-pinned
workspace'tir. Cache kaybı availability'yi düşürebilir ama doğruluğu bozmaz. Region
failover/backup-restore game day'lerinin sürekli operasyonu WP27; cloud/Kubernetes ürün
sözleşmesi, ölçülmemiş active/active ve global multi-region write bu ADR'nin dışıdır.
WP26 harness sonucu bağımsız kabul yerine geçmez.
