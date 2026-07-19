# Provider runtime kurulumu

Control plane runtime’ları pinli/test edilmiş sürüm ve machine-readable yüzeyle çalıştırır:

| Provider     | Pin                                        | Kurulum                                               | Auth                                                                   |
| ------------ | ------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Codex        | `0.144.2`                                  | Repository’deki mevcut pinli binary/provisioning      | `codex login` veya provision edilmiş `CODEX_HOME`                      |
| Claude Code  | `2.1.109`                                  | `npm install -g @anthropic-ai/claude-code@2.1.109`    | Mevcut CLI login veya yalnız server-side `ANTHROPIC_API_KEY`           |
| Gemini CLI   | `0.25.0`, `0.50.0`                         | `npm install -g @google/gemini-cli@0.50.0`            | Desteklenen CLI login/project veya yalnız server-side `GEMINI_API_KEY` |
| Cursor Agent | `2026.07.09-a3815c0`, `2026.07.16-899851b` | Resmî Cursor CLI dokümantasyonuna göre manuel kurulum | `cursor-agent login` veya yalnız server-side `CURSOR_API_KEY`          |

Secret değerlerini `PERSISTENT_PROVIDER_CATALOGS_JSON`, browser config’i, log, event,
fixture veya ledger’a koymayın. Control plane provider process’lerine yalnız server
environment’ını ve mevcut CLI auth home’unu aktarır.

## Readiness

```sh
codex --version
claude --version
gemini --version
cursor-agent --version
cursor-agent status --format json
```

Çıktılar sırasıyla `0.144.2`, `2.1.109`, Gemini için exact doğrulanmış `0.25.0` veya
`0.50.0` ve Cursor için exact doğrulanmış `2026.07.09-a3815c0` veya `2026.07.16-899851b` release'iyle
eşleşmelidir. Cursor auto-update sonrası farklı tarih
veya hash üretirse fixture ve authenticated gerçek smoke olmadan allowlist’e eklemeyin.
Claude veya
Gemini adapter readiness'i binary yoksa ya da allowlist farklıysa actionable install komutu
döndürür. Auth failure terminal/fixture başarısı sayılmaz; gerçek provider smoke ayrıca
çalıştırılmalıdır.

## CLI model katalog config’i

CLI’lar kararlı model-list discovery sözleşmesi vermediği için gerçek model ID ve effort
desteği deployment config’inden gelir. Aşağıdaki değerler placeholder’dır; provider
hesabınızın desteklediği gerçek ID’lerle değiştirin:

```json
[
  {
    "schemaVersion": 1,
    "identity": {
      "provider": "claude",
      "adapter": "claude-code-stream-json",
      "adapterVersion": "1",
      "upstreamVersion": "2.1.109"
    },
    "discoveredAt": "2026-07-15T00:00:00.000Z",
    "models": [
      {
        "provider": "claude",
        "modelId": "YOUR_CLAUDE_MODEL_ID",
        "displayName": "Configured Claude model",
        "hidden": false,
        "isDefault": true,
        "reasoningEfforts": ["none", "medium"],
        "defaultReasoningEffort": "medium",
        "inputModalities": ["text"],
        "capabilities": {
          "streaming": "supported",
          "reasoningSummary": "degraded",
          "commandExecution": "supported",
          "fileChanges": "supported",
          "approvals": "unsupported",
          "interrupt": "supported",
          "resume": "supported",
          "toolCalls": "supported",
          "imageInput": "unsupported"
        }
      }
    ]
  }
]
```

JSON array’ini tercihen secret içermeyen versioned bir dosyada tutup
`PERSISTENT_PROVIDER_CATALOGS_FILE` ile gösterin. Local alpha varsayılan olarak
`config/provider-catalogs.local.json` dosyasını kullanır; inline
`PERSISTENT_PROVIDER_CATALOGS_JSON` yalnız deployment override’ı olarak korunur. Gemini
için aynı shape'i `provider=gemini`, doğrulanmış sürüm `0.50.0` ve hesabınızın gerçek model ID'siyle
ekleyin. Capability veya effort desteğinden emin değilseniz supported yazmayın;
`degraded`/`unsupported` kullanın.

Gemini `0.50.0` local OAuth çağrısı `UNSUPPORTED_CLIENT` veya ineligible-tier döndürürse
readiness geçmiş olsa bile smoke başarısızdır. Resmî olarak desteklenen account/project
auth’a geçin veya secret’ı yalnız provider process environment’ında tutarak
`GEMINI_API_KEY` sağlayın; ardından şu exact komutu yeniden çalıştırın:

```sh
GEMINI_SMOKE_MODEL=gemini-2.5-pro pnpm provider:smoke:gemini
```

Auth hatasını fixture, mock usage veya yalnız `--help` çıktısıyla geçmiş saymayın.
Adapter exact `0.50.0` runtime’da headless trust prompt’unu önlemek için
`--skip-trust` ekler. Bu seçenek approval mode’u değiştirmez ve tool/file yetkisi
sağlamaz; workspace authorization ile karıştırılmamalıdır.

## Model ve reasoning kataloğu

- Claude katalogunda Sonnet 5, Opus 4.8, Fable 5 ve Haiku 4.5 vardır. Pinli Claude
  Code `2.1.109`, `low`, `medium`, `high`, `max` kabul eder. Anthropic API’deki ayrı
  `xhigh` seviyesi bu CLI yüzeyinde yoktur; adapter eski `xhigh` isteğini `max` olarak
  normalize eder.
- Gemini katalogunda Auto, 3.5 Flash, 3.1 Pro Preview, 3.1 Flash-Lite, 3 Flash
  Preview ve 2.5 ailesi vardır. Gemini API düşünme seviyelerini destekler; pinli Gemini
  CLI `0.50.0` ise turn bazında `thinkingLevel`/`thinkingBudget` parametresi sunmaz.
  Bu nedenle UI dürüstçe `provider default` gösterir ve adapter sahte bir override
  üretmez.
- Cursor katalogu `cursor-agent --list-models` ile authenticated hesapta doğrulanan
  seçili modelleri içerir. Effort destekleyen base model/effort çifti adapter tarafından
  listede bulunan exact `--model '<model>-<effort>'` ID’sine çevrilir. CLI yardımındaki
  parameterized override bu release/account kombinasyonunda gerçek smoke tarafından
  reddedildiği için kullanılmaz. Beta CLI değişirse exact version allowlist, fixture ve
  gerçek smoke yeniden doğrulanmalıdır.

Seçili modeli ve effort aktarımını küçük bir gerçek çağrıyla sınamak için:

```sh
CLAUDE_SMOKE_MODEL=claude-sonnet-5 PROVIDER_SMOKE_REASONING_EFFORT=low pnpm provider:smoke:claude
GEMINI_SMOKE_MODEL=gemini-3.5-flash pnpm provider:smoke:gemini
CURSOR_SMOKE_MODEL=claude-opus-4-8 PROVIDER_SMOKE_REASONING_EFFORT=low pnpm provider:smoke:cursor
```

## Liste fiyatı tahmini ve reconciliation

Local alpha, `config/provider-prices.standard.json` içindeki resmî standard API liste
fiyatlarından token bazlı bir eşdeğer maliyet tahmini üretir. Mevcut ChatGPT, Claude,
Gemini veya Cursor subscription login’i aynen korunur; bu tahmin subscription faturasını
ya da gerçekten tahsil edilmiş tutarı temsil etmez. Cursor için kararlı model/token
fiyatı yayımlanmadığından fiyat uydurulmaz.

Gerçekleşen provider maliyeti yalnız provider’ın organization/admin cost API’si ve ayrı
bir dedicated credential ile reconcile edilir. `.env.example` gerekli değişkenleri
listeler. `OPENAI_ADMIN_KEY` normal inference/Codex credential’ıyla aynı olamaz.
Claude tarafında da `ANTHROPIC_ADMIN_KEY` gerekir. Anahtar yokken UI açıkça “API liste
fiyatı tahmini”, başarılı reconciliation sonrasında “Gerçekleşen provider maliyeti”
etiketini gösterir. Gemini ve Cursor için resmi maliyet reconciliation portu henüz yoktur.

Fiyat kataloğunun mevcut sınırları görünür kabul edilmelidir: OpenAI service tier/cache
write, Gemini’nin 200K context eşiği ve provider-specific cache write fiyatları mevcut
şemada ayrı alanlar değildir. Katalog standard tier ve düşük context bandını baz alır;
bu eşikler desteklenene kadar sonuç kesin fatura değil tahmindir.

Cursor için `provider=cursor`, `upstreamVersion=2026.07.16-899851b`, gerçek model
listesinde doğrulanmış model ID’si ve yalnız o modelin desteklediği `reasoningEfforts`
değerlerini kullanın. Capability değerleri ADR-0015 ile uyumlu olmalıdır.

## Cursor permission ve force politikası

Her Cursor workspace’inde `.cursor/cli.json` bulunmalıdır. Relative ve dar allow
kuralları kullanın; deny listesi en az `.env*`, `*.pem`, `*.key`, private-key ve
credential dosyalarını kapsamalıdır. Workspace dışı absolute path, traversal, symlink
config ve geniş `Read(**/*)`/`Write(**/*)` kuralları reddedilir.

Güncel headless CLI canonicalize edilmiş workspace için `--trust` ister. Adapter bunu
policy doğrulamasından sonra ekler; `--trust` tool permission veya file write yetkisi
vermez.

`--force` normalde eklenmez. Yazma gerekiyorsa hem server environment’ında
`PERSISTENT_CURSOR_FORCE_ALLOWED=1` verilmeli hem project policy dar bir `Write(...)`
allow kuralı içermelidir. Bu bayrak tek başına permission vermez.

Binary server `PATH` içinde değilse `CURSOR_AGENT_BIN` değerini executable absolute
binary path’ine ayarlayın. API key’i bu veya başka bir command argument’ına eklemeyin.

## Cursor gerçek smoke

```sh
CURSOR_SMOKE_MODEL=auto pnpm provider:smoke:cursor
```

`auto`, 16 Temmuz 2026 tarihinde local login ile gerçek smoke’da doğrulanan model
ID’sidir. Deployment hesabınız başka bir model ID’sini gerçekten çalıştırabiliyorsa
explicit olarak değiştirebilirsiniz. Model listesinde görünmek tek başına çalıştırılabilir
olduğunu kanıtlamaz.

Smoke readiness, stdin prompt, start/assistant stream, gerçek tool event, durable
session/resume, explicit interrupt, raw/unknown güvenliği, usage ve cleanup raporlar.
`cursor-agent login` veya `CURSOR_API_KEY` yoksa komut başarısız olur; geçmiş sayılmaz.

Resmî yüzeyler: [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage),
[Gemini CLI headless reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md),
[Cursor CLI overview](https://docs.cursor.com/en/cli/overview),
[headless](https://docs.cursor.com/en/cli/headless),
[output format](https://docs.cursor.com/en/cli/reference/output-format),
[permissions](https://docs.cursor.com/cli/reference/permissions) ve
[parameters](https://docs.cursor.com/en/cli/reference/parameters).
