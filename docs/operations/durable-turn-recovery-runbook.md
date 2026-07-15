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

### Cost durumları ve resmi reconciliation

- `estimated`: Versioned price catalog ve ölçülmüş provider usage'ından hesaplanan
  tahmindir; resmi fatura tutarı değildir.
- `reconciled`: Ayrı resmi provider cost kaynağından idempotent olarak eklenen tutardır.
  Tahmin satırı mutasyona uğratılmaz; UI resmi tutarı ve katalog sürümlerini ayrıntıda
  ayrı gösterir.
- `partial`: Terminal usage eksik veya yalnız ara sayaçlar ölçülmüştür. Tutar varsa o
  ana kadarki kullanımı anlatır; yoksa UI “Maliyet ölçülemedi” der, sıfır göstermez.
- `unreconciled`: Resmi cost eşleştirmesi yapılmamıştır veya provider turn düzeyinde
  güvenli resmi kaynak sunmuyordur. Bu durum normal ve görünürdür.

Conversation toplamı turn satırlarını ve `purpose=conversation_title` otomatik başlık
işlerini içerir. Başlık satırı ayrıntıda ayrı görünür. Her satırda input, cached input,
output, reasoning token, tool unit, lifecycle outcome, currency ve price-catalog
version incelenebilir.

Normal inference credential ile admin/usage credential aynı güvenlik kapsamı değildir:

- OpenAI resmi organization cost sorgusu için `OPENAI_ADMIN_KEY`; isteğe bağlı daraltma
  için `OPENAI_RECONCILIATION_PROJECT_ID` ve `OPENAI_RECONCILIATION_API_KEY_ID` kullanır.
- Anthropic Usage & Cost API için `ANTHROPIC_ADMIN_KEY`; isteğe bağlı workspace daraltması
  için `ANTHROPIC_RECONCILIATION_WORKSPACE_ID` kullanır.
- Canlı portlar yalnız `PERSISTENT_RECONCILIATION_DEDICATED_SCOPE=1` ile açılır. Admin
  key inference key ile aynıysa servis başlamayı reddeder.
- Gemini için turn'e güvenle bağlanabilen resmi cost portu yoktur; usage fiyat kataloğu
  ile estimated kalır ve UI `unreconciled` gösterir.

Organization cost API'leri zaman aralığı/toplam düzeyinde olduğu için dedicated
project/workspace/API-key kapsamı olmadan bir turn'e resmi tutar dağıtmak yasaktır.
Credential yoksa canlı reconciliation çalıştırılmaz; fixture/contract testleri resmi
payload mapping ve idempotency'yi doğrular. Admin secret browser'a, event'e, log'a,
fixture'a veya snapshot'a yazılmaz.

## Güvenli operatör eylemleri

- Runtime tekrar erişilebilir olduğunda aynı session için explicit resume kullan.
- `recovery_required` run'ı otomatik yeni turn ile maskeleme; timeline ve provider thread
  kanıtını inceleyip kullanıcı kararı iste.
- Database'i elle terminal duruma çekme veya usage ledger satırını güncelleme; ledger
  append-only'dir.
