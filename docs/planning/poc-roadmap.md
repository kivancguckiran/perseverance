# Faz 0 — Protokol kanıtı yol haritası

Detaylı kapsam, iş paketleri, kabul kriterleri, riskler ve Definition of Done için `docs/planning/poc-implementation-plan.md` esas alınır.

## Amaç

Tek kullanıcı ve tek lokal workspace ile gerçek, pinli `codex app-server` olaylarını dayanıklı bir timeline'a taşıyan en küçük uçtan uca dilimi kurmak.

PoC'nin kabul edilmiş teknoloji yığını ve repository sınırları için `docs/architecture/adr-0002-poc-technology-stack.md` esas alınır.

## Exit kriteri

Üç örnek görevde agent message, reasoning summary, plan, command output, file change/diff ve approval semantiği kayıpsız görünür. Browser kapatılıp yeniden açıldığında aynı Codex thread'i ve platform timeline'ı sequence gap olmadan sürer.

## Uygulama durumu — 14 Temmuz 2026

| Paket                      | Durum      | Kanıt                                                                                                                                                      |
| -------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 Repository ve sözleşme  | Tamamlandı | pnpm/TypeScript monorepo, Codex 0.144.2 pini, generated TS + JSON Schema ve schema hash                                                                    |
| P1 Workspace Agent köprüsü | Tamamlandı | Typed process/protocol/timeout hataları, health state, restart/backoff, crash-loop limiti, fake server lifecycle testleri ve gerçek app-server smoke testi |
| P2 Normalize event adapter | Tamamlandı | Tüm hedef mapping'ler, runtime validation, reconciliation, redaction/checksum ve on golden fixture doğrulandı                                              |
| P3 Session ve replay       | Tamamlandı | Session/thread binding, atomik raw+normalize ingest, scoped REST replay ve high-water replay/live+ack doğrulandı                                           |
| P4 Thread, turn ve web     | Tamamlandı | Restart-safe runtime instance ingest key, collision guard, observable delivery error ve iki-instance gerçek browser kanıtı                                 |
| P5 Approval                | Tamamlandı | Durable state machine, concurrent karar, gerçek control-plane smoke ve responsive approval UI doğrulandı                                                   |
| P6 Resume ve arıza         | Tamamlandı | Persistent home, aynı-thread restart/resume, recovery modeli ve adreslenebilir session route doğrulandı                                                    |
| P7 Büyük çıktı             | Tamamlandı | Uçtan uca 100 MiB spill, streaming redaction, scoped artifact, slow-consumer resync ve bounded responsive timeline doğrulandı                              |
| P8 Golden demo             | Tamamlandı | Üç gerçek golden görev ile reconnect/restart/unknown/concurrent-approval senaryoları temiz kurulumdan doğrulandı                                           |

WP2 adapter teslimatı tamamlandı: generated Codex sözleşmeleri runtime'da doğrulanır; hedef event aileleri normalize edilir; unknown girdiler güvenli biçimde korunur; completed snapshot deltaların yetkili son halidir; redaction canonical checksum'dan önce uygulanır. On golden fixture dahil repo doğrulamasında 31 test geçmiştir.

WP3 kabul edildi: atomik ingest, durable session/event kayıtları, scoped replay, reconnect cursor ve replay/live sınırındaki buffer davranışı repo genelinde 46 testle doğrulandı. Persistence ve realtime kararları `docs/architecture/adr-0003-session-event-replay.md` içinde kayıtlıdır.

WP4 düzeltmesi kabul edildi: runtime-instance kimliği yeni control-plane registry'sinde yenilenir, store aynı key'in farklı session/checksum kullanımını `INGEST_KEY_CONFLICT` ile atomik olarak reddeder ve delivery hataları callback/log üzerinden görünür kalırken queue devam eder. File-backed regresyon testi iki instance'ta 12 benzersiz sequence ve iki authoritative final event'i doğruladı. Gerçek restart/browser denetiminde ilk session 10–42, ikinci session 43–80 sequence aralığında kaldı; ikinci session'ın son deltası `.` iken completed snapshot ve final kart tam metni gösterdi. Runtime/orchestration kararları `docs/architecture/adr-0004-live-thread-turn-orchestration.md` içinde kayıtlıdır.

WP4 tamamlandı.

WP5 kabul edildi: atomik durable approval, optimistic-lock/idempotent karar, generated command/file mapping, runtime lifecycle expiry, WebSocket reconciliation ve responsive approval kartı 65 testle doğrulandı. Gerçek control-plane smoke karar öncesi sıfır, karar sonrası tek upstream response ve terminal turn kanıtladı; browser denetiminde pending→resolved akışı desktop ve mobilde tamamlandı.

WP6 kabul edildi: server-owned persistent home, durable recovery alanları, scoped session detail/resume, generated steer/interrupt ve adreslenebilir browser session route'u tamamlandı. Gerçek iki-instance smoke aynı thread resume, monotonic sequence ve snapshot dedupe davranışını; browser reload denetimi TanStack route param aktarımı ile responsive görünümü doğruladı.

WP7 kabul edildi: 100 MiB delta ve completed-only akışları bounded preview ile tam redakte artifact'e taşındı; durable metadata/recovery, scoped streaming download, slow-consumer resync ve item başına coalesce edilen responsive timeline 94 test, build, SSR smoke ve browser denetimiyle doğrulandı.

WP8 kabul edildi: `pnpm demo:smoke` arıza regresyonlarını ve aynı-thread
restart/resume'u; üç `pnpm demo:golden:*` komutu gerçek app-server görevlerini ve tek
kazananlı concurrent approval yarışını doğruladı. Generator deterministik kaldı,
cleanup kontrolleri geçti ve desktop/mobil browser görünümü taşmasız, temiz console ile
açıldı. Faz 0 tamamlandı ve yeni işler Faz 1 planına taşındı.

## Sonraki faz

Faz 1 tek kiracılı alfa kapsamı WP9–WP12 olarak
`docs/planning/phase-1-alpha-plan.md` içinde tamamlanmıştır. Faz 2 maliyet, browser'dan
bağımsız kalıcı çalışma, PWA ve Codex/Claude/Gemini provider platformu kapsamı WP13–WP16
olarak `docs/planning/phase-2-provider-platform-plan.md` içinde tamamlanmıştır. Yeni faz
ayrı bir plan kabul edilmeden ve tek aktif work package açılmadan başlatılmaz. Cursor
provider köprüsü ile yeniden numaralanan Faz 3 Multi-tenant Security Beta taslağı
`docs/planning/phase-3-security-and-cursor-plan.md` içinde tamamlanmıştır. Faz 4 Corpus
ve mobil ürün WP21–WP24, Faz 5 Production hardening WP25–WP29 olarak
`docs/planning/phase-4-corpus-mobile-and-phase-5-production-plan.md` içinde planlanmış;
WP21 ve WP22 bağımsız kabul edilmiş; WP23 tek aktif iş paketi olarak açılmıştır.

## Uygulama sırası

### P0. Repository ve sözleşme temeli

- Runtime/package manager kararını ver ve minimal workspace'i kur.
- Codex binary sürümünü checksum ile pinle.
- Aynı sürümden TypeScript ve JSON Schema üretim komutunu ekle.
- `sourceVersion` ve `schemaHash` üretimini doğrula.

Kabul: Temiz ortamda tek komut generated protocol çıktısını yeniden üretebilir; schema drift CI'da görünür.

### P1. Workspace Agent process köprüsü

- App-server child process supervision.
- stdout JSONL parser; stderr tanı logu ayrımı.
- correlation id tabanlı request/response yönlendirme.
- `initialize`/`initialized`, health ve kontrollü shutdown.

Kabul: Gerçek app-server ile handshake testi geçer; malformed JSON ve process exit kontrollü hata üretir.

### P2. Normalize event adapter

- Versioned base envelope ve monotonic sequence.
- Agent message, reasoning summary, plan, command, file change, diff ve turn event mapping'leri.
- Completed item reconciliation.
- Bilinmeyen olaylar için `codex.unknown`.

Kabul: Golden JSONL fixture'ları deterministik normalize event dizisine dönüşür; unknown fixture servisi çökertmez.

### P3. Dayanıklı session ve replay

- Session ↔ Codex thread eşlemesi.
- Event append store ve `(workspaceId, sequence)` uniqueness.
- Snapshot + `afterSequence` replay.
- Browser reconnect için high-water mark akışı.

Kabul: Duplicate ingest idempotenttir; replay/live sınırında olay kaybı veya çift UI uygulaması yoktur.

### P4. Approval akışı

- Server-initiated request'i durable pending approval'a çevir.
- Karar endpoint'i, expected version ve idempotency.
- App-server response ve `serverRequest/resolved` reconciliation.
- Interrupt/crash halinde expire/supersede davranışı.

Kabul: İki eşzamanlı karardan yalnız biri kazanır; ikinci karar `APPROVAL_ALREADY_RESOLVED` olur.

### P5. Minimal responsive web timeline

- Tek kronolojik görev görünümü.
- Streaming message/status, plan, command, diff ve sticky approval kartları.
- Mobilde terminal/diff kapalı, ayrıntılar isteğe bağlı.
- Reconnect cursor ve completed snapshot reconciliation.

Kabul: Küçük ekran ve masaüstünde üç golden görev semantik olarak aynı görünür.

### P6. Resume ve arıza senaryoları

- Kalıcı `CODEX_HOME`.
- Process restart sonrası `thread/read` + `thread/resume`.
- Açık `THREAD_NOT_RESUMABLE` recovery durumu.

Kabul: Browser restart ve app-server restart senaryoları test edilir; aynı thread
sequence gap veya duplicate authoritative snapshot olmadan sürdürülür.

### P7. Büyük çıktı ve timeline dayanıklılığı

- Command output chunk index ve bounded live tail.
- Redaction sonrası artifact spill prototipi.
- Realtime/UI backpressure ve completed snapshot reconciliation.
- Uzun timeline sanallaştırma.

Kabul: 100 MB çıktı UI belleğini sınırsız büyütmez; son N KB canlı görünür ve tam
redakte çıktı tenant/workspace scoped artifact olarak erişilebilir.

### P8. Golden senaryolar ve PoC demosu

- Read-only repository inceleme ve final özet görevini uçtan uca yürüt.
- Küçük kod değişikliği, hedefli test ve diff görevini uçtan uca yürüt.
- Ağ veya komut approval'ı isteyen görevi gerçek karar akışıyla yürüt.
- Browser reconnect, app-server restart, unknown event replay ve concurrent approval
  yarışını tekrarlanabilir senaryolar olarak doğrula.
- Temiz kurulum, çalıştırma, demo ve beklenen kanıt adımlarını tek dokümanda kaydet.

Kabul: Üç golden görev web timeline'ında semantik olarak doğru görünür; kayıp/çift event
ve çift approval kararı oluşmaz; demo temiz kurulumdan yeniden çalıştırılabilir.

## Faz 0 dışında

Multi-tenant scheduler, production runtime izolasyonu, billing, corpus, native mobile, push notification ve multi-region çalışma bu PoC tamamlanmadan uygulama kapsamına alınmaz. Tasarım sırasında güvenlik sınırları korunur; ancak bu bileşenlerin üretim implementasyonu sonraki fazlardadır.

## Kabul edilmiş ilk kararlar

- PoC, pnpm tabanlı TypeScript monorepo olacaktır.
- Workspace Agent PoC'de Node.js/TypeScript, control plane Fastify, web istemcisi TanStack Start + TanStack Router + TanStack Query kullanacaktır.
- Lokal event/session store SQLite olacaktır ve bir persistence adapter arkasında tutulacaktır.
- Başlangıç Codex pini `0.144.2` olacaktır; generated schema bu binary'den üretilecektir.
- Auth, app-server'ın resmî account/auth yüzeyi üzerinden doğrulanacak; credential event store'a veya repository'ye yazılmayacaktır.
- Üretim runtime, platform-managed key/BYOK ve Workspace Agent'ın kalıcı dili Faz 0 sonrasında ayrı ADR'lerle kararlaştırılacaktır.
