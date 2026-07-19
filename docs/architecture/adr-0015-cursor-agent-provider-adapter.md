# ADR-0015: Cursor Agent provider adapter ve beta sürüm sınırı

- Durum: Kabul edildi
- Tarih: 16 Temmuz 2026
- Kapsam: WP17 Cursor Agent provider adapter

## Bağlam

Cursor CLI resmî olarak beta durumundadır, varsayılan olarak güncellenmeye çalışabilir ve
stream alanları ileri uyumlu biçimde genişleyebilir. Ürün provider parity varsayamaz;
secret, prompt, permission ve durable execution sınırlarını Cursor process’ine
devredemez.

## Karar

- Provider ID `cursor`, process binary’si `cursor-agent`, adapter yüzeyi
  `--print --output-format stream-json` olur. Process yalnız workspace cwd’sinde başlar;
  stdout NDJSON ve stderr diagnostics ayrı tutulur.
- Destek politikası exact, gerçek smoke ile doğrulanmış release allowlist’idir. İlk
  kabul edilen release `2026.07.09-a3815c0`, 19 Temmuz 2026 tarihinde fixture ve
  authenticated smoke ile doğrulanan güncel release `2026.07.16-899851b` olur. Tarih/hash biçimi parse
  edilemez, binary yok/çalıştırılamaz veya release allowlist dışında kalırsa process
  başlamaz. Aynı tarihli farklı hash dahil yeni her release fixture ve zorunlu gerçek
  smoke kanıtı olmadan reddedilir. Adapter installer, `curl`, `update` veya `upgrade`
  çalıştırmaz.
- Authentication yalnız server-side `cursor-agent status --format json` ile gerçek
  authenticated sonuç alındığında hazırdır. Bu sonuç local `cursor-agent login`
  credential’ından veya server environment’ındaki `CURSOR_API_KEY`’den gelebilir;
  environment’ta key varlığı tek başına readiness sayılmaz. API key argv, event, log,
  fixture, snapshot, audit veya UI’a taşınmaz. Prompt argv yerine stdin’den verilir.
- Model katalogu yalnız versioned `PERSISTENT_PROVIDER_CATALOGS_FILE` veya deployment
  override’ı `PERSISTENT_PROVIDER_CATALOGS_JSON` içinden gelir. `2026.07.16-899851b`
  authenticated model listesini machine-readable olarak verir. Yardım metni ayrıca
  parameterized model biçimi ilan etse de bu release/account kombinasyonu gerçek
  smoke’ta onu reddeder ve yalnız listedeki exact ID’leri kabul eder. Adapter katalogda
  izinli base model/effort çiftini `<model>-<effort>` exact ID’sine çevirir; kullanıcıdan
  serbest model suffix’i almaz. Effort desteklemeyen modeller yalnız `none` ilan edilir.
- `<workspace>/.cursor/cli.json` process başlamadan parse edilir. Allow/deny array’leri,
  workspace scope, traversal, symlink, `/proc`, `/sys`, sensitive file deny’ları ve aşırı
  geniş allow kuralları fail-closed doğrulanır. Deny allow’dan üstündür.
- `--force` varsayılan kapalıdır. Yalnız
  `PERSISTENT_CURSOR_FORCE_ALLOWED=1` platform kararı ile doğrulanmış project
  `Write(...)` allow kuralı birlikte varsa eklenir.
- Canonicalize edilmiş ve policy’si doğrulanmış workspace için güncel headless CLI’nin
  istediği `--trust` verilir. Bu bayrak `--force` değildir ve tool izin politikasını
  genişletmez.
- NDJSON parser satır ve buffer limitlidir; stdout işleme zinciri backpressure uygular.
  Malformed JSON, oversized line/buffer, non-zero exit, terminal `result` eksikliği ve
  early EOF typed failure’dır.
- `system/init`, assistant delta/completed, correlated tool start/completed ve terminal
  result normalize edilir. Bilinmeyen event redakte raw envelope ile `cursor.unknown`
  olur. `2026.07.09-a3815c0` resmî dokümanın aksine print stream’de `thinking`
  event’leri yayınlayabildiği için içerikleri saklanmaz; yalnız
  `[SUPPRESSED_REASONING]` işaretli `cursor.unknown` envelope korunur. Tekrarlanan
  assistant delta/result biçimleri yalnız bir completed mesaj üretir.
- Cursor `session_id`, mevcut provider-neutral durable session binding alanında saklanır;
  sonraki turn resmî `--resume <chatId>` kullanır. Browser disconnect run’ı durdurmaz.
  Explicit stop SIGINT → SIGTERM → SIGKILL bounded escalation uygular.
- Resmî stream usage sayaçları varsa provider-reported ledger kaydı oluşturulur.
  Sayaç yoksa lifecycle korunur ve sonuç `partial/unreconciled` kalır. Turn-safe resmî
  Cursor cost kaynağı doğrulanmadığından fiyat veya reconciled cost üretilmez.

## Capability matrix

| Capability          | Cursor Agent `2026.07.09-a3815c0`, `2026.07.16-899851b` |
| ------------------- | ------------------------------------------------------- |
| Streaming           | supported                                               |
| Reasoning summary   | unsupported                                             |
| Command execution   | supported                                               |
| File changes        | degraded (`--force` kapılı)                             |
| Approval resolution | unsupported                                             |
| Interrupt           | supported                                               |
| Resume              | supported                                               |
| Tool calls          | supported                                               |
| Image input         | unsupported                                             |
| Usage               | degraded (provider-reported)                            |
| Cost                | unsupported                                             |

## Sonuçlar

CLI beta ve auto-update davranışıyla exact allowlist’ten çıkarsa readiness fail-closed
olur. Operatör yeni sürümü güvenli fixture ve authenticated gerçek smoke ile doğrulayıp
allowlist ve bu ADR’yi bilinçli olarak güncellemelidir. Cursor Cloud Agent, billing
tahmini, approval emülasyonu ve global `--force` kapsam dışıdır.
