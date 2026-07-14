# ADR-0003: Session, event ingest ve replay sınırı

- Durum: Kabul edildi
- Tarih: 2026-07-14
- Kapsam: Faz 0 WP3 SQLite persistence ve client-facing realtime protokolü

## Bağlam

WP2, Codex envelope'larını redaction ve canonical checksum sonrasında normalize event'lere dönüştürür. WP3'te bu iki temsilin birlikte kalıcı olması, session'ın Codex thread binding'inin yeniden başlatma sonrasında korunması ve REST replay ile WebSocket live stream arasında event kaybı ya da duplicate oluşmaması gerekir.

Checksum bütünlük kanıtıdır. Aynı içeriğe sahip iki meşru upstream mesaj farklı ingest işlemleri olabilir; bu nedenle checksum deduplication anahtarı değildir. PoC control plane'de henüz auth principal bulunmadığından tenant/workspace kapsamı protokolde açık taşınmalıdır.

## Karar

- SQLite bootstrap, versioned `schema_migrations`/`user_version` ile yönetilir. WP2'nin legacy `events` tablosu açılışta veri kaybetmeden yeni şemaya taşınır.
- `sessions`, `(tenant_id, workspace_id, session_id)` bileşik kimliğiyle saklanır. Codex thread binding aynı değer için idempotent, farklı değer için conflict'tir.
- Workspace sequence sayacı `workspace_sequence` tablosundadır. `BEGIN IMMEDIATE` içinde artırılır ve `(workspace_id, sequence)` event uniqueness'iyle korunur.
- `ingest_key`, `(tenant_id, workspace_id)` kapsamında idempotency anahtarıdır. Duplicate ingest önceki normalize event'i döndürür ve yeni raw row, event ya da sequence üretmez.
- Sequence tahsisi, redakte raw envelope/artifact pointer insert'i, normalize event insert'i ve session high-water güncellemesi aynı transaction içindedir. Realtime notification yalnız commit sonrasında yapılır.
- Raw tabloda yalnız WP2'nin redakte edilmiş envelope'u veya artifact pointer bulunur. Secret içeren pre-redaction envelope persistence API'sine verilmez.
- REST replay scope'u zorunlu `x-tenant-id` ve `x-workspace-id` header'larıyla taşır. Cursor ve limit strict non-negative/integer doğrulamasından geçer.
- WebSocket `subscribe` ve `ack` mesajları tenant, workspace ve session kimliklerini açıkça içerir. Bu mesajların Zod şemaları `packages/control-plane-contracts` paketinde tek kaynaktır.
- Subscribe sırasında önce session high-water alınır. `afterSequence < sequence <= highWaterSequence` replay edilir; bu sırada commit edilen daha yeni event'ler connection-local buffer'a alınır. `subscribed` sonrasında buffer sequence sırasıyla, duplicate olmadan boşaltılır.
- Ack cursor connection-local ve monoton non-decreasing'dir. Scope mismatch, geriye gidiş ve henüz teslim edilmemiş sequence için ack reddedilir. Durable client cursor bu WP kapsamında server'da tutulmaz; reconnect eden client son ack değerini yeni `afterSequence` olarak gönderir.

## Sonuçlar

- SQLite tek-node PoC içinde transaction-safe, boşluksuz replay/live davranışı kanıtlanabilir.
- Process dışı message bus veya birden çok control-plane replica arasında live fan-out bu kararın kapsamı dışındadır.
- Gelecekte auth eklendiğinde header/message scope'u authenticated principal ile çapraz doğrulanmalıdır; istemci beyanı tek başına yetki kanıtı değildir.
- Artifact pointer şemada desteklenir, fakat gerçek artifact storage WP7'ye bırakılmıştır.
