# WP15 provider runtime kurulumu

Control plane üç runtime’ı pinli sürüm ve machine-readable yüzeyle çalıştırır:

| Provider    | Pin       | Kurulum                                            | Auth                                                                  |
| ----------- | --------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| Codex       | `0.144.2` | Repository’deki mevcut pinli binary/provisioning   | `codex login` veya provision edilmiş `CODEX_HOME`                     |
| Claude Code | `2.1.109` | `npm install -g @anthropic-ai/claude-code@2.1.109` | Mevcut CLI login veya yalnız server-side `ANTHROPIC_API_KEY`          |
| Gemini CLI  | `0.25.0`  | `npm install -g @google/gemini-cli@0.25.0`         | Mevcut CLI login veya yalnız server-side `GEMINI_API_KEY`/Google auth |

Secret değerlerini `PERSISTENT_PROVIDER_CATALOGS_JSON`, browser config’i, log, event,
fixture veya ledger’a koymayın. Control plane provider process’lerine yalnız server
environment’ını ve mevcut CLI auth home’unu aktarır.

## Readiness

```sh
codex --version
claude --version
gemini --version
```

Çıktılar sırasıyla `0.144.2`, `2.1.109`, `0.25.0` pinleriyle eşleşmelidir. Claude veya
Gemini adapter readiness’i binary yoksa ya da pin farklıysa actionable install komutu
döndürür. Auth failure terminal/fixture başarısı sayılmaz; gerçek provider smoke ayrıca
çalıştırılmalıdır.

## Claude/Gemini model katalog config’i

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

Resmî yüzeyler: [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage),
[Gemini CLI headless reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md).
