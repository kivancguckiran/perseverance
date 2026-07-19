# WP26 teslimat ve kabul kanıtı raporu

- Tarih: 2026-07-19
- Durum: Uygulama adayı; bağımsız kabul edilmedi
- Contract: `production-topology.v1`
- ADR: `adr-0026-ha-production-topology-scheduler-capacity.md`
- Migration: `0028_ha_scheduler_capacity.sql`

## Kimlik zinciri ve PostgreSQL kanıtı

Gerçek `postgres:17-alpine` container'ında iki ayrı scheduler connection'ı aynı işi
claim etmeye çalıştı. Opaque test zinciri:

- region `eu-1`
- node `node-1`
- workspace `workspace_a`
- queue item `queue-1`
- run `run-1`
- ilk lease `lease-a`, fencing token `1`
- recovery lease `lease-2`, fencing token `2`
- gerçek runtime harness lease `lease-runtime`, run `run-runtime`

Yalnız bir ilk claim oluştu. Lease expiry sonrası yeni owner token 2 aldı; token 1 ile
`assert_workspace_fence` reddedildi. Scheduler recovery transaction zinciri bu
makinede RPO 0 ve 11 ms wall-clock RTO ölçtü. Bu sayı region/node failover RTO'su veya
production SLO kanıtı değildir.

Queue, provider admission, fence counter, lease, placement, capacity reservation,
drain, recovery, dependency readiness ve capacity-limit tabloları dahil 11 tabloda
forced RLS doğrulandı. Başka tenant runtime role'ü queue satırını göremedi. Migration
sonrasında migration 18 reader yüzeyi okunabildi; rollback testi writer stop → lease
drain → N-1 binary → schema'yı drop etmeme stratejisini doğruladı.

## Scheduler ve gerçek runtime

`codex-cli 0.144.2` app-server, scheduler claim/fence callback'i üzerinden gerçek
thread/turn başlattı. Runtime başlangıcı ve terminal sonuçtan önce fence doğrulandı;
tamamlanma sonrası eski token reddedildi. İzole Codex home temizlendi.

Deterministik `weighted-fair-v1` ölçümünde Tenant A için 1000, Tenant B için 20 queued
item kullanıldı. Eşit weight altında Tenant B'nin son item'ı en geç queue pozisyonu
40'ta seçildi. Unit suite concurrency, provider rate, starvation age, bounded backoff
ve poison state'i ayrıca doğruladı. Bu deterministik ölçüm production load/latency
benchmark'ı değildir.

## Readiness ve fallback

Production composition PostgreSQL event/queue/lock, object artifact/attachment/source,
event broker, runtime-control ve KMS readiness endpoint'lerini zorunlu tutar. Eksik
dependency readiness ve new-turn admission'ı fail-closed yapar. SQLite, filesystem,
in-memory queue/lock ve cache-as-lock configuration unit gate'te reddedildi.

## Çalıştırılan kontroller

- `pnpm wp26:test`: 65 test geçti.
- `pnpm typecheck`: 19 workspace package geçti.
- `pnpm wp26:postgres`: gerçek PostgreSQL/RLS/race/recovery/cleanup geçti.
- `WP26_CODEX_BIN=... pnpm wp26:scheduler`: gerçek Codex app-server geçti.
- `WP26_CODEX_BIN=... pnpm wp26:ha`: PostgreSQL scheduler yarış/recovery ve gerçek
  runtime zinciri geçti.
- `WP26_CODEX_BIN=... pnpm wp26:browser`: local adapter restart high-water 16→36,
  snapshot reconciliation, approval race, Chromium 390x844/768x1024/1280x720 ve
  cleanup geçti; çıktı `productionHaEvidence:false` olarak işaretlendi.
- `pnpm verify`: 36 dosyada 345 test, typecheck, build ve SSR HTTP smoke geçti.

## Henüz production kanıtı olmayan kontroller

- `pnpm wp26:capacity`: Docker Desktop bu ortamda daemon block device'ını client'a
  sunmadığı ve `WP26_IO_DEVICE` bulunmadığı için fail-closed kaldı. CPU, memory, pids,
  io, disk/inode ve egress testlerinin tamamı gerçek Linux host üzerinde birlikte
  çalışmadan noisy-neighbor kabulü yoktur.
- `pnpm wp26:browser`: iki production API/realtime process'i, durable PostgreSQL event
  store, broker ve object storage ile instance kill browser doğrulaması henüz
  çalıştırılmadı. Local restart sonucu production HA kanıtı sayılmaz.
- Node/region drain altında aktif approval, detached run ve realtime replay için gerçek
  multi-process RPO/RTO ölçülmedi.
- PostgreSQL/cache/broker/object storage dependency-loss chaos ve online N/N-1 binary
  rollback gerçek external topology üzerinde çalıştırılmadı.

Bu açık kontroller nedeniyle `wp26:accept` bağımsız kabul kararı üretmez ve WP26 bu
raporla kendiliğinden tamamlanmış sayılmaz.

## Cleanup

Başarılı PostgreSQL/HA koşularının geçici container ve volume'ları silindi. İzole Codex
home kaldırıldı. Kabul raporu prompt, output, secret veya tenant içeriği içermez.
