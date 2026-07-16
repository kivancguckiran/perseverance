# ADR-0015: Cursor Agent provider adapter ve beta sürüm sınırı

- Durum: Kabul adayı
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
- Test edilmiş sürüm aralığı `2025.09.18-*` olur. `--version` çıktısı parse edilemez,
  binary yok/çalıştırılamaz veya sürüm aralık dışındaysa process başlamaz. Adapter
  installer, `curl`, `update` veya `upgrade` çalıştırmaz.
- Authentication yalnız server-side `cursor-agent status` veya server environment’ındaki
  `CURSOR_API_KEY` varlığıyla belirlenir. API key argv, event, log, fixture, snapshot,
  audit veya UI’a taşınmaz. Prompt argv yerine stdin’den verilir.
- Model katalogu yalnız `PERSISTENT_PROVIDER_CATALOGS_JSON` içindeki deployment
  doğrulamasından gelir. Cursor için reasoning effort yalnız `none` kabul edilir.
- `<workspace>/.cursor/cli.json` process başlamadan parse edilir. Allow/deny array’leri,
  workspace scope, traversal, symlink, `/proc`, `/sys`, sensitive file deny’ları ve aşırı
  geniş allow kuralları fail-closed doğrulanır. Deny allow’dan üstündür.
- `--force` varsayılan kapalıdır. Yalnız
  `PERSISTENT_CURSOR_FORCE_ALLOWED=1` platform kararı ile doğrulanmış project
  `Write(...)` allow kuralı birlikte varsa eklenir.
- NDJSON parser satır ve buffer limitlidir; stdout işleme zinciri backpressure uygular.
  Malformed JSON, oversized line/buffer, non-zero exit, terminal `result` eksikliği ve
  early EOF typed failure’dır.
- `system/init`, assistant delta/completed, correlated tool start/completed ve terminal
  result normalize edilir. Bilinmeyen event redakte raw envelope ile `cursor.unknown`
  olur. Suppressed thinking istenmez veya yeniden üretilmez.
- Cursor `session_id`, mevcut provider-neutral durable session binding alanında saklanır;
  sonraki turn resmî `--resume <chatId>` kullanır. Browser disconnect run’ı durdurmaz.
  Explicit stop SIGINT → SIGTERM → SIGKILL bounded escalation uygular.
- Resmî stream usage sayaçları varsa provider-reported ledger kaydı oluşturulur.
  Sayaç yoksa lifecycle korunur ve sonuç `partial/unreconciled` kalır. Turn-safe resmî
  Cursor cost kaynağı doğrulanmadığından fiyat veya reconciled cost üretilmez.

## Capability matrix

| Capability          | Cursor Agent `2025.09.18-*` |
| ------------------- | --------------------------- |
| Streaming           | supported                   |
| Reasoning summary   | unsupported                 |
| Command execution   | supported                   |
| File changes        | degraded (`--force` kapılı) |
| Approval resolution | unsupported                 |
| Interrupt           | supported                   |
| Resume              | supported                   |
| Tool calls          | supported                   |
| Image input         | unsupported                 |
| Usage               | degraded                    |
| Cost                | unsupported                 |

## Sonuçlar

CLI auto-update ile desteklenen aralıktan çıkarsa readiness fail-closed olur. Operatör
yeni sürümü fixture ve gerçek smoke ile doğrulayıp bu ADR’deki aralığı bilinçli olarak
güncellemelidir. Cursor Cloud Agent, billing tahmini, approval emülasyonu ve global
`--force` kapsam dışıdır.
