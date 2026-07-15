# ADR-0013: Durable detached turn execution

- Durum: Kabul adayı
- Tarih: 15 Temmuz 2026
- Kapsam: Faz 2 WP14 browser'dan bağımsız turn execution ve terminal accounting

## Bağlam

WebSocket bir subscription taşımasıdır; turn'ün sahibi değildir. Process belleğindeki
aktif-turn map'i control plane restart'ında kaybolur, iki eşzamanlı HTTP isteğini database
seviyesinde engellemez ve provider çağrısının kabul edilip edilmediği bilinmeyen crash
penceresinde prompt'un yanlışlıkla tekrar gönderilmesine yol açabilir. Usage snapshot'ı
ile terminal lifecycle ayrı yazılırsa completed, failed veya interrupted sonuç ile
ölçülmüş maliyet arasında atomiklik boşluğu oluşur.

## Karar

- SQLite schema v10 `durable_runs` tablosunu ekler. Server-owned `run_id`, session ve
  provider kimliği, nullable provider turn kimliği, attempt, runtime generation,
  lifecycle timestamp'leri, terminal outcome ve recovery nedeni kalıcıdır.
- Durum makinesi `queued → running → completed|failed|interrupted`,
  `running → interrupting → interrupted` ve belirsiz execution durumlarından
  `recovery_required` geçişlerini kullanır. Aynı terminal sonuç idempotenttir; farklı
  ikinci terminal sonuç conflict'tir.
- `queued`, `running` ve `interrupting` kayıtları için tenant/workspace/session scoped
  partial unique index session başına tek aktif turn'ü transaction sınırında korur.
- WebSocket close, browser unload ve route değişimi yalnız subscription listener'larını
  bırakır. Interrupt yalnız explicit REST endpoint'inden provider'a gönderilir. Aynı
  idempotency key önceki sonucu döndürür; provider interrupt sonucu bilinmiyorsa RPC
  tekrar edilmez ve run `recovery_required` olur.
- Control plane restart'ında provider turn kimliği yazılmamış queued run ve sonucu
  bilinmeyen interrupt otomatik yeniden gönderilmez. Bound running run aynı persistent
  Codex home/thread üzerinde `thread/read(includeTurns: true)` ve `thread/resume` ile
  reconcile edilir. Snapshot'ta run yoksa `RECOVERY_OUTCOME_UNKNOWN` gösterilir.
- Session detail snapshot `activeRun` ve `latestRun` taşır. İstemci snapshot'ı aldıktan
  sonra mevcut high-water replay/live protokolüne katılır; authoritative event dedupe
  kuralları değişmez.
- Codex cumulative usage için `tokenUsage.total` stable ingest key ile append edilir.
  Terminal run geçişi turn state ve terminal ledger satırını aynı SQLite transaction'ında
  yazar. Ölçülmüş ara usage korunur; terminal usage kesin değilse sonuç
  `partial/unreconciled` ve estimated cost nullable kalır.

## Sonuçlar

Tek node/process içindeki execution browser ömründen ayrılmıştır. Multi-node lease,
distributed scheduler ve production HA bu kararla çözülmez. Provider'ın terminal usage
semantiği kesin bir terminal snapshot sunmadığında sistem maliyeti complete veya sıfır
varsaymaz. Server shutdown aktif provider işini implicit browser interrupt'ına çevirmez;
sonraki startup aynı thread üzerinden reconcile eder.
