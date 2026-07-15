# Faz 2 — Kalıcı çok sağlayıcılı ajan platformu planı

- Plan durumu: Aktif
- Plan tarihi: 15 Temmuz 2026
- Aktif iş paketi: WP16
- Kaynak spesifikasyon: `docs/architecture/persistent-codex-workspace-tasarim-spesifikasyonu.md`

## 1. Amaç

Faz 1 tek kiracılı alfayı; ölçülebilir maliyet, browser'dan bağımsız kalıcı çalışma,
kurulabilir PWA ve Codex/Claude/Gemini sağlayıcılarını aynı ürün sözleşmesinin arkasında
çalıştıran bir platforma dönüştürmek. Conversation bazında model seçimi yapılacak,
yeni Codex conversation'ı `sol` model politikası ve `medium` effort ile başlayacak;
conversation başlığı ikinci kullanıcı mesajından sonra `luna` model politikası ve
`none` effort ile bir kez üretilecektir.

## 2. Temel kararlar

### 2.1 Maliyet doğruluğu

- Her model çağrısının provider, credential scope, model, turn, request ve lifecycle
  sonucu ile ilişkili append-only kullanım kaydı tutulur.
- `completed`, `failed` ve `interrupted` işler için o ana kadar alınmış token/tool
  kullanımı hesaba katılır. Terminal usage gelmemişse maliyet sıfır varsayılmaz;
  kayıt `partial` ve `unreconciled` kalır.
- Kullanıcıya önce versioned fiyat kataloğundan `estimated` tutar gösterilir. Provider
  organizasyon kullanım/maliyet API'si erişilebiliyorsa ayrı bir job bu kayıtları
  `reconciled` hale getirir; tahmin ile resmi tutar birbirinin üzerine yazılmaz.
- Standart inference API key her provider'da resmi fatura reconciliation'ı için yeterli
  değildir. Örneğin Anthropic Usage & Cost API ayrı Admin/Analytics key gerektirir.
- Secret değerleri ledger, event, audit, log, fixture veya UI'a yazılmaz; yalnız opaque
  credential reference tutulur.

### 2.2 Kalıcı çalışma

- Turn'ün sahibi browser veya Service Worker değil control plane/workspace runtime'dır.
  Tab kapanması, route değişmesi ve WebSocket kopması turn'ü iptal etmez.
- Kullanıcının açıkça verdiği `Durdur` kararı turn'ü interrupt eder. Browser kapanması
  implicit interrupt değildir.
- Geri dönen istemci session snapshot + replay/live high-water geçişiyle ara ve terminal
  çıktıları görür. Control plane restart/crash için lease, recovery ve resume davranışı
  deterministik olmalıdır.

### 2.3 Ortak ajan arayüzü

- Ortak arayüz lifecycle, conversation/session, turn, interrupt, approval, normalize
  event, model catalog, usage ve capability alanlarını standardize eder.
- Codex mevcut pinli `app-server` adapter'ıyla çalışmaya devam eder; orkestrasyon tekrar
  yazılmaz. Claude ve Gemini kendi resmi CLI/SDK protokollerini adapter olarak kullanır.
- Sağlayıcıların bütün araç ve event semantiklerinin aynı olduğu iddia edilmez. Feature
  parity yerine versioned capability matrix ve `supported/unsupported/degraded` durumu
  gösterilir; bilinmeyen provider olayı raw envelope ile korunur.
- Bir sağlayıcının eksik özelliği sessizce taklit edilmez veya başka bir davranışa
  çevrilmez.

### 2.4 Model politikaları ve başlık

- `sol` ve `luna` upstream model ID değil ürün politikası alias'larıdır. Alias'lar
  config ve provider model catalog sonucundan gerçek ID'ye çözülür; çözülemeyen alias
  görünür ve actionable config hatası üretir.
- Yeni Codex conversation varsayılanı `sol + medium` olur. Kullanıcı conversation
  oluştururken veya turn başlamadan önce desteklenen model/effort seçebilir; kullanılan
  gerçek provider/model/effort turn kaydında immutable tutulur.
- İkinci kullanıcı mesajı durable kaydedildikten sonra idempotent title job bir kez
  `luna + none` ile kısa başlık üretir. Kullanıcı başlığı değiştirmişse otomatik iş
  üzerine yazmaz. Job hata verirse conversation çalışmaya devam eder ve bounded retry
  sonrasında mevcut fallback başlık korunur.

### 2.5 PWA sınırı

- PWA; installable manifest, ikonlar, güvenli Service Worker güncellemesi, responsive
  standalone shell ve son senkronize conversation/history için read-only offline görünüm
  sağlar.
- Ajan browser içinde/offline çalıştırılmaz. Offline prompt gönderimi bu fazda kuyruğa
  alınmaz; kullanıcıya bağlantı durumu açıkça gösterilir.
- API, event stream, attachment ve secret içeren response'lar gelişigüzel cache'lenmez.

## 3. Faz 2 exit kriteri

- Codex, Claude ve Gemini aynı provider-neutral API üzerinden session/turn başlatır;
  capability farkları UI ve API'de doğru görünür.
- Conversation model seçimi kalıcıdır; yeni Codex conversation `sol + medium` ile,
  otomatik başlık ikinci kullanıcı mesajından sonra `luna + none` ile çalışır.
- Browser kapatılıp açıldığında devam eden turn iptal olmadan tamamlanır ve çıktısı
  replay ile görünür; açık interrupt ayrıca doğrulanır.
- Completed/failed/interrupted turn'ler için ölçülebilen usage ve estimated cost görünür;
  eksik kayıt `partial`, resmi provider verisiyle eşleşen kayıt `reconciled` olur.
- Uygulama desktop ve mobilde kurulabilir PWA olarak geçer; offline shell/history
  güvenli cache politikasıyla açılır, online dönüşte state reconcile edilir.
- Birleşik provider, recovery, cost ve PWA kabul paketi tekrarlanabilir biçimde geçer.

## 4. İş paketi özeti

| Paket | Durum      | Hedef                                                                         |
| ----- | ---------- | ----------------------------------------------------------------------------- |
| WP13  | Tamamlandı | Provider-neutral sözleşme, model/capability politikası ve usage ledger temeli |
| WP14  | Tamamlandı | Browser'dan bağımsız durable execution, recovery ve terminal accounting       |
| WP15  | Tamamlandı | Claude/Gemini adapter'ları, model seçimi ve otomatik conversation başlığı     |
| WP16  | Aktif      | PWA, maliyet görünümü ve Faz 2 uçtan uca kabulü                               |

## 5. WP13 — Platform sözleşmesi ve maliyet temeli

### Hedef

Mevcut Codex akışını bozmadan bütün sağlayıcıların bağlanacağı versioned runtime
sözleşmesini, model/capability çözümlemesini ve her lifecycle sonucunu ölçebilen durable
usage ledger'ı kurmak.

### Yapılacak işler

- Provider adapter ADR'si ve shared versioned contracts ekle: provider/model identity,
  capability matrix, session/turn lifecycle, interrupt, approval, normalize event,
  usage snapshot/delta ve typed provider errors.
- Mevcut Codex adapter'ını bu arayüze bağla; `model/list` ve supported reasoning effort
  verisini provider catalog'a dönüştür. Raw envelope ve `codex.unknown` garantisini koru.
- Config-driven `sol` ve `luna` policy alias resolver ekle; varsayılan conversation ve
  title policy'lerini contract/config düzeyinde tanımla, gerçek model ID hardcode etme.
- Conversation/turn kayıtlarına provider, resolved model, requested model policy,
  reasoning effort ve capability snapshot alanlarını migration ile ekle.
- Append-only usage ledger ekle: provider-reported input/cached/output/reasoning token,
  tool charge, request/turn association, cumulative/delta dedupe, lifecycle outcome,
  completeness ve reconciliation status.
- Versioned fiyat kataloğuyla deterministic estimated-cost hesaplayıcı ekle. Resmi cost
  reconciliation için provider-neutral port ve fixture oluştur; bu pakette canlı admin
  API entegrasyonu yapma.
- Scoped usage/cost read endpoint'i ekle; secret, raw prompt/output ve yüksek cardinality
  veriyi audit/metrics'e sızdırma.

### Kapsam dışı

- Claude/Gemini process adapter implementasyonu ve gerçek provider turn'leri.
- Background lease/recovery değişiklikleri, PWA ve nihai UI.
- Canlı OpenAI/Anthropic/Google billing API çağrısı veya kullanıcıya fatura kesme.
- Multi-tenant ödeme, quota, budget enforcement ve subscription sistemi.

### Kabul kriterleri

- Mevcut Codex session/turn/approval/replay akışı provider-neutral sözleşmeden geçerken
  davranış ve golden fixture semantiği değişmez.
- `sol`/`luna` gerçek model ID'ye yalnız config + discovered catalog ile çözülür;
  eksik/unsupported alias typed ve actionable hata üretir.
- Aynı cumulative usage tekrarı duplicate maliyet oluşturmaz; delta/cumulative karışımı,
  restart ve event replay deterministik olarak tek doğru toplama ulaşır.
- Completed, failed ve interrupted fixture'larında alınan kullanım hesaplanır; terminal
  usage eksikse kayıt `partial/unreconciled` olur ve sıfır maliyet gibi sunulmaz.
- Fiyat katalog sürümü her tahmine bağlıdır; katalog değişikliği geçmiş ledger satırını
  mutasyona uğratmaz.
- Migration reopen testi, tenant/session scope ve secret-redaction testleri geçer.

### Zorunlu doğrulama

- Contract/typecheck ve Codex golden adapter replay testleri
- Model catalog/alias/capability fixture testleri
- Usage dedupe, lifecycle outcome, partial/reconciled ve pricing golden testleri
- SQLite migration/reopen/concurrency ve scoped API integration testleri
- `pnpm verify`
- `git status --short`

### Teslimat commit'i

`feat: add provider platform and usage ledger foundation`

### Kabul sonucu

WP13 bağımsız olarak kabul edildi. Uygulama commit'i `f2cde59` üzerinde ADR-0012,
provider platform paketi, Codex model katalog köprüsü, schema v9 migration, append-only
usage ledger, versioned fiyat tahmini ve scoped usage/cost API doğrulandı. Güncel HEAD
üzerinde format, bütün typecheck'ler, 14 test dosyasında 158 test, production build ve
localhost izniyle `/` ile `/sessions/:sessionId` SSR HTTP smoke'u geçti. WP14 tek aktif
pakettir.

## 6. WP14 — Durable detached execution ve accounting finalization

WP13 tamamlandıktan sonra browser bağlantısından bağımsız server-owned run lease,
disconnect/reconnect, crash/restart recovery, explicit interrupt ve terminal usage
finalization uygulanır. Browser kapanıp yeniden açıldığında aynı turn'ün devam ettiği ve
sonucun replay edildiği; failed/interrupted turn'lerde kısmi usage'ın korunduğu gerçek
integration senaryolarıyla doğrulanır.

### Kabul sonucu

WP14 bağımsız olarak kabul edildi. Uygulama commit'i `0d75a1e` üzerinde ADR-0013,
schema v10 `durable_runs`, session başına database seviyesinde tek aktif run, explicit
interrupt, reconnect snapshot/replay ve terminal accounting doğrulandı. Güncel HEAD'de
format, bütün typecheck'ler, 14 test dosyasında 164 test, production build, SSR HTTP
smoke ve dört aşamalı gerçek Codex alfa canary geçti. İzole güncel web instance'ında
1280×720 ve 390×844 görünümleri taşmasız ve console hatasızdı. WP15 tek aktif pakettir.

## 7. WP15 — Çok sağlayıcılı adapter, model seçimi ve başlık

WP14 tamamlandıktan sonra resmi ve pinli yüzeylerle Claude ile Gemini adapter'ları ortak
arayüze eklenir; capability farkları normalize edilir ve bilinmeyen event korunur.
Conversation model/effort seçimi UI/API'ye bağlanır, Codex için `sol + medium` varsayılanı
ve ikinci kullanıcı mesajından sonra idempotent `luna + none` title job uygulanır.

### Kabul sonucu

WP15 bağımsız olarak kabul edildi. `aabd6bd`, `ddd3079`, `37455d2` ve `5835809`
commit'leri üzerinde ortak provider adapter arayüzü, Claude/Gemini process adapter'ları,
model/effort seçimi, Codex `sol + medium` varsayılanı ve ikinci kullanıcı mesajından sonra
idempotent `luna + none` başlık üretimi doğrulandı. Provider interrupt acceptance testi
10 bağımsız tekrarın tamamında geçti; güncel HEAD üzerinde 16 test dosyasında 196 test,
production build ve SSR HTTP smoke başarılıydı. Gerçek Claude, Gemini ve Codex title
smoke'ları ile 1280×720 ve 390×844 browser kontrolleri de geçti. WP16 tek aktif pakettir.

## 8. WP16 — PWA, maliyet görünümü ve Faz 2 kabulü

WP15 tamamlandıktan sonra güvenli cache politikalı installable PWA, offline read-only
shell/history, online reconciliation, turn/conversation maliyet görünümü ve
estimated/partial/reconciled ayrımı tamamlanır. Codex/Claude/Gemini, browser close/reopen,
interrupt, failed usage, title/model policy ve desktop/mobil PWA senaryolarını kapsayan
birleşik Faz 2 acceptance gate hazırlanır.

## 9. Paket geçiş ve commit kuralı

Her zaman yalnız bir aktif paket bulunur. Paket bağımsız olarak kod, migration, test,
gerçek smoke ve gerekli browser kanıtlarıyla doğrulanmadan sonraki pakete geçilmez.
Eksik varsa yalnız aynı paketin düzeltme prompt'u verilir. Her tamamlanan paket yalnız
kendi değişikliklerini içeren tek açıklayıcı commit üretir ve teslimat commit hash'ini
raporlar.

## 10. Resmi entegrasyon kaynakları

- OpenAI organization Usage/Costs API:
  `https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage`
- Anthropic Usage & Cost API:
  `https://platform.claude.com/docs/en/manage-claude/usage-cost-api`
- Claude Code CLI: `https://code.claude.com/docs/en/cli-usage`
- Gemini token/usage metadata: `https://ai.google.dev/gemini-api/docs/tokens`
- Gemini CLI: `https://developers.google.com/gemini-code-assist/docs/gemini-cli`
