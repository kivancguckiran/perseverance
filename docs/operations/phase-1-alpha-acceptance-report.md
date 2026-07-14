# Faz 1 tek kiracılı alfa kabul raporu

- WP12 durumu: **Tamamlandı**
- Faz 1 durumu: **Tamamlandı**
- Kanıt formatı: `.runtime/acceptance/alpha-accept.json` ve opt-in
  `.runtime/acceptance/alpha-canary.json`; bu dosyalar git'e alınmaz.

## Exit kriteri eşlemesi

| Faz 1 kriteri                                               | Komut/kanıt                                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Temiz kurulum ve actionable auth                            | `pnpm install --frozen-lockfile`, `pnpm alpha:dev`, `pnpm alpha:accept`; auth-none integration              |
| Browser/control-plane/app-server restart ve kayıpsız geçmiş | deterministic recovery/replay testleri, `pnpm alpha:lifecycle`, gerçek `pnpm alpha:canary` recovery aşaması |
| Yakın session ve salt-okunur Git                            | `pnpm verify`; browser desktop/mobil matrisi; canary change/targeted-test aşaması                           |
| Durable audit, health ve bounded metrics                    | `pnpm verify`; lifecycle restore; canary recovery/readiness/audit/metrics aşaması                           |
| Tekrarlanabilir release paketi                              | `pnpm alpha:accept` (canary yok) ve ayrı `pnpm alpha:canary`                                                |

## Deterministik arıza/soak matrisi

| Senaryo                                                              | Birleşik kanıt                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Reload, reconnect, sequence gap/duplicate ve authoritative reconcile | Web state + realtime replay/live integration testleri                  |
| Control-plane/app-server restart ve aynı thread resume               | recovery integration + fake lifecycle restart                          |
| Auth setup_required/401 ve recovery                                  | auth-none ve auth recovery integration testleri                        |
| Approval race/tek kazanan audit                                      | approval CAS/concurrency integration testleri                          |
| Büyük output, spill, cleanup                                         | 100 MiB adapter→SQLite→artifact testleri + 8 MiB resource soak         |
| DB/artifact/workspace/disk readiness failure/recovery                | dynamic readiness integration testleri                                 |
| Git before/after, bounded diff, reload persistence, dirty workspace  | Git fixture + turn checkpoint integration testleri                     |
| Audit pagination/retention/reopen ve metric cardinality              | event-store/server/metrics integration testleri                        |
| Uzun timeline, slow consumer ve resync                               | bounded sender ve browser 2.000-event/64-KiB state testleri            |
| Temporary runtime/orphan cleanup                                     | 12-cycle fake process soak + artifact orphan tests + lifecycle cleanup |

## Kaynak eşikleri

`pnpm alpha:soak` platformu kaydeder ve ölçülemeyen bir probe'u başarısız sayar.

| Kaynak                            |                       Lokal alfa eşiği |
| --------------------------------- | -------------------------------------: |
| Eşzamanlı ekstra child process    |                                      1 |
| Soak sonrası ekstra child process |                                      0 |
| Peak/final FD artışı              |                                 32 / 8 |
| Soak sonrası RSS büyümesi         |                                128 MiB |
| CPU/core oranı                    |                    logical core × 1.25 |
| Küçük soak SQLite+WAL+SHM         |                                 16 MiB |
| 8 MiB payload artifact kökü       |                                  9 MiB |
| Audit retention                   |                         100 soak kaydı |
| Realtime outbound queue           |                      256 event / 1 MiB |
| Browser timeline state            | 2.000 event; terminal tail 64 KiB/item |

Gerçek ölçümler makinece okunur `alpha-soak.json` özetine yazılır. Process, FD, RSS,
CPU ve disk probe'u kullanılamazsa script non-zero döner. Realtime ve browser sınırları
gerçek integration assertion'larıyla ölçülür; ölçüm yoksa başarı sayılmaz.

## Kanıt güvenliği

Gate özetleri yalnız aşama durumu, süre, eşik ve sayısal ölçüm taşır. Prompt, model
çıktısı, reasoning, credential, session/thread kimliği, hassas path ve kişisel Codex
session içeriği subprocess çıktısından acceptance dosyasına kopyalanmaz. Canary child
çıktısı yalnız bellekte cleanup doğrulaması için tutulur ve sonra atılır.

## Bilinen sınırlamalar ve Faz 2'ye bırakılanlar

Runbook'taki tek-node SQLite, lokal process, offline backup, filesystem artifact, lokal
auth ve salt-okunur Git sınırlamaları geçerlidir. Org/user/RBAC, güçlü tenant izolasyonu,
scheduler, KMS/Vault, egress policy, billing, production backup/DR, object storage,
multi-region ve deployment Faz 2+ konularıdır. Bu sınırlamalar kabul edilmiş alfa kapsam
sınırlarıdır; Faz 1'in tamamlanmasını engellemez.

## WP12 uygulama doğrulama kaydı

15 Temmuz 2026 tarihli uygulama doğrulamasında frozen-lockfile install ve iki ardışık
protocol generation drift üretmeden geçti. `pnpm alpha:accept`; deterministic soak,
`pnpm verify` içindeki 120+ test/typecheck/build/SSR zinciri ve lifecycle recovery
aşamalarını geçti. Ayrı `pnpm alpha:canary`; read-only turn, küçük değişiklik + hedefli
test + Git görünürlüğü, tek approval kararı ve restart/resume/readiness/audit/metrics
aşamalarını izole cleanup ile geçti.

Gerçek browser kabulü sırasında iki WP12 engeli bulundu ve kapatıldı: Vite yalnız IPv6
loopback'te dinliyordu; explicit `127.0.0.1` bind eklendi. Session navigasyonu realtime
cursor'u session scope'unda sıfırlamıyordu; session-scoped cursor reset ve regresyon
testi eklendi. Son kontrolde 1280×720 ve 390×844 görünümde iki session arasında
navigasyon, Git status/diff/log, approval pending→resolved, durable audit, reload,
control-plane restart ve replay geçti. Loading, empty, stale ve control-plane kapalı
error durumları görünür kaldı; yatay taşma, Vite overlay veya console warning/error
oluşmadı. Browser tab'ları, dev process'leri ve izole runtime kökü temizlendi.

İlk canary cleanup denetimi kişisel `config.toml` notification hook'unun geçici smoke
home'a taşındığını ve PPID 1 altında helper bırakabildiğini gösterdi. Canary home'ları
yalnız auth dosyasını bağlayacak biçimde daraltıldı; kişisel config/session state'i artık
çalıştırılmıyor. `alpha:canary` process probe'u ilgili smoke prefix'li orphan ölçerse
başarısız olur. Final canary dört aşamayı da orphan, port veya geçici runtime bırakmadan
yeniden geçti.

## Bağımsız kabul kararı

15 Temmuz 2026 tarihinde frozen install, çift generator drift kontrolü,
`pnpm alpha:accept`, `pnpm alpha:canary`, desktop/mobil browser matrisi ve cleanup
bağımsız olarak yeniden çalıştırıldı. Tüm release gate aşamaları geçti; çalışma ağacı
temiz ve kabul portları kapalı kaldı. WP12 ve Faz 1 tamamlandı.
