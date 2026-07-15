# Faz 2 acceptance raporu — WP16 uygulama kanıtı

- Tarih: 15 Temmuz 2026
- Durum: **Uygulandı / kabul bekliyor**
- Gate: `pnpm phase2:accept`
- Kapsam: WP13–WP16 provider, durable execution/recovery, accounting/cost ve PWA

Bu rapor uygulama teslimatının tekrarlanabilir kanıtıdır; WP16'yı kabul edilmiş veya
Faz 2'yi kapanmış saymaz.

## Deterministic gate

`pnpm phase2:accept` secret gerektirmeden aşağıdaki aşamaları sırasıyla çalıştırır:

1. Provider platform, Claude/Gemini CLI adapter, event store, control plane, title job,
   cost UI ve Service Worker contract/unit/integration testleri.
2. Unknown-event durable replay smoke'u.
3. TanStack Start/Vite production PWA build ve typecheck.
4. Gerçek Chrome üzerinde production SSR + API: desktop ve mobil, manifest/ikon,
   controlled worker, browser close/reopen eşdeğeri offline reload, read-only history,
   offline gönderim/upload engeli ve online snapshot + high-water replay.

Browser kanıtı:

```json
{
  "browser": "passed",
  "viewports": ["1280x720", "390x844"],
  "installability": "manifest+icons+controlled-service-worker",
  "offline": "shell+read-only-history+send-blocked",
  "online": "snapshot+high-water-replay",
  "evidence": "DOM/runtime assertions with zero page errors"
}
```

Gate; Codex/Claude/Gemini start, resume, interrupt, unknown event, measured usage ve
cleanup sözleşmelerini; completed/failed/interrupted/partial/estimated/reconciled maliyet
fixture'larını; Codex `sol + medium` conversation ve ikinci kullanıcı mesajından sonra
`luna + none` title politikasını kapsar. Resmi reconciliation tekrarında stable dedupe
key aynı provider sonucunun ikinci ledger satırını üretmesini engeller.

## Çalıştırılan kontroller

Nihai teslimatta aşağıdaki komutlar çalıştırıldı:

| Komut                                                                                                                     | Sonuç                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm phase2:accept`                                                                                                      | Geçti — 7 dosya/156 test + replay + production build + browser gate        |
| `pnpm verify`                                                                                                             | Geçti — format, 11 workspace typecheck, 17 dosya/213 test, build, SSR HTTP |
| `pnpm phase2:accept:browser`                                                                                              | Geçti — desktop/mobil/offline/online, sıfır page error                     |
| `CLAUDE_SMOKE_MODEL=sonnet GEMINI_SMOKE_MODEL=gemini-2.5-pro CODEX_TITLE_SMOKE_MODEL=gpt-5.6-luna pnpm phase2:smoke:live` | Geçti — Codex/Claude/Gemini/title ve cleanup                               |
| `git diff --check`                                                                                                        | Geçti                                                                      |
| `git status --short`                                                                                                      | Yalnız WP16 teslimat dosyaları listelendi                                  |

Canlı Codex canary read-only turn, file change + hedefli test + Git, tek approval ve
restart/resume/readiness/audit/metrics aşamalarını cleanup ile geçti. Claude `sonnet` ve
Gemini `gemini-2.5-pro` gerçek smoke'ları start, resume, streaming interrupt, measured
usage, raw/unknown-event güvenliği ve process cleanup'ı geçti. Codex title smoke'u ikinci
mesaj threshold'unu, tek idempotent job'ı ve `gpt-5.6-luna + none` generation usage'ının
`conversation_title` amacıyla tutulmasını doğruladı.

## Canlı provider ve reconciliation sınırı

Gerçek Codex, Claude ve Gemini smoke'ları deterministic gate dışında opt-in çalışır;
mevcut login/model credential'ları yoksa gate başarısız sayılmaz ve çalıştırılamayan
kontrol açıkça raporlanır. Smoke script'leri start/resume/interrupt/usage/unknown-event
ve process cleanup davranışını doğrular.

OpenAI/Anthropic resmi cost reconciliation yalnız ayrı admin credential, dedicated
attribution scope ve provider veri gecikmesi elverdiğinde canlı çalıştırılabilir. Gemini
için turn-level resmi cost kaynağı olmadığından canlı reconciliation yoktur. Credential
bulunmayan veya güvenli attribution yapılamayan ortamda contract fixture'ları kullanılır;
UI estimated/unreconciled kalır ve eksik usage hiçbir zaman sıfır maliyet göstermez.

Bu kabul ortamında `OPENAI_ADMIN_KEY`, `ANTHROPIC_ADMIN_KEY` ve dedicated attribution
scope değerleri yoktu; dolayısıyla canlı resmi reconciliation çalıştırılmadı. OpenAI
USD-micros mapping'i, Anthropic fractional-cent pagination'ı, secret'ın sonuçtan
çıkarılması ve control-plane stable-dedupe/idempotent reconciliation akışı fixture ve
integration testleriyle geçti.
