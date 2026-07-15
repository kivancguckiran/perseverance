# Durable turn recovery runbook

## Beklenen durumlar

- `queued`: HTTP isteği kabul edildi, provider turn kimliği henüz durable değil.
- `running`: provider turn kimliği bağlı; browser/WebSocket olmasa da çalışma sürer.
- `interrupting`: explicit Durdur RPC'si gönderiliyor.
- `completed`, `failed`, `interrupted`: terminal outcome ve terminal ledger satırı yazıldı.
- `recovery_required`: upstream etkinin sonucu kesin değil; otomatik prompt/interrupt
  tekrarı yasaktır.

## Browser disconnect

Browser kapanması veya WebSocket close için operator eylemi gerekmez. Session detail'deki
`activeRun` server-owned durumu gösterir. İstemci geri geldiğinde session snapshot'ını,
ardından durable cursor'dan replay ve live subscription'ı yükler. Disconnect ile aynı
zamanda `turn/interrupt` audit veya provider RPC'si görülmesi bug'dır.

## Control plane veya app-server restart

1. Aynı tenant/workspace/session ve persistent Codex home'un kullanıldığını doğrula.
2. Session resume çalıştır; servis önce `thread/read(includeTurns: true)`, sonra
   `thread/resume` yapar.
3. Snapshot'ta bound turn terminal ise run aynı `runId/turnId` ile finalize edilir.
4. Snapshot'ta turn `inProgress` ise runtime generation güncellenir ve run sürer.
5. Turn kimliği yok veya snapshot'ta bound turn bulunamıyorsa `recovery_required` bırak;
   yeni idempotency key ile prompt'u yeniden gönderme.

## Accounting kontrolü

Turn usage endpoint'inde terminal outcome ile ölçülmüş cumulative counters birlikte
kalmalıdır. Terminal usage kesin değilse `completeness=partial`,
`reconciliationStatus=unreconciled` ve fiyatlanabilir usage yoksa
`estimatedCostMicros=null` beklenir. Replay/reconnect sonrasında counter veya terminal
ledger satırı artıyorsa stable ingest/dedupe key ihlali vardır.

## Güvenli operatör eylemleri

- Runtime tekrar erişilebilir olduğunda aynı session için explicit resume kullan.
- `recovery_required` run'ı otomatik yeni turn ile maskeleme; timeline ve provider thread
  kanıtını inceleyip kullanıcı kararı iste.
- Database'i elle terminal duruma çekme veya usage ledger satırını güncelleme; ledger
  append-only'dir.
