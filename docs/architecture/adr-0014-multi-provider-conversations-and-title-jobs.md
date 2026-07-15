# ADR-0014: Çok sağlayıcılı conversation ve server-owned başlık işleri

- Durum: Kabul adayı
- Tarih: 15 Temmuz 2026
- Kapsam: Faz 2 WP15 Claude/Gemini adapter’ları, conversation model seçimi ve otomatik başlık

## Bağlam

WP13 provider-neutral model/capability/usage sözleşmesini, WP14 ise browser’dan
bağımsız durable turn lifecycle’ını kurdu. Claude Code ve Gemini CLI machine-readable
akışları Codex `app-server` ile aynı wire protocolü kullanmaz. Conversation modeli
oluşturma anında seçilmeli; unsupported seçim provider process’i başlamadan reddedilmeli
ve otomatik başlık ana conversation timeline’ından bağımsız, retry-safe bir iş olmalıdır.

## Karar

- Claude Code `2.1.109` `--output-format stream-json --verbose --resume`, Gemini CLI
  `0.25.0` `--output-format stream-json --resume` yüzeyleriyle çalışır. İnsan-okur terminal
  çıktısı parse edilmez. Her JSONL satırı secret redaction sonrasında raw envelope olarak
  saklanır; ardından provider-neutral event’e normalize edilir.
- Bilinmeyen veya malformed Claude/Gemini satırı decode crash üretmez;
  `provider.unknown` event’i ve redacted raw envelope ile korunur. Process exit, auth ve
  provider sonucu typed terminal outcome/error’a çevrilir.
- Claude/Gemini CLI kararlı bir model-list discovery sözleşmesi sunmadığından katalogları
  `PERSISTENT_PROVIDER_CATALOGS_JSON` server config’i sağlar. Gerçek model ID kodda veya
  UI bundle’ında hardcode edilmez. Codex kataloğu pinli `app-server model/list` üzerinden
  keşfedilmeye devam eder.
- Create-session contract provider ile alias veya doğrudan model seçimini ve reasoning
  effort’ı taşır. Resolver provider/model/effort/capability kombinasyonunu process çağrısı
  öncesinde doğrular. Varsayılan Codex seçimi `sol + medium` kalır. Session ve turn
  immutable snapshot’ları gerçek provider, model, effort ve capability değerlerini taşır.
- Capability matrix gerçek adapter davranışını bildirir. Headless Claude/Gemini
  adapter’ında approval resolution ve in-flight steer unsupported’tur; sessiz emülasyon
  yapılmaz. Attachment input bu adapter’larda etkin değildir ve typed hata üretir.
- SQLite schema v11 durable user-message threshold, `conversation_title_jobs`, manual
  title marker ve usage `purpose` alanını ekler. İkinci durable kullanıcı mesajı aynı
  deterministic idempotency key ile tek title job oluşturur.
- Title job `queued → running → completed|failed` akışında en fazla üç attempt yapar.
  Restart sırasında yarım kalmış `running` iş tekrar `queued` olur. `luna + none` her
  attempt’te resolver üzerinden gerçek Codex modeline çözülür. Üretim ayrı `codex exec
--json` sürecinde read-only sandbox ve ayrı timeline ile yapılır; conversation’a yapay
  user/assistant event’i eklenmez.
- Başlık whitespace/newline temizlenerek en fazla 80 karakterlik tek satıra çevrilir.
  Boş/hatalı çıktıda fallback korunur. `manual_title_at` doluysa job tamamlanabilir fakat
  session başlığını değiştiremez. Başarılı title usage satırı
  `purpose=conversation_title` ve stable dedupe key ile WP13 ledger’ına yazılır.

## Capability matrix

| Capability          | Codex app-server                    | Claude Code            | Gemini CLI             |
| ------------------- | ----------------------------------- | ---------------------- | ---------------------- |
| Streaming           | supported                           | supported              | supported              |
| Reasoning summary   | supported/degraded by model catalog | degraded               | degraded               |
| Command execution   | supported                           | supported              | supported              |
| File changes        | supported                           | supported              | supported              |
| Approval resolution | supported                           | unsupported            | unsupported            |
| Interrupt           | supported                           | supported (SIGINT)     | supported (SIGINT)     |
| Resume              | supported                           | supported              | supported              |
| Tool calls          | supported                           | supported              | supported              |
| Image input         | model catalog                       | unsupported in adapter | unsupported in adapter |

## Sonuçlar

Claude/Gemini provider session identity legacy `codex_thread_id` storage slotunda tutulur;
alanın provider-neutral yeniden adlandırılması sonraki geriye uyumlu migration’a bırakılır.
Headless CLI process’i multi-node lease çözmez. CLI auth state’inin machine-readable,
yan etkisiz ortak standardı olmadığından readiness exact binary version’ı doğrular; auth
failure ilk resmi provider çağrısında typed `unauthorized` olur. Multi-tenant credential
yönetimi ve unsupported approval emülasyonu kapsam dışıdır.
