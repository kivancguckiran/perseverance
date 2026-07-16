# Provider runtime kurulumu

Control plane runtime’ları pinli/test edilmiş sürüm ve machine-readable yüzeyle çalıştırır:

| Provider     | Pin                  | Kurulum                                               | Auth                                                                  |
| ------------ | -------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| Codex        | `0.144.2`            | Repository’deki mevcut pinli binary/provisioning      | `codex login` veya provision edilmiş `CODEX_HOME`                     |
| Claude Code  | `2.1.109`            | `npm install -g @anthropic-ai/claude-code@2.1.109`    | Mevcut CLI login veya yalnız server-side `ANTHROPIC_API_KEY`          |
| Gemini CLI   | `0.25.0`             | `npm install -g @google/gemini-cli@0.25.0`            | Mevcut CLI login veya yalnız server-side `GEMINI_API_KEY`/Google auth |
| Cursor Agent | `2026.07.09-a3815c0` | Resmî Cursor CLI dokümantasyonuna göre manuel kurulum | `cursor-agent login` veya yalnız server-side `CURSOR_API_KEY`         |

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

Çıktılar sırasıyla `0.144.2`, `2.1.109`, `0.25.0` ve Cursor için exact doğrulanmış
`2026.07.09-a3815c0` release’iyle eşleşmelidir. Cursor auto-update sonrası farklı tarih
veya hash üretirse fixture ve authenticated gerçek smoke olmadan allowlist’e eklemeyin.
Claude veya
Gemini adapter readiness’i binary yoksa ya da pin farklıysa actionable install komutu
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

JSON array’ini `PERSISTENT_PROVIDER_CATALOGS_JSON` environment değerine verin. Gemini
için aynı shape’i `provider=gemini`, pin `0.25.0` ve hesabınızın gerçek model ID’siyle
ekleyin. Capability veya effort desteğinden emin değilseniz supported yazmayın;
`degraded`/`unsupported` kullanın.

Cursor için `provider=cursor`, `upstreamVersion=2026.07.09-a3815c0`, gerçek smoke ile
doğrulanmış model ID’si, `reasoningEfforts=["none"]` kullanın. Capability değerleri
ADR-0015 ile uyumlu olmalıdır.

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
