# ADR-0007: Bounded command output ve scoped artifact depolama

- Durum: Kabul edildi (WP7 uygulama adayı)
- Tarih: 2026-07-14

## Bağlam

Command output deltalarını adapter, SQLite event payload, WebSocket queue veya browser state içinde birleştirmek 100 MB ve üzeri akışlarda bellek ile bağlantı baskısını sınırsız büyütür. `item/completed` yetkili son durum olmaya devam etmelidir; ancak completed snapshot içindeki büyük `aggregatedOutput` da yeniden tam string olarak taşınmamalıdır.

## Karar

- PoC local filesystem-backed `ArtifactStorage` adapter kullanır; production object storage bu iş paketinin dışındadır.
- Canlı preview UTF-8 güvenli son **64 KiB**, artifact append chunk hedefi **64 KiB**’dır. Realtime bağlantısı en çok **256 event / 1 MiB** queued veri taşır.
- Her chunk `chunkIndex`, redaction sonrası `byteLength`, stream, ordered byte range ve artifact pointer ile modellenir. Duplicate chunk index idempotent, sıra atlaması hatadır.
- Output secret redaction uygulandıktan sonra append edilir. Event, log, SQLite payload ve download yalnız bounded/redakte içeriği görür; filesystem path hiçbir sözleşmede dönmez.
- Adapter tam upstream chunk'ı yalnız transient `spill` handoff'unda aynı referansla taşır; raw envelope ve normalize event'e yalnız redakte bounded preview girer. Writer büyük tek delta ve completed-only snapshot'ı 64 KiB segmentlere böler.
- Streaming redactor en çok 4 KiB carry tutar; chunk sınırındaki bearer, `sk-*`, `sess-*` ve structured credential değerleri tamamlanmadan hiçbir byte kalıcı ortama yazılmaz.
- Artifact server-owned tenant/workspace/session/turn/item dizinlerinde `0600` temp data ve atomik metadata write ile tutulur. Scope segmentleri allow-list edilir; canonical root escape, `..`, symlink, `/proc` ve `/sys` reddedilir.
- Finalize temp data dosyasını atomik rename eder ve streaming SHA-256/byte count üretir. Startup recovery yarım metadata/data çiftlerini uzlaştırır; yaşlı temp orphan’lar kontrollü cleanup ile silinir.
- Artifact download `readFileSync`/browser `blob()` kullanmaz. Scoped istek 60 saniyelik tek kullanımlık opaque download grant üretir; grant URL'si tenant/workspace bilgisini taşımaz ve response doğrudan filesystem stream'idir. Range yalnız istenen byte aralığını açar.
- SQLite schema v4 artifact metadata tablosu ekler. Büyük output event/raw envelope tek satırda tutulmaz; payload bounded preview ve opaque artifact ID/range taşır.
- `command.completed` authoritative final durumdur. Final tail, total bytes ve checksum/artifact metadata geçici deltaların yerini alır; tam snapshot yeniden accumulator’a alınmaz.
- WebSocket bağlantısı event ve serialized byte limitiyle bounded queue kullanır. Command deltaları coalesce/sample edilebilir; approval, completed ve recovery olayları düşürülemez. Limit aşımında typed `resync` mesajı gönderilir ve istemci durable REST replay'den cursor ile toparlanır.
- Queue bütün outbound replay/live/approval trafiğini ve socket `bufferedAmount` değerini kapsar; tek resync sonrasında istemci durable cursor'dan yeniden bağlanır.
- Browser her terminal item için 64 KiB tail tutar; timeline window/sanallaştırma ile bounded render edilir. Reconnect eventId/sequence dedupe ve completed reconciliation uygular.

## Sonuçlar

Tam redakte çıktı scoped artifact endpoint’inden güvenli headers ve byte Range ile indirilebilir. Crash sırasında en fazla finalize edilmemiş temp artifact kalır; recovery/cleanup bunu görünür ve tekrar çalıştırılabilir biçimde ele alır. Production retention, S3/R2 ve multi-region replication ayrıca kararlaştırılacaktır.
