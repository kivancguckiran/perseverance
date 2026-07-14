# ADR-0004: Canlı thread/turn orchestration ve runtime yaşam döngüsü

- Durum: Kabul edildi
- Tarih: 2026-07-14
- Kapsam: Faz 0 WP4 gerçek Codex thread/turn ve canlı timeline akışı

## Bağlam

WP4'te control plane'in bir workspace için gerçek `codex app-server` sürecini paylaşması, session'ı upstream thread'e tekil biçimde bağlaması ve turn notification'larını WP2/WP3 hattına kayıpsız aktarması gerekir. İstemciden cwd almak güvenlik sınırını bozar; checksum'ı ingest dedupe anahtarı yapmak ise aynı içeriğe sahip meşru iki upstream mesajı yanlışlıkla birleştirir.

## Karar

- `WorkspaceRuntimeRegistry`, `(tenantId, workspaceId)` başına tek initialize edilmiş client tutar. Eşzamanlı initialization aynı promise üzerinde birleşir; farklı cwd ile ikinci initialization reddedilir.
- Notification ve server request listener'ları client initialize edilmeden kurulur. Registry her runtime oluştururken production'da `randomUUID`, testlerde injectable factory ile benzersiz bir `runtimeInstanceId` üretir. Bu kimlik aynı registry içindeki child-process restart'larında sabit kalır; yeni registry/control-plane instance'ında yenilenir.
- Her delivery, `runtimeInstanceId`, app-server process generation ve generation-local receive ordinal taşır. `ingestKey`, `JSON.stringify(["codex", tenantId, workspaceId, runtimeInstanceId, processGeneration, receiveOrdinal])` biçimindedir. Böylece process generation ve ordinal yeni control-plane instance'ında tekrar 1 olsa bile durable key yeniden kullanılmaz.
- Event store, mevcut bir ingest key'i yalnız tenant/workspace/session ve checksum da aynıysa idempotent duplicate kabul eder. Aynı key farklı session veya checksum ile gelirse transaction içinde `INGEST_KEY_CONFLICT` üretir; sequence tahsis etmez, raw/event yazmaz ve eski eventi döndürmez.
- Delivery handler hataları runtime ve delivery metadata'sıyla `onDeliveryError` callback'ine aktarılır; control plane bunları structured error log olarak yazar. Hatalı delivery queue zincirini kesmez ve sonraki mesaj işlenir. Callback sağlanmayan kullanımda hata stderr'e yazılır; hata sessizce yutulmaz.
- Registry control-plane kapanışında in-flight delivery queue'larını drain eder ve bütün client'ları kontrollü durdurur. Client factory testlerde deterministik fake transport ile değiştirilebilir.
- Session cwd'si yalnız control-plane konfigürasyonundan gelir. `POST /v1/sessions` istemciden path kabul etmez; session önce `starting`, başarılı `thread/start` ve binding sonrasında `active`, hata halinde `failed` olur.
- `thread/start` ve `turn/start` parametre/cevapları pinli Codex 0.144.2 binary'sinden generated TypeScript tipleriyle kurulur.
- Turn endpoint'inde `Idempotency-Key` zorunludur. Request hash normalize edilmiş prompt üzerinden hesaplanır. Aynı key+hash için process içindeki eşzamanlı istekler tek upstream çağrıda birleşir; completed cevap durable kayıttan replay edilir; farklı hash `IDEMPOTENCY_HASH_CONFLICT` üretir.
- Session başına tek kalıcı `CodexEventAdapter` context'i tutulur. Böylece approval request/resolved correlation aynı runtime akışı içinde korunur.
- Adapter'ın redakte raw envelope'u ve checksum'ı, normalize event ile WP3 transaction'ına birlikte verilir. Realtime yalnız store commit callback'inden yayınlanır.
- Server approval request'leri `approval.requested` olarak kaydedilir ve pasif kart olarak gösterilir; WP4 hiçbir JSON-RPC approval cevabı veya auto-approval üretmez.

## Sonuçlar

- Control-plane process restart sonrasında runtime/thread recovery ve stale `pending` idempotency lease çözümü WP6 kapsamındadır. Böyle bir durable pending kayıt mevcut process'te in-flight değilse açık `IDEMPOTENCY_REQUEST_IN_PROGRESS` döner.
- Global veya thread kimliği taşımayan app-server notification'ları session stream'ine yönlendirilmez. Thread kimliği taşıyan bilinmeyen notification'lar `codex.unknown` olarak saklanır.
- PoC tek aktif turn varsayımını korur; steer, interrupt ve thread/resume bu karara dahil değildir.
- `runtimeInstanceId` restart sonrası thread recovery sağlamaz; yalnız transport delivery kimliğini restart-safe yapar. Thread resume/recovery WP6 kapsamındadır.
